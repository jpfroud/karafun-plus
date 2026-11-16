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
const crypto = require('node:crypto');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { KaraFunBridge, normalizeKcsItem, BATTLE_MOD } = require('../karafun');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

// `setTimeout` : minuterie donnée au serveur (par défaut, aucune ne part) ;
// `Date` : horloge du serveur (par défaut, la vraie) ; `persistent` : serveur
// sans --demo, faux magasin de soirée (sauvegardes gardées dans `f.saves`),
// sans Java ni fichier Spotify (comme stage-progress-server.test.js).
function harness({ setTimeout: later = () => ({ unref() {} }), Date: clock = null, persistent = false } = {}) {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const saves = [];
  const overrides = persistent ? {
    './night-state': { ...fromServer('./night-state'), NightStateStore: class {
      load() { return null; }
      save(snapshot) { saves.push(plain(snapshot)); return true; }
    } },
    './scheduler': (() => {
      const real = fromServer('./scheduler');
      return { ...real, Scheduler: class extends real.Scheduler { constructor(o) { super({ ...o, solverEnabled: false }); } } };
    })(),
    './spotify': (() => {
      const real = fromServer('./spotify');
      return { ...real, SpotifyLink: class extends real.SpotifyLink { constructor(o) { super({ ...o, file: null }); } } };
    })(),
  } : {};
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), ...(persistent ? [] : ['--demo'])];
  // Lignes du journal du serveur (appLog), gardées pour les essais.
  const logs = [];
  const context = { require: name => name === 'fs' ? quietFs : overrides[name] || fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log: (...args) => logs.push(args.join(' ')) }, Buffer, URL,
    setTimeout: later, clearTimeout() {}, setImmediate, AbortSignal, ...(clock ? { Date: clock } : {}) };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, handlers, access, journal, sync, staffState, publicState, battleVote, clearEvening,
      resendWithoutOptions, restoreKaraFunDefaults: typeof restoreKaraFunDefaults === 'function' ? restoreKaraFunDefaults : null,
      safeSync: typeof safeSync === 'function' ? safeSync : null, wireBridge, connectionAnswer,
      syncAfterChange: typeof syncAfterChange === 'function' ? syncAfterChange : null,
      connectKaraFun, spotify, karaokeOutlook, spotifyTick, spotifyAutomation, setCode: code => { CODE = code; }, rememberBattleSongs,
      serverUpdate, tracked: () => tracked, pending: () => pending, setBridge: b => { bridge = b; },
      handle: server.listeners('request')[0], STAFF_KEY, PORT };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.logs = logs;
  f.saves = saves;
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
  return { bridge, get ws() { return ws; }, frames, reconnect, receive };
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
  const tom = singer(f, tb, 'Tom');
  const duo = f.sched.inviteDuet(lea.person, tom.person.id, { songId: 102, title: 'Duo', artist: 'Artiste' });
  // Titre de Tom ajouté après le duo : premiers passages dans l'ordre d'ajout.
  f.sched.chooseSong(tom.person, { songId: 201, title: 'Titre 201', artist: 'Artiste' });
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
// Options d'ajout telles que KaraFun les renvoie dans sa file et son état :
// recopiées en septembre 2026, complétées d'une liste de pistes vide par le
// KaraFun des essais réels du 6 novembre (`{ tracks: [], singer }`).
const KF_ECHO = Object.freeze({ septembre: options => options, novembre: options => ({ tracks: [], ...options }) });
// Titre A envoyé et en lecture, titre B envoyé derrière lui (sans réglage
// sauf `bSettings`). `duoA` : A est un duo. `echo` : options renvoyées par
// KaraFun (KF_ECHO). Rend de quoi jouer la suite.
function aThenB(t, { permissions = ADMIN, bSettings = null, songTracks, duoA = false, echo = KF_ECHO.septembre } = {}) {
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
  const A = isoItem('A-id', addA.payload.song.id, echo(addA.payload.options), songTracks);
  assert.deepEqual(bare(frames({ id: addA.id, type: 'remote.AddToQueueResponse', payload: {} }, isoStatus(1, A), queueEvent(A),
    isoStatus(2, A), isoStatus(3, A), isoStatus(4, A))), [], 'A sans réglage, KaraFun aux valeurs par défaut : rien');
  f.settings.auto = true;
  const addB = frames().find(m => m.type === 'remote.AddToQueueRequest');
  f.settings.auto = false;
  assert.equal(f.pending().sel.ids[0], zoe.person.id);
  const B = isoItem('B-id', addB.payload.song.id, echo(addB.payload.options), songTracks);
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

// Regression: relecture de l'étape 1 Socket.IO (issue #59) — avec les options
// du KaraFun de novembre 2026 (`tracks: []`), les chœurs par défaut n'étaient
// jamais relevés : coupés pour un chanteur, ils restaient coupés pour les
// suivants.
for (const form of Object.keys(KF_ECHO)) {
  test(`titre isolé : chœurs remis à la valeur du KaraFun du bar seulement si le titre précédent les avait changés (options de ${form})`, async t => {
    const echo = KF_ECHO[form];
    // Chœurs coupés en direct sur A, KaraFun collant : B revient à 53 (valeur relevée), qui n'est pas réapprise.
    const run = aThenB(t, { echo });
    await run.f.call('POST /api/staff/kf', { action: 'track', track: 'backing', value: 0, queueId: 'A-id' });
    assert.deepEqual(bare(run.frames(isoStatus(4, run.A, { backing: 0 }))), [volumeTo(4, 0)]);
    assert.deepEqual(playB(run, { backing: 0 }).find(([step]) => step === 'état 3')[1], [volumeTo(4, 53)]);
    assert.deepEqual(run.f.events('song.settingsReset').map(e => e.fields), [['backing']]);
    assert.equal(run.bridge.songSettingsDefaults().backing, 53);
    // A n'a pas touché aux chœurs : B les garde tels que KaraFun les donne.
    const other = aThenB(t, { echo });
    assert.deepEqual(playB(other, { backing: 30 }).flatMap(([, out]) => out), []);
    assert.deepEqual(other.f.events('song.settingsReset'), []);
  });
}

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

// Regression: contre-relecture RT4 — KaraFun relancé (même code) renumérote
// sa file depuis 1. Le titre 1 d'avant, vu se charger, et le titre 1 d'après,
// lancé pendant la coupure et vu pour la première fois déjà en lecture,
// étaient confondus (pont et serveur) : valeurs neutres envoyées en pleine
// chanson. Une nouvelle session KCS oublie ce qui a été vu se charger.
test('KaraFun relancé, numéros de file repris depuis 1 : le titre 1 déjà en lecture n’est pas remis à zéro', async t => {
  const f = harness();
  const { frames, reconnect } = replayBridge(t, f);
  const old = isoItem('1', 776, { singer: 'Quelqu’un' });
  frames(queueEvent(old), isoStatus(1, old), isoStatus(2, old), isoStatus(3, old), isoStatus(4, old));
  reconnect();
  singer(f, openTable(f, '1'), 'Léa', 777);
  const tr = sendNext(f, '1');
  const x = isoItem('1', tr.sel.song.songId, { singer: tr.sel.label });
  const live = { pitch: 2, tempo: 10, guide: 25 };
  assert.deepEqual(bare(frames(queueEvent(x), isoStatus(4, x, live))), [], 'rien en pleine chanson');
  assert.deepEqual(bare(frames(isoStatus(5, x, live), isoStatus(4, x, live))), []);
  assert.deepEqual(f.events('song.settingsReset'), []);
  // Le titre suivant, vu se charger dans la nouvelle session, reste isolé.
  const y = isoItem('2', 778, { singer: 'Autre' });
  assert.deepEqual(bare(frames(isoStatus(1, y), queueEvent(y), isoStatus(2, y, live))), []);
  assert.deepEqual(bare(frames(isoStatus(3, y, live))), [pitchTo(0), tempoTo(0), volumeTo(5, 0)]);
});

// Regression: vérification de la contre-relecture RT4 — coupure pendant
// que le titre suivant est annoncé (état 1), après un titre vu pour la
// première fois en pleine chanson avec des chœurs à 80 réglés en direct,
// gardés par un KaraFun collant : 80 était sauvegardé comme chœurs par
// défaut du KaraFun (repris à chaque redémarrage). Vérification de la
// troisième relecture finale R4 : sauvegardés seulement comme provisoires.
test('coupure pendant l’état 1 après un titre vu en pleine chanson : chœurs en direct jamais sauvegardés comme défaut confirmé', async t => {
  const f = harness();
  const { bridge, frames, reconnect } = replayBridge(t, f);
  bridge.code = '123456';
  const a = isoItem('10', 900, { singer: 'Bar' });
  const b = isoItem('11', 901, { singer: 'Autre' });
  frames(queueEvent(a, b), isoStatus(4, a, { backing: 80 }));
  frames(queueEvent(b), isoStatus(1, b));
  reconnect();
  frames(queueEvent(b), isoStatus(1, b), isoStatus(2, b, { backing: 80 }), isoStatus(3, b, { backing: 80 }), isoStatus(4, b, { backing: 80 }));
  assert.equal(bridge.provisionalDefaults, true);
  assert.equal(plain(f.settings.karafunDefaults)?.provisional, true, 'réglage en direct sauvegardé comme chœurs par défaut confirmés');
});

// Regression: vérification de la contre-relecture RT4 — une nouvelle
// session KCS suffisait à faire d'un titre déjà chargé un nouveau titre :
// titre ajouté dans KaraFun, remis aux valeurs neutres à l'état 3, tonalité
// réglée ensuite par le bar avant « Lecture », puis coupure : à la reprise
// (même titre, même numéro, toujours à l'état 3), la tonalité du bar était
// remise à 0. Même numéro de file et même chanson : même titre.
test('coupure pendant l’état 3 d’un titre ajouté dans KaraFun : la tonalité réglée ensuite par le bar est gardée', async t => {
  const f = harness();
  const { frames, reconnect } = replayBridge(t, f);
  const a = isoItem('1', 900, { singer: 'Bar' });
  const b = isoItem('2', 901, { singer: 'Bar2' });
  frames(queueEvent(a, b), isoStatus(1, a), isoStatus(2, a), isoStatus(3, a), isoStatus(4, a));
  assert.deepEqual(bare(frames(queueEvent(b), isoStatus(1, b), isoStatus(2, b, { pitch: 1 }), isoStatus(3, b, { pitch: 1 }))), [pitchTo(0)]);
  assert.deepEqual(bare(frames(isoStatus(3, b, { pitch: 2 }))), []); // réglé par le bar dans KaraFun
  reconnect();
  assert.deepEqual(bare(frames(queueEvent(b), isoStatus(3, b, { pitch: 2 }))), [], 'tonalité du bar remise à 0 à la reprise');
  assert.deepEqual(bare(frames(isoStatus(4, b, { pitch: 2 }))), []);
  // KaraFun relancé, numéro 2 repris par une autre chanson qui se charge : nouveau titre.
  reconnect();
  const c = isoItem('2', 902, { singer: 'Bar3' });
  assert.deepEqual(bare(frames(queueEvent(c), isoStatus(1, c), isoStatus(2, c, { pitch: 2 }), isoStatus(3, c, { pitch: 2 }))), [pitchTo(0)]);
});

// Regression: vérification de la contre-relecture RT4 — ancienne
// télécommande (faux KaraFun de la démo, réglages permis) : après une
// reconnexion, le titre ajouté dans KaraFun en cours de lecture passait pour
// un nouveau titre vu se charger, et sa tonalité réglée en direct était
// remise à 0 en pleine chanson.
test('ancienne télécommande : reconnexion en pleine chanson d’un titre ajouté dans KaraFun, rien remis', async t => {
  const f = harness();
  const bridge = new KaraFunBridge({ bases: ['http://127.0.0.1:9'] });
  t.after(() => bridge.disconnect());
  f.setBridge(bridge);
  const sent = [];
  const up = () => {
    Object.assign(bridge, { protocol: 'socket.io', ready: true, connected: true });
    bridge.permissions = { ...ADMIN, managePlayer: true };
    bridge.socket = { emit(name, payload) { sent.push([name, payload]); }, close() {}, removeAllListeners() {} };
  };
  up();
  const item = (queueId, songId) => ({ queueId, songId, title: `Titre ${songId}`, artist: 'A', singer: 'Bar', status: 'ready', songTracks: [4, 5] });
  const st = (state, it, { pitch = 0, backing = 100, guide = 0 } = {}) => ({ state, songPlaying: it, position: 0, pitch, tempo: 0,
    tracks: it && state === 'playing' ? [{ volume: backing, track: { type: 4 } }, { volume: guide, track: { type: 5 } }] : [] });
  const a = item(1, 500), b = item(2, 501), c = item(3, 502);
  const accept = (queue, status) => { bridge._accept('queue', queue); bridge._accept('status', status); f.sync(); };
  accept([a, b], st('playing', a));
  accept([b], st('idle', b));
  accept([b], st('playing', b));
  accept([b], st('playing', b, { pitch: 2 })); // tonalité +2 réglée en direct
  sent.length = 0;
  bridge.disconnect(); up();
  accept([b], st('playing', b, { pitch: 2 }));
  assert.deepEqual(sent, [], 'rien envoyé en pleine chanson');
  // Coupure pendant la chanson suivante, vue pour la première fois en lecture : rien non plus.
  bridge.disconnect(); up();
  accept([c], st('playing', c, { pitch: 2 }));
  assert.deepEqual(sent, []);
  // Le titre d'après, vu commencer dans cette session, est remis aux valeurs neutres.
  const d = item(4, 503);
  accept([d], st('playing', d, { pitch: 2 }));
  assert.deepEqual(sent, [['pitch', 0]]);
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
// Regression: vérification de la troisième relecture finale R4 — un pont
// neuf part d'une histoire inconnue et un KaraFun collant ne remet jamais
// ses chœurs au chargement : la valeur relevée restait provisoire, n'était
// plus sauvegardée, et un redémarrage réapprenait les chœurs gardés. Elle
// est sauvegardée comme provisoire, et reprise comme telle.
test('chœurs par défaut relevés gardés dans la sauvegarde et repris au redémarrage (KaraFun collant)', async t => {
  const f = harness();
  const { bridge, frames } = replayBridge(t, f);
  bridge.code = '123456';
  const a = isoItem('A-id', 776, { singer: 'Quelqu’un' });
  frames(queueEvent(a), isoStatus(1, a), isoStatus(2, a), isoStatus(3, a));
  const saved = plain(f.settings.karafunDefaults);
  assert.equal(saved?.backing, 53, 'relevé puis gardé dans les réglages sauvegardés');
  assert.equal(saved.provisional, true, 'pont neuf : histoire de KaraFun inconnue, valeur provisoire');
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
    // Autre code, rien de sauvegardé pour lui : 80 relevé pour la soirée à
    // titre provisoire (vérification de la deuxième relecture R2(c)).
    assert.equal(other.bridge.observedDefaults.backing, code === '123456' ? 53 : 80);
    assert.equal(other.bridge.provisionalDefaults, true);
    if (code === '123456') assert.deepEqual(plain(g.settings.karafunDefaults), saved, 'sauvegarde inchangée');
    else assert.deepEqual(plain(g.settings.karafunDefaults), { code: crypto.createHash('sha256').update('karafun:654321').digest('hex').slice(0, 16),
      backing: 80, provisional: true }, 'autre KaraFun : sa valeur provisoire');
  }
});

// Regression: vérification de la troisième relecture finale R4 — KaraFun
// collant, application démarrée sur un KaraFun propre (53) : A puis B à 53,
// chœurs réglés à 80 en direct sur B, redémarrage entre B et C. Rien n'était
// sauvegardé (valeur provisoire) : le pont relancé relevait 80, gardé par
// KaraFun au chargement de C, et ramenait chaque titre suivant à 80.
test('KaraFun collant, redémarrage après des chœurs réglés en direct : la valeur provisoire sauvegardée revient, pas le réglage', async t => {
  const f = harness();
  const { bridge, frames } = replayBridge(t, f);
  bridge.code = '123456';
  const a = isoItem('A-id', 801, { singer: 'Un' });
  const b = isoItem('B-id', 802, { singer: 'Deux' });
  frames(queueEvent(a, b), isoStatus(1, a), isoStatus(2, a), isoStatus(3, a), isoStatus(4, a));
  frames(queueEvent(b), isoStatus(1, b), isoStatus(2, b), isoStatus(3, b), isoStatus(4, b));
  frames(isoStatus(4, b, { backing: 80 })); // réglage en direct
  const saved = plain(f.settings.karafunDefaults);
  assert.equal(saved?.backing, 53, 'valeur relevée gardée pour un redémarrage');
  // Redémarrage entre B et C : KaraFun collant charge C à 80.
  const g = harness();
  g.settings.karafunDefaults = saved;
  const other = replayBridge(t, g);
  other.bridge.code = '123456';
  g.restoreKaraFunDefaults();
  const c = isoItem('C-id', 803, { singer: 'Trois' });
  other.frames(isoStatus(1, c), queueEvent(c), isoStatus(2, c, { backing: 80 }));
  assert.deepEqual(bare(other.frames(isoStatus(3, c, { backing: 80 }))), [], 'titre d’avant inconnu : C laissé tel quel');
  assert.equal(other.bridge.observedDefaults.backing, 53, 'réglage gardé par KaraFun jamais relevé');
  other.frames(isoStatus(4, c, { backing: 80 }), isoStatus(4, c, { backing: 30 })); // réglage en direct sur C
  const d = isoItem('D-id', 804, { singer: 'Quatre' });
  other.frames(isoStatus(1, d), queueEvent(d), isoStatus(2, d, { backing: 30 }));
  assert.deepEqual(bare(other.frames(isoStatus(3, d, { backing: 30 }))), [volumeTo(4, 53)], 'D ramené à 53, pas à 80');
  // KaraFun remet ses chœurs au chargement : valeur définitive, sauvegardée comme telle.
  other.frames(isoStatus(4, d, { backing: 53 }), isoStatus(4, d, { backing: 90 }));
  const e = isoItem('E-id', 805, { singer: 'Cinq' });
  other.frames(isoStatus(1, e), queueEvent(e), isoStatus(2, e, { backing: 60 }));
  assert.equal(other.bridge.provisionalDefaults, false);
  assert.deepEqual(plain(g.settings.karafunDefaults), { code: saved.code, backing: 60 });
});

// Regression: vérification de la deuxième relecture R2(b) et R2(c) — une
// valeur provisoire (relevée après un redémarrage en pleine chanson) n'est
// sauvegardée qu'une fois confirmée par une remise de KaraFun au chargement ;
// une valeur sauvegardée que KaraFun contredit (remise à une autre valeur)
// est remplacée dans la sauvegarde. Troisième relecture finale R4 : la
// valeur provisoire est sauvegardée comme telle.
test('chœurs par défaut : valeur provisoire sauvegardée comme telle, puis confirmée, valeur sauvegardée remplacée si KaraFun la contredit', async t => {
  const f = harness();
  const { bridge, frames } = replayBridge(t, f);
  bridge.code = '123456';
  const x = isoItem('X-id', 776, { singer: 'Quelqu’un' });
  frames(queueEvent(x), isoStatus(4, x, { backing: 53 }));
  const y = isoItem('Y-id', 777, { singer: 'Autre' });
  frames(isoStatus(1, y), queueEvent(y), isoStatus(2, y), isoStatus(3, y), isoStatus(4, y));
  assert.equal(bridge.observedDefaults.backing, 53, 'relevée pour la soirée');
  assert.equal(plain(f.settings.karafunDefaults)?.provisional, true, 'sauvegardée comme provisoire');
  // Chœurs changés en direct sur y, puis KaraFun remet z à 53 : confirmée.
  frames(isoStatus(4, y, { backing: 20 }));
  const z = isoItem('Z-id', 778, { singer: 'Encore' });
  frames(isoStatus(1, z), queueEvent(z), isoStatus(2, z));
  assert.equal(plain(f.settings.karafunDefaults)?.backing, 53, 'confirmée puis sauvegardée');
  assert.equal(plain(f.settings.karafunDefaults)?.provisional, undefined);
  // Redémarrage : 53 repris, mais le bar a changé la valeur dans KaraFun (70).
  const g = harness();
  g.settings.karafunDefaults = plain(f.settings.karafunDefaults);
  const other = replayBridge(t, g);
  other.bridge.code = '123456';
  g.restoreKaraFunDefaults();
  const a = isoItem('A-id', 779, { singer: 'Un' });
  other.frames(isoStatus(1, a), queueEvent(a), isoStatus(2, a, { backing: 70 }), isoStatus(3, a, { backing: 70 }), isoStatus(4, a, { backing: 53 }));
  const b = isoItem('B-id', 780, { singer: 'Deux' });
  other.frames(isoStatus(1, b), queueEvent(b), isoStatus(2, b, { backing: 70 }));
  assert.equal(other.bridge.observedDefaults.backing, 70, 'KaraFun remet 70 au chargement');
  assert.equal(plain(g.settings.karafunDefaults)?.backing, 70, 'sauvegarde remplacée');
  assert.deepEqual(bare(other.frames(isoStatus(3, b, { backing: 70 }))), [], 'b reste à 70, plus ramené à 53');
});

// Regression: troisième relecture finale R5 — le chemin de production
// connectKaraFun -> restoreKaraFunDefaults n'était pas testé : la valeur
// sauvegardée pour ce code arrive au pont à la connexion, jamais pour un autre code.
test('connexion à KaraFun : chœurs par défaut sauvegardés pour ce code repris par le pont', () => {
  for (const code of ['123456', '654321']) {
    const f = harness();
    f.settings.karafunDefaults = { code: crypto.createHash('sha256').update('karafun:123456').digest('hex').slice(0, 16), backing: 53 };
    const bridge = new KaraFunBridge();
    const connects = [];
    bridge.connect = wanted => { connects.push(wanted); bridge.code = wanted; return 'started'; };
    f.setBridge(bridge);
    f.connectKaraFun(code);
    assert.deepEqual(connects, [code]);
    assert.equal(bridge.observedDefaults.backing, code === '123456' ? 53 : undefined, `code ${code}`);
    assert.equal(bridge.songSettingsDefaults().backing, code === '123456' ? 53 : 100);
  }
});

// Regression: troisième relecture finale R4(i) — application relancée entre
// deux titres avant toute valeur sauvegardée, chœurs 80 réglés en direct sur
// le dernier titre et gardés par un KaraFun collant : le premier titre vu se
// charger les donnait comme chœurs par défaut, sauvegardés pour toujours et
// remis à chaque titre des soirées suivantes. Sauvegardés seulement comme
// provisoires (vérification de la troisième relecture R4), oubliés à la
// nouvelle soirée.
test('application relancée entre deux titres, KaraFun collant à 80 : sauvegardé seulement comme provisoire', async t => {
  const f = harness();
  const { bridge, frames } = replayBridge(t, f);
  bridge.code = '123456';
  for (const [id, songId] of [['B-id', 901], ['C-id', 902]]) {
    const item = isoItem(id, songId, { singer: 'Autre' });
    frames(queueEvent(item), isoStatus(1, item), isoStatus(2, item, { backing: 80 }), isoStatus(3, item, { backing: 80 }),
      isoStatus(4, item, { backing: 80 }));
  }
  assert.equal(bridge.observedDefaults.backing, 80, 'relevée pour la soirée');
  assert.equal(bridge.provisionalDefaults, true);
  assert.deepEqual(plain(f.settings.karafunDefaults), { code: crypto.createHash('sha256').update('karafun:123456').digest('hex').slice(0, 16),
    backing: 80, provisional: true }, 'réglage en direct gardé par KaraFun : jamais sauvegardé comme confirmé');
});

// Regression: troisième relecture finale R4(b) — une valeur sauvegardée à
// tort (relevée d'un réglage gardé par KaraFun) ne se réapprenait jamais
// et passait à toutes les soirées. « Nouvelle soirée » oublie une valeur
// provisoire. Relecture finale, quatrième passe (K1) : elle oubliait aussi
// la valeur confirmée, puis relevait comme valeur provisoire (sauvegardée,
// imposée aux titres suivants) les chœurs coupés du titre en cours qu'un
// KaraFun collant garde au titre suivant. Une valeur confirmée par une
// remise de KaraFun au chargement reste ; les chœurs laissés par un titre
// vu ne sont jamais relevés, seule une remise au chargement donne la valeur.
test('nouvelle soirée : valeur confirmée gardée, valeur provisoire oubliée, chœurs gardés du titre en cours jamais relevés', async t => {
  const f = harness();
  const { bridge, frames } = replayBridge(t, f);
  bridge.code = '123456';
  // Valeur confirmée : x vu en pleine chanson à 20, y remis à 53 par KaraFun au chargement.
  const x = isoItem('X-id', 776, { singer: 'Quelqu’un' });
  frames(queueEvent(x), isoStatus(4, x, { backing: 20 }));
  const y = isoItem('Y-id', 777, { singer: 'Autre' });
  frames(isoStatus(1, y), queueEvent(y), isoStatus(2, y), isoStatus(3, y), isoStatus(4, y));
  const confirmed = plain(f.settings.karafunDefaults);
  assert.deepEqual([confirmed?.backing, confirmed?.provisional], [53, undefined], 'remise par KaraFun : confirmée');
  frames(isoStatus(4, y, { backing: 0 })); // chœurs coupés en direct sur y
  f.clearEvening();
  f.sync();
  assert.deepEqual(plain(f.settings.karafunDefaults), confirmed, 'valeur confirmée gardée pour ce KaraFun');
  // KaraFun collant : z garde les chœurs coupés de y, ramenés à 53.
  const z = isoItem('Z-id', 778, { singer: 'Encore' });
  frames(isoStatus(1, z), queueEvent(z), isoStatus(2, z, { backing: 0 }));
  assert.deepEqual(bare(frames(isoStatus(3, z, { backing: 0 }))), [volumeTo(4, 53)]);
  assert.deepEqual(plain(f.settings.karafunDefaults), confirmed);

  // Valeur provisoire (KaraFun collant, jamais remis au chargement) : oubliée.
  const g = harness();
  const other = replayBridge(t, g);
  other.bridge.code = '123456';
  const a = isoItem('A-id', 801, { singer: 'Un' });
  other.frames(queueEvent(a), isoStatus(1, a), isoStatus(2, a), isoStatus(3, a), isoStatus(4, a));
  assert.equal(plain(g.settings.karafunDefaults)?.provisional, true);
  other.frames(isoStatus(4, a, { backing: 0 })); // chœurs coupés en direct sur a
  g.clearEvening();
  g.sync();
  assert.equal(g.settings.karafunDefaults, undefined, 'valeur provisoire oubliée');
  // b garde les chœurs coupés de a : valeur habituelle inconnue, rien envoyé ni relevé.
  const b = isoItem('B-id', 802, { singer: 'Deux' });
  other.frames(isoStatus(1, b), queueEvent(b), isoStatus(2, b, { backing: 0 }));
  assert.deepEqual(bare(other.frames(isoStatus(3, b, { backing: 0 }), isoStatus(4, b, { backing: 0 }))), []);
  assert.equal(other.bridge.observedDefaults.backing, undefined, 'chœurs gardés de a : jamais relevés');
  assert.equal(g.settings.karafunDefaults, undefined);
  // Remis à 53 en direct sur b, c se charge à 53 : jamais ramené à 0.
  other.frames(isoStatus(4, b, { backing: 53 }));
  const c = isoItem('C-id', 803, { singer: 'Trois' });
  other.frames(isoStatus(1, c), queueEvent(c), isoStatus(2, c, { backing: 53 }));
  assert.deepEqual(bare(other.frames(isoStatus(3, c, { backing: 53 }))), []);
  // KaraFun remet ses chœurs au chargement : relevée de nouveau, confirmée.
  other.frames(isoStatus(4, c, { backing: 90 }));
  const d = isoItem('D-id', 804, { singer: 'Quatre' });
  other.frames(isoStatus(1, d), queueEvent(d), isoStatus(2, d, { backing: 53 }));
  assert.deepEqual(plain(g.settings.karafunDefaults), { code: confirmed.code, backing: 53 });
});

// Regression: relecture finale, quatrième passe (K1) — nouveau code alors que
// le même KaraFun continue, chœurs coupés en direct sur le titre en cours :
// la déconnexion oubliait le titre vu avant que les chœurs par défaut ne
// soient oubliés, et 0, gardé au titre suivant par un KaraFun collant, était
// relevé (provisoire, sauvegardé) puis imposé aux titres suivants.
test('nouveau code, même KaraFun collant : chœurs coupés du titre en cours jamais relevés ni imposés ensuite', async t => {
  const f = harness();
  const { bridge, frames, reconnect } = replayBridge(t, f);
  bridge.code = '123456';
  const x = isoItem('X-id', 776, { singer: 'Quelqu’un' });
  frames(queueEvent(x), isoStatus(4, x, { backing: 20 }));
  const y = isoItem('Y-id', 777, { singer: 'Autre' });
  frames(isoStatus(1, y), queueEvent(y), isoStatus(2, y), isoStatus(3, y), isoStatus(4, y));
  assert.equal(plain(f.settings.karafunDefaults)?.backing, 53);
  frames(isoStatus(4, y, { backing: 0 })); // chœurs coupés en direct sur y
  // « Connecter » avec un autre code : le faux canal tient lieu de découverte.
  bridge._open = () => {};
  f.connectKaraFun('654321');
  assert.equal(bridge.code, '654321');
  reconnect();
  frames(queueEvent(y), isoStatus(4, y, { backing: 0 }));
  const z = isoItem('Z-id', 778, { singer: 'Encore' });
  frames(isoStatus(1, z), queueEvent(z), isoStatus(2, z, { backing: 0 }));
  assert.deepEqual(bare(frames(isoStatus(3, z, { backing: 0 }), isoStatus(4, z, { backing: 0 }))), []);
  assert.equal(bridge.observedDefaults.backing, undefined, 'chœurs gardés de y : jamais relevés');
  assert.equal(bridge.provisionalDefaults, false);
  // Remis à 53 en direct sur z, w se charge à 53 : jamais ramené à 0.
  frames(isoStatus(4, z, { backing: 53 }));
  const w = isoItem('W-id', 779, { singer: 'Dernier' });
  frames(isoStatus(1, w), queueEvent(w), isoStatus(2, w, { backing: 53 }));
  assert.deepEqual(bare(frames(isoStatus(3, w, { backing: 53 }))), []);
  assert.equal(bridge.observedDefaults.backing, undefined);
});

const codeKey = code => crypto.createHash('sha256').update(`karafun:${code}`).digest('hex').slice(0, 16);
const idleStatus = () => ({ type: 'remote.StatusEvent', payload: { status: { state: 1, pitch: 0, tempo: 0, tracks: [], current: null } } });

// Regression: vérification de la quatrième passe (K1) — chœurs coupés en
// direct, puis session KCS perdue avant « Nouvelle soirée » (coupure, KaraFun
// entre deux titres) ou avant le nouveau code (l'ancien cesse de marcher le
// premier) : 0, gardé au titre suivant par un KaraFun collant, était relevé
// (provisoire, sauvegardé, sous l'empreinte du nouveau code) puis imposé à un
// titre chargé à 53.
for (const how of ['nouvelle soirée', 'nouveau code']) {
  test(`${how} après une coupure, KaraFun collant : chœurs coupés en direct jamais relevés ni imposés ensuite`, async t => {
    const f = harness();
    const { bridge, frames, reconnect } = replayBridge(t, f);
    bridge.code = '123456';
    const a = isoItem('A-id', 801, { singer: 'Un' });
    frames(queueEvent(a), isoStatus(1, a), isoStatus(2, a), isoStatus(3, a), isoStatus(4, a));
    const learned = plain(f.settings.karafunDefaults);
    assert.deepEqual(learned, { code: codeKey('123456'), backing: 53, provisional: true });
    frames(isoStatus(4, a, { backing: 0 })); // chœurs coupés en direct sur a
    if (how === 'nouvelle soirée') {
      reconnect(); // coupure ; a a fini, KaraFun attend le titre suivant
      frames(queueEvent(), idleStatus());
      f.clearEvening();
      f.sync();
    } else {
      bridge.disconnect(); // l'ancien code ne marche plus
      f.sync();
      bridge._open = () => {};
      f.connectKaraFun('654321');
      reconnect();
      frames(queueEvent(), idleStatus());
    }
    const b = isoItem('B-id', 802, { singer: 'Deux' });
    assert.deepEqual(bare(frames(isoStatus(1, b), queueEvent(b), isoStatus(2, b, { backing: 0 }), isoStatus(3, b, { backing: 0 }),
      isoStatus(4, b, { backing: 0 }))), []);
    assert.equal(bridge.observedDefaults.backing, undefined, 'chœurs gardés de a : jamais relevés');
    assert.deepEqual(plain(f.settings.karafunDefaults), how === 'nouvelle soirée' ? undefined : learned, 'rien de sauvegardé');
    // Remis à 53 en direct sur b, c se charge à 53 : jamais ramené à 0.
    frames(isoStatus(4, b, { backing: 53 }));
    const c = isoItem('C-id', 803, { singer: 'Trois' });
    frames(isoStatus(1, c), queueEvent(c), isoStatus(2, c, { backing: 53 }));
    assert.deepEqual(bare(frames(isoStatus(3, c, { backing: 53 }))), []);
  });
}

// Regression: vérification de la quatrième passe (K1) — « Supprimer toutes
// les tables » avec le dernier titre sur scène, chœurs jamais changés : la
// valeur provisoire oubliée n'était plus relevée pour toute la suite (pages à
// 100 au lieu de « Réglage de KaraFun : 53 ») et, chez un KaraFun collant,
// les chœurs coupés par un titre restaient aux titres suivants. De même
// après un redémarrage qui reprend une valeur provisoire sauvegardée.
for (const start of ['pont neuf', 'valeur provisoire reprise']) {
  test(`nouvelle soirée, chœurs jamais changés (${start}) : valeur relevée de nouveau, chœurs coupés ensuite ramenés`, async t => {
    const f = harness();
    if (start !== 'pont neuf') f.settings.karafunDefaults = { code: codeKey('123456'), backing: 53, provisional: true };
    const { bridge, frames } = replayBridge(t, f);
    bridge.code = '123456';
    if (start !== 'pont neuf') f.restoreKaraFunDefaults();
    const shown = () => plain(f.publicState().songSettings.defaults.backing);
    const a = isoItem('A-id', 801, { singer: 'Un' });
    frames(queueEvent(a), isoStatus(1, a), isoStatus(2, a), isoStatus(3, a), isoStatus(4, a));
    assert.deepEqual([shown(), plain(f.settings.karafunDefaults)?.provisional], [53, true]);
    f.clearEvening();
    f.sync();
    assert.equal(f.settings.karafunDefaults, undefined, 'valeur provisoire oubliée');
    // b se charge avec les chœurs de a, jamais changés : relevée de nouveau, provisoire.
    const b = isoItem('B-id', 802, { singer: 'Deux' });
    assert.deepEqual(bare(frames(isoStatus(1, b), queueEvent(b), isoStatus(2, b), isoStatus(3, b), isoStatus(4, b))), []);
    assert.equal(shown(), 53, 'pages : réglage de KaraFun 53');
    assert.deepEqual(plain(f.settings.karafunDefaults), { code: codeKey('123456'), backing: 53, provisional: true });
    // e coupe les chœurs par ses options ; g, sans réglage, les garde (KaraFun collant) : ramenés à 53.
    const e = isoItem('E-id', 900, { singer: 'E', tracks: [{ track: { type: 4 }, volume: 0 }] });
    frames(isoStatus(1, e), queueEvent(e), isoStatus(2, e, { backing: 0 }), isoStatus(3, e, { backing: 0 }), isoStatus(4, e, { backing: 0 }));
    const g = isoItem('G-id', 901, { singer: 'G' });
    frames(isoStatus(1, g), queueEvent(g), isoStatus(2, g, { backing: 0 }));
    assert.deepEqual(bare(frames(isoStatus(3, g, { backing: 0 }))), [volumeTo(4, 53)]);
  });
}

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

// Regression: relecture finale, quatrième passe (K4) — sur un duo, la remise
// par défaut d'une page d'avant les voix une à une (« Réinitialiser » des
// téléphones : settings null ; bar : {}) gardait la voix 2 posée par sa voix
// guide : la page montrait les valeurs par défaut, KaraFun gardait l'ancienne
// voix 2. Sans `guideVoices`, la voix 2 d'un duo suit toujours la voix guide.
test('pages d’avant les voix une à une : sur un duo, leur remise par défaut remet aussi la voix 2', async t => {
  const f = harness();
  replayBridge(t, f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa');
  const tom = singer(f, tb, 'Tom');
  f.sched.inviteDuet(lea.person, tom.person.id, { songId: 12458, title: 'Titre 12458', artist: 'Artiste' });
  const entryId = lea.person.song.entryId;
  // Ancienne page des chanteurs : voix guide 40 (la voix 2 suit), puis « Réinitialiser ».
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { guide: 40 } });
  assert.deepEqual(plain(lea.person.song.settings), { guide: 40, guideVoices: { 6: 40 } });
  const reset = await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: null });
  assert.equal(reset.settings, null);
  assert.equal(lea.person.song.settings ?? null, null, 'plus de voix 2 restée à 40');
  // Ancienne page du bar : voix guide 30, puis remise par défaut.
  await f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId, settings: { guide: 30 } });
  assert.deepEqual(plain(lea.person.song.settings), { guide: 30, guideVoices: { 6: 30 } });
  const cleared = await f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId, settings: {} });
  assert.equal(cleared.settings, null);
  assert.equal(lea.person.song.settings ?? null, null);
  // Voix 3 réglée par une page actuelle : gardée par la remise d'une ancienne page.
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { guide: 50, guideVoices: { 6: 75, 7: 25 } } });
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: null });
  assert.deepEqual(plain(lea.person.song.settings), { guideVoices: { 7: 25 } });
  // Pages actuelles : leur voix 2 explicite ne bouge pas.
  await f.call('POST /api/table/song/settings', { ...lea.body, entryId, settings: { guide: 50, guideVoices: { 6: 75 } } });
  assert.deepEqual(plain(lea.person.song.settings), { guide: 50, guideVoices: { 6: 75 } });
  await f.call('POST /api/staff/song/settings', { personId: lea.person.id, entryId, settings: { pitch: 1, guideVoices: { 6: 75 } } });
  assert.deepEqual(plain(lea.person.song.settings), { pitch: 1, guideVoices: { 6: 75 } });
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

// Regression: valeurs imprévues de KaraFun (suite de la relecture de l'étape 1
// Socket.IO, issue #59) — titre ajouté dans KaraFun, sans pistes connues,
// chargé avec une piste d'un type imprévu dans ses options : neutralTarget
// levait une exception dans sync(), hors de l'écouteur du WebSocket, et le
// serveur du bar s'arrêtait (sonde du 11 novembre 2026). La piste compte
// pour absente.
test('valeurs imprévues : titre ajouté dans KaraFun avec une piste d’un type imprévu dans ses options', async t => {
  const f = harness();
  const { frames } = replayBridge(t, f);
  const trap = JSON.parse('{"toString":1}');
  const item = isoItem('X-id', 901, { singer: 'Quelqu’un', tracks: [{ track: { type: trap }, volume: 50 }] }, []);
  assert.deepEqual(bare(frames(queueEvent(item), isoStatus(1, item), isoStatus(3, item))), []);
  assert.deepEqual(f.sched.log.filter(line => line.kind === 'error'), []);
});

// Filet de la synchronisation : sync() tourne hors de l'écouteur du WebSocket
// (setImmediate à chaque changement du pont, minuterie de 2 s). Une erreur qui
// y resterait ne doit jamais arrêter le serveur : notée dans le journal du
// serveur, et une fois pour le bar ; la synchronisation suivante réessaie.
// Les deux autres suites d'événements du pont ont le même filet.
test('filet de la synchronisation : une erreur dans sync() n’arrête pas le serveur, signalée une fois au bar', async () => {
  const f = harness();
  const { bridge } = kcsBridge(f);
  const status = bridge.status;
  let fail = true;
  Object.defineProperty(bridge, 'status', { configurable: true, get() {
    if (fail) throw new TypeError('Cannot convert object to primitive value');
    return status;
  } });
  const errors = () => f.sched.log.filter(line => line.kind === 'error').map(line => line.msg);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  f.wireBridge(bridge);
  bridge.emit('change');
  await tick();
  bridge.emit('change');
  await tick();
  assert.deepEqual(errors(), ['La mise à jour avec KaraFun a échoué (Cannot convert object to primitive value) : la file ne pilote plus KaraFun et réessaie seule. Pilote dans KaraFun en attendant.']);
  assert.match(f.logs.find(line => line.startsWith('Synchronisation avec KaraFun interrompue')), /\(song-settings-server\.test\.js:\d+\)$/,
    'fichier et ligne seulement, sans le dossier d’installation');
  assert.equal(f.logs.filter(line => line.startsWith('Synchronisation avec KaraFun interrompue : Cannot convert object to primitive value')).length, 1,
    'une ligne pour la panne, pas une par essai');
  fail = false;
  f.safeSync();
  assert.ok(f.logs.includes('Synchronisation avec KaraFun rétablie après 2 échecs.'));
  fail = true;
  f.safeSync();
  assert.equal(errors().length, 2, 'nouvelle panne après un retour à la normale : signalée de nouveau');
  fail = false;
  bridge.emit('battle-mode-answer', { get ok() { throw new Error('réponse piégée'); } });
  await tick();
  assert.ok(f.logs.includes('Réponse de KaraFun au mode Battle non traitée : réponse piégée'));
});

// Regression: relecture de cette correction (trois relecteurs) — la mise à
// jour relancée 300 ms après une commande du bar (POST /api/staff/kf) et après
// « Connecter » ou « Reconnecter » (connectionAnswer) appelait sync() sans le
// filet : pendant une panne de la mise à jour, le clic suivant du bar
// arrêtait le serveur.
test('filet de la synchronisation : mise à jour relancée 300 ms après une commande du bar ou « Connecter »', async () => {
  const timers = [];
  const f = harness({ setTimeout: (run, ms) => { timers.push({ run, ms }); return { unref() {} }; } });
  const { bridge } = kcsBridge(f);
  const status = bridge.status;
  let fail = false;
  Object.defineProperty(bridge, 'status', { configurable: true, get() {
    if (fail) throw new TypeError('Cannot convert object to primitive value');
    return status;
  } });
  assert.deepEqual(plain(await f.call('POST /api/staff/kf', { action: 'next' })), { ok: true });
  f.connectionAnswer('kept');
  const later = timers.filter(timer => timer.ms === 300);
  assert.equal(later.length, 2, '« Suivant », puis la réponse à « Connecter »');
  fail = true;
  for (const { run } of later) assert.doesNotThrow(run, 'une mise à jour en échec ne sort pas de la minuterie');
  assert.equal(f.sched.log.filter(line => line.kind === 'error').length, 1, 'signalée une fois au bar');
});

// Deuxième tour de la relecture — une panne qui dure ne laisse qu'une ligne
// par minute dans le journal du serveur, et le retour n'est noté qu'après une
// mise à jour complète (pas quand sync() s'arrête tôt, KaraFun pas prêt).
test('filet de la synchronisation : panne qui dure, une ligne par minute ; retour noté après une mise à jour complète', async () => {
  let now = Date.parse('2026-11-12T21:00:00.000Z');
  const Real = Date;
  class Clock extends Real {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const f = harness({ Date: Clock });
  const { bridge } = kcsBridge(f);
  const status = bridge.status;
  let fail = true;
  Object.defineProperty(bridge, 'status', { configurable: true, get() {
    if (fail) throw new TypeError('Cannot convert object to primitive value');
    return status;
  } });
  const still = () => f.logs.filter(line => line.startsWith('Synchronisation avec KaraFun toujours en échec'));
  for (let i = 0; i < 30; i++) { f.safeSync(); now += 2000; } // 58 s de panne
  assert.equal(still().length, 0, 'moins d’une minute : aucune ligne de plus');
  f.safeSync(); // 60 s
  assert.deepEqual(still(), ['Synchronisation avec KaraFun toujours en échec (31 essais) : Cannot convert object to primitive value']);
  for (let i = 0; i < 29; i++) { now += 2000; f.safeSync(); }
  assert.equal(still().length, 1, 'une ligne par minute au plus');
  // KaraFun pas prêt : sync() s'arrête tôt, rien n'est rétabli.
  fail = false;
  bridge.ready = false;
  f.safeSync();
  assert.equal(f.logs.some(line => line.startsWith('Synchronisation avec KaraFun rétablie')), false);
  bridge.ready = true;
  f.safeSync();
  assert.ok(f.logs.includes('Synchronisation avec KaraFun rétablie après 60 échecs.'));
});

// Deuxième tour de la relecture — main() ne tourne pas dans le banc d'essai :
// rien n'essayait que la minuterie de 2 s passe par le filet, alors que deux
// relances l'avaient déjà oublié. Aucune minuterie n'appelle sync() sans lui,
// même dans une fonction fléchée (tour 3), ni syncAfterChange() (tour 5), qui
// hors d'une requête lève l'erreur comme sync().
test('filet de la synchronisation : aucune minuterie n’appelle sync() sans le filet', () => {
  const main = source.slice(source.indexOf('async function main()'), source.lastIndexOf('main().catch('));
  assert.match(main, /setInterval\(\(\) => \{[^}]*\bsafeSync\(\);\s*\}, 2000\)/, 'minuterie de 2 s');
  const offenders = [];
  for (const { index } of source.matchAll(/\bset(?:Timeout|Interval|Immediate)\(/g)) {
    const open = source.indexOf('(', index);
    let depth = 0, end = open;
    for (; end < source.length; end++) {
      if ('([{'.includes(source[end])) depth++;
      else if (')]}'.includes(source[end]) && --depth === 0) break;
    }
    if (/(?<![\w.$])(?:sync|syncAfterChange)\b/.test(source.slice(open, end + 1))) offenders.push(source.slice(0, index).split('\n').length);
  }
  assert.deepEqual(offenders, [], 'lignes de server.js où une minuterie appelle sync() nu');
  assert.match(source, /b\.on\('change', \(\) => setImmediate\(safeSync\)\)/, 'événements du pont');
});

// Relecture 2, tour 5 — les routes appelaient sync() nu : une panne de la
// mise à jour faisait répondre une erreur pour un geste déjà fait. Seuls le
// filet lui-même, syncAfterChange() (routes) et l'inscription (son propre
// filet, joinPersonDurably) appellent encore sync() ; toute autre fonction qui
// l'appellerait doit choisir l'un des deux filets.
test('filet de la synchronisation : seuls les filets et l’inscription appellent sync() nu', () => {
  const callers = new Set();
  for (const { index } of source.matchAll(/(?<![\w.$'])(?<!function )sync\(\)/g)) {
    const line = source.slice(source.lastIndexOf('\n', index) + 1, index);
    if (/^\s*\/\//.test(line)) continue; // commentaire
    const before = source.slice(0, index);
    const fn = [...before.matchAll(/^(?:async )?function (\w+)\(|^  '([A-Z]+ [^']+)': async/gm)].at(-1);
    callers.add(fn ? fn[1] || fn[2] : '?');
  }
  assert.deepEqual([...callers].sort(), ['joinPersonDurably', 'safeSync', 'syncAfterChange']);
});

// Regression: tour 3 de la relecture — avec une file de KaraFun illisible,
// l'ajout d'un titre n'y était jamais vu : « J'ai vérifié la file KaraFun :
// reprendre » concluait qu'il n'était pas parti et l'envoyait une seconde fois.
// La reprise est refusée tant que la file est illisible ; à la file lisible
// suivante, l'envoi est retrouvé. (Depuis la relecture 2, l'envoi n'est plus
// déclaré non confirmé pendant une file illisible : ici, la file devient
// illisible après.)
test('valeurs imprévues : file de KaraFun illisible, la reprise d’un envoi interrompu est refusée', async t => {
  let now = Date.parse('2026-11-12T21:00:00.000Z');
  const Real = Date;
  class Clock extends Real {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const f = harness({ Date: Clock });
  const { frames } = replayBridge(t, f);
  const lea = singer(f, openTable(f, '1'), 'Léa');
  f.sched.chooseSong(lea.person, { songId: 12458, title: 'Titre 12458', artist: 'Artiste' });
  f.settings.auto = true;
  const [add] = frames();
  f.settings.auto = false;
  assert.equal(add.type, 'remote.AddToQueueRequest');
  const item = isoItem('A-id', 12458, add.payload.options);
  // KaraFun tarde : 15 s plus tard, l'envoi est à vérifier.
  now += 16000;
  frames();
  assert.match(notes(f).at(-1), /^KaraFun n'a pas confirmé « Titre 12458 »/);
  // KaraFun ajoute le titre, mais sa file arrive avec un titre illisible.
  frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(item, null));
  await assert.rejects(f.call('POST /api/staff/reconcile-pending'), /^Error: La file de KaraFun est illisible/);
  assert.ok(f.pending(), 'rien n’est renvoyé');
  frames(queueEvent(item));
  assert.equal(f.pending(), null, 'file lisible : envoi retrouvé');
  assert.equal(f.tracked().map(tr => tr.queueId).join(), 'A-id');
});

// Horloge du serveur que l'essai avance lui-même.
function clockAt(iso) {
  const clock = { now: Date.parse(iso) };
  const Real = Date;
  clock.Date = class extends Real {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  };
  return clock;
}
// Titre ajouté dans KaraFun dont le numéro est illisible : toute file qui le
// contient est ignorée.
const ODD_ITEM = { id: ['x'], song: { id: { type: 1, id: 9 }, title: 'Pause', artist: 'Artiste', songTracks: [], options: {} } };
const removals = sent => sent.filter(m => m.type === 'remote.RemoveFromQueueRequest').map(m => m.payload.queueItemId);
const unconfirmed = f => notes(f).filter(line => line.startsWith('KaraFun n\'a pas confirmé'));

// Regression: relecture 2 (passe adverse) — avec une file de KaraFun
// illisible, la file la croyait vide et envoyait le titre suivant : jamais vu
// dans la file figée, il finissait en « n'a pas confirmé », envoi automatique
// suspendu. Pendant l'alerte, la file ne lui envoie plus rien d'elle-même ;
// l'envoi repart à la file lisible suivante.
test('valeurs imprévues : file de KaraFun illisible, aucun envoi d’elle-même, puis l’envoi repart', async t => {
  const clock = clockAt('2026-11-12T21:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  const lea = singer(f, openTable(f, '1'), 'Léa');
  f.sched.chooseSong(lea.person, { songId: 12458, title: 'Titre 12458', artist: 'Artiste' });
  f.settings.auto = true;
  assert.deepEqual(frames(queueEvent(ODD_ITEM)), [], 'file illisible : rien n’est envoyé');
  clock.now += 60000;
  assert.deepEqual(frames(), [], 'une minute plus tard non plus');
  assert.deepEqual(unconfirmed(f), []);
  const [add] = frames(queueEvent());
  assert.equal(add?.type, 'remote.AddToQueueRequest', 'file lisible : l’envoi repart');
});

// Regression: relecture 2 (équipe rouge) — un titre envoyé juste avant que la
// file de KaraFun devienne illisible n'y était jamais vu : 15 s plus tard,
// « n'a pas confirmé », alors que KaraFun le chantait ; une fois chanté et
// retiré, « reprendre » le renvoyait, et la même personne chantait deux fois.
// L'horloge des 15 s attend une file lisible, et le titre en cours, dans un
// état lisible, confirme l'envoi.
test('valeurs imprévues : titre envoyé puis file illisible, vu sur scène dans l’état : envoi confirmé, jamais renvoyé', async t => {
  const clock = clockAt('2026-11-12T21:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  const lea = singer(f, openTable(f, '1'), 'Léa');
  f.sched.chooseSong(lea.person, { songId: 12458, title: 'Titre 12458', artist: 'Artiste' });
  f.settings.auto = true;
  const [add] = frames();
  assert.equal(add.type, 'remote.AddToQueueRequest');
  const item = isoItem('A-id', 12458, add.payload.options);
  frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(item, ODD_ITEM));
  clock.now += 20000;
  frames();
  assert.deepEqual(unconfirmed(f), [], 'pas de fausse alerte');
  assert.ok(f.pending(), 'file illisible, titre pas encore vu : envoi en attente');
  frames(isoStatus(4, item));
  assert.equal(f.pending(), null, 'titre en cours : envoi confirmé');
  assert.equal(f.tracked().map(tr => tr.queueId).join(), 'A-id');
  // Titre chanté puis retiré par KaraFun ; le titre illisible s'en va ensuite.
  clock.now += 200000;
  const later = frames(isoStatus(1, null), queueEvent(ODD_ITEM), queueEvent());
  assert.deepEqual(later.filter(m => m.type === 'remote.AddToQueueRequest'), [], 'jamais renvoyé');
  assert.deepEqual(f.events('turn.unsent'), [], 'passage compté');
  assert.equal(notes(f).some(line => /passée dans KaraFun avant la lecture/.test(line)), false);
});

// Regression: relecture 2 (passe adverse) — avec un état de KaraFun illisible,
// la file ne sait plus ce qui est sur scène : elle relançait le retrait d'un
// titre et faisait ses retraits de fermeture alors que KaraFun pouvait être
// en train de le jouer. Rien n'est retiré d'elle-même avant un état lisible.
test('valeurs imprévues : état de KaraFun illisible, aucun retrait d’elle-même avant le prochain état lisible', async t => {
  const clock = clockAt('2026-11-12T21:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  const tb = openTable(f, '1');
  singer(f, tb, 'Léa', 101);
  singer(f, tb, 'Tom', 201);
  const a = sendNext(f, 'A-id'), b = sendNext(f, 'B-id');
  const item = tr => isoItem(tr.queueId, tr.sel.song.songId, { singer: tr.sel.label });
  frames(queueEvent(item(a), item(b)));
  frames({ type: 'remote.StatusEvent', payload: { status: { state: '4', current: item(b) } } });
  a.cancelled = true;
  f.settings.closingAt = clock.now - 60000;
  clock.now += 20000;
  assert.deepEqual(removals(frames()), [], 'ni retrait relancé ni retrait de fermeture');
  clock.now += 20000;
  assert.deepEqual(removals(frames(isoStatus(1, null))).sort(), ['A-id', 'B-id'], 'état lisible : les retraits partent');
});

// Regression: relecture 2 (passe adverse) — pendant une file illisible, la
// lecture automatique jugeait le titre en tête de la file figée, et le vidage
// de la file était déclaré fini sans rien retirer de KaraFun.
test('valeurs imprévues : file de KaraFun illisible, ni lecture automatique ni vidage déclaré fini', async t => {
  const clock = clockAt('2026-11-12T21:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  f.sched.opts.requirePresence = false;
  singer(f, openTable(f, '1'), 'Léa', 101);
  const a = sendNext(f, 'A-id');
  const item = isoItem('A-id', 101, { singer: a.sel.label });
  frames(queueEvent(item));
  frames(queueEvent(item, ODD_ITEM));
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 0;
  const played = [];
  for (let i = 0; i < 3; i++) { clock.now += 30000; played.push(...frames().filter(m => m.type === 'remote.PlayRequest')); }
  assert.deepEqual(played, [], 'pas de lecture automatique');
  assert.equal(frames(queueEvent(item))[0]?.type, 'remote.PlayRequest', 'file lisible : lecture automatique');
  // Vidage demandé pendant une file illisible : la file d'avant était vide,
  // KaraFun a pu en recevoir d'autres titres depuis.
  f.settings.autoPlay = false;
  f.tracked().length = 0;
  frames(queueEvent());
  frames(queueEvent(ODD_ITEM, isoItem('X-id', 301, { singer: 'Quelqu’un' })));
  f.settings.queueClearPending = true;
  frames();
  assert.equal(f.settings.queueClearPending, true, 'vidage pas déclaré fini');
  assert.equal(notes(f).some(line => line.startsWith('File vidée dans KaraFun')), false);
  frames(queueEvent());
  assert.equal(f.settings.queueClearPending, false, 'file lisible et vide : vidage fini');
});

// Un état illisible seul ne bloque pas la reprise d'un envoi interrompu : elle
// ne lit que la file, où le titre en cours est en tête pendant la lecture.
// L'envoi automatique, lui, attend un état lisible.
test('valeurs imprévues : état de KaraFun illisible seul, la reprise d’un envoi interrompu reste possible', async t => {
  const clock = clockAt('2026-11-12T21:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  const lea = singer(f, openTable(f, '1'), 'Léa');
  f.sched.chooseSong(lea.person, { songId: 12458, title: 'Titre 12458', artist: 'Artiste' });
  f.settings.auto = true;
  const [add] = frames();
  f.settings.auto = false;
  frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} });
  clock.now += 16000;
  frames();
  assert.match(notes(f).at(-1), /^KaraFun n'a pas confirmé « Titre 12458 »/);
  frames({ type: 'remote.StatusEvent', payload: { status: { state: '4', current: null } } });
  assert.deepEqual(plain(await f.call('POST /api/staff/reconcile-pending')), { ok: true });
  assert.deepEqual([f.settings.auto, f.pending()], [true, null]);
  assert.deepEqual(frames().filter(m => m.type === 'remote.AddToQueueRequest'), [], 'état illisible : pas encore renvoyé');
  assert.equal(frames(isoStatus(1, null))[0]?.type, 'remote.AddToQueueRequest', 'état lisible : renvoyé');
});

// Regression: relecture 2 (maintenabilité) — l'endroit du code venait de la
// première ligne de la pile : quand Number(), String() ou toISOString()
// échouent, c'est la fonction de Node (« at Number (<anonymous>) »), et
// l'endroit promis manquait au journal. La première ligne avec un fichier
// sert. Le retour à la normale est aussi annoncé au bar, qui pilotait
// KaraFun à la main en attendant.
test('filet de la synchronisation : endroit du code noté quand Number() échoue, retour annoncé au bar', () => {
  const f = harness();
  const { bridge } = kcsBridge(f);
  const status = bridge.status;
  const trap = JSON.parse('{"toString":1}');
  let fail = true;
  Object.defineProperty(bridge, 'status', { configurable: true, get() { return fail ? Number(trap) : status; } });
  f.safeSync();
  assert.match(f.logs.find(line => line.startsWith('Synchronisation avec KaraFun interrompue')), /\(song-settings-server\.test\.js:\d+\)$/);
  fail = false;
  f.safeSync();
  assert.deepEqual(f.sched.log.filter(line => /mise à jour avec KaraFun/i.test(line.msg)).map(line => [line.kind, line.msg]), [
    ['error', 'La mise à jour avec KaraFun a échoué (Cannot convert object to primitive value) : la file ne pilote plus KaraFun et réessaie seule. Pilote dans KaraFun en attendant.'],
    ['info', 'Mise à jour avec KaraFun rétablie : la file pilote de nouveau KaraFun.'],
  ]);
});

// ---------------------------------------------------------------- relecture 2, tour 2
// Regression: relecture 2, tour 2 (passe adverse) — une erreur dans sync()
// juste après le compte d'un passage (relevé du journal) laissait l'envoi en
// attente : le filet relançait sync(), qui retrouvait le même titre dans
// KaraFun et comptait le passage une seconde fois, à chaque essai. L'envoi
// est détaché avant d'être compté.
test('filet de la synchronisation : passage compté une seule fois quand la mise à jour échoue juste après', async t => {
  const f = harness();
  const { frames, receive } = replayBridge(t, f);
  const lea = singer(f, openTable(f, '1'), 'Léa', 101);
  f.settings.auto = true;
  const [add] = frames();
  f.settings.auto = false;
  assert.equal(add.type, 'remote.AddToQueueRequest');
  // Panne juste après le compte : le relevé du journal échoue, une fois par compte.
  const commit = f.sched.commit.bind(f.sched), presenceView = f.sched.presenceView.bind(f.sched);
  let armed = false;
  f.sched.commit = sel => { const done = commit(sel); armed = true; return done; };
  f.sched.presenceView = (...args) => {
    if (armed) { armed = false; throw new TypeError('panne simulée'); }
    return presenceView(...args);
  };
  receive({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} });
  receive(queueEvent(isoItem('A-id', 101, add.payload.options)));
  for (let i = 0; i < 3; i++) f.safeSync();
  assert.ok(notes(f).some(line => line.startsWith('La mise à jour avec KaraFun a échoué (panne simulée)')));
  assert.equal(lea.person.sung, 1, 'un seul passage compté');
  assert.equal(f.events('turn.sent').length, 1);
  assert.equal(f.pending(), null);
});

// Regression: relecture 2, tour 2 (design) — pendant une file illisible, le
// rattrapage du début d'un titre lisait ses options dans la file figée : la
// tonalité que le bar venait de régler dans KaraFun (comme l'alerte le
// demande) était remise à 0. Pendant l'alerte, rien n'est rattrapé ni remis,
// et le titre ne l'est pas non plus après elle, en pleine chanson.
// Relecture 2, tour 3 (tests) : l'essai ne montrait pas « ni après elle » :
// réglée dans les options du titre, la tonalité se lit dans la file lisible
// d'après l'alerte, et il n'y a plus rien à rattraper. Réglée en direct, elle
// ne s'y lit pas : sans le titre marqué comme vérifié pendant l'alerte
// (liveChecked), le rattrapage la remettrait à 0 en pleine chanson.
test('valeurs imprévues : file de KaraFun illisible, la tonalité réglée dans KaraFun n’est pas remise à 0', async t => {
  for (const where of ['dans les options du titre', 'en direct']) {
    const { frames, A, B } = aThenB(t);
    frames(queueEvent(A, B, ODD_ITEM));
    const B2 = where === 'en direct' ? B : { ...B, song: { ...B.song, options: { ...B.song.options, pitch: -2 } } };
    const sent = [isoStatus(1, B2), queueEvent(B2, ODD_ITEM), isoStatus(2, B2, { pitch: -2 }), isoStatus(3, B2, { pitch: -2 }),
      isoStatus(4, B2, { pitch: -2 })].flatMap(m => bare(frames(m)));
    assert.deepEqual(sent, [], `pendant l’alerte, tonalité réglée ${where}`);
    assert.deepEqual(bare(frames(queueEvent(B2), isoStatus(4, B2, { pitch: -2 }))), [],
      `après l’alerte, en pleine chanson, tonalité réglée ${where}`);
  }
});

// Même règle pour un titre ajouté directement dans KaraFun qui se charge
// pendant l'alerte : ses valeurs neutres ne sont pas visées (le bar le règle
// dans KaraFun), ni pendant l'alerte ni après elle.
test('valeurs imprévues : file de KaraFun illisible, titre ajouté dans KaraFun chargé sans remise à zéro', async t => {
  const { f, frames, A, B } = aThenB(t);
  await f.call('POST /api/staff/kf', { action: 'pitch', value: 2, queueId: 'A-id' });
  frames(isoStatus(4, A, { pitch: 2 }));
  frames(queueEvent(A, B, ODD_ITEM));
  const own = isoItem('C-id', 777, { singer: 'Quelqu’un' });
  const sent = [isoStatus(1, own), isoStatus(2, own, { pitch: 2 }), isoStatus(3, own, { pitch: 2 }), isoStatus(4, own, { pitch: 2 })]
    .flatMap(m => bare(frames(m)));
  assert.deepEqual(sent, [], 'pendant l’alerte');
  assert.deepEqual(bare(frames(queueEvent(own, B), isoStatus(4, own, { pitch: 2 }))), [], 'après l’alerte, en pleine chanson');
  assert.deepEqual(f.events('song.settingsReset'), []);
});

// Regression: relecture 2, tour 2 (passe adverse) — pendant une file
// illisible, un réglage changé sur un titre déjà dans KaraFun lui renvoyait
// toutes ses options, tirées de la file figée (nom, mode, volumes) : ce que le
// bar venait de changer dans KaraFun était écrasé. L'envoi attend une file
// lisible, et part alors si le titre n'a pas commencé. Depuis le tour 4, la
// réponse le dit pas encore envoyé (essai suivant).
test('valeurs imprévues : file de KaraFun illisible, réglages d’un titre déjà dans KaraFun envoyés après l’alerte', async t => {
  const { f, frames, A, B, trB } = aThenB(t);
  frames(queueEvent(A, B, ODD_ITEM));
  const answer = await f.call('POST /api/staff/song/settings', { personId: trB.sel.ids[0], entryId: trB.sel.song.entryId,
    settings: { pitch: 2 } });
  assert.equal(answer.applied, 'unreadable');
  assert.deepEqual(frames(), [], 'rien n’est envoyé pendant l’alerte');
  assert.deepEqual(frames(queueEvent(A, B)).map(m => [m.type, m.payload.queueItemId, m.payload.options?.pitch]),
    [['remote.SetQueueItemOptionsRequest', 'B-id', 2]], 'file lisible : envoyé');
});

// Regression: relecture 2, tour 4 (relecteurs) — pendant une alerte « message
// de KaraFun illisible », le réglage d'un titre déjà dans KaraFun répondait
// « appliqué au début du titre », celui d'un titre en cours d'envoi « dès que
// KaraFun reçoit le titre ». Lancé pendant l'alerte, le titre n'est pourtant
// pas rattrapé, ni pendant elle ni après elle, en pleine chanson : le réglage
// était perdu sans que le chanteur le sache. La réponse le dit pas encore
// envoyé (« unreadable ») : le téléphone renvoie au bar, qui le règle dans
// KaraFun.
test('valeurs imprévues : message de KaraFun illisible, un réglage pas encore envoyé à KaraFun le dit', async t => {
  const { f, frames, A, B, trB } = aThenB(t);
  frames(queueEvent(A, B, ODD_ITEM));
  const zoe = f.sched.people.get(trB.sel.ids[0]);
  const phone = { table: '1', access: f.access.issue('1'), personId: zoe.id, token: zoe.token, entryId: trB.sel.song.entryId };
  assert.equal((await f.call('POST /api/table/song/settings', { ...phone, settings: { pitch: 2 } })).applied, 'unreadable',
    'téléphone : pas « appliqué au début du titre »');
  assert.equal((await f.call('POST /api/staff/song/settings', { personId: zoe.id, entryId: trB.sel.song.entryId,
    settings: { pitch: 2 } })).applied, 'unreadable', 'page du bar');
  // B est lancé pendant l'alerte (état lisible), puis la file redevient
  // lisible en pleine chanson : rien ne part, le bar le règle dans KaraFun.
  const sent = [isoStatus(1, B), isoStatus(2, B), isoStatus(3, B), isoStatus(4, B), queueEvent(B), isoStatus(4, B)]
    .flatMap(m => bare(frames(m)));
  assert.deepEqual(sent, []);
});
test('valeurs imprévues : message de KaraFun illisible, un réglage d’un titre en cours d’envoi le dit pas encore envoyé', async t => {
  const f = harness();
  const { frames } = replayBridge(t, f);
  const lea = singer(f, openTable(f, '1'), 'Léa', 12458);
  f.settings.auto = true;
  assert.equal(frames()[0]?.type, 'remote.AddToQueueRequest');
  f.settings.auto = false;
  frames(queueEvent(ODD_ITEM));
  const answer = await f.call('POST /api/table/song/settings', { ...lea.body, entryId: f.pending().sel.song.entryId,
    settings: { pitch: 2 } });
  assert.equal(answer.applied, 'unreadable', 'pas « dès que KaraFun reçoit le titre »');
});

// Regression: relecture 2, tour 2 (maintenabilité, passe adverse) — pendant
// une file illisible, la copie d'une relance ⏮ n'y était jamais vue : 15 s
// plus tard, « rien n'a été passé », puis la file retirait d'elle-même la
// copie à la file lisible suivante. Pendant l'alerte, ⏮ est refusé, et une
// relance déjà en cours attend une vue lisible, sans commande ni conclusion.
test('valeurs imprévues : relance ⏮ refusée pendant l’alerte', async t => {
  const f = harness();
  const { frames } = replayBridge(t, f);
  singer(f, openTable(f, '1'), 'Léa', 101);
  const a = sendNext(f, 'A-id');
  const A = isoItem('A-id', 101, { singer: a.sel.label });
  frames(queueEvent(A), isoStatus(4, A));
  a.liveChecked = 'A-id';
  frames(queueEvent(A, ODD_ITEM));
  await assert.rejects(f.call('POST /api/staff/kf', { action: 'restart' }),
    /^Error: Un message de KaraFun est illisible : relance le titre depuis KaraFun\.$/);
  assert.deepEqual(frames(), []);
});

// Titre A en lecture, sa relance ⏮ demandée à KaraFun : rend de quoi jouer la
// suite, avec l'ajout de la copie.
async function restartRequested(t) {
  const clock = clockAt('2026-11-12T21:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  singer(f, openTable(f, '1'), 'Léa', 101);
  const a = sendNext(f, 'A-id');
  const A = isoItem('A-id', 101, { singer: a.sel.label });
  frames(queueEvent(A), isoStatus(4, A));
  a.liveChecked = 'A-id';
  await f.call('POST /api/staff/kf', { action: 'restart' });
  const add = frames().find(m => m.type === 'remote.AddToQueueRequest');
  assert.ok(add, 'copie demandée à KaraFun');
  return { clock, f, frames, A, add };
}
const restartNotConfirmed = f => notes(f).filter(line => /n’a pas confirmé la relance/.test(line));

test('valeurs imprévues : relance ⏮ en cours pendant une file illisible : copie gardée, pas de fausse alerte', async t => {
  const { clock, f, frames, A, add } = await restartRequested(t);
  const C = isoItem('C-id', 101, add.payload.options);
  // KaraFun ajoute la copie, mais sa file arrive illisible.
  frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, C, ODD_ITEM));
  clock.now += 16000;
  assert.deepEqual(frames(), [], 'ni commande ni conclusion pendant l’alerte');
  assert.deepEqual(restartNotConfirmed(f), [], 'pas de fausse alerte');
  // File lisible : la copie est juste après le titre en cours, la relance reprend.
  const after = frames(queueEvent(A, C));
  assert.deepEqual(removals(after), [], 'copie gardée');
  assert.deepEqual(after.map(m => m.type), ['remote.NextRequest']);
  assert.equal(f.tracked().map(tr => tr.queueId).join(), 'C-id', 'le suivi passe à la copie');
});

// Relecture 2, tour 3 (tests) : rien n'essayait les délais mis en pause avec
// la relance pendant l'alerte. Sans cette pause, « rien n'a été passé »
// partirait dès la première file lisible, sans laisser à KaraFun le reste de
// ses 15 s pour montrer la copie.
test('valeurs imprévues : relance ⏮ en cours pendant une file illisible : son délai reprend après l’alerte', async t => {
  const { clock, f, frames, A, add } = await restartRequested(t);
  // 5 s après la demande, la file de KaraFun arrive illisible, et le reste 20 s.
  clock.now += 5000;
  frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, ODD_ITEM));
  clock.now += 20000;
  assert.deepEqual(frames(), [], 'ni commande ni conclusion pendant l’alerte');
  // Files lisibles sans la copie : 10 s restent à KaraFun pour la montrer.
  frames(queueEvent(A));
  clock.now += 9000;
  frames(queueEvent(A));
  assert.deepEqual(restartNotConfirmed(f), [], '5 s avant l’alerte et 9 s après : délai pas encore écoulé');
  clock.now += 2000;
  frames();
  assert.equal(restartNotConfirmed(f).length, 1, '15 s de file lisible écoulées : la relance conclut');
});

// Même pause pour le retrait des copies tardives d'une relance abandonnée :
// une copie ajoutée par KaraFun pendant une longue alerte ne s'y voit pas.
// Sans la pause, le délai de 60 s serait passé à la première file lisible :
// elle resterait dans KaraFun et rejouerait le titre après lui.
test('valeurs imprévues : relance ⏮ abandonnée puis longue alerte : la copie tardive vue ensuite est retirée', async t => {
  const { clock, f, frames, A, add } = await restartRequested(t);
  // KaraFun ne montre pas la copie : 16 s plus tard, la relance est abandonnée.
  clock.now += 16000;
  frames(queueEvent(A));
  assert.equal(restartNotConfirmed(f).length, 1);
  // 10 s plus tard, la file arrive illisible, et le reste 70 s.
  clock.now += 10000;
  frames(queueEvent(A, ODD_ITEM));
  clock.now += 70000;
  assert.deepEqual(frames(), [], 'rien n’est retiré pendant l’alerte');
  // File lisible : la copie ajoutée pendant l'alerte est retirée (50 s du délai restaient).
  const C = isoItem('C-id', 101, add.payload.options);
  assert.deepEqual(removals(frames(queueEvent(A, C))), ['C-id'], 'copie tardive retirée');
  assert.equal(notes(f).at(-1), 'Copie tardive de « Titre 101 » retirée de KaraFun.');
});

// Regression: relecture 2, tour 2 (passe adverse) — un titre retiré par
// « Pas prêt » restait dans la file figée : 45 s plus tard, le bar lisait
// « KaraFun n'a pas retiré … : retire-le dans KaraFun », alors que KaraFun
// l'avait retiré. Cette alerte attend une file lisible.
test('valeurs imprévues : file de KaraFun illisible, pas de fausse alerte « KaraFun n’a pas retiré »', async t => {
  const clock = clockAt('2026-11-12T21:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  f.sched.opts.requirePresence = false;
  const tb = openTable(f, '1');
  const people = [singer(f, tb, 'Léa', 101), singer(f, tb, 'Tom', 201)];
  const a = sendNext(f, 'A-id');
  const owner = people.find(s => s.person.id === a.sel.ids[0]);
  frames(queueEvent(isoItem('A-id', a.sel.song.songId, { singer: a.sel.label })));
  await f.call('POST /api/table/defer', { ...owner.body, songs: 1 });
  // KaraFun retire le titre, mais sa file arrive illisible.
  frames(queueEvent(ODD_ITEM));
  clock.now += 50000;
  frames();
  const notRemoved = () => notes(f).filter(line => line.startsWith('KaraFun n’a pas retiré'));
  assert.deepEqual(notRemoved(), []);
  // File lisible : le titre est bien sorti de KaraFun, il revient à son chanteur.
  frames(queueEvent());
  assert.deepEqual(notRemoved(), []);
  assert.equal(f.tracked().length, 0);
});

// Regression: relecture 2, tour 2 (maintenabilité) — une mise à jour qui
// réussissait de nouveau pendant une alerte « message illisible » annonçait
// « la file pilote de nouveau KaraFun », alors que l'alerte rouge disait le
// contraire. Le retour est annoncé à la fin de l'alerte.
test('filet de la synchronisation : retour pendant une alerte « message illisible », annoncé à sa fin', async t => {
  const f = harness();
  const { bridge, frames, receive } = replayBridge(t, f);
  frames(queueEvent(ODD_ITEM));
  const status = bridge.status, trap = JSON.parse('{"toString":1}');
  let fail = true;
  Object.defineProperty(bridge, 'status', { configurable: true, get() { return fail ? Number(trap) : status; } });
  f.safeSync();
  fail = false;
  f.safeSync();
  const updates = () => notes(f).filter(line => /mise à jour avec KaraFun/i.test(line));
  assert.equal(updates().length, 1, 'pendant l’alerte : seulement l’échec');
  assert.equal(f.logs.some(line => line.startsWith('Synchronisation avec KaraFun rétablie')), false);
  receive(queueEvent());
  f.safeSync();
  assert.equal(updates().at(-1), 'Mise à jour avec KaraFun rétablie : la file pilote de nouveau KaraFun.');
  assert.ok(f.logs.includes('Synchronisation avec KaraFun rétablie après 1 échec.'));
});

// Regression: relecture 2, tour 2 — l'accusé d'un envoi annulé (chanteur
// parti) arrivé pendant un état illisible faisait retirer le titre aussitôt,
// d'après la scène figée, alors que KaraFun avait pu le lancer. Le titre est
// suivi, et son retrait attend un état lisible.
test('valeurs imprévues : envoi annulé confirmé pendant un état illisible, retiré seulement après l’alerte', async t => {
  const f = harness();
  const { frames } = replayBridge(t, f);
  const lea = singer(f, openTable(f, '1'), 'Léa', 101);
  f.settings.auto = true;
  const [add] = frames();
  f.settings.auto = false;
  await f.call('POST /api/staff/person/leave', { personId: lea.person.id });
  frames({ type: 'remote.StatusEvent', payload: { status: { state: '4', current: null } } });
  const A = isoItem('A-id', 101, add.payload.options);
  assert.deepEqual(removals(frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A))), [],
    'état illisible : rien n’est retiré');
  assert.equal(f.pending(), null);
  assert.deepEqual(plain(f.tracked().map(tr => [tr.queueId, !!tr.cancelled])), [['A-id', true]]);
  assert.deepEqual(removals(frames(isoStatus(1, null))), ['A-id'], 'état lisible, titre hors scène : retiré');
});

// Cases de la relecture 2, tour 2 (machines à états) : envoi en attente
// pendant une file illisible. Annulé ou non, il attend sans « n'a pas
// confirmé », et « reprendre » est refusé (il n'y a pas d'envoi interrompu) ;
// à la file lisible suivante, un titre absent depuis plus de 15 s est
// déclaré non confirmé tout de suite.
test('valeurs imprévues : envoi en attente pendant une file illisible, annulé ou non : ni verdict ni reprise avant la file lisible', async t => {
  for (const cancelled of [false, true]) {
    const clock = clockAt('2026-11-12T21:00:00.000Z');
    const f = harness({ Date: clock.Date });
    const { frames } = replayBridge(t, f);
    const lea = singer(f, openTable(f, '1'), 'Léa', 101);
    f.settings.auto = true;
    frames();
    f.settings.auto = false;
    if (cancelled) await f.call('POST /api/staff/person/leave', { personId: lea.person.id });
    frames(queueEvent(ODD_ITEM));
    clock.now += 16000;
    frames();
    assert.deepEqual(unconfirmed(f), [], 'file illisible : l’attente continue');
    await assert.rejects(f.call('POST /api/staff/reconcile-pending'), /^Error: Aucun envoi interrompu à vérifier\.$/);
    assert.ok(f.pending(), 'envoi gardé');
    assert.equal(!!f.pending().cancelled, cancelled);
    if (cancelled) continue;
    frames(queueEvent());
    assert.equal(unconfirmed(f).length, 1, 'file lisible sans le titre : non confirmé tout de suite');
  }
});

test('valeurs imprévues : file illisible, envoi annulé vu sur scène : il continue et compte, rien n’est retiré', async t => {
  const f = harness();
  const { frames } = replayBridge(t, f);
  const lea = singer(f, openTable(f, '1'), 'Léa', 101);
  f.settings.auto = true;
  const [add] = frames();
  f.settings.auto = false;
  frames(queueEvent(ODD_ITEM));
  await f.call('POST /api/staff/person/leave', { personId: lea.person.id });
  const A = isoItem('A-id', 101, add.payload.options);
  assert.deepEqual(removals(frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, isoStatus(4, A))), []);
  assert.equal(f.pending(), null);
  assert.deepEqual(plain(f.tracked().map(tr => [tr.queueId, !!tr.cancelled, !!tr.startedAt])), [['A-id', false, true]]);
  // Passage compté (commit) ; une personne partie n'y gagne rien de plus.
  assert.deepEqual(f.events('turn.sent').map(e => e.queueId), ['A-id']);
});

test('valeurs imprévues : file illisible, envoi à vérifier vu sur scène : confirmé, jamais renvoyé', async t => {
  const clock = clockAt('2026-11-12T21:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  singer(f, openTable(f, '1'), 'Léa', 101);
  f.settings.auto = true;
  const [add] = frames();
  clock.now += 16000;
  frames();
  assert.equal(unconfirmed(f).length, 1);
  const A = isoItem('A-id', 101, add.payload.options);
  frames(queueEvent(ODD_ITEM));
  frames(isoStatus(4, A));
  assert.equal(f.pending(), null, 'titre en cours : envoi confirmé');
  assert.deepEqual(plain(f.tracked().map(tr => [tr.queueId, !!tr.startedAt])), [['A-id', true]]);
  clock.now += 200000;
  const later = frames(isoStatus(1, null), queueEvent());
  assert.deepEqual(later.filter(m => m.type === 'remote.AddToQueueRequest'), [], 'jamais renvoyé');
  assert.deepEqual(f.events('turn.unsent'), []);
});

// Relecture 2, tour 2 (tests) : rien n'essayait la garde du vidage pendant un
// état illisible ; le seul essai figeait une file vide. Le titre qu'un état
// figé cache sur scène n'est pas retiré avant un état lisible.
test('valeurs imprévues : état de KaraFun illisible, le vidage ne retire rien avant un état lisible', async t => {
  const f = harness();
  const { frames } = replayBridge(t, f);
  const x = isoItem('X-id', 301, { singer: 'Quelqu’un' });
  frames(queueEvent(x));
  frames({ type: 'remote.StatusEvent', payload: { status: { state: '4', current: x } } });
  f.settings.queueClearPending = true;
  assert.deepEqual(removals(frames()), []);
  assert.deepEqual(removals(frames(isoStatus(1, null))), ['X-id']);
});

// Regression: relecture 2, tour 2 (équipe rouge) — la lecture automatique ne
// vérifiait l'alerte qu'à sa décision : avec Spotify, elle attend sa coupure
// (jusqu'à 4 s, puis 2 s de silence). Une file illisible arrivée entre-temps
// laissait la vue figée, notre titre en tête, et « Lecture » partait quand
// même. L'alerte est revérifiée juste avant « Lecture ».
test('valeurs imprévues : file illisible pendant la coupure de Spotify, la lecture automatique ne part pas', async t => {
  const timers = [];
  const f = harness({ setTimeout: (fn, ms, ...args) => { timers.push({ fn, ms, args }); return { unref() {} }; } });
  const { frames, ws } = replayBridge(t, f);
  f.sched.opts.requirePresence = false;
  singer(f, openTable(f, '1'), 'Léa', 101);
  const a = sendNext(f, 'A-id');
  f.spotify.config = { ...f.spotify.config, clientId: 'x', refreshToken: 'y' };
  f.spotify.pause = async () => 'done';
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 0;
  const decided = frames(queueEvent(isoItem('A-id', 101, { singer: a.sel.label })));
  assert.deepEqual(decided.filter(m => m.type === 'remote.PlayRequest'), [], 'la lecture attend la coupure de Spotify');
  await new Promise(resolve => setImmediate(resolve));
  const lead = timers.filter(timer => timer.ms === 2000);
  assert.ok(lead.length > 0, 'silence après la coupure de Spotify');
  frames(queueEvent(isoItem('A-id', 101, { singer: a.sel.label }), ODD_ITEM));
  for (const timer of lead) timer.fn(...timer.args);
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ws.out.filter(m => m.type === 'remote.PlayRequest'), []);
});

// Faux Spotify (comme dans spotify-fermeture.test.js) : rend la liste des
// lectures et des pauses demandées.
function fakeSpotify(f) {
  const calls = [];
  let playing = false;
  const json = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  const done = { ok: true, status: 204, text: async () => '' };
  f.spotify.fetchImpl = async url => {
    if (url.endsWith('/api/token')) return json({ access_token: 't', expires_in: 3600 });
    if (url.endsWith('/me/player')) return json({ is_playing: playing, device: { id: 'pc', name: 'PC' } });
    if (url.endsWith('/me/player/devices')) return json({ devices: [{ id: 'pc', name: 'PC', is_active: true }] });
    if (url.includes('/me/player/play')) { calls.push('lecture'); playing = true; return done; }
    if (url.includes('/me/player/pause')) { calls.push('pause'); playing = false; return done; }
    throw new Error(`inattendu : ${url}`);
  };
  f.spotify.config = { ...f.spotify.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'r',
    autoResume: true, autoPause: true, resumeDelaySec: 0, pauseLeadSec: 0 };
  return calls;
}

// Regression: relecture 2, tour 4 (relecteurs) — pendant une alerte « message
// de KaraFun illisible », l'automate de Spotify jugeait la soirée d'après la
// vue figée : file vide et KaraFun à l'arrêt, il relançait Spotify alors que
// KaraFun jouait peut-être le titre illisible ; un titre figé sur scène lui
// faisait couper la musique du bar. Pendant l'alerte, Spotify voit la soirée
// « blind » (tour 5 : plus « unknown », gardé pour KaraFun déconnecté) : rien
// n'est relancé ni coupé d'office (le bar s'en charge), et l'automate reprend
// à la vue lisible suivante.
test('valeurs imprévues : message de KaraFun illisible, Spotify ni relancé ni coupé d’après la vue figée', async t => {
  const f = harness();
  const { frames } = replayBridge(t, f);
  const calls = fakeSpotify(f);
  const oddStatus = { type: 'remote.StatusEvent', payload: { status: { state: 4, pitch: 0, tempo: 0, tracks: [], current: ODD_ITEM } } };
  // File vide, KaraFun à l'arrêt ; le bar lance dans KaraFun un titre que la
  // file ne sait pas lire : la file et l'état reçus sont ignorés.
  frames(queueEvent(ODD_ITEM), oddStatus);
  assert.equal(f.karaokeOutlook(), 'blind');
  await f.spotifyTick();
  assert.deepEqual(calls, [], 'pas relancé par-dessus le titre');
  // Vue lisible : file vide, KaraFun à l'arrêt, Spotify est relancé.
  frames(queueEvent(), isoStatus(1, null));
  assert.equal(f.karaokeOutlook(), 'silent');
  await f.spotifyTick();
  assert.deepEqual(calls, ['lecture']);
  // Un titre lisible sur scène, puis un état illisible : la vue figée garde
  // le titre sur scène.
  const A = isoItem('A-id', 777, { singer: 'Quelqu’un' });
  frames(queueEvent(A), isoStatus(4, A), oddStatus);
  assert.equal(f.karaokeOutlook(), 'blind');
  await f.spotifyTick();
  assert.deepEqual(calls, ['lecture'], 'pas coupé d’après la vue figée');
  frames(isoStatus(4, A));
  assert.equal(f.karaokeOutlook(), 'singing');
  await f.spotifyTick();
  assert.deepEqual(calls, ['lecture', 'pause'], 'état lisible : coupé');
});

// Regression: relecture 2, tour 2 (équipe rouge) — pendant un état illisible,
// « Pas prêt » retirait de KaraFun un titre qu'il pouvait être en train de
// jouer : la scène vient de l'état figé (« Priorité » refuse ce retrait pour
// la même raison). Le téléphone dit de demander au bar, qui voit l'alerte ;
// rien n'est retiré ni repoussé.
test('valeurs imprévues : état illisible, « Pas prêt » ne retire pas un titre peut-être lancé', async t => {
  const f = harness();
  const { frames, ws } = replayBridge(t, f);
  f.sched.opts.requirePresence = false;
  const tb = openTable(f, '1');
  const people = [singer(f, tb, 'Léa', 101), singer(f, tb, 'Max', 102)];
  const a = sendNext(f, 'A-id');
  const owner = people.find(s => s.person.id === a.sel.ids[0]);
  const item = isoItem('A-id', a.sel.song.songId, { singer: a.sel.label });
  frames(queueEvent(item));
  // KaraFun lance A : la file le garde en tête, l'état est illisible (numéro en texte).
  frames(queueEvent(item), { type: 'remote.StatusEvent', payload: { status: { state: '4', pitch: 0, tempo: 0, tracks: [], current: item } } });
  await assert.rejects(f.call('POST /api/table/defer', { ...owner.body, songs: 1 }),
    /^Error: KaraFun ne dit plus ce qu’il joue : ton passage ne peut pas être repoussé pour l’instant\. Demande au bar\.$/);
  assert.deepEqual(ws.out.filter(m => m.type === 'remote.RemoveFromQueueRequest'), []);
  assert.equal(owner.person.deferral ?? null, null, 'rien n’est repoussé');
  // État lisible, titre pas encore lancé : « Pas prêt » le retire de KaraFun.
  frames(isoStatus(1, item));
  const answer = await f.call('POST /api/table/defer', { ...owner.body, songs: 1 });
  assert.equal(answer.deferral.pendingRemoval, true);
  assert.deepEqual(removals(ws.out), ['A-id']);
});

// ---------------------------------------------------------------- relecture 2, tour 5
// Regression: relecture 2, tour 5 (relecture contradictoire) — pendant une
// alerte « message de KaraFun illisible », la scène vue peut être figée :
// KaraFun a pu lancer un titre suivi pas encore commencé, et il le retire
// alors de sa file. sync() le voyait sorti de la file lisible et absent de la
// scène figée, et concluait « passée dans KaraFun avant la lecture » :
// passage rendu (rollbackUnplayed), titre plus suivi, et le passage n'était
// plus compté quand l'état lisible le montrait ensuite sur scène. Même défaut
// pour un titre annulé, absent ou retiré. Ce verdict attend une vue lisible :
// un titre sur scène y est compté normalement, un titre disparu y reçoit son
// verdict.
test('valeurs imprévues : état illisible, titre suivi sorti de la file : verdict à la vue lisible, compté s’il est sur scène', async t => {
  const oddPlaying = item => ({ type: 'remote.StatusEvent', payload: { status: { state: '4', pitch: 0, tempo: 0, tracks: [], current: item } } });
  const reasons = { suivi: 'skipped-in-karafun', annulé: 'cancelled', absent: 'absent', retiré: 'pulled-defer' };
  for (const [kind, reason] of Object.entries(reasons)) for (const seen of ['sur scène', 'disparu']) {
    const label = `${kind}, ${seen}`;
    const f = harness();
    const { frames } = replayBridge(t, f);
    f.sched.opts.requirePresence = false;
    const tb = openTable(f, '1');
    const people = [singer(f, tb, 'Léa', 101), singer(f, tb, 'Tom', 201)];
    const a = sendNext(f, 'A-id'), b = sendNext(f, 'B-id');
    const owner = people.find(s => s.person.id === a.sel.ids[0]).person;
    const item = tr => isoItem(tr.queueId, tr.sel.song.songId, { singer: tr.sel.label });
    frames(queueEvent(item(a), item(b)));
    if (kind === 'annulé') a.cancelled = true;
    if (kind === 'absent') a.absent = true;
    if (kind === 'retiré') a.pulled = { reason: 'defer', at: Date.now() };
    // KaraFun lance A : l'état qui l'annonce est illisible (numéro d'état en
    // texte), puis sa file, lisible, n'a plus A.
    frames(oddPlaying(item(a)));
    frames(queueEvent(item(b)));
    assert.deepEqual(plain(f.tracked().map(tr => tr.queueId)), ['A-id', 'B-id'], `${label} : A toujours suivi pendant l’alerte`);
    assert.deepEqual(f.events('turn.unsent'), [], `${label} : aucun verdict pendant l’alerte`);
    assert.equal(a.sel.turnCredit.rolledBack, false, `${label} : passage pas rendu pendant l’alerte`);
    assert.equal(notes(f).some(line => /passée dans KaraFun avant la lecture/.test(line)), false, label);
    if (seen === 'sur scène') {
      frames(isoStatus(4, item(a)));
      assert.ok(a.startedAt, `${label} : A vu sur scène dans l’état lisible`);
      assert.deepEqual(plain(f.tracked().map(tr => tr.queueId)), ['A-id', 'B-id'], label);
      assert.deepEqual(f.events('turn.unsent'), [], label);
      assert.equal(a.sel.turnCredit.rolledBack, false, `${label} : passage gardé`);
      assert.equal(owner.sung, 1, `${label} : passage compté`);
      assert.ok(notes(f).includes(`Sur scène : ${a.sel.label} — « ${a.sel.song.title} »`), label);
    } else {
      frames(isoStatus(1, null));
      assert.deepEqual(f.events('turn.unsent').map(e => [e.queueId, e.reason]), [['A-id', reason]], `${label} : verdict à la vue lisible`);
      assert.deepEqual(plain(f.tracked().map(tr => tr.queueId)), ['B-id'], label);
      if (kind === 'suivi') {
        assert.equal(a.sel.turnCredit.rolledBack, true, label);
        assert.ok(notes(f).some(line => /passée dans KaraFun avant la lecture/.test(line)), label);
      }
    }
  }
});

// Regression: relecture 2, tour 5 — pendant l'alerte, karaokeOutlook rendait
// « unknown », que l'automate de Spotify traitait comme une période : la fin
// de l'alerte ouvrait un nouveau silence, et Spotify était relancé, ce qui
// défaisait « ⏸ Spotify » du bar, fait avant ou pendant l'alerte (GUIDE-BAR.md
// promet le contraire jusqu'au prochain titre ou au prochain silence).
// Pendant l'alerte, la soirée est « blind » : la période d'avant continue,
// avec le choix du bar. KaraFun déconnecté reste « unknown ».
test('valeurs imprévues : « ⏸ Spotify » du bar avant ou pendant l’alerte, pas défait à la fin de l’alerte', async t => {
  for (const when of ['avant', 'pendant']) {
    const f = harness();
    const { bridge, frames } = replayBridge(t, f);
    const calls = fakeSpotify(f);
    const oddStatus = { type: 'remote.StatusEvent', payload: { status: { state: 4, pitch: 0, tempo: 0, tracks: [], current: ODD_ITEM } } };
    frames(queueEvent(), isoStatus(1, null));
    await f.spotifyTick();
    assert.deepEqual(calls, ['lecture'], `${when} : silence, Spotify relancé`);
    if (when === 'avant') await f.call('POST /api/staff/spotify', { action: 'pause' });
    frames(queueEvent(ODD_ITEM), oddStatus);
    assert.equal(f.karaokeOutlook(), 'blind');
    await f.spotifyTick();
    if (when === 'pendant') await f.call('POST /api/staff/spotify', { action: 'pause' });
    await f.spotifyTick();
    assert.deepEqual(calls, ['lecture', 'pause'], `${when} : seulement la pause du bar`);
    // Fin de l'alerte : toujours le même silence.
    frames(queueEvent(), isoStatus(1, null));
    assert.equal(f.karaokeOutlook(), 'silent');
    for (let i = 0; i < 3; i++) await f.spotifyTick();
    assert.deepEqual(calls, ['lecture', 'pause'], `⏸ fait ${when} l’alerte : pas défait à sa fin`);
    // Le titre suivant, puis le silence d'après : l'automatisme reprend.
    const A = isoItem('A-id', 777, { singer: 'Quelqu’un' });
    frames(queueEvent(A), isoStatus(4, A));
    assert.equal(f.karaokeOutlook(), 'singing');
    await f.spotifyTick();
    frames(queueEvent(), isoStatus(1, null));
    await f.spotifyTick();
    assert.equal(calls.at(-1), 'lecture', `${when} : nouveau silence, Spotify relancé`);
    bridge.disconnect();
    assert.equal(f.karaokeOutlook(), 'unknown', 'KaraFun déconnecté : « unknown », comme avant');
  }
});

// Regression: relecture 2, tour 5 — seule la synchronisation lancée en
// arrière-plan passait par le filet (safeSync) : les routes appelaient sync()
// nu. Pendant la panne que ce filet absorbe (une valeur imprévue de KaraFun
// fait échouer sync()), un geste du bar ou d'un téléphone était fait (titre
// retiré), mais la route répondait par l'erreur technique, sans compter
// l'activité ni enregistrer la soirée : le bar le croyait refusé et le
// refaisait. Dans une requête, la panne est notée comme par le filet (un avis
// au bar, une ligne par minute au plus), et la route rend sa réponse. Hors
// requête, un traitement appelé directement lève toujours l'erreur.
test('filet de la synchronisation : geste fait pendant la panne, répondu, compté et enregistré par la vraie route', async () => {
  const f = harness({ persistent: true });
  const { bridge } = kcsBridge(f);
  const tb = openTable(f, '1');
  const lea = singer(f, tb, 'Léa', 101);
  const tom = singer(f, tb, 'Tom', 201);
  const zoe = singer(f, tb, 'Zoé', 301);
  const status = bridge.status;
  let fail = true;
  Object.defineProperty(bridge, 'status', { configurable: true, get() {
    if (fail) throw new TypeError('Cannot convert object to primitive value');
    return status;
  } });
  const errors = () => f.sched.log.filter(line => line.kind === 'error').map(line => line.msg);
  const saved = person => f.saves.at(-1)?.scheduler.people.find(p => p.id === person.id);
  // Le bar retire le titre de Léa.
  let saves = f.saves.length;
  const staff = await post(f, `/api/staff/remove?key=${f.STAFF_KEY}`, { personId: lea.person.id });
  assert.equal(staff.status, 200, JSON.stringify(staff.body));
  assert.deepEqual(staff.body, { ok: true });
  assert.equal(f.sched.songsOf(lea.person).length, 0, 'titre retiré');
  assert.ok(f.saves.length > saves, 'soirée enregistrée');
  assert.equal(saved(lea.person).song, null, 'la sauvegarde a le titre retiré');
  assert.deepEqual(errors(), ['La mise à jour avec KaraFun a échoué (Cannot convert object to primitive value) : la file ne pilote plus KaraFun et réessaie seule. Pilote dans KaraFun en attendant.'],
    'un seul avis au bar');
  assert.equal(f.logs.filter(line => line.startsWith('Synchronisation avec KaraFun interrompue : Cannot convert object to primitive value')).length, 1);
  // Tom retire son titre depuis son téléphone : même réponse, activité comptée.
  saves = f.saves.length;
  tom.person.lastActionAt = 0;
  const phone = await post(f, '/api/table/song/remove', { ...tom.body, entryId: tom.person.song.entryId });
  assert.equal(phone.status, 200, JSON.stringify(phone.body));
  assert.deepEqual(phone.body, { ok: true });
  assert.equal(f.sched.songsOf(tom.person).length, 0);
  assert.ok(tom.person.lastActionAt > 0, 'activité comptée');
  assert.ok(f.saves.length > saves, 'soirée enregistrée');
  assert.equal(saved(tom.person).song, null);
  assert.equal(errors().length, 1, 'toujours un seul avis pendant la même panne');
  // Hors requête (traitement appelé directement) : l'erreur remonte, comme sync().
  await assert.rejects(f.call('POST /api/staff/remove', { personId: zoe.person.id }), /^TypeError: Cannot convert object to primitive value$/);
  // Retour de la mise à jour : annoncé une fois, la file reprend.
  fail = false;
  f.safeSync();
  assert.equal(errors().length, 1);
  assert.equal(notes(f).at(-1), 'Mise à jour avec KaraFun rétablie : la file pilote de nouveau KaraFun.');
});

// Relecture 2, tour 5 — l'état d'une requête suit aussi les minuteries
// qu'elle lance (AsyncLocalStorage). Une fois la requête finie, une minuterie
// qui appellerait syncAfterChange() est hors requête : l'erreur remonte, comme
// avec sync(), au lieu d'être prise pour un geste de la requête. Route
// d'essai ajoutée au serveur, passée par la vraie enveloppe.
test('filet de la synchronisation : hors requête, ou dans une minuterie partie après la réponse, syncAfterChange lève comme sync()', async () => {
  const f = harness();
  const { bridge } = kcsBridge(f);
  Object.defineProperty(bridge, 'status', { configurable: true, get() { throw new TypeError('Cannot convert object to primitive value'); } });
  assert.throws(() => f.syncAfterChange(), /^TypeError: Cannot convert object to primitive value$/, 'hors requête');
  let fired;
  const later = new Promise(resolve => { fired = resolve; });
  f.handlers['POST /api/staff/essai-minuterie'] = async () => {
    f.syncAfterChange(); // dans la requête : panne notée, pas d'erreur
    setTimeout(() => {
      try { f.syncAfterChange(); fired('aucune erreur'); } catch (error) { fired(String(error)); }
    }, 5);
    return { ok: true, geste: 'fait' };
  };
  const answer = await post(f, `/api/staff/essai-minuterie?key=${f.STAFF_KEY}`, {});
  assert.deepEqual([answer.status, answer.body], [200, { ok: true, geste: 'fait' }]);
  assert.equal(await later, 'TypeError: Cannot convert object to primitive value', 'minuterie partie après la réponse : hors requête');
  assert.equal(f.sched.log.filter(line => line.kind === 'error').length, 1, 'un seul avis au bar');
});

// ---------------------------------------------------------------- relecture contradictoire du tour 5 (tour 1)
// État de KaraFun illisible (numéro d'état en texte), titre `current` sur scène.
const unreadableStatus = current => ({ type: 'remote.StatusEvent', payload: { status: { state: '4', pitch: 0, tempo: 0, tracks: [], current } } });

// Regression: relecture contradictoire du tour 5 (tour 1) — « blind »
// n'ouvrait pas de période et l'automate ne comparait que l'état de la
// soirée : B, lancé pendant l'alerte après la fin de A, passait à la fin de
// l'alerte pour la suite de A (« singing » des deux côtés). Le bar ayant
// relancé Spotify dans l'attente (« ▶ Spotify », comme le guide le demande
// pendant l'alerte), Spotify jouait tout B par-dessus le chanteur. Sur
// 974e589 comme sur main, B était coupé. Une période est propre à la scène
// vue : B en ouvre une, coupée à la fin de l'alerte. Alerte de l'état (A vu
// jusqu'au bout, figé) ou de la file seule (A fini puis B vus pendant
// l'alerte).
test('valeurs imprévues : un autre titre sur scène à la fin de l’alerte, Spotify coupé même après « ▶ Spotify » pendant l’alerte', async t => {
  for (const alert of ['état', 'file']) {
    const f = harness();
    const { frames } = replayBridge(t, f);
    const calls = fakeSpotify(f);
    const A = isoItem('A-id', 777, { singer: 'Quelqu’un' });
    const B = isoItem('B-id', 778, { singer: 'Autre' });
    frames(queueEvent(), isoStatus(1, null));
    await f.spotifyTick();
    frames(queueEvent(B), isoStatus(4, A));
    await f.spotifyTick();
    assert.deepEqual(calls, ['lecture', 'pause'], `${alert} : A sur scène, Spotify coupé`);
    frames(alert === 'état' ? unreadableStatus(A) : queueEvent(B, ODD_ITEM));
    assert.equal(f.karaokeOutlook(), 'blind', alert);
    await f.spotifyTick();
    if (alert === 'file') frames(isoStatus(1, null)); // A fini, vu pendant l'alerte
    await f.call('POST /api/staff/spotify', { action: 'play' }); // dans l'attente
    await f.spotifyTick();
    // Le bar lance B dans KaraFun, puis l'alerte finit pendant B.
    if (alert === 'état') frames(queueEvent(), isoStatus(4, B));
    else {
      frames(isoStatus(4, B));
      assert.equal(f.karaokeOutlook(), 'blind');
      await f.spotifyTick();
      frames(queueEvent());
    }
    assert.equal(f.karaokeOutlook(), 'singing', alert);
    for (let i = 0; i < 3; i++) await f.spotifyTick();
    assert.deepEqual(calls, ['lecture', 'pause', 'lecture', 'pause'], `${alert} : B vu après l’alerte, Spotify coupé`);
  }
});

// Regression: relecture contradictoire du tour 5 (tour 1), S1 — A sur scène,
// file illisible (alerte), A finit (l'état se lit encore), le bar touche
// « ▶ Spotify » puis « ⏸ Spotify » dans ce silence ; l'alerte finit sur le
// même silence : Spotify était relancé 3 s après, ce qui défaisait le choix
// fait pendant l'alerte. Le choix vaut pour la scène vue au moment du geste.
// L'état figé, lui, ne montre pas la fin de A : la fin de l'alerte ouvre le
// silence d'après A, et Spotify est relancé (GUIDE-BAR.md le dit).
test('valeurs imprévues : « ⏸ Spotify » fait pendant l’alerte dans le silence vu après un titre, gardé à sa fin', async t => {
  for (const alert of ['file', 'état']) {
    const f = harness();
    const { frames } = replayBridge(t, f);
    const calls = fakeSpotify(f);
    const A = isoItem('A-id', 777, { singer: 'Quelqu’un' });
    frames(queueEvent(), isoStatus(1, null));
    await f.spotifyTick();
    frames(queueEvent(), isoStatus(4, A));
    await f.spotifyTick();
    assert.deepEqual(calls, ['lecture', 'pause'], alert);
    if (alert === 'file') frames(queueEvent(ODD_ITEM), isoStatus(1, null));
    else frames(unreadableStatus(A));
    assert.equal(f.karaokeOutlook(), 'blind', alert);
    await f.call('POST /api/staff/spotify', { action: 'play' });
    await f.call('POST /api/staff/spotify', { action: 'pause' });
    for (let i = 0; i < 3; i++) await f.spotifyTick();
    assert.deepEqual(calls, ['lecture', 'pause', 'lecture', 'pause'], `${alert} : gestes du bar seulement pendant l’alerte`);
    frames(queueEvent(), isoStatus(1, null));
    assert.equal(f.karaokeOutlook(), 'silent', alert);
    for (let i = 0; i < 3; i++) await f.spotifyTick();
    if (alert === 'file') assert.deepEqual(calls, ['lecture', 'pause', 'lecture', 'pause'], 'file : même silence, « ⏸ Spotify » tient');
    else assert.deepEqual(calls, ['lecture', 'pause', 'lecture', 'pause', 'lecture'], 'état figé : la fin de A n’était pas vue, nouveau silence');
  }
});

// Regression: relecture contradictoire du tour 5 (tour 2) — une période de
// l'automate vaut pour une scène, mais la route du bar ne passait la scène
// vue qu'en « battle » et en « blind ». B enchaîné après A sans scène libre
// vue (« Suivant » dans KaraFun), « ▶ Spotify » touché pendant B avant le
// passage suivant de l'automate (toutes les 3 s) : ce passage ouvrait la
// période de B et coupait Spotify, ce qui défaisait le choix pendant le titre
// (GUIDE-BAR.md : « l'automatisme ne les défait pas avant le prochain titre
// ou le prochain silence »). Sur 974e589 comme sur main, le choix tenait.
test('« ▶ Spotify » touché pendant un titre enchaîné que l’automate n’a pas encore vu, gardé jusqu’au titre suivant', async t => {
  const f = harness();
  const { frames } = replayBridge(t, f);
  const calls = fakeSpotify(f);
  const A = isoItem('A-id', 777, { singer: 'Quelqu’un' });
  const B = isoItem('B-id', 778, { singer: 'Autre' });
  const C = isoItem('C-id', 779, { singer: 'Encore' });
  frames(queueEvent(), isoStatus(1, null));
  await f.spotifyTick();
  frames(queueEvent(B, C), isoStatus(4, A));
  await f.spotifyTick();
  assert.deepEqual(calls, ['lecture', 'pause'], 'A sur scène, Spotify coupé');
  frames(queueEvent(C), isoStatus(4, B)); // « Suivant » dans KaraFun : B aussitôt
  assert.equal(f.karaokeOutlook(), 'singing');
  await f.call('POST /api/staff/spotify', { action: 'play' });
  for (let i = 0; i < 3; i++) await f.spotifyTick();
  assert.deepEqual(calls, ['lecture', 'pause', 'lecture'], '« ▶ Spotify » pendant B, pas défait');
  frames(queueEvent(), isoStatus(4, C)); // C enchaîné, vu par l'automate : un nouveau titre
  await f.spotifyTick();
  assert.deepEqual(calls, ['lecture', 'pause', 'lecture', 'pause'], 'titre suivant : Spotify coupé de nouveau');
});

// Poignée de main de KaraFun sur la connexion rouverte par « Reconnecter »
// (dernier FakeWS), puis `messages` (sa file et son état).
function reopened(bridge, ...messages) {
  const ws = FakeWS.last;
  const receive = message => ws.emit('message', { data: JSON.stringify(message) });
  ws.emit('open');
  receive({ type: 'core.AuthenticatedEvent', payload: {} });
  receive({ type: 'remote.UsernameUpdateEvent', payload: { username: bridge.username } });
  receive({ type: 'remote.ConfigurationUpdateEvent', payload: { configuration: BAR_CONFIGURATION } });
  receive({ type: 'remote.PermissionsUpdateEvent', payload: { permissions: ADMIN } });
  for (const message of messages) receive(message);
  return ws;
}

// Regression: relecture contradictoire du tour 5 (tour 1) — « Reconnecter »,
// la sortie propre à l'alerte, rouvre la connexion : le pont n'est plus prêt
// jusqu'à la nouvelle file et le nouvel état. Un passage de l'automate (toutes
// les 3 s) y voyait « unknown », une période : le silence vu ensuite était
// nouveau, et Spotify relancé malgré « ⏸ Spotify » fait pendant l'alerte.
// La reconnexion demandée depuis l'alerte en fait partie (« blind ») jusqu'à
// la première vue complète de KaraFun ; une connexion perdue, elle, rend
// KaraFun déconnecté (« unknown »), comme sans alerte.
test('valeurs imprévues : « Reconnecter » de l’alerte, « ⏸ Spotify » gardé jusqu’à la vue de KaraFun ; connexion perdue : déconnecté', async t => {
  const f = harness();
  const rb = replayBridge(t, f);
  const { bridge, frames } = rb;
  const calls = fakeSpotify(f);
  frames(queueEvent(), isoStatus(1, null));
  await f.spotifyTick();
  assert.deepEqual(calls, ['lecture'], 'silence : Spotify relancé');
  // Code connu du serveur et URL KCS gardée, comme après une vraie connexion.
  bridge.code = '123456';
  bridge._kcs = { code: '123456', url: 'wss://kcs.exemple.invalid/remote' };
  assert.equal(f.connectKaraFun('123456'), 'kept');
  frames(queueEvent(ODD_ITEM), unreadableStatus(ODD_ITEM));
  assert.equal(f.karaokeOutlook(), 'blind');
  await f.call('POST /api/staff/spotify', { action: 'pause' });
  assert.deepEqual(calls, ['lecture', 'pause'], '« ⏸ Spotify » pendant l’alerte');
  // « Reconnecter » de l'alerte, par la vraie route.
  let before = FakeWS.last;
  assert.deepEqual(plain(await f.call('POST /api/staff/kf', { action: 'reconnect' })), { ok: true, kept: false });
  assert.notEqual(FakeWS.last, before, 'connexion rouverte');
  assert.equal(bridge.ready, false);
  assert.equal(f.karaokeOutlook(), 'blind', 'reconnexion demandée depuis l’alerte : l’alerte continue pour Spotify');
  await f.spotifyTick();
  f.sync();
  assert.equal(f.karaokeOutlook(), 'blind', 'toujours en cours');
  // KaraFun renvoie sa file et son état : même silence, le choix du bar tient.
  reopened(bridge, queueEvent(), isoStatus(1, null));
  f.sync();
  assert.equal(bridge.ready, true);
  assert.equal(f.karaokeOutlook(), 'silent');
  for (let i = 0; i < 3; i++) await f.spotifyTick();
  assert.deepEqual(calls, ['lecture', 'pause'], '« ⏸ Spotify » pas défait');
  // Plus tard, KaraFun déconnecté sans alerte, puis « Connecter » : KaraFun
  // déconnecté (« unknown ») jusqu'à sa vue, comme avant.
  bridge.disconnect();
  assert.equal(f.karaokeOutlook(), 'unknown', 'déconnexion après la reconnexion : KaraFun déconnecté');
  assert.equal(f.connectKaraFun('123456'), 'started');
  assert.equal(bridge.connectionState().phase, 'opening');
  assert.equal(f.karaokeOutlook(), 'unknown', 'connexion sans alerte : KaraFun déconnecté');
  // Nouvelle alerte, « Reconnecter », puis la connexion rouverte est perdue
  // (nouvel essai prévu) : KaraFun est déconnecté.
  rb.reconnect();
  frames(queueEvent(), isoStatus(1, null));
  frames(queueEvent(ODD_ITEM));
  assert.equal(f.karaokeOutlook(), 'blind');
  before = FakeWS.last;
  assert.deepEqual(plain(await f.call('POST /api/staff/kf', { action: 'reconnect' })), { ok: true, kept: false });
  assert.notEqual(FakeWS.last, before);
  assert.equal(f.karaokeOutlook(), 'blind');
  FakeWS.last.emit('close', { code: 1006 });
  assert.equal(bridge.connectionState().phase, 'retry');
  assert.equal(f.karaokeOutlook(), 'unknown', 'connexion perdue : KaraFun déconnecté');
  f.sync();
  assert.equal(f.karaokeOutlook(), 'unknown');
});

// Regression: relecture contradictoire du tour 5 (tour 1) — le délai d'un
// retrait annulé (PULL_LATE_MS : retrait de fermeture annulé par une heure
// décalée, duo défait), que KaraFun applique quand même, se comptait au
// verdict, donc à la fin d'une alerte de l'état, au lieu de la sortie du
// titre de la file. Une alerte de plus de 20 s concluait « passée dans
// KaraFun avant la lecture » : titre perdu pour son chanteur, au lieu de lui
// revenir (974e589 : « pulled-closing » ou « pulled-duo »). La sortie de la
// file vue pendant l'alerte est datée, et le délai compté depuis elle.
test('valeurs imprévues : retrait annulé que KaraFun fait pendant une longue alerte de l’état, le titre revient à son chanteur', async t => {
  for (const reason of ['closing', 'duo']) {
    const clock = clockAt('2026-11-14T22:00:00.000Z');
    const f = harness({ Date: clock.Date });
    const { frames } = replayBridge(t, f);
    f.sched.opts.requirePresence = false;
    const tb = openTable(f, '1');
    const people = [singer(f, tb, 'Léa', 101), singer(f, tb, 'Tom', 201)];
    const a = sendNext(f, 'A-id'), b = sendNext(f, 'B-id');
    const owner = people.find(s => s.person.id === a.sel.ids[0]).person;
    const item = tr => isoItem(tr.queueId, tr.sel.song.songId, { singer: tr.sel.label });
    const C = isoItem('C-id', 555, { singer: 'Autre' });
    frames(queueEvent(item(a), item(b)), isoStatus(4, C));
    // Retrait déjà envoyé, puis annulé : il peut encore aboutir.
    a.unpulled = { reason, at: clock.now };
    frames(unreadableStatus(C));
    assert.equal(f.karaokeOutlook(), 'blind');
    clock.now += 5000;
    frames(queueEvent(item(b))); // KaraFun fait le retrait
    assert.deepEqual(f.events('turn.unsent'), [], `${reason} : verdict à la fin de l’alerte`);
    clock.now += 60000;
    frames(isoStatus(4, C)); // fin de l'alerte, 65 s après l'annulation
    assert.deepEqual(f.events('turn.unsent').map(e => [e.queueId, e.reason]), [['A-id', `pulled-${reason}`]], reason);
    assert.ok(f.sched.songsOf(owner).some(song => song.songId === a.sel.song.songId), `${reason} : le titre revient à son chanteur`);
    assert.equal(notes(f).some(line => /passée dans KaraFun avant la lecture/.test(line)), false, reason);
    assert.ok(notes(f).includes(reason === 'duo' ?
      `« ${a.sel.song.title} » (${a.sel.label}) retiré de KaraFun malgré l’annulation du duo : il revient en tête de la liste de son chanteur.` :
      `« ${a.sel.song.title} » (${a.sel.label}) retiré de KaraFun juste avant le changement de l’heure de fermeture : il revient dans la liste de son chanteur.`), reason);
    // Sortie de la file au-delà du délai, même pendant l'alerte : passée dans
    // KaraFun, comme sans alerte.
    const late = sendNext(f, 'D-id');
    frames(queueEvent(item(b), item(late)), isoStatus(4, C));
    late.unpulled = { reason, at: clock.now };
    frames(unreadableStatus(C));
    clock.now += 25000;
    frames(queueEvent(item(b)));
    clock.now += 1000;
    frames(isoStatus(4, C));
    assert.deepEqual(f.events('turn.unsent').map(e => [e.queueId, e.reason]).at(-1), ['D-id', 'skipped-in-karafun'], `${reason} : délai dépassé`);
  }
});

// Panne de référence : un vrai pont KaraFun prêt dont l'état ne se lit plus
// (getter qui lève) ; sync() échoue, et toute lecture de KaraFun aussi.
function breakStatus(bridge) {
  const status = bridge.status;
  const broken = { on: true };
  Object.defineProperty(bridge, 'status', { configurable: true, get() {
    if (broken.on) throw new TypeError('Cannot convert object to primitive value');
    return status;
  } });
  return broken;
}
const barErrors = f => f.sched.log.filter(line => line.kind === 'error').map(line => line.msg);
const SYNC_FAILED = 'La mise à jour avec KaraFun a échoué (Cannot convert object to primitive value) : la file ne pilote plus KaraFun et réessaie seule. Pilote dans KaraFun en attendant.';

// Regression: relecture contradictoire du tour 5 (tour 1) — syncAfterChange
// absorbait la panne de sync(), mais ces routes relisaient KaraFun après le
// geste (avis de titre déjà chanté : repeatNotice puis publicState, lien de
// la Battle), dans le mode de panne même de la reproduction : le geste était
// fait (titre ajouté, invitation créée, vote compté), puis la route
// répondait 400 « Cannot convert object to primitive value », sans activité
// ni soirée enregistrée, et le téléphone qui refaisait le geste lisait « déjà
// dans la liste ». Le complément relu après le geste est sous le même filet :
// la route répond sans lui.
test('filet de la synchronisation : panne qui empêche de lire KaraFun, gestes des téléphones répondus, comptés et enregistrés', async () => {
  const f = harness({ persistent: true });
  const { bridge } = kcsBridge(f);
  f.setCode('123456'); // lien de la Battle relu après un vote
  const tb = openTable(f, '1', 6);
  const lea = singer(f, tb, 'Léa', 101);
  const tom = singer(f, tb, 'Tom', 201);
  const zoe = singer(f, tb, 'Zoé', 301);
  const max = singer(f, tb, 'Max', 401);
  const sam = singer(f, tb, 'Sam', 501);
  f.battleVote.propose({ personId: max.person.id, personName: 'Max', eligiblePersonIds: [lea, tom, zoe, max, sam].map(s => s.person.id),
    songs: [{ songId: 900, title: 'Tube', artist: 'Groupe' }, { songId: 901, title: 'Autre tube', artist: 'Groupe' }], proposerChoice: 900 });
  breakStatus(bridge);
  const saved = person => f.saves.at(-1)?.scheduler.people.find(p => p.id === person.id);
  const answer = async (url, body, who) => {
    const saves = f.saves.length;
    who.person.lastActionAt = 0;
    const reply = await post(f, url, body);
    assert.equal(reply.status, 200, `${url} : ${JSON.stringify(reply.body)}`);
    assert.ok(f.saves.length > saves, `${url} : soirée enregistrée`);
    assert.ok(who.person.lastActionAt > 0, `${url} : activité comptée`);
    return reply.body;
  };
  // Ajouter un titre (téléphone de la table, puis ancienne route au jeton).
  assert.deepEqual(await answer('/api/table/song', { ...lea.body, song: { songId: 555, title: 'Nouveau', artist: 'Artiste' } }, lea),
    { ok: true, notice: null });
  assert.deepEqual(f.sched.songsOf(lea.person).map(s => s.songId), [101, 555]);
  assert.ok(saved(lea.person), 'la sauvegarde a Léa');
  assert.deepEqual(await answer('/api/song', { token: zoe.person.token, song: { songId: 556, title: 'Autre', artist: 'Artiste' } }, zoe),
    { ok: true });
  assert.deepEqual(f.sched.songsOf(zoe.person).map(s => s.songId), [556], 'titre de Zoé remplacé');
  // Inviter en duo, ouvrir un duo à toute la salle.
  const invited = await answer('/api/table/duet', { ...lea.body, partnerId: tom.person.id, song: { songId: 557, title: 'Duo', artist: 'Artiste' } }, lea);
  assert.deepEqual(invited, { ok: true, notice: null });
  assert.ok(f.sched.songsOf(lea.person).some(s => s.songId === 557 && s.duet?.partnerId === tom.person.id), 'invitation créée');
  f.rememberBattleSongs([{ songId: 558, title: 'Ouvert', artist: 'Artiste' }]); // titre lu dans le catalogue
  const opened = await answer('/api/table/duet/open', { ...tom.body, song: { songId: 558, title: 'Ouvert', artist: 'Artiste' } }, tom);
  assert.equal(opened.notice, null);
  assert.ok(f.sched.songsOf(tom.person).some(s => s.entryId === opened.entryId && s.duet?.state === 'open'), 'duo ouvert');
  // Voter pour la Battle : vote compté, sans le lien de KaraFun relu après.
  const voted = await answer('/api/table/battle/vote', { ...tom.body, choice: 900 }, tom);
  assert.equal(voted.battle.joinUrl, null);
  assert.ok(f.battleVote.ballot.votes.some(([voter]) => voter === tom.person.id), 'vote compté');
  assert.deepEqual(barErrors(f), [SYNC_FAILED], 'un seul avis au bar pendant la panne');
});

// Même regression, gestes du bar : « Sélectionner » (retrait groupé) retirait
// les titres de la file, puis lisait la scène pour ceux de KaraFun et
// levait ; « ⏸ Spotify » coupait Spotify, puis lisait la soirée avant de
// noter le choix du bar (handled), jamais noté ; « Réordonner » était refusé
// par la lecture de KaraFun faite avant le geste (nombre de titres déjà
// chargés, pour le message). Ils répondent : les titres de la file sont
// retirés et ceux de KaraFun signalés ignorés (rien n'y est retiré sans voir
// la scène), le choix Spotify est noté, le passage déplacé. Un geste qui doit
// d'abord lire KaraFun pour décider (annuler un duo improvisé : ses titres
// encore dans KaraFun y restent) est refusé avant tout changement : il
// défaisait le duo à moitié.
test('filet de la synchronisation : panne qui empêche de lire KaraFun, gestes du bar répondus, ou refusés sans rien changer', async () => {
  const f = harness({ persistent: true });
  const { bridge, sent } = kcsBridge(f);
  const calls = fakeSpotify(f);
  const tb = openTable(f, '1', 6);
  const lea = singer(f, tb, 'Léa', 101);
  const tom = singer(f, tb, 'Tom', 201);
  const zoe = singer(f, tb, 'Zoé', 301);
  const max = singer(f, tb, 'Max', 401);
  singer(f, tb, 'Sam', 501);
  f.sched.opts.requirePresence = false;
  // A sur scène, avec un duo improvisé noté par le bar ; B déjà chargé dans KaraFun.
  const a = sendNext(f, 'A-id'), b = sendNext(f, 'B-id');
  const itemA = kfItem('A-id', a.sel.song.songId, a.sel.label), itemB = kfItem('B-id', b.sel.song.songId, b.sel.label);
  bridge.queue = [itemA, itemB];
  bridge.status = playing(itemA);
  f.sync();
  assert.ok(a.startedAt, 'A sur scène');
  const partner = [lea, tom, zoe, max].find(s => !a.sel.ids.includes(s.person.id) && !b.sel.ids.includes(s.person.id));
  await f.call('POST /api/staff/duo-mark', { queueId: 'A-id', partnerId: partner.person.id });
  assert.deepEqual(plain(a.sel.ids), [a.sel.ids[0], partner.person.id], 'duo noté');
  await f.call('POST /api/staff/spotify', { action: 'play' });
  const broken = breakStatus(bridge);
  const staff = async (route, body) => post(f, `${route}?key=${f.STAFF_KEY}`, body);
  // « Sélectionner » : un titre de la file et le titre B de KaraFun.
  const waiting = [lea, tom, zoe, max].find(s => !a.sel.ids.includes(s.person.id) && !b.sel.ids.includes(s.person.id) &&
    f.sched.songsOf(s.person).length);
  const entry = f.sched.songsOf(waiting.person)[0];
  let saves = f.saves.length;
  const many = await staff('/api/staff/remove-many', { items: [{ personId: waiting.person.id, entryId: entry.entryId }], queueIds: ['B-id'] });
  assert.equal(many.status, 200, JSON.stringify(many.body));
  assert.deepEqual(many.body, { ok: true, removed: 1, skipped: 1,
    message: '1 titre retiré ; 1 ignoré (état de KaraFun illisible : retire-le dans KaraFun).' });
  assert.equal(f.sched.songsOf(waiting.person).some(s => s.entryId === entry.entryId), false, 'titre de la file retiré');
  assert.deepEqual(removals(sent), [], 'rien retiré de KaraFun sans voir la scène');
  assert.ok(f.saves.length > saves, 'soirée enregistrée');
  // « ⏸ Spotify » : Spotify coupé, et le choix du bar noté.
  f.spotifyAutomation.step('silent', { autoResume: false });
  assert.equal(f.spotifyAutomation.done, false);
  const paused = await staff('/api/staff/spotify', { action: 'pause' });
  assert.deepEqual([paused.status, paused.body], [200, { ok: true, result: 'done' }]);
  assert.deepEqual(calls, ['lecture', 'pause']);
  assert.equal(f.spotifyAutomation.done, true, 'choix du bar noté');
  // « Réordonner » : le deuxième passage de la file passe en tête.
  saves = f.saves.length;
  const [first, second] = f.sched.presenceView().filter(v => !v.future).map(v => v.ids[0]);
  assert.ok(first && second, 'deux passages dans la file');
  const moved = await staff('/api/staff/move', { personId: second, toIndex: 0 });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.changed, undefined, 'déplacé');
  assert.deepEqual(f.sched.presenceView().filter(v => !v.future).map(v => v.ids[0]).slice(0, 2), [second, first]);
  assert.ok(f.saves.length > saves, 'soirée enregistrée');
  // Annuler le duo improvisé : refusé avant tout changement.
  const undo = await staff('/api/staff/duo-unmark', { queueId: 'A-id' });
  assert.deepEqual([undo.status, undo.body.error], [400, 'Cannot convert object to primitive value']);
  assert.deepEqual(plain(a.sel.ids), [a.sel.ids[0], partner.person.id], 'duo toujours noté');
  assert.ok(a.sel.staffDuo, 'reçu du duo gardé');
  assert.deepEqual(barErrors(f), [SYNC_FAILED], 'un seul avis au bar');
  // Mise à jour rétablie : le duo s'annule.
  broken.on = false;
  f.safeSync();
  await f.call('POST /api/staff/duo-unmark', { queueId: 'A-id' });
  assert.deepEqual(plain(a.sel.ids), [a.sel.ids[0]]);
});
// Regression: relecture gstack-review de la branche finale (spécialiste des
// essais) — un déplacement ou une « Priorité » du bar pendant la panne notait
// son changement manuel sans empreinte de KaraFun (routeRead rendait null) :
// la soirée enregistrée était refusée à la reprise (« changement manuel mal
// formé ») et le serveur ne redémarrait plus de cette soirée. Sans empreinte
// lisible, le changement porte une empreinte qu'aucune file ne donne : son
// annulation reprend l'ordre comme après un autre changement, et la soirée se
// reprend.
test('filet de la synchronisation : déplacement du bar pendant la panne, soirée enregistrée qui se reprend', async () => {
  const { restoreNight } = require('../night-state');
  const { Scheduler } = require('../scheduler');
  const { TableAccess } = require('../table-access');
  const f = harness({ persistent: true });
  const { bridge } = kcsBridge(f);
  const tb = openTable(f, '1', 6);
  for (const [name, song] of [['Léa', 101], ['Tom', 201], ['Zoé', 301]]) singer(f, tb, name, song);
  f.sched.opts.requirePresence = false;
  f.sync();
  breakStatus(bridge);
  const [, second] = f.sched.presenceView().filter(v => !v.future).map(v => v.ids[0]);
  const saves = f.saves.length;
  const moved = await post(f, `/api/staff/move?key=${f.STAFF_KEY}`, { personId: second, toIndex: 0 });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.ok(f.saves.length > saves, 'soirée enregistrée');
  const scheduler = new Scheduler({ solverEnabled: false });
  assert.doesNotThrow(() => restoreNight(f.saves.at(-1), { scheduler, access: new TableAccess(), settings: { auto: true } }),
    'la soirée enregistrée pendant la panne se reprend');
  const change = scheduler.manualChanges.at(-1);
  assert.equal(change?.personId, second, 'changement repris');
  assert.equal(change.native, '0'.repeat(64), 'empreinte de panne : aucune file ne la donne, annulation comme après un autre changement');
});

// ---------------------------------------------------------------- relecture contradictoire du tour 5 (tour 2)
// Ligne de GUIDE-BAR.md qui commence par `start` (un paragraphe, ou un point
// de liste).
function guideLine(start) {
  const line = fs.readFileSync(path.join(root, 'GUIDE-BAR.md'), 'utf8').split(/\r?\n/).find(text => text.startsWith(start));
  assert.ok(line, `GUIDE-BAR.md : ligne « ${start}… » introuvable`);
  return line;
}
const OUTAGE_PARAGRAPH = 'Si la mise à jour de la file avec KaraFun échoue quand même';
const OUTAGE_ERROR = 'Cannot convert object to primitive value';

// Lecture HTTP (GET) passée au gestionnaire du serveur.
function get(f, url) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1', localPort: f.PORT }, destroy() {} });
    const out = { status: null, headers: {} };
    const res = { setHeader(name, value) { out.headers[name.toLowerCase()] = value; }, getHeader() {}, removeHeader() {},
      writeHead(status, headers = {}) { out.status = status; Object.assign(out.headers, headers); },
      end(data = '') { try { out.body = JSON.parse(String(data)); } catch { out.body = String(data); } resolve(out); } };
    f.handle(req, res);
  });
}

// Soirée de la panne de référence : quatre chanteurs d'une table (deux titres
// pour Léa, rien dans KaraFun) et un déplacement du bar, à annuler. Avec
// `loaded`, A est sur scène et B chargé dans KaraFun ; avec `sentDuo`, le duo
// de Léa et Tom est chargé dans KaraFun ; `presence` : « Je suis là »
// obligatoire. `first()` : le prochain passage.
async function outageScene({ presence = false, loaded = false, sentDuo = false } = {}) {
  const f = harness({ persistent: true });
  const { bridge } = kcsBridge(f);
  f.sched.opts.requirePresence = presence;
  const tb = openTable(f, '1', 8);
  const s = {};
  if (sentDuo) {
    // Même table : le duo est accepté d'office, et c'est le seul passage.
    s.lea = singer(f, tb, 'Léa');
    s.tom = singer(f, tb, 'Tom');
    await f.call('POST /api/table/duet', { ...s.lea.body, partnerId: s.tom.person.id, song: { songId: 557, title: 'Duo', artist: 'Artiste' } });
    s.duo = sendNext(f, 'D-id');
    assert.equal(s.duo.sel.ids.length, 2, 'duo chargé dans KaraFun');
    bridge.queue = [kfItem('D-id', s.duo.sel.song.songId, s.duo.sel.label)];
  }
  s.lea ??= singer(f, tb, 'Léa', 101);
  s.tom ??= singer(f, tb, 'Tom', 201);
  s.zoe = singer(f, tb, 'Zoé', 301);
  s.max = singer(f, tb, 'Max', 401);
  f.sched.chooseSong(s.lea.person, { songId: 102, title: 'Titre 102', artist: 'Artiste' }, 'append');
  if (loaded) {
    s.a = sendNext(f, 'A-id');
    s.b = sendNext(f, 'B-id');
    const itemA = kfItem('A-id', s.a.sel.song.songId, s.a.sel.label);
    bridge.queue = [itemA, kfItem('B-id', s.b.sel.song.songId, s.b.sel.label)];
    bridge.status = playing(itemA);
  }
  f.sync();
  await f.call('POST /api/staff/move', { personId: s.max.person.id, toIndex: 0 });
  const people = [s.lea, s.tom, s.zoe, s.max];
  s.first = () => people.find(who => who.person.id === f.sched.presenceView().find(v => !v.future).ids[0]);
  s.free = () => people.find(who => !s.a?.sel.ids.includes(who.person.id) && !s.b?.sel.ids.includes(who.person.id));
  return { f, bridge, s, tb };
}
const staffUrl = (f, route) => `${route}?key=${f.STAFF_KEY}`;
const BATTLE_SONGS = [{ songId: 900, title: 'Tube', artist: 'Groupe' }, { songId: 901, title: 'Autre tube', artist: 'Groupe' }];

// Gestes qui lisent KaraFun pour décider, avant tout changement :
// [page, nom dans GUIDE-BAR.md, soirée, requête].
const OUTAGE_REFUSED = [
  ['téléphones', '« Je suis là »', { presence: true }, (f, s) => ['/api/table/confirm', { ...s.first().body }]],
  ['téléphones', '« Pas prêt »', {}, (f, s) => ['/api/table/defer', { ...s.first().body, songs: 1 }]],
  ['téléphones', "les réglages d'un titre", {}, (f, s) => ['/api/table/song/settings',
    { ...s.lea.body, entryId: f.sched.songsOf(s.lea.person)[0].entryId, settings: { pitch: 1 } }]],
  ['téléphones', '« Proposer une Battle »', {}, (f, s) => ['/api/table/battle/propose', { ...s.tom.body, songs: BATTLE_SONGS, proposerChoice: 900 }]],
  ['téléphones', '« Je ne chante plus ce duo »', { sentDuo: true }, (f, s) => ['/api/table/duet/leave',
    { ...s.tom.body, ownerId: s.lea.person.id, entryId: s.duo.sel.song.entryId }]],
  ['téléphones', '« Chanter seul »', { sentDuo: true }, (f, s) => ['/api/table/duet/solo', { ...s.lea.body, entryId: s.duo.sel.song.entryId }]],
  ['bar', '« ▶ Lecture »', {}, f => [staffUrl(f, '/api/staff/kf'), { action: 'play' }]],
  ['bar', '« ⏮ Relancer depuis le début »', {}, f => [staffUrl(f, '/api/staff/kf'), { action: 'restart' }]],
  ['bar', '« Réglages en direct »', { loaded: true }, f => [staffUrl(f, '/api/staff/kf'), { action: 'pitch', value: 1 }]],
  ['bar', "les réglages d'un titre à venir", {}, (f, s) => [staffUrl(f, '/api/staff/song/settings'),
    { entryId: f.sched.songsOf(s.lea.person)[0].entryId, settings: { pitch: 1 } }]],
  ['bar', '« Parti »', {}, (f, s) => [staffUrl(f, '/api/staff/person/leave'), { personId: s.tom.person.id }]],
  ['bar', '« Table partie »', {}, f => [staffUrl(f, '/api/staff/table-left'), { id: '1' }]],
  ['bar', '« Annuler ce changement »', {}, f => [staffUrl(f, '/api/staff/manual-change-undo'), { id: f.sched.manualChanges.at(-1).id }]],
  ['bar', '« Annuler tous les changements manuels »', {}, f => [staffUrl(f, '/api/staff/queue-recalculate'), {}]],
  ['bar', "« Recalculer la file » s'il reste un changement manuel", {}, f => [staffUrl(f, '/api/staff/queue-optimize'), {}]],
  ['bar', '« Vider toutes les chansons »', {}, f => [staffUrl(f, '/api/staff/queue-clear'), { confirmation: 'VIDER TOUTES LES CHANSONS' }]],
  ['bar', '« Supprimer toutes les tables »', {}, f => [staffUrl(f, '/api/staff/tables-clear'), { confirmation: 'SUPPRIMER TOUTES LES TABLES' }]],
  ['bar', '« Vider » les derniers passages', {}, f => [staffUrl(f, '/api/staff/stage-history/clear'), {}]],
  ['bar', 'le duo improvisé noté', { loaded: true }, (f, s) => [staffUrl(f, '/api/staff/duo-mark'), { queueId: 'A-id', partnerId: s.free().person.id }]],
  ['bar', '« Priorité » qui retire un titre chargé', { loaded: true }, (f, s) => [staffUrl(f, '/api/staff/move'),
    { personId: s.free().person.id, toIndex: 0, priority: true, pullLoaded: true, queueId: 'B-id' }]],
  ['bar', '« Vérifier et mettre à jour »', {}, f => {
    // Serveur Linux dont l'agent de mise à jour est prêt ; rien ne part ici.
    const view = f.serverUpdate.view;
    f.serverUpdate.view = blocked => ({ ...view(blocked), enabled: true, busy: false });
    f.serverUpdate.request = () => { throw new Error('mise à jour demandée'); };
    return [staffUrl(f, '/api/staff/update'), { confirmActive: true }];
  }],
];
// Gestes qui se passent de KaraFun : répondus et enregistrés.
const OUTAGE_ACCEPTED = [
  ['téléphones', 'retirer un titre', {}, (f, s) => ['/api/table/song/remove', { ...s.lea.body, entryId: f.sched.songsOf(s.lea.person)[1].entryId }]],
  ['téléphones', 'réordonner', {}, (f, s) => ['/api/table/song/reorder', { ...s.lea.body, entryId: f.sched.songsOf(s.lea.person)[1].entryId, toIndex: 0 }]],
  ['téléphones', 'inviter en duo', {}, (f, s) => ['/api/table/duet', { ...s.zoe.body, partnerId: s.tom.person.id, song: { songId: 557, title: 'Duo', artist: 'Artiste' } }]],
  ['bar', '« ⏭ Passer »', {}, f => [staffUrl(f, '/api/staff/kf'), { action: 'next' }]],
  ['bar', '« Toujours là »', {}, (f, s) => [staffUrl(f, '/api/staff/person/present'), { personId: s.tom.person.id }]],
  ['bar', '« Réactiver »', {}, async (f, s) => {
    await f.call('POST /api/staff/person/leave', { personId: s.tom.person.id });
    return [staffUrl(f, '/api/staff/person/reactivate'), { personId: s.tom.person.id }];
  }],
];

// Regression: relecture contradictoire du tour 5 (tour 2) — le paragraphe de
// GUIDE-BAR.md sur cette panne disait qu'un geste « compte quand même : il
// est enregistré, sans message d'erreur », et ne nommait comme refusés, quand
// l'état de KaraFun ne se lit plus, que « Pas prêt » d'un titre déjà chargé,
// le duo improvisé et « Priorité » avec retrait. Or tout « Pas prêt » lit
// KaraFun avant de chercher un titre chargé (deferTurn), « Je suis là » lit
// le prochain passage dans KaraFun (presenceCandidate), et d'autres gestes
// lisent KaraFun pour décider avant tout changement : refusés avec le
// message de l'erreur, rien ne change. La page du bar et les téléphones ne
// relisent plus la soirée non plus. Chaque geste passe par la vraie
// enveloppe ; le guide nomme exactement ceux qui sont refusés.
test('filet de la synchronisation : panne qui empêche de lire KaraFun, le guide du bar nomme chaque geste refusé', async () => {
  const paragraph = guideLine(OUTAGE_PARAGRAPH);
  const start = paragraph.search(/(Un geste qui doit|Les gestes qui doivent) d'abord lire KaraFun pour décider/);
  const refused = start < 0 ? '' : paragraph.slice(start, start + paragraph.slice(start).search(/[Rr]éessaie/));
  const parts = { téléphones: refused.slice(0, refused.indexOf(' ; au bar,')), bar: refused.slice(refused.indexOf(' ; au bar,')) };
  const missing = [], named = [];
  for (const [page, name, options, request] of OUTAGE_REFUSED) {
    const { f, bridge, s } = await outageScene(options);
    const [url, body] = await request(f, s);
    breakStatus(bridge);
    await new Promise(setImmediate); // sauvegardes d'avant le geste
    const before = { version: f.sched.version, notes: f.sched.log.length, saves: f.saves.length };
    const reply = await post(f, url, body);
    assert.deepEqual([reply.status, reply.body.error], [400, OUTAGE_ERROR], `${name} : refusé par la panne`);
    assert.equal(f.saves.length, before.saves, `${name} : rien d'enregistré`);
    assert.equal(f.sched.version - before.version, f.sched.log.length - before.notes, `${name} : rien ne change, sauf l'avis au bar`);
    if (!parts[page].includes(name)) missing.push(`${page} : ${name}`);
  }
  for (const [page, name, options, request] of OUTAGE_ACCEPTED) {
    const { f, bridge, s } = await outageScene(options);
    const [url, body] = await request(f, s);
    breakStatus(bridge);
    await new Promise(setImmediate);
    const saves = f.saves.length;
    const reply = await post(f, url, body);
    assert.equal(reply.status, 200, `${page}, ${name} : ${JSON.stringify(reply.body)}`);
    assert.ok(f.saves.length > saves, `${name} : soirée enregistrée`);
    if (refused.includes(name)) named.push(name);
  }
  // La page du bar et les téléphones ne relisent plus la soirée : la page du
  // bar affiche « Programme arrêté ? », le téléphone « Hors ligne ».
  const { f, bridge, s, tb } = await outageScene();
  breakStatus(bridge);
  const bar = await get(f, `/api/staff/state?key=${f.STAFF_KEY}`);
  const phone = await get(f, `/api/state?table=${tb.table}&access=${tb.access}&token=${s.lea.person.token}`);
  assert.deepEqual([bar.status, bar.body.error, phone.status, phone.body.error], [400, OUTAGE_ERROR, 400, OUTAGE_ERROR]);
  assert.match(fs.readFileSync(path.join(root, 'public', 'staff.html'), 'utf8'), /key \? 'Programme arrêté \?' :/);
  assert.match(fs.readFileSync(path.join(root, 'public', 'client.html'), 'utf8'), /setConnection\(\(\) => t\('Hors ligne'\), 'bad'\);/);
  // Le guide.
  assert.deepEqual(missing, [], 'GUIDE-BAR.md : gestes refusés pendant la panne, absents de sa liste');
  assert.deepEqual(named, [], 'GUIDE-BAR.md : gestes acceptés pendant la panne, nommés parmi les refusés');
  assert.doesNotMatch(paragraph, /« Pas prêt » d['’]un titre déjà chargé/, '« Pas prêt » est refusé même pour un titre de la liste');
  for (const shown of ['« Programme arrêté ? »', '« Hors ligne »', "l'avis de la panne n'apparaît qu'à la reprise"]) {
    assert.ok(paragraph.includes(shown), `GUIDE-BAR.md : ${shown}`);
  }
});

// Même relecture — « réessaie quand la mise à jour reprend » ne vaut pas pour
// « Je suis là » : quand la scène était libre, le délai de réponse court
// pendant la panne, et la personne est traitée dès la reprise comme sans
// réponse (le passage suivant d'abord, elle juste après). « Priorité » lui
// redonne la demande. Un titre sur scène au début de la panne, fini pendant
// celle-ci : le délai part de la reprise. Le guide le dit.
test('filet de la synchronisation : panne qui empêche de lire KaraFun, « Je suis là » refusé, puis passage sauté à la reprise si la scène était libre', async () => {
  for (const before of ['scène libre', 'titre sur scène']) {
    const clock = clockAt('2026-11-16T21:00:00.000Z');
    const f = harness({ persistent: true, Date: clock.Date });
    const { bridge } = kcsBridge(f);
    f.sched.opts.requirePresence = true;
    f.settings.auto = true;
    const tb = openTable(f, '1', 6);
    const lea = singer(f, tb, 'Léa', 101);
    singer(f, tb, 'Tom', 201);
    singer(f, tb, 'Zoé', 301);
    if (before === 'titre sur scène') bridge.status = playing(kfItem('X-id', 999, 'Autre'));
    f.safeSync();
    assert.deepEqual(plain(f.staffState().presencePending), ['Léa'], `${before} : Léa doit confirmer`);
    breakStatus(bridge);
    clock.now += 10000;
    f.safeSync();
    const refused = await post(f, '/api/table/confirm', { ...lea.body });
    assert.deepEqual([refused.status, refused.body.error], [400, OUTAGE_ERROR], `${before} : « Je suis là » refusé`);
    clock.now += f.settings.presenceGraceSec * 1000;
    f.safeSync();
    // Reprise, scène libre (le titre X a fini pendant la panne).
    Object.defineProperty(bridge, 'status', { configurable: true, writable: true, value: { state: 'idle', current: null } });
    f.safeSync();
    assert.equal(notes(f).at(-1), 'Mise à jour avec KaraFun rétablie : la file pilote de nouveau KaraFun.');
    if (before === 'titre sur scène') {
      assert.deepEqual(plain(f.staffState().presencePending), ['Léa'], 'délai parti de la reprise : Léa peut encore confirmer');
      assert.equal(f.sched.presenceSkipsOf(lea.person), 0);
      continue;
    }
    assert.deepEqual(plain(f.staffState().presencePending), ['Tom'], 'le passage suivant d’abord');
    assert.equal(f.sched.presenceSkipsOf(lea.person), 1);
    assert.ok(notes(f).includes('Léa n\'a pas confirmé sa présence : « Titre 101 » laisse passer le titre suivant et revient juste après (1/3)'));
    // « Priorité » sur son titre : la demande revient à Léa, qui confirme.
    const priority = await post(f, staffUrl(f, '/api/staff/move'), { personId: lea.person.id, toIndex: 0, priority: true });
    assert.equal(priority.status, 200, JSON.stringify(priority.body));
    f.safeSync();
    assert.deepEqual(plain(f.staffState().presencePending), ['Léa']);
    const confirmed = await post(f, '/api/table/confirm', { ...lea.body });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  }
  const paragraph = guideLine(OUTAGE_PARAGRAPH);
  for (const said of ['« Je suis là » ne peut pas attendre si la scène était déjà libre : son délai de réponse court pendant la panne',
    'la personne est traitée dès la reprise comme sans réponse', '« Priorité » sur son titre lui redonne la demande']) {
    assert.ok(paragraph.includes(said), `GUIDE-BAR.md : ${said}`);
  }
});

// Regression: relecture contradictoire du tour 5 (tour 2) — GUIDE-BAR.md
// disait qu'un titre sorti de la file de KaraFun sans avoir été vu commencer
// est jugé à la fin de l'alerte « comme sans alerte ». Pas un retrait annulé
// quand la file de KaraFun est illisible : la file garde la dernière qu'elle
// a lue et n'y voit la sortie du titre qu'à la fin de l'alerte (sa sortie
// n'est datée, goneAt, que dans une file lisible). Le délai d'un retrait qui
// aboutit quand même (PULL_LATE_MS) se compte alors depuis la fin de
// l'alerte : au-delà, le titre passe pour passé dans KaraFun et n'est pas
// rendu à son chanteur. Limite, écrite dans le guide.
test('valeurs imprévues : file de KaraFun illisible, retrait annulé que KaraFun fait quand même, jugé à la fin de l’alerte (limite écrite dans le guide)', async t => {
  const late = Number(/const PULL_LATE_MS = (\d+);/.exec(source)[1]);
  for (const reason of ['closing', 'duo']) {
    for (const end of [late - 5000, late + 45000]) {
      const clock = clockAt('2026-11-16T22:00:00.000Z');
      const f = harness({ Date: clock.Date });
      const { frames } = replayBridge(t, f);
      f.sched.opts.requirePresence = false;
      const tb = openTable(f, '1');
      const people = [singer(f, tb, 'Léa', 101), singer(f, tb, 'Tom', 201)];
      const a = sendNext(f, 'A-id'), b = sendNext(f, 'B-id');
      const owner = people.find(who => who.person.id === a.sel.ids[0]).person;
      const item = tr => isoItem(tr.queueId, tr.sel.song.songId, { singer: tr.sel.label });
      const C = isoItem('C-id', 555, { singer: 'Autre' });
      frames(queueEvent(item(a), item(b)), isoStatus(4, C));
      // Retrait déjà envoyé, puis annulé ; un titre illisible rend la file de KaraFun illisible.
      const cancelledAt = clock.now;
      a.unpulled = { reason, at: cancelledAt };
      frames(queueEvent(item(a), item(b), ODD_ITEM));
      clock.now += 5000;
      frames(queueEvent(item(b), ODD_ITEM)); // KaraFun fait le retrait, file toujours illisible
      assert.deepEqual(f.events('turn.unsent'), [], `${reason} : rien de vu sortir pendant l’alerte`);
      clock.now = cancelledAt + end;
      frames(queueEvent(item(b))); // fin de l'alerte
      const returned = end < late;
      const label = `${reason}, fin de l’alerte ${end / 1000} s après l’annulation`;
      assert.deepEqual(f.events('turn.unsent').map(e => [e.queueId, e.reason]), [['A-id', returned ? `pulled-${reason}` : 'skipped-in-karafun']], label);
      assert.equal(f.sched.songsOf(owner).some(song => song.songId === a.sel.song.songId), returned, `${label} : titre rendu à son chanteur`);
      if (!returned) {
        assert.ok(notes(f).includes(`« ${a.sel.song.title} » (${a.sel.label}) a été passée dans KaraFun avant la lecture : elle ne sera pas renvoyée automatiquement`), label);
      }
    }
  }
  const line = guideLine('- un titre illisible, dans la file ou sur scène');
  for (const said of ["Limite : quand la file de KaraFun est illisible, la file garde la dernière qu'elle a pu lire, et n'y voit un titre sortir qu'à la fin de l'alerte.",
    `compte alors comme un titre passé dans KaraFun si l'alerte finit plus de ${late / 1000} secondes après l'annulation : le titre n'est pas rendu à son chanteur`]) {
    assert.ok(line.includes(said), `GUIDE-BAR.md : ${said}`);
  }
});

// Regression: relecture gstack-review de la branche finale (passe
// contradictoire) — la pause des délais de la relance ⏮ pendant l'alerte était
// notée même sans relance en cours, puis appliquée à la première
// synchronisation lisible : une relance demandée juste après l'alerte, avant
// cette synchronisation, voyait ses délais (15 s, 20 s) repoussés de toute la
// durée de l'alerte. Chaque relance ne garde que sa propre pause.
test('valeurs imprévues : relance ⏮ demandée juste après une longue alerte : ses délais ne sont pas repoussés', async t => {
  const clock = clockAt('2026-11-12T21:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  singer(f, openTable(f, '1'), 'Léa', 101);
  const a = sendNext(f, 'A-id');
  const A = isoItem('A-id', 101, { singer: a.sel.label });
  frames(queueEvent(A), isoStatus(4, A));
  a.liveChecked = 'A-id';
  // Longue alerte sans relance en cours : file de KaraFun illisible pendant 60 s.
  frames(queueEvent(A, ODD_ITEM));
  clock.now += 60000;
  frames();
  // La file lisible arrive ; le bar touche ⏮ avant la synchronisation suivante.
  FakeWS.last.emit('message', { data: JSON.stringify(queueEvent(A)) });
  await f.call('POST /api/staff/kf', { action: 'restart' });
  assert.ok(frames().some(m => m.type === 'remote.AddToQueueRequest'), 'copie demandée à KaraFun');
  // 16 s plus tard, sans copie : la relance conclut, sans attendre 60 s de plus.
  clock.now += 16000;
  frames(queueEvent(A));
  assert.equal(restartNotConfirmed(f).length, 1, 'délai de 15 s compté depuis la demande');
});

// Regression: relecture gstack-review de la branche finale, passe 2 (essais,
// maintenabilité, machines à états) — la pause des copies tardives d'une relance
// abandonnée n'était appliquée qu'au passage suivant de la synchronisation : ⏮ touché
// après une longue alerte, avant ce passage, trouvait le délai écoulé, l'oubliait, et la
// copie tardive restait dans KaraFun. Chaque lecteur compte la pause.
test('valeurs imprévues : relance abandonnée, longue alerte, ⏮ avant la synchronisation : refusé, copie tardive retirée', async t => {
  const { clock, f, frames, A, add } = await restartRequested(t);
  clock.now += 16000;
  frames(queueEvent(A));
  assert.equal(restartNotConfirmed(f).length, 1, 'relance abandonnée');
  clock.now += 10000;
  frames(queueEvent(A, ODD_ITEM));
  clock.now += 70000;
  frames();
  const C = isoItem('C-id', 101, add.payload.options);
  FakeWS.last.emit('message', { data: JSON.stringify(queueEvent(A, C)) });
  await assert.rejects(f.call('POST /api/staff/kf', { action: 'restart' }), /La relance précédente vient d’échouer/);
  assert.deepEqual(removals(frames()), ['C-id'], 'copie tardive retirée');
});

// Relecture gstack-review de la branche finale, passe 2 (machines à états, case sans
// essai) : relance ⏮ en cours, longue alerte, ⏮ touché de nouveau avant la
// synchronisation : refusé, et le délai de la relance reprend où il en était.
test('valeurs imprévues : relance ⏮ en cours, longue alerte, ⏮ avant la synchronisation : refusé, son délai reprend', async t => {
  const { clock, f, frames, A, add } = await restartRequested(t);
  clock.now += 5000;
  frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, ODD_ITEM));
  clock.now += 70000;
  frames();
  FakeWS.last.emit('message', { data: JSON.stringify(queueEvent(A)) });
  await assert.rejects(f.call('POST /api/staff/kf', { action: 'restart' }), /La relance du titre est déjà en cours/);
  frames(queueEvent(A));
  assert.deepEqual(restartNotConfirmed(f), [], '5 s avant l’alerte : délai pas encore écoulé');
  clock.now += 11000;
  frames(queueEvent(A));
  assert.equal(restartNotConfirmed(f).length, 1, '15 s de file lisible écoulées : la relance conclut');
});

// ---------------------------------------------------------------- relecture, cycle 3 : relance ⏮ et mise à jour du serveur
// Relance ⏮ de A inachevée : la copie C, ajoutée juste après A, a pris son
// suivi, et « Suivant » a retiré A ; mais KaraFun reste à l'arrêt, C en tête,
// malgré « Lecture ». 20 s plus tard, la relance est abandonnée et C attend sa
// lecture (restartAwaitingPlay) : son suivi garde le début de A (startedAt).
async function p3g1CopyAwaitingPlay(t) {
  const run = await restartRequested(t);
  const { clock, f, frames, A, add } = run;
  const C = isoItem('C-id', 101, add.payload.options);
  assert.deepEqual(frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, C)).map(m => m.type),
    ['remote.NextRequest'], 'copie juste après le titre : « Suivant »');
  // « Suivant » fait : A retiré, C annoncé, KaraFun à l'arrêt.
  assert.deepEqual(frames(queueEvent(C), isoStatus(1, C)), []);
  clock.now += 3000;
  assert.deepEqual(frames().map(m => m.type), ['remote.PlayRequest'], 'KaraFun reste à l’arrêt : « Lecture »');
  clock.now += 18000;
  frames();
  assert.ok(notes(f).includes('La relance n’a pas démarré. La copie du titre est prête : lance la lecture dans KaraFun.'));
  const tr = f.tracked()[0];
  assert.deepEqual([f.tracked().length, tr.queueId, typeof tr.startedAt], [1, 'C-id', 'number'],
    'le suivi de A est passé à sa copie, avec le début de A');
  return { ...run, C, tr };
}

// Route « Vérifier et mettre à jour » d'un serveur Linux dont l'agent de mise
// à jour est prêt (comme dans server-mode.test.js) : le refus vient du serveur
// (updateBlockedReason) ; une demande acceptée est seulement comptée, rien ne
// part vers l'hôte.
function p3g1UpdateRoute(f) {
  const route = { requests: 0 };
  f.serverUpdate.view = blockedReason => ({ enabled: true, busy: false, phase: 'idle', blockedReason });
  f.serverUpdate.request = blockedReason => {
    if (blockedReason) throw Object.assign(new Error(blockedReason), { status: 409 });
    route.requests++;
  };
  route.post = () => post(f, staffUrl(f, '/api/staff/update'), { confirmActive: true });
  return route;
}

// Regression: relecture, cycle 3 — après une relance ⏮ inachevée, la copie
// prête à jouer garde le suivi du titre relancé, déjà commencé (startedAt).
// « Vider toutes les chansons » ne retirait que les titres jamais commencés :
// la copie restait dans KaraFun, le vidage l'attendait sans fin, et avec lui
// tout envoi de la file. Elle est retirée comme un titre à venir ; sortie de
// KaraFun, le vidage finit, et le passage du titre relancé, chanté, se clôt
// (fin dans l'historique de scène), au lieu de « Retrait KaraFun confirmé »
// sans fin de passage, comme pour un titre jamais lancé.
test('relance ⏮ inachevée, copie prête à jouer : « Vider toutes les chansons » la retire, le vidage finit et le passage se clôt', async t => {
  const { f, frames, tr } = await p3g1CopyAwaitingPlay(t);
  await f.call('POST /api/staff/queue-clear', { confirmation: 'VIDER TOUTES LES CHANSONS' });
  assert.equal(tr.cancelled, true, 'copie annulée comme un titre à venir');
  assert.deepEqual(removals(frames()), ['C-id'], 'son retrait part');
  assert.equal(f.settings.queueClearPending, true, 'le vidage attend que KaraFun la retire');
  // KaraFun retire la copie : sa file est vide.
  assert.deepEqual(frames(queueEvent(), isoStatus(1, null)), [], 'rien d’autre n’est envoyé');
  assert.equal(f.settings.queueClearPending, false, 'vidage fini');
  assert.ok(notes(f).includes('File vidée dans KaraFun : les nouveaux choix peuvent être envoyés.'));
  assert.equal(f.tracked().length, 0, 'copie plus suivie');
  const history = f.staffState().stageHistory;
  assert.deepEqual(plain(history.map(item => item.title)), ['Titre 101']);
  assert.equal(typeof history[0].endedAt, 'number', 'passage du titre relancé clos');
  assert.equal(notes(f).some(line => line.startsWith('Retrait KaraFun confirmé')), false, 'chanté, pas « retiré »');
});

// Regression: relecture, cycle 3 — même défaut pendant une relance encore en
// cours : la copie, placée juste après le titre et pas encore lancée, porte
// déjà le suivi commencé du titre. « Vider toutes les chansons » l'annule, et
// son retrait part à la synchronisation suivante (celle du vidage).
test('relance ⏮ en cours, copie pas encore lancée : « Vider toutes les chansons » l’annule, son retrait part à la synchronisation suivante', async t => {
  const { f, frames, A, add } = await restartRequested(t);
  const C = isoItem('C-id', 101, add.payload.options);
  assert.deepEqual(frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, C)).map(m => m.type),
    ['remote.NextRequest'], 'copie juste après le titre : « Suivant »');
  assert.equal(f.staffState().restarting, true, 'relance en cours, A toujours sur scène');
  const tr = f.tracked()[0];
  assert.deepEqual([tr.queueId, typeof tr.startedAt], ['C-id', 'number'], 'la copie porte le suivi commencé de A');
  await f.call('POST /api/staff/queue-clear', { confirmation: 'VIDER TOUTES LES CHANSONS' });
  assert.equal(tr.cancelled, true, 'copie annulée');
  assert.deepEqual(removals(frames()), ['C-id'], 'retrait de la copie envoyé');
});

// Regression: relecture, cycle 3 — « Parti » (et « Table partie ») ne
// retiraient de KaraFun que les titres jamais commencés de la personne : la
// copie prête à jouer d'une relance ⏮ inachevée restait dans KaraFun, prête à
// rejouer le titre de quelqu'un parti. Elle est retirée comme un titre à venir.
test('relance ⏮ inachevée, copie prête à jouer : « Parti » ou « Table partie » de son chanteur la retire de KaraFun', async t => {
  for (const gesture of ['« Parti »', '« Table partie »']) {
    const { f, frames, tr } = await p3g1CopyAwaitingPlay(t);
    const answer = gesture === '« Parti »' ? await f.call('POST /api/staff/person/leave', { personId: tr.sel.ids[0] }) :
      await f.call('POST /api/staff/table-left', { id: '1' });
    assert.equal(answer.removedFromKaraFun, 1, `${gesture} : la copie compte parmi les titres retirés`);
    assert.equal(tr.cancelled, true, gesture);
    assert.deepEqual(removals(frames()), ['C-id'], `${gesture} : retrait de la copie envoyé`);
  }
});

// Regression: relecture, cycle 3 — la pause de l'alerte « message de KaraFun
// illisible » sur la fenêtre des copies tardives (60 s après une relance ⏮
// abandonnée) ne finissait qu'à la vue lisible suivante (syncRestart). KaraFun
// perdu pendant l'alerte, cette vue ne venait pas : la fenêtre restait gelée,
// et la mise à jour du serveur bloquée sans fin. La pause finit quand KaraFun
// est perdu : la fenêtre reprend, sans compter l'alerte, et finit.
test('valeurs imprévues : relance ⏮ abandonnée, alerte puis KaraFun perdu : la fenêtre des copies tardives finit, la mise à jour n’est plus bloquée', async t => {
  const busy = 'Une action KaraFun ou Spotify est en cours. Réessaie dans un instant.';
  const { clock, f, frames, A } = await restartRequested(t);
  clock.now += 16000;
  frames(queueEvent(A));
  assert.equal(restartNotConfirmed(f).length, 1, 'relance abandonnée : copies tardives retirées pendant 60 s');
  const abandonedAt = clock.now;
  assert.equal(f.staffState().update.blockedReason, busy, 'fenêtre des copies tardives : mise à jour retenue');
  // 10 s plus tard, l'alerte commence (file illisible) ; 5 s après, la connexion tombe.
  clock.now += 10000;
  frames(queueEvent(A, ODD_ITEM));
  clock.now += 5000;
  FakeWS.last.emit('close', { code: 1006 });
  f.sync();
  assert.equal(f.karaokeOutlook(), 'unknown', 'KaraFun déconnecté');
  // Les 50 s qui restaient : la fenêtre n'est pas écourtée, l'alerte n'y compte pas.
  clock.now = abandonedAt + 60000 + 5000 - 1;
  f.sync();
  assert.equal(f.staffState().update.blockedReason, busy, 'fenêtre pas encore finie');
  assert.equal(f.staffState().restartRetryAt, abandonedAt + 65000,
    'KaraFun déconnecté : l’heure du nouvel essai de ⏮ reste affichée, sans compter les 5 s d’alerte');
  clock.now += 2;
  f.sync();
  const state = f.staffState();
  assert.equal(state.update.blockedReason, null, 'KaraFun toujours déconnecté : mise à jour permise');
  assert.equal(state.restartRetryAt, null);
});

// Regression: relecture, cycle 3 — pendant l'alerte « message de KaraFun
// illisible », la page du bar recevait la fin de la fenêtre des copies
// tardives, repoussée sans cesse par la pause (restartRetryAt) : le bouton ⏮
// restait grisé sur « Relance possible dans une minute » toute l'alerte, alors
// que ⏮ est refusé avec son remède (« relance le titre depuis KaraFun »).
// Pendant l'alerte, pas d'heure ; après elle, l'heure revient, prolongée de
// l'alerte.
test('valeurs imprévues : relance ⏮ abandonnée puis alerte : pas de compte à rebours figé sur ⏮ pendant l’alerte, il revient après elle', async t => {
  const { clock, f, frames, A } = await restartRequested(t);
  clock.now += 16000;
  frames(queueEvent(A));
  const abandonedAt = clock.now;
  assert.equal(f.staffState().restartRetryAt, abandonedAt + 60000, 'avant l’alerte : nouvel essai dans 60 s');
  clock.now += 10000;
  frames(queueEvent(A, ODD_ITEM));
  assert.equal(f.staffState().restartRetryAt, null, 'pendant l’alerte : pas de compte à rebours');
  await assert.rejects(f.call('POST /api/staff/kf', { action: 'restart' }),
    /^Error: Un message de KaraFun est illisible : relance le titre depuis KaraFun\.$/, '⏮ refusé avec son remède');
  clock.now += 30000;
  frames();
  assert.equal(f.staffState().restartRetryAt, null, 'toujours pendant l’alerte, 30 s plus tard');
  // Vue lisible : la fenêtre reprend, prolongée des 30 s d'alerte.
  frames(queueEvent(A));
  assert.equal(f.staffState().restartRetryAt, abandonedAt + 90000, 'après l’alerte : l’heure du nouvel essai revient');
  clock.now = abandonedAt + 80000; // au-delà des 60 s d'origine, dans la fenêtre prolongée
  frames();
  assert.equal(f.staffState().restartRetryAt, abandonedAt + 90000);
  await assert.rejects(f.call('POST /api/staff/kf', { action: 'restart' }), /Nouvel essai possible dans 10 s/);
});

// Relecture, cycle 3 (case sans essai) : relance ⏮ en cours (restartOp) et
// « Vérifier et mettre à jour » demandé avant la synchronisation qui la
// conclut, même quand KaraFun joue déjà la copie : refusé, comme toute action
// KaraFun en cours, par la vraie route. La synchronisation conclut la
// relance : permis.
test('mise à jour du serveur : refusée pendant une relance ⏮ en cours, même avant la synchronisation qui la conclut', async t => {
  const busy = 'Une action KaraFun ou Spotify est en cours. Réessaie dans un instant.';
  const { f, frames, A, add } = await restartRequested(t);
  const update = p3g1UpdateRoute(f);
  assert.equal(f.staffState().restarting, true, 'relance en cours');
  let answer = await update.post();
  assert.deepEqual([answer.status, answer.body.error], [409, busy], 'copie demandée, pas encore vue');
  // KaraFun place la copie juste après le titre, puis la lance (« Suivant ») ;
  // la demande arrive avant la synchronisation suivante.
  const C = isoItem('C-id', 101, add.payload.options);
  frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, C));
  FakeWS.last.emit('message', { data: JSON.stringify(queueEvent(C)) });
  FakeWS.last.emit('message', { data: JSON.stringify(isoStatus(4, C)) });
  answer = await update.post();
  assert.deepEqual([answer.status, answer.body.error], [409, busy], 'copie sur scène, relance pas encore conclue');
  assert.equal(f.staffState().update.blockedReason, busy);
  assert.equal(update.requests, 0, 'aucune demande à l’hôte');
  frames();
  assert.ok(notes(f).includes('« Titre 101 » repart du début.'));
  assert.equal(f.staffState().update.blockedReason, null, 'relance conclue');
  answer = await update.post();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(update.requests, 1);
});

// Relecture, cycle 3 (case sans essai) : fenêtre des copies tardives mise en
// pause par une longue alerte, sa fin d'origine dépassée, et « Vérifier et
// mettre à jour » demandé avant que la synchronisation replie la pause (vue
// lisible reçue, pas encore traitée) : encore refusé, la pause compte déjà
// (restartSweepUntil). Après la vue lisible, la mise à jour est permise à la
// fin de la fenêtre prolongée, pas avant.
test('mise à jour du serveur : fenêtre des copies tardives en pause pendant une longue alerte, encore refusée avant la synchronisation qui replie la pause', async t => {
  const busy = 'Une action KaraFun ou Spotify est en cours. Réessaie dans un instant.';
  const { clock, f, frames, A } = await restartRequested(t);
  const update = p3g1UpdateRoute(f);
  clock.now += 16000;
  frames(queueEvent(A));
  assert.equal(restartNotConfirmed(f).length, 1, 'relance abandonnée : copies tardives retirées pendant 60 s');
  const abandonedAt = clock.now;
  // 10 s plus tard, la file arrive illisible, et le reste 70 s : la fin
  // d'origine de la fenêtre est dépassée de 20 s.
  clock.now += 10000;
  frames(queueEvent(A, ODD_ITEM));
  clock.now += 70000;
  frames();
  // La file lisible arrive ; la demande précède la synchronisation suivante.
  FakeWS.last.emit('message', { data: JSON.stringify(queueEvent(A)) });
  let answer = await update.post();
  assert.deepEqual([answer.status, answer.body.error], [409, busy], 'pause pas encore repliée : la fenêtre continue');
  assert.equal(update.requests, 0);
  frames();
  clock.now = abandonedAt + 60000 + 70000 - 1;
  frames();
  assert.equal(f.staffState().update.blockedReason, busy, 'fenêtre prolongée des 70 s d’alerte, pas encore finie');
  clock.now += 2;
  frames();
  assert.equal(f.staffState().update.blockedReason, null, 'fenêtre prolongée finie');
  answer = await update.post();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(update.requests, 1);
});

// ---------------------------------------------------------------- relecture du cycle 3 : réglage fait pendant l'alerte
// Réglage de B fait au bar pendant l'alerte : tonalité, tempo et voix guide, pour que
// chaque sorte de commande en direct (PitchRequest, TempoRequest, TrackVolumeRequest)
// puisse partir. Rend la réponse de la route.
function p3g3SettingsDuringAlert(f, trB) {
  return f.call('POST /api/staff/song/settings', { personId: trB.sel.ids[0], entryId: trB.sel.song.entryId,
    settings: { pitch: 2, tempo: 10, guide: 50 } });
}
// Valeurs que le bar a réglées dans KaraFun pendant l'alerte, comme elle le demande.
function p3g3BarLive() {
  return { pitch: -1, tempo: 0, guide: 25 };
}

// Regression: relecture du cycle 3 — alerte d'un état de KaraFun illisible (file
// lisible) : le réglage de B fait au bar pendant l'alerte répond « pas encore envoyé ».
// KaraFun finit A et lance B sans qu'on le voie : B sort de sa file, l'état reste figé.
// Le premier état lisible montre B en pleine chanson, réglé dans KaraFun par le bar : le
// rattrapage du début du titre y envoyait tonalité, tempo et voix guide du réglage, en
// pleine chanson, par-dessus ce que le bar venait de régler. Rien n'est rattrapé.
test('valeurs imprévues : état illisible, réglage fait pendant l’alerte, titre lancé sans être vu puis vu en pleine chanson : rien rattrapé', async t => {
  const { f, frames, A, B, trB } = aThenB(t);
  frames(unreadableStatus(A));
  assert.equal((await p3g3SettingsDuringAlert(f, trB)).applied, 'unreadable', 'pas encore envoyé');
  // KaraFun finit A et lance B : B sort de sa file, l'état reçu reste illisible.
  assert.deepEqual([queueEvent(), unreadableStatus(B)].flatMap(m => bare(frames(m))), [], 'rien pendant l’alerte');
  assert.ok(f.tracked().includes(trB) && !trB.startedAt, 'B suivi, pas encore vu sur scène');
  // Premier état lisible : B en pleine chanson, avec les valeurs du bar.
  assert.deepEqual(bare(frames(isoStatus(4, B, p3g3BarLive()))), [], 'aucune tonalité, aucun tempo ni volume envoyé en pleine chanson');
  assert.ok(trB.startedAt, 'B compté sur scène');
  assert.deepEqual(bare(frames(isoStatus(4, B, p3g3BarLive()))), [], 'ni ensuite');
  assert.deepEqual(f.events('song.settingsCaughtUp'), [], 'rien rattrapé');
});

// Relecture du cycle 3 (case sans essai) : même scénario avec une alerte de la file seule
// (état lisible) : B est vu se charger puis commencer pendant l'alerte. Ni pendant elle, ni
// à la file lisible suivante, en pleine chanson, le réglage n'est rattrapé.
test('valeurs imprévues : file illisible, réglage fait pendant l’alerte, titre vu commencer pendant elle puis file lisible en pleine chanson : rien rattrapé', async t => {
  const { f, frames, A, B, trB } = aThenB(t);
  frames(queueEvent(A, B, ODD_ITEM));
  assert.equal((await p3g3SettingsDuringAlert(f, trB)).applied, 'unreadable', 'pas encore envoyé');
  const during = [isoStatus(1, B), isoStatus(2, B), isoStatus(3, B), isoStatus(4, B, p3g3BarLive())].flatMap(m => bare(frames(m)));
  assert.deepEqual(during, [], 'rien pendant l’alerte, ni au chargement ni au début');
  assert.ok(trB.startedAt, 'B vu commencer pendant l’alerte');
  assert.deepEqual(bare(frames(queueEvent(B), isoStatus(4, B, p3g3BarLive()))), [], 'file lisible, en pleine chanson : rien envoyé');
  assert.deepEqual(f.events('song.settingsCaughtUp'), [], 'rien rattrapé');
});

// Relecture du cycle 3 (chemin normal gardé) : l'alerte d'un état illisible finit alors que
// B est seulement chargé (état 3, pas en lecture). La fin de l'alerte ne le compte pas en
// pleine chanson : le réglage fait pendant l'alerte part avant la musique, par les options
// du titre de KaraFun, puis par le rattrapage sur l'état suivant, KaraFun du bar ignorant
// les options d'un titre déjà chargé.
test('valeurs imprévues : alerte d’un état illisible finie sur un titre seulement chargé : le réglage fait pendant l’alerte est appliqué avant la musique', async t => {
  const { f, frames, A, B, trB } = aThenB(t);
  frames(unreadableStatus(A));
  assert.equal((await p3g3SettingsDuringAlert(f, trB)).applied, 'unreadable', 'pas encore envoyé');
  // A finit, KaraFun charge B (encore dans sa file) ; l'état reçu reste illisible.
  assert.deepEqual(bare(frames(queueEvent(B), unreadableStatus(B))), [], 'rien pendant l’alerte');
  // Fin de l'alerte : B chargé, pas en lecture.
  const atEnd = bare(frames(isoStatus(3, B)));
  assert.deepEqual(atEnd.map(m => [m.type, m.payload.queueItemId]), [['remote.SetQueueItemOptionsRequest', 'B-id']],
    'options du titre envoyées à la fin de l’alerte');
  assert.equal(trB.startedAt, null, 'pas encore sur scène');
  // KaraFun ignore ces options : rattrapé sur l'état suivant, toujours avant la musique.
  assert.deepEqual(bare(frames(isoStatus(3, B))), [pitchTo(2), tempoTo(10), volumeTo(5, 50)], 'rattrapé avant la musique');
  assert.deepEqual(bare(frames(isoStatus(4, B, { pitch: 2, tempo: 10, guide: 50 }))), [], 'rien de plus au début de la musique');
  assert.deepEqual(f.events('song.settingsCaughtUp').map(e => [e.queueId, e.fields]), [['B-id', ['pitch', 'tempo', 'guide']]]);
});

// Regression: relecture du cycle 3 — même ligne avec un titre chargé que la file voit
// pendant l'alerte (alerte de la file seule, ou alerte de l'état commencée sur un titre
// déjà chargé). Pendant l'alerte, ce titre était marqué vérifié (catchUpSongSettings).
// À la fin de l'alerte, toujours seulement chargé, ses options partaient, mais le
// rattrapage qui les suit d'ordinaire quand KaraFun les ignore (KaraFun du bar, titre
// déjà chargé) ne partait jamais : le réglage fait pendant l'alerte, « pas encore
// envoyé », n'était pas appliqué, et rien ne le disait au bar. Seul un titre vu sur
// scène pendant l'alerte est marqué vérifié.
test('valeurs imprévues : titre chargé vu pendant l’alerte, alerte finie avant la musique : le réglage fait pendant l’alerte est rattrapé', async t => {
  for (const alert of ['file', 'état']) {
    const { f, frames, A, B, trB } = aThenB(t);
    if (alert === 'file') {
      frames(queueEvent(A, B, ODD_ITEM));
      assert.equal((await p3g3SettingsDuringAlert(f, trB)).applied, 'unreadable', alert);
      // A finit, KaraFun annonce puis charge B : l'état se lit encore.
      assert.deepEqual([isoStatus(1, B), isoStatus(2, B), isoStatus(3, B)].flatMap(m => bare(frames(m))), [], `${alert} : rien pendant l’alerte`);
      // Fin de l'alerte : file lisible, B toujours seulement chargé.
      assert.deepEqual(bare(frames(queueEvent(B))).map(m => m.type), ['remote.SetQueueItemOptionsRequest'], `${alert} : options du titre envoyées`);
    } else {
      // A finit, B annoncé puis chargé avant l'alerte ; l'alerte de l'état commence sur lui.
      frames(isoStatus(1, B), queueEvent(B));
      frames(isoStatus(2, B));
      frames(isoStatus(3, B));
      frames(unreadableStatus(B));
      assert.equal((await p3g3SettingsDuringAlert(f, trB)).applied, 'unreadable', alert);
      assert.deepEqual(bare(frames()), [], `${alert} : rien pendant l’alerte (balayage)`);
      // Fin de l'alerte : B toujours seulement chargé.
      assert.deepEqual(bare(frames(isoStatus(3, B))).map(m => m.type), ['remote.SetQueueItemOptionsRequest'], `${alert} : options du titre envoyées`);
    }
    assert.equal(trB.startedAt, null, `${alert} : pas encore sur scène`);
    // KaraFun ignore ces options : rattrapé sur l'état suivant, avant la musique.
    assert.deepEqual(bare(frames(isoStatus(3, B))), [pitchTo(2), tempoTo(10), volumeTo(5, 50)], `${alert} : rattrapé avant la musique`);
  }
});

// ---------------------------------------------------------------- relecture du cycle 3, cases anciennes : verdicts du suivi et accusés
// Léa et Tom attendent ; le titre A (le premier choisi) est envoyé et attend
// dans KaraFun, pendant que C, ajouté dans KaraFun, est en pleine chanson.
// L'heure de fermeture est passée : la synchronisation retire A de KaraFun
// (pullFromKaraFun, retrait de fermeture envoyé). Horloge du serveur avancée
// par l'essai. Rend de quoi jouer la suite.
function p3g4ClosingPull(t) {
  const clock = clockAt('2026-11-16T23:30:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  f.sched.opts.requirePresence = false;
  const tb = openTable(f, '1');
  const people = [singer(f, tb, 'Léa', 101), singer(f, tb, 'Tom', 201)];
  const a = sendNext(f, 'A-id');
  const owner = people.find(s => s.person.id === a.sel.ids[0]).person;
  const A = isoItem('A-id', a.sel.song.songId, { singer: a.sel.label });
  const C = isoItem('C-id', 555, { singer: 'Autre' });
  frames(queueEvent(A), isoStatus(4, C));
  f.settings.closingAt = clock.now - 60000;
  assert.deepEqual(removals(frames()), ['A-id'], 'fermeture passée : A sort de KaraFun');
  assert.equal(a.pulled?.reason, 'closing');
  assert.ok(a.removeRequestedAt > 0, 'retrait envoyé à KaraFun');
  return { clock, f, frames, a, A, C, owner };
}

// Relecture du cycle 3 (cases anciennes, retrait de fermeture × sortie de la
// file pendant l'alerte) : titre retiré pour l'heure de fermeture, retrait
// envoyé, qui sort de la file de KaraFun pendant une alerte de l'état. KaraFun
// a pu appliquer le retrait, ou lancer le titre : la scène vue est figée.
// Conclure là rendrait à son chanteur un titre peut-être en train d'être
// chanté. Le titre reste suivi, sans verdict ; à la première vue lisible, hors
// de la scène, son verdict est « pulled-closing » : il revient en tête de la
// liste de son chanteur avec la note de fermeture (restorePulled), et non
// « passée dans KaraFun avant la lecture », qui le lui ferait perdre.
test('valeurs imprévues : retrait de fermeture envoyé, titre sorti de la file pendant une alerte de l’état : verdict à la vue lisible, rendu à son chanteur', async t => {
  const { f, frames, a, C, owner } = p3g4ClosingPull(t);
  frames(unreadableStatus(C));
  assert.equal(f.karaokeOutlook(), 'blind');
  assert.deepEqual(frames(queueEvent()), [], 'KaraFun fait le retrait pendant l’alerte : rien ne part');
  assert.deepEqual(plain(f.tracked().map(tr => tr.queueId)), ['A-id'], 'A toujours suivi pendant l’alerte');
  assert.deepEqual(f.events('turn.unsent'), [], 'aucun verdict pendant l’alerte');
  assert.equal(a.pulled?.reason, 'closing', 'retrait de fermeture gardé');
  assert.equal(a.sel.turnCredit.rolledBack, false, 'passage pas encore rendu');
  assert.equal(f.sched.songsOf(owner).some(song => song.entryId === a.sel.song.entryId), false, 'titre pas encore rendu');
  // Fin de l'alerte : C chante toujours, A n'est nulle part.
  frames(isoStatus(4, C));
  assert.deepEqual(f.events('turn.unsent').map(e => [e.queueId, e.reason]), [['A-id', 'pulled-closing']], 'verdict à la vue lisible');
  assert.equal(f.tracked().length, 0, 'A n’est plus suivi');
  assert.equal(a.startedAt, null, 'jamais compté sur scène');
  assert.equal(a.sel.turnCredit.rolledBack, true, 'passage rendu : il n’a pas chanté');
  assert.equal(owner.sung, 0, 'son passage ne compte pas');
  assert.equal(owner.song?.entryId, a.sel.song.entryId, 'le titre revient en tête de la liste de son chanteur');
  assert.ok(notes(f).includes(`« ${a.sel.song.title} » (${a.sel.label}) retiré de KaraFun : il passerait après la fermeture. Il repartira s’il passe de nouveau avant l’heure, par exemple si le bar la décale.`));
  assert.equal(notes(f).some(line => /passée dans KaraFun avant la lecture/.test(line)), false);
});

// Relecture du cycle 3 (cases anciennes, retrait de fermeture × lancé sur
// scène) : titre retiré pour l'heure de fermeture, retrait envoyé, mais lancé
// par KaraFun avant de le recevoir, vu sur scène tout de suite ou à la fin
// d'une alerte de l'état (pendant laquelle il a quitté la file). La fermeture
// n'interrompt jamais un titre commencé : le retrait est oublié, le titre
// continue, son passage compte et le reste à sa fin, sans second retrait ni
// retour du titre à son chanteur (qui chanterait deux fois).
test('retrait de fermeture envoyé, titre lancé avant : il continue et compte, vu tout de suite ou à la fin d’une alerte de l’état', async t => {
  for (const alert of [false, true]) {
    const label = alert ? 'fin d’une alerte de l’état' : 'sans alerte';
    const { f, frames, a, A, owner } = p3g4ClosingPull(t);
    const sent = [];
    if (alert) {
      // KaraFun lance A : l'état qui l'annonce est illisible, et sa file n'a plus A.
      sent.push(...frames(unreadableStatus(A), queueEvent()));
      assert.equal(a.startedAt, null, `${label} : rien de conclu pendant l’alerte`);
      assert.deepEqual(f.events('turn.unsent'), [], label);
    }
    sent.push(...frames(isoStatus(4, A)));
    assert.equal(a.pulled, null, `${label} : retrait oublié`);
    assert.ok(a.startedAt, `${label} : A sur scène`);
    assert.ok(notes(f).includes(`« ${a.sel.song.title} » a commencé avant son retrait de KaraFun ; il continue.`), label);
    assert.ok(notes(f).includes(`Sur scène : ${a.sel.label} — « ${a.sel.song.title} »`), label);
    assert.equal(owner.sung, 1, `${label} : passage compté`);
    assert.equal(a.sel.turnCredit.rolledBack, false, label);
    assert.deepEqual(removals(sent), [], `${label} : aucun second retrait`);
    assert.deepEqual(f.events('turn.unsent'), [], label);
    // Fin du titre : passage toujours compté, titre pas rendu à son chanteur.
    frames(queueEvent(), isoStatus(1, null));
    assert.deepEqual(f.events('turn.unsent'), [], `${label} : fin du titre`);
    assert.equal(f.tracked().length, 0, label);
    assert.equal(a.sel.turnCredit.rolledBack, false, `${label} : passage toujours compté`);
    assert.equal(f.sched.songsOf(owner).some(song => song.entryId === a.sel.song.entryId), false, `${label} : titre chanté, pas rendu`);
  }
});

// Relecture du cycle 3 (cases anciennes, retrait pour une priorité × sortie de
// la file pendant l'alerte) : titre chargé retiré pour une priorité du bar
// (« Priorité » confirmée, retrait envoyé), qui sort de la file de KaraFun
// pendant une alerte de l'état. Il reste suivi, sans verdict, et rien ne part
// vers KaraFun ; à la première vue lisible, son verdict « pulled-priority » le
// fait repasser juste après la priorité (Scheduler#returnFromKaraFun) : la
// priorité part d'abord, puis il est le prochain annoncé, sans perdre son tour.
test('valeurs imprévues : titre retiré pour une priorité, sorti de la file pendant une alerte de l’état : verdict à la vue lisible, il repasse juste après la priorité', async t => {
  const clock = clockAt('2026-11-16T22:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  f.sched.opts.requirePresence = false;
  const [alice, bruno, chloe, driss] = ['Alice', 'Bruno', 'Chloé', 'Driss']
    .map((name, i) => singer(f, openTable(f, String(i + 1), 2), name, 801 + i).person);
  const a = sendNext(f, 'A-id'), b = sendNext(f, 'B-id');
  assert.deepEqual([a.sel.ids[0], b.sel.ids[0]], [alice.id, bruno.id], 'Alice chante, le titre de Bruno est chargé ensuite');
  const A = isoItem('A-id', 801, { singer: a.sel.label });
  frames(queueEvent(A, isoItem('B-id', 802, { singer: b.sel.label })), isoStatus(4, A));
  // Envoi automatique actif, comme au bar : sans lui, le retrait est refusé.
  f.settings.auto = true;
  const answer = await f.call('POST /api/staff/move', { personId: driss.id, toIndex: 0, priority: true, pullLoaded: true, queueId: 'B-id' });
  assert.equal(answer.message, '« Titre 802 » sort de KaraFun : Driss passe d’abord, « Titre 802 » juste après.');
  assert.deepEqual(removals(frames()), ['B-id'], 'retrait envoyé');
  assert.deepEqual([b.pulled?.reason, b.pulled?.forId], ['priority', driss.id]);
  frames(unreadableStatus(A));
  assert.deepEqual(frames(queueEvent(A)), [], 'KaraFun fait le retrait pendant l’alerte : rien ne part');
  assert.deepEqual(plain(f.tracked().map(tr => tr.queueId)), ['A-id', 'B-id'], 'B toujours suivi pendant l’alerte');
  assert.deepEqual(f.events('turn.unsent'), [], 'aucun verdict pendant l’alerte');
  assert.equal(b.pulled?.reason, 'priority');
  assert.equal(f.pending(), null);
  // Fin de l'alerte : Alice chante toujours, B n'est nulle part.
  const after = frames(isoStatus(4, A));
  assert.deepEqual(f.events('turn.unsent').map(e => [e.queueId, e.reason]), [['B-id', 'pulled-priority']], 'verdict à la vue lisible');
  assert.ok(notes(f).includes(`« Titre 802 » (${b.sel.label}) retiré de KaraFun : il repasse juste après Driss (priorité du bar), sans perdre son tour`));
  assert.equal(b.sel.turnCredit.rolledBack, true);
  assert.equal(bruno.sung, 0, 'son passage retiré n’a pas compté');
  const back = f.staffState().queue.find(line => line.source === 'helper' && line.id === bruno.id);
  assert.equal(back?.afterPriority, true, 'repère « Après la priorité »');
  // La priorité part vers KaraFun ; à son accusé, Bruno est le prochain annoncé.
  const add = after.find(m => m.type === 'remote.AddToQueueRequest');
  assert.equal(add?.payload.song.id, 804, 'la priorité de Driss part d’abord');
  frames({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, isoItem('D-id', 804, add.payload.options)));
  assert.equal(driss.sung, 1, 'la priorité compte');
  assert.equal(f.sched.reservedNext?.personId, bruno.id, 'Bruno repasse juste après la priorité');
  assert.equal(f.staffState().queue.find(line => line.source === 'helper' && !line.future)?.id, bruno.id, 'devant Chloé');
  assert.equal(chloe.sung, 0, 'Chloé attend son tour');
});

// Relecture du cycle 3 (cases anciennes, retrait de fermeture annulé × lancé
// sur scène) : retrait de fermeture envoyé puis annulé (le bar décale l'heure :
// le titre tient de nouveau avant elle), titre resté dans KaraFun et lancé.
// Départ simple : sur scène, passage compté, entrée de scène ; à sa fin, il ne
// revient pas à son chanteur (le délai d'un retrait annulé qui aboutit quand
// même, PULL_LATE_MS, ne vaut que pour un titre jamais commencé).
test('retrait de fermeture annulé, titre resté dans KaraFun puis lancé : départ simple, passage compté', async t => {
  const { clock, f, frames, a, A, owner } = p3g4ClosingPull(t);
  f.settings.closingAt = clock.now + 3 * 3600000;
  assert.deepEqual(removals(frames()), []);
  assert.equal(a.pulled, null, 'retrait annulé');
  assert.deepEqual(plain(a.unpulled), { reason: 'closing', at: clock.now });
  assert.equal(a.removeRequestedAt, 0);
  // C se termine, KaraFun lance A.
  const sent = frames(isoStatus(4, A));
  assert.ok(a.startedAt, 'A sur scène');
  assert.equal(owner.sung, 1, 'passage compté');
  assert.equal(a.sel.turnCredit.rolledBack, false);
  assert.ok(notes(f).includes(`Sur scène : ${a.sel.label} — « ${a.sel.song.title} »`));
  const entry = f.sched.stageHistory.at(-1);
  assert.deepEqual(plain({ ids: entry.ids, entryId: entry.entryId, endedAt: entry.endedAt }),
    { ids: [owner.id], entryId: a.sel.song.entryId, endedAt: null }, 'entrée de scène');
  assert.equal(notes(f).some(line => line.includes('avant son retrait de KaraFun')), false, 'plus de retrait en cours');
  assert.deepEqual(removals(sent), []);
  // Fin du titre, moins de 20 s après l'annulation : chanté, il ne revient pas à son chanteur.
  frames(queueEvent(), isoStatus(1, null));
  assert.deepEqual(f.events('turn.unsent'), []);
  assert.equal(f.tracked().length, 0);
  assert.ok(entry.endedAt, 'passage fini');
  assert.equal(a.sel.turnCredit.rolledBack, false, 'passage toujours compté');
  assert.equal(f.sched.songsOf(owner).some(song => song.entryId === a.sel.song.entryId), false, 'titre chanté, pas rendu');
  assert.equal(notes(f).some(line => line.includes('juste avant le changement de l’heure de fermeture')), false);
});

// Relecture du cycle 3 (cases anciennes, retrait de duo annulé × lancé sur
// scène) : le bar note un duo improvisé pendant le titre en cours ; le titre
// suivant du partenaire sort de KaraFun (retrait envoyé), puis le bar annule
// ce duo. Le titre, resté dans KaraFun, garde son retrait annulé (`unpulled`,
// « duo »). Lancé ensuite, c'est un départ simple : sur scène, passage compté,
// jamais rendu à son chanteur à sa fin.
test('retrait de duo annulé après son envoi, titre lancé ensuite : départ simple, passage compté', async t => {
  const clock = clockAt('2026-11-16T22:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  f.sched.opts.requirePresence = false;
  const people = [singer(f, openTable(f, '1'), 'Marine', 101), singer(f, openTable(f, '2'), 'Dam', 201)];
  const a = sendNext(f, 'A-id'), b = sendNext(f, 'B-id');
  const partner = people.find(s => s.person.id === b.sel.ids[0]).person;
  const A = isoItem('A-id', a.sel.song.songId, { singer: a.sel.label });
  const B = isoItem('B-id', b.sel.song.songId, { singer: b.sel.label });
  frames(queueEvent(A, B), isoStatus(4, A));
  assert.equal((await f.call('POST /api/staff/duo-mark', { queueId: 'A-id', partnerId: partner.id })).moved, 1);
  assert.deepEqual(removals(frames()), ['B-id'], 'retrait du titre du partenaire envoyé');
  assert.equal(b.pulled?.reason, 'duo');
  await f.call('POST /api/staff/duo-unmark', { queueId: 'A-id' });
  assert.equal(b.pulled, null, 'retrait annulé');
  assert.equal(b.unpulled?.reason, 'duo', 'retrait déjà envoyé : il pouvait encore aboutir');
  assert.equal(b.removeRequestedAt, 0);
  // A se termine, KaraFun lance B.
  const sent = frames(queueEvent(B), isoStatus(4, B));
  assert.ok(b.startedAt, 'B sur scène');
  assert.equal(partner.sung, 1, 'passage compté');
  assert.equal(b.sel.turnCredit.rolledBack, false);
  assert.ok(notes(f).includes(`Sur scène : ${b.sel.label} — « ${b.sel.song.title} »`));
  const entry = f.sched.stageHistory.at(-1);
  assert.deepEqual(plain({ ids: entry.ids, entryId: entry.entryId, endedAt: entry.endedAt }),
    { ids: [partner.id], entryId: b.sel.song.entryId, endedAt: null }, 'entrée de scène');
  assert.equal(notes(f).some(line => line.includes('avant son retrait de KaraFun')), false);
  assert.deepEqual(removals(sent), []);
  assert.deepEqual(f.events('turn.unsent'), []);
  // Fin du titre : chanté, il ne revient pas à son chanteur.
  frames(queueEvent(), isoStatus(1, null));
  assert.deepEqual(f.events('turn.unsent'), []);
  assert.equal(f.tracked().length, 0);
  assert.equal(b.sel.turnCredit.rolledBack, false, 'passage toujours compté');
  assert.equal(f.sched.songsOf(partner).some(song => song.entryId === b.sel.song.entryId), false, 'titre chanté, pas rendu');
  assert.equal(notes(f).some(line => line.includes('malgré l’annulation du duo')), false);
});

// Relecture du cycle 3 (cases anciennes, envoi annulé × délai de l'accusé) :
// envoi en cours annulé (« Parti » pendant l'envoi), sans accusé de KaraFun
// après 15 s. Une réponse manquante ne prouve pas que KaraFun a refusé
// l'ajout, et renvoyer ferait un doublon : l'envoi est déclaré non confirmé,
// l'envoi automatique est suspendu, et rien ne repart, ni ce titre ni un
// autre. Un accusé tardif retrouve l'envoi : le titre est suivi annulé, son
// retrait part aussitôt, le passage de la personne partie ne compte pas, et
// l'envoi automatique reprend avec l'autre titre une fois le retrait confirmé.
test('envoi annulé (« Parti ») sans accusé après 15 s : non confirmé, aucun second ajout ; accusé tardif suivi annulé et retiré', async t => {
  const clock = clockAt('2026-11-16T21:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  const tb = openTable(f, '1');
  singer(f, tb, 'Léa', 101);
  singer(f, tb, 'Tom', 201);
  f.settings.auto = true;
  const all = [];
  const step = (...messages) => { const out = frames(...messages); all.push(...out); return out; };
  const adds = () => all.filter(m => m.type === 'remote.AddToQueueRequest').map(m => m.payload.song.id);
  const [add] = step();
  assert.equal(add?.type, 'remote.AddToQueueRequest');
  const sel = f.pending().sel;
  assert.equal((await f.call('POST /api/staff/person/leave', { personId: sel.ids[0] })).pendingCancelled, true);
  clock.now += 16000;
  step();
  assert.equal(unconfirmed(f).length, 1, 'non confirmé après 15 s');
  assert.ok(unconfirmed(f)[0].startsWith(`KaraFun n'a pas confirmé « ${sel.song.title} »`));
  assert.equal(f.events('send.unconfirmed').length, 1);
  assert.equal(f.staffState().recoveredPending, true, 'envoi automatique suspendu');
  assert.equal(f.pending()?.cancelled, true, 'envoi gardé, toujours annulé');
  clock.now += 60000;
  step();
  assert.deepEqual(adds(), [add.payload.song.id], 'aucun second ajout, ni ce titre ni un autre');
  assert.equal(unconfirmed(f).length, 1, 'un seul avis');
  // Accusé tardif : KaraFun a bien ajouté le titre.
  const late = step({ id: add.id, type: 'remote.AddToQueueResponse', payload: {} },
    queueEvent(isoItem('A-id', add.payload.song.id, add.payload.options)));
  assert.equal(f.pending(), null, 'envoi retrouvé');
  assert.equal(f.staffState().recoveredPending, false);
  assert.deepEqual(plain(f.tracked().map(tr => [tr.queueId, !!tr.cancelled, tr.startedAt])), [['A-id', true, null]], 'suivi annulé');
  assert.deepEqual(removals(late), ['A-id'], 'retrait envoyé aussitôt');
  assert.ok(notes(f).includes(`« ${sel.song.title} » retirée de KaraFun après le départ du chanteur`));
  assert.deepEqual(f.events('turn.sent'), [], 'le passage de la personne partie ne compte pas');
  assert.deepEqual(adds(), [add.payload.song.id]);
  // KaraFun confirme le retrait ; l'envoi automatique reprend avec l'autre titre.
  step(queueEvent());
  assert.deepEqual(f.events('turn.unsent').map(e => [e.queueId, e.reason]), [['A-id', 'cancelled']]);
  assert.ok(notes(f).includes(`Retrait KaraFun confirmé : « ${sel.song.title} »`));
  clock.now += 1000;
  step();
  const other = add.payload.song.id === 101 ? 201 : 101;
  assert.deepEqual(adds(), [add.payload.song.id, other], 'jamais renvoyé ; l’envoi reprend avec l’autre titre');
});

// ---------------------------------------------------------------- relecture du cycle 3, cases anciennes : duo noté pendant un envoi, autre KaraFun
// Léa chante A (envoyé, accusé, sur scène) ; le titre de Zoé, d'une autre
// table, part vers KaraFun sans accusé encore, et le bar note Zoé en duo
// improvisé avec Léa : son titre doit quitter KaraFun dès qu'il y arrive
// (pending.pullOnAck), sinon elle rechanterait juste après son duo. Horloge du
// serveur avancée par l'essai. Rend aussi `Z`, ce titre tel que KaraFun le
// mettra dans sa file, et `addZ`, sa demande d'ajout.
async function p3g5DuoNotedDuringSend(t) {
  const clock = clockAt('2026-11-16T21:00:00.000Z');
  const f = harness({ Date: clock.Date });
  const { frames } = replayBridge(t, f);
  f.sched.opts.requirePresence = false;
  const lea = singer(f, openTable(f, '1'), 'Léa', 12458);
  const zoe = singer(f, openTable(f, '2'), 'Zoé');
  f.settings.auto = true;
  const [addA] = frames();
  f.settings.auto = false;
  assert.equal(addA?.type, 'remote.AddToQueueRequest');
  const A = isoItem('A-id', 12458, addA.payload.options);
  frames({ id: addA.id, type: 'remote.AddToQueueResponse', payload: {} }, isoStatus(1, A), queueEvent(A),
    isoStatus(2, A), isoStatus(3, A), isoStatus(4, A));
  assert.ok(f.tracked().find(tr => tr.queueId === 'A-id')?.startedAt, 'Léa chante A');
  f.sched.chooseSong(zoe.person, { songId: 12459, title: 'Titre 12459', artist: 'Artiste' });
  f.settings.auto = true;
  const addZ = frames().find(m => m.type === 'remote.AddToQueueRequest');
  f.settings.auto = false;
  assert.equal(f.pending()?.sel.ids[0], zoe.person.id, 'titre de Zoé en cours d’envoi');
  const marked = await f.call('POST /api/staff/duo-mark', { queueId: 'A-id', partnerId: zoe.person.id });
  assert.equal(marked.moved, 1);
  assert.equal(f.pending().pullOnAck, 'duo', 'retrait prévu à l’accusé');
  const Z = isoItem('Z-id', 12459, addZ.payload.options);
  return { f, clock, frames, lea, zoe, A, Z, addZ };
}

// Relecture du cycle 3 (cases anciennes, pull-on-ack × accusé) : l'accusé
// lisible arrive, le titre de Zoé n'est pas sur scène. Il est compté comme
// envoyé (turn.sent) et suivi, puis son retrait part aussitôt pour le duo ;
// KaraFun le retire, et il revient à Zoé, qui chantera plus tard.
test('duo noté pendant l’envoi du titre du partenaire, accusé lisible hors scène : compté, suivi, puis retiré de KaraFun', async t => {
  const { f, frames, zoe, A, Z, addZ } = await p3g5DuoNotedDuringSend(t);
  const out = frames({ id: addZ.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, Z));
  assert.equal(f.pending(), null, 'envoi accusé');
  assert.deepEqual(f.events('turn.sent').filter(e => e.queueId === 'Z-id').map(e => e.ids), [[zoe.person.id]],
    'passage compté à l’accusé');
  const sent = f.tracked().find(tr => tr.queueId === 'Z-id');
  assert.ok(sent, 'titre de Zoé suivi');
  assert.equal(sent.pulled?.reason, 'duo', 'retrait noté pour le duo');
  assert.deepEqual(removals(out), ['Z-id'], 'retrait envoyé dès l’accusé');
  // KaraFun le retire : le passage n'a pas eu lieu, le titre revient à Zoé.
  frames(queueEvent(A));
  assert.deepEqual(f.events('turn.unsent').map(e => [e.queueId, e.reason]), [['Z-id', 'pulled-duo']]);
  assert.ok(notes(f).some(line => /^« Titre 12459 » \(.+\) retiré de KaraFun après le duo improvisé : il repassera plus tard$/.test(line)));
  assert.ok(f.sched.songsOf(zoe.person).some(song => song.songId === 12459), 'titre rendu à Zoé');
});

// Relecture du cycle 3 (cases anciennes, pull-on-ack × délai) : sans accusé
// au bout de 15 s, l'envoi est à vérifier (recoveredPending, « KaraFun n'a pas
// confirmé ») comme un envoi simple, et rien n'est renvoyé : la commande peut
// encore arriver, un second ajout ferait chanter Zoé deux fois. Le retrait du
// duo reste prévu : l'accusé tardif le fait partir.
test('duo noté pendant l’envoi du titre du partenaire, sans accusé après 15 s : à vérifier, aucun second ajout ; accusé tardif retiré', async t => {
  const { f, clock, frames, A, Z, addZ } = await p3g5DuoNotedDuringSend(t);
  f.settings.auto = true; // l'envoi automatique ne renvoie pas le titre pour autant
  clock.now += 16000;
  const waited = frames();
  assert.equal(unconfirmed(f).length, 1);
  assert.match(unconfirmed(f)[0], /^KaraFun n'a pas confirmé « Titre 12459 »/);
  assert.equal(f.staffState().recoveredPending, true, 'envoi interrompu à vérifier par le bar');
  clock.now += 30000;
  waited.push(...frames());
  assert.deepEqual(waited.filter(m => m.type === 'remote.AddToQueueRequest'), [], 'aucun second ajout');
  assert.deepEqual(removals(waited), [], 'rien à retirer tant que le titre n’est pas vu');
  assert.equal(f.pending()?.pullOnAck, 'duo', 'retrait toujours prévu à l’accusé');
  // Accusé tardif : titre retrouvé, suivi, et retiré pour le duo.
  const late = frames({ id: addZ.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, Z));
  assert.equal(f.pending(), null);
  assert.equal(f.staffState().recoveredPending, false, 'plus rien à vérifier');
  assert.equal(f.tracked().find(tr => tr.queueId === 'Z-id')?.pulled?.reason, 'duo');
  assert.deepEqual(removals(late), ['Z-id'], 'accusé tardif : retrait envoyé');
  assert.deepEqual(late.filter(m => m.type === 'remote.AddToQueueRequest'), [], 'toujours aucun second ajout');
});

// Relecture du cycle 3 (cases anciennes, pull-on-ack × délai pendant une
// alerte de la file seule) : la file de KaraFun est illisible, l'état se lit
// encore (Léa chante). Le titre de Zoé y est peut-être : plus de 15 s passent
// sans verdict (ni « n'a pas confirmé », ni retrait). À la file lisible
// suivante, l'envoi est jugé comme un envoi simple : trouvé, il est accusé puis
// retiré pour le duo ; absent, il est à vérifier.
test('valeurs imprévues : duo noté pendant l’envoi, alerte de la file seule au-delà de 15 s : aucun verdict ; à la file lisible, accusé puis retiré, ou non confirmé', async t => {
  for (const seen of ['trouvé', 'absent']) {
    const { f, clock, frames, A, Z, addZ } = await p3g5DuoNotedDuringSend(t);
    const during = frames(...(seen === 'trouvé' ?
      [{ id: addZ.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, Z, ODD_ITEM)] : [queueEvent(A, ODD_ITEM)]));
    clock.now += 20000;
    during.push(...frames());
    clock.now += 40000;
    during.push(...frames());
    assert.deepEqual(unconfirmed(f), [], `${seen} : pas de verdict pendant l’alerte de la file`);
    assert.equal(f.staffState().recoveredPending, false, seen);
    assert.deepEqual(removals(during), [], `${seen} : rien retiré pendant l’alerte`);
    assert.equal(f.pending()?.pullOnAck, 'duo', `${seen} : envoi et retrait toujours en attente`);
    if (seen === 'trouvé') {
      const out = frames(queueEvent(A, Z));
      assert.equal(f.pending(), null, 'trouvé : accusé');
      assert.equal(f.tracked().find(tr => tr.queueId === 'Z-id')?.pulled?.reason, 'duo', seen);
      assert.deepEqual(removals(out), ['Z-id'], 'trouvé : retrait envoyé');
      assert.deepEqual(unconfirmed(f), [], seen);
    } else {
      const out = frames(queueEvent(A));
      assert.equal(unconfirmed(f).length, 1, 'absent : KaraFun n’a pas confirmé');
      assert.equal(f.staffState().recoveredPending, true, seen);
      assert.deepEqual(removals(out), [], 'absent : rien à retirer');
      assert.equal(f.pending()?.pullOnAck, 'duo', 'absent : retrait gardé pour un accusé tardif');
    }
  }
});

// Relecture du cycle 3 (cases anciennes, pull-on-ack × « J'ai vérifié la file
// KaraFun : reprendre ») : avant 15 s, l'envoi n'est pas interrompu. La reprise
// est refusée sans rien défaire (elle oublierait l'envoi et le renverrait) :
// l'envoi et son retrait suivent leur cours, le titre n'est jamais ajouté deux fois.
test('duo noté pendant l’envoi, « reprendre » demandé avant 15 s : refusé, l’envoi et son retrait suivent leur cours', async t => {
  const { f, frames, A, Z, addZ } = await p3g5DuoNotedDuringSend(t);
  await rejects(f.call('POST /api/staff/reconcile-pending'), null, /^Aucun envoi interrompu à vérifier\.$/);
  assert.equal(f.pending()?.pullOnAck, 'duo', 'envoi et retrait prévus gardés');
  assert.equal(f.staffState().recoveredPending, false);
  assert.equal(f.settings.auto, false, 'envoi automatique pas réactivé');
  const out = frames({ id: addZ.id, type: 'remote.AddToQueueResponse', payload: {} }, queueEvent(A, Z));
  assert.deepEqual(removals(out), ['Z-id'], 'à l’accusé, le titre de Zoé quitte KaraFun');
  assert.deepEqual(out.filter(m => m.type === 'remote.AddToQueueRequest'), [], 'jamais ajouté deux fois');
});

// Relecture du cycle 3 (cases anciennes, reconnexion depuis l'alerte × autre
// code) : « Reconnecter » de l'alerte garde « blind » jusqu'à la vue de
// KaraFun (alertReconnect), pour que « ⏸ Spotify » du bar tienne. Le bar
// saisit ensuite le code d'un autre KaraFun : ce n'est plus la reconnexion de
// l'alerte, mais un autre KaraFun, déconnecté (« unknown ») tant qu'il n'est
// pas vu. À sa vue, l'automatisme de Spotify repart de ce qu'il voit.
test('valeurs imprévues : « Reconnecter » de l’alerte, puis « Connecter » avec un autre code : déconnecté (« unknown ») jusqu’à la vue de cet autre KaraFun', async t => {
  const f = harness();
  const { bridge, frames } = replayBridge(t, f);
  const calls = fakeSpotify(f);
  frames(queueEvent(), isoStatus(1, null));
  await f.spotifyTick();
  assert.deepEqual(calls, ['lecture'], 'silence : Spotify relancé');
  // Code connu du serveur et URL KCS gardée, comme après une vraie connexion.
  bridge.code = '123456';
  bridge._kcs = { code: '123456', url: 'wss://kcs.exemple.invalid/remote' };
  assert.equal(f.connectKaraFun('123456'), 'kept');
  frames(queueEvent(ODD_ITEM), unreadableStatus(ODD_ITEM));
  assert.equal(f.karaokeOutlook(), 'blind');
  await f.call('POST /api/staff/spotify', { action: 'pause' });
  assert.deepEqual(plain(await f.call('POST /api/staff/kf', { action: 'reconnect' })), { ok: true, kept: false });
  assert.equal(f.karaokeOutlook(), 'blind', '« Reconnecter » de l’alerte : l’alerte continue pour Spotify');
  // Code d'un autre KaraFun : sa page est relue (découverte, sans réseau ici).
  bridge._open = function () { this._setPhase('discovering'); };
  assert.deepEqual(plain(await f.call('POST /api/staff/connect', { code: '654321' })), { ok: true, kept: false });
  assert.equal(bridge.code, '654321');
  assert.equal(bridge.connectionState().phase, 'discovering', 'connexion en cours, pas perdue');
  assert.equal(f.karaokeOutlook(), 'unknown', 'autre KaraFun : déconnecté, plus l’alerte de l’ancien');
  await f.spotifyTick();
  f.sync();
  assert.equal(f.karaokeOutlook(), 'unknown', 'tant qu’il n’est pas vu');
  // L'autre KaraFun répond : sa file et son état, scène libre.
  bridge._openKcs('wss://kcs.exemple.invalid/autre', () => true);
  reopened(bridge, queueEvent(), isoStatus(1, null));
  f.sync();
  assert.equal(bridge.ready, true);
  assert.equal(f.karaokeOutlook(), 'silent', 'vu : sa propre scène');
  await f.spotifyTick();
  assert.deepEqual(calls, ['lecture', 'pause', 'lecture'], 'autre KaraFun : l’automatisme repart de ce qu’il voit');
});

// Regression: relecture du cycle 3 — « Supprimer toutes les tables » ne retirait que
// les titres envoyés jamais commencés : la copie prête à jouer d'une relance ⏮
// inachevée, qui garde le début du titre relancé, restait en tête de KaraFun. Elle passait pour le prochain titre de la nouvelle soirée : rien
// ne partait de la file tant que le bar ne l'avait pas retirée dans KaraFun, et
// « Lecture » rejouait le titre de la soirée close. Elle part comme un titre à
// venir : son retrait est envoyé, elle ne compte pas dans la nouvelle soirée, et le
// premier titre de celle-ci part une fois KaraFun vidé.
test('relance ⏮ inachevée, copie prête à jouer : « Supprimer toutes les tables » la retire, la nouvelle soirée envoie son premier titre', async t => {
  const { clock, f, frames, tr } = await p3g1CopyAwaitingPlay(t);
  const reset = await f.call('POST /api/staff/tables-clear', { confirmation: 'SUPPRIMER TOUTES LES TABLES' });
  assert.deepEqual([reset.removalRequests, reset.removalPending], [1, 1], 'la copie compte parmi les titres à retirer');
  assert.equal(tr.cancelled, true, 'copie annulée comme un titre à venir');
  assert.deepEqual(removals(frames()), ['C-id'], 'son retrait est parti');
  // KaraFun retire la copie : sa file est vide.
  frames(queueEvent(), isoStatus(1, null));
  assert.equal(f.tracked().length, 0, 'copie plus suivie');
  assert.equal(f.sched.appearanceSerial, 0, 'aucun passage compté dans la nouvelle soirée');
  assert.deepEqual(f.events('turn.sent'), [], 'aucun envoi noté au journal de la nouvelle soirée');
  // Premier titre de la nouvelle soirée : il part une fois la file de KaraFun vide depuis 1 s.
  singer(f, openTable(f, '2'), 'Nina', 202);
  f.settings.auto = true;
  clock.now += 1000;
  assert.deepEqual(frames().filter(m => m.type === 'remote.AddToQueueRequest').map(m => m.payload.song.id), [202],
    'KaraFun vidé de la copie : le titre de Nina part');
});

// Regression: relecture du cycle 3 (case sans essai) — la synchronisation qui suit
// l'alerte d'un message illisible voit d'un coup ce que KaraFun a fait pendant elle,
// même quand KaraFun a été perdu entre-temps (lastSyncBlind). Réglage de B fait
// pendant l'alerte (« pas encore envoyé »), connexion perdue puis rouverte : B joue
// déjà, réglé par le bar dans KaraFun, et rien n'y est rattrapé en pleine chanson.
// Sans alerte, le réglage fait pendant la coupure (« au retour de KaraFun ») est
// rattrapé au retour, comme pour tout titre vu pour la première fois en lecture.
test('valeurs imprévues : réglage fait pendant l’alerte, KaraFun perdu puis revenu en pleine chanson : rien rattrapé ; sans alerte, rattrapé au retour', async t => {
  for (const alert of [true, false]) {
    const label = alert ? 'alerte puis coupure' : 'coupure seule';
    const { f, bridge, frames, A, B, trB } = aThenB(t);
    if (alert) frames(unreadableStatus(A));
    else { bridge.disconnect(); f.sync(); }
    const answer = await f.call('POST /api/staff/song/settings', { personId: trB.sel.ids[0], entryId: trB.sel.song.entryId,
      settings: { pitch: 2, tempo: 10, guide: 50 } });
    assert.equal(answer.applied, alert ? 'unreadable' : 'start', `${label} : réponse au réglage`);
    if (alert) { bridge.disconnect(); f.sync(); }
    assert.equal(f.karaokeOutlook(), 'unknown', `${label} : KaraFun déconnecté`);
    // KaraFun revient : A est fini, B joue déjà, avec les valeurs réglées dans KaraFun.
    const live = { pitch: -1, tempo: 0, guide: 25 };
    bridge._openKcs('wss://kcs.exemple.invalid/remote', () => true);
    const ws = reopened(bridge);
    ws.out.length = 0;
    for (const message of [queueEvent(B), isoStatus(4, B, live)]) ws.emit('message', { data: JSON.stringify(message) });
    f.sync();
    ws.emit('message', { data: JSON.stringify(isoStatus(4, B, live)) });
    f.sync();
    assert.ok(trB.startedAt, `${label} : B compté sur scène`);
    assert.deepEqual(bare(ws.out.filter(m => !m.type.startsWith('core.'))), alert ? [] : [pitchTo(2), tempoTo(10), volumeTo(5, 50)],
      `${label} : rattrapage en pleine chanson`);
    assert.equal(f.events('song.settingsCaughtUp').length, alert ? 0 : 1, label);
  }
});
