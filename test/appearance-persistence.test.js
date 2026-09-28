'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');

test('après crash, les deux voix d’un duo gardent leur dernière apparition physique', () => {
  const s = new Scheduler();
  const access = new TableAccess();
  s.table('1'); s.setHeadcount('1', 3); access.issue('1');
  const alice = s.join({ tableId: '1', name: 'Alice' });
  const bob = s.join({ tableId: '1', name: 'Bob' });
  const clara = s.join({ tableId: '1', name: 'Clara' });
  s.inviteDuet(alice, bob.id, { songId: 42, title: 'Duo', artist: 'Test' });
  s.chooseSong(clara, { songId: 43, title: 'Solo', artist: 'Test' });
  s.reservedNext = { personId: alice.id, reservedAt: Date.now() };
  const first = s.select();
  assert.deepEqual(first.ids, [alice.id, bob.id]);
  s.commit(first); s.songEnded(first.ids);
  assert.equal(s.appearanceSerial, 1);
  assert.equal(alice.lastAppearanceTurn, 1);
  assert.equal(bob.lastAppearanceTurn, 1, 'le tour de l’invité reste, son apparition non');

  const settings = { auto: true, autoPlay: false, baseUrl: 'https://test.invalid',
    pushDelaySec: 45, playDelaySec: 8 };
  const saved = snapshotNight({ scheduler: s, access, settings });
  const restored = new Scheduler();
  restoreNight(saved, { scheduler: restored, access: new TableAccess(), settings: { ...settings } });
  assert.equal(restored.appearanceSerial, 1);
  assert.equal(restored.people.get(alice.id).lastAppearanceTurn, 1);
  assert.equal(restored.people.get(bob.id).lastAppearanceTurn, 1);
  assert.equal(restored.people.get(clara.id).lastAppearanceTurn, 0);
  assert.equal(restored.select().ids[0], clara.id,
    'une reprise ne fait pas revenir le duo avant la première fois de Clara');
});

test('après crash, un titre chargé mais non chanté rend ses crédits sans effacer les vrais passages', () => {
  const s = new Scheduler();
  const access = new TableAccess();
  for (const tableId of ['1', '2', '3']) { s.table(tableId); s.setHeadcount(tableId, 1); access.issue(tableId); }
  const alice = s.join({ tableId: '1', name: 'Alice' });
  const bob = s.join({ tableId: '2', name: 'Bob' });
  const clara = s.join({ tableId: '3', name: 'Clara' });
  s.chooseSong(alice, { songId: 101, title: 'Alice', artist: 'Test' });
  s.chooseSong(bob, { songId: 102, title: 'Bob', artist: 'Test' });
  s.chooseSong(bob, { songId: 103, title: 'Bob encore', artist: 'Test' }, 'append');
  s.chooseSong(clara, { songId: 104, title: 'Clara', artist: 'Test' });
  s.reservedNext = { personId: alice.id, reservedAt: Date.now() };
  const performed = s.select();
  s.commit(performed); s.songEnded(performed.ids);
  s.reservedNext = { personId: bob.id, reservedAt: Date.now() };
  const loaded = s.select();
  s.commit(loaded); // confirmé par KaraFun, mais jamais commencé sur scène
  const settings = { auto: false, autoPlay: false, baseUrl: null, pushDelaySec: 45, playDelaySec: 8 };
  const saved = snapshotNight({ scheduler: s, access, settings,
    tracked: [{ queueId: 'charge-non-joue', sel: loaded, addedAt: Date.now(), startedAt: null }] });
  const resumed = new Scheduler();
  const recovered = restoreNight(saved,
    { scheduler: resumed, access: new TableAccess(), settings: { ...settings } });
  resumed.rollbackUnplayed(recovered.tracked[0].sel, { requeue: true });
  assert.equal(resumed.appearanceSerial, 1);
  assert.equal(resumed.people.get(alice.id).sung, 1);
  assert.equal(resumed.people.get(alice.id).lastAppearanceTurn, 1);
  assert.equal(resumed.people.get(bob.id).sung, 0);
  assert.equal(resumed.people.get(bob.id).lastAppearanceTurn, 0);
  assert.deepEqual(resumed.roundPeople, new Set([alice.id]));
  assert.deepEqual(resumed.roundGroups, new Set(['1']));
  assert.equal(resumed.tableServeCounts.get('1'), 1);
  assert.equal(resumed.tableServeCounts.get('2') || 0, 0);
  assert.equal(resumed.people.get(bob.id).song.songId, 103,
    'le prochain titre de Bob reste disponible sans ressusciter celui retiré');
  assert.notEqual(resumed.select().ids[0], alice.id,
    'Bob ou Clara qui n’a pas chanté passe avant le retour d’Alice');
});
