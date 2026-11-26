'use strict';
/*
 * Bornes des soirées : la règle pure de fin de soirée, la même pour la
 * clôture en direct (eveningOver, server.js) et pour la réparation des
 * journaux fusionnés (eveningBreaks, puis evening-split.js). Aucune
 * dépendance, aucun accès disque, aucune écriture : l'heure et le fuseau
 * viennent de l'appelant.
 *
 * - Une soirée se termine le matin. Son point de clôture C est le premier
 *   instant calme à partir de M, le premier 8 h locale (MORNING_HOUR)
 *   strictement après sa première activité (morningAfter).
 * - Activité (ACTIVITY_TYPES) : stage.started, song.requested, person.joined,
 *   et table.opened d'une table ordinaire. Ni « En solo », que
 *   ensureSoloGroup() recrée à chaque soirée (table.opened individual: true),
 *   ni les lignes reportées (carried: true), ni les signes de vie des
 *   téléphones (person.seen). Un booléen n'est vrai que s'il vaut true. Les
 *   places provisoires (« Solo N » sans prénom) n'écrivent rien au journal ;
 *   en mémoire, elles ne comptent pas.
 * - Calme à l'instant t : aucun titre commencé ou relancé (stage.started,
 *   stage.restarted) dans les QUIET_MS (60 min) qui précèdent t. Aucune
 *   condition sur la fin des titres : computeStats tient un titre pour fini
 *   au plus tard 20 min après son début (MAX_SONG_SEC, evening-stats.js), et
 *   une fin notée tard (retour de KaraFun) ne retient pas la soirée.
 * - Chaque ligne compte à son heure t, pas à sa place dans le journal ; la
 *   règle ne lit que les débuts et les relances notés jusqu'à C : en direct
 *   comme à la réparation, une même première activité donne le même C.
 * - Une heure hors des dates que Date accepte (± 8,64e15 ms, isTime), d'une
 *   ligne ou de la mémoire, se lit comme absente : ni activité, ni début de
 *   titre, ni date locale (localParts), ni 8 h (morningAfter), comme un 8 h
 *   qui sortirait de ces dates. Rien ne lève (journal abîmé).
 *
 * Fuseau : celui de meta.timezone s'il est valide, sinon celui du processus
 * (safeTimeZone, localParts : jamais d'erreur). Le module n'écrit rien :
 * quand safeTimeZone rend replaced: true, l'appelant écrit une ligne au
 * journal du serveur, une fois par soirée.
 *
 * Mémoire (`state`) d'eveningOver, de somethingToClose et de firstActivityOf,
 * chaque champ facultatif : tables (liste ou Map de { individual, createdAt }),
 * people (liste ou Map de { nameRequired, joinedAt }), songs (titres en
 * liste) et sent (titres envoyés ou en cours d'envoi), en nombre ou en liste.
 *
 * Le morceau en cours : `startedAt` est son début (meta.startedAt), `split`
 * son meta.split s'il vient d'un découpage.
 */

const MORNING_HOUR = 8;
const QUIET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Heure que Date accepte (± 8,64e15 ms autour de 1970, comme isTime
// d'evening-journal.js) : au-delà, Intl et toISOString lèvent.
const MAX_TIME = 8.64e15;
const isTime = value => Number.isFinite(value) && Math.abs(value) <= MAX_TIME;

// Types d'événement qui sont une activité (table.opened : table ordinaire
// seulement). Chaque type écrit par le code est rangé ici ou dans
// NOT_ACTIVITY_TYPES (test/evening-stats.test.js, règle « Gardes des listes »).
const ACTIVITY_TYPES = Object.freeze(['stage.started', 'song.requested', 'person.joined', 'table.opened']);
const ACTIVITY = new Set(ACTIVITY_TYPES);
const TITLE_STARTS = new Set(['stage.started', 'stage.restarted']);

// Champ booléen d'une ligne : vrai seulement s'il vaut true ('false', 0, 1 ou
// null se lisent comme absents, A7 : champs de mauvais type).
const isTrue = value => value === true;
const isActivity = e => !!e && ACTIVITY.has(e.ev) && isTime(e.t) && !isTrue(e.carried) &&
  !(e.ev === 'table.opened' && isTrue(e.individual));
const isTitleStart = e => !!e && TITLE_STARTS.has(e.ev) && isTime(e.t) && !isTrue(e.carried);

// Liste, Map (ses valeurs) ou autre itérable ; sinon liste vide.
function listOf(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (value != null && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') return [...value];
  return [];
}
const countOf = value => typeof value === 'number' ? (Number.isFinite(value) ? value : 0) : listOf(value).length;

// --------------------------------------------------------------- fuseau
// Un formateur gardé par fuseau ; les fuseaux refusés par Intl sont retenus.
const PARTS = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' };
const CACHE_MAX = 200;
const formatters = new Map();
const refused = new Set();

function formatterOf(zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { ...PARTS, timeZone: zone });
    if (formatters.size >= CACHE_MAX) formatters.clear();
    formatters.set(zone, formatter);
  }
  return formatter;
}

// Fuseau du processus, relu à chaque appel (TZ peut changer en cours de route).
function processZone() {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) { formatterOf(zone); return zone; }
  } catch { /* fuseau du processus illisible : UTC */ }
  return 'UTC';
}

// { zone, replaced } : le fuseau donné s'il est valide, sinon celui du
// processus. replaced est vrai pour un fuseau refusé par Intl (ou qui n'est
// pas une chaîne), faux pour un fuseau absent. Ne lève jamais.
function safeTimeZone(zone) {
  if (zone === undefined || zone === null || zone === '') return { zone: processZone(), replaced: false };
  if (typeof zone === 'string' && !refused.has(zone)) {
    try {
      return { zone: formatterOf(zone).resolvedOptions().timeZone, replaced: false };
    } catch {
      if (refused.size >= CACHE_MAX) refused.clear();
      refused.add(zone);
    }
  }
  return { zone: processZone(), replaced: true };
}

// Date et heure locales de `t` au fuseau donné (vérifié par safeTimeZone) :
// { year, month, day, hour, minute, second }, ou null sans heure valide
// (isTime).
function localParts(t, timeZone) {
  if (!isTime(t)) return null;
  const parts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const { type, value } of formatterOf(safeTimeZone(timeZone).zone).formatToParts(t)) {
    switch (type) {
      case 'year': parts.year = Number(value); break;
      case 'month': parts.month = Number(value); break;
      case 'day': parts.day = Number(value); break;
      case 'hour': parts.hour = Number(value); break;
      case 'minute': parts.minute = Number(value); break;
      case 'second': parts.second = Number(value); break;
      default: break;
    }
  }
  return parts;
}

// Instant où il est `hour` heures le jour local donné, au fuseau `zone` ;
// null hors des dates possibles.
function zonedTime(year, month, day, hour, zone) {
  const wanted = Date.UTC(year, month - 1, day, hour);
  let at = wanted;
  for (let i = 0; i < 4; i++) {
    const p = localParts(at, zone);
    if (!p) return null;
    const gap = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wanted;
    if (gap === 0) break;
    at -= gap;
  }
  return at;
}

// Le prochain 8 h locale strictement après `t`, par Intl : juste sous TZ=UTC
// comme aux changements d'heure. Null sans heure valide, ou si ce 8 h sort
// des dates possibles.
function morningAfter(t, timeZone) {
  if (!isTime(t)) return null;
  const { zone } = safeTimeZone(timeZone);
  const p = localParts(t, zone);
  const first = p.hour < MORNING_HOUR ? 0 : 1;
  for (let extra = 0; extra < 3; extra++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + first + extra));
    const at = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), MORNING_HOUR, zone);
    if (isTime(at) && at > t) return at;
  }
  return isTime(t + DAY_MS) ? t + DAY_MS : null;
}

// ----------------------------------------------------------------- règle
// Premier indice d'une liste triée dont la valeur dépasse `value`.
function firstAbove(sorted, value) {
  let low = 0, high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] > value) high = mid; else low = mid + 1;
  }
  return low;
}

const sortedTimes = (lines, keep) => {
  const times = [];
  for (const e of lines) if (keep(e)) times.push(e.t);
  return times.sort((a, b) => a - b);
};

// Premier instant calme à partir de `from` : un titre commencé ou relancé
// dans l'heure qui précède (60 min tout juste avant ne compte plus) le
// repousse à ce titre + QUIET_MS. Les débuts sont triés : chaque titre
// suivant qui n'est pas après l'instant trouvé tombe dans son heure.
function calmFrom(from, starts) {
  let at = from;
  for (let i = firstAbove(starts, from - QUIET_MS); i < starts.length && starts[i] <= at; i++) at = starts[i] + QUIET_MS;
  return at;
}

const atOrAfter = (t, startedAt) => Number.isFinite(startedAt) ? Math.max(t, startedAt) : t;

// Point de clôture C : le premier instant calme à partir du premier 8 h qui
// suit la première activité, jamais avant le début du morceau (`startedAt`) ;
// null sans ce 8 h (morningAfter).
function closurePoint({ firstActivityAt, events = [], timeZone, startedAt } = {}) {
  const morning = morningAfter(firstActivityAt, timeZone);
  if (morning === null) return null;
  return calmFrom(atOrAfter(morning, startedAt), sortedTimes(listOf(events), isTitleStart));
}

// « Quelque chose à clore » : tables ordinaires, inscrits nommés, titres en
// liste, titres envoyés ou en cours d'envoi, ou une activité dans le journal.
// « En solo » seul ne compte pas.
function somethingToClose({ events = [], state = null } = {}) {
  const memory = state || {};
  if (listOf(memory.tables).some(table => table && !table.individual)) return true;
  if (listOf(memory.people).some(person => person && !person.nameRequired)) return true;
  if (countOf(memory.songs) > 0 || countOf(memory.sent) > 0) return true;
  return listOf(events).some(isActivity);
}

// Première activité du morceau en cours, lignes reportées exclues. Dans un
// morceau découpé, une activité datée d'avant son début compte à son début.
// Sans activité à lui, la mémoire le date : la plus ancienne création de
// table ordinaire ou inscription d'une personne nommée. Sinon null.
function firstActivityOf({ events = [], state = null, startedAt, split } = {}) {
  let first = Infinity;
  for (const e of listOf(events)) if (isActivity(e) && e.t < first) first = e.t;
  if (first < Infinity) return split ? atOrAfter(first, startedAt) : first;
  const memory = state || {};
  for (const table of listOf(memory.tables)) {
    if (table && !table.individual && isTime(table.createdAt) && table.createdAt < first) first = table.createdAt;
  }
  for (const person of listOf(memory.people)) {
    if (person && !person.nameRequired && isTime(person.joinedAt) && person.joinedAt < first) first = person.joinedAt;
  }
  return first < Infinity ? first : null;
}

// La soirée en cours est-elle finie à `now` ? { at: C, reason: 'morning',
// activityAfter, firstActivityAt } dès que C ≤ now, sinon null. `events` est
// le journal du morceau en cours, lignes reportées comprises ; activityAfter
// dit s'il a une activité postérieure à C (découpage plutôt que remise à zéro).
function eveningOver({ events = [], state = null, startedAt, split, now, timeZone } = {}) {
  if (!Number.isFinite(now) || !somethingToClose({ events, state })) return null;
  const firstActivityAt = firstActivityOf({ events, state, startedAt, split });
  if (firstActivityAt == null) return null;
  const at = closurePoint({ firstActivityAt, events, timeZone, startedAt });
  if (at == null || at > now) return null;
  const activityAfter = listOf(events).some(e => isActivity(e) && e.t > at);
  return { at, reason: 'morning', activityAfter, firstActivityAt };
}

// Lignes d'un journal rangées par coupures : le morceau k va de la coupure
// k-1 (exclue) à la coupure k (comprise), chaque ligne selon son heure t,
// dans l'ordre du journal (celui des seq). Une ligne sans heure reste avec
// celle qui la précède.
function piecesOf({ events = [], cuts = [] } = {}) {
  const bounds = listOf(cuts).filter(Number.isFinite).sort((a, b) => a - b);
  const pieces = Array.from({ length: bounds.length + 1 }, () => []);
  let k = 0;
  for (const e of listOf(events)) {
    if (Number.isFinite(e?.t)) {
      let low = 0, high = bounds.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (bounds[mid] < e.t) low = mid + 1; else high = mid;
      }
      k = low;
    }
    pieces[k].push(e);
  }
  return pieces;
}

// Coupures d'un journal fusionné : partant de la première activité, C ; s'il
// reste une activité après C, coupure à C, puis la même règle à partir de la
// première activité qui suit. Rend { cuts, pieces } (piecesOf). `startedAt`
// et `split`, facultatifs, sont ceux du morceau réparé, comme pour eveningOver.
function eveningBreaks({ events = [], timeZone, startedAt, split } = {}) {
  const lines = listOf(events);
  const { zone } = safeTimeZone(timeZone);
  const activity = sortedTimes(lines, isActivity);
  const starts = sortedTimes(lines, isTitleStart);
  const cuts = [];
  for (let i = 0; i < activity.length;) {
    const first = cuts.length ? activity[i] : (split ? atOrAfter(activity[i], startedAt) : activity[i]);
    const morning = morningAfter(first, zone);
    if (morning === null) break; // aucun 8 h après elle dans les dates possibles
    const at = calmFrom(cuts.length ? morning : atOrAfter(morning, startedAt), starts);
    i = firstAbove(activity, at);
    if (i >= activity.length) break;
    cuts.push(at);
  }
  return { cuts, pieces: piecesOf({ events: lines, cuts }) };
}

// Une coupure du morceau en cours est-elle permise ? Toujours, dans une
// soirée jamais découpée ; dans un morceau découpé, seulement après son
// début (meta.startedAt) : un découpage n'est jamais refait.
function cutAllowed({ at, startedAt, split } = {}) {
  if (!Number.isFinite(at)) return false;
  if (!split) return true;
  return Number.isFinite(startedAt) && at > startedAt;
}

module.exports = {
  MORNING_HOUR, QUIET_MS, ACTIVITY_TYPES, isTime, isActivity, safeTimeZone, localParts, morningAfter, closurePoint,
  somethingToClose, firstActivityOf, eveningOver, piecesOf, eveningBreaks, cutAllowed,
};
