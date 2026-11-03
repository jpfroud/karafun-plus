'use strict';
// « Priorité » avant un titre déjà chargé dans KaraFun (décision du gérant du
// 26 octobre) : le titre de la file envoyé pushDelaySec après le début du
// titre en cours, pas encore commencé, sort de KaraFun quand le bar le
// confirme (POST /api/staff/move avec `pullLoaded`), par le même chemin que
// « Pas prêt » (pullFromKaraFun, retrait confirmé par la file réelle de
// KaraFun avant de reprendre les envois), la priorité part, et le titre
// retiré repasse juste après elle sans perdre son tour. Gestionnaires de
// server.js appelés dans un bac à sable (--demo) avec un faux pont KaraFun :
// aucune commande au vrai KaraFun.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { snapshotNight, restoreNight } = require('../night-state');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

// Même harnais que server-staff-routes.test.js : server.js sans son point
// d'entrée, fichiers de données neutralisés.
function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const context = { require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console, Buffer, URL, setTimeout, setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, handlers, access, journal, staffState, publicState, sync, analyze, closingBlocksStart,
      tracked: () => tracked, setTracked: list => { tracked = list; }, setBridge: b => { bridge = b; },
      setPending: p => { pending = p; }, getPending: () => pending, setRestartOp: op => { restartOp = op; }, deferTurn, battleVote,
      // Envoi interrompu par un redémarrage, à vérifier par le bar (restoreNight).
      setRecovered: value => { recoveredPending = value; },
      // Règle d'envoi remplacée, pour un code de sendStop encore inconnu.
      setSendStop: rule => { sendStop = rule; },
      // Écriture de la soirée en échec, comme le catch de saveNight (la démo ne sauvegarde rien).
      failSave: message => { persistenceError = message; settings.auto = false; } };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  // Envoi automatique actif, comme au bar : sans lui, rien ne repartirait
  // après un retrait, qui est alors refusé. Délai d'envoi le plus long que le
  // bar peut régler (trois minutes après le début du titre en cours) : rien ne
  // part vers KaraFun tant qu'un test ne le demande pas (pushDelaySec = 0).
  f.settings.auto = true;
  f.settings.pushDelaySec = 180;
  f.settings.autoPlay = false;
  f.events = [];
  const append = f.journal.append.bind(f.journal);
  f.journal.append = (type, fields) => { f.events.push({ type, ...JSON.parse(JSON.stringify(fields || {})) }); return append(type, fields); };
  f.call = (route, body = {}) => f.handlers[route]({}, {}, body);
  return f;
}

const plain = value => JSON.parse(JSON.stringify(value));
const notes = f => f.sched.log.map(line => line.msg);

function fakeBridge(queue, playingId) {
  const calls = [];
  return { calls, ready: true, connected: true, queue, events: [], permissions: {},
    snapshot: () => ({ ready: true, connected: true, queue, events: [] }),
    status: playingId == null ? { state: 'idle' } : { state: 'playing', songPlaying: { queueId: playingId } },
    add: (songId, singer, pos) => calls.push(['add', songId, pos]), remove: id => calls.push(['remove', id]),
    next: () => calls.push(['next']), play: () => calls.push(['play']) };
}

// Alice chante (suivie, queueId 1), le titre de Bruno est chargé ensuite
// (queueId 2) ; Chloé et Driss attendent dans la file. `duo` : Bruno chante
// avec Zoé, de sa table.
function loaded(f, { duo = false, presence = false } = {}) {
  const join = (tableId, name) => f.sched.join({ tableId, name, headcount: 2 });
  const alice = join('1', 'Alice'), bruno = join('2', 'Bruno');
  const zoe = duo ? f.sched.join({ tableId: '2', name: 'Zoé' }) : null;
  const chloe = join('3', 'Chloé'), driss = join('4', 'Driss');
  if (presence) f.sched.opts.requirePresence = true;
  f.sched.chooseSong(alice, { songId: 801, title: 'Titre Alice' });
  if (duo) {
    const song = f.sched.inviteDuet(bruno, zoe.id, { songId: 802, title: 'Duo Bruno' });
    if (song.duet?.state !== 'accepted') f.sched.answerDuet(zoe, true, song.entryId);
  } else f.sched.chooseSong(bruno, { songId: 802, title: 'Titre Bruno' });
  f.sched.chooseSong(chloe, { songId: 803, title: 'Titre Chloé' });
  f.sched.chooseSong(driss, { songId: 804, title: 'Titre Driss' });
  if (presence) for (const p of [alice, bruno, chloe]) f.sched.confirm(p);
  const stage = f.sched.select(); f.sched.commit(stage);
  assert.equal(stage.ids[0], alice.id);
  f.tracked().push({ queueId: 1, sel: stage, startedAt: Date.now() - 50000, addedAt: Date.now() - 60000 });
  const next = f.sched.select(); f.sched.commit(next);
  assert.equal(next.ids[0], bruno.id);
  const tr = { queueId: 2, sel: next, startedAt: null, addedAt: Date.now() - 5000 };
  f.tracked().push(tr);
  // Zoé choisit aussi un titre à elle, après l'envoi du duo.
  if (duo) f.sched.chooseSong(zoe, { songId: 805, title: 'Titre Zoé' });
  const queue = [{ queueId: 1, songId: 801, title: 'Titre Alice', singer: stage.label, status: 'playing' },
    { queueId: 2, songId: 802, title: next.song.title, singer: next.label }];
  const bridge = fakeBridge(queue, 1);
  f.setBridge(bridge);
  f.sync();
  return { people: { alice, bruno, zoe, chloe, driss }, stage, next, tr, queue, bridge };
}

const planned = f => plain(f.staffState().queue.filter(line => line.source === 'helper' && !line.future));
const move = (f, body) => f.call('POST /api/staff/move', body);
const pullFor = (f, person, queueId = 2) => move(f, { personId: person.id, toIndex: 0, priority: true, pullLoaded: true, queueId });
const removals = bridge => bridge.calls.filter(call => call[0] === 'remove');
// La vraie file de KaraFun confirme le retrait.
function karafunRemoves(f, ctx, queueId = 2) {
  ctx.queue.splice(ctx.queue.findIndex(item => item.queueId === queueId), 1);
  f.sync();
}
// Rien n'a changé dans la file : ni geste, ni priorité, ni retrait.
function nothingChanged(f, ctx) {
  assert.deepEqual(removals(ctx.bridge), [], 'rien n’est retiré de KaraFun');
  assert.deepEqual(f.sched.manualChanges, [], 'aucun geste n’est noté');
  assert.notEqual(f.sched.reservedNext?.byStaff, true, 'aucune priorité');
  assert.equal(ctx.tr.pulled ?? null, null);
}

test('priorité confirmée : le titre chargé sort de KaraFun, la priorité part, il repasse juste après', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno, driss } = ctx.people;
  assert.deepEqual(plain(f.staffState().priorityPull), { queueId: 2, title: 'Titre Bruno', name: 'Bruno', ids: [bruno.id],
    lineIds: [ctx.people.chloe.id, driss.id] }, 'la page du bar sait quel titre proposer de retirer, et pour quelles lignes');
  const result = plain(await pullFor(f, driss));
  assert.equal(result.message, '« Titre Bruno » sort de KaraFun : Driss passe d’abord, « Titre Bruno » juste après.');
  assert.deepEqual(result.pulled, { queueId: 2, title: 'Titre Bruno' });
  assert.deepEqual(removals(ctx.bridge), [['remove', 2]]);
  assert.equal(f.sched.reservedNext?.personId, driss.id);
  assert.equal(f.sched.reservedNext?.byStaff, true);
  // `forAt`, `changeId` : l'heure d'annonce de la priorité de ce geste, et ce
  // geste (passe 17).
  assert.deepEqual(plain(ctx.tr.pulled), { reason: 'priority', at: ctx.tr.pulled.at, forId: driss.id,
    forAt: f.sched.reservedNext.reservedAt, changeId: f.sched.manualChanges.at(-1).id });
  assert.ok(notes(f).includes('Le bar fait passer Driss avant « Titre Bruno » (Bruno · Table 2) : ce titre sort de KaraFun et repasse juste après, sans perdre son tour'));
  let state = plain(f.staffState());
  assert.equal(state.queue.find(line => line.queueId === 2).leaving, 'priority', 'la ligne KaraFun dit que le titre en sort');
  assert.equal(state.priorityPull, null, 'plus rien à proposer pendant le retrait');
  assert.equal(state.queue.find(line => line.source === 'helper').id, driss.id);

  // Rien ne part tant que la vraie file de KaraFun garde le titre.
  f.settings.auto = true;
  f.settings.pushDelaySec = 0;
  f.sync();
  assert.equal(f.getPending(), null, 'aucun envoi avant la confirmation du retrait');
  karafunRemoves(f, ctx);
  assert.ok(notes(f).includes('« Titre Bruno » (Bruno · Table 2) retiré de KaraFun : il repasse juste après Driss (priorité du bar), sans perdre son tour'));
  assert.equal(f.getPending()?.sel.ids[0], driss.id, 'retrait confirmé : la priorité part vers KaraFun');
  assert.deepEqual(ctx.bridge.calls.at(-1).slice(0, 2), ['add', 804]);
  state = plain(f.staffState());
  const back = state.queue.find(line => line.source === 'helper' && line.id === bruno.id);
  assert.equal(back.song.title, 'Titre Bruno');
  assert.equal(back.afterPriority, true, 'repère « Après la priorité »');
  assert.equal(back.deferred, false, 'pas un « Pas prêt »');
  const phone = plain(f.publicState(null, '2').tablePeople.find(p => p.id === bruno.id));
  assert.equal(phone.deferral, null, 'son téléphone ne parle pas de « Pas prêt »');

  // KaraFun accuse l'envoi de Driss : Bruno est le prochain annoncé.
  ctx.queue.push({ queueId: 3, songId: 804, title: 'Titre Driss', singer: f.getPending().sel.label });
  f.sync();
  assert.equal(f.sched.reservedNext?.personId, bruno.id);
  const first = planned(f)[0];
  assert.equal(first.id, bruno.id);
  assert.equal(first.guaranteed, true);
  assert.equal(f.sched.select().song.title, 'Titre Bruno');
  assert.equal(bruno.sung, 0, 'son passage retiré n’a pas compté');
  const moves = f.events.filter(e => e.type === 'staff.move');
  assert.equal(moves.at(-1).kind, 'priority');
  assert.equal(moves.at(-1).pulledEntryId, ctx.next.song.entryId);
  assert.ok(f.events.some(e => e.type === 'turn.unsent' && e.reason === 'pulled-priority'));
  assert.ok(!f.events.some(e => /^defer\./.test(e.type)), 'aucun « Pas prêt » au journal de soirée');
});

test('priorité confirmée : le titre chargé a commencé pendant la confirmation, refus clair et rien retiré', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { driss } = ctx.people;
  assert.equal(f.staffState().priorityPull.queueId, 2);
  // Alice termine et KaraFun lance le titre de Bruno pendant la question.
  ctx.queue.shift();
  ctx.queue[0].status = 'playing';
  ctx.bridge.status = { state: 'playing', songPlaying: { queueId: 2 } };
  f.sync();
  await assert.rejects(pullFor(f, driss), { message: '« Titre Bruno » a commencé pendant ta confirmation : rien n’a été retiré de KaraFun ni avancé. ' +
    'Touche de nouveau « Priorité » pour faire passer Driss juste après.' });
  nothingChanged(f, ctx);
  assert.equal(f.staffState().priorityPull, null);
});

test('priorité confirmée : KaraFun déconnecté ou qui refuse le retrait, rien n’est perdu', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { driss } = ctx.people;
  ctx.bridge.ready = false;
  assert.equal(f.staffState().priorityPull, null, 'KaraFun déconnecté : rien à proposer');
  await assert.rejects(pullFor(f, driss), { message: 'KaraFun est déconnecté : rien n’a été retiré ni avancé. Réessaie une fois KaraFun reconnecté.' });
  nothingChanged(f, ctx);
  ctx.bridge.ready = true;
  ctx.bridge.remove = () => { throw new Error('socket fermée'); };
  await assert.rejects(pullFor(f, driss), { message: 'KaraFun n’a pas pu retirer « Titre Bruno » (socket fermée) : rien n’a changé.' });
  nothingChanged(f, ctx);
  assert.equal(planned(f)[0].id, ctx.people.chloe.id, 'la file reste comme avant');
});

// Relecture : le retrait sortait le seul titre chargé de KaraFun alors que
// l'application n'enverrait plus rien ensuite (envoi automatique coupé par le
// bar, après une sauvegarde impossible, ou quand KaraFun retire le droit
// d'ajout) : ni la priorité ni le titre retiré ne partaient, et la scène
// restait vide après le titre en cours.
test('priorité avec retrait, envoi automatique coupé (bar, sauvegarde, droits KaraFun) : rien n’est retiré, la priorité sans retrait reste possible', async () => {
  const after = ' : rien n’a été retiré ni avancé. « Priorité » sans retrait fait passer la personne juste après lui.';
  const cases = [
    ['coupé par le bar', f => f.call('POST /api/staff/settings', { auto: false }), `L’envoi automatique vers KaraFun est coupé${after}`],
    ['sauvegarde impossible', f => f.failSave('disque plein'), `La sauvegarde de la soirée est impossible, l’envoi automatique est suspendu${after}`],
    ['droit d’ajout retiré, avant le balayage', (f, ctx) => { ctx.bridge.permissions.addToQueue = false; }, `KaraFun refuse l’ajout de titres${after}`],
    ['droit d’ajout retiré, envoi coupé par le balayage', (f, ctx) => {
      ctx.bridge.permissions.addToQueue = false;
      f.sync();
      assert.equal(f.settings.auto, false);
    }, `KaraFun refuse l’ajout de titres${after}`],
  ];
  for (const [how, cut, message] of cases) {
    const f = harness();
    const ctx = loaded(f);
    const { driss } = ctx.people;
    assert.equal(f.staffState().priorityPull?.queueId, 2, `${how} : envoi actif, le retrait est proposé`);
    await cut(f, ctx);
    assert.equal(f.staffState().priorityPull, null, `${how} : la page ne propose plus le retrait`);
    await assert.rejects(pullFor(f, driss), { message }, how);
    nothingChanged(f, ctx);
    assert.ok(ctx.queue.some(item => item.queueId === 2), `${how} : le titre de Bruno reste dans KaraFun`);
    // La priorité sans retrait reste celle d'avant.
    const result = plain(await move(f, { personId: driss.id, toIndex: 0, priority: true }));
    assert.equal(result.message, 'Driss passe juste après « Titre Bruno », déjà chargé dans KaraFun.', how);
    assert.deepEqual(removals(ctx.bridge), [], how);
    assert.equal(f.sched.reservedNext?.personId, driss.id, how);
  }
});

// Même règle que l'envoi (sendStop) : une Battle en attente d'une place laisse
// partir un passage annoncé, donc la priorité ; une Battle que le bar organise
// à la main retient les envois, et le retrait viderait KaraFun.
test('priorité avec retrait et Battle demandée : permise si la Battle attend une place, refusée si elle retient les envois', async () => {
  {
    const f = harness();
    const ctx = loaded(f);
    f.battleVote.staffLaunch({ song: { songId: 990, title: 'Battle du bar', artist: 'Groupe' } });
    assert.equal(f.battleVote.automation.status, 'waiting');
    f.sync();
    assert.equal(f.staffState().priorityPull?.queueId, 2, 'Battle en attente : le retrait est proposé');
    await pullFor(f, ctx.people.driss);
    assert.deepEqual(removals(ctx.bridge), [['remove', 2]]);
    f.settings.pushDelaySec = 0;
    karafunRemoves(f, ctx);
    assert.equal(f.getPending()?.sel.ids[0], ctx.people.driss.id, 'la priorité part avant la Battle');
  }
  {
    const f = harness();
    const ctx = loaded(f);
    f.battleVote.staffLaunch({ song: { songId: 990, title: 'Battle du bar', artist: 'Groupe' } });
    f.battleVote.resolve({ outcome: 'done' });
    assert.equal(f.battleVote.automation.status, 'manual', 'le bar lance la Battle lui-même');
    f.sync();
    assert.equal(f.staffState().priorityPull, null);
    await assert.rejects(pullFor(f, ctx.people.driss), { message: 'La Battle retient les envois vers KaraFun : rien n’a été retiré ni avancé. ' +
      '« Priorité » sans retrait fait passer la personne juste après lui.' });
    nothingChanged(f, ctx);
  }
});

// Relecture : le refus d'un envoi interrompu à vérifier (recoveredPending,
// après un redémarrage) n'avait pas de test, et un code de sendStop sans
// message dans PULL_STOPS donnait un refus vide : le retrait partait alors
// que rien ne repartirait ensuite vers KaraFun, et la scène restait vide.
test('priorité avec retrait, envoi interrompu à vérifier ou envoi retenu pour une raison sans message : rien n’est retiré', async () => {
  const after = ' : rien n’a été retiré ni avancé. « Priorité » sans retrait fait passer la personne juste après lui.';
  {
    const f = harness();
    const ctx = loaded(f);
    const { driss } = ctx.people;
    f.setRecovered(true);
    assert.equal(f.staffState().priorityPull, null, 'pas de question tant que l’envoi interrompu attend le bar');
    await assert.rejects(pullFor(f, driss), { message: `Un envoi interrompu est à vérifier dans KaraFun${after}` });
    nothingChanged(f, ctx);
    const result = plain(await move(f, { personId: driss.id, toIndex: 0, priority: true }));
    assert.equal(result.message, 'Driss passe juste après « Titre Bruno », déjà chargé dans KaraFun.');
    assert.deepEqual(removals(ctx.bridge), []);
  }
  {
    // Une raison ajoutée à sendStop sans message ici : refusé quand même.
    const f = harness();
    const ctx = loaded(f);
    f.setSendStop(() => 'raison-nouvelle');
    assert.equal(f.staffState().priorityPull, null, 'pas de question');
    await assert.rejects(pullFor(f, ctx.people.driss), { message: `Les envois vers KaraFun sont retenus${after}` });
    nothingChanged(f, ctx);
  }
});

test('priorité confirmée : KaraFun garde le titre, le bar est prévenu ; lancé quand même, la priorité passe juste après', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno, driss } = ctx.people;
  await pullFor(f, driss);
  ctx.tr.pulled.at = Date.now() - 46000;
  f.sync(); f.sync();
  const alert = 'KaraFun n’a pas retiré « Titre Bruno » (Bruno · Table 2) pour la priorité de Driss : retire-le dans KaraFun, ou lance-le ; Driss passera juste après lui.';
  assert.equal(notes(f).filter(msg => msg === alert).length, 1, 'le bar est prévenu une fois');
  assert.equal(f.sched.log.find(line => line.msg === alert).kind, 'error');
  // Alice termine ; le bar lance le titre de Bruno dans KaraFun.
  ctx.queue.shift();
  ctx.queue[0].status = 'playing';
  ctx.bridge.status = { state: 'playing', songPlaying: { queueId: 2 } };
  f.sync();
  assert.equal(ctx.tr.pulled, null, 'le titre lancé continue');
  assert.ok(ctx.tr.startedAt);
  assert.ok(notes(f).includes('« Titre Bruno » a commencé avant son retrait de KaraFun ; il continue, Driss passe juste après.'));
  assert.equal(f.sched.reservedNext?.personId, driss.id);
  assert.equal(f.sched.reservedNext?.byStaff, true, 'la priorité tient');
  assert.equal(bruno.deferral ?? null, null, 'aucun report fantôme');
});

test('priorité pendant un envoi, avec une Battle ou d’autres titres dans KaraFun : rien n’est retiré', async () => {
  {
    const f = harness();
    const ctx = loaded(f);
    f.setPending({ sel: f.sched.select(), before: new Set([1, 2]), at: Date.now(), attempts: 1 });
    assert.equal(f.staffState().priorityPull, null);
    await assert.rejects(pullFor(f, ctx.people.driss), { message: 'Un titre part vers KaraFun en ce moment : rien n’a été retiré ni avancé. Réessaie dans un instant.' });
    nothingChanged(f, ctx);
  }
  {
    // Battle chargée après le titre en cours : jamais retirée par ce geste.
    const f = harness();
    const ctx = loaded(f);
    f.setTracked(f.tracked().filter(item => item !== ctx.tr));
    ctx.queue[1] = { queueId: 9, songId: 806, title: 'La Battle', singer: 'Battle collective',
      options: { mod: { id: 3, caption: 'Battle', data: { battle: { subtype: 1 } } } } };
    f.sync();
    assert.equal(f.staffState().priorityPull, null, 'pas de question pour une Battle');
    await assert.rejects(pullFor(f, ctx.people.driss, 9), { message: 'Une Battle chargée dans KaraFun ne sort jamais pour une priorité : rien n’a été retiré ni avancé.' });
    assert.deepEqual(removals(ctx.bridge), []);
    assert.deepEqual(f.sched.manualChanges, []);
    const plainPriority = plain(await move(f, { personId: ctx.people.driss.id, toIndex: 0, priority: true }));
    assert.equal(plainPriority.message, 'Passage avancé à la première place libre, après 1 titre déjà chargé dans KaraFun.');
    assert.deepEqual(removals(ctx.bridge), [], 'la priorité sans retrait passe après la Battle');
  }
  {
    // Un titre ajouté à la main dans KaraFun après le nôtre.
    const f = harness();
    const ctx = loaded(f);
    ctx.queue.push({ queueId: 7, songId: 807, title: 'À la main', singer: 'Yann' });
    f.sync();
    assert.equal(f.staffState().priorityPull, null);
    await assert.rejects(pullFor(f, ctx.people.driss), { message: 'D’autres titres attendent dans KaraFun : rien n’a été retiré ni avancé. « Priorité » sans retrait fait passer la personne après eux.' });
    nothingChanged(f, ctx);
  }
  // Relecture : trois refus de priorityPullCheck n'avaient pas de test.
  {
    // « Relancer depuis le début » en cours sur le titre d'Alice.
    const f = harness();
    const ctx = loaded(f);
    f.setRestartOp({ songId: 801, singer: ctx.stage.label, title: 'Titre Alice', before: ['1', '2'], at: Date.now(),
      phase: 'adding', originalQueueId: 1, trackedQueueId: 1 });
    assert.equal(f.staffState().priorityPull, null, 'pas de question pendant la relance');
    await assert.rejects(pullFor(f, ctx.people.driss), { message: 'Le titre en cours est en train d’être relancé : rien n’a été retiré ni avancé. Réessaie dans un instant.' });
    nothingChanged(f, ctx);
  }
  {
    // « Vider toutes les chansons » attend la confirmation de KaraFun.
    const f = harness();
    const ctx = loaded(f);
    f.settings.queueClearPending = true;
    assert.equal(f.staffState().priorityPull, null, 'pas de question pendant le vidage');
    await assert.rejects(pullFor(f, ctx.people.driss), { message: 'La file est en train d’être vidée : rien n’a été retiré ni avancé.' });
    nothingChanged(f, ctx);
  }
  {
    // Seconde confirmation pendant que le premier retrait est en route : le
    // titre est déjà en train de sortir, rien n'est retiré ni avancé deux fois.
    const f = harness();
    const ctx = loaded(f);
    await pullFor(f, ctx.people.driss);
    assert.deepEqual(removals(ctx.bridge), [['remove', 2]]);
    assert.ok(ctx.tr.pulled, 'premier retrait en route');
    const gestures = f.sched.manualChanges.length;
    const message = 'Le titre chargé dans KaraFun a changé : rien n’a été retiré ni avancé. Touche de nouveau « Priorité ».';
    await assert.rejects(pullFor(f, ctx.people.chloe), { message });
    assert.deepEqual(removals(ctx.bridge), [['remove', 2]], 'un seul retrait envoyé');
    assert.equal(f.sched.manualChanges.length, gestures, 'aucun second geste');
    assert.equal(f.sched.reservedNext?.personId, ctx.people.driss.id, 'la première priorité tient');
    // Titre marqué absent par le bar (« Absent ») : même refus.
    const g = harness();
    const other = loaded(g);
    other.tr.absent = true;
    await assert.rejects(pullFor(g, other.people.driss), { message });
    assert.deepEqual(removals(other.bridge), []);
    assert.deepEqual(g.sched.manualChanges, []);
    assert.notEqual(g.sched.reservedNext?.byStaff, true);
  }
});

test('priorité sans retrait (« Annuler » à la question) : comportement d’avant, la page le dit', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { chloe, driss } = ctx.people;
  const result = plain(await move(f, { personId: driss.id, toIndex: 0, priority: true }));
  assert.equal(result.message, 'Driss passe juste après « Titre Bruno », déjà chargé dans KaraFun.');
  assert.deepEqual(removals(ctx.bridge), [], 'rien n’est retiré de KaraFun d’office');
  assert.equal(f.sched.reservedNext?.personId, driss.id);
  // Le premier passage libre peut aussi passer avant le titre chargé.
  const g = harness();
  const other = loaded(g);
  await assert.rejects(move(g, { personId: other.people.chloe.id, toIndex: 0, priority: true }),
    { message: 'Ce titre est déjà le prochain passage libre. 1 titre est déjà chargé dans KaraFun devant lui.' });
  await pullFor(g, other.people.chloe);
  assert.deepEqual(removals(other.bridge), [['remove', 2]]);
  assert.equal(g.sched.reservedNext?.personId, other.people.chloe.id);
  assert.ok(chloe);
});

test('priorité avant un duo chargé : il revient entier juste après ; son invitée ne passe pas avant lui', async () => {
  const f = harness();
  const ctx = loaded(f, { duo: true });
  const { bruno, zoe, driss } = ctx.people;
  assert.equal(ctx.next.ids[1], zoe.id, 'le duo de Bruno et Zoé est chargé');
  assert.deepEqual(plain(f.staffState().priorityPull.ids), [bruno.id, zoe.id]);
  assert.ok(!f.staffState().priorityPull.lineIds.includes(zoe.id), 'la page ne propose pas le retrait à Zoé');
  await assert.rejects(pullFor(f, zoe), { message: 'Zoé chante déjà dans « Duo Bruno » : rien n’a été retiré ni avancé.' });
  assert.deepEqual(removals(ctx.bridge), []);
  assert.equal(zoe.duetGuestCount, 1);
  await pullFor(f, driss);
  karafunRemoves(f, ctx);
  assert.equal(zoe.duetGuestCount, 0, 'le passage de l’invitée n’a pas eu lieu');
  const order = planned(f);
  assert.deepEqual(order.slice(0, 2).map(line => line.name), ['Driss', 'Bruno & Zoé']);
  assert.equal(order[1].afterPriority, true);
});

// Relecture, passe 5 (équipe rouge) : l'invitée marquée « Parti » pendant que
// le duo sortait de KaraFun restait sur le titre (keepSentDuosOfLeavers
// sautait les titres en train de sortir, Scheduler#leave ne voit que les
// listes). Revenu en tête de la liste de son auteur, il restait un duo avec
// une personne partie, et la place « juste après la priorité » tombait.
test('duo chargé qui sort de KaraFun, invitée marquée partie pendant le retrait : le titre revient au nom de son auteur seul', async () => {
  for (const how of ['priorité avant le duo', 'Pas prêt de Bruno', 'absent à l’appel']) {
    const f = harness();
    const ctx = loaded(f, { duo: true });
    const { bruno, zoe, driss } = ctx.people;
    if (how === 'priorité avant le duo') await pullFor(f, driss);
    else if (how === 'Pas prêt de Bruno') f.deferTurn(bruno, 1);
    else await f.call('POST /api/staff/kf', { action: 'absent', queueId: 2 });
    assert.deepEqual(removals(ctx.bridge), [['remove', 2]], `${how} : le duo sort de KaraFun`);
    await f.call('POST /api/staff/person/leave', { personId: zoe.id });
    // Passe 6 : le bar et Bruno lisaient la note d'un duo qui reste chargé
    // (« KaraFun affiche encore les deux noms »), pour un titre que KaraFun retire.
    assert.deepEqual(notes(f).filter(msg => msg.includes('KaraFun affiche encore')), [], `${how} : journal du bar`);
    assert.ok(notes(f).includes('Zoé est parti : « Duo Bruno », en train de sortir de KaraFun, revient à Bruno en solo'),
      `${how} : ${notes(f).slice(-3).join(' | ')}`);
    assert.deepEqual(plain(bruno.inbox.filter(n => n.kind === 'duoLeft').map(n => n.params)),
      [{ name: 'Zoé', title: 'Duo Bruno', sent: false }], `${how} : le téléphone de Bruno ne parle pas des deux noms dans KaraFun`);
    karafunRemoves(f, ctx);
    assert.equal(bruno.song.entryId, ctx.next.song.entryId, `${how} : le titre revient en tête de la liste de Bruno`);
    assert.equal(bruno.song.duet, undefined, `${how} : plus de duo avec Zoé, partie`);
    const phone = f.publicState(null, '2', new Set([bruno.id])).tablePeople.find(p => p.id === bruno.id);
    assert.equal(phone.duet, null, `${how} : son téléphone ne montre plus le duo`);
    const order = planned(f);
    assert.ok(order.some(line => line.name === 'Bruno') && !order.some(line => line.ids.includes(zoe.id)), `${how} : ${order.map(line => line.name)}`);
    if (how === 'priorité avant le duo') {
      assert.deepEqual(order.slice(0, 2).map(line => line.name), ['Driss', 'Bruno'], 'il repasse juste après la priorité');
      assert.equal(order[1].afterPriority, true);
    }
    if (how === 'Pas prêt de Bruno') assert.equal(f.sched.isDeferred(bruno), true, 'son « Pas prêt » tient toujours');
  }
});

test('priorité avant un titre chargé avec « Je suis là » : la priorité déjà confirmée part, le titre retiré garde sa confirmation', async () => {
  const f = harness();
  const ctx = loaded(f, { presence: true });
  const { bruno, driss } = ctx.people;
  // Driss a répondu « Je suis là » il y a peu (il était le prochain avant
  // l'envoi du titre de Bruno, par exemple) : il peut partir juste après le retrait.
  f.sched.confirm(driss);
  f.sync();
  assert.ok(plain(f.staffState().priorityPull.lineIds).includes(driss.id), 'le retrait est proposé pour Driss');
  await pullFor(f, driss);
  assert.deepEqual(plain(f.staffState().presencePending), [], 'pendant le retrait, personne n’est appelé');
  karafunRemoves(f, ctx);
  assert.deepEqual(plain(f.staffState().presencePending), [], 'sa présence est déjà confirmée : rien ne retient la priorité');
  assert.deepEqual(f.sched.select().ids, [driss.id]);
  f.sched.commit(f.sched.select());
  assert.equal(f.sched.reservedNext?.personId, bruno.id);
  assert.equal(bruno.held, 0, 'pas compté absent');
  assert.ok(f.sched.confirmedForTurn([bruno.id]), 'son « Je suis là » donné pour ce titre tient');
});

// Relecture : avec « Je suis là » obligatoire, le retrait était accepté pour
// une personne qui n'avait pas encore confirmé (priorityPullCheck reprenait
// la règle d'envoi de sync(), sendStop, mais pas son attente de la présence).
// Le titre chargé, confirmé, sortait de KaraFun ; la scène attendait la
// réponse de la priorité, la sautait après presenceGraceSec et rejouait le
// titre retiré après un silence, avec un « Absent ×1 » pour elle.
test('priorité avec retrait, « Je suis là » obligatoire, priorité pas encore confirmée : rien n’est retiré, la priorité sans retrait reste possible', async () => {
  {
    const f = harness();
    const ctx = loaded(f, { presence: true });
    const { chloe, driss } = ctx.people;
    assert.equal(f.sched.confirmedForTurn([driss.id]), false, 'Driss n’a pas répondu');
    assert.deepEqual(plain(f.staffState().priorityPull.lineIds), [chloe.id], 'pas de retrait proposé à Driss');
    await assert.rejects(pullFor(f, driss), { message: 'Driss n’a pas encore confirmé « Je suis là » : « Titre Bruno » reste dans KaraFun, ' +
      'rien n’a été retiré ni avancé. « Priorité » sans retrait fait passer Driss juste après lui.' });
    nothingChanged(f, ctx);
    // La priorité sans retrait : Driss passe juste après le titre de Bruno, et
    // sa présence lui est demandée pendant toute la durée de ce titre.
    const result = plain(await move(f, { personId: driss.id, toIndex: 0, priority: true }));
    assert.equal(result.message, 'Driss passe juste après « Titre Bruno », déjà chargé dans KaraFun.');
    assert.deepEqual(removals(ctx.bridge), []);
    assert.equal(f.sched.reservedNext?.personId, driss.id);
    ctx.queue.shift(); // Alice a fini, KaraFun lance le titre de Bruno
    ctx.queue[0].status = 'playing';
    ctx.bridge.status = { state: 'playing', songPlaying: { queueId: 2 } };
    f.sync();
    assert.deepEqual(plain(f.staffState().presencePending), ['Driss'], 'Driss est appelé pendant « Titre Bruno »');
  }
  {
    // Duo : la réponse de l'un des deux suffit, comme pour « Je suis là ».
    const f = harness();
    const ctx = loaded(f, { presence: true });
    const { driss } = ctx.people;
    const gus = f.sched.join({ tableId: '4', name: 'Gus' });
    f.sched.removeSong(driss, driss.song.entryId);
    const song = f.sched.inviteDuet(driss, gus.id, { songId: 813, title: 'Duo Driss' });
    if (song.duet?.state !== 'accepted') f.sched.answerDuet(gus, true, song.entryId);
    f.sched.confirm(gus);
    f.sync();
    assert.deepEqual(planned(f).find(line => line.id === driss.id)?.ids, [driss.id, gus.id], 'la ligne est le duo de Driss et Gus');
    assert.ok(plain(f.staffState().priorityPull.lineIds).includes(driss.id), 'Gus a confirmé : le retrait est proposé');
    await pullFor(f, driss);
    assert.deepEqual(removals(ctx.bridge), [['remove', 2]]);
  }
});

test('priorité avant un titre chargé, puis fermeture : refus si le titre retiré ne passerait plus', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { current } = f.analyze();
  const now = Date.now();
  let at = null;
  for (let s = 60; s <= 1800 && at === null; s += 5) {
    f.settings.closingAt = now + s * 1000;
    if (f.closingBlocksStart(current, 1, now) && !f.closingBlocksStart(current, 0, now)) at = f.settings.closingAt;
  }
  assert.ok(at, 'une heure de fermeture où seul le titre retiré ne passerait plus');
  assert.equal(f.staffState().priorityPull, null);
  await assert.rejects(pullFor(f, ctx.people.driss), error => /^Fermeture à \d\d:\d\d : « Titre Bruno » ne passerait plus après la priorité\. Rien n’a été retiré ni avancé ;/.test(error.message));
  nothingChanged(f, ctx);
});

// Relecture de la correction : le titre retiré laissait quand même passer
// quelqu'un d'autre (Chloé) quand la priorité ne tenait plus.
test('priorité avant un titre chargé qui ne tient plus : le titre retiré reprend sa place', async () => {
  for (const how of ['annulée pendant le retrait', 'annulée après le retrait', 'Recalculer la file', 'titre de la priorité retiré']) {
    const f = harness();
    const ctx = loaded(f);
    const { bruno, chloe, driss } = ctx.people;
    assert.deepEqual(planned(f).map(line => line.id), [chloe.id, driss.id], 'Bruno est chargé dans KaraFun');
    await pullFor(f, driss);
    if (how !== 'annulée pendant le retrait') karafunRemoves(f, ctx);
    if (how.startsWith('annulée')) await f.call('POST /api/staff/priority-undo');
    if (how === 'Recalculer la file') await f.call('POST /api/staff/queue-recalculate');
    if (how === 'titre de la priorité retiré') await f.call('POST /api/staff/remove', { personId: driss.id });
    if (how === 'annulée pendant le retrait') {
      karafunRemoves(f, ctx);
      assert.ok(notes(f).includes('« Titre Bruno » (Bruno · Table 2) retiré de KaraFun : la priorité de Driss ne tient plus, il reprend sa place sans perdre son tour'));
    }
    const order = planned(f);
    assert.equal(order[0].id, bruno.id, `${how} : Bruno reprend sa place, en tête`);
    assert.equal(order[0].guaranteed, true, `${how} : il est le prochain annoncé`);
    assert.ok(!order[0].afterPriority, how);
    assert.equal(order[1].id, chloe.id, how);
    assert.equal(f.sched.select().ids[0], bruno.id, how);
  }
});

// Relecture (passe 16, équipe rouge) : le bar donne « Priorité » à Eve, qui
// passe juste après « Titre Bruno », chargé dans KaraFun, puis à Driss avec
// retrait de ce titre, et annule ce dernier geste. L'annonce d'Eve revenait,
// et Eve passait devant « Titre Bruno » revenu de KaraFun, alors que la
// réponse disait « ordre précédent retrouvé » : avant le geste, Bruno passait
// avant elle. Annulé pendant l'envoi de la priorité, Driss part d'abord
// (déjà envoyé), puis Bruno, puis Eve, comme sans l'annulation.
test('priorité avec retrait annulée, une priorité plus ancienne annoncée après le titre chargé : le titre retiré repasse devant elle', async () => {
  for (const how of ['annulée pendant le retrait', 'annulée après le retrait', 'annulée pendant l’envoi de la priorité']) {
    const f = harness();
    const ctx = loaded(f);
    const { bruno, driss } = ctx.people;
    const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
    f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
    f.sync();
    const first = plain(await move(f, { personId: eve.id, toIndex: 0, priority: true }));
    assert.equal(first.message, 'Eve passe juste après « Titre Bruno », déjà chargé dans KaraFun.', how);
    await pullFor(f, driss);
    assert.deepEqual(removals(ctx.bridge), [['remove', 2]], how);
    if (how !== 'annulée pendant le retrait') karafunRemoves(f, ctx);
    if (how === 'annulée pendant l’envoi de la priorité') {
      f.settings.pushDelaySec = 0;
      f.sync();
      assert.equal(f.getPending()?.sel.ids[0], driss.id, `${how} : la priorité part vers KaraFun`);
    }
    await f.call('POST /api/staff/priority-undo');
    if (how === 'annulée pendant le retrait') karafunRemoves(f, ctx);
    if (how === 'annulée pendant l’envoi de la priorité') {
      ctx.queue.push({ queueId: 3, songId: 804, title: 'Titre Driss', singer: f.getPending().sel.label });
      f.sync();
      assert.equal(driss.sung, 1, `${how} : Driss, déjà envoyé, chante d’abord`);
    }
    const order = planned(f);
    assert.deepEqual(order.slice(0, 2).map(line => line.id), [bruno.id, eve.id], `${how} : Bruno reprend sa place devant Eve`);
    assert.equal(order[0].guaranteed, true, `${how} : il est le prochain annoncé`);
    assert.equal(f.sched.select().ids[0], bruno.id, how);
  }
});

// Pendant le retrait, le bar donne une nouvelle priorité, à Gus : la sienne
// tient au retour du titre. Seule une annonce plus ancienne que la priorité
// du geste (Eve, qui suivait le titre dans KaraFun), rendue par une
// annulation, cède sa place au titre retiré.
test('priorité avec retrait, puis nouvelle priorité pendant le retrait : la nouvelle tient au retour du titre', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno, driss } = ctx.people;
  const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
  const gus = f.sched.join({ tableId: '6', name: 'Gus', headcount: 2 });
  f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
  f.sched.chooseSong(gus, { songId: 810, title: 'Titre Gus' });
  f.sync();
  await move(f, { personId: eve.id, toIndex: 0, priority: true });
  const eveAt = f.sched.reservedNext.reservedAt;
  await pullFor(f, driss);
  assert.equal(ctx.tr.pulled.forAt, f.sched.reservedNext.reservedAt, 'le retrait note l’heure d’annonce de la priorité du geste');
  assert.ok(ctx.tr.pulled.forAt > eveAt, 'plus récente que l’annonce d’Eve, qui suivait le titre');
  await move(f, { personId: gus.id, toIndex: 0, priority: true });
  assert.ok(f.sched.reservedNext.reservedAt > ctx.tr.pulled.forAt, 'la priorité de Gus est plus récente que le geste');
  assert.equal(f.sched.reservedNext?.personId, gus.id);
  karafunRemoves(f, ctx);
  assert.ok(notes(f).includes('« Titre Bruno » (Bruno · Table 2) retiré de KaraFun : la priorité de Driss ne tient plus, il reprend sa place sans perdre son tour'));
  assert.equal(f.sched.reservedNext?.personId, gus.id, 'la priorité donnée pendant le retrait tient');
  assert.equal(planned(f)[0].id, gus.id);
  assert.equal(f.sched.select().ids[0], gus.id);
  assert.ok(bruno);
});

// Le titre revenu attend juste après la priorité de Driss ; le bar déplace
// Eve puis annule ce déplacement : la priorité tient, le titre ne lui prend
// pas l'annonce.
test('priorité avec retrait, titre revenu, puis un autre geste annulé : la priorité tient, le titre reste juste après', async () => {
  for (const undo of ['exacte', 'recalculée']) {
    const f = harness();
    const ctx = loaded(f);
    const { bruno, chloe, driss } = ctx.people;
    const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
    f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
    f.sync();
    await pullFor(f, driss);
    karafunRemoves(f, ctx);
    assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [driss.id, bruno.id]);
    const moved = plain(await move(f, { personId: eve.id, toIndex: 2 }));
    assert.equal(moved.ok, true);
    // Annulation recalculée : la file a changé depuis le geste.
    if (undo === 'recalculée') f.sched.chooseSong(chloe, { songId: 811, title: 'Autre titre Chloé' });
    const result = plain(await f.call('POST /api/staff/manual-change-undo', { id: f.sched.manualChanges.at(-1).id }));
    assert.equal(result.exact, undo === 'exacte', undo);
    assert.equal(f.sched.reservedNext?.personId, driss.id, `${undo} : la priorité de Driss tient`);
    const order = planned(f);
    assert.deepEqual(order.slice(0, 2).map(line => line.id), [driss.id, bruno.id], undo);
    assert.equal(order[1].afterPriority, true, undo);
  }
});

// Relecture (passe 16) : Rita n'a pas répondu « Je suis là » ; l'envoi de
// « Titre Bruno » l'annonce ensuite. Le bar donne la priorité à Chloé avec
// retrait de ce titre, puis l'annule une fois le titre revenu (annulation
// recalculée, « Recalculer la file »), ou pendant l'envoi de Chloé. L'annonce
// de Rita revenait, devant « Titre Bruno » : la scène attendait sa réponse,
// puis la sautait une deuxième fois. Le titre retiré repasse d'abord, comme
// avec l'annulation faite avant le retrait.
test('priorité avec retrait annulée après le retrait, une personne sautée faute de « Je suis là » annoncée après le titre chargé : le titre retiré repasse devant elle', async () => {
  for (const how of ['annulée après le retrait', 'Recalculer la file', 'annulée pendant l’envoi de la priorité']) {
    const f = harness();
    f.sched.opts.requirePresence = true;
    const join = (tableId, name) => f.sched.join({ tableId, name, headcount: 2 });
    const alice = join('1', 'Alice'), rita = join('2', 'Rita'), bruno = join('3', 'Bruno'), chloe = join('4', 'Chloé'), driss = join('5', 'Driss');
    [[alice, 801], [rita, 806], [bruno, 802], [chloe, 803], [driss, 804]].forEach(([p, songId]) =>
      f.sched.chooseSong(p, { songId, title: `Titre ${p.name}` }));
    for (const p of [alice, bruno, chloe]) f.sched.confirm(p);
    const stage = f.sched.select(); f.sched.commit(stage);
    assert.equal(stage.ids[0], alice.id);
    f.tracked().push({ queueId: 1, sel: stage, startedAt: Date.now() - 50000, addedAt: Date.now() - 60000 });
    f.sched.skipUnconfirmed(rita.id, 3);
    const next = f.sched.select(); f.sched.commit(next);
    assert.equal(next.ids[0], bruno.id, 'Rita, sautée, laisse passer Bruno');
    assert.equal(f.sched.reservedNext?.personId, rita.id, 'l’envoi de Bruno annonce Rita ensuite');
    const tr = { queueId: 2, sel: next, startedAt: null, addedAt: Date.now() - 5000 };
    f.tracked().push(tr);
    const queue = [{ queueId: 1, songId: 801, title: 'Titre Alice', singer: stage.label, status: 'playing' },
      { queueId: 2, songId: 802, title: 'Titre Bruno', singer: next.label }];
    const ctx = { queue, tr, bridge: fakeBridge(queue, 1) };
    f.setBridge(ctx.bridge);
    f.sync();
    await pullFor(f, chloe);
    assert.deepEqual(removals(ctx.bridge), [['remove', 2]], how);
    karafunRemoves(f, ctx);
    if (how === 'annulée pendant l’envoi de la priorité') {
      f.settings.pushDelaySec = 0;
      f.sync();
      assert.equal(f.getPending()?.sel.ids[0], chloe.id, `${how} : la priorité part vers KaraFun`);
    }
    if (how === 'Recalculer la file') await f.call('POST /api/staff/queue-recalculate');
    else await f.call('POST /api/staff/priority-undo');
    if (how === 'annulée pendant l’envoi de la priorité') {
      queue.push({ queueId: 3, songId: 803, title: 'Titre Chloé', singer: f.getPending().sel.label });
      f.sync();
      assert.equal(chloe.sung, 1, `${how} : Chloé, déjà envoyée, chante d’abord`);
    }
    const order = planned(f);
    assert.equal(order[0].id, bruno.id, `${how} : Bruno reprend sa place, en tête`);
    assert.equal(f.sched.select()?.ids[0], bruno.id, `${how} : son titre part ensuite, sans attendre Rita`);
    assert.equal(rita.presenceSkips, 1, `${how} : Rita n’est pas sautée une deuxième fois`);
    assert.ok(driss);
  }
});

// Relecture : Bruno, prochain, dit « Pas prêt » ; l'envoi du titre de Chloé
// lève son report et l'annonce. Le bar lui donne la priorité avec retrait de
// ce titre : une fois retiré de KaraFun, le report revenait, la priorité était
// libérée et le titre de Chloé repartait le premier, à l'inverse de ce que le
// bar venait de confirmer.
test('priorité avec retrait pour la personne dont le « Pas prêt » a été levé par le titre chargé : elle passe d’abord', async () => {
  const f = harness();
  const join = (tableId, name) => f.sched.join({ tableId, name, headcount: 2 });
  const alice = join('1', 'Alice'), bruno = join('2', 'Bruno'), chloe = join('3', 'Chloé'), driss = join('4', 'Driss');
  [[alice, 801], [bruno, 802], [chloe, 803], [driss, 804]].forEach(([p, songId]) =>
    f.sched.chooseSong(p, { songId, title: `Titre ${p.name}` }));
  const stage = f.sched.select(); f.sched.commit(stage);
  f.tracked().push({ queueId: 1, sel: stage, startedAt: Date.now() - 50000, addedAt: Date.now() - 60000 });
  f.sched.deferPassage(bruno.id, { entryId: bruno.song.entryId, ids: [bruno.id] }, 1);
  const next = f.sched.select(); f.sched.commit(next);
  assert.equal(next.ids[0], chloe.id, 'le titre de Chloé est chargé');
  assert.equal(f.sched.reservedNext?.personId, bruno.id, 'son envoi lève le report de Bruno, annoncé ensuite');
  const tr = { queueId: 2, sel: next, startedAt: null, addedAt: Date.now() - 5000 };
  f.tracked().push(tr);
  const queue = [{ queueId: 1, songId: 801, title: 'Titre Alice', singer: stage.label, status: 'playing' },
    { queueId: 2, songId: 803, title: 'Titre Chloé', singer: next.label }];
  const ctx = { queue, tr, bridge: fakeBridge(queue, 1) };
  f.setBridge(ctx.bridge);
  f.sync();
  assert.equal(f.staffState().priorityPull?.queueId, 2, 'le retrait est proposé pour Bruno');
  await pullFor(f, bruno);
  karafunRemoves(f, ctx);
  assert.ok(notes(f).includes('« Titre Chloé » (Chloé · Table 3) retiré de KaraFun : il repasse juste après Bruno (priorité du bar), sans perdre son tour'));
  assert.equal(f.sched.reservedNext?.personId, bruno.id, 'la priorité tient');
  assert.equal(f.sched.reservedNext?.byStaff, true);
  assert.equal(f.sched.isDeferred(bruno), false, 'son « Pas prêt » levé ne revient pas');
  const order = planned(f);
  assert.deepEqual(order.slice(0, 2).map(line => line.id), [bruno.id, chloe.id]);
  assert.equal(order[1].afterPriority, true);
  f.settings.auto = true;
  f.settings.pushDelaySec = 0;
  f.sync();
  assert.equal(f.getPending()?.sel.ids[0], bruno.id, 'Bruno part vers KaraFun, pas Chloé');
  assert.ok(driss);
});

// Relecture de la correction : un titre déjà sur le lecteur de KaraFun (le
// précédent fini, chargé ou en cours de chargement, pas lancé) n'était pas
// « commencé » : il sortait de KaraFun, qui pouvait le garder comme titre en
// cours, et plus rien ne repartait.
test('priorité avant un titre déjà sur le lecteur de KaraFun : pas de retrait', async () => {
  for (const status of [{ state: 'loading', kcsState: 2 }, { state: 'idle', kcsState: 3 }]) {
    const f = harness();
    const ctx = loaded(f);
    ctx.queue.shift(); // Alice a fini
    ctx.bridge.status = { ...status, current: { queueId: 2 } };
    f.sync();
    assert.equal(f.analyze().current, null, 'rien ne joue encore');
    assert.equal(f.staffState().priorityPull, null, 'pas de question au bar');
    await assert.rejects(pullFor(f, ctx.people.driss), { message: '« Titre Bruno » est déjà sur le lecteur de KaraFun : rien n’a été retiré ni avancé. ' +
      '« Priorité » sans retrait fait passer la personne juste après lui.' });
    nothingChanged(f, ctx);
  }
});

// Relecture de la correction : la priorité avec retrait pour une personne du
// titre en cours supprimait le seul titre entre ses deux passages.
test('priorité avec retrait pour une personne sur scène : refusée, elle ne chante pas deux fois de suite', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { alice } = ctx.people;
  f.sched.chooseSong(alice, { songId: 809, title: 'Encore Alice' });
  f.sync();
  assert.ok(planned(f).some(line => line.id === alice.id), 'Alice a une ligne dans la file');
  assert.ok(!f.staffState().priorityPull.lineIds.includes(alice.id), 'la page ne lui propose pas le retrait');
  await assert.rejects(pullFor(f, alice), { message: 'Alice est sur scène en ce moment : « Titre Bruno » reste dans KaraFun, ' +
    'rien n’a été retiré ni avancé. « Priorité » sans retrait fait passer Alice juste après lui.' });
  nothingChanged(f, ctx);
});

// Relecture de la passe 8 : depuis Scheduler#_heldFor, une priorité du bar
// n'est retenue par aucun « Pas prêt » de ses chanteurs : ni celui du duo
// d'un autre où l'une d'elles est l'invitée, ni celui de l'invitée de son duo
// sur son propre titre. Le retrait restait pourtant refusé pour elles
// (« Inès attend la fin du « Pas prêt » de Chloé & Inès »), alors que la
// priorité pouvait partir juste après. Le duo repoussé lui-même passe
// aussi : le geste du bar lève le « Pas prêt » de la personne placée.
test('priorité avec retrait sur une ligne dont une personne attend un « Pas prêt » : proposée, la priorité part, le titre retiré juste après', async () => {
  for (const who of ['Inès', 'Chloé & Inès', 'Driss & Chloé']) {
    const f = harness();
    const ctx = loaded(f);
    const { bruno, chloe, driss } = ctx.people;
    if (who === 'Driss & Chloé') {
      // Chloé, prochaine, dit « Pas prêt » sur son propre titre ; Driss
      // l'invite ensuite en duo.
      f.deferTurn(f.sched.people.get(chloe.id), 2);
      f.sched.removeSong(driss, driss.song.entryId);
      const duo = f.sched.inviteDuet(driss, chloe.id, { songId: 813, title: 'Duo Driss' });
      f.sched.answerDuet(chloe, true, duo.entryId);
      f.sync();
    } else {
      // Inès est l'invitée du duo de Chloé, repoussé ; elle a aussi son titre.
      const ines = f.sched.join({ tableId: '3', name: 'Inès' });
      f.sched.removeSong(chloe, chloe.song.entryId);
      f.sched.inviteDuet(chloe, ines.id, { songId: 811, title: 'Duo Chloé' });
      f.sched.chooseSong(ines, { songId: 812, title: 'Titre Inès' });
      f.sync();
      f.deferTurn(f.sched.people.get(chloe.id), 2);
      assert.deepEqual(planned(f).map(line => line.name), ['Driss', 'Chloé & Inès', 'Inès']);
      assert.deepEqual(plain(f.staffState().priorityPull.lineIds), [driss.id, chloe.id, ines.id], `${who} : retrait proposé à Inès aussi`);
    }
    const line = planned(f).find(row => row.name === who);
    assert.ok(f.staffState().priorityPull.lineIds.includes(line.id), `${who} : retrait proposé`);
    const result = plain(await pullFor(f, f.sched.people.get(line.id)));
    assert.equal(result.message, `« Titre Bruno » sort de KaraFun : ${who} ${who.includes(' & ') ? 'passent' : 'passe'} d’abord, « Titre Bruno » juste après.`);
    assert.deepEqual(removals(ctx.bridge), [['remove', 2]], who);
    karafunRemoves(f, ctx);
    assert.deepEqual(planned(f).slice(0, 2).map(row => row.name), [who, 'Bruno'], `${who} : la priorité d’abord, le titre retiré juste après`);
    assert.equal(planned(f)[1].afterPriority, true, who);
    assert.equal(f.sched.isDeferred(chloe), who !== 'Chloé & Inès', `${who} : seul le « Pas prêt » de la ligne placée est levé`);
    f.settings.pushDelaySec = 0;
    f.sync();
    assert.deepEqual(f.getPending()?.sel.ids, line.ids, `${who} part vers KaraFun`);
    // KaraFun accuse l'envoi : le titre retiré est le prochain annoncé.
    ctx.queue.push({ queueId: 3, songId: f.getPending().sel.song.songId, title: f.getPending().sel.song.title, singer: f.getPending().sel.label });
    f.sync();
    assert.equal(f.sched.reservedNext?.personId, bruno.id, who);
    assert.equal(f.sched.select().song.title, 'Titre Bruno', who);
    // Le report du duo de Chloé tient ; celui de son propre titre prend fin
    // quand elle monte sur scène.
    assert.equal(f.sched.isDeferred(chloe), who === 'Inès', `${who} : report après l’envoi`);
  }
});

// Relecture : le retrait sortait le titre chargé de KaraFun pour une personne
// qui ne pouvait pas passer ensuite (titre passé faute de « Je suis là ») :
// quelqu'un d'autre partait, et le titre retiré attendait derrière une
// priorité qui ne partait pas. Depuis la passe 7, une priorité du bar lève
// cette retenue (_isPresenceRetry) : seule compte sa confirmation de « Je suis
// là ». Passé puis revenu confirmer, Driss peut passer avant le titre chargé
// (relecture, passe 8 : il en était exclu).
test('priorité avec retrait pour un titre passé faute de « Je suis là » : refusée sans confirmation, possible après', async () => {
  {
    // Driss n'a pas confirmé « Je suis là » : son titre laisse passer le suivant.
    const f = harness();
    const ctx = loaded(f, { presence: true });
    const { chloe, driss } = ctx.people;
    f.sched.skipUnconfirmed(driss.id, 3);
    f.sync();
    assert.ok(planned(f).some(line => line.id === driss.id));
    assert.deepEqual(plain(f.staffState().priorityPull.lineIds), [chloe.id], 'pas de retrait proposé à Driss');
    await assert.rejects(pullFor(f, driss), { message: 'Driss n’a pas encore confirmé « Je suis là » : « Titre Bruno » reste dans KaraFun, ' +
      'rien n’a été retiré ni avancé. « Priorité » sans retrait fait passer Driss juste après lui.' });
    nothingChanged(f, ctx);
    assert.equal(planned(f)[0].id, chloe.id, 'la file reste comme avant');
  }
  {
    // Il revient et confirme : le retrait lui est proposé et il part avant le titre chargé.
    const f = harness();
    const ctx = loaded(f, { presence: true });
    const { bruno, chloe, driss } = ctx.people;
    f.sched.skipUnconfirmed(driss.id, 3);
    f.sched.confirm(driss);
    f.sync();
    assert.deepEqual(plain(f.staffState().priorityPull.lineIds).sort(), [chloe.id, driss.id].sort(), 'retrait proposé à Driss, confirmé');
    await pullFor(f, driss);
    assert.deepEqual(removals(ctx.bridge), [['remove', 2]]);
    assert.equal(f.sched.reservedNext?.personId, driss.id);
    assert.equal(f.sched.reservedNext.byStaff, true);
    karafunRemoves(f, ctx);
    assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [driss.id, bruno.id], 'Driss d’abord, le titre retiré juste après');
  }
});

// Relecture de la correction : une place donnée par le bar à l'invitée d'un
// duo prenait fin à l'envoi du duo, et ne revenait pas quand ce duo sortait
// de KaraFun sans avoir été chanté. Soirée du 24 octobre : « Pas prêt »
// utilisé sept fois sur des titres chargés.
function guestPlaced(f) {
  const s = f.sched;
  const join = (tableId, name) => s.join({ tableId, name, headcount: 2 });
  const alice = join('1', 'Alice'), bruno = join('2', 'Bruno');
  const zoe = s.join({ tableId: '2', name: 'Zoé' });
  const chloe = join('3', 'Chloé'), driss = join('4', 'Driss'), eve = join('5', 'Eve');
  s.chooseSong(alice, { songId: 801, title: 'Titre Alice' });
  const stage = s.select(); s.commit(stage);
  const song = s.inviteDuet(bruno, zoe.id, { songId: 802, title: 'Duo Bruno' });
  if (song.duet?.state !== 'accepted') s.answerDuet(zoe, true, song.entryId);
  s.chooseSong(chloe, { songId: 803, title: 'Titre Chloé' });
  s.chooseSong(driss, { songId: 804, title: 'Titre Driss' });
  s.chooseSong(eve, { songId: 806, title: 'Titre Eve' });
  s.chooseSong(zoe, { songId: 805, title: 'Titre Zoé' });
  f.tracked().push({ queueId: 1, sel: stage, startedAt: Date.now() - 50000, addedAt: Date.now() - 60000 });
  const queue = [{ queueId: 1, songId: 801, title: 'Titre Alice', singer: stage.label, status: 'playing' }];
  const bridge = fakeBridge(queue, 1);
  f.setBridge(bridge);
  f.sync();
  return { people: { alice, bruno, zoe, chloe, driss, eve }, queue, bridge };
}
const shown = f => planned(f).map(line => `${line.name}${line.placed ? '*' : ''}`);

test('invitée placée par le bar dans un duo chargé puis retiré sans être chanté : sa place revient', async () => {
  for (const how of ['Pas prêt de Bruno', 'Pas prêt de Zoé', 'priorité avant le duo', 'redémarrage']) {
    let f = harness();
    let ctx = guestPlaced(f);
    const { bruno, zoe, driss } = ctx.people;
    assert.deepEqual(shown(f), ['Bruno & Zoé', 'Chloé', 'Driss', 'Eve', 'Zoé']);
    await move(f, { personId: zoe.id, toIndex: 1 });
    assert.deepEqual(shown(f), ['Bruno & Zoé', 'Zoé*', 'Chloé', 'Driss', 'Eve']);
    const sel = f.sched.select();
    f.sched.commit(sel);
    f.tracked().push({ queueId: 2, sel, startedAt: null, addedAt: Date.now() - 5000 });
    ctx.queue.push({ queueId: 2, songId: 802, title: 'Duo Bruno', singer: sel.label });
    f.sync();
    assert.deepEqual(plain(f.sched.manualChanges), [], `${how} : le duo part, la place de Zoé prend fin`);
    if (how === 'redémarrage') {
      for (const tableId of f.sched.tables.keys()) if (!f.access.get(tableId)) f.access.issue(tableId);
      const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: f.sched, access: f.access, settings: f.settings,
        tracked: f.tracked(), pending: null })));
      const g = harness();
      const recovered = restoreNight(snapshot, { scheduler: g.sched, access: g.access, settings: g.settings });
      g.setTracked(recovered.tracked);
      g.settings.auto = false;
      const queue = ctx.queue.map(item => ({ ...item }));
      g.setBridge(fakeBridge(queue, 1));
      g.sync();
      f = g;
      ctx = { ...ctx, queue };
    }
    if (how === 'priorité avant le duo') await pullFor(f, driss);
    else f.deferTurn(f.sched.people.get((how === 'Pas prêt de Zoé' ? zoe : bruno).id), 1);
    karafunRemoves(f, ctx);
    assert.equal(f.sched.people.get(zoe.id).duetGuestCount, 0, `${how} : Zoé n’a pas chanté`);
    assert.ok(f.sched.manualChanges.some(change => change.name === 'Zoé'), `${how} : sa place revient`);
    assert.ok(notes(f).includes('Zoé n’a finalement pas chanté : la place donnée par le bar revient'), how);
    assert.deepEqual(shown(f), how === 'priorité avant le duo' ? ['Driss*', 'Bruno & Zoé', 'Zoé*', 'Chloé', 'Eve'] :
      ['Chloé', 'Bruno & Zoé', 'Zoé*', 'Driss', 'Eve'], `${how} : Zoé reste juste derrière le duo`);
  }
});

test('duo improvisé noté par erreur avec une personne placée par le bar, annulé ou corrigé : sa place revient', async () => {
  for (const how of ['annulé', 'corrigé']) {
    const f = harness();
    const ctx = guestPlaced(f);
    const { alice, zoe, driss } = ctx.people;
    f.sched.recordStage(f.tracked()[0].sel, Date.now() - 50000);
    await move(f, { personId: driss.id, toIndex: 1 });
    const before = shown(f);
    assert.deepEqual(before, ['Bruno & Zoé', 'Driss*', 'Chloé', 'Eve', 'Zoé']);
    await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: driss.id });
    assert.deepEqual(plain(f.sched.manualChanges), [], 'Driss chante avec Alice : sa place prend fin');
    if (how === 'annulé') await f.call('POST /api/staff/duo-unmark', { queueId: 1 });
    else await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: ctx.people.eve.id, replace: true });
    assert.equal(driss.duetGuestCount, 0, `${how} : Driss n’a pas chanté`);
    assert.deepEqual(f.sched.manualChanges.map(change => change.name), ['Driss'], `${how} : sa place revient`);
    assert.ok(notes(f).includes('Driss n’a finalement pas chanté : la place donnée par le bar revient'), how);
    assert.deepEqual(shown(f).slice(0, 2), ['Bruno & Zoé', 'Driss*'], how);
    assert.ok(alice && zoe);
  }
});

// Relecture : le titre chargé retiré de KaraFun parce que son chanteur est
// absent à l'appel (« Absent » du bar, restore de server.js) revenait en tête
// de sa liste sans que le duo formé entre-temps sur sa ligne placée rende la
// ligne qu'il en avait sortie, contrairement au retour de « Pas prêt »
// (requeueUnplayed, _currentChanged). Gil, gardé devant Paulo, passait
// derrière lui.
test('absent à l’appel devant un duo formé sur une ligne placée : la ligne de l’invitée revient', async () => {
  const f = harness();
  const s = f.sched;
  const join = (tableId, name) => s.join({ tableId, name, headcount: 1 });
  const lea = join('1', 'Léa'), paulo = join('2', 'Paulo'), maud = join('3', 'Maud'), gil = join('4', 'Gil'), hugo = join('5', 'Hugo');
  [[lea, 801], [paulo, 802], [maud, 803], [gil, 804], [hugo, 805]].forEach(([p, songId]) =>
    s.chooseSong(p, { songId, title: `Titre ${p.name}` }));
  const stage = s.select(); s.commit(stage);
  f.tracked().push({ queueId: 1, sel: stage, startedAt: Date.now() - 50000, addedAt: Date.now() - 60000 });
  const next = s.select(); s.commit(next);
  assert.equal(next.ids[0], paulo.id, 'le premier titre de Paulo est chargé dans KaraFun');
  f.tracked().push({ queueId: 2, sel: next, startedAt: null, addedAt: Date.now() - 5000 });
  const queue = [{ queueId: 1, songId: 801, title: 'Titre Léa', singer: stage.label, status: 'playing' },
    { queueId: 2, songId: 802, title: 'Titre Paulo', singer: next.label }];
  const ctx = { queue, bridge: fakeBridge(queue, 1) };
  f.setBridge(ctx.bridge);
  s.chooseSong(paulo, { songId: 806, title: 'Duo Paulo' }, 'append');
  f.sync();
  await move(f, { personId: paulo.id, toIndex: 2 });
  assert.deepEqual(shown(f).slice(0, 3), ['Maud', 'Gil', 'Paulo*']);
  s.openDuet(paulo, { entryId: paulo.song.entryId });
  s.acceptOpenDuet(gil, paulo.id, paulo.song.entryId);
  f.sync();
  const fixed = () => s.manualOrder.map(pid => s.people.get(pid).name);
  assert.deepEqual(fixed(), ['Maud', 'Paulo'], 'Gil chante avec Paulo, sa ligne quitte l’ordre fixé');
  const duo = paulo.song;
  await f.call('POST /api/staff/kf', { action: 'absent', queueId: 2 });
  assert.deepEqual(removals(ctx.bridge), [['remove', 2]]);
  karafunRemoves(f, ctx);
  assert.ok(notes(f).includes('« Titre Paulo » (Paulo · Table 2) retirée (absent à l\'appel) : garde sa chanson et reprend la 4e place'));
  assert.equal(paulo.song.entryId, next.song.entryId, 'le titre retiré revient en tête de sa liste');
  assert.equal(paulo.backlog[0], duo, 'le duo passe dans la suite de sa liste');
  assert.equal(duo.duet.unpinned, undefined, 'le duo ne garde plus la ligne de Gil');
  assert.deepEqual(fixed(), ['Maud', 'Gil', 'Paulo'], 'le duo n’est plus le titre en cours : Gil reprend sa place');
  assert.deepEqual(shown(f).slice(0, 3), ['Maud', 'Gil', 'Paulo*']);
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Paulo']);
  assert.equal(f.publicState(null, '2').tablePeople.find(p => p.id === paulo.id).duet, null,
    'son téléphone ne montre plus le duo sur le titre en cours');
  assert.ok(lea && hugo);
});

// Relecture (passe 7) : un duo formé sur une ligne placée, chargé dans KaraFun
// puis passé là-bas avant la lecture (ou retiré par « Retirer » du bar), n'est
// pas renvoyé et sort de la liste de son auteur, resté là. Les lignes qu'il
// avait sorties de l'ordre fixé ne revenaient pas, contrairement au duo défait
// avant l'envoi : Gil, gardée devant Paulo, passait derrière lui.
test('duo formé sur une ligne placée, passé dans KaraFun avant la lecture : la ligne de l’invitée revient', async () => {
  const f = harness();
  const s = f.sched;
  const join = (tableId, name) => s.join({ tableId, name, headcount: 1 });
  const maud = join('1', 'Maud'), paulo = join('2', 'Paulo'), gil = join('3', 'Gil'), hugo = join('4', 'Hugo'), nina = join('5', 'Nina');
  [[maud, 801], [paulo, 802], [gil, 803], [hugo, 804], [nina, 805]].forEach(([p, songId]) =>
    s.chooseSong(p, { songId, title: `Titre ${p.name}` }));
  s.chooseSong(paulo, { songId: 806, title: 'Encore Paulo' }, 'append');
  // Rien sur scène ni dans KaraFun : Gil n'est pas le prochain annoncé.
  await move(f, { personId: paulo.id, toIndex: 2 });
  await move(f, { personId: nina.id, toIndex: 3 });
  assert.deepEqual(shown(f).slice(0, 4), ['Maud', 'Gil', 'Paulo*', 'Nina*']);
  s.openDuet(paulo, { entryId: paulo.song.entryId });
  s.acceptOpenDuet(gil, paulo.id, paulo.song.entryId);
  const fixed = () => s.manualOrder.map(pid => s.people.get(pid).name);
  assert.deepEqual(fixed(), ['Maud', 'Paulo', 'Nina'], 'Gil chante avec Paulo, sa ligne quitte l’ordre fixé');
  const duo = paulo.song;
  assert.ok(duo.duet.unpinned?.length, 'le duo note la ligne de Gil');
  const stage = s.select(); s.commit(stage);
  assert.equal(stage.ids[0], maud.id);
  f.tracked().push({ queueId: 1, sel: stage, startedAt: Date.now() - 50000, addedAt: Date.now() - 60000 });
  const queue = [{ queueId: 1, songId: 801, title: 'Titre Maud', singer: stage.label, status: 'playing' }];
  const ctx = { queue, bridge: fakeBridge(queue, 1) };
  f.setBridge(ctx.bridge);
  f.sync();
  assert.deepEqual(fixed(), ['Paulo', 'Nina']);
  const sel = s.select();
  assert.deepEqual(sel.ids, [paulo.id, gil.id], 'le duo part vers KaraFun');
  s.commit(sel);
  f.tracked().push({ queueId: 2, sel, startedAt: null, addedAt: Date.now() - 5000 });
  queue.push({ queueId: 2, songId: 802, title: 'Titre Paulo', singer: sel.label });
  f.sync();
  assert.deepEqual(fixed(), ['Nina'], 'le duo part : la place de Paulo est faite');
  karafunRemoves(f, ctx);
  assert.ok(notes(f).some(msg => /Titre Paulo.*passée dans KaraFun avant la lecture/.test(msg)));
  assert.equal(paulo.song.title, 'Encore Paulo', 'le duo n’est pas renvoyé');
  assert.equal(duo.duet.unpinned, undefined, 'le duo ne garde plus la ligne de Gil');
  assert.deepEqual(fixed(), ['Gil', 'Nina'], 'Gil reprend sa place devant Nina');
  assert.deepEqual(shown(f).slice(0, 2), ['Gil', 'Nina*']);
  assert.ok(hugo);
});

test('redémarrage pendant le retrait : le titre revient juste après la priorité une fois retiré', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno, driss } = ctx.people;
  await pullFor(f, driss);
  for (const tableId of f.sched.tables.keys()) if (!f.access.get(tableId)) f.access.issue(tableId);
  const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: f.sched, access: f.access, settings: f.settings,
    tracked: f.tracked(), pending: null })));
  const g = harness();
  const recovered = restoreNight(snapshot, { scheduler: g.sched, access: g.access, settings: g.settings });
  g.setTracked(recovered.tracked);
  g.settings.auto = false;
  const queue = ctx.queue.map(item => ({ ...item }));
  const bridge = fakeBridge(queue, 1);
  g.setBridge(bridge);
  g.sync();
  assert.equal(g.tracked().find(item => item.queueId === 2).pulled.reason, 'priority', 'le retrait continue après la reprise');
  assert.equal(g.sched.reservedNext?.personId, driss.id);
  queue.splice(1, 1);
  g.sync();
  const order = planned(g);
  assert.deepEqual(order.slice(0, 2).map(line => line.id), [driss.id, bruno.id]);
  assert.equal(order[1].afterPriority, true);
});

// Passes 16 et 17 : l'heure d'annonce de la priorité du geste (`forAt`) est
// gardée par la sauvegarde ; annulée après la reprise, la priorité rend Eve,
// plus ancienne, qui ne passe pas devant le titre revenu.
test('redémarrage pendant le retrait, priorité annulée ensuite : le titre retiré repasse devant l’annonce qui le suivait', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno, driss } = ctx.people;
  const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
  f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
  f.sync();
  await move(f, { personId: eve.id, toIndex: 0, priority: true });
  await pullFor(f, driss);
  for (const tableId of f.sched.tables.keys()) if (!f.access.get(tableId)) f.access.issue(tableId);
  const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: f.sched, access: f.access, settings: f.settings,
    tracked: f.tracked(), pending: null })));
  const g = harness();
  const recovered = restoreNight(snapshot, { scheduler: g.sched, access: g.access, settings: g.settings });
  g.setTracked(recovered.tracked);
  g.settings.auto = false;
  const queue = ctx.queue.map(item => ({ ...item }));
  g.setBridge(fakeBridge(queue, 1));
  g.sync();
  assert.equal(g.tracked().find(item => item.queueId === 2).pulled.forAt, ctx.tr.pulled.forAt, 'l’heure de la priorité du geste est reprise');
  await g.call('POST /api/staff/priority-undo');
  assert.equal(g.sched.reservedNext?.personId, eve.id, 'l’annulation rend la priorité d’Eve');
  queue.splice(1, 1);
  g.sync();
  assert.deepEqual(planned(g).slice(0, 2).map(line => line.id), [bruno.id, eve.id], 'Bruno d’abord, Eve juste après');
  assert.ok(driss);
});

// ---------------------------------------------------------------- passe 17
// Relecture (passe 17) : un titre retiré de KaraFun pour une priorité du bar
// annulée depuis repasse le premier, comme quand il était chargé, et
// l'annonce qui le suivait le suit encore, avec ce qu'elle était (priorité du
// bar, personne sautée faute de « Je suis là », « Pas prêt » levé par son
// envoi). Personne d'arrivé depuis ne passe devant lui.

// Deuxième tour : Alice, Rita, Bruno et Chloé, une table chacun, ont chanté
// une fois ; Alice chante son deuxième titre (suivie, queueId 1). `before` :
// ce qui arrive avant l'envoi du titre suivant (Rita sautée faute de « Je
// suis là », ou son « Pas prêt » : celui de Bruno part ; sinon celui de
// Rita, `loads`). Ce titre attend dans KaraFun (queueId 2) ; Nina, d'une
// nouvelle table, choisit alors son premier titre : sans geste du bar, elle
// passerait avant tous les autres.
function secondRound(f, { presence = false, before = () => {}, loads = 'bruno' } = {}) {
  const join = (tableId, name) => f.sched.join({ tableId, name, headcount: 2 });
  const people = { alice: join('1', 'Alice'), rita: join('2', 'Rita'), bruno: join('3', 'Bruno'), chloe: join('4', 'Chloé') };
  let songId = 900;
  for (const p of Object.values(people)) {
    for (const title of [`Titre ${p.name}`, `Titre ${p.name} 2`]) f.sched.chooseSong(p, { songId: songId++, title }, 'append');
  }
  for (let k = 0; k < 4; k++) { const sel = f.sched.select(); f.sched.commit(sel); f.sched.songEnded(sel.ids); }
  if (presence) {
    f.sched.opts.requirePresence = true;
    for (const p of [people.alice, people.bruno, people.chloe, people[loads]]) f.sched.confirm(p);
  }
  const stage = f.sched.select(); f.sched.commit(stage);
  assert.equal(stage.ids[0], people.alice.id, 'Alice chante son deuxième titre');
  f.tracked().push({ queueId: 1, sel: stage, startedAt: Date.now() - 50000, addedAt: Date.now() - 60000 });
  before(people);
  const next = f.sched.select(); f.sched.commit(next);
  assert.equal(next.ids[0], people[loads].id, `le titre de ${people[loads].name} part ensuite`);
  const tr = { queueId: 2, sel: next, startedAt: null, addedAt: Date.now() - 5000 };
  f.tracked().push(tr);
  people.nina = join('5', 'Nina');
  f.sched.chooseSong(people.nina, { songId: 950, title: 'Titre Nina' });
  if (presence) f.sched.confirm(people.nina);
  const queue = [{ queueId: 1, songId: stage.song.songId, title: stage.song.title, singer: stage.label, status: 'playing' },
    { queueId: 2, songId: next.song.songId, title: next.song.title, singer: next.label }];
  const bridge = fakeBridge(queue, 1);
  f.setBridge(bridge);
  f.sync();
  return { people, stage, next, tr, queue, bridge };
}

// La priorité de `person` sort le titre chargé de KaraFun, puis le bar
// l'annule selon `how` : avant que KaraFun confirme le retrait, après, en
// « Recalculer la file », ou pendant l'envoi de la priorité (qui part donc
// d'abord, déjà envoyée). Rend la réponse de l'annulation.
const UNDO_TIMINGS = ['annulée pendant le retrait', 'annulée après le retrait', 'Recalculer la file', 'annulée pendant l’envoi de la priorité'];
async function pullThenUndo(f, ctx, person, how, { undo = () => f.call('POST /api/staff/priority-undo') } = {}) {
  await pullFor(f, person);
  assert.deepEqual(removals(ctx.bridge), [['remove', 2]], `${how} : le titre chargé sort de KaraFun`);
  if (how !== 'annulée pendant le retrait') karafunRemoves(f, ctx);
  if (how === 'annulée pendant l’envoi de la priorité') {
    f.settings.pushDelaySec = 0;
    f.sync();
    assert.equal(f.getPending()?.sel.ids[0], person.id, `${how} : la priorité part vers KaraFun`);
  }
  const result = how === 'Recalculer la file' ? await f.call('POST /api/staff/queue-recalculate') : await undo();
  if (how === 'annulée pendant le retrait') karafunRemoves(f, ctx);
  if (how === 'annulée pendant l’envoi de la priorité') {
    const sel = f.getPending().sel;
    ctx.queue.push({ queueId: 3, songId: sel.song.songId, title: sel.song.title, singer: sel.label });
    f.sync();
    assert.equal(f.getPending(), null, `${how} : KaraFun a accusé l’envoi de la priorité`);
    f.settings.pushDelaySec = 180;
  }
  return result;
}

// Le passage annoncé part (sélection et accusé de KaraFun, au niveau du
// planificateur) : rend la sélection.
function sendNext(f) {
  const sel = f.sched.select();
  assert.ok(sel, 'un passage part');
  f.sched.commit(sel);
  return sel;
}

// Après `loaded` : Eve donne un duo à Gil, qui a aussi son propre titre et
// son « Pas prêt » (2 chansons), dit quand ce titre était le prochain
// (Chloé et Driss n'en avaient pas encore). Le bar donne « Priorité » au duo,
// juste après « Titre Bruno » : le « Pas prêt » de Gil ne le retient pas.
async function priorityDuoWithReport(f, ctx) {
  const { chloe, driss } = ctx.people;
  const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
  const gil = f.sched.join({ tableId: '6', name: 'Gil', headcount: 2 });
  f.sched.removeSong(chloe, chloe.song.entryId);
  f.sched.removeSong(driss, driss.song.entryId);
  f.sched.chooseSong(gil, { songId: 812, title: 'Titre Gil' });
  const duo = f.sched.inviteDuet(eve, gil.id, { songId: 809, title: 'Duo Eve' });
  f.sync();
  assert.equal(planned(f)[0]?.id, gil.id, 'le titre de Gil est le prochain');
  f.deferTurn(f.sched.people.get(gil.id), 2);
  f.sched.answerDuet(gil, true, duo.entryId);
  f.sched.chooseSong(chloe, { songId: 803, title: 'Titre Chloé' });
  f.sched.chooseSong(driss, { songId: 804, title: 'Titre Driss' });
  f.sync();
  const first = plain(await move(f, { personId: eve.id, toIndex: 0, priority: true }));
  assert.equal(first.message, 'Eve & Gil passent juste après « Titre Bruno », déjà chargé dans KaraFun.');
  return { eve, gil };
}

test('passe 17 : priorité avec retrait annulée, une priorité plus ancienne sur un duo dont l’invitée a son « Pas prêt » : le titre retiré, puis le duo, toujours prioritaire', async () => {
  for (const how of ['annulée pendant le retrait', 'annulée après le retrait', 'annulée pendant l’envoi de la priorité']) {
    const f = harness();
    const ctx = loaded(f);
    const { bruno, driss } = ctx.people;
    const { eve, gil } = await priorityDuoWithReport(f, ctx);
    await pullThenUndo(f, ctx, driss, how);
    const order = planned(f);
    assert.deepEqual(order.slice(0, 2).map(line => line.name), ['Bruno', 'Eve & Gil'], `${how} : Bruno d’abord, le duo prioritaire juste après`);
    assert.equal(order[0].guaranteed, true, `${how} : Bruno est le prochain annoncé`);
    assert.equal(sendNext(f).ids[0], bruno.id, how);
    assert.equal(f.sched.reservedNext?.personId, eve.id, `${how} : la priorité d’Eve est de nouveau annoncée`);
    assert.equal(f.sched.reservedNext?.byStaff, true, `${how} : c’est toujours une priorité du bar`);
    assert.deepEqual(f.sched.select()?.ids, [eve.id, gil.id], `${how} : le duo part, le « Pas prêt » de Gil ne le retient pas`);
  }
});

test('passe 17 : priorité avec retrait annulée, une personne sautée faute de « Je suis là » annoncée après le titre chargé, une nouvelle table arrivée : le titre retiré, puis elle, puis la nouvelle', async () => {
  for (const how of UNDO_TIMINGS) {
    const f = harness();
    const ctx = secondRound(f, { presence: true, before: ({ rita }) => f.sched.skipUnconfirmed(rita.id, 3) });
    const { rita, bruno, chloe, nina } = ctx.people;
    assert.equal(f.sched.reservedNext?.personId, rita.id, 'l’envoi de Bruno annonce Rita ensuite');
    assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [rita.id, nina.id], 'sans geste : Rita, puis Nina');
    await pullThenUndo(f, ctx, chloe, how);
    assert.deepEqual(planned(f).slice(0, 3).map(line => line.id), [bruno.id, rita.id, nina.id], `${how} : Bruno, puis Rita, puis Nina`);
    const sent = sendNext(f);
    assert.equal(sent.ids[0], bruno.id, how);
    assert.equal(f.sched.reservedNext?.personId, rita.id, `${how} : Rita est annoncée juste après Bruno`);
    assert.equal(rita.presenceSkips, 1, `${how} : Rita n’est pas sautée une deuxième fois`);
    // Renvoyé, le titre de Bruno revient encore sans être chanté (« Pas
    // prêt ») : Rita attend de nouveau un passage devant elle, comme après
    // son premier envoi.
    f.sched.requeueUnplayed(sent);
    assert.notEqual(f.sched.reservedNext?.personId, rita.id, `${how} : Rita n’est plus annoncée`);
    assert.equal(rita.presenceRetry, true, `${how} : elle laisse passer le passage suivant`);
  }
});

test('passe 17 : priorité avec retrait annulée, un « Pas prêt » levé par l’envoi du titre chargé, une nouvelle table arrivée : le titre retiré, puis la personne prête, puis la nouvelle', async () => {
  for (const how of UNDO_TIMINGS) {
    const f = harness();
    const ctx = secondRound(f, { before: ({ rita }) => f.deferTurn(f.sched.people.get(rita.id), 1) });
    const { rita, bruno, chloe, nina } = ctx.people;
    assert.equal(f.sched.reservedNext?.personId, rita.id, 'l’envoi de Bruno lève le report de Rita, annoncée ensuite');
    await pullThenUndo(f, ctx, chloe, how);
    assert.deepEqual(planned(f).slice(0, 3).map(line => line.id), [bruno.id, rita.id, nina.id], `${how} : Bruno, puis Rita, puis Nina`);
    assert.equal(sendNext(f).ids[0], bruno.id, how);
    assert.equal(f.sched.reservedNext?.personId, rita.id, `${how} : Rita est annoncée juste après Bruno`);
  }
});

test('passe 17 : priorité avec retrait annulée sans annonce après le titre chargé : il repasse devant une nouvelle table et devant les lignes placées par le bar', async () => {
  for (const how of UNDO_TIMINGS) {
    {
      const f = harness();
      const ctx = secondRound(f, { loads: 'rita' });
      const { rita, chloe, nina } = ctx.people;
      assert.equal(f.sched.reservedNext, null, 'personne n’est annoncé pendant que le titre de Rita attend');
      assert.equal(planned(f)[0].id, nina.id, 'sans geste : Nina, nouvelle table, passe après Rita');
      await pullThenUndo(f, ctx, chloe, how);
      assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [rita.id, nina.id], `${how} : Rita d’abord, Nina ensuite`);
      assert.equal(sendNext(f).ids[0], rita.id, how);
    }
    {
      // Le bar a placé Eve en 2e place derrière Chloé (lignes fixées).
      const f = harness();
      const ctx = loaded(f);
      const { bruno, chloe, driss } = ctx.people;
      const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
      f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
      f.sync();
      assert.equal(plain(await move(f, { personId: eve.id, toIndex: 1 })).ok, true);
      assert.deepEqual(planned(f).map(line => line.id), [chloe.id, eve.id, driss.id]);
      await pullThenUndo(f, ctx, driss, how);
      const order = planned(f).map(line => line.id);
      if (how === 'Recalculer la file') assert.equal(order[0], bruno.id, `${how} : Bruno d’abord`);
      else assert.deepEqual(order.slice(0, 3), [bruno.id, chloe.id, eve.id], `${how} : Bruno d’abord, puis les lignes placées par le bar`);
      assert.equal(sendNext(f).ids[0], bruno.id, how);
    }
  }
});

test('passe 17 : priorité avec retrait pour la personne qui avait déjà la priorité juste après le titre chargé, annulée : le titre retiré, puis elle', async () => {
  for (const how of ['annulée pendant le retrait', 'annulée après le retrait']) {
    const f = harness();
    const ctx = loaded(f);
    const { bruno } = ctx.people;
    const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
    f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
    f.sync();
    assert.equal(plain(await move(f, { personId: eve.id, toIndex: 0, priority: true })).message,
      'Eve passe juste après « Titre Bruno », déjà chargé dans KaraFun.');
    assert.equal(f.staffState().priorityPull?.queueId, 2, 'le retrait reste proposé pour Eve');
    await pullThenUndo(f, ctx, eve, how);
    if (how === 'annulée pendant le retrait') {
      assert.ok(notes(f).includes('« Titre Bruno » (Bruno · Table 2) retiré de KaraFun : la priorité de Eve ne tient plus, il reprend sa place sans perdre son tour'),
        `${how} : la priorité annulée ne retient pas le titre`);
    }
    const order = planned(f);
    assert.deepEqual(order.slice(0, 2).map(line => line.id), [bruno.id, eve.id], `${how} : Bruno d’abord, Eve juste après`);
    assert.ok(!order[0].afterPriority, how);
    assert.equal(sendNext(f).ids[0], bruno.id, how);
    assert.equal(f.sched.reservedNext?.personId, eve.id, how);
    assert.equal(f.sched.reservedNext?.byStaff, true, `${how} : sa priorité d’avant tient`);
  }
});

test('passe 17 : deux priorités juste après le titre chargé, une troisième avec retrait, deux « Annuler » ou « Recalculer la file » avant le retrait : le titre retiré d’abord', async () => {
  for (const how of ['deux « Annuler »', 'Recalculer la file']) {
    const f = harness();
    const ctx = loaded(f);
    const { bruno, chloe, driss } = ctx.people;
    const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
    const jade = f.sched.join({ tableId: '6', name: 'Jade', headcount: 2 });
    f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
    f.sched.chooseSong(jade, { songId: 810, title: 'Titre Jade' });
    f.sync();
    await move(f, { personId: eve.id, toIndex: 0, priority: true });
    await move(f, { personId: jade.id, toIndex: 0, priority: true });
    await pullFor(f, driss);
    if (how === 'Recalculer la file') await f.call('POST /api/staff/queue-recalculate');
    else for (let k = 0; k < 2; k++) assert.equal(plain(await f.call('POST /api/staff/manual-change-undo', { id: f.sched.manualChanges.at(-1).id })).exact, true);
    karafunRemoves(f, ctx);
    const order = planned(f).map(line => line.id);
    assert.equal(order[0], bruno.id, `${how} : Bruno d’abord`);
    if (how === 'deux « Annuler »') {
      assert.equal(order[1], eve.id, `${how} : puis Eve, dont la priorité tient encore`);
      assert.equal(sendNext(f).ids[0], bruno.id, how);
      assert.equal(f.sched.reservedNext?.personId, eve.id, how);
      assert.equal(f.sched.reservedNext?.byStaff, true, how);
    } else {
      assert.equal(sendNext(f).ids[0], bruno.id, how);
      assert.notEqual(f.sched.reservedNext?.byStaff, true, `${how} : plus aucune priorité`);
    }
    assert.ok(chloe);
  }
});

test('passe 17 : « Recalculer la file » une fois le titre revenu, une priorité sans retrait avait pris l’annonce d’une personne sautée faute de « Je suis là » : le titre retiré, puis elle', async () => {
  const f = harness();
  const ctx = secondRound(f, { presence: true, before: ({ rita }) => f.sched.skipUnconfirmed(rita.id, 3) });
  const { rita, bruno, chloe, nina } = ctx.people;
  assert.equal(f.sched.reservedNext?.personId, rita.id);
  assert.equal(plain(await move(f, { personId: chloe.id, toIndex: 0, priority: true })).ok, true);
  assert.equal(f.sched.reservedNext?.personId, chloe.id, 'la priorité de Chloé prend l’annonce de Rita');
  await pullFor(f, nina);
  karafunRemoves(f, ctx);
  await f.call('POST /api/staff/queue-recalculate');
  assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [bruno.id, rita.id], 'Bruno, puis Rita');
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.equal(f.sched.reservedNext?.personId, rita.id, 'Rita est annoncée juste après Bruno');
  assert.notEqual(f.sched.reservedNext?.byStaff, true);
});

test('passe 17 : priorité avec retrait annulée pendant son envoi, la personne du titre retiré chante dans ce duo : son titre n’est pas annoncé juste après', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno, driss } = ctx.people;
  const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
  f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
  f.sync();
  await move(f, { personId: eve.id, toIndex: 0, priority: true });
  // Driss invite Bruno en duo sur son titre ; Bruno accepte pendant le retrait.
  f.sched.removeSong(driss, driss.song.entryId);
  const duo = f.sched.inviteDuet(driss, bruno.id, { songId: 813, title: 'Duo Driss' });
  f.sync();
  await pullFor(f, driss);
  f.sched.answerDuet(bruno, true, duo.entryId);
  karafunRemoves(f, ctx);
  f.settings.pushDelaySec = 0;
  f.sync();
  assert.deepEqual(f.getPending()?.sel.ids, [driss.id, bruno.id], 'le duo de Driss et Bruno part vers KaraFun');
  await f.call('POST /api/staff/priority-undo');
  const sel = f.getPending().sel;
  ctx.queue.push({ queueId: 3, songId: sel.song.songId, title: sel.song.title, singer: sel.label });
  f.sync();
  assert.notEqual(f.sched.reservedNext?.personId, bruno.id, 'Bruno n’est pas annoncé juste après le duo qu’il chante');
  assert.notEqual(f.sched.select()?.ids[0], bruno.id, 'son titre ne part pas juste après');
  assert.equal(f.sched.reservedNext?.personId, eve.id, 'la priorité d’Eve, rendue, est annoncée');
});

// Le titre retiré est revenu en tête, la priorité plus ancienne d'Eve juste
// derrière lui (annulation après le retrait).
async function backWithEve(f, ctx) {
  const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
  f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
  for (const p of [eve, ctx.people.driss]) f.sched.confirm(p);
  f.sync();
  await move(f, { personId: eve.id, toIndex: 0, priority: true });
  await pullThenUndo(f, ctx, ctx.people.driss, 'annulée après le retrait');
  assert.equal(f.sched.reservedNext?.personId, ctx.people.bruno.id, 'Bruno est le prochain annoncé');
  assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [ctx.people.bruno.id, eve.id]);
  return eve;
}

test('passe 17 : titre retiré revenu en tête, son chanteur dit « Pas prêt » ou manque « Je suis là » : la priorité gardée derrière lui passe', async () => {
  for (const how of ['Pas prêt', 'Je suis là manqué']) {
    const f = harness();
    const ctx = loaded(f, { presence: how === 'Je suis là manqué' });
    const { bruno } = ctx.people;
    const eve = await backWithEve(f, ctx);
    if (how === 'Pas prêt') f.deferTurn(f.sched.people.get(bruno.id), 1);
    else f.sched.skipUnconfirmed(bruno.id, 3);
    assert.equal(f.sched.reservedNext?.personId, eve.id, `${how} : Eve est annoncée`);
    assert.equal(f.sched.reservedNext?.byStaff, true, `${how} : sa priorité tient`);
    assert.equal(f.sched.select()?.ids[0], eve.id, `${how} : Eve part`);
    assert.equal(planned(f)[1].id, bruno.id, `${how} : Bruno juste après`);
  }
});

test('passe 17 : titre retiré revenu en tête, redémarrage : la priorité gardée derrière lui suit encore', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno } = ctx.people;
  const eve = await backWithEve(f, ctx);
  for (const tableId of f.sched.tables.keys()) if (!f.access.get(tableId)) f.access.issue(tableId);
  const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: f.sched, access: f.access, settings: f.settings,
    tracked: f.tracked(), pending: null })));
  const g = harness();
  const recovered = restoreNight(snapshot, { scheduler: g.sched, access: g.access, settings: g.settings });
  g.setTracked(recovered.tracked);
  g.settings.auto = false;
  g.setBridge(fakeBridge(ctx.queue.map(item => ({ ...item })), 1));
  g.sync();
  assert.equal(g.sched.reservedNext?.personId, bruno.id);
  assert.equal(g.sched.reservedNext?.then?.personId, eve.id, 'la sauvegarde garde l’annonce derrière le titre revenu');
  assert.deepEqual(planned(g).slice(0, 2).map(line => line.id), [bruno.id, eve.id]);
  assert.equal(sendNext(g).ids[0], bruno.id);
  assert.equal(g.sched.reservedNext?.personId, eve.id);
  assert.equal(g.sched.reservedNext?.byStaff, true);
});

test('passe 17 : titre retiré revenu en tête, le bar place une autre ligne juste derrière lui : elle passe avant la priorité gardée', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno, chloe } = ctx.people;
  const eve = await backWithEve(f, ctx);
  assert.equal(plain(await move(f, { personId: chloe.id, toIndex: 1 })).ok, true);
  assert.deepEqual(planned(f).slice(0, 3).map(line => line.id), [bruno.id, chloe.id, eve.id], 'Bruno, Chloé placée par le bar, puis Eve');
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.notEqual(f.sched.reservedNext?.personId, eve.id, 'Eve ne repasse pas devant Chloé');
  assert.equal(f.sched.select()?.ids[0], chloe.id);
});

test('passe 17 : titre retiré revenu en tête, son titre devient un duo ouvert en « Duos uniquement » : l’annonce gardée derrière lui passe', async () => {
  {
    // Sans « Je suis là » : le balayage suivant (select) voit que le titre
    // ne peut pas partir.
    const f = harness();
    const ctx = loaded(f);
    const { bruno, driss } = ctx.people;
    const { eve, gil } = await priorityDuoWithReport(f, ctx);
    await pullThenUndo(f, ctx, driss, 'annulée après le retrait');
    assert.equal(f.sched.reservedNext?.then?.personId, eve.id, 'le duo prioritaire est gardé derrière le titre revenu');
    f.sched.openDuet(bruno, { entryId: bruno.song.entryId });
    await f.call('POST /api/staff/settings', { duoOnly: true });
    assert.equal(planned(f)[0]?.name, 'Eve & Gil', 'la file montre le duo prioritaire en tête, comme l’envoi');
    assert.deepEqual(f.sched.select()?.ids, [eve.id, gil.id], 'le duo prioritaire part');
    assert.equal(f.sched.reservedNext?.byStaff, true, 'sa priorité tient');
  }
  const f = harness();
  const ctx = secondRound(f, { presence: true, before: ({ rita }) => f.sched.skipUnconfirmed(rita.id, 3) });
  const { rita, bruno, chloe, nina } = ctx.people;
  await pullThenUndo(f, ctx, chloe, 'annulée après le retrait');
  assert.equal(f.sched.reservedNext?.then?.personId, rita.id, 'Rita est gardée derrière le titre revenu');
  f.sched.openDuet(bruno, { entryId: bruno.song.entryId });
  await f.call('POST /api/staff/settings', { duoOnly: true });
  f.sched.confirm(rita);
  assert.equal(f.sched.select()?.ids[0], rita.id, 'Rita part, pas Nina');
  assert.equal(f.sched.reservedNext?.personId, rita.id);
  assert.ok(nina);
});

test('passe 17 : l’annonce gardée derrière le titre revenu devient un duo avec la personne de ce titre : elle n’est pas annoncée juste après lui', async () => {
  const f = harness();
  const ctx = secondRound(f, { presence: true, before: ({ rita }) => f.sched.skipUnconfirmed(rita.id, 3) });
  const { rita, bruno, chloe } = ctx.people;
  await pullThenUndo(f, ctx, chloe, 'annulée après le retrait');
  assert.equal(f.sched.reservedNext?.then?.personId, rita.id, 'Rita est gardée derrière le titre revenu');
  // Rita invite Bruno en duo, il accepte ; elle retire son titre en cours.
  const duo = f.sched.inviteDuet(rita, bruno.id, { songId: 830, title: 'Duo Rita' });
  f.sched.answerDuet(bruno, true, duo.entryId);
  f.sched.removeSong(rita, rita.song.entryId);
  f.sync();
  assert.deepEqual(rita.song.duet, { partnerId: bruno.id, state: 'accepted' }, 'son titre en cours est le duo avec Bruno');
  assert.notDeepEqual(planned(f)[1]?.ids, [rita.id, bruno.id], 'la file ne montre pas le duo juste après Bruno');
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.notEqual(f.sched.reservedNext?.personId, rita.id, 'Bruno ne chante pas deux fois de suite');
});

test('passe 17 : priorité avec retrait qui prend fin autrement (son titre retiré, sa table partie, « Pas prêt », « Je suis là » manqué) : le titre retiré repasse devant une nouvelle table', async () => {
  for (const how of ['titre retiré', 'table partie', 'Pas prêt', 'Je suis là manqué']) {
    const f = harness();
    const ctx = secondRound(f, { loads: 'rita', presence: how === 'Je suis là manqué' });
    const { rita, chloe, nina } = ctx.people;
    await pullFor(f, chloe);
    karafunRemoves(f, ctx);
    assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [chloe.id, rita.id], `${how} : Chloé d’abord, Rita juste après`);
    if (how === 'titre retiré') await f.call('POST /api/staff/remove', { personId: chloe.id });
    if (how === 'table partie') await f.call('POST /api/staff/table-left', { id: '4' });
    if (how === 'Pas prêt') f.deferTurn(f.sched.people.get(chloe.id), 1);
    if (how === 'Je suis là manqué') f.sched.skipUnconfirmed(chloe.id, 3);
    assert.equal(planned(f)[0].id, rita.id, `${how} : Rita reprend la tête, devant Nina`);
    assert.equal(f.sched.reservedNext?.personId, rita.id, `${how} : elle est la prochaine annoncée`);
    assert.equal(sendNext(f).ids[0], rita.id, how);
    assert.ok(nina);
  }
});

test('passe 17 : titre revenu de nouveau en route vers KaraFun, le bar déplace la priorité gardée derrière lui : elle ne lui est plus rendue', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno, chloe } = ctx.people;
  const eve = await backWithEve(f, ctx);
  f.settings.pushDelaySec = 0;
  f.sync();
  assert.equal(f.getPending()?.sel.ids[0], bruno.id, 'le titre de Bruno repart vers KaraFun');
  assert.equal(planned(f)[0].id, eve.id, 'la file montre Eve juste après lui');
  assert.equal(plain(await move(f, { personId: eve.id, toIndex: 2 })).ok, true);
  const sel = f.getPending().sel;
  ctx.queue.push({ queueId: 3, songId: sel.song.songId, title: sel.song.title, singer: sel.label });
  f.sync();
  assert.notEqual(f.sched.reservedNext?.personId, eve.id, 'Eve, déplacée par le bar, n’est plus la prochaine');
  assert.equal(f.sched.select()?.ids[0], chloe.id, 'la première ligne placée par le bar part');
});

test('passe 17 : une nouvelle priorité pendant que le titre retiré attend derrière une autre : il garde sa place derrière celle-ci, devant une nouvelle table', async () => {
  for (const when of ['après le retrait', 'pendant le retrait']) {
    const f = harness();
    const ctx = secondRound(f, { loads: 'rita' });
    const { rita, bruno, chloe, nina } = ctx.people;
    await pullFor(f, chloe);
    if (when === 'après le retrait') karafunRemoves(f, ctx);
    assert.equal(plain(await move(f, { personId: bruno.id, toIndex: 0, priority: true })).ok, true);
    if (when === 'pendant le retrait') karafunRemoves(f, ctx);
    assert.deepEqual(planned(f).slice(0, 4).map(line => line.id), [bruno.id, chloe.id, rita.id, nina.id],
      `${when} : Bruno, puis Chloé, puis Rita, puis Nina`);
    await f.call('POST /api/staff/priority-undo');
    assert.deepEqual(planned(f).slice(0, 3).map(line => line.id), [chloe.id, rita.id, nina.id], `${when} : priorité de Bruno annulée`);
    assert.equal(planned(f)[1].afterPriority, true, `${when} : Rita attend de nouveau la priorité de Chloé`);
    await f.call('POST /api/staff/queue-recalculate');
    assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [rita.id, nina.id], `${when} : tout annulé, Rita d’abord`);
  }
});

test('passe 17 : priorité annulée avant le retrait, puis une autre priorité donnée pendant que le titre est encore affiché chargé : il repasse devant elle', async () => {
  for (const who of ['Bruno', 'Chloé de nouveau']) {
    const f = harness();
    const ctx = secondRound(f, { loads: 'rita' });
    const { rita, bruno, chloe, nina } = ctx.people;
    await pullFor(f, chloe);
    assert.equal(plain(await f.call('POST /api/staff/manual-change-undo', { id: f.sched.manualChanges.at(-1).id })).exact, true);
    const next = who === 'Bruno' ? bruno : chloe;
    const result = plain(await move(f, { personId: next.id, toIndex: 0, priority: true }));
    assert.equal(result.ok, true, who);
    karafunRemoves(f, ctx);
    assert.deepEqual(planned(f).slice(0, 3).map(line => line.id), [rita.id, next.id, nina.id], `${who} : Rita, puis la nouvelle priorité, puis Nina`);
    assert.equal(sendNext(f).ids[0], rita.id, who);
    assert.equal(f.sched.reservedNext?.personId, next.id, who);
    assert.equal(f.sched.reservedNext?.byStaff, true, `${who} : c’est toujours une priorité du bar`);
  }
});

test('passe 17 : priorité d’un duo avec retrait annulée pendant son envoi, l’invitée était annoncée après le titre chargé : elle ne passe pas juste après', async () => {
  const f = harness();
  const ctx = secondRound(f, { before: ({ rita }) => f.deferTurn(f.sched.people.get(rita.id), 1) });
  const { rita, bruno, chloe } = ctx.people;
  assert.equal(f.sched.reservedNext?.personId, rita.id, 'l’envoi de Bruno lève le report de Rita, annoncée ensuite');
  // Le titre en cours de Chloé devient un duo avec Rita.
  const duo = f.sched.inviteDuet(chloe, rita.id, { songId: 960, title: 'Duo Chloé' });
  f.sched.answerDuet(rita, true, duo.entryId);
  f.sched.removeSong(chloe, chloe.song.entryId);
  f.sync();
  await pullFor(f, chloe);
  karafunRemoves(f, ctx);
  f.settings.pushDelaySec = 0;
  f.sync();
  assert.deepEqual(f.getPending()?.sel.ids, [chloe.id, rita.id], 'le duo de Chloé et Rita part vers KaraFun');
  await f.call('POST /api/staff/priority-undo');
  const sel = f.getPending().sel;
  ctx.queue.push({ queueId: 3, songId: sel.song.songId, title: sel.song.title, singer: sel.label });
  f.sync();
  assert.equal(f.sched.reservedNext?.personId, bruno.id, 'Bruno, chargé avant le geste, est le prochain');
  assert.notEqual(f.sched.reservedNext?.then?.personId, rita.id, 'Rita, qui chante ce duo, ne reste pas juste derrière lui');
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.notEqual(f.sched.reservedNext?.personId, rita.id, 'Rita n’est pas annoncée juste après');
});

test('passe 17 : l’annonce gardée derrière le titre revenu chante entre-temps en duo improvisé noté au bar : elle n’est plus annoncée juste après lui', async () => {
  const f = harness();
  const ctx = secondRound(f, { presence: true, before: ({ rita }) => f.sched.skipUnconfirmed(rita.id, 3) });
  const { rita, bruno, chloe } = ctx.people;
  await pullThenUndo(f, ctx, chloe, 'annulée après le retrait');
  assert.equal(f.sched.reservedNext?.then?.personId, rita.id);
  f.sched.staffCountPartner(ctx.stage.ids[0], rita.id, ctx.stage);
  f.sync();
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.notEqual(f.sched.reservedNext?.personId, rita.id, 'Rita, qui vient de chanter avec Alice, n’est pas annoncée aussitôt');
});

test('passe 17 : priorité sans retrait sur une personne sautée faute de « Je suis là », gardée derrière le titre revenu : la file la montre juste après lui', async () => {
  const f = harness();
  const ctx = secondRound(f, { presence: true, before: ({ rita, chloe }) => {
    f.sched.skipUnconfirmed(rita.id, 3);
    f.sched.skipUnconfirmed(chloe.id, 3);
  } });
  const { rita, bruno, chloe, nina } = ctx.people;
  assert.equal(f.sched.reservedNext?.personId, rita.id, 'l’envoi de Bruno annonce Rita ; Chloé attend encore');
  f.sched.confirm(chloe);
  assert.equal(plain(await move(f, { personId: chloe.id, toIndex: 0, priority: true })).ok, true);
  // Annulée avant que KaraFun confirme le retrait : l'annonce d'avant, la
  // priorité de Chloé, revient telle quelle.
  await pullThenUndo(f, ctx, nina, 'annulée pendant le retrait');
  assert.equal(f.sched.reservedNext?.then?.personId, chloe.id);
  assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [bruno.id, chloe.id], 'Bruno, puis Chloé, comme les envois');
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.equal(f.sched.reservedNext?.personId, chloe.id);
  assert.equal(f.sched.reservedNext?.byStaff, true, 'sa priorité tient, malgré son « Je suis là » manqué d’avant');
  assert.equal(f.sched.select()?.ids[0], chloe.id);
  assert.ok(rita);
});

test('passe 17 : priorité gardée derrière le titre revenu, sa personne notée en duo improvisé puis annulé : elle revient derrière lui', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno } = ctx.people;
  const eve = await backWithEve(f, ctx);
  f.sched.staffCountPartner(ctx.stage.ids[0], eve.id, ctx.stage);
  assert.notEqual(f.sched.reservedNext?.then?.personId, eve.id, 'sa priorité prend fin');
  f.sched.staffUncountPartner(ctx.stage.staffDuo, ctx.stage, [ctx.stage]);
  assert.equal(f.sched.reservedNext?.personId, bruno.id);
  assert.equal(f.sched.reservedNext?.then?.personId, eve.id, 'le duo noté annulé, elle revient derrière Bruno');
  assert.equal(f.sched.reservedNext?.then?.byStaff, true);
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.equal(f.sched.reservedNext?.personId, eve.id);
});

test('passe 17 : deux priorités, la plus ancienne sur un duo dont l’invitée a son « Pas prêt » : après la nouvelle, le duo part, toujours prioritaire', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { driss } = ctx.people;
  const { eve, gil } = await priorityDuoWithReport(f, ctx);
  assert.equal(plain(await move(f, { personId: driss.id, toIndex: 0, priority: true })).message,
    'Driss passe juste après « Titre Bruno », déjà chargé dans KaraFun.');
  assert.deepEqual(planned(f).slice(0, 2).map(line => line.name), ['Driss', 'Eve & Gil'], 'Driss, puis le duo d’Eve et Gil');
  assert.equal(sendNext(f).ids[0], driss.id);
  assert.equal(f.sched.reservedNext?.personId, eve.id, 'la priorité d’Eve est de nouveau annoncée');
  assert.equal(f.sched.reservedNext?.byStaff, true);
  assert.deepEqual(f.sched.select()?.ids, [eve.id, gil.id], 'le duo part, le « Pas prêt » de Gil ne le retient pas');
});

test('passe 17 : priorité avec retrait sans annulation, une priorité plus ancienne sur un duo : la priorité, le titre retiré, puis le duo, toujours prioritaire', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno, driss } = ctx.people;
  const { eve, gil } = await priorityDuoWithReport(f, ctx);
  await pullFor(f, driss);
  karafunRemoves(f, ctx);
  assert.deepEqual(planned(f).slice(0, 3).map(line => line.name), ['Driss', 'Bruno', 'Eve & Gil'], 'Driss, Bruno, puis le duo');
  assert.equal(sendNext(f).ids[0], driss.id);
  assert.equal(f.sched.reservedNext?.personId, bruno.id);
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.equal(f.sched.reservedNext?.personId, eve.id, 'la priorité d’Eve est de nouveau annoncée');
  assert.equal(f.sched.reservedNext?.byStaff, true);
  assert.deepEqual(f.sched.select()?.ids, [eve.id, gil.id]);
});

test('passe 17 : priorité avec retrait sans annulation, une personne sautée faute de « Je suis là » annoncée après le titre chargé, une nouvelle table : la priorité, le titre retiré, elle, puis la nouvelle', async () => {
  const f = harness();
  const ctx = secondRound(f, { presence: true, before: ({ rita }) => f.sched.skipUnconfirmed(rita.id, 3) });
  const { rita, bruno, chloe, nina } = ctx.people;
  await pullFor(f, chloe);
  karafunRemoves(f, ctx);
  assert.deepEqual(planned(f).slice(0, 4).map(line => line.id), [chloe.id, bruno.id, rita.id, nina.id], 'Chloé, Bruno, Rita, puis Nina');
  assert.equal(sendNext(f).ids[0], chloe.id);
  assert.equal(f.sched.reservedNext?.personId, bruno.id);
  f.sched.confirm(bruno);
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.equal(f.sched.reservedNext?.personId, rita.id, 'Rita est annoncée juste après Bruno');
  assert.equal(rita.presenceSkips, 1);
});

test('passe 17 : l’annonce gardée derrière le titre revenu devient un duo avec la personne sur scène, le titre dit « Pas prêt » : elle n’est pas annoncée, elle attend un passage', async () => {
  const f = harness();
  const ctx = secondRound(f, { presence: true, before: ({ rita }) => f.sched.skipUnconfirmed(rita.id, 3) });
  const { alice, rita, bruno, chloe } = ctx.people;
  await pullThenUndo(f, ctx, chloe, 'annulée après le retrait');
  assert.equal(f.sched.reservedNext?.then?.personId, rita.id);
  // Alice, sur scène, demande à chanter le titre de Rita, qui accepte.
  f.sched.requestDuetJoin(alice, rita.id, rita.song.entryId);
  f.sched.answerDuetJoin(rita, rita.song.entryId, alice.id, true);
  assert.deepEqual(rita.song.duet?.partnerId, alice.id);
  f.deferTurn(f.sched.people.get(bruno.id), 1);
  assert.notEqual(f.sched.reservedNext?.personId, rita.id, 'Alice ne chante pas deux fois de suite');
  assert.equal(rita.presenceRetry, true, 'Rita laisse passer un passage, comme après son manque');
});

test('passe 17 : priorité avec retrait annulée après le retrait, la personne de la priorité de nouveau annoncée par son « Pas prêt » rendu : le titre retiré d’abord', async () => {
  const f = harness();
  // Chloé a dit « Pas prêt » (1 chanson) quand son titre était le prochain.
  const ctx = secondRound(f, { presence: true, before: ({ rita, chloe }) => {
    f.sched.skipUnconfirmed(rita.id, 3);
    f.sched.deferPassage(chloe.id, { entryId: chloe.song.entryId, ids: [chloe.id] }, 1);
  } });
  const { rita, bruno, chloe } = ctx.people;
  assert.equal(f.sched.reservedNext?.personId, rita.id, 'l’envoi de Bruno annonce Rita, pas Chloé dont le report est au bout');
  f.sched.confirm(chloe);
  await pullFor(f, chloe);
  await f.call('POST /api/staff/table-left', { id: '2' }); // Rita part : son annonce ne peut plus revenir
  karafunRemoves(f, ctx);
  await f.call('POST /api/staff/priority-undo');
  assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [bruno.id, chloe.id], 'Bruno, puis Chloé');
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.ok(rita);
});

test('passe 17 : retrait noté par une sauvegarde d’avant ce correctif : une priorité donnée depuis tient, une plus ancienne de la même personne ne retient pas le titre', async () => {
  {
    const f = harness();
    const ctx = loaded(f);
    const { bruno, driss } = ctx.people;
    const gus = f.sched.join({ tableId: '6', name: 'Gus', headcount: 2 });
    f.sched.chooseSong(gus, { songId: 810, title: 'Titre Gus' });
    f.sync();
    await pullFor(f, driss);
    // Retrait noté avant la passe 17 : ni `changeId`, ni `forAt`.
    delete ctx.tr.pulled.changeId;
    delete ctx.tr.pulled.forAt;
    await move(f, { personId: gus.id, toIndex: 0, priority: true });
    karafunRemoves(f, ctx);
    assert.equal(f.sched.reservedNext?.personId, gus.id, 'la priorité donnée pendant le retrait tient');
    assert.ok(bruno);
  }
  {
    const f = harness();
    const ctx = loaded(f);
    const { bruno } = ctx.people;
    const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
    f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
    f.sync();
    await move(f, { personId: eve.id, toIndex: 0, priority: true });
    await pullFor(f, eve);
    delete ctx.tr.pulled.changeId;
    await f.call('POST /api/staff/priority-undo');
    karafunRemoves(f, ctx);
    assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [bruno.id, eve.id], 'Bruno d’abord, Eve juste après');
  }
});

test('passe 17 : priorité donnée par-dessus le titre revenu en tête, puis la personne de ce titre part : l’annulation rend la priorité qu’il gardait derrière lui', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno, chloe } = ctx.people;
  const eve = await backWithEve(f, ctx);
  await move(f, { personId: chloe.id, toIndex: 0, priority: true });
  await f.call('POST /api/staff/table-left', { id: '2' }); // la table de Bruno part
  assert.equal(f.sched.people.has(bruno.id), false);
  await f.call('POST /api/staff/manual-change-undo', { id: f.sched.manualChanges.at(-1).id });
  assert.equal(f.sched.reservedNext?.personId, eve.id, 'la priorité d’Eve, gardée derrière Bruno, revient');
  assert.equal(f.sched.reservedNext?.byStaff, true);
});

test('passe 17 : priorité sans retrait d’un duo annulée pendant son envoi, l’invitée était annoncée : elle n’est pas annoncée juste après le duo qu’elle chante', async () => {
  const f = harness();
  const ctx = secondRound(f, { before: ({ rita }) => f.deferTurn(f.sched.people.get(rita.id), 1) });
  const { rita, chloe } = ctx.people;
  assert.equal(f.sched.reservedNext?.personId, rita.id);
  const duo = f.sched.inviteDuet(chloe, rita.id, { songId: 960, title: 'Duo Chloé' });
  f.sched.answerDuet(rita, true, duo.entryId);
  f.sched.removeSong(chloe, chloe.song.entryId);
  f.sync();
  assert.equal(plain(await move(f, { personId: chloe.id, toIndex: 0, priority: true })).ok, true);
  // Le titre de Bruno commence, puis le duo part vers KaraFun.
  ctx.queue.shift();
  ctx.queue[0].status = 'playing';
  ctx.bridge.status = { state: 'playing', songPlaying: { queueId: 2 } };
  f.settings.pushDelaySec = 0;
  f.sync();
  assert.deepEqual(f.getPending()?.sel.ids, [chloe.id, rita.id], 'le duo de Chloé et Rita part vers KaraFun');
  await f.call('POST /api/staff/priority-undo');
  assert.notEqual(f.sched.reservedNext?.personId, rita.id, 'Rita, qui chante ce duo, n’est pas annoncée juste après');
});

test('passe 17 : trois priorités l’une après l’autre : elles passent de la plus récente à la plus ancienne, chacune toujours prioritaire', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { chloe, driss } = ctx.people;
  const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
  f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
  f.sync();
  for (const p of [eve, driss, chloe]) await move(f, { personId: p.id, toIndex: 0, priority: true });
  assert.deepEqual(planned(f).slice(0, 3).map(line => line.id), [chloe.id, driss.id, eve.id]);
  for (const p of [chloe, driss, eve]) {
    assert.equal(f.sched.reservedNext?.personId, p.id, `${p.name} est annoncée`);
    assert.equal(f.sched.reservedNext?.byStaff, true, `${p.name} : toujours une priorité du bar`);
    assert.equal(sendNext(f).ids[0], p.id);
  }
});

test('passe 17 : titre revenu en tête avec une priorité derrière lui, la priorité annulée part, puis une autre priorité sort son titre de KaraFun et est annulée : l’ordre d’avant revient entier', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno, chloe, driss } = ctx.people;
  const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
  f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
  f.sync();
  await move(f, { personId: eve.id, toIndex: 0, priority: true });
  await pullThenUndo(f, ctx, chloe, 'annulée pendant l’envoi de la priorité');
  assert.equal(f.sched.reservedNext?.personId, bruno.id);
  assert.equal(f.sched.reservedNext?.then?.personId, eve.id);
  // Le titre de Chloé, déjà parti, attend dans KaraFun (queueId 3).
  await pullFor(f, driss, 3);
  karafunRemoves(f, ctx, 3);
  await f.call('POST /api/staff/priority-undo');
  assert.deepEqual(planned(f).slice(0, 3).map(line => line.id), [chloe.id, bruno.id, eve.id], 'Chloé, Bruno, puis Eve');
  for (const p of [chloe, bruno]) assert.equal(sendNext(f).ids[0], p.id);
  assert.equal(f.sched.reservedNext?.personId, eve.id);
  assert.equal(f.sched.reservedNext?.byStaff, true, 'la priorité d’Eve tient encore');
});

test('passe 17 : deux « Pas prêt » levés par l’envoi du titre chargé, l’un d’eux reçoit la priorité avec retrait, annulée : le titre, puis l’autre, puis lui', async () => {
  const f = harness();
  const join = (tableId, name) => f.sched.join({ tableId, name, headcount: 2 });
  const people = { alice: join('1', 'Alice'), yan: join('2', 'Yan'), xavier: join('3', 'Xavier'), bruno: join('4', 'Bruno'), chloe: join('5', 'Chloé') };
  let songId = 970;
  for (const p of Object.values(people)) {
    for (const title of [`Titre ${p.name}`, `Titre ${p.name} 2`]) f.sched.chooseSong(p, { songId: songId++, title }, 'append');
  }
  for (let k = 0; k < 5; k++) { const sel = f.sched.select(); f.sched.commit(sel); f.sched.songEnded(sel.ids); }
  const stage = f.sched.select(); f.sched.commit(stage);
  assert.equal(stage.ids[0], people.alice.id);
  f.tracked().push({ queueId: 1, sel: stage, startedAt: Date.now() - 50000, addedAt: Date.now() - 60000 });
  f.deferTurn(f.sched.people.get(people.yan.id), 1);
  f.deferTurn(f.sched.people.get(people.xavier.id), 1);
  const next = f.sched.select(); f.sched.commit(next);
  assert.equal(next.ids[0], people.bruno.id);
  assert.equal(f.sched.reservedNext?.personId, people.yan.id, 'l’envoi de Bruno annonce Yan ; Xavier attend au bout de son report');
  const tr = { queueId: 2, sel: next, startedAt: null, addedAt: Date.now() - 5000 };
  f.tracked().push(tr);
  const queue = [{ queueId: 1, songId: stage.song.songId, title: stage.song.title, singer: stage.label, status: 'playing' },
    { queueId: 2, songId: next.song.songId, title: next.song.title, singer: next.label }];
  const ctx = { queue, tr, bridge: fakeBridge(queue, 1) };
  f.setBridge(ctx.bridge);
  f.sync();
  await pullFor(f, people.xavier);
  karafunRemoves(f, ctx);
  await f.call('POST /api/staff/priority-undo');
  assert.deepEqual(planned(f).slice(0, 3).map(line => line.id), [people.bruno.id, people.yan.id, people.xavier.id], 'Bruno, Yan, puis Xavier');
  assert.equal(sendNext(f).ids[0], people.bruno.id);
  assert.equal(f.sched.reservedNext?.personId, people.yan.id);
});

test('passe 17 : titre revenu en tête, puis une priorité : elle passe d’abord, le titre juste après, devant une nouvelle table', async () => {
  const f = harness();
  const ctx = secondRound(f, { loads: 'rita' });
  const { rita, bruno, chloe, nina } = ctx.people;
  await pullThenUndo(f, ctx, chloe, 'annulée après le retrait');
  assert.equal(f.sched.reservedNext?.personId, rita.id);
  assert.equal(plain(await move(f, { personId: bruno.id, toIndex: 0, priority: true })).ok, true);
  assert.deepEqual(planned(f).slice(0, 3).map(line => line.id), [bruno.id, rita.id, nina.id], 'Bruno, Rita, puis Nina');
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.equal(f.sched.reservedNext?.personId, rita.id);
});

test('passe 17 : priorité donnée à la personne gardée derrière le titre revenu, puis annulée : elle revient derrière lui, telle qu’elle était', async () => {
  const f = harness();
  const ctx = secondRound(f, { presence: true, before: ({ rita }) => f.sched.skipUnconfirmed(rita.id, 3) });
  const { rita, bruno, chloe, nina } = ctx.people;
  await pullThenUndo(f, ctx, chloe, 'annulée après le retrait');
  assert.equal(f.sched.reservedNext?.then?.personId, rita.id);
  f.sched.confirm(rita);
  assert.equal(plain(await move(f, { personId: rita.id, toIndex: 0, priority: true })).ok, true);
  f.sched.chooseSong(nina, { songId: 951, title: 'Autre titre Nina' }, 'append'); // la file change : annulation recalculée
  assert.equal(plain(await f.call('POST /api/staff/manual-change-undo', { id: f.sched.manualChanges.at(-1).id })).exact, false);
  assert.deepEqual(planned(f).slice(0, 3).map(line => line.id), [bruno.id, rita.id, nina.id], 'Bruno, Rita, puis Nina');
  assert.notEqual(f.sched.reservedNext?.then?.byStaff, true, 'sa priorité annulée ne revient pas');
});

test('passe 17 : priorité avec retrait qui prend fin sans annulation, une priorité plus ancienne la suivait : le titre retiré, puis elle, toujours prioritaire', async () => {
  for (const how of ['titre retiré', 'table partie']) {
    const f = harness();
    const ctx = loaded(f);
    const { bruno, driss } = ctx.people;
    const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
    f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
    f.sync();
    await move(f, { personId: eve.id, toIndex: 0, priority: true });
    await pullFor(f, driss);
    karafunRemoves(f, ctx);
    assert.deepEqual(planned(f).slice(0, 3).map(line => line.id), [driss.id, bruno.id, eve.id], how);
    if (how === 'titre retiré') await f.call('POST /api/staff/remove', { personId: driss.id });
    else await f.call('POST /api/staff/table-left', { id: '4' });
    assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [bruno.id, eve.id], `${how} : Bruno, puis Eve`);
    assert.equal(sendNext(f).ids[0], bruno.id, how);
    assert.equal(f.sched.reservedNext?.personId, eve.id, how);
    assert.equal(f.sched.reservedNext?.byStaff, true, `${how} : sa priorité tient`);
  }
});

test('passe 17 : trois priorités, celle du milieu part (sa table) : après la plus récente, la plus ancienne, toujours prioritaire', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { chloe, driss } = ctx.people;
  const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 2 });
  f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
  f.sync();
  for (const p of [eve, driss, chloe]) await move(f, { personId: p.id, toIndex: 0, priority: true });
  await f.call('POST /api/staff/table-left', { id: '4' }); // Driss part
  assert.equal(sendNext(f).ids[0], chloe.id);
  assert.equal(f.sched.reservedNext?.personId, eve.id, 'Eve est annoncée');
  assert.equal(f.sched.reservedNext?.byStaff, true, 'sa priorité tient');
});

test('passe 17 : priorité donnée à la priorité gardée derrière le titre revenu : elle passe d’abord, puis le titre, et ne revient pas après lui', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno } = ctx.people;
  const eve = await backWithEve(f, ctx);
  assert.equal(plain(await move(f, { personId: eve.id, toIndex: 0, priority: true })).ok, true);
  assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [eve.id, bruno.id], 'Eve, puis Bruno');
  assert.equal(sendNext(f).ids[0], eve.id);
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.notEqual(f.sched.reservedNext?.personId, eve.id, 'Eve, qui vient de chanter, n’est pas annoncée de nouveau');
});

test('passe 17 : priorité gardée derrière le titre revenu, notée en duo improvisé pendant un geste plus récent, puis ce geste annulé : elle ne revient pas derrière lui', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { bruno, chloe, driss } = ctx.people;
  const eve = await backWithEve(f, ctx);
  assert.equal(plain(await move(f, { personId: driss.id, toIndex: 2 })).message, null);
  assert.equal(f.sched.manualChanges.at(-1).name, 'Driss');
  f.sched.staffCountPartner(ctx.stage.ids[0], eve.id, ctx.stage);
  f.sched.chooseSong(chloe, { songId: 811, title: 'Autre titre Chloé' }, 'append'); // la file change : annulation recalculée
  await f.call('POST /api/staff/manual-change-undo', { id: f.sched.manualChanges.at(-1).id });
  assert.equal(f.sched.reservedNext?.personId, bruno.id);
  assert.notEqual(f.sched.reservedNext?.then?.personId, eve.id, 'Eve, qui vient de chanter avec Alice, ne revient pas juste derrière Bruno');
});

test('passe 17 : priorité donnée à la personne sur scène pour son titre suivant, puis priorité avec retrait annulée avant le retrait : le titre retiré, puis elle, toujours prioritaire', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { alice, bruno, driss } = ctx.people;
  f.sched.chooseSong(alice, { songId: 899, title: 'Titre Alice 2' });
  f.sync();
  assert.equal(plain(await move(f, { personId: alice.id, toIndex: 0, priority: true })).message,
    'Alice passe juste après « Titre Bruno », déjà chargé dans KaraFun.');
  await pullThenUndo(f, ctx, driss, 'annulée pendant le retrait');
  assert.deepEqual(planned(f).slice(0, 2).map(line => line.id), [bruno.id, alice.id], 'Bruno, puis Alice');
  assert.equal(sendNext(f).ids[0], bruno.id);
  assert.equal(f.sched.reservedNext?.personId, alice.id);
  assert.equal(f.sched.reservedNext?.byStaff, true, 'sa priorité tient');
});

// Relecture (passe 8, équipe rouge) : « Annuler mon changement et recalculer »
// (POST /api/staff/queue-optimize) abandonnait les gestes sans les annuler :
// le « Pas prêt » qu'un déplacement avait levé ne revenait pas, alors que
// « Annuler tous les changements manuels » le rend. Les deux « Annuler » du
// bar laissent maintenant la file dans le même état, puis le calcul repart.
test('« Annuler mon changement et recalculer » : les gestes sont annulés comme « Annuler tous les changements », puis le calcul repart', async () => {
  const f = harness();
  const ctx = loaded(f);
  const { chloe, driss } = ctx.people;
  const eve = f.sched.join({ tableId: '5', name: 'Eve', headcount: 1 });
  f.sched.chooseSong(eve, { songId: 809, title: 'Titre Eve' });
  const line = f.sched.presenceView([ctx.tr.sel.ids[0]]).find(v => !v.future && v.ids[0] === chloe.id);
  f.sched.deferPassage(chloe.id, line, 2);
  assert.equal(f.sched.isDeferred(chloe), true);
  assert.deepEqual(shown(f), ['Driss', 'Eve', 'Chloé']);
  await move(f, { personId: chloe.id, toIndex: 1 });
  assert.deepEqual(shown(f), ['Driss', 'Chloé*', 'Eve']);
  assert.equal(f.sched.isDeferred(chloe), false, 'le déplacement lève son « Pas prêt »');
  assert.equal(f.sched.manualChanges.length, 1);
  const result = plain(await f.call('POST /api/staff/queue-optimize'));
  assert.equal(result.ok, true);
  assert.deepEqual(f.sched.manualChanges, [], 'le geste est annulé');
  assert.equal(f.sched.isDeferred(chloe), true, 'son « Pas prêt » revient, comme avec « Annuler tous les changements »');
  assert.ok(notes(f).some(msg => /Le bar a annulé 1 changement manuel/.test(msg)), 'le journal du bar le dit');
  assert.ok(driss);
});

// Relecture (passe 9, équipe rouge ; déjà sur main) : « Je suis là »
// obligatoire, scène libre, plus personne d'autre ne peut chanter. La file
// montrait le passage repoussé en premier, la présence lui était demandée et
// skipAbsentIfDue le comptait absent alors que son « Pas prêt » courait
// encore : au bout de trois manques son titre était retiré. Comme le repli de
// select(), le report prend fin (« Personne d’autre ne peut chanter »), le
// passage devient le prochain annoncé, et la demande « Je suis là » commence
// alors seulement.
test('« Je suis là » obligatoire, scène libre, seul un « Pas prêt » attend : il n’est pas compté absent, il part', async () => {
  const f = harness();
  const s = f.sched;
  s.opts.requirePresence = true;
  f.settings.requirePresence = true;
  f.settings.presenceGraceSec = 0;
  const bob = s.join({ tableId: '2', name: 'Bob', headcount: 1 });
  const cid = s.join({ tableId: '3', name: 'Cid', headcount: 1 });
  s.chooseSong(bob, { songId: 802, title: 'Titre Bob' });
  s.chooseSong(cid, { songId: 803, title: 'Titre Cid' });
  s.deferPassage(bob.id, s.presenceView().find(v => !v.future && v.ids[0] === bob.id), 1);
  s.removeSong(cid, cid.song.entryId);
  f.setBridge(fakeBridge([], null));
  f.sync();
  assert.equal(s.presenceSkipsOf(bob), 0, 'Bob n’est pas compté absent pendant son « Pas prêt »');
  assert.equal(s.isDeferred(bob), false, 'personne d’autre ne peut chanter : son report prend fin');
  assert.equal(s.reservedNext?.personId, bob.id, 'il est le prochain annoncé');
  assert.ok(notes(f).some(msg => /Personne d’autre ne peut chanter : le passage repoussé de Bob part maintenant/.test(msg)));
  s.confirm(bob);
  f.sync();
  assert.deepEqual(f.getPending()?.sel.ids, [bob.id], 'confirmé, il part vers KaraFun');
});
