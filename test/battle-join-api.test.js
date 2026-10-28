'use strict';
// Bouton « Rejoindre la Battle » des téléphones (demande du gérant du
// 26 octobre 2026) : le lien https://www.karafun.fr/<code télécommande>
// n'arrive aux téléphones que tant qu'une Battle, suivie par la file ou
// ajoutée dans KaraFun, est en tête de KaraFun ou sur scène. Ni avant (vote,
// envoi), ni après, ni en démo, ni sans code, ni à la page du bar.
//
// server.js tourne dans un bac à sable `vm` sans port : GET /api/state passe
// par son gestionnaire HTTP avec une fausse requête (port du bar et port des
// clients). Disque en mémoire, faux magasin de la soirée, faux KaraFun (sa
// file et son état de lecture). Mode PC, mode serveur et démo.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { BATTLE_MOD } = require('../karafun');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));
const LINK = 'https://www.karafun.fr/123456';

// Clé du bar du mode serveur, tirée pour ce test (comme server-mode.test.js).
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-battle-join-'));
after(() => fs.rmSync(keyDir, { recursive: true, force: true }));
const KEY_FILE = path.join(keyDir, 'staff-key');
fs.writeFileSync(KEY_FILE, `${crypto.randomBytes(24).toString('base64url')}\n`, { mode: 0o600 });
const SERVER_ENV = { KARAOKE_MODE: 'server', KARAOKE_PUBLIC_URL: 'https://clients.exemple.fr',
  KARAOKE_STAFF_URL: 'https://bar.exemple.fr', KARAOKE_CLIENT_IP_HEADER: 'x-real-ip', KARAOKE_STAFF_KEY_FILE: KEY_FILE };

// `demo` : --demo ; `server` : variables du mode serveur ; sinon mode PC avec
// le code télécommande saisi au bar (--code).
function harness({ demo = false, server = false } = {}) {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const disk = new Map();
  const inMemory = file => String(file).startsWith(path.join(root, 'data')) || String(file).startsWith(path.join(root, 'journal'));
  const memFs = { ...fs,
    existsSync: file => inMemory(file) ? disk.has(file) : fs.existsSync(file),
    readFileSync(file, ...rest) {
      if (!inMemory(file)) return fs.readFileSync(file, ...rest);
      if (!disk.has(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return disk.get(file);
    },
    writeFileSync(file, data) { if (inMemory(file)) disk.set(file, String(data)); },
    appendFileSync(file, data) { if (inMemory(file)) disk.set(file, (disk.get(file) || '') + data); },
    renameSync(from, to) { disk.set(to, disk.get(from)); disk.delete(from); },
    unlinkSync(file) { disk.delete(file); }, mkdirSync() {}, readdirSync() { return []; } };
  const overrides = {
    './night-state': { ...fromServer('./night-state'), NightStateStore: class { load() { return null; } save() { return true; } } },
    './scheduler': (() => {
      const real = fromServer('./scheduler');
      return { ...real, Scheduler: class extends real.Scheduler { constructor(o) { super({ ...o, solverEnabled: false }); } } };
    })(),
    './spotify': (() => {
      const real = fromServer('./spotify');
      return { ...real, SpotifyLink: class extends real.SpotifyLink { constructor(o) { super({ ...o, file: null }); } } };
    })(),
  };
  const fixtureProcess = Object.create(process);
  fixtureProcess.env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('KARAOKE_'))),
    ...(server ? SERVER_ENV : {}) };
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), ...(demo ? ['--demo'] : ['--code', '123456'])];
  const context = { require: name => name === 'fs' ? memFs : overrides[name] || fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL, setTimeout, clearTimeout,
    setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, access, battleVote, staffState, publicState, sync, PORT, PUBLIC_PORT, SERVER, DEMO,
      handle: server.listeners('request')[0], setBridge: b => { bridge = b; }, setCode: c => { CODE = c; }, getCode: () => CODE };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  return f;
}

// Une requête HTTP passée directement au gestionnaire du serveur.
function call(f, method, url, { body, headers = {}, port = f.PORT } = {}) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers, socket: { remoteAddress: '127.0.0.1', localPort: port }, destroy() {} });
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

// Faux KaraFun : sa file, et le titre en lecture (queueId, ou l'objet que
// KaraFun annonce quand le titre n'est plus dans sa file).
function fakeBridge(queue, playing = null, { ready = true } = {}) {
  return { ready, connected: ready, queue, events: [], permissions: {}, protocol: 'kcs', raw: {},
    snapshot: () => ({ ready, connected: ready, queue, events: [] }),
    status: playing == null ? { state: 'idle' } : { state: 'playing', songPlaying: typeof playing === 'object' ? playing : { queueId: playing } },
    add() {}, remove() {}, next() {}, play() {} };
}
const battleItem = (queueId = 50) => ({ queueId, songId: 900, title: 'Tube collectif', artist: 'Groupe', singer: '', options: { mod: BATTLE_MOD } });
const plainItem = (queueId, songId = 700) => ({ queueId, songId, title: `Titre ${songId}`, singer: 'KaraFun' });

// Alice inscrite à la table 1 par son téléphone.
async function phone(f) {
  f.sched.table('1').headcount = 4;
  const tb = { table: '1', access: f.access.issue('1') };
  const joined = await call(f, 'POST', '/api/table/person', { body: { ...tb, name: 'Alice' } });
  assert.equal(joined.status, 200, joined.text);
  return async (port = f.PORT) => {
    const r = await call(f, 'GET', `/api/state?${new URLSearchParams(tb)}`,
      { headers: { 'x-person-tokens': JSON.stringify([joined.body.token]), 'x-page-visible': '1' }, port });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.body.battle, 'vue Battle du téléphone');
    return r.body.battle.joinUrl;
  };
}

test('mode PC : le lien de la télécommande n’arrive aux téléphones que pendant la Battle', async () => {
  const f = harness();
  assert.equal(f.getCode(), '123456', 'code saisi au bar');
  assert.ok(!f.SERVER && !f.DEMO, 'mode PC');
  const joinUrl = await phone(f);
  f.setBridge(fakeBridge([plainItem(40)], 40));
  assert.equal(await joinUrl(), null, 'pas de Battle : pas de lien');

  // Avant : Battle décidée, pas encore dans KaraFun.
  f.battleVote.staffLaunch({ song: { songId: 900, title: 'Tube collectif', artist: 'Groupe' } });
  assert.equal(await joinUrl(), null, 'Battle annoncée mais pas dans KaraFun : pas encore de lien');

  // Arrivée dans KaraFun, en tête de sa file, derrière le titre en cours.
  const kf = (queue, playing) => { f.setBridge(fakeBridge(queue, playing)); f.sync(); };
  kf([plainItem(40), battleItem(), plainItem(60, 701)], 40);
  assert.equal(f.battleVote.automation.status, 'queued', 'Battle suivie, reconnue dans KaraFun');
  assert.equal(await joinUrl(), null, 'Battle en tête de KaraFun, titre d’avant sur scène : pas encore de lien');
  // Titre d'avant fini : la Battle attend le bar, KaraFun montre son QR.
  kf([battleItem(), plainItem(60, 701)]);
  assert.equal(await joinUrl(), LINK, 'Battle en tête de KaraFun, scène libre : lien');
  assert.equal(await joinUrl(f.PUBLIC_PORT), LINK, 'même réponse sur le port des clients');
  // Lancée : KaraFun la retire de sa file un instant avant d'annoncer sa lecture.
  kf([plainItem(60, 701)]);
  assert.equal(f.battleVote.automation.status, 'queued', 'la file patiente');
  assert.equal(await joinUrl(), LINK, 'pas de fin de Battle annoncée à tort');
  // Sur scène, dans la file de KaraFun ou annoncée seulement par son état.
  kf([battleItem(), plainItem(60, 701)], 50);
  assert.equal(f.battleVote.automation.status, 'playing');
  assert.equal(await joinUrl(), LINK, 'Battle sur scène : lien');
  kf([plainItem(60, 701)], battleItem());
  assert.equal(await joinUrl(), LINK, 'Battle sur scène hors de la file de KaraFun : lien');
  assert.ok(!('joinUrl' in f.staffState().battle), 'la page du bar n’en a pas besoin');

  // Après : Battle finie, titre suivant en attente du bar puis lancé.
  kf([plainItem(60, 701)]);
  assert.equal(f.battleVote.automation.status, 'after');
  assert.equal(await joinUrl(), null, 'Battle finie : plus de lien');
  kf([plainItem(60, 701)], 60);
  assert.equal(f.battleVote.automation.status, 'released');
  assert.equal(await joinUrl(), null);

  // Un titre ordinaire devant la Battle : elle n'est pas en tête.
  f.setBridge(fakeBridge([plainItem(61, 702), battleItem(51)]));
  assert.equal(await joinUrl(), null, 'Battle plus loin dans la file : pas encore');
  // KaraFun déconnecté, ou code inconnu : pas de lien.
  f.setBridge(fakeBridge([battleItem(52)], null, { ready: false }));
  assert.equal(await joinUrl(), null, 'KaraFun déconnecté');
  f.setBridge(fakeBridge([battleItem(52)]));
  f.setCode('');
  assert.equal(await joinUrl(), null, 'sans code télécommande');
});

// Remarque de relecture : KaraFun déconnecté en pleine Battle (coupure du
// socket, nouvel essai dans 3 à 30 s), le lien disparaissait et la page
// annonçait « Battle terminée ». Le suivi garde son dernier état pendant la
// coupure : Battle sur scène (`playing`) ou en train de partir, le lien reste.
test('mode PC : KaraFun déconnecté pendant la Battle, le lien reste ; la fin se voit à la reconnexion', async () => {
  const f = harness();
  const joinUrl = await phone(f);
  const kf = (queue, playing, options) => { f.setBridge(fakeBridge(queue, playing, options)); f.sync(); };
  f.battleVote.staffLaunch({ song: { songId: 900, title: 'Tube collectif', artist: 'Groupe' } });
  kf([plainItem(40), battleItem(), plainItem(60, 701)], 40);
  kf([battleItem(), plainItem(60, 701)], 50);
  assert.equal(f.battleVote.automation.status, 'playing');
  assert.equal(await joinUrl(), LINK);
  kf([battleItem(), plainItem(60, 701)], 50, { ready: false });
  assert.equal(f.battleVote.automation.status, 'playing', 'suivi inchangé pendant la coupure');
  assert.equal(await joinUrl(), LINK, 'Battle sur scène, KaraFun déconnecté : le lien reste');
  assert.equal(await joinUrl(f.PUBLIC_PORT), LINK);
  // Reconnecté, toujours sur scène ; puis finie pendant une seconde coupure.
  kf([battleItem(), plainItem(60, 701)], 50);
  assert.equal(await joinUrl(), LINK);
  kf([plainItem(60, 701)], null, { ready: false });
  assert.equal(await joinUrl(), LINK, 'fin pas encore lue');
  kf([plainItem(60, 701)]);
  assert.equal(f.battleVote.automation.status, 'after');
  assert.equal(await joinUrl(), null, 'fin lue à la reconnexion : plus de lien');
  kf([plainItem(60, 701)], null, { ready: false });
  assert.equal(await joinUrl(), null, 'Battle finie, KaraFun déconnecté : toujours rien');

  // Battle qui attend le bar en tête de KaraFun : sans KaraFun, sa place
  // n'est plus connue, pas de lien (la page ouverte garde son bouton, voir
  // client-ui-coverage). Lancée, retirée de la file avant d'être annoncée
  // (`queued` qui patiente) : le lien reste pendant la coupure.
  const g = harness();
  const other = await phone(g);
  g.setBridge(fakeBridge([battleItem(77)])); g.sync();
  assert.equal(g.battleVote.automation.status, 'queued', 'Battle de KaraFun reconnue');
  assert.equal(await other(), LINK);
  g.setBridge(fakeBridge([battleItem(77)], null, { ready: false }));
  assert.equal(await other(), null);
  g.setBridge(fakeBridge([])); g.sync();
  assert.ok(g.battleVote.automation.missingSince, 'la file patiente');
  g.setBridge(fakeBridge([], null, { ready: false }));
  assert.equal(await other(), LINK, 'départ de la Battle, KaraFun déconnecté : le lien reste');
});

// Relecture, passe 5 (sécurité) : le lien porte le code de la télécommande
// KaraFun du bar. Il partait dans toute lecture de l'état d'une table, même
// sans personne, avec le seul secret du QR de la table : ce QR reste le même
// d'une soirée à l'autre et, en mode serveur, s'ouvre de n'importe où.
test('mode PC : le lien de la Battle ne part qu’aux téléphones qui gèrent une personne nommée encore là', async () => {
  const f = harness();
  f.sched.table('1').headcount = 4;
  const tb = { table: '1', access: f.access.issue('1') };
  const join = async name => {
    const joined = await call(f, 'POST', '/api/table/person', { body: { ...tb, name } });
    assert.equal(joined.status, 200, joined.text);
    return joined.body;
  };
  const zoe = await join('Zoé'), gil = await join('Gil');
  const read = async (tokens, port = f.PORT) => {
    const r = await call(f, 'GET', `/api/state?${new URLSearchParams(tb)}`,
      { headers: { ...(tokens ? { 'x-person-tokens': JSON.stringify(tokens) } : {}), 'x-page-visible': '1' }, port });
    assert.equal(r.status, 200, r.text);
    return r.body.battle.joinUrl ?? null;
  };
  f.setBridge(fakeBridge([battleItem()])); f.sync();
  assert.equal(await read(), null, 'lecture de la table sans personne : pas de code');
  assert.equal(await read(null, f.PUBLIC_PORT), null, 'pas plus sur le port des clients');
  assert.equal(await read(['0'.repeat(32)]), null, 'clé inconnue : pas de code');
  assert.equal(await read([zoe.token]), LINK, 'Zoé, inscrite : le lien');
  // Marquée partie par le bar : son téléphone ne gère plus personne de présent.
  f.sched.leave(f.sched.person(zoe.token), 'staff');
  assert.equal(await read([zoe.token]), null, 'Zoé partie : plus de code');
  assert.equal(await read([zoe.token, gil.token]), LINK, 'un téléphone qui gère aussi Gil, encore là : le lien');
  // Mêmes règles par la vue de l'état (place sans prénom comprise).
  assert.equal(f.publicState(null, '1', new Set()).battle.joinUrl, null);
  const placeholder = f.sched.join({ tableId: 'Comptoir', name: 'Solo 1', nameRequired: true });
  assert.equal(f.publicState(placeholder, 'Comptoir', new Set([placeholder.id])).battle.joinUrl, null, 'place sans prénom : pas de code');
});

test('démo : jamais de lien, même avec une Battle en tête du faux KaraFun', async () => {
  const f = harness({ demo: true });
  assert.equal(f.DEMO, true);
  f.setCode('123456');
  const joinUrl = await phone(f);
  f.setBridge(fakeBridge([battleItem()]));
  assert.equal(await joinUrl(), null);
  f.setBridge(fakeBridge([battleItem()], 50));
  assert.equal(await joinUrl(), null);
});

test('mode serveur : même règle que le mode PC', async () => {
  const f = harness({ server: true });
  assert.ok(f.SERVER, 'mode serveur');
  f.setCode('123456');
  const alice = f.sched.join({ tableId: '1', name: 'Alice', headcount: 4 });
  const joinUrl = () => f.publicState(alice, '1', new Set([alice.id])).battle.joinUrl;
  f.setBridge(fakeBridge([plainItem(40)], 40));
  assert.equal(joinUrl(), null);
  f.setBridge(fakeBridge([battleItem()]));
  assert.equal(joinUrl(), LINK);
  // Lecture de la table sans personne (le seul QR, ouvert de n'importe où) : pas de code.
  assert.equal(f.publicState(null, '1', new Set()).battle.joinUrl, null);
  f.setBridge(fakeBridge([battleItem()], 50));
  assert.equal(joinUrl(), LINK);
  f.setBridge(fakeBridge([]));
  assert.equal(joinUrl(), null);
  // KaraFun déconnecté pendant la Battle suivie : le lien reste.
  f.setBridge(fakeBridge([battleItem(51)])); f.sync();
  f.setBridge(fakeBridge([battleItem(51)], 51)); f.sync();
  assert.equal(f.battleVote.automation.status, 'playing');
  f.setBridge(fakeBridge([battleItem(51)], 51, { ready: false }));
  assert.equal(joinUrl(), LINK);
  f.setBridge(fakeBridge([])); f.sync();
  assert.equal(f.battleVote.automation.status, 'after');
  assert.equal(joinUrl(), null);
});
