'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { choosePort, serverEnv, sandboxCopy, launch } = require('./server-mode-startup.test');

async function fixture(t, { enabled = true, pc = false, version = null } = {}) {
  const cwd = sandboxCopy();
  fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(cwd, 'package.json'));
  // Version installée simulée (package.json de la copie), pour les limites de version.
  if (version) {
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ ...manifest, version }));
  }
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

test('version choisie : seulement une version publiée par l’agent, écrite avant la demande', async t => {
  const f = await fixture(t);
  const installed = `v${JSON.parse(fs.readFileSync(path.join(f.cwd, 'package.json'), 'utf8')).version}`;
  const state = () => f.call('/api/staff/state');
  const request = body => f.call('/api/staff/update', { body });
  assert.deepEqual([(await state()).body.update.versionChoice, (await state()).body.update.versions], [false, []]);
  assert.equal((await request({ version: 'v3.1.2' })).status, 400, 'agent sans liste : aucun choix');
  fs.writeFileSync(path.join(f.directory, 'versions.json'), JSON.stringify({ checkedAt: new Date().toISOString(), versions: [
    { version: installed, publishedAt: '2026-10-30T10:00:00Z' }, { version: 'v3.1.3', publishedAt: '2026-10-28T10:00:00Z' },
    { version: 'v3.1.2', publishedAt: null }] }));
  const offered = (await state()).body.update;
  assert.equal(offered.versionChoice, true);
  assert.deepEqual(offered.versions.map(item => item.version), ['v3.1.3', 'v3.1.2'], 'la version installée n’est pas proposée');
  for (const body of [{ version: installed }, { version: 'v9.9.9' }, { version: 'v3.1.2;id' }, { version: 3 },
    { version: ['v3.1.2'] }, { version: 'v3.1.2', image: 'ghcr.io/elsewhere/app' }]) {
    assert.equal((await request(body)).status, 400, JSON.stringify(body));
  }
  assert.equal(fs.existsSync(path.join(f.directory, 'request.json')), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'target.json')), false);
  const accepted = await request({ version: 'v3.1.2' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.update.busy, true);
  assert.equal(accepted.body.update.chosenVersion, 'v3.1.2');
  const record = JSON.parse(fs.readFileSync(path.join(f.directory, 'request.json'), 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'id']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'target.json'), 'utf8')), { requestId: record.id, version: 'v3.1.2' });
  assert.equal((await request({ version: 'v3.1.3' })).status, 409, 'une seule opération à la fois');
  assert.equal((await f.call('/api/staff/settings', { body: { auto: true } })).status, 503, 'verrou de maintenance');
  fs.writeFileSync(path.join(f.directory, 'status.json'), JSON.stringify({ requestId: record.id, phase: 'rolled-back' }));
  const after = (await state()).body.update;
  assert.equal(after.busy, false);
  assert.match(after.message, /version choisie n’a pas démarré/);
});

test('version choisie pendant une soirée : confirmation exigée, jamais une version qui perd la file', async t => {
  const f = await fixture(t, { version: INSTALLED });
  const state = () => f.call('/api/staff/state');
  const request = body => f.call('/api/staff/update', { body });
  fs.writeFileSync(path.join(f.directory, 'versions.json'), JSON.stringify({ checkedAt: new Date().toISOString(), versions: [
    { version: ABOVE, publishedAt: null }, { version: BELOW, publishedAt: null }] }));
  await f.call('/api/staff/table', { body: { id: '1', headcount: 2 } });
  const table = (await state()).body.tables.find(table => table.id === '1');
  const access = new URL(table.url).pathname.split('/').at(-1);
  const joined = await f.call('/api/join', { body: { table: '1', access, name: 'S01' } });
  assert.equal(joined.status, 200);
  const update = (await state()).body.update;
  assert.equal(update.requiresConfirmation, true);
  assert.equal(update.fullRestoreSince, AT, 'la page sait quelles versions perdent la file');
  for (const body of [{ version: BELOW }, { version: BELOW, confirmActive: true }]) {
    const refused = await request(body);
    assert.equal(refused.status, 409, JSON.stringify(body));
    assert.match(refused.body.error, LIMIT_TEXT);
  }
  assert.equal((await request({ version: ABOVE })).status, 409, 'accord explicite requis avec des clients inscrits');
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['versions.json'], 'ni choix ni demande avant la confirmation');
  const accepted = await request({ version: ABOVE, confirmActive: true });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.update.chosenVersion, ABOVE);
  const record = JSON.parse(fs.readFileSync(path.join(f.directory, 'request.json'), 'utf8'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'target.json'), 'utf8')), { requestId: record.id, version: ABOVE });
});

// Versions autour de la limite des retours en soirée (night-state.js), et une
// version installée au-dessus : ces tests suivent FULL_RESTORE_SINCE et
// package.json quand ils changent.
const { FULL_RESTORE_SINCE } = require('../night-state');
const [LIMIT_MAJOR, LIMIT_MINOR] = FULL_RESTORE_SINCE.slice(1).split('.').map(Number);
const AT = FULL_RESTORE_SINCE;
const BELOW = LIMIT_MINOR > 0 ? `v${LIMIT_MAJOR}.${LIMIT_MINOR - 1}.0` : `v${LIMIT_MAJOR - 1}.0.0`;
const ABOVE = `v${LIMIT_MAJOR}.${LIMIT_MINOR}.1`;
const INSTALLED = `${LIMIT_MAJOR}.${LIMIT_MINOR + 1}.0`;
const LIMIT_TEXT = new RegExp(`à partir de la ${AT.replace(/\./g, '\\.')}`);

// Soirée de la table 1 avec S01 ; renvoie l'identifiant de S01.
async function evening(f) {
  await f.call('/api/staff/table', { body: { id: '1', headcount: 2 } });
  const table = (await f.call('/api/staff/state')).body.tables.find(table => table.id === '1');
  const access = new URL(table.url).pathname.split('/').at(-1);
  const joined = await f.call('/api/join', { body: { table: '1', access, name: 'S01' } });
  assert.equal(joined.status, 200);
  return joined.body.id;
}
const offer = (f, versions) => fs.writeFileSync(path.join(f.directory, 'versions.json'), JSON.stringify({
  checkedAt: new Date().toISOString(), versions: versions.map(version => ({ version, publishedAt: null })) }));

test('dernière version ou version récente hors soirée : demande publiée sans confirmation', async t => {
  const f = await fixture(t, { version: INSTALLED });
  offer(f, [ABOVE]);
  const latest = await f.call('/api/staff/update', { body: {} });
  assert.equal(latest.status, 200);
  assert.equal(latest.body.update.busy, true);
  assert.equal(latest.body.update.chosenVersion, null);
  assert.equal(latest.body.update.nightInMemory, false);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['request.json', 'versions.json'], 'aucun choix pour la dernière version');
  fs.writeFileSync(path.join(f.directory, 'status.json'), JSON.stringify({ requestId: latest.body.update.requestId, phase: 'succeeded' }));
  const chosen = await f.call('/api/staff/update', { body: { version: ABOVE } });
  assert.equal(chosen.status, 200);
  assert.equal(chosen.body.update.chosenVersion, ABOVE);
  const record = JSON.parse(fs.readFileSync(path.join(f.directory, 'request.json'), 'utf8'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'target.json'), 'utf8')), { requestId: record.id, version: ABOVE });
});

test('soirée en mémoire sans personne inscrite : version ancienne toujours refusée', async t => {
  const f = await fixture(t, { version: INSTALLED });
  offer(f, [ABOVE, BELOW]);
  const person = await evening(f);
  assert.equal((await f.call('/api/staff/person/leave', { body: { personId: person } })).status, 200);
  const update = (await f.call('/api/staff/state')).body.update;
  assert.deepEqual([update.requiresConfirmation, update.nightInMemory], [false, true], 'creux de fin de soirée');
  for (const body of [{ version: BELOW }, { version: BELOW, confirmActive: true }]) {
    const refused = await f.call('/api/staff/update', { body });
    assert.equal(refused.status, 409, JSON.stringify(body));
    assert.match(refused.body.error, /« Nouvelle soirée »/);
    assert.match(refused.body.error, LIMIT_TEXT);
  }
  assert.deepEqual(fs.readdirSync(f.directory), ['versions.json']);
  const latest = await f.call('/api/staff/update', { body: {} });
  assert.equal(latest.status, 200, 'dernière version sans confirmation hors activité');
  assert.deepEqual([latest.body.update.chosenVersion, latest.body.update.nightInMemory], [null, true], 'soirée gardée');
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['request.json', 'versions.json'], 'aucun choix pour la dernière version');
  fs.writeFileSync(path.join(f.directory, 'status.json'), JSON.stringify({ requestId: latest.body.update.requestId, phase: 'succeeded' }));
  assert.equal((await f.call('/api/staff/update', { body: { version: ABOVE } })).status, 200, 'version récente sans confirmation hors activité');
});

test('après « Nouvelle soirée », une version ancienne redevient possible', async t => {
  const f = await fixture(t, { version: INSTALLED });
  offer(f, [BELOW]);
  await evening(f);
  assert.equal((await f.call('/api/staff/update', { body: { version: BELOW, confirmActive: true } })).status, 409);
  const cleared = await f.call('/api/staff/tables-clear', { body: { confirmation: 'SUPPRIMER TOUTES LES TABLES' } });
  assert.equal(cleared.status, 200);
  assert.equal((await f.call('/api/staff/state')).body.update.nightInMemory, false, 'soirée remplacée');
  const accepted = await f.call('/api/staff/update', { body: { version: BELOW } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.update.chosenVersion, BELOW);
});

test('après « Nouvelle soirée », un titre mis directement dans KaraFun ne bloque pas une version ancienne', async t => {
  // La garde protège la soirée de l'application (personnes, file, titres passés
  // ou envoyés) ; la file propre de KaraFun n'en fait pas partie.
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const fromServer = createRequire(path.join(root, 'server.js'));
  const timers = [];
  t.after(() => timers.forEach(clearTimeout));
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.execPath, 'server.js', '--demo'];
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const requests = [];
  const context = { __dirname: root, process: fixtureProcess, Buffer, URL, AbortSignal, setImmediate,
    console: { ...console, log() {} },
    setTimeout(...args) { const timer = setTimeout(...args); timers.push(timer); return timer; }, clearTimeout,
    require: name => name === 'fs' ? quietFs : name === './server-update' ? {
      createServerUpdate: () => ({ isBusy: () => false, view: () => ({ enabled: true, busy: false }),
        offers: version => version === BELOW,
        request(reason, options) {
          if (reason) { const error = new Error(reason); error.status = 409; throw error; }
          requests.push(options);
        } }),
      compareVersions: fromServer('./server-update').compareVersions, NOT_OFFERED: fromServer('./server-update').NOT_OFFERED,
    } : fromServer(name) };
  vm.runInNewContext(source.slice(0, source.lastIndexOf('main().catch(')) + `
    globalThis.fixture = { sched, settings, access, sync, clearEvening, handlers, setBridge: value => { bridge = value; } };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  const adds = [];
  const bridge = { ready: true, connected: true, queue: [], status: { state: 'idle' },
    add(songId, singer) { adds.push({ songId, singer }); }, play() {}, next() {}, remove() {} };
  f.setBridge(bridge);
  f.settings.auto = true;
  f.sched.opts.requirePresence = false;
  const update = async body => {
    try { return { status: 200, body: await f.handlers['POST /api/staff/update']({}, {}, body) }; }
    catch (error) { return { status: error.status || 400, error: error.message }; }
  };
  f.sched.table('1'); f.access.issue('1');
  const person = f.sched.join({ tableId: '1', name: 'S01', headcount: 1 });
  f.sched.chooseSong(person, { songId: 700, title: 'Titre A', artist: 'Artiste' });
  f.sync();
  assert.equal(adds.length, 1, 'titre envoyé à KaraFun par l’application');
  const sent = { queueId: 'app-1', songId: 700, title: 'Titre A', artist: 'Artiste', singer: adds[0].singer };
  const direct = { queueId: 'direct-1', songId: 701, title: 'Titre B', artist: 'Artiste', singer: 'Invité' };
  bridge.queue = [sent, direct];
  f.sync();
  const during = await update({ version: BELOW, confirmActive: true });
  assert.equal(during.status, 409, 'soirée de l’application en cours');
  assert.match(during.error, /« Nouvelle soirée »/);
  assert.equal(f.clearEvening().otherKaraFunSongs, 1, 'le titre mis directement dans KaraFun reste');
  bridge.queue = [direct];
  f.sync();
  const unconfirmed = await update({ version: BELOW });
  assert.equal(unconfirmed.status, 409, 'KaraFun joue encore : la brève interruption se confirme');
  assert.doesNotMatch(unconfirmed.error, /Nouvelle soirée/);
  assert.equal((await update({ version: BELOW, confirmActive: true })).status, 200);
  // Objets créés dans le contexte du serveur : comparés par leur JSON.
  assert.equal(JSON.stringify(requests), JSON.stringify([{ version: BELOW }]));
});

test('pendant une soirée, la version FULL_RESTORE_SINCE elle-même reste possible', async t => {
  const f = await fixture(t, { version: INSTALLED });
  offer(f, [AT, BELOW]);
  await evening(f);
  assert.equal((await f.call('/api/staff/update', { body: { version: BELOW, confirmActive: true } })).status, 409);
  const accepted = await f.call('/api/staff/update', { body: { version: AT, confirmActive: true } });
  assert.equal(accepted.status, 200, 'la limite est incluse');
  assert.equal(accepted.body.update.chosenVersion, AT);
});

test('mise à jour absente en mode PC et sur serveur sans agent', async t => {
  for (const options of [{ enabled: false }, { pc: true }]) {
    await t.test(JSON.stringify(options), async subtest => {
      const f = await fixture(subtest, options);
      assert.equal((await f.call('/api/staff/state')).body.update.enabled, false);
      assert.equal((await f.call('/api/staff/state')).body.update.versionChoice, false);
      assert.equal((await f.call('/api/staff/update', { body: {} })).status, 503);
      assert.equal((await f.call('/api/staff/update', { body: { version: 'v3.1.2' } })).status, 400);
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
