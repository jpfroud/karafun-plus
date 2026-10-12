'use strict';
// Planificateur, partie « Je suis là » et « Pas prêt » (report d’un passage).
// Méthodes de Scheduler (scheduler.js), recopiées sur sa classe au
// chargement : elles partagent ses états (this) comme si elles y étaient écrites.
const { DEFER_MAX, DEFER_MIN_SLOT_SEC, DEFER_SLOTS_PER_SONG, DEFER_GRACE_MS } = require('./common');

class SchedulerPresence {
  // ------------------------------------------------------------------ actions du chanteur
  confirm(p) {
    p.confirmedAt = Date.now(); p.held = 0;
    p.presenceSkips = 0; p.maybeGone = null;
    this.version++;
    this._event('presence.confirmed', { personId: p.id, entryId: p.song?.entryId || null });
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
      this._event('presence.skipped', { personId: p.id, entryId: p.song.entryId, skips, removed: true });
      this.removeSong(p, p.song.entryId, 'presence-max');
      this.notify(p.id, 'presenceRemoved', { title, skips });
      this.note(`${p.name} n'a pas confirmé sa présence ${skips} fois : « ${title} » est retiré de sa liste. Vérifie si ${p.name} est encore là.`, 'staff');
      return { removed: true, skips, title };
    }
    p.presenceRetry = true;
    this.version++;
    this._event('presence.skipped', { personId: p.id, entryId: p.song.entryId, skips: p.presenceSkips, removed: false });
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

  // « Toujours là » du bar : ferme l'alerte, sans confirmer la présence ni
  // toucher à la file. Rend le message pour le bar, qui nomme la personne
  // (avec sa table) et dit la suite (presenceFollowUp). null : l'alerte était
  // déjà fermée (un départ ou un passage la ferment aussi).
  dismissMaybeGone(p) {
    if (!p.maybeGone) return null;
    p.maybeGone = null;
    this._event('presence.stillHere', { personId: p.id });
    const next = this.presenceFollowUp(p);
    this.note(`Alerte fermée par le bar : ${this.personRef(p)} serait toujours là.${next ? ` ${next}` : ''}`, 'staff');
    return `Alerte fermée pour ${this.personRef(p)}.${next ? ` ${next}` : ''}`;
  }

  // Ce qui attend la personne, pour le bar : son prochain titre redemande
  // « Je suis là » (rien de plus si l'option est coupée). Sans titre à son
  // nom (option active ou non) : les duos acceptés où elle est invitée, dans
  // l'ordre de la file, puis un titre à rechoisir pour un passage à son nom,
  // et une invitation de duo qui attend sa réponse.
  presenceFollowUp(p) {
    if (this.songsOf(p).length) return this.opts.requirePresence ? 'Son prochain titre redemande « Je suis là ».' : '';
    const rank = new Map();
    this.presenceView().forEach((v, i) => { if (!rank.has(v.entryId)) rank.set(v.entryId, i); });
    const owners = [...new Set(this.guestDuetsOf(p)
      .sort((a, b) => (rank.get(a.entryId) ?? Infinity) - (rank.get(b.entryId) ?? Infinity))
      .map(d => this.personRef(this.people.get(d.ownerId))))];
    const invite = this.duetInvites(p)[0];
    const waiting = invite ? ` L'invitation de duo de ${this.personRef(this.people.get(invite.fromId))} attend sa réponse.` : '';
    if (!owners.length) return `Plus aucun titre à son nom : il faut en rechoisir un pour chanter.${waiting}`;
    const duos = owners.length > 1 ? `les duos avec ${owners.join(' puis ')} restent prévus` : `le duo avec ${owners[0]} reste prévu`;
    return `Plus aucun titre à son nom ; ${duos}. Pour un passage à son nom, il faut rechoisir un titre.${waiting}`;
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
    this._event('defer.requested', { ownerId: p.id, personIds: ids, entryId, songs: n, total, remaining });
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
    this._event('defer.ended', { ownerId: p.id, entryId, how: 'dropped' });
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
    this._event('defer.ended', { personId: String(personId), ownerId: p.id, entryId: p.deferral.entryId, how: 'ready' });
    p.deferral = null;
    this.invalidateManualOrder();
    this.version++;
    const who = this.people.get(String(personId))?.name || p.name;
    this.note(`${who} est prêt : son passage reprend sa place`, 'info');
    return p;
  }
}

module.exports = SchedulerPresence;
