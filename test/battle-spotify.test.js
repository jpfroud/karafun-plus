'use strict';
// Spotify pendant l'attente de la Battle (demande du gérant du 26 octobre
// 2026) : « La battle arrive dans KaraFun dès que la chanson qui précède la
// battle se termine. Et dès qu'on lance la battle manuellement depuis
// l'interface de l'application, il faut couper Spotify. Et le relancer de
// nouveau en attendant qu'on relance le prochain titre de manière manuelle
// aussi. » Ces reprises ne suspendent pas la lecture automatique et
// respectent un choix du bar. Serveur chargé en mémoire (--demo), faux
// KaraFun (file et état de lecture) et faux Spotify : aucun réseau.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { SpotifyAutomation } = require('../spotify');
const { BATTLE_MOD } = require('../karafun');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

// Même harnais que spotify-fermeture.test.js, avec le vote Battle exposé.
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
    globalThis.fixture = { sched, tracked, settings, handlers, spotify, spotifyAutomation, spotifyTick, sync,
      karaokeOutlook, battleVote, setBridge: b => { bridge = b; } };
  `, context, { filename: 'server.js' });
  context.fixture.settings.auto = false;
  context.fixture.settings.autoPlay = true;
  return context.fixture;
}

const json = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => null },
  json: async () => body, text: async () => JSON.stringify(body) });

// Faux Spotify : relance (« spotify-play ») et pause (« spotify-pause »)
// notées dans `order`, avec les commandes du faux KaraFun.
function fakeSpotify(f, order, options = {}) {
  const state = { playing: false };
  f.spotify.fetchImpl = async (url, request = {}) => {
    if (url.endsWith('/api/token')) return json({ access_token: 't', expires_in: 3600 });
    if (url.endsWith('/me/player')) return json({ is_playing: state.playing, device: { id: 'pc', name: 'PC' } });
    if (url.endsWith('/me/player/devices')) return json({ devices: [{ id: 'pc', name: 'PC', is_active: true }] });
    if (url.includes('/me/player/play')) { order.push('spotify-play'); state.playing = true; return { ok: true, status: 204, text: async () => '' }; }
    if (url.includes('/me/player/pause')) { order.push('spotify-pause'); state.playing = false; return { ok: true, status: 204, text: async () => '' }; }
    throw new Error(`inattendu : ${url} ${request.method || ''}`);
  };
  f.spotify.config = { ...f.spotify.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'r',
    autoResume: true, autoPause: true, resumeDelaySec: 3, pauseLeadSec: 0, ...options };
  return state;
}

// Faux KaraFun : sa file, et le titre en lecture (queueId) ou rien.
function fakeBridge(order, queue, playing = null) {
  return { ready: true, connected: true, queue, events: [], permissions: {}, protocol: 'kcs', raw: {},
    snapshot: () => ({ ready: true, connected: true, queue, events: [] }),
    status: playing == null ? { state: 'idle' } : { state: 'playing', songPlaying: { queueId: playing } },
    battleModForSong: () => BATTLE_MOD, addBattle: () => order.push('karafun-add-battle'),
    add: songId => order.push(`karafun-add-${songId}`), remove: id => order.push(`karafun-remove-${id}`),
    next: () => order.push('karafun-next'), play: () => order.push('karafun-play') };
}
const BATTLE_SONG = { songId: 900, title: 'Tube collectif', artist: 'Groupe' };
const battleItem = (queueId = 50) => ({ queueId, ...BATTLE_SONG, singer: '', options: { mod: BATTLE_MOD } });
const plainItem = (queueId, songId = 700) => ({ queueId, songId, title: `Titre ${songId}`, singer: 'KaraFun' });

// Passages de l'automate : un toutes les 3 s, comme au bar (spotifyTick).
async function ticks(f, clock, count) {
  for (let i = 0; i < count; i++) { clock.now += 3000; await f.spotifyTick(); }
}
function setup({ logs = null, spotify = {} } = {}) {
  const f = harness({ logs });
  const clock = { now: Date.now() };
  f.spotifyAutomation.now = () => clock.now;
  const order = [];
  const player = fakeSpotify(f, order, spotify);
  return { f, clock, order, player };
}
// Titre d'Alice suivi par la file, chargé dans KaraFun derrière la Battle.
function aliceLoaded(f, queueId = 60) {
  const alice = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  f.sched.chooseSong(alice, { songId: 801, title: 'Titre Alice' });
  const sel = f.sched.select(); f.sched.commit(sel);
  f.tracked.push({ queueId, sel, startedAt: null, addedAt: Date.now() });
  return { queueId, songId: sel.song.songId, singer: sel.label };
}

// ---------------------------------------------------------------- automate seul
test('automate Spotify : l’attente de la Battle relance comme un silence, une seule fois, et un geste du bar reste respecté', () => {
  let now = 0;
  const automation = new SpotifyAutomation({ now: () => now });
  const config = { autoResume: true, autoPause: true, resumeDelaySec: 3 };
  assert.equal(automation.step('singing', config), 'pause');
  automation.settle(true);
  assert.equal(automation.step('battle', config), null, 'pas avant le délai de relance');
  now += 3000;
  assert.equal(automation.step('battle', config), 'resume', 'Battle prête, rien sur scène : relance après 3 s');
  automation.settle(true);
  now += 600000;
  assert.equal(automation.step('battle', config), null, 'une seule action par attente');
  assert.equal(automation.step('between', config), null, 'jamais entre deux chansons');
  now += 600000;
  assert.equal(automation.step('between', config), null);

  // Geste du bar juste après la fin d'un titre, avant que l'automate ait vu
  // l'attente : il vaut pour l'attente qui commence, pas pour le titre fini.
  assert.equal(automation.step('singing', config), 'pause');
  automation.settle(true);
  automation.handled('battle');
  now += 60000;
  assert.equal(automation.step('battle', config), null, 'Spotify coupé par le bar : pas relancé');
  assert.equal(automation.step('singing', config), 'pause', 'le titre suivant repart de zéro');

  const off = new SpotifyAutomation({ now: () => now });
  const noResume = { ...config, autoResume: false };
  off.step('battle', noResume);
  now += 60000;
  assert.equal(off.step('battle', noResume), null, 'relance automatique coupée : rien');
});

// ---------------------------------------------------------------- serveur
test('Battle suivie par la file : Spotify reprend après le titre d’avant, « Lecture » de la Battle le coupe avant KaraFun, puis reprend après la Battle jusqu’au titre suivant', async () => {
  const logs = [];
  const { f, clock, order, player } = setup({ logs });
  const alice = aliceLoaded(f);
  f.battleVote.staffLaunch({ song: BATTLE_SONG });
  // Le titre d'avant chante ; la Battle est arrivée derrière lui dans KaraFun.
  f.setBridge(fakeBridge(order, [plainItem(40), battleItem(), alice], 40));
  f.sync();
  assert.equal(f.battleVote.automation.status, 'queued', 'Battle reconnue dans KaraFun');
  assert.equal(f.karaokeOutlook(), 'singing');
  await ticks(f, clock, 3);
  assert.deepEqual(order, [], 'pendant le titre d’avant : rien');

  // ---- Critère 1 : titre fini, Battle en tête → relance après 3 s.
  f.setBridge(fakeBridge(order, [battleItem(), alice]));
  f.sync();
  assert.equal(f.karaokeOutlook(), 'battle');
  await f.spotifyTick();
  assert.deepEqual(order, [], 'pas avant le délai');
  await ticks(f, clock, 1);
  assert.deepEqual(order, ['spotify-play'], 'Spotify reprend pendant l’attente de la Battle');
  assert.equal(f.settings.autoPlay, true, 'lecture automatique gardée');
  assert.equal(f.settings.autoPlayHeld, false);
  assert.ok(!f.sched.log.some(line => /lecture automatique suspendue/i.test(line.msg)), 'pas d’avis de suspension');
  assert.ok(logs.some(line => /Spotify relancé : la Battle attend le bar\./.test(line)), logs.join('\n'));
  await ticks(f, clock, 5);
  assert.deepEqual(order, ['spotify-play'], 'une seule relance');
  assert.ok(!order.includes('karafun-play'), 'la lecture automatique ne lance pas la Battle');

  // ---- Critère 2 : « Lecture » du bar sur la Battle → pause avant bridge.play().
  await f.handlers['POST /api/staff/kf'](null, null, { action: 'play' });
  assert.deepEqual(order, ['spotify-play', 'spotify-pause', 'karafun-play']);
  assert.equal(player.playing, false);
  // KaraFun met quelques secondes à annoncer la Battle : Spotify ne repart pas.
  await ticks(f, clock, 3);
  assert.deepEqual(order, ['spotify-play', 'spotify-pause', 'karafun-play'], 'aucune relance pendant le lancement');
  f.setBridge(fakeBridge(order, [battleItem(), alice], 50));
  f.sync();
  assert.equal(f.battleVote.automation.status, 'playing');
  assert.equal(f.karaokeOutlook(), 'singing');
  await ticks(f, clock, 3);
  assert.deepEqual(order, ['spotify-play', 'spotify-pause', 'karafun-play'], 'Spotify déjà coupé : rien de plus');

  // ---- Critère 3 : Battle finie (« after ») → relance ; « Lecture » du titre suivant → pause.
  f.setBridge(fakeBridge(order, [alice]));
  f.sync();
  assert.equal(f.battleVote.automation.status, 'after');
  assert.equal(f.karaokeOutlook(), 'battle', 'le titre suivant attend le bar');
  await ticks(f, clock, 4);
  assert.deepEqual(order.slice(3), ['spotify-play'], 'Spotify reprend après la Battle');
  assert.equal(f.settings.autoPlay, true, 'lecture automatique gardée');
  assert.equal(f.settings.autoPlayHeld, false);
  assert.ok(!order.slice(3).includes('karafun-play'), 'le titre suivant attend toujours le bar');
  // Deux appuis rapprochés : un seul lancement, sans erreur (chacun a pu
  // demander la pause, sans effet de plus).
  const taps = await Promise.all([f.handlers['POST /api/staff/kf'](null, null, { action: 'play' }),
    f.handlers['POST /api/staff/kf'](null, null, { action: 'play' })]);
  assert.deepEqual(taps.map(answer => answer.ok), [true, true]);
  assert.equal(f.battleVote.automation.status, 'resuming');
  const resumed = order.slice(3);
  assert.equal(resumed.filter(step => step === 'karafun-play').length, 1, 'un seul lancement');
  assert.ok(resumed.indexOf('spotify-pause') > 0 && resumed.indexOf('spotify-pause') < resumed.indexOf('karafun-play'),
    `Spotify coupé avant le titre suivant : ${resumed.join(', ')}`);
  assert.equal(resumed.at(-1), 'karafun-play');
  assert.equal(player.playing, false);
  await ticks(f, clock, 3);
  assert.deepEqual(order.slice(3), resumed, 'pas de relance pendant que KaraFun démarre');
  f.setBridge(fakeBridge(order, [alice], alice.queueId));
  f.sync();
  assert.equal(f.battleVote.automation.status, 'released', 'la file reprend');
  assert.equal(f.settings.autoPlay, true);
});

test('Battle ajoutée et lancée dans KaraFun : relance pendant l’attente, pause automatique au lancement, relance après, pause au titre suivant lancé dans KaraFun', async () => {
  const { f, clock, order } = setup();
  f.setBridge(fakeBridge(order, [battleItem(77)]));
  f.sync();
  assert.equal(f.battleVote.automation.status, 'queued', 'Battle de KaraFun reconnue');
  assert.equal(f.karaokeOutlook(), 'battle');
  await ticks(f, clock, 2);
  assert.deepEqual(order, ['spotify-play']);
  // Lancée depuis KaraFun : la pause d'un titre qui démarre la coupe.
  f.setBridge(fakeBridge(order, [battleItem(77)], 77));
  f.sync();
  await f.spotifyTick();
  assert.deepEqual(order, ['spotify-play', 'spotify-pause']);
  // Finie : Spotify reprend jusqu'au titre suivant.
  f.setBridge(fakeBridge(order, [plainItem(78)]));
  f.sync();
  assert.equal(f.battleVote.automation.status, 'after');
  await ticks(f, clock, 2);
  assert.deepEqual(order, ['spotify-play', 'spotify-pause', 'spotify-play']);
  // Le bar lance le titre suivant dans KaraFun : la file reprend, Spotify se coupe.
  f.setBridge(fakeBridge(order, [plainItem(78)], 78));
  f.sync();
  assert.equal(f.battleVote.automation.status, 'released');
  await f.spotifyTick();
  assert.deepEqual(order, ['spotify-play', 'spotify-pause', 'spotify-play', 'spotify-pause']);
  assert.equal(f.settings.autoPlay, true, 'jamais suspendue par la Battle');
  assert.equal(f.settings.autoPlayHeld, false);
});

test('attente de la Battle : Spotify coupé par le bar juste après le titre d’avant, ou relance automatique coupée, reste coupé', async () => {
  const { f, clock, order } = setup();
  f.setBridge(fakeBridge(order, [plainItem(40), battleItem()], 40));
  f.sync();
  await f.spotifyTick();
  assert.equal(f.spotifyAutomation.phase, 'singing');
  // Titre fini : le bar coupe Spotify avant le passage suivant de l'automate.
  f.setBridge(fakeBridge(order, [battleItem()]));
  f.sync();
  await f.handlers['POST /api/staff/spotify'](null, null, { action: 'pause' });
  await ticks(f, clock, 5);
  assert.deepEqual(order, [], 'choix du bar respecté pendant toute l’attente');

  const other = setup({ spotify: { autoResume: false } });
  other.f.setBridge(fakeBridge(other.order, [battleItem()]));
  other.f.sync();
  await ticks(other.f, other.clock, 5);
  assert.deepEqual(other.order, [], 'relance automatique coupée : rien pendant la Battle');
});

test('« Lecture » de la Battle dès la fin du titre d’avant : Spotify ne repart pas pendant que KaraFun la démarre', async () => {
  const { f, clock, order } = setup();
  f.battleVote.staffLaunch({ song: BATTLE_SONG });
  f.setBridge(fakeBridge(order, [plainItem(40), battleItem()], 40));
  f.sync();
  await f.spotifyTick();
  f.setBridge(fakeBridge(order, [battleItem()]));
  f.sync();
  await f.handlers['POST /api/staff/kf'](null, null, { action: 'play' });
  assert.deepEqual(order, ['karafun-play'], 'Spotify ne jouait pas : rien à couper');
  // KaraFun n'annonce la Battle qu'au bout de 9 s : toujours rien sur scène.
  await ticks(f, clock, 3);
  assert.deepEqual(order, ['karafun-play'], 'pas de relance par-dessus le lancement');
  f.setBridge(fakeBridge(order, [battleItem()], 50));
  f.sync();
  assert.equal(f.battleVote.automation.status, 'playing');
});

test('hors Battle : file vide, Spotify reprend et la lecture automatique attend toujours le bar', async () => {
  const { f, clock, order } = setup();
  f.setBridge(fakeBridge(order, []));
  assert.equal(f.karaokeOutlook(), 'silent');
  await ticks(f, clock, 2);
  assert.deepEqual(order, ['spotify-play']);
  assert.equal(f.settings.autoPlayHeld, true, 'comportement de fin de file inchangé');
  // Un titre ordinaire en tête : « between », jamais de relance.
  const next = setup();
  next.f.setBridge(fakeBridge(next.order, [plainItem(41)]));
  assert.equal(next.f.karaokeOutlook(), 'between');
  await ticks(next.f, next.clock, 5);
  assert.deepEqual(next.order, []);
});
