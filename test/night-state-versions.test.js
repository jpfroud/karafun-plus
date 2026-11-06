'use strict';
// Retour à une version précédente (page du bar, DEPLOIEMENT-SERVEUR.md §17) :
// une version antérieure à FULL_RESTORE_SINCE reprend la soirée sans tout ce
// que celle-ci sauvegarde ; tant qu'une soirée est en mémoire, la route et la
// page la refusent. Les chemins de champs sauvegardés d'une soirée remplie
// (tables, personnes, titres, duo, prochain annoncé) sont figés par version
// dans test/fixtures/sauvegarde-chemins-<version>.json. Un champ ajouté ou
// retiré demande de mettre FULL_RESTORE_SINCE à la version qui le publiera,
// puis d'enregistrer ses chemins : node test/night-state-versions.test.js --ecrire.
// Ce test ne voit pas une valeur ou une règle de reprise nouvelle dans un champ
// existant : la règle d'AGENTS.md s'applique aussi à elles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { spawnSync } = require('node:child_process');
const { snapshotNight, FULL_RESTORE_SINCE } = require('../night-state');

function populatedNight() {
  const scheduler = new Scheduler();
  const access = new TableAccess();
  scheduler.table('1'); scheduler.setHeadcount('1', 3); access.issue('1');
  const first = scheduler.join({ tableId: '1', name: 'S01' });
  const second = scheduler.join({ tableId: '1', name: 'S02' });
  const third = scheduler.join({ tableId: '1', name: 'S03' });
  scheduler.inviteDuet(first, second.id, { songId: 42, title: 'T1', artist: 'A' });
  scheduler.chooseSong(third, { songId: 43, title: 'T2', artist: 'A' });
  const turn = scheduler.select();
  // Ordre de la soirée : envoi à KaraFun, début sur scène, fin du titre.
  scheduler.commit(turn); scheduler.recordStage(turn); scheduler.songEnded(turn.ids);
  scheduler.chooseSong(first, { songId: 44, title: 'T3', artist: 'A' });
  // Champs que v3.2.0 sauvegarde pour une priorité et pour la chaîne du
  // prochain annoncé (night-state.js : validDeferral, reservedNext) ; les
  // gestes du bar qui les créent passent par server.js.
  const now = Date.now();
  second.deferral = { entryId: 'e1', total: 0, until: now + 60000, afterPriority: true, endedFor: third.id, endedAt: now };
  scheduler.reservedNext = { personId: third.id, reservedAt: now, byStaff: true, borrowable: true, pulledBack: now,
    then: { personId: first.id, reservedAt: now, pulled: true, forId: third.id, forAt: now, retry: true, back: true } };
  return JSON.parse(JSON.stringify(snapshotNight({ scheduler, access, settings: { auto: true, autoPlay: false,
    baseUrl: 'https://test.invalid', pushDelaySec: 45, playDelaySec: 8 } })));
}

// Chemins de tous les champs : « .scheduler.people[].song.title ».
function savedPaths(value, prefix = '', found = new Set()) {
  if (Array.isArray(value)) value.forEach(item => savedPaths(item, `${prefix}[]`, found));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { found.add(`${prefix}.${key}`); savedPaths(item, `${prefix}.${key}`, found); }
  }
  return found;
}

const fixture = path.join(__dirname, 'fixtures', `sauvegarde-chemins-${FULL_RESTORE_SINCE}.json`);
// Les chemins d'une version publiée ne se réécrivent jamais : sans
// FULL_RESTORE_SINCE relevé, --ecrire refuse et la garde reste en place.
if (process.argv.includes('--ecrire')) {
  if (fs.existsSync(fixture)) {
    console.error(`${path.basename(fixture)} existe déjà : relever d'abord FULL_RESTORE_SINCE (night-state.js).`);
    process.exitCode = 1;
  } else {
    fs.writeFileSync(fixture, `${JSON.stringify([...savedPaths(populatedNight())].sort(), null, 2)}\n`, { flag: 'wx' });
  }
}

test('chaque champ sauvegardé d’une soirée remplie est repris depuis FULL_RESTORE_SINCE', () => {
  assert.match(FULL_RESTORE_SINCE, /^v\d+\.\d+\.\d+$/);
  assert.ok(fs.existsSync(fixture), `${path.basename(fixture)} absent : enregistrer les chemins de ${FULL_RESTORE_SINCE}`);
  const expected = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  assert.deepEqual([...savedPaths(populatedNight())].sort(), expected,
    'champ sauvegardé ajouté ou retiré : mettre FULL_RESTORE_SINCE (night-state.js) à la version qui le publiera, puis enregistrer ses chemins (--ecrire)');
  for (const known of ['.scheduler.firstCycle', '.scheduler.reservedNext.then.personId', '.scheduler.reservedNext.pulledBack',
    '.scheduler.stageHistory[].turn', '.scheduler.people[].deferral.afterPriority']) assert.ok(expected.includes(known), known);
});

test('--ecrire ne remplace jamais les chemins figés d’une version', { skip: process.argv.includes('--ecrire') ? 'appel imbriqué' : false }, () => {
  const before = fs.readFileSync(fixture, 'utf8');
  const run = spawnSync(process.execPath, [__filename, '--ecrire'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0, 'refus quand le fichier existe');
  assert.match(run.stderr, /relever d'abord FULL_RESTORE_SINCE/);
  assert.equal(fs.readFileSync(fixture, 'utf8'), before);
});
