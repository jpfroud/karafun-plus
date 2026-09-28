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
    globalThis.fixture = { sched, access, sync, publicState, settings, clearEvening, clearQueue,
      setBridge(value) { bridge = value; },
      setIdleSince(value) { idleSince = value; },
      tracked() { return tracked; }, pending() { return pending; } };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.sched.table('1');
  f.access.issue('1');
  const adds = [];
  const removes = [];
  const plays = [];
  const bridge = {
    ready: true, connected: true, queue: [], status: { state: 'idle' },
    add(songId, singer) { adds.push({ songId, singer }); },
    play() { plays.push(Date.now()); }, next() {}, remove(queueId) { removes.push(queueId); },
  };
  f.setBridge(bridge);
  return { ...f, bridge, adds, removes, plays };
}

const song = (id, title = `Titre ${id}`) => ({ songId: id, title, artist: 'Artiste' });
const item = (id, s, singer) => ({ queueId: id, songId: s.songId, title: s.title, artist: s.artist, singer });
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

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
  assert.equal(f.sched.tables.size, 0);
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
  assert.equal(p.sung, 0, 'un titre annulé avant lecture ne consomme pas un tour');
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

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('PASS', t.name); }
  catch (e) { failed++; console.error('FAIL', t.name, '\n ', e.message); }
}
console.log(`${tests.length - failed} PASS, ${failed} FAIL`);
if (failed) process.exitCode = 1;
