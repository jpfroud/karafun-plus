'use strict';
// Essai réel au bar (PR #10) : le bar note un duo improvisé de Marine avec
// Dam, dont le titre suivant était déjà chargé dans KaraFun. Ce titre est
// retiré de KaraFun, mais Dam repassait aussitôt en tête : l'annulation de
// son passage non chanté effaçait aussi le passage compté pour le duo.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Scheduler } = require('../scheduler');

// JP a chanté, Marine chante, le titre de Dam est déjà envoyé à KaraFun.
function barScenario(s, solo) {
  const join = (name, table) => s.join({ tableId: solo ? 'Comptoir' : table, name, headcount: solo ? undefined : 1 });
  if (solo) s.table('Comptoir').individual = true;
  const jp = join('JP', 'A'), marine = join('Marine', 'B'), dam = join('Dam', 'C');
  let songId = 1;
  for (const p of [jp, marine, dam]) for (let k = 0; k < 2; k++) s.chooseSong(p, { songId: songId++, title: `${p.name} ${k + 1}` }, 'append');
  const sung = s.select(); s.commit(sung); s.recordStage(sung, Date.now() - 400000);
  assert.equal(sung.ids[0], jp.id);
  s.songEnded(sung.ids); s.endStage(sung);
  const stage = s.select(); s.commit(stage); s.recordStage(stage, Date.now() - 60000);
  assert.equal(stage.ids[0], marine.id);
  const loaded = s.select(); s.commit(loaded);
  assert.equal(loaded.ids[0], dam.id, 'Dam est le suivant, déjà chargé dans KaraFun');
  return { jp, marine, dam, stage, loaded };
}

for (const solo of [true, false]) {
  test(`duo improvisé (${solo ? 'En solo' : 'tables'}) : le partenaire retiré de KaraFun ne repasse pas juste après le duo`, () => {
    const s = new Scheduler();
    const { jp, marine, dam, stage, loaded } = barScenario(s, solo);
    s.staffCountPartner(marine.id, dam.id, stage, [loaded]);
    stage.ids.push(dam.id); stage.names.push('Dam'); stage.kind = 'duo';
    // KaraFun confirme le retrait : le titre de Dam revient dans sa liste.
    s.requeueUnplayed(loaded);
    assert.equal(dam.song.title, 'Dam 1', 'son titre revient en tête de sa liste');
    assert.ok(s.roundPeople.has(dam.id), 'le duo compte comme son passage du tour');
    assert.ok(!s.roundOwed.has(dam.id), 'Dam ne redevient pas prioritaire');
    s.songEnded(stage.ids); s.endStage(stage);
    const next = s.select();
    assert.equal(next.ids[0], jp.id, 'JP passe avant Dam, qui vient de chanter en duo');
  });
}

test('duo improvisé : le crédit du duo survit aussi quand d’autres changements ont eu lieu entre-temps', () => {
  const s = new Scheduler();
  const { jp, marine, dam, stage, loaded } = barScenario(s, false);
  const zoe = s.join({ tableId: 'D', name: 'Zoé', headcount: 1 });
  s.chooseSong(zoe, { songId: 99, title: 'Zoé 1' }, 'append');
  s.staffCountPartner(marine.id, dam.id, stage, [loaded]);
  s.requeueUnplayed(loaded);
  assert.ok(s.roundPeople.has(dam.id));
  s.songEnded(stage.ids); s.endStage(stage);
  const next = s.select();
  assert.notEqual(next.ids[0], dam.id, `${next.names} passe avant Dam`);
  assert.ok([jp.id, zoe.id].includes(next.ids[0]));
});

test('duo improvisé : sans titre en route, le comptage reste celui d’avant', () => {
  const s = new Scheduler();
  const { marine, dam, stage, loaded } = barScenario(s, true);
  // Titre de Dam finalement chanté : son passage et le duo comptent tous deux.
  s.staffCountPartner(marine.id, dam.id, stage, [loaded]);
  assert.equal(loaded.turnCredit.rolledBack, false);
  assert.ok(s.roundPeople.has(dam.id));
  assert.equal(dam.duetGuestCount, 1);
});

// Vérification de la troisième passe de la relecture finale : l'invité est
// compté au tour du passage noté (son reçu, ou le tour relevé dans les
// derniers passages). Un tour relevé abîmé, ou au-dessus du compteur actuel
// (passage resté en scène après « Nouvelle soirée »), n'est jamais recopié.
test('duo improvisé : invité compté au tour du passage noté, jamais au-dessus du compteur', () => {
  const s = new Scheduler();
  const { marine, dam, stage, loaded } = barScenario(s, true);
  const entry = s.stageHistory.at(-1);
  assert.equal(entry.turn, marine.lastAppearanceTurn, 'tour relevé au début du passage');
  assert.equal(loaded.turnCredit.after.appearanceSerial, entry.turn + 1, 'le titre de Dam est compté après');
  for (const turn of [s.appearanceSerial + 5, 1.5, 'deux', -1, undefined]) {
    const other = new Scheduler();
    const run = barScenario(other, true);
    other.staffCountPartner(run.marine.id, run.dam.id, { song: { ...run.stage.song }, turn }, [run.loaded]);
    assert.equal(run.dam.lastAppearanceTurn, run.marine.lastAppearanceTurn, `tour ${turn} : dernier passage du chanteur`);
    assert.ok(run.dam.lastAppearanceTurn <= other.appearanceSerial);
  }
  s.staffCountPartner(marine.id, dam.id, stage, [loaded]);
  assert.equal(dam.lastAppearanceTurn, entry.turn, 'reçu du passage en scène');
});

// ---------------------------------------------------------------- de bout en bout, faux KaraFun
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
    globalThis.fixture = { sched, tracked, settings, handlers, sync, setBridge: b => { bridge = b; }, getPending: () => pending };
  `, context, { filename: 'server.js' });
  context.fixture.settings.auto = false;
  context.fixture.settings.autoPlay = false;
  return context.fixture;
}

test('duo improvisé noté au bar : après le retrait par KaraFun, le titre envoyé ensuite est celui de JP', async () => {
  const f = harness();
  const { jp, dam, stage, loaded } = barScenario(f.sched, true);
  const queue = [{ queueId: 1, songId: stage.song.songId, singer: stage.label },
    { queueId: 2, songId: loaded.song.songId, singer: loaded.label }];
  const sent = [];
  const bridge = { ready: true, connected: true, queue, events: [], snapshot: () => ({ ready: true, connected: true, queue, events: [] }),
    status: { state: 'playing', songPlaying: { queueId: 1 } }, permissions: {},
    add: songId => sent.push(songId), remove: id => { const i = queue.findIndex(item => item.queueId === id); if (i >= 0) queue.splice(i, 1); },
    next() {}, play() {} };
  f.setBridge(bridge);
  f.tracked.push({ queueId: 1, sel: stage, startedAt: Date.now() - 60000, addedAt: Date.now() - 90000 },
    { queueId: 2, sel: loaded, startedAt: null, addedAt: Date.now() - 30000 });
  const r = await f.handlers['POST /api/staff/duo-mark'](null, null, { queueId: 1, partnerId: dam.id });
  assert.equal(r.moved, 1);
  f.sync();
  assert.ok(f.sched.log.some(line => /après le duo improvisé/.test(line.msg)), 'retrait constaté');
  assert.ok(f.sched.roundPeople.has(dam.id));
  // Envoi automatique du titre suivant : celui de JP, pas celui de Dam.
  f.settings.auto = true;
  f.settings.pushDelaySec = 0;
  f.sync();
  await new Promise(resolve => setTimeout(resolve, 1100));
  f.sync();
  const pending = f.getPending();
  assert.ok(pending, 'un titre part vers KaraFun');
  assert.equal(pending.sel.ids[0], jp.id, `titre envoyé : ${pending.sel.names}`);
  assert.deepEqual(sent, [pending.sel.song.songId]);
});
