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
 *   Une invitation sans réponse ne retient jamais le titre : il garde sa place
 *   et, à son tour, part en solo ; l'invitation expire alors.
 * - Présence sur scène : au plus deux passages par personne et par tour, quel
 *   que soit son rôle (son titre ou invitée d'un duo) ; au-delà, le duo attend
 *   le tour suivant. Au moins trois autres chansons entre deux passages d'une
 *   même personne quand un autre passage du tour le permet.
 * - Table plafonnée à son nombre de personnes (anti faux noms / navigation privée).
 * - Dans un tour, les tables se partagent les passages selon le mode : au
 *   prorata des chanteurs (par défaut), à parts égales, ou entre les deux.
 *   La même table ne reprend pas le micro quand une autre peut chanter (en
 *   « Chacun son tour », sauf pour respecter la patience). En compromis, la
 *   taille d'une table est son nombre de chanteurs inscrits (titre en attente
 *   ou déjà chanté ce soir).
 * - Patience : personne ne voit quelqu'un chanter deux fois pendant sa propre
 *   attente quand un autre passage permis l'évite. Selon le mode (choix du
 *   bar après le 12 octobre) : « Chacun son tour » la fait passer avant la
 *   règle des tables ; « Tables à tour de rôle » et « Compromis » après. Un
 *   bonus peut doubler, mais pas juste après sa chanson ; un malus n'est pas
 *   protégé. Un titre échangé (retrait du dernier titre puis ajout, sans
 *   passage entre les deux, ticket resté dans la file) garde l'attente en cours.
 * - Le bar peut accorder un bonus ou un malus (niveaux -3 à +3) à une table
 *   ou à une personne : il change la fréquence de passage, jamais la priorité
 *   des premiers passages. Les clients ne le voient pas.
 */
const { crypto, TimefoldBridge, DEFAULTS, bonusWeight, HISTORY_LIMIT, DEFER_MAX, INBOX_MAX, INBOX_TTL_MS, EPS, id, token } = require('./lib/scheduler/common');

class Scheduler {
  // Prénom : 24 caractères au plus ; deux prénoms sont les mêmes à la casse
  // près (validName, nameRivals, reprise d'une sauvegarde dans night-state.js).
  static NAME_MAX = 24;
  static nameKey(name) { return String(name).toLocaleLowerCase('fr'); }

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
    this._views = new Map();  // prévisions déjà calculées pour l'état courant (readyView)
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
    // Journal de soirée : branché par le serveur (voir evening-journal.js).
    this.onEvent = null;
  }

  // Événement du journal de soirée : identifiants seulement, jamais de prénom.
  // Une erreur du journal ne doit jamais empêcher une action de la file.
  _event(type, fields = {}) {
    if (typeof this.onEvent !== 'function') return;
    try { this.onEvent(type, fields); } catch (_) { /* journal au mieux */ }
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
    this._event('table.bonus', { tableId: t.id, level: t.bonus });
    return t;
  }

  setPersonBonus(personId, level) {
    const p = this.people.get(String(personId));
    if (!p) throw new Error('Chanteur inconnu.');
    p.bonus = this.bonusLevel(level);
    this.version++;
    this._event('person.bonus', { personId: p.id, level: p.bonus });
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

  // `owners` : groupe → première personne de ce groupe (_groupOwners), pour
  // ne pas reparcourir toutes les personnes à chaque groupe.
  tableWeight(group, owners = null) {
    const person = owners ? owners.get(group) : [...this.people.values()].find(p => p.group === group);
    const tableId = person ? person.tableId : group;
    return bonusWeight(this.tables.get(tableId)?.bonus);
  }

  _groupOwners() {
    const owners = new Map();
    for (const p of this.people.values()) if (!owners.has(p.group)) owners.set(p.group, p);
    return owners;
  }

  personWeight(pid) {
    const p = this.people.get(pid);
    if (!p) return 1;
    return bonusWeight(p.bonus) * bonusWeight(this.tables.get(p.tableId)?.bonus);
  }

  // Un passage consomme 1/poids de crédit de tour. Sans bonus ni malus, cela
  // revient exactement à « une fois par tour » (ensemble roundPeople).
  // `borrowed` : passage accordé par la règle anti-série à une personne déjà
  // passée dans ce tour. Il est pris sur son tour suivant (dette), comme un
  // malus : sans cela, ce second passage était gratuit et la personne
  // repassait aussi tôt que les autres au tour suivant (un soliste deux fois
  // pendant une attente de 65 min, soirée du 10 octobre). Le prochain annoncé
  // quand le tour semblait fini, puis rattrapé par une arrivée, est dans le
  // même cas (`reservedNext.borrowable`). Sans bonus ni malus, un passage non emprunté
  // d'une personne déjà comptée dans le tour (invitée de duo, ordre du bar)
  // ne coûte rien de plus, dette en cours ou non.
  // Rend la hausse de roundUse (0 quand seul roundPeople change), pour que
  // le retrait d'une invitée rende exactement ce qui a été ajouté.
  _useRound(roundPeople, roundUse, pid, borrowed = false) {
    const cost = 1 / this.personWeight(pid);
    if (Math.abs(cost - 1) < EPS && !borrowed && roundPeople.has(pid)) return 0;
    const already = borrowed && roundPeople.has(pid);
    if (Math.abs(cost - 1) < EPS && !roundUse.has(pid) && !already) { roundPeople.add(pid); return 0; }
    const previous = roundUse.get(pid) || 0;
    const used = (roundUse.get(pid) ?? (already ? 1 : 0)) + cost;
    roundUse.set(pid, used);
    if (used >= 1 - EPS) roundPeople.add(pid);
    return used - previous;
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

  // ------------------------------------------------------------------ messages
  // Ce que le téléphone d'une personne ne peut pas déduire de la file : duo
  // refusé, annulé ou quitté, demande de duo expirée, titre retiré… Seul le
  // téléphone qui gère la personne les voit, pendant une demi-heure.
  notify(personId, kind, params = {}) {
    const p = this.people.get(String(personId || ''));
    if (!p) return null;
    const now = Date.now();
    const notice = { id: id(), kind: String(kind), params: { ...params }, at: now };
    p.inbox = [...this.inboxOf(p, now), notice].slice(-INBOX_MAX);
    this.version++;
    this._event?.('notice.sent', { personId: p.id, kind: notice.kind });
    return notice;
  }

  inboxOf(p, now = Date.now()) {
    return (Array.isArray(p?.inbox) ? p.inbox : []).filter(n => n && typeof n.id === 'string' &&
      Number.isFinite(n.at) && now - n.at < INBOX_TTL_MS);
  }

  ackNotices(p, ids) {
    const seen = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    const before = this.inboxOf(p);
    p.inbox = before.filter(n => !seen.has(n.id));
    if (p.inbox.length !== before.length) this.version++;
    return before.length - p.inbox.length;
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
  // une inscription sans titre ne relancent donc pas Timefold. En
  // « Compromis », la part d'une table suit ses chanteurs inscrits
  // (_registeredWeights) : un départ ou un premier titre à une table qui a un
  // titre prêt la relance, pas un changement à une table sans titre prêt.
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
    // Tailles envoyées au solveur (groupSizes) : tables des passages prévus.
    const sized = new Set([...relevant].map(pid => this.people.get(pid)?.group));
    const context = { entries, physical, lastGroup: this.lastGroup,
      roundGroups: [...this.roundGroups], roundPeople: [...this.roundPeople],
      roundUse: [...this.roundUse], roundApps: [...this.roundApps], roundOwed: [...this.roundOwed],
      recentGroups: this.recentGroups.slice(-HISTORY_LIMIT),
      duetCooldowns: [...this.duetCooldowns],
      rotation: [!!this.opts.tableRotation, !!this.opts.weightedTables, this.opts.interleaveArrivals !== false],
      appearanceSerial: this.appearanceSerial, bonus: this._bonusContext(),
      registered: this.opts.tableRotation && this.opts.weightedTables ?
        [...this._registeredWeights()].filter(([group]) => sized.has(group)) : null,
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
    this._event('staff.undo', { changeId: latest.id || null, kind: latest.kind, personId: latest.personId || null });
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
    this._event('staff.recalculate', { count });
    this.note(`Le bar a annulé ${count} changement${count > 1 ? 's' : ''} manuel${count > 1 ? 's' : ''} dans la file`, 'staff');
    return count;
  }

  // ------------------------------------------------------------------ tables
  table(tableId, create = true) {
    const key = String(tableId).trim().slice(0, 20);
    if (!this.tables.has(key) && create) {
      this.tables.set(key, { id: key, name: /^\d+$/.test(key) ? `Table ${key}` : key, headcount: null, individual: /^comptoir/i.test(key), createdAt: Date.now() });
      this._event('table.opened', { tableId: key, individual: this.tables.get(key).individual });
    }
    return this.tables.get(key);
  }

  setHeadcount(tableId, n, by = 'staff') {
    const t = this.table(tableId);
    const v = Math.max(1, Math.min(40, parseInt(n, 10) || 1));
    t.headcount = v;
    this._event('table.headcount', { tableId: t.id, n: v, by });
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
      this._event('table.renamed', { tableId: t.id });
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
    const songsDropped = gone.reduce((n, p) => n + this.songsOf(p).length, 0);
    // Les personnes des autres tables apprennent, comme pour un départ
    // marqué personne par personne, la fin de leurs duos et demandes.
    const goneIds = new Set(gone.map(p => p.id));
    const staying = pid => !goneIds.has(pid);
    for (const p of gone) {
      this._removeDuetsForPerson(p, staying);
      this._songsGone(p, this.songsOf(p), staying);
    }
    gone.forEach(p => this._drop(p, false));
    this._event('table.left', { tableId: t.id, personIds: gone.map(p => p.id), songsDropped });
    this.tables.delete(tableId);
    this.note(`${t.name} est partie : ${gone.length} ticket${gone.length > 1 ? 's' : ''} retiré${gone.length > 1 ? 's' : ''}`);
  }

  // ------------------------------------------------------------------ personnes
  // `nameRequired` : personne créée à l'ouverture d'un QR (prénom provisoire
  // « Solo 3 »). Son inscription n'est notée qu'à son premier vrai prénom.
  join({ tableId, name, photo, headcount, nameRequired = false }) {
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
      privateNote: '', withdrawnAt: null, lastAppearanceTurn: 0,
    };
    p.group = t.individual ? `${t.id}#${p.id}` : t.id;
    if (nameRequired) p.nameRequired = true;
    this.people.set(p.id, p);
    this.byToken.set(p.token, p.id);
    if (nameRequired) {
      this.note(`${t.name} : QR ouvert, prénom à saisir (${p.name})`);
      return p;
    }
    this._event('person.joined', { personId: p.id, tableId: t.id });
    this.note(`${this.personRef(p)} s'est inscrit`);
    return p;
  }

  person(tok) {
    const pid = this.byToken.get(tok);
    return pid ? this.people.get(pid) : null;
  }

  validName(name, tableId, exceptId = null) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('Indique ton prénom.');
    if (clean.length > Scheduler.NAME_MAX) throw new Error('Prénom limité à 24 caractères.');
    // Un soliste est nommé par son seul prénom dans KaraFun : celui-ci se
    // confondrait avec la Battle (voir server.js, détection de la Battle).
    if (clean.toLocaleLowerCase('fr') === 'battle collective') {
      const e = new Error('Ce prénom est réservé à la Battle. Choisis un autre prénom.');
      e.code = 'NAME_RESERVED'; throw e;
    }
    // « · » sépare le prénom de la table dans le nom d'un passage : un
    // soliste « Max · Table 4 » passerait pour Max de la Table 4. Les points
    // médians qui lui ressemblent (•, ∙, ⋅, ・) sont refusés aussi.
    if (/[\u00B7\u0387\u2022\u2219\u22C5\u30FB\uFF65]/.test(clean)) {
      const e = new Error('Le prénom ne peut pas contenir « · ».');
      e.code = 'NAME_INVALID'; throw e;
    }
    const individual = !!this.table(tableId, false)?.individual;
    if (this.nameRivals(tableId, exceptId).some(p => Scheduler.nameKey(p.name) === Scheduler.nameKey(clean))) {
      const e = new Error(individual ? 'Ce prénom est déjà inscrit ce soir. Ajoute l’initiale de ton nom (ex. Marie L.).' :
        'Ce prénom est déjà inscrit à cette table. Utilise la fiche existante ou précise le nom.');
      e.code = 'NAME_TAKEN'; throw e;
    }
    return clean;
  }

  // Personnes dont le prénom doit différer : la même table, ou, pour un
  // soliste, tous les solistes de tous les groupes individuels (nommés par
  // leur seul prénom, deux « Léa » seraient indiscernables).
  nameRivals(tableId, exceptId = null) {
    const individual = !!this.table(tableId, false)?.individual;
    return [...this.people.values()].filter(p => p.id !== exceptId &&
      (individual ? !!this.table(p.tableId, false)?.individual : p.tableId === tableId));
  }

  // Tables nommées d'un passage : celles de ses personnes, sans les groupes
  // individuels (« En solo »), sans doublon, dans l'ordre des personnes.
  passageTables(ids = []) {
    const names = [];
    for (const pid of ids || []) {
      const p = this.people.get(String(pid));
      const t = p && this.table(p.tableId, false);
      if (t && !t.individual && !names.includes(t.name)) names.push(t.name);
    }
    return names;
  }

  // Nom d'un passage, sur l'écran de KaraFun comme sur les téléphones et la
  // page du bar : prénoms joints par « & », puis les tables non individuelles.
  // « Léa », « Léa & Sam », « Léa & Max · Table 4 », « Max & Zoé · Table 4 + Table 2 ».
  passageLabel(ids = []) {
    const names = (ids || []).map(pid => this.people.get(String(pid))?.name).filter(Boolean).join(' & ');
    const tables = this.passageTables(ids);
    return tables.length ? `${names} · ${tables.join(' + ')}` : names;
  }

  // Une personne dans le journal du bar : « Léa » pour un soliste, « Max
  // (Table 4) » à une table.
  personRef(p) {
    const t = p && this.table(p.tableId, false);
    return t && !t.individual ? `${p.name} (${t.name})` : (p?.name || '');
  }

  rename(p, name) {
    const next = this.validName(name, p.tableId, p.id);
    if (p.nameRequired) {
      // Premier vrai prénom : c'est maintenant que la personne s'inscrit.
      p.name = next;
      delete p.nameRequired;
      this.version++;
      this._event('person.joined', { personId: p.id, tableId: p.tableId });
      this.note(`${this.personRef(p)} s'est inscrit`);
      return p;
    }
    if (next === p.name) return p;
    const before = this.personRef(p);
    p.name = next;
    this._event('person.renamed', { personId: p.id });
    this.note(`${before} s'appelle maintenant ${next}`);
    return p;
  }

  // Repère privé noté par le bar : un indice pour reconnaître la personne plus
  // tard (« t-shirt rouge »), rien de plus. `note` absent : repère inchangé.
  setPrivateNote(personId, note) {
    const p = this.people.get(String(personId));
    if (!p) throw new Error('Chanteur inconnu.');
    const clean = note === undefined ? (p.privateNote || '') : String(note || '').replace(/\s+/g, ' ').trim();
    if (clean.length > 140) throw new Error('Description limitée à 140 caractères.');
    p.privateNote = clean;
    // Les notes privées ne vont jamais dans le journal public.
    this.version++;
    return p;
  }

  // `by` : « self » (la personne), « staff » (marquée partie par le bar).
  leave(p, by = 'self') {
    // L'identité et l'historique des passages survivent au retrait. On ne
    // peut donc pas recréer un « nouveau » chanteur avec le même QR de table.
    const songsDropped = this.songsOf(p).length;
    this._removeDuetsForPerson(p, true);
    this._songsGone(p, this.songsOf(p));
    p.song = null; p.backlog = []; p.withdrawnAt = Date.now();
    // Auteur du départ (sauvegardé) : partie d'elle-même, une personne venue
    // par l'événement privé garde sa fiche dans le plafond des fiches
    // (private-event.js, held) ; marquée partie par le bar, elle la libère.
    // Sa photo (400 Ko au plus) est libérée : une fiche partie ne la garde
    // ni en mémoire ni dans chaque sauvegarde.
    p.withdrawnBy = by;
    p.photo = null;
    p.presenceRetry = false; p.presenceSkips = 0; p.maybeGone = null; p.deferral = null;
    // Clé personnelle d'un QR individuel (server.js, keyHolder) : un départ la
    // révoque pour de bon, « Réactiver » ne la ranime pas (décision du gérant).
    if (p.soloKeyHash) p.soloKeyRevoked = true;
    this._removeFromQ(p.id);
    if (this.reservedNext?.personId === p.id) this.releaseNext();
    this.invalidateManualOrder();
    this._event('person.left', { personId: p.id, by, songsDropped });
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
    // Entrée du titre. Champ facultatif ajouté ensuite : `settings` (voir setSongSettings).
    const next = { entryId: id(), songId: Number(song.songId), title: String(song.title || '').slice(0, 80), artist: String(song.artist || '').slice(0, 60), img: song.img || null, duration: song.duration || null };
    if (!Number.isSafeInteger(next.songId) || next.songId <= 0 || !next.title) throw new Error('Chanson invalide.');
    if (mode === 'append' && this.songsOf(p).some(s => s.songId === next.songId)) {
      const e = new Error('Cette chanson est déjà dans la liste de ce chanteur.'); e.code = 'ALREADY_LISTED'; throw e;
    }
    if (mode === 'append' && this.songsOf(p).length >= 20) {
      const e = new Error('La liste est limitée à 20 chansons par chanteur.'); e.code = 'LIST_FULL'; throw e;
    }
    this.invalidateManualOrder();
    const replaced = mode === 'replace' ? this.songsOf(p).map(s => s.entryId) : [];
    // Début de l'attente pour ce titre : ceux qui ont chanté avant ne sont pas
    // passés « devant » cette personne (voir l'anti-série et la patience de
    // _pick). Un titre échangé (retrait du dernier titre puis ajout, sans
    // passage entre les deux) garde l'attente en cours.
    // Échange seulement si le ticket est resté dans la file : « Je pars » et
    // « Vider toutes les chansons » la vident, et l'attente recommence.
    const swapped = p.emptiedAt === this.appearanceSerial && this.Q.includes(p.id) && !p.withdrawnAt;
    if (!this.songsOf(p).length && !swapped) p.readySerial = this.appearanceSerial;
    delete p.emptiedAt;
    if (mode === 'append' && p.song) p.backlog.push(next);
    else {
      if (mode === 'replace') {
        this._songsGone(p, this.songsOf(p));
        p.backlog = [];
      }
      p.song = next;
    }
    p.withdrawnAt = null;
    this._refreshDuetViews();
    const listed = this.songsOf(p);
    this._event('song.requested', { personId: p.id, entryId: next.entryId, songId: next.songId, title: next.title,
      artist: next.artist, durationSec: Number(next.duration) > 0 ? Number(next.duration) : null,
      mode, listIndex: listed.indexOf(next), listLength: listed.length, replacedEntryIds: replaced,
      startsWait: !this.Q.includes(p.id) });
    if (!this.Q.includes(p.id)) {
      const pos = this._placeNewcomer(p);
      this._event('queue.entered', { personId: p.id, position: pos, queueLength: this.Q.length });
      this.note(`${this.personRef(p)} entre dans la file en ${pos === 0 ? '1re' : (pos + 1) + 'e'} position`);
    } else {
      this.note(`${p.name} a ${mode === 'append' ? 'ajouté à sa liste' : 'choisi'} « ${next.title} »`);
    }
    this.version++;
  }

  // `by` : « self », ou « presence-max » (« Je suis là » manqué trop souvent).
  removeSong(p, entryId, by = 'self') {
    const key = String(entryId || '');
    if (p.song && p.song.entryId === key) {
      this._songsGone(p, [p.song]);
      p.song = (p.backlog || []).shift() || null;
      // Un titre retiré faute de « Je suis là » n'ouvre pas d'échange : le
      // titre suivant commence une nouvelle attente.
      if (by !== 'presence-max') this._noteEmptied(p);
    } else {
      const i = (p.backlog || []).findIndex(s => s.entryId === key);
      if (i < 0) throw new Error('Chanson introuvable dans la liste.');
      this._songsGone(p, p.backlog.splice(i, 1));
    }
    this.invalidateManualOrder();
    this._refreshDuetViews();
    if (this.reservedNext?.personId === p.id && !p.song) this.releaseNext();
    this._event('song.removed', { personId: p.id, entryId: key, by });
    this.note(`${p.name} a retiré une chanson de sa liste`);
  }

  // Liste vidée par un retrait : un titre rechoisi avant le passage suivant
  // reprend la même attente (voir chooseSong).
  _noteEmptied(p) {
    if (!this.songsOf(p).length) p.emptiedAt = this.appearanceSerial;
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
    this._event('song.reordered', { personId: p.id, entryId: moved.entryId, fromIndex: from, toIndex: to });
    this.note(`${p.name} a réordonné sa liste de chansons`);
  }

  // Réglages du titre (tonalité, tempo, voix guide, chœurs) : champ facultatif
  // `settings` de l'entrée créée par chooseSong, déjà validé par
  // song-settings.js. Absent : réglages de KaraFun par défaut. L'entrée est
  // le même objet partout où le titre voyage (envoi, retour, sauvegarde).
  setSongSettings(song, settings) {
    if (settings) song.settings = { ...settings, ...(settings.guideVoices ? { guideVoices: { ...settings.guideVoices } } : {}) };
    else delete song.settings;
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

// La classe est répartie par thème dans lib/scheduler/ : chaque fichier
// déclare une classe de méthodes, recopiées ici sur Scheduler.prototype.
for (const part of ['duets', 'presence', 'staff', 'solver', 'rotation', 'passages']) {
  const methods = Object.getOwnPropertyDescriptors(require(`./lib/scheduler/${part}`).prototype);
  for (const [name, descriptor] of Object.entries(methods)) {
    if (name === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(Scheduler.prototype, name)) throw new Error(`Méthode en double : ${name}`);
    Object.defineProperty(Scheduler.prototype, name, descriptor);
  }
}

module.exports = { DEFER_MAX, Scheduler, DEFAULTS };
