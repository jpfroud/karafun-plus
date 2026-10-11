'use strict';
// Planificateur, partie rotation : choix du prochain passage (_pick), réservation, prévision de la file.
// Méthodes de Scheduler (scheduler.js), recopiées sur sa classe au
// chargement : elles partagent ses états (this) comme si elles y étaient écrites.
const { HISTORY_LIMIT, CONFIRM_MS, VIEW_CACHE_MAX, EPS } = require('./common');

class SchedulerRotation {
  // ------------------------------------------------------------------ sélection
  // Une invitation de duo sans réponse ne retient pas le titre (voir _expireInvite).
  isReady(p) {
    if (!p || !p.song) return false;
    if (this.opts.requirePresence && !this._confirmedRecently(p)) return false;
    return true;
  }

  _confirmedRecently(p) {
    return p.confirmedAt && Date.now() - p.confirmedAt < CONFIRM_MS;
  }

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
    let owners = null;
    for (const [group, set] of members) {
      const sum = [...set].reduce((total, pid) => total + this.personWeight(pid), 0);
      out.set(group, !set.size ? 0 : mode === 'people' ? sum :
        mode === 'sqrt' ? Math.sqrt(sum) : this.tableWeight(group, owners || (owners = this._groupOwners())));
    }
    return out;
  }

  // Écart entre la part méritée et les passages réellement obtenus sur la
  // dernière fenêtre d'environ un tour. Le plus grand écart passe d'abord.
  // Les passages de chaque groupe sont comptés en un seul parcours de la
  // fenêtre (une entrée compte une fois par groupe) : avec des centaines de
  // solistes, chacun son groupe, recompter la fenêtre groupe par groupe
  // coûtait un parcours complet par groupe à chaque passage prévu.
  _groupDeficits(weights, history, owners) {
    const total = [...weights.values()].reduce((a, b) => a + b, 0);
    const out = new Map();
    const recent = history.slice(-Math.max(4, owners));
    const served = new Map();
    for (const groups of recent) {
      groups.forEach((group, index) => {
        if (groups.indexOf(group) === index) served.set(group, (served.get(group) || 0) + 1);
      });
    }
    for (const [group, weight] of weights) {
      const count = served.get(group) || 0;
      out.set(group, total > EPS ? (recent.length + 1) * weight / total - count : -count);
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
      // Invitation de duo encore sans réponse : le titre garde sa place et
      // part en solo à son tour ; présence et report ne concernent que lui.
      if (!predict && (!song ||
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
    // chanteur a atteint ce plafond attend le tour suivant. Le tour se
    // termine quand plus rien d'autre n'est possible.
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
    let interleaved = null; // passages proposés par la règle anti-série
    let byBar = false; // passage choisi par l'ordre du bar (lu par withRound)
    const reserved = reservation && cands.find(c => c.ids[0] === reservation.personId);
    const withRound = c => {
      // Un duo peut réunir une table déjà servie et une table encore neuve.
      // Ce passage complète alors le tour ; il ne remet pas à zéro les tables
      // restantes (compteurs conservés pour l'historique).
      const newGroupRound = newPersonRound || cands.every(candidate =>
        candidate.groups.every(group => roundGroups.has(group)));
      // Passage repris d'un tour déjà commencé : choisi par la règle
      // anti-série, ou prochain annoncé automatiquement quand le tour semblait
      // fini, puis rattrapé par une arrivée (Dam's à 01:49 le 10 octobre).
      // `borrowable` le note au moment de l'annonce : une priorité ou un ordre
      // du bar, un report levé ou un passage ordinaire ne créent pas de dette.
      const borrowing = interleaved?.includes(c) || (c === reserved && !!reservation.borrowable && !newPersonRound);
      const borrowedIds = borrowing ? c.consumedIds.filter(pid => physicalRound.has(pid)) : [];
      const borrowable = !byBar && c !== reserved && (newPersonRound || borrowedIds.length > 0);
      return { ...c, newPersonRound, roundResets, newGroupRound, ...(newPersonRound ? { owed: [...owed] } : {}),
        ...(borrowedIds.length ? { borrowedIds } : {}), ...(borrowable ? { borrowable } : {}) };
    };
    if (reserved) return withRound(reserved);
    // Place de chaque personne dans l'ordre manuel du bar (la première, comme
    // indexOf), relevée une fois par passage prévu plutôt qu'à chaque candidat.
    const manualRanks = new Map();
    this.manualOrder.forEach((pid, index) => { if (!manualRanks.has(pid)) manualRanks.set(pid, index); });
    if (this.manualOrderActive) {
      const explicit = cands.filter(c => manualRanks.has(c.ids[0]) &&
        (!projectedSongs || c.song === this.people.get(c.ids[0])?.song))
        .sort((a, b) => manualRanks.get(a.ids[0]) - manualRanks.get(b.ids[0]));
      if (explicit.length) { byBar = true; return withRound(explicit[0]); }
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
      if (alternates.length) choices = interleaved = alternates;
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
    const manual = choices.filter(c => manualRanks.has(c.ids[0]) &&
      (!projectedSongs || c.song === this.people.get(c.ids[0])?.song))
      .sort((a, b) => manualRanks.get(a.ids[0]) - manualRanks.get(b.ids[0]));
    if (manual.length) { byBar = true; return withRound(manual[0]); }
    // Partage du tour entre les tables selon le mode choisi.
    const weights = this._groupWeights(cands);
    const deficits = this._groupDeficits(weights, history,
      new Set(cands.map(c => c.ids[0])).size);
    const need = c => Math.max(...c.groups.map(g => deficits.get(g) ?? -Infinity));
    const size = c => Math.max(...c.groups.map(g => weights.get(g) || 0));
    const tableIds = [...this.tables.keys()];
    const tableIndex = new Map(tableIds.map((tableId, index) => [tableId, index]));
    const tableRank = c => Math.min(...c.ids.map(pid =>
      tableIndex.get(this.people.get(pid)?.tableId) ?? tableIds.length));
    // Clés calculées une fois par candidat, pas à chaque comparaison : le tri
    // et son résultat sont les mêmes, sans recalculer écarts et rangs de table
    // des centaines de fois par passage prévu.
    const keyed = choices.map(c => ({ c, need: need(c), size: size(c), table: tableRank(c),
      weight: this.personWeight(c.ids[0]), recent: mostRecent(c) }));
    keyed.sort((a, b) => {
      const byNeed = b.need - a.need;
      if (Math.abs(byNeed) > EPS) return byNeed;
      return b.size - a.size || a.table - b.table || b.weight - a.weight ||
        a.recent - b.recent || a.c.at - b.c.at;
    });
    return withRound(keyed[0].c);
  }

  // Renvoie la prochaine chanson à envoyer (sans rien modifier), ou null.
  // `stageFree` : rien ne joue ni n'est chargé dans KaraFun. Si plus aucun
  // autre passage ne peut partir, le premier passage repoussé (« Pas prêt »)
  // part quand même, comme le montre déjà la prévision de la file : la
  // scène ne reste pas vide alors que la file contient des titres.
  select({ stageFree = false } = {}) {
    this._maybeRequestSolver();
    if (this.reservedNext) {
      const p = this.people.get(this.reservedNext.personId);
      const duet = p?.song?.duet;
      const guest = duet?.state === 'accepted' ? this.people.get(duet.partnerId) : null;
      if (!p || p.withdrawnAt || !p.song || this._isDeferred(p) ||
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
    if (!c && stageFree && deferred.length) {
      const owner = this.people.get(deferred[0]);
      const who = (owner.deferral.ids || [owner.id]).map(pid => this.people.get(pid)?.name).filter(Boolean).join(' & ');
      this._event('defer.ended', { ownerId: owner.id, entryId: owner.deferral.entryId, how: 'alone' });
      owner.deferral = null;
      this.invalidateManualOrder();
      this.version++;
      this.note(`Personne d’autre ne peut chanter : le passage repoussé ${/^[aeiouyàâéèêëîïôûùh]/i.test(who) ? 'd’' : 'de '}${who} part maintenant`, 'skip');
      return this.select({ stageFree });
    }
    if (!c) return null;
    const names = c.ids.map(pid => this.people.get(pid).name);
    return { ...c, label: this.passageLabel(c.ids), names,
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
        this.reservedNext = { personId: selected.ids[0], reservedAt: Date.now(),
          ...(selected.borrowable ? { borrowable: true } : {}) };
      });
      this.version++;
    }
    return selected;
  }

  // Réserve le premier titre réellement prêt hors confirmation de présence.
  // Les tickets sans chanson ne figurent pas ici ; un titre dont l'invitation
  // de duo attend encore sa réponse, si. Une réservation existante reste
  // stable tant que son titre existe.
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
      this.reservedNext = { personId: first.ids[0], reservedAt: Date.now(), ...(first.borrowable ? { borrowable: true } : {}) };
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
      c.ids.forEach(pid => this._useRound(roundPeople, roundUse, pid, !!c.borrowedIds?.includes(pid)));
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
  // Chaque téléphone relit la file toutes les 4 s : la prévision d'un état est
  // calculée une fois, puis resservie (nouveau tableau, passages partagés à ne
  // pas modifier) à toutes les lectures, tant que rien ne change. Elle est
  // oubliée à chaque écriture de `version`, quand le plan adopté ou un réglage
  // lu change, et à l'heure où un report « Pas prêt » ou une confirmation
  // « Je suis là » prend fin (_viewExpiry). L'empreinte de la file relevée
  // avec elle (optimiseur disponible ou plan adopté) vaut aussi tant qu'elle
  // est juste : la resérialiser à chaque lecture coûtait plus que la lecture.
  readyView(excludeIds = [], provisional = null, ignorePresence = false) {
    const now = Date.now();
    const key = this._viewKey(excludeIds, provisional, ignorePresence);
    const kept = this._viewFresh(this._views.get(key), now);
    const fingerprint = kept?.fingerprint ?? (this._solverWatching() ? this.solverContextFingerprint() : null);
    this._maybeRequestSolver(fingerprint);
    // Une demande à l'optimiseur écrit `version` : la prévision est oubliée.
    if (kept && this._viewFresh(this._views.get(key), now) === kept) {
      kept.fingerprint = fingerprint;
      return kept.view.slice();
    }
    const plan = this.solverPlan;
    const until = this._viewExpiry(now);
    const view = this._readyView(excludeIds, provisional, ignorePresence);
    if (this._views.size >= VIEW_CACHE_MAX) this._views.clear();
    this._views.set(key, { view, at: now, until, plan, planFingerprint: plan?.fingerprint, ranks: plan?.ranks, fingerprint });
    return view.slice();
  }

  // Prévision gardée encore juste pour le plan adopté et l'heure `now`, sinon null.
  _viewFresh(kept, now) {
    const plan = this.solverPlan;
    return kept && kept.plan === plan && kept.planFingerprint === plan?.fingerprint && kept.ranks === plan?.ranks &&
      now >= kept.at && now < kept.until ? kept : null;
  }

  // Toute écriture de `version` oublie les prévisions gardées, même quand le
  // serveur la remet à sa valeur d'avant (sauvegarde impossible) : une même
  // valeur ne sert jamais la prévision d'un autre état.
  get version() { return this._version; }
  set version(value) {
    this._version = value;
    this._views?.clear();
  }

  // Ce qui change une prévision sans passer par `version` : ses arguments
  // (passages exclus, sélection en cours d'envoi) et les réglages qu'elle lit.
  _viewKey(excludeIds, provisional, ignorePresence) {
    const o = this.opts;
    const sel = provisional && [provisional.ids, provisional.consumedIds, provisional.groups, provisional.group,
      provisional.kind, provisional.roundResets, provisional.newPersonRound, provisional.newGroupRound, provisional.owed,
      provisional.borrowedIds];
    return JSON.stringify([[...excludeIds], sel, !!ignorePresence, o.requirePresence, o.cap, o.tableRotation,
      o.weightedTables, o.interleaveArrivals, o.roundAppearanceCap, o.spacingSongs]);
  }

  // Heure où une prévision cesse d'être juste sans aucune action : fin du
  // report « Pas prêt » (_isDeferred) ou de la confirmation « Je suis là »
  // (_confirmedRecently) la plus proche.
  _viewExpiry(now) {
    let until = Infinity;
    for (const p of this.people.values()) {
      const deferredUntil = Number(p.deferral?.until);
      if (deferredUntil > now) until = Math.min(until, deferredUntil);
      if (p.confirmedAt && now - p.confirmedAt < CONFIRM_MS) until = Math.min(until, Number(p.confirmedAt) + CONFIRM_MS);
    }
    return until;
  }

  // Calcul complet de readyView, sans prévision gardée.
  _readyView(excludeIds, provisional, ignorePresence) {
    const qIndex = new Map(this.Q.map((pid, i) => [pid, i]));
    const out = [];
    for (const c of this._forecast(false, excludeIds, provisional, ignorePresence)) {
      const owner = this.people.get(c.ids[0]);
      if (!owner) continue;
      out.push({ ids: c.ids, song: c.song, entryId: c.entryId, future: c.future, kind: c.kind, ...(c.borrowable ? { borrowable: true } : {}),
        groups: c.groups, name: c.ids.map(pid => this.people.get(pid)?.name).filter(Boolean).join(' & '),
        // Nom du passage (écran KaraFun, téléphones) et tables seules (page du
        // bar) : jamais le nom d'un groupe individuel comme « En solo ».
        label: this.passageLabel(c.ids), table: this.passageTables(c.ids).join(' + '),
        tableId: owner.tableId, qi: qIndex.get(owner.id),
        over: owner.over, cap: this.opts.cap, confirmed: !!this._confirmedRecently(owner) });
    }
    return out;
  }

  presenceView(excludeIds = [], provisional = null) {
    return this.readyView(excludeIds, provisional, true);
  }
}

module.exports = SchedulerRotation;
