'use strict';

const crypto = require('crypto');
const net = require('net');

const SECRET_RE = /^[A-Za-z0-9_-]{22}$/;
// Garde-fous d'un QR commun qui circulerait hors du bar : la sauvegarde et la
// page du bar restent lisibles même si quelqu'un scanne en boucle. Un même
// appareil (adresse IPv4, ou préfixe /64 en IPv6, voir clientKey) crée au plus
// 30 chanteurs par minute (assez pour un Wi-Fi qui sort par une seule adresse
// publique), tout le bar 120 ; au plus 400 personnes présentes venues par
// l'événement, dont les places sans prénom des 10 dernières minutes, et au
// plus 800 fiches venues par l'événement (pas parties), quel que soit leur âge.
const CREATIONS_PER_MINUTE = 120;
const CLIENT_CREATIONS_PER_MINUTE = 30;
const MAX_PEOPLE = 400;
const MAX_EVENT_PEOPLE = 2 * MAX_PEOPLE;
const PLACEHOLDER_COUNT_MS = 10 * 60000;

// Appareil d'une adresse réseau : l'adresse IPv4 (aussi quand elle arrive
// mappée, ::ffff:a.b.c.d), ou les quatre premiers groupes d'une adresse IPv6
// (un téléphone change d'adresse dans son /64). Texte inconnu : gardé, borné.
function clientKey(address) {
  let text = String(address ?? '').trim().toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (net.isIPv4(text)) return text;
  if (!net.isIPv6(text)) return text.slice(0, 64);
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${(a << 8 | b).toString(16)}:${(c << 8 | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(word => parseInt(word, 16));
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.');
  }
  return `${words.slice(0, 4).map(word => word.toString(16)).join(':')}::/64`;
}

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

  // Personnes qui comptent dans le plafond : venues par l'événement, présentes,
  // nommées ; une place encore sans prénom seulement pendant 10 minutes (elle
  // reste nommable ensuite, sans plus occuper l'événement).
  static present(people, now = Date.now()) {
    let count = 0;
    for (const person of people) {
      if (!person?.viaEvent || person.withdrawnAt) continue;
      if (!person.nameRequired || now - (Number(person.joinedAt) || 0) < PLACEHOLDER_COUNT_MS) count++;
    }
    return count;
  }

  // Place sans prénom du QR de l'événement abandonnée : ouverte il y a 10
  // minutes ou plus (elle ne compte déjà plus), jamais relue par sa page
  // (lastSeen au plus une seconde après l'ouverture : touchSeen le change dès
  // la première relecture visible qui suit cette seconde) et sans aucune
  // action. Ni partie
  // (laissée au bar), ni venue par un QR personnel. Le serveur vérifie en plus
  // qu'elle n'a aucun titre, puis la retire sans trace avant chaque création.
  static abandoned(person, now = Date.now()) {
    if (!person?.viaEvent || !person.nameRequired || person.withdrawnAt || person.soloKeyHash || person.lastActionAt) return false;
    const joinedAt = Number(person.joinedAt) || 0;
    return now - joinedAt >= PLACEHOLDER_COUNT_MS && (Number(person.lastSeen) || 0) <= joinedAt + 1000;
  }

  // Fiches venues par l'événement et pas parties, nommées ou non, de tout âge.
  static held(people) {
    let count = 0;
    for (const person of people) if (person?.viaEvent && !person.withdrawnAt) count++;
    return count;
  }

  // Avant de créer un chanteur : `total` = personnes qui comptent (present),
  // `client` = appareil (clientKey ; null : inconnu, seule la limite du bar
  // compte), `held` = fiches de l'événement (held). « ok », « busy » (trop de
  // créations dans la minute : réessayer) ou « full » (plafond de personnes).
  admit(total, client, now = Date.now(), held = 0) {
    this.recent = this.recent.filter(entry => now - entry.at < 60000);
    if (total >= MAX_PEOPLE || held >= MAX_EVENT_PEOPLE) return 'full';
    if (this.recent.length >= CREATIONS_PER_MINUTE || (client !== null &&
      this.recent.filter(entry => entry.client === client).length >= CLIENT_CREATIONS_PER_MINUTE)) return 'busy';
    this.recent.push({ at: now, client });
    return 'ok';
  }

  // Après « busy » : secondes avant qu'une création se libère, au moins 1
  // (en-tête Retry-After).
  retryAfter(client, now = Date.now()) {
    const recent = this.recent.filter(entry => now - entry.at < 60000);
    const own = client === null ? [] : recent.filter(entry => entry.client === client);
    const waits = [0];
    if (recent.length >= CREATIONS_PER_MINUTE) waits.push(recent[recent.length - CREATIONS_PER_MINUTE].at + 60000 - now);
    if (own.length >= CLIENT_CREATIONS_PER_MINUTE) waits.push(own[own.length - CLIENT_CREATIONS_PER_MINUTE].at + 60000 - now);
    return Math.max(1, Math.ceil(Math.max(...waits) / 1000));
  }

  // Création annulée (sauvegarde impossible) : elle ne compte pas.
  release(at, client) {
    for (let index = this.recent.length - 1; index >= 0; index--) {
      if (this.recent[index].at === at && this.recent[index].client === client) { this.recent.splice(index, 1); return; }
    }
  }

  serialize() {
    return this.secret ? { enabled: this.enabled, secret: this.secret, since: this.since } : null;
  }
}

module.exports = { PrivateEvent, CREATIONS_PER_MINUTE, CLIENT_CREATIONS_PER_MINUTE, MAX_PEOPLE, MAX_EVENT_PEOPLE, PLACEHOLDER_COUNT_MS, clientKey };
