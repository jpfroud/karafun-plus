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

// Relecture (passe 5) : seul « Je ne chante plus ce duo » retirait l'invitée
// du report « Pas prêt » de l'auteur. « Annuler duo » (et « Chanter seul »
// avant l'envoi, même geste), l'invitée marquée partie, sa table partie ou
// son « Je pars » l'y laissaient : son propre titre attendait derrière le
// report d'une autre, et son téléphone pouvait encore le lever (« Je suis
// prêt ») ou le prolonger. Rejoindre un duo ouvert l'y ajoute, quelle que
// soit la table du volontaire.
test('duo défait pendant un « Pas prêt » de son auteur : le report n’attend plus l’ex-invité, par tous les chemins', () => {
  const order = s => s.presenceView().filter(v => !v.future).map(v => v.ids.map(pid => s.people.get(pid).name).join(' & '));
  for (const origin of ['duo ouvert rejoint', 'invitation acceptée']) {
    for (const how of ['Annuler duo', 'se retire', 'marqué parti', 'table partie', 'part puis revient']) {
      const label = `${origin}, ${how}`;
      const s = new Scheduler();
      s._event = () => {};
      const join = (table, name) => s.join({ tableId: table, name, headcount: 1 });
      const ines = join('1', 'Inès'), gil = join('2', 'Gil'), maud = join('3', 'Maud'), hugo = join('4', 'Hugo');
      const duo = origin === 'duo ouvert rejoint' ? s.openDuet(ines, { song: song(1, 'Un') }) : s.inviteDuet(ines, gil.id, song(1, 'Un'));
      [gil, maud, hugo].forEach((p, i) => s.chooseSong(p, song(10 + i, `Titre de ${p.name}`)));
      s.deferPassage(ines.id, s.presenceView().find(v => v.ids[0] === ines.id), 2);
      const deferred = order(s);
      assert.deepEqual(deferred, ['Gil', 'Maud', 'Inès', 'Hugo'], `${label} : Inès laisse passer deux chansons`);
      if (origin === 'duo ouvert rejoint') s.acceptOpenDuet(gil, ines.id, duo.entryId);
      else s.answerDuet(gil, true, duo.entryId);
      assert.deepEqual(ines.deferral.ids, [ines.id, gil.id], `${label} : le report attend aussi Gil`);
      if (how === 'Annuler duo') s.cancelDuet(ines, duo.entryId);
      else if (how === 'se retire') s.leaveDuet(gil, ines.id, duo.entryId);
      else if (how === 'marqué parti') s.leave(gil, 'staff');
      else if (how === 'table partie') s.tableLeft('2');
      else { s.leave(gil); s.chooseSong(gil, song(20, 'Retour de Gil')); }
      assert.equal(duo.duet, undefined, `${label} : solo d’Inès`);
      assert.deepEqual(ines.deferral.ids, [ines.id], `${label} : le report n’attend plus Gil`);
      assert.deepEqual([ines.deferral.remaining, ines.deferral.total], [2, 2], `${label} : celui d’Inès reste entier`);
      assert.equal(s.deferralFor(gil.id), null, `${label} : rien à lever ni à prolonger pour Gil`);
      if (!s.people.has(gil.id) || gil.withdrawnAt) continue;
      assert.throws(() => s.cancelDeferral(gil.id), { message: 'Aucun passage repoussé pour cette personne.' });
      assert.equal(s.deferralFor(ines.id)?.remaining, 2, `${label} : « Je suis prêt » de Gil ne lève pas le report d’Inès`);
      // Gil garde la place de son titre, sans attendre le report d'Inès.
      if (how !== 'part puis revient') assert.deepEqual(order(s), deferred, `${label} : l’ordre d’avant le duo`);
    }
  }
});

// « Pas prêt » sur un duo déjà chargé dans KaraFun (server.js, deferTurn) :
// le report est noté pendant que le titre en sort, hors de la liste de son
// auteur. L'invité marqué parti entre-temps n'y reste pas non plus.
test('duo chargé repoussé par « Pas prêt » en train de sortir de KaraFun : l’invité marqué parti quitte le report', () => {
  const s = new Scheduler();
  s._event = () => {};
  const join = (table, name) => s.join({ tableId: table, name, headcount: 2 });
  const elsa = join('1', 'Elsa'), paulo = join('2', 'Paulo'), nina = join('3', 'Nina');
  const duo = s.inviteDuet(elsa, paulo.id, song(1, 'Un'));
  s.answerDuet(paulo, true, duo.entryId);
  s.chooseSong(nina, song(2, 'Deux'));
  const sel = s.select();
  assert.deepEqual(sel.ids, [elsa.id, paulo.id]);
  s.commit(sel);
  s.deferPassage(elsa.id, { entryId: sel.song.entryId, ids: sel.ids, song: sel.song }, 1);
  assert.deepEqual(elsa.deferral.ids, [elsa.id, paulo.id]);
  s.leave(paulo, 'staff');
  assert.deepEqual(elsa.deferral.ids, [elsa.id], 'le report n’attend plus Paulo');
  // Retrait confirmé par KaraFun (restorePulled) : le titre revient, reporté.
  s.requeueUnplayed(sel);
  assert.equal(s.deferralFor(paulo.id), null);
  assert.equal(s.deferralFor(elsa.id)?.remaining, 1, 'celui d’Elsa reste');
  assert.deepEqual(elsa.deferral.ids, [elsa.id]);
});

// Relecture (passe 6) : un report « Pas prêt » remis depuis un état gardé ne
// passait pas par _dropDeferredGuest. L'annulation d'un déplacement du bar
// qui l'avait levé (_undoRebased, ou restoreManualOverride quand rien n'a
// changé depuis), et le retour d'un passage non chanté dont l'envoi l'avait
// levé (rollbackUnplayed), rendaient ses personnes d'avant le duo défait :
// l'ex-invité y revenait, son titre attendait derrière ce report, et son
// téléphone pouvait de nouveau le lever ou le prolonger.
test('report « Pas prêt » remis par une annulation du bar ou un passage non chanté : l’ex-invité du duo défait n’y revient pas', async t => {
  for (const path of ['annulation du déplacement', 'état d’avant le geste', 'passage non chanté']) {
    for (const how of ['Annuler duo', 'se retire', 'marqué parti']) await t.test(`${path}, ${how}`, () => {
      const label = `${path}, ${how}`;
      const s = new Scheduler();
      s._event = () => {};
      const names = ids => ids.map(pid => s.people.get(pid).name);
      const order = () => s.presenceView().filter(v => !v.future).map(v => names(v.ids).join(' & '));
      const join = (table, name) => s.join({ tableId: table, name, headcount: 1 });
      const ines = join('1', 'Inès'), gil = join('2', 'Gil'), maud = join('3', 'Maud'), hugo = join('4', 'Hugo');
      const duo = s.inviteDuet(ines, gil.id, song(1, 'Un'));
      s.answerDuet(gil, true, duo.entryId);
      [gil, maud, hugo].forEach((p, i) => s.chooseSong(p, song(10 + i, `Titre de ${p.name}`)));
      const rollback = path === 'passage non chanté';
      s.deferPassage(ines.id, s.presenceView().find(v => v.ids[0] === ines.id), rollback ? 1 : 2);
      assert.deepEqual(names(ines.deferral.ids), ['Inès', 'Gil'], `${label} : le report attend aussi Gil`);
      let restore;
      if (rollback) {
        // Le passage de Maud lève le report d'une chanson d'Inès, puis sort
        // de KaraFun sans avoir été chanté.
        const sel = s.select();
        assert.deepEqual(sel.ids, [maud.id], `${label} : Maud passe d’abord`);
        s.commit(sel);
        assert.equal(ines.deferral, null, `${label} : l’envoi de Maud lève le report`);
        restore = () => s.requeueUnplayed(sel);
      } else {
        const before = s.manualOverrideState({ deferrals: true });
        s.staffMove(ines.id, 1);
        assert.equal(ines.deferral, null, `${label} : le déplacement lève le report`);
        const change = s.recordManualChange({ kind: 'move', personId: ines.id, name: 'Inès', from: 3, to: 2, before, native: 'n' });
        // Annulation après le duo défait : la file a changé, _undoRebased.
        // Sans changement, l'annulation exacte remet l'état d'avant le geste.
        restore = path === 'annulation du déplacement' ? () => {
          assert.equal(s.canUndoManualChange('n'), false);
          s.undoLastManualChange(change.id, 'n');
        } : () => s.restoreManualOverride(before, { deferrals: true });
      }
      if (how === 'Annuler duo') s.cancelDuet(ines, duo.entryId);
      else if (how === 'se retire') s.leaveDuet(gil, ines.id, duo.entryId);
      else s.leave(gil, 'staff');
      assert.equal(duo.duet, undefined, `${label} : solo d’Inès`);
      restore();
      assert.ok(s.isDeferred(ines), `${label} : le report d’Inès revient`);
      assert.deepEqual(names(ines.deferral.ids), ['Inès'], `${label} : le report revenu n’attend plus Gil`);
      assert.equal(s.deferralFor(gil.id), null, `${label} : rien à lever ni à prolonger pour Gil`);
      if (gil.withdrawnAt) return;
      // Le titre de Gil n'attend plus derrière le report d'Inès, qui laisse
      // passer ses chansons (avant le correctif : Maud, Hugo, Inès, Gil après
      // l'annulation ; Maud, Inès, Gil, Hugo après le passage non chanté).
      if (path === 'annulation du déplacement') assert.deepEqual(order(), ['Gil', 'Maud', 'Inès', 'Hugo'], label);
      if (rollback) assert.deepEqual(order(), ['Gil', 'Inès', 'Maud', 'Hugo'], label);
      assert.throws(() => s.cancelDeferral(gil.id), { message: 'Aucun passage repoussé pour cette personne.' });
      assert.ok(s.isDeferred(ines), `${label} : « Je suis prêt » de Gil ne lève pas le report d’Inès`);
    });
  }
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
  // Duo d'Alice ajouté avant le titre de Bruno : premiers passages dans
  // l'ordre d'ajout, il part d'abord.
  const duo = s.inviteDuet(alice, bruno.id, song(1, 'Un'));
  s.answerDuet(bruno, true, duo.entryId);
  s.chooseSong(bruno, song(10, 'Titre de Bruno'));
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
    assert.deepEqual(events.find(([type]) => type === 'notice.sent')[1], { personId: alice.id, kind: 'duoRefused' });
  } finally { Date.now = realNow; }
  assert.deepEqual(s.inboxOf(null), []);
});

test('duo déjà dans KaraFun : un passage de l’invitée envoyé depuis n’est pas effacé par son retrait', () => {
  const { s, alice, bruno } = trio({ roundAppearanceCap: 0, spacingSongs: 0 });
  // Duo ajouté avant le titre de Bruno : il part d'abord (ordre d'ajout).
  const duo = s.inviteDuet(alice, bruno.id, song(1, 'Un'));
  s.answerDuet(bruno, true, duo.entryId);
  s.chooseSong(bruno, song(10, 'Titre de Bruno'));
  s.Q = [alice.id, bruno.id];
  const duoSel = s.select();
  assert.deepEqual(duoSel.ids, [alice.id, bruno.id]);
  s.commit(duoSel);
  // Le titre de Bruno part aussi dans KaraFun, derrière le duo.
  const own = s.select();
  assert.deepEqual(own.ids, [bruno.id]);
  s.commit(own);
  const apps = s.roundApps.get(bruno.id);
  s.leaveSentDuet(duoSel, bruno.id);
  assert.equal(s.roundApps.get(bruno.id), apps, 'son propre passage reste compté');
  assert.ok(s.roundPeople.has(bruno.id), 'et Bruno reste servi dans ce tour');
});

// Relecture : l'invitée d'un duo déjà chargé, qui s'en retire, sort aussi du
// cycle des premiers passages où ce duo avait fait passer sa table. Le cas
// où ce duo fermait le cycle n'était pas défait : le cycle repartait vide, et
// une deuxième personne de la table de l'auteur passait avant la table de
// l'invitée, qui n'avait pas eu son tour.
test('premiers passages : l’invitée se retire d’un duo chargé, sa table garde son tour dans le cycle', () => {
  for (const closes of [true, false]) {
    let n = 1;
    const tune = () => song(n, `Titre ${n++}`);
    const s = new Scheduler();
    s.setHeadcount('A', 2); s.setHeadcount('B', 1);
    const lea = s.join({ tableId: 'A', name: 'Léa' }), max = s.join({ tableId: 'A', name: 'Max' });
    const zoe = s.join({ tableId: 'B', name: 'Zoé' });
    // Sans fermeture : une troisième table attend encore son premier passage.
    const gus = closes ? null : s.join({ tableId: 'C', name: 'Gus', headcount: 1 });
    const duo = s.inviteDuet(lea, zoe.id, tune());
    s.chooseSong(max, tune()); s.chooseSong(zoe, tune());
    if (gus) s.chooseSong(gus, tune());
    s.answerDuet(zoe, true, duo.entryId);
    const sel = s.select();
    assert.deepEqual(sel.names, ['Léa', 'Zoé']);
    s.commit(sel);
    assert.deepEqual([...s.firstCycle].sort(), closes ? [] : ['A', 'B'], closes ? 'le duo ferme le cycle' : 'le cycle reste ouvert');
    s.leaveSentDuet(sel, zoe.id);
    assert.deepEqual([...s.firstCycle], ['A'], `fermeture ${closes} : seule la table A est passée dans ce cycle`);
    assert.deepEqual(s.readyView().map(v => v.name), closes ? ['Zoé', 'Max'] : ['Zoé', 'Gus', 'Max'],
      `fermeture ${closes} : comme si Léa avait chanté seule`);
    // KaraFun retire ensuite le titre sans qu'il soit chanté : le cycle d'avant revient.
    s.rollbackUnplayed(sel, { requeue: true });
    assert.deepEqual([...s.firstCycle], [], `fermeture ${closes} : cycle d’avant le passage rendu`);
  }
});

// Relecture : la correction ci-dessus ne valait que pour un duo déjà chargé.
// Marquée partie par le bar pendant l'envoi du duo (pas encore d'accusé de
// KaraFun, ou envoi interrompu par une mise à jour), l'invitée laissait sa
// table dans le cycle noté au choix du passage, que l'accusé appliquait tel
// quel : Bob, de sa table, perdait sa place, et un duo qui fermait le cycle
// le fermait sans elle. Le même geste du bar donne maintenant le même ordre,
// que KaraFun ait accusé l'envoi ou non.
test('premiers passages : invitée marquée partie pendant l’envoi du duo, sa table garde son tour dans le cycle', () => {
  const realNow = Date.now;
  let clock = Date.UTC(2026, 9, 25, 20, 0, 0);
  Date.now = () => clock;
  try {
    for (const closes of [false, true]) {
      for (const when of ['chargé', 'pendant l’envoi']) {
        let n = 1;
        const tune = () => song(n, `Titre ${n++}`);
        const s = new Scheduler();
        s.setHeadcount('A', 2); s.setHeadcount('B', 2);
        const alice = s.join({ tableId: 'A', name: 'Alice' }), ann = s.join({ tableId: 'A', name: 'Ann' });
        const bea = s.join({ tableId: 'B', name: 'Bea' }), bob = s.join({ tableId: 'B', name: 'Bob' });
        // Sans fermeture : une troisième table attend encore son premier passage.
        const cid = closes ? null : s.join({ tableId: 'C', name: 'Cid', headcount: 1 });
        clock += 1000; const duo = s.inviteDuet(alice, bea.id, tune());
        s.answerDuet(bea, true, duo.entryId);
        for (const p of [bob, cid, ann].filter(Boolean)) { clock += 1000; s.chooseSong(p, tune()); }
        clock += 45000;
        const sel = s.select();
        assert.deepEqual(sel.names, ['Alice', 'Bea']);
        if (when === 'chargé') {
          s.commit(sel);
          s.leaveSentDuet(sel, bea.id, { by: 'staff' });
        } else s.leaveSentDuet(sel, bea.id, { by: 'staff', keepLabel: true }); // keepSentDuosOfLeavers
        s.leave(bea, 'staff');
        if (when !== 'chargé') s.commit(sel);
        const label = `fermeture ${closes}, ${when}`;
        assert.deepEqual([...s.firstCycle], ['A'], `${label} : seule la table A est passée dans ce cycle`);
        assert.deepEqual(s.readyView().map(v => v.name), closes ? ['Bob', 'Ann'] : ['Bob', 'Cid', 'Ann'],
          `${label} : comme si Alice avait chanté seule`);
      }
    }
  } finally { Date.now = realNow; }
});
