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
// Reconnexions par l'URL KCS gardée (sans relire la page) : 3 s, 6 s, 12 s,
// 24 s puis 30 s, un peu dispersées. Elles repartent de 3 s quand la
// connexion précédente a tenu au moins 10 s : KaraFun absent renvoie son
// dernier état puis AppLeftEvent aussitôt, et les relances doivent alors
// continuer de s'espacer.
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30000;
const LINK_STABLE_MS = 10000;
// 20 connexions de suite closes aussitôt par AppLeftEvent (environ 10 min) :
// l'URL gardée est peut-être périmée, la page est relue une fois (budgétée).
// Sans ce filet, même « Reconnecter » réessaierait la même URL.
const APP_LEFT_REDISCOVER = 20;
// Page de découverte (https://www.karafun.com/<code>/) : KaraFun ne répond
// qu'aux 20 à 40 premières requêtes de chaque heure pleine depuis une même
// adresse, les deux domaines confondus, puis refuse tout jusqu'à l'heure
// pleine suivante (soirée du 2 octobre). La file en fait au plus 12 par
// heure : 9 pour ses essais automatiques, 3 gardés pour les clics du bar.
const HOUR_MS = 3600000;
const PAGE_LIMIT = 12;
const PAGE_AUTO_LIMIT = 9;
// Après un échec de découverte : 5 s, 15 s, 30 s, 1 min, 2 min, puis le reste
// du budget automatique réparti jusqu'à la fin de l'heure, 5 min au moins.
// KaraFun fermé toute la nuit : 9 pages par heure, une toutes les 6 à 7 min.
const DISCOVERY_STEPS_MS = [5000, 15000, 30000, 60000, 120000];
const DISCOVERY_SPREAD_MIN_MS = 300000;
// Gigue : ±15 %, 20 s au plus ; heure pleine suivante : 5 à 60 s après.
const DISCOVERY_JITTER_MAX_MS = 20000;
const HOUR_JITTER_MIN_MS = 5000;
const HOUR_JITTER_SPAN_MS = 55000;
// Retry-After au-delà de 2 h : ignoré (heure pleine suivante à la place),
// pour qu'un en-tête aberrant ne bloque pas toute la soirée.
const RETRY_AFTER_MAX_MS = 2 * HOUR_MS;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
// « Reconnecter » ne coupe pas une connexion qui vient de démarrer.
const RECONNECT_PATIENCE_MS = 15000;
// Demandes dont l'absence de réponse n'est qu'un avertissement : la file
// garde la connexion tant que KaraFun parle (chien de garde du transport).
const SOFT_REQUESTS = new Set(['remote.UpdateUsernameRequest']);
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
  'unknown-code': ['KaraFun fermé ou code changé',
    () => 'Code KaraFun inconnu ou télécommande fermée : vérifie le code affiché dans KaraFun et que sa télécommande est activée.'],
  refused: ['KaraFun limite les essais',
    status => `Le site KaraFun refuse ce PC (HTTP ${status || '?'}) : KaraFun limite les essais depuis cette connexion, la file réessaiera seule.`],
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

// Heure locale du PC du bar, HH:MM. `up` arrondit à la minute suivante :
// « jusqu’à 19:38 » n'annonce jamais une heure déjà passée.
function clock(at, up = false) {
  const date = new Date(up ? Math.ceil(at / 60000) * 60000 : at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// En-tête Retry-After : secondes ou date HTTP. Rend l'heure de fin, ou null
// s'il est absent, illisible ou démesuré.
function retryAfterAt(value, now) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const at = /^\d+$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  if (!Number.isFinite(at) || at - now > RETRY_AFTER_MAX_MS) return null;
  return Math.max(now, at);
}

const limitMessage = until => `KaraFun limite les essais depuis cette connexion jusqu’à ${clock(until, true)} : inutile de cliquer, la file réessaiera seule. Un téléphone sur un autre réseau (4G/5G) n’est pas concerné.`;
const BUSY_REASON = 'Trop d’essais auprès de KaraFun cette heure-ci';

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
    // Découverte : pages lues pendant l'heure pleine en cours, limite posée
    // par un refus de KaraFun, URL KCS de la dernière découverte réussie.
    // Cette URL contient un jeton : elle reste en mémoire, jamais écrite.
    this._pages = { hour: null, used: 0 };
    this._limit = null;
    this._window = null;
    this._kcs = null;
    this._socketFailures = 0;
    this._discoveryFailures = 0;
    this._urlRejects = 0;
    this._appLeftStreak = 0;
    this._retryKind = null;
    if (this.identityNotice) this._log(`KaraFun : ${this.identityNotice}`);
  }

  get base() { return this.bases[this.baseIdx % this.bases.length]; }
  _isLocal() { return LOCAL_HOSTS.includes(new URL(this.base).hostname); }

  // Pages de découverte de l'heure pleine en cours (les deux domaines).
  _pageBudget(now = Date.now()) {
    const hour = Math.floor(now / HOUR_MS);
    if (this._pages.hour !== hour) this._pages = { hour, used: 0 };
    return this._pages;
  }

  _canReadPage(byBar, now = Date.now()) {
    return this._pageBudget(now).used < (byBar ? PAGE_LIMIT : PAGE_AUTO_LIMIT);
  }

  // Heure pleine suivante plus une gigue tirée une fois pour cette heure.
  _nextWindow(now) {
    const hour = Math.floor(now / HOUR_MS) + 1;
    if (this._window?.hour !== hour) {
      this._window = { hour, at: hour * HOUR_MS + HOUR_JITTER_MIN_MS + Math.round(HOUR_JITTER_SPAN_MS * this.random()) };
    }
    return this._window.at;
  }

  _limitActive(now = Date.now()) {
    return this._limit && now < this._limit.until ? this._limit : null;
  }

  // Refus de KaraFun : rien avant l'heure donnée par Retry-After, sinon avant
  // l'heure pleine suivante (essai automatique 5 à 60 s après).
  _setLimit(retryAfter, now = Date.now()) {
    const until = retryAfterAt(retryAfter, now);
    this._limit = until == null ? { until: (Math.floor(now / HOUR_MS) + 1) * HOUR_MS, retryAt: this._nextWindow(now) } :
      { until, retryAt: until };
  }

  // Premier moment permis pour un essai automatique de la page, à partir de `at`.
  _pageGate(at, now = Date.now()) {
    const limit = this._limitActive(now);
    if (limit) at = Math.max(at, limit.retryAt);
    const pages = this._pageBudget(now);
    if (Math.floor(at / HOUR_MS) === pages.hour && pages.used >= PAGE_AUTO_LIMIT) at = this._nextWindow(now);
    return at;
  }

  // Prochain essai automatique après un échec de découverte.
  _discoveryAt(now) {
    const step = this._discoveryFailures;
    const pages = this._pageBudget(now);
    let delay;
    if (step < DISCOVERY_STEPS_MS.length) delay = DISCOVERY_STEPS_MS[step];
    else {
      const left = PAGE_AUTO_LIMIT - pages.used;
      if (left <= 0) return this._pageGate(now, now);
      delay = Math.max(DISCOVERY_SPREAD_MIN_MS, (this._nextWindow(now) - now) / (left + 1));
    }
    const spread = step ? Math.min(DISCOVERY_JITTER_MAX_MS, 0.15 * delay) : 0;
    let at = now + Math.round(delay - spread + 2 * spread * this.random());
    if (step >= DISCOVERY_STEPS_MS.length) at = Math.max(at, now + DISCOVERY_SPREAD_MIN_MS);
    return this._pageGate(at, now);
  }

  // `code` : code de fermeture du WebSocket ; `cause` : raison de l'oubli.
  _forgetKcs(code = null, cause = code == null ? 'erreur ou délai dépassé' : 'fermeture') {
    if (!this._kcs) return;
    this._kcs = null;
    this._record('info', 'url-kcs-oubliee', { code, cause });
  }
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
  // la connexion qu'on vient de fermer. L'URL KCS gardée pour ce code est
  // essayée d'abord, sans relire la page. Sinon, la page n'est relue que si
  // KaraFun ne limite pas les essais et s'il reste du budget dans l'heure.
  // Rend 'kept', 'started' ou { ok: false, reason, message } pour le bar.
  connect(code) {
    code = String(code || '').replace(/\D/g, '');
    if (!code) throw new Error('Code KaraFun manquant');
    if (this.code === code && this._keepCurrent()) return 'kept';
    const sameCode = this.code === code;
    if (!this._isLocal() && !(sameCode && this._kcs?.code === code)) {
      const now = Date.now(), limit = this._limitActive(now);
      if (sameCode && limit) {
        if (this._phase === 'idle') this._retry(DISCOVERY_ERRORS.refused[0], { mode: 'page', kind: 'limited' });
        return { ok: false, reason: 'limited', message: limitMessage(limit.until) };
      }
      if (!this._canReadPage(true, now)) {
        // Nouveau code : il est pris, son premier essai attend l'heure pleine.
        if (!sameCode || this._phase !== 'retry') {
          this._restart(code, sameCode);
          this._retry(BUSY_REASON, { mode: 'page', detail: `${BUSY_REASON}.` });
        }
        return { ok: false, reason: 'budget', message: `${BUSY_REASON} : prochain essai automatique à ${clock(this.retryAt)}.` };
      }
    }
    this._restart(code, sameCode);
    this._open({ byBar: true });
    return 'started';
  }

  _restart(code, sameCode) {
    this.disconnect();
    if (!sameCode) {
      this.bestPermissions = null; this.permissionWarning = null;
      this.nameConflictSince = null; this.nameConflictTries = 0;
      this._tries = 0; this._failures = 0;
      // Nouveau code : l'URL de l'ancien est oubliée, pas le budget de l'heure.
      this._kcs = null;
      this._socketFailures = 0; this._discoveryFailures = 0; this._urlRejects = 0; this._appLeftStreak = 0;
    }
    this.code = code;
    this.queue = [];
    this.status = this.permissions = this.preferences = null;
    this.raw = {};
  }

  _keepCurrent() {
    if (this._phase === 'ready' && this.ready) return true;
    if (this._phase === 'waiting-name' && this.nameConflictSince != null) return true;
    return ['discovering', 'opening', 'waiting-auth', 'waiting-name', 'waiting-data'].includes(this._phase) &&
      Date.now() - this._phaseSince < RECONNECT_PATIENCE_MS;
  }

  async _open({ byBar = false } = {}) {
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
    const opening = { base, code: maskCode(this.code), essai: this._tries };
    // Le faux KaraFun local n'a pas de page de découverte.
    if (this._isLocal()) {
      this._record('info', 'connexion', opening);
      this._setPhase('opening');
      this._openLegacy(base, active);
      return;
    }
    // URL KCS de la dernière découverte réussie : pas de page à relire.
    if (this._kcs?.code === this.code) {
      this._record('info', 'connexion', { ...opening, urlGardee: true });
      try { this._openKcs(this._kcs.url, active, { kept: true }); }
      catch { this._forgetKcs(null, 'WebSocket indisponible'); this._discoveryFailed({ host: new URL(base).hostname, kind: 'no-websocket' }); }
      return;
    }
    // Filet de sécurité : les relances sont déjà prévues dans le budget.
    if (!this._canReadPage(byBar)) { this._retry(BUSY_REASON, { mode: 'page', detail: `${BUSY_REASON}.` }); return; }
    this._pageBudget().used++;
    this._record('info', 'connexion', opening);
    this._setPhase('discovering');
    this.emit('change');
    const found = await this._discover(base);
    if (!active()) return;
    // Une vraie réponse de KaraFun lève la limite.
    if (found.status && found.kind !== 'refused') this._limit = null;
    if (!found.settings) { this._discoveryFailed(found); return; }
    this._record('info', 'discovery', { host: found.host, status: found.status, keys: found.keys });
    if (!found.settings.kcs_url) { this._openLegacy(base, active); return; }
    this._kcs = { code: this.code, url: found.settings.kcs_url };
    // Une URL toute neuve refusée de suite ne relance pas la page en boucle.
    this._discoveryFailures = this._urlRejects;
    try { this._openKcs(this._kcs.url, active, { kept: false }); }
    catch { this._kcs = null; this._discoveryFailed({ ...found, settings: null, kind: 'no-websocket' }); }
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
    if ([401, 403, 429].includes(response.status) || (!hasSettings && CHALLENGE.test(html))) {
      let retryAfter = null;
      try { retryAfter = response.headers?.get?.('retry-after') ?? null; } catch { /* en-têtes illisibles */ }
      return { ...info, kind: 'refused', retryAfter };
    }
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
    if (kind === 'refused') this._setLimit(found.retryAfter);
    if (this.bases.length > 1) this.baseIdx++;
    const where = [kind, status && `HTTP ${status}`, host, finalHost && `→ ${finalHost}`,
      keys && `Settings ${keys.Settings ? 'présent' : 'absent'}, kcs_url ${keys.kcs_url ? 'présent' : 'absent'}`].filter(Boolean).join(', ');
    this._retry(reason, { detail: `${this.lastError} [${where}]`, same: `${kind}|${status}|${this.lastError}`,
      mode: 'discovery', kind: kind === 'refused' ? 'limited' : kind === 'unknown-code' ? 'closed' : null });
    // Jamais le code ni l'URL KCS : l'hôte, l'état HTTP, le budget de l'heure.
    const limit = this._limitActive();
    this._record('info', 'discovery-error', { kind, status, host, finalHost, keys, message: this.lastError,
      pages: { used: this._pageBudget().used, limit: PAGE_LIMIT }, nextAt: new Date(this.retryAt).toISOString(),
      ...(limit ? { limitedUntil: new Date(limit.until).toISOString() } : {}) });
  }

  // Relance après un échec. `mode` : 'socket' (URL KCS gardée ou faux KaraFun
  // local, 3 à 30 s), 'discovery' (page après un échec de découverte,
  // budgétée) ou 'page' (page dès que le budget et la limite le permettent).
  _retry(reason = 'Connexion KaraFun perdue', { detail = this.lastError, same = detail, mode = 'socket', kind = null } = {}) {
    this._attempt++;
    const now = Date.now(), link = this._link;
    this._closeSocket();
    this.connected = this.ready = false;
    clearTimeout(this.retryTimer);
    // Connexion perdue après « prêt » : les essais se recomptent depuis 1.
    if (this._resetTries) { this._tries = 0; this._resetTries = false; }
    // Sans URL gardée, le prochain essai relit la page : il suit son budget.
    if (mode === 'socket' && !this._isLocal() && this._kcs?.code !== this.code) mode = 'discovery';
    let at;
    if (mode === 'socket') {
      if (link.provenAt != null && now - link.provenAt >= LINK_STABLE_MS) this._socketFailures = 0;
      const failures = this._socketFailures++;
      const step = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures, 4));
      at = now + (failures ? Math.min(RETRY_MAX_MS, Math.round(step * (0.85 + 0.3 * this.random()))) : step);
    } else if (mode === 'discovery') {
      at = this._discoveryAt(now);
      this._discoveryFailures++;
    } else at = this._pageGate(now, now);
    const delay = at - now;
    this._failures++;
    this.retryAt = at;
    this._retryReason = reason;
    this._retryKind = kind;
    this._setPhase('retry');
    // Une même panne n'écrit qu'une ligne, puis une toutes les 10 relances.
    if (same !== this._lastLoggedRetry || this._failures % 10 === 0) {
      this._lastLoggedRetry = same;
      const pages = mode === 'socket' ? '' : ` Page KaraFun : ${this._pageBudget(now).used}/${PAGE_LIMIT} cette heure.`;
      const when = delay > 120000 ? `Nouvel essai à ${clock(at)} (dans ${duration(delay)})` : `Nouvel essai dans ${duration(delay)}`;
      this._log(`KaraFun : ${detail || reason}${pages} ${when} (essai ${this._tries + 1}).`);
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

  // `kept` : URL gardée d'une découverte précédente (sinon toute neuve).
  _openKcs(url, active, { kept = false } = {}) {
    const socket = new KcsTransport(url);
    this.protocol = 'kcs';
    this.socket = socket;
    this._setPhase('opening');
    // KaraFun a accepté cette URL : code validé ou premières données reçues.
    const proven = () => {
      if (this._link.provenAt != null) return;
      this._link.provenAt = Date.now();
      this._discoveryFailures = 0;
      this._urlRejects = 0;
    };
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
        proven();
        if (!this.ready) this._setPhase('waiting-name');
        this._log(`KaraFun : code accepté, demande du nom ${this.username}.`);
        updateUsername();
      } else if (m.type === 'remote.UsernameUpdateEvent' || m.type === 'remote.UpdateUsernameResponse') {
        if (p.username && p.username !== this.username) return;
        this._nameAccepted();
      } else if (m.type === 'remote.QueueEvent' || m.type === 'remote.QueueResponse') {
        if (!p.queue || !Array.isArray(p.queue.items)) return;
        proven();
        this.raw.queue = p.queue;
        this._accept('queue', p.queue.items.map(normalizeKcsItem));
      } else if (m.type === 'remote.StatusEvent' || m.type === 'remote.StatusResponse') {
        if (!p.status || typeof p.status.state !== 'number') return;
        proven();
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
        this.emit('change');
      } else if (m.type === 'remote.AppLeftEvent') {
        // KaraFun absent : le serveur KCS renvoie son dernier état puis
        // AppLeftEvent dès la connexion. Reconnexion par l'URL gardée.
        const brief = this._link.provenAt != null && Date.now() - this._link.provenAt < LINK_STABLE_MS;
        this._appLeftStreak = brief ? this._appLeftStreak + 1 : 1;
        this.unreachable = true;
        this.lastError = 'KaraFun est fermé ou sa télécommande a été désactivée.';
        this._record('info', 'connexion-perdue', this.lastError);
        if (this._appLeftStreak < APP_LEFT_REDISCOVER) { this._retry('KaraFun fermé ou télécommande désactivée'); return; }
        this._appLeftStreak = 0;
        this._forgetKcs(null, 'AppLeftEvent répétés');
        this._retry('KaraFun fermé ou télécommande désactivée', { mode: 'page' });
      } else if (m.type === 'Error') {
        if (p.type === 4 && /username is already used/i.test(p.message || '')) {
          // L'Error répond à la demande de nom, même sans son identifiant.
          if (m.id === undefined) socket.settle('remote.UpdateUsernameRequest');
          this._nameUsed(askName);
          return;
        }
        this.lastError = `Commande KaraFun refusée : ${p.message || p.type || 'erreur inconnue'}`;
        this.emit('change');
      }
    });
    // Échec avant que KaraFun accepte l'URL (erreur, fermeture 4403/4401/
    // 4404/4210…, délai dépassé) : elle est oubliée et la page sera relue.
    // URL gardée : relue dès que le budget le permet ; URL toute neuve : la
    // relecture suit l'espacement des échecs de découverte.
    const lost = (message, reason, code = null) => {
      if (!active()) return;
      this.unreachable = true;
      this.lastError = message;
      this._record('info', 'connexion-perdue', message);
      if (this._link.provenAt != null) { this._retry(reason); return; }
      this._forgetKcs(code);
      if (!kept) this._urlRejects++;
      this._retry(reason, { mode: kept ? 'page' : 'discovery' });
    };
    socket.on('stale', message => lost(message, 'KaraFun ne répond plus'));
    socket.on('request-timeout', type => {
      if (!active()) return;
      if (!SOFT_REQUESTS.has(type)) {
        lost(`KaraFun ne confirme plus les commandes (${type}) ; reconnexion en cours.`, 'Commande KaraFun non confirmée');
        return;
      }
      this._record('info', 'sans-reponse', type);
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
      `KaraFun a fermé la connexion (code ${code})`, code ?? null));
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
      this._link.provenAt = Date.now();
      this._discoveryFailures = 0;
      this._urlRejects = 0;
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
    // Attente entre deux essais : limite de KaraFun, KaraFun fermé, ou panne.
    const limit = this._limitActive(now), pages = this._pageBudget(now);
    const wait = (this.retryAt ?? now) - now;
    const limited = phase === 'retry' && this._retryKind === 'limited' && limit;
    const retry = limited ? `KaraFun limite les essais jusqu’à ${clock(limit.until, true)}` :
      this._retryKind === 'closed' ? `KaraFun fermé ou code changé : prochain essai à ${clock(this.retryAt ?? now)}` :
      wait > 120000 ? `${this._retryReason} : prochain essai à ${clock(this.retryAt)}` :
      `${this._retryReason} : nouvel essai dans ${duration(wait)}${this._tries > 1 ? ` (essai ${this._tries + 1})` : ''}`;
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
      retry: ['error', retry],
    };
    const [level, label] = labels[phase];
    return {
      phase, level, label, since: this._phaseSince, attempt: this._tries, protocol: this.protocol,
      retryAt: phase === 'retry' ? this.retryAt : null,
      nameConflict: conflict,
      // Bouton « Prendre un autre nom maintenant » : POST /api/staff/kf { action: 'new-name' }.
      canRename: !!conflict,
      // Alerte que le bar ne peut pas fermer : conflit de nom ou limite de KaraFun.
      alert: conflict ? `KaraFun garde encore l’ancienne connexion de ${conflict.holder} (KaraFun relancé trop vite, ou une autre File karaoké ouverte avec le même nom). La file redemande ce nom toutes les 4 s pour garder ses droits d’administrateur et en prendra un autre ${later}. Tu peux aussi prendre un autre nom maintenant, puis lui redonner les droits dans KaraFun.` :
        limited ? limitMessage(limit.until) : null,
      // Pages de découverte de l'heure pleine en cours (sans secret).
      discovery: { used: pages.used, limit: PAGE_LIMIT, hourEndsAt: (pages.hour + 1) * HOUR_MS, limitedUntil: limit ? limit.until : null },
    };
  }

  _emit(name, payload) {
    if (!this.socket || !this.connected || !this.ready) throw new Error('Pas connecté à KaraFun');
    if (this.protocol === 'kcs') {
      const messages = {
        queueAdd: ['remote.AddToQueueRequest', payload && { song: { type: 1, id: payload.songId },
          options: payload.mod ? { mod: payload.mod } : { singer: payload.singer }, position: payload.pos }],
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
    } else if (!this._isLocal()) {
      throw new Error('Le mode Battle automatique nécessite la télécommande KaraFun récente.');
    }
    this._emit('queueAdd', { songId: id, pos,
      singer: 'Battle collective', mod: BATTLE_MOD });
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
      connection: this.connectionState(),
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
  maskCode, lockIdentity };
