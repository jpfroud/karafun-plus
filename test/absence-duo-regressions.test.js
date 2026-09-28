'use strict';

// Rejoue « Absent à l’appel » sans ouvrir KaraFun ni toucher une vraie soirée.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));
const song = id => ({ songId: id, title: `Titre ${id}`, artist: 'Simulation' });

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const context = {
    require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console, Buffer, URL, setTimeout, setImmediate,
  };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, sync, settings, tracked: () => tracked,
      setBridge(value) { bridge = value; } };
  `, context, { filename: 'server.js' });
  const fixture = context.fixture;
  const bridge = { ready: true, connected: true, queue: [], status: { state: 'idle' },
    add() {}, play() {}, next() {}, remove() {} };
  fixture.setBridge(bridge);
  fixture.settings.auto = false;
  fixture.settings.autoPlay = false;
  return { ...fixture, bridge };
}

test('un duo absent après chargement retrouve son titre sans prendre le tour de l’invité', () => {
  const f = harness();
  const people = ['Alice', 'Bob', 'Chloé', 'Dam', 'Emma'].map((name, i) => {
    const tableId = String(i + 1);
    return f.sched.join({ tableId, name, headcount: 1 });
  });
  const [owner, guest] = people;
  const duet = f.sched.inviteDuet(owner, guest.id, song(201));
  f.sched.answerDuet(guest, true, duet.entryId);
  for (let i = 1; i < people.length; i++) f.sched.chooseSong(people[i], song(201 + i));

  const selected = f.sched.select();
  assert.equal(selected.kind, 'duo');
  assert.deepEqual(selected.ids, [owner.id, guest.id]);
  f.sched.commit(selected);
  assert.equal(owner.sung, 1, 'le chargement réserve provisoirement le tour du propriétaire');
  assert.equal(guest.duetGuestCount, 1, 'le chargement réserve provisoirement le passage invité');
  const loaded = { queueId: 'duo-charge', songId: duet.songId, title: duet.title,
    artist: duet.artist, singer: selected.label };
  f.tracked().push({ queueId: loaded.queueId, sel: selected, addedAt: Date.now(), startedAt: null });
  f.bridge.queue = [loaded];
  f.sync();

  // Alice choisit déjà un autre titre pendant que son duo attend dans KaraFun.
  f.sched.chooseSong(owner, song(206), 'append');
  const expected = new Set([duet.entryId, ...people.slice(1).map(p => p.song.entryId),
    f.sched.songsOf(owner)[0].entryId]);
  f.tracked()[0].absent = true; // Même marqueur posé par l’action /api/staff/kf « absent ».
  f.bridge.queue = [];
  f.sync();

  assert.equal(f.tracked().length, 0, 'le chargement retiré n’est plus suivi');
  assert.deepEqual(f.sched.songsOf(owner).map(item => item.songId), [201, 206],
    'le duo revient devant le nouveau titre sans l’écraser');
  assert.equal(owner.sung, 0, 'le duo non chanté ne consomme pas le tour d’Alice');
  assert.equal(guest.sung, 0, 'le duo non chanté ne consomme pas le solo de Bob');
  assert.equal(guest.duetGuestCount, 0, 'Bob ne garde pas un passage duo fictif');
  assert.equal(f.sched.duetCooldowns.has(guest.id), false, 'aucun répit fictif après absence');
  assert.equal(f.sched.appearanceSerial, 0, 'la réservation non chantée ne devient pas une apparition réelle');
  assert.equal(owner.lastAppearanceTurn, 0);
  assert.equal(guest.lastAppearanceTurn, 0);
  assert.equal(f.sched.roundPeople.has(owner.id), false);
  assert.equal(f.sched.roundPeople.has(guest.id), false);
  assert.equal(f.sched.tableServeCounts.get(owner.group) || 0, 0);
  assert.equal(f.sched.tableServeCounts.get(guest.group) || 0, 0);
  assert.deepEqual([...f.sched.roundGroups], [], 'aucune table non chantée ne reçoit un crédit');
  assert.equal(new Set(f.sched.Q).size, f.sched.Q.length, 'un seul ticket par personne');
  assert.equal(f.sched.Q.indexOf(owner.id), 3, 'Alice revient à la quatrième place');
  const announced = f.sched.readyView().map(turn => turn.entryId);
  assert.equal(announced.length, expected.size, 'aucun titre répété dans la prévision');
  assert.deepEqual(new Set(announced), expected,
    'chaque titre restant apparaît une fois dans la file');

  const played = new Set();
  while (played.size < expected.size) {
    const turn = f.sched.select();
    assert.ok(turn, 'la file continue après l’absence');
    assert.ok(expected.has(turn.song.entryId), 'aucun titre inattendu');
    assert.ok(!played.has(turn.song.entryId), 'aucun titre joué deux fois');
    played.add(turn.song.entryId);
    f.sched.commit(turn);
    f.sched.songEnded(turn.ids);
  }
  assert.deepEqual(played, expected, 'tous les titres passent exactement une fois');
  assert.equal(f.sched.readyView().length, 0);
});

test('retirer un titre chargé mais non chanté conserve la chanson suivante à sa place', () => {
  const f = harness();
  const alice = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const bob = f.sched.join({ tableId: '2', name: 'Bob', headcount: 1 });
  f.sched.chooseSong(alice, song(301));
  f.sched.chooseSong(alice, song(302), 'append');
  f.sched.chooseSong(bob, song(303));
  f.sched.confirm(alice);
  const selected = f.sched.select();
  assert.equal(selected.ids[0], alice.id);
  f.sched.commit(selected);
  const loaded = { queueId: 'a-retirer', songId: 301, title: 'Titre 301',
    singer: selected.label };
  f.tracked().push({ queueId: loaded.queueId, sel: selected, addedAt: Date.now(), startedAt: null });
  f.bridge.queue = [loaded];
  f.sync();
  f.bridge.queue = []; // le bar l'a retiré depuis KaraFun avant la scène
  f.sync();
  assert.equal(alice.sung, 0);
  assert.equal(alice.lastAppearanceTurn, 0);
  assert.equal(f.sched.appearanceSerial, 0);
  assert.equal(alice.confirmedAt, 0, 'une ancienne présence ne valide pas le titre de remplacement');
  assert.deepEqual(f.sched.Q.slice(0, 2), [alice.id, bob.id]);
  assert.equal(alice.song.songId, 302, 'le titre suivant reste prêt sans renvoyer le titre retiré');
  assert.equal(f.sched.readyView()[0].song.songId, 302,
    'le titre suivant conserve la place annoncée de la chanteuse');
});
