'use strict';
// Découpage des journaux fusionnés (evening-split.js, plan du 8 novembre, A4 ;
// essais d'A7, « Réparation ») : planSplit, le calcul pur des morceaux, le même
// pour la réparation, le découpage en direct et le rejeu d'un export fusionné.
// Sans disque : l'écriture des morceaux (identifiant sur le disque, copie par
// génération, ordre d'écriture, index) s'essaie dans evening-journal.test.js.
//
// process.env.TZ est changé en cours d'exécution, puis toujours rendu (comme
// dans fuseau.test.js). Les heures sont écrites avec leur décalage : +02:00
// pour Paris jusqu'au 25 octobre 2026.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { planSplit, pieceJournal, pieceMeta, splitFingerprint, SPLIT_RULE } = require('../evening-split');
const { eveningBreaks, eveningOver, morningAfter, QUIET_MS } = require('../evening-bounds');
const { citedIds, computeStats, exportEvening } = require('../evening-stats');
const { parseLines, newEveningId, validEveningId } = require('../evening-journal');
const tires = require('./journaux-tires');

const PARIS = 'Europe/Paris';
// Heure de Paris en octobre 2026, avant le passage à l'heure d'hiver.
const P = local => Date.parse(`${local}+02:00`);
const ORIGIN = '2026-10-15_1900_ab12';

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

// Journal synthétique : lignes [heure, type, champs], écrites comme par
// EveningJournal.append (champs, puis v, seq, t, ev et boot).
function journal(rows, boot = 'b1') {
  let seq = 0;
  return rows.map(([t, ev, fields = {}]) => ({ ...fields, v: 1, seq: ++seq, t, ev, boot }));
}
// meta d'une soirée en cours ouverte à la première ligne : prénoms et tables
// donnés en [id, table] et [id, individual].
function metaOf(events, { people = [], tables = [], ...extra } = {}) {
  return { format: 'karaoke-evening-meta', version: 1, eveningId: ORIGIN, startedAt: events[0].t, endedAt: null,
    app: { version: 'v3.5.0', commit: null }, timezone: PARIS,
    roster: Object.fromEntries(people.map(([id, tableId]) => [id, { name: `Prénom ${id}`, tableId }])),
    tables: Object.fromEntries(tables.map(([id, individual = false]) => [id, { name: `Table ${id}`, individual }])), ...extra };
}
const cutsOf = (events, meta) => eveningBreaks({ events, timeZone: meta.timezone, startedAt: meta.startedAt, split: meta.split }).cuts;
const plan = (events, meta, options = {}) => planSplit({ meta, events, cuts: cutsOf(events, meta), citedIds, ...options });
// Ligne reportée attendue : champs, puis carried, v, seq, t, ev et boot.
const carriedLine = (t, boot, seq, ev, fields) => ({ ...fields, carried: true, v: 1, seq, t, ev, boot });
const evs = lines => lines.map(e => e.ev);
const maxSeq = lines => lines.reduce((max, e) => Math.max(max, e.seq), 0);
const stageOf = (stats, entryId) => stats.timeline.stages.find(st => st.entryId === entryId);
const singerOf = (stats, id) => stats.singers.find(s => s.id === id);
// Statistiques d'un morceau, comme la réparation les résume (journal du
// morceau, sa meta, maintenant à sa fin ou à sa dernière ligne).
const statsOfPiece = piece => {
  const lines = pieceJournal(piece);
  return computeStats({ meta: piece.meta, events: lines, now: piece.end ?? lines.at(-1).t });
};

// Deux nuits : le jeudi 15 octobre (tables 1 et 2, « En solo »), puis le
// vendredi 16. Coupure le vendredi à 8 h.
function deuxNuits(night2 = []) {
  return journal([
    [P('2026-10-15T19:00'), 'evening.started', { rules: { auto: true, gap: 3, autoPlay: false } }],
    [P('2026-10-15T19:00') + 1, 'app.started', { restored: false, offlineMs: 0 }],
    [P('2026-10-15T19:00') + 2, 'table.opened', { tableId: 'Comptoir', individual: true }],
    [P('2026-10-15T19:01'), 'karaoke.phase', { phase: 'silent', blocker: 'empty' }],
    [P('2026-10-15T19:05'), 'table.opened', { tableId: '1', individual: false }],
    [P('2026-10-15T19:05') + 1, 'table.headcount', { tableId: '1', n: 4, by: 'staff' }],
    [P('2026-10-15T19:06'), 'table.opened', { tableId: '2', individual: false }],
    [P('2026-10-15T19:06') + 1, 'table.headcount', { tableId: '2', n: 2, by: 'staff' }],
    [P('2026-10-15T19:07'), 'table.headcount', { tableId: '1', n: 5, by: 'staff' }],
    [P('2026-10-15T19:10'), 'person.joined', { personId: 'a', tableId: '1' }],
    [P('2026-10-15T19:11'), 'person.joined', { personId: 'b', tableId: '1' }],
    [P('2026-10-15T19:12'), 'person.joined', { personId: 'c', tableId: '2' }],
    [P('2026-10-15T19:13'), 'person.joined', { personId: 's', tableId: 'Comptoir' }],
    [P('2026-10-15T19:20'), 'table.bonus', { tableId: '1', level: 2 }],
    [P('2026-10-15T19:21'), 'person.bonus', { personId: 'a', level: -1 }],
    [P('2026-10-15T19:22'), 'settings.changed', { setting: 'gap', from: 3, to: 4 }],
    [P('2026-10-15T19:23'), 'settings.changed', { setting: 'autoPlay', from: false, to: true }],
    [P('2026-10-15T19:30'), 'song.requested', { personId: 'a', entryId: 'e1', title: 'Un', mode: 'append' }],
    [P('2026-10-15T19:35'), 'stage.started', { queueId: 1, entryId: 'e1', ids: ['a'], ownerId: 'a', source: 'queue', title: 'Un' }],
    [P('2026-10-15T19:39'), 'stage.ended', { queueId: 1, playedSec: 240 }],
    [P('2026-10-15T23:30'), 'song.requested', { personId: 'b', entryId: 'e2', title: 'Deux', mode: 'append' }],
    [P('2026-10-15T23:35'), 'stage.started', { queueId: 2, entryId: 'e2', ids: ['b'], ownerId: 'b', source: 'queue', title: 'Deux' }],
    [P('2026-10-15T23:39'), 'stage.ended', { queueId: 2, playedSec: 240 }],
    [P('2026-10-16T01:10'), 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }],
    ...night2,
  ]);
}
const PEOPLE = [['a', '1'], ['b', '1'], ['c', '2'], ['s', 'Comptoir']];
const TABLES = [['Comptoir', true], ['1'], ['2']];
const C16 = P('2026-10-16T08:00');

// ------------------------------------------------------------------ essais

test('A4 : module : constantes, et planSplit exige citedIds (evening-stats.js)', () => {
  assert.equal(SPLIT_RULE, 'v1');
  assert.throws(() => planSplit({ meta: {}, events: [], cuts: [] }), { name: 'TypeError', message: /citedIds/ });
});

test('A4 : la soirée du 15 octobre seule : aucune coupure, un seul morceau, la soirée telle qu’elle est (rejeu identique)', () => {
  const { events, meta } = tires.recopierFixture({ fois: 1 });
  assert.deepEqual(cutsOf(events, meta), []);
  const result = plan(events, meta);
  assert.deepEqual([result.from, result.generation, result.rule, result.cuts], [meta.eveningId, 1, 'v1', []]);
  assert.equal(result.pieces.length, 1);
  const [piece] = result.pieces;
  assert.deepEqual([piece.k, piece.start, piece.end, piece.carried, piece.closing], [1, meta.startedAt, null, [], null]);
  assert.ok(piece.lines.length === events.length && piece.lines.every((e, i) => e === events[i]), 'mêmes lignes, dans le même ordre');
  assert.deepEqual(piece.meta, meta, 'meta inchangée');
  assert.deepEqual(pieceJournal(piece), events);
});

test('A4 : la soirée du 15 octobre recopiée à +24 h : deux soirées coupées à 8 h, chaque ligne dans le morceau de son heure, lignes reportées et clôture', () => {
  const { events, meta, fixture } = tires.recopierFixture({ fois: 2 });
  assert.deepEqual(cutsOf(events, meta), [C16]);
  const at = P('2026-10-16T19:40');
  const result = plan(events, meta, { generation: 1, at });
  assert.deepEqual([result.from, result.generation, result.rule, result.cuts], [meta.eveningId, 1, 'v1', [C16]]);
  const [first, second] = result.pieces;
  assert.deepEqual([first.k, first.start, first.end, second.k, second.start, second.end], [1, meta.startedAt, C16, 2, C16, null]);
  assert.deepEqual(first.lines, events.filter(e => e.t <= C16));
  assert.deepEqual(second.lines, events.filter(e => e.t > C16));
  // Les lignes de la copie datées d'avant la coupure (redémarrages des 12 et
  // 15 octobre) restent au premier morceau : l'heure, pas la place.
  assert.ok(first.lines.some(e => e.boot === 'nuit-2'));
  // Clôture du premier morceau, datée de la coupure ; at : l'heure du découpage.
  assert.deepEqual(first.closing, { by: 'auto', reason: 'morning', split: true, at, v: 1, seq: maxSeq(first.lines) + 1, t: C16,
    ev: 'evening.closed', boot: 'split-g1-k1' });
  assert.equal(second.closing, null, 'le dernier morceau n’a pas de clôture ajoutée');
  // Reporté au second : les règles en vigueur (autoPlay changé le 15 au
  // soir) et la dernière phase de KaraFun ; aucune personne ni table (la
  // copie a ses propres identifiants), ni « En solo » de la copie, ouvert
  // le 12 octobre et jamais rejoint.
  const rules = { ...fixture.events.find(e => e.ev === 'evening.started').rules, autoPlay: true };
  assert.deepEqual(second.carried, [
    carriedLine(C16, 'split-g1-k2', -1, 'evening.started', { rules }),
    carriedLine(C16, 'split-g1-k2', 0, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
  ]);
  assert.deepEqual(pieceJournal(first), [...first.lines, first.closing]);
  assert.deepEqual(pieceJournal(second), [...second.carried, ...second.lines]);
  // meta filtrée : les personnes et les tables de chaque soirée.
  const keys = list => list.map(p => p.key);
  assert.deepEqual(Object.keys(first.meta.roster), keys(fixture.people));
  assert.deepEqual(Object.keys(second.meta.roster), keys(fixture.people).map(id => `${id}-2`));
  assert.deepEqual(Object.keys(first.meta.tables), [...keys(fixture.tables), 'T6-2']);
  assert.deepEqual(Object.keys(second.meta.tables), ['T1-2', 'T2-2', 'T3-2', 'T4-2', 'T5-2', 'T7-2']);
  assert.deepEqual(second.meta.roster['S01-2'], meta.roster['S01-2']);
  const fixed = ({ roster, tables, ...rest }) => rest;
  assert.deepEqual(fixed(first.meta), { format: 'karaoke-evening-meta', version: 1, eveningId: null, startedAt: meta.startedAt, endedAt: C16,
    app: meta.app, timezone: PARIS, closedBy: 'auto', split: { from: meta.eveningId, part: 1, generation: 1, rule: 'v1' } });
  assert.deepEqual(fixed(second.meta), { format: 'karaoke-evening-meta', version: 1, eveningId: meta.eveningId, startedAt: C16, endedAt: null,
    app: meta.app, timezone: PARIS, split: { from: meta.eveningId, part: 2, generation: 1, rule: 'v1' } });
});
test('A4 : indicateurs globaux de chaque morceau égaux à ceux de la soirée seule (copie à +24 h avec ses propres identifiants, son boot et les heures de ses champs décalées)', () => {
  const { events: alone, meta: aloneMeta } = tires.recopierFixture({ fois: 1 });
  const indicators = stats => ({ jain: stats.fairness.jain, songsPerHour: stats.global.songsPerHour, deadShare: stats.global.deadShare,
    waitAvgSec: stats.global.waitAvgSec, firstTurnAvgSec: stats.global.firstTurnAvgSec });
  const aloneStats = computeStats({ meta: aloneMeta, events: alone, now: alone.at(-1).t });
  const expected = indicators(aloneStats);
  // Simulation du plan : indice de Jain 0,784, 16,9 titres par heure, 5,5 %
  // de temps mort, attente moyenne 1 449 s et premier passage 528 s.
  assert.deepEqual(expected, { jain: 0.784, songsPerHour: 16.9, deadShare: 0.055, waitAvgSec: 1449, firstTurnAvgSec: 528 });
  const { events, meta } = tires.recopierFixture({ fois: 2 });
  const result = plan(events, meta, { at: P('2026-10-16T19:40') });
  assert.equal(result.pieces.length, 2);
  for (const piece of result.pieces) {
    const lines = pieceJournal(piece);
    const stats = computeStats({ meta: piece.meta, events: lines, now: piece.end ?? lines.at(-1).t });
    assert.deepEqual(indicators(stats), expected, `morceau ${piece.k}`);
    assert.deepEqual([stats.fairness, stats.global.registered, stats.tables.length],
      [aloneStats.fairness, aloneStats.global.registered, aloneStats.tables.length], `morceau ${piece.k} : équité, inscrits et tables`);
    // Par les règles d'un morceau (A4) : ses lignes reportées, de l'état, ne
    // sont comptées nulle part, ni parmi les lignes ni par leur type.
    assert.equal(stats.quality.events, lines.filter(e => e.carried !== true).length, `morceau ${piece.k} : lignes comptées`);
  }
  // Le second morceau commence par ses lignes reportées (règles et phase) : son
  // seul evening.started en est une.
  const second = result.pieces[1];
  assert.deepEqual(evs(second.carried), ['evening.started', 'karaoke.phase']);
  assert.ok(!second.lines.some(e => e.ev === 'evening.started'));
  assert.equal(statsOfPiece(second).quality.other['evening.started'], undefined, 'ligne reportée evening.started comptée');
  // Témoin : avec les mêmes identifiants, les personnes de la copie seraient
  // citées le second soir, donc reportées.
  const same = tires.recopierFixture({ fois: 2, idsPropres: false });
  const carried = plan(same.events, same.meta).pieces[1].carried;
  assert.ok(carried.some(e => e.ev === 'person.joined'), 'mêmes identifiants : personnes reportées');
});

test('A4 : export fusionné, comme test/rejeu-soiree.js --soiree : sans boot ni meta.startedAt, coupé en deux soirées ; chacune relue sans meta donne les indicateurs de la soirée seule', () => {
  // L'export retire le boot des lignes ; sa meta (evening, people, tables) n'a
  // ni début ni fin.
  const { events: copied, meta: full } = tires.recopierFixture({ fois: 2 });
  const events = copied.map(({ boot: _boot, ...e }) => e);
  const meta = { eveningId: full.eveningId, timezone: full.timezone, roster: full.roster, tables: full.tables };
  const cuts = eveningBreaks({ events, timeZone: meta.timezone }).cuts;
  assert.deepEqual(cuts, [C16]);
  const result = planSplit({ meta, events, cuts, citedIds });
  assert.deepEqual(result.pieces.map(piece => [piece.k, piece.start, piece.end]), [[1, events[0].t, C16], [2, C16, null]]);
  // Le rejeu lit chaque soirée sans meta (statsOf, test/rejeu-soiree.js) ;
  // les lignes reportées ont leur boot, jamais le doublon d'une ligne de l'export.
  const indicators = lines => {
    const stats = computeStats({ events: lines, now: lines.reduce((m, e) => Math.max(m, e.t), 0) });
    return [stats.fairness.jain, stats.global.songsPerHour, stats.global.deadShare, stats.global.waitAvgSec, stats.global.firstTurnAvgSec];
  };
  const alone = tires.recopierFixture({ fois: 1 }).events.map(({ boot: _boot, ...e }) => e);
  for (const piece of result.pieces) {
    const lines = pieceJournal(piece);
    const keys = lines.map(e => `${e.boot || ''}:${e.seq}`);
    assert.equal(new Set(keys).size, keys.length, `morceau ${piece.k} : clés boot:seq uniques`);
    assert.deepEqual(indicators(lines), indicators(alone), `morceau ${piece.k}`);
  }
  // « --soiree liste » : numéro, coupure et nombre de lignes de chaque soirée.
  assert.deepEqual(result.pieces.map(piece => [piece.k, piece.end, piece.lines.length]),
    [[1, C16, events.filter(e => e.t <= C16).length], [2, null, events.filter(e => e.t > C16).length]]);
});

test('A4 : lignes reportées : règles en vigueur, dernière phase de KaraFun, tables et personnes citées connues avant la coupure (table à la coupure, dernier effectif, bonus en vigueur), datées du début, boot et seq propres', () => {
  const events = deuxNuits([
    // Le téléphone de c rouvert le matin : ne cite pas, ne retient pas la soirée.
    [P('2026-10-16T08:30'), 'person.seen', { personId: 'c' }],
    [P('2026-10-16T19:00'), 'karaoke.phase', { phase: 'between', blocker: 'permission' }],
    // Réglage changé après la coupure : pas dans les règles reportées.
    [P('2026-10-16T19:05'), 'settings.changed', { setting: 'cap', from: 2, to: 3 }],
    [P('2026-10-16T19:08'), 'table.opened', { tableId: '3', individual: false }],
    // a, de la veille, demande un titre : citée, reportée avec sa table et son bonus.
    [P('2026-10-16T19:10'), 'song.requested', { personId: 'a', entryId: 'e9', title: 'Neuf', mode: 'append' }],
    // Nouvelle inscription sur la table 2 de la veille : la table est citée.
    [P('2026-10-16T19:12'), 'person.joined', { personId: 'd', tableId: '2' }],
    [P('2026-10-16T19:13'), 'person.joined', { personId: 'e', tableId: '3' }],
    [P('2026-10-16T19:15'), 'stage.started', { queueId: 3, entryId: 'e9', ids: ['a'], ownerId: 'a', source: 'queue' }],
  ]);
  const meta = metaOf(events, { people: [...PEOPLE, ['d', '2'], ['e', '3']], tables: [...TABLES, ['3']] });
  const result = plan(events, meta);
  assert.deepEqual(result.cuts, [C16]);
  const [first, second] = result.pieces;
  const boot = 'split-g1-k2';
  assert.deepEqual(second.carried, [
    carriedLine(C16, boot, -8, 'evening.started', { rules: { auto: true, gap: 4, autoPlay: true } }),
    carriedLine(C16, boot, -7, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
    carriedLine(C16, boot, -6, 'table.opened', { tableId: '1', individual: false }),
    carriedLine(C16, boot, -5, 'table.headcount', { tableId: '1', n: 5, by: 'staff' }),
    carriedLine(C16, boot, -4, 'table.bonus', { tableId: '1', level: 2 }),
    carriedLine(C16, boot, -3, 'table.opened', { tableId: '2', individual: false }),
    carriedLine(C16, boot, -2, 'table.headcount', { tableId: '2', n: 2, by: 'staff' }),
    carriedLine(C16, boot, -1, 'person.joined', { personId: 'a', tableId: '1' }),
    carriedLine(C16, boot, 0, 'person.bonus', { personId: 'a', level: -1 }),
  ]);
  // Rien de reporté ni pour b et c, ni pour « En solo ».
  assert.deepEqual(first.carried, []);
  // meta : la veille, toutes les personnes et tables nommées ; le second
  // morceau, les reportées et les créées (d, e, table 3).
  assert.deepEqual(Object.keys(first.meta.roster), ['a', 'b', 'c', 's']);
  // Ordre des clés de meta.tables (les clés numériques d'abord, en JavaScript).
  assert.deepEqual(Object.keys(first.meta.tables), ['1', '2', 'Comptoir']);
  assert.deepEqual(Object.keys(second.meta.roster), ['a', 'd', 'e']);
  assert.deepEqual(Object.keys(second.meta.tables), ['1', '2', '3']);
  assert.deepEqual(second.meta.roster.d, meta.roster.d);
  // Les seq propres des lignes reportées ne sont jamais ceux d'une ligne
  // écrite, même sans boot (export), et la clôture vient après toutes.
  const exported = pieceJournal(second).map(({ boot: _boot, ...e }) => `${e.seq}`);
  assert.equal(new Set(exported).size, exported.length, 'seq uniques dans le morceau, sans boot');
  assert.ok(first.closing.seq > maxSeq(first.lines));
});

test('A4 : personnes et tables citées : une personne et une table de la veille nommées seulement par des lignes qui ne citent pas ne sont pas reportées, ni dans la meta du morceau ; une ligne qui cite quelqu’un ne cite pas les autres personnes qu’elle nomme', () => {
  const events = deuxNuits([
    // c (table 2) et la table 2 : une ligne de chaque sorte qui ne cite pas.
    [P('2026-10-16T19:00'), 'person.seen', { personId: 'c' }],
    [P('2026-10-16T19:01'), 'notice.sent', { personId: 'c', kind: 'turnSoon' }],
    [P('2026-10-16T19:02'), 'presence.asked', { personIds: ['c'], entryId: null, source: 'auto' }],
    [P('2026-10-16T19:03'), 'presence.skipped', { personId: 'c', entryId: 'e5', skips: 1, removed: false }],
    [P('2026-10-16T19:04'), 'person.bonus', { personId: 'c', level: 1 }],
    [P('2026-10-16T19:05'), 'defer.requested', { ownerId: 'c', personIds: ['c'], entryId: null, songs: 1 }],
    [P('2026-10-16T19:06'), 'person.left', { personId: 'c', by: 'staff', songsDropped: 0 }],
    [P('2026-10-16T19:07'), 'table.left', { tableId: '2', personIds: ['c'], songsDropped: 0 }],
    // Nouvelle soirée : z à la table 9.
    [P('2026-10-16T19:10'), 'table.opened', { tableId: '9', individual: false }],
    [P('2026-10-16T19:11'), 'person.joined', { personId: 'z', tableId: '9' }],
    // z invite b (partnerId) et lui cède sa place (toId) : b n'est pas citée.
    [P('2026-10-16T19:12'), 'song.requested', { personId: 'z', entryId: 'e9', mode: 'append' }],
    [P('2026-10-16T19:13'), 'duo.invited', { personId: 'z', entryId: 'e9', ownerId: 'z', partnerId: 'b', sameGroup: false }],
    [P('2026-10-16T19:14'), 'person.gaveSpot', { personId: 'z', toId: 'b' }],
    // Gestes du bar sur b et s : bonus, réglage d'un titre, retrait.
    [P('2026-10-16T19:15'), 'person.bonus', { personId: 'b', level: 2 }],
    [P('2026-10-16T19:16'), 'song.settings', { by: 'staff', where: 'list', personId: 's', entryId: 'e8', settings: { pitch: 1 } }],
    [P('2026-10-16T19:17'), 'song.removed', { personId: 's', entryId: 'e8', by: 'staff' }],
    [P('2026-10-16T19:20'), 'stage.started', { queueId: 3, entryId: 'e9', ids: ['z'], ownerId: 'z', source: 'queue' }],
  ]);
  const meta = metaOf(events, { people: [...PEOPLE, ['z', '9']], tables: [...TABLES, ['9']] });
  const [, second] = plan(events, meta).pieces;
  assert.deepEqual(evs(second.carried), ['evening.started', 'karaoke.phase'], 'ni personne ni table de la veille reportée');
  assert.deepEqual(Object.keys(second.meta.roster), ['z']);
  assert.deepEqual(Object.keys(second.meta.tables), ['9']);
});

test('A4 : citent aussi : un passage sur scène, l’invitée d’un duo noté par le bar, « Toujours là » et le retour après un départ (gestes du bar) ; reportés avec leur table', () => {
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'presence.stillHere', { personId: 'b' }],
    [P('2026-10-16T19:01'), 'person.reactivated', { personId: 'c' }],
    [P('2026-10-16T19:02'), 'duo.improvised', { entryId: null, ownerId: 'b', partnerId: 's' }],
    // Passage sur scène d'un titre demandé la veille, sans demande dans ce morceau.
    [P('2026-10-16T19:10'), 'stage.started', { queueId: 7, entryId: 'e7', ids: ['b'], ownerId: 'b', source: 'queue' }],
  ]);
  const meta = metaOf(events, { people: PEOPLE, tables: TABLES });
  const [, second] = plan(events, meta).pieces;
  const joined = second.carried.filter(e => e.ev === 'person.joined').map(e => [e.personId, e.tableId]);
  assert.deepEqual(joined, [['b', '1'], ['c', '2'], ['s', 'Comptoir']], 'ordre d’arrivée de la veille');
  assert.deepEqual(second.carried.filter(e => e.ev === 'table.opened').map(e => [e.tableId, e.individual]),
    [['Comptoir', true], ['1', false], ['2', false]]);
  assert.deepEqual(Object.keys(second.meta.roster), ['b', 'c', 's']);
  assert.deepEqual(Object.keys(second.meta.tables), ['1', '2', 'Comptoir']);
});

test('A4 : « Je suis prêt » (defer.ended how: ready, avec le personId qu’écrit le serveur) cite celle qui l’a touché, comme computeStats y prolonge sa présence : reportée avec sa table ; le « Pas prêt » et les autres fins d’un report, qui ne nomment que par ownerId, ne citent pas', () => {
  // c (table 2) a demandé un titre jeudi, resté dans la file ; vendredi, elle
  // dit « Pas prêt », puis « Je suis prêt ». s (« En solo »), l'invitée du duo
  // de a, dit « Je suis prêt » pour le titre de a. b (table 1) dit « Pas
  // prêt », et le serveur finit son report (released). Lignes écrites comme
  // par lib/scheduler/presence.js (_endDeferral, cancelDeferral).
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'table.opened', { tableId: '3', individual: false }],
    [P('2026-10-16T19:01'), 'person.joined', { personId: 'd', tableId: '3' }],
    [P('2026-10-16T19:05'), 'defer.requested', { ownerId: 'c', personIds: ['c'], entryId: 'e5', songs: 1, total: 1, remaining: 1 }],
    [P('2026-10-16T19:06'), 'defer.ended', { personId: 'c', ownerId: 'c', entryId: 'e5', how: 'ready' }],
    [P('2026-10-16T19:07'), 'defer.requested', { ownerId: 'a', personIds: ['a', 's'], entryId: 'e6', songs: 1, total: 1, remaining: 1 }],
    [P('2026-10-16T19:08'), 'defer.ended', { personId: 's', ownerId: 'a', entryId: 'e6', how: 'ready' }],
    [P('2026-10-16T19:09'), 'defer.requested', { ownerId: 'b', personIds: ['b'], entryId: 'e7', songs: 1, total: 1, remaining: 1 }],
    [P('2026-10-16T19:20'), 'defer.ended', { ownerId: 'b', entryId: 'e7', how: 'released' }],
  ]);
  events.splice(23, 0, { personId: 'c', entryId: 'e5', title: 'Cinq', mode: 'append', v: 1, seq: 97, t: P('2026-10-15T23:40'),
    ev: 'song.requested', boot: 'b1' });
  const meta = metaOf(events, { people: [...PEOPLE, ['d', '3']], tables: [...TABLES, ['3']] });
  const [, second] = plan(events, meta).pieces;
  assert.deepEqual(second.carried.filter(e => e.ev === 'person.joined').map(e => [e.personId, e.tableId]), [['c', '2'], ['s', 'Comptoir']]);
  assert.deepEqual(second.carried.filter(e => e.ev === 'table.opened').map(e => [e.tableId, e.individual]), [['Comptoir', true], ['2', false]]);
  assert.deepEqual(Object.keys(second.meta.roster), ['c', 's', 'd']);
  assert.deepEqual(Object.keys(second.meta.tables), ['2', '3', 'Comptoir']);
});

// Jeudi : la table 3 (six personnes, bonus +2 du bar), où a chante. « Table
// partie » (POST /api/staff/table-left, Scheduler.tableLeft) retire la table
// et ses personnes et révoque son QR ; « Créer les tables » la rouvre ensuite
// sous le même numéro comme une table neuve (Scheduler.table : ni effectif ni
// bonus).
const TABLE_3_JEUDI = [
  [P('2026-10-15T19:00'), 'evening.started', { rules: {} }],
  [P('2026-10-15T19:05'), 'table.opened', { tableId: '3', individual: false }],
  [P('2026-10-15T19:05') + 1, 'table.headcount', { tableId: '3', n: 6, by: 'staff' }],
  [P('2026-10-15T19:10'), 'person.joined', { personId: 'a', tableId: '3' }],
  [P('2026-10-15T19:20'), 'table.bonus', { tableId: '3', level: 2 }],
  [P('2026-10-15T19:30'), 'song.requested', { personId: 'a', entryId: 'e1', mode: 'append' }],
  [P('2026-10-15T19:35'), 'stage.started', { queueId: 1, entryId: 'e1', ids: ['a'], ownerId: 'a', source: 'queue' }],
  [P('2026-10-15T19:39'), 'stage.ended', { queueId: 1, playedSec: 240 }],
];

test('A4 : table partie avant la coupure (table.left), rouverte sous le même numéro le soir suivant : table créée dans le morceau, sans ligne reportée (ni l’ouverture, ni l’effectif, ni le bonus de l’ancienne)', () => {
  const events = journal([
    ...TABLE_3_JEUDI,
    [P('2026-10-15T23:30'), 'table.left', { tableId: '3', personIds: ['a'], songsDropped: 0 }],
    // Vendredi : la table 3 rouverte, nouvelle tablée de deux.
    [P('2026-10-16T19:00'), 'table.opened', { tableId: '3', individual: false }],
    [P('2026-10-16T19:00') + 1, 'table.headcount', { tableId: '3', n: 2, by: 'staff' }],
    [P('2026-10-16T19:01'), 'person.joined', { personId: 'z', tableId: '3' }],
    [P('2026-10-16T19:02'), 'song.requested', { personId: 'z', entryId: 'e2', mode: 'append' }],
    [P('2026-10-16T19:05'), 'stage.started', { queueId: 2, entryId: 'e2', ids: ['z'], ownerId: 'z', source: 'queue' }],
  ]);
  const meta = metaOf(events, { people: [['a', '3'], ['z', '3']], tables: [['3']] });
  const result = plan(events, meta);
  assert.deepEqual(result.cuts, [C16]);
  const [, second] = result.pieces;
  assert.deepEqual(second.carried, [carriedLine(C16, 'split-g1-k2', 0, 'evening.started', { rules: {} })]);
  assert.deepEqual([Object.keys(second.meta.roster), Object.keys(second.meta.tables)], [['z'], ['3']]);
  // Le vendredi, la table 3 n'a pas le bonus de celle du jeudi.
  const lines = pieceJournal(second);
  const stats = computeStats({ meta: second.meta, events: lines, now: lines.at(-1).t });
  assert.deepEqual(stats.tables.map(tb => [tb.id, tb.bonus]), [['3', 0]]);
});

test('A4 : table partie puis rouverte sous le même numéro le même soir : reportée pour une personne citée de sa nouvelle tablée, avec l’effectif de celle-ci, sans le bonus de l’ancienne', () => {
  const events = journal([
    ...TABLE_3_JEUDI,
    [P('2026-10-15T21:00'), 'table.left', { tableId: '3', personIds: ['a'], songsDropped: 0 }],
    // Rouverte à 21 h 30 ; b s'y inscrit et donne l'effectif (Scheduler.join).
    [P('2026-10-15T21:30'), 'table.opened', { tableId: '3', individual: false }],
    [P('2026-10-15T21:31'), 'table.headcount', { tableId: '3', n: 3, by: 'table' }],
    [P('2026-10-15T21:31') + 1, 'person.joined', { personId: 'b', tableId: '3' }],
    [P('2026-10-15T21:40'), 'song.requested', { personId: 'b', entryId: 'e2', mode: 'append' }],
    [P('2026-10-15T21:45'), 'stage.started', { queueId: 2, entryId: 'e2', ids: ['b'], ownerId: 'b', source: 'queue' }],
    [P('2026-10-15T21:49'), 'stage.ended', { queueId: 2, playedSec: 240 }],
    // Vendredi : b demande un titre.
    [P('2026-10-16T19:00'), 'song.requested', { personId: 'b', entryId: 'e3', mode: 'append' }],
  ]);
  const meta = metaOf(events, { people: [['a', '3'], ['b', '3']], tables: [['3']] });
  const result = plan(events, meta);
  assert.deepEqual(result.cuts, [C16]);
  const boot = 'split-g1-k2';
  assert.deepEqual(result.pieces[1].carried, [
    carriedLine(C16, boot, -3, 'evening.started', { rules: {} }),
    carriedLine(C16, boot, -2, 'table.opened', { tableId: '3', individual: false }),
    carriedLine(C16, boot, -1, 'table.headcount', { tableId: '3', n: 3, by: 'table' }),
    carriedLine(C16, boot, 0, 'person.joined', { personId: 'b', tableId: '3' }),
  ]);
});

// ------------------------------- A4 : computeStats et l'export d'un morceau
// Un morceau se reconnaît à ses lignes reportées (carried: true), comme dans
// planSplit, même relu sans sa meta (rejeu --soiree).

test('A4 : computeStats d’un morceau : lignes reportées lues comme l’état à son début (table d’une personne, bonus en vigueur, phase de KaraFun), sans aucun compteur : ni staff.bonus, ni ouverture de table, ni inscription, ni ligne reportée d’un type qui n’est pas de l’état', () => {
  // a (table 1, bonus -1 ; table 1 à +2) et s (« En solo ») chantent le vendredi.
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'karaoke.phase', { phase: 'silent', blocker: 'empty' }],
    [P('2026-10-16T19:05'), 'song.requested', { personId: 'a', entryId: 'e9', title: 'Neuf', mode: 'append' }],
    [P('2026-10-16T19:06'), 'song.requested', { personId: 's', entryId: 'e10', title: 'Dix', mode: 'append' }],
    [P('2026-10-16T19:10'), 'stage.started', { queueId: 3, entryId: 'e9', ids: ['a'], ownerId: 'a', source: 'queue', title: 'Neuf' }],
    [P('2026-10-16T19:14'), 'stage.ended', { queueId: 3, playedSec: 240 }],
    [P('2026-10-16T19:15'), 'stage.started', { queueId: 4, entryId: 'e10', ids: ['s'], ownerId: 's', source: 'queue', title: 'Dix' }],
    [P('2026-10-16T19:19'), 'stage.ended', { queueId: 4, playedSec: 240 }],
  ]);
  const [, second] = plan(events, metaOf(events, { people: PEOPLE, tables: TABLES })).pieces;
  assert.deepEqual(evs(second.carried), ['evening.started', 'karaoke.phase', 'table.opened', 'table.opened', 'table.headcount', 'table.bonus',
    'person.joined', 'person.bonus', 'person.joined']);
  // Une ligne reportée d'un autre type (planSplit n'en écrit pas) n'est pas de
  // l'état : elle ne compte pas.
  const stray = carriedLine(C16, 'split-g1-k2', -9, 'song.requested', { personId: 'a', entryId: 'eX', title: 'Reportée', mode: 'append' });
  const lines = [stray, ...pieceJournal(second)];
  const stats = computeStats({ meta: second.meta, events: lines, now: lines.at(-1).t });
  // Les bonus reportés sont de l'état, pas des gestes du bar du morceau.
  assert.equal(stats.global.staff.bonus, 0, 'staff.bonus');
  assert.deepEqual([stats.global.registered, stats.global.requests], [2, 2]);
  const a = singerOf(stats, 'a'), s = singerOf(stats, 's');
  // Bonus en vigueur pendant toute sa présence : -1 pour elle, +2 pour sa table.
  assert.deepEqual([a.tableId, a.bonus, a.weight, a.requests], ['1', -1, 1.2, 1]);
  assert.deepEqual([s.tableId, s.bonus, s.weight, s.requests], ['Comptoir', 0, 1, 1]);
  assert.ok(!a.songs.some(song => song.entryId === 'eX'), 'demande reportée comptée');
  // Ni ouverture de table : les tables de la veille n'ont pas d'heure
  // d'ouverture dans le morceau ; « En solo » garde son genre.
  assert.deepEqual(stats.tables.map(tb => [tb.id, tb.individual, tb.openedAt, tb.bonus]),
    [['Comptoir', true, null, 0], ['1', false, null, 2]]);
  // Ni inscription : chacune est du morceau dès son début, sa présence
  // comptée à partir de l'ouverture du karaoké, comme aujourd'hui.
  assert.deepEqual([a.joinedAt, s.joinedAt], [C16, C16]);
  assert.ok(stats.evening.openedAt > C16, 'karaoké ouvert à la coupure');
  // Phase de KaraFun : celle de la coupure (coupé depuis 1 h 10), puis 19 h.
  assert.deepEqual(stats.timeline.phases.slice(0, 2).map(ph => [ph.start, ph.phase, ph.blocker]),
    [[C16, 'unknown', 'offline'], [P('2026-10-16T19:00'), 'silent', 'empty']]);
  // Aucune ligne reportée n'est comptée : quality ne voit que les lignes du morceau.
  assert.equal(stats.quality.events, second.lines.length);
  assert.deepEqual(['evening.started', 'table.headcount', 'song.requested'].filter(type => type in stats.quality.other), []);
  // Relu sans sa meta, comme le rejeu relit un morceau (--soiree,
  // computeStats({ events, now })) : la table de chaque personne et « En
  // solo » ne viennent plus que des lignes reportées.
  const bare = computeStats({ events: lines, now: lines.at(-1).t });
  const view = st => ({ tables: st.tables.map(tb => [tb.id, tb.individual, tb.people, tb.bonus]),
    singers: st.singers.map(x => [x.id, x.tableId, x.bonus, x.weight]) });
  assert.deepEqual(view(bare), view(stats), 'relu sans meta');
  assert.deepEqual(view(bare).tables, [['Comptoir', true, 1, 0], ['1', false, 1, 2]]);
});

// Jeudi 15 et vendredi 16 octobre, aux identifiants reconnaissables (id-…,
// tb-…) : aucun ne doit sortir de l'export d'un morceau.
function veilleNommee() {
  return journal([
    [P('2026-10-15T19:00'), 'evening.started', { rules: { auto: true } }],
    [P('2026-10-15T19:00') + 1, 'table.opened', { tableId: 'tb-solo', individual: true }],
    [P('2026-10-15T19:01'), 'karaoke.phase', { phase: 'silent', blocker: 'empty' }],
    [P('2026-10-15T19:05'), 'table.opened', { tableId: 'tb-un', individual: false }],
    [P('2026-10-15T19:05') + 1, 'table.headcount', { tableId: 'tb-un', n: 4, by: 'staff' }],
    [P('2026-10-15T19:06'), 'table.opened', { tableId: 'tb-deux', individual: false }],
    [P('2026-10-15T19:07'), 'table.opened', { tableId: 'tb-trois', individual: false }],
    [P('2026-10-15T19:10'), 'person.joined', { personId: 'id-ana', tableId: 'tb-un' }],
    [P('2026-10-15T19:11'), 'person.joined', { personId: 'id-bea', tableId: 'tb-un' }],
    [P('2026-10-15T19:12'), 'person.joined', { personId: 'id-cyd', tableId: 'tb-deux' }],
    [P('2026-10-15T19:13'), 'person.joined', { personId: 'id-sol', tableId: 'tb-solo' }],
    [P('2026-10-15T19:20'), 'table.bonus', { tableId: 'tb-un', level: 2 }],
    [P('2026-10-15T19:21'), 'person.bonus', { personId: 'id-ana', level: -1 }],
    [P('2026-10-15T19:30'), 'song.requested', { personId: 'id-ana', entryId: 'e1', title: 'Un', mode: 'append' }],
    [P('2026-10-15T19:31'), 'song.requested', { personId: 'id-sol', entryId: 'e8', title: 'Huit', mode: 'append' }],
    [P('2026-10-15T19:35'), 'stage.started', { queueId: 1, entryId: 'e1', ids: ['id-ana'], ownerId: 'id-ana', source: 'queue', title: 'Un' }],
    [P('2026-10-15T19:39'), 'stage.ended', { queueId: 1, playedSec: 240 }],
    [P('2026-10-16T01:10'), 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }],
    // Vendredi : id-cyd et sa table tb-deux, nommées seulement par des lignes
    // qui ne citent pas, une de chaque sorte (A7).
    [P('2026-10-16T19:00'), 'person.seen', { personId: 'id-cyd' }],
    [P('2026-10-16T19:01'), 'notice.sent', { personId: 'id-cyd', kind: 'turnSoon' }],
    [P('2026-10-16T19:02'), 'presence.asked', { personIds: ['id-cyd'], entryId: null, source: 'auto' }],
    [P('2026-10-16T19:03'), 'presence.skipped', { personId: 'id-cyd', entryId: 'e5', skips: 1, removed: false }],
    [P('2026-10-16T19:04'), 'person.bonus', { personId: 'id-cyd', level: 1 }],
    [P('2026-10-16T19:05'), 'defer.requested', { ownerId: 'id-cyd', personIds: ['id-cyd'], entryId: null, songs: 1 }],
    [P('2026-10-16T19:06'), 'person.left', { personId: 'id-cyd', by: 'staff', songsDropped: 0 }],
    [P('2026-10-16T19:07'), 'table.left', { tableId: 'tb-deux', personIds: ['id-cyd'], songsDropped: 0 }],
    [P('2026-10-16T19:08'), 'karaoke.phase', { phase: 'silent', blocker: 'empty' }],
    // Nouvelle tablée : id-zoe invite id-bea (partnerId) et lui cède sa place
    // (toId) ; id-bea n'est pas citée.
    [P('2026-10-16T19:10'), 'table.opened', { tableId: 'tb-neuf', individual: false }],
    [P('2026-10-16T19:11'), 'person.joined', { personId: 'id-zoe', tableId: 'tb-neuf' }],
    [P('2026-10-16T19:12'), 'song.requested', { personId: 'id-zoe', entryId: 'e9', title: 'Neuf', mode: 'append' }],
    [P('2026-10-16T19:13'), 'duo.invited', { personId: 'id-zoe', entryId: 'e9', ownerId: 'id-zoe', partnerId: 'id-bea', sameGroup: false }],
    [P('2026-10-16T19:14'), 'person.gaveSpot', { personId: 'id-zoe', toId: 'id-bea' }],
    // Gestes du bar sur id-bea et sur id-sol : bonus, réglage et retrait du titre de la veille.
    [P('2026-10-16T19:15'), 'person.bonus', { personId: 'id-bea', level: 2 }],
    [P('2026-10-16T19:16'), 'song.settings', { by: 'staff', where: 'list', personId: 'id-sol', entryId: 'e8', settings: { pitch: 1 } }],
    [P('2026-10-16T19:17'), 'song.removed', { personId: 'id-sol', entryId: 'e8', by: 'staff' }],
    // id-ana, de la veille, demande un titre ; id-eve rejoint tb-trois, une table de la veille.
    [P('2026-10-16T19:18'), 'song.requested', { personId: 'id-ana', entryId: 'e10', title: 'Dix', mode: 'append' }],
    [P('2026-10-16T19:19'), 'person.joined', { personId: 'id-eve', tableId: 'tb-trois' }],
    [P('2026-10-16T19:20'), 'stage.started', { queueId: 3, entryId: 'e9', ids: ['id-zoe'], ownerId: 'id-zoe', source: 'queue', title: 'Neuf' }],
    [P('2026-10-16T19:24'), 'stage.ended', { queueId: 3, playedSec: 240 }],
    [P('2026-10-16T19:25'), 'stage.started', { queueId: 4, entryId: 'e10', ids: ['id-ana'], ownerId: 'id-ana', source: 'queue', title: 'Dix' }],
    [P('2026-10-16T19:29'), 'stage.ended', { queueId: 4, playedSec: 240 }],
  ]);
}

test('A4 : computeStats et export d’un morceau : une personne et une table de la veille nommées seulement par des lignes qui ne citent pas n’y sont ni créées ni comptées (inscrits, présences, tables), sans erreur, et aucun identifiant interne ne sort de son export ; une personne de la veille qui demande un titre y est avec sa table et son bonus, une table de la veille rejointe par une nouvelle inscription aussi', () => {
  const events = veilleNommee();
  const meta = metaOf(events, { people: [['id-ana', 'tb-un'], ['id-bea', 'tb-un'], ['id-cyd', 'tb-deux'], ['id-sol', 'tb-solo'],
    ['id-zoe', 'tb-neuf'], ['id-eve', 'tb-trois']], tables: [['tb-solo', true], ['tb-un'], ['tb-deux'], ['tb-trois'], ['tb-neuf']] });
  const result = plan(events, meta);
  assert.deepEqual(result.cuts, [C16]);
  const second = result.pieces[1];
  assert.deepEqual(second.carried.filter(e => e.ev === 'person.joined' || e.ev === 'table.opened').map(e => [e.ev, e.personId ?? e.tableId]),
    [['table.opened', 'tb-un'], ['table.opened', 'tb-trois'], ['person.joined', 'id-ana']]);
  const stats = statsOfPiece(second);
  // Inscrits, présences et tables : rien pour id-cyd, id-bea, id-sol ni tb-deux.
  assert.equal(stats.global.registered, 3);
  assert.deepEqual(stats.singers.map(s => [s.id, s.tableId, s.bonus]), [['id-ana', 'tb-un', -1], ['id-zoe', 'tb-neuf', 0], ['id-eve', 'tb-trois', 0]]);
  assert.deepEqual(stats.tables.map(tb => [tb.id, tb.people, tb.bonus]), [['tb-un', 1, 2], ['tb-trois', 1, 0], ['tb-neuf', 1, 0]]);
  // Même règle que la meta du morceau (planSplit) : ses personnes et ses tables.
  assert.deepEqual([Object.keys(second.meta.roster).sort(), Object.keys(second.meta.tables).sort()],
    [stats.singers.map(s => s.id).sort(), stats.tables.map(tb => tb.id).sort()]);
  // Relu sans sa meta (rejeu --soiree) : les mêmes, par les lignes du morceau
  // (table reportée d'id-ana, tb-trois rejointe par id-eve).
  const bare = computeStats({ events: pieceJournal(second), now: second.lines.at(-1).t });
  const view = st => ({ singers: st.singers.map(s => [s.id, s.tableId, s.bonus]), tables: st.tables.map(tb => [tb.id, tb.individual, tb.people, tb.bonus]) });
  assert.deepEqual(view(bare), view(stats), 'relu sans meta');
  // Leurs lignes sont ignorées : ni bonus, ni retrait, ni avis, ni « Je suis
  // là » ; l'invitation d'id-zoe compte, pour elle seule.
  assert.deepEqual([stats.global.staff.bonus, stats.global.staff.removedSongs, stats.global.notices.sent, stats.global.presence.asks,
    stats.global.presence.skips, stats.global.deferrals.count], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([stats.global.duos.invites, singerOf(stats, 'id-zoe').invitesSent], [1, 1]);
  assert.deepEqual(['song.settings'].filter(type => type in stats.quality.other), []);
  // Export : une clé pour chaque personne nommée, dans l'ordre des lignes après
  // les chanteurs ; aucun identifiant interne, prénoms ni noms de table.
  const exported = exportEvening({ meta: second.meta, events: pieceJournal(second), now: second.lines.at(-1).t });
  const text = JSON.stringify(exported);
  assert.ok(!/id-|tb-/.test(text), `identifiant interne dans l'export : ${text.match(/.{0,40}(id-|tb-).{0,40}/)?.[0]}`);
  assert.deepEqual(exported.people, [{ key: 'S01', table: 'T1' }, { key: 'S02', table: 'T3' }, { key: 'S03', table: 'T2' },
    { key: 'S04', table: null }, { key: 'S05', table: null }, { key: 'S06', table: null }]);
  const line = ev => exported.events.find(e => e.ev === ev);
  assert.deepEqual([line('person.seen').personId, line('duo.invited').partnerId, line('person.gaveSpot').toId, line('song.settings').personId,
    line('table.left').tableId], ['S04', 'S05', 'S05', 'S06', 'T?']);
});

test('A4 : computeStats d’un morceau : une table ni reportée, ni ouverte, ni citée n’y est jamais créée, même nommée avec une personne du morceau (table 2 de la veille supprimée avec m, dont l’inscription s’est perdue) ; m y part quand même', () => {
  // m, inscrite vendredi à la table 2 sans ligne person.joined (écriture en
  // échec, meta.roster seul la place), demande un titre ; le bar supprime la
  // table 2, celle de c, qui n'est pas citée.
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'song.requested', { personId: 'm', entryId: 'e12', title: 'Douze', mode: 'append' }],
    [P('2026-10-16T19:05'), 'stage.started', { queueId: 3, entryId: 'e12', ids: ['m'], ownerId: 'm', source: 'queue', title: 'Douze' }],
    [P('2026-10-16T19:09'), 'stage.ended', { queueId: 3, playedSec: 240 }],
    [P('2026-10-16T19:30'), 'table.left', { tableId: '2', personIds: ['c', 'm'], songsDropped: 0 }],
  ]);
  const [, second] = plan(events, metaOf(events, { people: [...PEOPLE, ['m', '2']], tables: TABLES })).pieces;
  assert.deepEqual(evs(second.carried), ['evening.started', 'karaoke.phase'], 'ni c ni la table 2 reportées');
  const stats = statsOfPiece(second);
  assert.deepEqual(stats.singers.map(s => [s.id, s.tableId, s.explicitLeft, s.leftAt]), [['m', '2', true, P('2026-10-16T19:30')]]);
  assert.deepEqual(stats.tables, [], 'table 2 créée');
});

test('A4 : computeStats d’un morceau : un champ de mauvais type se lit comme absent (A7), comme dans planSplit ; un champ de personne ne nomme alors personne et la ligne compte comme une ligne sans personne, au lieu d’être ignorée comme une ligne qui ne nommerait que la veille (l’export lui donne quand même une clé) ; une table qui n’est pas une chaîne non vide ne déplace personne, et « En solo » n’est vrai que s’il vaut true', () => {
  // c, de la veille, n'est pas citée vendredi. Deux lignes la mettent dans un
  // champ de mauvais type : une liste qui n'en est pas une (personIds en
  // chaîne), une liste à la place d'un identifiant (personId). Témoins : les
  // mêmes lignes qui la nomment pour de bon, ignorées. Puis a, reportée à la
  // table 1, reçoit une inscription dont la table est un nombre, et n
  // s'inscrit à la table 9, ouverte avec un « En solo » en texte.
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'song.requested', { personId: 'a', entryId: 'e9', title: 'Neuf', mode: 'append' }],
    [P('2026-10-16T19:01'), 'notice.sent', { personIds: 'c', kind: 'turnSoon' }],
    [P('2026-10-16T19:02'), 'staff.move', { personId: ['c'], kind: 'move', from: 2, to: 1 }],
    [P('2026-10-16T19:03'), 'notice.sent', { personId: 'c', kind: 'turnSoon' }],
    [P('2026-10-16T19:04'), 'staff.move', { personId: 'c', kind: 'move', from: 2, to: 1 }],
    [P('2026-10-16T19:05'), 'stage.started', { queueId: 3, entryId: 'e9', ids: ['a'], ownerId: 'a', source: 'queue', title: 'Neuf' }],
    [P('2026-10-16T19:09'), 'stage.ended', { queueId: 3, playedSec: 240 }],
    [P('2026-10-16T19:10'), 'person.joined', { personId: 'a', tableId: 5 }],
    [P('2026-10-16T19:11'), 'table.opened', { tableId: '9', individual: 'false' }],
    [P('2026-10-16T19:12'), 'person.joined', { personId: 'n', tableId: '9' }],
  ]);
  const [, second] = plan(events, metaOf(events, { people: PEOPLE, tables: TABLES })).pieces;
  assert.deepEqual(second.carried.filter(e => e.ev === 'person.joined').map(e => e.personId), ['a'], 'c ni citée ni reportée');
  const stats = statsOfPiece(second);
  assert.deepEqual(stats.singers.map(s => s.id), ['a', 'n']);
  // Comme une ligne sans personne : un avis et un déplacement comptés, ceux
  // qui nomment c pour de bon ignorés.
  assert.deepEqual([stats.global.notices.sent, stats.global.staff.moves], [1, 1]);
  // L'export lit large : c reçoit une clé, même dans un champ de mauvais type.
  const exported = exportEvening({ meta: second.meta, events: pieceJournal(second), now: second.lines.at(-1).t });
  assert.deepEqual(exported.events.filter(e => e.ev === 'notice.sent' || e.ev === 'staff.move').map(e => e.personIds ?? e.personId),
    ['S03', ['S03'], 'S03', 'S03']);
  // a reste à la table 1, et la table 9 est ordinaire, avec sa meta ou relu
  // sans elle (rejeu --soiree).
  const bare = computeStats({ events: pieceJournal(second), now: second.lines.at(-1).t });
  // Une ligne reportée se lit par la même règle, bien que planSplit n'en écrive
  // jamais de mal formée : une table en nombre ne place pas a (elle garde celle
  // de meta.roster), un « En solo » en texte n'est pas vrai.
  const altered = pieceJournal(second).map(e => (!e.carried ? e : e.ev === 'person.joined' ? { ...e, tableId: 7 }
    : e.ev === 'table.opened' ? { ...e, individual: 'false' } : e));
  const alteredStats = computeStats({ meta: second.meta, events: altered, now: second.lines.at(-1).t });
  for (const [label, st] of [['meta', stats], ['sans meta', bare], ['lignes reportées mal formées', alteredStats]]) {
    assert.deepEqual(st.singers.map(s => [s.id, s.tableId]), [['a', '1'], ['n', '9']], label);
    assert.deepEqual(st.tables.map(tb => [tb.id, tb.individual, tb.people]), [['1', false, 1], ['9', false, 1]], label);
  }
  // Même lecture que planSplit : recoupé le samedi, le morceau suivant reporte
  // a à la table 1 et la table 9 ordinaire.
  let seq = maxSeq(events);
  const saturday = [...pieceJournal(second), ...[
    [P('2026-10-17T19:00'), 'song.requested', { personId: 'a', entryId: 'e10', mode: 'append' }],
    [P('2026-10-17T19:01'), 'song.requested', { personId: 'n', entryId: 'e11', mode: 'append' }],
  ].map(([t, ev, fields]) => ({ ...fields, v: 1, seq: ++seq, t, ev, boot: 'b2' }))];
  const resplit = plan(saturday, second.meta);
  assert.deepEqual(resplit.cuts, [P('2026-10-17T08:00')]);
  const next = resplit.pieces[1].carried;
  assert.deepEqual(next.filter(e => e.ev === 'table.opened').map(e => [e.tableId, e.individual]), [['1', false], ['9', false]]);
  assert.deepEqual(next.filter(e => e.ev === 'person.joined').map(e => [e.personId, e.tableId]), [['a', '1'], ['n', '9']]);
});

test('A4 : computeStats d’un morceau dont KaraFun est resté connecté de la coupure jusqu’au soir : karaoké ouvert à sa première activité (lignes reportées exclues), présence des personnes reportées comptée de là, jamais de la coupure ; un morceau sans activité et un journal sans ligne reportée gardent la règle d’aujourd’hui', () => {
  const events = journal([
    [P('2026-10-15T19:00'), 'evening.started', { rules: {} }],
    [P('2026-10-15T19:00') + 1, 'app.started', { restored: false, offlineMs: 0 }],
    [P('2026-10-15T19:01'), 'karaoke.phase', { phase: 'silent', blocker: 'empty' }],
    [P('2026-10-15T19:05'), 'table.opened', { tableId: '1', individual: false }],
    [P('2026-10-15T19:10'), 'person.joined', { personId: 'a', tableId: '1' }],
    [P('2026-10-15T19:11'), 'person.joined', { personId: 'b', tableId: '1' }],
    [P('2026-10-15T19:30'), 'song.requested', { personId: 'a', entryId: 'e1', mode: 'append' }],
    [P('2026-10-15T19:35'), 'stage.started', { queueId: 1, entryId: 'e1', ids: ['a'], ownerId: 'a', source: 'queue' }],
    [P('2026-10-15T19:39'), 'stage.ended', { queueId: 1, playedSec: 240 }],
    [P('2026-10-15T23:30'), 'song.requested', { personId: 'b', entryId: 'e2', mode: 'append' }],
    [P('2026-10-15T23:35'), 'stage.started', { queueId: 2, entryId: 'e2', ids: ['b'], ownerId: 'b', source: 'queue' }],
    [P('2026-10-15T23:39'), 'stage.ended', { queueId: 2, playedSec: 240 }],
    [P('2026-10-15T23:39') + 1, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }],
    // Vendredi, KaraFun toujours connecté : a demande un titre à 20 h, b à 21 h.
    [P('2026-10-16T20:00'), 'song.requested', { personId: 'a', entryId: 'e3', mode: 'append' }],
    [P('2026-10-16T20:05'), 'stage.started', { queueId: 3, entryId: 'e3', ids: ['a'], ownerId: 'a', source: 'queue' }],
    [P('2026-10-16T20:09'), 'stage.ended', { queueId: 3, playedSec: 240 }],
    [P('2026-10-16T21:00'), 'song.requested', { personId: 'b', entryId: 'e4', mode: 'append' }],
    [P('2026-10-16T21:05'), 'stage.started', { queueId: 4, entryId: 'e4', ids: ['b'], ownerId: 'b', source: 'queue' }],
    [P('2026-10-16T21:09'), 'stage.ended', { queueId: 4, playedSec: 240 }],
  ]);
  const result = plan(events, metaOf(events, { people: [['a', '1'], ['b', '1']], tables: [['1']] }));
  assert.deepEqual(result.cuts, [C16]);
  const [, second] = result.pieces;
  assert.deepEqual(second.carried.filter(e => e.ev === 'karaoke.phase').map(e => [e.phase, e.blocker]), [['silent', 'empty']],
    'KaraFun connecté à la coupure');
  assert.deepEqual(second.carried.filter(e => e.ev === 'person.joined').map(e => e.personId), ['a', 'b']);
  const stats = statsOfPiece(second);
  // Ouvert à 20 h, la première demande du vendredi, et non à 8 h.
  assert.equal(stats.evening.openedAt, P('2026-10-16T20:00'));
  // a : de 20 h à 20 h 35 (dernier signe à 20 h 05 + 30 min) ; b : de 20 h à
  // la fin du karaoké, 21 h 09, pas depuis 8 h.
  assert.deepEqual(['a', 'b'].map(id => [singerOf(stats, id).presenceSec, singerOf(stats, id).leftAt]),
    [[35 * 60, P('2026-10-16T20:35')], [69 * 60, P('2026-10-16T21:09')]]);
  // Sans activité à lui (un téléphone revu seulement), le morceau garde
  // l'ouverture d'aujourd'hui : KaraFun connecté, dès son début.
  const idle = [...second.carried, { personId: 'a', v: 1, seq: 30, t: P('2026-10-16T20:00'), ev: 'person.seen', boot: 'b1' }];
  assert.equal(computeStats({ meta: second.meta, events: idle, now: P('2026-10-16T21:00') }).evening.openedAt, C16);
  // Les mêmes lignes sans les lignes reportées : un journal d'aujourd'hui, ouvert comme aujourd'hui.
  assert.equal(computeStats({ meta: second.meta, events: second.lines, now: second.lines.at(-1).t }).evening.openedAt, C16);
});

test('A4 : computeStats d’un morceau : une personne partie avant la coupure (« Je pars ») que le bar réactive le soir suivant y est reportée, mais sa présence part de son retour, comme dans le journal entier, et non de l’ouverture du karaoké ; une personne reportée qui part puis revient dans le morceau garde la règle d’aujourd’hui', () => {
  // Vendredi : d s'inscrit à 20 h (première activité du morceau) ; a, de la
  // veille, chante, part à 20 h 35 et revient à 21 h 30 ; c, partie jeudi à
  // 23 h 50, revient à 21 h (réactivée par le bar, seul retour possible) et chante.
  const events = deuxNuits([
    [P('2026-10-16T20:00'), 'table.opened', { tableId: '3', individual: false }],
    [P('2026-10-16T20:00') + 1, 'person.joined', { personId: 'd', tableId: '3' }],
    [P('2026-10-16T20:02'), 'song.requested', { personId: 'd', entryId: 'e3', mode: 'append' }],
    [P('2026-10-16T20:10'), 'stage.started', { queueId: 3, entryId: 'e3', ids: ['d'], ownerId: 'd', source: 'queue' }],
    [P('2026-10-16T20:14'), 'stage.ended', { queueId: 3, playedSec: 240 }],
    [P('2026-10-16T20:20'), 'song.requested', { personId: 'a', entryId: 'e5', mode: 'append' }],
    [P('2026-10-16T20:25'), 'stage.started', { queueId: 5, entryId: 'e5', ids: ['a'], ownerId: 'a', source: 'queue' }],
    [P('2026-10-16T20:29'), 'stage.ended', { queueId: 5, playedSec: 240 }],
    [P('2026-10-16T20:35'), 'person.left', { personId: 'a', by: 'self', songsDropped: 0 }],
    [P('2026-10-16T21:00'), 'person.reactivated', { personId: 'c' }],
    [P('2026-10-16T21:05'), 'song.requested', { personId: 'c', entryId: 'e4', mode: 'append' }],
    [P('2026-10-16T21:10'), 'stage.started', { queueId: 4, entryId: 'e4', ids: ['c'], ownerId: 'c', source: 'queue' }],
    [P('2026-10-16T21:14'), 'stage.ended', { queueId: 4, playedSec: 240 }],
    [P('2026-10-16T21:30'), 'person.reactivated', { personId: 'a' }],
    [P('2026-10-16T21:35'), 'song.requested', { personId: 'a', entryId: 'e6', mode: 'append' }],
    [P('2026-10-16T21:40'), 'stage.started', { queueId: 6, entryId: 'e6', ids: ['a'], ownerId: 'a', source: 'queue' }],
    [P('2026-10-16T21:44'), 'stage.ended', { queueId: 6, playedSec: 240 }],
    [P('2026-10-16T22:30'), 'song.requested', { personId: 'd', entryId: 'e7', mode: 'append' }],
    [P('2026-10-16T22:35'), 'stage.started', { queueId: 7, entryId: 'e7', ids: ['d'], ownerId: 'd', source: 'queue' }],
    [P('2026-10-16T22:39'), 'stage.ended', { queueId: 7, playedSec: 240 }],
  ]);
  // Départ de c jeudi à 23 h 50, à sa place dans le journal.
  events.splice(23, 0, { personId: 'c', by: 'self', songsDropped: 0, v: 1, seq: 0, t: P('2026-10-15T23:50'), ev: 'person.left', boot: 'b1' });
  events.forEach((e, i) => { e.seq = i + 1; });
  const meta = metaOf(events, { people: [...PEOPLE, ['d', '3']], tables: [...TABLES, ['3']] });
  const result = plan(events, meta);
  assert.deepEqual(result.cuts, [C16]);
  const [, second] = result.pieces;
  // c, citée par son retour, est reportée comme a (lignes reportées inchangées).
  assert.deepEqual(second.carried.filter(e => e.ev === 'person.joined').map(e => e.personId), ['a', 'c']);
  const stats = statsOfPiece(second);
  assert.equal(stats.evening.openedAt, P('2026-10-16T20:00'));
  // c : de son retour (21 h) à son dernier signe + 30 min (21 h 40), soit
  // 40 min, et non 100 depuis l'ouverture ; comme la fin de sa présence dans
  // le journal entier, où son départ de jeudi est lu.
  const c = singerOf(stats, 'c');
  assert.deepEqual([c.presenceSec, c.leftAt, c.explicitLeft], [40 * 60, P('2026-10-16T21:40'), false]);
  assert.equal(singerOf(computeStats({ meta, events, now: events.at(-1).t }), 'c').leftAt, c.leftAt);
  // a, reportée présente : de l'ouverture (20 h) à son départ (20 h 35), puis
  // de son retour (21 h 30) à 22 h 10, comme aujourd'hui.
  const a = singerOf(stats, 'a');
  assert.deepEqual([a.presenceSec, a.leftAt], [75 * 60, P('2026-10-16T22:10')]);
});

test('A4 : titre demandé avant la coupure et chanté après : passage compté, attente inconnue ; sa chanteuse reportée', () => {
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'table.opened', { tableId: '3', individual: false }],
    [P('2026-10-16T19:01'), 'person.joined', { personId: 'd', tableId: '3' }],
    [P('2026-10-16T19:20'), 'turn.sent', { entryId: 'e2b', ids: ['b'], ownerId: 'b', sentAt: P('2026-10-16T19:20') }],
    [P('2026-10-16T19:21'), 'stage.started', { queueId: 3, entryId: 'e2b', ids: ['b'], ownerId: 'b', source: 'queue', title: 'Demandé jeudi' }],
    [P('2026-10-16T19:25'), 'stage.ended', { queueId: 3, playedSec: 240 }],
  ]);
  // La demande de e2b, jeudi à 23 h 50, après le dernier titre de la soirée.
  events.splice(23, 0, { personId: 'b', entryId: 'e2b', title: 'Demandé jeudi', mode: 'append', v: 1, seq: 99, t: P('2026-10-15T23:50'),
    ev: 'song.requested', boot: 'b1' });
  const meta = metaOf(events, { people: [...PEOPLE, ['d', '3']], tables: [...TABLES, ['3']] });
  const [first, second] = plan(events, meta).pieces;
  assert.ok(first.lines.some(e => e.entryId === 'e2b' && e.ev === 'song.requested'), 'demande au premier morceau');
  assert.ok(!second.lines.some(e => e.ev === 'song.requested'), 'aucune demande reportée');
  assert.deepEqual(second.carried.filter(e => e.ev === 'person.joined').map(e => e.personId), ['b']);
  const lines = pieceJournal(second);
  const stats = computeStats({ meta: second.meta, events: lines, now: lines.at(-1).t });
  const stage = stageOf(stats, 'e2b');
  assert.ok(stage, 'passage compté');
  assert.equal(stage.waitSec, null, 'attente inconnue');
  assert.equal(stats.global.ours, 1);
});

test('A4 : réponse à une invitation de duo faite avant la coupure : reste au morceau suivant, et la personne qui répond y est citée, donc reportée', () => {
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'duo.answered', { personId: 'c', entryId: 'e3', ownerId: 'a', partnerId: 'c', accepted: true }],
    [P('2026-10-16T19:05'), 'table.opened', { tableId: '3', individual: false }],
    [P('2026-10-16T19:06'), 'person.joined', { personId: 'd', tableId: '3' }],
  ]);
  events.splice(23, 0, { personId: 'a', entryId: 'e3', ownerId: 'a', partnerId: 'c', sameGroup: false, v: 1, seq: 98,
    t: P('2026-10-15T23:45'), ev: 'duo.invited', boot: 'b1' });
  const meta = metaOf(events, { people: [...PEOPLE, ['d', '3']], tables: [...TABLES, ['3']] });
  const [first, second] = plan(events, meta).pieces;
  assert.ok(first.lines.some(e => e.ev === 'duo.invited'));
  assert.deepEqual(evs(second.lines.filter(e => e.ev.startsWith('duo.'))), ['duo.answered']);
  assert.deepEqual(second.carried.filter(e => e.ev === 'person.joined').map(e => e.personId), ['c'], 'c citée par sa réponse, a non');
});

test('A4 : réponse à une invitation de duo faite avant la coupure : ignorée dans les duos du morceau suivant (computeStats), elle cite quand même la personne qui répond et prolonge sa présence ; une réponse à une invitation du morceau compte, et un journal sans ligne reportée les compte toutes', () => {
  // Vendredi : d invite c et c refuse ; à 19 h, c accepte l'invitation de a, faite jeudi.
  const events = deuxNuits([
    [P('2026-10-16T18:40'), 'table.opened', { tableId: '3', individual: false }],
    [P('2026-10-16T18:41'), 'person.joined', { personId: 'd', tableId: '3' }],
    [P('2026-10-16T18:42'), 'song.requested', { personId: 'd', entryId: 'e11', title: 'Onze', mode: 'append' }],
    [P('2026-10-16T18:43'), 'duo.invited', { personId: 'd', entryId: 'e11', ownerId: 'd', partnerId: 'c', sameGroup: false }],
    [P('2026-10-16T18:44'), 'duo.answered', { personId: 'c', entryId: 'e11', ownerId: 'd', partnerId: 'c', accepted: false }],
    [P('2026-10-16T19:00'), 'duo.answered', { personId: 'c', entryId: 'e3', ownerId: 'a', partnerId: 'c', accepted: true }],
    [P('2026-10-16T19:30'), 'stage.started', { queueId: 3, entryId: 'e11', ids: ['d'], ownerId: 'd', source: 'queue', title: 'Onze' }],
    [P('2026-10-16T19:34'), 'stage.ended', { queueId: 3, playedSec: 240 }],
  ]);
  events.splice(23, 0, { personId: 'a', entryId: 'e3', ownerId: 'a', partnerId: 'c', sameGroup: false, v: 1, seq: 98,
    t: P('2026-10-15T23:45'), ev: 'duo.invited', boot: 'b1' });
  const meta = metaOf(events, { people: [...PEOPLE, ['d', '3']], tables: [...TABLES, ['3']] });
  const [, second] = plan(events, meta).pieces;
  assert.deepEqual(second.carried.filter(e => e.ev === 'person.joined').map(e => e.personId), ['c']);
  const stats = statsOfPiece(second);
  const duos = ({ invites, accepted, declined }) => ({ invites, accepted, declined });
  assert.deepEqual(duos(stats.global.duos), { invites: 1, accepted: 0, declined: 1 }, 'acceptation de jeudi ignorée, refus de vendredi compté');
  // c, citée par sa réponse de 19 h : présente jusqu'à 19 h 30 (et non 19 h 14,
  // trente minutes après son refus).
  assert.equal(singerOf(stats, 'c').leftAt, P('2026-10-16T19:30'));
  // Le journal fusionné, sans ligne reportée : les deux invitations et les deux réponses comptent.
  assert.deepEqual(duos(computeStats({ meta, events, now: events.at(-1).t }).global.duos), { invites: 2, accepted: 1, declined: 1 });
});

test('A4 : réponse à une invitation de duo faite dans le morceau mais datée d’avant elle (heure du PC reculée entre les deux écritures, ligne hors d’ordre) : comptée dans les duos du morceau, comme dans la soirée seule', () => {
  // Vendredi : d invite e à 21 h (titre et invitation écrits ensemble) ; la
  // réponse de e, écrite après, est datée de 20 h 58 (heure reculée de 2 min).
  const friday = [
    [P('2026-10-16T20:00'), 'table.opened', { tableId: '3', individual: false }],
    [P('2026-10-16T20:00') + 1, 'person.joined', { personId: 'd', tableId: '3' }],
    [P('2026-10-16T20:01'), 'table.opened', { tableId: '4', individual: false }],
    [P('2026-10-16T20:01') + 1, 'person.joined', { personId: 'e', tableId: '4' }],
    [P('2026-10-16T21:00'), 'song.requested', { personId: 'd', entryId: 'e11', title: 'Onze', mode: 'append' }],
    [P('2026-10-16T21:00') + 1, 'duo.invited', { personId: 'd', entryId: 'e11', ownerId: 'd', partnerId: 'e', sameGroup: false }],
    [P('2026-10-16T20:58'), 'duo.answered', { personId: 'e', entryId: 'e11', ownerId: 'd', partnerId: 'e', accepted: true }],
    [P('2026-10-16T21:10'), 'stage.started', { queueId: 3, entryId: 'e11', ids: ['d', 'e'], ownerId: 'd', source: 'queue', title: 'Onze' }],
    [P('2026-10-16T21:14'), 'stage.ended', { queueId: 3, playedSec: 240 }],
  ];
  const people = [['d', '3'], ['e', '4']], tables = [['3'], ['4']];
  const events = deuxNuits(friday);
  const [, second] = plan(events, metaOf(events, { people: [...PEOPLE, ...people], tables: [...TABLES, ...tables] })).pieces;
  assert.ok(second.lines.some(e => e.ev === 'duo.answered' && e.t < P('2026-10-16T21:00')), 'réponse datée d’avant l’invitation');
  const duos = ({ invites, accepted, declined }) => ({ invites, accepted, declined });
  const alone = journal([[P('2026-10-16T19:59'), 'evening.started', { rules: {} }], ...friday]);
  const expected = duos(computeStats({ meta: metaOf(alone, { people, tables }), events: alone, now: alone.at(-1).t }).global.duos);
  assert.deepEqual(expected, { invites: 1, accepted: 1, declined: 0 });
  assert.deepEqual(duos(statsOfPiece(second).global.duos), expected);
});

test('A4 : fin de titre notée après la coupure (retour de KaraFun le soir suivant) : coupure à 8 h, la fin reste au second morceau sans y créer de passage, le titre finit au plus tard à 2 h 10 dans le premier', () => {
  const events = journal([
    [P('2026-10-15T20:00'), 'evening.started', { rules: {} }],
    [P('2026-10-15T20:00') + 1, 'table.opened', { tableId: '1', individual: false }],
    [P('2026-10-15T20:01'), 'person.joined', { personId: 'a', tableId: '1' }],
    [P('2026-10-16T01:45'), 'song.requested', { personId: 'a', entryId: 'e1', mode: 'append' }],
    [P('2026-10-16T01:50'), 'stage.started', { queueId: 1, entryId: 'e1', ids: ['a'], ownerId: 'a', source: 'queue', title: 'Tard' }],
    [P('2026-10-16T02:00'), 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }],
    [P('2026-10-16T18:30'), 'table.opened', { tableId: '2', individual: false }],
    [P('2026-10-16T18:31'), 'person.joined', { personId: 'b', tableId: '2' }],
    [P('2026-10-16T19:00'), 'karaoke.phase', { phase: 'silent', blocker: 'empty' }],
    [P('2026-10-16T19:00') + 1, 'stage.ended', { queueId: 1, playedSec: 61800 }],
  ]);
  const meta = metaOf(events, { people: [['a', '1'], ['b', '2']], tables: [['1'], ['2']] });
  const result = plan(events, meta);
  assert.deepEqual(result.cuts, [C16]);
  const [first, second] = result.pieces;
  assert.ok(second.lines.some(e => e.ev === 'stage.ended'), 'fin au second morceau');
  const statsOf = piece => { const lines = pieceJournal(piece); return computeStats({ meta: piece.meta, events: lines, now: piece.end ?? lines.at(-1).t }); };
  const late = statsOf(second);
  assert.equal(late.timeline.stages.length, 0, 'aucun passage créé par la fin notée tard');
  const early = statsOf(first);
  assert.equal(early.timeline.stages.length, 1);
  assert.ok(early.timeline.stages[0].end <= P('2026-10-16T02:10'), `fin du titre ${new Date(early.timeline.stages[0].end).toISOString()}`);
  // La personne du titre n'est pas citée par la fin notée tard : rien de reporté pour elle.
  assert.deepEqual(evs(second.carried), ['evening.started', 'karaoke.phase']);
});

test('A4 : chaque ligne va dans le morceau de son heure t, pas de sa place ; une ligne datée de la coupure va au morceau qui finit ; chaque morceau garde l’ordre des seq', () => {
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'table.opened', { tableId: '3', individual: false }],
    // Écrite tard, datée de la veille : premier morceau.
    [P('2026-10-15T23:58'), 'person.seen', { personId: 'b' }],
    // Datée de la coupure tout juste : premier morceau.
    [C16, 'person.seen', { personId: 'c' }],
    [P('2026-10-16T19:01'), 'person.joined', { personId: 'd', tableId: '3' }],
  ]);
  const meta = metaOf(events, { people: [...PEOPLE, ['d', '3']], tables: [...TABLES, ['3']] });
  const [first, second] = plan(events, meta).pieces;
  const seqs = lines => lines.map(e => e.seq);
  assert.deepEqual(seqs(first.lines), [...seqs(events.slice(0, 24)), 26, 27]);
  assert.deepEqual(seqs(second.lines), [25, 28]);
  // L'ordre du journal, pas celui des heures : 26 (23 h 58) après 24 (1 h 10).
  assert.ok(first.lines.at(-2).t < first.lines.at(-3).t);
});

test('A4 : soirée en cours découpée deux fois (deux générations, la seconde coupure plus tard) : rien n’est perdu, les lignes reportées de la première restent dans son morceau', () => {
  const night2 = [
    [P('2026-10-16T19:00'), 'table.opened', { tableId: '3', individual: false }],
    [P('2026-10-16T19:01'), 'person.joined', { personId: 'd', tableId: '3' }],
    [P('2026-10-16T19:02'), 'song.requested', { personId: 'a', entryId: 'e9', mode: 'append' }],
    [P('2026-10-16T19:10'), 'stage.started', { queueId: 3, entryId: 'e9', ids: ['a'], ownerId: 'a', source: 'queue' }],
  ];
  const events = deuxNuits(night2);
  const meta = metaOf(events, { people: [...PEOPLE, ['d', '3'], ['f', '4']], tables: [...TABLES, ['3'], ['4']] });
  const gen1 = plan(events, meta, { at: P('2026-10-16T19:30') });
  const [archived, current] = gen1.pieces;
  // La soirée en cours continue : nouvelles lignes, dont un nouveau seq.
  let seq = maxSeq(events);
  const night3 = [
    [P('2026-10-17T19:00'), 'table.opened', { tableId: '4', individual: false }],
    [P('2026-10-17T19:01'), 'person.joined', { personId: 'f', tableId: '4' }],
    [P('2026-10-17T19:02'), 'song.requested', { personId: 'a', entryId: 'e10', mode: 'append' }],
    [P('2026-10-17T19:03'), 'person.bonus', { personId: 'd', level: 1 }],
    [P('2026-10-17T19:04'), 'song.requested', { personId: 'd', entryId: 'e11', mode: 'append' }],
  ].map(([t, ev, fields]) => ({ ...fields, v: 1, seq: ++seq, t, ev, boot: 'b2' }));
  const running = [...pieceJournal(current), ...night3];
  // f, inscrite le 17, entre dans la meta de la soirée en cours (journalNames).
  const currentMeta = { ...current.meta, roster: { ...current.meta.roster, f: meta.roster.f }, tables: { ...current.meta.tables, 4: meta.tables[4] } };
  const second = plan(running, currentMeta, { at: P('2026-10-17T19:30') });
  assert.equal(second.generation, 2, 'génération suivante, lue dans meta.split');
  assert.deepEqual(second.cuts, [P('2026-10-17T08:00')]);
  const [middle, last] = second.pieces;
  // Le morceau du milieu garde les lignes reportées de la première génération.
  assert.deepEqual(middle.lines.slice(0, current.carried.length), current.carried);
  assert.deepEqual(middle.carried, []);
  assert.equal(middle.closing.boot, 'split-g2-k1');
  assert.ok(middle.closing.seq > maxSeq(middle.lines));
  // a (citée les deux soirs) reportée de nouveau, d (inscrite le 16) aussi, avec la table 3.
  assert.deepEqual(last.carried.filter(e => e.ev === 'person.joined').map(e => [e.personId, e.tableId]), [['a', '1'], ['d', '3']]);
  assert.ok(last.carried.every(e => e.boot === 'split-g2-k2' && e.t === P('2026-10-17T08:00')));
  assert.deepEqual(last.meta.split, { from: ORIGIN, part: 2, generation: 2, rule: 'v1' });
  assert.deepEqual(middle.meta.split, { from: ORIGIN, part: 1, generation: 2, rule: 'v1' });
  assert.deepEqual([middle.meta.startedAt, middle.meta.endedAt, last.meta.startedAt], [C16, P('2026-10-17T08:00'), P('2026-10-17T08:00')]);
  assert.deepEqual([Object.keys(middle.meta.roster), Object.keys(last.meta.roster)], [['a', 'd'], ['a', 'd', 'f']]);
  // Rien de perdu : chaque ligne écrite, une fois, dans les trois morceaux.
  const written = [...archived.lines, ...middle.lines, ...last.lines].filter(e => e.carried !== true);
  assert.deepEqual(written.map(e => JSON.stringify(e)).sort(), [...events, ...night3].map(e => JSON.stringify(e)).sort());
});

test('A4 : soirée en cours découpée, puis heure du PC reculée sous son début (A2, « Saut d’horloge ») : les lignes écrites après ses lignes reportées, datées d’avant elles, comptent à leur heure ; recoupée, elle reporte les règles, la phase, l’effectif et les bonus que le bar a changés', () => {
  // Jeudi et vendredi coupés à 8 h (génération 1) : le morceau en cours
  // commence par ses lignes reportées, datées du vendredi à 8 h.
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'song.requested', { personId: 'a', entryId: 'e9', mode: 'append' }],
    [P('2026-10-16T19:10'), 'stage.started', { queueId: 3, entryId: 'e9', ids: ['a'], ownerId: 'a', source: 'queue' }],
  ]);
  const [, current] = plan(events, metaOf(events, { people: PEOPLE, tables: TABLES }), { at: P('2026-10-16T19:30') }).pieces;
  assert.deepEqual(evs(current.carried), ['evening.started', 'karaoke.phase', 'table.opened', 'table.headcount', 'table.bonus',
    'person.joined', 'person.bonus']);
  // Ensuite, l'heure du PC reculée à 7 h 50 : le bar change un réglage, la
  // phase de KaraFun, l'effectif et le bonus de la table 1, et le bonus de a ;
  // ces lignes suivent les lignes reportées dans le journal. Samedi, a demande
  // un titre : la soirée en cours est recoupée le samedi à 8 h (génération 2).
  const C17 = P('2026-10-17T08:00');
  const resplit = firstAt => {
    let seq = maxSeq(events);
    const later = [
      [firstAt, 'settings.changed', { setting: 'gap', from: 4, to: 6 }],
      [firstAt + 60000, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }],
      [firstAt + 120000, 'table.headcount', { tableId: '1', n: 6, by: 'staff' }],
      [firstAt + 180000, 'table.bonus', { tableId: '1', level: 0 }],
      [firstAt + 240000, 'person.bonus', { personId: 'a', level: 2 }],
      [P('2026-10-17T19:00'), 'song.requested', { personId: 'a', entryId: 'e10', mode: 'append' }],
    ].map(([t, ev, fields]) => ({ ...fields, v: 1, seq: ++seq, t, ev, boot: 'b2' }));
    return plan([...pieceJournal(current), ...later], current.meta, { at: P('2026-10-17T19:30') });
  };
  const behind = resplit(P('2026-10-16T07:50'));
  assert.deepEqual(behind.cuts, [C17]);
  const boot = 'split-g2-k2';
  assert.deepEqual(behind.pieces[1].carried, [
    carriedLine(C17, boot, -5, 'evening.started', { rules: { auto: true, gap: 6, autoPlay: true } }),
    carriedLine(C17, boot, -4, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
    carriedLine(C17, boot, -3, 'table.opened', { tableId: '1', individual: false }),
    carriedLine(C17, boot, -2, 'table.headcount', { tableId: '1', n: 6, by: 'staff' }),
    carriedLine(C17, boot, -1, 'person.joined', { personId: 'a', tableId: '1' }),
    carriedLine(C17, boot, 0, 'person.bonus', { personId: 'a', level: 2 }),
  ]);
  // Les mêmes lignes datées d'après le début du morceau reportent la même chose.
  assert.deepEqual(resplit(C16 + 60000).pieces[1].carried, behind.pieces[1].carried);
  // Les lignes datées d'avant ce début restent au morceau du milieu, par leur heure.
  assert.ok(behind.pieces[0].lines.some(e => e.ev === 'person.bonus' && e.t < C16));
});

test('A4 : computeStats d’un morceau découpé dont l’heure du PC a reculé sous son début (A2, « Saut d’horloge ») : les lignes écrites après ses lignes reportées, datées d’avant elles, comptent à leur heure, comme dans planSplit : l’état reporté ne recouvre pas les bonus que le bar a changés, et le morceau ne commence ni n’ouvre avant son début', () => {
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'song.requested', { personId: 'a', entryId: 'e9', mode: 'append' }],
    [P('2026-10-16T19:10'), 'stage.started', { queueId: 3, entryId: 'e9', ids: ['a'], ownerId: 'a', source: 'queue' }],
    [P('2026-10-16T19:14'), 'stage.ended', { queueId: 3, playedSec: 240 }],
  ]);
  const [, current] = plan(events, metaOf(events, { people: PEOPLE, tables: TABLES }), { at: P('2026-10-16T19:30') }).pieces;
  assert.deepEqual(current.carried.filter(e => e.ev.endsWith('.bonus')).map(e => [e.ev, e.level]), [['table.bonus', 2], ['person.bonus', -1]]);
  // Ensuite, heure du PC reculée : le bar met a à +2 et la table 1 à 0, puis a
  // demande un titre ; ces lignes suivent les lignes reportées dans le journal.
  const later = firstAt => {
    let seq = maxSeq(events);
    return [
      [firstAt, 'person.bonus', { personId: 'a', level: 2 }],
      [firstAt + 60000, 'table.bonus', { tableId: '1', level: 0 }],
      [firstAt + 120000, 'song.requested', { personId: 'a', entryId: 'e10', mode: 'append' }],
    ].map(([t, ev, fields]) => ({ ...fields, v: 1, seq: ++seq, t, ev, boot: 'b2' }));
  };
  const read = lines => {
    const stats = computeStats({ meta: current.meta, events: lines, now: P('2026-10-16T20:00') });
    const a = singerOf(stats, 'a');
    return { stats, state: [a.bonus, a.weight, stats.tables.map(tb => [tb.id, tb.bonus]), stats.global.staff.bonus] };
  };
  const behind = [...pieceJournal(current), ...later(P('2026-10-16T07:50'))];
  const { stats, state } = read(behind);
  // Bonus de a +2 et table 1 à 0 depuis le début du morceau ; deux gestes du bar.
  assert.deepEqual(state, [2, 1.5, [['1', 0]], 2]);
  // Les mêmes lignes datées d'après le début du morceau donnent le même état.
  assert.deepEqual(read([...pieceJournal(current), ...later(C16 + 60000)]).state, state);
  // Le titre demandé à 7 h 52 compte au début du morceau, comme une activité
  // datée d'avant meta.startedAt (A1) : ni le début ni l'ouverture du karaoké
  // ne passent avant la coupure.
  assert.equal(singerOf(stats, 'a').songs.find(song => song.entryId === 'e10').requestedAt, C16);
  assert.deepEqual([stats.evening.startedAt, stats.evening.openedAt], [C16, C16]);
  // Même lecture que planSplit : recoupé le samedi, le morceau suivant reporte
  // l'état que computeStats lit à la fin du morceau du milieu.
  const saturday = [...behind, { personId: 'a', entryId: 'e11', mode: 'append', v: 1, seq: 99, t: P('2026-10-17T19:00'), ev: 'song.requested', boot: 'b2' }];
  const [middle, last] = plan(saturday, current.meta, { at: P('2026-10-17T19:30') }).pieces;
  assert.deepEqual(last.carried.filter(e => e.ev.endsWith('.bonus')).map(e => [e.ev, e.level]), [['person.bonus', 2]]);
  const middleStats = statsOfPiece(middle);
  assert.deepEqual([singerOf(middleStats, 'a').bonus, middleStats.tables.find(tb => tb.id === '1').bonus], [2, 0]);
});

test('A4 : soirée close fusionnée (« Supprimer toutes les tables » le samedi) : le dernier morceau finit à la fin d’origine et garde sa clôture, closedBy repris de sa ligne evening.closed, meta.json sans closedBy (archives d’avant A5) compris', () => {
  const closedAt = P('2026-10-17T02:00');
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'table.opened', { tableId: '3', individual: false }],
    [P('2026-10-16T19:01'), 'person.joined', { personId: 'd', tableId: '3' }],
    [closedAt, 'evening.closed', { by: 'staff-reset' }],
  ]);
  const meta = metaOf(events, { people: [...PEOPLE, ['d', '3']], tables: [...TABLES, ['3']], endedAt: closedAt, closedBy: 'staff-reset',
    karaoke: { openedAt: P('2026-10-15T19:01'), closedAt } });
  const [first, last] = plan(events, meta).pieces;
  assert.deepEqual([last.start, last.end, last.closing], [C16, closedAt, null]);
  assert.equal(last.lines.at(-1).ev, 'evening.closed', 'clôture d’origine au dernier morceau');
  assert.deepEqual([first.meta.closedBy, last.meta.closedBy], ['auto', 'staff-reset']);
  assert.deepEqual([first.meta.endedAt, last.meta.endedAt], [C16, closedAt]);
  // karaoke, celui de toute la soirée fusionnée, n'est repris par aucun morceau :
  // l'appelant le recalcule, comme à une clôture (A5).
  assert.ok(!('karaoke' in first.meta) && !('karaoke' in last.meta));
  // Le meta.json de toutes les archives d'aujourd'hui n'a ni closedBy ni
  // karaoke (EveningJournal ne les écrit qu'à partir d'A5) : le dernier morceau
  // prend alors le by de sa ligne evening.closed, que rien dans meta ne donne.
  // (La meta de la forme d'A5, plus haut, vérifie que cette ligne passe avant
  // meta.closedBy.)
  const archived = metaOf(events, { people: [...PEOPLE, ['d', '3']], tables: [...TABLES, ['3']], endedAt: closedAt });
  assert.ok(!('closedBy' in archived) && !('karaoke' in archived));
  assert.deepEqual(plan(events, archived).pieces.map(piece => piece.meta.closedBy), ['auto', 'staff-reset']);
});

test('A4 : identifiants des morceaux : empreinte de (identifiant d’origine, k, j), stable après un arrêt ; newEveningId(début du morceau, empreinte, fuseau de meta.timezone) valide, à l’heure de Paris sous TZ=UTC', () => {
  const fingerprint = splitFingerprint(ORIGIN, 1, 1);
  assert.match(fingerprint, /^[0-9a-f]{4}$/);
  assert.equal(splitFingerprint(ORIGIN, 1, 1), fingerprint, 'même calcul, même empreinte');
  const others = [splitFingerprint(ORIGIN, 1, 2), splitFingerprint(ORIGIN, 2, 1), splitFingerprint('2026-10-16_1900_ab12', 1, 1)];
  assert.equal(new Set([fingerprint, ...others]).size, 4, 'une empreinte par (origine, k, j)');
  for (const [k, j] of [[0, 1], [1, 0], [1.5, 1], [1, '2']]) assert.throws(() => splitFingerprint(ORIGIN, k, j), RangeError);
  const events = deuxNuits([[P('2026-10-16T19:00'), 'person.joined', { personId: 'd', tableId: '1' }]]);
  const [first] = plan(events, metaOf(events, { people: PEOPLE, tables: TABLES })).pieces;
  const ids = inZone('UTC', () => [1, 2].map(j => newEveningId(first.start, splitFingerprint(ORIGIN, first.k, j), PARIS)));
  assertRestored();
  assert.deepEqual(ids, [`2026-10-15_1900_${fingerprint}`, `2026-10-15_1900_${others[0]}`]);
  assert.ok(ids.every(validEveningId));
});

test('A4 : pieceMeta finit la meta d’un dossier arrêté entre son journal et son meta.json (début à l’heure des lignes reportées, prénoms et tables filtrés, split), comme planSplit pour le dernier morceau, soirée en cours ou close (fin d’origine par défaut ; closedBy de la ligne evening.closed, meta.json sans closedBy compris)', () => {
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'table.opened', { tableId: '3', individual: false }],
    [P('2026-10-16T19:01'), 'person.joined', { personId: 'd', tableId: '3' }],
    [P('2026-10-16T19:02'), 'song.requested', { personId: 'a', entryId: 'e9', mode: 'append' }],
    [P('2026-10-16T19:03'), 'person.seen', { personId: 'b' }],
  ]);
  const meta = metaOf(events, { people: [...PEOPLE, ['d', '3']], tables: [...TABLES, ['3']] });
  const result = plan(events, meta);
  const last = result.pieces.at(-1);
  assert.deepEqual(pieceMeta({ meta, events: pieceJournal(last), split: { from: ORIGIN, part: 2, generation: 1 }, citedIds }), last.meta);
  // Le premier morceau, sans ligne reportée : toutes les personnes et tables qu'il nomme.
  const first = result.pieces[0];
  assert.deepEqual(pieceMeta({ meta, events: pieceJournal(first), start: first.start, end: first.end, eveningId: null,
    split: { from: ORIGIN, part: 1, generation: 1 }, citedIds }), first.meta);
  // Soirée close (« Supprimer toutes les tables » le samedi à 2 h) : le dossier
  // arrêté est celui d'origine, le dernier morceau, dont le meta.json est
  // encore celui d'origine ; le même appel, sans `end`, garde la fin d'origine.
  const closedAt = P('2026-10-17T02:00');
  const closedEvents = deuxNuits([
    [P('2026-10-16T19:00'), 'table.opened', { tableId: '3', individual: false }],
    [P('2026-10-16T19:01'), 'person.joined', { personId: 'd', tableId: '3' }],
    [closedAt, 'evening.closed', { by: 'staff-reset' }],
  ]);
  const closedMeta = metaOf(closedEvents, { people: [...PEOPLE, ['d', '3']], tables: [...TABLES, ['3']], endedAt: closedAt,
    closedBy: 'staff-reset' });
  const closedLast = plan(closedEvents, closedMeta).pieces.at(-1);
  assert.deepEqual([closedLast.meta.endedAt, closedLast.meta.closedBy], [closedAt, 'staff-reset']);
  assert.deepEqual(pieceMeta({ meta: closedMeta, events: pieceJournal(closedLast), split: { from: ORIGIN, part: 2, generation: 1 },
    citedIds }), closedLast.meta);
  // Le même dossier pour une archive d'aujourd'hui, dont le meta.json d'origine
  // n'a pas de closedBy (écrit à partir d'A5) : closedBy vient de la ligne
  // evening.closed du journal.
  const archivedMeta = metaOf(closedEvents, { people: [...PEOPLE, ['d', '3']], tables: [...TABLES, ['3']], endedAt: closedAt });
  const archivedLast = plan(closedEvents, archivedMeta).pieces.at(-1);
  const finished = pieceMeta({ meta: archivedMeta, events: pieceJournal(archivedLast), split: { from: ORIGIN, part: 2, generation: 1 },
    citedIds });
  assert.deepEqual([archivedLast.meta.closedBy, finished.closedBy], ['staff-reset', 'staff-reset']);
  assert.deepEqual(finished, archivedLast.meta);
  // Un `end` donné l'emporte, null compris (planSplit donne toujours le sien).
  assert.equal(pieceMeta({ meta: closedMeta, events: pieceJournal(closedLast), end: null, citedIds }).endedAt, null);
  assert.equal(pieceMeta({ meta: closedMeta, events: pieceJournal(closedLast), end: C16, citedIds }).endedAt, C16);
});

test('A4 : planSplit est pur : rien de modifié dans meta ni dans les lignes, même résultat deux fois, module sans dépendance', () => {
  const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) freeze(v); }
    return value;
  };
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'song.requested', { personId: 'a', entryId: 'e9', mode: 'append' }],
    [P('2026-10-16T19:01'), 'person.joined', { personId: 'd', tableId: '2' }],
  ]);
  const meta = metaOf(events, { people: [...PEOPLE, ['d', '2']], tables: TABLES });
  const before = JSON.stringify({ meta, events });
  freeze(meta); freeze(events);
  const once = plan(events, meta, { at: 1 });
  assert.deepEqual(plan(events, meta, { at: 1 }), once);
  assert.equal(JSON.stringify({ meta, events }), before);
  // Sans dépendance : chargé là où tout require lève, il découpe de même.
  const source = fs.readFileSync(path.join(__dirname, '..', 'evening-split.js'), 'utf8');
  const sandbox = { module: { exports: {} }, require: name => { throw new Error(`dépendance inattendue : ${name}`); } };
  vm.runInNewContext(`(function (module, exports, require) {\n${source}\n})(module, module.exports, require);`, sandbox,
    { filename: 'evening-split.js' });
  const alone = sandbox.module.exports.planSplit({ meta, events, cuts: once.cuts, citedIds, at: 1 });
  assert.equal(JSON.stringify(alone), JSON.stringify(once));
});

test('A4 : entrées mal formées : coupures en désordre, en double ou non numériques, meta sans roster ni tables, lignes nulles ou sans heure : aucune exception', () => {
  // Trois soirées (jeudi, vendredi, samedi), coupées le vendredi et le samedi à 8 h.
  const C17 = P('2026-10-17T08:00');
  const events = deuxNuits([
    [P('2026-10-16T19:00'), 'person.joined', { personId: 'd', tableId: '1' }],
    [P('2026-10-17T19:00'), 'person.joined', { personId: 'f', tableId: '2' }],
  ]);
  const meta = metaOf(events, { people: [...PEOPLE, ['d', '1'], ['f', '2']], tables: TABLES });
  assert.deepEqual(cutsOf(events, meta), [C16, C17]);
  const reference = planSplit({ meta, events, cuts: [C16, C17], citedIds });
  // Trois morceaux, aucun vide, chaque ligne dans celui de son heure.
  assert.deepEqual(reference.pieces.map(piece => piece.lines.length > 0
    && piece.lines.every(e => [C16, C17].filter(c => c < e.t).length + 1 === piece.k)), [true, true, true]);
  // Les mêmes coupures en désordre, en double et parmi des valeurs qui n'en sont pas.
  const messy = planSplit({ meta, events, cuts: [C17, 'x', C16, NaN, null, C17], citedIds });
  assert.deepEqual(messy, reference);
  const bare = planSplit({ meta: { roster: 'Léa', tables: [1] }, events: [null, 7, ...events, { ev: 'person.seen' }], cuts: [C16], citedIds });
  assert.equal(bare.pieces.length, 2);
  assert.deepEqual(bare.pieces[0].meta.roster, {});
  assert.deepEqual(bare.pieces.flatMap(piece => piece.lines).length, events.length + 3);
  assert.deepEqual(planSplit({ meta: null, events: null, cuts: null, citedIds }).pieces.map(piece => piece.lines), [[]]);
  assert.throws(() => planSplit({ meta, events, cuts: [C16], citedIds, generation: 0 }), RangeError);
});

test('A4 : heure d’une ligne hors des dates possibles (±1e16, au-delà de ±8,64e15 ms, que Date refuse), sans meta.startedAt : lue comme absente, comme dans evening-bounds.js ; la ligne reste avec celle qui la précède, et le premier morceau commence à la plus ancienne heure valide', () => {
  for (const bad of [-1e16, 1e16]) {
    const events = deuxNuits([[P('2026-10-16T19:00'), 'person.joined', { personId: 'd', tableId: '1' }]]);
    const joined = events.findIndex(e => e.ev === 'person.joined');
    const odd = { personId: 'a', v: 1, seq: 99, t: bad, ev: 'person.seen', boot: 'b1' };
    const lines = [...events.slice(0, joined + 1), odd, ...events.slice(joined + 1)];
    const meta = { ...metaOf(events, { people: [...PEOPLE, ['d', '1']], tables: TABLES }), startedAt: null };
    const result = planSplit({ meta, events: lines, cuts: cutsOf(lines, meta), citedIds });
    assert.deepEqual(result.cuts, [C16], String(bad));
    assert.equal(result.pieces[0].start, events[0].t, `${bad} : début à la plus ancienne heure valide`);
    const first = result.pieces[0].lines;
    assert.equal(first[first.indexOf(odd) - 1], events[joined], `${bad} : avec la ligne qui la précède`);
    assert.ok(!result.pieces[1].lines.includes(odd), `${bad} : pas au second morceau`);
  }
});

test('A4 : journal de 60 nuits (47 760 lignes) : 59 coupures, 60 morceaux, aucune ligne perdue, planSplit en moins de 2 s', () => {
  const { events, meta } = tires.recopierFixture({ fois: 60 });
  assert.equal(events.length, 47760);
  const cuts = cutsOf(events, meta);
  assert.equal(cuts.length, 59);
  const t0 = performance.now();
  const result = planSplit({ meta, events, cuts, citedIds, at: events.at(-1).t });
  const ms = performance.now() - t0;
  console.log(`A4 : 60 nuits (${events.length} lignes) : planSplit en ${ms.toFixed(1)} ms.`);
  assert.equal(result.pieces.length, 60);
  assert.equal(result.pieces.reduce((n, piece) => n + piece.lines.length, 0), events.length);
  assert.ok(result.pieces.slice(1).every(piece => evs(piece.carried).join() === 'evening.started,karaoke.phase'));
  // gstack-timing-ok: repère de 2 s pour planSplit sur 60 nuits (mesuré vers 130 ms), quinze fois la mesure : garde contre un calcul qui relirait le journal à chaque ligne, sans dépendre d'une CI lente.
  assert.ok(ms < 2000, `planSplit : ${ms.toFixed(1)} ms, au-delà de 2 s`);
});

// ------------------------------------------- A7 : propriétés à graine fixe
// 200 journaux tirés (test/journaux-tires.js), dont 50 avec des champs de
// mauvais type. Chaque échec nomme la graine et le journal, et, pour une
// exception, la fonction qui a levé et la ligne du code ; pour citedIds, la
// ligne du journal.
const GRAINE = 20261108;
const DRAWN_AT = performance.now();
const JOURNAUX = tires.tirerJournaux({ graine: GRAINE, nombre: 200, malformes: 50 });
const DRAWN_MS = performance.now() - DRAWN_AT;
// Durée d'un essai lourd, écrite dans sa sortie (« Vérifications rapides »).
const timed = (label, run) => {
  const t0 = performance.now();
  const detail = run();
  console.log(`${label} : ${(performance.now() - t0).toFixed(0)} ms${detail ? ` (${detail})` : ''}.`);
};
const nomDe = j => `graine ${GRAINE}, journal ${j.numero}${j.malforme ? ' (champs de mauvais type)' : ''}`;
function essayer(j, fonction, run, ligne = null) {
  try { return run(); } catch (error) {
    const frame = String(error?.stack || '').split('\n').find(l => /^\s+at /.test(l))?.trim() || 'pile absente';
    const where = ligne ? `, ligne ${ligne.index + 1} du journal : ${JSON.stringify(ligne.event).slice(0, 200)}` : '';
    assert.fail(`${nomDe(j)} : ${fonction} a levé ${error?.name} : ${error?.message} (${frame})${where}`);
  }
}
// Analyse d'un journal tiré, avec `cited` pour les personnes citées
// (citedIds, ou, dans l'essai des messages, une copie qui lève). citedIds
// passe d'abord sur chaque ligne, avant planSplit qui l'appelle : son échec
// nomme ainsi la ligne du journal.
function analyser(j, cited = citedIds) {
  const events = parseLines(j.texte).events;
  const ids = events.map((event, index) => essayer(j, 'citedIds', () => cited(event), { index, event }));
  const breaks = essayer(j, 'eveningBreaks', () => eveningBreaks({ events, timeZone: j.timeZone, startedAt: j.meta.startedAt }));
  const result = essayer(j, 'planSplit', () => planSplit({ meta: j.meta, events, cuts: breaks.cuts, citedIds: cited, at: 1 }));
  return { events, ids, breaks, result };
}
const analyses = new Map();
function analyse(j) {
  if (!analyses.has(j)) analyses.set(j, analyser(j));
  return analyses.get(j);
}

// Lecture des champs par la même règle (A7) : un booléen n'est vrai que s'il
// vaut true. Activité et débuts de titre, comme A1 les définit.
const isTrue = value => value === true;
const activity = e => ['stage.started', 'song.requested', 'person.joined', 'table.opened'].includes(e.ev) && Number.isFinite(e.t)
  && !isTrue(e.carried) && !(e.ev === 'table.opened' && isTrue(e.individual));
const titleStart = e => ['stage.started', 'stage.restarted'].includes(e.ev) && Number.isFinite(e.t) && !isTrue(e.carried);
// Coupures par une recherche naïve : à partir du premier 8 h qui suit la
// première activité, les instants M et « début d'un titre + 60 min », pris
// dans l'ordre ; le premier sans titre commencé dans l'heure qui le précède.
function naiveCuts(events, timeZone, startedAt) {
  const starts = events.filter(titleStart).map(e => e.t);
  const acts = events.filter(activity).map(e => e.t);
  const calm = x => !starts.some(s => s > x - QUIET_MS && s <= x);
  const out = [];
  let first = Math.min(...acts);
  let firstCut = null;
  while (Number.isFinite(first)) {
    let M = morningAfter(first, timeZone);
    if (!out.length) M = Math.max(M, startedAt);
    const at = [M, ...starts.map(s => s + QUIET_MS).filter(x => x > M)].sort((a, b) => a - b).find(calm);
    firstCut ??= at;
    const next = acts.filter(a => a > at);
    if (!next.length) break;
    out.push(at);
    first = Math.min(...next);
  }
  return { cuts: out, first: firstCut };
}

test('A7 : propriétés (200 journaux tirés) : chaque ligne lisible dans un seul morceau, ligne entière comparée ; ordre des seq gardé ; aucun morceau recoupé', () => timed('A7 : 200 journaux tirés, morceaux', () => {
  let pieces = 0;
  for (const j of JOURNAUX) {
    const { events, breaks, result } = analyse(j);
    assert.equal(result.pieces.length, breaks.cuts.length + 1, nomDe(j));
    const remaining = new Map();
    for (const e of events) { const text = JSON.stringify(e); remaining.set(text, (remaining.get(text) || 0) + 1); }
    for (const piece of result.pieces) {
      pieces++;
      // Ordre du journal : chaque morceau en est une sous-suite.
      let at = 0;
      for (const e of piece.lines) {
        const index = events.indexOf(e, at);
        assert.ok(index >= 0, `${nomDe(j)} : morceau ${piece.k}, ordre du journal perdu (seq ${e.seq})`);
        at = index + 1;
        const text = JSON.stringify(e);
        assert.ok(remaining.get(text) > 0, `${nomDe(j)} : ligne en trop dans le morceau ${piece.k} : ${text.slice(0, 160)}`);
        remaining.set(text, remaining.get(text) - 1);
        const k = breaks.cuts.filter(c => c < e.t).length + 1;
        assert.equal(k, piece.k, `${nomDe(j)} : ligne de seq ${e.seq} rangée au morceau ${piece.k} au lieu de ${k}`);
      }
      // Rejouée, la réparation ne recoupe pas un morceau.
      const lines = pieceJournal(piece);
      const again = essayer(j, `eveningBreaks (morceau ${piece.k})`, () => eveningBreaks({ events: lines, timeZone: j.timeZone,
        startedAt: piece.meta.startedAt, split: piece.meta.split }));
      assert.deepEqual(again.cuts, [], `${nomDe(j)} : morceau ${piece.k} recoupé`);
      const replanned = essayer(j, `planSplit (morceau ${piece.k})`, () => planSplit({ meta: piece.meta, events: lines, cuts: again.cuts, citedIds }));
      assert.equal(replanned.pieces.length, 1, `${nomDe(j)} : morceau ${piece.k}`);
      assert.deepEqual(replanned.pieces[0].lines, lines, `${nomDe(j)} : planSplit du morceau ${piece.k} ne le rend pas tel quel`);
    }
    const lost = [...remaining].filter(([, n]) => n !== 0);
    assert.deepEqual(lost, [], `${nomDe(j)} : lignes perdues`);
  }
  assert.ok(pieces > JOURNAUX.length, `morceaux : ${pieces}`);
  const lines = JOURNAUX.reduce((n, j) => n + analyse(j).events.length, 0);
  return `${lines} lignes lisibles, ${pieces} morceaux ; journaux tirés en ${DRAWN_MS.toFixed(0)} ms`;
}));

test('A7 : propriétés : chaque coupure est le premier instant calme à partir de son M, comme une recherche naïve', () => timed('A7 : 200 journaux tirés, coupures', () => {
  const counts = [0, 0, 0, 0, 0];
  for (const j of JOURNAUX) {
    const { events, breaks } = analyse(j);
    const naive = naiveCuts(events, j.timeZone, j.meta.startedAt);
    assert.deepEqual(breaks.cuts, naive.cuts, `${nomDe(j)} : coupures`);
    counts[Math.min(breaks.cuts.length, 4)]++;
  }
  // Le tirage couvre des journaux d'une à quatre nuits, coupés de zéro à trois fois.
  assert.ok(counts[0] > 0 && counts[1] > 0 && counts[2] > 0 && counts[3] > 0, `coupures par journal : ${counts}`);
  return `journaux de 0 à 3 coupures : ${counts.slice(0, 4).join(', ')}`;
}));

test('A7 : propriétés : eveningOver en direct, sur le début du journal jusqu’à chaque ligne, rend null avant le premier C, puis ce C, la première coupure d’eveningBreaks', () => timed('A7 : 200 journaux tirés, eveningOver à chaque ligne', () => {
  for (const j of JOURNAUX) {
    const { events, breaks } = analyse(j);
    const { first } = naiveCuts(events, j.timeZone, j.meta.startedAt);
    if (breaks.cuts.length) assert.equal(first, breaks.cuts[0], `${nomDe(j)} : premier C`);
    let now = -Infinity;
    const prefix = [];
    for (let i = 0; i < events.length; i++) {
      now = Math.max(now, events[i].t);
      prefix.push(events[i]);
      const over = essayer(j, 'eveningOver', () => eveningOver({ events: prefix, now, timeZone: j.timeZone, startedAt: j.meta.startedAt }),
        { index: i, event: events[i] });
      const expected = first != null && now >= first ? first : null;
      assert.equal(over?.at ?? null, expected, `${nomDe(j)} : eveningOver à la ligne ${i + 1}`);
    }
  }
}));

test('A7 : propriétés : champs de mauvais type compris, eveningOver, eveningBreaks, planSplit, citedIds (chaque ligne) et computeStats (chaque morceau) ne lèvent jamais ; citedIds ne rend que des chaînes non vides', () => timed('A7 : 200 journaux tirés, exceptions', () => {
  // lastSignsOf (A2, second commit) rejoindra cette liste.
  let malformed = 0;
  for (const j of JOURNAUX) {
    const { events, ids, result } = analyse(j);
    if (j.malforme) malformed++;
    // citedIds a passé sur chaque ligne dans analyse, avant planSplit.
    ids.forEach((list, index) => {
      assert.ok(Array.isArray(list) && list.every(id => typeof id === 'string' && id !== ''), `${nomDe(j)} : citedIds, ligne ${index + 1}`);
    });
    essayer(j, 'eveningOver', () => eveningOver({ events, now: events.at(-1)?.t ?? 0, timeZone: j.timeZone, startedAt: j.meta.startedAt }));
    for (const piece of result.pieces) {
      const lines = pieceJournal(piece);
      const stats = essayer(j, `computeStats (morceau ${piece.k})`, () => computeStats({ meta: piece.meta, events: lines,
        now: piece.end ?? lines.at(-1)?.t ?? 0 }));
      assert.equal(typeof stats.global, 'object', `${nomDe(j)} : computeStats (morceau ${piece.k}) sans stats.global`);
    }
  }
  assert.equal(malformed, 50);
  return '50 journaux avec des champs de mauvais type';
}));

test('A7 : propriétés : une exception de citedIds nomme la graine, le journal, citedIds et la ligne du journal, pas planSplit qui l’appelle', () => {
  // Un journal coupé ; une copie de citedIds lève sur une ligne de son second
  // morceau, que planSplit lui passe aussi.
  const j = JOURNAUX.find(candidate => analyse(candidate).result.pieces.length > 1);
  const { events, breaks } = analyse(j);
  const index = events.findIndex(e => e.t > breaks.cuts[0]);
  const text = JSON.stringify(events[index]);
  const cited = e => { if (JSON.stringify(e) === text) throw new RangeError('essai'); return citedIds(e); };
  assert.throws(() => analyser(j, cited), error => {
    assert.ok(error.message.startsWith(`${nomDe(j)} : citedIds a levé RangeError : essai (at `), error.message);
    assert.ok(error.message.endsWith(`, ligne ${index + 1} du journal : ${text.slice(0, 200)}`), error.message);
    return true;
  });
});
