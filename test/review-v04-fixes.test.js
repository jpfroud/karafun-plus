'use strict';
// Régressions trouvées à la relecture de la v0.4 : relance du titre, « Pas
// prêt », duo improvisé, fermeture, Spotify et paroles. Tout est simulé : un
// faux pont KaraFun qui ne respecte pas toujours les commandes, comme le
// ferait une version non vérifiée du vrai KaraFun.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');
const { SpotifyLink } = require('../spotify');
const { Lyrics } = require('../lyrics');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

// Même harnais que staff-duo-tracked-api.test.js, avec un faux pont KaraFun injectable.
function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const context = { require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console, Buffer, URL, setTimeout, setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, tracked, settings, handlers, access, spotify, spotifyAutomation, spotifyTick, sync, analyze,
      startRestart, syncRestart, deferTurn, staffState, nextClosing, clearEvening, publicState, assertRoomBeforeClosing,
      restart: () => restartOp, setBridge: b => { bridge = b; }, setPending: p => { pending = p; }, getPending: () => pending };
  `, context, { filename: 'server.js' });
  context.fixture.settings.auto = false;
  context.fixture.settings.autoPlay = false;
  return context.fixture;
}

function fakeBridge(queue, playingId) {
  const calls = [];
  return { calls, ready: true, connected: true, queue, events: [], snapshot: () => ({ ready: true, connected: true, queue, events: [] }),
    status: playingId == null ? { state: 'idle' } : { state: 'playing', songPlaying: { queueId: playingId } },
    add: (songId, singer, pos) => calls.push(['add', pos]), remove: id => calls.push(['remove', id]),
    next: () => calls.push(['next']), play: () => calls.push(['play']) };
}

// Alice chante (suivie, queueId 1), Bruno est chargé ensuite (queueId 2).
function onStage(f) {
  const a = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const b = f.sched.join({ tableId: '2', name: 'Bruno', headcount: 1 });
  f.sched.chooseSong(a, { songId: 70001, title: 'En cours' });
  f.sched.chooseSong(b, { songId: 70002, title: 'Suivant' });
  const stage = f.sched.select(); f.sched.commit(stage);
  const live = { queueId: 1, sel: stage, startedAt: Date.now() - 30000, addedAt: Date.now() - 60000 };
  f.tracked.push(live);
  const queue = [{ queueId: 1, songId: 70001, title: 'En cours', singer: stage.label, status: 'playing' },
    { queueId: 2, songId: 70002, title: 'Suivant', singer: 'Bruno · Table 2' }];
  const bridge = fakeBridge(queue, 1);
  f.setBridge(bridge);
  return { a, b, stage, live, queue, bridge };
}

// KaraFun place la copie juste après le titre en cours (queueId 3).
const copyAfterCurrent = (bridge, queue) => {
  bridge.add = (songId, singer, pos) => { bridge.calls.push(['add', pos]); queue.splice(pos, 0, { queueId: 3, songId, singer }); };
};

// ---------------------------------------------------------------- relancer depuis le début
test('relance : copie mal placée par KaraFun retirée, jamais de « Suivant »', () => {
  const f = harness();
  const { queue, bridge } = onStage(f);
  bridge.add = (songId, singer, pos) => { bridge.calls.push(['add', pos]); queue.push({ queueId: 3, songId, singer }); };
  f.startRestart();
  f.syncRestart(f.analyze(), Date.now());
  assert.deepEqual(bridge.calls, [['add', 1], ['remove', 3]]);
  assert.equal(f.restart(), null);
  assert.ok(f.sched.log.some(l => /relance annulée/.test(l.msg)));
});

test('relance : copie arrivée après le délai de 15 s retirée, rien n’est passé', () => {
  const f = harness();
  const { stage, queue, bridge } = onStage(f);
  f.startRestart();
  const t0 = Date.now();
  f.syncRestart(f.analyze(), t0 + 15001);
  assert.equal(f.restart(), null);
  queue.splice(1, 0, { queueId: 5, songId: 70001, singer: stage.label }); // accusé tardif
  f.syncRestart(f.analyze(), t0 + 16000);
  assert.deepEqual(bridge.calls, [['add', 1], ['remove', 5]], 'la copie tardive ne rejouera pas le titre');
  f.syncRestart(f.analyze(), t0 + 17000);
  assert.equal(bridge.calls.length, 2, 'un seul retrait demandé');
});

test('relance : « Suivant » refusé, la copie est retirée et le titre en cours garde son suivi', () => {
  const f = harness();
  const { live, queue, bridge } = onStage(f);
  copyAfterCurrent(bridge, queue);
  bridge.next = () => { throw new Error('KaraFun occupé'); };
  f.startRestart();
  f.syncRestart(f.analyze(), Date.now());
  assert.equal(live.queueId, 1, 'suivi rendu au titre en cours');
  assert.deepEqual(bridge.calls, [['add', 1], ['remove', 3]]);
  assert.equal(f.restart(), null);
});

test('relance : KaraFun ignore « Suivant » pendant 20 s, la copie est retirée', () => {
  const f = harness();
  const { live, queue, bridge } = onStage(f);
  copyAfterCurrent(bridge, queue);
  f.startRestart();
  const t0 = Date.now();
  f.syncRestart(f.analyze(), t0);
  assert.equal(live.queueId, 3, 'suivi passé à la copie');
  f.syncRestart(f.analyze(), t0 + 20001);
  assert.equal(live.queueId, 1);
  assert.deepEqual(bridge.calls, [['add', 1], ['next'], ['remove', 3]]);
  assert.ok(f.sched.log.some(l => /La relance n’a pas démarré\. Le titre en cours continue\./.test(l.msg)));
});

// Regression: seconde passe adversariale — un nouvel essai dans la minute
// prenait sa propre copie pour une copie tardive, la retirait puis passait
// au titre suivant, coupant le chanteur sur scène.
test('relance : nouvel essai refusé tant qu’une copie de l’essai raté peut arriver', () => {
  const f = harness();
  const { queue, bridge } = onStage(f);
  bridge.add = (songId, singer, pos) => { bridge.calls.push(['add', pos]); queue.push({ queueId: 3, songId, singer }); };
  f.startRestart();
  f.syncRestart(f.analyze(), Date.now());
  assert.equal(f.restart(), null, 'premier essai abandonné');
  assert.throws(() => f.startRestart(), /relance précédente vient d’échouer/);
  assert.ok(f.staffState().restartRetryAt > Date.now(), 'bouton du bar désactivé pendant ce temps');
  assert.ok(!bridge.calls.some(c => c[0] === 'next'), 'jamais de Suivant');
});

// Regression: troisième passe adversariale — au moment où le bouton revient,
// l'ancienne surveillance expirée retirait encore la nouvelle copie.
test('relance : nouvel essai après la minute d’attente, la nouvelle copie n’est pas retirée', () => {
  const f = harness();
  const { queue, bridge } = onStage(f);
  let next = 3;
  bridge.add = (songId, singer, pos) => { bridge.calls.push(['add', pos]); queue.push({ queueId: next++, songId, singer }); };
  f.startRestart();
  f.syncRestart(f.analyze(), Date.now() - 61000); // essai raté il y a plus d’une minute
  queue.splice(queue.findIndex(item => item.queueId === 3), 1); // KaraFun a retiré la copie mal placée
  bridge.calls.length = 0;
  bridge.add = (songId, singer, pos) => { bridge.calls.push(['add', pos]); queue.splice(pos, 0, { queueId: 7, songId, singer }); };
  f.startRestart();
  f.syncRestart(f.analyze(), Date.now());
  assert.deepEqual(bridge.calls, [['add', 1], ['next']], 'la nouvelle copie est gardée et lancée');
});

test('relance : le titre quitte la file avant l’état de lecture, rien n’est décidé avant la suite', () => {
  const f = harness();
  const { queue, bridge } = onStage(f);
  copyAfterCurrent(bridge, queue);
  f.startRestart();
  queue.shift(); // QueueEvent arrivé avant StatusEvent : KaraFun annonce encore le titre fini
  const t0 = Date.now();
  f.syncRestart(f.analyze(), t0);
  assert.deepEqual(bridge.calls, [['add', 1]], 'ni Suivant ni Lecture tant que l’état est ambigu');
  bridge.status = { state: 'idle' };
  f.syncRestart(f.analyze(), t0 + 500);
  assert.deepEqual(bridge.calls, [['add', 1], ['play']]);
});

test('relance : titre fini seul et KaraFun à l’arrêt, la copie est lancée sans « Suivant »', () => {
  const f = harness();
  const { live, queue, bridge } = onStage(f);
  copyAfterCurrent(bridge, queue);
  f.startRestart();
  queue.shift();
  bridge.status = { state: 'idle' };
  const t0 = Date.now();
  f.syncRestart(f.analyze(), t0);
  assert.deepEqual(bridge.calls, [['add', 1], ['play']], 'lecture, pas de Suivant qui sauterait la copie');
  queue[0].status = 'playing';
  bridge.status = { state: 'playing', songPlaying: { queueId: 3 } };
  f.syncRestart(f.analyze(), t0 + 1000);
  assert.equal(live.queueId, 3);
  assert.equal(live.startedAt, t0 + 1000, 'durée mesurée depuis la relance');
  assert.equal(f.restart(), null);
});

test('relance : titre fini seul pendant l’ajout, la copie qui joue garde le passage', () => {
  const f = harness();
  const { live, queue, bridge } = onStage(f);
  copyAfterCurrent(bridge, queue);
  f.startRestart();
  queue.shift();
  bridge.status = { state: 'playing', songPlaying: { queueId: 3 } };
  f.syncRestart(f.analyze(), Date.now());
  assert.equal(live.queueId, 3);
  assert.deepEqual(bridge.calls, [['add', 1]], 'ni retrait de la copie qui joue, ni Suivant');
  assert.equal(f.restart(), null);
  assert.ok(f.sched.log.some(l => /repart du début/.test(l.msg)));
});

test('relance : Suivant fait mais lecture arrêtée, la copie prête reste et le bar est prévenu', () => {
  const f = harness();
  const { live, queue, bridge } = onStage(f);
  copyAfterCurrent(bridge, queue);
  f.startRestart();
  const t0 = Date.now();
  f.syncRestart(f.analyze(), t0);
  queue.shift();
  bridge.status = { state: 'idle' };
  f.syncRestart(f.analyze(), t0 + 3000);
  f.syncRestart(f.analyze(), t0 + 20001);
  assert.equal(live.queueId, 3);
  assert.deepEqual(bridge.calls, [['add', 1], ['next'], ['play']]);
  assert.ok(f.sched.log.some(l => /lance la lecture dans KaraFun/.test(l.msg)));
  f.setBridge({ ready: false });
  assert.throws(() => f.startRestart(), /déconnecté/);
});

// ---------------------------------------------------------------- « Pas prêt »
function loadedNext(f) {
  const ctx = onStage(f);
  const loaded = f.sched.select(); f.sched.commit(loaded);
  const next = { queueId: 2, sel: loaded, startedAt: null, addedAt: Date.now() };
  f.tracked.push(next);
  ctx.queue[1].singer = loaded.label;
  return { ...ctx, loaded, next, who: f.sched.people.get(loaded.ids[0]) };
}

test('« Pas prêt » sur un titre chargé, KaraFun déconnecté : rien ne change', () => {
  const f = harness();
  const { who } = loadedNext(f);
  f.setBridge(null);
  f.sched.manualOrder = [...f.sched.Q]; f.sched.manualOrderActive = true;
  const logLen = f.sched.log.length;
  assert.throws(() => f.deferTurn(who, 1), /déconnecté/);
  assert.equal(who.deferral ?? null, null);
  assert.equal(f.sched.manualOrderActive, true, 'ordre manuel du bar conservé');
  assert.ok(!f.sched.log.slice(logLen).some(l => /pas encore prêt/.test(l.msg)), 'pas de faux report au journal');
});

test('« Pas prêt » : retrait refusé par KaraFun connecté, rien ne change non plus', () => {
  const f = harness();
  const { bridge, who, next } = loadedNext(f);
  bridge.remove = () => { throw new Error('socket fermée'); };
  f.sched.manualOrder = [...f.sched.Q]; f.sched.manualOrderActive = true;
  const logLen = f.sched.log.length;
  assert.throws(() => f.deferTurn(who, 1), /socket fermée/);
  assert.equal(who.deferral ?? null, null);
  assert.equal(f.sched.deferredSongsOf(next.sel.song), 0);
  assert.equal(f.sched.manualOrderActive, true);
  assert.equal(next.pulled ?? null, null);
  assert.ok(!f.sched.log.slice(logLen).some(l => /pas encore prêt/.test(l.msg)));
});

test('« Pas prêt » : KaraFun lance le titre avant son retrait, il est chanté sans report fantôme', () => {
  const f = harness();
  const { next, queue, bridge, who } = loadedNext(f);
  f.deferTurn(who, 1);
  assert.ok(next.pulled);
  assert.ok(bridge.calls.some(c => c[0] === 'remove' && c[1] === 2));
  queue.shift(); bridge.status = { state: 'playing', songPlaying: { queueId: 2 } };
  f.sync();
  assert.equal(next.pulled, null, 'le titre lancé continue');
  assert.ok(next.startedAt);
  assert.equal(who.deferral ?? null, null);
});

test('« Pas prêt » : KaraFun garde le titre à retirer, le bar est prévenu une fois', () => {
  const f = harness();
  const { next, who } = loadedNext(f);
  f.deferTurn(who, 1);
  const view = f.publicState(null, '2').tablePeople.find(p => p.id === who.id);
  assert.equal(view.deferral.pendingRemoval, true);
  assert.equal(view.deferral.canDeferMore, false, 'pas d’« Encore une chanson » pendant le retrait');
  next.pulled.at = Date.now() - 46000;
  f.sync(); f.sync();
  assert.equal(f.sched.log.filter(l => /n’a pas retiré « Suivant »/.test(l.msg)).length, 1);
});

// ---------------------------------------------------------------- duo improvisé
test('duo improvisé : seul le titre du partenaire est retiré, pas le duo d’un autre où il est invité', async () => {
  const f = harness();
  const { b, live, queue, bridge } = onStage(f);
  const c = f.sched.join({ tableId: '3', name: 'Chloé', headcount: 1 });
  f.sched.chooseSong(c, { songId: 70003, title: 'Duo de Chloé' });
  const own = f.sched.select(); f.sched.commit(own); // titre de Bruno
  const other = { ids: [c.id, b.id], consumedIds: [c.id], names: ['Chloé', 'Bruno'], label: 'Chloé & Bruno · Table 3 + Table 2',
    kind: 'duo', song: c.song, group: c.group, groups: [c.group, b.group] };
  const mine = { queueId: 2, sel: own, startedAt: null, addedAt: Date.now() };
  const theirs = { queueId: 4, sel: other, startedAt: null, addedAt: Date.now() };
  f.tracked.push(mine, theirs);
  queue.push({ queueId: 4, songId: 70003, singer: other.label });
  const r = await f.handlers['POST /api/staff/duo-mark'](null, null, { queueId: live.queueId, partnerId: b.id });
  assert.equal(r.moved, 1);
  assert.equal(mine.pulled?.reason, 'duo');
  assert.equal(theirs.pulled ?? null, null, 'le duo de Chloé garde sa place');
  assert.deepEqual(bridge.calls, [['remove', 2]]);
});

test('duo improvisé pendant l’envoi du titre du partenaire : retrait à l’accusé', async () => {
  const f = harness();
  const { b, live } = onStage(f);
  const following = f.sched.select();
  assert.equal(following.ids[0], b.id);
  f.setPending({ sel: following, before: new Set([1, 2]), at: Date.now() });
  const r = await f.handlers['POST /api/staff/duo-mark'](null, null, { queueId: live.queueId, partnerId: b.id });
  assert.equal(r.moved, 1);
  assert.equal(f.getPending().pullOnAck, 'duo');
});

test('demande de duo refusée sur un titre en cours d’envoi à KaraFun', async () => {
  const f = harness();
  const { b } = onStage(f);
  const z = f.sched.join({ tableId: '4', name: 'Zoé', headcount: 1 });
  const following = f.sched.select();
  f.setPending({ sel: following, before: new Set([1, 2]), at: Date.now() });
  const secret = f.access.issue('4');
  await assert.rejects(f.handlers['POST /api/table/duet/join'](null, null,
    { table: '4', access: secret, personId: z.id, token: z.token, ownerId: b.id, entryId: following.song.entryId }), /en cours d’envoi/);
  assert.equal(b.song.duet ?? null, null);
});

// ---------------------------------------------------------------- fermeture
test('fermeture : passage de minuit, heure dépassée et formats refusés', () => {
  const { nextClosing } = harness();
  const at = (d, h, m) => new Date(2026, 9, d, h, m).getTime();
  assert.equal(nextClosing('02:00', at(2, 23, 30)), at(3, 2, 0), 'annoncé à 23:30 : cette nuit');
  assert.equal(nextClosing('23:00', at(3, 1, 0)), at(2, 23, 0), 'dépassée depuis moins de 3 h : atteinte');
  assert.equal(nextClosing('21:30', at(3, 1, 0)), at(3, 21, 30), 'dépassée depuis plus de 3 h : prochaine occurrence');
  assert.equal(nextClosing('2:05', at(2, 22, 0)), at(3, 2, 5));
  for (const bad of ['24:00', '12:60', '1200', '', '12:5']) assert.throws(() => nextClosing(bad, at(2, 22, 0)), /HH:MM/);
});

test('fermeture : effacée par « Nouvelle soirée », oubliée au bout de six heures', () => {
  const f = harness();
  f.settings.closingAt = Date.now() - 7 * 3600000;
  assert.equal(f.publicState(null, null).closing, null, 'heure de la veille ignorée');
  f.settings.closingAt = Date.now() + 3600000;
  assert.ok(f.publicState(null, null).closing);
  f.clearEvening();
  assert.equal(f.settings.closingAt, null);
});

test('fermeture : un titre de plus refusé s’il passerait après, nouveaux chanteurs encore accueillis', async () => {
  const f = harness();
  const people = ['Alice', 'Bruno', 'Chloé'].map((name, i) => {
    const p = f.sched.join({ tableId: String(i + 1), name, headcount: 1 });
    f.sched.chooseSong(p, { songId: 70001 + i, title: `Titre ${i}` });
    return p;
  });
  const slot = f.sched.avgSlotSec() * 1000;
  f.settings.closingAt = Date.now() + 3.6 * slot;
  const round = f.publicState(null, null).queue.filter(item => !item.future);
  assert.equal(round.length, 3);
  assert.equal(f.publicState(null, null).closing.full, false);
  const first = f.sched.people.get(round[0].ids[0]);
  const last = f.sched.people.get(round[2].ids[0]);
  f.assertRoomBeforeClosing(first, 'append');
  assert.throws(() => f.assertRoomBeforeClosing(last, 'append'), error => error.code === 'CLOSING' && /après la fermeture/.test(error.message));
  f.assertRoomBeforeClosing(f.sched.join({ tableId: '4', name: 'Zoé', headcount: 1 }), 'append');
  f.settings.closingAt = Date.now() - 60000;
  await assert.rejects(f.handlers['POST /api/duet'](null, null, { partnerId: people[1].id, song: { songId: 9, title: 'Duo' } }, people[0]),
    error => error.code === 'CLOSING', 'ancienne route d’invitation en duo soumise à la fermeture');
});

// Regression: premier essai réel — les titres marqués « Après la fermeture »
// partaient quand même dans KaraFun et y étaient lancés ; le bar devait
// mettre KaraFun en pause et relancer Spotify à la main.
test('fermeture : heure atteinte, plus aucun titre envoyé à KaraFun, envoi repris après un décalage', async () => {
  const f = harness();
  const a = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  f.sched.chooseSong(a, { songId: 70001, title: 'Après l’heure' });
  const bridge = fakeBridge([], null);
  f.setBridge(bridge);
  f.settings.auto = true;
  f.settings.closingAt = Date.now() - 60000;
  f.sync(); f.sync();
  assert.deepEqual(bridge.calls, [], 'rien n’est envoyé à KaraFun après l’heure');
  assert.equal(f.getPending(), null);
  assert.equal(a.song.title, 'Après l’heure', 'le titre reste prévu si le bar décale l’heure');
  assert.equal(f.sched.log.filter(l => /plus aucun titre n’est envoyé/.test(l.msg)).length, 1, 'le bar est prévenu une fois');
  await f.handlers['POST /api/staff/closing'](null, null, { extendMin: 30 });
  f.sync();
  assert.deepEqual(bridge.calls.map(c => c[0]), ['add'], '« +30 min » : le titre part');
});

test('fermeture : un titre déjà chargé qui commencerait après l’heure est retiré de KaraFun, sans couper la scène', () => {
  const f = harness();
  const { next, queue, bridge, who } = loadedNext(f);
  f.settings.auto = true;
  const slot = f.sched.avgSlotSec() * 1000;
  // Alice finit dans un tiers de chanson : Bruno commencerait trop tard.
  f.settings.closingAt = Date.now() + slot / 4;
  f.sync();
  assert.deepEqual(bridge.calls, [['remove', 2]], 'seul le titre suivant est retiré, jamais « Suivant »');
  assert.equal(next.pulled?.reason, 'closing');
  f.sync();
  assert.equal(bridge.calls.length, 1, 'un seul retrait demandé');
  queue.splice(1, 1); // KaraFun retire le titre
  f.sync();
  assert.ok(!f.publicState(null, null).queue.some(item => item.queueId === 2), 'plus suivi dans la file');
  assert.equal(who.song?.title, 'Suivant', 'Bruno garde son titre pour un éventuel décalage');
  assert.ok(f.sched.log.some(l => /« Suivant ».*passerait après la fermeture/.test(l.msg)));
  assert.ok(!bridge.calls.some(c => c[0] === 'add'), 'rien ne le remplace');
});

test('fermeture : un titre qui tient avant l’heure reste chargé', () => {
  const f = harness();
  const { next, bridge } = loadedNext(f);
  f.settings.auto = true;
  f.settings.closingAt = Date.now() + 3 * f.sched.avgSlotSec() * 1000;
  f.sync();
  assert.deepEqual(bridge.calls, []);
  assert.equal(next.pulled ?? null, null);
});

test('fermeture : KaraFun refuse le retrait, le titre d’après l’heure n’est pas lancé automatiquement', () => {
  const f = harness();
  const a = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  f.sched.chooseSong(a, { songId: 70001, title: 'Trop tard' });
  const sel = f.sched.select(); f.sched.commit(sel);
  f.tracked.push({ queueId: 7, sel, startedAt: null, addedAt: Date.now() - 60000 });
  const bridge = fakeBridge([{ queueId: 7, songId: 70001, title: 'Trop tard', singer: sel.label }], null);
  bridge.remove = id => { bridge.calls.push(['remove', id]); throw new Error('KaraFun occupé'); };
  f.setBridge(bridge);
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 0;
  f.settings.closingAt = Date.now() - 60000;
  f.sync(); f.sync();
  assert.ok(!bridge.calls.some(c => c[0] === 'play'), 'pas de lancement après l’heure');
});

test('fermeture : Spotify reprend dans le silence d’après l’heure, même sans reprise automatique', async () => {
  const f = harness();
  let now = Date.now();
  f.spotifyAutomation.now = () => now;
  const plays = [];
  f.spotify.fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/token')) return json({ access_token: 't', expires_in: 3600 });
    if (url.endsWith('/me/player')) return json({ is_playing: false, device: { id: 'pc', name: 'PC' } });
    if (url.includes('/me/player/play')) { plays.push(now); return { ok: true, status: 204, text: async () => '' }; }
    if (url.includes('/me/player/pause')) return { ok: true, status: 204, text: async () => '' };
    throw new Error(`inattendu : ${url}`);
  };
  f.spotify.config = { ...f.spotify.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'r', autoResume: false, autoPause: true, resumeDelaySec: 15 };
  f.setBridge({ ready: true, connected: true, queue: [], status: { state: 'idle' }, events: [] });
  await f.spotifyTick();
  now += 16000;
  await f.spotifyTick();
  assert.deepEqual(plays, [], 'avant l’heure, le réglage du bar est respecté');
  f.settings.closingAt = Date.now() - 60000;
  now += 1000;
  await f.spotifyTick();
  assert.equal(plays.length, 1, 'fermeture atteinte et scène libre : la musique du bar revient');
});

// ---------------------------------------------------------------- ordonnanceur
let n = 1;
const song = () => ({ songId: n, title: `Titre ${n++}`, artist: 'Essai' });
function evening(opts = {}) {
  const s = new Scheduler(opts);
  const ppl = [];
  for (let i = 1; i <= 5; i++) { const p = s.join({ tableId: String(i), name: `P${i}`, headcount: 1 }); s.chooseSong(p, song()); ppl.push(p); }
  const names = v => v.map(x => x.ids.map(pid => s.people.get(pid).name).join('&'));
  const firsts = () => s.presenceView().filter(x => !x.future);
  return { s, ppl, names, firsts };
}

test('« Je suis là » obligatoire : un passage repoussé n’est pas compté absent', () => {
  const { s, firsts } = evening({ requirePresence: true });
  const [head, second, third] = firsts();
  const deferred = s.people.get(head.ids[0]);
  s.deferPassage(deferred.id, head, 2);
  s.confirm(s.people.get(third.ids[0]));
  const sel = s.select();
  assert.equal(sel.ids[0], third.ids[0]);
  s.commit(sel);
  assert.equal(deferred.held, 0, 'le report n’est pas une absence');
  assert.equal(s.people.get(second.ids[0]).held, 1, 'celui qui n’a pas confirmé devant compte bien');
});

test('« Je suis prêt » n’est pas défait quand le passage suivant n’est finalement pas chanté', () => {
  const { s, firsts } = evening();
  const [head] = firsts();
  const p = s.people.get(head.ids[0]);
  s.deferPassage(p.id, head, 2);
  const sel = s.select(); s.commit(sel);
  assert.equal(p.deferral.remaining, 1);
  s.cancelDeferral(p.id);
  s.rollbackUnplayed(sel, { requeue: true });
  assert.equal(p.deferral, null);
  assert.equal(s.deferralFor(p.id), null);
});

// Déplacement noté comme le fait la route du bar (POST /api/staff/move).
function staffMoveRecorded(s, person, toIndex) {
  const before = s.manualOverrideState({ deferrals: true });
  s.staffMove(person.id, toIndex);
  s.recordManualChange({ kind: toIndex === 0 ? 'priority' : 'move', personId: person.id, name: person.name,
    from: 2, to: toIndex + 1, before, native: 'karafun' });
}

test('« Pas prêt » : annuler un déplacement du bar rend le report qu’il avait levé', () => {
  const { s, firsts } = evening();
  const [head] = firsts();
  const p = s.people.get(head.ids[0]);
  s.deferPassage(p.id, head, 2);
  staffMoveRecorded(s, p, 0);
  assert.equal(p.deferral, null, 'le bar place lui-même ce passage');
  s.undoLastManualChange(null, 'karafun');
  assert.equal(s.deferralFor(p.id).remaining, 2);
});

// Regression: troisième passe adversariale — retirer un titre au bar
// recalculait les empreintes en rétablissant un report levé par le bar.
test('« Pas prêt » : retirer un titre au bar ne rétablit pas un report levé, l’annulation le rend encore', () => {
  const { s, firsts } = evening();
  const [head, , third] = firsts();
  const d = s.people.get(head.ids[0]);
  s.deferPassage(d.id, head, 2);
  const other = s.people.get(third.ids[0]);
  s.chooseSong(other, song(), 'append'); // il a un titre de rechange
  staffMoveRecorded(s, other, 1);
  staffMoveRecorded(s, d, 0);
  assert.equal(d.deferral, null);
  s.staffRemove(other.id);
  assert.equal(d.deferral, null, 'le choix du bar reste en place');
  s.undoLastManualChange(null, 'karafun');
  assert.equal(s.deferralFor(d.id)?.remaining, 2, 'annuler la priorité rend le report');
});

test('« Pas prêt » : cinq chansons au plus par titre, même après plusieurs reports', () => {
  const { s, firsts } = evening();
  const [head] = firsts();
  const p = s.people.get(head.ids[0]);
  s.deferPassage(p.id, head, 1);
  const sel = s.select(); s.commit(sel);
  assert.equal(p.deferral, null, 'report terminé : prochain annoncé');
  const again = firsts().find(v => v.ids[0] === p.id);
  assert.throws(() => s.deferPassage(p.id, again, 5), /plus de 5 chansons/);
  s.deferPassage(p.id, again, 4);
  assert.equal(s.deferralFor(p.id).total, 5);
  assert.throws(() => s.deferPassage(p.id, again, 1), /plus de 5 chansons/);
});

for (const [label, setup] of [
  ['deux reports', (s, firsts) => { const [h] = firsts(); s.deferPassage(h.ids[0], h, 2);
    const o = firsts().find(x => x.ids[0] !== h.ids[0]); s.deferPassage(o.ids[0], o, 1); }],
  ['report puis présence manquée', (s, firsts) => { const [h] = firsts(); s.deferPassage(h.ids[0], h, 1); s.skipUnconfirmed(firsts()[0].ids[0]); }],
  ['présence manquée puis report', (s, firsts) => { const [h] = firsts(); s.skipUnconfirmed(h.ids[0]);
    const o = firsts().find(x => x.ids[0] !== h.ids[0]); s.deferPassage(o.ids[0], o, 1); }],
]) test(`retenues combinées (${label}) : la prévision dit vrai`, () => {
  const { s, names, firsts } = evening();
  setup(s, firsts);
  const forecast = names(firsts());
  const real = [];
  for (let i = 0; i < forecast.length; i++) { const sel = s.select(); real.push(names([sel])[0]); s.commit(sel); s.songEnded(sel.ids); }
  assert.deepEqual(real, forecast);
});

test('« Pas prêt » et demandes de duo : entrées refusées sans effet partiel', () => {
  const s = new Scheduler();
  const ppl = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name, i) => s.join({ tableId: String(i + 1), name, headcount: 1 }));
  const [a, b] = ppl;
  s.chooseSong(a, song()); s.chooseSong(b, song());
  const head = s.presenceView().find(v => !v.future);
  for (const bad of [0, 6, 1.5, 'deux', -1]) assert.throws(() => s.deferPassage(head.ids[0], head, bad), /de 1 à 5/);
  assert.throws(() => s.deferPassage(head.ids[0], { ...head, ids: ['autre'] }, 1), /Passage introuvable/);
  assert.throws(() => s.deferPassage(head.ids[0], { ids: head.ids }, 1), /Passage introuvable/);
  assert.equal(s.deferralFor(head.ids[0]), null, 'aucun report partiel');
  const entry = a.song.entryId;
  for (const p of ppl.slice(2)) s.requestDuetJoin(p, a.id, entry);
  assert.throws(() => s.requestDuetJoin(b, a.id, entry), /Plusieurs personnes/);
  assert.equal(s.duetJoinRequestsBy(ppl[2]).length, 1);
  assert.throws(() => s.requestDuetJoin(b, a.id, 'disparu'), /plus en attente/);
  assert.throws(() => s.answerDuetJoin(a, entry, b.id, true), /plus valable/);
  assert.throws(() => s.cancelDuetJoin(b, a.id, entry), /introuvable/);
  s.leave(a);
  assert.throws(() => s.requestDuetJoin(b, a.id, entry), /plus dans la file/);
});

// ---------------------------------------------------------------- reprise de soirée
function snap() {
  const s = new Scheduler();
  for (const [t, name, id] of [['1', 'Alice', 1], ['2', 'Bruno', 2]]) s.chooseSong(s.join({ tableId: t, name, headcount: 1 }), { songId: id, title: name });
  const head = s.presenceView()[0];
  s.deferPassage(head.ids[0], head, 1);
  const access = new TableAccess(); for (const id of s.tables.keys()) access.issue(id);
  return { snapshot: snapshotNight({ scheduler: s, access, settings: { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 } }), headId: head.ids[0] };
}
for (const [label, bad] of [['remaining négatif', { remaining: -1 }], ['ids vide', { ids: [] }], ['until absent', { until: null }], ['total trop grand', { total: 6 }]]) {
  test(`reprise : report abîmé (${label}) ignoré, la personne garde sa place`, () => {
    const { snapshot, headId } = snap();
    const p = snapshot.scheduler.people.find(x => x.id === headId);
    p.deferral = { ...p.deferral, ...bad };
    const restored = new Scheduler();
    restoreNight(snapshot, { scheduler: restored, access: new TableAccess(), settings: {} });
    assert.equal(restored.deferralFor(headId), null);
    assert.ok(restored.Q.includes(headId));
  });
}
test('reprise : compte des chansons laissées passer conservé avec le titre', () => {
  const { snapshot, headId } = snap();
  const restored = new Scheduler();
  restoreNight(snapshot, { scheduler: restored, access: new TableAccess(), settings: {} });
  assert.equal(restored.deferredSongsOf(restored.people.get(headId).song), 1);
});

// ---------------------------------------------------------------- Spotify
const json = (data, status = 200, headers = {}) => ({ ok: status < 300, status, json: async () => data,
  text: async () => JSON.stringify(data), headers: { get: name => headers[name.toLowerCase()] ?? null } });
const linked = fetchImpl => {
  const link = new SpotifyLink({ fetchImpl });
  link.config = { ...link.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'r' };
  return link;
};

test('Spotify : jeton révoqué, déconnexion au lieu d’un appel toutes les 3 s', async () => {
  const f = harness();
  let tokenCalls = 0;
  f.spotify.fetchImpl = async () => { tokenCalls++; return json({ error: 'invalid_grant' }, 400); };
  f.spotify.config = { ...f.spotify.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'révoqué' };
  for (let i = 0; i < 5; i++) await f.spotifyTick();
  assert.equal(tokenCalls, 1);
  assert.equal(f.spotify.connected, false, 'le panneau repasse à « Non connecté »');
  assert.match(f.spotify.lastError, /reconnecte/);
});

test('Spotify : réseau coupé, nouvel essai seulement après le délai d’attente', async () => {
  const f = harness();
  let calls = 0;
  f.spotify.fetchImpl = async () => { calls++; throw new Error('réseau coupé'); };
  f.spotify.config = { ...f.spotify.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'r' };
  for (let i = 0; i < 5; i++) await f.spotifyTick();
  assert.equal(calls, 1);
  assert.equal(f.spotify.waiting, true);
  assert.equal(f.spotify.connected, true, 'une panne réseau ne déconnecte pas');
});

// Regression: relecture Codex de la PR #9 — une pause faite au bar pendant
// un silence était annulée par la relance automatique à la fin du délai.
test('Spotify : pause faite au bar pendant un silence, pas de relance automatique ensuite', async () => {
  const f = harness();
  let now = Date.now();
  f.spotifyAutomation.now = () => now;
  let playing = true;
  const plays = [];
  f.spotify.fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/token')) return json({ access_token: 't', expires_in: 3600 });
    if (url.endsWith('/me/player')) return json({ is_playing: playing, device: { id: 'pc', name: 'PC' } });
    if (url.includes('/me/player/play')) { plays.push(now); playing = true; return { ok: true, status: 204, text: async () => '' }; }
    if (url.includes('/me/player/pause')) { playing = false; return { ok: true, status: 204, text: async () => '' }; }
    throw new Error(`inattendu : ${url}`);
  };
  f.spotify.config = { ...f.spotify.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'r', autoResume: true, autoPause: true, resumeDelaySec: 15 };
  f.setBridge({ ready: true, connected: true, queue: [], status: { state: 'idle' }, events: [] });
  await f.spotifyTick(); // le silence commence
  now += 5000;
  await f.handlers['POST /api/staff/spotify'](null, null, { action: 'pause' });
  now += 20000;
  await f.spotifyTick();
  assert.deepEqual(plays, [], 'la musique coupée par le bar reste coupée pendant ce silence');
  assert.equal(playing, false);
  // Un titre puis un nouveau silence : la relance automatique reprend.
  f.setBridge({ ready: true, connected: true, queue: [{ queueId: 1, songId: 1, title: 'T' }], status: { state: 'playing', songPlaying: { queueId: 1 } }, events: [] });
  await f.spotifyTick();
  f.setBridge({ ready: true, connected: true, queue: [], status: { state: 'idle' }, events: [] });
  await f.spotifyTick();
  now += 16000;
  await f.spotifyTick();
  assert.equal(plays.length, 1, 'silence suivant : relance automatique');
});

test('Spotify : 429 respecte Retry-After, 401 renouvelle le jeton une seule fois', async () => {
  let now = 1_000_000;
  let rejected = false, tokens = 0;
  const link = linked(async url => url.endsWith('/api/token') ? (tokens++, json({ access_token: `t${tokens}`, expires_in: 3600 }))
    : !rejected ? (rejected = true, json({}, 401)) : json({ is_playing: true }));
  assert.equal((await link.readPlayer()).isPlaying, true);
  assert.equal(tokens, 2);
  const busy = linked(async url => url.endsWith('/api/token') ? json({ access_token: 't', expires_in: 3600 }) : json({}, 429, { 'retry-after': '120' }));
  busy.now = () => now;
  await assert.rejects(busy.readPlayer(), /patienter/);
  assert.equal(busy.waitUntil, now + 120000);
  now += 120001;
  assert.equal(busy.waiting, false);
});

test('Spotify : un seul renouvellement du jeton à la fois, jeton refusé effacé seulement s’il est encore le bon', async () => {
  let tokens = 0;
  let release;
  const link = linked(url => url.endsWith('/api/token')
    ? (tokens++, new Promise(resolve => { release = () => resolve(json({ access_token: 't', refresh_token: 'r2', expires_in: 3600 })); }))
    : Promise.resolve(json({ is_playing: false })));
  const both = Promise.all([link.readPlayer(), link.devices().catch(() => null)]);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await both;
  assert.equal(tokens, 1, 'boucle et bouton du bar partagent le renouvellement');
  assert.equal(link.config.refreshToken, 'r2');
  const stale = linked(async () => json({ error: 'invalid_grant' }, 400));
  stale.config.refreshToken = 'nouveau';
  await assert.rejects(stale._token({ grant_type: 'refresh_token', refresh_token: 'ancien' }));
  assert.equal(stale.config.refreshToken, 'nouveau', 'un ancien jeton refusé n’efface pas le nouveau');
});

// Regression: troisième passe adversariale — une reconnexion pouvait être
// écrasée par un renouvellement parti avec l'ancien jeton.
test('Spotify : reconnexion pendant un renouvellement, le nouveau compte garde ses jetons', async () => {
  let releaseCode;
  const calls = [];
  const link = linked(async (url, options = {}) => {
    if (url.endsWith('/api/token')) {
      const form = new URLSearchParams(options.body);
      calls.push(form.get('grant_type'));
      if (form.get('grant_type') === 'authorization_code') {
        await new Promise(resolve => { releaseCode = resolve; });
        return json({ access_token: 'NOUVEAU', refresh_token: 'NOUVEAU_RT', expires_in: 3600 });
      }
      return json({ access_token: 'ANCIEN', refresh_token: 'ANCIEN_RT2', expires_in: 3600 });
    }
    return json({ is_playing: false });
  });
  link.failures = 3; link.waitUntil = Date.now() + 600000;
  link.authUrl('http://127.0.0.1:3000/spotify/callback');
  const connecting = link.finishAuth({ code: 'c', state: link.pendingAuth.state });
  const reading = link.readPlayer();
  await new Promise(resolve => setImmediate(resolve));
  releaseCode();
  await connecting; await reading;
  assert.deepEqual(calls, ['authorization_code'], 'pas de renouvellement avec l’ancien jeton');
  assert.equal(link.config.refreshToken, 'NOUVEAU_RT');
  assert.equal(link.waiting, false, 'reconnexion : plus d’attente héritée');
});

test('Spotify : après des erreurs, la pause d’un titre qui démarre passe quand même', async () => {
  const f = harness();
  let paused = 0, down = true;
  f.spotify.fetchImpl = async (url, options = {}) => {
    if (down) throw new Error('réseau coupé');
    if (url.endsWith('/api/token')) return json({ access_token: 't', expires_in: 3600 });
    if (url.endsWith('/me/player')) return json({ is_playing: true, device: { id: 'pc', name: 'PC' } });
    if (url.includes('/me/player/pause')) { paused++; return { ok: true, status: 204, text: async () => '' }; }
    throw new Error(`inattendu : ${url}`);
  };
  f.spotify.config = { ...f.spotify.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'r' };
  await f.spotifyTick();
  assert.equal(f.spotify.waiting, true);
  down = false;
  f.setBridge({ ready: true, connected: true, queue: [{ queueId: 1, songId: 1, title: 'T' }], status: { state: 'playing', songPlaying: { queueId: 1 } }, events: [] });
  await f.spotifyTick();
  assert.equal(paused, 1, 'pas de musique par-dessus le chanteur');
});

test('Spotify : déconnexion pendant un renouvellement, le jeton reçu est ignoré', async () => {
  let release;
  const link = linked(() => new Promise(resolve => { release = () => resolve(json({ access_token: 't', refresh_token: 'nouveau', expires_in: 3600 })); }));
  const reading = link.readPlayer();
  await new Promise(resolve => setImmediate(resolve));
  link.disconnect();
  release();
  await assert.rejects(reading, /changée/);
  assert.equal(link.connected, false);
  assert.equal(link.config.refreshToken, '');
});

test('Spotify : fichier abîmé nettoyé, nouveau Client ID efface le jeton', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-'));
  const file = path.join(dir, 'spotify.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ clientId: '0123456789abcdef', refreshToken: 'r', resumeDelaySec: -1, autoPause: 'oui' }));
    const link = new SpotifyLink({ file, fetchImpl: async () => { throw new Error('réseau'); } });
    assert.equal(link.config.resumeDelaySec, 3);
    assert.equal(link.config.autoPause, true);
    link.setClientId('fedcba9876543210');
    assert.equal(link.connected, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refreshToken, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- paroles
const page = (id, lines) => `<html><head><title>Karaoké</title></head><body><div class="lyrics js-lyrics" data-song-id="${id}">
  ${lines.map((line, i) => `<p data-original="${i ? '&#x0A;' : ''}${line}">x</p>`).join('')}<div class="js-lyrics__action"></div></div></body></html>`;
const html = text => ({ ok: true, status: 200, text: async () => text });
const missing = () => ({ ok: false, status: 404, text: async () => '' });

test('paroles : titre non latin, lien de recherche sans appel au site', async () => {
  let calls = 0;
  const lyrics = new Lyrics({ fetchImpl: async () => { calls++; return html('<html></html>'); } });
  const found = await lyrics.find({ title: 'Группа крови', artist: 'Кино' });
  assert.equal(found.lines, null);
  assert.match(found.url, /^https:\/\/www\.karafun\.fr\/search\/\?query=/);
  assert.equal(calls, 0);
});

test('paroles : un titre inventé avec un vrai identifiant ne remplace pas les paroles', async () => {
  const lyrics = new Lyrics({ fetchImpl: async url => new URL(url).pathname === '/karaoke/queen/ma-chanson/' ? html(page(7, ['Vers A']))
    : url.includes('/search/') ? html('') : missing() });
  const bogus = await lyrics.find({ songId: 7, title: 'Faux titre', artist: 'Pirate' });
  assert.equal(bogus.lines, null);
  const real = await lyrics.find({ songId: 7, title: 'Ma chanson', artist: 'Queen' });
  assert.deepEqual(real.lines, ['Vers A']);
  assert.equal(real.exact, true);
  const again = await lyrics.find({ songId: 7, title: 'Faux titre', artist: 'Pirate' });
  assert.deepEqual(again.lines, ['Vers A'], 'la page exacte connue sert ensuite pour cet identifiant');
});

test('paroles : demandes identiques regroupées, deux lectures au plus à la fois, panne signalée', async () => {
  let active = 0, peak = 0, calls = 0, down = false;
  const lyrics = new Lyrics({ fetchImpl: async () => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (down) throw new Error('site injoignable');
    return missing();
  } });
  await Promise.all([1, 2, 3].map(() => lyrics.find({ songId: 11, title: 'Même titre', artist: 'Même' })));
  const single = calls;
  assert.equal(single, 2, 'adresse devinée puis recherche, une seule fois pour trois téléphones');
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map(t => lyrics.find({ title: `Titre ${t}`, artist: 'X' })));
  assert.ok(peak <= 2, `au plus deux lectures simultanées (${peak})`);
  down = true;
  const failed = await lyrics.find({ title: 'Panne', artist: 'Réseau' });
  assert.equal(failed.unavailable, true);
  assert.equal(failed.lines, null);
});

test('paroles : une surcharge passagère n’est pas gardée en cache', async () => {
  let open = [];
  let calls = 0;
  const lyrics = new Lyrics({ fetchImpl: () => { calls++; return new Promise(resolve => open.push(() => resolve(missing()))); } });
  // Deux lectures en cours et vingt en attente : la vingt-troisième est de trop.
  const flood = Array.from({ length: 23 }, (_, i) => lyrics.find({ title: `Titre ${i}`, artist: 'X' }));
  const victim = await flood[22];
  assert.equal(victim.unavailable, true, 'au-delà de la file d’attente : indisponible pour le moment');
  while (open.length) { const batch = open; open = []; batch.forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve)); }
  await Promise.all(flood);
  const before = calls;
  const retry = lyrics.find({ title: 'Titre 22', artist: 'X' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls > before, 'nouvel essai sur le site après la surcharge');
  while (open.length) { const batch = open; open = []; batch.forEach(resolve => resolve()); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal((await retry).unavailable, undefined);
});
