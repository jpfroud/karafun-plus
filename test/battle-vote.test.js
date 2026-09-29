'use strict';
const assert = require('node:assert/strict');
const { BattleVote, COOLDOWN_MS, MIN_VOTERS } = require('../battle-vote');

assert.equal(COOLDOWN_MS, 15 * 60_000, 'le délai Battle par défaut est quinze minutes');
assert.equal(MIN_VOTERS, 5, 'cinq votants au minimum par défaut');
assert.equal(new BattleVote().view().cooldownMinutes, 15);
assert.equal(new BattleVote().view().voteMinutes, 5, 'vote de cinq minutes par défaut');

function fixture(extra = {}) {
  let time = 1_000_000;
  const events = [];
  const opts = { now: () => time, voteDurationMs: 120_000, minVoters: 3,
    cooldownMs: 600_000, onChange: event => events.push(event), ...extra };
  return { opts, events, clock: ms => { time += ms; }, time: () => time };
}

{
  // Le vote ne reste plus bloqué jusqu'au dernier votant : au bout du délai,
  // on décide avec ceux qui ont voté.
  const f = fixture(), vote = new BattleVote(f.opts);
  const electorate = ['a', 'b', 'c', 'd', 'e', 'f'];
  let state = vote.propose({ personId: 'a', personName: 'Alice', eligiblePersonIds: electorate });
  assert.equal(state.phase, 'voting');
  assert.deepEqual([state.yesVotes, state.eligible, state.threshold, state.voters], [1, 6, 3, 1]);
  assert.throws(() => vote.propose({ personId: 'b', personName: 'Bob', eligiblePersonIds: electorate }), /déjà en cours/);
  assert.throws(() => vote.vote({ personId: 'x', choice: 'yes' }), /ne peut pas voter/);
  assert.throws(() => vote.vote({ personId: 'a', choice: 'no' }), /déjà voté/);
  assert.throws(() => vote.vote({ personId: 'b', choice: 'maybe' }), /invalide/);
  vote.vote({ personId: 'b', choice: 'yes' });
  state = vote.vote({ personId: 'c', choice: 'no' });
  assert.equal(state.phase, 'voting', 'le vote attend la fin du minuteur');
  f.clock(119_999);
  assert.equal(vote.view().phase, 'voting');
  f.clock(1);
  state = vote.view();
  assert.equal(state.phase, 'requested', '3 votants, 2 pour la Battle contre 1 : accepté sans les absents');
  assert.equal(state.requestedAt, 1_120_000);
  assert.equal(state.cooldownUntil, null, 'la pause ne démarre pas avant la Battle elle-même');
  assert.ok(f.events.includes('requested'), 'une notification staff doit partir');
  assert.throws(() => vote.vote({ personId: 'd', choice: 'no' }), /Aucun vote/);
  f.clock(700_000);
  assert.equal(vote.view().phase, 'requested', 'la demande reste visible au bar jusqu’à résolution');
  state = vote.resolve({ outcome: 'done' });
  assert.equal(state.phase, 'cooldown');
  assert.equal(state.cooldownUntil, null, 'Battle manuelle pas encore jouée : pas de compte à rebours');
  assert.throws(() => vote.propose({ personId: 'a', personName: 'Alice', eligiblePersonIds: electorate }), /délai/);
  assert.equal(state.automation.status, 'manual', 'organiser une Battle manuelle ne relance pas la file');
  f.clock(300_000);
  state = vote.finishManual();
  assert.equal(state.automation.status, 'after', 'seule la fin annoncée autorise la reprise manuelle');
  assert.equal(state.cooldownUntil, f.time() + 600_000, 'le délai entre Battles part de la fin de la Battle');
  vote.updateAutomation('resuming');
  vote.updateAutomation('released');
  f.clock(599_999);
  assert.equal(vote.view().phase, 'cooldown');
  f.clock(1);
  assert.equal(vote.view().phase, 'idle');
  assert.equal(vote.view().lastOutcome.outcome, 'done');
}

{
  // Nombre minimal de votants : deux personnes ne déclenchent pas une Battle
  // dans une salle de dix.
  const f = fixture(), vote = new BattleVote(f.opts);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: 'abcdefghij'.split('') });
  vote.vote({ personId: 'b', choice: 'yes' });
  f.clock(120_000);
  const state = vote.view();
  assert.equal(state.phase, 'cooldown');
  assert.equal(state.outcome, 'quorum', 'deux votes pour, mais moins de trois votants');
  assert.equal(state.cooldownUntil, 1_720_000, 'échec du vote : pause à partir de la clôture');
  assert.ok(f.events.includes('quorum'));
}

{
  // Majorité parmi les votants ; tout le monde a voté : décision immédiate.
  const f = fixture(), vote = new BattleVote(f.opts);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a', 'b', 'c', 'd', 'e'] });
  vote.vote({ personId: 'b', choice: 'no' });
  vote.vote({ personId: 'c', choice: 'no' });
  vote.vote({ personId: 'd', choice: 'yes' });
  const state = vote.vote({ personId: 'e', choice: 'no' });
  assert.equal(state.phase, 'cooldown', 'dernier votant : le vote se clôt sans attendre le minuteur');
  assert.equal(state.outcome, 'rejected', '2 pour, 3 contre');
  assert.equal(state.cooldownUntil, 1_600_000);
  f.clock(599_999); assert.equal(vote.view().phase, 'cooldown');
  f.clock(1); assert.equal(vote.view().phase, 'idle');
}

{
  // Personne n'a rejoint le vote : le proposant seul ne suffit pas.
  const f = fixture(), vote = new BattleVote(f.opts);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a', 'b', 'c'] });
  f.clock(120_000);
  assert.equal(vote.view().outcome, 'quorum');
  assert.equal(vote.view().phase, 'cooldown');
  assert.throws(() => vote.vote({ personId: 'b', choice: 'yes' }), /Aucun vote/);
}

{
  // Moins d'inscrits que le minimum de votants : pas de vote possible
  // (le bar peut toujours lancer une Battle).
  const f = fixture(), vote = new BattleVote(f.opts);
  assert.throws(() => vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a', 'b'] }),
    /à partir de 3 personnes/);
  assert.equal(vote.view().phase, 'idle');
  const state = vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a', 'b', 'c'] });
  assert.equal(state.threshold, 3, 'le minimum n’est plus abaissé au nombre d’inscrits');
  vote.vote({ personId: 'b', choice: 'no' });
  assert.equal(vote.vote({ personId: 'c', choice: 'no' }).outcome, 'rejected');
  const byDefault = new BattleVote();
  assert.throws(() => byDefault.propose({ personId: 'a', personName: 'A', eligiblePersonIds: 'abcd'.split('') }),
    /à partir de 5 personnes/, 'par défaut, il faut cinq inscrits');
  assert.equal(byDefault.propose({ personId: 'a', personName: 'A', eligiblePersonIds: 'abcde'.split('') }).threshold, 5);
}

{
  // Le bar peut clore le vote à tout moment.
  const f = fixture(), vote = new BattleVote(f.opts);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: 'abcdef'.split('') });
  vote.vote({ personId: 'b', choice: 'yes' });
  vote.vote({ personId: 'c', choice: 'yes' });
  assert.equal(vote.closeNow().phase, 'requested');
  assert.throws(() => vote.closeNow(), /Aucun vote/);
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
  resumed.vote({ personId: 'b', choice: 'yes' });
  assert.equal(resumed.vote({ personId: 'c', choice: 'yes' }).phase, 'requested');
  const resumedAgain = new BattleVote({ ...f.opts, saved: resumed.serialize() });
  const dismissed = resumedAgain.resolve({ outcome: 'dismissed' });
  assert.equal(dismissed.phase, 'cooldown');
  assert.equal(dismissed.cooldownUntil, f.time() + 600_000, 'Battle annulée : la pause part de l’annulation');
  assert.throws(() => resumedAgain.propose({ personId: 'c', personName: 'C', eligiblePersonIds: ['a', 'b', 'c'] }), /délai/);
}

{
  const f = fixture(), vote = new BattleVote(f.opts);
  // Un même téléphone peut gérer plusieurs chanteurs ; le vote reste par ID.
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a', 'b', 'c', 'c'] });
  assert.equal(vote.view().eligible, 3);
  vote.vote({ personId: 'b', choice: 'yes' });
  assert.equal(vote.vote({ personId: 'c', choice: 'yes' }).phase, 'requested');
}

{
  const f = fixture({ minVoters: 1 }), vote = new BattleVote(f.opts);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a'],
    songs: [{ songId: 5091, title: 'Battle', artist: 'Test' }] });
  vote.beginAutomation(['titre-deja-present']);
  const restored = new BattleVote({ ...f.opts, saved: vote.serialize() });
  assert.equal(restored.view().phase, 'requested');
  assert.equal(restored.view().automation.status, 'sending');
  assert.deepEqual(restored.automation.before, ['titre-deja-present']);
  assert.throws(() => restored.beginAutomation([]), /ne peut pas être préparée/,
    'une reprise après panne ne renvoie pas automatiquement la Battle');
  restored.confirmAutomation('battle-confirmee');
  assert.equal(restored.view().phase, 'cooldown');
  assert.equal(restored.view().cooldownUntil, null, 'Battle prête mais pas jouée');
  assert.equal(restored.view().automation.queueId, 'battle-confirmee');
  const afterAck = new BattleVote({ ...f.opts, saved: restored.serialize() });
  assert.equal(afterAck.view().automation.status, 'queued', 'le mode confirmé persiste après un autre crash');
}

{
  const f = fixture(), vote = new BattleVote(f.opts);
  vote.observeExternalBattle({ queueId: 'native-1', songId: 5091,
    title: 'Battle organisée dans KaraFun', artist: 'Artiste' });
  assert.equal(vote.view().automation.status, 'queued');
  assert.equal(vote.view().phase, 'cooldown');
  assert.equal(vote.view().cooldownUntil, null, 'une Battle native démarre la pause à sa fin');
  const recovered = new BattleVote({ ...f.opts, saved: vote.serialize() });
  assert.equal(recovered.view().automation.queueId, 'native-1',
    'une Battle native reste surveillée après redémarrage');
  recovered.updateAutomation('playing');
  f.clock(240_000);
  recovered.updateAutomation('after');
  assert.equal(recovered.view().cooldownUntil, f.time() + 600_000);
  f.clock(700_000);
  assert.equal(recovered.view().phase, 'cooldown',
    'la pause de sécurité persiste tant que le bar n’a pas relancé la file');
  recovered.updateAutomation('resuming');
  recovered.updateAutomation('released');
  assert.equal(recovered.view().phase, 'idle');
}

{
  // Lancement direct par le bar : sans vote ni délai, pause après la Battle.
  const f = fixture(), vote = new BattleVote(f.opts);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a', 'b', 'c', 'd'] });
  let state = vote.staffLaunch({ song: { songId: 77, title: 'Titre du bar', artist: 'Artiste' } });
  assert.equal(state.phase, 'requested', 'un vote en cours est remplacé par la décision du bar');
  assert.equal(state.mode, 'staff');
  assert.equal(state.selectedSong.songId, 77);
  assert.equal(state.automation.status, 'waiting');
  assert.ok(f.events.includes('staff-launch'));
  assert.throws(() => vote.staffLaunch({ song: { songId: 78, title: 'Autre' } }), /déjà en préparation/);
  vote.beginAutomation([]);
  vote.confirmAutomation('battle-bar');
  vote.updateAutomation('playing');
  f.clock(200_000);
  state = vote.updateAutomation('after');
  assert.equal(state.cooldownUntil, f.time() + 600_000);
  assert.throws(() => vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a', 'b'] }), /Battle précédente|délai/);
  vote.updateAutomation('resuming');
  vote.updateAutomation('released');
  // Le bar n'est pas soumis au délai.
  assert.equal(vote.staffLaunch({ song: { songId: 79, title: 'Encore' } }).phase, 'requested');
  assert.throws(() => vote.staffLaunch({ song: { songId: 0, title: 'Invalide' } }), /déjà en préparation|invalide/);
}

{
  const f = fixture(), vote = new BattleVote(f.opts);
  assert.throws(() => vote.setCooldownMinutes(0), /1 à 120/);
  assert.throws(() => vote.setCooldownMinutes(121), /1 à 120/);
  assert.throws(() => vote.setVoteMinutes(0), /1 à 10/);
  assert.throws(() => vote.setVoteMinutes(11), /1 à 10/);
  assert.throws(() => vote.setMinVoters(0), /1 à 100/);
  vote.setVoteMinutes(3);
  vote.setMinVoters(1);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: ['a'] });
  vote.resolve({ outcome: 'done' });
  vote.finishManual();
  assert.equal(vote.setCooldownMinutes(3).cooldownUntil, 1_180_000,
    'changer le délai recalcule immédiatement la pause en cours depuis la fin de la Battle');
  const restored = new BattleVote({ ...f.opts, saved: vote.serialize() });
  assert.equal(restored.cooldownMs, 180_000, 'réglage conservé après redémarrage');
  assert.equal(restored.voteDurationMs, 180_000);
  assert.equal(restored.minVoters, 1);
  assert.equal(restored.view().automation.status, 'after');
  restored.updateAutomation('resuming');
  restored.updateAutomation('released');
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
  assert.equal(state.threshold, 3, 'minimum de votants');
  assert.throws(() => vote.vote({ personId: 'b', choice: 999 }), /invalide/);
  assert.throws(() => vote.vote({ personId: 'b', choice: 'yes' }), /invalide/);
  vote.vote({ personId: 'b', choice: 202 });
  state = vote.vote({ personId: 'c', choice: 202 });
  assert.equal(state.phase, 'voting', 'le vote reste ouvert et ses résultats restent visibles');
  assert.equal(state.yesVotes, 3);
  assert.deepEqual(state.songOptions.map(song => song.votes), [1, 2, 0], 'résultats en direct par titre');
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
      eligiblePersonIds: ['a', 'b', 'c'], songs: invalid }), /titre|titres|différent/i);
  }
  assert.throws(() => vote.propose({ personId: 'a', personName: 'Alice',
    eligiblePersonIds: ['a', 'b', 'c'], songs, proposerChoice: 99 }), /proposant invalide/);
  vote.propose({ personId: 'a', personName: 'Alice', eligiblePersonIds: ['a', 'b', 'c', 'd'], songs });
  vote.vote({ personId: 'b', choice: 2 });
  vote.vote({ personId: 'c', choice: 'none' });
  const state = vote.vote({ personId: 'd', choice: 1 });
  assert.equal(state.selectedSong.songId, 1, 'égalité de titres : premier titre proposé retenu');
}

{
  // Un ancien vote sauvegardé (règle de majorité des inscrits) reprend avec
  // les nouvelles règles.
  const f = fixture(), vote = new BattleVote(f.opts);
  vote.propose({ personId: 'a', personName: 'A', eligiblePersonIds: 'abcdef'.split('') });
  const saved = vote.serialize();
  delete saved.ballot.rule;
  saved.ballot.threshold = 4;
  saved.version = 3;
  const resumed = new BattleVote({ ...f.opts, saved });
  assert.equal(resumed.view().threshold, 3);
}

console.log('Battle collective : minuteur, votants minimum, décision des votants, pause après la Battle et lancement par le bar OK');
