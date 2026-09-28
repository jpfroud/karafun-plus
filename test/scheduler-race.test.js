'use strict';
// Une personne peut partir après queueAdd, avant sa confirmation par KaraFun.
const assert = require('assert');
const { Scheduler } = require('../scheduler');

const song = (songId) => ({ songId, title: `Titre ${songId}`, artist: 'Artiste' });
let count = 0;
function test(name, fn) { fn(); count++; console.log('ok -', name); }

test('solo retiré pendant un ajout : identité gardée, aucune place ressuscitée', () => {
  const s = new Scheduler();
  const alice = s.join({ tableId: '1', name: 'Alice', headcount: 1 });
  s.chooseSong(alice, song(1));
  const sel = s.select();
  s.leave(alice);

  assert.doesNotThrow(() => s.commit(sel));
  assert.strictEqual(s.people.size, 1);
  assert.strictEqual(s.person(alice.token), alice);
  assert.deepStrictEqual(s.Q, []);
  assert.strictEqual(alice.sung, 0);
  assert.deepStrictEqual(s.lastGroup, sel.groups, 'la chanson confirmée reste le dernier passage envoyé');
});

for (const departedRole of ['owner', 'partner']) {
  test(`duo avec ${departedRole === 'owner' ? 'initiateur parti' : 'partenaire parti'} pendant un ajout`, () => {
    const s = new Scheduler();
    const alice = s.join({ tableId: '1', name: 'Alice', headcount: 2 });
    const bob = s.join({ tableId: '1', name: 'Bob' });
    s.chooseSong(alice, song(1));
    s.chooseSong(bob, song(2));
    const duet = s.inviteDuet(alice, bob.id, song(3));
    s.reorderSongs(alice, duet.entryId, 0);
    assert.strictEqual(alice.duet.state, 'accepted', 'même table : pas de confirmation');
    s.manualOrder = [alice.id]; // le duo est la commande déjà partie vers KaraFun
    const sel = s.select();
    assert.deepStrictEqual(sel.ids, [alice.id, bob.id]);
    const departed = departedRole === 'owner' ? alice : bob;
    const remaining = departedRole === 'owner' ? bob : alice;
    s.leave(departed);

    assert.doesNotThrow(() => s.commit(sel));
    assert.strictEqual(s.person(departed.token), departed);
    assert.strictEqual(s.people.size, 2);
    assert.deepStrictEqual(s.Q, [remaining.id]);
    assert.strictEqual(departed.sung, 0);
    assert.strictEqual(remaining.sung, departedRole === 'partner' ? 1 : 0,
      'seul le ticket de l’initiateur est consommé');
    assert.strictEqual(remaining.duet, null);
    assert.strictEqual(remaining.duetOf, null);
    if (remaining === bob) assert.strictEqual(bob.song.songId, 2, 'le partenaire garde sa chanson personnelle');
    else assert.strictEqual(alice.song.songId, 1, 'la chanson personnelle de l’initiateur reste après le duo');
    assert.deepStrictEqual(s.lastGroup, sel.groups);
  });
}

console.log(`\n${count} tests de départ pendant ajout OK`);
