'use strict';
/*
 * Statistiques d'une soirée, calculées à partir de son journal (voir
 * evening-journal.js). Logique pure : aucun accès disque ni réseau, l'heure
 * courante est fournie par l'appelant.
 *
 * Définitions principales (reprises dans `definitions`) :
 * - présence : de l'inscription (ou du retour) au départ signalé ; sans
 *   départ signalé, jusqu'au dernier signe d'activité + 30 min, au plus
 *   jusqu'à la fin de la soirée. Les arrêts de l'application sont retirés.
 * - passage : un titre de la file réellement lancé sur scène (stage.started).
 *   Un titre envoyé puis retiré de KaraFun ne compte pas ; une relance non plus.
 * - attente : du moment où le titre pouvait passer (sa demande, ou la fin du
 *   passage précédent de la même personne si elle est plus tardive) au début
 *   du passage.
 * - temps mort : intervalle entre deux chansons pendant lequel au moins un
 *   titre attendait (file vide et fermeture exclues).
 */

const FORMAT = 1;
const IDLE_CUT_MS = 30 * 60000;      // présence estimée : dernier signe + 30 min
const FAIR_MIN_MS = 30 * 60000;      // équité : au moins 30 min de présence
const DEMAND_MIN_MS = 15 * 60000;    // équité par demande : au moins 15 min avec un titre
const MAX_SONG_SEC = 20 * 60;        // durée jouée plafonnée (déconnexion pendant un titre)
const GAP_MIN_MS = 1000;
// Même table que BONUS_WEIGHTS dans scheduler.js.
const BONUS_WEIGHTS = { '-3': 0.5, '-2': 2 / 3, '-1': 0.8, 0: 1, 1: 1.25, 2: 1.5, 3: 2 };
const bonusWeight = level => BONUS_WEIGHTS[String(Number(level) || 0)] || 1;
const WAIT_BUCKETS = [[0, 10], [10, 20], [20, 30], [30, 45], [45, 60], [60, 90], [90, null]];

// Causes d'un temps mort (bloqueur dominant de karaoke.phase).
const CAUSES = {
  'awaiting-presence': '« Je suis là » attendu',
  sending: 'Envoi à KaraFun',
  'push-delay': 'Envoi à KaraFun',
  loading: 'Lancement du titre',
  'autoplay-off': 'Lecture manuelle par le bar',
  'autoplay-held': 'Lecture suspendue après Spotify',
  'battle-hold': 'Battle en préparation',
  'auto-off': 'Envoi automatique coupé',
  'recovered-pending': 'Envoi KaraFun à vérifier',
  permission: 'Droits KaraFun manquants',
  'queue-clear': 'File en cours de vidage',
  restart: 'Relance d’un titre',
  offline: 'KaraFun ou application déconnectés',
  empty: 'File vide',
  closing: 'Fermeture du bar',
  unknown: 'Cause inconnue',
};
const NOT_DEAD = new Set(['empty', 'closing']);

const DEFINITIONS = {
  presence: 'De l’inscription (ou du retour) au départ signalé. Sans départ signalé : jusqu’au dernier signe d’activité + 30 min, au plus jusqu’à la fin de la soirée. Les arrêts de l’application sont retirés.',
  turns: 'Passages sur scène de ses propres titres (le titre a réellement été lancé). Les titres retirés avant d’être chantés et les relances ne comptent pas.',
  guestTurns: 'Passages comme invité d’un duo, y compris les duos notés par le bar.',
  turnsPerHour: 'Passages de ses titres par heure de présence.',
  wait: 'Du moment où le titre pouvait passer (sa demande, ou la fin du passage précédent de la personne) au début de son passage.',
  requestDelay: 'De la demande du titre à son passage sur scène, même s’il était loin dans la liste de la personne.',
  fairShare: 'Rythme attendu si chaque chanteur passait au même rythme par heure de présence, multiplié par son bonus ou malus.',
  jain: 'Indice de Jain sur les passages par heure de présence : 1 = tout le monde au même rythme, 1/n = une seule personne chante. Calculé sur les chanteurs présents au moins 30 min qui ont demandé un titre.',
  jainAdjusted: 'Même indice après division du rythme de chacun par son bonus ou malus (les écarts voulus par le bar ne comptent pas).',
  demandJain: 'Indice de Jain sur les passages par heure avec au moins un titre en attente (au moins 15 min).',
  deadTime: 'Temps entre deux chansons alors qu’un titre attendait, rapporté au temps de spectacle (chansons + temps morts). File vide et fermeture exclues.',
  songsPerHour: 'Chansons lancées par heure, de la première à la fin de la dernière (arrêts de l’application retirés).',
  firstTurn: 'De la première demande de titre au premier passage de la personne.',
};

const sum = list => list.reduce((a, b) => a + b, 0);
const mean = list => list.length ? sum(list) / list.length : null;
function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function quantile(list, q) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}
// Indice de Jain : (Σx)² / (n Σx²). Null sans données ou si tout vaut 0.
function jain(values) {
  const xs = values.filter(Number.isFinite);
  const squares = sum(xs.map(x => x * x));
  if (!xs.length || !squares) return null;
  return sum(xs) ** 2 / (xs.length * squares);
}
const round = (value, digits = 0) => value == null || !Number.isFinite(value) ? null :
  Math.round(value * 10 ** digits) / 10 ** digits;
const sec = ms => ms == null ? null : Math.round(ms / 1000);

// Chevauchement d'un intervalle avec une liste d'intervalles.
function overlapMs(start, end, spans) {
  let total = 0;
  for (const [a, b] of spans) total += Math.max(0, Math.min(end, b) - Math.max(start, a));
  return total;
}

// --------------------------------------------------------------- texte
const fr = (value, digits = 1) => value == null ? '—' :
  Number(value).toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
function duration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

// --------------------------------------------------------------- calcul
function computeStats({ meta = {}, events = [], now = Date.now(), live = false } = {}) {
  // Ordre du journal ; une ligne dupliquée après un arrêt brutal est ignorée.
  const seen = new Set();
  const list = [...events].filter(e => e && typeof e.ev === 'string' && Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t || (a.seq || 0) - (b.seq || 0))
    .filter(e => {
      if (e.seq == null) return true;
      const key = `${e.boot || ''}:${e.seq}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const closedEvent = list.find(e => e.ev === 'evening.closed');
  const E0 = Math.min(Number.isFinite(meta.startedAt) ? meta.startedAt : Infinity, list[0]?.t ?? now);
  const lastT = list.at(-1)?.t ?? E0;
  const E1 = Number.isFinite(meta.endedAt) ? meta.endedAt : closedEvent ? closedEvent.t : live ? Math.max(now, lastT) : lastT;
  const roster = meta.roster || {};
  const tableNames = meta.tables || {};

  // Arrêts de l'application (reprise après redémarrage).
  const offline = list.filter(e => e.ev === 'app.started' && e.offlineMs > 0)
    .map(e => [Math.max(E0, e.t - e.offlineMs), e.t]);
  const restarts = list.filter(e => e.ev === 'app.started' && e.restored).length;

  // ------------------------------------------------ personnes et tables
  const people = new Map();
  const tables = new Map();
  const tableOf = id => {
    const key = String(id);
    if (!tables.has(key)) tables.set(key, { id: key, individual: !!tableNames[key]?.individual, openedAt: null, leftAt: null, bonus: 0 });
    return tables.get(key);
  };
  const personOf = (id, t) => {
    if (!id) return null;
    if (!people.has(id)) {
      people.set(id, { id, tableId: roster[id]?.tableId ?? null, joinedAt: t, intervals: [], openSince: t,
        lastActivity: t, explicitLeft: null, bonus: 0, active: new Set(), demandSince: null, demandMs: 0,
        requests: 0, removed: 0, removedBy: {}, deferrals: 0, deferSongs: 0, deferMs: 0,
        presenceAsks: 0, presenceLatencies: [], presenceSkips: 0, presenceRemoved: 0, absences: 0,
        battleProposals: 0, battleVotes: 0, invitesSent: 0, invitesReceived: 0, joinRequests: 0,
        firstRequestAt: null });
    }
    return people.get(id);
  };
  const touch = (id, t) => { const p = personOf(id, t); if (p) p.lastActivity = Math.max(p.lastActivity, t); };
  const startDemand = (p, t) => { if (p.active.size && p.demandSince == null) p.demandSince = t; };
  const stopDemand = (p, t) => {
    if (!p.active.size && p.demandSince != null) { p.demandMs += Math.max(0, t - p.demandSince); p.demandSince = null; }
  };
  const dropEntry = (personId, entryId, t) => {
    const p = people.get(personId);
    if (!p || !p.active.delete(entryId)) return;
    stopDemand(p, t);
  };
  const leave = (p, t) => {
    if (!p) return;
    if (p.openSince != null) { p.intervals.push([p.openSince, t, false]); p.openSince = null; }
    p.explicitLeft = t;
    p.active.clear();
    stopDemand(p, t);
  };

  // ------------------------------------------------ titres et passages
  const songs = new Map();     // entryId → demande
  const stages = [];
  const openStages = new Map(); // queueId → passage en cours
  const improvisedLater = new Map(); // entryId → invité noté avant le lancement
  let lastImprovised = null; // dernier duo noté par le bar (changement de partenaire)
  const leftDuo = new Map();   // entryId → invités retirés du duo
  const phases = [];
  const presenceAsked = new Map(); // personId → heure de la demande en cours
  const battles = { proposals: 0, votes: 0, outcomes: {}, staffLaunches: 0, external: 0, voters: [], list: [], cooldownLifted: 0 };
  const duos = { invites: 0, accepted: 0, declined: 0, cancelled: 0, joinRequests: 0, joinAccepted: 0, joinDeclined: 0,
    joinCancelled: 0, joinExpired: 0, inviteExpired: 0, improvised: 0, improvisedCancelled: 0, improvisedReplaced: 0, left: 0 };
  const staff = { moves: 0, priorities: 0, undo: 0, recalculate: 0, removedSongs: 0, queueCleared: 0, absent: 0,
    play: 0, next: 0, restarts: 0, bonus: 0, settings: 0 };
  const closing = { sets: 0, closingAt: null, reachedAt: null, pulled: 0, refused: 0, unsungAtClose: null, cleared: 0 };
  const spotify = { actions: 0, resumes: 0, pauses: 0, silences: [], open: null };
  const autoplay = { held: 0, released: 0 };
  const unsent = {};
  const samples = [];
  const notices = { sent: 0, snoozed: 0 };
  const other = {};
  const settingsChanges = [];
  let queueClearedAt = null;

  const reopen = (stage, queueId, now) => {
    for (const [qid, value] of openStages) if (value === stage) openStages.delete(qid);
    stage.queueId = queueId ?? stage.queueId;
    stage.endAt = null; stage.endKnown = false; stage.ended = false;
    stage.segmentStart = now; // la durée jouée suivante part de la reprise
    openStages.set(stage.queueId ?? `#${stages.length}`, stage);
  };
  const activityKeys = ['personId', 'requesterId', 'voterId', 'proposerId'];
  const passive = /^(presence\.(asked|skipped)|staff\.|table\.|turn\.|person\.(left|joined)|song\.removed|duo\.(joinExpired|inviteExpired|improvised)|notice\.)/;

  for (const e of list) {
    const t = e.t;
    if (!passive.test(e.ev)) for (const key of activityKeys) if (typeof e[key] === 'string') touch(e[key], t);
    switch (e.ev) {
      case 'table.opened': { const tb = tableOf(e.tableId); tb.openedAt ??= t; tb.individual = !!e.individual || tb.individual; break; }
      case 'table.left': {
        const tb = tableOf(e.tableId); tb.leftAt = t;
        for (const pid of Array.isArray(e.personIds) ? e.personIds : []) leave(people.get(pid), t);
        break;
      }
      case 'table.bonus': tableOf(e.tableId).bonus = Number(e.level) || 0; staff.bonus++; break;
      case 'person.bonus': { const p = personOf(e.personId, t); p.bonus = Number(e.level) || 0; staff.bonus++; break; }
      case 'person.joined': {
        const p = personOf(e.personId, t);
        p.joinedAt = Math.min(p.joinedAt, t);
        if (e.tableId != null) p.tableId = String(e.tableId);
        if (p.tableId != null) tableOf(p.tableId);
        break;
      }
      case 'person.left': leave(personOf(e.personId, t), t); break;
      case 'person.reactivated': {
        const p = personOf(e.personId, t);
        if (p.openSince == null) p.openSince = t;
        p.explicitLeft = null;
        break;
      }
      case 'person.seen': break; // activité seulement
      case 'song.requested': {
        const p = personOf(e.personId, t);
        p.requests++;
        p.firstRequestAt ??= t;
        for (const old of Array.isArray(e.replacedEntryIds) ? e.replacedEntryIds : []) dropEntry(p.id, old, t);
        songs.set(e.entryId, { entryId: e.entryId, personId: p.id, requestedAt: t, songId: e.songId ?? null,
          title: e.title || '', artist: e.artist || '', durationSec: Number(e.durationSec) || null,
          mode: e.mode || null, partnerId: null, removedAt: null, removedBy: null, sentAt: null, stageAt: null,
          deferSince: null, deferMs: 0, deferrals: 0, presenceSkips: 0 });
        p.active.add(e.entryId);
        startDemand(p, t);
        break;
      }
      case 'song.removed': {
        const s = songs.get(e.entryId);
        if (s) { s.removedAt = t; s.removedBy = e.by || 'self'; }
        const p = people.get(e.personId) || (s && people.get(s.personId));
        if (p) { p.removed++; p.removedBy[e.by || 'self'] = (p.removedBy[e.by || 'self'] || 0) + 1; dropEntry(p.id, e.entryId, t); }
        if (e.by === 'staff') staff.removedSongs++;
        break;
      }
      case 'duo.invited': {
        const s = songs.get(e.entryId);
        if (s) s.partnerId = e.partnerId || null;
        duos.invites++;
        if (e.sameGroup) duos.accepted++;
        const owner = people.get(e.ownerId); if (owner) owner.invitesSent++;
        const partner = e.partnerId && personOf(e.partnerId, t); if (partner) partner.invitesReceived++;
        break;
      }
      case 'duo.answered': {
        const s = songs.get(e.entryId);
        if (e.accepted) duos.accepted++; else { duos.declined++; if (s) s.partnerId = null; }
        break;
      }
      case 'duo.cancelled': { const s = songs.get(e.entryId); if (s) s.partnerId = null; duos.cancelled++; break; }
      case 'duo.joinRequested': {
        duos.joinRequests++;
        const r = personOf(e.requesterId, t); if (r) r.joinRequests++;
        if (e.direct) { duos.joinAccepted++; const s = songs.get(e.entryId); if (s) s.partnerId = e.requesterId; }
        break;
      }
      case 'duo.joinAnswered': {
        if (e.accepted) { duos.joinAccepted++; const s = songs.get(e.entryId); if (s) s.partnerId = e.requesterId; }
        else duos.joinDeclined++;
        break;
      }
      case 'duo.joinCancelled': duos.joinCancelled++; break;
      case 'duo.joinExpired': duos.joinExpired++; break;
      // Invitation sans réponse au départ du titre : il est parti en solo. Ni
      // refusée ni annulée, elle n'est comptée qu'ici.
      case 'duo.inviteExpired': { const s = songs.get(e.entryId); if (s) s.partnerId = null; duos.inviteExpired++; break; }
      case 'duo.left': {
        duos.left++;
        const guest = e.personId || e.partnerId || e.guestId;
        const s = songs.get(e.entryId); if (s && s.partnerId === guest) s.partnerId = null;
        if (e.entryId && guest) {
          const stage = stages.find(st => st.entryId === e.entryId);
          if (stage && !stage.ended) stage.ids = stage.ids.filter(id => id !== guest);
          else if (!stage) leftDuo.set(e.entryId, [...(leftDuo.get(e.entryId) || []), guest]);
        }
        break;
      }
      case 'duo.improvised': {
        duos.improvised++;
        lastImprovised = { entryId: e.entryId, partnerId: e.partnerId };
        const stage = [...stages].reverse().find(st => e.entryId ? st.entryId === e.entryId : st.queueId === e.queueId);
        if (stage) {
          if (!stage.ids.includes(e.partnerId)) stage.ids.push(e.partnerId);
          stage.kind = 'duo'; stage.improvised = true;
        } else if (e.entryId) improvisedLater.set(e.entryId, e.partnerId);
        touch(e.partnerId, t);
        break;
      }
      case 'duo.improvisedCancelled': {
        duos.improvisedCancelled++;
        const stage = [...stages].reverse().find(st => st.entryId === e.entryId);
        const gone = e.partnerId || e.previousPartnerId || null;
        if (stage) {
          stage.ids = [stage.ids[0], ...stage.ids.slice(1).filter(id => gone && id !== gone)];
          if (stage.ids.length < 2) { stage.kind = 'solo'; stage.improvised = false; }
        }
        improvisedLater.delete(e.entryId);
        break;
      }
      case 'duo.improvisedReplaced': {
        duos.improvisedReplaced++;
        // Le nouveau partenaire vient d'être noté par « duo.improvised » : un
        // changement de partenaire n'est pas un duo de plus.
        if (lastImprovised && lastImprovised.entryId === e.entryId && lastImprovised.partnerId === (e.partnerId || e.newPartnerId)) {
          duos.improvised = Math.max(0, duos.improvised - 1);
        }
        lastImprovised = null;
        const stage = [...stages].reverse().find(st => st.entryId === e.entryId);
        const fresh = e.partnerId || e.newPartnerId;
        if (stage && fresh) { stage.ids = [stage.ids[0], fresh]; stage.kind = 'duo'; stage.improvised = true; }
        break;
      }
      case 'presence.asked':
        for (const pid of Array.isArray(e.personIds) ? e.personIds : []) {
          const p = personOf(pid, t);
          p.presenceAsks++;
          if (!presenceAsked.has(pid)) presenceAsked.set(pid, t);
        }
        break;
      case 'presence.confirmed': {
        const p = personOf(e.personId, t);
        const asked = presenceAsked.get(p.id);
        if (asked != null) { p.presenceLatencies.push(t - asked); presenceAsked.delete(p.id); }
        break;
      }
      case 'presence.skipped': {
        const p = personOf(e.personId, t);
        p.presenceSkips++;
        if (e.removed) p.presenceRemoved++;
        presenceAsked.delete(p.id);
        const s = songs.get(e.entryId); if (s) s.presenceSkips++;
        break;
      }
      case 'staff.absent': {
        staff.absent++;
        const s = songs.get(e.entryId);
        const p = s && people.get(s.personId); if (p) p.absences++;
        break;
      }
      case 'defer.requested': {
        const s = songs.get(e.entryId);
        const p = personOf(e.ownerId, t);
        p.deferrals++; p.deferSongs += Number(e.songs) || 1;
        if (s) { s.deferrals++; if (s.deferSince == null) s.deferSince = t; }
        break;
      }
      case 'defer.ended': {
        const s = songs.get(e.entryId);
        if (s?.deferSince != null) {
          s.deferMs += t - s.deferSince; s.deferSince = null;
        }
        break;
      }
      case 'turn.sent': {
        const s = songs.get(e.entryId);
        if (s) { s.sentAt = t; s.queueId = e.queueId ?? null; }
        if (s?.deferSince != null) { s.deferMs += t - s.deferSince; s.deferSince = null; }
        break;
      }
      case 'turn.unsent': {
        const reason = String(e.reason || 'inconnu');
        unsent[reason] = (unsent[reason] || 0) + 1;
        if (reason === 'pulled-closing') closing.pulled++;
        const s = songs.get(e.entryId);
        if (s && (reason === 'cancelled' || reason === 'skipped-in-karafun')) dropEntry(s.personId, s.entryId, t);
        break;
      }
      case 'stage.started': {
        const queueId = e.queueId == null ? null : String(e.queueId);
        if (queueId != null && openStages.has(queueId)) break; // même titre (reprise de lecture)
        // Même titre revenu juste après (pause, reconnexion) : un seul passage.
        const previous = stages.at(-1);
        if (queueId != null && previous?.queueId === queueId) { reopen(previous, queueId, t); break; }
        // Le passage précédent se termine au plus tard maintenant.
        for (const [qid, st] of openStages) { if (st.endAt == null) { st.endAt = t; st.endKnown = false; } openStages.delete(qid); }
        const s = e.entryId ? songs.get(e.entryId) : null;
        let ids = Array.isArray(e.ids) ? e.ids.filter(id => typeof id === 'string') : [];
        if (e.entryId && leftDuo.has(e.entryId)) ids = ids.filter(id => !leftDuo.get(e.entryId).includes(id));
        const later = e.entryId && improvisedLater.get(e.entryId);
        if (later && !ids.includes(later)) ids.push(later);
        const source = e.source || (ids.length ? 'queue' : 'native');
        const stage = { start: t, endAt: null, endKnown: false, queueId, entryId: e.entryId || null, ids,
          ownerId: ids[0] || null, source, kind: source === 'queue' ? (ids.length > 1 ? 'duo' : 'solo') : source,
          improvised: !!later, title: e.title || s?.title || '', artist: e.artist || s?.artist || '',
          durationSec: Number(e.durationSec) || s?.durationSec || null, playedSec: null, ended: false };
        stages.push(stage);
        if (queueId != null) openStages.set(queueId, stage);
        else openStages.set(`#${stages.length}`, stage);
        for (const pid of ids) touch(pid, t);
        if (s) {
          s.stageAt = t;
          if (s.deferSince != null) { s.deferMs += t - s.deferSince; s.deferSince = null; }
          dropEntry(s.personId, s.entryId, t);
        }
        break;
      }
      case 'stage.ended': {
        const queueId = e.queueId == null ? null : String(e.queueId);
        const st = (queueId != null && openStages.get(queueId)) || [...openStages.values()].at(-1);
        if (!st) break;
        const played = Number(e.playedSec);
        st.endAt = Number.isFinite(played) ? Math.min(t, (st.segmentStart ?? st.start) + played * 1000) : t;
        st.endKnown = true;
        st.ended = true;
        for (const [qid, value] of openStages) if (value === st) openStages.delete(qid);
        break;
      }
      case 'stage.restarted': {
        // Relance depuis le début : la copie du titre prolonge le même passage.
        staff.restarts++;
        const previous = stages.at(-1);
        if (previous) reopen(previous, e.queueId == null ? null : String(e.queueId), t);
        break;
      }
      case 'karaoke.phase': phases.push({ start: t, phase: e.phase || 'unknown', blocker: e.blocker || null }); break;
      case 'battle.proposed': {
        battles.proposals++;
        const p = personOf(e.proposerId, t); if (p) p.battleProposals++;
        battles.list.push({ t, kind: 'proposed', ballotId: e.ballotId, eligible: e.eligible ?? null });
        break;
      }
      case 'battle.vote': {
        battles.votes++;
        const p = personOf(e.voterId, t); if (p) p.battleVotes++;
        break;
      }
      case 'battle.decided': {
        battles.outcomes[e.outcome] = (battles.outcomes[e.outcome] || 0) + 1;
        if (Number.isFinite(e.voters)) battles.voters.push(e.voters);
        battles.list.push({ t, kind: 'decided', ballotId: e.ballotId, outcome: e.outcome, voters: e.voters ?? null, yes: e.yes ?? null });
        break;
      }
      case 'battle.staffLaunch': battles.staffLaunches++; battles.list.push({ t, kind: 'staff', ballotId: e.ballotId, title: e.title || '' }); break;
      case 'battle.external': battles.external++; break;
      case 'battle.cooldownLifted': battles.cooldownLifted++; break;
      case 'staff.move': if (e.kind === 'priority') staff.priorities++; else staff.moves++; break;
      case 'staff.undo': staff.undo++; break;
      case 'staff.recalculate': staff.recalculate++; break;
      case 'staff.queueCleared': {
        staff.queueCleared++;
        queueClearedAt = t;
        for (const p of people.values()) { p.active.clear(); stopDemand(p, t); }
        break;
      }
      case 'staff.play': staff.play++; break;
      case 'staff.next': staff.next++; break;
      case 'settings.changed': staff.settings++; settingsChanges.push({ t, setting: e.setting, from: e.from ?? null, to: e.to ?? null }); break;
      case 'closing.set': closing.sets++; closing.closingAt = e.closingAt ?? closing.closingAt; break;
      case 'closing.cleared': closing.cleared++; closing.closingAt = null; break;
      case 'closing.reached': closing.reachedAt ??= t; break;
      case 'closing.refused': closing.refused++; break;
      case 'spotify': {
        spotify.actions++;
        if (e.action === 'resume' && e.result !== 'error') {
          spotify.resumes++;
          if (spotify.open == null) spotify.open = { start: t, trigger: e.trigger || 'auto' };
        } else if (e.action === 'pause' && e.result !== 'error') {
          spotify.pauses++;
          if (spotify.open) { spotify.silences.push({ ...spotify.open, end: t }); spotify.open = null; }
        }
        break;
      }
      case 'autoplay.held': autoplay.held++; break;
      case 'autoplay.released': autoplay.released++; break;
      case 'queue.sample':
        samples.push({ t, ready: e.ready ?? null, songsListed: e.songsListed ?? null, present: e.present ?? null,
          demanding: e.demanding ?? null, deferred: e.deferred ?? null });
        break;
      case 'notice.sent': notices.sent++; break;
      case 'attention.snoozed': notices.snoozed++; break;
      case 'evening.closed': closing.unsungAtClose = Number.isFinite(e.unsungSongs) ? e.unsungSongs : null; break;
      default: other[e.ev] = (other[e.ev] || 0) + 1;
    }
  }
  if (spotify.open) spotify.silences.push({ ...spotify.open, end: E1, ongoing: live });

  // Fin des passages : connue, sinon le passage suivant, sinon maintenant.
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    if (st.endAt == null) {
      st.endAt = i < stages.length - 1 ? stages[i + 1].start : live ? Math.max(st.start, E1) :
        Math.max(st.start, Math.min(E1, st.durationSec ? st.start + st.durationSec * 1000 : E1));
      st.ongoing = live && i === stages.length - 1;
    }
    st.endAt = Math.min(st.endAt, st.start + MAX_SONG_SEC * 1000);
    st.playedSec = Math.max(0, Math.round((st.endAt - st.start) / 1000));
  }

  // ------------------------------------------------ présences
  for (const p of people.values()) {
    if (p.openSince != null) {
      const end = Math.max(p.openSince, Math.min(E1, p.lastActivity + IDLE_CUT_MS));
      p.intervals.push([p.openSince, end, true]);
      p.openSince = null;
    }
    if (p.demandSince != null) {
      const presentEnd = Math.max(...p.intervals.map(([, b]) => b), p.demandSince);
      p.demandMs += Math.max(0, Math.min(E1, presentEnd) - p.demandSince);
      p.demandSince = null;
    }
    p.presenceMs = Math.max(0, sum(p.intervals.map(([a, b]) => Math.max(0, b - a) - overlapMs(a, b, offline))));
    p.leftAt = p.intervals.length ? p.intervals.at(-1)[1] : null;
    p.leftEstimated = p.intervals.length ? p.intervals.at(-1)[2] : false;
    p.weight = bonusWeight(p.bonus) * bonusWeight(p.tableId != null ? tables.get(String(p.tableId))?.bonus : 0);
  }

  // ------------------------------------------------ attentes par passage
  const ours = stages.filter(st => st.source === 'queue');
  const lastAppearanceEnd = new Map();
  const waits = [];
  for (const st of ours) {
    const s = st.entryId ? songs.get(st.entryId) : null;
    if (s && st.ownerId) {
      const readySince = Math.max(s.requestedAt, lastAppearanceEnd.get(st.ownerId) ?? -Infinity);
      st.requestedAt = s.requestedAt;
      st.requestDelaySec = sec(st.start - s.requestedAt);
      st.waitSec = sec(Math.max(0, st.start - readySince));
      st.deferSec = sec(s.deferMs);
      st.netWaitSec = Math.max(0, st.waitSec - st.deferSec);
      st.presenceSkips = s.presenceSkips;
      waits.push({ personId: st.ownerId, sec: st.waitSec, requestDelaySec: st.requestDelaySec, netSec: st.netWaitSec,
        title: st.title, at: st.start, entryId: st.entryId });
    }
    for (const pid of st.ids) lastAppearanceEnd.set(pid, st.endAt);
  }

  // ------------------------------------------------ chanteurs
  const singers = [...people.values()].map(p => {
    const own = ours.filter(st => st.ownerId === p.id);
    const guest = ours.filter(st => st.ids.slice(1).includes(p.id));
    const myWaits = waits.filter(w => w.personId === p.id).map(w => w.sec);
    const hours = p.presenceMs / 3600000;
    const firstStage = own[0]?.start ?? null;
    const mySongs = [...songs.values()].filter(s => s.personId === p.id);
    return {
      id: p.id, tableId: p.tableId, joinedAt: p.joinedAt, leftAt: p.leftAt, leftEstimated: p.leftEstimated,
      explicitLeft: p.explicitLeft != null, presenceSec: sec(p.presenceMs), demandSec: sec(p.demandMs),
      requests: p.requests, removed: p.removed, removedBy: p.removedBy,
      waiting: mySongs.filter(s => !s.stageAt && !s.removedAt).length,
      turns: own.length, guestTurns: guest.length, appearances: own.length + guest.length,
      improvisedGuest: guest.filter(st => st.improvised).length,
      duosOwner: own.filter(st => st.ids.length > 1).length,
      turnsPerHour: hours > 0 ? round(own.length / hours, 2) : null,
      appearancesPerHour: hours > 0 ? round((own.length + guest.length) / hours, 2) : null,
      turnsPerDemandHour: p.demandMs > 0 ? round(own.length / (p.demandMs / 3600000), 2) : null,
      bonus: p.bonus, weight: round(p.weight, 3),
      waits: { n: myWaits.length, avgSec: round(mean(myWaits)), medianSec: round(median(myWaits)),
        maxSec: myWaits.length ? Math.max(...myWaits) : null, minSec: myWaits.length ? Math.min(...myWaits) : null },
      requestDelayAvgSec: round(mean(waits.filter(w => w.personId === p.id).map(w => w.requestDelaySec))),
      firstTurnSec: firstStage != null && p.firstRequestAt != null ? sec(firstStage - p.firstRequestAt) : null,
      deferrals: p.deferrals, deferSongs: p.deferSongs,
      deferSec: sec(sum(mySongs.map(s => s.deferMs))),
      presenceAsks: p.presenceAsks, presenceSkips: p.presenceSkips, presenceRemoved: p.presenceRemoved,
      presenceMedianSec: round(median(p.presenceLatencies) == null ? null : median(p.presenceLatencies) / 1000),
      absences: p.absences, invitesSent: p.invitesSent, invitesReceived: p.invitesReceived, joinRequests: p.joinRequests,
      battleProposals: p.battleProposals, battleVotes: p.battleVotes,
      songs: mySongs.map(s => ({ entryId: s.entryId, title: s.title, artist: s.artist, requestedAt: s.requestedAt,
        stageAt: s.stageAt, removedAt: s.removedAt, removedBy: s.removedBy,
        status: s.stageAt ? 'sung' : s.removedAt ? 'removed' : 'waiting',
        waitSec: ours.find(st => st.entryId === s.entryId)?.waitSec ?? null })),
    };
  }).sort((a, b) => a.joinedAt - b.joinedAt);

  // Part attendue : même rythme pour tous par heure de présence, × bonus.
  const pool = singers.filter(s => s.requests > 0 && s.presenceSec > 0);
  const poolTurns = sum(pool.map(s => s.turns));
  const poolWeightedHours = sum(pool.map(s => s.weight * s.presenceSec / 3600));
  const fairRate = poolWeightedHours > 0 ? poolTurns / poolWeightedHours : null;
  for (const s of singers) {
    const inPool = pool.includes(s);
    s.fairRate = inPool && fairRate != null ? round(fairRate * s.weight, 2) : null;
    s.expectedTurns = inPool && fairRate != null ? round(fairRate * s.weight * s.presenceSec / 3600, 2) : null;
    s.fairRatio = s.expectedTurns ? round(s.turns / s.expectedTurns, 2) : null;
  }

  // ------------------------------------------------ équité
  const fairPool = singers.filter(s => s.requests > 0 && s.presenceSec * 1000 >= FAIR_MIN_MS);
  const rates = fairPool.map(s => s.turns / (s.presenceSec / 3600));
  const demandPool = singers.filter(s => s.requests > 0 && s.demandSec * 1000 >= DEMAND_MIN_MS);
  const demandRates = demandPool.map(s => s.turns / (s.demandSec / 3600));
  const singerWaits = singers.filter(s => s.waits.n).map(s => s.waits.avgSec);
  const positive = rates.filter(r => r > 0);
  const fairness = {
    n: fairPool.length,
    jain: round(jain(rates), 3),
    jainAdjusted: round(jain(fairPool.map((s, i) => rates[i] / s.weight)), 3),
    bonusPeople: fairPool.filter(s => Math.abs(s.weight - 1) > 1e-9).length,
    demandN: demandPool.length,
    demandJain: round(jain(demandRates), 3),
    demandJainAdjusted: round(jain(demandPool.map((s, i) => demandRates[i] / s.weight)), 3),
    rateMax: rates.length ? round(Math.max(...rates), 2) : null,
    rateMin: rates.length ? round(Math.min(...rates), 2) : null,
    rateSpread: positive.length >= 2 && Math.min(...positive) > 0 ? round(Math.max(...positive) / Math.min(...positive), 2) : null,
    waitSpread: singerWaits.filter(w => w > 0).length >= 2 ?
      round(Math.max(...singerWaits) / Math.max(1, Math.min(...singerWaits.filter(w => w > 0))), 2) : null,
    waitJain: round(jain(singerWaits), 3),
    neverSang: singers.filter(s => s.requests > 0 && s.appearances === 0).length,
    neverSangLeft: singers.filter(s => s.requests > 0 && s.appearances === 0 && s.explicitLeft).length,
    fairRate: round(fairRate, 2),
  };

  // ------------------------------------------------ temps morts
  const phaseSpans = phases.map((ph, i) => [ph.start, phases[i + 1]?.start ?? E1, ph.phase === 'singing' ? null : (ph.blocker || (ph.phase === 'silent' ? 'empty' : 'unknown'))]);
  const gaps = [];
  for (let i = 0; i + 1 < stages.length; i++) {
    const a = stages[i].endAt, b = stages[i + 1].start;
    if (b - a < GAP_MIN_MS) continue;
    const weights = {};
    const off = overlapMs(a, b, offline);
    if (off) weights.offline = off;
    for (const [s, e, cause] of phaseSpans) {
      const w = Math.max(0, Math.min(b, e) - Math.max(a, s));
      if (w && cause) weights[cause] = (weights[cause] || 0) + w;
    }
    const known = sum(Object.values(weights));
    if (known < b - a) weights.unknown = (weights.unknown || 0) + (b - a - known);
    const cause = Object.entries(weights).sort((x, y) => y[1] - x[1])[0][0];
    gaps.push({ start: a, end: b, sec: sec(b - a), cause, label: CAUSES[cause] || cause, dead: !NOT_DEAD.has(cause),
      byCause: Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, sec(v)])) });
  }
  const deadGaps = gaps.filter(g => g.dead);
  const playedSum = sum(stages.map(st => st.playedSec));
  const deadSum = sum(deadGaps.map(g => g.sec));
  const causes = {};
  for (const g of deadGaps) for (const [cause, s] of Object.entries(g.byCause)) if (!NOT_DEAD.has(cause)) causes[cause] = (causes[cause] || 0) + s;
  const causeRows = Object.entries(causes).map(([cause, s]) => ({ cause, label: CAUSES[cause] || cause, sec: s }))
    .sort((a, b) => b.sec - a.sec);

  // ------------------------------------------------ par table
  const tableRows = [...tables.values()].map(tb => {
    const members = singers.filter(s => String(s.tableId) === tb.id);
    const memberIds = new Set(members.map(s => s.id));
    const singing = members.filter(s => s.requests > 0);
    const appearances = ours.filter(st => st.ids.some(id => memberIds.has(id))).length;
    const turns = sum(members.map(s => s.turns));
    const tWaits = waits.filter(w => memberIds.has(w.personId)).map(w => w.sec);
    const singerHours = sum(singing.map(s => s.presenceSec / 3600));
    return { id: tb.id, individual: tb.individual, openedAt: tb.openedAt, leftAt: tb.leftAt, bonus: tb.bonus,
      people: members.length, singers: singing.length, turns, appearances,
      duos: ours.filter(st => st.ids.length > 1 && st.ids.some(id => memberIds.has(id))).length,
      presenceSec: Math.round(sum(members.map(s => s.presenceSec))),
      turnsPerSingerHour: singerHours > 0 ? round(turns / singerHours, 2) : null,
      waits: { n: tWaits.length, avgSec: round(mean(tWaits)), medianSec: round(median(tWaits)), maxSec: tWaits.length ? Math.max(...tWaits) : null } };
  }).filter(tb => tb.people > 0).sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));

  // ------------------------------------------------ global
  const waitSecs = waits.map(w => w.sec);
  const firstStart = stages[0]?.start ?? null;
  const lastEnd = stages.length ? Math.max(...stages.map(st => st.endAt)) : null;
  const singingWindowMs = firstStart != null ? Math.max(0, lastEnd - firstStart - overlapMs(firstStart, lastEnd, offline)) : 0;
  const longest = waits.reduce((best, w) => !best || w.sec > best.sec ? w : best, null);
  const histogram = WAIT_BUCKETS.map(([lo, hi]) => ({ fromMin: lo, toMin: hi,
    count: waitSecs.filter(s => s >= lo * 60 && (hi == null || s < hi * 60)).length }));
  const hourly = [];
  if (stages.length) {
    const h0 = new Date(firstStart); h0.setMinutes(0, 0, 0);
    for (let h = h0.getTime(); h <= lastEnd; h += 3600000) {
      const inHour = stages.filter(st => st.start >= h && st.start < h + 3600000);
      hourly.push({ start: h, songs: inHour.length, solo: inHour.filter(st => st.kind === 'solo').length,
        duo: inHour.filter(st => st.kind === 'duo').length, battle: inHour.filter(st => st.kind === 'battle').length,
        native: inHour.filter(st => !['solo', 'duo', 'battle'].includes(st.kind)).length });
    }
  }
  const firstTurns = singers.map(s => s.firstTurnSec).filter(v => v != null);
  const latencies = [...people.values()].flatMap(p => p.presenceLatencies);
  const ourDuos = ours.filter(st => st.ids.length > 1);
  const pairs = new Set(ourDuos.map(st => [...st.ids].sort().join('+')));
  const tableIdOf = id => people.get(id)?.tableId ?? null;
  const global = {
    registered: people.size,
    singers: singers.filter(s => s.requests > 0 || s.appearances > 0).length,
    sang: singers.filter(s => s.appearances > 0).length,
    requests: songs.size,
    songs: stages.length, ours: ours.length,
    battles: stages.filter(st => st.source === 'battle').length,
    native: stages.filter(st => st.source === 'native').length,
    waitAvgSec: round(mean(waitSecs)), waitMedianSec: round(median(waitSecs)), waitP90Sec: quantile(waitSecs, 0.9),
    netWaitAvgSec: round(mean(waits.map(w => w.netSec))),
    requestDelayAvgSec: round(mean(waits.map(w => w.requestDelaySec))),
    waitHistogram: histogram,
    longestWait: longest ? { sec: longest.sec, personId: longest.personId, title: longest.title, at: longest.at } : null,
    firstTurnAvgSec: round(mean(firstTurns)), firstTurnMedianSec: round(median(firstTurns)),
    songsPerHour: singingWindowMs > 0 ? round(stages.length / (singingWindowMs / 3600000), 1) : null,
    avgSongSec: round(mean(stages.filter(st => st.endKnown).map(st => st.playedSec))),
    playedSec: playedSum,
    deadSec: deadSum, deadAvgSec: round(mean(deadGaps.map(g => g.sec))), deadMedianSec: round(median(deadGaps.map(g => g.sec))),
    deadShare: playedSum + deadSum > 0 ? round(deadSum / (playedSum + deadSum), 3) : null,
    deadCauses: causeRows,
    gapCount: gaps.length, deadGapCount: deadGaps.length,
    idleSec: sum(gaps.filter(g => !g.dead).map(g => g.sec)),
    duoStages: ourDuos.length, duoRate: ours.length ? round(ourDuos.length / ours.length, 3) : null,
    duoPairs: pairs.size,
    crossTableDuos: ourDuos.filter(st => new Set(st.ids.map(tableIdOf)).size > 1).length,
    duos: { ...duos, improvisedStages: ourDuos.filter(st => st.improvised).length },
    battle: { ...battles, list: undefined, voters: undefined,
      avgVoters: round(mean(battles.voters), 1),
      launched: stages.filter(st => st.source === 'battle').length,
      quorumRate: battles.voters.length ? round((battles.outcomes.quorum || 0) / sum(Object.values(battles.outcomes)), 3) : null },
    deferrals: { count: sum(singers.map(s => s.deferrals)), songs: sum(singers.map(s => s.deferSongs)),
      sec: sum(singers.map(s => s.deferSec)), people: singers.filter(s => s.deferrals).length },
    presence: { asks: sum(singers.map(s => s.presenceAsks)), confirmed: latencies.length,
      medianSec: round(median(latencies) == null ? null : median(latencies) / 1000),
      p90Sec: latencies.length ? round(quantile(latencies, 0.9) / 1000) : null,
      skips: sum(singers.map(s => s.presenceSkips)), removed: sum(singers.map(s => s.presenceRemoved)),
      absent: staff.absent },
    closing, staff, unsent, autoplay, notices,
    spotify: { actions: spotify.actions, resumes: spotify.resumes, pauses: spotify.pauses,
      silences: spotify.silences.length, silenceSec: sec(sum(spotify.silences.map(s => s.end - s.start))),
      longestSilenceSec: spotify.silences.length ? sec(Math.max(...spotify.silences.map(s => s.end - s.start))) : null },
    peakHour: hourly.reduce((best, h) => !best || h.songs > best.songs ? h : best, null),
    settingsChanges,
  };

  const stats = {
    format: 'karaoke-evening-stats', version: FORMAT,
    evening: { id: meta.eveningId || null, startedAt: E0, endedAt: Number.isFinite(meta.endedAt) || closedEvent ? E1 : null,
      live: !!live, durationSec: sec(E1 - E0), offlineSec: sec(sum(offline.map(([a, b]) => b - a))), restarts,
      closedBy: closedEvent?.by || null, queueClearedAt },
    global, fairness, singers, tables: tableRows,
    timeline: {
      start: E0, end: E1,
      stages: stages.map((st, i) => ({ i, start: st.start, end: st.endAt, ongoing: !!st.ongoing, endKnown: st.endKnown,
        playedSec: st.playedSec, durationSec: st.durationSec, title: st.title, artist: st.artist, ids: st.ids,
        ownerId: st.ownerId, kind: st.kind, source: st.source, improvised: st.improvised, entryId: st.entryId,
        queueId: st.queueId, requestedAt: st.requestedAt ?? null, waitSec: st.waitSec ?? null,
        requestDelaySec: st.requestDelaySec ?? null, deferSec: st.deferSec ?? null, presenceSkips: st.presenceSkips ?? 0 })),
      gaps,
      phases: phaseSpans.map(([start, end, blocker], i) => ({ start, end, phase: phases[i].phase, blocker })),
      battles: battles.list,
      spotify: spotify.silences,
      offline: offline.map(([start, end]) => ({ start, end })),
      queue: samples,
      hourly,
      closingAt: closing.closingAt,
    },
    quality: { events: list.length, other, offlineSec: sec(sum(offline.map(([a, b]) => b - a))), restarts,
      missing: [!phases.length && stages.length > 1 ? 'karaoke.phase' : null, !samples.length ? 'queue.sample' : null].filter(Boolean) },
    definitions: DEFINITIONS,
  };
  return stats;
}

// --------------------------------------------------------------- repères
// Quelques phrases automatiques. `nameOf(id)` et `tableName(id)` donnent les
// noms affichés (prénoms au bar, pseudonymes dans un export).
function insights(stats, { nameOf = id => id, tableName = id => id } = {}) {
  const out = [];
  const g = stats.global, f = stats.fairness;
  const add = (kind, text, level = 'info') => out.push({ kind, level, text });
  // Tables qui ont attendu nettement plus (ou moins) que la moyenne.
  if (g.waitAvgSec >= 60) {
    const slow = stats.tables.filter(tb => tb.waits.n >= 2 && tb.waits.avgSec >= 1.5 * g.waitAvgSec)
      .sort((a, b) => b.waits.avgSec - a.waits.avgSec).slice(0, 2);
    for (const tb of slow) {
      add('table-wait', `${tableName(tb.id)} a attendu ${fr(tb.waits.avgSec / g.waitAvgSec)}× plus que la moyenne (${duration(tb.waits.avgSec)} contre ${duration(g.waitAvgSec)}).`, 'warn');
    }
  }
  if (g.deadGapCount) {
    const top = g.deadCauses[0];
    const share = top && g.deadSec ? Math.round(100 * top.sec / g.deadSec) : null;
    add('dead-time', `Temps mort moyen entre deux chansons : ${duration(g.deadAvgSec)}${top ? `, surtout dû à ${top.label.startsWith('«') ? top.label : `« ${top.label} »`} (${share} %)` : ''}.`,
      g.deadAvgSec > 60 ? 'warn' : 'info');
  }
  if (f.jain != null && f.n >= 3) {
    if (f.jain >= 0.9) add('fairness', `Rotation équitable : indice ${fr(f.jain, 2)} sur ${f.n} chanteurs (1 = même rythme pour tous).`, 'good');
    else {
      const ranked = stats.singers.filter(s => s.requests > 0 && s.presenceSec * 1000 >= FAIR_MIN_MS && s.turnsPerHour != null)
        .sort((a, b) => b.turnsPerHour - a.turnsPerHour);
      const hi = ranked[0], lo = ranked.at(-1);
      add('fairness', `Rotation inégale (indice ${fr(f.jain, 2)}) : ${nameOf(hi.id)} a chanté ${fr(hi.turnsPerHour)} fois par heure, ${nameOf(lo.id)} ${fr(lo.turnsPerHour)}.${f.bonusPeople ? ` Corrigé des bonus : ${fr(f.jainAdjusted, 2)}.` : ''}`, 'warn');
    }
  }
  if (g.longestWait && g.longestWait.sec >= 60) {
    add('longest-wait', `Plus longue attente : ${duration(g.longestWait.sec)} (${nameOf(g.longestWait.personId)}, « ${g.longestWait.title} »).`,
      g.waitAvgSec && g.longestWait.sec > 3 * g.waitAvgSec ? 'warn' : 'info');
  }
  if (g.firstTurnAvgSec != null && g.sang >= 2) add('first-turn', `Premier passage en ${duration(g.firstTurnAvgSec)} en moyenne après la première demande.`);
  if (g.peakHour && g.peakHour.songs >= 3) {
    const h = new Date(g.peakHour.start).getHours();
    add('peak', `Heure la plus chargée : ${h} h – ${(h + 1) % 24} h, ${g.peakHour.songs} chansons.`);
  }
  if (f.neverSang) add('never-sang', `${f.neverSang} personne${f.neverSang > 1 ? 's ont' : ' a'} demandé un titre sans chanter${f.neverSangLeft ? ` (${f.neverSangLeft} partie${f.neverSangLeft > 1 ? 's' : ''} avant son tour)` : ''}.`, 'warn');
  if (g.presence.asks) {
    add('presence', `« Je suis là » : ${g.presence.confirmed} confirmation${g.presence.confirmed > 1 ? 's' : ''}${g.presence.medianSec != null ? `, réponse médiane en ${duration(g.presence.medianSec)}` : ''}${g.presence.removed ? `, ${g.presence.removed} titre${g.presence.removed > 1 ? 's' : ''} retiré${g.presence.removed > 1 ? 's' : ''} faute de réponse` : ''}.`);
  }
  if (g.battle.proposals || g.battle.staffLaunches) {
    const approved = g.battle.outcomes.approved || 0;
    add('battle', `Battles : ${g.battle.launched} lancée${g.battle.launched > 1 ? 's' : ''}, ${g.battle.proposals} vote${g.battle.proposals > 1 ? 's' : ''} proposé${g.battle.proposals > 1 ? 's' : ''} (${approved} accepté${approved > 1 ? 's' : ''}${g.battle.outcomes.quorum ? `, ${g.battle.outcomes.quorum} sans assez de votants` : ''}).`);
  }
  if (g.duoStages) add('duo', `${g.duoStages} duo${g.duoStages > 1 ? 's' : ''} sur ${g.ours} passages (${Math.round(100 * g.duoRate)} %)${g.duos.improvisedStages ? `, dont ${g.duos.improvisedStages} noté${g.duos.improvisedStages > 1 ? 's' : ''} par le bar` : ''}.`);
  if (g.closing.pulled || g.closing.refused) add('closing', `Fermeture : ${g.closing.pulled} titre${g.closing.pulled > 1 ? 's' : ''} retiré${g.closing.pulled > 1 ? 's' : ''} de KaraFun, ${g.closing.refused} ajout${g.closing.refused > 1 ? 's' : ''} refusé${g.closing.refused > 1 ? 's' : ''}.`);
  if (g.spotify.silences) add('spotify', `Spotify a comblé ${g.spotify.silences} silence${g.spotify.silences > 1 ? 's' : ''} (${duration(g.spotify.silenceSec)} au total).`);
  if (stats.evening.restarts) add('restarts', `L’application a redémarré ${stats.evening.restarts} fois (${duration(stats.evening.offlineSec)} d’arrêt).`, 'warn');
  return out;
}

// --------------------------------------------------------------- export
// Identifiants des personnes remplacés par S01, S02… (ordre d'arrivée) et
// des tables par T1, T2… Les prénoms ne sont joints qu'avec `names`.
function pseudonyms(meta, stats) {
  const people = new Map(), tables = new Map();
  const order = [...stats.singers].sort((a, b) => a.joinedAt - b.joinedAt).map(s => s.id);
  for (const id of Object.keys(meta.roster || {})) if (!order.includes(id)) order.push(id);
  order.forEach((id, i) => people.set(id, `S${String(i + 1).padStart(2, '0')}`));
  const tableOrder = stats.tables.map(tb => tb.id);
  for (const id of Object.keys(meta.tables || {})) if (!tableOrder.includes(id)) tableOrder.push(id);
  for (const s of stats.singers) if (s.tableId != null && !tableOrder.includes(String(s.tableId))) tableOrder.push(String(s.tableId));
  tableOrder.forEach((id, i) => tables.set(String(id), `T${i + 1}`));
  return { people, tables };
}

const TABLE_KEYS = new Set(['tableId', 'tableIds']);
function mapIds(value, maps, key = '') {
  if (value == null) return value;
  if (TABLE_KEYS.has(key)) {
    if (Array.isArray(value)) return value.map(v => v == null ? v : maps.tables.get(String(v)) || 'T?');
    return maps.tables.get(String(value)) || 'T?';
  }
  if (typeof value === 'string') return maps.people.get(value) || value;
  if (Array.isArray(value)) return value.map(v => mapIds(v, maps));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapIds(v, maps, k)]));
  return value;
}

function exportEvening({ meta = {}, events = [], now = Date.now(), live = false, names = false, app = null } = {}) {
  const stats = computeStats({ meta, events, now, live });
  const maps = pseudonyms(meta, stats);
  const roster = meta.roster || {}, tableMeta = meta.tables || {};
  const nameOf = id => names ? roster[id]?.name || maps.people.get(id) || '?' : maps.people.get(id) || '?';
  const tableName = id => names ? tableMeta[id]?.name || maps.tables.get(String(id)) || '?' : maps.tables.get(String(id)) || '?';
  const people = [...maps.people].map(([id, key]) => ({ key, table: maps.tables.get(String(roster[id]?.tableId ?? stats.singers.find(s => s.id === id)?.tableId)) || null,
    ...(names ? { name: roster[id]?.name || null } : {}) }));
  const tables = [...maps.tables].map(([id, key]) => ({ key, individual: !!tableMeta[id]?.individual,
    ...(names ? { name: tableMeta[id]?.name || null } : {}) }));
  // Le journal ne contient ni prénom ni secret ; seules les clés internes
  // (personnes, tables, démarrage) sont encore remplacées.
  const cleanEvents = events.map(({ boot, ...e }) => mapIds(e, maps));
  return {
    format: 'karaoke-evening', version: FORMAT, exportedAt: now,
    app: app ? { version: app.version || null, commit: app.commit || null } : (meta.app || null),
    evening: { id: meta.eveningId || null, startedAt: stats.evening.startedAt, endedAt: stats.evening.endedAt,
      timezone: meta.timezone || null, live: !!live },
    privacy: { names: names ? 'included' : 'pseudonymized', photos: false, notes: false, secrets: false },
    people, tables,
    insights: insights(stats, { nameOf, tableName }),
    stats: { ...mapIds(stats, maps), tables: stats.tables.map(tb => ({ ...mapIds(tb, maps), id: maps.tables.get(tb.id) })) },
    events: cleanEvents,
    definitions: DEFINITIONS,
  };
}

module.exports = { computeStats, insights, exportEvening, jain, median, duration, CAUSES, DEFINITIONS, FORMAT };
