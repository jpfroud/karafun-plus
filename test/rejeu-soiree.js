'use strict';
/*
 * Rejeu d'une soirée exportée (bouton « Exporter » des statistiques, format
 * karaoke-evening v1) avec le VRAI ordonnanceur (scheduler.js) : une longue
 * attente était-elle normale, ou vient-elle d'un défaut de la rotation ?
 *
 *   node test/rejeu-soiree.js <export.json> [options]
 *
 *   (sans option)          rejeu FORCÉ : à chaque envoi réel, ce que l'ordonnanceur
 *                          aurait choisi à la réservation (pendant la chanson
 *                          précédente) et à l'envoi ; le passage RÉEL est ensuite
 *                          engagé, l'état ne dérive donc jamais de la soirée.
 *   --libre                rejeu LIBRE : l'ordonnanceur choisit qui chante. Inscriptions,
 *                          demandes, duos, retraits, réordres et départs à leurs heures
 *                          réelles ; durées jouées réelles ; délais de lancement réels du
 *                          k-ième titre ; Battle à son heure réelle ; envoi à +pushDelaySec ;
 *                          rien n'est envoyé pendant un arrêt de l'application.
 *   --solveur [jar]        avec le plan Timefold (solver/bridge.js), attendu à chaque
 *                          décision. Jar par défaut : solver/target/karafun-solver.jar,
 *                          sinon solver/karafun-solver.jar.
 *   --budget <ms>          budget Timefold par décision (3000)
 *   --trace HH:MM[,HH:MM]  détail des décisions prises à ces minutes (heure de la soirée)
 *   --json <fichier>       décisions, passages, attentes et anomalies en JSON
 *   --option clé=valeur    remplace une règle de la soirée (répétable), par exemple
 *                          spacingSongs=2, roundAppearanceCap=0, interleaveArrivals=false,
 *                          pushDelaySec=30 (rejeu libre) : compare les réglages du bar.
 *   --court                résumé seulement (sans la liste des décisions ni des attentes)
 *
 * Programmatique : const r = require('./rejeu-soiree');
 *   const ev = r.loadEvening('export.json');
 *   const res = await r.runForced(ev, { solver, budget, options, until });   // ou r.runFree
 *   (`until` : rejeu forcé arrêté après cette heure, en ms)
 *   res.decisions, res.passages (attente par titre), res.analysis ; r.report(res)
 *
 * Aucune méthode de l'ordonnanceur n'est copiée ici : les choix viennent de
 * select() et reserveNext(), les explications de son ÉTAT au moment de la
 * décision (roundPeople, roundApps, roundUse, lastAppearanceTurn, readySerial…).
 * Les attentes sont calculées par evening-stats.js lui-même (computeStats,
 * définition de la page des statistiques : attente par titre, comme la
 * rotation, et sans monter sur scène par personne) sur un journal : celui de
 * la soirée, ou, en rejeu libre, le même journal où les passages rejoués
 * remplacent les passages réels. Comparées aux attentes enregistrées dans
 * l'export (une version plus ancienne de l'application peut en différer).
 *
 * Seul effet de bord : Date.now est remplacé par l'horloge de la soirée
 * pendant un rejeu, puis rendu. Ne parle jamais à KaraFun.
 */
const fs = require('fs');
const path = require('path');
const { Scheduler } = require('../scheduler');
const eveningStats = require('../evening-stats');

const ROOT = path.join(__dirname, '..');
const DEFAULT_JARS = [path.join(ROOT, 'solver', 'target', 'karafun-solver.jar'),
  path.join(ROOT, 'solver', 'karafun-solver.jar')];
const EPS = 1e-9;
// Règles de la soirée qui sont des options de l'ordonnanceur.
const SCHED_RULES = ['tableRotation', 'weightedTables', 'interleaveArrivals', 'roundAppearanceCap',
  'spacingSongs', 'requirePresence', 'gap', 'cap'];
// Événements du journal que le rejeu sait refaire (les autres sont ignorés).
const REPLAYED = new Set(['table.opened', 'table.headcount', 'person.joined', 'song.requested',
  'duo.invited', 'duo.answered', 'duo.cancelled', 'duo.left', 'song.removed', 'song.reordered',
  'table.left', 'person.left', 'person.reactivated', 'person.bonus', 'table.bonus', 'person.transferred',
  'settings.changed']);
// Gestes qui changent la file mais que le rejeu ne refait pas : signalés.
const NOT_REPLAYED = new Set(['staff.move', 'staff.undo', 'staff.recalculate', 'defer.requested',
  'duo.improvised', 'duo.improvisedCancelled', 'duo.improvisedReplaced', 'presence.skipped',
  'turn.unsent', 'stage.restarted', 'battle.external', 'duo.joinAccepted']);
const GAP_MS = 9500;     // fin d'un titre → début du suivant quand l'export ne dit rien
const ACK_MS = 100;      // accusé de KaraFun après un envoi

// ------------------------------------------------------------------ horloge
const clock = { now: 0 };
async function withClock(fn) {
  const real = Date.now;
  Date.now = () => clock.now;
  try { return await fn(); } finally { Date.now = real; }
}
function timeOf(t, tz = 'Europe/Paris') {
  return new Date(t).toLocaleTimeString('fr-FR', { timeZone: tz, hour12: false });
}

// ------------------------------------------------------------------ export
// `input` : chemin du fichier ou objet déjà lu.
function loadEvening(input) {
  const raw = typeof input === 'string' ? JSON.parse(fs.readFileSync(input, 'utf8')) : input;
  if (!raw || !Array.isArray(raw.events)) throw new Error('Export de soirée illisible : pas de liste « events ».');
  const skipped = {};
  const events = raw.events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => {
      const ok = e && typeof e.ev === 'string' && Number.isFinite(e.t) && (e.v == null || e.v === 1);
      if (!ok) skipped[e?.ev || '?'] = (skipped[e?.ev || '?'] || 0) + 1;
      return ok;
    })
    .sort((a, b) => (Number.isFinite(a.e.seq) && Number.isFinite(b.e.seq) ? a.e.seq - b.e.seq : a.e.t - b.e.t) || a.i - b.i)
    .map(({ e }) => e);
  const people = new Map();
  for (const p of raw.people || []) if (p?.key) people.set(p.key, { key: p.key, table: p.table, name: p.name || p.key });
  for (const e of events) {
    if (e.ev === 'person.joined' && !people.has(e.personId)) people.set(e.personId, { key: e.personId, table: e.tableId, name: e.personId });
  }
  const tables = new Map((raw.tables || []).filter(t => t?.key).map(t => [t.key, { key: t.key, individual: !!t.individual, name: t.name || t.key }]));
  const rules = { ...(events.find(e => e.ev === 'evening.started')?.rules || {}) };
  // Ouverture du karaoké : celle de evening-stats.js (dans l'export, sinon recalculée).
  let openedAt = raw.stats?.evening?.openedAt;
  if (!Number.isFinite(openedAt)) {
    try { openedAt = eveningStats.computeStats({ events: raw.events, now: events.at(-1)?.t || 0 }).evening.openedAt; } catch (_) { openedAt = null; }
  }
  if (!Number.isFinite(openedAt)) openedAt = events.find(e => e.ev === 'stage.started')?.t ?? events[0]?.t ?? 0;
  const requests = new Map();
  for (const e of events) if (e.ev === 'song.requested' && e.entryId && !requests.has(e.entryId)) requests.set(e.entryId, e);
  // Durée réellement jouée par titre et délais réels de lancement du k-ième titre :
  // depuis la fin du précédent (lecture auto) et depuis son envoi.
  const played = new Map();
  const startGaps = [];
  let battleSec = null;
  {
    const open = new Map(); let last = null; let lastEnd = 0; const sent = new Map();
    for (const e of events) {
      if (e.ev === 'turn.sent') sent.set(e.entryId, e.t);
      else if (e.ev === 'stage.started') {
        last = e; if (e.queueId != null) open.set(String(e.queueId), e);
        if (e.source === 'queue' || (e.entryId && e.source !== 'battle')) {
          startGaps.push({ endGap: e.t - lastEnd, sendGap: e.t - (sent.get(e.entryId) ?? e.t) });
        }
      } else if (e.ev === 'stage.ended') {
        const st = (e.queueId != null && open.get(String(e.queueId))) || last;
        lastEnd = e.t;
        if (!st) continue;
        const sec = Number.isFinite(Number(e.playedSec)) ? Number(e.playedSec) : (e.t - st.t) / 1000;
        if (st.entryId) played.set(st.entryId, sec);
        else if (st.source === 'battle') battleSec = sec;
      }
    }
  }
  // Arrêts de l'application : rien ne part pendant ces intervalles (rejeu libre).
  const offline = [];
  { let stoppedAt = null;
    for (const e of events) {
      if (e.ev === 'app.stopped') stoppedAt = e.t;
      else if (e.ev === 'app.started' && stoppedAt != null) { offline.push([stoppedAt, e.t]); stoppedAt = null; }
    } }
  const timezone = raw.evening?.timezone || 'Europe/Paris';
  const realPassages = passagesFromEvents(events);
  // Attentes de evening-stats.js présentes dans l'export (vérification de la définition).
  const exportWaits = new Map();
  for (const st of raw.stats?.timeline?.stages || []) if (st.entryId && st.waitSec != null) exportWaits.set(st.entryId, st.waitSec);
  return { raw, events, people, tables, rules, openedAt, requests, played, startGaps, battleSec, offline,
    timezone, realPassages, exportWaits, skipped };
}

// Passages réels de la file, comme evening-stats.js les reconstruit : même
// titre relancé = un passage ; un passage se termine au plus tard au début du
// suivant ; invitée retirée avant le lancement exclue ; duo noté par le bar ajouté.
function passagesFromEvents(events) {
  const stages = [];
  const open = new Map();
  const leftDuo = new Map();
  const improvisedLater = new Map();
  const sent = new Map();
  for (const e of events) {
    const t = e.t;
    switch (e.ev) {
      case 'turn.sent': if (e.entryId) sent.set(e.entryId, e); break;
      case 'duo.left': {
        const guest = e.personId || e.partnerId || e.guestId;
        if (!e.entryId || !guest) break;
        const st = stages.find(x => x.entryId === e.entryId);
        if (st && !st.ended) st.ids = st.ids.filter(id => id !== guest);
        else if (!st) leftDuo.set(e.entryId, [...(leftDuo.get(e.entryId) || []), guest]);
        break;
      }
      case 'duo.improvised': {
        const st = [...stages].reverse().find(x => e.entryId ? x.entryId === e.entryId : e.queueId != null && x.queueId === e.queueId);
        if (st) { if (!st.ids.includes(e.partnerId)) st.ids.push(e.partnerId); } else if (e.entryId) improvisedLater.set(e.entryId, e.partnerId);
        break;
      }
      case 'stage.started': {
        const queueId = e.queueId == null ? null : String(e.queueId);
        if (queueId != null && open.has(queueId)) { open.get(queueId).segmentStart = t; break; }
        const previous = stages.at(-1);
        if (queueId != null && previous?.queueId === queueId) {
          previous.endAt = null; previous.ended = false; previous.segmentStart = t; open.set(queueId, previous); break;
        }
        for (const [qid, st] of open) { if (st.endAt == null) st.endAt = t; open.delete(qid); }
        let ids = Array.isArray(e.ids) ? e.ids.filter(id => typeof id === 'string') : [];
        if (e.entryId && leftDuo.has(e.entryId)) ids = ids.filter(id => !leftDuo.get(e.entryId).includes(id));
        const later = e.entryId && improvisedLater.get(e.entryId);
        if (later && !ids.includes(later)) ids.push(later);
        const source = e.source || (ids.length ? 'queue' : 'native');
        const st = { start: t, endAt: null, ended: false, queueId, entryId: e.entryId || null, ids, source,
          title: e.title || '', newRound: !!sent.get(e.entryId)?.newRound };
        stages.push(st);
        open.set(queueId ?? `#${stages.length}`, st);
        break;
      }
      case 'stage.ended': {
        const queueId = e.queueId == null ? null : String(e.queueId);
        const st = (queueId != null && open.get(queueId)) || [...open.values()].at(-1);
        if (!st) break;
        const played = Number(e.playedSec);
        st.endAt = Number.isFinite(played) ? Math.min(t, (st.segmentStart ?? st.start) + played * 1000) : t;
        st.ended = true;
        for (const [qid, v] of open) if (v === st) open.delete(qid);
        break;
      }
      default: break;
    }
  }
  return stages.map(st => ({ entryId: st.entryId, ids: st.ids, start: st.start, end: st.endAt ?? st.start,
    source: st.source, title: st.title, newRound: st.newRound }));
}

// Statistiques de evening-stats.js sur un journal (gardées pour chaque
// tableau d'événements : la soirée réelle est relue plusieurs fois).
const statsCache = new WeakMap();
function statsOf(events) {
  if (!statsCache.has(events)) {
    statsCache.set(events, eveningStats.computeStats({ events, now: events.reduce((m, e) => Math.max(m, e.t), 0) }));
  }
  return statsCache.get(events);
}

// Événements de passage que le rejeu libre remplace par les siens.
const STAGE_EVENTS = new Set(['stage.started', 'stage.ended', 'stage.restarted', 'turn.sent', 'turn.unsent',
  'duo.improvised', 'duo.improvisedCancelled', 'duo.improvisedReplaced']);
// Journal du rejeu libre : les événements réels (demandes, duos, retraits,
// départs, connexions…) et les passages rejoués à la place des passages réels.
function replayJournal(ev, passages) {
  const merged = ev.events.filter(e => !STAGE_EVENTS.has(e.ev)).map((e, order) => ({ e, order }));
  passages.forEach((st, k) => {
    const queueId = `rejeu-${k}`;
    merged.push({ order: 1e9 + 2 * k, e: { v: 1, t: st.start, ev: 'stage.started', queueId, entryId: st.entryId,
      ids: st.ids, ownerId: st.ids[0] || null, source: st.source === 'queue' ? 'queue' : st.source, title: st.title } });
    merged.push({ order: 1e9 + 2 * k + 1, e: { v: 1, t: st.end, ev: 'stage.ended', queueId,
      playedSec: Math.round((st.end - st.start) / 1000) } });
  });
  merged.sort((a, b) => a.e.t - b.e.t || a.order - b.order);
  return merged.map(({ e }, i) => ({ ...e, seq: i + 1, boot: 'rejeu' }));
}

// Attente de chaque passage de la file, calculée par evening-stats.js sur le
// journal `events` (la soirée par défaut). Les autres passages (Battle, titre
// hors file) n'ont pas d'attente.
function computeWaits(passages, ev, events = ev.events) {
  const stats = statsOf(events);
  const waits = new Map(stats.timeline.stages.filter(st => st.entryId && st.waitSec != null).map(st => [st.entryId, st.waitSec]));
  return passages.filter(st => st.source === 'queue' && st.ids.length && waits.has(st.entryId)).map(st => {
    const waitSec = waits.get(st.entryId);
    return { ...st, owner: st.ids[0], readyAt: st.start - waitSec * 1000, waitSec };
  });
}

// Plus longue attente sans monter sur scène de chaque personne (invité compris).
function stageWaitsOf(events) {
  return Object.fromEntries(statsOf(events).singers.filter(x => x.stageWaits?.n)
    .map(x => [x.id, { n: x.stageWaits.n, guestN: x.stageWaits.guestN, maxSec: x.stageWaits.maxSec, avgSec: x.stageWaits.avgSec }]));
}

// ------------------------------------------------------------------ statistiques (comme evening-stats.js)
function quantile(list, q) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}
function summary(waitsSec) {
  const n = waitsSec.length;
  const min = x => x == null ? null : Math.round(x / 6) / 10;
  return { n, avgMin: n ? min(waitsSec.reduce((a, b) => a + b, 0) / n) : null, medianMin: min(eveningStats.median(waitsSec)),
    p90Min: min(quantile(waitsSec, 0.9)), maxMin: n ? min(Math.max(...waitsSec)) : null,
    over45: waitsSec.filter(x => x >= 2700).length, over60: waitsSec.filter(x => x >= 3600).length };
}

// ------------------------------------------------------------------ contexte de rejeu
function resolveJar(solver) {
  if (!solver) return null;
  if (typeof solver === 'string') {
    if (!fs.existsSync(solver)) throw new Error(`Jar Timefold introuvable : ${solver}`);
    return solver;
  }
  const jar = DEFAULT_JARS.find(fs.existsSync);
  if (!jar) throw new Error('Jar Timefold absent (solver/target/karafun-solver.jar) : construire le solveur ou retirer --solveur.');
  return jar;
}

function makeContext(ev, opts) {
  const overrides = { ...(opts.options || {}) };
  const rules = { ...ev.rules, ...overrides };
  const schedOpts = {};
  for (const k of SCHED_RULES) if (rules[k] !== undefined) schedOpts[k] = rules[k];
  const s = new Scheduler(schedOpts);
  // Le rejeu demande lui-même le plan à chaque décision (ensurePlan) : pas de
  // calcul lancé en tâche de fond ni d'optimisation continue.
  s._maybeRequestSolver = () => false;
  s._scheduleRefine = () => {};
  s.solverBridge = null;
  const ctx = { ev, s, rules, overrides, key2pid: new Map(), pid2key: new Map(), real2rep: new Map(), rep2real: new Map(),
    notes: [], ignored: {}, notReplayed: {}, decisions: [], budget: opts.budget || 3000, solver: null, jar: null };
  const jar = resolveJar(opts.solver);
  if (jar) {
    const { TimefoldBridge } = require('../solver/bridge');
    s.solverBridge = new TimefoldBridge({ jar, settleMs: 0 });
    ctx.solver = s.solverBridge; ctx.jar = jar;
  }
  return ctx;
}

const keyOf = (ctx, pid) => ctx.pid2key.get(pid) || pid;
const nameOf = (ctx, key) => ctx.ev.people.get(key)?.name || key;
const who = (ctx, keys) => keys.map(k => nameOf(ctx, k)).join(' & ');
const note = (ctx, msg) => ctx.notes.push(`${timeOf(clock.now, ctx.ev.timezone)} ${msg}`);

// Plan Timefold à jour pour l'état courant, attendu avant la décision.
async function ensurePlan(ctx) {
  const s = ctx.s;
  if (!ctx.solver) return;
  const fp = s.solverContextFingerprint();
  if (s.solverPlan && s.solverPlan.fingerprint === fp) return;
  s.solverPlan = null;
  s.solverRequestedFingerprint = null;
  const started = s._requestSolver(fp, { budgetMs: ctx.budget, forced: true });
  if (started && s.solverPromise) { try { await s.solverPromise; } catch (_) { /* ordre local */ } }
}

// Choix rendu par select()/reserveNext(), en clés de l'export.
function pickOf(ctx, sel) {
  if (!sel) return null;
  return { ids: sel.ids.map(pid => keyOf(ctx, pid)), entryId: ctx.rep2real.get(sel.song?.entryId) || sel.song?.entryId || null,
    title: sel.song?.title || '', borrowedIds: (sel.borrowedIds || []).map(pid => keyOf(ctx, pid)),
    newRound: !!(sel.roundResets || sel.newPersonRound), roundResets: sel.roundResets || 0, borrowable: !!sel.borrowable,
    owed: (sel.owed || []).map(pid => keyOf(ctx, pid)) };
}

// État de l'ordonnanceur au moment d'une décision : les candidats de la file
// et, pour chaque chanteur, ce que la rotation voit de lui.
function explain(ctx) {
  const s = ctx.s;
  const serial = s.appearanceSerial;
  const spacing = s._spacing();
  const ranks = s._activePlanRanks();
  const person = pid => {
    const p = s.people.get(pid) || {};
    const apps = s.roundApps.get(pid) || 0;
    const use = s.roundUse.get(pid) || 0;
    const last = p.lastAppearanceTurn || 0;
    return { key: keyOf(ctx, pid), inRound: s.roundPeople.has(pid), roundApps: apps, roundUse: +use.toFixed(3),
      debt: use >= 1 - EPS && apps === 0, owed: s.roundOwed.has(pid), last, waitStart: Math.max(last, p.readySerial || 0),
      spaced: !last || last <= serial - spacing, cooldown: s.duetCooldowns.get(pid) || 0,
      appearances: (p.sung || 0) + (p.duetGuestCount || 0), table: p.tableId || null };
  };
  const candidates = [];
  s.Q.forEach((pid, at) => {
    const p = s.people.get(pid);
    if (!p || p.withdrawnAt || !p.song) return;
    const duet = p.song.duet;
    const partner = duet?.state === 'accepted' ? s.people.get(duet.partnerId) : null;
    const ids = partner && !partner.withdrawnAt ? [pid, partner.id] : [pid];
    candidates.push({ at, owner: keyOf(ctx, pid), title: p.song.title, entryId: ctx.rep2real.get(p.song.entryId) || p.song.entryId,
      singers: ids.map(person), pendingDuo: duet?.state === 'pending', table: p.tableId,
      planRank: ranks ? (ranks.get(p.song.entryId) ?? null) : null });
  });
  return { serial, spacing, lastGroup: s.lastGroup, plan: !!ranks,
    reserved: s.reservedNext ? keyOf(ctx, s.reservedNext.personId) : null,
    roundPeople: [...s.roundPeople].map(pid => keyOf(ctx, pid)), roundOwed: [...s.roundOwed].map(pid => keyOf(ctx, pid)),
    candidates };
}

// ------------------------------------------------------------------ événements extérieurs (comme server.js)
function applyExternal(ctx, e, upcoming) {
  const s = ctx.s;
  const pid = k => ctx.key2pid.get(k);
  const P = k => s.people.get(pid(k));
  const entry = id => ctx.real2rep.get(id);
  if (NOT_REPLAYED.has(e.ev)) { ctx.notReplayed[e.ev] = (ctx.notReplayed[e.ev] || 0) + 1; return false; }
  if (!REPLAYED.has(e.ev)) return false;
  try {
    switch (e.ev) {
      case 'table.opened': {
        const t = s.table(e.tableId);
        t.individual = !!(e.individual ?? ctx.ev.tables.get(e.tableId)?.individual);
        return true;
      }
      case 'table.headcount': s.setHeadcount(e.tableId, e.n, e.by); return true;
      case 'person.joined': {
        const meta = ctx.ev.people.get(e.personId) || { name: e.personId };
        const t = s.table(e.tableId);
        // Effectif dépassé ou jamais saisi : le bar l'avait ajusté, l'inscription a eu lieu.
        const count = s.tableSingers(t.id).length;
        if (!t.individual && (t.headcount == null || count >= t.headcount)) t.headcount = Math.max(count + 1, t.headcount || 1);
        let name = meta.name;
        try { s.validName(name, t.id); } catch (_) { name = e.personId; }
        const p = s.join({ tableId: t.id, name });
        ctx.key2pid.set(e.personId, p.id); ctx.pid2key.set(p.id, e.personId);
        return true;
      }
      case 'song.requested': {
        const p = P(e.personId);
        if (!p) { note(ctx, `demande ignorée (personne inconnue ${e.personId})`); return false; }
        const song = { songId: e.songId, title: e.title || `Titre ${e.songId}`, artist: e.artist || '', duration: e.durationSec };
        const before = new Set(s.songsOf(p).map(x => x.entryId));
        // Un duo est demandé puis aussitôt noté (inviteDuet) : même table, accepté d'office.
        const duo = upcoming.find(x => x.ev === 'duo.invited' && x.entryId === e.entryId);
        const partner = duo && P(duo.partnerId);
        if (duo && partner && !partner.withdrawnAt) s.inviteDuet(p, partner.id, song);
        else s.chooseSong(p, song, e.mode === 'replace' ? 'replace' : 'append');
        const fresh = s.songsOf(p).find(x => !before.has(x.entryId));
        if (fresh) { ctx.real2rep.set(e.entryId, fresh.entryId); ctx.rep2real.set(fresh.entryId, e.entryId); }
        return true;
      }
      case 'duo.invited': return false; // traité avec song.requested
      case 'duo.answered': {
        const guest = P(e.partnerId || e.personId);
        if (!guest || !entry(e.entryId)) return false;
        s.answerDuet(guest, !!e.accepted, entry(e.entryId));
        return true;
      }
      case 'duo.cancelled': {
        const actor = P(e.personId) || P(e.ownerId);
        if (!actor || !entry(e.entryId)) return false;
        s.cancelDuet(actor, entry(e.entryId));
        return true;
      }
      case 'duo.left': {
        const guest = P(e.guestId || e.personId);
        if (!guest || !entry(e.entryId)) return false;
        s.leaveDuet(guest, pid(e.ownerId), entry(e.entryId));
        return true;
      }
      case 'song.removed': {
        const p = P(e.personId);
        const id = entry(e.entryId);
        if (!p || !s.songsOf(p).some(x => x.entryId === id)) { note(ctx, `retrait ignoré (titre déjà passé ou inconnu) ${e.entryId}`); return false; }
        s.removeSong(p, id, e.by || 'self');
        return true;
      }
      case 'song.reordered': {
        const p = P(e.personId);
        const id = entry(e.entryId);
        const list = p ? s.songsOf(p) : [];
        const from = list.findIndex(x => x.entryId === id);
        if (from < 0) { note(ctx, `réordre ignoré (titre absent) ${e.entryId}`); return false; }
        const to = Math.max(0, Math.min(Number(e.toIndex) || 0, list.length - 1));
        if (from !== to) s.reorderSongs(p, id, to);
        return true;
      }
      case 'table.left': s.tableLeft(e.tableId); return true;
      case 'person.left': { const p = P(e.personId); if (!p) return false; s.leave(p, e.by || 'self'); return true; }
      case 'person.reactivated': { const p = P(e.personId); if (!p) return false; p.withdrawnAt = null; return true; }
      case 'person.bonus': if (!pid(e.personId)) return false; s.setPersonBonus(pid(e.personId), e.level); return true;
      case 'table.bonus': s.setTableBonus(e.tableId, e.level); return true;
      case 'settings.changed': {
        // Une règle remplacée par --option garde la valeur demandée.
        if (!SCHED_RULES.includes(e.setting) || e.setting in ctx.overrides) return false;
        s.opts[e.setting] = e.to;
        return true;
      }
      case 'person.transferred': return false; // autre téléphone : rien ne change pour la file
      default: return false;
    }
  } catch (err) {
    note(ctx, `${e.ev} non rejoué : ${err.message}`);
    return false;
  }
}

function countIgnored(ctx, e) {
  if (!REPLAYED.has(e.ev) && !NOT_REPLAYED.has(e.ev)) ctx.ignored[e.ev] = (ctx.ignored[e.ev] || 0) + 1;
}

// ------------------------------------------------------------------ rejeu FORCÉ
async function runForced(evening, opts = {}) {
  const ev = evening?.events && evening.requests ? evening : loadEvening(evening);
  return withClock(async () => {
    clock.now = ev.events[0]?.t || 0;
    const ctx = makeContext(ev, opts);
    const { s } = ctx;
    const sels = new Map(); // entryId réel → passage engagé
    let current = null, upcoming = null, hold = false, reservation = null;
    const reserveIfDue = async why => {
      if (current?.kind !== 'song' || upcoming || hold || s.reservedNext) return;
      await ensurePlan(ctx);
      const sel = s.reserveNext();
      if (sel) reservation = { at: clock.now, time: timeOf(clock.now, ev.timezone), why, pick: pickOf(ctx, sel), state: explain(ctx) };
    };
    try {
      for (let i = 0; i < ev.events.length; i++) {
        const e = ev.events[i];
        if (opts.until != null && e.t > opts.until) break; // arrêt anticipé (heure en ms)
        clock.now = e.t;
        countIgnored(ctx, e);
        const soon = ev.events.slice(i + 1, i + 6).filter(x => x.t - e.t < 1000);
        if (applyExternal(ctx, e, soon)) { await reserveIfDue(e.ev); continue; }
        switch (e.ev) {
          case 'turn.sent': {
            const owner = ctx.key2pid.get(e.ownerId || e.ids?.[0]);
            const entry = ctx.real2rep.get(e.entryId);
            if (!owner || !entry) { note(ctx, `envoi réel sans titre connu (${e.entryId}) : ignoré`); break; }
            await ensurePlan(ctx);
            const state = explain(ctx);
            const held = s.reservedNext ? { ...s.reservedNext } : null;
            const sel = s.select({ stageFree: !current });
            // Choix sans la réservation, pour comparaison (réservation rendue ensuite).
            let freeAtSend = null;
            if (held) {
              s.reservedNext = null;
              freeAtSend = pickOf(ctx, s.select({ stageFree: !current }));
              s.reservedNext = held;
            }
            const match = !!sel && sel.ids[0] === owner && sel.song.entryId === entry;
            let committed = sel;
            if (!match) {
              // Engager le passage réel : réservation sur son auteur ; un solo dont
              // l'auteur a déjà sa place dans le tour ne peut venir que de l'anti-série.
              const p = s.people.get(owner);
              if (p && p.song?.entryId !== entry && s.songsOf(p).some(x => x.entryId === entry)) {
                note(ctx, `titre réel pas en tête de la liste de ${e.ownerId} : remis en tête`);
                s.reorderSongs(p, entry, 0);
              }
              const isSolo = !(p?.song?.duet?.state === 'accepted');
              const borrowable = isSolo && s.roundPeople.has(owner);
              s.reservedNext = { personId: owner, reservedAt: clock.now, ...(borrowable ? { borrowable: true } : {}) };
              committed = s.select({ stageFree: !current });
              if (!committed || committed.ids[0] !== owner || committed.song.entryId !== entry) {
                note(ctx, `impossible d'engager le passage réel ${e.ownerId} ${e.entryId} : l'état peut dériver`);
                s.reservedNext = held;
                break;
              }
            }
            const realIds = (e.ids || [e.ownerId]).filter(Boolean);
            const engaged = committed.ids.map(pid => keyOf(ctx, pid));
            if (JSON.stringify(engaged) !== JSON.stringify(realIds)) note(ctx, `chanteurs engagés ${engaged} ≠ réels ${realIds}`);
            s.commit(committed);
            sels.set(e.entryId, committed);
            upcoming = committed;
            const resv = reservation && held && reservation.pick?.ids[0] === keyOf(ctx, held.personId) ? reservation : null;
            ctx.decisions.push({ kind: 'send', at: clock.now, time: timeOf(clock.now, ev.timezone),
              real: { ids: realIds, entryId: e.entryId, title: committed.song.title, newRound: !!e.newRound },
              reservation: resv ? { at: resv.at, time: resv.time, why: resv.why, pick: resv.pick,
                match: resv.pick.ids[0] === e.ownerId && resv.pick.entryId === e.entryId, state: resv.state } : null,
              pick: pickOf(ctx, sel), match, freeAtSend, forced: !match, state,
              committed: pickOf(ctx, committed) });
            reservation = null;
            break;
          }
          case 'stage.started': {
            const sel = e.entryId ? sels.get(e.entryId) : null;
            if (sel) {
              s.recordStage(sel, clock.now);
              current = { kind: 'song', sel, start: clock.now };
              if (upcoming === sel) upcoming = null;
            } else current = { kind: e.source || 'native', start: clock.now };
            await reserveIfDue('stage.started');
            break;
          }
          case 'stage.ended': {
            if (current?.kind === 'song' && current.sel) {
              s.recordSlot((clock.now - current.start) / 1000);
              s.songEnded(current.sel.ids);
              s.endStage(current.sel);
            }
            current = null;
            break;
          }
          case 'battle.automation': {
            hold = !['released', 'resuming'].includes(e.status);
            if (!hold) await reserveIfDue('battle');
            break;
          }
          default: break;
        }
      }
    } finally {
      if (ctx.solver) ctx.solver.close();
    }
    // Passages : ceux de la soirée réelle (l'état les a suivis), avec la dette
    // de tour comptée par l'ordonnanceur à chaque engagement.
    const byEntry = new Map(ctx.decisions.map(d => [d.real.entryId, d]));
    const passages = computeWaits(ev.realPassages, ev).map(w => ({ ...w,
      borrowedIds: byEntry.get(w.entryId)?.committed?.borrowedIds || [], newRound: !!byEntry.get(w.entryId)?.real.newRound }));
    return finish(ctx, 'forcé', passages, null);
  });
}

// ------------------------------------------------------------------ rejeu LIBRE
async function runFree(evening, opts = {}) {
  const ev = evening?.events && evening.requests ? evening : loadEvening(evening);
  return withClock(async () => {
    const ctx = makeContext(ev, opts);
    const { s } = ctx;
    const pushMs = 1000 * Number(ctx.rules.pushDelaySec ?? 45);
    const ext = ev.events.filter(e => REPLAYED.has(e.ev) || NOT_REPLAYED.has(e.ev) ||
      ['battle.decided', 'closing.set'].includes(e.ev));
    for (const e of ev.events) countIgnored(ctx, e);
    const realBattle = ev.events.find(e => e.ev === 'battle.decided' && e.outcome === 'approved');
    const auto = ev.events.filter(e => e.ev === 'battle.automation');
    const bSending = auto.find(e => e.status === 'sending'), bPlaying = auto.find(e => e.status === 'playing');
    const battlePreGap = bSending && bPlaying ?
      bPlaying.t - Math.max(bSending.t, ev.events.find(e => e.ev === 'stage.ended' && e.t > bSending.t)?.t || bSending.t) : 132000;
    const battleMs = (ev.battleSec || 260) * 1000;
    const offlineAt = t => ev.offline.some(([a, b]) => t >= a && t < b);
    let closingAt = Infinity;
    const stages = [];
    let current = null, upcoming = null, lastEnd = 0;
    let battle = realBattle ? 'none' : 'never';
    const durOf = sel => 1000 * (ev.played.get(ctx.rep2real.get(sel.song.entryId)) ?? (Number(sel.song.duration) || 200));
    // Début du prochain titre : délais réels du titre de même rang.
    const startAt = () => {
      const g = ev.startGaps[stages.filter(x => x.kind === 'song').length];
      if (!g) return Math.max(lastEnd, upcoming.sentAt) + GAP_MS;
      return Math.max(lastEnd + g.endGap, upcoming.sentAt + Math.min(g.sendGap, g.endGap > 60000 ? g.sendGap : 15000));
    };
    const stepServer = async () => {
      if (current && clock.now >= current.end) {
        if (current.kind === 'song') { s.recordSlot((current.end - current.start) / 1000); s.songEnded(current.sel.ids); s.endStage(current.sel); }
        if (current.kind === 'battle') battle = 'done';
        lastEnd = current.end; current = null;
      }
      if (!current && upcoming && clock.now >= startAt()) {
        current = { kind: 'song', sel: upcoming.sel, start: clock.now, end: clock.now + durOf(upcoming.sel), sentAt: upcoming.sentAt,
          decision: upcoming.decision };
        s.recordStage(upcoming.sel, clock.now);
        stages.push(current); upcoming = null;
      }
      if (battle === 'waiting' && !upcoming && !(s.reservedNext && current)) battle = 'queued';
      if (!current && !upcoming && battle === 'queued' && clock.now >= lastEnd + battlePreGap) {
        current = { kind: 'battle', start: clock.now, end: clock.now + battleMs }; stages.push(current); battle = 'playing';
      }
      const hold = ['queued', 'playing'].includes(battle) || offlineAt(clock.now);
      if (!upcoming && !hold && current?.kind === 'song' && !s.reservedNext) {
        await ensurePlan(ctx);
        const state = explain(ctx);
        const sel = s.reserveNext();
        if (sel) ctx.decisions.push({ kind: 'reserve', at: clock.now, time: timeOf(clock.now, ev.timezone), pick: pickOf(ctx, sel), state });
      }
      const canPush = !current || clock.now - current.start >= pushMs;
      if (!upcoming && !hold && canPush && clock.now < closingAt) {
        await ensurePlan(ctx);
        const state = explain(ctx);
        const sel = s.select({ stageFree: !current });
        if (sel) {
          s.commit(sel);
          const decision = { kind: 'send', at: clock.now, time: timeOf(clock.now, ev.timezone), pick: pickOf(ctx, sel), state };
          ctx.decisions.push(decision);
          upcoming = { sel, sentAt: clock.now + ACK_MS, decision };
        }
      }
    };
    let i = 0;
    clock.now = ext[0]?.t || 0;
    try {
      for (let guard = 0; guard < 200000; guard++) {
        while (i < ext.length && ext[i].t <= clock.now) {
          const e = ext[i++];
          if (e.ev === 'battle.decided') { if (e.outcome === 'approved' && battle === 'none') battle = 'waiting'; continue; }
          if (e.ev === 'closing.set') { closingAt = Number.isFinite(e.closingAt) ? e.closingAt : Infinity; continue; }
          applyExternal(ctx, e, ext.slice(i, i + 5).filter(x => x.t - e.t < 1000));
        }
        // Plusieurs passages du serveur au même instant (fin → début → envoi).
        for (let k = 0; k < 4; k++) await stepServer();
        const next = [];
        if (i < ext.length) next.push(ext[i].t);
        if (current) next.push(current.end, current.start + pushMs);
        if (!current && upcoming) next.push(startAt());
        if (!current && !upcoming && battle === 'queued') next.push(lastEnd + battlePreGap);
        for (const [, b] of ev.offline) next.push(b);
        const future = next.filter(t => t > clock.now);
        if (!future.length) break;
        clock.now = Math.min(...future);
      }
    } finally {
      if (ctx.solver) ctx.solver.close();
    }
    const replayPassages = stages.map(st => st.kind === 'song' ? {
      entryId: ctx.rep2real.get(st.sel.song.entryId) || st.sel.song.entryId, ids: st.sel.ids.map(pid => keyOf(ctx, pid)),
      start: st.start, end: st.end, source: 'queue', title: st.sel.song.title,
      newRound: !!st.decision?.pick.newRound, borrowedIds: st.decision?.pick.borrowedIds || [] } :
      { entryId: null, ids: [], start: st.start, end: st.end, source: st.kind, title: st.kind });
    const journal = replayJournal(ev, replayPassages);
    const passages = computeWaits(replayPassages, ev, journal).map(w => ({ ...w, borrowedIds: w.borrowedIds || [] }));
    return finish(ctx, 'libre', passages, compareOrders(ev, passages), stageWaitsOf(journal));
  });
}

// Ordre réel et ordre rejoué (rejeu libre).
function compareOrders(ev, passages) {
  const real = computeWaits(ev.realPassages, ev);
  const realOrder = real.map(w => w.entryId), repOrder = passages.map(w => w.entryId);
  let samePosition = 0;
  for (let k = 0; k < Math.min(realOrder.length, repOrder.length); k++) if (realOrder[k] === repOrder[k]) samePosition++;
  const rank = new Map(realOrder.map((e, k) => [e, k]));
  const shifts = repOrder.map((e, k) => rank.has(e) ? Math.abs(k - rank.get(e)) : null).filter(x => x != null);
  const inReplay = new Set(repOrder);
  return { samePosition, songsReal: real.length, songsReplay: passages.length,
    meanRankShift: shifts.length ? Math.round(10 * shifts.reduce((a, b) => a + b, 0) / shifts.length) / 10 : 0,
    maxRankShift: shifts.length ? Math.max(...shifts) : 0,
    notSungInReplay: real.filter(w => !inReplay.has(w.entryId)).map(w => w.entryId),
    extraInReplay: passages.filter(w => !rank.has(w.entryId)).map(w => w.entryId) };
}

// ------------------------------------------------------------------ analyse
// Tours : du premier passage d'un tour (envoi marqué « nouveau tour ») au premier du suivant.
function analyse(passages) {
  const rounds = [];
  for (const p of passages) {
    if (!rounds.length || p.newRound) rounds.push({ start: p.start, end: null, passages: [] });
    rounds.at(-1).passages.push(p);
  }
  rounds.forEach((r, k) => { r.end = rounds[k + 1]?.start ?? null; r.index = k + 1; });
  const complete = rounds.filter(r => r.end != null);
  const roundMs = complete.map(r => r.end - r.start);
  const longestRoundMs = roundMs.length ? Math.max(...roundMs) : null;
  // Monté sur scène en invité pendant l'attente de son titre : la rotation
  // ne le lui compte pas comme son tour, mais il n'attendait pas sans chanter.
  const guestDuring = p => passages.filter(q => q.start > p.readyAt && q.start < p.start && q.ids.slice(1).includes(p.owner)).length;
  const longWaits = longestRoundMs == null ? [] : passages.filter(p => p.waitSec * 1000 > longestRoundMs)
    .map(p => ({ entryId: p.entryId, owner: p.owner, ids: p.ids, title: p.title, start: p.start, waitSec: p.waitSec,
      guestStages: guestDuring(p) }));
  // Quelqu'un vu deux fois sur scène pendant sa propre attente.
  const doubles = [];
  for (const p of passages) {
    const seen = new Map();
    for (const q of passages) {
      if (q === p || q.start <= p.readyAt || q.start >= p.start) continue;
      for (const id of q.ids) if (id !== p.owner) seen.set(id, (seen.get(id) || 0) + 1);
    }
    for (const [id, n] of seen) if (n >= 2) doubles.push({ owner: p.owner, title: p.title, start: p.start, waitSec: p.waitSec, saw: id, times: n });
  }
  // Prêt pendant tout un tour complet sans y monter sur scène.
  const debtors = new Map(); // clé → heure de la dernière dette créée
  for (const p of passages) for (const id of p.borrowedIds || []) debtors.set(id, p.start);
  const skipped = [];
  for (const r of complete) {
    const on = new Set(r.passages.flatMap(p => p.ids));
    for (const p of passages) {
      if (p.readyAt <= r.start && p.start >= r.end && !on.has(p.owner)) {
        skipped.push({ owner: p.owner, title: p.title, round: r.index, roundStart: r.start, roundEnd: r.end,
          debt: debtors.has(p.owner) && debtors.get(p.owner) < r.start });
      }
    }
  }
  const debts = passages.filter(p => (p.borrowedIds || []).length)
    .map(p => ({ start: p.start, ids: p.ids, title: p.title, borrowedIds: p.borrowedIds }));
  return { rounds: rounds.map(r => ({ index: r.index, start: r.start, end: r.end, passages: r.passages.length,
    minutes: r.end != null ? Math.round((r.end - r.start) / 6000) / 10 : null })),
  longestRoundMin: longestRoundMs == null ? null : Math.round(longestRoundMs / 6000) / 10,
  longWaits, doubles, skipped, debts };
}

function finish(ctx, mode, passages, order, replayStageWaits = null) {
  const ev = ctx.ev;
  const real = computeWaits(ev.realPassages, ev);
  // Définition de l'attente vérifiée contre celle de evening-stats.js (export).
  const checked = real.filter(w => ev.exportWaits.has(w.entryId));
  const definitionCheck = { compared: checked.length, equal: checked.filter(w => ev.exportWaits.get(w.entryId) === w.waitSec).length };
  const sends = ctx.decisions.filter(d => d.kind === 'send');
  const fidelity = mode === 'forcé' ? {
    sends: sends.length,
    matchAtSend: sends.filter(d => d.match).length,
    reservations: sends.filter(d => d.reservation).length,
    matchAtReservation: sends.filter(d => d.reservation?.match).length,
    matchFreeAtSend: sends.filter(d => d.freeAtSend ? d.freeAtSend.ids[0] === d.real.ids[0] && d.freeAtSend.entryId === d.real.entryId : d.match).length,
    newRoundAgree: sends.filter(d => d.committed && d.committed.newRound === d.real.newRound).length,
  } : order;
  return { mode, solver: !!ctx.solver, jar: ctx.jar, options: ctx.overrides, timezone: ev.timezone,
    names: Object.fromEntries([...ev.people].map(([k, p]) => [k, p.name])),
    decisions: ctx.decisions, passages, realWaits: real, fidelity, definitionCheck,
    waits: { real: summary(real.map(w => w.waitSec)), replay: summary(passages.map(w => w.waitSec)) },
    stageWaits: { real: stageWaitsOf(ev.events), replay: replayStageWaits },
    analysis: analyse(passages), notes: ctx.notes, ignored: ctx.ignored, notReplayed: ctx.notReplayed,
    unreadable: ev.skipped };
}

// ------------------------------------------------------------------ texte
function report(res, { traces = [], short = false } = {}) {
  const tz = res.timezone;
  const T = t => timeOf(t, tz);
  const nm = k => res.names[k] || k;
  const W = ids => ids.map(nm).join(' & ');
  const min = sec => `${Math.round(sec / 60)} min`;
  const out = [];
  const head = `REJEU ${res.mode.toUpperCase()}${res.solver ? ' [Timefold]' : ' [sans Timefold]'}` +
    `${Object.keys(res.options).length ? ' options ' + Object.entries(res.options).map(([k, v]) => `${k}=${v}`).join(',') : ''}`;
  out.push(head);
  const f = res.fidelity;
  if (res.mode === 'forcé') {
    out.push(`Fidélité : ${f.matchAtSend}/${f.sends} envois identiques à la réalité ; réservations ${f.matchAtReservation}/${f.reservations} ; ` +
      `sans la réservation ${f.matchFreeAtSend}/${f.sends} ; nouveau tour au même envoi ${f.newRoundAgree}/${f.sends}`);
  } else {
    out.push(`Ordre : ${f.samePosition}/${f.songsReal} titres au même rang ; décalage moyen ${f.meanRankShift} (max ${f.maxRankShift}) ; ` +
      `chantés ${f.songsReplay} (réel ${f.songsReal})`);
    if (f.notSungInReplay.length) out.push(`  pas chantés dans le rejeu : ${f.notSungInReplay.length}`);
  }
  out.push(`Attente par titre (evening-stats.js${res.definitionCheck.compared ? `, ${res.definitionCheck.equal}/${res.definitionCheck.compared} identiques à l'export` : ''}) :`);
  const S = x => `n=${x.n} moy ${x.avgMin} méd ${x.medianMin} P90 ${x.p90Min} max ${x.maxMin} min ; ≥45 min ${x.over45} ; ≥60 min ${x.over60}`;
  out.push(`  réel  : ${S(res.waits.real)}`);
  if (res.mode === 'libre') out.push(`  rejeu : ${S(res.waits.replay)}`);
  // Sans monter sur scène (invités compris) : les trois plus longues.
  const top = waits => Object.entries(waits || {}).sort((a, b) => b[1].maxSec - a[1].maxSec).slice(0, 3)
    .map(([k, x]) => `${nm(k)} ${min(x.maxSec)}${x.guestN ? ` (dont ${x.guestN} en invité)` : ''}`).join(', ') || '—';
  out.push(`Sans monter sur scène, plus longues : réel ${top(res.stageWaits.real)}` +
    `${res.mode === 'libre' ? ` ; rejeu ${top(res.stageWaits.replay)}` : ''}`);
  const pk = p => p ? `${W(p.ids)} «${p.title}»` : 'aucun';
  if (!short) {
    out.push('', 'Décisions :');
    for (const d of res.decisions) {
      if (res.mode === 'forcé') {
        const flag = d.match ? ' = ' : ' ≠ ';
        const nr = d.real.newRound !== d.committed?.newRound ? ` [nouveau tour réel=${d.real.newRound} rejeu=${d.committed?.newRound}]` :
          d.real.newRound ? ' [nouveau tour]' : '';
        out.push(`${d.time}${flag}réel ${W(d.real.ids)} «${d.real.title}»${d.match ? '' : ` | rejeu ${pk(d.pick)}`}` +
          `${d.committed?.borrowedIds.length ? ` [dette : ${W(d.committed.borrowedIds)}]` : ''}${nr}` +
          `${d.reservation ? ` (réservé ${d.reservation.time}${d.reservation.match ? '' : ` : ${pk(d.reservation.pick)}`})` : ''}`);
      } else if (d.kind === 'send') {
        out.push(`${d.time}  envoi ${pk(d.pick)}${d.pick.borrowedIds.length ? ` [dette : ${W(d.pick.borrowedIds)}]` : ''}${d.pick.newRound ? ' [nouveau tour]' : ''}`);
      }
      if (traces.some(t => d.time.startsWith(t))) out.push(...traceLines(res, d));
    }
    out.push('', `Attentes par titre (${res.mode === 'libre' ? 'réel → rejeu' : 'réel'}) :`);
    const replayed = new Map(res.passages.map(p => [p.entryId, p]));
    for (const w of res.realWaits) {
      const r = replayed.get(w.entryId);
      out.push(`  ${T(w.start)} ${String(Math.round(w.waitSec / 60)).padStart(3)} min` +
        `${res.mode === 'libre' ? ` → ${r ? String(Math.round(r.waitSec / 60)).padStart(3) + ' min' : ' pas chanté'}` : ''}  ${W(w.ids)} «${w.title}»`);
    }
  } else if (traces.length) {
    for (const d of res.decisions) if (traces.some(t => d.time.startsWith(t))) out.push(...traceLines(res, d));
  }
  const a = res.analysis;
  out.push('', `Attentes anormales (${res.mode === 'libre' ? 'rejeu' : 'soirée réelle'}) :`);
  out.push(`  tours : ${a.rounds.length} (${a.rounds.filter(r => r.minutes != null).map(r => r.minutes + ' min').join(', ') || '—'}) ; plus long ${a.longestRoundMin ?? '—'} min`);
  out.push(`  attentes plus longues que le plus long tour : ${a.longWaits.length ? '' : 'aucune'}`);
  for (const w of a.longWaits) {
    out.push(`    ${T(w.start)} ${min(w.waitSec)} ${W(w.ids)} «${w.title}»${w.guestStages ? ` (monté sur scène entre-temps en invité${w.guestStages > 1 ? ` ${w.guestStages} fois` : ''})` : ''}`);
  }
  out.push(`  quelqu'un vu deux fois pendant l'attente : ${a.doubles.length ? '' : 'personne'}`);
  for (const x of a.doubles) out.push(`    ${T(x.start)} ${nm(x.owner)} «${x.title}» (${min(x.waitSec)}) a vu ${nm(x.saw)} ${x.times} fois`);
  out.push(`  prêt pendant tout un tour sans passer : ${a.skipped.length ? '' : 'personne'}`);
  for (const x of a.skipped) out.push(`    tour ${x.round} (${T(x.roundStart)}–${T(x.roundEnd)}) ${nm(x.owner)} «${x.title}»${x.debt ? ' — dette de tour en cours' : ''}`);
  out.push(`  dettes de tour créées : ${a.debts.length ? '' : 'aucune'}`);
  for (const x of a.debts) out.push(`    ${T(x.start)} ${W(x.ids)} «${x.title}» : ${W(x.borrowedIds)}`);
  const extra = [];
  if (Object.keys(res.notReplayed).length) extra.push('gestes non rejoués : ' + Object.entries(res.notReplayed).map(([k, n]) => `${k}×${n}`).join(', '));
  if (Object.keys(res.unreadable).length) extra.push('événements illisibles ou d’une autre version : ' + Object.entries(res.unreadable).map(([k, n]) => `${k}×${n}`).join(', '));
  if (extra.length || res.notes.length) out.push('');
  for (const l of extra) out.push(l);
  for (const l of res.notes) out.push('note : ' + l);
  return out.join('\n');
}

function traceLines(res, d) {
  const nm = k => res.names[k] || k;
  const lines = [];
  const block = (title, st, pick) => {
    if (!st) return;
    lines.push(`    ── ${title} : tour [${st.roundPeople.map(nm).join(', ')}]${st.roundOwed.length ? ` dus [${st.roundOwed.map(nm).join(', ')}]` : ''}` +
      ` passage n° ${st.serial}, espacement ${st.spacing}${st.reserved ? `, annoncé ${nm(st.reserved)}` : ''}${st.plan ? ', plan Timefold actif' : ''}`);
    for (const c of st.candidates) {
      const people = c.singers.map(p => `${nm(p.key)}[${p.inRound ? 'dans le tour' : 'pas passé'} scène=${p.roundApps}` +
        `${p.debt ? ' DETTE' : ''}${p.owed ? ' dû' : ''} dernier=${p.last} attend-depuis=${p.waitStart}${p.spaced ? '' : ' trop-proche'}` +
        `${p.cooldown ? ` répit=${p.cooldown}` : ''} table=${p.table}]`).join(' + ');
      const chosen = pick && pick.ids[0] === c.owner && pick.entryId === c.entryId ? '→' : ' ';
      lines.push(`     ${chosen} ${String(c.at).padStart(2)} «${c.title}»${c.pendingDuo ? ' (duo en attente de réponse)' : ''}` +
        `${c.planRank != null ? ` plan#${c.planRank}` : ''} : ${people}`);
    }
    if (pick) lines.push(`       choix : ${pick.ids.map(nm).join(' & ')} «${pick.title}»${pick.borrowedIds.length ? ` emprunt (dette) ${pick.borrowedIds.map(nm)}` : ''}` +
      `${pick.newRound ? ` nouveau tour (${pick.roundResets})` : ''}${pick.borrowable ? ' empruntable' : ''}`);
  };
  if (d.reservation) block(`à la réservation ${d.reservation.time} (${d.reservation.why})`, d.reservation.state, d.reservation.pick);
  block(d.kind === 'reserve' ? 'réservation' : 'à l\'envoi', d.state, d.pick);
  if (d.freeAtSend && !d.match) lines.push(`       sans la réservation : ${d.freeAtSend.ids.map(nm).join(' & ')} «${d.freeAtSend.title}»`);
  return lines;
}

// ------------------------------------------------------------------ CLI
function parseArgs(argv) {
  const o = { file: null, free: false, solver: false, budget: 3000, traces: [], json: null, options: {}, short: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--libre') o.free = true;
    else if (a === '--solveur') o.solver = argv[k + 1] && !argv[k + 1].startsWith('--') && /\.jar$/i.test(argv[k + 1]) ? argv[++k] : true;
    else if (a === '--budget') o.budget = Number(argv[++k]);
    else if (a === '--trace') o.traces.push(...String(argv[++k] || '').split(',').filter(Boolean));
    else if (a === '--json') o.json = argv[++k];
    else if (a === '--court') o.short = true;
    else if (a === '--option') {
      const [key, ...rest] = String(argv[++k] || '').split('=');
      const raw = rest.join('=');
      if (!key || !rest.length) throw new Error(`--option attend clé=valeur (reçu « ${argv[k]} »)`);
      o.options[key] = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    } else if (a === '-h' || a === '--help' || a === '--aide') o.help = true;
    else if (!a.startsWith('--') && !o.file) o.file = a;
    else throw new Error(`Option inconnue : ${a}`);
  }
  if (!Number.isFinite(o.budget) || o.budget <= 0) throw new Error('--budget attend un nombre de millisecondes');
  return o;
}

// Aide : le bloc d'usage de l'en-tête ci-dessus.
const USAGE = (() => {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  const from = lines.findIndex(l => l.includes('node test/rejeu-soiree.js <export.json>'));
  const to = lines.findIndex(l => l.startsWith(' * Programmatique'));
  return lines.slice(from, to).map(l => l.replace(/^ \* ?/, '')).join('\n').trimEnd();
})();

async function main(argv = process.argv.slice(2), print = console.log) {
  let o;
  try { o = parseArgs(argv); } catch (err) { print(err.message + '\n\n' + USAGE); return 2; }
  if (o.help || !o.file) { print(USAGE); return o.help ? 0 : 2; }
  const ev = loadEvening(o.file);
  const run = o.free ? runFree : runForced;
  const res = await run(ev, { solver: o.solver, budget: o.budget, options: o.options });
  print(report(res, { traces: o.traces, short: o.short }));
  if (o.json) fs.writeFileSync(o.json, JSON.stringify(res, null, 1));
  return 0;
}

module.exports = { loadEvening, runForced, runFree, report, analyse, computeWaits, replayJournal, stageWaitsOf, passagesFromEvents, summary, main, parseArgs, timeOf };
if (require.main === module) main().then(code => { process.exitCode = code; }, err => { console.error(err); process.exitCode = 1; });
