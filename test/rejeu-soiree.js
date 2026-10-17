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
 *   --cles                 clés S01… à la place des prénoms (texte et JSON) : sortie
 *                          à reporter dans le dépôt ou une PR
 *   --avant <rév|dossier>  BILAN AVANT/APRÈS : la même soirée rejouée librement avec
 *                          l'ordonnanceur d'une autre version (révision git du dépôt,
 *                          extraite dans .git/karafun-rejeu, ou dossier de sources)
 *                          puis avec la version de travail, mesurées toutes deux par
 *                          evening-stats.js d'aujourd'hui : attentes, passages de chacun,
 *                          équilibre (indice de Jain, part de chacun), anomalies.
 *                          Avec --solveur, le jar de l'autre version est pris dans son
 *                          dossier, ou construit par Maven pour une révision git.
 *   --solveur-avant <jar>  jar Timefold de la version « avant » ; « sans » : version
 *                          « avant » sans Timefold. Ce qu'apporte Timefold :
 *                          --avant . --solveur --solveur-avant sans
 *
 * Programmatique : const r = require('./rejeu-soiree');
 *   const ev = r.loadEvening('export.json');
 *   const res = await r.runForced(ev, { solver, budget, options, until });   // ou r.runFree
 *   (`until` : rejeu forcé arrêté après cette heure, en ms)
 *   res.decisions, res.passages (attente par titre), res.analysis ; r.report(res)
 *   const cmp = await r.runCompare(ev, { before: { code: 'fd27698', solver: true },
 *     after: { solver: true }, budget, options });  r.compareReport(cmp)
 *   (`code` : révision git ou dossier, version de travail par défaut ; `solver`
 *   comme ci-dessus, true = jar de cette version)
 *
 * Aucune méthode de l'ordonnanceur n'est copiée ici : les choix viennent de
 * select() et reserveNext(), les explications de son ÉTAT au moment de la
 * décision (roundPeople, roundApps, roundUse, lastAppearanceTurn, readySerial…).
 * Les attentes sont calculées par evening-stats.js lui-même (computeStats,
 * définition de la page des statistiques : attente par titre, comme la
 * rotation, et sans monter sur scène par personne) sur un journal : celui de
 * la soirée, ou, en rejeu libre, le même journal où les passages rejoués
 * remplacent les passages réels, sans les gestes réels que le rejeu n'a pas pu
 * faire ni ceux qu'il ne refait pas (vidage de la file, « Pas prêt »), signalés
 * dans les notes et les avertissements. Comparées aux attentes enregistrées dans
 * l'export (une version plus ancienne de l'application peut en différer).
 *
 * Rejeu libre et serveur : comme server.js, l'heure de fermeture retient
 * ou retire un titre qui ne tiendrait plus avant l'heure ; un titre envoyé
 * suit les départs notés par le bar et les duos quittés ; une chanson
 * redemandée en « ajouter » alors qu'elle reste à chanter dans le rejeu
 * attend qu'elle quitte la liste ; chaque Battle approuvée est rejouée.
 * Rien ne part pendant un arrêt de l'application ni après la fin du
 * karaoké de la soirée réelle (evening-stats.js).
 *
 * Seul effet de bord : Date.now est remplacé par l'horloge de la soirée
 * pendant un rejeu, puis rendu. Ne parle jamais à KaraFun.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Scheduler } = require('../scheduler');
const { BUNDLED_JAVA } = require('../solver/bridge');
const eveningStats = require('../evening-stats');

const ROOT = path.join(__dirname, '..');
const jarsIn = dir => [path.join(dir, 'solver', 'target', 'karafun-solver.jar'), path.join(dir, 'solver', 'karafun-solver.jar')];
const EPS = 1e-9;
// Erreur d'utilisation (fichier, option, version) : message seul, sans trace.
class UsageError extends Error {}
// Règles de la soirée qui sont des options de l'ordonnanceur.
const SCHED_RULES = ['tableRotation', 'weightedTables', 'interleaveArrivals', 'roundAppearanceCap',
  'spacingSongs', 'requirePresence', 'gap', 'cap'];
// Événements du journal que le rejeu sait refaire (les autres sont ignorés).
const REPLAYED = new Set(['table.opened', 'table.headcount', 'person.joined', 'song.requested',
  'duo.invited', 'duo.answered', 'duo.cancelled', 'duo.left', 'duo.joinRequested', 'duo.joinAnswered',
  'duo.joinCancelled', 'song.removed', 'song.reordered', 'person.gaveSpot',
  'table.left', 'person.left', 'person.reactivated', 'person.bonus', 'table.bonus', 'person.transferred',
  'settings.changed']);
// Gestes qui changent la file mais que le rejeu ne refait pas : signalés.
const NOT_REPLAYED = new Set(['staff.move', 'staff.undo', 'staff.recalculate', 'defer.requested',
  'duo.improvised', 'duo.improvisedCancelled', 'duo.improvisedReplaced', 'presence.skipped',
  'turn.unsent', 'stage.restarted', 'battle.external', 'battle.staffLaunch', 'staff.queueCleared',
  'staff.absent']);
// Gestes sur les titres et les duos : un geste réel que le rejeu n'a pas pu
// faire (titre déjà chanté ou absent dans le rejeu) sort aussi du journal
// rejoué, sinon evening-stats.js le compterait comme fait.
const MUST_MATCH = new Set(['song.requested', 'song.removed', 'song.reordered', 'duo.answered', 'duo.cancelled',
  'duo.left', 'duo.joinRequested', 'duo.joinAnswered', 'duo.joinCancelled', 'person.gaveSpot']);
// Gestes non rejoués dont evening-stats.js tiendrait compte (titres vidés,
// « Pas prêt ») : hors du journal rejoué.
const NOT_IN_JOURNAL = new Set(['staff.queueCleared', 'defer.requested', 'defer.ended']);
const GAP_MS = 9500;     // fin d'un titre → début du suivant quand l'export ne dit rien
const SONG_GAP_MS = 20000; // temps moyen entre deux titres compté par la fermeture (server.js)
const ACK_MS = 100;      // accusé de KaraFun après un envoi

// ------------------------------------------------------------------ horloge
// Une seule horloge par processus : deux rejeux en même temps mélangeraient
// leurs heures (et laisseraient Date.now figé), le second est donc refusé.
const clock = { now: 0, busy: false };
const realNow = Date.now; // l'heure vraie, même pendant un rejeu
async function withClock(fn) {
  if (clock.busy) throw new Error('Un rejeu est déjà en cours dans ce processus : les lancer l’un après l’autre.');
  const real = Date.now;
  clock.busy = true;
  Date.now = () => clock.now;
  try { return await fn(); } finally { Date.now = real; clock.busy = false; }
}
function timeOf(t, tz = 'Europe/Paris') {
  return new Date(t).toLocaleTimeString('fr-FR', { timeZone: tz, hour12: false });
}

// ------------------------------------------------------------------ export
// `input` : chemin du fichier ou objet déjà lu.
function loadEvening(input) {
  let raw = input;
  if (typeof input === 'string') {
    let text;
    try { text = fs.readFileSync(input, 'utf8'); } catch (err) { throw new UsageError(`Export de soirée introuvable ou illisible : ${input} (${err.code || err.message})`); }
    try { raw = JSON.parse(text); } catch (err) { throw new UsageError(`Export de soirée illisible : ${input} n'est pas du JSON (${err.message})`); }
  }
  if (!raw || !Array.isArray(raw.events)) throw new UsageError('Export de soirée illisible : pas de liste « events ».');
  const skipped = {};
  // Ligne dupliquée après un arrêt brutal : ignorée, comme dans evening-stats.js.
  const seen = new Set();
  const events = raw.events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => {
      const ok = e && typeof e.ev === 'string' && Number.isFinite(e.t) && (e.v == null || e.v === 1);
      if (!ok) skipped[e?.ev || '?'] = (skipped[e?.ev || '?'] || 0) + 1;
      if (!ok || e.seq == null) return ok;
      const key = `${e.boot || ''}:${e.seq}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // Ordre des heures, puis des numéros d'ordre, comme evening-stats.js (une
    // horloge qui recule ne mélange pas les gestes du rejeu).
    .sort((a, b) => a.e.t - b.e.t || (Number.isFinite(a.e.seq) && Number.isFinite(b.e.seq) ? a.e.seq - b.e.seq : 0) || a.i - b.i)
    .map(({ e }) => e);
  const people = new Map();
  for (const p of raw.people || []) if (p?.key) people.set(p.key, { key: p.key, table: p.table, name: p.name || p.key });
  for (const e of events) {
    if (e.ev === 'person.joined' && !people.has(e.personId)) people.set(e.personId, { key: e.personId, table: e.tableId, name: e.personId });
  }
  const tables = new Map((raw.tables || []).filter(t => t?.key).map(t => [t.key, { key: t.key, individual: !!t.individual, name: t.name || t.key }]));
  const rules = { ...(events.find(e => e.ev === 'evening.started')?.rules || {}) };
  // Durée réellement jouée par titre et délais réels de lancement du k-ième titre :
  // depuis la fin du précédent (lecture auto) et depuis son envoi.
  const played = new Map();
  const startGaps = [];
  const battles = []; // durée jouée de chaque Battle, dans l'ordre
  {
    const open = new Map(); let last = null; let lastEnd = 0; const sent = new Map();
    for (const e of events) {
      if (e.ev === 'turn.sent') sent.set(e.entryId, e.t);
      else if (e.ev === 'stage.started') {
        const q = e.queueId == null ? null : String(e.queueId);
        // Même titre noté de nouveau (redémarrage pendant la chanson, reprise
        // juste après) : un seul passage, comme evening-stats.js ; la durée
        // jouée notée à sa fin part de la reprise.
        if (q != null && (open.has(q) || last?.q === q)) {
          const st = open.get(q) || last;
          st.resumedAt = e.t;
          open.set(q, st);
          continue;
        }
        open.clear();
        last = { e, q, resumedAt: null };
        open.set(q ?? `#${e.seq ?? e.t}`, last);
        if (e.source === 'queue' || (e.entryId && e.source !== 'battle')) {
          startGaps.push({ endGap: e.t - lastEnd, sendGap: e.t - (sent.get(e.entryId) ?? e.t) });
        }
      } else if (e.ev === 'stage.ended') {
        const q = e.queueId == null ? null : String(e.queueId);
        const st = (q != null && open.get(q)) || [...open.values()].at(-1);
        lastEnd = e.t;
        if (!st) continue;
        const playedSec = Number(e.playedSec);
        const endAt = Number.isFinite(playedSec) ? Math.min(e.t, (st.resumedAt ?? st.e.t) + playedSec * 1000) : e.t;
        const sec = (endAt - st.e.t) / 1000;
        if (st.e.entryId) played.set(st.e.entryId, sec);
        else if (st.e.source === 'battle') battles.push(sec);
        for (const [k, v] of open) if (v === st) open.delete(k);
      }
    }
  }
  // Arrêts de l'application : rien ne part pendant ces intervalles (rejeu
  // libre). Comme evening-stats.js, chaque redémarrage note la durée de
  // l'arrêt (offlineMs), arrêt propre ou coupure ; sans elle (ancien
  // export), de l'arrêt noté au redémarrage. Arrêt final sans redémarrage :
  // jusqu'au bout.
  const offline = [];
  { let stoppedAt = null;
    for (const e of events) {
      if (e.ev === 'app.stopped') stoppedAt = e.t;
      else if (e.ev === 'app.started') {
        const ms = Number(e.offlineMs);
        if (Number.isFinite(ms)) { if (ms > 0) offline.push([Math.max(events[0].t, e.t - ms), e.t]); }
        else if (stoppedAt != null) offline.push([stoppedAt, e.t]);
        stoppedAt = null;
      }
    }
    if (stoppedAt != null) offline.push([stoppedAt, Infinity]); }
  const timezone = raw.evening?.timezone || 'Europe/Paris';
  const realPassages = passagesFromEvents(events);
  // Attentes de evening-stats.js présentes dans l'export (vérification de la définition).
  const exportWaits = new Map();
  for (const st of raw.stats?.timeline?.stages || []) if (st.entryId && st.waitSec != null) exportWaits.set(st.entryId, st.waitSec);
  return { raw, events, people, tables, rules, played, startGaps, battles, offline,
    timezone, realPassages, exportWaits, skipped };
}

// Passages réels, tels que evening-stats.js les reconstruit (même titre
// relancé = un passage, invitée retirée avant le lancement exclue, duo noté
// par le bar ajouté ou annulé), avec le « nouveau tour » noté à l'envoi.
function passagesFromEvents(events) {
  const newRound = new Map();
  for (const e of events) if (e.ev === 'turn.sent' && e.entryId) newRound.set(e.entryId, !!e.newRound);
  return statsOf(events).timeline.stages.map(st => ({ entryId: st.entryId || null, ids: st.ids, start: st.start,
    end: st.end ?? st.start, source: st.source, title: st.title || '', newRound: !!newRound.get(st.entryId) }));
}

// Soirée déjà chargée par loadEvening, ou chemin / export à charger.
const asEvening = evening => (evening?.events && evening.realPassages ? evening : loadEvening(evening));

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
// départs, connexions…) et les passages rejoués à la place des passages réels,
// avec leur envoi (la rotation compte un passage à son envoi). `skip` : gestes
// réels que le rejeu n'a pas pu faire (retrait d'un titre déjà chanté dans le
// rejeu, demande refusée). Les gestes non rejoués de NOT_IN_JOURNAL n'y sont
// pas non plus. `added` : gestes que le rejeu a faits en plus, juste après
// celui qui les a causés ; `aliases` : geste → { from, to } : après lui, les
// gestes réels sur le titre `from` visent le titre `to` (même chanson
// redemandée par « remplacer » : le rejeu chante l'ancien titre).
function replayJournal(ev, passages, skip = new Set(), aliases = new Map(), added = new Map()) {
  const target = new Map();
  const merged = [];
  for (const e of ev.events) {
    if (STAGE_EVENTS.has(e.ev) || NOT_IN_JOURNAL.has(e.ev) || skip.has(e)) continue;
    let x = target.has(e.entryId) ? { ...e, entryId: target.get(e.entryId) } : e;
    if (Array.isArray(x.replacedEntryIds) && x.replacedEntryIds.some(id => target.has(id))) {
      x = { ...x, replacedEntryIds: x.replacedEntryIds.map(id => target.get(id) ?? id) };
    }
    merged.push({ e: x, order: merged.length });
    for (const a of added.get(e) || []) merged.push({ e: a, order: merged.length });
    if (aliases.has(e)) target.set(aliases.get(e).from, aliases.get(e).to);
  }
  passages.forEach((st, k) => {
    const queueId = `rejeu-${k}`;
    if (st.sentAt != null && st.source === 'queue') {
      merged.push({ order: 1e9 - 1, e: { v: 1, t: st.sentAt, ev: 'turn.sent', queueId, entryId: st.entryId,
        ids: st.ids, ownerId: st.ids[0] || null } });
    }
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
  const waits = new Map(stats.timeline.stages.filter(st => st.entryId && st.waitSec != null).map(st => [st.entryId, st]));
  return passages.filter(st => st.source === 'queue' && st.ids.length && waits.has(st.entryId)).map(st => {
    const { waitSec, readySince } = waits.get(st.entryId);
    // Début de l'attente : celui de evening-stats.js (le temps sans titre
    // n'est pas dans waitSec).
    return { ...st, owner: st.ids[0], readyAt: readySince ?? st.start - waitSec * 1000, waitSec };
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

// ------------------------------------------------------------------ version de l'ordonnanceur
// Version de travail : ce dépôt. Une autre version (bilan avant/après) : un
// dossier de sources, ou une révision git extraite une fois par commit dans
// le dossier git du dépôt (`.git/karafun-rejeu/<sha>`, propre à l'utilisateur
// et jamais suivi ; KARAFUN_REJEU_CACHE pour un autre dossier), les 5 plus
// récentes gardées. Seuls scheduler.js et ce qu'il charge (lib/scheduler,
// solver/bridge.js, song-repeats.js) viennent de l'autre version ; le rejeu
// et la mesure (evening-stats.js) restent ceux d'aujourd'hui.
const CURRENT = { label: 'version de travail', dir: ROOT, Scheduler, extracted: false };
const codeCache = new Map();
function git(args) {
  try { return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return null; }
}
function cacheRoot() {
  let root = process.env.KARAFUN_REJEU_CACHE ? path.resolve(process.env.KARAFUN_REJEU_CACHE) : null;
  if (!root) {
    const common = git(['rev-parse', '--git-common-dir']);
    if (!common) throw new UsageError('--avant <révision> : dépôt git introuvable ; donner plutôt un dossier de sources.');
    root = path.join(path.resolve(ROOT, common), 'karafun-rejeu');
  }
  const unsafe = message => new UsageError(`Cache des versions extraites non sûr (${root}) : ${message} ; ` +
    'donner un dossier à soi avec KARAFUN_REJEU_CACHE.');
  // Parents : un dossier modifiable par d'autres sans sticky bit laisserait
  // remplacer le cache après ce contrôle (règle de StrictModes d'OpenSSH).
  // Vérifiés avant de créer quoi que ce soit, puis sur le chemin réel.
  const checkParents = from => {
    if (!process.getuid) return;
    for (let dir = from; ; dir = path.dirname(dir)) {
      const p = fs.statSync(dir);
      if ((p.uid !== process.getuid() && p.uid !== 0) || ((p.mode & 0o022) && !(p.mode & 0o1000))) {
        throw unsafe(`le dossier ${dir} peut être modifié par d'autres`);
      }
      if (dir === path.dirname(dir)) break;
    }
  };
  let existing = path.dirname(root);
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  checkParents(fs.realpathSync(existing));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // Le code extrait ici est exécuté : dossier à soi, que nul autre ne peut modifier.
  const st = fs.lstatSync(root);
  if (st.isSymbolicLink() || (process.getuid && (st.uid !== process.getuid() || (st.mode & 0o022)))) {
    throw unsafe('il doit être à l\'utilisateur, sans droit d\'écriture pour les autres');
  }
  const real = fs.realpathSync(root);
  checkParents(path.dirname(real));
  return real;
}
const EXTRACTED_OK = '.rejeu-ok';
const HOUR = 3600_000;
// Extraction terminée par l'outil : marqueur au nom de la révision.
const extracted = (root, name) => {
  try { return fs.readFileSync(path.join(root, name, EXTRACTED_OK), 'utf8') === `${name}\n`; } catch (_) { return false; }
};
const ageMs = file => realNow() - fs.statSync(file).mtimeMs;
// Extraction d'une révision : index temporaire (ni l'index ni la copie de
// travail du dépôt ne bougent), dans un dossier temporaire renommé d'un coup ;
// un autre rejeu qui a fini avant garde la sienne.
function extract(root, sha, label) {
  const dir = path.join(root, sha);
  if (extracted(root, sha)) { fs.utimesSync(dir, new Date(), new Date()); return dir; }
  // Dossier sans marqueur laissé il y a plus d'une heure : abandonné.
  if (fs.existsSync(dir) && ageMs(dir) > HOUR) fs.rmSync(dir, { recursive: true, force: true });
  const tmp = fs.mkdtempSync(path.join(root, `${sha}.tmp-`));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, '.rejeu-index') };
    const run = args => execFileSync('git', ['-C', ROOT, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    run(['read-tree', sha]);
    run(['checkout-index', '-a', '-f', `--prefix=${tmp.split(path.sep).join('/')}/`]);
    fs.rmSync(env.GIT_INDEX_FILE, { force: true });
    fs.writeFileSync(path.join(tmp, EXTRACTED_OK), `${sha}\n`);
    try { fs.renameSync(tmp, dir); } catch (err) {
      if (!extracted(root, sha)) throw err;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new UsageError(`--avant : extraction de ${label} impossible (${String(err.message).split('\n')[0]})`);
  }
  // Ménage : seulement ce que l'outil a extrait. Les 5 révisions les plus
  // récemment utilisées sont gardées ; une copie interrompue (arrêt pendant
  // l'extraction) part au bout d'une heure.
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
  for (const d of entries) {
    if (/^[0-9a-f]{40}([0-9a-f]{24})?\.tmp-/.test(d.name) && ageMs(path.join(root, d.name)) > HOUR) {
      fs.rmSync(path.join(root, d.name), { recursive: true, force: true });
    }
  }
  const kept = entries.filter(d => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(d.name) && extracted(root, d.name))
    .map(d => ({ name: d.name, t: fs.statSync(path.join(root, d.name)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const old of kept.slice(5)) if (old.name !== sha) fs.rmSync(path.join(root, old.name), { recursive: true, force: true });
  return dir;
}
// `where` : révision git ou dossier de sources ; rien : la version de travail.
function loadCode(where) {
  if (where == null) return CURRENT;
  let dir, label, extracted = false;
  if (fs.existsSync(where) && fs.statSync(where).isDirectory()) {
    // Chemin réel : celui que require écrit dans les traces d'appels.
    label = path.resolve(where); dir = fs.realpathSync(where);
  } else {
    const sha = git(['rev-parse', '--verify', '--quiet', `${where}^{commit}`]);
    if (!sha) throw new UsageError(`--avant : « ${where} » n'est ni un dossier ni une révision git de ce dépôt.`);
    // Un sha court donné tel quel n'est pas répété.
    label = sha.startsWith(where) ? sha.slice(0, 7) : `${where} (${sha.slice(0, 7)})`; extracted = true;
    dir = extract(cacheRoot(), sha, label);
  }
  // Version déjà chargée depuis ce dossier (même cache, même révision).
  if (codeCache.has(dir)) return { ...codeCache.get(dir), label };
  const file = path.join(dir, 'scheduler.js');
  if (!fs.existsSync(file)) throw new UsageError(`--avant : pas de scheduler.js dans ${dir}`);
  let loaded;
  try { loaded = require(file); } catch (err) {
    throw new UsageError(`--avant : chargement de ${file} impossible (${String(err.message).split('\n')[0]})`);
  }
  const code = { label, dir, Scheduler: loaded.Scheduler, extracted };
  if (typeof code.Scheduler !== 'function') throw new UsageError(`--avant : ${file} n'exporte pas Scheduler`);
  codeCache.set(dir, code);
  return code;
}

// Jar plus ancien que les sources Java de sa version : les règles de Timefold
// ne seraient pas celles du code mesuré.
function staleJar(jar, dir) {
  const src = path.join(dir, 'solver', 'src');
  if (!fs.existsSync(src)) return false;
  const built = fs.statSync(jar).mtimeMs;
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).some(f =>
    f.isDirectory() ? walk(path.join(d, f.name)) : fs.statSync(path.join(d, f.name)).mtimeMs > built);
  const pom = path.join(dir, 'solver', 'pom.xml');
  return walk(src) || (fs.existsSync(pom) && fs.statSync(pom).mtimeMs > built);
}

// Construction du jar d'une autre version : au plus MVN_TIMEOUT_MS (premier
// téléchargement des dépendances compris) ; un verrou plus vieux que
// LOCK_STALE_MS (toujours plus long) a été laissé par une construction
// interrompue.
const MVN_TIMEOUT_MS = 20 * 60_000;
const LOCK_STALE_MS = 25 * 60_000;
// Reprise d'un verrou abandonné : un seul rejeu à la fois (fichier de reprise
// créé d'un coup), qui revérifie l'âge du verrou avant de le prendre. Une
// reprise interrompue (plus d'une minute) est effacée : relancer.
function takeOverLock(lock) {
  const claim = `${lock}.reprise`;
  try { fs.closeSync(fs.openSync(claim, 'wx')); } catch (err) {
    try { if (err.code === 'EEXIST' && ageMs(claim) > 60_000) fs.rmSync(claim, { force: true }); } catch (_) { /* rendue entre-temps */ }
    return false;
  }
  try {
    let age;
    try { age = ageMs(lock); } catch (_) { return false; } // rendu entre-temps : relancer
    if (age < LOCK_STALE_MS) return false;
    fs.writeFileSync(lock, '');
    return true;
  } finally { fs.rmSync(claim, { force: true }); }
}

function resolveJar(solver, code = CURRENT) {
  if (!solver) return null;
  if (typeof solver === 'string') {
    if (!fs.existsSync(solver)) throw new UsageError(`Jar Timefold introuvable : ${solver}`);
    return solver;
  }
  // Révision extraite : son solveur est construit une fois, gardé avec elle ;
  // seul un jar dont la construction a abouti (marqueur) sert.
  const built = path.join(code.dir, 'solver', '.rejeu-jar-ok');
  let jar = code.extracted && !fs.existsSync(built) ? null : jarsIn(code.dir).find(fs.existsSync);
  if (!jar && code.extracted) {
    const lock = path.join(code.dir, 'solver', '.rejeu-mvn.lock');
    const busy = () => new UsageError(`Jar Timefold de ${code.label} : construction déjà en cours (${lock}) ; relancer ensuite.`);
    try {
      try { fs.closeSync(fs.openSync(lock, 'wx')); } catch (err) {
        if (err.code !== 'EEXIST' || !takeOverLock(lock)) throw busy();
      }
      // Windows : mvn.cmd passe par le shell, chemin entre guillemets (espaces).
      const pom = path.join(code.dir, 'solver', 'pom.xml');
      const win = process.platform === 'win32';
      execFileSync('mvn', ['-q', '-B', '-DskipTests', 'package', '-f', win ? `"${pom}"` : pom],
        { stdio: ['ignore', 'ignore', 'pipe'], shell: win, timeout: MVN_TIMEOUT_MS });
      fs.writeFileSync(built, '');
    } catch (err) {
      if (err instanceof UsageError) throw err;
      fs.rmSync(lock, { force: true });
      throw new UsageError(`Jar Timefold de ${code.label} : construction par Maven impossible (${String(err.stderr || err.message).split('\n')[0]}) ; ` +
        'donner --solveur-avant <jar> ou retirer --solveur.');
    }
    fs.rmSync(lock, { force: true });
    jar = jarsIn(code.dir).find(fs.existsSync);
  }
  if (!jar) {
    throw new UsageError(code === CURRENT ?
      'Jar Timefold absent (solver/target/karafun-solver.jar) : construire le solveur ou retirer --solveur.' :
      `Jar Timefold absent pour ${code.label} : le construire dans ${path.join(code.dir, 'solver')}, ou donner --solveur-avant <jar>.`);
  }
  return jar;
}

// ------------------------------------------------------------------ contexte de rejeu
function makeContext(ev, opts) {
  const code = loadCode(opts.code);
  const overrides = { ...(opts.options || {}) };
  const rules = { ...ev.rules, ...overrides };
  const schedOpts = {};
  for (const k of SCHED_RULES) if (rules[k] !== undefined) schedOpts[k] = rules[k];
  // « Je suis là » obligatoire : ni les confirmations ni les passages laissés
  // faute de réponse ne sont rejoués ; sans cela le rejeu ne chanterait rien.
  const warnings = [];
  if (schedOpts.requirePresence) {
    schedOpts.requirePresence = false;
    warnings.push('« Je suis là » obligatoire non rejoué (confirmations, passages laissés faute de réponse) : rejeu fait sans');
  }
  const s = new code.Scheduler(schedOpts);
  for (const m of ['_maybeRequestSolver', '_scheduleRefine', '_requestSolver', 'solverContextFingerprint', 'select', 'reserveNext', 'commit']) {
    if (typeof s[m] !== 'function') throw new UsageError(`${code.label} : pas de méthode ${m}, version trop éloignée de l'outil de rejeu.`);
  }
  // Le rejeu demande lui-même le plan à chaque décision (ensurePlan) : pas de
  // calcul lancé en tâche de fond ni d'optimisation continue.
  s._maybeRequestSolver = () => false;
  s._scheduleRefine = () => {};
  s.solverBridge = null;
  const ctx = { ev, s, rules, overrides, key2pid: new Map(), pid2key: new Map(), real2rep: new Map(), rep2real: new Map(),
    notes: [], ignored: {}, notReplayed: {}, decisions: [], budget: opts.budget || 3000, solver: null, jar: null,
    code, warnings, plans: { asked: 0, ok: 0, failed: 0, lastError: null }, unapplied: new Set(), aliases: new Map(), added: new Map(),
    requestedAt: new Map(ev.events.filter(e => e.ev === 'song.requested').map(e => [e.entryId, e.t])) };
  const jar = resolveJar(opts.solver, code);
  if (jar) {
    const { TimefoldBridge } = require(path.join(code.dir, 'solver', 'bridge'));
    // Java de la version de travail (runtime du kit s'il est là) des deux côtés.
    s.solverBridge = new TimefoldBridge({ jar, settleMs: 0, ...(fs.existsSync(BUNDLED_JAVA) ? { java: BUNDLED_JAVA } : {}) });
    ctx.solver = s.solverBridge; ctx.jar = jar;
    if (!(code.extracted && typeof opts.solver === 'string') && staleJar(jar, code.dir)) {
      ctx.warnings.push(`jar Timefold plus ancien que ${path.join(code.dir, 'solver', 'src')} : reconstruire (mvn -q -DskipTests package -f ${path.join(code.dir, 'solver', 'pom.xml')})`);
    }
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
  // Moins de deux titres : rien à ordonner, ce n'est pas une demande à Timefold.
  if (!started && !s.solverLastError) return;
  ctx.plans.asked++;
  // Échec ou solveur indisponible : ordre local, compté et signalé au rapport.
  const ok = started && s.solverPromise ? await s.solverPromise.catch(() => false) : false;
  if (ok) ctx.plans.ok++;
  else {
    ctx.plans.failed++;
    ctx.plans.lastError = s.solverLastError || ctx.solver.lastError ||
      (ctx.solver.available ? null : 'solveur indisponible') || ctx.plans.lastError;
  }
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
    // roundMember : compté dans le tour (passage ou dette) ; la rotation ne
    // compte une invitée en dette dans le duo d'un auteur neuf qu'une fois
    // montée sur scène dans ce tour (roundApps).
    return { key: keyOf(ctx, pid), roundMember: s.roundPeople.has(pid), roundApps: apps, roundUse: +use.toFixed(3),
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
// Note d'un geste non rejoué : la raison, la personne qui l'a fait ou qu'il
// vise (invitée d'un duo, demande pour rejoindre…) et le titre.
const notReplayedNote = (e, why) => `${e.ev} non rejoué : ` +
  [why, e.personId || e.guestId || e.requesterId || e.ownerId || e.partnerId, e.entryId].filter(Boolean).join(' ');

// Titre envoyé dans le rejeu, pas encore lancé (`sel`), et gestes réels qui
// le touchent, comme server.js. Départ noté par le bar (une personne, ou toute
// une table) : l'invitée d'un duo envoyé le laisse en solo
// (keepSentDuosOfLeavers) ; le titre d'un auteur parti est retiré de KaraFun
// et son passage rendu (removeLeaversTracks, puis rollbackUnplayed). Invitée
// qui quitte le duo, ou auteur qui le chante seul : en solo (leaveSentDuo).
// En réel, avant l'envoi, ce dernier geste est un duo.cancelled de l'auteur
// (« Chanter seul » ou « Annuler duo ») : sur un duo envoyé, le serveur n'a
// que « Chanter seul ». « Je pars » tapé par la personne ne touche pas aux
// titres envoyés.
// Rend { handled } (geste fait ici) et { cancel } (titre retiré).
function sentGesture(ctx, e, sel) {
  const none = { handled: false, cancel: false };
  if (!sel) return none;
  const s = ctx.s;
  const pid = k => ctx.key2pid.get(k);
  const byOwner = e.ev === 'duo.cancelled' && e.personId && e.personId === e.ownerId;
  if (e.ev === 'duo.left' || byOwner) {
    const gid = pid(byOwner ? e.partnerId : e.guestId || e.personId);
    if (!gid || sel.song?.entryId !== ctx.real2rep.get(e.entryId) || sel.ids.indexOf(gid) < 1) return none;
    s.leaveSentDuet(sel, gid, { by: byOwner ? 'owner' : ['owner', 'staff'].includes(e.by) ? e.by : 'guest' });
    return { handled: true, cancel: false };
  }
  const ids = e.ev === 'table.left' ? s.tableSingers(e.tableId).map(p => p.id) :
    e.ev === 'person.left' && e.by === 'staff' && pid(e.personId) ? [pid(e.personId)] : [];
  if (!sel.ids.some(id => ids.includes(id))) return none;
  if (ids.includes(sel.ids[0])) return { handled: false, cancel: true };
  for (const gid of sel.ids.slice(1).filter(id => ids.includes(id))) s.leaveSentDuet(sel, gid, { by: 'staff' });
  return none;
}

function applyExternal(ctx, e, upcoming) {
  const s = ctx.s;
  const pid = k => ctx.key2pid.get(k);
  const P = k => s.people.get(pid(k));
  const entry = id => ctx.real2rep.get(id);
  // Geste que le rejeu ne peut pas faire : noté, et hors du journal rejoué.
  const skip = why => {
    ctx.unapplied.add(e);
    note(ctx, notReplayedNote(e, why));
    return false;
  };
  if (NOT_REPLAYED.has(e.ev)) {
    ctx.notReplayed[e.ev] = (ctx.notReplayed[e.ev] || 0) + 1;
    const cleared = '« Vider toutes les chansons » du bar non rejoué : les titres vidés restent à chanter dans le rejeu';
    if (e.ev === 'staff.queueCleared' && !ctx.warnings.includes(cleared)) ctx.warnings.push(cleared);
    return false;
  }
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
        if (!p) return skip('personne inconnue');
        const song = { songId: e.songId, title: e.title || `Titre ${e.songId}`, artist: e.artist || '', duration: e.durationSec };
        const before = new Set(s.songsOf(p).map(x => x.entryId));
        // Un duo est demandé puis aussitôt noté (inviteDuet) : même table, accepté d'office.
        const duo = upcoming.find(x => x.ev === 'duo.invited' && x.entryId === e.entryId);
        const partner = duo && P(duo.partnerId);
        // « Remplacer » : la soirée n'a retiré que e.replacedEntryIds. Les titres
        // de la liste rejouée hors de ceux-là (déjà chantés dans la soirée, pas
        // encore dans le rejeu) restent en place, avant le nouveau titre, avec
        // leur duo et leurs réglages : le nouveau titre est ajouté, puis seuls
        // les titres remplacés sont retirés (une chanson invalide ne retire
        // rien). Un « remplacer » réel ne crée jamais de duo (inviteDuet ajoute
        // toujours) : seul le duo d'un titre gardé de même chanson est repris.
        const replaced = new Set((e.replacedEntryIds || []).map(id => ctx.real2rep.get(id)).filter(Boolean));
        const kept = e.mode === 'replace' ? s.songsOf(p).filter(x => !replaced.has(x.entryId)) : [];
        // Même chanson redemandée et encore à chanter dans le rejeu : le nouveau
        // titre la remplace aussi, dans le rejeu et dans son journal.
        const same = kept.find(x => x.songId === Number(song.songId));
        const keptCount = kept.length - (same ? 1 : 0);
        // Duo de cette même chanson : le nouveau titre le reprend avec son
        // invitée (qui l'a chanté en réel), accepté comme avant.
        const sameGuest = same?.duet?.state === 'accepted' && s.people.get(same.duet.partnerId);
        const carry = sameGuest && !sameGuest.withdrawnAt ? sameGuest : null;
        const dropReplaced = () => { for (const x of s.songsOf(p).filter(x => replaced.has(x.entryId))) s.removeSong(p, x.entryId); };
        if (keptCount) {
          if (same) s.removeSong(p, same.entryId);
          try { s.chooseSong(p, song, 'append'); } catch (err) {
            // Refus que le « remplacer » du bar n'a pas (même chanson qu'un titre
            // remplacé, liste pleine avec eux) : les retirer d'abord, puis ajouter.
            if (!['ALREADY_LISTED', 'LIST_FULL'].includes(err.code)) throw err;
            dropReplaced();
            s.chooseSong(p, song, 'append');
          }
          dropReplaced();
        } else if (duo && partner && !partner.withdrawnAt) s.inviteDuet(p, partner.id, song);
        else s.chooseSong(p, song, e.mode === 'replace' ? 'replace' : 'append');
        const fresh = s.songsOf(p).find(x => !before.has(x.entryId));
        if (fresh) { ctx.real2rep.set(e.entryId, fresh.entryId); ctx.rep2real.set(fresh.entryId, e.entryId); }
        // Même chanson encore à chanter dans le rejeu : le nouveau titre en est
        // la suite. Le journal rejoué garde l'ancien titre en liste (son duo,
        // l'attente de son invitée depuis l'acceptation) et lui donne le
        // passage ; la demande réelle y est retirée aussitôt, et les gestes
        // réels qui suivent sur le nouveau titre visent l'ancien.
        const sameReal = same && ctx.rep2real.get(same.entryId);
        if (sameReal && fresh) {
          ctx.rep2real.set(fresh.entryId, sameReal);
          ctx.real2rep.set(sameReal, fresh.entryId);
          ctx.aliases.set(e, { from: e.entryId, to: sameReal });
          ctx.added.set(e, [{ v: 1, t: e.t, ev: 'song.removed', personId: e.personId, entryId: e.entryId, by: 'self' }]);
        }
        // Duo accepté de cette même chanson : son invitée (qui l'a chanté en
        // réel) rejoint le nouveau titre (titre déjà enregistré : un refus ici
        // ne retire pas la demande du journal).
        if (carry && fresh) {
          const { direct } = s.requestDuetJoin(carry, p.id, fresh.entryId);
          if (!direct) s.answerDuetJoin(p, fresh.entryId, carry.id, true);
        }
        if (keptCount) note(ctx, `remplacement de ${e.personId} : ${keptCount} titre(s) pas encore chanté(s) dans le rejeu gardé(s)`);
        if (same) note(ctx, `remplacement de ${e.personId} : « ${same.title} » redemandé avant d'être chanté dans le rejeu, chanté une fois`);
        return true;
      }
      case 'duo.invited': return false; // traité avec song.requested
      case 'duo.answered': {
        const guest = P(e.partnerId || e.personId);
        if (!guest || !entry(e.entryId)) return skip('duo inconnu');
        s.answerDuet(guest, !!e.accepted, entry(e.entryId));
        return true;
      }
      case 'duo.cancelled': {
        const actor = P(e.personId) || P(e.ownerId);
        if (!actor || !entry(e.entryId)) return skip('duo inconnu');
        s.cancelDuet(actor, entry(e.entryId));
        return true;
      }
      case 'duo.left': {
        const guest = P(e.guestId || e.personId);
        if (!guest || !entry(e.entryId)) return skip('duo inconnu');
        s.leaveDuet(guest, pid(e.ownerId), entry(e.entryId));
        return true;
      }
      case 'song.removed': {
        const p = P(e.personId);
        const id = entry(e.entryId);
        // Titre déjà chanté dans le rejeu : ce retrait sort aussi du journal rejoué.
        if (!p || !s.songsOf(p).some(x => x.entryId === id)) return skip('titre déjà passé ou inconnu,');
        s.removeSong(p, id, e.by || 'self');
        return true;
      }
      case 'song.reordered': {
        const p = P(e.personId);
        const id = entry(e.entryId);
        const list = p ? s.songsOf(p) : [];
        const from = list.findIndex(x => x.entryId === id);
        if (from < 0) return skip('titre absent,');
        const to = Math.max(0, Math.min(Number(e.toIndex) || 0, list.length - 1));
        if (from !== to) s.reorderSongs(p, id, to);
        return true;
      }
      case 'table.left': s.tableLeft(e.tableId); return true;
      case 'person.left': { const p = P(e.personId); if (!p) return false; s.leave(p, e.by || 'self'); return true; }
      case 'person.reactivated': { const p = P(e.personId); if (!p) return false; p.withdrawnAt = null; return true; }
      case 'person.bonus': if (!pid(e.personId)) return false; s.setPersonBonus(pid(e.personId), e.level); return true;
      case 'table.bonus': s.setTableBonus(e.tableId, e.level); return true;
      case 'duo.joinRequested': {
        const requester = P(e.requesterId);
        if (!requester || !entry(e.entryId)) return skip('duo inconnu');
        s.requestDuetJoin(requester, pid(e.ownerId), entry(e.entryId));
        return true;
      }
      case 'duo.joinAnswered': {
        const owner = P(e.ownerId || e.personId);
        if (!owner || !entry(e.entryId)) return skip('duo inconnu');
        s.answerDuetJoin(owner, entry(e.entryId), pid(e.requesterId), !!e.accepted);
        return true;
      }
      case 'duo.joinCancelled': {
        const requester = P(e.requesterId || e.personId);
        if (!requester || !entry(e.entryId)) return skip('duo inconnu');
        s.cancelDuetJoin(requester, pid(e.ownerId), entry(e.entryId));
        return true;
      }
      case 'person.gaveSpot': { const p = P(e.personId); if (!p) return skip('personne inconnue'); s.giveSpot(p, pid(e.toId)); return true; }
      case 'settings.changed': {
        // Une règle remplacée par --option garde la valeur demandée.
        if (!SCHED_RULES.includes(e.setting) || e.setting in ctx.overrides) return false;
        if (e.setting === 'requirePresence') {
          const warning = '« Je suis là » obligatoire non rejoué (confirmations, passages laissés faute de réponse) : rejeu fait sans';
          if (e.to && !ctx.warnings.includes(warning)) ctx.warnings.push(warning);
          return false;
        }
        s.opts[e.setting] = e.to;
        return true;
      }
      case 'person.transferred': return false; // autre téléphone : rien ne change pour la file
      default: return false;
    }
  } catch (err) {
    // Chanson redemandée en « ajouter » (chantée au bar, encore à chanter dans
    // le rejeu) : la demande attend qu'elle quitte la liste (rejeu libre).
    if (e.ev === 'song.requested' && err.code === 'ALREADY_LISTED' && ctx.deferred && !ctx.real2rep.has(e.entryId)) {
      ctx.deferred.push({ e, upcoming, follow: [] });
      note(ctx, `demande de ${e.personId} « ${e.title || e.songId} » différée : la même chanson reste à chanter dans le rejeu`);
      return false;
    }
    // Geste refusé par l'ordonnanceur rejoué (titre déjà chanté, duo parti…) :
    // hors du journal, sauf une demande déjà faite avant l'erreur.
    if (MUST_MATCH.has(e.ev) && !(e.ev === 'song.requested' && ctx.real2rep.has(e.entryId))) ctx.unapplied.add(e);
    note(ctx, notReplayedNote(e, err.message));
    return false;
  }
}

function countIgnored(ctx, e) {
  if (!REPLAYED.has(e.ev) && !NOT_REPLAYED.has(e.ev)) ctx.ignored[e.ev] = (ctx.ignored[e.ev] || 0) + 1;
}

// ------------------------------------------------------------------ rejeu FORCÉ
async function runForced(evening, opts = {}) {
  const ev = asEvening(evening);
  return withClock(async () => {
    clock.now = ev.events[0]?.t || 0;
    const ctx = makeContext(ev, opts);
    const { s } = ctx;
    const sels = new Map(); // entryId réel → passage engagé
    const started = new Set(); // passages engagés déjà lancés
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
        // Passage engagé, pas encore lancé, que le geste touche (comme le serveur).
        const target = e.ev === 'duo.left' || e.ev === 'duo.cancelled' ? sels.get(e.entryId) : upcoming;
        let sent = { handled: false, cancel: false };
        if (target && !started.has(target)) {
          try { sent = sentGesture(ctx, e, target); } catch (err) { note(ctx, `${e.ev} sur le titre envoyé : ${err.message}`); }
        }
        if (sent.handled) { await reserveIfDue(e.ev); continue; }
        const applied = applyExternal(ctx, e, soon);
        if (sent.cancel) {
          if (target.turnCredit) s.rollbackUnplayed(target);
          note(ctx, `titre envoyé retiré au départ de ${keyOf(ctx, target.ids[0])} : « ${target.song?.title || ''} »`);
          if (upcoming === target) upcoming = null;
        }
        if (applied) { await reserveIfDue(e.ev); continue; }
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
              started.add(sel);
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
// Garde-fou : nombre d'étapes d'horloge du rejeu libre (une soirée en fait
// quelques milliers).
const MAX_STEPS = 200000;
async function runFree(evening, opts = {}) {
  const ev = asEvening(evening);
  return withClock(async () => {
    clock.now = ev.events[0]?.t || 0;
    const ctx = makeContext(ev, opts);
    const { s } = ctx;
    const pushMs = 1000 * Number(ctx.rules.pushDelaySec ?? 45);
    const ext = ev.events.filter(e => REPLAYED.has(e.ev) || NOT_REPLAYED.has(e.ev) ||
      ['battle.decided', 'closing.set', 'closing.cleared'].includes(e.ev));
    for (const e of ev.events) countIgnored(ctx, e);
    // Battles approuvées en réel : chacune, à son tour, part dans KaraFun à
    // la première case libre, puis démarre avec le délai et dure le temps de
    // la Battle réelle de même rang.
    const auto = ev.events.filter(e => e.ev === 'battle.automation');
    const sendings = auto.filter(e => e.status === 'sending');
    const preGaps = sendings.map((sending, k) => {
      const playing = auto.find(e => e.status === 'playing' && e.t > sending.t && !(e.t > sendings[k + 1]?.t));
      if (!playing) return null;
      const freed = ev.events.find(e => e.ev === 'stage.ended' && e.t > sending.t)?.t || sending.t;
      return Math.max(0, playing.t - Math.max(sending.t, freed));
    });
    const preGapOf = k => preGaps[k] ?? preGaps.find(x => x != null) ?? 132000;
    const battleMsOf = k => 1000 * (ev.battles[k] ?? ev.battles.at(-1) ?? 260);
    const offlineAt = t => ev.offline.some(([a, b]) => t >= a && t < b);
    let closingAt = Infinity;
    const stages = [];
    let current = null, upcoming = null, lastEnd = 0;
    let battle = 'none', battlesDue = 0, battlesPlayed = 0;
    const durOf = sel => 1000 * (ev.played.get(ctx.rep2real.get(sel.song.entryId)) ?? (Number(sel.song.duration) || 200));
    // Début du prochain titre : délais réels du titre de même rang.
    const startAt = () => {
      const g = ev.startGaps[stages.filter(x => x.kind === 'song').length];
      if (!g) return Math.max(lastEnd, upcoming.sentAt) + GAP_MS;
      return Math.max(lastEnd + g.endGap, upcoming.sentAt + Math.min(g.sendGap, g.endGap > 60000 ? g.sendGap : 15000));
    };
    // Fermeture du bar (server.js, closingBlocksStart) : un titre ne part ni
    // ne démarre que si au moins sa moitié (créneau moyen) passe avant l'heure,
    // la scène se libérant à la fin du titre en cours plus SONG_GAP_MS.
    const closingBlocks = () => Number.isFinite(closingAt) &&
      (current ? Math.max(current.end + SONG_GAP_MS, clock.now) : clock.now) + s.avgSlotSec() * 500 > closingAt;
    // Fin du karaoké de la soirée réelle (evening-stats.js : fermeture du bar,
    // KaraFun ou l'application arrêtés après le dernier titre) : plus rien ne
    // part ni ne démarre ensuite, dans les deux versions du bilan (titres vidés
    // par le bar ou heure retirée par « Options par défaut » à la fin).
    const karaokeEnd = statsOf(ev.events).evening.closedAt ?? Infinity;
    const over = () => clock.now >= karaokeEnd;
    const stepServer = async () => {
      if (current && clock.now >= current.end) {
        if (current.kind === 'song') { s.recordSlot((current.end - current.start) / 1000); s.songEnded(current.sel.ids); s.endStage(current.sel); }
        if (current.kind === 'battle') {
          battlesPlayed++;
          if (battlesDue) { battlesDue--; battle = 'waiting'; } else battle = 'none';
        }
        lastEnd = current.end; current = null;
      }
      // Titre envoyé qui ne tiendrait plus avant l'heure : retiré de KaraFun,
      // il revient dans la liste de son auteur (pullFromKaraFun, restorePulled).
      if (upcoming && (closingBlocks() || over())) {
        s.requeueUnplayed(upcoming.sel);
        note(ctx, `titre envoyé retiré à la ${over() ? 'fin du karaoké' : 'fermeture'}, rendu à ${keyOf(ctx, upcoming.sel.ids[0])} : ` +
          `« ${upcoming.sel.song?.title || ''} »`);
        upcoming = null;
      }
      if (!current && upcoming && clock.now >= startAt()) {
        current = { kind: 'song', sel: upcoming.sel, start: clock.now, end: clock.now + durOf(upcoming.sel), sentAt: upcoming.sentAt,
          decision: upcoming.decision };
        s.recordStage(upcoming.sel, clock.now);
        stages.push(current); upcoming = null;
      }
      // Envoi de la Battle (server.js) : pas après l'heure de fermeture ; une
      // Battle envoyée n'est jamais retirée.
      if (battle === 'waiting' && !upcoming && !(s.reservedNext && current) && !closingBlocks() && !over()) battle = 'queued';
      if (!current && !upcoming && battle === 'queued' && clock.now >= lastEnd + preGapOf(battlesPlayed) && !over()) {
        current = { kind: 'battle', start: clock.now, end: clock.now + battleMsOf(battlesPlayed) };
        stages.push(current); battle = 'playing';
      }
      const hold = ['queued', 'playing'].includes(battle) || offlineAt(clock.now);
      if (!upcoming && !hold && current?.kind === 'song' && !s.reservedNext) {
        await ensurePlan(ctx);
        const state = explain(ctx);
        const sel = s.reserveNext();
        if (sel) ctx.decisions.push({ kind: 'reserve', at: clock.now, time: timeOf(clock.now, ev.timezone), pick: pickOf(ctx, sel), state });
      }
      const canPush = !current || clock.now - current.start >= pushMs;
      if (!upcoming && !hold && canPush && !closingBlocks() && !over()) {
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
    // Demandes différées (même chanson encore dans la liste) : faites dès
    // qu'elle en est sortie (envoyée, retirée), suivies des gestes réels sur
    // ce titre arrivés entre-temps. Personne partie avant, titre retiré ou
    // remplacé avant, ou chanson restée jusqu'à la fin : la demande et ces
    // gestes sortent du journal rejoué.
    ctx.deferred = [];
    const dropDeferred = (d, why) => {
      ctx.deferred.splice(ctx.deferred.indexOf(d), 1);
      for (const x of [d.e, ...d.follow.map(f => f.e)]) ctx.unapplied.add(x);
      note(ctx, notReplayedNote(d.e, why));
    };
    const retryDeferred = () => {
      for (const d of [...ctx.deferred]) {
        const pid = ctx.key2pid.get(d.e.personId);
        const p = s.people.get(pid);
        // Partie, ou sa table fermée (personne retirée de l'ordonnanceur).
        if (pid && (!p || p.withdrawnAt)) { dropDeferred(d, 'personne partie avant que la même chanson quitte sa liste'); continue; }
        if (p && s.songsOf(p).some(x => x.songId === Number(d.e.songId))) continue;
        ctx.deferred.splice(ctx.deferred.indexOf(d), 1);
        if (applyExternal(ctx, d.e, d.upcoming)) {
          // À sa place réelle : devant les titres demandés après elle.
          const id = ctx.real2rep.get(d.e.entryId);
          const list = s.songsOf(p);
          const from = list.findIndex(x => x.entryId === id);
          const to = list.findIndex(x => (ctx.requestedAt.get(ctx.rep2real.get(x.entryId)) ?? -Infinity) > d.e.t);
          if (from >= 0 && to >= 0 && to < from) s.reorderSongs(p, id, to);
        }
        for (const f of d.follow) applyExternal(ctx, f.e, f.soon);
      }
    };
    let i = 0;
    clock.now = ext[0]?.t || 0;
    let steps = 0;
    const maxSteps = opts.maxSteps || MAX_STEPS;
    try {
      for (; steps < maxSteps; steps++) {
        while (i < ext.length && ext[i].t <= clock.now) {
          const e = ext[i++];
          if (e.ev === 'battle.decided') {
            if (e.outcome === 'approved') { if (battle === 'none') battle = 'waiting'; else battlesDue++; }
            continue;
          }
          if (e.ev === 'closing.set') { closingAt = Number.isFinite(e.closingAt) ? e.closingAt : Infinity; continue; }
          if (e.ev === 'closing.cleared') { closingAt = Infinity; continue; }
          const soon = ext.slice(i, i + 5).filter(x => x.t - e.t < 1000);
          if (e.ev === 'song.requested' && e.mode === 'replace') {
            for (const d of ctx.deferred.filter(x => (e.replacedEntryIds || []).includes(x.e.entryId))) {
              dropDeferred(d, 'titre remplacé avant que la même chanson quitte la liste');
            }
          }
          // Gestes rejoués sur le titre d'une demande différée : ils l'attendent.
          const held = e.entryId && REPLAYED.has(e.ev) && e.ev !== 'song.requested' && ctx.deferred.find(d => d.e.entryId === e.entryId);
          if (held) {
            held.follow.push({ e, soon });
            if (e.ev === 'song.removed') dropDeferred(held, 'titre retiré avant que la même chanson quitte la liste');
            continue;
          }
          let sent = { handled: false, cancel: false };
          try { sent = sentGesture(ctx, e, upcoming?.sel); } catch (err) { note(ctx, `${e.ev} sur le titre envoyé : ${err.message}`); }
          if (!sent.handled) applyExternal(ctx, e, soon);
          if (sent.cancel) {
            if (upcoming.sel.turnCredit) s.rollbackUnplayed(upcoming.sel);
            note(ctx, `titre envoyé retiré au départ de ${keyOf(ctx, upcoming.sel.ids[0])} : « ${upcoming.sel.song?.title || ''} »`);
            upcoming = null;
          }
        }
        retryDeferred();
        // Plusieurs passages du serveur au même instant (fin → début → envoi).
        for (let k = 0; k < 4; k++) await stepServer();
        retryDeferred();
        const next = [];
        if (i < ext.length) next.push(ext[i].t);
        if (current) next.push(current.end, current.start + pushMs);
        if (!current && upcoming) next.push(startAt());
        if (!current && !upcoming && battle === 'queued') next.push(lastEnd + preGapOf(battlesPlayed));
        for (const [, b] of ev.offline) if (Number.isFinite(b)) next.push(b);
        const future = next.filter(t => t > clock.now);
        if (!future.length) break;
        clock.now = Math.min(...future);
      }
    } finally {
      if (ctx.solver) ctx.solver.close();
    }
    for (const d of [...ctx.deferred]) dropDeferred(d, 'même chanson restée à chanter jusqu\'à la fin');
    if (steps >= maxSteps) ctx.warnings.push(`rejeu arrêté à ${timeOf(clock.now, ev.timezone)} après ${maxSteps} étapes : la fin de la soirée manque`);
    const replayPassages = stages.map(st => st.kind === 'song' ? {
      entryId: ctx.rep2real.get(st.sel.song.entryId) || st.sel.song.entryId, ids: st.sel.ids.map(pid => keyOf(ctx, pid)),
      start: st.start, end: st.end, sentAt: st.sentAt, source: 'queue', title: st.sel.song.title,
      newRound: !!st.decision?.pick.newRound, borrowedIds: st.decision?.pick.borrowedIds || [] } :
      { entryId: null, ids: [], start: st.start, end: st.end, source: st.kind, title: st.kind });
    const journal = replayJournal(ev, replayPassages, ctx.unapplied, ctx.aliases, ctx.added);
    const passages = computeWaits(replayPassages, ev, journal).map(w => ({ ...w, borrowedIds: w.borrowedIds || [] }));
    return finish(ctx, 'libre', passages, compareOrders(ev, passages), journal);
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
// `groupOf` : groupe de rotation d'une personne (sa table ; chaque personne
// « En solo » est un groupe à elle).
function analyse(passages, groupOf = () => null) {
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
  // Reprises de table : deux passages de la file de suite pour le même groupe
  // (ce que Timefold cherche d'abord à éviter).
  let tableRepeats = 0;
  passages.forEach((p, k) => { if (k && groupOf(p.owner) != null && groupOf(p.owner) === groupOf(passages[k - 1].owner)) tableRepeats++; });
  return { rounds: rounds.map(r => ({ index: r.index, start: r.start, end: r.end, passages: r.passages.length,
    minutes: r.end != null ? Math.round((r.end - r.start) / 6000) / 10 : null })),
  longestRoundMin: longestRoundMs == null ? null : Math.round(longestRoundMs / 6000) / 10,
  longWaits, doubles, skipped, debts, tableRepeats };
}

// Équilibre des passages, mesuré par evening-stats.js (page des statistiques) :
// indice de Jain sur les passages par heure de présence, part de chacun
// (passages obtenus / passages attendus au même rythme pour tous, bonus compris).
function balanceOf(stats) {
  const f = stats.fairness;
  const people = {};
  for (const x of stats.singers) {
    if (!x.askedInKaraoke && !x.appearances) continue;
    people[x.id] = { turns: x.turns, guestTurns: x.guestTurns, appearances: x.appearances, presenceSec: x.presenceSec,
      fairRatio: x.fairRatio, waitMaxSec: x.waits.maxSec, waitAvgSec: x.waits.avgSec, stageMaxSec: x.stageWaits.maxSec };
  }
  const ratios = Object.values(people).map(p => p.fairRatio).filter(r => r != null);
  return { songs: stats.global.ours, n: f.n, jain: f.jain, jainAdjusted: f.jainAdjusted, demandJain: f.demandJain,
    rateMin: f.rateMin, rateMax: f.rateMax, neverSang: f.neverSang,
    shareMax: ratios.length ? Math.max(...ratios) : null, shareMin: ratios.length ? Math.min(...ratios) : null,
    stage60: Object.values(people).filter(p => p.stageMaxSec >= 3600).length, people };
}

const groupOf = ev => key => {
  const table = ev.people.get(key)?.table;
  return table == null ? null : ev.tables.get(table)?.individual ? `solo:${key}` : table;
};

function finish(ctx, mode, passages, order, journal = null) {
  const ev = ctx.ev;
  const replayStageWaits = journal ? stageWaitsOf(journal) : null;
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
  // Fiabilité : Timefold qui n'a rien rendu, titres perdus par le rejeu.
  const warnings = [...ctx.warnings];
  const plans = ctx.plans;
  if (ctx.solver && plans.asked && !plans.ok) {
    warnings.push(`Timefold n'a rendu aucun plan sur ${plans.asked} demandes (${plans.lastError || 'sans réponse'}) : rejeu fait avec la règle locale seule`);
  } else if (ctx.solver && plans.failed) {
    warnings.push(`Timefold sans plan pour ${plans.failed} décisions sur ${plans.asked} (${plans.lastError || 'sans réponse'}) : règle locale seule pour celles-là`);
  }
  const refused = [...ctx.unapplied].filter(e => e.ev === 'song.requested').length;
  if (refused) warnings.push(`${refused} demande${refused > 1 ? 's' : ''} de titre non rejouée${refused > 1 ? 's' : ''} (voir les notes)`);
  if (mode === 'libre' && passages.length < real.length) {
    warnings.push(`le rejeu chante ${passages.length} titres de la file, la soirée ${real.length}`);
  }
  // Avec Timefold : solveur lancé et au moins un plan rendu (ou aucun demandé).
  return { mode, code: ctx.code.label, solver: !!ctx.solver && (!plans.asked || plans.ok > 0), jar: ctx.jar, options: ctx.overrides, timezone: ev.timezone,
    timefold: ctx.solver ? { ...plans } : null,
    names: Object.fromEntries([...ev.people].map(([k, p]) => [k, p.name])),
    decisions: ctx.decisions, passages, realWaits: real, fidelity, definitionCheck,
    waits: { real: summary(real.map(w => w.waitSec)), replay: summary(passages.map(w => w.waitSec)) },
    stageWaits: { real: stageWaitsOf(ev.events), replay: replayStageWaits },
    balance: { real: balanceOf(statsOf(ev.events)), replay: journal ? balanceOf(statsOf(journal)) : null },
    analysis: analyse(passages, groupOf(ev)), realAnalysis: analyse(real, groupOf(ev)), notes: ctx.notes, warnings,
    ignored: ctx.ignored, notReplayed: ctx.notReplayed, unreadable: ev.skipped };
}

// ------------------------------------------------------------------ bilan avant / après
// La même soirée rejouée librement par deux versions de l'ordonnanceur, dans
// les mêmes conditions (inscriptions, demandes, départs, durées réelles),
// mesurée par la même définition (evening-stats.js de la version de travail).
async function runCompare(evening, opts = {}) {
  const ev = asEvening(evening);
  const side = s => ({ budget: opts.budget, options: opts.options, ...(s || {}) });
  // Version « avant » chargée (et extraite) avant tout rejeu : une erreur de
  // version arrête tout de suite.
  const beforeOpts = side(opts.before);
  const code = loadCode(beforeOpts.code);
  let before;
  try {
    before = await runFree(ev, beforeOpts);
  } catch (err) {
    // L'autre version a échoué dans son propre code (méthode renommée…) : le
    // dire, avec l'endroit de l'échec. Toute autre erreur garde sa trace.
    const stack = String(err?.stack || '');
    const inside = code.Scheduler !== Scheduler && [path.join(code.dir, 'scheduler.js'), path.join(code.dir, 'lib') + path.sep]
      .some(f => stack.includes(f));
    if (err instanceof UsageError || !inside) throw err;
    const at = stack.split('\n').find(l => /^\s+at /.test(l))?.trim() || '';
    throw new UsageError(`Rejeu impossible avec ${code.label} : ${err?.message || err}` +
      `${at ? ` (${at})` : ''} ; version trop éloignée de l'outil de rejeu ?`);
  }
  const after = await runFree(ev, side(opts.after));
  // Les deux côtés sont mesurés par evening-stats.js de la version de travail :
  // un changement des seules statistiques ne se voit pas dans ce bilan.
  let statsDiffer = false;
  try {
    statsDiffer = code.Scheduler !== Scheduler &&
      fs.readFileSync(path.join(code.dir, 'evening-stats.js'), 'utf8') !== fs.readFileSync(path.join(ROOT, 'evening-stats.js'), 'utf8');
  } catch (_) { /* dossier sans evening-stats.js */ }
  return { mode: 'avant-après', before, after, timezone: ev.timezone, names: after.names, statsDiffer,
    sameCode: code.Scheduler === Scheduler, unreadable: ev.skipped };
}

// Indicateurs du bilan : valeur réelle, avant, après ; sens du mieux et écart
// en dessous duquel les deux versions sont « égales ».
const MIN = sec => sec == null ? null : Math.round(sec / 6) / 10;
const INDICATORS = [
  { group: 'Titres de la file chantés', label: 'titres', get: r => r.balance.replay?.songs, real: r => r.balance.real.songs, better: 'up', tol: 0 },
  { group: 'Attente par titre (min)', label: 'moyenne', get: r => r.waits.replay.avgMin, real: r => r.waits.real.avgMin, better: 'down', tol: 0.5 },
  { label: 'médiane', get: r => r.waits.replay.medianMin, real: r => r.waits.real.medianMin, better: 'down', tol: 0.5 },
  { label: '9 titres sur 10 en moins de', get: r => r.waits.replay.p90Min, real: r => r.waits.real.p90Min, better: 'down', tol: 1 },
  { label: 'plus longue', get: r => r.waits.replay.maxMin, real: r => r.waits.real.maxMin, better: 'down', tol: 1 },
  { label: 'titres attendus 45 min ou plus', get: r => r.waits.replay.over45, real: r => r.waits.real.over45, better: 'down', tol: 0 },
  { label: 'titres attendus 60 min ou plus', get: r => r.waits.replay.over60, real: r => r.waits.real.over60, better: 'down', tol: 0 },
  { group: 'Sans monter sur scène, invités compris', label: 'plus longue (min)',
    get: r => MIN(maxOf(r.stageWaits.replay)), real: r => MIN(maxOf(r.stageWaits.real)), better: 'down', tol: 1 },
  { label: 'personnes à 60 min ou plus', get: r => r.balance.replay?.stage60, real: r => r.balance.real.stage60, better: 'down', tol: 0 },
  // Indice de Jain : toute baisse compte (AGENTS.md), sans tolérance.
  { id: 'jain', group: 'Équilibre des passages', label: 'indice de Jain (1 = même rythme pour tous)', get: r => r.balance.replay?.jain, real: r => r.balance.real.jain, better: 'up', tol: 0, digits: 3 },
  { label: 'corrigé des bonus et malus', get: r => r.balance.replay?.jainAdjusted, real: r => r.balance.real.jainAdjusted, better: 'up', tol: 0, digits: 3 },
  { label: 'part la plus haute (× sa part)', get: r => r.balance.replay?.shareMax, real: r => r.balance.real.shareMax, better: 'down', tol: 0.05, digits: 2 },
  { label: 'part la plus basse (× sa part)', get: r => r.balance.replay?.shareMin, real: r => r.balance.real.shareMin, better: 'up', tol: 0.05, digits: 2 },
  { label: 'jamais passés', get: r => r.balance.replay?.neverSang, real: r => r.balance.real.neverSang, better: 'down', tol: 0 },
  { group: 'Anomalies de la rotation', label: 'attentes plus longues que le plus long tour', get: r => r.analysis.longWaits.length, real: r => r.realAnalysis.longWaits.length, better: 'down', tol: 0 },
  { label: 'quelqu\'un vu deux fois pendant une attente', get: r => r.analysis.doubles.length, real: r => r.realAnalysis.doubles.length, better: 'down', tol: 0 },
  { label: 'prêt pendant tout un tour sans passer', get: r => r.analysis.skipped.length, real: r => r.realAnalysis.skipped.length, better: 'down', tol: 0 },
  { label: 'même table deux fois de suite', get: r => r.analysis.tableRepeats, real: r => r.realAnalysis.tableRepeats, better: 'down', tol: 0 },
];
function maxOf(waits) {
  const all = Object.values(waits || {}).map(x => x.maxSec).filter(x => x != null);
  return all.length ? Math.max(...all) : null;
}
function verdict(ind, a, b) {
  if (a == null || b == null) return '';
  const d = b - a;
  if (Math.abs(d) <= ind.tol + EPS) return '=';
  return (ind.better === 'down' ? d < 0 : d > 0) ? 'mieux' : 'MOINS BIEN';
}

// Écart d'attente qui fait un gagnant ou un perdant, et poids d'un titre
// gagné ou perdu pour ranger la liste.
const PERSON_WAIT_SEC = 300;
const TITLE_WEIGHT_SEC = 600;
// Personnes dont le sort change : ses propres titres (les passages en invité
// sont montrés, pas comptés, sauf pour qui ne monte plus du tout sur scène ou
// y monte enfin), plus longue attente d'un titre, plus longue attente sans
// monter sur scène (PERSON_WAIT_SEC d'écart au moins).
function peopleChanges(cmp) {
  const A = cmp.before.balance.replay?.people || {}, B = cmp.after.balance.replay?.people || {};
  const rows = [];
  // Attente mesurée d'un seul côté (personne qui n'a rien chanté de l'autre) :
  // pas d'écart, seul le titre gagné ou perdu compte.
  const delta = (x, y) => (x == null || y == null ? 0 : y - x);
  for (const key of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const a = A[key] || {}, b = B[key] || {};
    const dWait = delta(a.waitMaxSec, b.waitMaxSec);
    const dStage = delta(a.stageMaxSec, b.stageMaxSec);
    // Ses propres titres, comme l'équilibre (Jain) et la part ; les passages en
    // invité sont montrés, pas comptés.
    const dTurns = (b.turns ?? 0) - (a.turns ?? 0);
    const stageLost = (a.appearances ?? 0) > 0 && !(b.appearances ?? 0);
    const stageWon = !(a.appearances ?? 0) && (b.appearances ?? 0) > 0;
    // Gagner un titre n'efface pas une attente nettement plus longue : la
    // personne est alors rangée parmi celles qui y perdent.
    const worse = dTurns < 0 || stageLost || dWait >= PERSON_WAIT_SEC || dStage >= PERSON_WAIT_SEC;
    const better = dTurns > 0 || stageWon || dWait <= -PERSON_WAIT_SEC || dStage <= -PERSON_WAIT_SEC;
    if (!worse && !better) continue;
    rows.push({ key, a, b, dWait, dStage, dTurns, worse, better,
      weight: Math.max(Math.abs(dWait), Math.abs(dStage), TITLE_WEIGHT_SEC * Math.max(Math.abs(dTurns), stageLost || stageWon ? 1 : 0)) });
  }
  return rows.sort((x, y) => (y.worse - x.worse) || y.weight - x.weight);
}

// Prénoms et titres viennent des téléphones : aucun caractère de contrôle
// (séquences d'échappement) ni de mise en forme bidirectionnelle (qui
// réordonne une ligne à l'écran) ne part vers le terminal.
const printable = text => String(text)
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '\ufffd');

function compareReport(cmp, { short = false } = {}) {
  const { before, after } = cmp;
  const nm = k => cmp.names[k] || k;
  const T = t => timeOf(t, cmp.timezone);
  const fmt = (v, ind) => v == null ? '—' : ind.digits ? v.toFixed(ind.digits).replace('.', ',') : String(v).replace('.', ',');
  const out = [];
  // Fidélité : titres rejoués au même rang que dans la soirée vécue. La version
  // de ce soir-là, avec Timefold, doit refaire l'ordre réel (sinon le rejeu
  // s'écarte de la soirée et le bilan se lit avec prudence).
  const tag = r => r.solver ? '[Timefold]' : r.timefold ? `[Timefold sans plan, 0/${r.timefold.asked}]` : '[sans Timefold]';
  const side = r => `${r.code} ${tag(r)} ; ` +
    `ordre vécu refait : ${r.fidelity.samePosition}/${r.fidelity.songsReal} titres au même rang`;
  out.push('BILAN AVANT / APRÈS : la même soirée rejouée par deux versions, mesurée par evening-stats.js');
  out.push(`  avant : ${side(before)}`);
  out.push(`  après : ${side(after)}`);
  if (Object.keys(after.options).length) out.push(`  options : ${Object.entries(after.options).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  out.push('  réel  : la soirée vécue (gestes du bar compris, version de ce soir-là), pour repère ; le verdict compare avant et après');
  for (const w of [...before.warnings.map(w => `avant : ${w}`), ...after.warnings.map(w => `après : ${w}`)]) out.push(`  ATTENTION ${w}`);
  // Timefold lancé sans plan rendu (jar ou Java en cause) : à réparer, pas à
  // relancer avec --solveur, et jamais lu comme l'apport de Timefold.
  const broken = [['avant', before], ['après', after]].filter(([, r]) => !r.solver && r.timefold);
  if (broken.length) {
    out.push(`  ATTENTION Timefold lancé sans plan (${broken.map(([k, r]) => `${k} : ${r.jar || 'jar inconnu'}`).join(' ; ')}) : ` +
      'vérifier ce jar et Java, le reconstruire (mvn -q -DskipTests package dans son dossier solver) ou en donner un autre ' +
      '(--solveur pour la version de travail, --solveur-avant pour la version « avant »), puis relancer ; ' +
      `${broken.length > 1 ? 'les deux côtés sont rejoués' : 'ce côté est rejoué'} avec la règle locale seule`);
  }
  if (!before.solver && !after.solver) {
    if (!broken.length) out.push('  ATTENTION rejeu sans Timefold : au bar, Timefold aide à décider ; relancer avec --solveur pour le bilan à présenter');
  } else if (!before.solver || !after.solver) {
    const withoutSolver = !before.solver ? 'avant' : 'après';
    if (broken.length) {
      out.push(cmp.sameCode ?
        `  ATTENTION ${withoutSolver} sans plan Timefold : l'écart vient de la panne du solveur, pas d'un changement de code` :
        `  ATTENTION ${withoutSolver} sans plan Timefold et version différente : le bilan mêle le changement de code et la panne du solveur ; ` +
        'ne pas le présenter avant d\'avoir réparé Timefold');
    } else {
      out.push(cmp.sameCode ?
        `  NOTE ${withoutSolver} sans Timefold : ce bilan mesure l'apport de Timefold, pas un changement de code` :
        `  ATTENTION ${withoutSolver} sans Timefold et version différente : le bilan mêle le changement de code et l'apport de Timefold ; ` +
        'relancer avec Timefold des deux côtés pour le bilan à présenter');
    }
  }
  if (cmp.statsDiffer) {
    out.push('  ATTENTION evening-stats.js diffère entre les deux versions : les deux côtés sont mesurés par celui de la version de travail ; ' +
      'un changement des seules statistiques ne se voit pas ici');
  }
  const f = before.fidelity;
  if (before.solver && f.songsReal && f.samePosition < f.songsReal * 0.9) {
    out.push(`  ATTENTION la version « avant » ne refait que ${f.samePosition}/${f.songsReal} titres au rang vécu : ` +
      'si c\'était la version de la soirée, le rejeu s\'en écarte ; bilan à lire avec prudence');
  }
  out.push('');
  const width = 46;
  out.push(`${''.padEnd(width)}${'réel'.padStart(8)}${'avant'.padStart(8)}${'après'.padStart(8)}  verdict`);
  let up = 0, down = 0, same = 0;
  for (const ind of INDICATORS) {
    if (ind.group) out.push(ind.group);
    const r = ind.real(after), a = ind.get(before), b = ind.get(after);
    const v = verdict(ind, a, b);
    if (v === 'mieux') up++; else if (v === 'MOINS BIEN') down++; else if (v === '=') same++;
    out.push(`  ${ind.label.padEnd(width - 2)}${fmt(r, ind).padStart(8)}${fmt(a, ind).padStart(8)}${fmt(b, ind).padStart(8)}  ${v}`);
  }
  const changes = peopleChanges(cmp);
  const losers = changes.filter(c => c.worse), winners = changes.filter(c => c.better && !c.worse);
  const fr = n => n == null ? '—' : String(n).replace('.', ',');
  const mn = sec => sec == null ? '—' : String(Math.round(sec / 60));
  const line = c => `  ${nm(c.key)} : titres ${c.a.turns ?? 0} → ${c.b.turns ?? 0} (invité ${c.a.guestTurns ?? 0} → ${c.b.guestTurns ?? 0})` +
    ` ; plus longue attente d'un titre ${mn(c.a.waitMaxSec)} → ${mn(c.b.waitMaxSec)} min` +
    ` ; plus longue sans scène ${mn(c.a.stageMaxSec)} → ${mn(c.b.stageMaxSec)} min` +
    ` ; part ${fr(c.a.fairRatio)} → ${fr(c.b.fairRatio)}`;
  out.push('', `Personnes qui y perdent (un de ses titres de moins, plus aucun passage sur scène, ou ${PERSON_WAIT_SEC / 60} min de plus d'attente) : ` +
    (losers.length ? '' : 'personne'));
  for (const c of losers) out.push(line(c));
  out.push(`Personnes qui y gagnent : ${winners.length ? '' : 'personne'}`);
  for (const c of winners) out.push(line(c));
  const jainA = before.balance.replay?.jain, jainB = after.balance.replay?.jain;
  out.push('', `Verdict : ${up} indicateur${up > 1 ? 's' : ''} mieux, ${down} moins bien, ${same} ${same > 1 ? 'égaux' : 'égal'} ; ` +
    `équilibre (Jain) ${fmt(jainA, { digits: 3 })} → ${fmt(jainB, { digits: 3 })} ` +
    `(${verdict(INDICATORS.find(i => i.id === 'jain'), jainA, jainB) || '—'}) ; ` +
    `${losers.length} personne${losers.length > 1 ? 's' : ''} y perd${losers.length > 1 ? 'ent' : ''}, ${winners.length} y gagne${winners.length > 1 ? 'nt' : ''}.`);
  if (!short) {
    // Titres dont l'attente change de 5 min au moins.
    const A = new Map(before.passages.map(p => [p.entryId, p]));
    const B = new Map(after.passages.map(p => [p.entryId, p]));
    const rows = [];
    for (const id of new Set([...A.keys(), ...B.keys()])) {
      const a = A.get(id), b = B.get(id);
      const d = (b?.waitSec ?? Infinity) - (a?.waitSec ?? Infinity);
      if (a && b && Math.abs(d) < 300) continue;
      // Titre chanté d'un seul côté : le cas le plus grave, en tête.
      rows.push({ a, b, d: Number.isFinite(d) ? d : Infinity });
    }
    rows.sort((x, y) => (Math.abs(y.d) - Math.abs(x.d)) || 0);
    out.push('', `Titres dont l'attente change de 5 min ou plus (avant → après) : ${rows.length ? '' : 'aucun'}`);
    const m = p => p ? `${String(Math.round(p.waitSec / 60)).padStart(3)} min` : 'pas chanté';
    for (const { a, b } of rows) {
      const p = b || a;
      out.push(`  ${m(a)} → ${m(b)}  ${p.ids.map(nm).join(' & ')} «${p.title}»${b ? ` (${T(b.start)})` : ''}`);
    }
  }
  const notes = [...new Set([...before.notes, ...after.notes])];
  const extra = Object.entries(after.notReplayed).map(([k, n]) => `${k}×${n}`);
  const unreadable = Object.entries(cmp.unreadable || {}).map(([k, n]) => `${k}×${n}`);
  if (extra.length || unreadable.length || notes.length) out.push('');
  if (extra.length) out.push('gestes non rejoués : ' + extra.join(', '));
  if (unreadable.length) out.push('événements illisibles ou d’une autre version : ' + unreadable.join(', '));
  for (const l of notes) out.push('note : ' + l);
  return printable(out.join('\n'));
}

// ------------------------------------------------------------------ texte
function report(res, { traces = [], short = false } = {}) {
  const tz = res.timezone;
  const T = t => timeOf(t, tz);
  const nm = k => res.names[k] || k;
  const W = ids => ids.map(nm).join(' & ');
  const min = sec => `${Math.round(sec / 60)} min`;
  const out = [];
  const head = `REJEU ${res.mode.toUpperCase()}${res.solver ? ' [Timefold]' : res.timefold ? ' [Timefold sans plan]' : ' [sans Timefold]'}` +
    `${Object.keys(res.options).length ? ' options ' + Object.entries(res.options).map(([k, v]) => `${k}=${v}`).join(',') : ''}`;
  out.push(head);
  for (const w of res.warnings || []) out.push(`ATTENTION ${w}`);
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
  out.push(`  même table deux fois de suite : ${a.tableRepeats}`);
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
  return printable(out.join('\n'));
}

function traceLines(res, d) {
  const nm = k => res.names[k] || k;
  const lines = [];
  const block = (title, st, pick) => {
    if (!st) return;
    lines.push(`    ── ${title} : tour [${st.roundPeople.map(nm).join(', ')}]${st.roundOwed.length ? ` dus [${st.roundOwed.map(nm).join(', ')}]` : ''}` +
      ` passage n° ${st.serial}, espacement ${st.spacing}${st.reserved ? `, annoncé ${nm(st.reserved)}` : ''}${st.plan ? ', plan Timefold actif' : ''}`);
    for (const c of st.candidates) {
      const people = c.singers.map(p => `${nm(p.key)}[${p.roundMember ? 'compté dans le tour' : 'pas compté'} scène=${p.roundApps}` +
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
  const o = { file: null, free: false, solver: false, budget: 3000, traces: [], json: null, options: {}, short: false,
    before: null, solverBefore: null, keys: false };
  const value = (k, name) => {
    if (argv[k] == null || argv[k].startsWith('--')) throw new Error(`${name} attend une valeur`);
    return argv[k];
  };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--libre') o.free = true;
    else if (a === '--avant') o.before = value(++k, '--avant');
    else if (a === '--solveur-avant') o.solverBefore = value(++k, '--solveur-avant');
    else if (a === '--solveur') o.solver = argv[k + 1] && !argv[k + 1].startsWith('--') && /\.jar$/i.test(argv[k + 1]) ? argv[++k] : true;
    else if (a === '--budget') o.budget = Number(argv[++k]);
    else if (a === '--trace') o.traces.push(...value(++k, '--trace').split(',').filter(Boolean));
    else if (a === '--json') o.json = value(++k, '--json');
    else if (a === '--court') o.short = true;
    else if (a === '--cles') o.keys = true;
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
  if (o.solverBefore && !o.before) throw new Error('--solveur-avant va avec --avant');
  if (o.solverBefore && !o.solver) throw new Error('--solveur-avant demande aussi --solveur : les deux versions avec Timefold');
  if (o.before && o.traces.length) throw new Error('--trace détaille un seul rejeu : le lancer sans --avant');
  return o;
}

// Aide : le bloc d'usage de l'en-tête ci-dessus.
const USAGE = (() => {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  const from = lines.findIndex(l => l.includes('node test/rejeu-soiree.js <export.json>'));
  const to = lines.findIndex(l => l.startsWith(' * Programmatique'));
  return lines.slice(from, to).map(l => l.replace(/^ \* ?/, '')).join('\n').trimEnd();
})();

async function main(argv = process.argv.slice(2), print = console.log, printError = console.error) {
  let o;
  try { o = parseArgs(argv); } catch (err) { print(printable(err.message) + '\n\n' + USAGE); return 2; }
  if (o.help || !o.file) { print(USAGE); return o.help ? 0 : 2; }
  try {
    const ev = loadEvening(o.file);
    // --cles : les prénoms de l'export ne sortent pas (rapport, bilan, JSON).
    if (o.keys) for (const p of ev.people.values()) p.name = p.key;
    let res, text;
    if (o.before) {
      res = await runCompare(ev, { budget: o.budget, options: o.options,
        // Timefold des deux côtés : le jar de chaque version (un jar donné pour
        // la version de travail ne vaut pas pour l'autre).
        before: { code: o.before, solver: o.solverBefore === 'sans' ? false : o.solverBefore || !!o.solver },
        after: { solver: o.solver } });
      text = compareReport(res, { short: o.short });
    } else {
      res = await (o.free ? runFree : runForced)(ev, { solver: o.solver, budget: o.budget, options: o.options });
      text = report(res, { traces: o.traces, short: o.short });
    }
    print(text);
    if (o.json) fs.writeFileSync(o.json, JSON.stringify(res, null, 1));
    return 0;
  } catch (err) {
    // Erreur d'utilisation : son message ; défaut du rejeu : la trace complète.
    // Le message peut citer le fichier lu (JSON abîmé) : filtré comme la sortie.
    printError(printable(err instanceof UsageError ? err.message : err?.stack || String(err)));
    return 1;
  }
}

module.exports = { loadEvening, runForced, runFree, runCompare, report, compareReport, analyse, computeWaits, replayJournal,
  stageWaitsOf, passagesFromEvents, balanceOf, summary, main, parseArgs, timeOf, UsageError };
if (require.main === module) main().then(code => { process.exitCode = code; }, err => { console.error(err); process.exitCode = 1; });
