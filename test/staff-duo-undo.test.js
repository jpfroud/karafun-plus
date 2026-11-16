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

// Regression: relecture finale fraîche, première passe (adverse BAS) — le duo
// noté au bar acceptait n'importe quel titre suivi dans KaraFun, pas
// seulement celui sur scène. Noté sur un titre chargé mais pas commencé dont
// l'invitée avait aussi son propre titre chargé, puis ce titre passé dans
// KaraFun, le dernier passage de l'invitée dépassait le compteur des
// passages : la soirée sauvegardée ne se reprenait plus au redémarrage.
test('duo noté sur un titre chargé dans KaraFun mais pas commencé : refusé sans rien changer ; sur scène, accepté', async () => {
  const { f, s, dam, zoe, loaded, bridge, queue, beforeMark, credits } = evening();
  const zoeBefore = fairness(s, zoe);
  const creditsBefore = credits();
  await assert.rejects(f.call('POST /api/staff/duo-mark', { queueId: 2, partnerId: zoe.id }),
    { message: 'Ce titre n’a pas encore commencé : note le duo pendant la chanson en cours.' });
  assert.deepEqual(plain(loaded.ids), [dam.id], 'le titre chargé reste un solo');
  assert.equal(loaded.staffDuo, undefined);
  assert.deepEqual(fairness(s, zoe), zoeBefore, 'Zoé n’est pas comptée');
  assert.deepEqual(fairness(s, dam), beforeMark);
  assert.deepEqual(credits(), creditsBefore);
  assert.deepEqual(bridge.removed, [], 'rien n’est retiré de KaraFun');
  // Le même titre lancé par KaraFun, avant même que la file le note commencé :
  // il est sur scène, le duo se note.
  queue.splice(0, 1);
  bridge.status = { state: 'playing', songPlaying: { queueId: 2 } };
  assert.equal(f.tracked()[1].startedAt, null);
  const marked = plain(await f.call('POST /api/staff/duo-mark', { queueId: 2, partnerId: zoe.id }));
  assert.equal(marked.ok, true);
  assert.deepEqual(plain(loaded.ids), [dam.id, zoe.id]);
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

// Regression: relecture gstack-review de la branche finale (spécialiste des
// machines à états) — pendant l'alerte « Message de KaraFun illisible », l'accusé
// d'un envoi annulé reporte son retrait (la scène vue peut être figée, KaraFun
// a pu lancer le titre), mais celui d'un duo noté pendant l'envoi du titre du
// partenaire partait aussitôt, jugé sur cette scène peut-être figée. Il est
// noté, puis envoyé à la première vue lisible ; son délai d'avertissement
// (« retrait ignoré ») part de cet envoi.
test('duo noté pendant l’envoi, accusé pendant l’alerte d’un message illisible : retrait envoyé à la fin de l’alerte', async () => {
  const { f, s, bridge, queue } = evening();
  const next = s.select();
  const partner = s.people.get(next.ids[0]);
  f.setPending({ sel: next, at: Date.now(), before: new Set(queue.map(item => item.queueId)) });
  await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: partner.id });
  assert.equal(f.getPending().pullOnAck, 'duo', `duo noté avec ${partner.name} pendant l’envoi de son titre`);
  // Alerte, puis accusé : le titre envoyé apparaît dans la file de KaraFun.
  bridge.unreadable = 'remote.StatusEvent';
  queue.push({ queueId: 3, songId: next.song.songId, singer: next.label });
  f.sync();
  const sent = f.tracked().find(tr => tr.queueId === 3);
  assert.ok(sent, 'envoi accusé et suivi');
  assert.deepEqual(bridge.removed, [], 'rien retiré de KaraFun pendant l’alerte');
  assert.equal(sent.pulled?.reason, 'duo', 'retrait noté pour le duo');
  // Fin de l'alerte : le titre n'est pas sur scène, le retrait part.
  bridge.unreadable = null;
  const before = Date.now();
  f.sync();
  assert.deepEqual(bridge.removed, [3], 'retrait envoyé à la première vue lisible');
  assert.ok(sent.pulled.at >= before, 'délai d’avertissement compté depuis l’envoi');
});

// Duo improvisé noté pendant l'envoi du titre de son partenaire (Zoé), puis accusé de
// cet envoi pendant l'alerte d'un message illisible (état seul) : le retrait du titre de
// Zoé (queueId 3) est noté sans être envoyé.
function duoAckDuringAlert() {
  const context = evening();
  const { f, s, bridge, queue } = context;
  const next = s.select();
  const partner = s.people.get(next.ids[0]);
  f.setPending({ sel: next, at: Date.now(), before: new Set(queue.map(item => item.queueId)) });
  const ackDuringAlert = async () => {
    await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: partner.id });
    bridge.unreadable = 'remote.StatusEvent';
    queue.push({ queueId: 3, songId: next.song.songId, singer: next.label });
    f.sync();
    const sent = f.tracked().find(tr => tr.queueId === 3);
    assert.equal(sent?.pulled?.reason, 'duo', 'retrait noté à l’accusé');
    assert.deepEqual(bridge.removed, [], 'pas envoyé pendant l’alerte');
    return sent;
  };
  return { ...context, next, partner, ackDuringAlert };
}

// Regression: relecture gstack-review de la branche finale, passe 2 (cinq relecteurs) —
// le retrait d'un duo noté pendant l'alerte, pas encore envoyé, déclenchait au bout de
// 45 s d'alerte « KaraFun n'a pas retiré … », puis étouffait l'avis du vrai retrait
// ignoré après l'alerte. L'avis attend un retrait envoyé, et compte depuis l'envoi.
test('duo noté pendant l’envoi, accusé pendant une longue alerte : pas d’avis avant le vrai retrait, puis l’avis du retrait ignoré', async () => {
  const { f, s, bridge, ackDuringAlert } = duoAckDuringAlert();
  const sent = await ackDuringAlert();
  const ignored = () => s.log.filter(line => /n’a pas retiré/.test(line.msg));
  sent.pulled.at -= 46000; // 46 s d'alerte
  f.sync();
  assert.deepEqual(bridge.removed, [], 'rien envoyé pendant l’alerte');
  assert.deepEqual(ignored(), [], 'pas d’avis pour un retrait jamais envoyé');
  bridge.unreadable = null;
  f.sync();
  assert.deepEqual(bridge.removed, [3], 'retrait envoyé à la fin de l’alerte');
  sent.pulled.at -= 46000; // KaraFun ignore ce retrait depuis 46 s
  f.sync();
  assert.equal(ignored().length, 1, 'avis du retrait ignoré, compté depuis l’envoi');
});

// Regression: relecture gstack-review de la branche finale, passe 2 (passe contradictoire,
// équipe rouge) — un duo improvisé noté pendant l'alerte retirait aussitôt le titre chargé
// du partenaire, jugé sur une scène peut-être figée, alors que l'accusé d'un envoi le
// reporte. Les retraits de KaraFun pendant l'alerte attendent la première vue lisible.
test('duo noté pendant l’alerte d’un message illisible : le titre du partenaire quitte KaraFun à la première vue lisible', async () => {
  const { f, bridge, dam } = evening();
  bridge.unreadable = 'remote.StatusEvent';
  const marked = await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: dam.id });
  assert.match(marked.message, /Le titre suivant de Dam quittera KaraFun à la fin de l’alerte/);
  assert.equal(f.tracked().find(tr => tr.queueId === 2).pulled?.reason, 'duo', 'retrait du titre de Dam noté');
  assert.deepEqual(bridge.removed, [], 'pas pendant l’alerte : la scène vue peut être figée');
  bridge.unreadable = null;
  f.sync();
  assert.deepEqual(bridge.removed, [2], 'envoyé à la première vue lisible');
});

// Même règle (passe 2, simplification) : annulé avant d'être envoyé, le retrait ne laisse
// rien qui puisse encore aboutir ; le titre ne serait pas rendu à son chanteur à tort.
test('duo noté puis annulé pendant l’alerte, avant l’envoi du retrait : rien retiré, rien gardé pour plus tard', async () => {
  const { f, bridge, dam } = evening();
  bridge.unreadable = 'remote.StatusEvent';
  await f.call('POST /api/staff/duo-mark', { queueId: 1, partnerId: dam.id });
  const loaded = f.tracked().find(tr => tr.queueId === 2);
  await f.call('POST /api/staff/duo-unmark', { queueId: 1 });
  assert.equal(loaded.pulled, null, 'retrait abandonné');
  assert.equal(loaded.unpulled, undefined, 'jamais envoyé : rien qui puisse encore aboutir');
  bridge.unreadable = null;
  f.sync();
  assert.deepEqual(bridge.removed, [], 'rien retiré');
});

// Même règle pour « Parti » (GUIDE-BAR.md : pendant l'alerte, pas de retrait du titre d'un
// chanteur parti).
test('« Parti » pendant l’alerte d’un message illisible : son titre chargé quitte KaraFun à la première vue lisible', async () => {
  const { f, bridge, dam } = evening();
  bridge.unreadable = 'remote.StatusEvent';
  await f.call('POST /api/staff/person/leave', { personId: dam.id });
  assert.deepEqual(bridge.removed, [], 'pas pendant l’alerte');
  bridge.unreadable = null;
  f.sync();
  assert.deepEqual(bridge.removed, [2], 'envoyé à la première vue lisible');
});

// Regression: relecture gstack-review de la branche finale, passe 2 (équipe rouge) —
// pendant une alerte de la file seule (file figée, état lisible), un titre chanté puis fini
// reste dans la file figée : « Parti » ou « Vider toutes les chansons » le marquait annulé,
// et à la fin de l'alerte son passage ne se fermait jamais. Un titre déjà commencé n'est
// plus annulé, comme pour « Supprimer toutes les tables ».
for (const [geste, faire] of [
  ['« Parti »', (f, marine) => f.call('POST /api/staff/person/leave', { personId: marine.id })],
  ['« Vider toutes les chansons »', f => f.call('POST /api/staff/queue-clear', { confirmation: 'VIDER TOUTES LES CHANSONS' })],
]) {
  test(`${geste} pendant une alerte de la file seule : le titre déjà chanté se clôt à la fin de l’alerte`, async () => {
    const { f, s, bridge, queue, marine, stage } = evening();
    Object.assign(bridge, { unreadable: 'remote.QueueEvent', queueUnreadable: true, status: { state: 'playing', songPlaying: { queueId: 2 } } });
    f.sync();
    await faire(f, marine);
    assert.equal(f.tracked().find(tr => tr.queueId === 1)?.cancelled ?? false, false, 'titre chanté pas annulé');
    queue.shift();
    Object.assign(bridge, { unreadable: null, queueUnreadable: false });
    f.sync();
    const entry = s.stageHistory.find(item => item.entryId === stage.song.entryId);
    assert.ok(entry?.endedAt, 'passage de Marine clos');
  });
}

// Relecture gstack-review de la branche finale, passe 2 (machines à états, cases sans
// essai) : retrait d'un duo noté à l'accusé pendant l'alerte, puis le titre démarre,
// quitte KaraFun ou voit le duo annulé avant la fin de l'alerte.
test('duo noté pendant l’envoi, accusé pendant l’alerte, titre lancé dans KaraFun avant la fin : il continue et compte, rien retiré', async () => {
  const { f, s, bridge, queue, ackDuringAlert } = duoAckDuringAlert();
  const sent = await ackDuringAlert();
  // KaraFun finit le titre de Marine et lance celui de Zoé pendant l'alerte.
  queue.shift();
  bridge.status = { state: 'playing', songPlaying: { queueId: 3 } };
  bridge.unreadable = null;
  f.sync();
  assert.deepEqual(bridge.removed, [], 'rien retiré : il est sur scène');
  assert.equal(sent.pulled, null, 'retrait abandonné');
  assert.ok(sent.startedAt, 'passage compté');
  assert.ok(s.log.some(line => /a commencé avant son retrait de KaraFun ; il continue/.test(line.msg)));
});

test('duo noté pendant l’envoi, accusé pendant l’alerte, titre retiré dans KaraFun avant la fin : jugé à la fin de l’alerte, il repassera plus tard', async () => {
  const { f, s, bridge, queue, next, partner, ackDuringAlert } = duoAckDuringAlert();
  const sent = await ackDuringAlert();
  queue.pop(); // retiré dans KaraFun pendant l'alerte, jamais vu sur scène
  f.sync();
  assert.ok(f.tracked().includes(sent), 'rien de conclu pendant l’alerte');
  bridge.unreadable = null;
  f.sync();
  assert.ok(!f.tracked().includes(sent), 'jugé à la première vue lisible');
  assert.deepEqual(bridge.removed, [], 'aucun retrait envoyé');
  assert.ok(s.log.some(line => /retiré de KaraFun après le duo improvisé : il repassera plus tard/.test(line.msg)));
  assert.ok(s.songsOf(partner).some(song => song.title === next.song.title), 'titre rendu à Zoé');
});

test('duo noté pendant l’envoi, accusé pendant l’alerte, puis annulé avant l’envoi du retrait : rien retiré, rien gardé pour plus tard', async () => {
  const { f, bridge, ackDuringAlert } = duoAckDuringAlert();
  const sent = await ackDuringAlert();
  await f.call('POST /api/staff/duo-unmark', { queueId: 1 });
  assert.equal(sent.pulled, null, 'retrait abandonné');
  assert.equal(sent.unpulled, undefined, 'jamais envoyé : rien qui puisse encore aboutir');
  bridge.unreadable = null;
  f.sync();
  assert.deepEqual(bridge.removed, [], 'rien retiré');
});

// Même relecture, même case : un titre déjà commencé qui quitte la file de KaraFun
// pendant l'alerte (état seul illisible, l'état vu montre déjà le titre suivant) est clos
// tout de suite, une seule fois.
test('titre déjà commencé sorti de KaraFun pendant l’alerte d’un état illisible : passage clos tout de suite, compté une fois', () => {
  const { f, s, bridge, queue, marine, stage } = evening();
  Object.assign(bridge, { unreadable: 'remote.StatusEvent', status: { state: 'playing', songPlaying: { queueId: 2 } } });
  queue.shift();
  f.sync();
  const entries = () => s.stageHistory.filter(item => item.entryId === stage.song.entryId);
  assert.ok(entries()[0]?.endedAt, 'passage de Marine clos pendant l’alerte');
  assert.ok(!f.tracked().some(tr => tr.queueId === 1), 'titre de Marine plus suivi');
  const sung = marine.sung;
  bridge.unreadable = null;
  f.sync();
  assert.equal(marine.sung, sung, 'compté une seule fois');
  assert.equal(entries().length, 1, 'un seul passage');
});

// Événements que le serveur du bac à sable note au journal de soirée, à partir de
// maintenant. harness() n'expose pas le journal : une fonction créée par le
// constructeur Function du bac à sable voit les constantes de haut niveau de
// server.js, dont `journal`.
function p3g2Journal(f) {
  const journal = f.sync.constructor('return journal')();
  const append = journal.append.bind(journal);
  const seen = [];
  journal.append = (type, fields, at) => {
    seen.push({ ...plain(fields ?? {}), ev: type });
    return append(type, fields, at);
  };
  return seen;
}

// Regression: relecture gstack-review de la branche finale, cycle 3 (retraits reportés
// pendant l'alerte) — « Parti » pendant l'alerte d'un message illisible note le retrait
// du titre chargé du chanteur sans l'envoyer (removeRequestedAt à 0). KaraFun lance ce
// titre avant la première vue lisible : il restait annulé en pleine chanson, et à sa fin
// « Retrait KaraFun confirmé » prenait la place de la clôture de son passage (entrée de
// scène jamais close). Un retrait jamais envoyé ne prime pas sur la scène : le titre
// continue et compte comme chanté.
test('« Parti » pendant l’alerte d’un état illisible, titre chargé lancé par KaraFun avant la fin : rien retiré, il compte, son passage se clôt', async () => {
  const { f, s, dam, loaded, bridge, queue } = evening();
  bridge.unreadable = 'remote.StatusEvent';
  await f.call('POST /api/staff/person/leave', { personId: dam.id });
  const sent = f.tracked().find(tr => tr.queueId === 2);
  assert.equal(sent?.cancelled, true, 'retrait du titre de Dam noté');
  assert.equal(sent.removeRequestedAt, 0, 'pas envoyé pendant l’alerte');
  assert.deepEqual(bridge.removed, []);
  // KaraFun finit le titre de Marine et lance celui de Dam pendant l'alerte : la
  // première vue lisible le montre sur scène.
  queue.shift();
  Object.assign(bridge, { unreadable: null, status: { state: 'playing', songPlaying: { queueId: 2 } } });
  f.sync();
  assert.deepEqual(bridge.removed, [], 'rien retiré : il est sur scène');
  assert.equal(sent.cancelled, false, 'plus annulé : il continue');
  assert.ok(sent.startedAt, 'passage commencé');
  assert.equal(loaded.turnCredit.rolledBack, false, 'crédit gardé : il compte comme chanté');
  const entry = s.stageHistory.find(item => item.entryId === loaded.song.entryId);
  assert.ok(entry && !entry.endedAt, 'entrée de scène notée');
  // Fin du titre de Dam.
  queue.shift();
  bridge.status = { state: 'idle' };
  f.sync();
  assert.ok(!f.tracked().includes(sent), 'plus suivi');
  assert.ok(entry.endedAt, 'passage clos');
  assert.ok(!s.log.some(line => /Retrait KaraFun confirmé/.test(line.msg)), 'pas de « Retrait KaraFun confirmé »');
  assert.equal(loaded.turnCredit.rolledBack, false, 'toujours compté');
});

// « Supprimer toutes les tables » pendant l'alerte d'un message illisible (état seul) :
// le titre chargé de Dam (queueId 2), de la soirée close, est annulé sans que son
// retrait parte (removeRequestedAt à 0), ni à la synchronisation suivante, toujours
// pendant l'alerte.
async function p3g2ResetDuringAlert() {
  const context = evening();
  const { f, bridge } = context;
  bridge.unreadable = 'remote.StatusEvent';
  const reset = await f.call('POST /api/staff/tables-clear', { confirmation: 'SUPPRIMER TOUTES LES TABLES' });
  f.sync();
  const sent = f.tracked().find(tr => tr.queueId === 2);
  assert.equal(sent?.cancelled, true, 'titre de la soirée close annulé');
  assert.equal(sent.removeRequestedAt, 0, 'retrait pas envoyé');
  assert.deepEqual(bridge.removed, [], 'rien retiré pendant l’alerte');
  return { ...context, reset, sent };
}

// Même relecture, même règle pour la remise à zéro : le titre de la soirée close que
// KaraFun lance avant la première vue lisible continue. Il ne compte pas dans la
// nouvelle soirée (ni reçu ni envoi noté au journal), et son passage se clôt à sa fin.
test('« Supprimer toutes les tables » pendant l’alerte, titre de la soirée close lancé avant la fin : rien retiré, hors de la nouvelle soirée, passage clos', async () => {
  const { f, s, loaded, bridge, queue, sent } = await p3g2ResetDuringAlert();
  const journaled = p3g2Journal(f);
  queue.shift();
  Object.assign(bridge, { unreadable: null, status: { state: 'playing', songPlaying: { queueId: 2 } } });
  f.sync();
  assert.deepEqual(bridge.removed, [], 'rien retiré : il est sur scène');
  assert.equal(sent.cancelled, false, 'plus annulé : il continue');
  assert.ok(sent.startedAt, 'passage commencé');
  assert.equal(loaded.turnCredit.rolledBack, true, 'son reçu de la soirée close reste soldé : pas de nouveau passage compté');
  assert.equal(s.appearanceSerial, 0, 'aucun passage compté dans la nouvelle soirée');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.sent'), [], 'aucun envoi noté au journal de la nouvelle soirée');
  // Fin du titre.
  queue.shift();
  bridge.status = { state: 'idle' };
  f.sync();
  assert.ok(!f.tracked().includes(sent), 'plus suivi');
  const entries = s.stageHistory.filter(item => item.entryId === loaded.song.entryId);
  assert.equal(entries.length, 1, 'une entrée de scène, notée à son début');
  assert.ok(entries.every(item => item.endedAt), 'toute entrée de scène de ce titre est close');
  assert.ok(!s.log.some(line => /Retrait KaraFun confirmé/.test(line.msg)), 'pas de « Retrait KaraFun confirmé »');
  assert.equal(s.appearanceSerial, 0, 'toujours aucun passage compté');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.sent'), [], 'toujours aucun envoi noté');
});

// Titre de Zoé en cours d'envoi, annulé par « Parti », puis son accusé pendant l'alerte
// d'un message illisible (état seul) : suivi annulé (queueId 3), sans compter, et son
// retrait retenu jusqu'à la première vue lisible.
async function p3g2CancelledAckDuringAlert() {
  const context = evening();
  const { f, s, bridge, queue, zoe } = context;
  const next = s.select();
  assert.equal(next.ids[0], zoe.id, 'titre de Zoé en cours d’envoi');
  f.setPending({ sel: next, at: Date.now(), before: new Set(queue.map(item => item.queueId)) });
  await f.call('POST /api/staff/person/leave', { personId: zoe.id });
  assert.equal(f.getPending()?.cancelled, true, 'envoi annulé par « Parti »');
  const journaled = p3g2Journal(f);
  bridge.unreadable = 'remote.StatusEvent';
  queue.push({ queueId: 3, songId: next.song.songId, singer: next.label });
  f.sync();
  const sent = f.tracked().find(tr => tr.queueId === 3);
  assert.equal(sent?.cancelled, true, 'accusé suivi, annulé');
  assert.equal(sent.removeRequestedAt, 0, 'retrait retenu jusqu’à la fin de l’alerte');
  assert.equal(next.turnCredit, undefined, 'pas compté');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.sent'), []);
  assert.deepEqual(bridge.removed, [], 'rien retiré pendant l’alerte');
  return { ...context, next, sent, journaled };
}

// Même relecture, même règle pour l'accusé d'un envoi annulé reçu pendant l'alerte :
// KaraFun lance ce titre avant la première vue lisible. Il continue et compte comme un
// passage (reçu posé, envoi noté au journal), comme l'accusé arrivé directement sur
// scène, et son passage se clôt à sa fin.
test('envoi annulé par « Parti », accusé pendant l’alerte, titre lancé avant la fin : rien retiré, compté, passage clos', async () => {
  const { f, s, next, sent, journaled, bridge, queue } = await p3g2CancelledAckDuringAlert();
  // KaraFun finit le titre de Marine et lance celui de Zoé pendant l'alerte.
  queue.shift();
  Object.assign(bridge, { unreadable: null, status: { state: 'playing', songPlaying: { queueId: 3 } } });
  f.sync();
  assert.deepEqual(bridge.removed, [], 'rien retiré : il est sur scène');
  assert.equal(sent.cancelled, false, 'plus annulé : il continue');
  assert.equal(next.turnCredit?.rolledBack, false, 'compté comme passage');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.sent').map(e => e.queueId), [3], 'envoi noté au journal');
  // Fin du titre de Zoé : KaraFun le retire de sa file (le titre de Dam y reste).
  queue.splice(queue.findIndex(item => item.queueId === 3), 1);
  bridge.status = { state: 'idle' };
  f.sync();
  assert.ok(!f.tracked().includes(sent), 'plus suivi');
  const entry = s.stageHistory.find(item => item.entryId === next.song.entryId);
  assert.ok(entry?.endedAt, 'passage clos');
  assert.ok(!s.log.some(line => /Retrait KaraFun confirmé/.test(line.msg)), 'pas de « Retrait KaraFun confirmé »');
  assert.equal(next.turnCredit.rolledBack, false, 'toujours compté');
});

// Même relecture, cases sans essai : la remise à zéro pendant l'alerte n'envoie aucun
// retrait (la réponse le dit au bar) ; le titre de la soirée close qui attend encore dans
// la file de KaraFun, hors scène, la quitte à la première vue lisible.
test('« Supprimer toutes les tables » pendant l’alerte : aucun retrait envoyé, puis le titre encore dans la file quitte KaraFun à la première vue lisible', async () => {
  const { f, bridge, reset } = await p3g2ResetDuringAlert();
  assert.equal(reset.removalRequests, 0, 'aucun retrait envoyé pendant l’alerte');
  assert.equal(reset.removalPending, 1, 'un titre doit encore quitter KaraFun');
  bridge.unreadable = null;
  f.sync();
  assert.deepEqual(bridge.removed, [2], 'retrait envoyé à la première vue lisible');
});

// Même cas, mais le titre de la soirée close sort de la file de KaraFun pendant l'alerte,
// sans être vu sur scène : aucun verdict d'après la scène figée. Il reste suivi jusqu'à la
// première vue lisible, qui le dit annulé (retrait confirmé), sans rien retirer.
test('« Supprimer toutes les tables » pendant l’alerte, titre sorti de KaraFun avant la fin : suivi jusqu’à la fin de l’alerte, puis annulé, rien retiré', async () => {
  const { f, s, loaded, bridge, queue, sent } = await p3g2ResetDuringAlert();
  const journaled = p3g2Journal(f);
  queue.pop(); // sorti de la file de KaraFun pendant l'alerte ; Marine chante encore
  f.sync();
  assert.ok(f.tracked().includes(sent), 'toujours suivi pendant l’alerte');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.unsent'), [], 'aucun verdict pendant l’alerte');
  bridge.unreadable = null;
  f.sync();
  assert.ok(!f.tracked().includes(sent), 'jugé à la première vue lisible');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.unsent').map(e => [e.queueId, e.reason]), [[2, 'cancelled']], 'verdict : annulé');
  assert.ok(s.log.some(line => line.msg === `Retrait KaraFun confirmé : « ${loaded.song.title} »`));
  assert.deepEqual(bridge.removed, [], 'rien retiré');
});

// Même cas pour l'accusé d'un envoi annulé reçu pendant l'alerte : le titre sort de la
// file de KaraFun pendant elle, sans être vu sur scène. Retenu jusqu'à la première vue
// lisible, il y reçoit le verdict d'un titre annulé, sans crédit à rendre (jamais
// compté), et rien n'est retiré.
test('envoi annulé par « Parti », accusé pendant l’alerte, titre sorti de KaraFun avant la fin : retenu, puis annulé sans compter, rien retiré', async () => {
  const { f, s, next, sent, journaled, bridge, queue } = await p3g2CancelledAckDuringAlert();
  queue.pop(); // sorti de la file de KaraFun pendant l'alerte ; Marine chante encore
  f.sync();
  assert.ok(f.tracked().includes(sent), 'retenu pendant l’alerte');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.unsent'), [], 'aucun verdict pendant l’alerte');
  bridge.unreadable = null;
  f.sync();
  assert.ok(!f.tracked().includes(sent), 'plus suivi');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.unsent').map(e => [e.queueId, e.reason]), [[3, 'cancelled']], 'verdict : annulé');
  assert.ok(s.log.some(line => line.msg === `Retrait KaraFun confirmé : « ${next.song.title} »`));
  assert.equal(next.turnCredit, undefined, 'jamais compté');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.sent'), [], 'aucun envoi noté au journal');
  assert.deepEqual(bridge.removed, [], 'rien retiré');
});

// Regression: même relecture — « Parti » hors alerte envoie aussitôt le retrait du titre
// chargé ; KaraFun le lance quand même (retrait arrivé trop tard). Vu sur scène, il a été
// chanté : à sa fin, son passage se clôt. « Retrait KaraFun confirmé » prenait sa place
// et laissait son entrée de scène ouverte.
test('« Parti » hors alerte, retrait envoyé mais titre lancé quand même : à sa fin, passage clos sans « Retrait KaraFun confirmé »', async () => {
  const { f, s, dam, loaded, bridge, queue } = evening();
  await f.call('POST /api/staff/person/leave', { personId: dam.id });
  assert.deepEqual(bridge.removed, [2], 'retrait envoyé aussitôt');
  const sent = f.tracked().find(tr => tr.queueId === 2);
  assert.equal(sent?.cancelled, true);
  // KaraFun ignore le retrait : il finit le titre de Marine et lance celui de Dam.
  queue.shift();
  bridge.status = { state: 'playing', songPlaying: { queueId: 2 } };
  f.sync();
  assert.ok(sent.startedAt, 'vu sur scène');
  const entry = s.stageHistory.find(item => item.entryId === loaded.song.entryId);
  assert.ok(entry && !entry.endedAt, 'entrée de scène notée');
  // Fin du titre de Dam.
  queue.shift();
  bridge.status = { state: 'idle' };
  f.sync();
  assert.ok(!f.tracked().includes(sent), 'plus suivi');
  assert.ok(entry.endedAt, 'passage clos');
  assert.ok(!s.log.some(line => /Retrait KaraFun confirmé/.test(line.msg)), 'pas de « Retrait KaraFun confirmé »');
  assert.equal(loaded.turnCredit.rolledBack, false, 'chanté : son crédit reste');
});

// Renforcement (même relecture) de l'essai de la longue alerte plus haut : l'avis
// « KaraFun n’a pas retiré » compte depuis le premier envoi du retrait, pas depuis
// l'accusé noté pendant l'alerte. À la synchronisation de fin d'alerte, le retrait part
// et aucun avis n'est noté, même après une longue alerte ; il ne vient que 45 s après
// cet envoi, une seule fois.
test('duo noté pendant l’envoi, accusé pendant une longue alerte : aucun avis à l’envoi du retrait, un seul 45 s après', async () => {
  const { f, s, bridge, ackDuringAlert } = duoAckDuringAlert();
  const sent = await ackDuringAlert();
  const ignored = () => s.log.filter(line => /n’a pas retiré/.test(line.msg));
  sent.pulled.at -= 46000; // 46 s d'alerte depuis l'accusé
  f.sync();
  bridge.unreadable = null;
  f.sync();
  assert.deepEqual(bridge.removed, [3], 'retrait envoyé à la fin de l’alerte');
  assert.deepEqual(ignored(), [], 'aucun avis : KaraFun vient de recevoir le retrait');
  f.sync();
  assert.deepEqual(ignored(), [], 'toujours aucun avis avant 45 s');
  sent.pulled.at -= 46000; // KaraFun ignore ce retrait depuis 46 s
  f.sync();
  f.sync();
  assert.equal(ignored().length, 1, 'un seul avis, compté depuis l’envoi');
});

// Relecture du cycle 3 (file figée, cases sans essai) : pendant une alerte de la file seule
// (file figée, état lisible), le titre de Marine, chanté puis fini, reste dans la file
// figée pendant que KaraFun joue celui de Dam. Comme pour « Parti » et « Vider toutes les
// chansons » (essais plus haut), « Table partie » pour la table de Marine ne le compte plus
// comme un titre à venir à retirer : pas annulé, rien retiré de KaraFun, et son passage se
// clôt quand la file lisible ne l'a plus.
test('« Table partie » pendant une alerte de la file seule : titre déjà chanté pas annulé, rien retiré, passage clos à la fin de l’alerte', async () => {
  const { f, s, bridge, queue, marine, stage } = evening();
  Object.assign(bridge, { unreadable: 'remote.QueueEvent', queueUnreadable: true, status: { state: 'playing', songPlaying: { queueId: 2 } } });
  f.sync();
  const answer = plain(await f.call('POST /api/staff/table-left', { id: marine.tableId }));
  assert.equal(answer.removedFromKaraFun, 0, 'aucun titre de la table encore à venir');
  const sung = f.tracked().find(tr => tr.queueId === 1);
  assert.ok(sung, 'titre chanté toujours suivi pendant l’alerte');
  assert.equal(sung.cancelled ?? false, false, 'titre chanté pas annulé');
  // Fin de l'alerte : la file lisible n'a plus le titre de Marine.
  queue.shift();
  Object.assign(bridge, { unreadable: null, queueUnreadable: false });
  f.sync();
  assert.deepEqual(bridge.removed, [], 'rien retiré de KaraFun');
  assert.ok(!f.tracked().includes(sung), 'titre de Marine plus suivi');
  const entry = s.stageHistory.find(item => item.entryId === stage.song.entryId);
  assert.ok(entry?.endedAt, 'passage de Marine clos');
});

// Même case avec « Supprimer toutes les tables » (remise à zéro) : le titre chanté resté
// dans la file figée n'est pas annulé comme un titre envoyé à retirer ; il reste suivi
// jusqu'à ce que la file lisible ne l'ait plus, sans qu'aucun retrait parte vers KaraFun.
test('« Supprimer toutes les tables » pendant une alerte de la file seule : titre déjà chanté pas annulé, suivi jusqu’à la file lisible, rien retiré', async () => {
  const { f, bridge, queue } = evening();
  Object.assign(bridge, { unreadable: 'remote.QueueEvent', queueUnreadable: true, status: { state: 'playing', songPlaying: { queueId: 2 } } });
  f.sync();
  const answer = plain(await f.call('POST /api/staff/tables-clear', { confirmation: 'SUPPRIMER TOUTES LES TABLES' }));
  assert.equal(answer.removalPending, 0, 'aucun titre envoyé à retirer');
  const sung = f.tracked().find(tr => tr.queueId === 1);
  assert.ok(sung, 'titre chanté toujours suivi pendant l’alerte');
  assert.equal(sung.cancelled ?? false, false, 'titre chanté pas annulé');
  queue.shift();
  Object.assign(bridge, { unreadable: null, queueUnreadable: false });
  f.sync();
  assert.ok(!f.tracked().includes(sung), 'plus suivi quand la file lisible ne l’a plus');
  assert.deepEqual(bridge.removed, [], 'rien retiré de KaraFun');
});

// Regression: relecture du cycle 3 — remise à zéro (« Supprimer toutes les tables »)
// pendant que KaraFun est déconnecté : le titre déjà envoyé de Dam est annulé sans retrait
// envoyé (removeRequestedAt à 0), à retirer au retour de KaraFun. KaraFun l'a lancé
// entre-temps et revient avec lui sur scène : la file ne le retirait pas, mais le gardait
// annulé (« 1 retrait en attente » au bar pendant toute la chanson), puis notait à sa fin
// « Retrait KaraFun confirmé » sans clore son passage dans les derniers passages. Lancé
// avant le retrait, il continue et compte comme chanté.
test('remise à zéro pendant que KaraFun est déconnecté, titre envoyé revenu sur scène : rien retiré, il continue, passage clos à sa fin', async () => {
  const { f, s, bridge, queue, loaded } = evening();
  Object.assign(bridge, { ready: false, connected: false });
  f.sync();
  await f.call('POST /api/staff/tables-clear', { confirmation: 'SUPPRIMER TOUTES LES TABLES' });
  const sent = f.tracked().find(tr => tr.queueId === 2);
  assert.equal(sent?.cancelled, true, 'titre envoyé annulé par la remise à zéro');
  assert.equal(sent.removeRequestedAt, 0, 'retrait pas envoyé : KaraFun déconnecté');
  // KaraFun revient : il a fini le titre de Marine et lancé celui de Dam.
  queue.shift();
  Object.assign(bridge, { ready: true, connected: true, status: { state: 'playing', songPlaying: { queueId: 2 } } });
  f.sync();
  assert.deepEqual(bridge.removed, [], 'rien retiré de KaraFun');
  assert.ok(f.tracked().includes(sent) && sent.startedAt, 'toujours suivi, sur scène');
  assert.equal(f.staffState().removalPending, 0, 'lancé avant le retrait : il continue, aucun retrait en attente au bar');
  const entry = s.stageHistory.find(item => item.entryId === loaded.song.entryId);
  assert.ok(entry && !entry.endedAt, 'passage de Dam ouvert dans les derniers passages');
  // Fin du titre de Dam.
  queue.shift();
  bridge.status = { state: 'idle' };
  f.sync();
  assert.ok(!f.tracked().includes(sent), 'plus suivi');
  assert.ok(entry.endedAt, 'passage de Dam clos');
  assert.ok(!s.log.some(line => /Retrait KaraFun confirmé/.test(line.msg)), 'pas de « Retrait KaraFun confirmé »');
  assert.deepEqual(bridge.removed, [], 'toujours rien retiré');
});

// Regression: relecture 2, cycle 1 — titre de Zoé en cours d'envoi, annulé par « Parti »,
// puis accusé hors scène et hors alerte : son retrait part aussitôt (removeRequestedAt
// posé). KaraFun le lance quand même (retrait ignoré, ou arrivé trop tard). Seul un retrait
// jamais envoyé levait l'annulation d'un titre vu sur scène : celui-ci restait annulé en
// pleine chanson, sans reçu ni envoi noté au journal, alors que la chanson était chantée.
// Il continue et compte comme un passage, comme l'accusé arrivé directement sur scène ;
// aucun second retrait ne part, même quand l'état de KaraFun montre la scène libre avant
// que sa file ne lâche le titre, et à sa fin son passage se clôt.
test('envoi annulé par « Parti », accusé hors scène hors alerte, retrait envoyé, titre lancé quand même : il compte, aucun second retrait, passage clos', async () => {
  const { f, s, bridge, queue, zoe } = evening();
  const next = s.select();
  assert.equal(next.ids[0], zoe.id, 'titre de Zoé en cours d’envoi');
  f.setPending({ sel: next, at: Date.now(), before: new Set(queue.map(item => item.queueId)) });
  await f.call('POST /api/staff/person/leave', { personId: zoe.id });
  assert.equal(f.getPending()?.cancelled, true, 'envoi annulé par « Parti »');
  const journaled = p3g2Journal(f);
  // Accusé lisible, hors scène : Marine chante encore.
  queue.push({ queueId: 3, songId: next.song.songId, singer: next.label });
  f.sync();
  const sent = f.tracked().find(tr => tr.queueId === 3);
  assert.equal(sent?.cancelled, true, 'accusé suivi, annulé');
  assert.ok(sent.removeRequestedAt > 0, 'retrait envoyé à l’accusé');
  assert.deepEqual(bridge.removed, [3], 'retrait envoyé aussitôt');
  assert.equal(next.turnCredit, undefined, 'pas compté à l’accusé');
  // KaraFun ignore le retrait : il finit le titre de Marine et lance celui de Zoé.
  queue.shift();
  bridge.status = { state: 'playing', songPlaying: { queueId: 3 } };
  f.sync();
  assert.equal(sent.cancelled, false, 'plus annulé : il continue');
  assert.equal(f.staffState().removalPending, 0, 'aucun retrait en attente au bar');
  assert.ok(sent.startedAt, 'vu sur scène');
  assert.equal(next.turnCredit?.rolledBack, false, 'compté comme passage, reçu posé');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.sent').map(e => e.queueId), [3], 'envoi noté au journal');
  const entry = s.stageHistory.find(item => item.entryId === next.song.entryId);
  assert.ok(entry && !entry.endedAt, 'entrée de scène notée');
  // La chanson dure plus de 20 s après le retrait envoyé. À sa fin, l'état de KaraFun
  // (scène libre) arrive avant sa file, qui montre encore le titre : un titre resté
  // annulé y verrait un retrait à renvoyer.
  sent.removeRequestedAt -= 21000;
  bridge.status = { state: 'idle' };
  f.sync();
  assert.deepEqual(bridge.removed, [3], 'aucun second retrait');
  // Sa file suit : KaraFun n'a plus le titre de Zoé (celui de Dam y reste).
  queue.splice(queue.findIndex(item => item.queueId === 3), 1);
  f.sync();
  assert.ok(!f.tracked().includes(sent), 'plus suivi');
  assert.ok(entry.endedAt, 'passage clos');
  assert.ok(!s.log.some(line => /Retrait KaraFun confirmé/.test(line.msg)), 'pas de « Retrait KaraFun confirmé »');
  assert.equal(next.turnCredit.rolledBack, false, 'toujours compté');
  assert.deepEqual(bridge.removed, [3], 'toujours un seul retrait');
});

// Retrait de KaraFun pendant une coupure : le vrai pont lève « Pas connecté à KaraFun »
// (KaraFunBridge#_emit) sans rien envoyer. Rend les retraits tentés.
function p5gCOfflineRemove(bridge) {
  const attempts = [];
  const remove = bridge.remove;
  bridge.remove = id => {
    attempts.push(id);
    if (!bridge.ready || !bridge.connected) throw new Error('Pas connecté à KaraFun');
    return remove(id);
  };
  return attempts;
}

// Regression: relecture 2, cycle 1 — « Parti » pendant que KaraFun est déconnecté : le
// retrait du titre chargé de Dam est tenté (removeRequestedAt posé) et le pont lève « Pas
// connecté à KaraFun ». KaraFun revient avec ce titre sur scène, lancé pendant la coupure :
// il restait annulé pendant toute la chanson (« 1 retrait en attente » au bar), comme un
// titre dont KaraFun aurait ignoré le retrait. Un retrait que KaraFun n'a jamais reçu ne
// prime pas sur la scène : le titre continue, n'est plus annulé, et son passage se clôt à
// sa fin.
test('« Parti » pendant que KaraFun est déconnecté, retrait refusé par le pont, titre revenu sur scène : il continue, plus annulé, aucun retrait en attente', async () => {
  const { f, s, dam, loaded, bridge, queue } = evening();
  const attempts = p5gCOfflineRemove(bridge);
  Object.assign(bridge, { ready: false, connected: false });
  f.sync();
  await f.call('POST /api/staff/person/leave', { personId: dam.id });
  const sent = f.tracked().find(tr => tr.queueId === 2);
  assert.equal(sent?.cancelled, true, 'titre chargé de Dam annulé');
  assert.deepEqual(attempts, [2], 'retrait tenté');
  assert.ok(s.log.some(line => line.msg === 'Retrait KaraFun à vérifier : Pas connecté à KaraFun'), 'le pont refuse : KaraFun déconnecté');
  assert.deepEqual(bridge.removed, [], 'rien n’est parti vers KaraFun');
  assert.equal(f.staffState().removalPending, 1, 'retrait en attente pendant la coupure');
  // KaraFun revient : il a fini le titre de Marine et lancé celui de Dam.
  queue.shift();
  Object.assign(bridge, { ready: true, connected: true, status: { state: 'playing', songPlaying: { queueId: 2 } } });
  f.sync();
  assert.equal(sent.cancelled, false, 'plus annulé : il continue');
  assert.equal(f.staffState().removalPending, 0, 'aucun retrait en attente au bar');
  assert.deepEqual(bridge.removed, [], 'rien retiré : il est sur scène');
  assert.ok(sent.startedAt, 'vu sur scène');
  assert.equal(loaded.turnCredit.rolledBack, false, 'crédit gardé : il compte comme chanté');
  const entry = s.stageHistory.find(item => item.entryId === loaded.song.entryId);
  assert.ok(entry && !entry.endedAt, 'passage de Dam ouvert dans les derniers passages');
  // Fin du titre de Dam.
  queue.shift();
  bridge.status = { state: 'idle' };
  f.sync();
  assert.ok(!f.tracked().includes(sent), 'plus suivi');
  assert.ok(entry.endedAt, 'passage de Dam clos');
  assert.ok(!s.log.some(line => /Retrait KaraFun confirmé/.test(line.msg)), 'pas de « Retrait KaraFun confirmé »');
  assert.deepEqual(attempts, [2], 'aucun autre retrait tenté');
});

// Relecture 2, cycle 1 (case sans essai) — remise à zéro (« Supprimer toutes les tables »)
// pendant que KaraFun est déconnecté : le titre déjà envoyé de Dam est annulé, son retrait
// remis au retour de KaraFun (removeRequestedAt à 0). Le bar le retire dans KaraFun pendant
// la coupure : il sort de la file sans passer sur scène. Rien n'est conclu tant que KaraFun
// ne se voit pas ; à son retour, il reçoit le verdict d'un titre annulé (« Retrait KaraFun
// confirmé »), rien n'est retiré, et rien de la soirée close ne compte dans la nouvelle.
test('remise à zéro pendant que KaraFun est déconnecté, titre sorti de KaraFun pendant la coupure : au retour, annulé, rien retiré, rien compté', async () => {
  const { f, s, loaded, bridge, queue } = evening();
  Object.assign(bridge, { ready: false, connected: false });
  f.sync();
  const reset = plain(await f.call('POST /api/staff/tables-clear', { confirmation: 'SUPPRIMER TOUTES LES TABLES' }));
  assert.deepEqual([reset.karafunOffline, reset.removalRequests, reset.removalPending], [true, 0, 1],
    'aucun retrait envoyé, un titre à retirer au retour de KaraFun');
  const sent = f.tracked().find(tr => tr.queueId === 2);
  assert.equal(sent?.cancelled, true, 'titre de la soirée close annulé');
  assert.equal(sent.removeRequestedAt, 0, 'retrait pas envoyé : KaraFun déconnecté');
  const journaled = p3g2Journal(f);
  // Pendant la coupure, le bar le retire dans KaraFun ; Marine chante encore.
  queue.splice(queue.findIndex(item => item.queueId === 2), 1);
  f.sync();
  assert.ok(f.tracked().includes(sent), 'rien de conclu tant que KaraFun ne se voit pas');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.unsent'), [], 'aucun verdict pendant la coupure');
  // KaraFun revient sans lui.
  Object.assign(bridge, { ready: true, connected: true });
  f.sync();
  assert.ok(!f.tracked().includes(sent), 'jugé au retour de KaraFun');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.unsent').map(e => [e.queueId, e.reason]), [[2, 'cancelled']], 'verdict : annulé');
  assert.ok(s.log.some(line => line.msg === `Retrait KaraFun confirmé : « ${loaded.song.title} »`), '« Retrait KaraFun confirmé »');
  assert.deepEqual(bridge.removed, [], 'rien retiré');
  assert.equal(s.appearanceSerial, 0, 'aucun passage compté dans la nouvelle soirée');
  assert.deepEqual(journaled.filter(e => e.ev === 'turn.sent'), [], 'aucun envoi noté au journal de la nouvelle soirée');
  assert.equal(f.staffState().removalPending, 0, 'plus rien à retirer');
});
