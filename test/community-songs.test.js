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
  assert.deepEqual(refused, [{ songId: 70002, singer: 'Léa · T1', message: 'Permission denied' }]);
  assert.equal(bridge.communitySupport, 'refused');
  assert.equal(bridge.communityUsable(), false);
  assert.equal(bridge.lastError, null);
  assert.match(bridge.communityState().notice, /refuse les titres de la communauté.*Permission denied/);
  // La permission « community » changée dans KaraFun : nouvel essai possible.
  ws.receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: { ...ADMIN, shownTypes: { ...ADMIN.shownTypes, community: true } } } });
  assert.equal(bridge.communitySupport, 'unknown');
  assert.equal(bridge.communityState().permitted, true);
});

test('KCS : file pleine ou réglages refusés ne disent rien de la communauté', async t => {
  const { bridge, ws } = await kcs(t);
  ws.receive({ type: 'remote.ConfigurationUpdateEvent', payload: { configuration: { pitchMin: -6, pitchMax: 6, pitchStep: 1, tempoMin: -50, tempoMax: 50, tempoStep: 5 } } });
  const refused = [], options = [];
  bridge.on('community-add-refused', add => refused.push(add));
  bridge.on('add-options-refused', add => options.push(add));
  bridge.add(70002, 'Léa · T1', 99999, null, { community: true });
  ws.receive({ id: lastAdd(ws).id, type: 'Error', payload: { type: 3, message: 'Queue is full' } });
  assert.equal(bridge.communitySupport, 'unknown');
  assert.equal(bridge.lastError, 'Commande KaraFun refusée : Queue is full');
  // Avec des réglages : c'est d'abord un refus des réglages, le titre repart sans eux.
  assert.deepEqual(bridge.add(70003, 'Zoé · T3', 99999, { pitch: -2 }, { community: true }), { pitch: -2 });
  ws.receive({ id: lastAdd(ws).id, type: 'Error', payload: { type: 3, message: 'Invalid options' } });
  assert.deepEqual(options, [{ songId: 70003, singer: 'Zoé · T3', community: true }]);
  assert.deepEqual(refused, []);
  bridge.add(70003, 'Zoé · T3', 99999, null, { community: true });
  ws.receive({ id: lastAdd(ws).id, type: 'Error', payload: { type: 3, message: 'Not allowed' } });
  assert.equal(refused.length, 1, 'le second envoi, sans réglages, décide');
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

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), '--demo'];
  const context = { require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL,
    setTimeout: () => ({ unref() {} }), clearTimeout() {}, setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, handlers, access, journal, sync, staffState, publicState,
      communityAddRefused, tracked: () => tracked, pending: () => pending, setBridge: b => { bridge = b; },
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
function kcsBridge(f, { echo = false } = {}) {
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
  assert.deepEqual(plain(f.publicState(null, null).community), { enabled: false, off: false, refused: true });
  await rejects(f.call('POST /api/table/song', { ...tom.body, song: { songId: 71000, community: true }, mode: 'append' }),
    'COMMUNITY_REFUSED', /choisis un titre du catalogue/);
  assert.equal(f.staffState().community.support, 'refused');
  // Le bar coupe puis réactive l'interrupteur : nouvel essai.
  await f.call('POST /api/staff/settings', { communitySongs: false });
  await rejects(f.call('POST /api/table/song', { ...tom.body, song: { songId: 71000, community: true }, mode: 'append' }), 'COMMUNITY_OFF');
  await f.call('POST /api/staff/settings', { communitySongs: true });
  assert.equal(bridge.communitySupport, 'unknown');
  await f.call('POST /api/table/song', { ...tom.body, song: { songId: 71000, community: true }, mode: 'append' });
  await rejects(f.call('POST /api/staff/settings', { communitySongs: 'oui' }), null, /oui ou non/);
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
  const port = 4300 + Math.floor(Math.random() * 500);
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
