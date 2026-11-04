'use strict';
// Planificateur, partie gestes du bar sur la file (déplacer, retirer) et placement des nouveaux.
// Méthodes de Scheduler (scheduler.js), recopiées sur sa classe au
// chargement : elles partagent ses états (this) comme si elles y étaient écrites.

class SchedulerStaff {
  // ------------------------------------------------------------------ actions du bar
  // `head` (sans `then`) devient l'annonce en cours, comme « Priorité » le
  // fait (staffMove, place 0) et comme l'annulation d'un glissement de
  // l'annonce en cours la lui rend (_undoRebased, `headMoved`). L'annonce
  // qu'elle remplace reste juste derrière elle (`then`), telle qu'elle était,
  // si c'est une priorité plus ancienne du bar, un titre revenu de KaraFun en
  // tête (`pulledBack`, ou `back` une fois copié dans la chaîne), une personne
  // sautée faute de « Je suis là » annoncée juste après un passage, le titre
  // retiré pour une priorité annoncé après elle (`pulled`) ou la personne
  // sautée qui a confirmé depuis (`retry`) : sinon la priorité d'un duo
  // perdait son passe-droit sur le « Pas prêt » de son invitée, et une
  // nouvelle table passait devant elles (relecture, passes 17, 18 et 22). Une
  // annonce de la file reprend le calcul, comme avant, mais celles qu'elle
  // gardait derrière elle restent derrière la nouvelle tête. Annonce en route
  // vers KaraFun (`excludeIds`) : elle part, celles qu'elle gardait restent
  // derrière la nouvelle tête, comme si le geste venait après son accusé
  // (passe 18) ; de même pour la même ligne (« Priorité » redonnée avant le
  // titre chargé, par exemple : passe 19). Le titre retiré de KaraFun qui
  // attend la priorité remplacée (`waiting`, son report « après la
  // priorité ») devient un maillon de la chaîne juste derrière elle (passes
  // 17 et 19). Au-delà de BEHIND_MAX, les plus anciennes tombent comme une
  // annonce qui ne peut pas suivre (_dropBehind).
  _placeAhead(head, excludeIds = [], waiting = undefined) {
    const placed = head.personId;
    const old = this.reservedNext;
    const oldPerson = old && this.people.get(old.personId);
    const inFlight = !!old && excludeIds.includes(old.personId);
    if (waiting === undefined) waiting = old?.byStaff ? this._titleWaitingFor(old) : null;
    const keep = !!oldPerson && old.personId !== placed && !inFlight &&
      (old.byStaff || !!old.pulledBack || !!old.back || !!old.pulled || !!old.retry ||
        (this.presenceSkipsOf(oldPerson) > 0 && !this._confirmedRecently(oldPerson)));
    let source = keep ? old : old?.then || null;
    if (waiting && waiting.id !== placed && waiting.deferral) {
      const d = waiting.deferral;
      if (keep) {
        const { then, ...top } = old;
        source = { ...top, then: this._pulledLink(waiting, d.forId, d.forAt, then || null) };
      } else source = this._pulledLink(waiting, d.forId, d.forAt, source);
      this._endDeferral(waiting, 'released');
    }
    const cut = [];
    const behind = this._behindCopy(this._pruneBehind(source, link => link.personId === placed), 0, cut);
    this.reservedNext = { ...head, ...(behind ? { then: behind } : {}) };
    for (const link of cut) this._dropBehind(link);
    this.version++;
  }

  // Rend la place prise (de 0), plus basse que `toIndex` pour une ligne
  // glissée parmi les annonces gardées.
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
    const asked = Number(toIndex);
    if (!Number.isInteger(asked) || asked < 0 || asked >= visible.length) throw new Error('Place de destination invalide.');
    // Titre retiré de KaraFun qui attend la priorité en tête (son report
    // « après la priorité », yieldToPriority) : une nouvelle priorité passe
    // devant les deux, et il devient un maillon de la chaîne juste derrière
    // celle qu'elle remplace (ci-dessous). Sinon il reprenait sa place
    // calculée, et une nouvelle table passait devant lui (relecture, passes
    // 17 et 19).
    const waiting = asked === 0 && this.reservedNext?.byStaff ? this._titleWaitingFor(this.reservedNext) : null;
    // Le bar place lui-même ce passage : un report « Pas prêt » est levé.
    const moved = this.people.get(personId);
    if (moved?.deferral) this._endDeferral(moved, 'staff-move');
    const [item] = visible.splice(i, 1);
    // Annonces gardées derrière l'annonce en cours (la tête, sa chaîne `then`,
    // le titre retiré de KaraFun qui attend sa priorité, une personne sautée
    // faute de « Je suis là » qui passe juste après le prochain passage) :
    // elles gardent leur ordre, une ligne glissée parmi elles se place juste
    // après elles ; seule « Priorité » passe devant. Sinon la chaîne et
    // l'ordre fixé se contredisaient, et chaque déplacement dans la chaîne
    // ouvrait un nouvel ordre faux (relecture, passes 20 à 22).
    const keptEnd = asked === 0 ? 0 : this._keptEnd(visible, item.ids[0]);
    const target = asked === 0 ? 0 : Math.max(asked, keptEnd);
    // Une ligne gardée glissée juste après les annonces gardées le reste, au
    // bout de la chaîne, sauf si une personne sautée faute de « Je suis là »
    // les termine : elle ne passe qu'une fois la chaîne finie (_commit), la
    // ligne serait passée devant elle (relecture, passes 23 et 24).
    const keptLast = target === keptEnd && !(keptEnd > 0 && this._isPresenceRetry(this.people.get(visible[keptEnd - 1].ids[0])));
    visible.splice(target, 0, item);
    if (target !== 0 && this.reservedNext) this._moveKept(item.ids[0], keptLast);
    // Un titre déjà en cours d'envoi peut encore porter l'ancienne réservation.
    // Réordonner les titres suivants ne doit pas toucher à cette commande.
    if (target === 0 && visible[0]) {
      // Le bar avance explicitement ce passage. Cette dérogation unique peut
      // dépasser l'équité des premiers passages ; l'ordre mémorisé des autres
      // lignes ne le peut pas.
      // `byStaff` : place réservée par le bar, abandonnée avec les autres
      // déplacements manuels quand il relance le calcul de la file. Son heure
      // d'annonce suit celle qu'elle remplace, même dans la même
      // milliseconde : une annulation qui rend l'annonce d'avant se reconnaît
      // (yieldToPriority, _backFirst ; relecture, passe 17). Ce qu'elle garde
      // derrière elle : _placeAhead.
      this._placeAhead({ personId: visible[0].ids[0], reservedAt: this._staffStamp(this.reservedNext), byStaff: true }, excludeIds, waiting);
    }
    // Seul le préfixe qui fixe la place demandée passe avant l'équité : la
    // ligne placée et celles devant elle gardent leur ordre jusqu'à leur
    // départ vers KaraFun ; ni un titre ajouté, ni une arrivée, ni Timefold ne
    // passent devant. Les gestes se cumulent : le préfixe va jusqu'à la
    // dernière ligne placée, celle-ci ou une plus ancienne. Les titres
    // suivants restent soumis aux premiers passages et à la rotation.
    // Une ligne déjà fixée que la file affichée ne montre pas à son rang
    // (duo ouvert retenu en « Duos uniquement », passage exclu de la
    // prévision, report « Pas prêt » qui l'affiche plus loin) garde sa place
    // parmi les lignes fixées : juste derrière celle qui la précédait, et
    // derrière la ligne que le bar place au même endroit. Sinon elle sortait
    // de l'ordre fixé, ou fixait les lignes devant lesquelles son report
    // l'affichait, alors que son geste restait noté (relecture).
    const anchors = this._manualAnchors();
    anchors.delete(item.ids[0]);
    const kept = this.manualOrder.filter(pid => pid !== item.ids[0]);
    const shown = new Set(visible.map(v => v.ids[0]));
    const aside = new Set(kept.filter(pid => !shown.has(pid) || this._isDeferred(this.people.get(pid))));
    const lines = visible.map(v => v.ids[0]).filter(pid => !aside.has(pid));
    kept.forEach((pid, k) => {
      if (!aside.has(pid)) return;
      let at = k ? lines.indexOf(kept[k - 1]) + 1 : 0;
      if (lines[at] === item.ids[0]) at++;
      lines.splice(at, 0, pid);
    });
    let last = lines.indexOf(item.ids[0]);
    lines.forEach((pid, index) => { if (anchors.has(pid)) last = Math.max(last, index); });
    this.manualOrder = lines.slice(0, last + 1);
    this.manualOrderActive = this.manualOrder.length > 0;
    this.note(`Le bar a déplacé ${this.people.get(item.ids[0]).name} de la place ${i + 1} à la place ${target + 1}`, 'staff');
    // Les titres après l'ordre fixé gardent aussi l'ordre affiché, sans
    // nouveau calcul de Timefold, jusqu'au prochain changement réel de la
    // file ; ils sont alors recalculés, pas les lignes placées.
    const order = full.filter(v => v.entryId !== item.entryId).map(v => v.entryId);
    const after = visible[target + 1]?.entryId, before = visible[target - 1]?.entryId;
    const at = after ? order.indexOf(after) : before ? order.indexOf(before) + 1 : 0;
    order.splice(at < 0 ? order.length : at, 0, item.entryId);
    this.solverPlan = { version: this.version, fingerprint: this.solverContextFingerprint(),
      ranks: new Map(order.filter(Boolean).map((entry, index) => [entry, index])), source: 'manual' };
    return target;
  }

  // `tell(personId)` : faux pour une personne que l'appelant prévient
  // lui-même (retrait des titres trop longs) au lieu de l'avis habituel.
  staffRemove(personId, tell = () => true) {
    const p = this.people.get(personId);
    if (!p) return;
    const removed = p.song;
    const remove = () => {
      if (removed) this._songsGone(p, [removed], tell);
      p.song = (p.backlog || []).shift() || null;
      if (removed) this._noteEmptied(p);
      // Avec un titre de rechange, celui-ci prend la place du titre retiré, y
      // compris une place donnée par le bar. Sans rechange, la ligne sort de
      // la file : ses gestes tombent, les autres lignes placées gardent la leur.
      if (!p.song) this._unpinManual(p.id);
      else { this._guestJoined(p); this._duetOnAnnounced(p, p.song); this._keepWaitingSlot(p, removed); }
      if (!p.song) this._endLine(p.id);
      this._refreshDuetViews();
    };
    // Sans rechange, avec des gestes du bar en vigueur, la ligne disparaît
    // comme un passage parti : le plan affiché (ordre du bar ou Timefold)
    // reste valable pour les autres lignes, qui ne bougent pas. Sans geste,
    // la file se recalcule comme avant.
    if ((p.backlog || []).length || !this.manualChanges.length) remove(); else this._carryPlanAcross(remove);
    // Garder le ticket au même endroit : retirer un titre ne remet pas le
    // chanteur en fin de file, même si le prochain titre devient actif.
    if (removed) this._event('song.removed', { personId: p.id, entryId: removed.entryId, by: 'staff' });
    this.note(`Le bar a retiré ${removed ? `« ${removed.title} »` : 'le titre'} de ${p.name}${p.song ? ` ; « ${p.song.title} » prend sa place` : ''}`, 'staff');
  }

  // Retrait d'un titre précis, y compris un titre suivant de la liste d'une
  // personne (sélection multiple dans la page du bar).
  staffRemoveEntry(personId, entryId, tell = () => true) {
    const p = this.people.get(String(personId || ''));
    if (!p) throw new Error('Chanteur inconnu.');
    if (!entryId || p.song?.entryId === String(entryId)) return this.staffRemove(p.id, tell);
    const index = (p.backlog || []).findIndex(song => song.entryId === String(entryId));
    if (index < 0) throw new Error('Titre introuvable dans la liste de ce chanteur.');
    const [removed] = p.backlog.splice(index, 1);
    this._songsGone(p, [removed], tell);
    this._refreshDuetViews();
    this._event('song.removed', { personId: p.id, entryId: removed.entryId, by: 'staff' });
    this.note(`Le bar a retiré « ${removed.title} » de la liste de ${p.name}`, 'staff');
  }

  // Place (de 0) que prendrait la ligne `personId` glissée à `toIndex`, sans
  // rien changer : au plus haut, juste après les annonces gardées (staffMove).
  staffMoveTarget(personId, toIndex, excludeIds = [], provisional = null) {
    const visible = this.presenceView(excludeIds, provisional).filter(v => !v.future);
    const i = visible.findIndex(v => v.ids[0] === personId);
    const asked = Number(toIndex);
    if (i < 0 || !Number.isInteger(asked) || asked <= 0) return asked;
    return Math.max(asked, this._keptEnd(visible.filter((v, k) => k !== i), personId));
  }

  // Nombre de lignes de `rest` (la file montrée sans la ligne `movedId`), en
  // tête, qui sont des annonces gardées : l'annonce en cours, sa chaîne
  // (`then`), le titre retiré de KaraFun qui attend sa priorité, une personne
  // sautée faute de « Je suis là » qui passe juste après le prochain passage.
  _keptEnd(rest, movedId) {
    const head = this.reservedNext;
    if (!head) return 0;
    const kept = new Set([head.personId]);
    for (let link = head.then; link; link = link.then) kept.add(link.personId);
    const waiting = this._titleWaitingFor(head);
    if (waiting) kept.add(waiting.id);
    for (const pid of this._presenceRetries()) kept.add(pid);
    kept.delete(movedId);
    let end = 0;
    while (end < rest.length && kept.has(rest[end].ids[0])) end++;
    return end;
  }

  // Le bar glisse plus bas la ligne `pid`, l'annonce en cours ou une annonce
  // gardée dans sa chaîne : elle sort de la chaîne comme une ligne qui prend
  // fin (_endLine), et l'ordre fixé la place où le bar la pose. L'annonce en
  // cours cède la tête (_passNext : la suivante gardée la prend, le titre
  // retiré qui l'attendait reprend la tête) ; elle n'est pas remise dans la
  // chaîne avec son heure d'annonce, que son titre retiré reconnaîtrait
  // encore (relecture, passe 23). Un maillon glissé juste après les annonces
  // gardées (`last`) y reste gardé, en dernier, tel qu'il était (priorité du
  // bar, titre retiré, personne sautée).
  _moveKept(pid, last) {
    const head = this.reservedNext;
    if (head.personId === pid) { this._endLine(pid); return; }
    let self = null;
    for (let link = head.then; link && !self; link = link.then) if (link.personId === pid) self = this._plainReservation(link);
    if (!self) return;
    this._endLine(pid);
    if (last && this.reservedNext && this._behindStands(self, [])) this._appendChain(self);
    this.version++;
  }

  // Heure d'annonce d'une priorité du bar : après celle qu'elle remplace et
  // après toute priorité donnée avant elle, même dans la même milliseconde.
  // Sinon deux gestes coup sur coup avaient la même heure, et le titre retiré
  // de KaraFun ne reconnaissait plus la priorité donnée depuis la sienne
  // (returnFromKaraFun ; relecture, passe 21).
  _staffStamp(old) {
    const at = Math.max(Date.now(), (old?.reservedAt || 0) + 1, (this._lastStaffStamp || 0) + 1);
    this._lastStaffStamp = at;
    return at;
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
}

module.exports = SchedulerStaff;
