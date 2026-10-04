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
  // Regression: relecture PR #11 — « Plus tard » reste sur le téléphone :
  // aucun compteur qui resterait toujours à 0 dans l'export.
  assert.deepEqual(g.notices, { sent: 1 });
  assert.equal(stats.quality.other['attention.snoozed'], 1, 'événement inconnu : compté à part');
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

test('duo noté puis changé par le bar : un seul duo improvisé compté', () => {
  // Ordre réel du journal quand le bar change de partenaire : le nouveau duo
  // est noté par la file, puis la correction est signalée.
  const T = m => T0 + m * 60000;
  const events = [
    { t: T(0), seq: 1, ev: 'person.joined', personId: 'p1', name: 'Alice', tableId: '1' },
    { t: T(0), seq: 2, ev: 'person.joined', personId: 'p2', name: 'Bob', tableId: '1' },
    { t: T(0), seq: 3, ev: 'person.joined', personId: 'p3', name: 'Chloé', tableId: '2' },
    { t: T(1), seq: 4, ev: 'song.requested', personId: 'p1', entryId: 'x1', title: 'Solo' },
    { t: T(2), seq: 5, ev: 'stage.started', queueId: 1, entryId: 'x1', ids: ['p1'], source: 'queue' },
    { t: T(2.5), seq: 6, ev: 'duo.improvised', entryId: 'x1', ownerId: 'p1', partnerId: 'p2' },
    { t: T(3), seq: 7, ev: 'duo.improvised', entryId: 'x1', ownerId: 'p1', partnerId: 'p3' },
    { t: T(3), seq: 8, ev: 'duo.improvisedReplaced', entryId: 'x1', ownerId: 'p1', partnerId: 'p3', previousPartnerId: 'p2' },
    { t: T(5), seq: 9, ev: 'stage.ended', queueId: 1, playedSec: 180 },
  ];
  const stats = computeStats({ meta: {}, events, now: T(6) });
  assert.equal(stats.global.duos.improvised, 1, 'le changement de partenaire n’est pas un deuxième duo');
  assert.equal(stats.global.duos.improvisedReplaced, 1);
  assert.equal(stats.global.duos.improvisedStages, 1);
  assert.deepEqual(stats.timeline.stages[0].ids, ['p1', 'p3']);
});

test('vidage de la file : les titres restants passent à « retiré (bar) », plus en attente', () => {
  const T = m => T0 + m * 60000;
  const events = [
    { t: T(0), seq: 1, ev: 'person.joined', personId: 'pA', tableId: '1' },
    { t: T(0), seq: 2, ev: 'person.joined', personId: 'pB', tableId: '2' },
    { t: T(1), seq: 3, ev: 'song.requested', personId: 'pA', entryId: 'a1', title: 'Chanté' },
    { t: T(1), seq: 4, ev: 'song.requested', personId: 'pA', entryId: 'a2', title: 'Restant A' },
    { t: T(2), seq: 5, ev: 'song.requested', personId: 'pB', entryId: 'b1', title: 'Restant B' },
    { t: T(3), seq: 6, ev: 'stage.started', queueId: 1, entryId: 'a1', ids: ['pA'], source: 'queue' },
    { t: T(6), seq: 7, ev: 'stage.ended', queueId: 1, playedSec: 180 },
    { t: T(10), seq: 8, ev: 'staff.queueCleared', songs: 2, pendingCancelled: false },
    { t: T(20), seq: 9, ev: 'song.requested', personId: 'pB', entryId: 'b2', title: 'Après le vidage' },
  ];
  const stats = computeStats({ meta: {}, events, now: T(30) });
  const status = id => Object.fromEntries(byId(stats, id).songs.map(s => [s.entryId, [s.status, s.removedBy]]));
  assert.deepEqual(status('pA'), { a1: ['sung', null], a2: ['removed', 'staff'] });
  assert.deepEqual(status('pB'), { b1: ['removed', 'staff'], b2: ['waiting', null] });
  assert.equal(byId(stats, 'pA').songs.find(s => s.entryId === 'a2').removedAt, T(10));
  assert.equal(byId(stats, 'pA').waiting, 0);
  assert.equal(byId(stats, 'pB').waiting, 1, 'seul le titre demandé après le vidage attend');
  assert.equal(byId(stats, 'pA').removed, 1);
  assert.equal(byId(stats, 'pB').removed, 1);
  assert.deepEqual(byId(stats, 'pB').removedBy, { staff: 1 });
  assert.equal(stats.global.staff.queueCleared, 1);
  assert.equal(stats.global.staff.removedSongs, 0, 'le vidage a son propre compteur');
  const exported = exportEvening({ meta: {}, events, now: T(30) });
  assert.deepEqual(exported.stats.singers.map(s => s.waiting), [0, 1]);
  assert.deepEqual(exported.stats.singers.flatMap(s => s.songs.map(song => song.status)), ['sung', 'removed', 'removed', 'waiting']);
});

test('équité : un bonus temporaire ou tardif ne compte que pendant sa durée', () => {
  // A (table 1) et B (table 2) présents de 0 à 120 min ; A chante 3 fois, B une fois.
  const T = m => T0 + m * 60000;
  const evening = bonusEvents => {
    const events = [
      { t: T(0), ev: 'person.joined', personId: 'pA', tableId: '1' },
      { t: T(0), ev: 'person.joined', personId: 'pB', tableId: '2' },
      ...['a1', 'a2', 'a3'].map(entryId => ({ t: T(0), ev: 'song.requested', personId: 'pA', entryId })),
      { t: T(0), ev: 'song.requested', personId: 'pB', entryId: 'b1' },
      ...[['a1', 'pA', 10], ['a2', 'pA', 30], ['a3', 'pA', 50], ['b1', 'pB', 70]].flatMap(([entryId, pid, m], i) => [
        { t: T(m), ev: 'stage.started', queueId: i + 1, entryId, ids: [pid], source: 'queue' },
        { t: T(m + 4), ev: 'stage.ended', queueId: i + 1, playedSec: 240 }]),
      { t: T(120), ev: 'person.left', personId: 'pA', by: 'self' },
      { t: T(120), ev: 'person.left', personId: 'pB', by: 'self' },
      ...bonusEvents.map(([m, ev, fields]) => ({ t: T(m), ev, ...fields })),
    ].map((e, i) => ({ seq: i + 1, ...e }));
    return computeStats({ meta: {}, events, now: T(130) });
  };
  // Rythmes bruts : A 1,5 par heure, B 0,5 ; indice brut 0,8.
  const temporary = evening([[0, 'person.bonus', { personId: 'pA', level: 3 }], [60, 'person.bonus', { personId: 'pA', level: 0 }]]);
  assert.equal(temporary.fairness.jain, 0.8);
  assert.equal(byId(temporary, 'pA').weight, 1.5, '× 2 pendant la moitié de la présence');
  assert.equal(byId(temporary, 'pA').bonus, 0, 'dernier niveau affiché');
  assert.equal(temporary.fairness.bonusPeople, 1);
  close(temporary.fairness.jainAdjusted, jain([1.5 / 1.5, 0.5]), 0.001);
  const fairRate = 4 / (1.5 * 2 + 1 * 2);
  close(temporary.fairness.fairRate, fairRate);
  close(byId(temporary, 'pA').expectedTurns, fairRate * 1.5 * 2);
  close(byId(temporary, 'pB').expectedTurns, fairRate * 2);
  assert.equal(byId(temporary, 'pA').bonusSec, 3600);
  assert.equal(byId(temporary, 'pB').bonusSec, 0);
  // Bonus posé une minute avant la fin : presque sans effet.
  const late = evening([[119, 'person.bonus', { personId: 'pA', level: 3 }]]);
  assert.equal(byId(late, 'pA').weight, 1.008);
  assert.equal(byId(late, 'pA').bonus, 3);
  close(late.fairness.jainAdjusted, jain([1.5 / 1.008, 0.5]), 0.001);
  // Bonus de table temporaire : même effet.
  const table = evening([[0, 'table.bonus', { tableId: '1', level: 3 }], [60, 'table.bonus', { tableId: '1', level: 0 }]]);
  assert.equal(byId(table, 'pA').weight, 1.5);
  assert.equal(table.fairness.bonusPeople, 1);
  close(table.fairness.jainAdjusted, 0.9, 0.001);
  // +1 puis −1 dont la moyenne vaut exactement 1 : la personne a bien eu un bonus.
  const balanced = evening([[0, 'person.bonus', { personId: 'pA', level: 1 }], [3200 / 60, 'person.bonus', { personId: 'pA', level: -1 }]]);
  assert.equal(byId(balanced, 'pA').weight, 1);
  assert.equal(balanced.fairness.bonusPeople, 1);
  assert.equal(byId(balanced, 'pA').bonusSec, 7200);
  // Bonus posé avant l'arrivée : actif dès l'arrivée, comme dans l'ordonnanceur.
  const before = evening([[-10, 'table.bonus', { tableId: '2', level: 2 }]]);
  assert.equal(byId(before, 'pB').weight, 1.5);
});

// ---------------------------------------------------------------- QA navigateur du 2026-10-03
// Found by /qa on 2026-10-03
// Report: .gstack/qa-reports/run-20261003T140104Z/qa-report-127.0.0.1-2026-10-03.md

// Journal minimal : titres de 45 s enchaînés sans pause, puis éventuellement un titre en cours.
function backToBack({ count = 8, ongoingSec = null, extra = [] } = {}) {
  const events = [];
  let seq = 0;
  const e = (sec, ev, fields = {}) => events.push({ v: 1, seq: ++seq, t: T0 + sec * 1000, ev, boot: 'b1', ...fields });
  e(0, 'evening.started', { rules: {} });
  e(0, 'person.joined', { personId: 'pA', tableId: '1' });
  for (let i = 0; i < count; i++) {
    e(i * 45, 'stage.started', { queueId: i + 1, source: 'native', title: `T${i}` });
    e(i * 45 + 45, 'stage.ended', { queueId: i + 1, playedSec: 45 });
  }
  if (ongoingSec != null) e(count * 45, 'stage.started', { queueId: 99, source: 'native', title: 'En cours' });
  for (const [sec, ev, fields] of extra) e(sec, ev, fields);
  const now = T0 + (count * 45 + (ongoingSec || 0)) * 1000;
  return computeStats({ meta: { eveningId: 'e', startedAt: T0 }, events: events.sort((a, b) => a.t - b.t), now, live: true });
}

// Regression: ISSUE-027 — « Chansons par heure » dépassait le maximum possible pendant qu'un titre jouait
test('chansons par heure : le titre en cours ne compte pas, jamais plus de 80 titres de 45 s par heure', () => {
  const done = backToBack({ count: 8 });
  assert.equal(done.global.songsPerHour, 80, '8 titres de 45 s en 6 min : 80 par heure');
  for (const ongoingSec of [1, 5, 27, 44]) {
    const playing = backToBack({ count: 8, ongoingSec });
    assert.ok(playing.global.songsPerHour <= 80, `titre en cours depuis ${ongoingSec} s : ${playing.global.songsPerHour}`);
    assert.equal(playing.global.songsPerHour, 80);
    assert.equal(playing.global.songs, 9, 'le titre en cours reste compté parmi les chansons');
  }
  const first = backToBack({ count: 0, ongoingSec: 10 });
  assert.equal(first.global.songsPerHour, null, 'aucun titre terminé : pas de rythme');
});

// Regression: ISSUE-029 — temps mort après une Battle terminée attribué à « Battle en préparation »
// Regression: ISSUE-033 — une cause à 0 s apparaissait dans les causes des temps morts
test('temps morts : après une Battle terminée, cause « Après la Battle » ; aucune cause à 0 s', () => {
  const events = [];
  let seq = 0;
  const e = (minutes, ev, fields = {}) => events.push({ v: 1, seq: ++seq, t: at(minutes), ev, boot: 'b1', ...fields });
  e(0, 'evening.started', { rules: {} });
  e(0, 'person.joined', { personId: 'pA', tableId: '1' });
  e(0, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Take On Me' });
  e(0, 'karaoke.phase', { phase: 'between', blocker: 'battle-hold' });
  e(2, 'stage.started', { queueId: 1, source: 'battle', title: 'Dancing Queen' });
  e(2, 'karaoke.phase', { phase: 'singing', blocker: null });
  e(2.75, 'stage.ended', { queueId: 1, playedSec: 45 });
  e(2.75, 'karaoke.phase', { phase: 'between', blocker: 'battle-hold' });
  e(7, 'karaoke.phase', { phase: 'between', blocker: 'sending' });
  e(7.0001, 'stage.started', { queueId: 2, entryId: 'a1', ids: ['pA'], source: 'queue', title: 'Take On Me' });
  e(7.0001, 'karaoke.phase', { phase: 'singing', blocker: null });
  const stats = computeStats({ meta: { eveningId: 'e', startedAt: at(0) }, events, now: at(8), live: true });
  assert.deepEqual(stats.global.deadCauses.map(c => [c.cause, c.label, c.sec]), [['battle-after', 'Après la Battle : relance par le bar', 255]]);
  assert.equal(CAUSES['battle-after'], 'Après la Battle : relance par le bar');
  assert.equal(stats.timeline.gaps.find(g => g.dead).label, 'Après la Battle : relance par le bar');
  assert.ok(stats.global.deadCauses.every(c => c.sec > 0), 'aucune cause à 0 s');
  assert.ok(!insights(stats, { nameOf: () => 'A', tableName: () => 'T' }).some(i => /Battle en préparation/.test(i.text)));
});

// Regression: relecture PR #11 — un événement de duo sans titre (anciens
// journaux) ne se rapproche plus d'une Battle ou d'un titre hors file.
test('duo noté sans titre : aucun passage sans titre n’est changé en duo', () => {
  const T = m => T0 + m * 60000;
  const events = [
    { t: T(0), seq: 1, ev: 'person.joined', personId: 'p1', tableId: '1' },
    { t: T(0), seq: 2, ev: 'person.joined', personId: 'p2', tableId: '2' },
    { t: T(1), seq: 3, ev: 'stage.started', queueId: 7, source: 'battle', title: 'Battle collective' },
    { t: T(4), seq: 4, ev: 'stage.ended', queueId: 7, playedSec: 180 },
    { t: T(5), seq: 5, ev: 'song.requested', personId: 'p1', entryId: 'x1', title: 'Solo' },
    { t: T(6), seq: 6, ev: 'stage.started', queueId: 8, entryId: 'x1', ids: ['p1'], source: 'queue' },
    { t: T(9), seq: 7, ev: 'stage.ended', queueId: 8, playedSec: 180 },
    { t: T(10), seq: 8, ev: 'duo.improvised', entryId: null, ownerId: 'p1', partnerId: 'p2' },
    { t: T(10), seq: 9, ev: 'duo.improvisedReplaced', entryId: null, ownerId: 'p1', partnerId: 'p2', previousPartnerId: 'p3' },
    { t: T(11), seq: 10, ev: 'duo.improvisedCancelled', entryId: null, ownerId: 'p1', partnerId: 'p2' },
  ];
  const stats = computeStats({ meta: {}, events, now: T(12) });
  assert.deepEqual(stats.timeline.stages.map(st => [st.kind, st.ids]), [['battle', []], ['solo', ['p1']]]);
});

// ---------------------------------------------------------------- relecture PR #11
const singerOf = (stats, id) => stats.singers.find(s => s.id === id);

// Regression: relecture PR #11 — redémarrage pendant une chanson : la fin du
// passage était placée trop tôt et un faux temps mort apparaissait.
test('redémarrage pendant une chanson : durée jouée et fin justes, pas de faux temps mort', () => {
  const T = m => T0 + m * 60000;
  const events = [
    { t: T(0), seq: 1, ev: 'person.joined', personId: 'p1', tableId: '1' },
    { t: T(0), seq: 2, ev: 'person.joined', personId: 'p2', tableId: '2' },
    { t: T(1), seq: 3, ev: 'song.requested', personId: 'p1', entryId: 'a1', title: 'Un' },
    { t: T(1), seq: 4, ev: 'song.requested', personId: 'p2', entryId: 'b1', title: 'Deux' },
    { t: T(2), seq: 5, ev: 'stage.started', queueId: 1, entryId: 'a1', ids: ['p1'], source: 'queue', boot: 'b1' },
    { t: T(2), seq: 6, ev: 'karaoke.phase', phase: 'singing' },
    { t: T(3.5), seq: 7, ev: 'app.started', restored: true, offlineMs: 30000, boot: 'b2' },
    // Après la reprise, le serveur renote le même titre (son suivi repart de zéro).
    { t: T(3.5), seq: 8, ev: 'stage.started', queueId: 1, entryId: 'a1', ids: ['p1'], source: 'queue', boot: 'b2' },
    { t: T(3.5), seq: 9, ev: 'karaoke.phase', phase: 'singing' },
    { t: T(6), seq: 10, ev: 'stage.ended', queueId: 1, playedSec: 150 },
    { t: T(6), seq: 11, ev: 'karaoke.phase', phase: 'between', blocker: 'loading' },
    { t: T(6.25), seq: 12, ev: 'stage.started', queueId: 2, entryId: 'b1', ids: ['p2'], source: 'queue' },
    { t: T(9), seq: 13, ev: 'stage.ended', queueId: 2, playedSec: 165 },
  ];
  const stats = computeStats({ meta: {}, events, now: T(10) });
  const [first] = stats.timeline.stages;
  assert.equal(stats.timeline.stages.length, 2, 'un seul passage pour le titre repris');
  assert.equal(first.end, T(6), 'fin du titre à 19:06, pas à 19:04:30');
  assert.equal(first.playedSec, 240);
  assert.deepEqual(stats.global.deadCauses.map(c => [c.cause, c.sec]), [['loading', 15]]);
  assert.equal(stats.global.deadSec, 15);
});

// Regression: relecture PR #11 — invité retiré d'un duo prévu puis revenu :
// le duo chanté était compté comme un solo.
test('invité retiré d’un duo prévu puis revenu : le duo chanté compte pour lui', () => {
  const { Scheduler } = require('../scheduler');
  for (const sameTable of [true, false]) {
    const s = new Scheduler();
    const events = [];
    let clock = T0;
    s.onEvent = (ev, fields) => events.push({ t: clock += 1000, seq: events.length + 1, ev, ...JSON.parse(JSON.stringify(fields)) });
    const alice = s.join({ tableId: '1', name: 'Alice', headcount: 2 });
    const bob = s.join({ tableId: sameTable ? '1' : '2', name: 'Bob', headcount: 2 });
    s.chooseSong(alice, { songId: 1, title: 'Un' });
    const entryId = alice.song.entryId;
    const join = () => { s.requestDuetJoin(bob, alice.id, entryId); if (!sameTable) s.answerDuetJoin(alice, entryId, bob.id, true); };
    join();
    s.leaveDuet(bob, alice.id, entryId);
    join();
    const sel = s.select();
    assert.deepEqual([...sel.ids], [alice.id, bob.id], 'KaraFun reçoit le duo');
    s.commit(sel);
    s.chooseSong(bob, { songId: 2, title: 'Deux' }); // Bob a aussi son propre titre
    events.push({ t: clock += 1000, seq: events.length + 1, ev: 'stage.started', queueId: 1, entryId, ids: [...sel.ids], source: 'queue' });
    events.push({ t: clock += 180000, seq: events.length + 1, ev: 'stage.ended', queueId: 1, playedSec: 180 });
    const stats = computeStats({ meta: {}, events, now: clock });
    assert.equal(stats.global.duoStages, 1, `même table : ${sameTable}`);
    assert.equal(singerOf(stats, bob.id).guestTurns, 1);
    assert.equal(stats.fairness.neverSang, 0);
  }
});

// Regression: relecture PR #11 — un bonus ou un réglage fait par le bar
// comptait comme un signe d'activité de la personne.
test('présence : un geste du bar (bonus, réglage d’un titre) n’est pas un signe d’activité', () => {
  const T = m => T0 + m * 60000;
  const base = [
    { t: T(0), seq: 1, ev: 'person.joined', personId: 'p1', tableId: '1' },
    { t: T(240), seq: 9, ev: 'evening.closed' },
  ];
  const presence = extra => singerOf(computeStats({ meta: {}, events: [...base.slice(0, 1), ...extra, base[1]].map((e, i) => ({ ...e, seq: i + 1 })) }), 'p1').presenceSec;
  assert.equal(presence([]), 30 * 60);
  assert.equal(presence([{ t: T(180), ev: 'person.bonus', personId: 'p1', level: -2 }]), 30 * 60);
  assert.equal(presence([{ t: T(180), ev: 'song.settings', by: 'staff', where: 'list', personId: 'p1', entryId: 'e1', settings: { pitch: 1 } }]), 30 * 60);
  // Témoin : un réglage fait par la personne compte.
  assert.equal(presence([{ t: T(180), ev: 'song.settings', by: 'self', where: 'list', personId: 'p1', entryId: 'e1', settings: { pitch: 1 } }]), 210 * 60);
});

// Regression: relecture PR #11 — temps morts : arrêt compté deux fois, et
// intervalle entier rangé selon sa cause la plus longue.
test('temps morts : chaque portion compte pour sa cause, un arrêt une seule fois', () => {
  const T = m => T0 + m * 60000;
  const head = [
    { t: T(0), ev: 'person.joined', personId: 'p1', tableId: '1' },
    { t: T(0), ev: 'person.joined', personId: 'p2', tableId: '2' },
    { t: T(0.5), ev: 'stage.started', queueId: 1, ids: ['p1'], source: 'queue' },
    { t: T(4), ev: 'stage.ended', queueId: 1, playedSec: 210 },
  ];
  const run = rest => computeStats({ meta: {}, events: [...head, ...rest].map((e, i) => ({ ...e, seq: i + 1 })), now: T(30) }).global;
  // Arrêt de 4 min pendant qu'un titre attendait l'envoi.
  const off = run([{ t: T(4), ev: 'karaoke.phase', phase: 'waiting', blocker: 'push-delay' },
    { t: T(5), ev: 'person.seen', personId: 'p2' },
    { t: T(9), ev: 'app.started', restored: true, offlineMs: 4 * 60000 },
    { t: T(10), ev: 'stage.started', queueId: 2, ids: ['p2'], source: 'queue' }]);
  assert.equal(off.deadSec, 360);
  assert.deepEqual(off.deadCauses.map(c => [c.cause, c.sec]), [['offline', 240], ['push-delay', 120]]);
  assert.equal(off.deadCauses.reduce((n, c) => n + c.sec, 0), off.deadSec, 'les parts font 100 %');
  // File vide puis titre en attente de la lecture par le bar, dans les deux proportions.
  for (const [empty, waiting] of [[2, 3], [3, 2]]) {
    const g = run([{ t: T(4), ev: 'karaoke.phase', phase: 'silent', blocker: 'empty' },
      { t: T(4 + empty), ev: 'song.requested', personId: 'p2', entryId: 'b1', title: 'Deux' },
      { t: T(4 + empty), ev: 'karaoke.phase', phase: 'between', blocker: 'autoplay-off' },
      { t: T(4 + empty + waiting), ev: 'stage.started', queueId: 2, entryId: 'b1', ids: ['p2'], source: 'queue' }]);
    assert.equal(g.deadSec, waiting * 60, `file vide ${empty} min exclue`);
    assert.equal(g.deadGapCount, 1);
    assert.deepEqual(g.deadCauses.map(c => [c.cause, c.sec]), [['autoplay-off', waiting * 60]]);
    assert.equal(g.idleSec, empty * 60);
  }
  // Arrêt pendant que la file était vide : ni temps mort ni cause.
  const idle = run([{ t: T(4), ev: 'karaoke.phase', phase: 'silent', blocker: 'empty' },
    { t: T(5), ev: 'person.seen', personId: 'p2' },
    { t: T(9), ev: 'app.started', restored: true, offlineMs: 4 * 60000 },
    { t: T(10), ev: 'stage.started', queueId: 2, ids: ['p2'], source: 'queue' }]);
  assert.equal(idle.deadSec, 0);
  assert.deepEqual(idle.deadCauses, []);
});

// Regression: relecture PR #11 — titres remplacés, abandonnés au départ ou
// dont l'envoi est annulé : « en attente » pour toujours.
test('titres remplacés, abandonnés au départ ou annulés : retirés, plus « en attente »', () => {
  const T = m => T0 + m * 60000;
  const events = [
    { t: T(0), ev: 'person.joined', personId: 'pA', tableId: '1' },
    { t: T(0), ev: 'person.joined', personId: 'pB', tableId: '2' },
    { t: T(0), ev: 'person.joined', personId: 'pC', tableId: '3' },
    { t: T(0), ev: 'person.joined', personId: 'pD', tableId: '4' },
    { t: T(1), ev: 'song.requested', personId: 'pA', entryId: 'a1', title: 'Premier choix' },
    { t: T(2), ev: 'song.requested', personId: 'pA', entryId: 'a2', title: 'Remplaçant', replacedEntryIds: ['a1'] },
    { t: T(1), ev: 'song.requested', personId: 'pB', entryId: 'b1', title: 'Parti avec' },
    { t: T(1), ev: 'song.requested', personId: 'pC', entryId: 'c1', title: 'Table partie' },
    { t: T(1), ev: 'song.requested', personId: 'pD', entryId: 'd1', title: 'Envoyé puis remplacé' },
    { t: T(1), ev: 'song.requested', personId: 'pD', entryId: 'd2', title: 'Envoi annulé' },
    { t: T(3), ev: 'person.left', personId: 'pB', by: 'self' },
    { t: T(3), ev: 'table.left', tableId: '3', personIds: ['pC'] },
    // Remplacé pendant son envoi : il part quand même et il est chanté.
    { t: T(4), ev: 'song.requested', personId: 'pD', entryId: 'd3', title: 'Nouveau', replacedEntryIds: ['d1', 'd2'] },
    { t: T(5), ev: 'turn.sent', entryId: 'd1', ids: ['pD'], queueId: 5 },
    { t: T(6), ev: 'stage.started', queueId: 5, entryId: 'd1', ids: ['pD'], source: 'queue' },
    { t: T(9), ev: 'stage.ended', queueId: 5, playedSec: 180 },
    { t: T(10), ev: 'turn.sent', entryId: 'd3', ids: ['pD'], queueId: 6 },
    { t: T(11), ev: 'turn.unsent', entryId: 'd3', ids: ['pD'], queueId: 6, reason: 'cancelled' },
    { t: T(12), ev: 'evening.closed' },
  ].map((e, i) => ({ ...e, seq: i + 1 }));
  const stats = computeStats({ meta: {}, events });
  const songs = id => singerOf(stats, id).songs.map(s => [s.title, s.status, s.removedBy]);
  assert.deepEqual(songs('pA'), [['Premier choix', 'removed', 'self'], ['Remplaçant', 'waiting', null]]);
  assert.deepEqual(songs('pB'), [['Parti avec', 'removed', 'self']]);
  assert.deepEqual(songs('pC'), [['Table partie', 'removed', 'staff']]);
  assert.deepEqual(songs('pD'), [['Envoyé puis remplacé', 'sung', null], ['Envoi annulé', 'removed', 'self'], ['Nouveau', 'removed', 'staff']]);
  assert.deepEqual(['pA', 'pB', 'pC', 'pD'].map(id => [singerOf(stats, id).waiting, singerOf(stats, id).removed]),
    [[1, 1], [0, 1], [0, 1], [0, 2]]);
  assert.deepEqual(singerOf(stats, 'pD').removedBy, { self: 1, staff: 1 });
});
