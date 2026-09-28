'use strict';
// Parcours complet via l'API contre le mode démo (lancer d'abord : node server.js --demo --song-seconds 4)
const assert = require('assert');
const B = process.env.BASE || 'http://localhost:3000';
const { staffRoute } = require('./staff-auth');
const post = async (p, body) => { const r = await fetch(B + await staffRoute(B, p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) { const e = new Error(j.error); e.code = j.code; throw e; } return j; };
const get = async (p) => (await fetch(B + await staffRoute(B, p))).json();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const songs = await get('/api/search?q=an');
  assert.ok(songs.length > 5, 'recherche');
  for (const [id, headcount] of [['1', 2], ['2', 1], ['3', 5]]) await post('/api/staff/table', { id, headcount });
  const tableSecrets = Object.fromEntries((await get('/api/staff/state')).tables.map(t => [t.id, new URL(t.url).pathname.split('/').pop()]));
  const join = async (table, name) => (await post('/api/join', { table, access: tableSecrets[table], name })).token;
  const T = {};
  T.alice = await join('1', 'Alice'); T.bob = await join('1', 'Bob');
  await assert.rejects(join('1', 'Intrus'), /déjà 2 chanteurs/);            // plafond : navigation privée / faux nom
  T.chloe = await join('2', 'Chloé');
  // Deux chanteurs par table au maximum dans ce scénario : l'alternance
  // stricte reste alors mathématiquement possible avec les autres tables.
  for (const n of ['D1', 'D2']) T[n] = await join('3', n);
  let k = 0;
  for (const tok of Object.values(T)) await post('/api/song', { token: tok, song: songs[k++ % songs.length] });
  await sleep(1500);
  let st = await get('/api/staff/state');
  assert.ok(st.stage || st.next, 'une chanson est partie vers KaraFun');
  console.log('File initiale :', st.queue.map(q => `${q.name}(${q.table.replace('Table ', 'T')})`).join(' > '));

  // Suivre 9 passages : les cinq premiers chanteurs physiques doivent passer
  // avant qu'un seul d'entre eux ne revienne. La place du prochain annoncé
  // reste acquise, même si une autre table arrive entre-temps.
  const sung = [];
  let last = null;
  for (let i = 0; i < 80 && sung.length < 9; i++) {
    await sleep(400);
    st = await get('/api/staff/state');
    const cur = st.stage && st.stage.ours ? st.stage.singer : null;
    if (cur && cur !== last) { sung.push(cur); last = cur; }
    for (const tok of Object.values(T)) {
      const me = (await get(`/api/state?token=${tok}`)).me;
      if (me && !me.song && !(me.duet && me.duet.asPartner)) await post('/api/song', { token: tok, song: songs[k++ % songs.length] });
    }
  }
  console.log('Passages :', sung.join(' | '));
  const singerOf = (label) => label.split('·')[0].trim();
  assert.equal(new Set(sung.slice(0, 5).map(singerOf)).size, 5,
    `un chanteur est revenu avant le premier passage de tous : ${sung.slice(0, 5).join(' | ')}`);
  for (let i = 1; i < sung.length; i++) assert.notStrictEqual(singerOf(sung[i]), singerOf(sung[i - 1]),
    `même chanteur deux fois de suite : ${sung[i]}`);
  assert.ok(sung.length >= 6, 'des chansons passent');

  // Duo Alice -> Bob
  const bobId = (await get(`/api/state?token=${T.bob}`)).me.id;
  await post('/api/duet', { token: T.alice, partnerId: bobId, song: songs[3] });
  const bob = (await get(`/api/state?token=${T.bob}`)).me;
  assert.ok(!bob.invite, 'même table : aucune confirmation requise');
  const alice = (await get(`/api/state?token=${T.alice}`)).me;
  assert.ok(alice.songs.some(s => s.duet?.state === 'accepted'), 'le duo reste programmé dans sa liste');

  // Table 2 part
  await post('/api/staff/table-left', { id: '2' });
  st = await get('/api/staff/state');
  assert.ok(!st.queue.some(q => q.table === 'Table 2'), 'table 2 retirée');
  const ch = await get(`/api/state?token=${T.chloe}`);
  assert.ok(!ch.me, 'Chloé n\'a plus de session');
  console.log('Journal (extrait) :\n - ' + st.log.slice(0, 10).map(l => l.msg).join('\n - '));
  console.log('\nE2E API OK');
  process.exit(0);
})().catch(e => { console.error('ECHEC', e); process.exit(1); });
