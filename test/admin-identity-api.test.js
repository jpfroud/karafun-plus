'use strict';
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://127.0.0.1:3106';
const { staffRoute } = require('./staff-auth');
async function request(route, body) {
  const path = await staffRoute(BASE, route);
  const response = await fetch(BASE + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route}: ${value.error || response.status}`);
  return value;
}
const post = (path, body) => request(path, body);
const song = n => ({ songId: n, title: `Titre ${n}`, artist: 'Recette' });
const personTokens = new Map();

(async () => {
  await post('/api/staff/settings', { auto: false, autoPlay: false });
  await post('/api/staff/table', { id: '8', headcount: 8 });
  await post('/api/staff/table', { id: '4', headcount: 4 });
  const tables = (await request('/api/staff/state')).tables;
  const access = id => new URL(tables.find(t => t.id === id).url).pathname.split('/').pop();
  const body = (table, personId, fields = {}) => ({ table, access: access(table), personId,
    ...(personTokens.has(personId) ? { token: personTokens.get(personId) } : {}), ...fields });
  const singers = [];
  for (let i = 0; i < 5; i++) singers.push(await post('/api/table/person', body('8', null, { name: `T8-${i}` })));
  const other = await post('/api/table/person', body('4', null, { name: 'Autre' }));
  for (const p of [...singers, other]) personTokens.set(p.id, p.token);
  for (let i = 0; i < 5; i++) await post('/api/table/song', body('8', singers[i].id, { song: song(7000 + i) }));
  await post('/api/table/song', body('4', other.id, { song: song(7010) }));

  await post('/api/staff/settings', { requirePresence: true });
  const awaitingPresence = await request('/api/staff/state');
  assert.equal(awaitingPresence.kf.queue.length, 0,
    'aucun titre sans présence ne doit partir dans KaraFun');
  assert.equal(awaitingPresence.queue[0]?.source, 'helper',
    'le prochain titre reste visible pendant la demande de présence');
  assert.equal(awaitingPresence.queue[0]?.waitingPresence, true);
  assert.equal(awaitingPresence.presencePending.length, 1,
    'un seul chanteur est sollicité à la fois');
  assert.equal(awaitingPresence.queue.length, 6, 'les autres titres restent prévus dans la file');
  await post('/api/staff/settings', { requirePresence: false });

  await post('/api/staff/person/identify', { personId: singers[0].id, note: '  t-shirt   rouge ' });
  const privateState = await request('/api/staff/state');
  const marked = privateState.people.find(p => p.id === singers[0].id);
  assert.equal(marked.privateNote, 't-shirt rouge');
  assert.ok(!('verified' in marked), 'un repère n’a rien à vérifier');
  const publicState = await request(`/api/state?table=8&access=${access('8')}`);
  assert.ok(!JSON.stringify(publicState).includes('t-shirt rouge'), 'description absente de toutes les données clients');
  assert.ok(!JSON.stringify(publicState).includes('privateNote'), 'clé privée absente des données clients');
  await assert.rejects(post('/api/staff/person/identify', { personId: singers[0].id, note: 'x'.repeat(141) }), /140/);
  const denied = await fetch(BASE + '/api/staff/person/identify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403, 'un client ne peut pas modifier les notes');

  await post('/api/staff/move', { personId: singers[4].id, toIndex: 0 });
  const priority = await request('/api/staff/state');
  assert.equal(priority.queue[0].ids[0], singers[4].id, 'départ imminent : passage avancé dès que possible');

  for (const p of singers.slice(2)) await post('/api/staff/person/leave', { personId: p.id });
  await post('/api/staff/table', { id: '8', headcount: 2 });
  const after = await request('/api/staff/state');
  const table = after.tables.find(t => t.id === '8');
  assert.equal(table.activeCount, 2);
  assert.equal(table.count, 5, 'les cinq identités restent inscrites');
  assert.equal(table.headcount, 2);
  assert.ok(singers.slice(2).every(p => after.people.find(row => row.id === p.id)?.active === false));
  assert.ok(singers.slice(2).every(p => !after.queue.some(q => q.ids?.includes(p.id))));
  await assert.rejects(post('/api/table/person', body('8', null, { name: 'Nouveau faux nom' })), /déjà 5 chanteurs/);
  const one = await request(`/api/state?table=8&access=${access('8')}`);
  assert.ok(one.tablePeople.some(p => p.id === singers[0].id), 'les survivants conservent leur fiche');
  await assert.rejects(post('/api/table/song', body('8', singers[2].id, { song: song(7099) })),
    /marquée partie/);
  await assert.rejects(post('/api/staff/person/reactivate', { personId: singers[2].id }), /pleine/);
  await post('/api/staff/table', { id: '8', headcount: 3 });
  await post('/api/staff/person/reactivate', { personId: singers[2].id });
  assert.equal((await request('/api/staff/state')).people.find(p => p.id === singers[2].id).active, true);
  await post('/api/table/song', body('8', singers[2].id, { song: song(7099) }));
  console.log('API repères privés, priorité, départ partiel et plafond anti-gruge OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
