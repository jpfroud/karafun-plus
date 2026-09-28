'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const song = n => ({ songId: n, title: `Titre ${n}`, artist: 'Soirée' });
const join = (s, tableId, name, headcount) => s.join({ tableId, name, headcount });

test('renommer la table ne change ni son identité ni ses chanteurs', () => {
  const s = new Scheduler();
  const a = join(s, '1', 'Anne', 2);
  const b = join(s, '1', 'Bruno');
  s.setHeadcount('2', 1);
  const t = s.table('1');
  assert.equal(s.renameTable('1', '  Coin   fenêtre  '), t);
  assert.equal(t.name, 'Coin fenêtre');
  assert.equal(t.id, '1');
  assert.deepEqual(s.tableSingers('1').map(p => p.id), [a.id, b.id]);
  assert.throws(() => s.renameTable('1', 'Table 2'), /déjà utilisé/);
  assert.throws(() => s.renameTable('1', ''), /1 à 40/);
  assert.throws(() => s.renameTable('1', 'x'.repeat(41)), /1 à 40/);
});

test('deux duos de la même table et un solo restent trois titres distincts', () => {
  const s = new Scheduler();
  const a = join(s, '1', 'Anne', 2), b = join(s, '1', 'Bruno');
  s.inviteDuet(a, b.id, song(11));
  s.chooseSong(a, song(12), 'append');
  s.inviteDuet(a, b.id, song(13));
  assert.deepEqual(s.songsOf(a).map(x => x.songId), [11, 12, 13]);
  assert.deepEqual(s.songsOf(a).map(x => x.duet?.state || null), ['accepted', null, 'accepted']);
  assert.equal(s.duetInvites(b).length, 0, 'la même table accepte sans action');
  const first = s.select();
  assert.equal(first.kind, 'duo');
  s.commit(first); s.songEnded(first.ids);
  assert.equal(s.select().song.songId, 12);
  const second = s.select(); s.commit(second); s.songEnded(second.ids);
  assert.equal(s.select().song.songId, 13);
  assert.equal(s.select().kind, 'duo');
  assert.equal(b.sung, 0, 'l’invité conserve son tour');
});

test('deux invitations croisées se répondent séparément par identifiant', () => {
  const s = new Scheduler();
  const a = join(s, '1', 'Anne', 1), b = join(s, '2', 'Bruno', 1);
  const first = s.inviteDuet(a, b.id, song(21));
  s.chooseSong(a, song(22), 'append');
  const second = s.inviteDuet(a, b.id, song(23));
  assert.deepEqual(s.duetInvites(b).map(x => x.entryId), [first.entryId, second.entryId]);
  assert.throws(() => s.answerDuet(b, true), /Choisis l’invitation/);
  s.answerDuet(b, true, second.entryId);
  assert.equal(s.songsOf(a)[2].duet.state, 'accepted');
  assert.equal(s.duetInvites(b).length, 1);
  s.answerDuet(b, false, first.entryId);
  assert.equal(s.songsOf(a)[0].duet, undefined);
  assert.equal(s.songsOf(a)[2].duet.state, 'accepted');
  assert.equal(s.duetInvites(b).length, 0);
});

test('une personne peut accepter des duos avec plusieurs initiateurs', () => {
  const s = new Scheduler();
  const a = join(s, '1', 'Anne', 1), b = join(s, '2', 'Bruno', 1), c = join(s, '3', 'Carla', 1);
  const x = s.inviteDuet(a, b.id, song(31));
  const y = s.inviteDuet(c, b.id, song(32));
  assert.equal(s.duetInvites(b).length, 2);
  s.answerDuet(b, true, x.entryId);
  s.answerDuet(b, true, y.entryId);
  assert.equal(s.duetInvites(b).length, 0);
  assert.equal(a.duet.state, 'accepted');
  assert.equal(c.duet.state, 'accepted');
});

test('réordonner la liste conserve les duos, invitations et le ticket', () => {
  const s = new Scheduler();
  const a = join(s, '1', 'Anne', 1), b = join(s, '2', 'Bruno', 1);
  s.chooseSong(a, song(41), 'append');
  const duo = s.inviteDuet(a, b.id, song(42));
  s.chooseSong(a, song(43), 'append');
  const before = s.Q.indexOf(a.id);
  s.reorderSongs(a, duo.entryId, 2);
  assert.deepEqual(s.songsOf(a).map(x => x.songId), [41, 43, 42]);
  assert.equal(s.Q.indexOf(a.id), before);
  assert.equal(s.duetInvites(b)[0].entryId, duo.entryId);
  s.answerDuet(b, true, duo.entryId);
  s.reorderSongs(a, duo.entryId, 0);
  assert.equal(s.select().kind, 'duo');
  assert.equal(s.select().song.songId, 42);
  assert.throws(() => s.reorderSongs(a, 'autre-personne', 0), /introuvable/);
  assert.throws(() => s.reorderSongs(a, duo.entryId, 99), /invalide/);
});

test('retirer la première chanson au bar garde exactement la place et prend la suivante', () => {
  const s = new Scheduler();
  const a = join(s, '1', 'Anne', 1), b = join(s, '2', 'Bruno', 1), c = join(s, '3', 'Carla', 1);
  s.chooseSong(a, song(51), 'append');
  s.chooseSong(a, song(52), 'append');
  s.chooseSong(b, song(53)); s.chooseSong(c, song(54));
  s.Q = [b.id, a.id, c.id];
  s.manualOrder = [b.id, a.id, c.id];
  const beforeQ = s.Q.slice(), beforeView = s.readyView().map(x => x.ids[0]);
  s.staffRemove(a.id);
  assert.deepEqual(s.Q, beforeQ);
  assert.deepEqual(s.readyView().slice(0, 3).map(x => x.ids[0]), beforeView.slice(0, 3),
    'son titre suivant prend la même place ; une ligne future disparaît');
  assert.equal(a.song.songId, 52);
  assert.deepEqual(s.manualOrder, [b.id, a.id, c.id]);
  s.staffRemove(a.id);
  assert.deepEqual(s.Q, beforeQ, 'sans autre titre, le ticket reste inscrit');
  s.chooseSong(a, song(55), 'append');
  assert.deepEqual(s.Q, beforeQ, 'un nouveau titre reprend le ticket existant');
});

test('retirer un futur duo supprime son invitation, pas les autres chansons', () => {
  const s = new Scheduler();
  const a = join(s, '1', 'Anne', 1), b = join(s, '2', 'Bruno', 1);
  const first = s.inviteDuet(a, b.id, song(61));
  const second = s.inviteDuet(a, b.id, song(62));
  s.removeSong(a, second.entryId);
  assert.deepEqual(s.duetInvites(b).map(x => x.entryId), [first.entryId]);
  assert.equal(s.songsOf(a).length, 1);
  s.staffRemove(a.id);
  assert.equal(s.duetInvites(b).length, 0);
});

test('départ du partenaire annule tous les duos le concernant mais garde les titres solos', () => {
  const s = new Scheduler();
  const a = join(s, '1', 'Anne', 1), b = join(s, '2', 'Bruno', 1);
  s.inviteDuet(a, b.id, song(71));
  s.inviteDuet(a, b.id, song(72));
  s.tableLeft('2');
  assert.deepEqual(s.songsOf(a).map(x => x.songId), [71, 72]);
  assert.ok(s.songsOf(a).every(x => !x.duet));
  assert.equal(s.select().ids.length, 1);
});

test('simulation déterministe de 40 titres avec duos : aucun titre perdu ni tour invité consommé', () => {
  const s = new Scheduler({ tableRotation: true });
  const people = [
    join(s, '1', 'Anne', 2), join(s, '1', 'Alex'), join(s, '2', 'Bruno', 1),
    join(s, '3', 'Carla', 2), join(s, '3', 'Camille'),
  ];
  let next = 100;
  const expected = new Set();
  for (let round = 0; round < 8; round++) for (let i = 0; i < people.length; i++) {
    const p = people[i];
    const n = next++;
    if (round % 3 === 0 && i === 0) {
      const entry = s.inviteDuet(p, people[2].id, song(n));
      s.answerDuet(people[2], true, entry.entryId);
    } else if (round % 3 === 1 && i === 3) s.inviteDuet(p, people[4].id, song(n));
    else s.chooseSong(p, song(n), 'append');
    expected.add(n);
  }
  const played = [];
  for (let i = 0; i < 100 && expected.size; i++) {
    const selection = s.select();
    assert.ok(selection, `${expected.size} titres restent`);
    assert.ok(expected.delete(selection.song.songId), `titre répété : ${selection.song.songId}`);
    const guest = selection.kind === 'duo' ? s.people.get(selection.ids[1]) : null;
    const guestSung = guest?.sung;
    s.commit(selection); s.songEnded(selection.ids);
    if (guest) assert.equal(guest.sung, guestSung, 'le duo ne consomme pas le solo de l’invité');
    played.push(selection.song.songId);
    assert.equal(new Set(s.Q).size, s.Q.length, 'un seul ticket par personne');
  }
  assert.equal(expected.size, 0);
  assert.equal(played.length, 40);
  assert.ok(people.every(p => s.songsOf(p).length === 0));
});
