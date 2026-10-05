'use strict';
// Titres de la communauté KaraFun (partagés par ses membres, hors catalogue
// officiel). Le SDK de la télécommande (webkcs) identifie un titre par
// { type, id } : 1 catalogue, 2 communauté. Les deux numérotations sont
// distinctes : un même numéro peut désigner deux chansons. On vérifie ici,
// sans KaraFun réel :
// - la recherche (types=community) et la sélection « Communauté », repérées ;
// - l'envoi avec le type 2 et le rapprochement avec la file de KaraFun ;
// - le refus de KaraFun : titres retirés, chanteurs prévenus, soirée qui continue ;
// - Battle, doublons, interrupteur du bar, sauvegarde et faux KaraFun.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const { Catalog, normalizeSong, songKind } = require('../catalog');
const { KaraFunBridge, normalizeKcsItem, normalizeResults, SONG_TYPE } = require('../karafun');
const { sameSong } = require('../song-repeats');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight, inspectRecoveredPending } = require('../night-state');
const { analyzeState } = require('../karafun-state');

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------- modules
test('type d’un titre : identifiant { type, id } ou nom ; un nombre seul dans `type` ne compte pas', () => {
  assert.equal(SONG_TYPE.COMMUNITY, 2);
  assert.equal(songKind({ id: { type: 2, id: 5 } }), 'community');
  assert.equal(songKind({ id: { type: 1, id: 5 } }), 'catalog');
  assert.equal(songKind({ type: 'community' }), 'community');
  assert.equal(songKind({ songType: 'Karaoke' }), 'catalog');
  assert.equal(songKind({ type: 2 }), null, 'un « type » numérique sans identifiant reste inconnu');
  assert.equal(songKind({ type: 'song' }), null);
  assert.deepEqual(normalizeSong({ id: 9, title: 'T', artist: 'A' }, { community: true }),
    { songId: 9, title: 'T', artist: 'A', duration: null, img: null, year: null, isExplicit: false, community: true });
  assert.equal(normalizeSong({ id: 9, title: 'T' }).community, undefined, 'catalogue par défaut');
  assert.equal(normalizeSong({ id: { type: 1, id: 9 }, title: 'T' }, { community: true }).community, undefined,
    'le type porté par le titre prime sur la demande');
  assert.equal(normalizeSong({ id: { type: 2, id: 9 }, title: 'T' }).songId, 9);

  assert.deepEqual(normalizeResults([{ id: 4, title: 'Chanson maison', artist: 'X' }], { community: true }),
    [{ songId: 4, title: 'Chanson maison', artist: 'X', img: null, duration: null, duo: false, community: true }]);
  assert.deepEqual(normalizeResults([{ id: { type: 2, id: 4 }, title: 'Mêlé' }, { id: { type: 1, id: 5 }, title: 'Cat' }])
    .map(song => [song.songId, !!song.community]), [[4, true], [5, false]], 'liste mêlée : chaque titre garde son type');
  assert.equal(normalizeResults([{ id: 4, title: 'Sans type' }])[0].community, undefined);

  assert.deepEqual(plain(normalizeKcsItem({ id: 'q1', song: { id: { type: 2, id: 70002 }, title: 'Maison', artist: 'A',
    songTracks: [], options: { singer: 'Léa · T1' } } })).community, true);
  assert.equal(normalizeKcsItem({ id: 'q2', song: { id: { type: 1, id: 70002 }, title: 'Cat', songTracks: [] } }).community, undefined);
});

test('doublons et titre en cours : même numéro dans deux numérotations, deux chansons distinctes', () => {
  assert.equal(sameSong({ songId: 7, title: 'Maison' }, { songId: 7, title: 'Catalogue', community: true }), false);
  assert.equal(sameSong({ songId: 7, title: 'Même titre' }, { songId: 8, title: 'Même titre', community: true }), true,
    'même titre : la salle l’entend comme le même morceau');
  assert.equal(sameSong({ songId: 7, title: 'A', community: true }, { songId: 7, title: 'B', community: true }), true);
  const queue = [{ queueId: 1, songId: 7, singer: 'Léa', title: 'Catalogue' }, { queueId: 2, songId: 7, singer: 'Léa', title: 'Maison', community: true }];
  const { current } = analyzeState(queue, { state: 'playing', songPlaying: { songId: 7, singer: 'Léa', community: true } });
  assert.equal(current.queueId, 2, 'sans identifiant de file, le titre en cours se reconnaît avec son type');
  // Repli par le titre : jamais un titre de l'autre numérotation.
  const fallback = analyzeState([{ queueId: 1, songId: 9, singer: 'Tom', title: 'Même titre' }],
    { state: 'playing', songPlaying: { songId: 7, title: 'Même titre', community: true } });
  assert.equal(fallback.current.queueId, undefined, 'le titre du catalogue de même nom n’est pas pris pour celui sur scène');
  assert.equal(fallback.upcoming.length, 1);
});

test('catalogue : sélection de la communauté demandée avec types=community, titres repérés', async () => {
  const urls = [];
  const api = new Catalog({ base: 'https://kf.exemple.invalid', code: '123456',
    fetchImpl: async url => { urls.push(url); return { ok: true, json: async () => [{ id: 31, title: 'Maison', artist: 'Bar' }] }; } });
  assert.deepEqual((await api.highlights('news', { community: true })).map(song => [song.songId, song.community]), [[31, true]]);
  assert.match(urls[0], /type=news&types=community$/);
  assert.equal((await api.highlights('news'))[0].community, undefined);
  assert.match(urls[1], /types=karaoke$/);
});

// ---------------------------------------------------------------- protocole KCS
class FakeWebSocket {
  static OPEN = 1;
  constructor() { this.readyState = 0; this.listeners = {}; this.sent = []; FakeWebSocket.instances.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
  open() { this.readyState = 1; this.dispatch('open'); }
  receive(message) { this.dispatch('message', { data: JSON.stringify(message) }); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
}
FakeWebSocket.instances = [];
const CODE = '123456';
const ADMIN = { manageQueue: true, viewQueue: true, addToQueue: true, managePlayback: true, manageVolumes: true,
  sendPhotos: true, shownTypes: { karaoke: true, community: false, quiz: false, battle: true } };

async function kcs(t, respond = null) {
  const saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
  FakeWebSocket.instances = [];
  const calls = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async url => {
    calls.push(url);
    if (respond) return respond(url);
    return { ok: true, status: 200, text: async () => `<script>var Settings = ${JSON.stringify({ kcs_url: 'wss://kcs.exemple.invalid/x' })};</script>` };
  };
  t.after(() => { globalThis.WebSocket = saved.WebSocket; globalThis.fetch = saved.fetch; });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const bridge = new KaraFunBridge({ bases: ['https://kf.exemple.invalid'] });
  t.after(() => bridge.disconnect());
  bridge.connect(CODE);
  await flush();
  const ws = FakeWebSocket.instances.at(-1);
  ws.open();
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1 } } });
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: ADMIN } });
  return { bridge, ws, calls };
}
const lastAdd = ws => ws.sent.filter(m => m.type === 'remote.AddToQueueRequest').at(-1);

test('KCS : un titre de la communauté part avec le type 2, un titre du catalogue avec le type 1', async t => {
  const { bridge, ws } = await kcs(t);
  assert.equal(bridge.communityChannel(), true);
  bridge.add(70002, 'Léa · T1', 99999, null, { community: true });
  assert.deepEqual(lastAdd(ws).payload, { song: { type: 2, id: 70002 }, options: { singer: 'Léa · T1' }, position: 99999 });
  bridge.add(70002, 'Tom · T2');
  assert.deepEqual(lastAdd(ws).payload.song, { type: 1, id: 70002 });
  assert.deepEqual(bridge.communityState(), { channel: true, permitted: false, support: 'unknown', notice: null });
});

test('KCS : KaraFun accepte un titre de la communauté → fonction confirmée', async t => {
  const { bridge, ws } = await kcs(t);
  bridge.add(70002, 'Léa · T1', 99999, null, { community: true });
  ws.receive({ id: lastAdd(ws).id, type: 'remote.AddToQueueResponse', payload: {} });
  assert.equal(bridge.communitySupport, 'ok');
  assert.equal(bridge.communityUsable(), true);
});

test('KCS : refus d’un titre de la communauté → signalé une fois, sans passer pour une panne', async t => {
  const { bridge, ws } = await kcs(t);
  const refused = [];
  bridge.on('community-add-refused', add => refused.push(add));
  bridge.add(70002, 'Léa · T1', 99999, null, { community: true });
  ws.receive({ id: lastAdd(ws).id, type: 'Error', payload: { type: 3, message: 'Permission denied' } });
  assert.deepEqual(refused, [{ songId: 70002, singer: 'Léa · T1', message: 'Permission denied', global: true, repeat: false }]);
  assert.equal(bridge.communitySupport, 'refused');
  assert.equal(bridge.communityUsable(), false);
  assert.equal(bridge.lastError, null);
  assert.match(bridge.communityState().notice, /refuse les titres de la communauté.*Permission denied/);
  // La permission « community » changée dans KaraFun : nouvel essai possible.
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: { ...ADMIN, shownTypes: { ...ADMIN.shownTypes, community: true } } } });
  assert.equal(bridge.communitySupport, 'unknown');
  assert.equal(bridge.communityState().permitted, true);
});

test('KCS : file pleine ne dit rien de la communauté ; pas de réglages à l’ajout avant son accord', async t => {
  const { bridge, ws } = await kcs(t);
  ws.receive({ type: 'remote.ConfigurationUpdateEvent', payload: { configuration: { pitchMin: -6, pitchMax: 6, pitchStep: 1, tempoMin: -50, tempoMax: 50, tempoStep: 5 } } });
  const refused = [], options = [];
  bridge.on('community-add-refused', add => refused.push(add));
  bridge.on('add-options-refused', add => options.push(add));
  bridge.add(70002, 'Léa · T1', 99999, null, { community: true });
  ws.receive({ id: lastAdd(ws).id, type: 'Error', payload: { type: 3, message: 'Queue is full' } });
  assert.equal(bridge.communitySupport, 'unknown');
  assert.equal(bridge.lastError, 'Commande KaraFun refusée : Queue is full');
  // Avant tout accord, un titre de la communauté part sans réglages : un refus ne vise qu'une chose.
  assert.equal(bridge.add(70003, 'Zoé · T3', 99999, { pitch: -2 }, { community: true }), null);
  assert.deepEqual(lastAdd(ws).payload, { song: { type: 2, id: 70003 }, options: { singer: 'Zoé · T3' }, position: 99999 });
  ws.receive({ id: lastAdd(ws).id, type: 'remote.AddToQueueResponse', payload: {} });
  assert.equal(bridge.communitySupport, 'ok');
  // Accepté : les réglages partent avec le titre ; une Error est alors d'abord celle des réglages.
  assert.deepEqual(bridge.add(70004, 'Zoé · T3', 99999, { pitch: -2 }, { community: true }), { pitch: -2 });
  ws.receive({ id: lastAdd(ws).id, type: 'Error', payload: { type: 3, message: 'Invalid options' } });
  assert.deepEqual(options, [{ songId: 70004, singer: 'Zoé · T3', community: true }]);
  assert.deepEqual(refused, []);
  assert.equal(bridge.communitySupport, 'ok');
});

test('KCS : refus d’un titre précis, ou de tous les titres de la communauté sur un signal net', async t => {
  const { bridge, ws } = await kcs(t);
  const refused = [];
  bridge.on('community-add-refused', add => refused.push([add.songId, add.global, add.repeat]));
  const refuse = (songId, message) => {
    bridge.add(songId, 'X', 99999, null, { community: true });
    ws.receive({ id: lastAdd(ws).id, type: 'Error', payload: { type: 3, message } });
  };
  refuse(70002, 'Song not found');
  assert.deepEqual(refused.at(-1), [70002, false, false], 'un titre introuvable : ce titre seulement');
  assert.equal(bridge.communityUsable(), true);
  refuse(70002, 'Song not found');
  assert.deepEqual(refused.at(-1), [70002, false, false], 'le même titre ne compte qu’une fois');
  refuse(70005, 'Song not found');
  assert.deepEqual(refused.at(-1), [70005, true, false], 'deux titres différents refusés avant tout accord : refus global');
  assert.equal(bridge.communityUsable(), false);
  refuse(70006, 'Song not found');
  assert.deepEqual(refused.at(-1), [70006, true, true], 'déjà refusé : signalé sans nouvel avis');
  bridge.resetCommunitySupport();
  refuse(70007, 'Remote type not supported');
  assert.deepEqual(refused.at(-1), [70007, true, false], 'message de type ou de droits : refus global');
  bridge.resetCommunitySupport();
  bridge.add(70008, 'X', 99999, null, { community: true });
  ws.receive({ id: lastAdd(ws).id, type: 'remote.AddToQueueResponse', payload: {} });
  refuse(70009, 'Permission denied');
  assert.deepEqual(refused.at(-1), [70009, false, false], 'après un accord, un refus ne vise que ce titre');
  assert.equal(bridge.communitySupport, 'ok');
});

test('recherche KaraFun : types=community, titres repérés et réponse gardée au journal', async t => {
  const { bridge, calls } = await kcs(t, url => url.includes('type=search')
    ? { ok: true, status: 200, text: async () => JSON.stringify([{ id: 70001, title: 'Le Petit Bonhomme', artist: 'P' }]) }
    : { ok: true, status: 200, text: async () => `<script>var Settings = ${JSON.stringify({ kcs_url: 'wss://kcs.exemple.invalid/x' })};</script>` });
  const found = await bridge.search('bonhomme', { community: true });
  assert.deepEqual(found.map(song => [song.songId, song.community]), [[70001, true]]);
  assert.ok(calls.some(url => url.endsWith('?type=search&q=bonhomme&types=community')));
  assert.ok(bridge.events.some(event => event.name === 'community-search-sample'));
});

test('ancienne télécommande d’un vrai KaraFun : elle ajouterait le titre du catalogue de même numéro, refusé', () => {
  const bridge = new KaraFunBridge({ bases: ['https://kf.exemple.invalid'] });
  Object.assign(bridge, { protocol: 'socket.io', connected: true, ready: true, socket: { emit() { assert.fail('rien ne part'); } } });
  assert.equal(bridge.communityChannel(), false);
  assert.equal(bridge.communityUsable(), false);
  assert.throws(() => bridge.add(70002, 'Léa', 99999, null, { community: true }), /ancienne télécommande KaraFun ne connaît pas les titres de la communauté/);
});

// ---------------------------------------------------------------- serveur
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

function harness({ timers = false } = {}) {
  const entry = source.lastIndexOf('main().catch(');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), '--demo'];
  const context = { require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL,
    ...(timers ? { setTimeout, clearTimeout } : { setTimeout: () => ({ unref() {} }), clearTimeout() {} }), setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, handlers, access, journal, sync, staffState, publicState,
      communityAddRefused, wireBridge, resendWithoutOptions, abandonRestart, communityHighlights, rememberCatalogSongs,
      restart: () => restartOp, setRestart: op => { restartOp = op; }, sweep: () => restartSweep,
      tracked: () => tracked, pending: () => pending, setBridge: b => { bridge = b; },
      handle: server.listeners('request')[0], STAFF_KEY, PORT };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  f.settings.pushDelaySec = 0;
  f.journal.start({ rules: {} });
  f.call = async (route, body = {}) => f.handlers[route]({}, {}, body);
  return f;
}

const CATALOG = [{ songId: 70002, title: 'Bohemian Rhapsody', artist: 'Queen' }, { songId: 101, title: 'Titre 101', artist: 'A' }];
const COMMUNITY = [{ songId: 70002, title: 'Bohemian Rhapsody (version acoustique)', artist: 'Queen' },
  { songId: 71000, title: 'Chanson du bar', artist: 'Les Habitués' }];

// Vrai pont KaraFun, prêt, sur un faux canal KCS ; recherche simulée.
// `confirmed` : KaraFun a déjà accepté un titre de la communauté (sa
// télécommande les annonce « non affichés », comme au bar le 2 octobre).
function kcsBridge(f, { echo = false, confirmed = true } = {}) {
  f.settings.communityConfirmed = confirmed;
  const bridge = new KaraFunBridge();
  const sent = [];
  Object.assign(bridge, { protocol: 'kcs', ready: true, connected: true, queue: [], status: { state: 'idle', current: null } });
  bridge.raw.permissions = ADMIN;
  bridge.permissions = { ...ADMIN, managePlayer: true };
  bridge.socket = { send(type, payload) { sent.push({ type, payload }); return sent.length; }, close() {}, removeAllListeners() {} };
  bridge.searches = [];
  bridge.search = async (q, { community = false } = {}) => {
    bridge.searches.push([q, community]);
    // `echo` : KaraFun qui ignorerait types=community et rendrait le catalogue.
    return normalizeResults(community && !echo ? COMMUNITY : CATALOG, { community });
  };
  f.setBridge(bridge);
  return { bridge, sent };
}

function get(f, url) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1', localPort: f.PORT }, destroy() {} });
    const out = { status: null };
    const res = { setHeader() {}, getHeader() {}, removeHeader() {},
      writeHead(status) { out.status = status; },
      end(data = '') { out.body = JSON.parse(String(data)); resolve(out); } };
    f.handle(req, res);
  });
}
function openTable(f, id) {
  f.sched.table(id).headcount = 6;
  return { table: id, access: f.access.issue(id) };
}
function singer(f, tb, name) {
  const p = f.sched.join({ tableId: tb.table, name });
  return { person: p, body: { ...tb, personId: p.id, token: p.token } };
}
async function rejects(promise, code, message) {
  await assert.rejects(promise, error => {
    if (code) assert.equal(error.code, code, error.message);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test('serveur : recherche du catalogue puis de la communauté, repérée ; une Battle n’en demande pas', async () => {
  const f = harness();
  const { bridge } = kcsBridge(f);
  const out = await get(f, '/api/search?q=queen');
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.map(song => [song.songId, song.title, !!song.community]), [
    [70002, 'Bohemian Rhapsody', false], [101, 'Titre 101', false],
    [70002, 'Bohemian Rhapsody (version acoustique)', true], [71000, 'Chanson du bar', true]]);
  assert.deepEqual(bridge.searches, [['queen', false], ['queen', true]]);
  bridge.searches.length = 0;
  const battle = await get(f, '/api/search?q=queen&kinds=catalog');
  assert.ok(battle.body.every(song => !song.community));
  assert.deepEqual(bridge.searches, [['queen', false]], 'choix d’une Battle : catalogue seul');
  // Coupé par le bar : plus de recherche dans la communauté.
  f.settings.communitySongs = false;
  bridge.searches.length = 0;
  assert.ok((await get(f, '/api/search?q=queen')).body.every(song => !song.community));
  assert.deepEqual(bridge.searches, [['queen', false]]);
  assert.equal(f.publicState(null, null).community.enabled, false);
});

test('serveur : KaraFun annonce la communauté « non affichée » → proposée aux téléphones seulement après un essai réussi du bar', async () => {
  const f = harness();
  const { bridge, sent } = kcsBridge(f, { confirmed: false });
  assert.ok((await get(f, '/api/search?q=queen')).body.every(song => !song.community), 'pas proposée avant l’essai');
  assert.deepEqual(plain(f.publicState(null, null).community), { enabled: false, off: false, refused: false, unconfirmed: true });
  // Le bar cherche dans « Diagnostic KaraFun » (sa clé) : la communauté y figure pour l'essayer.
  const staffSearch = await get(f, `/api/search?q=queen&kinds=all&key=${encodeURIComponent(f.STAFF_KEY)}`);
  assert.ok(staffSearch.body.some(song => song.community));
  assert.ok((await get(f, '/api/search?q=queen&kinds=all')).body.every(song => !song.community), 'kinds=all réservé au bar');
  await f.call('POST /api/staff/kf', { action: 'test-add', songId: 71000, community: true });
  assert.deepEqual(sent.at(-1).payload.song, { type: 2, id: 71000 });
  bridge.communitySupport = 'ok'; // KaraFun a répondu AddToQueueResponse
  f.sync();
  assert.equal(f.settings.communityConfirmed, true, 'accord gardé pour les soirées suivantes');
  assert.equal(f.publicState(null, null).community.enabled, true);
  bridge.communitySupport = 'unknown'; // nouvelle soirée, KaraFun relancé
  assert.ok((await get(f, '/api/search?q=queen')).body.some(song => song.community), 'toujours proposée');
  bridge.communitySupport = 'refused';
  f.sync();
  assert.equal(f.settings.communityConfirmed, false, 'un refus efface l’accord');
});

test('serveur : page restée ouverte d’avant la mise à jour — un titre de la communauté sans repère le retrouve', async () => {
  const f = harness();
  const { sent } = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa');
  await get(f, '/api/search?q=queen');
  await f.call('POST /api/table/song', { ...lea.body, song: { songId: 70002, title: 'Bohemian Rhapsody (version acoustique)', artist: 'Queen' }, mode: 'append' });
  await f.call('POST /api/table/song', { ...lea.body, song: { songId: 70002, title: 'Bohemian Rhapsody', artist: 'Queen' }, mode: 'append' });
  assert.deepEqual(plain(f.sched.songsOf(lea.person).map(song => [song.title, !!song.community])),
    [['Bohemian Rhapsody (version acoustique)', true], ['Bohemian Rhapsody', false]]);
  f.settings.auto = true;
  f.sync();
  assert.deepEqual(sent.find(m => m.type === 'remote.AddToQueueRequest').payload.song, { type: 2, id: 70002 });
});

test('serveur : une réponse qui ignore types=community n’est jamais présentée comme la communauté', async () => {
  const f = harness();
  kcsBridge(f, { echo: true });
  const out = await get(f, '/api/search?q=queen');
  assert.deepEqual(out.body.map(song => [song.songId, !!song.community]), [[70002, false], [101, false]]);
});

test('serveur : choisir un titre de la communauté, envoi avec le type 2, accusé seulement par le bon type', async () => {
  const f = harness();
  const { bridge, sent } = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa');
  // Pas encore vu dans la recherche de ce serveur : refusé.
  await rejects(f.call('POST /api/table/song', { ...lea.body, song: { songId: 71000, title: 'Inventé', community: true }, mode: 'append' }),
    'COMMUNITY_UNKNOWN');
  await get(f, '/api/search?q=queen');
  await f.call('POST /api/table/song', { ...lea.body, song: { songId: 70002, title: 'Titre trafiqué', community: true }, mode: 'append' });
  // Même numéro, titre du catalogue : une autre chanson, pas un doublon.
  await f.call('POST /api/table/song', { ...lea.body, song: { songId: 70002, title: 'Bohemian Rhapsody', artist: 'Queen' }, mode: 'append' });
  await rejects(f.call('POST /api/table/song', { ...lea.body, song: { songId: 70002, community: true }, mode: 'append' }), 'ALREADY_LISTED');
  const songs = f.sched.songsOf(lea.person);
  assert.deepEqual(songs.map(song => [song.songId, song.title, !!song.community]), [
    [70002, 'Bohemian Rhapsody (version acoustique)', true], [70002, 'Bohemian Rhapsody', false]],
  'le titre vient de KaraFun, pas du téléphone');
  const view = f.publicState(lea.person, '1', new Set([lea.person.id]));
  assert.deepEqual(view.me.songs.map(song => !!song.community), [true, false], 'repère visible du téléphone');
  assert.equal(view.queue[0].song.community, true, 'et dans la file');

  f.settings.auto = true;
  f.sync();
  const add = sent.find(m => m.type === 'remote.AddToQueueRequest');
  assert.deepEqual(add.payload.song, { type: 2, id: 70002 });
  const label = add.payload.options.singer;
  assert.ok(f.pending(), 'en attente de l’accusé');
  // Le titre du catalogue de même numéro et même nom de chanteur n'est pas l'accusé.
  bridge.queue = [normalizeKcsItem({ id: 'k1', song: { id: { type: 1, id: 70002 }, title: 'Bohemian Rhapsody', songTracks: [], options: { singer: label } } })];
  f.sync();
  assert.ok(f.pending(), 'toujours en attente');
  assert.equal(inspectRecoveredPending(f.pending(), bridge.queue).state, 'unconfirmed');
  bridge.queue.push(normalizeKcsItem({ id: 'c1', song: { id: { type: 2, id: 70002 }, title: 'Bohemian Rhapsody (version acoustique)', songTracks: [], options: { singer: label } } }));
  f.sync();
  assert.equal(f.pending(), null);
  assert.deepEqual(plain(f.tracked().map(tr => [tr.queueId, !!tr.sel.song.community])), [['c1', true]]);
  const staff = f.staffState();
  const line = staff.queue.find(item => item.queueId === 'c1');
  assert.equal(line.community, true);
  assert.equal(line.song.community, true);
  // Regression: ISSUE-001 — « Déjà prête dans la file » perdait le repère (et les paroles cherchaient le catalogue)
  // Found by /qa on 2026-10-05
  // Report: .gstack/qa-reports/run-20261005T203849Z/qa-report-127.0.0.1-2026-10-05.md
  const ready = f.publicState(lea.person, '1', new Set([lea.person.id])).tablePeople.find(p => p.id === lea.person.id).inKaraFun;
  assert.deepEqual(plain(ready.map(song => [song.title, !!song.community])), [['Bohemian Rhapsody (version acoustique)', true]]);
});

test('serveur : KaraFun refuse → titres de la communauté retirés, chanteurs prévenus, la soirée continue', async () => {
  const f = harness();
  const { bridge, sent } = kcsBridge(f);
  const tb = openTable(f, '1');
  const tb2 = openTable(f, '2');
  const lea = singer(f, tb, 'Léa');
  const tom = singer(f, tb2, 'Tom');
  const zoe = singer(f, tb2, 'Zoé');
  await get(f, '/api/search?q=queen');
  await f.call('POST /api/table/song', { ...lea.body, song: { songId: 70002, community: true }, mode: 'append' });
  await f.call('POST /api/table/song', { ...lea.body, song: { songId: 101, title: 'Titre 101' }, mode: 'append' });
  await f.call('POST /api/table/duet', { ...tom.body, partnerId: zoe.person.id, song: { songId: 71000, community: true } });
  f.settings.auto = true;
  f.sync();
  const first = sent.filter(m => m.type === 'remote.AddToQueueRequest');
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].payload.song, { type: 2, id: first[0].payload.song.id });
  const label = first[0].payload.options.singer;
  bridge.communitySupport = 'refused';
  f.communityAddRefused({ songId: first[0].payload.song.id, singer: label, message: 'Permission denied' });
  assert.equal(f.sched.songsOf(lea.person).every(song => !song.community), true);
  assert.deepEqual(f.sched.songsOf(lea.person).map(song => song.songId), [101], 'son titre du catalogue reste');
  assert.deepEqual(f.sched.songsOf(tom.person), [], 'le duo de la communauté aussi');
  const inbox = person => plain(person.inbox.filter(notice => notice.kind !== 'duoAdded')
    .map(notice => [notice.kind, notice.params.title, notice.params.name || null]));
  assert.deepEqual(inbox(lea.person), [['communityRefused', 'Bohemian Rhapsody (version acoustique)', null]]);
  assert.deepEqual(inbox(tom.person), [['communityRefused', 'Chanson du bar', null]]);
  assert.deepEqual(inbox(zoe.person), [['communityRefused', 'Chanson du bar', 'Tom']], 'l’invitée apprend le retrait, pas une annulation');
  assert.ok(f.sched.log.some(line => /KaraFun refuse les titres de la communauté.*Permission denied.*2 titres retirés/.test(line.msg)));
  // Le passage suivant (titre du catalogue) part aussitôt.
  const next = sent.filter(m => m.type === 'remote.AddToQueueRequest').at(-1);
  assert.notEqual(next, first[0]);
  assert.deepEqual(next.payload.song, { type: 1, id: 101 });
  assert.ok(f.pending() && !f.pending().sel.song.community);
  // Les téléphones ne proposent plus la communauté et un nouveau choix est refusé clairement.
  assert.deepEqual(plain(f.publicState(null, null).community), { enabled: false, off: false, refused: true, unconfirmed: false });
  await rejects(f.call('POST /api/table/song', { ...tom.body, song: { songId: 71000, community: true }, mode: 'append' }),
    'COMMUNITY_REFUSED', /choisis un titre du catalogue/);
  assert.equal(f.staffState().community.support, 'refused');
  assert.equal(f.settings.communityConfirmed, false, 'l’accord est effacé');
  // Le bar coupe puis réactive l'interrupteur : KaraFun redevient « pas encore essayé ».
  await f.call('POST /api/staff/settings', { communitySongs: false });
  await rejects(f.call('POST /api/table/song', { ...tom.body, song: { songId: 71000, community: true }, mode: 'append' }), 'COMMUNITY_OFF');
  await f.call('POST /api/staff/settings', { communitySongs: true });
  assert.equal(bridge.communitySupport, 'unknown');
  // Sa télécommande les annonce « non affichés » : rien pour les téléphones avant un essai réussi.
  await rejects(f.call('POST /api/table/song', { ...tom.body, song: { songId: 71000, community: true }, mode: 'append' }), 'COMMUNITY_REFUSED');
  bridge.communitySupport = 'ok'; // essai « Ajouter à KaraFun (test) » accepté
  f.sync();
  await f.call('POST /api/table/song', { ...tom.body, song: { songId: 71000, community: true }, mode: 'append' });
  await rejects(f.call('POST /api/staff/settings', { communitySongs: 'oui' }), null, /oui ou non/);
});

// Regression: relecture gstack /review et Codex (PR #14) — refus ciblé, envoi en attente, relance, renvois
test('serveur : refus d’un seul titre → seul ce titre quitte la liste, la communauté reste proposée', async () => {
  const f = harness();
  const { sent } = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa');
  const tom = singer(f, tb, 'Tom');
  await get(f, '/api/search?q=queen');
  await f.call('POST /api/table/song', { ...lea.body, song: { songId: 71000, community: true }, mode: 'append' });
  await f.call('POST /api/table/song', { ...tom.body, song: { songId: 70002, community: true }, mode: 'append' });
  f.settings.auto = true;
  f.sync();
  const first = sent.filter(m => m.type === 'remote.AddToQueueRequest').at(-1);
  const owner = [lea, tom].find(x => first.payload.options.singer.startsWith(x.person.name));
  const other = owner === lea ? tom : lea;
  f.communityAddRefused({ songId: first.payload.song.id, singer: first.payload.options.singer, message: 'Song not found', global: false });
  assert.deepEqual(f.sched.songsOf(owner.person), [], 'le titre refusé est retiré');
  assert.equal(f.sched.songsOf(other.person)[0].community, true, 'l’autre titre de la communauté reste');
  assert.deepEqual(plain(owner.person.inbox.map(n => n.kind)), ['communityFailed']);
  assert.equal(f.publicState(null, null).community.enabled, true, 'la communauté reste proposée');
  assert.ok(f.sched.log.some(line => /KaraFun refuse « .* » \(Song not found\) : titre de la communauté retiré de la liste/.test(line.msg)));
  const next = sent.filter(m => m.type === 'remote.AddToQueueRequest').at(-1);
  assert.notEqual(next, first, 'le passage suivant part');
});

test('serveur : un refus global, même venu d’un autre envoi (essai du bar), abandonne l’envoi de la communauté en attente', async () => {
  const f = harness();
  const { sent } = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa');
  const tom = singer(f, tb, 'Tom');
  await get(f, '/api/search?q=queen');
  await f.call('POST /api/table/song', { ...lea.body, song: { songId: 71000, community: true }, mode: 'append' });
  f.settings.auto = true;
  f.sync();
  assert.equal(f.pending()?.sel.song.community, true);
  f.sched.chooseSong(tom.person, { songId: 101, title: 'Titre 101', artist: 'A' }, 'append');
  f.communityAddRefused({ songId: 70002, singer: 'Test file karaoké', message: 'Permission denied', global: true, repeat: false });
  assert.ok(!f.pending() || !f.pending().sel.song.community, 'l’envoi de la communauté en attente est abandonné');
  assert.deepEqual(f.sched.songsOf(lea.person), []);
  assert.deepEqual(sent.filter(m => m.type === 'remote.AddToQueueRequest').at(-1).payload.song, { type: 1, id: 101 });
});

test('serveur : relance ⏮ d’un titre de la communauté — copie refusée arrêtée, copie tardive retirée, renvois avec leur type', async () => {
  const f = harness();
  const { bridge, sent } = kcsBridge(f);
  // Copie refusée par KaraFun : aucune copie n'existe, la relance s'arrête.
  f.setRestart({ songId: 70002, singer: 'Léa · T1', community: true, title: 'Maison', before: [], at: Date.now(), phase: 'adding',
    originalQueueId: 'o1', trackedQueueId: null });
  f.communityAddRefused({ songId: 70002, singer: 'Léa · T1', message: 'Song not found', global: false });
  assert.equal(f.restart(), null);
  assert.ok(f.sched.log.some(line => /KaraFun refuse la copie de « Maison »/.test(line.msg)));
  // Relance abandonnée : la copie tardive (type 2) est retirée, pas le titre du catalogue de même numéro.
  const copy = normalizeKcsItem({ id: 'late', song: { id: { type: 2, id: 70002 }, title: 'Maison', songTracks: [], options: { singer: 'Léa · T1' } } });
  const twin = normalizeKcsItem({ id: 'twin', song: { id: { type: 1, id: 70002 }, title: 'Cat', songTracks: [], options: { singer: 'Léa · T1' } } });
  f.abandonRestart({ songId: 70002, singer: 'Léa · T1', community: true, title: 'Maison', before: [], originalQueueId: 'o1',
    copyQueueId: null, trackedQueueId: null }, { current: null, upcoming: [copy, twin], q: [copy, twin] }, 'Relance abandonnée.', Date.now());
  assert.equal(f.sweep().community, true);
  assert.deepEqual(sent.filter(m => m.type === 'remote.RemoveFromQueueRequest').map(m => m.payload.queueItemId), ['late']);
  // Renvoi sans réglages d'un titre de la communauté : toujours le type 2.
  bridge.communitySupport = 'ok';
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa');
  await get(f, '/api/search?q=queen');
  await f.call('POST /api/table/song', { ...lea.body, song: { songId: 71000, community: true }, mode: 'append' });
  lea.person.song.settings = { pitch: -2 };
  f.settings.auto = true;
  f.sync();
  const withOptions = sent.filter(m => m.type === 'remote.AddToQueueRequest').at(-1);
  assert.deepEqual(withOptions.payload.song, { type: 2, id: 71000 });
  assert.equal(withOptions.payload.options.pitch, -2);
  f.resendWithoutOptions({ songId: 71000, singer: withOptions.payload.options.singer, community: true });
  assert.deepEqual(sent.filter(m => m.type === 'remote.AddToQueueRequest').at(-1).payload,
    { song: { type: 2, id: 71000 }, options: { singer: withOptions.payload.options.singer }, position: 99999 });
});

test('serveur : essai du bar avec un titre de la communauté, titre long gardé', async () => {
  const f = harness();
  const { sent } = kcsBridge(f);
  await rejects(f.call('POST /api/staff/kf', { action: 'test-add', songId: 71000, community: true }), null, /Retrouve ce titre de la communauté/);
  await get(f, '/api/search?q=queen');
  await f.call('POST /api/staff/kf', { action: 'test-add', songId: 71000, community: true });
  assert.deepEqual(sent.at(-1).payload.song, { type: 2, id: 71000 });
  await f.call('POST /api/staff/kf', { action: 'test-add', songId: 101 });
  assert.deepEqual(sent.at(-1).payload.song, { type: 1, id: 101 });
  // Titre de la communauté très long : affiché, donc choisissable (raccourci).
  f.rememberCatalogSongs([{ songId: 72000, title: 'T'.repeat(150), artist: 'A'.repeat(90), community: true }]);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa');
  await f.call('POST /api/table/song', { ...lea.body, song: { songId: 72000, community: true }, mode: 'append' });
  assert.equal(f.sched.songsOf(lea.person)[0].title.length, 80);
});

test('serveur : sélection « Communauté » sans comparaison possible avec le catalogue → rien n’est proposé', async () => {
  const f = harness();
  kcsBridge(f);
  const c = { highlights: async (type, { community = false } = {}) => community
    ? [{ songId: 9, title: 'Écho', community: true }, { songId: 31, title: 'Maison', community: true }]
    : [{ songId: 9, title: 'Écho' }] };
  assert.deepEqual(plain((await f.communityHighlights(c, 'news')).map(song => song.title)), ['Maison'], 'écho du catalogue écarté');
  const broken = { highlights: async (type, { community = false } = {}) => {
    if (!community) throw new Error('Catalogue KaraFun : HTTP 503');
    return [{ songId: 9, title: 'Écho', community: true }];
  } };
  await assert.rejects(f.communityHighlights(broken, 'news'), /HTTP 503/, 'échec du catalogue : erreur, pas de liste non vérifiée');
  f.settings.communitySongs = false;
  assert.deepEqual(plain(await f.communityHighlights(c, 'news')), []);
});

test('serveur : une recherche de la communauté qui traîne ne retarde pas le catalogue', async () => {
  const f = harness({ timers: true });
  const { bridge } = kcsBridge(f);
  bridge.search = async (q, { community = false } = {}) => community ? new Promise(() => {}) : normalizeResults(CATALOG);
  const started = Date.now();
  const alive = setInterval(() => {}, 100); // le serveur HTTP garde le processus en vie ; ici, ce minuteur
  let out;
  try { out = await get(f, '/api/search?q=queen'); } finally { clearInterval(alive); }
  assert.ok(Date.now() - started < 4000, `réponse en ${Date.now() - started} ms`);
  assert.deepEqual(out.body.map(song => !!song.community), [false, false], 'résultats du catalogue seuls');
});

test('serveur + vrai pont KCS : un refus de KaraFun retire les titres et le passage suivant part', async t => {
  const { bridge, ws } = await kcs(t, url => url.includes('type=search')
    ? { ok: true, status: 200, text: async () => JSON.stringify(url.includes('types=community')
      ? [{ id: 71000, title: 'Chanson du bar', artist: 'Les Habitués' }] : [{ id: 101, title: 'Titre 101', artist: 'A' }]) }
    : { ok: true, status: 200, text: async () => `<script>var Settings = ${JSON.stringify({ kcs_url: 'wss://kcs.exemple.invalid/x' })};</script>` });
  const f = harness();
  f.settings.communityConfirmed = true;
  f.setBridge(bridge);
  f.wireBridge(bridge);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa');
  const tom = singer(f, tb, 'Tom');
  await get(f, '/api/search?q=bar');
  await f.call('POST /api/table/song', { ...lea.body, song: { songId: 71000, community: true }, mode: 'append' });
  f.settings.auto = true;
  f.sync();
  const adds = () => ws.sent.filter(m => m.type === 'remote.AddToQueueRequest');
  const first = adds().at(-1);
  assert.deepEqual(first.payload.song, { type: 2, id: 71000 });
  f.sched.chooseSong(tom.person, { songId: 101, title: 'Titre 101', artist: 'A' }, 'append');
  ws.receive({ id: first.id, type: 'Error', payload: { type: 3, message: 'Permission denied' } });
  await flush();
  assert.deepEqual(f.sched.songsOf(lea.person), []);
  assert.equal(bridge.communitySupport, 'refused');
  assert.deepEqual(adds().at(-1).payload.song, { type: 1, id: 101 }, 'le passage suivant part, sans attendre 15 s');
  assert.equal(f.publicState(null, null).community.enabled, false);
});

// Regression: relecture adversariale gstack (PR #14) — sans accusé, la reprise renvoyait le même titre en boucle
test('serveur : ajout d’un titre de la communauté resté sans trace → retiré à la reprise du bar, jamais renvoyé en boucle', async () => {
  const f = harness();
  const { bridge, sent } = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa');
  const tom = singer(f, tb, 'Tom');
  await get(f, '/api/search?q=queen');
  await f.call('POST /api/table/song', { ...lea.body, song: { songId: 71000, community: true }, mode: 'append' });
  f.settings.auto = true;
  f.sync();
  assert.equal(f.pending()?.sel.song.community, true);
  f.sched.chooseSong(tom.person, { songId: 101, title: 'Titre 101', artist: 'A' }, 'append');
  f.pending().at = 0; // 15 s sans accusé ni trace dans la file de KaraFun
  f.sync();
  assert.equal(f.staffState().recoveredPending, true, 'le bar doit vérifier la file');
  await f.call('POST /api/staff/reconcile-pending');
  assert.deepEqual(f.sched.songsOf(lea.person), [], 'le titre resté sans trace quitte la liste');
  assert.deepEqual(plain(lea.person.inbox.map(n => n.kind)), ['communityFailed']);
  const adds = sent.filter(m => m.type === 'remote.AddToQueueRequest');
  assert.equal(adds.filter(m => m.payload.song.type === 2).length, 1, 'jamais renvoyé');
  assert.deepEqual(adds.at(-1).payload.song, { type: 1, id: 101 }, 'le passage suivant part');
  assert.equal(bridge.communitySupport, 'unknown', 'un seul titre sans trace : pas encore un refus global');
});

test('serveur : un titre de la communauté ne sert jamais de Battle', async () => {
  const f = harness();
  kcsBridge(f);
  await get(f, '/api/search?q=queen');
  await rejects(f.call('POST /api/staff/battle/launch', { song: { songId: 70002, title: 'Bohemian Rhapsody (version acoustique)', community: true } }),
    null, /communauté ne peut pas servir de Battle/);
  // Le titre du catalogue de même numéro reste possible.
  const out = await f.call('POST /api/staff/battle/launch', { song: { songId: 70002 } });
  assert.equal(out.battle.selectedSong.title, 'Bohemian Rhapsody');
});

test('sauvegarde : le repère « communauté » et l’interrupteur du bar survivent à un redémarrage', () => {
  const sched = new Scheduler();
  const access = new TableAccess();
  sched.table('1'); sched.setHeadcount('1', 4); access.issue('1');
  const lea = sched.join({ tableId: '1', name: 'Léa' });
  sched.chooseSong(lea, { songId: 70002, title: 'Maison', artist: 'A', community: true }, 'append');
  sched.chooseSong(lea, { songId: 70002, title: 'Catalogue', artist: 'A', community: 'oui' }, 'append');
  assert.deepEqual(sched.songsOf(lea).map(song => !!song.community), [true, false], 'seul `true` marque la communauté');
  const settings = { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8, communitySongs: false };
  const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: sched, access, settings })));
  const resumed = new Scheduler();
  const resumedSettings = { auto: false, autoPlay: false, pushDelaySec: 45, playDelaySec: 8, communitySongs: true };
  restoreNight(snapshot, { scheduler: resumed, access: new TableAccess(), settings: resumedSettings });
  const person = [...resumed.people.values()][0];
  assert.deepEqual(resumed.songsOf(person).map(song => [song.title, !!song.community]), [['Maison', true], ['Catalogue', false]]);
  assert.equal(resumedSettings.communitySongs, false);
  snapshot.settings.communitySongs = 'abîmé';
  const kept = { auto: false, autoPlay: false, pushDelaySec: 45, playDelaySec: 8, communitySongs: true };
  restoreNight(snapshot, { scheduler: new Scheduler(), access: new TableAccess(), settings: kept });
  assert.equal(kept.communitySongs, true, 'valeur abîmée : la valeur actuelle reste');
});

// ---------------------------------------------------------------- faux KaraFun (démo)
test('faux KaraFun : recherche types=community et ajout marqué par l’ancien protocole local', async t => {
  const { startFakeKaraFun, COMMUNITY: FAKE_COMMUNITY, CATALOG: FAKE_CATALOG } = require('../fake-karafun');
  const port = await new Promise(resolve => {
    const probe = require('node:net').createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  const fake = await startFakeKaraFun({ port, autoplay: false });
  const bridge = new KaraFunBridge({ bases: [fake.base] });
  t.after(() => { bridge.disconnect(); fake.close(); });
  assert.equal(FAKE_COMMUNITY[0].songId, FAKE_CATALOG[0].songId, 'numéros qui se recoupent exprès');
  bridge.connect(fake.code);
  for (let i = 0; i < 100 && !bridge.ready; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(bridge.ready, 'pont prêt sur le faux KaraFun');
  assert.equal(bridge.communityChannel(), true, 'faux KaraFun local : canal possible');
  const found = await bridge.search('queen', { community: true });
  assert.deepEqual(found.map(song => [song.title, song.community]), [['Bohemian Rhapsody (version acoustique)', true]]);
  bridge.add(FAKE_COMMUNITY[0].songId, 'Léa · T1', 99999, null, { community: true });
  bridge.add(FAKE_CATALOG[0].songId, 'Tom · T2');
  for (let i = 0; i < 100 && bridge.queue.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(bridge.queue.map(item => [item.title, !!item.community]),
    [['Bohemian Rhapsody (version acoustique)', true], [FAKE_CATALOG[0].title, false]]);
});
