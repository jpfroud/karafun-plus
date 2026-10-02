'use strict';
// Un partenaire dont le propre titre est déjà chargé dans KaraFun peut
// chanter en invité sur le titre en cours sans perdre son passage prévu.
// Ici KaraFun est déconnecté : son titre ne peut pas être retiré, il reste
// chargé et le bar est prévenu. Le retrait réel est couvert par
// review-v04-fixes.test.js.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const context = {
    require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console, Buffer, URL, setTimeout, setImmediate,
  };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, handlers, tracked };
  `, context, { filename: 'server.js' });
  return context.fixture;
}

test('KaraFun déconnecté : le duo est noté, le titre déjà chargé du partenaire reste et le bar est prévenu', async () => {
  const f = harness();
  const owner = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const guest = f.sched.join({ tableId: '2', name: 'Bob', headcount: 1 });
  f.sched.chooseSong(owner, { songId: 101, title: 'Titre en cours' });
  f.sched.chooseSong(guest, { songId: 102, title: 'Titre suivant' });

  const stage = f.sched.select();
  assert.equal(stage.ids[0], owner.id);
  f.sched.commit(stage);
  const following = f.sched.select();
  assert.equal(following.ids[0], guest.id);
  f.sched.commit(following);
  const guestTurnBefore = guest.sung;
  const nextEntryId = following.song.entryId;
  const live = { queueId: 'live', sel: stage, startedAt: Date.now() };
  const next = { queueId: 'next', sel: following, startedAt: null };
  f.tracked.push(live, next);

  const response = await f.handlers['POST /api/staff/duo-mark'](null, null,
    { queueId: live.queueId, partnerId: guest.id });

  assert.equal(response.ok, true);
  assert.deepEqual(Array.from(live.sel.ids), [owner.id, guest.id],
    'le duo sur scène inclut le chanteur déjà chargé comme suivant');
  assert.equal(next.queueId, 'next', 'la chanson déjà chargée conserve son identifiant KaraFun');
  assert.equal(next.sel.song.entryId, nextEntryId, 'le prochain titre reste le même');
  assert.equal(guest.sung, guestTurnBefore, 'le duo invité ne consomme pas le propre tour du partenaire');
  assert.equal(guest.duetGuestCount, 1, 'sa présence physique en duo compte pour l’équité');
  assert.equal(response.moved, 0);
  assert.equal(next.pulled ?? null, null, 'rien n’est retiré sans KaraFun');
  assert.ok(f.sched.log.some(l => /Titre de Bob à retirer de KaraFun : KaraFun est déconnecté/.test(l.msg)), 'le bar est prévenu');
});
