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
// fichier présent lève EEXIST. `mkdirs` : dossiers demandés. `beforeWrite` et
// `beforeMkdir` : crochets appelés au début de chaque écriture ou création de
// dossier (course simulée, panne). `stderr` : texte écrit par fs.writeSync(2, …)
// (raison d'un refus de démarrer).
function memoryDisk(files = {}) {
  const disk = new Map(Object.entries(files).map(([rel, value]) =>
    [path.join(root, rel), typeof value === 'string' ? value : JSON.stringify(value)]));
  const inMemory = file => [DATA, path.join(root, 'journal')]
    .some(dir => file === dir || String(file).startsWith(dir + path.sep));
  const missing = file => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  const memory = { disk, writes: [], mkdirs: [], beforeWrite: null, beforeMkdir: null, stderr: '' };
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
    mkdirSync(dir, options) {
      if (memory.beforeMkdir) memory.beforeMkdir(dir, options);
      memory.mkdirs.push({ dir, options, order: ++order });
    },
    writeSync(fd, data, ...rest) {
      if (fd !== 2) return fs.writeSync(fd, data, ...rest);
      memory.stderr += String(data);
      return Buffer.byteLength(String(data));
    },
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
  try {
    vm.runInNewContext(source.slice(0, entry) + `
      globalThis.fixture = { sched, settings, access, soloInvitations, privateEvent, battleVote, staffState, journal,
        ensureSoloGroup, clearEvening, battleElectorate, saveNight, journalRoster, journalSample, publicState, transferSnapshot, personShareCodes,
        STAFF_KEY, PORT, PUBLIC_PORT, handle: server.listeners('request')[0], setTracked: value => { tracked = value; },
        setPending: value => { pending = value; },
        spotify, loadTables, normalizeBaseUrl, SERVER, STAFF_KEY_INFO, STOP_KEY, server, publicServer,
        isShuttingDown: () => shuttingDown, readServerConfig, loadStaffKey, staffKeyFingerprint, serverStartupLines,
        phoneBase, BUILD, rotateStaffKey, staffKeyCommand, printedBaseUrlWarning, serverClientAddress, karafunBridgeOptions, portInUseMessage,
        setRestartSweep: value => { restartSweep = value; },
        setBridge: value => { bridge = value; } };
    `, context, { filename: 'server.js' });
  } catch (error) {
    // Refus de démarrer : le disque en mémoire (raison sur stderr) reste lisible.
    throw Object.assign(error, { memory });
  }
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

test('catalogue en mode serveur : ni recherche ni listes sans QR ou clé du bar', async () => {
  const f = harness();
  const routes = ['/api/search?q=abba', '/api/catalog/categories?type=styles',
    '/api/catalog/highlights?type=news', '/api/catalog/songs?filter=pl_1&offset=0'];
  for (const route of routes) {
    const anonymous = await get(f, route, { port: f.PUBLIC_PORT });
    assert.equal(anonymous.status, 403, route);
    const wrongStaffPort = await get(f, route,
      { port: f.PUBLIC_PORT, headers: { 'x-staff-key': f.STAFF_KEY } });
    assert.equal(wrongStaffPort.status, 403, `clé du bar sur le port clients : ${route}`);
  }
  f.sched.table('1').headcount = 4;
  const access = f.access.issue('1');
  const qrHeaders = { 'x-table-id': '1', 'x-table-access': access };
  assert.equal((await get(f, '/api/search?q=abba', { port: f.PUBLIC_PORT, headers: qrHeaders })).status, 503,
    'QR valide : la demande passe le contrôle et atteint KaraFun absent');
  assert.equal((await get(f, '/api/search?q=abba', { port: f.PORT,
    headers: { 'x-staff-key': f.STAFF_KEY } })).status, 503, 'bar autorisé par sa clé');
  assert.equal((await get(f, '/api/search?q=abba', { port: f.PUBLIC_PORT,
    headers: { ...qrHeaders, 'x-table-access': 'faux' } })).status, 403, 'QR invalide');
  const pc = harness({ serverEnv: false });
  for (const route of routes) {
    assert.equal((await get(pc, route, { port: pc.PUBLIC_PORT })).status, 403,
      `le tunnel clients du kit PC exige aussi un QR : ${route}`);
    assert.equal((await get(pc, route, { port: pc.PORT, remote: '192.0.2.20' })).status, 403,
      `le port du bar accessible en Wi-Fi exige aussi un QR : ${route}`);
  }
  assert.equal((await get(pc, '/api/search?q=abba', { port: pc.PUBLIC_PORT,
    headers: { 'x-staff-key': pc.STAFF_KEY } })).status, 403,
    'la clé du bar ne fonctionne pas sur le tunnel clients du kit PC');
  assert.equal((await get(pc, '/api/search?q=abba', { port: pc.PORT, remote: '192.0.2.20',
    headers: { 'x-staff-key': pc.STAFF_KEY } })).status, 503,
    'le bar peut chercher avec sa clé depuis le Wi-Fi');
  pc.sched.table('1').headcount = 2;
  const pcQr = { 'x-table-id': '1', 'x-table-access': pc.access.issue('1') };
  assert.equal((await get(pc, '/api/search?q=abba', { port: pc.PUBLIC_PORT, headers: pcQr })).status, 503,
    'QR valide sur le tunnel clients du kit PC');
  assert.equal((await get(pc, '/api/search?q=abba', { port: pc.PORT, remote: '192.0.2.20', headers: pcQr })).status, 503,
    'QR valide depuis le Wi-Fi sur le port du bar du kit PC');
  assert.equal((await get(pc, '/api/search?q=abba', { port: pc.PORT })).status, 503,
    'la boucle locale du PC garde sa recherche historique');
});

test('catalogue solo : QR personnel ou téléphone inscrit requis', async () => {
  const f = harness();
  f.ensureSoloGroup();
  const headers = { 'x-table-id': 'Comptoir', 'x-table-access': f.access.get('Comptoir') };
  const route = '/api/search?q=abba';
  assert.equal((await get(f, route, { port: f.PUBLIC_PORT, headers })).status, 403);
  const invitation = f.soloInvitations.issue('Comptoir').token;
  assert.equal((await get(f, route, { port: f.PUBLIC_PORT,
    headers: { ...headers, 'x-solo-invitation': invitation } })).status, 503,
  'le QR personnel permet de découvrir des titres avant inscription');
  const joined = await post(f, '/api/table/person',
    { table: 'Comptoir', access: headers['x-table-access'], invitation, name: 'Soliste' },
    { port: f.PUBLIC_PORT });
  assert.equal(joined.status, 200, joined.text);
  const cookie = String(joined.headers['set-cookie']).split(';')[0];
  assert.equal((await get(f, route, { port: f.PUBLIC_PORT, headers, cookie })).status, 503,
    'le téléphone inscrit garde l’accès après consommation de son invitation');
  const person = f.sched.people.get(joined.body.id);
  assert.ok(person, 'la personne inscrite existe');
  person.withdrawnAt = Date.now();
  assert.equal((await get(f, route, { port: f.PUBLIC_PORT, headers, cookie })).status, 403,
    'un téléphone associé à une personne partie ne lit plus le catalogue');
  person.withdrawnAt = null;
  person.soloDeviceHashes.push(crypto.randomBytes(32).toString('hex'));
  assert.equal((await get(f, route, { port: f.PUBLIC_PORT, headers, cookie })).status, 403,
    'le téléphone précédent ne lit plus après transfert de la place solo');
});

test('catalogue solo : le budget de son QR suit le téléphone après inscription', async () => {
  const f = harness();
  f.ensureSoloGroup();
  f.setBridge({ search: async q => [{ songId: 1, title: q, artist: 'Test' }] });
  const headers = { 'x-table-id': 'Comptoir', 'x-table-access': f.access.get('Comptoir') };
  const invitation = f.soloInvitations.issue('Comptoir').token;
  const route = i => `/api/search?q=unique${i}`;
  for (let i = 0; i < 29; i++) assert.equal((await get(f, route(i), { port: f.PUBLIC_PORT,
    headers: { ...headers, 'x-solo-invitation': invitation } })).status, 200);
  const joined = await post(f, '/api/table/person',
    { table: 'Comptoir', access: headers['x-table-access'], invitation, name: 'Soliste' },
    { port: f.PUBLIC_PORT });
  assert.equal(joined.status, 200, joined.text);
  const cookie = String(joined.headers['set-cookie']).split(';')[0];
  assert.equal((await get(f, route(29), { port: f.PUBLIC_PORT, headers, cookie })).status, 200);
  assert.equal((await get(f, route(30), { port: f.PUBLIC_PORT, headers, cookie })).status, 429,
    'l’inscription ne remet pas à zéro la limite de 30 recherches du QR');
});

test('catalogue en mode serveur : les trois listes restent lisibles avec un QR valide', async () => {
  const calls = [];
  class FakeCatalog {
    async categories(type) { calls.push(`categories:${type}`); return [{ id: 1, name: 'Sélection', filter: 'pl_1' }]; }
    async highlights(type) { calls.push(`highlights:${type}`); return [{ songId: 1, title: 'Titre', artist: 'Artiste' }]; }
    async songs(filter, offset) { calls.push(`songs:${filter}:${offset}`); return { songs: [{ songId: 1, title: 'Titre', artist: 'Artiste' }], total: 1 }; }
  }
  const f = harness({ persistent: true, args: ['--code', '123456'], modules: { './catalog': { Catalog: FakeCatalog } } });
  f.sched.table('1').headcount = 2;
  const headers = { 'x-table-id': '1', 'x-table-access': f.access.issue('1') };
  const options = { port: f.PUBLIC_PORT, headers };
  const categories = await get(f, '/api/catalog/categories?type=playlist', options);
  const highlights = await get(f, '/api/catalog/highlights?type=news', options);
  const songs = await get(f, '/api/catalog/songs?filter=pl_1&offset=0', options);
  assert.equal(categories.status, 200, categories.text);
  assert.equal(highlights.status, 200, highlights.text);
  assert.equal(songs.status, 200, songs.text);
  assert.equal(categories.body[0].name, 'Sélection');
  assert.equal(highlights.body[0].title, 'Titre');
  assert.equal(songs.body.songs[0].title, 'Titre');
  assert.deepEqual(calls, ['categories:playlist', 'highlights:news', 'songs:pl_1:0']);
});

test('catalogue public : requêtes identiques partagées, budget commun sans pénalité par IP', async () => {
  const f = harness();
  let sent = 0;
  f.setBridge({ search: async q => { sent++; return [{ songId: sent, title: q, artist: 'Test' }]; } });
  const headers = [];
  for (const id of ['1', '2', '3']) {
    f.sched.table(id).headcount = 40;
    headers.push({ 'x-table-id': id, 'x-table-access': f.access.issue(id) });
  }
  const ask = (q, i) => get(f, `/api/search?q=${q}`, { port: f.PUBLIC_PORT,
    remote: '198.51.100.12', headers: headers[i % headers.length] });
  assert.equal((await ask('identique', 0)).status, 200);
  assert.equal((await ask('identique', 1)).status, 200);
  assert.equal(sent, 1, 'une requête KaraFun pour deux téléphones autorisés');
  for (let i = 0; i < 60; i++) assert.equal((await ask(`titre${i}`, i)).status, 200,
    '60 téléphones derrière une adresse peuvent faire une recherche chacun');
  let limited = null;
  for (let i = 60; i < 300; i++) {
    const r = await ask(`titre${i}`, i);
    if (r.status === 429) { limited = r; break; }
    assert.equal(r.status, 200);
  }
  assert.ok(limited, 'un QR connu ne donne pas des appels KaraFun illimités');
  assert.equal(limited.body.code, 'CATALOG_BUSY');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal((await get(f, '/api/search?q=secours', { port: f.PORT,
    headers: { 'x-staff-key': f.STAFF_KEY } })).status, 200,
  'le bar peut chercher malgré le trafic public');
});

test('catalogue public : six appels KaraFun actifs au plus, 60 téléphones attendent sans rafale', async () => {
  const f = harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let active = 0, maximum = 0, sent = 0;
  f.setBridge({ search: async q => {
    if (q === 'secours') return [{ songId: 99, title: q, artist: 'Test' }];
    active++; sent++; maximum = Math.max(maximum, active);
    await gate;
    active--;
    return [{ songId: sent, title: q, artist: 'Test' }];
  } });
  const headers = [];
  for (const id of ['1', '2', '3']) {
    f.sched.table(id).headcount = 40;
    headers.push({ 'x-table-id': id, 'x-table-access': f.access.issue(id) });
  }
  const jobs = Array.from({ length: 70 }, (_, i) => get(f, `/api/search?q=unique${i}`,
    { port: f.PUBLIC_PORT, remote: '198.51.100.12', headers: headers[i % 3] }));
  await sleep(20);
  assert.equal(sent, 6, 'la rafale reste à six appels externes');
  const staff = await get(f, '/api/search?q=secours', { port: f.PORT,
    headers: { 'x-staff-key': f.STAFF_KEY } });
  assert.equal(staff.status, 200, 'la recherche du bar ne dépend pas de la file publique pleine');
  release();
  const results = await Promise.all(jobs);
  assert.ok(results.filter(r => r.status === 200).length >= 60,
    '60 recherches distinctes depuis une seule adresse sont acceptées');
  assert.ok(results.some(r => r.status === 429), 'une file saturée répond vite avec Retry-After');
  assert.equal(maximum, 6, 'aucun dépassement de la simultanéité');
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

// ---------------------------------------------------------------- Spotify (#27)
// Valeurs factices : Client ID et adresse du réseau Docker.
const SPOTIFY_CLIENT_ID = '0123456789abcdef0123456789abcdef';
const DOCKER_REMOTE = '172.18.0.3';
// Faux Spotify : garde chaque requête, répond un jeton à /api/token.
function fakeSpotifyFetch(f) {
  const requests = [];
  f.spotify.fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), body: String(options.body || '') });
    if (String(url) !== 'https://accounts.spotify.com/api/token') throw new Error(`requête inattendue : ${url}`);
    return { ok: true, status: 200, json: async () => ({ access_token: 'jeton', refresh_token: 'rt', expires_in: 3600 }) };
  };
  return requests;
}
// Client ID enregistré puis adresse de connexion demandée par la page du bar.
async function spotifyAuthUrl(f, remote = DOCKER_REMOTE) {
  const client = await post(f, withKey('/api/staff/spotify', f.STAFF_KEY), { action: 'client', clientId: SPOTIFY_CLIENT_ID }, { remote });
  assert.equal(client.status, 200, 'Client ID enregistré');
  const auth = await post(f, withKey('/api/staff/spotify', f.STAFF_KEY), { action: 'auth-url' }, { remote });
  assert.equal(auth.status, 200, 'adresse de connexion rendue');
  return new URL(auth.body.url);
}

test('SP3 adresse de retour du serveur : http://127.0.0.1:<port>/spotify/callback, jamais les adresses publiques', async () => {
  const f = harness();
  assert.ok(f.SERVER, 'mode serveur actif dans le harnais');
  const url = await spotifyAuthUrl(f);
  assert.equal(url.origin, 'https://accounts.spotify.com');
  const expected = `http://127.0.0.1:${f.PORT}/spotify/callback`;
  assert.equal(url.searchParams.get('redirect_uri'), expected);
  const view = f.staffState().spotify;
  assert.equal(view.redirectUri, expected, 'même adresse affichée dans la page du bar');
  const text = JSON.stringify(view);
  assert.equal(text.includes('bar.exemple.fr'), false, 'pas l’adresse de KARAOKE_STAFF_URL');
  assert.equal(text.includes('clients.exemple.fr'), false, 'pas l’adresse de KARAOKE_PUBLIC_URL');
});

// Remplace T3 de #24 : en mode serveur, le retour arrive par le réseau Docker
// (tunnel SSH), jamais par la boucle locale du conteneur ; seul le state PKCE
// le protège, et le port clients ne le voit jamais.
test('SP4 retour Spotify du serveur protégé par le seul state, port clients refusé, page sans clé', async () => {
  const f = harness();
  const requests = fakeSpotifyFetch(f);
  const realFinish = f.spotify.finishAuth.bind(f.spotify);
  let finished = 0;
  f.spotify.finishAuth = (...args) => { finished += 1; return realFinish(...args); };
  const url = await spotifyAuthUrl(f);
  const state = url.searchParams.get('state');
  assert.ok(state && state === f.spotify.pendingAuth.state, 'state de la demande en cours');
  const page = (r, message, where) => {
    assert.equal(r.status, 200, where);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', where);
    assert.ok(r.text.includes(`<p>${message}</p>`), `${where} : ${message}`);
    assert.ok(r.text.includes('<a href="/staff">Revenir à la page du bar</a>'), `${where} : lien vers /staff`);
    assert.equal(r.text.includes(f.STAFF_KEY), false, `${where} : jamais la clé du bar`);
    assert.equal(r.text.includes('key='), false, `${where} : aucun paramètre key`);
  };

  // Port clients : refusé avant tout traitement, même avec le bon state.
  for (const remote of [...LOOPBACKS, DOCKER_REMOTE]) {
    const r = await get(f, `/spotify/callback?code=c&state=${encodeURIComponent(state)}`, { remote, port: f.PUBLIC_PORT });
    assert.equal(r.status, 403, remote);
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8', remote);
    assert.equal(r.text, 'Réservé au bar', remote);
  }
  assert.equal(finished, 0, 'le port clients n’appelle jamais finishAuth');
  assert.equal(f.spotify.pendingAuth?.state, state, 'le port clients ne consomme pas la demande');

  // Port du bar, toute adresse : même réponse, protégée par le seul state.
  const expired = 'Connexion Spotify expirée : relance-la depuis la page du bar.';
  for (const remote of [...LOOPBACKS, DOCKER_REMOTE]) {
    page(await get(f, '/spotify/callback?code=c&state=invente', { remote, port: f.PORT }), expired, `${remote}, state inventé`);
    const before = finished;
    page(await get(f, '/spotify/callback?error=access_denied&state=invente', { remote, port: f.PORT }),
      'Connexion Spotify annulée.', `${remote}, refus dans Spotify`);
    assert.equal(finished, before, `${remote} : refus dans Spotify sans finishAuth`);
  }
  // Retour sans state, ou avec un state vide : même refus, la demande reste en cours.
  for (const route of ['/spotify/callback?code=c', '/spotify/callback?code=c&state=']) {
    for (const remote of [...LOOPBACKS, DOCKER_REMOTE]) {
      page(await get(f, route, { remote, port: f.PORT }), expired, `${remote}, ${route}`);
    }
  }
  assert.equal(requests.length, 0, 'aucun state inventé, absent ou vide ne joint Spotify');
  assert.equal(f.spotify.pendingAuth?.state, state, 'demande toujours en cours');
  assert.equal(f.spotify.connected, false);

  // Bon state, depuis le réseau Docker : connexion faite.
  page(await get(f, `/spotify/callback?code=c&state=${encodeURIComponent(state)}`, { remote: DOCKER_REMOTE, port: f.PORT }),
    'Spotify est connecté. Choisis l’appareil qui joue la musique dans la page du bar.', 'bon state');
  assert.equal(f.spotify.connected, true);
  assert.equal(requests.length, 1, 'une seule requête à Spotify');
  assert.equal(requests[0].url, 'https://accounts.spotify.com/api/token');
  const form = new URLSearchParams(requests[0].body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('redirect_uri'), `http://127.0.0.1:${f.PORT}/spotify/callback`);
  assert.ok(f.sched.log.some(line => line.msg === 'Spotify connecté à la file karaoké.' && line.kind === 'staff'), 'note au journal du bar');

  // Rejeu du même state : refusé, sans nouvelle requête.
  page(await get(f, `/spotify/callback?code=c&state=${encodeURIComponent(state)}`, { remote: DOCKER_REMOTE, port: f.PORT }),
    expired, 'rejeu');
  assert.equal(requests.length, 1, 'le rejeu ne joint pas Spotify');
});

test('SP5 page du bar sans clé en mode serveur : la coquille seulement, API, impression, statistiques et QR fermés', async () => {
  const f = harness();
  const shell = fs.readFileSync(path.join(root, 'public', 'staff.html'), 'utf8');
  const r = await get(f, '/staff', { remote: DOCKER_REMOTE, port: f.PORT });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(r.text, shell, 'la page du bar telle quelle, sans secret ajouté');
  assert.equal(r.text.includes(f.STAFF_KEY), false);
  const refused = (res, where) => {
    assert.equal(res.status, 403, where);
    assert.equal(res.text.includes(f.STAFF_KEY), false, where);
  };
  for (const route of ['/staff?key=faux', '/staff?key=']) {
    const denied = await get(f, route, { remote: DOCKER_REMOTE, port: f.PORT });
    refused(denied, route);
    assert.equal(denied.text, 'Réservé au bar', `${route} : une clé fausse ou vide reste refusée`);
  }
  for (const remote of [...LOOPBACKS, DOCKER_REMOTE]) {
    const denied = await get(f, '/staff', { remote, port: f.PUBLIC_PORT });
    refused(denied, `port clients depuis ${remote}`);
    assert.equal(denied.text, 'Réservé au bar');
  }
  for (const route of ['/print', '/stats', '/qr/staff.svg', '/api/staff/state']) {
    refused(await get(f, route, { remote: DOCKER_REMOTE, port: f.PORT }), `${route} sans clé`);
  }
  // Témoin : avec la clé, l'API répond.
  assert.equal((await get(f, withKey('/api/staff/state', f.STAFF_KEY), { remote: DOCKER_REMOTE, port: f.PORT })).status, 200);
  // Lien du bar (--print-staff-url) : la page avec sa clé reste servie.
  const keyed = await get(f, withKey('/staff', f.STAFF_KEY), { remote: DOCKER_REMOTE, port: f.PORT });
  assert.equal(keyed.status, 200, 'lien du bar avec clé : page servie');
  assert.equal(keyed.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(keyed.text, shell);
});

test('mise à jour : les copies tardives de relance et les accusés Battle restent protégés', async t => {
  for (const operation of ['restart-sweep', 'battle-sending']) await t.test(operation, async () => {
    let requests = 0;
    const f = harness({ modules: { './server-update': { createServerUpdate: () => ({
      isBusy: () => false,
      view: blockedReason => ({ enabled: true, busy: false, blockedReason }),
      request(blockedReason) {
        if (blockedReason) throw Object.assign(new Error(blockedReason), { status: 409 });
        requests++;
      },
    }) } } });
    if (operation === 'restart-sweep') {
      f.setRestartSweep({ songId: 123, singer: 'S01', title: 'T1', before: [], until: Date.now() + 60000 });
    } else f.battleVote.automation = { status: 'sending' };
    const route = withKey('/api/staff/update', f.STAFF_KEY);
    const denied = await post(f, route, { confirmActive: true });
    assert.equal(denied.status, 409, 'la confirmation ne contourne pas une commande KaraFun à rapprocher');
    assert.match(denied.body.error, /action.*en cours/i);
    assert.equal(requests, 0, 'aucune demande hôte pendant le rapprochement');
    if (operation === 'restart-sweep') {
      f.setRestartSweep({ songId: 123, singer: 'S01', title: 'T1', before: [], until: Date.now() - 1 });
    } else f.battleVote.automation = { status: 'queued' };
    const accepted = await post(f, route, { confirmActive: true });
    assert.equal(accepted.status, 200, 'le verrou technique se libère après le délai ou l’accusé');
    assert.equal(requests, 1);
  });
});

test('entrée des gérants : seul le proxy privé authentifié fournit le lien de session', async () => {
  const f = harness();
  const headers = { host: 'bar.exemple.fr', 'x-karaoke-staff-entry': '1' };
  for (const route of ['/', '/staff']) {
    const r = await get(f, route, { headers, remote: DOCKER_REMOTE, port: f.PORT });
    assert.equal(r.status, 303, route);
    assert.equal(r.headers.location, withKey('/staff', f.STAFF_KEY));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    const page = await get(f, r.headers.location, { headers, remote: DOCKER_REMOTE, port: f.PORT });
    assert.equal(page.status, 200, 'le lien reçu ouvre la page sans boucle');
  }
  for (const options of [
    { headers, remote: DOCKER_REMOTE, port: f.PUBLIC_PORT },
    { headers, remote: '203.0.113.42', port: f.PORT },
    { headers: { ...headers, host: 'clients.exemple.fr' }, remote: DOCKER_REMOTE, port: f.PORT },
    { headers: { ...headers, 'x-karaoke-staff-entry': '1, 1' }, remote: DOCKER_REMOTE, port: f.PORT },
    { headers: { host: 'bar.exemple.fr' }, remote: DOCKER_REMOTE, port: f.PORT },
  ]) {
    for (const route of ['/', '/staff']) {
      const r = await get(f, route, options);
      assert.equal(r.headers.location, undefined, 'aucun secret redirigé hors du proxy privé');
      assert.equal(r.text.includes(f.STAFF_KEY), false);
    }
  }
  assert.equal((await get(f, '/api/staff/state', { headers, remote: DOCKER_REMOTE, port: f.PORT })).status, 403,
    'le marqueur ne donne pas directement accès à l’API');
  assert.equal((await get(f, '/staff?key=faux', { headers, remote: DOCKER_REMOTE, port: f.PORT })).status, 403,
    'une clé explicitement fausse reste refusée');
  const pc = harness({ serverEnv: false });
  const remote = await get(pc, '/', { headers, remote: DOCKER_REMOTE, port: pc.PORT });
  assert.equal(remote.status, 403, 'aucun droit supplémentaire en mode PC');
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
  // Activation : --server seul suffit. Sans lui ni KARAOKE_MODE=server, une
  // variable du mode serveur refuse le démarrage : jamais de mode PC en silence
  // (clé au journal, droits de la boucle locale), même avec --server=1.
  const byOption = harness({ env: { KARAOKE_MODE: undefined }, args: ['--server'] });
  assert.ok(byOption.SERVER, '--server active le mode serveur');
  assert.equal(byOption.STAFF_KEY, FILE_KEY);
  const strayReason = name => `Impossible de démarrer : ${name} est fixée sans le mode serveur : ajoute KARAOKE_MODE=server (ou --server), ou retire les variables KARAOKE_* pour le mode PC.\n`;
  const refusedLoad = options => {
    const error = raised(() => harness(options));
    assert.equal(error.message, 'process.exit(1) pendant le chargement du bac à sable');
    assert.deepEqual([error.memory.writes.length, error.memory.mkdirs.length], [0, 0], 'ni data/ ni journal/');
    return error.memory.stderr;
  };
  for (const mode of [undefined, '', '   ']) {
    assert.equal(refusedLoad({ env: { KARAOKE_MODE: mode } }), strayReason('KARAOKE_PUBLIC_URL'),
      `KARAOKE_MODE ${JSON.stringify(mode)} sans --server`);
  }
  assert.equal(refusedLoad({ env: { KARAOKE_MODE: undefined }, args: ['--server=1'] }), strayReason('KARAOKE_PUBLIC_URL'), '--server=1');
  for (const name of ['KARAOKE_PUBLIC_URL', 'KARAOKE_STAFF_URL', 'KARAOKE_BIND', 'KARAOKE_PUBLIC_BIND',
    'KARAOKE_CLIENT_IP_HEADER', 'KARAOKE_TRUSTED_PROXIES', 'KARAOKE_STAFF_KEY_FILE']) {
    assert.equal(refusedLoad({ serverEnv: false, env: { [name]: 'x' } }), strayReason(name), `${name} seule`);
  }
  // Mode PC : variable du mode serveur vide ou faite d'espaces = absente ; clé tirée à chaque démarrage.
  const pc = harness({ serverEnv: false, env: { KARAOKE_PUBLIC_URL: '   ', KARAOKE_STAFF_URL: '' } });
  assert.equal(pc.SERVER, null, 'mode PC');
  assert.equal(pc.STAFF_KEY_INFO, null);
  assert.notEqual(pc.STAFF_KEY, FILE_KEY, 'mode PC : clé tirée à ce démarrage');
  assert.equal(pc.memory.stderr, '', 'mode PC : aucun refus');
  // Fichier de clé écrit sous Windows (BOM, fin de ligne CRLF) : BOM et
  // espaces retirés, la clé est acceptée telle quelle.
  const bomKey = crypto.randomBytes(18).toString('base64url');
  const bomFile = path.join(keyDir, 'avec-bom');
  fs.writeFileSync(bomFile, `\uFEFF${bomKey}\r\n`);
  assert.deepEqual(plain(byOption.loadStaffKey({ ...byOption.SERVER, staffKeyFile: bomFile }, DATA)),
    { key: bomKey, source: 'KARAOKE_STAFF_KEY_FILE' }, 'BOM et CRLF retirés');
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

  // data/staff-key réenregistré avec BOM et CRLF : même clé, fichier jamais réécrit.
  const bomKey = crypto.randomBytes(18).toString('base64url');
  const w = harness({ files: { 'data/staff-key': `\uFEFF${bomKey}\r\n` } });
  const kept = w.loadStaffKey({ ...w.SERVER, staffKeyFile: null }, DATA);
  assert.equal(kept.key, bomKey, 'BOM et CRLF retirés');
  assert.equal(kept.source, 'data/staff-key');
  assert.equal(w.memory.writes.some(x => x.file === STAFF_KEY_FILE_IN_DATA), false, 'fichier avec BOM jamais réécrit');

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

  // Dossier data/ impossible à créer (volume en lecture seule) : même raison, rien d'écrit.
  const m = harness();
  m.memory.beforeMkdir = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  const noDir = raised(() => m.loadStaffKey({ ...m.SERVER, staffKeyFile: null }, DATA));
  assert.equal(noDir.message, 'data/staff-key impossible à créer (EACCES).');
  nothingCreated(m, 'mkdirSync en échec');

  // Assez longue mais hors de A-Z, a-z, 0-9, - et _ (base64 classique, espace
  // intérieure, lettre accentuée) : refusée dans les deux sources, jamais citée.
  for (const bad of [`${'A'.repeat(20)}+/==`, `${'B'.repeat(11)} ${'C'.repeat(11)}`, 'é'.repeat(22)]) {
    const file = path.join(keyDir, 'hors-format');
    fs.writeFileSync(file, `${bad}\n`);
    const fromFile = raised(() => f.loadStaffKey({ ...f.SERVER, staffKeyFile: file }, DATA));
    assert.equal(fromFile.message, 'La clé de KARAOKE_STAFF_KEY_FILE doit compter au moins 22 caractères parmi A-Z, a-z, 0-9, - et _.', bad);
    const d = harness({ files: { 'data/staff-key': `${bad}\n` } });
    const fromData = raised(() => d.loadStaffKey({ ...d.SERVER, staffKeyFile: null }, DATA));
    assert.equal(fromData.message, 'data/staff-key ne contient pas une clé valable (au moins 22 caractères parmi A-Z, a-z, 0-9, - et _) : remplace-la avec node server.js --rotate-staff-key.', bad);
    for (const error of [fromFile, fromData]) assert.equal(error.message.includes(bad), false, `${bad} jamais cité`);
    nothingCreated(d, bad);
  }

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

  // Adresse envoyée par la page du bar : refusée depuis #25 (T10) ; une autre
  // valeur de settings.baseUrl reste sans effet sur les QR.
  const sent = await post(f, withKey('/api/staff/settings', FILE_KEY), { baseUrl: 'https://autre.exemple.fr' });
  assert.equal(sent.status, 400, sent.text);
  f.settings.baseUrl = 'https://autre.exemple.fr';
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

// ================================================================ issue #25
// Commandes de clé, adresse des QR fixée, adresse des téléphones, cookies,
// en-têtes et délais du mode serveur.
const COMMAND_ENV = { KARAOKE_MODE: 'server', KARAOKE_PUBLIC_URL: 'https://clients.exemple.fr',
  KARAOKE_STAFF_URL: 'https://bar.exemple.fr', KARAOKE_STAFF_KEY_FILE: KEY_FILE };
const without = (env, ...names) => Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));
const sha8 = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
const refusal = reason => ({ code: 1, stdout: '', stderr: `Commande impossible : ${reason}\n` });
const ROTATED = key => ({ code: 0, stderr: '', stdout: `Nouvelle clé du bar écrite dans data/staff-key (empreinte ${sha8(key)}). ` +
  'Redémarre la file pour l’appliquer, puis donne aux gérants le lien de --print-staff-url : l’ancien lien ne marche plus.\n' });
const TEMPORARY_KEY = path.join(DATA, `staff-key.${process.pid}.tmp`);
const SECURITY_HEADERS = { 'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY', 'content-security-policy': 'frame-ancestors \'none\'' };

// État complet du disque en mémoire (data/ et journal/) et du fichier de clé du test.
const diskState = g => ({ writes: g.memory.writes.length, mkdirs: g.memory.mkdirs.length,
  disk: [...g.memory.disk.entries()].map(([file, data]) => `${file}=${data}`).sort(), keyFile: fs.readFileSync(KEY_FILE, 'utf8') });
// Opérations de fichier faites par le bac à sable, dans l'ordre ; unlinkSync
// d'un fichier absent lève ENOENT, comme le vrai disque.
function traceDisk(g) {
  const ops = [];
  const memFs = g.memory.memFs;
  for (const name of ['mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync']) {
    const real = memFs[name];
    memFs[name] = (...args) => {
      ops.push([name, ...args.map(value => value && typeof value === 'object' ? plain(value) : value)]);
      if (name === 'unlinkSync' && !g.memory.disk.has(args[0])) throw Object.assign(new Error(`ENOENT: ${args[0]}`), { code: 'ENOENT' });
      return real(...args);
    };
  }
  return ops;
}

// ---------------------------------------------------------------- 6. commandes ponctuelles
test('T7 commandes ponctuelles (harnais) : sorties exactes, clé écrite à côté puis renommée', () => {
  const f = harness();
  const run = (argv, env, g = f) => plain(g.staffKeyCommand(argv, env, DATA));
  for (const argv of [[], ['--server'], ['--port', '3230', '--demo'], ['--print-staff-urls'], ['print-staff-url']]) {
    assert.equal(f.staffKeyCommand(argv, COMMAND_ENV, DATA), null, `sans option : ${argv.join(' ')}`);
  }

  // Refus, dans l'ordre du tableau : rien n'est écrit, ni data/ ni journal/ ni le fichier de clé.
  const both = 'choisis --print-staff-url ou --rotate-staff-key, pas les deux.';
  const unknownMode = 'KARAOKE_MODE vaut « serveur » : seule la valeur server est reconnue (retire la variable pour le mode PC).';
  const pcMode = '--print-staff-url et --rotate-staff-key ne servent qu’en mode serveur (--server ou KARAOKE_MODE=server).';
  const absent = path.join(keyDir, 'absente-commande');
  const pc = without(COMMAND_ENV, 'KARAOKE_MODE');
  const fileKey = 'la clé du bar vient de KARAOKE_STAFF_KEY_FILE ; change ce fichier, puis redémarre la file.';
  const refused = [
    [['--print-staff-url', '--rotate-staff-key'], COMMAND_ENV, both],
    [['--rotate-staff-key', '--server', '--print-staff-url'], {}, both],
    // « Pas les deux » passe avant une valeur inconnue de KARAOKE_MODE.
    [['--print-staff-url', '--rotate-staff-key'], { ...COMMAND_ENV, KARAOKE_MODE: 'serveur' }, both],
    [['--print-staff-url'], { ...COMMAND_ENV, KARAOKE_MODE: 'serveur' }, unknownMode],
    [['--server', '--rotate-staff-key'], { ...COMMAND_ENV, KARAOKE_MODE: 'serveur' }, unknownMode],
    [['--print-staff-url'], pc, pcMode],
    [['--rotate-staff-key'], { ...COMMAND_ENV, KARAOKE_MODE: '   ' }, pcMode],
    [['--port', '3230', '--print-staff-url'], {}, pcMode],
    [['--print-staff-url'], without(COMMAND_ENV, 'KARAOKE_PUBLIC_URL'),
      'KARAOKE_PUBLIC_URL manque : indique l’adresse HTTPS des QR clients, par exemple https://chant.exemple.fr.'],
    [['--server', '--rotate-staff-key'], { ...pc, KARAOKE_STAFF_URL: 'https://clients.exemple.fr' },
      'KARAOKE_STAFF_URL doit différer de KARAOKE_PUBLIC_URL : la page du bar n’est jamais servie par l’adresse des clients.'],
    [['--print-staff-url'], { ...COMMAND_ENV, KARAOKE_STAFF_KEY_FILE: absent }, `KARAOKE_STAFF_KEY_FILE illisible (${absent} : ENOENT).`],
    [['--rotate-staff-key'], COMMAND_ENV, fileKey],
    [['--server', '--rotate-staff-key'], pc, fileKey],
  ];
  for (const [argv, env, reason] of refused) {
    const before = diskState(f);
    assert.deepEqual(run(argv, env), refusal(reason), argv.join(' '));
    assert.deepEqual(diskState(f), before, `${argv.join(' ')} : rien n’est touché`);
  }
  // data/staff-key abîmée : --print-staff-url refuse sans la remplacer.
  const damaged = harness({ files: { 'data/staff-key': 'abc\n' } });
  const damagedBefore = diskState(damaged);
  assert.deepEqual(run(['--print-staff-url'], without(COMMAND_ENV, 'KARAOKE_STAFF_KEY_FILE'), damaged), refusal(
    'data/staff-key ne contient pas une clé valable (au moins 22 caractères parmi A-Z, a-z, 0-9, - et _) : remplace-la avec node server.js --rotate-staff-key.'));
  assert.deepEqual(diskState(damaged), damagedBefore);

  // --print-staff-url : lien du bar sur l'origine de KARAOKE_STAFF_URL, quelle que soit la place de l'option.
  for (const [argv, env] of [[['--print-staff-url'], COMMAND_ENV], [['--port', '3230', '--print-staff-url'], COMMAND_ENV],
    [['--server', '--print-staff-url'], pc], [['--print-staff-url'], { ...COMMAND_ENV, KARAOKE_MODE: ' server ' }],
    [['--print-staff-url'], { ...COMMAND_ENV, KARAOKE_STAFF_URL: 'https://Bar.Exemple.fr/' }]]) {
    const before = diskState(f);
    assert.deepEqual(run(argv, env), { code: 0, stdout: `https://bar.exemple.fr/staff?key=${FILE_KEY}\n`, stderr: '' }, argv.join(' '));
    assert.deepEqual(diskState(f), before, `${argv.join(' ')} : rien n’est écrit`);
  }
  // Sans fichier de clé : data/staff-key créée au premier appel, puis la même clé.
  const fresh = harness();
  const noFile = without(COMMAND_ENV, 'KARAOKE_STAFF_KEY_FILE');
  const printed = run(['--print-staff-url'], noFile, fresh);
  const created = fresh.memory.disk.get(STAFF_KEY_FILE_IN_DATA);
  assert.match(created, /^[A-Za-z0-9_-]{22}\n$/);
  assert.deepEqual(printed, { code: 0, stdout: `https://bar.exemple.fr/staff?key=${created.trim()}\n`, stderr: '' });
  assert.deepEqual(plain(fresh.memory.mkdirs.at(-1)).options, { recursive: true });
  const writes = fresh.memory.writes.length;
  assert.deepEqual(run(['--print-staff-url'], noFile, fresh), printed, 'même lien ensuite');
  assert.equal(fresh.memory.writes.length, writes, 'aucune écriture de plus');

  // --rotate-staff-key sur un disque sans data/staff-key : dossier, fichier temporaire 0600 en wx, renommage.
  const r = harness();
  assert.equal(r.memory.disk.has(STAFF_KEY_FILE_IN_DATA), false);
  const ops = traceDisk(r);
  const rotated = run(['--rotate-staff-key'], noFile, r);
  const written = r.memory.disk.get(STAFF_KEY_FILE_IN_DATA);
  assert.match(written, /^[A-Za-z0-9_-]{22}\n$/);
  assert.deepEqual(rotated, ROTATED(written.trim()), 'empreinte de la clé écrite');
  assert.deepEqual(ops, [
    ['mkdirSync', DATA, { recursive: true }],
    ['unlinkSync', TEMPORARY_KEY],
    ['writeFileSync', TEMPORARY_KEY, written, { mode: 0o600, flag: 'wx' }],
    ['renameSync', TEMPORARY_KEY, STAFF_KEY_FILE_IN_DATA],
  ]);
  assert.equal(r.memory.disk.has(TEMPORARY_KEY), false, 'aucun fichier temporaire laissé');
  assert.equal(rotated.stdout.includes(written.trim()), false, 'la clé n’est pas affichée');
  const loaded = r.loadStaffKey({ ...r.SERVER, staffKeyFile: null }, DATA);
  assert.deepEqual([loaded.key, loaded.source], [written.trim(), 'data/staff-key'], 'relue par loadStaffKey au démarrage suivant');
  // Seconde rotation : autre clé ; l'ancienne n'est pas lue (abîmée ici), un
  // temporaire du même numéro de processus (conteneur relancé) est retiré.
  const again = harness({ files: { 'data/staff-key': 'abc\n', [`data/staff-key.${process.pid}.tmp`]: 'reste\n' } });
  const againOut = run(['--server', '--rotate-staff-key'], without(noFile, 'KARAOKE_MODE'), again);
  const next = again.memory.disk.get(STAFF_KEY_FILE_IN_DATA);
  assert.match(next, /^[A-Za-z0-9_-]{22}\n$/);
  assert.notEqual(next, written);
  assert.deepEqual(againOut, ROTATED(next.trim()));
  assert.equal(again.memory.disk.has(TEMPORARY_KEY), false);
  assert.equal(again.rotateStaffKey(DATA), again.memory.disk.get(STAFF_KEY_FILE_IN_DATA).trim(), 'rotateStaffKey rend la clé écrite');

  // Écriture impossible : raison exacte (code, sinon message), data/staff-key intacte, rien de temporaire.
  for (const [failure, reason] of [[Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }), 'EACCES'],
    [new Error('disque en panne'), 'disque en panne']]) {
    const g = harness({ files: { 'data/staff-key': `${FILE_KEY}\n` } });
    g.memory.beforeWrite = () => { throw failure; };
    assert.deepEqual(run(['--rotate-staff-key'], noFile, g), refusal(`data/staff-key impossible à écrire (${reason}).`));
    assert.equal(g.memory.disk.get(STAFF_KEY_FILE_IN_DATA), `${FILE_KEY}\n`, `${reason} : ancienne clé intacte`);
    assert.equal(g.memory.disk.has(TEMPORARY_KEY), false);
  }
  const blocked = harness();
  traceDisk(blocked);
  blocked.memory.memFs.renameSync = () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); };
  assert.deepEqual(run(['--rotate-staff-key'], noFile, blocked), refusal('data/staff-key impossible à écrire (EBUSY).'));
  assert.equal(blocked.memory.disk.has(TEMPORARY_KEY), false, 'temporaire retiré après un renommage impossible');
  assert.equal(blocked.memory.disk.has(STAFF_KEY_FILE_IN_DATA), false);
  const locked = harness();
  const lockedWrites = locked.memory.writes.length;
  locked.memory.memFs.unlinkSync = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
  assert.deepEqual(run(['--rotate-staff-key'], noFile, locked), refusal('data/staff-key impossible à écrire (EPERM).'));
  assert.equal(locked.memory.writes.length, lockedWrites, 'rien d’écrit si l’ancien temporaire reste');
});

// ---------------------------------------------------------------- 7. adresse des QR fixée
test('T10 adresse des QR non modifiable depuis la page du bar, autres réglages non appliqués', async () => {
  const f = harness();
  const message = 'L’adresse des QR vient de KARAOKE_PUBLIC_URL sur ce serveur : elle ne se change pas depuis la page du bar.';
  const settingsUrl = withKey('/api/staff/settings', FILE_KEY);
  const gap = f.sched.opts.gap;
  assert.notEqual(gap, 9);
  for (const baseUrl of ['https://autre.exemple.fr', null, '', 'http://clients.exemple.fr', '   ', 'https://clients.exemple.fr/x', 42]) {
    const label = JSON.stringify(baseUrl);
    const r = await post(f, settingsUrl, { baseUrl, gap: 9 });
    assert.equal(r.status, 400, label);
    assert.deepEqual(r.body, { error: message, code: null }, label);
    assert.equal(f.settings.baseUrl, 'https://clients.exemple.fr', `${label} : adresse inchangée`);
    assert.equal(f.sched.opts.gap, gap, `${label} : gap: 9 non appliqué`);
  }
  // La même adresse est acceptée et ne change rien ; le reste de la requête s'applique.
  for (const baseUrl of ['https://clients.exemple.fr', 'https://clients.exemple.fr/', ' HTTPS://Clients.Exemple.fr ']) {
    const r = await post(f, settingsUrl, { baseUrl });
    assert.equal(r.status, 200, `${baseUrl} : ${r.text}`);
    assert.equal(f.settings.baseUrl, 'https://clients.exemple.fr');
  }
  assert.equal((await post(f, settingsUrl, { baseUrl: 'https://clients.exemple.fr', gap: 9 })).status, 200);
  assert.equal(f.sched.opts.gap, 9);
  assert.equal((await post(f, settingsUrl, { gap: 5 })).status, 200, 'réglage sans adresse');
  assert.equal(f.sched.opts.gap, 5);
  // Options par défaut : l'adresse des QR reste celle du serveur.
  const reset = await post(f, withKey('/api/staff/settings-reset', FILE_KEY), { confirmation: 'OPTIONS PAR DÉFAUT' });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(f.settings.baseUrl, 'https://clients.exemple.fr');
  // Témoin : le harnais PC change toujours d'adresse.
  const pc = harness({ serverEnv: false });
  const changed = await post(pc, withKey('/api/staff/settings', pc.STAFF_KEY), { baseUrl: 'https://autre.exemple.fr' });
  assert.equal(changed.status, 200);
  assert.equal(pc.settings.baseUrl, 'https://autre.exemple.fr');
});

test('T11 avertissement data/tables.json : texte exact, null sans écart', () => {
  const tables = baseUrl => ({ version: 1, ...(baseUrl === undefined ? {} : { baseUrl }), tables: [] });
  const warning = (files, options = {}) => harness({ persistent: true, files, ...options }).printedBaseUrlWarning();
  const now = 'QR désormais créés pour https://clients.exemple.fr.';
  const other = old => `Attention : data/tables.json indiquait ${old} pour les QR. Les QR déjà imprimés avec cette adresse ne mènent pas à ce serveur. ${now}`;
  const none = `Attention : data/tables.json n’indiquait aucune adresse publique (QR du Wi-Fi local). Les QR déjà imprimés ne mènent pas à ce serveur. ${now}`;
  const longRefused = `http://${'a'.repeat(300)}.exemple.fr`;
  for (const [baseUrl, expected] of [
    ['https://ancien.exemple.fr', other('https://ancien.exemple.fr')],
    ['https://Ancien.Exemple.fr/', other('https://ancien.exemple.fr')],
    ['http://192.168.1.20:3000', other('http://192.168.1.20:3000')],
    ['http://ancien.exemple.fr', other('http://ancien.exemple.fr')],
    [longRefused, other(longRefused.slice(0, 200))],
    [null, none], [undefined, none], ['', none],
    ['https://clients.exemple.fr', null], ['https://clients.exemple.fr/', null],
  ]) {
    assert.equal(warning({ 'data/tables.json': tables(baseUrl) }), expected, JSON.stringify(baseUrl));
  }
  assert.equal(warning({}), null, 'fichier absent');
  assert.equal(warning({ 'data/tables.json': '{ pas du json' }), null, 'JSON invalide');
  const old = { 'data/tables.json': tables('https://ancien.exemple.fr') };
  assert.equal(harness({ files: old }).printedBaseUrlWarning(), null, 'démo');
  assert.equal(warning(old, { serverEnv: false }), null, 'harnais PC');
});

// ---------------------------------------------------------------- 8. cookies, en-têtes, délais
test('T12 cookie « En solo » Secure sur les deux ports', async () => {
  const format = /^karaoke_solo_device=[A-Za-z0-9_-]{32}; Path=\/; Max-Age=7776000; HttpOnly; SameSite=Lax; Secure$/;
  const f = harness();
  f.ensureSoloGroup();
  const tb = { table: 'Comptoir', access: f.access.get('Comptoir') };
  for (const [port, name] of [[f.PORT, 'Testeur'], [f.PUBLIC_PORT, 'Testeuse']]) {
    const invitation = f.soloInvitations.issue('Comptoir').token;
    const r = await post(f, '/api/table/person', { ...tb, name, invitation }, { port, remote: '172.18.0.5' });
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers['set-cookie'], format, port === f.PORT ? 'PORT' : 'PUBLIC_PORT');
  }
  // Témoin : en mode PC, le port du Wi-Fi garde un cookie sans Secure.
  const pc = harness({ serverEnv: false });
  pc.ensureSoloGroup();
  const pcTb = { table: 'Comptoir', access: pc.access.get('Comptoir') };
  const lan = await post(pc, '/api/table/person', { ...pcTb, name: 'Testeur', invitation: pc.soloInvitations.issue('Comptoir').token },
    { remote: '192.168.1.30' });
  assert.equal(lan.status, 200, lan.text);
  assert.match(lan.headers['set-cookie'], /; HttpOnly; SameSite=Lax$/);
});

// Requête qui accepte gzip (le faux `res` de call() n'a pas de `req`).
function callGzip(f, url) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'GET', url, headers: { 'accept-encoding': 'gzip' },
      socket: { remoteAddress: '172.18.0.5', localPort: f.PORT }, destroy() {} });
    const out = { status: null, headers: {} };
    const res = { req, setHeader(name, value) { out.headers[name.toLowerCase()] = value; },
      getHeader(name) { return out.headers[name.toLowerCase()]; }, hasHeader(name) { return name.toLowerCase() in out.headers; },
      removeHeader(name) { delete out.headers[name.toLowerCase()]; },
      writeHead(status, headers = {}) {
        out.status = status;
        for (const [name, value] of Object.entries(headers)) out.headers[name.toLowerCase()] = value;
      },
      end(data) { out.data = data; resolve(out); } };
    f.handle(req, res);
    setImmediate(() => req.emit('end'));
  });
}

test('T13 en-têtes de sécurité sur toutes les réponses du mode serveur, aucun en mode PC', async () => {
  const routes = (g, key) => {
    g.sched.table('1').headcount = 4;
    const secret = g.access.issue('1');
    return [['GET', '/', 403], ['GET', `/t/1/${secret}`, 200], ['GET', withKey('/staff', key), 200],
      ['GET', withKey('/api/staff/state', key), 200], ['GET', '/api/state?table=1&access=faux', 403], ['GET', '/app.css', 200],
      ['GET', '/inconnu', 404], ['POST', '/api/inconnu', 404], ['PUT', '/', 405]];
  };
  const f = harness();
  for (const [method, url, status] of routes(f, FILE_KEY)) {
    const label = `${method} ${url.replace(/key=[^&]+/, 'key=…')}`;
    const r = await call(f, method, url, { remote: '172.18.0.5' });
    assert.equal(r.status, status, label);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers[name], value, `${label} : ${name}`);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', `${label} : en-têtes habituels gardés`);
    const viaClients = await call(f, method, url, { remote: '172.18.0.5', port: f.PUBLIC_PORT });
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(viaClients.headers[name], value, `${label} sur PUBLIC_PORT : ${name}`);
  }
  // Réponse compressée : les mêmes en-têtes.
  const zipped = await callGzip(f, withKey('/api/staff/state', FILE_KEY));
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(zipped.headers[name], value, `gzip : ${name}`);
  // Harnais PC : aucun des quatre.
  const pc = harness({ serverEnv: false });
  for (const [method, url, status] of routes(pc, pc.STAFF_KEY)) {
    const label = `PC ${method} ${url.replace(/key=[^&]+/, 'key=…')}`;
    const r = await call(pc, method, url, { remote: '172.18.0.5' });
    assert.equal(r.status, status, label);
    for (const name of Object.keys(SECURITY_HEADERS)) assert.equal(name in r.headers, false, `${label} : ${name}`);
  }
});

test('T14 proxy de confiance : chaque téléphone compté par x-real-ip, sur les deux ports', async () => {
  const f = harness();
  f.ensureSoloGroup();
  const tb = { table: 'Comptoir', access: f.access.get('Comptoir') };
  const secret = f.privateEvent.enable();
  const enter = (ip, port) => post(f, '/api/table/enter', { ...tb, event: secret },
    { port, remote: '172.18.0.5', headers: { 'x-real-ip': ip } });
  for (let i = 1; i <= 8; i++) assert.equal((await enter(`203.0.113.${i}`, f.PUBLIC_PORT)).status, 200, `invité ${i}`);
  for (let i = 1; i <= 30; i++) assert.equal((await enter('198.51.100.7', f.PUBLIC_PORT)).status, 200, `entrée ${i} du même téléphone`);
  const busy = await enter('198.51.100.7', f.PUBLIC_PORT);
  assert.equal(busy.status, 429);
  assert.equal(busy.body.code, 'PRIVATE_EVENT_BUSY');
  assert.ok(Number(busy.headers['retry-after']) >= 1);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(busy.headers[name], value, `429 : ${name}`);
  const sameOnBar = await enter('198.51.100.7', f.PORT);
  assert.equal(sameOnBar.status, 429, 'même téléphone par le port du bar');
  assert.equal(sameOnBar.body.code, 'PRIVATE_EVENT_BUSY');
  assert.equal((await enter('203.0.113.9', f.PORT)).status, 200, 'un autre téléphone entre toujours');
});

test('T15 en-tête cru seulement d’un proxy de confiance, et seulement s’il porte une adresse IP', async () => {
  // Un harnais neuf par cas (120 créations par minute pour tout le bar) ;
  // entrées alternées entre PUBLIC_PORT et PORT.
  const statuses = async ({ env = {}, remote, headers }) => {
    const f = harness({ env });
    f.ensureSoloGroup();
    const tb = { table: 'Comptoir', access: f.access.get('Comptoir') };
    const secret = f.privateEvent.enable();
    const out = [];
    for (let i = 1; i <= 31; i++) {
      const r = await post(f, '/api/table/enter', { ...tb, event: secret },
        { port: i % 2 ? f.PUBLIC_PORT : f.PORT, remote, headers: headers(i) });
      out.push(r.status === 429 ? r.body.code : r.status);
    }
    return out;
  };
  const counted = [...Array(30).fill(200), 'PRIVATE_EVENT_BUSY'];
  const believed = Array(31).fill(200);
  const varying = i => ({ 'x-real-ip': `203.0.113.${i}` });
  const cases = [
    ['socket 198.51.100.20 hors liste', { remote: '198.51.100.20', headers: varying }, counted],
    ['socket 127.0.0.1, seulement cf-connecting-ip', { remote: '127.0.0.1', headers: i => ({ 'cf-connecting-ip': `203.0.113.${i}` }) }, counted],
    ['x-real-ip « abc »', { remote: '172.18.0.5', headers: () => ({ 'x-real-ip': 'abc' }) }, counted],
    ['x-real-ip « abc<n> »', { remote: '172.18.0.5', headers: i => ({ 'x-real-ip': `abc${i}` }) }, counted],
    ['x-real-ip « 203.0.113.9, 10.0.0.1 »', { remote: '172.18.0.5', headers: () => ({ 'x-real-ip': '203.0.113.9, 10.0.0.1' }) }, counted],
    ['x-real-ip « 203.0.113.<n>, 10.0.0.1 »', { remote: '172.18.0.5', headers: i => ({ 'x-real-ip': `203.0.113.${i}, 10.0.0.1` }) }, counted],
    ['KARAOKE_CLIENT_IP_HEADER retirée', { env: { KARAOKE_CLIENT_IP_HEADER: undefined }, remote: '172.18.0.5', headers: varying }, counted],
    ['liste 10.1.0.0/16, socket 172.18.0.5', { env: { KARAOKE_TRUSTED_PROXIES: '10.1.0.0/16' }, remote: '172.18.0.5', headers: varying }, counted],
    ['liste 10.1.0.0/16, socket 10.1.2.3', { env: { KARAOKE_TRUSTED_PROXIES: '10.1.0.0/16' }, remote: '10.1.2.3', headers: varying }, believed],
    ['liste par défaut, socket ::ffff:172.18.0.5', { remote: '::ffff:172.18.0.5', headers: varying }, believed],
    // Proxy en IPv6 pur (::1/128 et fc00::/7 de la liste par défaut), contrôlé en ipv6.
    ['liste par défaut, socket ::1', { remote: '::1', headers: varying }, believed],
    ['liste par défaut, socket fd00::5', { remote: 'fd00::5', headers: varying }, believed],
    ['socket 2001:db8::7 hors liste', { remote: '2001:db8::7', headers: varying }, counted],
    ['KARAOKE_CLIENT_IP_HEADER=CF-Connecting-IP, socket 127.0.0.1', { env: { KARAOKE_CLIENT_IP_HEADER: 'CF-Connecting-IP' },
      remote: '127.0.0.1', headers: i => ({ 'cf-connecting-ip': `2001:db8:${i}::1` }) }, believed],
  ];
  for (const [label, options, expected] of cases) assert.deepEqual(await statuses(options), expected, label);

  // L'adresse rendue elle-même.
  const f = harness();
  const address = (remote, headers = {}) => f.serverClientAddress({ socket: { remoteAddress: remote }, headers });
  assert.equal(address('172.18.0.5', { 'x-real-ip': ' 203.0.113.5 ' }), '203.0.113.5', 'espaces retirés');
  assert.equal(address('172.18.0.5', { 'x-real-ip': '2001:db8::5' }), '2001:db8::5');
  const zone = `fe80::1%${'a'.repeat(100)}`;
  assert.equal(address('172.18.0.5', { 'x-real-ip': zone }), zone.slice(0, 64), 'coupée à 64 caractères');
  assert.equal(address('172.18.0.5'), '172.18.0.5', 'en-tête absent');
  assert.equal(address('203.0.113.200', { 'x-real-ip': '198.51.100.1' }), '203.0.113.200', 'proxy hors liste');
  assert.equal(address('pas-une-adresse', { 'x-real-ip': '198.51.100.1' }), 'pas-une-adresse');
  assert.equal(address(undefined, { 'x-real-ip': '198.51.100.1' }), '');
  assert.equal(f.serverClientAddress({ headers: { 'x-real-ip': '198.51.100.1' } }), '', 'sans socket');
});

test('T16 délais keep-alive au-dessus du keepalive du relais HTTPS, sur les deux serveurs', () => {
  const f = harness();
  for (const [name, listener] of [['server', f.server], ['publicServer', f.publicServer]]) {
    assert.equal(listener.keepAliveTimeout, 65000, name);
    assert.equal(listener.headersTimeout, 66000, name);
  }
  const pc = harness({ serverEnv: false });
  for (const [name, listener] of [['server', pc.server], ['publicServer', pc.publicServer]]) {
    assert.equal(listener.keepAliveTimeout, 5000, `PC ${name}`);
    assert.equal(listener.headersTimeout, 60000, `PC ${name}`);
  }
});

// ---------------------------------------------------------------- textes (#28)
test('TX3 options du pont KaraFun selon le mode', () => {
  for (const [label, f, appMode] of [['mode PC', harness({ persistent: true, serverEnv: false }), 'pc'],
    ['mode serveur', harness({ persistent: true }), 'server']]) {
    const options = f.karafunBridgeOptions();
    assert.deepEqual(plain(options), { logDir: path.join(root, 'journal'), identityFile: path.join(DATA, 'karafun-login.json'),
      budgetFile: path.join(DATA, 'karafun-pages.json'), lockOwner: { port: f.PORT }, appMode }, label);
    assert.equal('bases' in options, true, `${label} : bases présent`);
    assert.equal(options.bases, undefined, `${label} : sites KaraFun par défaut`);
    assert.equal(typeof options.log, 'function', `${label} : journal du serveur`);
  }
});

test('TX4 port du bar occupé : message selon le mode', () => {
  const pc = harness({ serverEnv: false });
  assert.equal(pc.portInUseMessage(), `Le port ${pc.PORT} est déjà utilisé : le programme tourne peut-être déjà dans une autre fenêtre.`);
  const f = harness();
  assert.equal(f.portInUseMessage(), `Le port ${f.PORT} est déjà utilisé : une autre instance de la file tourne peut-être déjà sur ce serveur.`);
  assert.doesNotMatch(f.portInUseMessage(), /fenêtre/);
});

// TX3 prouve karafunBridgeOptions() seule : ici, « Connecter » du bar crée le
// pont avec ces options (appMode compris), une seule fois. Pont espion sans
// réseau ni fichier : connect() ne contacte rien.
test('TX3b « Connecter » crée le pont KaraFun avec karafunBridgeOptions()', async () => {
  const karafun = fromServer('./karafun');
  for (const [label, serverEnv, appMode] of [['mode PC', false, 'pc'], ['mode serveur', true, 'server']]) {
    const seen = [];
    class SpyBridge extends karafun.KaraFunBridge {
      constructor(options) {
        seen.push(options);
        super({ ...options, bases: ['https://kf.exemple.invalid'], logDir: null, identityFile: null, budgetFile: null, lockOwner: null });
      }
      connect() { return undefined; }
    }
    const f = harness({ persistent: true, serverEnv, modules: { './karafun': { ...karafun, KaraFunBridge: SpyBridge } } });
    for (const code of ['123456', '654321']) {
      const r = await post(f, withKey('/api/staff/connect', f.STAFF_KEY), { code });
      assert.equal(r.status, 200, `${label} : ${r.text}`);
      assert.deepEqual(r.body, { ok: true, kept: false }, label);
    }
    assert.equal(seen.length, 1, `${label} : un seul pont`);
    assert.deepEqual(plain(seen[0]), plain(f.karafunBridgeOptions()), `${label} : options de karafunBridgeOptions()`);
    assert.equal(seen[0].appMode, appMode, `${label} : mode transmis au pont`);
    assert.equal(typeof seen[0].log, 'function', `${label} : journal du serveur`);
  }
});
