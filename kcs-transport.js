'use strict';

// Canal JSON de la télécommande actuelle. L'URL authentifiée reste en mémoire.
const EventEmitter = require('events');

// Profondeur d'un message de KaraFun : 10 niveaux au plus dans les vraies
// trames (file avec un mode Battle, journaux de septembre et de novembre
// 2026). Au-delà de 32, le contenu est coupé (remplacé par null) : copier ou
// écrire un objet aussi imbriqué épuiserait la pile (structuredClone,
// JSON.stringify). Le reste du message sert : des options trop imbriquées
// dans un seul titre ne font pas ignorer toute la file.
const MAX_DEPTH = 32;
// Texte du message où chaque liste ou objet au-delà de `limit` niveaux (le
// message compris) est remplacé par null ; null quand rien n'est coupé. Un
// texte mal formé le reste, coupé ou non : JSON.parse le dira illisible.
// La coupe se fait dans le texte, avant JSON.parse, en un seul passage sans
// récursion ni pile : une trame très imbriquée n'est jamais construite (deux
// millions de niveaux, 4 Mo de texte, épuisaient la mémoire du serveur, ce
// qu'aucun filet ne rattrape), et une trame très large ne coûte que son texte.
// Aucune propriété n'est écrite sous un nom venu de KaraFun (CodeQL,
// js/remote-property-injection) : JSON.parse construit seul le message.
function cutDeep(text, limit) {
  let depth = 0, inString = false, skipFrom = -1, kept = '', from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++; // \ : le caractère suivant est échappé
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b || c === 0x5b) { // { [
      depth++;
      if (depth > limit && skipFrom < 0) skipFrom = i;
    } else if (c === 0x7d || c === 0x5d) { // } ]
      if (depth === limit + 1 && skipFrom >= 0) {
        kept += text.slice(from, skipFrom) + 'null';
        from = i + 1;
        skipFrom = -1;
      }
      depth--;
    }
  }
  return from === 0 ? null : kept + text.slice(from);
}
// Raison d'une erreur pour le journal, sans rien convertir d'imprévu.
const reasonOf = error => (typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : 'erreur inconnue');

class KcsTransport extends EventEmitter {
  constructor(url) {
    super();
    this.ws = new WebSocket(url, 'kcpj~v3+emuping');
    this.closed = false;
    this.opened = false;
    this.nextId = 0;
    this.lastMessageAt = Date.now();
    this.pending = new Map();
    this.ws.addEventListener('open', () => {
      if (this.closed) return;
      this.opened = true;
      this.lastMessageAt = Date.now();
      this.emit('open');
    });
    this.ws.addEventListener('message', (event) => {
      if (this.closed) return;
      this.lastMessageAt = Date.now();
      const text = String(event.data);
      const cut = cutDeep(text, MAX_DEPTH);
      let message;
      try { message = JSON.parse(cut ?? text); }
      catch { this.emit('transport-error', 'Message KaraFun illisible.'); return; }
      if (!message || typeof message.type !== 'string') return;
      // Identifiant renvoyé tel quel : un nombre ou un texte, jamais un objet.
      const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : undefined;
      // Message coupé au-delà de 32 niveaux : signalé au pont, qui le note
      // dans le journal de KaraFun, puis lu comme les autres.
      if (cut !== null) {
        try { this.emit('message-pruned', message.type); } catch { /* rien de plus à faire */ }
      }
      // Filet : l'erreur d'un écouteur du WebSocket, Node la relance hors de
      // toute portée et le serveur du bar s'arrêterait. Le message est
      // ignoré ('message-error') et la lecture continue : Ping et réponses
      // servent.
      try { this.emit('message', message); } catch (error) { this._ignore(message.type, error); }
      if (this.closed) return;
      // Connexion déjà en train de se fermer : plus de réponse possible, et ce
      // n'est pas un message illisible.
      const open = this.ws.readyState === WebSocket.OPEN;
      try {
        if (message.type === 'core.PingRequest') {
          if (open) this._send('core.PingResponse', {}, id);
        } else if (message.type === 'core.TimestampRequest') {
          if (open) this._send('core.TimestampResponse', { timestamp: { _type: 'timestamp', value: new Date().toISOString() } }, id);
        } else if (this.pending.has(id)) {
          // Réponse (ou Error) portant l'identifiant d'une demande : elle est
          // rattachée à cette demande, pour que le pont sache laquelle a réussi.
          const request = this.pending.get(id);
          clearTimeout(request.timer);
          this.pending.delete(id);
          this.emit('reply', request.type, message);
        }
      } catch (error) { this._ignore(message.type, error); }
    });
    this.ws.addEventListener('error', () => {
      if (!this.closed) this.emit('transport-error', 'Connexion WebSocket KaraFun interrompue.');
    });
    this.ws.addEventListener('close', (event) => {
      if (this.closed) return;
      this._stop();
      this.emit('close', { code: event.code });
    });
    this.watchdog = setInterval(() => {
      if (this.isStale()) {
        this.emit('stale', 'KaraFun ne répond plus ; reconnexion en cours.');
        this.close();
      }
    }, 2000);
    this.watchdog.unref();
  }

  // KaraFun muet plus longtemps que le chien de garde ne l'accepte : 10 s une fois ouvert,
  // 15 s avant. La sonde de la télécommande (test/probe-kcs.js) le demande aussi à la fin
  // de son essai, entre deux passages du chien de garde.
  isStale() {
    return Date.now() - this.lastMessageAt > (this.opened ? 10000 : 15000);
  }

  // Message ignoré : signalé au pont, qui le note dans ses journaux. Une erreur
  // de ce signalement même ne sort pas non plus de l'écouteur.
  _ignore(type, error) {
    try { this.emit('message-error', type, reasonOf(error)); } catch { /* rien de plus à faire */ }
  }

  _send(type, payload, id) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) throw new Error('Pas connecté à KaraFun');
    const message = { ...(id === undefined ? {} : { id }), type, payload };
    this.emit('out', message);
    this.ws.send(JSON.stringify(message));
  }

  // Demande numérotée. Sans réponse au bout de 8 s : 'request-timeout' avec
  // son type et son identifiant ; le pont décide si c'est grave.
  send(type, payload = {}) {
    const id = ++this.nextId;
    this._send(type, payload, id);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      if (!this.closed) this.emit('request-timeout', type, id);
    }, 8000);
    timer.unref();
    this.pending.set(id, { type, timer });
    return id;
  }

  // Type de la demande encore en attente sous cet identifiant, sinon null.
  requestType(id) {
    return this.pending.get(id)?.type ?? null;
  }

  // Réponse de KaraFun sans identifiant (une Error, par exemple) : elle
  // répond à la plus ancienne demande de ce type encore en attente.
  settle(type) {
    for (const [id, request] of this.pending) {
      if (request.type !== type) continue;
      clearTimeout(request.timer);
      this.pending.delete(id);
      return true;
    }
    return false;
  }

  _stop() {
    this.closed = true;
    clearInterval(this.watchdog);
    for (const request of this.pending.values()) clearTimeout(request.timer);
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this._stop();
    this.ws.close();
  }
}

module.exports = { KcsTransport };
