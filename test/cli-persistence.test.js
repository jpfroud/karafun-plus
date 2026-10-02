'use strict';
// Petits outils en ligne de commande et cas limites de la sauvegarde :
// - stop.js (ARRETER.bat) : fichier de session absent ou abîmé, arrêt accepté
//   avec l'en-tête x-helper-stop, arrêt refusé par le serveur ;
// - start-evening.js (DEMARRER.bat) : KaraFun lancé ou non, introuvable,
//   état inconnu, file déjà ouverte, port 3000 pris par un autre programme ;
// - night-state.js : photos enregistrées à part, écritures interrompues et
//   champs abîmés d'une sauvegarde, refusés avec un message en français.
// Aucun port fixe : le faux serveur d'arrêt écoute sur un port éphémère, le
// vrai KaraFun et le vrai serveur ne sont jamais lancés.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { Scheduler, DEFER_MAX } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { NightStateStore, snapshotNight, restoreNight } = require('../night-state');

const root = path.join(__dirname, '..');
const FAKE_SECRET = '123456-faux-secret';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-cli-persistance-'));
process.on('exit', () => {
  // Dossier créé exclusivement sous le répertoire temporaire du test.
  if (path.resolve(work).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
let serial = 0;
const freshDir = name => fs.mkdtempSync(path.join(work, `${name}-${++serial}-`));

// Environnement propre pour les processus enfants : pas de proxy, pas de
// chemins Windows hérités. NODE_V8_COVERAGE est conservé pour la couverture.
function childEnv(extra) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(https?_proxy|no_proxy|all_proxy|node_use_env_proxy)$/i.test(name) ||
      ['KARAFUN_EXE', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'NODE_TEST_CONTEXT'].includes(name)) delete env[name];
  }
  return { ...env, ...extra };
}

function runNode(args, env) {
  return new Promise(resolve => {
    childProcess.execFile(process.execPath, args, { cwd: work, env: childEnv(env), timeout: 15000 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// stop.js : le vrai fichier est exécuté (pour la couverture), mais son dossier
// data/ est redirigé vers un dossier temporaire par un module préchargé.
// ---------------------------------------------------------------------------
const stopPreload = path.join(work, 'stop-preload.js');
fs.writeFileSync(stopPreload, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const realData = path.join(process.env.STOP_ROOT, 'data') + path.sep;
const redirect = p => typeof p === 'string' && p.startsWith(realData) ?
  path.join(process.env.STOP_DATA, p.slice(realData.length)) : p;
for (const name of ['existsSync', 'readFileSync']) {
  const original = fs[name];
  fs[name] = (file, ...rest) => original.call(fs, redirect(file), ...rest);
}
`);

function runStop(dataDir, args = []) {
  return runNode(['--require', stopPreload, path.join(root, 'stop.js'), ...args],
    { STOP_ROOT: root, STOP_DATA: dataDir });
}

// Faux serveur de la file : n'écoute que sur 127.0.0.1, port choisi par le système.
async function shutdownServer(status) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, key: req.headers['x-helper-stop'], body });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? '{"ok":true}' : '{"error":"Arrêt réservé à ce PC."}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, port: server.address().port, close: () => new Promise(r => server.close(r)) };
}

test('ARRETER : sans fichier de session, le bar est invité à fermer la fenêtre noire', async () => {
  const data = freshDir('arret-absent');
  const result = await runStop(data, ['--port', '3000']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Impossible d’arrêter la file karaoké : La file karaoké ne semble pas lancée par cette version\. Ferme sa fenêtre noire avec Ctrl\+C\./);
  assert.equal(result.stdout, '');
});

test('ARRETER : un fichier de session abîmé est refusé sans rien contacter', async () => {
  const server = await shutdownServer(200);
  try {
    for (const runtime of [{ port: String(server.port), secret: FAKE_SECRET }, { port: server.port },
      { port: server.port, secret: 123456 }, { port: 12.5, secret: FAKE_SECRET }]) {
      const data = freshDir('arret-invalide');
      fs.writeFileSync(path.join(data, 'runtime-3000.json'), JSON.stringify(runtime));
      const result = await runStop(data, ['--port', '3000']);
      assert.equal(result.code, 1, JSON.stringify(runtime));
      assert.match(result.stderr, /Impossible d’arrêter la file karaoké : Fichier de session invalide\./);
    }
    const data = freshDir('arret-json');
    fs.writeFileSync(path.join(data, 'runtime-3000.json'), '{ pas du json');
    const result = await runStop(data, ['--port', '3000']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Impossible d’arrêter la file karaoké : /, 'JSON illisible : message lisible, pas de pile');
    assert.equal(server.requests.length, 0, 'aucune demande d’arrêt avec un fichier invalide');
  } finally { await server.close(); }
});

test('ARRETER : demande POST /internal/shutdown avec le secret de session, puis confirmation', async () => {
  const server = await shutdownServer(200);
  try {
    const data = freshDir('arret-ok');
    fs.writeFileSync(path.join(data, 'runtime-3000.json'), JSON.stringify({ port: server.port, secret: FAKE_SECRET }));
    // Sans --port, ARRETER.bat vise la file du port 3000.
    const result = await runStop(data);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /La file karaoké s’arrête\. Tu peux ensuite relancer DEMARRER\.bat\./);
    assert.equal(result.stderr, '');
    assert.equal(server.requests.length, 1);
    assert.deepEqual(server.requests[0], { method: 'POST', url: '/internal/shutdown', key: FAKE_SECRET, body: '' });
  } finally { await server.close(); }
});

test('ARRETER : --port choisit le fichier de session de cette file', async () => {
  const server = await shutdownServer(200);
  try {
    const data = freshDir('arret-port');
    fs.writeFileSync(path.join(data, 'runtime-3000.json'), JSON.stringify({ port: 1, secret: 'mauvaise-file' }));
    fs.writeFileSync(path.join(data, 'runtime-3456.json'), JSON.stringify({ port: server.port, secret: FAKE_SECRET }));
    const result = await runStop(data, ['--port', '3456']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].key, FAKE_SECRET);
  } finally { await server.close(); }
});

test('ARRETER : un refus du serveur affiche son code HTTP', async () => {
  const server = await shutdownServer(403);
  try {
    const data = freshDir('arret-refus');
    fs.writeFileSync(path.join(data, 'runtime-3000.json'), JSON.stringify({ port: server.port, secret: FAKE_SECRET }));
    const result = await runStop(data, ['--port', '3000']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Impossible d’arrêter la file karaoké : Arrêt refusé \(HTTP 403\)\./);
    assert.doesNotMatch(result.stdout, /s’arrête/);
    assert.equal(server.requests.length, 1);
  } finally { await server.close(); }
});

test('ARRETER : un port invalide est refusé avant toute lecture', async () => {
  const data = freshDir('arret-port-invalide');
  for (const port of ['0', '70000', 'abc']) {
    const result = await runStop(data, ['--port', port]);
    assert.notEqual(result.code, 0, port);
    assert.match(result.stderr, /Port invalide\./, port);
  }
});

// ---------------------------------------------------------------------------
// start-evening.js : fonctions exportées testées dans ce processus, puis
// main() exécuté dans un enfant avec un Windows simulé.
// ---------------------------------------------------------------------------
function loadStartEvening(execFileStub) {
  const original = childProcess.execFile;
  childProcess.execFile = execFileStub;
  try {
    delete require.cache[require.resolve('../start-evening')];
    return require('../start-evening');
  } finally { childProcess.execFile = original; }
}

test('DEMARRER : détection de KaraFun par Get-Process (lancé, fermé, inconnu)', async () => {
  const calls = [];
  let answer;
  const { karafunRunning } = loadStartEvening((file, args, options, callback) => {
    calls.push({ file, args, options });
    setImmediate(() => answer(callback));
  });
  answer = cb => cb(null, ' 2\r\n');
  assert.equal(await karafunRunning(), true, 'deux fenêtres KaraFun : déjà lancé');
  assert.equal(calls[0].file, 'powershell.exe');
  assert.ok(calls[0].args.includes('-NonInteractive'));
  assert.match(calls[0].args.at(-1), /Get-Process -Name KaraFun/);
  assert.equal(calls[0].options.windowsHide, true, 'aucune fenêtre PowerShell visible au bar');
  assert.equal(calls[0].options.timeout, 5000);
  answer = cb => cb(null, '0\r\n');
  assert.equal(await karafunRunning(), false, 'aucun processus : KaraFun fermé');
  answer = cb => cb(null, '');
  assert.equal(await karafunRunning(), false);
  answer = cb => cb(Object.assign(new Error('Accès refusé'), { code: 'EPERM' }), '');
  assert.equal(await karafunRunning(), null, 'PowerShell refusé : état inconnu, pas de lancement à l’aveugle');
});

test('DEMARRER : reconnaît sa propre file sur le port 3000 et refuse un autre programme', async () => {
  const { helperRunning } = loadStartEvening(() => {});
  const originalFetch = globalThis.fetch;
  const seen = [];
  let reply;
  globalThis.fetch = async (url, init) => { seen.push({ url, redirect: init.redirect }); return reply(); };
  try {
    reply = () => ({ status: 302, headers: new Headers({ location: '/staff?key=123456' }) });
    assert.equal(await helperRunning(), true);
    assert.deepEqual(seen[0], { url: 'http://localhost:3000/', redirect: 'manual' },
      'la redirection vers la page du bar n’est pas suivie');
    reply = () => ({ status: 302, headers: new Headers({ location: '/ailleurs' }) });
    await assert.rejects(helperRunning(), /Le port 3000 est utilisé par un autre programme\./);
    reply = () => ({ status: 200, headers: new Headers() });
    await assert.rejects(helperRunning(), /Le port 3000 est utilisé par un autre programme\./);
    reply = () => { throw new TypeError('fetch failed'); };
    assert.equal(await helperRunning(), false, 'rien n’écoute : la file peut démarrer');
  } finally { globalThis.fetch = originalFetch; }
});

const eveningPreload = path.join(work, 'evening-preload.js');
fs.writeFileSync(eveningPreload, `'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const cp = require('node:child_process');
const scenario = JSON.parse(process.env.EVENING_SCENARIO);
const log = event => fs.appendFileSync(process.env.EVENING_EVENTS, JSON.stringify(event) + '\\n');
if (scenario.platform) Object.defineProperty(process, 'platform', { value: scenario.platform });
cp.execFile = (file, args, options, callback) => {
  log({ type: 'execFile', file });
  setImmediate(() => scenario.running === 'error' ? callback(new Error('refusé'), '') : callback(null, String(scenario.running)));
};
cp.spawn = (file, args, options) => {
  log({ type: 'spawn', file, args, detached: options.detached });
  return { unref() { log({ type: 'unref', file }); } };
};
globalThis.fetch = async (url, init = {}) => {
  log({ type: 'fetch', url, redirect: init.redirect });
  if (scenario.helper === 'absent') throw new TypeError('fetch failed');
  if (url.endsWith('/internal/version')) {
    if (scenario.runningBuild === 'error') throw new TypeError('fetch failed');
    if (scenario.runningBuild === 'busy') return { ok: false, status: 503, json: async () => ({}) };
    if (!scenario.runningBuild) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => scenario.runningBuild };
  }
  if (scenario.helper === 'file') return { status: 302, headers: new Headers({ location: '/staff?key=123456' }) };
  return { status: 200, headers: new Headers() };
};
const load = Module._load;
Module._load = function (request, parent) {
  if (request === './server' && parent && /start-evening\\.js$/.test(parent.filename)) {
    log({ type: 'server' });
    return {};
  }
  return load.apply(this, arguments);
};
`);

async function runEvening(scenario, env = {}, script = path.join(root, 'start-evening.js')) {
  const events = path.join(freshDir('demarrer'), 'events.jsonl');
  fs.writeFileSync(events, '');
  const result = await runNode(['--require', eveningPreload, script],
    { EVENING_SCENARIO: JSON.stringify(scenario), EVENING_EVENTS: events, ...env });
  result.events = fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return result;
}

test('DEMARRER sous Windows : KaraFun fermé et installé est lancé, puis la file démarre', async () => {
  const result = await runEvening({ platform: 'win32', running: 0, helper: 'absent' },
    { KARAFUN_EXE: process.execPath });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /KaraFun démarre\. Active sa télécommande si elle ne l’est pas déjà\./);
  assert.match(result.stdout, /La file karaoké démarre\. Si le code KaraFun a changé, saisis-le sur la page du bar\./);
  const types = result.events.map(event => event.type);
  assert.deepEqual(types, ['execFile', 'spawn', 'unref', 'fetch', 'server']);
  assert.equal(result.events[0].file, 'powershell.exe');
  assert.deepEqual(result.events[1], { type: 'spawn', file: process.execPath, args: [], detached: true },
    'KaraFun est lancé détaché : fermer la fenêtre noire ne le ferme pas');
});

test('DEMARRER sous Windows : KaraFun introuvable, le bar est invité à l’ouvrir', async () => {
  const empty = freshDir('sans-karafun');
  const result = await runEvening({ platform: 'win32', running: 0, helper: 'absent' },
    { ProgramFiles: empty, LOCALAPPDATA: empty });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /KaraFun introuvable aux emplacements habituels : ouvre-le manuellement, puis active sa télécommande\./);
  assert.ok(!result.events.some(event => event.type === 'spawn'), 'aucun programme lancé au hasard');
  assert.ok(result.events.some(event => event.type === 'server'), 'la file démarre quand même');
});

test('DEMARRER sous Windows : état de KaraFun inconnu, aucun second KaraFun lancé', async () => {
  const result = await runEvening({ platform: 'win32', running: 'error', helper: 'absent' },
    { KARAFUN_EXE: process.execPath });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Ouvre KaraFun manuellement si sa fenêtre ne s’affiche pas\./);
  assert.ok(!result.events.some(event => event.type === 'spawn'));
});

test('DEMARRER : KaraFun et la file déjà ouverts, seule la page du bar s’ouvre', async () => {
  const result = await runEvening({ platform: 'win32', running: 1, helper: 'file' },
    { KARAFUN_EXE: process.execPath });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /La file karaoké tourne déjà : ouverture de la page du bar\./);
  assert.doesNotMatch(result.stdout, /KaraFun démarre|La file karaoké démarre/);
  const spawns = result.events.filter(event => event.type === 'spawn');
  assert.deepEqual(spawns, [{ type: 'spawn', file: 'cmd.exe', args: ['/c', 'start', '', 'http://localhost:3000/'], detached: true }]);
  assert.ok(!result.events.some(event => event.type === 'server'), 'pas de second serveur sur le même port');
});

// Regression: essai au bar du 2 octobre — le kit du matin tournait encore ;
// DEMARRER du nouveau kit rouvrait sa page sans prévenir : le 403, la lecture
// automatique et le silence avant le titre semblaient non corrigés.
function kitCopy(commit) {
  const dir = freshDir('kit');
  fs.copyFileSync(path.join(root, 'start-evening.js'), path.join(dir, 'start-evening.js'));
  fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ version: 'v0.4.0', commit, builtAt: '2026-10-02T13:42:00.0000000Z' }));
  return path.join(dir, 'start-evening.js');
}

test('DEMARRER : une autre version tourne déjà, le bar est prévenu au lieu de rouvrir l’ancienne', async () => {
  const script = kitCopy('4d575cebfd27d6cd872ba49502d646adeb427d7a');
  for (const runningBuild of [null, { version: 'v0.4.0', commit: '5681f16', builtAt: null }]) {
    const result = await runEvening({ platform: 'linux', helper: 'file', runningBuild }, {}, script);
    assert.equal(result.code, 3, 'DEMARRER.bat reste ouvert ; KaraFun Plus.exe reconnaît ce code');
    assert.match(result.stdout, runningBuild ? /Une autre version de la file karaoké tourne déjà \(v0\.4\.0 5681f16\)\./ :
      /Une autre version de la file karaoké tourne déjà \(version plus ancienne\)\./);
    assert.match(result.stdout, /Pour lancer celle de ce dossier \(v0\.4\.0 4d575ce\) : sur la page du bar qui s’ouvre, clique « Arrêter la soirée » \(ou lance ARRETER\.bat dans le dossier de l’autre version\), puis relance\./);
    // La page de l'autre version s'ouvre : « Arrêter la soirée » est à un clic.
    assert.deepEqual(result.events.filter(event => event.type === 'spawn').map(event => event.file), ['cmd.exe']);
    assert.ok(!result.events.some(event => event.type === 'server'));
  }
  // Version qui tourne illisible (délai, panne) : rien n'est affirmé, la page s'ouvre.
  for (const runningBuild of ['error', 'busy']) {
    const unknown = await runEvening({ platform: 'linux', helper: 'file', runningBuild }, {}, script);
    assert.equal(unknown.code, 0, unknown.stderr);
    assert.match(unknown.stdout, /La file karaoké tourne déjà \(version non vérifiée\) : ouverture de la page du bar\./, runningBuild);
  }
  // Même kit déjà lancé : seule la page du bar s'ouvre, comme avant.
  const same = await runEvening({ platform: 'linux', helper: 'file', runningBuild: { version: 'v0.4.0', commit: '4d575ce' } }, {}, script);
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /La file karaoké tourne déjà : ouverture de la page du bar\./);
});

test('DEMARRER hors Windows : pas de PowerShell ; port 3000 pris par un autre programme', async () => {
  const result = await runEvening({ platform: 'linux', helper: 'autre' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Démarrage impossible : Le port 3000 est utilisé par un autre programme\./);
  assert.ok(!result.events.some(event => event.type === 'execFile'), 'Get-Process n’est appelé que sous Windows');
  assert.ok(!result.events.some(event => event.type === 'server'));
});

// ---------------------------------------------------------------------------
// night-state.js
// ---------------------------------------------------------------------------
const song = (songId, title) => ({ songId, title, artist: 'Artiste' });
const settings = () => ({ auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 });
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function night() {
  const sched = new Scheduler();
  const access = new TableAccess();
  sched.table('1'); sched.setHeadcount('1', 3); access.issue('1');
  const alice = sched.join({ tableId: '1', name: 'Alice', photo: { type: 'image/png', buf: PNG } });
  const bob = sched.join({ tableId: '1', name: 'Bob' });
  sched.chooseSong(alice, song(101, 'Première'), 'append');
  sched.chooseSong(bob, song(102, 'Seconde'), 'append');
  return { sched, access, alice, bob };
}

// Soirée active qui ne doit pas bouger quand une sauvegarde est refusée.
function activeNight() {
  const scheduler = new Scheduler();
  scheduler.table('safe');
  const access = new TableAccess();
  access.issue('safe');
  return { scheduler, access, secret: access.get('safe'), settings: settings() };
}

function assertRefused(snapshot, reason, options = {}) {
  const target = activeNight();
  assert.throws(() => restoreNight(snapshot, { scheduler: target.scheduler, access: target.access,
    settings: target.settings, ...options }), error =>
    error.message === `Sauvegarde de soirée invalide : ${reason}`, reason);
  assert.ok(target.scheduler.table('safe', false), `${reason} : la soirée active reste intacte`);
  assert.equal(target.access.get('safe'), target.secret);
  assert.equal(target.settings.auto, true);
}

function restore(snapshot, options = {}) {
  const scheduler = new Scheduler();
  const result = restoreNight(snapshot, { scheduler, access: new TableAccess(), settings: settings(), ...options });
  return { scheduler, result };
}

function validChange(personId, extra = {}) {
  return { id: 'abcdefabcdef', kind: 'move', personId, name: 'Bob', from: 2, to: 1, at: Date.now(),
    after: 'b'.repeat(64), native: 'a'.repeat(64),
    before: { manualOrder: [], manualOrderActive: false, reservedNext: null }, ...extra };
}

test('Sauvegarde : les photos sont écrites une seule fois à part, puis relues à la reprise', () => {
  const { sched, access, alice } = night();
  const photoDir = path.join(freshDir('photos'), 'photos');
  const expected = `${crypto.createHash('sha256').update(PNG).digest('hex')}.bin`;
  const snapshot = snapshotNight({ scheduler: sched, access, settings: settings(), photoDir });
  const saved = snapshot.scheduler.people.find(p => p.id === alice.id).photo;
  assert.deepEqual(saved, { type: 'image/png', file: expected }, 'la sauvegarde ne contient qu’une référence');
  assert.ok(!JSON.stringify(snapshot).includes(PNG.toString('base64')), 'pas d’image en base64 dans le JSON');
  assert.deepEqual(fs.readFileSync(path.join(photoDir, expected)), PNG);
  assert.deepEqual(fs.readdirSync(photoDir), [expected], 'aucun fichier temporaire laissé');
  assert.equal(snapshot.scheduler.people.find(p => p.id !== alice.id).photo, null);

  const opened = [];
  const openSync = fs.openSync;
  fs.openSync = (file, ...rest) => { opened.push(file); return openSync.call(fs, file, ...rest); };
  try {
    snapshotNight({ scheduler: sched, access, settings: settings(), photoDir });
  } finally { fs.openSync = openSync; }
  assert.deepEqual(opened, [], 'une photo déjà enregistrée n’est pas réécrite à chaque sauvegarde');

  const { scheduler } = restore(snapshot, { photoDir });
  const photo = scheduler.people.get(alice.id).photo;
  assert.equal(photo.type, 'image/png');
  assert.ok(Buffer.isBuffer(photo.buf));
  assert.deepEqual(photo.buf, PNG);
});

test('Sauvegarde : une photo abîmée ou absente est oubliée, la file est conservée', () => {
  const { sched, access, alice } = night();
  const photoDir = freshDir('photos-abimees');
  const snapshot = snapshotNight({ scheduler: sched, access, settings: settings(), photoDir });
  const file = path.join(photoDir, snapshot.scheduler.people.find(p => p.id === alice.id).photo.file);

  fs.writeFileSync(file, Buffer.from('autre image'));
  let restored = restore(snapshot, { photoDir }).scheduler;
  assert.equal(restored.people.get(alice.id).photo, null, 'empreinte différente : photo ignorée');
  assert.deepEqual(restored.Q, sched.Q, 'la file reste entière malgré la photo abîmée');

  fs.writeFileSync(file, Buffer.alloc(400 * 1024 + 1));
  restored = restore(snapshot, { photoDir }).scheduler;
  assert.equal(restored.people.get(alice.id).photo, null, 'fichier trop grand : photo ignorée');

  fs.rmSync(file);
  restored = restore(snapshot, { photoDir }).scheduler;
  assert.equal(restored.people.get(alice.id).photo, null, 'fichier disparu : photo ignorée');
  assert.equal(restored.people.get(alice.id).name, 'Alice');

  assertRefused(snapshot, 'référence photo mal formée');
  const traversal = structuredClone(snapshot);
  traversal.scheduler.people.find(p => p.id === alice.id).photo.file = '../../secret.bin';
  assertRefused(traversal, 'référence photo mal formée', { photoDir });
  const base64 = structuredClone(snapshot);
  base64.scheduler.people.find(p => p.id === alice.id).photo = { type: 'image/png', base64: 'pas du base64 !' };
  assertRefused(base64, 'photo mal formée');
});

test('Sauvegarde : une écriture de photo interrompue ne laisse aucun fichier temporaire', () => {
  const { sched, access } = night();
  const photoDir = freshDir('photos-coupure');
  for (const broken of ['renameSync', 'fsyncSync']) {
    const original = fs[broken];
    const closeSync = fs.closeSync;
    let closed = 0;
    fs[broken] = () => { throw Object.assign(new Error(`disque plein (${broken})`), { code: 'ENOSPC' }); };
    fs.closeSync = fd => { closed++; return closeSync.call(fs, fd); };
    try {
      assert.throws(() => snapshotNight({ scheduler: sched, access, settings: settings(), photoDir }),
        new RegExp(`disque plein \\(${broken}\\)`));
    } finally { fs[broken] = original; fs.closeSync = closeSync; }
    assert.equal(closed, 1, `${broken} : le fichier temporaire est fermé une seule fois`);
    assert.deepEqual(fs.readdirSync(photoDir), [], `${broken} : fichier temporaire supprimé`);
  }
  const snapshot = snapshotNight({ scheduler: sched, access, settings: settings(), photoDir });
  assert.equal(fs.readdirSync(photoDir).length, 1, 'l’essai suivant réussit');
  assert.ok(snapshot.scheduler.people.some(p => p.photo?.file));
});

test('Sauvegarde : une écriture interrompue garde le compteur et se réessaie', () => {
  const { sched, access } = night();
  const dir = freshDir('store-coupure');
  const store = new NightStateStore(path.join(dir, 'soiree'));
  const snapshot = snapshotNight({ scheduler: sched, access, settings: settings() });
  // Un dossier à la place de la génération visée fait échouer le renommage.
  fs.mkdirSync(store.slot(1));
  assert.throws(() => store.save(snapshot), error => ['EISDIR', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code));
  assert.equal(store.sequence, 0, 'la génération n’avance pas après un échec');
  assert.equal(store.lastDigest, null);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['soiree-b.json'], 'aucun fichier temporaire laissé');
  fs.rmdirSync(store.slot(1));
  assert.equal(store.save(snapshot), true, 'le même état est réécrit au prochain essai');
  assert.equal(new NightStateStore(path.join(dir, 'soiree')).load().scheduler.people.length, 2);
  assert.throws(() => new NightStateStore(''), /Chemin de sauvegarde manquant\./);
});

test('Reprise : passages physiques et compteur de passages abîmés sont refusés', () => {
  const { sched, access, alice } = night();
  const base = snapshotNight({ scheduler: sched, access, settings: settings() });
  for (const value of [-1, 2.5, '3']) {
    const snapshot = structuredClone(base);
    snapshot.scheduler.people.find(p => p.id === alice.id).lastAppearanceTurn = value;
    assertRefused(snapshot, 'passage physique mal formé');
  }
  const behind = structuredClone(base);
  behind.scheduler.people.find(p => p.id === alice.id).lastAppearanceTurn = 5;
  behind.scheduler.appearanceSerial = 2;
  assertRefused(behind, 'compteur des passages physiques mal formé');
  const negative = structuredClone(base);
  negative.scheduler.appearanceSerial = -1;
  assertRefused(negative, 'compteur des passages physiques mal formé');

  // Ancienne sauvegarde sans compteur : il repart du dernier passage connu.
  const legacy = structuredClone(base);
  legacy.scheduler.people.find(p => p.id === alice.id).lastAppearanceTurn = 4;
  delete legacy.scheduler.appearanceSerial;
  assert.equal(restore(legacy).scheduler.appearanceSerial, 4);

  const physical = structuredClone(base);
  physical.scheduler.roundPeoplePhysical = 'oui';
  assertRefused(physical, 'version du tour physique mal formée');
});

test('Reprise : changements manuels du bar abîmés', () => {
  const { sched, access, bob, alice } = night();
  const base = snapshotNight({ scheduler: sched, access, settings: settings() });
  const ok = structuredClone(base);
  ok.scheduler.manualChanges = [validChange(bob.id)];
  assert.equal(restore(ok).scheduler.manualChanges.length, 1, 'un changement valide est restauré');

  const broken = [
    { kind: 'swap' }, { id: 'XYZ' }, { personId: 'inconnu' }, { name: '' }, { from: 0 }, { to: 1.5 },
    { at: 'hier' }, { after: 'court' }, { native: null },
    { before: { manualOrder: ['inconnu'], manualOrderActive: false, reservedNext: null } },
    { before: { manualOrder: [], manualOrderActive: 'non', reservedNext: null } },
    { before: { manualOrder: [], manualOrderActive: false, reservedNext: { personId: 'inconnu', reservedAt: 1 } } },
    { before: { manualOrder: [], manualOrderActive: false } },
  ];
  for (const change of broken) {
    const snapshot = structuredClone(base);
    snapshot.scheduler.manualChanges = [validChange(bob.id, change)];
    assertRefused(snapshot, 'changement manuel mal formé');
  }

  // Reports « Pas prêt » mémorisés dans l'annulation : abîmés, ils sont oubliés.
  const deferral = { entryId: 'e1', remaining: 1, total: 1, until: Date.now() + 60000, ids: [alice.id] };
  assert.ok(DEFER_MAX >= 1);
  const kept = structuredClone(base);
  kept.scheduler.manualChanges = [validChange(bob.id, { before: { manualOrder: [], manualOrderActive: false,
    reservedNext: null, deferrals: [[alice.id, deferral]] } })];
  assert.deepEqual(restore(kept).scheduler.manualChanges[0].before.deferrals, [[alice.id, deferral]]);
  for (const deferrals of ['abîmé', [[alice.id, { ...deferral, total: DEFER_MAX + 1 }]], [[alice.id]]]) {
    const snapshot = structuredClone(base);
    snapshot.scheduler.manualChanges = [validChange(bob.id, { before: { manualOrder: [], manualOrderActive: false,
      reservedNext: null, deferrals } })];
    const { scheduler } = restore(snapshot);
    assert.equal(scheduler.manualChanges.length, 1, 'l’annulation reste possible');
    assert.ok(!('deferrals' in scheduler.manualChanges[0].before), 'reports abîmés oubliés');
  }
});

test('Reprise : bonus des tables, crédits de tour, historique de scène et liens de transfert', () => {
  const { sched, access, alice, bob } = night();
  const base = snapshotNight({ scheduler: sched, access, settings: settings() });

  const bonus = structuredClone(base);
  bonus.scheduler.tables[0].bonus = -2;
  assert.equal(restore(bonus).scheduler.tables.get('1').bonus, -2);
  for (const value of [4, -4, 1.5, 'plus']) {
    const snapshot = structuredClone(base);
    snapshot.scheduler.tables[0].bonus = value;
    assertRefused(snapshot, 'bonus de table mal formé');
  }

  const rows = structuredClone(base);
  rows.scheduler.roundUse = [[alice.id, 1.5], ['inconnu', 1], [bob.id, 11], [bob.id, -1], 'abîmé'];
  rows.scheduler.stageHistory = [
    ...Array.from({ length: 70 }, (_, i) => ({ ids: [alice.id], at: i })),
    { ids: 'abîmé', at: 1 }, null, { ids: [bob.id] }, { ids: [bob.id], at: 999 },
  ];
  const restored = restore(rows).scheduler;
  assert.deepEqual([...restored.roundUse], [[alice.id, 1.5]], 'seuls les crédits plausibles sont gardés');
  assert.equal(restored.stageHistory.length, 60, 'historique de scène limité aux 60 derniers passages');
  assert.deepEqual(restored.stageHistory.at(-1), { ids: [bob.id], at: 999 });
  assert.ok(restored.stageHistory.every(item => Array.isArray(item.ids) && Number.isFinite(item.at)));

  const hash = 'c'.repeat(64);
  const valid = { personId: alice.id, hash, linkHash: null, expiresAt: Date.now() + 60000,
    linkExpiresAt: Date.now() - 1000, attempts: 0 };
  const transfers = structuredClone(base);
  transfers.transfers = [
    valid,
    { ...valid, personId: bob.id, linkHash: 'd'.repeat(64), expiresAt: Date.now() - 1000, linkExpiresAt: Date.now() + 60000, attempts: 5 },
    { ...valid, expiresAt: Date.now() - 2000, linkExpiresAt: Date.now() - 1000 },
    { ...valid, personId: 'inconnu' },
    { ...valid, hash: 'C'.repeat(64) },
    { ...valid, linkHash: 'court' },
    { ...valid, attempts: 6 },
    { ...valid, attempts: -1 },
    { ...valid, expiresAt: 'demain' },
    null, 'abîmé',
  ];
  const { result } = restore(transfers);
  assert.deepEqual(result.transfers.map(row => row.personId), [alice.id, bob.id],
    'seuls les liens encore valables et bien formés survivent au redémarrage');
});

test('Reprise : prochain passage garanti, réglages, envoi en cours et titres KaraFun abîmés', () => {
  const { sched, access, alice, bob } = night();
  const base = snapshotNight({ scheduler: sched, access, settings: settings() });

  const reserved = structuredClone(base);
  reserved.scheduler.reservedNext = { personId: bob.id, reservedAt: 1234 };
  assert.deepEqual(restore(reserved).scheduler.reservedNext, { personId: bob.id, reservedAt: 1234 });
  for (const value of [{ personId: 'inconnu', reservedAt: 1 }, { personId: bob.id }, 'Bob']) {
    const snapshot = structuredClone(base);
    snapshot.scheduler.reservedNext = value;
    assertRefused(snapshot, typeof value === 'string' ? 'prochain passage garanti' : 'prochain passage garanti mal formé');
  }
  const undoReserved = structuredClone(base);
  undoReserved.scheduler.manualChanges = [validChange(bob.id, { before: { manualOrder: [bob.id],
    manualOrderActive: true, reservedNext: { personId: alice.id, reservedAt: 99 } } })];
  assert.deepEqual(restore(undoReserved).scheduler.manualChanges[0].before.reservedNext,
    { personId: alice.id, reservedAt: 99 }, 'l’annulation rendra aussi le passage garanti');

  for (const [field, value] of [['auto', 'oui'], ['pushDelaySec', 181], ['playDelaySec', -1],
    ['repeatWarnMin', 241], ['presenceGraceSec', 9], ['presenceMaxSkips', 11],
    ['closingAt', 'minuit'], ['autoPlayHeld', 1]]) {
    const snapshot = structuredClone(base);
    snapshot.settings[field] = value;
    assertRefused(snapshot, 'réglages mal formés');
  }
  const closing = structuredClone(base);
  Object.assign(closing.settings, { repeatWarnMin: 30, presenceGraceSec: 60, presenceMaxSkips: 2,
    closingAt: Date.UTC(2026, 9, 3, 1, 0), autoPlayHeld: true });
  const restoredSettings = settings();
  restoreNight(closing, { scheduler: new Scheduler(), access: new TableAccess(), settings: restoredSettings });
  assert.equal(restoredSettings.closingAt, Date.UTC(2026, 9, 3, 1, 0), 'l’heure de fermeture survit au redémarrage');
  assert.equal(restoredSettings.autoPlayHeld, true);

  const sel = { ids: [alice.id], song: { entryId: 'e1', songId: 101, title: 'Première' }, label: 'Alice' };
  for (const pending of [{ sel, before: [], at: 1, attempts: 0 }, { sel, before: 'abîmé', at: 1, attempts: 1 },
    { sel: { ...sel, song: null }, before: [], at: 1, attempts: 1 }, { sel, before: [], at: 'hier', attempts: 1 }]) {
    const snapshot = structuredClone(base);
    snapshot.pending = pending;
    assertRefused(snapshot, 'envoi en cours mal formé');
  }
  for (const tracked of [[{ sel }], [null], [{ queueId: 4, sel: { ...sel, ids: [] } }]]) {
    const snapshot = structuredClone(base);
    snapshot.tracked = tracked;
    assertRefused(snapshot, 'titre KaraFun mal formé');
  }

  const rows = structuredClone(base);
  rows.scheduler.roundApps = [[alice.id, 2], [bob.id, 0], [bob.id, 21], ['inconnu', 1], [alice.id, 1.5]];
  rows.scheduler.playedSongs = [{ at: 1, title: 'Première' }, { at: 'hier', title: 'X' }, { at: 2, title: '' }, null];
  const restored = restore(rows).scheduler;
  assert.deepEqual([...restored.roundApps], [[alice.id, 2]]);
  assert.deepEqual(restored.playedSongs, [{ at: 1, title: 'Première' }],
    'seuls les titres chantés bien formés servent à l’alerte de répétition');
});
