'use strict';
// Musique d'ambiance Spotify pendant les silences du karaoké.
//
// L'application parle à l'API Web de Spotify (Spotify Connect) : elle lit
// l'état réel du lecteur avant d'agir, et commande l'appareil choisi par le
// bar, où qu'il soit (ce PC, celui de KaraFun ou une enceinte connectée).
// La connexion utilise le parcours PKCE : seul l'identifiant public de
// l'application Spotify du bar est nécessaire, jamais de secret. Le jeton de
// renouvellement reste dans data/ et n'est jamais renvoyé à la page.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'user-read-playback-state user-modify-playback-state';
const DEFAULTS = { autoResume: true, autoPause: true, resumeDelaySec: 15 };
// Après un échec, plus d'appel automatique pendant 30 s, puis 1, 2, 4 min…
const BACKOFF_FIRST_MS = 30000;
const BACKOFF_MAX_MS = 5 * 60000;

class SpotifyError extends Error {
  constructor(message, { status = 0, retryAfterSec = 0 } = {}) {
    super(message);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

// Messages lisibles au bar pour les réponses connues de Spotify.
function explain(status, reason = '') {
  if (status === 401) return 'Connexion Spotify expirée : reconnecte Spotify depuis la page du bar.';
  if (status === 403) return /PREMIUM/i.test(reason) ? 'Spotify refuse la commande : un abonnement Premium est nécessaire.' :
    'Spotify refuse la commande pour ce compte.';
  if (status === 404) return 'Aucun appareil Spotify actif : ouvre Spotify sur l’appareil choisi, puis réessaie.';
  if (status === 429) return 'Spotify demande de patienter avant la prochaine commande.';
  return `Spotify ne répond pas correctement (${status || 'réseau'}).`;
}

class SpotifyLink {
  constructor({ file = null, fetchImpl = globalThis.fetch, now = Date.now, log = () => {} } = {}) {
    this.file = file;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
    this.config = { clientId: '', refreshToken: '', deviceId: '', deviceName: '', ...DEFAULTS };
    this.access = null;       // { token, expiresAt } en mémoire seulement
    this.pendingAuth = null;  // { state, verifier, redirectUri, at }
    this.lastError = null;
    this.lastAction = null;   // { kind, at, ok }
    this.player = null;       // dernier état lu : { isPlaying, device, track, at }
    this.failures = 0;        // échecs d'affilée
    this.waitUntil = 0;       // pas d'appel automatique avant (échecs, 429)
    this.generation = 0;      // change à chaque déconnexion : un jeton en route est ignoré
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved && typeof saved === 'object') this.config = { ...this.config, ...this._clean(saved) };
    } catch (_) { /* pas encore configuré */ }
  }

  _clean(value) {
    const out = {};
    if (typeof value.clientId === 'string' && /^[A-Za-z0-9]{16,64}$/.test(value.clientId)) out.clientId = value.clientId;
    if (typeof value.refreshToken === 'string' && value.refreshToken.length < 2000) out.refreshToken = value.refreshToken;
    if (typeof value.deviceId === 'string' && value.deviceId.length < 200) out.deviceId = value.deviceId;
    if (typeof value.deviceName === 'string') out.deviceName = value.deviceName.slice(0, 80);
    if (typeof value.autoResume === 'boolean') out.autoResume = value.autoResume;
    if (typeof value.autoPause === 'boolean') out.autoPause = value.autoPause;
    if (Number.isInteger(value.resumeDelaySec) && value.resumeDelaySec >= 5 && value.resumeDelaySec <= 300) out.resumeDelaySec = value.resumeDelaySec;
    return out;
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.config));
    fs.renameSync(temporary, this.file);
  }

  get configured() { return !!this.config.clientId; }
  get connected() { return !!(this.config.clientId && this.config.refreshToken); }
  // Spotify a échoué récemment ou demande de patienter : la boucle
  // automatique attend ; les boutons du bar restent utilisables.
  get waiting() { return this.now() < this.waitUntil; }

  setClientId(clientId) {
    const value = String(clientId || '').trim();
    if (!/^[A-Za-z0-9]{16,64}$/.test(value)) throw new Error('Identifiant Spotify invalide : copie le « Client ID » de ton application Spotify.');
    if (value !== this.config.clientId) {
      this.config = { ...this.config, clientId: value, refreshToken: '', deviceId: '', deviceName: '' };
      this.access = null;
      this.generation++;
    }
    this._save();
  }

  setOptions(options = {}) {
    const next = this._clean({ ...this.config, ...options });
    if ('resumeDelaySec' in options && next.resumeDelaySec !== Number(options.resumeDelaySec)) {
      throw new Error('Le délai avant de relancer Spotify doit être entre 5 et 300 secondes.');
    }
    this.config = { ...this.config, ...next };
    this._save();
  }

  setDevice(deviceId, deviceName) {
    this.config.deviceId = String(deviceId || '').slice(0, 200);
    this.config.deviceName = String(deviceName || '').slice(0, 80);
    this._save();
  }

  disconnect() {
    this.config = { ...this.config, refreshToken: '', deviceId: '', deviceName: '' };
    this.access = null;
    this.player = null;
    this.lastError = null;
    this.failures = 0;
    this.waitUntil = 0;
    this.generation++;
    this._save();
  }

  // Adresse de connexion à ouvrir sur le PC du bar. Spotify n'accepte en
  // HTTP qu'une adresse de bouclage : http://127.0.0.1:<port>/spotify/callback.
  authUrl(redirectUri) {
    if (!this.configured) throw new Error('Indique d’abord le Client ID de l’application Spotify du bar.');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    this.pendingAuth = { state, verifier, redirectUri, at: this.now() };
    const url = new URL('/authorize', ACCOUNTS);
    for (const [key, value] of Object.entries({ client_id: this.config.clientId, response_type: 'code',
      redirect_uri: redirectUri, code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state })) {
      url.searchParams.set(key, value);
    }
    return url.href;
  }

  async _token(form) {
    const generation = this.generation;
    const response = await this.fetchImpl(`${ACCOUNTS}/api/token`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, ...form }).toString(),
      signal: AbortSignal.timeout(10000) });
    const data = await response.json().catch(() => ({}));
    // Déconnecté ou autre application pendant la demande : ne rien garder.
    if (generation !== this.generation) throw new SpotifyError('Connexion Spotify changée pendant la demande.');
    if (!response.ok || !data.access_token) {
      if (data.error === 'invalid_grant' && form.grant_type === 'refresh_token') {
        // Accès retiré dans Spotify : inutile de redemander ce jeton.
        this.config.refreshToken = '';
        this.access = null;
        this._save();
        this.log('Spotify a refusé le jeton enregistré : reconnecte Spotify depuis la page du bar.');
      }
      throw new SpotifyError(data.error === 'invalid_grant' ? 'Connexion Spotify refusée ou expirée : reconnecte Spotify.' :
        `Connexion Spotify impossible (${data.error_description || data.error || response.status}).`, { status: response.status });
    }
    this.access = { token: data.access_token, expiresAt: this.now() + (Number(data.expires_in) || 3600) * 1000 - 60000 };
    if (data.refresh_token) this.config.refreshToken = data.refresh_token;
    this._save();
    return this.access.token;
  }

  async finishAuth({ code, state }) {
    const pending = this.pendingAuth;
    if (!pending || !state || state !== pending.state || this.now() - pending.at > 10 * 60000) {
      throw new Error('Connexion Spotify expirée : relance-la depuis la page du bar.');
    }
    this.pendingAuth = null;
    await this._token({ grant_type: 'authorization_code', code: String(code || ''),
      redirect_uri: pending.redirectUri, code_verifier: pending.verifier });
    this.lastError = null;
  }

  async _accessToken() {
    if (!this.connected) throw new SpotifyError('Spotify n’est pas connecté.');
    if (this.access && this.now() < this.access.expiresAt) return this.access.token;
    return this._token({ grant_type: 'refresh_token', refresh_token: this.config.refreshToken });
  }

  async _api(method, route) {
    try {
      const data = await this._request(method, route);
      this.failures = 0;
      this.waitUntil = 0;
      return data;
    } catch (error) {
      this.failures++;
      this.waitUntil = this.now() + (error.retryAfterSec > 0 ? Math.min(error.retryAfterSec, 3600) * 1000 :
        Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (this.failures - 1)));
      throw error;
    }
  }

  async _request(method, route, retried = false) {
    const token = await this._accessToken();
    const response = await this.fetchImpl(`${API}${route}`, { method,
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    if (response.status === 401 && !retried) { this.access = null; return this._request(method, route, true); }
    if (response.status === 204 || response.status === 202) return null;
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (!response.ok) {
      throw new SpotifyError(explain(response.status, data?.error?.reason || data?.error?.message || ''), {
        status: response.status, retryAfterSec: Number(response.headers?.get?.('retry-after')) || 0 });
    }
    return data;
  }

  async readPlayer() {
    const data = await this._api('GET', '/me/player');
    this.player = { isPlaying: !!data?.is_playing, at: this.now(),
      device: data?.device ? { id: data.device.id, name: String(data.device.name || '').slice(0, 80) } : null,
      track: data?.item ? { title: String(data.item.name || '').slice(0, 100),
        artist: String(data.item.artists?.map(a => a.name).join(', ') || '').slice(0, 100) } : null };
    return this.player;
  }

  async devices() {
    const data = await this._api('GET', '/me/player/devices');
    return (Array.isArray(data?.devices) ? data.devices : []).filter(d => d && d.id).map(d => ({
      id: String(d.id), name: String(d.name || 'Appareil').slice(0, 80), type: String(d.type || ''),
      active: !!d.is_active }));
  }

  _deviceQuery() {
    return this.config.deviceId ? `?device_id=${encodeURIComponent(this.config.deviceId)}` : '';
  }

  // Ne commande que si l'état réel de Spotify l'exige.
  async resume() {
    return this._act('resume', async () => {
      const player = await this.readPlayer();
      if (player.isPlaying) return 'already';
      await this._api('PUT', `/me/player/play${this._deviceQuery()}`);
      this.player = { ...player, isPlaying: true, at: this.now() };
      return 'done';
    });
  }

  async pause() {
    return this._act('pause', async () => {
      const player = await this.readPlayer();
      if (!player.isPlaying) return 'already';
      await this._api('PUT', `/me/player/pause${player.device?.id ? `?device_id=${encodeURIComponent(player.device.id)}` : ''}`);
      this.player = { ...player, isPlaying: false, at: this.now() };
      return 'done';
    });
  }

  async _act(kind, work) {
    try {
      const result = await work();
      this.lastAction = { kind, result, at: this.now(), ok: true };
      this.lastError = null;
      return result;
    } catch (error) {
      this.lastAction = { kind, result: 'error', at: this.now(), ok: false };
      this.lastError = error.message;
      throw error;
    }
  }

  view(redirectUri = null) {
    return { configured: this.configured, connected: this.connected,
      clientId: this.config.clientId || '', redirectUri,
      deviceId: this.config.deviceId || '', deviceName: this.config.deviceName || '',
      autoResume: this.config.autoResume, autoPause: this.config.autoPause,
      resumeDelaySec: this.config.resumeDelaySec,
      player: this.player, lastAction: this.lastAction, lastError: this.lastError };
  }
}

// Décide quand agir, à partir de l'état de KaraFun : « singing » (un titre
// joue ou est en pause), « silent » (rien ne joue), « unknown » (KaraFun
// déconnecté : on ne touche à rien). Une seule action par période : si le bar
// coupe lui-même Spotify pendant un silence, l'application ne le relance pas.
class SpotifyAutomation {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.phase = null;
    this.since = 0;
    this.done = false;
    this.attempts = 0;
    this.retryAt = 0;
  }

  step(karaoke, { autoResume = DEFAULTS.autoResume, autoPause = DEFAULTS.autoPause,
    resumeDelaySec = DEFAULTS.resumeDelaySec } = {}) {
    const now = this.now();
    if (karaoke !== this.phase) {
      this.phase = karaoke;
      this.since = now;
      this.done = false;
      this.attempts = 0;
      this.retryAt = 0;
    }
    if (this.done || karaoke === 'unknown' || now < this.retryAt) return null;
    if (karaoke === 'singing') return autoPause ? 'pause' : null;
    if (karaoke === 'silent' && autoResume && now - this.since >= resumeDelaySec * 1000) return 'resume';
    return null;
  }

  // Résultat de l'action demandée : réussite, ou nouvel essai dans 30 s
  // (trois essais au plus par période).
  settle(ok) {
    this.attempts++;
    if (ok || this.attempts >= 3) this.done = true;
    else this.retryAt = this.now() + 30000;
  }
}

module.exports = { SpotifyLink, SpotifyAutomation };
