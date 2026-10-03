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
    entryId: alice.p.song.entryId, title: 'Six', at: 'number' });
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
