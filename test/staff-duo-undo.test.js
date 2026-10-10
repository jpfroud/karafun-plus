'use strict';
// Duo improvisé noté par erreur (retours du bar, v1.4) : le bar peut
// l'annuler ou changer de partenaire, pendant la chanson ou après, tant que
// le partenaire n'a pas rechanté. Les crédits de tour reviennent exactement
// à leur état d'avant le duo ; le titre du partenaire retiré de KaraFun y
// reste s'il y est encore, sinon il est en tête de sa liste. Les derniers
// passages montrent le partenaire noté. Gestionnaires de server.js appelés
// dans un bac à sable (--demo) : aucun port, faux pont KaraFun.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

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
    globalThis.fixture = { sched, settings, handlers, staffState, tracked: () => tracked,
      setBridge: b => { bridge = b; }, setPending: p => { pending = p; }, getPending: () => pending, sync };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  f.call = (route, body = {}) => {
    const handler = f.handlers[route];
    assert.equal(typeof handler, 'function', `route absente : ${route}`);
    return handler({}, {}, body);
  };
  return f;
}
const plain = value => JSON.parse(JSON.stringify(value));

// Faux KaraFun : `remove` est noté ; `honour` décide si KaraFun l'applique.
function fakeBridge(queue, playingId) {
  const bridge = { ready: true, connected: true, queue, events: [], permissions: {}, removed: [], honour: false,
    snapshot: () => ({ ready: true, connected: true, queue, events: [] }),
    status: { state: 'playing', songPlaying: { queueId: playingId } },
    add() {}, next() {}, play() {},
    remove(id) {
      bridge.removed.push(id);
      if (!bridge.honour) return;
      const i = queue.findIndex(item => item.queueId === id);
      if (i >= 0) queue.splice(i, 1);
    } };
  return bridge;
}

// JP a chanté ; Marine chante (queueId 1) ; le titre de Dam est déjà chargé
// dans KaraFun (queueId 2) ; Zoé attend. `beforeLoaded` : état de Dam juste
// avant l'envoi de son titre, `beforeMark` : juste avant le duo.
function evening() {
  const f = harness();
  const s = f.sched;
  const join = (name, table) => s.join({ tableId: table, name, headcount: 1 });
  const jp = join('JP', 'A'), marine = join('Marine', 'B'), dam = join('Dam', 'C'), zoe = join('Zoé', 'D');
  let songId = 1;
  for (const p of [jp, marine, dam, zoe]) for (let k = 0; k < 2; k++) s.chooseSong(p, { songId: songId++, title: `${p.name} ${k + 1}` }, 'append');
  const sung = s.select(); s.commit(sung); s.recordStage(sung, Date.now() - 400000);
  s.songEnded(sung.ids); s.endStage(sung);
  const stage = s.select(); s.commit(stage); s.recordStage(stage, Date.now() - 60000);
  assert.equal(stage.ids[0], marine.id);
  const beforeLoaded = fairness(s, dam);
  const loaded = s.select(); s.commit(loaded);
  assert.equal(loaded.ids[0], dam.id, 'Dam est le suivant, déjà chargé dans KaraFun');
  const queue = [{ queueId: 1, songId: stage.song.songId, singer: stage.label },
    { queueId: 2, songId: loaded.song.songId, singer: loaded.label }];
  const bridge = fakeBridge(queue, 1);
  f.setBridge(bridge);
  f.tracked().push({ queueId: 1, sel: stage, startedAt: Date.now() - 60000, addedAt: Date.now() - 90000 },
    { queueId: 2, sel: loaded, startedAt: null, addedAt: Date.now() - 30000 });
  const events = [];
  s._event = (type, fields) => events.push([type, plain(fields)]);
  return { f, s, jp, marine, dam, zoe, stage, loaded, bridge, queue, beforeLoaded, beforeMark: fairness(s, dam), events,
    credits: () => plain({ stage: stage.turnCredit, loaded: loaded.turnCredit }) };
}

// Tout ce que le duo improvisé touche pour une personne, plus l'état global.
function fairness(s, p) {
  return plain({ sung: p.sung, duetGuestCount: p.duetGuestCount || 0, lastAppearanceTurn: p.lastAppearanceTurn || 0,
    lastSungAt: p.lastSungAt || 0, inRound: s.roundPeople.has(p.id), roundApps: s.roundApps.get(p.id) || 0,
    owed: s.roundOwed.has(p.id), cooldown: s.duetCooldowns.get(p.id) ?? null, song: p.song?.title || null,
    appearanceSerial: s.appearanceSerial });
}
const openEntry = s => s.stageHistory.at(-1);

test('duo noté : les derniers passages montrent le partenaire avec le chanteur', async () => {
  const { f, s, marine, dam } = evening();
  await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: dam.id });
  assert.deepEqual(plain(openEntry(s).ids), [marine.id, dam.id], 'le passage en cours compte les deux chanteurs');
  assert.equal(openEntry(s).kind, 'duo');
  const view = plain(f.staffState().stageHistory[0]);
  assert.deepEqual(view.people.map(person => person.name), ['Marine', 'Dam']);
  assert.equal(view.staffDuo.partnerName, 'Dam');
  assert.equal(view.staffDuo.canUndo, true);
});

test('annuler un duo noté par erreur : crédits exacts, titre du partenaire laissé dans KaraFun', async () => {
  const { f, s, marine, dam, stage, loaded, bridge, beforeMark, events, credits } = evening();
  const creditsBefore = credits();
  const label = stage.label;
  const result = plain(await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: dam.id }));
  assert.equal(result.moved, 1);
  assert.deepEqual(bridge.removed, [2], 'son titre suivant est retiré de KaraFun');
  assert.equal(f.tracked()[1].pulled.reason, 'duo');
  assert.equal(plain(f.staffState().stage.staffDuo).partnerId, dam.id, 'la scène sait que ce duo a été noté au bar');

  const undo = plain(await f.call('POST /api/staff/duo-unmark', { queueId: 1 }));
  assert.equal(undo.ok, true);
  assert.match(undo.message, /Duo avec Dam annulé/);
  assert.match(undo.message, /reste dans KaraFun/);
  assert.deepEqual(fairness(s, dam), beforeMark, 'Dam retrouve exactement son état d’avant le duo');
  assert.deepEqual(credits(), creditsBefore, 'les reçus des deux titres sont ceux d’avant le duo');
  assert.deepEqual(plain(stage.ids), [marine.id]);
  assert.equal(stage.kind, 'solo');
  assert.equal(stage.label, label, 'libellé du solo retrouvé');
  assert.equal(stage.staffDuo, undefined);
  assert.deepEqual(plain(openEntry(s).ids), [marine.id], 'les derniers passages ne montrent plus Dam');
  const pulled = f.tracked()[1];
  assert.equal(pulled.pulled, null, 'le retrait de son titre est abandonné');
  assert.equal(pulled.unpulled.reason, 'duo');
  assert.equal(pulled.removeRequestedAt, 0);
  assert.equal(loaded.turnCredit.rolledBack, false);
  const duoEvents = events.filter(([type]) => type.startsWith('duo.improvised'));
  assert.deepEqual(duoEvents.map(([type]) => type), ['duo.improvised', 'duo.improvisedCancelled']);
  assert.deepEqual(duoEvents[1][1], { ownerId: marine.id, partnerId: dam.id, entryId: stage.song.entryId });
  assert.ok(s.log.some(line => line.msg === 'Le bar a annulé le duo noté de Marine avec Dam'));
  await assert.rejects(f.call('POST /api/staff/duo-unmark', { stageEntryId: 'inconnu' }),
    { message: 'Passage introuvable : il a peut-être déjà été effacé des derniers passages.' });
  await assert.rejects(f.call('POST /api/staff/duo-mark', { stageEntryId: openEntry(s).id, partnerId: dam.id }),
    { message: 'Choisis un passage solo encore visible dans KaraFun.' }, 'après la chanson, seulement une correction');
  await assert.rejects(f.call('POST /api/staff/duo-mark', { queueId: 99, partnerId: dam.id }),
    { message: 'Choisis un passage solo encore visible dans KaraFun.' });
  // Plus rien à annuler.
  await assert.rejects(f.call('POST /api/staff/duo-unmark', { queueId: 1 }), { message: 'Aucun duo noté par le bar sur ce passage.' });
  await assert.rejects(f.call('POST /api/staff/duo-unmark', { queueId: 99 }), { message: 'Passage introuvable : il a peut-être déjà été effacé des derniers passages.' });
  // KaraFun applique quand même le retrait déjà envoyé : le titre revient à Dam.
  bridge.honour = true;
  bridge.queue.splice(1, 1);
  f.sync();
  assert.equal(dam.song.title, 'Dam 1', 'son titre revient en tête de sa liste');
  assert.equal(dam.duetGuestCount || 0, 0);
});

test('annuler après le retrait par KaraFun : le titre du partenaire est en tête de sa liste, sans priorité', async () => {
  const { f, s, dam, bridge, beforeLoaded } = evening();
  bridge.honour = true;
  await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: dam.id });
  f.sync(); // KaraFun confirme le retrait : le titre de Dam revient dans sa liste
  assert.equal(f.tracked().length, 1);
  assert.equal(dam.song.title, 'Dam 1');
  const undo = plain(await f.call('POST /api/staff/duo-unmark', { queueId: 1 }));
  assert.match(undo.message, /Dam 1.*en tête de la liste de Dam/);
  assert.deepEqual(fairness(s, dam), beforeLoaded, 'Dam retrouve son état d’avant l’envoi de son titre');
  assert.equal(s.manualChanges.length, 0, 'aucune priorité automatique');
});

test('changer de partenaire : l’ancien retrouve son état, le nouveau est compté', async () => {
  const { f, s, marine, dam, jp, stage, beforeMark, events } = evening();
  const jpBefore = fairness(s, jp);
  await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: dam.id });
  const marked = fairness(s, dam);
  // Refus avant tout changement : même partenaire, chanteur lui-même, inconnu, parti.
  const zoeGone = s.join({ tableId: 'E', name: 'Yann', headcount: 1 });
  s.leave(zoeGone);
  for (const [partnerId, message] of [[dam.id, 'Dam est déjà noté sur ce duo.'], [marine.id, 'Choisis un autre chanteur encore présent dans la salle.'],
    ['inconnu', 'Choisis un autre chanteur encore présent dans la salle.'], [zoeGone.id, 'Choisis un autre chanteur encore présent dans la salle.']]) {
    await assert.rejects(f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId, replace: true }), { message }, partnerId);
    assert.deepEqual(fairness(s, dam), marked, 'rien ne change après un refus');
    assert.deepEqual(plain(stage.ids), [marine.id, dam.id]);
  }
  // Sans « replace », un second partenaire est refusé comme avant.
  await assert.rejects(f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: jp.id }),
    { message: 'Choisis un passage solo encore visible dans KaraFun.' });
  const result = plain(await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: jp.id, replace: true }));
  assert.match(result.message, /Duo corrigé : JP chante avec Marine à la place de Dam/);
  assert.deepEqual(fairness(s, dam), beforeMark, 'Dam n’est plus compté');
  const jpNow = fairness(s, jp);
  assert.equal(jpNow.duetGuestCount, jpBefore.duetGuestCount + 1, 'JP est compté en duo');
  assert.equal(jpNow.inRound, true);
  assert.deepEqual(plain(stage.ids), [marine.id, jp.id]);
  assert.equal(stage.label, 'Marine & JP · B + A');
  assert.deepEqual(plain(openEntry(s).ids), [marine.id, jp.id]);
  // Le journal reçoit le nouveau duo puis la correction, que les statistiques
  // ne comptent qu'une fois.
  const duoEvents = events.filter(([type]) => type.startsWith('duo.improvised'));
  assert.deepEqual(duoEvents.map(([type]) => type), ['duo.improvised', 'duo.improvised', 'duo.improvisedReplaced']);
  assert.deepEqual(duoEvents[2][1], { ownerId: marine.id, partnerId: jp.id, previousPartnerId: dam.id, entryId: stage.song.entryId });
});

test('après la chanson : annulation possible tant que le partenaire n’a pas rechanté, puis « trop tard »', async () => {
  const { f, s, marine, dam, zoe, bridge, queue, beforeMark } = evening();
  await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: dam.id });
  // La chanson de Marine finit ; le titre de Dam reste dans KaraFun (retrait ignoré).
  queue.splice(0, 1);
  bridge.status = { state: 'idle' };
  f.sync();
  assert.equal(f.tracked().length, 1, 'le passage de Marine est terminé');
  const entry = s.stageHistory.at(-1);
  assert.ok(entry.endedAt);
  const view = plain(f.staffState().stageHistory[0]);
  assert.equal(view.staffDuo.canUndo, true);
  // Le bar annule depuis les derniers passages.
  const undo = plain(await f.call('POST /api/staff/duo-unmark', { stageEntryId: entry.id }));
  assert.match(undo.message, /Duo avec Dam annulé/);
  assert.deepEqual(fairness(s, dam), beforeMark);
  assert.deepEqual(plain(entry.ids), [marine.id]);
  assert.equal(entry.staffDuo, undefined);
  // Nouveau duo noté après la chanson, puis Dam chante son titre : trop tard.
  await f.call('POST /api/staff/duo-mark', { stageEntryId: entry.id, partnerId: zoe.id, replace: true });
  assert.deepEqual(plain(entry.ids), [marine.id, zoe.id]);
  s.recordStage({ ids: [zoe.id], kind: 'solo', song: { ...zoe.song } }, Date.now());
  const late = plain(f.staffState().stageHistory.find(item => item.id === entry.id));
  assert.equal(late.staffDuo.canUndo, false);
  assert.equal(late.staffDuo.reason, 'Trop tard : Zoé a déjà rechanté');
  await assert.rejects(f.call('POST /api/staff/duo-unmark', { stageEntryId: entry.id }), { message: 'Trop tard : Zoé a déjà rechanté' });
  await assert.rejects(f.call('POST /api/staff/duo-mark', { stageEntryId: entry.id, partnerId: dam.id, replace: true }),
    { message: 'Trop tard : Zoé a déjà rechanté' });
  assert.deepEqual(plain(entry.ids), [marine.id, zoe.id], 'rien ne change');
});

test('duo noté pendant l’envoi du titre du partenaire : la demande de retrait est abandonnée', async () => {
  const { f, s, dam, marine } = evening();
  // Le titre suivant de Dam est en cours d'envoi (pas encore confirmé).
  const extra = s.join({ tableId: 'F', name: 'Inès', headcount: 1 });
  s.chooseSong(extra, { songId: 77, title: 'Inès 1' });
  f.tracked().splice(1, 1);
  const pending = { sel: { ids: [dam.id], names: ['Dam'], song: { songId: 3, title: 'Dam 1', entryId: dam.song?.entryId || 'x' }, label: 'Dam · C' }, at: Date.now(), before: new Set() };
  f.setPending(pending);
  await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: dam.id });
  assert.equal(f.getPending().pullOnAck, 'duo');
  await f.call('POST /api/staff/duo-unmark', { queueId: 1 });
  assert.equal(f.getPending().pullOnAck, undefined, 'le titre en cours d’envoi restera dans KaraFun');
  assert.deepEqual(plain(f.tracked()[0].sel.ids), [marine.id]);
});

test('annulation après un redémarrage : le reçu sauvegardé suffit ; un autre passage entre-temps est respecté', async () => {
  const { f, s, dam, jp, stage, beforeMark } = evening();
  await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: dam.id });
  // Sauvegarde de soirée : passages suivis et historique copiés en JSON.
  const saved = plain(stage.staffDuo);
  stage.staffDuo = saved;
  openEntry(s).staffDuo = plain(saved);
  // Un autre passage part dans KaraFun entre-temps : le répit de Dam avance d'un cran.
  const other = s.select(); s.commit(other);
  assert.notEqual(other.ids[0], dam.id);
  const cooldownBefore = beforeMark.cooldown;
  await f.call('POST /api/staff/duo-unmark', { queueId: 1 });
  assert.equal(dam.duetGuestCount || 0, beforeMark.duetGuestCount);
  assert.equal(s.duetCooldowns.get(dam.id) ?? null, cooldownBefore == null || cooldownBefore <= 1 ? null : cooldownBefore - 1,
    'le répit d’avant le duo, avancé du passage envoyé depuis');
  assert.ok(jp, 'JP reste inscrit');
  assert.throws(() => s.staffUncountPartner(null), { message: 'Aucun duo noté par le bar sur ce passage.' });
  assert.equal(s.setStagePeople(null, []), null);
});

test('changer de partenaire après le départ du chanteur : refusé sans rien défaire', async () => {
  const { f, s, marine, dam, jp } = evening();
  await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: dam.id });
  const marked = fairness(s, dam);
  marine.withdrawnAt = Date.now();
  await assert.rejects(f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: jp.id, replace: true }),
    { message: 'Choisis un autre chanteur encore présent dans la salle.' });
  assert.deepEqual(fairness(s, dam), marked, 'le duo noté reste compté');
  // L'annulation seule reste possible.
  await f.call('POST /api/staff/duo-unmark', { queueId: 1 });
  assert.equal(dam.duetGuestCount || 0, 0);
});

test('duo prévu par les chanteurs : le bar ne peut pas l’annuler comme un duo improvisé', async () => {
  const { f, stage, jp } = evening();
  stage.ids.push(jp.id); stage.names.push('JP'); stage.kind = 'duo';
  await assert.rejects(f.call('POST /api/staff/duo-unmark', { queueId: 1 }), { message: 'Aucun duo noté par le bar sur ce passage.' });
  await assert.rejects(f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: jp.id, replace: true }),
    { message: 'Aucun duo noté par le bar sur ce passage.' });
});

// Regression: relecture PR #11 — un duo noté ou corrigé après la chanson
// partait au journal sans titre (entryId null) : les statistiques gardaient
// l'ancien partenaire, ou changeaient une Battle en « duo ».
test('après la chanson : duo noté ou corrigé rattaché au titre du passage (journal et statistiques)', async () => {
  const { computeStats } = require('../evening-stats');
  const { f, s, marine, dam, zoe, stage, bridge, queue, events } = evening();
  await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: dam.id });
  queue.splice(0, 1);
  bridge.status = { state: 'idle' };
  f.sync();
  const entry = s.stageHistory.at(-1);
  assert.ok(entry.endedAt);
  await f.call('POST /api/staff/duo-mark', { stageEntryId: entry.id, partnerId: zoe.id, replace: true });
  const duoEvents = () => events.filter(([type]) => type.startsWith('duo.improvised')).map(([type, e]) => [type, e.entryId, e.partnerId]);
  assert.deepEqual(duoEvents(), [['duo.improvised', stage.song.entryId, dam.id], ['duo.improvised', stage.song.entryId, zoe.id],
    ['duo.improvisedReplaced', stage.song.entryId, zoe.id]], 'chaque événement porte le titre du passage');
  // Statistiques : une Battle jouée avant, puis le passage de Marine.
  const T = Date.now() - 600000;
  const journal = [{ t: T, seq: 1, ev: 'stage.started', queueId: 9, source: 'battle', title: 'Battle collective' },
    { t: T + 60000, seq: 2, ev: 'stage.ended', queueId: 9, playedSec: 60 },
    { t: T + 120000, seq: 3, ev: 'stage.started', queueId: 1, entryId: stage.song.entryId, ids: [marine.id], source: 'queue' },
    { t: T + 300000, seq: 4, ev: 'stage.ended', queueId: 1, playedSec: 180 },
    ...events.filter(([type]) => type.startsWith('duo.improvised')).map(([ev, fields], i) => ({ t: T + 400000 + i, seq: 5 + i, ev, ...fields }))];
  const stats = computeStats({ meta: {}, events: journal, now: T + 600000 });
  assert.deepEqual(stats.timeline.stages.map(st => [st.kind, st.ids]), [['battle', []], ['duo', [marine.id, zoe.id]]]);
  // Annulé puis noté pour la première fois après la chanson.
  await f.call('POST /api/staff/duo-unmark', { stageEntryId: entry.id });
  events.length = 0;
  await f.call('POST /api/staff/duo-mark', { stageEntryId: entry.id, partnerId: dam.id, replace: true });
  assert.deepEqual(duoEvents(), [['duo.improvised', stage.song.entryId, dam.id]]);
  await f.call('POST /api/staff/duo-unmark', { stageEntryId: entry.id });
  assert.equal(events.find(([type]) => type === 'duo.improvisedCancelled')?.[1].entryId, stage.song.entryId);
});

// Olga chante (queueId 1) ; personne d'autre n'attend : son titre suivant est
// déjà chargé dans KaraFun (queueId 2). Bea est dans la salle, sans titre.
// `stageTurn` : tour du passage d'Olga en scène.
function ownerNextLoaded() {
  const f = harness();
  const s = f.sched;
  const olga = s.join({ tableId: 'A', name: 'Olga', headcount: 1 });
  const bea = s.join({ tableId: 'B', name: 'Bea', headcount: 1 });
  s.chooseSong(olga, { songId: 1, title: 'Olga 1' }, 'append');
  s.chooseSong(olga, { songId: 2, title: 'Olga 2' }, 'append');
  const stage = s.select(); s.commit(stage); s.recordStage(stage, Date.now() - 60000);
  const stageTurn = olga.lastAppearanceTurn;
  const next = s.select(); s.commit(next);
  assert.deepEqual([plain(stage.ids), plain(next.ids)], [[olga.id], [olga.id]], 'titre suivant d’Olga déjà chargé');
  const queue = [{ queueId: 1, songId: 1, singer: stage.label }, { queueId: 2, songId: 2, singer: next.label }];
  const bridge = fakeBridge(queue, 1);
  f.setBridge(bridge);
  f.tracked().push({ queueId: 1, sel: stage, startedAt: Date.now() - 60000, addedAt: Date.now() - 90000 },
    { queueId: 2, sel: next, startedAt: null, addedAt: Date.now() - 30000 });
  return { f, s, olga, bea, stage, next, bridge, queue, stageTurn };
}

// Sauvegarde de la soirée puis reprise, comme après un redémarrage.
function restart(f) {
  const { snapshotNight, restoreNight } = require('../night-state');
  const { TableAccess } = require('../table-access');
  const { Scheduler } = require('../scheduler');
  const access = new TableAccess();
  for (const id of f.sched.tables.keys()) access.issue(id);
  const settings = { auto: false, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 };
  const snapshot = plain(snapshotNight({ scheduler: f.sched, access, settings, tracked: f.tracked() }));
  const scheduler = new Scheduler({});
  restoreNight(snapshot, { scheduler, access: new TableAccess(), settings: { ...settings } });
  return scheduler;
}

// Regression: vérification de la troisième passe de la relecture finale —
// le duo noté au bar comptait l'invitée au dernier passage du chanteur, qui
// pouvait être son titre suivant déjà chargé dans KaraFun. Ce titre passé
// avant la lecture, le compteur des passages redescendait sous le tour de
// l'invitée : jusqu'au passage suivant, la soirée sauvegardée était refusée
// au redémarrage (« compteur des passages physiques mal formé »).
test('duo noté sur le passage en cours, titre suivant du chanteur passé dans KaraFun : invitée comptée au tour du passage, soirée reprise', async () => {
  const { f, s, bea, queue, stageTurn } = ownerNextLoaded();
  await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: bea.id });
  assert.equal(bea.lastAppearanceTurn, stageTurn, 'Bea est montée pendant ce passage, pas pendant le suivant');
  queue.splice(1, 1); // passé dans KaraFun avant la lecture
  f.sync();
  assert.equal(f.tracked().length, 1, 'le titre suivant n’est plus suivi');
  assert.equal(s.appearanceSerial, stageTurn, 'il ne compte plus');
  assert.equal(bea.lastAppearanceTurn, stageTurn);
  assert.equal(restart(f).people.get(bea.id).lastAppearanceTurn, stageTurn, 'la soirée se reprend');
});

test('duo noté après la chanson, titre suivant du chanteur passé dans KaraFun : même tour, soirée reprise', async () => {
  const { f, s, olga, bea, bridge, queue, stageTurn } = ownerNextLoaded();
  queue.splice(0, 1); // la chanson d'Olga finit
  bridge.status = { state: 'idle' };
  f.sync();
  const entry = s.stageHistory.at(-1);
  assert.ok(entry.endedAt);
  assert.equal(olga.lastAppearanceTurn, stageTurn + 1, 'son titre suivant est déjà compté');
  await f.call('POST /api/staff/duo-mark', { stageEntryId: entry.id, partnerId: bea.id, replace: true });
  assert.deepEqual(plain(entry.ids), [olga.id, bea.id]);
  assert.equal(bea.lastAppearanceTurn, stageTurn, 'Bea est comptée au tour du passage fini');
  queue.splice(0, 1); // son titre suivant est passé dans KaraFun avant la lecture
  f.sync();
  assert.equal(s.appearanceSerial, stageTurn);
  assert.equal(restart(f).people.get(bea.id).lastAppearanceTurn, stageTurn, 'la soirée se reprend');
});
