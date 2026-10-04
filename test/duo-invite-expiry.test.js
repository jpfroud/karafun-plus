'use strict';
// Invitation de duo sans réponse au tour de son auteur (soirée du 2 octobre :
// une invitée ne voyait pas la demande, et l'auteur était sauté sans limite).
// Décision du propriétaire : « Solo tout de suite ». Une invitation en attente
// ne retient jamais le titre : il garde sa place, et à son tour il part en
// solo dans KaraFun ; l'invitation expire et les deux personnes sont prévenues,
// comme une demande de duo (voir Scheduler#_closeJoinRequests).
// server.js est chargé dans un bac à sable `vm` (--demo), sans port ouvert.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Scheduler } = require('../scheduler');
const { computeStats } = require('../evening-stats');

const root = path.join(__dirname, '..');
const song = (songId, title) => ({ songId, title, artist: 'Artiste' });
const plain = value => JSON.parse(JSON.stringify(value));
const inbox = p => (p.inbox || []).map(n => [n.kind, n.params]);

// Alice (table 1) invite Bruno (table 2) sur son seul titre ; Chloé (table 3)
// choisit ensuite un solo. Alice est entrée la première dans la file.
function night(opts = {}) {
  const s = new Scheduler(opts);
  const events = [];
  s._event = (type, fields) => events.push([type, fields]);
  const join = (table, name) => s.join({ tableId: table, name, headcount: 2 });
  const alice = join('1', 'Alice'), bruno = join('2', 'Bruno'), chloe = join('3', 'Chloé');
  const invite = s.inviteDuet(alice, bruno.id, song(1, 'Un'));
  s.chooseSong(chloe, song(2, 'Deux'));
  return { s, events, alice, bruno, chloe, invite };
}

// ---------------------------------------------------------------- ordonnanceur
test('invitation en attente : le titre garde sa place et part en solo à son tour', () => {
  const { s, alice, bruno, invite } = night();
  assert.equal(invite.duet.state, 'pending');
  assert.equal(s.isReady(alice), true, 'une invitation en attente ne retient pas le titre');
  const sel = s.select();
  assert.deepEqual(sel.ids, [alice.id], 'Alice passe à sa place, seule');
  assert.equal(sel.kind, undefined, 'pas un duo');
  assert.equal(sel.label, 'Alice · Table 1', 'KaraFun affiche le nom de l’auteur seul');
  assert.equal(sel.song.entryId, invite.entryId);
  assert.equal(s.reserveNext().ids[0], alice.id, 'Alice peut être annoncée comme prochaine');
  assert.equal(s.select().ids[0], alice.id, 'l’annonce tient tant que l’invitation attend');
  assert.equal(invite.duet.state, 'pending', 'rien n’expire avant l’envoi');
  assert.equal(s.duetInvites(bruno).length, 1, 'Bruno peut encore accepter avant l’envoi');
});

test('prévision : le titre apparaît à sa place, marqué invitation en attente, sans personne sautée', () => {
  const { s, alice, bruno, chloe, invite } = night();
  s.chooseSong(alice, song(3, 'Trois'), 'append');
  const lines = s.readyView();
  assert.deepEqual(lines.map(line => [line.ids, line.entryId, !!line.future]),
    [[[alice.id], invite.entryId, false], [[chloe.id], chloe.song.entryId, false], [[alice.id], alice.backlog[0].entryId, true]]);
  assert.equal(lines[0].song.duet.state, 'pending', 'la ligne garde l’invitation pour l’affichage');
  assert.equal(lines[0].kind, undefined);
  assert.deepEqual(s.presenceView().map(line => line.ids[0]), [alice.id, chloe.id, alice.id]);
  const view = s.view();
  const mine = view.find(row => row.id === alice.id);
  assert.equal(mine.pos, 1);
  assert.equal(mine.ready, true);
  assert.equal(mine.pendingDuet, true);
  assert.equal(mine.duetWith, null, 'Bruno ne figure pas dans ce passage');
  assert.ok(!view.some(row => row.id === bruno.id), 'Bruno n’a pas de passage');
  // Acceptée : la même place, en duo.
  s.answerDuet(bruno, true, invite.entryId);
  assert.deepEqual(s.readyView()[0].ids, [alice.id, bruno.id]);
});

test('envoi à KaraFun : l’invitation expire, le titre part en solo et les deux sont prévenus', () => {
  const { s, events, alice, bruno, invite } = night();
  const sel = s.select();
  s.commit(sel);
  assert.equal(invite.duet, undefined, 'song.duet retiré');
  assert.equal(sel.song.duet, undefined);
  assert.deepEqual(s.duetInvites(bruno), [], 'l’invitation n’existe plus');
  assert.equal(bruno.invite, null);
  assert.deepEqual(inbox(bruno), [['inviteExpired', { name: 'Alice', title: 'Un' }]]);
  assert.deepEqual(inbox(alice), [['inviteUnanswered', { name: 'Bruno', title: 'Un' }]]);
  assert.ok(s.log.some(l => l.kind === 'staff' &&
    l.msg === 'L’invitation de duo d’Alice à Bruno a expiré : « Un » est parti dans KaraFun, Alice le chante en solo'));
  assert.deepEqual(events.filter(([type]) => type === 'duo.inviteExpired').map(([, f]) => f),
    [{ ownerId: alice.id, partnerId: bruno.id, entryId: invite.entryId }]);
  assert.throws(() => s.answerDuet(bruno, true, invite.entryId), { message: 'Pas d\'invitation en cours.' });
  assert.equal(bruno.duetGuestCount || 0, 0, 'Bruno n’est pas compté sur scène');
  assert.ok(!s.roundPeople.has(bruno.id));
  // Retiré de KaraFun avant d'être chanté : il revient en solo, sans invitation.
  s.requeueUnplayed(sel);
  assert.equal(alice.song.entryId, invite.entryId);
  assert.equal(alice.song.duet, undefined);
  assert.deepEqual(s.duetInvites(bruno), []);
});

test('envoi reconnu après un redémarrage : la copie sauvegardée fait aussi expirer l’invitation', () => {
  const { s, events, alice, bruno, invite } = night();
  const saved = plain(s.select());
  s.commit(saved);
  assert.equal(invite.duet, undefined);
  assert.deepEqual(s.duetInvites(bruno), []);
  assert.deepEqual(inbox(bruno).map(([kind]) => kind), ['inviteExpired']);
  assert.deepEqual(inbox(alice).map(([kind]) => kind), ['inviteUnanswered']);
  assert.equal(events.filter(([type]) => type === 'duo.inviteExpired').length, 1, 'une seule expiration');
});

test('invitation acceptée ou refusée : rien n’expire à l’envoi', () => {
  const accepted = night();
  accepted.s.answerDuet(accepted.bruno, true, accepted.invite.entryId);
  const duo = accepted.s.select();
  assert.deepEqual(duo.ids, [accepted.alice.id, accepted.bruno.id]);
  accepted.s.commit(duo);
  assert.deepEqual(inbox(accepted.bruno), []);
  assert.ok(!accepted.events.some(([type]) => type === 'duo.inviteExpired'));
  const refused = night();
  refused.s.answerDuet(refused.bruno, false, refused.invite.entryId);
  refused.s.commit(refused.s.select());
  assert.deepEqual(inbox(refused.bruno), []);
  assert.deepEqual(inbox(refused.alice).map(([kind]) => kind), ['duoRefused']);
  assert.ok(!refused.events.some(([type]) => type === 'duo.inviteExpired'));
});

test('invitation acceptée alors que le titre est annoncé : les règles de la file le replacent', () => {
  const s = new Scheduler();
  const join = (table, name) => s.join({ tableId: table, name, headcount: 2 });
  const alice = join('1', 'Alice'), bruno = join('2', 'Bruno'), chloe = join('3', 'Chloé');
  s.chooseSong(bruno, song(9, 'Neuf'));
  s.commit(s.select()); // Bruno vient de chanter
  const invite = s.inviteDuet(alice, bruno.id, song(1, 'Un'));
  s.chooseSong(chloe, song(2, 'Deux'));
  assert.deepEqual(s.reserveNext().ids, [alice.id], 'Alice annoncée, seule tant que Bruno n’a pas répondu');
  s.answerDuet(bruno, true, invite.entryId);
  assert.equal(s.reservedNext, null, 'l’annonce faite pour un solo est libérée');
  assert.deepEqual(s.select().ids, [chloe.id], 'Bruno vient de chanter : Chloé, jamais montée sur scène, passe avant le duo');
  // Priorité donnée par le bar : elle tient, même devenue un duo.
  const other = new Scheduler();
  const a = other.join({ tableId: '1', name: 'Ana', headcount: 1 }), b = other.join({ tableId: '2', name: 'Ben', headcount: 1 });
  const c = other.join({ tableId: '3', name: 'Cléo', headcount: 1 });
  other.chooseSong(c, song(3, 'Trois'));
  const duo = other.inviteDuet(a, b.id, song(4, 'Quatre'));
  other.staffMove(a.id, 0);
  other.answerDuet(b, true, duo.entryId);
  assert.equal(other.reservedNext?.personId, a.id);
  assert.deepEqual(other.select().ids, [a.id, b.id]);
});

test('invitation sur un titre suivant de la liste : elle attend que ce titre parte', () => {
  const { s, alice, bruno, chloe } = night();
  s.removeSong(alice, alice.song.entryId);
  s.chooseSong(alice, song(4, 'Quatre'));
  const later = s.inviteDuet(alice, bruno.id, song(5, 'Cinq'));
  const first = s.select();
  assert.deepEqual(first.ids, [alice.id]);
  assert.equal(first.song.title, 'Quatre');
  s.commit(first);
  assert.equal(later.duet.state, 'pending', 'le titre « Cinq » n’est pas encore parti');
  assert.deepEqual(inbox(bruno).map(([kind]) => kind), ['duoCancelled'], 'seul le premier duo retiré est annoncé');
  s.commit(s.select()); // Chloé
  const second = s.select();
  assert.deepEqual(second.ids, [alice.id]);
  assert.equal(second.song.entryId, later.entryId);
  s.commit(second);
  assert.equal(later.duet, undefined);
  assert.deepEqual(inbox(bruno).at(-1), ['inviteExpired', { name: 'Alice', title: 'Cinq' }]);
  assert.ok(chloe.sung === 1);
});

test('« Je suis là » et « Pas prêt » : seule l’auteure est concernée tant que l’invitation attend', () => {
  const { s, alice, bruno, chloe, invite } = night({ requirePresence: true });
  assert.equal(s.presenceView()[0].ids.join(), alice.id, 'la présence est demandée à Alice seule');
  s.confirm(bruno);
  assert.equal(s.confirmedForTurn(s.presenceView()[0].ids), false, 'la réponse de Bruno ne compte pas');
  assert.equal(s.select(), null, 'ni Alice ni Chloé n’ont confirmé');
  s.confirm(chloe);
  assert.deepEqual(s.select().ids, [chloe.id], 'Alice absente : Chloé passe, comme pour un solo');
  s.confirm(alice);
  assert.deepEqual(s.select().ids, [alice.id]);
  // Report : le passage d'Alice laisse passer une chanson, Bruno n'y figure pas.
  const first = s.presenceView()[0];
  s.deferPassage(alice.id, first, 1);
  assert.deepEqual(alice.deferral.ids, [alice.id]);
  assert.equal(s.deferralFor(bruno.id), null);
  assert.equal(s.deferralFor(alice.id).entryId, invite.entryId);
  assert.deepEqual(s.select().ids, [chloe.id]);
});

// Alice (table 1) invite Bruno (table 2) sur « Un » ; Bruno et Chloé (table 3)
// ont chacun leur solo. Le titre d'Alice est le prochain et elle fait « Pas
// prêt » (une chanson) avant ou après la réponse de Bruno. Ordre réel des
// passages, envoyés l'un après l'autre.
function deferredDuo(acceptFirst) {
  const s = new Scheduler();
  const join = (table, name) => s.join({ tableId: table, name, headcount: 2 });
  const alice = join('1', 'Alice'), bruno = join('2', 'Bruno'), chloe = join('3', 'Chloé');
  const invite = s.inviteDuet(alice, bruno.id, song(1, 'Un'));
  s.chooseSong(bruno, song(2, 'B-solo'));
  s.chooseSong(chloe, song(3, 'C-solo'));
  if (acceptFirst) s.answerDuet(bruno, true, invite.entryId);
  s.deferPassage(alice.id, s.presenceView()[0], 1);
  if (!acceptFirst) s.answerDuet(bruno, true, invite.entryId);
  const deferral = { ids: [...alice.deferral.ids], guest: s.deferralFor(bruno.id) };
  const order = [];
  for (let i = 0; i < 3; i++) {
    const sel = s.select();
    order.push(`${sel.ids.map(pid => s.people.get(pid).name).join(' & ')} : ${sel.song.title}`);
    s.commit(sel);
  }
  return { alice, bruno, deferral, order };
}

test('invitation acceptée pendant un report « Pas prêt » : l’invité rejoint le report, l’ordre reste juste', () => {
  const before = deferredDuo(true), during = deferredDuo(false);
  const expected = ['Chloé : C-solo', 'Alice & Bruno : Un', 'Bruno : B-solo'];
  assert.deepEqual(before.order, expected, 'acceptée avant le report');
  assert.deepEqual(during.deferral.ids, [during.alice.id, during.bruno.id],
    'le passage reporté attend aussi Bruno, comme un duo reporté');
  assert.equal(during.deferral.guest?.ownerId, during.alice.id, 'Bruno voit le report de son duo');
  assert.deepEqual(during.order, expected,
    'Chloé, qui n’a jamais chanté, passe d’abord ; Bruno ne chante pas deux fois de suite devant elle');
});

test('report rapproché puis défait (titre retiré de KaraFun sans être chanté) : il attend toujours l’invité qui a accepté', () => {
  const s = new Scheduler();
  const join = (table, name) => s.join({ tableId: table, name, headcount: 2 });
  const alice = join('1', 'Alice'), bruno = join('2', 'Bruno'), chloe = join('3', 'Chloé');
  const invite = s.inviteDuet(alice, bruno.id, song(1, 'Un'));
  s.chooseSong(chloe, song(3, 'C-solo'));
  s.chooseSong(bruno, song(2, 'B-solo'));
  s.deferPassage(alice.id, s.presenceView()[0], 2);
  const passed = s.select();
  assert.ok(!passed.ids.includes(alice.id), 'une autre chanson passe pendant le report');
  s.commit(passed);
  assert.equal(alice.deferral.remaining, 1);
  s.answerDuet(bruno, true, invite.entryId);
  assert.deepEqual(alice.deferral.ids, [alice.id, bruno.id]);
  s.rollbackUnplayed(passed);
  assert.equal(alice.deferral.remaining, 2, 'le compte du report revient');
  assert.deepEqual(alice.deferral.ids, [alice.id, bruno.id], 'Bruno reste dans le passage reporté');
  assert.equal(s.deferralFor(bruno.id)?.ownerId, alice.id);
});

test('duo improvisé noté au bar : l’annonce d’un solo dont l’invitation attend tient', () => {
  const s = new Scheduler();
  const join = (table, name) => s.join({ tableId: table, name, headcount: 2 });
  const alice = join('1', 'Alice'), bruno = join('2', 'Bruno'), chloe = join('3', 'Chloé');
  s.chooseSong(alice, song(10, 'A0'));
  s.commit(s.select()); // Alice a déjà chanté
  s.chooseSong(chloe, song(11, 'C0'));
  const onStage = s.select();
  s.commit(onStage); // Chloé est sur scène
  const invite = s.inviteDuet(alice, bruno.id, song(1, 'Un'));
  assert.deepEqual(s.reserveNext().ids, [alice.id], 'Alice annoncée, en solo');
  const dan = join('4', 'Dan');
  s.chooseSong(dan, song(12, 'D0'));
  assert.deepEqual(s.select().ids, [alice.id], 'l’annonce tient malgré l’arrivée de Dan');
  s.staffCountPartner(chloe.id, bruno.id, onStage, []);
  assert.equal(s.reservedNext?.personId, alice.id, 'Bruno ne figure pas dans le passage annoncé');
  assert.deepEqual(s.select().ids, [alice.id]);
  assert.equal(invite.duet.state, 'pending');
  // Duo accepté et annoncé : Bruno vient de monter sur scène, l'annonce est libérée.
  const other = new Scheduler();
  const a = other.join({ tableId: '1', name: 'Ana', headcount: 1 }), b = other.join({ tableId: '2', name: 'Ben', headcount: 1 });
  const c = other.join({ tableId: '3', name: 'Cléo', headcount: 1 });
  other.chooseSong(c, song(20, 'Vingt'));
  const stage = other.select();
  other.commit(stage);
  const duo = other.inviteDuet(a, b.id, song(21, 'Vingt et un'));
  other.answerDuet(b, true, duo.entryId);
  assert.deepEqual(other.reserveNext().ids, [a.id, b.id]);
  other.staffCountPartner(c.id, b.id, stage, []);
  assert.equal(other.reservedNext, null);
});

test('titre remplacé ou retiré pendant son envoi : un seul avis pour l’invité, aucune expiration', () => {
  const cases = [
    ['remplacé par son auteure', (s, alice) => s.chooseSong(alice, song(3, 'Trois'), 'replace')],
    ['retiré par le bar', (s, alice) => s.staffRemove(alice.id)],
  ];
  for (const [label, act] of cases) {
    for (const saved of [false, true]) {
      const what = `${label}${saved ? ', copie relue après un redémarrage' : ''}`;
      const { s, events, alice, bruno, invite } = night();
      const selected = s.select();
      assert.equal(selected.song.entryId, invite.entryId);
      const sel = saved ? plain(selected) : selected;
      act(s, alice);
      s.commit(sel);
      assert.deepEqual(inbox(bruno).map(([kind]) => kind), ['duoCancelled'], `${what} : Bruno n’est prévenu qu’une fois`);
      assert.deepEqual(inbox(alice).filter(([kind]) => kind === 'inviteUnanswered'), [], `${what} : Alice a elle-même annulé`);
      assert.ok(!events.some(([type]) => type === 'duo.inviteExpired'), `${what} : aucune expiration comptée`);
      assert.ok(!s.log.some(l => l.msg.includes('a expiré')), `${what} : rien au journal du bar`);
      assert.equal(sel.song.duet, undefined, `${what} : le passage envoyé reste un solo`);
      assert.deepEqual(s.duetInvites(bruno), []);
    }
  }
});

// ---------------------------------------------------------------- statistiques
test('statistiques : invitation expirée comptée à part, sans double compte', () => {
  const T = minutes => Date.UTC(2026, 9, 2, 20, minutes);
  const events = [
    { t: T(0), seq: 1, ev: 'evening.started' },
    { t: T(0), seq: 2, ev: 'person.joined', personId: 'p1', tableId: '1' },
    { t: T(0), seq: 3, ev: 'person.joined', personId: 'p2', tableId: '2' },
    { t: T(1), seq: 4, ev: 'song.requested', personId: 'p1', entryId: 'e1', songId: 1, title: 'Un' },
    { t: T(1), seq: 5, ev: 'duo.invited', personId: 'p1', entryId: 'e1', ownerId: 'p1', partnerId: 'p2', sameGroup: false },
    { t: T(2), seq: 6, ev: 'song.requested', personId: 'p2', entryId: 'e2', songId: 2, title: 'Deux' },
    { t: T(2), seq: 7, ev: 'duo.joinRequested', requesterId: 'p1', ownerId: 'p2', entryId: 'e2', direct: false },
    { t: T(5), seq: 8, ev: 'duo.inviteExpired', ownerId: 'p1', partnerId: 'p2', entryId: 'e1' },
    { t: T(5), seq: 9, ev: 'notice.sent', personId: 'p2', kind: 'inviteExpired' },
    { t: T(6), seq: 10, ev: 'duo.joinExpired', ownerId: 'p2', requesterId: 'p1', entryId: 'e2', reason: 'sent' },
  ];
  const stats = computeStats({ meta: { eveningId: 'x', startedAt: T(0) }, events, now: T(30) });
  const d = stats.global.duos;
  assert.equal(d.invites, 1);
  assert.equal(d.inviteExpired, 1, 'invitation expirée');
  assert.equal(d.joinExpired, 1, 'demande expirée, comptée séparément');
  assert.equal(d.declined, 0, 'une invitation expirée n’est pas refusée');
  assert.equal(d.cancelled, 0);
  assert.equal(d.accepted, 0);
});

// ---------------------------------------------------------------- serveur
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
      tracked: () => tracked, setBridge: b => { bridge = b; }, setPending: p => { pending = p; }, getPending: () => pending };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  f.call = (route, body = {}, me) => f.handlers[route]({}, {}, body, me);
  return f;
}

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

function serverNight() {
  const f = harness();
  const alice = person(f, '1', 'Alice'), bruno = person(f, '2', 'Bruno'), chloe = person(f, '3', 'Chloé');
  const invite = f.sched.inviteDuet(alice.p, bruno.p.id, song(1, 'Un'));
  f.sched.chooseSong(chloe.p, song(2, 'Deux'));
  return { f, alice, bruno, chloe, invite };
}

test('serveur : le titre part en solo dans KaraFun, l’invitation expire à l’accusé', async () => {
  const { f, alice, bruno, invite } = serverNight();
  const queue = [];
  const bridge = fakeBridge(queue);
  f.setBridge(bridge);
  f.settings.auto = true;
  f.sync();
  assert.deepEqual(bridge.calls, [['add', 1, 'Alice · Table 1']], 'KaraFun reçoit le titre au nom d’Alice seule');
  assert.equal(invite.duet.state, 'pending', 'l’invitation expire à l’accusé, pas avant');
  queue.push({ queueId: 7, songId: 1, singer: 'Alice · Table 1' });
  f.sync();
  assert.equal(f.getPending(), null, 'accusé reçu');
  assert.equal(invite.duet, undefined);
  assert.deepEqual(plain(inbox(bruno.p)), [['inviteExpired', { name: 'Alice', title: 'Un' }]]);
  assert.deepEqual(plain(inbox(alice.p)), [['inviteUnanswered', { name: 'Bruno', title: 'Un' }]]);
  const guest = f.publicState(null, '2', new Set([bruno.p.id])).tablePeople[0];
  assert.deepEqual(plain(guest.invites), []);
  assert.equal(guest.invite, null);
  await assert.rejects(f.call('POST /api/table/duet/answer', { ...bruno.body, accept: true, entryId: invite.entryId }),
    { message: 'Pas d\'invitation en cours.' });
  const owner = f.publicState(null, '1', new Set([alice.p.id])).tablePeople[0];
  assert.equal(owner.inKaraFun[0].duo, undefined, 'titre solo d’Alice dans KaraFun');
});

test('serveur : accepter pendant l’envoi est refusé, l’invitation est masquée à l’invité', async () => {
  const { f, alice, bruno, invite } = serverNight();
  const sel = f.sched.select();
  assert.deepEqual(plain(sel.ids), [alice.p.id]);
  f.setPending({ sel, before: new Set(), at: Date.now(), attempts: 1, retryAt: null });
  const message = 'Trop tard : ce titre part déjà dans KaraFun en solo, l’invitation a expiré.';
  await assert.rejects(f.call('POST /api/table/duet/answer', { ...bruno.body, accept: true, entryId: invite.entryId }), { message });
  await assert.rejects(f.call('POST /api/table/duet/answer', { ...bruno.body, accept: true }), { message },
    'sans titre précis : la seule invitation est visée');
  await assert.rejects(f.call('POST /api/duet/answer', { accept: true, entryId: invite.entryId }, bruno.p), { message });
  assert.equal(invite.duet.state, 'pending', 'rien n’a changé');
  const guest = f.publicState(null, '2', new Set([bruno.p.id])).tablePeople[0];
  assert.deepEqual(plain(guest.invites), [], 'plus de bouton Accepter pendant l’envoi');
  assert.equal(guest.invite, null);
  assert.equal(f.publicState(bruno.p, null).me.invites.length, 0);
  // Envoi annulé (auteure partie) : rien n'est retenu par ce garde.
  f.setPending({ sel, before: new Set(), at: Date.now(), cancelled: true });
  assert.equal(f.publicState(null, '2', new Set([bruno.p.id])).tablePeople[0].invites.length, 1);
  f.setPending(null);
  assert.deepEqual(plain(await f.call('POST /api/duet/answer', { accept: true, entryId: invite.entryId }, bruno.p)), { ok: true },
    'envoi terminé ou annulé : l’invitation s’accepte de nouveau');
  assert.equal(invite.duet.state, 'accepted');
});

test('serveur : file affichée et présence ou report de l’auteure seule', async () => {
  const { f, alice, bruno, chloe, invite } = serverNight();
  const pub = f.publicState(null, '2', new Set([bruno.p.id]));
  const line = pub.queue.find(item => item.song?.entryId === invite.entryId);
  assert.ok(line, 'le titre est dans la file');
  assert.equal(line.pos, 1, 'à sa place');
  assert.deepEqual(plain(line.ids), [alice.p.id]);
  assert.deepEqual(plain(line.song.duet), { partnerName: 'Bruno', state: 'pending', kind: 'duo', seen: false });
  const staff = f.staffState();
  assert.equal(staff.blocked, undefined, 'plus de « duo en attente d’accord » sauté au bar');
  assert.equal(staff.queue[0].song.duet.state, 'pending');
  // Présence obligatoire : Alice seule.
  f.sched.opts.requirePresence = true;
  const view = id => f.publicState(null, f.sched.people.get(id).tableId, new Set([id])).tablePeople
    .find(row => row.id === id);
  assert.equal(view(alice.p.id).needConfirm, true);
  assert.equal(view(bruno.p.id).needConfirm, false, 'Bruno n’est pas sollicité');
  assert.equal(view(alice.p.id).canDefer, true);
  assert.equal(view(bruno.p.id).canDefer, false);
  await assert.rejects(f.call('POST /api/table/confirm', bruno.body),
    { message: 'La présence sera demandée quand ce chanteur sera le prochain à passer.' });
  await assert.rejects(f.call('POST /api/table/defer', { ...bruno.body, songs: 1 }),
    { message: 'Tu pourras repousser ton passage quand ta chanson sera la prochaine.' });
  const deferred = plain(await f.call('POST /api/table/defer', { ...alice.body, songs: 1 }));
  assert.equal(deferred.deferral.ownerId, alice.p.id);
  assert.deepEqual(plain(alice.p.deferral.ids), [alice.p.id]);
  assert.equal(view(chloe.p.id).needConfirm, true, 'Chloé passe pendant le report d’Alice');
});

test('serveur : invitation acceptée pendant le report de son auteure, Bruno rejoint le report', async () => {
  const f = harness();
  const alice = person(f, '1', 'Alice'), bruno = person(f, '2', 'Bruno'), chloe = person(f, '3', 'Chloé');
  const invite = f.sched.inviteDuet(alice.p, bruno.p.id, song(1, 'Un'));
  f.sched.chooseSong(bruno.p, song(2, 'B-solo'));
  f.sched.chooseSong(chloe.p, song(3, 'C-solo'));
  const deferred = plain(await f.call('POST /api/table/defer', { ...alice.body, songs: 1 }));
  assert.equal(deferred.deferral.ownerId, alice.p.id);
  assert.deepEqual(plain(alice.p.deferral.ids), [alice.p.id], 'tant que l’invitation attend, Alice seule');
  assert.deepEqual(plain(await f.call('POST /api/table/duet/answer', { ...bruno.body, accept: true, entryId: invite.entryId })),
    { ok: true });
  assert.deepEqual(plain(alice.p.deferral.ids), [alice.p.id, bruno.p.id]);
  const guest = f.publicState(null, '2', new Set([bruno.p.id])).tablePeople[0];
  assert.equal(guest.deferral?.remaining, 1, 'le téléphone de Bruno affiche le report de son duo');
  const pub = f.publicState(null, '3', new Set([chloe.p.id]));
  assert.deepEqual(plain(pub.queue.filter(line => !line.future).map(line => [line.name, line.title])),
    [['Chloé', 'C-solo'], ['Alice & Bruno', 'Un'], ['Bruno', 'B-solo']], 'file affichée');
});

test('serveur : titre remplacé ou retiré pendant son envoi, un seul avis pour l’invité', async () => {
  const cases = [
    ['« Remplacer le 1er titre » de l’auteure', (f, alice) =>
      f.call('POST /api/table/song', { ...alice.body, song: song(3, 'Trois'), mode: 'replace' })],
    ['« Retirer » au bar', (f, alice) => f.call('POST /api/staff/remove', { personId: alice.p.id })],
  ];
  for (const [label, act] of cases) {
    const { f, alice, bruno, invite } = serverNight();
    const events = [];
    const journal = f.sched.onEvent;
    f.sched.onEvent = (type, fields) => { events.push(type); journal?.(type, fields); };
    const queue = [];
    const bridge = fakeBridge(queue);
    f.setBridge(bridge);
    f.settings.auto = true;
    f.sync();
    assert.deepEqual(bridge.calls, [['add', 1, 'Alice · Table 1']], `${label} : envoi en solo`);
    assert.equal(f.getPending()?.sel.song.entryId, invite.entryId);
    assert.equal(plain(await act(f, alice)).ok, true, `${label} : accepté pendant l’envoi`);
    f.settings.auto = false;
    queue.push({ queueId: 7, songId: 1, singer: 'Alice · Table 1' });
    f.sync();
    assert.equal(f.getPending(), null, `${label} : accusé reçu`);
    assert.deepEqual(plain(inbox(bruno.p)), [['duoCancelled', { name: 'Alice', title: 'Un' }]], `${label} : un seul avis`);
    assert.deepEqual(inbox(alice.p).filter(([kind]) => kind === 'inviteUnanswered'), [], label);
    assert.ok(!events.includes('duo.inviteExpired'), `${label} : aucune expiration au journal de soirée`);
    assert.ok(!f.sched.log.some(l => l.msg.includes('a expiré')), `${label} : aucune expiration au journal du bar`);
  }
});
