'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');

const layout = [
  { seats: 8, singers: 5 }, { seats: 4, singers: 4 }, { seats: 2, singers: 1 },
  { seats: 4, singers: 2 }, { seats: 3, singers: 3 }, { seats: 2, singers: 1 },
];
const song = n => ({ songId: n, title: `Chanson ${n}`, artist: 'Simulation bar' });
const play = s => { const chosen = s.select(); assert.ok(chosen); s.commit(chosen); s.songEnded(chosen.ids); return chosen; };

test('soirée type du bar : 6 tables, 16 chanteurs, arrivées et départs', () => {
  const s = new Scheduler({ tableRotation: true, cap: 5 });
  const groups = layout.map((x, i) => {
    const tableId = String(i + 1);
    s.setHeadcount(tableId, x.seats);
    return { tableId, people: [] };
  });
  let n = 1000;
  const arrive = (group, count) => {
    while (group.people.length < count) {
      const p = s.join({ tableId: group.tableId, name: `T${group.tableId}-P${group.people.length + 1}` });
      s.chooseSong(p, song(n++), 'append');
      group.people.push(p);
    }
  };
  arrive(groups[0], 5); arrive(groups[1], 4); arrive(groups[2], 1);
  assert.equal(s.people.size, 10);
  const early = [play(s), play(s), play(s)];
  assert.equal(early.length, 3);
  const beforeArrival = new Map([...s.people.values()].map(p => [p.id, p.over]));
  arrive(groups[3], 2); arrive(groups[4], 3); arrive(groups[5], 1);
  assert.equal(s.people.size, 16);
  assert.deepEqual(groups.map(g => g.people.length), [5, 4, 1, 2, 3, 1]);
  assert.deepEqual(groups.map((g, i) => s.table(g.tableId).headcount), layout.map(x => x.seats));
  assert.ok([...s.people.values()].every(p => p.over <= 5), 'les arrivées ne dépassent pas le plafond de reculs');
  assert.ok([...beforeArrival].some(([id, over]) => (s.people.get(id)?.over || 0) >= over));

  // Un départ imminent est accepté par le bar. L'action ne fait passer devant
  // que les titres encore prévus, jamais ceux déjà chargés dans KaraFun.
  const urgent = groups[4].people[2];
  s.staffMove(urgent.id, 0);
  assert.equal(s.select().ids[0], urgent.id);
  const priorityTurn = play(s);
  assert.equal(priorityTurn.ids[0], urgent.id);
  assert.ok(s.roundPeople.has(urgent.id));

  // Trois personnes quittent la table de huit. Leurs titres disparaissent,
  // l'identité et leurs anciens tours restent connus pour éviter un faux nouveau.
  const departed = groups[0].people.slice(2);
  departed.forEach(p => s.leave(p));
  s.setHeadcount('1', 2);
  assert.equal(groups[0].people.filter(p => !p.withdrawnAt).length, 2);
  assert.equal(s.tableSingers('1').length, 5);
  assert.ok(departed.every(p => !s.Q.includes(p.id) && !p.song));
  assert.throws(() => s.join({ tableId: '1', name: departed[0].name }), e => e.code === 'NAME_TAKEN');
  assert.throws(() => s.join({ tableId: '1', name: 'Nouveau faux nom' }), e => e.code === 'TABLE_FULL');

  // Les gens restants reprennent un titre, sans perdre leur identité.
  const survivor = groups[0].people[0];
  const joinedAt = survivor.joinedAt;
  s.chooseSong(survivor, song(n++), 'append');
  assert.equal(survivor.joinedAt, joinedAt);
  const beforeTableLeft = new Set(s.Q);
  s.tableLeft('6');
  assert.ok(!s.people.has(groups[5].people[0].id));
  assert.ok([...beforeTableLeft].filter(id => id !== groups[5].people[0].id).every(id => s.Q.includes(id)));
  assert.ok(s.Q.every(id => s.people.has(id)));
});

test('50 variantes du même plan de salle : aucun double passage ni ticket perdu', () => {
  for (let seed = 1; seed <= 50; seed++) {
    let randomState = seed >>> 0;
    const rand = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 2 ** 32; };
    const s = new Scheduler({ tableRotation: seed % 2 === 0, weightedTables: seed % 4 === 0, cap: 5 });
    const groups = layout.map((x, i) => {
      const tableId = String(i + 1); s.setHeadcount(tableId, x.seats);
      return { tableId, people: [] };
    });
    let songId = seed * 1000;
    const arrivals = groups.slice().sort(() => rand() - .5);
    for (const g of arrivals) {
      const count = layout[Number(g.tableId) - 1].singers;
      for (let i = 0; i < count; i++) {
        const p = s.join({ tableId: g.tableId, name: `P${g.tableId}-${i}` });
        g.people.push(p);
        for (let k = 0; k < 3; k++) s.chooseSong(p, song(songId++), 'append');
      }
      if (rand() > .55) play(s);
    }
    assert.equal(s.people.size, 16);
    const urgent = [...s.people.values()].filter(p => p.song)[Math.floor(rand() * 16)];
    s.staffMove(urgent.id, 0);
    assert.equal(s.select().ids[0], urgent.id, `graine ${seed} : priorité honorée`);
    const gone = groups[0].people.slice(2);
    gone.forEach(p => s.leave(p));
    s.setHeadcount('1', 2);
    assert.equal(groups[0].people.filter(p => !p.withdrawnAt).length, 2);
    const remainingIds = new Set([...s.people.values()].flatMap(p => s.songsOf(p).map(t => t.entryId)));
    const observed = new Set();
    let turns = 0;
    while (remainingIds.size) {
      const sel = play(s);
      assert.ok(sel.song.entryId, `graine ${seed} : titre sans identifiant`);
      assert.ok(remainingIds.delete(sel.song.entryId), `graine ${seed} : titre inconnu ou joué deux fois`);
      assert.ok(!observed.has(sel.song.entryId), `graine ${seed} : répétition`);
      observed.add(sel.song.entryId);
      assert.equal(new Set(s.Q).size, s.Q.length, `graine ${seed} : ticket dupliqué`);
      assert.ok([...s.people.values()].every(p => p.over <= 5), `graine ${seed} : recul excessif`);
      assert.ok(++turns < 100, `graine ${seed} : file bloquée`);
    }
    assert.ok([...s.people.values()].every(p => s.songsOf(p).length === 0), `graine ${seed} : titres perdus`);
  }
});
