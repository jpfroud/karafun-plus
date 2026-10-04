'use strict';
// Démo isolée : le premier passage local garde sa place pendant l'attente de présence.
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://127.0.0.1:3109';
const { staffRoute } = require('./staff-auth');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(route, body) {
  const target = await staffRoute(BASE, route);
  const response = await fetch(BASE + target, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}
async function ok(route, body) {
  const result = await request(route, body);
  assert.equal(result.status, 200, `${route}: HTTP ${result.status} ${JSON.stringify(result.data)}`);
  return result.data;
}
const staff = () => ok('/api/staff/state');
const song = (id, title) => ({ songId: id, title, artist: 'Démo' });

(async () => {
  await ok('/api/staff/settings', { auto: false, autoPlay: false, requirePresence: false });
  for (const id of ['A', 'B', 'C']) await ok('/api/staff/table', { id, headcount: 1 });
  const tables = (await staff()).tables;
  const access = id => new URL(tables.find(t => t.id === id).url).pathname.split('/').pop();
  const singers = {};
  for (const [table, name] of [['A', 'Alice'], ['B', 'Sebastiano'], ['C', 'Chloé']]) {
    singers[table] = await ok('/api/table/person', { table, access: access(table), name });
  }
  const body = (table, extra = {}) => ({ table, access: access(table), personId: singers[table].id,
    token: singers[table].token, ...extra });
  const tableState = table => ok('/api/state?' + new URLSearchParams({ table,
    access: access(table), token: singers[table].token }));

  // Une chanson manuelle occupe la scène, puis deux personnes arrivent.
  await ok('/api/staff/kf', { action: 'test-add', songId: 70000 });
  for (let i = 0; i < 40; i++) {
    if ((await staff()).stage) break;
    await sleep(100);
  }
  assert.ok((await staff()).stage, 'Une chanson devrait être sur scène avant le test.');
  await ok('/api/table/song', body('B', { song: song(70001, 'Titre de Sebastiano') }));
  await ok('/api/table/song', body('C', { song: song(70002, 'Titre de Chloé') }));
  await ok('/api/staff/settings', { requirePresence: true, auto: true, pushDelaySec: 0 });
  let s = await staff();
  assert.equal(s.queue[0]?.ids[0], singers.B.id, 'Le premier titre bloqué reste visible et annoncé.');
  assert.equal(s.queue[0]?.source, 'helper');
  assert.equal(s.queue[0]?.waitingPresence, true);
  assert.ok(s.queue.some(turn => turn.ids?.includes(singers.C.id)),
    'Le titre de Chloé reste visible dans la file sans demande prématurée.');
  assert.deepEqual(s.presencePending, ['Sebastiano']);
  assert.equal((await tableState('B')).tablePeople[0].needConfirm, true,
    'Le bouton Je suis là doit apparaître chez Sebastiano.');
  assert.equal((await tableState('C')).tablePeople[0].needConfirm, false,
    'Chloé ne doit pas être sollicitée plusieurs chansons en avance.');
  assert.equal((await request('/api/table/confirm', body('C'))).status, 400,
    'Un téléphone ne peut pas confirmer hors de son tour.');
  assert.equal((await staff()).kf.queue.length, 1, 'Chloé ne doit pas passer devant Sebastiano.');

  await ok('/api/table/confirm', body('B'));
  for (let i = 0; i < 50; i++) {
    s = await staff();
    if (s.kf.queue.some(item => item.songId === 70001)) break;
    await sleep(100);
  }
  assert.ok(s.kf.queue.some(item => item.songId === 70001), 'Le titre confirmé doit partir dans KaraFun.');
  assert.equal(s.kf.queue.some(item => item.songId === 70002), false);
  assert.equal((await tableState('B')).tablePeople[0].needConfirm, false);
  assert.equal((await tableState('C')).tablePeople[0].needConfirm, false,
    'La demande à Chloé attend le début réel du titre de Sebastiano.');

  await ok('/api/staff/kf', { action: 'next' });
  for (let i = 0; i < 40; i++) {
    s = await staff();
    if (!s.stage && s.next?.ids?.includes(singers.B.id)) break;
    await sleep(100);
  }
  await ok('/api/staff/kf', { action: 'play' });
  for (let i = 0; i < 40; i++) {
    s = await staff();
    if (s.stage?.ids?.includes(singers.B.id)) break;
    await sleep(100);
  }
  assert.ok(s.stage?.ids?.includes(singers.B.id), 'Sebastiano doit être sur scène.');
  assert.equal((await tableState('B')).tablePeople[0].needConfirm, false,
    'Aucune demande pendant sa propre chanson.');
  assert.equal((await tableState('C')).tablePeople[0].needConfirm, true,
    'Chloé reçoit sa demande uniquement maintenant.');
  assert.deepEqual((await staff()).presencePending, ['Chloé']);
  console.log('Présence ciblée : demande au prochain seul, ordre conservé, confirmation au bon moment.');
})().catch(error => { console.error(error); process.exitCode = 1; });
