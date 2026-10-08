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

test('durée : le catalogue relayé par le serveur passe avant celle envoyée par le téléphone', () => {
  const f = harness();
  f.rememberBattleSongs([{ songId: 101, title: 'Titre 101', artist: 'Artiste', duration: 237 },
    { songId: 102, title: 'Sans durée', artist: 'Artiste', duration: 'longue' }]);
  const { item } = f.ours(1, 101, 99999);
  f.play(item);
  assert.equal(f.progress().durationSec, 237);
  // Une nouvelle réponse du catalogue sans durée oublie l'ancienne.
  f.rememberBattleSongs([{ songId: 101, title: 'Titre 101', artist: 'Artiste' }]);
  assert.equal(f.progress().durationSec, 1200);
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
