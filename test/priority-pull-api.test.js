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
  assert.deepEqual(plain(ctx.tr.pulled), { reason: 'priority', at: ctx.tr.pulled.at, forId: driss.id });
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

test('priorité avant un titre chargé avec « Je suis là » : la priorité confirme, le titre retiré garde sa confirmation', async () => {
  const f = harness();
  const ctx = loaded(f, { presence: true });
  const { bruno, driss } = ctx.people;
  await pullFor(f, driss);
  assert.deepEqual(plain(f.staffState().presencePending), [], 'pendant le retrait, personne n’est appelé');
  karafunRemoves(f, ctx);
  assert.deepEqual(plain(f.staffState().presencePending), ['Driss'], 'la priorité confirme sa présence');
  f.sched.confirm(driss);
  f.sched.commit(f.sched.select());
  assert.equal(f.sched.reservedNext?.personId, bruno.id);
  assert.equal(bruno.held, 0, 'pas compté absent');
  assert.ok(f.sched.confirmedForTurn([bruno.id]), 'son « Je suis là » donné pour ce titre tient');
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

// Relecture : le retrait sortait le titre chargé de KaraFun pour une personne
// qui ne pouvait pas passer ensuite (invitée d'un duo repoussé par « Pas
// prêt », titre passé faute de « Je suis là ») : quelqu'un d'autre partait,
// et le titre retiré attendait derrière une priorité qui ne partait pas.
test('priorité avec retrait pour une personne qui ne peut pas passer ensuite : refusée, rien retiré', async () => {
  {
    // Eve est l'invitée du duo de Chloé, repoussé ; elle a aussi son titre.
    const f = harness();
    const ctx = loaded(f);
    const { chloe, driss } = ctx.people;
    const eve = f.sched.join({ tableId: '3', name: 'Eve' });
    f.sched.removeSong(chloe, chloe.song.entryId);
    f.sched.inviteDuet(chloe, eve.id, { songId: 811, title: 'Duo Chloé' });
    f.sched.chooseSong(eve, { songId: 812, title: 'Titre Eve' });
    f.sync();
    f.deferTurn(f.sched.people.get(chloe.id), 2);
    assert.deepEqual(planned(f).map(line => line.name), ['Driss', 'Chloé & Eve', 'Eve']);
    // Relecture : la page proposait le retrait à Eve d'après sa propre copie
    // de la règle ; la liste du serveur suit les refus de priorityPullFor.
    assert.deepEqual(plain(f.staffState().priorityPull.lineIds), [driss.id, chloe.id], 'pas de retrait proposé à Eve');
    await assert.rejects(pullFor(f, eve), { message: 'Eve attend la fin du « Pas prêt » de Chloé & Eve : ' +
      '« Titre Bruno » reste dans KaraFun, rien n’a été retiré ni avancé.' });
    nothingChanged(f, ctx);
    assert.equal(f.sched.select().ids[0], driss.id, 'la file reste comme avant');
    // Chloé, elle, peut passer : le geste du bar lève son propre « Pas prêt ».
    await pullFor(f, chloe);
    assert.deepEqual(removals(ctx.bridge), [['remove', 2]]);
    karafunRemoves(f, ctx);
    assert.deepEqual(f.sched.select().ids, [chloe.id, eve.id]);
  }
  {
    // Driss n'a pas confirmé « Je suis là » : son titre laisse passer le suivant.
    const f = harness();
    const ctx = loaded(f, { presence: true });
    const { chloe, driss } = ctx.people;
    f.sched.skipUnconfirmed(driss.id, 3);
    f.sync();
    assert.ok(planned(f).some(line => line.id === driss.id));
    assert.deepEqual(plain(f.staffState().priorityPull.lineIds), [chloe.id], 'pas de retrait proposé à Driss');
    await assert.rejects(pullFor(f, driss), { message: 'Driss n’a pas confirmé sa présence : son titre laisse passer le suivant. ' +
      '« Titre Bruno » reste dans KaraFun, rien n’a été retiré ni avancé.' });
    nothingChanged(f, ctx);
    assert.equal(planned(f)[0].id, chloe.id, 'la file reste comme avant');
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
