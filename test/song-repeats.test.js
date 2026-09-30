'use strict';

// Titres en double : détection, historique des titres lancés dans KaraFun,
// alerte de la personne qui ajoute et repères de la page du bar.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { sameSong, songNotice, queueRepeats, lastPlay } = require('../song-repeats');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');

const MIN = 60000;

test('même chanson : identifiant, ou titre et artiste à la casse, aux accents et aux versions près', () => {
  assert.ok(sameSong({ songId: 7, title: 'A' }, { songId: 7, title: 'B' }));
  assert.ok(sameSong({ songId: 1, title: 'Bohemian Rhapsody', artist: 'Queen' },
    { songId: 2, title: 'bohemian rhapsody (Live)', artist: 'QUEEN' }));
  assert.ok(sameSong({ title: 'Déjà vu', artist: 'Céline' }, { title: 'Deja Vu [Karaoké]', artist: 'celine' }));
  assert.ok(sameSong({ title: 'Hallelujah', artist: '' }, { title: 'Hallelujah', artist: 'Jeff Buckley' }),
    'un artiste absent ne distingue pas deux titres identiques');
  assert.equal(sameSong({ songId: 1, title: 'Hallelujah', artist: 'Leonard Cohen' },
    { songId: 2, title: 'Hallelujah', artist: 'Jeff Buckley' }), false, 'deux reprises restent distinctes');
  assert.equal(sameSong({ songId: 1, title: 'Titre' }, null), false);
});

test('titre récent : seulement dans la fenêtre réglée, 0 coupe l’alerte', () => {
  const now = 10 * 60 * MIN;
  const played = [{ at: now - 50 * MIN, songId: 5, title: 'X' }, { at: now - 20 * MIN, songId: 5, title: 'X' }];
  assert.equal(lastPlay(played, { songId: 5, title: 'X' }, now, 45 * MIN).at, now - 20 * MIN);
  assert.equal(lastPlay(played, { songId: 5, title: 'X' }, now, 15 * MIN), null);
  assert.equal(lastPlay(played, { songId: 5, title: 'X' }, now, 0), null);
  const notice = songNotice({ song: { songId: 5, title: 'X' }, played, now, windowMs: 45 * MIN });
  assert.equal(notice.minutesAgo, 20);
  assert.deepEqual(notice.queued, []);
});

test('titre déjà dans la file : l’alerte dit si l’autre passage est avant le nouveau', () => {
  const queue = [
    { pos: 1, name: 'Léa', song: { entryId: 'e1', songId: 9, title: 'Y' }, eta: 1 },
    { pos: 2, name: 'Tom', song: { entryId: 'e2', songId: 3, title: 'Z' } },
    { pos: 3, name: 'Moi', song: { entryId: 'e3', songId: 9, title: 'Y' } },
    { pos: 4, name: 'Zoé', song: { entryId: 'e4', songId: 9, title: 'Y' } },
  ];
  const notice = songNotice({ song: queue[2].song, entryId: 'e3', queue });
  assert.equal(notice.position, 3);
  assert.deepEqual(notice.queued.map(item => [item.pos, item.before, item.name]), [[1, true, 'Léa'], [4, false, 'Zoé']]);
  assert.equal(songNotice({ song: queue[1].song, entryId: 'e2', queue }), null, 'titre unique : pas d’alerte');
  const before = songNotice({ song: { songId: 9, title: 'Y' }, queue });
  assert.deepEqual(before.queued.map(item => item.before), [null, null, null], 'avant l’ajout, la place du nouveau titre est inconnue');

  const marks = queueRepeats(queue, [{ at: 0, songId: 3, title: 'Z' }], 10 * MIN, 45 * MIN);
  assert.deepEqual(marks[0], { earlier: [], later: [3, 4], playedAt: null });
  assert.deepEqual(marks[1], { earlier: [], later: [], playedAt: 0 });
  assert.deepEqual(marks[2].earlier, [1]);
  assert.deepEqual(marks[3].earlier, [1, 3]);
});

test('historique des titres lancés : un queueId compte une fois, limite de taille, sauvegarde et reprise', () => {
  const s = new Scheduler({});
  s.recordPlayed({ queueId: 1, songId: 4, title: 'Un', artist: 'A' }, 1000);
  assert.equal(s.recordPlayed({ queueId: 1, songId: 4, title: 'Un', artist: 'A' }, 2000), null,
    'même titre en cours après un redémarrage ou une pause : pas de doublon');
  s.recordPlayed({ queueId: 2, songId: 0, title: 'Hors file' }, 3000);
  assert.equal(s.recordPlayed({ queueId: 3, title: '' }), null);
  assert.deepEqual(s.playedSongs.map(item => [item.queueId, item.songId, item.title]), [['1', 4, 'Un'], ['2', null, 'Hors file']]);
  for (let i = 0; i < 260; i++) s.recordPlayed({ queueId: 100 + i, songId: 1 + i, title: `T${i}` }, 4000 + i);
  assert.equal(s.playedSongs.length, 200);

  const access = new TableAccess();
  const settings = { auto: false, autoPlay: false, pushDelaySec: 45, playDelaySec: 8, repeatWarnMin: 30 };
  const snapshot = snapshotNight({ scheduler: s, access, settings });
  const target = new Scheduler({}), targetSettings = { repeatWarnMin: 45 };
  restoreNight(snapshot, { scheduler: target, access: new TableAccess(), settings: targetSettings });
  assert.deepEqual(target.playedSongs, s.playedSongs);
  assert.equal(targetSettings.repeatWarnMin, 30);

  const legacy = JSON.parse(JSON.stringify(snapshot));
  delete legacy.scheduler.playedSongs;
  delete legacy.settings.repeatWarnMin;
  const oldSettings = { repeatWarnMin: 45 };
  const old = new Scheduler({});
  restoreNight(legacy, { scheduler: old, access: new TableAccess(), settings: oldSettings });
  assert.deepEqual(old.playedSongs, [], 'ancienne sauvegarde : historique vide');
  assert.equal(oldSettings.repeatWarnMin, 45, 'ancienne sauvegarde : réglage par défaut conservé');
  const broken = JSON.parse(JSON.stringify(snapshot));
  broken.settings.repeatWarnMin = 999;
  assert.throws(() => restoreNight(broken, { scheduler: new Scheduler({}), access: new TableAccess(), settings: {} }),
    /réglages mal formés/);
});

// Serveur réel dans un contexte isolé, avec un faux pont KaraFun.
function harness() {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const fromServer = createRequire(path.join(root, 'server.js'));
  const context = {
    require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console, Buffer, URL, setTimeout, setImmediate,
  };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, sync, settings, staffState, repeatNotice,
      setBridge(value) { bridge = value; } };
  `, context, { filename: 'server.js' });
  const bridge = { ready: true, connected: true, queue: [], status: { state: 'idle' },
    add() {}, play() {}, next() {}, remove() {}, snapshot() { return null; } };
  context.fixture.setBridge(bridge);
  context.fixture.settings.auto = false;
  context.fixture.settings.autoPlay = false;
  return { ...context.fixture, bridge };
}

test('un titre lancé dans KaraFun, même ajouté hors de la file, déclenche l’alerte et le repère du bar', () => {
  const f = harness();
  const [lea, tom] = ['Léa', 'Tom'].map((name, i) => f.sched.join({ tableId: String(i + 1), name, headcount: 2 }));
  // Titre ajouté directement dans KaraFun, puis joué.
  const native = { queueId: 'natif-1', songId: 77, title: 'Tourner dans le vide', artist: 'Indila', singer: 'Bar' };
  f.bridge.queue = [native];
  f.bridge.status = { state: 'playing', current: { queueId: 'natif-1' } };
  f.sync();
  f.sync();
  assert.equal(f.sched.playedSongs.length, 1, 'le même titre en cours n’est compté qu’une fois');
  assert.equal(f.sched.playedSongs[0].title, 'Tourner dans le vide');

  f.sched.chooseSong(lea, { songId: 78, title: 'Tourner dans le vide (Version acoustique)', artist: 'Indila' });
  f.sched.chooseSong(tom, { songId: 90, title: 'Autre', artist: 'X' });
  const notice = f.repeatNotice(lea.song, lea.tableId, lea.song.entryId);
  assert.equal(notice.minutesAgo, 0, 'autre version du même titre : alerte « vient d’être chanté »');
  const marks = f.staffState().queue.filter(line => line.source === 'helper');
  assert.ok(marks.find(line => line.id === lea.id).repeat?.playedAt, 'la page du bar signale le titre récent');
  assert.equal(marks.find(line => line.id === tom.id).repeat, undefined);

  f.settings.repeatWarnMin = 0;
  assert.equal(f.repeatNotice(lea.song, lea.tableId, lea.song.entryId), null, '0 minute : alerte coupée');
  f.sched.chooseSong(tom, { songId: 78, title: 'Tourner dans le vide', artist: 'Indila' }, 'append');
  const queued = f.repeatNotice(f.sched.songsOf(tom)[1], tom.tableId, f.sched.songsOf(tom)[1].entryId);
  assert.equal(queued.queued.length, 1, 'un titre déjà prévu reste signalé même sans fenêtre de temps');
  assert.equal(queued.queued[0].before, true, 'le titre de Léa passera avant celui de Tom');
});
