'use strict';
// Réglages de titre (tonalité, tempo, voix guide, chœurs) : règles pures de
// song-settings.js, sauvegarde et reprise de la soirée (night-state.js), et
// faux KaraFun de la démo (fake-karafun.js). Les formes de trames viennent du
// journal du vrai KaraFun du bar (2 octobre) : aucun accès au vrai KaraFun.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const net = require('node:net');
const io = require('socket.io-client');

const settingsModule = require('../song-settings');
const { TRACK, DEFAULTS, VOLUME_STEP, rangesFrom, normalizeSettings, validateField, sanitizeSettings,
  clampSettings, addOptions, queueItemOptions, liveFromStatus, songTracksOf, guideVoicesOf, catchUpCommands,
  settingsFromLive, neutralTarget } = settingsModule;
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');
const { startFakeKaraFun } = require('../fake-karafun');

// Configuration annoncée par le KaraFun du bar (remote.ConfigurationUpdateEvent).
const BAR_CONFIGURATION = { pitchStep: 1, tempoStep: 5, pitchMin: -6, tempoMin: -50, pitchMax: 6, tempoMax: 50,
  compatibleMods: { battle: [1] } };
const RANGES = rangesFrom(BAR_CONFIGURATION);

// ---------------------------------------------------------------- plages
test('plages : configuration du KaraFun du bar, repli -6..6 pas 1 et -50..50 pas 5', () => {
  assert.deepEqual(RANGES, { pitch: { min: -6, max: 6, step: 1 }, tempo: { min: -50, max: 50, step: 5 },
    volume: { min: 0, max: 100, step: 25 } });
  assert.deepEqual(rangesFrom(null), RANGES, 'configuration pas encore reçue : repli');
  assert.deepEqual(rangesFrom({ compatibleMods: {} }), RANGES);
  // Une autre version de KaraFun peut annoncer d'autres plages.
  assert.deepEqual(rangesFrom({ pitchMin: -12, pitchMax: 12, pitchStep: 1, tempoMin: -30, tempoMax: 30, tempoStep: 10 }).pitch,
    { min: -12, max: 12, step: 1 });
  assert.deepEqual(rangesFrom({ pitchMin: -12, pitchMax: 12, pitchStep: 1, tempoMin: -30, tempoMax: 30, tempoStep: 10 }).tempo,
    { min: -30, max: 30, step: 10 });
  // Valeurs incohérentes : chaque plage retombe sur son repli.
  for (const broken of [{ pitchMin: 2, pitchMax: 6, pitchStep: 1 }, { pitchMin: -6, pitchMax: 6, pitchStep: 0 },
    { pitchMin: '-6', pitchMax: 6, pitchStep: 1 }, { pitchMin: -6, pitchMax: -6, pitchStep: 1 }, { pitchMin: -6.5, pitchMax: 6, pitchStep: 1 }]) {
    assert.deepEqual(rangesFrom(broken).pitch, { min: -6, max: 6, step: 1 }, JSON.stringify(broken));
  }
  assert.deepEqual(DEFAULTS, { pitch: 0, tempo: 0, guide: 0, backing: 100 }, 'guide coupé et chœurs à fond par défaut');
  assert.deepEqual(TRACK, { BACKING: 4, LEAD_A: 5, LEAD_B: 6 });
  assert.equal(VOLUME_STEP, 25);
});

// ---------------------------------------------------------------- validation
test('validation : entiers bornés par KaraFun, valeurs par défaut retirées, null = réglages de KaraFun', () => {
  assert.equal(normalizeSettings(null, RANGES), null);
  assert.equal(normalizeSettings(undefined, RANGES), null);
  assert.equal(normalizeSettings({}, RANGES), null, 'aucun réglage : KaraFun décide');
  assert.equal(normalizeSettings({ pitch: 0, tempo: 0 }, RANGES), null, 'tonalité et tempo d’origine : pas un réglage');
  assert.deepEqual(normalizeSettings({ pitch: 0, tempo: 0, guide: 0, backing: 100 }, RANGES), { guide: 0, backing: 100 },
    'volumes choisis gardés : leur valeur par défaut dépend du KaraFun (chœurs à 53 au bar)');
  assert.deepEqual(normalizeSettings({ pitch: -2, tempo: -10, guide: 50, backing: 0 }, RANGES),
    { pitch: -2, tempo: -10, guide: 50, backing: 0 });
  assert.deepEqual(normalizeSettings({ pitch: '3', tempo: null, guide: 75, backing: undefined, autre: 'x' }, RANGES),
    { pitch: 3, guide: 75 }, 'texte numérique accepté, champ inconnu ignoré');
  assert.deepEqual(normalizeSettings({ pitch: 6, tempo: 50 }, RANGES), { pitch: 6, tempo: 50 }, 'bornes incluses');
  assert.deepEqual(normalizeSettings({ pitch: -6, tempo: -50, guide: 100, backing: 25 }, RANGES),
    { pitch: -6, tempo: -50, guide: 100, backing: 25 });
  const refused = (input, message) => assert.throws(() => normalizeSettings(input, RANGES),
    error => error.code === 'SONG_SETTINGS' && error.message === message, JSON.stringify(input));
  refused('fort', 'Réglages de titre invalides.');
  refused([1, 2], 'Réglages de titre invalides.');
  refused({ pitch: 7 }, 'La tonalité va de -6 à +6 demi-tons.');
  refused({ pitch: -7 }, 'La tonalité va de -6 à +6 demi-tons.');
  refused({ pitch: 1.5 }, 'La tonalité va de -6 à +6 demi-tons.');
  refused({ pitch: '' }, 'La tonalité va de -6 à +6 demi-tons.');
  refused({ pitch: true }, 'La tonalité va de -6 à +6 demi-tons.');
  refused({ tempo: 12 }, 'Le tempo va de -50 % à +50 %, par pas de 5.');
  refused({ tempo: 55 }, 'Le tempo va de -50 % à +50 %, par pas de 5.');
  refused({ guide: 101 }, 'La voix guide va de 0 (coupée) à 100.');
  refused({ guide: -1 }, 'La voix guide va de 0 (coupée) à 100.');
  refused({ backing: 'beaucoup' }, 'Les chœurs vont de 0 (coupés) à 100.');
  // Plages plus larges annoncées par KaraFun : acceptées ; pas de tonalité plus grand annoncé.
  const wide = rangesFrom({ pitchMin: -12, pitchMax: 12, pitchStep: 2, tempoMin: -30, tempoMax: 30, tempoStep: 10 });
  assert.deepEqual(normalizeSettings({ pitch: -12, tempo: 30 }, wide), { pitch: -12, tempo: 30 });
  assert.throws(() => normalizeSettings({ pitch: 3 }, wide), { message: 'La tonalité va de -12 à +12 demi-tons, par pas de 2.' });
  // Un seul champ, pour les réglages en direct du bar.
  assert.equal(validateField('pitch', null, RANGES), 0, 'vide : valeur par défaut');
  assert.equal(validateField('backing', undefined, RANGES), 100);
  assert.equal(validateField('tempo', -25, RANGES), -25);
  assert.throws(() => validateField('volume', 3, RANGES), { message: 'Réglage de titre inconnu.' });
});

test('sauvegarde abîmée : chaque valeur invalide est retirée, le reste est gardé', () => {
  assert.equal(sanitizeSettings(null), null);
  assert.equal(sanitizeSettings('x'), null);
  assert.equal(sanitizeSettings([3]), null);
  assert.deepEqual(sanitizeSettings({ pitch: -2, tempo: 'vite', guide: 250, backing: 0, x: 1 }), { pitch: -2, backing: 0 });
  assert.equal(sanitizeSettings({ pitch: 0, tempo: 0 }), null, 'tonalité et tempo d’origine : rien à garder');
  assert.deepEqual(sanitizeSettings({ pitch: 0, backing: 100 }), { backing: 100 }, 'volume choisi gardé');
  assert.deepEqual(sanitizeSettings({ pitch: 0, tempo: 5, backing: 100 }, { keepDefaults: true }), { pitch: 0, tempo: 5, backing: 100 },
    'ce qui a été envoyé à KaraFun garde ses valeurs par défaut');
  assert.deepEqual(sanitizeSettings({ pitch: 30, tempo: -150, guide: 1.5 }), null, 'hors de toute plage plausible');
});

test('bornage avant envoi : ramené dans la plage de KaraFun et sur son pas', () => {
  assert.equal(clampSettings(null, RANGES), null);
  assert.deepEqual(clampSettings({ pitch: 9, tempo: 12, guide: 150, backing: -5 }, RANGES), { pitch: 6, tempo: 10, guide: 100, backing: 0 });
  assert.deepEqual(clampSettings({ pitch: -9, tempo: -52 }, RANGES), { pitch: -6, tempo: -50 });
  // Plage plus étroite annoncée par KaraFun après le réglage.
  assert.deepEqual(clampSettings({ pitch: -5 }, rangesFrom({ pitchMin: -3, pitchMax: 3, pitchStep: 1 })), { pitch: -3 });
});

// ---------------------------------------------------------------- options KaraFun
test('options d’ajout : chanteur seul sans réglage, sinon tonalité, tempo et pistes vocales', () => {
  assert.deepEqual(addOptions({ singer: 'Léa · T1', settings: null, ranges: RANGES }),
    { options: { singer: 'Léa · T1' }, sent: null }, 'sans réglage : la trame actuelle ne change pas');
  assert.deepEqual(addOptions({ singer: 'Léa · T1', settings: { pitch: -2, tempo: -10, guide: 30, backing: 0 }, ranges: RANGES }), {
    options: { singer: 'Léa · T1', pitch: -2, tempo: -10,
      tracks: [{ track: { type: 4 }, volume: 0 }, { track: { type: 5 }, volume: 30 }] },
    sent: { pitch: -2, tempo: -10, backing: 0, guide: 30 } });
  // Duo : chaque voix guide a son propre réglage (décision D6 du 8 octobre).
  assert.deepEqual(addOptions({ singer: 'Léa & Tom · T1', settings: { guide: 50 }, ranges: RANGES }).options,
    { singer: 'Léa & Tom · T1', tracks: [{ track: { type: 5 }, volume: 50 }] }, 'la voix 2 ne suit plus la voix 1');
  assert.deepEqual(addOptions({ singer: 'X', settings: { pitch: 9 }, ranges: RANGES }).options, { singer: 'X', pitch: 6 },
    'borné à la plage de KaraFun');
  // Pistes du titre connues (relance du titre en cours) : seulement celles-là.
  assert.deepEqual(addOptions({ singer: 'A & B', settings: { pitch: 1, guide: 50, backing: 0, guideVoices: { 6: 25 } }, ranges: RANGES,
    tracksAvailable: [5] }), { options: { singer: 'A & B', pitch: 1, tracks: [{ track: { type: 5 }, volume: 50 }] },
    sent: { pitch: 1, guide: 50 } }, 'titre sans voix 2 : son réglage est ignoré');
  assert.deepEqual(addOptions({ singer: 'A & B', settings: { guide: 25, guideVoices: { 6: 75 } }, ranges: RANGES, tracksAvailable: [4, 5, 6] }), {
    options: { singer: 'A & B', tracks: [{ track: { type: 5 }, volume: 25 }, { track: { type: 6 }, volume: 75 }] },
    sent: { guide: 25, guideVoices: { 6: 75 } } });
  assert.deepEqual(addOptions({ singer: 'C', settings: { backing: 0, guide: 25 }, ranges: RANGES, tracksAvailable: [6] }),
    { options: { singer: 'C' }, sent: null }, 'aucune piste réglable : rien d’autre que le chanteur');
});

test('options d’un titre de la file : tout est renvoyé (chanteur, Battle, valeurs inchangées)', () => {
  // KaraFun remplace TOUTES les options : chanteur et mode doivent revenir.
  assert.deepEqual(queueItemOptions({ singer: 'Léa · T1', settings: { pitch: -2, guide: 30 }, ranges: RANGES,
    tracksAvailable: [4, 5] }), {
    options: { singer: 'Léa · T1', pitch: -2, tempo: 0, tracks: [{ track: { type: 5 }, volume: 30 }] },
    sent: { pitch: -2, tempo: 0, guide: 30 } });
  const mod = { id: 1, caption: 'Battle', data: { battle: { subtype: 1 } } };
  assert.deepEqual(queueItemOptions({ singer: 'Battle collective', mod, settings: null, ranges: RANGES }).options,
    { singer: 'Battle collective', pitch: 0, tempo: 0, mod }, 'le mode Battle n’est jamais perdu');
  // Valeurs réglées dans KaraFun lui-même et pas par la file : gardées.
  const current = { singer: 'Léa · T1', pitch: 1, tempo: 5, tracks: [{ track: { type: 4 }, volume: 60 }, { track: { type: 5 }, volume: 10 }] };
  assert.deepEqual(queueItemOptions({ singer: 'Léa · T1', settings: { tempo: -10 }, current, ranges: RANGES, tracksAvailable: [4, 5] }).options,
    { singer: 'Léa · T1', pitch: 1, tempo: -10, tracks: [{ track: { type: 4 }, volume: 60 }, { track: { type: 5 }, volume: 10 }] });
  // Réglage remis par défaut après un envoi : la valeur par défaut est renvoyée.
  assert.deepEqual(queueItemOptions({ singer: 'Léa · T1', settings: null, sent: { pitch: -2, guide: 30 },
    current: { pitch: -2, tracks: [{ track: { type: 5 }, volume: 30 }] }, ranges: RANGES, tracksAvailable: [4, 5] }), {
    options: { singer: 'Léa · T1', pitch: 0, tempo: 0, tracks: [{ track: { type: 5 }, volume: 0 }] },
    sent: { pitch: 0, tempo: 0, guide: 0 } });
  // Valeurs par défaut observées sur le KaraFun du bar : chœurs à 53.
  assert.deepEqual(queueItemOptions({ singer: 'Léa · T1', settings: null, sent: { backing: 0 }, ranges: RANGES,
    tracksAvailable: [4, 5], defaults: { ...DEFAULTS, backing: 53 } }).options.tracks, [{ track: { type: 4 }, volume: 53 }]);
  // Pistes connues : seulement celles du titre ; chaque voix la sienne.
  assert.deepEqual(queueItemOptions({ singer: 'A & B · T1', settings: { guide: 25, backing: 50, guideVoices: { 6: 50 } }, ranges: RANGES,
    tracksAvailable: [5, 6] }).options.tracks,
  [{ track: { type: 5 }, volume: 25 }, { track: { type: 6 }, volume: 50 }], 'pas de chœurs sur ce titre');
  // Voix 2 jamais réglée par la file : sa valeur actuelle dans KaraFun est gardée.
  assert.deepEqual(queueItemOptions({ singer: 'A · T1', settings: { guide: 25 }, ranges: RANGES, tracksAvailable: [4, 5, 6],
    current: { tracks: [{ track: { type: 6 }, volume: 40 }] } }).options.tracks,
  [{ track: { type: 5 }, volume: 25 }, { track: { type: 6 }, volume: 40 }]);
  // Pistes inconnues : guide et chœurs envoyés, KaraFun ignore ceux qui manquent.
  assert.deepEqual(queueItemOptions({ singer: 'A · T1', settings: { guide: 25, backing: 50 }, ranges: RANGES }).options.tracks,
    [{ track: { type: 4 }, volume: 50 }, { track: { type: 5 }, volume: 25 }]);
  // Pistes inconnues : les voix réglées, envoyées ou déjà dans ses options aussi.
  assert.deepEqual(queueItemOptions({ singer: 'A · T1', settings: { guideVoices: { 7: 25 } }, sent: { guideVoices: { 6: 50 } }, ranges: RANGES,
    current: { tracks: [{ track: { type: 8 }, volume: 75 }, { track: { type: 3 }, volume: 10 }] } }), {
    options: { singer: 'A · T1', pitch: 0, tempo: 0,
      tracks: [{ track: { type: 6 }, volume: 0 }, { track: { type: 7 }, volume: 25 }, { track: { type: 8 }, volume: 75 }] },
    sent: { pitch: 0, tempo: 0, guideVoices: { 6: 0, 7: 25, 8: 75 } } });
});

// ---------------------------------------------------------------- état en direct
// StatusEvent du vrai KaraFun du bar (journal du 2 octobre), une fois normalisé par le pont.
const LIVE_STATUS = { state: 'playing', pitch: 0, tempo: 0, tracks: [{ volume: 0, track: { type: 5 } }],
  current: { queueId: '4f0c2a1e-0000-4000-8000-000000000001', songId: 12293, title: 'Le chanteur', singer: 'Lina · Table 4',
    songTracks: [5], options: { singer: 'Lina · Table 4' } } };

test('état en direct : tonalité, tempo, volumes et pistes du titre en cours', () => {
  assert.equal(liveFromStatus(null), null);
  assert.deepEqual(liveFromStatus(LIVE_STATUS), { queueId: '4f0c2a1e-0000-4000-8000-000000000001', pitch: 0, tempo: 0,
    guide: 0, backing: null, voices: { 5: 0 }, tracks: [5] });
  // Sans liste des pistes du titre : celles dont KaraFun donne le volume.
  assert.deepEqual(liveFromStatus({ state: 1, pitch: -1, tempo: 5, tracks: [{ volume: 100, track: { type: 4 } }, { volume: 0, track: { type: 5 } }] }),
    { queueId: null, pitch: -1, tempo: 5, guide: 0, backing: 100, voices: { 5: 0 }, tracks: [4, 5] });
  assert.deepEqual(liveFromStatus({ state: 'idle', tracks: [] }), { queueId: null, pitch: null, tempo: null, guide: null,
    backing: null, voices: {}, tracks: null }, 'rien de connu');
  // Chaque voix guide annoncée, sans supposer leur nombre ; volume illisible ignoré.
  assert.deepEqual(liveFromStatus({ state: 4, tracks: [{ volume: 25, track: { type: 6 } }, { volume: 50, track: { type: 5 } },
    { volume: 75, track: { type: 7 } }, { volume: 'x', track: { type: 8 } }, { volume: 60, track: { type: 4 } }] }).voices, { 5: 50, 6: 25, 7: 75 });
  // Faux KaraFun (ancien protocole) : titre en cours dans songPlaying.
  assert.equal(liveFromStatus({ state: 'playing', songPlaying: { queueId: 4, songTracks: [4, 5] } }).queueId, 4);
  assert.deepEqual(songTracksOf({ songTracks: [{ type: 4 }, { type: 5 }, { type: 'x' }] }), [4, 5], 'trame brute KCS');
  assert.deepEqual(songTracksOf({ songTracks: [5, 6] }), [5, 6]);
  assert.equal(songTracksOf({}), null);
  assert.equal(songTracksOf(null), null);
  assert.deepEqual(settingsFromLive({ pitch: -2, tempo: 0, guide: 0, backing: 50, voices: { 5: 0, 6: 0 } }), { pitch: -2, backing: 50 });
  assert.deepEqual(settingsFromLive({ pitch: 0, tempo: 0, guide: 25, backing: 100, voices: { 5: 25, 6: 50, 7: 0, 99: 50 } }),
    { guide: 25, guideVoices: { 6: 50 } }, 'relance d’un titre ajouté dans KaraFun : chaque voix copiée');
  assert.equal(settingsFromLive({ pitch: 0, tempo: 0, guide: 0, backing: 100 }), null);
  assert.equal(settingsFromLive({ pitch: 0, tempo: 0, guide: 0, backing: 53 }, { ...DEFAULTS, backing: 53 }), null,
    'chœurs à la valeur par défaut du KaraFun du bar : rien à copier');
  assert.deepEqual(settingsFromLive({ pitch: 0, tempo: 0, guide: 0, backing: 100 }, { ...DEFAULTS, backing: 53 }), { backing: 100 });
  assert.equal(settingsFromLive(null), null);
});

test('rattrapage au début du titre : seulement ce qui diffère, seulement les pistes du titre', () => {
  const live = liveFromStatus(LIVE_STATUS);
  assert.deepEqual(catchUpCommands({ settings: null, live, ranges: RANGES }), [], 'aucun réglage : rien à rattraper');
  assert.deepEqual(catchUpCommands({ settings: { pitch: -2, tempo: -10, guide: 40, backing: 0 }, live, ranges: RANGES }), [
    { kind: 'pitch', value: -2 }, { kind: 'tempo', value: -10 }, { kind: 'track', type: 5, value: 40 }],
  'pas de chœurs sur ce titre : aucun volume de chœurs envoyé');
  assert.deepEqual(catchUpCommands({ settings: { pitch: 0 }, live, ranges: RANGES }), []);
  assert.deepEqual(catchUpCommands({ settings: { pitch: -2 }, live: { ...live, pitch: -2 }, ranges: RANGES }), [],
    'KaraFun a déjà appliqué le réglage');
  // Réglage remis par défaut après l'envoi, ignoré par KaraFun : la valeur par défaut est rétablie.
  assert.deepEqual(catchUpCommands({ settings: null, sent: { pitch: -2 }, live: { ...live, pitch: -2 }, ranges: RANGES }),
    [{ kind: 'pitch', value: 0 }]);
  // Titre à deux voix : chaque voix la sienne, en solo comme en duo.
  const duoLive = { queueId: 'q', pitch: 0, tempo: 0, guide: 0, backing: 100, voices: { 5: 0, 6: 0 }, tracks: [4, 5, 6] };
  assert.deepEqual(catchUpCommands({ settings: { guide: 50, guideVoices: { 6: 25 } }, live: duoLive, ranges: RANGES }),
    [{ kind: 'track', type: 5, value: 50 }, { kind: 'track', type: 6, value: 25 }]);
  assert.deepEqual(catchUpCommands({ settings: { guide: 50 }, live: duoLive, ranges: RANGES }),
    [{ kind: 'track', type: 5, value: 50 }], 'voix 2 sans réglage : pas touchée sans valeur neutre');
  assert.deepEqual(catchUpCommands({ settings: { guideVoices: { 6: 75 } }, live: duoLive, ranges: RANGES }),
    [{ kind: 'track', type: 6, value: 75 }], 'voix 2 seule');
  assert.deepEqual(catchUpCommands({ settings: { pitch: 9 }, live, ranges: RANGES }), [{ kind: 'pitch', value: 6 }], 'borné');
  assert.deepEqual(catchUpCommands({ settings: { pitch: -1 }, live: null, ranges: RANGES }), []);
  // Chœurs remis par défaut après l'envoi : la valeur par défaut du KaraFun du bar (53).
  assert.deepEqual(catchUpCommands({ settings: null, sent: { backing: 0 }, live: { ...duoLive, backing: 0 }, ranges: RANGES,
    defaults: { ...DEFAULTS, backing: 53 } }), [{ kind: 'track', type: 4, value: 53 }]);
});

// Chaque titre isolé (lot G) : un KaraFun peut garder les valeurs du titre
// précédent ; au chargement, la cible d'un champ que le titre ne règle pas
// est sa valeur neutre.
test('valeurs neutres d’un titre qui se charge : 0 partout, chœurs seulement si le titre précédent les avait changés', () => {
  assert.deepEqual(neutralTarget(), { pitch: 0, tempo: 0, guide: 0 }, 'toutes les voix guides à 0');
  assert.deepEqual(neutralTarget({ backingDefault: 53, previousBacking: 53 }), { pitch: 0, tempo: 0, guide: 0 },
    'chœurs inchangés au titre précédent : pas touchés');
  assert.deepEqual(neutralTarget({ backingDefault: 53, previousBacking: 0 }), { pitch: 0, tempo: 0, guide: 0, backing: 53 });
  assert.deepEqual(neutralTarget({ backingDefault: null, previousBacking: 0 }), { pitch: 0, tempo: 0, guide: 0 },
    'valeur par défaut du KaraFun inconnue : jamais devinée');
  assert.deepEqual(neutralTarget({ backingDefault: 53, previousBacking: null }), { pitch: 0, tempo: 0, guide: 0 });
  // Titre ajouté directement dans KaraFun : ses propres options d'abord.
  assert.deepEqual(neutralTarget({ backingDefault: 53, previousBacking: 0, options: { singer: 'X', pitch: -1, tempo: 10,
    tracks: [{ track: { type: 4 }, volume: 20 }, { track: { type: 5 }, volume: 50 }, { track: { type: 6 }, volume: 25 },
      { track: { type: 7 }, volume: 75 }, { track: { type: 8 } }] } }),
  { pitch: -1, tempo: 10, guide: 50, guideVoices: { 6: 25, 7: 75 }, backing: 20 });
  assert.deepEqual(neutralTarget({ options: { pitch: 'x', tracks: 'abîmé' } }), { pitch: 0, tempo: 0, guide: 0 });
});

test('début d’un titre : les champs non réglés reviennent à leur valeur neutre, seulement ce qui diffère', () => {
  const neutral = neutralTarget();
  const sticky = { queueId: 'q', pitch: 2, tempo: 0, guide: 25, backing: 53, voices: { 5: 25, 6: 25 }, tracks: [4, 5, 6] };
  const reset = { ...sticky, pitch: 0, guide: 0, voices: { 5: 0, 6: 0 } };
  assert.deepEqual(catchUpCommands({ settings: null, live: sticky, ranges: RANGES, neutral }), [
    { kind: 'pitch', value: 0, neutral: true }, { kind: 'track', type: 5, value: 0, neutral: true },
    { kind: 'track', type: 6, value: 0, neutral: true }]);
  assert.deepEqual(catchUpCommands({ settings: null, live: reset, ranges: RANGES, neutral }), [],
    'KaraFun a déjà remis à zéro : rien');
  // Réglage du titre : il prime sur la valeur neutre, et n'est pas marqué neutre.
  assert.deepEqual(catchUpCommands({ settings: { guide: 50 }, live: sticky, ranges: RANGES, neutral }), [
    { kind: 'pitch', value: 0, neutral: true }, { kind: 'track', type: 5, value: 50 }, { kind: 'track', type: 6, value: 0, neutral: true }]);
  // Chaque voix la sienne : la voix 2 réglée seule, la voix 1 revient à 0.
  assert.deepEqual(catchUpCommands({ settings: { guideVoices: { 6: 50 } }, live: { ...sticky, pitch: 0 }, ranges: RANGES, neutral }), [
    { kind: 'track', type: 5, value: 0, neutral: true }, { kind: 'track', type: 6, value: 50 }]);
  // Valeur actuelle inconnue (pas annoncée par KaraFun) : rien d'envoyé à l'aveugle.
  assert.deepEqual(catchUpCommands({ settings: null, live: { queueId: 'q', pitch: null, tempo: null, guide: null,
    backing: null, voices: {}, tracks: null }, ranges: RANGES, neutral: { ...neutral, backing: 53 } }), []);
  assert.deepEqual(catchUpCommands({ settings: null, live: { ...reset, voices: { 5: 0 } }, ranges: RANGES, neutral }), [],
    'voix 2 neutre inconnue : rien');
  // Titre sans voix guide 2 : la piste 6 n'est pas touchée, même réglée.
  assert.deepEqual(catchUpCommands({ settings: { guideVoices: { 6: 50 } }, live: { ...sticky, pitch: 0, guide: 0, tracks: [4, 5] },
    ranges: RANGES, neutral }), []);
  // Chœurs : seulement si la cible neutre les porte (titre précédent changé).
  assert.deepEqual(catchUpCommands({ settings: null, live: { ...reset, backing: 0 }, ranges: RANGES,
    neutral: { ...neutral, backing: 53 } }), [{ kind: 'track', type: 4, value: 53, neutral: true }]);
  assert.deepEqual(catchUpCommands({ settings: null, live: { ...reset, backing: 0 }, ranges: RANGES, neutral }), []);
  // Tempo d'un titre ajouté dans KaraFun (ses options) : visé tel quel.
  assert.deepEqual(catchUpCommands({ settings: null, live: reset, ranges: RANGES,
    neutral: neutralTarget({ options: { tempo: 10 } }) }), [{ kind: 'tempo', value: 10, neutral: true }]);
});

// Voix guide réglable voix par voix (lot G2, décision D6) : `guide` règle la
// voix 1 (piste 5), `guideVoices` chacune des autres, sans supposer leur nombre.
test('voix guides : une piste supplémentaire annoncée est réglée comme les autres, chacune revient à 0', () => {
  assert.deepEqual(guideVoicesOf([7, 4, 6, 5, 16, 3, 'x', 6]), [5, 6, 7], 'hors chœurs, types 5 à 15, dans l’ordre des pistes');
  assert.equal(guideVoicesOf(null), null, 'pistes inconnues');
  const three = { queueId: 'q', pitch: 0, tempo: 0, guide: 25, backing: 53, voices: { 5: 25, 6: 25, 7: 25 }, tracks: [4, 5, 6, 7] };
  assert.deepEqual(catchUpCommands({ settings: { guideVoices: { 7: 100 } }, live: three, ranges: RANGES, neutral: neutralTarget() }), [
    { kind: 'track', type: 5, value: 0, neutral: true }, { kind: 'track', type: 6, value: 0, neutral: true },
    { kind: 'track', type: 7, value: 100 }]);
  // Pistes inconnues : la voix 1, et les voix réglées, envoyées ou dont KaraFun donne le volume.
  const unknown = { queueId: 'q', pitch: 0, tempo: 0, guide: 0, backing: null, voices: { 5: 0, 8: 50 }, tracks: null };
  assert.deepEqual(catchUpCommands({ settings: { guideVoices: { 7: 25 } }, sent: { guideVoices: { 6: 75 } }, live: unknown, ranges: RANGES,
    neutral: neutralTarget() }), [{ kind: 'track', type: 6, value: 0 }, { kind: 'track', type: 7, value: 25 },
    { kind: 'track', type: 8, value: 0, neutral: true }]);
  // Envoyée puis retirée (duo devenu solo, réglage effacé) : la voix revient à 0.
  assert.deepEqual(catchUpCommands({ settings: { guide: 50 }, sent: { guide: 50, guideVoices: { 6: 50 } },
    live: { ...three, guide: 50, voices: { 5: 50, 6: 50, 7: 0 } }, ranges: RANGES }), [{ kind: 'track', type: 6, value: 0 }]);
  // Réglages reçus d'une page : chaque voix validée comme la voix guide.
  assert.deepEqual(normalizeSettings({ guide: 25, guideVoices: { 6: 50, 7: '0', 8: null } }, RANGES), { guide: 25, guideVoices: { 6: 50, 7: 0 } });
  assert.deepEqual(normalizeSettings({ guideVoices: { 6: 0 } }, RANGES), { guideVoices: { 6: 0 } }, 'voix 2 coupée choisie : gardée');
  assert.equal(normalizeSettings({ guideVoices: { 6: null } }, RANGES), null);
  assert.equal(normalizeSettings({ guideVoices: null }, RANGES), null);
  const refused = (input, message) => assert.throws(() => normalizeSettings(input, RANGES),
    error => error.code === 'SONG_SETTINGS' && error.message === message, JSON.stringify(input));
  refused({ guideVoices: [50] }, 'Réglages de titre invalides.');
  refused({ guideVoices: 'fort' }, 'Réglages de titre invalides.');
  refused({ guideVoices: { 5: 50 } }, 'Voix guide inconnue.');
  refused({ guideVoices: { 4: 50 } }, 'Voix guide inconnue.');
  refused({ guideVoices: { 16: 50 } }, 'Voix guide inconnue.');
  refused({ guideVoices: { '06': 50 } }, 'Voix guide inconnue.');
  refused({ guideVoices: { voix: 50 } }, 'Voix guide inconnue.');
  refused({ guideVoices: { 6: 101 } }, 'La voix guide va de 0 (coupée) à 100.');
  refused({ guideVoices: { 6: 12.5 } }, 'La voix guide va de 0 (coupée) à 100.');
  // Sauvegarde : seules les valeurs possibles restent.
  assert.deepEqual(sanitizeSettings({ guide: 25, guideVoices: { 6: 50, 7: 150, 5: 25, 20: 50, x: 1 } }), { guide: 25, guideVoices: { 6: 50 } });
  assert.equal(sanitizeSettings({ guideVoices: { 6: -1 } }), null);
  assert.equal(sanitizeSettings({ guideVoices: [50] }), null);
  // Avant l'envoi : bornées, sur une clé de voix valable.
  assert.deepEqual(clampSettings({ guideVoices: { 6: 120, 7: 33.4, 4: 50, 9: 'x' } }, RANGES), { guideVoices: { 6: 100, 7: 33 } });
  // Options d'ajout : chaque voix réglée, pistes inconnues comprises.
  assert.deepEqual(addOptions({ singer: 'S', settings: { guideVoices: { 6: 50, 7: 25 } }, ranges: RANGES }), {
    options: { singer: 'S', tracks: [{ track: { type: 6 }, volume: 50 }, { track: { type: 7 }, volume: 25 }] },
    sent: { guideVoices: { 6: 50, 7: 25 } } });
});

// ---------------------------------------------------------------- sauvegarde et reprise
function night() {
  const sched = new Scheduler({ solverEnabled: false });
  const access = new TableAccess();
  sched.table('1').headcount = 4;
  access.issue('1');
  const lea = sched.join({ tableId: '1', name: 'Léa' });
  const tom = sched.join({ tableId: '1', name: 'Tom' });
  sched.chooseSong(lea, { songId: 101, title: 'Premier' });
  sched.chooseSong(lea, { songId: 102, title: 'Second' }, 'append');
  sched.chooseSong(tom, { songId: 201, title: 'Celui de Tom' });
  return { sched, access, lea, tom };
}

test('sauvegarde et reprise : les réglages suivent le titre, une valeur invalide est retirée sans perdre la soirée', () => {
  const { sched, access, lea, tom } = night();
  sched.setSongSettings(lea.song, { pitch: -2, guide: 50 });
  sched.setSongSettings(lea.backlog[0], { tempo: 10 });
  const sel = sched.select();
  const tomSel = { ids: [tom.id], names: ['Tom'], label: 'Tom · Table 1', song: { ...tom.song, settings: { backing: 0 } } };
  const tracked = [{ queueId: 'q-1', sel: tomSel, addedAt: 1, startedAt: null,
    sentSettings: { pitch: 0, tempo: 0, backing: 0 }, liveChecked: null, statusAtOptions: 41 }];
  const settings = { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8, singerSongSettings: false };
  const snapshot = snapshotNight({ scheduler: sched, access, settings, tracked });
  // Valeurs abîmées à la main dans le fichier de sauvegarde.
  const people = snapshot.scheduler.people;
  people.find(p => p.name === 'Tom').song.settings = { pitch: 99, tempo: 'vite', guide: 25 };
  snapshot.tracked[0].sentSettings = { pitch: 0, tempo: 'x', backing: 0 };
  const restored = new Scheduler({ solverEnabled: false });
  const restoredAccess = new TableAccess();
  const restoredSettings = { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8, singerSongSettings: true };
  const out = restoreNight(JSON.parse(JSON.stringify(snapshot)), { scheduler: restored, access: restoredAccess, settings: restoredSettings });
  const leaBack = restored.people.get(lea.id);
  assert.deepEqual(leaBack.song.settings, { pitch: -2, guide: 50 });
  assert.deepEqual(leaBack.backlog[0].settings, { tempo: 10 });
  assert.deepEqual(restored.people.get(tom.id).song.settings, { guide: 25 }, 'seules les valeurs invalides sont retirées');
  assert.deepEqual(out.tracked[0].sel.song.settings, { backing: 0 });
  assert.deepEqual(out.tracked[0].sentSettings, { pitch: 0, backing: 0 }, 'envoi noté : valeurs par défaut gardées');
  assert.equal(Object.hasOwn(out.tracked[0], 'statusAtOptions'), false, 'numéro d’état de KaraFun propre à l’exécution précédente');
  assert.equal(restoredSettings.singerSongSettings, false, 'interrupteur du bar repris');
  // Interrupteur abîmé : retiré, la valeur actuelle (activée) reste.
  snapshot.settings.singerSongSettings = 'oui';
  people.find(p => p.name === 'Tom').song.settings = 'n’importe quoi';
  const again = { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8, singerSongSettings: true };
  const restoredAgain = new Scheduler({ solverEnabled: false });
  restoreNight(JSON.parse(JSON.stringify(snapshot)), { scheduler: restoredAgain, access: new TableAccess(), settings: again });
  assert.equal(again.singerSongSettings, true);
  assert.equal(Object.hasOwn(restoredAgain.people.get(tom.id).song, 'settings'), false, 'réglages illisibles : réglages de KaraFun');
  // Envoi en cours repris avec ses réglages.
  const pendingSnap = snapshotNight({ scheduler: sched, access, settings, pending: { sel: { ...sel, song: { ...sel.song, settings: { pitch: 7, guide: 0 } } },
    before: new Set(), at: 1, attempts: 1, sentSettings: { pitch: 7 } } });
  const withPending = restoreNight(JSON.parse(JSON.stringify(pendingSnap)), { scheduler: new Scheduler({ solverEnabled: false }),
    access: new TableAccess(), settings: { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 } });
  assert.deepEqual(withPending.pending.sel.song.settings, { pitch: 7, guide: 0 }, 'voix guide coupée choisie : gardée');
  assert.deepEqual(withPending.pending.sentSettings, { pitch: 7 });
});

// Lot G2 : une sauvegarde d'avant les voix guides réglées une à une ne perd
// rien. Dans un duo, la voix 2 suivait la voix 1 : elle reçoit le même réglage.
test('sauvegarde d’avant les voix guides une à une : un duo avec voix guide reprend la voix 2 au même réglage', () => {
  const { sched, access, lea, tom } = night();
  const zoe = sched.join({ tableId: '1', name: 'Zoé' });
  const duet = sched.inviteDuet(tom, zoe.id, { songId: 301, title: 'Duo prévu' });
  sched.setSongSettings(duet, { guide: 25 });
  sched.setSongSettings(lea.song, { guide: 50 });
  const sel = (ids, settings) => ({ ids, names: ids.map(() => 'X'), label: 'X · Table 1',
    song: { entryId: `e-${ids.length}-${settings.guide}`, songId: 500 + settings.guide, title: 'Envoyé', settings } });
  const tracked = [
    { queueId: 'q-duo', sel: sel([lea.id, tom.id], { guide: 75 }), addedAt: 1, startedAt: null, sentSettings: { guide: 75, guideB: 75 } },
    // Duo devenu solo : la file avait posé la voix B, qui suivait encore la voix A.
    { queueId: 'q-solo', sel: sel([lea.id], { guide: 0, pitch: 1 }), addedAt: 2, startedAt: null, sentSettings: { guide: 50, guideB: 50 } },
    { queueId: 'q-seul', sel: sel([tom.id], { guide: 30 }), addedAt: 3, startedAt: null, sentSettings: { guide: 30 } },
  ];
  const pending = { sel: sel([zoe.id, lea.id], { guide: 100 }), before: new Set(), at: 1, attempts: 1, sentSettings: { guide: 100, guideB: 100 } };
  const settings = { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 };
  const snapshot = snapshotNight({ scheduler: sched, access, settings, tracked, pending });
  assert.equal(snapshot.guideVoicesSaved, true, 'nouvelle sauvegarde : marquée');
  const old = JSON.parse(JSON.stringify(snapshot));
  delete old.guideVoicesSaved;
  const restored = new Scheduler({ solverEnabled: false });
  const out = restoreNight(old, { scheduler: restored, access: new TableAccess(), settings: { ...settings } });
  const entry = (scheduler, p, entryId) => scheduler.songsOf(scheduler.people.get(p.id)).find(song => song.entryId === entryId);
  assert.deepEqual(entry(restored, tom, duet.entryId).settings, { guide: 25, guideVoices: { 6: 25 } }, 'duo prévu : la voix 2 garde le réglage qu’elle suivait');
  assert.deepEqual(entry(restored, lea, lea.song.entryId).settings, { guide: 50 }, 'titre seul : rien d’ajouté');
  assert.deepEqual(out.tracked.map(tr => [tr.queueId, tr.sel.song.settings, tr.sentSettings]), [
    ['q-duo', { guide: 75, guideVoices: { 6: 75 } }, { guide: 75, guideVoices: { 6: 75 } }],
    ['q-solo', { guide: 0, pitch: 1, guideVoices: { 6: 0 } }, { guide: 50, guideVoices: { 6: 50 } }],
    ['q-seul', { guide: 30 }, { guide: 30 }],
  ]);
  assert.deepEqual([out.pending.sel.song.settings, out.pending.sentSettings],
    [{ guide: 100, guideVoices: { 6: 100 } }, { guide: 100, guideVoices: { 6: 100 } }]);
  // Nouvelle sauvegarde : un duo sans réglage de voix 2 n'en reçoit pas (voix 2 coupée choisie).
  const again = new Scheduler({ solverEnabled: false });
  const fresh = restoreNight(JSON.parse(JSON.stringify(snapshot)), { scheduler: again, access: new TableAccess(), settings: { ...settings } });
  assert.deepEqual(entry(again, tom, duet.entryId).settings, { guide: 25 });
  assert.deepEqual(fresh.tracked[0].sel.song.settings, { guide: 75 });
  assert.deepEqual(fresh.tracked[0].sentSettings, { guide: 75, guideVoices: { 6: 75 } }, 'ce qui a été envoyé reste noté');
  // Voix 2 déjà réglée : elle prime ; titre sans voix guide : rien à reprendre.
  sched.setSongSettings(duet, { guide: 25, guideVoices: { 6: 0 } });
  const kept = JSON.parse(JSON.stringify(snapshotNight({ scheduler: sched, access, settings })));
  delete kept.guideVoicesSaved;
  const third = new Scheduler({ solverEnabled: false });
  restoreNight(kept, { scheduler: third, access: new TableAccess(), settings: { ...settings } });
  assert.deepEqual(entry(third, tom, duet.entryId).settings, { guide: 25, guideVoices: { 6: 0 } });
  sched.setSongSettings(duet, { pitch: 2 });
  const noGuide = JSON.parse(JSON.stringify(snapshotNight({ scheduler: sched, access, settings })));
  delete noGuide.guideVoicesSaved;
  const fourth = new Scheduler({ solverEnabled: false });
  restoreNight(noGuide, { scheduler: fourth, access: new TableAccess(), settings: { ...settings } });
  assert.deepEqual(entry(fourth, tom, duet.entryId).settings, { pitch: 2 });
});

test('faux KaraFun : pistes imposées pour un titre (trois voix guides), volume inconnu à 0', async () => {
  const port = await freePort();
  const fake = await startFakeKaraFun({ port, code: '424242', songSeconds: 60, songTracks: { 70001: [4, 5, 6, 7] } });
  const socket = io(fake.base, { query: { remote: 'kf424242' }, transports: ['websocket'], forceNew: true, reconnection: false });
  try {
    await new Promise(resolve => socket.on('connect', resolve));
    const firstQueue = nextEvent(socket, 'queue');
    socket.emit('authenticate', { channel: '424242' });
    await firstQueue;
    const status = nextEvent(socket, 'status', s => s.state === 'playing' && s.songPlaying?.songId === 70001);
    socket.emit('queueAdd', { songId: 70001, singer: 'A', options: { tracks: [{ track: { type: 6 }, volume: 50 }] } });
    const live = await status;
    assert.deepEqual(live.songPlaying.songTracks, [4, 5, 6, 7]);
    assert.deepEqual(live.tracks.map(row => [row.track.type, row.volume]), [[4, 100], [5, 0], [6, 50], [7, 0]]);
    const queued = nextEvent(socket, 'queue', q => q.length === 2);
    fake.manualAdd(70001, 'B');
    assert.deepEqual((await queued)[1].songTracks, [4, 5, 6, 7], 'aussi pour un titre ajouté à la main');
  } finally { socket.close(); fake.close(); }
});

test('ordonnanceur : réglages posés ou retirés sur l’entrée du titre, la vue change de version', () => {
  const { sched, lea, tom } = night();
  const before = sched.version;
  sched.setSongSettings(lea.song, { pitch: 1 });
  assert.deepEqual(lea.song.settings, { pitch: 1 });
  assert.ok(sched.version > before);
  const copy = { pitch: 2 };
  sched.setSongSettings(lea.song, copy);
  copy.pitch = 5;
  assert.deepEqual(lea.song.settings, { pitch: 2 }, 'copie gardée, pas la référence de la requête');
  sched.setSongSettings(lea.song, null);
  assert.equal(Object.hasOwn(lea.song, 'settings'), false, 'réinitialisé : champ retiré');
  // « Pas prêt » puis retour : le titre revient avec ses réglages.
  sched.setSongSettings(lea.song, { tempo: -5 });
  sched.setSongSettings(tom.song, { tempo: 5 });
  const sel = sched.select();
  const owner = sched.people.get(sel.ids[0]);
  const expected = owner === lea ? { tempo: -5 } : { tempo: 5 };
  sched.commit(sel);
  assert.notEqual(owner.song?.entryId, sel.song.entryId, 'le titre est parti');
  sched.requeueUnplayed(sel);
  assert.equal(owner.song.entryId, sel.song.entryId);
  assert.deepEqual(owner.song.settings, expected);
});

// ---------------------------------------------------------------- faux KaraFun (démo)
const freePort = () => new Promise(resolve => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const nextEvent = (socket, name, accept = () => true) => new Promise(resolve => {
  const on = data => { if (accept(data)) { socket.off(name, on); resolve(data); } };
  socket.on(name, on);
});

test('faux KaraFun : options d’ajout, options d’un titre de la file et réglages du titre en cours', async t => {
  const port = await freePort();
  const fake = await startFakeKaraFun({ port, code: '123456', songSeconds: 60, autoplay: false });
  t.after(() => fake.close());
  const socket = io(fake.base, { query: { remote: 'kf123456' }, transports: ['websocket'], forceNew: true, reconnection: false });
  t.after(() => socket.close());
  await new Promise(resolve => socket.on('connect', resolve));
  const firstQueue = nextEvent(socket, 'queue');
  socket.emit('authenticate', { channel: '123456' });
  await firstQueue;
  // Ajout avec réglages : KaraFun les garde dans les options du titre.
  let queued = nextEvent(socket, 'queue', q => q.length === 1);
  socket.emit('queueAdd', { songId: 70002, singer: 'Léa · T1', pos: 99999,
    options: { pitch: -2, tracks: [{ track: { type: 5 }, volume: 30 }] } });
  let queue = await queued;
  const item = queue[0];
  assert.deepEqual(item.options, { singer: 'Léa · T1', pitch: -2, tracks: [{ track: { type: 5 }, volume: 30 }] });
  assert.ok(Array.isArray(item.songTracks) && item.songTracks.includes(5), 'chaque titre annonce ses pistes vocales');
  // Options remplacées sur le titre de la file (comme SetQueueItemOptionsRequest).
  queued = nextEvent(socket, 'queue', q => q[0]?.options?.tempo === 10);
  socket.emit('queueItemOptions', { queueId: item.queueId, options: { singer: 'Léa · T1', pitch: 1, tempo: 10,
    tracks: [{ track: { type: 5 }, volume: 50 }] } });
  queue = await queued;
  assert.deepEqual(queue[0].options, { singer: 'Léa · T1', pitch: 1, tempo: 10, tracks: [{ track: { type: 5 }, volume: 50 }] });
  // Lecture : comme KaraFun (état 1 du KCS), le titre est d'abord annoncé sans
  // être chargé (pistes vides, réglages d'origine), puis ses options
  // deviennent l'état en direct.
  const announced = nextEvent(socket, 'status', s => s.state === 'idle' && s.songPlaying);
  let status = nextEvent(socket, 'status', s => s.state === 'playing');
  socket.emit('play');
  const early = await announced;
  assert.deepEqual([early.songPlaying.queueId, early.pitch, early.tempo, early.tracks], [item.queueId, 0, 0, []]);
  let live = await status;
  assert.equal(live.pitch, 1);
  assert.equal(live.tempo, 10);
  assert.equal(live.tracks.find(row => row.track.type === 5).volume, 50, 'voix guide du titre appliquée au démarrage');
  assert.deepEqual(live.songPlaying.songTracks, item.songTracks);
  assert.ok(Array.isArray(live.tracks));
  // Réglages du titre en cours (PitchRequest, TempoRequest, TrackVolumeRequest).
  status = nextEvent(socket, 'status', s => s.pitch === -3);
  socket.emit('pitch', -3);
  live = await status;
  status = nextEvent(socket, 'status', s => s.tempo === -20);
  socket.emit('tempo', -20);
  live = await status;
  status = nextEvent(socket, 'status', s => s.tracks.some(row => row.track.type === 5 && row.volume === 75));
  socket.emit('trackVolume', { type: 5, volume: 75 });
  live = await status;
  assert.equal(live.pitch, -3);
  // Réglage d'une piste que le titre n'a pas, ou d'un titre inconnu : rien ne change.
  socket.emit('trackVolume', { type: 9, volume: 10 });
  socket.emit('queueItemOptions', { queueId: 999, options: { pitch: 4 } });
  status = nextEvent(socket, 'status', s => s.tempo === 15);
  socket.emit('tempo', 15);
  live = await status;
  assert.equal(live.tracks.some(row => row.track.type === 9), false);
  // Options du titre en cours changées : appliquées en direct aussi.
  status = nextEvent(socket, 'status', s => s.pitch === 2);
  socket.emit('queueItemOptions', { queueId: item.queueId, options: { singer: 'Léa · T1', pitch: 2 } });
  live = await status;
  assert.equal(live.tempo, 0, 'options remplacées : tempo par défaut');
  assert.deepEqual(fake.state().queue[0].options, { singer: 'Léa · T1', pitch: 2 });
});

test('faux KaraFun collant (stickyLive) : le titre suivant garde les réglages du précédent, sauf ses options', async t => {
  for (const stickyLive of [true, false]) {
    const port = await freePort();
    const fake = await startFakeKaraFun({ port, code: '123456', songSeconds: 60, autoplay: false, stickyLive });
    t.after(() => fake.close());
    const socket = io(fake.base, { query: { remote: 'kf123456' }, transports: ['websocket'], forceNew: true, reconnection: false });
    t.after(() => socket.close());
    await new Promise(resolve => socket.on('connect', resolve));
    const firstQueue = nextEvent(socket, 'queue');
    socket.emit('authenticate', { channel: '123456' });
    await firstQueue;
    const queued = nextEvent(socket, 'queue', q => q.length === 3);
    socket.emit('queueAdd', { songId: 70000, singer: 'A', pos: 99999 });
    socket.emit('queueAdd', { songId: 70001, singer: 'B', pos: 99999 });
    socket.emit('queueAdd', { songId: 70002, singer: 'C', pos: 99999, options: { pitch: 1 } });
    await queued;
    let status = nextEvent(socket, 'status', s => s.state === 'playing' && s.songPlaying?.singer === 'A');
    socket.emit('play');
    await status;
    status = nextEvent(socket, 'status', s => s.pitch === -3 && s.tracks.some(row => row.track.type === 5 && row.volume === 75));
    socket.emit('pitch', -3);
    socket.emit('trackVolume', { type: 5, volume: 75 });
    await status;
    const guide = live => live.tracks.find(row => row.track.type === 5).volume;
    const playNext = async singer => {
      const idle = nextEvent(socket, 'status', s => s.state === 'infoscreen');
      socket.emit('next');
      await idle;
      const started = nextEvent(socket, 'status', s => s.state === 'playing' && s.songPlaying?.singer === singer);
      socket.emit('play');
      return started;
    };
    const b = await playNext('B');
    assert.deepEqual([b.pitch, guide(b)], stickyLive ? [-3, 75] : [0, 0], 'titre sans options');
    const c = await playNext('C');
    assert.deepEqual([c.pitch, guide(c)], stickyLive ? [1, 75] : [1, 0], 'ses options priment');
  }
});

test('module : rien d’autre n’est exporté par inadvertance', () => {
  assert.deepEqual(Object.keys(settingsModule).sort(), ['DEFAULTS', 'FIELDS', 'TRACK', 'VOLUME_STEP', 'addOptions', 'catchUpCommands',
    'clampSettings', 'guideVoicesOf', 'liveFromStatus', 'neutralTarget', 'normalizeSettings', 'queueItemOptions', 'rangesFrom', 'sanitizeSettings',
    'settingsFromLive', 'songTracksOf', 'validateField'].sort());
});

// Regression: relecture PR #11, revue au lot G2 (D6) — la voix 2 posée par
// la file est notée dans ce qui est envoyé, revient à 0 si son réglage
// disparaît (duo devenu solo), et une ancienne sauvegarde (`guideB`) la garde.
test('voix guide 2 posée par la file : notée à l’envoi, remise à 0 si son réglage disparaît, reprise d’une ancienne sauvegarde', () => {
  assert.deepEqual(addOptions({ singer: 'A & B', settings: { guide: 50, guideVoices: { 6: 50 } }, ranges: RANGES }).sent,
    { guide: 50, guideVoices: { 6: 50 } });
  const sent = { guide: 50, guideVoices: { 6: 50 } };
  const current = { tracks: [{ track: { type: 5 }, volume: 50 }, { track: { type: 6 }, volume: 50 }] };
  assert.deepEqual(queueItemOptions({ singer: 'A · T1', settings: { guide: 0 }, sent, current, ranges: RANGES, tracksAvailable: [5, 6] }),
    { options: { singer: 'A · T1', pitch: 0, tempo: 0, tracks: [{ track: { type: 5 }, volume: 0 }, { track: { type: 6 }, volume: 0 }] },
      sent: { pitch: 0, tempo: 0, guide: 0, guideVoices: { 6: 0 } } });
  assert.deepEqual(queueItemOptions({ singer: 'A · T1', settings: { guide: 0 }, sent, current, ranges: RANGES }).options.tracks,
    [{ track: { type: 5 }, volume: 0 }, { track: { type: 6 }, volume: 0 }], 'pistes inconnues');
  const duoLive = { queueId: 'q', pitch: 0, tempo: 0, guide: 0, backing: 100, voices: { 5: 0, 6: 50 }, tracks: [4, 5, 6] };
  assert.deepEqual(catchUpCommands({ settings: { guide: 0 }, sent, live: duoLive, ranges: RANGES }),
    [{ kind: 'track', type: 6, value: 0 }]);
  // Ancienne sauvegarde : `guideB` (piste B posée pour un duo) devient la voix 2 envoyée.
  assert.deepEqual(sanitizeSettings({ guide: 0, guideB: 50 }, { keepDefaults: true }), { guide: 0, guideVoices: { 6: 50 } });
  assert.deepEqual(sanitizeSettings({ guide: 0, guideB: 50, guideVoices: { 6: 25, 7: 0 } }, { keepDefaults: true }),
    { guide: 0, guideVoices: { 6: 25, 7: 0 } }, 'déjà au nouveau format : il prime');
  assert.deepEqual(sanitizeSettings({ guideB: 50, guideVoices: { 7: 0 } }, { keepDefaults: true }), { guideVoices: { 6: 50, 7: 0 } });
  assert.deepEqual(sanitizeSettings({ guide: 30, guideB: 50 }), { guide: 30 }, 'réglages d’un titre : pas de piste B');
  assert.deepEqual(sanitizeSettings({ guideB: 150 }, { keepDefaults: true }), null);
});
