'use strict';
// Routes des téléphones et du bar pour les duos (retours v1.4) : se retirer
// d'un duo accepté avant ou après l'envoi à KaraFun, « Chanter seul »,
// invitée marquée partie par le bar, demande de duo expirée à l'envoi, et
// messages par personne lus seulement par le téléphone qui la gère.
// server.js est chargé dans un bac à sable `vm` (--demo), sans port ouvert.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const context = { require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL, setTimeout, clearTimeout,
    setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, handlers, access, staffState, publicState, sync,
      tracked: () => tracked, setBridge: b => { bridge = b; }, setPending: p => { pending = p; }, getPending: () => pending,
      handle: server.listeners('request')[0] };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  f.call = (route, body = {}) => f.handlers[route]({}, {}, body);
  return f;
}

const plain = value => JSON.parse(JSON.stringify(value));
const song = (songId, title) => ({ songId, title, artist: 'Artiste' });

// Une personne par table, avec le corps de requête de son téléphone.
function person(f, table, name) {
  f.sched.table(table).headcount = 3;
  const p = f.sched.join({ tableId: table, name });
  return { p, body: { table, access: f.access.get(table) || f.access.issue(table), personId: p.id, token: p.token } };
}

function fakeBridge(queue = []) {
  const calls = [];
  return { calls, ready: true, connected: true, queue, events: [], permissions: {}, status: { state: 'idle' },
    snapshot: () => ({ ready: true, connected: true, queue, events: [] }),
    add: (songId, singer) => calls.push(['add', songId, singer]), remove: id => calls.push(['remove', id]),
    next: () => calls.push(['next']), play: () => calls.push(['play']) };
}

// Le duo d'Alice avec Bruno, accepté, puis envoyé à KaraFun sous `queueId`.
async function sentDuo(f, queueId = 41) {
  const alice = person(f, '1', 'Alice'), bruno = person(f, '2', 'Bruno');
  const duo = f.sched.inviteDuet(alice.p, bruno.p.id, song(1, 'Un'));
  await f.call('POST /api/table/duet/answer', { ...bruno.body, accept: true, entryId: duo.entryId });
  const sel = f.sched.select();
  assert.deepEqual(plain(sel.ids), [alice.p.id, bruno.p.id]);
  f.sched.commit(sel);
  const tr = { queueId, sel, addedAt: Date.now(), startedAt: null };
  f.tracked().push(tr);
  f.setBridge(fakeBridge([{ queueId, songId: 1, singer: sel.label }]));
  return { alice, bruno, duo, sel, tr };
}

test('se retirer d’un duo accepté avant l’envoi, puis messages lus par le téléphone de l’auteur', async () => {
  const f = harness();
  const alice = person(f, '1', 'Alice'), bruno = person(f, '2', 'Bruno');
  const duo = f.sched.inviteDuet(alice.p, bruno.p.id, song(1, 'Un'));
  await f.call('POST /api/table/duet/answer', { ...bruno.body, accept: true, entryId: duo.entryId });
  const view = f.publicState(null, '2', new Set([bruno.p.id]));
  assert.deepEqual(plain(view.tablePeople[0].guestDuos.map(d => [d.ownerId, d.entryId])), [[alice.p.id, duo.entryId]]);
  const result = plain(await f.call('POST /api/table/duet/leave', { ...bruno.body, ownerId: alice.p.id, entryId: duo.entryId }));
  assert.deepEqual(result, { ok: true, stage: 'planned' });
  assert.equal(duo.duet, undefined);
  // Le message n'est montré qu'au téléphone qui gère Alice.
  const mine = f.publicState(null, '1', new Set([alice.p.id])).tablePeople[0].inbox;
  assert.deepEqual(plain(mine.map(n => [n.kind, n.params])), [['duoLeft', { name: 'Bruno', title: 'Un', sent: false }]]);
  assert.equal(f.publicState(null, '1', new Set()).tablePeople[0].inbox, undefined, 'autre téléphone de la table : rien');
  await assert.rejects(f.call('POST /api/table/notice/ack', { ...alice.body, token: 'faux', ids: [mine[0].id] }),
    { code: 'PERSON_ACCESS' });
  assert.deepEqual(plain(await f.call('POST /api/table/notice/ack', { ...alice.body, ids: [mine[0].id] })), { ok: true, removed: 1 });
  assert.deepEqual(plain(f.publicState(null, '1', new Set([alice.p.id])).tablePeople[0].inbox), []);
  await assert.rejects(f.call('POST /api/table/duet/leave', { ...bruno.body, ownerId: alice.p.id, entryId: duo.entryId }),
    { message: 'Duo introuvable.' });
});

test('page de table : la vue d’état ne livre les messages qu’aux personnes de ce téléphone', async () => {
  const f = harness();
  const alice = person(f, '1', 'Alice'), marie = person(f, '1', 'Marie');
  f.sched.notify(alice.p.id, 'duoRefused', { name: 'Bruno', title: 'Un' });
  f.sched.notify(marie.p.id, 'duoRefused', { name: 'Bruno', title: 'Deux' });
  const view = await new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'GET', url: `/api/state?table=1&access=${alice.body.access}`,
      headers: { 'x-person-tokens': JSON.stringify([alice.p.token]) }, socket: { remoteAddress: '127.0.0.1', localPort: 3000 } });
    const res = { setHeader() {}, getHeader() {}, writeHead() {}, end: data => resolve(JSON.parse(String(data))) };
    f.handle(req, res);
  });
  const byName = Object.fromEntries(view.tablePeople.map(row => [row.name, row.inbox]));
  assert.deepEqual(byName.Alice.map(n => n.params.title), ['Un']);
  assert.equal(byName.Marie, undefined);
});

test('duo déjà dans KaraFun : l’invitée se retire, le titre reste sans commande KaraFun, ses crédits reviennent', async () => {
  const f = harness();
  const { alice, bruno, duo, sel, tr } = await sentDuo(f);
  const bridge = fakeBridge([{ queueId: 41, songId: 1, singer: sel.label }]);
  f.setBridge(bridge);
  const mine = f.publicState(null, '2', new Set([bruno.p.id])).tablePeople[0].inKaraFun[0];
  assert.deepEqual(plain(mine.duo), { role: 'guest', ownerId: alice.p.id, ownerName: 'Alice', guestName: 'Bruno' });
  assert.equal(mine.canLeave, true);
  assert.equal(mine.entryId, duo.entryId);
  assert.equal(bruno.p.duetGuestCount, 1);
  const result = plain(await f.call('POST /api/table/duet/leave', { ...bruno.body, ownerId: alice.p.id, entryId: duo.entryId }));
  assert.deepEqual(result, { ok: true, stage: 'sent' });
  assert.deepEqual(bridge.calls, [], 'KaraFun n’est pas touché');
  assert.deepEqual(plain(tr.sel.ids), [alice.p.id]);
  assert.equal(bruno.p.duetGuestCount, 0, 'le duo ne compte plus pour Bruno');
  assert.ok(!f.sched.roundPeople.has(bruno.p.id));
  assert.ok(f.sched.log.some(l => /KaraFun affiche encore les deux noms/.test(l.msg)));
  assert.equal(f.publicState(null, '2', new Set([bruno.p.id])).tablePeople[0].inKaraFun.length, 0);
  const owner = f.publicState(null, '1', new Set([alice.p.id])).tablePeople[0];
  assert.equal(owner.inKaraFun[0].duo, undefined, 'titre solo d’Alice');
  assert.equal(owner.inbox.at(-1).params.sent, true);
});

test('« Chanter seul » côté auteur, et refus pendant l’envoi ou sur scène', async () => {
  const f = harness();
  const { alice, bruno, duo, tr } = await sentDuo(f);
  const view = f.publicState(null, '1', new Set([alice.p.id])).tablePeople[0].inKaraFun[0];
  assert.equal(view.duo.role, 'owner');
  tr.pulled = { reason: 'defer', at: Date.now() };
  await assert.rejects(f.call('POST /api/table/duet/solo', { ...alice.body, entryId: duo.entryId }),
    { message: 'Ce titre est en train de sortir de KaraFun. Réessaie dans un instant.' });
  tr.pulled = null;
  tr.startedAt = Date.now();
  await assert.rejects(f.call('POST /api/table/duet/leave', { ...bruno.body, ownerId: alice.p.id, entryId: duo.entryId }),
    { message: 'Trop tard : ce duo est déjà sur scène.' });
  assert.equal(f.publicState(null, '1', new Set([alice.p.id])).tablePeople[0].inKaraFun[0].canLeave, false);
  tr.startedAt = null;
  assert.deepEqual(plain(await f.call('POST /api/table/duet/solo', { ...alice.body, entryId: duo.entryId })), { ok: true, stage: 'sent' });
  assert.deepEqual(plain(tr.sel.ids), [alice.p.id]);
  assert.equal(bruno.p.inbox.at(-1).kind, 'duoCancelled');
  // Avant l'envoi, « Chanter seul » annule simplement le duo.
  const next = f.sched.inviteDuet(alice.p, bruno.p.id, song(2, 'Deux'));
  assert.deepEqual(plain(await f.call('POST /api/table/duet/solo', { ...alice.body, entryId: next.entryId })), { ok: true, stage: 'planned' });
  assert.equal(next.duet, undefined);
  // Pendant l'envoi d'un duo, ses chanteurs sont fixés.
  const third = f.sched.inviteDuet(alice.p, bruno.p.id, song(3, 'Trois'));
  third.duet.state = 'accepted';
  f.setPending({ sel: { ids: [alice.p.id, bruno.p.id], song: third, label: 'x', names: ['Alice', 'Bruno'] }, cancelled: false, before: new Set(), at: Date.now() });
  for (const [route, body] of [['POST /api/table/duet/leave', { ...bruno.body, ownerId: alice.p.id }], ['POST /api/table/duet/solo', alice.body]]) {
    await assert.rejects(f.call(route, { ...body, entryId: third.entryId }),
      { message: 'Ce titre est en cours d’envoi à KaraFun. Réessaie dans un instant.' });
  }
});

test('bar : marquer partie l’invitée d’un duo envoyé garde le titre de son auteur', async () => {
  const f = harness();
  const { alice, bruno, tr } = await sentDuo(f);
  const bridge = fakeBridge([{ queueId: 41, songId: 1, singer: tr.sel.label }]);
  f.setBridge(bridge);
  // Un autre duo de Bruno est en route vers KaraFun, sans accusé.
  const chloe = person(f, '3', 'Chloé');
  const other = f.sched.inviteDuet(chloe.p, bruno.p.id, song(5, 'Cinq'));
  other.duet.state = 'accepted';
  const pendingSel = { ids: [chloe.p.id, bruno.p.id], consumedIds: [chloe.p.id], song: other, label: 'Chloé & Bruno · Table 3 + Table 2',
    names: ['Chloé', 'Bruno'], kind: 'duo', group: chloe.p.group, groups: [chloe.p.group, bruno.p.group] };
  f.setPending({ sel: pendingSel, cancelled: false, before: new Set([41]), at: Date.now() });
  const result = plain(await f.call('POST /api/staff/person/leave', { personId: bruno.p.id }));
  assert.deepEqual(result, { ok: true, removedFromKaraFun: 0, pendingCancelled: false, keptAsSolo: 2 });
  assert.deepEqual(bridge.calls, [], 'aucun titre retiré');
  assert.equal(tr.cancelled, undefined);
  assert.deepEqual(plain(tr.sel.ids), [alice.p.id]);
  assert.deepEqual(plain(pendingSel.ids), [chloe.p.id]);
  assert.equal(pendingSel.label, 'Chloé & Bruno · Table 3 + Table 2', 'l’accusé KaraFun est reconnu sous son nom');
  assert.ok(f.sched.log.some(l => l.msg.startsWith('Bruno est parti : Alice chantera « Un » en solo')));
  assert.equal(alice.p.inbox.at(-1).params.sent, true);
  // Le bar voit la demande de duo encore en attente (contrat C4).
  const dan = person(f, '4', 'Dan');
  f.sched.chooseSong(alice.p, song(6, 'Six'));
  f.sched.requestDuetJoin(dan.p, alice.p.id, alice.p.song.entryId);
  const [row] = plain(f.staffState().joinRequests);
  assert.deepEqual({ ...row, at: typeof row.at }, { ownerId: alice.p.id, ownerName: 'Alice', requesterId: dan.p.id, requesterName: 'Dan',
    entryId: alice.p.song.entryId, title: 'Six', at: 'number', seenAt: null });
});

test('bar : départ de la table de l’invitée d’un duo envoyé garde le titre de son auteur', async () => {
  const f = harness();
  const { alice, bruno, tr } = await sentDuo(f);
  // Béa, à la table de Bruno, a son propre titre dans KaraFun : il part avec elle.
  const bea = person(f, '2', 'Béa');
  f.sched.chooseSong(bea.p, song(7, 'Sept'));
  const solo = { queueId: 42, sel: { ids: [bea.p.id], consumedIds: [bea.p.id], song: bea.p.song, label: 'Béa · Table 2', names: ['Béa'] },
    addedAt: Date.now(), startedAt: null };
  f.tracked().push(solo);
  const bridge = fakeBridge([{ queueId: 41, songId: 1, singer: tr.sel.label }, { queueId: 42, songId: 7, singer: solo.sel.label }]);
  f.setBridge(bridge);
  // Un autre duo de Bruno est en route vers KaraFun, sans accusé.
  const chloe = person(f, '3', 'Chloé');
  const other = f.sched.inviteDuet(chloe.p, bruno.p.id, song(5, 'Cinq'));
  other.duet.state = 'accepted';
  const pendingSel = { ids: [chloe.p.id, bruno.p.id], consumedIds: [chloe.p.id], song: other, label: 'Chloé & Bruno · Table 3 + Table 2',
    names: ['Chloé', 'Bruno'], kind: 'duo', group: chloe.p.group, groups: [chloe.p.group, bruno.p.group] };
  f.setPending({ sel: pendingSel, cancelled: false, before: new Set([41, 42]), at: Date.now() });
  const result = plain(await f.call('POST /api/staff/table-left', { id: '2' }));
  assert.deepEqual(result, { ok: true, removedFromKaraFun: 1, pendingCancelled: false, keptAsSolo: 2 });
  assert.deepEqual(bridge.calls, [['remove', 42]], 'seul le titre de Béa sort de KaraFun');
  assert.equal(solo.cancelled, true);
  assert.equal(tr.cancelled, undefined);
  assert.deepEqual(plain(tr.sel.ids), [alice.p.id]);
  assert.deepEqual(plain(pendingSel.ids), [chloe.p.id]);
  assert.equal(f.getPending().cancelled, false);
  assert.equal(pendingSel.label, 'Chloé & Bruno · Table 3 + Table 2', 'l’accusé KaraFun est reconnu sous son nom');
  assert.ok(f.sched.log.some(l => l.msg.startsWith('Bruno est parti : Alice chantera « Un » en solo')));
  assert.equal(alice.p.inbox.at(-1).params.sent, true);
  assert.ok(!f.sched.people.has(bruno.p.id) && !f.sched.people.has(bea.p.id), 'la table est partie');
  assert.ok(f.sched.people.has(alice.p.id));

  // Témoin : quand la table de l'auteure part, son duo sort de KaraFun.
  const g = harness();
  const sent = await sentDuo(g);
  const ownerBridge = fakeBridge([{ queueId: 41, songId: 1, singer: sent.tr.sel.label }]);
  g.setBridge(ownerBridge);
  const own = plain(await g.call('POST /api/staff/table-left', { id: '1' }));
  assert.deepEqual(own, { ok: true, removedFromKaraFun: 1, pendingCancelled: false });
  assert.deepEqual(ownerBridge.calls, [['remove', 41]]);
  assert.equal(sent.tr.cancelled, true);
});

test('demande de duo : masquée à l’auteur pendant l’envoi, expirée à l’accusé de KaraFun', async () => {
  const f = harness();
  const alice = person(f, '1', 'Alice'), zoe = person(f, '2', 'Zoé');
  f.sched.chooseSong(alice.p, song(7, 'Sept'));
  await f.call('POST /api/table/duet/join', { ...zoe.body, ownerId: alice.p.id, entryId: alice.p.song.entryId });
  const requests = () => f.publicState(null, '1', new Set([alice.p.id])).tablePeople[0].joinRequests;
  assert.equal(requests().length, 1);
  const sel = f.sched.select();
  const queue = [];
  f.setBridge(fakeBridge(queue));
  f.setPending({ sel, before: new Set(), at: Date.now(), attempts: 1, retryAt: null });
  assert.equal(requests().length, 0, 'pendant l’envoi, Alice ne peut plus accepter');
  queue.push({ queueId: 77, songId: 7, singer: sel.label });
  f.sync();
  assert.equal(f.getPending(), null, 'accusé reçu');
  assert.deepEqual(plain(zoe.p.inbox.map(n => [n.kind, n.params])), [['joinExpired', { name: 'Alice', title: 'Sept', reason: 'sent' }]]);
  assert.ok(f.sched.log.some(l => l.msg === 'La demande de duo de Zoé à Alice a expiré : « Sept » est parti dans KaraFun'));
});

// ---------------------------------------------------------------- relecture PR #11
// Regression: relecture PR #11 — une invitée retirée d'un duo déjà dans
// KaraFun y revenait quand le titre réintégrait la liste de son auteur.
for (const [how, leave] of [
  ['l’invitée se retire', (f, s) => f.call('POST /api/table/duet/leave', { ...s.bruno.body, ownerId: s.alice.p.id, entryId: s.duo.entryId })],
  ['l’auteur chante seul', (f, s) => f.call('POST /api/table/duet/solo', { ...s.alice.body, entryId: s.duo.entryId })],
]) {
  test(`duo envoyé devenu solo (${how}) : revenu dans la liste de son auteur, il repart en solo`, async () => {
    const f = harness();
    const s = await sentDuo(f);
    assert.deepEqual(plain(await leave(f, s)), { ok: true, stage: 'sent' });
    assert.equal(s.tr.sel.song.duet, undefined, 'le titre envoyé n’est plus un duo');
    // « Pas prêt » ou fermeture : le titre sort de KaraFun sans être chanté.
    f.sched.requeueUnplayed(s.tr.sel);
    assert.equal(s.alice.p.song.entryId, s.duo.entryId);
    assert.equal(s.alice.p.song.duet, undefined);
    assert.equal(s.bruno.p.duetOf, null);
    const next = f.sched.select();
    assert.deepEqual(plain(next.ids), [s.alice.p.id], 'Bruno n’est plus remis dans le duo');
    assert.notEqual(next.kind, 'duo');
  });
}

// Regression: relecture PR #11 — le bar marque partie l'invitée d'un duo en
// cours d'envoi : l'auteur recevait deux avis « duoLeft » contradictoires.
test('bar : invitée marquée partie pendant l’envoi de son duo, un seul avis pour l’auteur', async () => {
  for (const restored of [false, true]) {
    const f = harness();
    const alice = person(f, '1', 'Alice'), bruno = person(f, '2', 'Bruno');
    const duo = f.sched.inviteDuet(alice.p, bruno.p.id, song(1, 'Un'));
    await f.call('POST /api/table/duet/answer', { ...bruno.body, accept: true, entryId: duo.entryId });
    const sel = f.sched.select();
    // Après un redémarrage, l'envoi en cours porte une copie du titre de la liste.
    if (restored) sel.song = JSON.parse(JSON.stringify(sel.song));
    assert.equal(sel.song === alice.p.song, !restored);
    f.setBridge(fakeBridge([]));
    f.setPending({ sel, cancelled: false, before: new Set(), at: Date.now(), attempts: 1, retryAt: null });
    const result = plain(await f.call('POST /api/staff/person/leave', { personId: bruno.p.id }));
    assert.deepEqual(result, { ok: true, removedFromKaraFun: 0, pendingCancelled: false, keptAsSolo: 1 });
    assert.deepEqual(plain(alice.p.inbox.map(n => [n.kind, n.params.sent])), [['duoLeft', true]], `copie relue : ${restored}`);
    assert.equal(alice.p.song.duet, undefined, 'le titre de la liste est aussi un solo');
    assert.equal(sel.song.duet, undefined);
    assert.ok(!f.sched.log.some(l => /duo annulé pour Bruno/.test(l.msg)));
  }
});

// Regression: relecture PR #11 — « Annuler duo » et « Remplacer » étaient
// acceptés pendant l'envoi d'un duo, qui partait quand même dans KaraFun.
test('pendant l’envoi d’un duo : annuler (auteur, invitée, ancienne route) et remplacer sont refusés', async () => {
  const f = harness();
  const alice = person(f, '1', 'Alice'), bruno = person(f, '2', 'Bruno');
  const duo = f.sched.inviteDuet(alice.p, bruno.p.id, song(1, 'Un'));
  await f.call('POST /api/table/duet/answer', { ...bruno.body, accept: true, entryId: duo.entryId });
  const sel = f.sched.select();
  const queue = [];
  f.setBridge(fakeBridge(queue));
  f.setPending({ sel, cancelled: false, before: new Set(), at: Date.now(), attempts: 1, retryAt: null });
  const sending = { message: 'Ce titre est en cours d’envoi à KaraFun. Réessaie dans un instant.' };
  await assert.rejects(f.call('POST /api/table/duet/cancel', { ...alice.body, entryId: duo.entryId }), sending);
  await assert.rejects(f.call('POST /api/table/duet/cancel', alice.body), sending, 'sans titre précis');
  await assert.rejects(f.call('POST /api/table/duet/cancel', { ...bruno.body, entryId: duo.entryId }), sending);
  await assert.rejects(f.handlers['POST /api/duet/cancel']({}, {}, { entryId: duo.entryId }, alice.p), sending);
  await assert.rejects(f.handlers['POST /api/duet/cancel']({}, {}, {}, bruno.p), sending);
  await assert.rejects(f.call('POST /api/table/song', { ...alice.body, song: song(2, 'Deux'), mode: 'replace' }), sending);
  assert.equal(duo.duet?.state, 'accepted', 'le duo reste entier');
  assert.deepEqual(plain(f.sched.songsOf(alice.p).map(s => s.title)), ['Un']);
  assert.deepEqual([...alice.p.inbox || [], ...bruno.p.inbox || []].map(n => n.kind), [], 'aucun avis d’annulation');
  // Ajouter un titre reste possible, et l'invitée garde sa propre liste.
  assert.equal(plain(await f.call('POST /api/table/song', { ...alice.body, song: song(3, 'Trois'), mode: 'append' })).ok, true);
  assert.equal(plain(await f.call('POST /api/table/song', { ...bruno.body, song: song(4, 'Quatre'), mode: 'replace' })).ok, true);
  // Accusé : le duo part entier, puis il peut de nouveau être annulé.
  queue.push({ queueId: 77, songId: 1, singer: sel.label });
  f.sync();
  assert.equal(f.getPending(), null);
  assert.deepEqual(plain(f.tracked().at(-1).sel.ids), [alice.p.id, bruno.p.id]);
  // Témoin : un envoi solo n'empêche pas d'annuler un autre duo.
  const other = f.sched.inviteDuet(bruno.p, alice.p.id, song(5, 'Cinq'));
  f.setPending({ sel: { ids: [bruno.p.id], song: f.sched.songsOf(bruno.p)[0], label: 'Bruno · Table 2', names: ['Bruno'] },
    cancelled: false, before: new Set(), at: Date.now(), attempts: 1, retryAt: null });
  assert.deepEqual(plain(await f.call('POST /api/table/duet/cancel', { ...bruno.body, entryId: other.entryId })), { ok: true });
});

// Regression: relecture PR #11 — départ d'une table marqué par le bar : les
// personnes des autres tables n'étaient pas prévenues de la fin de leurs duos.
test('bar : départ d’une table, les autres tables sont prévenues comme pour un départ personne par personne', async () => {
  const setup = async () => {
    const f = harness();
    const alice = person(f, '1', 'Alice'), bruno = person(f, '2', 'Bruno'), chloe = person(f, '3', 'Chloé'), dan = person(f, '4', 'Dan');
    const marie = person(f, '1', 'Marie');
    const duo = f.sched.inviteDuet(alice.p, bruno.p.id, song(1, 'Un'));
    await f.call('POST /api/table/duet/answer', { ...bruno.body, accept: true, entryId: duo.entryId });
    f.sched.inviteDuet(alice.p, dan.p.id, song(2, 'Deux'));
    const three = f.sched.inviteDuet(alice.p, marie.p.id, song(3, 'Trois'));
    assert.equal(three.duet.state, 'accepted', 'même table : duo direct');
    f.sched.chooseSong(alice.p, song(4, 'Quatre'), 'append');
    await f.call('POST /api/table/duet/join', { ...chloe.body, ownerId: alice.p.id, entryId: f.sched.songsOf(alice.p).at(-1).entryId });
    [alice, bruno, chloe, dan, marie].forEach(x => { x.p.inbox = []; });
    return { f, alice, bruno, chloe, dan, marie };
  };
  const kinds = x => (x.p.inbox || []).map(n => n.kind);
  const byTable = await setup();
  await byTable.f.call('POST /api/staff/table-left', { id: '1' });
  const byPerson = await setup();
  await byPerson.f.call('POST /api/staff/person/leave', { personId: byPerson.alice.p.id });
  for (const run of [byTable, byPerson]) {
    assert.deepEqual(kinds(run.bruno), ['duoCancelled']);
    assert.deepEqual(kinds(run.dan), ['duoCancelled']);
    assert.deepEqual(kinds(run.chloe), ['joinExpired']);
  }
  assert.deepEqual(kinds(byTable.marie), [], 'les personnes qui partent avec la table ne reçoivent rien');
  // Table de l'invitée partie : l'auteur est prévenu.
  const guestTable = await setup();
  await guestTable.f.call('POST /api/staff/table-left', { id: '2' });
  assert.deepEqual(kinds(guestTable.alice), ['duoLeft']);
});

test('bar : l’auteur d’un duo déjà dans KaraFun part, l’invitée apprend l’annulation', async () => {
  for (const route of ['person', 'table']) {
    const f = harness();
    const { alice, bruno, tr } = await sentDuo(f);
    bruno.p.inbox = [];
    const result = route === 'person' ? await f.call('POST /api/staff/person/leave', { personId: alice.p.id }) :
      await f.call('POST /api/staff/table-left', { id: '1' });
    assert.equal(result.removedFromKaraFun, 1);
    assert.equal(tr.cancelled, true);
    assert.deepEqual(plain(bruno.p.inbox.map(n => [n.kind, n.params])), [['duoCancelled', { name: 'Alice', title: 'Un' }]], route);
  }
});

// Regression: relecture PR #11 — duo direct à la même table : les demandes
// d'autres tables sur ce titre disparaissaient sans avis.
test('duo direct à la même table : les autres personnes qui demandaient ce titre sont prévenues', async () => {
  const f = harness();
  const alice = person(f, '1', 'Alice'), chloe = person(f, '3', 'Chloé'), marie = person(f, '1', 'Marie');
  f.sched.chooseSong(alice.p, song(1, 'Un'));
  const entryId = alice.p.song.entryId;
  await f.call('POST /api/table/duet/join', { ...chloe.body, ownerId: alice.p.id, entryId });
  assert.equal(f.sched.duetJoinRequestsBy(chloe.p).length, 1);
  assert.deepEqual(plain(await f.call('POST /api/table/duet/join', { ...marie.body, ownerId: alice.p.id, entryId })), { ok: true, direct: true });
  assert.deepEqual(f.sched.duetJoinRequestsBy(chloe.p), []);
  assert.deepEqual(plain(chloe.p.inbox.map(n => [n.kind, n.params])), [['joinRefused', { name: 'Alice', title: 'Un' }]]);
});
