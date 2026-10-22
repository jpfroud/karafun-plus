'use strict';
// P1 (issue #26) : sondes de la démo lancée par run-offline.js
// (BASE=http://127.0.0.1:3102, port clients 3103), par de vraies sockets.
// HEAD est lu octet par octet : la réponse s'arrête après les en-têtes.
const assert = require('node:assert/strict');
const net = require('node:net');
const { staffKey } = require('./staff-auth');

const BASE = process.env.BASE || 'http://127.0.0.1:3102';
const local = new URL(BASE);
const PUBLIC = `http://${local.hostname}:${Number(local.port) + 1}`;
const READY = '{"ok":true,"mode":"pc","karafun":"connected","solver":"off","persistence":"off"}';

// Requête HTTP/1.1 brute : tous les octets reçus jusqu'à la fermeture.
function raw(base, method, route) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname);
    const chunks = [];
    socket.setTimeout(5000, () => socket.destroy(new Error(`${method} ${base}${route} : délai dépassé`)));
    socket.on('connect', () => socket.write(`${method} ${route} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('latin1');
      const at = text.indexOf('\r\n\r\n');
      assert.ok(at > 0, `${method} ${route} : en-têtes incomplets`);
      const [status, ...headers] = text.slice(0, at).split('\r\n');
      resolve({ status: Number(status.split(' ')[1]), after: text.slice(at + 4),
        headers: Object.fromEntries(headers.map(line => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()])) });
    });
  });
}

(async () => {
  const key = await staffKey(BASE);
  for (const base of [BASE, PUBLIC]) {
    const get = await fetch(`${base}/healthz`);
    assert.equal(get.status, 200, `GET ${base}/healthz`);
    assert.equal(get.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await get.text(), 'ok');
    const head = await raw(base, 'HEAD', '/healthz');
    assert.equal(head.status, 200, `HEAD ${base}/healthz`);
    assert.equal(head.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(head.after, '', `HEAD ${base}/healthz : aucun corps`);
  }
  const ready = await fetch(`${BASE}/readyz`);
  const text = await ready.text();
  assert.equal(ready.status, 200, text);
  assert.equal(ready.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(text, READY);
  assert.ok(!text.includes(key), 'aucune clé du bar dans /readyz');
  const hidden = await fetch(`${PUBLIC}/readyz`);
  assert.equal(hidden.status, 404, '/readyz absent du port clients');
  assert.equal(await hidden.text(), 'Introuvable');
  console.log(`ok - sondes de la démo : /healthz sur ${local.port} et ${Number(local.port) + 1}, /readyz prêt sur le port du bar seulement`);
})().catch(error => { console.error(error); process.exitCode = 1; });
