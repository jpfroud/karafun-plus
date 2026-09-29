'use strict';

// Vote pour demander une Battle collective et suivi de sa lecture dans KaraFun.
// Aucun code de télécommande n'est exposé aux participants.
const { randomUUID } = require('node:crypto');

const VOTE_DURATION_MS = 2 * 60 * 1000;
const COOLDOWN_MS = 15 * 60 * 1000;
const MIN_VOTERS = 4;

// Règles du vote : il dure un temps fixe (compte à rebours visible) et se
// décide avec les personnes qui ont voté. Il faut un nombre minimal de
// votants (plafonné au nombre d'inscrits) et plus de voix pour la Battle que
// pour « Pas de Battle ». Le titre le plus voté gagne ; à égalité, le premier
// proposé. Le vote se clôt plus tôt si tout le monde a voté.
class BattleVote {
  constructor({ now = Date.now, voteDurationMs = VOTE_DURATION_MS,
    cooldownMs = COOLDOWN_MS, minVoters = MIN_VOTERS, onChange = () => {}, saved = null } = {}) {
    if (!Number.isSafeInteger(voteDurationMs) || voteDurationMs < 1 ||
        !Number.isSafeInteger(cooldownMs) || cooldownMs < 1) throw new Error('Durées de vote invalides.');
    this.now = now;
    this.voteDurationMs = saved?.voteDurationMs ?? voteDurationMs;
    this.cooldownMs = saved?.cooldownMs ?? cooldownMs;
    this.minVoters = saved?.minVoters ?? minVoters;
    if (!Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 1 ||
        this.cooldownMs > 120 * 60 * 1000) throw new Error('Délai entre Battles invalide.');
    if (!Number.isSafeInteger(this.voteDurationMs) || this.voteDurationMs < 1 ||
        this.voteDurationMs > 10 * 60 * 1000) throw new Error('Durée de vote invalide.');
    if (!Number.isSafeInteger(this.minVoters) || this.minVoters < 1 || this.minVoters > 100) {
      throw new Error('Nombre minimal de votants invalide.');
    }
    this.onChange = onChange;
    if (saved && (![1, 2, 3, 4].includes(saved.version) || (saved.ballot &&
      (!Array.isArray(saved.ballot.eligiblePersonIds) || !Array.isArray(saved.ballot.votes) ||
       saved.ballot.votes.some(vote => !Array.isArray(vote) || vote.length !== 2 || typeof vote[1] !== 'string') ||
       !['voting', 'requested', 'cooldown'].includes(saved.ballot.phase) ||
       (saved.ballot.mode === 'songs' && (!Array.isArray(saved.ballot.songs) ||
         saved.ballot.songs.length < 1 || saved.ballot.songs.length > 3 ||
         saved.ballot.songs.some(song => !Number.isSafeInteger(song?.songId) ||
           song.songId <= 0 || typeof song.title !== 'string' || !song.title.trim()))))))) {
      throw new Error('État de vote Battle invalide.');
    }
    if (saved?.automation && (typeof saved.automation !== 'object' ||
      !['waiting', 'sending', 'queued', 'playing', 'manual', 'after', 'resuming', 'released', 'failed'].includes(saved.automation.status) ||
      typeof saved.automation.ballotId !== 'string' ||
      !Number.isSafeInteger(saved.automation.songId) || saved.automation.songId < 0 ||
      !Array.isArray(saved.automation.before))) throw new Error('Suivi Battle invalide.');
    this.ballot = saved?.ballot ? structuredClone(saved.ballot) : null;
    this.automation = saved?.automation ? structuredClone(saved.automation) : null;
    this.lastOutcome = saved?.lastOutcome || null;
    if (this.ballot?.phase === 'voting' && this.ballot.rule !== 'voters') {
      // Vote ouvert avant la mise à jour : appliquer les nouvelles règles.
      this.ballot.rule = 'voters';
      this.ballot.threshold = Math.min(this.minVoters, this.ballot.eligiblePersonIds.length);
    }
  }

  _battlePending() {
    return !!this.automation && this.automation.status !== 'released' &&
      this.automation.status !== 'after';
  }

  _changed(event) { this.onChange(event, this.viewWithoutTick()); }

  _cooldown(outcome, time) {
    this.ballot.phase = 'cooldown';
    this.ballot.outcome = outcome;
    this.ballot.cooldownUntil = time + this.cooldownMs;
    this.lastOutcome = { id: this.ballot.id, outcome, at: time,
      proposalName: this.ballot.proposalName, selectedSong: this.ballot.selectedSong || null };
    this._changed(outcome);
  }

  tick() {
    const time = this.now();
    if (this.ballot?.phase === 'voting' && time >= this.ballot.closesAt) {
      // Une reprise après panne peut observer la clôture très en retard. La
      // pause commence à l'heure prévue, pas au redémarrage du serveur.
      this._decide(this.ballot.closesAt, 'timer');
    }
    // La pause entre Battles part de la fin de la Battle, pas du vote.
    if (this.ballot?.phase === 'cooldown' && this.ballot.cooldownUntil == null && !this._battlePending()) {
      this.ballot.cooldownUntil = time + this.cooldownMs;
      this.ballot.battleEndedAt = this.ballot.battleEndedAt || time;
      this._changed('cooldown-started');
    }
    if (this.ballot?.phase === 'cooldown' && this.ballot.cooldownUntil != null &&
        time >= this.ballot.cooldownUntil &&
        (!this.automation || this.automation.status === 'released')) {
      this.ballot = null;
      this._changed('idle');
    }
    return this.viewWithoutTick();
  }

  // Décision avec les votes exprimés : nombre minimal de votants, puis plus
  // de voix pour une Battle que contre.
  _decide(time, closedBy) {
    const b = this.ballot;
    const voters = b.votes.length;
    const yes = b.votes.filter(([, answer]) => answer === 'yes' || answer.startsWith('song:')).length;
    b.closedBy = closedBy;
    if (voters >= b.threshold && yes > voters - yes) this._requested(time);
    else this._cooldown(voters < b.threshold ? 'quorum' : closedBy === 'timer' && !voters ? 'expired' : 'rejected', time);
  }

  nextDeadline() {
    this.tick();
    return this.ballot?.phase === 'voting' ? this.ballot.closesAt :
      this.ballot?.phase === 'cooldown' ? this.ballot.cooldownUntil : null;
  }

  propose({ personId, personName, eligiblePersonIds, suggestedSong = null,
    songs, proposerChoice }) {
    this.tick();
    if (this.ballot?.phase === 'voting') throw new Error('Un vote Battle est déjà en cours.');
    if (this.ballot?.phase === 'requested') throw new Error('La demande de Battle attend le bar.');
    if (this.ballot?.phase === 'cooldown') throw new Error('Attends la fin du délai avant un nouveau vote Battle.');
    if (this.automation && this.automation.status !== 'released') {
      throw new Error('La Battle précédente attend encore le bar.');
    }
    if (!Array.isArray(eligiblePersonIds)) throw new Error('Électorat Battle manquant.');
    const eligible = [...new Set(eligiblePersonIds.map(String))];
    const proposer = String(personId || '');
    const name = String(personName || '').trim().slice(0, 80);
    if (!proposer || !name || !eligible.includes(proposer) || eligible.length > 5000 ||
        eligible.some(id => !id)) throw new Error('Proposition Battle non autorisée.');
    let song = null;
    if (suggestedSong != null) {
      const songId = Number(suggestedSong.songId);
      const title = String(suggestedSong.title || '').trim().slice(0, 100);
      if (!Number.isSafeInteger(songId) || songId <= 0 || !title) throw new Error('Titre suggéré invalide.');
      song = { songId, title, artist: String(suggestedSong.artist || '').trim().slice(0, 80) };
    }
    let options = null;
    if (songs !== undefined) {
      if (!Array.isArray(songs) || songs.length < 1 || songs.length > 3) {
        throw new Error('Propose entre un et trois titres pour la Battle.');
      }
      options = songs.map(item => {
        const songId = Number(item?.songId);
        const title = String(item?.title || '').trim();
        const artist = String(item?.artist || '').trim();
        if (!Number.isSafeInteger(songId) || songId <= 0 || !title || title.length > 100 || artist.length > 80) {
          throw new Error('Titre Battle invalide.');
        }
        return { songId, title, artist };
      });
      if (new Set(options.map(item => item.songId)).size !== options.length) {
        throw new Error('Chaque titre Battle doit être différent.');
      }
      const picked = Number(proposerChoice ?? options[0].songId);
      if (!options.some(item => item.songId === picked)) throw new Error('Vote du proposant invalide.');
      proposerChoice = `song:${picked}`;
      song = options[0];
    }
    const time = this.now();
    const threshold = Math.min(this.minVoters, eligible.length);
    this.ballot = { id: randomUUID(), phase: 'voting', proposalName: name, rule: 'voters',
      proposerId: proposer, suggestedSong: song, songs: options, mode: options ? 'songs' : 'legacy',
      selectedSong: null, eligiblePersonIds: eligible,
      votes: [[proposer, options ? proposerChoice : 'yes']], threshold, openedAt: time,
      closesAt: time + this.voteDurationMs, requestedAt: null,
      cooldownUntil: null, outcome: null, resolvedAt: null };
    if (eligible.length === 1) this._decide(time, 'all-voted');
    else this._changed('proposed');
    return this.view();
  }

  // Le bar lance directement une Battle sur le titre de son choix, sans vote
  // ni délai. La pause entre Battles démarrera à la fin de celle-ci.
  staffLaunch({ song }) {
    this.tick();
    if (this.automation && !['released', 'after'].includes(this.automation.status)) {
      throw new Error('Une Battle est déjà en préparation ou en cours.');
    }
    const songId = Number(song?.songId);
    const title = String(song?.title || '').trim();
    const artist = String(song?.artist || '').trim();
    if (!Number.isSafeInteger(songId) || songId <= 0 || !title || title.length > 100 || artist.length > 80) {
      throw new Error('Titre Battle invalide.');
    }
    const time = this.now();
    const chosen = { songId, title, artist };
    this.ballot = { id: randomUUID(), phase: 'requested', proposalName: 'Le bar', rule: 'staff',
      proposerId: null, suggestedSong: chosen, songs: [chosen], mode: 'staff',
      selectedSong: chosen, eligiblePersonIds: [], votes: [], threshold: 0, openedAt: time,
      closesAt: null, requestedAt: time, cooldownUntil: null, outcome: 'approved', resolvedAt: null };
    this.automation = { ballotId: this.ballot.id, songId, status: 'waiting', before: [],
      sentAt: null, queueId: null, failure: null };
    this.lastOutcome = { id: this.ballot.id, outcome: 'approved', at: time,
      proposalName: 'Le bar', selectedSong: chosen };
    this._changed('staff-launch');
    return this.view();
  }

  closeNow() {
    this.tick();
    if (this.ballot?.phase !== 'voting') throw new Error('Aucun vote Battle ouvert.');
    this._decide(this.now(), 'staff');
    return this.view();
  }

  _requested(time) {
    if (this.ballot.mode === 'songs') {
      const scores = this.ballot.songs.map((song, index) => ({ song, index,
        votes: this.ballot.votes.filter(([, answer]) => answer === `song:${song.songId}`).length }));
      scores.sort((a, b) => b.votes - a.votes || a.index - b.index);
      this.ballot.selectedSong = scores[0].song;
    } else this.ballot.selectedSong = this.ballot.suggestedSong || null;
    this.ballot.phase = 'requested';
    this.automation = { ballotId: this.ballot.id, songId: this.ballot.selectedSong?.songId || 0,
      status: 'waiting', before: [], sentAt: null, queueId: null, failure: null };
    this.ballot.requestedAt = time;
    this.ballot.cooldownUntil = null; // fixée à la fin de la Battle
    this.ballot.outcome = 'approved';
    this.lastOutcome = { id: this.ballot.id, outcome: 'approved', at: time,
      proposalName: this.ballot.proposalName, selectedSong: this.ballot.selectedSong };
    this._changed('requested');
  }


  vote({ personId, choice }) {
    this.tick();
    const b = this.ballot;
    if (!b || b.phase !== 'voting') throw new Error('Aucun vote Battle ouvert.');
    const id = String(personId || '');
    if (!b.eligiblePersonIds.includes(id)) throw new Error('Cette personne ne peut pas voter.');
    if (b.votes.some(([voter]) => voter === id)) throw new Error('Cette personne a déjà voté.');
    if (b.mode === 'songs') {
      if (choice === 'none') choice = 'none';
      else {
        const chosenId = Number(choice);
        if (!Number.isSafeInteger(chosenId) || !b.songs.some(song => song.songId === chosenId)) {
          throw new Error('Vote Battle invalide.');
        }
        choice = `song:${chosenId}`;
      }
    } else if (choice !== 'yes' && choice !== 'no') throw new Error('Vote Battle invalide.');
    b.votes.push([id, choice]);
    if (b.votes.length === b.eligiblePersonIds.length) this._decide(this.now(), 'all-voted');
    else this._changed('voted');
    return this.view();
  }

  resolve({ outcome }) {
    this.tick();
    if (!this.ballot || this.ballot.phase !== 'requested') throw new Error('Aucune Battle à traiter par le bar.');
    if (outcome !== 'done' && outcome !== 'dismissed') throw new Error('Résolution Battle invalide.');
    if (this.automation?.status === 'sending') {
      throw new Error('Attends la réponse de KaraFun avant de traiter cette Battle.');
    }
    const time = this.now();
    if (this.automation) {
      if (outcome === 'dismissed') this.automation.status = 'released';
      else if (['waiting', 'failed'].includes(this.automation.status)) {
        this.automation.status = 'manual';
        this.automation.manualStartedAt = time;
      }
    }
    this.ballot.phase = 'cooldown';
    this.ballot.outcome = outcome;
    this.ballot.resolvedAt = time;
    // Une Battle encore à jouer fixera la pause à sa fin (voir tick).
    this.ballot.cooldownUntil = this._battlePending() ? null : time + this.cooldownMs;
    this.lastOutcome = { id: this.ballot.id, outcome, at: time,
      proposalName: this.ballot.proposalName, selectedSong: this.ballot.selectedSong || null };
    this._changed(outcome);
    return this.view();
  }

  beginAutomation(before) {
    if (this.ballot?.phase !== 'requested' || this.automation?.status !== 'waiting' ||
      !Array.isArray(before) || before.some(id => typeof id !== 'string')) {
      throw new Error('La Battle ne peut pas être préparée.');
    }
    this.automation.before = [...before];
    this.automation.sentAt = this.now();
    this.automation.status = 'sending';
    this._changed('automation-sending');
  }

  confirmAutomation(queueId) {
    if (this.ballot?.phase !== 'requested' ||
      !['waiting', 'sending', 'failed'].includes(this.automation?.status) || queueId == null) {
      throw new Error('Confirmation Battle inattendue.');
    }
    this.automation.queueId = String(queueId);
    this.automation.status = 'queued';
    return this.resolve({ outcome: 'done' });
  }

  confirmManualAutomation(queueId) {
    if (this.ballot?.phase !== 'cooldown' || this.automation?.status !== 'manual' || queueId == null) {
      throw new Error('Confirmation Battle manuelle inattendue.');
    }
    this.automation.queueId = String(queueId);
    this.automation.status = 'queued';
    this._changed('automation-manual-confirmed');
    return this.view();
  }

  finishManual() {
    if (this.ballot?.phase !== 'cooldown' || this.automation?.status !== 'manual') {
      throw new Error('Aucune Battle manuelle en cours.');
    }
    return this.updateAutomation('after');
  }

  observeExternalBattle({ queueId, songId, title, artist }) {
    if (queueId == null || String(queueId) === '') throw new Error('Identifiant de Battle manquant.');
    const time = this.now();
    const id = randomUUID();
    const song = { songId: Number.isSafeInteger(Number(songId)) ? Number(songId) : 0,
      title: String(title || 'Battle collective').slice(0, 100),
      artist: String(artist || '').slice(0, 80) };
    // Une Battle organisée dans KaraFun prime sur un vote encore ouvert :
    // il ne faut ni envoyer une seconde Battle, ni relancer l'autoplay après elle.
    this.ballot = { id, phase: 'cooldown', mode: 'external', proposalName: 'Le bar',
      proposerId: null, suggestedSong: song, songs: null, selectedSong: song,
      eligiblePersonIds: [], votes: [], threshold: 0, openedAt: time,
      closesAt: null, requestedAt: time, resolvedAt: time,
      cooldownUntil: null, outcome: 'done' };
    this.automation = { ballotId: id, songId: song.songId, status: 'queued',
      before: [], sentAt: null, queueId: String(queueId), failure: null };
    this.lastOutcome = { id, outcome: 'done', at: time,
      proposalName: 'Le bar', selectedSong: song };
    this._changed('external');
    return this.view();
  }

  updateAutomation(status, failure = null) {
    if (!this.automation || !['playing', 'after', 'resuming', 'released', 'failed'].includes(status)) {
      throw new Error('Transition Battle invalide.');
    }
    const allowed = {
      waiting: ['failed'],
      sending: ['failed'], queued: ['playing', 'after', 'failed'],
      playing: ['after'], manual: ['after'], after: ['resuming', 'released'],
      resuming: ['released'], failed: ['after', 'released'],
    };
    if (!(allowed[this.automation.status] || []).includes(status)) {
      throw new Error('Transition Battle inattendue.');
    }
    this.automation.status = status;
    this.automation.failure = status === 'failed' ? String(failure || 'KaraFun n’a pas confirmé le mode Battle.') : null;
    if ((status === 'after' || status === 'released') && this.ballot?.phase === 'cooldown' &&
        this.ballot.cooldownUntil == null) {
      const time = this.now();
      this.ballot.battleEndedAt = time;
      this.ballot.cooldownUntil = time + this.cooldownMs;
    }
    this._changed(`automation-${status}`);
    return this.view();
  }

  setCooldownMinutes(minutes) {
    const value = Number(minutes);
    if (!Number.isInteger(value) || value < 1 || value > 120) {
      throw new Error('Le délai entre Battles doit être de 1 à 120 minutes.');
    }
    if (this.cooldownMs === value * 60 * 1000) return this.view();
    this.cooldownMs = value * 60 * 1000;
    if (this.ballot?.phase === 'cooldown' && this.ballot.cooldownUntil != null) {
      const base = this.ballot.battleEndedAt || this.ballot.resolvedAt || this.lastOutcome?.at || this.now();
      this.ballot.cooldownUntil = base + this.cooldownMs;
    }
    this._changed('settings');
    return this.view();
  }

  setVoteMinutes(minutes) {
    const value = Number(minutes);
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      throw new Error('La durée du vote doit être de 1 à 10 minutes.');
    }
    this.voteDurationMs = value * 60 * 1000;
    this._changed('settings');
    return this.view();
  }

  setMinVoters(count) {
    const value = Number(count);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new Error('Le nombre minimal de votants doit être de 1 à 100.');
    }
    this.minVoters = value;
    this._changed('settings');
    return this.view();
  }

  reset() {
    this.ballot = null;
    this.automation = null;
    this.lastOutcome = null;
    this._changed('reset');
  }

  viewWithoutTick() {
    const b = this.ballot;
    if (!b) return { phase: 'idle', yesVotes: 0, noVotes: 0, eligible: 0,
      threshold: 0, voters: 0, minVoters: this.minVoters, voteMinutes: this.voteDurationMs / 60000,
      closesAt: null, cooldownUntil: null, requestedAt: null,
      cooldownMinutes: this.cooldownMs / 60000,
      proposalName: null, suggestedSong: null, selectedSong: null, songOptions: [],
      mode: null, eligiblePersonIds: [],
      votedPersonIds: [], lastOutcome: this.lastOutcome,
      automation: this.automation ? { status: this.automation.status,
        queueId: this.automation.queueId, failure: this.automation.failure } : null };
    const songOptions = (b.songs || []).map(song => ({ ...song,
      votes: b.votes.filter(([, choice]) => choice === `song:${song.songId}`).length }));
    return { id: b.id, phase: b.phase, proposalName: b.proposalName,
      mode: b.mode || 'legacy', suggestedSong: b.suggestedSong,
      selectedSong: b.selectedSong || null, songOptions,
      yesVotes: b.votes.filter(([, v]) => v === 'yes' || v.startsWith('song:')).length,
      noVotes: b.votes.filter(([, v]) => v === 'no' || v === 'none').length,
      eligible: b.eligiblePersonIds.length, threshold: b.threshold, voters: b.votes.length,
      minVoters: this.minVoters, voteMinutes: this.voteDurationMs / 60000,
      battlePending: this._battlePending(), closedBy: b.closedBy || null,
      closesAt: b.closesAt, cooldownUntil: b.cooldownUntil,
      requestedAt: b.requestedAt, outcome: b.outcome,
      cooldownMinutes: this.cooldownMs / 60000,
      eligiblePersonIds: [...b.eligiblePersonIds],
      votedPersonIds: b.votes.map(([id]) => id), lastOutcome: this.lastOutcome,
      automation: this.automation ? { status: this.automation.status,
        queueId: this.automation.queueId, failure: this.automation.failure } : null };
  }

  view() { this.tick(); return this.viewWithoutTick(); }

  serialize() {
    this.tick();
    return { version: 4, cooldownMs: this.cooldownMs, voteDurationMs: this.voteDurationMs,
      minVoters: this.minVoters,
      ballot: this.ballot ? structuredClone(this.ballot) : null,
      automation: this.automation ? structuredClone(this.automation) : null,
      lastOutcome: this.lastOutcome ? { ...this.lastOutcome } : null };
  }
}

module.exports = { BattleVote, VOTE_DURATION_MS, COOLDOWN_MS, MIN_VOTERS };
