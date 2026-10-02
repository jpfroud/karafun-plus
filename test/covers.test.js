'use strict';
// Vignettes des titres : seule une image https reçue du catalogue KaraFun par
// ce serveur est montrée aux téléphones, jamais une adresse envoyée par l'un
// d'eux (pixel espion, adresse locale, javascript:).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const context = { require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console, Buffer, URL, setTimeout, setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, tracked, handlers, access, chooseFor, publicState, rememberBattleSongs, coverUrl };
  `, context, { filename: 'server.js' });
  return context.fixture;
}

test('vignettes : adresses https du catalogue seulement', () => {
  const { coverUrl } = harness();
  assert.equal(coverUrl('https://cdn.example/a.jpg'), 'https://cdn.example/a.jpg');
  assert.equal(coverUrl('//cdn.example/b.jpg'), 'https://cdn.example/b.jpg', 'adresse sans protocole : https');
  for (const bad of ['http://cdn.example/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AA', '/photo/x', 'https://user:pw@cdn.example/a.jpg',
    `https://cdn.example/${'a'.repeat(600)}`, 42, null, '']) assert.equal(coverUrl(bad), null, String(bad).slice(0, 40));
});

test('vignettes : un titre choisi garde l’image du catalogue, jamais celle envoyée par le téléphone', async () => {
  const f = harness();
  const results = f.rememberBattleSongs([
    { songId: 501, title: 'Avec image', artist: 'A', img: 'https://cdn.example/501.jpg' },
    { songId: 502, title: 'Image locale', artist: 'B', img: 'http://192.168.1.10/espion.png' },
  ]);
  assert.equal(results[1].img, null, 'les téléphones ne reçoivent pas une adresse non https');
  const alice = f.sched.join({ tableId: '1', name: 'Alice', headcount: 2 });
  const bruno = f.sched.join({ tableId: '1', name: 'Bruno', headcount: 2 });
  f.chooseFor(alice, { songId: 501, title: 'Avec image', artist: 'A', img: 'https://espion.example/pixel.png' }, 'append');
  f.chooseFor(bruno, { songId: 999, title: 'Inventé', artist: 'C', img: 'https://espion.example/pixel.png' }, 'append');
  assert.equal(alice.song.img, 'https://cdn.example/501.jpg');
  assert.equal(bruno.song.img, null, 'titre jamais vu dans le catalogue : pas d’image');
  const secret = f.access.issue('1');
  await f.handlers['POST /api/table/duet'](null, null, { table: '1', access: secret, personId: bruno.id, token: bruno.token,
    partnerId: alice.id, song: { songId: 502, title: 'Image locale', artist: 'B', img: 'https://espion.example/pixel.png' } });
  const duet = f.sched.songsOf(bruno).find(song => song.songId === 502);
  assert.equal(duet.img, null, 'invitation en duo : même règle');
  // Une soirée sauvegardée avant cette règle peut contenir une adresse quelconque.
  bruno.song.img = 'javascript:alert(1)';
  const view = f.publicState(null, '1');
  const imgs = view.queue.map(item => item.song?.img).concat(view.tablePeople.flatMap(p => p.songs.map(song => song.img)));
  assert.ok(imgs.includes('https://cdn.example/501.jpg'));
  assert.ok(imgs.every(img => img === null || img.startsWith('https://')), 'aucune adresse non https envoyée');
});
