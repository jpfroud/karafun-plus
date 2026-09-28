'use strict';
const assert = require('node:assert/strict');
const { BattleVote, COOLDOWN_MS } = require('../battle-vote');

assert.equal(COOLDOWN_MS, 15 * 60_000, 'le délai Battle par défaut est quinze minutes');
assert.equal(new BattleVote().view().cooldownMinutes, 15);

function fixture() {
  let time = 1_000_000;
  const events = [];
  const opts = { now: () => time, voteDurationMs: 120_000,
    cooldownMs: 600_000, onChange: event => events.push(event) };
  return { opts, events, clock: ms => { time += ms; } };
}

{
  const f = fixture(), vote = new BattleVote(f.opts);
  const electorate = ['a', 'b', 'c', 'd'];
  let state = vote.propose({ personId: 'a', personName: 'Alice', eligiblePersonIds: electorate });
  assert.equal(state.phase, 'voting');
  assert.deepEqual([state.yesVotes, state.eligible, state.threshold], [1, 4, 3]);
  assert.deepEqual(state.votedPersonIds, ['a']);
  assert.throws(() => vote.propose({ personId: 'b', personName: 'Bob', eligiblePersonIds: electorate }), /déjà en cours/);
  assert.throws(() => vote.vote({ personId: 'x', choice: 'yes' }), /ne peut pas voter/);
  assert.throws(() => vote.vote({ personId: 'a', choice: 'no' }), /déjà voté/);
  assert.throws(() => vote.vote({ personId: 'b', choice: 'maybe' }), /invalide/);
  state = vote.vote({ personId: 'b', choice: 'yes' });
  assert.equal(state.phase, 'voting');
  state = vote.vote({ personId: 'c', choice: 'yes' });
  assert.equal(state.phase, 'requested');
  assert.equal(state.requestedAt, 1_000_000);
  assert.equal(state.yesVotes, 3);
  assert.ok(f.events.includes('requested'), 'une notification staff doit partir');
  assert.throws(() => vote.vote({ personId: 'd', choice: 'no' }), /Aucun vote/);
  f.clock(700_000);
  assert.equal(vote.view().phase, 'requested', 'la demande reste visible au bar jusqu’à résolution');
  state = vote.resolve({ outcome: 'done' });
  assert.equal(state.phase, 'cooldown');
  assert.equal(state.cooldownUntil, 2_300_000);
  assert.throws(() => vote.propose({ personId: 'a', personName: 'Alice', eligiblePersonIds: electorate }), /délai/);
  f.clock(600_000);
  assert.equal(vote.view().phase, 'idle');
  assert.equal(vote.view().lastOutcome.outcome, 'done');
}

{
  const f = fixture(), vote = new BattleVote(f.opts);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a', 'b', 'c', 'd', 'e'] });
  vote.vote({ personId: 'b', choice: 'no' });
  vote.vote({ personId: 'c', choice: 'no' });
  let state = vote.vote({ personId: 'd', choice: 'no' });
  assert.equal(state.phase, 'cooldown', 'le refus est acté dès que la majorité devient impossible');
  assert.equal(state.outcome, 'rejected');
  assert.equal(state.cooldownUntil, 1_600_000);
  f.clock(599_999); assert.equal(vote.view().phase, 'cooldown');
  f.clock(1); assert.equal(vote.view().phase, 'idle');
}

{
  const f = fixture(), vote = new BattleVote(f.opts);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a', 'b', 'c'] });
  f.clock(120_000);
  assert.equal(vote.view().outcome, 'expired');
  assert.equal(vote.view().phase, 'cooldown');
  assert.throws(() => vote.vote({ personId: 'b', choice: 'yes' }), /Aucun vote/);
}

{
  const f = fixture(), vote = new BattleVote(f.opts);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a', 'b', 'c'] });
  const saved = vote.serialize();
  f.clock(800_000); // Le serveur est resté arrêté bien après vote + pause.
  const resumed = new BattleVote({ ...f.opts, saved });
  assert.equal(resumed.view().phase, 'idle', 'la pause expirée ne recommence pas au redémarrage');
  assert.equal(resumed.view().lastOutcome.at, 1_120_000, 'la clôture garde son heure réelle');
}

{
  const f = fixture();
  const vote = new BattleVote(f.opts);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a', 'b', 'c'],
    suggestedSong: { songId: 42, title: 'Un titre', artist: 'Une artiste' } });
  const resumed = new BattleVote({ ...f.opts, saved: vote.serialize() });
  assert.equal(resumed.view().suggestedSong.songId, 42);
  assert.deepEqual(resumed.view().eligiblePersonIds, ['a', 'b', 'c']);
  assert.throws(() => resumed.vote({ personId: 'a', choice: 'yes' }), /déjà voté/);
  assert.equal(resumed.vote({ personId: 'b', choice: 'yes' }).phase, 'requested');
  const resumedAgain = new BattleVote({ ...f.opts, saved: resumed.serialize() });
  assert.equal(resumedAgain.resolve({ outcome: 'dismissed' }).phase, 'cooldown');
  assert.throws(() => resumedAgain.propose({ personId: 'c', personName: 'C', eligiblePersonIds: ['a', 'b', 'c'] }), /délai/);
}

{
  const f = fixture(), vote = new BattleVote(f.opts);
  // Un même téléphone peut gérer plusieurs chanteurs ; le vote reste par ID.
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a', 'b', 'c', 'c'] });
  assert.equal(vote.view().eligible, 3);
  assert.equal(vote.vote({ personId: 'b', choice: 'yes' }).phase, 'requested');
  assert.equal(vote.view().threshold, 2);
}

{
  const f = fixture(), vote = new BattleVote(f.opts);
  assert.throws(() => vote.setCooldownMinutes(0), /1 à 120/);
  assert.throws(() => vote.setCooldownMinutes(121), /1 à 120/);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a'] });
  vote.resolve({ outcome: 'done' });
  assert.equal(vote.setCooldownMinutes(3).cooldownUntil, 1_180_000,
    'changer le délai recalcule immédiatement la pause en cours');
  const restored = new BattleVote({ ...f.opts, saved: vote.serialize() });
  assert.equal(restored.cooldownMs, 180_000, 'réglage conservé après redémarrage');
  f.clock(180_000);
  assert.equal(restored.view().phase, 'idle');
  restored.reset();
  assert.equal(restored.view().lastOutcome, null);
}

{
  const f = fixture(), vote = new BattleVote(f.opts);
  const songs = [
    { songId: 101, title: 'Premier', artist: 'Artiste A' },
    { songId: 202, title: 'Deuxième', artist: 'Artiste B' },
    { songId: 303, title: 'Troisième', artist: 'Artiste C' },
  ];
  let state = vote.propose({ personId: 'a', personName: 'Alice',
    eligiblePersonIds: ['a', 'b', 'c', 'd', 'e'], songs, proposerChoice: 101 });
  assert.equal(state.mode, 'songs');
  assert.deepEqual(state.songOptions.map(song => song.votes), [1, 0, 0]);
  assert.equal(state.threshold, 3, 'majorité de toutes les personnes inscrites');
  assert.throws(() => vote.vote({ personId: 'b', choice: 999 }), /invalide/);
  assert.throws(() => vote.vote({ personId: 'b', choice: 'yes' }), /invalide/);
  vote.vote({ personId: 'b', choice: 202 });
  state = vote.vote({ personId: 'c', choice: 202 });
  assert.equal(state.phase, 'voting', 'le titre gagnant reste ouvert tant que le vote peut basculer');
  assert.equal(state.yesVotes, 3);
  state = vote.vote({ personId: 'd', choice: 'none' });
  assert.equal(state.noVotes, 1, 'Pas de Battle est un vote contre, non une abstention');
  state = vote.vote({ personId: 'e', choice: 303 });
  assert.equal(state.phase, 'requested');
  assert.equal(state.selectedSong.songId, 202);
  assert.deepEqual(state.songOptions.map(song => song.votes), [1, 2, 1]);
  assert.ok(f.events.includes('requested'));
  const resumed = new BattleVote({ ...f.opts, saved: vote.serialize() });
  assert.equal(resumed.view().selectedSong.title, 'Deuxième');
  assert.equal(resumed.resolve({ outcome: 'done' }).phase, 'cooldown');
}

{
  const songs = [{ songId: 1, title: 'A' }, { songId: 2, title: 'B' }];
  const f = fixture(), vote = new BattleVote(f.opts);
  for (const invalid of [[], [...songs, songs[0], songs[1]], [songs[0], songs[0]],
    [{ songId: 0, title: 'Invalide' }], [{ songId: 3, title: '' }]]) {
    assert.throws(() => vote.propose({ personId: 'a', personName: 'Alice',
      eligiblePersonIds: ['a', 'b'], songs: invalid }), /titre|titres|différent/i);
  }
  assert.throws(() => vote.propose({ personId: 'a', personName: 'Alice',
    eligiblePersonIds: ['a', 'b'], songs, proposerChoice: 99 }), /proposant invalide/);
  vote.propose({ personId: 'a', personName: 'Alice', eligiblePersonIds: ['a', 'b', 'c'], songs });
  vote.vote({ personId: 'b', choice: 2 });
  const state = vote.vote({ personId: 'c', choice: 'none' });
  assert.equal(state.selectedSong.songId, 1, 'égalité de titres : premier titre proposé retenu');
}

{
  const songs = [{ songId: 1, title: 'A' }];
  const f = fixture(), vote = new BattleVote(f.opts);
  vote.propose({ personId: 'a', personName: 'Alice', eligiblePersonIds: ['a', 'b', 'c', 'd', 'e'], songs });
  vote.vote({ personId: 'b', choice: 'none' });
  vote.vote({ personId: 'c', choice: 'none' });
  assert.equal(vote.vote({ personId: 'd', choice: 'none' }).outcome, 'rejected',
    'la majorité est devenue impossible');
  const second = new BattleVote(f.opts);
  second.propose({ personId: 'a', personName: 'Alice', eligiblePersonIds: ['a', 'b', 'c', 'd', 'e'], songs });
  second.vote({ personId: 'b', choice: 1 });
  second.vote({ personId: 'c', choice: 1 });
  assert.equal(second.view().phase, 'voting');
  f.clock(120_000);
  assert.equal(second.view().phase, 'requested', 'majorité positive au délai malgré deux abstentions');
  assert.equal(second.view().selectedSong.songId, 1);
}

console.log('Battle collective : vote par titre, contre, majorité, délai et reprise OK');
