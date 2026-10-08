'use strict';
// Réglages d'un titre : tonalité, tempo, voix guide et chœurs.
//
// Ce que la télécommande KaraFun annonce et accepte (KCS, KaraFun du bar) :
// - plages dans remote.ConfigurationUpdateEvent (pitchMin, pitchMax,
//   pitchStep, tempoMin, tempoMax, tempoStep), en demi-tons et en % ; repli
//   -6..6 pas 1 et -50..50 pas 5 tant que KaraFun ne les a pas données ;
// - volumes des pistes vocales de 0 à 100 : 4 = chœurs, 5 = voix guide 1,
//   6 = voix guide 2, et toute autre voix que KaraFun annonce pour le titre
//   (`songTracks`, types 5 à 15). Par défaut, guide coupé et chœurs à 100.
// Sur l'entrée d'un titre (scheduler.js), `settings` vaut null ou
// { pitch?, tempo?, guide?, backing?, guideVoices? } : un champ absent laisse
// KaraFun à sa valeur par défaut. `guide` règle la voix 1 (piste 5) ;
// `guideVoices` = { "<type de piste>": volume } règle chacune des autres voix
// ({ "6": 50 }). Chaque voix est indépendante, en solo comme en duo ; une voix
// sans réglage revient à 0 (guide coupé) au chargement du titre
// (neutralTarget). Tonalité et tempo d'origine (0) ne sont jamais gardés ;
// un volume choisi l'est toujours, car sa valeur par défaut dépend du KaraFun
// (chœurs à 53 sur celui du bar, 100 sur KaraFun Web) : les valeurs par
// défaut réelles sont relevées par le pont (karafun.js) et passées ici en
// `defaults`. Ce module ne fait que des calculs, sans état.

const TRACK = Object.freeze({ BACKING: 4, LEAD_A: 5, LEAD_B: 6 });
const FIELDS = Object.freeze(['pitch', 'tempo', 'guide', 'backing']);
const DEFAULTS = Object.freeze({ pitch: 0, tempo: 0, guide: 0, backing: 100 });
const VOLUMES = new Set(['guide', 'backing']);
// Voix guides : la piste 5 (`guide`) et toute autre piste de voix que KaraFun
// annonce pour le titre, hors chœurs (4). Types plausibles : 5 à 15.
const isGuideVoice = type => Number.isInteger(type) && type >= TRACK.LEAD_A && type <= 15;
// Clé de `guideVoices` (« 6 » à « 15 », la voix 1 étant `guide`) : son type, sinon null.
const voiceKey = key => {
  const type = Number(key);
  return String(type) === String(key) && type !== TRACK.LEAD_A && isGuideVoice(type) ? type : null;
};
const plausibleVolume = n => Number.isInteger(n) && n >= 0 && n <= 100;
// Volume d'une voix guide dans des réglages : `guide` pour la voix 1.
const voiceOf = (settings, type) => (type === TRACK.LEAD_A ? settings?.guide : settings?.guideVoices?.[type]) ?? null;
function setVoice(out, type, volume) {
  if (type === TRACK.LEAD_A) out.guide = volume;
  else (out.guideVoices ||= {})[type] = volume;
}
// Voix guides présentes dans des réglages, dans l'ordre des pistes.
const voicesIn = settings => [...(settings?.guide != null ? [TRACK.LEAD_A] : []),
  ...Object.keys(settings?.guideVoices || {}).map(voiceKey).filter(type => type != null)];
// Voix guides d'un titre, dans l'ordre des pistes ; null si ses pistes sont inconnues.
function guideVoicesOf(tracks) {
  return Array.isArray(tracks) ? [...new Set(tracks.filter(isGuideVoice))].sort((a, b) => a - b) : null;
}
// Valeur à ne pas garder : tonalité ou tempo d'origine.
const unchanged = (field, value) => !VOLUMES.has(field) && value === DEFAULTS[field];
const FALLBACK = Object.freeze({ pitch: Object.freeze({ min: -6, max: 6, step: 1 }),
  tempo: Object.freeze({ min: -50, max: 50, step: 5 }) });
// Les pages proposent Coupé, 25, 50, 75 et 100 ; le serveur accepte 0..100.
const VOLUME_STEP = 25;
// À la reprise d'une sauvegarde, la configuration de KaraFun n'est pas encore
// connue : seules les valeurs impossibles sont retirées. Les autres sont
// bornées à la plage annoncée au moment de l'envoi.
const PLAUSIBLE = Object.freeze({ pitch: [-24, 24], tempo: [-100, 100], guide: [0, 100], backing: [0, 100] });

function settingsError(message) {
  const error = new Error(message);
  error.code = 'SONG_SETTINGS';
  return error;
}

// Plage d'un réglage annoncée par KaraFun, ou son repli si elle est incohérente.
function rangeOf(configuration, name) {
  const min = configuration?.[`${name}Min`], max = configuration?.[`${name}Max`], step = configuration?.[`${name}Step`];
  const valid = [min, max, step].every(Number.isInteger) && step >= 1 && min <= 0 && max >= 0 && min < max;
  return valid ? { min, max, step } : { ...FALLBACK[name] };
}

function rangesFrom(configuration) {
  return { pitch: rangeOf(configuration, 'pitch'), tempo: rangeOf(configuration, 'tempo'),
    volume: { min: 0, max: 100, step: VOLUME_STEP } };
}

const signed = n => (n > 0 ? `+${n}` : String(n));
function rangeMessage(field, ranges) {
  if (field === 'pitch') {
    const { min, max, step } = ranges.pitch;
    return `La tonalité va de ${signed(min)} à ${signed(max)} demi-tons${step > 1 ? `, par pas de ${step}` : ''}.`;
  }
  if (field === 'tempo') {
    const { min, max, step } = ranges.tempo;
    return `Le tempo va de ${signed(min)} % à ${signed(max)} %${step > 1 ? `, par pas de ${step}` : ''}.`;
  }
  return field === 'guide' ? 'La voix guide va de 0 (coupée) à 100.' : 'Les chœurs vont de 0 (coupés) à 100.';
}

// Un réglage reçu d'une page : entier dans la plage (et sur le pas) de
// KaraFun. Vide : la valeur par défaut de KaraFun.
function validateField(field, value, ranges) {
  if (!FIELDS.includes(field)) throw settingsError('Réglage de titre inconnu.');
  if (value === null || value === undefined) return DEFAULTS[field];
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  const range = field === 'pitch' || field === 'tempo' ? ranges[field] : ranges.volume;
  const onStep = field === 'pitch' || field === 'tempo' ? n % range.step === 0 : true;
  if (!Number.isInteger(n) || n < range.min || n > range.max || !onStep) throw settingsError(rangeMessage(field, ranges));
  return n;
}

// Réglages complets reçus d'une page. Un champ vide laisse KaraFun décider ;
// rien de réglé donne null.
function normalizeSettings(input, ranges) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw settingsError('Réglages de titre invalides.');
  const out = {};
  for (const field of FIELDS) {
    if (input[field] === null || input[field] === undefined) continue;
    const value = validateField(field, input[field], ranges);
    if (!unchanged(field, value)) out[field] = value;
  }
  const voices = normalizeVoices(input.guideVoices, ranges);
  if (voices) out.guideVoices = voices;
  return Object.keys(out).length ? out : null;
}

// Autres voix guides reçues d'une page : { "6": 50 }, type plausible (6 à 15 ;
// la voix 1 est `guide`), volume comme la voix guide. Vide : KaraFun décide.
function normalizeVoices(input, ranges) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw settingsError('Réglages de titre invalides.');
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (voiceKey(key) == null) throw settingsError('Voix guide inconnue.');
    if (value !== null && value !== undefined) out[key] = validateField('guide', value, ranges);
  }
  return Object.keys(out).length ? out : null;
}

// Autres voix guides d'une sauvegarde : seules les valeurs possibles restent.
function sanitizeVoices(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, n] of Object.entries(value)) if (voiceKey(key) != null && plausibleVolume(n)) out[key] = n;
  return Object.keys(out).length ? out : null;
}

// Réglages lus dans une sauvegarde : chaque valeur impossible est retirée.
// `keepDefaults` : ce qui a été envoyé à KaraFun garde ses valeurs par défaut ;
// la voix guide B qu'une ancienne version posait pour un duo (`guideB`) y
// devient la voix 2 envoyée (`guideVoices["6"]`).
function sanitizeSettings(value, { keepDefaults = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const field of FIELDS) {
    const n = value[field];
    const [min, max] = PLAUSIBLE[field];
    if (Number.isInteger(n) && n >= min && n <= max && (keepDefaults || !unchanged(field, n))) out[field] = n;
  }
  const voices = sanitizeVoices(value.guideVoices);
  if (keepDefaults && voices?.[TRACK.LEAD_B] == null && plausibleVolume(value.guideB)) setVoice(out, TRACK.LEAD_B, value.guideB);
  if (voices) out.guideVoices = { ...voices, ...out.guideVoices };
  return Object.keys(out).length ? out : null;
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
// Avant l'envoi : ramené dans la plage annoncée et sur son pas.
function clampSettings(settings, ranges) {
  if (!settings) return null;
  const out = {};
  for (const field of FIELDS) {
    const n = settings[field];
    if (!Number.isFinite(n)) continue;
    if (field === 'pitch' || field === 'tempo') {
      const { min, max, step } = ranges[field];
      out[field] = clamp(Math.round(n / step) * step, min, max);
    } else out[field] = clamp(Math.round(n), 0, 100);
  }
  for (const [key, n] of Object.entries(settings.guideVoices || {})) {
    if (voiceKey(key) != null && Number.isFinite(n)) setVoice(out, Number(key), clamp(Math.round(n), 0, 100));
  }
  return out;
}

const trackVolume = (type, volume) => ({ track: { type }, volume });

// Options d'ajout (remote.AddToQueueRequest) : seulement ce qui est réglé.
// Pistes du titre inconnues (premier envoi) : KaraFun ignore celles qui
// manquent. Connues (`tracksAvailable`, relance ⏮ du titre en cours) :
// seulement celles que le titre possède. Chaque voix guide a son volume.
function addOptions({ singer, settings, ranges, tracksAvailable = null }) {
  const s = clampSettings(settings, ranges);
  const options = { singer: String(singer || '') };
  if (!s) return { options, sent: null };
  const has = type => !tracksAvailable || tracksAvailable.includes(type);
  const sent = {}, tracks = [];
  if (s.pitch != null) options.pitch = sent.pitch = s.pitch;
  if (s.tempo != null) options.tempo = sent.tempo = s.tempo;
  if (s.backing != null && has(TRACK.BACKING)) { tracks.push(trackVolume(TRACK.BACKING, s.backing)); sent.backing = s.backing; }
  for (const type of voicesIn(s).filter(has)) {
    tracks.push(trackVolume(type, voiceOf(s, type)));
    setVoice(sent, type, voiceOf(s, type));
  }
  if (tracks.length) options.tracks = tracks;
  return { options, sent: Object.keys(sent).length ? sent : null };
}

const volumeIn = (tracks, type) => {
  const row = (Array.isArray(tracks) ? tracks : []).find(item => Number(item?.track?.type) === type);
  return Number.isFinite(row?.volume) ? Number(row.volume) : null;
};

// Options complètes d'un titre déjà dans la file de KaraFun
// (remote.SetQueueItemOptionsRequest). KaraFun REMPLACE toutes les options :
// le nom affiché (la file reconnaît son titre par lui), le mode Battle et les
// valeurs inchangées sont renvoyés. Un réglage remis par défaut après un
// envoi (`sent`) renvoie la valeur par défaut ; un réglage jamais touché par
// la file garde la valeur actuelle de KaraFun (`current`, options du titre).
// Voix guides : chacune la sienne, pour toutes celles du titre (pistes
// inconnues : celles réglées, envoyées ou déjà dans ses options).
function queueItemOptions({ singer, mod = null, settings, sent = null, current = null, tracksAvailable = null, ranges,
  defaults = DEFAULTS }) {
  const s = clampSettings(settings, ranges) || {};
  const previous = sent || {};
  const now = current || {};
  const pick = (field, kept, get = values => values[field]) => get(s) ?? (get(previous) != null ? defaults[field] : kept);
  const options = { singer: String(singer || '') };
  const out = {};
  options.pitch = out.pitch = pick('pitch', Number.isInteger(now.pitch) ? now.pitch : DEFAULTS.pitch);
  options.tempo = out.tempo = pick('tempo', Number.isInteger(now.tempo) ? now.tempo : DEFAULTS.tempo);
  const has = type => !tracksAvailable || tracksAvailable.includes(type);
  const tracks = [];
  const backing = has(TRACK.BACKING) ? pick('backing', volumeIn(now.tracks, TRACK.BACKING)) : null;
  if (backing != null) { tracks.push(trackVolume(TRACK.BACKING, backing)); out.backing = backing; }
  const listed = (Array.isArray(now.tracks) ? now.tracks : []).map(row => Number(row?.track?.type));
  const voices = guideVoicesOf(tracksAvailable) || guideVoicesOf([TRACK.LEAD_A, ...voicesIn(s), ...voicesIn(previous), ...listed]);
  for (const type of voices) {
    const volume = pick('guide', volumeIn(now.tracks, type), values => voiceOf(values, type));
    if (volume != null) { tracks.push(trackVolume(type, volume)); setVoice(out, type, volume); }
  }
  if (tracks.length) options.tracks = tracks;
  if (mod) options.mod = mod;
  return { options, sent: out };
}

// Pistes vocales d'un titre : [{ type: 4 }, …] (trame KCS) ou [4, …] (normalisé).
function songTracksOf(item) {
  if (!Array.isArray(item?.songTracks)) return null;
  return item.songTracks.map(track => Number(track && typeof track === 'object' ? track.type : track))
    .filter(type => Number.isInteger(type) && type > 0);
}

// État en direct du titre en cours (remote.StatusEvent) : tonalité, tempo,
// volumes (`voices` : chaque voix guide, par type de piste) et pistes
// vocales. Le faux KaraFun nomme le titre songPlaying.
function liveFromStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const volumes = Array.isArray(status.tracks) ? status.tracks : [];
  const current = status.current || status.songPlaying || null;
  const listed = songTracksOf(current);
  const reported = volumes.map(row => Number(row?.track?.type)).filter(Number.isInteger);
  const voices = {};
  for (const type of guideVoicesOf(reported)) if (volumeIn(volumes, type) != null) voices[type] = volumeIn(volumes, type);
  return { queueId: current?.queueId ?? null,
    pitch: Number.isFinite(status.pitch) ? status.pitch : null, tempo: Number.isFinite(status.tempo) ? status.tempo : null,
    guide: volumeIn(volumes, TRACK.LEAD_A), backing: volumeIn(volumes, TRACK.BACKING), voices,
    tracks: listed ?? (reported.length ? reported : null) };
}

// Réglages tirés de l'état en direct (relance d'un titre ajouté dans KaraFun).
function settingsFromLive(live, defaults = DEFAULTS) {
  if (!live) return null;
  const out = {};
  for (const field of FIELDS) if (Number.isInteger(live[field]) && live[field] !== defaults[field]) out[field] = live[field];
  for (const [key, n] of Object.entries(live.voices || {})) {
    if (voiceKey(key) != null && Number.isInteger(n) && n !== defaults.guide) setVoice(out, Number(key), n);
  }
  return Object.keys(out).length ? out : null;
}

// Valeurs neutres d'un titre qui se charge : chaque titre est isolé du
// précédent, quel que soit le KaraFun (certains gardent la tonalité ou les
// volumes d'un titre à l'autre). Tonalité 0, tempo 0, toutes les voix guides
// coupées (une voix absente de `guideVoices` vise aussi 0) ; chœurs remis à
// la vraie valeur par défaut du KaraFun (`backingDefault`, relevée par le
// pont) seulement si le titre précédent les avait changés (`previousBacking`,
// dernier état vu). `options` : options KaraFun d'un titre ajouté
// directement dans KaraFun, qui priment.
function neutralTarget({ backingDefault = null, previousBacking = null, options = null } = {}) {
  const out = { pitch: 0, tempo: 0, guide: 0 };
  if (Number.isInteger(backingDefault) && Number.isFinite(previousBacking) && previousBacking !== backingDefault) out.backing = backingDefault;
  if (options && typeof options === 'object') {
    if (Number.isInteger(options.pitch)) out.pitch = options.pitch;
    if (Number.isInteger(options.tempo)) out.tempo = options.tempo;
    const backing = volumeIn(options.tracks, TRACK.BACKING);
    if (backing != null) out.backing = backing;
    const listed = (Array.isArray(options.tracks) ? options.tracks : []).map(row => Number(row?.track?.type));
    for (const type of guideVoicesOf(listed)) if (volumeIn(options.tracks, type) != null) setVoice(out, type, volumeIn(options.tracks, type));
  }
  return out;
}

// Début d'un titre : commandes du titre en cours pour rattraper ce que
// KaraFun n'a pas appliqué. Les réglages faits (ou déjà envoyés puis remis
// par défaut) comptent d'abord ; un champ que le titre ne règle pas vise la
// valeur `neutral` (voir neutralTarget), marquée `neutral: true`, et
// seulement si KaraFun en donne la valeur actuelle. Seulement ce qui diffère,
// et seulement les pistes que le titre possède. Chaque voix guide est réglée
// pour elle-même, en solo comme en duo.
function catchUpCommands({ settings, sent = null, live, tracksAvailable = null, ranges, defaults = DEFAULTS, neutral = null }) {
  if (!live) return [];
  const s = clampSettings(settings, ranges) || {};
  const previous = sent || {};
  const out = [];
  // Cible d'un champ (`get` lit sa valeur dans des réglages), puis commande si
  // KaraFun en est ailleurs (`now`).
  const reach = (field, get, base, now, command) => {
    const own = get(s) ?? (get(previous) != null ? defaults[field] : null);
    const target = own != null ? { value: own } : neutral && base != null && Number.isFinite(now) ? { value: base, neutral: true } : null;
    if (target && now !== target.value) out.push({ ...command, value: target.value, ...(target.neutral ? { neutral: true } : {}) });
  };
  const plain = field => values => values[field];
  const tracks = tracksAvailable || live.tracks || null;
  reach('pitch', plain('pitch'), neutral?.pitch, live.pitch, { kind: 'pitch' });
  reach('tempo', plain('tempo'), neutral?.tempo, live.tempo, { kind: 'tempo' });
  if (!tracks || tracks.includes(TRACK.BACKING)) reach('backing', plain('backing'), neutral?.backing, live.backing, { kind: 'track', type: TRACK.BACKING });
  // Pistes inconnues : la voix 1, et les voix réglées, envoyées ou annoncées.
  const voices = guideVoicesOf(tracks) || guideVoicesOf([TRACK.LEAD_A, ...voicesIn(s), ...voicesIn(previous),
    ...Object.keys(live.voices || {}).map(Number)]);
  for (const type of voices) {
    const now = type === TRACK.LEAD_A ? live.guide : live.voices?.[type] ?? null;
    reach('guide', values => voiceOf(values, type), neutral ? voiceOf(neutral, type) ?? 0 : null, now, { kind: 'track', type });
  }
  return out;
}

module.exports = { TRACK, FIELDS, DEFAULTS, VOLUME_STEP, rangesFrom, validateField, normalizeSettings, sanitizeSettings,
  clampSettings, addOptions, queueItemOptions, songTracksOf, guideVoicesOf, liveFromStatus, settingsFromLive, neutralTarget,
  catchUpCommands };
