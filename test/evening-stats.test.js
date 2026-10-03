'use strict';
// Statistiques de soirée (evening-stats.js) sur un journal synthétique dont
// les réponses sont connues : présences au prorata, attentes, équité (indice
// de Jain), temps morts et leurs causes, duos, Battles, export pseudonymisé.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStats, insights, exportEvening, jain, median, duration, CAUSES } = require('../evening-stats');

const T0 = Date.UTC(2026, 9, 3, 18, 0);
const M = 60000;
const at = minutes => T0 + minutes * M;

// Soirée de 3 h : A et B (table 1), C et D (table 2). C part à 120 min.
function fixture() {
  const events = [];
  let seq = 0;
  const e = (minutes, ev, fields = {}) => events.push({ v: 1, seq: ++seq, t: at(minutes), ev, boot: 'b1', ...fields });
  e(0, 'evening.started', { rules: {} });
  e(0, 'app.started', { restored: false, offlineMs: 0 });
  e(0, 'table.opened', { tableId: '1', individual: false });
  e(0, 'table.opened', { tableId: '2', individual: false });
  for (const [pid, tableId] of [['pA', '1'], ['pB', '1'], ['pC', '2'], ['pD', '2']]) e(0, 'person.joined', { personId: pid, tableId });
  e(0, 'person.bonus', { personId: 'pB', level: 2 });
  e(0, 'song.requested', { personId: 'pA', entryId: 'e1', title: 'Un', artist: 'X', mode: 'replace' });
  e(5, 'song.requested', { personId: 'pB', entryId: 'e2', title: 'Deux', mode: 'replace' });
  e(10, 'song.requested', { personId: 'pC', entryId: 'e3', title: 'Trois', mode: 'replace' });
  e(10, 'song.requested', { personId: 'pD', entryId: 'e5', title: 'Cinq', mode: 'replace' });
  e(10, 'stage.started', { queueId: 1, entryId: 'e1', ids: ['pA'], ownerId: 'pA', source: 'queue', title: 'Un' });
  e(12, 'song.requested', { personId: 'pA', entryId: 'e4', title: 'Quatre', mode: 'append' });
  e(14, 'stage.ended', { queueId: 1, playedSec: 240 });
  e(14, 'karaoke.phase', { phase: 'between', blocker: 'awaiting-presence' });
  e(15, 'stage.started', { queueId: 2, entryId: 'e2', ids: ['pB'], source: 'queue' });
  e(15, 'karaoke.phase', { phase: 'singing', blocker: null });
  e(19, 'stage.ended', { queueId: 2, playedSec: 240 });
  e(19, 'karaoke.phase', { phase: 'silent', blocker: 'empty' });
  e(20, 'defer.requested', { ownerId: 'pC', personIds: ['pC'], entryId: 'e3', songs: 1 });
  e(25, 'defer.ended', { ownerId: 'pC', entryId: 'e3', how: 'ready' });
  e(30, 'presence.asked', { personIds: ['pC'], entryId: 'e3' });
  e(30.5, 'presence.confirmed', { personId: 'pC' });
  // Titre hors file, mis en pause puis repris : un seul passage.
  e(30, 'stage.started', { queueId: 'n1', source: 'native', title: 'Hors file' });
  e(30, 'karaoke.phase', { phase: 'singing', blocker: null });
  e(31, 'stage.ended', { queueId: 'n1', playedSec: 60 });
  e(31.2, 'stage.started', { queueId: 'n1', source: 'native', title: 'Hors file' });
  e(34, 'stage.ended', { queueId: 'n1', playedSec: 168 });
  e(34, 'stage.started', { queueId: 3, entryId: 'e3', ids: ['pC'], source: 'queue' });
  e(38, 'stage.ended', { queueId: 3, playedSec: 240 });
  e(38, 'karaoke.phase', { phase: 'between', blocker: 'autoplay-held' });
  e(40, 'stage.started', { queueId: 4, entryId: 'e4', ids: ['pA'], source: 'queue' });
  e(40, 'karaoke.phase', { phase: 'singing', blocker: null });
  e(41, 'duo.improvised', { entryId: 'e4', ownerId: 'pA', partnerId: 'pB' });
  e(44, 'stage.ended', { queueId: 4, playedSec: 240 });
  e(44, 'karaoke.phase', { phase: 'silent', blocker: 'empty' });
  // Envoi retiré de KaraFun puis renvoyé : seul le passage sur scène compte.
  e(45, 'turn.sent', { entryId: 'e5', ids: ['pD'], queueId: 5 });
  e(46, 'turn.unsent', { entryId: 'e5', reason: 'pulled-defer' });
  e(50, 'battle.proposed', { ballotId: 'b1', proposerId: 'pB', eligible: 4, threshold: 3 });
  e(50, 'battle.vote', { ballotId: 'b1', voterId: 'pB', choice: 'song:1' });
  e(51, 'battle.vote', { ballotId: 'b1', voterId: 'pC', choice: 'none' });
  e(53, 'battle.decided', { ballotId: 'b1', outcome: 'quorum', voters: 2, yes: 1 });
  e(55, 'app.started', { restored: true, offlineMs: 5 * M });
  e(58, 'turn.sent', { entryId: 'e5', ids: ['pD'], queueId: 6 });
  e(60, 'stage.started', { queueId: 6, entryId: 'e5', ids: ['pD'], source: 'queue' });
  e(61, 'stage.restarted', { queueId: 7 });
  e(64, 'stage.ended', { queueId: 7, playedSec: 180 });
  e(64, 'queue.sample', { ready: 0, songsListed: 0, present: 3, demanding: 0 });
  e(120, 'person.left', { personId: 'pC', by: 'self', songsDropped: 0 });
  e(180, 'evening.closed', { by: 'staff-reset', unsungSongs: 0 });
  const meta = { eveningId: '2026-10-03_2000_abcd', startedAt: at(0), endedAt: at(180), timezone: 'Europe/Paris',
    roster: { pA: { name: 'Alice', tableId: '1' }, pB: { name: 'Bruno', tableId: '1' }, pC: { name: 'Chloé', tableId: '2' }, pD: { name: 'Dina', tableId: '2' } },
    tables: { 1: { name: 'Table 1', individual: false }, 2: { name: 'Terrasse de Julie', individual: false } } };
  return { meta, events };
}

const byId = (stats, id) => stats.singers.find(s => s.id === id);
const close = (actual, expected, eps = 0.01) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≈ ${expected}`);

test('présence : départ signalé, sinon dernier signe + 30 min ; arrêt de l’application retiré', () => {
  const { meta, events } = fixture();
  const stats = computeStats({ meta, events });
  // A : dernier signe à 40 min (sur scène) → 70 min, moins 5 min d'arrêt.
  assert.equal(byId(stats, 'pA').presenceSec, 65 * 60);
  assert.equal(byId(stats, 'pA').leftEstimated, true);
  assert.equal(byId(stats, 'pB').presenceSec, 75 * 60, 'proposition Battle à 50 min');
  assert.equal(byId(stats, 'pC').presenceSec, 115 * 60, 'départ signalé à 120 min');
  assert.equal(byId(stats, 'pC').explicitLeft, true);
  assert.equal(byId(stats, 'pD').presenceSec, 85 * 60);
  assert.equal(stats.evening.offlineSec, 300);
  assert.equal(stats.evening.restarts, 1);
  assert.equal(stats.evening.durationSec, 180 * 60);
  assert.equal(stats.evening.closedBy, 'staff-reset');
});

test('passages : sur scène seulement (envoi retiré, pause et relance ne comptent pas), duo noté par le bar', () => {
  const { meta, events } = fixture();
  const stats = computeStats({ meta, events });
  assert.equal(stats.global.songs, 6);
  assert.equal(stats.global.ours, 5);
  assert.equal(stats.global.native, 1);
  const native = stats.timeline.stages.find(s => s.source === 'native');
  assert.equal(native.start, at(30));
  assert.equal(native.end, at(34));
  const restarted = stats.timeline.stages.find(s => s.entryId === 'e5');
  assert.equal(restarted.start, at(60));
  assert.equal(restarted.queueId, '7');
  assert.equal(restarted.end, at(64));
  const a = byId(stats, 'pA'), b = byId(stats, 'pB');
  assert.equal(a.turns, 2);
  assert.equal(a.duosOwner, 1);
  assert.equal(b.turns, 1);
  assert.equal(b.guestTurns, 1);
  assert.equal(b.improvisedGuest, 1);
  assert.equal(b.appearances, 2);
  close(a.turnsPerHour, 2 / (65 / 60));
  close(b.turnsPerHour, 1 / (75 / 60));
  assert.equal(stats.global.duoStages, 1);
  assert.equal(stats.global.duoRate, 0.2);
  assert.equal(stats.global.crossTableDuos, 0);
  assert.equal(stats.global.duos.improvisedStages, 1);
  assert.equal(stats.global.unsent['pulled-defer'], 1);
});

test('attentes : depuis la demande ou la fin du passage précédent, report « Pas prêt » retiré du net', () => {
  const { meta, events } = fixture();
  const stats = computeStats({ meta, events });
  const wait = id => stats.timeline.stages.find(s => s.entryId === id).waitSec / 60;
  assert.equal(wait('e1'), 10);
  assert.equal(wait('e2'), 10);
  assert.equal(wait('e3'), 24);
  assert.equal(wait('e4'), 26, 'prêt à la fin de son passage précédent (14 min), pas à sa demande (12 min)');
  assert.equal(stats.timeline.stages.find(s => s.entryId === 'e4').requestDelaySec, 28 * 60);
  assert.equal(wait('e5'), 50);
  const e3 = stats.timeline.stages.find(s => s.entryId === 'e3');
  assert.equal(e3.deferSec, 300);
  assert.equal(stats.global.waitAvgSec, 24 * 60);
  assert.equal(stats.global.waitMedianSec, 24 * 60);
  assert.equal(stats.global.netWaitAvgSec, 23 * 60);
  assert.deepEqual(stats.global.longestWait, { sec: 50 * 60, personId: 'pD', title: 'Cinq', at: at(60) });
  assert.deepEqual(stats.global.waitHistogram.map(b => b.count), [0, 2, 2, 0, 1, 0, 0]);
  assert.equal(byId(stats, 'pA').waits.avgSec, 18 * 60);
  assert.equal(byId(stats, 'pA').waits.maxSec, 26 * 60);
  assert.equal(byId(stats, 'pA').firstTurnSec, 600);
  assert.equal(stats.global.firstTurnAvgSec, (600 + 600 + 1440 + 3000) / 4);
  const table2 = stats.tables.find(tb => tb.id === '2');
  assert.equal(table2.waits.avgSec, 37 * 60);
  assert.equal(table2.turns, 2);
  close(table2.turnsPerSingerHour, 2 / ((115 + 85) / 60));
});

test('équité : indice de Jain sur les passages par heure de présence, brut et corrigé des bonus ; part attendue', () => {
  const { meta, events } = fixture();
  const stats = computeStats({ meta, events });
  const rates = [2 / (65 / 60), 1 / (75 / 60), 1 / (115 / 60), 1 / (85 / 60)];
  const expectedJain = rates.reduce((a, b) => a + b) ** 2 / (4 * rates.reduce((a, b) => a + b * b, 0));
  close(stats.fairness.jain, expectedJain, 0.001);
  close(stats.fairness.jain, 0.78, 0.01);
  const adjusted = [rates[0], rates[1] / 1.5, rates[2], rates[3]];
  close(stats.fairness.jainAdjusted, jain(adjusted), 0.001);
  assert.equal(stats.fairness.bonusPeople, 1);
  assert.equal(stats.fairness.n, 4);
  // Part attendue : 5 passages pour (65 + 1,5 × 75 + 115 + 85) min pondérées.
  const fairRate = 5 / ((65 + 1.5 * 75 + 115 + 85) / 60);
  close(stats.fairness.fairRate, fairRate);
  close(byId(stats, 'pB').fairRate, fairRate * 1.5);
  close(byId(stats, 'pA').expectedTurns, fairRate * 65 / 60);
  close(byId(stats, 'pA').fairRatio, 2 / (fairRate * 65 / 60));
  // Temps avec un titre en attente : B (10 min) sous le seuil de 15 min.
  assert.equal(byId(stats, 'pA').demandSec, 38 * 60);
  assert.equal(stats.fairness.demandN, 3);
  close(stats.fairness.rateSpread, rates[0] / rates[2]);
  assert.equal(stats.fairness.neverSang, 0);
  assert.equal(jain([]), null);
  assert.equal(jain([0, 0]), null);
  assert.equal(jain([2, 2, 2]), 1);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
});

test('temps morts : causes dominantes, file vide et arrêt exclus du temps mort', () => {
  const { meta, events } = fixture();
  const stats = computeStats({ meta, events });
  const g = stats.global;
  assert.equal(g.deadGapCount, 2);
  assert.equal(g.deadSec, 180);
  assert.equal(g.deadAvgSec, 90);
  assert.deepEqual(g.deadCauses.map(c => [c.cause, c.sec]), [['autoplay-held', 120], ['awaiting-presence', 60]]);
  assert.equal(g.deadCauses[0].label, CAUSES['autoplay-held']);
  const pause = stats.timeline.gaps.find(gap => gap.start === at(44));
  assert.equal(pause.cause, 'empty');
  assert.equal(pause.byCause.offline, 300);
  assert.equal(pause.dead, false);
  assert.equal(g.playedSec, 240 * 6);
  close(g.deadShare, 180 / (1440 + 180), 0.001);
  close(g.songsPerHour, 6 / (49 / 60), 0.05);
  assert.equal(g.avgSongSec, 240);
  assert.equal(g.idleSec, 11 * 60 + 16 * 60);
});

test('Battles, présence, reports et repères automatiques', () => {
  const { meta, events } = fixture();
  const stats = computeStats({ meta, events });
  const g = stats.global;
  assert.equal(g.battle.proposals, 1);
  assert.equal(g.battle.votes, 2);
  assert.deepEqual(g.battle.outcomes, { quorum: 1 });
  assert.equal(g.battle.avgVoters, 2);
  assert.equal(g.battle.quorumRate, 1);
  assert.equal(byId(stats, 'pB').battleProposals, 1);
  assert.equal(g.presence.asks, 1);
  assert.equal(g.presence.medianSec, 30);
  assert.deepEqual(g.deferrals, { count: 1, songs: 1, sec: 300, people: 1 });
  const names = { pA: 'Alice', pB: 'Bruno', pC: 'Chloé', pD: 'Dina' };
  const list = insights(stats, { nameOf: id => names[id], tableName: id => meta.tables[id].name });
  const text = list.map(i => i.text).join('\n');
  assert.match(text, /Terrasse de Julie a attendu 1,5× plus que la moyenne \(37 min contre 24 min\)\./);
  assert.match(text, new RegExp(`Temps mort moyen entre deux chansons : ${duration(90)}, surtout dû à « Lecture suspendue après Spotify » \\(67 %\\)\\.`));
  assert.match(text, /Rotation inégale \(indice 0,78\) : Alice a chanté 1,9 fois par heure, Chloé 0,5\. Corrigé des bonus : 0,73\./);
  assert.match(text, /Plus longue attente : 50 min \(Dina, « Cinq »\)\./);
  assert.match(text, /« Je suis là » : 1 confirmation, réponse médiane en 30 s\./);
  assert.match(text, /Battles : 0 lancée, 1 vote proposé \(0 accepté, 1 sans assez de votants\)\./);
  assert.match(text, /1 duo sur 5 passages \(20 %\), dont 1 noté par le bar\./);
  assert.match(text, /L’application a redémarré 1 fois \(5 min d’arrêt\)\./);
  assert.match(text, /Heure la plus chargée/);
  assert.equal(duration(null), '—');
  assert.equal(duration(5400), '1 h 30');
});

test('soirée en cours : le dernier passage dure jusqu’à maintenant, journal vide sans erreur', () => {
  const { meta, events } = fixture();
  const live = events.filter(e => e.t <= at(62) && e.ev !== 'evening.closed');
  const stats = computeStats({ meta: { ...meta, endedAt: null }, events: live, now: at(63), live: true });
  const last = stats.timeline.stages.at(-1);
  assert.equal(last.ongoing, true);
  assert.equal(last.end, at(63));
  assert.equal(stats.evening.endedAt, null);
  assert.equal(stats.evening.live, true);
  const empty = computeStats({ meta: {}, events: [], now: at(1) });
  assert.equal(empty.global.songs, 0);
  assert.equal(empty.global.waitAvgSec, null);
  assert.equal(empty.fairness.jain, null);
  assert.deepEqual(insights(empty), []);
  assert.deepEqual(empty.quality.missing, ['queue.sample']);
  // Lignes en double après un arrêt brutal : ignorées.
  const doubled = computeStats({ meta, events: [...events, ...events.slice(10, 20)] });
  assert.equal(doubled.global.songs, 6);
});

test('événements des autres écrans : départ d’un duo, demande expirée, avis et duo improvisé changé', () => {
  const T = m => at(m);
  const events = [
    { t: T(0), seq: 1, ev: 'table.opened', tableId: 'Comptoir', individual: true },
    { t: T(0), seq: 2, ev: 'person.joined', personId: 'p1', tableId: 'Comptoir' },
    { t: T(0), seq: 3, ev: 'person.joined', personId: 'p2', tableId: '3' },
    { t: T(0), seq: 4, ev: 'person.joined', personId: 'p3', tableId: '3' },
    { t: T(1), seq: 5, ev: 'song.requested', personId: 'p1', entryId: 'x1', title: 'Duo', replacedEntryIds: [] },
    { t: T(1), seq: 6, ev: 'duo.invited', entryId: 'x1', ownerId: 'p1', partnerId: 'p2', sameGroup: false },
    { t: T(2), seq: 7, ev: 'duo.answered', entryId: 'x1', accepted: true },
    { t: T(3), seq: 8, ev: 'duo.left', entryId: 'x1', personId: 'p2' },
    { t: T(4), seq: 9, ev: 'stage.started', queueId: 9, entryId: 'x1', ids: ['p1', 'p2'], source: 'queue' },
    { t: T(5), seq: 10, ev: 'duo.joinRequested', entryId: 'x2', ownerId: 'p2', requesterId: 'p3', direct: false },
    { t: T(6), seq: 11, ev: 'duo.joinExpired', entryId: 'x2', ownerId: 'p2', requesterId: 'p3' },
    { t: T(6), seq: 12, ev: 'notice.sent', personId: 'p3', kind: 'duo.joinExpired' },
    { t: T(6), seq: 13, ev: 'attention.snoozed', personId: 'p3' },
    { t: T(7), seq: 14, ev: 'song.requested', personId: 'p2', entryId: 'x3', title: 'Solo' },
    { t: T(8), seq: 15, ev: 'stage.started', queueId: 10, entryId: 'x3', ids: ['p2'], source: 'queue' },
    { t: T(8.5), seq: 16, ev: 'duo.improvised', entryId: 'x3', ownerId: 'p2', partnerId: 'p3' },
    { t: T(9), seq: 17, ev: 'duo.improvisedReplaced', entryId: 'x3', partnerId: 'p1' },
    { t: T(9.5), seq: 18, ev: 'duo.improvisedCancelled', entryId: 'x3', partnerId: 'p1' },
    { t: T(10), seq: 19, ev: 'song.requested', personId: 'p3', entryId: 'x4', title: 'Avant' },
    { t: T(10), seq: 20, ev: 'duo.improvised', entryId: 'x4', ownerId: 'p3', partnerId: 'p1' },
    { t: T(11), seq: 21, ev: 'stage.started', queueId: 11, entryId: 'x4', ids: ['p3'], source: 'queue' },
    { t: T(12), seq: 22, ev: 'stage.ended', queueId: 11, playedSec: 60 },
    { t: T(13), seq: 23, ev: 'table.left', tableId: '3', personIds: ['p2', 'p3'] },
    { t: T(14), seq: 24, ev: 'person.reactivated', personId: 'p1' },
    { t: T(14), seq: 25, ev: 'staff.move', kind: 'priority' },
    { t: T(14), seq: 26, ev: 'staff.move', kind: 'move' },
    { t: T(14), seq: 27, ev: 'spotify', action: 'resume', result: 'done', trigger: 'auto' },
    { t: T(15), seq: 28, ev: 'spotify', action: 'pause', result: 'done' },
    { t: T(15), seq: 29, ev: 'spotify', action: 'resume', result: 'done', trigger: 'closing' },
    { t: T(15), seq: 30, ev: 'closing.set', closingAt: T(20) },
    { t: T(16), seq: 31, ev: 'closing.refused', personId: 'p1' },
    { t: T(16), seq: 32, ev: 'turn.unsent', entryId: 'x9', reason: 'pulled-closing' },
    { t: T(17), seq: 33, ev: 'staff.queueCleared', songs: 0 },
    { t: T(17), seq: 34, ev: 'mystery.event' },
    { t: T(18), seq: 35, ev: 'battle.staffLaunch', ballotId: 'b9', title: 'Battle' },
    { t: T(18), seq: 36, ev: 'stage.started', queueId: 12, source: 'battle', title: 'Battle' },
    { t: T(19), seq: 37, ev: 'settings.changed', setting: 'auto', from: true, to: false },
    { t: T(19), seq: 38, ev: 'autoplay.held' },
    { t: T(19), seq: 39, ev: 'staff.absent', entryId: 'x4' },
    { t: T(19), seq: 40, ev: 'song.requested', personId: 'p1', entryId: 'y1', title: 'Retiré par le bar' },
    { t: T(19), seq: 41, ev: 'song.removed', personId: 'p1', entryId: 'y1', by: 'staff' },
    { t: T(19), seq: 42, ev: 'song.requested', personId: 'p1', entryId: 'y2', title: 'Retiré' },
    { t: T(19), seq: 43, ev: 'song.removed', entryId: 'y2' },
    { t: T(19), seq: 44, ev: 'duo.joinAnswered', entryId: 'y3', requesterId: 'p1', accepted: false },
    { t: T(19), seq: 45, ev: 'song.requested', personId: 'p1', entryId: 'y3', title: 'Attend encore' },
    { t: T(19), seq: 46, ev: 'duo.joinAnswered', entryId: 'y3', requesterId: 'p2', accepted: true },
    { t: T(19), seq: 47, ev: 'duo.joinCancelled', entryId: 'y3', requesterId: 'p3' },
    { t: T(19), seq: 48, ev: 'presence.skipped', personId: 'p1', entryId: 'y3', skips: 3, removed: true },
    { t: T(19.5), seq: 49, ev: 'stage.started', source: 'native', title: 'Sans identifiant' },
  ];
  const stats = computeStats({ meta: { roster: { p1: { name: 'Solo', tableId: 'Comptoir' } } }, events, now: T(20), live: true });
  const g = stats.global;
  assert.equal(g.duos.left, 1);
  assert.equal(g.duos.joinExpired, 1);
  assert.equal(g.notices.sent, 1);
  assert.equal(g.notices.snoozed, 1);
  assert.deepEqual(stats.timeline.stages[0].ids, ['p1'], 'l’invitée retirée ne compte pas sur scène');
  assert.deepEqual(stats.timeline.stages[1].ids, ['p2'], 'duo noté puis changé puis annulé');
  assert.equal(stats.timeline.stages[1].kind, 'solo');
  assert.deepEqual(stats.timeline.stages[2].ids, ['p3', 'p1'], 'duo noté avant le lancement');
  assert.equal(g.duos.improvisedReplaced, 1);
  assert.equal(g.duos.improvisedCancelled, 1);
  assert.equal(byId(stats, 'p2').explicitLeft, true);
  assert.equal(byId(stats, 'p1').leftEstimated, true, 'revenue : présence estimée');
  assert.equal(stats.tables.find(tb => tb.id === 'Comptoir').individual, true);
  assert.equal(g.staff.priorities, 1);
  assert.equal(g.staff.moves, 1);
  assert.equal(g.spotify.silences, 2);
  assert.equal(g.spotify.silenceSec, 60 + 300);
  assert.equal(g.closing.refused, 1);
  assert.equal(g.closing.pulled, 1);
  assert.equal(g.staff.queueCleared, 1);
  assert.equal(stats.quality.other['mystery.event'], 1);
  assert.equal(g.battle.staffLaunches, 1);
  assert.equal(g.battles, 1);
  assert.equal(g.staff.settings, 1);
  assert.equal(g.autoplay.held, 1);
  assert.equal(g.presence.absent, 1);
  assert.equal(byId(stats, 'p3').absences, 1);
  const solo = byId(stats, 'p1');
  assert.deepEqual(solo.removedBy, { staff: 1, self: 1 });
  assert.equal(solo.waiting, 1);
  assert.equal(solo.presenceRemoved, 1);
  assert.ok(solo.demandSec > 0, 'titre encore en attente à la fin');
  assert.equal(g.staff.removedSongs, 1);
  assert.equal(g.duos.joinDeclined, 1);
  assert.equal(g.duos.joinAccepted, 1);
  assert.equal(g.duos.joinCancelled, 1);
  assert.equal(stats.timeline.stages.at(-1).queueId, null);
  assert.match(insights(stats).map(i => i.text).join('\n'), /Fermeture : 1 titre retiré de KaraFun, 1 ajout refusé\.[\s\S]*Spotify a comblé 2 silences/);
});

test('export : prénoms remplacés par S01…, tables par T1…, prénoms seulement sur demande', () => {
  const { meta, events } = fixture();
  const data = exportEvening({ meta, events, now: at(200), app: { version: 'v1.4.0', commit: 'abc' } });
  const text = JSON.stringify(data);
  for (const secret of ['Alice', 'Bruno', 'Chloé', 'Dina', 'Julie', 'pA', 'pB', '"boot"']) assert.ok(!text.includes(secret), secret);
  assert.equal(data.format, 'karaoke-evening');
  assert.equal(data.privacy.names, 'pseudonymized');
  assert.deepEqual(data.people.map(p => p.key), ['S01', 'S02', 'S03', 'S04']);
  assert.deepEqual(data.tables.map(t => t.key), ['T1', 'T2']);
  assert.equal(data.people[2].table, 'T2');
  assert.ok(data.events.some(e => e.personId === 'S01' && e.ev === 'song.requested'));
  assert.ok(data.events.some(e => e.ev === 'person.joined' && e.tableId === 'T2'));
  assert.deepEqual(data.stats.tables.map(t => t.id), ['T1', 'T2']);
  assert.equal(data.stats.singers[0].id, 'S01');
  assert.match(data.insights.map(i => i.text).join(' '), /T2 a attendu/);
  assert.deepEqual(data.app, { version: 'v1.4.0', commit: 'abc' });
  const named = exportEvening({ meta, events, names: true });
  assert.equal(named.privacy.names, 'included');
  assert.equal(named.people[0].name, 'Alice');
  assert.equal(named.tables[1].name, 'Terrasse de Julie');
  assert.match(named.insights.map(i => i.text).join(' '), /Terrasse de Julie a attendu/);
  assert.equal(exportEvening({ meta: { ...meta, app: { version: 'v0' } }, events }).app.version, 'v0');
});
