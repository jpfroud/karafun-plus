'use strict';
// Retours de la soirée v1.4 : une invitée doit pouvoir quitter un duo accepté,
// avant comme après l'envoi à KaraFun, sans que « Annuler duo » touche un
// autre duo ; une demande de duo ne retient jamais un titre (elle expire et
// la personne est prévenue) ; chaque personne reçoit les messages que son
// téléphone ne peut pas déduire de la file.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');

const song = (songId, title) => ({ songId, title, artist: 'Artiste' });
const kinds = p => (p.inbox || []).map(n => n.kind);
function trio(opts = {}) {
  const s = new Scheduler(opts);
  const events = [];
  s._event = (type, fields) => events.push([type, fields]);
  const join = (table, name) => s.join({ tableId: table, name, headcount: 2 });
  return { s, events, alice: join('1', 'Alice'), bruno: join('2', 'Bruno'), chloe: join('3', 'Chloé') };
}

test('« Annuler duo » sans titre précis ne supprime jamais le duo d’un autre titre de l’invitée', () => {
  const { s, alice, bruno, chloe } = trio();
  const withBruno = s.inviteDuet(alice, bruno.id, song(1, 'Un'));
  s.answerDuet(bruno, true, withBruno.entryId);
  const brunoOwn = s.inviteDuet(bruno, chloe.id, song(2, 'Deux'));
  s.answerDuet(chloe, true, brunoOwn.entryId);
  assert.throws(() => s.cancelDuet(bruno), { message: 'Choisis le duo à annuler.' });
  assert.equal(withBruno.duet.state, 'accepted', 'le duo d’Alice reste');
  assert.equal(brunoOwn.duet.state, 'accepted', 'le duo de Bruno reste');
  // Avec le titre, Bruno quitte le duo d'Alice, pas le sien.
  s.cancelDuet(bruno, withBruno.entryId);
  assert.equal(withBruno.duet, undefined);
  assert.equal(brunoOwn.duet.state, 'accepted');
  assert.deepEqual(kinds(alice), ['duoLeft']);
  assert.ok(s.log.some(l => l.msg === 'Bruno se retire du duo avec Alice sur « Un » : Alice le chantera en solo'));
  assert.throws(() => s.cancelDuet(bruno, 'inconnu'), { message: 'Duo introuvable.' });
});

test('invitée d’un duo accepté : se retirer avant l’envoi ne change aucun tour', () => {
  const { s, events, alice, bruno } = trio();
  const duo = s.inviteDuet(alice, bruno.id, song(1, 'Un'));
  s.answerDuet(bruno, true, duo.entryId);
  s.deferPassage(alice.id, { entryId: duo.entryId, ids: [alice.id, bruno.id] }, 1);
  const counters = () => JSON.stringify([[...s.roundApps], [...s.roundPeople], [...s.duetCooldowns], alice.sung, bruno.sung,
    bruno.duetGuestCount || 0, s.Q]);
  const before = counters();
  const result = s.leaveDuet(bruno, alice.id, duo.entryId);
  assert.equal(result.stage, 'planned');
  assert.equal(duo.duet, undefined, 'titre redevenu le solo d’Alice');
  assert.equal(counters(), before, 'aucun crédit à rendre avant l’envoi');
  assert.deepEqual(alice.deferral.ids, [alice.id], 'le report n’attend plus Bruno');
  assert.deepEqual(alice.inbox.map(n => [n.kind, n.params]), [['duoLeft', { name: 'Bruno', title: 'Un', sent: false }]]);
  assert.deepEqual(events.filter(([type]) => type === 'duo.left').map(([, f]) => f),
    [{ ownerId: alice.id, guestId: bruno.id, entryId: duo.entryId, sent: false }]);
  assert.throws(() => s.leaveDuet(bruno, alice.id, duo.entryId), { message: 'Duo introuvable.' });
  // Invitation encore en attente : se retirer revient à refuser.
  const pending = s.inviteDuet(alice, bruno.id, song(2, 'Deux'));
  s.leaveDuet(bruno, alice.id, pending.entryId);
  assert.equal(pending.duet, undefined);
  assert.equal(alice.inbox.at(-1).kind, 'duoRefused');
});

// État de l'invitée tel que le duo l'a touché.
function guestState(s, p) {
  return JSON.stringify({ apps: s.roundApps.get(p.id) || 0, round: s.roundPeople.has(p.id),
    cooldown: s.duetCooldowns.get(p.id) ?? null, owed: s.roundOwed.has(p.id), guestCount: p.duetGuestCount || 0,
    last: p.lastAppearanceTurn || 0, served: s.tableServeCounts.get(p.group) || 0, groupRound: s.roundGroups.has(p.group),
    sung: p.sung || 0, song: p.song?.entryId || null });
}

test('duo déjà dans KaraFun : l’invitée récupère exactement sa part du tour, le titre reste celui de l’auteur', () => {
  const { s, events, alice, bruno, chloe } = trio();
  // Chloé chante d'abord, pour que l'état du tour ne soit pas vide.
  s.chooseSong(chloe, song(20, 'Titre de Chloé'));
  const sel = s.select();
  assert.deepEqual(sel.ids, [chloe.id]);
  s.commit(sel);
  s.chooseSong(bruno, song(10, 'Titre de Bruno'));
  const duo = s.inviteDuet(alice, bruno.id, song(1, 'Un'));
  s.answerDuet(bruno, true, duo.entryId);
  s.Q = [alice.id, bruno.id, chloe.id];
  const brunoBefore = guestState(s, bruno);
  const duoSel = s.select();
  assert.deepEqual(duoSel.ids, [alice.id, bruno.id], 'le duo part');
  s.commit(duoSel);
  assert.notEqual(guestState(s, bruno), brunoBefore, 'le duo a compté pour Bruno');
  const aliceAfterCommit = JSON.stringify([alice.sung, alice.lastAppearanceTurn, s.roundApps.get(alice.id), s.Q]);
  s.leaveSentDuet(duoSel, bruno.id);
  assert.equal(guestState(s, bruno), brunoBefore, 'Bruno revient à son état d’avant le duo');
  assert.equal(JSON.stringify([alice.sung, alice.lastAppearanceTurn, s.roundApps.get(alice.id), s.Q]), aliceAfterCommit,
    'Alice garde son passage');
  assert.deepEqual(duoSel.ids, [alice.id]);
  assert.deepEqual(duoSel.consumedIds, [alice.id]);
  assert.deepEqual(duoSel.names, ['Alice']);
  assert.equal(duoSel.kind, undefined);
  assert.equal(duoSel.label, 'Alice · Table 1');
  assert.deepEqual(duoSel.groups, [alice.group]);
  assert.deepEqual(s.recentGroups.at(-1), [alice.group]);
  assert.deepEqual(alice.inbox.at(-1).params, { name: 'Bruno', title: 'Un', sent: true });
  assert.ok(s.log.some(l => /Bruno se retire du duo avec Alice sur « Un », déjà dans KaraFun/.test(l.msg)));
  assert.ok(events.some(([type, f]) => type === 'duo.left' && f.sent === true && f.by === 'guest'));
  assert.throws(() => s.leaveSentDuet(duoSel, bruno.id), { message: 'Duo introuvable.' });
  // KaraFun retire ensuite le titre sans qu'il soit chanté : seule Alice est concernée.
  s.rollbackUnplayed(duoSel);
  assert.equal(guestState(s, bruno), brunoBefore, 'l’annulation ne touche plus Bruno');
  assert.equal(alice.sung, 0, 'le passage d’Alice est annulé');
});

test('duo improvisé noté au bar puis invitée partie : son passage compté par le bar est retiré', () => {
  const { s, alice, bruno } = trio();
  s.chooseSong(alice, song(1, 'Un'));
  s.chooseSong(bruno, song(2, 'Deux'));
  const brunoBefore = guestState(s, bruno);
  const sel = s.select();
  const owner = s.people.get(sel.ids[0]);
  const partner = owner === alice ? bruno : alice;
  const partnerBefore = owner === alice ? brunoBefore : guestState(s, alice);
  s.commit(sel);
  s.staffCountPartner(owner.id, partner.id, sel, []);
  sel.ids.push(partner.id); sel.names.push(partner.name); sel.kind = 'duo';
  s.leaveSentDuet(sel, partner.id, { by: 'staff' });
  assert.equal(guestState(s, partner), partnerBefore);
  assert.ok(s.log.some(l => l.msg.startsWith(`${partner.name} est parti : ${owner.name} chantera « ${sel.song.title} » en solo`)));
  // « Chanter seul » côté auteur : l'invitée est prévenue.
  s.staffCountPartner(owner.id, partner.id, sel, []);
  sel.ids.push(partner.id); sel.names.push(partner.name); sel.kind = 'duo';
  s.leaveSentDuet(sel, partner.id, { by: 'owner', keepLabel: true });
  assert.equal(partner.inbox.at(-1).kind, 'duoCancelled');
  assert.equal(sel.label, `${owner.name} · ${s.table(owner.tableId).name}`, 'le nom affiché n’a pas changé');
});

test('demande de duo jamais retenue : le titre part, la demande expire et la personne est prévenue', () => {
  const { s, events, alice, bruno, chloe } = trio();
  s.chooseSong(alice, song(1, 'Un'));
  s.requestDuetJoin(chloe, alice.id, alice.song.entryId);
  s.requestDuetJoin(bruno, alice.id, alice.song.entryId);
  const sent = alice.song;
  const sel = s.select();
  assert.deepEqual(sel.ids, [alice.id], 'une demande sans réponse ne retient pas le titre');
  s.commit(sel);
  assert.equal(sent.duoRequests, undefined, 'plus de demande sur le titre envoyé');
  assert.deepEqual(s.duetJoinRequestsBy(chloe), []);
  for (const p of [chloe, bruno]) assert.deepEqual(p.inbox.map(n => [n.kind, n.params]), [['joinExpired', { name: 'Alice', title: 'Un', reason: 'sent' }]]);
  assert.ok(s.log.some(l => l.kind === 'staff' && l.msg === 'La demande de duo de Chloé à Alice a expiré : « Un » est parti dans KaraFun'));
  assert.deepEqual(events.filter(([type]) => type === 'duo.joinExpired').map(([, f]) => f.requesterId), [chloe.id, bruno.id]);
  // Le titre revient dans la liste (retiré de KaraFun avant d'être chanté) : sans les demandes.
  s.requeueUnplayed(sel);
  assert.equal(alice.song.duoRequests, undefined);
});

test('titre retiré ou remplacé : demandes closes et invitée du duo prévenue', () => {
  const { s, alice, bruno, chloe } = trio();
  s.chooseSong(alice, song(1, 'Un'));
  s.requestDuetJoin(chloe, alice.id, alice.song.entryId);
  s.removeSong(alice, alice.song.entryId);
  assert.deepEqual(chloe.inbox.at(-1).params, { name: 'Alice', title: 'Un', reason: 'removed' });
  assert.ok(s.log.some(l => l.msg === 'La demande de duo de Chloé à Alice est close : « Un » n’est plus dans sa liste'));
  const duo = s.inviteDuet(alice, bruno.id, song(2, 'Deux'));
  s.answerDuet(bruno, true, duo.entryId);
  s.chooseSong(alice, song(3, 'Trois'), 'replace');
  assert.deepEqual(bruno.inbox.at(-1).params, { name: 'Alice', title: 'Deux' });
  assert.equal(bruno.inbox.at(-1).kind, 'duoCancelled');
  // Retrait par le bar d'un titre suivant, puis du titre courant.
  s.chooseSong(alice, song(4, 'Quatre'), 'append');
  s.requestDuetJoin(chloe, alice.id, alice.backlog[0].entryId);
  s.staffRemoveEntry(alice.id, alice.backlog[0].entryId);
  assert.equal(chloe.inbox.at(-1).params.title, 'Quatre');
  s.requestDuetJoin(chloe, alice.id, alice.song.entryId);
  s.staffRemove(alice.id);
  assert.equal(chloe.inbox.at(-1).params.title, 'Trois');
  // Personne partie : ses duos et les demandes sur ses titres sont clos.
  s.chooseSong(alice, song(5, 'Cinq'));
  s.requestDuetJoin(chloe, alice.id, alice.song.entryId);
  const guestDuo = s.inviteDuet(bruno, alice.id, song(6, 'Six'));
  s.answerDuet(alice, true, guestDuo.entryId);
  s.leave(alice);
  assert.equal(chloe.inbox.at(-1).params.title, 'Cinq');
  assert.deepEqual(bruno.inbox.at(-1).params, { name: 'Alice', title: 'Six', sent: false });
});

test('messages : invitation refusée ou annulée, duo direct, demande acceptée ou refusée, présence manquée', () => {
  const { s, alice, bruno, chloe } = trio({ requirePresence: true });
  const mate = s.join({ tableId: '1', name: 'Marie' });
  let duo = s.inviteDuet(alice, bruno.id, song(1, 'Un'));
  s.answerDuet(bruno, false, duo.entryId);
  assert.deepEqual(alice.inbox.at(-1).params, { name: 'Bruno', title: 'Un' });
  duo = s.inviteDuet(alice, bruno.id, song(2, 'Deux'));
  s.cancelDuet(alice, duo.entryId);
  assert.equal(bruno.inbox.at(-1).kind, 'duoCancelled');
  s.inviteDuet(alice, mate.id, song(3, 'Trois'));
  assert.deepEqual(mate.inbox.at(-1).params, { name: 'Alice', fromId: alice.id, title: 'Trois', entryId: s.songsOf(alice).at(-1).entryId });
  s.chooseSong(bruno, song(4, 'Quatre'));
  s.requestDuetJoin(chloe, bruno.id, bruno.song.entryId);
  s.requestDuetJoin(alice, bruno.id, bruno.song.entryId);
  s.answerDuetJoin(bruno, bruno.song.entryId, chloe.id, true);
  assert.equal(chloe.inbox.at(-1).kind, 'joinAccepted');
  assert.equal(alice.inbox.at(-1).kind, 'joinRefused', 'les autres demandes sur ce titre sont closes');
  s.chooseSong(chloe, song(5, 'Cinq'));
  s.requestDuetJoin(alice, chloe.id, chloe.song.entryId);
  s.answerDuetJoin(chloe, chloe.song.entryId, alice.id, false);
  assert.deepEqual(alice.inbox.at(-1).params, { name: 'Chloé', title: 'Cinq' });
  s.requestDuetJoin(mate, alice.id, s.songsOf(alice)[0].entryId);
  assert.equal(alice.inbox.at(-1).kind, 'duoAdded', 'même table : duo direct signalé à l’auteur');
  // Présence manquée trois fois : le titre est retiré, la personne prévenue.
  for (let i = 0; i < 3; i++) s.skipUnconfirmed(chloe.id, 3);
  assert.deepEqual(chloe.inbox.at(-1).params, { title: 'Cinq', skips: 3 });
});

test('messages : gardés 30 minutes, dix au plus, effacés par le téléphone', () => {
  const { s, events, alice } = trio();
  const realNow = Date.now;
  try {
    let now = realNow();
    Date.now = () => now;
    for (let i = 0; i < 12; i++) s.notify(alice.id, 'duoRefused', { name: 'X', title: `T${i}` });
    assert.equal(s.inboxOf(alice).length, 10);
    assert.equal(s.inboxOf(alice)[0].params.title, 'T2');
    const [first, second] = s.inboxOf(alice);
    assert.equal(s.ackNotices(alice, [first.id, 'inconnu']), 1);
    assert.equal(s.ackNotices(alice, 'inconnu'), 0);
    assert.equal(s.inboxOf(alice)[0].id, second.id);
    now += 31 * 60 * 1000;
    assert.deepEqual(s.inboxOf(alice), []);
    assert.equal(s.notify('inconnu', 'duoRefused'), null);
    assert.equal(events.filter(([type]) => type === 'notice.sent').length, 12);
    assert.deepEqual(events[0][1], { personId: alice.id, kind: 'duoRefused' });
  } finally { Date.now = realNow; }
  assert.deepEqual(s.inboxOf(null), []);
});
