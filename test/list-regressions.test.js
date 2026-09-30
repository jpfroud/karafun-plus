'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const song = n => ({ songId: n, title: `Titre ${n}`, artist: 'Artiste' });

test('une liste joue un titre par tour sans perdre les suivants', () => {
  const s = new Scheduler();
  const a = s.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const b = s.join({ tableId: '2', name: 'Bob', headcount: 1 });
  s.chooseSong(a, song(1), 'append');
  s.chooseSong(a, song(2), 'append');
  s.chooseSong(a, song(3), 'append');
  s.chooseSong(b, song(4));
  assert.deepEqual(s.songsOf(a).map(x => x.songId), [1, 2, 3]);
  const first = s.select();
  assert.equal(first.song.songId, 1);
  s.commit(first);
  s.songEnded(first.ids);
  assert.deepEqual(s.songsOf(a).map(x => x.songId), [2, 3]);
  const second = s.select();
  assert.equal(second.song.songId, 4, 'Bob doit passer entre les tours d’Alice');
  s.commit(second);
  s.songEnded(second.ids);
  const third = s.select();
  assert.equal(third.song.songId, 2);
  s.commit(third);
  s.songEnded(third.ids);
  assert.deepEqual(s.songsOf(a).map(x => x.songId), [3]);
});

test('le Comptoir garde des groupes individuels, sans nombre de places', () => {
  const s = new Scheduler();
  const a = s.join({ tableId: 'Comptoir', name: 'Alice', headcount: 2 });
  const b = s.join({ tableId: 'Comptoir', name: 'Bob' });
  assert.notEqual(a.group, b.group);
  const more = Array.from({ length: 60 }, (_, i) => s.join({ tableId: 'Comptoir', name: `Solo ${i}` }));
  assert.equal(new Set([a, b, ...more].map(p => p.group)).size, 62, 'au-delà de l’effectif et de 40 personnes');
  const t = s.join({ tableId: '1', name: 'Anne', headcount: 1 });
  assert.ok(t);
  assert.throws(() => s.join({ tableId: '1', name: 'Faux nom' }), e => e.code === 'TABLE_FULL',
    'une table ordinaire garde son effectif');
});

test('les solistes du Comptoir et une table ordinaire obtiennent chacun un premier passage', () => {
  const s = new Scheduler({ tableRotation: true });
  const solos = [
    s.join({ tableId: 'Comptoir', name: 'Alice', headcount: 2 }),
    s.join({ tableId: 'Comptoir', name: 'Bob' }),
  ];
  const friends = [
    s.join({ tableId: '1', name: 'Carla', headcount: 2 }),
    s.join({ tableId: '1', name: 'David' }),
  ];
  const everyone = [...solos, ...friends];
  everyone.forEach((p, i) => {
    s.chooseSong(p, song(20 + i), 'append');
    s.chooseSong(p, song(30 + i), 'append');
  });
  const first = [];
  for (let i = 0; i < everyone.length; i++) {
    const selected = s.select();
    first.push(selected.ids[0]);
    s.commit(selected);
    s.songEnded(selected.ids);
  }
  assert.deepEqual(new Set(first), new Set(everyone.map(p => p.id)),
    'aucun soliste ni ami ne rechante avant le premier passage des autres');
  assert.ok(everyone.every(p => p.sung === 1));
});

function send(s) {
  const selection = s.select();
  assert.ok(selection, 'une chanson prête doit être sélectionnée');
  s.commit(selection);
  s.songEnded(selection.ids);
  return selection.names[0];
}

test('JP, table 2, table 3, Marine : les trois tables passent avant le second chanteur de la table 1', () => {
  const s = new Scheduler();
  const jp = s.join({ tableId: '1', name: 'JP', headcount: 2 });
  s.chooseSong(jp, song(101));
  const played = [send(s)]; // JP est déjà parti dans KaraFun avant les autres choix.
  const marine = s.join({ tableId: '1', name: 'Marine' });
  const t2 = s.join({ tableId: '2', name: 'Table 2', headcount: 1 });
  const t3 = s.join({ tableId: '3', name: 'Table 3', headcount: 1 });
  s.chooseSong(marine, song(102));
  s.chooseSong(t2, song(103));
  s.chooseSong(t3, song(104));

  assert.deepEqual(s.readyView().map(x => x.name), ['Table 2', 'Table 3', 'Marine']);
  for (let i = 0; i < 3; i++) played.push(send(s));
  assert.deepEqual(played, ['JP', 'Table 2', 'Table 3', 'Marine']);

  // Marine est envoyée dès son nouveau choix, avant que les trois autres
  // personnes ne choisissent à nouveau : JP reste, mais après les autres tables.
  s.chooseSong(marine, song(105));
  const second = [send(s)];
  s.chooseSong(jp, song(106));
  s.chooseSong(t2, song(107));
  s.chooseSong(t3, song(108));
  assert.deepEqual(s.readyView().map(x => x.name), ['Table 2', 'Table 3', 'JP']);
  for (let i = 0; i < 3; i++) second.push(send(s));
  assert.deepEqual(second, ['Marine', 'Table 2', 'Table 3', 'JP']);
});

test('la prévision et la file provisoire suivent la sélection réelle', () => {
  const s = new Scheduler();
  const jp = s.join({ tableId: '1', name: 'JP', headcount: 2 });
  const marine = s.join({ tableId: '1', name: 'Marine' });
  const t2 = s.join({ tableId: '2', name: 'Table 2', headcount: 1 });
  const t3 = s.join({ tableId: '3', name: 'Table 3', headcount: 1 });
  [jp, t2, marine, t3].forEach((p, i) => s.chooseSong(p, song(200 + i)));
  s.Q = [jp.id, t2.id, marine.id, t3.id];
  const names = slots => slots.map(x => s.people.get(x.ids[0]).name);
  assert.deepEqual(names(s.predict()), ['JP', 'Table 2', 'Table 3', 'Marine']);
  assert.deepEqual(s.readyView().map(x => x.name), ['JP', 'Table 2', 'Table 3', 'Marine']);
  const pending = s.select();
  assert.equal(pending.names[0], 'JP');
  assert.deepEqual(s.readyView(pending.ids, pending).map(x => x.name), ['Table 2', 'Table 3', 'Marine']);
});

test('quarante chansons continues gardent dix passages par personne', () => {
  const s = new Scheduler();
  const people = [
    s.join({ tableId: '1', name: 'JP', headcount: 2 }),
    s.join({ tableId: '1', name: 'Marine' }),
    s.join({ tableId: '2', name: 'Table 2', headcount: 1 }),
    s.join({ tableId: '3', name: 'Table 3', headcount: 1 }),
  ];
  people.forEach((p, i) => s.chooseSong(p, song(300 + i)));
  for (let i = 0; i < 40; i++) {
    const selection = s.select();
    const p = s.people.get(selection.ids[0]);
    s.commit(selection);
    s.songEnded(selection.ids);
    s.chooseSong(p, song(400 + i));
  }
  assert.deepEqual(people.map(p => p.sung), [10, 10, 10, 10]);
});
