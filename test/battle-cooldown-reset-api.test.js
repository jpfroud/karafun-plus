'use strict';
// Retour du bar : l'admin lève la pause entre Battles pour que la salle
// puisse en reproposer une tout de suite. Serveur chargé en mémoire (--demo),
// sans port ni KaraFun : les gestionnaires sont appelés directement.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

// Même harnais que review-v04-fixes.test.js, avec le vote Battle exposé.
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
    globalThis.fixture = { sched, settings, handlers, access, battleVote, rememberBattleSongs, staffState, publicState };
  `, context, { filename: 'server.js' });
  context.fixture.settings.auto = false;
  context.fixture.settings.autoPlay = false;
  return context.fixture;
}

// Cinq téléphones inscrits (le minimum pour proposer une Battle).
function room(f) {
  const songs = [{ songId: 81001, title: 'Titre Battle', artist: 'Groupe' }];
  f.rememberBattleSongs(songs); // reçu du catalogue par le serveur
  const people = ['Alice', 'Bruno', 'Chloé', 'David', 'Emma'].map((name, index) => {
    const tableId = String(index + 1);
    const p = f.sched.join({ tableId, name, headcount: 1 });
    return { p, body: extra => ({ table: tableId, access: f.access.get(tableId) || f.access.issue(tableId),
      personId: p.id, token: p.token, ...extra }) };
  });
  return { songs, people };
}

test('le bar lève la pause après un refus : un téléphone repropose aussitôt', async () => {
  const f = harness();
  const { songs, people } = room(f);
  const propose = who => f.handlers['POST /api/table/battle/propose'](null, null, who.body({ songs }));
  assert.equal((await propose(people[0])).battle.phase, 'voting');
  for (const who of people.slice(1)) {
    await f.handlers['POST /api/table/battle/vote'](null, null, who.body({ choice: 'none' }));
  }
  assert.equal(f.battleVote.view().phase, 'cooldown');
  assert.ok(f.battleVote.view().cooldownUntil > Date.now(), 'pause après refus en cours');
  await assert.rejects(propose(people[1]), /Attends la fin du délai/);

  const reset = await f.handlers['POST /api/staff/battle/reset-cooldown'](null, null, {});
  assert.equal(reset.ok, true);
  assert.equal(reset.battle.phase, 'idle');
  assert.ok(f.sched.log.some(line => line.msg === 'Le bar autorise une nouvelle Battle dès maintenant.' && line.kind === 'battle'),
    'le journal du bar garde la trace de la décision');
  assert.equal(f.staffState().battle.phase, 'idle', 'la page du bar voit la pause levée');
  assert.equal(f.publicState(people[1].p, '2').battle.phase, 'idle', 'le téléphone affiche « Proposer une Battle »');
  assert.equal((await propose(people[1])).battle.phase, 'voting', 'nouvelle proposition acceptée');
});

test('rien à lever : erreur claire, sans note au journal', async () => {
  const f = harness();
  room(f);
  await assert.rejects(f.handlers['POST /api/staff/battle/reset-cooldown'](null, null, {}), /Aucune pause Battle/);
  assert.ok(!f.sched.log.some(line => /nouvelle Battle dès maintenant/.test(line.msg)));
});

test('Battle encore à jouer : la pause ne se lève pas', async () => {
  const f = harness();
  const { songs } = room(f);
  await f.handlers['POST /api/staff/battle/launch'](null, null, { song: songs[0] });
  await assert.rejects(f.handlers['POST /api/staff/battle/reset-cooldown'](null, null, {}), /en préparation ou en cours/);
  await f.handlers['POST /api/staff/battle/resolve'](null, null, { outcome: 'done' });
  await assert.rejects(f.handlers['POST /api/staff/battle/reset-cooldown'](null, null, {}), /en préparation ou en cours/,
    'Battle manuelle en cours');
  await f.handlers['POST /api/staff/battle/resolve'](null, null, { outcome: 'finished' });
  await assert.rejects(f.handlers['POST /api/staff/battle/reset-cooldown'](null, null, {}), /prochain titre attend le bar/,
    'la file doit d’abord reprendre');
  assert.ok(!f.sched.log.some(line => /nouvelle Battle dès maintenant/.test(line.msg)));
});
