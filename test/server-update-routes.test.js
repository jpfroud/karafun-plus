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
  const args = ['--no-open', '--port', String(port), '--public-port', String(publicPort)];
  let child = launch(args, { env, cwd });
  t.after(() => child.stop());
  const base = `http://127.0.0.1:${port}`;
  let key;
  async function ready() {
    for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(base + '/healthz')).ok) {
        key = pc ? new URL((await fetch(base + '/', { redirect: 'manual' })).headers.get('location'), base).searchParams.get('key') :
          fs.readFileSync(env.KARAOKE_STAFF_KEY_FILE, 'utf8').trim();
        return;
      }
    } catch (_) {}
    if (child.exitCode !== null) throw new Error(child.stdoutText + child.stderrText);
    await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Serveur temporaire non prêt.');
  }
  await ready();
  assert.ok(key, 'serveur prêt');
  async function call(route, { body, authorized = true, publicPort: publicSide = false } = {}) {
    const response = await fetch((publicSide ? `http://127.0.0.1:${publicPort}` : base) + route, {
      ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: { 'content-type': 'application/json', ...(authorized ? { 'x-staff-key': key } : {}) },
    });
    return { status: response.status, body: await response.json() };
  }
  return { call, directory, cwd, restart: async () => { await child.stop(); child = launch(args, { env, cwd }); await ready(); } };
}

test('mise à jour : authentification, confirmation de soirée active, verrou et reprise', async t => {
  const f = await fixture(t);
  const state = () => f.call('/api/staff/state');
  const request = options => f.call('/api/staff/update', { body: {}, ...options });
  assert.equal((await state()).body.update.enabled, true);
  assert.equal((await request({ authorized: false })).status, 403);
  assert.equal((await request({ publicPort: true })).status, 403);
  assert.equal((await request({ body: { version: 'v99.0.0' } })).status, 400);
  for (const body of [{ confirmActive: 'true' }, { confirmActive: 1 }, { confirmActive: true, command: 'x' }]) {
    assert.equal((await request({ body })).status, 400, 'confirmation strictement booléenne, aucun autre paramètre');
  }

  await f.call('/api/staff/table', { body: { id: '1', headcount: 2 } });
  const table = (await state()).body.tables.find(table => table.id === '1');
  const url = new URL(table.url);
  const access = url.pathname.split('/').at(-1);
  const joined = await f.call('/api/join', { body: { table: '1', access, name: 'S01' } });
  assert.equal(joined.status, 200);
  assert.equal((await state()).body.update.blockedReason, null, 'une soirée active ne bloque pas le bouton');
  assert.equal((await state()).body.update.requiresConfirmation, true);
  assert.equal((await request()).status, 409, 'accord explicite requis avec des clients inscrits');
  assert.equal(fs.existsSync(path.join(f.directory, 'request.json')), false);
  const accepted = await request({ body: { confirmActive: true } });
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
  assert.equal((await state()).body.people.find(p => p.id === joined.body.id).active, true,
    'la mise à jour ne déclare personne parti');
  assert.equal((await request({ body: { confirmActive: true } })).status, 200, 'nouvel essai après retour arrière');
});

test('mise à jour confirmée : soirée, accès, listes et ordre manuel conservés à la reprise', async t => {
  const f = await fixture(t);
  const ok = async (route, body) => {
    const r = await f.call(route, body === undefined ? {} : { body });
    assert.equal(r.status, 200, `${route}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  await ok('/api/staff/settings', { auto: false, requirePresence: false });
  for (const id of ['T1', 'T2']) await ok('/api/staff/table', { id, headcount: 2 });
  const tables = (await ok('/api/staff/state')).tables;
  const singers = [];
  for (let index = 0; index < 4; index++) {
    const table = index < 2 ? 'T1' : 'T2';
    const access = new URL(tables.find(t => t.id === table).url).pathname.split('/').pop();
    const p = await ok('/api/table/person', { table, access, name: `S0${index + 1}` });
    const person = { ...p, table, access, personId: p.id };
    singers.push(person);
    for (let n = 0; n < 2; n++) await ok('/api/table/song', { ...person,
      song: { songId: 800 + index * 2 + n, title: `Titre ${index}-${n}`, artist: 'Test' } });
  }
  await ok('/api/table/duet', { ...singers[0], partnerId: singers[1].id,
    song: { songId: 900, title: 'Duo', artist: 'Test' } });
  await ok('/api/staff/move', { personId: singers[3].id, toIndex: 0, priority: true });
  const before = await ok('/api/staff/state');
  const fingerprint = s => ({ tables: s.tables.map(t => ({ id: t.id, name: t.name, url: t.url, activeCount: t.activeCount })),
    people: s.people.map(p => ({ id: p.id, active: p.active, songCount: p.songCount })),
    queue: s.queue.map(row => ({ ids: row.ids, entryId: row.song?.entryId, title: row.song?.title || row.title })),
    settings: s.settings, manualChanges: s.manualChanges });
  assert.equal(before.queue.length > 2, true);
  assert.equal(before.update.requiresConfirmation, true);
  const denied = await f.call('/api/staff/update', { body: {} });
  assert.equal(denied.status, 409);
  assert.equal(fs.existsSync(path.join(f.directory, 'request.json')), false, 'annulation/refus sans maintenance');
  const accepted = await ok('/api/staff/update', { confirmActive: true });
  const id = accepted.update.requestId;
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.directory, 'request.json'), 'utf8'))).sort(),
    ['createdAt', 'id'], 'la confirmation ne transmet aucune nouvelle option au service hôte');
  await f.restart();
  const locked = await ok('/api/staff/state');
  assert.equal(locked.update.busy, true, 'la candidate attend la validation hôte');
  assert.deepEqual(fingerprint(locked), fingerprint(before), 'aucun changement de soirée pendant le redémarrage');
  assert.equal((await f.call('/api/table/song', { body: { ...singers[0],
    song: { songId: 999, title: 'Pendant maintenance', artist: 'Test' } } })).status, 503);
  fs.writeFileSync(path.join(f.directory, 'status.json'), JSON.stringify({ requestId: id, phase: 'succeeded' }));
  const after = await ok('/api/staff/state');
  assert.equal(after.update.busy, false);
  assert.deepEqual(fingerprint(after), fingerprint(before));
  await ok('/api/table/song', { ...singers[0], song: { songId: 999, title: 'Après maintenance', artist: 'Test' } });
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
  assert.match(f.updateBlockedReason(), /action.*cours/i);
  busy = true;
  release('done');
  assert.equal(await pending, false);
  assert.equal(played, 0, 'aucune commande de lecture après attente du réseau');
  assert.equal(await f.playKaraFun(), false, 'un nouvel appel sous maintenance ne lance rien');
  assert.equal(played, 0);
});

test('les commandes et le retour OAuth Spotify doivent finir avant la mise à jour', async t => {
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
      createServerUpdate: () => ({ isBusy: () => busy, view: () => ({ enabled: true, busy }),
        request(reason) {
          if (reason) { const error = new Error(reason); error.status = 409; throw error; }
          busy = true;
        } }),
    } : fromServer(name) };
  vm.runInNewContext(source.slice(0, source.lastIndexOf('main().catch(')) + `
    globalThis.fixture = { server, spotify, key: STAFF_KEY, port: PORT, handle: server.listeners('request')[0] };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => f.server.close(resolve)));
  const base = `http://127.0.0.1:${f.server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-staff-key': f.key }, body: JSON.stringify(body) });
  let release, started;
  const pending = new Promise(resolve => { started = resolve; });
  f.spotify.resume = () => new Promise(resolve => { release = resolve; started(); });
  const playing = post('/api/staff/spotify', { action: 'play' });
  await pending;
  try {
    const blocked = await post('/api/staff/update', { confirmActive: true });
    assert.equal(blocked.status, 409, 'une action manuelle déjà lancée ne finit pas après la sauvegarde de maintenance');
    assert.equal(busy, false, 'la maintenance ne commence pas pendant la commande Spotify');
  } finally { release('done'); }
  assert.equal((await playing).status, 200);
  assert.equal((await post('/api/staff/spotify', { action: 'inconnue' })).status, 400,
    'une commande refusée libère aussi son compteur');
  let finishAuthCalls = 0, releaseAuth;
  f.spotify.finishAuth = () => {
    finishAuthCalls++;
    return new Promise(resolve => { releaseAuth = resolve; });
  };
  const callback = async () => {
    const out = {};
    await f.handle({ method: 'GET', url: '/spotify/callback?code=essai&state=essai', headers: {},
      socket: { localPort: f.port, remoteAddress: '127.0.0.1' } }, {
      writeHead(status, headers) { out.status = status; out.headers = headers; }, end() {},
    });
    return out;
  };
  const authorizing = callback();
  assert.equal(finishAuthCalls, 1, 'le retour OAuth attend le serveur Spotify');
  try {
    assert.equal((await post('/api/staff/update', { confirmActive: true })).status, 409,
      'le retour OAuth est aussi une mutation suivie, même sur GET');
    assert.equal(busy, false);
  } finally { releaseAuth(); }
  assert.equal((await authorizing).status, 200);
  const accepted = await post('/api/staff/update', { confirmActive: true });
  assert.equal(accepted.status, 200, 'le compteur est libéré après la fin de la commande');
  assert.equal(busy, true);
  assert.equal((await callback()).status, 503, 'un nouveau retour OAuth attend la fin de la maintenance');
  assert.equal(finishAuthCalls, 1, 'la maintenance ne consomme pas le state OAuth');
});
