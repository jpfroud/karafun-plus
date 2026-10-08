'use strict';

// Barre de lecture du titre sur scène. KaraFun ne donne ni position ni durée
// dans ses StatusEvent (trames réelles du bar, 2 octobre) : le temps écoulé
// est mesuré ici, morceau par morceau, et la durée vient du catalogue.
//
// Horloge : { key, segAt, mediaMs, rate, paused, position }. `mediaMs` est le
// temps du titre (en millisecondes de chanson) atteint à `segAt` ; depuis,
// il avance de `rate` par milliseconde, sauf en pause. L'horloge ne change
// qu'aux transitions (pause, tempo, position) : la sauvegarde de la soirée
// n'est pas réécrite à chaque balayage.

const MAX_TRUSTED_SEC = 3600;            // au-delà, la valeur est absurde
const CLIENT_MIN_SEC = 30, CLIENT_MAX_SEC = 1200; // durée venue d'un téléphone
const MIN_RATE = 0.25, MAX_RATE = 2;

const finite = value => typeof value === 'number' && Number.isFinite(value);

// Durée donnée par KaraFun (catalogue, recherche, protocole) ou la démo.
function trustedDuration(value) {
  return finite(value) && value > 0 && value <= MAX_TRUSTED_SEC ? Math.round(value) : null;
}

// Durée envoyée par un téléphone avec le titre choisi : non vérifiée, bornée.
function clientDuration(value) {
  if (!finite(value) || value <= 0) return null;
  return Math.min(CLIENT_MAX_SEC, Math.max(CLIENT_MIN_SEC, Math.round(value)));
}

function stageDuration({ demoSec = null, protocolSec = null, catalogSec = null, clientSec = null } = {}) {
  return trustedDuration(demoSec) ?? trustedDuration(protocolSec) ?? trustedDuration(catalogSec) ?? clientDuration(clientSec);
}

// Si KaraFun envoie un jour une durée numérique du titre en cours.
function protocolDuration(status, rawStatus = null) {
  const current = status?.current || status?.songPlaying || null;
  return trustedDuration(current?.duration) ?? trustedDuration(current?.song?.duration) ??
    trustedDuration(status?.duration) ?? trustedDuration(rawStatus?.current?.song?.duration);
}

// Position en secondes (faux KaraFun de la démo : instantané à l'envoi).
function protocolPosition(status) {
  const position = status?.position;
  return finite(position) && position >= 0 ? position : null;
}

function pausedOf(status) {
  return /^(paused|pause)$/i.test(String(status?.state || '')) || status?.kcsState === 5;
}

// Tempo de KaraFun en pourcentage (-50 à +50) : vitesse de lecture du titre.
function rateOf(tempo) {
  if (!finite(tempo)) return 1;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, 1 + tempo / 100));
}

function startClock(key, startAt) {
  return { key: String(key), segAt: startAt, mediaMs: 0, rate: 1, paused: false, position: null };
}

const mediaAt = (clock, now) => clock.mediaMs + (clock.paused ? 0 : Math.max(0, now - clock.segAt) * clock.rate);

// État observé de KaraFun à `now`. Vrai si l'horloge a changé.
function observeClock(clock, now, { paused = false, rate = 1, position = null } = {}) {
  if (position !== null && position !== clock.position) {
    Object.assign(clock, { position, mediaMs: position * 1000, segAt: now, paused, rate });
    return true;
  }
  if (paused === clock.paused && rate === clock.rate) return false;
  Object.assign(clock, { mediaMs: mediaAt(clock, now), segAt: now, paused, rate });
  return true;
}

// Vue envoyée aux pages, calculée à `now` (temps du titre, en secondes).
function clockView(clock, now, durationSec = null) {
  return { elapsedSec: Math.round(mediaAt(clock, now) / 100) / 10, durationSec: durationSec ?? null,
    paused: clock.paused, rate: clock.rate };
}

// Reprise après redémarrage : une horloge abîmée est oubliée, jamais la soirée.
function sanitizeClock(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { key, segAt, mediaMs, rate, paused, position } = value;
  if (typeof key !== 'string' || !key || key.length > 200 || !finite(segAt) || !finite(mediaMs) || mediaMs < 0 ||
    !finite(rate) || rate < MIN_RATE || rate > MAX_RATE || typeof paused !== 'boolean') return null;
  return { key, segAt, mediaMs, rate, paused, position: finite(position) && position >= 0 ? position : null };
}

module.exports = { trustedDuration, clientDuration, stageDuration, protocolDuration, protocolPosition,
  pausedOf, rateOf, startClock, observeClock, clockView, sanitizeClock };
