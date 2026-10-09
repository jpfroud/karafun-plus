'use strict';

// Sauvegarde de la soirée sur deux emplacements indépendants. Un crash pendant
// une écriture laisse au moins la génération précédente lisible.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Scheduler, DEFER_MAX } = require('./scheduler');
const { TableAccess } = require('./table-access');
const { SoloInvitations } = require('./solo-invitations');
const { PrivateEvent } = require('./private-event');
const { PLAYED_LIMIT } = require('./song-repeats');
const { sanitizeSettings } = require('./song-settings');
const { sanitizeClock, clientDuration } = require('./stage-progress');

const FORMAT = 1;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reason => { throw new Error(`Sauvegarde de soirée invalide : ${reason}`); };
const list = (value, field) => Array.isArray(value) ? value : fail(field);
const object = (value, field) => value && typeof value === 'object' && !Array.isArray(value) ? value : fail(field);
const unique = (values, field) => {
  if (new Set(values).size !== values.length) fail(`${field} contient des doublons`);
};
const songValid = song => song === null || (
  song && typeof song === 'object' && !Array.isArray(song) &&
  typeof song.entryId === 'string' && song.entryId.length > 0 &&
  Number.isSafeInteger(song.songId) && song.songId > 0 &&
  typeof song.title === 'string' && song.title.length > 0
);
// Réglages de titre abîmés (tonalité, tempo, voix) : seule la valeur fautive
// disparaît, jamais le titre ni la soirée.
function cleanSongSettings(song) {
  if (!song || typeof song !== 'object' || !('settings' in song)) return;
  const settings = sanitizeSettings(song.settings);
  if (settings) song.settings = settings;
  else delete song.settings;
}
// Sauvegarde d'avant les voix guides réglées une à une (`guideVoicesSaved`
// absent) : dans un duo, la voix 2 suivait la voix 1. Elle reçoit donc le
// même réglage (`guideVoices["6"]`), pour rien perdre.
function legacyDuoVoice(song, duo) {
  const settings = song?.settings;
  if (!duo || !settings || settings.guide == null || settings.guideVoices?.['6'] != null) return;
  song.settings = { ...settings, guideVoices: { ...settings.guideVoices, 6: settings.guide } };
}
// Titre envoyé à KaraFun : réglages transmis et rattrapage déjà fait. Duo
// d'une ancienne sauvegarde : un duo, ou un duo devenu solo dont la file
// avait posé la voix guide B (`sentSettings.guideB`).
function cleanSentSettings(holder, legacy) {
  cleanSongSettings(holder.sel?.song);
  if (legacy) legacyDuoVoice(holder.sel?.song, holder.sel?.ids?.length > 1 || holder.sentSettings?.guideB != null);
  if ('sentSettings' in holder) holder.sentSettings = sanitizeSettings(holder.sentSettings, { keepDefaults: true });
  if (holder.liveChecked != null && typeof holder.liveChecked !== 'string') delete holder.liveChecked;
  delete holder.statusAtOptions; // numéro d'état de KaraFun propre à l'exécution précédente
  for (const flag of ['settingsDirty', 'settingsChanged']) if (flag in holder && typeof holder[flag] !== 'boolean') delete holder[flag];
}
// Titres gardés dans la sauvegarde (listes, invitations, envois à KaraFun).
function savedSongs(snapshot) {
  const songs = [];
  for (const p of Array.isArray(snapshot.scheduler?.people) ? snapshot.scheduler.people : []) {
    songs.push(p?.song, p?.invite?.song);
    if (Array.isArray(p?.backlog)) for (const song of p.backlog) songs.push(song);
  }
  for (const tr of Array.isArray(snapshot.tracked) ? snapshot.tracked : []) songs.push(tr?.sel?.song);
  songs.push(snapshot.pending?.sel?.song);
  return songs.filter(song => song && typeof song === 'object');
}
function dropCovers(snapshot) {
  for (const song of savedSongs(snapshot)) if ('img' in song) song.img = null;
}
// Durée envoyée par un téléphone : bornée comme à l'arrivée (une sauvegarde
// d'avant la borne a pu la garder telle quelle).
function boundDurations(snapshot) {
  for (const song of savedSongs(snapshot)) if ('duration' in song) song.duration = clientDuration(Number(song.duration));
}

// `remaining` peut compter un envoi déjà en route en plus du report.
const validDeferral = d => !!(d && typeof d === 'object' && typeof d.entryId === 'string' &&
  Number.isInteger(d.remaining) && d.remaining >= 0 && d.remaining <= DEFER_MAX + 1 &&
  Number.isInteger(d.total) && d.total >= 1 && d.total <= DEFER_MAX && Number.isFinite(d.until) &&
  Array.isArray(d.ids) && d.ids.length >= 1 && d.ids.every(id => typeof id === 'string'));
const selectionValid = sel => sel && typeof sel === 'object' &&
  Array.isArray(sel.ids) && sel.ids.length > 0 &&
  sel.ids.every(x => typeof x === 'string') && songValid(sel.song) &&
  sel.song !== null && typeof sel.label === 'string';

function savePhoto(photo, directory) {
  const checksum = crypto.createHash('sha256').update(photo.buf).digest('hex');
  const filename = `${checksum}.bin`;
  const target = path.join(directory, filename);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(target)) {
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx');
      fs.writeFileSync(fd, photo.buf);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = null;
      fs.renameSync(temporary, target);
    } catch (error) {
      if (fd !== undefined && fd !== null) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (_) { /* écriture déjà interrompue */ }
      throw error;
    }
  }
  return { type: photo.type, file: filename };
}

function snapshotNight({ scheduler, access, settings, pending = null, tracked = [], photoDir = null,
  soloInvitations = null, privateEvent = null, transfers = [], evening = null, stageClock = null }) {
  if (!scheduler || !access || !settings) throw new Error('État de soirée incomplet.');
  const tables = [...scheduler.tables.values()].map(t => ({ ...clone(t), secret: access.get(t.id) }));
  if (tables.some(t => !t.secret)) throw new Error('Secret QR manquant dans une table.');
  const people = [...scheduler.people.values()].map(p => {
    const { duet, duetOf, invite, photo, ...persistent } = p; // vues dérivées des chansons
    const person = clone(persistent);
    // Buffer#toJSON écrit chaque octet comme un nombre, ce qui gonfle beaucoup
    // les sauvegardes. Le navigateur attend un vrai Buffer après restauration.
    person.photo = photo ? photoDir ? savePhoto(photo, photoDir) :
      { type: photo.type, base64: photo.buf.toString('base64') } : null;
    return person;
  });
  return {
    version: FORMAT,
    // Vignettes certifiées par le catalogue (voir withCover dans server.js).
    coversCertified: true,
    // Voix guides réglées une à une (song-settings.js, `guideVoices`).
    guideVoicesSaved: true,
    scheduler: {
      opts: clone(scheduler.opts), tables, people,
      Q: [...scheduler.Q], lastGroup: clone(scheduler.lastGroup),
      reservedNext: scheduler.reservedNext ? clone(scheduler.reservedNext) : null,
      roundGroups: [...scheduler.roundGroups], roundPeople: [...scheduler.roundPeople],
      roundPeoplePhysical: true,
      appearanceSerial: scheduler.appearanceSerial,
      manualOrder: [...scheduler.manualOrder],
      manualOrderActive: !!scheduler.manualOrderActive,
      manualChanges: clone(scheduler.manualChanges),
      tableServeCounts: [...scheduler.tableServeCounts],
      duetCooldowns: [...scheduler.duetCooldowns],
      recentGroups: clone(scheduler.recentGroups || []), roundUse: [...(scheduler.roundUse || new Map())],
      roundApps: [...(scheduler.roundApps || new Map())],
      roundOwed: [...(scheduler.roundOwed || new Set())],
      stageHistory: clone(scheduler.stageHistory || []),
      playedSongs: clone(scheduler.playedSongs || []),
      log: clone(scheduler.log), slotSamples: [...scheduler.slotSamples],
      version: scheduler.version,
    },
    settings: clone(settings),
    soloInvitations: soloInvitations ? soloInvitations.serialize() : [],
    // Événement privé (QR unique) : secret en clair comme ceux des tables.
    privateEvent: privateEvent ? privateEvent.serialize() : null,
    // Transferts en cours : empreintes seulement, jamais le lien ni le code.
    transfers: clone(transfers),
    pending: pending ? { ...clone(pending), before: [...pending.before] } : null,
    tracked: clone(tracked),
    // Soirée du journal (data/soirees/<id>) : reprise après un redémarrage.
    evening: evening ? { id: String(evening.id), startedAt: Number(evening.startedAt) || null } : null,
    // Barre de lecture du titre sur scène (stage-progress.js), facultative.
    stageClock: stageClock ? clone(stageClock) : null,
  };
}

// La validation est faite dans un Scheduler temporaire : une sauvegarde abîmée
// ne doit jamais remplacer une soirée active par un état partiellement chargé.
function restoreNight(snapshot, { scheduler, access, settings, photoDir = null }) {
  object(snapshot, 'racine');
  if (snapshot.version !== FORMAT) fail('version inconnue');
  // Sauvegarde antérieure à la certification des vignettes : une image a pu
  // être choisie par un téléphone. Elle n'est pas reprise.
  if (snapshot.coversCertified !== true) dropCovers(snapshot);
  boundDurations(snapshot);
  const legacyVoices = snapshot.guideVoicesSaved !== true;
  const data = object(snapshot.scheduler, 'ordonnanceur');
  const restoredSoloInvitations = new SoloInvitations(snapshot.soloInvitations ?? []);
  object(data.opts, 'règles');
  const tmp = new Scheduler(data.opts);
  const tmpAccess = new TableAccess();
  for (const row of list(data.tables, 'tables')) {
    object(row, 'table');
    const key = TableAccess.key(row.id);
    if (tmp.tables.has(key)) fail('table répétée');
    if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 40 ||
      (row.headcount !== null && (!Number.isInteger(row.headcount) || row.headcount < 1 || row.headcount > 40))) fail('table mal formée');
    tmpAccess.restore(key, row.secret);
    tmp.tables.set(key, { id: key, name: row.name, headcount: row.headcount,
      individual: !!row.individual, createdAt: Number(row.createdAt) || Date.now() });
  }
  for (const p of list(data.people, 'personnes')) {
    object(p, 'personne');
    if (typeof p.id !== 'string' || !/^[a-f0-9]{12}$/.test(p.id) ||
      typeof p.token !== 'string' || !/^[a-f0-9]{32}$/.test(p.token) ||
      typeof p.name !== 'string' || !p.name.trim() || !tmp.tables.has(p.tableId) ||
      tmp.people.has(p.id) || tmp.byToken.has(p.token) ||
      !songValid(p.song) || !Array.isArray(p.backlog) || !p.backlog.every(songValid)) fail('personne mal formée');
    if (p.lastAppearanceTurn != null &&
        (!Number.isSafeInteger(p.lastAppearanceTurn) || p.lastAppearanceTurn < 0)) {
      fail('passage physique mal formé');
    }
    const person = clone(p);
    delete person.verifiedAt; // ancienne vérification des repères, retirée : le repère seul reste
    cleanSongSettings(person.song);
    person.backlog.forEach(cleanSongSettings);
    if (legacyVoices) for (const song of [person.song, ...person.backlog]) legacyDuoVoice(song, !!song?.duet);
    // Report « Pas prêt » abîmé : la personne garde simplement sa place.
    if (person.deferral != null && !validDeferral(person.deferral)) person.deferral = null;
    // Champs facultatifs de l'accès solo et de l'activité : abîmés, ils sont
    // ignorés (prénom libre, pas de clé personnelle, activité inconnue).
    if (person.nameRequired !== undefined && person.nameRequired !== true) delete person.nameRequired;
    if (person.viaEvent !== undefined && person.viaEvent !== true) delete person.viaEvent;
    if (person.soloKeyHash !== undefined &&
        (typeof person.soloKeyHash !== 'string' || !/^[a-f0-9]{64}$/.test(person.soloKeyHash))) delete person.soloKeyHash;
    if (person.lastActionAt !== undefined && !Number.isFinite(person.lastActionAt)) delete person.lastActionAt;
    if (p.photo != null) {
      const photo = object(p.photo, 'photo');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo.type)) fail('photo mal formée');
      if (typeof photo.file === 'string') {
        if (!photoDir || !/^[a-f0-9]{64}\.bin$/.test(photo.file)) fail('référence photo mal formée');
        try {
          const file = path.join(photoDir, photo.file);
          if (fs.statSync(file).size > 400 * 1024) throw new Error('photo trop grande');
          const buf = fs.readFileSync(file);
          if (crypto.createHash('sha256').update(buf).digest('hex') !== photo.file.slice(0, 64)) {
            throw new Error('empreinte photo incorrecte');
          }
          person.photo = { type: photo.type, buf };
        } catch (_) { person.photo = null; /* conserver la file même si une photo est abîmée */ }
      } else {
        if (typeof photo.base64 !== 'string' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(photo.base64)) {
          fail('photo mal formée');
        }
        const buf = Buffer.from(photo.base64, 'base64');
        if (buf.length > 400 * 1024) fail('photo trop volumineuse');
        person.photo = { type: photo.type, buf };
      }
    }
    tmp.people.set(person.id, person);
    tmp.byToken.set(person.token, person.id);
  }
  const queue = list(data.Q, 'file');
  unique(queue, 'La file');
  if (queue.some(pid => !tmp.people.has(pid))) fail('ticket orphelin');
  tmp.Q = [...queue];
  tmp.lastGroup = data.lastGroup == null ? null : clone(data.lastGroup);
  if (data.reservedNext != null) {
    const reserved = object(data.reservedNext, 'prochain passage garanti');
    if (typeof reserved.personId !== 'string' || !tmp.people.has(reserved.personId) ||
      !Number.isFinite(reserved.reservedAt)) fail('prochain passage garanti mal formé');
    tmp.reservedNext = { personId: reserved.personId, reservedAt: reserved.reservedAt, ...(reserved.byStaff === true ? { byStaff: true } : {}) };
  }
  tmp.roundGroups = new Set(list(data.roundGroups, 'tables du tour'));
  tmp.roundPeople = new Set(list(data.roundPeople, 'personnes du tour'));
  tmp.appearanceSerial = data.appearanceSerial == null ?
    Math.max(0, ...[...tmp.people.values()].map(p => p.lastAppearanceTurn || 0)) :
    data.appearanceSerial;
  if (!Number.isSafeInteger(tmp.appearanceSerial) || tmp.appearanceSerial < 0 ||
      [...tmp.people.values()].some(p => (p.lastAppearanceTurn || 0) > tmp.appearanceSerial)) {
    fail('compteur des passages physiques mal formé');
  }
  if ([...tmp.roundPeople].some(pid => !tmp.people.has(pid))) fail('personne du tour inconnue');
  if (data.roundPeoplePhysical != null && typeof data.roundPeoplePhysical !== 'boolean') {
    fail('version du tour physique mal formée');
  }
  tmp.manualOrder = [...list(data.manualOrder, 'ordre manuel')];
  if (tmp.manualOrder.some(pid => !tmp.people.has(pid))) fail('ordre manuel orphelin');
  if (data.manualOrderActive != null && typeof data.manualOrderActive !== 'boolean') fail('ordre manuel actif mal formé');
  tmp.manualOrderActive = !!data.manualOrderActive && tmp.manualOrder.length > 0;
  tmp.manualChanges = clone(list(data.manualChanges ?? [], 'changements manuels'));
  unique(tmp.manualChanges.map(change => change?.id), 'Les changements manuels');
  for (const change of tmp.manualChanges) {
    object(change, 'changement manuel');
    const before = object(change.before, 'état précédent du changement manuel');
    // Reports « Pas prêt » levés par un déplacement : abîmés, l'annulation
    // garde l'ordre sans les rendre.
    if ('deferrals' in before && !(Array.isArray(before.deferrals) && before.deferrals.every(row =>
      Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && validDeferral(row[1])))) delete before.deferrals;
    if (typeof change.id !== 'string' || !/^[a-f0-9]{12}$/.test(change.id) ||
      !['priority', 'move'].includes(change.kind) ||
      typeof change.personId !== 'string' || !tmp.people.has(change.personId) ||
      typeof change.name !== 'string' || !change.name ||
      !Number.isInteger(change.from) || change.from < 1 ||
      !Number.isInteger(change.to) || change.to < 1 ||
      !Number.isFinite(change.at) ||
      typeof change.after !== 'string' || !/^[a-f0-9]{64}$/.test(change.after) ||
      typeof change.native !== 'string' || !/^[a-f0-9]{64}$/.test(change.native) ||
      !Array.isArray(before.manualOrder) || before.manualOrder.some(pid => !tmp.people.has(pid)) ||
      typeof before.manualOrderActive !== 'boolean' ||
      (before.reservedNext !== null &&
        (!before.reservedNext || typeof before.reservedNext.personId !== 'string' ||
          !tmp.people.has(before.reservedNext.personId) ||
          !Number.isFinite(before.reservedNext.reservedAt)))) {
      fail('changement manuel mal formé');
    }
  }
  tmp.tableServeCounts = new Map(list(data.tableServeCounts, 'compteurs des tables'));
  tmp.duetCooldowns = new Map(list(data.duetCooldowns, 'répit des duos'));
  // Champs ajoutés après la v0.1.1 : absents des anciennes sauvegardes.
  tmp.recentGroups = list(data.recentGroups ?? [], 'historique des tables')
    .filter(groups => Array.isArray(groups) && groups.every(g => typeof g === 'string')).slice(-120);
  tmp.roundUse = new Map(list(data.roundUse ?? [], 'crédits de tour').filter(row =>
    Array.isArray(row) && tmp.people.has(row[0]) && Number.isFinite(row[1]) && row[1] >= 0 && row[1] <= 10));
  tmp.roundApps = new Map(list(data.roundApps ?? [], 'passages du tour').filter(row =>
    Array.isArray(row) && tmp.people.has(row[0]) && Number.isInteger(row[1]) && row[1] >= 1 && row[1] <= 20));
  tmp.roundOwed = new Set(list(data.roundOwed ?? [], 'passages dus du tour').filter(pid => tmp.people.has(pid)));
  tmp.stageHistory = clone(list(data.stageHistory ?? [], 'historique de scène')).filter(item =>
    item && typeof item === 'object' && Array.isArray(item.ids) && Number.isFinite(item.at)).slice(-60);
  tmp.playedSongs = clone(list(data.playedSongs ?? [], 'titres chantés')).filter(item =>
    item && typeof item === 'object' && Number.isFinite(item.at) &&
    typeof item.title === 'string' && item.title.length > 0).slice(-PLAYED_LIMIT);
  for (const t of list(data.tables, 'tables')) {
    if (t.bonus != null) {
      if (!Number.isInteger(t.bonus) || t.bonus < -3 || t.bonus > 3) fail('bonus de table mal formé');
      tmp.tables.get(TableAccess.key(t.id)).bonus = t.bonus;
    }
  }
  for (const p of tmp.people.values()) {
    if (p.bonus != null && (!Number.isInteger(p.bonus) || p.bonus < -3 || p.bonus > 3)) fail('bonus de personne mal formé');
  }
  tmp.log = clone(list(data.log, 'journal')).slice(-300);
  tmp.slotSamples = [...list(data.slotSamples, 'durées mesurées')].slice(-20);
  tmp.version = Number.isSafeInteger(data.version) ? data.version : 0;
  tmp._refreshDuetViews();

  const restoredSettings = clone(object(snapshot.settings, 'réglages'));
  if (typeof restoredSettings.auto !== 'boolean' || typeof restoredSettings.autoPlay !== 'boolean' ||
    !Number.isInteger(restoredSettings.pushDelaySec) || restoredSettings.pushDelaySec < 0 || restoredSettings.pushDelaySec > 180 ||
    !Number.isInteger(restoredSettings.playDelaySec) || restoredSettings.playDelaySec < 0 || restoredSettings.playDelaySec > 30 ||
    ('repeatWarnMin' in restoredSettings && (!Number.isInteger(restoredSettings.repeatWarnMin) ||
      restoredSettings.repeatWarnMin < 0 || restoredSettings.repeatWarnMin > 240)) ||
    ('presenceGraceSec' in restoredSettings && (!Number.isInteger(restoredSettings.presenceGraceSec) ||
      restoredSettings.presenceGraceSec < 10 || restoredSettings.presenceGraceSec > 300)) ||
    ('presenceMaxSkips' in restoredSettings && (!Number.isInteger(restoredSettings.presenceMaxSkips) ||
      restoredSettings.presenceMaxSkips < 1 || restoredSettings.presenceMaxSkips > 10)) ||
    (restoredSettings.closingAt != null && !Number.isFinite(restoredSettings.closingAt)) ||
    ('autoPlayHeld' in restoredSettings && typeof restoredSettings.autoPlayHeld !== 'boolean')) fail('réglages mal formés');

  // Interrupteur des réglages de titre (v1.4) abîmé : la valeur actuelle reste.
  if ('singerSongSettings' in restoredSettings && typeof restoredSettings.singerSongSettings !== 'boolean') {
    delete restoredSettings.singerSongSettings;
  }
  // Durée maximale des titres (lot J) : une valeur invalide coupe la limite.
  if ('maxSongSec' in restoredSettings && !(Number.isInteger(restoredSettings.maxSongSec) &&
    restoredSettings.maxSongSec >= 120 && restoredSettings.maxSongSec <= 900)) restoredSettings.maxSongSec = null;

  const pending = snapshot.pending === null ? null : object(snapshot.pending, 'envoi en cours');
  if (pending && (!selectionValid(pending.sel) || !Array.isArray(pending.before) ||
    !Number.isFinite(pending.at) || !Number.isInteger(pending.attempts) || pending.attempts < 1)) fail('envoi en cours mal formé');
  const tracked = list(snapshot.tracked, 'titres KaraFun');
  if (tracked.some(tr => !tr || tr.queueId == null || !selectionValid(tr.sel))) fail('titre KaraFun mal formé');
  if (!data.roundPeoplePhysical) {
    // Dans les anciens instantanés, le tour mémorisait les propriétaires mais
    // pas les invités. Conserver les premiers et ajouter les invités connus
    // des titres KaraFun en cours ou à venir évite de réinitialiser toute la
    // rotation au redémarrage. Les duos anciens déjà sortis de KaraFun ne
    // sont plus reconstructibles avec certitude.
    for (const selection of [...tracked.map(item => item.sel), pending?.sel].filter(Boolean)) {
      for (const pid of selection.ids) if (tmp.people.has(pid)) tmp.roundPeople.add(pid);
    }
  }
  // Un lien de transfert déjà envoyé (WhatsApp, SMS…) reste valable après un
  // redémarrage. Les lignes expirées ou mal formées sont simplement ignorées.
  const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  const restoredTransfers = clone(list(snapshot.transfers ?? [], 'transferts')).filter(row =>
    row && typeof row === 'object' && tmp.people.has(row.personId) && hex(row.hash) &&
    (row.linkHash === null || hex(row.linkHash)) && Number.isFinite(row.expiresAt) &&
    Number.isFinite(row.linkExpiresAt) && Number.isInteger(row.attempts) && row.attempts >= 0 &&
    row.attempts <= 5 && Math.max(row.expiresAt, row.linkExpiresAt) > Date.now());
  const restoredPending = pending ? { ...clone(pending), before: new Set(pending.before) } : null;
  // Champ ajouté en v1.4 : une soirée sans identifiant valable repart d'un nouveau journal.
  const evening = snapshot.evening && typeof snapshot.evening === 'object' &&
    /^\d{4}-\d{2}-\d{2}_\d{4}_[0-9a-f]{4}$/.test(String(snapshot.evening.id)) ?
    { id: snapshot.evening.id, startedAt: Number.isFinite(snapshot.evening.startedAt) ? snapshot.evening.startedAt : null } : null;
  const restoredTracked = clone(tracked);
  for (const holder of [...restoredTracked, restoredPending].filter(Boolean)) cleanSentSettings(holder, legacyVoices);

  // Aucun effet sur les objets fournis avant ce point.
  for (const id of scheduler.tables.keys()) access.revoke(id);
  scheduler.opts = tmp.opts;
  for (const field of ['tables', 'people', 'byToken', 'Q', 'lastGroup', 'reservedNext', 'roundGroups',
    'roundPeople', 'appearanceSerial', 'manualOrder', 'manualOrderActive', 'manualChanges', 'tableServeCounts', 'duetCooldowns', 'log',
    'slotSamples', 'version', 'recentGroups', 'roundUse', 'roundApps', 'roundOwed', 'stageHistory', 'playedSongs']) scheduler[field] = tmp[field];
  scheduler.solverPlan = null;
  for (const t of tmp.tables.values()) access.restore(t.id, tmpAccess.get(t.id));
  Object.assign(settings, restoredSettings);
  // Un AddToQueueRequest sans confirmation est ambigu après un crash. Le bar
  // garde les titres et doit regarder la file KaraFun avant de réarmer l'envoi.
  if (restoredPending) settings.auto = false;
  return { pending: restoredPending, tracked: restoredTracked,
    recoveredPending: !!restoredPending, soloInvitations: restoredSoloInvitations.serialize(),
    transfers: restoredTransfers, evening, stageClock: sanitizeClock(snapshot.stageClock),
    // Champ ajouté avec l'événement privé : absent ou abîmé = mode coupé.
    privateEvent: PrivateEvent.normalize(snapshot.privateEvent) };
}

// À utiliser uniquement après le premier instantané QueueEvent frais de
// KaraFun. Ne réémet jamais une commande : le résultat est une aide au
// rapprochement, et un cas absent/ambigu reste sous contrôle du bar.
function inspectRecoveredPending(pending, queue) {
  if (!pending) return { state: 'none', matches: [] };
  if (!Array.isArray(queue)) throw new Error('File KaraFun indisponible.');
  const before = pending.before instanceof Set ? pending.before : new Set(pending.before || []);
  const matches = queue.filter(item => !before.has(item.queueId) &&
    Number(item.songId) === Number(pending.sel.song.songId) &&
    item.singer === pending.sel.label);
  return { state: matches.length === 1 ? 'found' : matches.length ? 'ambiguous' : 'unconfirmed', matches };
}

class NightStateStore {
  constructor(prefix) {
    if (typeof prefix !== 'string' || !prefix) throw new Error('Chemin de sauvegarde manquant.');
    this.prefix = prefix;
    this.sequence = 0;
    this.lastDigest = null;
  }

  slot(seq) { return `${this.prefix}-${seq % 2 ? 'b' : 'a'}.json`; }

  load() {
    const paths = [this.slot(0), this.slot(1)];
    const found = paths.filter(p => fs.existsSync(p));
    if (!found.length) return null;
    const valid = [];
    for (const file of found) {
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
        const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (envelope.version !== FORMAT || !Number.isSafeInteger(envelope.sequence) ||
          envelope.sequence < 1 || typeof envelope.checksum !== 'string' ||
          digest(envelope.payload) !== envelope.checksum) continue;
        valid.push(envelope);
      } catch (_) { /* l'autre génération peut être intacte */ }
    }
    if (!valid.length) fail('les deux générations sont illisibles');
    valid.sort((a, b) => b.sequence - a.sequence);
    this.sequence = valid[0].sequence;
    this.lastDigest = valid[0].checksum;
    return clone(valid[0].payload);
  }

  save(snapshot, { force = false } = {}) {
    const payload = clone(snapshot);
    const checksum = digest(payload);
    if (!force && checksum === this.lastDigest) return false;
    const sequence = this.sequence + 1;
    const target = this.slot(sequence);
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const bytes = Buffer.from(JSON.stringify({ version: FORMAT, sequence,
      savedAt: Date.now(), checksum, payload }), 'utf8');
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Sauvegarde de soirée trop volumineuse.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx');
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = null;
      fs.renameSync(temporary, target);
    } catch (e) {
      if (fd !== undefined && fd !== null) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (_) { /* écriture interrompue */ }
      throw e;
    }
    this.sequence = sequence;
    this.lastDigest = checksum;
    return true;
  }
}

module.exports = { NightStateStore, snapshotNight, restoreNight, inspectRecoveredPending };
