'use strict';
/*
 * File karaoké équitable — serveur local à lancer sur le PC qui fait tourner KaraFun.
 *
 *   node server.js --code 123456        (KaraFun réel, code de la télécommande)
 *   node server.js --demo               (faux KaraFun intégré, pour essayer)
 *   KARAOKE_MODE=server node server.js  (mode serveur : Linux derrière un relais HTTPS)
 *   KARAOKE_MODE=server node server.js --print-staff-url   (lien du bar, puis sortie)
 *   KARAOKE_MODE=server node server.js --rotate-staff-key  (nouvelle clé, appliquée au redémarrage)
 *
 * Les clients scannent le QR de leur table et voient tout sur leur téléphone.
 * Le programme décide de l'ordre et n'envoie à KaraFun que la chanson suivante.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { createServerUpdate } = require('./server-update');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
const QRCode = require('qrcode');

// Version affichée au bar : celle du kit publié (build-info.json écrit par
// PREPARER-KIT-BAR.ps1), sinon package.json et le commit git local.
function readBuildInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (typeof info.version === 'string' && info.version) {
      return { version: info.version.slice(0, 40), commit: String(info.commit || '').slice(0, 7) || null,
        builtAt: Number.isFinite(Date.parse(info.builtAt)) ? info.builtAt : null };
    }
  } catch (_) { /* pas de kit publié : version de développement */ }
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 7) || null;
  } catch (_) { /* pas de dépôt git */ }
  let version = 'version inconnue';
  try { version = `v${JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version}`; }
  catch (_) { /* copie partielle : la version ne doit jamais empêcher le démarrage */ }
  return { version, commit, builtAt: null };
}
const BUILD = readBuildInfo();
// Identifie ce démarrage : une alerte fermée au bar revient après un redémarrage.
const BOOT_ID = crypto.randomBytes(6).toString('hex');
const { Scheduler, DEFER_MAX, SONG_GAP_MIN_SAMPLES, DEFAULTS: SCHED_DEFAULTS } = require('./scheduler');
const { KaraFunBridge, BATTLE_MOD, isBattleItem, maskCode, unknownSettingsSupport } = require('./karafun');
const { analyzeState } = require('./karafun-state');
const { TableAccess } = require('./table-access');
const { SoloInvitations } = require('./solo-invitations');
const { PrivateEvent, clientKey } = require('./private-event');
const { Catalog } = require('./catalog');
const { BattleVote, VOTE_DURATION_MS, COOLDOWN_MS, REJECTED_COOLDOWN_MS, MIN_VOTERS } = require('./battle-vote');
const { NightStateStore, snapshotNight, restoreNight } = require('./night-state');
const { DEFAULT_REPEAT_MIN, songNotice, queueRepeats } = require('./song-repeats');
const { Lyrics } = require('./lyrics');
const { SpotifyLink, SpotifyAutomation, OPTION_DEFAULTS: SPOTIFY_DEFAULTS } = require('./spotify');
const { EveningJournal, validEveningId } = require('./evening-journal');
const { computeStats, insights, exportEvening } = require('./evening-stats');
const { DEFAULTS: SONG_DEFAULTS, TRACK, rangesFrom, normalizeSettings, validateField, songTracksOf, guideVoicesOf, liveFromStatus,
  settingsFromLive, neutralTarget, catchUpCommands } = require('./song-settings');
const stageProgress = require('./stage-progress');

// ------------------------------------------------------------------ paramètres
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def; };
const PORT = parseInt(arg('port', process.env.PORT || 3000), 10);
// Le tunnel ou le relais HTTPS des clients pointe ici, jamais vers le port du
// bar ; en mode serveur, seul le relais de KARAOKE_STAFF_URL vise PORT.
const PUBLIC_PORT = parseInt(arg('public-port', process.env.PUBLIC_PORT || PORT + 1), 10);
const DEMO = !!arg('demo', false);
const NO_OPEN = !!arg('no-open', false);

// ------------------------------------------------------------------ mode serveur
// Serveur Linux derrière un relais HTTPS (--server ou KARAOKE_MODE=server) :
// configuration et clé du bar vérifiées avant tout effet de bord (journal/,
// data/), adresses HTTPS des QR fixées par l'environnement, aucun droit pour
// la boucle locale (le relais y arrive aussi). Sans lui : mode PC inchangé, mais
// une variable du mode serveur fixée sans lui refuse le démarrage (pcSetup).
const SERVER_MODE = !!arg('server', false) || String(process.env.KARAOKE_MODE || '').trim() === 'server';
const DEFAULT_TRUSTED_PROXIES = '127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7';
const STAFF_KEY_FORMAT = /^[A-Za-z0-9_-]{22,}$/;

// Configuration du mode serveur lue dans `env`, sans lecture de fichier.
// Une variable vide ou faite d'espaces est absente. Lève la raison du premier
// contrôle en échec, dans l'ordre des contrôles.
function readServerConfig(env) {
  const value = name => String(env[name] ?? '').trim() || null;
  const quoted = text => text.slice(0, 80);
  const mode = value('KARAOKE_MODE');
  if (mode !== null && mode !== 'server') {
    throw new Error(`KARAOKE_MODE vaut « ${quoted(mode)} » : seule la valeur server est reconnue (retire la variable pour le mode PC).`);
  }
  const origin = (name, purpose, example) => {
    const text = value(name);
    if (text === null) throw new Error(`${name} manque : indique l’adresse HTTPS ${purpose}, par exemple ${example}.`);
    let url;
    try { url = normalizeBaseUrl(text); } catch (error) { throw new Error(`${name} invalide : ${error.message}`); }
    if (!url.startsWith('https://')) throw new Error(`${name} doit commencer par https://.`);
    return url;
  };
  const publicUrl = origin('KARAOKE_PUBLIC_URL', 'des QR clients', 'https://chant.exemple.fr');
  const staffUrl = origin('KARAOKE_STAFF_URL', 'de la page du bar', 'https://bar.exemple.fr');
  if (publicUrl === staffUrl) {
    throw new Error('KARAOKE_STAFF_URL doit différer de KARAOKE_PUBLIC_URL : la page du bar n’est jamais servie par l’adresse des clients.');
  }
  const address = name => {
    const text = value(name);
    if (text === null) return '127.0.0.1';
    if (!net.isIP(text)) throw new Error(`${name} invalide (« ${quoted(text)} ») : indique une adresse IP, par exemple 127.0.0.1 ou 0.0.0.0.`);
    return text;
  };
  const bind = address('KARAOKE_BIND');
  const publicBind = address('KARAOKE_PUBLIC_BIND');
  const header = value('KARAOKE_CLIENT_IP_HEADER');
  if (header !== null && !/^[A-Za-z0-9-]{1,64}$/.test(header)) {
    throw new Error(`KARAOKE_CLIENT_IP_HEADER invalide (« ${quoted(header)} ») : indique un nom d’en-tête HTTP, par exemple x-real-ip.`);
  }
  const proxies = value('KARAOKE_TRUSTED_PROXIES') || DEFAULT_TRUSTED_PROXIES;
  const proxiesError = text => new Error(`KARAOKE_TRUSTED_PROXIES invalide (« ${quoted(text)} ») : indique des blocs CIDR séparés par des virgules, par exemple 172.16.0.0/12.`);
  const trustedProxies = new net.BlockList();
  const kept = proxies.split(',').map(entry => entry.trim()).filter(Boolean);
  if (!kept.length) throw proxiesError(proxies);
  for (const entry of kept) {
    const slash = entry.lastIndexOf('/');
    const ip = slash > 0 ? entry.slice(0, slash) : '';
    const prefix = entry.slice(slash + 1);
    const family = net.isIP(ip);
    if (!family || !/^\d{1,3}$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) throw proxiesError(entry);
    trustedProxies.addSubnet(ip, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
  }
  const keyFile = value('KARAOKE_STAFF_KEY_FILE');
  return { bind, publicBind, publicUrl, staffUrl, staffKeyFile: keyFile === null ? null : path.resolve(keyFile),
    clientIpHeader: header === null ? null : header.toLowerCase(), trustedProxies, trustedProxiesText: kept.join(',') };
}

// Clé du bar du mode serveur : celle de KARAOKE_STAFF_KEY_FILE, sinon
// <dataDir>/staff-key, créée une seule fois (0600) puis réutilisée. Le
// contenu d'un fichier de clé n'est jamais cité dans une raison de refus.
function loadStaffKey(config, dataDir) {
  const reason = error => error.code || error.message;
  const keyOf = text => String(text).replace(/^\uFEFF/, '').trim();
  if (config.staffKeyFile) {
    let text;
    try { text = fs.readFileSync(config.staffKeyFile, 'utf8'); }
    catch (error) { throw new Error(`KARAOKE_STAFF_KEY_FILE illisible (${config.staffKeyFile} : ${reason(error)}).`); }
    const key = keyOf(text);
    if (!STAFF_KEY_FORMAT.test(key)) {
      throw new Error('La clé de KARAOKE_STAFF_KEY_FILE doit compter au moins 22 caractères parmi A-Z, a-z, 0-9, - et _.');
    }
    return { key, source: 'KARAOKE_STAFF_KEY_FILE' };
  }
  const file = path.join(dataDir, 'staff-key');
  const read = missingAllowed => {
    try { return fs.readFileSync(file, 'utf8'); } catch (error) {
      if (missingAllowed && error.code === 'ENOENT') return null;
      throw new Error(`data/staff-key illisible (${reason(error)}).`);
    }
  };
  let text = read(true);
  if (text === null) {
    const key = crypto.randomBytes(16).toString('base64url');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, key + '\n', { mode: 0o600, flag: 'wx' });
      return { key, source: 'data/staff-key, créée à ce démarrage' };
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error(`data/staff-key impossible à créer (${reason(error)}).`);
    }
    // Deux démarrages simultanés : la clé écrite par l'autre est gardée.
    text = read(false);
  }
  const key = keyOf(text);
  if (!STAFF_KEY_FORMAT.test(key)) {
    throw new Error('data/staff-key ne contient pas une clé valable (au moins 22 caractères parmi A-Z, a-z, 0-9, - et _) : remplace-la avec node server.js --rotate-staff-key.');
  }
  return { key, source: 'data/staff-key' };
}

// Seule l'empreinte de la clé du bar est écrite au journal.
function staffKeyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

// Nouvelle clé du bar dans <dataDir>/staff-key (0600), écrite à côté puis
// renommée : un lecteur voit l'ancienne clé ou la nouvelle, jamais un morceau.
// L'ancienne clé n'est pas lue (elle peut être abîmée). Lève la raison.
function rotateStaffKey(dataDir) {
  const key = crypto.randomBytes(16).toString('base64url');
  // Dans un conteneur, le numéro de processus se répète d'un lancement à l'autre.
  const temporary = path.join(dataDir, `staff-key.${process.pid}.tmp`);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.writeFileSync(temporary, key + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, path.join(dataDir, 'staff-key'));
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) { /* rien à retirer */ }
    throw new Error(`data/staff-key impossible à écrire (${error.code || error.message}).`);
  }
  return key;
}

// Commandes ponctuelles du mode serveur : null sans --print-staff-url ni
// --rotate-staff-key, sinon { code, stdout, stderr } à écrire avant de sortir.
// Ne sort jamais du processus et n'écrit rien au journal.
function staffKeyCommand(argv, env, dataDir) {
  const print = argv.includes('--print-staff-url');
  const rotate = argv.includes('--rotate-staff-key');
  if (!print && !rotate) return null;
  const refuse = reason => ({ code: 1, stdout: '', stderr: `Commande impossible : ${reason}\n` });
  const done = text => ({ code: 0, stdout: `${text}\n`, stderr: '' });
  if (print && rotate) return refuse('choisis --print-staff-url ou --rotate-staff-key, pas les deux.');
  const mode = String(env.KARAOKE_MODE ?? '').trim();
  let config;
  try {
    // Valeur inconnue, même avec --server : refusée d'abord par readServerConfig (son premier contrôle).
    if (mode && mode !== 'server') readServerConfig(env);
    if (!argv.includes('--server') && mode !== 'server') {
      return refuse('--print-staff-url et --rotate-staff-key ne servent qu’en mode serveur (--server ou KARAOKE_MODE=server).');
    }
    config = readServerConfig(env);
  } catch (error) { return refuse(error.message); }
  if (print) {
    let keyInfo;
    try { keyInfo = loadStaffKey(config, dataDir); } catch (error) { return refuse(error.message); }
    return done(`${config.staffUrl}/staff?key=${keyInfo.key}`);
  }
  if (config.staffKeyFile) {
    return refuse('la clé du bar vient de KARAOKE_STAFF_KEY_FILE ; change ce fichier, puis redémarre la file.');
  }
  let key;
  try { key = rotateStaffKey(dataDir); } catch (error) { return refuse(error.message); }
  return done(`Nouvelle clé du bar écrite dans data/staff-key (empreinte ${staffKeyFingerprint(key)}). ` +
    'Redémarre la file pour l’appliquer, puis donne aux gérants le lien de --print-staff-url : l’ancien lien ne marche plus.');
}

function serverSetup(env, dataDir) {
  try {
    const config = readServerConfig(env);
    return { config, keyInfo: loadStaffKey(config, dataDir) };
  } catch (error) { return { error }; }
}
// Variables propres au mode serveur, dans l'ordre des contrôles de readServerConfig.
const SERVER_VARIABLES = ['KARAOKE_PUBLIC_URL', 'KARAOKE_STAFF_URL', 'KARAOKE_BIND', 'KARAOKE_PUBLIC_BIND',
  'KARAOKE_CLIENT_IP_HEADER', 'KARAOKE_TRUSTED_PROXIES', 'KARAOKE_STAFF_KEY_FILE', 'KARAOKE_UPDATE_DIR'];
// Mode PC : une variable du mode serveur fixée sans lui (KARAOKE_MODE oubliée
// ou mal écrite, --server=1) refuse le démarrage. Sinon le serveur partirait
// en silence en mode PC : clé du bar au journal, droits de la boucle locale.
function pcSetup(env) {
  const stray = SERVER_VARIABLES.find(name => String(env[name] ?? '').trim());
  if (!stray) return { config: null, keyInfo: null };
  return { error: new Error(`${stray} est fixée sans le mode serveur : ajoute KARAOKE_MODE=server (ou --server), ou retire les variables KARAOKE_* pour le mode PC.`) };
}
// Commande ponctuelle : réponse puis sortie, avant journal/ et sans port ouvert
// (écritures synchrones, aussi vers un tube sous Windows).
const command = staffKeyCommand(argv, process.env, path.join(__dirname, 'data'));
if (command) {
  if (command.stdout) fs.writeSync(1, command.stdout);
  if (command.stderr) fs.writeSync(2, command.stderr);
  process.exit(command.code);
}
// Une valeur inconnue de KARAOKE_MODE refuse le démarrage dans les deux modes.
const SETUP = (String(process.env.KARAOKE_MODE || '').trim() || SERVER_MODE) ?
  serverSetup(process.env, path.join(__dirname, 'data')) : pcSetup(process.env);
if (SETUP.error) {
  fs.writeSync(2, `Impossible de démarrer : ${SETUP.error.message}\n`);
  process.exit(1);
}
const SERVER = SETUP.config;
const serverUpdate = createServerUpdate({ directory: SERVER ? process.env.KARAOKE_UPDATE_DIR : null, version: BUILD.version });
const STAFF_KEY_INFO = SETUP.keyInfo;
// Mode serveur : en-têtes de sécurité de toutes les réponses (send), jamais
// écrasés par un appel. Aucune page du bar n'en encadre une autre : DENY.
const SERVER_HEADERS = Object.freeze(SERVER ? { 'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': 'frame-ancestors \'none\'' } : {});

const CODE_FILE = path.join(__dirname, 'data', 'last-karafun-code.json');
function rememberedCode() {
  try { return String(JSON.parse(fs.readFileSync(CODE_FILE, 'utf8')).code || '').replace(/\D/g, ''); }
  catch { return ''; }
}
let CODE = String(arg('code', '') || rememberedCode()).replace(/\D/g, '');
const LOG_DIR = path.join(__dirname, 'journal');
fs.mkdirSync(LOG_DIR, { recursive: true });
// Mode serveur : clé persistante (lien du bar stable). Mode PC : tirée à chaque démarrage.
const STAFF_KEY = SERVER ? STAFF_KEY_INFO.key : crypto.randomBytes(16).toString('base64url');
const TABLE_FILE = path.join(__dirname, 'data', 'tables.json');
const BATTLE_FILE = path.join(__dirname, 'data', 'battle-vote.json');
const PHOTO_DIR = path.join(__dirname, 'data', 'photos');
const nightStore = DEMO ? null : new NightStateStore(path.join(__dirname, 'data', 'soiree'));
const RUNTIME_FILE = path.join(__dirname, 'data', `runtime-${PORT}.json`);
const STOP_KEY = crypto.randomBytes(24).toString('base64url');
let shuttingDown = false;
let activeMutations = 0; // requêtes déjà commencées, y compris leurs attentes réseau
const personShareCodes = new Map();
const SOLO_COOKIE = 'karaoke_solo_device';
// Les titres proposés pour une Battle doivent avoir été reçus du catalogue
// KaraFun par ce serveur, et non inventés dans une requête cliente. Il en va
// de même des vignettes : seule une image https reçue du catalogue est
// montrée aux téléphones, jamais une adresse envoyée par l'un d'eux.
const battleCatalogSongs = new Map();
const catalogCovers = new Map(); // songId → adresse https de la vignette
// Durées données par le catalogue ou la recherche de KaraFun (barre de lecture).
const catalogDurations = new Map(); // songId → secondes
function coverUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 500) return null;
  let url;
  try { url = new URL(value.startsWith('//') ? `https:${value}` : value); } catch (_) { return null; }
  return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
}
function rememberBattleSongs(songs) {
  for (const song of songs || []) {
    const songId = Number(song?.songId);
    const title = String(song?.title || '').trim();
    const artist = String(song?.artist || '').trim();
    if (song && typeof song === 'object') song.img = coverUrl(song.img);
    if (!Number.isSafeInteger(songId) || songId <= 0 || !title || title.length > 100 || artist.length > 80) continue;
    battleCatalogSongs.delete(songId);
    battleCatalogSongs.set(songId, { songId, title, artist });
    if (battleCatalogSongs.size > 10000) battleCatalogSongs.delete(battleCatalogSongs.keys().next().value);
    // Une liste sans image ou sans durée (catalog.js rend null) garde celle
    // déjà connue ; une nouvelle valeur fiable la remplace.
    if (song.img) { catalogCovers.delete(songId); catalogCovers.set(songId, song.img); }
    if (catalogCovers.size > 10000) catalogCovers.delete(catalogCovers.keys().next().value);
    const duration = stageProgress.trustedDuration(song.duration);
    if (duration) { catalogDurations.delete(songId); catalogDurations.set(songId, duration); }
    if (catalogDurations.size > 10000) catalogDurations.delete(catalogDurations.keys().next().value);
  }
  return songs;
}
// Titre choisi par un téléphone : sa vignette vient du catalogue ; sa durée,
// non vérifiée, n'est gardée que bornée comme pour la barre de lecture.
const withCover = song => song && typeof song === 'object' ?
  { ...song, img: catalogCovers.get(Number(song.songId)) || null, duration: stageProgress.clientDuration(Number(song.duration)) } : song;
function certifiedBattleSongs(songs) {
  if (!Array.isArray(songs) || songs.length < 1 || songs.length > 3) {
    throw new Error('Propose entre un et trois titres du catalogue pour la Battle.');
  }
  return songs.map(song => {
    const seen = battleCatalogSongs.get(Number(song?.songId));
    if (!seen) throw new Error('Retrouve ce titre dans le catalogue avant de proposer la Battle.');
    return { ...seen };
  });
}

const sched = new Scheduler({ solverEnabled: !DEMO || argv.includes('--solver') });
sched.solverPaused = () => serverUpdate.isBusy();
// Journal de soirée (data/soirees/<id>/), en mémoire en démo. Écriture au
// mieux : un disque plein est signalé mais n'arrête jamais la file.
const journal = new EveningJournal({ dir: DEMO ? null : path.join(__dirname, 'data', 'soirees'), fs, app: BUILD, boot: BOOT_ID,
  onError: error => appLog(`Journal de soirée indisponible : ${error.message}. La file continue.`) });
// Prénoms et noms de tables : seulement dans meta.json, jamais dans les lignes.
function journalNames(fields = {}) {
  const ids = [fields.personId, ...(Array.isArray(fields.ids) ? fields.ids : []), ...(Array.isArray(fields.personIds) ? fields.personIds : [])];
  for (const pid of ids) {
    const person = typeof pid === 'string' && sched.people.get(pid);
    if (person) journal.person(person.id, { name: person.name, tableId: person.tableId });
  }
  const table = fields.tableId != null && sched.table(fields.tableId, false);
  if (table) journal.table(table.id, { name: table.name, individual: table.individual });
}
// Prénom provisoire (QR ouvert sans prénom) : pas au journal ; le premier vrai
// prénom l'y inscrit (person.joined), même après un redémarrage.
function journalRoster() {
  for (const t of sched.tables.values()) journal.table(t.id, { name: t.name, individual: t.individual });
  for (const person of sched.people.values()) {
    if (!person.nameRequired) journal.person(person.id, { name: person.name, tableId: person.tableId });
  }
}
function journalEvent(type, fields = {}) {
  // QR ouvert sans prénom (peut-être abandonné) : rien au journal tant que la
  // personne ne s'est pas vraiment inscrite. Les statistiques l'ignorent.
  if (typeof fields?.personId === 'string' && sched.people.get(fields.personId)?.nameRequired) return null;
  try { journalNames(fields); } catch (_) { /* noms au mieux */ }
  return journal.append(type, fields);
}
sched.onEvent = journalEvent;
// « Duos uniquement » : un duo ouvert sans partenaire ne part pas (lib/scheduler/duets.js, _openHeld).
sched.duoOnlyRule = () => !!settings.duoOnly;
// Règles en vigueur, notées au début de chaque soirée.
function journalRules() {
  return { tableRotation: !!sched.opts.tableRotation, weightedTables: !!sched.opts.weightedTables,
    interleaveArrivals: sched.opts.interleaveArrivals !== false, requirePresence: !!sched.opts.requirePresence,
    roundAppearanceCap: sched.opts.roundAppearanceCap, spacingSongs: sched.opts.spacingSongs,
    auto: !!settings.auto, autoPlay: !!settings.autoPlay, pushDelaySec: settings.pushDelaySec,
    presenceGraceSec: settings.presenceGraceSec, presenceMaxSkips: settings.presenceMaxSkips, duoOnly: !!settings.duoOnly };
}
const lyrics = new Lyrics();
// Paroles : au plus LYRICS_PER_MINUTE demandes par table (ou pour le bar).
const LYRICS_PER_MINUTE = 20;
const lyricsHits = new Map();
function lyricsAllowed(who, now = Date.now()) {
  const recent = (lyricsHits.get(who) || []).filter(at => now - at < 60000);
  const allowed = recent.length < LYRICS_PER_MINUTE;
  if (allowed) recent.push(now);
  if (recent.length) lyricsHits.set(who, recent); else lyricsHits.delete(who);
  return allowed;
}
// Spotify : réglages et jeton gardés dans data/ (en démo, en mémoire seulement).
const spotify = new SpotifyLink({ file: DEMO ? null : path.join(__dirname, 'data', 'spotify.json'),
  log: message => appLog(message) });
const spotifyAutomation = new SpotifyAutomation();
const access = new TableAccess();
const soloInvitations = new SoloInvitations();
// Événement privé (bar privatisé) : un seul QR qui inscrit chaque navigateur.
const privateEvent = new PrivateEvent();
const battleVote = new BattleVote({
  saved: !DEMO && fs.existsSync(BATTLE_FILE) ? JSON.parse(fs.readFileSync(BATTLE_FILE, 'utf8')) : null,
  onChange(event) {
    journalBattle(event);
    if (!DEMO) {
      fs.mkdirSync(path.dirname(BATTLE_FILE), { recursive: true });
      const temporary = `${BATTLE_FILE}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(battleVote.serialize()));
      fs.renameSync(temporary, BATTLE_FILE);
    }
    if (event === 'requested') {
      const title = battleVote.ballot?.selectedSong?.title;
      sched.note(`La salle demande une Battle collective${title ? ` sur « ${title} »` : ''} : elle sera ajoutée après le prochain passage annoncé.`, 'battle');
    }
    else if (event === 'staff-launch') {
      const title = battleVote.ballot?.selectedSong?.title;
      sched.note(`Le bar lance une Battle${title ? ` sur « ${title} »` : ''} : elle sera ajoutée après le prochain passage annoncé.`, 'battle');
    }
    else if (event === 'proposed') {
      const minutes = battleVote.voteDurationMs / 60000;
      sched.note(`Un vote pour une Battle collective est ouvert pendant ${minutes} minute${minutes > 1 ? 's' : ''}.`, 'battle');
    }
    else if (event === 'quorum') sched.note('Vote Battle terminé : pas assez de votants. Prochain vote après la pause.', 'battle');
    else if (event === 'expired' || event === 'rejected') sched.note('Vote Battle terminé sans majorité pour la Battle. Prochain vote après la pause.', 'battle');
    else if (event === 'done' || event === 'dismissed') sched.note('Demande Battle traitée par le bar. Pause entre les votes.', 'battle');
    else if (event === 'automation-failed') {
      const failure = battleVote.automation?.failure;
      sched.note(`Battle à préparer par le bar${failure ? ` : ${failure}` : '.'}`, 'battle');
    }
    if (!DEMO) setImmediate(() => saveNight());
  },
});
// Votes Battle dans le journal : chaque proposition une fois, chaque votant
// une fois, chaque décision une fois.
const journaledBallots = new Map(); // ballotId → votants déjà notés
// Votants déjà notés pour ce scrutin. Après un redémarrage, le scrutin est
// rechargé depuis data/battle-vote.json et la soirée reprise contient déjà
// sa proposition et ses votes : ils sont relus dans son journal, jamais
// réécrits.
function journaledVoters(b) {
  if (journaledBallots.has(b.id)) return journaledBallots.get(b.id);
  const known = (journal.id ? journal.read(journal.id)?.events || [] : []).filter(e => e.ballotId === b.id);
  const voters = new Set(known.filter(e => e.ev === 'battle.vote').map(e => e.voterId));
  journaledBallots.set(b.id, voters);
  if (journaledBallots.size > 50) journaledBallots.delete(journaledBallots.keys().next().value);
  if (!known.some(e => e.ev === 'battle.proposed')) {
    journalEvent('battle.proposed', { ballotId: b.id, proposerId: b.proposerId || null,
      songs: (b.songs || [b.suggestedSong]).filter(Boolean).map(song => ({ songId: song.songId, title: song.title })),
      eligible: b.eligiblePersonIds.length, threshold: b.threshold, closesAt: b.closesAt });
  }
  return voters;
}
function journalBattle(event) {
  const b = battleVote.ballot;
  if (b && !['staff', 'external'].includes(b.mode)) {
    const voters = journaledVoters(b);
    for (const [voterId, choice] of Array.isArray(b.votes) ? b.votes : []) {
      if (voters.has(voterId)) continue;
      voters.add(voterId);
      journalEvent('battle.vote', { ballotId: b.id, voterId, choice });
    }
  }
  if (['requested', 'quorum', 'expired', 'rejected'].includes(event) && b) {
    const votes = b.votes || [];
    journalEvent('battle.decided', { ballotId: b.id, outcome: event === 'requested' ? 'approved' : event, closedBy: b.closedBy || null,
      voters: votes.length, yes: votes.filter(([, answer]) => answer === 'yes' || String(answer).startsWith('song:')).length,
      eligible: b.eligiblePersonIds.length, songId: b.selectedSong?.songId || null });
  } else if (event === 'staff-launch' && b) {
    journalEvent('battle.staffLaunch', { ballotId: b.id, songId: b.selectedSong?.songId || null, title: b.selectedSong?.title || '' });
  } else if (event === 'external' && b) journalEvent('battle.external', { ballotId: b.id, songId: battleVote.automation?.songId || null });
  else if (event === 'done' || event === 'dismissed') journalEvent('battle.resolved', { ballotId: b?.id || null, outcome: event });
  else if (event === 'cooldown-reset') journalEvent('battle.cooldownLifted', {});
  else if (/^automation-(sending|mode|queued|playing|after|resuming|released|failed|manual)$/.test(event)) {
    // Mode demandé à KaraFun (envoi, puis passage d'une copie normale en
    // Battle) : une Battle confirmée ensuite se distingue de celle faite par
    // le bar dans KaraFun.
    const status = event.slice(11), automation = battleVote.automation;
    journalEvent('battle.automation', { ballotId: automation?.ballotId || null, status,
      songId: automation?.songId || null,
      ...(status === 'sending' && automation?.sentMod ? { mod: automation.sentMod } : {}),
      ...(status === 'mode' ? { queueId: automation?.modeTarget || null, mod: { id: automation?.modeId ?? null, caption: automation?.modeCaption || '' } } : {}),
      ...(status === 'failed' ? { failure: automation?.failure || null } : {}) });
  }
}
if (DEMO) {
  sched.opts.defaultSlotSec = parseInt(arg('song-seconds', 45), 10) + 1;
  // Le faux KaraFun enchaîne ses titres sans écart.
  sched.opts.defaultSongGapSec = 0;
}
let bridge = null;
let fake = null;
const SONG_SECONDS = parseInt(arg('song-seconds', 45), 10);
// Réglages du bar à leur valeur d'origine. « Options par défaut » (Plus ›
// Fin de soirée) y revient, avec les règles de la file, de la Battle et de
// Spotify, sans toucher au code de la télécommande, à la connexion Spotify,
// à l'adresse des QR, à l'événement privé, aux tables ni à la file.
const DEFAULT_SETTINGS = Object.freeze({ auto: true, autoPlay: false,
  // La chanson suivante est choisie le plus tard possible (pour tenir compte des derniers arrivés),
  // mais assez tôt pour que KaraFun la charge : `pushDelaySec` après le début de la chanson en cours.
  pushDelaySec: DEMO ? Math.max(1, Math.round(SONG_SECONDS / 3)) : 45, playDelaySec: 8,
  // Alerte « titre déjà chanté » : fenêtre en minutes, 0 pour la couper.
  repeatWarnMin: DEFAULT_REPEAT_MIN,
  // « Je suis là » : délai une fois la scène libre, puis nombre de passages
  // manqués avant de retirer le titre et de prévenir le bar.
  presenceGraceSec: 30, presenceMaxSkips: 3,
  // Durée maximale d'un titre ajouté par un client, en secondes (null : pas
  // de limite, réglage par défaut). Voir maxSongLimit et assertSongLength.
  maxSongSec: null,
  // Réglages de titre (tonalité, tempo, voix) depuis les téléphones des
  // chanteurs : le bar peut les couper, comme « Personnaliser la chanson en
  // cours » dans KaraFun. Gardé d'une soirée à l'autre.
  singerSongSettings: true,
  // Duos uniquement : les clients n'ajoutent que des duos (soirée chargée,
  // plus de monde sur scène par heure). Les titres déjà choisis restent.
  duoOnly: false });
const settings = { ...DEFAULT_SETTINGS, baseUrl: SERVER ? SERVER.publicUrl : null,
  // Heure de fermeture du bar (horodatage), annoncée aux clients. L'ajout de
  // titres reste toujours possible ; à l'heure, plus d'envoi ni de
  // lancement, titres chargés retirés, Spotify relancé (closingBlocksStart).
  closingAt: null,
  // Spotify a repris en fin de file : la lecture automatique attend que le
  // bar lance lui-même le titre suivant (« Lecture »), puis se rétablit.
  autoPlayHeld: false,
  queueClearPending: false };
const queueClearRemovalRequests = new Map();
let curKey = null, curSince = 0;
// Barre de lecture : horloge du titre sur scène (stage-progress.js), gardée
// dans la sauvegarde pour qu'un redémarrage ne remette pas le titre à zéro.
let stageClock = null;
let presenceWait = null; // { key, askedAt, freeSince } : demande « Je suis là » en cours
let pending = null;     // chanson envoyée à KaraFun, en attente de confirmation
let restartOp = null;   // « Relancer depuis le début » en cours (copie du titre puis Suivant)
let tracked = [];       // nos chansons présentes dans KaraFun
let idleSince = null;
let idleQueueId = null;
let emptySince = null;  // transition après Suivant : KaraFun peut ignorer un ajout immédiat
let hadNativeQueue = false;
let recoveredPending = false;
let persistenceError = null;
// Envoi coupé par KaraFun (droits perdus, souvent après une reconnexion) :
// il reprend seul dès que les droits reviennent, sauf décision du bar.
let permissionPause = false;
let curQueueId = null;      // titre en cours noté dans le journal (stage.started)
let curBattle = false;      // la scène en cours est une Battle
let songGap = null;         // { since, clean } : écart entre deux titres en cours de mesure (measureSongGap)
let phaseKey = null;        // dernier état karaoke.phase noté
let presenceAskKey = null;  // dernière demande « Je suis là » notée
let lastSampleAt = 0;       // dernier relevé queue.sample
const seenJournal = new Map(); // personne → dernier person.seen noté

function saveNight({ required = false, replaceBoth = false } = {}) {
  if (!nightStore) return true;
  try {
    const snapshot = snapshotNight({ scheduler: sched, access, settings, pending, tracked,
      soloInvitations, privateEvent, transfers: transferSnapshot(), stageClock,
      photoDir: PHOTO_DIR, evening: journal.snapshot() });
    nightStore.save(snapshot);
    if (replaceBoth) nightStore.save(snapshot, { force: true });
    persistenceError = null;
    return true;
  } catch (error) {
    persistenceError = error.message;
    settings.auto = false;
    appLog(`ERREUR sauvegarde de soirée : ${error.message}. Envoi automatique suspendu.`);
    if (required) throw error;
    return false;
  }
}

function rememberCode() {
  if (DEMO || !CODE) return;
  fs.mkdirSync(path.dirname(CODE_FILE), { recursive: true });
  const temporary = `${CODE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ code: CODE }));
  fs.renameSync(temporary, CODE_FILE);
}

function appLog(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(msg);
  try { fs.appendFileSync(path.join(LOG_DIR, `serveur-${line.slice(0, 10)}.log`), line + '\n'); } catch (e) { /* */ }
}

// Arrêt propre : ARRETER.bat (`'stop'`) ou signal du système (`'SIGTERM'`,
// `'SIGINT'`, `'SIGHUP'`, deux modes). Un second appel ne fait rien.
function stopHelper(reason = 'stop') {
  if (shuttingDown) return;
  shuttingDown = true;
  journalEvent('app.stopped', { reason });
  saveNight();
  appLog(reason === 'stop' ? 'Arrêt de la file karaoké demandé par le bar.' : `Arrêt de la file karaoké (signal ${reason}).`);
  sched.closeSolver();
  try { bridge?.disconnect(); bridge?.releaseIdentity(); } catch (_) { /* arrêt en cours */ }
  try { fake?.close(); } catch (_) { /* arrêt en cours */ }
  try {
    const runtime = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    if (runtime.pid === process.pid && runtime.secret === STOP_KEY) fs.unlinkSync(RUNTIME_FILE);
  } catch (_) { /* fichier déjà absent */ }
  server.close();
  publicServer.close();
  setTimeout(() => process.exit(0), 500).unref();
}

// État de GET /readyz (deux modes), lu dans les variables du module sans
// demander de calcul au solveur : jamais de texte d'erreur, de code KaraFun, de
// clé, de prénom ni de nom de table. Le solveur n'entre pas dans `ok` (rotation
// locale de secours). Phases KaraFun rendues telles quelles : retry, stopped,
// idle ; toute autre phase sans données (discovering, opening, waiting-*,
// ready, ou une phase inconnue) devient 'connecting'.
const KARAFUN_PHASES_AS_IS = new Set(['retry', 'stopped', 'idle']);
function readiness() {
  const phase = bridge && !bridge.ready ? bridge.connectionState().phase : null;
  const karafun = !bridge ? 'no-code' : bridge.ready ? 'connected' : KARAFUN_PHASES_AS_IS.has(phase) ? phase : 'connecting';
  const solver = !sched.solverBridge ? 'off' : sched.solverBridge.available ? 'available' : 'unavailable';
  const persistence = !nightStore ? 'off' : persistenceError !== null ? 'error' : 'ok';
  return { ok: karafun === 'connected' && persistence !== 'error', mode: SERVER ? 'server' : 'pc', karafun, solver, persistence };
}

function updateBlockedReason() {
  if (persistenceError !== null) return 'La sauvegarde de la soirée doit être réparée avant la mise à jour.';
  if (activeMutations || pending || restartOp || playStarting || spotifyBusy || spotifyWork ||
      (restartSweep && Date.now() <= restartSweep.until) || battleVote.automation?.status === 'sending') {
    return 'Une action KaraFun ou Spotify est en cours. Réessaie dans un instant.';
  }
  return null;
}

function updateRequiresConfirmation() {
  const { current, q } = analyze();
  return !!(current || q.length || sched.Q.length || [...sched.people.values()].some(person => !person.withdrawnAt));
}

function updateState() {
  return { ...serverUpdate.view(updateBlockedReason()), requiresConfirmation: updateRequiresConfirmation() };
}

function saveTables() {
  if (DEMO) return;
  const data = { version: 1, baseUrl: settings.baseUrl, tables: [...sched.tables.values()].map(t => ({
    id: t.id, name: t.name, headcount: t.headcount, individual: t.individual, secret: access.get(t.id),
  })) };
  fs.mkdirSync(path.dirname(TABLE_FILE), { recursive: true });
  const temporary = `${TABLE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, TABLE_FILE);
}

function loadTables() {
  if (DEMO || !fs.existsSync(TABLE_FILE)) {
    sched.table('1'); access.issue('1'); saveTables(); return;
  }
  const data = JSON.parse(fs.readFileSync(TABLE_FILE, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.tables)) throw new Error('Fichier des tables invalide');
  // Mode serveur : l'adresse vient de KARAOKE_PUBLIC_URL ; une ancienne
  // valeur du fichier, même refusée aujourd'hui, ne bloque pas le démarrage.
  settings.baseUrl = SERVER ? SERVER.publicUrl : normalizeBaseUrl(data.baseUrl);
  for (const row of data.tables) {
    const id = TableAccess.key(row.id);
    if (row.headcount !== null && (!Number.isInteger(row.headcount) || row.headcount < 1 || row.headcount > 40)) {
      throw new Error(`Effectif invalide pour ${id}`);
    }
    const t = sched.table(id);
    if (row.name) {
      const name = String(row.name).replace(/\s+/g, ' ').trim();
      if (name.length > 40) throw new Error(`Nom de table invalide pour ${id}`);
      t.name = name;
    }
    t.headcount = row.headcount;
    t.individual = !!row.individual;
    access.restore(id, row.secret);
  }
}

// Le QR commun aux personnes venues seules reste disponible sans préparation
// du bar. L'identifiant historique ne change pas : les QR déjà imprimés
// continuent à fonctionner pendant une soirée restaurée.
function ensureSoloGroup() {
  let solo = sched.table('Comptoir', false);
  if (solo && !solo.individual && sched.tableSingers(solo.id).length) return;
  if (!solo) solo = sched.table('Comptoir');
  if (!solo.name || solo.name === 'Comptoir') solo.name = 'En solo';
  solo.individual = true;
  if (!access.get(solo.id)) access.issue(solo.id);
  saveTables();
}

// ------------------------------------------------------------------ KaraFun : lecture de l'état
function analyze() {
  if (!bridge || !bridge.ready) return analyzeState();
  return analyzeState(bridge.queue, bridge.status);
}

function isOnStage(tr, current) {
  if (!current) return false;
  if (current.queueId != null && tr.queueId != null) return current.queueId === tr.queueId;
  return Number(current.songId) === tr.sel.song.songId;
}

// La demande « Je suis là » suit le prochain titre réel. Le simple numéro
// d'un ticket dans Q n'est pas suffisant : un ticket peut être sans chanson,
// et readyView masque justement les chanteurs qui n'ont pas encore confirmé.
function presenceCandidate({ current, upcoming } = analyze()) {
  if (!sched.opts.requirePresence || settings.queueClearPending) return null;
  // Relance en cours : la copie du titre sur scène n'est pas un passage.
  if (restartOp) return null;
  if (upcoming.length) {
    const first = tracked.find(tr => !tr.cancelled && !tr.pulled && String(tr.queueId) === String(upcoming[0].queueId));
    return first ? { ...first.sel, source: 'karafun' } : null;
  }
  if (pending && !pending.cancelled) return { ...pending.sel, source: 'envoi' };
  // Après la fermeture, le prochain passage prévu ne sera pas envoyé : ne pas
  // demander sa présence (ni le sauter faute de réponse).
  if (closingBlocksStart(current)) return null;
  const onStage = tracked.find(tr => isOnStage(tr, current));
  const excluded = onStage?.sel.ids || [];
  // Priorité du bar pour une personne encore sur scène : elle passe juste
  // après (reservePresenceNext) ; sa présence sera demandée à sa sortie.
  if (sched.reservedNext?.byStaff && excluded.includes(sched.reservedNext.personId)) return null;
  // L'ordre local est immédiat et Timefold ne déplace jamais le prochain
  // réservé : la notification « Je suis là » vise donc la bonne personne.
  const planned = sched.presenceView(excluded).find(turn => !turn.future && turn.song);
  return planned ? { ...planned, source: 'helper' } : null;
}

function presenceMissing(candidate) {
  if (!candidate) return [];
  const selectionConfirmed = candidate.source !== 'helper' && candidate.presenceConfirmed;
  // Un duo est présent dès que l'un des deux a confirmé.
  const people = candidate.ids.map(pid => sched.people.get(pid)).filter(p => p && !p.withdrawnAt);
  if (selectionConfirmed || people.some(p => sched._confirmedRecently(p))) return [];
  return people.map(p => p.id);
}

// Le prochain passage n'a pas confirmé alors que la scène est libre depuis
// `presenceGraceSec` (ou depuis la demande, si rien ne jouait) : la soirée
// continue avec le passage suivant, et ce titre revient juste après lui.
function skipAbsentIfDue({ current, upcoming }, presence, missing, now) {
  if (!sched.opts.requirePresence || presence?.source !== 'helper' || !missing.length) {
    presenceWait = null;
    return false;
  }
  const key = `${presence.ids.join('+')}|${presence.song?.entryId || ''}`;
  if (presenceWait?.key !== key) presenceWait = { key, askedAt: now, freeSince: null };
  if (current || upcoming.length || pending) { presenceWait.freeSince = null; return false; }
  presenceWait.freeSince ??= now;
  if (!settings.auto || settings.queueClearPending || battleHoldsQueue() || recoveredPending || !bridge?.ready) return false;
  if (now - Math.max(presenceWait.askedAt, presenceWait.freeSince) < settings.presenceGraceSec * 1000) return false;
  presenceWait = null;
  const result = sched.skipUnconfirmed(presence.ids[0], settings.presenceMaxSkips);
  if (result) appLog(`Présence non confirmée : ${presence.name || presence.label || presence.ids[0]} ${result.removed ? 'retiré' : 'passe après le titre suivant'}.`);
  return !!result;
}

function restore(tr, reason) {
  // L'ajout dans KaraFun avait réservé un passage, mais personne n'a chanté.
  // Annuler le crédit physique complet avant de remettre le titre en attente.
  sched.rollbackUnplayed(tr.sel);
  const owner = sched.people.get(tr.sel.ids[0]);
  if (!owner) return;
  // Une autre chanson peut avoir été ajoutée pendant que la première était
  // déjà chez KaraFun : ne jamais écraser cette liste.
  if (!owner.song || owner.song.entryId !== tr.sel.song.entryId) {
    if (owner.song) owner.backlog.unshift(owner.song);
    owner.song = tr.sel.song;
  }
  for (const pid of (tr.sel.consumedIds || tr.sel.ids)) {
    const p = sched.people.get(pid);
    if (!p) continue;
    const i = sched.Q.indexOf(pid);
    if (i >= 0) { sched.Q.splice(i, 1); sched.Q.splice(Math.min(3, sched.Q.length), 0, pid); }
  }
  sched.note(`« ${tr.sel.song.title} » (${shownLabel(tr.sel)}) ${reason} : garde sa chanson et reprend la 4e place`, 'staff');
}

// Titre retiré de KaraFun pour être chanté plus tard (« Pas prêt », partenaire
// d'un duo improvisé qui vient de monter sur scène, « Priorité » du bar avant
// lui) : son passage n'a pas eu lieu, le titre revient en tête de la liste de
// son chanteur et son ticket reprend sa place. Un report « Pas prêt »
// s'applique ensuite ; après une priorité, il repasse juste après elle
// (Scheduler#yieldToPriority), ou reprend sa place si elle ne tient plus.
function restorePulled(tr) {
  sched.requeueUnplayed(tr.sel);
  if (tr.pulled?.reason === 'priority') {
    const forP = sched.people.get(tr.pulled.forId || '');
    const still = !!sched.yieldToPriority(tr.sel, forP?.id || null);
    sched.note(`« ${tr.sel.song.title} » (${shownLabel(tr.sel)}) retiré de KaraFun : ` + (still ?
      `il repasse juste après ${forP.name} (priorité du bar), sans perdre son tour` :
      `la priorité ${forP ? `de ${forP.name} ` : ''}ne tient plus, il reprend sa place sans perdre son tour`), 'skip');
    return;
  }
  if (!tr.pulled) {
    sched.note(tr.unpulled?.reason === 'duo' ?
      `« ${tr.sel.song.title} » (${shownLabel(tr.sel)}) retiré de KaraFun malgré l’annulation du duo : il revient en tête de la liste de son chanteur.` :
      `« ${tr.sel.song.title} » (${shownLabel(tr.sel)}) retiré de KaraFun juste avant le changement de l’heure de fermeture : il revient dans la liste de son chanteur.`, 'skip');
    return;
  }
  const { reason } = tr.pulled;
  sched.note(reason === 'closing' ?
    `« ${tr.sel.song.title} » (${shownLabel(tr.sel)}) retiré de KaraFun : il passerait après la fermeture. Il repartira s’il passe de nouveau avant l’heure, par exemple si le bar la décale.` :
    reason === 'duo' ?
    `« ${tr.sel.song.title} » (${shownLabel(tr.sel)}) retiré de KaraFun après le duo improvisé : il repassera plus tard` :
    `« ${tr.sel.song.title} » (${shownLabel(tr.sel)}) retiré de KaraFun : ${passageNames(tr.sel)} laisse passer la chanson suivante`, 'skip');
}

// Retire de KaraFun un titre pas encore chanté pour le rechanter plus tard.
// `extra` : `forId`, personne de la priorité du bar qui passe avant lui.
const pullDisconnected = () => new Error('KaraFun est déconnecté : réessaie dans un instant ou demande au bar.');
function pullFromKaraFun(tr, reason, extra = {}) {
  if (!bridge?.ready) throw pullDisconnected();
  bridge.remove(tr.queueId);
  tr.pulled = { reason, at: Date.now(), ...extra };
  tr.removeRequestedAt = Date.now();
}
const PULL_ALERT_MS = 45000; // KaraFun garde un titre à retirer : le bar est prévenu
const BATTLE_ACK_MS = 15000; // attente de l'accusé d'un ajout Battle ; aucun second envoi
const BATTLE_SETTLE_MS = 1500; // état de la file KaraFun confirmé sur cette durée (trames arrivées en deux temps)
const PULL_LATE_MS = 20000; // un retrait envoyé (renvoyé toutes les 20 s) peut encore aboutir

// Départ de la Battle selon le suivi : sur scène (`playing`), ou retirée un
// instant de la file de KaraFun avant qu'il annonce sa lecture (`queued` qui
// patiente). Elle compte encore comme en tête de KaraFun pour le lien des
// téléphones et pour Spotify, y compris KaraFun déconnecté (coupure,
// redémarrage de l'application) : le suivi garde alors son dernier état.
function battleStarting() {
  const state = battleVote.automation;
  return state?.status === 'playing' || (state?.status === 'queued' && !!state.missingSince);
}

function battleHoldsQueue() {
  const state = battleVote.automation?.status;
  return !!state && !['released', 'resuming'].includes(state) &&
    !(state === 'waiting' && sched.reservedNext);
}

// KaraFun a ajouté le titre de la Battle en chanson normale : le mode demandé
// n'existe pas pour ce titre. Soirée du 10 octobre, « Sarà perché ti amo »
// (un duo) : la demande portait le mode « Battle » des titres à une voix,
// alors que sa Battle se fait sur une voix (numéro 2, « Angela Brambati ») ;
// le bar l'a passé en mode Battle dans KaraFun et la Battle a eu lieu. La
// page fait de même, une seule fois, avec le mode tiré des voix du titre.
// Rien n'est retiré de KaraFun d'office : sans mode connu, ou si KaraFun ne
// suit pas, le bar s'en charge et la Battle est reconnue dès qu'il l'a fait.
const battleTitle = () => battleVote.ballot?.selectedSong?.title || 'ce titre';
const plainBattleCopy = title => `KaraFun a ajouté « ${title} » en chanson normale, sans le mode Battle. ` +
  'Passe ce titre en mode Battle dans KaraFun (la page reconnaîtra la Battle), ou retire-le et touche « Ne pas lancer cette fois »';
const plainBattleOnStage = title => `KaraFun a lancé « ${title} » en chanson normale, sans le mode Battle : ` +
  'laisse-le finir ou passe au titre suivant, puis touche « Ne pas lancer cette fois »';
// Échec d'une copie normale : consigne selon qu'elle attend ou passe déjà.
function failPlainBattleCopy(copyId, current, reason = '') {
  const onStage = current && String(current.queueId) === String(copyId);
  const text = (onStage ? plainBattleOnStage : plainBattleCopy)(battleTitle());
  battleVote.updateAutomation('failed', reason ? `${text} (${String(reason).replace(/[.!?\s]+$/, '')})` : text);
}
function switchPlainBattleCopy(copy, current) {
  const state = battleVote.automation;
  const sent = state.sentMod || BATTLE_MOD;
  const mod = copy.battleMod;
  if ((current && String(current.queueId) === String(copy.queueId)) ||
      !mod || (Number(mod.id) === Number(sent.id) && mod.caption === sent.caption)) {
    failPlainBattleCopy(copy.queueId, current);
    return;
  }
  try {
    bridge.setBattleMode(copy.queueId, mod);
  } catch (error) {
    failPlainBattleCopy(copy.queueId, current, error.message);
    return;
  }
  battleVote.noteModeSwitch(copy.queueId, mod);
  sched.note(`KaraFun a ajouté « ${battleTitle()} » sans le mode Battle : la page le passe en mode Battle sur la voix « ${mod.caption} ».`, 'battle');
}
// Réponse de KaraFun au passage en mode Battle : un refus fait échouer tout
// de suite, avec sa raison ; une réponse positive attend la file de KaraFun.
function battleModeAnswer(answer) {
  const state = battleVote.automation;
  if (answer?.ok !== false || state?.status !== 'sending' || state.modeTarget !== String(answer.queueId)) return;
  failPlainBattleCopy(answer.queueId, analyze().current, `KaraFun : ${answer.message}`);
}

// Événements du pont KaraFun que la file suit.
function wireBridge(b) {
  b.on('change', () => setImmediate(sync));
  b.on('add-options-refused', add => setImmediate(() => resendWithoutOptions(add)));
  b.on('battle-mode-answer', answer => setImmediate(() => battleModeAnswer(answer)));
}

function syncBattle({ current, upcoming, q }, now) {
  let state = battleVote.automation;
  const native = [current, ...q].filter(Boolean).find(item => isBattleItem(item) &&
    item.queueId != null && String(item.queueId) !== String(state?.queueId || ''));
  if (!settings.queueClearPending && native && state?.status === 'manual' &&
      Number(native.songId) === state.songId) {
    battleVote.confirmManualAutomation(native.queueId);
    sched.note('KaraFun confirme la Battle manuelle : la fin sera détectée automatiquement.', 'battle');
    state = battleVote.automation;
  } else if (!settings.queueClearPending && native &&
      (!state || state.status === 'released' || state.status === 'manual' ||
        (state.status === 'waiting' && Number(native.songId) !== state.songId))) {
    battleVote.observeExternalBattle(native);
    sched.note('Battle ajoutée dans KaraFun : lancement et reprise du titre suivant réservés au bar.', 'battle');
    state = battleVote.automation;
  }
  if (!state || state.status === 'released') return;
  const matches = q.filter(item => Number(item.songId) === state.songId && isBattleItem(item));
  if (state.status === 'waiting') {
    if (matches.length === 1) {
      battleVote.confirmAutomation(matches[0].queueId);
      sched.note('Battle reconnue dans KaraFun : le bar laisse les téléphones rejoindre avant le départ.', 'battle');
    } else if (matches.length > 1) {
      battleVote.updateAutomation('failed', 'Plusieurs Battles identiques sont dans KaraFun. Vérifie la file.');
    } else if (!state.songId) {
      battleVote.updateAutomation('failed', 'Le vote ne contient pas de titre KaraFun compatible.');
    } else if (settings.auto &&
        (bridge.protocol !== 'kcs' || bridge.raw?.configuration) &&
        !upcoming.length && !pending && !recoveredPending && !settings.queueClearPending &&
        !sched.reservedNext && bridge.permissions?.addToQueue !== false && !closingBlocksStart(current, 0, now)) {
      // Le passage suivant déjà garanti garde sa place. Une Battle approuvée
      // attend qu'il ait chanté avant d'occuper la prochaine case libre.
      // Mode Battle que KaraFun connaît pour ce titre s'il est déjà passé par
      // sa file (voix d'un duo), sinon « Battle ».
      const mod = bridge.battleModForSong(state.songId);
      battleVote.beginAutomation(q.map(item => String(item.queueId)), { sentMod: mod });
      try {
        bridge.addBattle(state.songId, current ? 1 : 0, mod);
        sched.note('Titre Battle envoyé à KaraFun : attente de la confirmation du mode Battle.', 'battle');
      } catch (error) {
        battleVote.updateAutomation('failed', error.message);
      }
    }
  } else if (state.status === 'sending' || state.status === 'failed') {
    const fresh = q.filter(item => !state.before.includes(String(item.queueId)) &&
      Number(item.songId) === state.songId);
    const battles = fresh.filter(isBattleItem);
    // Notre ajout sans le mode Battle : même titre, apparu depuis l'envoi, et
    // aucun passage de la file. La trame KCS ne porte pas le nom « Battle
    // collective » (seulement le mode) : le nom ne permettait pas de le
    // reconnaître sur le vrai KaraFun (soirée du 10 octobre).
    const plain = fresh.filter(item => !isBattleItem(item) &&
      !tracked.some(tr => String(tr.queueId) === String(item.queueId)) &&
      !(pending && Number(pending.sel.song.songId) === state.songId));
    if (battles.length === 1) {
      // Confirmée par KaraFun, même après un échec : le bar a pu passer la
      // copie en mode Battle dans KaraFun lui-même.
      battleVote.confirmAutomation(battles[0].queueId);
      sched.note('KaraFun confirme le mode Battle : la pause entre votes commence.', 'battle');
    } else if (battles.length > 1) {
      if (state.status !== 'failed') battleVote.updateAutomation('failed', 'Plusieurs Battles identiques sont apparues dans KaraFun.');
    } else if (state.status === 'sending' && plain.length === 1 && state.modeTarget == null &&
        now - (state.plainId === String(plain[0].queueId) ? state.plainSince : state.sentAt) <= BATTLE_ACK_MS) {
      // Copie attribuée seulement si elle reste sans mode Battle 1,5 s, apparue
      // pendant l'attente de l'accusé (comptée depuis l'ajout ; une copie déjà
      // notée, depuis qu'elle l'a été) : une trame Battle incomplète ou un
      // suivi resté « sending » après une coupure ne compte pas.
      if (state.plainId !== String(plain[0].queueId)) battleVote.notePlainCopy(plain[0].queueId);
      else if (now - state.plainSince >= BATTLE_SETTLE_MS) switchPlainBattleCopy(plain[0], current);
    } else if (state.status === 'sending' && now - (state.modeSentAt ?? state.sentAt) > BATTLE_ACK_MS) {
      // Pas de seconde commande : un accusé tardif pourrait créer un doublon.
      if (state.modeTarget != null && plain.some(item => String(item.queueId) === state.modeTarget)) {
        failPlainBattleCopy(state.modeTarget, current);
      } else battleVote.updateAutomation('failed', 'KaraFun n’a pas confirmé l’ajout Battle. Vérifie sa file avant d’agir.');
    }
  } else if (state.status === 'queued' || state.status === 'playing') {
    const queueHasBattle = q.some(item => String(item.queueId) === state.queueId);
    const statusId = bridge.status?.current?.queueId || bridge.status?.songPlaying?.queueId;
    if (current && String(current.queueId) === state.queueId && state.status === 'queued') {
      battleVote.updateAutomation('playing');
    } else if (!queueHasBattle && String(statusId || '') !== state.queueId) {
      // QueueEvent peut arriver avant StatusEvent. Si le titre prêt disparaît
      // momentanément de la file, patienter avant de conclure qu'il est fini.
      if (state.status === 'queued' && !state.missingSince) {
        state.missingSince = now;
        battleVote._changed('automation-missing');
      } else if (state.status === 'playing' || now - state.missingSince >= BATTLE_SETTLE_MS) {
        battleVote.updateAutomation('after');
        sched.note('Battle terminée : le prochain titre attend le lancement manuel du bar.', 'battle');
      }
    } else if (state.missingSince) {
      state.missingSince = null;
      battleVote._changed('automation-found');
    }
  } else if (state.status === 'after' && current && !isBattleItem(current) && String(current.queueId) !== String(state.queueId) &&
      String(bridge.status?.current?.queueId ?? bridge.status?.songPlaying?.queueId ?? '') === String(current.queueId)) {
    // Titre suivant lancé directement dans KaraFun : la Battle est finie, la
    // file reprend (sinon elle restait retenue et le vote suivant bloqué).
    // KaraFun doit nommer ce titre comme joué : un état « lecture » sans
    // titre (transition) ferait passer le premier de la file pour la scène.
    battleVote.updateAutomation('released');
  } else if (state.status === 'resuming') {
    if (current && !isBattleItem(current)) {
      battleVote.updateAutomation('released');
    } else if (!state.resumePlaySentAt && upcoming.length && !current) {
      const first = upcoming[0];
      if (!isBattleItem(first)) {
        try {
          bridge.play();
          state.resumePlaySentAt = now;
          battleVote._changed('automation-resume-play');
        } catch (error) { sched.note(`Reprise Battle à relancer : ${error.message}`, 'battle'); }
      }
    }
  }
}

// ------------------------------------------------------------------ relancer depuis le début
// La télécommande KaraFun n'a pas de commande vérifiée pour revenir au début
// d'un titre. La relance utilise donc les commandes déjà employées par la
// file : une copie du titre est ajoutée juste après lui, puis « Suivant » la
// fait jouer. Le passage n'est ni terminé ni compté deux fois : son suivi
// passe à la copie. Si KaraFun ne place pas la copie juste après le titre en
// cours, ou si la relance échoue ensuite, la copie est retirée et le titre
// en cours garde son suivi.
const RESTART_ADD_TIMEOUT_MS = 15000;    // délai pour voir la copie dans KaraFun
const RESTART_PLAY_NUDGE_MS = 2500;      // « Lecture » si KaraFun reste à l'arrêt après Suivant
const RESTART_START_TIMEOUT_MS = 20000;  // délai pour voir la copie sur scène
const RESTART_SWEEP_MS = 60000;          // copie tardive retirée pendant ce délai
let lastRestartCopy = null;
let restartSweep = null; // { songId, singer, before, until } : copies tardives à retirer
let restartAwaitingPlay = null; // copie prête après une relance inachevée : { copyQueueId, title }

function startRestart() {
  if (!bridge?.ready) throw new Error('KaraFun est déconnecté. Reconnecte-le avant de relancer le titre.');
  if (restartOp) throw new Error('La relance du titre est déjà en cours.');
  // Une copie d'un essai raté peut encore arriver : impossible de la
  // distinguer d'une nouvelle copie du même titre.
  if (restartSweep && Date.now() <= restartSweep.until) {
    throw new Error(`La relance précédente vient d’échouer : vérifie la file de KaraFun. Nouvel essai possible dans ${Math.ceil((restartSweep.until - Date.now()) / 1000)} s, ou utilise le bouton de KaraFun.`);
  }
  restartSweep = null; // délai écoulé : la nouvelle copie ne doit pas être prise pour une copie tardive
  if (pending) throw new Error('Un titre est en cours d’envoi à KaraFun. Réessaie dans un instant.');
  const { current, q } = analyze();
  if (!current) throw new Error('Aucun titre en cours à relancer.');
  if (isBattleItem(current)) throw new Error('Une Battle se relance depuis KaraFun.');
  const songId = Number(current.songId);
  if (!Number.isSafeInteger(songId) || songId <= 0) {
    throw new Error('KaraFun ne donne pas l’identifiant de ce titre : relance-le depuis KaraFun.');
  }
  const tr = tracked.find(item => isOnStage(item, current));
  // Titre suivi : le nom recalculé (prénom seul pour un soliste), sous lequel
  // la copie est aussi reconnue. Ligne non suivie : le nom vu dans KaraFun,
  // sans le groupe individuel, comme la carte Scène l'affiche.
  const singer = tr ? shownLabel(tr.sel) : withoutSoloGroup(String(current.singer || ''));
  restartOp = { songId, singer, title: tr?.sel.song.title || current.title || 'le titre',
    before: q.map(item => String(item.queueId)), at: Date.now(), phase: 'adding',
    originalQueueId: current.queueId, trackedQueueId: tr ? tr.queueId : null };
  // La copie garde les réglages du titre (ceux de la file, sinon l'état en
  // direct d'un titre ajouté dans KaraFun).
  // Pistes vocales du titre connues : volumes seulement pour celles-là.
  const songSettings = tr ? tr.sel.song.settings || null : settingsFromLive(liveFromStatus(bridge.status), songDefaults());
  const tracksAvailable = liveFromStatus(bridge.status)?.tracks || songTracksOf(current);
  try { restartOp.sentSettings = bridge.add(songId, singer, 1, songSettings, { tracksAvailable }) || null; }
  catch (error) { restartOp = null; throw error; }
  sched.note(`Le bar relance « ${restartOp.title} » depuis le début.`, 'stage');
}

const restartCopies = (op, q) => q.filter(item => !op.before.includes(String(item.queueId)) &&
  Number(item.songId) === op.songId && String(item.singer || '') === op.singer &&
  !tracked.some(tr => String(tr.queueId) === String(item.queueId)));

// Copie arrivée après l'abandon de la relance : elle rejouerait le titre.
function sweepRestartCopies({ current, q }, now) {
  const sweep = restartSweep;
  if (!sweep) return;
  if (now > sweep.until) { restartSweep = null; return; }
  for (const copy of restartCopies(sweep, q)) {
    if (String(current?.queueId) === String(copy.queueId)) continue; // déjà sur scène : ne pas couper
    sweep.before.push(String(copy.queueId));
    try { bridge.remove(copy.queueId); sched.note(`Copie tardive de « ${sweep.title} » retirée de KaraFun.`, 'stage'); }
    catch (error) { appLog(`Retrait KaraFun en attente : ${error.message}`); sweep.before.pop(); }
  }
}

function abandonRestart(op, { current, upcoming, q }, message, now) {
  restartOp = null;
  const copyId = op.copyQueueId;
  const originalLive = q.some(item => String(item.queueId) === String(op.originalQueueId));
  if (copyId && !originalLive && !current && String(upcoming[0]?.queueId) === copyId) {
    // Suivant a bien retiré le titre : la copie prête à jouer garde le suivi,
    // et sa durée repartira de son lancement.
    restartAwaitingPlay = { copyQueueId: copyId, title: op.title };
    sched.note(`${message} La copie du titre est prête : lance la lecture dans KaraFun.`, 'error');
    return;
  }
  if (copyId) {
    const tr = tracked.find(item => String(item.queueId) === copyId);
    if (tr && op.trackedQueueId != null) tr.queueId = op.trackedQueueId;
    if (lastRestartCopy === copyId) lastRestartCopy = null;
  }
  // La copie (même tardive) ne doit jamais rejouer le titre après lui.
  restartSweep = { songId: op.songId, singer: op.singer, title: op.title,
    before: op.before.filter(id => id !== copyId), until: now + RESTART_SWEEP_MS };
  sweepRestartCopies({ current, q }, now);
  sched.note(`${message} ${originalLive ? 'Le titre en cours continue.' : current ?
    'Un autre titre joue maintenant : vérifie la file de KaraFun.' : 'Vérifie la file de KaraFun.'}`, 'error');
}

function syncRestart({ current, upcoming, q }, now) {
  sweepRestartCopies({ current, q }, now);
  const waiting = restartAwaitingPlay;
  if (waiting) {
    if (String(current?.queueId) === waiting.copyQueueId) {
      const tr = tracked.find(item => String(item.queueId) === waiting.copyQueueId);
      if (tr) tr.startedAt = now;
      sched.note(`« ${waiting.title} » repart du début.`, 'stage');
      restartAwaitingPlay = null;
    } else if (!q.some(item => String(item.queueId) === waiting.copyQueueId)) restartAwaitingPlay = null;
  }
  const op = restartOp;
  if (!op) return;
  const state = { current, upcoming, q };
  const playing = copyId => String(current?.queueId) === copyId;
  if (op.phase === 'adding') {
    // Le titre a quitté la file mais KaraFun l'annonce encore en lecture :
    // attendre son état suivant avant de choisir entre Lecture et Suivant.
    if (current && !q.some(item => String(item.queueId) === String(current.queueId))) return;
    const copies = restartCopies(op, q);
    if (!copies.length) {
      if (now - op.at > RESTART_ADD_TIMEOUT_MS) abandonRestart(op, state, 'KaraFun n’a pas confirmé la relance du titre : rien n’a été passé.', now);
      return;
    }
    // Le titre a pu finir seul pendant l'ajout : la copie joue déjà.
    const started = copies.find(copy => playing(String(copy.queueId)));
    const copy = started || copies[0];
    if (!started && (copies.length > 1 || String(upcoming[0]?.queueId) !== String(copy.queueId))) {
      // Sans place juste après le titre en cours, « Suivant » lancerait un autre titre.
      abandonRestart(op, state, 'KaraFun n’a pas placé la copie juste après le titre en cours : relance annulée. Utilise le bouton de KaraFun.', now);
      return;
    }
    const tr = op.trackedQueueId != null && tracked.find(item => String(item.queueId) === String(op.trackedQueueId));
    if (tr) {
      tr.queueId = copy.queueId;
      // Nouvel élément de KaraFun : ses réglages sont ceux envoyés avec la copie.
      if (op.sentSettings) tr.sentSettings = op.sentSettings;
      else delete tr.sentSettings;
    }
    op.copyQueueId = String(copy.queueId);
    lastRestartCopy = op.copyQueueId;
    op.phase = 'skipping';
    op.at = now;
    if (!started && !current) {
      // Le titre a fini seul et KaraFun attend : la copie est en tête, il
      // suffit de la lancer (« Suivant » risquerait de la passer).
      try { bridge.play(); op.playSentAt = now; } catch (_) { /* nouvel essai plus bas */ }
    } else if (!started) {
      try { bridge.next(); }
      catch (error) { abandonRestart(op, state, `Relance interrompue : ${error.message}.`, now); return; }
    }
  }
  if (playing(op.copyQueueId)) {
    const tr = tracked.find(item => String(item.queueId) === op.copyQueueId);
    if (tr) tr.startedAt = now; // la durée mesurée repart de la relance
    restartOp = null;
    sched.note(`« ${op.title} » repart du début.`, 'stage');
    return;
  }
  if (!current && String(upcoming[0]?.queueId) === op.copyQueueId && !op.playSentAt && now - op.at > RESTART_PLAY_NUDGE_MS) {
    try { bridge.play(); op.playSentAt = now; } catch (_) { /* nouvel essai au prochain passage */ }
  }
  if (now - op.at > RESTART_START_TIMEOUT_MS) abandonRestart(op, state, 'La relance n’a pas démarré.', now);
}

// ------------------------------------------------------------------ réglages de titre
// Tonalité, tempo, voix guide et chœurs (song-settings.js). Le réglage est un
// champ de l'entrée du titre : il part avec elle dans les options d'ajout,
// remplace les options du titre déjà chargé dans KaraFun
// (SetQueueItemOptionsRequest), puis il est rattrapé une seule fois au début
// du titre si KaraFun ne l'a pas appliqué (Pitch, Tempo, TrackVolume). Ce que
// le titre ne règle pas revient alors à sa valeur neutre : rien ne passe
// d'un titre au suivant.
const songRanges = () => rangesFrom(bridge?.raw?.configuration);
// Valeurs par défaut de ce KaraFun (chœurs à 53 au bar), relevées par le pont.
const songDefaults = () => bridge?.songSettingsDefaults?.() || { ...SONG_DEFAULTS };
const kfItemOf = tr => bridge?.queue?.find(item => String(item.queueId) === String(tr.queueId)) || null;
// Chaque titre est isolé du précédent : à son chargement, la file vise les
// valeurs neutres (song-settings.js, neutralTarget), complétées par ses
// réglages. `loadedLive` : dernier état vu du titre chargé ; `previousLoaded` :
// celui du titre d'avant (ses chœurs décident s'ils sont remis par défaut).
let loadedLive = null, previousLoaded = null;
// Numéro de l'état de KaraFun : il change à chaque nouvel état reçu
// (StatusEvent), pour savoir si KaraFun a parlé depuis une demande.
let statusSeen = null, statusNumber = 0;
function statusSeq() {
  const status = bridge?.status || null;
  if (status !== statusSeen) { statusSeen = status; statusNumber++; }
  return statusNumber;
}
// Titre que KaraFun a vraiment chargé : état 3 (prêt, avant « Lecture »),
// 4 (lecture) ou 5 (pause) de la télécommande KCS. À l'état 1, KaraFun
// annonce déjà le titre suivant sans l'avoir chargé (pistes vides, ou celles
// d'un autre titre) ; à l'état 2, il le charge encore : leurs valeurs ne
// disent rien des réglages appliqués. Sans numéro d'état (faux KaraFun de la
// démo), seule la lecture compte.
function loadedQueueId() {
  const status = bridge?.status;
  const item = status?.current || status?.songPlaying;
  if (item?.queueId == null) return null;
  const loaded = Number.isInteger(status.kcsState) ? [3, 4, 5].includes(status.kcsState)
    : /^(playing|paused)$/.test(String(status.state || ''));
  const voices = songTracksOf(item);
  if (!loaded || (voices?.length && !(Array.isArray(status.tracks) && status.tracks.length))) return null;
  return String(item.queueId);
}
function songSettingsError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Titre `entryId` encore à venir : chargé dans KaraFun sans avoir commencé,
// en cours d'envoi, ou dans la liste de son chanteur. `started` : refus si
// le titre a déjà commencé. `ids` : auteur du titre puis partenaire de duo.
function songSettingsTarget(entryId, started) {
  const key = String(entryId || '');
  const missing = () => songSettingsError('Ce titre n’est plus prévu : il a peut-être déjà été chanté ou retiré.', 'NO_SONG');
  if (!key) throw missing();
  const { current } = analyze();
  const tr = tracked.find(item => item.sel.song?.entryId === key && !item.cancelled);
  if (tr) {
    if (tr.startedAt || isOnStage(tr, current)) throw songSettingsError(started, 'SONG_STARTED');
    if (tr.pulled || tr.absent) throw new Error('Ce titre est en train de sortir de KaraFun. Réessaie dans un instant.');
    return { where: 'karafun', ids: tr.sel.ids, song: tr.sel.song, tr };
  }
  if (pending && !pending.cancelled && pending.sel.song.entryId === key) {
    // Après une reprise sur disque, l'envoi garde sa propre copie du titre.
    const owner = sched.people.get(pending.sel.ids[0]);
    const listed = owner && sched.songsOf(owner).find(song => song.entryId === key);
    return { where: 'sending', ids: pending.sel.ids, song: pending.sel.song,
      copies: listed && listed !== pending.sel.song ? [listed] : [] };
  }
  for (const owner of sched.people.values()) {
    const song = sched.songsOf(owner).find(item => item.entryId === key);
    if (song) return { where: 'list', ids: [owner.id, ...(song.duet?.partnerId ? [song.duet.partnerId] : [])], song };
  }
  throw missing();
}

// Réglages reçus d'une page : sans la clé `guideVoices` (page gardée en cache
// d'avant les voix guides par voix), les autres voix guides du titre restent ;
// sur un duo (`target.ids`), la voix 2 suit toujours la voix guide, comme sur
// ces pages (et comme à la reprise d'une ancienne sauvegarde, legacyDuoVoice) :
// sans voix guide (remise par défaut), plus de voix 2.
// Les pages actuelles envoient toujours la clé ({} quand il n'y en a plus).
function songSettingsInput(input, { song, ids }) {
  if (input != null && (typeof input !== 'object' || Array.isArray(input) || 'guideVoices' in input)) return input;
  const voices = { ...song?.settings?.guideVoices };
  if (ids?.length > 1) {
    delete voices[TRACK.LEAD_B];
    if (input?.guide != null) voices[TRACK.LEAD_B] = input.guide;
  }
  if (!Object.keys(voices).length) return input;
  return { ...(input || {}), guideVoices: voices };
}

// Enregistre les réglages sur le titre, puis les applique selon où il en est.
// Rend 'list' (au prochain envoi), 'sending' (dès l'accusé de KaraFun),
// 'karafun' (envoyés) ou 'start' (au début du titre, ou au retour de KaraFun).
function applySongSettings(target, values, fields) {
  sched.setSongSettings(target.song, values);
  for (const copy of target.copies || []) sched.setSongSettings(copy, values);
  let applied = 'list';
  if (target.where === 'sending') { pending.settingsChanged = true; applied = 'sending'; }
  else if (target.where === 'karafun') {
    target.tr.settingsDirty = true;
    delete target.tr.liveChecked; // déjà chargé par KaraFun : rattrapage refait si besoin
    applied = pushQueueItemSettings(target.tr) ? 'karafun' : 'start';
  }
  journalEvent('song.settings', { ...fields, personId: target.ids[0], entryId: target.song.entryId, where: target.where, settings: values });
  return applied;
}

// Titre déjà chargé dans KaraFun : ses options y sont remplacées, avec le nom
// que KaraFun affiche (la file reconnaît ses titres par lui) et son mode.
// false : envoi en attente du retour de KaraFun, ou droit « Éditer la file
// d'attente » refusé (le rattrapage au début du titre prendra le relais).
// Envoyées : le rattrapage attend un état de KaraFun reçu depuis
// (`statusAtOptions`), car KaraFun a pu les appliquer au titre chargé.
function pushQueueItemSettings(tr) {
  const item = bridge?.ready ? kfItemOf(tr) : null;
  if (!item) return false;
  tr.settingsDirty = false;
  if (bridge.permissions?.manageQueue === false) return false;
  try {
    const sent = bridge.setQueueItemOptions(tr.queueId, { singer: item.singer || tr.sel.label, mod: item.options?.mod || null,
      settings: tr.sel.song.settings || null, sent: tr.sentSettings || null, current: item.options || null,
      tracksAvailable: songTracksOf(item) });
    if (sent) tr.sentSettings = sent;
    tr.statusAtOptions = statusSeq();
    return true;
  } catch (error) {
    appLog(`Réglages de « ${tr.sel.song.title} » non envoyés à KaraFun : ${error.message}`);
    return false;
  }
}

// Titre chargé ou sur scène : ce que KaraFun n'a pas appliqué (options
// d'ajout ou du titre ignorées) est envoyé une seule fois, pour ce titre de
// KaraFun, ainsi que les valeurs neutres de ce que le titre ne règle pas
// (un KaraFun peut garder celles du titre précédent). Un réglage en direct
// fait ensuite n'est pas « rattrapé » une seconde fois.
function catchUpSongSettings(tr) {
  const mark = String(tr.queueId);
  if (tr.liveChecked === mark) return;
  // Options du titre tout juste envoyées : comparer à un état reçu depuis,
  // au plus tard celui de la lecture. Refusées par KaraFun : sans attendre.
  if (tr.statusAtOptions != null) {
    if (tr.statusAtOptions === statusSeq() && bridge.settingsSupport?.queueItemOptions !== 'refused') return;
    delete tr.statusAtOptions;
  }
  const live = liveFromStatus(bridge.status);
  if (live?.queueId != null && String(live.queueId) !== mark) return; // état de KaraFun pas encore à jour
  tr.liveChecked = mark;
  // Valeurs neutres complétées par les options du titre dans KaraFun : une
  // tonalité réglée par le bar dans KaraFun même est gardée (comme pour un
  // titre ajouté directement dans KaraFun). Les réglages du titre priment.
  // Titre vu pour la première fois déjà en lecture (application redémarrée,
  // télécommande reconnectée) : ses seuls réglages, jamais de valeur neutre
  // en pleine chanson. Battle : voir checkUntrackedSettings.
  const item = kfItemOf(tr);
  const neutral = !isBattleItem(item) && seenLoadingLive(mark) ? startNeutral(mark, item?.options || null) : null;
  const commands = catchUpCommands({ settings: tr.sel.song.settings || null, sent: tr.sentSettings || null, live,
    tracksAvailable: live?.tracks || songTracksOf(item), ranges: songRanges(), defaults: songDefaults(), neutral });
  applyStartCommands(commands, live, { title: tr.sel.song.title, entryId: tr.sel.song.entryId || null, queueId: tr.queueId });
}

// Chanson d'un titre de KaraFun (titre ou quiz) : compare deux états du même numéro.
const loadedSongOf = item => String(item?.songId ?? item?.quizId ?? item?.title ?? '');

// Dernier état vu du titre chargé ; le précédent est gardé au changement.
// true : ce titre vient d'être chargé (premier état vu pour lui) et cette
// application l'a vu annoncé ou se charger (états 1 à 3, voir
// KaraFunBridge.seenLoading). Un titre vu pour la première fois déjà en
// lecture (application redémarrée, ou télécommande reconnectée, en pleine
// chanson) n'en est pas un : ses réglages en direct ne sont pas remis. Sans
// numéro d'état (ancienne télécommande), après un titre déjà vu dans la
// même session. Autre session (coupure, « Reconnecter », KaraFun relancé qui
// renumérote sa file depuis 1) : même titre seulement s'il garde son numéro
// et sa chanson, jamais remis pour autant ; vu se charger seulement s'il
// l'est de nouveau (état 3, ou vu annoncé dans cette session). Sinon nouveau
// titre, sans titre d'avant connu.
function noteLoadedLive(loadedId) {
  const live = loadedId ? liveFromStatus(bridge.status) : null;
  if (!live || String(live.queueId) !== loadedId) return false;
  const session = bridge.statusSession ?? null;
  const song = loadedSongOf(bridge.status?.current || bridge.status?.songPlaying);
  const sameSession = loadedLive?.session === session;
  const fresh = loadedLive?.queueId !== loadedId || (!sameSession && loadedLive.song !== song);
  const kcsState = bridge.status?.kcsState;
  const seenNow = !Number.isInteger(kcsState) ? !!loadedLive && sameSession : kcsState === 3 || bridge.seenLoading(loadedId);
  if (loadedLive && fresh) previousLoaded = sameSession ? loadedLive : null;
  // Vu se charger : décidé au premier état vu du titre, gardé ensuite dans
  // la même session.
  const seenLoading = fresh ? seenNow : sameSession ? loadedLive.seenLoading : loadedLive.seenLoading && seenNow;
  loadedLive = { queueId: loadedId, song, backing: live.backing, seenLoading, session };
  return fresh && seenLoading;
}

// Le titre `queueId` est le titre chargé, et cette application l'a vu se
// charger : ses valeurs neutres peuvent être visées (voir noteLoadedLive).
const seenLoadingLive = queueId => loadedLive?.queueId === queueId && !!loadedLive.seenLoading;

// Valeurs neutres du titre `queueId` qui se charge, avec ses options KaraFun
// pour un titre ajouté directement dans KaraFun.
function startNeutral(queueId, options = null) {
  const previous = loadedLive?.queueId === queueId ? previousLoaded : null;
  return neutralTarget({ backingDefault: bridge?.observedDefaults?.backing ?? null, previousBacking: previous?.backing ?? null, options });
}

const signedValue = n => (n > 0 ? `+${n}` : String(n));
// Voix guide nommée comme sur les pages : « voix guide » pour un titre qui
// n'en a qu'une, sinon « voix 1 », « voix 2 »… dans l'ordre des pistes.
function voiceLabel(type, tracks) {
  const voices = guideVoicesOf([...(guideVoicesOf(tracks) || [TRACK.LEAD_A]), type]);
  return voices.length > 1 ? `voix ${voices.indexOf(type) + 1}` : 'voix guide';
}
const resetLabel = (command, live) => command.kind === 'pitch' ? `tonalité ${signedValue(live.pitch)}`
  : command.kind === 'tempo' ? `tempo ${signedValue(live.tempo)} %`
    : command.type === TRACK.BACKING ? `chœurs ${live.backing}` : `${voiceLabel(command.type, live.tracks)} ${live.voices?.[command.type]}`;
// Champ d'une commande pour le journal : 'guide' (voix 1) ou 'guideVoices.6'…
const trackField = type => type === TRACK.BACKING ? 'backing' : type === TRACK.LEAD_A ? 'guide' : `guideVoices.${type}`;
const commandField = command => command.kind !== 'track' ? command.kind : trackField(command.type);

// Commandes du début d'un titre : réglages du titre rattrapés
// (song.settingsCaughtUp) et valeurs neutres rétablies (song.settingsReset).
// Sans le droit « Personnaliser la chanson en cours », un seul avis au bar.
function applyStartCommands(commands, live, { title, entryId, queueId }) {
  if (!commands.length) return;
  const own = commands.filter(command => !command.neutral);
  if (bridge.permissions?.manageVolumes === false) {
    if (own.length) sched.note(`KaraFun n’a pas appliqué les réglages de « ${title} » et ne laisse pas ${bridge.username} personnaliser la chanson en cours : règle-la dans KaraFun.`, 'error');
    else {
      const left = commands.map(command => resetLabel(command, live)).join(', ');
      sched.note(`Le réglage du titre précédent est peut-être resté sur « ${left} » : KaraFun ne laisse pas l’application personnaliser la chanson en cours.`, 'error');
    }
    return;
  }
  const caught = new Set(), reset = new Set();
  for (const command of commands) {
    try {
      if (command.kind === 'pitch') bridge.setPitch(command.value);
      else if (command.kind === 'tempo') bridge.setTempo(command.value);
      else bridge.setTrackVolume(command.type, command.value);
      (command.neutral ? reset : caught).add(commandField(command));
    } catch (error) { appLog(`Réglage de « ${title} » non rattrapé : ${error.message}`); }
  }
  if (caught.size) journalEvent('song.settingsCaughtUp', { entryId, queueId, fields: [...caught] });
  if (reset.size) journalEvent('song.settingsReset', { entryId, queueId, fields: [...reset] });
}

// Titre ajouté directement dans KaraFun, tout juste chargé : mêmes valeurs
// neutres, complétées par ses propres options KaraFun, une seule fois. Un
// titre suivi qui cesse de l'être en cours de route (relance ⏮ : le suivi
// passe sur la copie) n'est pas concerné. Une Battle garde le réglage de
// KaraFun (le bar ne la règle pas en direct non plus).
function checkUntrackedSettings(loadedId) {
  if (tracked.some(tr => String(tr.queueId) === loadedId)) return;
  const live = liveFromStatus(bridge.status);
  const item = bridge.status?.current || bridge.status?.songPlaying;
  if (isBattleItem(item)) return;
  const options = bridge.queue?.find(row => String(row.queueId) === loadedId)?.options || item.options || null;
  const commands = catchUpCommands({ settings: null, live, tracksAvailable: live.tracks || songTracksOf(item), ranges: songRanges(),
    defaults: songDefaults(), neutral: startNeutral(loadedId, options) });
  applyStartCommands(commands, live, { title: item.title || 'le titre', entryId: null, queueId: item.queueId });
}

// KaraFun a répondu Error à un ajout qui portait des réglages : le titre
// n'est pas dans sa file. Il repart aussitôt sans eux (le pont ne les met
// plus à l'ajout) ; ils seront rattrapés au début du titre. Une seule fois.
function resendWithoutOptions(add) {
  if (!bridge?.ready) return;
  const same = (songId, singer) => Number(songId) === Number(add?.songId) && singer === add?.singer;
  try {
    if (pending && !pending.cancelled && !recoveredPending && pending.sentSettings && same(pending.sel.song.songId, pending.sel.label)) {
      delete pending.sentSettings;
      pending.at = Date.now();
      pending.attempts++;
      bridge.add(pending.sel.song.songId, pending.sel.label);
      sched.note(`KaraFun refuse les réglages de titre à l’ajout : « ${pending.sel.song.title} » repart sans eux ; ils seront appliqués au début du titre.`, 'error');
    } else if (restartOp?.phase === 'adding' && restartOp.sentSettings && same(restartOp.songId, restartOp.singer)) {
      restartOp.sentSettings = null;
      restartOp.at = Date.now();
      bridge.add(restartOp.songId, restartOp.singer, 1);
    } else return;
    saveNight();
  } catch (error) { appLog(`Nouvel envoi sans réglages impossible : ${error.message}`); }
}

// Piste réglée en direct : 'guide' (voix 1), 'backing', ou le type d'une
// autre voix guide (6, 7…) ; null si inconnue.
const liveTrackType = track => track === 'guide' ? TRACK.LEAD_A : track === 'backing' ? TRACK.BACKING
  : guideVoicesOf([typeof track === 'string' || typeof track === 'number' ? Number(track) : NaN])[0] ?? null;

// Titre en cours, réglé en direct par le bar (POST /api/staff/kf), visé par
// son `queueId`. Pour un titre de la file, la valeur est aussi gardée sur le
// titre : une relance ⏮ la reprend. Chaque voix guide se règle seule, en solo
// comme en duo.
function liveSongSetting(body) {
  if (!bridge?.ready) throw new Error('KaraFun est déconnecté. Reconnecte-le avant de régler le titre en cours.');
  const { current } = analyze();
  if (!current) throw new Error('Aucun titre en cours à régler.');
  const type = body.action === 'track' ? liveTrackType(body.track) : null;
  const field = body.action !== 'track' ? body.action : type === TRACK.BACKING ? 'backing' : type != null ? 'guide' : null;
  if (!field) throw new Error('Piste vocale inconnue.');
  // La page du bar vise le titre qu'elle affiche : s'il a changé entre-temps,
  // le réglage n'est ni envoyé ni gardé sur le nouveau titre.
  if (body.queueId != null && String(current.queueId) !== String(body.queueId)) throw new Error('Le titre a changé : réglage non envoyé.');
  const value = validateField(field, body.value, songRanges());
  const tr = tracked.find(item => isOnStage(item, current));
  const tracks = liveFromStatus(bridge.status)?.tracks || songTracksOf(current);
  if (field === 'guide' && tracks && !tracks.includes(type)) {
    throw new Error(type === TRACK.LEAD_A ? 'Ce titre n’a pas de voix guide.' : 'Ce titre n’a pas cette voix guide.');
  }
  if (field === 'backing' && tracks && !tracks.includes(TRACK.BACKING)) throw new Error('Ce titre n’a pas de chœurs.');
  // Page du bar d'avant les voix une à une (sans queueId) : sur un duo de la
  // file, sa voix guide règle aussi la voix 2, comme avant.
  const duoVoice = body.queueId == null && type === TRACK.LEAD_A && tr?.sel.ids.length > 1 &&
    (!tracks || tracks.includes(TRACK.LEAD_B));
  if (field === 'pitch') bridge.setPitch(value);
  else if (field === 'tempo') bridge.setTempo(value);
  else bridge.setTrackVolume(type, value);
  if (duoVoice) bridge.setTrackVolume(TRACK.LEAD_B, value);
  if (tr) {
    const next = { ...(tr.sel.song.settings || {}) };
    if (type != null && type !== TRACK.BACKING && type !== TRACK.LEAD_A) next.guideVoices = { ...next.guideVoices, [type]: value };
    else next[field] = value;
    if (duoVoice) next.guideVoices = { ...next.guideVoices, [TRACK.LEAD_B]: value };
    if ((field === 'pitch' || field === 'tempo') && value === 0) delete next[field]; // tonalité ou tempo d'origine
    sched.setSongSettings(tr.sel.song, Object.keys(next).length ? next : null);
    // Réglé en direct : rien à rattraper, même avant l'écho de KaraFun.
    tr.liveChecked = String(tr.queueId);
  }
  journalEvent('song.settings', { by: 'staff', where: 'live', personId: tr?.sel.ids[0] || null, entryId: tr?.sel.song.entryId || null,
    queueId: current.queueId ?? null, field: type == null ? field : trackField(type), value });
  return { ok: true, field: type == null ? field : trackField(type), value };
}

// Chœurs par défaut relevés sur le KaraFun du bar (KaraFunBridge
// observedDefaults) : gardés dans les réglages sauvegardés avec une empreinte
// du code KaraFun, jamais le code ; repris au redémarrage pour ce code
// seulement, au lieu d'être réappris de chœurs qu'un KaraFun « collant »
// garderait d'un titre réglé en direct. Une valeur provisoire (pas encore
// confirmée par une remise de KaraFun au chargement, jamais chez un KaraFun
// collant) est gardée comme telle : « Nouvelle soirée » l'oublie.
const karafunKey = code => crypto.createHash('sha256').update(`karafun:${code}`).digest('hex').slice(0, 16);
function rememberKaraFunDefaults() {
  const backing = bridge?.observedDefaults?.backing;
  if (!Number.isInteger(backing) || !bridge.code) return;
  const code = karafunKey(bridge.code), provisional = bridge.provisionalDefaults === true;
  const saved = settings.karafunDefaults;
  if (saved?.code === code && saved.backing === backing && (saved.provisional === true) === provisional) return;
  settings.karafunDefaults = provisional ? { code, backing, provisional } : { code, backing };
  saveNight();
}
function restoreKaraFunDefaults() {
  const saved = settings.karafunDefaults;
  if (bridge?.code && saved?.code === karafunKey(bridge.code)) bridge.restoreDefaults(saved);
}

// ------------------------------------------------------------------ synchronisation avec KaraFun
function sync() {
  // Une installation ne commande jamais KaraFun, même lors du contrôle de la
  // nouvelle image. L'agent hôte libère ce verrou après validation ou retour arrière.
  // L'écart entre deux titres en cours de mesure compterait cette attente.
  if (serverUpdate.isBusy()) {
    if (songGap) songGap.clean = false;
    return;
  }
  if (!bridge || !bridge.ready) {
    notePhase('unknown', 'offline');
    if (songGap) songGap.clean = false;
    return;
  }
  rememberKaraFunDefaults();
  if (settings.auto && bridge.permissions?.addToQueue === false) {
    settings.auto = false;
    permissionPause = true;
    sched.note(`KaraFun refuse l’ajout de titres pour ${bridge.username || 'FileKaraoke'} : redonne-lui le rôle administrateur dans KaraFun Pro. L’envoi reprendra seul ensuite.`, 'error');
  } else if (permissionPause && bridge.permissions && bridge.permissions.addToQueue !== false) {
    permissionPause = false;
    if (!recoveredPending && !persistenceError) {
      settings.auto = true;
      sched.note('Droits KaraFun retrouvés : envoi automatique réactivé.', 'staff');
    }
  }
  const { current, upcoming, q } = analyze();
  const qids = new Set(q.map(it => it.queueId));
  const now = Date.now();
  // Un titre a démarré, quel que soit le lancement (bar, KaraFun, Battle) :
  // la lecture automatique suspendue en fin de file se rétablit.
  if (current && settings.autoPlayHeld) releaseAutoPlay();
  syncBattle({ current, upcoming, q }, now);
  if (q.length) { hadNativeQueue = true; emptySince = null; }
  else if (hadNativeQueue && emptySince === null) emptySince = now;

  if (pending) {
    const matches = q.filter(it => !pending.before.has(it.queueId) && Number(it.songId) === pending.sel.song.songId && it.singer === pending.sel.label);
    const hit = recoveredPending && matches.length !== 1 ? null : matches[0];
    if (hit) {
      if (pending.cancelled) {
        if (isOnStage({ queueId: hit.queueId, sel: pending.sel }, current)) {
          // L'accusé et le début de lecture peuvent arriver dans le même
          // événement. Ne pas arrêter un morceau déjà sur scène. Envoi de la
          // soirée close : il ne compte pas dans la nouvelle.
          if (!pending.previousEvening) {
            sched.commit(pending.sel);
            journalTurnSent(pending, hit.queueId, now);
            if (settings.queueClearPending || pending.cancelledByClear) dropClearedTickets(pending.sel);
          }
          tracked.push({ queueId: hit.queueId, sel: pending.sel, addedAt: now, startedAt: now,
            ...(pending.sentSettings ? { sentSettings: pending.sentSettings } : {}) });
          sched.recordStage(pending.sel, now);
          sched.note(`« ${pending.sel.song.title} » a commencé sur scène pendant le retrait ; elle continue.`, 'stage');
        } else {
          // Suivi sans commit() : s'il passe malgré tout sur scène, le
          // passage sera compté à ce moment-là (plus bas).
          tracked.push({ queueId: hit.queueId, sel: pending.sel,
            addedAt: now, startedAt: null, cancelled: true, removeRequestedAt: now,
            ...(pending.previousEvening ? {} : { uncommitted: true }),
            ...(pending.cancelledByClear ? { cancelledByClear: true } : {}) });
          try { bridge.remove(hit.queueId); }
          catch (error) { appLog(`Retrait KaraFun en attente : ${error.message}`); }
          sched.note(`« ${pending.sel.song.title} » retirée de KaraFun après le départ du chanteur`, 'staff');
        }
      } else {
        sched.commit(pending.sel);
        journalTurnSent(pending, hit.queueId, now);
        const sent = { queueId: hit.queueId, sel: pending.sel, addedAt: Date.now(), startedAt: null,
          ...(pending.sentSettings ? { sentSettings: pending.sentSettings } : {}),
          // Réglé pendant l'envoi : appliqué dès maintenant (boucle plus bas).
          ...(pending.settingsChanged ? { settingsDirty: true } : {}) };
        tracked.push(sent);
        appLog(`Envoyé à KaraFun : ${pending.sel.label} — ${pending.sel.song.title} (queueId ${hit.queueId})`);
        // Duo improvisé noté pendant l'envoi : ce titre repassera plus tard.
        if (pending.pullOnAck && !isOnStage(sent, current)) {
          try { pullFromKaraFun(sent, pending.pullOnAck); }
          catch (error) { sched.note(`Retrait KaraFun à vérifier : ${error.message}`, 'error'); }
        }
      }
      pending = null;
      recoveredPending = false;
    } else if (!recoveredPending && now - pending.at > 15000) {
      // Une réponse manquante ne prouve pas que KaraFun a refusé l'ajout.
      // Le renvoyer créerait un doublon si la première commande arrive tard.
      recoveredPending = true;
      journalEvent('send.unconfirmed', { entryId: pending.sel.song.entryId || null, ids: pending.sel.ids });
      sched.note(`KaraFun n'a pas confirmé « ${pending.sel.song.title} » (${shownLabel(pending.sel)}). Vérifie sa file avant de reprendre l'envoi automatique.`, 'error');
      appLog('Ajout KaraFun sans confirmation : envoi automatique suspendu, aucune seconde commande envoyée.');
    }
  }

  syncRestart({ current, upcoming, q }, now);

  // Une remise à zéro peut avoir été demandée pendant une déconnexion. Au
  // retour de KaraFun, retirer aussi les titres ajoutés hors de cette page.
  // Leur queueId n'est connu qu'après un QueueEvent frais.
  if (settings.queueClearPending) {
    const known = new Set(tracked.map(tr => String(tr.queueId)));
    for (const item of upcoming) {
      const queueId = String(item.queueId);
      if (known.has(queueId) || now - (queueClearRemovalRequests.get(queueId) || 0) < 20000) continue;
      try { bridge.remove(item.queueId); queueClearRemovalRequests.set(queueId, now); }
      catch (error) { appLog(`Retrait KaraFun en attente : ${error.message}`); }
    }
    const stillUpcoming = new Set(upcoming.map(item => String(item.queueId)));
    for (const queueId of queueClearRemovalRequests.keys()) {
      if (!stillUpcoming.has(queueId)) queueClearRemovalRequests.delete(queueId);
    }
  }

  // Fermeture : un titre retiré qui tient de nouveau avant l'heure (heure
  // décalée, chanson plus courte) reste dans KaraFun. Décidé avant les
  // renvois de retrait et les alertes, avec la même estimation que le
  // retrait plus bas. Un retrait déjà envoyé peut encore aboutir : le titre
  // retourne alors au chanteur. Plus tard, c'est un choix du bar dans KaraFun.
  upcoming.forEach((item, ahead) => {
    const tr = tracked.find(x => String(x.queueId) === String(item.queueId));
    if (tr?.pulled?.reason !== 'closing' || tr.cancelled || closingBlocksStart(current, ahead, now)) return;
    tr.unpulled = { reason: tr.pulled.reason, at: now };
    tr.pulled = null;
    tr.removeRequestedAt = 0;
  });
  // Titre chargé par KaraFun (état 3, avant la musique) : ses réglages
  // peuvent déjà être rattrapés.
  const loadedId = loadedQueueId();
  const freshLoad = noteLoadedLive(loadedId);
  for (const tr of tracked.slice()) {
    const onStage = isOnStage(tr, current);
    // Si KaraFun était déconnecté lors du vidage, ce titre pouvait déjà être
    // sur scène. Ne jamais interrompre la chanson effectivement en lecture,
    // même après « Arrêter le vidage » ou une nouvelle soirée : le repère
    // reste sur le titre quand le vidage lui-même est terminé.
    if (tr.cancelled && onStage && (settings.queueClearPending || tr.cancelledByClear)) {
      tr.cancelled = false;
      delete tr.cancelledByClear;
      // Accusé tardif d'un envoi annulé, lancé quand même : il compte comme
      // passage, comme l'accusé arrivé directement sur scène.
      if (tr.uncommitted) {
        delete tr.uncommitted;
        sched.commit(tr.sel);
        journalTurnSent({ sel: tr.sel, at: tr.addedAt }, tr.queueId, now);
        dropClearedTickets(tr.sel);
      }
    }
    if ((tr.cancelled || tr.pulled) && qids.has(tr.queueId) && !onStage &&
        now - (tr.removeRequestedAt || 0) >= 20000) {
      tr.removeRequestedAt = now;
      try { bridge.remove(tr.queueId); }
      catch (error) { appLog(`Retrait KaraFun en attente : ${error.message}`); }
    }
    if (onStage && tr.pulled) {
      // KaraFun a lancé le titre avant de le retirer : il est chanté maintenant.
      // Une priorité du bar passe alors juste après lui, comme sans retrait.
      sched.dropDeferral(tr.sel.ids[0], tr.sel.song.entryId);
      const forP = tr.pulled.reason === 'priority' ? sched.people.get(tr.pulled.forId || '') : null;
      sched.note(`« ${tr.sel.song.title} » a commencé avant son retrait de KaraFun ; il continue${forP ? `, ${forP.name} passe juste après` : ''}.`, 'stage');
      tr.pulled = null;
    } else if (tr.pulled && qids.has(tr.queueId) && !tr.pulled.alerted && now - tr.pulled.at >= PULL_ALERT_MS) {
      // Retrait ignoré : rien d'autre ne part tant que ce titre attend en tête.
      tr.pulled.alerted = true;
      const forP = tr.pulled.reason === 'priority' ? sched.people.get(tr.pulled.forId || '') : null;
      sched.note(tr.pulled.reason === 'closing' ?
        `KaraFun n’a pas retiré « ${tr.sel.song.title} » (${shownLabel(tr.sel)}), qui passerait après la fermeture : retire-le dans KaraFun. Il ne sera pas lancé automatiquement tant qu’il passerait après l’heure.` :
        forP ? `KaraFun n’a pas retiré « ${tr.sel.song.title} » (${shownLabel(tr.sel)}) pour la priorité de ${forP.name} : retire-le dans KaraFun, ou lance-le ; ${forP.name} passera juste après lui.` :
        `KaraFun n’a pas retiré « ${tr.sel.song.title} » (${shownLabel(tr.sel)}) : retire-le dans KaraFun, ou lance-le si ${passageNames(tr.sel)} est prêt.`, 'error');
    }
    if (onStage && !tr.startedAt) {
      tr.startedAt = Date.now();
      sched.recordStage(tr.sel, tr.startedAt);
      sched.note(`Sur scène : ${shownLabel(tr.sel)} — « ${tr.sel.song.title} »`, 'stage');
    }
    const usable = !tr.cancelled && !tr.pulled && !tr.absent;
    // Réglé pendant l'envoi, ou KaraFun revenu : les options du titre de
    // KaraFun d'abord, tant qu'il n'a pas commencé (même déjà chargé).
    if (usable && tr.settingsDirty && !tr.startedAt) pushQueueItemSettings(tr);
    if (usable && (onStage || loadedId === String(tr.queueId))) catchUpSongSettings(tr);
    // QueueEvent et StatusEvent ne sont pas atomiques. Quand l'ancienne chanson
    // est encore dans status.current, attendre le second message avant de
    // conclure qu'elle a disparu (notamment après le bouton Suivant natif).
    const statusId = bridge.status && (bridge.status.current || bridge.status.songPlaying || {}).queueId;
    if (!qids.has(tr.queueId) && !onStage && statusId !== tr.queueId) {
      if (!tr.startedAt) {
        journalEvent('turn.unsent', { entryId: tr.sel.song.entryId || null, ids: tr.sel.ids, queueId: tr.queueId,
          reason: tr.cancelled ? 'cancelled' : tr.absent ? 'absent' : tr.pulled ? `pulled-${tr.pulled.reason}` :
            tr.unpulled && now - tr.unpulled.at < PULL_LATE_MS ? `pulled-${tr.unpulled.reason}` : 'skipped-in-karafun' });
      }
      if (tr.cancelled) {
        // Un accusé tardif d'un envoi annulé peut avoir été suivi sans
        // `commit()` : il n'a alors aucun crédit à rendre.
        if (!tr.startedAt && tr.sel.turnCredit) sched.rollbackUnplayed(tr.sel);
        sched.note(`Retrait KaraFun confirmé : « ${tr.sel.song.title} »`, 'staff');
      }
      else if (tr.startedAt) {
        sched.recordSlot((Date.now() - tr.startedAt) / 1000);
        sched.songEnded(tr.sel.ids);
        sched.endStage(tr.sel);
      }
      else if (tr.absent) restore(tr, 'retirée (absent à l\'appel)');
      // Retrait de fermeture annulé, mais déjà envoyé à KaraFun : il aboutit.
      else if (tr.pulled || (tr.unpulled && now - tr.unpulled.at < PULL_LATE_MS)) restorePulled(tr);
      else {
        sched.rollbackUnplayed(tr.sel, { requeue: true });
        sched.note(`« ${tr.sel.song.title} » (${shownLabel(tr.sel)}) a été passée dans KaraFun avant la lecture : elle ne sera pas renvoyée automatiquement`, 'skip');
      }
      tracked = tracked.filter(x => x !== tr);
      sched.version++;
    }
  }
  if (freshLoad) checkUntrackedSettings(loadedId);

  // Le même événement QueueEvent peut confirmer un solo promis puis libérer
  // immédiatement la place pour la Battle, ou confirmer le premier titre
  // après Battle. Éviter d'attendre le prochain balayage de deux secondes.
  syncBattle({ current, upcoming, q }, now);

  if (settings.queueClearPending && !upcoming.length && !pending &&
      !tracked.some(tr => tr.cancelled && !isOnStage(tr, current))) {
    settings.queueClearPending = false;
    queueClearRemovalRequests.clear();
    sched.note('File vidée dans KaraFun : les nouveaux choix peuvent être envoyés.', 'staff');
  }

  const key = stageKey(current);
  if (key !== curKey) {
    if (curKey !== null) journalEvent('stage.ended', { queueId: curQueueId, playedSec: Math.round((now - curSince) / 1000) });
    measureSongGap(curKey !== null && !curBattle, current, now);
    curKey = key; curSince = Date.now();
    curQueueId = current?.queueId ?? null;
    curBattle = !!current && isBattleItem(current);
    // Une relance n'est pas un nouveau passage du titre.
    if (current && String(current.queueId) !== lastRestartCopy) {
      sched.recordPlayed(current, curSince);
      journalStageStarted(current);
    } else if (current) journalEvent('stage.restarted', { queueId: current.queueId ?? null });
  }
  syncStageClock(current, key, now);
  // Dès qu'un titre est sur scène, le nom annoncé pour le passage suivant
  // reste fixe. L'envoi physique à KaraFun peut attendre le délai configuré.
  if (!upcoming.length && !pending && !settings.queueClearPending && !battleHoldsQueue()) {
    if (sched.opts.requirePresence) {
      const onStage = tracked.find(tr => isOnStage(tr, current));
      sched.reservePresenceNext(onStage?.sel.ids || []);
    } else if (current) sched.reserveNext();
  }
  let presence = presenceCandidate({ current, upcoming });
  if (skipAbsentIfDue({ current, upcoming }, presence, presenceMissing(presence), now)) {
    const onStage = tracked.find(tr => isOnStage(tr, current));
    sched.reservePresenceNext(onStage?.sel.ids || []);
    presence = presenceCandidate({ current, upcoming });
  }
  const missingNow = presenceMissing(presence);
  const awaitingPresence = missingNow.length > 0;
  const askKey = awaitingPresence ? `${presence.ids.join('+')}|${presence.song?.entryId || ''}` : null;
  if (askKey !== presenceAskKey) {
    presenceAskKey = askKey;
    if (askKey) journalEvent('presence.asked', { personIds: missingNow, entryId: presence.song?.entryId || null, source: presence.source });
  }
  const canPush = !current || Date.now() - curSince >= settings.pushDelaySec * 1000;
  // Heure de fermeture : nos titres déjà chargés qui commenceraient après
  // sont retirés de KaraFun (ils reviennent s'ils tiennent de nouveau avant
  // l'heure), et rien d'autre n'est envoyé. Le titre en cours finit normalement.
  upcoming.forEach((item, ahead) => {
    const tr = tracked.find(x => String(x.queueId) === String(item.queueId));
    if (!tr || tr.cancelled || tr.pulled || tr.absent || tr.startedAt || !closingBlocksStart(current, ahead, now)) return;
    try {
      pullFromKaraFun(tr, 'closing'); noteClosingStop();
      // Le titre revient dans la liste de son auteur : l'invitée d'un duo
      // l'apprend avec le nom de l'auteur.
      const [ownerId, ...guests] = tr.sel.ids;
      sched.notify(ownerId, 'closingPulled', { title: tr.sel.song.title });
      const ownerName = sched.people.get(ownerId)?.name || tr.sel.names?.[0] || '';
      for (const pid of guests) sched.notify(pid, 'closingPulled', { title: tr.sel.song.title, name: ownerName });
    }
    catch (error) { appLog(`Retrait KaraFun (fermeture) en attente : ${error.message}`); }
  });
  const closingHold = closingBlocksStart(current, upcoming.length, now);
  if (closingHold && settings.auto && !pending && sched.readyView().some(turn => turn.song)) noteClosingStop();
  const staleTracked = tracked.some(tr => !qids.has(tr.queueId));
  const emptySettled = emptySince === null || now - emptySince >= 1000;
  if (settings.auto && !settings.queueClearPending && !battleHoldsQueue() && !recoveredPending && !awaitingPresence &&
      !restartOp && bridge.ready && !staleTracked && upcoming.length === 0 && canPush && emptySettled && !closingHold) {
    if (!pending) {
      // Après un échec, la chanson du chanteur peut avoir changé : le choix
      // actuel de l'ordonnanceur prévaut au moment de la nouvelle tentative.
      const sel = sched.select({ stageFree: !current });
      if (sel) {
        pending = { sel, before: qids, at: now, attempts: 1, retryAt: null };
        try {
          // La commande distante n'a pas d'accusé immédiat : conserver la
          // tentative sur disque avant de l'envoyer pour éviter un doublon.
          saveNight({ required: true });
          // Réglages du titre dans les options d'ajout (chaque voix guide la sienne).
          const sentSettings = bridge.add(sel.song.songId, sel.label, undefined, sel.song.settings || null);
          if (sentSettings) pending.sentSettings = sentSettings;
        } catch (e) { pending = null; settings.auto = false; appLog(`ERREUR envoi : ${e.message}`); }
      } else pending = null;
    }
  }

  // Lancement automatique si KaraFun est à l'arrêt avec une chanson prête
  if (!current && upcoming.length && bridge.ready) {
    const first = upcoming[0];
    const firstQueueId = first.queueId == null ? null : String(first.queueId);
    if (idleQueueId !== firstQueueId) { idleQueueId = firstQueueId; idleSince = Date.now(); }
    else if (!idleSince) idleSince = Date.now();
    const owner = firstQueueId === null ? null : tracked.find(tr => String(tr.queueId) === firstQueueId);
    const present = owner && !owner.cancelled && !owner.pulled && !owner.absent && (owner.sel.ids.every(pid => sched.people.has(pid)) &&
      (!sched.opts.requirePresence || owner.sel.presenceConfirmed || sched.confirmedForTurn(owner.sel.ids)));
    if (settings.autoPlay && !settings.queueClearPending &&
        (!battleVote.automation || battleVote.automation.status === 'released' ||
          (battleVote.automation.status === 'waiting' && !isBattleItem(upcoming[0]))) &&
        present && Date.now() - idleSince >= settings.playDelaySec * 1000) {
      if (closingBlocksStart(null)) noteClosingStop();
      else {
        idleSince = Date.now() + 20000;
        playKaraFun({ queueId: firstQueueId }).then(played => { if (!played) idleSince = null; })
          .catch(error => appLog(`Lancement automatique impossible : ${error.message}`));
      }
    }
  } else { idleSince = null; idleQueueId = null; }
  const blocker = journalOutlook({ current, upcoming, awaitingPresence }, now);
  if (songGap && !SONG_GAP_BLOCKERS.has(blocker)) songGap.clean = false;
  saveNight();
}

// Écart entre deux titres (heures estimées, heure de fermeture) : de la fin
// d'un titre au début du suivant, quand un titre attendait. Il commence quand
// un titre (pas une Battle) quitte la scène et finit au début du suivant (ni
// une Battle ni la copie d'une relance). Il n'est pas gardé si autre chose
// que le lancement du titre suivant a retenu la scène entre-temps (file vide,
// fermeture, Battle, envoi coupé, vidage, relance : SONG_GAP_BLOCKERS), si
// KaraFun s'est déconnecté, ou s'il dépasse une minute (Scheduler#recordSongGap).
// Il n'est pas sauvegardé : un arrêt de l'application l'oublie. Un titre qui
// en remplace un autre sans scène libre vue entre les deux n'est pas mesuré.
function measureSongGap(songEnded, current, now) {
  if (songGap?.clean && current && !isBattleItem(current) && String(current.queueId) !== lastRestartCopy) {
    sched.recordSongGap((now - songGap.since) / 1000);
  }
  songGap = songEnded && !current ? { since: now, clean: true } : null;
}
// Causes d'une scène libre (journalOutlook) qui laissent mesurer l'écart :
// lancement du titre suivant, « Je suis là » attendu, envoi à KaraFun,
// lecture lancée par le bar ou par KaraFun lui-même.
const SONG_GAP_BLOCKERS = new Set(['loading', 'awaiting-presence', 'sending', 'push-delay', 'autoplay-off']);

// ------------------------------------------------------------------ barre de lecture
const stageKey = current => current ? String(current.queueId != null ? current.queueId : `${current.songId}|${current.title}`) : null;

// Départ : début de notre titre sur scène (sauvegardé, remis à l'heure par
// une relance), sinon son apparition sur scène. Pauses et tempo de KaraFun
// pris à chaque balayage. KaraFun déconnecté (sync() s'arrête avant) :
// l'horloge attend son retour.
function syncStageClock(current, key, now) {
  if (!current) {
    // KaraFun annonce un autre état (titre fini, suivant en chargement).
    if (bridge.status?.state) stageClock = null;
    return;
  }
  if (stageClock?.key !== key) {
    const tr = tracked.find(item => isOnStage(item, current));
    stageClock = stageProgress.startClock(key, tr?.startedAt || curSince || now);
  }
  stageProgress.observeClock(stageClock, now, { paused: stageProgress.pausedOf(bridge.status),
    rate: stageProgress.rateOf(liveFromStatus(bridge.status)?.tempo), position: stageProgress.protocolPosition(bridge.status) });
}

// Durée du titre sur scène : démo, catalogue, puis téléphone (bornée).
// Une Battle n'a pas de durée sûre (phase d'inscription, chanteurs alternés).
// `trustedOnly` : sans la durée envoyée par un téléphone (décisions de
// fermeture). `fromStart` : titre tout juste monté sur scène, horloge pas
// encore relevée dans ce passage de sync() : position comptée depuis son début.
function stageProgressView(current, kind, now, { trustedOnly = false, fromStart = false } = {}) {
  const tr = tracked.find(item => isOnStage(item, current));
  const synced = stageClock && stageClock.key === stageKey(current);
  if (!synced && !fromStart) return null;
  // Horloge provisoire lue comme syncStageClock le fera (pause, tempo,
  // position) : la décision de fermeture ne change pas une fois relevée.
  const clock = synced ? stageClock : stageProgress.startClock(stageKey(current), tr?.startedAt || now);
  if (!synced) stageProgress.observeClock(clock, now, { paused: stageProgress.pausedOf(bridge.status),
    rate: stageProgress.rateOf(liveFromStatus(bridge.status)?.tempo), position: stageProgress.protocolPosition(bridge.status) });
  const durationSec = kind === 'battle' ? null : stageProgress.stageDuration({ demoSec: fake ? SONG_SECONDS : null,
    catalogSec: catalogDurations.get(Number(tr?.sel.song.songId ?? current.songId)),
    clientSec: trustedOnly ? null : tr?.sel.song.duration });
  return stageProgress.clockView(clock, now, durationSec);
}

// ------------------------------------------------------------------ journal de soirée
function journalTurnSent(sent, queueId, now) {
  const sel = sent.sel;
  journalEvent('turn.sent', { entryId: sel.song.entryId || null, ids: sel.ids, ownerId: sel.ids[0], kind: sel.kind || null,
    queueId, sentAt: sent.at, ackMs: Math.max(0, now - sent.at), newRound: !!(sel.roundResets || sel.newPersonRound),
    presenceConfirmed: !!sel.presenceConfirmed, deferralReleased: !!sel.deferralReleasedTo });
  journalSample(now);
}

function journalStageStarted(current) {
  const tr = tracked.find(item => isOnStage(item, current));
  const duration = Number(tr?.sel.song.duration ?? current.duration);
  journalEvent('stage.started', { queueId: current.queueId ?? null, songId: Number(current.songId) || null,
    title: tr?.sel.song.title || current.title || '', artist: tr?.sel.song.artist || current.artist || '',
    durationSec: duration > 0 ? duration : null,
    source: tr ? 'queue' : isBattleItem(current) ? 'battle' : 'native',
    ...(tr ? { entryId: tr.sel.song.entryId || null, ids: tr.sel.ids, ownerId: tr.sel.ids[0], kind: tr.sel.kind || null } : {}) });
}

// Ce qui retient la soirée quand rien ne joue (cause des temps morts).
function notePhase(phase, blocker = null) {
  const key = `${phase}|${blocker || ''}`;
  if (key === phaseKey) return;
  phaseKey = key;
  journalEvent('karaoke.phase', { phase, blocker });
}

function readyTurns() {
  return sched.presenceView().filter(turn => !turn.future && turn.song);
}

function journalOutlook({ current, upcoming, awaitingPresence }, now) {
  let blocker = null;
  if (!current) {
    const head = upcoming[0] && tracked.find(tr => String(tr.queueId) === String(upcoming[0].queueId));
    if (settings.queueClearPending) blocker = 'queue-clear';
    else if (restartOp) blocker = 'restart';
    else if (closingBlocksStart(null, 0, now)) blocker = 'closing';
    else if (recoveredPending) blocker = 'recovered-pending';
    else if (permissionPause) blocker = 'permission';
    else if (battleHoldsQueue()) blocker = 'battle-hold';
    else if (upcoming.length) {
      blocker = settings.autoPlayHeld ? 'autoplay-held' : !settings.autoPlay ? 'autoplay-off' :
        head && sched.opts.requirePresence && !head.sel.presenceConfirmed && !sched.confirmedForTurn(head.sel.ids) ? 'awaiting-presence' : 'loading';
    } else if (pending) blocker = 'sending';
    else if (awaitingPresence) blocker = 'awaiting-presence';
    else if (readyTurns().length) blocker = settings.auto ? 'push-delay' : 'auto-off';
    else blocker = 'empty';
  }
  notePhase(current ? 'singing' : blocker === 'empty' ? 'silent' : 'between', blocker);
  if (now - lastSampleAt >= 5 * 60000) journalSample(now);
  return blocker;
}

// Relevé de la file : titres prêts, demandes et personnes présentes.
function journalSample(now = Date.now()) {
  lastSampleAt = now;
  // Présentes : ni parties, ni places « Solo N » encore sans prénom.
  const active = [...sched.people.values()].filter(countsAsPresent);
  journalEvent('queue.sample', { ready: readyTurns().length,
    songsListed: active.reduce((n, p) => n + sched.songsOf(p).length, 0),
    demanding: active.filter(p => sched.songsOf(p).length).length,
    // « Pas prêt » seulement, pas un titre retiré pour une priorité du bar.
    deferred: sched._deferredOwners().filter(pid => !sched.people.get(pid).deferral.afterPriority).length, present: active.length, inKaraFun: tracked.filter(tr => !tr.startedAt).length });
}

// Personne présente pour les comptes (relevé du journal, tuile du bar, effectif
// de la page) : pas marquée partie, et déjà un prénom (une place « Solo N »
// ouverte par un QR n'est encore personne).
function countsAsPresent(p) {
  return !p.withdrawnAt && !p.nameRequired;
}

// Dernier signe de vie d'un téléphone : au plus un par personne toutes les 5 min.
function noteSeen(person, now = Date.now()) {
  if (!person || person.nameRequired || now - (seenJournal.get(person.id) || 0) < 5 * 60000) return;
  seenJournal.set(person.id, now);
  journalEvent('person.seen', { personId: person.id });
}

// Clôture de la soirée : résumé écrit avant la remise à zéro.
function closeEvening(by, fields = {}) {
  return journal.close({ by, fields, summarize: ({ meta, events }) => computeStats({ meta, events, now: Date.now() }) });
}

// Données affichées par la page des statistiques : prénoms résolus au bar.
function eveningData(param) {
  const id = !param || param === 'current' ? journal.id : String(param);
  if (!id || (id !== journal.id && !validEveningId(id))) return null;
  return journal.read(id);
}

function statsView(saved) {
  const live = !!saved.current;
  const stats = computeStats({ meta: saved.meta, events: saved.events, now: Date.now(), live });
  const people = {}, tables = {};
  for (const [id, row] of Object.entries(saved.meta.roster || {})) people[id] = row.name || '?';
  for (const [id, row] of Object.entries(saved.meta.tables || {})) tables[id] = row.name || id;
  const nameOf = id => people[id] || 'Inconnu';
  const tableName = id => tables[id] || (/^\d+$/.test(String(id)) ? `Table ${id}` : String(id));
  return { evening: { id: saved.meta.eveningId, startedAt: stats.evening.startedAt, endedAt: stats.evening.endedAt, current: live,
    truncated: !!saved.truncated }, names: { people, tables }, stats, insights: insights(stats, { nameOf, tableName }),
    generatedAt: Date.now(), journalError: live ? journal.lastError : null };
}

function statsRoute(p, u, req, res) {
  if (!isStaff(req, u)) return send(res, 403, p === '/stats' ? 'Réservé au bar' : { error: 'Réservé au bar' },
    p === '/stats' ? 'text/plain; charset=utf-8' : undefined);
  if (p === '/stats') return sendFile(res, 'stats.html', 'text/html; charset=utf-8');
  if (p === '/api/staff/stats/evenings') return send(res, 200, { current: journal.id, evenings: journal.list() });
  const saved = eveningData(u.searchParams.get('evening'));
  if (!saved) return send(res, 404, { error: 'Soirée introuvable.' });
  if (p === '/api/staff/stats') return send(res, 200, statsView(saved));
  const names = u.searchParams.get('names') === '1';
  const data = exportEvening({ meta: saved.meta, events: saved.events, now: Date.now(), live: !!saved.current, names, app: BUILD });
  return send(res, 200, JSON.stringify(data, null, 1), 'application/json; charset=utf-8',
    { 'Content-Disposition': `attachment; filename="soiree-${saved.meta.eveningId}${names ? '-prenoms' : ''}.json"` });
}

// ------------------------------------------------------------------ duo improvisé noté au bar
// Passage visé par le bar : titre suivi dans KaraFun (`queueId`), ou entrée
// des derniers passages (`stageEntryId`), qui garde le reçu après la chanson.
function staffDuoTarget(body, missing = 'Passage introuvable : il a peut-être déjà été effacé des derniers passages.') {
  if (body.stageEntryId != null && body.stageEntryId !== '') {
    const entry = sched.stageHistory.find(item => String(item.id) === String(body.stageEntryId));
    if (!entry) throw new Error(missing);
    const tr = entry.endedAt || !entry.entryId ? null : tracked.find(item => item.sel.song?.entryId === entry.entryId) || null;
    return { tr, entry };
  }
  const tr = tracked.find(item => String(item.queueId) === String(body.queueId));
  if (!tr) throw new Error(missing);
  const entryId = tr.sel.song?.entryId;
  const entry = entryId ? [...sched.stageHistory].reverse().find(item => !item.endedAt && item.entryId === entryId) || null : null;
  return { tr, entry };
}
const staffDuoRecord = target => target.tr?.sel.staffDuo || target.entry?.staffDuo || null;

// L'invité a rechanté (ou un autre de ses titres est parti dans KaraFun)
// depuis le duo : son tour a déjà été recompté, l'annulation n'est plus juste.
function staffDuoTooLate(record) {
  const pid = record.partnerId;
  const pulled = new Set((record.pulled || []).map(item => item.entryId).filter(Boolean));
  const sangAgain = sched.stageHistory.some(item => item.at >= record.at && item.entryId !== record.entryId &&
    item.ids.includes(pid));
  const sentAgain = tracked.some(item => !item.cancelled && item.sel.ids.includes(pid) && (item.addedAt || 0) >= record.at &&
    item.sel.song?.entryId !== record.entryId && !pulled.has(item.sel.song?.entryId));
  return sangAgain || sentAgain ? `Trop tard : ${sched.people.get(pid)?.name || 'ce chanteur'} a déjà rechanté` : null;
}

// Défait le duo noté : crédits, passage, derniers passages et titres de
// l'invité retirés de KaraFun (gardés s'ils y sont encore). Renvoie la
// phrase à ajouter au message du bar.
function undoStaffDuo(target, record) {
  const partner = sched.people.get(record.partnerId);
  sched.staffUncountPartner(record, target.tr?.sel || null, tracked.map(item => item.sel));
  if (target.tr) {
    const sel = target.tr.sel;
    const index = sel.ids.indexOf(record.partnerId);
    if (index > 0) { sel.ids.splice(index, 1); sel.names.splice(index, 1); }
    sel.kind = record.kindBefore || 'solo';
    if (record.labelBefore) sel.label = record.labelBefore;
  }
  if (target.entry) {
    sched.setStagePeople(target.entry, target.entry.ids.filter(pid => pid !== record.partnerId), record.kindBefore || 'solo');
    delete target.entry.staffDuo;
  }
  const inKaraFun = new Set(analyze().upcoming.map(item => String(item.queueId)));
  const kept = [], back = [];
  for (const item of record.pulled || []) {
    const tr = item.entryId ? tracked.find(x => x.sel.song?.entryId === item.entryId) : null;
    if (tr?.pulled?.reason === 'duo' && inKaraFun.has(String(tr.queueId))) {
      tr.unpulled = { reason: 'duo', at: Date.now() };
      tr.pulled = null;
      tr.removeRequestedAt = 0;
      kept.push(item.title);
    } else if (!tr && pending?.pullOnAck === 'duo' && pending.sel.song?.entryId === item.entryId) {
      delete pending.pullOnAck;
      kept.push(item.title);
    } else if (!tr || tr.pulled) back.push(item.title);
  }
  const name = partner?.name || 'ce chanteur';
  const list = titles => titles.map(title => `« ${title} »`).join(', ');
  return (kept.length ? ` ${list(kept)} de ${name} reste dans KaraFun.` : '') +
    (back.length ? ` ${list(back)} est de nouveau en tête de la liste de ${name}.` : '');
}

// Pour la page du bar : partenaire noté et annulation encore possible.
function staffDuoView(record) {
  if (!record) return null;
  const late = staffDuoTooLate(record);
  return { partnerId: record.partnerId, partnerName: sched.people.get(record.partnerId)?.name || '?',
    at: record.at, canUndo: !late, reason: late };
}

// ------------------------------------------------------------------ vues
const fmtSong = (s) => s ? { entryId: s.entryId || null, songId: s.songId, title: s.title, artist: s.artist, img: coverUrl(s.img), duration: s.duration || null,
  settings: s.settings || null,
  // Duo ouvert (« Qui veut chanter en duo avec moi ? ») : pas encore de partenaire.
  duet: s.duet?.state === 'open' ? { state: 'open', kind: 'duo' } :
    s.duet ? { partnerName: sched.people.get(s.duet.partnerId)?.name || 'Un chanteur', state: s.duet.state, kind: s.duet.kind || 'duo',
    // Invitation en attente : vue ou non sur le téléphone de l'invité.
    ...(s.duet.state === 'pending' ? { seen: !!s.duet.seenAt } : {}) } : null } : null;

// Nom affiché d'un passage suivi : recalculé à partir de ses personnes
// (Scheduler#passageLabel), jamais repris du texte enregistré, si bien
// qu'une soirée commencée avant la mise à jour s'affiche au nouveau format.
// `sel.label` reste le nom envoyé à KaraFun : il sert seulement à y
// reconnaître le titre. Une personne qui n'est plus dans la soirée : le texte
// enregistré, sans le groupe individuel.
function shownLabel(sel) {
  const ids = Array.isArray(sel?.ids) ? sel.ids : [];
  if (ids.length && ids.every(pid => sched.people.has(String(pid)))) return sched.passageLabel(ids);
  return withoutSoloGroup(sel?.label || '');
}
// Prénoms d'un passage envoyé : ceux d'aujourd'hui (prénom changé, soliste
// homonyme numéroté à la reprise), sinon ceux notés à l'envoi.
function passageNames(sel) {
  return (sel?.ids || []).map((pid, i) => sched.people.get(String(pid))?.name || sel.names?.[i]).filter(Boolean).join(' & ');
}

// Ligne de KaraFun que l'application ne suit pas (ajoutée à la main, ou
// envoyée avant la mise à jour puis perdue) : le nom du groupe individuel
// (« Léa · En solo », « Léa & Max · En solo + Table 4 ») est retiré à
// l'affichage. Le nom actuel du groupe compte, et son nom par défaut.
function withoutSoloGroup(singer) {
  const text = String(singer || '');
  const cut = text.lastIndexOf(' · ');
  if (cut < 0) return text;
  const solo = new Set(['En solo', ...[...sched.tables.values()].filter(t => t.individual).map(t => t.name)]);
  const parts = text.slice(cut + 3).split(' + ');
  const kept = parts.filter(part => !solo.has(part.trim()));
  if (kept.length === parts.length) return text;
  return kept.length ? `${text.slice(0, cut)} · ${kept.join(' + ')}` : text.slice(0, cut);
}

// Chanteurs d'un passage avec leur table (`individual` : groupe des
// solistes, dont le nom ne s'affiche jamais à côté d'un prénom).
function singersOf(ids = []) {
  return ids.map(pid => sched.people.get(pid)).filter(Boolean).map(p => {
    const table = sched.table(p.tableId, false);
    return { id: p.id, name: p.name, table: table?.name || '', individual: !!table?.individual };
  });
}

function describe(item, byQid) {
  const tr = byQid.get(item.queueId);
  return {
    singers: tr ? singersOf(tr.sel.ids) : [],
    ours: !!tr, queueId: item.queueId || null,
    singer: tr ? shownLabel(tr.sel) : withoutSoloGroup(item.singer || (isBattleItem(item) ? 'Battle collective' : '')),
    // Pour nos titres, le catalogue KaraFun choisi par le chanteur fait foi.
    title: (tr && tr.sel.song.title) || item.title || '', artist: (tr && tr.sel.song.artist) || item.artist || '',
    img: coverUrl(tr ? tr.sel.song.img : item.img),
    kind: tr?.sel.kind || (isBattleItem(item) ? 'battle' : null),
    ids: tr ? tr.sel.ids : [], photos: tr ? tr.sel.ids.filter(pid => (sched.people.get(pid) || {}).photo).map(pid => `/photo/${pid}`) : [],
  };
}

// Chaque personne inscrite (même sans chanson) a une voix pour la Battle. Un
// QR ouvert sans prénom ne compte pas : il empêcherait le vote de se clore.
function battleElectorate() {
  return [...sched.people.values()].filter(person => !person.withdrawnAt && !person.nameRequired).map(person => person.id);
}
// Vote Battle ouvert : les personnes arrivées depuis (table, bar, QR solo,
// événement privé) ou qui viennent de saisir leur prénom votent aussi.
// Appelé après chaque action (routes POST) et avant chaque vote.
function syncBattleElectorate() {
  if (battleVote.ballot?.phase === 'voting') battleVote.admit(battleElectorate());
}

// Duo déjà chargé dans KaraFun, vu par l'une de ses deux personnes : rôle et
// retrait encore possible (pas commencé, pas en train de sortir de KaraFun).
function sentDuo(tr, p, current) {
  if (tr.sel.ids.length < 2) return {};
  const owner = sched.people.get(tr.sel.ids[0]);
  const guest = sched.people.get(tr.sel.ids[1]);
  return { duo: { role: tr.sel.ids[0] === p.id ? 'owner' : 'guest', ownerId: tr.sel.ids[0],
    ownerName: owner?.name || tr.sel.names?.[0] || '', guestName: guest?.name || tr.sel.names?.[1] || '' },
  canLeave: !tr.cancelled && !tr.pulled && !tr.absent && !tr.startedAt && !isOnStage(tr, current) };
}

// Lien « Rejoindre la Battle » des téléphones : la télécommande KaraFun du
// bar (le code saisi au bar), seulement tant qu'une Battle, suivie par
// l'application ou ajoutée dans KaraFun, est en tête de KaraFun une fois la
// scène libre (KaraFun montre alors son QR) ou sur scène : pas pendant le
// titre d'avant, qui garde les clients sur la page jusqu'au QR.
// Jamais avant (vote, envoi), ni après, ni en démo ou sans code. Au départ de
// la Battle (`battleStarting`), et KaraFun déconnecté pendant qu'elle passe,
// le suivi garde le lien, sans quoi un téléphone croirait la Battle finie.
// KaraFun déconnecté, sa file n'est plus lue (`analyze` la rend vide).
function battleJoinUrl() {
  if (DEMO || !CODE) return null;
  const { current, upcoming } = analyze();
  return isBattleItem(current) || (!current && isBattleItem(upcoming[0])) || battleStarting() ? `https://www.karafun.fr/${CODE}` : null;
}

// Vue Battle d'un téléphone (état et réponses des routes de la table) : sans
// le suivi de l'ajout à KaraFun ni ses consignes, que seule la page du bar
// lit ; électeurs et votants de sa table, ou de la personne seule sur un
// groupe individuel (« En solo »). `joinUrl` : « Rejoindre la Battle ».
function battleForPhone(battle, tableId, person) {
  const out = { ...battle };
  delete out.automation;
  out.joinUrl = battleJoinUrl();
  const individual = !!sched.table(tableId, false)?.individual;
  const shown = id => individual ? id === person?.id : sched.people.get(id)?.tableId === tableId;
  out.eligiblePersonIds = (battle.eligiblePersonIds || []).filter(shown);
  out.votedPersonIds = (battle.votedPersonIds || []).filter(shown);
  return out;
}

// `managed` : personnes gérées par le téléphone qui demande, seules à
// recevoir leurs messages (voir Scheduler#notify).
function publicState(person, tableId, managed = null) {
  const { current, upcoming } = analyze();
  const presence = presenceCandidate({ current, upcoming });
  const presenceMissingIds = new Set(presenceMissing(presence));
  const byQid = new Map(tracked.map(tr => [tr.queueId, tr]));
  // Durée moyenne d'un titre, et d'un début de titre au suivant (écart
  // mesuré entre deux titres compris) : chaque passage prévu en tient compte.
  const slot = sched.avgSlotSec() * 1000, gap = sched.songGapSec() * 1000, step = slot + gap;
  const curTr = current ? tracked.find(tr => isOnStage(tr, current)) : null;
  // Heure de fermeture fixée : heures affichées, repère et arrêt partent de la
  // même fin de scène (stageFreeAt) ; sinon, le passage moyen. Écart compris.
  const firstFreeAt = !current ? Date.now() : closingAt() != null ? stageFreeAt(current)
    : (curTr && curTr.startedAt) ? curTr.startedAt + step : Date.now() + slot / 2 + gap;
  const stage = current ? describe(current, byQid) : null;
  if (stage) stage.progress = stageProgressView(current, stage.kind, Date.now());
  const queue = upcoming.map((it, i) => ({ ...describe(it, byQid),
    source: 'karafun', pos: i + 1, eta: firstFreeAt + i * step,
    waitingPresence: i === 0 && presence?.source === 'karafun' && presenceMissingIds.size > 0,
    name: byQid.has(it.queueId) ? passageNames(byQid.get(it.queueId).sel) :
      withoutSoloGroup(it.singer || (isBattleItem(it) ? 'Battle collective' : 'KaraFun')),
    song: fmtSong(byQid.get(it.queueId)?.sel.song || it), table: byQid.has(it.queueId) ? sched.passageTables(byQid.get(it.queueId).sel.ids).join(' + ') : '',
    // Pistes vocales du titre annoncées par KaraFun (4 chœurs, 5, 6… voix guides).
    tracks: songTracksOf(it),
  }));
  if (pending) queue.push({ source: 'envoi', ours: true, queueId: null,
    pos: queue.length + 1, eta: firstFreeAt + queue.length * step,
    singer: shownLabel(pending.sel), name: passageNames(pending.sel),
    title: pending.sel.song.title, artist: pending.sel.song.artist,
    ids: pending.sel.ids, kind: pending.sel.kind, song: fmtSong(pending.sel.song), singers: singersOf(pending.sel.ids),
    table: sched.passageTables(pending.sel.ids).join(' + ') });
  // La file affichée montre aussi les titres dont la présence sera demandée
  // plus tard. Seul le prochain reçoit l'alerte et bloque l'envoi réel.
  const ready = sched.presenceView(pending ? (pending.sel.consumedIds || pending.sel.ids) : [], pending ? pending.sel : null);
  for (const v of ready) queue.push({ source: 'helper', ours: true, queueId: null,
    pos: queue.length + 1, eta: firstFreeAt + queue.length * step,
    singer: v.label, name: v.name, title: v.song.title, artist: v.song.artist,
    id: v.ids[0], ids: v.ids, kind: v.kind, song: fmtSong(v.song), table: v.table, tableId: v.tableId,
    singers: singersOf(v.ids),
    qi: v.qi, over: v.over, cap: v.cap, confirmed: v.confirmed, future: !!v.future,
    waitingPresence: presence?.source === 'helper' && presenceMissingIds.size > 0 &&
      v.entryId === presence.song?.entryId,
    isNew: !v.future && ((sched.people.get(v.ids[0])?.sung || 0) +
      (sched.people.get(v.ids[0])?.duetGuestCount || 0)) === 0,
    guaranteed: !v.future && sched.reservedNext?.personId === v.ids[0],
    // Titre retiré de KaraFun pour une priorité du bar : pas un « Pas prêt ».
    deferred: !v.future && sched.isDeferred(sched.people.get(v.ids[0])) &&
      !sched.people.get(v.ids[0]).deferral.afterPriority });
  // Heure de fermeture : titres qui passeront encore avant elle (la moitié
  // d'un titre moyen avant l'heure).
  const closing = closingView(queue, firstFreeAt, slot, step);
  if (closing) for (const item of queue) item.afterClosing = !(Number.isFinite(item.eta) && item.eta + slot / 2 <= closing.at);
  // « Pas prêt » : un titre déjà chargé dans KaraFun, ou le prochain passage
  // encore à envoyer, peut être repoussé par ses chanteurs.
  // Personne → titre concerné, tant que ce titre peut encore laisser passer
  // une chanson (DEFER_MAX par titre pour toute la soirée).
  // Sans autre passage prêt à chanter avant lui, un report laisserait la
  // scène vide : « Pas prêt » n'est pas proposé (deferAlone l'explique).
  const deferrable = new Map(), deferAlone = new Set();
  const allowDefer = (ids, song) => {
    if (sched.deferredSongsOf(song) >= DEFER_MAX) return;
    if (othersCanPass(ids, ready)) ids.forEach(id => deferrable.set(id, song));
    else ids.forEach(id => deferAlone.add(id));
  };
  for (const tr of tracked) {
    if (!tr.cancelled && !tr.pulled && !tr.absent && !tr.startedAt && !isOnStage(tr, current)) allowDefer(tr.sel.ids, tr.sel.song);
  }
  const firstHelper = ready.find(v => !v.future && !sched.isDeferred(sched.people.get(v.ids[0])));
  if (firstHelper) allowDefer(firstHelper.ids, firstHelper.song);
  if (pending) pending.sel.ids.forEach(id => deferrable.delete(id));
  const deferralOf = pid => {
    const active = sched.deferralFor(pid);
    if (active) return { remaining: active.remaining, total: active.total,
      canDeferMore: active.total < DEFER_MAX && othersCanPass(sched.people.get(active.ownerId)?.deferral?.ids || [pid], ready) };
    // Titre en train de sortir de KaraFun : pas d'autre report avant son retour.
    const pulling = tracked.find(tr => tr.pulled?.reason === 'defer' && tr.sel.ids.includes(pid));
    const owner = pulling && sched.people.get(pulling.sel.ids[0]);
    return owner?.deferral ? { remaining: owner.deferral.remaining, total: owner.deferral.total,
      pendingRemoval: true, canDeferMore: false } : null;
  };
  const sentJoinRequests = sched.duetJoinRequestsByPerson();
  // Invitations reçues, sauf celle dont le titre part déjà dans KaraFun : elle
  // expirera à son accusé (on ne peut plus l'accepter).
  const sending = sendingEntryId();
  const invitesFor = p => sched.duetInvites(p).filter(inv => inv.entryId !== sending).map(inv => ({ entryId: inv.entryId,
    fromName: sched.people.get(inv.fromId)?.name || 'Un chanteur', song: fmtSong(inv.song) }));
  const next = queue[0] || null;
  const nextEta = next?.eta || null;
  const confirmedForPage = p => !!sched._confirmedRecently(p) ||
    tracked.some(tr => tr.sel.ids.includes(p.id) && tr.sel.presenceConfirmed);
  const needsPresence = p => presenceMissingIds.has(p.id) &&
    !(stage?.ours && stage.ids.includes(p.id));
  const waiting = sched.Q.map(pid => sched.people.get(pid)).filter(p => p && !p.song && !tracked.some(tr => tr.sel.ids.includes(p.id)))
    .map(p => ({ id: p.id, name: p.name, table: sched.table(p.tableId, false)?.name || '' }));

  const out = {
    now: Date.now(),
    karafun: { connected: !!(bridge && bridge.connected), ready: !!(bridge && bridge.ready), demo: DEMO },
    stage, next, nextEta, queue, waiting, internalCount: sched.Q.length, closing,
    catalogAvailable: !!(CODE && bridge?.ready && !DEMO),
    guaranteed: sched.reservedNext ? 1 : 0,
    avgSlotMin: Math.round(sched.avgSlotSec() / 6) / 10,
    // Temps entre deux titres compté dans les heures estimées (diagnostic du bar).
    songGapSec: Math.round(sched.songGapSec()), songGapMeasured: sched.songGapSamples.length >= SONG_GAP_MIN_SAMPLES,
    rules: { gap: sched.opts.gap, cap: sched.opts.cap, protectTop: sched.opts.protectTop,
      requirePresence: sched.opts.requirePresence, tableRotation: sched.opts.tableRotation,
      weightedTables: sched.opts.weightedTables,
      // Durée maximale des titres (secondes, null : pas de limite).
      maxSongSec: maxSongLimit(), duoOnly: !!settings.duoOnly },
    log: sched.log.slice(-30).reverse(),
    v: sched.version,
    // « registered » : personnes qui pourraient voter. En dessous du minimum
    // de votants, les téléphones ne proposent pas de Battle.
    battle: { ...battleVote.view(), registered: battleElectorate().length },
    // Réglages de titre : interrupteur du bar (et télécommande qui les
    // connaît), plages de KaraFun, valeurs par défaut.
    songSettings: { enabled: settings.singerSongSettings !== false && bridge?.songSettingsAvailable?.() !== false,
      ranges: songRanges(), defaults: songDefaults() },
  };

  // Duos ouverts des autres (« Qui veut chanter en duo avec moi ? ») : seules
  // les personnes présentes et nommées gérées par ce téléphone peuvent les
  // rejoindre, jamais leur auteur ; sans elles, rien n'est envoyé. Tous, du
  // plus récent au plus ancien, sauf celui dont le titre part déjà dans
  // KaraFun (en solo) : c'est le seul moyen de les rejoindre, et en « Duos
  // uniquement » un duo retenu n'est pas dans la file. La page replie
  // l'affichage (client.html, renderInfos).
  const volunteers = [...(managed || [])].map(pid => sched.people.get(pid)).filter(p => p && !p.withdrawnAt && !p.nameRequired);
  if (volunteers.length) {
    out.openDuets = sched.openDuets().filter(open => open.entryId !== sending).map(open => ({
      ownerId: open.owner.id, ownerName: open.owner.name, ownerLabel: sched.passageLabel([open.owner.id]),
      entryId: open.entryId, openedAt: open.openedAt,
      song: { songId: open.song.songId, title: open.song.title, artist: open.song.artist, img: coverUrl(open.song.img), duration: open.song.duration || null },
      volunteerIds: volunteers.filter(p => p.id !== open.owner.id).map(p => p.id) }))
      .filter(open => open.volunteerIds.length);
  }

  const guestDuosOf = person => {
    const duos = [];
    for (const owner of sched.people.values()) for (const song of sched.songsOf(owner)) {
      if (song.duet?.partnerId === person.id && song.duet.state === 'accepted') {
        duos.push({ entryId: song.entryId, ownerId: owner.id, fromName: owner.name, song: fmtSong(song) });
      }
    }
    return duos;
  };

  out.people = [...sched.people.values()].filter(p => !tableId || p.tableId === tableId)
    .map(p => ({ id: p.id, name: p.name,
    table: sched.table(p.tableId, false)?.name || p.tableId, tableId: p.tableId,
    busy: false }));

  const tid = person ? person.tableId : (tableId ? String(tableId) : null);
  if (tid) {
    // La file commune reste publique, mais les personnes sans titre et le
    // journal des actions des autres tables ne concernent pas ce téléphone.
    out.waiting = out.waiting.filter(item => sched.people.get(item.id)?.tableId === tid);
    delete out.log;
    out.battle = battleForPhone(out.battle, tid, person);
  }
  if (tid) {
    const t = sched.table(tid, false);
    out.table = t ? { id: t.id, name: t.name, headcount: t.headcount, individual: t.individual,
      count: sched.tableSingers(t.id).length, activeCount: sched.tableSingers(t.id).filter(countsAsPresent).length } :
      { id: tid, name: /^\d+$/.test(tid) ? `Table ${tid}` : tid, headcount: null, count: 0, activeCount: 0 };
    if (t?.individual) {
      out.people = out.people.filter(item => item.id === person?.id);
      out.waiting = [];
      // Seules les personnes qui ont demandé un code de reprise au bar (ou
      // sur leur ancien téléphone) apparaissent dans ce parcours temporaire.
      // Personne partie sur ce téléphone (un doublon), ou place encore sans
      // prénom ni titre (un QR montré par le bar, ouvert sur ce nouveau
      // téléphone) : la reprise reste ouverte. La route filtre ensuite selon
      // le téléphone actuel de cette place.
      out.recoveryPeople = person && !person.withdrawnAt && !disposablePlaceholder(person) ? [] : sched.tableSingers(tid).filter(p => !p.withdrawnAt &&
        personShareCodes.get(p.id)?.expiresAt > Date.now() && personShareCodes.get(p.id).attempts < 5)
        .map(p => ({ id: p.id, name: p.name }));
    }
    out.tablePeople = sched.tableSingers(tid).filter(p => !t?.individual || p.id === person?.id)
      .map(p => ({ id: p.id, name: p.name,
      ...(p.nameRequired ? { nameRequired: true } : {}),
      // Venu par le QR de l'événement privé : son adresse ne garde pas ce QR,
      // le téléphone conseille de le rescanner depuis la même application.
      ...(t?.individual && p.viaEvent ? { viaEvent: true } : {}),
      active: !p.withdrawnAt,
      songs: sched.songsOf(p).map(fmtSong),
      confirmed: confirmedForPage(p),
      needConfirm: needsPresence(p),
      ...(invites => ({ invite: invites[0] ? { fromName: invites[0].fromName, song: invites[0].song } : null, invites }))(invitesFor(p)),
      guestDuos: guestDuosOf(p),
      // Demandes de duo reçues sur ses titres, et envoyées à d'autres.
      // Titre en cours d'envoi : la demande expirera à son accusé.
      joinRequests: sched.duetJoinRequestsFor(p).filter(r => !(pending && !pending.cancelled && pending.sel.song.entryId === r.entryId))
        .map(r => ({ entryId: r.entryId, fromId: r.fromId, fromName: r.fromName, song: fmtSong(r.song) })),
      sentJoinRequests: (sentJoinRequests.get(p.id) || []).map(r => ({ ownerId: r.ownerId, ownerName: r.ownerName,
        entryId: r.entryId, song: fmtSong(r.song), seen: !!r.seenAt })),
      ...(deferral => ({ deferral, canDefer: !p.withdrawnAt && deferrable.has(p.id) && !deferral,
        deferAlone: !p.withdrawnAt && !deferral && deferAlone.has(p.id) }))(deferralOf(p.id)),
      duet: p.duet?.state === 'open' ? { state: 'open' } : p.duet ? { partnerName: sched.people.get(p.duet.partnerId)?.name || 'Un chanteur',
        state: p.duet.state } : p.duetOf ? { partnerName: sched.people.get(p.duetOf)?.name || 'Un chanteur',
        state: 'accepted', asPartner: true } : null,
      ...(managed?.has(p.id) ? { inbox: sched.inboxOf(p).map(n => ({ id: n.id, kind: n.kind, params: n.params, at: n.at })) } : {}),
      // Réglages de titre : seul l'auteur du titre les change, avant son début.
      // `lock` dit pourquoi le téléphone ne peut plus : 'duo' (partenaire),
      // 'started' (commencé ou sur scène), 'leaving' (sort de KaraFun).
      inKaraFun: tracked.filter(tr => tr.sel.ids.includes(p.id)).map(tr => {
        const lock = tr.sel.ids[0] !== p.id ? 'duo' : tr.startedAt || isOnStage(tr, current) ? 'started'
          : tr.cancelled || tr.pulled || tr.absent ? 'leaving' : null;
        return { title: tr.sel.song.title, artist: tr.sel.song.artist,
          songId: tr.sel.song.songId, img: coverUrl(tr.sel.song.img), queueId: tr.queueId, stage: !!(stage && stage.queueId === tr.queueId),
          entryId: tr.sel.song.entryId || null, settings: tr.sel.song.settings || null, tracks: songTracksOf(kfItemOf(tr)),
          canAdjust: !lock, lock, ...sentDuo(tr, p, current) };
      }).concat(pending && pending.sel.ids.includes(p.id) ? [(lock => ({ title: pending.sel.song.title, artist: pending.sel.song.artist,
        songId: pending.sel.song.songId, img: coverUrl(pending.sel.song.img), queueId: null, stage: false, sending: true,
        entryId: pending.sel.song.entryId || null, settings: pending.sel.song.settings || null, canAdjust: !lock, lock }))(
        pending.sel.ids[0] !== p.id ? 'duo' : pending.cancelled ? 'leaving' : null)] : []),
    }));
  }

  if (person) {
    // La dernière activité ne bouge que sur une page visible : /api/state
    // note les signes de vie (une page cachée continue d'interroger).
    const i = sched.Q.indexOf(person.id);
    const mine = queue.find(v => v.ids?.includes(person.id)) || null;
    const onStageNow = !!(stage && stage.ours && stage.ids.includes(person.id));
    const upNext = !!(next && next.ours && next.ids.includes(person.id));
    const owner = person.duetOf ? sched.people.get(person.duetOf) : null;
    const partner = person.duet ? sched.people.get(person.duet.partnerId) : null;
    out.me = {
      id: person.id, name: person.name, tableId: person.tableId, photo: person.photo ? `/photo/${person.id}` : null,
      // Prénom provisoire (« Solo 3 ») : la page demande d'abord le vrai prénom.
      nameRequired: !!person.nameRequired,
      song: fmtSong(person.song), songs: sched.songsOf(person).map(fmtSong),
      inKaraFun: out.tablePeople?.find(p => p.id === person.id)?.inKaraFun || [],
      sung: person.sung, inQueue: i >= 0,
      pos: mine ? mine.pos : null, eta: mine ? mine.eta : null, guaranteed: mine ? mine.guaranteed : false,
      over: person.over, onStage: onStageNow, upNext,
      ...(invites => ({ invite: invites[0] ? { fromName: invites[0].fromName, song: invites[0].song } : null, invites }))(invitesFor(person)),
      guestDuos: guestDuosOf(person),
      duet: partner ? { partnerName: partner.name, state: person.duet.state } : (owner ? { partnerName: owner.name, state: 'accepted', asPartner: true, song: fmtSong(owner.song) } : null),
      confirmed: confirmedForPage(person),
      needConfirm: needsPresence(person),
      mates: sched.table(person.tableId, false)?.individual ? [] :
        sched.tableSingers(person.tableId).filter(p => p.id !== person.id).map(p => { const v = queue.find(x => x.ids?.includes(p.id)); return { id: p.id, name: p.name, pos: v ? v.pos : null, busy: false }; }),
    };
  }
  return out;
}

function staffState() {
  const pub = publicState(null, null);
  const presence = presenceCandidate();
  const presenceIds = new Set(presenceMissing(presence));
  const presencePending = [...presenceIds].map(pid => sched.people.get(pid)?.name).filter(Boolean);
  // Mode serveur : aucune adresse du Wi-Fi n'est proposée au bar.
  const ips = SERVER ? [] : lanAddresses();
  const latestManual = sched.manualChanges.at(-1);
  // Lignes placées par le bar (gestes encore valables) : repère dans la file.
  const placed = new Set(sched.manualChanges.map(change => change.personId));
  const repeats = queueRepeats(pub.queue, sched.playedSongs, Date.now(), repeatWindowMs());
  const { current } = analyze();
  const stageTr = current ? tracked.find(tr => isOnStage(tr, current)) : null;
  const kfSettings = bridge?.songSettingsState?.() || null;
  return {
    ...pub,
    // Réglages de titre pour le bar : droits et fonctions confirmées par
    // KaraFun, dernier avis, et titre en cours en direct (pistes comprises).
    songSettings: { ...pub.songSettings,
      permissions: kfSettings?.permissions || { manageVolumes: null, manageQueue: null },
      support: kfSettings?.support || unknownSettingsSupport(),
      notices: kfSettings?.notices || {},
      notice: kfSettings?.notice || null,
      available: kfSettings?.available ?? null,
      live: current && kfSettings?.live ? { ...kfSettings.live, entryId: stageTr?.sel.song.entryId || null,
        title: stageTr?.sel.song.title || current.title || '', settings: stageTr?.sel.song.settings || null } : null },
    // Duo noté au bar sur le titre en cours : la page propose de le corriger.
    stage: pub.stage && stageTr?.sel.staffDuo ? { ...pub.stage, staffDuo: staffDuoView(stageTr.sel.staffDuo) } : pub.stage,
    // Repères réservés au bar : titres en double, « Je suis là » manqués.
    // « trop long » (tooLongSec) : titre pas encore envoyé, au-delà de la durée maximale.
    // `afterPriority` : titre retiré de KaraFun pour une priorité, qui repasse
    // juste après elle ; `leaving` : titre de la file qui sort de KaraFun.
    queue: pub.queue.map((line, index) => {
      const owner = line.source === 'helper' ? sched.people.get(line.id) : null;
      const skips = owner && owner.song?.entryId === line.song?.entryId ? sched.presenceSkipsOf(owner) : 0;
      const tooLong = owner ? tooLongSec(line.song) : null;
      const placedByBar = !!owner && !line.future && placed.has(owner.id) && sched.manualOrder.includes(owner.id);
      const afterPriority = !!owner && !line.future && sched.isDeferred(owner) && !!owner.deferral.afterPriority;
      const leaving = line.source === 'karafun' && line.ours ?
        tracked.find(tr => String(tr.queueId) === String(line.queueId) && tr.pulled)?.pulled.reason || null : null;
      return repeats[index] || skips || tooLong || placedByBar || afterPriority || leaving ? { ...line, ...(repeats[index] ? { repeat: repeats[index] } : {}),
        ...(skips ? { presenceSkips: skips } : {}), ...(tooLong ? { tooLongSec: tooLong } : {}),
        ...(placedByBar ? { placed: true } : {}), ...(afterPriority ? { afterPriority: true } : {}),
        ...(leaving ? { leaving } : {}) } : line;
    }),
    // « Priorité » : titre déjà chargé dans KaraFun que la page propose de
    // retirer pour faire passer la personne prioritaire avant lui.
    // `stageIds` : chanteurs du titre en cours, qui chanteraient deux fois de
    // suite (priorityPullFor) ; la page ne propose pas le retrait pour eux.
    priorityPull: (tr => tr ? { queueId: tr.queueId, title: tr.sel.song.title, name: passageNames(tr.sel),
      ids: [...tr.sel.ids], stageIds: stageSingers() } : null)(priorityPullTarget()),
    // Durée maximale : titres de la file qu'un retrait groupé enlèverait.
    tooLong: { limitSec: maxSongLimit(), count: tooLongEntries().length },
    battle: { ...battleVote.view(), registered: battleElectorate().length },
    // Demandes de duo encore sans réponse de l'auteur du titre.
    joinRequests: [...sched.duetJoinRequestsByPerson()].flatMap(([requesterId, rows]) => rows.map(row => ({
      ownerId: row.ownerId, ownerName: row.ownerName, requesterId,
      requesterName: sched.people.get(requesterId)?.name || '', entryId: row.entryId, title: row.song.title,
      at: sched._joinRequests(row.song).find(item => item.fromId === requesterId)?.at || null, seenAt: row.seenAt }))),
    // Invitations de duo envoyées par l'auteur d'un titre, encore sans réponse
    // de l'invitée (vue ou pas encore vue sur son téléphone).
    duoInvites: [...sched.people.values()].filter(owner => !owner.withdrawnAt).flatMap(owner => sched.songsOf(owner)
      .filter(song => song.duet?.state === 'pending').map(song => ({ ownerId: owner.id, ownerName: owner.name,
        partnerId: song.duet.partnerId, partnerName: sched.people.get(song.duet.partnerId)?.name || '',
        entryId: song.entryId, title: song.title, seenAt: song.duet.seenAt || null }))),
    // Duos ouverts encore sans partenaire ; `held` : « Duos uniquement », le
    // titre ne part pas tant que personne ne l'a rejoint. Celui dont le titre
    // part déjà dans KaraFun (en solo) n'est plus à pourvoir, comme chez les clients.
    openDuets: sched.openDuets().filter(open => open.entryId !== sendingEntryId()).map(open => ({ ownerId: open.owner.id, ownerName: open.owner.name,
      table: sched.passageTables([open.owner.id]).join(' + '), entryId: open.entryId, title: open.song.title,
      openedAt: open.openedAt, held: sched._openHeld(open.song) })),
    // Gestes encore valables, du plus récent au plus ancien : le plus récent
    // s'annule toujours, même après d'autres changements de la file.
    manualChanges: sched.manualChanges.slice().reverse().map((change, index) => ({
      id: change.id, kind: change.kind, name: change.name,
      from: change.from, to: change.to, at: change.at,
      canUndo: index === 0,
      unavailableReason: index > 0 ? 'Annule d’abord les interventions plus récentes.' : null,
    })),
    priorityUndo: latestManual?.kind === 'priority' ? { available: true, name: latestManual.name } : null,
    presencePending,
    // « Je suis là » manqué plusieurs fois : titre retiré, le bar vérifie.
    maybeGone: [...sched.people.values()].filter(p => p.maybeGone && !p.withdrawnAt).map(p => ({
      // Un soliste est nommé par son seul prénom (jamais « En solo »).
      id: p.id, name: p.name, table: sched.table(p.tableId, false)?.individual ? '' : sched.table(p.tableId, false)?.name || '',
      title: p.maybeGone.title, skips: p.maybeGone.skips, at: p.maybeGone.at })),
    persistenceError, recoveredPending, queueClearPending: !!settings.queueClearPending,
    removalPending: tracked.filter(tr => tr.cancelled).length,
    log: sched.log.slice(-120).reverse(),
    settings: { ...settings, gap: sched.opts.gap, cap: sched.opts.cap, requirePresence: sched.opts.requirePresence,
      tableRotation: sched.opts.tableRotation, weightedTables: sched.opts.weightedTables,
      interleaveArrivals: sched.opts.interleaveArrivals !== false,
      battleCooldownMin: battleVote.cooldownMs / 60000,
      battleRejectedCooldownMin: battleVote.rejectedCooldownMs / 60000,
      battleVoteMin: battleVote.voteDurationMs / 60000, battleMinVoters: battleVote.minVoters },
    solver: sched.solverStatus(),
    app: { ...BUILD, mode: SERVER ? 'server' : 'pc' }, bootId: BOOT_ID,
    update: updateState(),
    stageHistory: stageHistoryView(),
    spotify: spotify.view(spotifyRedirect()),
    restarting: !!restartOp,
    restartRetryAt: restartSweep && Date.now() <= restartSweep.until ? restartSweep.until : null,
    soloInvitations: soloInvitations.view(),
    privateEvent: privateEventView(),
    phoneBase: phoneBase(), ips, port: PORT, staffKey: STAFF_KEY,
    tables: [...sched.tables.values()].map(t => ({ ...t,
      url: access.get(t.id) ? access.url(phoneBase(), t.id) : null,
      qrUrl: access.get(t.id) ? `/qr/${encodeURIComponent(t.id)}.svg` : null,
      count: sched.tableSingers(t.id).length,
      activeCount: sched.tableSingers(t.id).filter(countsAsPresent).length,
      inQueue: sched.tableSingers(t.id).filter(p => sched.Q.includes(p.id)).length })),
    people: [...sched.people.values()].map(p => ({ id: p.id, name: p.name, tableId: p.tableId,
      sung: p.sung, inQueue: sched.Q.includes(p.id), lastSeen: p.lastSeen,
      // Dernière activité sur son téléphone (page visible ou action), à
      // comparer à `now` (heure du serveur). Réservé au bar.
      lastActiveAt: Math.max(Number(p.lastSeen) || 0, Number(p.lastActionAt) || 0) || null,
      joinedAt: p.joinedAt, nameRequired: !!p.nameRequired, viaEvent: !!p.viaEvent,
      active: !p.withdrawnAt, songCount: sched.songsOf(p).length,
      privateNote: p.privateNote || '', bonus: p.bonus || 0,
      appearances: (p.sung || 0) + (p.duetGuestCount || 0),
      presenceSkips: sched.presenceSkipsOf(p), presenceRetry: sched._isPresenceRetry(p),
      photoUrl: p.photo ? `/photo/${p.id}` : null })),
    pending: pending ? { label: shownLabel(pending.sel), title: pending.sel.song.title } : null,
    tracked: tracked.map(tr => ({ queueId: tr.queueId, label: tr.sel.label, title: tr.sel.song.title,
      ids: tr.sel.ids, startedAt: tr.startedAt })),
    kf: bridge ? bridge.snapshot() : null,
    code: CODE,
  };
}

// Titre de la file actuellement chanté (null si rien de la file n'est sur scène).
function onStageEntryId() {
  const { current } = analyze();
  return tracked.find(tr => tr.startedAt && isOnStage(tr, current))?.sel.song?.entryId || null;
}

// Derniers passages réellement montés sur scène, du plus récent au plus
// ancien, avec les repères privés du bar pour reconnaître les personnes.
function stageHistoryView() {
  const live = onStageEntryId();
  return sched.stageHistory.slice(-20).reverse().map(item => ({
    id: item.id, at: item.at, endedAt: item.endedAt, title: item.title, artist: item.artist,
    kind: item.kind, onStage: !item.endedAt && !!live && item.entryId === live, staffDuo: staffDuoView(item.staffDuo),
    people: item.ids.map((pid, index) => {
      const p = sched.people.get(pid);
      const table = sched.table(p?.tableId || item.tableIds?.[index] || '', false);
      return { id: pid, name: p?.name || item.names[index] || '?',
        table: table?.name || '', individual: !!table?.individual,
        privateNote: p?.privateNote || '', active: !!p && !p.withdrawnAt,
        photoUrl: p?.photo ? `/photo/${pid}` : null, appearances: p ? (p.sung || 0) + (p.duetGuestCount || 0) : null };
    }),
  }));
}

// L'historique ne peut restaurer que la file du helper. Une évolution de la
// lecture ou de l'ordre natif KaraFun rend le dernier état manuel périmé.
function priorityNativeFingerprint() {
  const live = analyze();
  // Certaines versions annoncent le titre avant de lui attribuer un queueId.
  // Le statut varie pendant une même chanson : il n'appartient pas à l'identité.
  const identity = item => item ? [item.queueId ?? null, item.songId ?? null,
    item.title || '', item.singer || ''] : null;
  const value = JSON.stringify({
    current: identity(live.current),
    upcoming: live.upcoming.map(identity),
    pending: pending?.sel.song?.entryId || null,
    tracked: tracked.map(item => [item.queueId, item.sel.song?.entryId, item.startedAt || null]),
  });
  return crypto.createHash('sha256').update(value).digest('hex');
}

// ------------------------------------------------------------------ réseau local
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  const score = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => score(a.address) - score(b.address));
}
function phoneBase() {
  if (SERVER) return SERVER.publicUrl;
  if (settings.baseUrl) return settings.baseUrl.replace(/\/$/, '');
  const ip = (lanAddresses()[0] || {}).address || 'localhost';
  return `http://${ip}:${PORT}`;
}

// Appelée aussi pendant le chargement du module, par readServerConfig (section
// « mode serveur ») : elle ne lit que son argument, car une const ou un let de
// module déclaré après cette section n'est pas encore initialisé à ce moment-là.
function normalizeBaseUrl(value) {
  if (value == null || String(value).trim() === '') return null;
  let url;
  try { url = new URL(String(value).trim()); }
  catch { throw new Error('Adresse invalide : indique une origine HTTPS, par exemple https://chant.exemple.fr.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Indique seulement l’adresse de base, sans chemin, paramètres ni identifiants.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const parts = host.split('.').map(Number);
  const privateIp = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 169 && parts[1] === 254));
  if (url.protocol === 'http:' && host !== 'localhost' && host !== '::1' && !privateIp) {
    throw new Error('Une adresse accessible depuis Internet doit utiliser HTTPS.');
  }
  if (url.protocol === 'https:' && (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.lan') || host === '::1' || privateIp)) {
    throw new Error('Pour les mobiles sans Wi-Fi, utilise un vrai nom de domaine public HTTPS.');
  }
  return url.origin;
}

// ------------------------------------------------------------------ HTTP
const PUB = path.join(__dirname, 'public');
// JSON compressé (gzip) quand le navigateur l'accepte, ce que font tous les
// navigateurs : à 400 invités, une lecture de téléphone (toutes les 4 s, pages
// cachées comprises) pèse environ 240 Ko en clair, dix fois moins compressée,
// par le Wi-Fi du bar comme par le tunnel. Niveau le plus rapide, calcul hors
// du fil principal (environ 0,6 ms, plus 0,3 ms sur le fil principal, pour
// 240 Ko), en un seul passage pour une sortie jusqu'à 64 Ko ; une petite
// réponse part en clair.
const GZIP_MIN_LENGTH = 1024;
function acceptsGzip(req) {
  return String(req?.headers?.['accept-encoding'] || '').split(',').some(part => {
    const [coding, q] = part.split(/;\s*q=/).map(text => text.trim().toLowerCase());
    return coding === 'gzip' && (q === undefined || Number(q) > 0);
  });
}
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...extra, ...SERVER_HEADERS };
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  if (!type.startsWith('application/json') || data.length < GZIP_MIN_LENGTH || !acceptsGzip(res.req)) {
    res.writeHead(code, headers);
    return res.end(data);
  }
  zlib.gzip(data, { level: zlib.constants.Z_BEST_SPEED, chunkSize: 64 * 1024 }, (error, zipped) => {
    res.writeHead(code, error ? headers : { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    res.end(error ? data : zipped);
  });
};
const sendFile = (res, file, type) => fs.readFile(path.join(PUB, file), (err, buf) => err ? send(res, 404, 'Introuvable', 'text/plain') : send(res, 200, buf, type));

function readBody(req, limit = 900 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Trop volumineux')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('JSON invalide')); } });
    req.on('error', reject);
  });
}

function isLocal(req) {
  // Mode serveur : le relais HTTPS arrive par la boucle locale, qui ne donne aucun droit.
  if (SERVER) return false;
  const a = req.socket.remoteAddress || '';
  return req.socket.localPort === PORT && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1');
}
function isStaff(req, u) {
  // Le tunnel arrive depuis 127.0.0.1 : la prise publique reste interdite au bar,
  // même avec la clé. Sinon son proxy serait pris pour un navigateur local.
  if (req.socket.localPort === PUBLIC_PORT) return false;
  const supplied = u.searchParams.get('key') || req.headers['x-staff-key'];
  if (typeof supplied !== 'string') return false;
  const actual = Buffer.from(STAFF_KEY), candidate = Buffer.from(supplied);
  return candidate.length === actual.length && crypto.timingSafeEqual(candidate, actual);
}

// Caddy pose ce marqueur uniquement après le mot de passe des gérants et
// l'efface sur le domaine clients. Il ouvre la session de la page, jamais
// directement l'API. Un hôte ou un relais non prévu ne reçoit aucun secret.
function authenticatedStaffEntry(req) {
  if (!SERVER || req.socket.localPort !== PORT || req.headers['x-karaoke-staff-entry'] !== '1' ||
      req.headers.host !== new URL(SERVER.staffUrl).host) return false;
  const remote = req.socket.remoteAddress || '';
  return !!net.isIP(remote) && SERVER.trustedProxies.check(remote, net.isIPv6(remote) ? 'ipv6' : 'ipv4');
}

function redirectStaffEntry(res) {
  return send(res, 303, '', 'text/plain; charset=utf-8', { Location: `/staff?key=${encodeURIComponent(STAFF_KEY)}` });
}

// Page du bar seule (pas l'API, ni /print, /stats ou /qr) : en mode serveur, /staff sans
// paramètre key sert la coquille sans secret, qui relit la clé gardée par l'onglet.
// Une clé fausse ou vide reste refusée, et le port clients aussi.
function staffPageAllowed(req, u) {
  if (isStaff(req, u)) return true;
  return !!SERVER && req.socket.localPort !== PUBLIC_PORT && !u.searchParams.has('key');
}

function decodePhoto(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 400 * 1024) return null;
  return { type: m[1], buf };
}

function tableByAccess(id, secret) {
  const key = TableAccess.key(id);
  if (!access.verify(key, secret)) {
    const e = new Error('Lien de table invalide ou périmé. Scanne le QR code affiché à ta table.');
    e.code = 'TABLE_ACCESS'; throw e;
  }
  const t = sched.table(key, false);
  if (!t) {
    const e = new Error('Cette table n’est plus ouverte.'); e.code = 'TABLE_CLOSED'; throw e;
  }
  return t;
}

// Le code KaraFun reste sur le serveur. Seules les pages venues d'un QR de
// table peuvent demander une recherche ou un catalogue ; le bar utilise sa
// clé. Sur le PC, la boucle locale du port du bar garde son accès historique.
function catalogReader(req, u) {
  if (isStaff(req, u)) return { kind: 'staff' };
  if (isLocal(req)) return { kind: 'pc-local' };
  const id = req.headers['x-table-id'], secret = req.headers['x-table-access'];
  if (typeof id !== 'string' || !id || typeof secret !== 'string' || !secret) {
    const e = new Error('Scanne le QR code de ta table pour consulter le catalogue.');
    e.code = 'TABLE_ACCESS';
    throw e;
  }
  const table = tableByAccess(id, secret);
  if (!table.individual) return { kind: 'table', id: table.id };
  const owner = soloDeviceOwner(req);
  if (owner?.tableId === table.id && !owner.withdrawnAt && currentSoloDevice(req, owner)) {
    return { kind: 'solo', id: owner.soloKeyHash || owner.id };
  }
  const invitation = req.headers['x-solo-invitation'];
  requireSoloInvitation(table, invitation);
  return { kind: 'solo', id: SoloInvitations.digest(invitation) };
}

// Un QR divulgué ne peut pas envoyer des recherches sans fin vers KaraFun.
// Le budget est par table (ou par téléphone solo), avec un plafond commun :
// 60 téléphones peuvent lancer chacun quelques recherches dans la même minute,
// y compris derrière une unique adresse IP de Wi-Fi. Les sélections identiques
// sont partagées brièvement entre téléphones après vérification du QR.
const CATALOG_READ_WINDOW_MS = 60 * 1000;
const CATALOG_GLOBAL_PER_MINUTE = 180;
const CATALOG_TABLE_PER_MINUTE = 90;
const CATALOG_SOLO_PER_MINUTE = 30;
const CATALOG_MAX_ACTIVE = 6;
const CATALOG_MAX_QUEUED = 60;
const catalogGlobalBudget = { tokens: CATALOG_GLOBAL_PER_MINUTE, at: Date.now() };
const catalogActorBudgets = new Map();
const catalogReadCache = new Map();
const catalogQueue = [];
let catalogActive = 0;
function catalogBusyError(retryAfter = 1) {
  const e = new Error('Beaucoup de recherches en ce moment. Réessaie dans quelques secondes.');
  e.code = 'CATALOG_BUSY';
  e.retryAfter = retryAfter;
  return e;
}
function refillCatalogBudget(budget, maximum, now) {
  budget.tokens = Math.min(maximum, budget.tokens + Math.max(0, now - budget.at) * maximum / CATALOG_READ_WINDOW_MS);
  budget.at = now;
}
function reserveCatalogRead(reader) {
  if (reader.kind === 'staff' || reader.kind === 'pc-local') return;
  const now = Date.now();
  const key = `${reader.kind}:${reader.id}`;
  const maximum = reader.kind === 'solo' ? CATALOG_SOLO_PER_MINUTE : CATALOG_TABLE_PER_MINUTE;
  if (!catalogActorBudgets.has(key)) catalogActorBudgets.set(key, { tokens: maximum, at: now });
  const actor = catalogActorBudgets.get(key);
  refillCatalogBudget(catalogGlobalBudget, CATALOG_GLOBAL_PER_MINUTE, now);
  refillCatalogBudget(actor, maximum, now);
  if (catalogGlobalBudget.tokens < 1 || actor.tokens < 1) {
    throw catalogBusyError(Math.max(1, Math.ceil(Math.max(
      (1 - catalogGlobalBudget.tokens) * CATALOG_READ_WINDOW_MS / CATALOG_GLOBAL_PER_MINUTE,
      (1 - actor.tokens) * CATALOG_READ_WINDOW_MS / maximum) / 1000)));
  }
  catalogGlobalBudget.tokens -= 1;
  actor.tokens -= 1;
  if (catalogActorBudgets.size > 512) {
    for (const [id, value] of catalogActorBudgets) if (now - value.at > CATALOG_READ_WINDOW_MS) catalogActorBudgets.delete(id);
  }
}
function runCatalogWork(load) {
  if (catalogActive >= CATALOG_MAX_ACTIVE && catalogQueue.length >= CATALOG_MAX_QUEUED) {
    throw catalogBusyError(5);
  }
  return new Promise((resolve, reject) => {
    const run = () => {
      catalogActive++;
      Promise.resolve().then(load).then(resolve, reject).finally(() => {
        catalogActive--;
        const next = catalogQueue.shift();
        if (next) { clearTimeout(next.timer); next.run(); }
      });
    };
    if (catalogActive < CATALOG_MAX_ACTIVE) run();
    else {
      const ticket = { run, timer: null };
      ticket.timer = setTimeout(() => {
        const at = catalogQueue.indexOf(ticket);
        if (at >= 0) { catalogQueue.splice(at, 1); reject(catalogBusyError(5)); }
      }, 15000);
      catalogQueue.push(ticket);
    }
  });
}
async function readCatalog(reader, key, ttlMs, load) {
  // Le bar garde toujours sa recherche même si les clients remplissent la file.
  if (reader.kind === 'staff' || reader.kind === 'pc-local') return load();
  const now = Date.now();
  const cacheKey = `${CODE}|${key}`;
  const cached = catalogReadCache.get(cacheKey);
  if (cached && now < cached.until) return cached.promise;
  if (catalogActive >= CATALOG_MAX_ACTIVE && catalogQueue.length >= CATALOG_MAX_QUEUED) throw catalogBusyError(5);
  reserveCatalogRead(reader);
  const item = { until: Infinity, promise: null };
  item.promise = runCatalogWork(load).then(value => { item.until = Date.now() + ttlMs; return value; });
  catalogReadCache.delete(cacheKey);
  catalogReadCache.set(cacheKey, item);
  item.promise.catch(() => { if (catalogReadCache.get(cacheKey) === item) catalogReadCache.delete(cacheKey); });
  if (catalogReadCache.size > 512) catalogReadCache.delete(catalogReadCache.keys().next().value);
  return item.promise;
}

function catalogBusy(res, error) {
  if (error.code !== 'CATALOG_BUSY') return false;
  send(res, 429, { error: error.message, code: error.code }, undefined,
    { 'Retry-After': String(error.retryAfter) });
  return true;
}

function soloCookieHash(req) {
  const raw = String(req.headers.cookie || '').split(';').map(part => part.trim())
    .find(part => part.startsWith(`${SOLO_COOKIE}=`))?.slice(SOLO_COOKIE.length + 1);
  if (!raw || !/^[A-Za-z0-9_-]{32}$/.test(raw)) return null;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function soloDeviceOwner(req) {
  const hash = soloCookieHash(req);
  if (!hash) return null;
  return [...sched.people.values()].find(person =>
    sched.table(person.tableId, false)?.individual &&
    Array.isArray(person.soloDeviceHashes) && person.soloDeviceHashes.includes(hash)) || null;
}

// Place solo qui empêche ce navigateur d'en reprendre une autre : une personne
// marquée partie ne la retient plus (son doublon, par exemple), une personne
// présente oui. Créer une place reste refusé même après un départ
// (soloDeviceOwner) : la personne partie peut être réactivée par le bar.
function activeSoloDeviceOwner(req) {
  const owner = soloDeviceOwner(req);
  return owner && !owner.withdrawnAt ? owner : null;
}

// Reprise d'un profil par ce navigateur : il quitte sa place partie, qui
// revient sans téléphone si le bar la réactive (jamais deux places actives
// pour un navigateur), ou la place sans prénom d'un QR personnel, qui reste
// à son papier. Le téléphone actuel est le dernier de la liste : à sa
// place, une empreinte qu'aucun navigateur n'envoie, pour qu'un ancien
// téléphone écarté par un transfert ne redevienne pas le téléphone actuel.
function releaseSoloDevice(req, owner) {
  const hash = soloCookieHash(req);
  if (!hash || !Array.isArray(owner.soloDeviceHashes)) return;
  const current = owner.soloDeviceHashes.at(-1) === hash;
  owner.soloDeviceHashes = owner.soloDeviceHashes.filter(saved => saved !== hash);
  if (current && owner.soloDeviceHashes.length) owner.soloDeviceHashes.push(crypto.randomBytes(32).toString('hex'));
  if (!owner.soloDeviceHashes.length) delete owner.soloDeviceHashes;
}

function personLeftError() {
  const error = new Error('Cette personne a été marquée partie. Demande au bar de la réactiver.');
  error.code = 'PERSON_LEFT';
  return error;
}

// Place provisoire de ce navigateur, encore sans prénom ni titre (le QR de
// l'événement rescanné depuis une autre application) : comme une place
// partie, elle ne retient pas une reprise. La reprise la retire sans trace
// (rien au journal tant qu'il n'y a pas de prénom).
function disposablePlaceholder(person) {
  return !!person && !person.withdrawnAt && !!person.nameRequired && !sched.songsOf(person).length;
}

// Seul le téléphone actuel de cette place la retire. Une reprise d'une place
// sans prénom en détache aussitôt tous les autres navigateurs (claimPerson).
function ownDisposablePlaceholder(req, person) {
  return disposablePlaceholder(person) && currentSoloDevice(req, person);
}

// Place provisoire du QR de l'événement (sans clé personnelle) : la seule
// qu'un QR personnel neuf, ou la reprise d'une autre place sans prénom,
// retire. Celle d'un QR personnel garde ce QR (peut-être celui de quelqu'un
// d'autre) : elle ne part que pour reprendre un profil nommé (son propriétaire
// revenu sur ce navigateur, RT1).
function ownEventPlaceholder(req, person) {
  return ownDisposablePlaceholder(req, person) && !!person.viaEvent && !person.soloKeyHash;
}

// Créer une place depuis ce navigateur : refusé s'il en a déjà une, en disant
// pourquoi (personne marquée partie dont il est le téléphone actuel : le bar
// la réactive ; un ancien téléphone de cette personne n'a rien à réactiver).
function refuseSoloDeviceOwner(req, owner) {
  if (owner?.withdrawnAt && currentSoloDevice(req, owner)) throw personLeftError();
  if (owner) throw soloDeviceError('SOLO_DEVICE_USED');
}

function soloDeviceError(code) {
  const error = new Error(code === 'SOLO_DEVICE_USED' ?
    'Ce téléphone a déjà un prénom inscrit. Chacun utilise son propre téléphone.' :
    'Ce téléphone ne gère pas cette personne. Demande au bar un code de reprise si tu as changé de téléphone.');
  error.code = code;
  return error;
}

function requireSoloInvitation(table, token) {
  if (!soloInvitations.verify(token, table.id)) {
    const error = new Error('Demande au bar ton QR individuel pour t’inscrire. Ce lien sert à consulter la file.');
    error.code = 'SOLO_INVITATION';
    throw error;
  }
}

function requireSoloControl(req, person) {
  if (sched.table(person.tableId, false)?.individual && soloDeviceOwner(req)?.id !== person.id) {
    throw soloDeviceError('SOLO_DEVICE_ACCESS');
  }
}

// Le téléphone qui gère déjà cette personne garde son cookie (une reprise
// redemandée n'ajoute rien). Au plus les 8 derniers téléphones sont gardés,
// l'actuel en dernier.
const SOLO_DEVICE_HISTORY = 8;
function bindSoloDevice(req, res, person) {
  if (currentSoloDevice(req, person)) return;
  const value = crypto.randomBytes(24).toString('base64url');
  const hash = crypto.createHash('sha256').update(value).digest('hex');
  person.soloDeviceHashes = [...new Set([...(person.soloDeviceHashes || []), hash])].slice(-SOLO_DEVICE_HISTORY);
  res.setHeader('Set-Cookie', `${SOLO_COOKIE}=${value}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax${SERVER || req.socket.localPort === PUBLIC_PORT ? '; Secure' : ''}`);
}

// Téléphone actuel d'un solo : le dernier associé (une reprise en ajoute un).
// Les anciens restent « propriétaires » pour SOLO_DEVICE_USED, sans plus gérer.
function currentSoloDevice(req, person) {
  const hash = soloCookieHash(req);
  return !!hash && Array.isArray(person.soloDeviceHashes) && person.soloDeviceHashes.at(-1) === hash;
}

// Le QR individuel reste la clé personnelle de son chanteur pour la soirée :
// rouvert ailleurs, il retrouve cette personne, jamais une deuxième place.
// keyHolder : la personne de cette clé, même marquée partie ou revenue depuis ;
// keyTarget : la même, seulement si sa clé vit encore. Marquée partie une
// fois, la clé meurt pour de bon (soloKeyRevoked, scheduler.leave) : réactivée,
// la personne ne se reprend plus que par un QR de reprise du bar.
function keyHolder(key, table) {
  const hash = SoloInvitations.digest(key);
  if (!hash) return null;
  const digest = Buffer.from(hash, 'hex');
  return sched.tableSingers(table.id).find(person =>
    typeof person.soloKeyHash === 'string' && /^[a-f0-9]{64}$/.test(person.soloKeyHash) &&
    crypto.timingSafeEqual(Buffer.from(person.soloKeyHash, 'hex'), digest)) || null;
}
function keyTarget(key, table) {
  const holder = keyHolder(key, table);
  return holder && !holder.withdrawnAt && !holder.soloKeyRevoked ? holder : null;
}

function soloKeyRevokedError() {
  const error = new Error('Ce QR personnel n’est plus valable. Demande au bar un QR de reprise.');
  error.code = 'SOLO_KEY_REVOKED';
  return error;
}

// Prénom déjà pris par un soliste : la reprise par code (« Déjà inscrit ?
// J’ai un code ») ne vaut que si sa personne peut apparaître dans la liste de
// reprise de ce téléphone (même règle que publicState et /api/state) : place
// sans prénom ni titre dont ce navigateur est le téléphone actuel, personne
// du même groupe, pas partie. Sinon (partie, autre groupe), voir le bar.
function nameRecoverable(req, person, name) {
  const wanted = String(name || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('fr');
  const rival = sched.nameRivals(person.tableId, person.id).find(other => other.name.toLocaleLowerCase('fr') === wanted);
  return !!rival && ownDisposablePlaceholder(req, person) && rival.tableId === person.tableId && !rival.withdrawnAt;
}

function requireNamed(person) {
  if (person.nameRequired) {
    const error = new Error('Indique d’abord ton prénom.');
    error.code = 'NAME_REQUIRED';
    throw error;
  }
}

// Page visible : au plus un relevé par minute (chaque relevé change la sauvegarde).
// Exception : place encore sans prénom, sa première relecture passé la
// première seconde après l'ouverture compte tout de suite ; une invitée qui a
// vu sa fenêtre de prénom quelques secondes garde sa place (PrivateEvent.abandoned).
function touchSeen(person, now = Date.now()) {
  const last = Number(person.lastSeen) || 0;
  const opened = Number(person.joinedAt) || 0;
  const firstRead = !!person.nameRequired && last <= opened + 1000 && now > opened + 1000;
  if (firstRead || now - last >= 60000) person.lastSeen = now;
}

// Prénom provisoire unique : « Solo 1 », « Solo 2 »… le plus petit libre.
function placeholderName(tableId) {
  const taken = new Set(sched.nameRivals(tableId).map(person => person.name.toLocaleLowerCase('fr')));
  let n = 1;
  while (taken.has(`solo ${n}`)) n++;
  return `Solo ${n}`;
}

// Mode serveur : adresse du téléphone. L'en-tête KARAOKE_CLIENT_IP_HEADER (posé
// par le relais HTTPS) n'est cru que d'une connexion venue d'un proxy de
// KARAOKE_TRUSTED_PROXIES et seulement s'il porte une seule adresse IP ;
// sinon, l'adresse de la connexion. cf-connecting-ip n'a rien de particulier.
function serverClientAddress(req) {
  const socket = req.socket?.remoteAddress || '';
  if (SERVER.clientIpHeader && net.isIP(socket) &&
      SERVER.trustedProxies.check(socket, net.isIPv6(socket) ? 'ipv6' : 'ipv4')) {
    const value = String(req.headers?.[SERVER.clientIpHeader] ?? '').trim().slice(0, 64);
    if (net.isIP(value)) return value;
  }
  return socket;
}

// Appareil qui scanne le QR de l'événement. Sur le Wi-Fi : l'adresse de la
// connexion, jamais X-Forwarded-For (un en-tête que n'importe quel script peut
// inventer). Par le tunnel, tout arrive de 127.0.0.1 : l'adresse que
// Cloudflare réécrit (CF-Connecting-IP) ; sans elle, null = pas de limite par
// appareil, celle du bar seulement. L'adresse IPv4, ou le préfixe /64 d'une
// adresse IPv6 (clientKey, dans private-event.js).
// Mode serveur : même règle sur les deux ports (serverClientAddress).
function eventClient(req) {
  if (SERVER) return clientKey(serverClientAddress(req));
  if (req.socket?.localPort !== PUBLIC_PORT) return clientKey(req.socket?.remoteAddress);
  const edge = req.headers['cf-connecting-ip'];
  return typeof edge === 'string' && edge.trim() ? `cf:${clientKey(edge.slice(0, 64))}` : null;
}

// Plafond de l'événement atteint (création d'une place ou son premier
// prénom) : 403, sans nouvel essai automatique, le bar donne un QR individuel.
function privateEventFullError() {
  const error = new Error('L’événement est complet par ce QR : demande au bar un QR individuel.');
  error.code = 'PRIVATE_EVENT_FULL';
  return error;
}

// Place provisoire retirée sans trace (rien au journal tant qu'il n'y a pas
// de prénom) : son téléphone ne gère plus personne.
function dropPlaceholder(person) {
  sched.people.delete(person.id);
  sched.byToken.delete(person.token);
  personShareCodes.delete(person.id);
}

// Départ (« Je pars », « Parti » du bar) : comme la clé personnelle
// (scheduler.leave), le lien et le code de reprise en attente meurent ;
// « Réactiver » ne les ranime pas, le bar donne un nouveau QR de reprise.
function leavePerson(person, by) {
  sched.leave(person, by);
  personShareCodes.delete(person.id);
}

// Personne sans aucun historique dans la soirée : jamais montée sur scène
// (ni en duo), pas comptée dans le tour en cours, aucun titre demandé
// (jamais entrée dans la file) ni en route vers KaraFun, aucun duo (titre,
// invitation, demande ou répit), aucun vote ni proposition dans la Battle en
// cours. Sa fiche peut disparaître : ni la file, ni le tour, ni l'ordre du
// bar ne la citent (la reprise de la sauvegarde refuserait une personne
// inconnue). Le tour se vérifie à part : un duo retiré de KaraFun sans être
// chanté, après une autre intervention du bar, remet les compteurs de son
// invitée à zéro mais peut la laisser dans le tour qu'il avait ouvert
// (rollbackUnplayed ; vérification de la troisième passe).
function withoutHistory(person) {
  const id = person.id;
  const ballot = battleVote.ballot;
  return !person.sung && !person.duetGuestCount && !person.lastAppearanceTurn && !sched.roundPeople.has(id) &&
    !sched.songsOf(person).length && !sched.Q.includes(id) &&
    ![pending?.sel, ...tracked.map(tr => tr.sel)].some(sel => sel?.ids?.includes(id)) &&
    !person.duet && !person.duetOf && !person.invite && !sched.duetCooldowns.has(id) &&
    ![...sched.people.values()].some(owner => sched.songsOf(owner).some(song =>
      Array.isArray(song.duoRequests) && song.duoRequests.some(row => row?.fromId === id))) &&
    !(ballot && (ballot.proposerId === id || ballot.votes?.some(([voter]) => voter === id)));
}

// « Je pars » (POST /api/leave) d'une personne de l'événement privé sans
// aucun historique (troisième passe de la relecture finale) : une fiche
// partie ne garderait rien d'utile, et une boucle prénom puis départ en
// laissait une de plus à chaque tour. Comme une place provisoire, la fiche
// disparaît (son prénom se libère, elle ne compte pas dans les fiches de
// l'événement) ; son inscription est au journal, son départ y est noté comme
// par leavePerson (person.left, par elle-même, aucun titre retiré).
function forgetEventPerson(person) {
  journalEvent('person.left', { personId: person.id, by: 'self', songsDropped: 0 });
  sched.note(`${sched.personRef(person)} est parti sans titre ni passage : sa fiche est retirée`);
  dropPlaceholder(person);
  seenJournal.delete(person.id);
}

// Avant chaque création par le QR de l'événement : les places sans prénom
// abandonnées (PrivateEvent.abandoned, sans titre, sans code ni lien de
// reprise encore valable donné par le bar) partent sans trace. Une boucle
// sans cookie ne fait plus grossir la soirée ; une page qui revient après
// coup rescanne le QR de l'événement pour une nouvelle place.
function sweepAbandonedEventPlaces(now = Date.now()) {
  const shared = person => {
    const saved = personShareCodes.get(person.id);
    return !!saved && Math.max(saved.expiresAt, saved.linkExpiresAt) > now;
  };
  const abandoned = [...sched.people.values()].filter(person =>
    PrivateEvent.abandoned(person, now) && disposablePlaceholder(person) && !shared(person));
  abandoned.forEach(dropPlaceholder);
  if (abandoned.length) sched.version++;
}

// Chanteur créé à l'ouverture d'un QR (individuel ou d'événement), avant son
// prénom. Même règle que joinPersonDurably : rien n'est annoncé tant que la
// soirée n'est pas sauvegardée, et tout est défait sinon. Le ménage des places
// abandonnées se fait avant et pour lui-même : une création refusée ou non
// sauvegardée le laisse fait, avec son numéro de version (les pages le voient).
function createPlaceholderDurably(req, res, table, { invitation = null, viaEvent = false } = {}) {
  const now = Date.now();
  const client = eventClient(req);
  let person = null, admittedAt = null;
  if (viaEvent) {
    sweepAbandonedEventPlaces(now);
    // Seules les personnes nommées et présentes comptent (les parties
    // libèrent leur place, une place sans prénom ne coûte rien à la
    // prévision) ; le premier prénom d'une place revérifie ce plafond.
    // Plafond dur : 400 fiches de l'événement, pas parties ou parties
    // d'elles-mêmes (PrivateEvent.held). Un refus ne change rien et n'écrit
    // rien, pas même `version` (relecture finale fraîche) : une écriture
    // oublierait la prévision gardée, et chaque refus, ou chaque nouvel essai
    // d'un téléphone pendant une affluence, la ferait recalculer.
    const admitted = privateEvent.admit(PrivateEvent.present(sched.people.values()), client, now,
      PrivateEvent.held(sched.people.values()));
    if (admitted === 'full') throw privateEventFullError();
    if (admitted !== 'ok') {
      const busy = new Error('Trop d’inscriptions d’un coup : réessaie dans une minute.');
      busy.code = 'PRIVATE_EVENT_BUSY';
      busy.retryAfter = privateEvent.retryAfter(client, now);
      throw busy;
    }
    admittedAt = now;
  }
  const before = { log: sched.log.slice(), version: sched.version, invitations: soloInvitations.serialize(),
    cookie: res.getHeader('Set-Cookie') };
  try {
    person = sched.join({ tableId: table.id, name: placeholderName(table.id), nameRequired: true });
    if (invitation) {
      soloInvitations.consume(invitation, table.id);
      person.soloKeyHash = SoloInvitations.digest(invitation);
    }
    if (viaEvent) person.viaEvent = true;
    bindSoloDevice(req, res, person);
    saveNight({ required: true });
  } catch (error) {
    if (person) {
      sched.people.delete(person.id);
      sched.byToken.delete(person.token);
    }
    if (admittedAt !== null) privateEvent.release(admittedAt, client);
    soloInvitations.restore(before.invitations);
    sched.log = before.log;
    // Version inchangée : rien de ce qu'elle couvre n'a bougé, la prévision
    // gardée reste juste (pas de réécriture, voir Scheduler#version).
    if (sched.version !== before.version) sched.version = before.version;
    if (before.cookie === undefined) res.removeHeader('Set-Cookie');
    else res.setHeader('Set-Cookie', before.cookie);
    throw error;
  }
  res.nightAlreadySaved = true;
  return { id: person.id, token: person.token, nameRequired: true };
}

// POST /api/table/solo/open : la page ouverte par un QR individuel (jamais une
// lecture GET : un aperçu de lien ne crée personne).
function openSoloInvitation(req, res, body) {
  const t = tableByAccess(body.table, body.access);
  if (!t.individual) throw new Error('Ce QR individuel n’est pas valable pour cette table.');
  const owner = soloDeviceOwner(req);
  const known = keyTarget(body.invitation, t);
  if (known) {
    // Reprise par la clé personnelle : seule une place active la bloque
    // (pas une place provisoire sans prénom de ce navigateur).
    const active = activeSoloDeviceOwner(req);
    if (active && active.id !== known.id && !ownDisposablePlaceholder(req, active)) throw soloDeviceError('SOLO_DEVICE_USED');
    // Le téléphone qui la gère rouvre son QR : la même personne.
    if (currentSoloDevice(req, known)) {
      known.lastActionAt = Date.now();
      return { id: known.id, token: known.token, nameRequired: !!known.nameRequired };
    }
    // Autre navigateur : proposer « C'est bien toi ? » ; sans prénom encore,
    // rien à confirmer, la page est reprise tout de suite.
    if (!known.nameRequired) return { recover: { id: known.id, name: known.name } };
    const claimed = claimPersonDurably({ table: body.table, access: body.access, key: body.invitation }, req, res);
    return { ...claimed, nameRequired: true, recovered: true };
  }
  // QR personnel d'une personne marquée partie, sur ce navigateur ou un
  // autre : le dire (comme le QR de l'événement), pas « invitation utilisée ».
  // Revenue depuis, sa clé est morte : le bar lui donne un QR de reprise.
  const holder = keyHolder(body.invitation, t);
  if (holder?.withdrawnAt) throw personLeftError();
  if (holder?.soloKeyRevoked) throw soloKeyRevokedError();
  if (!soloInvitations.verify(body.invitation, t.id)) {
    const error = new Error('Cette invitation a déjà été utilisée ou a expiré. Demande un nouveau QR individuel au bar.');
    error.code = 'SOLO_INVITATION';
    throw error;
  }
  if (owner && !ownEventPlaceholder(req, owner)) refuseSoloDeviceOwner(req, owner);
  if (!owner) return createPlaceholderDurably(req, res, t, { invitation: body.invitation });
  // Place sans prénom ni titre de ce navigateur (QR de l'événement) : elle
  // part sans trace, jamais deux places ; elle revient si la sauvegarde
  // échoue, avec son code de reprise.
  const ownerCode = personShareCodes.get(owner.id);
  dropPlaceholder(owner);
  try {
    return createPlaceholderDurably(req, res, t, { invitation: body.invitation });
  } catch (error) {
    sched.people.set(owner.id, owner);
    sched.byToken.set(owner.token, owner.id);
    if (ownerCode) personShareCodes.set(owner.id, ownerCode);
    throw error;
  }
}

// POST /api/table/enter : QR de l'événement privé. Même navigateur : son
// chanteur revient. Autre navigateur : toujours un nouveau chanteur (pas de
// reprise par prénom, décision du gérant).
// Une personne inscrite (prénom donné, pas partie) dont ce navigateur est le
// téléphone actuel revient même avec un QR renouvelé ou un mode coupé : les
// inscrits gardent leur accès. Seule une nouvelle place exige le QR actif.
function enterPrivateEvent(req, res, body) {
  const t = tableByAccess(body.table, body.access);
  const found = t.individual ? soloDeviceOwner(req) : null;
  const owner = found && currentSoloDevice(req, found) ? found : null;
  const resume = () => {
    owner.lastActionAt = Date.now();
    return { id: owner.id, token: owner.token, nameRequired: !!owner.nameRequired, resumed: true };
  };
  if (owner && !owner.withdrawnAt && !owner.nameRequired) return resume();
  // Le secret n'est donné que pour « En solo » (Comptoir, voir
  // privateEventView) : un autre groupe individuel le refuse.
  if (!t.individual || t.id !== 'Comptoir' || !privateEvent.verify(body.event)) {
    const error = new Error('Ce QR d’événement n’est plus actif. Demande au bar.');
    error.code = 'PRIVATE_EVENT';
    throw error;
  }
  if (owner) {
    if (owner.withdrawnAt) throw personLeftError();
    return resume();
  }
  return createPlaceholderDurably(req, res, t, { viaEvent: true });
}

// Vue du bar : adresse et QR seulement quand le mode est allumé.
function privateEventView() {
  const url = privateEvent.enabled && privateEvent.secret && access.get('Comptoir') ?
    `${access.url(phoneBase(), 'Comptoir')}?evenement=${privateEvent.secret}` : null;
  return { enabled: !!url, url, qrUrl: url ? '/qr-evenement.svg' : null };
}

function joinPersonDurably(req, res, table, body, photo = null) {
  const before = {
    headcount: table.headcount, log: sched.log.slice(), version: sched.version,
    invitations: soloInvitations.serialize(),
    cookie: res.getHeader('Set-Cookie'),
  };
  let person;
  try {
    person = sched.join({ tableId: table.id, name: body.name, photo,
      headcount: body.headcount });
    if (table.individual) {
      soloInvitations.consume(body.invitation, table.id);
      person.soloKeyHash = SoloInvitations.digest(body.invitation);
      bindSoloDevice(req, res, person);
    }
    // Ne jamais annoncer une inscription que le disque n'a pas conservée :
    // sinon un QR individuel est brûlé et une place devient inaccessible.
    saveNight({ required: true });
  } catch (error) {
    if (person) {
      sched.people.delete(person.id);
      sched.byToken.delete(person.token);
    }
    table.headcount = before.headcount;
    soloInvitations.restore(before.invitations);
    sched.log = before.log;
    // Inscription refusée avant tout changement (prénom déjà pris…) : la
    // version n'a pas bougé et n'est pas réécrite (prévision gardée).
    if (sched.version !== before.version) sched.version = before.version;
    if (before.cookie === undefined) res.removeHeader('Set-Cookie');
    else res.setHeader('Set-Cookie', before.cookie);
    throw error;
  }
  res.nightAlreadySaved = true;
  // Cette personne n'a pas encore de chanson : une erreur de synchronisation
  // ne doit pas transformer une inscription sauvegardée en échec côté client.
  try { sync(); } catch (error) { appLog(`Synchronisation après inscription différée : ${error.message}`); }
  return { id: person.id, token: person.token };
}

// Activité d'une personne (spec C1) : seule une action ACCEPTÉE compte. Les
// routes réclament l'activité sur le corps de la requête (un objet propre à
// chaque requête) ; le répartiteur des POST ne la note qu'après le succès du
// traitement. Un refus (prénom déjà pris ou vide, toute erreur 4xx) ne la
// touche donc jamais, quelle que soit la route.
const PENDING_ACTIVITY = Symbol('activité en attente');
function claimActivity(body, person) {
  if (body && typeof body === 'object') body[PENDING_ACTIVITY] = person;
}
function creditActivity(body) {
  const person = body && typeof body === 'object' ? body[PENDING_ACTIVITY] : null;
  if (person) person.lastActionAt = Date.now();
}

// `passive` : geste automatique de la page (accusé des messages), qui ne
// compte pas comme activité de la personne.
function personAtTable(body, { passive = false } = {}) {
  const t = tableByAccess(body.table, body.access);
  const p = sched.people.get(String(body.personId || ''));
  if (!p || p.tableId !== t.id) {
    const e = new Error('Chanteur inconnu à cette table.'); e.code = 'NO_PERSON'; throw e;
  }
  if (p.withdrawnAt) throw personLeftError();
  if (!body.token || body.token !== p.token) {
    const e = new Error('Ce téléphone ne gère pas ce chanteur. Demande-lui son code de partage, ou vois avec le bar.');
    e.code = 'PERSON_ACCESS'; throw e;
  }
  if (!passive) claimActivity(body, p);
  return p;
}

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest();
const TRANSFER_LINK_MS = 30 * 60 * 1000;

// Un transfert se fait par lien (QR à scanner ou message WhatsApp, SMS,
// e-mail…) ou, à défaut, par un code à 4 chiffres saisi sur la page de la
// table. Les deux servent une seule fois : le premier utilisé annule l'autre.
async function createPersonShareCode(p) {
  const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  const link = crypto.randomBytes(16).toString('base64url');
  const now = Date.now();
  const expiresAt = now + 10 * 60 * 1000;
  const linkExpiresAt = now + TRANSFER_LINK_MS;
  let url = null, qr = null;
  try {
    url = `${access.url(phoneBase(), p.tableId)}?reprise=${link}`;
    qr = await QRCode.toDataURL(url, { margin: 1, errorCorrectionLevel: 'M' });
  } catch (error) { url = null; appLog(`Lien de transfert indisponible : ${error.message}`); }
  // Pendant le QR, la personne a pu partir (place retirée, marquée partie) :
  // pas de code pour elle.
  if (sched.people.get(p.id) !== p || p.withdrawnAt) throw new Error('Chanteur inconnu ou parti.');
  personShareCodes.set(p.id, { hash: sha256(code), expiresAt, attempts: 0,
    linkHash: url ? sha256(link) : null, linkExpiresAt: url ? linkExpiresAt : 0 });
  return { code, expiresAt, url, qr, linkExpiresAt: url ? linkExpiresAt : null, name: p.name };
}

// Seulement les personnes encore dans la soirée (la reprise ignore les autres).
function transferSnapshot() {
  const now = Date.now();
  return [...personShareCodes].filter(([personId, saved]) => sched.people.has(personId) &&
    Math.max(saved.expiresAt, saved.linkExpiresAt) > now)
    .map(([personId, saved]) => ({ personId, hash: saved.hash.toString('hex'), expiresAt: saved.expiresAt,
      attempts: saved.attempts, linkHash: saved.linkHash ? saved.linkHash.toString('hex') : null,
      linkExpiresAt: saved.linkExpiresAt }));
}

function restoreTransfers(rows) {
  personShareCodes.clear();
  for (const row of rows) personShareCodes.set(row.personId, { hash: Buffer.from(row.hash, 'hex'),
    expiresAt: row.expiresAt, attempts: row.attempts, linkExpiresAt: row.linkExpiresAt,
    linkHash: row.linkHash ? Buffer.from(row.linkHash, 'hex') : null });
}

// Retrouve la personne visée par un lien de transfert encore valable.
function transferTarget(link, table) {
  if (typeof link !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(link)) return null;
  const digest = sha256(link);
  for (const [personId, saved] of personShareCodes) {
    if (!saved.linkHash || Date.now() > saved.linkExpiresAt ||
        !crypto.timingSafeEqual(saved.linkHash, digest)) continue;
    const person = sched.people.get(personId);
    return person && !person.withdrawnAt && person.tableId === table.id ? person : null;
  }
  return null;
}

function claimPerson(body, req, res) {
  const t = tableByAccess(body.table, body.access);
  const p = sched.people.get(String(body.personId || ''));
  if (!p || p.tableId !== t.id || p.withdrawnAt) throw new Error('Chanteur indisponible à cette table.');
  // Reprise (QR de reprise, QR personnel, code) : une place partie de ce
  // navigateur ne la bloque pas, ni une place provisoire sans prénom dont il
  // est le téléphone actuel ; une place active si.
  const goneOwner = t.individual ? soloDeviceOwner(req) : null;
  if (t.individual) {
    const owner = activeSoloDeviceOwner(req);
    if (owner && owner.id !== p.id && !(p.nameRequired ? ownEventPlaceholder(req, owner) : ownDisposablePlaceholder(req, owner))) {
      throw soloDeviceError('SOLO_DEVICE_USED');
    }
  }
  const saved = personShareCodes.get(p.id);
  if (body.key !== undefined) {
    // Même règle que l'ouverture du QR (openSoloInvitation, D2). Personne
    // marquée partie (PERSON_LEFT) : refusée avant, par claimPersonDurably,
    // seul appelant, qui résout la clé.
    if (keyTarget(body.key, t)?.id !== p.id) throw soloKeyRevokedError();
  } else if (body.link !== undefined) {
    // Le lien contient un secret de 128 bits : pas de limite de tentatives.
    if (transferTarget(body.link, t)?.id !== p.id) {
      throw new Error('Ce lien de transfert a expiré ou a déjà servi. Demande un nouveau lien ou un code au bar.');
    }
  } else {
    if (!saved || Date.now() > saved.expiresAt || saved.attempts >= 5) {
      if (saved && Date.now() > saved.linkExpiresAt) personShareCodes.delete(p.id);
      throw new Error('Code de partage expiré. Demande un nouveau code au chanteur ou au bar.');
    }
    saved.attempts++;
    const input = String(body.code || '').trim();
    if (!/^[0-9]{4}$/.test(input) || !crypto.timingSafeEqual(saved.hash, sha256(input))) {
      // Trop d'erreurs : le code est brûlé, le lien reste utilisable.
      if (saved.attempts >= 5 && Date.now() > saved.linkExpiresAt) personShareCodes.delete(p.id);
      throw new Error('Code de partage incorrect.');
    }
  }
  personShareCodes.delete(p.id);
  // Une reprise transfère la gestion : l'ancien téléphone perd immédiatement
  // le droit de modifier les chansons de cette personne.
  sched.byToken.delete(p.token);
  p.token = crypto.randomBytes(16).toString('hex');
  sched.byToken.set(p.token, p.id);
  if (t.individual) {
    if (goneOwner && goneOwner.id !== p.id && ownEventPlaceholder(req, goneOwner)) {
      // Jamais deux places actives pour un navigateur : la place provisoire
      // du QR de l'événement part, avec son code de reprise.
      dropPlaceholder(goneOwner);
    } else if (goneOwner && goneOwner.id !== p.id) {
      // Place partie, ou place sans prénom d'un QR personnel (peut-être celui
      // de quelqu'un d'autre, ouvert par erreur) : ce navigateur la quitte,
      // elle reste à son papier, que son propriétaire rescanne.
      releaseSoloDevice(req, goneOwner);
    }
    // Place encore sans prénom reprise ailleurs (papier donné à quelqu'un
    // d'autre, autre application) : rien à protéger, ses anciens navigateurs
    // en sont détachés tout de suite et chacun peut ouvrir sa propre place.
    if (p.nameRequired && !currentSoloDevice(req, p)) delete p.soloDeviceHashes;
    bindSoloDevice(req, res, p);
  }
  p.lastActionAt = Date.now();
  journalEvent('person.transferred', { personId: p.id });
  sched.note(`${p.name} est désormais géré depuis un autre téléphone`, 'info');
  return { id: p.id, token: p.token };
}

function claimPersonDurably(body, req, res) {
  if (body.key !== undefined) {
    // Même refus que l'ouverture du même QR (openSoloInvitation, D2) :
    // personne marquée partie, PERSON_LEFT (le bar la réactive) ; clé
    // inconnue ou morte (réactivée depuis), SOLO_KEY_REVOKED (403, QR de
    // reprise), même texte sur le téléphone.
    const table = tableByAccess(body.table, body.access);
    if (keyHolder(body.key, table)?.withdrawnAt) throw personLeftError();
    const target = keyTarget(body.key, table);
    if (!target) throw soloKeyRevokedError();
    body = { ...body, personId: target.id };
  } else if (body.link !== undefined) {
    const target = transferTarget(body.link, tableByAccess(body.table, body.access));
    if (!target) throw new Error('Ce lien de transfert a expiré ou a déjà servi. Demande un nouveau lien ou un code au bar.');
    body = { ...body, personId: target.id };
  }
  const id = String(body.personId || '');
  const person = sched.people.get(id);
  const code = personShareCodes.get(id);
  const attempts = code?.attempts;
  const oldToken = person?.token;
  const oldDeviceHashes = person?.soloDeviceHashes?.slice();
  // Place partie que ce navigateur quitte en reprenant ce profil.
  const goneOwner = person && sched.table(person.tableId, false)?.individual ? soloDeviceOwner(req) : null;
  const goneOwnerHashes = goneOwner?.soloDeviceHashes?.slice();
  const goneOwnerCode = goneOwner ? personShareCodes.get(goneOwner.id) : undefined;
  const oldSoloInvitations = soloInvitations.serialize();
  const oldLog = sched.log.slice();
  const oldVersion = sched.version;
  const hadCookie = res.hasHeader('Set-Cookie');
  const oldCookie = res.getHeader('Set-Cookie');
  // Un code erroné continue de compter comme tentative. Le retour arrière
  // ci-dessous n'a lieu qu'après un code valide et une erreur de sauvegarde.
  const result = claimPerson(body, req, res);
  if (person && sched.table(person.tableId, false)?.individual &&
      soloInvitations.verify(body.invitation, person.tableId)) {
    soloInvitations.consume(body.invitation, person.tableId);
  }
  try {
    saveNight({ required: true });
  } catch (error) {
    sched.byToken.delete(person.token);
    person.token = oldToken;
    sched.byToken.set(oldToken, person.id);
    if (oldDeviceHashes) person.soloDeviceHashes = oldDeviceHashes;
    else delete person.soloDeviceHashes;
    if (goneOwner && goneOwner !== person) {
      goneOwner.soloDeviceHashes = goneOwnerHashes;
      // Place provisoire retirée par la reprise : elle revient telle quelle,
      // avec son code de reprise.
      if (!sched.people.has(goneOwner.id)) {
        sched.people.set(goneOwner.id, goneOwner);
        sched.byToken.set(goneOwner.token, goneOwner.id);
        if (goneOwnerCode) personShareCodes.set(goneOwner.id, goneOwnerCode);
      }
    }
    soloInvitations.restore(oldSoloInvitations);
    if (code) { code.attempts = attempts; personShareCodes.set(id, code); }
    sched.log = oldLog;
    sched.version = oldVersion;
    if (hadCookie) res.setHeader('Set-Cookie', oldCookie);
    else res.removeHeader('Set-Cookie');
    throw error;
  }
  return result;
}

function repeatWindowMs() {
  return (Number(settings.repeatWarnMin) || 0) * 60000;
}

// Alerte non bloquante pour la personne qui choisit un titre déjà chanté
// récemment ou déjà prévu dans la file. `entryId` : le titre qu'elle vient
// d'ajouter, pour dire si l'autre passage est prévu avant le sien.
function repeatNotice(song, tableId, entryId = null) {
  return songNotice({ song, entryId, queue: publicState(null, tableId).queue,
    played: sched.playedSongs, now: Date.now(), windowMs: repeatWindowMs() });
}

function chooseFor(p, song, mode) {
  assertDuoAllowed();
  assertSongLength(p, [song], 'song');
  const songId = Number(song?.songId);
  if ([...(pending && pending.sel.ids.includes(p.id) ? [pending.sel.song] : []),
    ...tracked.filter(tr => tr.sel.ids.includes(p.id)).map(tr => tr.sel.song)]
    .some(s => s.songId === songId)) {
    const e = new Error('Cette chanson est déjà envoyée à KaraFun pour ce chanteur.');
    e.code = 'ALREADY_IN_KARAFUN'; throw e;
  }
  // Duo en route vers KaraFun : remplacer la liste de son auteur annoncerait
  // l'annulation du duo, qui partirait pourtant à deux (voir /song/remove).
  if (mode === 'replace' && pending && !pending.cancelled && pending.sel.ids.length > 1 && pending.sel.ids[0] === p.id) {
    throw new Error('Ce titre est en cours d’envoi à KaraFun. Réessaie dans un instant.');
  }
  sched.chooseSong(p, withCover(song), mode);
  sync();
  const added = sched.songsOf(p).find(item => item.songId === songId);
  return added ? repeatNotice(added, p.tableId, added.entryId) : null;
}

// « Duos uniquement » : un client n'ajoute plus de solo (titre ou
// remplacement) ; duos, demandes de duo et titres déjà choisis restent.
function assertDuoAllowed() {
  if (!settings.duoOnly) return;
  const error = new Error('Ce soir, le bar ne prend que des duos : choisis un titre puis « Chanter en duo ».');
  error.code = 'DUO_ONLY';
  throw error;
}

// « Duos uniquement » : un duo accepté et encore prévu ne redevient pas un
// solo par le client (inviter puis annuler contournait la règle) : ni par
// son auteur, ni par l'invitée de la même table (duo accepté d'office). Le
// titre peut être retiré ; une invitation en attente peut être annulée, et
// une invitation d'une autre table déclinée, expirée ou quittée part en solo.
// Un duo ouvert, qui ne part pas sans partenaire dans ce mode, ne se ferme
// pas non plus en solo.
function assertDuoKept(p, entryId) {
  if (!settings.duoOnly) return;
  const key = entryId ? String(entryId) : null;
  const own = sched.songsOf(p).some(song => ['accepted', 'open'].includes(song.duet?.state) && (!key || song.entryId === key));
  const guest = !own && sched.guestDuetsOf(p).find(duo => !key || duo.entryId === key);
  if (!own && !(guest && sched.people.get(guest.ownerId)?.group === p.group)) return;
  const error = new Error(own ? 'Ce soir, le bar ne prend que des duos : garde ton duo ou retire ce titre.'
    : 'Ce soir, le bar ne prend que des duos : l’auteur du titre peut le retirer.');
  error.code = 'DUO_ONLY';
  throw error;
}

function confirmPresence(p) {
  if (sched.opts.requirePresence) {
    const candidate = presenceCandidate();
    const { current } = analyze();
    const currentOwner = tracked.find(tr => isOnStage(tr, current));
    if (!candidate?.ids.includes(p.id) || currentOwner?.sel.ids.includes(p.id)) {
      throw new Error('La présence sera demandée quand ce chanteur sera le prochain à passer.');
    }
  }
  sched.confirm(p);
  sync();
}

// « Priorité » avant un titre déjà chargé dans KaraFun (envoyé pushDelaySec
// après le début du titre en cours, pas encore commencé). Sans retrait, la
// priorité passe juste après lui ; confirmé par le bar (« Faire passer X avant
// « titre » ? », `pullLoaded`), le titre sort de KaraFun par le même chemin
// que « Pas prêt » (pullFromKaraFun, retrait confirmé par la file réelle de
// KaraFun avant de reprendre les envois) et repasse juste après la priorité
// (restorePulled, Scheduler#yieldToPriority). Seul un titre de la file, seul
// dans la file de KaraFun, ni sur scène ni en train d'en sortir, s'y prête :
// jamais une Battle ni un titre ajouté directement dans KaraFun ; pas pendant
// un envoi, une relance ou un vidage, ni KaraFun déconnecté, ni si la
// fermeture l'empêchait ensuite de repasser. Rend le titre suivi `tr` et la
// raison d'un refus (`started` : il vient de commencer), ou null.
function priorityPullCheck(queueId, { current, upcoming } = analyze(), now = Date.now()) {
  const same = item => queueId != null && String(item.queueId) === String(queueId);
  const tr = tracked.find(same) || null;
  const item = upcoming.find(same) || null;
  const refuse = refusal => ({ tr, refusal });
  if (tr && (tr.startedAt || isOnStage(tr, current))) return refuse('started');
  if (!bridge?.ready) return refuse('KaraFun est déconnecté : rien n’a été retiré ni avancé. Réessaie une fois KaraFun reconnecté.');
  // Déjà sur le lecteur de KaraFun (titre précédent fini, chargé ou en cours
  // de chargement, pas encore lancé) : KaraFun pourrait le garder comme titre
  // en cours après son retrait, et plus rien ne repartirait.
  const statusId = bridge?.status && (bridge.status.current || bridge.status.songPlaying || {}).queueId;
  if (tr && statusId != null && String(statusId) === String(tr.queueId)) {
    return refuse(`« ${tr.sel.song.title} » est déjà sur le lecteur de KaraFun : rien n’a été retiré ni avancé. ` +
      '« Priorité » sans retrait fait passer la personne juste après lui.');
  }
  if (isBattleItem(item)) return refuse('Une Battle chargée dans KaraFun ne sort jamais pour une priorité : rien n’a été retiré ni avancé.');
  if (pending) return refuse('Un titre part vers KaraFun en ce moment : rien n’a été retiré ni avancé. Réessaie dans un instant.');
  if (restartOp) return refuse('Le titre en cours est en train d’être relancé : rien n’a été retiré ni avancé. Réessaie dans un instant.');
  if (settings.queueClearPending) return refuse('La file est en train d’être vidée : rien n’a été retiré ni avancé.');
  if (!tr || !item || tr.cancelled || tr.pulled || tr.absent) {
    return refuse('Le titre chargé dans KaraFun a changé : rien n’a été retiré ni avancé. Touche de nouveau « Priorité ».');
  }
  if (upcoming.length > 1) {
    return refuse('D’autres titres attendent dans KaraFun : rien n’a été retiré ni avancé. « Priorité » sans retrait fait passer la personne après eux.');
  }
  if (closingBlocksStart(current, 1, now)) {
    return refuse(`Fermeture à ${hhmm(closingAt(now))} : « ${tr.sel.song.title} » ne passerait plus après la priorité. ` +
      'Rien n’a été retiré ni avancé ; « Priorité » sans retrait fait passer la personne juste après lui.');
  }
  return { tr, refusal: null };
}

// Titre que la page du bar propose de retirer pour une priorité, ou null.
function priorityPullTarget(analysis = analyze()) {
  if (analysis.upcoming.length !== 1) return null;
  const { tr, refusal } = priorityPullCheck(analysis.upcoming[0].queueId, analysis);
  return refusal ? null : tr;
}

// Vérifie le retrait demandé par le bar pour la priorité de `line` (passage
// visible de la file) : le titre que la page a nommé (`queueId`) attend
// toujours dans KaraFun. Sinon rien n'est retiré ni avancé.
function priorityPullFor(line, queueId) {
  const { tr, refusal } = priorityPullCheck(queueId);
  const name = line?.name || 'ce chanteur';
  if (refusal === 'started') {
    throw new Error(`« ${tr.sel.song.title} » a commencé pendant ta confirmation : rien n’a été retiré de KaraFun ni avancé. ` +
      `Touche de nouveau « Priorité » pour faire passer ${name} juste après.`);
  }
  if (!line) { const e = new Error('Cette chanson n’est plus dans la file du helper.'); e.code = 'SONG_SENT'; throw e; }
  if (refusal) throw new Error(refusal);
  // Une personne des deux passages chanterait deux fois de suite.
  const shared = line.ids.find(pid => tr.sel.ids.includes(pid));
  if (shared) {
    throw new Error(`${sched.people.get(shared)?.name || 'Cette personne'} chante déjà dans « ${tr.sel.song.title} » : rien n’a été retiré ni avancé.`);
  }
  // Une personne du titre en cours aussi : le titre chargé entre les deux
  // passages est le seul qui la sépare de son prochain.
  const singing = line.ids.find(pid => stageSingers().includes(pid));
  if (singing) {
    throw new Error(`${sched.people.get(singing)?.name || 'Cette personne'} est sur scène en ce moment : « ${tr.sel.song.title} » reste dans KaraFun, ` +
      `rien n’a été retiré ni avancé. « Priorité » sans retrait fait passer ${name} juste après lui.`);
  }
  return tr;
}

// Chanteurs du titre suivi sur scène (aucun pour une Battle ou un titre
// ajouté directement dans KaraFun).
function stageSingers({ current } = analyze()) {
  return [...(tracked.find(tr => isOnStage(tr, current))?.sel.ids || [])];
}

// « Pas prêt » : le prochain passage de cette personne laisse passer une ou
// plusieurs chansons sans perdre son tour. Un titre déjà chargé dans KaraFun
// en est retiré, puis reprend sa place dans la file.
// « Pas prêt » : un autre passage prêt (pas lui-même repoussé) pourra-t-il
// chanter avant celui de `ids` ? `view` : prévision déjà calculée.
function othersCanPass(ids, view = null) {
  const mine = new Set(ids.map(String));
  const ahead = view || sched.presenceView(pending ? (pending.sel.consumedIds || pending.sel.ids) : [], pending ? pending.sel : null);
  return ahead.some(v => !v.future && !v.ids.some(pid => mine.has(String(pid))) && !sched.isDeferred(sched.people.get(v.ids[0])));
}
function deferAloneError() {
  const error = new Error('Personne d’autre n’attend pour chanter : ton passage ne peut pas être repoussé.');
  error.code = 'DEFER_ALONE';
  return error;
}

function deferTurn(p, songs = 1) {
  const count = songs == null ? 1 : Number(songs);
  const active = sched.deferralFor(p.id);
  if (active) {
    const owner = sched.people.get(active.ownerId);
    if (!othersCanPass(owner.deferral.ids || [owner.id])) throw deferAloneError();
    sched.deferPassage(owner.id, { entryId: active.entryId, ids: owner.deferral.ids }, count);
    sync();
    return sched.deferralFor(p.id);
  }
  if (pending && !pending.cancelled && pending.sel.ids.includes(p.id)) {
    throw new Error('Ta chanson est en cours d’envoi à KaraFun. Réessaie dans un instant.');
  }
  const pulling = tracked.find(item => item.pulled?.reason === 'defer' && item.sel.ids.includes(p.id));
  if (pulling) throw new Error('Ton passage est déjà en train d’être repoussé. Réessaie dans un instant.');
  const { current } = analyze();
  const tr = tracked.find(item => !item.cancelled && !item.pulled && !item.absent && !item.startedAt &&
    !isOnStage(item, current) && item.sel.ids.includes(p.id));
  if (tr) {
    const owner = sched.people.get(tr.sel.ids[0]);
    if (!owner || owner.withdrawnAt) throw new Error('Chanteur inconnu ou parti.');
    // Rien ne change dans la file si KaraFun ne peut pas retirer le titre :
    // le report est vérifié, le titre retiré, puis le report enregistré.
    const passage = { entryId: tr.sel.song.entryId, ids: tr.sel.ids, song: tr.sel.song };
    sched.checkDeferral(owner.id, passage, count);
    if (!othersCanPass(tr.sel.ids)) throw deferAloneError();
    pullFromKaraFun(tr, 'defer');
    sched.deferPassage(owner.id, passage, count);
    sync();
    return { ownerId: owner.id, remaining: owner.deferral?.remaining ?? count, total: owner.deferral?.total ?? count, pendingRemoval: true };
  }
  const excluded = pending ? (pending.sel.consumedIds || pending.sel.ids) : [];
  const first = sched.presenceView(excluded, pending ? pending.sel : null)
    .find(v => !v.future && !sched.isDeferred(sched.people.get(v.ids[0])));
  if (!first || !first.ids.includes(p.id)) {
    throw new Error('Tu pourras repousser ton passage quand ta chanson sera la prochaine.');
  }
  if (!othersCanPass(first.ids)) throw deferAloneError();
  // Un envoi déjà parti chantera de toute façon avant : il ne compte pas.
  sched.deferPassage(first.ids[0], first, count, { extra: pending && !pending.cancelled ? 1 : 0 });
  sync();
  return sched.deferralFor(p.id);
}

function readyForTurn(p) {
  const pulling = tracked.find(item => item.pulled?.reason === 'defer' && item.sel.ids.includes(p.id));
  if (pulling) {
    // Le titre sort de KaraFun : il reviendra sans report.
    sched.dropDeferral(pulling.sel.ids[0], pulling.sel.song.entryId);
    sched.note(`${p.name} est prêt : son titre reprend sa place dès son retrait de KaraFun`, 'info');
  } else sched.cancelDeferral(p.id);
  sync();
}

// ------------------------------------------------------------------ heure de fermeture
const hhmm = at => new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

// Prochaine occurrence de « HH:MM » : une heure passée de moins de trois
// heures reste ce soir (fermeture atteinte), sinon c'est le lendemain.
function nextClosing(text, now = Date.now()) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('Indique l’heure de fermeture au format HH:MM, par exemple 02:00.');
  const at = new Date(now);
  at.setHours(Number(match[1]), Number(match[2]), 0, 0);
  while (at.getTime() <= now - 3 * 3600000) at.setDate(at.getDate() + 1);
  while (at.getTime() > now + 21 * 3600000) at.setDate(at.getDate() - 1);
  return at.getTime();
}

// Une fermeture oubliée ne bloque pas la soirée suivante.
const CLOSING_EXPIRE_MS = 6 * 3600000;
function closingAt(now = Date.now()) {
  const at = settings.closingAt;
  return Number.isFinite(at) && now - at < CLOSING_EXPIRE_MS ? at : null;
}

// Retrait de l'heure de fermeture. Celui d'« Options par défaut » est noté
// comme tel : fait après le début du dernier titre, les statistiques gardent
// l'heure de la soirée (voir evening-stats.js) ; avant, ou suivi d'un autre
// titre, il retire l'heure comme un retrait du bar.
function clearClosing(reason = null) {
  settings.closingAt = null;
  journalEvent('closing.cleared', reason ? { reason } : {});
  sched.note('Heure de fermeture retirée : la file n’a plus d’heure de fin.', 'staff');
}

// Titres qui passeront avant la fermeture : au moins la moitié du titre
// avant l'heure annoncée. Un nouveau chanteur entre dans le tour en cours
// (les titres suivants de chacun viennent après) : la file est complète
// quand ce tour ne peut plus accueillir un titre de plus. Simple repère : les
// ajouts restent possibles et la rotation décide qui passe avant l'heure.
// `slot` : durée moyenne d'un titre ; `step` : d'un début de titre au suivant.
function closingView(queue, firstFreeAt, slot, step = slot) {
  const now = Date.now();
  const at = closingAt(now);
  if (at == null) return null;
  const fits = item => Number.isFinite(item.eta) && item.eta + slot / 2 <= at;
  const fitCount = queue.filter(fits).length;
  const roundEnd = Math.max(now, firstFreeAt) + queue.filter(item => !item.future).length * step;
  return { at, passed: now >= at, full: now >= at || roundEnd + slot / 2 > at, fitCount,
    afterCount: queue.length - fitCount };
}

// Heure où la scène se libère : fin du titre en cours, sa durée moins la
// position de lecture, en temps réel selon le tempo, plus l'écart mesuré entre
// deux titres (Scheduler#songGapSec). Sinon un titre moyen (notre titre vient
// de monter sur scène si son début n'est pas encore noté), écart compris ; un
// titre qui dure plus longtemps libère la scène au plus tôt maintenant plus
// l'écart. La durée envoyée par un téléphone peut
// seulement avancer cette estimation : elle ne fait jamais retirer le titre
// d'un autre. Soirée du 10 octobre : à la fin d'un titre, « début + passage
// moyen » plaçait encore 1 min 30 de chanson devant « Hello » ; retiré pour la
// fermeture, sa chanteuse prévenue, puis renvoyé une seconde plus tard.
function stageFreeAt(current, now = Date.now()) {
  if (!current) return now;
  const slot = sched.avgSlotSec() * 1000, gap = sched.songGapSec() * 1000;
  const live = tracked.find(tr => isOnStage(tr, current));
  const kind = isBattleItem(current) ? 'battle' : null;
  const sure = stageProgressView(current, kind, now, { trustedOnly: true, fromStart: true });
  const told = !sure?.durationSec ? stageProgressView(current, kind, now, { fromStart: true }) : null;
  const endsAt = view => now + Math.max(0, view.durationSec - view.elapsedSec) * 1000 / (view.rate > 0 ? view.rate : 1) + gap;
  const estimate = (live ? Math.max(now, (live.startedAt || now) + slot) : now + slot / 2) + gap;
  return sure?.durationSec ? endsAt(sure) : told?.durationSec ? Math.min(estimate, endsAt(told)) : estimate;
}

// Fermeture du bar : un titre qui démarrerait dans `ahead` passages (titre
// moyen et écart entre deux titres chacun) ne part vers KaraFun et ne démarre
// que si au moins la moitié d'un titre moyen passe avant l'heure, avec la même
// fin de scène que le repère des téléphones (closingView). Un
// titre en cours qui déborde repousse l'estimation ; un titre écarté revient
// s'il tient de nouveau avant l'heure (heure décalée, chanson plus courte).
// Le bar peut toujours lancer un titre lui-même.
function closingBlocksStart(current, ahead = 0, now = Date.now()) {
  const at = closingAt(now);
  if (at == null) return false;
  const slot = sched.avgSlotSec() * 1000;
  return stageFreeAt(current, now) + ahead * sched.passageSec() * 1000 + slot / 2 > at;
}
let closingNoted = null;
function noteClosingStop() {
  if (closingNoted === settings.closingAt) return;
  closingNoted = settings.closingAt;
  journalEvent('closing.reached', { closingAt: settings.closingAt });
  sched.note(`Fermeture à ${hhmm(settings.closingAt)} : plus aucun titre n’est envoyé ni lancé dans KaraFun. Spotify reprend quand la scène est libre ; « +10 min » relance la file.`, 'staff');
}

// Le titre part vers KaraFun avec ses chanteurs déjà fixés : pas de duo ajouté.
function assertNotSending(entryId) {
  if (pending && !pending.cancelled && pending.sel.song.entryId === String(entryId || '')) {
    throw new Error('Ce titre est en cours d’envoi à KaraFun : le duo n’est plus possible.');
  }
}

// Titre d'une invitation de duo en route vers KaraFun : il part en solo et
// l'invitation expire à l'accusé (Scheduler#_expireInvite). L'accepter n'est
// plus possible ; la refuser ne change rien au titre. Sans titre précis, la
// seule invitation reçue est visée (comme Scheduler#answerDuet).
function sendingEntryId() {
  return pending && !pending.cancelled ? pending.sel.song.entryId : null;
}

// Personnes d'un passage déjà parti vers KaraFun (envoi en cours, titre
// chargé pas encore commencé) : annuler un geste du bar ne leur rend pas la
// réservation d'avant ce geste, qui viserait leur titre suivant.
function sendingIds() {
  const ids = pending && !pending.cancelled ? [...(pending.sel.consumedIds || pending.sel.ids)] : [];
  for (const tr of tracked) if (!tr.cancelled && !tr.startedAt) ids.push(...(tr.sel.consumedIds || tr.sel.ids.slice(0, 1)));
  return ids;
}
function assertInviteNotSending(guest, entryId) {
  const sending = sendingEntryId();
  if (!sending) return;
  const invites = sched.duetInvites(guest);
  const target = entryId ? String(entryId) : invites.length === 1 ? invites[0].entryId : null;
  if (target === sending) throw new Error('Trop tard : ce titre part déjà dans KaraFun en solo, l’invitation a expiré.');
}

// Duo en route vers KaraFun : ses chanteurs sont fixés jusqu'à l'accusé.
function assertDuoNotSending(entryId, personId) {
  if (pending && !pending.cancelled && pending.sel.song.entryId === entryId && pending.sel.ids.includes(personId)) {
    throw new Error('Ce titre est en cours d’envoi à KaraFun. Réessaie dans un instant.');
  }
}
// « Annuler duo » : sans titre précis, le seul duo de la personne est celui
// en cours d'envoi s'il la compte parmi ses chanteurs.
function assertDuoCancelNotSending(p, entryId) {
  if (pending && !pending.cancelled && pending.sel.ids.length > 1) {
    assertDuoNotSending(entryId ? String(entryId) : pending.sel.song.entryId, p.id);
  }
}

// Duo déjà chargé dans KaraFun : le titre reste à sa place au nom de son
// auteur, aucune commande KaraFun (voir Scheduler#leaveSentDuet).
function leaveSentDuo(tr, guestId, by) {
  const { current } = analyze();
  if (tr.startedAt || isOnStage(tr, current)) throw new Error('Trop tard : ce duo est déjà sur scène.');
  if (tr.cancelled || tr.pulled || tr.absent) throw new Error('Ce titre est en train de sortir de KaraFun. Réessaie dans un instant.');
  return sched.leaveSentDuet(tr.sel, guestId, { by });
}

// Le bar marque partis une personne ou toute une table (`ids`). Un duo déjà
// chargé dont seuls des invités partent reste dans KaraFun, au nom de son
// auteur seul (un titre en train de sortir revient à son auteur) ; un envoi
// sans accusé garde son nom d'origine pour que KaraFun le reconnaisse. À
// appeler avant le départ, pour que les invités récupèrent leur part de
// tour. Rend les titres suivis à retirer de KaraFun (ceux dont l'auteur part).
function keepSentDuosOfLeavers(ids) {
  const { current } = analyze();
  const upcoming = tracked.filter(tr => !isOnStage(tr, current) && tr.sel.ids.some(id => ids.has(id)));
  const asGuest = upcoming.filter(tr => !ids.has(tr.sel.ids[0]));
  let keptAsSolo = 0;
  for (const tr of asGuest) {
    if (tr.cancelled || tr.pulled || tr.absent || tr.startedAt) continue;
    for (const gid of tr.sel.ids.slice(1).filter(id => ids.has(id))) sched.leaveSentDuet(tr.sel, gid, { by: 'staff' });
    keptAsSolo++;
  }
  if (pending && !pending.cancelled && !ids.has(pending.sel.ids[0])) {
    const guests = pending.sel.ids.slice(1).filter(id => ids.has(id));
    for (const gid of guests) sched.leaveSentDuet(pending.sel, gid, { by: 'staff', keepLabel: true });
    if (guests.length) keptAsSolo++;
  }
  return { upcomingTracks: upcoming.filter(tr => !asGuest.includes(tr)), keptAsSolo };
}

// Titres déjà chargés dont l'auteur part : retirés de KaraFun. Les invités
// qui restent apprennent l'annulation du duo, comme avant l'envoi (une seule
// fois : un titre déjà annulé attend seulement son retrait de KaraFun).
function removeLeaversTracks(upcomingTracks, ids) {
  for (const tr of upcomingTracks) {
    const already = tr.cancelled;
    tr.cancelled = true;
    tr.removeRequestedAt = Date.now();
    try { bridge?.remove(tr.queueId); }
    catch (error) { sched.note(`Retrait KaraFun à vérifier : ${error.message}`, 'error'); }
    if (already) continue;
    const ownerName = sched.people.get(tr.sel.ids[0])?.name || tr.sel.names?.[0] || '';
    for (const gid of tr.sel.ids.slice(1)) {
      if (!ids.has(gid)) sched.notify(gid, 'duoCancelled', { name: ownerName, title: tr.sel.song.title });
    }
  }
}

// ------------------------------------------------- durée maximale des titres
// Réglage du bar (coupé par défaut) : un client ne peut plus ajouter un titre,
// un duo ni une proposition de Battle plus long que la limite. Le bar, les
// titres déjà dans KaraFun et « Relancer » ne sont jamais concernés ; les
// titres déjà dans la file restent (signalés au bar, retrait groupé possible).
// Bornes partagées avec la reprise de la sauvegarde (stage-progress.js).
function maxSongLimit() {
  return stageProgress.validMaxSong(settings.maxSongSec) ? settings.maxSongSec : null;
}
// « 6:12 »
const minSec = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
// Durée retenue : celle du catalogue relayé par ce serveur, sinon celle du
// téléphone, bornée comme pour la barre de lecture ; null si inconnue.
function songLengthSec(song) {
  return catalogDurations.get(Number(song?.songId)) ?? stageProgress.clientDuration(Number(song?.duration));
}
// Durée d'un titre au-delà de la limite active, sinon null (durée inconnue : accepté).
function tooLongSec(song) {
  const limit = maxSongLimit();
  const sec = limit == null ? null : songLengthSec(song);
  return sec != null && sec > limit ? sec : null;
}
function assertSongLength(p, songs, route) {
  for (const song of songs) {
    const sec = tooLongSec(song);
    if (sec == null) continue;
    const limit = maxSongLimit();
    journalEvent('songLength.refused', { personId: p.id, songId: Number(song?.songId) || null, durationSec: sec, limitSec: limit, route });
    const error = new Error(`Ce titre dure ${minSec(sec)} : le bar limite les chansons à ${minSec(limit)}.`);
    error.code = 'SONG_TOO_LONG';
    throw error;
  }
}
// Titres de la file plus longs que la limite et pas encore partis vers
// KaraFun (le titre en cours d'envoi reste).
function tooLongEntries() {
  if (maxSongLimit() == null) return [];
  const sending = sendingEntryId();
  const rows = [];
  for (const p of sched.people.values()) for (const song of sched.songsOf(p)) {
    const sec = song.entryId === sending ? null : tooLongSec(song);
    if (sec != null) rows.push({ p, song, sec });
  }
  return rows;
}

// ------------------------------------------------------------------ Spotify
const spotifyRedirect = () => `http://127.0.0.1:${PORT}/spotify/callback`;
// spotifyBusy : passages de l'automate et pauses d'avant-titre en cours ;
// spotifyWork : passage de l'automate en cours, qu'une pause d'avant-titre attend.
let spotifyBusy = 0;
let spotifyWork = null;
// Soirée vue par Spotify. « between » : rien ne joue, mais un titre suivant
// arrive (chargé dans KaraFun, en cours d'envoi, ou prêt dans la file avec
// l'envoi automatique) : Spotify ne reprend pas entre deux chansons.
// « silent » : file vide, ou fermeture du bar (plus rien ne sera lancé).
// « battle » : rien sur scène et la Battle attend le bar, qui la lance à la
// main (prête en tête de KaraFun, suivie ou ajoutée dans KaraFun ; ou déjà
// lancée, que KaraFun retire de sa file avant d'annoncer sa lecture), puis
// relance à la main le titre suivant (Battle finie) : Spotify comble
// l'attente, comme en silence ; chaque lancement le coupe.
function karaokeOutlook() {
  if (!bridge?.ready) return 'unknown';
  const { current, upcoming } = analyze();
  if (current) return 'singing';
  if (closingBlocksStart(null)) return 'silent';
  if (isBattleItem(upcoming[0]) || battleStarting() || battleVote.automation?.status === 'after') return 'battle';
  if (upcoming.length || (pending && !pending.cancelled)) return 'between';
  // presenceView compte aussi les chanteurs qui doivent encore confirmer
  // « Je suis là » : la file n'est pas vide pour autant.
  if (settings.auto && !settings.queueClearPending && sched.presenceView().some(turn => turn.song)) return 'between';
  return 'silent';
}

// Spotify reprend en fin de file : la lecture automatique attend que le bar
// lance le titre suivant, le temps de redonner le micro.
function holdAutoPlay() {
  if (!settings.autoPlay) return;
  settings.autoPlay = false;
  settings.autoPlayHeld = true;
  journalEvent('autoplay.held', {});
  sched.note('Spotify a repris en fin de file : lecture automatique suspendue. Touche « Lecture » quand le micro est prêt ; elle se rétablit ensuite.', 'staff');
  saveNight();
}
function releaseAutoPlay() {
  if (!settings.autoPlayHeld) return;
  settings.autoPlayHeld = false;
  settings.autoPlay = true;
  journalEvent('autoplay.released', {});
  sched.note('Lecture automatique rétablie.', 'staff');
}

// Lancement d'un titre : Spotify est d'abord coupé, puis KaraFun démarre
// après un court silence (pauseLeadSec), pour que la salle entende la
// transition au lieu d'un fondu. Rien n'est ajouté si Spotify ne jouait pas.
// Le lancement automatique (`queueId`) revérifie la file après ce délai : un
// titre retiré entre-temps (« Pas prêt », duo, fermeture) n'est pas remplacé
// par un autre. Le bouton « Lecture » du bar lance toujours. Rend true si
// KaraFun a reçu la commande.
const SPOTIFY_PAUSE_WAIT_MS = 4000; // au-delà, KaraFun démarre sans attendre Spotify
let playStarting = null;
// « Lancer le prochain titre » après la Battle : coupure de Spotify et court
// silence en cours, qu'un second appui attend au lieu de les écourter.
let afterBattleStarting = null;
// Coupure de Spotify avant un lancement depuis l'application (« Lecture »,
// lecture automatique, titre suivant après la Battle), puis le court silence.
// Attente de la Battle : l'automate ne relance plus Spotify jusqu'au titre
// lancé, que KaraFun met quelques secondes à annoncer. Hors Battle, rien ne
// change (il ne relance jamais entre deux chansons). Rien à couper : null, et
// le lancement part aussitôt.
function pauseSpotifyBeforeStart() {
  if (karaokeOutlook() === 'battle') spotifyAutomation.handled('battle');
  return spotify.connected && spotify.config.autoPause && !spotify.blocked ? pauseSpotifyThenWait() : null;
}
async function pauseSpotifyThenWait() {
  // Une vérification ou une relance de l'automate en cours ne fait plus
  // sauter la pause : elle part juste après, dans le même délai.
  const running = spotifyWork;
  spotifyBusy++;
  let paused = null;
  try {
    paused = await Promise.race([running ? running.then(() => spotify.pause()) : spotify.pause(),
      new Promise(resolve => setTimeout(resolve, SPOTIFY_PAUSE_WAIT_MS, 'timeout'))]);
  } catch (error) { spotify.lastError = error.message; }
  // Une pause encore en route après le délai peut croiser le prochain
  // passage de l'automate : sans effet, Spotify est déjà en pause.
  finally { spotifyBusy--; }
  const lead = Number(spotify.config.pauseLeadSec) || 0;
  if (paused === 'done' && lead > 0) await new Promise(resolve => setTimeout(resolve, lead * 1000));
}
async function playKaraFun({ queueId = null } = {}) {
  if (serverUpdate.isBusy()) return false;
  // Un appel pendant un lancement en prend le résultat. Si un lancement
  // automatique renonce, un seul « Lecture » du bar en attente lance.
  while (playStarting) {
    const running = playStarting;
    const played = await running.catch(() => false);
    if (played || queueId != null) return played;
    if (playStarting === running) playStarting = null;
  }
  const mine = (async () => {
    const pausing = pauseSpotifyBeforeStart();
    if (pausing) await pausing;
    // Une pause Spotify peut avoir attendu le réseau pendant plusieurs
    // secondes : revérifier le verrou juste avant toute commande de lecture.
    if (serverUpdate.isBusy()) return false;
    if (!bridge?.ready) throw new Error('KaraFun est déconnecté.');
    if (queueId != null) {
      const { current, upcoming } = analyze();
      const head = upcoming[0];
      const tr = head && tracked.find(item => String(item.queueId) === String(head.queueId));
      if (current || !head || String(head.queueId) !== String(queueId) || !tr || tr.cancelled || tr.pulled || tr.absent ||
          closingBlocksStart(null)) return false;
    }
    bridge.play();
    return true;
  })();
  playStarting = mine;
  try { return await mine; }
  finally { if (playStarting === mine) playStarting = null; }
}

// Vérification de Spotify (appareils et lecteur). Rétabli (appareil retrouvé,
// réseau revenu, reconnexion) : l'action abandonnée de la période en cours
// repart, sauf si le bar a lui-même coupé ou lancé la musique, au plus une
// fois par 10 minutes et pas quand seul l'appel de relance échoue en 5xx
// (SpotifyAutomation.recover). Spotify en panne ou sans appareil après cet
// échec : la panne n'était pas propre à l'appel, la reprise est permise.
// Rien de repris : rien au journal ; sinon l'action reprise (pause ou relance).
async function spotifyCheck() {
  const before = spotify.health.state;
  const health = await spotify.checkHealth();
  if (health.state === 'error' || health.state === 'no-device') spotifyAutomation.checkFailed();
  const action = spotifyAutomation.failure?.action;
  if (health.state === 'ready' && (before !== 'ready' || health.adopted) && spotifyAutomation.recover()) {
    appLog(`Spotify rétabli : la ${action === 'pause' ? 'pause' : 'relance'} automatique reprend.`);
  }
  return health;
}

async function spotifyTick() {
  if (!spotify.connected || spotifyBusy) return;
  const karaoke = karaokeOutlook();
  // Fermeture atteinte, scène libre : la musique du bar revient, même si la
  // reprise automatique est coupée (une pause faite au bar reste respectée).
  const closed = karaoke === 'silent' && closingBlocksStart(null);
  const trigger = closed ? 'closing' : karaoke === 'battle' ? 'battle' : 'auto';
  const action = spotifyAutomation.step(karaoke, closed ? { ...spotify.config, autoResume: true } : spotify.config);
  // Après un échec, Spotify n'est pas rappelé avant le délai ; seule la pause
  // d'un titre qui démarre passe outre (sauf si Spotify demande d'attendre).
  // Sans action : vérification toutes les minutes (ou après un échec).
  if (spotify.blocked || (spotify.waiting && action !== 'pause') || (!action && !spotify.checkDue)) return;
  spotifyBusy++;
  let release;
  spotifyWork = new Promise(resolve => { release = resolve; });
  try {
    if (!action) { await spotifyCheck(); return; }
    const result = action === 'resume' ? await spotify.resume() : await spotify.pause();
    spotifyAutomation.settle(true);
    journalEvent('spotify', { action, result: String(result || ''), trigger });
    if (result === 'done') appLog(action === 'pause' ? 'Spotify en pause : un titre démarre dans KaraFun.' :
      closed ? 'Spotify relancé : heure de fermeture.' : trigger === 'battle' ? 'Spotify relancé : la Battle attend le bar.' :
        'Spotify relancé : la file est vide.');
    // Fin de file (Spotify relancé, ou déjà en lecture) : le bar redonne le
    // micro avant le titre suivant. À la fermeture, « +10 min » relance seul.
    // Un titre lancé pendant la relance : rien à suspendre. Attente de la
    // Battle : la lecture automatique n'y lance rien (le bar lance la Battle
    // et le titre d'après), et une suspension survivrait à la Battle.
    if (action === 'resume' && !closed && trigger !== 'battle' && karaokeOutlook() !== 'singing') holdAutoPlay();
  } catch (error) {
    spotifyAutomation.settle(false, error);
    journalEvent('spotify', { action, result: 'error', trigger });
    spotify.lastError = error.message;
  } finally { spotifyBusy--; spotifyWork = null; release(); }
}

// Le catalogue essaie les deux domaines KaraFun comme la recherche, en gardant
// d'une requête à l'autre celui qui a répondu : refait seulement si le code ou
// la liste des domaines change. Au bar, un des domaines refusait les sélections (HTTP 403).
let catalogApi = null;
let catalogKey = '';
const CATALOG_FAILURES = { timeout: 'délai dépassé', json: 'réponse illisible', invalid: 'réponse inattendue', network: 'réseau injoignable' };
function catalog() {
  if (DEMO || !CODE) throw new Error('Catalogue KaraFun indisponible en mode démo ou sans code.');
  const known = bridge?.bases?.length ? bridge.bases : ['https://www.karafun.fr', 'https://www.karafun.com'];
  const first = known.includes(bridge?.base) ? bridge.base : known[0];
  const bases = [first, ...known.filter(base => base !== first)];
  const key = `${CODE}|${[...bases].sort().join(' ')}`;
  if (!catalogApi || catalogKey !== key) {
    // Journal : le domaine et le statut seulement, jamais l'URL (elle contient le code).
    catalogApi = new Catalog({ bases, code: CODE, onFailure: ({ host, status, kind }) =>
      appLog(`Catalogue KaraFun : échec sur ${host} (${status ? `HTTP ${status}` : CATALOG_FAILURES[kind] || kind}).`) });
    catalogKey = key;
  }
  return catalogApi;
}

// Message montré aux téléphones quand aucun domaine KaraFun ne donne le catalogue.
function catalogPhoneError(e) {
  if (!e?.catalogUnavailable) return e.message;
  if (e.status) return `Catalogue KaraFun indisponible pour le moment (refus HTTP ${e.status}). La recherche reste possible.`;
  if (e.kind === 'timeout') return 'Catalogue KaraFun indisponible pour le moment (délai dépassé). La recherche reste possible.';
  if (e.kind === 'json') return 'Catalogue KaraFun indisponible pour le moment (réponse illisible). La recherche reste possible.';
  return 'Catalogue KaraFun indisponible pour le moment (réseau injoignable). La recherche reste possible.';
}

function clearQueue() {
  const { current, upcoming } = analyze();
  const removedLocalSongs = [...sched.people.values()].reduce((sum, p) => sum + sched.songsOf(p).length, 0);
  const pendingCancelled = !!pending;
  if (pending) pending.cancelled = true;
  for (const tr of tracked) {
    if (!isOnStage(tr, current)) {
      tr.cancelled = true;
      tr.removeRequestedAt = 0;
    }
  }
  const otherKaraFunSongs = upcoming.filter(item =>
    !tracked.some(tr => String(tr.queueId) === String(item.queueId))).length;
  for (const p of sched.people.values()) {
    p.song = null;
    p.backlog = [];
    p.over = 0;
    p.held = 0;
  }
  sched._refreshDuetViews();
  sched.Q = [];
  sched.roundGroups.clear();
  sched.firstCycle.clear();
  // Le tour en cours se termine comme un tour normal : une dette (passage
  // emprunté, malus) reste due au tour suivant, sans compter deux fois le
  // passage que le vidage efface du tour. Les reçus des titres encore en
  // route vers KaraFun passent au même nouveau tour : un titre retiré sans
  // avoir été chanté rend alors sa part (rollbackUnplayed compare à ce reçu).
  // Leur roundOwed reste tel quel : un passage dû, retiré sans être chanté,
  // redevient dû malgré le vidage.
  for (const sel of [...tracked.map(tr => tr.sel), pending?.sel]) {
    const credit = sel?.turnCredit;
    if (!credit || credit.rolledBack) continue;
    for (const state of [credit.before, credit.after]) {
      if (!Array.isArray(state?.roundPeople) || !Array.isArray(state.roundUse)) continue;
      const people = new Set(state.roundPeople), use = new Map(state.roundUse), apps = new Map(state.roundApps || []);
      sched._resetRound(people, use, apps);
      state.roundPeople = [...people];
      state.roundUse = [...use];
      if (Array.isArray(state.roundApps)) state.roundApps = [...apps];
    }
  }
  sched._resetRound(sched.roundPeople, sched.roundUse, sched.roundApps);
  sched.roundOwed.clear();
  sched.invalidateManualOrder();
  sched.duetCooldowns.clear();
  sched.releaseNext();
  settings.queueClearPending = true;
  battleVote.reset();
  journalEvent('staff.queueCleared', { songs: removedLocalSongs, pendingCancelled });
  sched.note('Le bar a vidé toutes les chansons en attente ; les tables, accès et passages précédents sont conservés.', 'staff');
  // Écrire les deux générations avant toute commande distante : un crash ne
  // doit jamais recréer une file que le bar a décidé d'effacer.
  saveNight({ required: true, replaceBoth: true });
  if (bridge?.ready) sync();
  // KaraFun absent : rien n'y a été retiré, sa file sera vidée à son retour.
  return { ok: true, removedLocalSongs, pendingCancelled,
    currentStillPlaying: !!current,
    removalPending: tracked.filter(tr => tr.cancelled).length,
    otherKaraFunSongs, awaitingKaraFun: !!settings.queueClearPending, karafunOffline: !bridge?.ready };
}

// « Arrêter le vidage » : sans KaraFun (pas de code, fermé, essais
// arrêtés), le vidage n'aurait pas de fin, et KaraFun peut garder un titre
// qu'il refuse de retirer. Le bar arrête alors d'attendre : les titres
// ajoutés directement dans KaraFun y restent. Nos titres annulés restent
// suivis et quittent KaraFun dès qu'il les montre ; l'envoi automatique
// garde son réglage.
// Tant que le vidage attend KaraFun, il protège tout titre annulé qui se
// révèle sur scène (sync()). Quand il s'arrête avant la fin, chaque titre
// encore annulé garde cette protection, y compris ceux d'une soirée
// enregistrée par une version précédente.
function keepClearStageProtection() {
  for (const tr of tracked) if (tr.cancelled) tr.cancelledByClear = true;
  if (pending?.cancelled) pending.cancelledByClear = true;
}

// Titre annulé par un vidage mais chanté : commit() remet ses chanteurs au
// bout de la file. Seul ce ticket vide part ; un chanteur qui a choisi un
// nouveau titre depuis le vidage garde sa place.
function dropClearedTickets(sel) {
  const consumed = new Set(sel.consumedIds || sel.ids);
  sched.Q = sched.Q.filter(pid => {
    const person = sched.people.get(pid);
    return !consumed.has(pid) || (!!person && sched.songsOf(person).length > 0);
  });
}

function stopQueueClear() {
  if (!settings.queueClearPending) return { ok: true, wasPending: false };
  // Écrit sur les deux générations avant tout effet. Une sauvegarde
  // impossible laisse le vidage en cours ; si une seule génération a pu être
  // écrite, elle est réécrite vidage en cours, pour qu'un redémarrage dise
  // la même chose que la page.
  keepClearStageProtection();
  settings.queueClearPending = false;
  try { saveNight({ required: true, replaceBoth: true }); }
  catch (error) {
    settings.queueClearPending = true;
    saveNight({ replaceBoth: true });
    throw error;
  }
  queueClearRemovalRequests.clear();
  journalEvent('staff.queueClearStopped', { karafunReady: !!bridge?.ready });
  sched.note('Le bar a arrêté le vidage de KaraFun : la file ne retire plus les titres ajoutés directement dans KaraFun.', 'staff');
  sync();
  return { ok: true, wasPending: true };
}

function clearEvening() {
  const { current, upcoming } = analyze();
  // Vidage resté en attente : ses titres annulés restent protégés s'ils
  // passent sur scène (pas ceux que la remise à zéro annule ci-dessous).
  if (settings.queueClearPending) keepClearStageProtection();
  // Clôture et résumé de la soirée qui se termine, avant tout effacement.
  const listed = [...sched.people.values()].map(p => sched.songsOf(p).length);
  closeEvening('staff-reset', { unsungSongs: listed.reduce((a, b) => a + b, 0), peopleWithSongs: listed.filter(Boolean).length,
    people: sched.people.size, tables: sched.tables.size });
  // Même pendant une reconnexion, chaque titre envoyé reste sous suivi. On ne
  // connaît alors pas la file distante : le retrait sera tenté dès son retour.
  const toRemove = tracked.filter(tr => !tr.startedAt && !isOnStage(tr, current));
  // L'envoi automatique attend la vérification du bar seulement si un titre
  // envoyé doit encore quitter KaraFun (ou arriver) : le titre sur scène seul
  // ne le coupe pas. La page l'annonce avant la confirmation.
  const stopAuto = !!settings.auto && (!!pending || toRemove.length > 0);
  let removalErrors = 0;
  let removalRequests = 0;
  for (const tr of toRemove) {
    tr.cancelled = true;
    tr.removeRequestedAt = 0;
    if (bridge?.ready) {
      try { bridge.remove(tr.queueId); removalRequests++; tr.removeRequestedAt = Date.now(); }
      catch (error) { removalErrors++; appLog(`Retrait KaraFun non confirmé au reset : ${error.message}`); }
    }
  }
  // Un envoi encore sans accusé reste suivi uniquement pour pouvoir le retirer
  // s'il apparaît après la remise à zéro. S'il passe quand même sur scène, ce
  // passage de la soirée close ne compte pas dans la nouvelle.
  if (pending) { pending.cancelled = true; pending.previousEvening = true; }
  tracked = tracked.filter(tr => tr.cancelled || tr.startedAt || isOnStage(tr, current));
  for (const tr of tracked) delete tr.uncommitted;
  for (const tableId of sched.tables.keys()) access.revoke(tableId);
  soloInvitations.clear();
  privateEvent.clear();
  sched.tables.clear();
  sched.people.clear();
  sched.byToken.clear();
  sched.Q = [];
  sched.lastGroup = null;
  sched.roundGroups.clear();
  sched.firstCycle.clear();
  sched.unstartedTurn = 0;
  sched.stageEnds.clear();
  sched.roundPeople.clear();
  sched.roundApps.clear();
  sched.roundOwed.clear();
  sched.invalidateManualOrder();
  sched.tableServeCounts.clear();
  sched.duetCooldowns.clear();
  sched.releaseNext();
  sched.slotSamples = [];
  sched.songGapSamples = [];
  songGap = null;
  sched.log = [];
  sched.playedSongs = [];
  // Rien de la soirée précédente ne reste : historique de scène (prénoms),
  // partage entre tables, crédits de tour et compteur de passages.
  sched.clearStageHistory([onStageEntryId()]);
  sched.recentGroups = [];
  sched.roundUse.clear();
  sched.appearanceSerial = 0;
  personShareCodes.clear();
  journaledBallots.clear();
  seenJournal.clear();
  battleVote.reset();
  // Réglages de la nouvelle soirée avant son premier événement : les règles
  // notées dans evening.started sont celles qui s'appliquent.
  settings.autoPlay = false;
  settings.autoPlayHeld = false;
  settings.closingAt = null;
  // « Duos uniquement » se décide pour une soirée chargée, comme l'heure de
  // fermeture : la suivante repart avec les solos permis.
  settings.duoOnly = false;
  // Un vidage resté en attente de KaraFun ne passe pas à la soirée suivante :
  // il retirerait ses nouveaux titres à la reconnexion.
  settings.queueClearPending = false;
  queueClearRemovalRequests.clear();
  // Chœurs par défaut relevés provisoires oubliés (sauvegarde et pont) : une
  // valeur relevée à tort ne dure jamais plus d'une soirée. Une valeur
  // confirmée par une remise de KaraFun au chargement reste pour ce KaraFun.
  if (settings.karafunDefaults?.provisional === true) delete settings.karafunDefaults;
  bridge?.forgetDefaults?.({ keepConfirmed: true });
  if (stopAuto) settings.auto = false;
  journal.start({ rules: journalRules() });
  phaseKey = null; presenceAskKey = null; lastSampleAt = 0;
  ensureSoloGroup();
  journalRoster();
  restartSweep = null;
  restartAwaitingPlay = null;
  sched.note('Nouvelle soirée : anciens accès effacés et nouvel accès « En solo » créé.', 'staff');
  saveNight({ required: true, replaceBoth: true });
  saveTables();
  // Les photos ne sont plus nécessaires après deux instantanés sans personnes.
  try { for (const filename of fs.readdirSync(PHOTO_DIR)) fs.unlinkSync(path.join(PHOTO_DIR, filename)); }
  catch (_) { /* nettoyage différé : aucune photo n'est encore visible */ }
  return { ok: true, removalRequests, autoStopped: stopAuto, karafunOffline: !bridge?.ready,
    removalErrors, currentStillPlaying: !!current,
    otherKaraFunSongs: upcoming.filter(item => !tracked.some(tr => String(tr.queueId) === String(item.queueId))).length,
    removalPending: toRemove.length };
}

// Réglages notés dans le journal quand ils changent (jamais l'adresse publique).
function journalSettingsState() {
  return { auto: !!settings.auto, autoPlay: !!settings.autoPlay, pushDelaySec: settings.pushDelaySec, playDelaySec: settings.playDelaySec,
    repeatWarnMin: settings.repeatWarnMin, presenceGraceSec: settings.presenceGraceSec, presenceMaxSkips: settings.presenceMaxSkips,
    gap: sched.opts.gap, cap: sched.opts.cap, requirePresence: !!sched.opts.requirePresence, tableRotation: !!sched.opts.tableRotation,
    weightedTables: !!sched.opts.weightedTables, interleaveArrivals: sched.opts.interleaveArrivals !== false,
    battleCooldownMin: battleVote.cooldownMs / 60000, battleRejectedCooldownMin: battleVote.rejectedCooldownMs / 60000,
    battleVoteMin: battleVote.voteDurationMs / 60000, battleMinVoters: battleVote.minVoters, baseUrl: !!settings.baseUrl,
    singerSongSettings: settings.singerSongSettings !== false, privateEvent: privateEvent.enabled,
    maxSongSec: maxSongLimit(), duoOnly: !!settings.duoOnly };
}
function journalSettings(before) {
  const after = journalSettingsState();
  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value) journalEvent('settings.changed', { setting: key, from: before[key], to: value });
  }
}

const handlers = {
  // ---------------- clients
  'POST /api/join': async (req, res, body) => {
    const t = tableByAccess(body.table, body.access);
    if (t.individual) refuseSoloDeviceOwner(req, soloDeviceOwner(req));
    if (t.individual) requireSoloInvitation(t, body.invitation);
    if (t.headcount == null && !t.individual) {
      const e = new Error('Le bar doit d’abord indiquer le nombre de personnes à cette table.');
      e.code = 'NEED_HEADCOUNT'; throw e;
    }
    const photo = decodePhoto(body.photo);
    return joinPersonDurably(req, res, t, body, photo);
  },
  'POST /api/song': async (req, res, body, me) => { requireNamed(me); chooseFor(me, body.song, body.mode || 'replace'); return { ok: true }; },
  // QR individuel ouvert : la personne existe dès maintenant (prénom à saisir),
  // ou le même QR rouvert ailleurs propose de récupérer ses chansons.
  'POST /api/table/solo/open': async (req, res, body) => openSoloInvitation(req, res, body),
  // QR de l'événement privé.
  'POST /api/table/enter': async (req, res, body) => enterPrivateEvent(req, res, body),
  // QR de sa table à faire scanner aux amis, depuis un téléphone de la table.
  'GET /api/table/invite': async (req, res, u) => {
    const t = tableByAccess(u.searchParams.get('table'), u.searchParams.get('access'));
    if (t.individual) throw new Error('Pas de QR à partager : chacun demande son QR individuel au bar.');
    const url = access.url(phoneBase(), t.id);
    return { url, qr: await QRCode.toDataURL(url, { margin: 1, errorCorrectionLevel: 'M' }) };
  },
  'POST /api/table/person': async (req, res, body) => {
    const t = tableByAccess(body.table, body.access);
    if (t.individual) refuseSoloDeviceOwner(req, soloDeviceOwner(req));
    if (t.individual) requireSoloInvitation(t, body.invitation);
    if (t.headcount == null && !t.individual) { const e = new Error('Effectif de la table à définir au bar.'); e.code = 'NEED_HEADCOUNT'; throw e; }
    return joinPersonDurably(req, res, t, body);
  },
  'POST /api/table/person/share': async (req, res, body) => createPersonShareCode(personAtTable(body)),
  'POST /api/table/person/claim': async (req, res, body) => claimPersonDurably(body, req, res),
  'POST /api/table/person/rename': async (req, res, body) => {
    const p = personAtTable(body);
    try {
      // Prénom vérifié d'abord : à l'événement complet, le prénom déjà inscrit
      // d'une invitée (sa page rouverte ailleurs) garde NAME_TAKEN et la
      // reprise par code (recoverable), pas « complet ».
      sched.validName(body.name, p.tableId, p.id);
      // Premier prénom d'une place du QR de l'événement : elle compte alors dans
      // le plafond des personnes nommées, revérifié ici comme à la création (une
      // place ouverte avant que l'événement soit complet ne le dépasse pas).
      if (p.viaEvent && p.nameRequired && PrivateEvent.full(sched.people.values())) throw privateEventFullError();
      sched.rename(p, body.name);
    } catch (error) {
      if (error.code === 'NAME_TAKEN' && sched.table(p.tableId, false)?.individual) error.recoverable = nameRecoverable(req, p, body.name);
      throw error;
    }
    sync(); return { ok: true };
  },
  'POST /api/table/confirm': async (req, res, body) => {
    const p = personAtTable(body);
    confirmPresence(p); return { ok: true };
  },
  'POST /api/table/song': async (req, res, body) => {
    const p = personAtTable(body);
    requireNamed(p);
    const notice = chooseFor(p, body.song, body.mode || 'append');
    return { ok: true, notice };
  },
  'POST /api/table/song/remove': async (req, res, body) => {
    const p = personAtTable(body);
    if (pending?.sel.ids[0] === p.id && pending.sel.song.entryId === String(body.entryId)) {
      throw new Error('Ce titre est en cours d’envoi à KaraFun. Réessaie dans un instant.');
    }
    sched.removeSong(p, body.entryId); sync(); return { ok: true };
  },
  // Réglages de son titre (tonalité, tempo, voix guide, chœurs), tant qu'il
  // n'a pas commencé. Duo : seul l'auteur du titre règle.
  'POST /api/table/song/settings': async (req, res, body) => {
    const p = personAtTable(body);
    if (settings.singerSongSettings === false) {
      throw songSettingsError('Le bar a désactivé les réglages de titre depuis les téléphones.', 'SONG_SETTINGS_OFF');
    }
    if (bridge?.songSettingsAvailable?.() === false) {
      throw songSettingsError('Cette ancienne télécommande KaraFun ne connaît pas les réglages de titre : ils ne seraient pas appliqués.',
        'SONG_SETTINGS_UNAVAILABLE');
    }
    const target = songSettingsTarget(body.entryId, 'Ce titre a déjà commencé : seul le bar peut encore le régler.');
    if (target.ids[0] !== p.id) {
      throw target.ids.includes(p.id) ?
        songSettingsError(`${sched.people.get(target.ids[0])?.name || 'L’auteur du titre'} a choisi ce duo : les réglages se font sur son téléphone.`, 'DUO_GUEST') :
        songSettingsError('Ce titre n’est pas dans ta liste.', 'NOT_OWNER');
    }
    const values = normalizeSettings(songSettingsInput(body.settings, target), songRanges());
    return { ok: true, settings: values, applied: applySongSettings(target, values, { by: 'self' }) };
  },
  'POST /api/table/song/reorder': async (req, res, body) => {
    const p = personAtTable(body);
    const songs = sched.songsOf(p);
    const from = songs.findIndex(s => s.entryId === String(body.entryId || ''));
    const to = Number(body.toIndex);
    if (pending?.sel.ids[0] === p.id && (from === 0 || to === 0)) {
      throw new Error('Le prochain titre est en cours d’envoi à KaraFun. Réordonne les suivants ou réessaie dans un instant.');
    }
    sched.reorderSongs(p, body.entryId, body.toIndex); sync(); return { ok: true };
  },
  'POST /api/table/duet': async (req, res, body) => {
    const p = personAtTable(body);
    requireNamed(p);
    assertSongLength(p, [body.song], 'duet');
    const duet = sched.inviteDuet(p, String(body.partnerId || ''), withCover(body.song)); sync();
    return { ok: true, notice: repeatNotice(duet, p.tableId, duet.entryId) };
  },
  // « Qui veut chanter en duo avec moi ? » : un titre du catalogue (`song`)
  // ou de sa liste pas encore envoyé (`entryId`) cherche un partenaire dans
  // toute la salle. Sans volontaire à son tour, il part en solo.
  'POST /api/table/duet/open': async (req, res, body) => {
    const p = personAtTable(body);
    requireNamed(p);
    if (body.song) assertSongLength(p, [body.song], 'duet');
    else assertNotSending(body.entryId);
    const song = sched.openDuet(p, body.song ? { song: withCover(body.song) } : { entryId: body.entryId }); sync();
    return { ok: true, entryId: song.entryId, ...(body.song ? { notice: repeatNotice(song, p.tableId, song.entryId) } : {}) };
  },
  'POST /api/table/duet/open/close': async (req, res, body) => {
    const p = personAtTable(body);
    assertDuoKept(p, body.entryId);
    sched.closeOpenDuet(p, body.entryId); sync(); return { ok: true };
  },
  // « Je chante avec … » : le premier volontaire devient l'invité du duo, les
  // suivants reçoivent le refus. Titre en route vers KaraFun : il part en solo.
  'POST /api/table/duet/open/accept': async (req, res, body) => {
    const p = personAtTable(body);
    requireNamed(p);
    // Second appui de celui qui l'a déjà rejoint (réponse perdue) : c'est
    // fait, même si le duo part déjà dans KaraFun.
    const owner = sched.people.get(String(body.ownerId || ''));
    const song = owner && sched.songsOf(owner).find(item => item.entryId === String(body.entryId || ''));
    if (sched._joinedOpenDuet(p, song)) return { ok: true };
    assertNotSending(body.entryId);
    sched.acceptOpenDuet(p, body.ownerId, body.entryId); sync(); return { ok: true };
  },
  'POST /api/table/duet/answer': async (req, res, body) => {
    const p = personAtTable(body);
    if (body.accept) requireNamed(p);
    if (body.accept) assertInviteNotSending(p, body.entryId);
    sched.answerDuet(p, !!body.accept, body.entryId); sync(); return { ok: true };
  },
  'POST /api/table/duet/cancel': async (req, res, body) => {
    const p = personAtTable(body);
    assertDuoCancelNotSending(p, body.entryId);
    assertDuoKept(p, body.entryId);
    sched.cancelDuet(p, body.entryId); sync(); return { ok: true };
  },
  // Invitée qui ne chante plus un duo accepté, avant ou après son envoi.
  'POST /api/table/duet/leave': async (req, res, body) => {
    const p = personAtTable(body);
    const entryId = String(body.entryId || '');
    assertDuoNotSending(entryId, p.id);
    const tr = tracked.find(item => item.sel.song?.entryId === entryId && item.sel.ids.indexOf(p.id) > 0);
    if (tr) { leaveSentDuo(tr, p.id, 'guest'); sync(); return { ok: true, stage: 'sent' }; }
    assertDuoKept(p, entryId);
    sched.leaveDuet(p, body.ownerId, entryId); sync(); return { ok: true, stage: 'planned' };
  },
  // « Chanter seul » : l'auteur d'un duo déjà chargé dans KaraFun le garde en solo.
  'POST /api/table/duet/solo': async (req, res, body) => {
    const p = personAtTable(body);
    const entryId = String(body.entryId || '');
    assertDuoNotSending(entryId, p.id);
    const tr = tracked.find(item => item.sel.song?.entryId === entryId && item.sel.ids[0] === p.id && item.sel.ids.length > 1);
    if (tr) { leaveSentDuo(tr, tr.sel.ids[1], 'owner'); sync(); return { ok: true, stage: 'sent' }; }
    assertDuoKept(p, entryId);
    sched.cancelDuet(p, entryId); sync(); return { ok: true, stage: 'planned' };
  },
  // Messages lus sur le téléphone qui gère la personne.
  'POST /api/table/notice/ack': async (req, res, body) => {
    const p = personAtTable(body, { passive: true });
    return { ok: true, removed: sched.ackNotices(p, body.ids) };
  },
  // Demander à chanter en duo le titre prévu par une autre personne.
  'POST /api/table/duet/join': async (req, res, body) => {
    const p = personAtTable(body);
    requireNamed(p);
    assertNotSending(body.entryId);
    const result = sched.requestDuetJoin(p, body.ownerId, body.entryId); sync();
    return { ok: true, direct: result.direct };
  },
  'POST /api/table/duet/join/answer': async (req, res, body) => {
    const p = personAtTable(body);
    if (body.accept) requireNamed(p);
    if (body.accept) assertNotSending(body.entryId);
    sched.answerDuetJoin(p, body.entryId, body.fromId, !!body.accept); sync(); return { ok: true };
  },
  'POST /api/table/duet/join/cancel': async (req, res, body) => {
    const p = personAtTable(body);
    sched.cancelDuetJoin(p, body.ownerId, body.entryId); sync(); return { ok: true };
  },
  // La fenêtre d'une demande (avec `fromId`) ou d'une invitation de duo vient
  // de s'afficher sur le téléphone qui doit répondre.
  'POST /api/table/duet/seen': async (req, res, body) => {
    const p = personAtTable(body);
    const seen = sched.markDuetSeen(p, body.entryId, body.fromId || null);
    if (seen) sync();
    return { ok: true, seen };
  },
  // « Pas prêt » : repousser son passage d'une chanson, ou revenir.
  'POST /api/table/defer': async (req, res, body) => {
    const p = personAtTable(body);
    return { ok: true, deferral: deferTurn(p, body.songs) };
  },
  'POST /api/table/defer/cancel': async (req, res, body) => {
    const p = personAtTable(body);
    readyForTurn(p); return { ok: true };
  },
  'POST /api/table/battle/propose': async (req, res, body) => {
    const p = personAtTable(body);
    requireNamed(p);
    if (closingBlocksStart(analyze().current)) {
      const error = new Error('Le bar ferme bientôt : plus de Battle ce soir.');
      error.code = 'CLOSING';
      throw error;
    }
    const songs = certifiedBattleSongs(body.songs);
    assertSongLength(p, songs, 'battle');
    const battle = battleVote.propose({ personId: p.id, personName: p.name, eligiblePersonIds: battleElectorate(),
      songs, proposerChoice: body.proposerChoice });
    return { ok: true, battle: battleForPhone(battle, p.tableId, p) };
  },
  'POST /api/table/battle/vote': async (req, res, body) => {
    const p = personAtTable(body);
    requireNamed(p);
    syncBattleElectorate();
    const battle = battleVote.vote({ personId: p.id, choice: body.choice });
    return { ok: true, battle: battleForPhone(battle, p.tableId, p) };
  },
  'POST /api/duet': async (req, res, body, me) => {
    requireNamed(me);
    assertSongLength(me, [body.song], 'duet');
    sched.inviteDuet(me, body.partnerId, withCover(body.song)); sync(); return { ok: true };
  },
  'POST /api/duet/answer': async (req, res, body, me) => {
    if (body.accept) requireNamed(me);
    if (body.accept) assertInviteNotSending(me, body.entryId);
    sched.answerDuet(me, !!body.accept, body.entryId); sync(); return { ok: true };
  },
  'POST /api/duet/cancel': async (req, res, body, me) => {
    assertDuoCancelNotSending(me, body.entryId);
    assertDuoKept(me, body.entryId);
    sched.cancelDuet(me, body.entryId); sync(); return { ok: true };
  },
  'POST /api/confirm': async (req, res, body, me) => { confirmPresence(me); return { ok: true }; },
  'POST /api/give': async (req, res, body, me) => { sched.giveSpot(me, body.to); sync(); return { ok: true }; },
  'POST /api/leave': async (req, res, body, me) => {
    // Place sans prénom ni titre du QR de l'événement : supprimée, sans trace
    // (sinon chaque nouveau scan laisserait une fiche partie de plus).
    if (me.viaEvent && disposablePlaceholder(me)) { dropPlaceholder(me); sched.version++; }
    // Nommée mais sans aucun historique : supprimée aussi, départ au journal.
    else if (me.viaEvent && withoutHistory(me)) forgetEventPerson(me);
    // Sinon marquée partie ; venue par l'événement, sa fiche reste comptée
    // dans le plafond des fiches (partie d'elle-même, PrivateEvent.held).
    else leavePerson(me);
    sync(); return { ok: true };
  },
  // Une place sans prénom n'a pas de photo (400 Ko au plus, gardés en mémoire).
  'POST /api/photo': async (req, res, body, me) => { requireNamed(me); me.photo = decodePhoto(body.photo); sched.version++; return { ok: true }; },

  // ---------------- bar
  // Un code vide est refusé : il effaçait le code retenu sans rien connecter.
  'POST /api/staff/update': async (req, res, body) => {
    if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== 'confirmActive') ||
        ('confirmActive' in body && typeof body.confirmActive !== 'boolean')) {
      throw new Error('Seule la confirmation de la soirée est acceptée pour la mise à jour.');
    }
    // Le refus technique prime sur la confirmation ; aucune action KaraFun
    // ou Spotify déjà lancée ne doit finir après notre instantané.
    const blockedReason = updateBlockedReason();
    const available = serverUpdate.view(blockedReason);
    if (available.enabled && !available.busy && !blockedReason && updateRequiresConfirmation() && body.confirmActive !== true) {
      const error = new Error('Une soirée est en cours. Confirme la brève interruption pour mettre à jour en conservant les tables, les chansons et l’ordre de passage.');
      error.status = 409;
      throw error;
    }
    saveNight({ required: true });
    serverUpdate.request(blockedReason);
    res.nightAlreadySaved = true;
    return { ok: true, update: updateState() };
  },
  'POST /api/staff/connect': async (req, res, body) => {
    const code = String(body.code || '').replace(/\D/g, '');
    if (!code) throw new Error('Code KaraFun manquant : recopie les chiffres affichés dans la télécommande de KaraFun.');
    return connectionAnswer(connectKaraFun(code));
  },
  'POST /api/staff/settings': async (req, res, body) => {
    // Mode serveur : l'adresse des QR vient de l'environnement. Seule la même
    // adresse est acceptée (sans effet) ; sinon rien de la requête n'est appliqué.
    if (SERVER && 'baseUrl' in body) {
      let sent = null;
      try { sent = normalizeBaseUrl(body.baseUrl); } catch (_) { /* même refus qu'une autre adresse */ }
      if (sent !== SERVER.publicUrl) {
        throw new Error('L’adresse des QR vient de KARAOKE_PUBLIC_URL sur ce serveur : elle ne se change pas depuis la page du bar.');
      }
    }
    const settingsBefore = journalSettingsState();
    const nextTableRotation = 'tableRotation' in body ? !!body.tableRotation : sched.opts.tableRotation;
    const nextWeighted = 'weightedTables' in body ? !!body.weightedTables : sched.opts.weightedTables;
    if (nextWeighted && !nextTableRotation) throw new Error('Active d’abord la rotation des tables.');
    // Valider toute la requête avant de changer un réglage : un HTTP 400 ne
    // doit jamais modifier silencieusement l'ordre de passage.
    const nextBaseUrl = 'baseUrl' in body ? normalizeBaseUrl(body.baseUrl) : settings.baseUrl;
    const nextPushDelay = 'pushDelaySec' in body ? Number(body.pushDelaySec) : settings.pushDelaySec;
    if (!Number.isInteger(nextPushDelay) || nextPushDelay < 0 || nextPushDelay > 180) {
      throw new Error('Le délai d’envoi doit être entre 0 et 180 secondes.');
    }
    const nextPlayDelay = 'playDelaySec' in body ? Number(body.playDelaySec) : settings.playDelaySec;
    if (!Number.isInteger(nextPlayDelay) || nextPlayDelay < 0 || nextPlayDelay > 30) {
      throw new Error('La pause avant lecture doit être entre 0 et 30 secondes.');
    }
    const nextBattleCooldown = 'battleCooldownMin' in body ? Number(body.battleCooldownMin) : null;
    if (nextBattleCooldown !== null && (!Number.isInteger(nextBattleCooldown) ||
        nextBattleCooldown < 1 || nextBattleCooldown > 120)) {
      throw new Error('Le délai entre Battles doit être de 1 à 120 minutes.');
    }
    const nextRejectedCooldown = 'battleRejectedCooldownMin' in body ? Number(body.battleRejectedCooldownMin) : null;
    if (nextRejectedCooldown !== null && (!Number.isInteger(nextRejectedCooldown) ||
        nextRejectedCooldown < 1 || nextRejectedCooldown > 120)) {
      throw new Error('Le délai après un refus de Battle doit être de 1 à 120 minutes.');
    }
    const nextVoteMin = 'battleVoteMin' in body ? Number(body.battleVoteMin) : null;
    if (nextVoteMin !== null && (!Number.isInteger(nextVoteMin) || nextVoteMin < 1 || nextVoteMin > 120)) {
      throw new Error('La durée du vote Battle doit être de 1 à 120 minutes.');
    }
    const nextRepeatWarn = 'repeatWarnMin' in body ? Number(body.repeatWarnMin) : settings.repeatWarnMin;
    if (!Number.isInteger(nextRepeatWarn) || nextRepeatWarn < 0 || nextRepeatWarn > 240) {
      throw new Error('L’alerte « titre déjà chanté » doit être entre 0 et 240 minutes (0 la désactive).');
    }
    const nextPresenceGrace = 'presenceGraceSec' in body ? Number(body.presenceGraceSec) : settings.presenceGraceSec;
    if (!Number.isInteger(nextPresenceGrace) || nextPresenceGrace < 10 || nextPresenceGrace > 300) {
      throw new Error('Le délai pour confirmer « Je suis là » doit être entre 10 et 300 secondes.');
    }
    const nextPresenceSkips = 'presenceMaxSkips' in body ? Number(body.presenceMaxSkips) : settings.presenceMaxSkips;
    if (!Number.isInteger(nextPresenceSkips) || nextPresenceSkips < 1 || nextPresenceSkips > 10) {
      throw new Error('Le nombre de passages manqués doit être entre 1 et 10.');
    }
    // Écart et recul : une valeur vide ou hors bornes est refusée, comme les
    // autres réglages, au lieu d'être ramenée en silence à une autre valeur.
    const strictInt = value => typeof value === 'string' && !value.trim() ? NaN : Number(value);
    const nextGap = 'gap' in body ? strictInt(body.gap) : null;
    if (nextGap !== null && (!Number.isInteger(nextGap) || nextGap < 1 || nextGap > 10)) {
      throw new Error('L’écart entre chanteurs d’une table doit être de 1 à 10 places.');
    }
    const nextCap = 'cap' in body ? strictInt(body.cap) : null;
    if (nextCap !== null && (!Number.isInteger(nextCap) || nextCap < 1 || nextCap > 50)) {
      throw new Error('Le recul maximal doit être de 1 à 50 places.');
    }
    const nextMinVoters = 'battleMinVoters' in body ? Number(body.battleMinVoters) : null;
    if (nextMinVoters !== null && (!Number.isInteger(nextMinVoters) || nextMinVoters < 1 || nextMinVoters > 100)) {
      throw new Error('Le nombre minimal de votants doit être de 1 à 100.');
    }
    const nextSingerSettings = 'singerSongSettings' in body ? body.singerSongSettings : settings.singerSongSettings;
    if (typeof nextSingerSettings !== 'boolean') {
      throw new Error('Le réglage des titres depuis les téléphones est activé ou désactivé (oui ou non).');
    }
    const nextDuoOnly = 'duoOnly' in body ? body.duoOnly : !!settings.duoOnly;
    if (typeof nextDuoOnly !== 'boolean') throw new Error('« Duos uniquement » est activé ou désactivé (oui ou non).');
    // Durée maximale des titres : null (ou false) coupe la limite.
    const nextMaxSong = 'maxSongSec' in body ? (body.maxSongSec === null || body.maxSongSec === false ? null : Number(body.maxSongSec))
      : maxSongLimit();
    if (nextMaxSong !== null && !stageProgress.validMaxSong(nextMaxSong)) {
      throw new Error('La durée maximale des chansons doit être entre 2:00 et 15:00.');
    }
    if (body.auto && recoveredPending) throw new Error('Vérifie d’abord l’envoi interrompu dans KaraFun.');
    if (body.auto && persistenceError) throw new Error('Sauvegarde indisponible : l’envoi automatique reste suspendu.');
    if (body.auto && bridge?.permissions?.addToQueue === false) {
      throw new Error('KaraFun refuse l’ajout de titres au compte FileKaraoke. Vérifie ses permissions.');
    }
    if (nextTableRotation !== sched.opts.tableRotation || nextWeighted !== sched.opts.weightedTables) {
      sched.opts.tableRotation = nextTableRotation;
      sched.opts.weightedTables = nextWeighted;
      // Le tour des personnes est conservé : changer de mode ne doit jamais
      // permettre à quelqu'un de rechanter avant ceux qui attendent ce tour.
      // Les lignes placées par le bar gardent leur place ; les autres sont
      // recalculées selon le nouveau mode.
      sched.note(`Rotation : ${nextWeighted ? 'compromis, grandes tables un peu plus tôt dans le tour' : nextTableRotation ? 'tables à tour de rôle' : 'chacun son tour, la patience d’abord'}`, 'staff');
    }
    if ('interleaveArrivals' in body && !!body.interleaveArrivals !== (sched.opts.interleaveArrivals !== false)) {
      sched.opts.interleaveArrivals = !!body.interleaveArrivals;
      sched.note(`Grande table qui arrive : ${sched.opts.interleaveArrivals ? 'intercalée avec la rotation' : 'passe d’abord en entier'}`, 'staff');
    }
    if ('auto' in body) {
      settings.auto = !!body.auto;
      permissionPause = false;
    }
    if ('autoPlay' in body) { settings.autoPlay = !!body.autoPlay; settings.autoPlayHeld = false; }
    if ('baseUrl' in body) { settings.baseUrl = nextBaseUrl; saveTables(); }
    if (nextGap !== null) sched.opts.gap = nextGap;
    if (nextCap !== null) sched.opts.cap = nextCap;
    if ('requirePresence' in body) {
      sched.opts.requirePresence = !!body.requirePresence;
      if (!sched.opts.requirePresence) sched.clearPresenceRetries();
    }
    settings.pushDelaySec = nextPushDelay;
    settings.playDelaySec = nextPlayDelay;
    settings.repeatWarnMin = nextRepeatWarn;
    settings.presenceGraceSec = nextPresenceGrace;
    settings.presenceMaxSkips = nextPresenceSkips;
    settings.singerSongSettings = nextSingerSettings;
    if (nextDuoOnly !== !!settings.duoOnly) {
      settings.duoOnly = nextDuoOnly;
      sched.note(nextDuoOnly ? 'Duos uniquement : les clients n’ajoutent plus que des duos ; les titres déjà choisis restent.' :
        'Duos uniquement coupé : les clients peuvent de nouveau ajouter des solos.', 'staff');
    }
    if (nextMaxSong !== maxSongLimit()) {
      settings.maxSongSec = nextMaxSong;
      const count = tooLongEntries().length;
      sched.note(nextMaxSong === null ? 'Durée des chansons : plus de limite.' :
        `Durée des chansons limitée à ${minSec(nextMaxSong)} pour les nouveaux ajouts des clients` +
        (count ? ` ; ${count} titre${count > 1 ? 's' : ''} de la file ${count > 1 ? 'dépassent' : 'dépasse'} (« Plus » › règles pour ${count > 1 ? 'les' : 'le'} retirer).` : '.'), 'staff');
    }
    if (nextBattleCooldown !== null) battleVote.setCooldownMinutes(nextBattleCooldown);
    if (nextRejectedCooldown !== null) battleVote.setRejectedCooldownMinutes(nextRejectedCooldown);
    if (nextVoteMin !== null) battleVote.setVoteMinutes(nextVoteMin);
    if (nextMinVoters !== null) battleVote.setMinVoters(nextMinVoters);
    journalSettings(settingsBefore);
    sched.version++; sync();
    return { ok: true };
  },
  // Toutes les options du bar à leur valeur d'origine, pour une nouvelle
  // soirée ou après des réglages faits par quelqu'un d'autre. Gardés : code
  // et connexion KaraFun, connexion et appareil Spotify, adresse des QR,
  // événement privé, tables, bonus, file et soirée en cours.
  'POST /api/staff/settings-reset': async (req, res, body) => {
    if (body.confirmation !== 'OPTIONS PAR DÉFAUT') throw new Error('Confirmation de la remise aux options par défaut manquante.');
    const kept = [];
    // L'envoi automatique ne se rallume que si rien ne l'interdit encore
    // (mêmes raisons que la confirmation de la page du bar).
    const autoBlocked = persistenceError ? 'la sauvegarde est impossible'
      : recoveredPending ? 'un envoi interrompu est à vérifier dans KaraFun'
      : bridge?.permissions?.addToQueue === false ? 'KaraFun refuse l’ajout de titres' : null;
    if (autoBlocked && !settings.auto) kept.push('auto');
    const { auto, ...rest } = DEFAULT_SETTINGS;
    await handlers['POST /api/staff/settings'](req, res, { ...rest, ...(autoBlocked ? {} : { auto }),
      gap: SCHED_DEFAULTS.gap, cap: SCHED_DEFAULTS.cap, requirePresence: SCHED_DEFAULTS.requirePresence,
      tableRotation: SCHED_DEFAULTS.tableRotation, weightedTables: SCHED_DEFAULTS.weightedTables,
      interleaveArrivals: SCHED_DEFAULTS.interleaveArrivals,
      battleCooldownMin: COOLDOWN_MS / 60000, battleRejectedCooldownMin: REJECTED_COOLDOWN_MS / 60000,
      battleVoteMin: VOTE_DURATION_MS / 60000, battleMinVoters: MIN_VOTERS });
    if (settings.closingAt != null) { clearClosing('settings-reset'); sched.version++; }
    // Réglages de la file déjà remis : un échec d'écriture Spotify est
    // signalé sans annoncer une remise à zéro ratée.
    let spotifyError = null;
    try { spotify.setOptions({ ...SPOTIFY_DEFAULTS }); }
    catch (error) { spotifyError = error.message; kept.push('spotify'); }
    sched.note(`Options remises par défaut${kept.includes('auto') ? ` (envoi automatique laissé coupé : ${autoBlocked})` : ''}` +
      `${spotifyError ? `. Automatismes Spotify non remis : ${spotifyError}` : ''}.`, 'staff');
    return { ok: true, kept, ...(kept.includes('auto') ? { autoBlocked } : {}), ...(spotifyError ? { spotifyError } : {}) };
  },
  'POST /api/staff/table': async (req, res, body) => {
    const id = TableAccess.key(body.id);
    const existing = sched.table(id, false);
    if (id === 'Comptoir' && 'individual' in body && !body.individual) {
      throw new Error('Le groupe En solo garde ses tours individuels pendant toute la soirée.');
    }
    if (existing && 'individual' in body && existing.individual !== !!body.individual &&
        sched.tableSingers(id).length) {
      throw new Error('Le mode individuel ne peut pas changer après l’inscription de chanteurs. Crée un autre groupe.');
    }
    const t = existing || sched.table(id);
    if (!access.get(t.id)) access.issue(t.id);
    if (body.headcount) sched.setHeadcount(t.id, body.headcount, 'staff');
    if ('individual' in body) t.individual = !!body.individual;
    saveTables();
    return { ok: true };
  },
  'POST /api/staff/solo-invite': async (req, res, body) => {
    const t = sched.table(TableAccess.key(body.tableId || 'Comptoir'), false);
    if (!t?.individual || !access.get(t.id)) throw new Error('Groupe de personnes seules indisponible.');
    // « En solo » n'a pas de nombre de places : chaque QR individuel crée une place.
    const invitation = soloInvitations.issue(t.id);
    const url = `${access.url(phoneBase(), t.id)}?invitation=${invitation.token}`;
    let qr;
    try { qr = await QRCode.toDataURL(url, { margin: 1, errorCorrectionLevel: 'M' }); }
    catch (error) { soloInvitations.revoke(invitation.id); throw error; }
    sched.note(`Le bar a préparé une invitation individuelle pour ${t.name}.`, 'staff');
    return { id: invitation.id, url, qr, expiresAt: invitation.expiresAt };
  },
  // Événement privé : allumer, couper (le QR imprimé reste pour le rallumer)
  // ou renouveler le QR. Le journal ne note que l'état, jamais le secret.
  'POST /api/staff/private-event': async (req, res, body) => {
    if ('enabled' in body && typeof body.enabled !== 'boolean') {
      throw new Error('L’événement privé est activé ou désactivé (oui ou non).');
    }
    const before = journalSettingsState();
    if (body.enabled === true && !privateEvent.enabled) {
      privateEvent.enable();
      sched.note('Événement privé activé : un seul QR pour tout le monde.', 'staff');
    } else if (body.enabled === false && privateEvent.enabled) {
      privateEvent.disable();
      sched.note('Événement privé coupé : son QR ne permet plus de s’inscrire.', 'staff');
    }
    if (body.rotate) {
      privateEvent.rotate();
      // Les places venues par l'ancien QR, encore sans prénom ni titre, partent
      // sans trace : leur page retombe sur « QR d'événement plus actif ».
      const dropped = [...sched.people.values()].filter(p => p.viaEvent && p.nameRequired && !sched.songsOf(p).length);
      dropped.forEach(dropPlaceholder);
      if (dropped.length) sched.version++;
      // Les personnes de l'ancien QR parties d'elles-mêmes libèrent leur fiche
      // (relecture finale fraîche, décision du gérant) : un script entrée,
      // prénom, un titre puis « Je pars » ne ferme plus le QR pour la soirée,
      // le plafond des fiches vaut pour chaque QR. Comme un départ marqué par
      // le bar (withdrawnBy « staff », sauvegardé), la fiche et son historique
      // restent. Couper puis rallumer le mode ne libère rien.
      let freed = 0;
      for (const p of sched.people.values()) {
        if (p.viaEvent && p.withdrawnAt && p.withdrawnBy === 'self') { p.withdrawnBy = 'staff'; freed++; }
      }
      sched.note(`Nouveau QR d’événement privé : l’ancien est refusé, les inscrits gardent leur accès.${freed ?
        ` Fiches libérées (parties d’elles-mêmes) : ${freed}.` : ''}`, 'staff');
    }
    journalSettings(before);
    return privateEventView();
  },
  'POST /api/staff/solo-invite/revoke': async (req, res, body) => {
    if (!soloInvitations.revoke(String(body.id || ''))) throw new Error('Invitation inconnue ou déjà utilisée.');
    sched.note('Le bar a annulé une invitation individuelle.', 'staff');
    return { ok: true };
  },
  'POST /api/staff/table/rename': async (req, res, body) => {
    const t = sched.renameTable(TableAccess.key(body.tableId), body.name);
    saveTables(); sync(); return { ok: true, table: { id: t.id, name: t.name } };
  },
  'POST /api/staff/tables-create': async (req, res, body) => {
    const n = Math.max(1, Math.min(60, parseInt(body.count, 10) || 10));
    for (let i = 1; i <= n; i++) {
      const t = sched.table(String(i));
      if (!access.get(t.id)) access.issue(t.id);
      if (body.headcount) sched.setHeadcount(t.id, body.headcount, 'staff');
    }
    const comptoir = sched.table('Comptoir');
    if (!access.get(comptoir.id)) access.issue(comptoir.id);
    sched.version++;
    saveTables();
    return { ok: true };
  },
  'POST /api/staff/table-left': async (req, res, body) => {
    const tableId = String(body.id);
    if (tableId === 'Comptoir') {
      throw new Error('Le groupe En solo reste disponible. Termine la soirée pour renouveler son QR.');
    }
    const people = sched.tableSingers(tableId);
    const ids = new Set(people.map(person => person.id));
    // Invités de duos d'autres tables : le titre de l'auteur reste en solo.
    const { upcomingTracks, keptAsSolo } = keepSentDuosOfLeavers(ids);
    if (pending?.sel.ids.some(id => ids.has(id))) pending.cancelled = true;
    sched.tableLeft(tableId);
    // Comme un départ (leavePerson) : leurs codes et liens de reprise meurent.
    for (const id of ids) personShareCodes.delete(id);
    soloInvitations.revokeTable(tableId);
    access.revoke(tableId);
    saveTables();
    removeLeaversTracks(upcomingTracks, ids);
    sync();
    return { ok: true, removedFromKaraFun: upcomingTracks.length, pendingCancelled: !!pending?.cancelled,
      ...(keptAsSolo ? { keptAsSolo } : {}) };
  },
  'POST /api/staff/tables-clear': async (req, res, body) => {
    if (body.confirmation !== 'SUPPRIMER TOUTES LES TABLES') {
      throw new Error('Confirme la remise à zéro de toutes les tables.');
    }
    return clearEvening();
  },
  'POST /api/staff/queue-clear': async (req, res, body) => {
    if (body.confirmation !== 'VIDER TOUTES LES CHANSONS') {
      throw new Error('Confirme le retrait de toutes les chansons en attente.');
    }
    return clearQueue();
  },
  'POST /api/staff/queue-clear-stop': async () => stopQueueClear(),
  'POST /api/staff/table-rotate': async (req, res, body) => {
    const t = sched.table(String(body.id), false);
    if (!t) throw new Error('Table inconnue.');
    access.issue(t.id); saveTables(); sched.note(`Nouveau QR pour ${t.name} : ancien lien désactivé`, 'staff');
    return { url: access.url(phoneBase(), t.id) };
  },
  'POST /api/staff/move': async (req, res, body) => {
    const provisional = pending?.sel || null;
    const excluded = provisional ? (provisional.consumedIds || provisional.ids) : [];
    const personId = String(body.personId || '');
    const toIndex = Number(body.toIndex);
    const priority = body.priority === true && toIndex === 0;
    const visible = sched.presenceView(excluded, provisional).filter(v => !v.future);
    const nativeAhead = analyze().upcoming.length + (pending ? 1 : 0);
    const from = visible.findIndex(v => v.ids[0] === personId);
    // « Faire passer X avant « titre chargé » ? » confirmé par le bar : rien
    // ne change si ce titre n'attend plus dans KaraFun (commencé entre-temps,
    // envoi en cours…). Le premier passage libre peut aussi passer avant lui.
    const pull = priority && body.pullLoaded === true ? priorityPullFor(visible[from], body.queueId) : null;
    if (priority && from === 0 && !pull) {
      throw new Error(nativeAhead ?
        `Ce titre est déjà le prochain passage libre. ${nativeAhead} titre${nativeAhead > 1 ? 's sont' : ' est'} déjà chargé${nativeAhead > 1 ? 's' : ''} dans KaraFun devant lui.` :
        'Ce titre est déjà le prochain passage libre.');
    }
    if (from >= 0 && from === toIndex && !pull) {
      return { ok: true, changed: false, message: 'Ce titre est déjà à cette place.' };
    }
    const name = visible[from]?.name || sched.people.get(personId)?.name || 'ce chanteur';
    // Le geste est noté avant sync() : un passage confirmé par KaraFun
    // pendant ce balayage fait avancer la ligne placée sans l'effacer. Il
    // reste annulable après tout autre changement de la file.
    const before = sched.manualOverrideState({ deferrals: true });
    if (pull) {
      // KaraFun refuse la commande : rien n'a changé, ni dans KaraFun ni dans la file.
      try { pullFromKaraFun(pull, 'priority', { forId: personId }); }
      catch (error) {
        throw new Error(`KaraFun n’a pas pu retirer « ${pull.sel.song.title} » (${String(error.message).replace(/[.!?\s]+$/, '')}) : rien n’a changé.`);
      }
    }
    sched.staffMove(personId, toIndex, excluded, provisional);
    sched.recordManualChange({
      kind: priority ? 'priority' : 'move', personId, name,
      from: from + 1, to: toIndex + 1, before, native: priorityNativeFingerprint(),
    });
    if (pull) {
      sched.note(`Le bar fait passer ${name} avant « ${pull.sel.song.title} » (${shownLabel(pull.sel)}) : ce titre sort de KaraFun et repasse juste après, sans perdre son tour`, 'staff');
    }
    sync();
    journalEvent('staff.move', { personId, kind: priority ? 'priority' : 'move', from: from + 1, to: toIndex + 1,
      ...(pull ? { pulledEntryId: pull.sel.song.entryId || null } : {}) });
    if (pull) {
      return { ok: true, firstFreePosition: 1, pulled: { queueId: pull.queueId, title: pull.sel.song.title },
        message: `« ${pull.sel.song.title} » sort de KaraFun : ${name} passe d’abord, « ${pull.sel.song.title} » juste après.` };
    }
    // Sans retrait, la priorité passe juste après notre titre déjà chargé.
    const loaded = priority && nativeAhead === 1 && !pending ? tracked.find(tr => !tr.startedAt && !tr.pulled && !tr.cancelled &&
      String(tr.queueId) === String(analyze().upcoming[0]?.queueId)) : null;
    return { ok: true, firstFreePosition: nativeAhead + 1,
      message: loaded ? `${name} passe juste après « ${loaded.sel.song.title} », déjà chargé dans KaraFun.` :
        priority && nativeAhead ?
        `Passage avancé à la première place libre, après ${nativeAhead} titre${nativeAhead > 1 ? 's' : ''} déjà chargé${nativeAhead > 1 ? 's' : ''} dans KaraFun.` : null };
  },
  'POST /api/staff/manual-change-undo': async (req, res, body) => {
    if (!body.id) throw new Error('Indique le changement manuel à annuler.');
    // Sans autre changement depuis le geste, l'ordre d'avant revient ; sinon
    // seule sa ligne retrouve le calcul, ou la place d'un geste plus ancien.
    const native = priorityNativeFingerprint();
    const exact = sched.canUndoManualChange(native);
    const change = sched.undoLastManualChange(String(body.id), native, { excludeIds: sendingIds() });
    const older = sched.manualChanges.some(other => other.personId === change.personId);
    sync();
    return { ok: true, exact, message: exact ? 'Dernier changement annulé ; ordre précédent retrouvé' : older ?
      `Dernier changement annulé : ${change.name} retrouve la place de son changement précédent` :
      `Dernier changement annulé : la file a changé depuis, ${change.name} retrouve sa place calculée` };
  },
  'POST /api/staff/priority-undo': async () => {
    if (sched.manualChanges.at(-1)?.kind !== 'priority') {
      throw new Error('La dernière intervention du bar n’est pas une priorité.');
    }
    sched.undoLastManualChange(null, priorityNativeFingerprint(), { excludeIds: sendingIds() });
    sync();
    return { ok: true };
  },
  'POST /api/staff/queue-recalculate': async () => {
    const count = sched.undoAllManualChanges(priorityNativeFingerprint(), { excludeIds: sendingIds() });
    sync();
    return { ok: true, undone: count };
  },
  'POST /api/staff/remove': async (req, res, body) => { sched.staffRemove(body.personId); sync(); return { ok: true }; },
  'POST /api/staff/remove-many': async (req, res, body) => {
    const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    const queueIds = Array.isArray(body.queueIds) ? body.queueIds.slice(0, 50).map(String) : [];
    if (!items.length && !queueIds.length) throw new Error('Coche au moins un titre à retirer.');
    let removed = 0;
    const skipped = [];
    for (const item of items) {
      const personId = String(item?.personId || '');
      const entryId = item?.entryId ? String(item.entryId) : null;
      if (pending && !pending.cancelled && pending.sel.ids[0] === personId &&
          (!entryId || pending.sel.song.entryId === entryId)) {
        skipped.push('titre en cours d’envoi à KaraFun');
        continue;
      }
      try { sched.staffRemoveEntry(personId, entryId); removed++; }
      catch (error) { skipped.push(error.message); }
    }
    for (const queueId of queueIds) {
      const tr = tracked.find(item => String(item.queueId) === queueId && !item.cancelled);
      const { current } = analyze();
      if (!tr || isOnStage(tr, current)) { skipped.push('titre déjà sur scène ou absent de KaraFun'); continue; }
      try { bridge?.remove(tr.queueId); removed++; }
      catch (error) { skipped.push(error.message); }
    }
    sync();
    return { ok: true, removed, skipped: skipped.length,
      message: `${removed} titre${removed > 1 ? 's' : ''} retiré${removed > 1 ? 's' : ''}${skipped.length ? ` ; ${skipped.length} ignoré${skipped.length > 1 ? 's' : ''} (${[...new Set(skipped)].join(', ')})` : ''}.` };
  },
  // Durée maximale (décision D9) : les titres trop longs déjà dans la file
  // restent jusqu'à ce geste du bar ; chaque personne est prévenue sur son
  // téléphone, l'invitée d'un duo aussi (au lieu de « … a annulé le duo »).
  // Les titres déjà dans KaraFun ou en cours d'envoi restent.
  'POST /api/staff/songs-too-long/remove': async () => {
    const limit = maxSongLimit();
    if (limit == null) throw new Error('Active d’abord « Limiter la durée des chansons ».');
    let removed = 0;
    const skipped = [];
    for (const { p, song, sec } of tooLongEntries()) {
      const partnerId = song.duet?.partnerId || null;
      try { sched.staffRemoveEntry(p.id, song.entryId, pid => pid !== partnerId); }
      catch (error) { skipped.push(error.message); continue; }
      removed++;
      const params = { title: song.title, length: minSec(sec), limit: minSec(limit) };
      sched.notify(p.id, 'tooLongRemoved', params);
      if (partnerId) sched.notify(partnerId, 'tooLongRemoved', { ...params, name: p.name });
    }
    journalEvent('songLength.removed', { count: removed, limitSec: limit });
    if (removed) sched.note(`Le bar a retiré ${removed} titre${removed > 1 ? 's' : ''} plus long${removed > 1 ? 's' : ''} que ${minSec(limit)} ; les personnes concernées sont prévenues.`, 'staff');
    sync();
    return { ok: true, removed, skipped: skipped.length,
      message: `${removed} titre${removed > 1 ? 's' : ''} trop long${removed > 1 ? 's' : ''} retiré${removed > 1 ? 's' : ''}${skipped.length ? ` ; ${skipped.length} ignoré${skipped.length > 1 ? 's' : ''} (${[...new Set(skipped)].join(', ')})` : ''}.` };
  },
  'POST /api/staff/queue-optimize': async () => {
    const started = sched.forceReplan(30000);
    sync();
    return { ok: true, started, message: started ?
      'Calcul complet lancé : 30 secondes au plus, puis la recherche continue tant que la file ne change pas. La file affichée reste utilisable pendant ce temps.' :
      'Optimisation indisponible : la file a été recalculée par la règle locale.' };
  },
  // Réglages d'un titre à venir (même déjà chargé dans KaraFun). Le titre en
  // cours se règle en direct : POST /api/staff/kf { action: 'pitch' | 'tempo' | 'track' }.
  'POST /api/staff/song/settings': async (req, res, body) => {
    const target = songSettingsTarget(body.entryId, 'Ce titre est sur scène : règle-le en direct.');
    const personId = body.personId == null ? '' : String(body.personId);
    if (personId && !target.ids.includes(personId)) {
      throw songSettingsError(`Ce titre n’est pas celui de ${sched.people.get(personId)?.name || 'cette personne'}.`, 'NOT_OWNER');
    }
    const values = normalizeSettings(songSettingsInput(body.settings, target), songRanges());
    return { ok: true, settings: values, applied: applySongSettings(target, values, { by: 'staff' }) };
  },
  'POST /api/staff/bonus': async (req, res, body) => {
    if (body.tableId != null && body.tableId !== '') sched.setTableBonus(TableAccess.key(body.tableId), body.level);
    else if (body.personId) sched.setPersonBonus(String(body.personId), body.level);
    else throw new Error('Choisis une table ou une personne.');
    sync();
    return { ok: true };
  },
  'POST /api/staff/person/identify': async (req, res, body) => {
    const p = sched.setPrivateNote(body.personId, 'note' in body ? body.note : undefined);
    return { ok: true, personId: p.id };
  },
  'POST /api/staff/person/share': async (req, res, body) => {
    const p = sched.people.get(String(body.personId || ''));
    if (!p || p.withdrawnAt) throw new Error('Chanteur inconnu ou parti.');
    // Le QR mène directement à la reprise de cette personne ; le code sert
    // si le téléphone ne peut pas scanner (saisie après le QR de la table).
    return createPersonShareCode(p);
  },
  'POST /api/staff/person/leave': async (req, res, body) => {
    const p = sched.people.get(String(body.personId || ''));
    if (!p) throw new Error('Chanteur inconnu.');
    const placeholder = p.viaEvent && disposablePlaceholder(p);
    // La page du bar a confirmé « Retirer la place « Solo N » ? » sur l'état
    // qu'elle affichait : si l'invitée a donné son prénom entre-temps, rien
    // ne change. Sans ce drapeau (page d'avant la mise à jour) : comme avant.
    if (body.expectPlaceholder === true && !placeholder) {
      throw new Error('Cette place vient de recevoir un prénom : vérifie avant de la marquer partie.');
    }
    // Place « Solo N » du QR de l'événement, sans prénom ni titre : supprimée
    // sans trace, comme par /api/leave. Marquée partie, son navigateur
    // resterait lié à une fiche que le bar ne saurait pas réactiver ; il
    // rescanne le QR de l'événement et retrouve une nouvelle place.
    if (placeholder) {
      dropPlaceholder(p);
      sched.version++;
      sync();
      return { ok: true, removedFromKaraFun: 0, pendingCancelled: false,
        message: `Place « ${p.name} » sans prénom retirée : s’il est encore là, il rescanne le QR de l’événement.` };
    }
    // Invitée d'un duo déjà chargé : le titre reste dans KaraFun, au nom de
    // son auteur seul.
    const { upcomingTracks, keptAsSolo } = keepSentDuosOfLeavers(new Set([p.id]));
    leavePerson(p, 'staff');
    if (pending?.sel.ids.includes(p.id)) pending.cancelled = true;
    removeLeaversTracks(upcomingTracks, new Set([p.id]));
    sync();
    return { ok: true, removedFromKaraFun: upcomingTracks.length, pendingCancelled: !!pending?.cancelled,
      ...(keptAsSolo ? { keptAsSolo } : {}) };
  },
  'POST /api/staff/stage-history/clear': async () => {
    const removed = sched.clearStageHistory([onStageEntryId()]);
    return { ok: true, removed };
  },
  'POST /api/staff/person/present': async (req, res, body) => {
    const p = sched.people.get(String(body.personId || ''));
    if (!p) throw new Error('Personne introuvable.');
    // Page d'un autre appareil en retard : la personne a déjà été marquée
    // partie (ce qui ferme aussi l'alerte) ; le dire plutôt qu'un succès.
    const ref = sched.personRef(p);
    if (p.withdrawnAt) {
      return { ok: false, message: `« Parti » déjà noté pour ${ref} : ses titres ont été retirés. Si cette personne est là : « Réactiver » dans « Repères », puis un titre à rechoisir sur son téléphone.` };
    }
    const dismissed = sched.dismissMaybeGone(p);
    if (dismissed) return { ok: true, message: dismissed };
    // Alerte déjà fermée (second appareil, page en retard, double appui) :
    // un passage déjà envoyé l'a peut-être fermée ; sinon, la même suite.
    const sent = [pending?.sel, ...tracked.map(tr => tr.sel)].find(sel => sel?.ids?.includes(p.id));
    if (sent) return { ok: true, message: `Alerte déjà fermée pour ${ref} : son passage « ${sent.song?.title || '?'} » est déjà dans KaraFun.` };
    return { ok: true, message: `Alerte déjà fermée pour ${ref}. ${sched.presenceFollowUp(p)}` };
  },
  'POST /api/staff/person/reactivate': async (req, res, body) => {
    const p = sched.people.get(String(body.personId || ''));
    if (!p || !p.withdrawnAt) throw new Error('Cette personne n’est pas marquée partie.');
    const t = sched.table(p.tableId, false);
    if (!t) throw new Error('La table n’est plus ouverte.');
    if (!t.individual && sched.tableSingers(t.id).filter(person => !person.withdrawnAt).length >= t.headcount) {
      throw new Error('La table est pleine. Ajuste son effectif avant de réactiver cette personne.');
    }
    p.withdrawnAt = null;
    journalEvent('person.reactivated', { personId: p.id });
    sched.note(`${t.individual ? `${p.name} revient` : `${p.name} revient à ${t.name}`} ; son historique de passages est conservé`, 'staff');
    // Sa clé personnelle est morte au départ : son téléphone retrouve ses
    // droits, mais une page perdue ne revient que par un QR de reprise.
    return p.soloKeyRevoked ? { ok: true,
      message: `${p.name} revient. Son QR personnel ne sert plus : s’il a perdu sa page, donne-lui un QR de reprise.` } : { ok: true };
  },
  // Heure de fermeture : à régler, décaler (« encore une chanson ! ») ou retirer.
  'POST /api/staff/closing': async (req, res, body) => {
    const closingBefore = settings.closingAt;
    if (body.clear) clearClosing();
    else if (body.extendMin !== undefined) {
      const minutes = Number(body.extendMin);
      if (closingAt() == null) throw new Error('Indique d’abord une heure de fermeture.');
      if (!Number.isInteger(minutes) || minutes === 0 || minutes < -60 || minutes > 180) {
        throw new Error('Décale la fermeture de -60 à +180 minutes.');
      }
      // Une fermeture déjà passée repart de maintenant.
      const base = minutes > 0 ? Math.max(settings.closingAt, Math.floor(Date.now() / 60000) * 60000) : settings.closingAt;
      settings.closingAt = base + minutes * 60000;
      sched.note(`Fermeture décalée à ${hhmm(settings.closingAt)}.`, 'staff');
    } else {
      settings.closingAt = nextClosing(body.time);
      sched.note(`Le bar ferme à ${hhmm(settings.closingAt)}.`, 'staff');
    }
    if (settings.closingAt != null) journalEvent('closing.set', { closingAt: settings.closingAt,
      deltaMin: Number.isFinite(closingBefore) ? Math.round((settings.closingAt - closingBefore) / 60000) : null });
    sched.version++;
    return { ok: true, closingAt: settings.closingAt };
  },
  'POST /api/staff/spotify': async (req, res, body) => {
    const action = String(body.action || '');
    if (action === 'client') spotify.setClientId(body.clientId);
    else if (action === 'auth-url') return { ok: true, url: spotify.authUrl(spotifyRedirect()) };
    else if (action === 'disconnect') spotify.disconnect();
    else if (action === 'device') { spotify.setDevice(body.deviceId, body.deviceName); await spotifyCheck(); }
    else if (action === 'options') spotify.setOptions({
      ...('autoResume' in body ? { autoResume: !!body.autoResume } : {}),
      ...('autoPause' in body ? { autoPause: !!body.autoPause } : {}),
      ...('resumeDelaySec' in body ? { resumeDelaySec: Number(body.resumeDelaySec) } : {}),
      ...('pauseLeadSec' in body ? { pauseLeadSec: Number(body.pauseLeadSec) } : {}) });
    else if (action === 'play' || action === 'pause') {
      // Choix du bar : l'automate ne le défait pas pendant ce silence ou ce
      // titre. Attente de la Battle : le choix vaut pour elle, même fait juste
      // après la fin du titre d'avant, avant que l'automate l'ait vue ; hors
      // Battle, comme avant, pour la période que l'automate a vue.
      const result = action === 'play' ? await spotify.resume() : await spotify.pause();
      if (karaokeOutlook() === 'battle') spotifyAutomation.handled('battle');
      else spotifyAutomation.handled();
      journalEvent('spotify', { action: action === 'play' ? 'resume' : 'pause', result: String(result || ''), trigger: 'staff' });
      return { ok: true, result };
    }
    // « Vérifier Spotify » : liste des appareils, appareil repris, état du lecteur.
    else if (action === 'refresh') return { ok: true, health: await spotifyCheck() };
    else throw new Error('Action Spotify inconnue.');
    return { ok: true };
  },
  // Duo improvisé : noter le second chanteur, ou, avec `replace`, corriger
  // un duo déjà noté au bar (le précédent est d'abord annulé). Après la
  // chanson, `stageEntryId` désigne le passage dans les derniers passages.
  'POST /api/staff/duo-mark': async (req, res, body) => {
    const partnerId = String(body.partnerId || '');
    // Vérifié avant tout changement (un remplacement annule d'abord l'ancien duo).
    if (sched.people.get(partnerId)?.nameRequired) throw new Error('Cette personne n’a pas encore saisi son prénom.');
    const byEntry = body.stageEntryId != null && body.stageEntryId !== '';
    const target = byEntry ? staffDuoTarget(body) :
      staffDuoTarget({ queueId: body.queueId }, 'Choisis un passage solo encore visible dans KaraFun.');
    const { current } = analyze();
    // Titre suivi pas encore commencé (chargé ou en attente dans KaraFun) :
    // refusé, comme sur la page du bar qui n'envoie que le titre sur scène
    // (relecture finale fraîche). Noté avant son passage puis sauté, il
    // laissait le dernier passage de l'invitée au-delà du compteur des
    // passages.
    if (!byEntry && !target.tr.startedAt && !isOnStage(target.tr, current)) {
      throw new Error('Ce titre n’a pas encore commencé : note le duo pendant la chanson en cours.');
    }
    const record = staffDuoRecord(target);
    const holder = target.tr ? target.tr.sel : target.entry;
    if (body.replace && !record && holder.ids.length !== 1) throw new Error('Aucun duo noté par le bar sur ce passage.');
    if (!(body.replace && record) && (holder.ids.length !== 1 || (byEntry && !body.replace))) {
      throw new Error('Choisis un passage solo encore visible dans KaraFun.');
    }
    let previous = null, undoText = '';
    if (body.replace && record) {
      const late = staffDuoTooLate(record);
      if (late) throw new Error(late);
      const candidate = sched.people.get(partnerId), owner = sched.people.get(record.ownerId);
      if (candidate && partnerId === record.partnerId) throw new Error(`${candidate.name} est déjà noté sur ce duo.`);
      // Tout est vérifié avant d'annuler l'ancien duo : rien ne doit échouer à moitié.
      if (!candidate || candidate.withdrawnAt || partnerId === record.ownerId || !owner || owner.withdrawnAt) {
        throw new Error('Choisis un autre chanteur encore présent dans la salle.');
      }
      previous = sched.people.get(record.partnerId);
      undoText = undoStaffDuo(target, record);
    }
    const ownerId = holder.ids[0];
    // Ses titres déjà chargés dans KaraFun gardent le duo dans leur reçu : si
    // l'un est retiré sans être chanté, le duo compte toujours pour lui.
    const inFlight = tracked.filter(item => item !== target.tr && !item.startedAt && !item.cancelled &&
      !isOnStage(item, current) && item.sel.ids.includes(partnerId)).map(item => item.sel);
    // Chanson finie (plus suivie) : le duo est noté sur le titre du passage,
    // pour que le journal et les statistiques le rattachent au bon passage,
    // et l'invité compté au tour de ce passage (relevé par recordStage).
    const sel = target.tr ? target.tr.sel : { song: { entryId: target.entry?.entryId || null }, turn: target.entry?.turn };
    const partner = sched.staffCountPartner(ownerId, partnerId, sel, inFlight);
    const mark = sel.staffDuo;
    mark.kindBefore = holder.kind || 'solo';
    if (target.tr) {
      mark.labelBefore = target.tr.sel.label;
      target.tr.sel.ids.push(partner.id);
      target.tr.sel.names.push(partner.name);
      target.tr.sel.kind = 'duo';
      target.tr.sel.label = sched.passageLabel(target.tr.sel.ids);
    }
    if (target.entry) {
      sched.setStagePeople(target.entry, [...target.entry.ids, partner.id], 'duo');
      target.entry.staffDuo = mark;
    }
    // Le partenaire du duo improvisé vient de monter sur scène : son propre
    // titre déjà chargé dans KaraFun ne doit pas passer juste après. Il est
    // retiré de KaraFun et reprend sa place dans la file, qui le fait passer
    // plus tard selon l'espacement habituel.
    let moved = 0;
    mark.pulled = [];
    // Seuls ses propres titres : un duo d'une autre personne où il est invité
    // garde sa place.
    for (const item of tracked) {
      if (item === target.tr || item.cancelled || item.pulled || item.absent || item.startedAt ||
          isOnStage(item, current) || item.sel.ids[0] !== partner.id) continue;
      try {
        pullFromKaraFun(item, 'duo'); moved++;
        mark.pulled.push({ entryId: item.sel.song?.entryId || null, title: item.sel.song?.title || '' });
      } catch (error) { sched.note(`Titre de ${partner.name} à retirer de KaraFun : ${error.message}`, 'error'); }
    }
    if (pending && !pending.cancelled && pending.sel.ids[0] === partner.id) {
      pending.pullOnAck = 'duo'; moved++;
      mark.pulled.push({ entryId: pending.sel.song?.entryId || null, title: pending.sel.song?.title || '' });
    }
    if (previous) {
      sched._event?.('duo.improvisedReplaced', { ownerId, partnerId: partner.id, previousPartnerId: previous.id, entryId: mark.entryId });
    }
    sync();
    const movedText = moved ? ` Le titre suivant de ${partner.name} est retiré de KaraFun : ${partner.name} chantera plus tard.` : '';
    return { ok: true, moved, message: previous ?
      `Duo corrigé : ${partner.name} chante avec ${sched.people.get(ownerId)?.name || 'le chanteur'} à la place de ${previous.name}.${undoText}${movedText}` :
      moved ? `Duo noté.${movedText}` : 'Duo comptabilisé' };
  },
  // Duo improvisé noté par erreur : le chanteur reprend son solo, l'invité
  // retrouve son tour et, si possible, son titre retiré de KaraFun.
  'POST /api/staff/duo-unmark': async (req, res, body) => {
    const target = staffDuoTarget(body);
    const record = staffDuoRecord(target);
    if (!record) throw new Error('Aucun duo noté par le bar sur ce passage.');
    const late = staffDuoTooLate(record);
    if (late) throw new Error(late);
    const owner = sched.people.get(record.ownerId), partner = sched.people.get(record.partnerId);
    const text = undoStaffDuo(target, record);
    sched._event?.('duo.improvisedCancelled', { ownerId: record.ownerId, partnerId: record.partnerId, entryId: record.entryId });
    sync();
    return { ok: true, message: `Duo avec ${partner?.name || 'ce chanteur'} annulé : ${owner?.name || 'le chanteur'} chante seul ce titre.${text}` };
  },
  'POST /api/staff/battle/launch': async (req, res, body) => {
    const [song] = certifiedBattleSongs([body.song]);
    const battle = battleVote.staffLaunch({ song });
    sync();
    return { ok: true, battle };
  },
  'POST /api/staff/battle/close': async () => {
    const battle = battleVote.closeNow();
    sync();
    return { ok: true, battle };
  },
  // Le bar autorise une nouvelle proposition sans attendre la fin de la pause.
  'POST /api/staff/battle/reset-cooldown': async () => {
    const battle = battleVote.endCooldownNow();
    sched.note('Le bar autorise une nouvelle Battle dès maintenant.', 'battle');
    sync();
    return { ok: true, battle };
  },
  'POST /api/staff/battle/resolve': async (req, res, body) => {
    const battle = body.outcome === 'finished' ? battleVote.finishManual() :
      battleVote.resolve({ outcome: body.outcome });
    return { ok: true, battle };
  },
  'POST /api/staff/reconcile-pending': async () => {
    if (!recoveredPending) throw new Error('Aucun envoi interrompu à vérifier.');
    if (!bridge?.ready) throw new Error('Attends la reconnexion à KaraFun pour vérifier sa file.');
    if (bridge.permissions?.addToQueue === false) throw new Error('Donne d’abord au compte FileKaraoke le droit d’ajouter des titres.');
    sync();
    if (pending) {
      const { inspectRecoveredPending } = require('./night-state');
      const result = inspectRecoveredPending(pending, bridge.queue);
      if (result.state === 'ambiguous') throw new Error('Plusieurs titres correspondants dans KaraFun : retire le doublon manuellement avant de reprendre.');
      if (result.state === 'found') throw new Error('Un titre correspondant est encore en cours de rapprochement. Réessaie dans un instant.');
      pending = null;
    }
    recoveredPending = false;
    settings.auto = true;
    sched.note('Envoi interrompu vérifié par le bar ; envoi automatique repris.', 'staff');
    sync();
    return { ok: true };
  },
  'POST /api/staff/kf': async (req, res, body) => {
    if (!bridge) throw new Error('KaraFun non connecté');
    if (body.action === 'play') {
      const status = battleVote.automation?.status;
      if (status === 'after') {
        if (afterBattleStarting) { await afterBattleStarting; return { ok: true }; }
        if (!bridge.ready) throw new Error('KaraFun est déconnecté. Reconnecte-le avant de reprendre après la Battle.');
        const upcoming = analyze().upcoming;
        const nextNative = !!upcoming[0] && !isBattleItem(upcoming[0]);
        const nextPending = !!pending && !pending.cancelled && !recoveredPending;
        const nextLocal = nextPending || sched.readyView().some(turn => !turn.future && turn.song);
        if (!nextNative && !nextLocal) {
          throw new Error('Aucun titre suivant. Ajoute d’abord une chanson, puis lance la reprise.');
        }
        if (!nextNative && !nextPending && !settings.auto) {
          throw new Error('Active l’envoi automatique à KaraFun avant de lancer le titre suivant.');
        }
        if (!nextNative && !nextPending && (recoveredPending || bridge.permissions?.addToQueue === false)) {
          throw new Error('KaraFun ne peut pas recevoir ce titre. Vérifie l’envoi interrompu et ses droits avant de reprendre.');
        }
        // Spotify a repris pendant l'attente : coupé d'abord, puis le court
        // silence, comme avant tout lancement. Un second appui pendant ce
        // temps attend ce premier, qui lance seul. Titre lancé dans KaraFun
        // entre-temps : la file a déjà repris.
        const pausing = pauseSpotifyBeforeStart();
        if (pausing) {
          afterBattleStarting = pausing;
          try { await pausing; } finally { afterBattleStarting = null; }
        }
        if (battleVote.automation?.status !== 'after') return { ok: true };
        battleVote.updateAutomation('resuming');
        sched.note('Le bar lance manuellement le premier titre après la Battle.', 'battle');
        sync();
      } else if (['queued', 'manual', 'failed'].includes(status)) {
        // Lancer la Battle depuis cette page, comme depuis KaraFun : le titre
        // Battle doit être le prochain et rien ne doit être en lecture.
        if (!bridge.ready) throw new Error('KaraFun est déconnecté. Reconnecte-le avant de lancer la Battle.');
        const { current, upcoming } = analyze();
        if (current && isBattleItem(current)) throw new Error('La Battle est déjà en cours.');
        if (current) throw new Error('Un titre est en cours : la Battle pourra être lancée à sa fin.');
        if (!upcoming[0] || !isBattleItem(upcoming[0])) {
          throw new Error('La Battle n’est pas le prochain titre dans KaraFun. Vérifie sa file.');
        }
        await playKaraFun();
        sched.note('Le bar lance la Battle depuis la page du bar.', 'battle');
      } else if (status === 'sending') {
        throw new Error('KaraFun n’a pas encore confirmé la Battle. Réessaie dans un instant.');
      } else if (status === 'playing') {
        throw new Error('La Battle est déjà en cours.');
      } else {
        await playKaraFun();
        journalEvent('staff.play', {});
        releaseAutoPlay();
      }
    }
    else if (body.action === 'next') { bridge.next(); journalEvent('staff.next', {}); }
    else if (body.action === 'restart') startRestart();
    else if (body.action === 'reconnect') {
      if (!CODE) throw new Error('Pas de code KaraFun : saisis d’abord le code affiché dans KaraFun.');
      return connectionAnswer(connectKaraFun());
    }
    else if (body.action === 'new-name') { bridge.forceNewName(); sched._event?.('karafun.renamed', {}); }
    else if (body.action === 'dismiss-notice') bridge.dismissIdentityNotice?.();
    else if (body.action === 'absent') {
      const tr = tracked.find(x => x.queueId === body.queueId && !x.startedAt);
      if (!tr) throw new Error('Cette chanson a déjà commencé ou n\'est pas de la file');
      tr.absent = true;
      bridge.remove(tr.queueId);
      journalEvent('staff.absent', { queueId: tr.queueId, entryId: tr.sel.song.entryId || null, ids: tr.sel.ids });
    } else if (body.action === 'remove') bridge.remove(body.queueId);
    else if (body.action === 'test-add') bridge.add(body.songId, 'Test file karaoké');
    else if (['pitch', 'tempo', 'track'].includes(body.action)) return liveSongSetting(body);
    else throw new Error('Action inconnue');
    setTimeout(sync, 300);
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  // Cible de requête que URL ne sait pas lire (//x:99999/, http://[), deux
  // ports, sans clé : 400. Levée hors du try, l'exception deviendrait un rejet
  // non géré qui arrêterait la file.
  let u;
  try { u = new URL(req.url, 'http://x'); }
  catch (_) { return send(res, 400, 'Requête invalide', 'text/plain; charset=utf-8'); }
  const p = u.pathname;
  try {
    // Sonde de vie (deux modes) : deux ports, toute adresse, aucun secret.
    if (p === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) return send(res, 200, 'ok', 'text/plain; charset=utf-8');
    if (req.method === 'GET') {
      if (p === '/' ) {
        if (authenticatedStaffEntry(req)) return redirectStaffEntry(res);
        if (!isLocal(req) || req.socket.localPort === PUBLIC_PORT) return send(res, 403, 'Scanne le QR code de ta table.', 'text/plain; charset=utf-8');
        res.writeHead(302, { Location: `/staff?key=${STAFF_KEY}`, 'Referrer-Policy': 'no-referrer' }); return res.end();
      }
      // Sonde de disponibilité (deux modes) : port du bar seulement, sans clé.
      if (p === '/readyz') {
        if (req.socket.localPort === PUBLIC_PORT) return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
        const state = readiness();
        return send(res, state.ok ? 200 : 503, state);
      }
      let m = /^\/t\/([^/]+)\/([A-Za-z0-9_-]{22})\/?$/.exec(p);
      if (m) {
        tableByAccess(decodeURIComponent(m[1]), m[2]);
        return sendFile(res, 'client.html', 'text/html; charset=utf-8');
      }
      if (/^\/t\/[^/]+\/?$/.test(p)) return send(res, 403, 'Scanne le QR code de ta table.', 'text/plain; charset=utf-8');
      if (p === '/staff') {
        if (!u.searchParams.has('key') && !isStaff(req, u) && authenticatedStaffEntry(req)) return redirectStaffEntry(res);
        if (!staffPageAllowed(req, u)) return send(res, 403, 'Réservé au bar', 'text/plain; charset=utf-8');
        return sendFile(res, 'staff.html', 'text/html; charset=utf-8');
      }
      if (p === '/print') { if (!isStaff(req, u)) return send(res, 403, 'Réservé au bar', 'text/plain; charset=utf-8'); return sendFile(res, 'print.html', 'text/html; charset=utf-8'); }
      if (p === '/app.css') return sendFile(res, 'app.css', 'text/css; charset=utf-8');
      // Traductions de la page des chanteurs, publiques comme elle.
      if (p === '/client-i18n.js') return sendFile(res, 'client-i18n.js', 'text/javascript; charset=utf-8');
      if (p === '/api/state') {
        const me = sched.person(u.searchParams.get('token') || '');
        if (me && !u.searchParams.has('table')) {
          requireSoloControl(req, me);
          // Page cachée (« 0 ») : aucun signe de vie, ni affiché ni au journal.
          // Soirée du 10 octobre : des téléphones restés ouverts en arrière-plan
          // ont compté des présences jusqu'au lendemain midi.
          if (req.headers['x-page-visible'] !== '0') { touchSeen(me); noteSeen(me); }
          const view = publicState(me, me.tableId, new Set([me.id]));
          // Même règle que la lecture par table : seule la place sans prénom
          // dont ce navigateur est le téléphone actuel laisse la reprise ouverte.
          if (view.recoveryPeople && !me.withdrawnAt && !ownDisposablePlaceholder(req, me)) {
            view.recoveryPeople = view.recoveryPeople.filter(person => person.id === me.id);
          }
          view.managedIds = [me.id];
          return send(res, 200, view);
        }
        const t = tableByAccess(u.searchParams.get('table'), u.searchParams.get('access'));
        let headerTokens = [];
        try {
          const parsed = JSON.parse(String(req.headers['x-person-tokens'] || '[]'));
          if (Array.isArray(parsed)) headerTokens = parsed.filter(token => typeof token === 'string');
        } catch (_) { /* Une liste mal formée ne donne aucun accès. */ }
        const soloOwner = t.individual ? soloDeviceOwner(req) : null;
        const owned = [...u.searchParams.getAll('token'), ...headerTokens].slice(0, 40).map(token => sched.person(token))
          .filter(person => person && person.tableId === t.id && (!t.individual || person.id === soloOwner?.id));
        const view = publicState(owned[0] || null, t.id, new Set(owned.map(person => person.id)));
        if (t.individual) view.soloInvitationReady = !!soloInvitations.verify(u.searchParams.get('invitation'), t.id);
        if (u.searchParams.has('reprise')) {
          const target = transferTarget(u.searchParams.get('reprise'), t);
          view.transferOffer = target ? { personId: target.id, name: target.name,
            expiresAt: personShareCodes.get(target.id)?.linkExpiresAt || null } : { invalid: true };
        }
        if (t.individual && soloOwner && !soloOwner.withdrawnAt && !ownDisposablePlaceholder(req, soloOwner)) {
          view.recoveryPeople = (view.recoveryPeople || []).filter(person => person.id === soloOwner.id);
        }
        view.managedIds = [...new Set(owned.map(person => person.id))];
        // Activité : sauf une page cachée (« 0 » ; la page continue d'interroger
        // en arrière-plan), pour toutes les personnes gérées par ce téléphone.
        // Sans en-tête : page gardée en cache d'avant la mise à jour, comptée.
        if (req.headers['x-page-visible'] !== '0') for (const person of owned) { touchSeen(person); noteSeen(person); }
        return send(res, 200, view);
      }
      if (['/stats', '/api/staff/stats', '/api/staff/stats/evenings', '/api/staff/stats/export'].includes(p)) {
        return statsRoute(p, u, req, res);
      }
      if (p === '/api/staff/state') { if (!isStaff(req, u)) return send(res, 403, { error: 'Réservé au bar' }); return send(res, 200, staffState()); }
      if (p === '/api/song/notice') {
        const table = tableByAccess(u.searchParams.get('table'), u.searchParams.get('access'));
        const song = { songId: Number(u.searchParams.get('songId')) || null,
          title: String(u.searchParams.get('title') || '').slice(0, 100),
          artist: String(u.searchParams.get('artist') || '').slice(0, 80) };
        if (!song.songId && !song.title) return send(res, 400, { error: 'Titre manquant.' });
        return send(res, 200, { notice: repeatNotice(song, table.id) });
      }
      if (p === '/api/lyrics') {
        const who = isStaff(req, u) ? 'bar' : tableByAccess(u.searchParams.get('table'), u.searchParams.get('access')).id;
        if (!lyricsAllowed(who)) return send(res, 429, { error: 'Trop de demandes de paroles : réessaie dans une minute.' });
        const title = String(u.searchParams.get('title') || '').trim().slice(0, 100);
        if (!title) return send(res, 400, { error: 'Titre manquant.' });
        const found = await lyrics.find({ songId: Number(u.searchParams.get('songId')) || null, title,
          artist: String(u.searchParams.get('artist') || '').trim().slice(0, 80) });
        return send(res, 200, { lines: found.lines, url: found.url, exact: found.exact, unavailable: !!found.unavailable });
      }
      if (p === '/spotify/callback') {
        // Retour de la connexion Spotify, sur http://127.0.0.1:<port>/spotify/callback dans les deux modes. Mode PC : navigateur de ce PC seulement. Mode serveur : port du bar, atteint par un tunnel SSH ; protégé par le seul state PKCE (usage unique, 10 min).
        if (SERVER) { if (req.socket.localPort === PUBLIC_PORT) return send(res, 403, 'Réservé au bar', 'text/plain; charset=utf-8'); }
        else if (!isLocal(req)) return send(res, 403, 'Connecte Spotify depuis le PC du bar.', 'text/plain; charset=utf-8');
        if (serverUpdate.isBusy()) return send(res, 503, 'Mise à jour en cours. Actualise cette page dans quelques instants pour terminer la connexion Spotify.',
          'text/plain; charset=utf-8', { 'Retry-After': '10' });
        activeMutations++;
        try {
        let message = 'Spotify est connecté. Choisis l’appareil qui joue la musique dans la page du bar.';
        try {
          if (u.searchParams.get('error')) throw new Error('Connexion Spotify annulée.');
          await spotify.finishAuth({ code: u.searchParams.get('code'), state: u.searchParams.get('state') });
          sched.note('Spotify connecté à la file karaoké.', 'staff');
        } catch (error) { message = error.message; }
        // Jamais la clé du bar dans cette page (deux modes). En mode PC, son lien « / »
        // redirige toute requête jugée locale vers /staff?key=<clé> : un relais HTTPS
        // branché sur PORT obtient encore la clé par là, cette page seule ne l'en protège pas.
        const back = SERVER ? '/staff' : '/';
        return send(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Spotify</title><body style="font-family:system-ui;padding:24px"><p>${message.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</p><p><a href="${back}">Revenir à la page du bar</a></p></body>`, 'text/html; charset=utf-8');
        } finally { activeMutations--; }
      }
      if (p === '/api/duo/partners') {
        const table = tableByAccess(u.searchParams.get('table'), u.searchParams.get('access'));
        // Duos déjà prévus avec chaque personne comme invitée : la page prévient
        // que le plafond de passages peut faire attendre un nouveau duo.
        const guestDuos = new Map();
        for (const owner of sched.people.values()) for (const item of sched.songsOf(owner)) {
          if (item.duet?.partnerId) guestDuos.set(item.duet.partnerId, (guestDuos.get(item.duet.partnerId) || 0) + 1);
        }
        // Un soliste est proposé sous son seul prénom : son groupe n'est pas une table.
        return send(res, 200, [...sched.people.values()].filter(person => !person.withdrawnAt && !person.nameRequired)
          .map(person => ({ id: person.id, name: person.name, tableId: person.tableId,
            ...(sched.table(person.tableId, false)?.individual ? { table: '', individual: true } :
              { table: sched.table(person.tableId, false)?.name || person.tableId }),
            sameTable: person.tableId === table.id, guestDuos: guestDuos.get(person.id) || 0 })));
      }
      if (p === '/api/search') {
        const reader = catalogReader(req, u);
        const q = String(u.searchParams.get('q') || '').trim();
        if (q.length < 2) return send(res, 200, []);
        if (!bridge) return send(res, 503, { error: 'KaraFun non connecté' });
        try { return send(res, 200, await readCatalog(reader, `search:${q.toLowerCase()}`, 15000,
          () => bridge.search(q).then(rememberBattleSongs))); }
        catch (e) { if (catalogBusy(res, e)) return; return send(res, 502, { error: `Recherche KaraFun impossible : ${e.message}` }); }
      }
      if (p === '/api/catalog/categories' || p === '/api/catalog/highlights' || p === '/api/catalog/songs') {
        const reader = catalogReader(req, u);
        try {
          const c = catalog();
          if (p.endsWith('/categories')) {
            const type = u.searchParams.get('type');
            const categories = await readCatalog(reader, `categories:${type}`, 120000, () => c.categories(type));
            return send(res, 200, (Array.isArray(categories) ? categories : []).map(cat => ({ ...cat, img: coverUrl(cat?.img) })));
          }
          if (p.endsWith('/highlights')) {
            const type = u.searchParams.get('type');
            return send(res, 200, await readCatalog(reader, `highlights:${type}`, 60000,
              () => c.highlights(type).then(rememberBattleSongs)));
          }
          const filter = u.searchParams.get('filter');
          const offset = Number(u.searchParams.get('offset') || 0);
          const page = await readCatalog(reader, `songs:${filter}:${offset}`, 60000, () => c.songs(filter, offset));
          rememberBattleSongs(page.songs);
          return send(res, 200, page);
        } catch (e) { if (catalogBusy(res, e)) return; return send(res, 502, { error: catalogPhoneError(e) }); }
      }
      m = /^\/photo\/([a-f0-9]+)$/.exec(p);
      if (m) { const pp = sched.people.get(m[1]); if (!pp || !pp.photo) return send(res, 404, ''); return send(res, 200, pp.photo.buf, pp.photo.type, { 'Cache-Control': 'max-age=60' }); }
      if (p === '/qr/staff.svg') {
        if (!isStaff(req, u)) return send(res, 403, 'Réservé au bar', 'text/plain; charset=utf-8');
        // Mode serveur : le QR des gérants vise l'adresse HTTPS de la page du bar.
        const target = `${SERVER ? SERVER.staffUrl : phoneBase()}/staff?key=${STAFF_KEY}`;
        const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return send(res, 200, svg, 'image/svg+xml');
      }
      // QR de l'événement privé, hors de /qr/<table>.svg (une table peut
      // s'appeler « evenement »). Réservé au bar, seulement mode allumé.
      if (p === '/qr-evenement.svg') {
        if (!isStaff(req, u)) return send(res, 403, 'Réservé au bar', 'text/plain; charset=utf-8');
        const { url } = privateEventView();
        if (!url) return send(res, 404, 'QR inconnu', 'text/plain; charset=utf-8');
        const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return send(res, 200, svg, 'image/svg+xml');
      }
      m = /^\/qr\/([^/]+)\.svg$/.exec(p);
      if (m) {
        if (!isStaff(req, u)) return send(res, 403, 'Réservé au bar', 'text/plain; charset=utf-8');
        const id = decodeURIComponent(m[1]);
        if (!sched.table(id, false) || !access.get(id)) return send(res, 404, 'QR inconnu', 'text/plain; charset=utf-8');
        const target = access.url(phoneBase(), id);
        const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return send(res, 200, svg, 'image/svg+xml');
      }
      // Routes GET des téléphones déclarées avec les autres (traductions vérifiées).
      const tableGet = p.startsWith('/api/table/') && handlers[`GET ${p}`];
      if (tableGet) return send(res, 200, await tableGet(req, res, u));
      return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST') {
      if (p === '/internal/shutdown') {
        // Mode serveur : l'arrêt passe par le signal du système, cette route n'existe pas.
        if (SERVER) return send(res, 404, { error: 'Introuvable' });
        if (!isLocal(req) || req.socket.localPort === PUBLIC_PORT || req.headers['x-helper-stop'] !== STOP_KEY) return send(res, 403, { error: 'Arrêt réservé à ce PC.' });
        send(res, 200, { ok: true }); setTimeout(() => stopHelper('stop'), 150); return;
      }
      const key = `POST ${p}`;
      const h = handlers[key];
      if (!h) return send(res, 404, { error: 'Introuvable' });
      if (p.startsWith('/api/staff/') && !isStaff(req, u)) return send(res, 403, { error: 'Réservé au bar' });
      const body = await readBody(req);
      // Contrôle après readBody (qui attend le réseau) : une autre requête
      // peut avoir accepté une mise à jour entre-temps. Les lectures restent disponibles.
      if (p !== '/api/staff/update' && serverUpdate.isBusy()) {
        return send(res, 503, { error: 'Mise à jour en cours. Réessaie dans quelques instants.', code: 'SERVER_UPDATING' },
          undefined, { 'Retry-After': '10' });
      }
      let me = null;
      if (!p.startsWith('/api/staff/') && p !== '/api/join' && !p.startsWith('/api/table/')) {
        me = sched.person(body.token || '');
        if (!me) return send(res, 401, { error: 'Session inconnue : inscris-toi à nouveau.', code: 'NO_SESSION' });
        if (me.withdrawnAt) throw personLeftError();
        requireSoloControl(req, me);
        claimActivity(body, me);
      }
      // Routes qui créent ou rattachent une personne : pas encore de téléphone associé.
      if (p.startsWith('/api/table/') && !['/api/table/person', '/api/table/person/claim',
        '/api/table/solo/open', '/api/table/enter'].includes(p)) {
        const table = tableByAccess(body.table, body.access);
        if (table.individual) {
          const owner = soloDeviceOwner(req);
          if (!owner || owner.id !== String(body.personId || '')) throw soloDeviceError('SOLO_DEVICE_ACCESS');
        }
      }
      let out;
      const mutation = p !== '/api/staff/update';
      if (mutation) activeMutations++;
      try {
      // Toute action peut ajouter ou nommer une personne : un vote Battle
      // ouvert l'accueille aussitôt, même si l'action échoue ensuite.
      try { out = await h(req, res, body, me); }
      finally {
        // Une écriture impossible ne doit ni masquer l'erreur de l'action, ni
        // faire échouer une action réussie : le vote réessaiera.
        try { syncBattleElectorate(); }
        catch (error) { appLog(`Électorat Battle non mis à jour : ${error.message}`); }
      }
      // Seule une action acceptée compte comme activité (une action refusée
      // a levé son erreur avant d'arriver ici).
      creditActivity(body);
      if (p !== '/api/table/person/claim' && !res.nightAlreadySaved) saveNight({ required: true });
      return send(res, 200, out || { ok: true });
      } finally { if (mutation) activeMutations--; }
    }
    send(res, 405, 'Méthode non gérée', 'text/plain');
  } catch (e) {
    // Trop d'inscriptions dans la minute : 429 et le délai avant un essai utile.
    if (e.code === 'PRIVATE_EVENT_BUSY') {
      return send(res, 429, { error: e.message, code: e.code }, undefined, { 'Retry-After': String(Math.max(1, e.retryAfter || 1)) });
    }
    send(res, ['TABLE_ACCESS', 'PERSON_ACCESS', 'PERSON_LEFT', 'SOLO_DEVICE_USED', 'SOLO_DEVICE_ACCESS', 'SOLO_INVITATION', 'SOLO_KEY_REVOKED',
      'PRIVATE_EVENT', 'PRIVATE_EVENT_FULL'].includes(e.code) ? 403 : [409, 503].includes(e.status) ? e.status : 400, { error: e.message, code: e.code || null,
      ...(typeof e.recoverable === 'boolean' ? { recoverable: e.recoverable } : {}) });
  }
});
// Point d'entrée réservé au tunnel HTTPS (mode serveur : au relais HTTPS des
// clients). Lié à la boucle locale (mode serveur : KARAOKE_PUBLIC_BIND) et
// privé de tous les droits du bar, même si le proxy vient de 127.0.0.1.
const publicServer = http.createServer(server.listeners('request')[0]);
// Mode serveur : connexions gardées plus longtemps que le keepalive (50 s) du
// relais HTTPS, pour qu'il ne réutilise jamais une connexion que Node ferme.
if (SERVER) {
  for (const listener of [server, publicServer]) {
    listener.keepAliveTimeout = 65000;
    listener.headersTimeout = 66000;
  }
}

// ------------------------------------------------------------------ démarrage
// Les transitions de la connexion vont au journal du serveur ; le code de
// télécommande n'y paraît que masqué (deux derniers chiffres). Les pages de
// KaraFun lues dans l'heure (sans code ni URL) sont gardées dans data/ pour
// qu'un redémarrage de la file ne remette pas leur compteur à zéro.
// `appMode` : textes du pont (diagnostics, limite de KaraFun) selon le mode.
function karafunBridgeOptions() {
  return { logDir: LOG_DIR, bases: DEMO ? [fake.base] : undefined, log: appLog,
    identityFile: DEMO ? null : path.join(__dirname, 'data', 'karafun-login.json'),
    budgetFile: DEMO ? null : path.join(__dirname, 'data', 'karafun-pages.json'),
    lockOwner: DEMO ? null : { port: PORT }, appMode: SERVER ? 'server' : 'pc' };
}

// Port du bar déjà pris : une autre fenêtre sur le PC, une autre instance sur le serveur.
function portInUseMessage() {
  return SERVER ? `Le port ${PORT} est déjà utilisé : une autre instance de la file tourne peut-être déjà sur ce serveur.` :
    `Le port ${PORT} est déjà utilisé : le programme tourne peut-être déjà dans une autre fenêtre.`;
}

function connectKaraFun(code = CODE) {
  if (!code) { appLog('Pas de code KaraFun : saisis-le sur la page du bar.'); return 'no-code'; }
  if (!bridge) {
    bridge = new KaraFunBridge(karafunBridgeOptions());
    wireBridge(bridge);
  }
  const result = bridge.connect(code);
  // Budget de l'heure épuisé et connexion prête : le pont garde son code
  // (faute de frappe probable). Le code retenu suit toujours le pont.
  CODE = bridge.code || code;
  restoreKaraFunDefaults();
  rememberCode();
  appLog(result === 'kept' ? `KaraFun (code ${maskCode(code)}) : connexion en cours ou prête, gardée.` :
    result?.ok === false ? `KaraFun (code ${maskCode(code)}) : clic sans nouvel essai. ${result.message}` :
    `Connexion à KaraFun (code ${maskCode(code)})...`);
  return result;
}

// Réponse de « Connecter » et « Reconnecter » pour la page du bar. KaraFun
// limite les essais ou budget de l'heure épuisé : { ok: false, message },
// affiché en erreur par la page du bar, sans relire la page de KaraFun.
function connectionAnswer(result) {
  setTimeout(sync, 300);
  if (result?.ok === false) return { ok: false, kept: false, message: result.message };
  return result === 'kept' ?
    { ok: true, kept: true, message: 'KaraFun est déjà connecté ou en train de se connecter : connexion gardée.' } :
    { ok: true, kept: false };
}

// Lignes de démarrage du mode serveur ([] en mode PC) : adresses, fuseau,
// empreinte de la clé du bar, jamais la clé ni un lien qui la porte.
function serverStartupLines(zone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (!SERVER) return [];
  return ['',
    `=== File karaoké ${BUILD.version}${BUILD.commit ? ` (${BUILD.commit})` : ''} ===`,
    'Mode                           : serveur',
    `Adresse des clients (QR)       : ${SERVER.publicUrl}  (port ${PUBLIC_PORT} sur ${SERVER.publicBind})`,
    `Adresse de la page du bar      : ${SERVER.staffUrl}  (port ${PORT} sur ${SERVER.bind})`,
    `Fuseau horaire                 : ${zone}`,
    ...(zone === 'UTC' || zone === 'Etc/UTC' ?
      ['Attention : fuseau horaire UTC. L’heure de fermeture et les heures du journal seront décalées : fixe TZ=Europe/Paris.'] : []),
    `Clé du bar                     : empreinte ${staffKeyFingerprint(STAFF_KEY)} (${STAFF_KEY_INFO.source})`,
    'Lien du bar                    : node server.js --print-staff-url',
    SERVER.clientIpHeader ? `Adresse des téléphones         : en-tête ${SERVER.clientIpHeader} des proxys ${SERVER.trustedProxiesText}` :
      'Adresse des téléphones         : adresse de la connexion (KARAOKE_CLIENT_IP_HEADER non fixée)',
    ''];
}

// Mode serveur : avertissement quand data/tables.json gardait une autre adresse
// pour les QR (ceux déjà imprimés ne mènent pas ici), sinon null. Lu avant que
// ensureSoloGroup() réécrive le fichier avec KARAOKE_PUBLIC_URL : l'écart ne se
// voit alors qu'une fois, même si le démarrage échoue ensuite (logBaseUrlWarning).
// Tant que le fichier n'est pas réécrit (démarrage refusé avant, ou « Comptoir »
// table ordinaire d'une ancienne soirée, que ensureSoloGroup() laisse), il revient.
function printedBaseUrlWarning() {
  if (!SERVER || DEMO) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(TABLE_FILE, 'utf8')); } catch (_) { return null; }
  let old;
  try { old = normalizeBaseUrl(data?.baseUrl); } catch (_) { old = String(data.baseUrl).slice(0, 200); }
  if (old === SERVER.publicUrl) return null;
  if (old === null) {
    return 'Attention : data/tables.json n’indiquait aucune adresse publique (QR du Wi-Fi local). ' +
      `Les QR déjà imprimés ne mènent pas à ce serveur. QR désormais créés pour ${SERVER.publicUrl}.`;
  }
  return `Attention : data/tables.json indiquait ${old} pour les QR. ` +
    `Les QR déjà imprimés avec cette adresse ne mènent pas à ce serveur. QR désormais créés pour ${SERVER.publicUrl}.`;
}
// Avertissement lu par main() et pas encore écrit : après les lignes de
// démarrage, ou juste avant de sortir si le démarrage échoue, car le fichier
// peut déjà être réécrit (l'ancienne adresse ne resterait alors nulle part).
let pendingBaseUrlWarning = null;
function logBaseUrlWarning() {
  if (pendingBaseUrlWarning) appLog(pendingBaseUrlWarning);
  pendingBaseUrlWarning = null;
}

async function main() {
  if (PUBLIC_PORT === PORT || !Number.isInteger(PUBLIC_PORT) || PUBLIC_PORT < 1 || PUBLIC_PORT > 65535) {
    throw new Error('Le port public doit être valide et différent de celui du bar.');
  }
  // Avant la soirée et ensureSoloGroup(), qui réécrit en général data/tables.json.
  pendingBaseUrlWarning = printedBaseUrlWarning();
  const previousNight = nightStore?.load();
  // Même soirée après un redémarrage : son journal continue.
  const resumed = journal.open({ resume: previousNight?.evening || null, rules: journalRules() });
  if (previousNight) {
    const recovered = restoreNight(previousNight, { scheduler: sched, access, settings,
      photoDir: PHOTO_DIR });
    // Mode serveur : l'adresse des QR reste celle de KARAOKE_PUBLIC_URL.
    if (SERVER) settings.baseUrl = SERVER.publicUrl;
    pending = recovered.pending;
    tracked = recovered.tracked;
    soloInvitations.restore(recovered.soloInvitations);
    privateEvent.restore(recovered.privateEvent);
    restoreTransfers(recovered.transfers);
    stageClock = recovered.stageClock;
    recoveredPending = recovered.recoveredPending;
    appLog(`Soirée restaurée : ${sched.tables.size} tables, ${sched.people.size} personnes, ${sched.Q.length} tickets.`);
    for (const warning of recovered.warnings) appLog(`Sauvegarde de soirée réparée : ${warning}.`);
    if (recoveredPending) appLog('Envoi KaraFun interrompu : le bar doit vérifier la file avant de réactiver l’automatique.');
  } else loadTables();
  ensureSoloGroup();
  // Soirée reprise d'une version sans journal : ses inscriptions y sont
  // reportées à leur heure, pour que les présences restent justes.
  if (previousNight && !resumed) {
    for (const p of sched.people.values()) {
      if (p.nameRequired) continue; // QR ouvert, pas encore inscrite
      journal.append('person.joined', { personId: p.id, tableId: p.tableId, restored: true }, p.joinedAt);
      if (p.withdrawnAt) journal.append('person.left', { personId: p.id, by: 'restored' }, p.withdrawnAt);
    }
  }
  journalRoster();
  if (!DEMO && !sched.solverStatus().available) {
    appLog(`Optimiseur de file indisponible au démarrage : ${sched.solverStatus().fallbackLastError || 'cause inconnue'}. Rotation locale de secours.`);
  }
  saveNight({ required: true });
  if (DEMO) {
    const { startFakeKaraFun } = require('./fake-karafun');
    fake = await startFakeKaraFun({ port: PORT + 1001, code: '123456', songSeconds: SONG_SECONDS, log: appLog });
    CODE = fake.code;
    appLog(`Mode démo : faux KaraFun sur ${fake.base} (chansons de ${SONG_SECONDS} s)`);
  }
  server.listen(PORT, SERVER ? SERVER.bind : '0.0.0.0', () => {
    publicServer.listen(PUBLIC_PORT, SERVER ? SERVER.publicBind : '127.0.0.1', () => {
      // Mode PC seulement : ouverte dans le navigateur de ce PC, jamais écrite
      // au journal ; la clé n'y figure que sur la ligne « Clé du bar »
      // (GUIDE-BAR.md) et, depuis ce PC, l'adresse sans clé mène à la page du
      // bar (GET /). Mode serveur : aucune des deux ne sert (GET / répond 403).
      const staffUrl = `http://localhost:${PORT}/staff?key=${STAFF_KEY}`;
      const localUrl = `http://localhost:${PORT}/`;
      // Mode serveur : ni la clé ni un lien qui la porte (empreinte seulement).
      if (SERVER) {
        for (const line of serverStartupLines()) appLog(line);
        logBaseUrlWarning();
      } else {
        appLog('');
        appLog(`=== File karaoké ${BUILD.version}${BUILD.commit ? ` (${BUILD.commit})` : ''} ===`);
        appLog(`Page du bar (sur ce PC)        : ${localUrl}`);
        appLog(`Adresse pour les téléphones    : QR secret à imprimer depuis ${localUrl}`);
        appLog(`QR codes à imprimer            : http://localhost:${PORT}/print`);
        appLog(`Tunnel HTTPS (clients seulement) : http://127.0.0.1:${PUBLIC_PORT}`);
        appLog(`Clé du bar (autre appareil)    : ${STAFF_KEY}  (ex. ${phoneBase()}/staff?key=${STAFF_KEY})`);
      }
      fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
      fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ pid: process.pid, port: PORT, secret: STOP_KEY }));
      if (!SERVER) {
        appLog('Laisse cette fenêtre ouverte pendant la soirée. Ctrl+C pour arrêter.');
        appLog('');
      }
      if (CODE && !serverUpdate.isBusy()) connectKaraFun();
      if (!SERVER && !NO_OPEN && process.platform === 'win32') spawn('cmd', ['/c', 'start', '', staffUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setInterval(() => {
        // La version candidate attend le contrôle de santé de l'agent hôte
        // avant de retrouver la télécommande et ses automatismes.
        if (SERVER && !serverUpdate.isBusy() && CODE && !bridge) connectKaraFun();
        sync();
      }, 2000);
      setInterval(() => { if (!serverUpdate.isBusy()) battleVote.tick(); }, 2000);
      setInterval(() => { if (!serverUpdate.isBusy()) spotifyTick().catch(() => {}); }, 3000);
    });
  });
  server.on('error', (e) => {
    logBaseUrlWarning();
    if (e.code === 'EADDRINUSE') appLog(portInUseMessage());
    else appLog(`Erreur serveur : ${e.message}`);
    process.exit(1);
  });
  publicServer.on('error', (e) => {
    logBaseUrlWarning();
    appLog(`Port public ${PUBLIC_PORT} indisponible : ${e.message}`);
    process.exit(1);
  });
}

main().catch(e => { logBaseUrlWarning(); appLog(`Impossible de démarrer : ${e.message}`); process.exitCode = 1; });
// Arrêt par le système (deux modes) : docker compose stop, Ctrl+C, fenêtre
// fermée. Même routine qu'ARRETER.bat, sortie en 0 ; un second signal est
// absorbé par stopHelper. Hors des bacs à sable `vm` des tests.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stopHelper(signal));

// Mesure de couverture des tests (NODE_V8_COVERAGE, voir test/coverage.js) :
// relevé chaque seconde, pour qu'un serveur arrêté brutalement par un test
// garde ses mesures. Sans effet en soirée.
if (process.env.NODE_V8_COVERAGE) setInterval(() => require('v8').takeCoverage(), 1000).unref();
