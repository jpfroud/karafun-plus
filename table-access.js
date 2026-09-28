'use strict';

const crypto = require('crypto');

// A link proves possession of the table QR. A bare, guessable table number does not.
class TableAccess {
  #secrets = new Map();
  #dummy = crypto.randomBytes(16).toString('base64url');

  static key(id) {
    const key = String(id == null ? '' : id).trim();
    if (!key || key.length > 20 || /[\/\\?#\x00-\x1f]/.test(key)) {
      throw new Error('Identifiant de table invalide');
    }
    return key;
  }

  // Each issue rotates the capability. Previously printed/scanned links stop working.
  issue(id) {
    const secret = crypto.randomBytes(16).toString('base64url');
    this.#secrets.set(TableAccess.key(id), secret);
    return secret;
  }

  restore(id, secret) {
    const key = TableAccess.key(id);
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(secret)) {
      throw new Error('Secret de table invalide');
    }
    this.#secrets.set(key, secret);
  }

  get(id) {
    try { return this.#secrets.get(TableAccess.key(id)) || null; }
    catch (_) { return null; }
  }

  verify(id, secret) {
    let key;
    try { key = TableAccess.key(id); }
    catch (_) { return false; }
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(secret)) return false;
    const known = this.#secrets.get(key);
    const digest = (value) => crypto.createHash('sha256').update(value).digest();
    return crypto.timingSafeEqual(digest(known || this.#dummy), digest(secret)) && !!known;
  }

  revoke(id) {
    try { return this.#secrets.delete(TableAccess.key(id)); }
    catch (_) { return false; }
  }

  url(base, id) {
    const key = TableAccess.key(id);
    const secret = this.#secrets.get(key);
    if (!secret) throw new Error('QR non émis pour cette table');
    const root = String(base || '').replace(/\/+$/, '');
    if (!root) throw new Error('Adresse du serveur manquante');
    return `${root}/t/${encodeURIComponent(key)}/${secret}`;
  }
}

module.exports = { TableAccess };
