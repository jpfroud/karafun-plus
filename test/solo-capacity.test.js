'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');

test('le groupe individuel accueille plus de 40 solistes successifs sans rouvrir les tables ordinaires', () => {
  const s = new Scheduler();
  const song = n => ({ songId: n + 1, title: `Titre ${n + 1}`, artist: 'Test' });
  for (let i = 0; i < 65; i++) {
    const person = s.join({ tableId: 'Comptoir', name: `Solo ${i}`, headcount: 40 });
    s.chooseSong(person, song(i));
    assert.ok(s.select(), `soliste ${i} prêt`);
    s.leave(person);
  }
  assert.equal(s.tableSingers('Comptoir').length, 65, 'les fiches historiques restent auditables');
  assert.equal(s.tableSingers('Comptoir').filter(p => !p.withdrawnAt).length, 0);
  const p = s.join({ tableId: 'Comptoir', name: 'Dernier', headcount: 40 });
  assert.equal(p.withdrawnAt, null);

  const a = s.join({ tableId: '1', name: 'Anne', headcount: 1 });
  s.leave(a);
  assert.throws(() => s.join({ tableId: '1', name: 'Anne bis' }), /déjà 1 chanteur/,
    'une table ordinaire ne gagne pas un nouveau tour en remplaçant un nom');
});
