'use strict';
// Mode serveur, socle (issue #24) : configuration lue dans l'environnement,
// clé du bar persistante, boucle locale sans droit, adresses HTTPS des QR et
// lignes de démarrage.
//
// Même harnais que server-table-routes.test.js : server.js chargé dans un bac
// à sable `vm` sans écouter de port, disque en mémoire pour data/ et journal/.
// Le mode serveur y est activé par l'environnement du faux processus ;
// `harness({ serverEnv: false })` est le harnais du mode PC (aucune variable
// KARAOKE_*, pas de --server). Les vrais processus sont dans
// server-mode-startup.test.js.
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
const DATA = path.join(root, 'data');
const STAFF_KEY_FILE_IN_DATA = path.join(DATA, 'staff-key');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const plain = value => JSON.parse(JSON.stringify(value));

// Clé du bar fournie par fichier : tirée à chaque exécution, jamais affichée.
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-server-mode-'));
after(() => fs.rmSync(keyDir, { recursive: true, force: true }));
const KEY_FILE = path.join(keyDir, 'staff-key');
const FILE_KEY = crypto.randomBytes(24).toString('base64url');
fs.writeFileSync(KEY_FILE, `${FILE_KEY}\n`, { mode: 0o600 });

const DEFAULT_PROXIES = '127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7';
const SERVER_ENV = { KARAOKE_MODE: 'server', KARAOKE_PUBLIC_URL: 'https://clients.exemple.fr',
  KARAOKE_STAFF_URL: 'https://bar.exemple.fr', KARAOKE_CLIENT_IP_HEADER: 'x-real-ip', KARAOKE_STAFF_KEY_FILE: KEY_FILE };
const withoutKaraoke = env => Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('KARAOKE_')));

// ---------------------------------------------------------------- harnais
// Disque en mémoire pour data/ et journal/ ; le reste (pages, package.json,
// fichier de clé du test) est lu sur le vrai disque, jamais écrit.
// `writes` : écritures faites, dans l'ordre ; une écriture `flag: 'wx'` sur un
// fichier présent lève EEXIST. `mkdirs` : dossiers demandés. `beforeWrite` :
// crochet appelé au début de chaque écriture (course simulée, panne).
function memoryDisk(files = {}) {
  const disk = new Map(Object.entries(files).map(([rel, value]) =>
    [path.join(root, rel), typeof value === 'string' ? value : JSON.stringify(value)]));
  const inMemory = file => [DATA, path.join(root, 'journal')]
    .some(dir => file === dir || String(file).startsWith(dir + path.sep));
  const missing = file => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  const memory = { disk, writes: [], mkdirs: [], beforeWrite: null };
  let order = 0;
  memory.memFs = { ...fs,
    existsSync: file => inMemory(file) ? disk.has(file) : fs.existsSync(file),
    readFileSync(file, ...rest) {
      if (!inMemory(file)) return fs.readFileSync(file, ...rest);
      if (!disk.has(file)) throw missing(file);
      return disk.get(file);
    },
    writeFileSync(file, data, options) {
      if (memory.beforeWrite) memory.beforeWrite(file, options);
      if (options?.flag === 'wx' && disk.has(file)) throw Object.assign(new Error(`EEXIST: ${file}`), { code: 'EEXIST' });
      memory.writes.push({ file, data: String(data), options, order: ++order });
      disk.set(file, String(data));
    },
    appendFileSync(file, data) { disk.set(file, (disk.get(file) || '') + data); },
    renameSync(from, to) { if (!disk.has(from)) throw missing(from); disk.set(to, disk.get(from)); disk.delete(from); },
    unlinkSync(file) { disk.delete(file); },
    mkdirSync(dir, options) { memory.mkdirs.push({ dir, options, order: ++order }); },
    readdirSync() { return []; } };
  memory.read = rel => disk.get(path.join(root, rel));
  return memory;
}

function fakeNightStore() {
  const control = { saves: [] };
  class Store {
    load() { return null; }
    save(snapshot) { control.saves.push(JSON.parse(JSON.stringify(snapshot))); return true; }
  }
  return { control, Store };
}

// `persistent` : serveur réel (sans --demo), disque en mémoire, faux magasin de
// soirée, ni Java ni jeton Spotify. `serverEnv` : variables du mode serveur du
// harnais, puis `env` (undefined retire). `modules` : modules remplacés
// (qrcode, pour lire la cible d'un QR). `args` : options ajoutées à argv.
function harness({ persistent = false, files = {}, modules = {}, serverEnv = true, env = {}, args = [] } = {}) {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const memory = memoryDisk(files);
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
  Object.assign(overrides, modules);
  const fixtureEnv = { ...withoutKaraoke(process.env), ...(serverEnv ? SERVER_ENV : {}) };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete fixtureEnv[name];
    else fixtureEnv[name] = value;
  }
  const fixtureProcess = Object.create(process);
  fixtureProcess.env = fixtureEnv;
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), ...(persistent ? [] : ['--demo']), ...args];
  fixtureProcess.exit = code => { throw new Error(`process.exit(${code}) pendant le chargement du bac à sable`); };
  const context = { require: name => name === 'fs' ? memory.memFs : overrides[name] || fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL, setTimeout, clearTimeout,
    setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, access, soloInvitations, privateEvent, battleVote, staffState, journal,
      ensureSoloGroup, clearEvening, battleElectorate, saveNight, journalRoster, journalSample, publicState, transferSnapshot, personShareCodes,
      STAFF_KEY, PORT, PUBLIC_PORT, handle: server.listeners('request')[0], setTracked: value => { tracked = value; },
      setPending: value => { pending = value; },
      spotify, loadTables, normalizeBaseUrl, SERVER, STAFF_KEY_INFO, STOP_KEY, server, publicServer,
      isShuttingDown: () => shuttingDown, readServerConfig, loadStaffKey, staffKeyFingerprint, serverStartupLines,
      phoneBase, BUILD };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  f.journal.start({});
  return Object.assign(f, { memory, night: night.control });
}

// Une requête HTTP passée directement au gestionnaire du serveur.
function call(f, method, url, { body, cookie, headers = {}, remote = '127.0.0.1', port = f.PORT } = {}) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers: { ...headers, ...(cookie ? { cookie } : {}) },
      socket: { remoteAddress: remote, localPort: port }, destroy() {} });
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
const get = (f, url, options = {}) => call(f, 'GET', url, options);
const post = (f, url, body, options = {}) => call(f, 'POST', url, { ...options, body });
const withKey = (route, key) => `${route}${route.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
const LOOPBACKS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const raised = fn => { try { fn(); } catch (error) { return error; } assert.fail('une erreur était attendue'); };

// ---------------------------------------------------------------- 1. boucle locale sans droit
test('T1 GET / sans Location : la boucle locale ne reçoit pas la clé du bar', async () => {
  const f = harness();
  assert.ok(f.SERVER, 'mode serveur actif dans le harnais');
  for (const port of [f.PORT, f.PUBLIC_PORT]) {
    for (const remote of LOOPBACKS) {
      const where = `${remote} sur ${port === f.PORT ? 'PORT' : 'PUBLIC_PORT'}`;
      const r = await get(f, '/', { remote, port });
      assert.equal(r.status, 403, where);
      assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8', where);
      assert.equal(r.text, 'Scanne le QR code de ta table.', where);
      assert.equal('location' in r.headers, false, `${where} : aucun en-tête location`);
      assert.equal(r.text.includes(f.STAFF_KEY), false, where);
    }
  }
  // Témoin : le harnais PC redirige toujours le PC du bar vers sa page.
  const pc = harness({ serverEnv: false });
  assert.equal(pc.SERVER, null);
  const home = await get(pc, '/', { remote: '127.0.0.1', port: pc.PORT });
  assert.equal(home.status, 302);
  assert.equal(home.headers.location, `/staff?key=${pc.STAFF_KEY}`);
});

test('T2 arrêt interne 404 : même le secret de data/runtime-<port>.json n’arrête rien', async () => {
  const f = harness();
  const r = await post(f, '/internal/shutdown', undefined,
    { remote: '127.0.0.1', port: f.PORT, headers: { 'x-helper-stop': f.STOP_KEY } });
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: 'Introuvable' });
  await sleep(500);
  assert.equal(f.isShuttingDown(), false, 'aucun arrêt programmé');
});

test('T3 retour Spotify refusé à la boucle locale, sans finishAuth', async () => {
  const f = harness();
  let finished = 0;
  f.spotify.finishAuth = async () => { finished += 1; };
  for (const remote of LOOPBACKS) {
    const r = await get(f, '/spotify/callback?code=abc&state=def', { remote, port: f.PORT });
    assert.equal(r.status, 403, remote);
    assert.equal(r.text, 'Connecte Spotify depuis le PC du bar.', remote);
    assert.equal(r.text.includes('/staff'), false, `${remote} : aucun lien de retour`);
  }
  assert.equal(finished, 0, 'finishAuth jamais appelé');
  // Témoin : en mode PC, le même retour depuis ce PC finit la connexion.
  const pc = harness({ serverEnv: false });
  let pcFinished = 0;
  pc.spotify.finishAuth = async () => { pcFinished += 1; };
  const done = await get(pc, '/spotify/callback?code=abc&state=def', { remote: '127.0.0.1', port: pc.PORT });
  assert.equal(done.status, 200);
  assert.equal(pcFinished, 1);
});

// ---------------------------------------------------------------- 2. clé persistante
test('T4 clé du fichier KARAOKE_STAFF_KEY_FILE, rien dans data/', async () => {
  for (const persistent of [false, true]) {
    const f = harness({ persistent });
    const label = persistent ? 'sans --demo' : '--demo';
    assert.equal(f.STAFF_KEY, FILE_KEY, `${label} : clé lue dans le fichier`);
    assert.equal(f.STAFF_KEY_INFO.source, 'KARAOKE_STAFF_KEY_FILE');
    assert.equal((await get(f, withKey('/api/staff/state', FILE_KEY), { port: f.PORT })).status, 200, label);
    assert.equal((await get(f, '/api/staff/state', { port: f.PORT })).status, 403, `${label} : sans clé`);
    assert.equal((await get(f, withKey('/api/staff/state', FILE_KEY), { port: f.PUBLIC_PORT })).status, 403,
      `${label} : clé sur le port clients`);
    assert.equal(f.memory.disk.has(STAFF_KEY_FILE_IN_DATA), false, `${label} : data/staff-key absent`);
    assert.equal(f.memory.writes.some(w => w.file === STAFF_KEY_FILE_IN_DATA), false, `${label} : data/staff-key jamais écrit`);
  }
});

test('T5 data/staff-key créée une fois (0600, wx) puis réutilisée ; course au démarrage', () => {
  const f = harness();
  const config = { ...f.SERVER, staffKeyFile: null };
  const before = { writes: f.memory.writes.length, mkdirs: f.memory.mkdirs.length };
  const first = f.loadStaffKey(config, DATA);
  const mkdirs = f.memory.mkdirs.slice(before.mkdirs);
  const writes = f.memory.writes.slice(before.writes);
  assert.equal(mkdirs.length, 1);
  assert.equal(mkdirs[0].dir, DATA);
  assert.deepEqual(plain(mkdirs[0].options), { recursive: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].file, STAFF_KEY_FILE_IN_DATA);
  assert.match(writes[0].data, /^[A-Za-z0-9_-]{22}\n$/);
  assert.deepEqual(plain(writes[0].options), { mode: 0o600, flag: 'wx' });
  assert.ok(mkdirs[0].order < writes[0].order, 'dossier créé avant le fichier');
  assert.equal(first.key, writes[0].data.trim());
  assert.equal(first.source, 'data/staff-key, créée à ce démarrage');

  const second = f.loadStaffKey(config, DATA);
  assert.equal(second.key, first.key, 'même clé au démarrage suivant');
  assert.equal(second.source, 'data/staff-key');
  assert.equal(f.memory.writes.length, before.writes + 1, 'aucune écriture de plus');
  assert.equal(f.memory.disk.get(STAFF_KEY_FILE_IN_DATA), `${first.key}\n`, 'fichier jamais réécrit');

  // Deux démarrages simultanés : l'autre a écrit sa clé juste avant nous.
  const g = harness();
  const theirs = crypto.randomBytes(18).toString('base64url');
  const attempts = [];
  g.memory.beforeWrite = (file, options) => {
    attempts.push({ file, options: plain(options) });
    if (file === STAFF_KEY_FILE_IN_DATA) g.memory.disk.set(file, `${theirs}\n`);
  };
  const raced = g.loadStaffKey({ ...g.SERVER, staffKeyFile: null }, DATA);
  assert.deepEqual(attempts, [{ file: STAFF_KEY_FILE_IN_DATA, options: { mode: 0o600, flag: 'wx' } }], 'écriture tentée en wx');
  assert.equal(raced.key, theirs, 'EEXIST : la clé déjà écrite est relue');
  assert.equal(raced.source, 'data/staff-key');
  assert.equal(g.memory.disk.get(STAFF_KEY_FILE_IN_DATA), `${theirs}\n`, 'clé de l’autre démarrage gardée');
  assert.equal(g.memory.writes.some(w => w.file === STAFF_KEY_FILE_IN_DATA), false);

  // Le harnais sans KARAOKE_STAFF_KEY_FILE charge data/staff-key au démarrage.
  const h = harness({ env: { KARAOKE_STAFF_KEY_FILE: undefined } });
  assert.equal(h.STAFF_KEY_INFO.source, 'data/staff-key, créée à ce démarrage');
  assert.equal(h.memory.disk.get(STAFF_KEY_FILE_IN_DATA), `${h.STAFF_KEY}\n`);
});

test('T6 clés refusées : raison exacte, aucune clé de remplacement, contenu jamais cité', () => {
  const f = harness();
  const nothingCreated = (g, label) => {
    assert.equal(g.memory.writes.some(w => w.file === STAFF_KEY_FILE_IN_DATA), false, `${label} : aucune clé créée`);
  };
  const short = path.join(keyDir, 'courte');
  const shortKey = crypto.randomBytes(16).toString('base64url').slice(0, 21);
  fs.writeFileSync(short, `${shortKey}\n`);
  const tooShort = raised(() => f.loadStaffKey({ ...f.SERVER, staffKeyFile: short }, DATA));
  assert.equal(tooShort.message, 'La clé de KARAOKE_STAFF_KEY_FILE doit compter au moins 22 caractères parmi A-Z, a-z, 0-9, - et _.');
  assert.equal(tooShort.message.includes(shortKey), false);
  assert.equal(f.memory.disk.has(STAFF_KEY_FILE_IN_DATA), false);
  nothingCreated(f, '21 caractères');

  const absent = path.join(keyDir, 'absente');
  const missing = raised(() => f.loadStaffKey({ ...f.SERVER, staffKeyFile: absent }, DATA));
  assert.equal(missing.message, `KARAOKE_STAFF_KEY_FILE illisible (${absent} : ENOENT).`);
  nothingCreated(f, 'fichier absent');

  const g = harness({ files: { 'data/staff-key': 'abc\n' } });
  const invalid = raised(() => g.loadStaffKey({ ...g.SERVER, staffKeyFile: null }, DATA));
  assert.equal(invalid.message, 'data/staff-key ne contient pas une clé valable (au moins 22 caractères parmi A-Z, a-z, 0-9, - et _) : remplace-la avec node server.js --rotate-staff-key.');
  assert.equal(invalid.message.includes('abc'), false);
  assert.equal(g.memory.disk.get(STAFF_KEY_FILE_IN_DATA), 'abc\n', 'fichier refusé laissé tel quel');
  nothingCreated(g, '« abc »');

  const h = harness();
  h.memory.beforeWrite = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  const denied = raised(() => h.loadStaffKey({ ...h.SERVER, staffKeyFile: null }, DATA));
  assert.equal(denied.message, 'data/staff-key impossible à créer (EACCES).');
  assert.equal(h.memory.disk.has(STAFF_KEY_FILE_IN_DATA), false);

  // data/staff-key illisible (ici un dossier, sur le vrai disque du test).
  const blocked = path.join(keyDir, 'data-bloque');
  fs.mkdirSync(path.join(blocked, 'staff-key'), { recursive: true });
  const unreadable = raised(() => f.loadStaffKey({ ...f.SERVER, staffKeyFile: null }, blocked));
  assert.match(unreadable.message, /^data\/staff-key illisible \(E[A-Z]+\)\.$/);
});

// ---------------------------------------------------------------- 3. refus de démarrer
test('T8 readServerConfig : défauts, raisons exactes dans l’ordre des 8 contrôles', () => {
  const f = harness();
  const base = { KARAOKE_MODE: 'server', KARAOKE_PUBLIC_URL: 'https://clients.exemple.fr', KARAOKE_STAFF_URL: 'https://bar.exemple.fr' };
  const reason = env => {
    try { f.readServerConfig(env); } catch (error) { return error.message; }
    return null;
  };
  const defaults = f.readServerConfig(base);
  assert.equal(defaults.bind, '127.0.0.1');
  assert.equal(defaults.publicBind, '127.0.0.1');
  assert.equal(defaults.publicUrl, 'https://clients.exemple.fr');
  assert.equal(defaults.staffUrl, 'https://bar.exemple.fr');
  assert.equal(defaults.clientIpHeader, null);
  assert.equal(defaults.staffKeyFile, null);
  assert.equal(defaults.trustedProxiesText, DEFAULT_PROXIES);
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.31.255.1', '192.168.0.9']) assert.equal(defaults.trustedProxies.check(ip, 'ipv4'), true, ip);
  for (const ip of ['::1', 'fd12::1']) assert.equal(defaults.trustedProxies.check(ip, 'ipv6'), true, ip);
  assert.equal(defaults.trustedProxies.check('203.0.113.5', 'ipv4'), false);
  assert.equal(defaults.trustedProxies.check('2001:db8::1', 'ipv6'), false);

  // Vide ou fait d'espaces : absent.
  const blank = f.readServerConfig({ ...base, KARAOKE_MODE: '  ', KARAOKE_BIND: '', KARAOKE_PUBLIC_BIND: ' \t ',
    KARAOKE_CLIENT_IP_HEADER: '  ', KARAOKE_TRUSTED_PROXIES: '   ', KARAOKE_STAFF_KEY_FILE: ' ' });
  assert.deepEqual([blank.bind, blank.publicBind, blank.clientIpHeader, blank.trustedProxiesText, blank.staffKeyFile],
    ['127.0.0.1', '127.0.0.1', null, DEFAULT_PROXIES, null]);
  assert.equal(reason({ ...base, KARAOKE_PUBLIC_URL: '   ' }),
    'KARAOKE_PUBLIC_URL manque : indique l’adresse HTTPS des QR clients, par exemple https://chant.exemple.fr.');
  assert.equal(reason({ ...base, KARAOKE_STAFF_URL: '' }),
    'KARAOKE_STAFF_URL manque : indique l’adresse HTTPS de la page du bar, par exemple https://bar.exemple.fr.');

  // Ordre : tout faux, puis un contrôle réparé à la fois ; seul le premier échec est rendu.
  const env = { KARAOKE_MODE: 'serveur', KARAOKE_BIND: 'localhost', KARAOKE_PUBLIC_BIND: 'tout', KARAOKE_CLIENT_IP_HEADER: 'x real ip',
    KARAOKE_TRUSTED_PROXIES: '10.0.0.0/40' };
  const steps = [
    [{}, 'KARAOKE_MODE vaut « serveur » : seule la valeur server est reconnue (retire la variable pour le mode PC).'],
    [{ KARAOKE_MODE: 'server' }, 'KARAOKE_PUBLIC_URL manque : indique l’adresse HTTPS des QR clients, par exemple https://chant.exemple.fr.'],
    [{ KARAOKE_PUBLIC_URL: 'https://clients.exemple.fr' }, 'KARAOKE_STAFF_URL manque : indique l’adresse HTTPS de la page du bar, par exemple https://bar.exemple.fr.'],
    [{ KARAOKE_STAFF_URL: 'https://clients.exemple.fr/' }, 'KARAOKE_STAFF_URL doit différer de KARAOKE_PUBLIC_URL : la page du bar n’est jamais servie par l’adresse des clients.'],
    [{ KARAOKE_STAFF_URL: 'https://bar.exemple.fr' }, 'KARAOKE_BIND invalide (« localhost ») : indique une adresse IP, par exemple 127.0.0.1 ou 0.0.0.0.'],
    [{ KARAOKE_BIND: '0.0.0.0' }, 'KARAOKE_PUBLIC_BIND invalide (« tout ») : indique une adresse IP, par exemple 127.0.0.1 ou 0.0.0.0.'],
    [{ KARAOKE_PUBLIC_BIND: '::' }, 'KARAOKE_CLIENT_IP_HEADER invalide (« x real ip ») : indique un nom d’en-tête HTTP, par exemple x-real-ip.'],
    [{ KARAOKE_CLIENT_IP_HEADER: 'X-Real-IP' }, 'KARAOKE_TRUSTED_PROXIES invalide (« 10.0.0.0/40 ») : indique des blocs CIDR séparés par des virgules, par exemple 172.16.0.0/12.'],
    [{ KARAOKE_TRUSTED_PROXIES: ' 10.0.0.0/8 , , 2001:db8::/32 ' }, null],
  ];
  for (const [fix, expected] of steps) {
    Object.assign(env, fix);
    assert.equal(reason(env), expected, JSON.stringify(fix));
  }
  const fixed = f.readServerConfig(env);
  assert.deepEqual([fixed.bind, fixed.publicBind, fixed.clientIpHeader, fixed.trustedProxiesText],
    ['0.0.0.0', '::', 'x-real-ip', '10.0.0.0/8,2001:db8::/32'], 'en-tête en minuscules, entrées vides ignorées');
  assert.equal(fixed.trustedProxies.check('10.9.8.7', 'ipv4'), true);
  assert.equal(fixed.trustedProxies.check('2001:db8:1::5', 'ipv6'), true);
  assert.equal(fixed.trustedProxies.check('192.168.1.1', 'ipv4'), false, 'liste fournie : le défaut ne s’ajoute pas');

  // 1. KARAOKE_MODE : seule la valeur server, après trim ; citation coupée à 80 caractères.
  assert.equal(reason({ ...base, KARAOKE_MODE: ' server ' }), null);
  assert.equal(reason({ ...base, KARAOKE_MODE: 'Server' }),
    'KARAOKE_MODE vaut « Server » : seule la valeur server est reconnue (retire la variable pour le mode PC).');
  assert.equal(reason({ ...base, KARAOKE_MODE: 'x'.repeat(100) }),
    `KARAOKE_MODE vaut « ${'x'.repeat(80)} » : seule la valeur server est reconnue (retire la variable pour le mode PC).`);
  // 2 et 3. Adresses : message de normalizeBaseUrl, puis https exigé.
  for (const name of ['KARAOKE_PUBLIC_URL', 'KARAOKE_STAFF_URL']) {
    const other = name === 'KARAOKE_PUBLIC_URL' ? { KARAOKE_STAFF_URL: 'https://bar.exemple.fr' } : { KARAOKE_PUBLIC_URL: 'https://clients.exemple.fr' };
    const check = value => reason({ ...base, ...other, [name]: value });
    assert.equal(check('http://clients.exemple.fr'), `${name} invalide : Une adresse accessible depuis Internet doit utiliser HTTPS.`);
    assert.equal(check('https://clients.exemple.fr/x'),
      `${name} invalide : Indique seulement l’adresse de base, sans chemin, paramètres ni identifiants.`);
    assert.equal(check('pas une adresse'),
      `${name} invalide : Adresse invalide : indique une origine HTTPS, par exemple https://chant.exemple.fr.`);
    assert.equal(check('https://192.168.1.5'), `${name} invalide : Pour les mobiles sans Wi-Fi, utilise un vrai nom de domaine public HTTPS.`);
    assert.equal(check('http://192.168.1.5:3000'), `${name} doit commencer par https://.`);
    assert.equal(check('http://localhost:3000'), `${name} doit commencer par https://.`);
    for (const value of ['http://clients.exemple.fr', 'pas une adresse', 'https://192.168.1.5']) {
      assert.equal(check(value), `${name} invalide : ${raised(() => f.normalizeBaseUrl(value)).message}`, 'message repris de normalizeBaseUrl');
    }
  }
  assert.equal(f.readServerConfig({ ...base, KARAOKE_PUBLIC_URL: ' https://Clients.Exemple.fr/ ' }).publicUrl, 'https://clients.exemple.fr');
  // 4. Origines égales après normalisation.
  assert.equal(reason({ ...base, KARAOKE_STAFF_URL: 'HTTPS://CLIENTS.exemple.fr' }),
    'KARAOKE_STAFF_URL doit différer de KARAOKE_PUBLIC_URL : la page du bar n’est jamais servie par l’adresse des clients.');
  assert.equal(f.readServerConfig({ ...base, KARAOKE_STAFF_URL: 'https://clients.exemple.fr:8443' }).staffUrl, 'https://clients.exemple.fr:8443');
  // 5 et 6. Adresses d'écoute.
  assert.equal(reason({ ...base, KARAOKE_PUBLIC_BIND: '127.0.0.256' }),
    'KARAOKE_PUBLIC_BIND invalide (« 127.0.0.256 ») : indique une adresse IP, par exemple 127.0.0.1 ou 0.0.0.0.');
  assert.equal(reason({ ...base, KARAOKE_BIND: 'b'.repeat(90) }),
    `KARAOKE_BIND invalide (« ${'b'.repeat(80)} ») : indique une adresse IP, par exemple 127.0.0.1 ou 0.0.0.0.`);
  // 7. Tout nom d'en-tête conforme, cf-connecting-ip compris.
  assert.equal(f.readServerConfig({ ...base, KARAOKE_CLIENT_IP_HEADER: 'CF-Connecting-IP' }).clientIpHeader, 'cf-connecting-ip');
  assert.equal(f.readServerConfig({ ...base, KARAOKE_CLIENT_IP_HEADER: 'h'.repeat(64) }).clientIpHeader, 'h'.repeat(64));
  assert.equal(reason({ ...base, KARAOKE_CLIENT_IP_HEADER: 'h'.repeat(65) }),
    `KARAOKE_CLIENT_IP_HEADER invalide (« ${'h'.repeat(65)} ») : indique un nom d’en-tête HTTP, par exemple x-real-ip.`);
  assert.equal(reason({ ...base, KARAOKE_CLIENT_IP_HEADER: 'x_real_ip' }),
    'KARAOKE_CLIENT_IP_HEADER invalide (« x_real_ip ») : indique un nom d’en-tête HTTP, par exemple x-real-ip.');
  // 8. Proxys de confiance : entrée refusée citée, ou la valeur entière sans entrée gardée.
  const proxies = value => reason({ ...base, KARAOKE_TRUSTED_PROXIES: value });
  const refused = text => `KARAOKE_TRUSTED_PROXIES invalide (« ${text} ») : indique des blocs CIDR séparés par des virgules, par exemple 172.16.0.0/12.`;
  assert.equal(proxies(','), refused(','));
  assert.equal(proxies(' , ,, '), refused(', ,,'));
  assert.equal(proxies('10.0.0.0/8,172.16.0.0'), refused('172.16.0.0'), 'entrée sans /');
  assert.equal(proxies('reseau/8'), refused('reseau/8'));
  assert.equal(proxies('/8'), refused('/8'));
  assert.equal(proxies('10.0.0.0/'), refused('10.0.0.0/'));
  assert.equal(proxies('10.0.0.0/x'), refused('10.0.0.0/x'));
  assert.equal(proxies('10.0.0.0/-1'), refused('10.0.0.0/-1'));
  assert.equal(proxies('::1/129'), refused('::1/129'));
  assert.equal(proxies(`10.0.0.0/8,${'9'.repeat(100)}/8`), refused('9'.repeat(80)));
  assert.equal(f.readServerConfig({ ...base, KARAOKE_TRUSTED_PROXIES: '0.0.0.0/0,::/0' }).trustedProxies.check('203.0.113.9', 'ipv4'), true);
  // Chemin du fichier de clé résolu.
  assert.equal(f.readServerConfig({ ...base, KARAOKE_STAFF_KEY_FILE: 'cle/bar' }).staffKeyFile, path.resolve('cle/bar'));
});

// ---------------------------------------------------------------- 4. adresses publiques
test('T9 QR des deux origines : clients sur KARAOKE_PUBLIC_URL, gérants sur KARAOKE_STAFF_URL', async () => {
  const targets = [];
  const realQr = fromServer('qrcode');
  const qrcode = { ...realQr, toString: (text, options) => { targets.push(text); return realQr.toString(text, options); } };
  const f = harness({ modules: { qrcode } });
  f.sched.table('1').headcount = 4;
  f.access.issue('1');
  f.ensureSoloGroup();
  assert.equal(f.settings.baseUrl, 'https://clients.exemple.fr', 'valeur initiale');
  assert.equal(f.phoneBase(), 'https://clients.exemple.fr');
  const state = f.staffState();
  assert.deepEqual(plain(state.ips), []);
  assert.equal(state.app.mode, 'server');
  assert.equal(state.app.version, f.BUILD.version);
  assert.equal(state.phoneBase, 'https://clients.exemple.fr');
  assert.ok(state.tables.length >= 2);
  for (const table of state.tables) assert.ok(table.url.startsWith('https://clients.exemple.fr/t/'), table.url);
  const viaHttp = await get(f, withKey('/api/staff/state', FILE_KEY));
  assert.equal(viaHttp.status, 200);
  assert.deepEqual(viaHttp.body.ips, []);
  assert.equal(viaHttp.body.app.mode, 'server');

  const staffQr = await get(f, withKey('/qr/staff.svg', FILE_KEY));
  assert.equal(staffQr.status, 200);
  assert.equal(targets.at(-1), `https://bar.exemple.fr/staff?key=${f.STAFF_KEY}`);
  const tableQr = await get(f, withKey('/qr/1.svg', FILE_KEY));
  assert.equal(tableQr.status, 200);
  assert.ok(targets.at(-1).startsWith('https://clients.exemple.fr/t/1/'), 'QR de table sur l’adresse des clients');
  assert.equal(targets.length, 2);
  assert.ok(targets.every(target => target.startsWith('https://')), 'aucune adresse http ni du Wi-Fi');

  // Adresse envoyée par la page du bar : enregistrée (route inchangée ici), sans effet sur les QR.
  const sent = await post(f, withKey('/api/staff/settings', FILE_KEY), { baseUrl: 'https://autre.exemple.fr' });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(f.settings.baseUrl, 'https://autre.exemple.fr');
  assert.equal(f.phoneBase(), 'https://clients.exemple.fr');
  for (const table of f.staffState().tables) assert.ok(table.url.startsWith('https://clients.exemple.fr/t/'), table.url);
  await get(f, withKey('/qr/1.svg', FILE_KEY));
  assert.ok(targets.at(-1).startsWith('https://clients.exemple.fr/t/1/'), 'QR de table toujours sur KARAOKE_PUBLIC_URL');
  await get(f, withKey('/qr/staff.svg', FILE_KEY));
  assert.equal(targets.at(-1), `https://bar.exemple.fr/staff?key=${f.STAFF_KEY}`);

  // Ancienne adresse de data/tables.json : sans effet en mode serveur, même refusée aujourd'hui.
  for (const baseUrl of ['https://ancien.exemple.fr', 'http://ancien.exemple.fr']) {
    const tables = { version: 1, baseUrl, tables: [{ id: '1', name: null, headcount: 4, individual: false,
      secret: crypto.randomBytes(16).toString('base64url') }] };
    const p = harness({ persistent: true, files: { 'data/tables.json': tables } });
    p.loadTables();
    assert.equal(p.settings.baseUrl, 'https://clients.exemple.fr', baseUrl);
    assert.equal(p.staffState().tables.find(t => t.id === '1').url.startsWith('https://clients.exemple.fr/t/1/'), true);
    p.ensureSoloGroup();
    assert.equal(JSON.parse(p.memory.read('data/tables.json')).baseUrl, 'https://clients.exemple.fr', 'écrite dans data/tables.json');
  }

  // Harnais PC : mode affiché « pc », adresse du Wi-Fi toujours proposée.
  const pc = harness({ serverEnv: false });
  const pcState = pc.staffState();
  assert.equal(pcState.app.mode, 'pc');
  assert.equal(pcState.app.version, pc.BUILD.version);
  const lan = Object.values(os.networkInterfaces()).flat().some(a => a && a.family === 'IPv4' && !a.internal);
  assert.equal(pcState.ips.length > 0, lan);
  assert.equal(pc.settings.baseUrl, null);
});

// ---------------------------------------------------------------- 5. journal de démarrage
test('T17 lignes de démarrage : adresses, fuseau, empreinte, jamais la clé', () => {
  const f = harness();
  const fingerprint = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  assert.equal(f.staffKeyFingerprint(f.STAFF_KEY), fingerprint(FILE_KEY));
  const head = (g, publicBind = '127.0.0.1', bind = '127.0.0.1') => ['',
    `=== File karaoké ${g.BUILD.version}${g.BUILD.commit ? ` (${g.BUILD.commit})` : ''} ===`,
    'Mode                           : serveur',
    `Adresse des clients (QR)       : https://clients.exemple.fr  (port ${g.PUBLIC_PORT} sur ${publicBind})`,
    `Adresse de la page du bar      : https://bar.exemple.fr  (port ${g.PORT} sur ${bind})`];
  const zoneLine = zone => `Fuseau horaire                 : ${zone}`;
  const warning = 'Attention : fuseau horaire UTC. L’heure de fermeture et les heures du journal seront décalées : fixe TZ=Europe/Paris.';
  const tail = (g, source, phones) => [`Clé du bar                     : empreinte ${fingerprint(g.STAFF_KEY)} (${source})`,
    'Lien du bar                    : node server.js --print-staff-url', phones, ''];
  const viaHeader = `Adresse des téléphones         : en-tête x-real-ip des proxys ${DEFAULT_PROXIES}`;
  const viaSocket = 'Adresse des téléphones         : adresse de la connexion (KARAOKE_CLIENT_IP_HEADER non fixée)';
  const noHeader = harness({ env: { KARAOKE_CLIENT_IP_HEADER: undefined } });
  const lines = (g, zone) => [...g.serverStartupLines(zone)];
  for (const [g, phones] of [[f, viaHeader], [noHeader, viaSocket]]) {
    assert.deepEqual(lines(g, 'Europe/Paris'), [...head(g), zoneLine('Europe/Paris'), ...tail(g, 'KARAOKE_STAFF_KEY_FILE', phones)]);
    for (const zone of ['UTC', 'Etc/UTC']) {
      assert.deepEqual(lines(g, zone), [...head(g), zoneLine(zone), warning, ...tail(g, 'KARAOKE_STAFF_KEY_FILE', phones)], zone);
    }
  }
  // Zone par défaut : celle du processus.
  assert.ok(lines(f).includes(zoneLine(Intl.DateTimeFormat().resolvedOptions().timeZone)));
  // Adresses d'écoute, proxys fournis et clé de data/staff-key.
  const custom = harness({ env: { KARAOKE_BIND: '0.0.0.0', KARAOKE_PUBLIC_BIND: '::', KARAOKE_STAFF_KEY_FILE: undefined,
    KARAOKE_TRUSTED_PROXIES: '172.16.0.0/12' } });
  assert.deepEqual(lines(custom, 'Europe/Paris'), [...head(custom, '::', '0.0.0.0'), zoneLine('Europe/Paris'),
    ...tail(custom, 'data/staff-key, créée à ce démarrage', 'Adresse des téléphones         : en-tête x-real-ip des proxys 172.16.0.0/12')]);
  for (const g of [f, noHeader, custom]) {
    for (const line of [...lines(g, 'UTC'), ...lines(g, 'Europe/Paris')]) {
      assert.equal(line.includes(g.STAFF_KEY), false, 'la clé n’apparaît sur aucune ligne');
      assert.equal(line.includes('staff?key='), false);
      assert.equal(line.includes('Laisse cette fenêtre ouverte'), false);
    }
  }
  // Harnais PC : aucune ligne du mode serveur.
  assert.deepEqual(lines(harness({ serverEnv: false }), 'UTC'), []);
});
