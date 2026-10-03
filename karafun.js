'use strict';
/* Pont vers la télécommande KaraFun : KCS JSON actuel, socket.io v2 historique
 * et démo. Découverte des paramètres officiels sans exécuter de code distant. */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const io = require('socket.io-client');
const { KcsTransport } = require('./kcs-transport');
const { rangesFrom, addOptions, queueItemOptions, clampSettings, songTracksOf, liveFromStatus, TRACK,
  DEFAULTS: SETTINGS_DEFAULTS } = require('./song-settings');

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

// `songTracks` : pistes vocales du titre (4 chœurs, 5 et 6 voix guides),
// seulement si KaraFun les donne. `options` : réglages du titre dans KaraFun.
function normalizeKcsItem(item) {
  const song = item.song || {}, quiz = item.quiz || {};
  const tracks = songTracksOf(song);
  return {
    queueId: String(item.id), id: String(item.id), songId: song.id && song.id.id,
    title: song.title || quiz.title || '', artist: song.artist || '',
    singer: song.options && song.options.singer || '', options: song.options || {},
    ...(tracks ? { songTracks: tracks } : {}),
    ...(quiz.id ? { quizId: quiz.id.id } : {}),
  };
}

// Forme observée dans les QueueEvent et StatusEvent d'une vraie Battle KaraFun.
// Le mode est confirmé par la réponse de KaraFun, jamais par le seul envoi.
const BATTLE_MOD = Object.freeze({ id: 1, caption: 'Battle', data: { battle: { subtype: 1 } } });
function isBattleItem(item) {
  const mod = item?.options?.mod || item?.song?.options?.mod;
  return Number(mod?.id) === 1 && Number(mod?.data?.battle?.subtype) === 1;
}

// Les droits d'administrateur sont donnés dans KaraFun à un participant
// nommé. Le nom de ce programme doit donc rester le même d'une reconnexion à
// l'autre, et même après un redémarrage : il est conservé dans data/.
function loadIdentity(file) {
  if (!file) return null;
  try {
    const value = Number(JSON.parse(fs.readFileSync(file, 'utf8')).suffix);
    return Number.isInteger(value) && value >= 1000 && value <= 9999 ? value : null;
  } catch { return null; }
}

function saveIdentity(file, suffix) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ suffix }));
    fs.renameSync(temporary, file);
  } catch { /* nom stable pour cette exécution seulement */ }
}

// Un seul programme par dossier data/ : deux files lancées depuis le même
// dossier demanderaient le même nom FileKaraoke à KaraFun et se le
// disputeraient. Le verrou garde le numéro du processus et une heure
// rafraîchie toutes les 30 s. Fenêtre fermée ou plantage : le verrou n'est
// plus rafraîchi et il est repris au bout de 90 s, même si Windows a déjà
// redonné ce numéro de processus à un autre programme.
const LOCK_REFRESH_MS = 30000;
const LOCK_STALE_MS = 90000;
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function lockIdentity(file, { pid = process.pid, port = null, alive = processAlive } = {}) {
  const lock = `${file}.lock`;
  const free = { ok: true, release() {} };
  const content = () => JSON.stringify({ pid, port, at: new Date().toISOString() });
  const mine = () => { try { return JSON.parse(fs.readFileSync(lock, 'utf8')).pid === pid; } catch { return false; } };
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, content(), { flag: 'wx' });
      const timer = setInterval(() => { try { if (mine()) fs.writeFileSync(lock, content()); } catch { /* disque plein */ } }, LOCK_REFRESH_MS);
      timer.unref();
      return { ok: true, release() {
        clearInterval(timer);
        try { if (mine()) fs.unlinkSync(lock); } catch { /* déjà libre */ }
      } };
    } catch (error) {
      if (error.code !== 'EEXIST') return free; // dossier en lecture seule : pas de garde
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* verrou illisible : abandonné */ }
      const fresh = holder && Date.now() - Date.parse(holder.at) < LOCK_STALE_MS;
      if (fresh && Number.isInteger(holder.pid) && holder.pid !== pid && alive(holder.pid)) {
        return { ok: false, holder: { pid: holder.pid, port: holder.port ?? null }, release() {} };
      }
      try { fs.unlinkSync(lock); } catch { /* repris par un autre */ }
    }
  }
  return free;
}

// Le code de télécommande ne doit pas circuler en clair dans les journaux
// partagés : seuls les deux derniers chiffres restent, pour les comparer.
function maskCode(code) {
  const digits = String(code || '').replace(/\D/g, '');
  return digits.length > 2 ? `••••${digits.slice(-2)}` : '••••';
}

const IMPORTANT_PERMISSIONS = [
  ['addToQueue', p => p?.addToQueue !== false, 'ajout de titres'],
  ['battle', p => p?.shownTypes?.battle !== false, 'mode Battle'],
  ['playback', p => !!(p?.managePlayback ?? p?.managePlayer), 'lecture'],
];

// Nom encore tenu par une ancienne connexion : le même nom est redemandé
// toutes les 4 s, puis la file en prend un autre après environ 2 min. Le
// délai court sur toute la durée du conflit, pas par WebSocket.
const NAME_RETRY_MS = 4000;
const NAME_SWITCH_MS = 120000;
// Relances après échec : 3 s, 6 s, 12 s, 24 s puis 30 s, un peu dispersées.
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30000;
// « Reconnecter » ne coupe pas une connexion qui vient de démarrer.
const RECONNECT_PATIENCE_MS = 15000;
// Réglages de titre (tonalité, tempo, voix) : décrits par le SDK de KaraFun
// Web, pas encore vérifiés sur le KaraFun du bar. Une Error avec le même
// identifiant, ou aucune réponse, marque la fonction comme non prise en
// charge ('refused') ; une réponse la confirme ('ok').
const SETTING_REQUESTS = Object.freeze({ 'remote.PitchRequest': 'pitch', 'remote.TempoRequest': 'tempo',
  'remote.TrackVolumeRequest': 'trackVolume', 'remote.SetQueueItemOptionsRequest': 'queueItemOptions' });
// `addOptions` : réglages dans les options de remote.AddToQueueRequest. Une
// Error à un ajout qui en portait : le titre n'est pas dans KaraFun, le
// serveur le renvoie sans réglages ('add-options-refused').
const SETTING_LABELS = { pitch: ['la tonalité', 'de tonalité'], tempo: ['le tempo', 'de tempo'],
  trackVolume: ['le volume des voix', 'des voix'], queueItemOptions: ['un titre de la file', 'des titres de la file'],
  addOptions: ['un titre à son ajout', 'des titres à leur ajout'] };
const freshSupport = () => ({ pitch: 'unknown', tempo: 'unknown', trackVolume: 'unknown', queueItemOptions: 'unknown',
  addOptions: 'unknown' });
// Demandes dont l'absence de réponse n'est qu'un avertissement : la file
// garde la connexion tant que KaraFun parle (chien de garde du transport).
const SOFT_REQUESTS = new Set(['remote.UpdateUsernameRequest', ...Object.keys(SETTING_REQUESTS)]);
// Battements de KaraFun : gardés dans le fichier, comptés à l'écran.
const NOISE = new Set(['core.PingRequest', 'core.PingResponse', 'core.TimestampRequest', 'core.TimestampResponse']);
// En-têtes de navigateur ordinaires, comme pour le catalogue.
const DISCOVERY_HEADERS = Object.freeze({
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
});
const CHALLENGE = /cf-chl|challenge-platform|captcha|just a moment/i;
// Échecs de découverte : [motif court pour l'état, message pour le diagnostic].
const DISCOVERY_ERRORS = {
  'unknown-code': ['Code inconnu ou télécommande KaraFun fermée',
    () => 'Code KaraFun inconnu ou télécommande fermée : vérifie le code affiché dans KaraFun et que sa télécommande est activée.'],
  refused: ['Le site KaraFun refuse ce PC',
    status => `Le site KaraFun refuse ce PC (HTTP ${status || '?'}) : attends quelques minutes ou essaie un autre réseau.`],
  http: ['Site KaraFun en panne', status => `Le site KaraFun répond mal (HTTP ${status}) : nouvel essai automatique.`],
  'bad-page': ['Page KaraFun inattendue', () => 'Page de télécommande KaraFun inattendue : nouvel essai automatique.'],
  network: ['Réseau coupé', () => 'Réseau coupé ou site KaraFun injoignable depuis ce PC : vérifie la connexion Internet.'],
  timeout: ['KaraFun trop lent', () => 'Le site KaraFun ne répond pas à temps (10 s) : réseau lent ou coupé.'],
  'no-websocket': ['WebSocket indisponible', () => 'WebSocket indisponible sur ce PC : le kit doit utiliser Node 22.'],
};

function duration(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000)), minutes = Math.floor(seconds / 60), rest = seconds % 60;
  if (!minutes) return `${rest} s`;
  return rest ? `${minutes} min ${String(rest).padStart(2, '0')}` : `${minutes} min`;
}

class KaraFunBridge extends EventEmitter {
  constructor({ logDir, bases, identityFile = null, log = null, lockOwner = null } = {}) {
    super();
    this.bases = bases || ['https://www.karafun.com', 'https://www.karafun.fr'];
    this.baseIdx = 0;
    this.logDir = logDir;
    this.log = log;
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
    this.noiseCount = 0;
    this.retryTimer = null;
    this.retryAt = null;
    this.random = Math.random;
    this.identityNotice = null;
    this.identityLock = identityFile && lockOwner ? lockIdentity(identityFile, lockOwner) : null;
    if (this.identityLock && !this.identityLock.ok) {
      const { port } = this.identityLock.holder;
      this.identityNotice = `Une autre File karaoké tourne déjà depuis ce dossier${port ? ` (port ${port})` : ''} : celle-ci prend un nom KaraFun provisoire pour ne pas lui voler le sien. Ferme l’une des deux.`;
      identityFile = null;
    }
    this.identityFile = identityFile;
    this.loginSuffix = loadIdentity(identityFile) || Math.floor(1000 + Math.random() * 9000);
    saveIdentity(identityFile, this.loginSuffix);
    this.permissionWarning = null;
    this.bestPermissions = null;
    this.settingsSupport = freshSupport();
    this.settingsNotice = null;
    this._optionAdds = new Map(); // identifiant KCS → ajout avec réglages sans réponse
    this.observedDefaults = {}; // volumes des voix d'un titre chargé sans réglage
    this._observedFor = null;
    this.nameConflictSince = null;
    this.nameConflictTries = 0;
    this._generation = 0;
    this._attempt = 0;
    this._tries = 0;
    this._failures = 0;
    this._phase = 'idle';
    this._phaseSince = Date.now();
    this._retryReason = null;
    this._lastLoggedRetry = null;
    this._startedAt = null;
    this._link = {};
    this._fresh = { queue: false, status: false };
    if (this.identityNotice) this._log(`KaraFun : ${this.identityNotice}`);
  }

  get base() { return this.bases[this.baseIdx % this.bases.length]; }
  get username() { return `FileKaraoke-${this.loginSuffix}`; }

  _log(message) {
    try { this.log?.(message); } catch { /* journal best-effort */ }
  }

  _setPhase(phase) {
    if (phase === this._phase) return;
    const previous = this._phase;
    this._phase = phase;
    this._phaseSince = Date.now();
    if (phase === 'ready') {
      this._resetTries = true;
      const took = this._startedAt == null ? '' : ` en ${duration(Date.now() - this._startedAt)}`;
      this._log(`KaraFun : prêt, file et lecture reçues${took} (essai ${this._tries}, ${this.username}).`);
      this._record('info', 'pret', { essai: this._tries, from: previous });
      this._failures = 0;
      this._lastLoggedRetry = null;
      this._startedAt = null;
    }
  }

  // Dernier recours : KaraFun refuse durablement le nom habituel. Après un
  // redémarrage rapide, KaraFun garde souvent l'ancienne connexion quelques
  // dizaines de secondes : on attend donc environ deux minutes avant de
  // changer de nom, sauf si le bar le demande. Le bar peut fermer l'avis ;
  // il revient à un nouveau changement de nom.
  _changeIdentity(byBar = false) {
    const previous = this.username;
    this.loginSuffix = Math.floor(1000 + Math.random() * 9000);
    saveIdentity(this.identityFile, this.loginSuffix);
    this.identityNotice = byBar ?
      `À ta demande, la file s’appelle maintenant ${this.username} (au lieu de ${previous}). Donne-lui les droits d’administrateur dans les participants de la télécommande KaraFun.` :
      `KaraFun gardait encore l’ancienne connexion ${previous} : la file s’appelle maintenant ${this.username}. Si l’envoi de titres échoue, redonne-lui les droits d’administrateur dans KaraFun.`;
    this._record('info', 'identity-changed', { previous, next: this.username, byBar });
    this._log(`KaraFun : nom changé ${previous} → ${this.username} (${byBar ? 'demande du bar' : `nom encore pris après ${duration(Date.now() - (this.nameConflictSince ?? Date.now()))}`}).`);
    this.nameConflictSince = null;
    this.nameConflictTries = 0;
  }

  dismissIdentityNotice() { this.identityNotice = null; this.emit('change'); }

  // Bouton du bar « Prendre un autre nom maintenant » : sans attendre la fin
  // des deux minutes. Refusé si le nom actuel fonctionne.
  forceNewName() {
    if (this.ready && this.nameConflictSince == null) throw new Error(`Le nom ${this.username} fonctionne : rien à changer.`);
    this._changeIdentity(true);
    if (this.connected && this._link.authenticated) this._link.askName();
    this.emit('change');
  }

  releaseIdentity() { this.identityLock?.release(); }

  // Nom refusé car encore pris : même nom redemandé, puis autre nom.
  _nameUsed(ask) {
    const now = Date.now();
    if (this.nameConflictSince == null) {
      this.nameConflictSince = now;
      this.nameConflictTries = 0;
      this._record('info', 'name-conflict', { username: this.username });
      this._log(`KaraFun : le nom ${this.username} est encore pris par une ancienne connexion ; même nom redemandé toutes les 4 s, autre nom dans ${duration(NAME_SWITCH_MS)} si besoin.`);
    }
    this.nameConflictTries++;
    this._setPhase('waiting-name');
    if (now - this.nameConflictSince >= NAME_SWITCH_MS) {
      this._changeIdentity();
      ask(0);
    } else {
      this.lastError = `KaraFun garde encore l’ancienne connexion de ${this.username} ; nouvel essai dans quelques secondes.`;
      ask(NAME_RETRY_MS);
    }
    this.emit('change');
  }

  _nameAccepted() {
    this.lastError = null;
    if (!this._link.nameAccepted) {
      this._link.nameAccepted = true;
      this._log(`KaraFun : nom ${this.username} accepté.`);
    }
    if (this.nameConflictSince != null) {
      this._log(`KaraFun : conflit de nom terminé après ${duration(Date.now() - this.nameConflictSince)} (${this.nameConflictTries} refus).`);
      this._record('info', 'name-conflict-end', { username: this.username, tries: this.nameConflictTries });
      this.nameConflictSince = null;
      this.nameConflictTries = 0;
    }
    this._setPhase(this.ready ? 'ready' : 'waiting-data');
    this.emit('change');
  }

  _checkPermissions(permissions) {
    const now = Object.fromEntries(IMPORTANT_PERMISSIONS.map(([key, read]) => [key, read(permissions)]));
    const lost = IMPORTANT_PERMISSIONS.filter(([key]) => this.bestPermissions?.[key] && !now[key]);
    this.permissionWarning = lost.length ?
      `KaraFun ne donne plus à ${this.username} : ${lost.map(([, , label]) => label).join(', ')}. Redonne-lui les droits d’administrateur dans les participants de la télécommande KaraFun.` : null;
    this.bestPermissions = Object.fromEntries(IMPORTANT_PERMISSIONS.map(([key]) =>
      [key, !!(now[key] || this.bestPermissions?.[key])]));
  }

  // Réponse (ou silence, `message` null) de KaraFun à un réglage de titre.
  _settingsAnswer(kind, message) {
    const [what, of] = SETTING_LABELS[kind];
    if (message && message.type !== 'Error') this.settingsSupport[kind] = 'ok';
    else {
      this.settingsSupport[kind] = 'refused';
      this.settingsNotice = message ? `KaraFun refuse de régler ${what} : ${message.payload?.message || 'erreur inconnue'}` :
        `KaraFun ne répond pas aux réglages ${of} : cette version de KaraFun ne le permet peut-être pas.`;
      this._record('info', 'reglage-refuse', { request: kind, message: this.settingsNotice });
    }
    if (!Object.values(this.settingsSupport).includes('refused')) this.settingsNotice = null;
    this.emit('change');
  }

  _record(dir, name, data, id) {
    const entry = { t: new Date().toISOString(), dir, name, ...(id === undefined ? {} : { id }), data };
    if (NOISE.has(name)) this.noiseCount++;
    else {
      this.events.push(entry);
      if (this.events.length > 200) this.events.shift();
    }
    if (this.logDir) {
      try { fs.appendFileSync(path.join(this.logDir, `karafun-${entry.t.slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n'); }
      catch { /* journal best-effort */ }
    }
  }

  // « Connecter » ou « Reconnecter ». Avec le même code, une connexion prête
  // ou en cours n'est pas coupée : la couper recréerait un conflit de nom avec
  // la connexion qu'on vient de fermer. Rend 'kept' ou 'started'.
  connect(code) {
    code = String(code || '').replace(/\D/g, '');
    if (!code) throw new Error('Code KaraFun manquant');
    if (this.code === code && this._keepCurrent()) return 'kept';
    const sameCode = this.code === code;
    this.disconnect();
    if (!sameCode) {
      this.bestPermissions = null; this.permissionWarning = null;
      this.settingsSupport = freshSupport(); this.settingsNotice = null;
      this.observedDefaults = {}; this._observedFor = null;
      this.nameConflictSince = null; this.nameConflictTries = 0;
      this._tries = 0; this._failures = 0;
    }
    this.code = code;
    this.queue = [];
    this.status = this.permissions = this.preferences = null;
    this.raw = {};
    this._open();
    return 'started';
  }

  _keepCurrent() {
    if (this._phase === 'ready' && this.ready) return true;
    if (this._phase === 'waiting-name' && this.nameConflictSince != null) return true;
    return ['discovering', 'opening', 'waiting-auth', 'waiting-name', 'waiting-data'].includes(this._phase) &&
      Date.now() - this._phaseSince < RECONNECT_PATIENCE_MS;
  }

  async _open() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
    const generation = this._generation, attempt = ++this._attempt;
    const active = () => generation === this._generation && attempt === this._attempt;
    const base = this.base;
    this._fresh = { queue: false, status: false };
    this._link = {};
    this.ready = false;
    this.connected = false;
    if (this._resetTries) { this._tries = 0; this._resetTries = false; }
    this._tries++;
    this._startedAt ??= Date.now();
    this._record('info', 'connexion', { base, code: maskCode(this.code), essai: this._tries });
    // Le faux KaraFun local n'a pas de page de découverte.
    if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) {
      this._setPhase('opening');
      this._openLegacy(base, active);
      return;
    }
    this._setPhase('discovering');
    this.emit('change');
    const found = await this._discover(base);
    if (!active()) return;
    if (!found.settings) { this._discoveryFailed(found); return; }
    this._record('info', 'discovery', { host: found.host, status: found.status, keys: found.keys });
    if (!found.settings.kcs_url) { this._openLegacy(base, active); return; }
    try { this._openKcs(found.settings.kcs_url, active); }
    catch { this._discoveryFailed({ ...found, settings: null, kind: 'no-websocket' }); }
  }

  // Lit la page publique de la télécommande. Ne garde que l'état HTTP, les
  // hôtes et la présence des clés attendues : jamais le HTML ni l'URL KCS,
  // qui contiennent un jeton.
  async _discover(base) {
    const info = { host: new URL(base).hostname };
    let response, html;
    try {
      response = await fetch(`${base}/${this.code}/`, { headers: { ...DISCOVERY_HEADERS }, signal: AbortSignal.timeout(10000) });
      html = String(await response.text());
    } catch (error) {
      return { ...info, kind: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network' };
    }
    info.status = response.status;
    try {
      const finalHost = response.url ? new URL(response.url).hostname : null;
      if (finalHost && finalHost !== info.host) info.finalHost = finalHost;
    } catch { /* adresse finale illisible */ }
    const hasSettings = /\bSettings\s*=/.test(html);
    info.keys = { Settings: hasSettings, kcs_url: /["']?kcs_url["']?\s*:/.test(html) };
    if ([401, 403, 429].includes(response.status) || (!hasSettings && CHALLENGE.test(html))) return { ...info, kind: 'refused' };
    if ([404, 410].includes(response.status)) return { ...info, kind: 'unknown-code' };
    if (!response.ok) return { ...info, kind: 'http' };
    let settings;
    try { settings = readSettings(html); } catch { return { ...info, kind: 'bad-page' }; }
    if (!settings) return { ...info, kind: 'unknown-code' };
    if (settings.kcs_url) {
      let protocol = null;
      try { protocol = new URL(settings.kcs_url).protocol; } catch { /* adresse illisible */ }
      if (protocol !== 'wss:') return { ...info, kind: 'bad-page' };
    }
    return { ...info, settings };
  }

  _discoveryFailed(found) {
    const [reason, message] = DISCOVERY_ERRORS[found.kind];
    this.lastError = message(found.status);
    this.unreachable = true;
    const { kind, status, host, finalHost, keys } = found;
    this._record('info', 'discovery-error', { kind, status, host, finalHost, keys, message: this.lastError });
    if (this.bases.length > 1) this.baseIdx++;
    const where = [kind, status && `HTTP ${status}`, host, finalHost && `→ ${finalHost}`,
      keys && `Settings ${keys.Settings ? 'présent' : 'absent'}, kcs_url ${keys.kcs_url ? 'présent' : 'absent'}`].filter(Boolean).join(', ');
    this._retry(reason, { detail: `${this.lastError} [${where}]`, minDelay: kind === 'refused' ? 15000 : 0 });
  }

  _retry(reason = 'Connexion KaraFun perdue', { detail = this.lastError, minDelay = 0 } = {}) {
    this._attempt++;
    this._closeSocket();
    this.connected = this.ready = false;
    clearTimeout(this.retryTimer);
    // Connexion perdue après « prêt » : les essais se recomptent depuis 1.
    if (this._resetTries) { this._tries = 0; this._resetTries = false; }
    const step = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(this._failures, 4));
    const jittered = this._failures ? Math.min(RETRY_MAX_MS, Math.round(step * (0.85 + 0.3 * this.random()))) : step;
    const delay = Math.max(minDelay, jittered);
    this._failures++;
    this.retryAt = Date.now() + delay;
    this._retryReason = reason;
    this._setPhase('retry');
    // Une même panne n'écrit qu'une ligne, puis une toutes les 10 relances.
    if (detail !== this._lastLoggedRetry || this._failures % 10 === 0) {
      this._lastLoggedRetry = detail;
      this._log(`KaraFun : ${detail || reason} Nouvel essai dans ${duration(delay)} (essai ${this._tries + 1}).`);
    }
    const generation = this._generation;
    this.retryTimer = setTimeout(() => { if (generation === this._generation) this._open(); }, delay);
    this.emit('change');
  }

  _accept(name, data) {
    this[name] = data;
    if (name === 'permissions') this._checkPermissions(data);
    if (name === 'queue' || name === 'status') {
      this._fresh[name] = true;
      this.ready = this._fresh.queue && this._fresh.status;
      if (this.ready) {
        this.unreachable = false; this.lastError = null;
        if (this.nameConflictSince == null) this._setPhase('ready');
      }
      this.emit(name, data);
    }
    this.emit('change');
  }

  _openKcs(url, active) {
    const socket = new KcsTransport(url);
    this._optionAdds.clear(); // identifiants propres à chaque connexion
    this.protocol = 'kcs';
    this.socket = socket;
    this._setPhase('opening');
    // KaraFun garde parfois l'ancien nom quelques secondes après une coupure.
    // On redemande alors le MÊME nom un moment, pour conserver les droits
    // d'administrateur donnés à ce participant, avant d'en changer.
    let usernameTimer = null;
    let softWarned = false;
    socket.once('close', () => clearTimeout(usernameTimer));
    const updateUsername = () => socket.send('remote.UpdateUsernameRequest', { username: this.username });
    const askName = (delay = 0) => {
      clearTimeout(usernameTimer);
      const send = () => { if (active()) { try { updateUsername(); } catch (_) { /* reconnexion */ } } };
      if (delay) usernameTimer = setTimeout(send, delay); else send();
    };
    this._link.askName = askName;
    socket.on('open', () => {
      if (!active()) return;
      this.connected = true;
      this.unreachable = false;
      this.lastError = null;
      this._setPhase('waiting-auth');
      this._log(`KaraFun : connexion ouverte (essai ${this._tries}), attente de KaraFun.`);
      this.emit('change');
      // Les snapshots arrivent par événements. KaraFun 3.12 refuse les requêtes
      // QueueRequest/StatusRequest pourtant décrites dans le SDK de la page.
    });
    socket.on('out', m => { if (active()) this._record('out', m.type, m.payload, m.id); });
    socket.on('message', m => {
      if (!active()) return;
      this.lastEventAt = Date.now();
      this._record('in', m.type, m.payload, m.id);
      const p = m.payload || {};
      if (m.type === 'core.AuthenticatedEvent') {
        this._link.authenticated = true;
        if (!this.ready) this._setPhase('waiting-name');
        this._log(`KaraFun : code accepté, demande du nom ${this.username}.`);
        updateUsername();
      } else if (m.type === 'remote.UsernameUpdateEvent' || m.type === 'remote.UpdateUsernameResponse') {
        if (p.username && p.username !== this.username) return;
        this._nameAccepted();
      } else if (m.type === 'remote.QueueEvent' || m.type === 'remote.QueueResponse') {
        if (!p.queue || !Array.isArray(p.queue.items)) return;
        this.raw.queue = p.queue;
        this._accept('queue', p.queue.items.map(normalizeKcsItem));
      } else if (m.type === 'remote.StatusEvent' || m.type === 'remote.StatusResponse') {
        if (!p.status || typeof p.status.state !== 'number') return;
        const status = p.status || {};
        this.raw.status = status;
        this._observeDefaults(status);
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
        this.emit('change');
      } else if (m.type === 'remote.AppLeftEvent') {
        this.unreachable = true;
        this.lastError = 'KaraFun est fermé ou sa télécommande a été désactivée.';
        this._record('info', 'connexion-perdue', this.lastError);
        this._retry('KaraFun fermé ou télécommande désactivée');
      } else if (m.type === 'Error') {
        if (p.type === 4 && /username is already used/i.test(p.message || '')) {
          // L'Error répond à la demande de nom, même sans son identifiant.
          if (m.id === undefined) socket.settle('remote.UpdateUsernameRequest');
          this._nameUsed(askName);
          return;
        }
        // Réglage de titre refusé : traité avec sa demande (événement 'reply').
        if (m.id !== undefined && (SETTING_REQUESTS[socket.requestType(m.id)] || this._optionAdds.has(m.id))) return;
        this.lastError = `Commande KaraFun refusée : ${p.message || p.type || 'erreur inconnue'}`;
        this.emit('change');
      }
    });
    socket.on('reply', (type, message) => {
      if (!active()) return;
      if (SETTING_REQUESTS[type]) this._settingsAnswer(SETTING_REQUESTS[type], message);
      else if (this._optionAdds.has(message.id)) {
        const add = this._optionAdds.get(message.id);
        this._optionAdds.delete(message.id);
        this._settingsAnswer('addOptions', message);
        if (message.type === 'Error') this.emit('add-options-refused', add);
      }
    });
    const lost = (message, reason) => {
      if (!active()) return;
      this.unreachable = true;
      this.lastError = message;
      this._record('info', 'connexion-perdue', message);
      this._retry(reason);
    };
    socket.on('stale', message => lost(message, 'KaraFun ne répond plus'));
    socket.on('request-timeout', type => {
      if (!active()) return;
      if (!SOFT_REQUESTS.has(type)) {
        lost(`KaraFun ne confirme plus les commandes (${type}) ; reconnexion en cours.`, 'Commande KaraFun non confirmée');
        return;
      }
      this._record('info', 'sans-reponse', type);
      if (SETTING_REQUESTS[type]) this._settingsAnswer(SETTING_REQUESTS[type], null);
      if (this.ready && this.nameConflictSince == null) this._setPhase('ready');
      if (!softWarned) {
        softWarned = true;
        this._log(`KaraFun : pas de réponse à ${type} en 8 s ; connexion gardée.`);
      }
    });
    socket.on('transport-error', message => {
      if (!active()) return;
      this.lastError = message;
      this._record('info', 'connect_error', message);
      this.emit('change');
    });
    socket.on('close', ({ code }) => lost(`Télécommande KaraFun déconnectée (code ${code}). Vérifie le code affiché dans KaraFun.`,
      `KaraFun a fermé la connexion (code ${code})`));
  }

  _openLegacy(base, active) {
    this.protocol = 'socket.io';
    this._setPhase('opening');
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
      this.unreachable = false;
      this.lastError = null;
      this._setPhase('waiting-data');
      this._link.authenticated = true;
      this._link.askName = () => this._auth();
      this._log(`KaraFun : connexion ouverte (ancien protocole, essai ${this._tries}).`);
      this._auth();
      this.emit('change');
    });
    socket.on('connect_error', err => {
      if (!active()) return;
      this.lastError = `Connexion impossible à ${base} : ${err && err.message}`;
      this._record('info', 'connect_error', this.lastError);
      if (this.bases.length > 1) this.baseIdx++;
      this._retry('Connexion KaraFun impossible');
    });
    socket.on('disconnect', reason => {
      if (!active()) return;
      this._record('info', 'disconnect', reason);
      this._retry('Connexion KaraFun perdue', { detail: `Connexion KaraFun perdue (${reason}).` });
    });
    let loginTimer = null;
    socket.on('loginAlreadyTaken', () => {
      if (!active()) return;
      this._nameUsed(delay => {
        clearTimeout(loginTimer);
        loginTimer = setTimeout(() => { if (active()) this._auth(); }, delay);
      });
    });
    const unreachable = () => {
      if (!active()) return;
      this.unreachable = true;
      this.lastError = 'KaraFun ne répond pas pour ce code : vérifie que KaraFun est ouvert et que le code est le bon.';
      if (this.bases.length > 1) this.baseIdx++;
      this._retry('Code inconnu ou KaraFun fermé');
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
    const payload = { login: this.username, channel: maskCode(this.code), role: 'participant', app: 'karafun', socket_id: null };
    this._record('out', 'authenticate', payload);
    this.socket.emit('authenticate', { ...payload, channel: this.code }, null);
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
    this.retryTimer = null;
    this.retryAt = null;
    this._closeSocket();
    this.connected = this.ready = false;
    this._setPhase('idle');
  }

  // État de la connexion pour le bar (contrat C2) : une phrase courte, un
  // niveau pour la couleur, depuis quand et à quel essai.
  connectionState(now = Date.now()) {
    const phase = this._phase;
    const conflict = this.nameConflictSince == null ? null : {
      holder: this.username, since: this.nameConflictSince, tries: this.nameConflictTries,
      switchAt: this.nameConflictSince + NAME_SWITCH_MS,
    };
    const later = conflict && conflict.switchAt - now > 0 ? `dans ${duration(conflict.switchAt - now)}` : 'imminent';
    const labels = {
      idle: ['wait', 'KaraFun déconnecté'],
      discovering: ['wait', `Recherche de la télécommande KaraFun${this._tries > 1 ? ` (essai ${this._tries})` : ''}…`],
      opening: ['wait', 'Ouverture de la connexion à KaraFun…'],
      'waiting-auth': ['wait', 'Connexion ouverte : KaraFun vérifie le code…'],
      'waiting-name': ['wait', conflict ?
        `KaraFun garde encore l’ancienne connexion de ${conflict.holder} : nouvel essai, changement de nom ${later}` :
        `KaraFun reçoit le nom ${this.username}…`],
      'waiting-data': ['wait', 'Connecté : réception de la file KaraFun…'],
      ready: ['ok', `KaraFun connecté (${this.username})`],
      retry: ['error', `${this._retryReason} : nouvel essai dans ${duration((this.retryAt ?? now) - now)}${this._tries > 1 ? ` (essai ${this._tries + 1})` : ''}`],
    };
    const [level, label] = labels[phase];
    return {
      phase, level, label, since: this._phaseSince, attempt: this._tries, protocol: this.protocol,
      retryAt: phase === 'retry' ? this.retryAt : null,
      nameConflict: conflict,
      // Bouton « Prendre un autre nom maintenant » : POST /api/staff/kf { action: 'new-name' }.
      canRename: !!conflict,
      alert: conflict ? `KaraFun garde encore l’ancienne connexion de ${conflict.holder} (KaraFun relancé trop vite, ou une autre File karaoké ouverte avec le même nom). La file redemande ce nom toutes les 4 s pour garder ses droits d’administrateur et en prendra un autre ${later}. Tu peux aussi prendre un autre nom maintenant, puis lui redonner les droits dans KaraFun.` : null,
    };
  }

  _emit(name, payload) {
    if (!this.socket || !this.connected || !this.ready) throw new Error('Pas connecté à KaraFun');
    if (this.protocol === 'kcs') {
      const messages = {
        queueAdd: ['remote.AddToQueueRequest', payload && { song: { type: 1, id: payload.songId },
          options: payload.mod ? { mod: payload.mod } : payload.options || { singer: payload.singer }, position: payload.pos }],
        queueRemove: ['remote.RemoveFromQueueRequest', { queueItemId: String(payload) }],
        queueMove: ['remote.MoveInQueueRequest', payload && { queueItemId: String(payload.queueId), to: payload.to }],
        play: ['remote.PlayRequest', {}], next: ['remote.NextRequest', {}],
        // Réglages de titre (SDK de KaraFun Web) : valeurs absolues.
        queueItemOptions: ['remote.SetQueueItemOptionsRequest', payload && { queueItemId: String(payload.queueId), options: payload.options }],
        pitch: ['remote.PitchRequest', { pitch: payload }],
        tempo: ['remote.TempoRequest', { tempo: payload }],
        trackVolume: ['remote.TrackVolumeRequest', payload && { type: payload.type, volume: payload.volume }],
      };
      const mapped = messages[name];
      if (!mapped) throw new Error('Commande KaraFun inconnue');
      return this.socket.send(...mapped);
    } else {
      this._record('out', name, payload);
      this.socket.emit(name, payload);
    }
  }

  // `settings` : réglages du titre (song-settings.js), ajoutés aux options
  // d'ajout ; `duo` : la voix guide B suit la voix guide A. Rend les réglages
  // effectivement envoyés (bornés), ou null.
  add(songId, singer, pos = 99999, settings = null, { duo = false } = {}) {
    const payload = { songId: Number(songId), pos, singer: String(singer || '') };
    const allowed = settings && this.settingsSupport.addOptions !== 'refused' && this._settingsChannel();
    const built = allowed ? addOptions({ singer: payload.singer, settings, ranges: this.songSettingsRanges(), duo }) : { sent: null };
    if (built.sent) {
      // Ancien protocole (faux KaraFun) : le chanteur reste à part.
      const { singer: _, ...rest } = built.options;
      payload.options = this.protocol === 'kcs' ? built.options : rest;
    }
    const id = this._emit('queueAdd', payload);
    if (built.sent && id !== undefined) this._optionAdds.set(id, { songId: payload.songId, singer: payload.singer });
    return built.sent;
  }
  addBattle(songId, pos = 0) {
    const id = Number(songId);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Titre Battle invalide.');
    if (this.protocol === 'kcs') {
      const compatible = this.raw.configuration?.compatibleMods?.battle;
      if (!Array.isArray(compatible) || !compatible.includes(1)) {
        throw new Error('Cette version de KaraFun ne confirme pas le mode Battle à distance.');
      }
      // compatibleMods décrit les modes disponibles sur le PC, tandis que
      // shownTypes décrit ceux autorisés pour cette télécommande. KaraFun peut
      // annoncer battle: [1] tout en refusant AddToQueueRequest pour Battle.
      if (this.raw.permissions?.shownTypes?.battle === false) {
        throw new Error('Permission Battle refusée par KaraFun pour cette télécommande. Prépare la Battle dans KaraFun.');
      }
    } else if (!this._localFake()) {
      throw new Error('Le mode Battle automatique nécessite la télécommande KaraFun récente.');
    }
    this._emit('queueAdd', { songId: id, pos,
      singer: 'Battle collective', mod: BATTLE_MOD });
  }
  _localFake() { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(this.base).hostname); }

  // ---------------------------------------------------------------- réglages de titre
  songSettingsRanges() { return rangesFrom(this.raw.configuration); }

  // KCS, ou faux KaraFun local de la démo. Une ancienne télécommande d'un vrai
  // KaraFun ne connaît pas ces réglages.
  _settingsChannel() { return this.protocol === 'kcs' || this._localFake(); }

  _settingsAllowed(permission) {
    if (!this._settingsChannel()) throw new Error('Réglages de titre indisponibles avec cette ancienne télécommande KaraFun.');
    if (this.permissions?.[permission] !== false) return;
    throw new Error(permission === 'manageVolumes' ?
      `KaraFun ne laisse pas ${this.username} personnaliser la chanson en cours : active « Personnaliser la chanson en cours » pour ce participant dans la télécommande KaraFun.` :
      `KaraFun ne laisse pas ${this.username} modifier les titres de sa file : active « Éditer la file d’attente » pour ce participant dans la télécommande KaraFun.`);
  }

  // Titre déjà dans la file de KaraFun : options complètes (voir
  // queueItemOptions). Rend les réglages envoyés.
  setQueueItemOptions(queueId, { singer, mod = null, settings = null, sent = null, current = null, tracksAvailable = null, duo = false } = {}) {
    if (queueId === null || queueId === undefined || queueId === '') throw new Error('Titre de la file KaraFun inconnu.');
    this._settingsAllowed('manageQueue');
    const built = queueItemOptions({ singer, mod, settings, sent, current, tracksAvailable, duo, ranges: this.songSettingsRanges(),
      defaults: this.songSettingsDefaults() });
    this._emit('queueItemOptions', { queueId, options: built.options });
    return built.sent;
  }

  // Titre en cours : valeurs absolues, bornées par la configuration de KaraFun.
  setPitch(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Tonalité invalide.');
    this._settingsAllowed('manageVolumes');
    const { pitch } = clampSettings({ pitch: value }, this.songSettingsRanges());
    this._emit('pitch', pitch);
    return pitch;
  }

  setTempo(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Tempo invalide.');
    this._settingsAllowed('manageVolumes');
    const { tempo } = clampSettings({ tempo: value }, this.songSettingsRanges());
    this._emit('tempo', tempo);
    return tempo;
  }

  setTrackVolume(type, volume) {
    if (![TRACK.BACKING, TRACK.LEAD_A, TRACK.LEAD_B].includes(type)) throw new Error('Piste vocale inconnue.');
    if (typeof volume !== 'number' || !Number.isFinite(volume)) throw new Error('Volume invalide.');
    this._settingsAllowed('manageVolumes');
    const value = Math.min(100, Math.max(0, Math.round(volume)));
    this._emit('trackVolume', { type, volume: value });
    return value;
  }

  // Valeurs par défaut des voix sur ce KaraFun : relevées à la première trame
  // d'un titre chargé sans volumes dans ses options (ensuite, le bar a pu les
  // changer pendant le titre). Celui du bar met les chœurs à 53.
  _observeDefaults(status) {
    const current = status.current;
    if (!current || current.id == null || String(current.id) === this._observedFor) return;
    this._observedFor = String(current.id);
    if (Array.isArray(current.song?.options?.tracks)) return;
    const live = liveFromStatus({ tracks: status.tracks });
    for (const field of ['guide', 'backing']) if (live[field] != null) this.observedDefaults[field] = live[field];
  }

  songSettingsDefaults() { return { ...SETTINGS_DEFAULTS, ...this.observedDefaults }; }

  // Pour les pages : plages, droits de KaraFun (null : non précisés),
  // fonctions confirmées ou refusées, dernier avis et état en direct.
  songSettingsState() {
    const flag = key => typeof this.permissions?.[key] === 'boolean' ? this.permissions[key] : null;
    return { ranges: this.songSettingsRanges(), defaults: this.songSettingsDefaults(),
      permissions: { manageVolumes: flag('manageVolumes'), manageQueue: flag('manageQueue') },
      support: { ...this.settingsSupport }, notice: this.settingsNotice, live: liveFromStatus(this.status) };
  }

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
      code: this.code, username: this.username,
      identityNotice: this.identityNotice, permissionWarning: this.permissionWarning,
      base: this.base, protocol: this.protocol, connected: this.connected, ready: this.ready,
      unreachable: this.unreachable, lastError: this.lastError, lastEventAt: this.lastEventAt,
      queue: this.queue, status: this.status, permissions: this.permissions, preferences: this.preferences,
      raw: this.raw, events: this.events.slice(-40), pings: this.noiseCount,
      connection: this.connectionState(), songSettings: this.songSettingsState(),
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

module.exports = { KaraFunBridge, normalizeResults, readSettings, normalizeKcsItem, BATTLE_MOD, isBattleItem,
  maskCode, lockIdentity, unknownSettingsSupport: freshSupport };
