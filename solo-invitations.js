'use strict';

const crypto = require('crypto');
const { TableAccess } = require('./table-access');

const LIFE_MS = 30 * 60 * 1000;
// Les versions précédentes lisaient l'horloge deux fois à l'émission : une
// sauvegarde peut donc porter une durée de vie supérieure de quelques
// millisecondes. Cette marge l'accepte sans admettre une durée prolongée.
const CLOCK_SLACK_MS = 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
// Garde-fou technique de la sauvegarde, pas un nombre de places : un QR
// expire en 30 minutes, 2 400 invitations en attente ne se produisent pas.
const MAX_PENDING = 2400;

// Le QR commun ne donne aucun droit d'inscription. Seule une invitation émise
// par le bar crée une place, et son secret ne figure jamais dans l'état public.
class SoloInvitations {
  constructor(saved = []) {
    this.entries = new Map();
    this.restore(saved);
  }

  static digest(token) {
    return typeof token === 'string' && TOKEN_RE.test(token) ?
      crypto.createHash('sha256').update(token).digest('hex') : null;
  }

  prune(now = Date.now()) {
    for (const [hash, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(hash);
  }

  // `limit` : nombre de places encore libres, sans limite par défaut.
  issue(tableId, limit = Infinity) {
    this.prune();
    const table = TableAccess.key(tableId);
    const pending = [...this.entries.values()].filter(entry => entry.tableId === table).length;
    if (!(limit === Infinity || (Number.isInteger(limit) && limit >= 1)) || pending >= limit) {
      throw new Error('Toutes les places en solo disponibles ont déjà une invitation. Annule une invitation ou libère une place.');
    }
    if (this.entries.size >= MAX_PENDING) throw new Error('Trop d’invitations en attente : annules-en quelques-unes.');
    const token = crypto.randomBytes(24).toString('base64url');
    const hash = SoloInvitations.digest(token);
    // Une seule lecture de l'horloge : deux lectures peuvent tomber de part et
    // d'autre d'une milliseconde et rendre la sauvegarde illisible.
    const now = Date.now();
    const entry = { id: hash.slice(0, 12), hash, tableId: table,
      issuedAt: now, expiresAt: now + LIFE_MS };
    this.entries.set(hash, entry);
    return { token, id: entry.id, expiresAt: entry.expiresAt };
  }

  verify(token, tableId) {
    const hash = SoloInvitations.digest(token);
    if (!hash) return null;
    const entry = this.entries.get(hash);
    return entry && entry.tableId === tableId && entry.expiresAt > Date.now() ? entry : null;
  }

  consume(token, tableId) {
    const entry = this.verify(token, tableId);
    if (!entry) return false;
    this.entries.delete(entry.hash);
    return true;
  }

  revoke(id) {
    for (const [hash, entry] of this.entries) {
      if (entry.id === id) { this.entries.delete(hash); return true; }
    }
    return false;
  }

  revokeTable(tableId) {
    for (const [hash, entry] of this.entries) if (entry.tableId === tableId) this.entries.delete(hash);
  }

  clear() { this.entries.clear(); }

  view() {
    this.prune();
    return [...this.entries.values()].map(({ id, tableId, issuedAt, expiresAt }) =>
      ({ id, tableId, issuedAt, expiresAt }));
  }

  serialize() {
    this.prune();
    return [...this.entries.values()].map(entry => ({ ...entry }));
  }

  restore(saved) {
    if (!Array.isArray(saved)) throw new Error('Invitations solo invalides.');
    const next = new Map();
    for (const entry of saved) {
      if (!entry || typeof entry !== 'object' ||
        typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash) ||
        entry.id !== entry.hash.slice(0, 12) ||
        typeof entry.tableId !== 'string' || TableAccess.key(entry.tableId) !== entry.tableId ||
        !Number.isFinite(entry.issuedAt) || !Number.isFinite(entry.expiresAt) ||
        entry.expiresAt <= entry.issuedAt || entry.expiresAt - entry.issuedAt > LIFE_MS + CLOCK_SLACK_MS ||
        next.has(entry.hash)) throw new Error('Invitations solo invalides.');
      if (entry.expiresAt > Date.now()) next.set(entry.hash, { ...entry });
    }
    if (next.size > MAX_PENDING) throw new Error('Trop d’invitations solo en attente.');
    this.entries = next;
  }
}

module.exports = { SoloInvitations };
