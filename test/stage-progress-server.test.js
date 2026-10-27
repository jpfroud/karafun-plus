'use strict';
// Barre de lecture du titre sur scène (lot F), côté serveur : server.js tourne
// dans un bac à sable `vm` avec une horloge simulée et un faux pont KaraFun
// (aucun port, aucun KaraFun). publicState().stage.progress et staffState().
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { BATTLE_MOD } = require('../karafun');
const { snapshotNight, restoreNight } = require('../night-state');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));
const T0 = 1_800_000_000_000;
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// `persistent` : serveur sans --demo, faux magasin de soirée (sauvegardes gardées en mémoire).
function harness({ persistent = false } = {}) {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const clock = { now: T0 };
  const FakeDate = class extends Date { static now() { return clock.now; } };
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
  const context = { require: name => name === 'fs' ? quietFs : overrides[name] || fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL, Date: FakeDate,
    setTimeout: () => ({ unref() {} }), clearTimeout() {}, setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, access, settings, handlers, sync, staffState, publicState, rememberBattleSongs, saveNight,
      closingBlocksStart, clearEvening,
      tracked: () => tracked, setBridge: b => { bridge = b; },
      stageClock: () => stageClock, setStageClock: c => { stageClock = c; } };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  f.sched.table('1').headcount = 8;
  f.access.issue('1');
  const bridge = {
    ready: true, connected: true, queue: [], status: { state: 'idle' }, adds: [],
    add(songId, singer) { this.adds.push({ songId, singer }); return null; },
    play() {}, next() {}, remove() {}, snapshot() { return {}; },
  };
  f.setBridge(bridge);
  return Object.assign(f, { clock, bridge, saves,
    at(seconds) { clock.now = T0 + seconds * 1000; },
    progress() { return plain(f.publicState()?.stage?.progress); },
    // Nos chansons : choisie sur un téléphone, envoyée et suivie sous `queueId`.
    ours(queueId, songId, duration = null) {
      const p = f.sched.join({ tableId: '1', name: `Chanteur ${queueId}` });
      f.sched.chooseSong(p, { songId, title: `Titre ${songId}`, artist: 'Artiste', duration });
      const sel = f.sched.select();
      f.sched.commit(sel);
      const tr = { queueId, sel, addedAt: clock.now, startedAt: null };
      f.tracked().push(tr);
      return { tr, item: { queueId, songId, title: `Titre ${songId}`, artist: 'Artiste', singer: sel.label } };
    },
    play(item, extra = {}) {
      bridge.queue = [item];
      bridge.status = { state: 'playing', songPlaying: item, pitch: 0, tempo: 0, ...extra };
      f.sync();
    },
  });
}

test('notre titre : le temps part de son début sur scène, durée du téléphone bornée (99999 → 1200 s)', () => {
  const f = harness();
  const { tr, item } = f.ours(1, 101, 99999);
  f.bridge.queue = [item];
  f.sync();
  assert.equal(f.progress(), undefined, 'titre en attente : pas de barre');
  f.at(5);
  f.play(item);
  assert.equal(tr.startedAt, T0 + 5000);
  assert.deepEqual(f.progress(), { elapsedSec: 0, durationSec: 1200, paused: false, rate: 1 });
  f.at(47);
  assert.deepEqual(f.progress(), { elapsedSec: 42, durationSec: 1200, paused: false, rate: 1 });
  assert.deepEqual(plain(f.staffState().stage.progress), f.progress(), 'la page du bar reçoit la même barre');
});

// Relecture finale, quatrième passe (K5) : le départ de notre titre est son
// début noté (`startedAt`, sauvegardé), pas l'instant où le serveur le voit :
// relancé d'une sauvegarde sans horloge, le titre ne repart pas de 0:00.
test('notre titre déjà commencé, sans horloge sauvegardée : le temps part de son début noté', () => {
  const f = harness();
  const { tr, item } = f.ours(1, 101, 200);
  tr.startedAt = T0;
  f.at(60);
  assert.equal(f.stageClock(), null, 'aucune horloge reprise');
  f.play(item);
  assert.equal(tr.startedAt, T0, 'début gardé');
  assert.deepEqual(f.progress(), { elapsedSec: 60, durationSec: 200, paused: false, rate: 1 });
});

test('durée : le catalogue relayé par le serveur passe avant celle envoyée par le téléphone', () => {
  const f = harness();
  f.rememberBattleSongs([{ songId: 101, title: 'Titre 101', artist: 'Artiste', duration: 237 },
    { songId: 102, title: 'Sans durée', artist: 'Artiste', duration: 'longue' }]);
  const { item } = f.ours(1, 101, 99999);
  f.play(item);
  assert.equal(f.progress().durationSec, 237);
  // Une nouvelle réponse du catalogue sans durée garde la durée fiable déjà
  // connue (relecture Codex de la PR #15 : l'oublier faisait sauter la durée
  // maximale des titres) ; une nouvelle durée fiable la remplace.
  f.rememberBattleSongs([{ songId: 101, title: 'Titre 101', artist: 'Artiste' }]);
  assert.equal(f.progress().durationSec, 237);
  f.rememberBattleSongs([{ songId: 101, title: 'Titre 101', artist: 'Artiste', duration: 241 }]);
  assert.equal(f.progress().durationSec, 241);
});

test('titre ajouté dans KaraFun : départ à son apparition sur scène, durée inconnue', () => {
  const f = harness();
  const native = { queueId: 9, songId: 555, title: 'Natif', artist: 'X', singer: 'Quelqu’un' };
  f.at(10);
  f.play(native);
  f.at(100);
  assert.deepEqual(f.progress(), { elapsedSec: 90, durationSec: null, paused: false, rate: 1 });
  // Un titre natif cherché dans le catalogue par le bar : sa durée est connue.
  f.rememberBattleSongs([{ songId: 555, title: 'Natif', artist: 'X', duration: 180 }]);
  assert.equal(f.progress().durationSec, 180);
});

test('pause puis reprise : la pause n’est pas comptée, la barre reste figée', () => {
  const f = harness();
  const { item } = f.ours(1, 101, 200);
  f.play(item);
  f.at(60);
  f.play(item, { state: 'paused' });
  f.at(150);
  assert.deepEqual(f.progress(), { elapsedSec: 60, durationSec: 200, paused: true, rate: 1 });
  f.at(180);
  f.play(item);
  f.at(190);
  assert.deepEqual(f.progress(), { elapsedSec: 70, durationSec: 200, paused: false, rate: 1 });
});

test('tempo +20 en direct : le reste du titre raccourcit', () => {
  const f = harness();
  const { item } = f.ours(1, 101, 240);
  f.play(item);
  f.at(50);
  f.play(item, { tempo: 20 });
  f.at(100);
  assert.deepEqual(f.progress(), { elapsedSec: 110, durationSec: 240, paused: false, rate: 1.2 });
});

test('« Relancer depuis le début » : la copie repart de zéro', async () => {
  const f = harness();
  const { tr, item } = f.ours('q-1', 101, 200);
  f.play(item);
  f.at(90);
  assert.equal(f.progress().elapsedSec, 90);
  await f.handlers['POST /api/staff/kf']({}, {}, { action: 'restart' });
  const copy = { ...item, queueId: 'q-2' };
  f.bridge.queue = [item, copy];
  f.sync();
  assert.equal(tr.queueId, 'q-2');
  f.at(92);
  f.play(copy);
  assert.equal(tr.startedAt, T0 + 92_000);
  assert.deepEqual(f.progress(), { elapsedSec: 0, durationSec: 200, paused: false, rate: 1 });
  f.at(100);
  assert.equal(f.progress().elapsedSec, 8);
});

test('Battle : temps écoulé seul, jamais de durée ni de fin', () => {
  const f = harness();
  f.rememberBattleSongs([{ songId: 5091, title: 'Battle', artist: 'X', duration: 200 }]);
  const battle = { queueId: 'b-1', songId: 5091, title: 'Battle', artist: 'X', singer: 'Battle collective', options: { mod: BATTLE_MOD } };
  f.play(battle);
  f.at(30);
  assert.equal(f.publicState().stage.kind, 'battle');
  assert.deepEqual(f.progress(), { elapsedSec: 30, durationSec: null, paused: false, rate: 1 });
});

test('position numérique envoyée par KaraFun : prise en priorité', () => {
  const f = harness();
  const native = { queueId: 9, songId: 555, title: 'Natif', artist: 'X', singer: 'Quelqu’un' };
  f.play(native, { position: 0 });
  f.at(25);
  f.play(native, { position: 20 });
  f.at(26);
  assert.equal(f.progress().elapsedSec, 21);
});

test('entre deux titres la barre disparaît ; KaraFun déconnecté puis revenu : le temps continue', () => {
  const f = harness();
  const native = { queueId: 9, songId: 555, title: 'Natif', artist: 'X', singer: 'Quelqu’un' };
  f.play(native);
  f.at(30);
  f.bridge.ready = false;
  f.sync();
  assert.equal(f.publicState().stage, null);
  f.at(40);
  f.bridge.ready = true;
  f.sync();
  assert.equal(f.progress().elapsedSec, 40, 'même titre au retour : pas de remise à zéro');
  f.bridge.status = { state: 'idle', songPlaying: native };
  f.sync();
  assert.equal(f.stageClock(), null, 'titre fini : horloge oubliée');
  assert.equal(f.publicState().stage, null);
  // Titre déjà sur scène mais pas encore vu par sync() : pas de barre inventée.
  f.bridge.status = { state: 'playing', songPlaying: native };
  assert.equal(f.progress(), null);
});

test('redémarrage : l’horloge est sauvegardée et un titre natif ne repart pas de zéro', () => {
  const f = harness({ persistent: true });
  const native = { queueId: 'n-1', songId: 555, title: 'Natif', artist: 'X', singer: 'Quelqu’un' };
  f.play(native);
  f.at(60);
  f.play(native, { state: 'paused' });
  f.saveNight();
  const saved = f.saves.at(-1);
  assert.deepEqual(saved.stageClock, { key: 'n-1', segAt: T0 + 60_000, mediaMs: 60_000, rate: 1, paused: true, position: null });
  // Reprise dans un nouveau serveur (main() restaure le résultat de restoreNight).
  const restored = restoreNight(saved, { scheduler: new Scheduler({ solverEnabled: false }), access: new TableAccess(), settings: {} });
  assert.deepEqual(restored.stageClock, saved.stageClock);
  const g = harness();
  g.setStageClock(restored.stageClock);
  g.at(300);
  g.play(native);
  g.at(310);
  assert.deepEqual(g.progress(), { elapsedSec: 70, durationSec: null, paused: false, rate: 1 },
    '60 s avant la pause, pause non comptée, 10 s après la reprise');
});

test('sauvegarde : horloge abîmée ou absente ignorée sans bloquer la soirée', () => {
  const scheduler = new Scheduler({ solverEnabled: false });
  const access = new TableAccess();
  const settings = { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 };
  const snapshot = plain(snapshotNight({ scheduler, access, settings, stageClock: { key: 'x', segAt: 'hier' } }));
  assert.equal(restoreNight(snapshot, { scheduler, access, settings: {} }).stageClock, null);
  delete snapshot.stageClock;
  assert.equal(restoreNight(snapshot, { scheduler, access, settings: {} }).stageClock, null, 'sauvegarde d’une version précédente');
});

// Regression: vérification de la relecture C5 — une durée envoyée par un
// téléphone avant la borne (30 à 1200 s) restait telle quelle dans la
// soirée sauvegardée : reprise après la mise à jour, elle repartait vers
// chaque téléphone (200 000 caractères). La reprise la borne aussi.
test('reprise d’une soirée sauvegardée avant la borne : durées des titres bornées', () => {
  const scheduler = new Scheduler({ solverEnabled: false });
  const access = new TableAccess();
  scheduler.table('1').headcount = 4;
  access.issue('1');
  const ana = scheduler.join({ tableId: '1', name: 'Ana' });
  const bob = scheduler.join({ tableId: '1', name: 'Bob' });
  // Titres gardés par une version d'avant la borne.
  scheduler.chooseSong(ana, { songId: 5, title: 'Énorme', artist: 'A', duration: 'x'.repeat(200000) });
  scheduler.chooseSong(ana, { songId: 6, title: 'Long', artist: 'A', duration: 99999 }, 'append');
  scheduler.chooseSong(bob, { songId: 7, title: 'Juste', artist: 'A', duration: 215 });
  const sel = scheduler.select();
  const settings = { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 };
  const snapshot = plain(snapshotNight({ scheduler, access, settings,
    tracked: [{ queueId: 'q1', sel: { ...sel, song: { ...sel.song, duration: 5 } }, addedAt: T0, startedAt: null }],
    pending: { sel: { ...sel, song: { ...sel.song, duration: 'y'.repeat(1000) } }, before: [], at: T0, attempts: 1 } }));
  const target = new Scheduler({ solverEnabled: false });
  const restored = restoreNight(snapshot, { scheduler: target, access: new TableAccess(), settings: {} });
  const people = [...target.people.values()];
  const a = people.find(p => p.name === 'Ana'), b = people.find(p => p.name === 'Bob');
  assert.deepEqual([a.song, ...a.backlog, b.song].map(song => song.duration).sort(), [1200, 215, null].sort());
  assert.equal(restored.tracked[0].sel.song.duration, 30);
  assert.equal(restored.pending.sel.song.duration, null);
});

// Retour du gérant après les soirées des 23 et 24 octobre : « ce calcul-là ne
// tient pas compte du temps entre deux chansons ». La durée moyenne mesurée
// va du début à la fin d'un titre ; le temps de lancer le suivant (9 s en
// médiane) n'était compté qu'après le titre en cours. Il est mesuré de la fin
// d'un titre au début du suivant, puis compté à chaque passage prévu.
function songsInKaraFun(f, count, firstQueueId = 1) {
  f.sched.table('1').headcount = 40;
  return [...Array(count)].map((_, i) => f.ours(firstQueueId + i, 300 + firstQueueId + i).item);
}
// Fin du titre sur scène : KaraFun garde `waiting` dans sa file, rien ne joue.
function endSong(f, waiting) {
  f.bridge.queue = [...waiting];
  f.bridge.status = { state: 'idle' };
  f.sync();
}
function playNext(f, item, waiting) {
  f.bridge.queue = [item, ...waiting];
  f.bridge.status = { state: 'playing', songPlaying: item, pitch: 0, tempo: 0 };
  f.sync();
}

test('fermeture : l’écart mesuré entre deux titres compte à chaque passage prévu', () => {
  const f = harness({ persistent: true });
  // Quatre titres de 200 s, 10 s entre deux : la file mesure les deux.
  const [a, b, c, d] = songsInKaraFun(f, 4);
  playNext(f, a, [b, c, d]);
  f.at(200); endSong(f, [b, c, d]);
  f.at(210); playNext(f, b, [c, d]);
  f.at(410); endSong(f, [c, d]);
  f.at(420); playNext(f, c, [d]);
  f.at(620); endSong(f, [d]);
  f.at(630); playNext(f, d, []);
  f.at(830); endSong(f, []);
  // Seize titres attendent, scène libre. Fermeture dans 52 min 10 s : sans
  // l'écart, la moitié du seizième finirait à 51 min 40 s ; avec, à 54 min 10 s.
  for (let i = 0; i < 16; i++) {
    const p = f.sched.join({ tableId: '1', name: `Client ${i + 1}` });
    f.sched.chooseSong(p, { songId: 500 + i, title: `Titre ${i + 1}`, artist: 'Artiste' });
  }
  const now = T0 + 830000;
  f.settings.closingAt = now + 3130000;
  const state = f.staffState();
  assert.equal(state.queue.length, 16);
  assert.deepEqual(state.queue.map(row => (row.eta - now) / 1000), [...Array(16)].map((_, i) => i * 210),
    'heures estimées : 200 s de titre et 10 s d’écart par passage');
  assert.deepEqual(state.queue.map(row => row.afterClosing), [...Array(15).fill(false), true],
    'le seizième titre est marqué « Après la fermeture »');
  assert.equal(state.closing.fitCount, 15);
  assert.equal(state.closing.afterCount, 1);
  const phone = f.publicState(f.sched.people.get(state.queue[15].ids[0]), '1');
  assert.equal(phone.queue[15].afterClosing, true, 'le téléphone voit le même repère');
  assert.equal(f.closingBlocksStart(null, 14), false);
  assert.equal(f.closingBlocksStart(null, 15), true, 'le seizième titre ne partira pas vers KaraFun');
  assert.deepEqual(f.sched.slotSamples, [200, 200, 200, 200], 'durée d’un titre : sans l’écart');
  assert.deepEqual(f.sched.songGapSamples, [10, 10, 10]);
  assert.equal(state.songGapSec, 10);
  assert.equal(state.songGapMeasured, true);
  // Sans écart entre deux titres, les seize tiendraient : c'est l'écart qui recule le repère.
  f.sched.songGapSamples = [0, 0, 0];
  assert.equal(f.staffState().closing.fitCount, 16);
  assert.equal(f.closingBlocksStart(null, 15), false);
});

test('écart entre deux titres : mesuré seulement quand un titre attendait, sans Battle, coupure ni pause', () => {
  const f = harness({ persistent: true });
  assert.equal(f.staffState().songGapMeasured, false, 'valeur par défaut avant mesure');
  const [a, b, c, d] = songsInKaraFun(f, 4);
  playNext(f, a, [b, c, d]);
  f.at(200); endSong(f, [b, c, d]);
  f.at(208); playNext(f, b, [c, d]);
  f.at(408); endSong(f, [c, d]);
  f.at(417); playNext(f, c, [d]);
  f.at(617); endSong(f, [d]);
  f.at(647); playNext(f, d, []);
  assert.deepEqual(f.sched.songGapSamples, [8, 9, 30]);
  assert.equal(f.sched.songGapSec(), 9, 'médiane');
  // File vide à la fin du titre : le bar lance un titre 20 s plus tard.
  f.at(847); endSong(f, []);
  const native = { queueId: 'n-1', songId: 555, title: 'Natif', artist: 'X', singer: 'Quelqu’un' };
  f.at(867); playNext(f, native, []);
  // Plus d'une minute avant le titre suivant (pause du bar).
  const [e] = songsInKaraFun(f, 1, 10);
  f.at(1067); endSong(f, [e]);
  f.at(1157); playNext(f, e, []);
  // KaraFun déconnecté entre deux titres.
  const [g] = songsInKaraFun(f, 1, 11);
  f.at(1357); endSong(f, [g]);
  f.at(1360); f.bridge.ready = false; f.sync();
  f.at(1365); f.bridge.ready = true; f.sync();
  f.at(1370); playNext(f, g, []);
  // Battle avant et après.
  const battle = { queueId: 'b-1', songId: 5091, title: 'Battle', artist: 'X', singer: 'Battle collective', options: { mod: BATTLE_MOD } };
  f.at(1570); endSong(f, [battle]);
  f.at(1575); playNext(f, battle, []);
  const [h] = songsInKaraFun(f, 1, 12);
  f.at(1775); endSong(f, [h]);
  f.at(1785); playNext(f, h, []);
  assert.deepEqual(f.sched.songGapSamples, [8, 9, 30], 'aucun de ces écarts n’est gardé');
  // De nouveau un écart ordinaire.
  const [k] = songsInKaraFun(f, 1, 13);
  f.at(1985); endSong(f, [k]);
  f.at(1995); playNext(f, k, []);
  assert.deepEqual(f.sched.songGapSamples, [8, 9, 30, 10]);
  assert.equal(f.staffState().songGapSec, 10, 'médiane de 9 et 10 arrondie pour le bar');
  assert.deepEqual(f.saves.at(-1).scheduler.songGapSamples, [8, 9, 30, 10], 'gardés dans la sauvegarde de soirée');
  // « Nouvelle soirée » : rien de la soirée précédente ne reste.
  f.clearEvening();
  assert.deepEqual(plain(f.sched.songGapSamples), []);
  assert.deepEqual(plain(f.sched.slotSamples), []);
});

// Relecture : le commentaire de measureSongGap et le nom de la liste
// (SONG_GAP_BLOCKERS) disaient l'inverse de son rôle. Elle ne contient que
// les causes d'une scène libre qui laissent mesurer l'écart ; y ajouter une
// cause qui l'écarte (« auto-off », envoi coupé par le bar) compterait des
// minutes de scène libre dans l'écart, et dans toutes les heures estimées.
test('écart entre deux titres : la liste des causes nomme celles qui laissent mesurer l’écart', () => {
  const found = /const SONG_GAP_KEEPERS = new Set\(\[([^\]]*)\]\);/.exec(source);
  assert.ok(found, 'SONG_GAP_KEEPERS introuvable dans server.js');
  const causes = found[1].split(',').map(text => text.trim().replace(/'/g, ''));
  assert.deepEqual(causes, ['loading', 'awaiting-presence', 'sending', 'push-delay', 'autoplay-off']);
  for (const dropped of ['empty', 'closing', 'battle-hold', 'queue-clear', 'restart', 'auto-off', 'autoplay-held',
    'recovered-pending', 'permission']) assert.ok(!causes.includes(dropped), `${dropped} écarte la mesure`);
  assert.doesNotMatch(source, /SONG_GAP_BLOCKERS/, 'plus d’ancien nom ni de renvoi vers lui');
});

test('sauvegarde : écarts entre deux titres repris, bornés, absents d’une version précédente', () => {
  const scheduler = new Scheduler({ solverEnabled: false });
  const access = new TableAccess();
  const settings = { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 };
  for (const seconds of [8, 9, 30]) scheduler.recordSongGap(seconds);
  const snapshot = plain(snapshotNight({ scheduler, access, settings }));
  assert.deepEqual(snapshot.scheduler.songGapSamples, [8, 9, 30]);
  const target = new Scheduler({ solverEnabled: false });
  restoreNight(snapshot, { scheduler: target, access: new TableAccess(), settings: {} });
  assert.deepEqual(target.songGapSamples, [8, 9, 30]);
  assert.equal(target.songGapSec(), 9);
  snapshot.scheduler.songGapSamples = [12, -5, 600, 'x', null, ...Array(25).fill(11)];
  restoreNight(snapshot, { scheduler: target, access: new TableAccess(), settings: {} });
  assert.deepEqual(target.songGapSamples, Array(20).fill(11), 'mêmes bornes et même nombre qu’en direct');
  delete snapshot.scheduler.songGapSamples;
  restoreNight(snapshot, { scheduler: target, access: new TableAccess(), settings: {} });
  assert.deepEqual(target.songGapSamples, [], 'sauvegarde d’une version précédente');
  assert.equal(target.songGapSec(), 10, 'valeur par défaut');
});
