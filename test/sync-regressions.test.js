'use strict';
// Rejoue les transitions observées dans le journal KCS sans ouvrir KaraFun ni un port.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');
const { KaraFunBridge, BATTLE_MOD, isBattleItem, normalizeKcsItem } = require('../karafun');

const root = path.join(__dirname, '..');
const fromServer = createRequire(path.join(root, 'server.js'));
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  // Ce harnais rejoue seulement l'ordonnanceur et le pont KaraFun en mémoire.
  // Il ne doit ni charger ni écraser la sauvegarde d'une vraie soirée.
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const context = {
    require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console, Buffer, URL, setTimeout, setImmediate,
  };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, access, sync, publicState, presenceCandidate,
      settings, clearEvening, clearQueue, battleVote,
      staffPlay() { return handlers['POST /api/staff/kf'](null, null, { action: 'play' }); },
      finishBattle() { return handlers['POST /api/staff/battle/resolve'](null, null, { outcome: 'finished' }); },
      handle(route, body) { return handlers[route](null, null, body); },
      setBridge(value) { bridge = value; },
      setIdleSince(value) { idleSince = value; },
      setEmptySince(value) { emptySince = value; },
      tracked() { return tracked; }, pending() { return pending; } };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  // Ces rejeux n'ont qu'un votant : le minimum de la salle ne les concerne pas.
  f.battleVote.setMinVoters(1);
  f.sched.table('1');
  f.access.issue('1');
  const adds = [];
  const battleAdds = [];
  const removes = [];
  const plays = [];
  const bridge = {
    ready: true, connected: true, queue: [], status: { state: 'idle' },
    add(songId, singer) { adds.push({ songId, singer }); },
    addBattle(songId, position) { battleAdds.push({ songId, position }); },
    play() { plays.push(Date.now()); }, next() {}, remove(queueId) { removes.push(queueId); },
  };
  f.setBridge(bridge);
  return { ...f, bridge, adds, battleAdds, removes, plays };
}

const song = (id, title = `Titre ${id}`) => ({ songId: id, title, artist: 'Artiste' });
const item = (id, s, singer) => ({ queueId: id, songId: s.songId, title: s.title, artist: s.artist, singer });
const battleItem = (id, s) => ({ ...item(id, s, 'Battle collective'), options: { mod: BATTLE_MOD } });
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('la trame KCS Battle reprend le mode observé dans les événements réels', () => {
  const bridge = new KaraFunBridge();
  const sent = [];
  bridge.protocol = 'kcs';
  bridge.ready = bridge.connected = true;
  bridge.raw.configuration = { compatibleMods: { battle: [1] } };
  bridge.socket = { send(type, payload) { sent.push({ type, payload }); } };
  bridge.raw.permissions = { addToQueue: true, shownTypes: { battle: false } };
  assert.throws(() => bridge.addBattle(5091, 1), /permission Battle/i,
    'KaraFun peut annoncer le mode Battle compatible tout en refusant son ajout à cette télécommande');
  assert.equal(sent.length, 0, 'une permission Battle refusée ne doit pas émettre de commande');
  bridge.raw.permissions.shownTypes.battle = true;
  bridge.addBattle(5091, 1);
  assert.equal(sent[0].type, 'remote.AddToQueueRequest');
  assert.deepEqual(sent[0].payload.song, { type: 1, id: 5091 });
  assert.equal(sent[0].payload.position, 1);
  assert.deepEqual(sent[0].payload.options.mod, BATTLE_MOD);
  assert.equal(Object.hasOwn(sent[0].payload.options, 'singer'), false,
    'la trame Battle observée dans KaraFun ne comporte pas de chanteur solo');
  const confirmed = normalizeKcsItem({ id: 'battle-uuid', song: {
    id: { id: 5091 }, title: 'Battle', options: { mod: BATTLE_MOD },
  } });
  assert.equal(isBattleItem(confirmed), true);
  bridge.raw.configuration.compatibleMods.battle = [];
  assert.throws(() => bridge.addBattle(5091), /ne confirme pas le mode Battle/);
  assert.equal(sent.length, 1, 'un mode non annoncé par KaraFun ne doit jamais être envoyé');
});

test('le vote Battle signale immédiatement la permission refusée et attend le bar', () => {
  const f = harness();
  const remote = new KaraFunBridge();
  const sent = [];
  remote.protocol = 'kcs';
  remote.ready = remote.connected = true;
  remote.raw.configuration = { compatibleMods: { battle: [1] } };
  remote.raw.permissions = { addToQueue: true, shownTypes: { battle: false } };
  remote.socket = { send(type, payload) { sent.push({ type, payload }); } };
  f.bridge.addBattle = (...args) => remote.addBattle(...args);
  f.battleVote.propose({ personId: 'client', personName: 'Client',
    eligiblePersonIds: ['client'], songs: [song(5091, 'Battle demandée')] });
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'failed');
  assert.match(f.battleVote.view().automation.failure, /permission Battle refusée/i);
  assert.equal(sent.length, 0, 'aucune commande rejetée par KaraFun ne part');
  assert.equal(f.adds.length, 0, 'la file ordinaire attend que le bar traite la Battle');
});

test('une Battle approuvée est confirmée en mode Battle, attend les joueurs puis le bar après les résultats', () => {
  const f = harness();
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 0;
  f.settings.pushDelaySec = 0;
  const alice = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  f.sched.chooseSong(alice, song(91, 'Après la Battle'));
  const choice = song(5091, 'Battle collective');
  f.battleVote.propose({ personId: 'client', personName: 'Client', eligiblePersonIds: ['client'],
    songs: [choice], proposerChoice: choice.songId });
  assert.equal(f.battleVote.view().phase, 'requested');
  f.sync();
  assert.deepEqual(f.battleAdds, [{ songId: 5091, position: 0 }]);
  assert.equal(f.adds.length, 0, 'le prochain solo n’est pas ajouté derrière la Battle');
  assert.equal(f.battleVote.view().automation.status, 'sending');
  const battle = battleItem('battle-uuid', choice);
  f.bridge.queue = [battle];
  f.sync();
  assert.equal(f.battleVote.view().phase, 'cooldown', 'pause de 15 min après confirmation, pas après le vote');
  assert.equal(f.battleVote.view().automation.status, 'queued');
  f.setIdleSince(Date.now() - 9_000);
  f.sync();
  assert.equal(f.plays.length, 0, 'aucune lecture helper pendant la connexion des joueurs');
  assert.equal(f.publicState(null, '1').queue[0].kind, 'battle');
  f.bridge.status = { state: 'playing', current: battle };
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'playing');
  f.bridge.queue = [];
  f.bridge.status = { state: 'idle', current: null };
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'after');
  assert.equal(f.adds.length, 0, 'le titre suivant attend les félicitations');
  f.battleVote.updateAutomation('resuming'); // clic manuel du bar
  f.setEmptySince(Date.now() - 2_000);
  f.sync();
  assert.equal(f.adds.length, 1, 'le prochain titre n’est envoyé que sur action du bar');
  const next = item('solo-uuid', song(91, 'Après la Battle'), f.adds[0].singer);
  f.bridge.queue = [next];
  f.sync();
  assert.equal(f.plays.length, 1, 'le clic manuel lance le titre confirmé');
  f.sync();
  assert.equal(f.plays.length, 1, 'pas de double lecture pendant la réponse KaraFun');
  f.bridge.status = { state: 'playing', current: next };
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'released');
});

test('la Battle attend le chanteur suivant déjà garanti et un accusé perdu ne provoque pas de doublon', () => {
  const f = harness();
  f.settings.pushDelaySec = 0;
  const alice = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  f.sched.chooseSong(alice, song(92, 'Passage garanti'));
  f.sched.reserveNext();
  const choice = song(5091, 'Battle collective');
  f.battleVote.propose({ personId: 'client', personName: 'Client', eligiblePersonIds: ['client'],
    songs: [choice], proposerChoice: choice.songId });
  f.sync();
  assert.equal(f.battleAdds.length, 0, 'une Battle ne prend pas la place garantie');
  assert.equal(f.adds.length, 1, 'le chanteur garanti est bien envoyé');
  const stage = item('garanti', song(92, 'Passage garanti'), f.adds[0].singer);
  f.bridge.queue = [stage];
  f.bridge.status = { state: 'playing', current: stage };
  f.sync(); // réception KaraFun : commit du passage promis
  f.sync(); // tick suivant : la place d'après est libre pour la Battle
  assert.deepEqual(f.battleAdds, [{ songId: 5091, position: 1 }]);
  f.battleVote.automation.sentAt = Date.now() - 16000;
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'failed');
  f.sync();
  assert.equal(f.battleAdds.length, 1, 'une commande Battle sans accusé ne repart jamais');
  f.bridge.queue.push(battleItem('late-battle', choice));
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'queued', 'un accusé tardif est rapproché');
  assert.equal(f.battleAdds.length, 1);
});

test('un titre ajouté sans option Battle ne valide pas la demande et ne part pas en lecture automatique', () => {
  const f = harness();
  f.settings.autoPlay = true;
  const choice = song(5091, 'Titre non compatible');
  f.battleVote.propose({ personId: 'client', personName: 'Client', eligiblePersonIds: ['client'],
    songs: [choice], proposerChoice: choice.songId });
  f.sync();
  assert.equal(f.battleAdds.length, 1);
  f.bridge.queue = [item('sans-battle', choice, 'Battle collective')];
  f.sync();
  assert.equal(f.battleVote.view().phase, 'requested');
  assert.equal(f.battleVote.view().automation.status, 'failed');
  assert.match(f.battleVote.view().automation.failure, /sans le mode Battle/);
  f.setIdleSince(Date.now() - 9_000);
  f.sync();
  assert.equal(f.plays.length, 0);
  assert.equal(f.battleAdds.length, 1, 'aucune nouvelle commande en cas de mode refusé');
});

test('une Battle créée directement dans KaraFun suspend aussi la lecture du titre suivant', () => {
  const f = harness();
  f.settings.auto = true;
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 0;
  f.settings.pushDelaySec = 0;
  const alice = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  f.sched.chooseSong(alice, song(99, 'Après la Battle native'));
  const native = battleItem('native-battle', song(5091, 'Battle native'));
  f.bridge.queue = [native];
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'queued');
  assert.equal(f.battleVote.view().phase, 'cooldown',
    'une Battle créée au bar bloque aussi les votes');
  assert.equal(f.battleVote.view().cooldownUntil, null,
    'le délai entre Battles ne part qu’à la fin de la Battle');
  assert.equal(f.adds.length, 0);
  f.setIdleSince(Date.now() - 9_000);
  f.sync();
  assert.equal(f.plays.length, 0, 'le bar laisse les participants rejoindre depuis le QR');
  f.bridge.status = { state: 'playing', current: native };
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'playing');
  f.bridge.queue = [];
  f.bridge.status = { state: 'idle', current: null };
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'after');
  assert.ok(f.battleVote.view().cooldownUntil > Date.now(), 'le délai démarre à la fin de la Battle');
  assert.equal(f.adds.length, 0, 'aucun nouveau titre envoyé avant que le bar reprenne');
  f.battleVote.updateAutomation('resuming');
  f.setEmptySince(Date.now() - 2_000);
  f.sync();
  assert.equal(f.adds.length, 1, 'la reprise manuelle envoie le titre prévu');
  const next = item('apres-native', song(99, 'Après la Battle native'), f.adds[0].singer);
  f.bridge.queue = [next];
  f.sync();
  assert.equal(f.plays.length, 1, 'la lecture ne reprend qu’après confirmation de la commande');
  f.bridge.status = { state: 'playing', current: next };
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'released');
});

test('une Battle native interrompt un vote en attente sans envoyer une seconde Battle', () => {
  const f = harness();
  const choice = song(5091, 'Battle votée');
  f.battleVote.propose({ personId: 'client', personName: 'Client', eligiblePersonIds: ['client'],
    songs: [choice], proposerChoice: choice.songId });
  f.bridge.queue = [battleItem('native-other', song(5092, 'Battle du bar'))];
  f.sync();
  assert.equal(f.battleVote.view().automation.queueId, 'native-other');
  assert.equal(f.battleVote.view().selectedSong.title, 'Battle du bar');
  assert.equal(f.battleAdds.length, 0, 'la Battle votée est supplantée sans doublon');
});

test('un QueueEvent arrivé avant StatusEvent ne conclut pas prématurément la Battle', () => {
  const f = harness();
  const old = item('ancien', song(88, 'Ancien titre'), 'Le bar');
  const battle = battleItem('native-transition', song(5091, 'Battle'));
  f.bridge.queue = [old, battle];
  f.bridge.status = { state: 'playing', current: old };
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'queued');
  f.bridge.queue = [old];
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'queued',
    'la disparition de la file attend la mise à jour de la lecture');
  f.bridge.queue = [battle];
  f.bridge.status = { state: 'playing', current: battle };
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'playing');
});

test('la reprise après Battle refuse une file vide et ne déclenche pas un futur titre ajouté plus tard', async () => {
  const f = harness();
  f.battleVote.observeExternalBattle(battleItem('native-empty', song(5091, 'Battle')));
  f.battleVote.updateAutomation('after');
  await assert.rejects(f.staffPlay(), /Aucun titre suivant/);
  assert.equal(f.battleVote.view().automation.status, 'after');
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  f.sched.chooseSong(p, song(100, 'Nouveau titre'));
  assert.equal(f.battleVote.view().automation.status, 'after',
    'ajouter un titre après le clic refusé ne libère pas la pause');
  await f.staffPlay();
  assert.equal(f.battleVote.view().automation.status, 'resuming');
});

test('la reprise après Battle refuse un titre local si l’envoi automatique est désactivé', async () => {
  const f = harness();
  f.settings.auto = false;
  f.battleVote.observeExternalBattle(battleItem('native-disabled', song(5091, 'Battle')));
  f.battleVote.updateAutomation('after');
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  f.sched.chooseSong(p, song(101, 'Titre local'));
  await assert.rejects(f.staffPlay(), /envoi automatique/i);
  assert.equal(f.battleVote.view().automation.status, 'after');
  f.settings.auto = true;
  await f.staffPlay();
  assert.equal(f.battleVote.view().automation.status, 'resuming');
});

test('une Battle manuelle organisée ne libère la suite qu’après les résultats', async () => {
  const f = harness();
  f.settings.auto = true;
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  f.sched.chooseSong(p, song(101, 'Titre après Battle'));
  f.battleVote.propose({ personId: 'client', personName: 'Client', eligiblePersonIds: ['client'],
    songs: [song(5091, 'Battle')] });
  f.battleVote.updateAutomation('failed', 'Mode distant indisponible');
  f.battleVote.resolve({ outcome: 'done' });
  assert.equal(f.battleVote.view().automation.status, 'manual');
  f.sync();
  assert.equal(f.adds.length, 0, 'la chanson suivante ne part pas pendant les connexions');
  await assert.rejects(f.staffPlay(), /Battle/);
  await f.finishBattle();
  assert.equal(f.battleVote.view().automation.status, 'after');
});

test('une Battle manuelle reconnue par KaraFun revient au suivi automatique de sa fin', () => {
  const f = harness();
  const choice = song(5091, 'Battle du bar');
  f.battleVote.propose({ personId: 'client', personName: 'Client', eligiblePersonIds: ['client'],
    songs: [choice] });
  f.battleVote.updateAutomation('failed', 'Accusé absent');
  f.battleVote.resolve({ outcome: 'done' });
  const native = battleItem('manual-confirmed', choice);
  f.bridge.queue = [native];
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'queued');
  assert.equal(f.battleVote.view().automation.queueId, 'manual-confirmed');
  f.bridge.status = { state: 'playing', current: native };
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'playing');
  f.bridge.queue = [];
  f.bridge.status = { state: 'idle', current: null };
  f.sync();
  assert.equal(f.battleVote.view().automation.status, 'after');
});

test('la lecture automatique ne lance pas une Battle ou un titre ajouté directement dans KaraFun', () => {
  const f = harness();
  f.settings.auto = false;
  f.settings.autoPlay = true;
  f.settings.playDelaySec = 8;
  const native = item('battle-manuelle', song(88, 'Battle collective'), 'La salle');
  f.bridge.queue = [native];
  f.sync();
  assert.equal(f.publicState(null, '1').queue[0].ours, false,
    'le titre KaraFun manuel est identifiable dans la vue');
  f.setIdleSince(Date.now() - 9_000);
  f.sync();
  assert.equal(f.plays.length, 0, 'la Battle attend que le bar laisse les invités rejoindre');

  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const s = song(89, 'Titre FileKaraoke');
  f.sched.chooseSong(p, s);
  const sel = f.sched.select();
  f.sched.commit(sel);
  const ours = item('notre-titre', s, sel.label);
  f.tracked().push({ queueId: ours.queueId, sel, addedAt: Date.now(), startedAt: null });
  f.bridge.queue = [native, ours];
  f.sync();
  f.setIdleSince(Date.now() - 9_000);
  f.sync();
  assert.equal(f.plays.length, 0, 'un titre du helper derrière une Battle ne la lance pas');

  f.bridge.queue = [ours];
  f.sync();
  assert.equal(f.plays.length, 0, 'le délai redémarre quand le prochain titre change');
  f.setIdleSince(Date.now() - 9_000);
  f.sync();
  assert.equal(f.plays.length, 1, 'un titre confirmé du helper garde la lecture automatique');

  f.tracked()[0].cancelled = true;
  f.sync();
  f.setIdleSince(Date.now() - 9_000);
  f.sync();
  assert.equal(f.plays.length, 1, 'un titre en cours de retrait ne redémarre pas');
});

test('Suivant sur un titre chargé mais jamais joué ne renvoie pas ce titre', () => {
  const f = harness();
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const s = song(101);
  f.sched.chooseSong(p, s);
  f.sync();
  assert.equal(f.adds.length, 1);
  // KaraFun confirme l’ajout, puis charge le titre sans le jouer (state 3 normalisé idle).
  f.bridge.queue = [item('uuid-1', s, f.adds[0].singer)];
  f.bridge.status = { state: 'idle', current: item('uuid-1', s, f.adds[0].singer) };
  f.sync();
  assert.equal(f.tracked().length, 1);
  // Le bouton Suivant de KaraFun enlève le titre chargé. Aucun Play n’a été observé.
  f.bridge.queue = [];
  f.bridge.status = { state: 'idle', current: null };
  f.sync();
  assert.equal(f.adds.length, 1, 'le même morceau repart automatiquement après Suivant');
  assert.equal(f.tracked().length, 0);
  assert.equal(p.song, null, 'le titre sauté ne doit pas redevenir un titre prêt à jouer');
});

test('un choix reçu pendant l’accusé de réception du précédent reste en attente', () => {
  const f = harness();
  const p = f.sched.join({ tableId: '1', name: 'Marine', headcount: 1 });
  const first = song(201, 'Premier titre');
  const second = song(202, 'Deuxième titre');
  f.sched.chooseSong(p, first);
  f.sync(); // ajout lancé, accusé de réception encore attendu
  f.sched.chooseSong(p, second);
  f.bridge.queue = [item('uuid-2', first, f.adds[0].singer)];
  f.sync(); // accusé de réception du premier titre
  assert.equal(p.song?.songId, second.songId, 'commit() a effacé le nouveau choix');
  assert.equal(f.sched.select()?.song.songId, second.songId);
});

test('un titre identique ajouté par une autre télécommande ne confirme pas notre envoi', () => {
  const f = harness();
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const s = song(203, 'Même titre');
  f.sched.chooseSong(p, s);
  f.sync();
  f.bridge.queue = [item('externe', s, 'Autre personne')];
  f.sync();
  assert.equal(f.tracked().length, 0, 'la chanson externe a été attribuée à Alice');
  assert.ok(f.pending(), 'notre ajout attend encore sa confirmation');
  f.bridge.queue.push(item('notre-uuid', s, f.adds[0].singer));
  f.sync();
  assert.equal(f.tracked()[0]?.queueId, 'notre-uuid');
});

test('un ajout non confirmé n’est jamais renvoyé et une confirmation tardive le rapproche', () => {
  const f = harness();
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  f.sched.chooseSong(p, song(250));
  f.sync();
  assert.equal(f.adds.length, 1);
  f.pending().at = Date.now() - 16000;
  f.sync();
  assert.equal(f.settings.auto, true);
  assert.ok(f.pending(), 'la tentative reste traçable');
  f.sync();
  assert.equal(f.adds.length, 1, 'une réponse absente ne prouve pas que KaraFun a refusé la première commande');
  f.bridge.queue = [item('retardee', song(250), f.adds[0].singer)];
  f.sync();
  assert.equal(f.tracked()[0]?.queueId, 'retardee', 'une confirmation tardive est attribuée à la tentative initiale');
  assert.equal(f.pending(), null);
  assert.equal(f.settings.auto, true);
});

test('reset pendant la déconnexion conserve la piste à retirer jusqu’à la reconnexion', () => {
  const f = harness();
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const s = song(260, 'À retirer');
  f.sched.chooseSong(p, s);
  f.sync();
  assert.equal(f.adds.length, 1);
  f.bridge.queue = [item('uuid-reset', s, f.adds[0].singer)];
  f.sync();
  assert.equal(f.tracked().length, 1);
  assert.equal(f.tracked()[0].startedAt, null, 'la piste est encore à venir');

  f.bridge.ready = false;
  f.bridge.connected = false;
  f.bridge.queue = []; // la file distante n’est plus consultable
  const reset = f.clearEvening();
  assert.equal(reset.removalPending, 1);
  assert.equal(reset.removalRequests, 0, 'aucun retrait ne peut être confirmé hors connexion');
  assert.equal(f.settings.auto, false, 'aucun nouvel envoi automatique pendant le retrait différé');
  assert.equal(f.sched.tables.size, 1, 'Le groupe En solo est prêt pour la nouvelle soirée.');
  assert.equal(f.sched.table('Comptoir', false)?.name, 'En solo');
  assert.equal(f.sched.people.size, 0);
  assert.equal(f.tracked().length, 1, 'la piste envoyée reste suivie malgré le reset');
  assert.equal(f.tracked()[0].cancelled, true);
  assert.deepEqual(f.removes, []);
  const saved = snapshotNight({ scheduler: f.sched, access: f.access,
    settings: f.settings, tracked: f.tracked() });
  const resumedSettings = { ...f.settings };
  const resumed = restoreNight(saved, { scheduler: new Scheduler(),
    access: new TableAccess(), settings: resumedSettings });
  assert.equal(resumed.tracked[0].cancelled, true,
    'le retrait différé reste suivi après restauration de la soirée');
  assert.equal(resumedSettings.auto, false);

  f.bridge.ready = true;
  f.bridge.connected = true;
  f.bridge.queue = [item('uuid-reset', s, f.adds[0].singer)];
  f.sync();
  assert.deepEqual(f.removes, ['uuid-reset'], 'le retrait est demandé à KaraFun après reconnexion');
  assert.equal(f.tracked().length, 1, 'la piste attend la confirmation de son retrait');
  f.sync();
  assert.equal(f.removes.length, 1, 'pas de commandes répétées tant que le délai de vérification court');
  f.bridge.queue = [];
  f.sync();
  assert.equal(f.tracked().length, 0, 'le suivi finit quand KaraFun confirme la disparition');
  assert.equal(f.adds.length, 1, 'aucun titre ne repart après le reset');
});

test('vider la file conserve les tables, les téléphones et l’historique mais retire listes et duos', () => {
  const f = harness();
  f.settings.auto = false;
  const a = f.sched.join({ tableId: '1', name: 'Alice', headcount: 2 });
  f.sched.table('2').headcount = 1;
  f.access.issue('2');
  const b = f.sched.join({ tableId: '2', name: 'Bob' });
  f.sched.chooseSong(a, song(401), 'append');
  f.sched.chooseSong(a, song(402), 'append');
  f.sched.inviteDuet(a, b.id, song(403));
  f.sched.chooseSong(b, song(404));
  a.sung = 2;
  a.privateNote = 't-shirt rouge';
  const token = a.token, qr = f.access.get('1');
  const result = f.clearQueue();
  assert.equal(result.removedLocalSongs, 4);
  assert.equal(f.sched.tables.size, 2);
  assert.equal(f.access.get('1'), qr);
  assert.equal(f.sched.person(token), a);
  assert.equal(a.sung, 2);
  assert.equal(a.privateNote, 't-shirt rouge');
  assert.equal(f.sched.Q.length, 0);
  assert.equal(f.sched.songsOf(a).length, 0);
  assert.equal(f.sched.songsOf(b).length, 0);
  assert.equal(b.invite, null);
  assert.equal(f.publicState(a, '1').queue.length, 0);
  f.sched.chooseSong(a, song(405));
  assert.equal(f.sched.Q[0], a.id, 'un nouveau choix repart dans une file fraîche');
});

test('vider pendant un envoi non confirmé retire son accusé tardif sans renvoyer le titre', () => {
  const f = harness();
  const p = f.sched.join({ tableId: '1', name: 'Marine', headcount: 1 });
  p.sung = 1; // un vrai passage antérieur ne doit pas être débité par ce retrait
  p.lastAppearanceTurn = 1;
  f.sched.appearanceSerial = 1;
  const s = song(411);
  f.sched.chooseSong(p, s);
  f.sync();
  assert.equal(f.adds.length, 1);
  f.clearQueue();
  assert.equal(f.pending()?.cancelled, true);
  assert.equal(p.song, null);
  f.bridge.queue = [item('tardif', s, f.adds[0].singer)];
  f.sync();
  assert.equal(f.pending(), null);
  assert.deepEqual(f.removes, ['tardif']);
  assert.equal(p.sung, 1, 'un accusé annulé sans commit ne débite pas un vrai passage antérieur');
  assert.equal(p.lastAppearanceTurn, 1);
  assert.equal(f.sched.appearanceSerial, 1);
  f.bridge.queue = [];
  f.sync();
  assert.equal(f.tracked().length, 0);
  assert.equal(f.settings.queueClearPending, false);
  assert.equal(f.adds.length, 1);
});

test('un accusé tardif déjà sur scène pendant le vidage continue et compte comme un passage', () => {
  const f = harness();
  const p = f.sched.join({ tableId: '1', name: 'Marine', headcount: 1 });
  const s = song(415);
  f.sched.chooseSong(p, s);
  f.sync();
  f.clearQueue();
  const stage = item('tardif-sur-scene', s, f.adds[0].singer);
  f.bridge.queue = [stage];
  f.bridge.status = { state: 'playing', current: stage };
  f.sync();
  assert.deepEqual(f.removes, [], 'La chanson déjà en lecture ne doit pas être interrompue.');
  assert.equal(f.tracked()[0].startedAt > 0, true);
  assert.equal(p.sung, 1, 'Le passage chanté doit rester dans l’historique.');
  assert.equal(f.sched.Q.length, 0, 'Le vidage ne recrée pas son ticket.');
});

test('vider conserve le titre sur scène et retire les titres KaraFun manuels suivants', () => {
  const f = harness();
  f.settings.auto = false;
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const s = song(421);
  f.sched.chooseSong(p, s);
  const sel = f.sched.select();
  f.sched.commit(sel);
  const stage = item('sur-scene', s, sel.label);
  const manual = item('manuel', song(422), 'Invité manuel');
  f.tracked().push({ queueId: stage.queueId, sel, addedAt: Date.now(), startedAt: null });
  f.bridge.queue = [stage, manual];
  f.bridge.status = { state: 'playing', current: stage };
  f.sync();
  const result = f.clearQueue();
  assert.equal(result.currentStillPlaying, true);
  assert.equal(result.otherKaraFunSongs, 1);
  assert.deepEqual(f.removes, ['manuel']);
  assert.equal(f.tracked()[0].cancelled, undefined);
  assert.equal(p.sung, 1);
  assert.equal(f.sched.Q.length, 0);
  f.bridge.queue = [stage];
  f.sync();
  assert.equal(f.settings.queueClearPending, false);
  f.bridge.queue = [];
  f.bridge.status = { state: 'idle', current: null };
  f.sync();
  assert.equal(f.tracked().length, 0);
  assert.equal(p.sung, 1);
  assert.equal(f.sched.Q.length, 0);
});

test('vider hors connexion garde les retraits à faire dans la sauvegarde', () => {
  const f = harness();
  f.settings.auto = false;
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const s = song(431);
  f.sched.chooseSong(p, s);
  const sel = f.sched.select();
  f.sched.commit(sel);
  f.tracked().push({ queueId: 'attente', sel, addedAt: Date.now(), startedAt: null });
  f.bridge.ready = false;
  const result = f.clearQueue();
  assert.equal(result.awaitingKaraFun, true);
  assert.equal(f.settings.queueClearPending, true);
  assert.equal(f.tracked()[0].cancelled, true);
  assert.deepEqual(f.removes, []);
  const saved = snapshotNight({ scheduler: f.sched, access: f.access,
    settings: f.settings, tracked: f.tracked() });
  const resumedSettings = { ...f.settings };
  const resumed = restoreNight(saved, { scheduler: new Scheduler(), access: new TableAccess(),
    settings: resumedSettings });
  assert.equal(resumedSettings.queueClearPending, true);
  assert.equal(resumed.tracked[0].cancelled, true);
  f.bridge.ready = true;
  f.bridge.queue = [item('attente', s, sel.label), item('manuel-deconnecte', song(432), 'Autre téléphone')];
  f.bridge.status = { state: 'idle' };
  f.sync();
  assert.deepEqual(new Set(f.removes), new Set(['attente', 'manuel-deconnecte']));
  f.bridge.queue = [];
  f.sync();
  assert.equal(f.settings.queueClearPending, false);
});

test('vider sans KaraFun : le bar arrête l’attente, seuls nos titres annulés quittent KaraFun au retour', async () => {
  const f = harness();
  f.settings.auto = false;
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const s = song(441);
  f.sched.chooseSong(p, s);
  const sel = f.sched.select();
  f.sched.commit(sel);
  f.tracked().push({ queueId: 'deja-envoye', sel, addedAt: Date.now(), startedAt: null });
  const bridge = f.bridge;
  f.setBridge(null); // pas de code KaraFun, ou KaraFun fermé : sync() ne peut rien conclure
  const result = f.clearQueue();
  assert.equal(result.awaitingKaraFun, true);
  assert.equal(result.karafunOffline, true, 'la page du bar doit savoir que rien n’a été retiré de KaraFun');
  for (let i = 0; i < 50; i++) f.sync();
  assert.equal(f.settings.queueClearPending, true, 'sans KaraFun, le vidage attend sa reconnexion');
  const stopped = await f.handle('POST /api/staff/queue-clear-stop', {});
  assert.deepEqual({ ...stopped }, { ok: true, wasPending: true });
  assert.equal(f.settings.queueClearPending, false, 'le bar peut toujours sortir de l’attente, même sans KaraFun');
  assert.equal(f.settings.auto, false, 'arrêter le vidage ne réactive pas l’envoi automatique');
  assert.ok(f.sched.log.some(line => /arrêté le vidage de KaraFun/.test(line.msg)));
  assert.deepEqual({ ...await f.handle('POST /api/staff/queue-clear-stop', {}) }, { ok: true, wasPending: false },
    'un second clic (ou une page en retard) ne change rien');
  // KaraFun revient : notre titre annulé part toujours, le titre ajouté à la main reste.
  f.setBridge(bridge);
  bridge.queue = [item('deja-envoye', s, sel.label), item('manuel', song(442), 'Invité manuel')];
  bridge.status = { state: 'idle' };
  f.sync();
  assert.deepEqual(f.removes, ['deja-envoye']);
  bridge.queue = [item('manuel', song(442), 'Invité manuel')];
  f.sync();
  assert.equal(f.tracked().length, 0);
  assert.deepEqual(f.removes, ['deja-envoye'], 'le titre ajouté directement dans KaraFun n’est jamais retiré');
  assert.equal(f.settings.queueClearPending, false);
});

test('KaraFun garde un titre après le vidage : arrêter le vidage cesse les retraits et l’envoi reprend file vide', async () => {
  const f = harness();
  f.settings.auto = true;
  f.settings.pushDelaySec = 0;
  const manual = item('manuel-tenace', song(451), 'Invité manuel');
  f.bridge.queue = [manual];
  f.bridge.status = { state: 'idle' };
  f.sync();
  const result = f.clearQueue();
  assert.equal(result.karafunOffline, false);
  assert.deepEqual(f.removes, ['manuel-tenace']);
  f.sync(); // KaraFun ignore le retrait (droits, titre chargé…)
  assert.equal(f.settings.queueClearPending, true);
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  f.sched.chooseSong(p, song(452));
  f.sync();
  assert.equal(f.adds.length, 0, 'rien ne part pendant le vidage');
  assert.deepEqual({ ...await f.handle('POST /api/staff/queue-clear-stop', {}) }, { ok: true, wasPending: true });
  assert.equal(f.settings.queueClearPending, false);
  assert.equal(f.settings.auto, true);
  f.sync();
  assert.deepEqual(f.removes, ['manuel-tenace'], 'le titre gardé par KaraFun n’est plus retiré');
  assert.equal(f.adds.length, 0, 'il reste devant : rien ne part tant que KaraFun le garde');
  f.bridge.queue = [];
  f.setEmptySince(Date.now() - 5000);
  f.sync();
  assert.equal(f.adds.length, 1, 'file KaraFun vide : le nouveau choix part');
  assert.equal(f.adds[0].songId, 452);
});

test('vidage arrêté sans KaraFun : la chanson déjà sur scène au retour finit normalement son passage', async () => {
  const f = harness();
  f.settings.auto = false;
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const s = song(471);
  f.sched.chooseSong(p, s);
  const sel = f.sched.select();
  f.sched.commit(sel);
  f.tracked().push({ queueId: 'scene', sel, addedAt: Date.now(), startedAt: null });
  const bridge = f.bridge;
  f.setBridge(null); // KaraFun perdu : le vidage ne voit pas la scène et annule ce titre
  f.clearQueue();
  assert.equal(f.tracked()[0].cancelled, true);
  await f.handle('POST /api/staff/queue-clear-stop', {});
  const stage = item('scene', s, sel.label);
  f.setBridge(bridge);
  bridge.queue = [stage];
  bridge.status = { state: 'playing', current: stage };
  f.sync();
  assert.deepEqual(f.removes, [], 'la chanson en lecture n’est pas interrompue');
  assert.equal(f.tracked()[0].cancelled, false, 'elle ne compte plus comme un retrait en attente');
  bridge.queue = [];
  bridge.status = { state: 'idle', current: null };
  f.sync();
  assert.equal(f.tracked().length, 0);
  assert.ok(f.sched.stageHistory.at(-1)?.endedAt, 'le passage chanté se termine dans l’historique');
  assert.ok(!f.sched.log.some(line => /Retrait KaraFun confirmé/.test(line.msg)), 'pas de faux retrait confirmé');
  assert.equal(p.sung, 1);
});

test('vidage arrêté pendant un envoi : l’accusé déjà sur scène compte sans remettre le chanteur dans la file', async () => {
  const f = harness();
  const p = f.sched.join({ tableId: '1', name: 'Marine', headcount: 1 });
  const s = song(481);
  f.sched.chooseSong(p, s);
  f.sync();
  assert.equal(f.adds.length, 1);
  f.bridge.ready = false; // KaraFun perdu avant l'accusé
  f.clearQueue();
  await f.handle('POST /api/staff/queue-clear-stop', {});
  const stage = item('accuse-scene', s, f.adds[0].singer);
  f.bridge.ready = true;
  f.bridge.queue = [stage];
  f.bridge.status = { state: 'playing', current: stage };
  f.sync();
  assert.deepEqual(f.removes, [], 'la chanson en lecture n’est pas interrompue');
  assert.equal(f.tracked()[0].startedAt > 0, true);
  assert.equal(p.sung, 1);
  assert.equal(f.sched.Q.length, 0, 'le vidage ne recrée pas son ticket');
});

test('vidage arrêté pendant un envoi : un nouveau choix fait avant l’accusé garde sa place dans la file', async () => {
  const f = harness();
  f.settings.pushDelaySec = 0;
  const p = f.sched.join({ tableId: '1', name: 'Marine', headcount: 1 });
  const s = song(491);
  f.sched.chooseSong(p, s);
  f.sync();
  assert.equal(f.adds.length, 1);
  f.bridge.ready = false; // KaraFun perdu avant l'accusé
  f.clearQueue();
  await f.handle('POST /api/staff/queue-clear-stop', {});
  f.sched.chooseSong(p, song(492)); // nouveau choix avant le retour de KaraFun
  const stage = item('accuse-scene', s, f.adds[0].singer);
  f.bridge.ready = true;
  f.bridge.queue = [stage];
  f.bridge.status = { state: 'playing', current: stage };
  f.sync();
  assert.deepEqual(f.removes, []);
  assert.equal(p.song?.songId, 492);
  assert.ok(f.sched.Q.includes(p.id), 'le nouveau choix garde son ticket');
  f.bridge.queue = [];
  f.bridge.status = { state: 'idle', current: null };
  f.setEmptySince(Date.now() - 5000);
  f.sync();
  f.sync();
  assert.equal(f.adds.at(-1).songId, 492, 'le nouveau choix part une fois la scène libre');
});

test('vidage enregistré par l’ancienne version puis arrêté : la chanson sur scène reste protégée', async () => {
  const f = harness();
  f.settings.auto = false;
  const p = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const s = song(495);
  f.sched.chooseSong(p, s);
  const sel = f.sched.select();
  f.sched.commit(sel);
  // Soirée restaurée d'avant ce correctif : drapeau levé, titre annulé sans repère.
  f.settings.queueClearPending = true;
  f.tracked().push({ queueId: 'ancien', sel, addedAt: Date.now(), startedAt: null, cancelled: true, removeRequestedAt: 0 });
  const bridge = f.bridge;
  f.setBridge(null);
  await f.handle('POST /api/staff/queue-clear-stop', {});
  const stage = item('ancien', s, sel.label);
  f.setBridge(bridge);
  bridge.queue = [stage];
  bridge.status = { state: 'playing', current: stage };
  f.sync();
  assert.deepEqual(f.removes, []);
  assert.equal(f.tracked()[0].cancelled, false, 'la chanson en lecture compte comme un passage');
  bridge.queue = [];
  bridge.status = { state: 'idle', current: null };
  f.sync();
  assert.ok(f.sched.stageHistory.at(-1)?.endedAt);
  assert.ok(!f.sched.log.some(line => /Retrait KaraFun confirmé/.test(line.msg)));
});

test('Supprimer toutes les tables termine un vidage resté en attente de KaraFun', () => {
  const f = harness();
  f.settings.auto = false;
  f.bridge.ready = false;
  f.clearQueue();
  assert.equal(f.settings.queueClearPending, true);
  const reset = f.clearEvening();
  assert.equal(reset.karafunOffline, true, 'la page du bar doit dire de vérifier la file KaraFun');
  assert.equal(f.settings.queueClearPending, false, 'une nouvelle soirée ne garde pas le vidage de la précédente');
  // Le lendemain, le bar met des titres directement dans KaraFun puis connecte la file.
  f.bridge.ready = true;
  f.bridge.queue = [item('dj-1', song(461), 'DJ'), item('dj-2', song(462), 'DJ')];
  f.bridge.status = { state: 'idle' };
  f.sync();
  assert.deepEqual(f.removes, [], 'les titres de la nouvelle soirée restent dans KaraFun');
});

test('une seule personne reçoit Je suis là : la prochaine après la scène, jamais celle qui chante', () => {
  const f = harness();
  f.settings.auto = false;
  f.settings.pushDelaySec = 0;
  f.sched.table('2').headcount = 1; f.access.issue('2');
  f.sched.table('3').headcount = 1; f.access.issue('3');
  const a = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const b = f.sched.join({ tableId: '2', name: 'Sebastiano' });
  const c = f.sched.join({ tableId: '3', name: 'Chloé' });
  f.sched.chooseSong(a, song(501));
  f.sched.chooseSong(b, song(502));
  f.sched.chooseSong(c, song(503));
  const sel = f.sched.select();
  f.sched.commit(sel);
  const stage = item('scene-presence', sel.song, sel.label);
  f.tracked().push({ queueId: stage.queueId, sel, addedAt: Date.now(), startedAt: Date.now() });
  f.bridge.queue = [stage];
  f.bridge.status = { state: 'playing', current: stage };
  f.sched.opts.requirePresence = true;
  f.sched.confirm(c); // une confirmation trop tôt ne doit pas faire doubler Sebastiano
  let view = f.publicState(b, '2');
  assert.equal(view.stage.ids[0], a.id);
  assert.equal(view.tablePeople[0].needConfirm, true,
    'Sebastiano est absent de la file et ne reçoit aucune demande.');
  assert.equal(view.queue[0].ids[0], b.id, 'le titre retenu doit rester visible en premier');
  assert.equal(f.publicState(a, '1').tablePeople[0].needConfirm, false);
  assert.equal(f.publicState(c, '3').tablePeople[0].needConfirm, false,
    'ne pas demander la présence deux ou trois chansons en avance');
  f.settings.auto = true;
  f.sync();
  assert.equal(f.adds.length, 0, 'Chloé confirmée a sauté le tour de Sebastiano non confirmé.');
  f.sched.confirm(b);
  f.sync();
  assert.equal(f.adds[0]?.songId, 502, 'après confirmation, Sebastiano part bien avant Chloé');
  f.bridge.queue = [stage, item('confirme-presence', song(502), f.adds[0].singer)];
  f.sync();
  view = f.publicState(b, '2');
  assert.equal(view.tablePeople[0].needConfirm, false);
  assert.equal(f.publicState(c, '3').tablePeople[0].needConfirm, false,
    'Chloé attend que Sebastiano soit réellement sur scène.');
  c.confirmedAt = 0; // l'ancienne confirmation anticipée n'est plus valide
  f.bridge.queue = [item('confirme-presence', song(502), f.adds[0].singer)];
  f.bridge.status = { state: 'playing', current: f.bridge.queue[0] };
  f.sync();
  assert.equal(f.publicState(c, '3').tablePeople[0].needConfirm, true,
    'la notification arrive quand Chloé devient la prochaine après Sebastiano');
});

test('avant la première chanson, seule la première personne peut confirmer sa présence', () => {
  const f = harness();
  f.settings.auto = false;
  f.sched.opts.requirePresence = true;
  f.sched.table('2').headcount = 1; f.access.issue('2');
  const a = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const b = f.sched.join({ tableId: '2', name: 'Bob' });
  f.sched.chooseSong(a, song(510));
  f.sched.chooseSong(b, song(511));
  assert.equal(f.publicState(a, '1').tablePeople[0].needConfirm, true);
  assert.equal(f.publicState(b, '2').tablePeople[0].needConfirm, false);
  assert.equal(f.publicState(a, '1').queue[0].ids[0], a.id);
});

test('le bar notifie Je suis là sans attendre Timefold, et son résultat ne change pas la personne notifiée', async () => {
  const f = harness();
  f.settings.auto = false;
  f.sched.opts.requirePresence = true;
  f.sched.table('2').headcount = 1; f.access.issue('2');
  const a = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const b = f.sched.join({ tableId: '2', name: 'Bob' });
  f.sched.chooseSong(a, song(520));
  f.sched.chooseSong(b, song(521));
  const original = f.sched.presenceView();
  let complete;
  f.sched.solverBridge = { available: true, lastError: null,
    solve: request => new Promise(resolve => {
      complete = () => resolve({ requestId: request.requestId,
        order: original.map(row => row.entryId).reverse() });
    }) };
  f.sync();
  const notified = f.presenceCandidate();
  assert.equal(notified.ids[0], original[0].ids[0], 'le prochain de l’ordre local est prévenu tout de suite');
  assert.equal(f.sched.reservedNext?.personId, notified.ids[0], 'et sa place est réservée');
  f.sched._planMetric = slots => slots[0]?.ids[0] === b.id ? 0 : 1000;
  complete();
  await f.sched.solverPromise;
  assert.equal(f.presenceCandidate().ids[0], notified.ids[0],
    'un meilleur ordre de Timefold ne retire pas la place annoncée');
});

test('un calcul Timefold long ne retarde pas la réservation du prochain ni sa confirmation', async () => {
  const f = harness();
  f.settings.auto = false;
  f.sched.opts.requirePresence = true;
  f.sched.table('2').headcount = 1; f.access.issue('2');
  const a = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const b = f.sched.join({ tableId: '2', name: 'Bob' });
  f.sched.chooseSong(a, song(530));
  f.sched.chooseSong(b, song(531));
  const fallback = f.sched.presenceView();
  const solves = [];
  f.sched.solverBridge = { available: true, lastError: null,
    solve: request => new Promise(resolve => {
      solves.push({ request, resolve });
    }) };
  f.sync();
  const reservedId = f.sched.reservedNext?.personId;
  assert.equal(reservedId, fallback[0].ids[0], 'le prochain est garanti même pendant le calcul profond');
  assert.equal(f.presenceCandidate().ids[0], reservedId);
  assert.equal(f.publicState(a, '1').tablePeople[0].needConfirm, reservedId === a.id);
  assert.equal(f.publicState(b, '2').tablePeople[0].needConfirm, reservedId === b.id);
  assert.equal(solves.length, 1, 'la réservation réalise le plan : pas de nouveau calcul');
  solves[0].resolve({ requestId: solves[0].request.requestId,
    order: fallback.map(row => row.entryId).reverse() });
  await f.sched.solverPromise;
  assert.equal(f.presenceCandidate().ids[0], reservedId,
    'le résultat final du solveur ne retire pas la confirmation demandée');
});

test('droits KaraFun perdus puis retrouvés : l’envoi automatique reprend seul', () => {
  const f = harness();
  f.settings.auto = true;
  f.bridge.username = 'FileKaraoke-1234';
  f.bridge.permissions = { addToQueue: false };
  f.sync();
  assert.equal(f.settings.auto, false, 'aucun envoi tant que KaraFun refuse');
  f.bridge.permissions = { addToQueue: true };
  f.sync();
  assert.equal(f.settings.auto, true, 'reprise automatique quand les droits reviennent');
  f.bridge.permissions = { addToQueue: false };
  f.sync();
  f.settings.auto = false;
  f.handle('POST /api/staff/settings', { auto: false });
  f.bridge.permissions = { addToQueue: true };
  f.sync();
  assert.equal(f.settings.auto, false, 'une coupure décidée par le bar est respectée');
});

test('changer de mode de rotation au bar garde le tour des personnes en cours', async () => {
  const f = harness();
  f.settings.auto = false;
  for (const id of ['2', '3']) { f.sched.table(id).headcount = 2; f.access.issue(id); }
  f.sched.table('1').headcount = 2;
  const people = [];
  for (const [tableId, names] of [['1', ['A1', 'A2']], ['2', ['B1', 'B2']], ['3', ['C1', 'C2']]]) {
    for (const name of names) {
      const p = f.sched.join({ tableId, name });
      f.sched.chooseSong(p, song(600 + people.length));
      f.sched.chooseSong(p, song(700 + people.length), 'append');
      people.push(p);
    }
  }
  for (let i = 0; i < 3; i++) { const sel = f.sched.select(); f.sched.commit(sel); f.sched.songEnded(sel.ids); }
  const round = new Set(f.sched.roundPeople);
  assert.equal(round.size, 3);
  await f.handle('POST /api/staff/settings', { tableRotation: true, weightedTables: false });
  assert.deepEqual(new Set(f.sched.roundPeople), round, 'le tour n’est plus effacé par un changement de mode');
  const next = f.sched.readyView().slice(0, 3);
  assert.ok(next.every(item => !round.has(item.ids[0])),
    `les trois personnes pas encore passées chantent d’abord : ${next.map(item => item.name)}`);
});

test('une file composée de tickets sans chanson ne promet ni rang ni heure', () => {
  const f = harness();
  f.settings.auto = false;
  const people = ['Alice', 'Bob', 'Chloé'].map(name => f.sched.join({ tableId: '1', name, headcount: 3 }));
  people.forEach((p, i) => f.sched.chooseSong(p, song(301 + i)));
  for (let i = 0; i < people.length; i++) {
    const sel = f.sched.select();
    assert.ok(sel);
    f.sched.commit(sel);
    f.sched.songEnded(sel.ids);
  }
  assert.equal(f.sched.Q.length, 3, 'les chanteurs restent inscrits après leur passage');
  assert.ok(people.every(p => !p.song), 'aucun morceau choisi pour un nouveau passage');
  const state = f.publicState(people[2], '1');
  assert.equal(state.queue.length, 0, 'la page La file affiche des passages inexistants');
  assert.equal(state.me.pos, null, 'le client annonce un rang sans morceau prêt');
  assert.equal(state.me.eta, null);
});

// Regression: après l'heure de fermeture, la Battle et les demandes « Je suis
// là » continuaient comme si la soirée durait encore.
test('fermeture atteinte : la Battle approuvée n’est pas envoyée à KaraFun', () => {
  const f = harness();
  f.settings.auto = true;
  f.settings.closingAt = Date.now() - 60000;
  const choice = song(5091, 'Battle trop tard');
  f.battleVote.propose({ personId: 'client', personName: 'Client', eligiblePersonIds: ['client'],
    songs: [choice], proposerChoice: choice.songId });
  assert.equal(f.battleVote.view().phase, 'requested');
  f.sync(); f.sync();
  assert.deepEqual(f.battleAdds, [], 'aucune Battle ajoutée après l’heure');
  assert.equal(f.adds.length, 0);
});

test('fermeture atteinte : plus de demande « Je suis là », personne n’est sauté ni retiré', () => {
  const f = harness();
  f.settings.auto = true;
  f.settings.presenceGraceSec = 0;
  f.settings.presenceMaxSkips = 1;
  f.sched.opts.requirePresence = true;
  const a = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  f.sched.chooseSong(a, song(520));
  f.settings.closingAt = Date.now() - 60000;
  assert.equal(f.presenceCandidate(), null);
  assert.equal(f.publicState(a, '1').tablePeople[0].needConfirm, false);
  for (let i = 0; i < 4; i++) f.sync();
  assert.equal(a.song?.songId, 520, 'son titre reste prévu');
  assert.ok(!f.sched.log.some(l => /n'a pas confirmé sa présence/.test(l.msg)));
  assert.equal(f.adds.length, 0);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('PASS', t.name); }
    catch (e) { failed++; console.error('FAIL', t.name, '\n ', e.message); }
  }
  console.log(`${tests.length - failed} PASS, ${failed} FAIL`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
