'use strict';
// Réglages de titre côté serveur : routes des chanteurs et du bar, droits
// (autre téléphone, partenaire de duo, fonction coupée par le bar), envoi
// avec options, titre déjà dans KaraFun, rattrapage au début du titre,
// relance ⏮, réglages en direct et états exposés aux pages.
//
// server.js tourne dans un bac à sable `vm` (--demo, aucun port ouvert). Le
// pont KaraFun est le vrai KaraFunBridge, branché sur un faux canal qui
// garde chaque trame KCS : on vérifie le protocole exact sans KaraFun.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { KaraFunBridge, normalizeKcsItem, BATTLE_MOD } = require('../karafun');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), '--demo'];
  const context = { require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL,
    setTimeout: () => ({ unref() {} }), clearTimeout() {}, setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, handlers, access, journal, sync, staffState, publicState, battleVote, clearEvening,
      resendWithoutOptions,
      tracked: () => tracked, pending: () => pending, setBridge: b => { bridge = b; },
      handle: server.listeners('request')[0], STAFF_KEY, PORT };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  f.settings.pushDelaySec = 0;
  f.journal.start({ rules: {} });
  f.call = async (route, body = {}) => f.handlers[route]({}, {}, body);
  f.events = type => f.journal.current.events.filter(e => e.ev === type).map(plain);
  return f;
}

const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const notes = f => f.sched.log.map(line => line.msg);

// Trames du vrai KaraFun du bar (journal du 2 octobre).
const BAR_CONFIGURATION = { pitchStep: 1, tempoStep: 5, pitchMin: -6, tempoMin: -50, pitchMax: 6, tempoMax: 50,
  compatibleMods: { battle: [1] } };
const ADMIN = { manageQueue: true, viewQueue: true, addToQueue: true, managePlayback: true, manageVolumes: true,
  sendPhotos: true, shownTypes: { karaoke: true, community: false, quiz: false, battle: true } };

// Vrai pont KaraFun, prêt, sur un faux canal KCS.
function kcsBridge(f, { permissions = ADMIN } = {}) {
  const bridge = new KaraFunBridge();
  const sent = [];
  Object.assign(bridge, { protocol: 'kcs', ready: true, connected: true, queue: [], status: { state: 'idle', current: null } });
  bridge.raw.configuration = BAR_CONFIGURATION;
  bridge.raw.permissions = permissions;
  bridge.permissions = { ...permissions, managePlayer: !!permissions.managePlayback };
  bridge.socket = { send(type, payload) { sent.push({ type, payload }); return sent.length; }, close() {}, removeAllListeners() {} };
  f.setBridge(bridge);
  return { bridge, sent };
}

// File KaraFun telle que le pont la normalise.
const kfItem = (queueId, songId, singer, { songTracks = [{ type: 4 }, { type: 5 }], options = {} } = {}) =>
  normalizeKcsItem({ id: queueId, song: { id: { type: 1, id: songId }, title: `Titre ${songId}`, artist: 'Artiste', songTracks,
    options: { singer, ...options } } });
const playing = (item, extra = {}) => ({ state: 'playing', pitch: 0, tempo: 0,
  tracks: (item.songTracks || []).map(type => ({ volume: type === 4 ? 100 : 0, track: { type } })), ...extra, current: item });

function openTable(f, id, headcount = 4) {
  f.sched.table(id).headcount = headcount;
  return { table: id, access: f.access.issue(id) };
}
function singer(f, tb, name, songId) {
  const p = f.sched.join({ tableId: tb.table, name });
  if (songId) f.sched.chooseSong(p, { songId, title: `Titre ${songId}`, artist: 'Artiste' });
  return { person: p, body: { ...tb, personId: p.id, token: p.token } };
}
// Prochain passage envoyé à KaraFun et suivi sous `queueId`.
function sendNext(f, queueId, extra = {}) {
  const sel = f.sched.select();
  f.sched.commit(sel);
  const tr = { queueId, sel, addedAt: Date.now(), startedAt: null, ...extra };
  f.tracked().push(tr);
  return tr;
}
async function rejects(promise, code, message) {
  await assert.rejects(promise, error => {
    if (code) assert.equal(error.code, code, error.message);
    if (message) assert.match(error.message, message);
    return true;
  });
}

// Requête HTTP passée au gestionnaire du serveur (codes de retour réels).
function post(f, url, body) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', url, headers: {}, socket: { remoteAddress: '127.0.0.1', localPort: f.PORT }, destroy() {} });
    const out = { status: null, headers: {} };
    const res = { setHeader(name, value) { out.headers[name.toLowerCase()] = value; }, getHeader() {}, removeHeader() {},
      writeHead(status, headers = {}) { out.status = status; Object.assign(out.headers, headers); },
      end(data = '') { out.body = JSON.parse(String(data)); resolve(out); } };
    f.handle(req, res);
    setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
}

// ---------------------------------------------------------------- chanteurs
test('chanteur : règle son titre prévu ; autre téléphone, partenaire de duo, titre inconnu refusés clairement', async () => {
  const f = harness();
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  const tom = singer(f, tb, 'Tom', 201);
  const entryId = lea.person.song.entryId;
  const answer = await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { pitch: -2, guide: 50 } });
  assert.deepEqual(plain(answer), { ok: true, settings: { pitch: -2, guide: 50 }, applied: 'list' });
  assert.deepEqual(plain(lea.person.song.settings), { pitch: -2, guide: 50 });
  const view = f.publicState(lea.person, '1', new Set([lea.person.id]));
  assert.deepEqual(plain(view.me.songs[0].settings), { pitch: -2, guide: 50 }, 'le téléphone voit ses réglages');
  assert.deepEqual(plain(view.tablePeople.find(p => p.id === lea.person.id).songs[0].settings), { pitch: -2, guide: 50 });
  assert.equal(view.tablePeople.find(p => p.id === tom.person.id).songs[0].settings, null, 'titre sans réglage');
  assert.deepEqual(f.events('song.settings').map(({ personId, entryId: id, by, where, settings }) => ({ personId, id, by, where, settings })),
    [{ personId: lea.person.id, id: entryId, by: 'self', where: 'list', settings: { pitch: -2, guide: 50 } }]);
  // Le téléphone de Tom ne gère pas Léa (vraie requête HTTP : 403).
  const other = await post(f, '/api/table/song/settings', { ...lea.body, token: tom.person.token, entryId, settings: { pitch: 3 } });
  assert.equal(other.status, 403);
  assert.equal(other.body.code, 'PERSON_ACCESS');
  // Le titre d'une autre personne.
  await rejects(f.call('POST /api/table/song/settings', { ...tom.body, entryId, settings: { pitch: 3 } }), 'NOT_OWNER',
    /^Ce titre n’est pas dans ta liste\.$/);
  // Duo : seul l'auteur règle, le partenaire voit les réglages.
  const duo = f.sched.inviteDuet(lea.person, tom.person.id, { songId: 102, title: 'Notre duo', artist: 'Artiste' });
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId: duo.entryId, settings: { tempo: -10 } });
  await rejects(f.call('POST /api/table/song/settings', { ...tom.body, entryId: duo.entryId, settings: { tempo: 10 } }), 'DUO_GUEST',
    /^Léa a choisi ce duo : les réglages se font sur son téléphone\.$/);
  assert.deepEqual(plain(duo.settings), { tempo: -10 });
  const tomView = f.publicState(tom.person, '1', new Set([tom.person.id]));
  assert.deepEqual(plain(tomView.me.guestDuos[0].song.settings), { tempo: -10 }, 'le partenaire voit les réglages');
  // Titre inconnu, réglage invalide, puis remise à zéro.
  await rejects(f.call('POST /api/table/song/settings', { ...lea.body, entryId: 'inconnu', settings: { pitch: 1 } }), 'NO_SONG',
    /^Ce titre n’est plus prévu : il a peut-être déjà été chanté ou retiré\.$/);
  await rejects(f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { pitch: 9 } }), 'SONG_SETTINGS',
    /^La tonalité va de -6 à \+6 demi-tons\.$/);
  assert.deepEqual(plain(lea.person.song.settings), { pitch: -2, guide: 50 }, 'refusé : rien ne change');
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: null });
  assert.equal(Object.hasOwn(lea.person.song, 'settings'), false, 'réinitialisé : réglages de KaraFun');
  assert.equal(f.events('song.settings').at(-1).settings, null);
});

test('bar : interrupteur des réglages pour les téléphones, activé par défaut, enregistré et journalisé', async () => {
  const f = harness();
  assert.equal(f.settings.singerSongSettings, true, 'activé par défaut');
  assert.equal(f.publicState(null, null).songSettings.enabled, true);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  const entryId = lea.person.song.entryId;
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { pitch: 2 } });
  await f.call('POST /api/staff/settings', { singerSongSettings: false });
  assert.equal(f.settings.singerSongSettings, false);
  assert.equal(f.staffState().settings.singerSongSettings, false);
  assert.equal(f.publicState(lea.person, '1').songSettings.enabled, false, 'les téléphones n’affichent plus le bouton');
  assert.deepEqual(f.events('settings.changed').map(e => [e.setting, e.from, e.to]), [['singerSongSettings', true, false]]);
  await rejects(f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { pitch: 3 } }), 'SONG_SETTINGS_OFF',
    /^Le bar a désactivé les réglages de titre depuis les téléphones\.$/);
  assert.deepEqual(plain(lea.person.song.settings), { pitch: 2 }, 'les réglages déjà faits restent appliqués');
  // Le bar règle toujours.
  await f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId, settings: { pitch: 4 } });
  assert.deepEqual(plain(lea.person.song.settings), { pitch: 4 });
  assert.equal(f.events('song.settings').at(-1).by, 'staff');
  // Une autre requête de réglages ne touche pas à l'interrupteur.
  await f.call('POST /api/staff/settings', { pushDelaySec: 30 });
  assert.equal(f.settings.singerSongSettings, false);
  await f.call('POST /api/staff/settings', { singerSongSettings: true });
  assert.equal(f.settings.singerSongSettings, true);
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { pitch: 3 } });
  assert.deepEqual(plain(lea.person.song.settings), { pitch: 3 });
  // Une nouvelle soirée garde le choix du bar, comme les autres réglages.
  await f.call('POST /api/staff/settings', { singerSongSettings: false });
  f.clearEvening();
  assert.equal(f.settings.singerSongSettings, false);
  await rejects(f.call('POST /api/staff/settings', { singerSongSettings: 'non' }), null,
    /^Le réglage des titres depuis les téléphones est activé ou désactivé \(oui ou non\)\.$/);
  assert.equal(f.settings.singerSongSettings, false);
});

// ---------------------------------------------------------------- envoi à KaraFun
test('envoi : le titre part avec ses réglages dans AddToQueueRequest ; duo : la voix guide B suit la voix A', async () => {
  const f = harness();
  const { sent } = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  const tom = singer(f, tb, 'Tom');
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId: lea.person.song.entryId,
    settings: { pitch: -2, tempo: -10, guide: 30 } });
  f.settings.auto = true;
  f.sync();
  const label = f.pending().sel.label;
  assert.deepEqual(sent, [{ type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 101 },
    options: { singer: label, pitch: -2, tempo: -10, tracks: [{ track: { type: 5 }, volume: 30 }] }, position: 99999 } }]);
  assert.deepEqual(plain(f.pending().sentSettings), { pitch: -2, tempo: -10, guide: 30 });
  // Accusé de KaraFun : le titre suivi garde ce qui a été envoyé.
  f.settings.auto = false;
  const bridge = kcsBridge(f);
  bridge.bridge.queue = [kfItem('q-1', 101, label, { options: { pitch: -2, tempo: -10, tracks: [{ track: { type: 5 }, volume: 30 }] } })];
  f.sync();
  assert.equal(f.tracked()[0].queueId, 'q-1');
  assert.deepEqual(plain(f.tracked()[0].sentSettings), { pitch: -2, tempo: -10, guide: 30 });
  assert.deepEqual(bridge.sent, [], 'réglages déjà envoyés à l’ajout : rien d’autre');

  // Duo : guide A et guide B ensemble.
  const g = harness();
  const duoBridge = kcsBridge(g);
  const tb2 = openTable(g, '1');
  const ana = singer(g, tb2, 'Ana');
  const ben = singer(g, tb2, 'Ben');
  const duo = g.sched.inviteDuet(ana.person, ben.person.id, { songId: 300, title: 'Duo', artist: 'Artiste' });
  await g.call('POST /api/table/song/settings', { ...ana.body, entryId: duo.entryId, settings: { guide: 50 } });
  g.settings.auto = true;
  g.sync();
  assert.deepEqual(duoBridge.sent[0].payload.options.tracks, [{ track: { type: 5 }, volume: 50 }, { track: { type: 6 }, volume: 50 }]);
  assert.ok(tom.person && ben.person);
});

test('titre en cours d’envoi : réglage gardé, appliqué dès l’accusé avec le même chanteur, une seule fois', async () => {
  const f = harness();
  let link = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  const entryId = lea.person.song.entryId;
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { pitch: -2, tempo: -10, guide: 30 } });
  f.settings.auto = true;
  f.sync();
  f.settings.auto = false;
  const label = f.pending().sel.label;
  const answer = await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { pitch: 1 } });
  assert.equal(answer.applied, 'sending');
  assert.equal(f.publicState(lea.person, '1', new Set([lea.person.id])).me.inKaraFun[0].canAdjust, true);
  assert.deepEqual(plain(f.pending().sel.song.settings), { pitch: 1 });
  assert.equal(link.sent.length, 1, 'rien d’autre avant l’accusé');
  link = kcsBridge(f);
  link.bridge.queue = [kfItem('q-1', 101, label, { options: { pitch: -2, tempo: -10, tracks: [{ track: { type: 5 }, volume: 30 }] } })];
  f.sync();
  assert.deepEqual(link.sent, [{ type: 'remote.SetQueueItemOptionsRequest', payload: { queueItemId: 'q-1',
    options: { singer: label, pitch: 1, tempo: 0, tracks: [{ track: { type: 5 }, volume: 0 }] } } }],
  'même nom affiché, ce qui avait été envoyé revient par défaut');
  f.sync();
  f.sync();
  assert.equal(link.sent.length, 1, 'une seule fois');
  assert.deepEqual(plain(f.tracked()[0].sentSettings), { pitch: 1, tempo: 0, guide: 0 });
  // Accusé après une reprise (titre de l'envoi copié sur disque, distinct de la liste).
  assert.equal(f.events('song.settings').at(-1).where, 'sending');
});

test('titre déjà dans KaraFun : réglé par le bar ou son chanteur, avec le nom affiché et le mode gardés', async () => {
  const f = harness();
  const link = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  const tr = sendNext(f, 'q-7');
  // KaraFun affiche un autre nom (corrigé par un duo improvisé par exemple) : c'est celui-là qu'on renvoie.
  link.bridge.queue = [kfItem('q-7', 101, 'Léa · Table 1 (KaraFun)', { songTracks: [{ type: 5 }], options: { mod: BATTLE_MOD } })];
  const answer = await f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId: tr.sel.song.entryId,
    settings: { tempo: 5, backing: 50 } });
  assert.deepEqual(plain(answer), { ok: true, settings: { tempo: 5, backing: 50 }, applied: 'karafun' });
  assert.deepEqual(link.sent, [{ type: 'remote.SetQueueItemOptionsRequest', payload: { queueItemId: 'q-7',
    options: { singer: 'Léa · Table 1 (KaraFun)', pitch: 0, tempo: 5, mod: BATTLE_MOD } } }],
  'pas de chœurs sur ce titre : aucun volume de chœurs');
  assert.deepEqual(plain(tr.sel.song.settings), { tempo: 5, backing: 50 });
  // Le chanteur aussi, tant que le titre n'a pas commencé.
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId: tr.sel.song.entryId, settings: { pitch: -1 } });
  assert.equal(link.sent.length, 2);
  assert.deepEqual(link.sent[1].payload.options, { singer: 'Léa · Table 1 (KaraFun)', pitch: -1, tempo: 0, mod: BATTLE_MOD });
  // KaraFun déconnecté : réglage gardé, envoyé au retour de la connexion.
  link.bridge.ready = false;
  const offline = await f.call('POST /api/table/song/settings', { ...lea.body, entryId: tr.sel.song.entryId, settings: { pitch: -3 } });
  assert.equal(offline.applied, 'start');
  assert.equal(link.sent.length, 2);
  link.bridge.ready = true;
  f.sync();
  assert.equal(link.sent.length, 3, 'envoyé dès le retour de KaraFun');
  assert.equal(link.sent[2].payload.options.pitch, -3);
  f.sync();
  assert.equal(link.sent.length, 3);
  // Droit « Éditer la file d'attente » refusé : appliqué au début du titre.
  link.bridge.permissions.manageQueue = false;
  const refused = await f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId: tr.sel.song.entryId, settings: { pitch: 2 } });
  assert.equal(refused.applied, 'start');
  f.sync();
  assert.equal(link.sent.length, 3, 'pas de nouvel essai à chaque passage');
  // Envoi impossible (ancienne télécommande d'un vrai KaraFun) : noté, rattrapé au début du titre.
  link.bridge.permissions.manageQueue = true;
  link.bridge.protocol = 'socket.io';
  const legacy = await f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId: tr.sel.song.entryId, settings: { pitch: 1 } });
  assert.equal(legacy.applied, 'start');
  assert.equal(tr.settingsDirty, false, 'pas de nouvel essai en boucle');
  link.bridge.protocol = 'kcs';
  assert.equal(link.sent.length, 3);
  // Titre en train de sortir de KaraFun.
  tr.pulled = { reason: 'defer', at: Date.now() };
  await rejects(f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId: tr.sel.song.entryId, settings: { pitch: 1 } }),
    null, /en train de sortir de KaraFun/);
  // Le bar doit viser la bonne personne.
  tr.pulled = null;
  const tom = singer(f, tb, 'Tom', 201);
  await rejects(f.call('POST /api/staff/song/settings', { personId: tom.person.id, entryId: tr.sel.song.entryId, settings: { pitch: 1 } }),
    'NOT_OWNER', /^Ce titre n’est pas celui de Tom\.$/);
});

// ---------------------------------------------------------------- titre en cours
test('titre commencé : plus de réglage depuis le téléphone, le bar le règle en direct', async () => {
  const f = harness();
  const link = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  const tom = singer(f, tb, 'Tom');
  const duo = f.sched.inviteDuet(lea.person, tom.person.id, { songId: 102, title: 'Duo', artist: 'Artiste' });
  f.sched.removeSong(lea.person, lea.person.song.entryId);
  assert.equal(lea.person.song.entryId, duo.entryId);
  const tr = sendNext(f, 'q-9', { startedAt: Date.now() });
  const item = kfItem('q-9', 102, tr.sel.label, { songTracks: [{ type: 4 }, { type: 5 }, { type: 6 }] });
  link.bridge.queue = [item];
  link.bridge.status = playing(item);
  tr.liveChecked = 'q-9';
  await rejects(f.call('POST /api/table/song/settings', { ...lea.body, entryId: duo.entryId, settings: { pitch: 1 } }), 'SONG_STARTED',
    /^Ce titre a déjà commencé : seul le bar peut encore le régler\.$/);
  await rejects(f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId: duo.entryId, settings: { pitch: 1 } }),
    'SONG_STARTED', /^Ce titre est sur scène : règle-le en direct\.$/);
  // Réglages en direct du bar.
  assert.deepEqual(plain(await f.call('POST /api/staff/kf', { action: 'pitch', value: -1 })), { ok: true, field: 'pitch', value: -1 });
  await f.call('POST /api/staff/kf', { action: 'tempo', value: 10 });
  await f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 25 });
  await f.call('POST /api/staff/kf', { action: 'track', track: 'backing', value: 0 });
  assert.deepEqual(link.sent, [
    { type: 'remote.PitchRequest', payload: { pitch: -1 } },
    { type: 'remote.TempoRequest', payload: { tempo: 10 } },
    { type: 'remote.TrackVolumeRequest', payload: { type: 5, volume: 25 } },
    { type: 'remote.TrackVolumeRequest', payload: { type: 6, volume: 25 } },
    { type: 'remote.TrackVolumeRequest', payload: { type: 4, volume: 0 } },
  ], 'duo à deux voix : guide B avec guide A');
  assert.deepEqual(plain(tr.sel.song.settings), { pitch: -1, tempo: 10, guide: 25, backing: 0 }, 'gardés pour une relance');
  await f.call('POST /api/staff/kf', { action: 'pitch', value: 0 });
  assert.deepEqual(plain(tr.sel.song.settings), { tempo: 10, guide: 25, backing: 0 });
  await f.call('POST /api/staff/kf', { action: 'track', track: 'backing', value: 100 });
  assert.deepEqual(plain(tr.sel.song.settings), { tempo: 10, guide: 25, backing: 100 }, 'volume choisi gardé, même à 100');
  await f.call('POST /api/staff/kf', { action: 'pitch', value: 0 });
  assert.deepEqual(f.events('song.settings').at(-1), { ...f.events('song.settings').at(-1), by: 'staff', where: 'live',
    personId: lea.person.id, entryId: duo.entryId, field: 'pitch', value: 0 });
  await rejects(f.call('POST /api/staff/kf', { action: 'tempo', value: 7 }), 'SONG_SETTINGS', /par pas de 5/);
  await rejects(f.call('POST /api/staff/kf', { action: 'track', track: 'basse', value: 7 }), null, /^Piste vocale inconnue\.$/);
  // Titre sans chœurs.
  const solo = kfItem('n-1', 555, 'Quelqu’un', { songTracks: [{ type: 5 }] });
  link.bridge.queue = [solo];
  link.bridge.status = playing(solo);
  await rejects(f.call('POST /api/staff/kf', { action: 'track', track: 'backing', value: 50 }), null, /^Ce titre n’a pas de chœurs\.$/);
  await f.call('POST /api/staff/kf', { action: 'pitch', value: 2 });
  assert.deepEqual(link.sent.at(-1), { type: 'remote.PitchRequest', payload: { pitch: 2 } }, 'titre ajouté dans KaraFun : réglé aussi');
  // Droit refusé, rien en cours, KaraFun déconnecté.
  link.bridge.permissions.manageVolumes = false;
  await rejects(f.call('POST /api/staff/kf', { action: 'pitch', value: 1 }), null, /Personnaliser la chanson en cours/);
  link.bridge.permissions.manageVolumes = true;
  link.bridge.status = { state: 'idle', current: null };
  await rejects(f.call('POST /api/staff/kf', { action: 'tempo', value: 5 }), null, /^Aucun titre en cours à régler\.$/);
  link.bridge.ready = false;
  await rejects(f.call('POST /api/staff/kf', { action: 'tempo', value: 5 }), null, /^KaraFun est déconnecté/);
});

test('début d’un titre suivi : réglages ignorés par KaraFun rattrapés une seule fois', async () => {
  const f = harness();
  const link = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  f.sched.setSongSettings(lea.person.song, { pitch: -2, guide: 40, backing: 0 });
  const tr = sendNext(f, 'q-1', { sentSettings: { pitch: -2, guide: 40, backing: 0 } });
  assert.equal(tr.sel.ids[0], lea.person.id);
  const item = kfItem('q-1', 101, tr.sel.label, { songTracks: [{ type: 5 }] });
  link.bridge.queue = [item];
  // KaraFun charge le titre (états 2 puis 3) : rattrapé avant que la musique démarre.
  link.bridge.status = { ...playing(item), state: 'loading' };
  f.sync();
  assert.equal(tr.startedAt, null, 'pas encore sur scène');
  link.bridge.status = playing(item);
  f.sync();
  assert.deepEqual(link.sent, [
    { type: 'remote.PitchRequest', payload: { pitch: -2 } },
    { type: 'remote.TrackVolumeRequest', payload: { type: 5, volume: 40 } },
  ], 'seulement ce qui diffère, seulement les pistes du titre (pas de chœurs ici)');
  f.sync();
  f.sync();
  assert.equal(link.sent.length, 2, 'une seule fois');
  assert.deepEqual(f.events('song.settingsCaughtUp').map(e => [e.queueId, e.fields]), [['q-1', ['pitch', 'guide']]]);
  assert.ok(tr.startedAt);

  // Commande impossible (ancienne télécommande d'un vrai KaraFun) : notée, la file continue.
  const g = harness();
  const legacy = kcsBridge(g);
  const tb2 = openTable(g, '1');
  const ana = singer(g, tb2, 'Ana', 301);
  g.sched.setSongSettings(ana.person.song, { tempo: 10 });
  const trAna = sendNext(g, 'q-5');
  const anaItem = kfItem('q-5', 301, trAna.sel.label);
  legacy.bridge.protocol = 'socket.io';
  legacy.bridge.queue = [anaItem];
  legacy.bridge.status = playing(anaItem);
  g.sync();
  assert.deepEqual(legacy.sent, []);
  assert.equal(trAna.liveChecked, 'q-5', 'pas de nouvel essai à chaque passage');
  assert.deepEqual(g.events('song.settingsCaughtUp'), [], 'rien n’a été rattrapé');
});

test('début d’un titre suivi : rien si KaraFun a déjà appliqué, avis si le droit manque', async () => {
  const f = harness();
  const link = kcsBridge(f, { permissions: { ...ADMIN, manageVolumes: false } });
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  const tom = singer(f, tb, 'Tom', 201);
  f.sched.setSongSettings(lea.person.song, { pitch: -2 });
  f.sched.setSongSettings(tom.person.song, { tempo: 5 });
  const first = sendNext(f, 'q-1');
  const second = sendNext(f, 'q-2');
  const one = kfItem('q-1', first.sel.song.songId, first.sel.label);
  const two = kfItem('q-2', second.sel.song.songId, second.sel.label);
  link.bridge.queue = [one, two];
  link.bridge.status = playing(one, { pitch: first.sel.song.settings.pitch ?? 0, tempo: first.sel.song.settings.tempo ?? 0 });
  f.sync();
  assert.deepEqual(link.sent, [], 'KaraFun a appliqué les options d’ajout');
  link.bridge.queue = [two];
  link.bridge.status = playing(two);
  f.sync();
  assert.deepEqual(link.sent, [], 'droit « Personnaliser la chanson en cours » refusé : rien n’est envoyé');
  const warned = () => notes(f).filter(line => line.startsWith('KaraFun n’a pas appliqué'));
  assert.deepEqual(warned(), [`KaraFun n’a pas appliqué les réglages de « ${second.sel.song.title} » et ne laisse pas ${link.bridge.username} personnaliser la chanson en cours : règle-la dans KaraFun.`]);
  f.sync();
  assert.equal(warned().length, 1, 'avis donné une fois');
});

test('relance ⏮ : la copie repart avec les mêmes réglages, rattrapés à son début si besoin', async () => {
  const f = harness();
  const link = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  f.sched.setSongSettings(lea.person.song, { pitch: -2, guide: 30 });
  const tr = sendNext(f, 'q-1', { startedAt: Date.now(), liveChecked: 'q-1' });
  const item = kfItem('q-1', 101, tr.sel.label);
  link.bridge.queue = [item];
  link.bridge.status = playing(item, { pitch: -2, tracks: [{ volume: 30, track: { type: 5 } }] });
  f.sync();
  await f.call('POST /api/staff/kf', { action: 'restart' });
  assert.deepEqual(link.sent.at(-1), { type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 101 },
    options: { singer: tr.sel.label, pitch: -2, tracks: [{ track: { type: 5 }, volume: 30 }] }, position: 1 } });
  // La copie arrive juste après le titre en cours, puis « Suivant » la lance.
  const copy = kfItem('q-2', 101, tr.sel.label);
  link.bridge.queue = [item, copy];
  f.sync();
  assert.equal(tr.queueId, 'q-2');
  assert.deepEqual(plain(tr.sentSettings), { pitch: -2, guide: 30 });
  const before = link.sent.length;
  link.bridge.queue = [copy];
  link.bridge.status = playing(copy);
  f.sync();
  assert.deepEqual(link.sent.slice(before).filter(m => m.type !== 'remote.NextRequest'), [
    { type: 'remote.PitchRequest', payload: { pitch: -2 } },
    { type: 'remote.TrackVolumeRequest', payload: { type: 5, volume: 30 } },
  ], 'la copie est un nouvel élément de KaraFun : rattrapage refait une fois');

  // Titre ajouté directement dans KaraFun : la copie reprend l'état en direct.
  const g = harness();
  const native = kcsBridge(g);
  const own = kfItem('n-1', 777, 'Quelqu’un');
  native.bridge.queue = [own];
  native.bridge.status = playing(own, { pitch: -1, tempo: 0 });
  g.sync();
  await g.call('POST /api/staff/kf', { action: 'restart' });
  assert.deepEqual(native.sent.at(-1).payload.options, { singer: 'Quelqu’un', pitch: -1 });
});

// ---------------------------------------------------------------- le réglage suit le titre
test('le réglage suit le titre : « Pas prêt », absent rendu au chanteur, duo improvisé', async () => {
  const f = harness();
  const link = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  const tom = singer(f, tb, 'Tom');
  f.sched.setSongSettings(lea.person.song, { pitch: -2 });
  const tr = sendNext(f, 'q-1');
  assert.equal(tr.sel.ids[0], lea.person.id);
  link.bridge.queue = [kfItem('q-1', 101, tr.sel.label)];
  // « Pas prêt » : KaraFun retire le titre, il revient dans la liste de Léa avec ses réglages.
  await f.call('POST /api/table/defer', { ...lea.body });
  assert.ok(link.sent.some(m => m.type === 'remote.RemoveFromQueueRequest'));
  link.bridge.queue = [];
  f.sync();
  assert.equal(lea.person.song.entryId, tr.sel.song.entryId);
  assert.deepEqual(plain(lea.person.song.settings), { pitch: -2 });
  // Absent à l'appel : le titre lui revient avec ses réglages.
  f.sched.chooseSong(tom.person, { songId: 201, title: 'Titre 201', artist: 'Artiste' });
  f.sched.setSongSettings(tom.person.song, { tempo: 5 });
  const trTom = sendNext(f, 'q-2');
  assert.equal(trTom.sel.ids[0], tom.person.id);
  link.bridge.queue = [kfItem('q-2', 201, trTom.sel.label)];
  await f.call('POST /api/staff/kf', { action: 'absent', queueId: 'q-2' });
  link.bridge.queue = [];
  f.sync();
  assert.deepEqual(plain(tom.person.song.settings), { tempo: 5 });
});

test('états exposés aux pages : plages, droits, capacité, état en direct, réglages des titres', async () => {
  const f = harness();
  let state = f.staffState();
  assert.deepEqual(plain(state.songSettings), { enabled: true, ranges: { pitch: { min: -6, max: 6, step: 1 },
    tempo: { min: -50, max: 50, step: 5 }, volume: { min: 0, max: 100, step: 25 } }, defaults: { pitch: 0, tempo: 0, guide: 0, backing: 100 },
  permissions: { manageVolumes: null, manageQueue: null },
  support: { pitch: 'unknown', tempo: 'unknown', trackVolume: 'unknown', queueItemOptions: 'unknown', addOptions: 'unknown' },
  notices: {}, notice: null, available: null, live: null },
  'KaraFun pas connecté : plages de repli');
  const link = kcsBridge(f);
  link.bridge.raw.configuration = { ...BAR_CONFIGURATION, pitchMin: -5, pitchMax: 5 };
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  const tom = singer(f, tb, 'Tom');
  f.sched.setSongSettings(lea.person.song, { pitch: -2 });
  const tr = sendNext(f, 'q-1', { startedAt: Date.now(), liveChecked: 'q-1' });
  f.sched.chooseSong(tom.person, { songId: 201, title: 'Titre 201', artist: 'Artiste' });
  const trTom = sendNext(f, 'q-2');
  assert.equal(trTom.sel.ids[0], tom.person.id);
  f.sched.setSongSettings(trTom.sel.song, { guide: 75 });
  const item = kfItem('q-1', 101, tr.sel.label, { songTracks: [{ type: 5 }] });
  link.bridge.queue = [item, kfItem('q-2', 201, trTom.sel.label, { songTracks: [{ type: 4 }, { type: 5 }, { type: 6 }] }),
    kfItem('n-3', 999, 'Ajout du bar')];
  link.bridge.status = playing(item, { pitch: -2 });
  f.sync();
  state = f.staffState();
  assert.deepEqual(plain(state.songSettings.ranges.pitch), { min: -5, max: 5, step: 1 });
  assert.deepEqual(plain(state.songSettings.permissions), { manageVolumes: true, manageQueue: true });
  assert.equal(state.songSettings.available, true);
  // Un avis par fonction de KaraFun, et le dernier.
  link.bridge.settingsSupport = { ...link.bridge.settingsSupport, pitch: 'refused', queueItemOptions: 'silent' };
  link.bridge.settingsNotices = { pitch: 'Avis tonalité', queueItemOptions: 'Avis file' };
  assert.deepEqual(plain(f.staffState().songSettings.notices), { pitch: 'Avis tonalité', queueItemOptions: 'Avis file' });
  assert.equal(f.staffState().songSettings.notice, 'Avis file');
  link.bridge.settingsSupport = { ...link.bridge.settingsSupport, pitch: 'unknown', queueItemOptions: 'unknown' };
  link.bridge.settingsNotices = {};
  assert.deepEqual(plain(state.songSettings.live), { queueId: 'q-1', pitch: -2, tempo: 0, guide: 0, guideB: null, backing: null,
    tracks: [5], entryId: tr.sel.song.entryId, title: 'Titre 101', settings: { pitch: -2 } });
  assert.deepEqual(plain(state.queue.map(line => [line.queueId, line.song?.settings ?? null, line.tracks])),
    [['q-2', { guide: 75 }, [4, 5, 6]], ['n-3', null, [4, 5]]]);
  // Téléphone de Tom : son titre déjà dans KaraFun, réglable tant qu'il n'a pas commencé.
  const view = f.publicState(tom.person, '1', new Set([tom.person.id]));
  assert.deepEqual(plain(view.songSettings), { enabled: true, ranges: plain(state.songSettings.ranges),
    defaults: { pitch: 0, tempo: 0, guide: 0, backing: 100 } });
  assert.deepEqual(plain(view.me.inKaraFun.map(row => [row.queueId, row.settings, row.tracks, row.canAdjust])),
    [['q-2', { guide: 75 }, [4, 5, 6], true]]);
  const leaRow = f.publicState(lea.person, '1', new Set([lea.person.id])).me.inKaraFun[0];
  assert.equal(leaRow.canAdjust, false, 'sur scène : plus réglable depuis le téléphone');
  assert.deepEqual(plain(leaRow.settings), { pitch: -2 });
  // Valeurs par défaut relevées sur le KaraFun du bar : les pages les affichent.
  link.bridge.observedDefaults = { guide: 0, backing: 53 };
  assert.deepEqual(plain(f.publicState(null, null).songSettings.defaults), { pitch: 0, tempo: 0, guide: 0, backing: 53 });
});

test('titre en cours d’envoi vu par le téléphone : réglages et droit de les changer', async () => {
  const f = harness();
  kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  f.sched.setSongSettings(lea.person.song, { tempo: -5 });
  f.settings.auto = true;
  f.sync();
  const row = f.publicState(lea.person, '1', new Set([lea.person.id])).me.inKaraFun[0];
  assert.equal(row.sending, true);
  assert.deepEqual(plain(row.settings), { tempo: -5 });
  assert.equal(row.canAdjust, true);
  assert.equal(row.entryId, lea.person.song.entryId);
});

test('KaraFun refuse les réglages à l’ajout : le titre repart aussitôt sans eux, rattrapés à son début', async () => {
  const f = harness();
  const link = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  f.sched.setSongSettings(lea.person.song, { pitch: -2 });
  f.settings.auto = true;
  f.sync();
  f.settings.auto = false;
  const label = f.pending().sel.label;
  assert.deepEqual(link.sent[0].payload.options, { singer: label, pitch: -2 });
  // Le pont a reçu une Error à cet ajout : il n'envoie plus de réglages à l'ajout.
  link.bridge.settingsSupport.addOptions = 'refused';
  f.resendWithoutOptions({ songId: 999, singer: label });
  assert.equal(link.sent.length, 1, 'autre titre : rien');
  f.resendWithoutOptions({ songId: 101, singer: label });
  assert.deepEqual(link.sent[1], { type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 101 },
    options: { singer: label }, position: 99999 } });
  assert.equal(f.pending().sentSettings, undefined);
  assert.equal(f.pending().attempts, 2);
  assert.match(notes(f).at(-1), /^KaraFun refuse les réglages de titre à l’ajout : « Titre 101 » repart sans eux ; ils seront appliqués au début du titre\.$/);
  f.resendWithoutOptions({ songId: 101, singer: label });
  assert.equal(link.sent.length, 2, 'renvoyé une seule fois');
  // Accusé puis début du titre : le réglage est rattrapé en direct.
  link.bridge.queue = [kfItem('q-1', 101, label)];
  f.sync();
  link.bridge.status = playing(link.bridge.queue[0]);
  f.sync();
  assert.deepEqual(link.sent.at(-1), { type: 'remote.PitchRequest', payload: { pitch: -2 } });

  // Relance ⏮ refusée pour la même raison : la copie repart sans réglages, en position 1.
  link.bridge.settingsSupport.addOptions = 'unknown';
  const tr = f.tracked()[0];
  await f.call('POST /api/staff/kf', { action: 'restart' });
  assert.deepEqual(link.sent.at(-1).payload.options, { singer: label, pitch: -2 });
  link.bridge.settingsSupport.addOptions = 'refused';
  f.resendWithoutOptions({ songId: 101, singer: label });
  assert.deepEqual(link.sent.at(-1).payload, { song: { type: 1, id: 101 }, options: { singer: label }, position: 1 });
  f.resendWithoutOptions({ songId: 101, singer: label });
  assert.equal(link.sent.filter(m => m.type === 'remote.AddToQueueRequest').length, 4, 'copie renvoyée une seule fois');
  assert.ok(tr);

  // Connexion perdue au moment du nouvel envoi : rien n'est cassé, l'envoi reste à vérifier comme avant.
  const g = harness();
  const lost = kcsBridge(g);
  const ana = singer(g, openTable(g, '1'), 'Ana', 301);
  g.sched.setSongSettings(ana.person.song, { tempo: 5 });
  g.settings.auto = true;
  g.sync();
  g.settings.auto = false;
  lost.bridge.settingsSupport.addOptions = 'refused';
  lost.bridge.connected = false;
  g.resendWithoutOptions({ songId: 301, singer: g.pending().sel.label });
  assert.equal(lost.sent.length, 1);
  assert.equal(g.pending().attempts, 2, 'tentative comptée');
  // KaraFun déconnecté : rien n'est tenté.
  lost.bridge.ready = false;
  g.resendWithoutOptions({ songId: 301, singer: g.pending().sel.label });
  assert.equal(g.pending().attempts, 2);
});

test('titre chargé dans KaraFun puis réglé de nouveau : rattrapage refait avec les nouveaux réglages', async () => {
  const f = harness();
  const link = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  f.sched.setSongSettings(lea.person.song, { pitch: -2 });
  const tr = sendNext(f, 'q-1', { sentSettings: { pitch: -2 } });
  const item = kfItem('q-1', 101, tr.sel.label, { songTracks: [{ type: 5 }] });
  link.bridge.queue = [item];
  // État 3 du KCS (titre chargé, prêt) : normalisé 'idle', comme l'état 1.
  link.bridge.status = { ...playing(item), state: 'idle', kcsState: 3, pitch: -2 };
  f.sync();
  assert.deepEqual(link.sent, [], 'KaraFun a déjà appliqué');
  // Le chanteur change d'avis avant la lecture : options du titre, puis attente d'un état de KaraFun.
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId: tr.sel.song.entryId, settings: { pitch: 1 } });
  assert.equal(link.sent.at(-1).type, 'remote.SetQueueItemOptionsRequest');
  f.sync();
  assert.equal(link.sent.length, 1, 'rien en direct sur l’état d’avant la demande');
  // Nouvel état, toujours à -2 : KaraFun ignore les options du titre chargé.
  link.bridge.status = { ...playing(item), state: 'idle', kcsState: 3, pitch: -2 };
  f.sync();
  assert.deepEqual(link.sent.at(-1), { type: 'remote.PitchRequest', payload: { pitch: 1 } });
  f.sync();
  assert.equal(link.sent.length, 2, 'une seule fois');
  // État 1 (titre suivant annoncé, pas chargé) : jamais comparé.
  const g = harness();
  const other = kcsBridge(g);
  const ana = singer(g, openTable(g, '1'), 'Ana', 301);
  g.sched.setSongSettings(ana.person.song, { tempo: 5 });
  const trAna = sendNext(g, 'q-5');
  const anaItem = kfItem('q-5', 301, trAna.sel.label);
  other.bridge.queue = [anaItem];
  other.bridge.status = { state: 'idle', kcsState: 1, pitch: 0, tempo: 0, tracks: [], current: anaItem };
  g.sync();
  other.bridge.status = { ...playing(anaItem), state: 'idle', kcsState: 1 };
  g.sync();
  assert.deepEqual(other.sent, []);
  assert.equal(trAna.liveChecked, undefined);
  // Titre chargé mais pistes encore vides : pas encore comparé non plus.
  other.bridge.status = { state: 'idle', kcsState: 3, pitch: 0, tempo: 0, tracks: [], current: anaItem };
  g.sync();
  assert.deepEqual(other.sent, []);
  other.bridge.status = { ...playing(anaItem), state: 'loading', kcsState: 2 };
  g.sync();
  assert.deepEqual(other.sent, [], 'état 2 : KaraFun charge encore le titre');
  other.bridge.status = { ...playing(anaItem), state: 'idle', kcsState: 3 };
  g.sync();
  assert.deepEqual(other.sent, [{ type: 'remote.TempoRequest', payload: { tempo: 5 } }]);
});

// ---------------------------------------------------------------- séquence réelle du KaraFun du bar
// Le vrai pont KaraFun, sur un faux WebSocket, reçoit les trames du KaraFun
// du bar (journal du 2 octobre, titre « DJ ») : accusé d'ajout, état 1 (le
// titre est annoncé mais pas chargé : pistes vides), file, état 2
// (chargement), état 3 (prêt, attente de « Lecture », 20 s à 3 min au bar)
// puis état 4 (lecture). Le serveur synchronise après les trames reçues,
// comme avec bridge.on('change').
class FakeWS {
  static OPEN = 1;
  constructor() { this.readyState = 1; this.listeners = {}; this.out = []; FakeWS.last = this; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  send(text) { this.out.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
  emit(type, data = {}) { for (const fn of this.listeners[type] || []) fn(data); }
}
function replayBridge(t, f, { permissions = ADMIN } = {}) {
  const saved = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  const bridge = new KaraFunBridge();
  t.after(() => { bridge.disconnect(); globalThis.WebSocket = saved; });
  f.setBridge(bridge);
  bridge._openKcs('wss://kcs.exemple.invalid/remote', () => true);
  const ws = FakeWS.last;
  const receive = message => ws.emit('message', { data: JSON.stringify(message) });
  ws.emit('open');
  receive({ type: 'core.AuthenticatedEvent', payload: {} });
  receive({ type: 'remote.UsernameUpdateEvent', payload: { username: bridge.username } });
  receive({ type: 'remote.ConfigurationUpdateEvent', payload: { configuration: BAR_CONFIGURATION } });
  receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions } });
  receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  receive({ type: 'remote.StatusEvent', payload: { status: { state: 1, pitch: 0, tempo: 0, tracks: [], current: null } } });
  ws.out.length = 0;
  // Trames reçues, puis une synchronisation : rend les demandes parties ensuite.
  const frames = (...messages) => {
    for (const message of messages) receive(message);
    f.sync();
    return ws.out.splice(0).filter(m => !m.type.startsWith('core.'));
  };
  return { bridge, ws, frames };
}
const bare = messages => messages.map(({ type, payload }) => ({ type, payload }));
const DJ_ID = 'a0c6bc1b-7a57-4537-846b-d4ded79e830c';
const djItem = options => ({ id: DJ_ID, song: { id: { type: 1, id: 12458 }, artist: 'Diam’s',
  songTracks: [{ type: 4 }, { type: 5 }], title: 'DJ', options } });
// Valeurs par défaut du KaraFun du bar : chœurs à 53, voix guide coupée.
const statusEvent = (state, current, { pitch = 0, tempo = 0, backing = 53, guide = 0 } = {}) => ({ type: 'remote.StatusEvent',
  payload: { status: { state, pitch, tempo, current,
    tracks: state === 1 ? [] : [{ volume: backing, track: { type: 4 } }, { volume: guide, track: { type: 5 } }] } } });
const queueEvent = (...items) => ({ type: 'remote.QueueEvent', payload: { queue: { items } } });
const caughtUpNotes = f => notes(f).filter(line => line.startsWith('KaraFun n’a pas appliqué'));

test('séquence réelle du bar : réglages comparés au titre chargé (état 3), jamais à l’état 1 qui l’annonce', async t => {
  for (const applied of [true, false]) {
    const f = harness();
    const { frames } = replayBridge(t, f);
    const so = singer(f, openTable(f, '1'), 'Soraya', 12458);
    await f.call('POST /api/table/song/settings', { ...so.body, entryId: so.person.song.entryId,
      settings: { pitch: -2, guide: 40, backing: 0 } });
    f.settings.auto = true;
    const [add] = frames();
    f.settings.auto = false;
    const label = f.pending().sel.label;
    assert.deepEqual(add.payload.options, { singer: label, pitch: -2,
      tracks: [{ track: { type: 4 }, volume: 0 }, { track: { type: 5 }, volume: 40 }] });
    // KaraFun garde les options d'ajout sur son titre ; il les applique (ou non) au chargement.
    const item = djItem(add.payload.options);
    const live = applied ? { pitch: -2, backing: 0, guide: 40 } : {};
    const steps = [
      ['accusé', frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} })],
      ['état 1', frames(statusEvent(1, item))],
      ['file', frames(queueEvent(item))],
      ['état 2', frames(statusEvent(2, item, live))],
      ['état 3', frames(statusEvent(3, item, live))],
      ['état 4', frames(statusEvent(4, item, live))],
    ].map(([step, out]) => [step, bare(out)]);
    const expected = applied ? [] : [
      { type: 'remote.PitchRequest', payload: { pitch: -2 } },
      { type: 'remote.TrackVolumeRequest', payload: { type: 4, volume: 0 } },
      { type: 'remote.TrackVolumeRequest', payload: { type: 5, volume: 40 } },
    ];
    assert.deepEqual(steps, [['accusé', []], ['état 1', []], ['file', []], ['état 2', []], ['état 3', expected], ['état 4', []]],
      applied ? 'KaraFun a appliqué les options d’ajout : rien d’autre' : 'options ignorées : rattrapées une fois, titre chargé');
    assert.equal(f.tracked()[0].queueId, DJ_ID);
    assert.deepEqual(f.events('song.settingsCaughtUp').map(e => e.fields), applied ? [] : [['pitch', 'backing', 'guide']]);
  }
});

test('séquence réelle du bar : réglage changé pendant l’envoi, envoyé au titre de KaraFun dès l’accusé', async t => {
  for (const manageVolumes of [true, false]) {
    const f = harness();
    const { frames } = replayBridge(t, f, { permissions: { ...ADMIN, manageVolumes } });
    const so = singer(f, openTable(f, '1'), 'Soraya', 12458);
    const entryId = so.person.song.entryId;
    await f.call('POST /api/table/song/settings', { ...so.body, entryId, settings: { pitch: -2 } });
    f.settings.auto = true;
    const [add] = frames();
    f.settings.auto = false;
    const label = f.pending().sel.label;
    const answer = await f.call('POST /api/table/song/settings', { ...so.body, entryId, settings: { pitch: 3 } });
    assert.equal(answer.applied, 'sending');
    const item = djItem(add.payload.options);
    frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} });
    assert.deepEqual(bare(frames(statusEvent(1, item))), []);
    const [options, ...others] = frames(queueEvent(item));
    assert.deepEqual(bare([options]), [{ type: 'remote.SetQueueItemOptionsRequest', payload: { queueItemId: DJ_ID,
      options: { singer: label, pitch: 3, tempo: 0 } } }], 'même nom affiché, nouvelle tonalité');
    assert.deepEqual(bare(others), [], 'rien en direct : le titre n’est pas chargé');
    assert.equal(f.tracked()[0].settingsDirty, false);
    // KaraFun applique les options de son titre avant de le charger.
    const updated = djItem({ ...add.payload.options, pitch: 3 });
    assert.deepEqual(bare(frames({ id: options.id, type: 'remote.SetQueueItemOptionsResponse', payload: {} }, queueEvent(updated))), []);
    assert.deepEqual(bare(frames(statusEvent(2, updated, { pitch: 3 }))), []);
    assert.deepEqual(bare(frames(statusEvent(3, updated, { pitch: 3 }))), []);
    assert.deepEqual(bare(frames(statusEvent(4, updated, { pitch: 3 }))), []);
    assert.deepEqual(caughtUpNotes(f), [], 'aucune fausse alerte au bar');
    assert.deepEqual(f.events('song.settingsCaughtUp'), []);
  }
});

test('séquence réelle du bar : accusé reçu avec le titre déjà chargé, options d’abord, direct seulement sur un état frais', async t => {
  for (const manageVolumes of [true, false]) {
    const f = harness();
    const { frames } = replayBridge(t, f, { permissions: { ...ADMIN, manageVolumes } });
    const so = singer(f, openTable(f, '1'), 'Soraya', 12458);
    const entryId = so.person.song.entryId;
    await f.call('POST /api/table/song/settings', { ...so.body, entryId, settings: { pitch: -2 } });
    f.settings.auto = true;
    const [add] = frames();
    f.settings.auto = false;
    const label = f.pending().sel.label;
    await f.call('POST /api/table/song/settings', { ...so.body, entryId, settings: { pitch: 3 } });
    const item = djItem(add.payload.options);
    // Les trames arrivent ensemble : la synchronisation voit déjà l'état 3 (options d'ajout appliquées).
    const sent = frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, statusEvent(1, item), queueEvent(item),
      statusEvent(2, item, { pitch: -2 }), statusEvent(3, item, { pitch: -2 }));
    assert.deepEqual(bare(sent), [{ type: 'remote.SetQueueItemOptionsRequest', payload: { queueItemId: DJ_ID,
      options: { singer: label, pitch: 3, tempo: 0 } } }], 'pas de rattrapage sur un état d’avant la demande');
    assert.deepEqual(caughtUpNotes(f), []);
    // Réponse de KaraFun, puis rien de neuf : on attend.
    assert.deepEqual(bare(frames({ id: sent[0].id, type: 'remote.SetQueueItemOptionsResponse', payload: {} })), []);
    assert.deepEqual(bare(frames()), []);
    // La lecture démarre sans la nouvelle tonalité : rattrapée une fois (ou avis au bar sans le droit).
    assert.deepEqual(bare(frames(statusEvent(4, item, { pitch: -2 })).concat(frames(), frames(statusEvent(4, item, { pitch: -2 })))),
      manageVolumes ? [{ type: 'remote.PitchRequest', payload: { pitch: 3 } }] : []);
    assert.equal(caughtUpNotes(f).length, manageVolumes ? 0 : 1);
  }
});

test('titre chargé mais pas lancé, réglé de nouveau : options du titre seulement, direct comparé à un état reçu après', async t => {
  for (const manageVolumes of [true, false]) {
    const f = harness();
    const { frames } = replayBridge(t, f, { permissions: { ...ADMIN, manageVolumes } });
    const so = singer(f, openTable(f, '1'), 'Soraya', 12458);
    const entryId = so.person.song.entryId;
    await f.call('POST /api/table/song/settings', { ...so.body, entryId, settings: { pitch: -2 } });
    f.settings.auto = true;
    const [add] = frames();
    f.settings.auto = false;
    const label = f.pending().sel.label;
    const item = djItem(add.payload.options);
    frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, statusEvent(1, item), queueEvent(item));
    assert.deepEqual(bare(frames(statusEvent(2, item, { pitch: -2 }), statusEvent(3, item, { pitch: -2 }))), [], 'déjà appliqué');
    // En état 3, la chanteuse change d'avis.
    const answer = await f.call('POST /api/table/song/settings', { ...so.body, entryId, settings: { pitch: 1 } });
    assert.equal(answer.applied, 'karafun');
    const [options, ...more] = frames();
    assert.deepEqual(bare([options]), [{ type: 'remote.SetQueueItemOptionsRequest', payload: { queueItemId: DJ_ID,
      options: { singer: label, pitch: 1, tempo: 0 } } }]);
    assert.deepEqual(bare(more), [], 'pas de tonalité en direct calculée sur l’état d’avant');
    assert.deepEqual(bare(frames({ id: options.id, type: 'remote.SetQueueItemOptionsResponse', payload: {} })), []);
    assert.deepEqual(caughtUpNotes(f), [], 'pas de fausse alerte : KaraFun n’a pas encore pu répondre');
    assert.deepEqual(f.events('song.settingsCaughtUp'), []);
    // KaraFun renvoie son état avec la nouvelle tonalité : rien à rattraper.
    assert.deepEqual(bare(frames(statusEvent(3, item, { pitch: 1 }), statusEvent(4, item, { pitch: 1 }))), []);
    assert.deepEqual(caughtUpNotes(f), []);
  }
});

test('réglage en direct d’un titre sans réglage : pas de rattrapage ensuite, une seule commande', async () => {
  const f = harness();
  const link = kcsBridge(f);
  const tb = openTable(f, '1');
  singer(f, tb, 'Léa', 101);
  const tr = sendNext(f, 'q-1', { startedAt: Date.now() });
  const item = kfItem('q-1', 101, tr.sel.label);
  link.bridge.queue = [item];
  link.bridge.status = playing(item);
  f.sync();
  await f.call('POST /api/staff/kf', { action: 'pitch', value: 2 });
  // Réponse de KaraFun avant son nouvel état : synchronisation sur l'ancien état (tonalité 0).
  f.sync();
  f.sync();
  assert.deepEqual(link.sent, [{ type: 'remote.PitchRequest', payload: { pitch: 2 } }]);
  assert.deepEqual(f.events('song.settingsCaughtUp'), [], 'pas présenté comme un réglage ignoré par KaraFun');
});

test('relance ⏮ d’un duo : volumes seulement pour les pistes que le titre possède', async () => {
  const f = harness();
  const link = kcsBridge(f);
  const tb = openTable(f, '1');
  const ana = singer(f, tb, 'Ana');
  const ben = singer(f, tb, 'Ben');
  const duo = f.sched.inviteDuet(ana.person, ben.person.id, { songId: 12293, title: 'Le chanteur', artist: 'Daniel Balavoine' });
  f.sched.setSongSettings(duo, { guide: 50, backing: 0 });
  const tr = sendNext(f, 'q-1', { startedAt: Date.now(), liveChecked: 'q-1' });
  assert.equal(tr.sel.ids.length, 2);
  const item = kfItem('q-1', 12293, tr.sel.label, { songTracks: [{ type: 5 }] });
  link.bridge.queue = [item];
  link.bridge.status = playing(item, { tracks: [{ volume: 50, track: { type: 5 } }] });
  f.sync();
  await f.call('POST /api/staff/kf', { action: 'restart' });
  assert.deepEqual(link.sent.at(-1), { type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 12293 },
    options: { singer: tr.sel.label, tracks: [{ track: { type: 5 }, volume: 50 }] }, position: 1 } },
  'ni chœurs ni voix guide B : le titre n’a que la voix guide A');
});

test('ancienne télécommande d’un vrai KaraFun : réglages indisponibles, les téléphones n’affichent rien, la route le dit', async () => {
  const f = harness();
  const link = kcsBridge(f);
  link.bridge.protocol = 'socket.io';
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  const entryId = lea.person.song.entryId;
  assert.equal(f.publicState(lea.person, '1', new Set([lea.person.id])).songSettings.enabled, false, 'pas de bouton « Réglages »');
  assert.equal(f.settings.singerSongSettings, true, 'l’interrupteur du bar ne change pas');
  const state = f.staffState();
  assert.equal(state.songSettings.available, false);
  assert.equal(state.settings.singerSongSettings, true);
  await rejects(f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { pitch: 1 } }), 'SONG_SETTINGS_UNAVAILABLE',
    /^Cette ancienne télécommande KaraFun ne connaît pas les réglages de titre : ils ne seraient pas appliqués\.$/);
  assert.equal(Object.hasOwn(lea.person.song, 'settings'), false);
  // Télécommande récente : de nouveau proposés.
  link.bridge.protocol = 'kcs';
  assert.equal(f.publicState(lea.person, '1', new Set([lea.person.id])).songSettings.enabled, true);
  // KaraFun pas encore connecté : rien ne permet de dire que c'est impossible.
  link.bridge.protocol = null;
  assert.equal(f.publicState(lea.person, '1').songSettings.enabled, true);
});

test('titre parti vers KaraFun vu par le téléphone : raison quand il ne se règle plus', async () => {
  const f = harness();
  const link = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa');
  const tom = singer(f, tb, 'Tom', 201);
  const duo = f.sched.inviteDuet(lea.person, tom.person.id, { songId: 102, title: 'Duo', artist: 'Artiste' });
  assert.equal(lea.person.song.entryId, duo.entryId);
  const tr = sendNext(f, 'q-1');
  assert.deepEqual(tr.sel.ids, [lea.person.id, tom.person.id]);
  link.bridge.queue = [kfItem('q-1', 102, tr.sel.label)];
  const row = who => f.publicState(who.person, '1', new Set([who.person.id])).me.inKaraFun.find(item => item.queueId === 'q-1');
  const view = who => { const { canAdjust, lock } = row(who); return { canAdjust, lock }; };
  assert.deepEqual(view(lea), { canAdjust: true, lock: null });
  assert.deepEqual(view(tom), { canAdjust: false, lock: 'duo' }, 'partenaire : seul l’auteur règle');
  tr.pulled = { reason: 'defer', at: Date.now() };
  assert.deepEqual(view(lea), { canAdjust: false, lock: 'leaving' }, '« Pas prêt » : le titre sort de KaraFun');
  tr.pulled = null;
  tr.startedAt = Date.now();
  assert.deepEqual(view(lea), { canAdjust: false, lock: 'started' });
  // Envoi en cours annulé (départ du chanteur) : le titre ne partira pas.
  const g = harness();
  kcsBridge(g);
  const ana = singer(g, openTable(g, '1'), 'Ana', 301);
  g.settings.auto = true;
  g.sync();
  g.settings.auto = false;
  assert.equal(g.pending().sel.ids[0], ana.person.id);
  const sending = () => g.publicState(ana.person, '1', new Set([ana.person.id])).me.inKaraFun.find(item => item.sending);
  assert.equal(sending().lock, null);
  g.pending().cancelled = true;
  assert.deepEqual([sending().canAdjust, sending().lock], [false, 'leaving']);
});
