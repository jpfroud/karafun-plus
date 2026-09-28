'use strict';
// BASE=http://127.0.0.1:3102, démo lancée par run-offline.js.
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://127.0.0.1:3102';
const local = new URL(BASE);
assert.equal(local.hostname, '127.0.0.1');
assert.equal(local.port, '3102');
const PUBLIC = `http://127.0.0.1:${Number(local.port) + 1}`;
const { staffKey } = require('./staff-auth');

async function req(base, path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* page HTML ou texte */ }
  return { status: response.status, data };
}

(async () => {
  const key = await staffKey(BASE);
  const secure = path => path + (path.includes('?') ? '&' : '?') + `key=${encodeURIComponent(key)}`;
  assert.equal((await req(BASE, '/api/staff/state')).status, 403, 'bar sans clé refusé même sur localhost');
  const bar = await req(BASE, secure('/api/staff/state'));
  assert.equal(bar.status, 200);
  assert.ok(bar.data.kf?.ready);
  const table = bar.data.tables.find(t => t.id === '1');
  const path = new URL(table.url).pathname;

  assert.equal((await req(PUBLIC, path)).status, 200, 'page de table via port du tunnel');
  assert.equal((await req(PUBLIC, `/api/state?table=1&access=${path.split('/').pop()}`)).status, 200);
  const publicRoot = await fetch(PUBLIC + '/', { redirect: 'manual' });
  assert.equal(publicRoot.status, 403, 'la racine du tunnel ne doit pas dévoiler la clé du bar');
  assert.equal(publicRoot.headers.get('location'), null);
  assert.equal((await req(PUBLIC, '/internal/shutdown', 'POST', {})).status, 403);
  for (const route of ['/staff', '/print', '/qr/1.svg', '/api/staff/state']) {
    assert.equal((await req(PUBLIC, route)).status, 403, `${route} publié sans clé`);
    assert.equal((await req(PUBLIC, `${route}?key=${key}`)).status, 403, `${route} publié avec clé`);
  }
  assert.equal((await req(PUBLIC, '/api/staff/settings', 'POST', { auto: false })).status, 403);
  assert.equal((await req(BASE, '/staff')).status, 403, 'page bar sans clé refusée');
  assert.equal((await req(BASE, secure('/staff'))).status, 200, 'page bar avec clé');
  console.log('ok - port tunnel public : clients autorisés, bar refusé même avec clé');

  let r = await req(BASE, secure('/api/staff/settings'), 'POST', { baseUrl: 'https://chant.exemple.fr' });
  assert.equal(r.status, 200);
  let state = (await req(BASE, secure('/api/staff/state'))).data;
  assert.equal(state.settings.baseUrl, 'https://chant.exemple.fr');
  assert.ok(state.tables.find(t => t.id === '1').url.startsWith('https://chant.exemple.fr/t/1/'));
  r = await req(BASE, secure('/api/staff/settings'), 'POST', { baseUrl: 'http://chant.exemple.fr' });
  assert.equal(r.status, 400, 'HTTP public interdit');
  for (const localHttps of ['https://localhost', 'https://192.168.0.94', 'https://bar.local']) {
    assert.equal((await req(BASE, secure('/api/staff/settings'), 'POST', { baseUrl: localHttps })).status, 400,
      `fausse adresse Internet acceptée : ${localHttps}`);
  }
  state = (await req(BASE, secure('/api/staff/state'))).data;
  assert.equal(state.settings.baseUrl, 'https://chant.exemple.fr', 'erreur ne change pas le réglage');
  r = await req(BASE, secure('/api/staff/settings'), 'POST', { baseUrl: 'http://192.168.0.94:3000' });
  assert.equal(r.status, 200, 'HTTP local conservé pour le Wi-Fi');
  await req(BASE, secure('/api/staff/settings'), 'POST', { baseUrl: null });
  console.log('ok - adresse QR HTTPS validée et adresse locale acceptée');
})().catch(e => { console.error(e); process.exitCode = 1; });
