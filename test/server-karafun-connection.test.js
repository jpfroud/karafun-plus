'use strict';
// Routes de connexion à KaraFun sur la page du bar : un code vide ne doit
// plus effacer le code retenu, « Reconnecter » garde une connexion prête,
// « Prendre un autre nom maintenant », et le code reste masqué dans le
// journal du serveur. server.js tourne dans un bac à sable (--demo) : aucun
// port ouvert, aucun réseau, un faux pont KaraFun.
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
  const lines = [];
  const quietConsole = { ...console, log: line => lines.push(String(line)) };
  const context = { require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console: quietConsole, Buffer, URL, setTimeout, setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { handlers, staffState,
      setBridge: b => { bridge = b; }, setCode: c => { CODE = c; }, getCode: () => CODE };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.lines = lines;
  f.call = (route, body = {}) => f.handlers[route]({}, {}, body);
  return f;
}

function fakeBridge(answer = 'started') {
  const calls = [];
  return { calls, ready: true, connected: true, queue: [], events: [], permissions: {},
    snapshot: () => ({ ready: true, connected: true, queue: [], events: [] }),
    connect: code => { calls.push(['connect', code]); return answer; },
    forceNewName: () => calls.push(['new-name']),
    dismissIdentityNotice: () => calls.push(['dismiss']),
    disconnect: () => calls.push(['disconnect']), releaseIdentity: () => calls.push(['release']) };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('Connecter : un code vide est refusé et le code retenu reste en place', async () => {
  const f = harness();
  const bridge = fakeBridge();
  f.setBridge(bridge);
  f.setCode('123456');
  await assert.rejects(f.call('POST /api/staff/connect', { code: '' }), /Code KaraFun manquant/);
  await assert.rejects(f.call('POST /api/staff/connect', { code: 'abc' }), /Code KaraFun manquant/);
  assert.equal(f.getCode(), '123456');
  assert.deepEqual(bridge.calls, [], 'aucune connexion tentée');
});

test('Connecter : code nettoyé, connexion lancée, code masqué dans le journal du serveur', async () => {
  const f = harness();
  const bridge = fakeBridge();
  f.setBridge(bridge);
  assert.deepEqual(plain(await f.call('POST /api/staff/connect', { code: '65 43 21' })), { ok: true, kept: false });
  assert.equal(f.getCode(), '654321');
  assert.deepEqual(bridge.calls, [['connect', '654321']]);
  assert.ok(f.lines.includes('Connexion à KaraFun (code ••••21)...'));
  assert.equal(f.lines.some(line => line.includes('654321')), false, 'jamais le code complet');
});

test('Reconnecter : connexion prête ou en cours gardée, avec un message pour le bar', async () => {
  const f = harness();
  const bridge = fakeBridge('kept');
  f.setBridge(bridge);
  f.setCode('123456');
  const answer = plain(await f.call('POST /api/staff/kf', { action: 'reconnect' }));
  assert.equal(answer.kept, true);
  assert.match(answer.message, /connexion gardée/);
  assert.deepEqual(bridge.calls, [['connect', '123456']]);
  assert.ok(f.lines.includes('KaraFun (code ••••56) : connexion en cours ou prête, gardée.'));
});

test('Reconnecter sans code : erreur claire au lieu d’un « Reconnexion… » muet', async () => {
  const f = harness();
  const bridge = fakeBridge();
  f.setBridge(bridge);
  f.setCode('');
  await assert.rejects(f.call('POST /api/staff/kf', { action: 'reconnect' }), /Pas de code KaraFun/);
  assert.deepEqual(bridge.calls, []);
});

test('« Prendre un autre nom maintenant » passe par le pont KaraFun', async () => {
  const f = harness();
  const bridge = fakeBridge();
  f.setBridge(bridge);
  assert.deepEqual(plain(await f.call('POST /api/staff/kf', { action: 'new-name' })), { ok: true });
  assert.deepEqual(bridge.calls, [['new-name']]);
});

// KaraFun limite les essais (page de découverte refusée) ou budget de l'heure
// épuisé : le pont ne relit pas la page et le bar reçoit une phrase claire.
test('Connecter / Reconnecter pendant une limite de KaraFun : { ok: false, message } sans code en clair', async () => {
  const f = harness();
  const message = 'KaraFun limite les essais depuis cette connexion jusqu’à 20:00 : inutile de cliquer, la file réessaiera seule. Un téléphone sur un autre réseau (4G/5G) n’est pas concerné.';
  const bridge = fakeBridge({ ok: false, reason: 'limited', message });
  f.setBridge(bridge);
  f.setCode('123456');
  assert.deepEqual(plain(await f.call('POST /api/staff/kf', { action: 'reconnect' })), { ok: false, kept: false, message });
  assert.deepEqual(plain(await f.call('POST /api/staff/connect', { code: '123456' })), { ok: false, kept: false, message });
  assert.deepEqual(bridge.calls, [['connect', '123456'], ['connect', '123456']]);
  assert.ok(f.lines.includes(`KaraFun (code ••••56) : clic sans nouvel essai. ${message}`));
  assert.equal(f.lines.some(line => line.includes('123456')), false, 'jamais le code complet');
});

// Budget de l'heure épuisé et connexion prête : le pont garde son code (une
// faute de frappe ne coupe pas ce qui marche). Le serveur ne retient alors
// pas le code tapé, pour que « Reconnecter » et un redémarrage gardent le bon.
test('Connecter un autre code refusé par le pont : le code retenu reste celui qui marche', async () => {
  const f = harness();
  const message = 'Trop d’essais auprès de KaraFun cette heure-ci : la connexion actuelle est gardée ; un autre code pourra être essayé à 20:00.';
  const bridge = { ...fakeBridge({ ok: false, reason: 'budget', message }), code: '123456' };
  f.setBridge(bridge);
  f.setCode('123456');
  assert.deepEqual(plain(await f.call('POST /api/staff/connect', { code: '123465' })), { ok: false, kept: false, message });
  assert.deepEqual(bridge.calls, [['connect', '123465']]);
  assert.equal(f.getCode(), '123456', 'le code qui marche reste retenu');
  assert.ok(f.lines.includes(`KaraFun (code ••••65) : clic sans nouvel essai. ${message}`), 'le journal parle du code tapé, masqué');
  assert.equal(f.lines.some(line => line.includes('123465')), false);
});
