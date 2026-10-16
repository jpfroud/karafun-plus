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
