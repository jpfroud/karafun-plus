'use strict';
// Barre de lecture du titre sur scène (lot F) : règles pures de
// stage-progress.js avec des horloges simulées. KaraFun ne donne ni position
// ni durée : temps écoulé mesuré par l'application, durée du catalogue.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const progress = require('../stage-progress');
const { trustedDuration, clientDuration, stageDuration, protocolDuration, protocolPosition,
  pausedOf, rateOf, startClock, observeClock, clockView, sanitizeClock } = progress;

const T0 = 1_800_000_000_000;
const playing = { paused: false, rate: 1, position: null };

test('exports figés du module', () => {
  assert.deepEqual(Object.keys(progress).sort(), ['clientDuration', 'clockView', 'observeClock', 'pausedOf',
    'protocolDuration', 'protocolPosition', 'rateOf', 'sanitizeClock', 'stageDuration', 'startClock', 'trustedDuration']);
});

test('départ : le temps écoulé part du début du titre', () => {
  const clock = startClock('42', T0);
  assert.equal(observeClock(clock, T0, playing), false, 'rien ne change au départ');
  assert.deepEqual(clockView(clock, T0, 237), { elapsedSec: 0, durationSec: 237, paused: false, rate: 1 });
  assert.equal(clockView(clock, T0 + 102_000, 237).elapsedSec, 102);
  assert.equal(clockView(clock, T0 + 1_049, 237).elapsedSec, 1, 'un dixième de seconde près');
  // Horloge du serveur en retard sur le départ : jamais de temps négatif.
  assert.equal(clockView(clock, T0 - 5_000, 237).elapsedSec, 0);
});

test('pause puis reprise : la pause n’est pas comptée et la barre reste figée', () => {
  const clock = startClock('42', T0);
  assert.equal(observeClock(clock, T0 + 60_000, { ...playing, paused: true }), true);
  const frozen = clockView(clock, T0 + 60_000, 200);
  assert.deepEqual(frozen, { elapsedSec: 60, durationSec: 200, paused: true, rate: 1 });
  assert.deepEqual(clockView(clock, T0 + 150_000, 200), frozen, 'pendant la pause, rien n’avance');
  assert.equal(observeClock(clock, T0 + 150_000, { ...playing, paused: true }), false, 'même état : rien à noter');
  assert.equal(observeClock(clock, T0 + 180_000, playing), true);
  assert.equal(clockView(clock, T0 + 190_000, 200).elapsedSec, 70, '60 s avant la pause + 10 s après');
  assert.equal(clockView(clock, T0 + 190_000, 200).paused, false);
});

test('tempo +20 : le titre avance 1,2 fois plus vite à partir du changement', () => {
  const clock = startClock('42', T0);
  observeClock(clock, T0 + 50_000, { ...playing, rate: rateOf(20) });
  assert.equal(clockView(clock, T0 + 50_000, 240).rate, 1.2);
  assert.equal(clockView(clock, T0 + 100_000, 240).elapsedSec, 110, '50 s à 1× puis 50 s à 1,2×');
  // Retour au tempo d'origine : intégré par morceaux.
  observeClock(clock, T0 + 100_000, { ...playing, rate: rateOf(0) });
  assert.equal(clockView(clock, T0 + 110_000, 240).elapsedSec, 120);
});

test('tempo : valeurs aberrantes ramenées dans des limites sûres', () => {
  assert.equal(rateOf(-50), 0.5);
  assert.equal(rateOf(null), 1);
  assert.equal(rateOf('20'), 1, 'seul un nombre de KaraFun compte');
  assert.equal(rateOf(Infinity), 1);
  assert.equal(rateOf(500), 2);
  assert.equal(rateOf(-500), 0.25);
});

test('relance : un nouvel identifiant de file repart de zéro', () => {
  const first = startClock('42', T0);
  assert.equal(clockView(first, T0 + 90_000, 200).elapsedSec, 90);
  const copy = startClock('43', T0 + 90_000);
  assert.equal(clockView(copy, T0 + 90_000, 200).elapsedSec, 0);
  assert.equal(copy.key, '43');
});

test('durée inconnue : seul le temps écoulé est donné', () => {
  const clock = startClock('native', T0);
  assert.deepEqual(clockView(clock, T0 + 30_000, null), { elapsedSec: 30, durationSec: null, paused: false, rate: 1 });
  assert.equal(clockView(clock, T0 + 30_000).durationSec, null);
});

test('durée envoyée par un téléphone : bornée à 30–1200 s (99999 → 1200)', () => {
  assert.equal(clientDuration(99999), 1200);
  assert.equal(clientDuration(3), 30);
  assert.equal(clientDuration(236.6), 237);
  for (const bad of [0, -5, NaN, Infinity, '200', null, undefined, true]) assert.equal(clientDuration(bad), null, String(bad));
});

test('durée de confiance : catalogue ou protocole, sans valeur absurde', () => {
  assert.equal(trustedDuration(362), 362);
  assert.equal(trustedDuration(4), 4, 'les titres très courts de la démo restent possibles');
  assert.equal(trustedDuration(3601), null);
  for (const bad of [0, -1, NaN, '362', null, undefined, {}]) assert.equal(trustedDuration(bad), null, String(bad));
});

test('choix de la durée : démo, puis protocole, puis catalogue, puis téléphone borné', () => {
  assert.equal(stageDuration({ demoSec: 45, protocolSec: 200, catalogSec: 237, clientSec: 99999 }), 45);
  assert.equal(stageDuration({ protocolSec: 200, catalogSec: 237, clientSec: 99999 }), 200);
  assert.equal(stageDuration({ catalogSec: 237, clientSec: 99999 }), 237, 'le catalogue passe avant le téléphone');
  assert.equal(stageDuration({ catalogSec: null, clientSec: 99999 }), 1200);
  assert.equal(stageDuration({}), null);
  assert.equal(stageDuration(), null);
});

test('protocole : position et durée numériques prises si KaraFun les envoie un jour', () => {
  assert.equal(protocolDuration({ current: { duration: 210 } }), 210);
  assert.equal(protocolDuration({ songPlaying: { duration: 190 } }), 190);
  assert.equal(protocolDuration({ duration: 180 }), 180);
  assert.equal(protocolDuration({ current: {} }, { current: { song: { duration: 205 } } }), 205);
  // Trames réelles du bar (2 octobre) : ni position ni durée.
  assert.equal(protocolDuration({ current: { id: 'a', song: { id: 1 } }, state: 'playing', pitch: 0, tempo: 0 }), null);
  assert.equal(protocolDuration(null, null), null);
  assert.equal(protocolPosition({ position: 12 }), 12);
  assert.equal(protocolPosition({ position: -1 }), null);
  assert.equal(protocolPosition({ position: '12' }), null);
  assert.equal(protocolPosition(null), null);
});

test('position du protocole : le temps écoulé se recale sur chaque nouvelle valeur', () => {
  const clock = startClock('7', T0);
  assert.equal(observeClock(clock, T0, { ...playing, position: 0 }), true);
  assert.equal(observeClock(clock, T0 + 2_000, { ...playing, position: 0 }), false, 'même instantané : rien ne bouge');
  assert.equal(clockView(clock, T0 + 2_000, 45).elapsedSec, 2);
  assert.equal(observeClock(clock, T0 + 25_000, { ...playing, position: 20 }), true);
  assert.equal(clockView(clock, T0 + 26_000, 45).elapsedSec, 21);
});

test('pause signalée par KaraFun : état texte ou état 5 de la télécommande KCS', () => {
  assert.equal(pausedOf({ state: 'paused' }), true);
  assert.equal(pausedOf({ state: 'Pause' }), true);
  assert.equal(pausedOf({ state: 'idle', kcsState: 5 }), true);
  assert.equal(pausedOf({ state: 'playing', kcsState: 4 }), false);
  assert.equal(pausedOf(null), false);
});

test('sauvegarde : horloge reprise telle quelle, valeurs abîmées ignorées sans erreur', () => {
  const clock = startClock('42', T0);
  observeClock(clock, T0 + 60_000, { ...playing, paused: true });
  const restored = sanitizeClock(JSON.parse(JSON.stringify(clock)));
  assert.deepEqual(restored, clock);
  assert.deepEqual(clockView(restored, T0 + 600_000, 200), clockView(clock, T0 + 600_000, 200));
  for (const bad of [null, 'x', [], { key: 42, segAt: T0, mediaMs: 0, rate: 1, paused: false },
    { key: '', segAt: T0, mediaMs: 0, rate: 1, paused: false },
    { key: 'k'.repeat(201), segAt: T0, mediaMs: 0, rate: 1, paused: false },
    { key: '42', segAt: 'x', mediaMs: 0, rate: 1, paused: false },
    { key: '42', segAt: T0, mediaMs: -1, rate: 1, paused: false },
    { key: '42', segAt: T0, mediaMs: 0, rate: 9, paused: false },
    { key: '42', segAt: T0, mediaMs: 0, rate: 1, paused: 'non' }]) {
    assert.equal(sanitizeClock(bad), null, JSON.stringify(bad));
  }
  // Position abîmée seule : l'horloge reste, la position est oubliée.
  assert.equal(sanitizeClock({ ...clock, position: 'x' }).position, null);
  assert.equal(sanitizeClock({ ...clock, position: 12 }).position, 12);
});
