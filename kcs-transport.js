'use strict';

// Canal JSON de la télécommande actuelle. L'URL authentifiée reste en mémoire.
const EventEmitter = require('events');

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
      let message;
      try { message = JSON.parse(String(event.data)); }
      catch { this.emit('transport-error', 'Message KaraFun illisible.'); return; }
      if (!message || typeof message.type !== 'string') return;
      this.emit('message', message);
      if (this.closed) return;
      if (message.type === 'core.PingRequest') {
        this._send('core.PingResponse', {}, message.id);
      } else if (message.type === 'core.TimestampRequest') {
        this._send('core.TimestampResponse', { timestamp: { _type: 'timestamp', value: new Date().toISOString() } }, message.id);
      } else if (this.pending.has(message.id)) {
        clearTimeout(this.pending.get(message.id));
        this.pending.delete(message.id);
      }
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
      if (Date.now() - this.lastMessageAt > (this.opened ? 10000 : 15000)) {
        this.emit('stale', 'KaraFun ne répond plus ; reconnexion en cours.');
        this.close();
      }
    }, 2000);
    this.watchdog.unref();
  }

  _send(type, payload, id) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) throw new Error('Pas connecté à KaraFun');
    const message = { ...(id === undefined ? {} : { id }), type, payload };
    this.emit('out', message);
    this.ws.send(JSON.stringify(message));
  }

  send(type, payload = {}) {
    const id = ++this.nextId;
    this._send(type, payload, id);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      if (!this.closed) this.emit('request-timeout', type);
    }, 8000);
    timer.unref();
    this.pending.set(id, timer);
  }

  _stop() {
    this.closed = true;
    clearInterval(this.watchdog);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this._stop();
    this.ws.close();
  }
}

module.exports = { KcsTransport };
