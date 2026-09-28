'use strict';
const assert = require('node:assert/strict');
const { Scheduler } = require('../scheduler');
const song = n => ({ songId: n, title: `Titre ${n}`, artist: 'Artiste' });

{
  const s = new Scheduler();
  s.setHeadcount('1', 1);
  const p = s.join({ tableId: '1', name: 'Marine' });
  s.chooseSong(p, song(101));
  const before = p.joinedAt;
  s.staffRemove(p.id);
  assert.ok(s.people.has(p.id), 'le bar ne doit pas supprimer la personne');
  assert.equal(p.song, null);
  assert.equal(p.joinedAt, before);
  assert.throws(() => s.join({ tableId: '1', name: 'Marine' }), error => error.code === 'NAME_TAKEN');
  s.rename(p, 'Marie');
  assert.equal(p.name, 'Marie');
  s.leave(p);
  assert.ok(s.people.has(p.id), 'quitter garde l’identité anti-gruge');
  assert.throws(() => s.join({ tableId: '1', name: 'Marine' }), error => error.code === 'TABLE_FULL');
}

{
  const s = new Scheduler({ tableRotation: true });
  s.setHeadcount('1', 1); s.setHeadcount('2', 1);
  const a = s.join({ tableId: '1', name: 'Alice' });
  const b = s.join({ tableId: '2', name: 'Bob' });
  s.inviteDuet(a, b.id, song(201));
  assert.equal(s.select(), null, 'invitation non acceptée');
  s.answerDuet(b, true);
  const picked = s.select();
  assert.deepEqual(new Set(picked.ids), new Set([a.id, b.id]));
  assert.deepEqual(new Set(picked.groups), new Set(['1', '2']));
  s.commit(picked);
  assert.equal(a.sung, 1); assert.equal(b.sung, 0, 'l’invité garde son tour');
  assert.ok(s.roundGroups.has('1') && s.roundGroups.has('2'));
}

{
  const s = new Scheduler({ requirePresence: true });
  s.setHeadcount('1', 1);
  const p = s.join({ tableId: '1', name: 'Présent' });
  s.chooseSong(p, song(301));
  assert.equal(s.select(), null, 'pas de confirmation, pas d’envoi');
  s.confirm(p);
  const selected = s.select();
  assert.ok(selected.presenceConfirmed);
  s.commit(selected);
  assert.equal(p.confirmedAt, 0, 'le prochain tour doit demander une nouvelle confirmation');
  assert.ok(selected.presenceConfirmed, 'le passage chargé reste confirmé pour la lecture');
}

{
  const s = new Scheduler();
  s.setHeadcount('1', 2);
  const a = s.join({ tableId: '1', name: 'A' });
  const b = s.join({ tableId: '1', name: 'B' });
  s.chooseSong(a, song(501));
  const selected = s.select(); assert.equal(selected.ids[0], a.id); s.commit(selected);
  s.chooseSong(b, song(502));
  s.staffCountPartner(a.id, b.id);
  assert.equal(b.sung, 0);
  assert.ok(s.roundPeople.has(b.id), 'un duo constaté par le bar compte comme passage physique');
  assert.equal(b.song.songId, 502, 'la chanson solo du partenaire reste pour plus tard');
}

console.log('Identité, duos et présence OK');
