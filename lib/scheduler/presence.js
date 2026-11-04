'use strict';
// Planificateur, partie « Je suis là » et « Pas prêt » (report d’un passage).
// Méthodes de Scheduler (scheduler.js), recopiées sur sa classe au
// chargement : elles partagent ses états (this) comme si elles y étaient écrites.
const { DEFER_MAX, DEFER_MIN_SLOT_SEC, DEFER_SLOTS_PER_SONG, DEFER_GRACE_MS, CONFIRM_MS, BEHIND_MAX } = require('./common');

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
    if (this.reservedNext?.personId === p.id) this._passNext();
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

  // Titre passé faute de « Je suis là », qui laisse passer le suivant. Pas
  // tant qu'une priorité du bar le place en tête : le geste du bar passe
  // avant, la demande « Je suis là » lui revient (reservePresenceNext) et,
  // sans réponse, skipUnconfirmed met fin à la priorité. Sinon il restait
  // retenu (select, prévision) pendant que sa priorité bloquait tout autre
  // envoi : la demande allait au suivant et rien ne partait (relecture,
  // passe 7).
  _isPresenceRetry(p) {
    if (!(p && !p.withdrawnAt && p.presenceRetry && p.song && p.presenceEntryId === p.song.entryId)) return false;
    for (let link = this.reservedNext; link; link = link.then) if (link.byStaff && link.personId === p.id) return false;
    return true;
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
  // (personRef) et donne son prochain passage (presenceFollowUp), calculé
  // avant de fermer l'alerte. null : l'alerte était déjà fermée (sa propre
  // confirmation, un départ ou un passage envoyé la ferment aussi).
  dismissMaybeGone(p) {
    if (!p.maybeGone) return null;
    const next = this.presenceFollowUp(p);
    p.maybeGone = null;
    this._event('presence.stillHere', { personId: p.id });
    this.note(`Alerte fermée par le bar : ${this.personRef(p)} serait toujours là. ${next}`, 'staff');
    return `Alerte fermée pour ${this.personRef(p)}. ${next}`;
  }

  // Pour le bar : le premier passage de la file où la personne chante (son
  // titre, ou un duo comme hôte ou invitée), et s'il redemandera « Je suis
  // là » ou si la présence est déjà confirmée ; sans titre à son nom, il
  // faut en rechoisir un sur son téléphone (le bar ne peut pas le faire).
  presenceFollowUp(p) {
    const next = this.presenceView().find(v => v.ids.includes(p.id));
    const pick = 'un titre à rechoisir sur son téléphone';
    if (!next) return `Aucun passage prévu : ${pick}.`;
    const partner = next.ids.find(id => id !== p.id);
    const duo = partner ? ` en duo avec ${this.personRef(this.people.get(partner))}` : '';
    const ask = !this.opts.requirePresence ? '' : this.confirmedForTurn(next.ids) ? ' Présence déjà confirmée.'
      : ' Ce passage redemandera « Je suis là ».';
    const own = this.songsOf(p).length ? '' : ` Pour un passage à son nom, ${pick}.`;
    return `Prochain passage : « ${next.song?.title || '?'} »${duo}.${ask}${own}`;
  }

  // ------------------------------------------------------------------ « Pas prêt »
  // Une personne pas encore prête (toilettes, cigarette…) laisse passer une
  // ou plusieurs chansons sans perdre son tour : son passage attend que
  // `remaining` autres passages soient envoyés, puis devient le prochain
  // annoncé. Le report suit le titre concerné : retiré ou remplacé, il
  // disparaît. Sans autre passage possible, il expire à `until`. Le titre
  // retiré de KaraFun pour une priorité du bar (yieldToPriority) n'attend que
  // tant que cette priorité tient (_priorityHolds).
  _isDeferred(p) {
    const d = p?.deferral;
    return !!(d && !p.withdrawnAt && p.song && d.entryId === p.song.entryId && Date.now() < d.until &&
      (!d.afterPriority || this._priorityHolds(d)));
  }

  // La priorité pour laquelle ce titre est sorti de KaraFun est encore le
  // prochain annoncé (`forId`, `forAt` : sa personne et l'heure de son
  // annonce). Annulée (« Annuler », « Recalculer la file »), son titre retiré
  // ou passé faute de « Je suis là », sa personne partie : le titre retiré
  // reprend sa place au lieu de laisser passer quelqu'un d'autre. Report sans
  // `forId` (titre retiré qui n'a pas pu suivre sa priorité ni reprendre la
  // tête à sa fin, en simple report : _commit, _plainReport ; ou sauvegarde
  // d'avant ce lien) : il tient.
  _priorityHolds(d) {
    if (typeof d?.forId !== 'string') return true;
    const reserved = this.reservedNext;
    return !!reserved?.byStaff && reserved.personId === d.forId && reserved.reservedAt === d.forAt;
  }

  _deferralKey(p) {
    return this._isDeferred(p) ? [p.deferral.remaining, p.deferral.ids || [p.id]] : null;
  }

  // Titres reportés, dans l'ordre de la file.
  _deferredOwners() {
    return this.Q.filter(pid => this._isDeferred(this.people.get(pid)));
  }

  // Personnes d'un passage reporté (« Pas prêt ») : _commit ne les compte pas
  // absentes à « Je suis là ». Le choix du passage, lui, suit _heldBy et
  // _heldFor, qui laissent partir le passage annoncé et une priorité du bar.
  _deferredPeople(owners = this._deferredOwners()) {
    return new Set(owners.flatMap(pid => this.people.get(pid)?.deferral?.ids || [pid]));
  }

  // Même chose pour le choix du passage (_pick, _heldFor) : chaque personne
  // retenue, avec les auteurs des reports qui l'attendent. `reports` :
  // [auteur, personnes du report], reports en cours (select) ou simulés
  // (_forecast).
  _heldBy(reports) {
    const out = new Map();
    for (const [owner, ids] of reports) for (const pid of ids) out.set(pid, [...(out.get(pid) || []), owner]);
    return out.size ? out : null;
  }

  // `pid`, qui chante sur le passage de la ligne `line`, le retient-il ?
  // (`held` : _heldBy.) Le passage annoncé (`reservation`) n'est jamais
  // retenu par le report d'un autre où l'une de ses personnes est l'invitée :
  // ce report ne la retient que pour que son propre titre ne passe pas juste
  // avant le duo, et _commit n'annonce pas le duo juste après elle. Sinon
  // quelqu'un d'autre partait pendant que la salle attendait l'annonce (le
  // titre retiré de KaraFun pour une priorité, annoncé juste après elle).
  // Une priorité du bar ne l'est pas non plus par le « Pas prêt » de son
  // invitée : le geste du bar l'emporte, comme sur celui de la personne
  // placée (staffMove), et le report de l'invitée prend fin quand elle monte
  // sur scène (_commit). Sinon elle ne partait jamais, toujours annoncée,
  // jusqu'à l'échéance de sécurité du report (relecture, passe 6). Son propre
  // report ne retient le passage annoncé que s'il est un « Pas prêt »
  // (_unready) : pas celui de son titre retiré de KaraFun pour une priorité,
  // en attente ou en simple report, réel ou prévu par _forecast (sans report
  // réel). Sinon un titre revenu de KaraFun en tête dont elle est l'invitée
  // perdait sa place (contre-relecture de la passe 26).
  _heldFor(held, pid, line, reservation) {
    const by = held?.get(pid);
    if (!by) return false;
    if (reservation?.personId !== line) return true;
    return !reservation.byStaff && by.includes(pid) && this._unready(this.people.get(pid));
  }

  // Report « Pas prêt » qui concerne cette personne, propriétaire du titre ou
  // invitée. Le report d'un titre retiré pour une priorité du bar
  // (yieldToPriority) n'en est pas un pour elle : ni « Je suis prêt », ni
  // « Encore une chanson », ni l'avis de son téléphone.
  deferralFor(personId) {
    const pid = String(personId);
    const owner = this._deferredOwners().map(id => this.people.get(id))
      .find(p => !p.deferral.afterPriority && (p.id === pid || (p.deferral.ids || []).includes(pid)));
    return owner ? { ownerId: owner.id, entryId: owner.deferral.entryId, remaining: owner.deferral.remaining,
      total: owner.deferral.total, until: owner.deferral.until } : null;
  }

  // Invitée qui ne chante plus le passage repoussé d'`owner` (`entryId` :
  // seulement le report de ce titre) : duo défait avant son envoi (« Annuler
  // duo », « Chanter seul », « Je ne chante plus ce duo ») ou départ (marquée
  // partie, table partie, « Je pars »). Le report de l'auteur ne l'attend
  // plus, inverse de son ajout à l'acceptation du duo (_deferralWaitsFor).
  // Sinon son propre titre restait bloqué derrière le report d'un autre
  // (_heldBy, _heldFor dans _pick), et son téléphone pouvait encore le lever
  // (« Je suis prêt ») ou le prolonger (deferralFor).
  _dropDeferredGuest(owner, pid, entryId = null) {
    const d = owner?.deferral;
    if (!d || pid === owner.id || (entryId && d.entryId !== entryId) || !Array.isArray(d.ids)) return;
    d.ids = d.ids.filter(id => id !== pid);
    if (!d.ids.length) d.ids = [owner.id];
  }

  // Inverse de _dropDeferredGuest : le report du titre `song` d'`owner`
  // attend aussi l'invitée acceptée de son duo, comme un duo reporté.
  // Invitation, duo ouvert ou demande de duo acceptés pendant le report
  // (answerDuet, acceptOpenDuet, requestDuetJoin, answerDuetJoin), ou report
  // remis depuis un état gardé d'avant l'acceptation (_restoreDeferral).
  // Sinon son propre titre partait avant, et le duo juste après ; et son
  // téléphone ne pouvait ni lever ni prolonger le report du duo qu'elle
  // chante (deferralFor).
  _deferralWaitsFor(owner, song) {
    const d = owner?.deferral, duet = song?.duet;
    if (!d || d.entryId !== song.entryId || duet?.state !== 'accepted') return;
    const ids = Array.isArray(d.ids) && d.ids.length ? d.ids : [owner.id];
    d.ids = ids.includes(duet.partnerId) ? ids : [...ids, duet.partnerId];
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
    // Le report d'un titre retiré pour une priorité qui ne tient plus
    // (_priorityHolds) ne compte plus.
    const current = p.deferral && p.deferral.entryId === entryId && now < p.deferral.until &&
      (!p.deferral.afterPriority || this._priorityHolds(p.deferral)) ? p.deferral : null;
    // Annoncée, ou gardée derrière l'annonce en cours (`then`) : sa place y
    // prend fin aussi, comme sa priorité ; son report la libère. Sinon une
    // annulation pouvait la rendre annoncée pendant son « Pas prêt »
    // (relecture, passe 17). Le titre retiré de KaraFun pour sa priorité
    // prend sa place (_endLine).
    this._endLine(p.id);
    const remaining = (current ? current.remaining : Math.max(0, Number(extra) || 0)) + n;
    // Filet de sécurité si personne d'autre ne chante : le titre redevient
    // envoyable après environ deux chansons par place laissée.
    const slotMs = Math.max(DEFER_MIN_SLOT_SEC, this.avgSlotSec()) * 1000;
    song.deferredSongs = total;
    p.deferral = { entryId, ids, remaining, total,
      until: now + remaining * DEFER_SLOTS_PER_SONG * slotMs + DEFER_GRACE_MS };
    p.presenceRetry = false;
    // Les lignes placées par le bar gardent leur place ; celle-ci, si elle
    // en est une, attend son report comme les autres (holds de _forecast).
    this.version++;
    this._event('defer.requested', { ownerId: p.id, personIds: ids, entryId, songs: n, total, remaining });
    const who = ids.map(pid => this.people.get(pid)?.name).filter(Boolean).join(' & ');
    this.note(`${who} n’est pas encore prêt : son passage laisse passer ${n} chanson${n > 1 ? 's' : ''} de plus et garde son tour`, 'skip');
    return p.deferral;
  }

  isDeferred(p) { return this._isDeferred(p); }

  // Fin d'un report. Le journal de soirée ne note que les « Pas prêt » : le
  // report d'un titre retiré pour une priorité du bar n'en est pas un
  // (yieldToPriority), evening-stats.js ne doit pas le compter.
  _endDeferral(p, how, fields = {}) {
    if (!p.deferral.afterPriority) this._event('defer.ended', { ...fields, ownerId: p.id, entryId: p.deferral.entryId, how });
    p.deferral = null;
  }

  // Report d'un titre précis effacé sans annonce (titre lancé, ou retiré de
  // KaraFun alors que la personne s'est dite prête).
  dropDeferral(ownerId, entryId) {
    const p = this.people.get(String(ownerId));
    if (!p?.deferral || p.deferral.entryId !== entryId) return false;
    this._endDeferral(p, 'dropped');
    this.version++;
    return true;
  }

  // « Priorité » du bar avant un titre déjà chargé dans KaraFun (server.js,
  // POST /api/staff/move avec `pullLoaded`) : le titre, retiré de KaraFun et
  // revenu en tête de la liste de son chanteur (requeueUnplayed), repasse
  // juste après le prochain passage, celui de la priorité. Même report d'une
  // chanson que « Pas prêt » (_forecast, select, Timefold, puis prochain
  // annoncé dans _commit ; jamais compté absent par « Je suis là »), sans en
  // être un pour ses chanteurs (`afterPriority`) : pas de décompte de
  // DEFER_MAX, pas d'événement « Pas prêt » au journal de soirée, ni « Je
  // suis prêt » sur leurs téléphones. Le rollback a rendu son attente (début
  // d'attente, place dans la file) ; un « Je suis là » déjà donné pour ce
  // titre tient encore. Le report ne vaut que pour la priorité de `forId`,
  // tant qu'elle est le prochain annoncé (_priorityHolds) : si elle ne tient
  // déjà plus (annulée pendant le retrait), ou dès qu'elle ne tient plus, le
  // titre reprend la tête (_backFirst, returnFromKaraFun et _undoLatest) ; si
  // une autre priorité passe devant elle, il devient un maillon de la chaîne
  // des annonces juste derrière elle (staffMove). Les annonces que cette
  // priorité gardait derrière elle (`then`) y restent : à son envoi, le titre
  // passe devant elles (_commit). Sinon elles vivaient à part sur ce report,
  // et une fin de priorité, un geste ou un duo les perdait (relecture, passe
  // 19). `forAt` : heure d'annonce de la priorité donnée par le geste (notée
  // au retrait) ; une priorité plus ancienne de la même personne, rendue par
  // l'annulation du geste, n'est pas la sienne. Sans `forAt` (sauvegarde
  // d'avant) : la personne suffit. `dormant` : une autre priorité, donnée
  // depuis, est en tête ; le titre prend place dans la chaîne juste derrière
  // la priorité de son geste (_insertPulled). Rend le report s'il tient, ou
  // null.
  yieldToPriority(sel, forId = null, { forAt = null, dormant = false } = {}) {
    const owner = this.people.get(sel?.ids?.[0]);
    const song = owner?.song;
    if (!owner || owner.withdrawnAt || !song || song.entryId !== sel.song?.entryId) return null;
    const now = Date.now();
    this._keepConfirmed(sel);
    const reserved = this.reservedNext;
    const holds = !!forId && !!reserved?.byStaff && reserved.personId === forId &&
      (!Number.isFinite(forAt) || reserved.reservedAt === forAt);
    if (!holds && !(dormant && forId && Number.isFinite(forAt) && reserved)) return null;
    owner.presenceRetry = false;
    if (!holds) {
      this._insertPulled(owner, forId, forAt);
      return null;
    }
    return this._waitPriority(owner, sel.ids, forId, reserved.reservedAt, now);
  }

  // Report « après la priorité » du titre en cours d'`owner`, chanté par `ids`,
  // pour la priorité de `forId` annoncée à `forAt` (yieldToPriority).
  _waitPriority(owner, ids, forId, forAt, now = Date.now()) {
    const slotMs = Math.max(DEFER_MIN_SLOT_SEC, this.avgSlotSec()) * 1000;
    const singers = ids.filter(pid => this.people.has(pid) && !this.people.get(pid).withdrawnAt);
    owner.deferral = { entryId: owner.song.entryId, ids: singers.length ? singers : [owner.id], remaining: 1,
      total: this.deferredSongsOf(owner.song), until: now + DEFER_SLOTS_PER_SONG * slotMs + DEFER_GRACE_MS, afterPriority: true,
      forId, forAt };
    owner.presenceRetry = false;
    return owner.deferral;
  }

  // Titre retiré de KaraFun pour la priorité de `forId` annoncée à `forAt`,
  // sorti de la chaîne des annonces par une annulation qui rend l'état d'avant
  // une priorité plus récente (_undoLatest, _undoRebased), ou dont la priorité
  // revient telle quelle (_rewaitEnded), ou son passage pas chanté (_ownBack) :
  // il attend de nouveau la sienne, en report si elle est le prochain annoncé,
  // dans la chaîne si elle y est gardée ; sinon il reprend la tête ou attend en
  // simple report (_backOrWait). Sinon il retombait derrière une nouvelle table
  // (relecture, passes 19 et 27).
  _waitAgain(owner, forId, forAt, busyIds = []) {
    if (!owner?.song || owner.withdrawnAt) return;
    const head = this.reservedNext;
    if (head?.byStaff && head.personId === forId && head.reservedAt === forAt) {
      this._waitPriority(owner, this._lineOf(owner.id), forId, forAt);
      this.version++;
      return;
    }
    for (let link = head?.then; link; link = link.then) {
      if (link.byStaff && link.personId === forId && link.reservedAt === forAt) { this._insertPulled(owner, forId, forAt); return; }
    }
    // Son geste encore noté (« Pas prêt » de sa personne pendant le retrait,
    // par exemple), une priorité donnée depuis en tête : comme à son retour
    // (returnFromKaraFun, `dormant`), il prend place juste derrière elle.
    // Sinon _backFirst refusait de passer devant elle et le titre perdait sa
    // place (relecture, passe 22).
    if (head?.byStaff && Number.isFinite(forAt) && head.reservedAt > forAt &&
        this.manualChanges.some(change => change.personId === forId)) {
      this._insertPulled(owner, forId, forAt);
      return;
    }
    this._backOrWait(owner, owner.song.entryId, { cutoff: Number.isFinite(forAt) ? forAt : null, busyIds, forId, forAt });
  }

  // Une annulation (ou un duo noté puis annulé, _restorePlaced) rend telle
  // quelle la priorité dont la fin avait mis le titre retiré pour elle en
  // simple report (`endedFor`, `endedAt` : _plainReport) : il l'attend de
  // nouveau, en report si elle est en tête, dans la chaîne juste derrière
  // elle si elle y est gardée (_waitAgain). Sinon il passait derrière ce
  // qu'elle gardait, alors que l'annulation disait rendre l'ordre d'avant
  // (relecture, passe 26).
  _rewaitEnded() {
    for (const pid of this.Q) {
      const p = this.people.get(pid), d = p?.deferral;
      if (!d?.afterPriority || typeof d.forId === 'string' || typeof d.endedFor !== 'string' || !this._isDeferred(p)) continue;
      let held = false;
      for (let link = this.reservedNext; link && !held; link = link.then) {
        held = !!link.byStaff && link.personId === d.endedFor && link.reservedAt === d.endedAt;
      }
      if (!held) continue;
      p.deferral = null;
      // Déjà gardé dans la chaîne rendue (maillon `pulled`) : il y reste, sans
      // second report (une seule représentation du titre, passe 19).
      if (this._inChain(p.id)) { this.version++; continue; }
      this._waitAgain(p, d.endedFor, d.endedAt);
    }
  }

  // Maillon de la chaîne des annonces pour le titre `owner`, retiré de KaraFun
  // pour la priorité de `forId` annoncée à `forAt` (`pulled`), suivi de
  // `then`. Une annulation qui le sort de la chaîne le fait attendre de
  // nouveau sa priorité, ou lui rend la tête si elle ne tient plus
  // (_undoLatest, _waitAgain).
  _pulledLink(owner, forId, forAt, then = null) {
    return { personId: owner.id, reservedAt: Date.now(), pulled: true,
      ...(typeof forId === 'string' ? { forId } : {}), ...(Number.isFinite(forAt) ? { forAt } : {}),
      ...(then ? { then } : {}) };
  }

  // Le titre `owner` prend place dans la chaîne des annonces juste derrière
  // la priorité de `forId` annoncée à `forAt` (un maillon, la tête étant une
  // priorité plus récente), devant ce qu'elle garde ; si elle n'y est plus
  // (« Pas prêt » pendant le retrait, _endLine), juste derrière la tête.
  // Sinon une annonce passait devant lui, ou une nouvelle table (relecture,
  // passes 18 et 19). Déjà dans la chaîne (le bar a donné « Priorité » à son
  // titre suivant pendant le retrait, par exemple), sa personne y garde sa
  // place, qui enverra ce titre revenu en tête de sa liste : un second maillon
  // la comptait deux fois, un « Je suis là » manqué valait deux absences
  // (relecture, passe 20).
  _insertPulled(owner, forId, forAt) {
    if (this._inChain(owner.id)) return;
    let placed = false;
    const walk = link => {
      if (!link) return null;
      const { then, ...self } = link;
      if (!placed && self.byStaff && self.personId === forId && self.reservedAt === forAt) {
        placed = true;
        return { ...self, then: this._pulledLink(owner, forId, forAt, then || null) };
      }
      const rest = walk(then);
      return rest ? { ...self, then: rest } : self;
    };
    const { then, ...head } = this.reservedNext;
    const rest = walk(then);
    this.reservedNext = placed ? { ...head, then: rest } :
      { ...head, then: this._pulledLink(owner, forId, forAt, then || null) };
    this.version++;
  }

  // Un « Je suis là » déjà donné pour ce titre, revenu de KaraFun sans être
  // chanté, tient encore (son envoi l'avait consommé).
  _keepConfirmed(sel) {
    const now = Date.now();
    for (const row of Array.isArray(sel?.turnCredit?.before?.people) ? sel.turnCredit.before.people : []) {
      const p = this.people.get(row.id);
      if (p && !p.confirmedAt && row.confirmedAt > 0 && now - row.confirmedAt < CONFIRM_MS) p.confirmedAt = row.confirmedAt;
    }
    this.version++;
  }

  // Titre revenu de KaraFun sans être chanté, retiré pour la priorité du bar
  // de `forId` (server.js : POST /api/staff/move avec `pullLoaded`, puis
  // restorePulled) : il revient en tête de la liste de son chanteur
  // (requeueUnplayed), puis passe juste après cette priorité si elle tient
  // (yieldToPriority), sinon reprend la tête ou attend en simple report
  // (_backOrWait). `forAt` : heure
  // d'annonce de cette priorité ; `cutoff` : une annonce plus ancienne le
  // suivait dans KaraFun ; `busyIds` : personnes d'un passage en route vers
  // KaraFun. `changeId` : le geste de cette priorité. S'il n'est plus noté
  // (annulé : « Annuler », « Recalculer la file » ; ou tombé : sa personne
  // partie, son titre retiré), le titre reprend la tête devant toute annonce,
  // même une priorité donnée depuis : le bar la donnait quand le titre était
  // encore affiché chargé, « juste après » lui. Encore noté, mais une autre
  // priorité donnée depuis est en tête : le titre prend place dans la chaîne
  // des annonces juste derrière la sienne (yieldToPriority, `dormant`). Sinon
  // une nouvelle table passait devant lui (relecture, passes 17 et 19). Rend
  // le report s'il tient, ou null.
  returnFromKaraFun(sel, { forId = null, forAt = null, changeId = null, cutoff = forAt, busyIds = [] } = {}) {
    this.requeueUnplayed(sel);
    this._keepConfirmed(sel);
    const owner = this.people.get(sel?.ids?.[0]);
    const ended = typeof changeId === 'string' && !this.manualChanges.some(change => change.id === changeId);
    if (!ended) {
      const reserved = this.reservedNext;
      const newer = !!forId && !!reserved?.byStaff && reserved.personId !== forId && Number.isFinite(forAt) &&
        reserved.reservedAt > forAt;
      const yielded = this.yieldToPriority(sel, forId, { forAt, dormant: newer });
      if (yielded || newer) return yielded;
    }
    this._backOrWait(owner, sel?.song?.entryId, { cutoff: ended ? Infinity : cutoff, busyIds, forId, forAt });
    return null;
  }

  // Titre retiré de KaraFun pour la priorité de `forId` annoncée à `forAt`,
  // qui ne tient plus : il reprend la tête (_backFirst). S'il ne le peut pas
  // (l'invitée de son duo vient de chanter ou part vers KaraFun, une priorité
  // donnée depuis est en tête), il attend en simple report et passe dès le
  // passage suivant (_plainReport), sauf si son propre chanteur vient de
  // chanter ou part vers KaraFun : il reprend alors le calcul, comme son
  // report qui prend fin à son envoi (_waitsAfterPriority). Que la priorité
  // prenne fin par « Pas prêt », un glissement, son titre retiré, un départ,
  // « Annuler » ou « Recalculer la file », avant ou après le retour du titre
  // (_passNext, returnFromKaraFun, _waitAgain, _undoLatest). Sinon il perdait
  // sa place, derrière de nouvelles tables (relecture, passes 25 et 26).
  _backOrWait(p, entryId, { cutoff = null, busyIds = [], forId = null, forAt = null } = {}) {
    if (this._backFirst(p, entryId, { cutoff, busyIds })) return true;
    if (!p?.song || p.withdrawnAt || p.song.entryId !== entryId || this._inChain(p.id) || busyIds.includes(p.id) ||
        !this._waitsAfterPriority({ personId: p.id, pulled: true })) return false;
    this._plainReport(p, forId, forAt);
    return true;
  }

  // Titre retiré de KaraFun pour une priorité du bar qui ne tient plus
  // (« Annuler », « Recalculer la file », avant ou après le retrait, ou
  // pendant l'envoi de la priorité) : chargé avant le geste, il était le
  // prochain, il le redevient. L'annonce qui le suivait dans KaraFun reste
  // juste derrière lui telle qu'elle était (`then` : priorité plus ancienne du
  // bar, personne sautée faute de « Je suis là » annoncée par son envoi,
  // annonce rendue par l'annulation) ; son envoi la rend (_commit). Sinon une
  // nouvelle table, une ligne placée par le bar ou cette annonce passaient
  // devant lui, ou l'annonce perdait ce qu'elle était : la priorité d'un duo
  // retenue par le « Pas prêt » de son invitée, la personne sautée doublée par
  // une nouvelle table (relecture, passes 16 et 17). Pas devant une annonce
  // faite depuis le geste (heure d'annonce à partir de `cutoff`, celle de la
  // priorité du geste), une priorité donnée depuis par exemple ; ni juste
  // après un passage où chante l'une de ses personnes, en route vers KaraFun
  // (`busyIds`) ou dernier parti ; ni devant une ligne où elle chante : il
  // reprend alors sa place calculée. Une personne annoncée avec un « Pas
  // prêt » en cours ne reste pas derrière lui : son report la libère, comme
  // avant le geste. `pulledBack` : `cutoff`, pour une annulation suivante qui
  // rendrait une annonce plus ancienne (_undoRebased), ou la priorité qui
  // revient (_restorePlaced).
  _backFirst(owner, entryId, { cutoff = null, busyIds = [] } = {}) {
    if (!owner || owner.withdrawnAt || !owner.song || owner.song.entryId !== entryId) return false;
    const reserved = this.reservedNext;
    if (reserved?.personId === owner.id) return false;
    // Seule une priorité du bar donnée depuis le geste tient devant lui : une
    // annonce de la file le suivait (sync() n'annonce personne tant qu'un
    // titre attend dans KaraFun ; une annulation rend celles d'avant).
    const limit = typeof cutoff === 'number' && !Number.isNaN(cutoff) ? cutoff : -Infinity;
    if (reserved?.byStaff && !(reserved.reservedAt < limit)) return false;
    const ids = this._lineOf(owner.id);
    const sangNow = this._justSang();
    if (ids.some(pid => busyIds.includes(pid) || sangNow.includes(pid))) return false;
    if (reserved && ids.some(pid => this._singsOnLine(reserved.personId, pid))) return false;
    // L'annonce déplacée, avec celles qu'elle gardait elle-même derrière elle
    // (`then`), le suit. Elle ne reste pas derrière lui si l'une de ses
    // personnes chante dans un passage en route vers KaraFun, ou, hors
    // priorité du bar, vient de chanter : elle rechanterait aussitôt
    // (relecture, passe 17). Une priorité du bar pour la personne sur scène
    // tient, comme annoncée (reservePresenceNext).
    const lineBusy = !!reserved && this._lineOf(reserved.personId).some(pid => busyIds.includes(pid) ||
      (!reserved.byStaff && sangNow.includes(pid)));
    // Au-delà de BEHIND_MAX, les plus anciennes tombent comme partout
    // (_dropBehind) : sinon la personne sautée gardée au bout perdait sa place
    // sans retenue (relecture, passe 21).
    const cut = [];
    let behind;
    if (reserved && (lineBusy || this._isDeferred(this.people.get(reserved.personId)))) {
      if (lineBusy) this._dropBehind(reserved, busyIds);
      behind = this._behindCopy(reserved.then, 0, cut);
    } else behind = this._behindCopy(reserved, 0, cut);
    for (const link of cut) this._dropBehind(link);
    // Son report « après la priorité » reste, sans effet : si cette priorité
    // revient telle quelle (duo noté par erreur puis annulé, _restorePlaced),
    // il l'attend de nouveau. Un « Pas prêt » de sa personne que son envoi
    // avait terminé, rendu par son retour (rollbackUnplayed), ne revient pas :
    // comme chargé, le titre part le premier, comme quand il cède sa place à
    // la priorité (yieldToPriority remplace ce report). Sinon il restait
    // annoncé et retenu (relecture, passe 17).
    if (owner.deferral && !owner.deferral.afterPriority && owner.deferral.entryId === entryId) owner.deferral = null;
    this.reservedNext = { personId: owner.id, reservedAt: Date.now(),
      pulledBack: Number.isFinite(cutoff) ? cutoff : Date.now(), ...(behind ? { then: behind } : {}) };
    this.version++;
    return true;
  }

  // Annonce sans ce qui ne vaut que pour la tête (`pulledBack`) ni les
  // annonces gardées derrière elle (`then`). Un titre revenu de KaraFun en
  // tête (`pulledBack`) le reste dans la chaîne (`back`) : de nouveau en
  // tête, une nouvelle priorité le garde derrière elle (staffMove). Sinon une
  // nouvelle table passait devant lui (relecture, passe 22).
  _plainReservation(reserved) {
    const { then, pulledBack, ...plain } = reserved;
    return pulledBack != null ? { ...plain, back: true } : plain;
  }

  // Annonce avec celles qu'elle garde derrière elle (`then`, BEHIND_MAX au
  // plus), pour la garder à son tour derrière une autre : sans `pulledBack`.
  // Un titre retiré de KaraFun (`pulled`) n'y compte pas : il reprend la
  // place qu'il avait avant ces priorités, et seules les annonces les plus
  // anciennes tombent au-delà. `cut` : liste où ranger celles-ci, à faire
  // tomber par l'appelant (_dropBehind) ; sinon une personne sautée faute de
  // « Je suis là » coupée là perdait sa place sans retenue (relecture,
  // passes 19 et 20).
  _behindCopy(reserved, depth = 0, cut = null) {
    if (!reserved || typeof reserved !== 'object') return null;
    const { then, ...rest } = reserved;
    const plain = this._plainReservation(rest);
    const counted = !plain.pulled;
    const next = this._behindCopy(then, depth + (counted ? 1 : 0), cut);
    if (counted && depth >= BEHIND_MAX) {
      if (cut) cut.push(plain);
      return next;
    }
    return next ? { ...plain, then: next } : plain;
  }

  // Les annonces `extra` (une chaîne) passent au bout de la chaîne en cours,
  // dans la limite de BEHIND_MAX : au-delà, celles du bout de la chaîne
  // tombent (_dropBehind), les annonces `extra` d'abord.
  _appendChain(extra) {
    if (!this.reservedNext || !extra) return;
    const links = [];
    for (const start of [this.reservedNext.then, extra]) {
      for (let link = start; link; link = link.then) { const { then, ...self } = link; links.push(self); }
    }
    const cut = [];
    const behind = this._behindCopy(links.reduceRight((then, link) => ({ ...link, ...(then ? { then } : {}) }), null), 0, cut);
    const { then, ...head } = this.reservedNext;
    this.reservedNext = behind ? { ...head, then: behind } : head;
    for (const link of cut) this._dropBehind(link);
    this.version++;
  }

  // Nombre d'annonces de la chaîne, la tête comprise.
  _chainSize() {
    let size = 0;
    for (let link = this.reservedNext; link; link = link.then) size++;
    return size;
  }

  // `pid` est-il la tête ou un maillon de la chaîne des annonces ?
  _inChain(pid) {
    for (let link = this.reservedNext; link; link = link.then) if (link.personId === pid) return true;
    return false;
  }

  // La même chaîne sans les annonces pour lesquelles `drop` est vrai.
  _pruneBehind(reserved, drop) {
    if (!reserved || typeof reserved !== 'object') return null;
    const rest = this._pruneBehind(reserved.then, drop);
    const { then, ...self } = reserved;
    if (drop(self)) return rest;
    return rest ? { ...self, then: rest } : self;
  }

  // Titre retiré de KaraFun qui attend la priorité du bar `link`, le prochain
  // annoncé (son report « après la priorité » à son heure d'annonce, qui
  // tient : yieldToPriority, _isDeferred), ou null.
  _titleWaitingFor(link) {
    if (!link?.byStaff) return null;
    for (const pid of this.Q) {
      const q = this.people.get(pid), d = q?.deferral;
      if (d?.afterPriority && d.forId === link.personId && d.forAt === link.reservedAt && this._isDeferred(q)) return q;
    }
    return null;
  }

  // La ligne de `pid` prend fin (« Pas prêt », plus de titre, personne
  // partie, duo improvisé noté) : annoncée, l'annonce gardée derrière elle
  // prend sa place (_passNext) ; gardée derrière l'annonce en cours, son
  // maillon tombe, et ceux qu'elle gardait (le titre retiré de KaraFun pour
  // sa priorité compris, _insertPulled, staffMove) avancent d'une place.
  _endLine(pid) {
    if (this.reservedNext?.personId === pid) { this._passNext(); return; }
    let found = false;
    for (let link = this.reservedNext?.then; link && !found; link = link.then) found = link.personId === pid;
    if (!found) return;
    const { then, ...head } = this.reservedNext;
    const kept = this._pruneBehind(then, link => link.personId === pid);
    this.reservedNext = kept ? { ...head, then: kept } : head;
    this.version++;
  }

  // Première des annonces gardées (`behind`) qui peut devenir la prochaine
  // juste après le passage dont `sang` sont les chanteurs, avec celles
  // qu'elle garde derrière elle. Celles d'avant qui ne le peuvent pas tombent
  // (_dropBehind), sauf pour la prévision (`drop` faux) ; `dropped` : les
  // garder dans cette liste, à faire tomber par l'appelant ; `free` :
  // personnes dont la prévision a déjà libéré le report, `spent` : celles
  // qu'elle a déjà fait chanter, dont les gestes ont donc pris fin (_forecast).
  _nextBehind(behind, sang = [], { drop = true, dropped = null, free = null, spent = null } = {}) {
    let link = behind;
    while (link && !this._behindStands(link, sang, free, spent)) {
      if (drop && dropped) dropped.push(link);
      else if (drop) this._dropBehind(link, sang);
      link = link.then;
    }
    return link ? { ...link } : null;
  }

  // L'annonce gardée (`then`) peut-elle devenir la prochaine juste après le
  // passage dont `sang` sont les chanteurs ? Sa personne est encore là avec
  // un titre, sans « Pas prêt » ni « Je suis là » manqué en cours (ils la
  // libèrent eux-mêmes ; une priorité du bar n'est pas retenue par un « Je
  // suis là » manqué d'avant elle, même rendue après la libération de
  // l'annonce en cours) ; hors priorité du bar, personne de sa ligne ne
  // chante dans ce passage (sinon elle rechanterait aussitôt ; une priorité
  // du bar tient, comme annoncée pour la personne sur scène) ; une priorité
  // du bar seulement si sa ligne est encore placée par le bar. Une annonce qui ne peut pas partir
  // pour une autre raison (duo ouvert, invitée partie ou retenue) est libérée
  // par select() comme toute annonce.
  _behindStands(reserved, sang = [], free = null, spent = null) {
    const p = this.people.get(reserved?.personId);
    if (!p || p.withdrawnAt || !p.song || (this._isDeferred(p) && !free?.has(p.id)) ||
        (!reserved.byStaff && this._isPresenceRetry(p) && !free?.has(p.id))) return false;
    if (!reserved.byStaff && this._lineOf(p.id).some(pid => sang.includes(pid))) return false;
    return !reserved.byStaff || (this.manualOrder.includes(p.id) && !spent?.has(p.id));
  }

  // Chanteurs du dernier passage parti vers KaraFun (sur scène ou chargé).
  _justSang() {
    return [...this.people.values()].filter(q => (q.lastAppearanceTurn || 0) > 0 &&
      q.lastAppearanceTurn >= this.appearanceSerial).map(q => q.id);
  }

  // Annonce gardée derrière un titre revenu de KaraFun qui ne peut pas
  // devenir la prochaine (_behindStands) : une personne sautée faute de « Je
  // suis là » attend de nouveau un passage devant elle, comme après son
  // manque (sinon elle perdait sa place « juste après »). Un titre retiré de
  // KaraFun pour une priorité (`pulled`) qui ne peut pas la suivre (l'invitée
  // de son duo vient d'y chanter) attend en simple report et passe dès le
  // passage suivant, comme quand il attend sa priorité en report (_commit,
  // passe 20) : sinon il reprenait sa place calculée, derrière de nouvelles
  // tables (relecture, passe 22). Pas si son propre chanteur vient de chanter
  // (en invité d'un duo) : comme son report qui prend fin à son envoi, le
  // titre reprend le calcul, sinon il rechantait deux passages plus tard
  // (relecture, passe 23). Les autres reprennent le calcul ; une ligne
  // placée par le bar garde sa place. `busy` : personnes qui vont chanter
  // sans être encore comptées (passage en route vers KaraFun, `excludeIds`,
  // `busyIds`), comme celles qui viennent de chanter : sinon le titre de l'une
  // d'elles prenait un simple report caché, réveillé si ce titre revenait de
  // KaraFun sans être chanté (relecture, passe 27).
  _dropBehind(behind, busy = null) {
    const spent = Array.isArray(busy) && busy.length ? new Set([...this._justSang(), ...busy]) : null;
    const kind = this._dropKind(behind, null, spent);
    if (!kind) return;
    const p = this.people.get(behind.personId);
    if (kind === 'report') { this._plainReport(p, behind.forId, behind.forAt); return; }
    p.presenceRetry = true;
    this.version++;
  }

  // Ce que devient l'annonce gardée `link` qui ne peut pas devenir la
  // prochaine (_dropBehind) : 'presence' (personne encore sautée faute de « Je
  // suis là » : elle attend de nouveau un passage devant elle), 'report'
  // (titre retiré de KaraFun qui ne peut pas suivre sa priorité : simple
  // report) ou null (elle reprend le calcul). La prévision en fait autant
  // (`free`, `spent` : _forecast, comme _behindStands), pour les annonces
  // gardées derrière chaque priorité qu'elle fait partir comme pour celles
  // d'une annonce faite pendant un envoi. Sinon la file montrait plus loin la
  // personne sautée que l'accusé faisait passer juste après le passage
  // suivant (relecture, passe 26). Un titre revenu de KaraFun (`pulledBack`
  // en tête, `back` dans la chaîne) est un titre retiré comme un autre
  // (_asPulled), qu'il tombe derrière une priorité, au bout de la chaîne
  // (BEHIND_MAX) ou à l'accusé : sinon il passait derrière de nouvelles
  // tables (contre-relecture de la passe 26).
  _dropKind(link, free = null, spent = null) {
    const p = this.people.get(link?.personId);
    if (!p || link.byStaff || p.withdrawnAt || !p.song || (this._isDeferred(p) && !free?.has(p.id))) return null;
    if (this.presenceSkipsOf(p) > 0 && !this._confirmedRecently(p) && !spent?.has(p.id)) return 'presence';
    return this._waitsAfterPriority(this._asPulled(link), free, spent) ? 'report' : null;
  }

  // Simple report « après la priorité » du titre retiré de KaraFun `p`, qui
  // ne peut pas suivre la priorité de `forId` annoncée à `forAt` ni reprendre
  // la tête quand elle prend fin (l'invitée de son duo vient d'y chanter) : il
  // passe dès le passage suivant, après les annonces déjà gardées (_commit).
  // `endedFor`, `endedAt` : cette priorité (à défaut, celle de son report),
  // qu'une annulation peut rendre telle quelle ; il l'attend alors de nouveau
  // (_rewaitEnded). Sinon l'annulation du geste qui l'avait finie ne lui
  // rendait plus son attente (relecture, passe 26).
  _plainReport(p, forId = null, forAt = null) {
    const prior = p.deferral?.afterPriority && p.deferral.entryId === p.song.entryId ? p.deferral : null;
    const [endedFor, endedAt] = typeof forId === 'string' ? [forId, forAt] :
      [prior?.forId ?? prior?.endedFor, prior?.forAt ?? prior?.endedAt];
    const slotMs = Math.max(DEFER_MIN_SLOT_SEC, this.avgSlotSec()) * 1000;
    p.deferral = { entryId: p.song.entryId, ids: this._lineOf(p.id), remaining: 0, total: this.deferredSongsOf(p.song),
      until: Date.now() + DEFER_SLOTS_PER_SONG * slotMs + DEFER_GRACE_MS, afterPriority: true,
      ...(typeof endedFor === 'string' && Number.isFinite(endedAt) ? { endedFor, endedAt } : {}) };
    p.presenceRetry = false;
    this.version++;
  }

  // Titres retirés de KaraFun notés dans le reçu `sel.ownBack` (_commit) :
  // sortis de la chaîne à l'accusé parce que leur propre personne chantait en
  // invitée dans ce passage, qui n'a finalement pas lieu pour elle (passage
  // pas chanté, invitée qui quitte le duo déjà chargé : `pid`). Chacun attend
  // de nouveau sa priorité, en report si elle est en tête, dans la chaîne si
  // elle y est gardée, sinon reprend la tête ou attend en simple report
  // (_waitAgain, _backOrWait) : il ne passe pas derrière de nouvelles tables
  // (relecture, passe 27). Pas s'il a changé depuis (autre titre, déjà dans
  // la chaîne ou retenu).
  _ownBack(sel, pid = null) {
    const rows = Array.isArray(sel?.ownBack) ? sel.ownBack : [];
    const mine = rows.filter(row => row && typeof row === 'object' && (pid === null || row.pid === pid));
    const rest = rows.filter(row => !mine.includes(row));
    if (rest.length) sel.ownBack = rest; else if (sel) delete sel.ownBack;
    for (const row of mine) {
      const p = this.people.get(row.pid);
      if (!p || p.withdrawnAt || !p.song || p.song.entryId !== row.entryId || this._inChain(p.id) || this._isDeferred(p)) continue;
      if (typeof row.forId === 'string') this._waitAgain(p, row.forId, Number.isFinite(row.forAt) ? row.forAt : null);
      else this._backOrWait(p, row.entryId, { cutoff: Number.isFinite(row.cutoff) ? row.cutoff : null });
      this.version++;
    }
  }

  // Titre revenu de KaraFun en tête (`pulledBack`) ou gardé tel quel dans la
  // chaîne (`back`), qui ne peut pas suivre le passage dont il devait être le
  // suivant : comme un maillon `pulled`, il attend en simple report
  // (_dropKind). Sinon il reprenait sa place calculée, derrière de nouvelles
  // tables (relecture, passe 26).
  _asPulled(link) {
    return link && !link.pulled && (link.pulledBack != null || link.back) ? { ...link, pulled: true } : link;
  }

  // Maillon `link` d'un titre retiré de KaraFun pour une priorité qui, s'il
  // ne peut pas la suivre, attend en simple report (_dropKind, _backOrWait,
  // _forecast).
  // Pas si son propre chanteur vient de chanter (_justSang ; pour la
  // prévision, `spent` : les personnes qu'elle a fait chanter). `free` :
  // reports que la prévision a déjà libérés (_forecast).
  _waitsAfterPriority(link, free = null, spent = null) {
    const p = this.people.get(link?.personId);
    return !!link?.pulled && !link.byStaff && !!p && !p.withdrawnAt && !!p.song && (!this._isDeferred(p) || !!free?.has(p.id)) &&
      !(spent ? spent.has(p.id) : this._justSang().includes(p.id)) && !(this.presenceSkipsOf(p) > 0 && !this._confirmedRecently(p));
  }

  // Le prochain annoncé ne partira pas (sauté faute de « Je suis là », « Pas
  // prêt », titre retiré, parti…) : l'annonce gardée derrière lui (`then`,
  // titre revenu de KaraFun) prend sa place, comme si le titre était sorti de
  // KaraFun. Une priorité du bar qui prend fin ainsi rend la tête au titre
  // retiré de KaraFun pour elle (_backFirst) : il était chargé avant elle.
  // Sinon une nouvelle table passait devant lui (GUIDE-BAR : « le titre
  // retiré reprend sa place, sans laisser passer quelqu'un d'autre devant
  // lui » ; relecture, passe 17).
  // Si le titre retiré ne peut pas reprendre la tête (l'invitée de son duo
  // vient de chanter, par exemple), il attend en simple report et passe dès le
  // passage suivant (_backOrWait) ; ce report garde la trace de la priorité
  // finie, qu'« Annuler » peut lui rendre (relecture, passes 25 et 26).
  _passNext() {
    const released = this.reservedNext;
    const next = this._nextBehind(released?.then, this._justSang());
    this.releaseNext();
    if (next) this.reservedNext = next;
    if (!released?.byStaff) return;
    for (const pid of this.Q) {
      const p = this.people.get(pid);
      const d = p?.deferral;
      if (d?.afterPriority && d.forId === released.personId && d.forAt === released.reservedAt) {
        this._backOrWait(p, d.entryId, { cutoff: d.forAt, forId: d.forId, forAt: d.forAt });
      }
    }
  }

  // Titre retiré de KaraFun avant d'être chanté (« Pas prêt », partenaire
  // d'un duo improvisé) : il revient en tête de la liste de son chanteur
  // (putBackFirst) et son ticket reprend sa place. Un report « Pas prêt »
  // s'applique ensuite.
  requeueUnplayed(sel) {
    this.rollbackUnplayed(sel, { requeue: true });
    const owner = this.people.get(sel.ids[0]);
    if (!owner || owner.withdrawnAt) return null;
    this.putBackFirst(owner, sel.song);
    if (!this.Q.includes(owner.id)) this.Q.push(owner.id);
    this.version++;
    return owner;
  }

  // Titre chargé dans KaraFun et revenu sans être chanté (requeueUnplayed,
  // absent à l'appel dans server.js) : il reprend la tête de la liste de son
  // chanteur, sauf s'il y est déjà. Le titre qu'il remplace en tête reste
  // dans la liste : un duo formé dessus sur une ligne fixée rend les lignes
  // qu'il en avait sorties (_currentChanged). Sinon, après l'absence à
  // l'appel, la personne gardée devant un geste passait derrière lui
  // (relecture).
  putBackFirst(owner, song) {
    if (!owner.song || owner.song.entryId !== song.entryId) {
      const previous = owner.song;
      if (owner.song) owner.backlog.unshift(owner.song);
      owner.song = song;
      this._currentChanged(owner, previous);
    }
    this._refreshDuetViews();
  }

  // « Je suis prêt » : le passage reporté redevient envoyable tout de suite.
  cancelDeferral(personId) {
    const found = this.deferralFor(personId);
    const p = found && this.people.get(found.ownerId);
    if (!p) throw new Error('Aucun passage repoussé pour cette personne.');
    this._endDeferral(p, 'ready', { personId: String(personId) });
    this.version++;
    const who = this.people.get(String(personId))?.name || p.name;
    this.note(`${who} est prêt : son passage reprend sa place`, 'info');
    return p;
  }
}

module.exports = SchedulerPresence;
