'use strict';
// Planificateur, partie plan Timefold et optimisation continue.
// Méthodes de Scheduler (scheduler.js), recopiées sur sa classe au
// chargement : elles partagent ses états (this) comme si elles y étaient écrites.
const { HISTORY_LIMIT, EPS, id, overlaps, solverScoreGain, plainSolverError } = require('./common');

class SchedulerSolver {
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

  // Plan adopté ou optimiseur disponible : _maybeRequestSolver a besoin de
  // l'empreinte de la file. Sinon rien à décider, l'empreinte (toute la file
  // sérialisée) ne servirait à rien à chaque lecture.
  _solverWatching() {
    return !!this.solverPlan || !!this.solverBridge?.available;
  }

  // `fingerprint` : empreinte de l'état courant déjà connue (readyView, celle
  // d'une prévision gardée encore juste) ; sinon elle est calculée ici.
  _maybeRequestSolver(fingerprint = null) {
    if (!this._solverWatching()) return false;
    fingerprint ??= this.solverContextFingerprint();
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
    // La graine d'un nouveau calcul prévoit exactement un passage par titre des
    // listes de la file (chaque passage consomme un titre de son auteur) : au-
    // delà de 200 titres, le refus vient sans calculer toute la prévision.
    const tooMany = !refine && this.Q.reduce((n, pid) => {
      const p = this.people.get(pid);
      return p && !p.withdrawnAt ? n + this.songsOf(p).length : n;
    }, 0) > 200;
    const seed = tooMany ? null : this._forecast(false, [], null, true, { ranks: baseRanks });
    if (!refine) {
      this.solverRequestedFingerprint = fingerprint;
      this._cancelRefine();
    }
    if (!seed || seed.length < 2 || seed.length > 200 || seed.some(item => !item.entryId)) {
      if (refine) return false;
      this.solverLastError = !seed || seed.length > 200 ?
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
}

module.exports = SchedulerSolver;
