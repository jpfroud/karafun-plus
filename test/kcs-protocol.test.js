'use strict';
// Protocole de la télécommande KaraFun actuelle (KCS, JSON sur WebSocket).
// C'est le chemin utilisé avec le VRAI KaraFun du bar ; le faux KaraFun de la
// démo parle encore l'ancien socket.io, donc ce chemin n'était presque pas
// essayé. Ici, tout est simulé : faux WebSocket global, faux fetch, faux
// socket.io-client. Aucun accès réseau, aucun vrai code de télécommande.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// --- Faux socket.io-client (ancien protocole, utilisé seulement en local) ---
const ioSockets = [];
class FakeIoSocket {
  constructor(base, options) {
    this.base = base; this.options = options; this.handlers = {}; this.outgoing = []; this.closed = false;
    // socket.io appelle onevent pour chaque paquet reçu ; karafun.js l'enveloppe.
    this.onevent = packet => this.fire(...(packet.data || []));
    ioSockets.push(this);
  }
  on(name, fn) { (this.handlers[name] ||= []).push(fn); return this; }
  fire(name, ...args) { for (const fn of this.handlers[name] || []) fn(...args); }
  receive(name, data) { this.onevent({ data: [name, data] }); }
  emit(name, ...args) { this.outgoing.push({ name, args }); }
  removeAllListeners() { this.handlers = {}; }
  close() { this.closed = true; }
}
const ioPath = require.resolve('socket.io-client');
require.cache[ioPath] = { id: ioPath, filename: ioPath, loaded: true,
  exports: (base, options) => new FakeIoSocket(base, options) };

const { KcsTransport } = require('../kcs-transport');
const { KaraFunBridge, readSettings, normalizeKcsItem, normalizeResults, BATTLE_MOD, isBattleItem } = require('../karafun');

// --- Faux WebSocket : ce que KaraFun envoie et ce qu'il reçoit ---
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url, protocol) {
    this.url = url; this.protocol = protocol; this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = {}; this.sent = []; this.closeCalls = 0;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
  open() { this.readyState = FakeWebSocket.OPEN; this.dispatch('open'); }
  receive(message) { this.dispatch('message', { data: typeof message === 'string' ? message : JSON.stringify(message) }); }
  fail() { this.dispatch('error', {}); }
  serverClose(code) { this.readyState = FakeWebSocket.CLOSED; this.dispatch('close', { code }); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.closeCalls++; this.readyState = FakeWebSocket.CLOSED; }
}
FakeWebSocket.instances = [];

// Jeton factice : il ne doit jamais apparaître dans le journal ni dans l'état.
const KCS_URL = 'wss://kcs.exemple.invalid/remote?token=jeton-factice-000';
const CODE = '123456';
const page = (settings = { kcs_url: KCS_URL, label: 'accolade } dans une "chaîne" {' }) =>
  `<html><script>\n  var Settings = ${JSON.stringify(settings)};\n  init(Settings);</script></html>`;
const ok = html => ({ ok: true, status: 200, text: async () => html });

// Installe les faux globaux pour un test et les restaure à la fin.
function fakes(t, respond = () => ok(page())) {
  const saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
  FakeWebSocket.instances = [];
  const calls = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return respond(url, options); };
  t.after(() => { globalThis.WebSocket = saved.WebSocket; globalThis.fetch = saved.fetch; });
  return { calls, sockets: FakeWebSocket.instances };
}
const mockTime = t => t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const sentTypes = ws => ws.sent.map(m => m.type);

// Pont connecté au vrai chemin KCS : découverte, ouverture, snapshots.
async function connected(t, options = {}) {
  const env = fakes(t, options.respond);
  const bridge = new KaraFunBridge({ bases: options.bases || ['https://kf.exemple.invalid'], logDir: options.logDir });
  const changes = { count: 0 };
  bridge.on('change', () => changes.count++);
  bridge.connect(options.code || CODE);
  await flush();
  const ws = env.sockets.at(-1);
  assert.ok(ws, 'la découverte doit ouvrir le WebSocket KCS');
  ws.open();
  if (options.ready !== false) {
    ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
    ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1 } } });
  }
  return { bridge, ws, env, changes };
}

// ---------------------------------------------------------------------------
// readSettings, normalizeKcsItem, normalizeResults
// ---------------------------------------------------------------------------

test('readSettings lit les paramètres de la page de télécommande sans exécuter de code', () => {
  assert.deepEqual(readSettings(page()), { kcs_url: KCS_URL, label: 'accolade } dans une "chaîne" {' },
    'les accolades et guillemets échappés dans une chaîne ne coupent pas la lecture');
  assert.deepEqual(readSettings('const Settings={"a":{"b":{"c":1}},"d":"\\\\"}; x = {}'),
    { a: { b: { c: 1 } }, d: '\\' }, 'objets imbriqués et barre oblique échappée');
  assert.deepEqual(readSettings('let  Settings = {}'), {});
  assert.equal(readSettings('<html>session terminée</html>'), null, 'page sans paramètres : session fermée');
  assert.equal(readSettings('var MySettings = {"kcs_url":"wss://x"}'), null, 'seul le nom exact Settings compte');
  assert.throws(() => readSettings('var Settings = {"kcs_url": "wss://x", "a": {'),
    /Paramètres de télécommande incomplets/);
});

test('normalizeKcsItem : titre, quiz et options de la file KaraFun', () => {
  assert.deepEqual(normalizeKcsItem({ id: 42, song: { id: { id: 5091 }, title: 'Titre', artist: 'Artiste',
    options: { singer: 'Léa' } } }), {
    queueId: '42', id: '42', songId: 5091, title: 'Titre', artist: 'Artiste', singer: 'Léa',
    options: { singer: 'Léa' } });
  assert.deepEqual(normalizeKcsItem({ id: 'q-9', quiz: { id: { id: 77 }, title: 'Quiz musical' } }), {
    queueId: 'q-9', id: 'q-9', songId: undefined, title: 'Quiz musical', artist: '', singer: '',
    options: {}, quizId: 77 });
  const bare = normalizeKcsItem({ id: 3 });
  assert.equal(bare.title, '');
  assert.equal(bare.singer, '');
  assert.equal(Object.hasOwn(bare, 'quizId'), false);
});

test('normalizeResults accepte les différentes formes de réponse de recherche', () => {
  assert.deepEqual(normalizeResults({ songs: [{ id: '12', title: 'Un', artist: { name: 'A' }, img: 'i.jpg', duet: 1 }] }),
    [{ songId: 12, title: 'Un', artist: 'A', img: 'i.jpg', duration: null, duo: true }]);
  assert.deepEqual(normalizeResults({ results: [{ song: { id: 3, title: 'Trois', artist: 'B' }, duration: 200 }] }),
    [{ songId: 3, title: 'Trois', artist: 'B', img: null, duration: 200, duo: false }]);
  assert.equal(normalizeResults({ items: [{ id: 1 }, { title: 'sans id' }] }).length, 0, 'titre ou id manquant : ignoré');
  assert.deepEqual(normalizeResults(null), []);
  assert.equal(normalizeResults(Array.from({ length: 60 }, (_, i) => ({ id: i + 1, title: `T${i}` }))).length, 40);
});

// ---------------------------------------------------------------------------
// KcsTransport seul
// ---------------------------------------------------------------------------

test('KcsTransport : sous-protocole, ouverture et envoi de messages JSON numérotés', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, KCS_URL);
  assert.equal(ws.protocol, 'kcpj~v3+emuping');
  assert.throws(() => transport.send('remote.PlayRequest'), /Pas connecté à KaraFun/, 'pas d’envoi avant ouverture');
  assert.deepEqual(ws.sent, []);
  t.mock.timers.tick(8000);
  let opened = 0;
  const out = [];
  transport.on('open', () => opened++);
  transport.on('out', m => out.push(m));
  ws.open();
  assert.equal(opened, 1);
  transport.send('remote.PlayRequest');
  transport.send('remote.RemoveFromQueueRequest', { queueItemId: '7' });
  assert.deepEqual(ws.sent.map(({ type, payload }) => ({ type, payload })), [
    { type: 'remote.PlayRequest', payload: {} },
    { type: 'remote.RemoveFromQueueRequest', payload: { queueItemId: '7' } },
  ]);
  const [a, b] = ws.sent.map(m => m.id);
  assert.ok(Number.isInteger(a) && b > a, 'identifiants distincts et croissants');
  assert.deepEqual(out, ws.sent, 'chaque envoi est signalé pour le journal');
});

test('KcsTransport répond aux Ping et Timestamp de KaraFun avec le même identifiant', t => {
  mockTime(t);
  t.mock.timers.setTime(Date.parse('2026-10-02T21:30:00.000Z'));
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  const received = [];
  transport.on('message', m => received.push(m.type));
  ws.open();
  ws.receive({ id: 41, type: 'core.PingRequest', payload: {} });
  ws.receive({ id: 'abc', type: 'core.TimestampRequest', payload: {} });
  assert.deepEqual(ws.sent, [
    { id: 41, type: 'core.PingResponse', payload: {} },
    { id: 'abc', type: 'core.TimestampResponse', payload: { timestamp: { _type: 'timestamp', value: '2026-10-02T21:30:00.000Z' } } },
  ]);
  assert.deepEqual(received, ['core.PingRequest', 'core.TimestampRequest'], 'les messages restent visibles du pont');
});

test('KcsTransport : messages illisibles ou sans type', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  const errors = [], messages = [];
  transport.on('transport-error', e => errors.push(e));
  transport.on('message', m => messages.push(m));
  ws.open();
  ws.receive('{pas du json');
  ws.receive('null');
  ws.receive({ id: 1, payload: {} });
  ws.receive({ type: 42 });
  assert.deepEqual(errors, ['Message KaraFun illisible.']);
  assert.deepEqual(messages, [], 'un message sans type texte est ignoré');
  assert.deepEqual(ws.sent, []);
});

test('KcsTransport : commande sans réponse au bout de 8 s → request-timeout ; réponse reçue → rien', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  const timeouts = [], stale = [];
  transport.on('request-timeout', type => timeouts.push(type));
  transport.on('stale', m => stale.push(m));
  ws.open();
  transport.send('remote.PlayRequest');
  transport.send('remote.NextRequest');
  t.mock.timers.tick(5000);
  ws.receive({ id: 2, type: 'remote.NextResponse', payload: {} });
  t.mock.timers.tick(2999);
  assert.deepEqual(timeouts, []);
  t.mock.timers.tick(1);
  assert.deepEqual(timeouts, ['remote.PlayRequest'], 'seule la commande sans réponse expire');
  t.mock.timers.tick(6000);
  assert.deepEqual(timeouts, ['remote.PlayRequest'], 'NextRequest confirmée : pas d’expiration');
  assert.equal(stale.length, 0, 'messages reçus récemment : pas de silence détecté avant 10 s');
});

test('KcsTransport : silence de KaraFun → stale puis fermeture (10 s connecté, 15 s en attente)', t => {
  mockTime(t);
  fakes(t);
  const opened = new KcsTransport(KCS_URL);
  const waiting = new KcsTransport(KCS_URL);
  t.after(() => { opened.close(); waiting.close(); });
  const [ws, wsWaiting] = FakeWebSocket.instances;
  const stale = [];
  opened.on('stale', m => stale.push(['ouvert', m]));
  waiting.on('stale', m => stale.push(['attente', m]));
  ws.open();
  t.mock.timers.tick(6000);
  ws.receive({ type: 'remote.StatusEvent', payload: {} });
  t.mock.timers.tick(8000);
  assert.deepEqual(stale, [], '14 s sans ouverture, 8 s sans message : encore patient');
  t.mock.timers.tick(2000);
  assert.deepEqual(stale, [['attente', 'KaraFun ne répond plus ; reconnexion en cours.']],
    'jamais ouvert : abandon après 15 s ; ouvert : dernier message à 10 s pile, encore vivant');
  assert.equal(ws.closeCalls, 0);
  t.mock.timers.tick(2000);
  assert.deepEqual(stale, [['attente', 'KaraFun ne répond plus ; reconnexion en cours.'],
    ['ouvert', 'KaraFun ne répond plus ; reconnexion en cours.']]);
  assert.equal(ws.closeCalls, 1, 'le WebSocket muet est fermé');
  assert.equal(wsWaiting.closeCalls, 1);
  t.mock.timers.tick(30000);
  assert.equal(stale.length, 2, 'le chien de garde s’arrête après la fermeture');
});

test('KcsTransport : erreur et fermeture côté KaraFun, puis plus aucun événement', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  const ws = FakeWebSocket.instances[0];
  const events = [];
  for (const name of ['transport-error', 'close', 'message', 'request-timeout', 'stale']) {
    transport.on(name, data => events.push([name, data]));
  }
  ws.open();
  transport.send('remote.PlayRequest');
  ws.fail();
  ws.serverClose(1006);
  assert.deepEqual(events, [['transport-error', 'Connexion WebSocket KaraFun interrompue.'], ['close', { code: 1006 }]]);
  ws.fail();
  ws.serverClose(1000);
  ws.receive({ id: 5, type: 'core.PingRequest' });
  t.mock.timers.tick(60000);
  assert.equal(events.length, 2, 'après fermeture : ni erreur, ni message, ni expiration, ni silence');
  assert.deepEqual(sentTypes(ws), ['remote.PlayRequest'], 'pas de PingResponse sur une connexion fermée');
  assert.throws(() => transport.send('remote.NextRequest'), /Pas connecté à KaraFun/);
  assert.equal(ws.closeCalls, 0, 'fermé par KaraFun : rien à refermer');
});

test('KcsTransport.close : idempotent, annule les attentes et ignore la suite', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  const ws = FakeWebSocket.instances[0];
  const events = [];
  for (const name of ['transport-error', 'close', 'message', 'request-timeout', 'stale', 'open']) {
    transport.on(name, data => events.push(name));
  }
  ws.open();
  transport.send('remote.PlayRequest');
  transport.close();
  transport.close();
  assert.equal(ws.closeCalls, 1);
  ws.open();
  ws.receive({ id: 9, type: 'core.PingRequest' });
  ws.fail();
  ws.serverClose(1000);
  t.mock.timers.tick(60000);
  assert.deepEqual(events, ['open'], 'fermeture volontaire : aucun événement ensuite');
  assert.throws(() => transport.send('remote.PlayRequest'), /Pas connecté à KaraFun/);
});

test('KcsTransport : un message qui provoque la fermeture n’entraîne pas de réponse au Ping', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  const ws = FakeWebSocket.instances[0];
  transport.on('message', () => transport.close());
  ws.open();
  ws.receive({ id: 1, type: 'core.PingRequest' });
  assert.deepEqual(ws.sent, []);
  assert.equal(ws.closeCalls, 1);
});

// ---------------------------------------------------------------------------
// KaraFunBridge : découverte de la télécommande
// ---------------------------------------------------------------------------

test('connect : découverte de la page de télécommande puis WebSocket KCS, sans journaliser le jeton', async t => {
  mockTime(t);
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcs-journal-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const { bridge, ws, env } = await connected(t, { code: '123 456', logDir });
  t.after(() => bridge.disconnect());
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].url, 'https://kf.exemple.invalid/123456/', 'code nettoyé, page de la télécommande');
  assert.ok(env.calls[0].options.signal, 'la découverte a un délai maximal');
  assert.equal(ws.url, KCS_URL);
  assert.equal(ws.protocol, 'kcpj~v3+emuping');
  const snap = bridge.snapshot();
  assert.equal(snap.code, CODE);
  assert.equal(snap.protocol, 'kcs');
  assert.equal(snap.connected, true);
  assert.equal(snap.ready, true);
  ws.receive({ id: 3, type: 'core.PingRequest' });
  bridge.play();
  const journal = fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('');
  assert.match(journal, /remote\.PlayRequest/, 'les commandes sont journalisées');
  assert.match(journal, /core\.PingRequest/);
  for (const text of [journal, JSON.stringify(bridge.snapshot())]) {
    assert.equal(text.includes('jeton-factice'), false, 'le jeton KCS ne doit jamais être écrit');
  }
});

test('connect : code vide refusé', t => {
  fakes(t);
  const bridge = new KaraFunBridge({ bases: ['https://kf.exemple.invalid'] });
  assert.throws(() => bridge.connect('abc'), /Code KaraFun manquant/);
  assert.throws(() => bridge.connect(), /Code KaraFun manquant/);
});

// Chaque échec de découverte a son message : un code faux et un site qui
// refuse ce PC ne se ressemblent plus dans le diagnostic.
const UNKNOWN = 'Code KaraFun inconnu ou télécommande fermée : vérifie le code affiché dans KaraFun et que sa télécommande est activée.';
const BAD_PAGE = 'Page de télécommande KaraFun inattendue : nouvel essai automatique.';
for (const [name, respond, message, kind, status] of [
  ['réponse HTTP 404', () => ({ ok: false, status: 404, text: async () => '' }), UNKNOWN, 'unknown-code', 404],
  ['session fermée (page sans paramètres)', () => ok('<html>Cette session est terminée</html>'), UNKNOWN, 'unknown-code', 200],
  ['paramètres tronqués', () => ok('<script>var Settings = {"kcs_url": "wss://x"'), BAD_PAGE, 'bad-page', 200],
  ['adresse KCS non chiffrée', () => ok(page({ kcs_url: 'ws://kcs.exemple.invalid/remote' })), BAD_PAGE, 'bad-page', 200],
  ['réseau coupé', () => { throw new TypeError('fetch failed'); },
    'Réseau coupé ou site KaraFun injoignable depuis ce PC : vérifie la connexion Internet.', 'network', undefined],
]) {
  test(`découverte impossible (${name}) : message au bar, autre adresse KaraFun, nouvel essai 5 s plus tard`, async t => {
    mockTime(t);
    const env = fakes(t, respond);
    const bridge = new KaraFunBridge({ bases: ['https://kf-a.exemple.invalid', 'https://kf-b.exemple.invalid'] });
    t.after(() => bridge.disconnect());
    let changes = 0;
    bridge.on('change', () => changes++);
    bridge.connect(CODE);
    await flush();
    assert.equal(env.sockets.length, 0, 'aucun WebSocket ouvert');
    const snap = bridge.snapshot();
    assert.equal(snap.unreachable, true);
    assert.equal(snap.connected, false);
    assert.equal(snap.lastError, message);
    assert.equal(snap.base, 'https://kf-b.exemple.invalid', 'on essaie l’autre site KaraFun');
    assert.equal(snap.connection.phase, 'retry');
    assert.equal(snap.connection.level, 'error');
    assert.ok(changes >= 1, 'le bar est prévenu');
    const failure = bridge.events.find(e => e.name === 'discovery-error');
    assert.equal(failure.data.kind, kind);
    assert.equal(failure.data.status, status, 'état HTTP noté');
    assert.equal(failure.data.host, 'kf-a.exemple.invalid');
    assert.equal(JSON.stringify(bridge.events).includes('kcs.exemple'), false, 'jamais l’URL KCS dans le journal');
    t.mock.timers.tick(4999);
    assert.equal(env.calls.length, 1);
    t.mock.timers.tick(1);
    assert.equal(env.calls.length, 2);
    assert.equal(env.calls[1].url, `https://kf-b.exemple.invalid/${CODE}/`);
  });
}

test('déconnexion pendant la découverte : la réponse tardive n’ouvre rien', async t => {
  mockTime(t);
  let release;
  const env = fakes(t, () => new Promise(resolve => { release = resolve; }));
  const bridge = new KaraFunBridge({ bases: ['https://kf.exemple.invalid'] });
  bridge.connect(CODE);
  await flush();
  bridge.disconnect();
  release(ok(page()));
  await flush();
  assert.equal(env.sockets.length, 0);
  assert.equal(bridge.connected, false);
  assert.equal(bridge.lastError, null);
  t.mock.timers.tick(60000);
  assert.equal(env.calls.length, 1, 'pas de nouvel essai après une déconnexion voulue');
});

test('déconnexion pendant la découverte en échec : pas de message ni de nouvel essai', async t => {
  mockTime(t);
  let fail;
  const env = fakes(t, () => new Promise((_, reject) => { fail = reject; }));
  const bridge = new KaraFunBridge({ bases: ['https://kf-a.exemple.invalid', 'https://kf-b.exemple.invalid'] });
  bridge.connect(CODE);
  await flush();
  bridge.disconnect();
  fail(new TypeError('fetch failed'));
  await flush();
  assert.equal(bridge.lastError, null);
  assert.equal(bridge.unreachable, false);
  assert.equal(bridge.base, 'https://kf-a.exemple.invalid');
  t.mock.timers.tick(60000);
  assert.equal(env.calls.length, 1);
});

// ---------------------------------------------------------------------------
// KaraFunBridge : événements reçus de KaraFun
// ---------------------------------------------------------------------------

test('ouverture KCS : connecté mais pas prêt avant les deux snapshots file et lecture', async t => {
  mockTime(t);
  const { bridge, ws, changes } = await connected(t, { ready: false });
  t.after(() => bridge.disconnect());
  assert.equal(bridge.connected, true);
  assert.equal(bridge.ready, false);
  assert.ok(changes.count >= 1);
  assert.throws(() => bridge.play(), /Pas connecté à KaraFun/, 'aucune commande avant les snapshots');
  const queues = [], statuses = [];
  bridge.on('queue', q => queues.push(q));
  bridge.on('status', s => statuses.push(s));
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [
    { id: 11, song: { id: { id: 5091 }, title: 'Premier', artist: 'A', options: { singer: 'Léa' } } },
    { id: 12, song: { id: { id: 77 }, title: 'Second', artist: 'B', options: {} } },
  ] } } });
  assert.equal(bridge.ready, false, 'la file seule ne suffit pas');
  assert.deepEqual(bridge.queue.map(i => [i.queueId, i.songId, i.title, i.singer]),
    [['11', 5091, 'Premier', 'Léa'], ['12', 77, 'Second', '']]);
  assert.equal(queues.length, 1);
  assert.equal(bridge.raw.queue.items.length, 2, 'trame brute gardée pour le diagnostic');
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [
    { id: 'b-1', song: { id: { id: 5091 }, title: 'Battle', options: { mod: BATTLE_MOD } } },
    { id: 12, song: { id: { id: 77 }, title: 'Second', artist: 'B', options: {} } },
  ] } } });
  assert.deepEqual(bridge.queue.map(isBattleItem), [true, false], 'la Battle confirmée par KaraFun est reconnue');
  assert.equal(queues.length, 2);
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 4, volume: 50,
    current: { id: 11, song: { id: { id: 5091 }, title: 'Premier', options: { singer: 'Léa' } } } } } });
  assert.equal(bridge.ready, true);
  assert.equal(bridge.status.state, 'playing');
  assert.equal(bridge.status.volume, 50);
  assert.equal(bridge.status.current.queueId, '11');
  assert.equal(statuses.length, 1);
  assert.equal(bridge.raw.status.state, 4, 'état brut gardé pour le diagnostic');
  assert.ok(bridge.lastEventAt > 0 || bridge.lastEventAt === 0);
});

test('StatusEvent : états KaraFun traduits, trames incomplètes ignorées', async t => {
  mockTime(t);
  const { bridge, ws } = await connected(t);
  t.after(() => bridge.disconnect());
  const state = n => {
    ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: n } } });
    return bridge.status.state;
  };
  assert.deepEqual([1, 2, 3, 4, 5, 99].map(state), ['idle', 'loading', 'idle', 'playing', 'paused', 'idle']);
  assert.equal(bridge.status.current, null);
  state(4);
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 'playing' } } });
  ws.receive({ type: 'remote.StatusEvent', payload: {} });
  ws.receive({ type: 'remote.StatusEvent' });
  assert.equal(bridge.status.state, 'playing', 'état non numérique ou absent : dernier état connu gardé');
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [{ id: 1, song: { title: 'X' } }] } } });
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: {} } });
  ws.receive({ type: 'remote.QueueEvent', payload: {} });
  assert.deepEqual(bridge.queue.map(i => i.title), ['X'], 'file sans liste : dernière file connue gardée');
  ws.receive({ type: 'remote.QueueResponse', payload: { queue: { items: [] } } });
  ws.receive({ type: 'remote.StatusResponse', payload: { status: { state: 5 } } });
  assert.deepEqual(bridge.queue, []);
  assert.equal(bridge.status.state, 'paused', 'les réponses ont la même forme que les événements');
});

test('droits, préférences et configuration de la télécommande', async t => {
  mockTime(t);
  const { bridge, ws, changes } = await connected(t);
  t.after(() => bridge.disconnect());
  const before = changes.count;
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: {
    addToQueue: true, managePlayback: true, manageVolumes: false, sendPhotos: true, shownTypes: { battle: true } } } });
  assert.equal(bridge.permissions.managePlayer, true);
  assert.equal(bridge.permissions.manageKaraoke, false);
  assert.equal(bridge.permissions.uploadPicture, true);
  assert.equal(bridge.raw.permissions.managePlayback, true);
  assert.equal(bridge.permissionWarning, null);
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: {} });
  assert.equal(bridge.permissions.managePlayer, false, 'droits absents : tout est refusé');
  assert.match(bridge.permissionWarning,
    new RegExp(`KaraFun ne donne plus à ${bridge.username} : lecture\\. Redonne-lui les droits d’administrateur`),
    'addToQueue et battle non précisés restent permis ; seule la lecture est perdue');
  ws.receive({ type: 'remote.PreferencesUpdateEvent', payload: { preferences: { askOptions: 1, lang: 'fr' } } });
  assert.deepEqual(bridge.preferences, { askOptions: 1, lang: 'fr', askSingerName: true });
  ws.receive({ type: 'remote.PreferencesUpdateEvent', payload: {} });
  assert.deepEqual(bridge.preferences, { askSingerName: false });
  ws.receive({ type: 'remote.ConfigurationUpdateEvent', payload: { configuration: { compatibleMods: { battle: [1] } } } });
  assert.deepEqual(bridge.raw.configuration, { compatibleMods: { battle: [1] } });
  assert.ok(changes.count >= before + 5, 'chaque mise à jour prévient le bar');
});

test('perte de droits signalée même après une reconnexion au même code, oubliée avec un autre code', async t => {
  mockTime(t);
  const { bridge, ws, env } = await connected(t);
  t.after(() => bridge.disconnect());
  const full = { addToQueue: true, managePlayback: true, shownTypes: { battle: true } };
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: full } });
  bridge.connect(CODE);
  await flush();
  const ws2 = env.sockets.at(-1);
  ws2.open();
  ws2.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: { ...full, addToQueue: false, shownTypes: { battle: false } } } });
  assert.match(bridge.permissionWarning, /ajout de titres, mode Battle\./);
  bridge.connect('654321');
  assert.equal(bridge.permissionWarning, null, 'nouveau code : nouvelle session KaraFun');
  await flush();
  const ws3 = env.sockets.at(-1);
  ws3.open();
  ws3.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: { addToQueue: false } } });
  assert.equal(bridge.permissionWarning, null, 'aucun droit connu auparavant pour ce code');
});

test('authentification : la file demande son nom habituel, KaraFun le confirme', async t => {
  mockTime(t);
  const { bridge, ws } = await connected(t);
  t.after(() => bridge.disconnect());
  ws.receive({ type: 'core.AuthenticatedEvent', payload: {} });
  assert.deepEqual(ws.sent.at(-1), { id: 1, type: 'remote.UpdateUsernameRequest', payload: { username: bridge.username } });
  ws.receive({ type: 'Error', payload: { type: 4, message: 'Username is already used' } });
  assert.match(bridge.lastError, new RegExp(`ancienne connexion de ${bridge.username}`));
  t.mock.timers.tick(3999);
  assert.equal(ws.sent.filter(m => m.type === 'remote.UpdateUsernameRequest').length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(ws.sent.at(-1), { id: 2, type: 'remote.UpdateUsernameRequest', payload: { username: bridge.username } },
    'même nom redemandé 4 s plus tard');
  ws.receive({ id: 1, type: 'remote.UpdateUsernameResponse', payload: {} });
  ws.receive({ id: 2, type: 'remote.UpdateUsernameResponse', payload: {} });
  assert.equal(bridge.lastError, null, 'nom accepté : le message disparaît');
  ws.receive({ type: 'Error', payload: { type: 4, message: 'Username is already used' } });
  ws.receive({ type: 'remote.UsernameUpdateEvent', payload: { username: bridge.username } });
  assert.equal(bridge.lastError, null);
});

test('nom occupé puis coupure : la relance prévue n’est pas envoyée sur l’ancienne connexion', async t => {
  mockTime(t);
  const { bridge, ws } = await connected(t);
  t.after(() => bridge.disconnect());
  ws.receive({ type: 'core.AuthenticatedEvent', payload: {} });
  ws.receive({ type: 'Error', payload: { type: 4, message: 'username is already used' } });
  ws.serverClose(1006);
  t.mock.timers.tick(4000);
  assert.equal(ws.sent.filter(m => m.type === 'remote.UpdateUsernameRequest').length, 1);
});

test('erreurs de commande KaraFun : message lisible pour le bar', async t => {
  mockTime(t);
  const { bridge, ws } = await connected(t);
  t.after(() => bridge.disconnect());
  ws.receive({ type: 'Error', payload: { type: 3, message: 'Permission denied' } });
  assert.equal(bridge.lastError, 'Commande KaraFun refusée : Permission denied');
  ws.receive({ type: 'Error', payload: { type: 4, message: 'Queue is full' } });
  assert.equal(bridge.lastError, 'Commande KaraFun refusée : Queue is full', 'type 4 sans nom occupé : erreur ordinaire');
  ws.receive({ type: 'Error', payload: { type: 7 } });
  assert.equal(bridge.lastError, 'Commande KaraFun refusée : 7');
  ws.receive({ type: 'Error' });
  assert.equal(bridge.lastError, 'Commande KaraFun refusée : erreur inconnue');
  assert.equal(bridge.connected, true, 'une commande refusée ne coupe pas la connexion');
  ws.receive({ type: 'remote.SomethingNewEvent', payload: { x: 1 } });
  assert.equal(bridge.events.at(-1).name, 'remote.SomethingNewEvent', 'événement inconnu journalisé sans effet');
});

test('KaraFun fermé (AppLeftEvent) : message au bar, fermeture puis reconnexion 3 s plus tard par l’URL gardée', async t => {
  mockTime(t);
  const { bridge, ws, env } = await connected(t);
  t.after(() => bridge.disconnect());
  ws.receive({ type: 'remote.AppLeftEvent', payload: {} });
  assert.equal(bridge.unreachable, true);
  assert.equal(bridge.lastError, 'KaraFun est fermé ou sa télécommande a été désactivée.');
  assert.equal(bridge.connected, false);
  assert.equal(bridge.ready, false);
  assert.equal(bridge.socket, null);
  assert.equal(ws.closeCalls, 1);
  assert.throws(() => bridge.next(), /Pas connecté à KaraFun/);
  // L'ancienne connexion ne modifie plus l'état.
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [{ id: 1, song: { title: 'Fantôme' } }] } } });
  assert.deepEqual(bridge.queue, []);
  t.mock.timers.tick(2999);
  assert.equal(env.sockets.length, 1);
  t.mock.timers.tick(1);
  assert.equal(env.sockets.length, 2, 'nouvelle connexion');
  assert.equal(env.calls.length, 1, 'URL KCS gardée : la page n’est pas relue');
  const ws2 = env.sockets.at(-1);
  assert.notEqual(ws2, ws);
  assert.equal(ws2.url, KCS_URL);
  ws2.open();
  ws2.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  ws2.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1 } } });
  assert.equal(bridge.ready, true);
  assert.equal(bridge.unreachable, false);
  assert.equal(bridge.lastError, null, 'KaraFun revenu : plus de message');
});

test('coupure du WebSocket par KaraFun : message avec le code, reconnexion', async t => {
  mockTime(t);
  const { bridge, ws, env } = await connected(t);
  t.after(() => bridge.disconnect());
  ws.fail();
  assert.equal(bridge.lastError, 'Connexion WebSocket KaraFun interrompue.');
  assert.equal(bridge.connected, true, 'une erreur seule ne coupe pas');
  assert.ok(bridge.events.some(e => e.name === 'connect_error'));
  ws.receive('pas du json');
  assert.equal(bridge.lastError, 'Message KaraFun illisible.');
  ws.serverClose(4001);
  assert.equal(bridge.lastError, 'Télécommande KaraFun déconnectée (code 4001). Vérifie le code affiché dans KaraFun.');
  assert.equal(bridge.unreachable, true);
  assert.equal(bridge.connected, false);
  assert.ok(bridge.events.some(e => e.name === 'connexion-perdue'));
  t.mock.timers.tick(3000);
  assert.equal(env.sockets.length, 2, 'reconnexion par l’URL KCS gardée');
  assert.equal(env.calls.length, 1);
});

test('KaraFun muet : le chien de garde relance la connexion', async t => {
  mockTime(t);
  const { bridge, ws, env } = await connected(t);
  t.after(() => bridge.disconnect());
  t.mock.timers.tick(10000);
  assert.equal(bridge.connected, true);
  t.mock.timers.tick(2000);
  assert.equal(bridge.lastError, 'KaraFun ne répond plus ; reconnexion en cours.');
  assert.equal(bridge.unreachable, true);
  assert.equal(ws.closeCalls, 1);
  t.mock.timers.tick(3000);
  assert.equal(env.sockets.length, 2, 'reconnexion par l’URL KCS gardée');
  assert.equal(env.calls.length, 1);
});

test('commande non confirmée en 8 s : reconnexion avec le nom de la commande', async t => {
  mockTime(t);
  const { bridge, ws, env } = await connected(t);
  t.after(() => bridge.disconnect());
  bridge.next();
  t.mock.timers.tick(7999);
  assert.equal(bridge.connected, true);
  t.mock.timers.tick(1);
  assert.equal(bridge.lastError, 'KaraFun ne confirme plus les commandes (remote.NextRequest) ; reconnexion en cours.');
  assert.equal(bridge.connected, false);
  assert.equal(ws.closeCalls, 1);
  t.mock.timers.tick(3000);
  assert.equal(env.sockets.length, 2, 'reconnexion par l’URL KCS gardée');
  assert.equal(env.calls.length, 1);
});

// ---------------------------------------------------------------------------
// KaraFunBridge : commandes envoyées à KaraFun
// ---------------------------------------------------------------------------

test('commandes de la file traduites en requêtes KCS exactes', async t => {
  mockTime(t);
  const { bridge, ws } = await connected(t);
  t.after(() => bridge.disconnect());
  bridge.add('5091', 'Léa', 3);
  bridge.add(77, null);
  bridge.remove(1234);
  bridge.remove('q-uuid');
  bridge.move(55, 4, 1);
  bridge.play();
  bridge.next();
  assert.deepEqual(ws.sent.map(({ type, payload }) => ({ type, payload })), [
    { type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 5091 }, options: { singer: 'Léa' }, position: 3 } },
    { type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 77 }, options: { singer: '' }, position: 99999 } },
    { type: 'remote.RemoveFromQueueRequest', payload: { queueItemId: '1234' } },
    { type: 'remote.RemoveFromQueueRequest', payload: { queueItemId: 'q-uuid' } },
    { type: 'remote.MoveInQueueRequest', payload: { queueItemId: '55', to: 1 } },
    { type: 'remote.PlayRequest', payload: {} },
    { type: 'remote.NextRequest', payload: {} },
  ]);
  assert.deepEqual(ws.sent.map(m => m.id), [1, 2, 3, 4, 5, 6, 7], 'chaque requête a son identifiant');
  assert.throws(() => bridge._emit('pause', null), /Commande KaraFun inconnue/);
  assert.equal(ws.sent.length, 7, 'commande inconnue : rien n’est envoyé');
  const out = bridge.events.filter(e => e.dir === 'out').map(e => e.name);
  assert.deepEqual(out.slice(-2), ['remote.PlayRequest', 'remote.NextRequest'], 'envois journalisés');
});

test('Battle KCS : envoyée seulement si KaraFun la déclare compatible et permise', async t => {
  mockTime(t);
  const { bridge, ws } = await connected(t);
  t.after(() => bridge.disconnect());
  assert.throws(() => bridge.addBattle(5091), /ne confirme pas le mode Battle/);
  assert.throws(() => bridge.addBattle('abc'), /Titre Battle invalide/);
  assert.throws(() => bridge.addBattle(0), /Titre Battle invalide/);
  ws.receive({ type: 'remote.ConfigurationUpdateEvent', payload: { configuration: { compatibleMods: { battle: [1] } } } });
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: { addToQueue: true, shownTypes: { battle: false } } } });
  assert.throws(() => bridge.addBattle(5091), /Permission Battle refusée/);
  assert.equal(ws.sent.length, 0);
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: { addToQueue: true, shownTypes: { battle: true } } } });
  bridge.addBattle('5091');
  assert.deepEqual(ws.sent.at(-1).payload, { song: { type: 1, id: 5091 }, options: { mod: BATTLE_MOD }, position: 0 });
});

test('Battle sans télécommande récente : refusée sur un vrai KaraFun ancien protocole', () => {
  const bridge = new KaraFunBridge({ bases: ['https://kf.exemple.invalid'] });
  bridge.protocol = 'socket.io';
  assert.throws(() => bridge.addBattle(5091), /nécessite la télécommande KaraFun récente/);
});

// ---------------------------------------------------------------------------
// Recherche de titres
// ---------------------------------------------------------------------------

test('recherche : demande JSON, repli sur l’autre site KaraFun, erreur claire sinon', async t => {
  const bridge = new KaraFunBridge({ bases: ['https://kf-a.exemple.invalid', 'https://kf-b.exemple.invalid'] });
  await assert.rejects(bridge.search('abba'), /Pas de code KaraFun/);
  bridge.code = CODE;
  const env = fakes(t, url => {
    if (url.startsWith('https://kf-a')) throw new TypeError('fetch failed');
    return ok(JSON.stringify([{ id: 9, title: 'Dancing Queen', artist: 'ABBA' }]));
  });
  assert.deepEqual(await bridge.search('abba & co'), [
    { songId: 9, title: 'Dancing Queen', artist: 'ABBA', img: null, duration: null, duo: false }]);
  assert.deepEqual(env.calls.map(c => c.url), [
    `https://kf-a.exemple.invalid/${CODE}/?type=search&q=abba%20%26%20co&types=karaoke`,
    `https://kf-b.exemple.invalid/${CODE}/?type=search&q=abba%20%26%20co&types=karaoke`]);
  assert.equal(env.calls[1].options.headers.Accept, 'application/json');
  assert.ok(bridge.events.some(e => e.name === 'search-sample'));
  globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => '<html>Bad gateway</html>' });
  await assert.rejects(bridge.search('abba'), /Réponse inattendue \(502\)/);
});

// ---------------------------------------------------------------------------
// Ancien protocole socket.io (faux KaraFun local) : cas d'erreur
// ---------------------------------------------------------------------------

function legacy(t) {
  mockTime(t);
  ioSockets.length = 0;
  const bridge = new KaraFunBridge({ bases: ['http://localhost:1', 'http://127.0.0.1:2'] });
  t.after(() => bridge.disconnect());
  bridge.connect(CODE);
  return bridge;
}

test('page de télécommande sans adresse KCS : repli sur l’ancien protocole socket.io', async t => {
  mockTime(t);
  ioSockets.length = 0;
  const env = fakes(t, () => ok(page({ version: 2 })));
  const bridge = new KaraFunBridge({ bases: ['https://kf.exemple.invalid'] });
  t.after(() => bridge.disconnect());
  bridge.connect(CODE);
  await flush();
  assert.equal(env.sockets.length, 0, 'pas de WebSocket KCS');
  assert.equal(bridge.protocol, 'socket.io');
  assert.equal(ioSockets.length, 1);
  assert.equal(ioSockets[0].base, 'https://kf.exemple.invalid');
  assert.deepEqual(ioSockets[0].options.query, { remote: `kf${CODE}` });
});

test('ancien protocole : connexion, authentification et file reçue', t => {
  const bridge = legacy(t);
  const socket = ioSockets[0];
  assert.equal(socket.base, 'http://localhost:1');
  assert.deepEqual(socket.options.query, { remote: `kf${CODE}` });
  assert.equal(bridge.protocol, 'socket.io');
  socket.fire('connect');
  assert.equal(bridge.connected, true);
  assert.deepEqual(socket.outgoing[0], { name: 'authenticate', args: [
    { login: bridge.username, channel: CODE, role: 'participant', app: 'karafun', socket_id: null }, null] });
  socket.receive('queue', 'pas une liste');
  assert.deepEqual(bridge.queue, []);
  socket.receive('status', { state: 'idle' });
  assert.equal(bridge.ready, true);
  bridge.remove(5);
  assert.deepEqual(socket.outgoing.at(-1), { name: 'queueRemove', args: [5] });
});

test('ancien protocole : échec de connexion, autre adresse et nouvel essai', t => {
  const bridge = legacy(t);
  ioSockets[0].fire('connect_error', new Error('xhr poll error'));
  assert.equal(bridge.lastError, 'Connexion impossible à http://localhost:1 : xhr poll error');
  assert.equal(ioSockets[0].closed, true);
  t.mock.timers.tick(3000);
  assert.equal(ioSockets.length, 2);
  assert.equal(ioSockets[1].base, 'http://127.0.0.1:2');
});

test('ancien protocole : déconnexion puis reconnexion 3 s plus tard', t => {
  const bridge = legacy(t);
  ioSockets[0].fire('connect');
  ioSockets[0].fire('disconnect', 'transport close');
  assert.equal(bridge.connected, false);
  assert.ok(bridge.events.some(e => e.name === 'disconnect' && e.data === 'transport close'));
  t.mock.timers.tick(3000);
  assert.equal(ioSockets.length, 2);
  assert.equal(ioSockets[1].base, 'http://localhost:1', 'simple coupure : même adresse');
});

test('ancien protocole : code inconnu de KaraFun, message au bar', t => {
  mockTime(t);
  for (const name of ['serverUnreacheable', 'serverUnreachable']) {
    ioSockets.length = 0;
    const bridge = new KaraFunBridge({ bases: ['http://localhost:1', 'http://127.0.0.1:2'] });
    bridge.connect(CODE);
    ioSockets[0].fire(name);
    assert.equal(bridge.unreachable, true, name);
    assert.match(bridge.lastError, /vérifie que KaraFun est ouvert et que le code est le bon/);
    t.mock.timers.tick(5000);
    assert.equal(ioSockets.at(-1).base, 'http://127.0.0.1:2');
    bridge.disconnect();
  }
});

test('ancien protocole : nom déjà pris, on redemande le même nom 4 s plus tard', t => {
  const bridge = legacy(t);
  const socket = ioSockets[0];
  socket.fire('connect');
  const name = bridge.username;
  socket.fire('loginAlreadyTaken');
  t.mock.timers.tick(3999);
  assert.equal(socket.outgoing.length, 1);
  t.mock.timers.tick(1);
  assert.equal(socket.outgoing.length, 2);
  assert.equal(socket.outgoing[1].args[0].login, name);
});

test('identité et journal impossibles à écrire : la file fonctionne quand même', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcs-identite-'));
  try {
    const blocker = path.join(tmp, 'fichier');
    fs.writeFileSync(blocker, 'x');
    const bridge = new KaraFunBridge({ identityFile: path.join(blocker, 'sous', 'karafun-login.json'),
      logDir: path.join(tmp, 'absent') });
    assert.match(bridge.username, /^FileKaraoke-\d{4}$/);
    bridge._record('info', 'essai', {});
    assert.equal(bridge.events.at(-1).name, 'essai', 'journal en mémoire gardé');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
