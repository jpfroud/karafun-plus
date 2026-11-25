'use strict';
/*
 * Journal de soirée : un fichier par soirée, en ajout seulement.
 *
 *   data/soirees/<eveningId>/journal.jsonl   un événement JSON par ligne
 *   data/soirees/<eveningId>/meta.json       début, fin, prénoms et tables ;
 *                                            à la clôture, karaoke et closedBy
 *   data/soirees/<eveningId>/summary.json    statistiques écrites à la clôture
 *
 * Les lignes ne portent que des identifiants (personne, table, titre, passage
 * KaraFun) : les prénoms vivent seulement dans meta.json. Jamais de photo, de
 * note privée, de jeton, de secret QR, de clé du bar ni de code KaraFun.
 * Écriture au mieux : une erreur de disque est signalée une fois mais
 * n'arrête jamais la file. Sans dossier (démo, tests), tout reste en mémoire.
 *
 * Seules exceptions à l'ajout seul (plan du 8 novembre, A4) : la réparation
 * d'un journal qui mêle plusieurs soirées (repair, au démarrage) et le
 * découpage en direct de la soirée ouverte (splitAt) réécrivent un journal,
 * copie d'abord. Les morceaux viennent de planSplit (evening-split.js) ; la
 * copie d'origine reste dans data/soirees-originales/<id>/<g>/ (g : la
 * génération du découpage), marquée complète par son fichier copie-complete,
 * et data/soirees/.bornage.json garde l'état de chaque soirée close vérifiée
 * (ok, split, retry, failed). Chaque fichier passe par un .tmp propre au
 * processus créé en 'wx', synchronisé, puis renommé ; ses dossiers sont
 * synchronisés (sauf sous Windows). Les morceaux s'écrivent d'abord, le
 * meta.json d'origine en dernier : son champ split marque la fin du travail,
 * et list() ne montre les morceaux d'une génération qu'une fois l'origine
 * réécrite.
 */
const crypto = require('crypto');
const path = require('path');
const { localParts, safeTimeZone, eveningBreaks, firstActivityOf, cutAllowed } = require('./evening-bounds');
// Découpage des journaux fusionnés (A4) : planSplit, le calcul pur des
// morceaux, que la réparation et le découpage en direct (repair, splitAt)
// écrivent.
const { planSplit, pieceJournal, pieceMeta, splitFingerprint, SPLIT_RULE } = require('./evening-split');

const FORMAT = 1;
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{4}_[0-9a-f]{4}$/;
const EVENT_PATTERN = /^[a-z][a-zA-Z]*(\.[a-zA-Z]+){0,3}$/;
const EARLY_LIMIT = 500;        // événements gardés avant l'ouverture
// Champs jamais écrits, même si un appelant les fournit par erreur.
const PRIVATE_KEY = /^(names?|label|labels|singer|token|tokens|secret|code|key|staffKey|photo|photoUrl|privateNote|note|access|invitation|link|cookie|url|qr|hash|password)$/i;
const MAX_STRING = 200;
const MAX_ARRAY = 60;

// --------------------------------------------------- réparation (A4)
const INDEX_FILE = '.bornage.json';
const INDEX_TEXT = 'data/soirees/.bornage.json';
const COPY_MARK = 'copie-complete';
const COPIED = ['meta.json', 'journal.jsonl', 'summary.json'];
const MAX_ATTEMPTS = 3;
// Erreurs de données (A4, « Échecs ») : failed aussitôt. Toute autre erreur
// d'un appel de fs (code sans ERR_) suit la règle des erreurs passagères :
// retry, puis failed au troisième essai.
const DATA_CODES = new Set(['BAD_JSON', 'BAD_META', 'BAD_PATH', 'EISDIR']);
// Renommage refusé un instant sous Windows (antivirus, dossier synchronisé).
const RENAME_RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_DELAYS = [10, 50, 200];
const MAX_ID_TRIES = 1000;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;
const NAME_PATTERN = /^[A-Za-z_$][\w$]{0,63}$/;
const CARRIED_BOOT = /^split-g([1-9]\d{0,8})-k([1-9]\d{0,8})$/;
const REFAIRE = '(DEPLOIEMENT-SERVEUR §18, « Refaire une réparation en échec »)';
const ENVOYER = '(DEPLOIEMENT-SERVEUR §18, « Envoyer une soirée au développeur »)';
// Dossier de l'application : les piles y donnent leurs chemins relatifs.
const APP_ROOT = path.join(__dirname);

const pad = n => String(n).padStart(2, '0');
// Date et heure locales de `at` au fuseau donné (meta.timezone, vérifié par
// safeTimeZone d'evening-bounds.js) ; sans fuseau, celui du processus. Une
// heure absente ou hors des dates que Date accepte (isTime) prend l'heure
// actuelle : jamais d'exception.
function newEveningId(at = Date.now(), random = crypto.randomBytes(2).toString('hex'), timeZone = null) {
  const d = localParts(isTime(at) ? at : Date.now(), timeZone);
  return `${d.year}-${pad(d.month)}-${pad(d.day)}_${pad(d.hour)}${pad(d.minute)}_${random}`;
}
const validId = value => typeof value === 'string' && ID_PATTERN.test(value);
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Heure que Date accepte (± 8,64e15 ms autour de 1970) : au-delà, toISOString
// et Intl lèvent.
const MAX_TIME = 8.64e15;
const isTime = value => Number.isFinite(value) && Math.abs(value) <= MAX_TIME;

// Copie sûre d'un champ : profondeur et tailles bornées, clés privées retirées.
function clean(value, depth = 0) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (depth > 3) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map(item => clean(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PRIVATE_KEY.test(k) || v === undefined || typeof v === 'function') continue;
      out[k] = clean(v, depth + 1);
    }
    return out;
  }
  return null;
}

// Lecture tolérante : une dernière ligne coupée (arrêt brutal) est ignorée.
function parseLines(text) {
  const lines = String(text || '').split('\n');
  const events = [];
  let truncated = false, corrupt = 0;
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && typeof event.ev === 'string' && Number.isFinite(event.t)) events.push(event);
      else corrupt++;
    } catch (_) {
      if (index === lines.length - 1 || (index === lines.length - 2 && !lines.at(-1))) truncated = true;
      else corrupt++;
    }
  });
  return { events, truncated, corrupt };
}

// ------------------------------------------------ pile d'une erreur
// Le chemin d'un fichier de la pile : depuis le dossier de l'application
// (lib/scheduler/duets.js), sinon son seul nom, jamais un chemin absolu, qui
// passe d'ordinaire par le dossier du compte Windows (un prénom).
function shortPath(text, root) {
  let file = text.startsWith('file://') ? text.slice(7) : text;
  if (/^\/[A-Za-z]:[\\/]/.test(file)) file = file.slice(1);
  const slashed = file.split('\\').join('/');
  let base = root.split('\\').join('/');
  while (base.endsWith('/')) base = base.slice(0, -1);
  const windows = /^[A-Za-z]:\//.test(base);
  const inside = windows ? slashed.toLowerCase().startsWith(`${base.toLowerCase()}/`) : slashed.startsWith(`${base}/`);
  if (inside) return slashed.slice(base.length + 1);
  return slashed.slice(slashed.lastIndexOf('/') + 1);
}
const isDrive = (text, i) => /[A-Za-z]/.test(text[i] || '') && text[i + 1] === ':' && (text[i + 2] === '\\' || text[i + 2] === '/');
// Début d'un chemin absolu à la position i (après « ( », une espace, ou en tête).
function pathAt(text, i) {
  if (i > 0 && text[i - 1] !== '(' && text[i - 1] !== ' ') return false;
  return text[i] === '/' || text.startsWith('file://', i) || isDrive(text, i) || text.startsWith('\\\\', i);
}
// Fin du chemin : juste avant « :ligne » (puis « :colonne »), sinon avant la
// parenthèse finale. Les espaces d'un chemin (« Léa Dupont ») y restent.
function pathEnd(text, start) {
  for (let i = start + 2; i < text.length; i++) {
    if (text[i] !== ':') continue;
    let j = i + 1;
    while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
    if (j === i + 1) continue;
    if (text[j] === ':') { let k = j + 1; while (k < text.length && text[k] >= '0' && text[k] <= '9') k++; if (k > j + 1) j = k; }
    if (j === text.length || text[j] === ')' || text[j] === ',') return i;
  }
  return text.endsWith(')') ? text.length - 1 : text.length;
}
function cleanFrame(line, root) {
  const text = line.trim();
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (pathAt(text, i)) {
      const end = pathEnd(text, i);
      out += shortPath(text.slice(i, end), root);
      i = end;
    } else out += text[i++];
  }
  return out;
}

// Pile d'une erreur pour le journal du serveur (A2, « Une seule garde » ; A4,
// « Lignes d'échec ») : { name, code, stack }, `stack` fait des cinq
// premières lignes « at … » jointes par « · », jamais une ligne du message,
// qui peut citer un prénom (erreur de l'ordonnanceur, JSON abîmé). Ne lève
// jamais.
function errorTrace(error, { root = APP_ROOT } = {}) {
  const value = error !== null && typeof error === 'object' ? error : {};
  const name = typeof value.name === 'string' && NAME_PATTERN.test(value.name) ? value.name : 'Error';
  const code = typeof value.code === 'string' && CODE_PATTERN.test(value.code) ? value.code : null;
  let frames = [];
  try {
    const stack = typeof value.stack === 'string' ? value.stack.split('\n') : [];
    const header = typeof value.message === 'string' ? value.message.split('\n').length : 1;
    frames = stack.slice(header).filter(line => line.trim().startsWith('at ')).slice(0, 5).map(line => cleanFrame(line, root));
  } catch (_) { frames = []; }
  return { name, code, stack: frames.join(' · ') };
}

// ------------------------------------------------------------ morceaux
const cutsFrom = value => (Array.isArray(value) ? value : Array.isArray(value?.cuts) ? value.cuts : []);
// Coupures d'une soirée : eveningBreaks, avec le début et le split de son
// meta (un morceau déjà découpé n'est pas recoupé avant son début).
const defaultBreaks = ({ meta, events, timeZone }) =>
  eveningBreaks({ events, timeZone, startedAt: meta?.startedAt, split: meta?.split }).cuts;
const pieceIdAt = (plan, piece, j) => newEveningId(piece.start, splitFingerprint(plan.from, piece.k, j), plan.timeZone);

// Morceaux d'une soirée, sans disque : ses coupures (breaksOf, par défaut
// eveningBreaks), puis planSplit (evening-split.js), au fuseau vérifié de
// meta.timezone, et l'identifiant de chaque morceau au premier essai (j = 1 ;
// le dernier garde l'identifiant d'origine). La réparation et splitAt font ce
// calcul ; le rejeu d'un export fusionné (test/rejeu-soiree.js --soiree) le
// reprend : ce sont les mêmes morceaux qu'au bar, et les mêmes identifiants
// tant qu'aucun n'est déjà pris sur le disque.
function splitPlan({ meta = {}, events = [], citedIds, breaksOf = defaultBreaks, generation, at, id } = {}) {
  const base = isPlain(meta) ? meta : {};
  const { zone, replaced } = safeTimeZone(base.timezone);
  const cuts = cutsFrom(breaksOf({ meta: base, events, timeZone: zone }));
  const plan = planSplit({ meta: base, events, cuts, citedIds, generation, at, id });
  const n = plan.pieces.length;
  const result = { ...plan, timeZone: zone, zoneReplaced: replaced };
  result.ids = plan.pieces.map(piece => (piece.k === n ? plan.from : pieceIdAt(result, piece, 1)));
  return result;
}

// Ouverture et fin du karaoké d'une soirée close (A5) : l'ouverture de son
// résumé (evening.openedAt), jamais avant sa première activité (A1,
// firstActivityOf : lignes reportées exclues ; dans un morceau découpé, une
// activité datée d'avant son début, heure du PC reculée, compte à ce début),
// sinon cette première activité ; la fin du karaoké de son résumé
// (evening.closedAt), sinon null. `meta` : son meta.json (startedAt, split) ;
// sans lui, la première activité telle quelle.
function karaokeOf(summary, events = [], meta = null) {
  const firstActivity = firstActivityOf({ events: Array.isArray(events) ? events : [], startedAt: meta?.startedAt, split: meta?.split });
  const opened = summary?.evening?.openedAt;
  const closed = summary?.evening?.closedAt;
  const openedAt = Number.isFinite(opened) ? (firstActivity === null ? opened : Math.max(opened, firstActivity)) : firstActivity;
  return { openedAt, closedAt: Number.isFinite(closed) ? closed : null };
}

// Ouverture d'une soirée (A5), celle du menu des statistiques et du nom de ses
// exports : meta.karaoke.openedAt ; sinon, pour une archive encore sans
// karaoke (pas encore vue par la réparation, ou notée retry ou failed),
// l'ouverture de son résumé (`summary`, summary.json) ; la soirée en cours,
// qui n'a ni l'un ni l'autre, sa première activité (`events`, karaokeOf : A1,
// lignes reportées exclues, jamais avant le début d'un morceau découpé) ;
// sinon meta.startedAt. Null si rien ne la date.
function openingOf(meta, { summary = null, events = null } = {}) {
  const karaoke = isPlain(meta?.karaoke) ? meta.karaoke.openedAt : undefined;
  if (isTime(karaoke)) return karaoke;
  const found = events ? karaokeOf(null, events, meta).openedAt : isPlain(summary?.evening) ? summary.evening.openedAt : null;
  if (isTime(found)) return found;
  return isTime(meta?.startedAt) ? meta.startedAt : null;
}

// Libellé de l'ouverture d'une soirée dans le menu des statistiques (A5) :
// « ven. 6 nov. · 20:40 ». stats.html le forme de même, à l'heure du
// navigateur, comme ses autres heures ; ici au fuseau donné (celui de la
// soirée, meta.timezone ou evening.timezone d'un export, vérifié par
// safeTimeZone), sinon celui du processus. Le rejeu d'un export fusionné
// (test/rejeu-soiree.js --soiree liste) le reprend. Null sans heure valide.
function openingLabel(t, timeZone = null) {
  if (!isTime(t)) return null;
  const zone = safeTimeZone(timeZone).zone;
  const day = new Date(t).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone });
  const time = new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: zone });
  return `${day} · ${time}`;
}

// Nom du fichier exporté d'une soirée (A5) : la date et l'heure de son
// ouverture (openingOf, la même que le menu) au fuseau de la soirée, puis la
// fin de son identifiant, comme l'identifiant lui-même :
// « soiree-2026-11-06_2040_ab12.json », « -prenoms » avec les prénoms. Sans
// ouverture lisible, la date et l'heure de l'identifiant. Le nom n'a que des
// chiffres, des tirets et des lettres de l'identifiant validé : il va tel quel
// dans l'en-tête Content-Disposition.
function exportFileName({ id, openedAt = null, timeZone = null, names = false } = {}) {
  const suffix = names ? '-prenoms' : '';
  if (!validId(id)) return `soiree${suffix}.json`;
  const d = isTime(openedAt) ? localParts(openedAt, timeZone) : null;
  const stamp = d ? `${d.year}-${pad(d.month)}-${pad(d.day)}_${pad(d.hour)}${pad(d.minute)}` : id.slice(0, 15);
  return `soiree-${stamp}_${id.slice(-4)}${suffix}.json`;
}

// meta d'un morceau clos, avec karaoke, puis closedBy et split à la fin.
function withKaraoke(meta, karaoke, closedBy = meta.closedBy) {
  const entries = Object.entries(meta).filter(([key]) => key !== 'karaoke' && key !== 'closedBy' && key !== 'split');
  entries.push(['karaoke', karaoke]);
  if (closedBy !== undefined) entries.push(['closedBy', closedBy]);
  if (meta.split !== undefined) entries.push(['split', meta.split]);
  return Object.fromEntries(entries);
}
// La soirée en cours, coupée : sa coupure et son dernier morceau archivé
// (A2, « Déjà coupée au démarrage »).
const withCut = (meta, cut, previous) => Object.fromEntries(Object.entries(meta)
  .map(([key, value]) => (key === 'split' ? [key, { ...value, cut, previous }] : [key, value])));
const withId = (meta, id) => Object.fromEntries(Object.entries(meta).map(([key, value]) => (key === 'eveningId' ? [key, id] : [key, value])));

const isClosed = loaded => Number.isFinite(loaded.meta?.endedAt) || loaded.events.some(e => e.ev === 'evening.closed');
const journalText = lines => lines.map(e => JSON.stringify(e)).join('\n') + '\n';
const metaText = meta => JSON.stringify(meta, null, 1);
const unreadableOf = loaded => (loaded.truncated ? 1 : 0) + (loaded.corrupt || 0);
// Génération et rang d'un journal qui commence par ses lignes reportées.
function carriedPart(events) {
  const first = events[0];
  if (!first || first.carried !== true || typeof first.boot !== 'string') return null;
  const match = CARRIED_BOOT.exec(first.boot);
  return match ? { generation: Number(match[1]), part: Number(match[2]) } : null;
}

function dataError(code, file) {
  return Object.assign(new Error(`${code} (${file})`), { code, repairFile: file });
}
// Fichier d'une erreur de lecture ou d'écriture de la réparation, que nomme
// la ligne d'échec d'une erreur de données (« (EISDIR, summary.json) ») ; le
// premier nommé l'emporte. Rend l'erreur.
function named(error, file) {
  try {
    if (error !== null && typeof error === 'object' && error.repairFile === undefined) error.repairFile = file;
  } catch (_) { /* erreur figée : sans fichier */ }
  return error;
}
// Champs de meta.json que la réparation lit (A4, « Échecs », BAD_META), puis
// la génération, d'où viennent les chemins (BAD_PATH). startedAt et endedAt
// sont des heures que Date accepte : sinon la trace, écrite après les
// fichiers, ne pourrait pas les dire.
function checkMeta(meta) {
  const bad = () => dataError('BAD_META', 'meta.json');
  const optional = (value, test) => value === undefined || value === null || test(value);
  const isText = value => typeof value === 'string';
  if (!isPlain(meta)) throw bad();
  if (!optional(meta.startedAt, isTime) || !optional(meta.endedAt, isTime)) throw bad();
  for (const key of ['roster', 'tables']) {
    if (meta[key] !== undefined && !(isPlain(meta[key]) && Object.values(meta[key]).every(isPlain))) throw bad();
  }
  if (!optional(meta.timezone, isText) || !optional(meta.eveningId, isText) || !optional(meta.closedBy, isText)) throw bad();
  if (!optional(meta.karaoke, isPlain) || !optional(meta.split, isPlain)) throw bad();
  if (meta.split != null && !(Number.isInteger(meta.split.generation) && meta.split.generation >= 1)) throw dataError('BAD_PATH', 'meta.json');
}

// Sorte d'un échec (A4, « Échecs ») : données (failed aussitôt), exception du
// calcul (failed, EXCEPTION), ou erreur de fichier (retry, puis failed).
function failureOf(error, step) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const file = typeof error?.repairFile === 'string' ? error.repairFile : null;
  if (code && DATA_CODES.has(code)) return { step, code, kind: 'data', file: file || 'meta.json' };
  if (!code || code.startsWith('ERR_') || !CODE_PATTERN.test(code)) return { step, code: 'EXCEPTION', kind: 'exception', file };
  return { step, code, kind: 'transient', file };
}
// Ligne d'échec (A4, « Lignes d'échec ») ; les renommages refaits avant
// l'échec (« Ordre d'écriture »), s'il y en a, dans sa parenthèse, avant ce
// qu'il faut faire.
function failureLine(id, failure, attempts, status, trace, renames = 0) {
  const head = `Réparation : ${id} en échec à l'étape « ${failure.step} »`;
  const retried = renamesText(renames);
  if (failure.kind === 'exception') {
    return `${head} (EXCEPTION, ${trace.name}${retried}) : notée failed, refaite à la prochaine version. Envoie cette ligne et la suivante au développeur ${ENVOYER}.`;
  }
  if (failure.kind === 'data') {
    return `${head} (${failure.code}, ${failure.file}${retried}) : notée failed, ses fichiers restent tels quels. Répare ou remets le fichier, puis refais-la ${REFAIRE}.`;
  }
  if (status === 'retry') return `${head} (${failure.code}, essai ${attempts} sur ${MAX_ATTEMPTS}${retried}) : reprise au prochain démarrage.`;
  const todo = failure.code === 'ENOSPC' ? 'Libère le disque' : 'Vérifie le disque et le dossier data (droits, antivirus, dossier synchronisé)';
  return `${head} (${failure.code}, essai ${attempts} sur ${MAX_ATTEMPTS}${retried}) : notée failed. ${todo}, puis refais-la ${REFAIRE}.`;
}
// Ligne d'échec de la lecture du démarrage, avant de savoir la soirée de la
// sauvegarde ouverte, quand son entrée de l'index (`kept` : ok, split ou
// failed de cette version) est gardée : rien n'est noté, aucun essai compté.
// Ouverte, la soirée est revue au démarrage suivant (A4, « Index ») ; close,
// son entrée dit déjà ce qu'il en est. Notée failed, une erreur de données
// dit aussi de la refaire, comme failureLine pour une soirée notée failed.
function keptLine(id, failure, kept, trace, renames = 0) {
  const head = `Réparation : ${id} en échec à l'étape « ${failure.step} »`;
  const retried = renamesText(renames);
  const entry = `entrée ${kept} de l'index gardée`;
  if (failure.kind === 'exception') return `${head} (EXCEPTION, ${trace.name}${retried}) : ${entry}. Envoie cette ligne et la suivante au développeur ${ENVOYER}.`;
  if (failure.kind === 'data') {
    return `${head} (${failure.code}, ${failure.file}${retried}) : ${entry}, ses fichiers restent tels quels. ` +
      `Répare ou remets le fichier${kept === 'failed' ? `, puis refais-la ${REFAIRE}` : ''}.`;
  }
  return `${head} (${failure.code}${retried}) : ${entry} ; reprise au prochain démarrage si elle est encore en cours.`;
}
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
// Lignes illisibles laissées à la copie ; null : copie illisible (meta.json
// fini sans recouper).
const unreadableText = n => (n === null ? 'copie illisible, lignes illisibles non comptées'
  : n ? plural(n, 'ligne illisible laissée à la copie', 'lignes illisibles laissées à la copie') : 'aucune ligne illisible');
const renamesText = n => (n ? ` ; ${plural(n, 'renommage refait', 'renommages refaits')}` : '');
// Heure de la trace ; « ? » pour une heure absente ou que Date refuse (un
// morceau déjà écrit n'est pas relu par checkMeta) : la trace ne lève jamais.
const iso = t => (isTime(t) ? new Date(t).toISOString() : '?');
const timeOrNull = t => (Number.isFinite(t) ? t : null);
// Morceau dans la ligne « Réparation : » d'une soirée découpée (A4, « Trace
// et contraintes ») : identifiant, début et fin, nombre de lignes (null :
// journal illisible).
const pieceText = p => `${p.id} (${iso(p.start)} → ${p.end === null ? 'en cours' : iso(p.end)}, ` +
  `${p.lines === null ? 'journal illisible' : plural(p.lines, 'ligne', 'lignes')})`;
// Rangs a à b (a ≤ b) sans morceau trouvé, dans la ligne d'un meta.json fini
// sans recouper : une plage, jamais un rang à la fois.
const missingText = (a, b) => (a === b ? `morceau ${a} introuvable` : `morceaux ${a} ${b === a + 1 ? 'et' : 'à'} ${b} introuvables`);
// Lignes du morceau k de la génération g tel qu'il est écrit : les siennes,
// sans ses lignes reportées ni sa clôture, qui ont le boot split-g<g>-k<k>,
// et ses lignes reportées.
function pieceCounts(events, generation, k) {
  const boot = `split-g${generation}-k${k}`;
  let lines = 0, carried = 0;
  for (const e of events) {
    if (e.boot !== boot) lines++;
    else if (e.carried === true) carried++;
  }
  return { lines, carried };
}
const codeText = error => (typeof error?.code === 'string' && CODE_PATTERN.test(error.code) ? error.code : 'EXCEPTION');

// Index data/soirees/.bornage.json : { rule, checked: { <id>: 'ok' | 'split' |
// { status, attempts, code, version } } }, lu dans une Map ; null s'il est mal
// formé.
function indexEntries(data) {
  if (!isPlain(data) || typeof data.rule !== 'string' || !isPlain(data.checked)) return null;
  const entries = new Map();
  for (const [id, entry] of Object.entries(data.checked)) {
    if (!validId(id)) return null;
    if (entry === 'ok' || entry === 'split') { entries.set(id, entry); continue; }
    if (!isPlain(entry) || (entry.status !== 'retry' && entry.status !== 'failed') || !Number.isInteger(entry.attempts) ||
      entry.attempts < 1 || typeof entry.code !== 'string' || !(entry.version == null || typeof entry.version === 'string')) return null;
    entries.set(id, { status: entry.status, attempts: entry.attempts, code: entry.code, version: entry.version ?? null });
  }
  return { rule: data.rule, entries };
}
// Soirée close laissée telle quelle tant que l'index ne se lit pas (erreur
// passagère) : rien n'est écrit, et la passe ne lit pas son dossier ;
// 'skipped', avec le code de l'erreur et step 'index'.
const waitIndex = (result, index) => ({ ...result, code: index.problem, step: 'index' });

// Attente bloquante (renommage refait sous Windows).
const defaultSleep = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

class EveningJournal {
  // `dir` : dossier des soirées (data/soirees), null pour garder en mémoire.
  // `fs` : module de fichiers injecté (disque en mémoire des tests).
  // `platform` et `sleep` : système et attente des renommages refaits (A4).
  // `originals` : copie des soirées découpées (data/soirees-originales).
  // `repairEnabled` : faux avec KARAOKE_REPAIR (server.js) : ni repair ni
  // splitAt ne réécrivent rien. `citedIds` (evening-stats.js) : par défaut
  // pour repair et splitAt.
  constructor({ dir = null, fs = require('fs'), now = Date.now, app = null, boot = null, onError = null,
    platform = process.platform, sleep = defaultSleep, originals = null, repairEnabled = true, citedIds = null } = {}) {
    this.dir = dir;
    this.fs = fs;
    this.now = now;
    this.app = app;
    this.boot = boot || crypto.randomBytes(4).toString('hex');
    this.onError = onError;
    this.platform = platform;
    this.sleep = sleep;
    this.originals = originals || (dir ? path.join(path.dirname(dir), 'soirees-originales') : null);
    this.repairEnabled = repairEnabled !== false;
    this.citedIds = citedIds;
    this.current = null;      // { id, meta, events, seq }
    this.memory = new Map();  // soirées closes sans disque : id → { meta, events, summary }
    this.early = [];
    this.lastError = null;
    this._openings = new Map(); // archive sans karaoke → { text, summary } (_summaryOf)
    this._indexLogged = false;
    this._indexReadLogged = false;
    this._indexWriteLogged = false;
  }

  get id() { return this.current?.id || null; }
  get startedAt() { return this.current?.meta.startedAt || null; }

  _folder(id) { return path.join(this.dir, id); }

  _fail(error) {
    const first = !this.lastError;
    this.lastError = error.message;
    if (first && this.onError) {
      try { this.onError(error); } catch (_) { /* le signalement ne doit rien casser */ }
    }
  }

  _writeMeta() {
    const cur = this.current;
    if (!cur || !this.dir) return;
    try {
      this.fs.mkdirSync(this._folder(cur.id), { recursive: true });
      const target = path.join(this._folder(cur.id), 'meta.json');
      this.fs.writeFileSync(`${target}.tmp`, JSON.stringify(this._diskMeta(cur), null, 1));
      this.fs.renameSync(`${target}.tmp`, target);
    } catch (error) { this._fail(error); }
  }

  // meta écrit sur le disque. Après un découpage en direct en échec avant la
  // réécriture du journal du dossier (A2, « Erreur d'écriture ») : le meta
  // d'avant la coupure (son début, ses prénoms et ses tables, sans split),
  // avec les prénoms et les tables nouveaux et, à la clôture, endedAt.
  _diskMeta(cur) {
    const before = cur.diskMeta;
    if (!before) return cur.meta;
    return { ...before, endedAt: Number.isFinite(cur.meta.endedAt) ? cur.meta.endedAt : (before.endedAt ?? null),
      roster: { ...(isPlain(before.roster) ? before.roster : {}), ...cur.meta.roster },
      tables: { ...(isPlain(before.tables) ? before.tables : {}), ...cur.meta.tables } };
  }

  // Ouvre la soirée enregistrée dans l'instantané (redémarrage), sinon une
  // nouvelle. Rend true si la soirée précédente a été reprise. Une soirée
  // déjà close n'est jamais rouverte : la clôture et l'instantané qui cite la
  // soirée suivante sont deux écritures distinctes, et un arrêt entre les deux
  // laisse un instantané qui pointe encore vers l'archive.
  open({ resume = null, rules = null } = {}) {
    const now = this.now();
    if (resume && validId(resume.id)) {
      const saved = this.read(resume.id);
      const closed = saved && (Number.isFinite(saved.meta?.endedAt) || saved.events.some(e => e.ev === 'evening.closed'));
      if (saved && !closed) {
        const last = saved.events.at(-1);
        this.current = { id: resume.id, meta: saved.meta, events: saved.events,
          seq: saved.events.reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0) };
        delete this.current.meta.endedAt;
        this._endCutLine(resume.id);
        this._flushEarly();
        this.append('app.started', { restored: true, offlineMs: last ? Math.max(0, now - last.t) : 0,
          version: this.app?.version || null, truncated: saved.truncated || undefined });
        return true;
      }
    }
    this.start({ rules });
    return false;
  }

  // Nouvelle soirée, sans fermer la précédente (voir close).
  start({ rules = null } = {}) {
    const now = this.now();
    let id = newEveningId(now);
    while (this.memory.has(id) || (this.dir && this._exists(id))) id = newEveningId(now);
    this.current = { id, events: [], seq: 0, meta: { format: 'karaoke-evening-meta', version: FORMAT,
      eveningId: id, startedAt: now, endedAt: null,
      app: this.app ? { version: this.app.version || null, commit: this.app.commit || null } : null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null, roster: {}, tables: {} } };
    this._writeMeta();
    this.append('evening.started', { rules });
    this._flushEarly();
    this.append('app.started', { restored: false, offlineMs: 0, version: this.app?.version || null });
    return id;
  }

  // Arrêt brutal pendant une écriture : la ligne coupée est terminée, pour
  // que la reprise commence sur une nouvelle ligne. Collée à la ligne coupée,
  // elle serait illisible à la relecture (redémarrage et arrêt perdus).
  _endCutLine(id) {
    if (!this.dir) return;
    try {
      const file = path.join(this._folder(id), 'journal.jsonl');
      if (!this.fs.existsSync(file)) return;
      const text = this.fs.readFileSync(file, 'utf8');
      if (text && !text.endsWith('\n')) this.fs.appendFileSync(file, '\n');
    } catch (error) { this._fail(error); }
  }

  _exists(id) {
    try { return this.fs.existsSync(this._folder(id)); } catch (_) { return false; }
  }

  _flushEarly() {
    const early = this.early;
    this.early = [];
    for (const [ev, fields, t] of early) this.append(ev, fields, t);
  }

  // Ajoute un événement. Ne lève jamais d'erreur.
  append(ev, fields = {}, at = null) {
    try {
      if (typeof ev !== 'string' || !EVENT_PATTERN.test(ev)) return null;
      const t = Number.isFinite(at) ? at : this.now();
      if (!this.current) {
        if (this.early.length < EARLY_LIMIT) this.early.push([ev, fields, t]);
        return null;
      }
      const cur = this.current;
      const event = { ...clean(fields && typeof fields === 'object' ? fields : {}), v: FORMAT, seq: ++cur.seq, t, ev, boot: this.boot };
      cur.events.push(event);
      if (this.dir) {
        try {
          this.fs.mkdirSync(this._folder(cur.id), { recursive: true });
          this.fs.appendFileSync(path.join(this._folder(cur.id), 'journal.jsonl'), JSON.stringify(event) + '\n');
          if (this.lastError) this.lastError = null;
        } catch (error) { this._fail(error); }
      }
      return event;
    } catch (_) { return null; }
  }

  // Prénom et table d'une personne, gardés hors des lignes du journal.
  person(personId, { name, tableId } = {}) {
    const cur = this.current;
    if (!cur || !personId) return;
    const row = { name: String(name || '').slice(0, 40), tableId: tableId == null ? null : String(tableId) };
    const before = cur.meta.roster[personId];
    if (before && before.name === row.name && before.tableId === row.tableId) return;
    cur.meta.roster[personId] = row;
    this._writeMeta();
  }

  table(tableId, { name, individual } = {}) {
    const cur = this.current;
    if (!cur || tableId == null) return;
    const row = { name: String(name || '').slice(0, 40), individual: !!individual };
    const before = cur.meta.tables[tableId];
    if (before && before.name === row.name && before.individual === row.individual) return;
    cur.meta.tables[tableId] = row;
    this._writeMeta();
  }

  // Clôture : événement final, résumé et heure de fin. La soirée suivante
  // s'ouvre avec start(). `by` : 'staff-reset' pour « Supprimer toutes les
  // tables », 'auto' pour la remise à zéro du matin (A2). Une fin automatique
  // donne aussi `reason` ('morning') et `at`, son point de clôture C : la
  // ligne evening.closed, datée de l'heure réelle de la remise à zéro, porte
  // alors reason et closedAt = C, et meta.endedAt vaut C, jamais l'heure de la
  // remise à zéro. meta.json reçoit aussi karaoke { openedAt, closedAt }
  // (karaokeOf du résumé) et closedBy (A5). Après un découpage en direct en
  // échec, la soirée close reste aussi en mémoire, coupée, jusqu'à la
  // réparation du démarrage suivant (A2, « Erreur d'écriture »).
  close({ by = 'staff-reset', reason = null, at = null, fields = {}, summarize = null } = {}) {
    const cur = this.current;
    if (!cur) return null;
    const timed = isTime(at);
    this.append('evening.closed', { ...fields, by, ...(reason ? { reason } : {}), ...(timed ? { closedAt: at } : {}) });
    cur.meta.endedAt = timed ? at : this.now();
    cur.meta.closedBy = by;
    let summary = null;
    try { summary = summarize ? summarize({ meta: cur.meta, events: cur.events }) : null; }
    catch (error) { this._fail(error); }
    cur.meta = withKaraoke(cur.meta, karaokeOf(summary, cur.events, cur.meta), by);
    if (this.dir) {
      this._writeMeta();
      if (summary && !cur.diskMeta) {
        try {
          const target = path.join(this._folder(cur.id), 'summary.json');
          this.fs.writeFileSync(`${target}.tmp`, JSON.stringify(summary));
          this.fs.renameSync(`${target}.tmp`, target);
        } catch (error) { this._fail(error); }
      }
      if (cur.diskMeta) this.memory.set(cur.id, { meta: cur.meta, events: cur.events, summary });
    } else this.memory.set(cur.id, { meta: cur.meta, events: cur.events, summary });
    this.current = null;
    return { id: cur.id, summary };
  }

  // État de l'instantané de soirée : l'identifiant suffit pour reprendre.
  snapshot() {
    return this.current ? { id: this.current.id, startedAt: this.current.meta.startedAt } : null;
  }

  // Fichiers d'une soirée du disque (A4, « Index ») : meta.json et
  // journal.jsonl (par parseLines), lus d'un dossier ; null sans meta.json, un
  // journal absent lu comme vide. Lève toute autre erreur avec son code :
  // celui de Node (EISDIR pour un dossier à la place du fichier…), ou
  // BAD_JSON. `raw` garde les octets lus (copie par génération).
  _loadFrom(folder) {
    const metaFile = path.join(folder, 'meta.json');
    if (!this.fs.existsSync(metaFile)) return null;
    const read = (file, name) => {
      try { return this.fs.readFileSync(file); } catch (error) { throw named(error, name); }
    };
    const rawMeta = read(metaFile, 'meta.json');
    let meta;
    try { meta = JSON.parse(String(rawMeta)); } catch (_) { throw dataError('BAD_JSON', 'meta.json'); }
    const file = path.join(folder, 'journal.jsonl');
    const rawJournal = this.fs.existsSync(file) ? read(file, 'journal.jsonl') : null;
    const parsed = rawJournal === null ? { events: [], truncated: false, corrupt: 0 } : parseLines(String(rawJournal));
    return { meta, ...parsed, raw: { 'meta.json': rawMeta, 'journal.jsonl': rawJournal } };
  }

  // Soirée archivée `id` du disque : voir _loadFrom. Le contrôle des champs
  // (BAD_META) reste à la réparation : read() rend une archive dont un champ
  // est mal formé, comme avant.
  _load(id) {
    if (!this.dir || !validId(id)) throw dataError('BAD_PATH', 'identifiant');
    return this._loadFrom(this._folder(id));
  }

  // Soirée en cours ou archivée : { meta, events, truncated, corrupt, current }.
  read(id) {
    if (this.current && id === this.current.id) {
      return { meta: this.current.meta, events: this.current.events.slice(), truncated: false, corrupt: 0, current: true };
    }
    if (!validId(id)) return null;
    const kept = this.memory.get(id);
    if (kept) return { meta: kept.meta, events: kept.events.slice(), truncated: false, corrupt: 0, current: false, summary: kept.summary };
    if (!this.dir) return null;
    try {
      const loaded = this._load(id);
      if (!loaded) return null;
      return { meta: loaded.meta, events: loaded.events, truncated: loaded.truncated, corrupt: loaded.corrupt, current: false };
    } catch (_) { return null; }
  }

  // Génération du découpage d'une soirée d'origine : la soirée en cours, en
  // mémoire, ou son dossier (`metas`, déjà lus, sinon lu ici) ; null si elle
  // n'existe plus.
  _originGeneration(from, metas = null) {
    let meta;
    if (this.current?.id === from) meta = this.current.meta;
    else if (this.memory.has(from)) meta = this.memory.get(from).meta;
    else if (metas) meta = metas.get(from);
    else {
      try {
        const file = path.join(this._folder(from), 'meta.json');
        meta = this.fs.existsSync(file) ? JSON.parse(String(this.fs.readFileSync(file, 'utf8'))) : undefined;
      } catch (_) { meta = undefined; }
    }
    if (meta === undefined) return null;
    return Number.isInteger(meta?.split?.generation) ? meta.split.generation : 0;
  }

  // Morceau d'une réparation inachevée (A4, « Ordre d'écriture ») : son
  // origine existe et n'a pas encore sa génération.
  _pendingPiece(id, meta, metas = null) {
    const split = meta?.split;
    if (!isPlain(split) || !validId(split.from) || split.from === id || !Number.isInteger(split.generation)) return false;
    const origin = this._originGeneration(split.from, metas);
    return origin !== null && origin < split.generation;
  }

  // Résumé d'une archive pour son ouverture (A5) : lu seulement si son meta
  // n'a pas encore de karaoke ; null s'il manque ou ne se lit pas. Seule son
  // ouverture (evening.openedAt) est rendue, et gardée pour ce processus
  // d'après le texte de son meta.json (`text`), qui change quand la
  // réparation y ajoute karaoke : chaque summary.json n'est lu et analysé
  // qu'une fois, même quand la passe des soirées closes ne tourne pas
  // (KARAOKE_REPAIR) ou laisse l'archive en retry ou failed. Une lecture en
  // échec passager n'est pas gardée ; repair oublie celle de la soirée qu'il
  // revoit, dont il peut réécrire summary.json.
  _summaryOf(id, meta, text = null) {
    if (isPlain(meta?.karaoke)) return null;
    const kept = this._openings.get(id);
    if (kept && typeof text === 'string' && kept.text === text) return kept.summary;
    const file = path.join(this._folder(id), 'summary.json');
    let raw = null;
    try { if (this.fs.existsSync(file)) raw = String(this.fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
    let summary = null;
    if (raw !== null) {
      try {
        const data = JSON.parse(raw);
        summary = isPlain(data?.evening) ? { evening: { openedAt: data.evening.openedAt } } : null;
      } catch (_) { summary = null; }
    }
    if (typeof text === 'string') this._openings.set(id, { text, summary });
    return summary;
  }

  // Soirées connues, la plus récente d'abord (par ouverture, A5). Chaque
  // ligne donne son ouverture (`openedAt`, openingOf : celle du menu des
  // statistiques), l'état de sa réparation dans data/soirees/.bornage.json
  // (`repair` : 'ok', 'split', 'retry', 'failed', ou null hors de l'index)
  // et si elle est découpée (`split` : meta.split). summary.json n'est lu que
  // pour une archive encore sans karaoke, une fois par processus
  // (_summaryOf) : après la passe des soirées closes, aucun. Les morceaux
  // d'une génération n'y sont qu'une fois l'origine
  // réécrite (son dossier, ou la soirée en cours en mémoire) : une réparation
  // inachevée ne compte jamais une soirée deux fois.
  list() {
    const rows = [];
    const seen = new Set();
    let index = new Map();
    try { if (this.dir) index = this._readIndex(null).checked; } catch (_) { /* index illisible : aucune marque */ }
    const add = (id, meta, extra = {}, sources = {}) => {
      if (seen.has(id)) return;
      seen.add(id);
      const entry = index.get(id);
      rows.push({ id, startedAt: meta?.startedAt || null, endedAt: meta?.endedAt || null, openedAt: openingOf(meta, sources),
        people: Object.keys(meta?.roster || {}).length, current: id === this.id, split: isPlain(meta?.split),
        repair: entry === undefined ? null : isPlain(entry) ? entry.status : entry, ...extra });
    };
    if (this.current) add(this.current.id, this.current.meta, { events: this.current.events.length }, { events: this.current.events });
    for (const [id, kept] of this.memory) add(id, kept.meta, { events: kept.events.length }, { summary: kept.summary });
    if (this.dir) {
      let names = [];
      try { names = this.fs.readdirSync(this.dir); } catch (_) { names = []; }
      const metas = new Map(), texts = new Map();
      for (const id of names) {
        if (!validId(id) || seen.has(id)) continue;
        try {
          const text = String(this.fs.readFileSync(path.join(this._folder(id), 'meta.json'), 'utf8'));
          metas.set(id, JSON.parse(text));
          texts.set(id, text);
        } catch (_) { /* dossier incomplet : ignoré */ }
      }
      for (const [id, meta] of metas) {
        if (!this._pendingPiece(id, meta, metas)) add(id, meta, {}, { summary: this._summaryOf(id, meta, texts.get(id)) });
      }
    }
    return rows.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
  }

  // Ouverture d'une soirée (A5) : celle de sa ligne de list(), pour le nom de
  // ses exports. Null pour une soirée inconnue ; ne lève jamais.
  openedAt(id) {
    try {
      if (this.current && id === this.current.id) return openingOf(this.current.meta, { events: this.current.events });
      if (!validId(id)) return null;
      const kept = this.memory.get(id);
      if (kept) return openingOf(kept.meta, { summary: kept.summary });
      if (!this.dir) return null;
      const file = path.join(this._folder(id), 'meta.json');
      if (!this.fs.existsSync(file)) return null;
      const text = String(this.fs.readFileSync(file, 'utf8'));
      const meta = JSON.parse(text);
      return openingOf(meta, { summary: this._summaryOf(id, meta, text) });
    } catch (_) { return null; }
  }

  // ------------------------------------------------------ écritures (A4)
  _version() { return typeof this.app?.version === 'string' ? this.app.version : null; }

  _syncDir(dir) {
    if (this.platform === 'win32') return;
    const fd = this.fs.openSync(dir, 'r');
    try { this.fs.fsyncSync(fd); } finally { this.fs.closeSync(fd); }
  }

  // Dossier créé au besoin ; chaque dossier créé est synchronisé dans son
  // parent (hors Windows).
  _mkdirs(dir) {
    const created = this.fs.mkdirSync(dir, { recursive: true });
    if (typeof created !== 'string' || this.platform === 'win32') return;
    const fresh = [];
    for (let d = dir; ; d = path.dirname(d)) {
      fresh.unshift(d);
      if (d === created || path.dirname(d) === d) break;
    }
    for (const d of fresh) this._syncDir(path.dirname(d));
  }

  // Renommage refait sous Windows, après 10, 50 puis 200 ms.
  _rename(from, to, stats) {
    const delays = this.platform === 'win32' ? RENAME_DELAYS : [];
    for (let attempt = 0; ; attempt++) {
      try { this.fs.renameSync(from, to); return; } catch (error) {
        if (attempt >= delays.length || !RENAME_RETRY.has(error?.code)) throw error;
        this.sleep(delays[attempt]);
        if (stats) stats.renames++;
      }
    }
  }

  // Fichier écrit comme NightStateStore.save : .tmp propre au processus créé
  // en 'wx', écrit par son descripteur, synchronisé, renommé, puis dossier
  // synchronisé (hors Windows).
  _writeFile(file, data, stats) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let fd = null;
    try {
      fd = this.fs.openSync(tmp, 'wx');
      this.fs.writeFileSync(fd, data);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = null;
      this._rename(tmp, file, stats);
    } catch (error) {
      if (fd !== null) { try { this.fs.closeSync(fd); } catch (_) { /* déjà fermé */ } }
      try { this.fs.unlinkSync(tmp); } catch (_) { /* jamais créé, ou déjà renommé */ }
      throw named(error, path.basename(file));
    }
    this._syncDir(path.dirname(file));
  }

  _unlink(file) {
    if (!this.fs.existsSync(file)) return false;
    try { this.fs.unlinkSync(file); } catch (error) { throw named(error, path.basename(file)); }
    this._syncDir(path.dirname(file));
    return true;
  }

  // Index : lu à chaque réparation. Illisible (JSON abîmé, dossier à la
  // place du fichier) ou mal formé : lu comme vide, puis réécrit (une ligne,
  // une fois). Toute autre erreur de lecture (EBUSY d'un antivirus, EIO…)
  // est passagère (A4, « Échecs ») : `unread`, l'index n'est jamais réécrit
  // par cette lecture, et une soirée close attend qu'il se lise (une ligne,
  // une fois) ; une soirée remise à l'original n'est donc jamais recoupée
  // pour un verrou d'un instant. Une entrée failed d'une autre règle est
  // retirée (refaite, ses essais repartent de 1) : l'index réécrit, toujours
  // à la règle en cours, ne la garde jamais comme un échec de cette règle.
  _readIndex(say) {
    const index = { checked: new Map(), problem: null, unread: false, dirty: false };
    const file = path.join(this.dir, INDEX_FILE);
    let text = null;
    try { if (this.fs.existsSync(file)) text = String(this.fs.readFileSync(file, 'utf8')); }
    catch (error) { index.problem = codeText(error); index.unread = index.problem !== 'EISDIR'; }
    if (text !== null) {
      let data;
      try { data = JSON.parse(text); } catch (_) { index.problem = 'BAD_JSON'; }
      if (!index.problem) {
        const parsed = indexEntries(data);
        if (!parsed) index.problem = 'BAD_META';
        else {
          index.checked = parsed.entries;
          if (parsed.rule !== SPLIT_RULE) {
            for (const [id, entry] of [...index.checked]) {
              if (isPlain(entry) && entry.status === 'failed') { index.checked.delete(id); index.dirty = true; }
            }
          }
        }
      }
    }
    if (index.unread) {
      if (say && !this._indexReadLogged) {
        this._indexReadLogged = true;
        say(`Réparation : index ${INDEX_TEXT} impossible à lire (${index.problem}) : laissé tel quel, aucune soirée close n'est revue sans lui (reprise au prochain démarrage). Si cette ligne revient à chaque démarrage, vérifie le disque et le dossier data (droits, antivirus, dossier synchronisé).`);
      }
    } else if (index.problem) {
      index.dirty = true;
      if (say && !this._indexLogged) {
        this._indexLogged = true;
        say(`Réparation : index ${INDEX_TEXT} illisible (${index.problem}) : lu comme vide, les soirées closes sont revues. Une soirée remise à l'original (DEPLOIEMENT-SERVEUR §18, « Revenir à l'original d'une soirée découpée ») peut être recoupée : refais son retour à l'original, entrée 'ok' comprise.`);
      }
    }
    return index;
  }

  // Index réécrit (.tmp puis renommage) s'il a changé, jamais après une
  // lecture en échec passager ; lève l'erreur.
  _saveIndex(index, stats) {
    if (!index.dirty || index.unread) return;
    const checked = Object.fromEntries([...index.checked].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    this._writeFile(path.join(this.dir, INDEX_FILE), JSON.stringify({ rule: SPLIT_RULE, checked }) + '\n', stats);
    index.dirty = false;
  }

  // Index réécrit au mieux : impossible à écrire, une ligne, rien n'est
  // bloqué, et la vérification est refaite au démarrage suivant.
  _writeIndex(index, say, stats) {
    try { this._saveIndex(index, stats); } catch (error) {
      if (say && !this._indexWriteLogged) {
        this._indexWriteLogged = true;
        say(`Réparation : index ${INDEX_TEXT} impossible à écrire (${codeText(error)}) : rien n'est bloqué, la vérification est refaite au prochain démarrage.`);
      }
    }
  }

  _note(index, id, entry) {
    const before = index.checked.get(id);
    if (entry === null) { if (index.checked.delete(id)) index.dirty = true; return; }
    if (JSON.stringify(before) !== JSON.stringify(entry)) { index.checked.set(id, entry); index.dirty = true; }
  }

  // Entrée de l'index qui dispense de revoir une soirée close : ok, split, ou
  // failed à cette version (celles d'une autre règle sont retirées à la
  // lecture, _readIndex).
  _indexDone(entry) {
    if (entry === 'ok' || entry === 'split') return true;
    return isPlain(entry) && entry.status === 'failed' && entry.version === this._version();
  }

  // Soirées closes à revoir (passe des soirées closes de server.js) : les
  // dossiers de data/soirees à l'identifiant valide, hors soirée ouverte, sans
  // celles que l'index dit vérifiées ; dans l'ordre des identifiants. Un index
  // impossible à lire pour l'instant n'en retire aucune : repair le relit pour
  // chacune. Lève l'erreur de la liste du dossier (readdirSync), qu'un dossier
  // absent excepté.
  repairQueue() {
    if (!this.dir || !this.repairEnabled) return [];
    let names;
    try { names = this.fs.readdirSync(this.dir); } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const index = this._readIndex(null);
    return names.filter(id => validId(id) && id !== this.id && !this._indexDone(index.checked.get(id))).sort();
  }

  // État d'un dossier candidat pour le morceau k : libre (ni meta.json ni
  // journal.jsonl), le nôtre (réparation interrompue : même origine, même
  // rang, même génération), ou pris.
  _folderState(id, from, k, generation) {
    const folder = this._folder(id);
    const metaFile = path.join(folder, 'meta.json');
    if (!this.fs.existsSync(metaFile)) return this.fs.existsSync(path.join(folder, 'journal.jsonl')) ? 'taken' : 'free';
    let text;
    try { text = this.fs.readFileSync(metaFile, 'utf8'); } catch (error) {
      if (error?.code === 'EISDIR') return 'taken';
      throw error;
    }
    let meta = null;
    try { meta = JSON.parse(String(text)); } catch (_) { return 'taken'; }
    const split = meta?.split;
    return isPlain(split) && split.from === from && split.part === k && split.generation === generation ? 'ours' : 'taken';
  }

  // Identifiant du morceau k (k < n) : newEveningId(début, empreinte(origine,
  // k, j)), j = 1, 2… jusqu'au premier libre ou au nôtre (A4, « Identifiants »).
  // Un dossier candidat qui ne se lit pas lève son erreur ; avec
  // `skipUnreadable`, il est passé comme un dossier pris.
  _pieceId(plan, piece, taken, { skipUnreadable = false } = {}) {
    for (let j = 1; j <= MAX_ID_TRIES; j++) {
      const id = pieceIdAt(plan, piece, j);
      if (!validId(id)) throw dataError('BAD_PATH', 'identifiant');
      if (taken.has(id) || id === plan.from || id === this.current?.id || this.memory.has(id)) continue;
      if (!this.dir) return id;
      let state;
      try { state = this._folderState(id, plan.from, piece.k, plan.generation); } catch (error) {
        if (skipUnreadable) continue;
        throw error;
      }
      if (state !== 'taken') return id;
    }
    throw dataError('BAD_PATH', 'identifiant');
  }

  // Morceau écrit dans data/soirees/<id>/ : meta.json d'abord.
  _writePiece(id, { meta, lines, summary }, stats) {
    const folder = this._folder(id);
    this._mkdirs(folder);
    this._writeFile(path.join(folder, 'meta.json'), metaText(meta), stats);
    this._writeFile(path.join(folder, 'journal.jsonl'), journalText(lines), stats);
    if (summary) this._writeFile(path.join(folder, 'summary.json'), JSON.stringify(summary), stats);
    else this._unlink(path.join(folder, 'summary.json'));
  }

  // Copie de la génération g : les fichiers du dossier tels quels, octet pour
  // octet, puis copie-complete en dernier. Une copie de même génération
  // laissée par un découpage qui n'a pas servi est remplacée (le dossier en
  // a toutes les lignes) : son copie-complete part d'abord.
  _copyOriginal(id, generation, raw, stats) {
    const dir = path.join(this.originals, id, String(generation));
    this._mkdirs(dir);
    this._unlink(path.join(dir, COPY_MARK));
    for (const name of COPIED) {
      if (raw[name] !== null && raw[name] !== undefined) this._writeFile(path.join(dir, name), raw[name], stats);
      else this._unlink(path.join(dir, name));
    }
    this._writeFile(path.join(dir, COPY_MARK), JSON.stringify({ generation, files: COPIED.filter(name => raw[name] != null) }) + '\n', stats);
  }

  _readRaw(file) {
    if (!this.fs.existsSync(file)) return null;
    try { return this.fs.readFileSync(file); } catch (error) { throw named(error, path.basename(file)); }
  }

  // Copie de la génération g qui sert de point de reprise : copie-complete
  // présent, ses fichiers lisibles et bien formés, et chaque ligne non
  // reportée du journal du dossier (même boot, même seq) dans la copie. Sinon
  // null : une copie abîmée (JSON illisible, dossier à la place d'un fichier,
  // champ mal formé) ne fait jamais échouer la soirée, le découpage repart du
  // dossier. Une erreur passagère de sa lecture suit « Échecs » (retry).
  _usableCopy(id, generation, loaded) {
    const dir = path.join(this.originals, id, String(generation));
    if (!this.fs.existsSync(path.join(dir, COPY_MARK))) return null;
    let copy;
    try { copy = this._loadFrom(dir); } catch (error) {
      if (DATA_CODES.has(error?.code)) return null;
      throw error;
    }
    if (!copy) return null;
    try { checkMeta(copy.meta); } catch (_) { return null; }
    if ((copy.meta.split?.generation ?? 0) !== (loaded.meta.split?.generation ?? 0)) return null;
    const have = new Set(copy.events.map(e => `${e.boot}\u0000${e.seq}`));
    for (const e of loaded.events) if (e.carried !== true && !have.has(`${e.boot}\u0000${e.seq}`)) return null;
    return copy;
  }

  // Morceaux déjà écrits de la génération g d'une origine (meta.json fini sans
  // recoupe) : rang k → { id, meta }, le premier dossier de ce rang dans
  // l'ordre des identifiants. Un dossier sans meta.json, ou dont le meta.json
  // est abîmé (JSON illisible, dossier à la place du fichier), n'est pas un
  // morceau : passé. Toute autre erreur de lecture (EBUSY, EIO…, la liste de
  // data/soirees comprise) sort, et la soirée suit « Échecs » (retry) avant
  // que son meta.json soit écrit : le démarrage suivant retrouve ses morceaux.
  _piecesOf(from, generation) {
    const found = new Map();
    const names = this.fs.readdirSync(this.dir);
    for (const id of names.filter(validId).sort()) {
      if (id === from) continue;
      const file = path.join(this._folder(id), 'meta.json');
      if (!this.fs.existsSync(file)) continue;
      let text;
      try { text = this.fs.readFileSync(file, 'utf8'); } catch (error) {
        if (error?.code === 'EISDIR') continue;
        throw named(error, 'meta.json');
      }
      let meta;
      try { meta = JSON.parse(String(text)); } catch (_) { continue; }
      const split = meta?.split;
      if (isPlain(split) && split.from === from && split.generation === generation && Number.isInteger(split.part) && !found.has(split.part)) {
        found.set(split.part, { id, meta });
      }
    }
    return found;
  }

  // Résumé d'un morceau écrit, null s'il ne se lit pas.
  _readSummary(id) {
    try { return JSON.parse(String(this.fs.readFileSync(path.join(this._folder(id), 'summary.json'), 'utf8'))); } catch (_) { return null; }
  }

  // Lignes du journal d'un morceau écrit, null s'il ne se lit pas (absent
  // compris).
  _pieceEvents(id) {
    try {
      const raw = this._readRaw(path.join(this._folder(id), 'journal.jsonl'));
      return raw === null ? null : parseLines(String(raw)).events;
    } catch (_) { return null; }
  }

  // Lignes illisibles laissées à la copie de la génération g : celles de son
  // journal.jsonl, le journal d'avant le découpage ; null s'il ne se lit pas
  // (absent compris).
  _copyUnreadable(id, generation) {
    try {
      const raw = this._readRaw(path.join(this.originals, id, String(generation), 'journal.jsonl'));
      return raw === null ? null : unreadableOf(parseLines(String(raw)));
    } catch (_) { return null; }
  }

  // Réparation d'une soirée (A4), dans un seul bloc synchrone, index compris :
  // lecture, coupures (breaksOf, par défaut eveningBreaks), morceaux
  // (planSplit), copie de la génération, morceaux, puis le dossier d'origine
  // (journal.jsonl, summary.json, meta.json en dernier), puis l'index.
  // `current` : la soirée de l'instantané, réparée au démarrage avant
  // journal.open ; ouverte, elle est revue quel que soit l'index et n'y est
  // jamais notée ok ni split. `summarize({ meta, events })` : le résumé d'un
  // morceau clos (computeStats). `log` : chaque ligne « Réparation : » du
  // journal du serveur (appLog). Ne lève pas pour une soirée en échec : son
  // état va dans l'index et dans le résultat.
  //
  // Rend { id, status, current, split, generation, pieces, previous, code,
  // step, attempts, renames } ; status : 'split', 'ok' (vérifiée sans
  // coupure), 'retry', 'failed', 'skipped' (déjà vérifiée, soirée ouverte dans
  // ce journal, démo, ou soirée close laissée telle quelle tant que l'index
  // ne se lit pas : code de l'erreur passagère et step 'index'), 'ignored'
  // (dossier sans meta.json, ou morceau d'une réparation inachevée) ou 'off'
  // (KARAOKE_REPAIR). pieces : les morceaux d'une soirée découpée, { id, k,
  // start, end, lines } (lines : ses lignes, sans lignes reportées ni
  // clôture ; null quand le journal d'un morceau déjà écrit ne se lit pas,
  // après un meta.json fini sans recouper). Pour la soirée en cours découpée,
  // previous = { id, cut, summary } : son dernier morceau archivé ; null pour
  // un échec. attempts : l'essai noté d'un échec ; null quand la lecture du
  // démarrage échoue avant de savoir la soirée ouverte et que l'index la dit
  // déjà vue (ok, split, failed de cette version) : son entrée est gardée,
  // et retry (ou failed) rendu au démarrage, avec kept : l'état de cette
  // entrée ('ok', 'split' ou 'failed'), dont startNight tire la note au bar
  // d'une soirée close ; kept est absent de tout autre résultat.
  repair({ id, current = false, breaksOf = defaultBreaks, summarize = null, citedIds = this.citedIds, log = null } = {}) {
    const say = line => { if (typeof log === 'function') { try { log(line); } catch (_) { /* journal du serveur au mieux */ } } };
    const result = { id, status: 'skipped', current: false, split: false, generation: null, pieces: [], previous: null,
      code: null, step: null, attempts: null, renames: 0 };
    if (!this.dir) return result;
    if (!this.repairEnabled) return { ...result, status: 'off' };
    if (!validId(id)) {
      say(`Réparation : identifiant de soirée invalide, rien n'est lu ni écrit. Envoie cette ligne au développeur ${ENVOYER}.`);
      return { ...result, status: 'failed', code: 'BAD_PATH', step: 'lecture' };
    }
    if (this.current && this.current.id === id) return result;
    if (typeof citedIds !== 'function') throw new TypeError('repair : citedIds attendu (evening-stats.js).');
    if (typeof breaksOf !== 'function') throw new TypeError('repair : breaksOf attendu (eveningBreaks).');
    const work = { id, say, summarize: typeof summarize === 'function' ? summarize : null, citedIds, breaksOf,
      step: 'lecture', started: performance.now(), stats: { renames: 0 }, asCurrent: false, generation: null };
    const index = this._readIndex(say);
    const entry = index.checked.get(id);
    if (!current && index.unread) return waitIndex(result, index);
    if (!current && this._indexDone(entry)) return result;
    // Son summary.json peut être réécrit, même si meta.json ne l'est pas
    // (échec entre les deux) : list() le relira.
    this._openings.delete(id);
    try {
      return this._repairOne(work, index, entry, current, result);
    } catch (error) {
      return this._repairFailed(work, index, entry, error, result);
    }
  }

  _repairOne(work, index, entry, current, result) {
    const { id } = work;
    const loaded = this._load(id);
    if (!loaded) return { ...result, status: 'ignored' };
    const closed = isClosed(loaded);
    work.asCurrent = !!current && !closed;
    if (!work.asCurrent && current && index.unread) return waitIndex(result, index);
    if (!work.asCurrent && current && this._indexDone(entry)) return result;
    checkMeta(loaded.meta);
    if (!work.asCurrent && this._pendingPiece(id, loaded.meta)) return { ...result, status: 'ignored' };
    const g0 = loaded.meta.split ? loaded.meta.split.generation : 0;
    const g = g0 + 1;
    work.generation = g;
    // Découpage inachevé : reprise de la copie de la génération g, sinon un
    // dossier dont le journal est déjà réécrit a son meta.json fini.
    const copy = this._usableCopy(id, g, loaded);
    const carried = carriedPart(loaded.events);
    if (!copy && carried && carried.generation > g0) return this._finishMeta(work, index, loaded, carried, result);
    const input = copy || loaded;
    let plan;
    try {
      plan = splitPlan({ meta: input.meta, events: input.events, citedIds: work.citedIds, breaksOf: work.breaksOf,
        generation: g, at: this.now(), id });
    } catch (error) {
      // Exception du calcul du morceau k, que planSplit marque de son rang :
      // étape « morceau k » ; celle des coupures (breaksOf) reste à « lecture ».
      if (Number.isInteger(error?.splitPart)) work.step = `morceau ${error.splitPart}`;
      throw error;
    }
    if (plan.zoneReplaced) work.say(`Réparation : ${id} : fuseau de meta.json refusé, fuseau du processus pris (${plan.timeZone}).`);
    if (plan.pieces.length < 2) return this._noCut(work, index, loaded, closed, result);
    const pieces = this._pieces(work, plan, isClosed(input));
    const n = pieces.length;
    // Écriture : la copie, les morceaux, puis le dossier d'origine.
    if (!copy) { work.step = 'copie'; this._copyOriginal(id, g, { ...loaded.raw, 'summary.json': this._readRaw(path.join(this._folder(id), 'summary.json')) }, work.stats); }
    for (const piece of pieces.slice(0, -1)) {
      work.step = `morceau ${piece.piece.k}`;
      this._writePiece(piece.id, piece, work.stats);
    }
    const last = pieces[n - 1];
    const folder = this._folder(id);
    work.step = 'journal';
    this._writeFile(path.join(folder, 'journal.jsonl'), journalText(last.lines), work.stats);
    work.step = 'meta.json';
    if (last.summary) this._writeFile(path.join(folder, 'summary.json'), JSON.stringify(last.summary), work.stats);
    else if (!work.asCurrent) this._unlink(path.join(folder, 'summary.json'));
    this._writeFile(path.join(folder, 'meta.json'), metaText(last.meta), work.stats);
    if (work.asCurrent) this._dropMark(work, g);
    for (const piece of pieces.slice(0, -1)) this._note(index, piece.id, 'ok');
    this._note(index, id, work.asCurrent ? null : 'split');
    this._writeIndex(index, work.say, work.stats);
    const carriedLines = pieces.reduce((sum, piece) => sum + piece.piece.carried.length, 0);
    const entries = pieces.map(piece => ({ id: piece.id, k: piece.piece.k, start: piece.piece.start, end: piece.piece.end, lines: piece.piece.lines.length }));
    work.say(`Réparation : ${id} découpée en ${n} morceaux (génération ${g}${copy ? ', reprise de la copie' : ''}) : ${entries.map(pieceText).join(', ')} ; ` +
      `${plural(carriedLines, 'ligne reportée', 'lignes reportées')} ; ${unreadableText(unreadableOf(input))}${renamesText(work.stats.renames)} ; ` +
      `en ${Math.round(performance.now() - work.started)} ms.`);
    if (work.asCurrent) {
      const previous = pieces[n - 2];
      result.previous = { id: previous.id, cut: previous.piece.end, summary: previous.summary };
    }
    return { ...result, status: 'split', current: work.asCurrent, split: true, generation: g, renames: work.stats.renames, pieces: entries };
  }

  // Contenu de chaque morceau, calculé avant toute écriture : identifiant,
  // meta (karaoke et closedBy pour un morceau clos ; cut et previous pour la
  // soirée en cours), lignes et résumé.
  _pieces(work, plan, lastClosed) {
    const n = plan.pieces.length;
    const taken = new Set();
    const out = [];
    for (const piece of plan.pieces) {
      work.step = `morceau ${piece.k}`;
      const last = piece.k === n;
      const id = last ? plan.from : this._pieceId(plan, piece, taken);
      taken.add(id);
      const lines = pieceJournal(piece);
      let meta = last ? piece.meta : withId(piece.meta, id);
      let summary = null;
      if (!last || lastClosed) {
        summary = work.summarize ? work.summarize({ meta, events: lines }) : null;
        meta = withKaraoke(meta, karaokeOf(summary, lines, meta));
      }
      out.push({ piece, id, meta, lines, summary });
    }
    if (work.asCurrent) out[n - 1].meta = withCut(out[n - 1].meta, plan.pieces[n - 1].start, out[n - 2].id);
    return out;
  }

  // Rien à couper. Soirée en cours : rien d'écrit, son entrée et la marque
  // d'une copie de sa génération déjà finie retirées. Soirée close sans
  // karaoke : karaoke et closedBy ajoutés à son meta.json, une seule fois
  // (A4, « Champ ajouté ») ; puis ok.
  _noCut(work, index, loaded, closed, result) {
    const { id } = work;
    if (work.asCurrent) {
      const g0 = loaded.meta.split ? loaded.meta.split.generation : 0;
      if (g0) this._dropMark(work, g0);
      this._note(index, id, null);
      this._writeIndex(index, work.say, work.stats);
      return { ...result, status: 'ok', current: true, renames: work.stats.renames };
    }
    let added = false;
    if (closed && loaded.meta.karaoke == null) {
      work.step = 'meta.json';
      const summary = work.summarize ? work.summarize({ meta: loaded.meta, events: loaded.events }) : null;
      const closing = loaded.events.findLast(e => e.ev === 'evening.closed');
      const closedBy = typeof closing?.by === 'string' ? closing.by : typeof loaded.meta.closedBy === 'string' ? loaded.meta.closedBy : null;
      this._writeFile(path.join(this._folder(id), 'meta.json'), metaText(withKaraoke(loaded.meta, karaokeOf(summary, loaded.events, loaded.meta), closedBy)), work.stats);
      added = true;
    }
    this._note(index, id, 'ok');
    this._writeIndex(index, work.say, work.stats);
    const unreadable = unreadableOf(loaded);
    work.say(`Réparation : ${id} vérifiée sans coupure : ${plural(loaded.events.length, 'ligne', 'lignes')}` +
      `${unreadable ? ` et ${plural(unreadable, 'illisible', 'illisibles')}` : ''}${added ? ', karaoke et closedBy ajoutés à meta.json' : ''}` +
      `${renamesText(work.stats.renames)} ; en ${Math.round(performance.now() - work.started)} ms.`);
    return { ...result, status: 'ok', renames: work.stats.renames };
  }

  // Dossier arrêté entre son journal et son meta.json, sans copie qui serve :
  // meta.json fini (début à l'heure des lignes reportées, prénoms et tables
  // filtrés, split), sans recouper (A4, « Sauvegarde par génération »). Sa
  // ligne « Réparation : » est celle d'une soirée découpée (« Trace et
  // contraintes »), d'après les morceaux tels qu'ils sont écrits : chacun
  // (identifiant, début et fin, nombre de lignes), leurs lignes reportées, et
  // les lignes illisibles de la copie de la génération. Un morceau
  // introuvable, ou un journal ou une copie qui ne se lisent pas, y sont
  // nommés, sans faire échouer la soirée ; rend les morceaux trouvés. Une
  // soirée close où la règle coupe encore (une nuit de plus depuis l'arrêt :
  // soirée rouverte telle quelle, puis close) n'est pas notée split : son
  // entrée est retirée, si bien qu'elle reste à revoir et que ses essais
  // repartent de 1 (meta.json fini est un progrès : un retry d'avant ne
  // compte plus), et la passe suivante la recoupe à la génération suivante,
  // d'une copie nouvelle (« Sauvegarde par génération ») ; sa ligne le dit.
  _finishMeta(work, index, loaded, carried, result) {
    const { id } = work;
    const { generation, part } = carried;
    work.generation = generation;
    work.step = 'meta.json';
    const closed = isClosed(loaded);
    const found = this._piecesOf(id, generation);
    let meta = pieceMeta({ meta: loaded.meta, events: loaded.events, citedIds: work.citedIds, eveningId: id,
      split: { from: id, part, generation, rule: SPLIT_RULE } });
    let summary = null;
    if (closed) {
      summary = work.summarize ? work.summarize({ meta, events: loaded.events }) : null;
      meta = withKaraoke(meta, karaokeOf(summary, loaded.events, meta));
    }
    // Dernier morceau archivé de la soirée en cours, rendu (previous) une
    // fois meta.json écrit, comme après un découpage : jamais pour un échec.
    let previous = null;
    if (work.asCurrent) {
      const before = part > 1 ? found.get(part - 1) : undefined;
      meta = withCut(meta, meta.startedAt, before ? before.id : null);
      previous = before ? { id: before.id, cut: Number.isFinite(before.meta.endedAt) ? before.meta.endedAt : meta.startedAt,
        summary: this._readSummary(before.id) } : null;
    }
    const left = work.asCurrent ? 0 : cutsFrom(work.breaksOf({ meta, events: loaded.events, timeZone: safeTimeZone(meta.timezone).zone })).length;
    const folder = this._folder(id);
    if (summary) this._writeFile(path.join(folder, 'summary.json'), JSON.stringify(summary), work.stats);
    this._writeFile(path.join(folder, 'meta.json'), metaText(meta), work.stats);
    if (work.asCurrent) this._dropMark(work, generation);
    this._note(index, id, work.asCurrent || left ? null : 'split');
    this._writeIndex(index, work.say, work.stats);
    const pieces = [], list = [];
    let carriedLines = 0, partial = false;
    // Le morceau 1 n'a pas de lignes reportées : seul un morceau suivant
    // introuvable ou illisible laisse leur nombre incomplet (« au moins »).
    // Le rang vient de la première ligne du journal (jusqu'à neuf chiffres) :
    // seuls les morceaux trouvés sont parcourus, les rangs manquants entre
    // eux nommés par plages.
    const ranks = [...found.keys()].filter(k => k >= 1 && k < part).sort((a, b) => a - b);
    let next = 1;
    for (const k of [...ranks, part]) {
      if (k > next) {
        list.push(missingText(next, k - 1));
        if (k - 1 > 1) partial = true;
      }
      next = k + 1;
      const piece = k === part ? { id, meta } : found.get(k);
      const events = k === part ? loaded.events : this._pieceEvents(piece.id);
      const counts = events ? pieceCounts(events, generation, k) : null;
      if (counts) carriedLines += counts.carried;
      else if (k > 1) partial = true;
      const entry = { id: piece.id, k, start: timeOrNull(piece.meta.startedAt), end: timeOrNull(piece.meta.endedAt), lines: counts ? counts.lines : null };
      pieces.push(entry);
      list.push(pieceText(entry));
    }
    work.say(`Réparation : ${id} découpée en ${plural(part, 'morceau', 'morceaux')} (génération ${generation}, meta.json fini sans recouper) : ` +
      `${list.join(', ')} ; ${partial ? 'au moins ' : ''}${plural(carriedLines, 'ligne reportée', 'lignes reportées')} ; ` +
      `${unreadableText(this._copyUnreadable(id, generation))}${renamesText(work.stats.renames)}` +
      `${left ? ` ; ${plural(left, 'coupure restée', 'coupures restées')} : revue au prochain démarrage` : ''} ; en ${Math.round(performance.now() - work.started)} ms.`);
    result.previous = previous;
    return { ...result, status: 'split', current: work.asCurrent, split: true, generation, renames: work.stats.renames, pieces };
  }

  // copie-complete de la génération g retiré : la soirée en cours continue, et
  // sa copie ne doit plus servir de reprise. Un échec ne fait qu'une ligne :
  // une copie à laquelle manque une ligne du dossier ne sert jamais.
  _dropMark(work, generation) {
    try { this._unlink(path.join(this.originals, work.id, String(generation), COPY_MARK)); } catch (error) {
      work.say(`Réparation : ${work.id} : copie-complete de la génération ${generation} non retiré (${codeText(error)}) : cette copie ne servira plus de reprise.`);
    }
  }

  _repairFailed(work, index, entry, error, result) {
    const failure = failureOf(error, work.step);
    const trace = errorTrace(error);
    // Lecture du démarrage en échec avant de savoir la soirée ouverte (seul
    // cas où une entrée qui dispense de la revoir arrive ici) : cette entrée
    // (ok, split, failed de cette version) est gardée, jamais réécrite en
    // retry, sans quoi une soirée remise à l'original serait recoupée par la
    // passe suivante ; l'échec est rendu au démarrage (startNight), sans essai
    // compté.
    if (!work.asCurrent && this._indexDone(entry)) {
      const kept = isPlain(entry) ? entry.status : entry;
      work.say(keptLine(work.id, failure, kept, trace, work.stats.renames));
      if (failure.kind === 'exception') work.say(`Réparation : pile de ${work.id} : ${trace.stack || '(pile vide)'}`);
      return { ...result, status: failure.kind === 'transient' ? 'retry' : 'failed', current: false, code: failure.code, step: failure.step,
        renames: work.stats.renames, kept };
    }
    const version = this._version();
    const stale = isPlain(entry) && entry.status === 'failed' && entry.version !== version;
    const before = isPlain(entry) && !stale ? entry.attempts : 0;
    const attempts = Math.min(MAX_ATTEMPTS, before + 1);
    const status = failure.kind === 'transient' && attempts < MAX_ATTEMPTS ? 'retry' : 'failed';
    work.say(failureLine(work.id, failure, attempts, status, trace, work.stats.renames));
    if (failure.kind === 'exception') work.say(`Réparation : pile de ${work.id} : ${trace.stack || '(pile vide)'}`);
    if (work.asCurrent && work.generation) this._dropMark(work, work.generation);
    this._note(index, work.id, { status, attempts, code: failure.code, version });
    this._writeIndex(index, work.say, work.stats);
    return { ...result, status, current: work.asCurrent, code: failure.code, step: failure.step, attempts, renames: work.stats.renames };
  }

  // Découpage en direct de la soirée ouverte à `cut` (A2, « Soirée reprise
  // après C ») : le même calcul et les mêmes écritures que la réparation. Le
  // morceau d'avant la coupure est archivé, clos à `cut` ; les fichiers de la
  // soirée ouverte sont réécrits, puis journal.current est remplacé : même
  // identifiant, meta.startedAt = cut, meta.split avec cut et previous, lignes
  // reportées puis lignes d'après la coupure, un seq qui continue. Synchrone ;
  // aucun app.started. Une écriture en échec n'empêche pas le découpage en
  // mémoire : le morceau archivé reste lisible (journal.memory), l'erreur est
  // signalée une fois (onError) et rendue (`error`). Sans dossier (démo), le
  // morceau va dans journal.memory. Sans aucun identifiant sûr pour le
  // morceau archivé (les mille essais pris ou illisibles), lève BAD_PATH sans
  // rien changer.
  //
  // Rend { id, cut, summary, generation, current, error, indexProblem } ;
  // indexProblem : le code d'un index .bornage.json illisible ou impossible
  // à lire, laissé tel quel (le morceau n'y est pas noté), sinon null.
  // { refused } pour une coupure refusée par cutAllowed ('cut'), une
  // génération illisible ('generation'), KARAOKE_REPAIR ('off') ou un
  // découpage précédent pas encore écrit sur le disque ('pending') ; null
  // sans soirée ouverte.
  splitAt(cut, { summarize = null, citedIds = this.citedIds } = {}) {
    const cur = this.current;
    if (!cur || !Number.isFinite(cut)) return null;
    if (!this.repairEnabled) return { refused: 'off' };
    if (cur.diskMeta) return { refused: 'pending' };
    const meta = cur.meta;
    if (!cutAllowed({ at: cut, startedAt: meta.startedAt, split: meta.split })) return { refused: 'cut' };
    if (meta.split != null && !(isPlain(meta.split) && Number.isInteger(meta.split.generation) && meta.split.generation >= 1)) {
      return { refused: 'generation' };
    }
    if (typeof citedIds !== 'function') throw new TypeError('splitAt : citedIds attendu (evening-stats.js).');
    const generation = (meta.split ? meta.split.generation : 0) + 1;
    const plan = splitPlan({ meta, events: cur.events, citedIds, breaksOf: () => [cut], generation, at: this.now(), id: cur.id });
    const [first, last] = plan.pieces;
    const firstLines = pieceJournal(first);
    const failure = { step: null, error: null };
    const fail = (step, error) => { if (!failure.error) { failure.step = step; failure.error = error; this._fail(error); } };
    let id;
    try { id = this._pieceId(plan, first, new Set()); } catch (error) {
      // Choix sur le disque en échec : rien n'est écrit, et le morceau gardé
      // en mémoire prend le premier identifiant libre ou le nôtre d'après une
      // nouvelle lecture, un dossier encore illisible passé comme pris :
      // jamais celui d'une autre soirée, que read() et list() cacheraient.
      // Sans aucun identifiant sûr, l'erreur sort, rien n'est changé.
      id = this._pieceId(plan, first, new Set(), { skipUnreadable: true });
      fail('morceau 1', error);
    }
    let summary = null;
    try { summary = typeof summarize === 'function' ? summarize({ meta: withId(first.meta, id), events: firstLines }) : null; }
    catch (error) { this._fail(error); }
    const archived = { meta: withKaraoke(withId(first.meta, id), karaokeOf(summary, firstLines, first.meta)), lines: firstLines, summary };
    const nextMeta = withCut(last.meta, cut, id);
    const nextEvents = pieceJournal(last);
    let pieceWritten = false, journalWritten = !this.dir, indexProblem = null;
    if (this.dir && !failure.error) {
      const folder = this._folder(cur.id);
      const stats = { renames: 0 };
      let step = 'copie';
      let marked = false;
      try {
        const raw = {};
        for (const name of COPIED) raw[name] = this._readRaw(path.join(folder, name));
        if (raw['meta.json'] === null) raw['meta.json'] = Buffer.from(metaText(meta));
        this._copyOriginal(cur.id, generation, raw, stats);
        marked = true;
        step = 'morceau 1';
        this._writePiece(id, archived, stats);
        pieceWritten = true;
        step = 'journal';
        this._writeFile(path.join(folder, 'journal.jsonl'), journalText(nextEvents), stats);
        journalWritten = true;
        step = 'meta.json';
        this._writeFile(path.join(folder, 'meta.json'), metaText(nextMeta), stats);
        step = 'copie-complete';
        this._unlink(path.join(this.originals, cur.id, String(generation), COPY_MARK));
        marked = false;
      } catch (error) {
        fail(step, error);
        if (marked) { try { this._unlink(path.join(this.originals, cur.id, String(generation), COPY_MARK)); } catch (_) { /* une copie incomplète ne sert jamais */ } }
      }
      if (pieceWritten) {
        try {
          // Index illisible (lecture en échec, contenu abîmé) : laissé tel
          // quel, jamais réécrit avec la seule entrée du morceau, qui y
          // effacerait les autres sans une ligne. La passe des soirées closes
          // vérifie le morceau au démarrage suivant, et la réparation y écrit
          // la ligne d'un index encore illisible.
          const index = this._readIndex(null);
          if (index.problem) indexProblem = index.problem;
          else {
            this._note(index, id, 'ok');
            this._saveIndex(index, stats);
          }
        } catch (error) { this._fail(error); }
      }
    }
    if (!this.dir || !pieceWritten) this.memory.set(id, { meta: archived.meta, events: archived.lines, summary });
    this.current = { id: cur.id, meta: nextMeta, events: nextEvents, seq: cur.seq };
    if (!journalWritten) this.current.diskMeta = meta;
    const error = failure.error ? { step: failure.step, code: codeText(failure.error), name: errorTrace(failure.error).name } : null;
    return { id, cut, summary, generation, current: cur.id, error, indexProblem };
  }
}

module.exports = { EveningJournal, newEveningId, validEveningId: validId, parseLines, cleanFields: clean, errorTrace, karaokeOf, splitPlan,
  openingLabel, exportFileName };
