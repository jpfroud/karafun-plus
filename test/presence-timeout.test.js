'use strict';
// Serveur réel (contexte isolé, faux pont KaraFun, horloge simulée) : un
// « Je suis là » manqué ne bloque plus la soirée.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Les valeurs créées dans le contexte isolé ont d'autres prototypes.
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const fromServer = createRequire(path.join(root, 'server.js'));
  const clock = { now: Date.now() };
  const FakeDate = class extends Date { static now() { return clock.now; } };
  const context = {
    require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL, setTimeout, setImmediate,
    Date: FakeDate,
  };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, sync, settings, staffState, confirmPresence,
      setBridge(value) { bridge = value; } };
  `, context, { filename: 'server.js' });
  let queueId = 0;
  const bridge = { ready: true, connected: true, queue: [], status: { state: 'idle' }, permissions: {},
    add(songId, singer) { this.queue.push({ queueId: `k${++queueId}`, songId, singer, title: `Titre ${songId}` }); },
    play() {}, next() {}, remove() {}, snapshot() { return null; } };
  context.fixture.setBridge(bridge);
  Object.assign(context.fixture.settings, { auto: true, autoPlay: false, pushDelaySec: 0, presenceGraceSec: 10, presenceMaxSkips: 2 });
  context.fixture.sched.opts.requirePresence = true;
  return { ...context.fixture, bridge, clock, tick(ms) { clock.now += ms; context.fixture.sync(); } };
}

test('sans « Je suis là » dans le délai, la file passe au suivant ; au deuxième manque le titre part et le bar est prévenu', () => {
  const f = harness();
  const [alice, bruno] = ['Alice', 'Bruno'].map((name, i) => f.sched.join({ tableId: String(i + 1), name, headcount: 1 }));
  f.sched.chooseSong(alice, { songId: 101, title: 'Titre A' });
  f.sched.chooseSong(bruno, { songId: 102, title: 'Titre B' });
  f.sync();
  assert.deepEqual(plain(f.staffState().presencePending), ['Alice']);
  f.tick(9000);
  assert.deepEqual(plain(f.staffState().presencePending), ['Alice'], 'avant le délai, Alice garde sa place');
  assert.equal(f.bridge.queue.length, 0);

  f.tick(2000);
  assert.deepEqual(plain(f.staffState().presencePending), ['Bruno'], 'après le délai, Bruno est annoncé à son tour');
  assert.equal(alice.presenceRetry, true);
  f.confirmPresence(bruno);
  f.tick(1000);
  assert.deepEqual(plain(f.bridge.queue.map(item => item.songId)), [102], 'le titre de Bruno part dans KaraFun');
  f.tick(1000);
  assert.equal(f.sched.reservedNext?.personId, alice.id, 'Alice revient juste après Bruno');

  // Bruno chante : Alice reçoit sa nouvelle demande, puis la scène se libère
  // sans qu'elle confirme.
  f.bridge.status = { state: 'playing', current: { queueId: 'k1' } };
  f.tick(1000);
  assert.deepEqual(plain(f.staffState().presencePending), ['Alice']);
  f.tick(60000);
  assert.equal(f.sched.songsOf(alice).length, 1, 'pas de passage manqué tant que la scène est occupée');
  f.bridge.queue = []; f.bridge.status = { state: 'idle' };
  f.tick(1000);
  f.tick(9500);
  assert.equal(f.sched.songsOf(alice).length, 1, 'le délai part de la fin de la chanson');
  f.tick(1000);
  assert.equal(f.sched.songsOf(alice).length, 0, 'deuxième manque : le titre est retiré');
  const [gone] = f.staffState().maybeGone;
  assert.deepEqual([gone.name, gone.title, gone.skips], ['Alice', 'Titre A', 2]);
});

test('duo : la confirmation de l’invité suffit pour l’envoi', () => {
  const f = harness();
  const owner = f.sched.join({ tableId: '1', name: 'Olga', headcount: 2 });
  const guest = f.sched.join({ tableId: '1', name: 'Gus' });
  f.sched.inviteDuet(owner, guest.id, { songId: 201, title: 'Duo' });
  f.sync();
  assert.deepEqual(plain(f.staffState().presencePending).sort(), ['Gus', 'Olga']);
  f.confirmPresence(guest);
  f.tick(1000);
  assert.deepEqual(plain(f.staffState().presencePending), [], 'plus rien à confirmer');
  assert.deepEqual(plain(f.bridge.queue.map(item => item.songId)), [201]);
});
