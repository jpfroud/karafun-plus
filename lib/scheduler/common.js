'use strict';
// Constantes et petites aides du planificateur (scheduler.js et ses parties
// dans lib/scheduler/).
const crypto = require('crypto');
const { TimefoldBridge } = require('../../solver/bridge');
const { PLAYED_LIMIT } = require('../../song-repeats');

const DEFAULTS = {
  gap: 4,               // espacement visé entre deux chanteurs d'une même table
  cap: 2,               // reculs max pendant une attente
  protectTop: 5,        // les N prochains ne bougent jamais
  requirePresence: false, // confirmation « je suis là » obligatoire quand on approche
  tableRotation: false,  // parts égales entre tables (sinon au prorata des chanteurs)
  weightedTables: false, // compromis : part proportionnelle à la racine du nombre de chanteurs
  interleaveArrivals: true, // une table arrivée d'un coup est intercalée avec la rotation en cours
  roundAppearanceCap: 2, // passages sur scène max par personne et par tour (0 : sans limite)
  spacingSongs: 3,      // autres chansons voulues entre deux passages d'une même personne
  presenceWindow: 3,    // on demande la confirmation dans les N prochains
  defaultSlotSec: 240,  // durée moyenne d'un passage avant mesure réelle
  solverEnabled: false,  // activé par le serveur quand le solveur Java est empaqueté
  solverSettleMs: 1000,  // regroupement des changements rapprochés avant Timefold
  continuousSolver: true, // file inchangée : Timefold continue de chercher un meilleur ordre
  solverRefinePauseMs: 2000, // pause entre deux passes d'optimisation continue
};

// Niveau de bonus → facteur de fréquence. +2 : une fois et demie plus de
// passages ; -3 : un tour sur deux. Le niveau 0 est neutre.
const BONUS_WEIGHTS = Object.freeze({ '-3': 0.5, '-2': 2 / 3, '-1': 0.8, 0: 1, 1: 1.25, 2: 1.5, 3: 2 });
const bonusWeight = level => BONUS_WEIGHTS[String(Number(level) || 0)] || 1;
const HISTORY_LIMIT = 120;
// « Pas prêt » : au plus cinq chansons de report pour un même passage.
// « Pas prêt » : un titre laisse passer au plus DEFER_MAX chansons en tout.
const DEFER_MAX = 5;
const DEFER_MIN_SLOT_SEC = 180;   // durée minimale d'une chanson pour le délai de secours
const DEFER_SLOTS_PER_SONG = 2;   // délai de secours : deux chansons par place laissée
const DEFER_GRACE_MS = 120000;
const DUET_JOIN_MAX = 5;          // demandes de duo en attente sur un même titre
const INBOX_MAX = 10;             // messages gardés par personne
const INBOX_TTL_MS = 30 * 60 * 1000; // un message plus ancien n'est plus montré
const CONFIRM_MS = 30 * 60 * 1000; // durée d'un « Je suis là »
const VIEW_CACHE_MAX = 8;         // prévisions gardées par état (arguments distincts)
const EPS = 1e-9;

const id = () => crypto.randomBytes(6).toString('hex');
const token = () => crypto.randomBytes(16).toString('hex');
const overlaps = (a, b) => a.some(x => b.includes(x));
// Score « 0hard/-1500medium/-30soft » : gain réel si le niveau dur ou moyen
// progresse (le niveau doux ne mesure que la stabilité de l'ordre).
const parseSolverScore = text => {
  const match = /(-?\d+)hard\/(-?\d+)medium\/(-?\d+)soft/.exec(String(text || ''));
  return match ? match.slice(1, 3).map(Number) : null;
};
const solverScoreGain = (seedScore, score) => {
  const before = parseSolverScore(seedScore), after = parseSolverScore(score);
  if (!before || !after) return false;
  return after[0] > before[0] || (after[0] === before[0] && after[1] > before[1]);
};
const plainSolverError = message => message == null ? null :
  String(message).replace(/\bTimefold\b/gi, 'd’optimisation').replace(/^\w+(Exception|Error): /, '');

module.exports = { crypto, TimefoldBridge, PLAYED_LIMIT, DEFAULTS, BONUS_WEIGHTS, bonusWeight, HISTORY_LIMIT, DEFER_MAX, DEFER_MIN_SLOT_SEC, DEFER_SLOTS_PER_SONG, DEFER_GRACE_MS, DUET_JOIN_MAX, INBOX_MAX, INBOX_TTL_MS, CONFIRM_MS, VIEW_CACHE_MAX, EPS, id, token, overlaps, parseSolverScore, solverScoreGain, plainSolverError };
