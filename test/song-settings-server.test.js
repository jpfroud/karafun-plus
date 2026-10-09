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
      resendWithoutOptions, restoreKaraFunDefaults: typeof restoreKaraFunDefaults === 'function' ? restoreKaraFunDefaults : null,
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
test('envoi : le titre part avec ses réglages dans AddToQueueRequest ; duo : chaque voix guide la sienne', async () => {
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

  // Duo : la voix 2 ne suit plus la voix 1 (D6) ; réglée, elle part avec la sienne.
  const g = harness();
  const duoBridge = kcsBridge(g);
  const tb2 = openTable(g, '1');
  const ana = singer(g, tb2, 'Ana');
  const ben = singer(g, tb2, 'Ben');
  const duo = g.sched.inviteDuet(ana.person, ben.person.id, { songId: 300, title: 'Duo', artist: 'Artiste' });
  await g.call('POST /api/table/song/settings', { ...ana.body, entryId: duo.entryId, settings: { guide: 50, guideVoices: {} } });
  g.settings.auto = true;
  g.sync();
  assert.deepEqual(duoBridge.sent[0].payload.options.tracks, [{ track: { type: 5 }, volume: 50 }]);
  assert.deepEqual(plain(g.pending().sentSettings), { guide: 50 });
  const h = harness();
  const voicesBridge = kcsBridge(h);
  const tb3 = openTable(h, '1');
  const cleo = singer(h, tb3, 'Cléo');
  const dan = singer(h, tb3, 'Dan');
  const duo2 = h.sched.inviteDuet(cleo.person, dan.person.id, { songId: 301, title: 'Duo 2', artist: 'Artiste' });
  assert.deepEqual(plain(await h.call('POST /api/table/song/settings', { ...cleo.body, entryId: duo2.entryId,
    settings: { guide: 0, guideVoices: { 6: 25 } } })), { ok: true, settings: { guide: 0, guideVoices: { 6: 25 } }, applied: 'list' });
  h.settings.auto = true;
  h.sync();
  assert.deepEqual(voicesBridge.sent[0].payload.options.tracks, [{ track: { type: 5 }, volume: 0 }, { track: { type: 6 }, volume: 25 }]);
  assert.deepEqual(plain(h.pending().sentSettings), { guide: 0, guideVoices: { 6: 25 } });
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
  await f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 25, queueId: 'q-9' }); // page actuelle
  await f.call('POST /api/staff/kf', { action: 'track', track: 'backing', value: 0 });
  assert.deepEqual(link.sent, [
    { type: 'remote.PitchRequest', payload: { pitch: -1 } },
    { type: 'remote.TempoRequest', payload: { tempo: 10 } },
    { type: 'remote.TrackVolumeRequest', payload: { type: 5, volume: 25 } },
    { type: 'remote.TrackVolumeRequest', payload: { type: 4, volume: 0 } },
  ], 'duo à deux voix : la voix 2 ne suit plus la voix 1');
  assert.deepEqual(plain(tr.sel.song.settings), { pitch: -1, tempo: 10, guide: 25, backing: 0 }, 'gardés pour une relance');
  // Voix 2 réglée seule, par sa piste.
  assert.deepEqual(plain(await f.call('POST /api/staff/kf', { action: 'track', track: 6, value: 75, queueId: 'q-9' })),
    { ok: true, field: 'guideVoices.6', value: 75 });
  assert.deepEqual(link.sent.at(-1), { type: 'remote.TrackVolumeRequest', payload: { type: 6, volume: 75 } });
  assert.deepEqual(f.events('song.settings').at(-1).field, 'guideVoices.6');
  await f.call('POST /api/staff/kf', { action: 'track', track: '6', value: 50 });
  assert.deepEqual(plain(tr.sel.song.settings), { pitch: -1, tempo: 10, guide: 25, backing: 0, guideVoices: { 6: 50 } });
  await rejects(f.call('POST /api/staff/kf', { action: 'track', track: 7, value: 50 }), null, /^Ce titre n’a pas cette voix guide\.$/);
  await rejects(f.call('POST /api/staff/kf', { action: 'track', track: 16, value: 50 }), null, /^Piste vocale inconnue\.$/);
  await rejects(f.call('POST /api/staff/kf', { action: 'track', track: { type: 6 }, value: 50 }), null, /^Piste vocale inconnue\.$/);
  await rejects(f.call('POST /api/staff/kf', { action: 'track', track: 6, value: 120 }), 'SONG_SETTINGS', /^La voix guide va de 0/);
  await f.call('POST /api/staff/kf', { action: 'pitch', value: 0 });
  assert.deepEqual(plain(tr.sel.song.settings), { tempo: 10, guide: 25, backing: 0, guideVoices: { 6: 50 } });
  await f.call('POST /api/staff/kf', { action: 'track', track: 'backing', value: 100 });
  assert.deepEqual(plain(tr.sel.song.settings), { tempo: 10, guide: 25, backing: 100, guideVoices: { 6: 50 } }, 'volume choisi gardé, même à 100');
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
  await rejects(f.call('POST /api/staff/kf', { action: 'track', track: 6, value: 50 }), null, /^Ce titre n’a pas cette voix guide\.$/);
  const choir = kfItem('n-2', 556, 'Chorale', { songTracks: [{ type: 4 }] });
  link.bridge.queue = [choir];
  link.bridge.status = playing(choir);
  await rejects(f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 50 }), null, /^Ce titre n’a pas de voix guide\.$/);
  link.bridge.queue = [solo];
  link.bridge.status = playing(solo);
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
  // « Pas prêt » n'est possible que si quelqu'un d'autre peut chanter avant : Tom.
  f.sched.chooseSong(tom.person, { songId: 201, title: 'Titre 201', artist: 'Artiste' });
  // « Pas prêt » : KaraFun retire le titre, il revient dans la liste de Léa avec ses réglages.
  await f.call('POST /api/table/defer', { ...lea.body });
  assert.ok(link.sent.some(m => m.type === 'remote.RemoveFromQueueRequest'));
  link.bridge.queue = [];
  f.sync();
  assert.equal(lea.person.song.entryId, tr.sel.song.entryId);
  assert.deepEqual(plain(lea.person.song.settings), { pitch: -2 });
  // Absent à l'appel : le titre lui revient avec ses réglages.
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
  assert.deepEqual(plain(state.songSettings.live), { queueId: 'q-1', pitch: -2, tempo: 0, guide: 0, backing: null,
    voices: { 5: 0 }, tracks: [5], entryId: tr.sel.song.entryId, title: 'Titre 101', settings: { pitch: -2 } });
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
  let ws;
  const receive = message => ws.emit('message', { data: JSON.stringify(message) });
  // Connexion (ou reconnexion, même pont) : poignée de main de KaraFun.
  const open = () => {
    bridge._openKcs('wss://kcs.exemple.invalid/remote', () => true);
    ws = FakeWS.last;
    ws.emit('open');
    receive({ type: 'core.AuthenticatedEvent', payload: {} });
    receive({ type: 'remote.UsernameUpdateEvent', payload: { username: bridge.username } });
    receive({ type: 'remote.ConfigurationUpdateEvent', payload: { configuration: BAR_CONFIGURATION } });
    receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions } });
  };
  open();
  receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  receive({ type: 'remote.StatusEvent', payload: { status: { state: 1, pitch: 0, tempo: 0, tracks: [], current: null } } });
  ws.out.length = 0;
  // Trames reçues, puis une synchronisation : rend les demandes parties ensuite.
  const frames = (...messages) => {
    for (const message of messages) receive(message);
    f.sync();
    return ws.out.splice(0).filter(m => !m.type.startsWith('core.'));
  };
  // Coupure de la télécommande puis reconnexion : demandes de la reprise oubliées.
  const reconnect = () => {
    bridge.disconnect();
    f.sync();
    open();
    ws.out.length = 0;
  };
  return { bridge, get ws() { return ws; }, frames, reconnect };
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

// Lot F : la barre de lecture part de l'état 4 (lecture), pas de l'annonce
// (1), du chargement (2) ni de l'attente de « Lecture » (3, jusqu'à 3 min au bar).
test('séquence réelle du bar : la barre de lecture ne part qu’à l’état 4, se fige à l’état 5', async t => {
  const f = harness();
  const { frames } = replayBridge(t, f);
  const item = djItem({ singer: 'Soraya' });
  const progress = () => plain(f.publicState().stage?.progress);
  frames(queueEvent(item));
  for (const state of [1, 2, 3]) {
    frames(statusEvent(state, item));
    assert.equal(progress(), undefined, `état ${state} : rien sur scène, pas de barre`);
    assert.equal(f.staffState().stage, null);
  }
  frames(statusEvent(4, item, { tempo: 10 }));
  const started = progress();
  assert.ok(started.elapsedSec < 1, `état 4 : départ à zéro (${started.elapsedSec})`);
  assert.deepEqual({ ...started, elapsedSec: 0 }, { elapsedSec: 0, durationSec: null, paused: false, rate: 1.1 },
    'titre ajouté dans KaraFun, jamais cherché : durée inconnue ; tempo +10 pris en compte');
  frames(statusEvent(5, item, { tempo: 10 }));
  assert.equal(progress().paused, true, 'état 5 (pause de KaraFun) : barre figée');
  frames(statusEvent(4, item, { tempo: 10 }));
  assert.equal(progress().paused, false);
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
  f.sched.setSongSettings(duo, { guide: 50, backing: 0, guideVoices: { 6: 50 } });
  const tr = sendNext(f, 'q-1', { startedAt: Date.now(), liveChecked: 'q-1' });
  assert.equal(tr.sel.ids.length, 2);
  const item = kfItem('q-1', 12293, tr.sel.label, { songTracks: [{ type: 5 }] });
  link.bridge.queue = [item];
  link.bridge.status = playing(item, { tracks: [{ volume: 50, track: { type: 5 } }] });
  f.sync();
  await f.call('POST /api/staff/kf', { action: 'restart' });
  assert.deepEqual(link.sent.at(-1), { type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 12293 },
    options: { singer: tr.sel.label, tracks: [{ track: { type: 5 }, volume: 50 }] }, position: 1 } },
  'ni chœurs ni voix guide 2 : le titre n’a que la voix guide 1');
  // Titre ajouté dans KaraFun : la copie reprend chaque voix de l'état en direct.
  const g = harness();
  const other = kcsBridge(g);
  const added = kfItem('n-1', 12300, 'Bar', { songTracks: [{ type: 4 }, { type: 5 }, { type: 6 }] });
  other.bridge.queue = [added];
  other.bridge.status = playing(added, { tracks: [{ volume: 100, track: { type: 4 } }, { volume: 25, track: { type: 5 } },
    { volume: 50, track: { type: 6 } }] });
  g.sync();
  await g.call('POST /api/staff/kf', { action: 'restart' });
  assert.deepEqual(other.sent.at(-1).payload.options.tracks,
    [{ track: { type: 5 }, volume: 25 }, { track: { type: 6 }, volume: 50 }]);
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

// Regression: relecture PR #11, revue au lot G2 (D6) — duo devenu solo dans
// KaraFun : la voix 2 posée par la file ne suit plus la voix 1, mais revient
// à 0 dès que son réglage disparaît, et plus rien ne la laisse au réglage du duo.
test('duo devenu solo dans KaraFun : la voix guide 2 posée par la file revient à 0 quand son réglage disparaît', async () => {
  const f = harness();
  let link = kcsBridge(f);
  const tb = openTable(f, '1');
  const ana = singer(f, tb, 'Ana');
  const ben = singer(f, tb, 'Ben');
  const duo = f.sched.inviteDuet(ana.person, ben.person.id, { songId: 300, title: 'Duo', artist: 'Artiste' });
  await f.call('POST /api/table/song/settings', { ...ana.body, entryId: duo.entryId, settings: { guide: 50, guideVoices: { 6: 50 } } });
  f.settings.auto = true;
  f.sync();
  f.settings.auto = false;
  const label = f.pending().sel.label;
  assert.deepEqual(link.sent[0].payload.options.tracks, [{ track: { type: 5 }, volume: 50 }, { track: { type: 6 }, volume: 50 }]);
  const options = { tracks: [{ track: { type: 5 }, volume: 50 }, { track: { type: 6 }, volume: 50 }] };
  const songTracks = [{ type: 4 }, { type: 5 }, { type: 6 }];
  link = kcsBridge(f);
  link.bridge.queue = [kfItem('q-1', 300, label, { songTracks, options })];
  f.sync();
  const tr = f.tracked()[0];
  assert.equal(tr.queueId, 'q-1');
  assert.deepEqual(plain(tr.sentSettings), { guide: 50, guideVoices: { 6: 50 } }, 'la voix 2 posée pour le duo est notée');
  assert.deepEqual(plain(await f.call('POST /api/table/duet/leave', { ...ben.body, ownerId: ana.person.id, entryId: duo.entryId })),
    { ok: true, stage: 'sent' });
  assert.deepEqual(plain(tr.sel.ids), [ana.person.id]);
  const b = message => message.payload.options.tracks.find(row => row.track.type === 6)?.volume;
  // Ana (téléphone) règle la voix 1 seule : la voix 2, plus réglée, revient à 0.
  await f.call('POST /api/table/song/settings', { ...ana.body, entryId: duo.entryId, settings: { guide: 50, guideVoices: {} } });
  assert.equal(link.sent.at(-1).type, 'remote.SetQueueItemOptionsRequest');
  assert.deepEqual(link.sent.at(-1).payload.options.tracks, [{ track: { type: 5 }, volume: 50 }, { track: { type: 6 }, volume: 0 }]);
  await f.call('POST /api/staff/song/settings', { personId: ana.person.id, entryId: duo.entryId, settings: { guide: 25, guideVoices: { 6: 75 } } });
  assert.equal(b(link.sent.at(-1)), 75, 'chaque voix la sienne');
  // Réglage remis par défaut : la voix 2 revient aussi à la valeur par défaut.
  await f.call('POST /api/staff/song/settings', { personId: ana.person.id, entryId: duo.entryId, settings: { guideVoices: {} } });
  assert.equal(b(link.sent.at(-1)), 0);
  // Au début du titre, KaraFun a laissé la voix 2 à 50 : rattrapée.
  f.sched.setSongSettings(tr.sel.song, { guide: 0 });
  delete tr.statusAtOptions;
  delete tr.liveChecked;
  const item = kfItem('q-1', 300, label, { songTracks, options });
  link.bridge.queue = [item];
  link.bridge.status = playing(item, { tracks: [{ volume: 100, track: { type: 4 } }, { volume: 0, track: { type: 5 } }, { volume: 50, track: { type: 6 } }] });
  const before = link.sent.length;
  f.sync();
  assert.deepEqual(link.sent.slice(before), [{ type: 'remote.TrackVolumeRequest', payload: { type: 6, volume: 0 } }]);
  // En direct, « Coupé » sur la voix 1 ne touche qu'elle ; la voix 2 se règle par sa piste.
  const live = link.sent.length;
  await f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 0 });
  await f.call('POST /api/staff/kf', { action: 'track', track: 6, value: 25 });
  assert.deepEqual(link.sent.slice(live), [{ type: 'remote.TrackVolumeRequest', payload: { type: 5, volume: 0 } },
    { type: 'remote.TrackVolumeRequest', payload: { type: 6, volume: 25 } }]);
});

// ---------------------------------------------------------------- chaque titre isolé (lot G, retours du 4 octobre)
// Le titre précédent a été réglé en direct (voix guide 25, tonalité +2) ;
// le suivant n'a aucun réglage. Un KaraFun « collant » garde ces valeurs au
// titre suivant, un autre les remet à zéro : la file vise les valeurs
// neutres au chargement du titre, et n'envoie que ce qui diffère.
const isoItem = (id, songId, options, songTracks = [{ type: 4 }, { type: 5 }]) => ({ id, song: { id: { type: 1, id: songId },
  artist: 'Artiste', songTracks, title: `Titre ${songId}`, options } });
// État de KaraFun avec chaque piste du titre (4 chœurs, 5 et 6 voix guides).
const isoStatus = (state, current, { pitch = 0, tempo = 0, backing = 53, guide = 0, guideB = 0, voices = {} } = {}) => {
  const volumes = { 4: backing, 5: guide, 6: guideB, ...voices };
  return { type: 'remote.StatusEvent', payload: { status: { state, pitch, tempo, current,
    tracks: state === 1 ? [] : current.song.songTracks.map(({ type }) => ({ volume: volumes[type], track: { type } })) } } };
};
const resetNotes = f => notes(f).filter(line => line.startsWith('Le réglage du titre précédent'));
// Titre A envoyé et en lecture, titre B envoyé derrière lui (sans réglage
// sauf `bSettings`). `duoA` : A est un duo. Rend de quoi jouer la suite.
function aThenB(t, { permissions = ADMIN, bSettings = null, songTracks, duoA = false } = {}) {
  const f = harness();
  const { bridge, frames } = replayBridge(t, f, { permissions });
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa');
  const tom = singer(f, tb, 'Tom');
  const zoe = singer(f, tb, 'Zoé');
  if (duoA) f.sched.inviteDuet(lea.person, tom.person.id, { songId: 12458, title: 'Titre 12458', artist: 'Artiste' });
  else f.sched.chooseSong(lea.person, { songId: 12458, title: 'Titre 12458', artist: 'Artiste' });
  f.settings.auto = true;
  const [addA] = frames();
  f.settings.auto = false;
  assert.equal(f.pending().sel.ids[0], lea.person.id);
  f.sched.chooseSong(zoe.person, { songId: 12459, title: 'Titre 12459', artist: 'Artiste' });
  if (bSettings) f.sched.setSongSettings(zoe.person.song, bSettings);
  const A = isoItem('A-id', addA.payload.song.id, addA.payload.options, songTracks);
  assert.deepEqual(bare(frames({ id: addA.id, type: 'remote.AddToQueueResponse', payload: {} }, isoStatus(1, A), queueEvent(A),
    isoStatus(2, A), isoStatus(3, A), isoStatus(4, A))), [], 'A sans réglage, KaraFun aux valeurs par défaut : rien');
  f.settings.auto = true;
  const addB = frames().find(m => m.type === 'remote.AddToQueueRequest');
  f.settings.auto = false;
  assert.equal(f.pending().sel.ids[0], zoe.person.id);
  const B = isoItem('B-id', addB.payload.song.id, addB.payload.options, songTracks);
  assert.deepEqual(bare(frames({ id: addB.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, B))), []);
  const trA = f.tracked().find(tr => tr.queueId === 'A-id'), trB = f.tracked().find(tr => tr.queueId === 'B-id');
  assert.ok(trA && trB);
  return { f, bridge, frames, A, B, trA, trB, addB };
}
// A se termine, B est annoncé (état 1) puis chargé (états 2, 3) et lancé (4).
function playB({ frames, B }, carried) {
  return [
    ['état 1', frames(isoStatus(1, B), queueEvent(B))],
    ['état 2', frames(isoStatus(2, B, carried))],
    ['état 3', frames(isoStatus(3, B, carried))],
    ['état 4', frames(isoStatus(4, B, carried))],
    ['état 4 encore', frames(isoStatus(4, B, carried))],
  ].map(([step, out]) => [step, bare(out)]);
}
const pitchTo = pitch => ({ type: 'remote.PitchRequest', payload: { pitch } });
const volumeTo = (type, volume) => ({ type: 'remote.TrackVolumeRequest', payload: { type, volume } });

test('titre isolé : voix guide 25 et tonalité +2 en direct sur A, B sans réglage démarre à 0 avec un KaraFun collant', async t => {
  const run = aThenB(t);
  const { f, bridge, frames, trA, trB } = run;
  assert.deepEqual(plain(await f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 25, queueId: 'A-id' })),
    { ok: true, field: 'guide', value: 25 });
  await f.call('POST /api/staff/kf', { action: 'pitch', value: 2, queueId: 'A-id' });
  assert.deepEqual(bare(frames(isoStatus(4, run.A, { guide: 25, pitch: 2 }))), [volumeTo(5, 25), pitchTo(2)]);
  assert.deepEqual(plain(trA.sel.song.settings), { guide: 25, pitch: 2 }, 'gardés sur A seulement');
  assert.equal(trB.sel.song.settings, undefined);
  // KaraFun garde les valeurs de A : remises à zéro une fois, au titre chargé (état 3), jamais à l'état 1.
  const carried = { guide: 25, pitch: 2 };
  const steps = playB(run, carried);
  assert.deepEqual(steps, [['état 1', []], ['état 2', []], ['état 3', [pitchTo(0), volumeTo(5, 0)]], ['état 4', []], ['état 4 encore', []]]);
  assert.equal(trB.sel.song.settings, undefined, 'rien n’est enregistré sur B');
  assert.deepEqual(f.events('song.settingsReset').map(e => [e.queueId, e.entryId, e.fields]),
    [['B-id', trB.sel.song.entryId, ['pitch', 'guide']]]);
  assert.deepEqual(f.events('song.settingsCaughtUp'), [], 'pas présenté comme un réglage du titre');
  // La voix guide n'est plus apprise comme valeur par défaut ; les chœurs restent ceux du KaraFun du bar.
  assert.deepEqual(bridge.songSettingsDefaults(), { pitch: 0, tempo: 0, guide: 0, backing: 53 });
  assert.equal(f.staffState().songSettings.defaults.guide, 0, 'le bar voit « guide 25 » s’il reste');
});

test('titre isolé : un KaraFun qui remet déjà à zéro ne reçoit aucune trame de plus', async t => {
  const run = aThenB(t);
  const { f, frames } = run;
  await f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 25, queueId: 'A-id' });
  await f.call('POST /api/staff/kf', { action: 'pitch', value: 2, queueId: 'A-id' });
  frames(isoStatus(4, run.A, { guide: 25, pitch: 2 }));
  assert.deepEqual(playB(run, {}), [['état 1', []], ['état 2', []], ['état 3', []], ['état 4', []], ['état 4 encore', []]]);
  assert.deepEqual(f.events('song.settingsReset'), []);
  assert.deepEqual(resetNotes(f), []);
});

test('titre isolé : la voix guide 50 choisie pour B reste sa cible, le reste revient à zéro', async t => {
  for (const applied of [true, false]) {
    const run = aThenB(t, { bSettings: { guide: 50 } });
    const { f, frames, addB, trB } = run;
    assert.deepEqual(addB.payload.options.tracks, [{ track: { type: 5 }, volume: 50 }]);
    await f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 25, queueId: 'A-id' });
    await f.call('POST /api/staff/kf', { action: 'pitch', value: 2, queueId: 'A-id' });
    frames(isoStatus(4, run.A, { guide: 25, pitch: 2 }));
    // KaraFun collant : il applique (ou non) les options de B, mais garde la tonalité de A.
    const carried = applied ? { guide: 50, pitch: 2 } : { guide: 25, pitch: 2 };
    const loaded = playB(run, carried).find(([step]) => step === 'état 3')[1];
    assert.deepEqual(loaded, applied ? [pitchTo(0)] : [pitchTo(0), volumeTo(5, 50)], 'cible 50, pas 0');
    assert.deepEqual(f.events('song.settingsReset').map(e => e.fields), [['pitch']]);
    assert.deepEqual(f.events('song.settingsCaughtUp').map(e => e.fields), applied ? [] : [['guide']]);
    assert.deepEqual(plain(trB.sel.song.settings), { guide: 50 });
  }
});

test('titre isolé : sans le droit « Personnaliser la chanson en cours », rien n’est envoyé et un seul avis', async t => {
  const run = aThenB(t, { permissions: { ...ADMIN, manageVolumes: false } });
  const { f, frames, bridge } = run;
  // Réglé dans KaraFun pendant A : la file ne peut pas le faire elle-même.
  await rejects(f.call('POST /api/staff/kf', { action: 'pitch', value: 2, queueId: 'A-id' }), null, /Personnaliser la chanson en cours/);
  assert.deepEqual(bare(frames(isoStatus(4, run.A, { guide: 25, pitch: 2 }))), []);
  const steps = playB(run, { guide: 25, pitch: 2 });
  assert.deepEqual(steps.flatMap(([, out]) => out), [], 'aucune trame');
  assert.deepEqual(resetNotes(f), ['Le réglage du titre précédent est peut-être resté sur « tonalité +2, voix guide 25 » : KaraFun ne laisse pas l’application personnaliser la chanson en cours.']);
  assert.deepEqual(caughtUpNotes(f), [], 'pas l’avis des réglages d’un titre : B n’en a pas');
  assert.deepEqual(f.events('song.settingsReset'), []);
  assert.deepEqual(bridge.songSettingsDefaults().guide, 0);
});

test('titre isolé : voix guide 2 d’un duo remise à zéro sur le titre suivant qui a cette piste', async t => {
  const songTracks = [{ type: 4 }, { type: 5 }, { type: 6 }];
  const run = aThenB(t, { duoA: true, songTracks });
  const { f, frames, trA } = run;
  assert.equal(trA.sel.ids.length, 2);
  await f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 25, queueId: 'A-id' });
  await f.call('POST /api/staff/kf', { action: 'track', track: 6, value: 25, queueId: 'A-id' });
  assert.deepEqual(bare(frames(isoStatus(4, run.A, { guide: 25, guideB: 25 }))), [volumeTo(5, 25), volumeTo(6, 25)]);
  assert.deepEqual(plain(trA.sel.song.settings), { guide: 25, guideVoices: { 6: 25 } });
  const loaded = playB(run, { guide: 25, guideB: 25 }).find(([step]) => step === 'état 3')[1];
  assert.deepEqual(loaded, [volumeTo(5, 0), volumeTo(6, 0)]);
  assert.deepEqual(f.events('song.settingsReset').map(e => e.fields), [['guide', 'guideVoices.6']]);
});

// Voix guide réglable voix par voix (lot G2, décision D6 du gérant) : un
// réglage par voix, sans curseur commun, en solo comme en duo ; chaque voix
// sans réglage revient à 0 au titre suivant, même avec un KaraFun collant.
test('voix guides : titre à deux voix chanté seul puis en duo, chaque voix réglée seule, retour à 0 avec un KaraFun collant', async t => {
  const f = harness();
  const { frames } = replayBridge(t, f);
  const tb = openTable(f, '1', 6);
  const lea = singer(f, tb, 'Léa', 12458);
  const tom = singer(f, tb, 'Tom');
  const zoe = singer(f, tb, 'Zoé');
  const max = singer(f, tb, 'Max');
  const ivy = singer(f, tb, 'Ivy');
  const two = [{ type: 4 }, { type: 5 }, { type: 6 }];
  const sendNow = () => {
    f.settings.auto = true;
    const add = frames().find(m => m.type === 'remote.AddToQueueRequest');
    f.settings.auto = false;
    return add;
  };
  // Solo sur un titre à deux voix : chaque voix part avec son propre volume.
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId: lea.person.song.entryId,
    settings: { guide: 50, guideVoices: { 6: 25 } } });
  const addA = sendNow();
  assert.deepEqual(addA.payload.options.tracks, [{ track: { type: 5 }, volume: 50 }, { track: { type: 6 }, volume: 25 }]);
  const A = isoItem('A-id', 12458, addA.payload.options, two);
  assert.deepEqual(bare(frames({ id: addA.id, type: 'remote.AddToQueueResponse', payload: {} }, isoStatus(1, A), queueEvent(A),
    isoStatus(2, A))), []);
  // KaraFun ignore les options d'ajout : chaque voix rattrapée une fois, au titre chargé.
  assert.deepEqual(bare(frames(isoStatus(3, A))), [volumeTo(5, 50), volumeTo(6, 25)]);
  assert.deepEqual(f.events('song.settingsCaughtUp').map(e => e.fields), [['guide', 'guideVoices.6']]);
  const trA = f.tracked().find(tr => tr.queueId === 'A-id');
  // En direct, la voix 2 seule.
  assert.deepEqual(bare(frames(isoStatus(4, A, { guide: 50, guideB: 25 }))), []);
  await f.call('POST /api/staff/kf', { action: 'track', track: 6, value: 75, queueId: 'A-id' });
  assert.deepEqual(bare(frames(isoStatus(4, A, { guide: 50, guideB: 75 }))), [volumeTo(6, 75)]);
  assert.deepEqual(plain(trA.sel.song.settings), { guide: 50, guideVoices: { 6: 75 } });
  assert.deepEqual(plain(f.staffState().songSettings.live.voices), { 5: 50, 6: 75 });
  // Duo sur le même genre de titre : la voix 2 seule réglée, la voix 1 ne la suit pas.
  const duet = f.sched.inviteDuet(tom.person, zoe.person.id, { songId: 12459, title: 'Titre 12459', artist: 'Artiste' });
  await f.call('POST /api/table/song/settings', { ...tom.body, entryId: duet.entryId, settings: { guideVoices: { 6: 50 } } });
  const addB = sendNow();
  assert.equal(f.pending().sel.ids.length, 2);
  assert.deepEqual(addB.payload.options.tracks, [{ track: { type: 6 }, volume: 50 }]);
  const B = isoItem('B-id', 12459, addB.payload.options, two);
  assert.deepEqual(bare(frames({ id: addB.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, B))), []);
  // KaraFun collant : B garde les voix de A (50 et 75) et ignore ses options.
  const carriedB = { guide: 50, guideB: 75 };
  assert.deepEqual(bare(frames(isoStatus(1, B), queueEvent(B), isoStatus(2, B, carriedB))), []);
  assert.deepEqual(bare(frames(isoStatus(3, B, carriedB))), [volumeTo(5, 0), volumeTo(6, 50)]);
  assert.deepEqual(bare(frames(isoStatus(4, B, { guideB: 50 }))), [], 'une seule fois');
  assert.deepEqual(f.events('song.settingsReset').map(e => [e.queueId, e.fields]), [['B-id', ['guide']]]);
  assert.deepEqual(f.events('song.settingsCaughtUp').at(-1).fields, ['guideVoices.6']);
  // Titre suivant sans réglage, avec une troisième voix annoncée : toutes reviennent à 0.
  f.sched.chooseSong(max.person, { songId: 12460, title: 'Titre 12460', artist: 'Artiste' });
  const addC = sendNow();
  assert.deepEqual(addC.payload.options, { singer: f.pending().sel.label }, 'rien à envoyer pour ce titre');
  const three = [{ type: 4 }, { type: 5 }, { type: 6 }, { type: 7 }];
  const C = isoItem('C-id', 12460, addC.payload.options, three);
  frames({ id: addC.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(B, C));
  const carriedC = { guideB: 50, voices: { 7: 25 } };
  assert.deepEqual(bare(frames(isoStatus(1, C), queueEvent(C), isoStatus(2, C, carriedC))), []);
  assert.deepEqual(bare(frames(isoStatus(3, C, carriedC))), [volumeTo(6, 0), volumeTo(7, 0)]);
  assert.deepEqual(f.events('song.settingsReset').at(-1).fields, ['guideVoices.6', 'guideVoices.7']);
  // Titre sans voix 2 : son réglage de voix 2 est ignoré, la voix 1 appliquée.
  assert.deepEqual(bare(frames(isoStatus(4, C))), []);
  f.sched.chooseSong(ivy.person, { songId: 12461, title: 'Titre 12461', artist: 'Artiste' });
  await f.call('POST /api/table/song/settings', { ...ivy.body, entryId: ivy.person.song.entryId,
    settings: { guide: 25, guideVoices: { 6: 50 } } });
  const addD = sendNow();
  assert.deepEqual(addD.payload.options.tracks, [{ track: { type: 5 }, volume: 25 }, { track: { type: 6 }, volume: 50 }],
    'pistes encore inconnues : KaraFun ignore celles que le titre n’a pas');
  const D = isoItem('D-id', 12461, addD.payload.options, [{ type: 4 }, { type: 5 }]);
  frames({ id: addD.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(C, D));
  assert.deepEqual(bare(frames(isoStatus(1, D), queueEvent(D), isoStatus(2, D), isoStatus(3, D))), [volumeTo(5, 25)]);
  assert.ok(zoe.person);
});

// Sans le droit « Personnaliser la chanson en cours » : l'avis nomme chaque voix restée.
test('voix guides : avis au bar avec chaque voix du titre précédent restée, nommée voix 1, voix 2', async t => {
  const run = aThenB(t, { permissions: { ...ADMIN, manageVolumes: false }, songTracks: [{ type: 4 }, { type: 5 }, { type: 6 }] });
  const { f, frames } = run;
  frames(isoStatus(4, run.A, { guide: 25, guideB: 50 }));
  playB(run, { guide: 25, guideB: 50 });
  assert.deepEqual(resetNotes(f), ['Le réglage du titre précédent est peut-être resté sur « voix 1 25, voix 2 50 » : KaraFun ne laisse pas l’application personnaliser la chanson en cours.']);
});

test('titre isolé : réglage en direct envoyé pendant le changement de titre refusé, rien enregistré sur le nouveau', async t => {
  const run = aThenB(t);
  const { f, frames, trA, trB } = run;
  playB(run, {});
  const before = f.events('song.settings').length;
  await rejects(f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 25, queueId: 'A-id' }), null,
    /^Le titre a changé : réglage non envoyé\.$/);
  assert.deepEqual(bare(frames()), [], 'rien envoyé à KaraFun');
  assert.equal(trB.sel.song.settings, undefined, 'rien sur B');
  assert.equal(trA.sel.song.settings, undefined, 'ni sur A');
  assert.equal(f.events('song.settings').length, before, 'rien au journal');
  // Le bon titre : réglé.
  await f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 25, queueId: 'B-id' });
  assert.deepEqual(bare(frames()), [volumeTo(5, 25)]);
  assert.deepEqual(plain(trB.sel.song.settings), { guide: 25 });
});

test('titre isolé : chœurs remis à la valeur du KaraFun du bar seulement si le titre précédent les avait changés', async t => {
  // Chœurs coupés en direct sur A, KaraFun collant : B revient à 53 (valeur relevée), qui n'est pas réapprise.
  const run = aThenB(t);
  await run.f.call('POST /api/staff/kf', { action: 'track', track: 'backing', value: 0, queueId: 'A-id' });
  assert.deepEqual(bare(run.frames(isoStatus(4, run.A, { backing: 0 }))), [volumeTo(4, 0)]);
  assert.deepEqual(playB(run, { backing: 0 }).find(([step]) => step === 'état 3')[1], [volumeTo(4, 53)]);
  assert.deepEqual(run.f.events('song.settingsReset').map(e => e.fields), [['backing']]);
  assert.equal(run.bridge.songSettingsDefaults().backing, 53);
  // A n'a pas touché aux chœurs : B les garde tels que KaraFun les donne.
  const other = aThenB(t);
  assert.deepEqual(playB(other, { backing: 30 }).flatMap(([, out]) => out), []);
  assert.deepEqual(other.f.events('song.settingsReset'), []);
});

test('titre isolé : titre ajouté directement dans KaraFun, ses propres options KaraFun d’abord, une seule fois', async t => {
  const run = aThenB(t);
  const { f, frames } = run;
  await f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 25, queueId: 'A-id' });
  await f.call('POST /api/staff/kf', { action: 'pitch', value: 2, queueId: 'A-id' });
  frames(isoStatus(4, run.A, { guide: 25, pitch: 2 }));
  // Le bar a mis un titre avant B dans KaraFun, avec sa propre tonalité (-1).
  const own = isoItem('C-id', 777, { singer: 'Quelqu’un', pitch: -1 });
  const carried = { guide: 25, pitch: 2 };
  assert.deepEqual(bare(frames(isoStatus(1, own), queueEvent(own, run.B), isoStatus(2, own, carried))), []);
  assert.deepEqual(bare(frames(isoStatus(3, own, carried))), [pitchTo(-1), volumeTo(5, 0)]);
  assert.deepEqual(bare(frames(isoStatus(4, own, carried), isoStatus(4, own, carried))), [], 'une seule fois');
  assert.deepEqual(f.events('song.settingsReset').map(e => [e.queueId, e.entryId, e.fields]), [['C-id', null, ['pitch', 'guide']]]);
  // Réglé en direct ensuite : pas « remis » une seconde fois.
  await f.call('POST /api/staff/kf', { action: 'pitch', value: 3, queueId: 'C-id' });
  assert.deepEqual(bare(frames(isoStatus(4, own, { pitch: 3 }))), [pitchTo(3)]);
  // Sans le droit : l'avis, pas de trame.
  const g = aThenB(t, { permissions: { ...ADMIN, manageVolumes: false } });
  g.frames(isoStatus(4, g.A, { tempo: 10 }));
  const native = isoItem('D-id', 778, { singer: 'Quelqu’un' });
  assert.deepEqual(bare(g.frames(isoStatus(1, native), queueEvent(native), isoStatus(3, native, { tempo: 10 }))), []);
  assert.deepEqual(resetNotes(g.f), ['Le réglage du titre précédent est peut-être resté sur « tempo +10 % » : KaraFun ne laisse pas l’application personnaliser la chanson en cours.']);
  // Battle lancée depuis KaraFun : KaraFun garde la main, la file n'y touche pas.
  const h = aThenB(t);
  h.frames(isoStatus(4, h.A, { pitch: 2 }));
  const battle = isoItem('E-id', 779, { singer: 'Battle', mod: BATTLE_MOD });
  assert.deepEqual(bare(h.frames(isoStatus(1, battle), queueEvent(battle), isoStatus(3, battle, { pitch: 2 }))), []);
  assert.deepEqual(h.f.events('song.settingsReset'), []);
});

test('titre isolé : pendant une relance ⏮, le titre en cours n’est pas pris pour un titre ajouté dans KaraFun', async () => {
  for (const abandon of [false, true]) {
    const f = harness();
    const link = kcsBridge(f);
    const tb = openTable(f, '1');
    singer(f, tb, 'Léa', 101);
    const tr = sendNext(f, 'q-1', { startedAt: Date.now() });
    const item = kfItem('q-1', 101, tr.sel.label);
    link.bridge.queue = [item];
    link.bridge.status = playing(item);
    f.sync();
    await f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 25, queueId: 'q-1' });
    link.bridge.status = playing(item, { tracks: [{ volume: 100, track: { type: 4 } }, { volume: 25, track: { type: 5 } }] });
    f.sync();
    await f.call('POST /api/staff/kf', { action: 'restart' });
    const before = link.sent.length;
    // La copie arrive : le suivi passe sur elle, le titre d'origine joue encore.
    const copy = kfItem(abandon ? 'q-3' : 'q-2', 101, tr.sel.label);
    link.bridge.queue = abandon ? [item, kfItem('n-9', 555, 'Autre'), copy] : [item, copy];
    f.sync();
    f.sync();
    assert.deepEqual(link.sent.slice(before).filter(m => m.type === 'remote.TrackVolumeRequest'), [],
      abandon ? 'relance abandonnée : le titre continue avec sa voix guide' : 'aucune remise à zéro du titre qui se termine');
    assert.deepEqual(f.events('song.settingsReset'), []);
  }
});

test('titre isolé : une Battle de la file garde le réglage de KaraFun, comme celle ajoutée dans KaraFun', async () => {
  const f = harness();
  const link = kcsBridge(f);
  singer(f, openTable(f, '1'), 'Léa', 101);
  const tr = sendNext(f, 'q-1');
  const item = kfItem('q-1', 101, tr.sel.label, { options: { mod: BATTLE_MOD } });
  link.bridge.queue = [item];
  link.bridge.status = playing(item, { pitch: 2, tracks: [{ volume: 100, track: { type: 4 } }, { volume: 25, track: { type: 5 } }] });
  f.sync();
  assert.deepEqual(link.sent, [], 'rien pendant une Battle');
  assert.equal(tr.liveChecked, 'q-1');
  // Le titre suivant, lui, repart des valeurs neutres.
  const next = kfItem('n-2', 102, 'Quelqu’un');
  link.bridge.queue = [next];
  link.bridge.status = playing(next, { pitch: 2 });
  f.sync();
  assert.deepEqual(link.sent, [{ type: 'remote.PitchRequest', payload: { pitch: 0 } }]);
});

// ---------------------------------------------------------------- relecture finale (lot serveur)
// Regression: relecture finale C2 — une page gardée en cache d'avant les voix
// guides par voix envoie ses réglages sans `guideVoices` : le serveur
// remplaçait tout et effaçait le réglage de la voix 2. Sans la clé, les
// autres voix guides du titre restent ; les nouvelles pages l'envoient
// toujours ({} quand il n'y en a plus).
test('ancienne page sans guideVoices : les réglages des autres voix guides du titre sont gardés', async () => {
  const f = harness();
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  const entryId = lea.person.song.entryId;
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { guide: 50, guideVoices: { 6: 75 } } });
  // Page des chanteurs d'avant la mise à jour.
  const old = await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { pitch: 2, guide: 50 } });
  assert.deepEqual(plain(lea.person.song.settings), { pitch: 2, guide: 50, guideVoices: { 6: 75 } });
  assert.deepEqual(plain(old.settings), { pitch: 2, guide: 50, guideVoices: { 6: 75 } });
  // Page du bar d'avant la mise à jour : même règle, remise par défaut comprise.
  await f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId, settings: { tempo: -10 } });
  assert.deepEqual(plain(lea.person.song.settings), { tempo: -10, guideVoices: { 6: 75 } });
  await f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId, settings: null });
  assert.deepEqual(plain(lea.person.song.settings), { guideVoices: { 6: 75 } }, 'ce que l’ancienne page ne montre pas reste');
  // Nouvelle page : la clé est là, vide quand la voix 2 n'est plus réglée.
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { pitch: 1, guideVoices: { 6: 25 } } });
  assert.deepEqual(plain(lea.person.song.settings), { pitch: 1, guideVoices: { 6: 25 } });
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { pitch: 1, guideVoices: {} } });
  assert.deepEqual(plain(lea.person.song.settings), { pitch: 1 });
  await f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId, settings: { guideVoices: {} } });
  assert.equal(lea.person.song.settings ?? null, null);
});

// Regression: relecture finale R1 — après un redémarrage de l'application, le
// premier état vu (titre ajouté directement dans KaraFun, déjà en lecture)
// était pris pour un titre tout juste chargé : valeurs neutres envoyées en
// pleine chanson, réglages en direct du bar effacés.
test('redémarrage pendant un titre ajouté dans KaraFun : ses réglages en direct ne sont pas remis à zéro', async t => {
  for (const state of [4, 5]) {
    const f = harness();
    const { frames } = replayBridge(t, f);
    const own = isoItem('X-id', 777, { singer: 'Quelqu’un' });
    const live = { pitch: 2, tempo: 10, guide: 25, backing: 0 };
    assert.deepEqual(bare(frames(queueEvent(own), isoStatus(state, own, live))), [], `état ${state} : rien en pleine chanson`);
    assert.deepEqual(bare(frames(isoStatus(4, own, live), isoStatus(5, own, live))), []);
    assert.deepEqual(f.events('song.settingsReset'), []);
    assert.deepEqual(resetNotes(f), []);
    // Le titre suivant, vu se charger, reste isolé du précédent.
    const next = isoItem('Y-id', 778, { singer: 'Autre' });
    assert.deepEqual(bare(frames(isoStatus(1, next), queueEvent(next), isoStatus(2, next, live))), []);
    assert.deepEqual(bare(frames(isoStatus(3, next, live))), [pitchTo(0), { type: 'remote.TempoRequest', payload: { tempo: 0 } }, volumeTo(5, 0)]);
  }
});

// Regression: relecture finale R2 — tonalité changée par le bar dans
// l'application KaraFun sur un titre de la file : remise à 0 à son chargement
// (le titre ajouté directement dans KaraFun, lui, gardait ses options).
test('titre de la file réglé dans KaraFun même : sa tonalité KaraFun est gardée à son chargement', async t => {
  for (const applied of [true, false]) {
    const run = aThenB(t);
    const { f, frames, A, B } = run;
    await f.call('POST /api/staff/kf', { action: 'pitch', value: 2, queueId: 'A-id' });
    frames(isoStatus(4, A, { pitch: 2 }));
    // Le bar règle B dans KaraFun : tonalité +3 dans les options du titre.
    const tuned = { ...B, song: { ...B.song, options: { ...B.song.options, pitch: 3 } } };
    assert.deepEqual(bare(frames(queueEvent(A, tuned))), []);
    // KaraFun collant qui applique (ou non) les options de B.
    const carried = { pitch: applied ? 3 : 2 };
    assert.deepEqual(bare(frames(isoStatus(1, tuned), queueEvent(tuned), isoStatus(2, tuned, carried))), []);
    assert.deepEqual(bare(frames(isoStatus(3, tuned, carried))), applied ? [] : [pitchTo(3)], 'la valeur de KaraFun, pas 0');
    assert.deepEqual(bare(frames(isoStatus(4, tuned, { pitch: 3 }))), []);
  }
});

// Regression: vérification de la relecture R1 — coupure de la télécommande :
// pendant la coupure, un titre ajouté dans KaraFun démarre et le bar le règle
// dans KaraFun. À la reconnexion, son premier état vu est la lecture : il
// était remis aux valeurs neutres en pleine chanson (un titre déjà vu avant
// la coupure suffisait). Seul un titre vu se charger est remis.
test('reconnexion pendant un titre ajouté dans KaraFun : ses réglages en direct ne sont pas remis à zéro', async t => {
  const f = harness();
  const { frames, reconnect } = replayBridge(t, f);
  const x = isoItem('X-id', 777, { singer: 'Quelqu’un' });
  frames(queueEvent(x), isoStatus(1, x), isoStatus(2, x), isoStatus(3, x), isoStatus(4, x));
  reconnect();
  const y = isoItem('Y-id', 778, { singer: 'Autre' });
  const live = { pitch: 2, tempo: 10, guide: 25 };
  assert.deepEqual(bare(frames(queueEvent(y), isoStatus(4, y, live))), [], 'rien en pleine chanson');
  assert.deepEqual(bare(frames(isoStatus(5, y, live), isoStatus(4, y, live))), []);
  assert.deepEqual(f.events('song.settingsReset'), []);
  // Le titre suivant, vu se charger, reste isolé.
  const z = isoItem('Z-id', 779, { singer: 'Encore' });
  assert.deepEqual(bare(frames(isoStatus(1, z), queueEvent(z), isoStatus(2, z, live))), []);
  assert.deepEqual(bare(frames(isoStatus(3, z, live))), [pitchTo(0), { type: 'remote.TempoRequest', payload: { tempo: 0 } }, volumeTo(5, 0)]);
});

// Regression: vérification de la relecture R1 — premier titre de
// l'application vu annoncé puis se charger (états 1 et 2), puis directement
// en lecture (sans trame d'état 3) : il n'était plus isolé du précédent.
test('titre vu se charger (états 1 et 2) puis directement en lecture : remis aux valeurs neutres', async t => {
  const f = harness();
  const { frames } = replayBridge(t, f);
  const y = isoItem('Y-id', 778, { singer: 'Autre' });
  const live = { pitch: 2, tempo: 10, guide: 25 };
  assert.deepEqual(bare(frames(isoStatus(1, y), queueEvent(y), isoStatus(2, y, live))), []);
  assert.deepEqual(bare(frames(isoStatus(4, y, live))), [pitchTo(0), { type: 'remote.TempoRequest', payload: { tempo: 0 } }, volumeTo(5, 0)]);
  // Même trames reçues d'un bloc avant la synchronisation.
  const g = harness();
  const other = replayBridge(t, g);
  assert.deepEqual(bare(other.frames(isoStatus(1, y), queueEvent(y), isoStatus(2, y, live), isoStatus(4, y, live))),
    [pitchTo(0), { type: 'remote.TempoRequest', payload: { tempo: 0 } }, volumeTo(5, 0)]);
});

// Regression: deuxième relecture finale R1 — titre de la file vu pour la
// première fois déjà en lecture (application redémarrée, ou télécommande
// reconnectée, en pleine chanson) : le rattrapage du titre visait encore les
// valeurs neutres, remises à 0 en pleine chanson (et song.settingsReset au
// journal). Seuls ses propres réglages sont rattrapés ; le titre suivant, vu
// se charger, reste isolé (KaraFun collant) ou n'a rien à recevoir.
const tempoTo = tempo => ({ type: 'remote.TempoRequest', payload: { tempo } });
for (const sticky of [false, true]) {
  test(`redémarrage ou reconnexion pendant un titre de la file : réglages en direct gardés, seuls les siens rattrapés (KaraFun ${sticky ? 'collant' : 'qui remet à zéro'})`, async t => {
    for (const own of [null, { guide: 50 }]) {
      for (const how of ['redémarrage', 'reconnexion']) {
        const f = harness();
        const { frames, reconnect } = replayBridge(t, f);
        const tb = openTable(f, '1');
        const lea = singer(f, tb, 'Léa', 777);
        const zoe = singer(f, tb, 'Zoé', 778);
        if (how === 'reconnexion') {
          // Titre d'avant la coupure, vu se charger puis chanté.
          const before = isoItem('W-id', 776, { singer: 'Quelqu’un' });
          frames(queueEvent(before), isoStatus(1, before), isoStatus(2, before), isoStatus(3, before), isoStatus(4, before));
          reconnect();
        }
        // Titre de la file (repris de la sauvegarde, ou lancé pendant la coupure).
        const tr = sendNext(f, 'X-id');
        if (own) f.sched.setSongSettings(tr.sel.song, own);
        const x = isoItem('X-id', tr.sel.song.songId, { singer: tr.sel.label });
        const live = { pitch: 2, tempo: 10, guide: 25, backing: 0 };
        const label = `${how}, ${own ? 'voix guide 50 choisie' : 'sans réglage'}`;
        assert.deepEqual(bare(frames(queueEvent(x), isoStatus(4, x, live))), own ? [volumeTo(5, 50)] : [], `${label} : rien de neutre en pleine chanson`);
        const held = { ...live, guide: own ? 50 : 25 };
        assert.deepEqual(bare(frames(isoStatus(5, x, held), isoStatus(4, x, held))), [], label);
        assert.deepEqual(f.events('song.settingsReset'), [], label);
        assert.deepEqual(f.events('song.settingsCaughtUp').map(e => e.fields), own ? [['guide']] : [], label);
        assert.deepEqual(resetNotes(f), [], label);
        // Titre suivant de la file, vu se charger.
        const trY = sendNext(f, 'Y-id');
        assert.deepEqual([tr.sel.ids[0], trY.sel.ids[0]].sort(), [lea.person.id, zoe.person.id].sort());
        const y = isoItem('Y-id', trY.sel.song.songId, { singer: trY.sel.label });
        const loaded = sticky ? held : {};
        assert.deepEqual(bare(frames(queueEvent(x, y), isoStatus(1, y), queueEvent(y), isoStatus(2, y, loaded))), [], label);
        // Chœurs relevés (53) avant la coupure : gardés, jamais réappris des chœurs 0 du titre en cours.
        const backing = how === 'reconnexion' ? [volumeTo(4, 53)] : [];
        assert.deepEqual(bare(frames(isoStatus(3, y, loaded))),
          sticky ? [pitchTo(0), tempoTo(0), ...backing, volumeTo(5, 0)] : [], `${label} : titre suivant isolé`);
      }
    }
  });
}

// Regression: deuxième relecture finale R2 — chœurs par défaut relevés sur le
// KaraFun du bar : gardés dans la sauvegarde avec l'empreinte du code, repris
// au redémarrage (même code seulement). Avec un KaraFun collant relancé en
// pleine chanson, le titre suivant revient aux chœurs relevés (53) au lieu
// d'apprendre ceux gardés du titre en cours.
test('chœurs par défaut relevés gardés dans la sauvegarde et repris au redémarrage (KaraFun collant)', async t => {
  const f = harness();
  const { bridge, frames } = replayBridge(t, f);
  bridge.code = '123456';
  const a = isoItem('A-id', 776, { singer: 'Quelqu’un' });
  frames(queueEvent(a), isoStatus(1, a), isoStatus(2, a), isoStatus(3, a));
  const saved = plain(f.settings.karafunDefaults);
  assert.equal(saved?.backing, 53, 'relevé puis gardé dans les réglages sauvegardés');
  assert.match(saved.code, /^[0-9a-f]{16}$/, 'empreinte du code, jamais le code');
  assert.equal(JSON.stringify(saved).includes('123456'), false);
  // Redémarrage : même code, puis un autre code (autre KaraFun).
  for (const code of ['123456', '654321']) {
    const g = harness();
    g.settings.karafunDefaults = saved;
    const other = replayBridge(t, g);
    other.bridge.code = code;
    g.restoreKaraFunDefaults();
    assert.equal(other.bridge.observedDefaults.backing, code === '123456' ? 53 : undefined, `code ${code}`);
    const x = isoItem('X-id', 777, { singer: 'Quelqu’un' });
    assert.deepEqual(bare(other.frames(queueEvent(x), isoStatus(4, x, { backing: 80 }))), [], 'rien en pleine chanson');
    const y = isoItem('Y-id', 778, { singer: 'Autre' });
    assert.deepEqual(bare(other.frames(isoStatus(1, y), queueEvent(y), isoStatus(2, y, { backing: 80 }))), []);
    assert.deepEqual(bare(other.frames(isoStatus(3, y, { backing: 80 }))), code === '123456' ? [volumeTo(4, 53)] : [],
      `code ${code} : chœurs gardés par KaraFun`);
    assert.equal(other.bridge.observedDefaults.backing, code === '123456' ? 53 : undefined, 'jamais 80');
  }
});

// Regression: deuxième relecture finale R4 — pages gardées en cache d'avant
// les voix guides réglées une à une : leur unique « voix guide » réglait les
// deux voix d'un duo. Sur un duo, un réglage sans `guideVoices` pose aussi la
// voix 2 (comme la reprise d'une ancienne sauvegarde), et le réglage en
// direct d'une ancienne page du bar (sans queueId) règle aussi la piste B.
test('pages d’avant les voix une à une : sur un duo, la voix guide règle aussi la voix 2', async t => {
  const f = harness();
  replayBridge(t, f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa');
  const tom = singer(f, tb, 'Tom');
  const solo = singer(f, tb, 'Zoé', 12460);
  f.sched.inviteDuet(lea.person, tom.person.id, { songId: 12458, title: 'Titre 12458', artist: 'Artiste' });
  const entryId = lea.person.song.entryId;
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { guide: 50, guideVoices: { 6: 75 } } });
  // Ancienne page des chanteurs : voix guide 40, la voix 2 suit.
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { pitch: 1, guide: 40 } });
  assert.deepEqual(plain(lea.person.song.settings), { pitch: 1, guide: 40, guideVoices: { 6: 40 } });
  // Ancienne page du bar : même règle.
  await f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId, settings: { guide: 20 } });
  assert.deepEqual(plain(lea.person.song.settings), { guide: 20, guideVoices: { 6: 20 } });
  // Page actuelle : la clé est là, chaque voix seule.
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { guide: 30, guideVoices: {} } });
  assert.deepEqual(plain(lea.person.song.settings), { guide: 30 });
  // Solo : la voix 2 ne suit pas.
  await f.call('POST /api/table/song/settings', { ...solo.body, entryId: solo.person.song.entryId, settings: { guideVoices: { 6: 75 } } });
  await f.call('POST /api/table/song/settings', { ...solo.body, entryId: solo.person.song.entryId, settings: { guide: 40 } });
  assert.deepEqual(plain(solo.person.song.settings), { guide: 40, guideVoices: { 6: 75 } });
});

test('ancienne page du bar : la voix guide en direct d’un duo de la file règle aussi la piste B', async t => {
  const songTracks = [{ type: 4 }, { type: 5 }, { type: 6 }];
  const run = aThenB(t, { duoA: true, songTracks });
  const { f, frames, trA } = run;
  assert.equal(trA.sel.ids.length, 2);
  assert.deepEqual(plain(await f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 30 })),
    { ok: true, field: 'guide', value: 30 });
  assert.deepEqual(bare(frames(isoStatus(4, run.A, { guide: 30, guideB: 30 }))), [volumeTo(5, 30), volumeTo(6, 30)]);
  assert.deepEqual(plain(trA.sel.song.settings), { guide: 30, guideVoices: { 6: 30 } });
  // Page actuelle (avec queueId) : la voix 1 seule.
  await f.call('POST /api/staff/kf', { action: 'track', track: 'guide', value: 10, queueId: 'A-id' });
  assert.deepEqual(bare(frames(isoStatus(4, run.A, { guide: 10, guideB: 30 }))), [volumeTo(5, 10)]);
  assert.deepEqual(plain(trA.sel.song.settings), { guide: 10, guideVoices: { 6: 30 } });
});
