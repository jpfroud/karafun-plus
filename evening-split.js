'use strict';
/*
 * Découpage d'un journal de soirée fusionné en morceaux (plan du 8 novembre,
 * A4) : le calcul pur, le même pour la réparation (EveningJournal.repair), le
 * découpage en direct (splitAt) et le rejeu d'un export fusionné
 * (test/rejeu-soiree.js --soiree) : ce sont les mêmes morceaux qu'au bar.
 * Aucune dépendance ni accès disque : les coupures viennent d'eveningBreaks
 * (evening-bounds.js), les personnes citées de citedIds (evening-stats.js), et
 * EveningJournal écrit les morceaux (choix de j et de l'identifiant sur le
 * disque, copie par génération, copie-complete, ordre d'écriture, renommages,
 * index).
 *
 * planSplit({ meta, events, cuts, citedIds, generation, at, id }) rend
 * { from, generation, rule, cuts, pieces }, et pour chaque morceau k (1 à n)
 * { k, start, end, meta, carried, lines, closing } :
 * - bornes : le morceau k va de la coupure k-1 (exclue) à la coupure k
 *   (comprise) ; le premier commence au début d'origine (meta.startedAt), le
 *   dernier finit à la fin d'origine (meta.endedAt, null pour la soirée en
 *   cours). Chaque ligne va dans le morceau de son heure t, pas de sa place
 *   (une ligne sans heure reste avec celle qui la précède), et chaque morceau
 *   garde l'ordre du journal, celui des seq, comme piecesOf (evening-bounds.js) ;
 * - lines : les lignes du journal du morceau, telles quelles (mêmes objets) ;
 * - carried : à partir du deuxième morceau, les lignes reportées
 *   (carried: true), datées de son début, avec un boot propre et des seq
 *   propres, de 1 - m à 0 pour m lignes : jamais ceux d'une ligne écrite par
 *   le journal, même dans un export, qui retire le boot. Seul ce qui est connu avant la
 *   coupure est reporté : les règles en vigueur (evening.started : règles
 *   d'origine et settings.changed d'avant, toujours écrite, rules: null si
 *   rien n'est connu), la dernière karaoke.phase ; pour chaque table citée
 *   dans le morceau, table.opened (avec individual), le dernier
 *   table.headcount et le bonus en vigueur ; pour chaque personne citée dans
 *   le morceau, person.joined (avec sa table à la coupure) et le bonus en
 *   vigueur. Une table ou une personne créée dans le morceau n'a pas de ligne
 *   reportée ; une table partie (table.left) est oubliée : rouverte sous le
 *   même numéro, c'est une table neuve, sans l'effectif ni le bonus de
 *   l'ancienne. Cet état se lit dans l'ordre des heures, puis du journal ;
 *   dans un morceau déjà découpé, une ligne datée d'avant ses lignes
 *   reportées (heure du PC reculée) compte à leur heure, donc après elles ;
 * - citée : une personne l'est quand une ligne du morceau, hors lignes
 *   reportées, la cite (citedIds) ; une table, quand une personne citée y est
 *   à la coupure, ou qu'une inscription du morceau y fait arriver quelqu'un
 *   (person.joined sur une table de la veille) ;
 * - closing : sauf pour le dernier morceau, evening.closed { by: 'auto',
 *   reason: 'morning', split: true, at }, datée de sa coupure (C), dont le seq
 *   suit ceux du morceau ; at est l'heure réelle du découpage, si l'appelant
 *   la donne ;
 * - meta : celle d'origine filtrée aux personnes et aux tables reportées ou
 *   créées dans le morceau (pieceMeta), avec ses bornes, closedBy (le by de sa
 *   ligne evening.closed) et split = { from, part: k, generation, rule }. Le
 *   dernier morceau garde l'identifiant d'origine ; les autres ont
 *   eveningId: null, que l'appelant remplace par newEveningId(start,
 *   splitFingerprint(from, k, j), meta.timezone), j = 1, 2… jusqu'au premier
 *   identifiant libre ou dont le dossier est le sien. karaoke (A5), calculé
 *   comme à une clôture, vient aussi de l'appelant.
 * Sans coupure, un seul morceau : la soirée telle qu'elle est (meta
 * inchangée, rien de reporté ni de clos).
 *
 * Lecture des champs (A7, champs de mauvais type) : un booléen n'est vrai que
 * s'il vaut true ; un identifiant ne nomme une personne ou une table que si
 * c'est une chaîne non vide ; une liste qui n'en est pas une est vide ; un
 * niveau de bonus qui n'est pas un nombre vaut 0. Le module ne modifie ni
 * meta ni les lignes reçues, et ne lève pas sur une ligne mal formée ; une
 * exception de citedIds pendant le calcul du morceau k est relancée telle
 * quelle, marquée error.splitPart = k (l'étape « morceau k » de la
 * réparation). Aucune propriété n'est nommée par une valeur du journal sans
 * contrôle : Map, Set, Object.fromEntries, noms de réglages vérifiés.
 */

const SPLIT_RULE = 'v1';
const FORMAT = 1;  // version des lignes, comme dans evening-journal.js
// Champs qui nomment une personne (les mêmes que pseudonyms, evening-stats.js).
const PERSON_FIELDS = ['personId', 'ownerId', 'partnerId', 'guestId', 'requesterId', 'voterId', 'proposerId', 'toId', 'previousPartnerId'];
const PERSON_LISTS = ['personIds', 'ids'];
// Champs de meta.json recalculés pour chaque morceau.
const RECOMPUTED = new Set(['eveningId', 'startedAt', 'endedAt', 'roster', 'tables', 'split', 'karaoke', 'closedBy']);
// Nom de réglage repris dans les règles reportées.
const SETTING = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;

const isTrue = value => value === true;
const isId = value => typeof value === 'string' && value !== '';
// Heure que Date accepte (± 8,64e15 ms autour de 1970), comme isTime
// d'evening-bounds.js et d'evening-journal.js : au-delà, une heure se lit
// comme absente (ligne sans heure). Un niveau de bonus et un seq ne sont pas
// des heures : un nombre fini leur suffit.
const MAX_TIME = 8.64e15;
const isTime = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIME;
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isLine = e => e !== null && typeof e === 'object';
const levelOf = value => (Number.isFinite(value) ? value : 0);
// Objet sans les champs indéfinis (JSON identique, écriture stable).
const defined = fields => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

function namedPeople(e) {
  const out = [];
  for (const key of PERSON_FIELDS) if (isId(e[key])) out.push(e[key]);
  for (const key of PERSON_LISTS) if (Array.isArray(e[key])) for (const id of e[key]) if (isId(id)) out.push(id);
  return out;
}
function citedOf(citedIds, e) {
  const ids = citedIds(e);
  return Array.isArray(ids) ? ids.filter(isId) : [];
}
// Exception du calcul du morceau k (citedIds, ou un défaut du module) :
// relancée telle quelle, marquée de son rang (error.splitPart = k, sauf s'il
// en a déjà un), d'où l'étape « morceau k » de la réparation (A4, « Lignes
// d'échec »). Une erreur qui n'est pas un objet, ou figée, part sans rang.
function inPart(error, k) {
  try {
    if (error !== null && typeof error === 'object' && error.splitPart === undefined) error.splitPart = k;
  } catch (_) { /* erreur figée : sans rang */ }
  return error;
}
// Coupures en nombres, triées, sans double.
const cutList = cuts => [...new Set((Array.isArray(cuts) ? cuts : []).filter(isTime))].sort((a, b) => a - b);

// Lignes rangées par morceau : le morceau d'une ligne est le nombre de
// coupures strictement avant son heure ; une ligne sans heure suit la
// précédente.
function assign(lines, cuts) {
  const pieces = Array.from({ length: cuts.length + 1 }, () => []);
  let k = 0;
  for (const e of lines) {
    if (isTime(e?.t)) {
      let low = 0, high = cuts.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (cuts[mid] < e.t) low = mid + 1; else high = mid;
      }
      k = low;
    }
    pieces[k].push(e);
  }
  return pieces;
}

// Personnes et tables d'un morceau (meta filtrée). Avec des lignes reportées,
// comme computeStats les crée : reportées, inscrites ou ouvertes dans le
// morceau, citées, et les tables où une inscription fait arriver quelqu'un.
// Sans ligne reportée, toutes celles que le morceau nomme.
function membersOf(lines, citedIds) {
  const people = new Set(), tables = new Set();
  const withCarried = lines.some(e => isLine(e) && isTrue(e.carried));
  for (const e of lines) {
    if (!isLine(e)) continue;
    if (!withCarried) {
      for (const id of namedPeople(e)) people.add(id);
      if (isId(e.tableId)) tables.add(e.tableId);
      continue;
    }
    if (!isTrue(e.carried)) for (const id of citedOf(citedIds, e)) people.add(id);
    if (e.ev === 'person.joined') {
      if (isId(e.personId)) people.add(e.personId);
      if (isId(e.tableId)) tables.add(e.tableId);
    } else if (e.ev === 'table.opened' && isId(e.tableId)) tables.add(e.tableId);
  }
  return { people, tables };
}

// meta d'un morceau : celle d'origine, filtrée aux personnes et aux tables du
// morceau (membersOf), avec ses bornes, closedBy et split. Sert à planSplit et
// à la réparation d'un dossier arrêté entre son journal et son meta.json, dont
// le journal commence par ses lignes reportées : `events` est alors ce
// journal, `start` par défaut l'heure de sa première ligne reportée.
// Ce dossier est celui d'origine, le dernier morceau : `end` et `eveningId`
// sont par défaut ceux d'origine (meta.endedAt, null pour la soirée en
// cours ; meta.eveningId). Un `end` donné l'emporte, null compris.
function pieceMeta({ meta = {}, events = [], start, end, split = null, citedIds, eveningId } = {}) {
  if (typeof citedIds !== 'function') throw new TypeError('pieceMeta : citedIds attendu (evening-stats.js).');
  const base = isPlain(meta) ? meta : {};
  const lines = Array.isArray(events) ? events : [];
  const { people, tables } = membersOf(lines, citedIds);
  const firstCarried = lines.find(e => isLine(e) && isTrue(e.carried) && isTime(e.t));
  const begin = isTime(start) ? start : firstCarried ? firstCarried.t : isTime(base.startedAt) ? base.startedAt : null;
  const closing = lines.findLast(e => isLine(e) && e.ev === 'evening.closed');
  const closedBy = isId(closing?.by) ? closing.by : isId(base.closedBy) ? base.closedBy : null;
  const keep = (value, wanted) => Object.fromEntries(Object.entries(isPlain(value) ? value : {}).filter(([key]) => wanted.has(key)));
  const computed = new Map([
    ['eveningId', eveningId === undefined ? (base.eveningId ?? null) : eveningId],
    ['startedAt', begin],
    ['endedAt', end === undefined ? (isTime(base.endedAt) ? base.endedAt : null) : isTime(end) ? end : null],
    ['roster', keep(base.roster, people)],
    ['tables', keep(base.tables, tables)],
  ]);
  const entries = [];
  for (const [key, value] of Object.entries(base)) {
    if (computed.has(key)) { entries.push([key, computed.get(key)]); computed.delete(key); } else if (!RECOMPUTED.has(key)) entries.push([key, value]);
  }
  entries.push(...computed);
  if (closedBy) entries.push(['closedBy', closedBy]);
  if (split) entries.push(['split', { from: split.from ?? null, part: split.part, generation: split.generation, rule: split.rule ?? SPLIT_RULE }]);
  return Object.fromEntries(entries);
}

// État connu avant chaque coupure, lu dans l'ordre des heures (puis du
// journal) : règles, dernière phase de KaraFun, tables et personnes connues.
// Une seule passe pour toutes les coupures. Les lignes reportées d'un morceau
// déjà découpé sont son état à son début : une ligne datée d'avant la première
// (heure du PC reculée, A2, « Saut d'horloge »), écrite après elles, compte à
// leur heure, comme une activité datée d'avant meta.startedAt dans un morceau
// découpé (A1) ; elle est donc lue après elles, et l'état reporté ne la
// recouvre pas.
class Known {
  constructor(lines, roster, tables) {
    const first = lines.find(e => isLine(e) && isTrue(e.carried) && isTime(e.t));
    const floor = first ? first.t : -Infinity;
    this.at = lines.map(e => (isLine(e) && isTime(e.t) ? Math.max(e.t, floor) : null));
    this.order = lines.map((e, i) => i).filter(i => this.at[i] !== null).sort((a, b) => this.at[a] - this.at[b] || a - b);
    this.lines = lines;
    this.next = 0;
    this.roster = roster;
    this.metaTables = tables;
    this.rules = null;           // null (inconnues) ou Map
    this.phase = null;
    this.tables = new Map();     // id → { opened, individual, headcount, bonus }
    this.people = new Map();     // id → { tableId, bonus }
  }

  table(id) {
    if (!this.tables.has(id)) this.tables.set(id, { opened: false, individual: false, headcount: null, bonus: 0 });
    return this.tables.get(id);
  }

  person(id) {
    if (!this.people.has(id)) this.people.set(id, { tableId: null, bonus: 0 });
    return this.people.get(id);
  }

  // Lit les lignes datées jusqu'à `cut` compris.
  until(cut) {
    for (; this.next < this.order.length && this.at[this.order[this.next]] <= cut; this.next++) this.read(this.lines[this.order[this.next]]);
  }

  read(e) {
    if (isId(e.tableId)) this.table(e.tableId);
    for (const id of namedPeople(e)) this.person(id);
    switch (e.ev) {
      case 'evening.started': this.rules = isPlain(e.rules) ? new Map(Object.entries(e.rules)) : null; break;
      case 'settings.changed':
        if (typeof e.setting === 'string' && SETTING.test(e.setting)) {
          if (!(this.rules instanceof Map)) this.rules = new Map();
          if (Object.hasOwn(e, 'to')) this.rules.set(e.setting, e.to); else this.rules.delete(e.setting);
        }
        break;
      case 'karaoke.phase': this.phase = e; break;
      case 'table.opened': if (isId(e.tableId)) Object.assign(this.table(e.tableId), { opened: true, individual: isTrue(e.individual) }); break;
      case 'table.headcount': if (isId(e.tableId)) this.table(e.tableId).headcount = e; break;
      case 'table.bonus': if (isId(e.tableId)) this.table(e.tableId).bonus = levelOf(e.level); break;
      // Table partie (Scheduler.tableLeft) : retirée avec son effectif et son
      // bonus. Rouverte sous le même numéro, c'est une table neuve : créée
      // dans le morceau, ou, rouverte avant la coupure, sans l'état de
      // l'ancienne.
      case 'table.left': if (isId(e.tableId)) this.tables.delete(e.tableId); break;
      // Table à la coupure : celle de la dernière inscription (lot C : et des
      // déplacements, person.moved).
      case 'person.joined': if (isId(e.personId) && isId(e.tableId)) this.person(e.personId).tableId = e.tableId; break;
      case 'person.bonus': if (isId(e.personId)) this.person(e.personId).bonus = levelOf(e.level); break;
      default: break;
    }
  }

  // Table d'une personne à la coupure : sa dernière inscription, sinon celle
  // de meta.roster.
  tableAt(id) {
    const known = this.people.get(id)?.tableId;
    if (known) return known;
    const fallback = this.roster.get(id)?.tableId;
    return isId(fallback) ? fallback : null;
  }

  // Lignes reportées au début du morceau qui commence à `start`, pour ses
  // personnes citées et ses tables d'arrivée.
  carried({ start, boot, cited, arrivals }) {
    const out = [];
    const add = (ev, fields) => out.push({ ...defined(fields), carried: true, v: FORMAT, seq: 0, t: start, ev, boot });
    add('evening.started', { rules: this.rules instanceof Map ? Object.fromEntries(this.rules) : null });
    if (this.phase) add('karaoke.phase', { phase: this.phase.phase, blocker: this.phase.blocker });
    const people = [...this.people.keys()].filter(id => cited.has(id));
    const citedTables = new Set(arrivals);
    for (const id of people) { const tableId = this.tableAt(id); if (tableId) citedTables.add(tableId); }
    for (const [id, table] of this.tables) {
      if (!citedTables.has(id)) continue;
      const individual = table.opened ? table.individual : isTrue(this.metaTables.get(id)?.individual);
      add('table.opened', { tableId: id, individual });
      if (table.headcount) add('table.headcount', { tableId: id, n: table.headcount.n, by: table.headcount.by });
      if (table.bonus) add('table.bonus', { tableId: id, level: table.bonus });
    }
    for (const id of people) {
      add('person.joined', { personId: id, tableId: this.tableAt(id) });
      const { bonus } = this.people.get(id);
      if (bonus) add('person.bonus', { personId: id, level: bonus });
    }
    out.forEach((line, i) => { line.seq = i - out.length + 1; });
    return out;
  }
}

// Le calcul des morceaux (voir l'en-tête). `generation` : la copie par
// génération que l'appelant prend (entier ≥ 1) ; par défaut celle qui suit
// meta.split.generation, sinon 1. `id` : l'identifiant d'origine, par défaut
// meta.eveningId.
function planSplit({ meta = {}, events = [], cuts = [], citedIds, generation, at, id } = {}) {
  if (typeof citedIds !== 'function') throw new TypeError('planSplit : citedIds attendu (evening-stats.js).');
  const base = isPlain(meta) ? meta : {};
  const lines = Array.isArray(events) ? events : [];
  if (generation !== undefined && !(Number.isInteger(generation) && generation >= 1)) {
    throw new RangeError('planSplit : génération entière ≥ 1 attendue.');
  }
  const previous = base.split?.generation;
  const gen = generation ?? (Number.isInteger(previous) && previous >= 1 ? previous + 1 : 1);
  const from = id ?? base.eveningId ?? null;
  const bounds = cutList(cuts);
  const byPiece = assign(lines, bounds);
  // Début d'origine ; sans meta.startedAt (export relu par le rejeu), la plus
  // ancienne heure du journal, comme computeStats.
  const earliest = lines.reduce((min, e) => (isTime(e?.t) && e.t < min ? e.t : min), Infinity);
  const start = isTime(base.startedAt) ? base.startedAt : earliest < Infinity ? earliest : null;
  const end = isTime(base.endedAt) ? base.endedAt : null;
  const result = { from, generation: gen, rule: SPLIT_RULE, cuts: bounds, pieces: [] };
  if (!bounds.length) {
    result.pieces.push({ k: 1, start, end, meta: { ...base }, carried: [], lines: byPiece[0], closing: null });
    return result;
  }
  const roster = new Map(Object.entries(isPlain(base.roster) ? base.roster : {}));
  const tables = new Map(Object.entries(isPlain(base.tables) ? base.tables : {}));
  const known = new Known(lines, roster, tables);
  const n = byPiece.length;
  for (let index = 0; index < n; index++) {
    const k = index + 1;
    try {
      const pieceStart = index ? bounds[index - 1] : start;
      const pieceEnd = k < n ? bounds[index] : end;
      const boot = `split-g${gen}-k${k}`;
      const pieceLines = byPiece[index];
      let carried = [];
      if (index) {
        known.until(pieceStart);
        const cited = new Set(), arrivals = new Set();
        for (const e of pieceLines) {
          if (!isLine(e) || isTrue(e.carried)) continue;
          for (const person of citedOf(citedIds, e)) cited.add(person);
          if (e.ev === 'person.joined' && isId(e.tableId)) arrivals.add(e.tableId);
        }
        carried = known.carried({ start: pieceStart, boot, cited, arrivals });
      }
      let closing = null;
      if (k < n) {
        const seq = pieceLines.reduce((max, e) => (Number.isFinite(e?.seq) ? Math.max(max, e.seq) : max), 0) + 1;
        closing = { by: 'auto', reason: 'morning', split: true, ...(isTime(at) ? { at } : {}), v: FORMAT, seq, t: pieceEnd, ev: 'evening.closed', boot };
      }
      const piece = { k, start: pieceStart, end: pieceEnd, meta: null, carried, lines: pieceLines, closing };
      piece.meta = pieceMeta({ meta: base, events: pieceJournal(piece), start: pieceStart, end: pieceEnd, citedIds,
        eveningId: k < n ? null : from, split: { from, part: k, generation: gen, rule: SPLIT_RULE } });
      result.pieces.push(piece);
    } catch (error) { throw inPart(error, k); }
  }
  return result;
}

// Lignes du journal d'un morceau, dans l'ordre où elles s'écrivent : lignes
// reportées, lignes du morceau, ligne de clôture.
function pieceJournal(piece) {
  return [...(piece?.carried || []), ...(piece?.lines || []), ...(piece?.closing ? [piece.closing] : [])];
}

// Empreinte de l'identifiant du morceau k au j-ième essai (A4,
// « Identifiants ») : quatre chiffres hexadécimaux tirés de (identifiant
// d'origine, k, j), par FNV-1a. Le même calcul la redonne après un arrêt.
function splitFingerprint(from, k, j) {
  if (!Number.isInteger(k) || k < 1 || !Number.isInteger(j) || j < 1) throw new RangeError('splitFingerprint : k et j entiers ≥ 1 attendus.');
  const text = `${String(from)}\u0000${k}\u0000${j}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash >>>= 0;
  return ((hash ^ (hash >>> 16)) & 0xffff).toString(16).padStart(4, '0');
}

module.exports = { SPLIT_RULE, planSplit, pieceJournal, pieceMeta, splitFingerprint };
