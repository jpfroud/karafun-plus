'use strict';
// Fuseau horaire du processus (issue #26) : l'heure de fermeture et
// l'identifiant de soirée suivent l'heure locale, donc la variable TZ (l'image
// Docker fixe TZ=Europe/Paris, #29). Sous UTC, « 02:00 » tombe 2 h (été) ou
// 1 h (hiver) plus tard qu'à Paris.
//
// process.env.TZ est changé en cours d'exécution (Node relit alors le fuseau)
// puis toujours rendu. nextClosing et hhmm viennent de server.js chargé dans
// le bac à sable `vm` de review-v04-fixes.test.js.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EveningJournal, newEveningId } = require('../evening-journal');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));
const withoutKaraoke = env => Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('KARAOKE_')));

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.env = withoutKaraoke(process.env);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const context = { require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL, setTimeout, setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { nextClosing, hhmm };
  `, context, { filename: 'server.js' });
  return context.fixture;
}

const ORIGINAL_TZ = process.env.TZ;
const ORIGINAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Exécute `run` sous le fuseau `zone`, puis rend la valeur d'origine de TZ.
function inZone(zone, run) {
  process.env.TZ = zone;
  try {
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, zone, `fuseau ${zone} pris en compte`);
    return run();
  } finally {
    // Sous Windows, Node ne suit TZ que quand elle reçoit une valeur : la
    // retirer seule laisserait le dernier fuseau essayé. Le fuseau d'origine
    // est donc redonné avant le retrait (sans effet ailleurs).
    if (ORIGINAL_TZ === undefined) { process.env.TZ = ORIGINAL_ZONE; delete process.env.TZ; }
    else process.env.TZ = ORIGINAL_TZ;
  }
}
function assertRestored() {
  assert.equal(process.env.TZ, ORIGINAL_TZ, 'TZ d’origine rendue');
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, ORIGINAL_ZONE, 'fuseau d’origine rendu');
}

const f = harness();
// Soirée d'été, soirée d'hiver, et la nuit du passage à l'heure d'hiver
// (dimanche 25 octobre 2026, 03:00 CEST → 02:00 CET).
const NOWS = ['2026-10-22T20:00:00.000Z', '2026-12-04T21:00:00.000Z', '2026-10-24T20:00:00.000Z'].map(Date.parse);
const closings = () => NOWS.map(now => {
  const at = f.nextClosing('02:00', now);
  return { iso: new Date(at).toISOString(), at, hhmm: f.hhmm(at) };
});

test('F1 Europe/Paris : 02:00 de Paris, y compris la nuit du changement d’heure', () => {
  const paris = inZone('Europe/Paris', closings);
  assertRestored();
  assert.deepEqual(paris.map(row => row.iso),
    ['2026-10-23T00:00:00.000Z', '2026-12-05T01:00:00.000Z', '2026-10-25T00:00:00.000Z']);
  assert.deepEqual(paris.map(row => row.hhmm), ['02:00', '02:00', '02:00']);
});

test('F2 UTC : 02:00 UTC, soit 2 h (été) ou 1 h (hiver) plus tard qu’à Paris', () => {
  const paris = inZone('Europe/Paris', closings);
  const utc = inZone('UTC', closings);
  assertRestored();
  assert.deepEqual(utc.map(row => row.iso),
    ['2026-10-23T02:00:00.000Z', '2026-12-05T02:00:00.000Z', '2026-10-25T02:00:00.000Z']);
  assert.deepEqual(utc.map(row => row.hhmm), ['02:00', '02:00', '02:00']);
  assert.deepEqual(utc.map((row, i) => (row.at - paris[i].at) / 3600000), [2, 1, 2]);
});

test('F3 identifiant de soirée et fuseau noté au journal', () => {
  const summer = Date.UTC(2026, 9, 15, 20, 30), afterMidnight = Date.UTC(2026, 9, 15, 23, 30);
  const read = () => {
    const journal = new EveningJournal({ dir: null });
    journal.start({});
    return { ids: [newEveningId(summer, 'beef'), newEveningId(afterMidnight, 'beef')], timezone: journal.current.meta.timezone };
  };
  const paris = inZone('Europe/Paris', read);
  const utc = inZone('UTC', read);
  assertRestored();
  assert.deepEqual(paris.ids, ['2026-10-15_2230_beef', '2026-10-16_0130_beef']);
  assert.deepEqual(utc.ids, ['2026-10-15_2030_beef', '2026-10-15_2330_beef']);
  assert.equal(paris.timezone, 'Europe/Paris');
  assert.equal(utc.timezone, 'UTC');
});
