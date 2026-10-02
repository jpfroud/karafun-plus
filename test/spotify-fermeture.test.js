'use strict';
// Deuxième essai réel au bar (PR #10) :
// - Spotify ne reprend que quand la file est vide, jamais entre deux chansons,
//   et le silence avant la relance peut descendre sous 5 secondes ;
// - quand Spotify reprend en fin de file, la lecture automatique attend le
//   bar (le temps de redonner le micro) ; « Lecture » la rétablit ;
// - Spotify se coupe un court instant avant le lancement d'un titre ;
// - à l'heure de fermeture, les titres qui ne passeraient plus ne partent
//   pas vers KaraFun et ne démarrent pas : Spotify reprend.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { SpotifyLink, SpotifyAutomation } = require('../spotify');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

function harness({ logs = null } = {}) {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const context = { require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, Buffer,
    console: logs ? { ...console, log: (...parts) => logs.push(parts.join(' ')) } : console, URL, setTimeout, setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, tracked, settings, handlers, spotify, spotifyAutomation, spotifyTick, sync, analyze,
      karaokeOutlook, playKaraFun, staffState, access, battleVote, closingBlocksStart, catalogPhoneError,
      setBridge: b => { bridge = b; }, getPending: () => pending, getPlayStarting: () => playStarting };
  `, context, { filename: 'server.js' });
  context.fixture.settings.auto = false;
  context.fixture.settings.autoPlay = false;
  return context.fixture;
}

const json = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => null },
  json: async () => body, text: async () => JSON.stringify(body) });

// Faux Spotify : journal des appels, lecture en cours ou non.
function fakeSpotify(f, { playing = false, ...options } = {}) {
  const calls = [];
  const state = { playing };
  f.spotify.fetchImpl = async (url, request = {}) => {
    if (url.endsWith('/api/token')) return json({ access_token: 't', expires_in: 3600 });
    if (url.endsWith('/me/player')) return json({ is_playing: state.playing, device: { id: 'pc', name: 'PC' } });
    if (url.includes('/me/player/play')) { calls.push(['spotify-play', Date.now()]); state.playing = true; return { ok: true, status: 204, text: async () => '' }; }
    if (url.includes('/me/player/pause')) { calls.push(['spotify-pause', Date.now()]); state.playing = false; return { ok: true, status: 204, text: async () => '' }; }
    throw new Error(`inattendu : ${url} ${request.method || ''}`);
  };
  f.spotify.config = { ...f.spotify.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'r',
    autoResume: true, autoPause: true, resumeDelaySec: 0, pauseLeadSec: 0, ...options };
  return { calls, state };
}

// Faux KaraFun : `playing` = queueId en lecture, ou rien.
function fakeBridge(calls, queue, playing = null) {
  return { ready: true, connected: true, queue, events: [], permissions: {},
    snapshot: () => ({ ready: true, connected: true, queue, events: [] }),
    status: playing == null ? { state: 'idle' } : { state: 'playing', songPlaying: { queueId: playing } },
    add: songId => calls.push(['add', songId, Date.now()]), remove: id => calls.push(['remove', id]),
    next: () => calls.push(['next']), play: () => calls.push(['karafun-play', Date.now()]) };
}

function singers(f, names) {
  return names.map((name, i) => {
    const p = f.sched.join({ tableId: String(i + 1), name, headcount: 1 });
    f.sched.chooseSong(p, { songId: 800 + i, title: `Titre ${name}` });
    return p;
  });
}

// Le titre de la première personne est chargé dans KaraFun, rien ne joue.
function loadedNext(f, calls) {
  const sel = f.sched.select(); f.sched.commit(sel);
  const queue = [{ queueId: 5, songId: sel.song.songId, singer: sel.label }];
  f.setBridge(fakeBridge(calls, queue));
  f.tracked.push({ queueId: 5, sel, startedAt: null, addedAt: Date.now() });
  return sel;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- automate seul
test('automate Spotify : rien entre deux chansons, relance sans délai quand la file est vide', () => {
  let now = 0;
  const automation = new SpotifyAutomation({ now: () => now });
  const config = { autoResume: true, autoPause: true, resumeDelaySec: 0 };
  assert.equal(automation.step('between', config), null);
  now += 600000;
  assert.equal(automation.step('between', config), null, 'jamais de relance tant qu’un titre arrive');
  assert.equal(automation.step('silent', config), 'resume', 'file vide : relance immédiate avec un délai de 0 s');
});

test('réglages Spotify : relance de 0 à 300 s, silence avant un titre de 0 à 10 s', () => {
  const link = new SpotifyLink({ file: null });
  link.setOptions({ resumeDelaySec: 0, pauseLeadSec: 0 });
  assert.equal(link.config.resumeDelaySec, 0);
  assert.equal(link.config.pauseLeadSec, 0);
  link.setOptions({ resumeDelaySec: 2, pauseLeadSec: 2 });
  assert.equal(link.view().pauseLeadSec, 2);
  assert.throws(() => link.setOptions({ resumeDelaySec: -1 }), /entre 0 et 300/);
  assert.throws(() => link.setOptions({ resumeDelaySec: 301 }), /entre 0 et 300/);
  assert.throws(() => link.setOptions({ pauseLeadSec: 11 }), /entre 0 et 10/);
  assert.throws(() => link.setOptions({ pauseLeadSec: 1.5 }), /entre 0 et 10/);
});

// ---------------------------------------------------------------- serveur
test('Spotify ne reprend pas entre deux chansons : titre chargé dans KaraFun ou prêt dans la file', async () => {
  const f = harness();
  const { calls } = fakeSpotify(f);
  const kf = [];
  singers(f, ['Alice', 'Bruno']);
  loadedNext(f, kf);
  assert.equal(f.karaokeOutlook(), 'between');
  await f.spotifyTick();
  await f.spotifyTick();
  assert.deepEqual(calls, [], 'titre suivant chargé : pas de Spotify');
  // Plus rien dans KaraFun, mais un titre prêt dans la file avec l'envoi automatique.
  f.tracked.length = 0;
  f.setBridge(fakeBridge(kf, []));
  f.settings.auto = true;
  assert.equal(f.karaokeOutlook(), 'between');
  await f.spotifyTick();
  assert.deepEqual(calls, []);
});

test('fin de file : Spotify reprend et la lecture automatique attend le bar ; « Lecture » la rétablit', async () => {
  const f = harness();
  const { calls, state } = fakeSpotify(f);
  const kf = [];
  f.setBridge(fakeBridge(kf, []));
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 0;
  assert.equal(f.karaokeOutlook(), 'silent');
  await f.spotifyTick();
  assert.deepEqual(calls.map(c => c[0]), ['spotify-play']);
  assert.equal(f.settings.autoPlay, false, 'lecture automatique suspendue');
  assert.equal(f.settings.autoPlayHeld, true);
  assert.ok(f.sched.log.some(line => /lecture automatique suspendue/i.test(line.msg)));
  assert.equal(f.staffState().settings.autoPlayHeld, true, 'le bar le voit');
  // Un titre arrive dans KaraFun : il attend le bar.
  singers(f, ['Alice']);
  loadedNext(f, kf);
  f.sync();
  await wait(20);
  assert.equal(kf.filter(c => c[0] === 'karafun-play').length, 0, 'pas de lancement automatique');
  // Le bar touche « Lecture » : Spotify d'abord coupé, puis le titre.
  f.spotify.config.pauseLeadSec = 1;
  await f.handlers['POST /api/staff/kf'](null, null, { action: 'play' });
  const pause = calls.find(c => c[0] === 'spotify-pause');
  const play = kf.find(c => c[0] === 'karafun-play');
  assert.ok(pause && play, 'Spotify coupé puis KaraFun lancé');
  assert.ok(play[1] - pause[1] >= 950, `silence de transition : ${play[1] - pause[1]} ms`);
  assert.equal(state.playing, false);
  assert.equal(f.settings.autoPlay, true, 'lecture automatique rétablie');
  assert.equal(f.settings.autoPlayHeld, false);
});

test('changer soi-même la lecture automatique lève la suspension', async () => {
  const f = harness();
  fakeSpotify(f);
  f.setBridge(fakeBridge([], []));
  f.settings.autoPlay = true;
  await f.spotifyTick();
  assert.equal(f.settings.autoPlayHeld, true);
  await f.handlers['POST /api/staff/settings'](null, null, { autoPlay: true });
  assert.equal(f.settings.autoPlay, true);
  assert.equal(f.settings.autoPlayHeld, false);
});

test('lecture automatique : Spotify coupé avant le titre, avec le silence réglé', async () => {
  const f = harness();
  const { calls } = fakeSpotify(f, { playing: true, pauseLeadSec: 1 });
  const kf = [];
  singers(f, ['Alice', 'Bruno']);
  loadedNext(f, kf);
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 0;
  f.sync();
  f.sync();
  // Le lancement attend la coupure de Spotify puis le silence : on attend sa fin.
  assert.ok(f.getPlayStarting(), 'lancement en cours');
  await f.getPlayStarting();
  const pause = calls.find(c => c[0] === 'spotify-pause');
  const plays = kf.filter(c => c[0] === 'karafun-play');
  assert.ok(pause, 'Spotify coupé');
  assert.equal(plays.length, 1, 'un seul lancement');
  assert.ok(plays[0][1] - pause[1] >= 950, `silence de transition : ${plays[0][1] - pause[1]} ms`);
});

test('lancement sans Spotify en lecture : pas d’attente', async () => {
  const f = harness();
  const { calls } = fakeSpotify(f, { playing: false, pauseLeadSec: 5 });
  const kf = [];
  singers(f, ['Alice']);
  loadedNext(f, kf);
  const started = Date.now();
  await f.playKaraFun();
  assert.ok(Date.now() - started < 1000, 'aucun silence ajouté quand Spotify ne joue pas');
  assert.deepEqual(calls, []);
  assert.equal(kf.filter(c => c[0] === 'karafun-play').length, 1);
});

// ---------------------------------------------------------------- fermeture
test('fermeture : un titre qui passerait après l’heure ne part pas vers KaraFun', async () => {
  const f = harness();
  const kf = [];
  const [alice] = singers(f, ['Alice', 'Bruno', 'Chloé']);
  const stage = f.sched.select(); f.sched.commit(stage);
  assert.equal(stage.ids[0], alice.id);
  const queue = [{ queueId: 1, songId: stage.song.songId, singer: stage.label }];
  f.setBridge(fakeBridge(kf, queue, 1));
  f.tracked.push({ queueId: 1, sel: stage, startedAt: Date.now() - 5000, addedAt: Date.now() - 10000 });
  f.settings.auto = true;
  f.settings.pushDelaySec = 0;
  const slot = f.sched.avgSlotSec() * 1000;
  // Le titre suivant commencerait à la fin de celui-ci : sa moitié dépasse l'heure.
  f.settings.closingAt = Date.now() - 5000 + slot + slot / 2 - 2000;
  f.sync(); await wait(1100); f.sync();
  assert.equal(f.getPending(), null, 'rien n’est envoyé');
  assert.deepEqual(kf.filter(c => c[0] === 'add'), []);
  assert.equal(f.sched.log.filter(line => /Fermeture/.test(line.msg) && /plus aucun titre n’est envoyé/.test(line.msg)).length, 1);
  f.sync();
  assert.equal(f.sched.log.filter(line => /Fermeture/.test(line.msg) && /plus aucun titre n’est envoyé/.test(line.msg)).length, 1, 'annoncé une fois');
  // Le bar décale l'heure : l'envoi reprend.
  await f.handlers['POST /api/staff/closing'](null, null, { extendMin: 30 });
  f.sync();
  assert.ok(f.getPending(), 'après décalage, le titre suivant part');
});

test('fermeture : un titre chargé ne démarre plus après l’heure, et Spotify reprend', async () => {
  const f = harness();
  const { calls } = fakeSpotify(f);
  const kf = [];
  singers(f, ['Alice', 'Bruno']);
  loadedNext(f, kf);
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 0;
  const slot = f.sched.avgSlotSec() * 1000;
  f.settings.closingAt = Date.now() + slot / 2 - 3000;
  assert.equal(f.karaokeOutlook(), 'silent', 'fermeture : plus rien ne sera lancé');
  f.sync(); f.sync();
  await wait(50);
  assert.equal(kf.filter(c => c[0] === 'karafun-play').length, 0, 'le titre chargé ne démarre pas');
  assert.ok(kf.some(c => c[0] === 'remove' && c[1] === 5), 'le titre chargé est retiré de KaraFun');
  await f.spotifyTick();
  assert.deepEqual(calls.map(c => c[0]), ['spotify-play'], 'Spotify reprend à la fermeture');
  // KaraFun retire le titre ; le bar ajoute lui-même un titre dans KaraFun et le lance.
  const bridge = f.analyze && fakeBridge(kf, [{ queueId: 9, songId: 999, singer: 'Le bar' }]);
  f.setBridge(bridge);
  f.sync();
  await f.handlers['POST /api/staff/kf'](null, null, { action: 'play' });
  assert.equal(kf.filter(c => c[0] === 'karafun-play').length, 1, '« Lecture » du bar reste possible après l’heure');
});

test('fermeture encore loin : envoi et lancement normaux', async () => {
  const f = harness();
  const kf = [];
  singers(f, ['Alice', 'Bruno']);
  loadedNext(f, kf);
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 0;
  f.settings.closingAt = Date.now() + 3 * 3600000;
  assert.equal(f.karaokeOutlook(), 'between');
  f.sync(); f.sync();
  await wait(50);
  assert.equal(kf.filter(c => c[0] === 'karafun-play').length, 1);
});

// ---------------------------------------------------------------- relecture
// Regression: relecture gstack du 2 octobre (suspension levée par n'importe
// quel lancement, fermeture sans suspension, « Je suis là », état revérifié
// avant de lancer, délai Spotify enregistré, retrait annulé, Battle après l'heure).

// Lecture automatique suspendue (Spotify a repris en fin de file).
async function heldAutoPlay(f) {
  fakeSpotify(f);
  f.setBridge(fakeBridge([], []));
  f.settings.autoPlay = true;
  await f.spotifyTick();
  assert.equal(f.settings.autoPlayHeld, true);
}

test('suspension levée dès qu’un titre démarre, même lancé dans KaraFun', async () => {
  const f = harness();
  await heldAutoPlay(f);
  const kf = [];
  singers(f, ['Alice', 'Bruno']);
  const sel = loadedNext(f, kf);
  // Le bar lance le titre directement dans KaraFun.
  f.setBridge(fakeBridge(kf, [{ queueId: 5, songId: sel.song.songId, singer: sel.label }], 5));
  f.sync();
  assert.equal(f.settings.autoPlayHeld, false);
  assert.equal(f.settings.autoPlay, true, 'la lecture automatique reprend pour les titres suivants');
});

test('fermeture : Spotify reprend sans suspendre la lecture automatique, et le journal dit pourquoi', async () => {
  const logs = [];
  const f = harness({ logs });
  const { calls } = fakeSpotify(f);
  singers(f, ['Alice']);
  f.setBridge(fakeBridge([], []));
  f.settings.auto = true;
  f.settings.autoPlay = true;
  f.settings.closingAt = Date.now() - 60000;
  await f.spotifyTick();
  assert.deepEqual(calls.map(c => c[0]), ['spotify-play']);
  assert.equal(f.settings.autoPlay, true, '« +10 min » relancera la file d’elle-même');
  assert.equal(f.settings.autoPlayHeld, false);
  assert.ok(!f.sched.log.some(line => /fin de file/.test(line.msg)));
  assert.ok(logs.some(line => /Spotify relancé : heure de fermeture\./.test(line)), logs.join('\n'));
  // Sans fermeture, le journal donne l'autre raison.
  const endLogs = [];
  const g = harness({ logs: endLogs });
  fakeSpotify(g);
  g.setBridge(fakeBridge([], []));
  await g.spotifyTick();
  assert.ok(endLogs.some(line => /Spotify relancé : la file est vide\./.test(line)), endLogs.join('\n'));
});

test('« Je suis là » attendu : Spotify ne reprend pas entre deux chansons', async () => {
  const f = harness();
  const { calls } = fakeSpotify(f);
  f.sched.opts.requirePresence = true;
  singers(f, ['Alice', 'Bruno']);
  f.setBridge(fakeBridge([], []));
  f.settings.auto = true;
  assert.equal(f.karaokeOutlook(), 'between', 'un chanteur attend sa confirmation : la file n’est pas vide');
  await f.spotifyTick();
  assert.deepEqual(calls, []);
});

test('lancement annulé si le titre a été retiré de KaraFun pendant la coupure de Spotify', async () => {
  const f = harness();
  fakeSpotify(f, { playing: true, pauseLeadSec: 1 });
  const kf = [];
  singers(f, ['Alice', 'Bruno']);
  loadedNext(f, kf);
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 0;
  f.sync();
  const starting = f.getPlayStarting();
  assert.ok(starting);
  // Pendant le silence, KaraFun retire le titre (« Pas prêt », duo, fermeture…).
  f.setBridge(fakeBridge(kf, []));
  await starting;
  assert.equal(kf.filter(c => c[0] === 'karafun-play').length, 0, 'rien n’est lancé à la place');
});

test('lancement : pause Spotify en échec, KaraFun démarre quand même sans silence ; deux appels, un seul lancement', async () => {
  const f = harness();
  fakeSpotify(f, { playing: true, pauseLeadSec: 5 });
  const base = f.spotify.fetchImpl;
  f.spotify.fetchImpl = async (url, request) => url.includes('/me/player/pause') ?
    json({ error: { message: 'panne' } }, 500) : base(url, request);
  const kf = [];
  singers(f, ['Alice']);
  loadedNext(f, kf);
  const started = Date.now();
  await Promise.all([f.playKaraFun(), f.playKaraFun()]);
  assert.ok(Date.now() - started < 1000, 'pas de silence quand la pause a échoué');
  assert.equal(kf.filter(c => c[0] === 'karafun-play').length, 1);
  assert.ok(f.spotify.lastError);
});

test('réglages Spotify enregistrés : l’ancien délai par défaut de 15 s passe à 3 s, un choix du bar est gardé', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'spotify-'));
  try {
    const file = path.join(dir, 'spotify.json');
    fs.writeFileSync(file, JSON.stringify({ clientId: '0123456789abcdef', resumeDelaySec: 15 }));
    assert.equal(new SpotifyLink({ file }).config.resumeDelaySec, 3);
    fs.writeFileSync(file, JSON.stringify({ clientId: '0123456789abcdef', resumeDelaySec: 5 }));
    assert.equal(new SpotifyLink({ file }).config.resumeDelaySec, 5);
    const link = new SpotifyLink({ file });
    link.setOptions({ resumeDelaySec: 15 });
    assert.equal(new SpotifyLink({ file }).config.resumeDelaySec, 15, '15 s choisi après la mise à jour : gardé');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fermeture : « +10 min » avant le retrait, le titre reste chargé ; alerte propre à la fermeture', async () => {
  const f = harness();
  const kf = [];
  singers(f, ['Alice', 'Bruno']);
  loadedNext(f, kf);
  f.settings.auto = true;
  f.settings.closingAt = Date.now() - 60000;
  f.sync();
  const tr = f.tracked.find(item => item.queueId === 5);
  assert.equal(tr.pulled?.reason, 'closing');
  // KaraFun n'a pas encore retiré le titre : l'alerte parle de la fermeture.
  tr.pulled.at -= 46000;
  f.sync();
  assert.ok(f.sched.log.some(line => /passerait après la fermeture : retire-le dans KaraFun/.test(line.msg)));
  await f.handlers['POST /api/staff/closing'](null, null, { extendMin: 30 });
  const removals = kf.filter(c => c[0] === 'remove').length;
  f.sync();
  assert.equal(tr.pulled, null, 'le titre n’est plus à retirer');
  tr.removeRequestedAt = 0;
  f.sync();
  assert.equal(kf.filter(c => c[0] === 'remove').length, removals, 'plus de retrait demandé');
});

test('fermeture : titre ajouté par le bar sur scène, estimation à partir de maintenant', () => {
  const f = harness();
  const kf = [];
  singers(f, ['Alice']);
  f.setBridge(fakeBridge(kf, [{ queueId: 9, songId: 999, singer: 'Le bar' }], 9));
  const slot = f.sched.avgSlotSec() * 1000;
  const current = f.analyze().current;
  assert.ok(current);
  f.settings.closingAt = Date.now() + slot + 5000;
  assert.equal(f.closingBlocksStart(current, 0), false, 'la moitié du titre suivant tient encore');
  f.settings.closingAt = Date.now() + slot - 5000;
  assert.equal(f.closingBlocksStart(current, 0), true);
});

test('fermeture : plus de proposition de Battle après l’heure', async () => {
  const f = harness();
  const [alice] = singers(f, ['Alice']);
  const secret = f.access.issue('1');
  f.settings.closingAt = Date.now() - 60000;
  await assert.rejects(f.handlers['POST /api/table/battle/propose'](null, null,
    { table: '1', access: secret, personId: alice.id, token: alice.token, songs: [{ songId: 1, title: 'X' }] }),
  error => error.code === 'CLOSING' && /Battle/.test(error.message));
});

test('catalogue : message montré aux téléphones selon la panne', () => {
  const f = harness();
  const unavailable = extra => Object.assign(new Error('x'), { catalogUnavailable: true, ...extra });
  assert.match(f.catalogPhoneError(unavailable({ status: 403 })), /refus HTTP 403/);
  assert.match(f.catalogPhoneError(unavailable({ kind: 'timeout' })), /délai dépassé/);
  assert.match(f.catalogPhoneError(unavailable({ kind: 'json' })), /réponse illisible/);
  assert.match(f.catalogPhoneError(unavailable({ kind: 'network' })), /réseau injoignable/);
  assert.equal(f.catalogPhoneError(new Error('Filtre de catalogue invalide')), 'Filtre de catalogue invalide');
});

test('soirée sauvegardée : la suspension de la lecture automatique survit à un redémarrage', () => {
  const { Scheduler } = require('../scheduler');
  const { TableAccess } = require('../table-access');
  const { snapshotNight, restoreNight } = require('../night-state');
  const s = new Scheduler();
  const settings = { auto: true, autoPlay: false, autoPlayHeld: true, pushDelaySec: 45, playDelaySec: 8 };
  const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access: new TableAccess(), settings })));
  const restored = {};
  restoreNight(snapshot, { scheduler: new Scheduler(), access: new TableAccess(), settings: restored });
  assert.equal(restored.autoPlayHeld, true);
  snapshot.settings.autoPlayHeld = 'oui';
  assert.throws(() => restoreNight(snapshot, { scheduler: new Scheduler(), access: new TableAccess(), settings: {} }), /réglages mal formés/);
});

// ---------------------------------------------------------------- seconde relecture
// Regression: seconde relecture gstack du 2 octobre (retrait de fermeture
// annulé pendant que KaraFun l'applique, estimation incohérente au début
// d'un titre, lancements concurrents, titre absent, suspension pendant la
// relance de Spotify).

// Le titre d'Alice, chargé dans KaraFun, a été retiré pour la fermeture.
function closingPulled(f, kf) {
  singers(f, ['Alice', 'Bruno']);
  const sel = loadedNext(f, kf);
  f.settings.closingAt = Date.now() - 60000;
  f.sync();
  assert.equal(f.tracked.find(item => item.queueId === 5).pulled?.reason, 'closing');
  return sel;
}

test('fermeture : « +10 min » pendant le retrait, KaraFun retire quand même le titre : le chanteur le garde', async () => {
  const f = harness();
  const kf = [];
  const sel = closingPulled(f, kf);
  const owner = f.sched.people.get(sel.ids[0]);
  await f.handlers['POST /api/staff/closing'](null, null, { extendMin: 30 });
  f.sync();
  assert.equal(f.tracked.find(item => item.queueId === 5).pulled, null, 'le titre tient de nouveau avant l’heure');
  // Le retrait envoyé avant le décalage arrive ensuite dans KaraFun.
  f.setBridge(fakeBridge(kf, []));
  f.sync();
  assert.equal(owner.song?.songId, sel.song.songId, 'le titre revient dans la liste du chanteur');
  assert.ok(!f.sched.log.some(line => /passée dans KaraFun avant la lecture/.test(line.msg)),
    f.sched.log.map(line => line.msg).join('\n'));
});

test('fermeture : longtemps après « +10 min », un titre retiré dans KaraFun est un choix du bar', async () => {
  const f = harness();
  const kf = [];
  const sel = closingPulled(f, kf);
  const owner = f.sched.people.get(sel.ids[0]);
  await f.handlers['POST /api/staff/closing'](null, null, { extendMin: 30 });
  f.sync();
  f.tracked.find(item => item.queueId === 5).unpulled.at -= 21000;
  f.setBridge(fakeBridge(kf, []));
  f.sync();
  assert.ok(f.sched.log.some(line => /passée dans KaraFun avant la lecture/.test(line.msg)));
  assert.notEqual(owner.song?.songId, sel.song.songId, 'le titre n’est pas renvoyé');
});

test('fermeture : au début d’un titre, un retrait en attente n’est ni annulé ni renvoyé', () => {
  const f = harness();
  const kf = [];
  const [alice, bruno] = singers(f, ['Alice', 'Bruno']);
  const stage = f.sched.select(); f.sched.commit(stage);
  assert.equal(stage.ids[0], alice.id);
  const next = f.sched.select(); f.sched.commit(next);
  assert.equal(next.ids[0], bruno.id);
  const queue = [{ queueId: 1, songId: stage.song.songId, singer: stage.label },
    { queueId: 2, songId: next.song.songId, singer: next.label }];
  // Le titre d'Alice vient de démarrer : startedAt n'est pas encore noté.
  f.setBridge(fakeBridge(kf, queue, 1));
  const pulledAt = Date.now() - 50000;
  f.tracked.push({ queueId: 1, sel: stage, startedAt: null, addedAt: Date.now() - 60000 },
    { queueId: 2, sel: next, startedAt: null, addedAt: Date.now() - 60000,
      pulled: { reason: 'closing', at: pulledAt, alerted: true }, removeRequestedAt: Date.now() });
  // Bruno commencerait entre une et une fois et demie la durée moyenne d'un titre.
  const slot = f.sched.avgSlotSec() * 1000;
  f.settings.closingAt = Date.now() + slot * 1.25;
  f.sync();
  const tr = f.tracked.find(item => item.queueId === 2);
  assert.deepEqual({ ...tr.pulled }, { reason: 'closing', at: pulledAt, alerted: true }, 'retrait gardé tel quel');
  assert.equal(kf.filter(c => c[0] === 'remove').length, 0, 'pas de retrait renvoyé ni de nouvelle alerte');
});

test('lancement automatique abandonné : deux « Lecture » du bar en attente, un seul lancement', async () => {
  const f = harness();
  fakeSpotify(f, { playing: true, pauseLeadSec: 1 });
  const kf = [];
  singers(f, ['Alice', 'Bruno']);
  loadedNext(f, kf);
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 0;
  f.sync();
  const auto = f.getPlayStarting();
  assert.ok(auto, 'lancement automatique en cours');
  const taps = [f.playKaraFun(), f.playKaraFun()];
  // Pendant le silence, la tête de la file change : le lancement automatique renonce.
  f.setBridge(fakeBridge(kf, [{ queueId: 6, songId: 999, singer: 'Le bar' }]));
  assert.equal(await auto, false);
  assert.deepEqual(await Promise.all(taps), [true, true]);
  assert.equal(kf.filter(c => c[0] === 'karafun-play').length, 1, 'un seul lancement pour les deux appuis');
  assert.equal(f.getPlayStarting(), null);
});

test('lancement automatique revérifié après le silence : autre titre, titre en cours ou titre retiré', async () => {
  const cases = {
    'autre titre en tête': (f, kf) => f.setBridge(fakeBridge(kf, [{ queueId: 6, songId: 999, singer: 'Le bar' },
      { queueId: 5, songId: 800, singer: 'Alice' }])),
    'titre déjà en cours': (f, kf) => f.setBridge(fakeBridge(kf, [{ queueId: 6, songId: 999, singer: 'Le bar' },
      { queueId: 5, songId: 800, singer: 'Alice' }], 6)),
    'titre retiré entre-temps': f => { f.tracked.find(item => item.queueId === 5).pulled = { reason: 'defer', at: Date.now() }; },
    'heure de fermeture passée': f => { f.settings.closingAt = Date.now() - 60000; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const f = harness();
    fakeSpotify(f, { playing: true, pauseLeadSec: 1 });
    const kf = [];
    singers(f, ['Alice', 'Bruno']);
    loadedNext(f, kf);
    const starting = f.playKaraFun({ queueId: '5' });
    change(f, kf);
    assert.equal(await starting, false, name);
    assert.equal(kf.filter(c => c[0] === 'karafun-play').length, 0, name);
  }
});

test('titre marqué absent en tête : pas de lancement automatique, Spotify n’est pas coupé', async () => {
  const f = harness();
  const { calls } = fakeSpotify(f, { playing: true });
  const kf = [];
  singers(f, ['Alice', 'Bruno']);
  loadedNext(f, kf);
  f.tracked.find(item => item.queueId === 5).absent = true;
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 0;
  f.sync(); f.sync();
  await wait(50);
  assert.equal(f.getPlayStarting(), null, 'aucun lancement tenté');
  assert.deepEqual(calls, [], 'Spotify continue');
});

test('Spotify relancé pendant qu’un titre démarre : la lecture automatique n’est pas suspendue', async () => {
  const f = harness();
  const { calls } = fakeSpotify(f);
  const base = f.spotify.fetchImpl;
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  f.spotify.fetchImpl = async (url, request) => {
    if (url.includes('/me/player/play')) await slow;
    return base(url, request);
  };
  const kf = [];
  f.setBridge(fakeBridge(kf, []));
  f.settings.autoPlay = true;
  const tick = f.spotifyTick();
  await wait(20);
  // Pendant la relance, le bar lance un titre dans KaraFun.
  f.setBridge(fakeBridge(kf, [{ queueId: 9, songId: 999, singer: 'Le bar' }], 9));
  release();
  await tick;
  assert.deepEqual(calls.map(c => c[0]), ['spotify-play']);
  assert.equal(f.settings.autoPlayHeld, false, 'un titre est en cours : rien à suspendre');
  assert.equal(f.settings.autoPlay, true);
});

test('réglages Spotify : la migration du délai de 15 s ne touche que les réglages d’avant la v0.4', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'spotify-'));
  try {
    const file = path.join(dir, 'spotify.json');
    fs.writeFileSync(file, JSON.stringify({ clientId: '0123456789abcdef', resumeDelaySec: 15, configVersion: 3 }));
    assert.equal(new SpotifyLink({ file }).config.resumeDelaySec, 15, 'réglage plus récent : gardé');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('soirée sauvegardée : une « Priorité » du bar le reste après un redémarrage, puis « Recalculer » l’abandonne', () => {
  const { Scheduler } = require('../scheduler');
  const { TableAccess } = require('../table-access');
  const { snapshotNight, restoreNight } = require('../night-state');
  const s = new Scheduler();
  const access = new TableAccess();
  const people = ['Alice', 'Bruno', 'Chloé'].map((name, i) => {
    access.issue(String(i + 1));
    const p = s.join({ tableId: String(i + 1), name, headcount: 1 });
    s.chooseSong(p, { songId: 900 + i, title: `Titre ${name}` });
    return p;
  });
  s.staffMove(people[2].id, 0);
  assert.equal(s.reservedNext?.byStaff, true);
  const settings = { auto: true, autoPlay: true, pushDelaySec: 45, playDelaySec: 8 };
  const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings })));
  const restored = new Scheduler();
  restoreNight(snapshot, { scheduler: restored, access: new TableAccess(), settings: {} });
  assert.equal(restored.reservedNext?.personId, people[2].id);
  assert.equal(restored.reservedNext?.byStaff, true, 'la priorité reste celle du bar');
  restored.forceReplan();
  assert.equal(restored.reservedNext, null);
  assert.ok(restored.log.some(line => /déplacements manuels sont abandonnés/.test(line.msg)), 'le bar sait que la priorité est abandonnée');
  snapshot.scheduler.reservedNext.byStaff = 'oui';
  const loose = new Scheduler();
  restoreNight(snapshot, { scheduler: loose, access: new TableAccess(), settings: {} });
  assert.equal(loose.reservedNext?.byStaff, undefined, 'valeur non booléenne ignorée');
});

test('« Recalculer » quand seule une « Priorité » reste active : le bar sait qu’elle est abandonnée', () => {
  const { Scheduler } = require('../scheduler');
  const s = new Scheduler();
  const people = ['Alice', 'Bruno', 'Chloé'].map((name, i) => {
    const p = s.join({ tableId: String(i + 1), name, headcount: 1 });
    s.chooseSong(p, { songId: 900 + i, title: `Titre ${name}` });
    return p;
  });
  s.staffMove(people[2].id, 0);
  // Une nouvelle table efface l'ordre manuel, pas la priorité.
  s.chooseSong(s.join({ tableId: '4', name: 'Dan', headcount: 1 }), { songId: 950, title: 'Titre Dan' });
  s.presenceView();
  assert.equal(s.manualOrderActive, false);
  assert.notEqual(s.solverPlan?.source, 'manual');
  assert.equal(s.reservedNext?.byStaff, true);
  s.forceReplan();
  assert.equal(s.reservedNext, null);
  assert.match(s.log.at(-1).msg, /déplacements manuels sont abandonnés/);
});
