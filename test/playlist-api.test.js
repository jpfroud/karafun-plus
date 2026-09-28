'use strict';
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://127.0.0.1:3105';
const { staffRoute } = require('./staff-auth');

async function request(route, body) {
  const path = await staffRoute(BASE, route);
  const r = await fetch(BASE + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${route}: ${value.error || r.status}`);
  return value;
}
const post = (path, body) => request(path, body);
const song = n => ({ songId: n, title: `Titre ${n}`, artist: 'Recette' });
const personTokens = new Map();

(async () => {
  await post('/api/staff/settings', { auto: false, autoPlay: false });
  for (const [id, headcount] of [['a', 2], ['b', 1], ['c', 1]]) {
    await post('/api/staff/table', { id, headcount });
  }
  const before = (await request('/api/staff/state')).tables.find(t => t.id === 'a');
  await post('/api/staff/table/rename', { tableId: 'a', name: 'Coin fenêtre' });
  const after = (await request('/api/staff/state')).tables.find(t => t.id === 'a');
  assert.equal(after.name, 'Coin fenêtre');
  assert.equal(after.url, before.url, 'le QR reste valide après le renommage');
  await assert.rejects(post('/api/staff/table/rename', { tableId: 'a', name: '' }), /1 à 40/);
  const tokens = Object.fromEntries((await request('/api/staff/state')).tables.map(t => [t.id, new URL(t.url).pathname.split('/').pop()]));
  const body = (table, personId, fields = {}) => ({ table, access: tokens[table], personId,
    ...(personTokens.has(personId) ? { token: personTokens.get(personId) } : {}), ...fields });
  const tableState = table => request(`/api/state?table=${table}&access=${tokens[table]}`);
  const a = await post('/api/table/person', body('a', null, { name: 'Alice' }));
  const mate = await post('/api/table/person', body('a', null, { name: 'Amie' }));
  const b = await post('/api/table/person', body('b', null, { name: 'Bruno' }));
  const c = await post('/api/table/person', body('c', null, { name: 'Carla' }));
  for (const p of [a, mate, b, c]) personTokens.set(p.id, p.token);

  await post('/api/table/duet', body('a', a.id, { partnerId: mate.id, song: song(5101) }));
  let ap = (await tableState('a')).tablePeople.find(p => p.id === a.id);
  assert.equal(ap.songs[0].duet.state, 'accepted');
  assert.equal((await tableState('a')).tablePeople.find(p => p.id === mate.id).invites.length, 0);
  await post('/api/table/song', body('a', a.id, { song: song(5102) }));
  await post('/api/table/duet', body('a', a.id, { partnerId: b.id, song: song(5103) }));
  await post('/api/table/duet', body('a', a.id, { partnerId: b.id, song: song(5104) }));
  await post('/api/table/song', body('a', a.id, { song: song(5105) }));
  await post('/api/table/duet', body('c', c.id, { partnerId: b.id, song: song(5106) }));
  ap = (await tableState('a')).tablePeople.find(p => p.id === a.id);
  assert.deepEqual(ap.songs.map(s => s.songId), [5101, 5102, 5103, 5104, 5105]);
  assert.deepEqual(ap.songs.map(s => s.duet?.state || null), ['accepted', null, 'pending', 'pending', null]);
  let bp = (await tableState('b')).tablePeople.find(p => p.id === b.id);
  assert.equal(bp.invites.length, 3);
  const cross = ap.songs[3].entryId;
  await post('/api/table/duet/answer', body('b', b.id, { entryId: cross, accept: true }));
  bp = (await tableState('b')).tablePeople.find(p => p.id === b.id);
  assert.equal(bp.invites.length, 2);
  assert.ok((await tableState('a')).tablePeople.find(p => p.id === a.id).songs[3].duet?.state === 'accepted');

  const firstId = ap.songs[0].entryId;
  await post('/api/table/song/reorder', body('a', a.id, { entryId: cross, toIndex: 0 }));
  ap = (await tableState('a')).tablePeople.find(p => p.id === a.id);
  assert.equal(ap.songs[0].entryId, cross);
  assert.equal(ap.songs[1].entryId, firstId);
  assert.equal(ap.songs[1].duet.state, 'accepted', 'réordonnancement conserve le duo initial');
  await assert.rejects(post('/api/table/song/reorder', body('a', b.id, { entryId: cross, toIndex: 1 })), /inconnu à cette table/);
  await assert.rejects(post('/api/table/song/reorder', body('a', a.id, { entryId: 'autre', toIndex: 0 })), /introuvable/);
  await post('/api/staff/remove', { personId: a.id });
  ap = (await tableState('a')).tablePeople.find(p => p.id === a.id);
  assert.equal(ap.songs[0].entryId, firstId, 'la chanson suivante prend la place');
  assert.ok((await request('/api/staff/state')).queue.some(q => q.ids?.includes(a.id)), 'le ticket reste prêt dans la file');
  console.log('API table renommée, QR inchangé, 3 invitations, duos conservés, liste réordonnée, place gardée OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
