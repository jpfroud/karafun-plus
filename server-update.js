'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The application can request two fixed operations: install the latest
// release, or one release of the list the host agent publishes (versions.json).
// Only the host agent has Docker access and checks the chosen version against
// the official repository; no command, repository, image or digest crosses
// this channel. The choice (target.json) is written before the request that
// refers to it, and request.json keeps the shape older versions read.
const MAX_FILE_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^v\d+\.\d+\.\d+$/;
const TERMINAL = new Set(['succeeded', 'failed', 'rolled-back']);
const PHASES = new Set(['idle', 'checking', 'downloading', 'backing-up', 'installing', 'verifying', ...TERMINAL]);
// The agent rewrites its list hourly, retried ten minutes after a failure: a
// list older than three hours means a stopped agent, or an older agent
// reinstalled that ignores the choice, so the choice is not offered. A chosen
// install needs GitHub anyway (the agent re-verifies the release).
const CATALOGUE_MAX_AGE_MS = 3 * 3600 * 1000;
const CATALOGUE_MAX_ITEMS = 20;
const MESSAGES = {
  idle: 'Vérifie et installe la dernière version, avec sauvegarde et retour en arrière si nécessaire.',
  requested: 'Demande transmise. La mise à jour va commencer.',
  checking: 'Recherche de la dernière version publiée…',
  downloading: 'Téléchargement et vérification de la nouvelle version…',
  'backing-up': 'Sauvegarde avant installation…',
  installing: 'Installation en cours. La page reviendra automatiquement.',
  verifying: 'Vérification du démarrage…',
  succeeded: 'L’application est à jour.',
  failed: 'La mise à jour a échoué. Un administrateur doit consulter le diagnostic du serveur.',
  'rolled-back': 'La nouvelle version n’a pas démarré. L’ancienne version a été rétablie.',
};
// Same steps for a version chosen by the bar; only these texts differ.
const CHOICE_MESSAGES = {
  requested: 'Demande transmise. L’installation de la version choisie va commencer.',
  checking: 'Vérification de la version choisie…',
  downloading: 'Téléchargement et vérification de la version choisie…',
  succeeded: 'La version choisie est installée.',
  failed: 'La version choisie n’a pas pu être installée. Un administrateur doit consulter le diagnostic du serveur.',
  'rolled-back': 'La version choisie n’a pas démarré. La version en service a été rétablie.',
};
const UNAVAILABLE = 'Le service de mise à jour n’est pas disponible sur ce serveur.';
const INVALID = 'Le suivi de la mise à jour est illisible. Un administrateur doit vérifier le serveur.';
const NOT_OFFERED = 'Cette version n’est pas proposée par le service de mise à jour.';

function failure(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function dateString(value) {
  return typeof value === 'string' && value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && Number.isFinite(Date.parse(value));
}

function stableVersion(value) {
  return typeof value === 'string' && value.length <= 40 && VERSION.test(value);
}

// Numerical order of two stable versions (vX.Y.Z): negative when a < b.
function compareVersions(a, b) {
  const [x, y] = [a, b].map(value => value.slice(1).split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function validRequest(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && typeof value.id === 'string' && UUID.test(value.id) && dateString(value.createdAt);
}

function validStatus(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    PHASES.has(value.phase) && (value.phase === 'idle' ? !value.requestId : typeof value.requestId === 'string' && UUID.test(value.requestId)) &&
    (value.currentVersion == null || stableVersion(value.currentVersion)) &&
    (value.targetVersion == null || stableVersion(value.targetVersion)) &&
    (value.updatedAt == null || dateString(value.updatedAt));
}

const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function validTarget(value) {
  return exactKeys(value, ['requestId', 'version']) && typeof value.requestId === 'string' &&
    UUID.test(value.requestId) && stableVersion(value.version);
}

// versions.json, written by the host agent: installable releases. The agent
// is not updated with the app, and an older app (after a return) reads the
// list of a later agent: unknown keys are ignored, a longer list shows its
// CATALOGUE_MAX_ITEMS newest versions, a missing or unreadable date is left
// out. Only version and publishedAt reach the page; the agent re-verifies
// every choice.
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
function validCatalogue(value) {
  if (!plainObject(value) || !dateString(value.checkedAt) || !Array.isArray(value.versions)) return false;
  const seen = new Set();
  return value.versions.every(item => plainObject(item) && stableVersion(item.version) &&
    !seen.has(item.version) && seen.add(item.version));
}

function createServerUpdate({ directory, version, now = Date.now } = {}) {
  const enabled = typeof directory === 'string' && !!directory.trim();
  const root = enabled ? path.resolve(directory) : null;
  const currentVersion = typeof version === 'string' ? version.slice(0, 40) : '';

  function directoryReady() {
    try { const stat = fs.lstatSync(root); return stat.isDirectory() && !stat.isSymbolicLink(); }
    catch (_) { return false; }
  }

  function readJson(name, validate) {
    let fd;
    try {
      const file = path.join(root, name);
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) return { invalid: true };
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_FILE_BYTES) return { invalid: true };
      // A growing file must not turn a small status read into an unbounded read.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (size > MAX_FILE_BYTES) return { invalid: true };
      const value = JSON.parse(buffer.toString('utf8', 0, size));
      return validate(value) ? { value } : { invalid: true };
    } catch (error) {
      return error.code === 'ENOENT' ? {} : { invalid: true };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  function snapshot() {
    if (!enabled) return { enabled: false, busy: false, phase: 'idle' };
    // An explicitly configured IPC mount is a safety boundary, including on a
    // candidate image's first boot. Its disappearance must not release writes
    // or KaraFun commands while the host is still verifying the transaction.
    if (!directoryReady()) return { enabled: true, busy: true, phase: 'requested', unavailable: true };
    const request = readJson('request.json', validRequest);
    const status = readJson('status.json', validStatus);
    // Do not free the application after a corrupt record or a worker crash.
    // The host recovers its transaction on restart and writes a terminal status.
    if (request.invalid || status.invalid) return { enabled: true, busy: true, phase: 'requested', invalid: true };
    if (request.value) {
      if (!status.value || status.value.requestId !== request.value.id) {
        return { enabled: true, busy: true, phase: 'requested', request: request.value };
      }
      return { enabled: true, busy: !TERMINAL.has(status.value.phase), phase: status.value.phase,
        request: request.value, status: status.value };
    }
    const phase = status.value?.phase || 'idle';
    return { enabled: true, busy: phase !== 'idle' && !TERMINAL.has(phase), phase, status: status.value };
  }

  // Releases the bar may install instead of this one, or null when the host
  // agent publishes no recent list (older agent, stopped timer, no network).
  function catalogue() {
    if (!enabled || !directoryReady()) return null;
    const list = readJson('versions.json', validCatalogue).value;
    if (!list) return null;
    const age = now() - Date.parse(list.checkedAt);
    if (!(age >= -3600 * 1000 && age <= CATALOGUE_MAX_AGE_MS)) return null;
    return list.versions.filter(item => item.version !== currentVersion)
      .sort((a, b) => compareVersions(b.version, a.version)).slice(0, CATALOGUE_MAX_ITEMS)
      .map(item => ({ version: item.version, publishedAt: dateString(item.publishedAt) ? item.publishedAt : null }));
  }

  function offers(version) {
    return stableVersion(version) && !!catalogue()?.some(item => item.version === version);
  }

  // Version chosen for this request, or null. Read for the page only, never
  // by isBusy(): a choice only describes the request it names, and an
  // unreadable one is refused by the host agent with a terminal status. An
  // agent that predates the choice installs the latest release instead: its
  // status then names another target, and the generic messages apply.
  function chosenVersion(state) {
    if (!state.request) return null;
    const target = readJson('target.json', validTarget).value;
    if (!target || target.requestId !== state.request.id) return null;
    const named = state.status?.targetVersion;
    return named == null || named === target.version ? target.version : null;
  }

  function view(blockedReason = null) {
    const state = snapshot();
    const reason = state.unavailable ? UNAVAILABLE : state.invalid ? INVALID :
      (typeof blockedReason === 'string' && blockedReason ? blockedReason.slice(0, 400) : null);
    const versions = state.enabled ? catalogue() : null;
    const choice = chosenVersion(state);
    const messages = choice ? { ...MESSAGES, ...CHOICE_MESSAGES } : MESSAGES;
    return { enabled: state.enabled, busy: state.busy, phase: state.phase, currentVersion,
      targetVersion: state.status?.targetVersion || null,
      requestId: state.request?.id || state.status?.requestId || null,
      chosenVersion: choice,
      versionChoice: !!versions,
      versions: versions || [],
      blockedReason: reason,
      // Never forward worker stderr or free-form messages to the browser.
      message: state.invalid ? INVALID : state.unavailable ? UNAVAILABLE : messages[state.phase] };
  }

  // Durable before the request that names it: rename over any earlier choice,
  // then persist the directory entry.
  function writeChoice(requestId, version) {
    const temporary = path.join(root, `.target-${requestId}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0), 0o660);
      fs.writeFileSync(fd, `${JSON.stringify({ requestId, version })}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, path.join(root, 'target.json'));
      syncDirectory();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (_) { /* already renamed, or not created */ }
    }
  }

  function syncDirectory() {
    if (process.platform === 'win32') return;
    const directoryFd = fs.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }

  function request(blockedReason = null, { version = null } = {}) {
    const state = snapshot();
    if (!state.enabled || state.unavailable) throw failure(UNAVAILABLE, 503);
    if (state.busy) throw failure(state.invalid ? INVALID : 'Une mise à jour est déjà en cours.', 409);
    if (blockedReason) throw failure(String(blockedReason).slice(0, 400), 409);
    if (version !== null && !offers(version)) throw failure(NOT_OFFERED, 400);
    const pending = { id: crypto.randomUUID(), createdAt: new Date(now()).toISOString() };
    const file = path.join(root, 'request.json');
    const temporary = path.join(root, `.request-${pending.id}.tmp`);
    let fd;
    try {
      if (version !== null) writeChoice(pending.id, version);
      else {
        // A choice of an earlier request can never name this new one; remove
        // it anyway so the folder only describes the current operation.
        try { fs.unlinkSync(path.join(root, 'target.json')); } catch (_) { /* absent */ }
      }
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0), 0o660);
      fs.writeFileSync(fd, `${JSON.stringify(pending)}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      if (state.request) {
        // The single application process performs this synchronously: its
        // second click sees the new request, never the old terminal status.
        const previous = readJson('request.json', validRequest);
        if (previous.invalid || previous.value?.id !== state.request.id) throw failure('Le suivi de la mise à jour a changé. Réessaie.', 409);
        fs.renameSync(temporary, file);
      } else {
        // A hard link publishes the complete JSON atomically, without ever
        // replacing a request created since snapshot().
        fs.linkSync(temporary, file);
      }
      // Persist the new directory entry too: a power loss must not free the
      // maintenance lock after the worker has already begun its transaction.
      syncDirectory();
    } catch (error) {
      if (error.status) throw error;
      if (error.code === 'EEXIST') throw failure('Une mise à jour est déjà en cours.', 409);
      throw failure('Impossible de transmettre la demande au service de mise à jour.', 503);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (_) { /* already renamed, or not created */ }
    }
    return view();
  }

  return { view, request, offers, isBusy: () => snapshot().busy };
}

module.exports = { createServerUpdate, compareVersions, NOT_OFFERED };
