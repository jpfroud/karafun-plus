'use strict';
// Protocole de la télécommande KaraFun actuelle (KCS, JSON sur WebSocket).
// C'est le chemin utilisé avec le VRAI KaraFun du bar, et avec le faux KaraFun
// de la démo (issue #59, test/fake-karafun.test.js pour la vraie connexion).
// Ici, tout est simulé : faux WebSocket global, faux fetch, faux
// socket.io-client. Aucun accès réseau, aucun vrai code de télécommande.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

// --- Faux socket.io-client (ancien protocole, page de KaraFun sans kcs_url) ---
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
const { KaraFunBridge, readSettings, normalizeKcsItem, normalizeResults, BATTLE_MOD, BATTLE_MODS_MAX, isBattleItem, battleModFor } = require('../karafun');
const { analyzeState } = require('../karafun-state');

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

// Regression: valeurs imprévues de KaraFun (suite de la relecture de l'étape 1
// Socket.IO, issue #59) — une exception levée par un écouteur du message (le
// pont) sortait de l'écouteur du WebSocket : Node la relance hors de toute
// portée, et le serveur du bar s'arrêtait. Filet : le message est ignoré et
// signalé ('message-error'), la lecture continue ; le Ping reçoit sa réponse,
// une réponse attendue reste rattachée à sa demande.
test('KcsTransport : un écouteur qui échoue n’arrête ni la lecture ni les réponses aux Ping', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  const errors = [], replies = [];
  transport.on('message', m => { if (m.payload?.piege) throw new TypeError('Cannot convert object to primitive value'); });
  transport.on('reply', (type, m) => {
    replies.push([type, m.type]);
    if (m.payload?.piege) throw new Error('réponse piégée');
  });
  transport.on('message-error', (type, reason) => errors.push([type, reason]));
  ws.open();
  assert.doesNotThrow(() => ws.receive({ id: 41, type: 'core.PingRequest', payload: { piege: true } }));
  const id = transport.send('remote.PlayRequest');
  assert.doesNotThrow(() => ws.receive({ id, type: 'remote.PlayResponse', payload: { piege: true } }));
  ws.receive({ id: 42, type: 'core.PingRequest', payload: {} });
  assert.deepEqual(errors, [['core.PingRequest', 'Cannot convert object to primitive value'],
    ['remote.PlayResponse', 'Cannot convert object to primitive value'], ['remote.PlayResponse', 'réponse piégée']]);
  assert.deepEqual(replies, [['remote.PlayRequest', 'remote.PlayResponse']], 'réponse rattachée à sa demande malgré l’échec');
  assert.equal(transport.requestType(id), null);
  assert.deepEqual(ws.sent.filter(m => m.type === 'core.PingResponse').map(m => m.id), [41, 42]);
});

// Regression: même relecture — un message imbriqué sur 100 000 niveaux
// épuisait la pile du pont (structuredClone d'un mode Battle) ; gardé dans le
// journal en mémoire, il aurait aussi cassé la page du bar (JSON.stringify).
// Les vraies trames ont 10 niveaux au plus. Un identifiant d'un type imprévu
// n'est jamais renvoyé à KaraFun. Regression: relecture 2 — au-delà de 32
// niveaux, tout le message était ignoré : 26 niveaux dans les options d'un
// seul titre (un client de télécommande qui en enverrait) figeaient la file
// de KaraFun vue par le serveur. Le contenu est coupé au-delà de 32 niveaux
// (remplacé par null) et le reste du message sert, Ping et réponses compris.
test('KcsTransport : message de plus de 32 niveaux coupé au-delà et lu, Ping et réponse servis, identifiant d’un type imprévu jamais renvoyé', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  const errors = [], messages = [], pruned = [];
  transport.on('message', m => messages.push(m));
  transport.on('message-error', (type, reason) => errors.push([type, reason]));
  transport.on('message-pruned', type => pruned.push(type));
  ws.open();
  const nested = levels => '{"a":'.repeat(levels) + '1' + '}'.repeat(levels);
  const depth = value => (value !== null && typeof value === 'object' ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 0);
  ws.receive(`{"type":"remote.QueueEvent","payload":${nested(31)}}`); // 32 niveaux avec le message
  assert.deepEqual([messages.length, depth(messages[0]), pruned], [1, 32, []], '32 niveaux : lu tel quel');
  for (const levels of [32, 100000]) ws.receive(`{"type":"remote.QueueEvent","payload":${nested(levels)}}`);
  assert.deepEqual(messages.slice(1).map(depth), [32, 32], 'au-delà : coupé à 32 niveaux, puis lu');
  assert.deepEqual(pruned, ['remote.QueueEvent', 'remote.QueueEvent']);
  assert.deepEqual(errors, [], 'rien d’illisible');
  ws.receive({ id: { piege: 1 }, type: 'core.PingRequest', payload: {} });
  ws.receive({ id: [7], type: 'core.TimestampRequest', payload: {} });
  assert.deepEqual(ws.sent.map(m => [m.type, 'id' in m]), [['core.PingResponse', false], ['core.TimestampResponse', false]],
    'réponse sans identifiant : un objet ou une liste n’est jamais renvoyé');
  // Trop imbriqués, un Ping et une réponse attendue servent comme les autres.
  const replies = [];
  transport.on('reply', (type, m) => replies.push([type, m.type, depth(m)]));
  ws.sent.length = 0;
  ws.receive(`{"id":43,"type":"core.PingRequest","payload":${nested(40)}}`);
  const id = transport.send('remote.AddToQueueRequest', {});
  ws.receive(`{"id":${id},"type":"remote.AddToQueueResponse","payload":${nested(40)}}`);
  assert.deepEqual(ws.sent.map(m => [m.type, m.id]), [['core.PingResponse', 43], ['remote.AddToQueueRequest', id]]);
  assert.deepEqual(replies, [['remote.AddToQueueRequest', 'remote.AddToQueueResponse', 32]], 'réponse rattachée, coupée à 32 niveaux');
  assert.equal(transport.requestType(id), null, 'plus en attente : pas de reconnexion 8 s plus tard');
  assert.equal(pruned.length, 4);
});

// Relecture 2, tour 2 (tests) : la coupe d'une liste n'était jamais essayée,
// tous les messages trop imbriqués des essais étaient faits d'objets. Une
// liste sur 100 000 niveaux est coupée à 32 comme un objet, puis lue.
test('KcsTransport : liste imbriquée au-delà de 32 niveaux coupée, puis lue', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  const messages = [], pruned = [];
  transport.on('message', m => messages.push(m));
  transport.on('message-pruned', type => pruned.push(type));
  ws.open();
  const depth = value => (value !== null && typeof value === 'object' ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 0);
  ws.receive(`{"type":"remote.QueueEvent","payload":{"list":${'['.repeat(100000)}1${']'.repeat(100000)}}}`);
  assert.deepEqual([messages.length, depth(messages[0]), pruned], [1, 32, ['remote.QueueEvent']]);
  // Liste coupée à sa place, au 32e niveau.
  let list = messages[0].payload.list;
  for (let level = 3; level < 32; level++) list = list[0];
  assert.deepEqual(list, [null]);
});

// Le filet du transport tient aussi quand l'écouteur qui reçoit le message
// ignoré ('message-error') ou coupé ('message-pruned') échoue à son tour :
// la lecture continue et les Ping reçoivent leur réponse.
test('KcsTransport : écouteurs de message-error et message-pruned qui échouent, la lecture et les Ping continuent', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  transport.on('message', () => { throw new Error('écouteur piégé'); });
  transport.on('message-error', () => { throw new Error('signalement piégé'); });
  transport.on('message-pruned', () => { throw new Error('coupe piégée'); });
  ws.open();
  const deep = '{"a":'.repeat(40) + '1' + '}'.repeat(40);
  assert.doesNotThrow(() => ws.receive({ id: 9, type: 'core.PingRequest', payload: {} }));
  assert.doesNotThrow(() => ws.receive(`{"id":10,"type":"core.PingRequest","payload":${deep}}`));
  assert.deepEqual(ws.sent.filter(m => m.type === 'core.PingResponse').map(m => m.id), [9, 10]);
});

// Regression: tour 3 de la relecture — un Ping reçu pendant la fermeture de la
// connexion faisait échouer la réponse, signalée comme un message illisible.
test('KcsTransport : Ping reçu pendant la fermeture, ni réponse ni message illisible', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  const errors = [];
  transport.on('message-error', (type, reason) => errors.push([type, reason]));
  ws.open();
  ws.readyState = FakeWebSocket.CLOSING;
  ws.receive({ id: 5, type: 'core.PingRequest', payload: {} });
  ws.receive({ id: 6, type: 'core.TimestampRequest', payload: {} });
  assert.deepEqual([errors, ws.sent], [[], []]);
});

// Regression: tour 3 de la relecture — la garde de profondeur gardait une paire
// [valeur, profondeur] pour chaque valeur, nombres compris : une trame large
// de quelques Mo épuisait la mémoire, ce qu'aucun filet ne rattrape (le
// processus s'arrête). Regression: relecture 2 — elle empilait encore chaque
// objet d'une liste : 1,2 million d'objets vides (3,6 Mo) l'épuisaient aussi,
// alors que la trame seule tient. Essai dans un processus à 96 Mo de mémoire.
test('KcsTransport : une trame large de quelques Mo, de nombres ou d’objets vides, n’épuise pas la mémoire du serveur', () => {
  for (const [item, count] of [['0', 2e6], ['{}', 1.2e6]]) {
    const child = `class WS { static OPEN = 1; constructor() { this.readyState = 1; this.listeners = {}; }
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } send() {} close() {} }
      globalThis.WebSocket = WS;
      const { KcsTransport } = require(${JSON.stringify(path.join(__dirname, '..', 'kcs-transport.js'))});
      const transport = new KcsTransport('wss://kcs.exemple.invalid/');
      let read = 0;
      transport.on('message', () => { read++; }); transport.on('message-error', () => {});
      const data = '{"type":"remote.ConfigurationUpdateEvent","payload":{"list":[' + ${JSON.stringify(`${item},`)}.repeat(${count}) + ${JSON.stringify(item)} + ']}}';
      for (const listener of transport.ws.listeners.message) listener({ data });
      transport.close(); console.log(read === 1 ? 'vivant' : 'non lu');`;
    const run = spawnSync(process.execPath, ['--max-old-space-size=96', '-e', child], { encoding: 'utf8' });
    assert.equal(run.status, 0, `liste de ${item} : ${run.stderr.slice(0, 300)}`);
    assert.match(run.stdout, /vivant/, `liste de ${item} lue`);
  }
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
  // Le numéro de KaraFun reste : 'idle' confond l'état 1 (titre annoncé) et l'état 3 (titre chargé).
  state(3);
  assert.equal(bridge.status.kcsState, 3);
  state(1);
  assert.equal(bridge.status.kcsState, 1);
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

// Trames réelles du 10 octobre (journal KaraFun du bar) : « Sarà perché ti
// amo » est un duo. La Battle demandée avec le mode « Battle » des titres à
// une voix arrive sans aucune option ; passée en Battle dans KaraFun, elle
// porte le mode de sa première voix.
const SARA_TRACKS = [{ caption: 'Angela Brambati', color: { red: 254, green: 71, blue: 208 }, type: 5 },
  { caption: 'Angelo Sotgiu', color: { red: 74, green: 142, blue: 255 }, type: 6 }];
const SARA_MOD = { id: 2, caption: 'Angela Brambati', data: { battle: { subtype: 1 } } };
const saraItem = options => ({ id: '920bd91b-d963-48b6-9d9f-6b5bfe82be94', song: { id: { type: 1, id: 18179 },
  artist: 'Ricchi e Poveri', songTracks: SARA_TRACKS, title: 'Sarà perché ti amo', ...(options ? { options } : {}) } });

test('Battle KCS d’un duo : mode de la première voix appris de la file, envoyé ensuite, et Battle de KaraFun reconnue', async t => {
  mockTime(t);
  const { bridge, ws } = await connected(t);
  t.after(() => bridge.disconnect());
  ws.receive({ type: 'remote.ConfigurationUpdateEvent', payload: { configuration: { compatibleMods: { battle: [1] } } } });
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: { addToQueue: true, manageQueue: true,
    shownTypes: { battle: true } } } });
  // Titre jamais vu : mode « Battle » (titre à une voix, comme « L'aventurier »).
  assert.deepEqual(bridge.battleModForSong(18179), BATTLE_MOD);
  assert.deepEqual(battleModFor([{ type: 5 }]), BATTLE_MOD, 'une voix guide sans nom : « Battle »');
  assert.deepEqual(battleModFor([{ type: 4 }, { type: 5 }]), BATTLE_MOD);
  assert.deepEqual(battleModFor(SARA_TRACKS), SARA_MOD, 'duo : première voix, numéro 2');
  // Copie normale reçue (QueueEvent de 23:21:56) : ses voix donnent le mode.
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [saraItem(null)] } } });
  assert.equal(isBattleItem(bridge.queue[0]), false);
  assert.deepEqual(bridge.queue[0].battleMod, SARA_MOD);
  assert.deepEqual(bridge.battleModForSong(18179), SARA_MOD);
  bridge.addBattle(18179, 1);
  assert.deepEqual(ws.sent.at(-1).payload, { song: { type: 1, id: 18179 }, options: { mod: SARA_MOD }, position: 1 });
  // Passage en mode Battle d'un titre de la file : options remplacées par le mode seul.
  bridge.setBattleMode('920bd91b-d963-48b6-9d9f-6b5bfe82be94', SARA_MOD);
  assert.deepEqual(ws.sent.at(-1), { id: ws.sent.at(-1).id, type: 'remote.SetQueueItemOptionsRequest',
    payload: { queueItemId: '920bd91b-d963-48b6-9d9f-6b5bfe82be94', options: { mod: SARA_MOD } } });
  assert.throws(() => bridge.setBattleMode('920bd91b', { id: 2, caption: 'x', data: {} }), /Mode Battle invalide/);
  assert.throws(() => bridge.addBattle(18179, 1, { id: 0, data: { battle: { subtype: 1 } } }), /Mode Battle invalide/);
  // Battle passée dans KaraFun (QueueEvent de 23:22:17) : reconnue, et son mode gardé.
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [saraItem({ mod: SARA_MOD })] } } });
  assert.equal(isBattleItem(bridge.queue[0]), true, 'mode numéro 2 : c’est une Battle');
  // Une copie vue ensuite sans voix connues ne remplace pas le mode observé.
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [{ ...saraItem(null),
    song: { ...saraItem(null).song, songTracks: [{ type: 5 }] } }] } } });
  assert.deepEqual(bridge.battleModForSong(18179), SARA_MOD);
  // Droit « Éditer la file d'attente » retiré : rien n'est envoyé.
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: { addToQueue: true, manageQueue: false,
    shownTypes: { battle: true } } } });
  const sent = ws.sent.length;
  assert.throws(() => bridge.setBattleMode('920bd91b', SARA_MOD), /Éditer la file d’attente/);
  assert.equal(ws.sent.length, sent);
});

test('Battle KCS : mode d’un duo seulement avec deux voix guides, dans l’ordre des pistes ; mémoire bornée', async t => {
  mockTime(t);
  // Voix listées dans le désordre, chœurs nommés : la première voix guide (5) donne le mode.
  assert.deepEqual(battleModFor([{ type: 6, caption: 'Angelo Sotgiu' }, { type: 4, caption: 'Chœurs' }, { type: 5, caption: 'Angela Brambati' }]), SARA_MOD);
  // Une seule voix guide, même nommée : titre à une voix, mode « Battle ».
  assert.deepEqual(battleModFor([{ type: 4 }, { type: 5, caption: 'Indochine' }]), BATTLE_MOD);
  // Piste hors des voix guides (au-delà de 15) : ignorée.
  assert.deepEqual(battleModFor([{ type: 5, caption: 'A' }, { type: 16, caption: 'B' }]), BATTLE_MOD);
  assert.deepEqual(battleModFor([{ type: 5 }, { type: 6, caption: 'B' }]), BATTLE_MOD, 'première voix sans nom');
  const { bridge, ws } = await connected(t);
  t.after(() => bridge.disconnect());
  // Battle sur scène (StatusEvent) : son mode est gardé pour le titre.
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 4, current: saraItem({ mod: SARA_MOD }) } } });
  assert.deepEqual(bridge.battleModForSong(18179), SARA_MOD);
  // Mémoire bornée : le titre le plus ancien sort, un titre revu reste.
  const duo = id => normalizeKcsItem({ id: `q${id}`, song: { id: { type: 1, id }, title: `Duo ${id}`, songTracks: SARA_TRACKS } });
  bridge._learnBattleMods([duo(1), duo(2)]);
  bridge._learnBattleMods([duo(1)]);
  bridge._learnBattleMods(Array.from({ length: BATTLE_MODS_MAX - 1 }, (_, i) => duo(1000 + i)));
  assert.equal(bridge.battleMods.size, BATTLE_MODS_MAX);
  assert.equal(bridge.battleMods.has(18179), false, 'le plus ancien est sorti');
  assert.equal(bridge.battleMods.has(2), false);
  assert.equal(bridge.battleMods.has(1), true, 'revu plus tard : gardé');
});

test('Battle KCS : la réponse au passage en mode Battle va au suivi de la Battle, pas aux réglages de titre', async t => {
  mockTime(t);
  const { bridge, ws } = await connected(t);
  t.after(() => bridge.disconnect());
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: { addToQueue: true, manageQueue: true,
    shownTypes: { battle: true } } } });
  const answers = [];
  bridge.on('battle-mode-answer', answer => answers.push(answer));
  bridge.setBattleMode('920bd91b', SARA_MOD);
  ws.receive({ id: ws.sent.at(-1).id, type: 'Error', payload: { type: 3, message: 'Not allowed' } });
  assert.deepEqual(answers.at(-1), { queueId: '920bd91b', mod: SARA_MOD, ok: false, message: 'Not allowed' });
  bridge.setBattleMode('920bd91b', SARA_MOD);
  ws.receive({ id: ws.sent.at(-1).id, type: 'remote.SetQueueItemOptionsResponse', payload: {} });
  assert.deepEqual(answers.at(-1), { queueId: '920bd91b', mod: SARA_MOD, ok: true, message: null });
  bridge.setBattleMode('920bd91b', SARA_MOD);
  t.mock.timers.tick(8000);
  assert.deepEqual(answers.at(-1), { queueId: '920bd91b', mod: SARA_MOD, ok: null, message: null });
  assert.equal(answers.length, 3);
  const settings = bridge.snapshot().songSettings;
  assert.equal(settings.support.queueItemOptions, 'unknown', 'les réglages de titre ne sont pas jugés sur la Battle');
  assert.deepEqual(settings.notices, {});
  assert.equal(bridge.lastError, null, 'le refus va à la Battle, pas à l’erreur générale');
});

test('Battle KCS : passage en mode Battle sans réponse puis reconnexion : une réponse de la nouvelle connexion ne va pas à la Battle', async t => {
  mockTime(t);
  const { bridge, ws, env } = await connected(t);
  t.after(() => bridge.disconnect());
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: { addToQueue: true, manageQueue: true,
    shownTypes: { battle: true } } } });
  const answers = [];
  bridge.on('battle-mode-answer', answer => answers.push(answer));
  bridge.setBattleMode('920bd91b', SARA_MOD);
  const staleId = ws.sent.at(-1).id;
  assert.equal(bridge._battleModes.size, 1);
  ws.receive({ type: 'remote.AppLeftEvent', payload: {} });
  t.mock.timers.tick(3000);
  const ws2 = env.sockets.at(-1);
  assert.notEqual(ws2, ws);
  ws2.open();
  assert.equal(bridge._battleModes.size, 0, 'identifiants propres à chaque connexion');
  // Réponse portant le même identifiant sur la nouvelle connexion : rien pour la Battle.
  ws2.receive({ id: staleId, type: 'Error', payload: { type: 3, message: 'Autre demande' } });
  assert.deepEqual(answers, []);
  // Une même voix listée deux fois : titre à une voix.
  assert.deepEqual(battleModFor([{ type: 5, caption: 'Indochine' }, { type: 5, caption: 'Indochine' }]), BATTLE_MOD);
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
// Ancien protocole socket.io (page de KaraFun sans adresse KCS) : cas d'erreur
// ---------------------------------------------------------------------------

// Depuis l'issue #59, le faux KaraFun local parle KCS : l'ancien protocole ne
// sert plus qu'à une page de télécommande sans `kcs_url`. Après un échec, le
// nouvel essai relit donc la page (5 s pour le premier, DISCOVERY_STEPS_MS).
const LEGACY_BASES = ['https://kf.exemple.invalid', 'https://kf2.exemple.invalid'];
async function legacy(t) {
  mockTime(t);
  ioSockets.length = 0;
  fakes(t, () => ok(page({ version: 2 })));
  const bridge = new KaraFunBridge({ bases: LEGACY_BASES });
  t.after(() => bridge.disconnect());
  bridge.connect(CODE);
  await flush();
  return bridge;
}
const nextTry = async t => { t.mock.timers.tick(5000); await flush(); };

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

test('ancien protocole : connexion, authentification et file reçue', async t => {
  const bridge = await legacy(t);
  const socket = ioSockets[0];
  assert.equal(socket.base, LEGACY_BASES[0]);
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

test('ancien protocole : échec de connexion, autre adresse et nouvel essai', async t => {
  const bridge = await legacy(t);
  ioSockets[0].fire('connect_error', new Error('xhr poll error'));
  assert.equal(bridge.lastError, `Connexion impossible à ${LEGACY_BASES[0]} : xhr poll error`);
  assert.equal(ioSockets[0].closed, true);
  await nextTry(t);
  assert.equal(ioSockets.length, 2);
  assert.equal(ioSockets[1].base, LEGACY_BASES[1]);
});

test('ancien protocole : déconnexion puis reconnexion après une nouvelle lecture de la page', async t => {
  const bridge = await legacy(t);
  ioSockets[0].fire('connect');
  ioSockets[0].fire('disconnect', 'transport close');
  assert.equal(bridge.connected, false);
  assert.ok(bridge.events.some(e => e.name === 'disconnect' && e.data === 'transport close'));
  await nextTry(t);
  assert.equal(ioSockets.length, 2);
  assert.equal(ioSockets[1].base, LEGACY_BASES[0], 'simple coupure : même adresse');
});

test('ancien protocole : code inconnu de KaraFun, message au bar', async t => {
  mockTime(t);
  fakes(t, () => ok(page({ version: 2 })));
  for (const name of ['serverUnreacheable', 'serverUnreachable']) {
    ioSockets.length = 0;
    const bridge = new KaraFunBridge({ bases: LEGACY_BASES });
    bridge.connect(CODE);
    await flush();
    ioSockets[0].fire(name);
    assert.equal(bridge.unreachable, true, name);
    assert.match(bridge.lastError, /vérifie que KaraFun est ouvert et que le code est le bon/);
    await nextTry(t);
    assert.equal(ioSockets.at(-1).base, LEGACY_BASES[1]);
    bridge.disconnect();
  }
});

test('ancien protocole : nom déjà pris, on redemande le même nom 4 s plus tard', async t => {
  const bridge = await legacy(t);
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

// ---------------------------------------------------------------------------
// Réglages de titre : tonalité, tempo, voix guide et chœurs
// ---------------------------------------------------------------------------
// Trames relevées sur le vrai KaraFun du bar (journal du 2 octobre).
const BAR_CONFIGURATION = { pitchStep: 1, tempoStep: 5, pitchMin: -6, tempoMin: -50, pitchMax: 6, tempoMax: 50,
  compatibleMods: { battle: [1] } };
const ADMIN_PERMISSIONS = { manageQueue: true, viewQueue: true, addToQueue: true, managePlayback: true, manageVolumes: true,
  sendPhotos: true, shownTypes: { karaoke: true, community: false, quiz: false, battle: true } };
const payloads = (ws, from = 0) => ws.sent.slice(from).map(({ type, payload }) => ({ type, payload }));

async function adminBridge(t) {
  const link = await connected(t);
  link.ws.receive({ type: 'remote.ConfigurationUpdateEvent', payload: { configuration: BAR_CONFIGURATION } });
  link.ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: ADMIN_PERMISSIONS } });
  return link;
}

test('KcsTransport : réponse rattachée à sa demande, identifiant rendu et donné à l’expiration', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  const replies = [], timeouts = [];
  transport.on('reply', (type, message) => replies.push([type, message.type]));
  transport.on('request-timeout', (type, id) => timeouts.push([type, id]));
  ws.open();
  const id = transport.send('remote.PitchRequest', { pitch: 1 });
  assert.equal(id, ws.sent.at(-1).id, 'send rend l’identifiant de la demande');
  assert.equal(transport.requestType(id), 'remote.PitchRequest');
  ws.receive({ id, type: 'remote.PitchResponse', payload: {} });
  assert.deepEqual(replies, [['remote.PitchRequest', 'remote.PitchResponse']]);
  assert.equal(transport.requestType(id), null, 'demande close');
  const late = transport.send('remote.TempoRequest', { tempo: 5 });
  ws.receive({ id: late, type: 'Error', payload: { type: 3, message: 'Refusé' } });
  assert.deepEqual(replies.at(-1), ['remote.TempoRequest', 'Error'], 'une Error avec le même identifiant répond à la demande');
  const silent = transport.send('remote.TrackVolumeRequest', { type: 5, volume: 0 });
  t.mock.timers.tick(8000);
  assert.deepEqual(timeouts, [['remote.TrackVolumeRequest', silent]]);
  ws.receive({ id: silent, type: 'remote.TrackVolumeResponse', payload: {} });
  assert.equal(replies.length, 2, 'réponse après l’expiration : ignorée');
  assert.equal(transport.requestType(undefined), null);
});

test('réglages de titre : requêtes KCS exactes pour l’ajout, la file et le titre en cours', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const sent = [];
  sent.push(bridge.add(5091, 'Léa · T1', 99999, { pitch: -2, tempo: -10, guide: 30, backing: 0 }));
  sent.push(bridge.add(77, 'Léa & Tom · T1', 99999, { guide: 50, guideVoices: { 6: 25, 7: 75 } }));
  sent.push(bridge.add(78, 'Zoé · T3', 99999, null));
  sent.push(bridge.setQueueItemOptions('11', { singer: 'Léa · T1', settings: { pitch: -2, tempo: -10, guide: 30 }, tracksAvailable: [4, 5] }));
  sent.push(bridge.setQueueItemOptions(12, { singer: 'Battle collective', mod: BATTLE_MOD, settings: null }));
  sent.push(bridge.setPitch(2), bridge.setTempo(5), bridge.setTrackVolume(5, 0), bridge.setTrackVolume(4, 100), bridge.setTrackVolume(7, 50));
  assert.deepEqual(payloads(ws), [
    { type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 5091 }, options: { singer: 'Léa · T1', pitch: -2, tempo: -10,
      tracks: [{ track: { type: 4 }, volume: 0 }, { track: { type: 5 }, volume: 30 }] }, position: 99999 } },
    { type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 77 }, options: { singer: 'Léa & Tom · T1',
      tracks: [{ track: { type: 5 }, volume: 50 }, { track: { type: 6 }, volume: 25 }, { track: { type: 7 }, volume: 75 }] }, position: 99999 } },
    { type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 78 }, options: { singer: 'Zoé · T3' }, position: 99999 } },
    { type: 'remote.SetQueueItemOptionsRequest', payload: { queueItemId: '11', options: { singer: 'Léa · T1', pitch: -2, tempo: -10,
      tracks: [{ track: { type: 5 }, volume: 30 }] } } },
    { type: 'remote.SetQueueItemOptionsRequest', payload: { queueItemId: '12', options: { singer: 'Battle collective', pitch: 0, tempo: 0,
      mod: BATTLE_MOD } } },
    { type: 'remote.PitchRequest', payload: { pitch: 2 } },
    { type: 'remote.TempoRequest', payload: { tempo: 5 } },
    { type: 'remote.TrackVolumeRequest', payload: { type: 5, volume: 0 } },
    { type: 'remote.TrackVolumeRequest', payload: { type: 4, volume: 100 } },
    { type: 'remote.TrackVolumeRequest', payload: { type: 7, volume: 50 } },
  ]);
  // Chaque voix guide posée par la file est notée (relecture PR #11, lot G2).
  assert.deepEqual(sent, [{ pitch: -2, tempo: -10, backing: 0, guide: 30 }, { guide: 50, guideVoices: { 6: 25, 7: 75 } }, null,
    { pitch: -2, tempo: -10, guide: 30 }, { pitch: 0, tempo: 0 }, 2, 5, 0, 100, 50], 'chaque méthode rend ce qui a été envoyé');
  assert.throws(() => bridge._emit('pause', null), /Commande KaraFun inconnue/, 'toujours aucune commande inconnue');
});

test('réglages de titre : bornés par la configuration de KaraFun avant l’envoi', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  assert.deepEqual(bridge.snapshot().songSettings.ranges, { pitch: { min: -6, max: 6, step: 1 },
    tempo: { min: -50, max: 50, step: 5 }, volume: { min: 0, max: 100, step: 25 } });
  assert.equal(bridge.setPitch(9), 6);
  assert.equal(bridge.setPitch(-8), -6);
  assert.equal(bridge.setTempo(12), 10, 'ramené sur le pas de 5');
  assert.equal(bridge.setTempo(-73), -50);
  assert.equal(bridge.setTrackVolume(6, 150), 100);
  assert.equal(bridge.setTrackVolume(4, -3), 0);
  assert.deepEqual(payloads(ws).map(m => m.payload), [{ pitch: 6 }, { pitch: -6 }, { tempo: 10 }, { tempo: -50 },
    { type: 6, volume: 100 }, { type: 4, volume: 0 }]);
  const before = ws.sent.length;
  assert.throws(() => bridge.setPitch('fort'), /Tonalité invalide/);
  assert.throws(() => bridge.setTempo(null), /Tempo invalide/);
  assert.throws(() => bridge.setTrackVolume(3, 10), /Piste vocale inconnue/);
  assert.throws(() => bridge.setTrackVolume(16, 10), /Piste vocale inconnue/, 'voix guides : types 5 à 15');
  assert.throws(() => bridge.setTrackVolume(5, 'x'), /Volume invalide/);
  assert.throws(() => bridge.setQueueItemOptions('', { singer: 'Léa' }), /Titre de la file KaraFun inconnu/);
  assert.equal(ws.sent.length, before, 'rien d’invalide n’est envoyé');
  // Autre configuration annoncée plus tard par KaraFun.
  ws.receive({ type: 'remote.ConfigurationUpdateEvent', payload: { configuration: { pitchMin: -3, pitchMax: 3, pitchStep: 1 } } });
  assert.equal(bridge.setPitch(5), 3);
  assert.equal(bridge.snapshot().songSettings.ranges.tempo.step, 5, 'tempo non annoncé : repli');
});

test('réglages de titre sans réponse en 8 s : avertissement, fonction gardée, la connexion reste', async t => {
  mockTime(t);
  const { bridge, ws, env } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  assert.deepEqual(bridge.snapshot().songSettings.support,
    { pitch: 'unknown', tempo: 'unknown', trackVolume: 'unknown', queueItemOptions: 'unknown', addOptions: 'unknown' });
  bridge.setPitch(1);
  bridge.setQueueItemOptions('11', { singer: 'Léa · T1', settings: { tempo: 5 } });
  t.mock.timers.tick(7000);
  ws.receive({ id: 90, type: 'core.PingRequest' });
  t.mock.timers.tick(1000);
  assert.equal(bridge.connected, true, 'aucune reconnexion');
  assert.equal(bridge.ready, true);
  assert.equal(ws.closeCalls, 0);
  assert.equal(bridge.lastError, null, 'l’état de la connexion reste propre');
  let state = bridge.snapshot().songSettings;
  // Un silence ne prouve pas un refus (client lent, confirmation par l'état seulement) : le bar peut réessayer.
  assert.equal(state.support.pitch, 'silent');
  assert.equal(state.support.queueItemOptions, 'silent');
  assert.equal(state.support.tempo, 'unknown');
  assert.deepEqual(state.notices, {
    pitch: 'KaraFun n’a pas répondu aux réglages de tonalité en 8 s : vérifie dans KaraFun ; un nouvel essai reste possible.',
    queueItemOptions: 'KaraFun n’a pas répondu aux réglages des titres de la file en 8 s : vérifie dans KaraFun ; un nouvel essai reste possible.' });
  assert.equal(state.notice, state.notices.queueItemOptions, 'dernier avis');
  assert.ok(bridge.events.some(e => e.name === 'sans-reponse' && e.data === 'remote.PitchRequest'));
  t.mock.timers.tick(5000);
  ws.receive({ id: 91, type: 'core.PingRequest' });
  t.mock.timers.tick(5000);
  assert.equal(env.calls.length, 1, 'pas de nouvelle découverte de la télécommande');
  // KaraFun applique sans répondre : son état montre la valeur envoyée, la fonction est confirmée.
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 4, pitch: 0, tempo: 0, tracks: [] } } });
  bridge.setPitch(2);
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 4, pitch: 2, tempo: 0, tracks: [] } } });
  state = bridge.snapshot().songSettings;
  assert.equal(state.support.pitch, 'ok');
  assert.equal(state.notices.pitch, undefined);
  bridge.setTrackVolume(5, 50);
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 4, pitch: 2, tempo: 0, tracks: [{ volume: 50, track: { type: 5 } }] } } });
  assert.equal(bridge.snapshot().songSettings.support.trackVolume, 'ok');
  // Une réponse plus tard confirme aussi.
  bridge.setTempo(5);
  ws.receive({ id: ws.sent.at(-1).id, type: 'remote.TempoResponse', payload: {} });
  assert.equal(bridge.snapshot().songSettings.support.tempo, 'ok');
  // Silence après une confirmation : la fonction reste confirmée, avec l'avis.
  bridge.setPitch(3);
  t.mock.timers.tick(8000);
  state = bridge.snapshot().songSettings;
  assert.equal(state.support.pitch, 'ok');
  assert.match(state.notices.pitch, /n’a pas répondu aux réglages de tonalité/);
  assert.equal(bridge.connected, true);
});

test('réglages de titre : chaque nouvelle connexion repart de capacités inconnues', async t => {
  mockTime(t);
  const { bridge, ws, env } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  bridge.setPitch(1);
  ws.receive({ id: ws.sent.at(-1).id, type: 'Error', payload: { type: 3, message: 'Not allowed' } });
  bridge.setTempo(5);
  t.mock.timers.tick(8000);
  assert.deepEqual(bridge.snapshot().songSettings.support,
    { pitch: 'refused', tempo: 'silent', trackVolume: 'unknown', queueItemOptions: 'unknown', addOptions: 'unknown' });
  // Coupure puis reconnexion automatique avec le même code (KaraFun a pu être mis à jour entre-temps).
  ws.serverClose(1006);
  t.mock.timers.tick(3000);
  await flush();
  // Reconnexion par l'URL KCS gardée en mémoire : pas de nouvelle lecture de
  // la page (limite horaire de KaraFun), mais bien une nouvelle connexion.
  assert.equal(env.calls.length, 1);
  const next = env.sockets.at(-1);
  assert.notEqual(next, ws);
  next.open();
  next.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  next.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1 } } });
  assert.equal(bridge.ready, true);
  const state = bridge.snapshot().songSettings;
  assert.deepEqual(state.support,
    { pitch: 'unknown', tempo: 'unknown', trackVolume: 'unknown', queueItemOptions: 'unknown', addOptions: 'unknown' });
  assert.deepEqual(state.notices, {});
  assert.equal(state.notice, null);
});

test('réglages de titre : un avis par fonction, le dernier refus n’efface pas les autres', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  bridge.setPitch(1);
  ws.receive({ id: ws.sent.at(-1).id, type: 'Error', payload: { type: 3, message: 'Not allowed' } });
  bridge.setQueueItemOptions('11', { singer: 'Léa · T1', settings: { tempo: 5 } });
  ws.receive({ id: ws.sent.at(-1).id, type: 'Error', payload: { type: 3, message: 'Not supported' } });
  let state = bridge.snapshot().songSettings;
  assert.deepEqual(state.notices, { pitch: 'KaraFun refuse de régler la tonalité : Not allowed',
    queueItemOptions: 'KaraFun refuse de régler un titre de la file : Not supported' });
  assert.equal(state.notice, 'KaraFun refuse de régler un titre de la file : Not supported');
  // La file accepte de nouveau : seul son avis disparaît.
  bridge.setQueueItemOptions('11', { singer: 'Léa · T1', settings: { tempo: 10 } });
  ws.receive({ id: ws.sent.at(-1).id, type: 'remote.SetQueueItemOptionsResponse', payload: {} });
  state = bridge.snapshot().songSettings;
  assert.deepEqual(state.notices, { pitch: 'KaraFun refuse de régler la tonalité : Not allowed' });
  assert.equal(state.notice, 'KaraFun refuse de régler la tonalité : Not allowed');
});

test('réglages de titre : capacité du canal exposée (télécommande KCS, faux KaraFun, ancienne télécommande)', async t => {
  mockTime(t);
  const idle = new KaraFunBridge({ bases: ['https://kf.exemple.invalid'] });
  assert.equal(idle.songSettingsState().available, null, 'pas encore connecté : inconnu');
  const { bridge } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  assert.equal(bridge.songSettingsState().available, true);
});

test('réglages de titre refusés par une Error du même identifiant : fonction notée refusée, rien d’autre', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  bridge.setTempo(5);
  ws.receive({ id: ws.sent.at(-1).id, type: 'Error', payload: { type: 3, message: 'Not allowed' } });
  let state = bridge.snapshot().songSettings;
  assert.equal(state.support.tempo, 'refused');
  assert.equal(state.notice, 'KaraFun refuse de régler le tempo : Not allowed');
  assert.equal(bridge.lastError, null, 'pas présenté comme une panne de la connexion');
  bridge.setTrackVolume(5, 25);
  ws.receive({ id: ws.sent.at(-1).id, type: 'Error', payload: {} });
  assert.equal(bridge.snapshot().songSettings.notice, 'KaraFun refuse de régler le volume des voix : erreur inconnue');
  bridge.setTempo(10);
  ws.receive({ id: ws.sent.at(-1).id, type: 'remote.TempoResponse', payload: {} });
  state = bridge.snapshot().songSettings;
  assert.equal(state.support.tempo, 'ok');
  assert.equal(state.support.trackVolume, 'refused');
  bridge.setTrackVolume(5, 50);
  ws.receive({ id: ws.sent.at(-1).id, type: 'remote.TrackVolumeResponse', payload: {} });
  assert.equal(bridge.snapshot().songSettings.notice, null, 'tout fonctionne de nouveau : plus d’avis');
  // Une Error sans identifiant reste une erreur de commande ordinaire.
  ws.receive({ type: 'Error', payload: { type: 3, message: 'Permission denied' } });
  assert.equal(bridge.lastError, 'Commande KaraFun refusée : Permission denied');
  // Nouveau code : nouvelle télécommande, capacités inconnues.
  bridge.connect('654321');
  assert.deepEqual(bridge.snapshot().songSettings.support,
    { pitch: 'unknown', tempo: 'unknown', trackVolume: 'unknown', queueItemOptions: 'unknown', addOptions: 'unknown' });
});

test('réglages de titre : droits de KaraFun exposés, vérifiés, jamais ajoutés à l’alerte de droits perdus', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  assert.deepEqual(bridge.snapshot().songSettings.permissions, { manageVolumes: true, manageQueue: true });
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: { ...ADMIN_PERMISSIONS, manageVolumes: false, manageQueue: false } } });
  assert.equal(bridge.permissionWarning, null, 'perte de ces droits : pas d’alerte de connexion');
  assert.deepEqual(bridge.snapshot().songSettings.permissions, { manageVolumes: false, manageQueue: false });
  const before = ws.sent.length;
  assert.throws(() => bridge.setPitch(1), /Personnaliser la chanson en cours/);
  assert.throws(() => bridge.setTempo(5), /Personnaliser la chanson en cours/);
  assert.throws(() => bridge.setTrackVolume(5, 25), /Personnaliser la chanson en cours/);
  assert.throws(() => bridge.setQueueItemOptions('11', { singer: 'Léa · T1' }), /Éditer la file d’attente/);
  assert.equal(ws.sent.length, before);
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: {} });
  assert.deepEqual(bridge.snapshot().songSettings.permissions, { manageVolumes: null, manageQueue: null }, 'droits non précisés');
});

test('réglages de titre : pistes vocales des titres de la file et état en direct du titre en cours', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [
    { id: '4f0c2a1e-02', song: { id: { type: 1, id: 37024 }, artist: 'Les Inconnus', songTracks: [{ type: 5 }], title: 'Isabelle a les yeux bleus',
      options: { singer: 'Hugo · Table 5' } } },
    { id: 'b2', song: { id: { type: 1, id: 5 }, title: 'Duo', songTracks: [{ type: 4 }, { type: 5 }, { type: 6 }],
      options: { singer: 'A & B · T1', pitch: -2, tempo: 5, tracks: [{ track: { type: 5 }, volume: 30 }] } } },
  ] } } });
  assert.deepEqual(bridge.queue.map(item => item.songTracks), [[5], [4, 5, 6]]);
  assert.deepEqual(bridge.queue[1].options, { singer: 'A & B · T1', pitch: -2, tempo: 5, tracks: [{ track: { type: 5 }, volume: 30 }] },
    'options du titre gardées telles que KaraFun les donne');
  assert.equal(bridge.snapshot().songSettings.live.pitch, null, 'rien en cours');
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { current: { id: '4f0c2a1e-0000-4000-8000-000000000001',
    song: { id: { type: 1, id: 12293 }, artist: 'Daniel Balavoine', songTracks: [{ type: 5 }], title: 'Le chanteur',
      options: { singer: 'Lina · Table 4' } } }, state: 4, pitch: 0, tempo: 0, tracks: [{ volume: 0, track: { type: 5 } }] } } });
  assert.deepEqual(bridge.status.current.songTracks, [5]);
  assert.deepEqual(bridge.snapshot().songSettings.live, { queueId: '4f0c2a1e-0000-4000-8000-000000000001', pitch: 0, tempo: 0,
    guide: 0, backing: null, voices: { 5: 0 }, tracks: [5] });
});

test('réglages de titre, ancien protocole d’un vrai KaraFun : refusés, ajout sans réglage', async t => {
  mockTime(t);
  ioSockets.length = 0;
  fakes(t, () => ok(page({ version: 2 })));
  const bridge = new KaraFunBridge({ bases: ['https://kf.exemple.invalid'] });
  t.after(() => bridge.disconnect());
  bridge.connect(CODE);
  await flush();
  const socket = ioSockets[0];
  socket.fire('connect');
  socket.receive('queue', []);
  socket.receive('status', { state: 'idle' });
  assert.equal(bridge.add(70002, 'Léa · T1', 99999, { pitch: -2 }), null);
  assert.deepEqual(socket.outgoing.at(-1), { name: 'queueAdd', args: [{ songId: 70002, pos: 99999, singer: 'Léa · T1' }] });
  assert.throws(() => bridge.setPitch(1), /ancienne télécommande KaraFun/);
  assert.throws(() => bridge.setQueueItemOptions(4, { singer: 'Léa' }), /ancienne télécommande KaraFun/);
  assert.equal(bridge.songSettingsState().available, false, 'les pages le disent au lieu d’échouer à l’appui');
});

test('réglages refusés à l’ajout par une Error du même identifiant : signalé, plus de réglages à l’ajout', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const refused = [];
  bridge.on('add-options-refused', add => refused.push(add));
  assert.deepEqual(bridge.add(5091, 'Léa · T1', 99999, { pitch: -2 }), { pitch: -2 });
  ws.receive({ id: ws.sent.at(-1).id, type: 'Error', payload: { type: 3, message: 'Invalid options' } });
  assert.deepEqual(refused, [{ songId: 5091, singer: 'Léa · T1' }], 'le serveur peut renvoyer ce titre sans réglages');
  const state = bridge.snapshot().songSettings;
  assert.equal(state.support.addOptions, 'refused');
  assert.equal(state.notice, 'KaraFun refuse de régler un titre à son ajout : Invalid options');
  assert.equal(bridge.lastError, null, 'pas présenté comme une panne de la connexion');
  assert.equal(bridge.add(5091, 'Léa · T1', 99999, { pitch: -2 }), null, 'réglages plus envoyés à l’ajout');
  assert.deepEqual(ws.sent.at(-1).payload.options, { singer: 'Léa · T1' });
  // Un ajout sans réglage refusé reste une erreur ordinaire.
  ws.receive({ id: ws.sent.at(-1).id, type: 'Error', payload: { type: 3, message: 'Queue is full' } });
  assert.equal(bridge.lastError, 'Commande KaraFun refusée : Queue is full');
  assert.equal(refused.length, 1);
});

test('réglages acceptés à l’ajout : fonction confirmée, un ajout sans réglage ne compte pas', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  bridge.add(78, 'Zoé · T3', 99999);
  ws.receive({ id: ws.sent.at(-1).id, type: 'remote.AddToQueueResponse', payload: {} });
  assert.equal(bridge.snapshot().songSettings.support.addOptions, 'unknown');
  bridge.add(5091, 'Léa · T1', 99999, { tempo: 10 });
  ws.receive({ id: ws.sent.at(-1).id, type: 'remote.AddToQueueResponse', payload: {} });
  assert.equal(bridge.snapshot().songSettings.support.addOptions, 'ok');
});

test('réglages de titre : valeurs par défaut des voix relevées sur le KaraFun du bar (chœurs à 53)', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  assert.deepEqual(bridge.snapshot().songSettings.defaults, { pitch: 0, tempo: 0, guide: 0, backing: 100 }, 'rien relevé : repli');
  const status = (id, state, tracks, options = { singer: 'Lina · Table 4' }) => ws.receive({ type: 'remote.StatusEvent', payload: {
    status: { current: { id, song: { id: { type: 1, id: 12458 }, title: 'T', songTracks: tracks.map(row => ({ type: row.track.type })),
      options } }, state, pitch: 0, tempo: 0, tracks } } });
  // Trames du 2 octobre : titre chargé sans options de voix.
  status('a', 2, [{ volume: 53, track: { type: 4 } }, { volume: 0, track: { type: 5 } }]);
  assert.deepEqual(bridge.snapshot().songSettings.defaults, { pitch: 0, tempo: 0, guide: 0, backing: 53 });
  // Le bar change les chœurs pendant ce titre : ce n'est pas une valeur par défaut.
  status('a', 4, [{ volume: 80, track: { type: 4 } }, { volume: 0, track: { type: 5 } }]);
  // Titre envoyé avec ses propres volumes : pas relevé non plus.
  status('b', 2, [{ volume: 25, track: { type: 4 } }, { volume: 50, track: { type: 5 } }],
    { singer: 'Léa', tracks: [{ track: { type: 4 }, volume: 25 }, { track: { type: 5 }, volume: 50 }] });
  assert.deepEqual(bridge.snapshot().songSettings.defaults, { pitch: 0, tempo: 0, guide: 0, backing: 53 });
  // KaraFun « collant » : le titre suivant, sans options, garde les voix d'avant. Ni relevées, ni la voix guide.
  status('c', 3, [{ volume: 25, track: { type: 4 } }, { volume: 50, track: { type: 5 } }]);
  assert.deepEqual(bridge.snapshot().songSettings.defaults, { pitch: 0, tempo: 0, guide: 0, backing: 53 });
  // Remise par défaut d'un titre de la file : la valeur du KaraFun du bar.
  bridge.setQueueItemOptions('11', { singer: 'Léa · T1', settings: null, sent: { backing: 0 }, tracksAvailable: [4, 5] });
  assert.deepEqual(ws.sent.at(-1).payload.options.tracks, [{ track: { type: 4 }, volume: 53 }]);
  // Nouveau code : nouvelle installation, valeurs à relever.
  bridge.connect('654321');
  assert.equal(bridge.snapshot().songSettings.defaults.backing, 100);
});

test('réglages de titre : défauts relevés quand KaraFun a chargé le titre, pas sur l’état 1 qui l’annonce', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const status = (id, state, tracks) => ws.receive({ type: 'remote.StatusEvent', payload: {
    status: { current: { id, song: { id: { type: 1, id: 12458 }, title: 'DJ', songTracks: [{ type: 4 }, { type: 5 }],
      options: { singer: 'Soraya · Table princess' } } }, state, pitch: 0, tempo: 0, tracks } } });
  // Séquence réelle du 2 octobre (« DJ ») : état 1 sans pistes, puis état 2 avec les chœurs à 53.
  status('dj', 1, []);
  assert.equal(bridge.snapshot().songSettings.defaults.backing, 100, 'rien à relever sur l’état 1');
  status('dj', 2, [{ volume: 53, track: { type: 4 } }, { volume: 0, track: { type: 5 } }]);
  assert.deepEqual(bridge.snapshot().songSettings.defaults, { pitch: 0, tempo: 0, guide: 0, backing: 53 });
  // Fin d'un titre : l'état 1 du suivant porte déjà des pistes, pas forcément les siennes.
  status('next', 1, [{ volume: 80, track: { type: 4 } }, { volume: 0, track: { type: 5 } }]);
  assert.equal(bridge.snapshot().songSettings.defaults.backing, 53, 'état 1 : pas encore chargé');
  status('next', 3, [{ volume: 60, track: { type: 4 } }, { volume: 0, track: { type: 5 } }]);
  assert.equal(bridge.snapshot().songSettings.defaults.backing, 60, 'relevé sur le titre chargé');
  // Voix guide jamais relevée : coupée par défaut, même si un titre démarre avec.
  status('guide', 3, [{ volume: 60, track: { type: 4 } }, { volume: 25, track: { type: 5 } }]);
  assert.deepEqual(bridge.snapshot().songSettings.defaults, { pitch: 0, tempo: 0, guide: 0, backing: 60 });
  // Chœurs changés par la file en direct : plus relevés ensuite (un KaraFun peut les garder).
  bridge.setTrackVolume(4, 0);
  status('after', 3, [{ volume: 0, track: { type: 4 } }, { volume: 0, track: { type: 5 } }]);
  assert.equal(bridge.snapshot().songSettings.defaults.backing, 60);
});

// Regression: relecture finale R3 — un premier titre chargé avec un volume de
// chœurs dans ses options verrouillait le relevé : la valeur par défaut du
// bar (53) n'était jamais apprise de toute la soirée, et les chœurs n'étaient
// plus remis entre deux titres (titre isolé, lot G). Le verrou ne vaut
// qu'une fois une valeur par défaut relevée.
test('réglages de titre : chœurs par défaut relevés même si le premier titre portait ses propres chœurs', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const status = (id, state, backing, options = { singer: 'Lina · Table 4' }) => ws.receive({ type: 'remote.StatusEvent', payload: {
    status: { current: { id, song: { id: { type: 1, id: 12458 }, title: 'T', songTracks: [{ type: 4 }, { type: 5 }], options } },
      state, pitch: 0, tempo: 0, tracks: [{ volume: backing, track: { type: 4 } }, { volume: 0, track: { type: 5 } }] } } });
  // Titre 1 : envoyé avec chœurs à 75.
  status('t1', 3, 75, { singer: 'Léa', tracks: [{ track: { type: 4 }, volume: 75 }] });
  assert.equal(bridge.snapshot().songSettings.defaults.backing, 100, 'pas relevé sur un titre qui règle ses chœurs');
  // Titres 2 à 4 sans options : le KaraFun du bar les met à 53.
  for (const id of ['t2', 't3', 't4']) status(id, 3, 53);
  assert.equal(bridge.snapshot().songSettings.defaults.backing, 53);
  assert.equal(bridge.observedDefaults.backing, 53, 'les chœurs seront remis à 53 entre deux titres');
  // Une fois relevée, la valeur ne change plus après un réglage des chœurs.
  bridge.setTrackVolume(4, 0);
  status('t5', 3, 0);
  assert.equal(bridge.snapshot().songSettings.defaults.backing, 53);
});

// Regression: vérification de la relecture R3 — KaraFun « collant » : le
// premier titre (options chœurs 75, ou 0) garde ses chœurs au titre suivant
// sans options. La valeur gardée était apprise comme valeur par défaut du
// bar, puis imposée à tous les titres suivants. Rien n'est relevé tant que
// les chœurs du titre suivant sont ceux laissés par le précédent.
const backingStatus = ws => (id, state, backing, options = { singer: 'Zoé' }) => ws.receive({ type: 'remote.StatusEvent', payload: {
  status: { current: { id, song: { id: { type: 1, id: 12458 }, title: 'T', songTracks: [{ type: 4 }, { type: 5 }], options } },
    state, pitch: 0, tempo: 0, tracks: state === 1 ? [] : [{ volume: backing, track: { type: 4 } }, { volume: 0, track: { type: 5 } }] } } });
for (const kept of [75, 0]) {
  test(`réglages de titre : KaraFun collant, les chœurs gardés du titre précédent (${kept}) ne deviennent pas la valeur par défaut`, async t => {
    mockTime(t);
    const { bridge, ws } = await adminBridge(t);
    t.after(() => bridge.disconnect());
    const status = backingStatus(ws);
    status('t1', 3, kept, { singer: 'Léa', tracks: [{ track: { type: 4 }, volume: kept }] });
    for (const id of ['t2', 't3']) {
      status(id, 2, kept);
      status(id, 3, kept);
    }
    assert.equal(bridge.observedDefaults.backing, undefined, `chœurs ${kept} gardés par KaraFun : pas une valeur par défaut`);
    assert.equal(bridge.snapshot().songSettings.defaults.backing, 100);
    // Le bar règle les chœurs en direct sur t3 : t4 les garde, toujours rien.
    status('t3', 4, 80);
    status('t4', 3, 80);
    assert.equal(bridge.observedDefaults.backing, undefined);
    // Un titre que KaraFun remet de lui-même à une autre valeur la donne.
    status('t5', 3, 53);
    assert.equal(bridge.observedDefaults.backing, 53);
    // Vérification de la deuxième relecture R2(b) : une nouvelle remise par
    // KaraFun à une autre valeur la remplace (valeur changée dans KaraFun).
    status('t6', 3, 0);
    assert.equal(bridge.observedDefaults.backing, 0, 'remise par KaraFun à 0 : nouvelle valeur');
  });
}

// Regression: vérification de la relecture (redémarrage) — application
// relancée en pleine chanson : le premier état vu est un titre déjà en
// lecture, chœurs réglés en direct (80). Ce réglage était appris comme
// valeur par défaut. Un titre vu pour la première fois déjà en lecture ne
// donne pas de valeur par défaut ; le suivant, vu se charger, la donne.
for (const state of [4, 5]) {
  test(`réglages de titre : un titre vu pour la première fois déjà en lecture (état ${state}) ne donne pas les chœurs par défaut`, async t => {
    mockTime(t);
    const { bridge, ws } = await adminBridge(t);
    t.after(() => bridge.disconnect());
    const status = backingStatus(ws);
    status('x', state, 80);
    status('x', 4, 80);
    assert.equal(bridge.observedDefaults.backing, undefined, 'réglage en direct, pas une valeur par défaut');
    assert.equal(bridge.seenLoading('x'), false);
    status('y', 1, 0);
    status('y', 2, 53);
    status('y', 3, 53);
    assert.equal(bridge.observedDefaults.backing, 53);
  });
}
test('réglages de titre : titre annoncé (état 1) puis vu directement en lecture : vu se charger', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const status = backingStatus(ws);
  status('z', 1, 0);
  status('z', 4, 53);
  assert.equal(bridge.observedDefaults.backing, 53);
  assert.equal(bridge.seenLoading('z'), true);
  assert.equal(bridge.seenLoading('inconnu'), false);
});
test('réglages de titre : titre vu pour la première fois en lecture avec ses propres chœurs : le titre suivant qui les garde ne les donne pas', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const status = backingStatus(ws);
  status('x', 4, 0, { singer: 'Léa', tracks: [{ track: { type: 4 }, volume: 0 }] });
  status('y', 2, 0);
  status('y', 3, 0);
  assert.equal(bridge.observedDefaults.backing, undefined, 'chœurs de Léa gardés par KaraFun');
});

// Regression: relecture de l'étape 1 Socket.IO (issue #59) — le KaraFun des
// essais réels du 6 novembre 2026 renvoie les options d'un titre ajouté sans
// volumes avec une liste de pistes vide, `{ tracks: [], singer }`, dans la
// file comme dans l'état. Celui des soirées de septembre n'envoyait que
// `{ singer }`. Le relevé s'arrêtait sur toute liste, même vide : les chœurs
// par défaut du bar n'étaient jamais appris, donc jamais remis entre deux
// titres. Une liste vide ne règle rien ; une liste qui règle les chœurs
// bloque toujours le relevé.
test('réglages de titre : options du KaraFun de novembre 2026 (`tracks: []`) : chœurs par défaut relevés', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const status = backingStatus(ws);
  const november = singer => ({ tracks: [], singer });
  // Séquence du 6 novembre : annoncé (état 1, sans pistes), chargé (2), prêt (3).
  status('n1', 1, 0, november('Zoé'));
  status('n1', 2, 53, november('Zoé'));
  status('n1', 3, 53, november('Zoé'));
  assert.deepEqual([bridge.observedDefaults.backing, bridge.provisionalDefaults], [53, true], 'pont neuf : relevée, provisoire');
  assert.equal(bridge.snapshot().songSettings.defaults.backing, 53);
  // Titre suivant remis par KaraFun à une autre valeur au chargement : confirmée.
  status('n2', 1, 0, november('Tom'));
  status('n2', 2, 60, november('Tom'));
  assert.deepEqual([bridge.observedDefaults.backing, bridge.provisionalDefaults], [60, false], 'remise par KaraFun');
  // Un titre qui règle ses chœurs dans ses options ne donne toujours rien.
  const own = { tracks: [{ track: { type: 4 }, volume: 75 }], singer: 'Léa' };
  status('n3', 1, 0, own);
  status('n3', 3, 75, own);
  assert.equal(bridge.observedDefaults.backing, 60, 'chœurs réglés par le titre : pas une valeur par défaut');
  // Un titre vu pour la première fois en pleine chanson, avec la liste vide :
  // ses chœurs ne sont pas relevés non plus.
  status('n4', 4, 20, november('Ana'));
  assert.equal(bridge.observedDefaults.backing, 60, 'réglage en direct, pas une valeur par défaut');
});

// Regression: deuxième relecture finale R3 — nouveau code KaraFun (autre
// installation) : les titres vus se charger avec l'ancien code étaient
// gardés. Un identifiant de file repris par le nouveau KaraFun, vu pour la
// première fois en pleine chanson, passait pour vu se charger.
test('réglages de titre : un nouveau code oublie les titres vus se charger et les chœurs observés', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const status = backingStatus(ws);
  status('q1', 1, 0);
  status('q1', 3, 53);
  assert.equal(bridge.seenLoading('q1'), true);
  assert.equal(bridge._observedBacking, 53);
  bridge.connect('654321');
  assert.equal(bridge.seenLoading('q1'), false, 'autre installation : titre jamais vu se charger');
  assert.equal(bridge._observedBacking, null);
  assert.equal(bridge._lastBacking, null);
});
// Regression: contre-relecture RT4 — titres vus se charger gardés d'une
// session KCS à l'autre avec le même code : KaraFun relancé (AppLeftEvent)
// renumérote sa file depuis 1, et le titre 1 de la nouvelle session, vu pour
// la première fois en pleine chanson, passait pour vu se charger (remis aux
// valeurs neutres en pleine chanson). Toute session perdue ou reprise
// oublie ces titres et les chœurs observés, pas les chœurs par défaut relevés.
for (const how of ['AppLeftEvent', 'coupure', 'Reconnecter']) {
  test(`réglages de titre : ${how} puis nouvelle session (numéros repris depuis 1), titres vus se charger oubliés`, async t => {
    mockTime(t);
    const { bridge, ws, env } = await adminBridge(t);
    t.after(() => bridge.disconnect());
    const status = backingStatus(ws);
    status('1', 1, 0);
    status('1', 3, 53);
    status('1', 4, 53);
    assert.equal(bridge.seenLoading('1'), true);
    assert.equal(bridge.observedDefaults.backing, 53);
    const session = bridge.kcsSession;
    if (how === 'AppLeftEvent') ws.receive({ type: 'remote.AppLeftEvent', payload: {} });
    else if (how === 'coupure') ws.serverClose(1006);
    else { bridge.disconnect(); bridge.connect(CODE); }
    assert.equal(bridge.seenLoading('1'), false, 'session perdue : titre 1 jamais vu se charger');
    assert.equal(bridge._observedFor, null);
    assert.equal(bridge._observedBacking, null);
    assert.equal(bridge._lastBacking, null);
    assert.ok(bridge.kcsSession > session, 'nouvelle session signalée au serveur');
    t.mock.timers.tick(3000);
    await flush();
    const ws2 = env.sockets.at(-1);
    assert.notEqual(ws2, ws, 'nouvelle connexion');
    ws2.open();
    ws2.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
    // KaraFun relancé en pleine chanson : titre 1 (un autre) déjà en lecture, chœurs réglés en direct.
    const status2 = backingStatus(ws2);
    status2('1', 4, 80);
    assert.equal(bridge.ready, true);
    assert.equal(bridge.seenLoading('1'), false, 'titre 1 vu pour la première fois en lecture');
    assert.equal(bridge.observedDefaults.backing, 53, 'chœurs par défaut relevés gardés');
    assert.equal(bridge.statusSession, bridge.kcsSession, 'état reçu dans la nouvelle session');
    status2('2', 1, 0);
    status2('2', 3, 53);
    assert.equal(bridge.seenLoading('2'), true);
    assert.equal(bridge.observedDefaults.backing, 53);
  });
}
// Regression: vérification de la contre-relecture RT4 — une coupure (même
// KaraFun, même file) pendant que le titre suivant est seulement annoncé
// (état 1), après un titre vu pour la première fois en pleine chanson avec
// des chœurs réglés en direct (80) qu'un KaraFun collant garde : la session
// oubliée remettait la chaîne à « propre », et 80 était relevé comme chœurs
// par défaut définitifs (sauvegardés pour les soirées suivantes). Après une
// session perdue où un titre a été vu, la chaîne est inconnue : le titre
// suivant ne donne qu'une valeur provisoire, jusqu'à une remise par KaraFun.
for (const when of ['état 1', 'état 3']) {
  test(`réglages de titre : coupure pendant l’${when} du titre suivant, chœurs gardés d’un titre vu en pleine chanson : provisoires`, async t => {
    mockTime(t);
    const { bridge, ws, env } = await adminBridge(t);
    t.after(() => bridge.disconnect());
    const status = backingStatus(ws);
    status('A', 4, 80); // vu pour la première fois en lecture, chœurs 80 réglés en direct
    if (when === 'état 1') status('B', 1, 0);
    else { status('B', 1, 0); status('B', 2, 80); status('B', 3, 80); }
    const provisional = bridge.provisionalDefaults, learned = bridge.observedDefaults.backing ?? null;
    ws.serverClose(1006);
    t.mock.timers.tick(3000);
    await flush();
    const ws2 = env.sockets.at(-1);
    ws2.open();
    ws2.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
    const status2 = backingStatus(ws2);
    if (when === 'état 1') status2('B', 1, 0);
    status2('B', 2, 80); // KaraFun collant : 80 gardé de A
    status2('B', 3, 80);
    status2('B', 4, 80);
    assert.equal(bridge.observedDefaults.backing, 80);
    assert.equal(bridge.provisionalDefaults, true, 'chœurs d’un réglage en direct jamais définitifs');
    if (when === 'état 3') assert.deepEqual([learned, provisional], [80, true]);
    // KaraFun remet ses chœurs au titre suivant : valeur définitive.
    status2('C', 1, 0);
    status2('C', 2, 53);
    assert.equal(bridge.observedDefaults.backing, 53);
    assert.equal(bridge.provisionalDefaults, false);
  });
}
// Sans titre vu avant la coupure (ni chœurs envoyés), la reprise est un
// démarrage : l'histoire de KaraFun reste inconnue (troisième relecture
// finale R4), le premier titre vu se charger donne une valeur provisoire.
test('réglages de titre : coupure avant tout titre vu, premier titre vu se charger relevé à titre provisoire comme au démarrage', async t => {
  mockTime(t);
  const { bridge, ws, env } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  ws.serverClose(1006);
  t.mock.timers.tick(3000);
  await flush();
  const ws2 = env.sockets.at(-1);
  ws2.open();
  ws2.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  const status2 = backingStatus(ws2);
  status2('A', 1, 0);
  status2('A', 3, 53);
  assert.equal(bridge.observedDefaults.backing, 53);
  assert.equal(bridge.provisionalDefaults, true);
});
// Regression: troisième relecture finale R4(i) — application relancée entre
// deux titres, avant toute valeur sauvegardée : le pont neuf ne connaît pas
// l'histoire de KaraFun, et les chœurs 80 réglés en direct sur le dernier
// titre, gardés par un KaraFun collant, étaient relevés au chargement du
// suivant comme chœurs par défaut définitifs (sauvegardés pour toujours).
// Un pont neuf part d'une histoire inconnue : la valeur reste provisoire
// jusqu'à une remise par KaraFun au chargement d'un titre vu après un autre.
// Vérification de la troisième relecture finale R4(i) : connect() passe par
// la branche « nouveau code » (forgetDefaults) et cachait l'état laissé par le
// constructeur ; le pont neuf est ici ouvert sur KCS sans connect(), comme
// celui de l'application relancée par les tests du serveur.
test('réglages de titre : pont neuf, KaraFun collant qui garde des chœurs réglés en direct : valeur provisoire, puis définitive à une remise', async t => {
  mockTime(t);
  const env = fakes(t);
  const bridge = new KaraFunBridge();
  t.after(() => bridge.disconnect());
  bridge._openKcs(KCS_URL, () => true);
  const ws = env.sockets.at(-1);
  ws.open();
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  ws.receive({ type: 'remote.ConfigurationUpdateEvent', payload: { configuration: BAR_CONFIGURATION } });
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: ADMIN_PERMISSIONS } });
  const status = backingStatus(ws);
  for (const id of ['B', 'C']) { status(id, 1, 0); status(id, 2, 80); status(id, 3, 80); status(id, 4, 80); }
  assert.equal(bridge.observedDefaults.backing, 80, 'relevée pour la soirée');
  assert.equal(bridge.provisionalDefaults, true, 'jamais définitive : peut venir d’un réglage en direct');
  // KaraFun remet ses chœurs au chargement du titre suivant : définitive.
  status('D', 1, 0);
  status('D', 2, 53);
  assert.equal(bridge.observedDefaults.backing, 53);
  assert.equal(bridge.provisionalDefaults, false);
});

// Regression: troisième relecture finale R4(ii) — nouveau code KaraFun alors
// que le même KaraFun continue (chœurs réglés en direct à 80 sur le titre en
// cours) : la branche « nouveau code » remettait la chaîne à « connue » juste
// après que la déconnexion l'avait marquée inconnue, et 80 gardé au titre
// suivant devenait la valeur par défaut définitive.
// Regression: relecture finale, quatrième passe (K1) — 80 restait relevé à
// titre provisoire (sauvegardé, imposé aux titres suivants) : les chœurs
// laissés par un titre vu avant le nouveau code ne sont plus relevés du tout,
// seule une remise par KaraFun au chargement donne la valeur.
test('réglages de titre : nouveau code, même KaraFun avec des chœurs réglés en direct : chœurs gardés jamais relevés, remise relevée', async t => {
  mockTime(t);
  const { bridge, ws, env } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const status = backingStatus(ws);
  status('A', 1, 0);
  status('A', 3, 53);
  status('A', 4, 80); // réglage en direct
  bridge.connect('654321');
  await flush();
  const ws2 = env.sockets.at(-1);
  assert.notEqual(ws2, ws, 'nouvelle connexion');
  ws2.open();
  ws2.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  ws2.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: ADMIN_PERMISSIONS } });
  const status2 = backingStatus(ws2);
  status2('B', 1, 0);
  status2('B', 2, 80);
  status2('B', 3, 80);
  assert.equal(bridge.observedDefaults.backing, undefined, 'réglage en direct gardé par KaraFun : jamais relevé');
  assert.equal(bridge.provisionalDefaults, false);
  // KaraFun remet ses chœurs au chargement du titre suivant : valeur confirmée.
  status2('C', 1, 0);
  status2('C', 2, 53);
  assert.equal(bridge.observedDefaults.backing, 53);
  assert.equal(bridge.provisionalDefaults, false);
});

// Relecture finale, quatrième passe (K2) : une session perdue après un titre
// vu rend la chaîne des chœurs inconnue même avec une valeur confirmée. Des
// chœurs réglés à 80 dans KaraFun pendant la coupure, gardés par le titre
// suivant vu se charger dans la nouvelle session, ne la remplacent pas.
test('réglages de titre : valeur confirmée, coupure, chœurs gardés au titre suivant de la nouvelle session : jamais relevés', async t => {
  mockTime(t);
  const { bridge, ws, env } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const status = backingStatus(ws);
  status('A', 1, 0);
  status('A', 2, 80);
  status('A', 3, 80);
  status('B', 1, 0);
  status('B', 2, 53); // KaraFun remet ses chœurs au chargement : confirmée
  status('B', 4, 53);
  assert.deepEqual([bridge.observedDefaults.backing, bridge.provisionalDefaults], [53, false]);
  ws.serverClose(1006);
  t.mock.timers.tick(3000);
  await flush();
  const ws2 = env.sockets.at(-1);
  assert.notEqual(ws2, ws, 'nouvelle connexion');
  ws2.open();
  ws2.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  const status2 = backingStatus(ws2);
  status2('C', 1, 0);
  status2('C', 2, 80);
  status2('C', 3, 80);
  assert.equal(bridge.observedDefaults.backing, 53, 'chœurs gardés d’avant la coupure : jamais relevés');
  assert.equal(bridge.provisionalDefaults, false);
});

// Regression: vérification de la quatrième passe (K1) — chœurs réglés en
// direct, puis session KCS perdue avant le nouveau code ou « Nouvelle
// soirée » (l'ancien code cesse de marcher le premier, coupure) :
// forgetDefaults, sans titre vu dans la session, tenait les chœurs pour
// inchangés, et 80, gardé au titre suivant par un KaraFun collant, était
// relevé (provisoire, sauvegardé, imposé ensuite).
for (const how of ['nouveau code', 'nouvelle soirée']) {
  test(`réglages de titre : chœurs réglés en direct, session KCS perdue, puis ${how} : chœurs gardés jamais relevés`, async t => {
    mockTime(t);
    const { bridge, ws, env } = await adminBridge(t);
    t.after(() => bridge.disconnect());
    const status = backingStatus(ws);
    status('A', 1, 0);
    status('A', 3, 53);
    status('A', 4, 80); // réglage en direct
    assert.deepEqual([bridge.observedDefaults.backing, bridge.provisionalDefaults], [53, true]);
    ws.serverClose(1006);
    await flush();
    if (how === 'nouveau code') bridge.connect('654321');
    else t.mock.timers.tick(3000);
    await flush();
    const ws2 = env.sockets.at(-1);
    assert.notEqual(ws2, ws, 'nouvelle connexion');
    ws2.open();
    ws2.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
    ws2.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: ADMIN_PERMISSIONS } });
    if (how === 'nouvelle soirée') bridge.forgetDefaults({ keepConfirmed: true }); // KaraFun entre deux titres
    const status2 = backingStatus(ws2);
    status2('B', 1, 0);
    status2('B', 2, 80);
    status2('B', 3, 80);
    assert.equal(bridge.observedDefaults.backing, undefined, 'réglage en direct gardé par KaraFun : jamais relevé');
    assert.equal(bridge.provisionalDefaults, false);
  });
}

// Regression: vérification de la quatrième passe (K1) — « Nouvelle soirée »
// (ou un nouveau code) avec un titre vu dont les chœurs n'ont jamais changé
// tenait les chœurs pour changés : la valeur provisoire oubliée n'était plus
// jamais relevée chez un KaraFun collant (pages à 100, chœurs coupés par un
// titre jamais ramenés). Une valeur reprise de la sauvegarde ne compte pas
// non plus pour des chœurs changés.
for (const start of ['pont neuf', 'valeur provisoire reprise']) {
  test(`réglages de titre : ${start}, chœurs jamais changés, « Nouvelle soirée » avec un titre sur scène : valeur relevée de nouveau`, async t => {
    mockTime(t);
    const { bridge, ws } = await adminBridge(t);
    t.after(() => bridge.disconnect());
    if (start !== 'pont neuf') assert.equal(bridge.restoreDefaults({ backing: 53, provisional: true }), true);
    const status = backingStatus(ws);
    for (const id of ['B', 'C']) { status(id, 1, 0); status(id, 2, 53); status(id, 3, 53); status(id, 4, 53); }
    assert.deepEqual([bridge.observedDefaults.backing, bridge.provisionalDefaults], [53, true]);
    bridge.forgetDefaults({ keepConfirmed: true });
    assert.equal(bridge.observedDefaults.backing, undefined, 'valeur provisoire oubliée');
    status('D', 1, 0);
    status('D', 2, 53);
    assert.deepEqual([bridge.observedDefaults.backing, bridge.provisionalDefaults], [53, true], 'relevée de nouveau, provisoire');
    assert.equal(bridge.snapshot().songSettings.defaults.backing, 53);
  });
}

// Garde de la même vérification : un titre vu à d'autres chœurs que la valeur
// connue sans remise de KaraFun au chargement (réglés pendant une coupure, en
// pleine chanson pendant la coupure, ou avant un redémarrage de
// l'application) porte des chœurs changés, même oublié avec sa session : après
// « Nouvelle soirée », ceux qu'un KaraFun collant en garde au titre suivant ne
// sont pas relevés.
for (const how of ['coupure', 'coupure en pleine chanson', 'redémarrage', 'coupure, puis seconde coupure']) {
  test(`réglages de titre : titre vu à d’autres chœurs que la valeur connue (${how}), « Nouvelle soirée » : jamais relevés`, async t => {
    mockTime(t);
    const { bridge, ws, env } = await adminBridge(t);
    t.after(() => bridge.disconnect());
    // Coupure de la télécommande, puis nouvelle session KCS (relance après 3 s, puis 6 s ± 15 %).
    const drop = async (from, wait) => {
      from.serverClose(1006);
      t.mock.timers.tick(wait);
      await flush();
      const next = env.sockets.at(-1);
      assert.notEqual(next, from, 'nouvelle connexion');
      next.open();
      next.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
      return next;
    };
    let link = ws;
    if (how === 'redémarrage') assert.equal(bridge.restoreDefaults({ backing: 53, provisional: true }), true);
    else {
      const status = backingStatus(ws);
      status('A', 1, 0);
      status('A', 3, 53);
      status('A', 4, 53);
      link = await drop(ws, 3000);
    }
    assert.deepEqual([bridge.observedDefaults.backing, bridge.provisionalDefaults], [53, true]);
    let status = backingStatus(link);
    // Réglé à 80 pendant la coupure (ou avant le redémarrage) : B le garde.
    if (how === 'coupure en pleine chanson') status('B', 4, 80);
    else { status('B', 1, 0); status('B', 2, 80); status('B', 3, 80); }
    assert.equal(bridge.observedDefaults.backing, 53, 'valeur connue gardée');
    if (how.endsWith('seconde coupure')) status = backingStatus(await drop(link, 7000)); // B oublié avec sa session
    bridge.forgetDefaults({ keepConfirmed: true });
    status('C', 1, 0);
    status('C', 2, 80);
    status('C', 3, 80);
    assert.equal(bridge.observedDefaults.backing, undefined, 'chœurs gardés de B : jamais relevés');
  });
}

// Regression: deuxième relecture finale R2 — KaraFun « collant », application
// relancée en pleine chanson : les chœurs du titre vu pour la première fois
// en lecture (réglés en direct) restaient au titre suivant, qui les donnait
// comme valeur par défaut, gardée dans la sauvegarde.
// Regression: vérification de la deuxième relecture R2(c) — l'application
// n'apprenait alors plus rien, même d'un KaraFun qui remet à zéro dont les
// chœurs du titre en cours étaient déjà à la valeur par défaut (53) : les
// téléphones gardaient 100. Les deux cas se ressemblent trame pour trame :
// la valeur du titre suivant est relevée pour la soirée mais reste
// provisoire (sauvegardée comme telle) tant qu'une remise par KaraFun au
// chargement (autre valeur que celle du titre d'avant) ne l'a pas confirmée.
for (const sticky of [true, false]) {
  test(`réglages de titre : relancé en pleine chanson, chœurs du titre suivant relevés à titre provisoire (KaraFun ${sticky ? 'collant' : 'qui remet à zéro'})`, async t => {
    mockTime(t);
    const { bridge, ws } = await adminBridge(t);
    t.after(() => bridge.disconnect());
    const status = backingStatus(ws);
    const kept = sticky ? 70 : 53;
    status('x', 4, kept);
    status('x', 5, kept);
    for (const id of ['y', 'z']) {
      status(id, 1, 0);
      status(id, 2, kept);
      status(id, 3, kept);
      status(id, 4, kept);
    }
    assert.equal(bridge.observedDefaults.backing, kept, 'relevée pour la soirée');
    assert.equal(bridge.provisionalDefaults, true, 'provisoire : peut venir du titre en cours au redémarrage');
    assert.equal(bridge.snapshot().songSettings.defaults.backing, kept);
    // Chœurs réglés en direct sur z, puis w se charge.
    status('z', 4, 90);
    status('w', 1, 0);
    status('w', 2, sticky ? 90 : 53);
    assert.equal(bridge.observedDefaults.backing, sticky ? 70 : 53);
    assert.equal(bridge.provisionalDefaults, sticky, sticky ? 'KaraFun garde : rien de confirmé' : 'remise par KaraFun : confirmée');
  });
}
test('réglages de titre : relancé en pleine chanson avec une valeur par défaut connue, rien de provisoire', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  assert.equal(bridge.restoreDefaults({ backing: 53 }), true);
  const status = backingStatus(ws);
  status('x', 4, 0);
  for (const id of ['y', 'z']) { status(id, 1, 0); status(id, 2, 0); status(id, 4, 0); }
  assert.equal(bridge.observedDefaults.backing, 53, 'chœurs 0 gardés par KaraFun, jamais appris');
  assert.equal(bridge.provisionalDefaults, false);
});

// Valeur relevée gardée dans la sauvegarde : reprise après un redémarrage,
// jamais réapprise de chœurs gardés par KaraFun.
test('réglages de titre : valeur par défaut des chœurs reprise après un redémarrage, pas réapprise', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  assert.equal(bridge.restoreDefaults({ backing: 53 }), true);
  assert.equal(bridge.snapshot().songSettings.defaults.backing, 53);
  const status = backingStatus(ws);
  // Redémarrage entre deux titres : le suivant, vu se charger, garde les chœurs 80 réglés avant.
  status('y', 1, 0);
  status('y', 3, 80);
  status('z', 3, 80);
  assert.equal(bridge.observedDefaults.backing, 53, 'reprise, pas réapprise');
  assert.equal(bridge.provisionalDefaults, false);
  // Valeurs abîmées : rien n'est repris.
  const other = new KaraFunBridge();
  for (const bad of [null, {}, { backing: -1 }, { backing: 101 }, { backing: 52.5 }, { backing: '53' }]) {
    assert.equal(other.restoreDefaults(bad), false);
  }
  assert.equal(other.observedDefaults.backing, undefined);
});

// Regression: vérification de la troisième relecture finale R4 — valeur
// provisoire sauvegardée (KaraFun collant, jamais remis au chargement) :
// reprise comme provisoire, jamais remplacée par une valeur provisoire
// relevée après le redémarrage, remplacée par une remise de KaraFun (alors
// définitive) ; sans effet sur une valeur déjà confirmée.
test('réglages de titre : valeur provisoire sauvegardée reprise comme provisoire, confirmée par une remise de KaraFun', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  assert.equal(bridge.restoreDefaults({ backing: 53, provisional: true }), true);
  assert.equal(bridge.observedDefaults.backing, 53);
  assert.equal(bridge.provisionalDefaults, true);
  const status = backingStatus(ws);
  for (const id of ['y', 'z']) { status(id, 1, 0); status(id, 2, 80); status(id, 3, 80); status(id, 4, 80); }
  assert.equal(bridge.observedDefaults.backing, 53, 'chœurs 80 gardés par KaraFun : jamais relevés à la place');
  assert.equal(bridge.provisionalDefaults, true);
  status('w', 1, 0);
  status('w', 2, 60);
  assert.equal(bridge.observedDefaults.backing, 60, 'remise par KaraFun au chargement');
  assert.equal(bridge.provisionalDefaults, false);
  assert.equal(bridge.restoreDefaults({ backing: 53, provisional: true }), false, 'valeur confirmée gardée');
  assert.equal(bridge.restoreDefaults({ backing: 53 }), true);
  assert.deepEqual([bridge.observedDefaults.backing, bridge.provisionalDefaults], [60, false]);
});

// Regression: vérification de la deuxième relecture R2(b) — valeur par défaut
// des chœurs reprise de la sauvegarde (53) alors que le bar l'a changée dans
// KaraFun (70) : elle n'était plus jamais réapprise, et chaque titre était
// ramené à 53. Une remise par KaraFun au chargement (titre vu se charger à
// une autre valeur que celle laissée par le titre d'avant) la remplace.
test('réglages de titre : valeur par défaut reprise remplacée par une remise de KaraFun à une autre valeur', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  assert.equal(bridge.restoreDefaults({ backing: 53 }), true);
  const status = backingStatus(ws);
  status('a', 1, 0);
  status('a', 2, 70);
  status('a', 3, 70);
  assert.equal(bridge.observedDefaults.backing, 53, 'un titre chargé à 70 ne dit pas encore si KaraFun garde');
  // La file ramène a à 53 (valeur neutre), b se charge de nouveau à 70.
  bridge.setTrackVolume(4, 53);
  status('a', 4, 53);
  status('b', 1, 0);
  status('b', 2, 70);
  assert.equal(bridge.observedDefaults.backing, 70, 'KaraFun remet 70 au chargement : nouvelle valeur par défaut');
  assert.equal(bridge.provisionalDefaults, false);
  assert.equal(bridge.snapshot().songSettings.defaults.backing, 70);
});

// ---------------------------------------------------------------------------
// Valeurs imprévues de KaraFun
// ---------------------------------------------------------------------------

// Regression: suite de la relecture de l'étape 1 Socket.IO (issue #59) — une
// seule valeur d'un type imprévu dans une trame KCS (un titre null, un numéro
// objet…) levait une exception dans le pont, que Node relançait hors de toute
// portée : le serveur du bar s'arrêtait (sonde du 11 novembre 2026 : 11 cas
// sur 16 avec le vrai WebSocket de Node). Chaque valeur est lue avec son
// type : une valeur secondaire imprévue compte pour absente et le reste du
// message sert, sans « message-ignore » ; un titre illisible (pas un objet,
// numéro absent, vide, ou qui n'est ni un texte ni un nombre) fait ignorer
// tout le message, la file garde ce qu'elle savait, et la page du bar
// l'affiche en alerte.
// `piege()` : un objet JSON qu'on ne peut convertir ni en texte ni en nombre
// (sa clé toString n'est pas une fonction).
const piege = () => JSON.parse('{"toString":1}');
const kcsItem = (over = {}, song = {}) => ({ id: 'q-1', song: { id: { type: 1, id: 35369 }, title: 'Titre', artist: 'Artiste',
  songTracks: [{ type: 4 }, { type: 5 }], options: { tracks: [], singer: 'Zoé' }, ...song }, ...over });
const ignoredMessages = bridge => bridge.events.filter(e => e.name === 'message-ignore').map(e => e.data);

// Regression: relecture de cette correction — un titre illisible était
// laissé de côté : la file croyait ensuite qu'il avait été retiré de KaraFun
// (passage rendu, titre plus suivi, et un second passage possible). Toute la
// file reçue est ignorée, et la file garde ce qu'elle savait. Regression:
// tours 2 et 3 de la relecture — rien ne le montrait au bar, et « J'ai vérifié
// la file KaraFun : reprendre » renvoyait alors un titre déjà dans KaraFun :
// une alerte rouge reste affichée jusqu'à la prochaine file lisible, et la
// vérification d'un envoi interrompu est refusée (queueUnreadable). Le pont
// reste prêt : les états lisibles suivent toujours la scène. Regression:
// relecture 2, tour 3 — un titre sans numéro (absent, null) ou au numéro
// vide passait encore : numéroté « undefined », « null » ou vide, tous ces
// titres avaient le même numéro, et la file prenait le premier d'entre eux
// pour celui que KaraFun jouait. Dans les journaux réels (septembre à
// novembre 2026), les 391 titres de file et les 556 titres en cours ont tous
// un numéro en texte non vide.
test('valeurs imprévues : file de KaraFun lue avec ses types ; un titre illisible fait ignorer toute la file reçue', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const queue = items => ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items } } });
  queue([kcsItem({ id: 'q-0' }), kcsItem({ id: 'q-1' })]);
  const announced = [];
  bridge.on('queue', items => announced.push(items));
  const valid = kcsItem({ id: 'q-2' });
  // Titre qui n'est pas un objet, ou dont le numéro est absent, null, vide,
  // un objet, une liste ou un booléen.
  const bads = [null, 'texte', kcsItem({ id: piege() }), kcsItem({ id: [1] }), kcsItem({ id: undefined }), kcsItem({ id: null }),
    kcsItem({ id: '' }), kcsItem({ id: true })];
  for (const bad of bads) assert.doesNotThrow(() => queue([valid, bad]));
  assert.deepEqual(bridge.queue.map(item => item.queueId), ['q-0', 'q-1'], 'file d’avant gardée telle quelle');
  assert.deepEqual(announced, [], 'aucune file annoncée au serveur');
  assert.deepEqual(ignoredMessages(bridge).map(entry => entry.reason), Array(bads.length).fill('titre illisible dans la file'));
  assert.match(bridge.lastError, /message de KaraFun illisible \(remote\.QueueEvent\)/);
  assert.deepEqual([bridge.ready, bridge.queueUnreadable], [true, true], 'toujours prêt, file de KaraFun illisible');
  const alerted = bridge.connectionState();
  assert.equal(alerted.level, 'error', 'bandeau rouge sur la page du bar');
  assert.equal(alerted.alert, 'Message de KaraFun illisible (remote.QueueEvent) : la file ne voit plus ces changements de KaraFun ' +
    'et ne lui envoie plus rien d’elle-même ; Spotify, s’il est relié, n’est plus coupé ni relancé d’office. Pilote dans ' +
    'KaraFun en attendant, ou clique sur « Reconnecter » pour qu’il les renvoie.');
  // Relecture gstack-review de la branche finale (design) : la pastille de l'état KaraFun ne
  // garde que le titre de l'alerte ; la phrase entière y faisait grandir la barre du haut.
  assert.equal(alerted.label, 'Message de KaraFun illisible (remote.QueueEvent)');
  assert.deepEqual([alerted.canRename, alerted.nameConflict, alerted.canReconnect], [false, null, true],
    'alerte à part, avec « Reconnecter »');
  // Un état lisible ne lève pas l'alerte de la file.
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1, current: null } } });
  assert.equal(bridge.queueUnreadable, true);
  assert.match(bridge.connectionState().alert, /remote\.QueueEvent/);
  assert.equal(normalizeKcsItem(null), null);
  // Valeurs secondaires d'un type imprévu : ignorées, le reste du titre sert.
  const odd = kcsItem({ id: 'q-3' }, { id: { type: 1, id: piege() }, title: piege(), artist: piege(),
    songTracks: [{ type: piege() }, { type: 4 }, { type: '5' }],
    options: { singer: piege(), tracks: [], mod: { id: piege(), caption: 'Battle', data: { battle: { subtype: 1 } } } } });
  const items = [odd, kcsItem({ id: 'q-4' }, { options: 'texte' }), valid];
  assert.doesNotThrow(() => ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items } } }));
  assert.deepEqual(bridge.queue.map(item => item.queueId), ['q-3', 'q-4', 'q-2']);
  const [read, plain, kept] = bridge.queue;
  assert.deepEqual([read.songId, read.title, read.artist, read.singer, read.songTracks], [undefined, '', '', '', [4, 5]]);
  assert.equal(isBattleItem(read), false, 'mode Battle sans numéro lisible : pas une Battle');
  assert.deepEqual(plain.options, {}, 'options d’un autre type : aucune');
  assert.deepEqual(kept, normalizeKcsItem(valid));
  assert.equal(ignoredMessages(bridge).length, bads.length, 'lues avec leur type, sans le filet');
  assert.equal(bridge.lastError, null, 'une file lisible efface l’avis');
  assert.equal(bridge.queueUnreadable, false);
  assert.deepEqual([bridge.connectionState().level, bridge.connectionState().alert, bridge.connectionState().canReconnect],
    ['ok', null, false], 'alerte levée');
});

// Regression: tour 3 de la relecture — une file sans liste de titres, ou un
// état dont le numéro n'est pas un nombre, étaient jetés en silence : le pont
// restait sur l'état d'avant sans rien dire au bar. Regression: relecture 2 —
// un message sans file ou sans état (charge vide ou d'un autre type) l'était
// encore : une clé renommée par une mise à jour de KaraFun aurait figé la
// file sans alerte. Les 1 380 messages de file et d'état des journaux réels
// (septembre et novembre 2026) ont tous la leur.
test('valeurs imprévues : file ou état mal formés ou absents ignorés comme un titre illisible, alerte comprise', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [kcsItem({ id: 'q-0' })] } } });
  for (const queue of [{ items: { 0: kcsItem() } }, null, 'texte']) ws.receive({ type: 'remote.QueueEvent', payload: { queue } });
  for (const payload of [{}, null, 'texte']) ws.receive({ type: 'remote.QueueEvent', payload });
  for (const status of [{ state: '4', current: kcsItem() }, null, 'texte']) ws.receive({ type: 'remote.StatusEvent', payload: { status } });
  for (const payload of [{}, null]) ws.receive({ type: 'remote.StatusEvent', payload });
  assert.deepEqual(ignoredMessages(bridge).map(entry => entry.reason), [...Array(6).fill('file illisible'), ...Array(5).fill('état illisible')]);
  assert.deepEqual(bridge.queue.map(item => item.queueId), ['q-0']);
  assert.equal(bridge.status.kcsState, 1, 'état d’avant gardé');
  assert.equal(bridge.queueUnreadable, true);
  assert.match(bridge.connectionState().alert, /illisible/);
});

// Regression: relecture 2 — 26 niveaux dans les options d'un seul titre (un
// client de la télécommande peut en envoyer, KaraFun renvoie les options)
// faisaient ignorer toute la file : celle que voyait le serveur restait figée
// tant que ce titre était dans KaraFun. Le surplus est coupé, noté dans le
// journal de KaraFun, et la file se lit.
test('valeurs imprévues : options d’un titre trop imbriquées coupées, la file se lit sans alerte', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const deep = levels => (levels ? { a: deep(levels - 1) } : 1);
  const options = { tracks: [], singer: 'Zoé', extra: deep(30) };
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [kcsItem({ id: 'q-1' }, { options })] } } });
  assert.deepEqual(bridge.queue.map(item => [item.queueId, item.singer]), [['q-1', 'Zoé']]);
  assert.deepEqual([bridge.queueUnreadable, bridge.unreadable, bridge.connectionState().alert], [false, null, null]);
  assert.deepEqual(ignoredMessages(bridge), []);
  assert.deepEqual(bridge.events.filter(e => e.name === 'message-coupe').map(e => e.data), [{ type: 'remote.QueueEvent' }]);
});

// L'alerte d'un message illisible ne vaut que connecté : KaraFun perdu, c'est
// l'alerte de relance (avec « Reconnecter ») qui s'affiche. Et seuls la file
// et l'état comptent : un autre message ignoré (réponse à un ajout) ne rend
// ni l'une ni l'autre illisibles, et la reprise d'un envoi reste possible.
test('valeurs imprévues : alerte d’un message illisible seulement connecté, et pour la file ou l’état seulement', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  for (const type of ['remote.AddToQueueResponse', 'remote.SetQueueItemOptionsResponse', 'remote.QueueItemEvent']) {
    bridge._ignoredMessage(type, 'réponse illisible');
  }
  assert.deepEqual([bridge.queueUnreadable, bridge.unreadable, bridge.connectionState().alert], [false, null, null]);
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [null] } } });
  assert.equal(bridge.unreadable, 'remote.QueueEvent');
  assert.match(bridge.connectionState().alert, /illisible/);
  ws.serverClose(1006);
  const lost = bridge.connectionState();
  assert.equal(lost.phase, 'retry');
  assert.doesNotMatch(lost.label, /illisible/);
  assert.equal(lost.alert, null, 'KaraFun perdu : l’alerte générale, avec « Reconnecter »');
});

// Tour 3 de la relecture — une file illisible dès la connexion (titre déjà
// dans KaraFun quand la file se reconnecte) s'affiche aussi, et une nouvelle
// connexion l'oublie, comme un état illisible (relecture 2). Regression:
// relecture 2, tour 2 (équipe rouge) — l'alerte n'avait pas de sortie quand
// KaraFun est à l'arrêt : il ne renvoie rien de lui-même, et « Reconnecter »
// gardait la connexion. Pendant l'alerte, « Reconnecter » la rouvre : KaraFun
// renvoie sa file et son état, l'alerte repart de zéro. Sans alerte, une
// connexion qui marche reste gardée (la couper créerait un conflit de nom).
test('valeurs imprévues : file illisible dès la connexion, file et état illisibles oubliés à la reconnexion ; « Reconnecter » rouvre la connexion pendant l’alerte', async t => {
  mockTime(t);
  const { bridge, ws, env } = await connected(t, { ready: false });
  t.after(() => bridge.disconnect());
  const named = socket => {
    socket.receive({ type: 'core.AuthenticatedEvent', payload: {} });
    socket.receive({ type: 'remote.UsernameUpdateEvent', payload: { username: bridge.username } });
  };
  named(ws);
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [kcsItem({ id: piege() })] } } });
  assert.deepEqual([bridge.connectionState().phase, bridge.connectionState().level], ['waiting-data', 'error']);
  // Relecture gstack-review de la branche finale, passe 2 (design) : dès la connexion,
  // « Reconnecter » ne sert à rien tant que KaraFun renvoie ce titre ; l'alerte donne le remède.
  assert.match(bridge.connectionState().alert, /Un titre de KaraFun est sans doute en cause : retire-le dans KaraFun, ou attends qu’il soit passé\./);
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1, current: null } } });
  assert.equal(bridge.ready, true);
  assert.equal(bridge.connect(CODE), 'kept', 'sans alerte : connexion gardée');
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [null] } } });
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 3, current: 'texte' } } });
  const fetches = env.calls.length;
  assert.equal(bridge.connect(CODE), 'started', 'alerte : connexion rouverte');
  assert.equal(ws.closeCalls, 1);
  await flush();
  assert.equal(env.calls.length, fetches, 'adresse gardée : la page de KaraFun n’est pas relue');
  const again = env.sockets.at(-1);
  assert.notEqual(again, ws);
  again.open();
  named(again);
  assert.deepEqual([bridge.queueUnreadable, bridge.unreadable, bridge.connectionState().level, bridge.connectionState().alert],
    [false, null, 'wait', null], 'nouvelle connexion : file et état illisibles oubliés');
  again.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  again.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1, current: null } } });
  assert.deepEqual([bridge.ready, bridge.connectionState().level, bridge.connectionState().alert], [true, 'ok', null]);
  assert.equal(bridge.connect(CODE), 'kept');
});

// Regression: relecture de cette correction — un titre en cours illisible
// devenait « aucun titre en cours » alors que KaraFun jouait : analyzeState
// prenait alors le premier titre de la file pour celui sur scène. Tout l'état
// reçu est ignoré, et la file garde ce qu'elle savait.
test('valeurs imprévues : état de KaraFun lu avec ses types ; un titre en cours illisible fait ignorer tout l’état reçu', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const tracks = [{ track: { type: piege() }, volume: 53 }, null, { track: { type: 4 }, volume: 53 }, { track: { type: 5 }, volume: piege() }];
  const status = (current, extra = {}) => ({ type: 'remote.StatusEvent', payload: { status: { state: 3, pitch: 0, tempo: 0, tracks, current, ...extra } } });
  // Seul null veut dire « aucun titre en cours » : 0, false ou un texte vide
  // sont illisibles, comme un titre sans numéro lisible.
  const currents = [kcsItem({ id: piege() }), 'texte', 0, false, '', kcsItem({ id: undefined }), kcsItem({ id: null }),
    kcsItem({ id: '' }), kcsItem({ id: true })];
  for (const current of currents) assert.doesNotThrow(() => ws.receive(status(current)));
  assert.deepEqual([bridge.status.kcsState, bridge.status.current], [1, null], 'état d’avant gardé');
  assert.deepEqual(ignoredMessages(bridge).map(entry => entry.reason), Array(currents.length).fill('titre en cours illisible'));
  assert.equal(bridge.ready, true, 'toujours prêt');
  assert.match(bridge.connectionState().alert, /illisible \(remote\.StatusEvent\)/);
  // Une file lisible ne lève pas l'alerte de l'état.
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  assert.match(bridge.connectionState().alert, /remote\.StatusEvent/);
  assert.equal(bridge.queueUnreadable, false, 'la file, elle, est lisible');
  // Piste, volume, tonalité et options d'un type imprévu : ignorés, le reste sert.
  const own = { singer: 'Zoé', tracks: [{ track: { type: piege() }, volume: 50 }] };
  assert.doesNotThrow(() => ws.receive(status(kcsItem({}, { options: own }), { pitch: piege() })));
  assert.equal(bridge.status.current.queueId, 'q-1');
  assert.deepEqual(bridge.snapshot().songSettings.live,
    { queueId: 'q-1', pitch: null, tempo: 0, guide: null, backing: 53, voices: {}, tracks: [4, 5] });
  assert.equal(bridge.seenLoading('q-1'), true);
  assert.equal(ignoredMessages(bridge).length, currents.length, 'lu avec ses types, sans le filet');
  assert.equal(bridge.lastError, null);
  assert.equal(bridge.connectionState().alert, null, 'un état lisible lève l’alerte');
});

// Regression: relecture de cette correction — un champ `songPlaying` (le nom
// du titre en cours dans l'ancien protocole ; KaraFun ne l'envoie pas en KCS,
// journaux de septembre et de novembre 2026) restait tel quel dans l'état, et
// analyzeState le lit avant le titre en cours lu avec ses types.
test('valeurs imprévues : un champ songPlaying de l’état KCS n’est jamais gardé', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [kcsItem()] } } });
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 4, pitch: 0, tempo: 0, tracks: [], current: kcsItem(),
    songPlaying: { songId: piege(), queueId: [7], title: ['x'] } } } });
  assert.equal(bridge.status.songPlaying, undefined);
  assert.equal(analyzeState(bridge.queue, bridge.status).current.queueId, 'q-1', 'le titre en cours lu avec ses types');
});

test('valeurs imprévues : refus de KaraFun dont la raison est d’un type imprévu', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  assert.doesNotThrow(() => ws.receive({ type: 'Error', payload: { type: 1, message: piege() } }));
  assert.equal(bridge.lastError, 'Commande KaraFun refusée : 1');
  assert.doesNotThrow(() => ws.receive({ type: 'Error', payload: { type: 4, message: piege() } }));
  assert.equal(bridge.nameConflictSince, null, 'raison illisible : pas un conflit de nom');
  // Réglage de titre refusé, mode Battle refusé : raison illisible, « erreur inconnue ».
  bridge.setPitch(2);
  const pitch = ws.sent.at(-1);
  assert.equal(pitch.type, 'remote.PitchRequest');
  assert.doesNotThrow(() => ws.receive({ id: pitch.id, type: 'Error', payload: { type: 1, message: piege() } }));
  assert.equal(bridge.settingsNotices.pitch, 'KaraFun refuse de régler la tonalité : erreur inconnue');
  const answers = [];
  bridge.on('battle-mode-answer', answer => answers.push(answer));
  bridge.setBattleMode('q-1', BATTLE_MOD);
  const mode = ws.sent.at(-1);
  assert.doesNotThrow(() => ws.receive({ id: mode.id, type: 'Error', payload: { type: piege(), message: piege() } }));
  assert.deepEqual(answers.map(answer => [answer.ok, answer.message]), [[false, 'erreur inconnue']]);
  assert.deepEqual(ignoredMessages(bridge), []);
});

// Regression: relecture 2, tour 2 (passe adverse) — la raison d'un refus de
// KaraFun passait entière au bar : une raison de 400 ko (des espaces sans fin)
// figeait le serveur deux minutes dans la consigne de la Battle (server.js,
// failPlainBattleCopy, dont le nettoyage coûte le carré de la longueur). Elle
// est bornée à 200 caractères, comme les raisons du journal.
test('valeurs imprévues : raison d’un refus de KaraFun bornée, pour le bar comme pour la Battle', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const long = `Refus${' '.repeat(400000)}fin`;
  ws.receive({ type: 'Error', payload: { type: 1, message: long } });
  assert.equal(bridge.lastError, `Commande KaraFun refusée : ${long.slice(0, 200)}`);
  bridge.setPitch(2);
  ws.receive({ id: ws.sent.at(-1).id, type: 'Error', payload: { type: 1, message: long } });
  assert.equal(bridge.settingsNotices.pitch, `KaraFun refuse de régler la tonalité : ${long.slice(0, 200)}`);
  const answers = [];
  bridge.on('battle-mode-answer', answer => answers.push(answer));
  bridge.setBattleMode('q-1', BATTLE_MOD);
  ws.receive({ id: ws.sent.at(-1).id, type: 'Error', payload: { type: 3, message: long } });
  assert.deepEqual(answers.map(answer => answer.message), [long.slice(0, 200)]);
  // Nom déjà pris : reconnu sur toute la raison, même longue.
  ws.receive({ type: 'Error', payload: { type: 4, message: `${' '.repeat(300)}Username is already used` } });
  assert.notEqual(bridge.nameConflictSince, null);
});

// Filet du pont : un message que le pont ne peut pas lire jusqu'au bout est
// ignoré, noté dans le journal de KaraFun (chaque fois) et dans celui du
// serveur (une ligne par minute au plus) ; la connexion continue.
test('filet du pont : un message qui fait échouer le pont est ignoré, noté au journal, la connexion continue', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const lines = [];
  bridge.log = line => lines.push(line);
  let fail = true;
  bridge.on('queue', () => { if (fail) throw new TypeError('Cannot convert object to primitive value'); });
  const queue = { type: 'remote.QueueEvent', payload: { queue: { items: [kcsItem()] } } };
  assert.doesNotThrow(() => ws.receive(queue));
  assert.deepEqual(ignoredMessages(bridge), [{ type: 'remote.QueueEvent', reason: 'Cannot convert object to primitive value' }]);
  assert.deepEqual(lines, ['KaraFun : message remote.QueueEvent ignoré (Cannot convert object to primitive value) ; la connexion continue.']);
  assert.match(bridge.lastError, /message de KaraFun illisible \(remote\.QueueEvent\)/, 'avis sur la page du bar');
  assert.match(bridge.connectionState().alert, /remote\.QueueEvent/, 'file peut-être à moitié lue : alerte jusqu’à la suivante');
  ws.receive(queue);
  assert.equal(ignoredMessages(bridge).length, 2);
  assert.equal(lines.length, 1, 'une ligne par minute au plus dans le journal du serveur');
  // Une minute plus tard, KaraFun parlant toujours (un Ping toutes les 5 s).
  for (let i = 1; i <= 12; i++) {
    t.mock.timers.tick(5000);
    ws.receive({ id: i, type: 'core.PingRequest', payload: {} });
  }
  ws.receive(queue);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /3 messages ignorés depuis le démarrage/);
  // Message trop imbriqué (mode Battle sur 100 000 niveaux) : coupé à 32
  // niveaux, puis lu ; une file lisible efface l'avis.
  fail = false;
  const battle = { singer: 'Zoé', mod: { id: 1, caption: 'Battle', data: { battle: { subtype: 1 } }, x: 'IMBRIQUE' } };
  const deep = JSON.stringify({ type: 'remote.QueueEvent', payload: { queue: { items: [kcsItem({ id: 'q-9' }, { options: battle })] } } })
    .replace('"IMBRIQUE"', '{"a":'.repeat(100000) + '1' + '}'.repeat(100000));
  assert.doesNotThrow(() => ws.receive(deep));
  assert.equal(ignoredMessages(bridge).length, 3, 'rien d’ignoré de plus');
  assert.deepEqual(bridge.queue.map(item => [item.queueId, isBattleItem(item)]), [['q-9', true]], 'mode Battle lu, son surplus coupé');
  assert.equal(bridge.lastError, null);
  assert.doesNotThrow(() => JSON.stringify(bridge.snapshot()), 'la page du bar reste lisible');
  // La connexion sert toujours.
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [kcsItem({ id: 'q-5' })] } } });
  assert.deepEqual(bridge.queue.map(item => item.queueId), ['q-5']);
  assert.equal(bridge.lastError, null);
  assert.equal(bridge.ready, true);
  assert.equal(ws.closeCalls, 0);
});

// Regression: relecture de cette correction — le nom d'un message ignoré,
// choisi par KaraFun, était recopié tel quel dans le journal du serveur : un
// retour à la ligne y fabriquait une fausse ligne, et un nom très long
// remplissait le journal.
test('filet du pont : le nom d’un message ignoré est nettoyé dans le journal du serveur et sur la page du bar', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  const lines = [];
  bridge.log = line => lines.push(line);
  const type = `remote.QueueEvent\nFAUSSE LIGNE ${'x'.repeat(500)}`;
  // Le transport signale le message ignoré sous le nom choisi par KaraFun.
  bridge.socket.emit('message-error', type, 'Cannot convert object to primitive value');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^KaraFun : message remote\.QueueEvent\?FAUSSE\?LIGNE\?x+ ignoré \(Cannot convert object to primitive value\)/);
  assert.ok(lines[0].length < 200, 'nom raccourci');
  assert.doesNotMatch(bridge.lastError, /\n/);
  // Coupé au-delà de 32 niveaux, il est noté nettoyé de même.
  ws.receive(`{"type":${JSON.stringify(type)},"payload":${'{"a":'.repeat(40) + '1' + '}'.repeat(40)}}`);
  assert.match(bridge.events.filter(e => e.name === 'message-coupe').at(-1).data.type, /^remote\.QueueEvent\?FAUSSE\?LIGNE\?x+$/);
  assert.equal(bridge.events.filter(e => e.name === 'message-coupe').at(-1).data.type.length, 64);
});

// Relecture, cycle 3 — case « état illisible × connexion perdue », le pendant
// pour l'état de KaraFun de l'essai sur la file illisible plus haut. Un
// StatusEvent illisible (titre en cours qui n'est pas un objet) met la page du
// bar en alerte rouge, avec son propre « Reconnecter » : la connexion marche,
// seul KaraFun lève l'alerte. Si la connexion se ferme ensuite, la relance est
// déjà prévue : la page doit montrer l'alerte générale de KaraFun perdu (phase
// « retry », niveau « error », avec le « Reconnecter » de la page), pas
// l'alerte d'état, cachée (la nouvelle connexion l'oublie). Sinon le bar
// lirait que la file « ne voit plus ces changements » et qu'il faut cliquer
// sur « Reconnecter », alors qu'elle n'est plus reliée du tout et qu'un
// nouvel essai est déjà prévu.
test('valeurs imprévues : état illisible puis connexion fermée, l’alerte d’état cède la place à l’alerte générale de reconnexion', async t => {
  mockTime(t);
  const { bridge, ws } = await adminBridge(t);
  t.after(() => bridge.disconnect());
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 4, current: 'texte' } } });
  assert.deepEqual([bridge.ready, bridge.queueUnreadable, bridge.unreadable], [true, false, 'remote.StatusEvent'],
    'toujours prêt, état de KaraFun illisible, la file lisible');
  const alerted = bridge.connectionState();
  assert.deepEqual([alerted.phase, alerted.level, alerted.label, alerted.canReconnect],
    ['ready', 'error', 'Message de KaraFun illisible (remote.StatusEvent)', true], 'alerte d’état, avec son « Reconnecter »');
  assert.match(alerted.alert, /^Message de KaraFun illisible \(remote\.StatusEvent\) : la file ne voit plus ces changements/);
  ws.serverClose(1006);
  const lost = bridge.connectionState();
  assert.equal(lost.phase, 'retry');
  assert.equal(lost.alert, null, 'alerte d’état cachée : KaraFun perdu');
  assert.equal(lost.canReconnect, false, 'plus le « Reconnecter » de l’alerte d’état');
  assert.equal(lost.level, 'error', 'alerte générale de KaraFun perdu, avec le « Reconnecter » de la page');
  assert.match(lost.label, /^KaraFun a fermé la connexion \(code 1006\) : nouvel essai dans 3 s$/);
  assert.equal(lost.retryAt, Date.now() + 3000, 'nouvel essai déjà prévu');
  assert.match(bridge.lastError, /^Télécommande KaraFun déconnectée \(code 1006\)/, 'l’avis du message ignoré est remplacé');
});

// Regression: PR #64, CodeQL (js/remote-property-injection) — la coupe au-delà de 32 niveaux
// écrivait null sous un nom de propriété venu de KaraFun, dans le message déjà construit. Elle se
// fait maintenant dans le texte, avant JSON.parse (cutDeep). Une trame de deux millions de
// niveaux (4 Mo) n'est donc plus construite : elle épuisait la mémoire du serveur, ce qu'aucun
// filet ne rattrape. Essai dans un processus à 96 Mo de mémoire, comme la trame large plus haut.
test('KcsTransport : une trame de deux millions de niveaux est coupée sans épuiser la mémoire du serveur', () => {
  const child = `class WS { static OPEN = 1; constructor() { this.readyState = 1; this.listeners = {}; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } send() {} close() {} }
    globalThis.WebSocket = WS;
    const { KcsTransport } = require(${JSON.stringify(path.join(__dirname, '..', 'kcs-transport.js'))});
    const transport = new KcsTransport('wss://kcs.exemple.invalid/');
    let read = 0, cut = 0;
    transport.on('message', () => { read++; }); transport.on('message-pruned', () => { cut++; }); transport.on('message-error', () => {});
    const data = '{"type":"remote.QueueEvent","payload":{"list":' + '['.repeat(2e6) + '1' + ']'.repeat(2e6) + '}}';
    for (const listener of transport.ws.listeners.message) listener({ data });
    transport.close(); console.log(read === 1 && cut === 1 ? 'vivant' : 'non lu');`;
  const run = spawnSync(process.execPath, ['--max-old-space-size=96', '-e', child], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(0, 300));
  assert.match(run.stdout, /vivant/, 'trame lue une fois, coupée une fois');
});

// Même relecture : la coupe dans le texte ne compte ni les crochets ni les accolades d'un texte
// (guillemets et barres obliques échappés compris), coupe chaque branche trop profonde à sa place
// et laisse le reste du message intact. Un texte trop profond qui ne se referme pas reste
// illisible, comme avant la coupe.
test('KcsTransport : coupe dans le texte, textes avec crochets et guillemets échappés, plusieurs branches, texte mal fermé', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  const messages = [], pruned = [], errors = [];
  transport.on('message', m => messages.push(m));
  transport.on('message-pruned', type => pruned.push(type));
  transport.on('transport-error', reason => errors.push(reason));
  ws.open();
  // Crochets et accolades équilibrés sur 40 niveaux, dans des textes : comptés, ils seraient coupés.
  const brackets = `${'['.repeat(40)}${']'.repeat(40)}${'{'.repeat(40)}${'}'.repeat(40)}`;
  const quoted = `a"${'['.repeat(40)}${']'.repeat(40)}"b\\`; // guillemets et barre oblique, échappés dans le message
  ws.receive({ type: 'remote.QueueEvent', payload: { title: brackets, artist: quoted, items: [1, { x: ']}' }] } });
  assert.deepEqual([messages.length, pruned, errors], [1, [], []], 'crochets et guillemets dans un texte : rien de coupé');
  assert.deepEqual([messages[0].payload.title, messages[0].payload.artist], [brackets, quoted], 'textes intacts');
  const nested = levels => '{"a":'.repeat(levels) + '1' + '}'.repeat(levels);
  // Deux branches trop profondes (40 niveaux) et, entre elles, un texte qui ressemble à du JSON.
  ws.receive(`{"type":"remote.QueueEvent","payload":{"first":${nested(40)},"note":"\\"{[ ]}\\"","second":[${nested(40)}],"last":2}}`);
  assert.deepEqual(pruned, ['remote.QueueEvent'], 'un seul signalement par message');
  const read = messages[1].payload;
  let first = read.first;
  for (let level = 3; level < 32; level++) first = first.a;
  assert.deepEqual(first, { a: null }, 'première branche coupée au 32e niveau');
  let second = read.second[0];
  for (let level = 4; level < 32; level++) second = second.a;
  assert.deepEqual(second, { a: null }, 'seconde branche coupée au 32e niveau');
  assert.deepEqual([read.note, read.last], ['"{[ ]}"', 2], 'le reste du message est intact');
  // Trop profond et jamais refermé : illisible, comme sans la coupe.
  ws.receive(`{"type":"remote.QueueEvent","payload":${'{"a":'.repeat(40)}1`);
  assert.deepEqual([messages.length, pruned.length, errors], [2, 1, ['Message KaraFun illisible.']]);
});

// Regression: relecture 3 de la PR #64 (sécurité) — une branche de plus de 32 niveaux jamais
// refermée restait dans le texte : JSON.parse y descendait sur toute sa profondeur avant de le
// refuser, en mémoire hors du tas de Node (plus de 500 Mo pour une trame de 8 Mo), que
// --max-old-space-size ne borne pas. Le texte est maintenant illisible sans être confié à
// JSON.parse, même après une branche déjà coupée.
test('KcsTransport : une branche trop profonde jamais refermée est illisible sans être lue', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  const messages = [], errors = [];
  transport.on('message', m => messages.push(m));
  transport.on('transport-error', reason => errors.push(reason));
  ws.open();
  const parse = t.mock.method(JSON, 'parse');
  const open = '['.repeat(2e6);
  ws.receive(`{"type":"remote.QueueEvent","payload":${open}`);
  ws.receive(`{"type":"remote.QueueEvent","payload":[${'['.repeat(40)}${']'.repeat(40)},${open}`);
  assert.deepEqual([messages.length, errors], [0, ['Message KaraFun illisible.', 'Message KaraFun illisible.']]);
  assert.ok(parse.mock.calls.every(call => String(call.arguments[0]).length < 1000), 'texte jamais confié à JSON.parse');
});

// Même relecture (contradictoire) : la coupe se faisait hors du filet de l'écouteur. Un texte
// qu'elle ne pouvait pas traiter (plus long que le plus long texte de Node : environ 270 Mo de
// branches vides) lançait une erreur hors de toute portée, et le serveur du bar s'arrêtait.
// Conversion, coupe et lecture sont sous le même filet : une erreur rend le message illisible.
test('KcsTransport : une erreur en lisant le texte d’un message le rend illisible, sans sortir de l’écouteur', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  const errors = [];
  transport.on('transport-error', reason => errors.push(reason));
  ws.open();
  const data = { toString() { throw new RangeError('Invalid string length'); } };
  assert.doesNotThrow(() => ws.dispatch('message', { data }));
  // Relecture 3, passe 2 (essais) : la coupe elle-même (branche de plus de 32 niveaux) qui
  // échoue, et non la seule conversion du texte, reste sous le même filet.
  const slice = t.mock.method(String.prototype, 'slice', () => { throw new RangeError('Invalid string length'); });
  let thrown = null;
  try { ws.receive(`{"type":"remote.QueueEvent","payload":${'['.repeat(40)}${']'.repeat(40)}}`); } catch (error) { thrown = error; }
  slice.mock.restore();
  assert.equal(thrown, null, 'rien ne sort de l’écouteur');
  assert.deepEqual(errors, ['Message KaraFun illisible.', 'Message KaraFun illisible.']);
});

// Même relecture (essais, maintenabilité, machines à états) : une branche coupée n'est jamais
// lue, bien formée ou non. Un contenu mal formé seulement au-delà de 32 niveaux part donc avec
// elle et le message est lu, alors que JSON.parse seul l'aurait refusé ; mal formé ailleurs, le
// message reste illisible.
test('KcsTransport : contenu mal formé seulement au-delà de 32 niveaux : coupé avec sa branche, message lu', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const ws = FakeWebSocket.instances[0];
  const messages = [], pruned = [], errors = [];
  transport.on('message', m => messages.push(m));
  transport.on('message-pruned', type => pruned.push(type));
  transport.on('transport-error', reason => errors.push(reason));
  ws.open();
  const frame = (inside, after = '') => `{"type":"remote.QueueEvent","payload":{"list":${'['.repeat(40)}${inside}${']'.repeat(40)}${after},"last":2}}`;
  for (const inside of ['1,,2', '[1}', '{"a" 1}']) {
    assert.throws(() => JSON.parse(frame(inside)), SyntaxError, `${inside} : texte mal formé`);
    ws.receive(frame(inside));
  }
  assert.deepEqual([messages.length, pruned.length, errors], [3, 3, []]);
  assert.deepEqual(messages.map(m => m.payload.last), [2, 2, 2], 'le reste du message est lu');
  ws.receive(frame('1', ','));
  assert.deepEqual([messages.length, errors], [3, ['Message KaraFun illisible.']], 'mal formé hors de la branche coupée : illisible');
});
