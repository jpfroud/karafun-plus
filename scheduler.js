'use strict';
/*
 * Règles de la file d'attente (logique pure, sans réseau).
 *
 * - Un ticket par chanteur. On entre dans la file quand on choisit sa 1re chanson.
 * - Nouveau : au milieu de la file, jamais dans les 5 prochains, derrière les nouveaux
 *   des autres tables qui attendent encore leur 1re chanson. Les chanteurs d'une même
 *   table sont espacés (au moins `gap` places quand c'est possible).
 * - Personne ne recule de plus de `cap` places pendant une même attente, et jamais une
 *   fois dans la 1re moitié de la file (place garantie).
 * - Après avoir chanté : retour en fin de file.
 * - Chaque chanteur prêt passe une fois par tour ; parmi eux, on sert d'abord
 *   les tables qui n'ont pas encore chanté pendant ce tour.
 * - Avant tout deuxième passage physique, servir les premiers passages prêts
 *   (un invité de duo compte comme déjà entendu mais garde son ticket).
 * - Le prochain chanteur annoncé peut être réservé : seul le bar, son retrait
 *   ou son indisponibilité peuvent changer cette annonce.
 * - Pas de chanson prête à son tour : on garde sa place, les suivants passent ; dès qu'on
 *   choisit, on passe au prochain tour. Jamais de cumul (un seul ticket).
 * - Duo : le partenaire accepte l'invitation ; seul l'initiateur dépense son
 *   ticket. Le partenaire garde son titre, avec deux passages de répit si possible.
 * - Présence sur scène : au plus deux passages par personne et par tour, quel
 *   que soit son rôle (son titre ou invitée d'un duo) ; au-delà, le duo attend
 *   le tour suivant. Au moins trois autres chansons entre deux passages d'une
 *   même personne quand un autre passage du tour le permet.
 * - Table plafonnée à son nombre de personnes (anti faux noms / navigation privée).
 * - Dans un tour, les tables se partagent les passages selon le mode : au
 *   prorata des chanteurs (par défaut), à parts égales, ou entre les deux.
 *   La même table ne reprend pas le micro quand une autre peut chanter.
 * - Le bar peut accorder un bonus ou un malus (niveaux -3 à +3) à une table
 *   ou à une personne : il change la fréquence de passage, jamais la priorité
 *   des premiers passages. Les clients ne le voient pas.
 */
const crypto = require('crypto');
const { TimefoldBridge } = require('./solver/bridge');
const { PLAYED_LIMIT } = require('./song-repeats');

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

class Scheduler {
  constructor(opts = {}) {
    this.opts = Object.assign({}, DEFAULTS, opts);
    this.people = new Map();  // personId -> personne
    this.byToken = new Map(); // token -> personId
    this.tables = new Map();  // tableId -> table
    this.Q = [];              // ordre de passage (personIds)
    this.lastGroup = null;    // groupe (table) de la dernière chanson envoyée
    this.roundGroups = new Set(); // groupes déjà servis dans le tour courant
    this.roundPeople = new Set(); // personnes déjà montées sur scène dans le tour, invitées comprises
    this.manualOrder = [];    // ordre explicite du bar pour les chansons encore dans le helper
    this.manualOrderActive = false; // préfixe déplacé volontairement, valable jusqu'au prochain changement de titres
    this.manualChanges = [];  // interventions du bar encore annulables, de la plus ancienne à la plus récente
    this.tableServeCounts = new Map(); // passages par groupe (historique, affichage)
    this.recentGroups = [];   // groupes des derniers passages, pour le partage entre tables
    this.roundUse = new Map(); // crédit de tour consommé par les personnes avec bonus/malus
    this.roundApps = new Map(); // passages sur scène de chaque personne dans le tour, invitées comprises
    this.roundOwed = new Set(); // privées de passage par le plafond au tour précédent : en tête du tour
    this.duetCooldowns = new Map(); // invité : nombre d'autres chansons à laisser passer
    this.reservedNext = null; // personne annoncée comme prochain passage, hors KaraFun
    this.stageHistory = [];   // derniers passages sur scène (bar uniquement)
    this.playedSongs = [];    // titres lancés dans KaraFun, y compris hors file, pour les doublons
    this.log = [];            // journal visible par tous
    this.slotSamples = [];    // durées réelles mesurées (s)
    this.version = 0;
    this.appearanceSerial = 0; // passages physiques, invités de duo compris
    this.solverBridge = this.opts.solverEnabled ? new TimefoldBridge() : null;
    // Plan adopté (Timefold ou ordre manuel du bar) : un classement des titres
    // prêts, valable tant que l'état de la file n'a pas changé autrement que
    // par le passage attendu de sa tête.
    this.solverPlan = null;
    this.solverRequestedFingerprint = null;
    this.solverPendingFingerprint = null;
    this.solverPendingRequestId = null;
    this.solverPendingSince = 0;
    this.solverPendingBudgetMs = 0;
    this.solverPromise = null;
    this.solverLastError = null;
    this.solverLastRun = null;
    this.solverForced = null;
    // Optimisation continue : passes successives sur une file inchangée.
    this.solverRefine = null;       // passe en cours
    this.solverRefineTimer = null;
    this.solverRefineAt = null;     // heure de la prochaine passe
    this.solverRefineStats = { fingerprint: null, runs: 0, improvements: 0, fruitless: 0 };
  }

  // ------------------------------------------------------------------ bonus
  // Réglage réservé au bar : jamais exposé aux pages clients.
  bonusLevel(value) {
    const level = Number(value);
    if (!Number.isInteger(level) || level < -3 || level > 3) throw new Error('Le bonus doit être un niveau de -3 à +3.');
    return level;
  }

  setTableBonus(tableId, level) {
    const t = this.table(tableId, false);
    if (!t) throw new Error('Table inconnue.');
    t.bonus = this.bonusLevel(level);
    this.version++;
    return t;
  }

  setPersonBonus(personId, level) {
    const p = this.people.get(String(personId));
    if (!p) throw new Error('Chanteur inconnu.');
    p.bonus = this.bonusLevel(level);
    this.version++;
    return p;
  }

  _roundCap() {
    const cap = Number(this.opts.roundAppearanceCap);
    return Number.isInteger(cap) && cap >= 0 && cap <= 10 ? cap : DEFAULTS.roundAppearanceCap;
  }

  _spacing() {
    const spacing = Number(this.opts.spacingSongs);
    return Number.isInteger(spacing) && spacing >= 0 && spacing <= 10 ? spacing : DEFAULTS.spacingSongs;
  }

  tableWeight(group) {
    const person = [...this.people.values()].find(p => p.group === group);
    const tableId = person ? person.tableId : group;
    return bonusWeight(this.tables.get(tableId)?.bonus);
  }

  personWeight(pid) {
    const p = this.people.get(pid);
    if (!p) return 1;
    return bonusWeight(p.bonus) * bonusWeight(this.tables.get(p.tableId)?.bonus);
  }

  // Un passage consomme 1/poids de crédit de tour. Sans bonus ni malus, cela
  // revient exactement à « une fois par tour » (ensemble roundPeople).
  _useRound(roundPeople, roundUse, pid) {
    const cost = 1 / this.personWeight(pid);
    if (Math.abs(cost - 1) < EPS && !roundUse.has(pid)) { roundPeople.add(pid); return; }
    const used = (roundUse.get(pid) || 0) + cost;
    roundUse.set(pid, used);
    if (used >= 1 - EPS) roundPeople.add(pid);
  }

  // Nouveau tour : chacun récupère un crédit. Un malus reporte sa dette et
  // peut laisser passer un tour ; un bonus non utilisé ne se cumule pas.
  _resetRound(roundPeople, roundUse, roundApps = null) {
    roundPeople.clear();
    roundApps?.clear();
    for (const [pid, used] of [...roundUse]) {
      const left = used - 1;
      if (left <= EPS) roundUse.delete(pid);
      else {
        roundUse.set(pid, left);
        if (left >= 1 - EPS) roundPeople.add(pid);
      }
    }
  }

  // ------------------------------------------------------------------ journal
  note(msg, kind = 'info') {
    this.log.push({ t: Date.now(), msg, kind });
    if (this.log.length > 300) this.log.shift();
    this.version++;
  }

  invalidateManualOrder() {
    this.manualOrder = [];
    this.manualOrderActive = false;
    this.manualChanges = [];
  }

  // `deferrals` : pour une intervention du bar, les reports « Pas prêt »
  // qu'un déplacement lève et qu'une annulation doit rendre.
  manualOverrideState({ deferrals = false } = {}) {
    const state = { manualOrder: [...this.manualOrder], manualOrderActive: this.manualOrderActive,
      reservedNext: this.reservedNext ? { ...this.reservedNext } : null };
    if (deferrals) state.deferrals = this._deferredOwners().map(pid => [pid, { ...this.people.get(pid).deferral }]);
    return state;
  }

  // `deferrals` : seule une annulation du bar rend les reports levés ; le
  // recalcul des empreintes ne doit jamais les rétablir.
  restoreManualOverride(state, { deferrals = false } = {}) {
    this.manualOrder = [...state.manualOrder];
    this.manualOrderActive = !!state.manualOrderActive && this.manualOrder.length > 0;
    this.reservedNext = state.reservedNext ? { ...state.reservedNext } : null;
    if (!deferrals || !Array.isArray(state.deferrals)) return;
    for (const [pid, deferral] of state.deferrals) {
      const p = this.people.get(pid);
      if (p && !p.withdrawnAt && p.song?.entryId === deferral.entryId && !p.deferral) p.deferral = { ...deferral };
    }
  }

  // Les notes, photos et noms peuvent changer sans modifier la file. Cette
  // empreinte ne couvre que les données qui déterminent les places prévues.
  manualContextFingerprint() {
    const people = this.Q.map(pid => {
      const p = this.people.get(pid);
      return p ? [pid, p.group, p.withdrawnAt, p.sung, p.duetGuestCount || 0,
        p.lastAppearanceTurn || 0, this._isPresenceRetry(p), this._deferralKey(p),
        p.over, p.held, p.song?.entryId || null, p.song?.duet || null,
        (p.backlog || []).map(song => [song.entryId, song.duet || null])] : [pid];
    });
    const context = { people, Q: this.Q, lastGroup: this.lastGroup,
      roundGroups: [...this.roundGroups], roundPeople: [...this.roundPeople],
      roundUse: [...this.roundUse], roundApps: [...this.roundApps], roundOwed: [...this.roundOwed],
      recentGroups: this.recentGroups.slice(-40),
      tableServeCounts: [...this.tableServeCounts], duetCooldowns: [...this.duetCooldowns],
      opts: this.opts, appearanceSerial: this.appearanceSerial, bonus: this._bonusContext(),
      ...this.manualOverrideState() };
    return crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex');
  }

  _bonusContext() {
    return [[...this.tables.values()].filter(t => t.bonus).map(t => [t.id, t.bonus]),
      [...this.people.values()].filter(p => p.bonus).map(p => [p.id, p.bonus])];
  }

  // Empreinte de tout ce qui détermine l'ordre prévu. Les heures, reculs,
  // confirmations, notes et photos n'y figurent pas : la fin d'une chanson ou
  // une inscription sans titre ne relancent donc pas Timefold.
  solverContextFingerprint() {
    const readyQ = this.Q.filter(pid => {
      const p = this.people.get(pid);
      return p && !p.withdrawnAt && this.songsOf(p).length > 0;
    });
    const relevant = new Set();
    const entries = readyQ.map(pid => {
      const p = this.people.get(pid);
      relevant.add(pid);
      const songs = this.songsOf(p);
      for (const song of songs) {
        if (song.duet?.state === 'accepted') relevant.add(song.duet.partnerId);
      }
      return [pid, p.group, p.sung, p.duetGuestCount || 0,
        p.lastAppearanceTurn || 0, p.readySerial || 0,
        songs.map(song => [song.entryId, song.duet || null])];
    });
    // Un invité sans ticket reste pertinent : son dernier passage physique
    // influence directement le score et la distance de son prochain duo.
    const physical = [...relevant].map(pid => {
      const p = this.people.get(pid);
      return p ? [pid, p.group, p.withdrawnAt, p.sung, p.duetGuestCount || 0,
        p.lastAppearanceTurn || 0, this._isPresenceRetry(p), this._deferralKey(p)] : [pid];
    });
    const context = { entries, physical, lastGroup: this.lastGroup,
      roundGroups: [...this.roundGroups], roundPeople: [...this.roundPeople],
      roundUse: [...this.roundUse], roundApps: [...this.roundApps], roundOwed: [...this.roundOwed],
      recentGroups: this.recentGroups.slice(-HISTORY_LIMIT),
      duetCooldowns: [...this.duetCooldowns],
      rotation: [!!this.opts.tableRotation, !!this.opts.weightedTables, this.opts.interleaveArrivals !== false],
      appearanceSerial: this.appearanceSerial, bonus: this._bonusContext(),
      ...this.manualOverrideState() };
    return crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex');
  }

  canUndoManualChange(nativeFingerprint) {
    const latest = this.manualChanges.at(-1);
    return !!latest && latest.native === nativeFingerprint &&
      latest.after === this.manualContextFingerprint();
  }

  recordManualChange({ kind, personId, name, from, to, before, native, planBefore = this._planBeforeManual }) {
    const change = { id: id(), kind, personId, name, from, to, at: Date.now(),
      before, after: this.manualContextFingerprint(), native, planBefore: planBefore || null };
    this._planBeforeManual = null;
    this.manualChanges.push(change);
    return change;
  }

  _planSnapshot() {
    const plan = this.solverPlan;
    if (!plan?.ranks || plan.fingerprint === undefined) return null;
    return { source: plan.source || 'timefold', fingerprint: plan.fingerprint,
      order: [...plan.ranks].sort((a, b) => a[1] - b[1]).map(([entry]) => entry) };
  }

  // Revenir sur une intervention redonne aussi l'ordre affiché avant elle.
  _restorePlan(snapshot) {
    this.solverPlan = snapshot && Array.isArray(snapshot.order) ? { version: this.version,
      fingerprint: snapshot.fingerprint, source: snapshot.source,
      ranks: new Map(snapshot.order.map((entry, index) => [entry, index])) } : null;
  }

  undoLastManualChange(changeId, nativeFingerprint) {
    const latest = this.manualChanges.at(-1);
    if (!latest) throw new Error('Aucun changement manuel à annuler.');
    if (changeId && latest.id !== changeId) {
      throw new Error('Annule d’abord le changement manuel le plus récent.');
    }
    if (!this.canUndoManualChange(nativeFingerprint)) {
      this.manualChanges = [];
      throw new Error('La file a changé depuis cette intervention ; elle ne peut plus être annulée sans déplacer d’autres titres.');
    }
    this.restoreManualOverride(latest.before, { deferrals: true });
    this._restorePlan(latest.planBefore);
    this.manualChanges.pop();
    this.note(`Le bar a annulé ${latest.kind === 'priority' ? 'la priorité' : 'le déplacement'} de ${latest.name}`, 'staff');
    return latest;
  }

  undoAllManualChanges(nativeFingerprint) {
    if (!this.manualChanges.length) throw new Error('Aucun changement manuel à annuler.');
    if (!this.canUndoManualChange(nativeFingerprint)) {
      this.manualChanges = [];
      throw new Error('La file a changé depuis ces interventions ; leur annulation globale n’est plus possible.');
    }
    const count = this.manualChanges.length;
    this.restoreManualOverride(this.manualChanges[0].before, { deferrals: true });
    this._restorePlan(this.manualChanges[0].planBefore);
    this.manualChanges = [];
    this.note(`Le bar a annulé ${count} changement${count > 1 ? 's' : ''} manuel${count > 1 ? 's' : ''} dans la file`, 'staff');
    return count;
  }

  // ------------------------------------------------------------------ tables
  table(tableId, create = true) {
    const key = String(tableId).trim().slice(0, 20);
    if (!this.tables.has(key) && create) {
      this.tables.set(key, { id: key, name: /^\d+$/.test(key) ? `Table ${key}` : key, headcount: null, individual: /^comptoir/i.test(key), createdAt: Date.now() });
    }
    return this.tables.get(key);
  }

  setHeadcount(tableId, n, by = 'staff') {
    const t = this.table(tableId);
    const v = Math.max(1, Math.min(40, parseInt(n, 10) || 1));
    t.headcount = v;
    this.note(`${t.name} : ${v} personne${v > 1 ? 's' : ''} (${by === 'staff' ? 'réglé par le bar' : 'déclaré par la table'})`);
    return t;
  }

  renameTable(tableId, name) {
    const t = this.table(tableId, false);
    if (!t) throw new Error('Table inconnue.');
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 40) throw new Error('Le nom de table doit contenir de 1 à 40 caractères.');
    if ([...this.tables.values()].some(other => other.id !== t.id &&
        other.name.toLocaleLowerCase('fr') === clean.toLocaleLowerCase('fr'))) {
      throw new Error('Ce nom est déjà utilisé par une autre table.');
    }
    if (t.name !== clean) {
      const before = t.name;
      t.name = clean;
      this.note(`${before} s'appelle maintenant ${clean}`, 'staff');
    }
    return t;
  }

  tableSingers(tableId) {
    return [...this.people.values()].filter(p => p.tableId === tableId);
  }

  tableLeft(tableId) {
    const t = this.table(tableId, false);
    if (!t) return;
    const gone = this.tableSingers(tableId);
    gone.forEach(p => this._drop(p, false));
    this.tables.delete(tableId);
    this.note(`${t.name} est partie : ${gone.length} ticket${gone.length > 1 ? 's' : ''} retiré${gone.length > 1 ? 's' : ''}`);
  }

  // ------------------------------------------------------------------ personnes
  join({ tableId, name, photo, headcount }) {
    const t = this.table(tableId);
    name = this.validName(name, t.id);
    if (t.headcount == null && !t.individual) {
      if (!headcount) { const e = new Error('Combien êtes-vous à la table ?'); e.code = 'NEED_HEADCOUNT'; throw e; }
      this.setHeadcount(t.id, headcount, 'table');
    }
    // Le groupe des solistes n'a pas de nombre de places : chaque inscription
    // passe par une invitation du bar. Les tables ordinaires gardent leurs
    // fiches historiques pour éviter le retour frauduleux comme « nouveau ».
    const count = this.tableSingers(t.id).length;
    if (!t.individual && count >= t.headcount) {
      const e = new Error(`${t.name} a déjà ${count} chanteur${count > 1 ? 's' : ''} inscrit${count > 1 ? 's' : ''} pour ${t.headcount} personne${t.headcount > 1 ? 's' : ''}. Si vous êtes plus nombreux, demande au bar d'ajuster.`);
      e.code = 'TABLE_FULL';
      throw e;
    }
    const p = {
      id: id(), token: token(), name, tableId: t.id, photo: photo || null,
      joinedAt: Date.now(), song: null, backlog: [], sung: 0, over: 0, held: 0,
      confirmedAt: 0, duet: null, duetOf: null, invite: null, lastSeen: Date.now(),
      privateNote: '', verifiedAt: 0, withdrawnAt: null, lastAppearanceTurn: 0,
    };
    p.group = t.individual ? `${t.id}#${p.id}` : t.id;
    this.people.set(p.id, p);
    this.byToken.set(p.token, p.id);
    this.note(`${p.name} (${t.name}) s'est inscrit`);
    return p;
  }

  person(tok) {
    const pid = this.byToken.get(tok);
    return pid ? this.people.get(pid) : null;
  }

  validName(name, tableId, exceptId = null) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('Indique ton prénom.');
    if (clean.length > 24) throw new Error('Prénom limité à 24 caractères.');
    if ([...this.people.values()].some(p => p.tableId === tableId && p.id !== exceptId &&
        p.name.toLocaleLowerCase('fr') === clean.toLocaleLowerCase('fr'))) {
      const e = new Error('Ce prénom est déjà inscrit à cette table. Utilise la fiche existante ou précise le nom.');
      e.code = 'NAME_TAKEN'; throw e;
    }
    return clean;
  }

  rename(p, name) {
    const next = this.validName(name, p.tableId, p.id);
    if (next === p.name) return p;
    const before = p.name;
    p.name = next;
    this.note(`${before} (${this.table(p.tableId).name}) s'appelle maintenant ${next}`);
    return p;
  }

  // `note` absent : repère inchangé. `verified` absent : la vérification
  // reste tant que le texte ne change pas ; un autre texte est à revérifier,
  // sauf s'il est vérifié dans le même appui.
  staffIdentify(personId, note, verified) {
    const p = this.people.get(String(personId));
    if (!p) throw new Error('Chanteur inconnu.');
    const clean = note === undefined ? (p.privateNote || '') : String(note || '').replace(/\s+/g, ' ').trim();
    if (clean.length > 140) throw new Error('Description limitée à 140 caractères.');
    const changed = clean !== (p.privateNote || '');
    p.privateNote = clean;
    if (verified === true) p.verifiedAt = !changed && p.verifiedAt ? p.verifiedAt : Date.now();
    else if (verified === false || changed) p.verifiedAt = 0;
    // Les notes privées ne vont jamais dans le journal public.
    this.version++;
    return p;
  }

  leave(p) {
    // L'identité et l'historique des passages survivent au retrait. On ne
    // peut donc pas recréer un « nouveau » chanteur avec le même QR de table.
    this._removeDuetsForPerson(p, true);
    p.song = null; p.backlog = []; p.withdrawnAt = Date.now();
    p.presenceRetry = false; p.presenceSkips = 0; p.maybeGone = null; p.deferral = null;
    this._removeFromQ(p.id);
    if (this.reservedNext?.personId === p.id) this.releaseNext();
    this.invalidateManualOrder();
    this.note(`${p.name} a retiré ses chansons ; son identité reste inscrite à la table`);
  }

  _drop(p, notify) {
    // annule les duos liés
    this._removeDuetsForPerson(p, notify);
    this._removeFromQ(p.id);
    if (this.reservedNext?.personId === p.id) this.releaseNext();
    this.people.delete(p.id);
    this.byToken.delete(p.token);
    this.roundPeople.delete(p.id);
    this.roundApps.delete(p.id);
    this.roundOwed.delete(p.id);
    this.duetCooldowns.delete(p.id);
    this.invalidateManualOrder();
    if (![...this.people.values()].some(q => q.group === p.group)) this.roundGroups.delete(p.group);
    this.version++;
  }

  // ------------------------------------------------------------------ chansons
  songsOf(p) {
    return [p.song, ...(p.backlog || [])].filter(Boolean);
  }

  chooseSong(p, song, mode = 'replace') {
    if (!song || !song.songId) throw new Error('Chanson invalide.');
    if (!['append', 'replace'].includes(mode)) throw new Error('Action sur la liste inconnue.');
    const next = { entryId: id(), songId: Number(song.songId), title: String(song.title || '').slice(0, 80), artist: String(song.artist || '').slice(0, 60), img: song.img || null, duration: song.duration || null };
    if (!Number.isSafeInteger(next.songId) || next.songId <= 0 || !next.title) throw new Error('Chanson invalide.');
    if (mode === 'append' && this.songsOf(p).some(s => s.songId === next.songId)) {
      const e = new Error('Cette chanson est déjà dans la liste de ce chanteur.'); e.code = 'ALREADY_LISTED'; throw e;
    }
    if (mode === 'append' && this.songsOf(p).length >= 20) {
      const e = new Error('La liste est limitée à 20 chansons par chanteur.'); e.code = 'LIST_FULL'; throw e;
    }
    this.invalidateManualOrder();
    // Début de l'attente pour ce titre : ceux qui ont chanté avant ne sont pas
    // passés « devant » cette personne (voir la règle anti-série de _pick).
    if (!this.songsOf(p).length) p.readySerial = this.appearanceSerial;
    if (mode === 'append' && p.song) p.backlog.push(next);
    else {
      if (mode === 'replace') {
        p.backlog = [];
      }
      p.song = next;
    }
    p.withdrawnAt = null;
    this._refreshDuetViews();
    if (!this.Q.includes(p.id)) {
      const pos = this._placeNewcomer(p);
      this.note(`${p.name} (${this.table(p.tableId).name}) entre dans la file en ${pos === 0 ? '1re' : (pos + 1) + 'e'} position`);
    } else {
      this.note(`${p.name} a ${mode === 'append' ? 'ajouté à sa liste' : 'choisi'} « ${next.title} »`);
    }
    this.version++;
  }

  removeSong(p, entryId) {
    const key = String(entryId || '');
    if (p.song && p.song.entryId === key) {
      p.song = (p.backlog || []).shift() || null;
    } else {
      const i = (p.backlog || []).findIndex(s => s.entryId === key);
      if (i < 0) throw new Error('Chanson introuvable dans la liste.');
      p.backlog.splice(i, 1);
    }
    this.invalidateManualOrder();
    this._refreshDuetViews();
    if (this.reservedNext?.personId === p.id && !p.song) this.releaseNext();
    this.note(`${p.name} a retiré une chanson de sa liste`);
  }

  reorderSongs(p, entryId, toIndex) {
    const songs = this.songsOf(p);
    const from = songs.findIndex(s => s.entryId === String(entryId || ''));
    const to = Number(toIndex);
    if (from < 0) throw new Error('Chanson introuvable dans cette liste.');
    if (!Number.isInteger(to) || to < 0 || to >= songs.length) throw new Error('Position invalide dans la liste.');
    if (from === to) return;
    this.invalidateManualOrder();
    const [moved] = songs.splice(from, 1);
    songs.splice(to, 0, moved);
    p.song = songs.shift() || null;
    p.backlog = songs;
    this._refreshDuetViews();
    this.note(`${p.name} a réordonné sa liste de chansons`);
  }

  // ------------------------------------------------------------------ duos
  duetInvites(q) {
    const out = [];
    for (const owner of this.people.values()) {
      for (const song of this.songsOf(owner)) {
        if (song.duet?.partnerId === q.id && song.duet.state === 'pending') {
          out.push({ fromId: owner.id, song, entryId: song.entryId });
        }
      }
    }
    return out;
  }

  _refreshDuetViews() {
    // Les données persistantes sont sur les titres : ces trois champs gardent
    // simplement la compatibilité avec les vues et les anciens tests.
    for (const p of this.people.values()) {
      p.duet = p.song?.duet || null;
      p.invite = null;
      p.duetOf = null;
    }
    for (const owner of this.people.values()) {
      for (const song of this.songsOf(owner)) {
        const d = song.duet;
        if (!d) continue;
        const partner = this.people.get(d.partnerId);
        if (!partner) { delete song.duet; continue; }
        if (d.state === 'pending' && !partner.invite) partner.invite = { fromId: owner.id, song, entryId: song.entryId };
        if (d.state === 'accepted' && !partner.duetOf) partner.duetOf = owner.id;
      }
    }
  }

  _removeDuetsForPerson(p, notify) {
    let removed = 0;
    for (const owner of this.people.values()) {
      for (const song of this.songsOf(owner)) {
        // Ses demandes de duo en attente partent avec elle.
        if (Array.isArray(song.duoRequests)) {
          song.duoRequests = song.duoRequests.filter(row => row?.fromId !== p.id);
          if (!song.duoRequests.length) delete song.duoRequests;
        }
        if (!song.duet || (owner.id !== p.id && song.duet.partnerId !== p.id)) continue;
        delete song.duet;
        removed++;
      }
    }
    this._refreshDuetViews();
    if (removed) this.invalidateManualOrder();
    if (removed && notify) this.note(`${removed} duo${removed > 1 ? 's' : ''} annulé${removed > 1 ? 's' : ''} pour ${p.name}`);
  }

  inviteDuet(p, partnerId, song) {
    const q = this.people.get(partnerId);
    if (!q || q.id === p.id) throw new Error('Partenaire introuvable.');
    this.chooseSong(p, song, 'append');
    // Comme un titre solo, un duo est ajouté à la fin de la liste. Une personne
    // peut ensuite réordonner ses titres si elle souhaite le chanter plus tôt.
    const duetSong = this.songsOf(p).at(-1);
    // Le Comptoir est une table physique, mais chaque soliste y est un groupe
    // indépendant : il doit accepter l'invitation comme à une autre table.
    const sameGroup = p.group === q.group;
    duetSong.duet = { partnerId: q.id, state: sameGroup ? 'accepted' : 'pending' };
    this._refreshDuetViews();
    this.note(sameGroup ?
      `${p.name} a prévu un duo avec ${q.name} sur « ${duetSong.title} »` :
      `${p.name} invite ${q.name} en duo sur « ${duetSong.title} »`);
    return duetSong;
  }

  answerDuet(q, accept, entryId) {
    const invitations = this.duetInvites(q);
    if (!entryId && invitations.length > 1) throw new Error('Choisis l’invitation à laquelle répondre.');
    const inv = entryId ? invitations.find(x => x.entryId === String(entryId)) : invitations[0];
    if (!inv) throw new Error('Pas d\'invitation en cours.');
    const p = this.people.get(inv.fromId);
    const song = inv.song;
    if (!p || song.duet?.partnerId !== q.id || song.duet.state !== 'pending') throw new Error('Invitation expirée.');
    this.invalidateManualOrder();
    if (accept) {
      song.duet.state = 'accepted';
      this.note(`${q.name} accepte le duo avec ${p.name} : seul ${p.name} dépense son tour`);
    } else {
      delete song.duet;
      this.note(`${q.name} décline le duo : ${p.name} chantera en solo`);
    }
    this._refreshDuetViews();
    this.version++;
  }

  _cancelDuet(owner, notify, entryId) {
    const song = entryId ? this.songsOf(owner).find(s => s.entryId === String(entryId)) : this.songsOf(owner).find(s => s.duet);
    const d = song?.duet;
    if (!d) return;
    this.invalidateManualOrder();
    const q = this.people.get(d.partnerId);
    delete song.duet;
    this._refreshDuetViews();
    if (notify) this.note(`Duo annulé (${owner.name}${q ? ' & ' + q.name : ''})`);
    this.version++;
  }

  cancelDuet(p, entryId) {
    const own = entryId ? this.songsOf(p).find(s => s.entryId === String(entryId) && s.duet) : this.songsOf(p).find(s => s.duet);
    if (own) return this._cancelDuet(p, true, own.entryId);
    const inv = this.duetInvites(p).find(x => !entryId || x.entryId === String(entryId));
    if (inv) return this._cancelDuet(this.people.get(inv.fromId), true, inv.entryId);
    throw new Error('Duo introuvable.');
  }

  // `sel` : passage déjà confirmé par KaraFun auquel le bar ajoute l'invité.
  // `inFlight` : passages déjà envoyés à KaraFun, pas encore chantés, où
  // figure l'invité. Si l'un d'eux est retiré de KaraFun, son annulation ne
  // doit pas effacer le passage en duo (voir _keepGuestCredit).
  staffCountPartner(ownerId, partnerId, sel = null, inFlight = []) {
    const owner = this.people.get(String(ownerId)), partner = this.people.get(String(partnerId));
    if (!owner || !partner || owner.id === partner.id || owner.withdrawnAt || partner.withdrawnAt) {
      throw new Error('Choisis un autre chanteur encore présent dans la salle.');
    }
    this.invalidateManualOrder();
    const row = this._creditRow(partner.id), serialBefore = this.appearanceSerial;
    // Reçu d'annulation (duo noté par erreur) : valeurs d'avant le duo, reçus
    // des titres concernés, puis valeurs posées par le duo (voir
    // staffUncountPartner). Sérialisable, il survit à un redémarrage.
    const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
    const record = { ownerId: owner.id, partnerId: partner.id, at: Date.now(), entryId: sel?.song?.entryId || null,
      serialBefore, before: this._duoFields(partner.id),
      creditBefore: sel?.turnCredit && !sel.turnCredit.rolledBack ? clone(sel.turnCredit) : null,
      inFlight: (Array.isArray(inFlight) ? inFlight : []).filter(other => other && other !== sel &&
        other.ids?.includes(partner.id) && other.turnCredit && !other.turnCredit.rolledBack)
        .map(other => ({ entryId: other.song?.entryId || null, creditBefore: clone(other.turnCredit) })) };
    this.duetCooldowns.set(partner.id, 2);
    partner.duetGuestCount = (partner.duetGuestCount || 0) + 1;
    partner.lastAppearanceTurn = owner.lastAppearanceTurn || ++this.appearanceSerial;
    this.roundPeople.add(partner.id);
    this.roundApps.set(partner.id, (this.roundApps.get(partner.id) || 0) + 1);
    this.roundOwed.delete(partner.id);
    if (sel?.turnCredit && !sel.turnCredit.rolledBack) this._addPartnerCredit(sel.turnCredit, partner.id, row, serialBefore);
    for (const other of Array.isArray(inFlight) ? inFlight : []) {
      if (other && other !== sel && other.ids?.includes(partner.id) && other.turnCredit && !other.turnCredit.rolledBack) {
        this._keepGuestCredit(other.turnCredit, partner.id, this.appearanceSerial - serialBefore);
      }
    }
    // Le partenaire vient de monter sur scène : le passage annoncé avec lui
    // juste après est libéré, et la file choisit à nouveau le suivant (avec
    // l'espacement habituel, il chantera plus tard si d'autres attendent).
    const reserved = this.people.get(this.reservedNext?.personId);
    if (reserved && (reserved.id === partner.id || reserved.song?.duet?.partnerId === partner.id)) this.releaseNext();
    record.after = this._duoFields(partner.id);
    record.serialAfter = this.appearanceSerial;
    if (sel) sel.staffDuo = record;
    this.note(`Le bar a compté ${partner.name} en duo avec ${owner.name} : ${owner.name} dépense son tour ; ${partner.name} garde son titre mais attend deux autres chansons si possible`, 'staff');
    return partner;
  }

  // Ce que le duo improvisé change pour l'invité.
  _duoFields(pid) {
    const p = this.people.get(pid);
    return { duetGuestCount: p?.duetGuestCount || 0, lastAppearanceTurn: p?.lastAppearanceTurn || 0,
      cooldown: this.duetCooldowns.has(pid) ? this.duetCooldowns.get(pid) : null,
      inRound: this.roundPeople.has(pid), roundApps: this.roundApps.get(pid) || 0, owed: this.roundOwed.has(pid) };
  }

  // Duo noté par erreur : défait staffCountPartner. Comme rollbackUnplayed,
  // on ne revient que sur une valeur encore égale à celle posée par le duo ;
  // une correction faite depuis prévaut. `sel` : passage du chanteur s'il est
  // encore suivi ; `liveSels` : passages encore suivis dans KaraFun. Un titre
  // de l'invité retiré de KaraFun sans être chanté a déjà défait son envoi :
  // son reçu d'avant envoi sert alors de référence.
  staffUncountPartner(record, sel = null, liveSels = []) {
    const owner = this.people.get(record?.ownerId), partner = this.people.get(record?.partnerId);
    if (!record?.before || !record.after || !partner) throw new Error('Aucun duo noté par le bar sur ce passage.');
    const pid = partner.id;
    const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
    let base = record.before, expectedTurn = record.after.lastAppearanceTurn;
    let rolledBack = false;
    for (const row of record.inFlight || []) {
      const live = (Array.isArray(liveSels) ? liveSels : []).find(item => row.entryId && item?.song?.entryId === row.entryId);
      if (live?.turnCredit && !live.turnCredit.rolledBack) { live.turnCredit = clone(row.creditBefore); continue; }
      const old = row.creditBefore?.before;
      const oldRow = Array.isArray(old?.people) && old.people.find(item => item.id === pid);
      if (rolledBack || !oldRow) continue;
      rolledBack = true;
      base = { duetGuestCount: oldRow.duetGuestCount || 0, lastAppearanceTurn: oldRow.lastAppearanceTurn || 0,
        cooldown: new Map(old.duetCooldowns || []).get(pid) ?? null,
        inRound: (old.roundPeople || []).includes(pid), roundApps: new Map(old.roundApps || []).get(pid) || 0,
        owed: (old.roundOwed || []).includes(pid) };
      // L'annulation de l'envoi a remis le reçu « avant », duo compris.
      expectedTurn = Math.max(oldRow.lastAppearanceTurn || 0, record.after.lastAppearanceTurn || 0);
    }
    this.invalidateManualOrder();
    partner.duetGuestCount = Math.max(0, (partner.duetGuestCount || 0) - 1);
    if ((partner.lastAppearanceTurn || 0) === expectedTurn) partner.lastAppearanceTurn = base.lastAppearanceTurn;
    if (record.serialAfter === record.serialBefore + 1 && this.appearanceSerial === record.serialAfter) this.appearanceSerial = record.serialBefore;
    // Chaque passage envoyé depuis le duo a rapproché les deux répits d'un cran.
    const cooldown = this.duetCooldowns.get(pid);
    if (cooldown !== undefined) {
      const left = base.cooldown == null ? 0 : base.cooldown - (2 - cooldown);
      if (left > 0) this.duetCooldowns.set(pid, left); else this.duetCooldowns.delete(pid);
    }
    // Sans passage compté au tour, un nouveau tour a commencé depuis : rien à rendre.
    const apps = this.roundApps.get(pid) || 0;
    if (apps > 0) {
      if (apps > 1) this.roundApps.set(pid, apps - 1); else this.roundApps.delete(pid);
      if (!base.inRound && (this.roundUse.get(pid) || 0) < 1 - EPS) this.roundPeople.delete(pid);
      if (base.owed) this.roundOwed.add(pid);
    }
    if (sel?.turnCredit && !sel.turnCredit.rolledBack && record.creditBefore) sel.turnCredit = clone(record.creditBefore);
    if (sel) delete sel.staffDuo;
    this._refreshDuetViews();
    this.note(`Le bar a annulé le duo noté de ${owner?.name || 'ce chanteur'} avec ${partner.name}`, 'staff');
    this.version++;
    return partner;
  }

  // Les derniers passages suivent le duo improvisé noté, annulé ou corrigé.
  setStagePeople(entry, ids, kind) {
    if (!entry) return null;
    entry.ids = [...ids];
    entry.names = ids.map(pid => this.people.get(pid)?.name || '?');
    entry.tableIds = ids.map(pid => this.people.get(pid)?.tableId || null);
    entry.kind = kind || (ids.length > 1 ? 'duo' : 'solo');
    this.version++;
    return entry;
  }

  // ------------------------------------------------------------------ actions du chanteur
  confirm(p) {
    p.confirmedAt = Date.now(); p.held = 0;
    p.presenceSkips = 0; p.maybeGone = null;
    this.version++;
  }

  // Un duo est présent dès que l'un des deux a confirmé : l'autre n'a pas à
  // refaire la démarche sur son propre téléphone.
  confirmedForTurn(ids) {
    const people = ids.map(pid => this.people.get(pid));
    if (people.some(p => !p)) return false;
    return !this.opts.requirePresence || people.some(p => this._confirmedRecently(p));
  }

  // « Je suis là » manqué alors que la scène est libre : ce passage laisse
  // passer le suivant et revient juste après lui, avec une nouvelle demande.
  // Au bout de `maxSkips` fois, le titre est retiré et le bar est prévenu que
  // la personne est peut-être partie ; c'est à lui de la marquer partie.
  skipUnconfirmed(personId, maxSkips = 3) {
    const p = this.people.get(personId);
    if (!p || p.withdrawnAt || !p.song) return null;
    const title = p.song.title;
    if (this.reservedNext?.personId === p.id) this.releaseNext();
    p.presenceSkips = this.presenceSkipsOf(p) + 1;
    p.presenceEntryId = p.song.entryId;
    if (p.presenceSkips >= maxSkips) {
      const skips = p.presenceSkips;
      p.presenceSkips = 0;
      p.presenceRetry = false;
      p.maybeGone = { at: Date.now(), title, skips };
      this.removeSong(p, p.song.entryId);
      this.note(`${p.name} n'a pas confirmé sa présence ${skips} fois : « ${title} » est retiré de sa liste. Vérifie si ${p.name} est encore là.`, 'staff');
      return { removed: true, skips, title };
    }
    p.presenceRetry = true;
    this.version++;
    this.note(`${p.name} n'a pas confirmé sa présence : « ${title} » laisse passer le titre suivant et revient juste après (${p.presenceSkips}/${maxSkips})`, 'skip');
    return { removed: false, skips: p.presenceSkips, title };
  }

  // Les manques comptent pour le titre qui a été passé : un titre remplacé,
  // retiré ou nouveau repart de zéro et reprend sa place normale.
  presenceSkipsOf(p) {
    return p?.song && p.presenceEntryId === p.song.entryId ? p.presenceSkips || 0 : 0;
  }

  _isPresenceRetry(p) {
    return !!(p && !p.withdrawnAt && p.presenceRetry && p.song && p.presenceEntryId === p.song.entryId);
  }

  // Titres passés faute de présence, dans l'ordre de la file.
  _presenceRetries() {
    return this.Q.filter(pid => this._isPresenceRetry(this.people.get(pid)));
  }

  clearPresenceRetries() {
    let changed = false;
    for (const p of this.people.values()) if (p.presenceRetry) { p.presenceRetry = false; changed = true; }
    if (changed) this.version++;
  }

  dismissMaybeGone(p) {
    if (!p.maybeGone) return;
    p.maybeGone = null;
    this.note(`Le bar a confirmé que ${p.name} est toujours là`, 'staff');
  }

  // ------------------------------------------------------------------ « Pas prêt »
  // Une personne pas encore prête (toilettes, cigarette…) laisse passer une
  // ou plusieurs chansons sans perdre son tour : son passage attend que
  // `remaining` autres passages soient envoyés, puis devient le prochain
  // annoncé. Le report suit le titre concerné : retiré ou remplacé, il
  // disparaît. Sans autre passage possible, il expire à `until`.
  _isDeferred(p) {
    const d = p?.deferral;
    return !!(d && !p.withdrawnAt && p.song && d.entryId === p.song.entryId && Date.now() < d.until);
  }

  _deferralKey(p) {
    return this._isDeferred(p) ? [p.deferral.remaining, p.deferral.ids || [p.id]] : null;
  }

  // Titres reportés, dans l'ordre de la file.
  _deferredOwners() {
    return this.Q.filter(pid => this._isDeferred(this.people.get(pid)));
  }

  // Personnes absentes d'un passage reporté : ni leur titre ni un duo avec
  // elles ne part tant que le report court.
  _deferredPeople(owners = this._deferredOwners()) {
    return new Set(owners.flatMap(pid => this.people.get(pid)?.deferral?.ids || [pid]));
  }

  // Report qui concerne cette personne, propriétaire du titre ou invitée.
  deferralFor(personId) {
    const pid = String(personId);
    const owner = this._deferredOwners().map(id => this.people.get(id))
      .find(p => p.id === pid || (p.deferral.ids || []).includes(pid));
    return owner ? { ownerId: owner.id, entryId: owner.deferral.entryId, remaining: owner.deferral.remaining,
      total: owner.deferral.total, until: owner.deferral.until } : null;
  }

  // Chansons déjà laissées passer par ce titre, tous reports confondus : le
  // compte suit la chanson, pour que DEFER_MAX vaille pour toute la soirée.
  deferredSongsOf(song) {
    return Math.max(0, Number(song?.deferredSongs) || 0);
  }

  // `passage` : { ids, entryId, song? } du prochain passage de cette personne
  // (`song` pour un titre déjà chargé dans KaraFun). `extra` : passage déjà
  // en route vers KaraFun (envoi sans accusé), qui compterait sinon comme la
  // chanson laissée passer.
  // Vérifie un report sans rien changer (le serveur retire ensuite le titre
  // de KaraFun, puis l'enregistre).
  checkDeferral(ownerId, passage, count = 1) {
    const p = this.people.get(String(ownerId));
    if (!p || p.withdrawnAt) throw new Error('Chanteur inconnu ou parti.');
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > DEFER_MAX) throw new Error(`Repousse ton passage de 1 à ${DEFER_MAX} chansons.`);
    const entryId = String(passage?.entryId || '');
    const ids = Array.isArray(passage?.ids) && passage.ids.length ? passage.ids.map(String) : [p.id];
    if (!entryId || ids[0] !== p.id) throw new Error('Passage introuvable.');
    const song = this.songsOf(p).find(item => item.entryId === entryId) ||
      (passage.song?.entryId === entryId ? passage.song : null);
    if (!song) throw new Error('Passage introuvable.');
    const total = this.deferredSongsOf(song) + n;
    if (total > DEFER_MAX) throw new Error(`Un passage ne peut pas être repoussé de plus de ${DEFER_MAX} chansons.`);
    return { p, n, entryId, ids, song, total };
  }

  deferPassage(ownerId, passage, count = 1, { extra = 0 } = {}) {
    const { p, n, entryId, ids, song, total } = this.checkDeferral(ownerId, passage, count);
    const now = Date.now();
    const current = p.deferral && p.deferral.entryId === entryId && now < p.deferral.until ? p.deferral : null;
    if (this.reservedNext?.personId === p.id) this.releaseNext();
    const remaining = (current ? current.remaining : Math.max(0, Number(extra) || 0)) + n;
    // Filet de sécurité si personne d'autre ne chante : le titre redevient
    // envoyable après environ deux chansons par place laissée.
    const slotMs = Math.max(DEFER_MIN_SLOT_SEC, this.avgSlotSec()) * 1000;
    song.deferredSongs = total;
    p.deferral = { entryId, ids, remaining, total,
      until: now + remaining * DEFER_SLOTS_PER_SONG * slotMs + DEFER_GRACE_MS };
    p.presenceRetry = false;
    this.invalidateManualOrder();
    this.version++;
    const who = ids.map(pid => this.people.get(pid)?.name).filter(Boolean).join(' & ');
    this.note(`${who} n’est pas encore prêt : son passage laisse passer ${n} chanson${n > 1 ? 's' : ''} de plus et garde son tour`, 'skip');
    return p.deferral;
  }

  isDeferred(p) { return this._isDeferred(p); }

  // Report d'un titre précis effacé sans annonce (titre lancé, ou retiré de
  // KaraFun alors que la personne s'est dite prête).
  dropDeferral(ownerId, entryId) {
    const p = this.people.get(String(ownerId));
    if (!p?.deferral || p.deferral.entryId !== entryId) return false;
    p.deferral = null;
    this.version++;
    return true;
  }

  // Titre retiré de KaraFun avant d'être chanté (« Pas prêt », partenaire
  // d'un duo improvisé) : il revient en tête de la liste de son chanteur et
  // son ticket reprend sa place. Un report « Pas prêt » s'applique ensuite.
  requeueUnplayed(sel) {
    this.rollbackUnplayed(sel, { requeue: true });
    const owner = this.people.get(sel.ids[0]);
    if (!owner || owner.withdrawnAt) return null;
    if (!owner.song || owner.song.entryId !== sel.song.entryId) {
      if (owner.song) owner.backlog.unshift(owner.song);
      owner.song = sel.song;
    }
    if (!this.Q.includes(owner.id)) this.Q.push(owner.id);
    this._refreshDuetViews();
    this.invalidateManualOrder();
    this.version++;
    return owner;
  }

  // « Je suis prêt » : le passage reporté redevient envoyable tout de suite.
  cancelDeferral(personId) {
    const found = this.deferralFor(personId);
    const p = found && this.people.get(found.ownerId);
    if (!p) throw new Error('Aucun passage repoussé pour cette personne.');
    p.deferral = null;
    this.invalidateManualOrder();
    this.version++;
    const who = this.people.get(String(personId))?.name || p.name;
    this.note(`${who} est prêt : son passage reprend sa place`, 'info');
    return p;
  }

  // ------------------------------------------------------------------ demandes de duo
  // Une personne qui aime un titre prévu par une autre peut lui demander de
  // le chanter ensemble. L'auteur du titre garde son passage et accepte ou
  // refuse ; à la même table, le duo est direct, comme une invitation.
  _joinRequests(song) {
    const list = Array.isArray(song?.duoRequests) ? song.duoRequests : [];
    return list.filter(row => row && this.people.has(row.fromId) && !this.people.get(row.fromId).withdrawnAt);
  }

  requestDuetJoin(requester, ownerId, entryId) {
    const owner = this.people.get(String(ownerId || ''));
    if (!owner || owner.withdrawnAt) throw new Error('Ce chanteur n’est plus dans la file.');
    if (owner.id === requester.id) throw new Error('C’est déjà ton titre.');
    const song = this.songsOf(owner).find(item => item.entryId === String(entryId || ''));
    if (!song) throw new Error('Ce titre n’est plus en attente : il est peut-être déjà dans KaraFun.');
    if (song.duet) throw new Error('Ce titre est déjà prévu en duo.');
    const requests = this._joinRequests(song);
    if (requests.some(row => row.fromId === requester.id)) throw new Error('Ta demande de duo est déjà envoyée.');
    if (requests.length >= DUET_JOIN_MAX) throw new Error('Plusieurs personnes ont déjà demandé ce duo. Attends la réponse.');
    this.version++;
    if (owner.group === requester.group) {
      song.duet = { partnerId: requester.id, state: 'accepted' };
      delete song.duoRequests;
      this.invalidateManualOrder();
      this._refreshDuetViews();
      this.note(`${requester.name} rejoint ${owner.name} en duo sur « ${song.title} »`);
      return { direct: true, song };
    }
    song.duoRequests = [...requests, { fromId: requester.id, at: Date.now() }];
    this.note(`${requester.name} propose à ${owner.name} de chanter « ${song.title} » en duo`);
    return { direct: false, song };
  }

  answerDuetJoin(owner, entryId, fromId, accept) {
    const song = this.songsOf(owner).find(item => item.entryId === String(entryId || ''));
    const requests = this._joinRequests(song);
    const request = requests.find(row => row.fromId === String(fromId || ''));
    if (!song || !request) throw new Error('Cette demande de duo n’est plus valable.');
    const partner = this.people.get(request.fromId);
    if (accept) {
      if (song.duet) throw new Error('Ce titre est déjà prévu en duo.');
      song.duet = { partnerId: partner.id, state: 'accepted' };
      // Un seul partenaire : les autres demandes sur ce titre sont closes.
      delete song.duoRequests;
      this.invalidateManualOrder();
      this._refreshDuetViews();
      this.note(`${owner.name} accepte de chanter « ${song.title} » avec ${partner.name} : ${owner.name} garde son tour, ${partner.name} garde ses propres titres`);
    } else {
      song.duoRequests = requests.filter(row => row !== request);
      if (!song.duoRequests.length) delete song.duoRequests;
      this.note(`${owner.name} préfère chanter « ${song.title} » sans ${partner.name}`);
    }
    this.version++;
    return song;
  }

  cancelDuetJoin(requester, ownerId, entryId) {
    const owner = this.people.get(String(ownerId || ''));
    const song = owner && this.songsOf(owner).find(item => item.entryId === String(entryId || ''));
    const requests = this._joinRequests(song);
    if (!requests.some(row => row.fromId === requester.id)) throw new Error('Demande de duo introuvable.');
    song.duoRequests = requests.filter(row => row.fromId !== requester.id);
    if (!song.duoRequests.length) delete song.duoRequests;
    this.version++;
    this.note(`${requester.name} retire sa demande de duo à ${owner.name}`);
  }

  // Demandes reçues par l'auteur de titres, et envoyées par une personne.
  duetJoinRequestsFor(owner) {
    return this.songsOf(owner).flatMap(song => this._joinRequests(song).map(row => ({
      entryId: song.entryId, fromId: row.fromId, fromName: this.people.get(row.fromId).name, at: row.at, song })));
  }

  // Toutes les demandes envoyées, par personne : un seul passage sur la file.
  duetJoinRequestsByPerson() {
    const out = new Map();
    for (const owner of this.people.values()) {
      if (owner.withdrawnAt) continue;
      for (const song of this.songsOf(owner)) {
        if (!song.duoRequests) continue;
        for (const row of this._joinRequests(song)) {
          if (!out.has(row.fromId)) out.set(row.fromId, []);
          out.get(row.fromId).push({ ownerId: owner.id, ownerName: owner.name, entryId: song.entryId, song });
        }
      }
    }
    return out;
  }

  duetJoinRequestsBy(requester) {
    return this.duetJoinRequestsByPerson().get(requester.id) || [];
  }

  giveSpot(p, toId) {
    const q = this.people.get(toId);
    if (!q || q.group !== p.group) throw new Error('On ne cède sa place qu\'à quelqu\'un de son groupe.');
    const i = this.Q.indexOf(p.id), j = this.Q.indexOf(q.id);
    if (i < 0) throw new Error('Tu n\'es pas encore dans la file.');
    if (j >= 0 && j < i) throw new Error(`${q.name} est déjà devant toi.`);
    if (j < 0) { // q n'a pas encore de ticket : il prend la place de p, p repart en fin de file
      this.Q[i] = q.id;
      this.Q.push(p.id);
    } else {
      this.Q[i] = q.id; this.Q[j] = p.id;
    }
    this.invalidateManualOrder();
    this.note(`${p.name} cède sa place à ${q.name}`);
  }

  // ------------------------------------------------------------------ actions du bar
  staffMove(personId, toIndex, excludeIds = [], provisional = null) {
    // Les titres supplémentaires d'un même chanteur ont une place prévue mais
    // ne sont pas des tickets indépendants déplaçables par le bar.
    const full = this.presenceView(excludeIds, provisional);
    const visible = full.filter(v => !v.future);
    this._planBeforeManual = this._planSnapshot();
    // L'invité d'un duo peut aussi posséder un solo plus loin dans la file :
    // son bouton Priorité doit viser son propre titre, pas celui du duo.
    const i = visible.findIndex(v => v.ids[0] === personId);
    if (i < 0) { const e = new Error('Cette chanson n’est plus dans la file du helper.'); e.code = 'SONG_SENT'; throw e; }
    const target = Number(toIndex);
    if (!Number.isInteger(target) || target < 0 || target >= visible.length) throw new Error('Place de destination invalide.');
    // Le bar place lui-même ce passage : un report « Pas prêt » est levé.
    const moved = this.people.get(personId);
    if (moved?.deferral) moved.deferral = null;
    const [item] = visible.splice(i, 1);
    visible.splice(target, 0, item);
    // Un titre déjà en cours d'envoi peut encore porter l'ancienne réservation.
    // Réordonner les titres suivants ne doit pas toucher à cette commande.
    if (target === 0 && visible[0]) {
      // Le bar avance explicitement ce passage. Cette dérogation unique peut
      // dépasser l'équité des premiers passages ; l'ordre mémorisé des autres
      // lignes ne le peut pas.
      // `byStaff` : place réservée par le bar, abandonnée avec les autres
      // déplacements manuels quand il relance le calcul de la file.
      this.reservedNext = { personId: visible[0].ids[0], reservedAt: Date.now(), byStaff: true };
      this.version++;
    } else if (this.reservedNext && !excludeIds.includes(this.reservedNext.personId) &&
        visible[0]?.ids[0] !== this.reservedNext.personId) this.releaseNext();
    // Seul le préfixe qui fixe la place demandée passe avant l'équité. Les
    // autres titres restent soumis aux premiers passages et à la rotation.
    this.manualOrder = visible.slice(0, target + 1).map(v => v.ids[0]);
    this.manualOrderActive = this.manualOrder.length > 0;
    this.note(`Le bar a déplacé ${this.people.get(item.ids[0]).name} de la place ${i + 1} à la place ${target + 1}`, 'staff');
    // Une priorité ou un déplacement ne touche qu'une ligne : les autres
    // gardent exactement l'ordre affiché, sans nouveau calcul de Timefold,
    // jusqu'au prochain changement réel de la file ou au bouton Recalculer.
    const order = full.filter(v => v.entryId !== item.entryId).map(v => v.entryId);
    const after = visible[target + 1]?.entryId, before = visible[target - 1]?.entryId;
    const at = after ? order.indexOf(after) : before ? order.indexOf(before) + 1 : 0;
    order.splice(at < 0 ? order.length : at, 0, item.entryId);
    this.solverPlan = { version: this.version, fingerprint: this.solverContextFingerprint(),
      ranks: new Map(order.filter(Boolean).map((entry, index) => [entry, index])), source: 'manual' };
  }

  staffRemove(personId) {
    const p = this.people.get(personId);
    if (!p) return;
    const removed = p.song;
    const changes = this.manualChanges;
    const rebase = changes.length && changes.at(-1).after === this.manualContextFingerprint();
    const hasNextSong = !!(p.backlog || []).length;
    const otherVisible = !hasNextSong && changes.length ?
      this.presenceView().filter(v => !v.future && v.ids[0] !== p.id).map(v => v.ids[0]) : [];
    const adjustState = state => {
      if (hasNextSong) return state;
      const manualOrder = state.manualOrder.filter(pid => pid !== p.id);
      return { manualOrder, manualOrderActive: !!state.manualOrderActive && manualOrder.length > 0,
        reservedNext: state.reservedNext?.personId === p.id ? null : state.reservedNext,
        ...(state.deferrals ? { deferrals: state.deferrals } : {}) };
    };
    const priorStates = rebase ? changes.map(change => adjustState(change.before)) : [];
    if (!hasNextSong && changes.length) {
      // Sans chanson de rechange, l'ancien titre sort de la file. Seules ses
      // priorités disparaissent ; les autres conservent leur ordre visible.
      const hidden = this.manualOrder.filter(pid => pid !== p.id && !otherVisible.includes(pid));
      this.manualOrder = [...otherVisible, ...hidden];
      this.manualOrderActive = this.manualOrderActive && this.manualOrder.length > 0;
      if (this.reservedNext?.personId === p.id) this.releaseNext();
    }
    p.song = (p.backlog || []).shift() || null;
    if (this.reservedNext?.personId === p.id && !p.song) this.releaseNext();
    this._refreshDuetViews();
    if (rebase) {
      // Le titre change sans modifier le ticket ni l'ordre du bar. Recalculer
      // les empreintes garde chaque ancienne intervention annulable.
      const currentState = this.manualOverrideState();
      changes.forEach((change, index) => {
        change.before = priorStates[index];
        this.restoreManualOverride(priorStates[index + 1] || currentState);
        change.after = this.manualContextFingerprint();
      });
      this.restoreManualOverride(currentState);
    }
    // Garder le ticket au même endroit : retirer un titre ne remet pas le
    // chanteur en fin de file, même si le prochain titre devient actif.
    this.note(`Le bar a retiré ${removed ? `« ${removed.title} »` : 'le titre'} de ${p.name}${p.song ? ` ; « ${p.song.title} » prend sa place` : ''}`, 'staff');
  }

  // Retrait d'un titre précis, y compris un titre suivant de la liste d'une
  // personne (sélection multiple dans la page du bar).
  staffRemoveEntry(personId, entryId) {
    const p = this.people.get(String(personId || ''));
    if (!p) throw new Error('Chanteur inconnu.');
    if (!entryId || p.song?.entryId === String(entryId)) return this.staffRemove(p.id);
    const index = (p.backlog || []).findIndex(song => song.entryId === String(entryId));
    if (index < 0) throw new Error('Titre introuvable dans la liste de ce chanteur.');
    const [removed] = p.backlog.splice(index, 1);
    this.invalidateManualOrder();
    this._refreshDuetViews();
    this.note(`Le bar a retiré « ${removed.title} » de la liste de ${p.name}`, 'staff');
  }

  // Remet des personnes en tête (ex. chanson envoyée mais la personne n'était pas là)
  restoreToHead(personIds) {
    this.invalidateManualOrder();
    this.releaseNext();
    personIds.forEach((pid, k) => {
      const i = this.Q.indexOf(pid);
      if (i >= 0) { this.Q.splice(i, 1); this.Q.splice(k, 0, pid); }
    });
    this.version++;
  }

  // ------------------------------------------------------------------ placement
  _removeFromQ(pid) {
    const i = this.Q.indexOf(pid);
    if (i >= 0) this.Q.splice(i, 1);
  }

  // Index du premier ticket dont l'attente n'a pas commencé (il vient de chanter) : un nouveau passe avant lui.
  _justSangIndex() {
    const now = Date.now();
    for (let i = 0; i < this.Q.length; i++) {
      const q = this.people.get(this.Q[i]);
      if (q && (q.waitingSince || 0) > now) return i;
    }
    return this.Q.length;
  }

  _placeNewcomer(p) {
    const n = this.Q.length, now = Date.now();
    const slotMs = this.avgSlotSec() * 1000;
    const hi = this._justSangIndex();
    // « Au milieu » en temps : comme s'il attendait déjà depuis la moitié d'un tour
    const eNew = now - (n * slotMs) / 2;
    let target = 0;
    for (let i = 0; i < hi; i++) { const q = this.people.get(this.Q[i]); if (q && (q.waitingSince || 0) <= eNew) target = i + 1; }
    let lo = Math.max(this.guaranteedCount(), target);
    for (let i = hi - 1; i >= 0; i--) {                // derrière les nouveaux des autres tables qui attendent
      const q = this.people.get(this.Q[i]);
      if (q && q.sung === 0 && q.group !== p.group) { lo = Math.max(lo, i + 1); break; }
    }
    for (let i = n - 1; i >= 0; i--) {                 // jamais devant quelqu'un déjà reculé `cap` fois
      const q = this.people.get(this.Q[i]);
      if (q && q.over >= this.opts.cap) { lo = Math.max(lo, i + 1); break; }
    }
    lo = Math.min(lo, n);
    const top = Math.max(lo, Math.min(hi, n));
    const mates = [];
    this.Q.forEach((pid, i) => { const q = this.people.get(pid); if (q && q.group === p.group) mates.push(i); });
    let j = lo;
    if (mates.length) {                                // étaler les chanteurs d'une même table
      const L = n + 1;
      let best = -1;
      for (let k = lo; k <= top; k++) {
        let d = Infinity;
        for (const m of mates) {
          const mm = m + (m >= k ? 1 : 0);
          const dd = Math.abs(k - mm);
          d = Math.min(d, dd, L - dd);
        }
        if (d >= this.opts.gap) { j = k; break; }
        if (d > best) { best = d; j = k; }
      }
    }
    for (let k = j; k < n; k++) { const q = this.people.get(this.Q[k]); if (q && (q.waitingSince || 0) <= now) q.over++; }
    this.Q.splice(j, 0, p.id);
    p.over = 0;
    p.waitingSince = now;
    this.version++;
    return j;
  }

  // ------------------------------------------------------------------ sélection
  isReady(p) {
    if (!p || !p.song) return false;
    if (p.duet && p.duet.state === 'pending') return false;
    if (this.opts.requirePresence && !this._confirmedRecently(p)) return false;
    return true;
  }

  _confirmedRecently(p) {
    return p.confirmedAt && Date.now() - p.confirmedAt < 30 * 60 * 1000;
  }

  // ------------------------------------------------------------------ plan et Timefold
  // L'ordre prévu est toujours calculé tout de suite par la règle locale
  // (_pick) : la file ne reste jamais muette en attendant Java. Timefold
  // cherche ensuite en arrière-plan un meilleur ordre pour les mêmes règles.
  // Son résultat n'est adopté que s'il n'est pas moins bon selon la mesure
  // locale (_planMetric) et si l'état n'a pas changé entre-temps. Un plan
  // adopté survit au passage normal des chansons (réservation, envoi, fin) ;
  // un titre ajouté ou retiré, un duo, un réglage, un bonus ou une action du
  // bar en demandent un nouveau.
  _activePlanRanks(fingerprint = null) {
    const plan = this.solverPlan;
    if (!plan) return null;
    // Compatibilité : un plan sans empreinte ne vaut que pour sa version.
    if (plan.fingerprint === undefined) return plan.version === this.version ? plan.ranks : null;
    if (plan.fingerprint !== (fingerprint || this.solverContextFingerprint())) return null;
    plan.version = this.version;
    return plan.ranks;
  }

  // Une réservation ou un envoi prévu ne rendent pas le plan faux : ils le
  // réalisent. Le plan et un calcul encore en cours sont donc conservés.
  _carryPlanAcross(mutate) {
    const before = this.solverContextFingerprint();
    const keepPlan = !!this.solverPlan && this.solverPlan.fingerprint === before;
    const keepPending = this.solverPendingFingerprint === before;
    const keepRequested = this.solverRequestedFingerprint === before;
    const keepRefine = this.solverRefine?.fingerprint === before;
    const keepStats = this.solverRefineStats.fingerprint === before;
    const result = mutate();
    if (keepPlan || keepPending || keepRequested || keepRefine || keepStats) {
      const after = this.solverContextFingerprint();
      if (keepPlan) this.solverPlan.fingerprint = after;
      if (keepPending) this.solverPendingFingerprint = after;
      if (keepRequested) this.solverRequestedFingerprint = after;
      if (keepRefine) this.solverRefine.fingerprint = after;
      if (keepStats) this.solverRefineStats.fingerprint = after;
    }
    return result;
  }

  _maybeRequestSolver() {
    const fingerprint = this.solverContextFingerprint();
    if (this.solverPlan && this.solverPlan.fingerprint !== undefined &&
        this.solverPlan.fingerprint !== fingerprint) this.solverPlan = null;
    if (this.solverPlan?.fingerprint === fingerprint) {
      this.solverPlan.version = this.version;
      // Relance la chaîne d'optimisation continue si elle s'est arrêtée.
      if (!this.solverRefineTimer && !this.solverRefine) this._scheduleRefine();
      return false;
    }
    if (!this.solverBridge || !this.solverBridge.available) return false;
    if (this.solverRequestedFingerprint === fingerprint) return this.solverPendingFingerprint === fingerprint;
    return this._requestSolver(fingerprint);
  }

  _requestSolver(fingerprint, { budgetMs = null, forced = false, refine = false } = {}) {
    // Une passe d'optimisation continue part du plan adopté ; un nouveau
    // calcul part de l'ordre local.
    const baseRanks = refine ? this._activePlanRanks(fingerprint) : null;
    if (refine && !baseRanks) return false;
    const seed = this._forecast(false, [], null, true, { ranks: baseRanks });
    if (!refine) {
      this.solverRequestedFingerprint = fingerprint;
      this._cancelRefine();
    }
    if (seed.length < 2 || seed.length > 200 || seed.some(item => !item.entryId)) {
      if (refine) return false;
      this.solverLastError = seed.length > 200 ?
        'Plus de 200 titres prêts : ordonnanceur local seul.' :
        seed.some(item => !item.entryId) ? 'Titre sans identifiant : ordonnanceur local seul.' : null;
      this.solverForced = null;
      return false;
    }
    const rows = seed.map((item, previousIndex) => {
      const owner = this.people.get(item.ids[0]);
      return { id: item.entryId, owner: owner.id,
        ownerSongIndex: this.songsOf(owner).findIndex(song => song.entryId === item.entryId),
        singers: item.ids, groups: item.groups || [item.group], previousIndex };
    });
    let pinnedUntil = 0;
    if (this.reservedNext && rows[0]?.owner === this.reservedNext.personId) pinnedUntil = 1;
    // Titre passé faute de présence : il suit le prochain passage, sans exception.
    if (rows[1] && this._isPresenceRetry(this.people.get(rows[1].owner))) pinnedUntil = 2;
    // Titre reporté (« Pas prêt ») : sa place et celles d'avant sont fixées.
    rows.forEach((row, index) => {
      if (this._isDeferred(this.people.get(row.owner))) pinnedUntil = Math.max(pinnedUntil, index + 1);
    });
    if (this.manualOrderActive) {
      while (pinnedUntil < rows.length && this.manualOrder.includes(rows[pinnedUntil].owner)) {
        pinnedUntil++;
      }
    }
    const pastAppearance = {}, physicalCount = {}, readyAt = {}, personWeights = {};
    const involved = new Set(rows.flatMap(row => row.singers));
    for (const p of this.people.values()) {
      physicalCount[p.id] = (p.sung || 0) + (p.duetGuestCount || 0);
      if (p.lastAppearanceTurn) {
        pastAppearance[p.id] = p.lastAppearanceTurn - this.appearanceSerial - 1;
      } else if (physicalCount[p.id]) pastAppearance[p.id] = -1000;
      if (involved.has(p.id)) {
        readyAt[p.id] = (p.readySerial || 0) - this.appearanceSerial - 1;
        const weight = this.personWeight(p.id);
        if (Math.abs(weight - 1) > EPS) personWeights[p.id] = weight;
      }
    }
    const tableWeights = {};
    for (const group of new Set(rows.flatMap(row => row.groups))) {
      const weight = this.tableWeight(group);
      if (Math.abs(weight - 1) > EPS) tableWeights[group] = weight;
    }
    const adaptiveBudgetMs = rows.length < 20 ? 3000 : rows.length < 60 ? 8000 : 15000;
    // Les tests de simulation peuvent réduire le temps, sans changer la
    // politique de production ni la fonction de score utilisée.
    const configured = Number.isInteger(this.opts.solverBudgetMs) &&
      this.opts.solverBudgetMs >= 100 && this.opts.solverBudgetMs <= 30000 ?
      this.opts.solverBudgetMs : adaptiveBudgetMs;
    const budget = Number.isInteger(budgetMs) ? Math.max(100, Math.min(30000, budgetMs)) : configured;
    const stats = this._refineStatsFor(fingerprint);
    const request = { requestId: `${this.version}-${id()}`, budgetMs: budget, performances: rows,
      pastAppearance, physicalCount, readyAt, pinnedUntil,
      roundPeople: [...this.roundPeople].filter(pid => this.people.has(pid)),
      roundUse: Object.fromEntries([...this.roundUse].filter(([pid]) => this.people.has(pid))),
      roundApps: Object.fromEntries([...this.roundApps].filter(([pid]) => this.people.has(pid))),
      roundOwed: [...this.roundOwed].filter(pid => this.people.has(pid)),
      roundCap: this._roundCap(), spacing: this._spacing(),
      personWeights, tableWeights,
      history: this.recentGroups.slice(-HISTORY_LIMIT),
      rotation: !this.opts.tableRotation ? 'people' : this.opts.weightedTables ? 'sqrt' : 'equal',
      interleaveArrivals: this.opts.interleaveArrivals !== false,
      lastGroups: Array.isArray(this.lastGroup) ? this.lastGroup :
        this.lastGroup ? [this.lastGroup] : [],
      // Champs historiques conservés pour les anciens workers.
      roundGroups: [...this.roundGroups], tableServeCounts: Object.fromEntries(this.tableServeCounts),
      tableRotation: !!this.opts.tableRotation, weightedTables: !!this.opts.weightedTables };
    // Chaque passe explore un autre voisinage : refaire la même recherche
    // sur la même file ne trouverait rien de nouveau.
    if (refine) request.randomSeed = (stats.runs % 16) + 1;
    if (refine) {
      this.solverRefine = { requestId: request.requestId, fingerprint,
        since: Date.now(), budgetMs: budget };
    } else {
      this.solverPendingFingerprint = fingerprint;
      this.solverPendingRequestId = request.requestId;
      this.solverPendingSince = Date.now();
      this.solverPendingBudgetMs = budget;
      this.solverForced = forced ? { at: Date.now(), budgetMs: budget } : null;
      this.version++;
    }
    const current = () => refine ? this.solverRefine?.requestId === request.requestId :
      this.solverPendingRequestId === request.requestId;
    let claimed = false; // réponse prise en charge : une erreur ensuite reste la nôtre
    const promise = this.solverBridge.solve(request, { immediate: forced || refine }).then(response => {
      if (!current()) return false;
      claimed = true;
      let expected;
      if (refine) {
        expected = this.solverRefine.fingerprint;
        this.solverRefine = null;
      } else {
        expected = this.solverPendingFingerprint;
        this.solverPendingFingerprint = null;
        this.solverPendingRequestId = null;
        this.solverForced = null;
        this.version++;
      }
      if (this.solverContextFingerprint() !== expected) return false;
      if (refine && (this.solverPlan?.source === 'manual' || !this._activePlanRanks(expected))) return false;
      const order = response.order;
      const originalIds = rows.map(row => row.id);
      if (!Array.isArray(order) || order.length !== originalIds.length ||
          new Set(order).size !== order.length || order.some(entry => !originalIds.includes(entry)) ||
          originalIds.slice(0, pinnedUntil).some((entry, index) => order[index] !== entry)) {
        throw new Error('Le solveur a répondu avec une file invalide.');
      }
      const ranks = new Map(order.map((entry, index) => [entry, index]));
      const baseOrder = this._forecast(false, [], null, true,
        { ranks: refine ? this._activePlanRanks(expected) : null });
      const local = this._planMetric(baseOrder);
      const proposedOrder = this._forecast(false, [], null, true, { ranks });
      const proposed = this._planMetric(proposedOrder);
      // À qualité égale, l'ordre déjà affiché est conservé : Timefold le
      // confirme sans faire bouger la file pour rien. Un gain que seule la
      // mesure complète voit (part de chaque table, premiers passages) est
      // adopté s'il ne dégrade pas la mesure locale et si la règle locale
      // reproduit exactement l'ordre proposé.
      const sameOrder = proposedOrder.length === order.length &&
        proposedOrder.every((slot, index) => slot.entryId === order[index]);
      const improved = proposed < local ||
        (proposed === local && sameOrder && solverScoreGain(response.seedScore, response.score));
      const now = Date.now();
      if (refine) {
        stats.runs++;
        if (improved) { stats.improvements++; stats.fruitless = 0; stats.lastImprovedAt = now; } else stats.fruitless++;
      }
      this.solverLastRun = { at: now, elapsedMs: Number(response.elapsedMs) || null,
        budgetMs: budget, titles: rows.length, forced, refine, improved,
        localMetric: local, solverMetric: proposed };
      if (improved) {
        this.solverPlan = { version: this.version, fingerprint: expected, ranks, source: 'timefold' };
        if (refine) this.version++;
      } else if (!refine) {
        this.solverPlan = { version: this.version, fingerprint: expected,
          ranks: new Map(baseOrder.map((item, index) => [item.entryId, index])), source: 'confirmed' };
      }
      this.solverLastError = null;
      this._scheduleRefine();
      return improved || !refine;
    }).catch(error => {
      if (!claimed && !current()) return false;
      if (refine) {
        this.solverRefine = null;
        this.solverLastError = error.message;
        // Solveur arrêté : il redevient disponible après sa pause de sécurité.
        this._scheduleRefine(60_000);
        return false;
      }
      if (!claimed) {
        this.solverPendingFingerprint = null;
        this.solverPendingRequestId = null;
        this.solverForced = null;
        this.version++;
      }
      this.solverLastError = error.message;
      if (!this.solverBridge.available) this.solverRequestedFingerprint = null;
      return false; // l'ordre local reste disponible
    });
    if (refine) this.solverRefinePromise = promise;
    else this.solverPromise = promise;
    return true;
  }

  // ------------------------------------------------------------------ optimisation continue
  // Donner plus de temps à la recherche trouve souvent une meilleure rotation
  // sur les mêmes données. Tant que la file ne change pas, des passes de 10,
  // 20 puis 30 secondes repartent du meilleur ordre connu avec une autre
  // graine. Après plusieurs passes sans gain, les pauses s'allongent (2 s
  // jusqu'à 2 min) pour ne pas occuper le PC du bar inutilement. Tout
  // changement réel interrompt la passe en cours ; le prochain chanteur
  // annoncé et les titres déjà dans KaraFun ne bougent jamais.
  _refineStatsFor(fingerprint) {
    if (this.solverRefineStats.fingerprint !== fingerprint) {
      this.solverRefineStats = { fingerprint, runs: 0, improvements: 0, fruitless: 0 };
    }
    return this.solverRefineStats;
  }

  _refineAllowed() {
    return !!(this.opts.solverEnabled && this.opts.continuousSolver && this.solverBridge?.available &&
      this.solverPlan && this.solverPlan.source !== 'manual' && !this.manualOrderActive &&
      this.solverPendingFingerprint === null && !this.solverRefine);
  }

  _cancelRefine() {
    clearTimeout(this.solverRefineTimer);
    this.solverRefineTimer = null;
    this.solverRefineAt = null;
    this.solverRefine = null;
  }

  _scheduleRefine(delayMs = null) {
    clearTimeout(this.solverRefineTimer);
    this.solverRefineTimer = null;
    this.solverRefineAt = null;
    if (!this._refineAllowed()) return false;
    const stats = this._refineStatsFor(this.solverPlan.fingerprint);
    const base = Math.max(10, Number(this.opts.solverRefinePauseMs) || 2000);
    const pause = delayMs ?? (stats.fruitless < 3 ? base : Math.min(120_000, base * 2 ** (stats.fruitless - 2)));
    this.solverRefineAt = Date.now() + pause;
    this.solverRefineTimer = setTimeout(() => {
      this.solverRefineTimer = null;
      this.solverRefineAt = null;
      this._refineNow();
    }, pause);
    this.solverRefineTimer.unref?.();
    return true;
  }

  _refineNow() {
    const fingerprint = this.solverContextFingerprint();
    if (!this._refineAllowed() || this.solverPlan.fingerprint !== fingerprint) return false;
    const stats = this._refineStatsFor(fingerprint);
    const configured = Number.isInteger(this.opts.solverBudgetMs) ? this.opts.solverBudgetMs : 10_000;
    const budgetMs = Math.min(30_000, Math.max(100, configured) * Math.min(3, stats.runs + 1));
    return this._requestSolver(fingerprint, { budgetMs, refine: true });
  }

  // Le bar demande un nouveau calcul complet : les déplacements manuels sont
  // abandonnés, « Priorité » comprise ; un prochain annoncé par le calcul
  // reste garanti. Timefold dispose de son budget maximal, sans attendre la
  // fenêtre de regroupement.
  forceReplan(budgetMs = 30000) {
    // Une priorité donnée par le bar est un déplacement manuel comme un autre,
    // même quand une nouvelle table a déjà effacé l'ordre manuel.
    const priority = !!this.reservedNext?.byStaff;
    const manual = priority || this.manualOrderActive || this.solverPlan?.source === 'manual';
    this.invalidateManualOrder();
    if (priority) this.releaseNext();
    this.solverPlan = null;
    this.solverRequestedFingerprint = null;
    this._cancelRefine();
    this.note(`Le bar relance le calcul de la file${manual ? ' ; les déplacements manuels sont abandonnés' : ''}`, 'staff');
    if (!this.solverBridge?.available) return false;
    return this._requestSolver(this.solverContextFingerprint(), { budgetMs, forced: true });
  }

  // Mesure commune pour comparer deux ordres : une table qui reprend le micro
  // compte beaucoup, un retour trop rapide d'une même personne un peu moins.
  _planMetric(slots) {
    let adjacency = 0, recency = 0;
    let previous = Array.isArray(this.lastGroup) ? this.lastGroup : this.lastGroup ? [this.lastGroup] : [];
    const seen = new Map();
    slots.forEach((slot, index) => {
      const groups = slot.groups || [slot.group];
      if (previous.length && overlaps(groups, previous)) adjacency++;
      for (const pid of slot.ids) {
        if (seen.has(pid)) {
          const distance = index - seen.get(pid);
          if (distance < 4) recency += (4 - distance) ** 2;
        }
        seen.set(pid, index);
      }
      previous = groups;
    });
    return adjacency * 1000 + recency;
  }

  whenPlanReady() {
    const pending = this._maybeRequestSolver();
    return pending ? this.solverPromise : Promise.resolve(!!this._activePlanRanks());
  }

  solverStatus() {
    this._maybeRequestSolver();
    const ranks = this._activePlanRanks();
    const stats = this.solverRefineStats.fingerprint === this.solverPlan?.fingerprint ?
      this.solverRefineStats : { runs: 0, improvements: 0, fruitless: 0 };
    return { configured: !!this.solverBridge,
      available: !!this.solverBridge?.available,
      pending: this.solverPendingFingerprint !== null,
      pendingSince: this.solverPendingFingerprint !== null ? this.solverPendingSince : null,
      budgetMs: this.solverPendingFingerprint !== null ? this.solverPendingBudgetMs : null,
      forced: !!this.solverForced,
      plan: ranks ? this.solverPlan.source || 'timefold' : 'local',
      lastRun: this.solverLastRun,
      continuous: !!(this.opts.solverEnabled && this.opts.continuousSolver),
      refining: !!this.solverRefine,
      refineSince: this.solverRefine?.since ?? null,
      refineBudgetMs: this.solverRefine?.budgetMs ?? null,
      nextRefineAt: this.solverRefineAt,
      refineRuns: ranks ? stats.runs : 0,
      refineImprovements: ranks ? stats.improvements : 0,
      lastImprovedAt: ranks ? stats.lastImprovedAt || null : null,
      blockingNext: false,
      // Texte montré au bar : sans nom de bibliothèque ni détail Java.
      fallbackLastError: plainSolverError(this.solverLastError || this.solverBridge?.lastError || null) };
  }
  closeSolver() { this._cancelRefine(); this.solverBridge?.close(); }

  // Poids de chaque groupe dans le partage d'un tour. Par défaut, au prorata
  // des chanteurs prêts (chacun chante une fois par tour, une table de 10
  // obtient deux fois plus de passages qu'une table de 5) ; en rotation des
  // tables, parts égales ; en compromis, racine du nombre de chanteurs.
  _groupWeights(cands) {
    const members = new Map();
    for (const c of cands) {
      const owner = this.people.get(c.ids[0]);
      if (!owner) continue;
      if (!members.has(owner.group)) members.set(owner.group, new Set());
      members.get(owner.group).add(owner.id);
    }
    for (const c of cands) for (const g of c.groups) if (!members.has(g)) members.set(g, new Set());
    const mode = !this.opts.tableRotation ? 'people' : this.opts.weightedTables ? 'sqrt' : 'equal';
    const out = new Map();
    for (const [group, set] of members) {
      const sum = [...set].reduce((total, pid) => total + this.personWeight(pid), 0);
      out.set(group, !set.size ? 0 : mode === 'people' ? sum :
        mode === 'sqrt' ? Math.sqrt(sum) : this.tableWeight(group));
    }
    return out;
  }

  // Écart entre la part méritée et les passages réellement obtenus sur la
  // dernière fenêtre d'environ un tour. Le plus grand écart passe d'abord.
  _groupDeficits(weights, history, owners) {
    const total = [...weights.values()].reduce((a, b) => a + b, 0);
    const out = new Map();
    const recent = history.slice(-Math.max(4, owners));
    for (const [group, weight] of weights) {
      const served = recent.reduce((n, groups) => n + (groups.includes(group) ? 1 : 0), 0);
      out.set(group, total > EPS ? (recent.length + 1) * weight / total - served : -served);
    }
    return out;
  }

  // Chaque chanteur prêt passe une fois par tour (crédit ajusté par un bonus
  // ou un malus). Les premiers passages de la soirée restent prioritaires.
  // Parmi les passages équitables, la table la plus en retard sur sa part
  // chante, sans reprendre le micro juste après elle-même si possible.
  // `predict` : on suppose que chaque ticket sera prêt à temps.
  _pick(order, lastGroup, predict, roundGroups = this.roundGroups, roundPeople = this.roundPeople,
    servedCounts = this.tableServeCounts, cooldowns = this.duetCooldowns, projectedSongs = null,
    reservation = null, appearances = null, ignorePresence = false,
    recentTurns = null, sim = null, unready = null) {
    const idx = new Map(order.map((pid, i) => [pid, i]));
    const cands = [];
    for (const pid of order) {
      const p = this.people.get(pid);
      if (!p || p.withdrawnAt) continue;
      // Personne d'un passage reporté (« Pas prêt ») : rien ne part avec elle.
      if (unready?.has(pid)) continue;
      const song = projectedSongs ? projectedSongs.get(pid) : p.song;
      const duet = song?.duet;
      const owner = duet && duet.state === 'accepted' ? p : null;
      if (owner) {
        const partner = this.people.get(duet.partnerId);
        if (partner && !partner.withdrawnAt) {
          if (unready?.has(partner.id)) continue;
          if (!predict) {
            if (!song) continue;
            if (!ignorePresence && this.opts.requirePresence &&
                !(this._confirmedRecently(owner) || this._confirmedRecently(partner))) continue;
          }
          cands.push({ ids: [owner.id, partner.id], consumedIds: [owner.id],
            song, group: owner.group,
            groups: [...new Set([owner.group, partner.group])], at: idx.get(p.id),
            kind: 'duo' });
          continue;
        }
      }
      if (!predict && (!song || duet?.state === 'pending' ||
          (!ignorePresence && this.opts.requirePresence && !this._confirmedRecently(p)))) continue;
      cands.push({ ids: [p.id], consumedIds: [p.id], song, group: p.group, groups: [p.group], at: idx.get(p.id) });
    }
    if (!cands.length) return null;
    const roundUse = sim ? sim.roundUse : this.roundUse;
    const roundApps = sim?.roundApps || this.roundApps;
    const history = sim ? sim.history : this.recentGroups;
    const serial = sim ? sim.serial : this.appearanceSerial;
    const ranks = sim ? sim.ranks : this._activePlanRanks();
    // Le tour mesure les personnes réellement montées sur scène, invitées de
    // duo comprises. Un tour neuf commence seulement quand plus aucun titre
    // prêt ne peut présenter une personne qui n'a pas chanté dans ce tour.
    // Un malus peut prolonger l'attente d'une personne sur plusieurs tours.
    // Au plus deux passages par personne dans le tour : un duo dont un
    // chanteur a atteint ce plafond attend le tour suivant, comme un duo
    // encore sans réponse. Le tour se termine quand plus rien d'autre n'est
    // possible.
    const cap = this._roundCap();
    const capped = (c, apps) => cap > 0 && c.ids.some(pid => (apps.get(pid) || 0) >= cap);
    let physicalRound = roundPeople, physicalApps = roundApps, roundResets = 0;
    const blocked = (set, apps) => cands.every(c => capped(c, apps) || c.ids.every(pid => set.has(pid)));
    if (blocked(roundPeople, roundApps)) {
      const people = new Set(roundPeople), use = new Map(roundUse), apps = new Map();
      do { this._resetRound(people, use); roundResets++; } while (roundResets < 4 && blocked(people, apps));
      physicalRound = people;
      physicalApps = apps;
    }
    const open = cands.filter(c => !capped(c, physicalApps));
    const pool = open.length ? open : cands;
    // Un tour clos par le plafond laisse des personnes sans passage (leur duo
    // attendait quelqu'un au plafond) : elles passent en tête du tour suivant,
    // toutes, et restent prioritaires jusqu'à leur passage dans ce tour.
    const owed = roundResets ? new Set(cands.flatMap(c => c.ids).filter(pid => !roundPeople.has(pid))) :
      (sim?.roundOwed || this.roundOwed);
    const preferOwed = list => {
      const owing = owed.size ? list.filter(c => c.ids.some(pid => owed.has(pid) && !physicalRound.has(pid))) : [];
      return owing.length ? owing : list;
    };
    const newPersonRound = roundResets > 0;
    const withRound = c => {
      // Un duo peut réunir une table déjà servie et une table encore neuve.
      // Ce passage complète alors le tour ; il ne remet pas à zéro les tables
      // restantes (compteurs conservés pour l'historique).
      const newGroupRound = newPersonRound || cands.every(candidate =>
        candidate.groups.every(group => roundGroups.has(group)));
      return { ...c, newPersonRound, roundResets, newGroupRound, ...(newPersonRound ? { owed: [...owed] } : {}) };
    };
    const reserved = reservation && cands.find(c => c.ids[0] === reservation.personId);
    if (reserved) return withRound(reserved);
    if (this.manualOrderActive) {
      const explicit = cands.filter(c => this.manualOrder.includes(c.ids[0]) &&
        (!projectedSongs || c.song === this.people.get(c.ids[0])?.song))
        .sort((a, b) => this.manualOrder.indexOf(a.ids[0]) - this.manualOrder.indexOf(b.ids[0]));
      if (explicit.length) return withRound(explicit[0]);
    }
    // Le ticket de l'invité d'un duo reste intact, mais sa présence sur scène
    // compte pour l'équité. Tant qu'un passage sans chanteur déjà entendu est
    // prêt, personne ne doit revenir (même en duo). Parmi les duos mêlant un
    // nouveau et un ancien, servir d'abord ceux qui présentent un nouveau.
    const appearancesOf = pid => appearances ? (appearances.get(pid) || 0) :
      ((this.people.get(pid)?.sung || 0) + (this.people.get(pid)?.duetGuestCount || 0));
    const fairest = candidates => {
      const untouched = candidates.filter(c => c.ids.every(pid => appearancesOf(pid) === 0));
      let choices = untouched.length ? untouched : candidates;
      if (!untouched.length) {
        const introducing = candidates.filter(c => c.ids.some(pid => appearancesOf(pid) === 0));
        if (introducing.length) {
          // À premier passage égal, un duo avec une personne déjà souvent montée
          // sur scène attend derrière celui dont le partenaire a moins chanté.
          const total = c => c.ids.reduce((n, pid) => n + appearancesOf(pid), 0);
          const least = Math.min(...introducing.map(total));
          choices = introducing.filter(c => total(c) === least);
        }
      }
      // Une personne privée de passage au tour précédent passe d'abord, même
      // si son duo ramène une personne déjà montée dans ce tour.
      choices = preferOwed(choices);
      // Une fois les premières apparitions de la soirée servies, refaire la
      // même vérification à chaque tour physique. En particulier, un duo déjà
      // entendu ne doit pas passer devant un solo ou duo qui présente encore
      // quelqu'un de ce tour. Parmi ces derniers, préférer deux personnes
      // inédites à un duo où une seule est inédite.
      const physicallyFresh = choices.filter(c => c.ids.every(pid => !physicalRound.has(pid)));
      if (physicallyFresh.length) return physicallyFresh;
      const introducingNow = choices.filter(c => c.ids.some(pid => !physicalRound.has(pid)));
      if (!introducingNow.length) return choices;
      const fewestRepeats = Math.min(...introducingNow.map(c =>
        c.ids.filter(pid => physicalRound.has(pid)).length));
      return introducingNow.filter(c =>
        c.ids.filter(pid => physicalRound.has(pid)).length === fewestRepeats);
    };
    let choices = fairest(pool);
    const lastTable = new Set(Array.isArray(lastGroup) ? lastGroup : lastGroup ? [lastGroup] : []);
    const lastApp = pid => recentTurns ? (recentTurns.get(pid) || 0) :
      (this.people.get(pid)?.lastAppearanceTurn || 0);
    // Espacement : au moins trois autres chansons avant qu'une personne
    // remonte sur scène. Si tous les passages prioritaires la font revenir
    // trop tôt, un autre passage du tour s'intercale, jamais une personne qui
    // a déjà chanté dans ce tour ; un premier passage attend ainsi au plus
    // trois chansons. La règle des tables passe avant : on n'espace pas une
    // personne en redonnant le micro à la table qui vient de chanter.
    const spacing = this._spacing();
    const spaced = c => c.ids.every(pid => { const seen = lastApp(pid); return !seen || seen <= serial - spacing; });
    const offTable = list => list.some(c => c.groups.every(g => !lastTable.has(g)));
    if (spacing > 0) {
      let wellSpaced = choices.filter(spaced);
      if (!wellSpaced.length) {
        const others = pool.filter(c => spaced(c) && c.ids.some(pid => !physicalRound.has(pid)));
        if (others.length) wellSpaced = fairest(others);
      }
      if (wellSpaced.length && (offTable(wellSpaced) || !offTable(choices))) choices = wellSpaced;
    }
    // Anti-série : quand tous les passages prioritaires sont de la table qui
    // vient de chanter (typiquement une grande table arrivée d'un coup), une
    // personne d'une autre table peut s'intercaler, à condition de n'avoir
    // chanté avant AUCUNE personne encore en attente depuis son dernier
    // passage. Ainsi personne ne voit quelqu'un chanter deux fois pendant
    // sa propre attente, et la table nouvelle ne monopolise pas le micro.
    if (this.opts.interleaveArrivals !== false && lastTable.size && choices.every(c => c.groups.some(g => lastTable.has(g)))) {
      const waitStart = pid => Math.max(lastApp(pid), this.people.get(pid)?.readySerial || 0);
      const alternates = pool.filter(c => !choices.includes(c) &&
        c.groups.every(g => !lastTable.has(g)) &&
        c.ids.every(pid => {
          const seen = lastApp(pid);
          return seen > 0 && cands.every(other => other.consumedIds.every(q =>
            c.ids.includes(q) || seen <= waitStart(q)));
        }));
      if (alternates.length) choices = alternates;
    }
    // Un plan (Timefold ou ordre manuel du bar) départage les passages que
    // l'équité autorise ; il ne peut jamais contourner les règles ci-dessus.
    if (ranks) {
      const planned = choices.filter(c => ranks.has(c.song?.entryId))
        .sort((a, b) => ranks.get(a.song.entryId) - ranks.get(b.song.entryId) || a.at - b.at);
      if (planned.length) return withRound(planned[0]);
    }
    // Le répit d'un invité évite les passages trop rapprochés seulement entre
    // candidats de même niveau d'équité : il ne retarde pas un premier passage
    // au profit d'une personne déjà montée sur scène.
    const cooled = choices.filter(c => c.ids.every(pid => (cooldowns.get(pid) || 0) <= 0));
    if (cooled.length) choices = cooled;
    // Pas deux chansons de suite pour la même table quand une autre est prête.
    const otherTable = choices.filter(c => c.groups.every(g => !lastTable.has(g)));
    if (otherTable.length) choices = otherTable;
    // Quelqu'un qui vient de monter sur scène (dans les deux derniers
    // passages) laisse passer les autres : « Yannick & Marine » passe avant
    // « Osark & Johnny » quand Johnny vient de chanter.
    const mostRecent = c => Math.max(0, ...c.ids.map(lastApp));
    const rested = choices.filter(c => mostRecent(c) <= serial - 2);
    if (rested.length) choices = rested;
    // Le glisser-déposer du bar départage les candidats équitables. Une
    // priorité ponctuelle explicite est déjà traitée par reservedNext ci-dessus.
    const manual = choices.filter(c => this.manualOrder.includes(c.ids[0]) &&
      (!projectedSongs || c.song === this.people.get(c.ids[0])?.song))
      .sort((a, b) => this.manualOrder.indexOf(a.ids[0]) - this.manualOrder.indexOf(b.ids[0]));
    if (manual.length) return withRound(manual[0]);
    // Partage du tour entre les tables selon le mode choisi.
    const weights = this._groupWeights(cands);
    const deficits = this._groupDeficits(weights, history,
      new Set(cands.map(c => c.ids[0])).size);
    const need = c => Math.max(...c.groups.map(g => deficits.get(g) ?? -Infinity));
    const size = c => Math.max(...c.groups.map(g => weights.get(g) || 0));
    const tableIds = [...this.tables.keys()];
    const tableRank = c => Math.min(...c.ids.map(pid => {
      const index = tableIds.indexOf(this.people.get(pid)?.tableId);
      return index < 0 ? tableIds.length : index;
    }));
    choices = choices.slice().sort((a, b) => {
      const byNeed = need(b) - need(a);
      if (Math.abs(byNeed) > EPS) return byNeed;
      return size(b) - size(a) || tableRank(a) - tableRank(b) ||
        this.personWeight(b.ids[0]) - this.personWeight(a.ids[0]) ||
        mostRecent(a) - mostRecent(b) || a.at - b.at;
    });
    return withRound(choices[0]);
  }

  // Renvoie la prochaine chanson à envoyer (sans rien modifier), ou null.
  select() {
    this._maybeRequestSolver();
    if (this.reservedNext) {
      const p = this.people.get(this.reservedNext.personId);
      const duet = p?.song?.duet;
      const guest = duet?.state === 'accepted' ? this.people.get(duet.partnerId) : null;
      if (!p || p.withdrawnAt || !p.song || duet?.state === 'pending' || this._isDeferred(p) ||
          (duet?.state === 'accepted' && (!guest || guest.withdrawnAt))) {
        this.releaseNext();
      } else if (this.opts.requirePresence && !this.confirmedForTurn(
        guest ? [p.id, guest.id] : [p.id])) {
        // Le prochain annoncé attend sa confirmation. Envoyer C à sa place
        // ferait mentir l'annonce faite à B et à toute la salle.
        return null;
      }
    }
    // Un titre passé faute de présence laisse passer le suivant, un titre
    // reporté (« Pas prêt ») le nombre de chansons demandé (voir _forecast).
    const deferred = this._deferredOwners();
    const held = new Set([...this._presenceRetries(), ...deferred]);
    const blocked = deferred.length ? this._deferredPeople(deferred) : null;
    const order = held.size ? this.Q.filter(pid => !held.has(pid)) : this.Q;
    const c = this._pick(order, this.lastGroup, false,
      this.roundGroups, this.roundPeople, this.tableServeCounts, this.duetCooldowns,
      null, this.reservedNext, null, false, null, null, blocked);
    if (!c) return null;
    const names = c.ids.map(pid => this.people.get(pid).name);
    const tables = [...new Set(c.ids.map(pid => this.table(this.people.get(pid).tableId).name))];
    return { ...c, label: `${names.join(' & ')} · ${tables.join(' + ')}`, names,
      presenceConfirmed: this.opts.requirePresence && this.confirmedForTurn(c.ids) };
  }

  // Le serveur appelle ceci dès qu'il annonce le chanteur suivant pendant la
  // chanson en cours. Les nouvelles tables et changements de rotation ne le
  // déplacent plus. Un départ ou une intervention du bar peuvent le libérer.
  reserveNext() {
    const selected = this.select();
    if (!selected) return null;
    if (!this.reservedNext || this.reservedNext.personId !== selected.ids[0]) {
      this._carryPlanAcross(() => {
        this.reservedNext = { personId: selected.ids[0], reservedAt: Date.now() };
      });
      this.version++;
    }
    return selected;
  }

  // Réserve le premier titre réellement prêt hors confirmation de présence.
  // Les tickets sans chanson et les duos encore en attente ne figurent pas
  // ici. Une réservation existante reste stable tant que son titre existe.
  reservePresenceNext(excludeIds = [], provisional = null) {
    // Un titre reporté (« Pas prêt ») n'est pas annoncé avant la fin de son report.
    const visible = this.presenceView(excludeIds, provisional)
      .filter(v => !v.future && !this._isDeferred(this.people.get(v.ids[0])));
    const kept = visible.find(v => v.ids[0] === this.reservedNext?.personId);
    if (kept) return kept;
    if (this.reservedNext) this.releaseNext();
    const first = visible[0];
    if (!first) return null;
    this._carryPlanAcross(() => {
      this.reservedNext = { personId: first.ids[0], reservedAt: Date.now() };
      const p = this.people.get(first.ids[0]);
      if (p) p.presenceRetry = false;
    });
    this.version++;
    return first;
  }

  releaseNext() {
    if (this.reservedNext) {
      this.reservedNext = null;
      this.version++;
    }
  }

  // Simule les titres suivants sans consommer les vrais tickets. Une personne
  // reste dans le cercle tant que sa liste contient un autre titre ; seul
  // `select()` peut envoyer son titre courant à KaraFun.
  _forecast(predict, excludeIds = [], provisional = null, ignorePresence = false, options = {}) {
    const excluded = new Set(excludeIds);
    const pendingIds = new Set(provisional ? (provisional.consumedIds || provisional.ids) : []);
    const lists = new Map(), positions = new Map(), songs = new Map(), remaining = [];
    for (const pid of this.Q) {
      if (excluded.has(pid) && !pendingIds.has(pid)) continue;
      const p = this.people.get(pid);
      if (!p || p.withdrawnAt) continue;
      const list = this.songsOf(p);
      if (predict && !list.length) list.push(null); // ticket sans titre, utile à la prévision personnelle
      const start = pendingIds.has(pid) ? 1 : 0;
      if (start >= list.length) continue;
      lists.set(pid, list); positions.set(pid, start); songs.set(pid, list[start]);
      remaining.push(pid);
    }
    const ranks = 'ranks' in options ? options.ranks : this._activePlanRanks();
    let last = this.lastGroup;
    const round = new Set(this.roundGroups);
    const roundPeople = new Set(this.roundPeople);
    const roundUse = new Map(this.roundUse);
    const roundApps = new Map(this.roundApps);
    const roundOwed = new Set(this.roundOwed);
    const history = this.recentGroups.slice(-HISTORY_LIMIT);
    const served = new Map(this.tableServeCounts);
    const cooldowns = new Map(this.duetCooldowns);
    const appearances = new Map([...this.people.values()].map(p =>
      [p.id, (p.sung || 0) + (p.duetGuestCount || 0)]));
    const recentTurns = new Map([...this.people.values()].map(p =>
      [p.id, p.lastAppearanceTurn || 0]));
    let appearanceTurn = this.appearanceSerial;
    const slots = [];
    const apply = c => {
      const resets = c.roundResets ?? (c.newPersonRound ? 1 : 0);
      for (let k = 0; k < resets; k++) this._resetRound(roundPeople, roundUse, roundApps);
      if (resets) { roundOwed.clear(); (c.owed || []).forEach(pid => roundOwed.add(pid)); }
      if (c.newGroupRound) round.clear();
      c.ids.forEach(pid => this._useRound(roundPeople, roundUse, pid));
      c.ids.forEach(pid => roundApps.set(pid, (roundApps.get(pid) || 0) + 1));
      c.ids.forEach(pid => roundOwed.delete(pid));
      const groups = c.groups || [c.group];
      groups.forEach(g => { round.add(g); served.set(g, (served.get(g) || 0) + 1); });
      history.push(groups);
      this._advanceCooldowns(cooldowns, c);
      c.ids.forEach(pid => appearances.set(pid, (appearances.get(pid) || 0) + 1));
      appearanceTurn++;
      c.ids.forEach(pid => recentTurns.set(pid, appearanceTurn));
      last = groups;
    };
    if (provisional) apply(provisional);
    let reservation = this.reservedNext && !pendingIds.has(this.reservedNext.personId) ?
      this.reservedNext : null;
    // Un titre passé faute de « Je suis là » laisse passer le passage suivant,
    // un titre reporté (« Pas prêt ») le nombre de chansons demandé, puis il
    // devient le prochain annoncé (comme _commit le fait réellement). Les
    // titres passés faute de présence sont libérés d'abord, puis les reports,
    // chacun dans l'ordre de la file.
    const holds = new Map();
    for (const pid of this._presenceRetries()) {
      if (remaining.includes(pid) && !pendingIds.has(pid)) holds.set(pid, { left: 1, presence: true, ids: [pid] });
    }
    for (const pid of this._deferredOwners()) {
      if (!remaining.includes(pid) || pendingIds.has(pid) || holds.has(pid)) continue;
      const d = this.people.get(pid).deferral;
      holds.set(pid, { left: d.remaining, presence: false, ids: d.ids || [pid] });
    }
    const passed = ids => { for (const [pid, hold] of holds) if (!ids.includes(pid)) hold.left--; };
    const release = (any = false) => {
      for (const presence of [true, false]) {
        for (const pid of this.Q) {
          const hold = holds.get(pid);
          if (hold && hold.presence === presence && (any || hold.left <= 0)) { holds.delete(pid); return { personId: pid }; }
        }
      }
      return null;
    };
    const blockedNow = () => {
      const out = new Set();
      for (const hold of holds.values()) if (!hold.presence) hold.ids.forEach(pid => out.add(pid));
      return out.size ? out : null;
    };
    if (provisional && holds.size) {
      passed(provisional.ids);
      if (!reservation) reservation = release();
    }
    while (remaining.length) {
      const order = holds.size ? remaining.filter(pid => !holds.has(pid)) : remaining;
      let c = order.length ? this._pick(order, last, predict, round, roundPeople, served,
        cooldowns, songs, reservation, appearances, ignorePresence, recentTurns,
        { roundUse, roundApps, roundOwed, history, serial: appearanceTurn, ranks }, blockedNow()) : null;
      if (!c && holds.size) {
        // Plus aucun autre passage possible : le titre retenu revient tout de suite.
        reservation = release() || release(true);
        continue;
      }
      if (!c) break;
      reservation = null;
      if (holds.size) {
        // Monter sur scène (en invité d'un duo) efface un « Je suis là » manqué.
        c.ids.forEach(pid => { if (holds.get(pid)?.presence) holds.delete(pid); });
        passed(c.ids);
        reservation = release();
      }
      slots.push({ ...c, entryId: c.song?.entryId || null, future: positions.get(c.ids[0]) > 0 });
      for (const pid of c.consumedIds) {
        const k = remaining.indexOf(pid);
        if (k < 0) continue;
        remaining.splice(k, 1);
        const next = positions.get(pid) + 1;
        positions.set(pid, next);
        if (next < lists.get(pid).length) {
          songs.set(pid, lists.get(pid)[next]);
          remaining.push(pid); // alterner aussi les chanteurs d'une même table
        } else songs.delete(pid);
      }
      apply(c);
    }
    if (predict) for (const pid of remaining) slots.push({ ids: [pid], group: (this.people.get(pid) || {}).group });
    return slots;
  }

  // Ordre de tous les passages futurs, avec les titres suivants des listes.
  predict() { this._maybeRequestSolver(); return this._forecast(true); }

  // Uniquement les passages qui disposent déjà d'une chanson. Les tickets
  // sans titre conservent leur place interne, sans créer un faux rang public.
  readyView(excludeIds = [], provisional = null, ignorePresence = false) {
    this._maybeRequestSolver();
    const qIndex = new Map(this.Q.map((pid, i) => [pid, i]));
    const out = [];
    for (const c of this._forecast(false, excludeIds, provisional, ignorePresence)) {
      const owner = this.people.get(c.ids[0]);
      if (!owner) continue;
      const table = this.table(owner.tableId);
      const tables = [...new Set(c.ids.map(pid => this.table(this.people.get(pid).tableId).name))];
      out.push({ ids: c.ids, song: c.song, entryId: c.entryId, future: c.future, kind: c.kind,
        groups: c.groups, name: c.ids.map(pid => this.people.get(pid)?.name).filter(Boolean).join(' & '),
        table: tables.join(' + ') || table?.name || '', tableId: owner.tableId, qi: qIndex.get(owner.id),
        over: owner.over, cap: this.opts.cap, confirmed: !!this._confirmedRecently(owner) });
    }
    return out;
  }

  presenceView(excludeIds = [], provisional = null) {
    return this.readyView(excludeIds, provisional, true);
  }

  _advanceCooldowns(cooldowns, passage) {
    for (const [pid, n] of cooldowns) {
      if (n <= 1) cooldowns.delete(pid);
      else cooldowns.set(pid, n - 1);
    }
    if (passage.kind === 'duo' && passage.ids[1]) cooldowns.set(passage.ids[1], 2);
  }

  // KaraFun confirme l'ajout avant que la chanson commence. Ce crédit sert à
  // prévoir la suite, mais doit pouvoir être annulé si le titre disparaît
  // sans jamais passer sur scène. Il voyage avec la sélection sauvegardée.
  _turnCreditState(sel) {
    return {
      appearanceSerial: this.appearanceSerial,
      lastGroup: Array.isArray(this.lastGroup) ? [...this.lastGroup] : this.lastGroup,
      roundPeople: [...this.roundPeople], roundGroups: [...this.roundGroups],
      roundUse: [...this.roundUse], roundApps: [...this.roundApps], roundOwed: [...this.roundOwed],
      recentGroups: this.recentGroups.map(groups => [...groups]),
      tableServeCounts: [...this.tableServeCounts], duetCooldowns: [...this.duetCooldowns],
      qIndex: this.Q.indexOf(sel.ids[0]),
      people: sel.ids.map(pid => this._creditRow(pid)),
    };
  }

  _creditRow(pid) {
    const p = this.people.get(pid);
    return p ? { id: pid, sung: p.sung || 0, duetGuestCount: p.duetGuestCount || 0,
      lastAppearanceTurn: p.lastAppearanceTurn || 0, lastSungAt: p.lastSungAt || 0,
      waitingSince: p.waitingSince || 0, confirmedAt: p.confirmedAt || 0,
      over: p.over || 0, held: p.held || 0 } : { id: pid };
  }

  // Le bar note l'invité d'un duo après l'envoi du titre à KaraFun : son
  // passage rejoint le reçu du titre, pour disparaître avec lui si KaraFun
  // retire ce titre sans qu'il ait été chanté.
  _addPartnerCredit(credit, partnerId, row, serialBefore) {
    const { before, after } = credit;
    if (!after || !Array.isArray(before?.people) || !Array.isArray(after.people) ||
        before.people.some(old => old.id === partnerId)) return;
    before.people.push(row);
    after.people.push(this._creditRow(partnerId));
    const put = (list, value) => {
      const map = new Map(list);
      if (value === undefined) map.delete(partnerId); else map.set(partnerId, value);
      return [...map];
    };
    if (Array.isArray(after.roundApps)) after.roundApps = put(after.roundApps, this.roundApps.get(partnerId));
    if (Array.isArray(after.duetCooldowns)) after.duetCooldowns = put(after.duetCooldowns, this.duetCooldowns.get(partnerId));
    if (Array.isArray(after.roundPeople) && !after.roundPeople.includes(partnerId)) after.roundPeople.push(partnerId);
    if (Array.isArray(after.roundOwed)) after.roundOwed = after.roundOwed.filter(pid => pid !== partnerId);
    if (after.appearanceSerial === serialBefore) after.appearanceSerial = this.appearanceSerial;
  }

  // Duo improvisé noté pendant qu'un autre passage de l'invité attend dans
  // KaraFun : le reçu de ce passage intègre le duo, avant comme après son
  // envoi. Si KaraFun retire ce titre sans qu'il soit chanté, l'annulation
  // rend l'état d'avant son envoi, duo compris : l'invité reste compté dans
  // le tour et attend ses deux chansons, au lieu de repasser en tête.
  _keepGuestCredit(credit, guestId, serialBump = 0) {
    const guest = this.people.get(guestId);
    const { before, after } = credit;
    if (!guest || !before || !after) return;
    for (const state of [before, after]) {
      if (Array.isArray(state.roundPeople) && !state.roundPeople.includes(guestId)) state.roundPeople.push(guestId);
      if (Array.isArray(state.roundOwed)) state.roundOwed = state.roundOwed.filter(pid => pid !== guestId);
      if (Array.isArray(state.duetCooldowns)) {
        const cooldowns = new Map(state.duetCooldowns);
        cooldowns.set(guestId, this.duetCooldowns.get(guestId));
        state.duetCooldowns = [...cooldowns];
      }
      if (serialBump > 0 && Number.isFinite(state.appearanceSerial)) state.appearanceSerial += serialBump;
      const row = Array.isArray(state.people) && state.people.find(item => item.id === guestId);
      if (row) {
        row.duetGuestCount = (row.duetGuestCount || 0) + 1;
        row.lastAppearanceTurn = Math.max(row.lastAppearanceTurn || 0, guest.lastAppearanceTurn || 0);
      }
    }
    const apps = state => {
      if (!Array.isArray(state.roundApps)) return;
      const counts = new Map(state.roundApps);
      counts.set(guestId, (counts.get(guestId) || 0) + 1);
      state.roundApps = [...counts];
    };
    apps(before); apps(after);
    // Le reçu « après » suit l'état actuel de l'invité, duo compris.
    const afterRow = Array.isArray(after.people) && after.people.find(item => item.id === guestId);
    if (afterRow) afterRow.lastAppearanceTurn = guest.lastAppearanceTurn || afterRow.lastAppearanceTurn;
  }

  rollbackUnplayed(sel, { requeue = false } = {}) {
    const credit = sel?.turnCredit;
    if (credit?.rolledBack) return false;
    // Le titre passé faute de présence était annoncé après ce passage, qui
    // n'a finalement pas été chanté : sans confirmation entre-temps, il
    // attend de nouveau qu'un autre passage chante devant lui.
    const retry = sel?.presenceRetryOf && this.people.get(sel.presenceRetryOf);
    if (retry && this.reservedNext?.personId === retry.id && !this._confirmedRecently(retry) &&
        retry.song && retry.presenceEntryId === retry.song.entryId) {
      this.releaseNext();
      retry.presenceRetry = true;
    }
    // Les reports (« Pas prêt ») rapprochés par ce passage reprennent leur
    // compte, sauf si la personne a changé son report entre-temps : « Je suis
    // prêt » (report effacé) ou « Encore une chanson » (total changé).
    for (const row of Array.isArray(sel?.deferralUndo) ? sel.deferralUndo : []) {
      const p = this.people.get(row?.pid);
      const old = row?.deferral;
      if (!p || !old || p.withdrawnAt || !p.song || p.song.entryId !== old.entryId) continue;
      const clearedByThis = sel.deferralReleasedTo === p.id || sel.ids.includes(p.id);
      const untouched = p.deferral ? (p.deferral.entryId === old.entryId && p.deferral.total === old.total &&
        p.deferral.remaining === Math.max(0, old.remaining - 1)) : clearedByThis;
      if (!untouched) continue;
      if (sel.deferralReleasedTo === p.id && this.reservedNext?.personId === p.id) this.releaseNext();
      p.deferral = { ...old };
    }
    if (sel) { delete sel.deferralUndo; delete sel.deferralReleasedTo; }
    const before = credit?.before, after = credit?.after;
    if (before && after && Array.isArray(before.people) && Array.isArray(after.people)) {
      const fields = ['sung', 'duetGuestCount', 'lastAppearanceTurn', 'lastSungAt',
        'waitingSince', 'over', 'held'];
      for (const old of before.people) {
        const p = this.people.get(old.id);
        const newer = after.people.find(row => row.id === old.id);
        if (!p || !newer) continue;
        for (const field of fields) {
          // Une correction faite depuis le chargement prévaut ; ne revenir que
          // sur une valeur qui est encore exactement celle de ce chargement.
          if ((p[field] || 0) === (newer[field] || 0)) p[field] = old[field] || 0;
        }
      }
      const globals = ['appearanceSerial', 'lastGroup', 'roundPeople', 'roundGroups',
        'tableServeCounts', 'duetCooldowns', 'roundUse', 'roundApps', 'roundOwed', 'recentGroups']
        .filter(field => field in after);
      const current = this._turnCreditState(sel);
      const matches = globals.every(field => JSON.stringify(current[field]) === JSON.stringify(after[field]));
      if (matches) {
        this.appearanceSerial = before.appearanceSerial;
        this.lastGroup = before.lastGroup;
        this.roundPeople = new Set(before.roundPeople);
        this.roundGroups = new Set(before.roundGroups);
        this.tableServeCounts = new Map(before.tableServeCounts);
        this.duetCooldowns = new Map(before.duetCooldowns);
        if (before.roundUse) this.roundUse = new Map(before.roundUse);
        if (before.roundApps) this.roundApps = new Map(before.roundApps);
        if (before.roundOwed) this.roundOwed = new Set(before.roundOwed);
        if (before.recentGroups) this.recentGroups = before.recentGroups.map(groups => [...groups]);
      } else {
        // Le passage n'a pas eu lieu : il ne compte plus dans le partage des tables.
        const groups = JSON.stringify(sel.groups || [sel.group]);
        for (let i = this.recentGroups.length - 1; i >= 0; i--) {
          if (JSON.stringify(this.recentGroups[i]) === groups) { this.recentGroups.splice(i, 1); break; }
        }
        // Ce passage n'a pas eu lieu : il ne compte plus dans le plafond du tour.
        if (after.roundApps) {
          const counted = new Map(after.roundApps);
          for (const pid of sel.ids) {
            const now = this.roundApps.get(pid) || 0;
            if (!now || now !== (counted.get(pid) || 0)) continue;
            if (now > 1) this.roundApps.set(pid, now - 1);
            else this.roundApps.delete(pid);
          }
        }
        // Une personne privée de passage au tour précédent le redevient.
        if (before.roundOwed && after.roundOwed && !sel.newPersonRound) {
          const wasOwed = new Set(before.roundOwed), stillOwed = new Set(after.roundOwed);
          for (const pid of sel.ids) {
            if (wasOwed.has(pid) && !stillOwed.has(pid) && this.people.has(pid)) this.roundOwed.add(pid);
          }
        }
        if (before.roundUse && after.roundUse) {
          const oldUse = new Map(before.roundUse), newUse = new Map(after.roundUse);
          for (const pid of sel.ids) {
            if ((this.roundUse.get(pid) || 0) !== (newUse.get(pid) || 0)) continue;
            if (oldUse.has(pid)) this.roundUse.set(pid, oldUse.get(pid));
            else this.roundUse.delete(pid);
          }
        }
        // Une autre intervention du bar a changé l'état entre-temps. Retirer
        // seulement le crédit de ce passage, sans effacer cette intervention.
        if (this.appearanceSerial === after.appearanceSerial) {
          this.appearanceSerial = before.appearanceSerial;
        }
        const beforePeople = new Set(before.roundPeople);
        if (!sel.newPersonRound) for (const pid of sel.ids) {
          if (!beforePeople.has(pid)) this.roundPeople.delete(pid);
        }
        const beforeGroups = new Set(before.roundGroups);
        if (!sel.newGroupRound) for (const group of (sel.groups || [sel.group])) {
          if (!beforeGroups.has(group)) this.roundGroups.delete(group);
        }
        const servedBefore = new Map(before.tableServeCounts);
        for (const group of (sel.groups || [sel.group])) {
          const old = servedBefore.get(group) || 0;
          const now = this.tableServeCounts.get(group) || 0;
          if (now > old) this.tableServeCounts.set(group, now - 1);
        }
        if (JSON.stringify(this.lastGroup) === JSON.stringify(after.lastGroup)) {
          this.lastGroup = before.lastGroup;
        }
        const oldCooldowns = new Map(before.duetCooldowns);
        const afterCooldowns = new Map(after.duetCooldowns);
        for (const pid of new Set([...oldCooldowns.keys(), ...afterCooldowns.keys()])) {
          if ((this.duetCooldowns.get(pid) || 0) !== (afterCooldowns.get(pid) || 0)) continue;
          if (oldCooldowns.has(pid)) this.duetCooldowns.set(pid, oldCooldowns.get(pid));
          else this.duetCooldowns.delete(pid);
        }
      }
      if (requeue) {
        const owner = this.people.get(sel.ids[0]);
        if (owner && !owner.withdrawnAt && before.qIndex >= 0 && this.Q.includes(owner.id)) {
          this._removeFromQ(owner.id);
          this.Q.splice(Math.min(before.qIndex, this.Q.length), 0, owner.id);
        }
      }
      credit.rolledBack = true;
    } else {
      // Compatibilité avec une soirée sauvegardée avant l'ajout de ce reçu.
      for (const pid of (sel.consumedIds || sel.ids)) {
        const p = this.people.get(pid);
        if (p) p.sung = Math.max(0, (p.sung || 0) - 1);
      }
      if (sel.kind === 'duo' && sel.ids[1]) {
        const guest = this.people.get(sel.ids[1]);
        if (guest) guest.duetGuestCount = Math.max(0, (guest.duetGuestCount || 0) - 1);
        this.duetCooldowns.delete(sel.ids[1]);
      }
    }
    this.version++;
    return true;
  }

  // Appelé quand la chanson a bien été ajoutée dans KaraFun. Le plan en cours
  // (Timefold ou ordre manuel) reste valable : ce passage était prévu.
  commit(sel) { return this._carryPlanAcross(() => this._commit(sel)); }

  _commit(sel) {
    const now = Date.now();
    this.manualChanges = [];
    const [first, second] = sel.ids;
    // Ceux qui étaient devant sans être prêts faute de confirmation : on compte, et au 2e raté on recule de 3
    if (this.opts.requirePresence) {
      // `sel.at` compte dans la file sans les titres retenus : la place réelle
      // du chanteur dans Q dit qui était devant lui. Un passage reporté
      // (« Pas prêt ») n'est pas une absence.
      const ownerAt = this.Q.indexOf(first);
      const limit = ownerAt >= 0 ? ownerAt : sel.at;
      const deferred = this._deferredPeople();
      for (let i = 0; i < limit && i < this.Q.length; i++) {
        const q = this.people.get(this.Q[i]);
        if (q && q.song && !deferred.has(q.id) && !this._isPresenceRetry(q) && !this._confirmedRecently(q) && !sel.ids.includes(q.id)) {
          q.held++;
          if (q.held >= 2) {
            const k = this.Q.indexOf(q.id);
            this.Q.splice(k, 1);
            this.Q.splice(Math.min(this.Q.length, k + 3), 0, q.id);
            q.held = 0;
            this.note(`${q.name} n'a pas confirmé sa présence : recule de 3 places`);
          }
        }
      }
    }
    const creditBefore = this._turnCreditState(sel);
    for (const pid of (sel.consumedIds || sel.ids)) {
      const p = this.people.get(pid);
      // L'inscription peut avoir été retirée pendant l'aller-retour vers KaraFun.
      if (!p || p.withdrawnAt) continue;
      this._removeFromQ(pid);
      this.Q.push(pid);
      p.over = 0; p.held = 0; p.sung++; p.lastSungAt = now; p.confirmedAt = 0;
      p.waitingSince = now + 2 * this.avgSlotSec() * 1000; // provisoire : son attente commence à la fin de sa chanson
    }
    const owner = this.people.get(first);
    const partner = second ? this.people.get(second) : null;
    // Le choix peut avoir changé pendant l'aller-retour réseau. On ne consomme
    // que l'entrée effectivement confirmée par KaraFun.
    if (owner) {
      if (owner.song && (owner.song.entryId ? owner.song.entryId === sel.song.entryId : owner.song === sel.song)) {
        owner.song = (owner.backlog || []).shift() || null;
      }
    }
    this._refreshDuetViews();
    const resets = sel.roundResets ?? (sel.newPersonRound ? 1 : 0);
    for (let k = 0; k < resets; k++) this._resetRound(this.roundPeople, this.roundUse, this.roundApps);
    if (resets) this.roundOwed = new Set((sel.owed || []).filter(pid => this.people.has(pid)));
    if (sel.newGroupRound) this.roundGroups.clear();
    sel.ids.forEach(pid => {
      this.roundOwed.delete(pid);
      if (!this.people.has(pid)) return;
      this._useRound(this.roundPeople, this.roundUse, pid);
      this.roundApps.set(pid, (this.roundApps.get(pid) || 0) + 1);
    });
    (sel.groups || [sel.group]).forEach(g => {
      this.roundGroups.add(g);
      this.tableServeCounts.set(g, (this.tableServeCounts.get(g) || 0) + 1);
    });
    this.recentGroups.push([...(sel.groups || [sel.group])]);
    if (this.recentGroups.length > HISTORY_LIMIT) this.recentGroups.splice(0, this.recentGroups.length - HISTORY_LIMIT);
    this.lastGroup = sel.groups || [sel.group];
    this._advanceCooldowns(this.duetCooldowns, sel);
    if (sel.kind === 'duo' && partner) partner.duetGuestCount = (partner.duetGuestCount || 0) + 1;
    this.appearanceSerial++;
    sel.ids.forEach(pid => {
      const p = this.people.get(pid);
      if (p) p.lastAppearanceTurn = this.appearanceSerial;
    });
    this.manualOrder = this.manualOrder.filter(pid => !sel.ids.includes(pid));
    if (!this.manualOrder.length) this.manualOrderActive = false;
    if (this.reservedNext?.personId === sel.ids[0]) this.releaseNext();
    // Monter sur scène efface les « Je suis là » manqués. Un titre passé faute
    // de présence devient le prochain annoncé, juste après ce passage.
    // Chaque passage envoyé rapproche aussi les titres reportés (« Pas
    // prêt ») ; le premier arrivé au bout de son report est annoncé ensuite.
    const deferralUndo = [];
    for (const pid of this._deferredOwners()) {
      const p = this.people.get(pid);
      deferralUndo.push({ pid, deferral: { ...p.deferral } });
      if (sel.ids.includes(pid)) p.deferral = null;
      else p.deferral.remaining = Math.max(0, p.deferral.remaining - 1);
    }
    for (const pid of sel.ids) {
      const p = this.people.get(pid);
      if (p) { p.presenceSkips = 0; p.presenceRetry = false; p.maybeGone = null; }
    }
    const [retry] = this._presenceRetries();
    if (retry && !this.reservedNext) {
      this.people.get(retry).presenceRetry = false;
      this.reservedNext = { personId: retry, reservedAt: Date.now() };
      sel.presenceRetryOf = retry; // à défaire si ce passage n'est finalement pas chanté
    }
    const ready = this._deferredOwners().find(pid => this.people.get(pid).deferral.remaining <= 0);
    if (ready && !this.reservedNext) {
      this.people.get(ready).deferral = null;
      this.reservedNext = { personId: ready, reservedAt: Date.now() };
      sel.deferralReleasedTo = ready;
    }
    if (deferralUndo.length) sel.deferralUndo = deferralUndo;
    sel.turnCredit = { before: creditBefore, after: this._turnCreditState(sel), rolledBack: false };
    this.note(`À suivre : ${sel.label} — « ${sel.song.title} »`, 'next');
  }

  // Historique réservé au bar : qui est réellement monté sur scène, pour
  // retrouver un visage ou marquer parti quelqu'un qui n'était pas là.
  recordStage(sel, at = Date.now()) {
    if (!sel?.song) return null;
    const entry = { id: id(), at, endedAt: null, ids: [...sel.ids],
      names: sel.ids.map(pid => this.people.get(pid)?.name || '?'),
      tableIds: sel.ids.map(pid => this.people.get(pid)?.tableId || null),
      title: sel.song.title, artist: sel.song.artist || '', entryId: sel.song.entryId || null,
      kind: sel.kind || (sel.ids.length > 1 ? 'duo' : 'solo') };
    // Duo noté au bar avant le début du titre : annulable depuis l'historique.
    if (sel.staffDuo) entry.staffDuo = sel.staffDuo;
    this.stageHistory.push(entry);
    if (this.stageHistory.length > 60) this.stageHistory.splice(0, this.stageHistory.length - 60);
    this.version++;
    return entry;
  }

  // Tout titre lancé dans KaraFun, même ajouté directement dans KaraFun ou en
  // Battle : la salle l'a entendu. Un même queueId n'est compté qu'une fois
  // (redémarrage de l'application ou pause pendant la chanson).
  recordPlayed(item, at = Date.now()) {
    const title = String(item?.title || '').slice(0, 100);
    if (!title) return null;
    const queueId = item.queueId == null ? null : String(item.queueId);
    const last = this.playedSongs.at(-1);
    if (last && queueId !== null && last.queueId === queueId) return null;
    const songId = Number(item.songId);
    const entry = { at, queueId, songId: Number.isSafeInteger(songId) && songId > 0 ? songId : null,
      title, artist: String(item.artist || '').slice(0, 80) };
    this.playedSongs.push(entry);
    if (this.playedSongs.length > PLAYED_LIMIT) this.playedSongs.splice(0, this.playedSongs.length - PLAYED_LIMIT);
    return entry;
  }

  // Le bar vide l'historique ; le passage en cours reste affiché.
  clearStageHistory(keepEntryIds = []) {
    const keep = new Set(keepEntryIds.filter(Boolean));
    const before = this.stageHistory.length;
    this.stageHistory = this.stageHistory.filter(item => !item.endedAt && keep.has(item.entryId));
    this.version++;
    return before - this.stageHistory.length;
  }

  endStage(sel, at = Date.now()) {
    const entryId = sel?.song?.entryId;
    const entry = [...this.stageHistory].reverse().find(item => !item.endedAt &&
      (entryId ? item.entryId === entryId : item.title === sel?.song?.title));
    if (entry) { entry.endedAt = at; this.version++; }
    return entry || null;
  }

  // Appelé quand la chanson est terminée : l'attente de ces personnes commence maintenant.
  songEnded(ids) {
    const now = Date.now();
    for (const pid of ids) {
      const p = this.people.get(pid);
      if (p) {
        if ((p.waitingSince || 0) > now) { p.waitingSince = now; p.over = 0; }
        p.confirmedAt = 0;
      }
    }
    this.version++;
  }

  // ------------------------------------------------------------------ durées et heures estimées
  recordSlot(seconds) {
    if (seconds > 60 && seconds < 900) {
      this.slotSamples.push(seconds);
      if (this.slotSamples.length > 20) this.slotSamples.shift();
    }
  }

  avgSlotSec() {
    if (this.slotSamples.length < 2) return this.opts.defaultSlotSec;
    return this.slotSamples.reduce((a, b) => a + b, 0) / this.slotSamples.length;
  }

  // Nombre de places en tête où aucun nouveau ne peut s'insérer : la 1re moitié de la file, plus
  // les N prochains qui attendent déjà depuis au moins une chanson (pas ceux qui viennent de chanter).
  guaranteedCount() {
    const n = this._justSangIndex();              // ceux qui viennent de chanter ne comptent pas
    let lo = Math.floor(n / 2);
    const slotMs = this.avgSlotSec() * 1000, now = Date.now();
    for (let i = 0; i < Math.min(n, this.opts.protectTop); i++) {
      const q = this.people.get(this.Q[i]);
      if (q && now - (q.waitingSince || 0) >= slotMs) lo = Math.max(lo, i + 1);
    }
    return lo;
  }

  // Liste dans l'ordre de passage prévu, avec position et heure estimée.
  // `songsBefore` = chansons déjà dans KaraFun avant la file ; `firstFreeAt` = fin estimée de la chanson en cours.
  view(songsBefore = 0, firstFreeAt = null) {
    const now = Date.now();
    const slot = this.avgSlotSec() * 1000;
    const base = firstFreeAt ? Math.max(now, firstFreeAt) : now;
    const g = this.guaranteedCount();
    const qIndex = new Map(this.Q.map((pid, i) => [pid, i]));
    const out = [];
    this.predict().forEach((sl, k) => {
      const eta = base + (songsBefore + k) * slot;
      for (const pid of sl.ids) {
        const p = this.people.get(pid);
        if (!p) continue;
        const t = this.table(p.tableId);
        const other = sl.ids.length > 1 ? sl.ids.find(x => x !== pid) : null;
        const owner = sl.ids.length > 1 && sl.ids[0] !== p.id ? this.people.get(sl.ids[0]) : null;
        out.push({
          pos: k + 1, qi: qIndex.get(pid), id: p.id, name: p.name, table: t ? t.name : '', tableId: p.tableId,
          song: sl.song || (owner ? owner.song : p.song),
          ready: owner ? !!owner.song : this.isReady(p),
          duetWith: other ? (this.people.get(other) || {}).name : null,
          pendingDuet: !!(p.duet && p.duet.state === 'pending'),
          isNew: p.sung === 0, guaranteed: k < g,
          over: p.over, cap: this.opts.cap, eta, hasPhoto: !!p.photo, sung: p.sung,
          confirmed: !!this._confirmedRecently(p),
        });
      }
    });
    return out;
  }
}

module.exports = { DEFER_MAX, Scheduler, DEFAULTS };
