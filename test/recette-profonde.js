'use strict';
// Recette HTTP isolée : BASE=http://127.0.0.1:3101 node test/recette-profonde.js
// Démarrer d'abord : node server.js --demo --song-seconds 10 --port 3101 --no-open
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const BASE = (process.env.BASE || 'http://127.0.0.1:3101').replace(/\/+$/, '');
const { staffRoute } = require('./staff-auth');
const target = new URL(BASE);
assert.equal(target.port, '3101', 'Cette recette est réservée au port de démo 3101');
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), 'BASE doit viser la démo locale');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = Date.now() + 45_000;
const madeTables = new Set();
let touched = false;

async function request(method, route, body) {
  const res = await fetch(BASE + await staffRoute(BASE, route), {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(2500),
  });
  const raw = await res.text();
  let data = raw;
  if (res.headers.get('content-type')?.includes('json')) {
    try { data = JSON.parse(raw); } catch { throw new Error(`${method} ${route} : JSON invalide`); }
  }
  return { status: res.status, data };
}

async function get(route) {
  const r = await request('GET', route);
  assert.equal(r.status, 200, `GET ${route} : ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

async function post(route, body) {
  const r = await request('POST', route, body);
  assert.equal(r.status, 200, `POST ${route} : ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

async function denied(method, route, body, status = 403, code = 'TABLE_ACCESS') {
  const r = await request(method, route, body);
  assert.equal(r.status, status, `${method} ${route} devrait être refusé : ${JSON.stringify(r.data)}`);
  if (code) assert.equal(r.data.code, code, `${method} ${route} : code d'erreur`);
}

async function until(label, read, accept, timeout = 6500) {
  const end = Math.min(deadline, Date.now() + timeout);
  let value;
  while (Date.now() < end) {
    value = await read();
    if (accept(value)) return value;
    await sleep(100);
  }
  throw new Error(`${label} : délai dépassé (${JSON.stringify(value)?.slice(0, 500)})`);
}

const staff = () => get('/api/staff/state');
const stateFor = (table, access, token) => get(`/api/state?${new URLSearchParams(token ? { token } : { table, access })}`);
const personTokens = new Map();
const tableBody = (table, access, personId, extra = {}) => ({ table, access, personId,
  ...(personTokens.has(personId) ? { token: personTokens.get(personId) } : {}), ...extra });
const songIds = songs => songs.map(s => s.songId);
const listed = (s, id) => s.tablePeople.find(p => p.id === id).songs;
const secretFrom = t => {
  const u = new URL(t.url);
  assert.equal(decodeURIComponent(u.pathname.split('/')[2]), t.id);
  const secret = u.pathname.split('/')[3];
  assert.match(secret, /^[A-Za-z0-9_-]{22}$/);
  return secret;
};

async function cleanup() {
  if (!touched) return;
  const errors = [];
  try { await post('/api/staff/settings', { auto: false, autoPlay: false }); }
  catch (e) { errors.push(`réglages : ${e.message}`); }
  for (const id of madeTables) {
    try { await post('/api/staff/table-left', { id }); }
    catch (e) { errors.push(`table ${id} : ${e.message}`); }
  }
  // La démo était vide au départ. Suivant retire le titre en cours, puis les
  // commandes remove vident les titres chargés sans lecture.
  try {
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      const s = await staff();
      if (!s.kf.queue.length) break;
      if (s.stage) await post('/api/staff/kf', { action: 'next' });
      else for (const item of s.kf.queue) await post('/api/staff/kf', { action: 'remove', queueId: item.queueId });
      await sleep(120);
    }
    assert.equal((await staff()).kf.queue.length, 0, 'file KaraFun non vidée');
  } catch (e) { errors.push(`file KaraFun : ${e.message}`); }
  if (errors.length) throw new Error(`Nettoyage incomplet : ${errors.join(' ; ')}`);
}

async function main() {
  const initial = await until('démo prête', staff, s => s.karafun.demo && s.kf?.ready, 5000);
  assert.equal(initial.people.length, 0, 'Utiliser une démo sans chanteurs');
  assert.equal(initial.kf.queue.length, 0, 'Utiliser une démo sans chanson KaraFun');
  assert.equal(initial.pending, null, 'Utiliser une démo sans envoi en cours');
  touched = true;
  await post('/api/staff/settings', { auto: false, autoPlay: false });

  const nonce = crypto.randomBytes(4).toString('hex');
  const a = `R${nonce}`, b = `S${nonce}`;
  await post('/api/staff/table', { id: a, headcount: 3 }); madeTables.add(a);
  await post('/api/staff/table', { id: b, headcount: 1 }); madeTables.add(b);
  const tables = (await staff()).tables;
  const aSecret = secretFrom(tables.find(t => t.id === a));
  const bSecret = secretFrom(tables.find(t => t.id === b));
  assert.notEqual(aSecret, bSecret);
  const aPath = `/t/${a}/${aSecret}`;
  await denied('GET', `/t/${a}`, undefined, 403, null);
  await denied('GET', `/t/${a}/${bSecret}`);
  assert.equal((await request('GET', aPath)).status, 200, 'QR valide inaccessible');
  await denied('GET', `/api/state?table=${a}`);
  await denied('POST', '/api/join', { table: a, name: 'Intrus' });
  await denied('POST', '/api/join', { table: a, access: bSecret, name: 'Intrus' });
  console.log('ok - QR secret et inscription interdite sans capacité');

  const alice = await post('/api/join', { table: a, access: aSecret, name: 'Alice' });
  const bob = await post('/api/table/person', { table: a, access: aSecret, name: 'Bob' });
  const carole = await post('/api/table/person', { table: a, access: aSecret, name: 'Carole' });
  for (const p of [alice, bob, carole]) personTokens.set(p.id, p.token);
  assert.equal(new Set([alice.id, bob.id, carole.id]).size, 3);
  await denied('POST', '/api/table/person', { table: a, access: bSecret, name: 'Intrus' });
  await denied('POST', '/api/table/person', { table: a, access: aSecret, name: 'Quatrième' }, 400, 'TABLE_FULL');
  let view = await stateFor(a, aSecret, alice.token);
  assert.deepEqual(view.tablePeople.map(p => p.name), ['Alice', 'Bob', 'Carole']);
  assert.equal(view.me.pos, null);
  assert.equal(view.me.eta, null);
  assert.equal(view.queue.length, 0);
  console.log('ok - plusieurs chanteurs sur un téléphone, plafond et absence de rang sans titre');

  const found = new Map();
  for (const q of ['an', 'ou', 'on']) {
    for (const song of await get(`/api/search?q=${q}`)) found.set(song.songId, song);
  }
  const songs = [...found.values()];
  assert.ok(songs.length >= 10, `Catalogue démo insuffisant : ${songs.length} titres`);
  const choose = (personId, song, mode = 'append') => post('/api/table/song', tableBody(a, aSecret, personId, { song, mode }));
  const remove = (personId, entryId) => post('/api/table/song/remove', tableBody(a, aSecret, personId, { entryId }));
  await choose(alice.id, songs[0]);
  await choose(alice.id, songs[1]);
  await choose(alice.id, songs[2]);
  view = await stateFor(a, aSecret);
  assert.deepEqual(songIds(listed(view, alice.id)), songIds(songs.slice(0, 3)));
  assert.equal(new Set(listed(view, alice.id).map(s => s.entryId)).size, 3);
  await denied('POST', '/api/table/song', tableBody(a, aSecret, alice.id, { song: songs[1], mode: 'append' }), 400, 'ALREADY_LISTED');
  await remove(alice.id, listed(view, alice.id)[1].entryId); // milieu de liste
  view = await stateFor(a, aSecret);
  assert.deepEqual(songIds(listed(view, alice.id)), [songs[0].songId, songs[2].songId]);
  await remove(alice.id, listed(view, alice.id)[0].entryId); // chanson de tête
  view = await stateFor(a, aSecret);
  assert.deepEqual(songIds(listed(view, alice.id)), [songs[2].songId]);
  await choose(alice.id, songs[3], 'replace');
  await choose(alice.id, songs[4]);
  view = await stateFor(a, aSecret);
  assert.deepEqual(songIds(listed(view, alice.id)), [songs[3].songId, songs[4].songId]);
  console.log('ok - liste append/remove/replace et rejet du doublon local');

  await post('/api/staff/settings', { auto: true }); // queueAdd part sans attendre sa réponse socket
  const pendingSeen = !!(await staff()).pending;
  await choose(alice.id, songs[5], 'replace'); // changement pendant ou juste après l'ACK
  let live = await until('accusé de réception KaraFun', staff,
    s => s.tracked.some(t => t.title === songs[3].title && t.label.includes('Alice')), 6500);
  assert.ok(live.kf.queue.some(q => q.queueId === live.tracked.find(t => t.title === songs[3].title).queueId));
  view = await stateFor(a, aSecret);
  assert.deepEqual(songIds(listed(view, alice.id)), [songs[5].songId], 'le nouveau choix a été perdu après ACK');
  await denied('POST', '/api/table/song', tableBody(a, aSecret, alice.id, { song: songs[3], mode: 'append' }), 400, 'ALREADY_IN_KARAFUN');
  await post('/api/staff/settings', { auto: false });
  console.log(`ok - synchronisation KaraFun, anti-doublon, ACK en attente ${pendingSeen ? 'observé' : 'non observé'}`);

  for (const song of songs.slice(6, 9)) await post('/api/staff/kf', { action: 'test-add', songId: song.songId });
  live = await until('file KaraFun externe', staff, s => s.kf.queue.length >= 3, 4000);
  await choose(bob.id, songs[9]);
  live = await staff(); // état public et snapshot KaraFun du même tour d'événement
  const direct = live.queue.filter(q => q.source === 'karafun');
  const expected = live.kf.queue.filter(q => !live.stage || q.queueId !== live.stage.queueId);
  assert.ok(direct.length >= 2, 'au moins deux chansons KaraFun attendues pour tester leur ordre');
  assert.deepEqual(direct.map(q => q.queueId), expected.map(q => q.queueId), 'ordre public différent de kf.queue');
  assert.deepEqual(direct.map(q => q.pos), direct.map((_, i) => i + 1));
  assert.deepEqual(live.next, live.queue[0]);
  assert.ok(live.queue.every(q => q.title && q.song?.title), 'rang affiché sans titre');
  assert.ok(live.queue.some(q => q.source === 'helper' && q.ids.includes(bob.id)));
  assert.ok(!live.queue.some(q => q.ids.includes(carole.id)), 'Carole a un rang sans chanson');
  console.log('ok - file publique dans l’ordre exact de kf.queue, titres obligatoires');

  await remove(alice.id, (await stateFor(a, aSecret)).tablePeople.find(p => p.id === alice.id).songs[0].entryId);
  view = await stateFor(a, aSecret, alice.token);
  assert.equal(view.me.song, null);
  assert.equal(view.me.pos, null, 'rang affiché après retrait du dernier titre');
  assert.equal(view.me.eta, null, 'heure affichée après retrait du dernier titre');
  assert.ok((await staff()).people.some(p => p.id === alice.id && p.inQueue), 'ticket interne perdu');
  console.log('ok - ticket interne conservé sans rang ni heure après retrait du dernier titre');

  await post('/api/staff/table-left', { id: a }); madeTables.delete(a);
  await denied('GET', aPath);
  await denied('POST', '/api/join', { table: a, access: aSecret, name: 'Ancien QR' });
  await denied('POST', '/api/song', { token: alice.token, song: songs[0] }, 401, 'NO_SESSION');
  await post('/api/staff/table', { id: a, headcount: 1 }); madeTables.add(a);
  const fresh = secretFrom((await staff()).tables.find(t => t.id === a));
  assert.notEqual(fresh, aSecret);
  await denied('GET', aPath);
  assert.equal((await request('GET', `/t/${a}/${fresh}`)).status, 200);
  await post('/api/join', { table: a, access: fresh, name: 'Nouvelle cliente' });
  console.log('ok - reset de table, ancien QR révoqué et nouveau QR utilisable');
}

(async () => {
  let failure;
  try { await main(); }
  catch (e) { failure = e; }
  try { await cleanup(); }
  catch (e) { failure = failure ? new AggregateError([failure, e], 'Recette et nettoyage en échec') : e; }
  if (failure) throw failure;
  console.log('\nRECETTE PROFONDE OK');
})().catch(e => { console.error('ECHEC RECETTE PROFONDE', e); process.exitCode = 1; });
