'use strict';
// Planificateur, partie passages : crédits de tour, retour d’un titre non chanté, envoi (commit) et scène.
// Méthodes de Scheduler (scheduler.js), recopiées sur sa classe au
// chargement : elles partagent ses états (this) comme si elles y étaient écrites.
const { PLAYED_LIMIT, HISTORY_LIMIT, id } = require('./common');

class SchedulerPassages {
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
      over: p.over || 0, held: p.held || 0, readySerial: p.readySerial || 0,
      readySince: p.readySince ?? null } : { id: pid };
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
      // Seul le compte revient : les chanteurs du passage reporté ont pu
      // changer depuis (invitation acceptée, invitée retirée du duo).
      p.deferral = { ...old, ...(Array.isArray(p.deferral?.ids) ? { ids: [...p.deferral.ids] } : {}) };
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
      // Début d'attente (patience et anti-série de _pick) : ce passage n'a pas
      // eu lieu, la personne dont le titre est parti attend depuis avant lui,
      // même si elle a choisi un autre titre entre-temps (pas l'invitée d'un
      // duo, dont le titre n'est pas parti) ; et personne n'attend depuis un
      // passage qui n'existe plus. Son heure (`readySince`, ordre d'ajout des
      // premiers passages) revient avec lui ; un reçu d'avant ce champ la garde.
      const consumed = new Set(sel.consumedIds || sel.ids.slice(0, 1));
      for (const old of before.people) {
        if (!consumed.has(old.id)) continue;
        const p = this.people.get(old.id);
        if (p && Number.isFinite(old.readySerial) && (p.readySerial || 0) > old.readySerial) p.readySerial = old.readySerial;
        if (p && Number.isFinite(old.readySince) && (p.readySince || 0) > old.readySince) p.readySince = old.readySince;
      }
      // Un titre retiré pendant l'envoi de ce passage reste un échange.
      for (const p of this.people.values()) {
        if ((p.readySerial || 0) > this.appearanceSerial) p.readySerial = this.appearanceSerial;
        if (p.emptiedAt > this.appearanceSerial) p.emptiedAt = this.appearanceSerial;
      }
      // Le titre de ce passage n'a pas été chanté : en choisir un autre avant
      // le prochain passage est un échange, l'attente continue (chooseSong).
      // Seul le titre du passage compte, pas l'invitée d'un duo.
      for (const pid of consumed) {
        const p = this.people.get(pid);
        if (p && !p.withdrawnAt && !this.songsOf(p).length && this.Q.includes(p.id) && p.emptiedAt === undefined) {
          p.emptiedAt = this.appearanceSerial;
        }
      }
      // Un titre retiré juste avant ce passage aussi, si le compteur revient
      // où il était (aucun autre passage depuis).
      if (this.appearanceSerial === before.appearanceSerial) {
        for (const [pid, at] of Array.isArray(credit.emptied) ? credit.emptied : []) {
          const p = this.people.get(pid);
          if (p && !p.withdrawnAt && !this.songsOf(p).length && p.emptiedAt === undefined && Number.isInteger(at)) {
            p.emptiedAt = Math.min(at, this.appearanceSerial);
          }
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
    const [first, second] = sel.ids;
    // Ceux qui étaient devant sans être prêts faute de confirmation : on compte, et au 2e raté on recule de 3
    if (this.opts.requirePresence) {
      // `sel.at` compte dans la file sans les titres retenus : la place réelle
      // du chanteur dans Q dit qui était devant lui. Un passage reporté
      // (« Pas prêt ») n'est pas une absence, ni un duo ouvert qui attend un
      // volontaire en « Duos uniquement » : il ne pouvait pas partir.
      const ownerAt = this.Q.indexOf(first);
      const limit = ownerAt >= 0 ? ownerAt : sel.at;
      const deferred = this._deferredPeople();
      for (let i = 0; i < limit && i < this.Q.length; i++) {
        const q = this.people.get(this.Q[i]);
        if (q && q.song && !deferred.has(q.id) && !this._openHeld(q.song) && !this._isPresenceRetry(q) && !this._confirmedRecently(q) && !sel.ids.includes(q.id)) {
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
      // Titre de la liste effectivement parti (la sélection peut être une
      // copie relue après un redémarrage).
      const sent = owner.song && (owner.song.entryId ? owner.song.entryId === sel.song.entryId : owner.song === sel.song) ?
        owner.song : null;
      if (sent) owner.song = (owner.backlog || []).shift() || null;
      // Demandes de duo sans réponse : le titre part sans les attendre.
      this._closeJoinRequests(owner, sel.song, 'sent');
      // Invitation ou duo ouvert sans réponse : le titre est parti en solo, la
      // demande expire. Titre remplacé ou retiré pendant l'envoi : l'invitée a
      // déjà appris l'annulation du duo (_songsGone), rien n'expire ni n'est prévenu.
      if (!second) {
        if (sent) { this._expireInvite(owner, sent); this._expireOpenDuet(owner, sent); }
        if (['pending', 'open'].includes(sel.song.duet?.state)) delete sel.song.duet;
      }
    }
    this._refreshDuetViews();
    const resets = sel.roundResets ?? (sel.newPersonRound ? 1 : 0);
    for (let k = 0; k < resets; k++) this._resetRound(this.roundPeople, this.roundUse, this.roundApps);
    if (resets) this.roundOwed = new Set((sel.owed || []).filter(pid => this.people.has(pid)));
    if (sel.newGroupRound) this.roundGroups.clear();
    const roundCharged = [];
    sel.ids.forEach(pid => {
      this.roundOwed.delete(pid);
      if (!this.people.has(pid)) return;
      const charged = this._useRound(this.roundPeople, this.roundUse, pid, !!sel.borrowedIds?.includes(pid));
      if (charged) roundCharged.push([pid, charged]);
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
    // Une liste vidée avant ce passage n'est plus un échange de titre : la
    // rechoisir commence une nouvelle attente (chooseSong). Effacé ici, car le
    // compteur seul ne suffit pas : il peut reculer sans qu'un passage soit
    // annulé (duo noté puis retiré par le bar). Gardé dans le reçu : si ce
    // passage est annulé, l'échange reprend (rollbackUnplayed).
    const emptied = [];
    for (const p of this.people.values()) {
      if (p.emptiedAt === undefined) continue;
      emptied.push([p.id, p.emptiedAt]);
      delete p.emptiedAt;
    }
    // Le titre part vers KaraFun : sa ligne quitte l'ordre fixé par le bar, et
    // ses gestes ne s'annulent plus ; les lignes placées derrière elle
    // avancent d'une place et gardent leurs gestes. Les autres lignes fixées
    // où ces chanteurs reviennent (l'invitée d'un duo et son propre titre)
    // retrouvent le calcul, sauf une place donnée par le bar lui-même.
    for (const pid of (sel.consumedIds || sel.ids.slice(0, 1))) this._unpinManual(pid);
    this._unpinSingers(sel.ids);
    if (this.reservedNext?.personId === sel.ids[0]) this.releaseNext();
    // Monter sur scène efface les « Je suis là » manqués. Un titre passé faute
    // de présence devient le prochain annoncé, juste après ce passage.
    // Chaque passage envoyé rapproche aussi les titres reportés (« Pas
    // prêt ») ; le premier arrivé au bout de son report est annoncé ensuite.
    const deferralUndo = [];
    for (const pid of this._deferredOwners()) {
      const p = this.people.get(pid);
      deferralUndo.push({ pid, deferral: { ...p.deferral } });
      if (sel.ids.includes(pid)) {
        this._event('defer.ended', { ownerId: pid, entryId: p.deferral.entryId, how: 'sent' });
        p.deferral = null;
      }
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
      this._event('defer.ended', { ownerId: ready, entryId: this.people.get(ready).deferral.entryId, how: 'released' });
      this.people.get(ready).deferral = null;
      this.reservedNext = { personId: ready, reservedAt: Date.now() };
      sel.deferralReleasedTo = ready;
    }
    if (deferralUndo.length) sel.deferralUndo = deferralUndo;
    sel.turnCredit = { before: creditBefore, after: this._turnCreditState(sel), rolledBack: false, roundCharged, emptied };
    // Le journal montre le nom recalculé ; `sel.label` (nom reçu par KaraFun,
    // peut-être à l'ancien format) ne sert qu'à y reconnaître le titre.
    const ids = sel.ids || [];
    const shown = ids.length && ids.every(pid => this.people.has(String(pid))) ? this.passageLabel(ids) : sel.label;
    this.note(`À suivre : ${shown} — « ${sel.song.title} »`, 'next');
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
    // Tour de ce passage : un duo noté après la chanson y compte l'invité
    // (staffCountPartner), même si le titre suivant du chanteur est déjà parti.
    const turn = this._passageTurn(sel);
    if (turn) entry.turn = turn;
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
}

module.exports = SchedulerPassages;
