'use strict';
// Exploitation (issue #26), dans les deux modes : sondes GET/HEAD /healthz et
// GET /readyz, arrêt par stopHelper(raison) et arrêt d'ARRETER.bat.
//
// Même harnais que solo-access-routes.test.js : server.js chargé dans un bac
// à sable `vm`, sans port, disque en mémoire, faux magasin de soirée. Le faux
// processus note chaque process.exit dans `exits` au lieu de sortir. Les
// vrais signaux sont envoyés à un vrai serveur par night-restart-api.test.js
// (N1) ; la démo de run-offline.js est sondée par sondes-demo.test.js (P1).
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Clé du bar du harnais `server: true` : tirée à chaque exécution, jamais affichée.
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-sondes-'));
after(() => fs.rmSync(keyDir, { recursive: true, force: true }));
const KEY_FILE = path.join(keyDir, 'staff-key');
fs.writeFileSync(KEY_FILE, crypto.randomBytes(16).toString('base64url') + '\n', { mode: 0o600 });
const withoutKaraoke = env => Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('KARAOKE_')));

const TEXT = 'text/plain; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const READY_PC = '{"ok":true,"mode":"pc","karafun":"connected","solver":"off","persistence":"off"}';

function memoryDisk() {
  const disk = new Map();
  const inMemory = file => [path.join(root, 'data'), path.join(root, 'journal')]
    .some(dir => file === dir || String(file).startsWith(dir + path.sep));
  const missing = file => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  const memFs = { ...fs,
    existsSync: file => inMemory(file) ? disk.has(file) : fs.existsSync(file),
    readFileSync(file, ...rest) {
      if (!inMemory(file)) return fs.readFileSync(file, ...rest);
      if (!disk.has(file)) throw missing(file);
      return disk.get(file);
    },
    writeFileSync(file, data) { disk.set(file, String(data)); },
    appendFileSync(file, data) { disk.set(file, (disk.get(file) || '') + data); },
    renameSync(from, to) { if (!disk.has(from)) throw missing(from); disk.set(to, disk.get(from)); disk.delete(from); },
    unlinkSync(file) { disk.delete(file); },
    mkdirSync() {}, readdirSync() { return []; } };
  return { disk, memFs };
}

function fakeNightStore() {
  const control = { saves: [], fail: null };
  class Store {
    load() { return null; }
    save(snapshot) {
      if (control.fail) throw new Error(control.fail);
      control.saves.push(JSON.parse(JSON.stringify(snapshot)));
      return true;
    }
  }
  return { control, Store };
}

// `persistent` : serveur réel (sans --demo), faux magasin de soirée, sans Java.
// `server` : --server et les adresses HTTPS d'essai (clé dans KEY_FILE).
// Aucune variable KARAOKE_* héritée dans les deux cas.
function harness({ persistent = false, server = false } = {}) {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const memory = memoryDisk();
  const night = fakeNightStore();
  const overrides = persistent ? {
    './night-state': { ...fromServer('./night-state'), NightStateStore: night.Store },
    './scheduler': (() => {
      const real = fromServer('./scheduler');
      return { ...real, Scheduler: class extends real.Scheduler { constructor(o) { super({ ...o, solverEnabled: false }); } } };
    })(),
    './spotify': (() => {
      const real = fromServer('./spotify');
      return { ...real, SpotifyLink: class extends real.SpotifyLink { constructor(o) { super({ ...o, file: null }); } } };
    })(),
  } : {};
  const exits = [];
  const lines = [];
  const fixtureProcess = Object.create(process);
  fixtureProcess.env = { ...withoutKaraoke(process.env), ...(server ? { KARAOKE_PUBLIC_URL: 'https://clients.exemple.fr',
    KARAOKE_STAFF_URL: 'https://bar.exemple.fr', KARAOKE_STAFF_KEY_FILE: KEY_FILE } : {}) };
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), ...(persistent ? [] : ['--demo']),
    ...(server ? ['--server'] : [])];
  fixtureProcess.exit = code => { exits.push({ code, at: Date.now() }); };
  const context = { require: name => name === 'fs' ? memory.memFs : overrides[name] || fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log(line) { lines.push(String(line)); } }, Buffer, URL,
    setTimeout, clearTimeout, setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, journal, saveNight, STAFF_KEY, STOP_KEY, PORT, PUBLIC_PORT,
      handle: server.listeners('request')[0], stopHelper, readiness,
      setBridge: value => { bridge = value; }, setCode: value => { CODE = value; } };
  `, context, { filename: 'server.js' });
  assert.deepEqual(exits, [], 'le bac à sable démarre sans process.exit');
  const f = context.fixture;
  f.journal.start({});
  return Object.assign(f, { night: night.control, memory, exits, lines });
}

function call(f, method, url, { body, headers = {}, port = f.PORT, remote = '127.0.0.1' } = {}) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers, socket: { remoteAddress: remote, localPort: port }, destroy() {} });
    const out = { status: null, headers: {} };
    const res = {
      setHeader(name, value) { out.headers[name.toLowerCase()] = value; },
      getHeader(name) { return out.headers[name.toLowerCase()]; },
      hasHeader(name) { return name.toLowerCase() in out.headers; },
      removeHeader(name) { delete out.headers[name.toLowerCase()]; },
      writeHead(status, headers = {}) {
        out.status = status;
        for (const [name, value] of Object.entries(headers)) out.headers[name.toLowerCase()] = value;
      },
      end(data = '') {
        out.text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        out.body = out.text && /json/.test(out.headers['content-type'] || '') ? JSON.parse(out.text) : out.text;
        resolve(out);
      },
    };
    f.handle(req, res);
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  });
}
const events = (f, type) => f.journal.current.events.filter(e => e.ev === type);
const serverLog = f => [...f.memory.disk].filter(([file]) => path.basename(file).startsWith('serveur-'))
  .map(([, text]) => text).join('');
const readyz = (f, options) => call(f, 'GET', '/readyz', options);
// Faux pont KaraFun : seules `ready` et la phase comptent pour /readyz.
const fakeBridge = (ready, phase = ready ? 'ready' : 'idle') => ({ ready, connectionState: () => ({ phase, label: 'non lu' }) });

test('H1 /healthz : 200 « ok » en GET et HEAD, sur les deux ports, depuis toute adresse', async () => {
  for (const f of [harness(), harness({ server: true })]) {
    for (const port of [f.PORT, f.PUBLIC_PORT]) {
      for (const remote of ['127.0.0.1', '203.0.113.7']) {
        const where = `port ${port}, adresse ${remote}`;
        const r = await call(f, 'GET', '/healthz', { port, remote });
        assert.equal(r.status, 200, where);
        assert.equal(r.text, 'ok', where);
        assert.equal(r.headers['content-type'], TEXT, where);
        assert.equal(r.headers['cache-control'], 'no-store', where);
        const head = await call(f, 'HEAD', '/healthz', { port, remote });
        assert.equal(head.status, 200, `HEAD ${where}`);
        assert.equal(head.headers['content-type'], TEXT, `HEAD ${where}`);
      }
    }
  }
});

test('H2 /readyz démo : faux pont prêt, 200 et JSON exact, clés dans l’ordre', async () => {
  const f = harness();
  f.setBridge(fakeBridge(true));
  const r = await readyz(f);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], JSON_TYPE);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.text, READY_PC);
  assert.deepEqual(Object.keys(r.body), ['ok', 'mode', 'karafun', 'solver', 'persistence']);
  // Objet du bac à sable (autre royaume) : comparé par sa forme JSON.
  assert.equal(JSON.stringify(f.readiness()), READY_PC);
  // HEAD n'est pas une sonde de disponibilité : méthode non gérée, comme avant.
  assert.equal((await call(f, 'HEAD', '/readyz')).status, 405);
});

test('H3 /readyz KaraFun : sans pont no-code, phases rangées, prêt = connected', async () => {
  const f = harness();
  let r = await readyz(f);
  assert.equal(r.status, 503);
  assert.equal(r.body.karafun, 'no-code');
  assert.equal(r.body.ok, false);
  for (const phase of ['discovering', 'opening', 'waiting-auth', 'waiting-name', 'waiting-data', 'ready']) {
    f.setBridge(fakeBridge(false, phase));
    r = await readyz(f);
    assert.equal(r.body.karafun, 'connecting', phase);
    assert.equal(r.body.ok, false, phase);
    assert.equal(r.status, 503, phase);
  }
  for (const phase of ['retry', 'stopped', 'idle']) {
    f.setBridge(fakeBridge(false, phase));
    r = await readyz(f);
    assert.equal(r.body.karafun, phase);
    assert.equal(r.body.ok, false, phase);
    assert.equal(r.status, 503, phase);
  }
  // Données reçues pendant que la phase n'a pas encore suivi : `ready` décide.
  f.setBridge(fakeBridge(true, 'waiting-name'));
  r = await readyz(f);
  assert.equal(r.body.karafun, 'connected');
  assert.equal(r.body.ok, true);
  assert.equal(r.status, 200);
});

test('H4 /readyz solveur : lu sans demander de calcul, sans effet sur ok', async () => {
  const f = harness();
  f.setBridge(fakeBridge(true));
  let asked = 0;
  f.sched._maybeRequestSolver = () => { asked++; return false; };
  const cases = [[null, 'off'], [{ available: true }, 'available'], [{ available: false }, 'unavailable']];
  for (const [solverBridge, expected] of cases) {
    f.sched.solverBridge = solverBridge;
    const r = await readyz(f);
    assert.equal(r.body.solver, expected);
    assert.equal(r.body.ok, true, `solveur ${expected} : la rotation locale prend le relais`);
    assert.equal(r.status, 200);
  }
  f.readiness();
  f.readiness();
  assert.equal(asked, 0, 'cinq lectures sans aucune demande de plan');
});

test('H5 /readyz sauvegarde : panne signalée sans son message, puis rétablie', async () => {
  const f = harness({ persistent: true });
  f.setBridge(fakeBridge(true));
  assert.equal(f.saveNight(), true);
  let r = await readyz(f);
  assert.equal(r.body.persistence, 'ok');
  assert.equal(r.body.ok, true);
  assert.equal(r.status, 200);
  f.night.fail = 'Disque plein';
  assert.equal(f.saveNight(), false);
  r = await readyz(f);
  assert.equal(r.body.persistence, 'error');
  assert.equal(r.body.ok, false);
  assert.equal(r.status, 503);
  assert.ok(!r.text.includes('Disque plein'), 'le texte de l’erreur ne sort pas');
  f.night.fail = null;
  assert.equal(f.saveNight(), true);
  r = await readyz(f);
  assert.equal(r.body.persistence, 'ok');
  assert.equal(r.body.ok, true);
  assert.equal(r.status, 200);
});

test('H6 /readyz sans secret : 404 sur le port clients, ni clé, code, prénom ni table', async () => {
  for (const f of [harness(), harness({ persistent: true })]) {
    const pub = await readyz(f, { port: f.PUBLIC_PORT });
    assert.equal(pub.status, 404);
    assert.equal(pub.text, 'Introuvable');
    assert.equal(pub.headers['content-type'], TEXT);
    f.setCode('654321');
    f.sched.table('Table-Essai').headcount = 2;
    f.sched.join({ tableId: 'Table-Essai', name: 'Chanteuse-Essai', headcount: 2 });
    for (const bridge of [null, fakeBridge(false, 'retry'), fakeBridge(true)]) {
      f.setBridge(bridge);
      for (const remote of ['127.0.0.1', '203.0.113.7']) {
        const r = await readyz(f, { remote });
        for (const secret of [f.STAFF_KEY, '654321', 'Chanteuse-Essai', 'Table-Essai']) {
          assert.ok(!r.text.includes(secret), `réponse sans ${secret === f.STAFF_KEY ? 'la clé du bar' : secret}`);
        }
      }
    }
  }
});

test('H7 /readyz mode : server avec --server, pc sans réglage', async () => {
  const server = harness({ server: true });
  server.setBridge(fakeBridge(true));
  const r = await readyz(server);
  assert.equal(r.body.mode, 'server');
  assert.equal(r.text, '{"ok":true,"mode":"server","karafun":"connected","solver":"off","persistence":"off"}');
  const pc = harness();
  pc.setBridge(fakeBridge(true));
  assert.equal((await readyz(pc)).body.mode, 'pc');
});

test('H8 stopHelper(raison) : un seul app.stopped, message du signal, pont fermé, sortie 0', async () => {
  const f = harness();
  const calls = [];
  f.setBridge({ ready: true, disconnect: () => calls.push('disconnect'), releaseIdentity: () => calls.push('releaseIdentity') });
  const start = Date.now();
  f.stopHelper('SIGTERM');
  f.stopHelper('SIGINT');
  const stopped = events(f, 'app.stopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].reason, 'SIGTERM');
  assert.ok(f.lines.includes('Arrêt de la file karaoké (signal SIGTERM).'), f.lines.join('\n'));
  assert.ok(serverLog(f).includes(' Arrêt de la file karaoké (signal SIGTERM).\n'), 'ligne écrite au journal du serveur');
  assert.ok(!f.lines.some(line => line.includes('SIGINT')), 'le second appel n’écrit rien');
  assert.deepEqual(calls, ['disconnect', 'releaseIdentity']);
  await sleep(1600);
  assert.equal(f.exits.length, 1, 'un seul process.exit');
  assert.equal(f.exits[0].code, 0);
  const delay = f.exits[0].at - start;
  // gstack-timing-ok: sortie prévue à 500 ms ; 1 500 ms laissent une machine chargée tenir, une sortie immédiate (< 450) échoue.
  assert.ok(delay >= 450 && delay <= 1500, `sortie après ${delay} ms`);
  assert.equal(events(f, 'app.stopped').length, 1, 'le second signal n’ajoute rien');

  const bar = harness();
  bar.stopHelper();
  const byBar = events(bar, 'app.stopped');
  assert.equal(byBar.length, 1);
  assert.equal(byBar[0].reason, 'stop');
  assert.ok(bar.lines.includes('Arrêt de la file karaoké demandé par le bar.'), bar.lines.join('\n'));
  assert.ok(!bar.lines.some(line => line.includes('(signal')));
});

test('H9 ARRETER.bat : réponse d’abord, puis un seul app.stopped « stop » après 150 ms', async () => {
  const f = harness();
  const start = Date.now();
  const r = await call(f, 'POST', '/internal/shutdown', { headers: { 'x-helper-stop': f.STOP_KEY } });
  assert.equal(r.status, 200);
  assert.equal(r.text, '{"ok":true}');
  // Relevé fait avant tout minuteur : la réponse part avant l'arrêt.
  assert.equal(events(f, 'app.stopped').length, 0, 'rien avant la réponse');
  assert.deepEqual(f.exits, []);
  await sleep(400);
  const stopped = events(f, 'app.stopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].reason, 'stop');
  // gstack-timing-ok: minuteur de 150 ms, qui ne part jamais plus tôt ; un arrêt immédiat serait noté avant 145 ms.
  assert.ok(stopped[0].t - start >= 145, `arrêt noté ${stopped[0].t - start} ms après la demande`);
  assert.ok(f.lines.includes('Arrêt de la file karaoké demandé par le bar.'));
});
