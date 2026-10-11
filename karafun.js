'use strict';
/* Pont vers la télécommande KaraFun : KCS JSON actuel, socket.io v2 historique
 * et démo. Découverte des paramètres officiels sans exécuter de code distant. */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const io = require('socket.io-client');
const { KcsTransport } = require('./kcs-transport');
const { rangesFrom, addOptions, queueItemOptions, clampSettings, songTracksOf, guideVoicesOf, liveFromStatus, TRACK,
  DEFAULTS: SETTINGS_DEFAULTS } = require('./song-settings');
// Valeur en direct d'un réglage essayé : 'pitch', 'tempo', 'backing' ou
// 'voice:<type>' (volume d'une voix guide).
const probedValue = (live, field) => (/^voice:/.test(field) ? live?.voices?.[field.slice(6)] : live?.[field]) ?? null;

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

// `songTracks` : pistes vocales du titre (4 chœurs, 5, 6… voix guides),
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

// Écriture atomique d'un petit fichier JSON de data/. Rend false si le
// disque refuse : l'information reste alors en mémoire pour cette exécution.
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, file);
    return true;
  } catch { return false; }
}

function saveIdentity(file, suffix) {
  if (file) writeJson(file, { suffix });
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
// Sans ce filet, même « Reconnecter » réessaierait la même URL. Si l'URL que
// donne cette page se referme aussi aussitôt, KaraFun reste absent : essais
// arrêtés, comme pour « KaraFun fermé » (sinon le cycle durerait la nuit).
const APP_LEFT_REDISCOVER = 20;
// Page de découverte (https://www.karafun.com/<code>/) : KaraFun ne répond
// qu'aux 20 à 40 premières requêtes de chaque heure pleine depuis une même
// adresse, les deux domaines confondus, puis refuse tout jusqu'à l'heure
// pleine suivante (soirée du 2 octobre). La file en fait au plus 12 par
// heure : 9 pour ses essais automatiques, 3 gardés pour les clics du bar.
const HOUR_MS = 3600000;
const PAGE_LIMIT = 12;
const PAGE_AUTO_LIMIT = 9;
// Après un échec de découverte (réseau coupé, site en panne, page inattendue) :
// 5 s, 15 s, 30 s, 1 min, 2 min, puis le reste du budget automatique réparti
// jusqu'à la fin de l'heure, 5 min au moins : une page toutes les 6 à 7 min
// si la panne dure. Une relance rapide n'est prise que si les essais
// automatiques restants couvrent encore la fin de l'heure avec 7 min d'écart
// au plus : le retour est repéré en 7 min 30 au plus, même juste après un
// démarrage, un nouveau code ou une coupure (sinon les relances rapides
// vident le budget).
// KaraFun fermé ou code changé (page sans télécommande, URL toute neuve
// refusée) : les seules relances rapides, environ 4 min en tout, tant qu'un
// essai automatique est permis tout de suite dans l'heure. Elles couvrent
// KaraFun lancé avec la file (DEMARRER.bat) et prêt un peu après, même après
// une autre panne (la série repart alors de 5 s). Ensuite, plus aucun essai :
// bar fermé, PC de KaraFun éteint, la page n'est plus lue de la nuit ; à
// l'ouverture, « Reconnecter » la relit tout de suite. Une seule série par
// heure pleine tant que KaraFun n'a pas été joint : les clics suivants ne
// lisent que leur page et gardent ainsi le budget de l'heure. Un clic
// pendant la série prend la place de la relance prévue sans l'avancer.
const DISCOVERY_STEPS_MS = [5000, 15000, 30000, 60000, 120000];
const DISCOVERY_SPREAD_MIN_MS = 300000;
const DISCOVERY_COVER_MS = 420000;
// URL KCS gardée en échec 20 fois de suite sans refus de KaraFun (erreur,
// coupure 1006, délai dépassé : le réseau plutôt que l'URL), soit environ
// 9 min : la page est relue une fois pour la vérifier, si le budget le
// permet. L'URL n'est oubliée que si KaraFun répond (réseau revenu) ; réseau
// toujours coupé, elle reste gardée et les relances du WebSocket continuent.
const URL_FAIL_REDISCOVER = 20;
// Fermeture du WebSocket par laquelle KaraFun refuse l'URL avant
// l'authentification : session finie (4403, observé la nuit du 2 octobre),
// KaraFun fermé, code changé, 4210 vu une fois. L'URL est alors oubliée.
const urlRejected = code => code === 4210 || (code >= 4400 && code <= 4499);
const CLOSED_REASON = 'KaraFun fermé ou code changé';
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
// Réglages de titre (tonalité, tempo, voix) : décrits par le SDK de KaraFun
// Web, pas encore vérifiés sur le KaraFun du bar. Une Error avec le même
// identifiant marque la fonction comme non prise en charge ('refused') ; une
// réponse, ou un état de KaraFun qui montre la valeur envoyée, la confirme
// ('ok'). Un silence de 8 s ne prouve rien (client lent, confirmation par
// l'état seulement) : 'silent', avec un avis, et la fonction reste essayable.
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
  'unknown-code': [CLOSED_REASON,
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

// En-tête Retry-After : nombre entier de secondes ou date HTTP
// (« Fri, 02 Oct 2026 18:00:00 GMT »). Rend l'heure de fin, ou null s'il est
// absent, illisible, déjà passé (-5, 0, 1.5, date passée) ou démesuré : la
// limite dure alors jusqu'à l'heure pleine suivante.
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
function retryAfterAt(value, now) {
  const text = String(value ?? '').trim();
  const at = /^\d+$/.test(text) ? now + Number(text) * 1000 : HTTP_DATE.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(at) && at > now && at - now <= RETRY_AFTER_MAX_MS ? at : null;
}

// Pages lues dans l'heure pleine, limite de KaraFun et heure du dernier arrêt
// des essais, gardées dans data/ (sans code ni URL) : relancer la file ne
// remet ni le compteur à zéro ni une nouvelle série de relances rapides.
function readPages(file) {
  if (!file) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
    return { hour: count(saved.hour), used: count(saved.used) ?? 0, auto: count(saved.auto) ?? 0,
      limitUntil: count(saved.limitUntil), limitRetryAt: count(saved.limitRetryAt), stoppedHour: count(saved.stoppedHour) };
  } catch { return null; }
}

const limitMessage = until => `KaraFun limite les essais depuis cette connexion jusqu’à ${clock(until, true)} : inutile de cliquer, la file réessaiera seule. Un téléphone sur un autre réseau (4G/5G) n’est pas concerné.`;
const BUSY_REASON = 'Trop d’essais auprès de KaraFun cette heure-ci';

class KaraFunBridge extends EventEmitter {
  constructor({ logDir, bases, identityFile = null, log = null, lockOwner = null, budgetFile = null } = {}) {
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
    this.settingsNotices = {}; // un avis par fonction, le plus récent en dernier
    this._settingsProbe = {};  // dernière valeur envoyée en direct, à confirmer par l'état de KaraFun
    this._optionAdds = new Map(); // identifiant KCS → ajout avec réglages sans réponse
    this.observedDefaults = {}; // chœurs d'un titre chargé sans réglage (voir _observeDefaults)
    this._backingChanged = false;
    this.provisionalDefaults = false; // chœurs relevés après un titre vu déjà en lecture, pas encore confirmés
    // Chœurs transmis d'un titre vu pour la première fois déjà en lecture, ou
    // d'avant une session perdue ou ce pont : inconnus au départ (application
    // relancée entre deux titres, KaraFun qui garde un réglage en direct).
    this._carriedUnseen = true;
    this._observedFor = null;
    this._observedBacking = null; // chœurs du premier état vu du titre `_observedFor`
    this._lastBacking = null; // chœurs du dernier état du titre `_observedFor`
    this._loadingSeen = new Set(); // titres vus annoncés ou se charger (états 1 à 3)
    // Numéro de la session KCS (voir _forgetSession) et celui de la session
    // qui a donné `status` : le serveur ne confond pas deux sessions.
    this.kcsSession = 0;
    this.statusSession = 0;
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
    // Découverte : pages lues pendant l'heure pleine en cours (toutes, et
    // celles des essais automatiques), limite posée par un refus de KaraFun,
    // URL KCS de la dernière découverte réussie. Cette URL contient un jeton :
    // elle reste en mémoire, jamais écrite. Le compteur et la limite, sans
    // secret, sont gardés dans `budgetFile` pour survivre à un redémarrage.
    this.budgetFile = budgetFile;
    this._pages = { hour: null, used: 0, auto: 0 };
    this._limit = null;
    this._window = null;
    this._kcs = null;
    this._socketFailures = 0;
    this._discoveryFailures = 0;
    this._urlFailures = 0;
    this._appLeftStreak = 0;
    // Page déjà relue après une série d'AppLeftEvent, sans connexion qui tienne depuis.
    this._appLeftChecked = false;
    this._retryKind = null;
    // Heure pleine du dernier arrêt des essais (KaraFun fermé), oubliée dès
    // que KaraFun est joint : pas de nouvelle série de relances rapides avant.
    this._stoppedHour = null;
    if (this.identityNotice) this._log(`KaraFun : ${this.identityNotice}`);
    this._restorePages();
  }

  // Programme relancé dans la même heure pleine : pages déjà lues, limite
  // de KaraFun (une limite au-delà de 2 h est ignorée) et arrêt des essais
  // repris du fichier. Des redémarrages répétés ne relancent pas une série de
  // relances rapides chacun : les pages gardées pour le bar restent libres.
  _restorePages(now = Date.now()) {
    const saved = readPages(this.budgetFile);
    if (!saved) return;
    if (saved.hour === Math.floor(now / HOUR_MS)) this._pages = { hour: saved.hour, used: saved.used, auto: saved.auto };
    if (saved.stoppedHour === Math.floor(now / HOUR_MS)) this._stoppedHour = saved.stoppedHour;
    if (saved.limitUntil > now && saved.limitUntil - now <= RETRY_AFTER_MAX_MS) {
      this._limit = { until: saved.limitUntil, retryAt: Math.max(saved.limitRetryAt ?? 0, saved.limitUntil) };
    }
    if (!this._pages.used && !this._limit) return;
    this._record('info', 'budget-repris', { pages: { used: this._pages.used, limit: PAGE_LIMIT },
      ...(this._limit ? { limitedUntil: new Date(this._limit.until).toISOString() } : {}) });
    this._log(`KaraFun : page déjà lue ${this._pages.used}/${PAGE_LIMIT} fois cette heure avant le redémarrage${this._limit ? ` ; KaraFun limite les essais jusqu’à ${clock(this._limit.until, true)}` : ''}${this._stoppedHour != null ? ' ; essais déjà arrêtés cette heure (KaraFun fermé)' : ''}.`);
  }

  _savePages(now = Date.now()) {
    if (!this.budgetFile) return;
    const pages = this._pageBudget(now), limit = this._limit;
    writeJson(this.budgetFile, { hour: pages.hour, used: pages.used, auto: pages.auto,
      limitUntil: limit ? limit.until : null, limitRetryAt: limit ? limit.retryAt : null, stoppedHour: this._stoppedHour });
  }

  get base() { return this.bases[this.baseIdx % this.bases.length]; }
  _isLocal() { return LOCAL_HOSTS.includes(new URL(this.base).hostname); }

  // Pages de découverte de l'heure pleine en cours (les deux domaines) :
  // `used` toutes, `auto` celles des essais automatiques.
  _pageBudget(now = Date.now()) {
    const hour = Math.floor(now / HOUR_MS);
    if (this._pages.hour !== hour) this._pages = { hour, used: 0, auto: 0 };
    return this._pages;
  }

  // Essais automatiques encore permis cette heure : 9 au plus, sans jamais
  // dépasser les 12 pages au total. Les clics du bar, le démarrage et un
  // nouveau code prennent d'abord les 3 pages gardées pour eux.
  _autoLeft(now = Date.now()) {
    const pages = this._pageBudget(now);
    return Math.max(0, Math.min(PAGE_AUTO_LIMIT - pages.auto, PAGE_LIMIT - pages.used));
  }

  _canReadPage(byBar, now = Date.now()) {
    return byBar ? this._pageBudget(now).used < PAGE_LIMIT : this._autoLeft(now) > 0;
  }

  // Une page de plus. Le fichier est relu d'abord : une autre File karaoké
  // du même dossier (même connexion Internet) a pu en lire aussi.
  _countPage(byBar, now = Date.now()) {
    const pages = this._pageBudget(now), saved = readPages(this.budgetFile);
    if (saved?.hour === pages.hour) { pages.used = Math.max(pages.used, saved.used); pages.auto = Math.max(pages.auto, saved.auto); }
    pages.used++;
    if (!byBar) pages.auto++;
    this._savePages(now);
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
  // l'heure pleine qui suit le DÉPART de la requête (`sentAt`), essai
  // automatique 5 à 60 s après. Un refus parti à 19:59:59 et reçu à 20:00:00
  // vise le quota de 19 h, déjà remis à zéro : la limite est alors levée.
  _setLimit(retryAfter, now = Date.now(), sentAt = now) {
    const until = retryAfterAt(retryAfter, now);
    this._limit = until == null ? { until: (Math.floor(sentAt / HOUR_MS) + 1) * HOUR_MS, retryAt: this._nextWindow(sentAt) } :
      { until, retryAt: until };
    this._savePages(now);
  }

  // Premier moment permis pour un essai automatique de la page, à partir de `at`.
  _pageGate(at, now = Date.now()) {
    const limit = this._limitActive(now);
    if (limit) at = Math.max(at, limit.retryAt);
    if (Math.floor(at / HOUR_MS) === this._pageBudget(now).hour && this._autoLeft(now) <= 0) at = this._nextWindow(now);
    return at;
  }

  // Prochain essai automatique après un échec de découverte. Relance rapide
  // seulement si, après elle, les essais restants couvrent encore la fin de
  // l'heure avec 7 min d'écart au plus ; sinon le budget restant est réparti
  // jusqu'à l'heure pleine suivante, 5 min d'écart au moins. `closed`
  // (KaraFun fermé ou code changé) : relance rapide seulement, si un essai
  // automatique est permis tout de suite et si aucune série ne s'est déjà
  // arrêtée cette heure ; sinon null, plus aucun essai.
  _discoveryAt(now, closed = false) {
    const step = this._discoveryFailures;
    const left = this._autoLeft(now);
    if (closed && (step >= DISCOVERY_STEPS_MS.length || left <= 0 || this._limitActive(now) ||
      (!step && this._stoppedHour === Math.floor(now / HOUR_MS)))) return null;
    if (left <= 0) return this._pageGate(now, now);
    const rest = this._nextWindow(now) - now;
    const fast = closed || (step < DISCOVERY_STEPS_MS.length && left * DISCOVERY_COVER_MS >= rest - DISCOVERY_STEPS_MS[step]);
    const delay = fast ? DISCOVERY_STEPS_MS[step] : Math.max(DISCOVERY_SPREAD_MIN_MS, rest / (left + 1));
    const spread = step ? Math.min(DISCOVERY_JITTER_MAX_MS, 0.15 * delay) : 0;
    let at = now + Math.round(delay - spread + 2 * spread * this.random());
    if (!fast) at = Math.max(at, now + DISCOVERY_SPREAD_MIN_MS);
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
      if (this._stoppedHour != null) { this._stoppedHour = null; this._savePages(); }
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
    delete this.settingsNotices[kind];
    if (message && message.type !== 'Error') this.settingsSupport[kind] = 'ok';
    else if (message) {
      this.settingsSupport[kind] = 'refused';
      this.settingsNotices[kind] = `KaraFun refuse de régler ${what} : ${message.payload?.message || 'erreur inconnue'}`;
      this._record('info', 'reglage-refuse', { request: kind, message: this.settingsNotices[kind] });
    } else {
      if (this.settingsSupport[kind] !== 'ok') this.settingsSupport[kind] = 'silent';
      this.settingsNotices[kind] = `KaraFun n’a pas répondu aux réglages ${of} en 8 s : vérifie dans KaraFun ; un nouvel essai reste possible.`;
    }
    this.emit('change');
  }

  // KaraFun peut appliquer un réglage du titre en cours sans répondre à la
  // demande : un nouvel état qui montre la valeur envoyée le confirme (sauf
  // si le titre l'avait déjà).
  _confirmFromStatus(status) {
    const live = liveFromStatus(status);
    for (const [kind, probe] of Object.entries(this._settingsProbe)) {
      if (probedValue(live, probe.field) !== probe.value) continue;
      delete this._settingsProbe[kind];
      if (probe.before === probe.value || this.settingsSupport[kind] === 'refused') continue;
      this.settingsSupport[kind] = 'ok';
      delete this.settingsNotices[kind];
    }
  }

  _probeSetting(kind, field, value) {
    this._settingsProbe[kind] = { field, value, before: probedValue(liveFromStatus(this.status), field) };
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
  // Essais arrêtés (KaraFun fermé ou code changé) : page relue tout de suite ;
  // relances rapides de nouveau à partir de l'heure pleine qui suit l'arrêt,
  // ou pour un nouveau code.
  // Rend 'kept', 'started' ou { ok: false, reason, message } pour le bar ;
  // `this.code` dit ensuite quel code le pont garde.
  connect(code) {
    code = String(code || '').replace(/\D/g, '');
    if (!code) throw new Error('Code KaraFun manquant');
    if (this.code === code && this._keepCurrent()) return 'kept';
    const sameCode = this.code === code;
    if (!this._isLocal() && !(sameCode && this._kcs?.code === code)) {
      const now = Date.now(), limit = this._limitActive(now);
      // Même code, ou code retenu au démarrage pendant une limite reprise du
      // fichier : KaraFun refuserait, rien n'est relu. Sans essai prévu
      // (démarrage, essais arrêtés), l'essai automatique d'après la limite
      // est pris. Essais arrêtés et limite ensemble ne devraient pas arriver
      // (une réponse « fermé » lève la limite) : simple prudence.
      if (limit && (sameCode || this.code == null)) {
        if (this._phase === 'idle' || this._phase === 'stopped') {
          if (!sameCode) this._restart(code, false);
          this._retry(DISCOVERY_ERRORS.refused[0], { mode: 'page', kind: 'limited' });
        }
        return { ok: false, reason: 'limited', message: limitMessage(limit.until) };
      }
      if (!this._canReadPage(true, now)) {
        // Budget épuisé : un autre code (faute de frappe probable) ne coupe
        // pas une connexion ouverte, prête ou en cours ; le code actuel reste
        // en place. Une simple recherche de page en cours ne compte pas.
        if (!sameCode && this.code && this.connected && this._keepCurrent()) {
          return { ok: false, reason: 'budget',
            message: `${BUSY_REASON} : la connexion actuelle est gardée ; un autre code pourra être essayé à partir de ${clock((Math.floor(now / HOUR_MS) + 1) * HOUR_MS)}.` };
        }
        // Nouveau code sans connexion qui marche : il est pris, son premier
        // essai attend l'heure pleine.
        if (!sameCode || this._phase !== 'retry') {
          this._restart(code, sameCode);
          this._retry(BUSY_REASON, { mode: 'page', detail: `${BUSY_REASON}.` });
        }
        return { ok: false, reason: 'budget', message: `${BUSY_REASON} : prochain essai automatique à ${clock(this.retryAt)}.` };
      }
    }
    // Clic pendant les relances rapides de « KaraFun fermé » : il prend la
    // place de la relance prévue sans avancer la série (sinon un clic pendant
    // la dernière attente arrêterait les essais).
    if (sameCode && this._phase === 'retry' && this._retryKind === 'closed' && this._discoveryFailures > 0) this._discoveryFailures--;
    this._restart(code, sameCode);
    this._open({ byBar: true });
    return 'started';
  }

  _restart(code, sameCode) {
    // Autre installation : chœurs par défaut à relever de nouveau. Le même
    // KaraFun peut continuer sous un nouveau code avec des chœurs réglés en
    // direct : chaîne inconnue, et des chœurs déjà changés (même avant une
    // coupure) ne sont jamais relevés (forgetDefaults).
    if (!sameCode) this.forgetDefaults();
    this.disconnect();
    this._appLeftChecked = false;
    if (!sameCode) {
      this.bestPermissions = null; this.permissionWarning = null;
      this.nameConflictSince = null; this.nameConflictTries = 0;
      this._tries = 0; this._failures = 0;
      // Nouveau code : l'URL de l'ancien est oubliée, pas le budget de l'heure ;
      // un arrêt des essais de l'ancien ne prive pas celui-ci de relances
      // rapides (au démarrage, l'arrêt repris du fichier est gardé).
      this._kcs = null;
      if (this.code != null) this._stoppedHour = null;
      this._socketFailures = 0; this._discoveryFailures = 0; this._urlFailures = 0; this._appLeftStreak = 0;
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
    // Chaque connexion repart de capacités inconnues : KaraFun a pu être mis
    // à jour, et un refus ou un silence d'avant ne bloque rien pour la soirée.
    this.settingsSupport = freshSupport();
    this.settingsNotices = {};
    this._settingsProbe = {};
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
    // URL KCS de la dernière découverte réussie : pas de page à relire, sauf
    // vérification après 20 échecs (et seulement s'il reste du budget).
    const kcs = this._kcs?.code === this.code ? this._kcs : null;
    if (kcs?.check && !this._canReadPage(byBar)) kcs.check = false;
    if (kcs && !kcs.check) {
      this._record('info', 'connexion', { ...opening, urlGardee: true });
      try { this._openKcs(this._kcs.url, active, { kept: true }); }
      catch { this._forgetKcs(null, 'WebSocket impossible à créer'); this._discoveryFailed({ host: new URL(base).hostname, kind: this._socketFailure() }); }
      return;
    }
    // Filet de sécurité : les relances sont déjà prévues dans le budget.
    if (!this._canReadPage(byBar)) { this._retry(BUSY_REASON, { mode: 'page', detail: `${BUSY_REASON}.` }); return; }
    this._countPage(byBar);
    this._record('info', 'connexion', opening);
    this._setPhase('discovering');
    this.emit('change');
    const sentAt = Date.now();
    const found = await this._discover(base);
    if (!active()) return;
    // Une vraie réponse de KaraFun lève la limite.
    if (found.status && found.kind !== 'refused' && this._limit) { this._limit = null; this._savePages(); }
    // Vérification de l'URL gardée : KaraFun répond, elle est oubliée (une
    // URL neuve la remplace) ; pas de réponse, le réseau est toujours coupé :
    // elle reste gardée et le WebSocket est réessayé toutes les 30 s.
    if (kcs) {
      if (!found.status) { kcs.check = false; this._discoveryFailed({ ...found, sentAt }, 'socket'); return; }
      this._forgetKcs(null, 'échecs répétés');
    }
    if (!found.settings) { this._discoveryFailed({ ...found, sentAt }); return; }
    this._record('info', 'discovery', { host: found.host, status: found.status, keys: found.keys });
    if (!found.settings.kcs_url) { this._openLegacy(base, active); return; }
    this._kcs = { code: this.code, url: found.settings.kcs_url };
    this._urlFailures = 0;
    // La cadence des échecs de découverte ne repart de 5 s qu'une fois l'URL
    // acceptée par KaraFun (proven), au premier « KaraFun fermé » après une
    // autre panne, ou après un arrêt des essais : une URL toute neuve refusée,
    // ou un WebSocket impossible à créer, ne relance pas la page toutes les 5 s.
    try { this._openKcs(this._kcs.url, active, { kept: false }); }
    catch { this._kcs = null; this._discoveryFailed({ ...found, settings: null, kind: this._socketFailure() }); }
  }

  // WebSocket impossible à créer : absent (Node trop ancien) ou URL refusée.
  _socketFailure() { return typeof globalThis.WebSocket === 'function' ? 'bad-page' : 'no-websocket'; }

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
      // Un fragment (#…) est refusé par le WebSocket de Node.
      if (protocol !== 'wss:' || String(settings.kcs_url).includes('#')) return { ...info, kind: 'bad-page' };
    }
    return { ...info, settings };
  }

  // `mode` : 'socket' quand une URL gardée reste à réessayer (réseau coupé).
  _discoveryFailed(found, mode = 'discovery') {
    const [reason, message] = DISCOVERY_ERRORS[found.kind];
    this.lastError = message(found.status);
    this.unreachable = true;
    const { kind, status, host, finalHost, keys } = found;
    if (kind === 'refused') this._setLimit(found.retryAfter, Date.now(), found.sentAt ?? Date.now());
    if (this.bases.length > 1) this.baseIdx++;
    const where = [kind, status && `HTTP ${status}`, host, finalHost && `→ ${finalHost}`,
      keys && `Settings ${keys.Settings ? 'présent' : 'absent'}, kcs_url ${keys.kcs_url ? 'présent' : 'absent'}`].filter(Boolean).join(', ');
    this._retry(reason, { detail: `${this.lastError} [${where}]`, same: `${kind}|${status}|${this.lastError}`,
      mode: kind === 'unknown-code' ? 'closed' : mode, kind: kind === 'refused' ? 'limited' : kind === 'unknown-code' ? 'closed' : null });
    // Jamais le code ni l'URL KCS : l'hôte, l'état HTTP, le budget de l'heure.
    // `nextAt` null : essais arrêtés.
    const limit = this._limitActive();
    this._record('info', 'discovery-error', { kind, status, host, finalHost, keys, message: this.lastError,
      pages: { used: this._pageBudget().used, limit: PAGE_LIMIT }, nextAt: this.retryAt == null ? null : new Date(this.retryAt).toISOString(),
      ...(limit ? { limitedUntil: new Date(limit.until).toISOString() } : {}) });
  }

  // Relance après un échec. `mode` : 'socket' (URL KCS gardée ou faux KaraFun
  // local, 3 à 30 s), 'discovery' (page après un échec de découverte,
  // budgétée), 'closed' (KaraFun fermé ou code changé : relances rapides de
  // la page, puis essais arrêtés), 'page' (page dès que le budget et la
  // limite le permettent) ou 'stop' (essais arrêtés tout de suite).
  _retry(reason = 'Connexion KaraFun perdue', { detail = this.lastError, same = detail, mode = 'socket', kind = null } = {}) {
    this._forgetSession();
    this._attempt++;
    const now = Date.now(), link = this._link;
    this._closeSocket();
    this.connected = this.ready = false;
    clearTimeout(this.retryTimer);
    // Connexion perdue après « prêt » : les essais se recomptent depuis 1.
    if (this._resetTries) { this._tries = 0; this._resetTries = false; }
    // Sans URL gardée, le prochain essai relit la page : il suit son budget.
    if (mode === 'socket' && !this._isLocal() && this._kcs?.code !== this.code) mode = 'discovery';
    // Connexion qui a tenu : une série d'AppLeftEvent repart de zéro.
    if (link.provenAt != null && now - link.provenAt >= LINK_STABLE_MS) this._appLeftChecked = false;
    // Premier « KaraFun fermé » après une autre panne (réseau coupé au
    // démarrage…), y compris l'URL gardée refusée : la série de relances
    // rapides repart de 5 s.
    if (kind === 'closed' && this._retryKind !== 'closed') this._discoveryFailures = 0;
    if (mode === 'stop') { this._stop(reason, kind); return; }
    let at;
    if (mode === 'socket') {
      if (link.provenAt != null && now - link.provenAt >= LINK_STABLE_MS) this._socketFailures = 0;
      const failures = this._socketFailures++;
      const step = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures, 4));
      at = now + (failures ? Math.min(RETRY_MAX_MS, Math.round(step * (0.85 + 0.3 * this.random()))) : step);
    } else if (mode === 'discovery' || mode === 'closed') {
      at = this._discoveryAt(now, mode === 'closed');
      if (at == null) { this._stop(reason, kind); return; }
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

  // KaraFun fermé ou code changé, relances rapides finies (depuis _retry,
  // connexion déjà coupée) : plus aucun essai automatique. « Reconnecter »
  // repart comme un démarrage : page lue tout de suite, relances rapides de
  // nouveau permises à partir de l'heure pleine suivante, essais et « prêt
  // en … » comptés depuis le clic.
  _stop(reason, kind) {
    this.retryTimer = this.retryAt = null;
    this._retryReason = reason;
    this._retryKind = kind;
    this._discoveryFailures = 0;
    this._stoppedHour = Math.floor(Date.now() / HOUR_MS);
    this._savePages();
    this._failures = 0;
    this._tries = 0;
    this._lastLoggedRetry = null;
    this._startedAt = null;
    this._setPhase('stopped');
    const pages = { used: this._pageBudget().used, limit: PAGE_LIMIT };
    this._log(`KaraFun : ${reason}. Plus d’essai automatique : clique sur « Reconnecter » une fois KaraFun ouvert. Page KaraFun : ${pages.used}/${PAGE_LIMIT} cette heure.`);
    this._record('info', 'essais-arretes', { reason, pages });
    this.emit('change');
  }

  _accept(name, data) {
    this[name] = data;
    if (name === 'status') this.statusSession = this.kcsSession;
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
    this._optionAdds.clear(); // identifiants propres à chaque connexion
    this._forgetSession();
    this.protocol = 'kcs';
    this.socket = socket;
    this._setPhase('opening');
    // KaraFun a accepté cette URL : code validé ou premières données reçues.
    const proven = () => {
      if (this._link.provenAt != null) return;
      this._link.provenAt = Date.now();
      this._discoveryFailures = 0;
      this._urlFailures = 0;
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
      // Pendant une panne qui dure (KaraFun fermé la nuit), une ligne toutes
      // les 10 relances, comme la panne elle-même.
      if (this._failures % 10 === 0) this._log(`KaraFun : connexion ouverte (essai ${this._tries}), attente de KaraFun.`);
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
        if (this._failures % 10 === 0) this._log(`KaraFun : code accepté, demande du nom ${this.username}.`);
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
        this._noteLoading(status);
        this._observeDefaults(status);
        this._confirmFromStatus(status);
        // `kcsState` garde le numéro de KaraFun : 'idle' confond l'état 1
        // (titre annoncé, pas chargé) et l'état 3 (titre chargé, prêt).
        this._accept('status', {
          ...status,
          state: ({ 1: 'idle', 2: 'loading', 3: 'idle', 4: 'playing', 5: 'paused' })[status.state] || 'idle',
          kcsState: status.state,
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
        // AppLeftEvent dès la connexion. Reconnexion par l'URL gardée ; après
        // une relecture de la page sans connexion qui tienne, essais arrêtés.
        const brief = this._link.provenAt != null && Date.now() - this._link.provenAt < LINK_STABLE_MS;
        this._appLeftStreak = brief ? this._appLeftStreak + 1 : 1;
        if (!brief) this._appLeftChecked = false;
        this.unreachable = true;
        this.lastError = 'KaraFun est fermé ou sa télécommande a été désactivée.';
        this._record('info', 'connexion-perdue', this.lastError);
        const reason = 'KaraFun fermé ou télécommande désactivée';
        if (brief && this._appLeftChecked) {
          this._appLeftStreak = 0;
          this._forgetKcs(null, 'AppLeftEvent après relecture de la page');
          this._retry(reason, { mode: 'stop', kind: 'closed' });
          return;
        }
        if (this._appLeftStreak < APP_LEFT_REDISCOVER) { this._retry(reason); return; }
        this._appLeftStreak = 0;
        this._appLeftChecked = true;
        this._forgetKcs(null, 'AppLeftEvent répétés');
        this._retry(reason, { mode: 'page' });
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
    // Échec avant que KaraFun accepte l'URL. Fermeture 4403/4401/4404/4210
    // ou autre 44xx : KaraFun refuse l'URL (KaraFun fermé, session finie,
    // code changé), elle est oubliée et la page sera relue : URL gardée, une
    // fois dès que le budget le permet (KaraFun relancé donne une URL
    // neuve) ; URL toute neuve, par les seules relances rapides, puis essais
    // arrêtés.
    // Erreur, coupure 1006 ou délai dépassé : le réseau plutôt que l'URL
    // (Wi-Fi qui saute). Elle est gardée et réessayée toutes les 3 à 30 s,
    // sans page ; après 20 échecs de suite, la page est relue une fois.
    const lost = (message, reason, code = null) => {
      if (!active()) return;
      this.unreachable = true;
      this.lastError = message;
      this._record('info', 'connexion-perdue', message);
      if (this._link.provenAt != null) { this._retry(reason); return; }
      if (urlRejected(code)) {
        this._forgetKcs(code);
        this._retry(CLOSED_REASON, { mode: kept ? 'page' : 'closed', kind: 'closed' });
        return;
      }
      if (++this._urlFailures < URL_FAIL_REDISCOVER || !this._kcs || !this._canReadPage(false)) { this._retry(reason); return; }
      this._urlFailures = 0;
      this._kcs.check = true;
      this._retry(reason, { mode: 'page' });
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
        if (name === 'status') this._confirmFromStatus(data);
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
    this._forgetSession();
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
      this._retryKind === 'closed' ? `${CLOSED_REASON} : prochain essai à ${clock(this.retryAt ?? now)}` :
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
      // Plus d'essai automatique : le bar clique « Reconnecter » à l'ouverture.
      stopped: ['error', `${CLOSED_REASON} : essais arrêtés`],
    };
    const [level, label] = labels[phase];
    return {
      phase, level, label, since: this._phaseSince, attempt: this._tries, protocol: this.protocol,
      retryAt: phase === 'retry' ? this.retryAt : null,
      nameConflict: conflict,
      // Bouton « Prendre un autre nom maintenant » : POST /api/staff/kf { action: 'new-name' }.
      canRename: !!conflict,
      // Alerte que le bar ne peut pas fermer : conflit de nom ou limite de
      // KaraFun. Essais arrêtés : KaraFun absent, rien d'autre à signaler.
      alert: phase !== 'stopped' && conflict ? `KaraFun garde encore l’ancienne connexion de ${conflict.holder} (KaraFun relancé trop vite, ou une autre File karaoké ouverte avec le même nom). La file redemande ce nom toutes les 4 s pour garder ses droits d’administrateur et en prendra un autre ${later}. Tu peux aussi prendre un autre nom maintenant, puis lui redonner les droits dans KaraFun.` :
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
  // d'ajout (chaque voix guide la sienne) ; `tracksAvailable` : pistes
  // vocales du titre quand on les connaît. Rend les réglages
  // effectivement envoyés (bornés), ou null.
  add(songId, singer, pos = 99999, settings = null, { tracksAvailable = null } = {}) {
    const payload = { songId: Number(songId), pos, singer: String(singer || '') };
    const allowed = settings && this.settingsSupport.addOptions !== 'refused' && this._settingsChannel();
    const built = allowed ? addOptions({ singer: payload.singer, settings, ranges: this.songSettingsRanges(), tracksAvailable })
      : { sent: null };
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
    } else if (!this._isLocal()) {
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
  setQueueItemOptions(queueId, { singer, mod = null, settings = null, sent = null, current = null, tracksAvailable = null } = {}) {
    if (queueId === null || queueId === undefined || queueId === '') throw new Error('Titre de la file KaraFun inconnu.');
    this._settingsAllowed('manageQueue');
    const built = queueItemOptions({ singer, mod, settings, sent, current, tracksAvailable, ranges: this.songSettingsRanges(),
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
    this._probeSetting('pitch', 'pitch', pitch);
    return pitch;
  }

  setTempo(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Tempo invalide.');
    this._settingsAllowed('manageVolumes');
    const { tempo } = clampSettings({ tempo: value }, this.songSettingsRanges());
    this._emit('tempo', tempo);
    this._probeSetting('tempo', 'tempo', tempo);
    return tempo;
  }

  // Chœurs (4) ou une voix guide (5, 6… : toutes celles que KaraFun annonce).
  setTrackVolume(type, volume) {
    if (type !== TRACK.BACKING && !guideVoicesOf([type])?.length) throw new Error('Piste vocale inconnue.');
    if (typeof volume !== 'number' || !Number.isFinite(volume)) throw new Error('Volume invalide.');
    this._settingsAllowed('manageVolumes');
    const value = Math.min(100, Math.max(0, Math.round(volume)));
    // Chœurs laissés au titre suivant : ceux envoyés, même avant la trame qui les montre.
    if (type === TRACK.BACKING) { this._backingChanged = true; this._lastBacking = value; }
    this._emit('trackVolume', { type, volume: value });
    this._probeSetting('trackVolume', type === TRACK.BACKING ? 'backing' : `voice:${type}`, value);
    return value;
  }

  // Titres vus annoncés ou se charger (états 1 à 3) par cette application,
  // trame par trame : un titre vu pour la première fois déjà en lecture (après
  // un redémarrage ou une coupure) n'en est pas un. Les derniers seulement.
  _noteLoading(status) {
    const id = status.current?.id;
    if (id == null || !(status.state >= 1 && status.state <= 3) || this._loadingSeen.has(String(id))) return;
    this._loadingSeen.add(String(id));
    if (this._loadingSeen.size > 50) this._loadingSeen.delete(this._loadingSeen.values().next().value);
  }
  seenLoading(id) { return id != null && this._loadingSeen.has(String(id)); }

  // Nouvelle soirée ou nouveau code : chœurs par défaut à relever de nouveau,
  // provisoires jusqu'à une remise par KaraFun au chargement (_observeDefaults).
  // `keepConfirmed` (nouvelle soirée) : une valeur confirmée par une telle
  // remise reste pour ce code. Les chœurs changés depuis le démarrage du pont
  // (_backingChanged : par la file, par des options de titre, en direct, ou
  // vus à une autre valeur que la valeur connue), même avant une coupure, le
  // restent : ceux qu'un KaraFun « collant » en garde au titre suivant ne sont
  // jamais relevés, seulement une remise au chargement. Sans chœurs changés,
  // la valeur est relevée de nouveau au titre suivant, comme pour un pont neuf.
  forgetDefaults({ keepConfirmed = false } = {}) {
    if (keepConfirmed && this.observedDefaults.backing != null && !this.provisionalDefaults) return;
    this.observedDefaults = {}; this.provisionalDefaults = false;
    this._carriedUnseen = true;
  }

  // Session KCS perdue (coupure, AppLeftEvent, déconnexion) ou nouvelle :
  // KaraFun relancé renumérote sa file depuis 1, un titre vu se charger ou
  // observé avant ne dit rien du titre de même numéro d'après. Les chœurs
  // par défaut relevés (observedDefaults, provisionalDefaults) et les
  // chœurs changés (_backingChanged, jamais oubliés) restent. Les chœurs
  // laissés au titre suivant, eux, ne sont plus connus (réglés en direct
  // pendant la coupure, ou par un titre vu en pleine chanson) : dès qu'un
  // titre a été vu ou des chœurs envoyés, la chaîne passe pour inconnue
  // (_carriedUnseen), comme après un titre vu pour la première fois en
  // lecture. Sans rien de vu, la chaîne reste ce qu'elle était (inconnue au
  // démarrage du pont).
  _forgetSession() {
    this.kcsSession++;
    this._loadingSeen.clear();
    if (this._observedFor != null || this._lastBacking != null) this._carriedUnseen = true;
    this._observedFor = null; this._observedBacking = null; this._lastBacking = null;
  }

  // Valeur par défaut des chœurs sur ce KaraFun (celui du bar les met à 53) :
  // relevée à la première trame d'un titre chargé (état 2 ou plus, pistes
  // reçues) sans volumes dans ses options. L'état 1 annonce le titre sans
  // l'avoir chargé : pistes vides, ou celles d'avant. Un titre vu pour la
  // première fois déjà en lecture peut porter un réglage en direct : rien
  // n'en est relevé. Un KaraFun peut garder les volumes d'un titre au
  // suivant : dès que les chœurs ont été changés (par la file, par des
  // options de titre ou pendant un titre), la valeur n'est plus relevée, pour
  // ne jamais prendre un réglage pour la valeur par défaut ; sauf, tant
  // qu'aucune n'est relevée, un titre dont KaraFun a changé les chœurs de
  // lui-même au chargement (autre valeur que celle laissée par le titre
  // d'avant). La voix guide n'est jamais relevée : coupée par défaut (0).
  // Une telle remise par KaraFun au chargement donne toujours la valeur, même
  // déjà relevée ou reprise de la sauvegarde (valeur changée dans KaraFun).
  // Après un titre vu pour la première fois déjà en lecture (ou une session
  // KCS perdue après un titre vu, voir _forgetSession, un pont neuf ou un
  // nouveau code : l'histoire de KaraFun est inconnue), ses chœurs (un
  // réglage en direct, ou la valeur par défaut) passent au titre suivant chez
  // un KaraFun « collant » comme chez un KaraFun qui remet à zéro : sans
  // valeur connue ni chœurs changés, celle du titre suivant est relevée pour
  // la soirée, mais provisoire (provisionalDefaults, sauvegardée comme telle)
  // jusqu'à une remise ; avec une valeur connue, rien n'est relevé avant une
  // remise.
  _observeDefaults(status) {
    const current = status.current;
    if (!current || current.id == null) return;
    if (!(status.state >= 2) || !Array.isArray(status.tracks) || !status.tracks.length) return;
    const backing = liveFromStatus({ tracks: status.tracks }).backing;
    if (String(current.id) === this._observedFor) {
      if (backing !== this._observedBacking) this._backingChanged = true;
      this._lastBacking = backing;
      return;
    }
    const carried = this._lastBacking;
    this._observedFor = String(current.id);
    this._observedBacking = backing;
    this._lastBacking = backing;
    const optionTracks = current.song?.options?.tracks;
    if (Array.isArray(optionTracks)) {
      if (liveFromStatus({ tracks: optionTracks }).backing != null) this._backingChanged = true;
      return;
    }
    if (status.state >= 4 && !this.seenLoading(current.id)) this._carriedUnseen = true;
    else if (backing == null) return;
    else if (carried != null && backing !== carried) {
      this.observedDefaults.backing = backing;
      this.provisionalDefaults = false;
      this._carriedUnseen = false;
    } else if (this._carriedUnseen) {
      if (this.observedDefaults.backing == null && !this._backingChanged) { this.observedDefaults.backing = backing; this.provisionalDefaults = true; }
    } else if (!this._backingChanged) this.observedDefaults.backing = backing;
    // Titre vu à d'autres chœurs que la valeur connue, sans remise par KaraFun
    // au chargement (réglés avant un redémarrage, pendant une coupure ou en
    // pleine chanson) : chœurs changés, qu'un KaraFun collant garde au suivant.
    if (backing != null && this.observedDefaults.backing != null && backing !== this.observedDefaults.backing) this._backingChanged = true;
  }

  songSettingsDefaults() { return { ...SETTINGS_DEFAULTS, ...this.observedDefaults }; }

  // Chœurs par défaut relevés avant un redémarrage (sauvegarde de la soirée,
  // même code KaraFun) : repris tels quels, jamais réappris de chœurs qu'un
  // KaraFun « collant » aurait gardés. Une valeur reprise ne tient pas les
  // chœurs pour changés (forgetDefaults). Une valeur sauvegardée provisoire (un
  // KaraFun collant ne remet jamais ses chœurs au chargement) reste
  // provisoire : reprise seulement sans valeur confirmée, jamais remplacée
  // par une valeur provisoire relevée ensuite, remplacée par une remise de
  // KaraFun au chargement (_observeDefaults). false : valeur abîmée, ou
  // provisoire face à une valeur confirmée, rien repris.
  restoreDefaults(saved) {
    const backing = saved?.backing;
    if (!Number.isInteger(backing) || backing < 0 || backing > 100) return false;
    const confirmed = this.observedDefaults.backing != null && !this.provisionalDefaults;
    if (saved.provisional === true && confirmed) return false;
    if (!confirmed) this.observedDefaults.backing = backing;
    this.provisionalDefaults = saved.provisional === true;
    return true;
  }

  // Réglages de titre possibles avec cette connexion : true, false (ancienne
  // télécommande d'un vrai KaraFun) ou null (pas encore connecté).
  songSettingsAvailable() { return this.protocol ? this._settingsChannel() : null; }

  // Pour les pages : plages, droits de KaraFun (null : non précisés),
  // fonctions confirmées, refusées ou sans réponse, un avis par fonction (et
  // le dernier), capacité du canal et état en direct.
  songSettingsState() {
    const flag = key => typeof this.permissions?.[key] === 'boolean' ? this.permissions[key] : null;
    return { ranges: this.songSettingsRanges(), defaults: this.songSettingsDefaults(),
      permissions: { manageVolumes: flag('manageVolumes'), manageQueue: flag('manageQueue') },
      support: { ...this.settingsSupport }, notices: { ...this.settingsNotices },
      notice: Object.values(this.settingsNotices).at(-1) || null, available: this.songSettingsAvailable(),
      live: liveFromStatus(this.status) };
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
