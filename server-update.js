'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The application can request one fixed operation. Only the host agent has
// Docker access; no command, repository, image or version crosses this channel.
const MAX_FILE_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^v\d+\.\d+\.\d+$/;
const TERMINAL = new Set(['succeeded', 'failed', 'rolled-back']);
const PHASES = new Set(['idle', 'checking', 'downloading', 'backing-up', 'installing', 'verifying', ...TERMINAL]);
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
const UNAVAILABLE = 'Le service de mise à jour n’est pas disponible sur ce serveur.';
const INVALID = 'Le suivi de la mise à jour est illisible. Un administrateur doit vérifier le serveur.';

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

  function view(blockedReason = null) {
    const state = snapshot();
    const reason = state.unavailable ? UNAVAILABLE : state.invalid ? INVALID :
      (typeof blockedReason === 'string' && blockedReason ? blockedReason.slice(0, 400) : null);
    return { enabled: state.enabled, busy: state.busy, phase: state.phase, currentVersion,
      targetVersion: state.status?.targetVersion || null,
      requestId: state.request?.id || state.status?.requestId || null,
      blockedReason: reason,
      // Never forward worker stderr or free-form messages to the browser.
      message: state.invalid ? INVALID : state.unavailable ? UNAVAILABLE : MESSAGES[state.phase] };
  }

  function request(blockedReason = null) {
    const state = snapshot();
    if (!state.enabled || state.unavailable) throw failure(UNAVAILABLE, 503);
    if (state.busy) throw failure(state.invalid ? INVALID : 'Une mise à jour est déjà en cours.', 409);
    if (blockedReason) throw failure(String(blockedReason).slice(0, 400), 409);
    const pending = { id: crypto.randomUUID(), createdAt: new Date(now()).toISOString() };
    const file = path.join(root, 'request.json');
    const temporary = path.join(root, `.request-${pending.id}.tmp`);
    let fd;
    try {
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
      if (process.platform !== 'win32') {
        // Persist the new directory entry too: a power loss must not free the
        // maintenance lock after the worker has already begun its transaction.
        const directoryFd = fs.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
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

  return { view, request, isBusy: () => snapshot().busy };
}

module.exports = { createServerUpdate };
