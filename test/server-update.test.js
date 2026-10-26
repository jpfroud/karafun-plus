'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServerUpdate } = require('../server-update');

const NOW = Date.parse('2026-10-26T16:00:00.000Z');
const OTHER_ID = 'a5bcd6d2-9780-424f-a824-23eb8845c088';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const update = createServerUpdate({ directory, version: 'v3.1.1', now: () => NOW });
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  return { directory, update, read, write, status(phase, extra = {}) {
    write('status.json', { requestId: read('request.json').id, phase, currentVersion: 'v3.1.1',
      targetVersion: 'v3.1.2', updatedAt: new Date(NOW).toISOString(), ...extra });
  } };
}

test('mode PC et serveur sans agent : aucun accès au disque', () => {
  const lstat = fs.lstatSync;
  fs.lstatSync = () => { throw new Error('Ne doit pas lire le disque'); };
  try {
    for (const directory of [undefined, null, '']) {
      const update = createServerUpdate({ directory, version: 'v3.1.1' });
      assert.equal(update.view().enabled, false);
      assert.equal(update.isBusy(), false);
      assert.throws(() => update.request(), e => e.status === 503);
    }
  } finally { fs.lstatSync = lstat; }
});

test('un chemin configuré absent n’est pas créé par l’application', t => {
  const f = fixture(t);
  const directory = path.join(f.directory, 'absent');
  const update = createServerUpdate({ directory, version: 'v3.1.1' });
  assert.equal(update.view().enabled, true);
  assert.equal(update.view().busy, true);
  assert.equal(update.isBusy(), true);
  assert.match(update.view().blockedReason, /pas disponible/);
  assert.throws(() => update.request(), e => e.status === 503);
  assert.equal(fs.existsSync(directory), false);
  const rebooted = createServerUpdate({ directory, version: 'v3.1.2' });
  assert.equal(rebooted.isBusy(), true, 'un conteneur candidat sans montage ne peut pas reprendre les commandes');
});

test('un répertoire IPC remplacé par un lien ne libère pas les commandes au redémarrage', t => {
  const f = fixture(t);
  const actual = path.join(f.directory, 'actual');
  const linked = path.join(f.directory, 'linked');
  fs.mkdirSync(actual);
  try { fs.symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Création de liens symboliques non autorisée sur ce Windows');
    throw error;
  }
  for (const version of ['v3.1.1', 'v3.1.2']) {
    const update = createServerUpdate({ directory: linked, version });
    assert.equal(update.isBusy(), true);
    assert.equal(update.view().busy, true);
    assert.match(update.view().blockedReason, /pas disponible/);
    assert.throws(() => update.request(), e => e.status === 503);
  }
  assert.deepEqual(fs.readdirSync(actual), [], 'le lien ne doit recevoir aucune demande');
});

test('une soirée active refuse la demande et n’écrit aucun fichier', t => {
  const f = fixture(t);
  const reason = 'Attends la fin de la soirée.';
  assert.equal(f.update.view(reason).blockedReason, reason);
  assert.throws(() => f.update.request(reason), e => e.status === 409 && e.message === reason);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('le premier clic publie une opération fixe, complète et durable', t => {
  const f = fixture(t);
  assert.equal(f.update.view().phase, 'idle');
  const result = f.update.request();
  const record = f.read('request.json');
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'id']);
  assert.match(record.id, /^[a-f0-9-]{36}$/);
  assert.equal(record.createdAt, new Date(NOW).toISOString());
  assert.equal(result.phase, 'requested');
  assert.equal(result.busy, true);
  assert.equal(result.requestId, record.id);
  assert.deepEqual(fs.readdirSync(f.directory), ['request.json']);
  assert.equal(createServerUpdate({ directory: f.directory }).isBusy(), true,
    'un redémarrage ne perd pas une demande encore en attente');
});

test('un double clic ne remplace pas une demande en attente', t => {
  const f = fixture(t);
  f.update.request();
  const initial = f.read('request.json');
  assert.throws(() => f.update.request(), e => e.status === 409);
  assert.deepEqual(f.read('request.json'), initial);
});

test('les étapes hôte gardent le verrou jusqu’au statut terminal correspondant', t => {
  const f = fixture(t);
  f.update.request();
  for (const phase of ['checking', 'downloading', 'backing-up', 'installing', 'verifying']) {
    f.status(phase);
    assert.equal(f.update.view().phase, phase);
    assert.equal(f.update.isBusy(), true);
    assert.throws(() => f.update.request(), e => e.status === 409);
  }
  for (const phase of ['succeeded', 'failed', 'rolled-back']) {
    f.status(phase);
    assert.equal(f.update.isBusy(), false);
    assert.equal(f.update.view().phase, phase);
  }
});

test('une demande terminée peut être remplacée sans réutiliser son identifiant', t => {
  const f = fixture(t);
  const before = f.update.request();
  f.status('succeeded');
  const after = f.update.request();
  assert.notEqual(after.requestId, before.requestId);
  assert.equal(after.busy, true);
  assert.equal(after.phase, 'requested', 'l’ancien succès ne termine pas la nouvelle demande');
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['request.json', 'status.json']);
});

test('le succès d’une autre demande ne libère pas la mise à jour courante', t => {
  const f = fixture(t);
  f.update.request();
  f.status('succeeded', { requestId: OTHER_ID });
  assert.equal(f.update.isBusy(), true);
  assert.equal(f.update.view().phase, 'requested');
});

test('un travail hôte sans requête reste bloquant, même après redémarrage', t => {
  const f = fixture(t);
  f.write('status.json', { requestId: OTHER_ID, phase: 'installing' });
  assert.equal(f.update.isBusy(), true);
  assert.throws(() => f.update.request(), e => e.status === 409);
  const reopened = createServerUpdate({ directory: f.directory, version: 'v3.1.2' });
  assert.equal(reopened.isBusy(), true);
  f.write('status.json', { requestId: OTHER_ID, phase: 'rolled-back' });
  assert.equal(reopened.isBusy(), false);
  assert.equal(reopened.request().busy, true);
});

test('les fichiers invalides échouent fermés et ne sont pas écrasés', t => {
  const f = fixture(t);
  for (const record of ['{', '[]', JSON.stringify({ id: OTHER_ID, createdAt: 'non-date' }),
    JSON.stringify({ id: [OTHER_ID], createdAt: new Date(NOW).toISOString() }),
    JSON.stringify({ id: OTHER_ID, createdAt: '2026' }),
    JSON.stringify({ id: OTHER_ID, createdAt: new Date(NOW).toISOString(), command: 'injected' })]) {
    fs.writeFileSync(path.join(f.directory, 'request.json'), record);
    assert.equal(f.update.isBusy(), true);
    assert.match(f.update.view().message, /illisible/);
    assert.throws(() => f.update.request(), e => e.status === 409);
    assert.equal(fs.readFileSync(path.join(f.directory, 'request.json'), 'utf8'), record);
  }
});

test('statut inconnu, trop gros ou version non stable : ne pas libérer une demande', t => {
  const f = fixture(t);
  f.update.request();
  for (const extra of [{ phase: 'complete' }, { targetVersion: 'latest; commande' },
    { requestId: [OTHER_ID] }, { targetVersion: ['v3.1.2'] },
    { updatedAt: 'hier' }, { message: 'x'.repeat(17000) }]) {
    f.status('succeeded', extra);
    assert.equal(f.update.isBusy(), true);
    assert.match(f.update.view().message, /illisible/);
  }
});

test('un statut idle initial laisse la première demande disponible', t => {
  const f = fixture(t);
  f.write('status.json', { phase: 'idle', currentVersion: 'v3.1.1' });
  assert.equal(f.update.isBusy(), false);
  assert.equal(f.update.request().busy, true);
});

test('le navigateur ne reçoit jamais les messages libres ou secrets du service', t => {
  const f = fixture(t);
  f.update.request();
  f.status('failed', { message: '<img src=x onerror=attaque()> password=privé',
    stderr: 'clé=privée', privatePath: '/home/personne/.secret' });
  const result = f.update.view();
  assert.equal(result.phase, 'failed');
  assert.equal(result.currentVersion, 'v3.1.1');
  assert.equal(result.targetVersion, 'v3.1.2');
  assert.doesNotMatch(JSON.stringify(result), /attaque|password|privé|secret|stderr/);
});

test('un fichier qui apparaît pendant la publication n’est jamais remplacé', t => {
  const f = fixture(t);
  const originalLink = fs.linkSync;
  fs.linkSync = (...args) => {
    f.write('request.json', { id: OTHER_ID, createdAt: new Date(NOW).toISOString() });
    return originalLink(...args);
  };
  try {
    assert.throws(() => f.update.request(), e => e.status === 409);
  } finally { fs.linkSync = originalLink; }
  assert.equal(f.read('request.json').id, OTHER_ID);
  assert.deepEqual(fs.readdirSync(f.directory), ['request.json']);
});

test('une écriture refusée ne laisse ni demande partielle ni fichier temporaire', t => {
  const f = fixture(t);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = () => { throw Object.assign(new Error('Disque plein'), { code: 'ENOSPC' }); };
  try { assert.throws(() => f.update.request(), e => e.status === 503); }
  finally { fs.writeFileSync = originalWrite; }
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.equal(f.update.isBusy(), false);
});

test('un lien symbolique ne permet pas de lire ou remplacer un fichier extérieur', t => {
  const f = fixture(t);
  const outside = path.join(f.directory, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ id: OTHER_ID, createdAt: new Date(NOW).toISOString() }));
  try { fs.symlinkSync(outside, path.join(f.directory, 'request.json')); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Création de liens symboliques non autorisée sur ce Windows');
    throw error;
  }
  assert.equal(f.update.isBusy(), true);
  assert.throws(() => f.update.request(), e => e.status === 409);
  assert.equal(JSON.parse(fs.readFileSync(outside, 'utf8')).id, OTHER_ID);
});
