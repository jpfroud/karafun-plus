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
 * - Un geste du bar (déplacement, « Priorité ») passe avant le calcul : la
 *   ligne placée et celles devant elle gardent leur ordre jusqu'au départ de
 *   leur titre vers KaraFun ; titres ajoutés, arrivées et Timefold ne
 *   passent jamais devant (staffMove, _unpinManual).
 * - Pas de chanson prête à son tour : on garde sa place, les suivants passent ; dès qu'on
 *   choisit, on passe au prochain tour. Jamais de cumul (un seul ticket).
 * - Duo : le partenaire accepte l'invitation ; seul l'initiateur dépense son
 *   ticket. Le partenaire garde son titre, avec deux passages de répit si possible.
 *   Une invitation sans réponse ne retient jamais le titre : il garde sa place
 *   et, à son tour, part en solo ; l'invitation expire alors. Un duo ouvert
 *   (sans partenaire, proposé à toute la salle) fait de même, sauf en « Duos
 *   uniquement », où il attend ; le premier volontaire devient l'invité.
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
 * - Premiers passages : les tables tournent, premier de chaque table (décision
 *   du gérant du 26 octobre). En « Chacun son tour », un cycle où chaque table
 *   (chaque soliste « En solo » est la sienne) fait passer une personne : les
 *   tables dans l'ordre d'ajout de leur prochain titre, dans une table ses
 *   personnes dans l'ordre d'ajout (heure où l'attente a commencé, celle de
 *   l'auteur pour un duo) ; avant la règle des tables, qui ne fait plus que
 *   départager. Dans les modes de tables, l'ordre d'ajout départage les
 *   passages de même part.
 * - Patience : personne ne voit quelqu'un chanter deux fois pendant sa propre
 *   attente quand un autre passage permis l'évite. Selon le mode (choix du
 *   bar après le 12 octobre) : « Chacun son tour » la fait passer avant la
 *   règle des tables, puis, à patience égale, la plus ancienne attente
 *   (dernier passage, ou demande après une liste vide ; une demande faite
 *   pendant l'envoi d'un passage compte d'avant lui ; à compteur égal, à
 *   l'heure : la fin du passage, les demandes à leur heure) ; « Tables à
 *   tour de rôle » et « Compromis » après la règle des tables. Un
 *   bonus peut doubler, mais pas juste après sa chanson ; un malus n'est pas
 *   protégé. Un titre échangé (retrait du dernier titre puis ajout, sans
 *   passage entre les deux, ticket resté dans la file) garde l'attente en cours.
 * - Le bar peut accorder un bonus ou un malus (niveaux -3 à +3) à une table
 *   ou à une personne : il change la fréquence de passage, jamais la priorité
 *   des premiers passages. Les clients ne le voient pas. Les passages en plus
 *   d'un bonus sont étalés : environ n/poids chansons entre deux passages (n :
 *   personnes du tour), et non deux passages rapprochés puis un tour d'attente.
 *   Seuls les titres de la personne sont retenus : invitée d'un duo, elle ne
 *   retarde pas la personne qui l'invite.
 */
const { crypto, TimefoldBridge, DEFAULTS, bonusWeight, HISTORY_LIMIT, DEFER_MAX, INBOX_MAX, INBOX_TTL_MS, EPS, id, token,
  SONG_GAP_MAX_SEC, SONG_GAP_SAMPLES, SONG_GAP_MIN_SAMPLES, BEHIND_MAX } = require('./lib/scheduler/common');

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
    this.manualOrder = [];    // ordre fixé par le bar : jusqu'à la dernière ligne qu'il a placée, celle-ci comprise
    this.manualOrderActive = false; // ordre fixé en vigueur, jusqu'au départ de ses lignes vers KaraFun
    this.manualChanges = [];  // gestes du bar encore valables et annulables, du plus ancien au plus récent
    this.manualEpoch = 0;     // abandons de tous les gestes par le bar (« Recalculer la file »…), voir _restorePlaced
    this.tableServeCounts = new Map(); // passages par groupe (historique, affichage)
    this.recentGroups = [];   // groupes des derniers passages, pour le partage entre tables
    this.roundUse = new Map(); // crédit de tour consommé par les personnes avec bonus/malus
    this.roundApps = new Map(); // passages sur scène de chaque personne dans le tour, invitées comprises
    this.roundOwed = new Set(); // privées de passage par le plafond au tour précédent : en tête du tour
    this.firstCycle = new Set(); // tables déjà passées dans le cycle en cours des premiers passages
    this.unstartedTurn = 0;   // tour du passage envoyé à KaraFun pas encore commencé sur scène (0 : aucun)
    this.stageEnds = new Map(); // tour d'un passage fini sur scène → heure de sa fin (début d'attente de ses chanteurs)
    this.duetCooldowns = new Map(); // invité : nombre d'autres chansons à laisser passer
    this.reservedNext = null; // personne annoncée comme prochain passage, hors KaraFun
    this.stageHistory = [];   // derniers passages sur scène (bar uniquement)
    this.playedSongs = [];    // titres lancés dans KaraFun, y compris hors file, pour les doublons
    this.log = [];            // journal visible par tous
    this.slotSamples = [];    // durées réelles mesurées (s)
    this.songGapSamples = []; // écarts mesurés entre la fin d'un titre et le début du suivant (s)
    this._views = new Map();  // prévisions déjà calculées pour l'état courant (readyView)
    this.version = 0;
    this.appearanceSerial = 0; // passages physiques, invités de duo compris
    // Départs de tables (dernière personne partie), numérotés : un reçu de
    // passage note le dernier numéro (`departures`) ; une table partie après
    // lui ne revient pas dans le tour qu'il rend, rouverte ou non
    // (_presentGroups).
    this.departureSerial = 0;
    this.groupDepartures = new Map(); // table -> numéro de son dernier départ
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
    // « Duos uniquement » du bar (settings.duoOnly) : branché par le serveur.
    this.duoOnlyRule = null;
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
  // même cas (`reservedNext.borrowable`). Une dette pèse sur les titres du
  // débiteur : invité du duo d'un auteur encore neuf dans le tour, il ne
  // retarde pas cet auteur (`inRound` dans `_pick`). Sans bonus ni malus, un
  // passage non emprunté d'une personne déjà comptée dans le tour (invitée de
  // duo, ordre du bar) ne coûte rien de plus, dette en cours ou non.
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

  // Tous les gestes du bar tombent : « Recalculer la file », « Vider toutes
  // les chansons », nouvelle soirée. Rien d'autre ne les efface d'un coup.
  // Ceux qu'un duo avait terminés aussi : gardés dans un reçu, ils ne
  // reviennent plus (`manualEpoch`, _restorePlaced).
  invalidateManualOrder() {
    this.manualOrder = [];
    this.manualOrderActive = false;
    this.manualChanges = [];
    this.manualEpoch = (this.manualEpoch || 0) + 1;
  }

  // Lignes placées par le bar (déplacement, priorité) : celles de ses gestes
  // encore valables. Un ordre fixé sans geste noté (ancienne sauvegarde) vaut
  // pour toutes ses lignes.
  _manualAnchors() {
    const anchors = new Set(this.manualChanges.map(change => change.personId));
    return anchors.size ? anchors : new Set(this.manualOrder);
  }

  // L'ordre fixé s'arrête à la dernière ligne placée par le bar : les lignes
  // gardées devant un geste disparu retrouvent le calcul.
  _trimManualOrder() {
    const anchors = new Set(this.manualChanges.map(change => change.personId));
    let last = -1;
    this.manualOrder.forEach((pid, index) => { if (anchors.has(pid)) last = index; });
    this.manualOrder = this.manualOrder.slice(0, last + 1);
    this.manualOrderActive = this.manualOrderActive && this.manualOrder.length > 0;
  }

  // Une ligne de l'ordre fixé prend fin : son titre part vers KaraFun, sa
  // liste est vide, la personne part. Elle quitte l'ordre fixé et ses gestes
  // ne s'annulent plus ; les lignes derrière elle avancent d'une place, les
  // autres gestes restent en vigueur (retours du 23 octobre : chaque titre
  // ajouté par quelqu'un d'autre effaçait les déplacements du bar).
  _unpinManual(pid) {
    const anchored = this.manualChanges.some(change => change.personId === pid);
    if (!anchored && !this.manualOrder.includes(pid)) return false;
    this.manualOrder = this.manualOrder.filter(other => other !== pid);
    if (anchored) {
      this.manualChanges = this.manualChanges.filter(change => change.personId !== pid);
      this._trimManualOrder();
    }
    this.manualOrderActive = this.manualOrderActive && this.manualOrder.length > 0;
    return true;
  }

  // Personne supprimée (table partie) : les gestes qui restent l'oublient
  // aussi dans leur état d'avant (ordre fixé, prochain annoncé, reports).
  // Sinon la sauvegarde de la soirée ne se reprenait plus (« changement
  // manuel mal formé », relecture de la correction du 26 octobre).
  _forgetManual(pid) {
    for (const change of this.manualChanges) this._forgetIn(change, other => other === pid);
  }

  // `gone(pid)` : personne à oublier dans l'état d'avant de ce geste.
  _forgetIn(change, gone) {
    const before = change?.before;
    if (!before || typeof before !== 'object') return;
    if (Array.isArray(before.manualOrder)) before.manualOrder = before.manualOrder.filter(other => !gone(other));
    // Les annonces gardées derrière (`then`) aussi : la suivante prend la
    // place de celle qu'on oublie.
    if (before.reservedNext) before.reservedNext = this._pruneBehind(before.reservedNext, link => gone(link.personId));
    if (!Array.isArray(before.deferrals)) return;
    before.deferrals = before.deferrals.filter(row => !gone(row?.[0])).map(([owner, deferral]) => {
      const ids = Array.isArray(deferral?.ids) ? deferral.ids.filter(other => !gone(other)) : [owner];
      return [owner, { ...deferral, ids: ids.length ? ids : [owner] }];
    });
  }

  // `pid` chante sur la ligne fixée de `line` : c'est sa propre ligne, ou
  // l'invitée acceptée du titre en cours de cette ligne.
  _singsOnLine(line, pid) {
    const duet = this.people.get(line)?.song?.duet;
    return line === pid || (duet?.state === 'accepted' && duet.partnerId === pid);
  }

  // Personnes qui chantent sur la ligne de `line` (_singsOnLine).
  _lineOf(line) {
    const duet = this.people.get(line)?.song?.duet;
    return [line, ...(duet?.state === 'accepted' ? [duet.partnerId] : [])];
  }

  // Report « Pas prêt » remis depuis un état gardé : annulation d'un geste du
  // bar (restoreManualOverride, _undoRebased) ou passage non chanté dont
  // l'envoi l'avait levé ou rapproché (rollbackUnplayed). Le titre reporté
  // est le titre en cours de son auteur (les appelants le vérifient). Le
  // report attend les personnes qui chantent ce titre maintenant
  // (_singsOnLine), par les règles du report en cours : l'invitée d'un duo
  // défait depuis (« Annuler duo », « Chanter seul », « Je ne chante plus ce
  // duo », départ) en sort (_dropDeferredGuest), et celle qui a rejoint le
  // duo pendant qu'il était levé y entre (_deferralWaitsFor). Sinon le titre
  // de l'ex-invitée attendait de nouveau derrière ce report, que son
  // téléphone pouvait lever ou prolonger ; celui de la nouvelle passait juste
  // avant le duo, et son téléphone ne voyait pas le report (relecture,
  // passe 6). Comme deferPassage, le report rendu remplace un titre sauté
  // faute de « Je suis là » (presenceRetry) : la prévision ne voyait que le
  // titre sauté, select() que le report, et la scène libre envoyait un
  // autre passage que celui de la file (relecture, passe 10).
  _restoreDeferral(owner, deferral) {
    owner.deferral = { ...deferral };
    owner.presenceRetry = false;
    for (const pid of Array.isArray(deferral.ids) ? deferral.ids : []) {
      if (!this._singsOnLine(owner.id, pid)) this._dropDeferredGuest(owner, pid, deferral.entryId);
    }
    this._deferralWaitsFor(owner, owner.song);
  }

  // Personnes montées sur scène hors de leur propre ligne (invitée d'un duo
  // parti vers KaraFun, duo improvisé noté au bar) : les lignes de l'ordre
  // fixé où elles chantent encore retrouvent le calcul (espacement, premiers
  // passages des autres). Sinon une personne gardée devant un geste
  // rechantait deux chansons plus tard. Une ligne placée par le bar
  // elle-même aussi (_endPlaced) : sa personne chante avant elle. Rend les
  // gestes terminés, à garder dans le reçu du passage ou du duo noté : si la
  // personne n'a finalement pas chanté, ils reviennent (_restorePlaced).
  // Les gestes qui restent oublient aussi ces lignes, et l'annonce de ces
  // chanteurs comme prochain, dans leur état d'avant : un duo improvisé noté
  // au tour même de ces gestes ne se voit pas dans le compteur des passages
  // (_undoRebased), et annuler l'un d'eux faisait rechanter la personne
  // juste après son duo (relecture de la correction).
  _unpinSingers(ids) {
    const ended = ids.map(pid => this._endPlaced(pid)).filter(Boolean);
    if (!ids.length) return ended;
    const gone = new Set(ended.map(record => record.personId));
    if (this.manualOrder.length) {
      const anchors = this._manualAnchors();
      for (const line of [...this.manualOrder]) {
        if (!anchors.has(line) && ids.some(pid => this._singsOnLine(line, pid)) && this._unpinManual(line)) gone.add(line);
      }
    }
    const anchors = new Set(this.manualChanges.map(change => change.personId));
    const sang = pid => !anchors.has(pid) && (gone.has(pid) || ids.some(other => this._singsOnLine(pid, other)));
    for (const change of this.manualChanges) {
      const before = change?.before;
      if (!before || typeof before !== 'object') continue;
      if (Array.isArray(before.manualOrder)) before.manualOrder = before.manualOrder.filter(pid => !sang(pid));
      if (before.reservedNext) before.reservedNext = this._pruneBehind(before.reservedNext, link => sang(link.personId));
    }
    return ended;
  }

  // Décision du gérant du 26 octobre : « si je place quelqu'un, mais que pour
  // une raison ou une autre il passe devant son propre passage que j'ai
  // positionné, alors il faut le recalculer ». La personne d'une ligne placée
  // par le bar (déplacement, « Priorité ») monte sur scène avant elle, quel
  // que soit son rôle (invitée d'un duo parti vers KaraFun, duo improvisé noté
  // au bar) : le geste prend fin. Sa ligne quitte l'ordre fixé et retourne au
  // calcul (_unpinManual), sa priorité ne la garde plus en tête, le geste
  // n'est plus annulable et le journal du bar le dit ; les autres gestes
  // restent. Le plan affiché (ordre du bar, Timefold) la plaçait encore à la
  // place du geste : il est abandonné (_carryPlanAcross ne le reporte pas),
  // le calcul et Timefold repartent de l'ordre fixé qui reste. L'invitée d'un
  // duo placé qui chante ailleurs avant lui ne met pas fin au geste : il
  // appartient à l'auteur du titre. Rend de quoi le rétablir (_restorePlaced),
  // sérialisable (reçu du passage, sauvegardé avec la soirée), ou null.
  _endPlaced(pid) {
    const changes = this.manualChanges.filter(change => change.personId === pid);
    const priority = !!this.reservedNext?.byStaff && this.reservedNext.personId === pid;
    // Priorité gardée derrière un titre revenu de KaraFun (`then`) : elle prend
    // fin aussi, et revient derrière lui si la personne n'a pas chanté
    // (`behindOf`, _restorePlaced).
    let found = null;
    for (let link = this.reservedNext?.then; link && !found; link = link.then) if (link.byStaff && link.personId === pid) found = link;
    const behind = !priority && found ? { ...this._plainReservation(found), behindOf: this.reservedNext.personId,
      behindAt: this.reservedNext.reservedAt } : null;
    if (!changes.length) return null;
    // `changeIds` : tous les gestes à ce moment, pour les rendre à leur rang.
    // `epoch` : abandons des gestes déjà faits par le bar (voir _restorePlaced).
    const record = { personId: pid, changes: JSON.parse(JSON.stringify(changes)), order: [...this.manualOrder],
      changeIds: this.manualChanges.map(change => change.id),
      reserved: priority ? this._plainReservation(this.reservedNext) : behind, serial: this.appearanceSerial, at: Date.now(),
      epoch: this.manualEpoch || 0 };
    if (!this._unpinManual(pid)) return null;
    if (priority) this._passNext();
    // Gardée derrière l'annonce en cours : son maillon tombe, le titre retiré
    // de KaraFun pour elle prend sa place (_endLine).
    else if (behind) this._endLine(pid);
    this.solverPlan = null;
    this._planDropped = true;
    const p = this.people.get(pid);
    const what = changes.some(change => change.kind === 'priority') && priority ? 'sa priorité' : 'la place donnée par le bar';
    this.note(`${p?.name || 'Cette personne'} chante avant ${what} : sa ligne retrouve le calcul`, 'staff');
    this.version++;
    return record;
  }

  // La personne d'un geste terminé par _endPlaced n'est finalement pas montée
  // sur scène : le duo où elle était invitée est sorti de KaraFun sans être
  // chanté (« Pas prêt », priorité du bar avant lui, absent à « Je suis là »,
  // fermeture, passé dans KaraFun : rollbackUnplayed), ou le bar annule ou
  // corrige le duo improvisé noté avec elle (staffUncountPartner). Le geste
  // revient, avec sa place parmi les lignes fixées qui attendent encore et les
  // lignes gardées devant elle ; jamais devant une priorité du bar donnée
  // depuis. Sa priorité revient : en tête si personne n'est annoncé
  // entre-temps ; juste derrière l'annonce devant laquelle elle était gardée,
  // si c'est encore la même (`behindOf`) ; ou elle reprend la tête au titre
  // retiré de KaraFun que sa fin lui avait rendue (`backFor`). Rien ne
  // revient si elle est remontée sur scène depuis (passage compté après
  // `serial`), si sa ligne n'a plus de titre, si le bar l'a replacée, ou si
  // le bar a abandonné tous les gestes depuis (« Recalculer la file »,
  // « Annuler tous les changements manuels », « Vider toutes les chansons » :
  // `epoch` dépassé). Un reçu sans `epoch` (sauvegarde d'avant ce champ)
  // revient comme avant.
  _restorePlaced(records) {
    let restored = 0;
    for (const record of Array.isArray(records) ? records : []) {
      const p = this.people.get(record?.personId);
      const changes = Array.isArray(record?.changes) ? record.changes.filter(change => change && change.personId === p?.id) : [];
      const dropped = record?.epoch !== undefined && record.epoch !== (this.manualEpoch || 0);
      if (!p || p.withdrawnAt || !p.song || !changes.length || !Number.isSafeInteger(record.serial) || dropped ||
        (p.lastAppearanceTurn || 0) >= record.serial || this.manualChanges.some(change => change.personId === p.id)) continue;
      const waiting = pid => {
        const q = this.people.get(pid);
        return !!q && !q.withdrawnAt && !!q.song && (q.lastAppearanceTurn || 0) < record.serial;
      };
      const at = Array.isArray(record.order) ? record.order.indexOf(p.id) : -1;
      const ahead = at < 0 ? [] : record.order.slice(0, at).filter(pid => this.manualOrder.includes(pid) || waiting(pid));
      // Priorité gardée derrière un titre revenu de KaraFun, ou derrière une
      // priorité plus récente du bar : elle revient juste derrière lui, devant
      // les annonces qu'il garde, s'il est encore le prochain annoncé (la même
      // annonce, `behindAt`). Sinon la priorité plus ancienne perdait son
      // passe-droit sur le « Pas prêt » de l'invitée de son duo (relecture,
      // passe 18).
      const behindOf = record.reserved?.behindOf;
      const asBehind = !!behindOf && this.reservedNext?.personId === behindOf && (!!this.reservedNext.pulledBack ||
        (Number.isFinite(record.reserved.behindAt) && this.reservedNext.reservedAt === record.reserved.behindAt));
      // Sa priorité avait rendu la tête au titre retiré de KaraFun pour elle
      // (_backFirst, `pulledBack` : son heure d'annonce) : elle la reprend, et
      // le titre l'attend de nouveau (son report « après la priorité »).
      const backFor = !behindOf && !!record.reserved && Number.isFinite(record.reserved.reservedAt) &&
        this.reservedNext?.pulledBack === record.reserved.reservedAt;
      const reserved = record.reserved && (asBehind || backFor || !this.reservedNext) ? { personId: p.id,
        reservedAt: Number.isFinite(record.reserved.reservedAt) ? record.reserved.reservedAt : Date.now(), byStaff: true } : null;
      // Sa ligne dans `list` (l'ordre fixé, ou celui d'avant un geste), avec
      // les lignes gardées devant elle ; derrière la priorité `staff`.
      const place = (list, staff) => {
        const order = list.filter(pid => pid !== p.id);
        const kept = new Set(order);
        let index = 0;
        if (!reserved) {
          for (const pid of ahead) if (kept.has(pid)) index = Math.max(index, order.indexOf(pid) + 1);
          if (staff?.byStaff) index = Math.max(index, order.indexOf(staff.personId) + 1);
        }
        order.splice(index, 0, ...(reserved ? [] : ahead.filter(pid => !kept.has(pid))), p.id);
        return order;
      };
      this.manualOrder = place(this.manualOrder, this.reservedNext);
      this.manualOrderActive = true;
      // Reprenant la tête au titre retiré, elle garde derrière elle ce qu'il
      // gardait (son report l'attend de nouveau, sans chaîne à lui) ; sinon
      // une personne sautée qui suivait le titre perdait sa place (relecture,
      // passe 19).
      const backThen = backFor ? this.reservedNext.then : null;
      // Remise derrière la tête, dans la limite de BEHIND_MAX comme partout où
      // la chaîne grandit (_behindCopy, _dropBehind) : sinon un redémarrage
      // gardait une autre chaîne que la soirée (relecture, passe 21).
      const cut = [];
      if (reserved) this.reservedNext = asBehind ? { ...this.reservedNext,
        then: this._behindCopy(this.reservedNext.then ? { ...reserved, then: this.reservedNext.then } : reserved, 0, cut) } :
        backThen ? { ...reserved, then: backThen } : reserved;
      for (const link of cut) this._dropBehind(link);
      if (reserved) this._rewaitEnded();
      // Chaque geste revient après ceux qui le précédaient encore, avant ceux
      // faits depuis.
      const ids = Array.isArray(record.changeIds) ? record.changeIds : [];
      for (const change of changes) {
        this._forgetIn(change, pid => typeof pid === 'string' && !this.people.has(pid));
        const prior = new Set(ids.slice(0, Math.max(0, ids.indexOf(change.id))));
        let rank = 0;
        this.manualChanges.forEach((other, index) => { if (prior.has(other.id)) rank = index + 1; });
        this.manualChanges.splice(rank, 0, change);
      }
      // Les gestes rangés après lui la comptent aussi dans leur état d'avant,
      // à la même place : annuler l'un d'eux ne retire plus sa ligne
      // (relecture de la correction : le geste restait annulable, sa ligne
      // retournait au calcul).
      const first = Math.min(...changes.map(change => this.manualChanges.indexOf(change)));
      for (const change of this.manualChanges.slice(first + 1)) {
        const before = change.before;
        if (changes.includes(change) || !Array.isArray(before?.manualOrder) || before.manualOrder.includes(p.id)) continue;
        before.manualOrder = place(before.manualOrder, before.reservedNext);
      }
      this.solverPlan = null;
      this._planDropped = true;
      this.note(`${p.name} n’a finalement pas chanté : ${reserved ? 'sa priorité' : 'la place donnée par le bar'} revient`, 'staff');
      this.version++;
      restored++;
    }
    return restored;
  }

  // Le titre en cours d'une ligne fixée devient un duo (invitation ou demande
  // acceptée, titre suivant de sa liste). Sur une ligne que le bar n'a pas
  // placée, un duo que les règles de la file ne laisseraient pas passer à
  // cette place (invitée déjà entendue alors que l'auteur passait pour la
  // première fois, déjà montée dans ce tour, trop récemment sur scène, ou qui
  // chante plus tôt dans l'ordre fixé) repasse par le calcul, comme un
  // prochain annoncé (answerDuet). Sinon le duo garde la place, et la propre
  // ligne de l'invitée (ou un autre duo plus loin avec elle) retrouve le
  // calcul : elle monte sur scène avec ce duo. Une ligne placée par le bar
  // garde sa place jusqu'à ce que sa personne monte sur scène avant elle
  // (_unpinSingers, au départ du duo vers KaraFun) : le duo peut encore être
  // annulé d'ici là ; retiré de KaraFun sans être chanté, il rend la place
  // (_restorePlaced). Les lignes rendues au calcul sont notées sur le duo
  // (`unpinned`, sauvegardé avec le titre) : défait avant son envoi, ou
  // chargé dans KaraFun puis laissé par l'invitée (leaveSentDuet), retiré
  // sans être chanté après le départ de son auteur (rollbackUnplayed) ou
  // passé dans KaraFun sans être renvoyé (sync de server.js), il les remet
  // (_guestLeft). `kept` : gestes dont l'état d'avant comptait la
  // ligne, que l'envoi du duo leur retire (_unpinSingers).
  _guestJoined(owner) {
    const duet = owner?.song?.duet;
    const at = this.manualOrder.indexOf(owner?.id);
    const guest = duet?.state === 'accepted' ? this.people.get(duet.partnerId) : null;
    if (!guest || at < 0) return;
    const changeIds = this.manualChanges.map(change => change.id);
    const unpin = line => {
      const ahead = this.manualOrder.slice(0, Math.max(0, this.manualOrder.indexOf(line)));
      const kept = this.manualChanges.filter(change => Array.isArray(change.before?.manualOrder) &&
        change.before.manualOrder.includes(line)).map(change => change.id);
      if (!this._unpinManual(line)) return;
      duet.unpinned = [...(Array.isArray(duet.unpinned) ? duet.unpinned : []),
        { pid: line, ahead, changeIds, kept, serial: this.appearanceSerial, epoch: this.manualEpoch || 0 }];
    };
    const anchors = this._manualAnchors(), reserved = this.reservedNext?.personId;
    // Sa propre ligne plus tôt ne compte que si elle reste : placée par le
    // bar, ou prochain annoncé.
    const stays = line => line !== guest.id || anchors.has(line) || line === reserved;
    const heard = p => (p.sung || 0) + (p.duetGuestCount || 0) > 0;
    // `at` passages partent avant cette ligne : espacement compté comme _pick.
    const last = guest.lastAppearanceTurn || 0;
    const early = (heard(guest) && !heard(owner)) ||
      (this.roundPeople.has(guest.id) && !this.roundPeople.has(owner.id)) ||
      (last > 0 && last > this.appearanceSerial + at - this._spacing()) ||
      this.manualOrder.slice(0, at).some(line => this._singsOnLine(line, guest.id) && stays(line));
    if (!anchors.has(owner.id) && early) {
      unpin(owner.id);
      return;
    }
    [...this.manualOrder].forEach((line, index) => {
      if (line === owner.id || anchors.has(line) || !this._singsOnLine(line, guest.id)) return;
      if (line === guest.id ? line !== reserved : index > at) unpin(line);
    });
  }

  // Duo défait avant son envoi (invitée qui se retire, duo annulé, titre
  // retiré, départ de l'un des deux), qui n'est plus le titre en cours de sa
  // ligne (_currentChanged), ou chargé dans KaraFun et laissé par l'invitée
  // (leaveSentDuet), retiré sans être chanté après le départ de son auteur
  // (rollbackUnplayed) ou passé dans KaraFun sans être renvoyé (sync de
  // server.js) : les lignes que _guestJoined avait rendues au calcul pour
  // lui reviennent dans l'ordre fixé, derrière les lignes qui les
  // précédaient, jamais devant une priorité du bar ; les gestes notés depuis
  // les comptent aussi dans leur état d'avant, comme _restorePlaced, et ceux
  // d'avant qui les comptaient (`kept`) les retrouvent si l'envoi du duo les
  // en avait retirées. Rien ne revient pour une personne montée sur scène
  // depuis, sans titre, replacée par le bar, une ligne qui ne serait plus
  // devant aucune ligne placée, ou si le bar a abandonné tous ses gestes
  // depuis (`epoch`). Sinon la personne gardée devant un geste passait
  // derrière lui (relecture).
  _guestLeft(duet) {
    const records = Array.isArray(duet?.unpinned) ? duet.unpinned : [];
    if (duet) delete duet.unpinned;
    for (const record of records) {
      const p = this.people.get(record?.pid);
      if (!p || p.withdrawnAt || !p.song || this.manualOrder.includes(p.id) || !Array.isArray(record.ahead) ||
        record.epoch !== (this.manualEpoch || 0) || (p.lastAppearanceTurn || 0) > record.serial) continue;
      const place = (list, staff) => {
        let index = 0;
        for (const pid of record.ahead) if (list.includes(pid)) index = Math.max(index, list.indexOf(pid) + 1);
        if (staff?.byStaff) index = Math.max(index, list.indexOf(staff.personId) + 1);
        return index;
      };
      const at = place(this.manualOrder, this.reservedNext);
      const anchors = this._manualAnchors();
      if (!this.manualOrder.slice(at).some(pid => anchors.has(pid))) continue;
      this.manualOrder.splice(at, 0, p.id);
      this.manualOrderActive = true;
      const known = new Set(Array.isArray(record.changeIds) ? record.changeIds : []);
      const kept = new Set(Array.isArray(record.kept) ? record.kept : []);
      for (const change of this.manualChanges) {
        const before = change?.before;
        if ((known.has(change.id) && !kept.has(change.id)) || !Array.isArray(before?.manualOrder) ||
          before.manualOrder.includes(p.id)) continue;
        before.manualOrder.splice(place(before.manualOrder, before.reservedNext), 0, p.id);
      }
      this.version++;
    }
  }

  // Le titre en cours de `p` change sans que `previous` quitte sa liste
  // (liste réordonnée, titre revenu de KaraFun en tête de liste). Un duo qui
  // n'est plus le titre en cours ne chante plus à cette place : comme un duo
  // défait avant son envoi, il rend les lignes qu'il avait sorties de l'ordre
  // fixé (_guestLeft) ; remis en tête, il les ressort (_guestJoined). Sinon
  // la personne gardée devant un geste passait derrière lui (relecture,
  // passe 3).
  _currentChanged(p, previous) {
    if (!p || p.song === previous) return;
    this._guestLeft(previous?.duet);
    this._guestJoined(p);
    this._duetOnAnnounced(p, p.song);
    this._keepWaitingSlot(p, previous);
  }

  // Titre retiré de KaraFun qui attendait sa priorité, réordonné ou remplacé
  // par le titre suivant de sa liste (retiré par son chanteur ou par le bar) :
  // le titre désormais en tête de sa liste garde cette place, comme son
  // téléphone le promet (« sans changer la place ») et comme quand il l'attend
  // dans la chaîne des annonces, où sa personne garde sa place (relecture,
  // passes 19 et 20).
  _keepWaitingSlot(p, previous) {
    const d = p?.deferral;
    if (d?.afterPriority && p.song && previous?.entryId === d.entryId && p.song.entryId !== d.entryId) {
      d.entryId = p.song.entryId;
      d.ids = this._lineOf(p.id);
      this.version++;
    }
  }

  // `deferrals` : pour une intervention du bar, les reports « Pas prêt »
  // qu'un déplacement lève et qu'une annulation doit rendre.
  manualOverrideState({ deferrals = false } = {}) {
    const state = { manualOrder: [...this.manualOrder], manualOrderActive: this.manualOrderActive,
      reservedNext: this._copyReservation(this.reservedNext) };
    if (deferrals) state.deferrals = this._deferredOwners().map(pid => [pid, { ...this.people.get(pid).deferral }]);
    return state;
  }

  // `deferrals` : seule une annulation du bar rend les reports levés ; le
  // recalcul des empreintes ne doit jamais les rétablir.
  restoreManualOverride(state, { deferrals = false } = {}) {
    this.manualOrder = [...state.manualOrder];
    this.manualOrderActive = !!state.manualOrderActive && this.manualOrder.length > 0;
    this.reservedNext = this._copyReservation(state.reservedNext);
    this._chainAnnounced();
    if (!deferrals || !Array.isArray(state.deferrals)) return;
    // Simple report « après la priorité » né du geste annulé (titre retiré qui
    // ne pouvait pas reprendre la tête à la fin de sa priorité, _plainReport) :
    // il n'existait pas avant lui. Le report d'avant le geste remplace aussi
    // celui « après la priorité » que le geste a changé. Sinon le titre ne
    // l'attendait plus et passait derrière ce qu'elle gardait (relecture,
    // passe 26).
    const saved = new Set(state.deferrals.map(([pid]) => pid));
    for (const p of this.people.values()) {
      const d = p.deferral;
      if (d?.afterPriority && typeof d.forId !== 'string' && !saved.has(p.id) && this._isDeferred(p)) {
        p.deferral = null;
        this.version++;
      }
    }
    for (const [pid, deferral] of state.deferrals) {
      const p = this.people.get(pid);
      if (!p || p.withdrawnAt || p.song?.entryId !== deferral.entryId) continue;
      if (!p.deferral || (p.deferral.afterPriority && p.deferral.entryId === deferral.entryId)) this._restoreDeferral(p, deferral);
    }
  }

  // Les personnes de la chaîne des annonces rendue par une annulation y sont
  // de nouveau annoncées : une personne sautée faute de « Je suis là » que le
  // geste annulé avait coupée de la chaîne (au-delà de BEHIND_MAX,
  // _dropBehind) n'attend plus aussi comme sautée. Sinon elle était à la fois
  // annoncée et retenue : la file montrait quelqu'un d'autre en tête, la
  // scène attendait son « Je suis là », puis un autre partait (relecture,
  // passe 20). Une priorité du bar n'est pas une annonce de ce genre.
  _chainAnnounced() {
    for (let link = this.reservedNext; link; link = link.then) {
      const p = link.byStaff ? null : this.people.get(link.personId);
      if (p?.presenceRetry) { p.presenceRetry = false; this.version++; }
    }
  }

  // Copie d'une annonce, celle qu'un titre revenu de KaraFun garde derrière
  // lui comprise (`then`) : un état gardé ne partage rien avec l'annonce en
  // cours.
  _copyReservation(reserved) {
    return reserved ? structuredClone(reserved) : null;
  }

  // Les notes, photos et noms peuvent changer sans modifier la file. Cette
  // empreinte ne couvre que les données qui déterminent les places prévues.
  manualContextFingerprint() {
    const people = this.Q.map(pid => {
      const p = this.people.get(pid);
      return p ? [pid, p.group, p.withdrawnAt, p.sung, p.duetGuestCount || 0,
        p.lastAppearanceTurn || 0, this._isPresenceRetry(p), this._deferralKey(p),
        p.over, p.held, p.song?.entryId || null, this._duetKey(p.song),
        (p.backlog || []).map(song => [song.entryId, this._duetKey(song)])] : [pid];
    });
    const context = { people, Q: this.Q, lastGroup: this.lastGroup,
      roundGroups: [...this.roundGroups], roundPeople: [...this.roundPeople], firstCycle: [...this.firstCycle],
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
  // (_registeredWeights) : un changement de ce nombre (départ de quelqu'un
  // qui compte, premier titre, retrait du dernier titre de quelqu'un qui n'a
  // pas encore chanté) à une table présente dans la file (titre en attente,
  // prêt ou non, ou invitée d'un duo accepté) la relance ; pas à une autre
  // table.
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
        p.lastAppearanceTurn || 0, p.readySerial || 0, p.readySince || 0,
        songs.map(song => [song.entryId, this._duetKey(song)])];
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
      roundGroups: [...this.roundGroups], roundPeople: [...this.roundPeople], firstCycle: [...this.firstCycle],
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

  // Rien n'a changé depuis le dernier geste (file du helper et KaraFun) :
  // l'annuler rend exactement l'ordre affiché avant lui. Sinon l'annulation
  // reste possible et ne rend au calcul que la ligne de ce geste
  // (_undoRebased).
  canUndoManualChange(nativeFingerprint) {
    const latest = this.manualChanges.at(-1);
    return !!latest && latest.native === nativeFingerprint &&
      latest.after === this.manualContextFingerprint();
  }

  // `serial` : passages déjà comptés au moment du geste, pour rendre un
  // report « Pas prêt » levé par lui, moins les chansons passées depuis.
  recordManualChange({ kind, personId, name, from, to, before, native, planBefore = this._planBeforeManual }) {
    const change = { id: id(), kind, personId, name, from, to, at: Date.now(),
      before, after: this.manualContextFingerprint(), native, planBefore: planBefore || null,
      serial: this.appearanceSerial };
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

  // Annule le geste le plus récent. `excludeIds` : passage en cours d'envoi à
  // KaraFun, dont la réservation d'avant le geste ne peut plus être rendue.
  // Un titre retiré de KaraFun pour la priorité de ce geste et déjà revenu
  // (yieldToPriority) reprend la tête, l'annonce que l'annulation rend juste
  // derrière lui : avant le geste, elle le suivait dans KaraFun (_backFirst).
  // Sinon elle passait devant lui, une personne sautée faute de « Je suis
  // là » comprise (relecture, passes 16 et 17). `busyIds` : personnes des
  // passages en route vers KaraFun, invitée d'un duo comprise (le titre ne
  // repasse pas juste après elles). Titre pas encore revenu : à son retour
  // (returnFromKaraFun). De même pour un titre qui attendait sa priorité dans
  // la chaîne des annonces (`pulled`, staffMove, _insertPulled), si ni la
  // chaîne ni son report ne le gardent après l'annulation (relecture, passe 19).
  _undoLatest(nativeFingerprint, excludeIds = [], busyIds = []) {
    const latest = this.manualChanges.at(-1);
    const yielded = this._deferredOwners().map(pid => this.people.get(pid)).filter(p => p.deferral.afterPriority);
    const linked = [];
    for (let link = this.reservedNext?.then; link; link = link.then) if (link.pulled && this.people.has(link.personId)) linked.push(link);
    if (this.canUndoManualChange(nativeFingerprint)) {
      this.restoreManualOverride(latest.before, { deferrals: true });
      this._restorePlan(latest.planBefore);
      this.manualChanges.pop();
    } else this._undoRebased(latest, [...excludeIds, ...busyIds]);
    for (const p of yielded) {
      if (!this._isDeferred(p) && p.deferral) {
        const { entryId, forId, forAt } = p.deferral;
        this._backOrWait(p, entryId, { cutoff: forAt, busyIds: [...excludeIds, ...busyIds], forId, forAt });
      }
    }
    for (const link of linked) {
      const p = this.people.get(link.personId);
      if (!p?.song || this._inChain(p.id) || this._isDeferred(p)) continue;
      this._waitAgain(p, link.forId, link.forAt, [...excludeIds, ...busyIds]);
    }
    this.version++;
    return latest;
  }

  // Annulation après d'autres changements de la file (titres ajoutés,
  // arrivées, passages partis) : la ligne du geste revient au calcul ; les
  // lignes placées par les gestes plus anciens retrouvent leur place d'avant
  // ce geste (une ligne redéplacée, sa place précédente), moins les passages
  // partis depuis ; le prochain annoncé d'avant le geste est rendu s'il
  // attend encore. Les titres déjà dans KaraFun ne bougent jamais.
  _undoRebased(change, excludeIds = []) {
    const before = change.before || {};
    // Titre retiré de KaraFun pour la priorité de ce geste, qui l'attend dans
    // la chaîne des annonces (`pulled`, avant que celle-ci ne change).
    let pulledFor = false;
    for (let link = this.reservedNext; link && !pulledFor; link = link.then) pulledFor = !!link.pulled && link.forId === change.personId;
    const pinned = new Set(this.manualOrder);
    // Ligne encore en attente : toujours fixée, ou encore là avec un titre,
    // sans être montée sur scène depuis le geste (son titre parti, ou en
    // invitée d'un duo : un passage compté après `serial` ; sans ce décompte,
    // ancienne sauvegarde, son envoi daté `lastSungAt`).
    const sentSince = p => Number.isSafeInteger(change.serial) ?
      (p.lastAppearanceTurn || 0) > change.serial : (p.lastSungAt || 0) >= change.at;
    const waiting = pid => {
      if (pinned.has(pid)) return true;
      const p = this.people.get(pid);
      return !!p && !p.withdrawnAt && !!p.song && !excludeIds.includes(pid) && !sentSince(p);
    };
    this.manualChanges = this.manualChanges.filter(other => other !== change);
    const order = (Array.isArray(before.manualOrder) ? before.manualOrder : []).filter(waiting);
    // Invitée d'un duo d'une autre ligne fixée : sa propre ligne, sortie de
    // l'ordre fixé pour ce duo (_guestJoined), n'y revient pas.
    this.manualOrder = order.filter(pid => pinned.has(pid) ||
      !order.some(line => line !== pid && this._singsOnLine(line, pid)));
    this.manualOrderActive = this.manualOrder.length > 0;
    this._trimManualOrder();
    // Priorité annulée en tête : les annonces qu'elle gardait derrière elle
    // (`then`) sont rendues ci-dessous, comme quand elle prend fin autrement
    // (_passNext). Sinon une personne sautée faute de « Je suis là » gardée là
    // perdait sa place quand l'annonce d'avant le geste ne pouvait plus
    // revenir (relecture, passe 20).
    let heldChain = null;
    if (change.to === 1 && this.reservedNext?.personId === change.personId) {
      heldChain = this.reservedNext.then || null;
      this.reservedNext = null;
    }
    // Priorité annulée de l'annonce gardée derrière un titre revenu de
    // KaraFun : elle ne lui est plus rendue.
    if (change.to === 1 && this.reservedNext?.then) {
      const { then, ...head } = this.reservedNext;
      const kept = this._pruneBehind(then, link => !!link.byStaff && link.personId === change.personId);
      this.reservedNext = kept ? { ...head, then: kept } : head;
    }
    // Ligne qui peut redevenir la prochaine annoncée : personne n'y chante qui
    // vient de chanter (dernier passage envoyé, ou depuis le geste) ni qui part
    // vers KaraFun (`excludeIds`), la personne de la ligne comme l'invitée de
    // son duo (_singsOnLine). Comme _commit, qui n'annonce pas un report juste
    // après un passage où chante l'une de ses personnes, et _duetOnAnnounced.
    // Sinon l'annonce rendue faisait repasser aussitôt quelqu'un qui venait de
    // chanter (relecture, passe 8).
    const fresh = pid => {
      const q = this.people.get(pid);
      return !!q && !q.withdrawnAt && !excludeIds.includes(pid) && !sentSince(q) &&
        !((q.lastAppearanceTurn || 0) > 0 && q.lastAppearanceTurn >= this.appearanceSerial);
    };
    const lineFree = pid => {
      const duet = this.people.get(pid)?.song?.duet;
      return waiting(pid) && [pid, ...(duet?.state === 'accepted' ? [duet.partnerId] : [])].every(fresh);
    };
    // Ni une personne dont le titre est passé depuis faute de « Je suis là »
    // (presenceRetry) : son manque laisse passer le titre suivant, comme sans
    // le geste. Sinon elle redevenait la prochaine annoncée en restant
    // retenue (select, prévision) : la file montrait l'un, l'envoi un autre
    // (relecture, passe 10).
    // Ni une personne dont le « Pas prêt » a commencé depuis le geste, ni, hors
    // priorité du bar, un duo dont l'invitée a le sien (_announcedGuestHeld) :
    // select() et reservePresenceNext libéraient aussitôt cette annonce, mais
    // d'ici là un titre retiré de KaraFun pour cette priorité attendait
    // derrière elle (yieldToPriority) et le journal le disait (relecture,
    // passe 12).
    const skipped = pid => this._isPresenceRetry(this.people.get(pid));
    const notReady = reserved => {
      const q = this.people.get(reserved.personId);
      return !q || this._isDeferred(q) || this._announcedGuestHeld(reserved);
    };
    const old = before.reservedNext;
    const restorable = old && lineFree(old.personId) && !skipped(old.personId) && !notReady(old) &&
      (!old.byStaff || this.manualOrder.includes(old.personId));
    const back = this.reservedNext;
    const restoredOld = !back && restorable;
    // Place de la personne du geste dans la chaîne d'avant lui (0 : elle était
    // l'annonce en cours).
    const links = [];
    for (let link = old; link && typeof link === 'object' && links.length <= 4 * BEHIND_MAX; link = link.then) links.push(link);
    const at = links.findIndex(link => link.personId === change.personId);
    // Déplacement plus bas de l'annonce en cours elle-même (staffMove : elle
    // cède la tête, _moveKept) : comme le prochain annoncé d'avant une
    // priorité annulée, elle est rendue en tête si elle peut revenir, avec son
    // heure d'annonce, comme une « Priorité » redonnée (_placeAhead : ce que
    // l'annonce qui l'a remplacée était et gardait reste derrière elle selon
    // les mêmes règles). Le titre retiré de KaraFun qui l'attendait l'attend
    // de nouveau (son report « après la priorité » tient de nouveau) : il sort
    // de la chaîne, et n'est plus une personne sautée s'il l'était devenu.
    // Sinon elle restait derrière la ligne qui avait pris la tête, alors que
    // la réponse disait qu'elle retrouvait sa place (relecture, passes 23 et
    // 24).
    const headMoved = change.to !== 1 && at === 0 && restorable && !!back && back.personId !== change.personId;
    if (restoredOld) {
      // L'annonce d'avant le geste revient telle qu'elle était, avec ce qu'elle
      // gardait ; les annonces que la priorité annulée a gardées depuis le
      // geste la suivent (un titre retiré de KaraFun attend de nouveau sa
      // priorité : _undoLatest).
      this.reservedNext = this._copyReservation(old);
      this._rewaitEnded();
      const since = heldChain ? this._pruneBehind(heldChain, link => !!link.pulled || this._inChain(link.personId)) : null;
      if (since) this._appendChain(since);
      this._chainAnnounced();
    } else if (headMoved) {
      // Ce qu'elle gardait derrière elle avant le geste y reste, même une
      // annonce de la file (relecture, passe 25). Le titre retiré qui ne
      // pouvait pas reprendre la tête à son glissement l'attend de nouveau
      // (_rewaitEnded, passe 26).
      const { then, ...top } = this._copyReservation(old);
      this._placeAhead(top, excludeIds, undefined, new Set(links.slice(1).map(link => link.personId)));
      this._rewaitEnded();
      const title = this._titleWaitingFor(this.reservedNext);
      if (title) {
        title.presenceRetry = false;
        const { then: chain, ...head } = this.reservedNext;
        const rest = this._pruneBehind(chain, link => link.personId === title.id);
        this.reservedNext = rest ? { ...head, then: rest } : head;
      }
      this._chainAnnounced();
    } else if (!back && heldChain) {
      // Elle ne peut plus revenir : la première des annonces que gardait la
      // priorité annulée qui peut encore partir devient la prochaine, avec
      // celles qu'elle garde ; celles d'avant qui ne le peuvent pas tombent
      // (_dropBehind).
      const promoted = this._nextBehind(heldChain, [...this._justSang(), ...excludeIds]);
      if (promoted) this.reservedNext = promoted;
    }
    // Titre revenu de KaraFun en tête sans annonce derrière lui (_backFirst) :
    // l'annonce d'avant ce geste, plus ancienne que le retrait, le suivait dans
    // KaraFun ; elle le suit de nouveau. Sinon « Recalculer la file » une fois
    // le titre revenu perdait la personne sautée faute de « Je suis là » que la
    // priorité annulée avait remplacée (relecture, passe 17).
    else if (restorable && back?.pulledBack && !back.then && old.personId !== back.personId &&
        old.reservedAt < back.pulledBack && !this._lineOf(back.personId).some(pid => this._singsOnLine(old.personId, pid))) {
      this.reservedNext = { ...back, then: this._plainReservation(old) };
    }
    // Déplacement annulé d'une annonce gardée dans la chaîne (staffMove l'en
    // sortait, ou la mettait au bout des annonces gardées) : elle y retrouve
    // sa place d'avant le geste, juste derrière l'annonce qui la précédait,
    // telle qu'elle était (personne sautée, titre retiré, priorité du bar),
    // si elle peut encore partir. Sinon une personne sautée faute de « Je
    // suis là » passait derrière une nouvelle table, ou une ligne gardait la
    // place annulée alors que la réponse disait le contraire (relecture,
    // passe 22).
    const self = at > 0 ? this._plainReservation(links[at]) : null;
    if (change.to !== 1 && self && this.reservedNext && this.reservedNext.personId !== change.personId &&
        lineFree(change.personId) && this._behindStands(self, [])) {
      const { then, ...top } = this.reservedNext;
      const chain = [];
      for (let link = then; link; link = link.then) if (link.personId !== change.personId) chain.push(this._plainReservation(link));
      let pos = 0;
      for (let j = at - 1; j > 0 && !pos; j--) pos = chain.findIndex(link => link.personId === links[j].personId) + 1;
      chain.splice(pos, 0, self);
      const cut = [];
      const behind = this._behindCopy(chain.reduceRight((rest, link) => ({ ...link, ...(rest ? { then: rest } : {}) }), null), 0, cut);
      this.reservedNext = behind ? { ...top, then: behind } : top;
      for (const link of cut) this._dropBehind(link);
    }
    // Quelle que soit la branche qui a rendu la chaîne (annonce d'avant,
    // annonce gardée remise à sa place), le titre retiré dont la priorité
    // revient telle quelle l'attend de nouveau (_rewaitEnded, passe 26).
    // Sinon il passait derrière ce qu'elle gardait (contre-relecture de la
    // passe 26).
    this._rewaitEnded();
    // Seul le report levé par ce geste revient, moins les chansons passées.
    // Déjà écoulé, il prend fin comme dans _commit au bout d'un report : déjà
    // annoncée, la personne le reste ; sinon elle devient la prochaine
    // annoncée si personne ne l'est et que sa ligne le peut (`lineFree`) ;
    // sinon il revient à 0 et le prochain envoi la libère. Sinon elle laissait
    // passer une chanson de plus que demandé (relecture, passes 7 et 8).
    const passed = Number.isSafeInteger(change.serial) ? Math.max(0, this.appearanceSerial - change.serial) : 0;
    // Un titre retiré de KaraFun pour la priorité de ce geste reprend la tête
    // (_undoLatest, _backFirst) : comme une annonce en cours, il garde le
    // report rendu de la personne de ce geste, au bout, derrière lui ; sinon
    // elle passait devant lui, et devant une personne dont son envoi lèvera
    // le report (relecture, passe 17).
    const yielding = pulledFor || [...this.people.values()].some(q => q.deferral?.afterPriority && q.deferral.forId === change.personId &&
      q.song?.entryId === q.deferral.entryId);
    for (const [pid, deferral] of Array.isArray(before.deferrals) ? before.deferrals : []) {
      const p = this.people.get(pid);
      if (pid !== change.personId || !p || p.withdrawnAt || p.song?.entryId !== deferral.entryId || p.deferral) continue;
      const remaining = Math.max(0, deferral.remaining - passed);
      if (remaining === 0 && this.reservedNext?.personId === p.id) continue;
      // Titre retiré de KaraFun dont la priorité a pris fin depuis le geste
      // (« Pas prêt », départ, titre retiré) : son report ne vaudrait plus
      // rien. Il attend cette priorité là où elle est encore gardée, sinon il
      // reprend la tête ou attend en simple report (_waitAgain), comme si le
      // geste n'avait pas eu lieu. Sinon de nouvelles tables passaient devant
      // lui (contre-relecture de la passe 26).
      if (deferral.afterPriority && typeof deferral.forId === 'string' && !this._priorityHolds(deferral)) {
        this._waitAgain(p, deferral.forId, deferral.forAt, excludeIds);
        continue;
      }
      if (remaining > 0 || this.reservedNext || yielding || !lineFree(p.id) || skipped(p.id)) {
        this._restoreDeferral(p, { ...deferral, remaining });
        // Devenue entre-temps la prochaine annoncée (hors priorité du bar), ou
        // rendue telle par cette annulation (priorité du bar gardée derrière
        // une autre dans l'état d'avant le geste, passe 17) : son report rendu
        // la retient, l'annonce est libérée, comme deferPassage le fait
        // (relecture, passe 12).
        if (this.reservedNext?.personId === p.id && (!this.reservedNext.byStaff || restoredOld)) this._passNext();
      } else this.reservedNext = { personId: p.id, reservedAt: Date.now() };
    }
    this._restorePlan(change.planBefore);
  }

  undoLastManualChange(changeId, nativeFingerprint, { excludeIds = [], busyIds = [] } = {}) {
    const latest = this.manualChanges.at(-1);
    if (!latest) throw new Error('Aucun changement manuel à annuler.');
    if (changeId && latest.id !== changeId) {
      throw new Error('Annule d’abord le changement manuel le plus récent.');
    }
    this._undoLatest(nativeFingerprint, excludeIds, busyIds);
    this._event('staff.undo', { changeId: latest.id || null, kind: latest.kind, personId: latest.personId || null });
    this.note(`Le bar a annulé ${latest.kind === 'priority' ? 'la priorité' : 'le déplacement'} de ${latest.name}`, 'staff');
    return latest;
  }

  // Tous les gestes, du plus récent au plus ancien : leurs lignes reviennent
  // au calcul, sans relancer Timefold (voir forceReplan). Ceux qu'un duo
  // avait terminés ne reviennent plus (`manualEpoch`, _restorePlaced).
  undoAllManualChanges(nativeFingerprint, { excludeIds = [], busyIds = [] } = {}) {
    if (!this.manualChanges.length) throw new Error('Aucun changement manuel à annuler.');
    const count = this.manualChanges.length;
    while (this.manualChanges.length) this._undoLatest(nativeFingerprint, excludeIds, busyIds);
    this.manualEpoch = (this.manualEpoch || 0) + 1;
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
    this._endLine(p.id);
    this._unpinManual(p.id);
    this._event('person.left', { personId: p.id, by, songsDropped });
    this.note(`${p.name} a retiré ses chansons ; son identité reste inscrite à la table`);
  }

  _drop(p, notify) {
    // annule les duos liés
    this._removeDuetsForPerson(p, notify);
    this._removeFromQ(p.id);
    this._endLine(p.id);
    this.people.delete(p.id);
    this.byToken.delete(p.token);
    this.roundPeople.delete(p.id);
    this.roundApps.delete(p.id);
    this.roundOwed.delete(p.id);
    this.duetCooldowns.delete(p.id);
    this._unpinManual(p.id);
    this._forgetManual(p.id);
    // Dernière personne de sa table : la table quitte le tour et le cycle des
    // premiers passages. Rouverte avec le même numéro, sa nouvelle tablée
    // rejoint le cycle en cours comme toute table qui arrive (relecture).
    if (![...this.people.values()].some(q => q.group === p.group)) {
      this.roundGroups.delete(p.group);
      this.firstCycle.delete(p.group);
      this.groupDepartures.set(p.group, ++this.departureSerial);
    }
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
    // Un titre ajouté, remplacé ou une arrivée ne touchent pas aux lignes
    // placées par le bar : elles gardent leur place (_pick, ordre fixé).
    const replaced = mode === 'replace' ? this.songsOf(p).map(s => s.entryId) : [];
    // Début de l'attente pour ce titre : ceux qui ont chanté avant ne sont pas
    // passés « devant » cette personne (voir l'anti-série et la patience de
    // _pick). Un titre échangé (retrait du dernier titre puis ajout, sans
    // passage entre les deux) garde l'attente en cours.
    // Échange seulement si le ticket est resté dans la file : « Je pars » et
    // « Vider toutes les chansons » la vident, et l'attente recommence.
    // `readySince` : heure de ce même début d'attente, qui range les premiers
    // passages dans l'ordre d'ajout (_pick).
    const swapped = p.emptiedAt === this.appearanceSerial && this.Q.includes(p.id) && !p.withdrawnAt;
    if (!this.songsOf(p).length && !swapped) this._startWait(p);
    delete p.emptiedAt;
    if (mode === 'append' && p.song) p.backlog.push(next);
    else {
      const previous = p.song;
      if (mode === 'replace') {
        this._songsGone(p, this.songsOf(p));
        p.backlog = [];
      }
      p.song = next;
      // « Remplacer ma prochaine chanson » sur un titre retiré de KaraFun qui
      // attend sa priorité : le nouveau titre garde sa place, comme un titre
      // suivant qui le remplace (relecture, passe 21).
      this._keepWaitingSlot(p, previous);
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
    const current = p.song;
    if (p.song && p.song.entryId === key) {
      this._songsGone(p, [p.song]);
      p.song = (p.backlog || []).shift() || null;
      // Un titre retiré faute de « Je suis là » n'ouvre pas d'échange, et
      // efface un ancien repère (passage annulé puis rendu) : le titre
      // suivant de la liste, ou un titre rechoisi, commence une nouvelle attente.
      if (by === 'presence-max') {
        delete p.emptiedAt;
        if (p.song) this._startWait(p);
      } else this._noteEmptied(p);
    } else {
      const i = (p.backlog || []).findIndex(s => s.entryId === key);
      if (i < 0) throw new Error('Chanson introuvable dans la liste.');
      this._songsGone(p, p.backlog.splice(i, 1));
    }
    // Liste vidée, ou titre retiré faute de « Je suis là » : la place donnée
    // par le bar tombe. Sinon le titre suivant de la liste la garde (un duo :
    // voir _guestJoined).
    if (!p.song || by === 'presence-max') this._unpinManual(p.id);
    else if (p.song !== current) { this._guestJoined(p); this._duetOnAnnounced(p, p.song); this._keepWaitingSlot(p, current); }
    this._refreshDuetViews();
    if (!p.song) this._endLine(p.id);
    this._event('song.removed', { personId: p.id, entryId: key, by });
    this.note(`${p.name} a retiré une chanson de sa liste`);
  }

  // Nouvelle attente : `readySerial` (compteur des passages, patience et
  // anti-série) et `readySince` (heure, premier ajouté premier servi parmi
  // les premiers passages, puis la plus ancienne attente d'abord). Deux
  // attentes ouvertes dans la même milliseconde gardent leur ordre : l'heure
  // ne recule jamais d'un ajout au suivant. Place cédée par quelqu'un de sa
  // table avant son premier titre (`givenWait`, giveSpot) : l'attente de
  // cette place, tant que son ticket est encore dans la file (un départ ou
  // « Vider toutes les chansons » l'ont retiré).
  _startWait(p) {
    const given = this.Q.includes(p.id) ? p.givenWait : null;
    delete p.givenWait;
    p.readySerial = Number.isSafeInteger(given?.readySerial) ? Math.min(given.readySerial, this._waitSerial()) : this._waitSerial();
    p.readySince = Number.isFinite(given?.readySince) ? given.readySince : this._readyStamp();
  }

  // Compteur d'un début d'attente : les passages déjà commencés sur scène.
  // Un passage compte à son envoi vers KaraFun (`_commit`, 45 s après le
  // début du titre en cours) ; une demande faite pendant cet envoi, avant
  // que son titre commence, prend le début d'attente d'avant lui : il compte
  // comme venu après elle (soirée du 23 octobre : une demande de 23:13:38,
  // pendant l'envoi d'un passage de 23:12:12 chanté à 23:15:05, ne la
  // protégeait plus de ce chanteur). L'heure `readySince` de la demande est
  // déjà avant le début de ce passage.
  _waitSerial() {
    const sent = this.unstartedTurn;
    return sent > 0 && sent <= this.appearanceSerial ? sent - 1 : this.appearanceSerial;
  }

  // Heure où l'attente commence pour les chanteurs du passage `turn` : la fin
  // de ce passage sur scène (endStage), comme dans les statistiques, où
  // l'attente d'un titre commence au plus tôt à la fin du précédent. Passage
  // pas encore fini (sur scène, envoyé, ou prévu par _forecast) : après
  // toute demande déjà faite. Sert à départager, à compteur égal, ce passage
  // et les demandes faites pendant lui (avant sa fin) ou juste après.
  _stageEnd(turn) {
    if (!turn || turn > this.appearanceSerial) return Infinity;
    return this.stageEnds.get(turn) ?? Infinity;
  }

  // Heure d'un début d'attente, strictement après la précédente (et après
  // toutes celles d'une sauvegarde reprise, même si l'horloge a reculé).
  // Même horloge pour les fins de passage (endStage) : _waitSince les compare.
  _readyStamp() {
    this._readyClock = Math.max(Date.now(), (this._readyClock || 0) + 1);
    return this._readyClock;
  }

  // Repère sur cette horloge, sans la faire avancer : la dernière heure
  // donnée par _readyStamp (0 : aucune). Une attente déjà commencée ne le
  // dépasse pas ; toute attente commencée ensuite vient strictement après,
  // même si l'horloge du PC recule entre-temps. Heure du choix d'un passage
  // (`pickedAt`, rotation.js#_pick), comparée aux débuts d'attente par
  // _commit : lue sans rien changer, car _pick sert aussi aux prévisions.
  _readyMark() {
    return this._readyClock || 0;
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
    const [moved] = songs.splice(from, 1);
    songs.splice(to, 0, moved);
    const current = p.song;
    p.song = songs.shift() || null;
    p.backlog = songs;
    // Duo qui quitte ou prend le titre en cours d'une ligne fixée : voir
    // _currentChanged.
    this._currentChanged(p, current);
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

  // Écart entre la fin d'un titre et le début du suivant, mesuré par le
  // serveur quand un titre attendait (délai avant la lecture, chargement par
  // KaraFun) : la durée d'un titre (recordSlot) ne le contient pas. Médiane
  // des derniers écarts, valeur par défaut tant qu'il y en a trop peu ; un
  // écart de plus d'une minute (pause, panne) n'est pas gardé.
  recordSongGap(seconds) {
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= SONG_GAP_MAX_SEC) {
      this.songGapSamples.push(seconds);
      if (this.songGapSamples.length > SONG_GAP_SAMPLES) this.songGapSamples.shift();
    }
  }

  songGapSec() {
    if (this.songGapSamples.length < SONG_GAP_MIN_SAMPLES) return this.opts.defaultSongGapSec;
    const sorted = [...this.songGapSamples].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Du début d'un titre au début du suivant : durée moyenne d'un titre plus
  // l'écart entre deux titres (heures estimées, heure de fermeture).
  passageSec() {
    return this.avgSlotSec() + this.songGapSec();
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
    const step = this.passageSec() * 1000;
    const base = firstFreeAt ? Math.max(now, firstFreeAt) : now;
    const g = this.guaranteedCount();
    const qIndex = new Map(this.Q.map((pid, i) => [pid, i]));
    const out = [];
    this.predict().forEach((sl, k) => {
      const eta = base + (songsBefore + k) * step;
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

module.exports = { DEFER_MAX, SONG_GAP_MIN_SAMPLES, Scheduler, DEFAULTS };
