'use strict';
// Réglages d'un titre : tonalité, tempo, voix guide et chœurs.
//
// Ce que la télécommande KaraFun annonce et accepte (KCS, KaraFun du bar) :
// - plages dans remote.ConfigurationUpdateEvent (pitchMin, pitchMax,
//   pitchStep, tempoMin, tempoMax, tempoStep), en demi-tons et en % ; repli
//   -6..6 pas 1 et -50..50 pas 5 tant que KaraFun ne les a pas données ;
// - volumes des pistes vocales de 0 à 100 : 4 = chœurs, 5 = voix guide A,
//   6 = voix guide B (duos). Par défaut, guide coupé et chœurs à 100.
// Sur l'entrée d'un titre (scheduler.js), `settings` vaut null ou
// { pitch?, tempo?, guide?, backing? } : un champ absent laisse KaraFun à sa
// valeur par défaut. Tonalité et tempo d'origine (0) ne sont jamais gardés ;
// un volume choisi l'est toujours, car sa valeur par défaut dépend du KaraFun
// (chœurs à 53 sur celui du bar, 100 sur KaraFun Web) : les valeurs par
// défaut réelles sont relevées par le pont (karafun.js) et passées ici en
// `defaults`. Ce module ne fait que des calculs, sans état.

const TRACK = Object.freeze({ BACKING: 4, LEAD_A: 5, LEAD_B: 6 });
const FIELDS = Object.freeze(['pitch', 'tempo', 'guide', 'backing']);
const DEFAULTS = Object.freeze({ pitch: 0, tempo: 0, guide: 0, backing: 100 });
const VOLUMES = new Set(['guide', 'backing']);
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
  return Object.keys(out).length ? out : null;
}

// Réglages lus dans une sauvegarde : chaque valeur impossible est retirée.
// `keepDefaults` : ce qui a été envoyé à KaraFun garde ses valeurs par défaut.
function sanitizeSettings(value, { keepDefaults = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const field of FIELDS) {
    const n = value[field];
    const [min, max] = PLAUSIBLE[field];
    if (Number.isInteger(n) && n >= min && n <= max && (keepDefaults || !unchanged(field, n))) out[field] = n;
  }
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
  return out;
}

const trackVolume = (type, volume) => ({ track: { type }, volume });

// Options d'ajout (remote.AddToQueueRequest) : seulement ce qui est réglé.
// Les pistes du titre ne sont pas encore connues : KaraFun ignore celles qui
// manquent. Duo : la voix guide B suit la voix guide A.
function addOptions({ singer, settings, ranges, duo = false }) {
  const s = clampSettings(settings, ranges);
  const options = { singer: String(singer || '') };
  if (!s) return { options, sent: null };
  const sent = {}, tracks = [];
  if (s.pitch != null) options.pitch = sent.pitch = s.pitch;
  if (s.tempo != null) options.tempo = sent.tempo = s.tempo;
  if (s.backing != null) { tracks.push(trackVolume(TRACK.BACKING, s.backing)); sent.backing = s.backing; }
  if (s.guide != null) {
    tracks.push(trackVolume(TRACK.LEAD_A, s.guide));
    if (duo) tracks.push(trackVolume(TRACK.LEAD_B, s.guide));
    sent.guide = s.guide;
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
function queueItemOptions({ singer, mod = null, settings, sent = null, current = null, tracksAvailable = null, duo = false, ranges,
  defaults = DEFAULTS }) {
  const s = clampSettings(settings, ranges) || {};
  const previous = sent || {};
  const now = current || {};
  const pick = (field, kept) => s[field] ?? (previous[field] != null ? defaults[field] : kept);
  const options = { singer: String(singer || '') };
  const out = {};
  options.pitch = out.pitch = pick('pitch', Number.isInteger(now.pitch) ? now.pitch : DEFAULTS.pitch);
  options.tempo = out.tempo = pick('tempo', Number.isInteger(now.tempo) ? now.tempo : DEFAULTS.tempo);
  const has = type => !tracksAvailable || tracksAvailable.includes(type);
  const tracks = [];
  const backing = has(TRACK.BACKING) ? pick('backing', volumeIn(now.tracks, TRACK.BACKING)) : null;
  if (backing != null) { tracks.push(trackVolume(TRACK.BACKING, backing)); out.backing = backing; }
  const guide = has(TRACK.LEAD_A) ? pick('guide', volumeIn(now.tracks, TRACK.LEAD_A)) : null;
  if (guide != null) { tracks.push(trackVolume(TRACK.LEAD_A, guide)); out.guide = guide; }
  if (tracksAvailable ? tracksAvailable.includes(TRACK.LEAD_B) : duo) {
    const second = duo ? pick('guide', volumeIn(now.tracks, TRACK.LEAD_B)) : volumeIn(now.tracks, TRACK.LEAD_B);
    if (second != null) tracks.push(trackVolume(TRACK.LEAD_B, second));
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
// volumes et pistes vocales. Le faux KaraFun nomme le titre songPlaying.
function liveFromStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const volumes = Array.isArray(status.tracks) ? status.tracks : [];
  const current = status.current || status.songPlaying || null;
  const listed = songTracksOf(current);
  const reported = volumes.map(row => Number(row?.track?.type)).filter(Number.isInteger);
  return { queueId: current?.queueId ?? null,
    pitch: Number.isFinite(status.pitch) ? status.pitch : null, tempo: Number.isFinite(status.tempo) ? status.tempo : null,
    guide: volumeIn(volumes, TRACK.LEAD_A), guideB: volumeIn(volumes, TRACK.LEAD_B), backing: volumeIn(volumes, TRACK.BACKING),
    tracks: listed ?? (reported.length ? reported : null) };
}

// Réglages tirés de l'état en direct (relance d'un titre ajouté dans KaraFun).
function settingsFromLive(live, defaults = DEFAULTS) {
  if (!live) return null;
  const out = {};
  for (const field of FIELDS) if (Number.isInteger(live[field]) && live[field] !== defaults[field]) out[field] = live[field];
  return Object.keys(out).length ? out : null;
}

// Début d'un titre suivi : commandes du titre en cours pour rattraper ce que
// KaraFun n'a pas appliqué. Seuls les réglages faits (ou déjà envoyés puis
// remis par défaut) comptent, et seulement les pistes que le titre possède.
function catchUpCommands({ settings, sent = null, live, tracksAvailable = null, duo = false, ranges, defaults = DEFAULTS }) {
  if (!live) return [];
  const s = clampSettings(settings, ranges) || {};
  const previous = sent || {};
  const want = field => s[field] ?? (previous[field] != null ? defaults[field] : null);
  const tracks = tracksAvailable || live.tracks || null;
  const has = type => !tracks || tracks.includes(type);
  const out = [];
  const pitch = want('pitch'), tempo = want('tempo'), backing = want('backing'), guide = want('guide');
  if (pitch != null && live.pitch !== pitch) out.push({ kind: 'pitch', value: pitch });
  if (tempo != null && live.tempo !== tempo) out.push({ kind: 'tempo', value: tempo });
  if (backing != null && has(TRACK.BACKING) && live.backing !== backing) out.push({ kind: 'track', type: TRACK.BACKING, value: backing });
  if (guide != null && has(TRACK.LEAD_A) && live.guide !== guide) out.push({ kind: 'track', type: TRACK.LEAD_A, value: guide });
  if (guide != null && duo && has(TRACK.LEAD_B) && live.guideB !== guide) out.push({ kind: 'track', type: TRACK.LEAD_B, value: guide });
  return out;
}

module.exports = { TRACK, FIELDS, DEFAULTS, VOLUME_STEP, rangesFrom, validateField, normalizeSettings, sanitizeSettings,
  clampSettings, addOptions, queueItemOptions, songTracksOf, liveFromStatus, settingsFromLive, catchUpCommands };
