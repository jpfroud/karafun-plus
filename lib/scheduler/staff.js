'use strict';
// Planificateur, partie gestes du bar sur la file (déplacer, retirer, remettre en tête) et placement des nouveaux.
// Méthodes de Scheduler (scheduler.js), recopiées sur sa classe au
// chargement : elles partagent ses états (this) comme si elles y étaient écrites.

class SchedulerStaff {
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
    if (moved?.deferral) {
      this._event('defer.ended', { ownerId: moved.id, entryId: moved.deferral.entryId, how: 'staff-move' });
      moved.deferral = null;
    }
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

  // `tell(personId)` : faux pour une personne que l'appelant prévient
  // lui-même (retrait des titres trop longs) au lieu de l'avis habituel.
  staffRemove(personId, tell = () => true) {
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
    if (removed) this._songsGone(p, [removed], tell);
    p.song = (p.backlog || []).shift() || null;
    if (removed) this._noteEmptied(p);
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
    this.invalidateManualOrder();
    this._refreshDuetViews();
    this._event('song.removed', { personId: p.id, entryId: removed.entryId, by: 'staff' });
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
}

module.exports = SchedulerStaff;
