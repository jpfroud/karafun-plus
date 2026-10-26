'use strict';
// Planificateur, partie duos : invitations, réponses, duos notés par le bar, demandes pour rejoindre un titre.
// Méthodes de Scheduler (scheduler.js), recopiées sur sa classe au
// chargement : elles partagent ses états (this) comme si elles y étaient écrites.
const { DUET_JOIN_MAX, EPS } = require('./common');

class SchedulerDuets {
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
        // Duo ouvert : pas encore de partenaire, rien à montrer chez un autre.
        if (!d || d.state === 'open') continue;
        const partner = this.people.get(d.partnerId);
        if (!partner) { delete song.duet; continue; }
        if (d.state === 'pending' && !partner.invite) partner.invite = { fromId: owner.id, song, entryId: song.entryId };
        if (d.state === 'accepted' && !partner.duetOf) partner.duetOf = owner.id;
      }
    }
  }

  // `notify` : true, false, ou fonction qui dit qui prévenir (départ d'une
  // table : seulement les personnes qui restent). Le journal du bar n'est
  // complété que pour true.
  _removeDuetsForPerson(p, notify) {
    const tell = typeof notify === 'function' ? notify : () => !!notify;
    let removed = 0;
    for (const owner of this.people.values()) {
      for (const song of this.songsOf(owner)) {
        // Ses demandes de duo en attente partent avec elle.
        if (Array.isArray(song.duoRequests)) {
          song.duoRequests = song.duoRequests.filter(row => row?.fromId !== p.id);
          if (!song.duoRequests.length) delete song.duoRequests;
        }
        if (!song.duet || (owner.id !== p.id && song.duet.partnerId !== p.id)) continue;
        // Son duo ouvert se ferme : personne d'autre n'y chantait encore.
        if (this._closeOpen(owner, song, 'left')) continue;
        // L'autre personne du duo apprend pourquoi il a disparu.
        const other = owner.id === p.id ? song.duet.partnerId : owner.id;
        if (tell(other)) {
          if (owner.id === p.id) this.notify(other, 'duoCancelled', { name: p.name, title: song.title });
          else this.notify(other, 'duoLeft', { name: p.name, title: song.title, sent: false });
        }
        delete song.duet;
        removed++;
      }
    }
    this._refreshDuetViews();
    if (removed && notify === true) this.note(`${removed} duo${removed > 1 ? 's' : ''} annulé${removed > 1 ? 's' : ''} pour ${p.name}`);
  }

  // Titres qui quittent la liste de leur auteur sans passer par KaraFun
  // (retirés, remplacés, personne partie) : l'invitée du duo et les
  // personnes qui demandaient à le chanter sont prévenues.
  // `tell` : qui prévenir (par défaut, tout le monde).
  _songsGone(owner, songs, tell = () => true) {
    for (const song of songs.filter(Boolean)) {
      // Duo ouvert : la demande se ferme avec le titre.
      this._closeOpen(owner, song, 'removed');
      const partner = song.duet && this.people.get(song.duet.partnerId);
      if (partner && tell(partner.id)) this.notify(partner.id, 'duoCancelled', { name: owner.name, title: song.title });
      this._closeJoinRequests(owner, song, 'removed', tell);
    }
  }

  // Une demande de duo ne retient jamais un titre : il part à son heure
  // (`sent`) ou disparaît de la liste (`removed`), et la demande expire.
  _closeJoinRequests(owner, song, reason, tell = () => true) {
    const requests = this._joinRequests(song);
    if (song) delete song.duoRequests;
    for (const row of requests) {
      const requester = this.people.get(row.fromId);
      if (!tell(requester.id)) continue;
      this.notify(requester.id, 'joinExpired', { name: owner.name, title: song.title, reason });
      // Parti avant la réponse : l'auteur du titre apprend aussi qu'une demande attendait.
      if (reason === 'sent') this.notify(owner.id, 'joinMissed', { name: requester.name, title: song.title });
      this.note(reason === 'sent' ?
        `La demande de duo de ${requester.name} à ${owner.name} a expiré : « ${song.title} » est parti dans KaraFun` :
        `La demande de duo de ${requester.name} à ${owner.name} est close : « ${song.title} » n’est plus dans sa liste`, 'staff');
      this._event?.('duo.joinExpired', { ownerId: owner.id, requesterId: requester.id, entryId: song.entryId, reason });
    }
    return requests.length;
  }

  // Une invitation de duo ne retient jamais un titre, comme une demande : à
  // son tour, il part en solo dans KaraFun et l'invitation expire. L'invitée
  // et l'auteur sont prévenus.
  _expireInvite(owner, song) {
    const d = song?.duet;
    if (!d || d.state !== 'pending') return false;
    const partner = this.people.get(d.partnerId);
    delete song.duet;
    const guest = partner?.name || 'son invité';
    if (partner) this.notify(partner.id, 'inviteExpired', { name: owner.name, title: song.title });
    this.notify(owner.id, 'inviteUnanswered', { name: guest, title: song.title });
    this.note(`L’invitation de duo ${/^[aeiouyàâéèêëîïôûùh]/i.test(owner.name) ? 'd’' : 'de '}${owner.name} à ${guest} a expiré : « ${song.title} » est parti dans KaraFun, ${owner.name} le chante en solo`, 'staff');
    this._event?.('duo.inviteExpired', { ownerId: owner.id, partnerId: d.partnerId, entryId: song.entryId || null });
    return true;
  }

  // ------------------------------------------------------------------ duos ouverts
  // « Qui veut chanter en duo avec moi ? » : un titre de la liste cherche un
  // partenaire dans toute la salle (song.duet = { state: 'open', openedAt },
  // sans partenaire). Comme une invitation sans réponse, il ne retient jamais
  // le titre : il passe comme un solo et, sans volontaire à son tour, part en
  // solo à l'accusé de KaraFun (_expireOpenDuet). Exception, « Duos
  // uniquement » : il ne part pas sans partenaire (_openHeld). Le premier
  // volontaire devient l'invité, quelle que soit sa table (acceptOpenDuet).

  // « Duos uniquement » du bar (settings.duoOnly), branché par le serveur sur
  // `duoOnlyRule`, comme le journal sur `onEvent`.
  _duoOnly() {
    return typeof this.duoOnlyRule === 'function' && !!this.duoOnlyRule();
  }

  // Titre qui ne part pas : duo ouvert encore sans partenaire, en « Duos uniquement ».
  _openHeld(song) {
    return song?.duet?.state === 'open' && this._duoOnly();
  }

  // Duo d'un titre pour les empreintes de la file : un duo ouvert passe comme
  // un solo, sauf en « Duos uniquement » ; ouvrir ou fermer la demande ne
  // relance donc ni l'optimiseur ni ne défait l'ordre du bar.
  _duetKey(song) {
    const d = song?.duet;
    if (!d) return null;
    return d.state === 'open' ? (this._duoOnly() ? 'open' : null) : d;
  }

  openDuetOf(p) {
    return this.songsOf(p).find(song => song.duet?.state === 'open') || null;
  }

  // Duos ouverts des personnes présentes, du plus récent au plus ancien.
  openDuets() {
    const out = [];
    for (const owner of this.people.values()) {
      if (owner.withdrawnAt) continue;
      for (const song of this.songsOf(owner)) {
        if (song.duet?.state === 'open') out.push({ owner, song, entryId: song.entryId, openedAt: Number(song.duet.openedAt) || 0 });
      }
    }
    return out.sort((a, b) => b.openedAt - a.openedAt);
  }

  // Un titre du catalogue (`song`, ajouté à la fin de la liste comme un duo)
  // ou un titre déjà dans la liste (`entryId`). Un seul duo ouvert à la fois
  // par personne, jamais pour une place sans prénom.
  openDuet(p, { song = null, entryId = null } = {}) {
    if (p.nameRequired) throw new Error('Indique d’abord ton prénom.');
    if (this.openDuetOf(p)) throw new Error('Un seul duo ouvert à la fois : ferme d’abord ta demande en cours.');
    let target;
    if (song) {
      this.chooseSong(p, song, 'append');
      target = this.songsOf(p).at(-1);
    } else {
      target = this.songsOf(p).find(item => item.entryId === String(entryId || ''));
      if (!target) throw new Error('Ce titre n’est plus en attente : il est peut-être déjà dans KaraFun.');
      if (target.duet) throw new Error('Ce titre est déjà prévu en duo.');
      if (this._joinRequests(target).length) throw new Error('Des personnes demandent déjà à chanter ce titre avec toi : réponds-leur d’abord.');
    }
    target.duet = { state: 'open', openedAt: Date.now() };
    // Il passe comme un solo ; en « Duos uniquement », il attend sans faire
    // tomber les gestes du bar (une ligne placée reprend sa place à l'acceptation).
    this._refreshDuetViews();
    this.version++;
    this._event('duo.openRequested', { personId: p.id, entryId: target.entryId, fromCatalog: !!song });
    this.note(`${this.personRef(p)} cherche un partenaire pour chanter « ${target.title} » en duo`);
    return target;
  }

  // L'auteur ne cherche plus de partenaire : le titre reste dans sa liste, en solo.
  closeOpenDuet(p, entryId) {
    const song = this.songsOf(p).find(item => item.entryId === String(entryId || ''));
    if (song?.duet?.state !== 'open') throw new Error('Cette demande de duo n’est plus ouverte.');
    this._closeOpen(p, song, 'self', p.id);
    this._refreshDuetViews();
    this.version++;
    this.note(`${p.name} ne cherche plus de partenaire pour « ${song.title} » : le titre reste en solo`);
    return song;
  }

  // Demande fermée sans volontaire : geste de l'auteur (`self`), titre retiré
  // (`removed`) ou départ de l'auteur (`left`).
  _closeOpen(owner, song, reason, by = null) {
    if (song?.duet?.state !== 'open') return false;
    delete song.duet;
    this._event?.('duo.openClosed', { ...(by ? { personId: by } : {}), ownerId: owner.id, entryId: song.entryId || null, reason });
    return true;
  }

  // Premier volontaire : il devient l'invité du duo, quelle que soit sa table.
  // Comme une invitation acceptée (answerDuet) : il garde ses propres titres
  // et son tour, seul l'auteur dépense le sien. Les suivants sont refusés.
  acceptOpenDuet(q, ownerId, entryId) {
    if (q.nameRequired) throw new Error('Indique d’abord ton prénom.');
    if (q.withdrawnAt) throw new Error('Cette personne a été marquée partie. Demande au bar de la réactiver.');
    const owner = this.people.get(String(ownerId || ''));
    if (!owner || owner.withdrawnAt) throw new Error('Ce chanteur n’est plus dans la file.');
    if (owner.id === q.id) throw new Error('C’est déjà ton titre.');
    // Titre parti dans KaraFun (en solo) ou retiré par son auteur : dans les
    // deux cas, la demande est close.
    const song = this.songsOf(owner).find(item => item.entryId === String(entryId || ''));
    if (!song) throw new Error('Cette demande de duo n’est plus ouverte.');
    // Second appui du même volontaire (réponse perdue, double appui) : c'est fait.
    if (this._joinedOpenDuet(q, song)) return song;
    if (song.duet?.state !== 'open') throw new Error(song.duet ? 'Quelqu’un a déjà rejoint ce duo.' : 'Cette demande de duo n’est plus ouverte.');
    song.duet = { partnerId: q.id, state: 'accepted' };
    // Comme une invitation acceptée (answerDuet) : une ligne de l'ordre fixé
    // par le bar qui devient un duo, voir _guestJoined ; annoncé comme
    // prochain alors qu'il partait en solo, le duo repasse par les règles de
    // la file, sauf priorité du bar ou ligne de l'ordre qu'il a fixé.
    if (owner.song === song) this._guestJoined(owner);
    if (this.reservedNext?.personId === owner.id && !this.reservedNext.byStaff && owner.song === song &&
        !this.manualOrder.includes(owner.id)) this.releaseNext();
    // « Pas prêt » en cours : le passage repoussé attend aussi l'invité.
    if (owner.deferral?.entryId === song.entryId) {
      const ids = Array.isArray(owner.deferral.ids) && owner.deferral.ids.length ? owner.deferral.ids : [owner.id];
      owner.deferral.ids = ids.includes(q.id) ? ids : [...ids, q.id];
    }
    // Demandes pour rejoindre ce titre restées d'avant : un seul partenaire.
    for (const row of this._joinRequests(song)) if (row.fromId !== q.id) this.notify(row.fromId, 'joinRefused', { name: owner.name, title: song.title });
    delete song.duoRequests;
    this._refreshDuetViews();
    this.version++;
    this._event('duo.openAccepted', { personId: q.id, ownerId: owner.id, partnerId: q.id, entryId: song.entryId });
    this.note(`${this.personRef(q)} rejoint ${owner.name} en duo sur « ${song.title} » : seul ${owner.name} dépense son tour`);
    this.notify(owner.id, 'openAccepted', { name: q.name, title: song.title });
    return song;
  }

  // Ce volontaire chante déjà ce titre avec son auteur (le serveur répond
  // « ok » à un second « Je chante » avant même de regarder l'envoi en cours).
  _joinedOpenDuet(q, song) {
    return song?.duet?.state === 'accepted' && song.duet.partnerId === q.id;
  }

  // Personne n'a rejoint le duo ouvert à son tour : le titre est parti en solo
  // dans KaraFun, la demande se ferme et l'auteur est prévenu (comme _expireInvite).
  _expireOpenDuet(owner, song) {
    if (song?.duet?.state !== 'open') return false;
    delete song.duet;
    this.notify(owner.id, 'openUnanswered', { title: song.title });
    this.note(`Personne n’a rejoint le duo ouvert ${/^[aeiouyàâéèêëîïôûùh]/i.test(owner.name) ? 'd’' : 'de '}${owner.name} : « ${song.title} » est parti dans KaraFun, ${owner.name} le chante en solo`, 'staff');
    this._event?.('duo.openExpired', { ownerId: owner.id, entryId: song.entryId || null });
    return true;
  }

  inviteDuet(p, partnerId, song) {
    const q = this.people.get(partnerId);
    if (!q || q.id === p.id) throw new Error('Partenaire introuvable.');
    // Marquée partie après l'ouverture de la liste des partenaires (qui ne la
    // propose plus) : refusée, comme l'auteur parti d'une demande de duo. Son
    // départ a effacé ses invitations ; aucune ne doit en recréer, et à la
    // même table, aucun duo direct avec elle.
    if (q.withdrawnAt) throw new Error('Ce chanteur est parti : choisis un autre partenaire.');
    this.chooseSong(p, song, 'append');
    // Comme un titre solo, un duo est ajouté à la fin de la liste. Une personne
    // peut ensuite réordonner ses titres si elle souhaite le chanter plus tôt.
    const duetSong = this.songsOf(p).at(-1);
    // Le Comptoir est une table physique, mais chaque soliste y est un groupe
    // indépendant : il doit accepter l'invitation comme à une autre table.
    const sameGroup = p.group === q.group;
    duetSong.duet = { partnerId: q.id, state: sameGroup ? 'accepted' : 'pending' };
    this._refreshDuetViews();
    this._event('duo.invited', { personId: p.id, entryId: duetSong.entryId, ownerId: p.id, partnerId: q.id, sameGroup });
    this.note(sameGroup ?
      `${p.name} a prévu un duo avec ${q.name} sur « ${duetSong.title} »` :
      `${p.name} invite ${q.name} en duo sur « ${duetSong.title} »`);
    // Même table : duo direct, sans réponse demandée. Le téléphone de
    // l'invitée le signale (sauf s'il gère aussi l'auteur du titre).
    if (sameGroup) this.notify(q.id, 'duoAdded', { name: p.name, fromId: p.id, title: duetSong.title, entryId: duetSong.entryId });
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
    this._event('duo.answered', { personId: q.id, entryId: song.entryId, ownerId: p.id, partnerId: q.id, accepted: !!accept });
    if (accept) {
      song.duet.state = 'accepted';
      // Ligne de l'ordre fixé par le bar qui devient un duo : voir _guestJoined.
      if (p.song === song) this._guestJoined(p);
      // Titre annoncé comme prochain alors qu'il partait en solo : le duo
      // repasse par les règles de la file (premiers passages, espacement,
      // plafond du tour). Une priorité du bar, ou une ligne de l'ordre qu'il a
      // fixé, tient.
      if (this.reservedNext?.personId === p.id && !this.reservedNext.byStaff && p.song === song &&
          !this.manualOrder.includes(p.id)) this.releaseNext();
      // Passage repoussé (« Pas prêt ») pendant que l'invitation attendait :
      // il attend désormais aussi l'invitée, comme un duo reporté (inverse de
      // leaveDuet). Sinon son solo partirait avant, et le duo juste après.
      if (p.deferral?.entryId === song.entryId) {
        const ids = Array.isArray(p.deferral.ids) && p.deferral.ids.length ? p.deferral.ids : [p.id];
        p.deferral.ids = ids.includes(q.id) ? ids : [...ids, q.id];
      }
      this.note(`${q.name} accepte le duo avec ${p.name} : seul ${p.name} dépense son tour`);
    } else {
      delete song.duet;
      this.note(`${q.name} décline le duo : ${p.name} chantera en solo`);
      this.notify(p.id, 'duoRefused', { name: q.name, title: song.title });
    }
    this._refreshDuetViews();
    this.version++;
  }

  _cancelDuet(owner, notify, entryId, by = null) {
    const song = entryId ? this.songsOf(owner).find(s => s.entryId === String(entryId)) : this.songsOf(owner).find(s => s.duet);
    const d = song?.duet;
    if (!d) return;
    const q = this.people.get(d.partnerId);
    delete song.duet;
    this._refreshDuetViews();
    this._event('duo.cancelled', { personId: by, entryId: song.entryId, ownerId: owner.id, partnerId: d.partnerId });
    if (notify) {
      this.note(`Duo annulé (${owner.name}${q ? ' & ' + q.name : ''})`);
      if (q) this.notify(q.id, 'duoCancelled', { name: owner.name, title: song.title });
    }
    this.version++;
  }

  // Duos acceptés où cette personne est invitée, titres encore dans la liste
  // de leur auteur.
  guestDuetsOf(q) {
    const out = [];
    for (const owner of this.people.values()) {
      for (const song of this.songsOf(owner)) {
        if (song.duet?.partnerId === q.id && song.duet.state === 'accepted') out.push({ ownerId: owner.id, entryId: song.entryId, song });
      }
    }
    return out;
  }

  // « Annuler duo » : sur son titre, l'auteur annule ; invitée, on refuse
  // l'invitation ou on se retire du duo accepté. Sans titre précis, un seul
  // duo doit correspondre : jamais celui d'un autre titre de la personne.
  cancelDuet(p, entryId) {
    const key = entryId ? String(entryId) : null;
    const own = this.songsOf(p).filter(s => s.duet && (!key || s.entryId === key));
    const invites = this.duetInvites(p).filter(x => !key || x.entryId === key);
    const guest = this.guestDuetsOf(p).filter(x => !key || x.entryId === key);
    if (own.length + invites.length + guest.length > 1 && !key) throw new Error('Choisis le duo à annuler.');
    if (own[0]?.duet.state === 'open') return this.closeOpenDuet(p, own[0].entryId);
    if (own[0]) return this._cancelDuet(p, true, own[0].entryId, p.id);
    if (invites[0]) return this.answerDuet(p, false, invites[0].entryId);
    if (guest[0]) return this.leaveDuet(p, guest[0].ownerId, guest[0].entryId);
    throw new Error('Duo introuvable.');
  }

  // L'invitée d'un duo accepté change d'avis avant l'envoi à KaraFun : le
  // titre redevient le solo de son auteur. Rien n'est encore compté, les
  // tours ne changent pas.
  leaveDuet(guest, ownerId, entryId) {
    const owner = this.people.get(String(ownerId || ''));
    const song = owner && this.songsOf(owner).find(s => s.entryId === String(entryId || ''));
    const d = song?.duet;
    if (!d || d.partnerId !== guest.id) throw new Error('Duo introuvable.');
    if (d.state === 'pending') { this.answerDuet(guest, false, song.entryId); return { stage: 'planned', owner, song }; }
    delete song.duet;
    // Un passage repoussé (« Pas prêt ») n'attend plus l'invitée.
    if (owner.deferral?.entryId === song.entryId && Array.isArray(owner.deferral.ids)) {
      owner.deferral.ids = owner.deferral.ids.filter(pid => pid !== guest.id);
      if (!owner.deferral.ids.length) owner.deferral.ids = [owner.id];
    }
    this._refreshDuetViews();
    this.version++;
    this.note(`${guest.name} se retire du duo avec ${owner.name} sur « ${song.title} » : ${owner.name} le chantera en solo`);
    this.notify(owner.id, 'duoLeft', { name: guest.name, title: song.title, sent: false });
    this._event?.('duo.left', { ownerId: owner.id, guestId: guest.id, entryId: song.entryId, sent: false });
    return { stage: 'planned', owner, song };
  }

  // Duo déjà chargé dans KaraFun dont l'invitée se retire (elle-même, son
  // auteur avec « Chanter seul », ou le bar qui la marque partie). Le titre
  // garde sa place dans KaraFun, qui affiche encore les deux noms : aucune
  // commande n'est envoyée. Il devient le solo de son auteur, et l'invitée
  // récupère la part de tour que le duo lui avait comptée. `keepLabel` :
  // envoi encore sans accusé, reconnu par KaraFun sous l'ancien nom.
  leaveSentDuet(sel, guestId, { by = 'guest', keepLabel = false } = {}) {
    const gid = String(guestId || '');
    const owner = this.people.get(sel?.ids?.[0]);
    const index = sel?.ids ? sel.ids.indexOf(gid) : -1;
    if (!owner || index < 1) throw new Error('Duo introuvable.');
    const guest = this.people.get(gid);
    const guestName = guest?.name || sel.names?.[index] || '?';
    if (sel.turnCredit && !sel.turnCredit.rolledBack) this._dropPartnerCredit(sel, gid, owner);
    sel.ids = sel.ids.filter(pid => pid !== gid);
    // Le titre n'est plus un duo : revenu dans la liste de son auteur (« Pas
    // prêt », fermeture), il repart en solo. Envoi sans accusé : le titre de
    // la liste (le même, ou sa copie relue après un redémarrage) aussi.
    const entryId = sel.song?.entryId;
    for (const song of [sel.song, ...this.songsOf(owner).filter(s => entryId && s.entryId === entryId)]) {
      if (song?.duet?.partnerId === gid) delete song.duet;
    }
    this._refreshDuetViews();
    sel.consumedIds = (sel.consumedIds || [owner.id]).filter(pid => pid !== gid);
    if (Array.isArray(sel.names)) sel.names = sel.names.filter((name, i) => i !== index);
    if (sel.ids.length < 2) delete sel.kind;
    sel.group = owner.group;
    sel.groups = [owner.group];
    if (!keepLabel) sel.label = this.passageLabel([owner.id]);
    // La présence confirmée par l'invitée seule ne vaut plus pour l'auteur.
    if (sel.presenceConfirmed && this.opts.requirePresence && !this._confirmedRecently(owner)) sel.presenceConfirmed = false;
    const title = sel.song?.title || '';
    if (by === 'owner') {
      this.note(`${owner.name} chantera « ${title} » en solo, sans ${guestName} : KaraFun affiche encore les deux noms`, 'staff');
      this.notify(gid, 'duoCancelled', { name: owner.name, title });
    } else {
      this.note(by === 'staff' ?
        `${guestName} est parti : ${owner.name} chantera « ${title} » en solo. KaraFun affiche encore les deux noms` :
        `${guestName} se retire du duo avec ${owner.name} sur « ${title} », déjà dans KaraFun : ${owner.name} le chantera en solo. KaraFun affiche encore les deux noms`, 'staff');
      this.notify(owner.id, 'duoLeft', { name: guestName, title, sent: true });
    }
    this._event?.('duo.left', { ownerId: owner.id, guestId: gid, entryId: sel.song?.entryId || null, sent: true, by });
    this.version++;
    return { owner, guest };
  }

  // Inverse de _addPartnerCredit et de la part de l'invitée dans _commit :
  // l'invitée revient à son état d'avant le duo, sauf ce qui a changé depuis
  // (même garde que rollbackUnplayed). Le reçu du titre ne la contient plus :
  // une annulation plus tard ne touchera que son auteur.
  _dropPartnerCredit(sel, gid, owner) {
    const { before, after } = sel.turnCredit;
    if (!before || !after) return;
    const guest = this.people.get(gid);
    const oldRow = (before.people || []).find(row => row.id === gid);
    const newRow = (after.people || []).find(row => row.id === gid);
    // Remontée sur scène depuis (son propre titre envoyé après le duo) :
    // ce passage-là reste compté, seuls les compteurs propres au duo bougent.
    const sangSince = !newRow || (guest?.lastAppearanceTurn || 0) !== (newRow.lastAppearanceTurn || 0);
    if (guest && oldRow && newRow) {
      for (const field of ['duetGuestCount', 'lastAppearanceTurn']) {
        if ((guest[field] || 0) === (newRow[field] || 0)) guest[field] = oldRow[field] || 0;
      }
    }
    const valueIn = (rows, key = gid) => new Map(Array.isArray(rows) ? rows : []).get(key);
    const put = (rows, value, key = gid) => {
      const map = new Map(rows);
      if (value === undefined) map.delete(key); else map.set(key, value);
      return [...map];
    };
    const resets = sel.roundResets ?? (sel.newPersonRound ? 1 : 0);
    // Un passage de moins dans le tour, si elle n'est pas remontée sur scène depuis.
    const untouched = !sangSince && Array.isArray(after.roundApps) && (this.roundApps.get(gid) || 0) === (valueIn(after.roundApps) || 0);
    if (untouched) {
      const left = (this.roundApps.get(gid) || 0) - 1;
      if (left > 0) this.roundApps.set(gid, left); else this.roundApps.delete(gid);
      after.roundApps = put(after.roundApps, this.roundApps.get(gid));
    }
    // Son répit avance comme pour tout le monde, sans les deux chansons du duo.
    if (valueIn(after.duetCooldowns) !== undefined && this.duetCooldowns.get(gid) === valueIn(after.duetCooldowns)) {
      const old = valueIn(before.duetCooldowns);
      if (old > 1) this.duetCooldowns.set(gid, old - 1); else this.duetCooldowns.delete(gid);
      after.duetCooldowns = put(after.duetCooldowns, this.duetCooldowns.get(gid));
    }
    // Hausse de roundUse due à ce passage (roundPeople est rendu à part) :
    // rien quand l'invitée était déjà comptée dans le tour (dette en cours
    // comprise). Ancien reçu sans ce relevé : un passage entier, comme avant.
    const charged = Array.isArray(sel.turnCredit.roundCharged) ? (valueIn(sel.turnCredit.roundCharged) || 0) : 1 / this.personWeight(gid);
    if (charged > 0 && Array.isArray(after.roundUse) && this.roundUse.has(gid) && this.roundUse.get(gid) === valueIn(after.roundUse)) {
      const left = this.roundUse.get(gid) - charged;
      if (left > EPS) this.roundUse.set(gid, left); else this.roundUse.delete(gid);
      after.roundUse = put(after.roundUse, this.roundUse.get(gid));
    }
    const wasCounted = !resets && Array.isArray(before.roundPeople) && before.roundPeople.includes(gid);
    if (untouched && Array.isArray(after.roundPeople) && after.roundPeople.includes(gid) && !wasCounted &&
        !((this.roundUse.get(gid) || 0) >= 1 - EPS)) {
      this.roundPeople.delete(gid);
      after.roundPeople = after.roundPeople.filter(pid => pid !== gid);
    }
    const wasOwed = resets ? (sel.owed || []).includes(gid) : Array.isArray(before.roundOwed) && before.roundOwed.includes(gid);
    if (untouched && wasOwed && Array.isArray(after.roundOwed) && !after.roundOwed.includes(gid) && this.people.has(gid)) {
      this.roundOwed.add(gid);
      after.roundOwed = [...after.roundOwed, gid];
    }
    // Table de l'invitée comptée pour ce passage : il reste celui de l'auteur.
    const groups = sel.groups || [sel.group];
    const guestGroup = guest?.group || groups.find(group => group !== owner.group);
    if (guestGroup && guestGroup !== owner.group && groups.includes(guestGroup)) {
      const served = this.tableServeCounts.get(guestGroup) || 0;
      if (served === (valueIn(after.tableServeCounts, guestGroup) || 0) && served > 0) {
        if (served > 1) this.tableServeCounts.set(guestGroup, served - 1); else this.tableServeCounts.delete(guestGroup);
        after.tableServeCounts = put(after.tableServeCounts, this.tableServeCounts.get(guestGroup), guestGroup);
        const hadRound = !sel.newGroupRound && Array.isArray(before.roundGroups) && before.roundGroups.includes(guestGroup);
        if (!hadRound) {
          this.roundGroups.delete(guestGroup);
          if (Array.isArray(after.roundGroups)) after.roundGroups = after.roundGroups.filter(group => group !== guestGroup);
        }
      }
      const same = value => JSON.stringify(value) === JSON.stringify(groups);
      for (const list of [this.recentGroups, after.recentGroups]) {
        if (!Array.isArray(list)) continue;
        for (let i = list.length - 1; i >= 0; i--) if (same(list[i])) { list[i] = [owner.group]; break; }
      }
      if (same(this.lastGroup)) this.lastGroup = [owner.group];
      if (same(after.lastGroup)) after.lastGroup = [owner.group];
    }
    if (Array.isArray(before.people)) before.people = before.people.filter(row => row.id !== gid);
    if (Array.isArray(after.people)) after.people = after.people.filter(row => row.id !== gid);
  }

  // Tour d'un passage : celui de son envoi à KaraFun (son reçu, ligne de son
  // chanteur), sinon `sel.turn` (passage fini, relevé par recordStage). Pas
  // le dernier passage du chanteur, peut-être son titre suivant déjà chargé
  // dans KaraFun. 0 : inconnu (soirée sauvegardée avant ce relevé), ou hors
  // du compteur actuel des passages.
  _passageTurn(sel) {
    const credit = sel?.turnCredit;
    const row = credit && !credit.rolledBack && Array.isArray(credit.after?.people) ?
      credit.after.people.find(item => item.id === sel.ids?.[0]) : null;
    const turn = row ? row.lastAppearanceTurn : sel?.turn;
    return Number.isSafeInteger(turn) && turn > 0 && turn <= this.appearanceSerial ? turn : 0;
  }

  // `sel` : passage déjà confirmé par KaraFun auquel le bar ajoute l'invité.
  // `inFlight` : passages déjà envoyés à KaraFun, pas encore chantés, où
  // figure l'invité. Si l'un d'eux est retiré de KaraFun, son annulation ne
  // doit pas effacer le passage en duo (voir _keepGuestCredit).
  staffCountPartner(ownerId, partnerId, sel = null, inFlight = []) {
    const owner = this.people.get(String(ownerId)), partner = this.people.get(String(partnerId));
    if (!owner || !partner || owner.id === partner.id || owner.withdrawnAt || partner.withdrawnAt) {
      throw new Error('Choisis un autre chanteur encore présent dans la salle.');
    }
    // QR ouvert sans prénom : « Solo 3 » ne doit jamais devenir un nom de duo.
    if (partner.nameRequired) throw new Error('Cette personne n’a pas encore saisi son prénom.');
    const row = this._creditRow(partner.id), serialBefore = this.appearanceSerial;
    // Reçu d'annulation (duo noté par erreur) : valeurs d'avant le duo, reçus
    // des titres concernés, puis valeurs posées par le duo (voir
    // staffUncountPartner). Sérialisable, il survit à un redémarrage.
    const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
    const record = { ownerId: owner.id, partnerId: partner.id, at: Date.now(), entryId: sel?.song?.entryId || null,
      serialBefore, before: this._duoFields(partner.id),
      creditBefore: sel?.turnCredit && !sel.turnCredit.rolledBack ? clone(sel.turnCredit) : null,
      inFlight: (Array.isArray(inFlight) ? inFlight : []).filter(other => other && other !== sel &&
        other.ids?.includes(partner.id) && other.turnCredit && !other.turnCredit.rolledBack)
        .map(other => ({ entryId: other.song?.entryId || null, creditBefore: clone(other.turnCredit) })) };
    this.duetCooldowns.set(partner.id, 2);
    partner.duetGuestCount = (partner.duetGuestCount || 0) + 1;
    // Au tour du passage noté, pas au dernier passage du chanteur : son titre
    // suivant, déjà chargé dans KaraFun puis passé sans être chanté, fait
    // redescendre le compteur des passages (rollbackUnplayed), et un tour
    // resté au-dessus rendait la soirée sauvegardée impossible à reprendre
    // (vérification de la troisième passe de la relecture finale).
    const turn = this._passageTurn(sel) || owner.lastAppearanceTurn || ++this.appearanceSerial;
    // Sans titre du partenaire en route dans KaraFun, son dernier passage ne
    // recule pas : un duo corrigé sur un passage ancien ne doit pas le faire
    // passer devant celles et ceux qui attendent depuis plus longtemps (règle
    // de patience de _pick).
    partner.lastAppearanceTurn = record.inFlight.length ? turn : Math.max(partner.lastAppearanceTurn || 0, turn);
    this.roundPeople.add(partner.id);
    this.roundApps.set(partner.id, (this.roundApps.get(partner.id) || 0) + 1);
    this.roundOwed.delete(partner.id);
    if (sel?.turnCredit && !sel.turnCredit.rolledBack) this._addPartnerCredit(sel.turnCredit, partner.id, row, serialBefore);
    for (const other of Array.isArray(inFlight) ? inFlight : []) {
      if (other && other !== sel && other.ids?.includes(partner.id) && other.turnCredit && !other.turnCredit.rolledBack) {
        this._keepGuestCredit(other.turnCredit, partner.id, this.appearanceSerial - serialBefore);
      }
    }
    // Le partenaire vient de monter sur scène : le passage annoncé avec lui
    // juste après est libéré, et la file choisit à nouveau le suivant (avec
    // l'espacement habituel, il chantera plus tard si d'autres attendent).
    // Une invitation encore sans réponse ne compte pas : ce passage annoncé
    // part en solo, sans le partenaire. Les lignes de l'ordre fixé où il
    // chante retrouvent aussi le calcul (_unpinSingers), y compris une place
    // donnée par le bar à son propre titre (priorité, déplacement) : il chante
    // avant elle, le geste prend fin (_endPlaced).
    this._unpinSingers([partner.id]);
    const reserved = this.reservedNext?.byStaff ? null : this.people.get(this.reservedNext?.personId);
    const reservedDuet = reserved?.song?.duet;
    if (reserved && !this.manualOrder.includes(reserved.id) && (reserved.id === partner.id ||
        (reservedDuet?.state === 'accepted' && reservedDuet.partnerId === partner.id))) this.releaseNext();
    record.after = this._duoFields(partner.id);
    record.serialAfter = this.appearanceSerial;
    if (sel) sel.staffDuo = record;
    this._event('duo.improvised', { entryId: sel?.song?.entryId || null, ownerId: owner.id, partnerId: partner.id });
    this.note(`Le bar a compté ${partner.name} en duo avec ${owner.name} : ${owner.name} dépense son tour ; ${partner.name} garde son titre mais attend deux autres chansons si possible`, 'staff');
    return partner;
  }

  // Ce que le duo improvisé change pour l'invité.
  _duoFields(pid) {
    const p = this.people.get(pid);
    return { duetGuestCount: p?.duetGuestCount || 0, lastAppearanceTurn: p?.lastAppearanceTurn || 0,
      cooldown: this.duetCooldowns.has(pid) ? this.duetCooldowns.get(pid) : null,
      inRound: this.roundPeople.has(pid), roundApps: this.roundApps.get(pid) || 0, owed: this.roundOwed.has(pid) };
  }

  // Duo noté par erreur : défait staffCountPartner. Comme rollbackUnplayed,
  // on ne revient que sur une valeur encore égale à celle posée par le duo ;
  // une correction faite depuis prévaut. `sel` : passage du chanteur s'il est
  // encore suivi ; `liveSels` : passages encore suivis dans KaraFun. Un titre
  // de l'invité retiré de KaraFun sans être chanté a déjà défait son envoi :
  // son reçu d'avant envoi sert alors de référence.
  staffUncountPartner(record, sel = null, liveSels = []) {
    const owner = this.people.get(record?.ownerId), partner = this.people.get(record?.partnerId);
    if (!record?.before || !record.after || !partner) throw new Error('Aucun duo noté par le bar sur ce passage.');
    const pid = partner.id;
    const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
    let base = record.before, expectedTurn = record.after.lastAppearanceTurn;
    let rolledBack = false;
    for (const row of record.inFlight || []) {
      const live = (Array.isArray(liveSels) ? liveSels : []).find(item => row.entryId && item?.song?.entryId === row.entryId);
      if (live?.turnCredit && !live.turnCredit.rolledBack) { live.turnCredit = clone(row.creditBefore); continue; }
      const old = row.creditBefore?.before;
      const oldRow = Array.isArray(old?.people) && old.people.find(item => item.id === pid);
      if (rolledBack || !oldRow) continue;
      rolledBack = true;
      base = { duetGuestCount: oldRow.duetGuestCount || 0, lastAppearanceTurn: oldRow.lastAppearanceTurn || 0,
        cooldown: new Map(old.duetCooldowns || []).get(pid) ?? null,
        inRound: (old.roundPeople || []).includes(pid), roundApps: new Map(old.roundApps || []).get(pid) || 0,
        owed: (old.roundOwed || []).includes(pid) };
      // L'annulation de l'envoi a remis le reçu « avant », duo compris.
      expectedTurn = Math.max(oldRow.lastAppearanceTurn || 0, record.after.lastAppearanceTurn || 0);
    }
    partner.duetGuestCount = Math.max(0, (partner.duetGuestCount || 0) - 1);
    if ((partner.lastAppearanceTurn || 0) === expectedTurn) partner.lastAppearanceTurn = base.lastAppearanceTurn;
    if (record.serialAfter === record.serialBefore + 1 && this.appearanceSerial === record.serialAfter) {
      this.appearanceSerial = record.serialBefore;
      // Personne n'attend depuis un passage qui n'existe plus.
      for (const p of this.people.values()) {
        if ((p.readySerial || 0) > this.appearanceSerial) p.readySerial = this.appearanceSerial;
        if (p.emptiedAt > this.appearanceSerial) p.emptiedAt = this.appearanceSerial;
      }
    }
    // Chaque passage envoyé depuis le duo a rapproché les deux répits d'un cran.
    const cooldown = this.duetCooldowns.get(pid);
    if (cooldown !== undefined) {
      const left = base.cooldown == null ? 0 : base.cooldown - (2 - cooldown);
      if (left > 0) this.duetCooldowns.set(pid, left); else this.duetCooldowns.delete(pid);
    }
    // Sans passage compté au tour, un nouveau tour a commencé depuis : rien à rendre.
    const apps = this.roundApps.get(pid) || 0;
    if (apps > 0) {
      if (apps > 1) this.roundApps.set(pid, apps - 1); else this.roundApps.delete(pid);
      if (!base.inRound && (this.roundUse.get(pid) || 0) < 1 - EPS) this.roundPeople.delete(pid);
      if (base.owed) this.roundOwed.add(pid);
    }
    if (sel?.turnCredit && !sel.turnCredit.rolledBack && record.creditBefore) sel.turnCredit = clone(record.creditBefore);
    if (sel) delete sel.staffDuo;
    this._refreshDuetViews();
    this.note(`Le bar a annulé le duo noté de ${owner?.name || 'ce chanteur'} avec ${partner.name}`, 'staff');
    this.version++;
    return partner;
  }

  // Les derniers passages suivent le duo improvisé noté, annulé ou corrigé.
  setStagePeople(entry, ids, kind) {
    if (!entry) return null;
    entry.ids = [...ids];
    entry.names = ids.map(pid => this.people.get(pid)?.name || '?');
    entry.tableIds = ids.map(pid => this.people.get(pid)?.tableId || null);
    entry.kind = kind || (ids.length > 1 ? 'duo' : 'solo');
    this.version++;
    return entry;
  }

  // ------------------------------------------------------------------ demandes de duo
  // Une personne qui aime un titre prévu par une autre peut lui demander de
  // le chanter ensemble. L'auteur du titre garde son passage et accepte ou
  // refuse ; à la même table, le duo est direct, comme une invitation.
  _joinRequests(song) {
    const list = Array.isArray(song?.duoRequests) ? song.duoRequests : [];
    return list.filter(row => row && this.people.has(row.fromId) && !this.people.get(row.fromId).withdrawnAt);
  }

  requestDuetJoin(requester, ownerId, entryId) {
    const owner = this.people.get(String(ownerId || ''));
    if (!owner || owner.withdrawnAt) throw new Error('Ce chanteur n’est plus dans la file.');
    if (owner.id === requester.id) throw new Error('C’est déjà ton titre.');
    const song = this.songsOf(owner).find(item => item.entryId === String(entryId || ''));
    if (!song) throw new Error('Ce titre n’est plus en attente : il est peut-être déjà dans KaraFun.');
    if (song.duet?.state === 'open') throw new Error('Ce titre cherche déjà un partenaire : appuie sur « Je chante avec » pour le rejoindre.');
    if (song.duet) throw new Error('Ce titre est déjà prévu en duo.');
    const requests = this._joinRequests(song);
    if (requests.some(row => row.fromId === requester.id)) throw new Error('Ta demande de duo est déjà envoyée.');
    if (requests.length >= DUET_JOIN_MAX) throw new Error('Plusieurs personnes ont déjà demandé ce duo. Attends la réponse.');
    this.version++;
    if (owner.group === requester.group) {
      song.duet = { partnerId: requester.id, state: 'accepted' };
      if (owner.song === song) this._guestJoined(owner);
      // Comme une demande acceptée : les autres personnes qui demandaient ce
      // titre sont prévenues.
      for (const row of requests) this.notify(row.fromId, 'joinRefused', { name: owner.name, title: song.title });
      delete song.duoRequests;
      this._refreshDuetViews();
      this._event('duo.joinRequested', { requesterId: requester.id, ownerId: owner.id, entryId: song.entryId, direct: true });
      this.note(`${requester.name} rejoint ${owner.name} en duo sur « ${song.title} »`);
      this.notify(owner.id, 'duoAdded', { name: requester.name, fromId: requester.id, title: song.title });
      return { direct: true, song };
    }
    song.duoRequests = [...requests, { fromId: requester.id, at: Date.now() }];
    this._event('duo.joinRequested', { requesterId: requester.id, ownerId: owner.id, entryId: song.entryId, direct: false });
    this.note(`${requester.name} propose à ${owner.name} de chanter « ${song.title} » en duo`);
    return { direct: false, song };
  }

  answerDuetJoin(owner, entryId, fromId, accept) {
    const song = this.songsOf(owner).find(item => item.entryId === String(entryId || ''));
    const requests = this._joinRequests(song);
    const request = requests.find(row => row.fromId === String(fromId || ''));
    if (!song || !request) throw new Error('Cette demande de duo n’est plus valable.');
    const partner = this.people.get(request.fromId);
    if (accept && song.duet) throw new Error('Ce titre est déjà prévu en duo.');
    this._event('duo.joinAnswered', { personId: owner.id, ownerId: owner.id, requesterId: partner.id, entryId: song.entryId, accepted: !!accept });
    if (accept) {
      song.duet = { partnerId: partner.id, state: 'accepted' };
      if (owner.song === song) this._guestJoined(owner);
      // Un seul partenaire : les autres demandes sur ce titre sont closes.
      delete song.duoRequests;
      this._refreshDuetViews();
      this.note(`${owner.name} accepte de chanter « ${song.title} » avec ${partner.name} : ${owner.name} garde son tour, ${partner.name} garde ses propres titres`);
      this.notify(partner.id, 'joinAccepted', { name: owner.name, title: song.title });
      // Les autres personnes qui demandaient ce titre sont prévenues.
      for (const row of requests) if (row !== request) this.notify(row.fromId, 'joinRefused', { name: owner.name, title: song.title });
    } else {
      song.duoRequests = requests.filter(row => row !== request);
      if (!song.duoRequests.length) delete song.duoRequests;
      this.note(`${owner.name} préfère chanter « ${song.title} » sans ${partner.name}`);
      this.notify(partner.id, 'joinRefused', { name: owner.name, title: song.title });
    }
    this.version++;
    return song;
  }

  cancelDuetJoin(requester, ownerId, entryId) {
    const owner = this.people.get(String(ownerId || ''));
    const song = owner && this.songsOf(owner).find(item => item.entryId === String(entryId || ''));
    const requests = this._joinRequests(song);
    if (!requests.some(row => row.fromId === requester.id)) throw new Error('Demande de duo introuvable.');
    song.duoRequests = requests.filter(row => row.fromId !== requester.id);
    if (!song.duoRequests.length) delete song.duoRequests;
    this.version++;
    this._event('duo.joinCancelled', { requesterId: requester.id, ownerId: owner.id, entryId: song.entryId });
    this.note(`${requester.name} retire sa demande de duo à ${owner.name}`);
  }

  // Demandes reçues par l'auteur de titres, et envoyées par une personne.
  duetJoinRequestsFor(owner) {
    return this.songsOf(owner).flatMap(song => this._joinRequests(song).map(row => ({
      entryId: song.entryId, fromId: row.fromId, fromName: this.people.get(row.fromId).name, at: row.at, song })));
  }

  // Toutes les demandes envoyées, par personne : un seul passage sur la file.
  duetJoinRequestsByPerson() {
    const out = new Map();
    for (const owner of this.people.values()) {
      if (owner.withdrawnAt) continue;
      for (const song of this.songsOf(owner)) {
        if (!song.duoRequests) continue;
        for (const row of this._joinRequests(song)) {
          if (!out.has(row.fromId)) out.set(row.fromId, []);
          out.get(row.fromId).push({ ownerId: owner.id, ownerName: owner.name, entryId: song.entryId, song, seenAt: row.seenAt || null });
        }
      }
    }
    return out;
  }

  duetJoinRequestsBy(requester) {
    return this.duetJoinRequestsByPerson().get(requester.id) || [];
  }

  // Fenêtre d'une demande ou d'une invitation de duo affichée sur le téléphone
  // de la personne qui doit répondre : le demandeur et le bar savent qu'elle
  // est arrivée. Sans `fromId`, c'est une invitation reçue par `recipient`.
  markDuetSeen(recipient, entryId, fromId = null) {
    const key = String(entryId || '');
    let target = null;
    if (fromId) {
      const song = this.songsOf(recipient).find(item => item.entryId === key);
      target = this._joinRequests(song).find(row => row.fromId === String(fromId)) || null;
    } else {
      target = this.duetInvites(recipient).find(item => item.entryId === key)?.song.duet || null;
    }
    if (!target) return false;
    if (!target.seenAt) {
      target.seenAt = Date.now();
      this.version++;
    }
    return true;
  }

  giveSpot(p, toId) {
    const q = this.people.get(toId);
    if (!q || q.group !== p.group) throw new Error('On ne cède sa place qu\'à quelqu\'un de son groupe.');
    const i = this.Q.indexOf(p.id), j = this.Q.indexOf(q.id);
    if (i < 0) throw new Error('Tu n\'es pas encore dans la file.');
    // Deux premiers passages de la même table partent dans l'ordre d'ajout
    // (`readySince`, rotation.js#_pick), pas dans l'ordre de la file.
    const first = r => r.song && !((r.sung || 0) + (r.duetGuestCount || 0));
    const byAdd = j >= 0 && first(p) && first(q);
    if (j >= 0 && (byAdd ? (q.readySince || 0) < (p.readySince || 0) : j < i)) throw new Error(`${q.name} est déjà devant toi.`);
    if (j < 0) { // q n'a pas encore de ticket : il prend la place de p, p repart en fin de file
      this.Q[i] = q.id;
      this.Q.push(p.id);
      // Fin de file aussi pour l'ordre d'ajout ; q prend l'heure de son titre.
      p.readySince = this._readyStamp();
    } else {
      this.Q[i] = q.id; this.Q[j] = p.id;
      if (byAdd) [p.readySince, q.readySince] = [q.readySince, p.readySince];
    }
    // Les deux places changent de main : elles retrouvent le calcul, les
    // autres lignes placées par le bar gardent la leur.
    this._unpinManual(p.id);
    this._unpinManual(q.id);
    this._event('person.gaveSpot', { personId: p.id, toId: q.id });
    this.note(`${p.name} cède sa place à ${q.name}`);
  }
}

module.exports = SchedulerDuets;
