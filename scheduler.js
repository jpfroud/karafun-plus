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
 * - Table plafonnée à son nombre de personnes (anti faux noms / navigation privée).
 */
const crypto = require('crypto');
const { TimefoldBridge } = require('./solver/bridge');

const DEFAULTS = {
  gap: 4,               // espacement visé entre deux chanteurs d'une même table
  cap: 2,               // reculs max pendant une attente
  protectTop: 5,        // les N prochains ne bougent jamais
  requirePresence: false, // confirmation « je suis là » obligatoire quand on approche
  tableRotation: false,  // une table prête passe avant de revenir à la précédente
  weightedTables: false, // alternance par table avec crédit proportionnel à sqrt(chanteurs prêts)
  presenceWindow: 3,    // on demande la confirmation dans les N prochains
  defaultSlotSec: 240,  // durée moyenne d'un passage avant mesure réelle
  solverEnabled: false,  // activé par le serveur quand le solveur Java est empaqueté
};

const id = () => crypto.randomBytes(6).toString('hex');
const token = () => crypto.randomBytes(16).toString('hex');

class Scheduler {
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
    this.tableServeCounts = new Map(); // passages par groupe pour l'alternance pondérée
    this.duetCooldowns = new Map(); // invité : nombre d'autres chansons à laisser passer
    this.reservedNext = null; // personne annoncée comme prochain passage, hors KaraFun
    this.log = [];            // journal visible par tous
    this.slotSamples = [];    // durées réelles mesurées (s)
    this.version = 0;
    this.appearanceSerial = 0; // passages physiques, invités de duo compris
    this.solverBridge = this.opts.solverEnabled ? new TimefoldBridge() : null;
    this.solverPlan = null;
    this.solverRequestedVersion = -1;
    this.solverRequestedFingerprint = null;
    this.solverPendingVersion = -1;
    this.solverPendingFingerprint = null;
    this.solverPendingRequestId = null;
    this.solverNextStartedAt = 0;
    this.solverPromise = null;
    this.solverLastError = null;
  }

  // ------------------------------------------------------------------ journal
  note(msg, kind = 'info') {
    this.log.push({ t: Date.now(), msg, kind });
    if (this.log.length > 300) this.log.shift();
    this.version++;
  }

  invalidateManualOrder() {
    this.manualOrder = [];
    this.manualOrderActive = false;
    this.manualChanges = [];
  }

  manualOverrideState() {
    return { manualOrder: [...this.manualOrder], manualOrderActive: this.manualOrderActive,
      reservedNext: this.reservedNext ? { ...this.reservedNext } : null };
  }

  restoreManualOverride(state) {
    this.manualOrder = [...state.manualOrder];
    this.manualOrderActive = !!state.manualOrderActive && this.manualOrder.length > 0;
    this.reservedNext = state.reservedNext ? { ...state.reservedNext } : null;
  }

  // Les notes, photos et noms peuvent changer sans modifier la file. Cette
  // empreinte ne couvre que les données qui déterminent les places prévues.
  manualContextFingerprint() {
    const people = this.Q.map(pid => {
      const p = this.people.get(pid);
      return p ? [pid, p.group, p.withdrawnAt, p.sung, p.duetGuestCount || 0,
        p.lastAppearanceTurn || 0,
        p.over, p.held, p.song?.entryId || null, p.song?.duet || null,
        (p.backlog || []).map(song => [song.entryId, song.duet || null])] : [pid];
    });
    const context = { people, Q: this.Q, lastGroup: this.lastGroup,
      roundGroups: [...this.roundGroups], roundPeople: [...this.roundPeople],
      tableServeCounts: [...this.tableServeCounts], duetCooldowns: [...this.duetCooldowns],
      opts: this.opts, appearanceSerial: this.appearanceSerial,
      ...this.manualOverrideState() };
    return crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex');
  }

  // Empreinte séparée de celle des annulations manuelles. Une inscription sans
  // chanson ou un ticket vide ne change aucun problème soumis à Timefold ;
  // elle ne doit pas interrompre quinze secondes de recherche pour les autres.
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
        p.lastAppearanceTurn || 0, p.over, p.held, p.waitingSince || 0,
        songs.map(song => [song.entryId, song.duet || null])];
    });
    // Un invité sans ticket reste pertinent : son dernier passage physique
    // influence directement le score et la distance de son prochain duo.
    const physical = [...relevant].map(pid => {
      const p = this.people.get(pid);
      return p ? [pid, p.group, p.withdrawnAt, p.sung, p.duetGuestCount || 0,
        p.lastAppearanceTurn || 0] : [pid];
    });
    const context = { entries, physical, lastGroup: this.lastGroup,
      roundGroups: [...this.roundGroups], roundPeople: [...this.roundPeople],
      tableServeCounts: [...this.tableServeCounts], duetCooldowns: [...this.duetCooldowns],
      opts: this.opts, appearanceSerial: this.appearanceSerial,
      ...this.manualOverrideState() };
    return crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex');
  }

  canUndoManualChange(nativeFingerprint) {
    const latest = this.manualChanges.at(-1);
    return !!latest && latest.native === nativeFingerprint &&
      latest.after === this.manualContextFingerprint();
  }

  recordManualChange({ kind, personId, name, from, to, before, native }) {
    const change = { id: id(), kind, personId, name, from, to, at: Date.now(),
      before, after: this.manualContextFingerprint(), native };
    this.manualChanges.push(change);
    return change;
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
    this.restoreManualOverride(latest.before);
    this.manualChanges.pop();
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
    this.restoreManualOverride(this.manualChanges[0].before);
    this.manualChanges = [];
    this.note(`Le bar a annulé ${count} changement${count > 1 ? 's' : ''} manuel${count > 1 ? 's' : ''} dans la file`, 'staff');
    return count;
  }

  // ------------------------------------------------------------------ tables
  table(tableId, create = true) {
    const key = String(tableId).trim().slice(0, 20);
    if (!this.tables.has(key) && create) {
      this.tables.set(key, { id: key, name: /^\d+$/.test(key) ? `Table ${key}` : key, headcount: null, individual: /^comptoir/i.test(key), createdAt: Date.now() });
    }
    return this.tables.get(key);
  }

  setHeadcount(tableId, n, by = 'staff') {
    const t = this.table(tableId);
    const v = Math.max(1, Math.min(40, parseInt(n, 10) || 1));
    t.headcount = v;
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
    gone.forEach(p => this._drop(p, false));
    this.tables.delete(tableId);
    this.note(`${t.name} est partie : ${gone.length} ticket${gone.length > 1 ? 's' : ''} retiré${gone.length > 1 ? 's' : ''}`);
  }

  // ------------------------------------------------------------------ personnes
  join({ tableId, name, photo, headcount }) {
    const t = this.table(tableId);
    name = this.validName(name, t.id);
    if (t.headcount == null) {
      if (!headcount) { const e = new Error('Combien êtes-vous à la table ?'); e.code = 'NEED_HEADCOUNT'; throw e; }
      this.setHeadcount(t.id, headcount, 'table');
    }
    // Le groupe des solistes accueille des personnes successives toute la
    // soirée : un départ libère sa place. Les tables ordinaires gardent leurs
    // fiches historiques pour éviter le retour frauduleux comme « nouveau ».
    const count = this.tableSingers(t.id).filter(p => !t.individual || !p.withdrawnAt).length;
    if (count >= t.headcount) {
      const e = new Error(`${t.name} a déjà ${count} chanteur${count > 1 ? 's' : ''} inscrit${count > 1 ? 's' : ''} pour ${t.headcount} personne${t.headcount > 1 ? 's' : ''}. Si vous êtes plus nombreux, demande au bar d'ajuster.`);
      e.code = 'TABLE_FULL';
      throw e;
    }
    const p = {
      id: id(), token: token(), name, tableId: t.id, photo: photo || null,
      joinedAt: Date.now(), song: null, backlog: [], sung: 0, over: 0, held: 0,
      confirmedAt: 0, duet: null, duetOf: null, invite: null, lastSeen: Date.now(),
      privateNote: '', verifiedAt: 0, withdrawnAt: null, lastAppearanceTurn: 0,
    };
    p.group = t.individual ? `${t.id}#${p.id}` : t.id;
    this.people.set(p.id, p);
    this.byToken.set(p.token, p.id);
    this.note(`${p.name} (${t.name}) s'est inscrit`);
    return p;
  }

  person(tok) {
    const pid = this.byToken.get(tok);
    return pid ? this.people.get(pid) : null;
  }

  validName(name, tableId, exceptId = null) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('Indique ton prénom.');
    if (clean.length > 24) throw new Error('Prénom limité à 24 caractères.');
    if ([...this.people.values()].some(p => p.tableId === tableId && p.id !== exceptId &&
        p.name.toLocaleLowerCase('fr') === clean.toLocaleLowerCase('fr'))) {
      const e = new Error('Ce prénom est déjà inscrit à cette table. Utilise la fiche existante ou précise le nom.');
      e.code = 'NAME_TAKEN'; throw e;
    }
    return clean;
  }

  rename(p, name) {
    const next = this.validName(name, p.tableId, p.id);
    if (next === p.name) return p;
    const before = p.name;
    p.name = next;
    this.note(`${before} (${this.table(p.tableId).name}) s'appelle maintenant ${next}`);
    return p;
  }

  staffIdentify(personId, note, verified) {
    const p = this.people.get(String(personId));
    if (!p) throw new Error('Chanteur inconnu.');
    const clean = String(note || '').replace(/\s+/g, ' ').trim();
    if (clean.length > 140) throw new Error('Description limitée à 140 caractères.');
    p.privateNote = clean;
    p.verifiedAt = verified ? (p.verifiedAt || Date.now()) : 0;
    // Les notes privées ne vont jamais dans le journal public.
    this.version++;
    return p;
  }

  leave(p) {
    // L'identité et l'historique des passages survivent au retrait. On ne
    // peut donc pas recréer un « nouveau » chanteur avec le même QR de table.
    this._removeDuetsForPerson(p, true);
    p.song = null; p.backlog = []; p.withdrawnAt = Date.now();
    this._removeFromQ(p.id);
    if (this.reservedNext?.personId === p.id) this.releaseNext();
    this.invalidateManualOrder();
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
    const next = { entryId: id(), songId: Number(song.songId), title: String(song.title || '').slice(0, 80), artist: String(song.artist || '').slice(0, 60), img: song.img || null, duration: song.duration || null };
    if (!Number.isSafeInteger(next.songId) || next.songId <= 0 || !next.title) throw new Error('Chanson invalide.');
    if (mode === 'append' && this.songsOf(p).some(s => s.songId === next.songId)) {
      const e = new Error('Cette chanson est déjà dans la liste de ce chanteur.'); e.code = 'ALREADY_LISTED'; throw e;
    }
    if (mode === 'append' && this.songsOf(p).length >= 20) {
      const e = new Error('La liste est limitée à 20 chansons par chanteur.'); e.code = 'LIST_FULL'; throw e;
    }
    this.invalidateManualOrder();
    if (mode === 'append' && p.song) p.backlog.push(next);
    else {
      if (mode === 'replace') {
        p.backlog = [];
      }
      p.song = next;
    }
    p.withdrawnAt = null;
    this._refreshDuetViews();
    if (!this.Q.includes(p.id)) {
      const pos = this._placeNewcomer(p);
      this.note(`${p.name} (${this.table(p.tableId).name}) entre dans la file en ${pos === 0 ? '1re' : (pos + 1) + 'e'} position`);
    } else {
      this.note(`${p.name} a ${mode === 'append' ? 'ajouté à sa liste' : 'choisi'} « ${next.title} »`);
    }
    this.version++;
  }

  removeSong(p, entryId) {
    const key = String(entryId || '');
    if (p.song && p.song.entryId === key) {
      p.song = (p.backlog || []).shift() || null;
    } else {
      const i = (p.backlog || []).findIndex(s => s.entryId === key);
      if (i < 0) throw new Error('Chanson introuvable dans la liste.');
      p.backlog.splice(i, 1);
    }
    this.invalidateManualOrder();
    this._refreshDuetViews();
    if (this.reservedNext?.personId === p.id && !p.song) this.releaseNext();
    this.note(`${p.name} a retiré une chanson de sa liste`);
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
    this.note(`${p.name} a réordonné sa liste de chansons`);
  }

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
        if (!d) continue;
        const partner = this.people.get(d.partnerId);
        if (!partner) { delete song.duet; continue; }
        if (d.state === 'pending' && !partner.invite) partner.invite = { fromId: owner.id, song, entryId: song.entryId };
        if (d.state === 'accepted' && !partner.duetOf) partner.duetOf = owner.id;
      }
    }
  }

  _removeDuetsForPerson(p, notify) {
    let removed = 0;
    for (const owner of this.people.values()) {
      for (const song of this.songsOf(owner)) {
        if (!song.duet || (owner.id !== p.id && song.duet.partnerId !== p.id)) continue;
        delete song.duet;
        removed++;
      }
    }
    this._refreshDuetViews();
    if (removed) this.invalidateManualOrder();
    if (removed && notify) this.note(`${removed} duo${removed > 1 ? 's' : ''} annulé${removed > 1 ? 's' : ''} pour ${p.name}`);
  }

  inviteDuet(p, partnerId, song) {
    const q = this.people.get(partnerId);
    if (!q || q.id === p.id) throw new Error('Partenaire introuvable.');
    this.chooseSong(p, song, 'append');
    // Comme un titre solo, un duo est ajouté à la fin de la liste. Une personne
    // peut ensuite réordonner ses titres si elle souhaite le chanter plus tôt.
    const duetSong = this.songsOf(p).at(-1);
    // Le Comptoir est une table physique, mais chaque soliste y est un groupe
    // indépendant : il doit accepter l'invitation comme à une autre table.
    const sameGroup = p.group === q.group;
    duetSong.duet = { partnerId: q.id, state: sameGroup ? 'accepted' : 'pending' };
    this._refreshDuetViews();
    this.note(sameGroup ?
      `${p.name} a prévu un duo avec ${q.name} sur « ${duetSong.title} »` :
      `${p.name} invite ${q.name} en duo sur « ${duetSong.title} »`);
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
    this.invalidateManualOrder();
    if (accept) {
      song.duet.state = 'accepted';
      this.note(`${q.name} accepte le duo avec ${p.name} : seul ${p.name} dépense son tour`);
    } else {
      delete song.duet;
      this.note(`${q.name} décline le duo : ${p.name} chantera en solo`);
    }
    this._refreshDuetViews();
    this.version++;
  }

  _cancelDuet(owner, notify, entryId) {
    const song = entryId ? this.songsOf(owner).find(s => s.entryId === String(entryId)) : this.songsOf(owner).find(s => s.duet);
    const d = song?.duet;
    if (!d) return;
    this.invalidateManualOrder();
    const q = this.people.get(d.partnerId);
    delete song.duet;
    this._refreshDuetViews();
    if (notify) this.note(`Duo annulé (${owner.name}${q ? ' & ' + q.name : ''})`);
    this.version++;
  }

  cancelDuet(p, entryId) {
    const own = entryId ? this.songsOf(p).find(s => s.entryId === String(entryId) && s.duet) : this.songsOf(p).find(s => s.duet);
    if (own) return this._cancelDuet(p, true, own.entryId);
    const inv = this.duetInvites(p).find(x => !entryId || x.entryId === String(entryId));
    if (inv) return this._cancelDuet(this.people.get(inv.fromId), true, inv.entryId);
    throw new Error('Duo introuvable.');
  }

  staffCountPartner(ownerId, partnerId) {
    const owner = this.people.get(String(ownerId)), partner = this.people.get(String(partnerId));
    if (!owner || !partner || owner.id === partner.id || owner.withdrawnAt || partner.withdrawnAt) {
      throw new Error('Choisis un autre chanteur encore présent dans la salle.');
    }
    this.invalidateManualOrder();
    this.duetCooldowns.set(partner.id, 2);
    partner.duetGuestCount = (partner.duetGuestCount || 0) + 1;
    partner.lastAppearanceTurn = owner.lastAppearanceTurn || ++this.appearanceSerial;
    this.roundPeople.add(partner.id);
    this.note(`Le bar a compté ${partner.name} en duo avec ${owner.name} : ${owner.name} dépense son tour ; ${partner.name} garde son titre mais attend deux autres chansons si possible`, 'staff');
    return partner;
  }

  // ------------------------------------------------------------------ actions du chanteur
  confirm(p) { p.confirmedAt = Date.now(); p.held = 0; this.version++; }

  confirmedForTurn(ids) {
    return ids.every(pid => {
      const p = this.people.get(pid);
      return p && (!this.opts.requirePresence || this._confirmedRecently(p));
    });
  }

  giveSpot(p, toId) {
    const q = this.people.get(toId);
    if (!q || q.group !== p.group) throw new Error('On ne cède sa place qu\'à quelqu\'un de son groupe.');
    const i = this.Q.indexOf(p.id), j = this.Q.indexOf(q.id);
    if (i < 0) throw new Error('Tu n\'es pas encore dans la file.');
    if (j >= 0 && j < i) throw new Error(`${q.name} est déjà devant toi.`);
    if (j < 0) { // q n'a pas encore de ticket : il prend la place de p, p repart en fin de file
      this.Q[i] = q.id;
      this.Q.push(p.id);
    } else {
      this.Q[i] = q.id; this.Q[j] = p.id;
    }
    this.invalidateManualOrder();
    this.note(`${p.name} cède sa place à ${q.name}`);
  }

  // ------------------------------------------------------------------ actions du bar
  staffMove(personId, toIndex, excludeIds = [], provisional = null) {
    // Les titres supplémentaires d'un même chanteur ont une place prévue mais
    // ne sont pas des tickets indépendants déplaçables par le bar.
    const visible = this.presenceView(excludeIds, provisional).filter(v => !v.future);
    // L'invité d'un duo peut aussi posséder un solo plus loin dans la file :
    // son bouton Priorité doit viser son propre titre, pas celui du duo.
    const i = visible.findIndex(v => v.ids[0] === personId);
    if (i < 0) { const e = new Error('Cette chanson n’est plus dans la file du helper.'); e.code = 'SONG_SENT'; throw e; }
    const target = Number(toIndex);
    if (!Number.isInteger(target) || target < 0 || target >= visible.length) throw new Error('Place de destination invalide.');
    const [item] = visible.splice(i, 1);
    visible.splice(target, 0, item);
    // Un titre déjà en cours d'envoi peut encore porter l'ancienne réservation.
    // Réordonner les titres suivants ne doit pas toucher à cette commande.
    if (target === 0 && visible[0]) {
      // Le bar avance explicitement ce passage. Cette dérogation unique peut
      // dépasser l'équité des premiers passages ; l'ordre mémorisé des autres
      // lignes ne le peut pas.
      this.reservedNext = { personId: visible[0].ids[0], reservedAt: Date.now() };
      this.version++;
    } else if (this.reservedNext && !excludeIds.includes(this.reservedNext.personId) &&
        visible[0]?.ids[0] !== this.reservedNext.personId) this.releaseNext();
    // Seul le préfixe qui fixe la place demandée passe avant l'équité. Les
    // autres titres restent soumis aux premiers passages et à la rotation.
    this.manualOrder = visible.slice(0, target + 1).map(v => v.ids[0]);
    this.manualOrderActive = this.manualOrder.length > 0;
    this.note(`Le bar a déplacé ${this.people.get(item.ids[0]).name} de la place ${i + 1} à la place ${target + 1}`, 'staff');
  }

  staffRemove(personId) {
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
        reservedNext: state.reservedNext?.personId === p.id ? null : state.reservedNext };
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
    p.song = (p.backlog || []).shift() || null;
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
    this.note(`Le bar a retiré ${removed ? `« ${removed.title} »` : 'le titre'} de ${p.name}${p.song ? ` ; « ${p.song.title} » prend sa place` : ''}`, 'staff');
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

  // ------------------------------------------------------------------ sélection
  isReady(p) {
    if (!p || !p.song) return false;
    if (p.duet && p.duet.state === 'pending') return false;
    if (this.opts.requirePresence && !this._confirmedRecently(p)) return false;
    return true;
  }

  _confirmedRecently(p) {
    return p.confirmedAt && Date.now() - p.confirmedAt < 30 * 60 * 1000;
  }

  // Le solveur est un processus local asynchrone. Les lectures restent
  // synchrones, mais l'envoi automatique attend le plan correspondant à la
  // version courante ; un résultat ancien ne peut jamais déplacer un titre.
  _maybeRequestSolver() {
    if (!this.solverBridge || !this.solverBridge.available) return false;
    // `version` sert aussi aux rafraîchissements d'interface et au journal.
    // Une note ou une photo ne doit donc pas redémarrer Timefold, ni faire
    // vaciller un classement déjà publié.
    const fingerprint = this.solverContextFingerprint();
    if (this.solverPlan?.fingerprint === fingerprint) {
      this.solverPlan.version = this.version;
      this.solverRequestedVersion = this.version;
      return false;
    }
    if (this.solverRequestedFingerprint === fingerprint) {
      this.solverRequestedVersion = this.version;
      if (this.solverPendingFingerprint === fingerprint) {
        this.solverPendingVersion = this.version;
        return true;
      }
      return false;
    }
    const before = this.version;
    const base = this._forecast(false, [], null, true);
    if (base.length < 2 || base.length > 200 || base.some(item => !item.entryId)) {
      this.solverLastError = base.length > 200 ?
        'Plus de 200 titres prêts : ordonnanceur de repli actif.' :
        base.some(item => !item.entryId) ? 'Titre sans identifiant : ordonnanceur de repli actif.' : null;
      this.solverRequestedVersion = before;
      this.solverRequestedFingerprint = fingerprint;
      this.solverNextStartedAt = 0;
      return false;
    }
    const rows = base.map((item, previousIndex) => {
      const owner = this.people.get(item.ids[0]);
      return { id: item.entryId, owner: owner.id,
        ownerSongIndex: this.songsOf(owner).findIndex(song => song.entryId === item.entryId),
        singers: item.ids, groups: item.groups || [item.group], previousIndex };
    });
    let pinnedUntil = 0;
    if (this.reservedNext && rows[0]?.owner === this.reservedNext.personId) pinnedUntil = 1;
    if (this.manualOrderActive) {
      while (pinnedUntil < rows.length && this.manualOrder.includes(rows[pinnedUntil].owner)) {
        pinnedUntil++;
      }
    }
    const pastAppearance = {}, physicalCount = {};
    const groupReadySets = new Map();
    for (const p of this.people.values()) {
      physicalCount[p.id] = (p.sung || 0) + (p.duetGuestCount || 0);
      if (p.lastAppearanceTurn) {
        pastAppearance[p.id] = p.lastAppearanceTurn - this.appearanceSerial - 1;
      } else if (physicalCount[p.id]) pastAppearance[p.id] = -1000;
    }
    for (const row of rows) for (const singerId of row.singers) {
      const singer = this.people.get(singerId);
      if (!singer) continue;
      if (!groupReadySets.has(singer.group)) groupReadySets.set(singer.group, new Set());
      groupReadySets.get(singer.group).add(singerId);
    }
    // Un petit groupe est vite stabilisé ; les grandes soirées bénéficient
    // de plus de recherche. Un seul plan final est publié pour cette version.
    const adaptiveBudgetMs = rows.length < 20 ? 3000 : rows.length < 60 ? 8000 : 15000;
    // Les tests de simulation peuvent réduire le temps, sans changer la
    // politique de production ni la fonction de score utilisée.
    const budgetMs = Number.isInteger(this.opts.solverBudgetMs) &&
      this.opts.solverBudgetMs >= 100 && this.opts.solverBudgetMs <= 30000 ?
      this.opts.solverBudgetMs : adaptiveBudgetMs;
    const request = { requestId: `${before}-${id()}`, budgetMs, performances: rows,
      pastAppearance, physicalCount, pinnedUntil,
      roundPeople: [...this.roundPeople],
      roundGroups: [...this.roundGroups],
      tableServeCounts: Object.fromEntries(this.tableServeCounts),
      groupReadyCounts: Object.fromEntries([...groupReadySets].map(([g, singers]) => [g, singers.size])),
      lastGroups: Array.isArray(this.lastGroup) ? this.lastGroup :
        this.lastGroup ? [this.lastGroup] : [],
      tableRotation: !!this.opts.tableRotation, weightedTables: !!this.opts.weightedTables };
    this.solverRequestedVersion = before;
    this.solverRequestedFingerprint = fingerprint;
    this.solverPendingVersion = before;
    this.solverPendingFingerprint = fingerprint;
    this.solverPendingRequestId = request.requestId;
    if (!this.solverNextStartedAt && !this.reservedNext && !this.manualOrderActive) {
      this.solverNextStartedAt = Date.now();
    }
    this.solverPromise = this.solverBridge.solve(request).then(response => {
      if (this.solverPendingRequestId !== request.requestId ||
          this.solverContextFingerprint() !== fingerprint) return false;
      const order = response.order;
      const originalIds = rows.map(row => row.id);
      if (!Array.isArray(order) || order.length !== originalIds.length ||
          new Set(order).size !== order.length || order.some(entry => !originalIds.includes(entry)) ||
          originalIds.slice(0, pinnedUntil).some((entry, index) => order[index] !== entry)) {
        throw new Error('Le solveur a répondu avec une file invalide.');
      }
      this.version++;
      this.solverPlan = { version: this.version,
        fingerprint,
        ranks: new Map(order.map((entry, index) => [entry, index])) };
      this.solverRequestedVersion = this.version;
      this.solverPendingVersion = -1;
      this.solverPendingFingerprint = null;
      this.solverPendingRequestId = null;
      this.solverLastError = null;
      return true;
    }).catch(error => {
      if (this.solverPendingRequestId === request.requestId) {
        this.solverPendingVersion = -1;
        this.solverPendingFingerprint = null;
        this.solverPendingRequestId = null;
        this.solverLastError = error.message;
        if (!this.solverBridge.available) {
          this.solverRequestedVersion = -1;
          this.solverRequestedFingerprint = null;
        }
      }
      return false; // l'ancien ordonnanceur reste disponible
    });
    return true;
  }

  whenPlanReady() {
    const pending = this._maybeRequestSolver();
    return pending ? this.solverPromise : Promise.resolve(this.solverPlan?.version === this.version);
  }
  // Une chanson ne doit pas rester muette 15 s lorsque la file vient d'être
  // créée. Après cette courte fenêtre, l'heuristique locale peut annoncer et
  // réserver le prochain passage ; Timefold poursuit le reste en arrière-plan.
  _solverBlocksNext() {
    return this.solverPendingFingerprint !== null &&
      this.solverNextStartedAt > 0 &&
      Date.now() - this.solverNextStartedAt < 2500 &&
      !this.reservedNext && !this.manualOrderActive;
  }
  solverStatus() {
    return { configured: !!this.solverBridge,
      available: !!this.solverBridge?.available,
      pending: this.solverPendingVersion === this.version,
      blockingNext: this._solverBlocksNext(),
      fallbackLastError: this.solverLastError || this.solverBridge?.lastError || null };
  }
  closeSolver() { this.solverBridge?.close(); }

  // Chaque chanteur prêt passe une fois par tour. Parmi ceux qui attendent leur
  // tour, on privilégie une table qui n'a pas encore chanté dans ce tour.
  // `predict` : on suppose que chaque ticket sera prêt à temps.
  _pick(order, lastGroup, predict, roundGroups = this.roundGroups, roundPeople = this.roundPeople,
    servedCounts = this.tableServeCounts, cooldowns = this.duetCooldowns, projectedSongs = null,
    reservation = null, appearances = null, ignorePresence = false,
    recentTurns = null) {
    const idx = new Map(order.map((pid, i) => [pid, i]));
    const cands = [];
    for (const pid of order) {
      const p = this.people.get(pid);
      if (!p || p.withdrawnAt) continue;
      const song = projectedSongs ? projectedSongs.get(pid) : p.song;
      const duet = song?.duet;
      const owner = duet && duet.state === 'accepted' ? p : null;
      if (owner) {
        const partner = this.people.get(duet.partnerId);
        if (partner && !partner.withdrawnAt) {
          if (!predict) {
            if (!song) continue;
            if (!ignorePresence && this.opts.requirePresence &&
                !(this._confirmedRecently(owner) && this._confirmedRecently(partner))) continue;
          }
          cands.push({ ids: [owner.id, partner.id], consumedIds: [owner.id],
            song, group: owner.group,
            groups: [...new Set([owner.group, partner.group])], at: idx.get(p.id),
            kind: 'duo' });
          continue;
        }
      }
      if (!predict && (!song || duet?.state === 'pending' ||
          (!ignorePresence && this.opts.requirePresence && !this._confirmedRecently(p)))) continue;
      cands.push({ ids: [p.id], consumedIds: [p.id], song, group: p.group, groups: [p.group], at: idx.get(p.id) });
    }
    if (!cands.length) return null;
    // Le tour mesure les personnes réellement montées sur scène, invitées de
    // duo comprises. Un tour neuf commence seulement quand plus aucun titre
    // prêt ne peut présenter une personne qui n'a pas chanté dans ce tour.
    const newPersonRound = cands.every(c => c.ids.every(pid => roundPeople.has(pid)));
    const physicalRound = newPersonRound ? new Set() : roundPeople;
    const withRound = c => {
      // Un duo peut réunir une table déjà servie et une table encore neuve.
      // Ce passage complète alors le tour ; il ne remet pas à zéro les tables
      // restantes. Un nouveau tour ne démarre que si toutes les tables ayant
      // un titre prêt ont déjà été servies dans le tour courant.
      const newGroupRound = newPersonRound || cands.every(candidate =>
        candidate.groups.every(group => roundGroups.has(group)));
      return { ...c, newPersonRound, newGroupRound };
    };
    const reserved = reservation && cands.find(c => c.ids[0] === reservation.personId);
    if (reserved) return withRound(reserved);
    if (this.manualOrderActive) {
      const explicit = cands.filter(c => this.manualOrder.includes(c.ids[0]) &&
        (!projectedSongs || c.song === this.people.get(c.ids[0])?.song))
        .sort((a, b) => this.manualOrder.indexOf(a.ids[0]) - this.manualOrder.indexOf(b.ids[0]));
      if (explicit.length) return withRound(explicit[0]);
    }
    // Le plan Timefold classe tous les titres admissibles. Les garde-fous
    // ci-dessus (prochain annoncé et ordre manuel) et la construction de
    // `cands` (présence, duo accepté, ordre des titres d'un même chanteur)
    // restent impératifs. En l'absence de plan valide, l'heuristique
    // historique ci-dessous assure un fonctionnement hors ligne.
    const solverRanks = this.solverPlan?.version === this.version ? this.solverPlan.ranks : null;
    if (solverRanks) {
      const planned = cands.filter(c => solverRanks.has(c.song?.entryId))
        .sort((a, b) => solverRanks.get(a.song.entryId) - solverRanks.get(b.song.entryId) || a.at - b.at);
      if (planned.length) return withRound(planned[0]);
    }
    // Le ticket de l'invité d'un duo reste intact, mais sa présence sur scène
    // compte pour l'équité. Tant qu'un passage sans chanteur déjà entendu est
    // prêt, personne ne doit revenir (même en duo). Parmi les duos mêlant un
    // nouveau et un ancien, servir d'abord ceux qui présentent un nouveau.
    const appearancesOf = pid => appearances ? (appearances.get(pid) || 0) :
      ((this.people.get(pid)?.sung || 0) + (this.people.get(pid)?.duetGuestCount || 0));
    const untouched = cands.filter(c => c.ids.every(pid => appearancesOf(pid) === 0));
    let choices = untouched.length ? untouched : cands;
    if (!untouched.length) {
      const introducing = cands.filter(c => c.ids.some(pid => appearancesOf(pid) === 0));
      if (introducing.length) {
        // À premier passage égal, un duo avec une personne déjà souvent montée
        // sur scène attend derrière celui dont le partenaire a moins chanté.
        const appearances = c => c.ids.reduce((n, pid) => n + appearancesOf(pid), 0);
        const least = Math.min(...introducing.map(appearances));
        choices = introducing.filter(c => appearances(c) === least);
      }
    }
    // Une fois les premières apparitions de la soirée servies, refaire la
    // même vérification à chaque tour physique. En particulier, un duo déjà
    // entendu ne doit pas passer devant un solo ou duo qui présente encore
    // quelqu'un de ce tour. Parmi ces derniers, préférer deux personnes
    // inédites à un duo où une seule est inédite.
    const physicallyFresh = choices.filter(c => c.ids.every(pid => !physicalRound.has(pid)));
    if (physicallyFresh.length) choices = physicallyFresh;
    else {
      const introducingNow = choices.filter(c => c.ids.some(pid => !physicalRound.has(pid)));
      if (introducingNow.length) {
        const fewestRepeats = Math.min(...introducingNow.map(c =>
          c.ids.filter(pid => physicalRound.has(pid)).length));
        choices = introducingNow.filter(c =>
          c.ids.filter(pid => physicalRound.has(pid)).length === fewestRepeats);
      }
    }
    // Le répit d'un invité évite les passages trop rapprochés seulement entre
    // candidats de même niveau d'équité : il ne retarde pas un premier passage
    // au profit d'une personne déjà montée sur scène.
    const cooled = choices.filter(c => c.ids.every(pid => (cooldowns.get(pid) || 0) <= 0));
    if (cooled.length) choices = cooled;
    // Le tour des tables passe avant le départage par ancienneté individuelle.
    // Après Marine (table 1) puis table 2, table 3 doit chanter avant JP de
    // table 1, même si JP a chanté plus tôt dans la soirée.
    if (!newPersonRound && choices.every(c => c.ids.every(pid => !physicalRound.has(pid)))) {
      const awaitingTable = choices.filter(c => c.groups.some(g => !roundGroups.has(g)));
      if (awaitingTable.length) choices = awaitingTable;
    }
    // Le répit d'une personne ne doit pas faire chanter deux fois de suite la
    // même table alors qu'une autre table de même niveau d'équité est prête.
    const lastTable = new Set(Array.isArray(lastGroup) ? lastGroup : lastGroup ? [lastGroup] : []);
    const otherTable = choices.filter(c => c.groups.every(g => !lastTable.has(g)));
    if (otherTable.length) choices = otherTable;
    // La première apparition de Yannick dans « Yannick & Marine » doit passer
    // avant « Osark & Johnny » quand Marine a chanté au #1 et Johnny au #3.
    // Le tour de l'invité reste intact, mais sa présence physique est réelle.
    const mostRecent = c => Math.max(0, ...c.ids.map(pid =>
      recentTurns ? (recentTurns.get(pid) || 0) :
        (this.people.get(pid)?.lastAppearanceTurn || 0)));
    const oldestRepeat = Math.min(...choices.map(mostRecent));
    choices = choices.filter(c => mostRecent(c) === oldestRepeat);
    const plannedFirst = available => available[0];
    // Le glisser-déposer du bar départage les candidats équitables. Une
    // priorité ponctuelle explicite est déjà traitée par reservedNext ci-dessus.
    const manual = choices.filter(c => this.manualOrder.includes(c.ids[0]) &&
      (!projectedSongs || c.song === this.people.get(c.ids[0])?.song))
      .sort((a, b) => this.manualOrder.indexOf(a.ids[0]) - this.manualOrder.indexOf(b.ids[0]));
    if (manual.length) return withRound(manual[0]);
    if (this.opts.tableRotation) {
      const groups = [...new Set(choices.flatMap(c => c.groups))];
      const last = new Set(Array.isArray(lastGroup) ? lastGroup : lastGroup ? [lastGroup] : []);
      const tableIds = [...this.tables.keys()];
      const rank = group => {
        const p = [...this.people.values()].find(x => x.group === group);
        return p ? tableIds.indexOf(p.tableId) * 100000 + p.joinedAt % 100000 : Number.MAX_SAFE_INTEGER;
      };
      groups.sort((a, b) => rank(a) - rank(b));
      const possible = groups.length > 1 ? groups.filter(g => !last.has(g)) : groups;
      const options = possible.length ? possible : groups;
      let chosenGroup;
      if (this.opts.weightedTables) {
        const readyCount = group => new Set(choices.flatMap(c => c.ids).filter(pid => this.people.get(pid)?.group === group)).size || 1;
        const allZero = groups.every(g => (servedCounts.get(g) || 0) === 0);
        chosenGroup = allZero && !last.size ? groups[0] : options.slice().sort((a, b) => {
          const wa = Math.sqrt(readyCount(a)), wb = Math.sqrt(readyCount(b));
          const debt = (servedCounts.get(a) || 0) / wa - (servedCounts.get(b) || 0) / wb;
          return Math.abs(debt) > 1e-9 ? debt : wb - wa || rank(a) - rank(b);
        })[0];
      } else {
        // Garder le cercle de toutes les tables inscrites. Une table qui vient
        // de passer peut ne plus avoir de titre prêt et ne figure plus dans
        // `groups` ; elle reste pourtant le point de départ de la rotation.
        const circle = [...new Set([...this.people.values()].filter(p => !p.withdrawnAt).map(p => p.group))]
          .sort((a, b) => rank(a) - rank(b));
        const anchor = Array.isArray(lastGroup) ? lastGroup[0] : lastGroup;
        const previous = circle.indexOf(anchor);
        chosenGroup = options.slice().sort((a, b) => {
          const da = (circle.indexOf(a) - previous + circle.length) % circle.length || circle.length;
          const db = (circle.indexOf(b) - previous + circle.length) % circle.length || circle.length;
          return da - db || rank(a) - rank(b);
        })[0];
      }
      const c = plannedFirst(choices.filter(x => x.groups.includes(chosenGroup)));
      return withRound(c);
    }
    const groupWaiting = choices.filter(c => newPersonRound || c.groups.some(g => !roundGroups.has(g)));
    const newGroupRound = newPersonRound || groupWaiting.length === 0;
    const eligible = newGroupRound ? choices : groupWaiting;
    // Au début d'un tour, éviter aussi de faire revenir immédiatement la table
    // de la dernière chanson si une autre table est déjà prête.
    const last = new Set(Array.isArray(lastGroup) ? lastGroup : lastGroup ? [lastGroup] : []);
    const c = plannedFirst(eligible.filter(x => x.groups.every(g => !last.has(g)))) ||
      plannedFirst(eligible);
    return { ...c, newPersonRound, newGroupRound };
  }

  // Renvoie la prochaine chanson à envoyer (sans rien modifier), ou null.
  select() {
    const waitingForPlan = this._maybeRequestSolver();
    if (waitingForPlan && this._solverBlocksNext()) return null;
    if (this.reservedNext) {
      const p = this.people.get(this.reservedNext.personId);
      const duet = p?.song?.duet;
      const guest = duet?.state === 'accepted' ? this.people.get(duet.partnerId) : null;
      if (!p || p.withdrawnAt || !p.song || duet?.state === 'pending' ||
          (duet?.state === 'accepted' && (!guest || guest.withdrawnAt))) {
        this.releaseNext();
      } else if (this.opts.requirePresence && !this.confirmedForTurn(
        guest ? [p.id, guest.id] : [p.id])) {
        // Le prochain annoncé attend sa confirmation. Envoyer C à sa place
        // ferait mentir l'annonce faite à B et à toute la salle.
        return null;
      }
    }
    const c = this._pick(this.Q, this.lastGroup, false,
      this.roundGroups, this.roundPeople, this.tableServeCounts, this.duetCooldowns,
      null, this.reservedNext);
    if (!c) return null;
    const names = c.ids.map(pid => this.people.get(pid).name);
    const tables = [...new Set(c.ids.map(pid => this.table(this.people.get(pid).tableId).name))];
    return { ...c, label: `${names.join(' & ')} · ${tables.join(' + ')}`, names,
      presenceConfirmed: this.opts.requirePresence && this.confirmedForTurn(c.ids) };
  }

  // Le serveur appelle ceci dès qu'il annonce le chanteur suivant pendant la
  // chanson en cours. Les nouvelles tables et changements de rotation ne le
  // déplacent plus. Un départ ou une intervention du bar peuvent le libérer.
  reserveNext() {
    const selected = this.select();
    if (!selected) return null;
    if (!this.reservedNext || this.reservedNext.personId !== selected.ids[0]) {
      this.reservedNext = { personId: selected.ids[0], reservedAt: Date.now() };
      this.solverNextStartedAt = 0;
      this.version++;
    }
    return selected;
  }

  // Réserve le premier titre réellement prêt hors confirmation de présence.
  // Les tickets sans chanson et les duos encore en attente ne figurent pas
  // ici. Une réservation existante reste stable tant que son titre existe.
  reservePresenceNext(excludeIds = [], provisional = null) {
    // En mode confirmation, la réservation annonce effectivement quelqu'un
    // aux clients. Elle attend donc le plan courant comme `select()` ; sinon
    // le nom affiché pourrait changer deux secondes plus tard.
    if (this._maybeRequestSolver() && this._solverBlocksNext()) return null;
    const visible = this.presenceView(excludeIds, provisional).filter(v => !v.future);
    const kept = visible.find(v => v.ids[0] === this.reservedNext?.personId);
    if (kept) return kept;
    if (this.reservedNext) this.releaseNext();
    const first = visible[0];
    if (!first) return null;
    this.reservedNext = { personId: first.ids[0], reservedAt: Date.now() };
    this.solverNextStartedAt = 0;
    this.version++;
    return first;
  }

  releaseNext() {
    if (this.reservedNext) {
      this.reservedNext = null;
      this.solverNextStartedAt = 0;
      this.version++;
    }
  }

  // Simule les titres suivants sans consommer les vrais tickets. Une personne
  // reste dans le cercle tant que sa liste contient un autre titre ; seul
  // `select()` peut envoyer son titre courant à KaraFun.
  _forecast(predict, excludeIds = [], provisional = null, ignorePresence = false) {
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
    let last = this.lastGroup;
    const round = new Set(this.roundGroups);
    const roundPeople = new Set(this.roundPeople);
    const served = new Map(this.tableServeCounts);
    const cooldowns = new Map(this.duetCooldowns);
    const appearances = new Map([...this.people.values()].map(p =>
      [p.id, (p.sung || 0) + (p.duetGuestCount || 0)]));
    const recentTurns = new Map([...this.people.values()].map(p =>
      [p.id, p.lastAppearanceTurn || 0]));
    let appearanceTurn = this.appearanceSerial;
    const slots = [];
    if (provisional) {
      if (provisional.newPersonRound) roundPeople.clear();
      if (provisional.newGroupRound) round.clear();
      provisional.ids.forEach(pid => roundPeople.add(pid));
      (provisional.groups || [provisional.group]).forEach(g => {
        round.add(g); served.set(g, (served.get(g) || 0) + 1);
      });
      this._advanceCooldowns(cooldowns, provisional);
      provisional.ids.forEach(pid => appearances.set(pid, (appearances.get(pid) || 0) + 1));
      appearanceTurn++;
      provisional.ids.forEach(pid => recentTurns.set(pid, appearanceTurn));
      last = provisional.groups || [provisional.group];
    }
    let reservation = this.reservedNext && !pendingIds.has(this.reservedNext.personId) ?
      this.reservedNext : null;
    while (remaining.length) {
      const c = this._pick(remaining, last, predict, round, roundPeople, served,
        cooldowns, songs, reservation, appearances, ignorePresence, recentTurns);
      if (!c) break;
      reservation = null;
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
      if (c.newPersonRound) roundPeople.clear();
      if (c.newGroupRound) round.clear();
      c.ids.forEach(pid => roundPeople.add(pid));
      c.groups.forEach(g => { round.add(g); served.set(g, (served.get(g) || 0) + 1); });
      this._advanceCooldowns(cooldowns, c);
      c.ids.forEach(pid => appearances.set(pid, (appearances.get(pid) || 0) + 1));
      appearanceTurn++;
      c.ids.forEach(pid => recentTurns.set(pid, appearanceTurn));
      last = c.groups;
    }
    if (predict) for (const pid of remaining) slots.push({ ids: [pid], group: (this.people.get(pid) || {}).group });
    return slots;
  }

  // Ordre de tous les passages futurs, avec les titres suivants des listes.
  predict() { this._maybeRequestSolver(); return this._forecast(true); }

  // Uniquement les passages qui disposent déjà d'une chanson. Les tickets
  // sans titre conservent leur place interne, sans créer un faux rang public.
  readyView(excludeIds = [], provisional = null, ignorePresence = false) {
    this._maybeRequestSolver();
    const qIndex = new Map(this.Q.map((pid, i) => [pid, i]));
    const out = [];
    for (const c of this._forecast(false, excludeIds, provisional, ignorePresence)) {
      const owner = this.people.get(c.ids[0]);
      if (!owner) continue;
      const table = this.table(owner.tableId);
      const tables = [...new Set(c.ids.map(pid => this.table(this.people.get(pid).tableId).name))];
      out.push({ ids: c.ids, song: c.song, entryId: c.entryId, future: c.future, kind: c.kind,
        name: c.ids.map(pid => this.people.get(pid)?.name).filter(Boolean).join(' & '),
        table: tables.join(' + ') || table?.name || '', tableId: owner.tableId, qi: qIndex.get(owner.id),
        over: owner.over, cap: this.opts.cap, confirmed: !!this._confirmedRecently(owner) });
    }
    return out;
  }

  presenceView(excludeIds = [], provisional = null) {
    return this.readyView(excludeIds, provisional, true);
  }

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
      tableServeCounts: [...this.tableServeCounts], duetCooldowns: [...this.duetCooldowns],
      qIndex: this.Q.indexOf(sel.ids[0]),
      people: sel.ids.map(pid => {
        const p = this.people.get(pid);
        return p ? { id: pid, sung: p.sung || 0, duetGuestCount: p.duetGuestCount || 0,
          lastAppearanceTurn: p.lastAppearanceTurn || 0, lastSungAt: p.lastSungAt || 0,
          waitingSince: p.waitingSince || 0, confirmedAt: p.confirmedAt || 0,
          over: p.over || 0, held: p.held || 0 } : { id: pid };
      }),
    };
  }

  rollbackUnplayed(sel, { requeue = false } = {}) {
    const credit = sel?.turnCredit;
    if (credit?.rolledBack) return false;
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
        'tableServeCounts', 'duetCooldowns'];
      const current = this._turnCreditState(sel);
      const matches = globals.every(field => JSON.stringify(current[field]) === JSON.stringify(after[field]));
      if (matches) {
        this.appearanceSerial = before.appearanceSerial;
        this.lastGroup = before.lastGroup;
        this.roundPeople = new Set(before.roundPeople);
        this.roundGroups = new Set(before.roundGroups);
        this.tableServeCounts = new Map(before.tableServeCounts);
        this.duetCooldowns = new Map(before.duetCooldowns);
      } else {
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

  // Appelé quand la chanson a bien été ajoutée dans KaraFun.
  commit(sel) {
    const now = Date.now();
    this.manualChanges = [];
    const [first, second] = sel.ids;
    // Ceux qui étaient devant sans être prêts faute de confirmation : on compte, et au 2e raté on recule de 3
    if (this.opts.requirePresence) {
      for (let i = 0; i < sel.at && i < this.Q.length; i++) {
        const q = this.people.get(this.Q[i]);
        if (q && q.song && !this._confirmedRecently(q) && !sel.ids.includes(q.id)) {
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
      if (owner.song && (owner.song.entryId ? owner.song.entryId === sel.song.entryId : owner.song === sel.song)) {
        owner.song = (owner.backlog || []).shift() || null;
      }
    }
    this._refreshDuetViews();
    if (sel.newPersonRound) this.roundPeople.clear();
    if (sel.newGroupRound) this.roundGroups.clear();
    sel.ids.forEach(pid => { if (this.people.has(pid)) this.roundPeople.add(pid); });
    (sel.groups || [sel.group]).forEach(g => {
      this.roundGroups.add(g);
      this.tableServeCounts.set(g, (this.tableServeCounts.get(g) || 0) + 1);
    });
    this.lastGroup = sel.groups || [sel.group];
    this._advanceCooldowns(this.duetCooldowns, sel);
    if (sel.kind === 'duo' && partner) partner.duetGuestCount = (partner.duetGuestCount || 0) + 1;
    this.appearanceSerial++;
    sel.ids.forEach(pid => {
      const p = this.people.get(pid);
      if (p) p.lastAppearanceTurn = this.appearanceSerial;
    });
    this.manualOrder = this.manualOrder.filter(pid => !sel.ids.includes(pid));
    if (!this.manualOrder.length) this.manualOrderActive = false;
    if (this.reservedNext?.personId === sel.ids[0]) this.releaseNext();
    sel.turnCredit = { before: creditBefore, after: this._turnCreditState(sel), rolledBack: false };
    this.note(`À suivre : ${sel.label} — « ${sel.song.title} »`, 'next');
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

module.exports = { Scheduler, DEFAULTS };
