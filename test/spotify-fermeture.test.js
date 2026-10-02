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

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const context = { require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console, Buffer, URL, setTimeout, setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, tracked, settings, handlers, spotify, spotifyAutomation, spotifyTick, sync, analyze,
      karaokeOutlook, playKaraFun, staffState,
      setBridge: b => { bridge = b; }, getPending: () => pending };
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
  await wait(1300);
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
  assert.equal(f.sched.log.filter(line => /Fermeture/.test(line.msg) && /plus de nouveau titre/.test(line.msg)).length, 1);
  f.sync();
  assert.equal(f.sched.log.filter(line => /Fermeture/.test(line.msg) && /plus de nouveau titre/.test(line.msg)).length, 1, 'annoncé une fois');
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
  await f.spotifyTick();
  assert.deepEqual(calls.map(c => c[0]), ['spotify-play'], 'Spotify reprend à la fermeture');
  // Le bar peut toujours lancer le titre lui-même.
  await f.handlers['POST /api/staff/kf'](null, null, { action: 'play' });
  assert.equal(kf.filter(c => c[0] === 'karafun-play').length, 1);
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
