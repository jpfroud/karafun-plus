'use strict';
/*
 * Statistiques d'une soirée, calculées à partir de son journal (voir
 * evening-journal.js). Logique pure : aucun accès disque ni réseau, l'heure
 * courante est fournie par l'appelant.
 *
 * Définitions principales (reprises dans `definitions`) :
 * - présence : de l'inscription (ou du retour) au départ signalé ; sans
 *   départ signalé, jusqu'au dernier signe d'activité + 30 min. Elle reste
 *   dans la soirée du karaoké : de la connexion de la télécommande KaraFun
 *   (celle qui suit le dernier arrêt du PC ou de KaraFun d'au moins 30 min
 *   survenu alors qu'aucun titre n'attendait, avant le premier titre ; au
 *   plus tard le premier titre) à la fermeture. Fermeture : heure de fermeture en vigueur
 *   au début du dernier titre, avec les changements faits avant qu'elle passe
 *   (une heure réglée alors qu'elle était déjà passée compte depuis son
 *   réglage) ; une fois passée, seule une prolongation faite dans les 30 min
 *   la repousse ; le retrait d'« Options par défaut » fait après le début du
 *   dernier titre ne compte pas ; sans heure de fermeture, la clôture de la
 *   soirée dans l'application. Si le dernier passage finit plus tard, sa fin.
 *   Plus tôt : déconnexion de KaraFun pendant ou après le dernier titre, sauf
 *   retour dans les 30 min, ou application arrêtée pendant au moins 30 min à
 *   partir du début du dernier titre. Les arrêts de l'application sont
 *   retirés.
 * - passage : un titre de la file réellement lancé sur scène (stage.started).
 *   Un titre envoyé puis retiré de KaraFun ne compte pas ; une relance non plus.
 * - attente : du moment où le titre pouvait passer (sa demande, ou la fin du
 *   passage précédent de la même personne si elle est plus tardive, au plus
 *   tôt la connexion de KaraFun) au début du passage.
 * - temps mort : intervalle entre deux chansons pendant lequel au moins un
 *   titre attendait (file vide et fermeture exclues).
 *
 * Morceau d'une soirée découpée (plan du 8 novembre, A4 ; evening-split.js) :
 * un journal qui a des lignes reportées (carried: true). Elles sont l'état du
 * morceau à son début, sans aucun compteur ; une personne ou une table n'y est
 * créée que reportée, inscrite ou ouverte dans le morceau, ou citée ; le
 * karaoké y ouvre au plus tôt à sa première activité ; une personne reportée
 * que le bar réactive, partie avant la coupure, n'y est présente que depuis
 * son retour ; la suite d'une demande de duo faite avant la coupure (réponse,
 * annulation, expiration, duo ouvert rejoint ou fermé, invitée qui se retire)
 * n'y compte pas dans les duos. Un journal sans ligne reportée est lu comme
 * avant.
 *
 * Soirée close d'office (plan du 8 novembre, A5) : meta.closedBy, sinon le by
 * de sa ligne evening.closed, vaut 'auto' (remise à zéro du matin, morceaux
 * d'une soirée découpée). Elle finit à son point de clôture C (meta.endedAt,
 * sinon le closedAt de cette ligne, sinon son heure) : aucune ligne datée
 * après C n'est lue, sauf cette ligne, et d'une ligne app.started datée après
 * C ne reste que la part de l'arrêt d'avant C ; de même, une coupure de
 * KaraFun encore ouverte à C n'est durable que si elle dure déjà 30 min à C.
 * Sans heure de fermeture passée, coupure durable de KaraFun ni arrêt de
 * l'application, son karaoké finit à la fin de son dernier titre. Une soirée
 * close par le bouton est lue comme avant.
 */

const { isActivity } = require('./evening-bounds');

const FORMAT = 1;
const IDLE_CUT_MS = 30 * 60000;      // présence estimée : dernier signe + 30 min
const FAIR_MIN_MS = 30 * 60000;      // équité : au moins 30 min de présence
const DEMAND_MIN_MS = 15 * 60000;    // équité par demande : au moins 15 min avec un titre
const MAX_SONG_SEC = 20 * 60;        // durée jouée plafonnée (déconnexion pendant un titre)
const GAP_MIN_MS = 1000;
const BLIP_MS = 30 * 60000;          // KaraFun revenu plus vite : coupure brève (ni ouverture ni fin de la soirée)
const APP_STOP_MS = 30 * 60000;      // arrêt de l'application : sépare la soirée (ouverture) ou la ferme (dernier titre)
const REOPEN_MS = 30 * 60000;        // heure de fermeture passée : une prolongation dans ce délai rouvre la soirée
// Même table que BONUS_WEIGHTS dans lib/scheduler/common.js.
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
  'battle-after': 'Après la Battle : relance par le bar',
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
  presence: 'De l’inscription (ou du retour) au départ signalé. Sans départ signalé : jusqu’au dernier signe d’activité + 30 min. Comptée seulement pendant le karaoké, de la connexion de la télécommande KaraFun (celle qui suit le dernier arrêt du PC ou de KaraFun d’au moins 30 min survenu alors qu’aucun titre n’attendait, avant le premier titre ; au plus tard le premier titre) à la fermeture. Fermeture : heure de fermeture en vigueur au début du dernier titre, avec les changements faits avant qu’elle passe (une heure réglée alors qu’elle était déjà passée compte depuis son réglage) ; une fois passée, seule une prolongation faite dans les 30 min la repousse ; le retrait d’« Options par défaut » fait après le début du dernier titre ne compte pas ; sans heure de fermeture, la clôture de la soirée dans l’application. Si le dernier passage finit plus tard, sa fin. Plus tôt : déconnexion de KaraFun pendant ou après le dernier titre, sauf retour dans les 30 min, ou application arrêtée pendant au moins 30 min à partir du début du dernier titre. Les arrêts de l’application sont retirés.',
  turns: 'Passages sur scène de ses propres titres (le titre a réellement été lancé). Les titres retirés avant d’être chantés et les relances ne comptent pas.',
  guestTurns: 'Passages comme invité d’un duo, y compris les duos notés par le bar.',
  turnsPerHour: 'Passages de ses titres par heure de présence.',
  wait: 'Attente d’un titre, comme la rotation la voit : du moment où la personne attendait son tour (fin de son passage précédent avec un de ses titres, ou début de la période où elle avait un titre en liste, au plus tôt la connexion de KaraFun) au début du passage, sans le temps passé sans aucun titre en liste. Changer, remplacer ou remonter un titre sans qu’un passage de la file soit parti entre-temps ne relance pas l’attente ; un départ, « Vider toutes les chansons » ou un titre retiré faute de « Je suis là » la relancent. Chanter en invité d’un duo ne la remet pas à zéro (la rotation ne compte pas ce passage comme son tour). Attente nette (fichier téléchargé) : sans les « Pas prêt » de la personne pendant ce temps.',
  stageWait: 'Sans monter sur scène : pour chaque passage de la personne, invité compris, depuis sa montée sur scène précédente (quel que soit son rôle), ou depuis qu’elle attendait (un de ses titres en liste, ou un duo accepté), au plus tôt la connexion de KaraFun. Temps sans titre ni duo et coupures : comme l’attente par titre. Un invité noté par le bar au moment du passage n’attendait rien.',
  requestDelay: 'De la demande du titre (au plus tôt la connexion de KaraFun) à son passage sur scène, même s’il était loin dans la liste de la personne.',
  fairShare: 'Rythme attendu si chaque chanteur passait au même rythme par heure de présence, multiplié par son bonus ou malus moyen (pondéré par le temps où il était actif pendant sa présence).',
  jain: 'Indice de Jain sur les passages par heure de présence : 1 = tout le monde au même rythme, 1/n = une seule personne chante. Calculé sur les chanteurs présents au moins 30 min qui ont chanté ou avaient un titre en attente pendant leur présence au karaoké, avant l’heure de fermeture.',
  jainAdjusted: 'Même indice après division du rythme de chacun par son bonus ou malus moyen, pondéré par le temps où il était actif pendant sa présence (les écarts voulus par le bar ne comptent pas).',
  demandJain: 'Indice de Jain sur les passages par heure avec au moins un titre en attente, pendant la présence au karaoké et avant l’heure de fermeture (au moins 15 min).',
  deadTime: 'Temps entre deux chansons alors qu’un titre attendait, rapporté au temps de spectacle (chansons + temps morts). File vide et fermeture exclues.',
  songsPerHour: 'Chansons terminées par heure, du début de la première à la fin de la dernière (titre en cours et arrêts de l’application exclus).',
  firstTurn: 'Depuis la première demande de titre encore en attente lors de la connexion de KaraFun, ou faite après (comptée au plus tôt depuis cette connexion), jusqu’au premier passage de la personne.',
};

// Périodes d'attente d'une personne, comme la rotation les voit : ses
// périodes avec un titre en liste, triées puis fusionnées. Retirer un titre
// puis en choisir un autre sans qu'aucun passage de la file ne soit parti
// entre-temps est un échange : l'attente continue, mais le temps passé sans
// titre (un trou) n'est pas de l'attente. Une coupure (départ de la personne,
// « Vider toutes les chansons », titre retiré faute de « Je suis là ») relance
// l'attente, même au milieu d'une période. `sends` : envois des passages de
// la file (la rotation compte un passage à l'envoi), `cuts` : coupures.
// Rend des périodes { start, end, holes }.
function readyRuns(spans, sends, cuts) {
  const pieces = [];
  for (const [a, b] of spans) {
    if (!(b >= a)) continue;
    let from = a;
    for (const c of [...cuts].sort((x, y) => x - y)) if (c > from && c < b) { pieces.push([from, c]); from = c; }
    pieces.push([from, b]);
  }
  pieces.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const runs = [];
  for (const [a, b] of pieces) {
    const last = runs.at(-1);
    // Chaque morceau est d'un seul côté de chaque coupure : seul un morceau
    // qui commence à la fin de la période, ou après, peut en être séparé.
    const joined = last && (a < last.end ||
      (!cuts.some(c => c >= last.end && c <= a) && !sends.some(t => t >= last.end && t < a)));
    if (!joined) { runs.push({ start: a, end: b, holes: [] }); continue; }
    if (a > last.end) last.holes.push([last.end, a]);
    last.end = Math.max(last.end, b);
  }
  return runs;
}
// Période d'attente qui mène au passage de l'instant `at`.
const runAt = (runs, at) => runs.find(r => r.start < at && at <= r.end) || null;

// Attentes, à partir des passages reconstruits par computeStats. Deux lectures :
// - `waits`, par titre, comme la rotation : du moment où la personne
//   attendait son tour (fin de son dernier passage avec un de ses titres, ou
//   début de la période où elle avait un titre en liste ; un titre changé,
//   remplacé ou remonté en tête ne relance rien) au passage, sans le temps
//   passé sans aucun titre en liste. Chanter en invitée d'un duo ne remet pas
//   l'attente de ses titres à zéro : la rotation ne le lui compte pas comme
//   son tour (soirée du 15 octobre : « L'aventurier » 81 min, affiché 31 min
//   avant). Attente nette : sans les « Pas prêt » de la personne pendant
//   cette attente (titre remplacé ensuite compris) ;
// - `stageWaits`, par personne, sans monter sur scène : chaque montée sur
//   scène, invitée comprise, depuis la précédente ou depuis qu'elle
//   attendait (un de ses titres en liste, ou un duo accepté). Un invité
//   seulement invité a ainsi son attente (59 min le 15 octobre).
// Comme la présence, une attente ne compte que pendant le karaoké.
function passageWaits({ ours, songs, people, openedAt, queueClears = [] }) {
  // La rotation compte un passage à son envoi (titre sans envoi noté : son début).
  const sends = ours.map(st => (st.entryId && songs.get(st.entryId)?.sentAt) ?? st.start);
  const runsOf = new Map(), stageRunsOf = new Map();
  const guestSpans = new Map(); // personne → [acceptation du duo, passage du duo]
  for (const st of ours) {
    const s = st.entryId ? songs.get(st.entryId) : null;
    for (const gid of st.ids.slice(1)) {
      const since = s?.guestSince?.get(gid);
      if (since != null && since < st.start) {
        if (!guestSpans.has(gid)) guestSpans.set(gid, []);
        guestSpans.get(gid).push([since, st.start]);
      }
    }
  }
  const cutsOf = pid => {
    const p = people.get(pid);
    return [...queueClears, ...(p?.leaves || []), ...(p?.presenceCuts || [])];
  };
  const lastCut = (pid, at) => Math.max(-Infinity, ...cutsOf(pid).filter(c => c < at));
  const ownRuns = pid => {
    if (!runsOf.has(pid)) runsOf.set(pid, readyRuns(people.get(pid)?.demandSpans || [], sends, cutsOf(pid)));
    return runsOf.get(pid);
  };
  const anyRuns = pid => {
    if (!stageRunsOf.has(pid)) {
      stageRunsOf.set(pid, readyRuns([...(people.get(pid)?.demandSpans || []), ...(guestSpans.get(pid) || [])],
        sends, cutsOf(pid)));
    }
    return stageRunsOf.get(pid);
  };
  const lastOwnEnd = new Map(), lastStageEnd = new Map();
  const guestAt = new Map(); // personne → débuts de ses passages en invitée
  for (const st of ours) for (const pid of st.ids.slice(1)) {
    if (!guestAt.has(pid)) guestAt.set(pid, []);
    guestAt.get(pid).push(st.start);
  }
  const waits = [], stageWaits = [];
  for (const st of ours) {
    const s = st.entryId ? songs.get(st.entryId) : null;
    if (s && st.ownerId) {
      // Titre en liste sans interruption depuis sa demande : la période qui
      // mène au passage commence au plus tard à cette demande, et jamais
      // avant la dernière coupure (titre déjà envoyé, chanté malgré elle).
      const run = runAt(ownRuns(st.ownerId), st.start);
      const ready = Math.max(Math.min(run?.start ?? s.requestedAt, s.requestedAt), lastCut(st.ownerId, st.start));
      const readySince = Math.max(ready, openedAt, lastOwnEnd.get(st.ownerId) ?? -Infinity);
      const holesMs = run ? overlapMs(readySince, st.start, run.holes) : 0;
      const deferMs = overlapMs(readySince, st.start, people.get(st.ownerId)?.deferSpans || []);
      st.requestedAt = s.requestedAt;
      st.requestDelaySec = sec(st.start - Math.max(s.requestedAt, openedAt));
      st.readySince = readySince;
      st.waitSec = sec(Math.max(0, st.start - readySince - holesMs));
      st.deferSec = sec(s.deferMs);
      st.netWaitSec = Math.max(0, st.waitSec - sec(deferMs));
      st.presenceSkips = s.presenceSkips;
      // Passages en invitée pendant cette attente (montée sur scène quand même).
      const guestStages = guestAt.get(st.ownerId)?.filter(t => t > readySince && t < st.start).length || 0;
      waits.push({ personId: st.ownerId, sec: st.waitSec, requestDelaySec: st.requestDelaySec, netSec: st.netWaitSec,
        title: st.title, at: st.start, entryId: st.entryId, guestStages });
    }
    for (const pid of st.ids) {
      // Invité noté par le bar au moment du passage, sans titre en liste :
      // il n'attendait rien, aucune attente.
      const run = runAt(anyRuns(pid), st.start);
      if (!run) continue;
      const since = Math.max(run.start, openedAt, lastStageEnd.get(pid) ?? -Infinity);
      stageWaits.push({ personId: pid, sec: sec(Math.max(0, st.start - since - overlapMs(since, st.start, run.holes))),
        guest: pid !== st.ownerId, title: st.title, at: st.start, entryId: st.entryId });
    }
    if (st.ownerId) lastOwnEnd.set(st.ownerId, st.endAt);
    for (const pid of st.ids) lastStageEnd.set(pid, st.endAt);
  }
  return { waits, stageWaits };
}

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

// Chevauchement d'un intervalle avec une liste d'intervalles (qui peuvent se
// chevaucher entre eux : deux « Pas prêt » ne comptent qu'une fois).
function overlapMs(start, end, spans) {
  let total = 0, upTo = start;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const lo = Math.max(a, upTo), hi = Math.min(end, b);
    if (hi > lo) { total += hi - lo; upTo = hi; }
  }
  return total;
}

// Niveau de bonus en vigueur à l'instant t ([heure, niveau] dans l'ordre du
// journal ; 0 avant le premier changement).
function levelAt(log, t) {
  let level = 0;
  for (const [at, value] of log) { if (at > t) break; level = value; }
  return level;
}

// Présence pondérée par le bonus de la personne et celui de sa table : chaque
// niveau ne compte que pendant le temps où il était actif, comme dans
// l'ordonnanceur qui l'applique à chaque décision de tour. Rend aussi le
// temps de présence passé avec un poids différent de 1.
function weightedPresence(intervals, personLog, tableLog, offline) {
  const cuts = [...personLog, ...tableLog].map(([at]) => at);
  let weightedMs = 0, bonusMs = 0;
  for (const [a, b] of intervals) {
    if (!(b > a)) continue;
    const points = [...new Set([a, ...cuts.filter(at => at > a && at < b), b])].sort((x, y) => x - y);
    for (let i = 0; i + 1 < points.length; i++) {
      const ms = points[i + 1] - points[i] - overlapMs(points[i], points[i + 1], offline);
      if (ms <= 0) continue;
      const weight = bonusWeight(levelAt(personLog, points[i])) * bonusWeight(levelAt(tableLog, points[i]));
      weightedMs += ms * weight;
      if (Math.abs(weight - 1) > 1e-9) bonusMs += ms;
    }
  }
  return { weightedMs, bonusMs };
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

// --------------------------------------------------------- personnes citées
// Une ligne prolonge la présence des personnes qu'elle nomme par ces champs,
// sauf un geste passif pour elles (gestes du bar sur une personne, messages et
// demandes du serveur, envois et retraits, départs, fins de duo sans geste de
// sa part) ou une ligne du bar (by: 'staff'). Une seule liste et un seul motif,
// pour computeStats et pour citedIds.
const PRESENCE_KEYS = ['personId', 'requesterId', 'voterId', 'proposerId'];
const PASSIVE = /^(presence\.(asked|skipped)|staff\.|table\.|turn\.|person\.(left|joined|bonus)|song\.removed|duo\.(joinExpired|inviteExpired|improvised)|notice\.)/;
// Un identifiant ne nomme quelqu'un que si c'est une chaîne non vide.
const isId = value => typeof value === 'string' && value !== '';
const isLine = e => !!e && typeof e === 'object' && typeof e.ev === 'string';
function presenceIds(e) {
  if (!isLine(e) || PASSIVE.test(e.ev) || e.by === 'staff') return [];
  return PRESENCE_KEYS.map(key => e[key]).filter(isId);
}

// Personnes citées par une ligne (plan du 8 novembre, A4, « Personnes et
// tables citées ») : celles qu'elle montre prendre part à la soirée. C'est la
// règle par laquelle computeStats prolonge une présence, sans les signes de vie
// des téléphones (person.seen) : par les champs de PRESENCE_KEYS, plus les ids
// bruts d'un passage sur scène (stage.started) et l'invitée d'un duo noté par
// le bar (duo.improvised, partnerId). « Je suis prêt » (defer.ended, how:
// 'ready') nomme par personId celle qui l'a touché : elle cite, comme
// computeStats y prolonge sa présence ; les autres lignes d'un « Pas prêt »
// ne nomment que par ownerId. La réparation et le découpage des journaux
// fusionnés (evening-split.js) la reçoivent. Ne rend que des chaînes non
// vides, ne lève jamais.
function citedIds(e) {
  if (!isLine(e) || e.ev === 'person.seen') return [];
  const ids = presenceIds(e);
  if (e.ev === 'stage.started' && Array.isArray(e.ids)) ids.push(...e.ids.filter(isId));
  else if (e.ev === 'duo.improvised' && isId(e.partnerId)) ids.push(e.partnerId);
  return ids;
}

// ------------------------------------------------- morceaux (A4)
// Un morceau d'une soirée découpée se reconnaît à ses lignes reportées
// (carried, vrai seulement s'il vaut true), comme dans planSplit
// (evening-split.js) : même relu sans sa meta (rejeu d'un export, --soiree).
const isCarried = e => e.carried === true;
// Champs qui nomment une personne (les mêmes que dans evening-split.js), dans
// l'ordre de l'export (A4).
const NAMING_KEYS = ['personId', 'personIds', 'ids', 'ownerId', 'partnerId', 'guestId', 'requesterId', 'voterId', 'proposerId', 'toId',
  'previousPartnerId'];
const NAMING_LISTS = new Set(['personIds', 'ids']);
// Lecture large, pour l'export seulement (pseudonyms) : dans n'importe lequel
// de ces champs, toute chaîne non vide que mapIds remplacerait nomme
// quelqu'un, car mapIds remplace toute chaîne, quel que soit son champ : la
// valeur du champ, puis ses éléments imbriqués (listes et objets, sauf sous
// tableId et tableIds, que mapIds lit comme des tables), dans l'ordre.
// Jusqu'au plus profond que garde cleanFields (evening-journal.js), qui rend
// null une liste ou un objet de plus de trois niveaux : une chaîne y est dans
// trois listes ou objets au plus, la valeur du champ comprise.
const NAMED_DEPTH = 4;
function namedIds(e) {
  const ids = [];
  const visit = (value, depth) => {
    if (isId(value)) ids.push(value);
    else if (depth < NAMED_DEPTH && value !== null && typeof value === 'object') {
      if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
      else for (const [key, item] of Object.entries(value)) if (!TABLE_KEYS.has(key)) visit(item, depth + 1);
    }
  };
  for (const key of NAMING_KEYS) visit(e[key], 1);
  return ids;
}
// Lecture stricte, pour les lignes qu'un morceau ignore, comme planSplit
// (A7, champs de mauvais type) : un champ d'identifiant ne nomme que par une
// chaîne non vide, personIds et ids que s'ils sont des listes, par leurs
// éléments qui en sont. Un champ de mauvais type se lit comme absent.
function namedPeople(e) {
  const ids = [];
  for (const key of NAMING_KEYS) {
    const value = e[key];
    if (NAMING_LISTS.has(key)) { if (Array.isArray(value)) ids.push(...value.filter(isId)); }
    else if (isId(value)) ids.push(value);
  }
  return ids;
}
// Demande pour rejoindre un titre (A4) : le titre et la personne qui demande ;
// null sans identifiant de personne.
const joinKey = (entryId, requesterId) => (isId(requesterId) ? `${entryId}\u0000${requesterId}` : null);
// Personnes et tables qu'un morceau crée (A4, « Personnes et tables
// citées »), jugées sur tout le morceau : reportées (person.joined et
// table.opened reportés ; la table d'une personne reportée est citée),
// inscrites ou ouvertes dans le morceau, citées (citedIds), et les tables où
// une inscription du morceau fait arriver quelqu'un. Aussi les demandes de duo
// faites dans le morceau, quel que soit l'ordre des heures : une réponse datée
// d'avant sa demande (heure du PC reculée) y répond quand même. Les
// invitations par leur titre (entryId, un titre neuf par invitation) ; les
// duos ouverts par leur titre et les demandes pour rejoindre par joinKey, avec
// le seq de la première, car elles peuvent se refaire sur un titre de la
// veille (une demande sans seq passe avant toute suite).
function pieceMembers(list) {
  const people = new Set(), tables = new Set(), invitations = new Set(), opens = new Map(), joins = new Map();
  const asked = (requests, key, e) => {
    const seq = Number.isFinite(e.seq) ? e.seq : -Infinity;
    if (key != null && (!requests.has(key) || seq < requests.get(key))) requests.set(key, seq);
  };
  for (const e of list) {
    if (!isCarried(e)) for (const id of citedIds(e)) people.add(id);
    if (e.ev === 'person.joined' && isId(e.personId)) people.add(e.personId);
    if ((e.ev === 'person.joined' || e.ev === 'table.opened') && isId(e.tableId)) tables.add(e.tableId);
    if (isCarried(e) || e.entryId == null) continue;
    if (e.ev === 'duo.invited') invitations.add(e.entryId);
    else if (e.ev === 'duo.openRequested') asked(opens, e.entryId, e);
    else if (e.ev === 'duo.joinRequested') asked(joins, joinKey(e.entryId, e.requesterId), e);
  }
  return { people, tables, invitations, opens, joins };
}

// ------------------------------------------- soirée close d'office (A5)
// Soirée close d'office : meta.closedBy, sinon le by de sa ligne
// evening.closed, vaut 'auto' (remise à zéro du matin, morceaux de la
// réparation et de splitAt). La ligne compte, car test/rejeu-soiree.js relit
// un export sans meta. Rend son point de clôture C : meta.endedAt, sinon le
// closedAt de cette ligne, sinon son heure ; null pour toute autre soirée,
// une soirée en direct, ou sans C connu.
function officeClose(meta, closing, live) {
  if (live) return null;
  const by = typeof meta.closedBy === 'string' ? meta.closedBy : closing?.by;
  if (by !== 'auto') return null;
  if (Number.isFinite(meta.endedAt)) return meta.endedAt;
  if (!closing) return null;
  return Number.isFinite(closing.closedAt) ? closing.closedAt : closing.t;
}

// --------------------------------------------------------------- calcul
function computeStats({ meta = {}, events = [], now = Date.now(), live = false } = {}) {
  // Ordre du journal ; une ligne dupliquée après un arrêt brutal est ignorée.
  const seen = new Set();
  const readable = [...events].filter(e => e && typeof e.ev === 'string' && Number.isFinite(e.t));
  // Morceau d'une soirée découpée (A4) : ses lignes reportées, datées de son
  // début, viennent en tête de son journal. Une ligne datée d'avant elles
  // (heure du PC reculée, A2, « Saut d'horloge ») a été écrite après elles :
  // elle compte à leur heure, donc après elles, comme dans planSplit et comme
  // une activité datée d'avant meta.startedAt dans un morceau découpé (A1).
  const floor = readable.find(isCarried)?.t ?? null;
  const ordered = (floor == null ? readable : readable.map(e => (e.t < floor ? { ...e, t: floor } : e)))
    .sort((a, b) => a.t - b.t || (a.seq || 0) - (b.seq || 0))
    .filter(e => {
      if (e.seq == null) return true;
      const key = `${e.boot || ''}:${e.seq}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  // Soirée close d'office (A5, « Fin du karaoké d'une soirée close
  // d'office ») : elle finit à C. Aucune ligne datée après C n'est lue, sauf
  // sa ligne evening.closed : les lignes qu'une file écrit pendant un retard
  // de la remise à zéro (téléphones revus, retraits, départs, avis, A2) ne
  // changent ni les présences, ni les compteurs, ni la fin du karaoké. D'une
  // ligne app.started datée après C, seule la part de l'arrêt d'avant C reste
  // (PC éteint la nuit, puis remise à zéro au démarrage).
  const closingLine = ordered.find(e => e.ev === 'evening.closed' && !isCarried(e));
  const C = officeClose(meta, closingLine, live);
  const list = C == null ? ordered : ordered.filter(e => e.t <= C || e === closingLine);
  const stopsBeforeC = C == null ? [] : ordered.filter(e => e.t > C && e.ev === 'app.started' && e.offlineMs > 0 && e.t - e.offlineMs < C)
    .map(e => [e.t - e.offlineMs, C]);
  // Personnes et tables que le morceau crée ; null pour un journal sans ligne
  // reportée, lu comme avant. Les lignes reportées ne sont que de l'état :
  // aucune n'est une ligne de la soirée (`own`).
  const piece = floor == null ? null : pieceMembers(list);
  const own = piece ? list.filter(e => !isCarried(e)) : list;
  const closedEvent = own.find(e => e.ev === 'evening.closed');
  const E0 = Math.min(Number.isFinite(meta.startedAt) ? meta.startedAt : Infinity, list[0]?.t ?? now);
  const lastT = list.at(-1)?.t ?? E0;
  const E1 = C != null ? C : Number.isFinite(meta.endedAt) ? meta.endedAt : closedEvent ? closedEvent.t : live ? Math.max(now, lastT) : lastT;
  const roster = meta.roster || {};
  const tableNames = meta.tables || {};

  // Arrêts de l'application (reprise après redémarrage).
  const offline = [...own.filter(e => e.ev === 'app.started' && e.offlineMs > 0).map(e => [e.t - e.offlineMs, e.t]), ...stopsBeforeC]
    .map(([a, b]) => [Math.max(E0, a), b]);
  const restarts = own.filter(e => e.ev === 'app.started' && e.restored).length;

  // ------------------------------------------------ personnes et tables
  // Dans un morceau, une personne ou une table qu'il ne crée pas ne l'est
  // jamais : les lignes qui la nomment sont ignorées pour elle, sans erreur.
  const people = new Map();
  const tables = new Map();
  // Personnes reportées d'un morceau, présentes dès sa coupure (A4).
  const carriedPeople = new Set();
  const tableOk = id => !piece || (isId(id) && piece.tables.has(id));
  // Dans un morceau, un champ de mauvais type se lit comme absent, comme dans
  // planSplit (A7) : une ligne ne nomme une table que par une chaîne non vide,
  // et « En solo » n'y est vrai que s'il vaut true.
  const namesTable = e => (piece ? isId(e.tableId) : e.tableId != null);
  const individualOf = e => (piece ? e.individual === true : !!e.individual);
  const tableOf = id => {
    const key = String(id);
    if (!tables.has(key)) tables.set(key, { id: key, individual: !!tableNames[key]?.individual, openedAt: null, leftAt: null, bonus: 0, bonusLog: [] });
    return tables.get(key);
  };
  const personOf = (id, t) => {
    if (!id) return null;
    if (piece && !piece.people.has(id)) return null;
    if (!people.has(id)) {
      people.set(id, { id, tableId: roster[id]?.tableId ?? null, joinedAt: t, intervals: [], openSince: t,
        lastActivity: t, explicitLeft: null, bonus: 0, bonusLog: [], active: new Set(), demandSince: null, demandSpans: [], leaves: [], presenceCuts: [], deferSpans: [],
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
    if (!p.active.size && p.demandSince != null) { p.demandSpans.push([p.demandSince, t]); p.demandSince = null; }
  };
  const dropEntry = (personId, entryId, t) => {
    const p = people.get(personId);
    if (!p || !p.active.delete(entryId)) return;
    stopDemand(p, t);
  };
  // Titre sorti de la liste sans « song.removed » (remplacé, personne partie,
  // envoi annulé par le bar) : retiré, plus « en attente ». Chanté quand même
  // ensuite (envoi déjà en route), il redevient un titre chanté.
  const retire = (s, t, by) => {
    if (!s || s.stageAt || s.removedAt) return;
    const p = people.get(s.personId);
    s.removedAt = t; s.removedBy = by; s.implicitRemoval = true;
    endDefer(s, t, false);
    if (p) { p.removed++; p.removedBy[by] = (p.removedBy[by] || 0) + 1; }
  };
  // Fin d'un « Pas prêt » : comptée pour le titre s'il part (fin du report,
  // envoi, scène), gardée pour la personne dans tous les cas (attente nette,
  // titre retiré pendant son report compris).
  const endDefer = (s, t, counted = true) => {
    if (s?.deferSince == null) return;
    if (counted) s.deferMs += t - s.deferSince;
    people.get(s.personId)?.deferSpans.push([s.deferSince, t]);
    s.deferSince = null;
  };
  const unretire = s => {
    if (!s?.implicitRemoval) return;
    const p = people.get(s.personId);
    if (p) { p.removed--; if (!--p.removedBy[s.removedBy]) delete p.removedBy[s.removedBy]; }
    s.removedAt = null; s.removedBy = null; s.implicitRemoval = false;
  };
  const leave = (p, t, by = 'self') => {
    if (!p) return;
    if (p.openSince != null) { p.intervals.push([p.openSince, t, false]); p.openSince = null; }
    p.explicitLeft = t;
    p.leaves.push(t);
    for (const entryId of p.active) retire(songs.get(entryId), t, by);
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
  // Invité de nouveau partenaire de ce titre : il n'est plus « retiré ».
  const rejoin = (entryId, guest) => {
    const gone = leftDuo.get(entryId);
    if (!gone) return;
    const rest = gone.filter(id => id !== guest);
    if (rest.length) leftDuo.set(entryId, rest); else leftDuo.delete(entryId);
  };
  const phases = [];
  const presenceAsked = new Map(); // personId → heure de la demande en cours
  const battles = { proposals: 0, votes: 0, outcomes: {}, staffLaunches: 0, external: 0, voters: [], list: [], cooldownLifted: 0 };
  const duos = { invites: 0, accepted: 0, declined: 0, cancelled: 0, joinRequests: 0, joinAccepted: 0, joinDeclined: 0,
    joinCancelled: 0, joinExpired: 0, inviteExpired: 0, improvised: 0, improvisedCancelled: 0, improvisedReplaced: 0, left: 0,
    openRequests: 0, openAccepted: 0, openExpired: 0, openClosed: 0 };
  const staff = { moves: 0, priorities: 0, undo: 0, recalculate: 0, removedSongs: 0, queueCleared: 0, absent: 0,
    play: 0, next: 0, restarts: 0, bonus: 0, settings: 0 };
  const closing = { sets: 0, closingAt: null, reachedAt: null, pulled: 0, refused: 0, unsungAtClose: null, cleared: 0 };
  const spotify = { actions: 0, resumes: 0, pauses: 0, silences: [], open: null };
  const autoplay = { held: 0, released: 0 };
  const unsent = {};
  const samples = [];
  // Avis envoyés aux téléphones. « Plus tard » reste sur le téléphone (rien
  // n'est envoyé au serveur) : il n'est pas compté.
  const notices = { sent: 0 };
  const other = {};
  const settingsChanges = [];
  let queueClearedAt = null;
  const queueClears = []; // « Vider toutes les chansons » : coupe les attentes
  let lastClosingReached = null;
  // [heure du changement, heure de fermeture ou null, retrait d'« Options par défaut »]
  const closingChanges = [];

  const reopen = (stage, queueId, now) => {
    for (const [qid, value] of openStages) if (value === stage) openStages.delete(qid);
    stage.queueId = queueId ?? stage.queueId;
    stage.endAt = null; stage.endKnown = false; stage.ended = false;
    stage.segmentStart = now; // la durée jouée suivante part de la reprise
    openStages.set(stage.queueId ?? `#${stages.length}`, stage);
  };
  // Ligne reportée d'un morceau (A4) : l'état du morceau à son début (table
  // d'une personne, bonus en vigueur, phase de KaraFun ; les règles ne servent
  // pas ici), sans aucun compteur : ni staff.bonus, ni ouverture de table, ni
  // inscription. Une ligne reportée d'un autre type ne compte pas.
  const carriedState = (e, t) => {
    switch (e.ev) {
      case 'karaoke.phase': phases.push({ start: t, phase: e.phase || 'unknown', blocker: e.blocker || null }); break;
      case 'table.opened': if (tableOk(e.tableId)) { const tb = tableOf(e.tableId); tb.individual = individualOf(e) || tb.individual; } break;
      case 'table.bonus': if (tableOk(e.tableId)) { const tb = tableOf(e.tableId); tb.bonus = Number(e.level) || 0; tb.bonusLog.push([t, tb.bonus]); } break;
      case 'person.joined': {
        const p = personOf(e.personId, t);
        if (!p) break;
        carriedPeople.add(p.id);
        if (namesTable(e)) p.tableId = String(e.tableId);
        if (p.tableId != null && tableOk(p.tableId)) tableOf(p.tableId);
        break;
      }
      case 'person.bonus': { const p = personOf(e.personId, t); if (p) { p.bonus = Number(e.level) || 0; p.bonusLog.push([t, p.bonus]); } break; }
      default: break;
    }
  };
  // Ligne d'un morceau qui ne nomme que des personnes ou des tables qu'il ne
  // crée pas : ignorée, sans erreur (gestes du bar, avis, demandes et départs
  // qui ne concernent que la veille). Lecture stricte : une ligne dont le seul
  // nom est dans un champ de mauvais type ne nomme personne, et compte.
  const outsiders = e => {
    let named = false;
    for (const id of namedPeople(e)) { if (piece.people.has(id)) return false; named = true; }
    if (isId(e.tableId)) { if (piece.tables.has(e.tableId)) return false; named = true; }
    return named;
  };
  // Suite d'une demande de duo (A4, « Ce qui traverse la coupure ») : dans un
  // morceau, elle ne compte dans ses duos que si sa demande y a été faite,
  // comme la réponse à une invitation ; celle d'une demande de la veille y est
  // ignorée, et cite quand même ses personnes. Un duo ouvert ou une demande
  // pour rejoindre refaits dans le morceau sur un titre de la veille ne valent
  // que pour les suites écrites après eux (seq) : celle de la demande de la
  // veille, écrite avant, reste ignorée.
  const askedBefore = (requests, key, e) => requests.has(key) && !(Number.isFinite(e.seq) && e.seq < requests.get(key));
  const priorInvite = e => !!piece && !piece.invitations.has(e.entryId);
  const priorOpen = e => !!piece && !askedBefore(piece.opens, e.entryId, e);
  const priorJoin = (e, requesterId = e.requesterId) => !!piece && !askedBefore(piece.joins, joinKey(e.entryId, requesterId), e);
  // Invitation en attente ou duo accepté, venu d'une invitation, d'un duo
  // ouvert ou d'une demande pour rejoindre de son invitée.
  const priorDuo = (e, guestId) => priorInvite(e) && priorOpen(e) && priorJoin(e, guestId);
  for (const e of list) {
    const t = e.t;
    if (piece) {
      if (isCarried(e)) { carriedState(e, t); continue; }
      if (outsiders(e)) continue;
    }
    // Signe d'activité : les personnes que la ligne cite (citedIds), et le
    // téléphone d'un signe de vie (person.seen) ; un geste du bar sur une
    // personne (bonus, réglages de ses titres…) n'en est pas un. Passage sur
    // scène et duo noté par le bar : plus bas, ids filtrés.
    for (const id of presenceIds(e)) touch(id, t);
    switch (e.ev) {
      case 'table.opened': { if (!tableOk(e.tableId)) break; const tb = tableOf(e.tableId); tb.openedAt ??= t; tb.individual = individualOf(e) || tb.individual; break; }
      case 'table.left': {
        if (tableOk(e.tableId)) tableOf(e.tableId).leftAt = t;
        for (const pid of Array.isArray(e.personIds) ? e.personIds : []) leave(people.get(pid), t, 'staff');
        break;
      }
      // Dernier niveau (affiché) et historique (pondération par le temps).
      case 'table.bonus': { if (!tableOk(e.tableId)) break; const tb = tableOf(e.tableId); tb.bonus = Number(e.level) || 0; tb.bonusLog.push([t, tb.bonus]); staff.bonus++; break; }
      // Une ligne qui ne nomme pas sa personne (personOf rend null) est
      // ignorée (A7, champs de mauvais type).
      case 'person.bonus': { const p = personOf(e.personId, t); if (!p) break; p.bonus = Number(e.level) || 0; p.bonusLog.push([t, p.bonus]); staff.bonus++; break; }
      case 'person.joined': {
        const p = personOf(e.personId, t);
        if (!p) break;
        p.joinedAt = Math.min(p.joinedAt, t);
        if (namesTable(e)) p.tableId = String(e.tableId);
        if (p.tableId != null && tableOk(p.tableId)) tableOf(p.tableId);
        break;
      }
      case 'person.left': leave(personOf(e.personId, t), t, e.by === 'staff' ? 'staff' : 'self'); break;
      case 'person.reactivated': {
        const p = personOf(e.personId, t);
        if (!p) break;
        // Personne reportée que le bar réactive (A4) : sans départ noté avant
        // dans le morceau, elle était partie avant la coupure, car le serveur
        // ne note ce retour que pour une personne marquée partie. Sa présence
        // part de son retour, comme dans le journal entier, et non de
        // l'ouverture du karaoké (après un départ, elle n'en a déjà plus).
        if (carriedPeople.delete(p.id) || p.openSince == null) p.openSince = t;
        p.explicitLeft = null;
        break;
      }
      case 'person.seen': break; // activité seulement
      case 'song.requested': {
        const p = personOf(e.personId, t);
        if (!p) break;
        p.requests++;
        p.firstRequestAt ??= t;
        for (const old of Array.isArray(e.replacedEntryIds) ? e.replacedEntryIds : []) { dropEntry(p.id, old, t); retire(songs.get(old), t, 'self'); }
        songs.set(e.entryId, { entryId: e.entryId, personId: p.id, requestedAt: t, songId: e.songId ?? null,
          title: e.title || '', artist: e.artist || '', durationSec: Number(e.durationSec) || null,
          mode: e.mode || null, partnerId: null, guestSince: new Map(), removedAt: null, removedBy: null, sentAt: null, stageAt: null,
          deferSince: null, deferMs: 0, deferrals: 0, presenceSkips: 0 });
        p.active.add(e.entryId);
        startDemand(p, t);
        break;
      }
      case 'song.removed': {
        const s = songs.get(e.entryId);
        if (s) { s.removedAt = t; s.removedBy = e.by || 'self'; endDefer(s, t, false); }
        const p = people.get(e.personId) || (s && people.get(s.personId));
        if (p) { p.removed++; p.removedBy[e.by || 'self'] = (p.removedBy[e.by || 'self'] || 0) + 1; dropEntry(p.id, e.entryId, t); }
        // « Je suis là » manqué trop souvent : la rotation relance l'attente de
        // la personne (titre suivant ou rechoisi, jamais un échange).
        if (p && e.by === 'presence-max') p.presenceCuts.push(t);
        if (e.by === 'staff') staff.removedSongs++;
        break;
      }
      case 'duo.invited': {
        const s = songs.get(e.entryId);
        if (s) s.partnerId = e.partnerId || null;
        duos.invites++;
        // Même table : accepté d'office, l'invité attend le duo dès maintenant.
        if (e.sameGroup) { duos.accepted++; if (s && e.partnerId) s.guestSince.set(e.partnerId, t); }
        const owner = people.get(e.ownerId); if (owner) owner.invitesSent++;
        const partner = e.partnerId && personOf(e.partnerId, t); if (partner) partner.invitesReceived++;
        break;
      }
      case 'duo.answered': {
        // Réponse à une invitation faite avant la coupure (A4) : sans
        // invitation dans le morceau, ignorée dans ses duos ; elle cite quand
        // même la personne qui répond.
        if (priorInvite(e)) break;
        const s = songs.get(e.entryId);
        if (e.accepted) { duos.accepted++; const guest = e.partnerId || s?.partnerId; if (s && guest) s.guestSince.set(guest, t); }
        else { duos.declined++; if (s) { s.guestSince.delete(e.partnerId || s.partnerId); s.partnerId = null; } }
        break;
      }
      // Invitation en attente ou duo accepté d'une demande de la veille (A4) :
      // annulation ignorée dans les duos du morceau.
      case 'duo.cancelled': {
        if (priorDuo(e, e.partnerId)) break;
        const s = songs.get(e.entryId); if (s) { s.guestSince.delete(e.partnerId || s.partnerId); s.partnerId = null; }
        duos.cancelled++;
        break;
      }
      case 'duo.joinRequested': {
        duos.joinRequests++;
        const r = personOf(e.requesterId, t); if (r) r.joinRequests++;
        if (e.direct) { duos.joinAccepted++; const s = songs.get(e.entryId); if (s) { s.partnerId = e.requesterId; s.guestSince.set(e.requesterId, t); } rejoin(e.entryId, e.requesterId); }
        break;
      }
      case 'duo.joinAnswered': {
        // Réponse à une demande de la veille (A4) : ignorée, comme la réponse
        // à une invitation.
        if (priorJoin(e)) break;
        if (e.accepted) { duos.joinAccepted++; const s = songs.get(e.entryId); if (s) { s.partnerId = e.requesterId; s.guestSince.set(e.requesterId, t); } rejoin(e.entryId, e.requesterId); }
        else duos.joinDeclined++;
        break;
      }
      // Duo ouvert (« Qui veut chanter en duo avec moi ? ») : son volontaire
      // attend le duo dès qu'il le rejoint, comme l'invité d'un duo accepté.
      case 'duo.openRequested': duos.openRequests++; break;
      case 'duo.openAccepted': {
        // Duo ouvert de la veille (A4) : ignoré, comme la réponse à une invitation.
        if (priorOpen(e)) break;
        duos.openAccepted++;
        const guest = e.partnerId || e.personId;
        const s = songs.get(e.entryId);
        if (s && guest) { s.partnerId = guest; s.guestSince.set(guest, t); }
        if (guest) rejoin(e.entryId, guest);
        break;
      }
      // Sans volontaire au départ du titre : il est parti en solo. Suites d'un
      // duo ouvert ou d'une demande de la veille (A4) : ignorées.
      case 'duo.openExpired': if (!priorOpen(e)) duos.openExpired++; break;
      case 'duo.openClosed': if (!priorOpen(e)) duos.openClosed++; break;
      case 'duo.joinCancelled': if (!priorJoin(e)) duos.joinCancelled++; break;
      case 'duo.joinExpired': if (!priorJoin(e)) duos.joinExpired++; break;
      // Invitation sans réponse au départ du titre : il est parti en solo. Ni
      // refusée ni annulée, elle n'est comptée qu'ici. Invitation de la veille
      // (A4) : ignorée.
      case 'duo.inviteExpired': {
        if (priorInvite(e)) break;
        const s = songs.get(e.entryId); if (s) { s.guestSince.delete(e.partnerId || s.partnerId); s.partnerId = null; }
        duos.inviteExpired++;
        break;
      }
      case 'duo.left': {
        const guest = e.personId || e.partnerId || e.guestId;
        // Invitée d'un duo d'une demande de la veille (A4) : son départ ne
        // compte pas dans les duos du morceau, mais le passage, lui, ne la
        // compte plus.
        if (!priorDuo(e, guest)) duos.left++;
        const s = songs.get(e.entryId); if (s && s.partnerId === guest) s.partnerId = null;
        s?.guestSince.delete(guest);
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
        // Sans titre ni titre de KaraFun, aucun passage n'est rapproché (une
        // Battle ou un titre hors file n'ont pas de titre de la file).
        const stage = [...stages].reverse().find(st => e.entryId ? st.entryId === e.entryId : e.queueId != null && st.queueId === e.queueId);
        if (stage) {
          if (!stage.ids.includes(e.partnerId)) stage.ids.push(e.partnerId);
          stage.kind = 'duo'; stage.improvised = true;
        } else if (e.entryId) improvisedLater.set(e.entryId, e.partnerId);
        touch(e.partnerId, t);
        break;
      }
      case 'duo.improvisedCancelled': {
        duos.improvisedCancelled++;
        const stage = e.entryId ? [...stages].reverse().find(st => st.entryId === e.entryId) : null;
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
        const stage = e.entryId ? [...stages].reverse().find(st => st.entryId === e.entryId) : null;
        const fresh = e.partnerId || e.newPartnerId;
        if (stage && fresh) { stage.ids = [stage.ids[0], fresh]; stage.kind = 'duo'; stage.improvised = true; }
        break;
      }
      case 'presence.asked':
        for (const pid of Array.isArray(e.personIds) ? e.personIds : []) {
          const p = personOf(pid, t);
          if (!p) continue;
          p.presenceAsks++;
          if (!presenceAsked.has(pid)) presenceAsked.set(pid, t);
        }
        break;
      case 'presence.confirmed': {
        const p = personOf(e.personId, t);
        if (!p) break;
        const asked = presenceAsked.get(p.id);
        if (asked != null) { p.presenceLatencies.push(t - asked); presenceAsked.delete(p.id); }
        break;
      }
      case 'presence.skipped': {
        const p = personOf(e.personId, t);
        if (!p) break;
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
        if (!p) break;
        p.deferrals++; p.deferSongs += Number(e.songs) || 1;
        if (s) { s.deferrals++; if (s.deferSince == null) s.deferSince = t; }
        break;
      }
      case 'defer.ended': {
        const s = songs.get(e.entryId);
        endDefer(s, t);
        break;
      }
      case 'turn.sent': {
        const s = songs.get(e.entryId);
        if (s) { s.sentAt = t; s.queueId = e.queueId ?? null; }
        endDefer(s, t);
        break;
      }
      case 'turn.unsent': {
        const reason = String(e.reason || 'inconnu');
        unsent[reason] = (unsent[reason] || 0) + 1;
        if (reason === 'pulled-closing') closing.pulled++;
        const s = songs.get(e.entryId);
        if (s && (reason === 'cancelled' || reason === 'skipped-in-karafun')) dropEntry(s.personId, s.entryId, t);
        // Envoi annulé (départ, vidage, remise à zéro : toujours le bar).
        if (reason === 'cancelled') retire(s, t, 'staff');
        break;
      }
      case 'stage.started': {
        const queueId = e.queueId == null ? null : String(e.queueId);
        // Même titre noté de nouveau sans fin : l'application a redémarré
        // pendant la chanson. La durée jouée notée à sa fin part de la reprise.
        if (queueId != null && openStages.has(queueId)) { openStages.get(queueId).segmentStart = t; break; }
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
          unretire(s);
          s.stageAt = t;
          endDefer(s, t);
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
        // L'électorat peut grandir pendant le vote (arrivées admises) : la
        // décision garde le nombre final, la proposition celui de l'ouverture.
        battles.list.push({ t, kind: 'decided', ballotId: e.ballotId, outcome: e.outcome, voters: e.voters ?? null, yes: e.yes ?? null,
          eligible: Number.isFinite(e.eligible) ? e.eligible : null });
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
        queueClears.push(t);
        // Le serveur ne note pas un song.removed par titre : chaque titre
        // encore en attente est retiré par le bar à cet instant (le compteur
        // staff.removedSongs reste réservé aux retraits titre par titre).
        for (const p of people.values()) {
          for (const entryId of p.active) {
            const s = songs.get(entryId);
            if (!s || s.stageAt || s.removedAt) continue;
            s.removedAt = t; s.removedBy = 'staff'; endDefer(s, t, false);
            p.removed++; p.removedBy.staff = (p.removedBy.staff || 0) + 1;
          }
          p.active.clear(); stopDemand(p, t);
        }
        break;
      }
      case 'staff.play': staff.play++; break;
      case 'staff.next': staff.next++; break;
      case 'settings.changed': staff.settings++; settingsChanges.push({ t, setting: e.setting, from: e.from ?? null, to: e.to ?? null }); break;
      case 'closing.set':
        closing.sets++; closing.closingAt = e.closingAt ?? closing.closingAt;
        closingChanges.push([t, closing.closingAt]);
        break;
      case 'closing.cleared':
        closing.cleared++; closing.closingAt = null;
        closingChanges.push([t, null, e.reason === 'settings-reset']);
        break;
      case 'closing.reached':
        closing.reachedAt ??= t;
        // Noté dès qu'aucun titre ne peut plus partir, parfois avant l'heure :
        // le bar ferme à l'heure annoncée.
        lastClosingReached = Number.isFinite(e.closingAt) ? e.closingAt : t;
        break;
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
      case 'evening.closed': closing.unsungAtClose = Number.isFinite(e.unsungSongs) ? e.unsungSongs : null; break;
      default: other[e.ev] = (other[e.ev] || 0) + 1;
    }
  }
  if (spotify.open) spotify.silences.push({ ...spotify.open, end: E1, ongoing: live });

  // Coupure de KaraFun « pour de bon » : pas de retour dans les 30 min (en
  // direct, coupé depuis au moins 30 min). Soirée close d'office (A5) : elle
  // finit à C sans lire le retour daté après C (au morceau suivant pour un
  // morceau découpé) ; une coupure encore ouverte à C n'est durable que si
  // elle dure déjà 30 min à C, comme en direct, et comme l'arrêt de
  // l'application dont seule la part d'avant C compte.
  const lasting = (ph, i) => (phases.slice(i + 1).find(next => next.blocker !== 'offline')?.start ?? (live || C != null ? E1 : Infinity)) - ph.start >= BLIP_MS;
  // Première coupure pour de bon après `from` (et avant `until`).
  const lastingCut = (from, until = Infinity) =>
    phases.find((ph, k) => ph.blocker === 'offline' && ph.start > from && ph.start < until && lasting(ph, k));

  // Fin des passages : connue, sinon le passage suivant, sinon maintenant.
  // En direct, le dernier titre sans fin notée est encore sur scène, sauf
  // s'il a commencé il y a plus de 20 min (KaraFun coupé ou PC éteint
  // pendant le titre depuis au moins 30 min, titre laissé en pause) ou si
  // l'application a redémarré depuis sans le retrouver sur scène : sa fin est
  // alors estimée comme une fois la soirée close.
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    if (st.endAt == null) {
      const last = i === stages.length - 1;
      st.ongoing = live && last && E1 - st.start < MAX_SONG_SEC * 1000 &&
        !offline.some(([a]) => a >= (st.segmentStart ?? st.start));
      st.endAt = !last ? stages[i + 1].start : st.ongoing ? Math.max(st.start, E1) :
        Math.max(st.start, Math.min(E1, st.durationSec ? st.start + st.durationSec * 1000 : E1));
    }
    // KaraFun coupé pour de bon pendant le passage : il finit à la coupure,
    // comme le karaoké (un titre retrouvé sur scène après ne le rouvre pas).
    // Une reconnexion plus tard note une fin qui compterait la coupure comme
    // du chant.
    const cutAt = lastingCut(st.start, st.endAt)?.start;
    if (cutAt != null) { st.endAt = cutAt; st.endKnown = false; }
    st.endAt = Math.min(st.endAt, st.start + MAX_SONG_SEC * 1000);
    st.playedSec = Math.max(0, Math.round((st.endAt - st.start) / 1000));
  }

  // ------------------------------------------------ soirée du karaoké
  // Ouverture : connexion de la télécommande KaraFun après la dernière
  // interruption (KaraFun coupé pour de bon, ou application arrêtée au moins
  // 30 min) survenue alors qu'aucun titre n'attendait, avant le premier
  // titre ; au plus tard le premier passage. Soirée du 10 octobre : application lancée à
  // 15:41, KaraFun connecté à 20:19. « Supprimer toutes les tables » en fin de
  // nuit, KaraFun encore connecté : le journal suivant commence connecté, mais
  // l'arrêt du PC ou de KaraFun pendant la nuit le sépare de la soirée. Une
  // coupure pendant que des titres attendent ne déplace rien : leurs attentes
  // restent comptées (un essai du bar retiré avant n'empêche rien).
  const firstStageStart = stages[0]?.start ?? Infinity;
  const waitingAt = x => [...people.values()].some(p =>
    (p.demandSince != null && p.demandSince <= x) || p.demandSpans.some(([a, b]) => a <= x && x < b));
  const interruptions = [
    ...offline.filter(([a, b]) => b - a >= APP_STOP_MS && b <= firstStageStart && !waitingAt(a)).map(([, b]) => b),
    ...phases.filter((ph, k) => ph.blocker === 'offline' && ph.start < firstStageStart && !waitingAt(ph.start) &&
      lasting(ph, k)).map(ph => ph.start),
  ];
  const resumeFrom = interruptions.length ? Math.max(...interruptions) : null;
  const connected = resumeFrom != null || phases[0]?.blocker === 'offline'
    ? phases.find(ph => ph.start >= (resumeFrom ?? -Infinity) && ph.blocker !== 'offline') : null;
  // Morceau (A4) : au plus tôt à sa première activité (A1, lignes reportées
  // exclues), s'il en a une. La présence d'une personne reportée part de là,
  // jamais de la coupure, même quand KaraFun est resté connecté depuis.
  const firstActivity = piece ? own.find(isActivity)?.t ?? -Infinity : -Infinity;
  const openedAt = Math.max(E0, Math.min(connected?.start ?? resumeFrom ?? E0, firstStageStart), firstActivity);
  // Fermeture du bar : heure de fermeture (ci-dessous), ou fin du dernier
  // titre s'il finit plus tard ; plus tôt, KaraFun déconnecté pour de bon ou
  // le PC éteint pendant ou après le dernier titre (en direct aussi, une fois
  // la coupure longue de 30 min) ; sinon fin du journal. Soirée du
  // 10 octobre, close au bar le lendemain à 12:54 : la présence s'arrête à
  // 03:17 (dernier titre après la fermeture de 03:10) au lieu de compter la
  // matinée. KaraFun coupé pendant le dernier titre : le passage et la soirée
  // finissent à la coupure. Une coupure brève (KaraFun
  // revenu en moins de 30 min) ne ferme rien ; une reconnexion le lendemain
  // matin ne rouvre pas la soirée. Un arrêt de l'application d'au moins
  // 30 min (PC du bar éteint) ferme aussi la soirée : au redémarrage, KaraFun
  // revient aussitôt et la coupure semblerait brève.
  const lastStageEnd = stages.length ? Math.max(...stages.map(st => st.endAt)) : null;
  const lastStageStart = stages.length ? Math.max(...stages.map(st => st.start)) : null;
  // Arrêt de l'application d'au moins 30 min à partir du début du dernier titre.
  const appStop = lastStageStart != null ? offline.find(([a, b]) => a >= lastStageStart && b - a >= APP_STOP_MS) : null;
  // Heure de fermeture de la soirée, qu'une « fermeture atteinte » ait été
  // notée ou non (le serveur ne la note que si un titre est retenu) : celle
  // en vigueur au début du dernier titre, puis chaque changement fait avant
  // qu'elle passe (avancée, « + 10 min », retrait). Une fois passée, seule
  // une prolongation dans les 30 min rouvre la soirée ; un retrait ou une
  // heure changée plus tard (le lendemain) ne change rien, en direct comme
  // une fois la soirée close. Le retrait d'« Options par défaut » après le
  // début du dernier titre n'en est pas un (réglages remis en fin de
  // soirée) : l'heure reste. Une heure réglée déjà
  // passée (par erreur) ne passe qu'au moment où elle est réglée. Les
  // changements faits après l'arrêt du PC ne comptent pas (celui noté juste
  // avant, si). Ancien journal sans réglage noté : la dernière fermeture atteinte.
  let closingHour = lastClosingReached, closingFrom = lastClosingReached;
  if (closingChanges.length) {
    const from = lastStageStart ?? -Infinity, until = appStop ? appStop[0] : Infinity;
    const inForce = closingChanges.filter(([at]) => at <= from).at(-1);
    let hour = inForce?.[1] ?? null, setAt = inForce?.[0] ?? -Infinity, passedAt = null;
    for (const [at, next, reset] of closingChanges.filter(([at]) => at > from && at <= until)) {
      if (reset && lastStageStart != null) continue;
      if (passedAt == null && hour != null && hour <= at) passedAt = Math.max(hour, setAt);
      if (passedAt == null || (next != null && next > at && at - passedAt < REOPEN_MS)) {
        hour = next; setAt = at; passedAt = null;
      }
    }
    closingHour = hour;
    // Heure réglée déjà passée : elle ne passe qu'au moment où elle est réglée.
    closingFrom = hour == null ? null : Math.max(hour, setAt);
  }
  const barClosed = closingHour != null && closingHour <= E1;
  // KaraFun coupé pour de bon après le début du dernier titre (sans retour
  // dans les 30 min ; en direct, coupé depuis au moins 30 min) : pas de
  // KaraFun, pas de karaoké, même avant l'heure de fermeture. Le PC éteint
  // après le début du dernier titre finit aussi la soirée. Même règle en
  // direct et une fois la soirée close.
  const offlineAfter = lastStageStart != null ? lastingCut(lastStageStart) : null;
  // Soirée close d'office (A5) qui a au moins un titre et aucune de ces trois
  // fins : son karaoké finit à la fin de son dernier titre (plafonnée par
  // MAX_SONG_SEC), jamais à C, le matin, ce qui compterait des heures de temps
  // mort et d'attente quand KaraFun reste connecté toute la nuit. Le résumé la
  // dit finie. Un morceau découpé dont l'arrêt de l'application n'est noté
  // qu'au morceau suivant (app.started de la reprise) finit ainsi.
  const officeEnd = C != null && stages.length > 0 && !barClosed && !offlineAfter && !appStop;
  const end = barClosed ? Math.max(lastStageEnd ?? -Infinity, closingFrom) : officeEnd ? lastStageEnd : E1;
  const closedAt = Math.max(openedAt, Math.min(E1, end, offlineAfter?.start ?? Infinity, appStop?.[0] ?? Infinity));
  // En direct, un titre encore sur scène : le karaoké n'est pas fini.
  const ended = !stages.some(st => st.ongoing) && (barClosed || !!offlineAfter || !!appStop || officeEnd);
  const inEvening = ([a, b, ...rest]) => [Math.max(a, openedAt), Math.min(b, closedAt), ...rest];
  // Demandes de l'équité : jusqu'à l'heure de fermeture une fois passée (après
  // elle, plus aucun titre ne part), même si le dernier titre finit plus tard.
  const requestEnd = barClosed ? Math.min(closedAt, closingFrom) : closedAt;
  // Arrêts de l'application pendant le karaoké : l'arrêt du PC après la
  // fermeture (jusqu'au lendemain) n'est pas un incident de la soirée.
  const eveningOffline = offline.map(inEvening).filter(([a, b]) => b > a);
  // Le redémarrage qui termine l'arrêt de la nuit (ouverture ancrée sur lui, en
  // direct tant que KaraFun n'est pas connecté) n'est pas un incident du karaoké.
  const eveningRestarts = own.filter(e => e.ev === 'app.started' && e.restored && ((e.t > openedAt && e.t <= closedAt) ||
    eveningOffline.some(([a, b]) => e.t - (e.offlineMs || 0) < b && e.t > a))).length;
  // Silences comblés par Spotify pendant le karaoké seulement : ni l'après-midi
  // avant la connexion de KaraFun, ni la nuit après la fermeture.
  for (const silence of spotify.silences) {
    silence.end = Math.max(Math.min(silence.end, closedAt), Math.min(silence.start, closedAt));
    silence.start = Math.min(Math.max(silence.start, openedAt), silence.end);
    if (silence.end < E1 && silence.ongoing) silence.ongoing = false;
  }
  spotify.silences = spotify.silences.filter(silence => silence.end > silence.start);

  // ------------------------------------------------ présences
  for (const p of people.values()) {
    if (p.openSince != null) {
      const end = Math.max(p.openSince, Math.min(E1, p.lastActivity + IDLE_CUT_MS));
      p.intervals.push([p.openSince, end, true]);
      p.openSince = null;
    }
    if (p.demandSince != null) {
      const presentEnd = Math.max(...p.intervals.map(([, b]) => b), p.demandSince);
      p.demandSpans.push([p.demandSince, Math.min(E1, presentEnd)]);
      p.demandSince = null;
    }
    // Départ réel (avant le découpage au karaoké) : la fiche d'une personne
    // venue seulement hors du karaoké le montre encore.
    p.rawLeftAt = p.intervals.length ? p.intervals.at(-1)[1] : null;
    p.intervals = p.intervals.map(inEvening).filter(([a, b]) => b > a);
    // Titre en attente : pendant la présence au karaoké (arrêts de
    // l'application retirés, comme la présence), jusqu'à l'heure de fermeture
    // une fois passée (après elle, plus aucun titre ne part).
    p.demandMs = sum(p.demandSpans.flatMap(([a, b]) => p.intervals.map(([c, d]) => {
      const lo = Math.max(a, c), hi = Math.min(b, d, requestEnd);
      return hi > lo ? hi - lo - overlapMs(lo, hi, offline) : 0;
    })));
    p.presenceMs = Math.max(0, sum(p.intervals.map(([a, b]) => Math.max(0, b - a) - overlapMs(a, b, offline))));
    p.leftAt = p.intervals.length ? p.intervals.at(-1)[1] : null;
    p.leftEstimated = p.intervals.length ? p.intervals.at(-1)[2] : false;
    const table = p.tableId != null ? tables.get(String(p.tableId)) : null;
    const { weightedMs, bonusMs } = weightedPresence(p.intervals, p.bonusLog, table?.bonusLog || [], offline);
    p.bonusMs = bonusMs;
    // Bonus moyen sur la présence ; sans présence, le dernier niveau connu.
    p.weight = p.presenceMs > 0 ? weightedMs / p.presenceMs : bonusWeight(p.bonus) * bonusWeight(table?.bonus || 0);
  }

  // ------------------------------------------------ attentes par passage
  const ours = stages.filter(st => st.source === 'queue');
  const { waits, stageWaits } = passageWaits({ ours, songs, people, openedAt, queueClears });

  // ------------------------------------------------ chanteurs
  const singers = [...people.values()].map(p => {
    const own = ours.filter(st => st.ownerId === p.id);
    const guest = ours.filter(st => st.ids.slice(1).includes(p.id));
    const myWaits = waits.filter(w => w.personId === p.id).map(w => w.sec);
    const myStageWaits = stageWaits.filter(w => w.personId === p.id);
    const stageSecs = myStageWaits.map(w => w.sec);
    const hours = p.presenceMs / 3600000;
    const firstStage = own[0]?.start ?? null;
    // Premier passage : depuis la première demande encore en attente à
    // l'ouverture ou faite après (un essai retiré avant l'ouverture ne compte
    // pas), au plus tôt l'ouverture.
    const openAsks = p.demandSpans.filter(([a, b]) => b > openedAt && a <= (firstStage ?? Infinity)).map(([a]) => Math.max(a, openedAt));
    const askedFrom = openAsks.length ? openAsks.reduce((min, at) => Math.min(min, at), Infinity)
      : p.firstRequestAt != null ? Math.max(p.firstRequestAt, openedAt) : null;
    const mySongs = [...songs.values()].filter(s => s.personId === p.id);
    return {
      id: p.id, tableId: p.tableId, joinedAt: p.joinedAt, leftAt: p.leftAt, rawLeftAt: p.rawLeftAt, leftEstimated: p.leftEstimated,
      explicitLeft: p.explicitLeft != null, presenceSec: sec(p.presenceMs), demandSec: sec(p.demandMs),
      requests: p.requests, removed: p.removed, removedBy: p.removedBy,
      // Titre chanté, ou en attente pendant sa présence au karaoké avant
      // l'heure de fermeture : une demande faite après elle (ajout toujours
      // possible) ne compte ni dans l'équité ni parmi les chanteurs (soirée
      // et tables).
      askedInKaraoke: own.length > 0 || p.demandMs > 0,
      waiting: mySongs.filter(s => !s.stageAt && !s.removedAt).length,
      turns: own.length, guestTurns: guest.length, appearances: own.length + guest.length,
      improvisedGuest: guest.filter(st => st.improvised).length,
      duosOwner: own.filter(st => st.ids.length > 1).length,
      turnsPerHour: hours > 0 ? round(own.length / hours, 2) : null,
      appearancesPerHour: hours > 0 ? round((own.length + guest.length) / hours, 2) : null,
      turnsPerDemandHour: p.demandMs > 0 ? round(own.length / (p.demandMs / 3600000), 2) : null,
      bonus: p.bonus, weight: round(p.weight, 3), bonusSec: sec(p.bonusMs),
      waits: { n: myWaits.length, avgSec: round(mean(myWaits)), medianSec: round(median(myWaits)),
        maxSec: myWaits.length ? Math.max(...myWaits) : null, minSec: myWaits.length ? Math.min(...myWaits) : null },
      // Sans monter sur scène, comme invitée aussi (définition stageWait).
      stageWaits: { n: stageSecs.length, guestN: myStageWaits.filter(w => w.guest).length, avgSec: round(mean(stageSecs)),
        medianSec: round(median(stageSecs)), maxSec: stageSecs.length ? Math.max(...stageSecs) : null },
      requestDelayAvgSec: round(mean(waits.filter(w => w.personId === p.id).map(w => w.requestDelaySec))),
      firstTurnSec: firstStage != null && askedFrom != null ? sec(firstStage - askedFrom) : null,
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
  const pool = singers.filter(s => s.askedInKaraoke && s.presenceSec > 0);
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
  const fairPool = singers.filter(s => s.askedInKaraoke && s.presenceSec * 1000 >= FAIR_MIN_MS);
  const rates = fairPool.map(s => s.turns / (s.presenceSec / 3600));
  const demandPool = singers.filter(s => s.askedInKaraoke && s.demandSec * 1000 >= DEMAND_MIN_MS);
  const demandRates = demandPool.map(s => s.turns / (s.demandSec / 3600));
  const singerWaits = singers.filter(s => s.waits.n).map(s => s.waits.avgSec);
  const positive = rates.filter(r => r > 0);
  const fairness = {
    n: fairPool.length,
    jain: round(jain(rates), 3),
    jainAdjusted: round(jain(fairPool.map((s, i) => rates[i] / s.weight)), 3),
    bonusPeople: fairPool.filter(s => people.get(s.id).bonusMs > 0).length,
    demandN: demandPool.length,
    demandJain: round(jain(demandRates), 3),
    demandJainAdjusted: round(jain(demandPool.map((s, i) => demandRates[i] / s.weight)), 3),
    rateMax: rates.length ? round(Math.max(...rates), 2) : null,
    rateMin: rates.length ? round(Math.min(...rates), 2) : null,
    rateSpread: positive.length >= 2 && Math.min(...positive) > 0 ? round(Math.max(...positive) / Math.min(...positive), 2) : null,
    waitSpread: singerWaits.filter(w => w > 0).length >= 2 ?
      round(Math.max(...singerWaits) / Math.max(1, Math.min(...singerWaits.filter(w => w > 0))), 2) : null,
    waitJain: round(jain(singerWaits), 3),
    // Titre en attente pendant le karaoké, personne présente pendant le
    // karaoké : une demande après la fermeture, ou d'une personne déjà partie,
    // n'est pas un passage manqué de la rotation.
    neverSang: singers.filter(s => s.askedInKaraoke && s.appearances === 0 && s.presenceSec > 0).length,
    neverSangLeft: singers.filter(s => s.askedInKaraoke && s.appearances === 0 && s.presenceSec > 0 && s.explicitLeft).length,
    fairRate: round(fairRate, 2),
  };

  // ------------------------------------------------ temps morts
  const phaseSpans = phases.map((ph, i) => [ph.start, phases[i + 1]?.start ?? E1, ph.phase === 'singing' ? null : (ph.blocker || (ph.phase === 'silent' ? 'empty' : 'unknown'))]);
  const gaps = [];
  for (let i = 0; i + 1 < stages.length; i++) {
    const a = stages[i].endAt, b = stages[i + 1].start;
    if (b - a < GAP_MIN_MS) continue;
    // Chaque portion de l'intervalle compte pour sa cause : seules celles où
    // un titre attendait sont du temps mort (pas la file vide ni la
    // fermeture). Un arrêt de l'application compte une seule fois, en
    // « offline », et n'est un temps mort que si un titre attendait alors.
    const weights = {}, dead = {};
    const add = (cause, w, isDead) => {
      if (!(w > 0)) return;
      weights[cause] = (weights[cause] || 0) + w;
      if (isDead) dead[cause] = (dead[cause] || 0) + w;
    };
    // Une Battle vient de finir : la file attend que le bar la relance
    // (résultats annoncés), ce n'est plus une Battle « en préparation ».
    const afterBattle = stages[i].source === 'battle';
    let offIdle = 0;
    for (const [s, e, cause] of phaseSpans) {
      const lo = Math.max(a, s), hi = Math.min(b, e);
      if (hi <= lo || !cause) continue;
      const why = afterBattle && cause === 'battle-hold' ? 'battle-after' : cause;
      const off = overlapMs(lo, hi, offline);
      if (NOT_DEAD.has(why)) offIdle += off;
      add(why, hi - lo - off, !NOT_DEAD.has(why));
    }
    const off = overlapMs(a, b, offline);
    add('offline', off - offIdle, true);
    add('offline', offIdle, false);
    const known = sum(Object.values(weights));
    add('unknown', b - a - known, true);
    const deadMs = sum(Object.values(dead));
    const isDead = deadMs >= GAP_MIN_MS;
    // Cause affichée : la plus longue des portions mortes, sinon de l'intervalle.
    const cause = Object.entries(isDead ? dead : weights).sort((x, y) => y[1] - x[1])[0][0];
    gaps.push({ start: a, end: b, sec: sec(b - a), deadSec: isDead ? sec(deadMs) : 0, cause, label: CAUSES[cause] || cause, dead: isDead,
      byCause: Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, sec(v)])),
      deadByCause: isDead ? Object.fromEntries(Object.entries(dead).map(([k, v]) => [k, sec(v)])) : {} });
  }
  const deadGaps = gaps.filter(g => g.dead);
  const playedSum = sum(stages.map(st => st.playedSec));
  const deadSum = sum(deadGaps.map(g => g.deadSec));
  const causes = {};
  for (const g of deadGaps) for (const [cause, s] of Object.entries(g.deadByCause)) causes[cause] = (causes[cause] || 0) + s;
  const causeRows = Object.entries(causes).filter(([, s]) => s > 0).map(([cause, s]) => ({ cause, label: CAUSES[cause] || cause, sec: s }))
    .sort((a, b) => b.sec - a.sec);

  // ------------------------------------------------ par table
  const tableRows = [...tables.values()].map(tb => {
    const members = singers.filter(s => String(s.tableId) === tb.id);
    const memberIds = new Set(members.map(s => s.id));
    const singing = members.filter(s => s.askedInKaraoke);
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
  // Chansons par heure : titres terminés seulement, jusqu'à la fin du dernier
  // d'entre eux. Un titre en cours compterait pour une chanson entière avec
  // seulement son temps écoulé (plus de 80 titres de 45 s par heure).
  const done = stages.filter(st => !st.ongoing);
  const doneEnd = done.length ? Math.max(...done.map(st => st.endAt)) : null;
  const doneWindowMs = done.length ? Math.max(0, doneEnd - done[0].start - overlapMs(done[0].start, doneEnd, offline)) : 0;
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
    singers: singers.filter(s => s.askedInKaraoke || s.appearances > 0).length,
    sang: singers.filter(s => s.appearances > 0).length,
    requests: songs.size,
    songs: stages.length, ours: ours.length,
    battles: stages.filter(st => st.source === 'battle').length,
    native: stages.filter(st => st.source === 'native').length,
    waitAvgSec: round(mean(waitSecs)), waitMedianSec: round(median(waitSecs)), waitP90Sec: quantile(waitSecs, 0.9),
    netWaitAvgSec: round(mean(waits.map(w => w.netSec))),
    requestDelayAvgSec: round(mean(waits.map(w => w.requestDelaySec))),
    waitHistogram: histogram,
    longestWait: longest ? { sec: longest.sec, personId: longest.personId, title: longest.title, at: longest.at,
      guestStages: longest.guestStages } : null,
    firstTurnAvgSec: round(mean(firstTurns)), firstTurnMedianSec: round(median(firstTurns)),
    songsPerHour: doneWindowMs > 0 ? round(done.length / (doneWindowMs / 3600000), 1) : null,
    avgSongSec: round(mean(stages.filter(st => st.endKnown).map(st => st.playedSec))),
    playedSec: playedSum,
    deadSec: deadSum, deadAvgSec: round(mean(deadGaps.map(g => g.deadSec))), deadMedianSec: round(median(deadGaps.map(g => g.deadSec))),
    deadShare: playedSum + deadSum > 0 ? round(deadSum / (playedSum + deadSum), 3) : null,
    deadCauses: causeRows,
    gapCount: gaps.length, deadGapCount: deadGaps.length,
    idleSec: sum(gaps.map(g => g.sec - g.deadSec)),
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
      openedAt, closedAt: ended ? closedAt : null,
      live: !!live, durationSec: sec(E1 - E0), offlineSec: sec(sum(eveningOffline.map(([a, b]) => b - a))), restarts: eveningRestarts,
      closedBy: closedEvent?.by || null, queueClearedAt },
    global, fairness, singers, tables: tableRows,
    timeline: {
      start: E0, end: E1,
      stages: stages.map((st, i) => ({ i, start: st.start, end: st.endAt, ongoing: !!st.ongoing, endKnown: st.endKnown,
        playedSec: st.playedSec, durationSec: st.durationSec, title: st.title, artist: st.artist, ids: st.ids,
        ownerId: st.ownerId, kind: st.kind, source: st.source, improvised: st.improvised, entryId: st.entryId,
        queueId: st.queueId, requestedAt: st.requestedAt ?? null, readySince: st.readySince ?? null, waitSec: st.waitSec ?? null,
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
    quality: { events: own.length, other, offlineSec: sec(sum(offline.map(([a, b]) => b - a))), restarts,
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
      const ranked = stats.singers.filter(s => s.askedInKaraoke && s.presenceSec * 1000 >= FAIR_MIN_MS && s.turnsPerHour != null)
        .sort((a, b) => b.turnsPerHour - a.turnsPerHour);
      const hi = ranked[0], lo = ranked.at(-1);
      add('fairness', `Rotation inégale (indice ${fr(f.jain, 2)}) : ${nameOf(hi.id)} a chanté ${fr(hi.turnsPerHour)} fois par heure, ${nameOf(lo.id)} ${fr(lo.turnsPerHour)}.${f.bonusPeople ? ` Corrigé des bonus : ${fr(f.jainAdjusted, 2)}.` : ''}`, 'warn');
    }
  }
  if (g.longestWait && g.longestWait.sec >= 60) {
    const n = g.longestWait.guestStages;
    const guest = n ? ` ; entre-temps, ${n} passage${n > 1 ? 's' : ''} sur scène comme invité d’un duo` : '';
    add('longest-wait', `Plus longue attente : ${duration(g.longestWait.sec)} (${nameOf(g.longestWait.personId)}, « ${g.longestWait.title} »${guest}).`,
      g.waitAvgSec && g.longestWait.sec > 3 * g.waitAvgSec ? 'warn' : 'info');
  }
  if (g.firstTurnAvgSec != null && g.sang >= 2) add('first-turn', `Premier passage en ${duration(g.firstTurnAvgSec)} en moyenne après la première demande du karaoké.`);
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
  // Les ajouts ne sont plus refusés à la fermeture : seuls d'anciens journaux en comptent.
  const pulled = `${g.closing.pulled} titre${g.closing.pulled > 1 ? 's' : ''} retiré${g.closing.pulled > 1 ? 's' : ''} de KaraFun`;
  const refused = g.closing.refused ? `, ${g.closing.refused} ajout${g.closing.refused > 1 ? 's' : ''} refusé${g.closing.refused > 1 ? 's' : ''}` : '';
  if (g.closing.pulled || g.closing.refused) add('closing', `Fermeture : ${pulled}${refused}.`);
  if (g.spotify.silences) add('spotify', `Spotify a comblé ${g.spotify.silences} silence${g.spotify.silences > 1 ? 's' : ''} (${duration(g.spotify.silenceSec)} au total).`);
  if (stats.evening.restarts) add('restarts', `L’application a redémarré ${stats.evening.restarts} fois (${duration(stats.evening.offlineSec)} d’arrêt).`, 'warn');
  return out;
}

// --------------------------------------------------------------- export
// Identifiants des personnes remplacés par S01, S02… (ordre d'arrivée) et
// des tables par T1, T2… Les prénoms ne sont joints qu'avec `names`.
function pseudonyms(meta, stats, events = []) {
  const people = new Map(), tables = new Map();
  const order = [...stats.singers].sort((a, b) => a.joinedAt - b.joinedAt).map(s => s.id);
  for (const id of Object.keys(meta.roster || {})) if (!order.includes(id)) order.push(id);
  // Puis toute personne nommée par une ligne sans être parmi les chanteurs
  // ni dans meta.roster (A4 : celles de la veille qu'un morceau ne crée pas),
  // dans l'ordre des lignes : aucun identifiant interne ne sort de l'export.
  // Un journal d'aujourd'hui n'en a aucune : il nomme les personnes de son
  // meta.roster.
  const keyed = new Set(order);
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    for (const id of namedIds(e)) if (!keyed.has(id)) { keyed.add(id); order.push(id); }
  }
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
  const maps = pseudonyms(meta, stats, events);
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

module.exports = { computeStats, citedIds, insights, exportEvening, jain, median, duration, CAUSES, DEFINITIONS, FORMAT };
