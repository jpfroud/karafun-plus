'use strict';
// Routes des téléphones (pages de table) et aides du serveur jamais exercées
// par la suite : téléphone attaché à une personne « En solo », transfert d'un
// chanteur vers un autre téléphone, adresse publique des QR, fichier des
// tables, échec de la sauvegarde de soirée, limite des paroles et routes
// « POST /api/table/* ».
//
// Le serveur est chargé dans un bac à sable `vm` (comme dans
// review-v04-fixes.test.js) sans écouter de port : chaque requête passe par
// le gestionnaire HTTP du serveur avec une fausse requête et une fausse
// réponse. Le disque (data/, journal/) est en mémoire ; la sauvegarde de
// soirée est remplacée par un faux magasin qui peut échouer à la demande.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

// ---------------------------------------------------------------- harnais
// Disque en mémoire pour data/ et journal/ ; le reste (pages, package.json)
// est lu sur le vrai disque, jamais écrit.
function memoryDisk(files = {}) {
  const disk = new Map(Object.entries(files).map(([rel, value]) =>
    [path.join(root, rel), typeof value === 'string' ? value : JSON.stringify(value)]));
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
  const journal = () => [...disk].filter(([file]) => file.startsWith(path.join(root, 'journal')))
    .map(([, text]) => text).join('');
  return { disk, memFs, journal, read: rel => disk.get(path.join(root, rel)) };
}

// Faux magasin de la soirée : garde chaque instantané, ou échoue avec `fail`.
function fakeNightStore() {
  const control = { saves: [], fail: null };
  class Store {
    constructor(prefix) { control.prefix = prefix; }
    load() { return null; }
    save(snapshot, { force = false } = {}) {
      if (control.fail) throw new Error(control.fail);
      control.saves.push({ snapshot: JSON.parse(JSON.stringify(snapshot)), force });
      return true;
    }
  }
  return { control, Store };
}

// `persistent` : serveur réel (sans --demo), avec disque en mémoire et faux
// magasin de soirée ; sinon mode démo, comme les autres tests.
function harness({ persistent = false, files = {} } = {}) {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const memory = memoryDisk(files);
  const night = fakeNightStore();
  const overrides = persistent ? {
    './night-state': { ...fromServer('./night-state'), NightStateStore: night.Store },
    // Jamais de moteur Java pendant ces tests.
    './scheduler': (() => {
      const real = fromServer('./scheduler');
      return { ...real, Scheduler: class extends real.Scheduler { constructor(o) { super({ ...o, solverEnabled: false }); } } };
    })(),
    // Le jeton Spotify n'est jamais lu ni écrit sur le vrai disque.
    './spotify': (() => {
      const real = fromServer('./spotify');
      return { ...real, SpotifyLink: class extends real.SpotifyLink { constructor(o) { super({ ...o, file: null }); } } };
    })(),
  } : {};
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), ...(persistent ? [] : ['--demo'])];
  const quietConsole = { ...console, log() {} };
  const context = { require: name => name === 'fs' ? memory.memFs : overrides[name] || fromServer(name),
    __dirname: root, process: fixtureProcess, console: quietConsole, Buffer, URL, setTimeout, clearTimeout,
    setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, getTracked: () => tracked, settings, access, soloInvitations, spotify, lyrics, staffState,
      normalizeBaseUrl, lyricsAllowed, transferSnapshot, restoreTransfers, personShareCodes, saveNight,
      saveTables, loadTables, ensureSoloGroup, presenceCandidate, STAFF_KEY, PORT, PUBLIC_PORT,
      handle: server.listeners('request')[0], setPending: p => { pending = p; }, setBridge: b => { bridge = b; } };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
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
        out.raw = data;
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
const post = (f, url, body, options = {}) => call(f, 'POST', url, { ...options, body });
const get = (f, url, options = {}) => call(f, 'GET', url, options);

// Table ordinaire prête (effectif connu) et son lien secret.
function openTable(f, id, headcount = 4) {
  f.sched.table(id).headcount = headcount;
  return { table: id, access: f.access.issue(id) };
}

async function joinTable(f, tb, name, options = {}) {
  const r = await post(f, '/api/table/person', { ...tb, name, ...(options.body || {}) }, options);
  assert.equal(r.status, 200, `inscription de ${name} : ${r.text}`);
  return { ...tb, personId: r.body.id, token: r.body.token, cookie: soloCookie(r) };
}

// Le cookie « En solo » posé par le serveur, tel que le téléphone le renverra.
function soloCookie(r) {
  const header = r.headers['set-cookie'];
  return header ? String(header).split(';')[0] : null;
}

// Groupe « En solo » ouvert, et une invitation personnelle du bar.
function openSolo(f) {
  f.ensureSoloGroup();
  const id = [...f.sched.tables.values()].find(t => t.individual).id;
  return { tb: { table: id, access: f.access.get(id) }, invite: () => f.soloInvitations.issue(id).token };
}

const song = (songId, title, artist = 'Artiste') => ({ songId, title, artist });
const titles = (f, personId) => f.sched.songsOf(f.sched.people.get(personId)).map(s => s.title);
// Objets du bac à sable ramenés à des objets ordinaires pour les comparer.
const plain = value => JSON.parse(JSON.stringify(value));
const sha256hex = value => crypto.createHash('sha256').update(String(value)).digest('hex');

// ---------------------------------------------------------------- adresse publique des QR
test('adresse publique : origine HTTPS acceptée et ramenée à sa forme courte, vide = adresse locale', () => {
  const f = harness();
  assert.equal(f.normalizeBaseUrl(null), null);
  assert.equal(f.normalizeBaseUrl(''), null);
  assert.equal(f.normalizeBaseUrl('   '), null);
  assert.equal(f.normalizeBaseUrl(' https://Chant.Exemple.fr/ '), 'https://chant.exemple.fr');
  assert.equal(f.normalizeBaseUrl('https://chant.exemple.fr:8443'), 'https://chant.exemple.fr:8443');
  // HTTP seulement sur ce PC ou le Wi-Fi du bar.
  for (const local of ['http://localhost:3000', 'http://192.168.1.20:3000', 'http://10.0.0.5', 'http://172.16.0.1',
    'http://172.31.255.1', 'http://127.0.0.1:3000', 'http://169.254.10.1', 'http://[::1]:3000']) {
    assert.equal(f.normalizeBaseUrl(local), new URL(local).origin, local);
  }
});

test('adresse publique : formes refusées avec un message clair', () => {
  const f = harness();
  const refused = (value, message) => assert.throws(() => f.normalizeBaseUrl(value), { message }, value);
  refused('chant.exemple.fr', /^Adresse invalide : indique une origine HTTPS, par exemple https:\/\/chant\.exemple\.fr\.$/);
  for (const value of ['ftp://chant.exemple.fr', 'https://bar:secret@chant.exemple.fr', 'https://chant.exemple.fr/table',
    'https://chant.exemple.fr/?table=1', 'https://chant.exemple.fr/#file']) {
    refused(value, /^Indique seulement l’adresse de base, sans chemin, paramètres ni identifiants\.$/);
  }
  for (const value of ['http://chant.exemple.fr', 'http://172.32.0.1', 'http://8.8.8.8']) {
    refused(value, /^Une adresse accessible depuis Internet doit utiliser HTTPS\.$/);
  }
  for (const value of ['https://localhost', 'https://bar.localhost', 'https://pc-bar.local', 'https://pc.lan',
    'https://[::1]', 'https://192.168.1.20', 'https://10.1.2.3']) {
    refused(value, /^Pour les mobiles sans Wi-Fi, utilise un vrai nom de domaine public HTTPS\.$/);
  }
});

test('adresse publique : le bar la règle, les liens de transfert l’utilisent ; une adresse refusée ne change rien', async () => {
  const f = harness();
  const key = `?key=${f.STAFF_KEY}`;
  const before = f.settings.pushDelaySec;
  let r = await post(f, `/api/staff/settings${key}`, { baseUrl: 'http://chant.exemple.fr', pushDelaySec: 12 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Une adresse accessible depuis Internet doit utiliser HTTPS.');
  assert.equal(f.settings.baseUrl, null);
  assert.equal(f.settings.pushDelaySec, before, 'requête refusée : aucun réglage modifié');
  r = await post(f, `/api/staff/settings${key}`, { baseUrl: 'https://chant.exemple.fr/' });
  assert.equal(r.status, 200);
  assert.equal(f.settings.baseUrl, 'https://chant.exemple.fr');
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  r = await post(f, '/api/table/person/share', alice);
  assert.equal(r.status, 200);
  assert.match(r.body.url, new RegExp(`^https://chant\\.exemple\\.fr/t/1/${alice.access}\\?reprise=[A-Za-z0-9_-]{22}$`));
  // Effacer l'adresse revient à l'adresse locale du PC.
  r = await post(f, `/api/staff/settings${key}`, { baseUrl: '' });
  assert.equal(f.settings.baseUrl, null);
  r = await post(f, '/api/table/person/share', alice);
  assert.match(r.body.url, new RegExp(`^http://[^/]+:${f.PORT}/t/1/`));
});

// ---------------------------------------------------------------- fichier des tables
// Secrets factices de 22 caractères, au format des QR imprimés.
const SECRET_1 = 'AAAAAAAAAAAAAAAAAAAAAA';
const SECRET_SOLO = 'BBBBBBBBBBBBBBBBBBBBBB';

test('tables : premier démarrage, la table 1 et son QR sont créés et écrits sur le disque', () => {
  const f = harness({ persistent: true });
  f.loadTables();
  const saved = JSON.parse(f.memory.read('data/tables.json'));
  assert.equal(saved.version, 1);
  assert.equal(saved.baseUrl, null);
  assert.deepEqual(saved.tables.map(t => [t.id, t.headcount, t.individual]), [['1', null, false]]);
  assert.match(saved.tables[0].secret, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(saved.tables[0].secret, f.access.get('1'), 'le QR enregistré est celui que le serveur accepte');
  assert.equal(f.memory.read('data/tables.json.tmp'), undefined, 'écriture atomique : pas de fichier temporaire laissé');
});

test('tables : un redémarrage garde noms, effectifs, groupe « En solo », QR imprimés et adresse publique', async () => {
  const f = harness({ persistent: true, files: { 'data/tables.json': { version: 1, baseUrl: 'https://Chant.Exemple.fr/', tables: [
    { id: '1', name: '  Terrasse   du   fond ', headcount: 6, individual: false, secret: SECRET_1 },
    { id: 'Comptoir', name: 'En solo', headcount: null, individual: true, secret: SECRET_SOLO },
  ] } } });
  f.loadTables();
  assert.equal(f.settings.baseUrl, 'https://chant.exemple.fr');
  const t1 = f.sched.table('1', false);
  assert.deepEqual([t1.name, t1.headcount, t1.individual], ['Terrasse du fond', 6, false]);
  assert.equal(f.sched.table('Comptoir', false).individual, true);
  // Le QR déjà imprimé ouvre toujours la page de la table ; un autre secret non.
  let r = await get(f, `/t/1/${SECRET_1}`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.text, /<script>/);
  r = await get(f, `/t/1/${SECRET_SOLO}`);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'TABLE_ACCESS');
  // Effectif déjà connu : la table s'inscrit sans attendre le bar.
  await joinTable(f, { table: '1', access: SECRET_1 }, 'Alice');
  // Le fichier relu n'est pas réécrit tant que rien ne change.
  assert.equal(JSON.parse(f.memory.read('data/tables.json')).baseUrl, 'https://Chant.Exemple.fr/');
});

test('tables : fichier abîmé ou modifié à la main, démarrage refusé avec la raison', () => {
  const cases = [
    [{ version: 2, tables: [] }, /^Fichier des tables invalide$/],
    [{ version: 1 }, /^Fichier des tables invalide$/],
    [{ version: 1, tables: [{ id: '1', headcount: 0, secret: SECRET_1 }] }, /^Effectif invalide pour 1$/],
    [{ version: 1, tables: [{ id: '1', headcount: 41, secret: SECRET_1 }] }, /^Effectif invalide pour 1$/],
    [{ version: 1, tables: [{ id: '1', headcount: 2.5, secret: SECRET_1 }] }, /^Effectif invalide pour 1$/],
    [{ version: 1, tables: [{ id: '1', headcount: '3', secret: SECRET_1 }] }, /^Effectif invalide pour 1$/],
    [{ version: 1, tables: [{ id: '1', name: 'x'.repeat(41), headcount: 2, secret: SECRET_1 }] }, /^Nom de table invalide pour 1$/],
    [{ version: 1, tables: [{ id: '1', headcount: 2, secret: 'court' }] }, /^Secret de table invalide$/],
    [{ version: 1, tables: [{ id: 'a/b', headcount: 2, secret: SECRET_1 }] }, /^Identifiant de table invalide$/],
    [{ version: 1, baseUrl: 'http://chant.exemple.fr', tables: [] }, /doit utiliser HTTPS/],
  ];
  for (const [content, message] of cases) {
    const f = harness({ persistent: true, files: { 'data/tables.json': content } });
    assert.throws(() => f.loadTables(), { message }, JSON.stringify(content));
  }
  const f = harness({ persistent: true, files: { 'data/tables.json': '{ pas du JSON' } });
  assert.throws(() => f.loadTables(), { name: 'SyntaxError' });
});

test('tables : ce que le bar change est écrit et retrouvé au démarrage suivant ; rien n’est écrit en démo', async () => {
  const first = harness({ persistent: true });
  first.loadTables();
  first.sched.table('2').name = 'Terrasse';
  first.sched.table('2').headcount = 3;
  const secret2 = first.access.issue('2');
  const r = await post(first, `/api/staff/settings?key=${first.STAFF_KEY}`, { baseUrl: 'https://chant.exemple.fr' });
  assert.equal(r.status, 200);
  const saved = first.memory.read('data/tables.json');
  assert.equal(JSON.parse(saved).baseUrl, 'https://chant.exemple.fr');

  const second = harness({ persistent: true, files: { 'data/tables.json': saved } });
  second.loadTables();
  assert.equal(second.settings.baseUrl, 'https://chant.exemple.fr');
  assert.deepEqual([second.sched.table('2', false).name, second.sched.table('2', false).headcount], ['Terrasse', 3]);
  assert.equal((await get(second, `/t/2/${secret2}`)).status, 200, 'le QR de la table 2 reste valable');

  const demo = harness();
  demo.saveTables();
  await post(demo, `/api/staff/settings?key=${demo.STAFF_KEY}`, { baseUrl: 'https://chant.exemple.fr' });
  assert.equal(demo.memory.read('data/tables.json'), undefined);
});

// ---------------------------------------------------------------- sauvegarde de la soirée
test('sauvegarde en échec : inscription refusée et annulée, envoi automatique suspendu, bar prévenu', async () => {
  const f = harness({ persistent: true });
  f.loadTables();
  const tb = openTable(f, '1');
  f.settings.auto = true;
  f.night.fail = 'disque plein';
  let r = await post(f, '/api/table/person', { ...tb, name: 'Alice' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'disque plein');
  assert.equal(f.sched.people.size, 0, 'aucune inscription annoncée sans sauvegarde');
  assert.equal(f.settings.auto, false, 'envoi automatique suspendu');
  assert.match(f.memory.journal(), /ERREUR sauvegarde de soirée : disque plein\. Envoi automatique suspendu\./);
  r = await get(f, `/api/staff/state?key=${f.STAFF_KEY}`);
  assert.equal(r.body.persistenceError, 'disque plein');
  // Le bar ne peut pas relancer l'envoi tant que la sauvegarde échoue.
  r = await post(f, `/api/staff/settings?key=${f.STAFF_KEY}`, { auto: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Sauvegarde indisponible : l’envoi automatique reste suspendu.');
  assert.equal(f.settings.auto, false);
  // Disque revenu : l'inscription passe, l'alerte disparaît, l'envoi peut reprendre.
  f.night.fail = null;
  r = await post(f, '/api/table/person', { ...tb, name: 'Alice' });
  assert.equal(r.status, 200);
  assert.equal(f.staffState().persistenceError, null);
  const last = f.night.saves.at(-1).snapshot;
  assert.deepEqual(last.scheduler.people.map(p => p.name), ['Alice']);
  r = await post(f, `/api/staff/settings?key=${f.STAFF_KEY}`, { auto: true });
  assert.equal(r.status, 200);
  assert.equal(f.settings.auto, true);
});

test('sauvegarde : échec toléré hors inscription, double écriture pour une nouvelle soirée, transferts sans code en clair', async () => {
  const f = harness({ persistent: true });
  f.loadTables();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  const share = (await post(f, '/api/table/person/share', alice)).body;
  f.night.saves.length = 0;
  assert.equal(f.saveNight({ replaceBoth: true }), true);
  assert.deepEqual(f.night.saves.map(s => s.force), [false, true], 'les deux générations sont remplacées');
  const [transfer] = f.night.saves[0].snapshot.transfers;
  assert.equal(transfer.personId, alice.personId);
  assert.equal(transfer.hash, sha256hex(share.code), 'seule l’empreinte du code est sauvegardée');
  assert.equal(transfer.linkHash, sha256hex(new URL(share.url).searchParams.get('reprise')));
  assert.equal('code' in transfer, false);
  f.night.fail = 'disque débranché';
  f.settings.auto = true;
  assert.equal(f.saveNight(), false, 'sauvegarde de fond : pas d’exception');
  assert.equal(f.settings.auto, false);
  assert.throws(() => f.saveNight({ required: true }), /^Error: disque débranché$/);
  assert.equal(f.staffState().persistenceError, 'disque débranché');
});

test('sauvegarde en échec pendant un transfert : rien ne change, le code reste utilisable', async () => {
  const f = harness({ persistent: true });
  f.loadTables();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  const { code } = (await post(f, '/api/table/person/share', alice)).body;
  const logBefore = f.sched.log.length;
  f.night.fail = 'disque plein';
  let r = await post(f, '/api/table/person/claim', { table: alice.table, access: alice.access, personId: alice.personId, code });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'disque plein');
  assert.equal(f.sched.people.get(alice.personId).token, alice.token, 'l’ancien téléphone garde la main');
  assert.equal(f.sched.log.length, logBefore, 'aucun transfert annoncé');
  assert.equal(f.transferSnapshot()[0].attempts, 0, 'l’essai raté n’use pas le code');
  f.night.fail = null;
  r = await post(f, '/api/table/song', { ...alice, song: song(101, 'Encore là') });
  assert.equal(r.status, 200, 'ancien téléphone toujours valable');
  r = await post(f, '/api/table/person/claim', { table: alice.table, access: alice.access, personId: alice.personId, code });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.token, alice.token);
  r = await post(f, '/api/table/song', { ...alice, song: song(102, 'Trop tard') });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PERSON_ACCESS');
});

test('sauvegarde en échec à l’inscription « En solo » : pas de cookie, l’invitation reste valable', async () => {
  const f = harness({ persistent: true });
  f.loadTables();
  const { tb, invite } = openSolo(f);
  const invitation = invite();
  f.night.fail = 'disque plein';
  let r = await post(f, '/api/table/person', { ...tb, name: 'Zoé', invitation });
  assert.equal(r.status, 400);
  assert.equal(r.headers['set-cookie'], undefined, 'le téléphone n’est attaché à personne');
  assert.equal(f.sched.people.size, 0);
  assert.ok(f.soloInvitations.verify(invitation, tb.table), 'invitation non brûlée');
  f.night.fail = null;
  r = await post(f, '/api/table/person', { ...tb, name: 'Zoé', invitation });
  assert.equal(r.status, 200);
  assert.match(soloCookie(r), /^karaoke_solo_device=[A-Za-z0-9_-]{32}$/);
  assert.equal(f.soloInvitations.verify(invitation, tb.table), null, 'invitation consommée');
});

// ---------------------------------------------------------------- paroles
test('paroles : 20 demandes par minute et par table, la minute écoulée libère la place', () => {
  const f = harness();
  for (let i = 0; i < 20; i++) assert.equal(f.lyricsAllowed('1', 1000 + i), true, `demande ${i + 1}`);
  assert.equal(f.lyricsAllowed('1', 30000), false, '21e demande dans la minute');
  assert.equal(f.lyricsAllowed('2', 30000), true, 'une autre table n’est pas limitée');
  assert.equal(f.lyricsAllowed('1', 59999), false, 'les refus ne prolongent pas l’attente, la minute court toujours');
  // Fenêtre glissante : chaque demande libère sa place une minute plus tard.
  assert.equal(f.lyricsAllowed('1', 61000), true, 'une minute après la première demande');
  assert.equal(f.lyricsAllowed('1', 61000), false, 'une seule place libérée');
  assert.equal(f.lyricsAllowed('1', 61001), true, 'la deuxième demande expire à son tour');
  assert.equal(f.lyricsAllowed('1', 121001), true, 'deux minutes plus tard, tout est libre');
});

test('paroles : la page de table reçoit les paroles, puis « réessaie dans une minute » ; le bar a son propre quota', async () => {
  const f = harness();
  const tb = openTable(f, '1');
  const other = openTable(f, '2');
  const asked = [];
  f.lyrics.find = async query => {
    asked.push({ ...query });
    return { lines: ['Première ligne', 'Deuxième ligne'], url: 'https://paroles.exemple/chanson', exact: true };
  };
  const lyricsUrl = (t, extra = '') => `/api/lyrics?table=${t.table}&access=${t.access}${extra}`;
  let r = await get(f, lyricsUrl(tb, '&songId=42&title=%20Ma%20chanson%20&artist=%20Moi%20'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { lines: ['Première ligne', 'Deuxième ligne'], url: 'https://paroles.exemple/chanson',
    exact: true, unavailable: false });
  assert.deepEqual(asked, [{ songId: 42, title: 'Ma chanson', artist: 'Moi' }]);
  r = await get(f, `/api/lyrics?table=1&access=${other.access}&title=X`);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Lien de table invalide ou périmé. Scanne le QR code affiché à ta table.');
  r = await get(f, lyricsUrl(tb, '&title=%20%20'));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Titre manquant.');
  for (let i = 0; i < 18; i++) assert.equal((await get(f, lyricsUrl(tb, `&title=T${i}`))).status, 200);
  r = await get(f, lyricsUrl(tb, '&title=Encore'));
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'Trop de demandes de paroles : réessaie dans une minute.');
  assert.equal(asked.length, 19, 'la demande refusée ne part pas vers le site de paroles');
  assert.equal((await get(f, lyricsUrl(other, '&title=Encore'))).status, 200, 'autre table');
  r = await get(f, `/api/lyrics?key=${f.STAFF_KEY}&title=Encore`);
  assert.equal(r.status, 200, 'le bar n’a pas besoin du QR d’une table');
  // Site injoignable : le téléphone l'apprend sans erreur.
  f.lyrics.find = async () => ({ lines: null, url: 'https://paroles.exemple/recherche', exact: false, unavailable: true });
  r = await get(f, `/api/lyrics?key=${f.STAFF_KEY}&title=Encore`);
  assert.deepEqual(r.body, { lines: null, url: 'https://paroles.exemple/recherche', exact: false, unavailable: true });
});

// ---------------------------------------------------------------- « En solo » : un téléphone, une personne
const SOLO_COOKIE_FORMAT = /^karaoke_solo_device=[A-Za-z0-9_-]{32}; Path=\/; Max-Age=7776000; HttpOnly; SameSite=Lax$/;

test('« En solo » : invitation obligatoire, téléphone attaché par cookie, un seul inscrit par téléphone', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  let r = await post(f, '/api/table/person', { ...tb, name: 'Zoé' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'SOLO_INVITATION');
  assert.equal(r.body.error, 'Demande au bar une invitation personnelle pour t’inscrire en solo. Ce lien sert à consulter la file.');
  const invitation = invite();
  r = await post(f, '/api/table/person', { ...tb, name: 'Zoé', invitation });
  assert.equal(r.status, 200);
  assert.match(r.headers['set-cookie'], SOLO_COOKIE_FORMAT);
  const zoe = { ...tb, personId: r.body.id, token: r.body.token, cookie: soloCookie(r) };
  // L'invitation ne sert qu'une fois.
  r = await post(f, '/api/table/person', { ...tb, name: 'Yann', invitation });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'SOLO_INVITATION');
  // Même téléphone, nouvelle invitation : refusé.
  r = await post(f, '/api/table/person', { ...tb, name: 'Yann', invitation: invite() }, { cookie: zoe.cookie });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'SOLO_DEVICE_USED');
  assert.equal(r.body.error, 'Ce téléphone gère déjà une personne dans « En solo ». Chacun utilise son propre téléphone.');
  r = await post(f, '/api/join', { ...tb, name: 'Yann', invitation: invite() }, { cookie: zoe.cookie });
  assert.equal(r.body.code, 'SOLO_DEVICE_USED', 'ancienne route d’inscription aussi');
  // Par le tunnel HTTPS, le cookie n'est envoyé qu'en HTTPS.
  r = await post(f, '/api/table/person', { ...tb, name: 'Yann', invitation: invite() }, { port: f.PUBLIC_PORT });
  assert.equal(r.status, 200);
  assert.match(r.headers['set-cookie'], /; HttpOnly; SameSite=Lax; Secure$/);
  assert.deepEqual([...f.sched.people.values()].map(p => p.name), ['Zoé', 'Yann']);
});

test('« En solo » : seul le téléphone attaché modifie la liste ou lit la page de la personne', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const zoe = await joinTable(f, tb, 'Zoé', { body: { invitation: invite() } });
  const yann = await joinTable(f, tb, 'Yann', { body: { invitation: invite() } });
  const refused = async (cookie, message) => {
    const r = await post(f, '/api/table/song', { ...zoe, song: song(201, 'Volé') }, { cookie });
    assert.equal(r.status, 403, message);
    assert.equal(r.body.code, 'SOLO_DEVICE_ACCESS', message);
    assert.equal(r.body.error, 'Ce téléphone ne gère pas cette personne. Demande au bar un code de reprise si tu as changé de téléphone.');
  };
  await refused(undefined, 'sans cookie, même avec le jeton');
  await refused(yann.cookie, 'cookie d’une autre personne');
  await refused('karaoke_solo_device=court', 'cookie mal formé');
  await refused(`karaoke_solo_device=${'x'.repeat(31)}!`, 'caractère interdit');
  assert.deepEqual(titles(f, zoe.personId), []);
  let r = await post(f, '/api/table/song', { ...zoe, song: song(201, 'À moi') },
    { cookie: `theme=sombre; ${zoe.cookie}; lang=fr` });
  assert.equal(r.status, 200, 'le cookie est retrouvé parmi les autres');
  assert.deepEqual(titles(f, zoe.personId), ['À moi']);
  // Ancienne route par jeton : même contrôle.
  r = await post(f, '/api/song', { token: zoe.token, song: song(202, 'Remplacé') });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'SOLO_DEVICE_ACCESS');
  r = await post(f, '/api/song', { token: zoe.token, song: song(202, 'Remplacé') }, { cookie: zoe.cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(titles(f, zoe.personId), ['Remplacé']);
  // Page de la personne lue par son jeton seul.
  r = await get(f, `/api/state?token=${zoe.token}`);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'SOLO_DEVICE_ACCESS');
  r = await get(f, `/api/state?token=${zoe.token}`, { cookie: zoe.cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.managedIds, [zoe.personId]);
  assert.deepEqual(r.body.tablePeople.map(p => p.name), ['Zoé'], 'Yann n’apparaît pas sur le téléphone de Zoé');
  // Une table ordinaire n'utilise pas de cookie.
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  r = await get(f, `/api/state?token=${alice.token}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.managedIds, [alice.personId]);
});

test('« En solo » : page du groupe, le téléphone ne gère que sa personne et ne voit que sa reprise', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const zoe = await joinTable(f, tb, 'Zoé', { body: { invitation: invite() } });
  const yann = await joinTable(f, tb, 'Yann', { body: { invitation: invite() } });
  for (const p of [zoe, yann]) assert.equal((await post(f, '/api/table/person/share', p, { cookie: p.cookie })).status, 200);
  const page = `/api/state?table=${tb.table}&access=${tb.access}`;
  let r = await get(f, page);
  assert.deepEqual(r.body.recoveryPeople.map(p => p.name).sort(), ['Yann', 'Zoé'], 'nouveau téléphone : reprises proposées');
  assert.deepEqual(r.body.managedIds, []);
  assert.equal(r.body.soloInvitationReady, false);
  r = await get(f, `${page}&invitation=${invite()}`);
  assert.equal(r.body.soloInvitationReady, true, 'invitation valable annoncée à la page');
  r = await get(f, page, { cookie: zoe.cookie });
  assert.deepEqual(r.body.recoveryPeople.map(p => p.name), ['Zoé'], 'le téléphone de Zoé ne peut reprendre que Zoé');
  r = await get(f, `${page}&token=${yann.token}`, { cookie: zoe.cookie });
  assert.deepEqual(r.body.managedIds, [], 'le jeton de Yann ne suffit pas sur le téléphone de Zoé');
  r = await get(f, `${page}&token=${zoe.token}`, { cookie: zoe.cookie });
  assert.deepEqual(r.body.managedIds, [zoe.personId]);
});

test('« En solo » : reprise sur un nouveau téléphone, jamais sur celui d’une autre personne', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const zoe = await joinTable(f, tb, 'Zoé', { body: { invitation: invite() } });
  const yann = await joinTable(f, tb, 'Yann', { body: { invitation: invite() } });
  const { code } = (await post(f, '/api/table/person/share', yann, { cookie: yann.cookie })).body;
  const claim = { table: tb.table, access: tb.access, personId: yann.personId, code };
  let r = await post(f, '/api/table/person/claim', claim, { cookie: zoe.cookie });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'SOLO_DEVICE_USED');
  const invitation = invite();
  r = await post(f, '/api/table/person/claim', { ...claim, invitation });
  assert.equal(r.status, 200);
  assert.match(r.headers['set-cookie'], SOLO_COOKIE_FORMAT);
  assert.equal(f.soloInvitations.verify(invitation, tb.table), null, 'l’invitation apportée est consommée');
  const phone = { ...yann, token: r.body.token, cookie: soloCookie(r) };
  r = await post(f, '/api/table/song', { ...phone, song: song(301, 'Nouveau téléphone') }, { cookie: phone.cookie });
  assert.equal(r.status, 200);
  r = await post(f, '/api/table/song', { ...yann, song: song(302, 'Ancien jeton') }, { cookie: yann.cookie });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PERSON_ACCESS', 'l’ancien téléphone perd la main');
  assert.deepEqual(titles(f, yann.personId), ['Nouveau téléphone']);
});

// ---------------------------------------------------------------- transfert vers un autre téléphone
test('transfert : code et lien survivent à un redémarrage, seules leurs empreintes sont gardées', async () => {
  const f = harness();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  const r0 = await post(f, '/api/table/person/share', alice);
  assert.equal(r0.status, 200);
  const share = r0.body;
  assert.match(share.code, /^\d{4}$/);
  assert.equal(share.name, 'Alice');
  assert.match(share.qr, /^data:image\/png;base64,/);
  assert.ok(share.linkExpiresAt - share.expiresAt >= 19 * 60000, 'le lien dure plus longtemps que le code');
  const link = new URL(share.url).searchParams.get('reprise');
  const [row] = plain(f.transferSnapshot());
  assert.deepEqual(row, { personId: alice.personId, hash: sha256hex(share.code), expiresAt: share.expiresAt, attempts: 0,
    linkHash: sha256hex(link), linkExpiresAt: share.linkExpiresAt });
  // Redémarrage : seuls les éléments sauvegardés reviennent.
  f.personShareCodes.clear();
  f.restoreTransfers(JSON.parse(JSON.stringify([row])));
  const claim = { table: alice.table, access: alice.access, personId: alice.personId };
  const wrong = share.code === '0000' ? '0001' : '0000';
  let r = await post(f, '/api/table/person/claim', { ...claim, code: wrong });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Code de partage incorrect.');
  assert.equal(f.transferSnapshot()[0].attempts, 1, 'l’essai raté est compté et sauvegardé');
  r = await post(f, '/api/table/person/claim', { ...claim, code: share.code });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, alice.personId);
  assert.notEqual(r.body.token, alice.token);
  assert.deepEqual(plain(f.transferSnapshot()), [], 'code et lien utilisés : plus rien à sauvegarder');
  assert.ok(f.sched.log.some(l => l.msg === 'Alice est désormais géré depuis un autre téléphone'));
  r = await post(f, '/api/table/song', { ...alice, song: song(101, 'Ancien téléphone') });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PERSON_ACCESS');
});

test('transfert : code expiré mais lien encore valable, puis les deux expirés', async () => {
  const f = harness();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  const share = (await post(f, '/api/table/person/share', alice)).body;
  const link = new URL(share.url).searchParams.get('reprise');
  const saved = f.personShareCodes.get(alice.personId);
  saved.expiresAt = Date.now() - 1;
  assert.equal(f.transferSnapshot().length, 1, 'le lien vit encore : la reprise reste sauvegardée');
  const claim = { table: alice.table, access: alice.access, personId: alice.personId };
  let r = await post(f, '/api/table/person/claim', { ...claim, code: share.code });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Code de partage expiré. Demande un nouveau code au chanteur ou au bar.');
  const page = `/api/state?table=${alice.table}&access=${alice.access}`;
  r = await get(f, `${page}&reprise=${link}`);
  assert.deepEqual(r.body.transferOffer, { personId: alice.personId, name: 'Alice', expiresAt: share.linkExpiresAt });
  saved.linkExpiresAt = Date.now() - 1;
  assert.deepEqual(plain(f.transferSnapshot()), [], 'tout a expiré : rien n’est sauvegardé');
  r = await get(f, `${page}&reprise=${link}`);
  assert.deepEqual(r.body.transferOffer, { invalid: true });
  r = await post(f, '/api/table/person/claim', { table: alice.table, access: alice.access, link });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Ce lien de transfert a expiré ou a déjà servi. Demande un nouveau lien ou un code au bar.');
  assert.equal(f.sched.people.get(alice.personId).token, alice.token);
});

test('transfert par lien : une seule utilisation, il annule le code, et ne vaut que pour sa table', async () => {
  const f = harness();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  const table2 = openTable(f, '2');
  const share = (await post(f, '/api/table/person/share', alice)).body;
  const link = new URL(share.url).searchParams.get('reprise');
  let r = await get(f, `/api/state?table=2&access=${table2.access}&reprise=${link}`);
  assert.deepEqual(r.body.transferOffer, { invalid: true }, 'lien de la table 1 ouvert sur la table 2');
  r = await get(f, `/api/state?table=1&access=${alice.access}&reprise=pas-un-lien`);
  assert.deepEqual(r.body.transferOffer, { invalid: true });
  r = await post(f, '/api/table/person/claim', { ...table2, link });
  assert.equal(r.status, 400, 'pas de reprise depuis une autre table');
  r = await post(f, '/api/table/person/claim', { table: '1', access: alice.access, link });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, alice.personId);
  r = await post(f, '/api/table/person/claim', { table: '1', access: alice.access, link });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Ce lien de transfert a expiré ou a déjà servi. Demande un nouveau lien ou un code au bar.');
  r = await post(f, '/api/table/person/claim', { table: '1', access: alice.access, personId: alice.personId, code: share.code });
  assert.equal(r.body.error, 'Code de partage expiré. Demande un nouveau code au chanteur ou au bar.');
});

// ---------------------------------------------------------------- liste de chansons d'une personne
async function addSongs(f, person, list) {
  for (const [songId, title] of list) {
    const r = await post(f, '/api/table/song', { ...person, song: song(songId, title) });
    assert.equal(r.status, 200, `${title} : ${r.text}`);
  }
}
const entryOf = (f, person, title) => f.sched.songsOf(f.sched.people.get(person.personId)).find(s => s.title === title).entryId;
// Le prochain passage part vers KaraFun (envoi pas encore confirmé).
function sending(f) {
  const sel = f.sched.select();
  assert.ok(sel, 'un passage prêt à envoyer');
  f.setPending({ sel, before: new Set(), at: Date.now(), attempts: 1, retryAt: null });
  return sel;
}

test('retirer un titre : sa liste se met à jour, sauf le titre en cours d’envoi à KaraFun', async () => {
  const f = harness();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  await addSongs(f, alice, [[101, 'Un'], [102, 'Deux'], [103, 'Trois']]);
  const remove = title => post(f, '/api/table/song/remove', { ...alice, entryId: entryOf(f, alice, title) });
  let r = await remove('Deux');
  assert.equal(r.status, 200);
  assert.deepEqual(titles(f, alice.personId), ['Un', 'Trois']);
  assert.ok(f.sched.log.some(l => l.msg === 'Alice a retiré une chanson de sa liste'));
  const sel = sending(f);
  assert.equal(sel.song.title, 'Un');
  r = await remove('Un');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Ce titre est en cours d’envoi à KaraFun. Réessaie dans un instant.');
  assert.deepEqual(titles(f, alice.personId), ['Un', 'Trois']);
  // Le même titre ne peut pas être choisi une seconde fois pendant l'envoi.
  r = await post(f, '/api/table/song', { ...alice, song: song(101, 'Un'), mode: 'replace' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'ALREADY_IN_KARAFUN');
  assert.equal(r.body.error, 'Cette chanson est déjà envoyée à KaraFun pour ce chanteur.');
  r = await remove('Trois');
  assert.equal(r.status, 200, 'les titres suivants restent modifiables pendant l’envoi');
  f.setPending(null);
  r = await post(f, '/api/table/song/remove', { ...alice, entryId: 'inconnu' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Chanson introuvable dans la liste.');
  r = await remove('Un');
  assert.equal(r.status, 200);
  assert.deepEqual(titles(f, alice.personId), []);
});

test('réordonner sa liste : nouvel ordre, positions contrôlées, prochain titre figé pendant son envoi', async () => {
  const f = harness();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  await addSongs(f, alice, [[101, 'Un'], [102, 'Deux'], [103, 'Trois']]);
  const move = (title, toIndex) => post(f, '/api/table/song/reorder', { ...alice, entryId: entryOf(f, alice, title), toIndex });
  let r = await move('Trois', 0);
  assert.equal(r.status, 200);
  assert.deepEqual(titles(f, alice.personId), ['Trois', 'Un', 'Deux']);
  assert.ok(f.sched.log.some(l => l.msg === 'Alice a réordonné sa liste de chansons'));
  r = await move('Deux', 5);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Position invalide dans la liste.');
  r = await post(f, '/api/table/song/reorder', { ...alice, entryId: 'inconnu', toIndex: 1 });
  assert.equal(r.body.error, 'Chanson introuvable dans cette liste.');
  assert.equal(sending(f).song.title, 'Trois');
  const frozen = 'Le prochain titre est en cours d’envoi à KaraFun. Réordonne les suivants ou réessaie dans un instant.';
  r = await move('Deux', 0);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, frozen, 'rien ne passe devant le titre en cours d’envoi');
  r = await move('Trois', 2);
  assert.equal(r.body.error, frozen, 'le titre en cours d’envoi ne recule pas');
  assert.deepEqual(titles(f, alice.personId), ['Trois', 'Un', 'Deux']);
  r = await move('Deux', 1);
  assert.equal(r.status, 200, 'les suivants se réordonnent pendant l’envoi');
  assert.deepEqual(titles(f, alice.personId), ['Trois', 'Deux', 'Un']);
});

test('routes de table : personne inconnue, partie ou gérée par un autre téléphone', async () => {
  const f = harness();
  const tb = openTable(f, '1');
  const alice = await joinTable(f, tb, 'Alice');
  const bruno = await joinTable(f, tb, 'Bruno');
  let r = await post(f, '/api/table/song/remove', { ...alice, personId: 'inconnu', entryId: 'x' });
  assert.equal(r.status, 400);
  assert.deepEqual([r.body.code, r.body.error], ['NO_PERSON', 'Chanteur inconnu à cette table.']);
  r = await post(f, '/api/table/song/reorder', { ...alice, token: bruno.token, entryId: 'x', toIndex: 0 });
  assert.equal(r.status, 403);
  assert.deepEqual([r.body.code, r.body.error], ['PERSON_ACCESS',
    'Ce téléphone ne gère pas ce chanteur. Demande-lui son code de partage, ou vois avec le bar.']);
  r = await post(f, '/api/table/song/remove', { ...alice, access: SECRET_1, entryId: 'x' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'TABLE_ACCESS');
  f.sched.people.get(alice.personId).withdrawnAt = Date.now();
  r = await post(f, '/api/table/confirm', alice);
  assert.equal(r.status, 400);
  assert.deepEqual([r.body.code, r.body.error], ['PERSON_LEFT', 'Cette personne a été marquée partie. Demande au bar de la réactiver.']);
});

test('« Je suis là » depuis la page de table : seulement pour le prochain chanteur quand le bar l’exige', async () => {
  const f = harness();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  const bruno = await joinTable(f, openTable(f, '2'), 'Bruno');
  await addSongs(f, alice, [[101, 'Un']]);
  await addSongs(f, bruno, [[201, 'Deux']]);
  let r = await post(f, '/api/table/confirm', bruno);
  assert.equal(r.status, 200, 'sans présence obligatoire, la confirmation est toujours acceptée');
  assert.ok(f.sched.people.get(bruno.personId).confirmedAt > 0);
  f.sched.opts.requirePresence = true;
  const nextId = f.presenceCandidate().ids[0];
  const [next, later] = nextId === alice.personId ? [alice, bruno] : [bruno, alice];
  f.sched.people.get(later.personId).confirmedAt = 0;
  r = await post(f, '/api/table/confirm', later);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'La présence sera demandée quand ce chanteur sera le prochain à passer.');
  assert.equal(f.sched.people.get(later.personId).confirmedAt, 0);
  r = await post(f, '/api/table/confirm', next);
  assert.equal(r.status, 200);
  assert.ok(f.sched.people.get(next.personId).confirmedAt > 0);
});

// ---------------------------------------------------------------- duos depuis la page de table
test('duo : invitation, réponse et annulation depuis les pages de table, avec l’alerte de titre déjà prévu', async () => {
  const f = harness();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  const bruno = await joinTable(f, openTable(f, '2'), 'Bruno');
  const charlie = await joinTable(f, openTable(f, '3'), 'Charlie');
  await addSongs(f, charlie, [[500, 'Tube']]);
  let r = await post(f, '/api/table/duet', { ...alice, partnerId: bruno.personId, song: song(500, 'Tube') });
  assert.equal(r.status, 200);
  assert.ok(r.body.notice.queued.some(line => line.name === 'Charlie'), 'Alice apprend que Charlie a déjà prévu ce titre');
  const duet = () => f.sched.songsOf(f.sched.people.get(alice.personId)).find(s => s.title === 'Tube').duet;
  assert.deepEqual(plain(duet()), { partnerId: bruno.personId, state: 'pending' });
  const entryId = entryOf(f, alice, 'Tube');
  r = await post(f, '/api/table/duet/answer', { ...bruno, accept: true, entryId });
  assert.equal(r.status, 200);
  assert.equal(duet().state, 'accepted');
  assert.ok(f.sched.log.some(l => l.msg === 'Bruno accepte le duo avec Alice : seul Alice dépense son tour'));
  r = await post(f, '/api/table/duet/cancel', { ...alice, entryId });
  assert.equal(r.status, 200);
  assert.equal(duet(), undefined);
  assert.ok(f.sched.log.some(l => l.msg === 'Duo annulé (Alice & Bruno)'));
  // Refus : Alice chantera seule.
  r = await post(f, '/api/table/duet', { ...alice, partnerId: bruno.personId, song: song(501, 'Autre') });
  assert.equal(r.body.notice, null, 'titre prévu par personne d’autre : pas d’alerte');
  r = await post(f, '/api/table/duet/answer', { ...bruno, accept: false });
  assert.equal(r.status, 200);
  assert.equal(f.sched.songsOf(f.sched.people.get(alice.personId)).find(s => s.title === 'Autre').duet, undefined);
  assert.ok(f.sched.log.some(l => l.msg === 'Bruno décline le duo : Alice chantera en solo'));
  // Erreurs lisibles.
  r = await post(f, '/api/table/duet', { ...alice, partnerId: 'inconnu', song: song(502, 'Seule') });
  assert.equal(r.body.error, 'Partenaire introuvable.');
  r = await post(f, '/api/table/duet/answer', { ...bruno, accept: true });
  assert.equal(r.body.error, 'Pas d\'invitation en cours.');
  r = await post(f, '/api/table/duet/cancel', { ...bruno });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Duo introuvable.');
});

test('demande de duo sur un titre de la file : retrait, refus, et accord impossible pendant l’envoi', async () => {
  const f = harness();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  const bruno = await joinTable(f, openTable(f, '2'), 'Bruno');
  await addSongs(f, alice, [[101, 'Un']]);
  const entryId = entryOf(f, alice, 'Un');
  const target = () => f.sched.songsOf(f.sched.people.get(alice.personId))[0];
  const ask = () => post(f, '/api/table/duet/join', { ...bruno, ownerId: alice.personId, entryId });
  let r = await ask();
  assert.deepEqual(r.body, { ok: true, direct: false }, 'autre table : Alice doit accepter');
  r = await post(f, '/api/table/duet/join/cancel', { ...bruno, ownerId: alice.personId, entryId });
  assert.equal(r.status, 200);
  assert.equal(target().duoRequests, undefined);
  assert.ok(f.sched.log.some(l => l.msg === 'Bruno retire sa demande de duo à Alice'));
  r = await post(f, '/api/table/duet/join/cancel', { ...bruno, ownerId: alice.personId, entryId });
  assert.equal(r.body.error, 'Demande de duo introuvable.');
  // Refus d'Alice.
  await ask();
  r = await post(f, '/api/table/duet/join/answer', { ...alice, entryId, fromId: bruno.personId, accept: false });
  assert.equal(r.status, 200);
  assert.equal(target().duet, undefined);
  assert.equal(target().duoRequests, undefined);
  assert.ok(f.sched.log.some(l => l.msg === 'Alice préfère chanter « Un » sans Bruno'));
  // Accord pendant l'envoi de ce titre à KaraFun : refusé, le refus reste possible.
  await ask();
  sending(f);
  r = await post(f, '/api/table/duet/join/answer', { ...alice, entryId, fromId: bruno.personId, accept: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Ce titre est en cours d’envoi à KaraFun : le duo n’est plus possible.');
  assert.equal(target().duet, undefined);
  f.setPending(null);
  r = await post(f, '/api/table/duet/join/answer', { ...alice, entryId, fromId: bruno.personId, accept: true });
  assert.equal(r.status, 200);
  assert.deepEqual(plain(target().duet), { partnerId: bruno.personId, state: 'accepted' });
  r = await post(f, '/api/table/duet/join/answer', { ...alice, entryId, fromId: bruno.personId, accept: true });
  assert.equal(r.body.error, 'Cette demande de duo n’est plus valable.');
});

// ---------------------------------------------------------------- « Pas prêt »
test('« Pas prêt » depuis la page de table : seulement pour le prochain, cumul limité, retour possible', async () => {
  const f = harness();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  const bruno = await joinTable(f, openTable(f, '2'), 'Bruno');
  await addSongs(f, alice, [[101, 'Un']]);
  await addSongs(f, bruno, [[201, 'Deux']]);
  const firstId = f.sched.presenceView([], null).find(v => !v.future).ids[0];
  const [first, other] = firstId === alice.personId ? [alice, bruno] : [bruno, alice];
  const name = f.sched.people.get(first.personId).name;
  let r = await post(f, '/api/table/defer', { ...other, songs: 1 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Tu pourras repousser ton passage quand ta chanson sera la prochaine.');
  r = await post(f, '/api/table/defer', first);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.deferral.ownerId, r.body.deferral.remaining, r.body.deferral.total], [first.personId, 1, 1]);
  r = await post(f, '/api/table/defer', { ...first, songs: 2 });
  assert.equal(r.status, 200, 'passage déjà repoussé : le report s’allonge');
  assert.deepEqual([r.body.deferral.remaining, r.body.deferral.total], [3, 3]);
  r = await post(f, '/api/table/defer', { ...first, songs: 9 });
  assert.equal(r.body.error, 'Repousse ton passage de 1 à 5 chansons.');
  r = await post(f, '/api/table/defer', { ...first, songs: 3 });
  assert.equal(r.body.error, 'Un passage ne peut pas être repoussé de plus de 5 chansons.');
  r = await post(f, '/api/table/defer/cancel', first);
  assert.equal(r.status, 200);
  assert.equal(f.sched.deferralFor(first.personId), null);
  assert.ok(f.sched.log.some(l => l.msg === `${name} est prêt : son passage reprend sa place`));
  r = await post(f, '/api/table/defer/cancel', first);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Aucun passage repoussé pour cette personne.');
  assert.deepEqual(plain(sending(f).ids), [first.personId]);
  r = await post(f, '/api/table/defer', first);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Ta chanson est en cours d’envoi à KaraFun. Réessaie dans un instant.');
});

// ---------------------------------------------------------------- lectures publiques (GET)
test('alerte avant de choisir un titre : déjà prévu par quelqu’un, titre manquant, QR exigé', async () => {
  const f = harness();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  const t2 = openTable(f, '2');
  await addSongs(f, alice, [[500, 'Tube']]);
  const notice = query => get(f, `/api/song/notice?table=2&access=${t2.access}&${query}`);
  let r = await notice('songId=500');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.notice.queued.map(line => [line.name, line.ownerId]), [['Alice', alice.personId]],
    'le téléphone peut proposer un duo à Alice');
  r = await notice('title=tube');
  assert.equal(r.body.notice.queued[0].name, 'Alice', 'même titre sans identifiant');
  r = await notice('songId=999&title=Inconnu');
  assert.deepEqual(r.body, { notice: null });
  r = await notice('artist=Quelqu%E2%80%99un');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Titre manquant.');
  r = await get(f, `/api/song/notice?table=2&access=${alice.access}&songId=500`);
  assert.equal(r.status, 403);
});

test('partenaires de duo : personnes présentes, même table signalée, duos déjà prévus comptés', async () => {
  const f = harness();
  const tb1 = openTable(f, '1');
  const alice = await joinTable(f, tb1, 'Alice');
  await joinTable(f, tb1, 'Anna');
  const tb2 = openTable(f, '2');
  const bruno = await joinTable(f, tb2, 'Bruno');
  const paul = await joinTable(f, tb2, 'Paul');
  f.sched.table('2').name = 'Terrasse';
  f.sched.people.get(paul.personId).withdrawnAt = Date.now();
  await post(f, '/api/table/duet', { ...alice, partnerId: bruno.personId, song: song(501, 'Duo 1') });
  await post(f, '/api/table/duet', { ...alice, partnerId: bruno.personId, song: song(502, 'Duo 2') });
  let r = await get(f, `/api/duo/partners?table=1&access=${tb1.access}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map(p => [p.name, p.table, p.sameTable, p.guestDuos]), [
    ['Alice', 'Table 1', true, 0], ['Anna', 'Table 1', true, 0], ['Bruno', 'Terrasse', false, 2]]);
  r = await get(f, `/api/duo/partners?table=1&access=${tb2.access}`);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'TABLE_ACCESS');
});

test('recherche KaraFun : requête trop courte, KaraFun absent ou en erreur', async () => {
  const f = harness();
  let r = await get(f, '/api/search?q=a');
  assert.deepEqual([r.status, r.body], [200, []], 'une lettre : pas de recherche');
  r = await get(f, '/api/search?q=abba');
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'KaraFun non connecté');
  const asked = [];
  f.setBridge({ ready: false, connected: false, search: async q => { asked.push(q); throw new Error('délai dépassé'); } });
  r = await get(f, '/api/search?q=%20abba%20');
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'Recherche KaraFun impossible : délai dépassé');
  assert.deepEqual(asked, ['abba']);
  f.setBridge({ ready: false, connected: false, search: async () => [{ songId: 7, title: 'Waterloo', artist: 'ABBA' }] });
  r = await get(f, '/api/search?q=abba');
  // Vignette : seule une image https du catalogue est transmise (aucune ici).
  assert.deepEqual([r.status, r.body], [200, [{ songId: 7, title: 'Waterloo', artist: 'ABBA', img: null }]]);
});

test('catalogue KaraFun en démo : indisponible avec un message, pas d’erreur muette', async () => {
  const f = harness();
  for (const route of ['/api/catalog/categories?type=genre', '/api/catalog/highlights', '/api/catalog/songs?filter=x&offset=0']) {
    const r = await get(f, route);
    assert.equal(r.status, 502, route);
    assert.equal(r.body.error, 'Catalogue KaraFun indisponible en mode démo ou sans code.', route);
  }
});

test('retour de connexion Spotify : réservé au PC du bar, message lisible et échappé', async () => {
  const f = harness();
  let r = await get(f, '/spotify/callback?code=c&state=s', { remote: '192.168.1.50' });
  assert.equal(r.status, 403);
  assert.equal(r.text, 'Connecte Spotify depuis le PC du bar.');
  r = await get(f, '/spotify/callback?code=c&state=s', { port: f.PUBLIC_PORT });
  assert.equal(r.status, 403, 'jamais par le tunnel public');
  const back = `<a href="/staff?key=${encodeURIComponent(f.STAFF_KEY)}">Revenir à la page du bar</a>`;
  r = await get(f, '/spotify/callback?error=access_denied');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.ok(r.text.includes('<p>Connexion Spotify annulée.</p>'));
  assert.ok(r.text.includes(back), 'lien de retour vers la page du bar');
  r = await get(f, '/spotify/callback?code=c&state=s');
  assert.ok(r.text.includes('Connexion Spotify expirée : relance-la depuis la page du bar.'), 'connexion jamais demandée');
  const received = [];
  f.spotify.finishAuth = async args => { received.push({ ...args }); };
  r = await get(f, '/spotify/callback?code=abc&state=xyz');
  assert.deepEqual(received, [{ code: 'abc', state: 'xyz' }]);
  assert.ok(r.text.includes('Spotify est connecté. Choisis l’appareil qui joue la musique dans la page du bar.'));
  assert.ok(f.sched.log.some(l => l.msg === 'Spotify connecté à la file karaoké.'));
  f.spotify.finishAuth = async () => { throw new Error('Refus <b>"invalide"</b> & fin'); };
  r = await get(f, '/spotify/callback?code=abc&state=xyz');
  assert.ok(r.text.includes('Refus &lt;b&gt;&quot;invalide&quot;&lt;/b&gt; &amp; fin'));
  assert.ok(!r.text.includes('<b>'), 'aucune balise reçue n’est interprétée');
});

// Regression: essai au bar du 2 octobre — le nouveau kit, lancé pendant que
// l'ancien tournait, rouvrait l'ancien sans rien dire. DEMARRER compare
// maintenant sa version à celle qui tourne, lue sur ce PC seulement.
test('version du kit qui tourne : lue depuis ce PC, refusée ailleurs', async () => {
  const f = harness();
  let r = await get(f, '/internal/version');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['builtAt', 'commit', 'version']);
  assert.equal(typeof r.body.version, 'string');
  r = await get(f, '/internal/version', { remote: '192.168.0.20' });
  assert.equal(r.status, 403, 'un autre appareil du réseau');
  r = await get(f, '/internal/version', { port: f.PUBLIC_PORT });
  assert.equal(r.status, 403, 'le tunnel public');
});

test('pages et routes inconnues, table fermée, table sans effectif, photo d’inscription', async () => {
  const f = harness();
  let r = await get(f, '/inconnu');
  assert.deepEqual([r.status, r.text], [404, 'Introuvable']);
  r = await call(f, 'PUT', '/api/state');
  assert.deepEqual([r.status, r.text], [405, 'Méthode non gérée']);
  r = await post(f, '/api/table/inconnu', {});
  assert.deepEqual([r.status, r.body], [404, { error: 'Introuvable' }]);
  r = await get(f, '/t/1');
  assert.deepEqual([r.status, r.text], [403, 'Scanne le QR code de ta table.']);
  // QR encore valable d'une table que le bar a fermée.
  const closed = f.access.issue('9');
  r = await get(f, `/api/state?table=9&access=${closed}`);
  assert.equal(r.status, 400);
  assert.deepEqual([r.body.code, r.body.error], ['TABLE_CLOSED', 'Cette table n’est plus ouverte.']);
  // Effectif inconnu : le bar doit d'abord le saisir.
  f.sched.table('3');
  const t3 = { table: '3', access: f.access.issue('3') };
  r = await post(f, '/api/join', { ...t3, name: 'Alice' });
  assert.equal(r.status, 400);
  assert.deepEqual([r.body.code, r.body.error], ['NEED_HEADCOUNT', 'Le bar doit d’abord indiquer le nombre de personnes à cette table.']);
  // Photo envoyée à l'inscription, servie ensuite ; trop lourde, elle est ignorée.
  const t4 = openTable(f, '4');
  const pixels = Buffer.from('fausse image png');
  r = await post(f, '/api/join', { ...t4, name: 'Alice', photo: `data:image/png;base64,${pixels.toString('base64')}` });
  assert.equal(r.status, 200);
  let photo = await get(f, `/photo/${r.body.id}`);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers['content-type'], 'image/png');
  assert.ok(Buffer.from(photo.raw).equals(pixels));
  const heavy = Buffer.alloc(400 * 1024 + 1, 1).toString('base64');
  r = await post(f, '/api/join', { ...t4, name: 'Bruno', photo: `data:image/png;base64,${heavy}` });
  assert.equal(r.status, 200, r.text);
  photo = await get(f, `/photo/${r.body.id}`);
  assert.equal(photo.status, 404);
});

test('page de table : chanteurs gérés annoncés par l’en-tête du téléphone, liste illisible sans effet', async () => {
  const f = harness();
  const tb = openTable(f, '1');
  const alice = await joinTable(f, tb, 'Alice');
  const bruno = await joinTable(f, tb, 'Bruno');
  const other = await joinTable(f, openTable(f, '2'), 'Chloé');
  const page = `/api/state?table=1&access=${tb.access}`;
  let r = await get(f, page, { headers: { 'x-person-tokens': JSON.stringify([alice.token, bruno.token, other.token, 42]) } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.managedIds.sort(), [alice.personId, bruno.personId].sort(), 'Chloé est d’une autre table');
  r = await get(f, page, { headers: { 'x-person-tokens': '[pas du JSON' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.managedIds, []);
  r = await get(f, `${page}&token=${bruno.token}`, { headers: { 'x-person-tokens': JSON.stringify({ jeton: alice.token }) } });
  assert.deepEqual(r.body.managedIds, [bruno.personId], 'seule une liste est lue');
});

test('« Pas prêt » sur un titre déjà chargé dans KaraFun : KaraFun le retire, « Je suis prêt » le remet sans report', async () => {
  const f = harness();
  const alice = await joinTable(f, openTable(f, '1'), 'Alice');
  const bruno = await joinTable(f, openTable(f, '2'), 'Bruno');
  await addSongs(f, alice, [[101, 'Un']]);
  await addSongs(f, bruno, [[201, 'Deux']]);
  const sel = f.sched.select();
  f.sched.commit(sel);
  const owner = sel.ids[0] === alice.personId ? alice : bruno;
  const name = f.sched.people.get(owner.personId).name;
  const sent = [];
  const queue = [{ queueId: 5, songId: sel.song.songId, singer: sel.label }];
  f.setBridge({ ready: true, connected: true, queue, events: [], permissions: {}, status: { state: 'idle' },
    add: (...args) => sent.push(['add', ...args]), remove: id => sent.push(['remove', id]),
    next: () => sent.push(['next']), play: () => sent.push(['play']) });
  f.getTracked().push({ queueId: 5, sel, startedAt: null, addedAt: Date.now() });
  let r = await post(f, '/api/table/defer', owner);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.deferral, { ownerId: owner.personId, remaining: 1, total: 1, pendingRemoval: true });
  assert.deepEqual(sent, [['remove', 5]], 'KaraFun reçoit seulement le retrait du titre');
  assert.equal(f.getTracked().find(tr => tr.queueId === 5).pulled.reason, 'defer');
  r = await post(f, '/api/table/defer/cancel', owner);
  assert.equal(r.status, 200);
  assert.equal(f.sched.deferralFor(owner.personId), null, 'le titre reviendra sans report');
  assert.ok(f.sched.log.some(l => l.msg === `${name} est prêt : son titre reprend sa place dès son retrait de KaraFun`));
  assert.deepEqual(sent, [['remove', 5]], 'rien d’autre n’est envoyé à KaraFun');
});

// ---------------------------------------------------------------- catalogue KaraFun (serveur réel, réseau simulé)
test('catalogue KaraFun : titres reçus certifiés pour une Battle, pannes expliquées au téléphone, code jamais journalisé', async () => {
  const f = harness({ persistent: true, files: { 'data/last-karafun-code.json': { code: '123456' } } });
  f.loadTables();
  const asked = [];
  let mode = 'ok';
  const answer = body => ({ ok: true, status: 200, json: async () => body });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = new URL(url);
    asked.push(`${u.host}${u.pathname}?${u.searchParams.get('type')}`);
    if (mode === 'network') throw new TypeError('fetch failed');
    if (mode === 403) return { ok: false, status: 403, json: async () => ({}) };
    if (mode === 'json') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    if (u.searchParams.get('type') === 'styles') return answer([{ id: 3, name: 'Disco' }]);
    if (u.searchParams.get('type') === 'news') return answer([{ id: 11, title: 'Waterloo', artist: 'ABBA' }]);
    return answer({ songs: [{ id: 12, title: 'Mamma Mia', artist: 'ABBA' }], total: 1 });
  };
  try {
    let r = await get(f, '/api/catalog/categories?type=styles');
    assert.deepEqual([r.status, r.body], [200, [{ id: 3, name: 'Disco', filter: 'st_3', img: null }]]);
    r = await get(f, '/api/catalog/highlights?type=news');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(s => [s.songId, s.title]), [[11, 'Waterloo']]);
    r = await get(f, '/api/catalog/songs?filter=pl_5&offset=0');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.total, r.body.songs.map(s => s.title)], [1, ['Mamma Mia']]);
    assert.deepEqual(asked, ['www.karafun.fr/123456/?styles', 'www.karafun.fr/123456/?news', 'www.karafun.fr/123456/?song_list']);
    // Battle du bar : seul un titre reçu du catalogue est accepté, avec ses vraies informations.
    const key = `?key=${f.STAFF_KEY}`;
    r = await post(f, `/api/staff/battle/launch${key}`, { song: { songId: 99, title: 'Inventé' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Retrouve ce titre dans le catalogue avant de proposer la Battle.');
    r = await post(f, `/api/staff/battle/launch${key}`, { song: { songId: 11, title: 'Titre trafiqué' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.battle.lastOutcome.selectedSong.title, 'Waterloo');
    assert.ok(f.sched.log.some(l => /^Le bar lance une Battle sur « Waterloo »/.test(l.msg)));
    assert.equal(JSON.parse(f.memory.read('data/battle-vote.json')).ballot.selectedSong.title, 'Waterloo',
      'Battle gardée sur le disque');
    // Pannes : le téléphone garde la recherche, le journal ne contient jamais le code.
    const failures = [
      [403, 'KaraFun refuse cette sélection (HTTP 403). Essaie une autre sélection ou la recherche.'],
      ['json', 'Catalogue KaraFun indisponible pour le moment (réponse illisible). La recherche reste possible.'],
      ['network', 'Catalogue KaraFun indisponible pour le moment (réseau injoignable). La recherche reste possible.'],
    ];
    for (const [failure, message] of failures) {
      mode = failure;
      r = await get(f, '/api/catalog/highlights?type=featured');
      assert.deepEqual([r.status, r.body.error], [502, message], String(failure));
    }
    mode = 'ok';
    r = await get(f, '/api/catalog/songs?filter=../admin');
    assert.deepEqual([r.status, r.body.error], [502, 'Filtre de catalogue invalide']);
    const journal = f.memory.journal();
    assert.match(journal, /Catalogue KaraFun : échec sur www\.karafun\.fr \(HTTP 403\)\./);
    assert.match(journal, /Catalogue KaraFun : échec sur www\.karafun\.com \(réseau injoignable\)\./);
    assert.ok(!journal.includes('123456'), 'le code de la télécommande n’apparaît pas dans le journal');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Regression: essai au bar du 2 octobre (après-midi) — depuis la France,
// karafun.com (domaine de la télécommande) refusait « Nouveautés » et les
// tops étrangers (Top US, Top UK) ; l'ancien serveur n'essayait que lui.
test('catalogue KaraFun : refus de karafun.com sur les nouveautés et Top US, servis par karafun.fr', async () => {
  const f = harness({ persistent: true, files: { 'data/last-karafun-code.json': { code: '123456' } } });
  f.loadTables();
  f.setBridge({ ready: true, connected: true, queue: [], events: [], permissions: {}, status: { state: 'idle' },
    bases: ['https://www.karafun.com', 'https://www.karafun.fr'], base: 'https://www.karafun.com' });
  const asked = [];
  const answer = body => ({ ok: true, status: 200, json: async () => body });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = new URL(url);
    const type = u.searchParams.get('type');
    asked.push(`${u.host} ${type}${u.searchParams.get('filter') ? ' ' + u.searchParams.get('filter') : ''}`);
    if (u.host === 'www.karafun.com' && (type === 'news' || ['pl_7', 'pl_23'].includes(u.searchParams.get('filter')))) {
      return { ok: false, status: 403, json: async () => ({}) };
    }
    if (type === 'top') return answer([{ id: 7, name: u.host === 'www.karafun.com' ? 'Top US' : 'Top États-Unis' }]);
    if (type === 'news') return answer([{ id: 11, title: 'Nouveauté' }]);
    return answer({ songs: [{ id: 12, title: 'Hit US' }], total: 1 });
  };
  try {
    let r = await get(f, '/api/catalog/categories?type=top');
    assert.deepEqual([r.status, r.body.map(c => c.name)], [200, ['Top US']]);
    r = await get(f, '/api/catalog/highlights?type=news');
    assert.deepEqual([r.status, r.body.map(s => s.title)], [200, ['Nouveauté']], 'Nouveautés servies au téléphone');
    r = await get(f, '/api/catalog/songs?filter=pl_7&offset=0');
    assert.deepEqual([r.status, r.body.songs.map(s => s.title)], [200, ['Hit US']], 'Top US servi au téléphone');
    assert.deepEqual(asked, ['www.karafun.com top', 'www.karafun.com news', 'www.karafun.fr news',
      'www.karafun.fr song_list pl_7'], 'karafun.fr, qui a répondu, est retenu pour la suite');
    const journal = f.memory.journal();
    assert.match(journal, /Catalogue KaraFun : échec sur www\.karafun\.com \(HTTP 403\)\./);
    assert.ok(!journal.includes('123456'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
