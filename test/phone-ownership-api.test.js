'use strict';
const assert = require('node:assert/strict');
const { staffRoute } = require('./staff-auth');
const BASE = process.env.BASE || 'http://127.0.0.1:3107';

async function request(path, body, base = BASE) {
  const route = base === BASE ? await staffRoute(BASE, path) : path;
  const response = await fetch(base + route, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${path}: ${value.error || response.status}`);
    error.status = response.status;
    error.code = value.code;
    throw error;
  }
  return value;
}

(async () => {
  await request('/api/staff/settings', { auto: false, autoPlay: false });
  await request('/api/staff/table', { id: 'quatre', headcount: 4 });
  await request('/api/staff/table', { id: 'autre', headcount: 1 });
  const staff = await request('/api/staff/state');
  const secret = id => new URL(staff.tables.find(t => t.id === id).url).pathname.split('/').pop();
  const body = (id, fields = {}) => ({ table: id, access: secret(id), ...fields });
  const a = await request('/api/table/person', body('quatre', { name: 'Alice' }));
  const b = await request('/api/table/person', body('quatre', { name: 'Bob' }));
  const c = await request('/api/table/person', body('quatre', { name: 'Carla' }));
  const d = await request('/api/table/person', body('quatre', { name: 'Dan' }));
  const other = await request('/api/table/person', body('autre', { name: 'Marine' }));
  const singer = (p, extra = {}) => body('quatre', { personId: p.id, token: p.token, ...extra });

  const state = (...tokens) => request('/api/state?' + new URLSearchParams([
    ['table', 'quatre'], ['access', secret('quatre')], ...tokens.map(token => ['token', token]),
  ]));
  assert.deepEqual((await state(a.token, b.token)).managedIds.sort(), [a.id, b.id].sort());
  assert.deepEqual((await state(c.token, d.token)).managedIds.sort(), [c.id, d.id].sort());
  assert.equal((await state()).managedIds.length, 0);
  assert.ok((await state()).tablePeople.every(p => p.name !== 'Marine'));
  assert.ok((await state()).people.every(p => p.tableId === 'quatre'));
  assert.equal(Object.hasOwn(await state(), 'log'), false, 'le journal de toutes les tables reste privé au bar');

  await request('/api/table/song', singer(a, { song: { songId: 201, title: 'Alice' } }));
  await request('/api/table/song', singer(b, { song: { songId: 202, title: 'Bob' } }));
  await request('/api/table/song', singer(c, { song: { songId: 203, title: 'Carla' } }));
  await assert.rejects(request('/api/table/song', body('quatre', {
    personId: c.id, token: a.token, song: { songId: 204, title: 'Volé' },
  })), error => error.status === 403 && error.code === 'PERSON_ACCESS');
  await assert.rejects(request('/api/table/person/rename', body('quatre', {
    personId: d.id, token: b.token, name: 'Usurpé',
  })), error => error.status === 403 && error.code === 'PERSON_ACCESS');
  await assert.rejects(request('/api/table/confirm', body('quatre', { personId: d.id })),
    error => error.status === 403 && error.code === 'PERSON_ACCESS');
  await assert.rejects(request('/api/table/song', body('quatre', {
    personId: other.id, token: other.token, song: { songId: 205, title: 'Intrus' },
  })), /inconnu à cette table/);

  const share = await request('/api/table/person/share', singer(a));
  assert.match(share.code, /^[0-9]{4}$/);
  await assert.rejects(request('/api/table/person/claim', body('quatre', {
    personId: a.id, code: '0000' === share.code ? '1111' : '0000',
  })), /incorrect/);
  const transferred = await request('/api/table/person/claim', body('quatre', {
    personId: a.id, code: share.code,
  }));
  assert.notEqual(transferred.token, a.token);
  assert.deepEqual((await state(a.token, b.token)).managedIds, [b.id]);
  assert.deepEqual(new Set((await state(transferred.token, c.token, d.token)).managedIds),
    new Set([a.id, c.id, d.id]));
  await assert.rejects(request('/api/table/song/remove', singer(a, { entryId: 'x' })),
    error => error.status === 403 && error.code === 'PERSON_ACCESS');
  await assert.rejects(request('/api/table/person/claim', body('quatre', {
    personId: a.id, code: share.code,
  })), /expiré/);

  const battleSong = (await request('/api/search?q=Queen')).find(item => item.title === 'Bohemian Rhapsody');
  assert.ok(battleSong);
  const proposed = await request('/api/table/battle/propose', singer(b, { songs: [battleSong] }));
  assert.equal(proposed.battle.eligible, 5);
  assert.equal(proposed.battle.threshold, 3);
  await assert.rejects(request('/api/table/battle/vote', body('quatre', {
    personId: c.id, token: b.token, choice: battleSong.songId,
  })), error => error.status === 403 && error.code === 'PERSON_ACCESS');
  await request('/api/table/battle/vote', singer(c, { choice: battleSong.songId }));
  await request('/api/table/battle/vote', body('quatre', {
    personId: a.id, token: transferred.token, choice: battleSong.songId,
  }));
  await request('/api/table/battle/vote', singer(d, { choice: 'none' }));
  await request('/api/table/battle/vote', body('autre', {
    personId: other.id, token: other.token, choice: 'none',
  }));
  assert.equal((await request('/api/staff/state')).battle.phase, 'requested');
  assert.ok(!(await request('/api/staff/state')).queue.some(q => q.kind === 'battle'));
  await request('/api/staff/battle/resolve', { outcome: 'done' });
  assert.equal((await request('/api/staff/state')).battle.phase, 'cooldown');
  await assert.rejects(request('/api/table/battle/propose', singer(d, { songs: [battleSong] })), /délai/);

  const staffQr = await fetch(BASE + await staffRoute(BASE, '/qr/staff.svg'));
  assert.equal(staffQr.status, 200);
  assert.match(await staffQr.text(), /<svg/);
  assert.equal((await fetch(BASE + '/qr/staff.svg')).status, 403);
  const publicBase = new URL(BASE);
  publicBase.port = String(Number(publicBase.port) + 1);
  assert.equal((await fetch(publicBase.origin + '/qr/staff.svg')).status, 403);
  console.log('Téléphones : 2+2 chanteurs, droits exclusifs, transfert, vote Battle et QR bar OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
