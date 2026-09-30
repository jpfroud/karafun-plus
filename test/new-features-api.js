'use strict';
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://127.0.0.1:3104';
const { staffRoute } = require('./staff-auth');
async function request(route, body) {
  const path = await staffRoute(BASE, route);
  const r = await fetch(BASE + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const error = new Error(`${route}: ${data.error || r.status}`); error.status = r.status; throw error; }
  return data;
}
const post = (route, body) => request(route, body);
const state = () => request('/api/staff/state');
const song = (songId, title) => ({ songId, title, artist: 'Recette' });
const personTokens = new Map();

(async () => {
  const denied = await fetch(BASE + '/api/staff/state');
  assert.equal(denied.status, 403);
  await post('/api/staff/settings', { auto: false, autoPlay: false });
  for (const [id, headcount] of [['alpha', 2], ['beta', 1]]) await post('/api/staff/table', { id, headcount });
  const tables = (await state()).tables;
  const access = id => new URL(tables.find(t => t.id === id).url).pathname.split('/').pop();
  const body = (table, personId, extra = {}) => ({ table, access: access(table), personId,
    ...(personTokens.has(personId) ? { token: personTokens.get(personId) } : {}), ...extra });
  const a = await post('/api/table/person', body('alpha', null, { name: 'A' }));
  const mate = await post('/api/table/person', body('alpha', null, { name: 'M' }));
  const b = await post('/api/table/person', body('beta', null, { name: 'B' }));
  for (const p of [a, mate, b]) personTokens.set(p.id, p.token);
  const alphaState = () => request(`/api/state?table=alpha&access=${access('alpha')}`);
  assert.equal((await alphaState()).tablePeople.length, 2);
  await post('/api/table/person/rename', body('alpha', a.id, { name: 'Alice' }));
  assert.equal((await alphaState()).tablePeople.find(p => p.id === a.id).name, 'Alice');
  assert.equal((await alphaState()).table.count, 2);
  await post('/api/table/song', body('alpha', mate.id, { song: song(1001, 'Solo M') }));
  await post('/api/staff/remove', { personId: mate.id });
  assert.ok((await alphaState()).tablePeople.some(p => p.id === mate.id), 'retirer la chanson garde la personne');

  await post('/api/staff/settings', { tableRotation: true, weightedTables: false,
    playDelaySec: 3, pushDelaySec: 9, requirePresence: true });
  let s = await state();
  assert.equal(s.settings.tableRotation, true);
  assert.equal(s.settings.weightedTables, false);
  assert.equal(s.settings.playDelaySec, 3);
  await post('/api/staff/settings', { weightedTables: true });
  s = await state(); assert.equal(s.settings.weightedTables, true);
  await assert.rejects(post('/api/staff/settings', { tableRotation: false }), /Active d’abord/);
  await post('/api/staff/settings', { tableRotation: false, weightedTables: false, requirePresence: false });

  await post('/api/table/duet', body('alpha', a.id, { partnerId: b.id, song: song(1002, 'Duo AB') }));
  assert.equal((await alphaState()).tablePeople.find(p => p.id === a.id).duet.state, 'pending');
  const betaState = () => request(`/api/state?table=beta&access=${access('beta')}`);
  assert.equal((await betaState()).tablePeople.find(p => p.id === b.id).invite.fromName, 'Alice');
  await post('/api/table/duet/answer', body('beta', b.id, { accept: true }));
  s = await state();
  assert.ok(s.queue.some(q => q.ids?.includes(a.id) && q.ids?.includes(b.id)));
  // La page prévient qu'une personne déjà invitée peut faire attendre un duo.
  const partners = await request(`/api/duo/partners?table=alpha&access=${access('alpha')}`);
  assert.equal(partners.find(p => p.id === b.id).guestDuos, 1, 'B est invitée dans un duo');
  assert.equal(partners.find(p => p.id === mate.id).guestDuos, 0);
  await post('/api/table/duet/cancel', body('alpha', a.id));

  const battleSong = (await request('/api/search?q=Queen')).find(item => item.title === 'Bohemian Rhapsody');
  assert.ok(battleSong, 'titre réel fourni par le catalogue de la simulation');
  // Trois inscrits : sous le minimum par défaut (5), la salle ne peut pas
  // proposer de Battle et les téléphones masquent le bouton.
  const fewPeople = await alphaState();
  assert.deepEqual([fewPeople.battle.phase, fewPeople.battle.minVoters, fewPeople.battle.registered], ['idle', 5, 3]);
  await assert.rejects(post('/api/table/battle/propose', body('alpha', a.id, { songs: [battleSong] })),
    /à partir de 5 personnes/);
  await post('/api/staff/settings', { battleMinVoters: 3 });
  await post('/api/table/battle/propose', body('alpha', a.id, { songs: [battleSong] }));
  assert.equal((await alphaState()).battle.phase, 'voting');
  await post('/api/table/battle/vote', body('alpha', mate.id, { choice: battleSong.songId }));
  await post('/api/table/battle/vote', body('beta', b.id, { choice: 'none' }));
  s = await state();
  assert.equal(s.battle.phase, 'requested');
  assert.equal(s.battle.automation.status, 'waiting');
  assert.ok(!s.queue.some(q => q.kind === 'battle'),
    'envoi automatique désactivé : le bar organise la Battle dans KaraFun');
  await post('/api/staff/battle/resolve', { outcome: 'done' });
  s = await state();
  assert.equal(s.battle.phase, 'cooldown');
  assert.equal(s.battle.automation.status, 'manual',
    'une Battle préparée manuellement reste bloquante jusqu’à ses résultats');
  await post('/api/staff/battle/resolve', { outcome: 'finished' });
  assert.equal((await state()).battle.automation.status, 'after');
  console.log('API identité, duos inter-tables, battle collective, réglages live et accès bar OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
