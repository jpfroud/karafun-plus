'use strict';
// « Pas prêt » : une personne repousse son passage d'une ou plusieurs
// chansons sans perdre son tour. Demandes de duo sur le titre d'une autre
// personne : l'auteur garde son passage et accepte ou refuse.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');

let n = 1;
const song = () => ({ songId: n, title: `Titre ${n++}`, artist: 'Essai' });

function evening(names = [['1', 'Alice'], ['2', 'Bruno'], ['3', 'Chloé'], ['4', 'Driss']], opts = {}) {
  const s = new Scheduler(opts);
  const people = {};
  for (const [tableId, name] of names) {
    people[name] = s.table(tableId, false) ? s.join({ tableId, name }) : s.join({ tableId, name, headcount: 3 });
    s.chooseSong(people[name], song());
  }
  const names_ = view => view.map(item => item.ids.map(pid => s.people.get(pid).name).join(' & '));
  const sing = sel => { s.commit(sel); s.songEnded(sel.ids); return sel; };
  const first = () => s.presenceView().find(v => !v.future);
  const defer = (person, count = 1, extra = 0) => {
    const passage = s.presenceView().find(v => !v.future && v.ids.includes(person.id));
    return s.deferPassage(passage.ids[0], passage, count, { extra, by: person.id });
  };
  return { s, people, names: names_, sing, first, defer };
}

test('pas prêt : le passage laisse passer une chanson puis devient le prochain annoncé', () => {
  const { s, people, names, sing, first, defer } = evening();
  const order = names(s.presenceView());
  const [head, second, third] = order;
  const person = people[head];
  defer(person, 1);
  assert.deepEqual(names(s.presenceView()).slice(0, 3), [second, head, third], 'repoussé d’une seule place');
  assert.equal(s.deferralFor(person.id).remaining, 1);
  const next = s.select();
  assert.equal(names([next])[0], second, 'le suivant chante d’abord');
  sing(next);
  assert.equal(s.reservedNext?.personId, person.id, 'le passage reporté est annoncé juste après');
  assert.equal(s.deferralFor(person.id), null, 'le report est terminé');
  assert.equal(names([s.select()])[0], head, 'son tour est conservé');
  assert.ok(first());
});

test('pas prêt deux fois : deux chansons passent avant, et la prévision dit vrai', () => {
  const { s, people, names, sing, defer } = evening();
  const [head, second, third, fourth] = names(s.presenceView());
  defer(people[head], 1);
  defer(people[head], 1);
  assert.equal(s.deferralFor(people[head].id).total, 2);
  const forecast = names(s.presenceView());
  assert.deepEqual(forecast, [second, third, head, fourth]);
  const real = [];
  for (let i = 0; i < 4; i++) { const sel = s.select(); real.push(names([sel])[0]); sing(sel); }
  assert.deepEqual(real, forecast, 'l’ordre réel suit la prévision');
});

test('sans autre chanteur, le titre reporté attend « Je suis prêt » ou la fin du délai', () => {
  const { s, people, defer } = evening([['1', 'Alice']]);
  defer(people.Alice, 1);
  assert.equal(s.select(), null, 'rien ne part tant qu’Alice n’est pas prête');
  assert.equal(s.presenceView()[0].ids[0], people.Alice.id, 'la file montre encore son titre');
  s.cancelDeferral(people.Alice.id);
  assert.equal(s.select().ids[0], people.Alice.id, '« Je suis prêt » rend le titre envoyable');
  defer(people.Alice, 1);
  people.Alice.deferral.until = Date.now() - 1;
  assert.equal(s.select().ids[0], people.Alice.id, 'le report expire de lui-même');
});

test('un envoi en cours compte comme la chanson laissée passer seulement si on le demande', () => {
  const { s, people, names, sing, defer } = evening();
  const pendingSel = s.select();
  const pendingName = names([pendingSel])[0];
  const after = s.presenceView(pendingSel.consumedIds, pendingSel).filter(v => !v.future);
  const head = s.people.get(after[0].ids[0]);
  const second = names(after)[1];
  // Le serveur ajoute l'envoi déjà parti aux chansons à laisser passer.
  s.deferPassage(head.id, after[0], 1, { extra: 1 });
  assert.deepEqual(names(s.presenceView(pendingSel.consumedIds, pendingSel)).slice(0, 2), [second, head.name]);
  sing(pendingSel);
  assert.equal(s.deferralFor(head.id).remaining, 1, 'l’envoi déjà parti ne compte pas pour le report');
  assert.notEqual(s.reservedNext?.personId, head.id);
  const next = s.select();
  assert.equal(names([next])[0], second);
  sing(next);
  assert.equal(s.reservedNext?.personId, head.id);
  assert.ok(pendingName);
});

test('un passage annulé (titre retiré de KaraFun) rend son report', () => {
  const { s, people, names, defer } = evening();
  const [head, second] = names(s.presenceView());
  defer(people[head], 1);
  const sel = s.select();
  assert.equal(names([sel])[0], second);
  s.commit(sel);
  assert.equal(s.reservedNext?.personId, people[head].id);
  s.rollbackUnplayed(sel, { requeue: true });
  assert.equal(s.reservedNext, null, 'l’annonce faite après ce passage est retirée');
  assert.equal(s.deferralFor(people[head].id)?.remaining, 1, 'le report attend de nouveau une chanson');
});

test('duo : l’invité pas prêt retient le duo et ses propres titres', () => {
  const s = new Scheduler();
  const alice = s.join({ tableId: '1', name: 'Alice', headcount: 2 });
  const zoe = s.join({ tableId: '1', name: 'Zoé' });
  const bruno = s.join({ tableId: '2', name: 'Bruno', headcount: 1 });
  s.inviteDuet(alice, zoe.id, song());
  s.chooseSong(zoe, song());
  s.chooseSong(bruno, song());
  const duo = s.presenceView().find(v => v.ids.length === 2);
  s.deferPassage(duo.ids[0], duo, 1, { by: zoe.id });
  assert.deepEqual(s.deferralFor(zoe.id).ownerId, alice.id, 'le report de Zoé porte sur le duo d’Alice');
  const sel = s.select();
  assert.deepEqual(sel.ids, [bruno.id], 'ni le duo ni le titre de Zoé ne partent pendant le report');
  s.commit(sel);
  assert.equal(s.reservedNext?.personId, alice.id, 'le duo revient ensuite');
  assert.throws(() => s.cancelDeferral(zoe.id), /Aucun passage repoussé/, 'report terminé');
});

test('report : limites, titre remplacé et sauvegarde de soirée', () => {
  const { s, people, defer } = evening();
  const head = s.people.get(s.presenceView()[0].ids[0]);
  defer(head, 5);
  assert.throws(() => defer(head, 1), /plus de 5 chansons/);
  const access = new TableAccess();
  for (const id of s.tables.keys()) access.issue(id);
  const snapshot = snapshotNight({ scheduler: s, access,
    settings: { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 } });
  assert.equal(snapshot.scheduler.people.find(p => p.id === head.id).deferral.remaining, 5);
  const restored = new Scheduler();
  restoreNight(snapshot, { scheduler: restored, access: new TableAccess(), settings: {} });
  assert.equal(restored.deferralFor(head.id)?.remaining, 5, 'le report survit à un redémarrage');
  s.chooseSong(head, song(), 'replace');
  assert.equal(s.deferralFor(head.id), null, 'un titre remplacé repart sans report');
  assert.ok(people);
});

test('demande de duo : l’auteur du titre accepte, refuse ou reçoit un duo direct de sa table', () => {
  const s = new Scheduler();
  const alice = s.join({ tableId: '1', name: 'Alice', headcount: 2 });
  const marc = s.join({ tableId: '1', name: 'Marc' });
  const bruno = s.join({ tableId: '2', name: 'Bruno', headcount: 1 });
  const chloe = s.join({ tableId: '3', name: 'Chloé', headcount: 1 });
  s.chooseSong(alice, song());
  const entryId = alice.song.entryId;
  assert.equal(s.requestDuetJoin(bruno, alice.id, entryId).direct, false, 'autre table : accord nécessaire');
  assert.throws(() => s.requestDuetJoin(bruno, alice.id, entryId), /déjà envoyée/);
  s.requestDuetJoin(chloe, alice.id, entryId);
  assert.deepEqual(s.duetJoinRequestsFor(alice).map(r => r.fromName), ['Bruno', 'Chloé']);
  assert.deepEqual(s.duetJoinRequestsBy(bruno).map(r => r.ownerName), ['Alice']);
  s.answerDuetJoin(alice, entryId, chloe.id, false);
  assert.deepEqual(s.duetJoinRequestsFor(alice).map(r => r.fromName), ['Bruno'], 'refus : seule Chloé est écartée');
  s.answerDuetJoin(alice, entryId, bruno.id, true);
  assert.deepEqual(alice.song.duet, { partnerId: bruno.id, state: 'accepted' });
  assert.deepEqual(s.duetJoinRequestsFor(alice), [], 'les autres demandes sont closes');
  assert.throws(() => s.requestDuetJoin(chloe, alice.id, entryId), /déjà prévu en duo/);
  const sel = s.select();
  assert.deepEqual(sel.ids, [alice.id, bruno.id], 'Alice garde son passage, Bruno est son invité');
  assert.deepEqual(sel.consumedIds, [alice.id]);

  s.chooseSong(alice, song(), 'append');
  const other = alice.backlog.at(-1).entryId;
  assert.equal(s.requestDuetJoin(marc, alice.id, other).direct, true, 'même table : duo direct');
  assert.equal(alice.backlog.at(-1).duet.partnerId, marc.id);

  s.chooseSong(bruno, song());
  s.requestDuetJoin(chloe, bruno.id, bruno.song.entryId);
  s.cancelDuetJoin(chloe, bruno.id, bruno.song.entryId);
  assert.deepEqual(s.duetJoinRequestsFor(bruno), []);
  s.requestDuetJoin(chloe, bruno.id, bruno.song.entryId);
  s.leave(chloe);
  assert.deepEqual(s.duetJoinRequestsFor(bruno), [], 'une personne partie retire ses demandes');
  assert.throws(() => s.requestDuetJoin(alice, alice.id, entryId), /déjà ton titre/);
});

// ---------------------------------------------------------------- QA navigateur du 2026-10-03
// Found by /qa on 2026-10-03
// Report: .gstack/qa-reports/run-20261003T140104Z/qa-report-127.0.0.1-2026-10-03.md

// Regression: ISSUE-013 — deux « Pas prêt » croisés bloquaient la file : scène vide, rien n'était envoyé
test('deux « Pas prêt » croisés : scène libre, le premier passage repoussé part quand même', () => {
  const { s, people, names, sing, defer } = evening([['1', 'Chloé'], ['2', 'Bruno']]);
  const [head, second] = names(s.presenceView());
  defer(people[head], 1);
  defer(people[second], 1);
  assert.equal(s.select(), null, 'pendant un titre, rien ne part encore : chacun attend une autre chanson');
  const forecast = names(s.presenceView())[0];
  const logLen = s.log.length;
  const sel = s.select({ stageFree: true });
  assert.ok(sel, 'scène libre : un titre part, la scène ne reste pas vide');
  assert.equal(names([sel])[0], forecast, 'celui que la file annonçait en premier');
  assert.equal(s.deferralFor(sel.ids[0]), null, 'son report est levé');
  assert.ok(s.deferralFor(people[forecast === head ? second : head].id), 'l’autre report reste');
  assert.ok(s.log.slice(logLen).some(l => l.msg === `Personne d’autre ne peut chanter : le passage repoussé de ${forecast} part maintenant`),
    'le journal du bar l’explique');
  sing(sel);
  assert.equal(names([s.select({ stageFree: true })])[0], forecast === head ? second : head, 'l’autre passe ensuite');
});

test('« Pas prêt » seul : le passage repoussé part dès que la scène est libre, élision du journal', () => {
  const { s, people, defer } = evening([['1', 'Emma']]);
  defer(people.Emma, 1);
  assert.equal(s.select(), null);
  const sel = s.select({ stageFree: true });
  assert.equal(sel.ids[0], people.Emma.id);
  assert.equal(s.log.at(-1).msg, 'Personne d’autre ne peut chanter : le passage repoussé d’Emma part maintenant');
});
