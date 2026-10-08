'use strict';

const crypto = require('crypto');

const SECRET_RE = /^[A-Za-z0-9_-]{22}$/;
// Garde-fous d'un QR commun qui circulerait hors du bar : la sauvegarde et la
// page du bar restent lisibles même si quelqu'un scanne en boucle.
const CREATIONS_PER_MINUTE = 30;
const MAX_PEOPLE = 400;

// Événement privé (bar privatisé) : un seul QR pour tout le monde, qui crée un
// chanteur « En solo » à chaque nouveau navigateur. Le secret est gardé en
// clair (comme les secrets des tables) : la page du bar doit pouvoir refaire le
// QR après un redémarrage. Il n'est accepté que tant que le mode est allumé.
class PrivateEvent {
  constructor(saved = null) {
    this.recent = [];
    this.restore(saved);
  }

  // Forme sauvegardée valable, ou null (mode coupé, secret oublié).
  static normalize(saved) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
      typeof saved.enabled !== 'boolean' || typeof saved.secret !== 'string' ||
      !SECRET_RE.test(saved.secret) || !Number.isFinite(saved.since)) return null;
    return { enabled: saved.enabled, secret: saved.secret, since: saved.since };
  }

  // Jamais d'exception : une forme abîmée coupe le mode sans gêner la soirée.
  restore(saved) {
    const valid = PrivateEvent.normalize(saved);
    this.enabled = valid ? valid.enabled : false;
    this.secret = valid ? valid.secret : null;
    this.since = valid ? valid.since : null;
  }

  // Rallumer garde le secret : le QR déjà imprimé reste valable.
  enable() {
    if (!this.secret) this.secret = crypto.randomBytes(16).toString('base64url');
    if (!this.enabled) { this.enabled = true; this.since = Date.now(); }
    return this.secret;
  }

  disable() { this.enabled = false; }

  // « Renouveler le QR » : l'ancien est refusé, les inscrits gardent leur accès.
  rotate() {
    if (!this.enabled) throw new Error('Active d’abord l’événement privé.');
    this.secret = crypto.randomBytes(16).toString('base64url');
    return this.secret;
  }

  clear() {
    this.enabled = false;
    this.secret = null;
    this.since = null;
    this.recent = [];
  }

  verify(token) {
    if (!this.enabled || !this.secret || typeof token !== 'string' || !SECRET_RE.test(token)) return false;
    const digest = value => crypto.createHash('sha256').update(value).digest();
    return crypto.timingSafeEqual(digest(this.secret), digest(token));
  }

  // Avant de créer un chanteur : `total` = personnes déjà venues par
  // l'événement. Faux = plafond atteint (le serveur répond au téléphone).
  admit(total, now = Date.now()) {
    this.recent = this.recent.filter(at => now - at < 60000);
    if (total >= MAX_PEOPLE || this.recent.length >= CREATIONS_PER_MINUTE) return false;
    this.recent.push(now);
    return true;
  }

  // Création annulée (sauvegarde impossible) : elle ne compte pas.
  release(at) {
    const index = this.recent.lastIndexOf(at);
    if (index >= 0) this.recent.splice(index, 1);
  }

  serialize() {
    return this.secret ? { enabled: this.enabled, secret: this.secret, since: this.since } : null;
  }
}

module.exports = { PrivateEvent, CREATIONS_PER_MINUTE, MAX_PEOPLE };
