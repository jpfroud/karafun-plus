'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { choosePort, serverEnv, sandboxCopy, launch } = require('./server-mode-startup.test');

async function fixture(t, { enabled = true, pc = false } = {}) {
  const cwd = sandboxCopy();
  fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(cwd, 'package.json'));
  const directory = path.join(cwd, 'maintenance');
  fs.mkdirSync(directory);
  const port = await choosePort();
  const publicPort = port + 1;
  const env = serverEnv(enabled ? { KARAOKE_UPDATE_DIR: directory } : {});
  if (pc) for (const name of Object.keys(env)) if (name.startsWith('KARAOKE_')) delete env[name];
  const child = launch(['--no-open', '--port', String(port), '--public-port', String(publicPort)], { env, cwd });
  t.after(() => child.stop());
  const base = `http://127.0.0.1:${port}`;
  let key;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(base + '/healthz')).ok) {
        key = pc ? new URL((await fetch(base + '/', { redirect: 'manual' })).headers.get('location'), base).searchParams.get('key') :
          fs.readFileSync(env.KARAOKE_STAFF_KEY_FILE, 'utf8').trim();
        break;
      }
    } catch (_) {}
    if (child.exitCode !== null) throw new Error(child.stdoutText + child.stderrText);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(key, 'serveur prêt');
  async function call(route, { body, authorized = true, publicPort: publicSide = false } = {}) {
    const response = await fetch((publicSide ? `http://127.0.0.1:${publicPort}` : base) + route, {
      ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { 'content-type': 'application/json', ...(authorized ? { 'x-staff-key': key } : {}) },
    });
    return { status: response.status, body: await response.json() };
  }
  return { call, directory, child };
}

test('mise à jour : authentification, blocage pendant une soirée, verrou et reprise', async t => {
  const f = await fixture(t);
  const state = () => f.call('/api/staff/state');
  const request = options => f.call('/api/staff/update', { body: {}, ...options });
  assert.equal((await state()).body.update.enabled, true);
  assert.equal((await request({ authorized: false })).status, 403);
  assert.equal((await request({ publicPort: true })).status, 403);
  assert.equal((await request({ body: { version: 'v99.0.0' } })).status, 400);

  await f.call('/api/staff/table', { body: { id: '1', headcount: 2 } });
  const table = (await state()).body.tables.find(table => table.id === '1');
  const url = new URL(table.url);
  const access = url.pathname.split('/').at(-1);
  const joined = await f.call('/api/join', { body: { table: '1', access, name: 'S01' } });
  assert.equal(joined.status, 200);
  assert.equal((await request()).status, 409, 'pas de mise à jour avec des clients inscrits');
  assert.equal(fs.existsSync(path.join(f.directory, 'request.json')), false);
  await f.call('/api/staff/table-left', { body: { id: '1' } });
  const accepted = await request();
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.update.busy, true);
  const id = accepted.body.update.requestId;
  assert.equal((await request()).status, 409, 'double clic sans seconde opération');
  assert.equal((await f.call('/api/staff/settings', { body: { auto: true } })).status, 503);
  assert.equal((await f.call('/api/join', { body: { table: '1', access, name: 'S02' } })).status, 503);
  assert.equal((await state()).status, 200, 'suivi disponible pendant la transaction');
  fs.writeFileSync(path.join(f.directory, 'status.json'), JSON.stringify({ requestId: id, phase: 'rolled-back' }));
  assert.equal((await state()).body.update.busy, false);
  assert.equal((await f.call('/api/staff/settings', { body: { auto: false } })).status, 200);
  assert.equal((await request()).status, 200, 'nouvel essai après retour arrière');
});

test('mise à jour absente en mode PC et sur serveur sans agent', async t => {
  for (const options of [{ enabled: false }, { pc: true }]) {
    await t.test(JSON.stringify(options), async subtest => {
      const f = await fixture(subtest, options);
      assert.equal((await f.call('/api/staff/state')).body.update.enabled, false);
      assert.equal((await f.call('/api/staff/update', { body: {} })).status, 503);
    });
  }
});

test('une lecture qui attend Spotify ne peut pas franchir le verrou de maintenance', async t => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const fromServer = createRequire(path.join(root, 'server.js'));
  let busy = false;
  const timers = [];
  t.after(() => timers.forEach(clearTimeout));
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.execPath, 'server.js', '--demo'];
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const context = { __dirname: root, process: fixtureProcess, Buffer, URL, AbortSignal, setImmediate,
    console: { ...console, log() {} },
    setTimeout(...args) { const timer = setTimeout(...args); timers.push(timer); return timer; }, clearTimeout,
    require: name => name === 'fs' ? quietFs : name === './server-update' ? {
      createServerUpdate: () => ({ isBusy: () => busy, view: () => ({ enabled: true, busy }) }),
    } : fromServer(name) };
  vm.runInNewContext(source.slice(0, source.lastIndexOf('main().catch(')) + `
    globalThis.fixture = { spotify, playKaraFun, updateBlockedReason, setBridge: value => { bridge = value; } };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  let played = 0, release;
  f.setBridge({ ready: true, queue: [], status: null, play() { played++; } });
  Object.defineProperty(f.spotify, 'connected', { get: () => true });
  f.spotify.config.autoPause = true;
  f.spotify.config.pauseLeadSec = 0;
  f.spotify.pause = () => new Promise(resolve => { release = resolve; });
  const pending = f.playKaraFun();
  assert.ok(release, 'la lecture attend la pause Spotify');
  assert.match(f.updateBlockedReason(), /Disponible après la soirée/);
  busy = true;
  release('done');
  assert.equal(await pending, false);
  assert.equal(played, 0, 'aucune commande de lecture après attente du réseau');
  assert.equal(await f.playKaraFun(), false, 'un nouvel appel sous maintenance ne lance rien');
  assert.equal(played, 0);
});
