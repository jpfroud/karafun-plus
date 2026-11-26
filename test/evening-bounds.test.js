'use strict';
// Bornes des soirées (evening-bounds.js, plan du 8 novembre, A1 ; essais
// d'A7) : la règle pure de fin de soirée, la même pour la clôture en direct
// (eveningOver) et pour la réparation des journaux fusionnés (eveningBreaks).
// Une soirée se termine le matin à 8 h locale, au premier instant calme
// (aucun titre commencé ou relancé depuis 60 min) qui suit le premier 8 h
// après sa première activité.
//
// process.env.TZ est changé en cours d'exécution, puis toujours rendu (comme
// dans fuseau.test.js). Les heures sont écrites avec leur décalage : +02:00
// pour Paris jusqu'au 25 octobre 2026, +01:00 ensuite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bounds = require('../evening-bounds');
const { computeStats } = require('../evening-stats');

const {
  MORNING_HOUR, QUIET_MS, ACTIVITY_TYPES, isActivity, safeTimeZone, localParts, morningAfter, closurePoint,
  somethingToClose, firstActivityOf, eveningOver, eveningBreaks, cutAllowed,
} = bounds;

const MIN = 60000;
const H = 60 * MIN;
const PARIS = 'Europe/Paris';
// Heure de Paris en octobre 2026, avant le passage à l'heure d'hiver.
const P = local => Date.parse(`${local}+02:00`);

const ORIGINAL_TZ = process.env.TZ;
const ORIGINAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Exécute `run` sous le fuseau `zone`, puis rend la valeur d'origine de TZ
// (copie de fuseau.test.js, qui n'exporte rien).
function inZone(zone, run) {
  process.env.TZ = zone;
  try {
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, zone, `fuseau ${zone} pris en compte`);
    return run();
  } finally {
    if (ORIGINAL_TZ === undefined) { process.env.TZ = ORIGINAL_ZONE; delete process.env.TZ; }
    else process.env.TZ = ORIGINAL_TZ;
  }
}
function assertRestored() {
  assert.equal(process.env.TZ, ORIGINAL_TZ, 'TZ d’origine rendue');
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, ORIGINAL_ZONE, 'fuseau d’origine rendu');
}

// Journal synthétique : lignes [heure, type, champs], numérotées dans l'ordre donné.
function journal(rows, boot = 'b1') {
  let seq = 0;
  return rows.map(([t, ev, fields = {}]) => ({ v: 1, seq: ++seq, t, ev, boot, ...fields }));
}
// Ouverture d'une soirée à `t` : « En solo » recréé au démarrage, la table 1 et p1.
const opening = t => [
  [t, 'evening.started', { rules: {} }],
  [t, 'app.started', { restored: false, offlineMs: 0 }],
  [t, 'table.opened', { tableId: 'Comptoir', individual: true }],
  [t + MIN, 'table.opened', { tableId: '1', individual: false }],
  [t + MIN, 'person.joined', { personId: 'p1', tableId: '1' }],
];
// Un titre demandé 2 min avant de commencer sur scène, à `t`.
let entries = 0;
function title(t, personId = 'p1', fields = {}) {
  const entryId = `e${++entries}`;
  return [
    [t - 2 * MIN, 'song.requested', { personId, entryId, title: entryId, mode: 'append' }],
    [t, 'stage.started', { queueId: entries, entryId, ids: [personId], ownerId: personId, source: 'queue', title: entryId, ...fields }],
  ];
}
const upTo = (events, t) => events.filter(e => e.t <= t);
const seqs = list => list.map(e => e.seq);

test('A1 : constantes et types d’activité', () => {
  assert.equal(MORNING_HOUR, 8);
  assert.equal(QUIET_MS, 60 * MIN);
  assert.deepEqual([...ACTIVITY_TYPES].sort(), ['person.joined', 'song.requested', 'stage.started', 'table.opened']);
  assert.ok(Object.isFrozen(ACTIVITY_TYPES), 'liste figée');
});

test('A1 : frontière de 8 h sous TZ=UTC pour Europe/Paris, passage à l’heure d’hiver et à l’heure d’été', () => {
  const rows = () => ({
    // 8 h strictement après t : 7 h 59 min 59,999 s donne 8 h le jour même, 8 h tout juste le lendemain.
    before: morningAfter(P('2026-10-16T07:59:59.999'), PARIS),
    exactly: morningAfter(P('2026-10-16T08:00:00.000'), PARIS),
    evening: morningAfter(P('2026-10-15T20:00'), PARIS),
    // Nuit du 24 au 25 octobre 2026 : 3 h (heure d'été) devient 2 h (heure d'hiver).
    winterNight: morningAfter(P('2026-10-24T21:00'), PARIS),
    winterLate: morningAfter(P('2026-10-25T01:30'), PARIS),
    winterDay: morningAfter(Date.parse('2026-10-25T10:00+01:00'), PARIS),
    // Nuit du 27 au 28 mars 2027 : 2 h (heure d'hiver) devient 3 h (heure d'été).
    summerNight: morningAfter(Date.parse('2027-03-27T22:00+01:00'), PARIS),
    summerDay: morningAfter(Date.parse('2027-03-28T09:00+02:00'), PARIS),
    utc: morningAfter(Date.parse('2026-10-16T07:30Z'), 'UTC'),
    processZone: morningAfter(Date.parse('2026-10-16T07:30Z')),
    parts: localParts(Date.parse('2026-10-25T08:00+01:00'), PARIS),
  });
  const utc = inZone('UTC', rows);
  const paris = inZone(PARIS, rows);
  assertRestored();
  assert.equal(utc.before, Date.parse('2026-10-16T06:00Z'));
  assert.equal(utc.exactly, Date.parse('2026-10-17T06:00Z'));
  assert.equal(utc.evening, Date.parse('2026-10-16T06:00Z'));
  assert.equal(utc.winterNight, Date.parse('2026-10-25T07:00Z'), '8 h à l’heure d’hiver, le matin du changement');
  assert.equal(utc.winterLate, Date.parse('2026-10-25T07:00Z'));
  assert.equal(utc.winterDay, Date.parse('2026-10-26T07:00Z'));
  assert.equal(utc.summerNight, Date.parse('2027-03-28T06:00Z'), '8 h à l’heure d’été, le matin du changement');
  assert.equal(utc.summerDay, Date.parse('2027-03-29T06:00Z'));
  assert.equal(utc.utc, Date.parse('2026-10-16T08:00Z'));
  assert.equal(utc.processZone, Date.parse('2026-10-16T08:00Z'), 'sans fuseau : celui du processus (UTC)');
  assert.deepEqual(utc.parts, { year: 2026, month: 10, day: 25, hour: 8, minute: 0, second: 0 });
  // Le fuseau donné ne dépend pas de celui du processus ; sans fuseau, Paris.
  assert.deepEqual({ ...paris, processZone: utc.processZone }, utc);
  assert.equal(paris.processZone, Date.parse('2026-10-17T08:00+02:00'), '7 h 30 UTC : 9 h 30 à Paris, 8 h le lendemain');
});

test('A1 : karaoké qui continue après 8 h : clôture et coupure à 9 h 55, dans closurePoint comme dans eveningBreaks', () => {
  const events = journal([
    ...opening(P('2026-10-15T19:00')),
    ...title(P('2026-10-15T22:00')),
    ...title(P('2026-10-16T07:50')), ...title(P('2026-10-16T08:10')), ...title(P('2026-10-16T08:55')),
    ...title(P('2026-10-16T20:00')),
  ]);
  const C = P('2026-10-16T09:55');
  assert.equal(closurePoint({ firstActivityAt: P('2026-10-15T19:00'), events, timeZone: PARIS }), C);
  const { cuts, pieces } = eveningBreaks({ events, timeZone: PARIS });
  assert.deepEqual(cuts, [C]);
  assert.equal(pieces.length, 2);
  assert.ok(pieces[0].every(e => e.t <= C) && pieces[1].every(e => e.t > C));
  assert.deepEqual(pieces[1].map(e => e.ev), ['song.requested', 'stage.started'], 'le titre de 20 h ouvre le second morceau');
  // En direct : pas avant 9 h 55, et jamais repoussé au lendemain.
  assert.equal(eveningOver({ events: upTo(events, C - 1), now: C - 1, timeZone: PARIS }), null);
  assert.deepEqual(eveningOver({ events: upTo(events, C), now: C, timeZone: PARIS }),
    { at: C, reason: 'morning', activityAfter: false, firstActivityAt: P('2026-10-15T19:01') });
});

test('A1 : soirée vide, « En solo » créé au démarrage compris : jamais close', () => {
  const events = journal(opening(P('2026-10-15T19:00')).slice(0, 3));
  const state = {
    tables: new Map([['Comptoir', { id: 'Comptoir', individual: true, createdAt: P('2026-10-15T19:00') }]]),
    // Place provisoire : QR individuel ouvert, prénom pas encore saisi.
    people: new Map([['x', { id: 'x', name: 'Solo 1', tableId: 'Comptoir', nameRequired: true, joinedAt: P('2026-10-15T20:00') }]]),
  };
  assert.equal(somethingToClose({ events, state }), false);
  assert.equal(firstActivityOf({ events, state }), null);
  for (const now of [P('2026-10-16T08:00'), P('2026-10-18T12:00')]) {
    assert.equal(eveningOver({ events, state, now, timeZone: PARIS }), null);
  }
  assert.deepEqual(eveningBreaks({ events, timeZone: PARIS }).cuts, []);
});

test('A1 : soirée faite seulement d’inscriptions : close le lendemain au premier calme après 8 h', () => {
  const events = journal([
    [P('2026-10-15T19:00'), 'table.opened', { tableId: 'Comptoir', individual: true }],
    [P('2026-10-15T21:00'), 'person.joined', { personId: 's1', tableId: 'Comptoir' }],
    [P('2026-10-15T21:10'), 'person.joined', { personId: 's2', tableId: 'Comptoir' }],
  ]);
  const M = P('2026-10-16T08:00');
  assert.equal(eveningOver({ events, now: M - 1, timeZone: PARIS }), null);
  assert.deepEqual(eveningOver({ events, now: M, timeZone: PARIS }),
    { at: M, reason: 'morning', activityAfter: false, firstActivityAt: P('2026-10-15T21:00') });
  // Mémoire seule (journal sans activité) : même heure.
  const state = { people: [{ id: 's1', name: 'Léa', tableId: 'Comptoir', joinedAt: P('2026-10-15T21:00') }] };
  assert.deepEqual(eveningOver({ events: events.slice(0, 1), state, now: M + H, timeZone: PARIS }),
    { at: M, reason: 'morning', activityAfter: false, firstActivityAt: P('2026-10-15T21:00') });
});

test('A1 : tables sans inscription : closes au premier calme après 8 h (QR révoqués par la remise à zéro, A2)', () => {
  const events = journal([
    [P('2026-10-15T19:00'), 'table.opened', { tableId: 'Comptoir', individual: true }],
    [P('2026-10-15T19:05'), 'table.opened', { tableId: '1', individual: false }],
    [P('2026-10-15T19:06'), 'table.opened', { tableId: '2', individual: false }],
  ]);
  const M = P('2026-10-16T08:00');
  assert.equal(eveningOver({ events, now: M - 1, timeZone: PARIS }), null);
  assert.equal(eveningOver({ events, now: M, timeZone: PARIS }).at, M);
  // Tables restées en mémoire, journal sans activité.
  const state = { tables: [{ id: 'Comptoir', individual: true, createdAt: P('2026-10-15T19:00') },
    { id: '1', individual: false, createdAt: P('2026-10-15T19:05') }] };
  assert.equal(eveningOver({ events: events.slice(0, 1), state, now: M, timeZone: PARIS }).at, M);
});

test('A1 : téléphone vu à 9 h : ne retient pas la soirée', () => {
  const events = journal([
    ...opening(P('2026-10-15T20:00')),
    ...title(P('2026-10-15T23:00')),
    [P('2026-10-16T09:00'), 'person.seen', { personId: 'p1' }],
  ]);
  assert.deepEqual(eveningOver({ events, now: P('2026-10-16T09:05'), timeZone: PARIS }),
    { at: P('2026-10-16T08:00'), reason: 'morning', activityAfter: false, firstActivityAt: P('2026-10-15T20:01') });
  assert.deepEqual(eveningBreaks({ events, timeZone: PARIS }).cuts, [], 'rien à couper : aucune activité après 8 h');
});

test('A1 : fin de titre notée au retour de KaraFun : coupure à 8 h, tables de 18 h 30 dans le second morceau', () => {
  const events = journal([
    ...opening(P('2026-10-15T20:00')),
    ...title(P('2026-10-16T01:50')),
    [P('2026-10-16T02:00'), 'karaoke.phase', { phase: 'offline', blocker: 'offline' }],
    [P('2026-10-16T18:30'), 'table.opened', { tableId: '2', individual: false }],
    [P('2026-10-16T18:31'), 'person.joined', { personId: 'p2', tableId: '2' }],
    [P('2026-10-16T19:00'), 'karaoke.phase', { phase: 'between', blocker: null }],
    [P('2026-10-16T19:00'), 'stage.ended', { queueId: entries, playedSec: 200 }],
  ]);
  const C = P('2026-10-16T08:00');
  const { cuts, pieces } = eveningBreaks({ events, timeZone: PARIS });
  assert.deepEqual(cuts, [C], 'attendre la fin notée aurait donné 19 h');
  assert.deepEqual(pieces[1].map(e => e.ev), ['table.opened', 'person.joined', 'karaoke.phase', 'stage.ended']);
  // En direct, à 8 h, avec le journal de ce moment : le même C.
  assert.deepEqual(eveningOver({ events: upTo(events, C), now: C, timeZone: PARIS }),
    { at: C, reason: 'morning', activityAfter: false, firstActivityAt: P('2026-10-15T20:01') });
  // Plus tard, le journal entier : même C, avec une activité après lui.
  assert.deepEqual(eveningOver({ events, now: P('2026-10-16T19:05'), timeZone: PARIS }),
    { at: C, reason: 'morning', activityAfter: true, firstActivityAt: P('2026-10-15T20:01') });
});

test('A1 : titre sans durée connue resté sur scène sans fin notée : C = 8 h 30, plus en cours pour computeStats à 8 h 29', () => {
  // KaraFun en pause sur le titre de 7 h 30 jusqu'à 9 h 30, sans fin notée.
  const events = journal([...opening(P('2026-10-15T20:00')), ...title(P('2026-10-16T07:30'))]);
  assert.equal(events.at(-1).durationSec, undefined);
  const C = P('2026-10-16T08:30');
  assert.equal(closurePoint({ firstActivityAt: P('2026-10-15T20:01'), events, timeZone: PARIS }), C);
  assert.equal(eveningOver({ events, now: C - MIN, timeZone: PARIS }), null);
  assert.equal(eveningOver({ events, now: C, timeZone: PARIS }).at, C);
  // La durée maximale des statistiques (20 min) passe sous QUIET_MS : en
  // direct à 8 h 29, le titre n'est plus en cours et finit au plus tard à 7 h 50.
  const stats = computeStats({ events, now: C - MIN, live: true });
  const stage = stats.timeline.stages.at(-1);
  assert.equal(stage.start, P('2026-10-16T07:30'));
  assert.equal(stage.ongoing, false, 'plus sur scène pour les statistiques');
  assert.ok(stage.end <= P('2026-10-16T07:50'), `fin au plus tard à 7 h 50 (${new Date(stage.end).toISOString()})`);
  assert.ok(stage.end - stage.start < QUIET_MS);
});

test('A1 : titre relancé par le bar à 8 h 10 : eveningOver nul à 8 h 20, puis C = 9 h 10, comme eveningBreaks', () => {
  const first = title(P('2026-10-16T07:20'));
  const events = journal([
    ...opening(P('2026-10-15T20:00')),
    ...first,
    [P('2026-10-16T08:10'), 'stage.restarted', { queueId: first[1][2].queueId, entryId: first[1][2].entryId, by: 'staff' }],
    ...title(P('2026-10-16T20:00')),
  ]);
  const C = P('2026-10-16T09:10');
  assert.equal(eveningOver({ events: upTo(events, P('2026-10-16T08:20')), now: P('2026-10-16T08:20'), timeZone: PARIS }), null,
    'sans compter la relance, C vaudrait 8 h 20');
  assert.equal(eveningOver({ events: upTo(events, C), now: C, timeZone: PARIS }).at, C);
  assert.equal(closurePoint({ firstActivityAt: P('2026-10-15T20:01'), events, timeZone: PARIS }), C);
  assert.deepEqual(eveningBreaks({ events, timeZone: PARIS }).cuts, [C]);
});

test('A1 : borne du calme, M = 8 h : titre à 7 h 00 tout juste, C = 8 h ; à 7 h 00 et 1 ms, C = 8 h et 1 ms', () => {
  for (const [start, C] of [[P('2026-10-16T07:00'), P('2026-10-16T08:00')], [P('2026-10-16T07:00') + 1, P('2026-10-16T08:00') + 1]]) {
    const events = journal([...opening(P('2026-10-15T20:00')), ...title(start), ...title(P('2026-10-16T20:00'))]);
    assert.equal(closurePoint({ firstActivityAt: P('2026-10-15T20:01'), events, timeZone: PARIS }), C, new Date(start).toISOString());
    assert.deepEqual(eveningBreaks({ events, timeZone: PARIS }).cuts, [C], new Date(start).toISOString());
  }
});

test('A1 : dernier morceau réparé fait seulement de lignes reportées, avec la mémoire de la veille : clos, jamais avant son début', () => {
  const startedAt = P('2026-10-16T09:55');
  const split = { from: '2026-10-15_2000_ab12', part: 2, generation: 1, rule: 'v1', cut: startedAt };
  const events = journal([
    [startedAt, 'evening.started', { rules: {}, carried: true }],
    [startedAt, 'karaoke.phase', { phase: 'silent', blocker: 'empty', carried: true }],
    [startedAt, 'table.opened', { tableId: '1', individual: false, carried: true }],
    [startedAt, 'person.joined', { personId: 'p1', tableId: '1', carried: true }],
  ], 'reparation');
  const state = {
    tables: [{ id: 'Comptoir', individual: true, createdAt: startedAt }, { id: '1', individual: false, createdAt: P('2026-10-15T20:01') }],
    people: [{ id: 'p1', name: 'Léa', tableId: '1', joinedAt: P('2026-10-15T20:01') }],
  };
  assert.equal(somethingToClose({ events, state: null }), false, 'les lignes reportées ne sont pas une activité');
  assert.equal(firstActivityOf({ events, state, startedAt, split }), P('2026-10-15T20:01'), 'daté par la mémoire de la veille');
  const now = P('2026-10-16T10:30');
  assert.deepEqual(eveningOver({ events, state, startedAt, split, now, timeZone: PARIS }),
    { at: startedAt, reason: 'morning', activityAfter: false, firstActivityAt: P('2026-10-15T20:01') },
    'C = 8 h aurait fini l’archive avant son début');
  assert.equal(eveningOver({ events, state, startedAt, split, now: startedAt - 1, timeZone: PARIS }), null);
});

test('A1 : fuseau absent, invalide ou inconnu dans meta.timezone : fuseau du processus, sans erreur', () => {
  const t = Date.parse('2026-10-16T05:30Z');
  const read = () => ({
    zones: ['Bad/Zone', 'Foo/Bar', PARIS, 'europe/paris', undefined, null, '', 42, {}].map(safeTimeZone),
    parts: ['Bad/Zone', 'Foo/Bar', undefined].map(zone => localParts(t, zone)),
    mornings: ['Bad/Zone', 'Foo/Bar', undefined, null].map(zone => morningAfter(t, zone)),
    over: eveningOver({ events: journal(opening(P('2026-10-15T20:00'))), now: P('2026-10-17T12:00'), timeZone: 'Bad/Zone' }),
    breaks: eveningBreaks({ events: journal(opening(P('2026-10-15T20:00'))), timeZone: 'Foo/Bar' }).cuts,
  });
  const utc = inZone('UTC', read);
  const paris = inZone(PARIS, read);
  assertRestored();
  assert.deepEqual(utc.zones, [
    { zone: 'UTC', replaced: true }, { zone: 'UTC', replaced: true }, { zone: PARIS, replaced: false },
    { zone: PARIS, replaced: false }, { zone: 'UTC', replaced: false }, { zone: 'UTC', replaced: false },
    { zone: 'UTC', replaced: false }, { zone: 'UTC', replaced: true }, { zone: 'UTC', replaced: true }]);
  assert.deepEqual(paris.zones.slice(0, 2), [{ zone: PARIS, replaced: true }, { zone: PARIS, replaced: true }],
    'remplacé par le fuseau du processus du moment');
  for (const parts of utc.parts) assert.deepEqual(parts, { year: 2026, month: 10, day: 16, hour: 5, minute: 30, second: 0 });
  for (const parts of paris.parts) assert.deepEqual(parts, { year: 2026, month: 10, day: 16, hour: 7, minute: 30, second: 0 });
  assert.deepEqual(utc.mornings, Array(4).fill(Date.parse('2026-10-16T08:00Z')));
  assert.deepEqual(paris.mornings, Array(4).fill(Date.parse('2026-10-16T06:00Z')));
  assert.equal(utc.over.at, Date.parse('2026-10-16T08:00Z'));
  assert.equal(paris.over.at, P('2026-10-16T08:00'));
  assert.deepEqual(utc.breaks, []);
});

test('A1 : heure hors des dates que Date accepte (au-delà de ±8,64e15 ms) : lue comme absente, sans erreur ; au dernier jour de ces dates, aucun 8 h après elle', () => {
  // Une ligne datée de 1e16 (journal abîmé) faisait lever eveningBreaks
  // (RangeError de formatToParts) : la réparation finissait en échec à
  // l'étape « lecture ». Les heures de la mémoire suivent la même règle.
  const MAX = 8.64e15;
  const t1 = Date.parse('2026-11-06T20:40:00+01:00');
  const M = Date.parse('2026-11-07T08:00:00+01:00');
  const events = [{ ev: 'song.requested', t: t1, seq: 1 }, { ev: 'song.requested', t: 1e16, seq: 2 }];
  const { cuts, pieces } = eveningBreaks({ events, timeZone: PARIS });
  assert.deepEqual(cuts, [], 'la ligne de 1e16 n’est pas une activité');
  assert.deepEqual(pieces.map(seqs), [[1, 2]], 'rien de perdu');
  assert.deepEqual(eveningOver({ events, now: M + H, timeZone: PARIS }),
    { at: M, reason: 'morning', activityAfter: false, firstActivityAt: t1 }, 'aucune activité après C');
  for (const t of [1e16, -1e16, MAX + 1, -MAX - 1]) {
    for (const ev of ACTIVITY_TYPES) assert.equal(isActivity({ ev, t, tableId: '1' }), false, `${ev} à ${t}`);
    assert.equal(localParts(t, PARIS), null, `localParts(${t})`);
    assert.equal(morningAfter(t, PARIS), null, `morningAfter(${t})`);
    assert.equal(closurePoint({ firstActivityAt: t, events, timeZone: PARIS }), null, `closurePoint(${t})`);
  }
  const state = {
    tables: [{ id: '1', individual: false, createdAt: -1e16 }, { id: '2', individual: false, createdAt: t1 }],
    people: [{ id: 'p1', name: 'Léa', tableId: '2', joinedAt: 1e16 }],
  };
  assert.equal(firstActivityOf({ events: [], state }), t1, 'la mémoire hors des dates ne date pas la soirée');
  // Bornes comprises : 8,64e15 se lit encore (13 septembre 275760, minuit
  // UTC), mais aucun 8 h ne le suit dans ces dates : rien à clore, rien ne lève.
  assert.deepEqual(localParts(MAX, 'UTC'), { year: 275760, month: 9, day: 13, hour: 0, minute: 0, second: 0 });
  assert.equal(morningAfter(MAX - 1, PARIS), null);
  const last = [events[0], { ev: 'song.requested', t: MAX - 1, seq: 2 }];
  assert.deepEqual(eveningBreaks({ events: last, timeZone: PARIS }).cuts, [M], 'une heure possible reste une activité');
  assert.equal(eveningOver({ events: last.slice(1), now: MAX, timeZone: PARIS }), null);
  // La règle commune, exportée (la même qu'isTime d'evening-journal.js).
  assert.deepEqual([MAX, -MAX, MAX + 1, -MAX - 1, NaN, Infinity, '1', null].map(t => bounds.isTime(t)),
    [true, true, false, false, false, false, false, false]);
});

test('A1 : identifiant de soirée au fuseau donné (localParts), sous TZ=UTC ; fuseau abîmé : celui du processus, sans erreur', () => {
  const { newEveningId, validEveningId } = require('../evening-journal');
  const at = Date.UTC(2026, 9, 15, 23, 30); // 1 h 30 le 16 octobre à Paris
  const ids = inZone('UTC', () => [newEveningId(at, 'beef', PARIS), newEveningId(at, 'beef'), newEveningId(at, 'beef', 'Bad/Zone'),
    newEveningId(Date.UTC(2026, 9, 25, 7, 5), 'beef', PARIS)]);
  assertRestored();
  assert.deepEqual(ids, ['2026-10-16_0130_beef', '2026-10-15_2330_beef', '2026-10-15_2330_beef', '2026-10-25_0805_beef']);
  for (const id of ids) assert.ok(validEveningId(id), id);
});

test('A1 : ligne datée avant C écrite après des lignes d’après C : rangée dans le morceau de son heure, seq dans l’ordre', () => {
  const C = P('2026-10-16T08:00');
  const events = journal([
    ...opening(P('2026-10-15T20:00')), // seq 1 à 5
    ...title(P('2026-10-15T23:00')), // 6, 7
    [P('2026-10-16T19:00'), 'table.opened', { tableId: '2', individual: false }], // 8
    [P('2026-10-16T19:05'), 'person.joined', { personId: 'p2', tableId: '2' }], // 9
    // Gardée avant l'ouverture (_flushEarly) : écrite après, datée de la nuit.
    [P('2026-10-16T01:00'), 'person.seen', { personId: 'p1' }], // 10
    [C, 'person.seen', { personId: 'p1' }], // 11, datée de C tout juste
    ...title(P('2026-10-16T21:00'), 'p2'), // 12, 13
  ]);
  const { cuts, pieces } = eveningBreaks({ events, timeZone: PARIS });
  assert.deepEqual(cuts, [C]);
  assert.deepEqual(pieces.map(seqs), [[1, 2, 3, 4, 5, 6, 7, 10, 11], [8, 9, 12, 13]], '10, datée de 1 h, dans le premier morceau');
  // Même coupure quel que soit l'ordre du tableau reçu.
  assert.deepEqual(eveningBreaks({ events: [...events].reverse(), timeZone: PARIS }).cuts, [C]);
  // Datée de 22 h 30, avant les lignes 6 et 7 : rangée par son heure, mais à sa place dans l'ordre des seq.
  const earlier = events.map(e => (e.seq === 10 ? { ...e, t: P('2026-10-15T22:30') } : e));
  assert.deepEqual(eveningBreaks({ events: earlier, timeZone: PARIS }).pieces.map(seqs), [[1, 2, 3, 4, 5, 6, 7, 10, 11], [8, 9, 12, 13]]);
  // Ligne sans heure (piecesOf) : gardée avec celle qui la précède dans le journal.
  const untimed = events.map(e => (e.seq === 10 ? { ...e, t: undefined } : e));
  assert.deepEqual(eveningBreaks({ events: untimed, timeZone: PARIS }).pieces.map(seqs), [[1, 2, 3, 4, 5, 6, 7, 11], [8, 9, 10, 12, 13]]);
});

test('A1 : morceau découpé à 9 h 55 avec une activité datée de 7 h 50 (heure du PC reculée) : C le lendemain, accepté par cutAllowed', () => {
  const startedAt = P('2026-10-16T09:55');
  const split = { from: '2026-10-15_2000_ab12', part: 2, generation: 1, rule: 'v1', cut: startedAt };
  const events = journal([
    [startedAt, 'evening.started', { rules: {}, carried: true }],
    [startedAt, 'table.opened', { tableId: '1', individual: false, carried: true }],
    [startedAt, 'person.joined', { personId: 'p1', tableId: '1', carried: true }],
    // Heure du PC reculée : lignes écrites après la coupure, datées d'avant.
    ...title(P('2026-10-16T07:52')),
    ...title(P('2026-10-16T21:00')),
  ], 'apres-coupure');
  assert.equal(firstActivityOf({ events, state: null, startedAt, split }), startedAt, 'compte à meta.startedAt');
  const now = P('2026-10-17T10:00');
  const over = eveningOver({ events, state: null, startedAt, split, now, timeZone: PARIS });
  assert.deepEqual(over, { at: P('2026-10-17T08:00'), reason: 'morning', activityAfter: false, firstActivityAt: startedAt });
  assert.equal(cutAllowed({ at: over.at, startedAt, split }), true);
  assert.deepEqual(eveningBreaks({ events, timeZone: PARIS, startedAt, split }).cuts, [], 'aucune recoupe à 8 h 52 le 16');
  // Sans la règle du morceau découpé, C tomberait à 8 h 52 le 16, avant le
  // début du morceau : cutAllowed le refuse, une soirée jamais découpée non.
  const early = closurePoint({ firstActivityAt: P('2026-10-16T07:50'), events, timeZone: PARIS });
  assert.equal(early, P('2026-10-16T08:52'));
  assert.equal(cutAllowed({ at: early, startedAt, split }), false);
  assert.equal(cutAllowed({ at: startedAt, startedAt, split }), false, 'coupure au début même : refusée');
  assert.equal(cutAllowed({ at: early, startedAt, split: null }), true);
  assert.equal(cutAllowed({ at: NaN, startedAt, split: null }), false);
  assert.equal(cutAllowed({ at: over.at, startedAt: undefined, split }), false, 'morceau découpé sans début lisible : refusé');
});

test('A1 : soirée jamais découpée, journal ouvert à 10 h avec les inscriptions de la veille (version sans journal) : première activité non décalée, même C = 10 h en direct et en réparation', () => {
  // startNight() après un journal.open sans reprise (version sans journal,
  // journal illisible) : les inscriptions de la sauvegarde sont reportées à
  // leur heure (person.joined restored: true), avant meta.startedAt.
  const startedAt = P('2026-10-16T10:00');
  const events = journal([
    [startedAt, 'evening.started', { rules: {} }],
    [startedAt, 'app.started', { restored: false, offlineMs: 0 }],
    [startedAt, 'table.opened', { tableId: 'Comptoir', individual: true }],
    [P('2026-10-15T21:00'), 'person.joined', { personId: 'p1', tableId: '1', restored: true }],
    [P('2026-10-16T20:00'), 'table.opened', { tableId: '2', individual: false }],
    [P('2026-10-16T20:01'), 'person.joined', { personId: 'p2', tableId: '2' }],
  ], 'sans-journal');
  // Sans meta.split, l'activité d'avant le début du journal n'est pas ramenée à lui.
  assert.equal(firstActivityOf({ events, startedAt }), P('2026-10-15T21:00'));
  // En direct à 10 h 30 : 8 h est passé, mais C n'est jamais avant le début du journal.
  const now = P('2026-10-16T10:30');
  assert.deepEqual(eveningOver({ events: upTo(events, now), startedAt, now, timeZone: PARIS }),
    { at: startedAt, reason: 'morning', activityAfter: false, firstActivityAt: P('2026-10-15T21:00') });
  // Réparation du journal entier : la même coupure ; les inscriptions de la veille restent dans le premier morceau.
  const { cuts, pieces } = eveningBreaks({ events, startedAt, timeZone: PARIS });
  assert.deepEqual(cuts, [startedAt]);
  assert.deepEqual(pieces.map(seqs), [[1, 2, 3, 4], [5, 6]]);
});

test('A1 : somethingToClose et firstActivityOf prennent l’objet d’eveningOver ({ events, state })', () => {
  const events = journal([
    [P('2026-10-16T18:00'), 'evening.started', { rules: {} }],
    [P('2026-10-16T18:00'), 'table.opened', { tableId: 'Comptoir', individual: true }],
    [P('2026-10-16T18:30'), 'person.seen', { personId: 'p0' }],
    [P('2026-10-16T20:00'), 'song.requested', { personId: 'p1', entryId: 'a' }],
  ]);
  // Mémoire d'avant une coupure : plus ancienne, elle ne date plus la soirée,
  // qui a sa propre activité.
  const state = {
    tables: new Map([['1', { id: '1', individual: false, createdAt: P('2026-10-15T19:00') }]]),
    people: new Map([['p1', { id: 'p1', name: 'Léa', tableId: '1', joinedAt: P('2026-10-15T19:05') }]]),
  };
  assert.equal(somethingToClose({ events, state }), true);
  assert.equal(firstActivityOf({ events, state }), P('2026-10-16T20:00'));
  const quiet = events.slice(0, 3);
  assert.equal(firstActivityOf({ events: quiet, state }), P('2026-10-15T19:00'), 'sans activité : la mémoire');
  assert.equal(somethingToClose({ events: quiet, state: null }), false);
  // Titres en liste, titres envoyés ou en cours d'envoi : quelque chose à clore.
  assert.equal(somethingToClose({ events: quiet, state: { songs: 1 } }), true);
  assert.equal(somethingToClose({ events: quiet, state: { sent: [{ entryId: 'a' }] } }), true);
  assert.equal(somethingToClose({ events: quiet, state: { songs: 0, sent: [] } }), false);
  assert.equal(somethingToClose({ events: [], state: undefined }), false);
  assert.equal(firstActivityOf({ events: [], state: undefined }), null);
});

test('A1 : booléen de mauvais type lu comme absent (A7) : carried et individual en \'false\', 0, 1 ou null, vrais seulement s’ils valent true', () => {
  // Règle des champs de mauvais type (A7, essai par propriétés) : « un booléen
  // n'est vrai que s'il vaut true ». cleanFields garde 'false' et 1 tels quels.
  const C = P('2026-10-16T08:00');
  const night = [...opening(P('2026-10-15T20:00')), ...title(P('2026-10-15T23:00'))];
  const cases = value => ({
    // Table ouverte le lendemain soir : ordinaire, sauf individual: true (« En solo »).
    table: journal([...night, [P('2026-10-16T19:00'), 'table.opened', { tableId: '2', individual: value }]]),
    // Inscription du lendemain soir : une activité, sauf ligne reportée (carried: true).
    joined: journal([...night, [P('2026-10-16T19:00'), 'person.joined', { personId: 'p2', tableId: '1', carried: value }]]),
    // Titre commencé à 7 h 30 : un début de titre, sauf ligne reportée.
    started: journal([...night, ...title(P('2026-10-16T07:30'), 'p1', { carried: value }), ...title(P('2026-10-16T20:00'))]),
    // Seule ligne du journal : la première activité, sauf ligne reportée.
    first: journal([[P('2026-10-15T21:00'), 'person.joined', { personId: 's1', tableId: 'Comptoir', carried: value }]]),
  });
  const read = value => {
    const { table, joined, started, first } = cases(value);
    return {
      tableCuts: eveningBreaks({ events: table, timeZone: PARIS }).cuts,
      tableAfter: eveningOver({ events: table, now: P('2026-10-16T19:05'), timeZone: PARIS })?.activityAfter,
      joinedCuts: eveningBreaks({ events: joined, timeZone: PARIS }).cuts,
      startedCuts: eveningBreaks({ events: started, timeZone: PARIS }).cuts,
      startedAt815: eveningOver({ events: upTo(started, P('2026-10-16T08:15')), now: P('2026-10-16T08:15'), timeZone: PARIS })?.at ?? null,
      closure: closurePoint({ firstActivityAt: P('2026-10-15T20:01'), events: started, timeZone: PARIS }),
      firstAt: firstActivityOf({ events: first }),
      toClose: somethingToClose({ events: first }),
    };
  };
  const absent = {
    tableCuts: [C], tableAfter: true, joinedCuts: [C],
    startedCuts: [P('2026-10-16T08:30')], startedAt815: null, closure: P('2026-10-16T08:30'),
    firstAt: P('2026-10-15T21:00'), toClose: true,
  };
  for (const value of ['false', 0, 1, null]) assert.deepEqual(read(value), absent, `${JSON.stringify(value)} : lu comme absent`);
  // Témoin : true retire la ligne de l'activité (« En solo », ligne reportée).
  assert.deepEqual(read(true), {
    tableCuts: [], tableAfter: false, joinedCuts: [],
    startedCuts: [C], startedAt815: C, closure: C,
    firstAt: null, toClose: false,
  });
});

// La fixture du 15 octobre recopiée n fois à +24 h : heures des lignes et
// des champs datés décalées, seq continus, un boot par nuit.
const TIME_FIELDS = { 'turn.sent': 'sentAt', 'battle.proposed': 'closesAt', 'closing.set': 'closingAt' };
function nights(n) {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'soiree-2026-10-15-anonyme.json'), 'utf8'));
  const out = [];
  for (let k = 0; k < n; k++) {
    for (const e of fixture.events) {
      const copy = { ...e, seq: out.length + 1, t: e.t + k * 24 * H, boot: `nuit-${k + 1}` };
      const field = Object.hasOwn(TIME_FIELDS, e.ev) ? TIME_FIELDS[e.ev] : null;
      if (field && Number.isFinite(e[field])) copy[field] = e[field] + k * 24 * H;
      out.push(copy);
    }
  }
  return out;
}

test('A1 : journal de 60 nuits (47 760 lignes) : 59 coupures, eveningOver et eveningBreaks en moins de 200 ms', () => {
  const events = nights(60);
  assert.equal(events.length, 47760);
  let t0 = performance.now();
  const { cuts, pieces } = eveningBreaks({ events, timeZone: PARIS });
  const breaksMs = performance.now() - t0;
  t0 = performance.now();
  const over = eveningOver({ events, now: events.at(-1).t + MIN, timeZone: PARIS });
  const overMs = performance.now() - t0;
  console.log(`A1 : 60 nuits (${events.length} lignes) : eveningBreaks ${breaksMs.toFixed(1)} ms, eveningOver ${overMs.toFixed(1)} ms.`);
  assert.equal(cuts.length, 59);
  // Chaque coupure : 8 h à Paris, le matin qui suit chaque nuit (passage à l'heure d'hiver compris).
  cuts.forEach((cut, k) => assert.deepEqual(localParts(cut, PARIS), { ...localParts(P('2026-10-16T08:00') + k * 24 * H, PARIS), hour: 8 },
    `coupure ${k + 1}`));
  assert.equal(pieces.length, 60);
  assert.equal(pieces.reduce((n, piece) => n + piece.length, 0), events.length, 'aucune ligne perdue');
  assert.deepEqual(over, { at: cuts[0], reason: 'morning', activityAfter: true, firstActivityAt: events.find(e => e.ev === 'table.opened' && !e.individual).t });
  // gstack-timing-ok: borne du plan (A7) : cent fois le budget de 2 ms par passe de sync(), pour rester vert sur une CI lente ; un calcul qui relirait le journal à chaque ligne la dépasse.
  assert.ok(breaksMs < 200, `eveningBreaks : ${breaksMs.toFixed(1)} ms, au-delà de 200 ms`);
  // gstack-timing-ok: même borne du plan (A7) pour eveningOver, que sync() lancera à chaque passe (A2) : cent fois son budget de 2 ms.
  assert.ok(overMs < 200, `eveningOver : ${overMs.toFixed(1)} ms, au-delà de 200 ms`);
});
