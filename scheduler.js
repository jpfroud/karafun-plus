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

  manualOverrideState() {
    return { manualOrder: [...this.manualOrder], manualOrderActive: this.manualOrderActive,
      reservedNext: this.reservedNext ? { ...this.reservedNext } : null };
  }

  restoreManualOverride(state) {
    this.manualOrder = [...state.manualOrder];
    this.manualOrderActive = !!state.manualOrderActive && this.manualOrder.length > 0;
    this.reservedNext = state.reservedNext ? { ...state.reservedNext } : null;
  }

  // Les notes, photos et noms peuvent changer sans modifier la file. Cette
  // empreinte ne couvre que les données qui déterminent les places prévues.
  manualContextFingerprint() {
    const people = this.Q.map(pid => {
      const p = this.people.get(pid);
      return p ? [pid, p.group, p.withdrawnAt, p.sung, p.duetGuestCount || 0,
        p.lastAppearanceTurn || 0, !!p.presenceRetry,
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
        p.lastAppearanceTurn || 0, !!p.presenceRetry] : [pid];
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
    this.restoreManualOverride(latest.before);
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
    this.restoreManualOverride(this.manualChanges[0].before);
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

  staffIdentify(personId, note, verified) {
    const p = this.people.get(String(personId));
    if (!p) throw new Error('Chanteur inconnu.');
    const clean = String(note || '').replace(/\s+/g, ' ').trim();
    if (clean.length > 140) throw new Error('Description limitée à 140 caractères.');
    p.privateNote = clean;
    p.verifiedAt = verified ? (p.verifiedAt || Date.now()) : 0;
    // Les notes privées ne vont jamais dans le journal public.
    this.version++;
    return p;
  }

  leave(p) {
    // L'identité et l'historique des passages survivent au retrait. On ne
    // peut donc pas recréer un « nouveau » chanteur avec le même QR de table.
    this._removeDuetsForPerson(p, true);
    p.song = null; p.backlog = []; p.withdrawnAt = Date.now();
    p.presenceRetry = false; p.presenceSkips = 0; p.maybeGone = null;
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
  staffCountPartner(ownerId, partnerId, sel = null) {
    const owner = this.people.get(String(ownerId)), partner = this.people.get(String(partnerId));
    if (!owner || !partner || owner.id === partner.id || owner.withdrawnAt || partner.withdrawnAt) {
      throw new Error('Choisis un autre chanteur encore présent dans la salle.');
    }
    this.invalidateManualOrder();
    const row = this._creditRow(partner.id), serialBefore = this.appearanceSerial;
    this.duetCooldowns.set(partner.id, 2);
    partner.duetGuestCount = (partner.duetGuestCount || 0) + 1;
    partner.lastAppearanceTurn = owner.lastAppearanceTurn || ++this.appearanceSerial;
    this.roundPeople.add(partner.id);
    this.roundApps.set(partner.id, (this.roundApps.get(partner.id) || 0) + 1);
    this.roundOwed.delete(partner.id);
    if (sel?.turnCredit && !sel.turnCredit.rolledBack) this._addPartnerCredit(sel.turnCredit, partner.id, row, serialBefore);
    // Le passage annoncé qui ferait dépasser le plafond du tour à ce
    // partenaire est libéré : la file choisit à nouveau le suivant.
    const cap = this._roundCap();
    const reserved = this.people.get(this.reservedNext?.personId);
    if (reserved && cap > 0 && this.roundApps.get(partner.id) >= cap &&
        (reserved.id === partner.id || reserved.song?.duet?.partnerId === partner.id)) this.releaseNext();
    this.note(`Le bar a compté ${partner.name} en duo avec ${owner.name} : ${owner.name} dépense son tour ; ${partner.name} garde son titre mais attend deux autres chansons si possible`, 'staff');
    return partner;
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
    p.presenceSkips = (p.presenceSkips || 0) + 1;
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

  // Titres passés faute de présence, dans l'ordre de la file.
  _presenceRetries() {
    return this.Q.filter(pid => {
      const p = this.people.get(pid);
      return p && !p.withdrawnAt && p.presenceRetry && p.song;
    });
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
    const [item] = visible.splice(i, 1);
    visible.splice(target, 0, item);
    // Un titre déjà en cours d'envoi peut encore porter l'ancienne réservation.
    // Réordonner les titres suivants ne doit pas toucher à cette commande.
    if (target === 0 && visible[0]) {
      // Le bar avance explicitement ce passage. Cette dérogation unique peut
      // dépasser l'équité des premiers passages ; l'ordre mémorisé des autres
      // lignes ne le peut pas.
      this.reservedNext = { personId: visible[0].ids[0], reservedAt: Date.now() };
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
        reservedNext: state.reservedNext?.personId === p.id ? null : state.reservedNext };
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
    if (rows[1] && this.people.get(rows[1].owner)?.presenceRetry) pinnedUntil = 2;
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
  // abandonnés (le prochain annoncé reste garanti) et Timefold dispose de son
  // budget maximal, sans attendre la fenêtre de regroupement.
  forceReplan(budgetMs = 30000) {
    const manual = this.manualOrderActive || this.solverPlan?.source === 'manual';
    this.invalidateManualOrder();
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
    recentTurns = null, sim = null) {
    const idx = new Map(order.map((pid, i) => [pid, i]));
    const cands = [];
    for (const pid of order) {
      const p = this.people.get(pid);
      if (!p || p.withdrawnAt) continue;
      const song = projectedSongs ? projectedSongs.get(pid) : p.song;
      const duet = song?.duet;
      const owner = duet && duet.state === 'accepted' ? p : null;
      if (owner) {
        const partner = this.people.get(duet.partnerId);
        if (partner && !partner.withdrawnAt) {
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
      if (!p || p.withdrawnAt || !p.song || duet?.state === 'pending' ||
          (duet?.state === 'accepted' && (!guest || guest.withdrawnAt))) {
        this.releaseNext();
      } else if (this.opts.requirePresence && !this.confirmedForTurn(
        guest ? [p.id, guest.id] : [p.id])) {
        // Le prochain annoncé attend sa confirmation. Envoyer C à sa place
        // ferait mentir l'annonce faite à B et à toute la salle.
        return null;
      }
    }
    // Un titre passé faute de présence laisse passer le suivant (voir _forecast).
    const retries = new Set(this._presenceRetries());
    const order = retries.size ? this.Q.filter(pid => !retries.has(pid)) : this.Q;
    const c = this._pick(order, this.lastGroup, false,
      this.roundGroups, this.roundPeople, this.tableServeCounts, this.duetCooldowns,
      null, this.reservedNext);
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
    const visible = this.presenceView(excludeIds, provisional).filter(v => !v.future);
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
    // puis devient le prochain annoncé (comme _commit le fait réellement).
    const retries = this._presenceRetries().filter(pid => remaining.includes(pid) && !pendingIds.has(pid));
    const held = new Set(retries);
    const releaseRetry = () => {
      const pid = retries.shift();
      held.delete(pid);
      return { personId: pid };
    };
    if (provisional && retries.length && !reservation) reservation = releaseRetry();
    while (remaining.length) {
      const order = held.size ? remaining.filter(pid => !held.has(pid)) : remaining;
      let c = order.length ? this._pick(order, last, predict, round, roundPeople, served,
        cooldowns, songs, reservation, appearances, ignorePresence, recentTurns,
        { roundUse, roundApps, roundOwed, history, serial: appearanceTurn, ranks }) : null;
      if (!c && held.size) {
        // Plus aucun autre passage possible : le titre passé revient tout de suite.
        reservation = releaseRetry();
        continue;
      }
      if (!c) break;
      reservation = null;
      if (retries.length) {
        c.ids.forEach(pid => { if (held.delete(pid)) retries.splice(retries.indexOf(pid), 1); });
        if (retries.length) reservation = releaseRetry();
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

  rollbackUnplayed(sel, { requeue = false } = {}) {
    const credit = sel?.turnCredit;
    if (credit?.rolledBack) return false;
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
      for (let i = 0; i < sel.at && i < this.Q.length; i++) {
        const q = this.people.get(this.Q[i]);
        if (q && q.song && !q.presenceRetry && !this._confirmedRecently(q) && !sel.ids.includes(q.id)) {
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
    for (const pid of sel.ids) {
      const p = this.people.get(pid);
      if (p) { p.presenceSkips = 0; p.presenceRetry = false; p.maybeGone = null; }
    }
    const [retry] = this._presenceRetries();
    if (retry && !this.reservedNext) {
      this.people.get(retry).presenceRetry = false;
      this.reservedNext = { personId: retry, reservedAt: Date.now() };
    }
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

module.exports = { Scheduler, DEFAULTS };
