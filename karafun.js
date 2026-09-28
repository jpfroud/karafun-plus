'use strict';
/* Pont vers la télécommande KaraFun : KCS JSON actuel, socket.io v2 historique
 * et démo. Découverte des paramètres officiels sans exécuter de code distant. */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const io = require('socket.io-client');
const { KcsTransport } = require('./kcs-transport');

function readSettings(html) {
  const match = /\b(?:const|var|let)\s+Settings\s*=\s*\{/.exec(html);
  if (!match) return null;
  const start = match.index + match[0].lastIndexOf('{');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('Paramètres de télécommande incomplets.');
}

function normalizeKcsItem(item) {
  const song = item.song || {}, quiz = item.quiz || {};
  return {
    queueId: String(item.id), id: String(item.id), songId: song.id && song.id.id,
    title: song.title || quiz.title || '', artist: song.artist || '',
    singer: song.options && song.options.singer || '', options: song.options || {},
    ...(quiz.id ? { quizId: quiz.id.id } : {}),
  };
}

class KaraFunBridge extends EventEmitter {
  constructor({ logDir, bases } = {}) {
    super();
    this.bases = bases || ['https://www.karafun.com', 'https://www.karafun.fr'];
    this.baseIdx = 0;
    this.logDir = logDir;
    this.code = null;
    this.socket = null;
    this.connected = false;
    this.ready = false;
    this.unreachable = false;
    this.queue = [];
    this.status = this.permissions = this.preferences = null;
    this.raw = {};
    this.protocol = null;
    this.lastEventAt = 0;
    this.lastError = null;
    this.events = [];
    this.retryTimer = null;
    this.loginSuffix = Math.floor(1000 + Math.random() * 9000);
    this._generation = 0;
    this._attempt = 0;
    this._fresh = { queue: false, status: false };
  }

  get base() { return this.bases[this.baseIdx % this.bases.length]; }

  _record(dir, name, data) {
    const entry = { t: new Date().toISOString(), dir, name, data };
    this.events.push(entry);
    if (this.events.length > 200) this.events.shift();
    if (this.logDir) {
      try { fs.appendFileSync(path.join(this.logDir, `karafun-${entry.t.slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n'); }
      catch { /* journal best-effort */ }
    }
  }

  connect(code) {
    code = String(code || '').replace(/\D/g, '');
    if (!code) throw new Error('Code KaraFun manquant');
    this.disconnect();
    this.code = code;
    this.queue = [];
    this.status = this.permissions = this.preferences = null;
    this.raw = {};
    this._open();
  }

  async _open() {
    clearTimeout(this.retryTimer);
    const generation = this._generation, attempt = ++this._attempt;
    const active = () => generation === this._generation && attempt === this._attempt;
    const base = this.base;
    this._fresh = { queue: false, status: false };
    this.ready = false;
    this.connected = false;
    this._record('info', 'connexion', { base, code: this.code });
    // Le faux KaraFun local n'a pas de page de découverte.
    if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) {
      this._openLegacy(base, active);
      return;
    }
    try {
      const response = await fetch(`${base}/${this.code}/`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Réponse HTTP inattendue');
      const settings = readSettings(await response.text());
      if (!active()) return;
      if (!settings) throw new Error('Session fermée ou code modifié');
      if (settings.kcs_url) {
        if (new URL(settings.kcs_url).protocol !== 'wss:') throw new Error('Adresse inattendue');
        this._openKcs(settings.kcs_url, active);
      } else this._openLegacy(base, active);
    } catch {
      if (!active()) return;
      // Ne jamais journaliser le HTML ou l'URL KCS : ils contiennent un jeton.
      this.lastError = 'Télécommande KaraFun injoignable : vérifie le code affiché et la connexion Internet.';
      this.unreachable = true;
      this._record('info', 'discovery-error', this.lastError);
      if (this.bases.length > 1) this.baseIdx++;
      this._retry(5000);
    }
  }

  _retry(delay = 3000) {
    this._attempt++;
    this._closeSocket();
    this.connected = this.ready = false;
    clearTimeout(this.retryTimer);
    const generation = this._generation;
    this.retryTimer = setTimeout(() => { if (generation === this._generation) this._open(); }, delay);
    this.emit('change');
  }

  _accept(name, data) {
    this[name] = data;
    if (name === 'queue' || name === 'status') {
      this._fresh[name] = true;
      this.ready = this._fresh.queue && this._fresh.status;
      if (this.ready) { this.unreachable = false; this.lastError = null; }
      this.emit(name, data);
    }
    this.emit('change');
  }

  _openKcs(url, active) {
    this.protocol = 'kcs';
    const socket = new KcsTransport(url);
    this.socket = socket;
    // KaraFun garde parfois l'ancien nom quelques secondes après une coupure.
    // Chaque nouvelle connexion doit donc choisir une autre identité.
    this.loginSuffix = Math.floor(1000 + Math.random() * 9000);
    let usernameRetries = 0;
    const updateUsername = () => socket.send('remote.UpdateUsernameRequest', { username: `FileKaraoke-${this.loginSuffix}` });
    socket.on('open', () => {
      if (!active()) return;
      this.connected = true;
      this.lastError = null;
      this.emit('change');
      // Les snapshots arrivent par événements. KaraFun 3.12 refuse les requêtes
      // QueueRequest/StatusRequest pourtant décrites dans le SDK de la page.
    });
    socket.on('out', m => { if (active()) this._record('out', m.type, m.payload); });
    socket.on('message', m => {
      if (!active()) return;
      this.lastEventAt = Date.now();
      this._record('in', m.type, m.payload);
      const p = m.payload || {};
      if (m.type === 'core.AuthenticatedEvent') {
        updateUsername();
      } else if (m.type === 'remote.UsernameUpdateEvent' || m.type === 'remote.UpdateUsernameResponse') {
        this.lastError = null;
        this.emit('change');
      } else if (m.type === 'remote.QueueEvent' || m.type === 'remote.QueueResponse') {
        if (!p.queue || !Array.isArray(p.queue.items)) return;
        this.raw.queue = p.queue;
        this._accept('queue', p.queue.items.map(normalizeKcsItem));
      } else if (m.type === 'remote.StatusEvent' || m.type === 'remote.StatusResponse') {
        if (!p.status || typeof p.status.state !== 'number') return;
        const status = p.status || {};
        this.raw.status = status;
        this._accept('status', {
          ...status,
          state: ({ 1: 'idle', 2: 'loading', 3: 'idle', 4: 'playing', 5: 'paused' })[status.state] || 'idle',
          current: status.current ? normalizeKcsItem(status.current) : null,
        });
      } else if (m.type === 'remote.PermissionsUpdateEvent') {
        this.raw.permissions = p.permissions;
        const v = p.permissions || {};
        this._accept('permissions', { ...v, managePlayer: !!v.managePlayback, manageKaraoke: !!v.manageVolumes, uploadPicture: !!v.sendPhotos });
      } else if (m.type === 'remote.PreferencesUpdateEvent') {
        this.raw.preferences = p.preferences;
        this._accept('preferences', { ...p.preferences, askSingerName: !!(p.preferences && p.preferences.askOptions) });
      } else if (m.type === 'remote.ConfigurationUpdateEvent') {
        this.raw.configuration = p.configuration;
      } else if (m.type === 'remote.AppLeftEvent') {
        this.unreachable = true;
        this.lastError = 'KaraFun est fermé ou sa télécommande a été désactivée.';
        this._retry(3000);
      } else if (m.type === 'Error') {
        if (p.type === 4 && /username is already used/i.test(p.message || '') && usernameRetries++ < 5) {
          this.loginSuffix = Math.floor(1000 + Math.random() * 9000);
          updateUsername();
          return;
        }
        this.lastError = `Commande KaraFun refusée : ${p.message || p.type || 'erreur inconnue'}`;
        this.emit('change');
      }
    });
    const lost = message => {
      if (!active()) return;
      this.unreachable = true;
      this.lastError = message;
      this._record('info', 'connexion-perdue', message);
      this._retry(3000);
    };
    socket.on('stale', lost);
    socket.on('request-timeout', type => lost(`KaraFun ne confirme plus les commandes (${type}) ; reconnexion en cours.`));
    socket.on('transport-error', message => {
      if (!active()) return;
      this.lastError = message;
      this._record('info', 'connect_error', message);
      this.emit('change');
    });
    socket.on('close', ({ code }) => lost(`Télécommande KaraFun déconnectée (code ${code}). Vérifie le code affiché dans KaraFun.`));
  }

  _openLegacy(base, active) {
    this.protocol = 'socket.io';
    const socket = io(base, {
      query: { remote: `kf${this.code}` }, transports: ['polling', 'websocket'],
      forceNew: true, reconnection: false, timeout: 15000,
    });
    this.socket = socket;
    const onevent = socket.onevent;
    socket.onevent = packet => {
      if (!active()) return;
      const args = packet.data || [];
      this.lastEventAt = Date.now();
      this._record('in', args[0], args[1]);
      onevent.call(socket, packet);
    };
    socket.on('connect', () => {
      if (!active()) return;
      this.connected = true;
      this.lastError = null;
      this._auth();
      this.emit('change');
    });
    socket.on('connect_error', err => {
      if (!active()) return;
      this.lastError = `Connexion impossible à ${base} : ${err && err.message}`;
      this._record('info', 'connect_error', this.lastError);
      if (this.bases.length > 1) this.baseIdx++;
      this._retry(3000);
    });
    socket.on('disconnect', reason => {
      if (!active()) return;
      this._record('info', 'disconnect', reason);
      this._retry(3000);
    });
    socket.on('loginAlreadyTaken', () => {
      if (!active()) return;
      this.loginSuffix = Math.floor(1000 + Math.random() * 9000);
      this._auth();
    });
    const unreachable = () => {
      if (!active()) return;
      this.unreachable = true;
      this.lastError = 'KaraFun ne répond pas pour ce code : vérifie que KaraFun est ouvert et que le code est le bon.';
      if (this.bases.length > 1) this.baseIdx++;
      this._retry(5000);
    };
    socket.on('serverUnreacheable', unreachable);
    socket.on('serverUnreachable', unreachable);
    for (const name of ['permissions', 'preferences', 'status', 'queue']) {
      socket.on(name, data => {
        if (!active()) return;
        this.raw[name] = data;
        this._accept(name, name === 'queue' ? (Array.isArray(data) ? data : []) : data);
      });
    }
  }

  _auth() {
    const payload = { login: `FileKaraoke-${this.loginSuffix}`, channel: this.code, role: 'participant', app: 'karafun', socket_id: null };
    this._record('out', 'authenticate', payload);
    this.socket.emit('authenticate', payload, null);
  }

  _closeSocket() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
  }

  disconnect() {
    this._generation++;
    clearTimeout(this.retryTimer);
    this._closeSocket();
    this.connected = this.ready = false;
  }

  _emit(name, payload) {
    if (!this.socket || !this.connected || !this.ready) throw new Error('Pas connecté à KaraFun');
    if (this.protocol === 'kcs') {
      const messages = {
        queueAdd: ['remote.AddToQueueRequest', payload && { song: { type: 1, id: payload.songId }, options: { singer: payload.singer }, position: payload.pos }],
        queueRemove: ['remote.RemoveFromQueueRequest', { queueItemId: String(payload) }],
        queueMove: ['remote.MoveInQueueRequest', payload && { queueItemId: String(payload.queueId), to: payload.to }],
        play: ['remote.PlayRequest', {}], next: ['remote.NextRequest', {}],
      };
      const mapped = messages[name];
      if (!mapped) throw new Error('Commande KaraFun inconnue');
      this.socket.send(...mapped);
    } else {
      this._record('out', name, payload);
      this.socket.emit(name, payload);
    }
  }

  add(songId, singer, pos = 99999) { this._emit('queueAdd', { songId: Number(songId), pos, singer: String(singer || '') }); }
  remove(queueId) { this._emit('queueRemove', queueId); }
  move(queueId, from, to) { this._emit('queueMove', { queueId, from, to }); }
  play() { this._emit('play', null); }
  next() { this._emit('next', null); }

  async search(q) {
    if (!this.code) throw new Error('Pas de code KaraFun');
    let lastErr;
    for (let k = 0; k < this.bases.length; k++) {
      const base = this.bases[(this.baseIdx + k) % this.bases.length];
      const u = `${base}/${this.code}/?type=search&q=${encodeURIComponent(q)}&types=karaoke`;
      try {
        const res = await fetch(u, { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(8000) });
        let data;
        try { data = JSON.parse(await res.text()); } catch { throw new Error(`Réponse inattendue (${res.status})`); }
        if (!this._searchLogged) { this._searchLogged = true; this._record('info', 'search-sample', Array.isArray(data) ? data.slice(0, 2) : data); }
        return normalizeResults(data);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Recherche impossible');
  }

  snapshot() {
    return {
      code: this.code, username: `FileKaraoke-${this.loginSuffix}`,
      base: this.base, protocol: this.protocol, connected: this.connected, ready: this.ready,
      unreachable: this.unreachable, lastError: this.lastError, lastEventAt: this.lastEventAt,
      queue: this.queue, status: this.status, permissions: this.permissions, preferences: this.preferences,
      raw: this.raw, events: this.events.slice(-40),
    };
  }
}

function normalizeResults(data) {
  const arr = Array.isArray(data) ? data : (data && (data.songs || data.results || data.items || data.data)) || [];
  const str = v => (typeof v === 'string' ? v : (v && (v.name || v.title)) || '');
  return arr.map(s => ({
    songId: Number(s.songId || s.id || s.song_id || (s.song && s.song.id)),
    title: str(s.title) || str(s.name) || str(s.song && s.song.title),
    artist: str(s.artist) || str(s.artist_name) || str(s.song && s.song.artist) || str(s.artists && s.artists[0]),
    img: typeof (s.img || s.image || s.cover) === 'string' ? (s.img || s.image || s.cover) : null,
    duration: s.duration || null, duo: !!(s.duo || s.duet),
  })).filter(s => s.songId && s.title).slice(0, 40);
}

module.exports = { KaraFunBridge, normalizeResults, readSettings, normalizeKcsItem };
