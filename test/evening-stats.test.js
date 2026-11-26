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
  assert.deepEqual(stats.global.longestWait, { sec: 50 * 60, personId: 'pD', title: 'Cinq', at: at(60), guestStages: 0 });
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

// Soirée du 10 octobre : application lancée à 15:41, KaraFun connecté à 20:19,
// fermeture à 03:10 (dernier titre fini à 03:17), soirée close au bar le
// lendemain à 12:54. Des pages restées ouvertes ont compté 15 h et 16 h de
// présence à deux habitués.
test('présence : de la connexion de KaraFun à la fermeture du bar, pas la matinée suivante', () => {
  const T = m => T0 + m * 60000;
  let seq = 0;
  const e = (minutes, ev, fields = {}) => ({ v: 1, seq: ++seq, t: T(minutes), ev, ...fields });
  const events = [
    e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
    e(0, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
    e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
    e(60, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
    e(70, 'person.joined', { personId: 'pB', tableId: '1' }),
    e(80, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Un' }),
    e(90, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], ownerId: 'pA', source: 'queue' }),
    e(94, 'stage.ended', { queueId: 1, playedSec: 240 }),
    e(150, 'closing.set', { closingAt: T(200) }),
    e(195, 'stage.started', { queueId: 2, source: 'native', title: 'Dernier' }),
    e(200, 'closing.reached', { closingAt: T(200) }),
    e(205, 'stage.ended', { queueId: 2, playedSec: 600 }),
    e(206, 'spotify', { action: 'resume', result: 'done', trigger: 'closing' }),
    e(210, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
    // Téléphones restés ouverts : signes de vie jusqu'au lendemain.
    ...Array.from({ length: 50 }, (_, k) => e(220 + k * 15, 'person.seen', { personId: k % 2 ? 'pA' : 'pB' })),
    e(1000, 'evening.closed', { by: 'staff-reset' }),
  ];
  const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(1000) }, events });
  assert.equal(stats.evening.openedAt, T(60), 'ouverture : connexion de KaraFun');
  assert.equal(stats.evening.closedAt, T(205), 'fermeture : fin du dernier titre, après l’heure de fermeture');
  assert.equal(singerOf(stats, 'pA').presenceSec, (205 - 60) * 60, 'inscrite avant la connexion : comptée depuis la connexion');
  assert.equal(singerOf(stats, 'pB').presenceSec, (205 - 70) * 60);
  assert.equal(stats.global.spotify.silences, 0, 'la musique d’après la fermeture n’est pas un silence de la soirée');
  // Sans heure de fermeture : KaraFun déconnecté après le dernier titre.
  const noClosing = events.filter(ev => !/^closing\./.test(ev.ev));
  const other = computeStats({ meta: { startedAt: T(0), endedAt: T(1000) }, events: noClosing });
  assert.equal(other.evening.closedAt, T(210));
  assert.equal(singerOf(other, 'pA').presenceSec, (210 - 60) * 60);
});

// Relectures du 11 octobre : cas limites de la soirée du karaoké.
{
  const T = m => T0 + m * 60000;
  const evening = () => {
    let seq = 0;
    return (minutes, ev, fields = {}) => ({ v: 1, seq: ++seq, t: T(minutes), ev, ...fields });
  };

  test('présence en direct : fermeture atteinte puis décalée par le bar, la soirée continue', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(20, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Un' }),
      e(30, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], ownerId: 'pA', source: 'queue' }),
      e(34, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(40, 'closing.set', { closingAt: T(60) }),
      e(60, 'closing.reached', { closingAt: T(60) }),
      e(61, 'closing.set', { closingAt: T(120) }),
      e(90, 'person.seen', { personId: 'pA' }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0) }, events, now: T(100), live: true });
    assert.equal(stats.evening.closedAt, null, 'fermeture décalée : soirée encore ouverte');
    assert.ok(singerOf(stats, 'pA').presenceSec > (60 - 10) * 60, 'présence comptée après l’ancienne heure');
  });

  // Codex sur la PR #16 : la même soirée, archivée sans nouvelle fermeture
  // atteinte, ne doit pas être coupée à l'ancienne heure. Une heure retirée le
  // lendemain (« Options par défaut ») sans titre chanté depuis ne rouvre rien.
  test('soirée archivée : fermeture atteinte puis décalée, on rechante ensuite : l’ancienne heure ne coupe plus', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(30, 'stage.started', { queueId: 1, source: 'native', title: 'Un' }),
      e(34, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(40, 'closing.set', { closingAt: T(60) }),
      e(60, 'closing.reached', { closingAt: T(60) }),
      e(61, 'closing.set', { closingAt: T(120) }),
      e(90, 'stage.started', { queueId: 2, source: 'native', title: 'Deux' }),
      e(94, 'stage.ended', { queueId: 2, playedSec: 240 }),
      e(100, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(300, 'evening.closed', { by: 'staff-reset' }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events });
    assert.equal(stats.evening.closedAt, T(100), 'heure décalée puis rechantée, KaraFun coupé avant la nouvelle heure : la coupure finit le karaoké');
    // Heure retirée le lendemain sans titre chanté depuis : la fermeture tient.
    const nextDay = [...events.filter(ev => ev.t < T(61)), e(280, 'closing.cleared'), e(300, 'evening.closed', { by: 'staff-reset' })];
    assert.equal(computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: nextDay }).evening.closedAt, T(60));
  });

  // Relecture du 11 octobre : la file vide à la nouvelle heure, le serveur ne
  // note pas de nouvelle « fermeture atteinte » ; la soirée finit quand même.
  test('fermeture atteinte, « + 15 min », on rechante, file vide à la nouvelle heure : la soirée finit à la nouvelle heure', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(40, 'closing.set', { closingAt: T(60) }),
      e(50, 'stage.started', { queueId: 1, source: 'native', title: 'Un' }),
      e(54, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(60, 'closing.reached', { closingAt: T(60) }),
      e(61, 'closing.set', { closingAt: T(75) }),
      e(65, 'stage.started', { queueId: 2, source: 'native', title: 'Deux' }),
      e(69, 'stage.ended', { queueId: 2, playedSec: 240 }),
      ...Array.from({ length: 20 }, (_, k) => e(80 + k * 10, 'person.seen', { personId: 'pA' })),
      e(300, 'evening.closed', { by: 'staff-reset' }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events });
    assert.equal(stats.evening.closedAt, T(75));
    assert.equal(singerOf(stats, 'pA').presenceSec, (75 - 10) * 60);
    // Heure jamais « atteinte » (rien de retenu) : elle ferme aussi la soirée.
    const quiet = events.filter(ev => !/^closing\.(reached|set)$/.test(ev.ev) || ev.t === T(40))
      .filter(ev => !(ev.ev === 'stage.started' && ev.t === T(65)) && !(ev.ev === 'stage.ended' && ev.t === T(69)));
    assert.equal(computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: quiet }).evening.closedAt, T(60));
  });

  // Relecture du 11 octobre (troisième passe) : l'heure en vigueur au début
  // du dernier titre ne suffit pas, un changement fait avant qu'elle passe
  // compte aussi ; après, seule une prolongation dans les 30 min rouvre.
  test('heure de fermeture : avancée ou prolongée avant qu’elle passe, changée le lendemain, KaraFun quitté avant l’heure', () => {
    const e = evening();
    const base = () => [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(20, 'closing.set', { closingAt: T(180) }),
      e(100, 'stage.started', { queueId: 1, source: 'native', title: 'Dernier' }),
      e(104, 'stage.ended', { queueId: 1, playedSec: 240 }),
    ];
    const end = (extra, opts = {}) => computeStats({ meta: { startedAt: T(0), endedAt: opts.live ? undefined : T(900) },
      events: [...base(), ...extra, ...(opts.live ? [] : [e(900, 'evening.closed', { by: 'staff-reset' })])].sort((a, b) => a.t - b.t),
      ...(opts.live ? { now: opts.now, live: true } : {}) }).evening.closedAt;
    // Avancée après le dernier titre (titres retenus) : la nouvelle heure.
    assert.equal(end([e(106, 'closing.set', { closingAt: T(110) }), e(110, 'closing.reached', { closingAt: T(110) })]), T(110));
    // « + 15 min » avant l'heure, sans titre ensuite : même fin en direct et une fois close.
    const later = [e(170, 'closing.set', { closingAt: T(195) })];
    assert.equal(end(later), T(195));
    assert.equal(end(later, { live: true, now: T(200) }), T(195));
    // Le lendemain : heure retirée ou réglée pour le soir même, rien ne change.
    assert.equal(end([e(700, 'closing.cleared')]), T(180));
    assert.equal(end([e(700, 'closing.set', { closingAt: T(1400) })]), T(180));
    assert.equal(end([e(700, 'closing.cleared')], { live: true, now: T(720) }), T(180));
    // KaraFun quitté pour de bon avant l'heure, PC allumé : pas de KaraFun, pas de karaoké,
    // en direct aussi une fois la coupure longue de 30 min (pas avant).
    const quit = [e(120, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' })];
    assert.equal(end(quit), T(120));
    assert.equal(end(quit, { live: true, now: T(160) }), T(120));
    assert.equal(end(quit, { live: true, now: T(130) }), null, 'coupure de 10 min : la soirée reste en cours');
    // Soirée close 20 min après avoir quitté KaraFun : la coupure compte déjà, rien ne peut plus la suivre.
    const quickClose = [...base(), ...quit, e(140, 'evening.closed', { by: 'staff-reset' })];
    assert.equal(computeStats({ meta: { startedAt: T(0), endedAt: T(140) }, events: quickClose }).evening.closedAt, T(120));
    // Retrait de l'heure après le dernier titre, avant qu'elle passe : plus de fermeture.
    assert.equal(end([e(150, 'closing.cleared')]), null);
    // Retrait dans les 30 min après l'heure passée : ignoré (seule une prolongation rouvre).
    assert.equal(end([e(190, 'closing.cleared')]), T(180));
    // Heure avancée dans les 30 min après qu'elle est passée : ignorée aussi.
    assert.equal(end([e(190, 'closing.set', { closingAt: T(170) })]), T(180), 'heure avancée après qu’elle est passée : ignorée');
    // « Options par défaut » après le dernier titre, avant l'heure : réglages remis, l'heure de la soirée reste.
    const reset = [e(150, 'closing.cleared', { reason: 'settings-reset' })];
    assert.equal(end(reset), T(180));
    assert.equal(end(reset, { live: true, now: T(200) }), T(180));
    // Puis on rechante : plus d'heure de fermeture, comme pour le serveur.
    assert.equal(end([...reset, e(160, 'stage.started', { queueId: 2, source: 'native', title: 'Encore' }),
      e(164, 'stage.ended', { queueId: 2, playedSec: 240 })]), null);
    // Heure déjà passée réglée par erreur, corrigée une minute après : la correction compte.
    assert.equal(end([e(150, 'closing.set', { closingAt: T(30) }), e(151, 'closing.set', { closingAt: T(200) })]), T(200));
    // Prolongation notée juste avant l'arrêt du PC (dernier événement) : elle compte, et
    // l'arrêt du PC finit la soirée (à l'arrêt, pas à l'ancienne heure).
    assert.equal(end([e(185, 'closing.set', { closingAt: T(195) }), e(900, 'app.started', { restored: true, offlineMs: 715 * 60000 })]), T(185));
    // Ancien journal (aucun réglage noté) : la dernière fermeture atteinte.
    const old = [...base().filter(ev => ev.ev !== 'closing.set'), e(150, 'closing.reached', { closingAt: T(150) }), e(900, 'evening.closed', { by: 'staff-reset' })];
    assert.equal(computeStats({ meta: { startedAt: T(0), endedAt: T(900) }, events: old }).evening.closedAt, T(150));
  });

  test('en direct : redémarrage du PC en milieu de soirée, puis on rechante : la soirée reste en cours', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(20, 'closing.set', { closingAt: T(300) }),
      e(30, 'stage.started', { queueId: 1, source: 'native', title: 'Avant' }),
      e(34, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(80, 'app.started', { restored: true, offlineMs: 40 * 60000 }),
      e(90, 'stage.started', { queueId: 2, source: 'native', title: 'Après' }),
      e(94, 'stage.ended', { queueId: 2, playedSec: 240 }),
    ];
    assert.equal(computeStats({ meta: { startedAt: T(0) }, events, now: T(100), live: true }).evening.closedAt, null);
  });

  test('en direct, dernier titre encore sur scène après l’heure de fermeture : karaoké « en cours », pas une fin qui avance', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(20, 'closing.set', { closingAt: T(60) }),
      e(58, 'stage.started', { queueId: 1, source: 'native', title: 'Dernier', durationSec: 300 }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0) }, events, now: T(61), live: true });
    assert.equal(stats.evening.closedAt, null);
    // Titre fini : la fin du karaoké est connue.
    const after = computeStats({ meta: { startedAt: T(0) }, events: [...events, e(63, 'stage.ended', { queueId: 1, playedSec: 300 })], now: T(70), live: true });
    assert.equal(after.evening.closedAt, T(63));
  });

  test('en direct : KaraFun coupé ou PC éteint pendant le dernier titre, fin jamais notée : même fin qu’une fois la soirée close', () => {
    const e = evening();
    const start = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(20, 'closing.set', { closingAt: T(200) }),
      e(195, 'stage.started', { queueId: 2, source: 'native', title: 'Dernier', durationSec: 240 }),
    ];
    const live = (extra, now) => computeStats({ meta: { startedAt: T(0) }, events: [...start, ...extra], now: T(now), live: true });
    const archived = (extra, at) => computeStats({ meta: { startedAt: T(0), endedAt: T(at) },
      events: [...start, ...extra, e(at, 'evening.closed', { by: 'staff-reset' })] }).evening.closedAt;
    // KaraFun quitté pendant le titre, jamais revenu : la coupure ferme la soirée.
    const quit = [e(196, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' })];
    assert.equal(live(quit, 210).evening.closedAt, null, 'coupure de 14 min : le titre est peut-être encore sur scène');
    const after = live(quit, 230);
    assert.equal(after.evening.closedAt, T(196));
    assert.equal(after.timeline.stages.at(-1).ongoing, false, 'plus « en cours » le lendemain');
    assert.equal(archived(quit, 900), T(196));
    // PC éteint pendant le titre, rallumé le lendemain matin.
    const pcOff = [e(900, 'app.started', { restored: true, offlineMs: 705 * 60000 }),
      e(900, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }), e(901, 'karaoke.phase', { phase: 'silent', blocker: 'empty' })];
    assert.equal(live(pcOff, 910).evening.closedAt, T(195));
    assert.equal(archived(pcOff, 1000), T(195));
    // Application redémarrée 9 min pendant le titre, plus rien sur scène au retour : titre fini.
    const restart = [e(205, 'app.started', { restored: true, offlineMs: 9 * 60000 })];
    assert.equal(live(restart, 207).evening.closedAt, T(200));
    assert.equal(live(restart, 207).timeline.stages.at(-1).playedSec, 240, 'plus « en cours » : fin estimée à sa durée');
    // Arrêt compté depuis le dernier événement noté, ici le début du titre.
    assert.equal(live([e(205, 'app.started', { restored: true, offlineMs: 10 * 60000 })], 207).evening.closedAt, T(200));
    assert.equal(archived(restart, 300), T(200));
    // Même redémarrage, titre retrouvé sur scène au retour : encore en cours.
    const back = live([...restart, e(205, 'stage.started', { queueId: 2, source: 'native', title: 'Dernier', durationSec: 240 })], 207);
    assert.equal(back.evening.closedAt, null);
    assert.equal(back.timeline.stages.at(-1).ongoing, true);
  });

  test('en direct le lendemain matin, fermeture atteinte et PC éteint avant l’heure : même fin qu’une fois la soirée close', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(150, 'closing.set', { closingAt: T(200) }),
      e(180, 'stage.started', { queueId: 2, source: 'native', title: 'Dernier' }),
      e(184, 'stage.ended', { queueId: 2, playedSec: 240 }),
      e(188, 'closing.reached', { closingAt: T(200) }),
      e(900, 'app.started', { restored: true, offlineMs: 710 * 60000 }),
      // « Options par défaut » le matin : l'heure de fermeture est retirée.
      e(910, 'closing.cleared'),
    ];
    const stats = computeStats({ meta: { startedAt: T(0) }, events, now: T(920), live: true });
    assert.equal(stats.evening.closedAt, T(190));
    assert.ok(!insights(stats).some(item => /redémarré/.test(item.text)), 'pas de redémarrage annoncé le lendemain');
  });

  test('demande : un titre choisi avant la connexion de KaraFun compte depuis la connexion', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(15, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Un' }),
      e(60, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(90, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], ownerId: 'pA', source: 'queue' }),
      e(94, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(100, 'evening.closed', { by: 'staff-reset' }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(100) }, events });
    assert.equal(stats.evening.openedAt, T(60));
    assert.equal(singerOf(stats, 'pA').demandSec, (90 - 60) * 60, 'demande bornée à la soirée du karaoké');
    const stage = stats.timeline.stages.find(st => st.entryId === 'a1');
    assert.equal(stage.waitSec, (90 - 60) * 60, 'attente comptée depuis la connexion de KaraFun');
    assert.equal(stage.requestDelaySec, (90 - 60) * 60);
  });

  test('KaraFun coupé pendant le dernier titre, sans heure de fermeture : la coupure ferme la soirée', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(20, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Un' }),
      e(30, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], ownerId: 'pA', source: 'queue', durationSec: 240 }),
      e(31, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      ...Array.from({ length: 40 }, (_, k) => e(40 + k * 25, 'person.seen', { personId: 'pA' })),
      e(1100, 'evening.closed', { by: 'staff-reset' }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(1100) }, events });
    assert.equal(stats.evening.closedAt, T(31));
    assert.ok(singerOf(stats, 'pA').presenceSec <= (31 - 10) * 60, `présence : ${singerOf(stats, 'pA').presenceSec} s`);
  });

  test('KaraFun coupé quelques secondes pendant le dernier titre puis reconnecté : la soirée finit à la vraie déconnexion', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(20, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Un' }),
      e(30, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], ownerId: 'pA', source: 'queue', durationSec: 240 }),
      e(31, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(31.1, 'karaoke.phase', { phase: 'singing', blocker: null }),
      e(34, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(34, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      ...Array.from({ length: 6 }, (_, k) => e(40 + k * 10, 'person.seen', { personId: 'pA' })),
      e(95, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(200, 'evening.closed', { by: 'staff-reset' }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(200) }, events });
    assert.equal(stats.evening.closedAt, T(95), 'la déconnexion définitive ferme la soirée');
  });

  test('KaraFun coupé après le dernier titre, reconnecté le lendemain avant la remise à zéro : la soirée finit à la coupure', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(60, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(195, 'stage.started', { queueId: 2, source: 'native', title: 'Dernier' }),
      e(205, 'stage.ended', { queueId: 2, playedSec: 600 }),
      e(210, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      ...Array.from({ length: 50 }, (_, k) => e(220 + k * 15, 'person.seen', { personId: 'pA' })),
      e(900, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(1000, 'evening.closed', { by: 'staff-reset' }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(1000) }, events });
    assert.equal(stats.evening.closedAt, T(210));
    assert.equal(singerOf(stats, 'pA').presenceSec, (210 - 60) * 60);
  });

  test('application arrêtée après le dernier titre, relancée le lendemain avec KaraFun : la soirée finit à l’arrêt', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(195, 'stage.started', { queueId: 2, source: 'native', title: 'Dernier' }),
      e(205, 'stage.ended', { queueId: 2, playedSec: 600 }),
      // PC du bar éteint à 210, rallumé le lendemain à 900 : KaraFun revient aussitôt.
      e(900, 'app.started', { restored: true, offlineMs: 690 * 60000 }),
      e(900, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(901, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      ...Array.from({ length: 5 }, (_, k) => e(905 + k * 15, 'person.seen', { personId: 'pA' })),
      e(1000, 'evening.closed', { by: 'staff-reset' }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(1000) }, events });
    assert.equal(stats.evening.closedAt, T(210), 'l’arrêt de l’application ferme la soirée');
    assert.equal(singerOf(stats, 'pA').presenceSec, (210 - 10) * 60, 'pas de présence le lendemain');
    // L'arrêt de la nuit n'est pas un incident de la soirée.
    assert.deepEqual([stats.evening.restarts, stats.evening.offlineSec], [0, 0]);
    assert.ok(!insights(stats).some(item => item.id === 'restarts' || /redémarré/.test(item.text)));
    // Arrêt bref (20 min) : la soirée continue.
    const brief = events.map(ev => ev.ev === 'app.started' && ev.offlineMs ? { ...ev, t: T(230), offlineMs: 20 * 60000 } : ev);
    assert.equal(computeStats({ meta: { startedAt: T(0), endedAt: T(1000) }, events: brief }).evening.closedAt, null);
  });

  test('arrêt de l’application : PC éteint pendant le dernier titre ferme la soirée, un redémarrage en milieu de soirée non', () => {
    const e = evening();
    // Rien n'est noté après le début du dernier titre : l'arrêt commence à cet instant.
    const lastSong = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(195, 'stage.started', { queueId: 2, source: 'native', title: 'Dernier' }),
      e(900, 'app.started', { restored: true, offlineMs: 705 * 60000 }),
      e(900, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(901, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(1000, 'evening.closed', { by: 'staff-reset' }),
    ];
    assert.equal(computeStats({ meta: { startedAt: T(0), endedAt: T(1000) }, events: lastSong }).evening.closedAt, T(195));
    // PC redémarré 40 min en milieu de soirée, puis on rechante : la soirée continue.
    const reboot = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(30, 'stage.started', { queueId: 1, source: 'native', title: 'Avant' }),
      e(34, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(80, 'app.started', { restored: true, offlineMs: 40 * 60000 }),
      e(90, 'stage.started', { queueId: 2, source: 'native', title: 'Après' }),
      e(94, 'stage.ended', { queueId: 2, playedSec: 240 }),
      e(200, 'evening.closed', { by: 'staff-reset' }),
    ];
    assert.equal(computeStats({ meta: { startedAt: T(0), endedAt: T(200) }, events: reboot }).evening.closedAt, null);
  });

  test('présence entièrement avant la connexion de KaraFun : rien de compté, heure de départ réelle gardée', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(20, 'person.left', { personId: 'pA', by: 'self', songsDropped: 0 }),
      e(60, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(100, 'evening.closed', { by: 'staff-reset' }),
    ];
    const pA = singerOf(computeStats({ meta: { startedAt: T(0), endedAt: T(100) }, events }), 'pA');
    assert.deepEqual([pA.presenceSec, pA.leftAt, pA.rawLeftAt, pA.explicitLeft], [0, null, T(20), true]);
  });

  test('karaoké seulement : Spotify avant la connexion de KaraFun, demande après la fermeture, « Options par défaut » avant tout titre', () => {
    const e = evening();
    const start = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
    ];
    // Spotify lancé par le bar l'après-midi, coupé au premier titre : seul le silence du karaoké compte.
    const spotify = [...start,
      e(0, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(10, 'spotify', { action: 'resume', result: 'done', trigger: 'staff' }),
      e(60, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(70, 'spotify', { action: 'pause', result: 'done', trigger: 'auto' }),
      e(70, 'stage.started', { queueId: 1, source: 'native', title: 'Premier' }),
      e(74, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(100, 'evening.closed', { by: 'staff-reset' }),
    ];
    const g = computeStats({ meta: { startedAt: T(0), endedAt: T(100) }, events: spotify }).global;
    assert.deepEqual([g.spotify.silences, g.spotify.silenceSec], [1, 10 * 60]);
    // Demandes après la fermeture (arrivée tardive pB, ou pD présente toute la
    // soirée) : pas un passage manqué de la rotation, hors de l'équité.
    const late = [...start,
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(5, 'closing.set', { closingAt: T(60) }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(12, 'person.joined', { personId: 'pD', tableId: '4' }),
      e(20, 'person.joined', { personId: 'pC', tableId: '3' }),
      e(21, 'song.requested', { personId: 'pC', entryId: 'c1', title: 'Jamais chanté' }),
      e(22, 'person.joined', { personId: 'pE', tableId: '5' }),
      e(23, 'song.requested', { personId: 'pE', entryId: 'e1', title: 'Parti avant' }),
      e(25, 'person.left', { personId: 'pE', by: 'self', songsDropped: 1 }),
      e(30, 'stage.started', { queueId: 1, source: 'native', title: 'Dernier' }),
      e(34, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(50, 'person.seen', { personId: 'pD' }),
      e(70, 'song.requested', { personId: 'pD', entryId: 'd1', title: 'Après l’heure' }),
      e(80, 'person.joined', { personId: 'pB', tableId: '2' }),
      e(81, 'song.requested', { personId: 'pB', entryId: 'b1', title: 'Trop tard' }),
      e(82, 'person.left', { personId: 'pB', by: 'self', songsDropped: 1 }),
      e(200, 'evening.closed', { by: 'staff-reset' }),
    ];
    const after = computeStats({ meta: { startedAt: T(0), endedAt: T(200) }, events: late });
    assert.equal(after.evening.closedAt, T(60));
    assert.equal(singerOf(after, 'pB').presenceSec, 0);
    assert.ok(singerOf(after, 'pD').presenceSec > 0, 'pD présente pendant le karaoké');
    assert.deepEqual(['pC', 'pE', 'pD', 'pB'].map(id => singerOf(after, id).askedInKaraoke), [true, true, false, false]);
    assert.equal(after.fairness.neverSang, 2, 'pC et pE, un titre en attente pendant le karaoké');
    assert.equal(after.fairness.neverSangLeft, 1, 'pE ; pas pB, parti après la fermeture');
    assert.equal(after.global.singers, 2);
    assert.equal(singerOf(after, 'pD').expectedTurns, null, 'pD hors de la part attendue');
    assert.equal(after.fairness.n, 1, 'pD hors de l’indice de Jain');
    assert.equal(after.tables.find(tb => tb.id === '4').singers, 0, 'pas de chanteur à la table de pD');
    // Demande après l'heure pendant le dernier titre, qui la dépasse : hors de l'équité aussi.
    const pastHour = [...start,
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(5, 'closing.set', { closingAt: T(60) }),
      e(10, 'person.joined', { personId: 'pR', tableId: '1' }),
      e(50, 'person.seen', { personId: 'pR' }),
      e(58, 'stage.started', { queueId: 1, source: 'native', title: 'Dernier' }),
      e(61, 'song.requested', { personId: 'pR', entryId: 'r1', title: 'Pendant le dernier' }),
      e(64, 'stage.ended', { queueId: 1, playedSec: 360 }),
      e(200, 'evening.closed', { by: 'staff-reset' }),
    ];
    const lastLong = computeStats({ meta: { startedAt: T(0), endedAt: T(200) }, events: pastHour });
    assert.equal(lastLong.evening.closedAt, T(64));
    assert.deepEqual([singerOf(lastLong, 'pR').askedInKaraoke, singerOf(lastLong, 'pR').demandSec], [false, 0]);
    assert.equal(lastLong.fairness.neverSang, 0);
    // Titre demandé l'après-midi par une personne partie avant le karaoké, retiré le soir : pas « sans chanter ».
    const ghost = [...start,
      e(0, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(10, 'person.joined', { personId: 'pG', tableId: '9' }),
      e(11, 'song.requested', { personId: 'pG', entryId: 'g1', title: 'Fantôme' }),
      e(300, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(361, 'song.removed', { personId: 'pG', entryId: 'g1', by: 'presence' }),
      e(900, 'evening.closed', { by: 'staff-reset' }),
    ];
    const absent = computeStats({ meta: { startedAt: T(0), endedAt: T(900) }, events: ghost });
    assert.equal(singerOf(absent, 'pG').presenceSec, 0);
    assert.equal(absent.fairness.neverSang, 0);
    assert.deepEqual([singerOf(absent, 'pG').askedInKaraoke, singerOf(absent, 'pG').demandSec, absent.global.singers], [false, 0, 0],
      'titre en attente pendant son absence : ni demande, ni chanteur');
    // Heure de fermeture déjà passée réglée après coup : les demandes comptent jusqu'au réglage.
    const pastSet = [...start,
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pL', tableId: '1' }),
      e(62, 'song.requested', { personId: 'pL', entryId: 'l1', title: 'Avant le réglage' }),
      e(70, 'person.seen', { personId: 'pL' }),
      e(78, 'stage.started', { queueId: 1, source: 'native', title: 'Dernier' }),
      e(80, 'closing.set', { closingAt: T(60) }),
      e(82, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(200, 'evening.closed', { by: 'staff-reset' }),
    ];
    const setLate = computeStats({ meta: { startedAt: T(0), endedAt: T(200) }, events: pastSet });
    assert.equal(singerOf(setLate, 'pL').askedInKaraoke, true, 'titre en attente avant le réglage');
    assert.equal(setLate.fairness.neverSang, 1);
    // Même réglage entre deux titres (rien sur scène) : le karaoké finit au réglage, pas à l'heure tapée.
    const between = pastSet.filter(ev => !/^stage\./.test(ev.ev)).concat([
      e(70, 'stage.started', { queueId: 1, source: 'native', title: 'Dernier' }), e(74, 'stage.ended', { queueId: 1, playedSec: 240 }),
    ]).map(ev => ev.ev === 'song.requested' ? { ...ev, t: T(76) } : ev).sort((a, b) => a.t - b.t);
    const setBetween = computeStats({ meta: { startedAt: T(0), endedAt: T(200) }, events: between });
    assert.equal(setBetween.evening.closedAt, T(80));
    assert.equal(singerOf(setBetween, 'pL').askedInKaraoke, true);
    // Heure déjà passée réglée avant le début du dernier titre (heure en vigueur) : demandes comptées jusqu'au réglage.
    const inForce = [...start,
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pM', tableId: '1' }),
      e(70, 'song.requested', { personId: 'pM', entryId: 'm1', title: 'Juste avant' }),
      e(75, 'closing.set', { closingAt: T(60) }),
      e(76, 'person.seen', { personId: 'pM' }),
      e(78, 'stage.started', { queueId: 1, source: 'native', title: 'Dernier' }),
      e(82, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(200, 'evening.closed', { by: 'staff-reset' }),
    ];
    assert.equal(singerOf(computeStats({ meta: { startedAt: T(0), endedAt: T(200) }, events: inForce }), 'pM').askedInKaraoke, true);
    // Attente pendant un arrêt de l'application : retirée, comme la présence.
    const reboot = [...start,
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pN', tableId: '1' }),
      e(20, 'song.requested', { personId: 'pN', entryId: 'n1', title: 'Attend' }),
      e(25, 'person.seen', { personId: 'pN' }),
      e(50, 'app.started', { restored: true, offlineMs: 20 * 60000 }),
      e(55, 'person.seen', { personId: 'pN' }),
      e(60, 'stage.started', { queueId: 1, entryId: 'n1', ids: ['pN'], source: 'queue', title: 'Attend', durationSec: 240 }),
      e(64, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(200, 'evening.closed', { by: 'staff-reset' }),
    ];
    const pN = singerOf(computeStats({ meta: { startedAt: T(0), endedAt: T(200) }, events: reboot }), 'pN');
    assert.equal(pN.demandSec, 20 * 60, '40 min d’attente moins 20 min d’arrêt');
    // Titre encore en attente à la fermeture, PC éteint la nuit : l'arrêt après la fermeture ne retire rien.
    const overnight = [...start,
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(5, 'closing.set', { closingAt: T(120) }),
      e(90, 'stage.started', { queueId: 1, source: 'native', title: 'Dernier' }),
      e(94, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(95, 'person.joined', { personId: 'pO', tableId: '2' }),
      e(100, 'song.requested', { personId: 'pO', entryId: 'o1', title: 'Trop tard' }),
      e(110, 'person.seen', { personId: 'pO' }),
      e(130, 'queue.sample', { ready: 1 }),
      e(700, 'app.started', { restored: true, offlineMs: 570 * 60000 }),
      e(800, 'evening.closed', { by: 'staff-reset' }),
    ];
    const pO = singerOf(computeStats({ meta: { startedAt: T(0), endedAt: T(800) }, events: overnight }), 'pO');
    assert.deepEqual([pO.demandSec, pO.askedInKaraoke], [20 * 60, true]);
    // « Options par défaut » avant tout titre : l'heure est retirée, comme un retrait du bar.
    const noStage = reason => computeStats({ meta: { startedAt: T(0) }, now: T(200), live: true, events: [...start,
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(20, 'closing.set', { closingAt: T(180) }),
      e(30, 'closing.cleared', reason ? { reason } : {}),
    ] }).evening.closedAt;
    assert.equal(noStage(null), null);
    assert.equal(noStage('settings-reset'), null);
  });

  test('équité : une demande après la fermeture ne compte ni dans l’indice, ni dans le classement, ni dans les tables', () => {
    const e = evening();
    const events = [e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }), e(1, 'closing.set', { closingAt: T(120) }),
      ...['pA', 'pB', 'pC', 'pD'].map((id, k) => e(2, 'person.joined', { personId: id, tableId: String(k + 1) })),
      ...[0, 1, 2].map(k => e(3, 'song.requested', { personId: 'pA', entryId: `a${k}`, title: `A${k}` })),
      e(3, 'song.requested', { personId: 'pB', entryId: 'b0', title: 'B' }), e(3, 'song.requested', { personId: 'pC', entryId: 'c0', title: 'C' })];
    let queueId = 0;
    for (const [m, id, entryId] of [[10, 'pA', 'a0'], [20, 'pB', 'b0'], [30, 'pA', 'a1'], [40, 'pC', 'c0'], [50, 'pA', 'a2']]) {
      events.push(e(m, 'stage.started', { queueId: ++queueId, entryId, ids: [id], source: 'queue', title: entryId }),
        e(m + 4, 'stage.ended', { queueId, playedSec: 240 }));
    }
    for (let m = 15; m <= 115; m += 10) for (const id of ['pA', 'pB', 'pC', 'pD']) events.push(e(m, 'person.seen', { personId: id }));
    events.push(e(125, 'song.requested', { personId: 'pD', entryId: 'd0', title: 'Après l’heure' }), e(300, 'evening.closed', { by: 'staff-reset' }));
    const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: events.sort((a, b) => a.t - b.t) });
    assert.equal(stats.fairness.n, 3);
    assert.equal(stats.tables.find(tb => tb.id === '4').singers, 0);
    const text = insights(stats, { nameOf: id => ({ pA: 'Alice', pB: 'Bruno', pC: 'Chloé', pD: 'Dora' })[id] }).map(i => i.text).join('\n');
    assert.match(text, /Rotation inégale/);
    assert.doesNotMatch(text, /Dora/);
  });

  test('ouverture : soirée suivant « Supprimer toutes les tables » fait KaraFun connecté, la nuit ne compte pas', () => {
    const e = evening();
    // Remise à zéro à 0, KaraFun encore connecté ; le soir, connexion à 980, premier titre à 1000.
    const evening2 = night => [
      e(0, 'evening.started', { rules: {} }), e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      ...night,
      e(980, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(990, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(991, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Premier' }),
      e(1000, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], source: 'queue', title: 'Premier', durationSec: 240 }),
      e(1004, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(1200, 'evening.closed', { by: 'staff-reset' }),
    ];
    const opened = night => computeStats({ meta: { startedAt: T(0), endedAt: T(1200) }, events: evening2(night) }).evening.openedAt;
    // PC éteint la nuit (dernier événement à 30), relancé à 700 avant KaraFun.
    assert.equal(opened([e(30, 'queue.sample', { ready: 0 }), e(700, 'app.started', { restored: true, offlineMs: 670 * 60000 }),
      e(700, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' })]), T(980));
    // PC resté allumé, KaraFun quitté la nuit.
    assert.equal(opened([e(40, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' })]), T(980));
    // PC éteint la nuit, essai de l'après-midi, KaraFun refermé : la dernière interruption compte.
    assert.equal(opened([e(30, 'queue.sample', { ready: 0 }), e(700, 'app.started', { restored: true, offlineMs: 670 * 60000 }),
      e(720, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }), e(800, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' })]), T(980));
    // Titre d'essai du bar retiré avant que KaraFun ne soit fermé : la coupure sépare encore la soirée.
    assert.equal(opened([e(20, 'person.joined', { personId: 'pBar', tableId: '9' }),
      e(21, 'song.requested', { personId: 'pBar', entryId: 'essai', title: 'Essai' }),
      e(23, 'song.removed', { personId: 'pBar', entryId: 'essai', by: 'staff' }),
      e(40, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' })]), T(980));
    // Tout resté allumé et connecté : début du journal, comme avant.
    assert.equal(opened([]), T(0));
    // Interruptions courtes (moins de 30 min) : rien ne sépare la soirée.
    assert.equal(opened([e(30, 'queue.sample', { ready: 0 }), e(50, 'app.started', { restored: true, offlineMs: 20 * 60000 })]), T(0));
    assert.equal(opened([e(40, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }), e(60, 'karaoke.phase', { phase: 'silent', blocker: 'empty' })]), T(0));
    // Coupure de 40 min une fois un titre demandé : l'ouverture ne bouge pas (attente gardée).
    const queued = before => computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: [
      e(0, 'evening.started', { rules: {} }), e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(before ? 11 : 65, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Premier' }),
      e(20, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }), e(60, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(70, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], source: 'queue', title: 'Premier', durationSec: 240 }),
      e(74, 'stage.ended', { queueId: 1, playedSec: 240 }), e(300, 'evening.closed', { by: 'staff-reset' }),
    ].sort((a, b) => a.t - b.t) }).evening.openedAt;
    assert.equal(queued(true), T(0), 'titre demandé avant la coupure');
    assert.equal(queued(false), T(60), 'titre demandé après la coupure : connexion qui la suit');
    // PC redémarré 40 min une fois un titre demandé : idem.
    const rebooted = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: [
      e(0, 'evening.started', { rules: {} }), e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(11, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Premier' }),
      e(20, 'queue.sample', { ready: 1 }), e(60, 'app.started', { restored: true, offlineMs: 40 * 60000 }),
      e(60, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(70, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], source: 'queue', title: 'Premier', durationSec: 240 }),
      e(74, 'stage.ended', { queueId: 1, playedSec: 240 }), e(300, 'evening.closed', { by: 'staff-reset' }),
    ] });
    assert.equal(rebooted.evening.openedAt, T(0));
    // Titres joués sans demande (KaraFun) avant et après une coupure : une coupure après le premier titre ne déplace pas l’ouverture.
    const native = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: [
      e(0, 'evening.started', { rules: {} }), e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(30, 'stage.started', { queueId: 1, source: 'native', title: 'Un' }), e(34, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(50, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }), e(90, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(100, 'stage.started', { queueId: 2, source: 'native', title: 'Deux' }), e(104, 'stage.ended', { queueId: 2, playedSec: 240 }),
      e(300, 'evening.closed', { by: 'staff-reset' }),
    ] });
    assert.equal(native.evening.openedAt, T(0));
    // Titre encore en attente à la fin du journal (jamais chanté ni retiré) : la coupure ne déplace pas l'ouverture.
    assert.equal(opened([e(20, 'person.joined', { personId: 'pB', tableId: '2' }),
      e(21, 'song.requested', { personId: 'pB', entryId: 'b1', title: 'Jamais chanté' }),
      e(40, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' })]), T(0));
    // File vidée juste avant d'éteindre le PC (dernier événement), KaraFun reconnecté au redémarrage : plus rien
    // n'attendait, la nuit sépare la soirée.
    assert.equal(opened([e(20, 'person.joined', { personId: 'pB', tableId: '2' }),
      e(21, 'song.requested', { personId: 'pB', entryId: 'b1', title: 'Retiré' }),
      e(30, 'song.removed', { personId: 'pB', entryId: 'b1', by: 'staff' }),
      e(700, 'app.started', { restored: true, offlineMs: 670 * 60000 }),
      e(700, 'karaoke.phase', { phase: 'silent', blocker: 'empty' })]), T(700));
    // Journal commencé KaraFun pas encore connecté, connexion 15 min après, avant toute demande : ouverture à la connexion.
    const lateLink = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }), e(15, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(20, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(21, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Premier' }),
      e(30, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], source: 'queue', title: 'Premier', durationSec: 240 }),
      e(34, 'stage.ended', { queueId: 1, playedSec: 240 }), e(300, 'evening.closed', { by: 'staff-reset' }),
    ] });
    assert.equal(lateLink.evening.openedAt, T(15));
    // KaraFun connecté en plein titre : stage.started est noté avant la phase ; l'ouverture est au plus tard le premier titre.
    const midSong = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(30, 'stage.started', { queueId: 1, source: 'native', title: 'Déjà lancé' }),
      e(30.5, 'karaoke.phase', { phase: 'singing', blocker: null }),
      e(34, 'stage.ended', { queueId: 1, playedSec: 240 }), e(300, 'evening.closed', { by: 'staff-reset' }),
    ] });
    assert.equal(midSong.evening.openedAt, T(30));
    // Titre demandé après la coupure de la nuit et jamais chanté : l'ouverture reste à la connexion,
    // soirée close comme en direct.
    const byTime = list => list.map((x, i) => [x, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(([x]) => x);
    const night = [e(30, 'queue.sample', { ready: 0 }), e(700, 'app.started', { restored: true, offlineMs: 670 * 60000 }),
      e(700, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' })];
    const late = [e(985, 'person.joined', { personId: 'pB', tableId: '2' }),
      e(986, 'song.requested', { personId: 'pB', entryId: 'b1', title: 'Jamais chanté' })];
    const nightLate = byTime(evening2([...night, ...late]));
    assert.equal(computeStats({ meta: { startedAt: T(0), endedAt: T(1200) }, events: nightLate }).evening.openedAt, T(980));
    assert.equal(computeStats({ meta: { startedAt: T(0) }, events: nightLate.filter(x => x.ev !== 'evening.closed'),
      now: T(1100), live: true }).evening.openedAt, T(980), 'en direct aussi');
    // Titre demandé juste avant l'arrêt du PC (dernier événement), chanté après le redémarrage : il attendait, la
    // soirée n'est pas coupée.
    const askedLast = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: [
      e(0, 'evening.started', { rules: {} }), e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(30, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Premier' }),
      e(70, 'app.started', { restored: true, offlineMs: 40 * 60000 }), e(70, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(80, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], source: 'queue', title: 'Premier', durationSec: 240 }),
      e(84, 'stage.ended', { queueId: 1, playedSec: 240 }), e(300, 'evening.closed', { by: 'staff-reset' }),
    ] });
    assert.equal(askedLast.evening.openedAt, T(0));
  });

  test('redémarrages : celui qui termine l’arrêt de la nuit n’en est pas un, une courte panne autour de l’heure de fermeture si', () => {
    const e = evening();
    // En direct, PC rallumé le soir, KaraFun pas encore connecté : l'ouverture est ce redémarrage.
    const live = computeStats({ meta: { startedAt: T(0) }, now: T(710), live: true, events: [
      e(0, 'evening.started', { rules: {} }), e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(30, 'queue.sample', { ready: 0 }), e(700, 'app.started', { restored: true, offlineMs: 670 * 60000 }),
      e(700, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
    ] });
    assert.equal(live.evening.openedAt, T(700));
    assert.deepEqual([live.evening.restarts, live.evening.offlineSec], [0, 0]);
    assert.ok(!insights(live).some(item => /redémarré/.test(item.text)));
    // Panne de 20 min commencée 5 min avant l'heure de fermeture : un redémarrage du karaoké, 5 min d'arrêt.
    const crash = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: [
      e(0, 'evening.started', { rules: {} }), e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }), e(20, 'closing.set', { closingAt: T(120) }),
      e(100, 'stage.started', { queueId: 1, source: 'native', title: 'Dernier' }), e(104, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(115, 'queue.sample', { ready: 0 }), e(135, 'app.started', { restored: true, offlineMs: 20 * 60000 }),
      e(300, 'evening.closed', { by: 'staff-reset' }),
    ] });
    assert.equal(crash.evening.closedAt, T(120));
    assert.deepEqual([crash.evening.restarts, crash.evening.offlineSec], [1, 300]);
    // Panne de 10 min pendant le karaoké, puis PC éteint la nuit et rallumé le lendemain matin : seule la panne compte.
    const morning = computeStats({ meta: { startedAt: T(0), endedAt: T(1000) }, events: [
      e(0, 'evening.started', { rules: {} }), e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }), e(20, 'closing.set', { closingAt: T(120) }),
      e(30, 'stage.started', { queueId: 1, source: 'native', title: 'Premier' }), e(34, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(60, 'queue.sample', { ready: 0 }), e(70, 'app.started', { restored: true, offlineMs: 10 * 60000 }),
      e(100, 'stage.started', { queueId: 2, source: 'native', title: 'Dernier' }), e(104, 'stage.ended', { queueId: 2, playedSec: 240 }),
      e(130, 'queue.sample', { ready: 0 }), e(900, 'app.started', { restored: true, offlineMs: 770 * 60000 }),
      e(1000, 'evening.closed', { by: 'staff-reset' }),
    ] });
    assert.deepEqual([morning.evening.restarts, morning.evening.offlineSec], [1, 600]);
    assert.ok(insights(morning).some(item => /redémarré 1 fois/.test(item.text)), insights(morning).map(item => item.text).join(' | '));
  });

  test('KaraFun quitté pendant un titre puis rouvert bien plus tard : le passage finit à la coupure', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(30, 'stage.started', { queueId: 1, source: 'native', title: 'Avant', durationSec: 240 }),
      e(34, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(100, 'stage.started', { queueId: 2, source: 'native', title: 'Coupé', durationSec: 200 }),
      e(102, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      // KaraFun rouvert 48 min plus tard, application restée lancée : fin notée avec la coupure.
      e(150, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(150, 'stage.ended', { queueId: 2, playedSec: 50 * 60 }),
      e(300, 'evening.closed', { by: 'staff-reset' }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events });
    const cut = stats.timeline.stages.at(-1);
    assert.deepEqual([cut.end, cut.endKnown], [T(102), false]);
    assert.equal(stats.evening.closedAt, T(102));
    assert.equal(stats.global.avgSongSec, 240, 'durée moyenne sans la coupure');
    // Coupure brève (retour en 10 min) : la fin notée reste.
    const blip = events.map(ev => ev.ev === 'karaoke.phase' && ev.t === T(150) ? { ...ev, t: T(112) } : ev)
      .map(ev => ev.ev === 'stage.ended' && ev.queueId === 2 ? { ...ev, t: T(113), playedSec: 13 * 60 } : ev);
    const kept = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: blip }).timeline.stages.at(-1);
    assert.deepEqual([kept.end, kept.endKnown], [T(113), true]);
    // En milieu de soirée, puis on rechante : même fin à la coupure, temps mort « offline », soirée ouverte.
    const middle = [...events.filter(ev => ev.ev !== 'evening.closed'),
      e(155, 'stage.started', { queueId: 3, source: 'native', title: 'Après', durationSec: 240 }),
      e(155, 'karaoke.phase', { phase: 'singing', blocker: null }),
      e(159, 'stage.ended', { queueId: 3, playedSec: 240 }),
      e(159, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(300, 'evening.closed', { by: 'staff-reset' }),
    ];
    const mid = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: middle });
    const midCut = mid.timeline.stages[1];
    assert.deepEqual([midCut.end, midCut.endKnown], [T(102), false]);
    assert.equal(mid.evening.closedAt, null, 'coupure en milieu de soirée : le karaoké continue');
    assert.equal(mid.global.deadCauses.find(row => row.cause === 'offline')?.sec, 48 * 60, 'la coupure est un temps mort');
    // Titre retrouvé sur scène après la coupure : même règle que la fin du karaoké, le passage finit à la coupure.
    const renoted = [...events.filter(ev => ev.ev !== 'stage.ended' || ev.queueId !== 2).filter(ev => ev.ev !== 'evening.closed'),
      e(151, 'stage.started', { queueId: 2, source: 'native', title: 'Coupé', durationSec: 200 }),
      e(153, 'stage.ended', { queueId: 2, playedSec: 120 }),
      e(300, 'evening.closed', { by: 'staff-reset' }),
    ];
    const resumed = computeStats({ meta: { startedAt: T(0), endedAt: T(300) }, events: renoted });
    const back = resumed.timeline.stages.at(-1);
    assert.deepEqual([back.end, back.endKnown, resumed.evening.closedAt], [T(102), false, T(102)]);
  });

  test('heure de fermeture réglée, PC éteint après le dernier titre et avant l’heure : la soirée finit à l’arrêt, sans redémarrage', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(150, 'closing.set', { closingAt: T(200) }),
      e(180, 'stage.started', { queueId: 2, source: 'native', title: 'Dernier' }),
      e(184, 'stage.ended', { queueId: 2, playedSec: 240 }),
      // Plus aucun titre ne tient avant 200 : fermeture notée en avance.
      e(188, 'closing.reached', { closingAt: T(200) }),
      e(900, 'app.started', { restored: true, offlineMs: 710 * 60000 }),
      e(1000, 'evening.closed', { by: 'staff-reset' }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(1000) }, events });
    assert.equal(stats.evening.closedAt, T(190));
    assert.deepEqual([stats.evening.restarts, stats.evening.offlineSec], [0, 0]);
    assert.ok(!insights(stats).some(item => /redémarré/.test(item.text)));
  });

  test('coupure de KaraFun après le dernier titre : 20 min ne ferme pas la soirée, 40 min la ferme', () => {
    const e = evening();
    const cut = minutes => [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(30, 'stage.started', { queueId: 1, source: 'native', title: 'Dernier' }),
      e(34, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(40, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(40 + minutes, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(200, 'evening.closed', { by: 'staff-reset' }),
    ];
    const closedAt = minutes => computeStats({ meta: { startedAt: T(0), endedAt: T(200) }, events: cut(minutes) }).evening.closedAt;
    assert.equal(closedAt(20), null, 'coupure brève : la soirée continue jusqu’à la fin du journal');
    assert.equal(closedAt(40), T(40), 'coupure longue : la soirée finit à la coupure');
  });

  test('premier passage : compté depuis la connexion de KaraFun, pas depuis un titre choisi avant', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(15, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Un' }),
      e(60, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(90, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], ownerId: 'pA', source: 'queue' }),
      e(94, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(100, 'evening.closed', { by: 'staff-reset' }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(100) }, events });
    assert.equal(singerOf(stats, 'pA').firstTurnSec, (90 - 60) * 60);
    assert.equal(stats.global.firstTurnAvgSec, (90 - 60) * 60);
    // Essai retiré avant une coupure de la nuit, nouvelle demande le soir : compté depuis cette demande.
    const trial = computeStats({ meta: { startedAt: T(0), endedAt: T(1200) }, events: [
      e(0, 'evening.started', { rules: {} }), e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(20, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(21, 'song.requested', { personId: 'pA', entryId: 'essai', title: 'Essai' }),
      e(23, 'song.removed', { personId: 'pA', entryId: 'essai', by: 'staff' }),
      e(40, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }), e(980, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(991, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Premier' }),
      e(1000, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], ownerId: 'pA', source: 'queue', title: 'Premier', durationSec: 240 }),
      e(1004, 'stage.ended', { queueId: 1, playedSec: 240 }), e(1200, 'evening.closed', { by: 'staff-reset' }),
    ] });
    assert.equal(trial.evening.openedAt, T(980));
    assert.equal(singerOf(trial, 'pA').firstTurnSec, (1000 - 991) * 60);
    const turn = rows => singerOf(computeStats({ meta: { startedAt: T(0), endedAt: T(1200) }, events: [
      e(0, 'evening.started', { rules: {} }), e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(20, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(40, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }), e(980, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      ...rows,
      e(1000, 'stage.started', { queueId: 1, entryId: 'a2', ids: ['pA'], ownerId: 'pA', source: 'queue', title: 'Chanté', durationSec: 240 }),
      e(1004, 'stage.ended', { queueId: 1, playedSec: 240 }), e(1200, 'evening.closed', { by: 'staff-reset' }),
    ].sort((a, b) => a.t - b.t) }), 'pA').firstTurnSec;
    // Deux demandes après l'ouverture : depuis la première, même retirée ensuite.
    assert.equal(turn([e(990, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Retiré' }),
      e(992, 'song.removed', { personId: 'pA', entryId: 'a1', by: 'self' }),
      e(995, 'song.requested', { personId: 'pA', entryId: 'a2', title: 'Chanté' })]), (1000 - 990) * 60);
    // Titre déjà en attente à la connexion, retiré après elle, puis un autre : depuis la connexion.
    assert.equal(turn([e(950, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Retiré' }),
      e(985, 'song.removed', { personId: 'pA', entryId: 'a1', by: 'self' }),
      e(990, 'song.requested', { personId: 'pA', entryId: 'a2', title: 'Chanté' })]), (1000 - 980) * 60);
  });

  test('fermeture notée avant l’heure (plus aucun titre ne tient) : la soirée finit à l’heure annoncée', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }), e(0, 'app.started', { restored: false, offlineMs: 0 }),
      e(0, 'karaoke.phase', { phase: 'silent', blocker: 'empty' }),
      e(10, 'person.joined', { personId: 'pA', tableId: '1' }),
      e(20, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Un' }),
      e(30, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], ownerId: 'pA', source: 'queue' }),
      e(34, 'stage.ended', { queueId: 1, playedSec: 240 }),
      e(35, 'closing.set', { closingAt: T(60) }),
      e(52, 'closing.reached', { closingAt: T(60) }),
      e(58, 'person.seen', { personId: 'pA' }),
      e(200, 'evening.closed', { by: 'staff-reset' }),
    ];
    const stats = computeStats({ meta: { startedAt: T(0), endedAt: T(200) }, events });
    assert.equal(stats.evening.closedAt, T(60));
    assert.equal(singerOf(stats, 'pA').presenceSec, (60 - 10) * 60);
  });

  test('fermeture sans refus d’ajout : pas de « 0 ajout refusé »', () => {
    const e = evening();
    const events = [
      e(0, 'evening.started', { rules: {} }),
      e(1, 'closing.set', { closingAt: T(30) }),
      e(2, 'turn.unsent', { entryId: 'x', reason: 'pulled-closing' }),
    ];
    const stats = computeStats({ meta: { eveningId: 'e', startedAt: T(0), endedAt: T(40) }, events, now: T(40) });
    const text = insights(stats).map(item => item.text).join('\n');
    assert.match(text, /Fermeture : 1 titre retiré de KaraFun\./);
    assert.doesNotMatch(text, /ajout refusé/);
  });
}

// Soirée du 15 octobre : attente par titre comme la rotation (un passage en
// invitée ne la remet pas à zéro ; changer, remplacer ou remonter un titre ne
// la relance pas) et, à part, attente sans monter sur scène, invités compris.
test('attentes : par titre comme la rotation, et sans monter sur scène pour chaque personne', () => {
  const T = m => T0 + m * M;
  const events = [];
  const e = (minutes, ev, fields = {}) => events.push({ v: 1, seq: events.length + 1, t: T(minutes), ev, ...fields });
  const stage = (from, to, entryId, ids, queueId) => {
    e(from, 'stage.started', { queueId, entryId, ids, ownerId: ids[0], source: 'queue', title: entryId });
    e(to, 'stage.ended', { queueId, playedSec: (to - from) * 60 });
  };
  e(0, 'app.started', { restored: false, offlineMs: 0 });
  for (const [pid, tableId] of [['bea', '1'], ['ana', '1'], ['chris', '2'], ['leo', '2'],
    ['eva', '3'], ['fred', '4'], ['gus', '5'], ['hugo', '6']]) e(0, 'person.joined', { personId: pid, tableId });
  e(0, 'song.requested', { personId: 'bea', entryId: 'n1', title: 'n1', mode: 'append' });
  e(0, 'song.requested', { personId: 'bea', entryId: 'n2', title: 'n2', mode: 'append' });
  e(0, 'song.requested', { personId: 'ana', entryId: 'c1', title: 'c1', mode: 'append' });
  e(1, 'duo.invited', { personId: 'ana', entryId: 'c1', ownerId: 'ana', partnerId: 'bea', sameGroup: true });
  e(0, 'song.requested', { personId: 'chris', entryId: 'r1', title: 'r1', mode: 'append' });
  e(0, 'song.requested', { personId: 'chris', entryId: 'r2', title: 'r2', mode: 'append' });
  e(2, 'duo.invited', { personId: 'chris', entryId: 'r2', ownerId: 'chris', partnerId: 'leo', sameGroup: true });
  e(1, 'song.requested', { personId: 'eva', entryId: 's1', title: 's1', mode: 'append' });
  e(1, 'song.requested', { personId: 'eva', entryId: 's2', title: 's2', mode: 'append' });
  e(1, 'song.requested', { personId: 'fred', entryId: 'y1', title: 'y1', mode: 'append' });
  e(1, 'song.requested', { personId: 'gus', entryId: 'i1', title: 'i1', mode: 'append' });
  e(3, 'song.removed', { personId: 'gus', entryId: 'i1', by: 'self' });
  e(6, 'song.requested', { personId: 'hugo', entryId: 'l1', title: 'l1', mode: 'append' });
  e(6.5, 'song.removed', { personId: 'hugo', entryId: 'l1', by: 'self' });
  e(7, 'song.requested', { personId: 'hugo', entryId: 'l2', title: 'l2', mode: 'append' });
  stage(5, 9, 'n1', ['bea'], 1);
  stage(10, 14, 'r1', ['chris'], 2);
  e(12, 'song.requested', { personId: 'gus', entryId: 'i2', title: 'i2', mode: 'append' });
  stage(15, 19, 'c1', ['ana', 'bea'], 3);
  stage(20, 24, 'r2', ['chris', 'leo'], 4);
  stage(25, 29, 'i2', ['gus'], 5);
  stage(30, 34, 'n2', ['bea'], 6);
  stage(35, 39, 'l2', ['hugo'], 7);
  stage(40, 44, 's1', ['eva'], 8);
  e(41, 'song.requested', { personId: 'fred', entryId: 'y2', title: 'y2', mode: 'replace', replacedEntryIds: ['y1'] });
  stage(45, 49, 'y2', ['fred'], 9);
  e(50, 'song.requested', { personId: 'eva', entryId: 's3', title: 's3', mode: 'append' });
  e(50.5, 'song.reordered', { personId: 'eva', entryId: 's3', fromIndex: 1, toIndex: 0 });
  stage(60, 64, 's3', ['eva'], 10);
  const stats = computeStats({ meta: {}, events, now: T(70) });
  const wait = id => stats.timeline.stages.find(s => s.entryId === id).waitSec / 60;
  assert.equal(wait('n2'), 30 - 9, 'son passage en invitée (15-19) ne remet pas l’attente de son titre à zéro');
  assert.equal(wait('s3'), 60 - 44, 'titre remonté en tête : prête depuis la fin de son passage, un autre titre en liste');
  assert.equal(wait('y2'), 45 - 1, 'titre remplacé : l’attente continue');
  assert.equal(wait('l2'), 35 - 6 - 0.5, 'retiré puis rechoisi sans passage entre-temps : un échange, sans le temps sans titre (6,5 à 7)');
  assert.equal(wait('i2'), 25 - 12, 'retiré puis rechoisi après des passages : l’attente repart');
  const sansScene = id => singerOf(stats, id).stageWaits;
  assert.deepEqual(sansScene('bea'), { n: 3, guestN: 1, avgSec: (5 + 6 + 11) * 60 / 3, medianSec: 6 * 60, maxSec: 11 * 60 });
  assert.deepEqual(sansScene('leo'), { n: 1, guestN: 1, avgSec: 18 * 60, medianSec: 18 * 60, maxSec: 18 * 60 },
    'seulement invité : attend depuis le duo accepté');
  assert.equal(singerOf(stats, 'leo').waits.n, 0, 'aucun titre à lui');
  assert.equal(sansScene('ana').maxSec, 15 * 60);
});

// Attente par titre : coupures, temps sans titre, bornes à l'envoi, « Pas
// prêt », et plus longue attente traversée par des passages en invitée.
test('attentes : coupures, temps sans titre et « Pas prêt » comme la rotation', () => {
  const T = m => T0 + m * M;
  const scenario = build => {
    const events = [];
    const e = (minutes, ev, fields = {}) => events.push({ v: 1, seq: 0, t: T(minutes), ev, ...fields });
    const stage = (from, to, entryId, ids, queueId, sentAt) => {
      if (sentAt != null) e(sentAt, 'turn.sent', { entryId, ids, ownerId: ids[0], queueId });
      e(from, 'stage.started', { queueId, entryId, ids, ownerId: ids[0], source: 'queue', title: entryId });
      e(to, 'stage.ended', { queueId, playedSec: (to - from) * 60 });
    };
    e(0, 'app.started', { restored: false, offlineMs: 0 });
    for (const pid of ['p', 'q', 'g']) e(0, 'person.joined', { personId: pid, tableId: pid });
    build(e, stage);
    events.sort((a, b) => a.t - b.t).forEach((x, i) => { x.seq = i + 1; });
    return computeStats({ meta: {}, events, now: T(200) });
  };
  const waitOf = (stats, id) => stats.timeline.stages.find(st => st.entryId === id).waitSec / 60;
  // Départ, « Vider toutes les chansons », titre retiré faute de « Je suis là » :
  // l'attente repart de la coupure, sans aucun passage entre-temps.
  const cuts = {
    départ: e => { e(5, 'person.left', { personId: 'p', by: 'staff' }); e(10, 'person.reactivated', { personId: 'p' }); },
    vidage: e => e(5, 'staff.queueCleared', {}),
  };
  for (const [name, cut] of Object.entries(cuts)) {
    const stats = scenario((e, stage) => {
      e(0, 'song.requested', { personId: 'p', entryId: 'a1', title: 'a1' });
      cut(e);
      e(12, 'song.requested', { personId: 'p', entryId: 'a2', title: 'a2' });
      stage(30, 34, 'a2', ['p'], 1);
    });
    assert.equal(waitOf(stats, 'a2'), 30 - 12, name);
  }
  // Coupure au même instant que la nouvelle demande : pas d'échange non plus.
  assert.equal(waitOf(scenario((e, stage) => {
    e(0, 'song.requested', { personId: 'p', entryId: 'a1', title: 'a1' });
    e(5, 'person.left', { personId: 'p', by: 'staff' }); e(5, 'person.reactivated', { personId: 'p' });
    e(5, 'song.requested', { personId: 'p', entryId: 'a2', title: 'a2' });
    stage(30, 34, 'a2', ['p'], 1);
  }), 'a2'), 30 - 5, 'coupure et demande à la même minute');
  // « Je suis là » manqué trop souvent : le titre suivant de la liste repart de zéro.
  assert.equal(waitOf(scenario((e, stage) => {
    e(0, 'song.requested', { personId: 'p', entryId: 'a1', title: 'a1' });
    e(0, 'song.requested', { personId: 'p', entryId: 'a2', title: 'a2' });
    e(10, 'song.removed', { personId: 'p', entryId: 'a1', by: 'presence-max' });
    stage(30, 34, 'a2', ['p'], 1);
  }), 'a2'), 30 - 10, 'titre suivant après « Je suis là » manqué');
  // Pause sans passage (titre retiré à 6, rechoisi à 20) : échange, mais les
  // 14 min sans titre ne sont pas de l'attente.
  assert.equal(waitOf(scenario((e, stage) => {
    e(1, 'song.requested', { personId: 'p', entryId: 'a1', title: 'a1' });
    e(6, 'song.removed', { personId: 'p', entryId: 'a1', by: 'self' });
    e(20, 'song.requested', { personId: 'p', entryId: 'a2', title: 'a2' });
    stage(30, 34, 'a2', ['p'], 1);
  }), 'a2'), 30 - 1 - 14, 'temps sans titre retiré');
  // La rotation compte un passage à son envoi : retirer avant l'envoi d'un
  // autre puis rechoisir avant son début n'est plus un échange ; retirer
  // après l'envoi et rechoisir après le début en est un.
  const around = (removedAt, addedAt) => waitOf(scenario((e, stage) => {
    e(0, 'song.requested', { personId: 'p', entryId: 'a1', title: 'a1' });
    e(0, 'song.requested', { personId: 'q', entryId: 'b1', title: 'b1' });
    e(removedAt, 'song.removed', { personId: 'p', entryId: 'a1', by: 'self' });
    e(addedAt, 'song.requested', { personId: 'p', entryId: 'a2', title: 'a2' });
    stage(10, 14, 'b1', ['q'], 1, 9);
    stage(30, 34, 'a2', ['p'], 2, 29);
  }), 'a2');
  assert.equal(around(8, 9.5), 30 - 9.5, 'envoi de b1 (9) entre le retrait et le nouveau titre');
  assert.equal(around(9.5, 11), 30 - 0 - 1.5, 'envoi de b1 avant le retrait : échange');
  // « Pas prêt » sur un titre ensuite remplacé : compté dans l'attente,
  // retiré de l'attente nette.
  const deferred = scenario((e, stage) => {
    e(1, 'song.requested', { personId: 'p', entryId: 'a1', title: 'a1' });
    e(3, 'defer.requested', { ownerId: 'p', entryId: 'a1', songs: 3 });
    e(20, 'song.removed', { personId: 'p', entryId: 'a1', by: 'self' });
    e(20, 'song.requested', { personId: 'p', entryId: 'a2', title: 'a2' });
    stage(27, 31, 'a2', ['p'], 1);
  });
  const a2 = deferred.timeline.stages.find(st => st.entryId === 'a2');
  assert.equal(a2.waitSec, (27 - 1) * 60);
  // Deux « Pas prêt » qui se chevauchent (2 à 10 et 4 à 12) ne comptent qu'une fois.
  const twice = scenario((e, stage) => {
    e(0, 'song.requested', { personId: 'p', entryId: 'a1', title: 'a1' });
    e(0, 'song.requested', { personId: 'p', entryId: 'a2', title: 'a2' });
    e(2, 'defer.requested', { ownerId: 'p', entryId: 'a1', songs: 2 });
    e(4, 'defer.requested', { ownerId: 'p', entryId: 'a2', songs: 2 });
    e(10, 'defer.ended', { ownerId: 'p', entryId: 'a1' });
    e(12, 'defer.ended', { ownerId: 'p', entryId: 'a2' });
    stage(30, 34, 'a1', ['p'], 1);
  });
  assert.equal(twice.global.netWaitAvgSec, (30 - 10) * 60, 'union de 2 à 12');
  // « Pas prêt » puis titre remplacé (choix « remplacer ») : retiré aussi.
  const replaced = scenario((e, stage) => {
    e(0, 'song.requested', { personId: 'p', entryId: 'a1', title: 'a1' });
    e(2, 'defer.requested', { ownerId: 'p', entryId: 'a1', songs: 3 });
    e(10, 'song.requested', { personId: 'p', entryId: 'a2', title: 'a2', mode: 'replace', replacedEntryIds: ['a1'] });
    stage(30, 34, 'a2', ['p'], 1);
  });
  assert.equal(waitOf(replaced, 'a2'), 30);
  assert.equal(replaced.global.netWaitAvgSec, (30 - 8) * 60);
  // « Vider toutes les chansons » au même instant qu'une nouvelle demande : coupure.
  assert.equal(waitOf(scenario((e, stage) => {
    e(0, 'song.requested', { personId: 'p', entryId: 'a1', title: 'a1' });
    e(5, 'staff.queueCleared', {});
    e(5, 'song.requested', { personId: 'p', entryId: 'a2', title: 'a2' });
    stage(30, 34, 'a2', ['p'], 1);
  }), 'a2'), 30 - 5, 'vidage et demande à la même minute');
  assert.equal(deferred.global.netWaitAvgSec, (27 - 1 - 17) * 60, 'seul titre chanté : attente nette moyenne');
  // Plus longue attente traversée par deux passages en invitée : dit, au pluriel.
  const guested = scenario((e, stage) => {
    e(0, 'song.requested', { personId: 'g', entryId: 'g1', title: 'g1' });
    e(0, 'song.requested', { personId: 'q', entryId: 'b1', title: 'b1' });
    e(1, 'duo.invited', { personId: 'q', entryId: 'b1', ownerId: 'q', partnerId: 'g', sameGroup: true });
    e(0, 'song.requested', { personId: 'q', entryId: 'b2', title: 'b2' });
    e(15, 'duo.invited', { personId: 'q', entryId: 'b2', ownerId: 'q', partnerId: 'g', sameGroup: true });
    stage(10, 14, 'b1', ['q', 'g'], 1);
    stage(20, 24, 'b2', ['q', 'g'], 2);
    stage(40, 44, 'g1', ['g'], 3);
  });
  assert.deepEqual(guested.global.longestWait, { sec: 40 * 60, personId: 'g', title: 'g1', at: T(40), guestStages: 2 });
  assert.match(insights(guested).find(i => i.kind === 'longest-wait').text,
    /Plus longue attente : 40 min \(g, « g1 » ; entre-temps, 2 passages sur scène comme invité d’un duo\)\./);
  // Sans monter sur scène : duo entre tables, l'invité attend depuis son
  // accord ; demande pour rejoindre directe, depuis la demande ; invité noté
  // par le bar sans titre, aucune attente.
  const cross = scenario((e, stage) => {
    e(0, 'song.requested', { personId: 'q', entryId: 'b1', title: 'b1' });
    e(2, 'duo.invited', { personId: 'q', entryId: 'b1', ownerId: 'q', partnerId: 'g', sameGroup: false });
    e(4, 'duo.answered', { personId: 'g', entryId: 'b1', ownerId: 'q', partnerId: 'g', accepted: true });
    e(0, 'song.requested', { personId: 'p', entryId: 'a1', title: 'a1' });
    e(6, 'duo.joinRequested', { requesterId: 'q', ownerId: 'p', entryId: 'a1', direct: true });
    stage(10, 14, 'b1', ['q', 'g'], 1);
    stage(20, 24, 'a1', ['p', 'q'], 2);
    e(30, 'song.requested', { personId: 'q', entryId: 'b2', title: 'b2' });
    stage(40, 44, 'b2', ['q'], 3);
    e(41, 'duo.improvised', { entryId: 'b2', partnerId: 'p' });
  });
  assert.deepEqual(singerOf(cross, 'g').stageWaits, { n: 1, guestN: 1, avgSec: 6 * 60, medianSec: 6 * 60, maxSec: 6 * 60 },
    'duo entre tables : depuis l’accord (4)');
  assert.equal(singerOf(cross, 'q').stageWaits.n, 3, 'q : son titre, son passage en invitée, son second titre');
  assert.deepEqual(singerOf(cross, 'q').stageWaits, { n: 3, guestN: 1, avgSec: (10 + 6 + 10) * 60 / 3, medianSec: 10 * 60, maxSec: 10 * 60 },
    'b1 0 à 10, invitée de a1 depuis la fin de b1 (14 à 20), b2 demandé à 30 sans titre entre-temps');
  assert.equal(singerOf(cross, 'p').stageWaits.n, 1, 'p noté par le bar sur b2 sans titre en liste : aucune attente');
});

// ------------------------------------------------------- A7 : statistiques figées
// Règle « Rotation » → « Statistiques figées » : le rejeu mesure les deux côtés
// avec l'evening-stats.js de la branche et ne voit pas un changement de
// computeStats. computeStats et exportEvening de la version de travail, sur la
// soirée du 15 octobre, sont donc comparés champ par champ à ceux de 1c15d72
// (test/fixtures/soiree-2026-10-15-resume.json, écrit par test/figer-resume.js),
// avec les mêmes meta et now (metaOf et NOW du script), sous TZ=Europe/Paris
// réglé puis rendu comme dans fuseau.test.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const figer = require('./figer-resume');

// Champs nouveaux de computeStats ou d'exportEvening, absents de 1c15d72 :
// chemin depuis « stats. » ou « export. », « [] » pour tout élément d'une
// liste (par exemple 'stats.singers[].reported').
const NOUVEAUX_CHAMPS = [];

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

const ABSENT = Symbol('absent');
const newField = p => {
  const general = p.replace(/\[\d+\]/g, '[]');
  return NOUVEAUX_CHAMPS.some(f => general === f || general.startsWith(`${f}.`) || general.startsWith(`${f}[`));
};
// Écarts entre la version de travail et le fichier figé, dans l'ordre des
// champs ; un champ présent seulement aujourd'hui n'en est pas un s'il est
// nommé dans NOUVEAUX_CHAMPS.
function frozenDifferences(actual, frozen, at, found = []) {
  const object = v => v !== null && typeof v === 'object';
  if (object(actual) && object(frozen) && Array.isArray(actual) === Array.isArray(frozen)) {
    const list = Array.isArray(actual);
    const keys = list ? [...Array(Math.max(actual.length, frozen.length)).keys()]
      : [...new Set([...Object.keys(frozen), ...Object.keys(actual)])];
    for (const k of keys) {
      const p = list ? `${at}[${k}]` : `${at}.${k}`;
      const now = list ? k < actual.length : Object.hasOwn(actual, k);
      const then = list ? k < frozen.length : Object.hasOwn(frozen, k);
      if (now && !then) { if (!newField(p)) found.push({ path: p, actual: actual[k], frozen: ABSENT }); }
      else if (!now) found.push({ path: p, actual: ABSENT, frozen: frozen[k] });
      else frozenDifferences(actual[k], frozen[k], p, found);
    }
  } else if (!Object.is(actual, frozen)) found.push({ path: at, actual, frozen });
  return found;
}
const shown = value => {
  if (value === ABSENT) return 'absent';
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
};

test('A7 : statistiques figées : computeStats et exportEvening égaux à ceux de 1c15d72 sur la soirée du 15 octobre', () => {
  const file = path.relative(path.join(__dirname, '..'), figer.RESUME).split(path.sep).join('/');
  assert.ok(fs.existsSync(figer.RESUME), `${file} absent : node test/figer-resume.js --ecrire`);
  const frozen = JSON.parse(fs.readFileSync(figer.RESUME, 'utf8'));
  assert.deepEqual(frozen.source, { commit: '1c15d72', module: 'evening-stats.js', fixture: 'test/fixtures/soiree-2026-10-15-anonyme.json',
    timeZone: 'Europe/Paris', now: figer.NOW, live: false }, 'fichier figé écrit par test/figer-resume.js');
  assert.equal(figer.NOW, 1792103188419, 'now : heure de la dernière ligne de la fixture, le 16 octobre à 00:26:28 à Paris');
  const exported = JSON.parse(fs.readFileSync(figer.FIXTURE, 'utf8'));
  const meta = figer.metaOf(exported);
  const current = inZone('Europe/Paris', () => ({
    stats: computeStats({ meta, events: exported.events, now: figer.NOW, live: false }),
    export: exportEvening({ meta, events: exported.events, now: figer.NOW, live: false }),
  }));
  assertRestored();
  // Même forme que le fichier figé (undefined retiré, NaN en null).
  const actual = JSON.parse(JSON.stringify(current));
  const found = [
    ...frozenDifferences(actual.stats, frozen.stats, 'stats'),
    ...frozenDifferences(actual.export, frozen.export, 'export'),
  ];
  if (!found.length) return;
  const [first, ...others] = found;
  assert.fail(`Statistiques figées : ${first.path} vaut ${shown(first.actual)}, ${shown(first.frozen)} avec 1c15d72 (${file}). ` +
    'Champ nouveau : nomme-le dans NOUVEAUX_CHAMPS (evening-stats.test.js) ; sinon computeStats a changé sur une soirée ' +
    'sans coupure ni déplacement : c\'est un défaut (règle « Rotation »).' +
    (others.length ? `\nAutres écarts (${others.length}) : ${others.slice(0, 9).map(d => `${d.path} vaut ${shown(d.actual)}, ` +
      `${shown(d.frozen)} avec 1c15d72`).join(' ; ')}${others.length > 9 ? ' ; …' : ''}.` : ''));
});

// main(argv) de test/figer-resume.js, sans 1c15d72 : la CI clone sans historique.
const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: line => lines.out.push(line), err: line => lines.err.push(line) } };
};

test('A7 : figer-resume.js : --aide, option fausse, et --ecrire refusé sur le fichier figé, sans le réécrire ni lire 1c15d72', () => {
  const help = capture();
  assert.equal(figer.main(['--aide'], help.io), 0);
  assert.match(help.lines.out.join('\n'), /^Usage : node test\/figer-resume\.js --ecrire/);
  for (const argv of [['-h'], ['--help']]) assert.equal(figer.main(argv, capture().io), 0, argv[0]);

  const wrong = capture();
  assert.equal(figer.main(['--x'], wrong.io), 2);
  assert.match(wrong.lines.err.join('\n'), /^Option inconnue : --x\n\nUsage : node test\/figer-resume\.js/);
  assert.equal(figer.main([], capture().io), 2, 'sans --ecrire : l’usage et 2');

  const before = fs.readFileSync(figer.RESUME);
  const refused = capture();
  let reads = 0;
  assert.equal(figer.main(['--ecrire'], { ...refused.io, gitShow: () => { reads++; return ''; } }), 1);
  assert.deepEqual(refused.lines.err, ['soiree-2026-10-15-resume.json existe déjà : efface-le d\'abord pour le refaire.']);
  assert.equal(reads, 0, 'refus avant toute lecture de 1c15d72');
  assert.ok(fs.readFileSync(figer.RESUME).equals(before), 'fichier figé inchangé, octet pour octet');
  // Le vrai chemin, sans rien injecter : même refus, même dans un clone sans 1c15d72.
  const real = capture();
  assert.equal(figer.main(['--ecrire'], real.io), 1);
  assert.deepEqual(real.lines.err, refused.lines.err);
  assert.ok(fs.readFileSync(figer.RESUME).equals(before));
});

test('A7 : figer-resume.js : TZ=Europe/Paris réglée par le script puis rendue, module sans dépendance, 1c15d72 absent, copie sans dépôt git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figer-resume-'));
  try {
    // Module de remplacement qui relève ce qu'il reçoit.
    const probe = `'use strict';
      module.exports = {
        computeStats: ({ meta, events, now, live }) => ({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          eveningId: meta.eveningId, timezone: meta.timezone, roster: meta.roster, tables: meta.tables, events: events.length, now, live }),
        exportEvening: ({ now, live }) => ({ exportedAt: now, live }),
      };`;
    const outFile = path.join(dir, 'resume.json');
    const written = capture();
    assert.equal(figer.main(['--ecrire'], { ...written.io, gitShow: () => probe, outFile }), 0, written.lines.err.join('\n'));
    assertRestored();
    assert.equal(written.lines.out.length, 1);
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(data.stats.zone, 'Europe/Paris', 'calcul sous TZ=Europe/Paris');
    assert.deepEqual([data.stats.eveningId, data.stats.timezone, data.stats.events, data.stats.now, data.stats.live],
      ['soiree-2026-10-15-anonyme', 'Europe/Paris', 796, figer.NOW, false]);
    assert.deepEqual(data.stats.roster.S01, { name: 'S01', tableId: 'T1' }, 'prénom égal à la clé');
    assert.deepEqual(data.stats.tables.T6, { name: 'T6', individual: true });
    assert.equal(Object.keys(data.stats.roster).length, 18);
    assert.deepEqual(data.export, { exportedAt: figer.NOW, live: false });
    // Jamais remplacé.
    const bytes = fs.readFileSync(outFile);
    assert.equal(figer.main(['--ecrire'], { ...capture().io, gitShow: () => probe, outFile }), 1);
    assert.ok(fs.readFileSync(outFile).equals(bytes));

    // Une dépendance : refusée, une ligne sans pile, rien d'écrit.
    const withRequire = capture();
    const other = path.join(dir, 'autre.json');
    assert.equal(figer.main(['--ecrire'], { ...withRequire.io, gitShow: () => `require('fs'); ${probe}`, outFile: other }), 1);
    assert.deepEqual(withRequire.lines.err, ['1c15d72:evening-stats.js : dépendance inattendue (fs), le module doit être sans dépendance.']);
    assert.equal(fs.existsSync(other), false);

    const missing = withoutCommit(dir, other);
    assert.equal(missing.code, 1);
    assert.deepEqual(missing.err, ['1c15d72 introuvable : git fetch --unshallow, puis relance.']);
    assert.equal(fs.existsSync(other), false);

    // Copie sans dépôt git : la ligne fatale de git, pas le remède d'un clone
    // sans 1c15d72, qui n'y marche pas ; une ligne, sans pile, rien d'écrit.
    const outside = outsideRepository(dir, other);
    assert.equal(outside.code, 1);
    assert.equal(outside.err.length, 1, outside.err.join('\n'));
    assert.match(outside.err[0], /^git show 1c15d72:evening-stats\.js a échoué : fatal: not a git repository\b[^\n]*$/i);
    assert.equal(fs.existsSync(other), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Copie sans dépôt git (téléchargée en zip, par exemple), dans dir/hors-depot :
// main(['--ecrire']) qui lit 1c15d72 par gitShowStats depuis ce dossier. La
// recherche du dépôt s'arrête à dir (GIT_CEILING_DIRECTORIES), même si le
// dossier temporaire est dans un dépôt. GIT_CONFIG_GLOBAL, un dossier, fait
// écrire à git un avertissement avant sa ligne fatale, comme un HOME illisible.
function outsideRepository(dir, outFile) {
  const copy = path.join(dir, 'hors-depot');
  fs.mkdirSync(copy);
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dir, GIT_CONFIG_GLOBAL: copy };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  const run = capture();
  const code = figer.main(['--ecrire'], { ...run.io, gitShow: () => figer.gitShowStats({ cwd: copy, env }), outFile });
  return { code, err: run.lines.err };
}

// Clone sans 1c15d72 (dépôt vide, dans dir/clone) : main(['--ecrire']) qui lit
// 1c15d72 par gitShowStats dans ce dépôt. git n'y reçoit pas le dépôt d'un
// crochet git en cours (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE le
// détourneraient), comme dans comparer-images.test.js.
function withoutCommit(dir, outFile) {
  const repo = path.join(dir, 'clone');
  fs.mkdirSync(repo);
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore', env });
  const run = capture();
  const code = figer.main(['--ecrire'], { ...run.io, gitShow: () => figer.gitShowStats({ cwd: repo, env }), outFile });
  return { code, err: run.lines.err, repo };
}

test('A7 : figer-resume.js : 1c15d72 absent, lancé par un crochet git d’un autre dépôt (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE) : même refus, ce dépôt intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figer-resume-'));
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  try {
    // Dépôt du crochet, son répertoire git hors de sa copie de travail comme
    // celui d'une copie de travail liée (.git/worktrees/<nom>), où
    // « git show 1c15d72:evening-stats.js » réussit (étiquette 1c15d72).
    const hook = path.join(dir, 'crochet');
    const hookGit = path.join(dir, 'crochet-git');
    const config = path.join(dir, 'gitconfig');
    fs.writeFileSync(config, '');
    fs.mkdirSync(hook);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'essai',
      GIT_AUTHOR_EMAIL: 'essai@example.invalid', GIT_COMMITTER_NAME: 'essai', GIT_COMMITTER_EMAIL: 'essai@example.invalid' };
    for (const name of names) delete env[name];
    const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
      { cwd: hook, env, stdio: 'ignore' });
    git('init', '-q', `--separate-git-dir=${hookGit}`);
    fs.writeFileSync(path.join(hook, 'evening-stats.js'),
      'module.exports = { computeStats: () => ({}), exportEvening: () => ({}) };\n');
    git('add', 'evening-stats.js');
    git('commit', '-q', '-m', 'essai');
    git('tag', figer.COMMIT);
    const before = fs.readFileSync(path.join(hookGit, 'config'));
    // Variables qu'exporte un crochet git lancé dans ce dépôt.
    Object.assign(process.env, { GIT_DIR: hookGit, GIT_WORK_TREE: hook, GIT_INDEX_FILE: path.join(hookGit, 'index') });
    const other = path.join(dir, 'resume.json');
    const missing = withoutCommit(dir, other);
    assert.equal(missing.code, 1, '1c15d72 lu dans le dépôt du crochet');
    assert.deepEqual(missing.err, ['1c15d72 introuvable : git fetch --unshallow, puis relance.']);
    assert.equal(fs.existsSync(other), false);
    assert.ok(fs.existsSync(path.join(missing.repo, '.git')), 'dépôt vide créé dans clone');
    assert.ok(fs.readFileSync(path.join(hookGit, 'config')).equals(before), 'configuration du dépôt du crochet inchangée');
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------- A4 : personnes citées (citedIds) et garde des événements
// Une personne est citée par une ligne qui montre qu'elle prend part au
// morceau (A4, « Personnes et tables citées ») : la règle par laquelle
// computeStats prolonge une présence, sans les signes de vie des téléphones.
// La garde des événements (règle « Gardes des listes ») range chaque type que
// le code écrit dans l'une des deux listes d'A4, et dans l'activité des bornes
// (A1) : un type non rangé fait échouer les deux essais qui la lisent.
const { citedIds } = require('../evening-stats');
const { ACTIVITY_TYPES } = require('../evening-bounds');

// Types qui citent : par leurs champs personId, requesterId, voterId ou
// proposerId (« champs »), par les ids d'un passage sur scène (« ids »), par
// l'invitée d'un duo noté par le bar (« invitée »).
const CITING_TYPES = new Map([
  ['song.requested', 'champs'], ['queue.entered', 'champs'], ['song.reordered', 'champs'], ['song.settings', 'champs'],
  ['songLength.refused', 'champs'], ['presence.confirmed', 'champs'], ['person.renamed', 'champs'],
  ['person.transferred', 'champs'], ['person.gaveSpot', 'champs'], ['duo.invited', 'champs'], ['duo.answered', 'champs'],
  ['duo.cancelled', 'champs'], ['duo.openRequested', 'champs'], ['duo.openAccepted', 'champs'], ['duo.openClosed', 'champs'],
  ['duo.joinRequested', 'champs'], ['duo.joinAnswered', 'champs'], ['duo.joinCancelled', 'champs'], ['battle.vote', 'champs'],
  ['battle.proposed', 'champs'],
  // Deux gestes du bar qui disent qu'elle est là : « Toujours là » et son retour.
  ['presence.stillHere', 'champs'], ['person.reactivated', 'champs'],
  // Fin d'un « Pas prêt » : « Je suis prêt » (how: 'ready', cancelDeferral de
  // lib/scheduler/presence.js) nomme par personId celle qui l'a touché, et
  // computeStats y prolonge sa présence : elle cite, malgré l'exemple
  // « defer.* » de la liste d'A4 qui ne cite pas. Ses autres fins ne nomment
  // personne que par ownerId.
  ['defer.ended', 'champs'],
  ['stage.started', 'ids'], ['duo.improvised', 'invitée'],
]);
// Types qui ne citent personne : « passif », aucun champ ne cite (signes de
// vie, inscription, messages et demandes du serveur, gestes du bar, envois et
// retraits, fins de duo sans geste de la personne, départs) ; « sans champ »,
// aucun appel qui l'écrit ne nomme quelqu'un par un champ qui cite (ownerId,
// partnerId, guestId, toId au plus : son « Pas prêt », sa sortie d'un duo) :
// la garde lit les champs de chaque appel (fieldsWritten).
const NOT_CITING_TYPES = new Map([
  ...['person.seen', 'person.joined', 'person.left', 'person.bonus', 'notice.sent', 'presence.asked', 'presence.skipped',
    'song.removed', 'duo.inviteExpired', 'duo.joinExpired', 'duo.improvisedCancelled', 'duo.improvisedReplaced', 'staff.absent',
    'staff.move', 'staff.next', 'staff.play', 'staff.queueClearStopped', 'staff.queueCleared', 'staff.recalculate', 'staff.undo',
    'table.bonus', 'table.headcount', 'table.left', 'table.opened', 'table.renamed', 'turn.sent', 'turn.unsent'].map(type => [type, 'passif']),
  ...['app.started', 'app.stopped', 'autoplay.held', 'autoplay.released', 'battle.automation', 'battle.cooldownLifted',
    'battle.decided', 'battle.external', 'battle.resolved', 'battle.staffLaunch', 'closing.cleared', 'closing.reached', 'closing.set',
    'defer.requested', 'duo.left', 'duo.openExpired', 'evening.closed', 'evening.started', 'karafun.renamed',
    'karaoke.phase', 'queue.sample', 'send.unconfirmed', 'settings.changed', 'song.settingsCaughtUp', 'song.settingsReset',
    'songLength.removed', 'spotify', 'stage.ended', 'stage.restarted'].map(type => [type, 'sans champ']),
]);
// Types qui ne sont pas une activité des bornes (A1 ; ACTIVITY_TYPES est
// exportée par evening-bounds.js).
const NOT_ACTIVITY_TYPES = [
  'app.started', 'app.stopped', 'autoplay.held', 'autoplay.released', 'battle.automation', 'battle.cooldownLifted',
  'battle.decided', 'battle.external', 'battle.proposed', 'battle.resolved', 'battle.staffLaunch', 'battle.vote',
  'closing.cleared', 'closing.reached', 'closing.set', 'defer.ended', 'defer.requested', 'duo.answered', 'duo.cancelled',
  'duo.improvised', 'duo.improvisedCancelled', 'duo.improvisedReplaced', 'duo.inviteExpired', 'duo.invited',
  'duo.joinAnswered', 'duo.joinCancelled', 'duo.joinExpired', 'duo.joinRequested', 'duo.left', 'duo.openAccepted',
  'duo.openClosed', 'duo.openExpired', 'duo.openRequested', 'evening.closed', 'evening.started', 'karafun.renamed',
  'karaoke.phase', 'notice.sent', 'person.bonus', 'person.gaveSpot', 'person.left', 'person.reactivated', 'person.renamed',
  'person.seen', 'person.transferred', 'presence.asked', 'presence.confirmed', 'presence.skipped', 'presence.stillHere',
  'queue.entered', 'queue.sample', 'send.unconfirmed', 'settings.changed', 'song.removed', 'song.reordered', 'song.settings',
  'song.settingsCaughtUp', 'song.settingsReset', 'songLength.refused', 'songLength.removed', 'spotify', 'staff.absent',
  'staff.move', 'staff.next', 'staff.play', 'staff.queueClearStopped', 'staff.queueCleared', 'staff.recalculate', 'staff.undo',
  'stage.ended', 'stage.restarted', 'table.bonus', 'table.headcount', 'table.left', 'table.renamed', 'turn.sent', 'turn.unsent',
];

// Relevé des types écrits : journal.append('…') et this.append('…')
// d'evening-journal.js, journalEvent('…') de server.js, _event('…') de
// scheduler.js et de lib/scheduler/, par un appel direct ou facultatif
// (`?.`). Hors des trois relais, dont le type est calculé (_event de
// scheduler.js, journalEvent de server.js et la reprise des lignes gardées
// avant l'ouverture, _flushEarly d'evening-journal.js), un appel dont le type
// n'est pas écrit en entier entre apostrophes est signalé.
const ROOT = path.join(__dirname, '..');
const WRITERS = ['evening-journal.js', 'server.js', 'scheduler.js',
  ...fs.readdirSync(path.join(ROOT, 'lib', 'scheduler')).filter(name => name.endsWith('.js')).sort().map(name => `lib/scheduler/${name}`)];
const RELAYS = new Set([
  'scheduler.js:_event(type, fields = {}) {',
  'server.js:function journalEvent(type, fields = {}) {',
  'server.js:return journal.append(type, fields);',
  'evening-journal.js:for (const [ev, fields, t] of early) this.append(ev, fields, t);',
]);
const WRITE_CALL = /\b(?:_event|journalEvent|journal\.append|this\.append)\s*(?:\?\.)?\(\s*/g;
const TYPE_LITERAL = /^'([a-z][a-zA-Z]*(?:\.[a-zA-Z]+){0,3})'\s*[,)]/;
// Champs par lesquels une ligne cite (PRESENCE_KEYS d'evening-stats.js).
const CITING_KEYS = ['personId', 'requesterId', 'voterId', 'proposerId'];
// Champs écrits par un appel, lus dans ses arguments après le type, jusqu'à
// sa parenthèse fermante (chaînes et commentaires sautés) : les clés de ses
// objets littéraux, et les champs que la garde ne lit pas (objet étendu par un
// nom, `...fields`, champs passés par un nom, appel qui ne se referme pas).
function fieldsWritten(source, from) {
  const stack = [], hidden = [];
  let text = '', closed = false;
  for (let i = from; i < source.length && !closed; i++) {
    const c = source[i];
    if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      const next = source[i + 1] === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2) + 1;
      i = next > 0 ? next : source.length;
      text += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++;
      text += "''";
      continue;
    }
    if ('({['.includes(c)) stack.push(c);
    else if (')}]'.includes(c)) { if (!stack.length) { closed = true; continue; } stack.pop(); }
    else if (source.startsWith('...', i) && stack.at(-1) === '{') {
      const name = /^\.\.\.\s*([A-Za-z_$][\w$.]*)/.exec(source.slice(i, i + 80));
      if (name) hidden.push(`...${name[1]}`);
    }
    text += c;
  }
  if (!closed) return { keys: new Set(), hidden: ['appel non refermé'] };
  const keys = new Set([...text.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*(?=[:,}])/g)].map(m => m[1]));
  const bare = /^,\s*([A-Za-z_$][\w$.]*)\s*(?:,|$)/.exec(text.trim());
  if (bare) hidden.push(bare[1]);
  return { keys, hidden };
}
// Champs étendus d'un type « sans champ », relus : ligne de l'appel, puis
// d'où viennent ses champs, sans personId, requesterId, voterId ni proposerId.
const SPREADS = new Map([
  ["evening-journal.js:this.append('evening.closed', { ...fields, by, ...(reason ? { reason } : {}), ...(timed ? { closedAt: at } : {}) });",
    'close({ fields }) : ceux de closeEvening (server.js), le bilan de « Supprimer toutes les tables » (unsungSongs, peopleWithSongs, people, tables), ' +
    'et la première activité d’une fin automatique (firstActivityAt, A2) ; reason et closedAt viennent de close (A5)'],
]);
function eventTypesWritten(files = WRITERS, read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')) {
  const written = new Map(), computed = [], sites = new Map();
  for (const file of files) {
    const source = read(file).replace(/\r\n/g, '\n');
    const lines = source.split('\n');
    const starts = [0];
    for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) starts.push(i + 1);
    const lineOf = index => { let low = 0, high = starts.length; while (low < high) { const mid = (low + high) >>> 1; if (starts[mid] <= index) low = mid + 1; else high = mid; } return low; };
    for (const match of source.matchAll(WRITE_CALL)) {
      const typeAt = match.index + match[0].length;
      const literal = TYPE_LITERAL.exec(source.slice(typeAt, typeAt + 80));
      if (literal) {
        const line = lineOf(typeAt);
        if (!written.has(literal[1])) written.set(literal[1], `${file}:${line}`);
        if (!sites.has(literal[1])) sites.set(literal[1], []);
        sites.get(literal[1]).push({ where: `${file}:${line}`, line: `${file}:${lines[line - 1].trim()}`,
          ...fieldsWritten(source, typeAt + literal[0].length - 1) });
        continue;
      }
      const line = lineOf(match.index);
      if (!RELAYS.has(`${file}:${lines[line - 1].trim()}`)) computed.push(`${file}:${line}`);
    }
  }
  return { written, computed, sites };
}
// Écarts de la garde, un message par type ou par appel.
function guardProblems({ written, computed, sites = new Map() }) {
  const problems = [];
  for (const [type, where] of written) {
    const once = (a, b) => a !== b;
    if (!once(CITING_TYPES.has(type), NOT_CITING_TYPES.has(type)) || !once(ACTIVITY_TYPES.includes(type), NOT_ACTIVITY_TYPES.includes(type))) {
      problems.push(`Type d'événement non rangé : ${type}, écrit à ${where}. Range-le une fois dans CITING_TYPES ou NOT_CITING_TYPES ` +
        '(test/evening-stats.test.js, règle d\'A4), et une fois dans ACTIVITY_TYPES (evening-bounds.js) ou NOT_ACTIVITY_TYPES ' +
        '(test/evening-stats.test.js, règle d\'A1).');
    }
  }
  for (const where of computed) problems.push(`Type d'événement calculé à ${where} : écris-le en entier entre apostrophes, pour que la garde le range.`);
  for (const [name, list] of [['CITING_TYPES', [...CITING_TYPES.keys()]], ['NOT_CITING_TYPES', [...NOT_CITING_TYPES.keys()]],
    ['ACTIVITY_TYPES', ACTIVITY_TYPES], ['NOT_ACTIVITY_TYPES', NOT_ACTIVITY_TYPES]]) {
    for (const type of list) if (!written.has(type)) problems.push(`Type d'événement rangé mais jamais écrit : ${type} (${name}). Retire-le de cette liste.`);
  }
  // Un type « sans champ » : aucun de ses appels n'écrit un champ qui cite,
  // ni des champs que la garde ne lit pas, hors des appels relus de SPREADS.
  const spread = new Set();
  for (const [type, why] of NOT_CITING_TYPES) {
    if (why !== 'sans champ') continue;
    for (const site of sites.get(type) || []) {
      const citing = CITING_KEYS.filter(key => site.keys.has(key));
      if (citing.length) {
        problems.push(`Type d'événement rangé « sans champ » mais écrit avec ${citing.join(', ')} à ${site.where} : range-le dans CITING_TYPES ` +
          '(test/evening-stats.test.js, règle d\'A4), ou retire ce champ.');
      }
      if (!site.hidden.length) continue;
      if (SPREADS.has(site.line)) { spread.add(site.line); continue; }
      problems.push(`Type d'événement rangé « sans champ » écrit à ${site.where} avec des champs que la garde ne lit pas (${site.hidden.join(', ')}) : ` +
        'vérifie qu\'ils ne nomment personne par personId, requesterId, voterId ou proposerId, puis ajoute cet appel à SPREADS ' +
        '(test/evening-stats.test.js) ; sinon, range le type dans CITING_TYPES.');
    }
  }
  for (const line of SPREADS.keys()) if (!spread.has(line)) problems.push(`Appel de SPREADS jamais écrit pour un type « sans champ » : ${line}. Retire-le.`);
  return problems;
}
const WRITTEN = eventTypesWritten();

test('A4 : garde des événements : chaque type écrit par le code rangé une fois parmi les types qui citent ou non (A4), une fois dans l’activité des bornes (A1), aucun type calculé hors des trois relais', () => {
  assert.ok(WRITTEN.written.size >= 80, `types relevés : ${WRITTEN.written.size}`);
  for (const type of ['evening.closed', 'stage.started', 'duo.improvisedReplaced', 'karafun.renamed', 'notice.sent']) {
    assert.ok(WRITTEN.written.has(type), `${type} relevé (appel direct, facultatif ou d'evening-journal.js)`);
  }
  assert.deepEqual(guardProblems(WRITTEN), []);
  // La garde elle-même, sur des sources écrites par l'essai : un type non
  // rangé, un type calculé, un relais reconnu.
  const fake = new Map([
    ['scheduler.js', "  _event(type, fields = {}) {\n    this._event?.('duo.nouveau', { personId: p.id });\n    this._event(kind, {});\n"],
    ['server.js', "journalEvent(`stage.${kind}`, {});\njournalEvent('stage.started', {});\n"],
  ]);
  const found = eventTypesWritten([...fake.keys()], file => fake.get(file));
  assert.deepEqual([...found.written], [['duo.nouveau', 'scheduler.js:2'], ['stage.started', 'server.js:2']]);
  assert.deepEqual(guardProblems(found).filter(p => !p.includes('jamais écrit')), [
    'Type d\'événement non rangé : duo.nouveau, écrit à scheduler.js:2. Range-le une fois dans CITING_TYPES ou NOT_CITING_TYPES ' +
      '(test/evening-stats.test.js, règle d\'A4), et une fois dans ACTIVITY_TYPES (evening-bounds.js) ou NOT_ACTIVITY_TYPES ' +
      '(test/evening-stats.test.js, règle d\'A1).',
    'Type d\'événement calculé à scheduler.js:3 : écris-le en entier entre apostrophes, pour que la garde le range.',
    'Type d\'événement calculé à server.js:1 : écris-le en entier entre apostrophes, pour que la garde le range.',
  ]);
  // Les champs d'un type « sans champ », sur des sources écrites par l'essai :
  // un champ qui cite, un objet étendu par un nom, des champs passés par un
  // nom, un appel qui ne se referme pas ; un champ en commentaire ou dans une
  // chaîne n'est pas lu, ni une liste étendue.
  const shapes = new Map([
    ['lib/scheduler/presence.js', "    this._event('defer.requested', { ownerId: p.id, personIds: ids, personId: p.id });\n" +
      "    this._event?.('duo.openExpired', { ...extra, ownerId: owner.id });\n" +
      "    this._event('duo.left', { ownerId: o.id, guestId: g.id /* , personId: g.id */, note: ', personId: x', ids: [...ids] });\n"],
    ['server.js', "journalEvent('karaoke.phase', state);\njournalEvent('stage.ended', { queueId: 1,\n"],
  ]);
  assert.deepEqual(guardProblems(eventTypesWritten([...shapes.keys()], file => shapes.get(file))).filter(p => !p.includes('jamais écrit')), [
    'Type d\'événement rangé « sans champ » mais écrit avec personId à lib/scheduler/presence.js:1 : range-le dans CITING_TYPES ' +
      '(test/evening-stats.test.js, règle d\'A4), ou retire ce champ.',
    'Type d\'événement rangé « sans champ » écrit à lib/scheduler/presence.js:2 avec des champs que la garde ne lit pas (...extra) : ' +
      'vérifie qu\'ils ne nomment personne par personId, requesterId, voterId ou proposerId, puis ajoute cet appel à SPREADS ' +
      '(test/evening-stats.test.js) ; sinon, range le type dans CITING_TYPES.',
    'Type d\'événement rangé « sans champ » écrit à server.js:1 avec des champs que la garde ne lit pas (state) : ' +
      'vérifie qu\'ils ne nomment personne par personId, requesterId, voterId ou proposerId, puis ajoute cet appel à SPREADS ' +
      '(test/evening-stats.test.js) ; sinon, range le type dans CITING_TYPES.',
    'Type d\'événement rangé « sans champ » écrit à server.js:2 avec des champs que la garde ne lit pas (appel non refermé) : ' +
      'vérifie qu\'ils ne nomment personne par personId, requesterId, voterId ou proposerId, puis ajoute cet appel à SPREADS ' +
      '(test/evening-stats.test.js) ; sinon, range le type dans CITING_TYPES.',
  ]);
});

test('A4 : citedIds en tableau : chaque type des deux listes d’A4 et chaque champ ; personId, requesterId, voterId et proposerId citent, partnerId, toId, ownerId et guestId non, sauf l’invitée d’un duo noté par le bar ; ligne du bar, ids bruts d’un passage ; types « sans champ » avec les champs de leurs appels ; « Je suis prêt » (defer.ended, personId) cite', () => {
  // Le relevé de la garde, sans second relevé : un type non rangé échoue ici aussi.
  for (const [type, where] of WRITTEN.written) {
    assert.ok(CITING_TYPES.has(type) !== NOT_CITING_TYPES.has(type),
      `Type d'événement non rangé : ${type}, écrit à ${where}. Range-le une fois dans CITING_TYPES ou NOT_CITING_TYPES (test/evening-stats.test.js, règle d'A4).`);
  }
  const t = T0;
  const CITING_FIELDS = { personId: 'p', requesterId: 'r', voterId: 'v', proposerId: 'x' };
  const OTHER_FIELDS = { partnerId: 'q', toId: 'to', ownerId: 'o', guestId: 'g', previousPartnerId: 'pp' };
  const LISTS = { ids: ['i1'], personIds: ['l1'] };
  for (const [type, how] of CITING_TYPES) {
    const line = fields => ({ v: 1, seq: 1, t, ev: type, boot: 'b1', ...fields });
    if (how === 'champs') {
      for (const [key, id] of Object.entries(CITING_FIELDS)) assert.deepEqual(citedIds(line({ [key]: id })), [id], `${type} : ${key} cite`);
      for (const [key, id] of Object.entries(OTHER_FIELDS)) assert.deepEqual(citedIds(line({ [key]: id })), [], `${type} : ${key} ne cite pas`);
      assert.deepEqual(citedIds(line({ ...LISTS })), [], `${type} : ids et personIds ne citent pas`);
      assert.deepEqual(citedIds(line({ ...CITING_FIELDS, ...OTHER_FIELDS })), ['p', 'r', 'v', 'x'], `${type} : tous les champs`);
      assert.deepEqual(citedIds(line({ ...CITING_FIELDS, by: 'staff' })), [], `${type} : une ligne du bar ne cite pas`);
    } else if (how === 'ids') {
      assert.deepEqual(citedIds(line({ ids: ['a', 'b', '', 5, null, 'a'], ownerId: 'o', ...OTHER_FIELDS })), ['a', 'b', 'a'],
        `${type} : ids bruts, chaînes non vides seulement`);
    } else {
      assert.deepEqual(citedIds(line({ ownerId: 'o', partnerId: 'g' })), ['g'], `${type} : l'invitée citée, pas la personne du titre`);
      assert.deepEqual(citedIds(line({ ...CITING_FIELDS, ownerId: 'o' })), [], `${type} : geste du bar, ses autres champs ne citent pas`);
    }
  }
  // « passif » : avec les champs qui citent ; « sans champ » : avec les champs
  // de chaque appel qui l'écrit (relevé de la garde), comme le code l'écrit.
  const writtenFields = type => Object.fromEntries((WRITTEN.sites.get(type) || []).flatMap(site => [...site.keys]).map(key => [key, 'w']));
  for (const [type, why] of NOT_CITING_TYPES) {
    const line = { ...(why === 'passif' ? CITING_FIELDS : writtenFields(type)), ...OTHER_FIELDS, ...LISTS, v: 1, seq: 1, t, ev: type, boot: 'b1' };
    assert.deepEqual(citedIds(line), [], `${type} (${why}) ne cite personne`);
  }
  // Le « Pas prêt » tel que lib/scheduler/presence.js l'écrit : « Je suis
  // prêt » nomme par personId celle qui l'a touché (la personne du titre ou
  // son invitée) et ne cite qu'elle ; la demande et les autres fins du report
  // ne nomment que par ownerId.
  const deferLine = (ev, fields) => citedIds({ ...fields, v: 1, seq: 1, t, ev, boot: 'b1' });
  assert.deepEqual(deferLine('defer.ended', { personId: 'g', ownerId: 'o', entryId: 'e1', how: 'ready' }), ['g']);
  for (const how of ['released', 'sent', 'dropped', 'alone', 'staff-move']) {
    assert.deepEqual(deferLine('defer.ended', { ownerId: 'o', entryId: 'e1', how }), [], `defer.ended ${how}`);
  }
  assert.deepEqual(deferLine('defer.requested', { ownerId: 'o', personIds: ['o', 'g'], entryId: 'e1', songs: 1, total: 1, remaining: 1 }), []);
  // Ce que la personne fait elle-même cite : réglage de son titre, sauf par le bar.
  assert.deepEqual(citedIds({ ev: 'song.settings', t, by: 'self', where: 'list', personId: 'p1' }), ['p1']);
  assert.deepEqual(citedIds({ ev: 'song.settings', t, by: 'staff', where: 'list', personId: 'p1' }), []);
  // Champs de mauvais type : lus comme absents ; jamais d'exception.
  assert.deepEqual(citedIds({ ev: 'song.requested', t, personId: 42 }), []);
  assert.deepEqual(citedIds({ ev: 'song.requested', t, personId: '', requesterId: ['p'], voterId: { id: 'p' } }), []);
  assert.deepEqual(citedIds({ ev: 'stage.started', t, ids: 'p1' }), []);
  assert.deepEqual(citedIds({ ev: 'duo.improvised', t, partnerId: 7 }), []);
  for (const bad of [null, undefined, 7, 'song.requested', {}, { ev: 5, personId: 'p' }, []]) assert.deepEqual(citedIds(bad), [], String(bad));
});

test('A4 : export en tableau : pseudonyms donne une clé S…, dans l’ordre des lignes, à toute personne nommée par une ligne sans être parmi les chanteurs ni dans meta.roster, par chacun des onze champs lus, éléments imbriqués compris (listes et objets, jusqu’au plus profond que garde cleanFields) ; aucun identifiant interne ne sort de l’export ; un journal d’aujourd’hui n’en reçoit aucune de plus', () => {
  const { cleanFields } = require('../evening-journal');
  // Les onze champs lus (A4, « Personnes et tables citées », export).
  const NAMING = ['personId', 'personIds', 'ids', 'ownerId', 'partnerId', 'guestId', 'requesterId', 'voterId', 'proposerId', 'toId',
    'previousPartnerId'];
  const { meta, events } = fixture();
  // Un journal d'aujourd'hui : chaque personne qu'il nomme est dans son meta.roster.
  const today = exportEvening({ meta, events, now: at(180) });
  assert.deepEqual(today.people.map(p => p.key), ['S01', 'S02', 'S03', 'S04']);
  // Une personne hors du roster par champ, nommée par un avis (ligne qui ne
  // crée personne dans les statistiques) ; puis, dans une même ligne, deux
  // personnes dans l'ordre des champs et une personne déjà nommée ; enfin un
  // nom dans une liste qui n'en est pas une (une clé quand même : rien
  // d'interne ne sort), des valeurs qui ne nomment personne, et un
  // identifiant de titre, qui n'est pas une personne. Des noms aussi dans des
  // éléments imbriqués (A7, liste dont des éléments ne sont pas des chaînes
  // non vides) : un objet dans la liste ids de cette ligne, puis une liste
  // dans la liste, un objet, le plus profond que garde cleanFields, et un
  // objet à la place d'un identifiant, dont le tableId reste une table.
  const line = (i, fields) => ({ v: 1, seq: 100 + i, t: at(100 + i), ev: 'notice.sent', boot: 'b1', kind: 'turnSoon', ...fields });
  const deepest = { ids: [[['hors-profond']]], partnerId: { tableId: '1', personId: 'hors-champ' } };
  assert.deepEqual(cleanFields(deepest), deepest, 'gardé par cleanFields');
  const extra = [
    ...NAMING.map((key, i) => line(i, { [key]: ['personIds', 'ids'].includes(key) ? [`hors-${key}`] : `hors-${key}` })),
    line(20, { toId: 'hors-cede', personId: 'hors-avant', ownerId: 'hors-personId' }),
    line(21, { personIds: 'hors-chaine', personId: 42, partnerId: '', ids: ['', null, 7, { id: 'hors-objet' }], entryId: 'entree-9' }),
    line(22, { personIds: ['pA', ['hors-liste']] }),
    line(23, { personId: 'pA', personIds: [{ id: 'hors-element' }] }),
    line(24, deepest),
  ];
  const all = [...events.slice(0, -1), ...extra, events.at(-1)];
  const exported = exportEvening({ meta, events: all, now: at(180) });
  const keys = [...NAMING.map(key => `hors-${key}`), 'hors-avant', 'hors-cede', 'hors-chaine', 'hors-objet', 'hors-liste', 'hors-element',
    'hors-profond', 'hors-champ'];
  const keyOf = i => `S${String(i + 5).padStart(2, '0')}`;
  assert.deepEqual(exported.people.map(p => p.key), ['S01', 'S02', 'S03', 'S04', ...keys.map((_, i) => keyOf(i))]);
  assert.deepEqual(exported.people.slice(4).map(p => p.table), keys.map(() => null));
  // Chaque identifiant remplacé par sa clé, dans chaque champ.
  const mapped = exported.events.filter(e => e.seq >= 100);
  NAMING.forEach((key, i) => assert.deepEqual(mapped[i][key], ['personIds', 'ids'].includes(key) ? [keyOf(i)] : keyOf(i), key));
  assert.deepEqual([mapped[11].personId, mapped[11].ownerId, mapped[11].toId], ['S16', 'S05', 'S17']);
  assert.deepEqual([mapped[12].personIds, mapped[12].personId, mapped[12].partnerId, mapped[12].ids, mapped[12].entryId],
    ['S18', 42, '', ['', null, 7, { id: 'S19' }], 'entree-9']);
  assert.deepEqual([mapped[13].personIds, mapped[14].personId, mapped[14].personIds, mapped[15].ids, mapped[15].partnerId],
    [['S01', ['S20']], 'S01', [{ id: 'S21' }], [[['S22']]], { tableId: 'T1', personId: 'S23' }]);
  // Aucun identifiant interne des onze champs ne sort de l'export, prénoms demandés ou non.
  for (const names of [false, true]) {
    const text = JSON.stringify(exportEvening({ meta, events: all, now: at(180), names }));
    for (const id of keys) assert.ok(!text.includes(`"${id}"`), `${id} dans l'export (names: ${names})`);
  }
  // Les statistiques ne changent pas : ces lignes ne créent personne.
  assert.deepEqual(computeStats({ meta, events: all, now: at(180) }).singers, computeStats({ meta, events, now: at(180) }).singers);
});

test('A7 : lignes qui ne nomment pas leur personne (huit sortes) : computeStats et exportEvening rendent un résultat, la ligne ignorée', () => {
  const base = [
    { v: 1, seq: 1, t: at(0), ev: 'evening.started', boot: 'b1', rules: {} },
    { v: 1, seq: 2, t: at(0), ev: 'table.opened', boot: 'b1', tableId: '1', individual: false },
    { v: 1, seq: 3, t: at(1), ev: 'person.joined', boot: 'b1', personId: 'p1', tableId: '1' },
    { v: 1, seq: 4, t: at(5), ev: 'song.requested', boot: 'b1', personId: 'p1', entryId: 'e1', title: 'Un', mode: 'append' },
    { v: 1, seq: 5, t: at(10), ev: 'stage.started', boot: 'b1', queueId: 1, entryId: 'e1', ids: ['p1'], ownerId: 'p1', source: 'queue' },
    { v: 1, seq: 6, t: at(14), ev: 'stage.ended', boot: 'b1', queueId: 1, playedSec: 240 },
  ];
  const closing = { v: 1, seq: 9, t: at(60), ev: 'evening.closed', boot: 'b1', by: 'staff-reset' };
  const run = extra => {
    const events = [...base, ...extra.map((e, i) => ({ v: 1, seq: 7 + i, t: at(20), boot: 'b1', ...e })), closing];
    const meta = { eveningId: 'e', roster: { p1: { name: 'Léa', tableId: '1' } }, tables: { 1: { name: 'Table 1', individual: false } } };
    return { stats: computeStats({ meta, events, now: at(60) }), exported: exportEvening({ meta, events, now: at(60) }) };
  };
  const reference = run([]).stats;
  const LINES = [
    { ev: 'person.joined', tableId: '1' },
    { ev: 'song.requested', entryId: 'x1', title: 'Sans personne', mode: 'append' },
    { ev: 'person.bonus', level: 2 },
    { ev: 'person.reactivated' },
    { ev: 'presence.confirmed', entryId: null },
    { ev: 'presence.skipped', entryId: 'e1', skips: 1, removed: false },
    { ev: 'presence.asked', personIds: ['', null], entryId: 'e1' },
    { ev: 'defer.requested', personIds: ['p1'], entryId: 'e1', songs: 1 },
  ];
  for (const line of LINES) {
    for (const variant of [{}, line.ev === 'defer.requested' ? { ownerId: '' } : { personId: '' }, line.ev === 'defer.requested' ? { ownerId: null } : { personId: null }]) {
      const { stats, exported } = run([{ ...line, ...variant }]);
      const label = `${line.ev} ${JSON.stringify(variant)}`;
      assert.deepEqual(stats.singers, reference.singers, `${label} : ligne ignorée`);
      assert.deepEqual(stats.fairness, reference.fairness, label);
      assert.equal(exported.format, 'karaoke-evening', label);
    }
  }
  // presence.asked : les éléments valides comptent, les autres sont ignorés.
  const asked = run([{ ev: 'presence.asked', personIds: ['p1', '', null], entryId: 'e1' }]).stats;
  assert.equal(singerOf(asked, 'p1').presenceAsks, 1);
  assert.deepEqual(asked.singers.map(s => s.id), ['p1']);
});

// ------------------------------------------- A5 : soirée close d'office
// A5, « Fin du karaoké d'une soirée close d'office » (A7, « Fin d'une soirée
// close d'office » et « Retard de 3 h ») : la soirée du 15 octobre privée de
// ce qui finit aujourd'hui son karaoké, la coupure durable de KaraFun après
// son dernier titre (karaoke.phase offline de 00:12 et de 00:17) et son heure
// de fermeture (closing.set) ; elle n'a aucun arrêt de l'application après son
// dernier titre. KaraFun y reste donc connecté toute la nuit. Une soirée close
// d'office se lit sur meta.closedBy, sinon sur le by de sa ligne
// evening.closed (relue sans meta par test/rejeu-soiree.js) ; son C est
// meta.endedAt, sinon le closedAt de cette ligne, sinon son heure.
const { eveningBreaks, closurePoint, isActivity } = require('../evening-bounds');
const PARIS = 'Europe/Paris';
const MIN_MS = 60000;
const HOUR_MS = 60 * MIN_MS;
// Heure de Paris le 16 octobre 2026 (heure d'été, UTC+2).
const le16 = hhmm => Date.parse(`2026-10-16T${hhmm}:00+02:00`);
function sansFin() {
  const exported = JSON.parse(fs.readFileSync(figer.FIXTURE, 'utf8'));
  const lastStart = Math.max(...exported.events.filter(e => e.ev === 'stage.started').map(e => e.t));
  const isEnd = e => e.ev === 'closing.set' || (e.ev === 'karaoke.phase' && e.blocker === 'offline' && e.t > lastStart);
  const events = exported.events.filter(e => !isEnd(e));
  return { events, ends: exported.events.filter(isEnd), meta: figer.metaOf(exported), lastStart,
    firstActivityAt: Math.min(...events.filter(isActivity).map(e => e.t)), seq: Math.max(...exported.events.map(e => e.seq)) };
}
// Ligne evening.closed ajoutée à la fin d'un journal (seq après ses lignes).
const closingOf = (events, t, fields) => ({ v: 1, seq: Math.max(...events.map(e => e.seq)) + 1, t, ev: 'evening.closed', boot: 'remise', ...fields });
// Close d'office à C par la remise à zéro du matin (A2) : meta.endedAt à C,
// closedBy 'auto', ligne datée de l'heure réelle de la remise à zéro (`t`, C
// par défaut), avec reason, closedAt = C et la première activité.
function closeOffice({ meta, events, firstActivityAt }, C, t = C) {
  return { meta: { ...meta, endedAt: C, closedBy: 'auto' },
    events: [...events, closingOf(events, t, { by: 'auto', reason: 'morning', closedAt: C, firstActivityAt })] };
}
// Close par « Supprimer toutes les tables » à `t` ; `cut` : lignes d'après `t`
// retirées, la soirée suivante les aurait.
function closeButton({ meta, events }, t, { cut = false } = {}) {
  const kept = cut ? events.filter(e => e.t <= t) : events;
  return { meta: { ...meta, endedAt: t, closedBy: 'staff-reset' }, events: [...kept, closingOf(kept, t, { by: 'staff-reset' })] };
}
const statsAt = ({ meta, events }, now = Math.max(...events.map(e => e.t))) => computeStats({ meta, events, now });
// Relue sans meta, comme test/rejeu-soiree.js (statsOf : now à la dernière heure).
const statsBare = ({ events }) => computeStats({ events, now: events.reduce((m, e) => Math.max(m, e.t), 0) });
const lastEndOf = stats => Math.max(...stats.timeline.stages.map(st => st.end));
// Temps mort, titres par heure, attente moyenne et attente sans monter sur
// scène (par personne, invité compris).
const waitFigures = stats => ({ deadShare: stats.global.deadShare, deadSec: stats.global.deadSec, songsPerHour: stats.global.songsPerHour,
  waitAvgSec: stats.global.waitAvgSec, waitMedianSec: stats.global.waitMedianSec, netWaitAvgSec: stats.global.netWaitAvgSec,
  waits: Object.fromEntries(stats.singers.map(s => [s.id, s.waits])), stageWaits: Object.fromEntries(stats.singers.map(s => [s.id, s.stageWaits])) });

test('A7 : fin d’une soirée close d’office (A5) : la soirée du 15 octobre privée de ses fins, KaraFun connecté toute la nuit, close d’office à 9 h : karaoké fini à la fin de son dernier titre, résumé fini ; temps mort, titres par heure, attente moyenne et attente sans monter sur scène égaux à ceux de la même soirée close par le bouton juste après son dernier titre ; avec une coupure durable de KaraFun, un arrêt de l’application ou une heure de fermeture, la fin reste la leur ; close par le bouton, rien ne change', () => {
  const base = sansFin();
  assert.deepEqual(base.ends.map(e => e.ev), ['closing.set', 'karaoke.phase', 'karaoke.phase'], 'heure de fermeture et coupure durable de KaraFun retirées');
  const C = le16('09:00');
  const office = statsAt(closeOffice(base, C));
  const lastEnd = lastEndOf(office);
  assert.ok(lastEnd > base.lastStart && lastEnd < le16('00:12'), 'dernier titre fini vers minuit');
  assert.equal(office.evening.closedAt, lastEnd, 'karaoké fini à la fin du dernier titre, résumé fini (closedAt rempli)');
  assert.deepEqual([office.evening.endedAt, office.evening.closedBy], [C, 'auto']);
  for (const s of office.singers) assert.ok(s.leftAt == null || s.leftAt <= lastEnd, `${s.id} : présence jusqu’à la fin du karaoké au plus`);
  // La même soirée close par le bouton une minute après son dernier titre.
  const button = statsAt(closeButton(base, lastEnd + MIN_MS, { cut: true }));
  assert.deepEqual(waitFigures(office), waitFigures(button));
  assert.deepEqual(office.timeline.stages, button.timeline.stages);
  // Close par le bouton à la fin même du dernier titre : mêmes présences et
  // même indice de Jain (0,744 ; 0,83 si le karaoké courait jusqu'à 9 h).
  const atEnd = statsAt(closeButton(base, lastEnd, { cut: true }));
  assert.deepEqual(office.singers.map(s => [s.id, s.presenceSec]), atEnd.singers.map(s => [s.id, s.presenceSec]));
  assert.equal(office.fairness.jain, atEnd.fairness.jain);
  assert.equal(office.fairness.jain, 0.744);
  // Avec l'une des trois fins, la fin reste la sienne : celle de la même
  // soirée close par le bouton à 9 h.
  const cutAt = base.ends.at(-1).t;
  const closingSet = base.ends.find(e => e.ev === 'closing.set');
  const variants = [
    ['coupure durable de KaraFun', base.ends.filter(e => e.ev === 'karaoke.phase'), cutAt],
    ['arrêt de l’application', [{ v: 1, seq: base.seq + 1, t: le16('03:00'), ev: 'app.started', boot: 'reprise', restored: true,
      offlineMs: 2 * HOUR_MS, version: 'v3.0.1' }], le16('01:00')],
    ['heure de fermeture', [closingSet], closingSet.closingAt],
  ];
  for (const [name, extra, end] of variants) {
    const evening = { ...base, events: [...base.events, ...extra] };
    assert.equal(statsAt(closeOffice(evening, C)).evening.closedAt, end, `${name} : close d’office`);
    assert.equal(statsAt(closeButton(evening, C)).evening.closedAt, end, `${name} : close par le bouton à 9 h`);
  }
  // Close par le bouton : rien ne change, le karaoké court jusqu'à la clôture
  // (aucune fin, résumé sans closedAt) et S11, vu à 00:26, reste compté après
  // le dernier titre.
  const late = statsAt(closeButton(base, C));
  assert.deepEqual([late.evening.closedAt, late.evening.closedBy, late.timeline.end], [null, 'staff-reset', C]);
  assert.ok(singerOf(late, 'S11').leftAt > lastEnd);
  assert.ok(singerOf(office, 'S11').leftAt <= lastEnd);
});

// Coupure de KaraFun encore ouverte à C : son retour, daté après C, n'est
// jamais lu (un morceau découpé le laisse au morceau suivant). Elle est jugée
// à C, comme en direct (coupée depuis au moins 30 min), et comme un arrêt de
// l'application noté après C, dont seule la part d'avant C compte.
test('A7 : fin d’une soirée close d’office (A5), coupure de KaraFun encore ouverte à C, retour daté après C : jugée à C, comme en direct et comme un arrêt de l’application noté après C ; KaraFun coupé à C − 10 min et revenu à C + 5 min : coupure brève, karaoké fini à la fin du dernier titre, mêmes présences et même indice de Jain que sans elle, avec meta comme relue sans meta ; coupé à C − 40 min, il l’est depuis 30 min à C : la fin reste la sienne', () => {
  const base = sansFin();
  const C = le16('09:00'), at = C + 3 * HOUR_MS;
  const reference = statsAt(closeOffice(base, C, at), at);
  const lastEnd = lastEndOf(reference);
  assert.equal(reference.evening.closedAt, lastEnd);
  let seq = base.seq;
  const line = (minutes, ev, fields) => ({ ...fields, v: 1, seq: ++seq, t: C + minutes * MIN_MS, ev, boot: 'coupure' });
  // KaraFun coupé de C + from à C + back (en minutes) ; application arrêtée
  // de même, notée par l'app.started de sa reprise.
  const karafun = (from, back) => [line(from, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' }),
    line(back, 'karaoke.phase', { phase: 'silent', blocker: 'empty' })];
  const app = (from, back) => [line(back, 'app.started', { restored: true, offlineMs: (back - from) * MIN_MS, version: 'v3.5.0' })];
  const presences = stats => stats.singers.map(s => [s.id, s.presenceSec]);
  for (const [name, extra, end] of [
    ['KaraFun coupé de C − 10 min à C + 5 min', karafun(-10, 5), lastEnd],
    ['application arrêtée de C − 10 min à C + 60 min', app(-10, 60), lastEnd],
    ['KaraFun coupé de C − 40 min à C + 5 min', karafun(-40, 5), C - 40 * MIN_MS],
    ['application arrêtée de C − 40 min à C + 60 min', app(-40, 60), C - 40 * MIN_MS],
  ]) {
    const evening = closeOffice({ ...base, events: [...base.events, ...extra] }, C, at);
    for (const [how, stats] of [['close d’office', statsAt(evening, at)], ['relue sans meta', statsBare(evening)]]) {
      assert.equal(stats.evening.closedAt, end, `${name}, ${how} : fin du karaoké`);
      if (end === lastEnd) {
        assert.deepEqual([stats.fairness.jain, presences(stats)], [reference.fairness.jain, presences(reference)],
          `${name}, ${how} : mêmes présences et même indice de Jain que sans elle`);
      }
    }
  }
  // Close par le bouton à C, le retour retiré (la soirée suivante l'aurait) :
  // rien ne change, la coupure sans retour lu reste durable.
  const button = statsAt(closeButton({ ...base, events: [...base.events, ...karafun(-10, 5)] }, C, { cut: true }));
  assert.equal(button.evening.closedAt, C - 10 * MIN_MS, 'close par le bouton : rien ne change');
});

test('A7 : retard de 3 h (A5) : la même soirée close d’office à C (9 h) par une remise à zéro faite 3 h plus tard, avec les lignes d’une file qui attend : computeStats exactement égal à celui de la soirée close à C sans ces lignes ; relue sans meta (rejeu-soiree.js), même fin du karaoké, même indice de Jain, mêmes titres par heure, temps mort, attente moyenne et attente sans monter sur scène ; exportEvening garde chaque ligne ; eveningBreaks n’y coupe rien ; remise à zéro au démarrage, PC éteint de 1 h 30 à 10 h : karaoké fini à 1 h 30, à l’arrêt de l’application, comme sans la règle', () => {
  const base = sansFin();
  const C = le16('09:00');
  const lastStage = base.events.filter(e => e.ev === 'stage.started').at(-1);
  // Titre de S16 encore en liste : l'envoi en cours, confirmé pendant
  // l'attente, puis retiré par le bar.
  const waiting = base.events.find(e => e.ev === 'song.requested' && e.entryId === 'eb7a3b958ba7');
  assert.equal(waiting.personId, 'S16');
  let seq = base.seq;
  const line = (minutes, ev, fields) => ({ ...fields, v: 1, seq: ++seq, t: C + minutes * MIN_MS, ev, boot: 'attente' });
  const lines = [
    line(5, 'karaoke.phase', { phase: 'between', blocker: 'evening-end' }),
    // Six téléphones revus, dont S13 et S10, sans signe depuis plus d'une
    // heure avant la fin du karaoké.
    ...['S13', 'S10', 'S11', 'S03', 'S16', 'S17'].map((id, i) => line(10 + i, 'person.seen', { personId: id })),
    line(20, 'notice.sent', { personId: 'S16', kind: 'turnSoon' }),
    line(21, 'presence.asked', { personIds: ['S16'], entryId: waiting.entryId, source: 'auto' }),
    line(22, 'turn.sent', { entryId: waiting.entryId, ids: ['S16'], ownerId: 'S16', kind: 'solo', queueId: 'attente-1', sentAt: C + 22 * MIN_MS }),
    line(23, 'song.removed', { personId: 'S16', entryId: waiting.entryId, by: 'staff' }),
    line(24, 'stage.ended', { queueId: lastStage.queueId, playedSec: 1500 }),
    line(25, 'queue.sample', { ready: 1, songsListed: 1, demanding: 1, deferred: 0, present: 12, inKaraFun: 1 }),
    line(26, 'person.left', { personId: 'S17', by: 'staff', songsDropped: 0 }),
    // Mise à jour longue : application arrêtée de C + 2 h 10 à C + 2 h 50.
    line(170, 'app.started', { restored: true, offlineMs: 40 * MIN_MS, version: 'v3.5.0' }),
  ];
  const office = statsAt(closeOffice(base, C));
  for (const id of ['S13', 'S10']) assert.ok(singerOf(office, id).leftAt < lastEndOf(office) - 30 * MIN_MS, `${id} : sans signe depuis plus d’une heure`);
  const reference = closeOffice(base, C);
  const delayed = closeOffice({ ...base, events: [...base.events, ...lines] }, C, C + 3 * HOUR_MS);
  assert.deepEqual(delayed.events.at(-1), { ...reference.events.at(-1), seq: seq + 1, t: C + 3 * HOUR_MS }, 'même ligne evening.closed, datée de C + 3 h');
  const now = C + 3 * HOUR_MS;
  assert.deepEqual(statsAt(delayed, now), statsAt(reference, now), 'computeStats rend le résultat de la soirée close à C');
  // Relue sans meta : la ligne evening.closed dit 'auto' et closedAt = C.
  const bareDelayed = statsBare(delayed), bareReference = statsBare(reference);
  for (const [name, get] of [['fin du karaoké', s => s.evening.closedAt], ['indice de Jain', s => s.fairness.jain], ['titres par heure', s => s.global.songsPerHour],
    ['temps mort', s => s.global.deadShare], ['attente moyenne', s => s.global.waitAvgSec],
    ['attente sans monter sur scène', s => s.singers.map(x => [x.id, x.stageWaits])]]) {
    assert.deepEqual(get(bareDelayed), get(bareReference), `sans meta : ${name}`);
  }
  assert.equal(bareDelayed.evening.closedAt, lastEndOf(bareReference));
  assert.equal(bareDelayed.fairness.jain, office.fairness.jain);
  // Le journal s'arrête à C (E1), même sans meta : le même résultat en tout.
  assert.deepEqual([bareDelayed.timeline.end, bareDelayed.evening.endedAt], [C, C]);
  assert.deepEqual(bareDelayed, bareReference, 'sans meta : le résultat de la soirée close à C');
  // L'export garde chaque ligne ; eveningBreaks n'y coupe rien.
  const exported = exportEvening({ ...delayed, now });
  assert.equal(exported.events.length, delayed.events.length);
  for (const e of lines) assert.ok(exported.events.some(x => x.seq === e.seq && x.ev === e.ev && x.t === e.t), `${e.ev} gardé dans l’export`);
  assert.deepEqual(eveningBreaks({ events: delayed.events, timeZone: PARIS }).cuts, []);
  // Remise à zéro au démarrage : PC éteint de 1 h 30 à 10 h, C au premier
  // calme après 8 h. Le karaoké finit à l'arrêt de l'application, comme sans
  // la règle (même journal clos par le bouton à C) ; de l'arrêt noté à 10 h,
  // seule la part d'avant C compte.
  const C8 = closurePoint({ firstActivityAt: base.firstActivityAt, events: base.events, timeZone: PARIS });
  assert.equal(C8, le16('08:00'));
  const restart = { v: 1, seq: base.seq + 1, t: le16('10:00'), ev: 'app.started', boot: 'matin', restored: true, offlineMs: 8.5 * HOUR_MS, version: 'v3.5.0' };
  const startup = { ...base, events: [...base.events, restart] };
  const atStartup = statsAt(closeOffice(startup, C8, le16('10:00') + 1000));
  assert.equal(atStartup.evening.closedAt, le16('01:30'), 'karaoké fini à 1 h 30, à l’arrêt de l’application');
  const withoutRule = { meta: { ...startup.meta, endedAt: C8, closedBy: 'staff-reset' },
    events: [...startup.events, closingOf(startup.events, le16('10:00') + 1000, { by: 'staff-reset' })] };
  assert.equal(statsAt(withoutRule).evening.closedAt, le16('01:30'), 'comme sans la règle');
  const noRestart = statsAt(closeOffice(base, C8));
  assert.equal(atStartup.quality.offlineSec - noRestart.quality.offlineSec, 6.5 * 3600, 'arrêt compté jusqu’à C');
  assert.equal(atStartup.quality.restarts, noRestart.quality.restarts, 'la reprise de 10 h, après C, n’est pas lue');
});

// ------------------------------- A4 : suites des demandes de duo de la veille
// Plan du 8 novembre, A4 (« Ce qui traverse la coupure ») : « réponses de duo
// d'avant ignorées ». Une demande de duo encore en attente à la coupure (titre
// laissé dans la liste, qui part quand KaraFun revient) n'a de suite dans le
// morceau suivant que ses citations : ni sa réponse, ni son annulation, ni son
// expiration au départ du titre, ni le duo ouvert rejoint ou fermé, ni
// l'invitée qui se retire n'y comptent dans les duos. Sinon la carte « Duos et
// Battles » montre « duos ouverts 0 · rejoints 1 » ou « invitations 0 … sans
// réponse 1 ».
const { planSplit, pieceJournal } = require('../evening-split');
// Heure de Paris le 15 octobre 2026 (heure d'été, UTC+2).
const le15 = hhmm => Date.parse(`2026-10-15T${hhmm}:00+02:00`);

test('A4 : suites des demandes de duo faites avant la coupure (invitation annulée, expirée, ou acceptée puis quittée ; demande pour rejoindre acceptée puis annulée, refusée, retirée ou expirée ; duo ouvert rejoint puis quitté, fermé ou expiré) : ignorées dans les duos du morceau suivant, même quand le titre reçoit ensuite une demande du morceau ; les mêmes suites des demandes du morceau y comptent, réponse datée d’avant sa demande comprise, l’invitée qui se retire d’un duo de la veille n’est plus sur scène, et le journal sans ligne reportée les compte toutes', () => {
  const events = [];
  const line = (t, ev, fields = {}) => events.push({ ...fields, v: 1, seq: events.length + 1, t, ev, boot: 'b1' });
  const title = (t, personId, entryId) => line(t, 'song.requested', { personId, entryId, title: entryId, mode: 'append' });
  // Une invitation ajoute son propre titre (inviteDuet).
  const invite = (t, ownerId, partnerId, entryId) => {
    title(t, ownerId, entryId);
    line(t + 1, 'duo.invited', { personId: ownerId, entryId, ownerId, partnerId, sameGroup: false });
  };
  const askJoin = (t, requesterId, ownerId, entryId) => line(t, 'duo.joinRequested', { requesterId, ownerId, entryId, direct: false });
  const open = (t, personId, entryId) => line(t, 'duo.openRequested', { personId, entryId, fromCatalog: false });
  let queueId = 0;
  // Titre envoyé à KaraFun, puis chanté.
  const sing = (t, entryId, ids) => {
    line(t, 'turn.sent', { entryId, ids, ownerId: ids[0], kind: ids.length > 1 ? 'duo' : 'solo', queueId: ++queueId, sentAt: t });
    line(t + MIN_MS, 'stage.started', { queueId, entryId, ids, ownerId: ids[0], source: 'queue', title: entryId });
    line(t + 5 * MIN_MS, 'stage.ended', { queueId, playedSec: 240 });
  };
  // Jeudi : a et b à la table 1, c et d à la table 2 (jamais le même groupe :
  // chaque demande attend sa réponse), un titre chanté.
  const people = [['a', '1'], ['b', '1'], ['c', '2'], ['d', '2']];
  line(le15('19:00'), 'evening.started', { rules: {} });
  line(le15('19:00') + 1, 'app.started', { restored: false, offlineMs: 0 });
  line(le15('19:01'), 'karaoke.phase', { phase: 'silent', blocker: 'empty' });
  line(le15('19:05'), 'table.opened', { tableId: '1', individual: false });
  line(le15('19:06'), 'table.opened', { tableId: '2', individual: false });
  people.forEach(([personId, tableId], i) => line(le15('19:10') + i, 'person.joined', { personId, tableId }));
  title(le15('19:30'), 'a', 'e0');
  sing(le15('19:34'), 'e0', ['a']);
  // Demandes encore en attente à la coupure : trois invitations, quatre
  // demandes pour rejoindre un titre, trois duos ouverts (un par personne).
  invite(le15('23:00'), 'a', 'c', 'v1');
  invite(le15('23:01'), 'b', 'd', 'v2');
  invite(le15('23:02'), 'c', 'a', 'v3');
  [['a', 'c', 'j1'], ['b', 'd', 'j2'], ['c', 'a', 'j3'], ['d', 'b', 'j4']].forEach(([ownerId, requesterId, entryId], i) => {
    title(le15('23:10') + i * MIN_MS, ownerId, entryId);
    askJoin(le15('23:10') + i * MIN_MS + 1, requesterId, ownerId, entryId);
  });
  [['a', 'o1'], ['b', 'o2'], ['c', 'o3']].forEach(([personId, entryId], i) => {
    title(le15('23:20') + i * MIN_MS, personId, entryId);
    open(le15('23:20') + i * MIN_MS + 1, personId, entryId);
  });
  line(le16('01:10'), 'karaoke.phase', { phase: 'unknown', blocker: 'offline' });
  // Vendredi, KaraFun revenu : les suites des demandes de la veille.
  line(le16('18:30'), 'karaoke.phase', { phase: 'silent', blocker: 'empty' });
  line(le16('19:00'), 'duo.cancelled', { personId: 'a', entryId: 'v1', ownerId: 'a', partnerId: 'c' });
  line(le16('19:01'), 'duo.answered', { personId: 'a', entryId: 'v3', ownerId: 'c', partnerId: 'a', accepted: true });
  line(le16('19:02'), 'duo.left', { ownerId: 'c', guestId: 'a', entryId: 'v3', sent: false });
  line(le16('19:03'), 'duo.joinAnswered', { personId: 'a', ownerId: 'a', requesterId: 'c', entryId: 'j1', accepted: true });
  line(le16('19:04'), 'duo.cancelled', { personId: 'a', entryId: 'j1', ownerId: 'a', partnerId: 'c' });
  line(le16('19:05'), 'duo.joinAnswered', { personId: 'b', ownerId: 'b', requesterId: 'd', entryId: 'j2', accepted: false });
  line(le16('19:06'), 'duo.joinCancelled', { requesterId: 'a', ownerId: 'c', entryId: 'j3' });
  line(le16('19:07'), 'duo.openAccepted', { personId: 'd', ownerId: 'a', partnerId: 'd', entryId: 'o1' });
  line(le16('19:08'), 'duo.openClosed', { personId: 'b', ownerId: 'b', entryId: 'o2', reason: 'self' });
  // Titres de la veille partis en solo : leur demande expire.
  line(le16('19:20'), 'duo.inviteExpired', { ownerId: 'b', partnerId: 'd', entryId: 'v2' });
  sing(le16('19:20') + 1, 'v2', ['b']);
  line(le16('19:30'), 'duo.joinExpired', { ownerId: 'd', requesterId: 'b', entryId: 'j4', reason: 'sent' });
  sing(le16('19:30') + 1, 'j4', ['d']);
  line(le16('19:40'), 'duo.openExpired', { ownerId: 'c', entryId: 'o3' });
  sing(le16('19:40') + 1, 'o3', ['c']);
  // Duo ouvert de la veille rejoint par d, déjà dans KaraFun quand elle se
  // retire : le passage noté avec les deux noms ne la compte plus.
  line(le16('19:50'), 'turn.sent', { entryId: 'o1', ids: ['a', 'd'], ownerId: 'a', kind: 'duo', queueId: ++queueId, sentAt: le16('19:50') });
  line(le16('19:50') + 1, 'duo.left', { ownerId: 'a', guestId: 'd', entryId: 'o1', sent: true, by: 'guest' });
  line(le16('19:51'), 'stage.started', { queueId, entryId: 'o1', ids: ['a', 'd'], ownerId: 'a', source: 'queue', title: 'o1' });
  line(le16('19:55'), 'stage.ended', { queueId, playedSec: 240 });
  // Demandes du morceau et leurs suites. Trois sur un titre de la veille dont
  // la demande vient de finir (v1, o2, j2) : la suite de celle-ci, écrite
  // avant elles, ne compte toujours pas.
  invite(le16('20:00'), 'a', 'c', 'w1');
  line(le16('20:01'), 'duo.cancelled', { personId: 'a', entryId: 'w1', ownerId: 'a', partnerId: 'c' });
  invite(le16('20:02'), 'b', 'd', 'w2');
  invite(le16('20:03'), 'c', 'a', 'w3');
  line(le16('20:04'), 'duo.answered', { personId: 'a', entryId: 'w3', ownerId: 'c', partnerId: 'a', accepted: true });
  line(le16('20:05'), 'duo.left', { ownerId: 'c', guestId: 'a', entryId: 'w3', sent: false });
  askJoin(le16('20:10'), 'c', 'a', 'v1');
  line(le16('20:11'), 'duo.joinAnswered', { personId: 'a', ownerId: 'a', requesterId: 'c', entryId: 'v1', accepted: true });
  line(le16('20:12'), 'duo.cancelled', { personId: 'a', entryId: 'v1', ownerId: 'a', partnerId: 'c' });
  open(le16('20:15'), 'b', 'o2');
  line(le16('20:16'), 'duo.openAccepted', { personId: 'c', ownerId: 'b', partnerId: 'c', entryId: 'o2' });
  line(le16('20:17'), 'duo.cancelled', { personId: 'b', entryId: 'o2', ownerId: 'b', partnerId: 'c' });
  // Réponse écrite après sa demande mais datée d'avant elle (heure du PC
  // reculée de 2 min) : elle y répond quand même, comme pour une invitation.
  askJoin(le16('20:20'), 'd', 'b', 'j2');
  line(le16('20:18'), 'duo.joinAnswered', { personId: 'b', ownerId: 'b', requesterId: 'd', entryId: 'j2', accepted: false });
  title(le16('20:25'), 'd', 'w4');
  askJoin(le16('20:26'), 'a', 'd', 'w4');
  line(le16('20:27'), 'duo.joinCancelled', { requesterId: 'a', ownerId: 'd', entryId: 'w4' });
  askJoin(le16('20:28'), 'c', 'd', 'w4');
  title(le16('20:30'), 'c', 'w5');
  open(le16('20:30') + 1, 'c', 'w5');
  line(le16('20:31'), 'duo.openClosed', { personId: 'c', ownerId: 'c', entryId: 'w5', reason: 'self' });
  title(le16('20:32'), 'a', 'w6');
  open(le16('20:32') + 1, 'a', 'w6');
  line(le16('21:00'), 'duo.inviteExpired', { ownerId: 'b', partnerId: 'd', entryId: 'w2' });
  sing(le16('21:00') + 1, 'w2', ['b']);
  line(le16('21:10'), 'duo.joinExpired', { ownerId: 'd', requesterId: 'c', entryId: 'w4', reason: 'sent' });
  sing(le16('21:10') + 1, 'w4', ['d']);
  line(le16('21:20'), 'duo.openExpired', { ownerId: 'a', entryId: 'w6' });
  sing(le16('21:20') + 1, 'w6', ['a']);

  const meta = { format: 'karaoke-evening-meta', version: 1, eveningId: '2026-10-15_1900_ab12', startedAt: events[0].t, endedAt: null,
    timezone: PARIS, roster: Object.fromEntries(people.map(([id, tableId]) => [id, { name: `Prénom ${id}`, tableId }])),
    tables: { 1: { name: 'Table 1', individual: false }, 2: { name: 'Table 2', individual: false } } };
  const C = le16('08:00');
  assert.deepEqual(eveningBreaks({ events, timeZone: PARIS, startedAt: meta.startedAt }).cuts, [C], 'deux nuits, coupure vendredi à 8 h');
  const [first, second] = planSplit({ meta, events, cuts: [C], citedIds }).pieces;
  const requests = lines => lines.filter(e => ['duo.invited', 'duo.joinRequested', 'duo.openRequested'].includes(e.ev)).map(e => e.entryId);
  assert.deepEqual(requests(first.lines), ['v1', 'v2', 'v3', 'j1', 'j2', 'j3', 'j4', 'o1', 'o2', 'o3'], 'demandes de la veille au premier morceau');
  assert.deepEqual(second.carried.filter(e => e.ev === 'person.joined').map(e => e.personId).sort(), ['a', 'b', 'c', 'd'],
    'personnes citées dans le morceau, donc reportées : aucune de ses lignes n’est ignorée');
  const journal = pieceJournal(second);
  const stats = computeStats({ meta: second.meta, events: journal, now: journal.at(-1).t });
  const none = { declined: 0, improvised: 0, improvisedCancelled: 0, improvisedReplaced: 0, improvisedStages: 0 };
  // Seules les suites des demandes du morceau comptent : une de chaque sorte,
  // et trois annulations (w1, et les duos de v1 et de o2 formés dans le morceau).
  assert.deepEqual(stats.global.duos, { ...none, invites: 3, accepted: 1, cancelled: 3, inviteExpired: 1, left: 1,
    joinRequests: 4, joinAccepted: 1, joinDeclined: 1, joinCancelled: 1, joinExpired: 1,
    openRequests: 3, openAccepted: 1, openClosed: 1, openExpired: 1 });
  // d s'est retirée du duo ouvert de la veille : elle ne compte pas sur scène.
  assert.deepEqual(stats.timeline.stages.find(st => st.entryId === 'o1').ids, ['a']);
  assert.equal(singerOf(stats, 'd').guestTurns, 0);
  // Le journal fusionné, sans ligne reportée : toutes les suites comptent, comme avant.
  const merged = computeStats({ meta, events, now: events.at(-1).t });
  assert.deepEqual(merged.global.duos, { ...none, invites: 6, accepted: 2, cancelled: 5, inviteExpired: 2, left: 3,
    joinRequests: 8, joinAccepted: 2, joinDeclined: 2, joinCancelled: 2, joinExpired: 2,
    openRequests: 6, openAccepted: 2, openClosed: 2, openExpired: 2 });
  assert.deepEqual(merged.timeline.stages.find(st => st.entryId === 'o1').ids, ['a']);
});
