'use strict';
// Routes de la page du bar que la suite n'exerçait pas encore : déplacer et
// prioriser un titre, retirer plusieurs titres, marquer une personne partie
// puis la réactiver, préparer les tables et les invitations En solo, régler
// la soirée, piloter Spotify et lire l'état du bar. Les gestionnaires de
// server.js sont appelés directement dans un bac à sable (--demo) : aucun
// port ouvert, aucun réseau, un faux pont KaraFun et un faux Spotify.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

// Même harnais que review-v04-fixes.test.js : server.js sans son point
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
    globalThis.fixture = { sched, settings, handlers, access, spotify, spotifyAutomation, staffState, publicState, battleVote,
      tracked: () => tracked, setBridge: b => { bridge = b; }, setPending: p => { pending = p; },
      getPending: () => pending };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  // Appel d'une route comme le ferait le serveur HTTP (req, res, corps JSON).
  f.call = (route, body = {}) => {
    const handler = f.handlers[route];
    assert.equal(typeof handler, 'function', `route absente : ${route}`);
    return handler({}, {}, body);
  };
  return f;
}

// Les objets du bac à sable viennent d'un autre domaine : comparer leurs valeurs.
const plain = value => JSON.parse(JSON.stringify(value));
const lastNote = f => f.sched.log.at(-1);
const notes = f => f.sched.log.map(line => line.msg);

// Faux pont KaraFun : journal des commandes, file et lecture configurables.
function fakeBridge(queue = [], playingId = null) {
  const calls = [];
  return { calls, ready: true, connected: true, queue, events: [], permissions: {},
    snapshot: () => ({ ready: true, connected: true, queue, events: [] }),
    status: playingId == null ? { state: 'idle' } : { state: 'playing', songPlaying: { queueId: playingId } },
    add: (songId, singer, pos) => calls.push(['add', songId, pos]), remove: id => calls.push(['remove', id]),
    next: () => calls.push(['next']), play: () => calls.push(['play']) };
}

// Un chanteur par table, chacun avec un titre.
function singers(f, names, headcount = 2) {
  return names.map((name, i) => {
    const p = f.sched.join({ tableId: String(i + 1), name, headcount });
    f.sched.chooseSong(p, { songId: 900 + i, title: `Titre ${name}` });
    return p;
  });
}

const order = f => f.sched.presenceView().filter(v => !v.future).map(v => v.name);

// Envoie le prochain passage à KaraFun et le suit sous `queueId`.
function sendNext(f, queueId, extra = {}) {
  const sel = f.sched.select();
  f.sched.commit(sel);
  const tr = { queueId, sel, addedAt: Date.now(), startedAt: null, ...extra };
  f.tracked().push(tr);
  return tr;
}

// ---------------------------------------------------------------- déplacer, prioriser
test('priorité : le titre passe en tête, le bar voit l’intervention et peut l’annuler', async () => {
  const f = harness();
  const [, , chloe] = singers(f, ['Alice', 'Bruno', 'Chloé']);
  assert.deepEqual(plain(order(f)), ['Alice', 'Bruno', 'Chloé']);

  const result = await f.call('POST /api/staff/move', { personId: chloe.id, toIndex: 0, priority: true });
  assert.deepEqual(plain(result), { ok: true, firstFreePosition: 1, message: null });
  assert.deepEqual(plain(order(f)), ['Chloé', 'Alice', 'Bruno']);
  assert.equal(lastNote(f).msg, 'Le bar a déplacé Chloé de la place 3 à la place 1');
  assert.equal(lastNote(f).kind, 'staff');

  const state = f.staffState();
  assert.deepEqual(plain(state.priorityUndo), { available: true, name: 'Chloé' });
  assert.equal(state.manualChanges.length, 1);
  const [change] = plain(state.manualChanges);
  assert.equal(change.kind, 'priority');
  assert.equal(change.name, 'Chloé');
  assert.equal(change.from, 3);
  assert.equal(change.to, 1);
  assert.equal(change.canUndo, true);
  assert.equal(change.unavailableReason, null);

  assert.deepEqual(plain(await f.call('POST /api/staff/priority-undo')), { ok: true });
  assert.deepEqual(plain(order(f)), ['Alice', 'Bruno', 'Chloé']);
  assert.equal(lastNote(f).msg, 'Le bar a annulé la priorité de Chloé');
  assert.equal(f.staffState().priorityUndo, null);
  await assert.rejects(f.call('POST /api/staff/priority-undo'),
    { message: 'La dernière intervention du bar n’est pas une priorité.' });
});

test('déplacement simple : pas une priorité, deux interventions annulées dans l’ordre inverse', async () => {
  const f = harness();
  const [alice, , chloe] = singers(f, ['Alice', 'Bruno', 'Chloé']);
  await f.call('POST /api/staff/move', { personId: chloe.id, toIndex: 1 });
  assert.deepEqual(plain(order(f)), ['Alice', 'Chloé', 'Bruno']);
  assert.equal(f.sched.manualChanges.at(-1).kind, 'move');
  // `priority` n'a de sens que vers la première place.
  await f.call('POST /api/staff/move', { personId: alice.id, toIndex: 2, priority: true });
  assert.deepEqual(plain(order(f)), ['Chloé', 'Bruno', 'Alice']);
  assert.equal(f.sched.manualChanges.at(-1).kind, 'move');
  assert.equal(f.staffState().priorityUndo, null, 'aucune priorité à annuler');
  await assert.rejects(f.call('POST /api/staff/priority-undo'),
    { message: 'La dernière intervention du bar n’est pas une priorité.' });

  const views = plain(f.staffState().manualChanges);
  assert.deepEqual(views.map(v => [v.name, v.from, v.to, v.canUndo]), [['Alice', 1, 3, true], ['Chloé', 3, 2, false]]);
  assert.equal(views[1].unavailableReason, 'Annule d’abord les interventions plus récentes.');
  // Annuler la plus ancienne d'abord est refusé.
  await assert.rejects(f.call('POST /api/staff/manual-change-undo', { id: views[1].id }),
    { message: 'Annule d’abord le changement manuel le plus récent.' });
  await assert.rejects(f.call('POST /api/staff/manual-change-undo', {}),
    { message: 'Indique le changement manuel à annuler.' });
  await f.call('POST /api/staff/manual-change-undo', { id: views[0].id });
  assert.deepEqual(plain(order(f)), ['Alice', 'Chloé', 'Bruno']);
  assert.equal(lastNote(f).msg, 'Le bar a annulé le déplacement de Alice');
});

test('déplacement : même place, déjà premier, chanteur absent ou place invalide', async () => {
  const f = harness();
  const [alice, bruno] = singers(f, ['Alice', 'Bruno', 'Chloé']);
  const same = await f.call('POST /api/staff/move', { personId: bruno.id, toIndex: 1 });
  assert.deepEqual(plain(same), { ok: true, changed: false, message: 'Ce titre est déjà à cette place.' });
  assert.equal(f.sched.manualChanges.length, 0, 'rien n’est enregistré');
  await assert.rejects(f.call('POST /api/staff/move', { personId: alice.id, toIndex: 0, priority: true }),
    { message: 'Ce titre est déjà le prochain passage libre.' });
  await assert.rejects(f.call('POST /api/staff/move', { personId: 'inconnu', toIndex: 0 }),
    { message: 'Cette chanson n’est plus dans la file du helper.' });
  await assert.rejects(f.call('POST /api/staff/move', { personId: bruno.id, toIndex: 7 }),
    { message: 'Place de destination invalide.' });
  await assert.rejects(f.call('POST /api/staff/move', { personId: bruno.id, toIndex: 'x' }),
    { message: 'Place de destination invalide.' });
  assert.deepEqual(plain(order(f)), ['Alice', 'Bruno', 'Chloé'], 'aucun refus ne change l’ordre');
});

test('priorité avec des titres déjà chargés dans KaraFun : première place libre annoncée', async () => {
  const f = harness();
  const [alice, , chloe] = singers(f, ['Alice', 'Bruno', 'Chloé']);
  // Deux titres ajoutés hors de l'application attendent dans KaraFun.
  const bridge = fakeBridge([{ queueId: 51, songId: 1, title: 'Natif 1', singer: 'Zoé' },
    { queueId: 52, songId: 2, title: 'Natif 2', singer: 'Yann' }]);
  f.setBridge(bridge);
  await assert.rejects(f.call('POST /api/staff/move', { personId: alice.id, toIndex: 0, priority: true }),
    { message: 'Ce titre est déjà le prochain passage libre. 2 titres sont déjà chargés dans KaraFun devant lui.' });
  const result = plain(await f.call('POST /api/staff/move', { personId: chloe.id, toIndex: 0, priority: true }));
  assert.equal(result.firstFreePosition, 3);
  assert.equal(result.message, 'Passage avancé à la première place libre, après 2 titres déjà chargés dans KaraFun.');
  assert.equal(plain(order(f))[0], 'Chloé');
  assert.deepEqual(bridge.calls, [], 'KaraFun ne reçoit aucune commande');

  // Un seul titre natif : accord au singulier.
  bridge.queue.splice(1, 1);
  await assert.rejects(f.call('POST /api/staff/move', { personId: chloe.id, toIndex: 0, priority: true }),
    { message: 'Ce titre est déjà le prochain passage libre. 1 titre est déjà chargé dans KaraFun devant lui.' });
});

test('recalcul de la file : toutes les interventions du bar sont défaites d’un coup', async () => {
  const f = harness();
  const [alice, , chloe] = singers(f, ['Alice', 'Bruno', 'Chloé']);
  await assert.rejects(f.call('POST /api/staff/queue-recalculate'), { message: 'Aucun changement manuel à annuler.' });
  await f.call('POST /api/staff/move', { personId: chloe.id, toIndex: 0, priority: true });
  await f.call('POST /api/staff/move', { personId: alice.id, toIndex: 2 });
  assert.deepEqual(plain(order(f)), ['Chloé', 'Bruno', 'Alice']);
  assert.deepEqual(plain(await f.call('POST /api/staff/queue-recalculate')), { ok: true, undone: 2 });
  assert.deepEqual(plain(order(f)), ['Alice', 'Bruno', 'Chloé']);
  assert.equal(lastNote(f).msg, 'Le bar a annulé 2 changements manuels dans la file');
});

test('optimisation forcée sans optimiseur : la règle locale reprend et les déplacements sont abandonnés', async () => {
  const f = harness();
  const [, , chloe] = singers(f, ['Alice', 'Bruno', 'Chloé']);
  await f.call('POST /api/staff/move', { personId: chloe.id, toIndex: 1 });
  assert.deepEqual(plain(order(f)), ['Alice', 'Chloé', 'Bruno']);
  assert.equal(f.staffState().solver.plan, 'manual');
  const result = plain(await f.call('POST /api/staff/queue-optimize'));
  assert.deepEqual(result, { ok: true, started: false,
    message: 'Optimisation indisponible : la file a été recalculée par la règle locale.' });
  assert.equal(lastNote(f).msg, 'Le bar relance le calcul de la file ; les déplacements manuels sont abandonnés');
  assert.equal(f.sched.manualChanges.length, 0);
  assert.deepEqual(plain(order(f)), ['Alice', 'Bruno', 'Chloé']);
  assert.equal(f.staffState().solver.plan, 'local');
});

// Regression: trouvé en écrivant les tests manquants (2 octobre) — une
// priorité survivait à « Recalculer la file » sans pouvoir être annulée.
test('optimisation forcée après une priorité : la priorité est abandonnée avec les autres déplacements', async () => {
  const f = harness();
  const [, , chloe] = singers(f, ['Alice', 'Bruno', 'Chloé']);
  await f.call('POST /api/staff/move', { personId: chloe.id, toIndex: 0, priority: true });
  assert.deepEqual(plain(order(f)), ['Chloé', 'Alice', 'Bruno']);
  await f.call('POST /api/staff/queue-optimize');
  assert.deepEqual(plain(order(f)), ['Alice', 'Bruno', 'Chloé'], 'la règle locale reprend tout l’ordre');
  assert.equal(f.sched.reservedNext, null);
});

test('optimisation forcée avec optimiseur : calcul complet de 30 s demandé et annoncé au bar', async () => {
  const f = harness();
  singers(f, ['Alice', 'Bruno']);
  const requests = [];
  // Optimiseur factice : accepte la demande sans lancer Java.
  f.sched.solverBridge = { available: true };
  f.sched._requestSolver = (fingerprint, options) => { requests.push(plain(options)); return true; };
  const result = plain(await f.call('POST /api/staff/queue-optimize'));
  assert.equal(result.started, true);
  assert.equal(result.message, 'Calcul complet lancé : 30 secondes au plus, puis la recherche continue tant que la file ne change pas. La file affichée reste utilisable pendant ce temps.');
  assert.deepEqual(requests, [{ budgetMs: 30000, forced: true }]);
  assert.equal(lastNote(f).msg, 'Le bar relance le calcul de la file');
});

// ---------------------------------------------------------------- retrait groupé
test('retrait groupé : un titre suivant d’une liste et un titre courant, refus expliqués', async () => {
  const f = harness();
  const [alice, bruno] = singers(f, ['Alice', 'Bruno']);
  f.sched.chooseSong(alice, { songId: 990, title: 'Deuxième Alice' }, 'append');
  const second = alice.backlog[0].entryId;
  await assert.rejects(f.call('POST /api/staff/remove-many', {}), { message: 'Coche au moins un titre à retirer.' });
  await assert.rejects(f.call('POST /api/staff/remove-many', { items: 'tout', queueIds: [] }),
    { message: 'Coche au moins un titre à retirer.' });

  const result = plain(await f.call('POST /api/staff/remove-many', { items: [
    { personId: alice.id, entryId: second },
    { personId: bruno.id },
    { personId: 'personne' },
    { personId: alice.id, entryId: 'absent' },
  ] }));
  assert.equal(result.removed, 2);
  assert.equal(result.skipped, 2);
  assert.equal(result.message, '2 titres retirés ; 2 ignorés (Chanteur inconnu., Titre introuvable dans la liste de ce chanteur.).');
  assert.equal(alice.song.title, 'Titre Alice', 'le titre courant d’Alice reste');
  assert.equal(alice.backlog.length, 0);
  assert.equal(bruno.song, null);
  assert.ok(notes(f).includes('Le bar a retiré « Deuxième Alice » de la liste de Alice'));
  assert.ok(notes(f).includes('Le bar a retiré « Titre Bruno » de Bruno'));
  assert.deepEqual(plain(order(f)), ['Alice']);

  const single = plain(await f.call('POST /api/staff/remove-many', { items: [{ personId: alice.id }] }));
  assert.equal(single.message, '1 titre retiré.');
});

test('retrait groupé : le titre en cours d’envoi à KaraFun est protégé', async () => {
  const f = harness();
  const [alice, bruno] = singers(f, ['Alice', 'Bruno']);
  f.setPending({ sel: { ids: [alice.id], song: alice.song, label: 'Alice · Table 1', names: ['Alice'] }, cancelled: false,
    before: new Set(), at: Date.now() });
  const result = plain(await f.call('POST /api/staff/remove-many', { items: [
    { personId: alice.id, entryId: alice.song.entryId }, { personId: alice.id }, { personId: bruno.id }] }));
  assert.equal(result.removed, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.message, '1 titre retiré ; 2 ignorés (titre en cours d’envoi à KaraFun).');
  assert.ok(alice.song, 'le titre d’Alice reste');
  assert.equal(bruno.song, null);
  // Un envoi annulé ne protège plus rien.
  f.getPending().cancelled = true;
  const after = plain(await f.call('POST /api/staff/remove-many', { items: [{ personId: alice.id }] }));
  assert.equal(after.removed, 1);
  assert.equal(alice.song, null);
});

test('retrait groupé de titres KaraFun : seuls les titres suivis et pas sur scène partent', async () => {
  const f = harness();
  singers(f, ['Alice', 'Bruno', 'Chloé']);
  const onStage = sendNext(f, 11, { startedAt: Date.now() });
  const next = sendNext(f, 12);
  const queue = [{ queueId: 11, songId: onStage.sel.song.songId, singer: onStage.sel.label },
    { queueId: 12, songId: next.sel.song.songId, singer: next.sel.label }];
  const bridge = fakeBridge(queue, 11);
  f.setBridge(bridge);
  const result = plain(await f.call('POST /api/staff/remove-many', { queueIds: [12, 11, 99] }));
  assert.deepEqual(bridge.calls, [['remove', 12]], 'jamais le titre en cours ni un titre inconnu');
  assert.equal(result.removed, 1);
  assert.equal(result.message, '1 titre retiré ; 2 ignorés (titre déjà sur scène ou absent de KaraFun).');

  // KaraFun refuse le retrait : le refus est rapporté au bar.
  bridge.remove = () => { throw new Error('KaraFun occupé'); };
  const refused = plain(await f.call('POST /api/staff/remove-many', { queueIds: ['12'] }));
  assert.equal(refused.removed, 0);
  assert.equal(refused.message, '0 titre retiré ; 1 ignoré (KaraFun occupé).');
});

// ---------------------------------------------------------------- partir, revenir
test('personne partie : titres suivants retirés de KaraFun, envoi en cours annulé, titre sur scène gardé', async () => {
  const f = harness();
  const [alice, bruno] = singers(f, ['Alice', 'Bruno']);
  f.sched.chooseSong(alice, { songId: 991, title: 'Encore Alice' }, 'append');
  const stage = sendNext(f, 21, { startedAt: Date.now() }); // Alice chante
  assert.deepEqual(plain(stage.sel.ids), [alice.id]);
  const upcoming = sendNext(f, 22); // Bruno est chargé ensuite
  assert.deepEqual(plain(upcoming.sel.ids), [bruno.id]);
  const queue = [{ queueId: 21, songId: stage.sel.song.songId, singer: stage.sel.label },
    { queueId: 22, songId: upcoming.sel.song.songId, singer: upcoming.sel.label }];
  const bridge = fakeBridge(queue, 21);
  f.setBridge(bridge);

  // Alice part pendant son titre : rien à retirer, sa liste est vidée.
  const aliceLeft = plain(await f.call('POST /api/staff/person/leave', { personId: alice.id }));
  assert.deepEqual(aliceLeft, { ok: true, removedFromKaraFun: 0, pendingCancelled: false });
  assert.deepEqual(bridge.calls, []);
  assert.ok(alice.withdrawnAt);
  assert.equal(alice.backlog.length, 0);
  assert.ok(!f.sched.Q.includes(alice.id));
  assert.equal(stage.cancelled, undefined, 'le titre sur scène continue');

  // Bruno part : son titre chargé est retiré, l'envoi en cours est annulé.
  f.setPending({ sel: { ids: [bruno.id], song: { entryId: 'x', songId: 5, title: 'Envoi' }, label: 'Bruno', names: ['Bruno'] },
    cancelled: false, before: new Set([21, 22]), at: Date.now() });
  const brunoLeft = plain(await f.call('POST /api/staff/person/leave', { personId: bruno.id }));
  assert.deepEqual(brunoLeft, { ok: true, removedFromKaraFun: 1, pendingCancelled: true });
  assert.deepEqual(bridge.calls, [['remove', 22]]);
  assert.equal(upcoming.cancelled, true);
  assert.equal(f.staffState().removalPending, 1, 'le bar voit le retrait en attente');
  assert.ok(notes(f).includes('Bruno a retiré ses chansons ; son identité reste inscrite à la table'));

  await assert.rejects(f.call('POST /api/staff/person/leave', { personId: 'fantôme' }), { message: 'Chanteur inconnu.' });
});

test('personne partie : un retrait refusé par KaraFun est signalé au bar', async () => {
  const f = harness();
  const [alice] = singers(f, ['Alice', 'Bruno']);
  const tr = sendNext(f, 31);
  const bridge = fakeBridge([{ queueId: 31, songId: tr.sel.song.songId, singer: tr.sel.label }]);
  bridge.remove = () => { throw new Error('connexion perdue'); };
  f.setBridge(bridge);
  const result = plain(await f.call('POST /api/staff/person/leave', { personId: alice.id }));
  assert.equal(result.removedFromKaraFun, 1);
  assert.ok(f.sched.log.some(l => l.msg === 'Retrait KaraFun à vérifier : connexion perdue' && l.kind === 'error'));
});

test('réactiver une personne partie : historique gardé, table pleine ou fermée refusée', async () => {
  const f = harness();
  const alice = f.sched.join({ tableId: '1', name: 'Alice', headcount: 2 });
  const bruno = f.sched.join({ tableId: '1', name: 'Bruno' });
  alice.sung = 2;
  await assert.rejects(f.call('POST /api/staff/person/reactivate', { personId: alice.id }),
    { message: 'Cette personne n’est pas marquée partie.' });
  await assert.rejects(f.call('POST /api/staff/person/reactivate', {}),
    { message: 'Cette personne n’est pas marquée partie.' });

  await f.call('POST /api/staff/person/leave', { personId: alice.id });
  assert.equal(f.staffState().people.find(p => p.id === alice.id).active, false);
  // La table est réduite à une place, occupée par Bruno.
  f.sched.setHeadcount('1', 1, 'staff');
  await assert.rejects(f.call('POST /api/staff/person/reactivate', { personId: alice.id }),
    { message: 'La table est pleine. Ajuste son effectif avant de réactiver cette personne.' });
  f.sched.setHeadcount('1', 2, 'staff');
  assert.deepEqual(plain(await f.call('POST /api/staff/person/reactivate', { personId: alice.id })), { ok: true });
  assert.equal(alice.withdrawnAt, null);
  assert.equal(alice.sung, 2, 'les passages déjà faits comptent toujours');
  assert.equal(lastNote(f).msg, 'Alice revient à Table 1 ; son historique de passages est conservé');
  const view = f.staffState().people.find(p => p.id === alice.id);
  assert.equal(view.active, true);
  assert.equal(f.staffState().tables.find(t => t.id === '1').activeCount, 2);

  // Table fermée entre-temps (soirée restaurée partiellement).
  f.sched.leave(bruno);
  f.sched.tables.delete('1');
  await assert.rejects(f.call('POST /api/staff/person/reactivate', { personId: bruno.id }),
    { message: 'La table n’est plus ouverte.' });
});

test('réactiver En solo : pas de nombre de places à respecter', async () => {
  const f = harness();
  const solo = f.sched.table('Comptoir');
  solo.headcount = 1;
  const a = f.sched.join({ tableId: 'Comptoir', name: 'Solène' });
  f.sched.join({ tableId: 'Comptoir', name: 'Théo' });
  f.sched.leave(a);
  assert.deepEqual(plain(await f.call('POST /api/staff/person/reactivate', { personId: a.id })), { ok: true });
  assert.equal(a.withdrawnAt, null);
});

// ---------------------------------------------------------------- « Pas prêt » puis « Je suis prêt »
test('« Je suis prêt » : le passage repoussé reprend sa place, sans report rien n’est changé', async () => {
  const f = harness();
  const [alice] = singers(f, ['Alice', 'Bruno', 'Chloé']);
  const secret = f.access.issue('1');
  const body = { table: '1', access: secret, personId: alice.id, token: alice.token };
  await assert.rejects(f.call('POST /api/table/defer/cancel', body),
    { message: 'Aucun passage repoussé pour cette personne.' });
  const deferred = plain(await f.call('POST /api/table/defer', { ...body, songs: 1 }));
  assert.equal(deferred.deferral.remaining, 1);
  assert.equal(plain(order(f))[0], 'Bruno');
  assert.deepEqual(plain(await f.call('POST /api/table/defer/cancel', body)), { ok: true });
  assert.equal(alice.deferral, null);
  assert.equal(plain(order(f))[0], 'Alice');
  assert.equal(lastNote(f).msg, 'Alice est prêt : son passage reprend sa place');
  // Mauvais téléphone : refus avant tout changement.
  await assert.rejects(f.call('POST /api/table/defer/cancel', { ...body, token: 'autre' }), { code: 'PERSON_ACCESS' });
});

test('« Je suis prêt » pendant le retrait KaraFun : le report est effacé, le titre reviendra sans report', async () => {
  const f = harness();
  const [alice] = singers(f, ['Alice', 'Bruno']);
  const tr = sendNext(f, 41, { pulled: { reason: 'defer', at: Date.now() } });
  assert.deepEqual(plain(tr.sel.ids), [alice.id]);
  alice.deferral = { entryId: tr.sel.song.entryId, ids: [alice.id], remaining: 1, total: 1, until: Date.now() + 60000 };
  const secret = f.access.issue('1');
  await f.call('POST /api/table/defer/cancel', { table: '1', access: secret, personId: alice.id, token: alice.token });
  assert.equal(alice.deferral, null);
  assert.equal(lastNote(f).msg, 'Alice est prêt : son titre reprend sa place dès son retrait de KaraFun');
  assert.deepEqual(plain(tr.pulled), { reason: 'defer', at: tr.pulled.at }, 'le retrait KaraFun continue');
});

// ---------------------------------------------------------------- tables et En solo
test('préparer les tables : QR émis, effectif réglé, bornes respectées', async () => {
  const f = harness();
  assert.deepEqual(plain(await f.call('POST /api/staff/tables-create', { count: 3, headcount: 4 })), { ok: true });
  for (const id of ['1', '2', '3']) {
    assert.equal(f.sched.table(id, false).headcount, 4);
    assert.ok(f.access.get(id), `QR de la table ${id}`);
  }
  assert.equal(f.sched.table('4', false), undefined);
  assert.ok(f.access.get('Comptoir'), 'le groupe En solo a toujours son QR');
  assert.equal(f.sched.table('Comptoir', false).individual, true);
  await f.call('POST /api/staff/settings', { baseUrl: 'https://chant.exemple.fr' });
  const tables = f.staffState().tables;
  const one = tables.find(t => t.id === '1');
  assert.match(one.url, /^https:\/\/chant\.exemple\.fr\/t\/1\/[A-Za-z0-9_-]{22}$/);
  assert.equal(one.qrUrl, '/qr/1.svg');
  assert.equal(one.count, 0);

  // Une seconde préparation garde les QR déjà imprimés.
  const secret = f.access.get('2');
  await f.call('POST /api/staff/tables-create', { count: 3 });
  assert.equal(f.access.get('2'), secret);
  assert.equal(f.sched.table('2', false).headcount, 4, 'sans effectif, rien ne change');

  const g = harness();
  await g.call('POST /api/staff/tables-create', { count: 'beaucoup' });
  assert.ok(g.sched.table('10', false) && !g.sched.table('11', false), '10 tables par défaut');
  const h = harness();
  await h.call('POST /api/staff/tables-create', { count: 500 });
  assert.ok(h.sched.table('60', false) && !h.sched.table('61', false), '60 tables au plus');
});

test('invitation En solo : lien et QR à usage unique, secret absent de l’état du bar', async () => {
  const f = harness();
  await assert.rejects(f.call('POST /api/staff/solo-invite', {}), { message: 'Groupe de personnes seules indisponible.' });
  await f.call('POST /api/staff/tables-create', { count: 2 });
  await f.call('POST /api/staff/settings', { baseUrl: 'http://192.168.1.20:3000' });
  await assert.rejects(f.call('POST /api/staff/solo-invite', { tableId: '1' }),
    { message: 'Groupe de personnes seules indisponible.' });

  const invite = plain(await f.call('POST /api/staff/solo-invite', {}));
  const secret = f.access.get('Comptoir');
  const url = new URL(invite.url);
  assert.equal(url.origin, 'http://192.168.1.20:3000');
  assert.equal(url.pathname, `/t/Comptoir/${secret}`);
  const token = url.searchParams.get('invitation');
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.match(invite.qr, /^data:image\/png;base64,/);
  assert.ok(invite.expiresAt > Date.now() + 25 * 60000);
  assert.equal(lastNote(f).msg, 'Le bar a préparé une invitation individuelle pour Comptoir.');

  const state = f.staffState();
  assert.deepEqual(state.soloInvitations.map(i => i.id), [invite.id]);
  assert.ok(!JSON.stringify(state).includes(token), 'le jeton de l’invitation ne quitte pas la réponse');

  assert.deepEqual(plain(await f.call('POST /api/staff/solo-invite/revoke', { id: invite.id })), { ok: true });
  assert.equal(lastNote(f).msg, 'Le bar a annulé une invitation individuelle.');
  assert.equal(f.staffState().soloInvitations.length, 0);
  await assert.rejects(f.call('POST /api/staff/solo-invite/revoke', { id: invite.id }),
    { message: 'Invitation inconnue ou déjà utilisée.' });
});

test('groupe En solo : ses tours restent individuels ; une table occupée ne change plus de mode', async () => {
  const f = harness();
  await assert.rejects(f.call('POST /api/staff/table', { id: 'Comptoir', individual: false }),
    { message: 'Le groupe En solo garde ses tours individuels pendant toute la soirée.' });
  await f.call('POST /api/staff/table', { id: '7', headcount: 3 });
  assert.equal(f.sched.table('7', false).headcount, 3);
  assert.ok(f.access.get('7'));
  f.sched.join({ tableId: '7', name: 'Inès' });
  await assert.rejects(f.call('POST /api/staff/table', { id: '7', individual: true }),
    { message: 'Le mode individuel ne peut pas changer après l’inscription de chanteurs. Crée un autre groupe.' });
  assert.equal(f.sched.table('7', false).individual, false);
});

test('renommer une table et renouveler son QR : l’ancien lien ne fonctionne plus', async () => {
  const f = harness();
  await f.call('POST /api/staff/tables-create', { count: 2 });
  await f.call('POST /api/staff/settings', { baseUrl: 'https://chant.exemple.fr' });
  const renamed = plain(await f.call('POST /api/staff/table/rename', { tableId: '1', name: '  Terrasse   nord ' }));
  assert.deepEqual(renamed, { ok: true, table: { id: '1', name: 'Terrasse nord' } });
  await assert.rejects(f.call('POST /api/staff/table/rename', { tableId: '2', name: 'terrasse NORD' }),
    { message: 'Ce nom est déjà utilisé par une autre table.' });
  const old = f.access.get('1');
  const rotated = plain(await f.call('POST /api/staff/table-rotate', { id: '1' }));
  assert.notEqual(f.access.get('1'), old);
  assert.equal(rotated.url, `https://chant.exemple.fr/t/1/${f.access.get('1')}`);
  assert.equal(f.access.verify('1', old), false);
  assert.equal(lastNote(f).msg, 'Nouveau QR pour Terrasse nord : ancien lien désactivé');
  await assert.rejects(f.call('POST /api/staff/table-rotate', { id: '42' }), { message: 'Table inconnue.' });
});

// ---------------------------------------------------------------- réglages
test('réglages Battle : vote de 15 min et 30 min entre Battles par défaut, vote jusqu’à 120 min', async () => {
  const f = harness();
  const s = () => plain(f.staffState().settings);
  assert.deepEqual([s().battleVoteMin, s().battleCooldownMin, s().battleRejectedCooldownMin], [15, 30, 5]);
  await f.call('POST /api/staff/settings', { battleVoteMin: 45 });
  assert.equal(s().battleVoteMin, 45, 'plus de limite de 10 minutes');
  await f.call('POST /api/staff/settings', { battleVoteMin: 120 });
  assert.equal(s().battleVoteMin, 120);
  await assert.rejects(f.call('POST /api/staff/settings', { battleVoteMin: 121 }),
    { message: 'La durée du vote Battle doit être de 1 à 120 minutes.' });
  assert.equal(s().battleVoteMin, 120);
});

test('réglages : chaque valeur hors bornes est refusée sans rien modifier', async () => {
  const f = harness();
  const before = plain(f.staffState().settings);
  const refusals = [
    [{ weightedTables: true, tableRotation: false }, 'Active d’abord la rotation des tables.'],
    [{ pushDelaySec: 181 }, 'Le délai d’envoi doit être entre 0 et 180 secondes.'],
    [{ pushDelaySec: 2.5 }, 'Le délai d’envoi doit être entre 0 et 180 secondes.'],
    [{ playDelaySec: 31 }, 'La pause avant lecture doit être entre 0 et 30 secondes.'],
    [{ playDelaySec: -1 }, 'La pause avant lecture doit être entre 0 et 30 secondes.'],
    [{ battleCooldownMin: 0 }, 'Le délai entre Battles doit être de 1 à 120 minutes.'],
    [{ battleRejectedCooldownMin: 121 }, 'Le délai après un refus de Battle doit être de 1 à 120 minutes.'],
    [{ battleVoteMin: 121 }, 'La durée du vote Battle doit être de 1 à 120 minutes.'],
    [{ repeatWarnMin: 241 }, 'L’alerte « titre déjà chanté » doit être entre 0 et 240 minutes (0 la désactive).'],
    [{ presenceGraceSec: 9 }, 'Le délai pour confirmer « Je suis là » doit être entre 10 et 300 secondes.'],
    [{ presenceMaxSkips: 11 }, 'Le nombre de passages manqués doit être entre 1 et 10.'],
    [{ battleMinVoters: 0 }, 'Le nombre minimal de votants doit être de 1 à 100.'],
    [{ baseUrl: 'http://chant.exemple.fr' }, 'Une adresse accessible depuis Internet doit utiliser HTTPS.'],
    [{ baseUrl: 'https://chant.exemple.fr/file' }, 'Indique seulement l’adresse de base, sans chemin, paramètres ni identifiants.'],
    [{ baseUrl: 'pas une adresse' }, 'Adresse invalide : indique une origine HTTPS, par exemple https://chant.exemple.fr.'],
  ];
  for (const [body, message] of refusals) {
    // Les autres champs valides de la même requête ne passent pas non plus.
    await assert.rejects(f.call('POST /api/staff/settings', { gap: 9, autoPlay: true, ...body }), { message },
      JSON.stringify(body));
  }
  assert.deepEqual(plain(f.staffState().settings), before);
});

test('réglages : valeurs enregistrées et visibles dans l’état du bar', async () => {
  const f = harness();
  await f.call('POST /api/staff/settings', { pushDelaySec: 0, playDelaySec: 30, repeatWarnMin: 0,
    presenceGraceSec: 300, presenceMaxSkips: 1, battleCooldownMin: 45, battleRejectedCooldownMin: 5,
    battleVoteMin: 3, battleMinVoters: 4, gap: 9, cap: '12', autoPlay: true,
    baseUrl: 'https://chant.exemple.fr' });
  const s = plain(f.staffState().settings);
  assert.equal(s.pushDelaySec, 0);
  assert.equal(s.playDelaySec, 30);
  assert.equal(s.repeatWarnMin, 0);
  assert.equal(s.presenceGraceSec, 300);
  assert.equal(s.presenceMaxSkips, 1);
  assert.equal(s.battleCooldownMin, 45);
  assert.equal(s.battleRejectedCooldownMin, 5);
  assert.equal(s.battleVoteMin, 3);
  assert.equal(s.battleMinVoters, 4);
  assert.equal(s.gap, 9);
  assert.equal(s.cap, 12, 'nombre écrit en texte accepté');
  assert.equal(s.autoPlay, true);
  assert.equal(s.autoPlayHeld, false);
  assert.equal(s.baseUrl, 'https://chant.exemple.fr');
  assert.equal(f.staffState().phoneBase, 'https://chant.exemple.fr');
  // Adresse vide : retour à l'adresse du réseau local.
  await f.call('POST /api/staff/settings', { baseUrl: '' });
  assert.equal(f.settings.baseUrl, null);
});

test('réglages de rotation : chaque mode est annoncé et les déplacements manuels tombent', async () => {
  const f = harness();
  const [, , chloe] = singers(f, ['Alice', 'Bruno', 'Chloé']);
  await f.call('POST /api/staff/move', { personId: chloe.id, toIndex: 0, priority: true });
  await f.call('POST /api/staff/settings', { tableRotation: true, weightedTables: false });
  assert.equal(lastNote(f).msg, 'Rotation : tables à tour de rôle');
  assert.equal(f.sched.manualChanges.length, 0, 'l’intervention du bar n’est plus annulable');
  assert.equal(f.staffState().settings.tableRotation, true);
  await f.call('POST /api/staff/settings', { weightedTables: true });
  assert.equal(lastNote(f).msg, 'Rotation : compromis, grandes tables un peu plus souvent');
  assert.equal(f.staffState().settings.weightedTables, true);
  await f.call('POST /api/staff/settings', { tableRotation: false, weightedTables: false });
  assert.equal(lastNote(f).msg, 'Rotation : chacun son tour, tables au prorata des chanteurs');
  const count = f.sched.log.length;
  await f.call('POST /api/staff/settings', { tableRotation: false });
  assert.equal(f.sched.log.length, count, 'un réglage inchangé n’ajoute rien au journal');

  await f.call('POST /api/staff/settings', { interleaveArrivals: false });
  assert.equal(lastNote(f).msg, 'Grande table qui arrive : passe d’abord en entier');
  assert.equal(f.staffState().settings.interleaveArrivals, false);
  await f.call('POST /api/staff/settings', { interleaveArrivals: true });
  assert.equal(lastNote(f).msg, 'Grande table qui arrive : intercalée avec la rotation');
  const again = f.sched.log.length;
  await f.call('POST /api/staff/settings', { interleaveArrivals: true });
  assert.equal(f.sched.log.length, again);
});

test('réglages : « Je suis là » désactivé efface les reprises en attente', async () => {
  const f = harness();
  const [alice] = singers(f, ['Alice', 'Bruno']);
  await f.call('POST /api/staff/settings', { requirePresence: true });
  assert.equal(f.staffState().settings.requirePresence, true);
  alice.presenceRetry = true;
  alice.presenceSkips = 2;
  await f.call('POST /api/staff/settings', { requirePresence: false });
  assert.equal(f.staffState().settings.requirePresence, false);
  assert.equal(f.staffState().people.find(p => p.id === alice.id).presenceRetry, false);
});

test('réglages : envoi automatique refusé si KaraFun interdit l’ajout de titres', async () => {
  const f = harness();
  const bridge = fakeBridge();
  bridge.permissions = { addToQueue: false };
  f.setBridge(bridge);
  await assert.rejects(f.call('POST /api/staff/settings', { auto: true }),
    { message: 'KaraFun refuse l’ajout de titres au compte FileKaraoke. Vérifie ses permissions.' });
  assert.equal(f.settings.auto, false);
  bridge.permissions = { addToQueue: true };
  await f.call('POST /api/staff/settings', { auto: true });
  assert.equal(f.settings.auto, true);
  await f.call('POST /api/staff/settings', { auto: false });
  assert.equal(f.settings.auto, false);
});

// ---------------------------------------------------------------- bonus, fiche, présence
test('bonus, fiche privée et « toujours là » depuis la page du bar', async () => {
  const f = harness();
  const [alice] = singers(f, ['Alice']);
  await f.call('POST /api/staff/bonus', { tableId: '1', level: 2 });
  assert.equal(f.staffState().tables.find(t => t.id === '1').bonus, 2);
  await f.call('POST /api/staff/bonus', { personId: alice.id, level: -1 });
  assert.equal(f.staffState().people.find(p => p.id === alice.id).bonus, -1);
  await assert.rejects(f.call('POST /api/staff/bonus', { personId: alice.id, level: 4 }),
    { message: 'Le bonus doit être un niveau de -3 à +3.' });
  await assert.rejects(f.call('POST /api/staff/bonus', {}), { message: 'Choisis une table ou une personne.' });

  const identified = plain(await f.call('POST /api/staff/person/identify',
    { personId: alice.id, note: '  veste   rouge ' }));
  assert.deepEqual(identified, { ok: true, personId: alice.id });
  const view = f.staffState().people.find(p => p.id === alice.id);
  assert.equal(view.privateNote, 'veste rouge');
  assert.ok(!f.sched.log.some(l => l.msg.includes('veste rouge')), 'la note privée ne va pas au journal');

  alice.maybeGone = { title: 'Titre Alice', skips: 3, at: Date.now() };
  assert.deepEqual(plain(f.staffState().maybeGone.map(m => [m.name, m.table, m.skips])), [['Alice', 'Table 1', 3]]);
  await f.call('POST /api/staff/person/present', { personId: alice.id });
  assert.equal(f.staffState().maybeGone.length, 0);
  assert.equal(lastNote(f).msg, 'Le bar a confirmé que Alice est toujours là');
  await assert.rejects(f.call('POST /api/staff/person/present', { personId: 'x' }), { message: 'Personne introuvable.' });
});

// ---------------------------------------------------------------- état du bar
test('état du bar : invitation en attente dans la file, envoi en cours, titres suivis et réglages Battle', async () => {
  const f = harness();
  const alice = f.sched.join({ tableId: '1', name: 'Alice', headcount: 2 });
  const bruno = f.sched.join({ tableId: '2', name: 'Bruno', headcount: 2 });
  f.sched.inviteDuet(alice, bruno.id, { songId: 700, title: 'Duo en attente', artist: 'Les Deux' });
  // Une invitation sans réponse ne retient pas le titre : il est à sa place
  // dans la file, marqué, et personne n'est « sauté ».
  const waiting = f.staffState();
  assert.equal(waiting.blocked, undefined);
  assert.deepEqual(plain(waiting.queue.map(q => [q.source, q.ids, q.song.duet?.state])), [['helper', [alice.id], 'pending']]);
  f.setPending({ sel: { ids: [alice.id], song: alice.song, label: 'Alice · Table 1', names: ['Alice'] }, cancelled: false,
    before: new Set(), at: Date.now() });
  const state = f.staffState();
  assert.deepEqual(plain(state.pending), { label: 'Alice · Table 1', title: 'Duo en attente' });
  f.setPending(null);
  // Accepté : le même titre, en duo.
  f.sched.answerDuet(bruno, true);
  assert.deepEqual(plain(f.staffState().queue.map(q => [q.ids, q.kind])), [[[alice.id, bruno.id], 'duo']]);

  const chloe = f.sched.join({ tableId: '3', name: 'Chloé', headcount: 1 });
  f.sched.chooseSong(chloe, { songId: 701, title: 'Solo' });
  const tr = sendNext(f, 61);
  const s = plain(f.staffState());
  assert.deepEqual(s.tracked, [{ queueId: 61, label: tr.sel.label, title: tr.sel.song.title,
    ids: plain(tr.sel.ids), startedAt: null }]);
  assert.equal(s.kf, null, 'KaraFun non connecté');
  assert.equal(s.restarting, false);
  assert.equal(s.queueClearPending, false);
  assert.equal(s.removalPending, 0);
  assert.equal(s.recoveredPending, false);
  assert.equal(s.persistenceError, null);
  assert.equal(typeof s.staffKey, 'string');
  assert.equal(s.battle.registered, 3);
  assert.equal(s.settings.battleVoteMin, f.battleVote.voteDurationMs / 60000);
  assert.equal(s.settings.battleMinVoters, f.battleVote.minVoters);
  assert.ok(Array.isArray(s.log) && s.log[0].t >= s.log.at(-1).t, 'journal du plus récent au plus ancien');
  assert.deepEqual(s.people.map(p => p.name).sort(), ['Alice', 'Bruno', 'Chloé']);

  f.setBridge(fakeBridge([{ queueId: 61, songId: tr.sel.song.songId, singer: tr.sel.label }]));
  assert.deepEqual(plain(f.staffState().kf.queue.map(q => q.queueId)), [61]);
});

test('état du bar : titre en double et « Je suis là » manqués signalés sur la ligne concernée', () => {
  const f = harness();
  const alice = f.sched.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const bruno = f.sched.join({ tableId: '2', name: 'Bruno', headcount: 1 });
  const chloe = f.sched.join({ tableId: '3', name: 'Chloé', headcount: 1 });
  f.sched.chooseSong(alice, { songId: 501, title: 'Même titre', artist: 'Groupe' });
  f.sched.chooseSong(bruno, { songId: 501, title: 'Même titre', artist: 'Groupe' });
  f.sched.chooseSong(chloe, { songId: 502, title: 'Autre titre' });
  alice.presenceEntryId = alice.song.entryId;
  alice.presenceSkips = 2;
  const lines = f.staffState().queue.filter(line => line.source === 'helper' && !line.future);
  const byName = name => lines.find(line => line.name === name);
  assert.equal(byName('Alice').presenceSkips, 2);
  assert.equal(byName('Bruno').presenceSkips, undefined);
  assert.ok(byName('Alice').repeat && byName('Bruno').repeat, 'les deux lignes du même titre sont marquées');
  assert.equal(byName('Chloé').repeat, undefined);
  assert.equal(byName('Chloé').presenceSkips, undefined);
  // Repères réservés au bar : l'état public n'en porte aucun.
  const pub = f.publicState(null, null).queue;
  assert.ok(pub.length >= 3);
  assert.ok(!pub.some(line => 'presenceSkips' in line || 'repeat' in line));
});

test('état du bar : une intervention devient non annulable quand KaraFun change', async () => {
  const f = harness();
  const [, , chloe] = singers(f, ['Alice', 'Bruno', 'Chloé']);
  const bridge = fakeBridge([]);
  f.setBridge(bridge);
  await f.call('POST /api/staff/move', { personId: chloe.id, toIndex: 0, priority: true });
  assert.equal(f.staffState().manualChanges[0].canUndo, true);
  bridge.queue.push({ queueId: 71, songId: 3, title: 'Ajout natif', singer: 'Zoé' });
  const [change] = plain(f.staffState().manualChanges);
  assert.equal(change.canUndo, false);
  assert.equal(change.unavailableReason, 'La file a changé depuis cette intervention.');
  assert.equal(f.staffState().priorityUndo, null);
  await assert.rejects(f.call('POST /api/staff/manual-change-undo', { id: change.id }),
    { message: 'La file a changé depuis cette intervention ; elle ne peut plus être annulée sans déplacer d’autres titres.' });
  assert.equal(f.sched.manualChanges.length, 0);
});

// ---------------------------------------------------------------- Spotify
const json = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => null },
  json: async () => body, text: async () => JSON.stringify(body) });

// Faux Spotify : journal des appels, état du lecteur.
function fakeSpotify(f, player = { is_playing: false }) {
  const calls = [];
  const state = { player, failNext: null };
  f.spotify.fetchImpl = async (url, request = {}) => {
    calls.push([request.method || 'GET', url.replace('https://api.spotify.com/v1', '')]);
    if (url.endsWith('/api/token')) return json({ access_token: 'jeton-factice', expires_in: 3600 });
    if (state.failNext) { const status = state.failNext; state.failNext = null; return json({ error: { message: 'non' } }, status); }
    if (url.endsWith('/me/player')) return json(state.player);
    if (url.endsWith('/me/player/devices')) return json({ devices: [
      { id: 'pc-bar', name: 'PC du bar', type: 'Computer', is_active: true },
      { id: '', name: 'Sans identifiant' },
      { id: 'enceinte', type: 'Speaker' }] });
    if (url.includes('/me/player/play')) { state.player = { ...state.player, is_playing: true }; return { ok: true, status: 204 }; }
    if (url.includes('/me/player/pause')) { state.player = { ...state.player, is_playing: false }; return { ok: true, status: 204 }; }
    throw new Error(`appel inattendu : ${url}`);
  };
  return { calls, state };
}

test('Spotify : identifiant, adresse de connexion, appareils et options depuis le bar', async () => {
  const f = harness();
  await assert.rejects(f.call('POST /api/staff/spotify', { action: 'auth-url' }),
    { message: 'Indique d’abord le Client ID de l’application Spotify du bar.' });
  await assert.rejects(f.call('POST /api/staff/spotify', { action: 'client', clientId: 'trop-court' }),
    { message: 'Identifiant Spotify invalide : copie le « Client ID » de ton application Spotify.' });
  await f.call('POST /api/staff/spotify', { action: 'client', clientId: '0123456789abcdef0123456789abcdef' });
  let view = plain(f.staffState().spotify);
  assert.equal(view.configured, true);
  assert.equal(view.connected, false);
  assert.equal(view.clientId, '0123456789abcdef0123456789abcdef');

  const { url } = plain(await f.call('POST /api/staff/spotify', { action: 'auth-url' }));
  const auth = new URL(url);
  assert.equal(auth.origin + auth.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(auth.searchParams.get('client_id'), '0123456789abcdef0123456789abcdef');
  assert.equal(auth.searchParams.get('redirect_uri'), `http://127.0.0.1:${f.staffState().port}/spotify/callback`);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(view.redirectUri, auth.searchParams.get('redirect_uri'));

  // Connecté (jeton factice) : liste des appareils, sans ceux sans identifiant.
  f.spotify.config.refreshToken = 'renouvellement-factice';
  const { calls } = fakeSpotify(f);
  const { devices } = plain(await f.call('POST /api/staff/spotify', { action: 'devices' }));
  assert.deepEqual(devices, [
    { id: 'pc-bar', name: 'PC du bar', type: 'Computer', active: true },
    { id: 'enceinte', name: 'Appareil', type: 'Speaker', active: false }]);
  assert.deepEqual(calls.map(c => c[1]), ['https://accounts.spotify.com/api/token', '/me/player/devices']);

  // Choix d'un appareil : vérifié tout de suite, type repris de la liste.
  calls.length = 0;
  await f.call('POST /api/staff/spotify', { action: 'device', deviceId: 'pc-bar', deviceName: 'PC du bar' });
  assert.deepEqual(calls.map(c => c[1]), ['/me/player/devices', '/me/player'], 'vérification après le choix');
  assert.equal(f.staffState().spotify.deviceType, 'Computer');
  assert.equal(f.staffState().spotify.health.state, 'ready');
  assert.equal(f.staffState().spotify.devices.length, 2, 'liste gardée sur le serveur');
  await f.call('POST /api/staff/spotify', { action: 'options', autoResume: false, autoPause: 0,
    resumeDelaySec: '12', pauseLeadSec: 4 });
  view = plain(f.staffState().spotify);
  assert.equal(view.deviceId, 'pc-bar');
  assert.equal(view.deviceName, 'PC du bar');
  assert.equal(view.autoResume, false);
  assert.equal(view.autoPause, false);
  assert.equal(view.resumeDelaySec, 12);
  assert.equal(view.pauseLeadSec, 4);
  assert.ok(!JSON.stringify(f.staffState()).includes('renouvellement-factice'), 'le jeton reste sur le serveur');
  await assert.rejects(f.call('POST /api/staff/spotify', { action: 'options', resumeDelaySec: 301 }),
    { message: 'Le délai avant de relancer Spotify doit être entre 0 et 300 secondes.' });
  await assert.rejects(f.call('POST /api/staff/spotify', { action: 'options', pauseLeadSec: 11 }),
    { message: 'Le silence entre Spotify et un titre doit être entre 0 et 10 secondes.' });
  assert.equal(f.staffState().spotify.resumeDelaySec, 12, 'un refus ne change rien');
  // Seules les options envoyées changent.
  await f.call('POST /api/staff/spotify', { action: 'options', autoPause: true });
  view = plain(f.staffState().spotify);
  assert.equal(view.autoPause, true);
  assert.equal(view.autoResume, false);

  await assert.rejects(f.call('POST /api/staff/spotify', { action: 'volume' }), { message: 'Action Spotify inconnue.' });
  await assert.rejects(f.call('POST /api/staff/spotify', {}), { message: 'Action Spotify inconnue.' });

  await f.call('POST /api/staff/spotify', { action: 'disconnect' });
  view = plain(f.staffState().spotify);
  assert.equal(view.connected, false);
  assert.equal(view.configured, true, 'l’identifiant de l’application reste');
  assert.equal(view.deviceId, '');
  await assert.rejects(f.call('POST /api/staff/spotify', { action: 'devices' }), { message: 'Spotify n’est pas connecté.' });
});

test('Spotify : lecture et pause du bar, l’automate ne les défait pas', async () => {
  const f = harness();
  f.spotify.config = { ...f.spotify.config, clientId: '0123456789abcdef0123456789abcdef',
    refreshToken: 'renouvellement-factice', deviceId: 'pc-bar', deviceName: 'PC du bar' };
  const { calls, state } = fakeSpotify(f, { is_playing: false, device: { id: 'pc-bar', name: 'PC du bar' },
    item: { name: 'Ambiance', artists: [{ name: 'Groupe' }] } });

  const played = plain(await f.call('POST /api/staff/spotify', { action: 'play' }));
  assert.deepEqual(played, { ok: true, result: 'done' });
  assert.deepEqual(calls.slice(1), [['GET', '/me/player'], ['PUT', '/me/player/play?device_id=pc-bar']]);
  assert.equal(f.spotifyAutomation.done, true, 'choix du bar respecté');
  assert.deepEqual(plain(await f.call('POST /api/staff/spotify', { action: 'play' })), { ok: true, result: 'already' });

  f.spotifyAutomation.done = false;
  calls.length = 0;
  assert.deepEqual(plain(await f.call('POST /api/staff/spotify', { action: 'pause' })), { ok: true, result: 'done' });
  assert.deepEqual(calls, [['GET', '/me/player'], ['PUT', '/me/player/pause?device_id=pc-bar']]);
  assert.equal(f.spotifyAutomation.done, true);
  assert.equal(state.player.is_playing, false);

  // « Vérifier Spotify » : appareils et lecteur, l'état revient à la page.
  calls.length = 0;
  const checked = plain(await f.call('POST /api/staff/spotify', { action: 'refresh' }));
  assert.equal(checked.ok, true);
  assert.equal(checked.health.state, 'ready');
  assert.deepEqual(checked.health.device, { id: 'pc-bar', name: 'PC du bar', active: true });
  assert.equal(checked.health.adopted, false);
  assert.deepEqual(calls, [['GET', '/me/player/devices'], ['GET', '/me/player']]);
  const view = plain(f.staffState().spotify);
  assert.equal(view.player.isPlaying, false);
  assert.deepEqual(view.player.track, { title: 'Ambiance', artist: 'Groupe' });
  assert.deepEqual(view.player.device, { id: 'pc-bar', name: 'PC du bar' });
  assert.equal(view.lastAction.kind, 'pause');

  // Échec Spotify : message lisible, l'automate garde la main.
  f.spotifyAutomation.done = false;
  state.failNext = 404;
  await assert.rejects(f.call('POST /api/staff/spotify', { action: 'play' }),
    { message: 'Aucun appareil Spotify actif : ouvre Spotify sur l’appareil choisi, puis réessaie.' });
  assert.equal(f.spotifyAutomation.done, false);
  assert.equal(f.staffState().spotify.lastError, 'Aucun appareil Spotify actif : ouvre Spotify sur l’appareil choisi, puis réessaie.');
});

// ---------------------------------------------------------------- v1.4 : retours du bar
test('« Arrêter la soirée » n’existe plus sur la page du bar ; l’arrêt local reste', () => {
  const f = harness();
  assert.equal(f.handlers['POST /api/staff/shutdown'], undefined, 'route du bouton supprimée');
  assert.match(source, /p === '\/internal\/shutdown'/, 'ARRETER.bat garde son arrêt local');
});

test('réglages : écart et recul invalides refusés comme les autres champs', async () => {
  const f = harness();
  const before = plain(f.staffState().settings);
  for (const [body, message] of [[{ gap: 0 }, 'L’écart entre chanteurs d’une table doit être de 1 à 10 places.'],
    [{ gap: '' }, 'L’écart entre chanteurs d’une table doit être de 1 à 10 places.'],
    [{ gap: 11 }, 'L’écart entre chanteurs d’une table doit être de 1 à 10 places.'],
    [{ cap: 'beaucoup' }, 'Le recul maximal doit être de 1 à 50 places.'],
    [{ cap: 51 }, 'Le recul maximal doit être de 1 à 50 places.'], [{ cap: 2.5 }, 'Le recul maximal doit être de 1 à 50 places.']]) {
    await assert.rejects(f.call('POST /api/staff/settings', { autoPlay: true, ...body }), { message }, JSON.stringify(body));
  }
  assert.deepEqual(plain(f.staffState().settings), before, 'rien n’a changé');
  await f.call('POST /api/staff/settings', { gap: '7', cap: 12 });
  assert.equal(f.sched.opts.gap, 7);
  assert.equal(f.sched.opts.cap, 12);
});

test('repère privé : un simple indice sur la personne, sans aucune vérification', async () => {
  const f = harness();
  const [alice] = singers(f, ['Alice']);
  const view = () => plain(f.staffState().people.find(p => p.id === alice.id));
  await f.call('POST /api/staff/person/identify', { personId: alice.id, note: '  veste   rouge ' });
  assert.equal(view().privateNote, 'veste rouge');
  assert.ok(!('verified' in view()) && !('verifiedAt' in view()), 'aucun état de vérification envoyé au bar');
  // Un ancien champ « verified » envoyé par une page restée ouverte est ignoré.
  await f.call('POST /api/staff/person/identify', { personId: alice.id, verified: true });
  assert.equal(view().privateNote, 'veste rouge', 'sans texte, le repère est gardé');
  assert.ok(!('verifiedAt' in f.sched.people.get(alice.id)), 'rien de tel n’est gardé sur la personne');
  assert.equal(typeof f.sched.staffIdentify, 'undefined', 'plus de « staffIdentify » : le repère s’enregistre avec setPrivateNote');
  f.sched.setPrivateNote(alice.id, 'veste verte');
  assert.equal(view().privateNote, 'veste verte');
  await f.call('POST /api/staff/person/identify', { personId: alice.id, note: '' });
  assert.equal(view().privateNote, '', 'un repère vidé est retiré');
});

// ---------------------------------------------------------------- QA navigateur du 2026-10-03
// Found by /qa on 2026-10-03
// Report: .gstack/qa-reports/run-20261003T140104Z/qa-report-127.0.0.1-2026-10-03.md

// Regression: ISSUE-003 — « Supprimer toutes les tables » coupait l'envoi automatique sans l'annoncer
test('nouvelle soirée : le titre sur scène seul ne coupe pas l’envoi automatique, un titre à retirer de KaraFun le coupe et le dit', async () => {
  const confirm = { confirmation: 'SUPPRIMER TOUTES LES TABLES' };
  // Seulement le titre en cours : il continue, l'envoi automatique reste actif.
  const f = harness();
  singers(f, ['Alice', 'Bruno']);
  const live = sendNext(f, 11, { startedAt: Date.now() - 20000 });
  f.setBridge(fakeBridge([{ queueId: 11, songId: live.sel.song.songId, title: live.sel.song.title, status: 'playing' }], 11));
  f.settings.auto = true;
  const calm = plain(await f.call('POST /api/staff/tables-clear', confirm));
  assert.equal(calm.autoStopped, false);
  assert.equal(calm.currentStillPlaying, true);
  assert.equal(f.settings.auto, true, 'l’envoi automatique reste coché après la fin du titre en cours');
  // Un titre suivant déjà chargé dans KaraFun doit en être retiré : envoi coupé, réponse explicite.
  const g = harness();
  singers(g, ['Alice', 'Bruno']);
  const onStage = sendNext(g, 21, { startedAt: Date.now() - 20000 });
  const upcoming = sendNext(g, 22);
  const bridge = fakeBridge([{ queueId: 21, songId: onStage.sel.song.songId, status: 'playing' },
    { queueId: 22, songId: upcoming.sel.song.songId, status: 'ready' }], 21);
  g.setBridge(bridge);
  g.settings.auto = true;
  const busy = plain(await g.call('POST /api/staff/tables-clear', confirm));
  assert.equal(busy.autoStopped, true);
  assert.equal(busy.removalPending, 1);
  assert.equal(g.settings.auto, false);
  assert.deepEqual(plain(bridge.calls).filter(call => call[0] === 'remove'), [['remove', 22]]);
  // Envoi automatique déjà coupé : rien n'est « coupé » par la remise à zéro.
  const h = harness();
  singers(h, ['Alice']);
  sendNext(h, 31);
  h.setBridge(fakeBridge([{ queueId: 31, status: 'ready' }], null));
  assert.equal(plain(await h.call('POST /api/staff/tables-clear', confirm)).autoStopped, false);
});

// Regression: ISSUE-008 — une invitation de duo en attente n'apparaissait nulle part sur la page du bar
test('état du bar : invitations de duo en attente, avec l’état vu / pas encore vue', async () => {
  const f = harness();
  const alice = f.sched.join({ tableId: '1', name: 'Alice', headcount: 2 });
  const zoe = f.sched.join({ tableId: '2', name: 'Zoé', headcount: 2 });
  const mate = f.sched.join({ tableId: '1', name: 'Marc', headcount: 2 });
  f.sched.chooseSong(alice, { songId: 900, title: 'Premier' });
  const song = f.sched.inviteDuet(alice, zoe.id, { songId: 901, title: 'Hotel California', artist: 'Eagles' });
  f.sched.inviteDuet(alice, mate.id, { songId: 902, title: 'Même table' });
  let invites = plain(f.staffState().duoInvites);
  assert.deepEqual(invites, [{ ownerId: alice.id, ownerName: 'Alice', partnerId: zoe.id, partnerName: 'Zoé',
    entryId: song.entryId, title: 'Hotel California', seenAt: null }], 'seule l’invitation vers une autre table attend une réponse');
  f.sched.markDuetSeen(zoe, song.entryId);
  invites = plain(f.staffState().duoInvites);
  assert.ok(invites[0].seenAt > 0, 'vue sur le téléphone de l’invitée');
  f.sched.answerDuet(zoe, true, song.entryId);
  assert.deepEqual(plain(f.staffState().duoInvites), [], 'acceptée : plus en attente');
});
