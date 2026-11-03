'use strict';
// Gestes du bar (déplacement, « Priorité ») : ils ont la précédence sur le
// calcul. Demande du gérant après la soirée du 23 octobre : « tout
// changement manuel doit avoir la précédence sur le calcul ». Journal :
// 00:30:35 Elsa déplacé de 7 à 4, 00:31:49 Maud ajoute un 5e titre à sa
// liste, 00:32:26 le bar doit redéplacer Elsa de 6 à 4, puis encore à
// 00:35:47 ; chaque titre ajouté par quelqu'un d'autre effaçait le geste.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');
const { TimefoldBridge } = require('../solver/bridge');

const JAR = path.join(__dirname, '..', 'solver', 'target', 'karafun-solver.jar');
const NATIVE = 'a'.repeat(64); // file KaraFun inchangée
let songId = 1;
const song = () => ({ songId: songId++, title: `Titre ${songId}`, artist: 'Test' });

// Une personne par table, un titre chacune (Maud en a quatre), dans l'ordre
// des tables : la règle locale les fait passer dans cet ordre.
function evening(options = {}) {
  const s = new Scheduler(options);
  const access = new TableAccess();
  const names = ['Paulo', 'Maud', 'Gil', 'Hugo', 'Ines', 'Jade', 'Elsa', 'Karim'];
  const people = {};
  names.forEach((name, i) => {
    access.issue(String(i + 1));
    people[name] = s.join({ tableId: String(i + 1), name, headcount: 1 });
  });
  for (const name of names) {
    s.chooseSong(people[name], song(), 'append');
    if (name === 'Maud') for (let k = 0; k < 3; k++) s.chooseSong(people[name], song(), 'append');
  }
  return { s, access, people };
}

const names = (s, exclude = [], provisional = null) =>
  s.presenceView(exclude, provisional).filter(v => !v.future).map(v => v.name);

// Comme la route du bar (POST /api/staff/move) : le geste est noté.
// `exclude` : passage sur scène, hors de la prévision.
function gesture(s, person, toIndex, exclude = []) {
  const visible = s.presenceView(exclude).filter(v => !v.future);
  const from = visible.findIndex(v => v.ids[0] === person.id);
  const before = s.manualOverrideState({ deferrals: true });
  s.staffMove(person.id, toIndex, exclude);
  return s.recordManualChange({ kind: toIndex === 0 ? 'priority' : 'move', personId: person.id,
    name: person.name, from: from + 1, to: toIndex + 1, before, native: NATIVE });
}

// Le passage suivant part vers KaraFun puis est chanté.
function play(s) {
  const sel = s.select();
  assert.ok(sel, 'un passage doit partir');
  s.commit(sel);
  s.songEnded(sel.ids);
  return sel;
}

function saved(s, access) {
  for (const tableId of s.tables.keys()) if (!access.get(tableId)) access.issue(tableId);
  const settings = { auto: false, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 };
  return JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings })));
}

function restart(s, access, snapshot = saved(s, access)) {
  const resumed = new Scheduler(s.opts);
  resumed.warnings = restoreNight(snapshot, { scheduler: resumed, access: new TableAccess(), settings: {} }).warnings;
  return resumed;
}

// Qui monte sur scène : « Paulo & Gil » pour un duo.
const label = (s, sel) => sel.ids.map(pid => s.people.get(pid).name).join(' & ');
const playNames = (s, n) => Array.from({ length: n }, () => label(s, play(s)));

test('cas Elsa : déplacé en 4e place, il y reste quand d’autres ajoutent des titres, puis avance à chaque passage', () => {
  const { s, people } = evening();
  assert.equal(names(s).indexOf('Elsa'), 6, 'Elsa est 7e avant le geste du bar');
  gesture(s, people.Elsa, 3);
  assert.equal(names(s).indexOf('Elsa'), 3);
  s.chooseSong(people.Maud, song(), 'append'); // 00:31:49, un 5e titre pour Maud
  assert.equal(names(s).indexOf('Elsa'), 3, 'un titre ajouté par quelqu’un d’autre ne déplace pas Elsa');
  assert.equal(s.manualChanges.length, 1, 'le geste reste noté et annulable');
  play(s);
  assert.equal(names(s).indexOf('Elsa'), 2, 'un passage parti : Elsa passe de la 4e à la 3e place');
  s.chooseSong(people.Gil, song(), 'append');
  s.chooseSong(people.Karim, song(), 'replace');
  assert.equal(names(s).indexOf('Elsa'), 2, 'deux autres ajouts : Elsa reste 3e');
  play(s); play(s);
  assert.equal(names(s)[0], 'Elsa');
  assert.equal(play(s).ids[0], people.Elsa.id, 'Elsa chante à la place donnée par le bar');
  assert.deepEqual(s.manualOrder, [], 'parti vers KaraFun : plus rien de fixé');
  assert.equal(s.manualChanges.length, 0, 'le geste a abouti, il ne s’annule plus');
});

test('un nouvel arrivé ne passe pas devant une ligne placée par le bar', () => {
  const { s, people } = evening();
  for (let i = 0; i < 8; i++) play(s); // tout le monde a chanté une fois
  for (const name of ['Paulo', 'Gil', 'Hugo', 'Ines', 'Jade', 'Elsa', 'Karim']) s.chooseSong(people[name], song());
  const order = names(s);
  gesture(s, people.Elsa, 2);
  const placed = names(s);
  assert.equal(placed[2], 'Elsa');
  const newcomer = s.join({ tableId: '9', name: 'Zoé', headcount: 1 });
  s.chooseSong(newcomer, song());
  const after = names(s);
  assert.deepEqual(after.slice(0, 3), placed.slice(0, 3), 'les lignes jusqu’à Elsa ne bougent pas');
  assert.ok(after.indexOf('Zoé') > 2, `Zoé (premier passage) passe après Elsa : ${after.join(', ')}`);
  assert.ok(order.indexOf('Elsa') > 2, 'sans le geste, Elsa aurait attendu plus longtemps');
});

test('plusieurs gestes se cumulent, et chacun garde sa place quand l’autre part', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 3);
  gesture(s, people.Karim, 1);
  assert.deepEqual(names(s).slice(0, 5), ['Paulo', 'Karim', 'Maud', 'Gil', 'Elsa'],
    'Karim s’insère en 2e place : Elsa glisse d’une place, comme dans la liste du bar, et garde son geste');
  s.chooseSong(people.Hugo, song(), 'append');
  assert.equal(names(s).indexOf('Karim'), 1);
  assert.equal(names(s).indexOf('Elsa'), 4);
  // Karim part : Elsa garde son geste et avance d'une place.
  s.leave(people.Karim);
  assert.equal(names(s).indexOf('Elsa'), 3);
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa']);
});

test('annuler marche encore après un titre ajouté : seule la ligne du geste retourne au calcul', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 3);
  const karim = gesture(s, people.Karim, 1);
  s.chooseSong(people.Maud, song(), 'append');
  assert.equal(s.canUndoManualChange(NATIVE), false, 'la file a changé depuis');
  s.undoLastManualChange(karim.id, NATIVE);
  assert.equal(names(s).indexOf('Elsa'), 3, 'le geste plus ancien reste en vigueur');
  assert.equal(names(s).at(-1), 'Karim', 'Karim retrouve sa place calculée');
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa']);
  // Un changement dans KaraFun ne bloque pas non plus l'annulation.
  s.undoLastManualChange(null, 'b'.repeat(64));
  assert.equal(names(s).indexOf('Elsa'), 6, 'Elsa retrouve le calcul');
  assert.deepEqual(s.manualOrder, []);
});

test('annuler un redéplacement après un ajout rend la place du geste précédent, moins les passages partis', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 3);
  gesture(s, people.Elsa, 1);
  assert.equal(names(s).indexOf('Elsa'), 1);
  s.chooseSong(people.Karim, song(), 'append');
  play(s); // Paulo part
  s.undoLastManualChange(null, NATIVE);
  assert.equal(names(s).indexOf('Elsa'), 2, 'retour à la 4e place, moins le passage parti (3e)');
  assert.deepEqual(s.manualChanges.map(change => change.to), [4], 'le premier geste reste en vigueur');
  s.undoLastManualChange(null, NATIVE);
  assert.deepEqual(s.manualOrder, []);
});

// Relecture (passe 3, cellule sans test) : l'annulation recalculée
// (_undoRebased) rend le « Pas prêt » levé par le geste, moins les chansons
// passées depuis. Sans ce décompte, Ines attendait une chanson de plus que
// ce qu'elle avait demandé.
test('annuler après d’autres changements rend le « Pas prêt » levé, moins les chansons passées', () => {
  const { s, people } = evening();
  const line = s.presenceView().find(v => v.ids[0] === people.Ines.id);
  s.deferPassage(people.Ines.id, line, 3);
  gesture(s, people.Ines, 1); // le geste lève le report
  assert.equal(s.deferralFor(people.Ines.id), null);
  assert.equal(label(s, play(s)), 'Paulo'); // une chanson passe
  s.chooseSong(people.Paulo, song(), 'append'); // la file change : annulation recalculée
  assert.equal(s.canUndoManualChange(NATIVE), false);
  s.undoLastManualChange(null, NATIVE);
  assert.equal(s.deferralFor(people.Ines.id)?.remaining, 2, 'trois chansons demandées, une passée');
  assert.deepEqual(playNames(s, 3), ['Maud', 'Gil', 'Ines'], 'Ines laisse passer les deux chansons qui restent');
});

// Relecture (passe 7) : même annulation, report déjà écoulé. Le « Pas prêt »
// revenait à 0 et seul l'envoi suivant le libérait : Ines laissait passer une
// chanson de plus que demandé. Comme _commit au bout d'un report, elle devient
// la prochaine annoncée ; si quelqu'un l'est déjà, le report reste à 0 et le
// prochain envoi la libère.
test('annuler après d’autres changements, « Pas prêt » déjà écoulé : la personne est la prochaine', () => {
  const { s, people } = evening();
  const line = s.presenceView().find(v => v.ids[0] === people.Ines.id);
  s.deferPassage(people.Ines.id, line, 1);
  gesture(s, people.Ines, 2); // le geste lève le report
  assert.equal(label(s, play(s)), 'Paulo'); // la chanson demandée passe
  s.chooseSong(people.Paulo, song(), 'append'); // la file change : annulation recalculée
  s.undoLastManualChange(null, NATIVE);
  assert.equal(s.deferralFor(people.Ines.id), null, 'une chanson demandée, une passée : le report est fini');
  assert.equal(s.reservedNext?.personId, people.Ines.id);
  assert.deepEqual(playNames(s, 2), ['Ines', 'Maud'], 'Ines repasse aussitôt');
});

// Relecture (passe 8) : la même annulation quand la personne est déjà
// l'annoncée (le serveur annonce la ligne du geste pendant le titre suivant) :
// son report écoulé ne revient pas, elle reste annoncée. Il revenait à 0,
// select() libérait son annonce et une chanson de plus passait.
test('annuler après d’autres changements, « Pas prêt » écoulé et personne déjà annoncée : elle le reste', () => {
  const { s, people } = evening();
  const line = s.presenceView().find(v => v.ids[0] === people.Ines.id);
  s.deferPassage(people.Ines.id, line, 1);
  gesture(s, people.Ines, 1);
  assert.equal(label(s, play(s)), 'Paulo');
  assert.deepEqual(s.reserveNext().ids, [people.Ines.id], 'Ines annoncée pendant le titre suivant');
  s.chooseSong(people.Paulo, song(), 'append');
  s.undoLastManualChange(null, NATIVE);
  assert.equal(s.deferralFor(people.Ines.id), null);
  assert.equal(s.reservedNext?.personId, people.Ines.id, 'elle reste annoncée');
  assert.deepEqual(playNames(s, 1), ['Ines']);
});

// Relecture (passe 8) : quelqu'un d'autre est déjà annoncé : le report écoulé
// revient à 0 et l'envoi suivant libère la personne, juste après lui.
test('annuler après d’autres changements, « Pas prêt » écoulé et quelqu’un d’autre annoncé : elle passe juste après', () => {
  const { s, people } = evening();
  const line = s.presenceView().find(v => v.ids[0] === people.Ines.id);
  s.deferPassage(people.Ines.id, line, 1);
  gesture(s, people.Ines, 2);
  assert.equal(label(s, play(s)), 'Paulo');
  assert.deepEqual(s.reserveNext().ids, [people.Maud.id], 'Maud annoncée');
  s.chooseSong(people.Paulo, song(), 'append');
  s.undoLastManualChange(null, NATIVE);
  assert.equal(s.reservedNext?.personId, people.Maud.id, 'l’annonce de Maud tient');
  assert.equal(s.deferralFor(people.Ines.id)?.remaining, 0);
  assert.deepEqual(playNames(s, 2), ['Maud', 'Ines']);
});

// Relecture (passe 8) : l'annulation recalculée ne fait jamais repasser
// aussitôt quelqu'un qui vient de chanter. Le report écoulé d'Ines, dont le
// duo a été rejoint par Paulo juste après son titre, attend l'envoi suivant ;
// l'annonce d'avant une priorité, celle de Bob dont le titre est devenu un duo
// avec Ana qui vient de chanter, n'est pas rendue. Comme _commit et
// _duetOnAnnounced, la règle vaut pour la personne de la ligne et l'invitée de
// son duo.
test('annulation recalculée : personne ne repasse juste après avoir chanté, invitée d’un duo comprise', async t => {
  await t.test('report écoulé, duo rejoint par celui qui vient de chanter', () => {
    const { s, people } = evening();
    const { Ines, Paulo } = people;
    s.chooseSong(Paulo, song(), 'append');
    s.deferPassage(Ines.id, s.presenceView().find(v => v.ids[0] === Ines.id), 1);
    gesture(s, Ines, 2);
    const stage = play(s);
    assert.equal(label(s, stage), 'Paulo');
    s.openDuet(Ines, { entryId: Ines.song.entryId });
    s.acceptOpenDuet(Paulo, Ines.id, Ines.song.entryId);
    s.undoLastManualChange(null, NATIVE);
    assert.notEqual(s.reservedNext?.personId, Ines.id, 'le duo avec Paulo n’est pas annoncé juste après lui');
    const next = s.select();
    assert.ok(!next.ids.includes(Paulo.id), `Paulo ne rechante pas aussitôt (${label(s, next)})`);
  });
  await t.test('annonce d’avant une priorité, devenue un duo avec celle qui vient de chanter', () => {
    const s = new Scheduler(); s._event = () => {};
    const join = (table, name) => s.join({ tableId: table, name, headcount: 1 });
    const ana = join('1', 'Ana'), bob = join('2', 'Bob'), cid = join('3', 'Cid'), dan = join('4', 'Dan');
    [ana, bob, cid, dan].forEach(p => s.chooseSong(p, song()));
    const stage = s.select(); s.commit(stage);
    assert.deepEqual(stage.ids, [ana.id]);
    assert.deepEqual(s.reserveNext().ids, [bob.id], 'Bob annoncé, en solo');
    gesture(s, cid, 0, stage.ids);
    const duo = s.inviteDuet(bob, ana.id, song());
    s.answerDuet(ana, true, duo.entryId);
    s.reorderSongs(bob, duo.entryId, 0);
    s.undoLastManualChange(null, NATIVE, { excludeIds: stage.ids });
    assert.notEqual(s.reservedNext?.personId, bob.id, 'l’annonce de Bob, devenue un duo avec Ana, n’est pas rendue');
    s.songEnded(stage.ids);
    const next = s.select();
    assert.ok(!next.ids.includes(ana.id), `Ana ne rechante pas aussitôt (${label(s, next)})`);
  });
  // Relecture (passe 9) : chaque garde tient seule, dans l'état du serveur où
  // elle est la seule à jouer. Titre d'Ana commencé : sendingIds() est vide,
  // seul son dernier passage la retient.
  const fourTables = () => {
    const s = new Scheduler(); s._event = () => {};
    const join = (table, name) => s.join({ tableId: table, name, headcount: 1 });
    const people = [['1', 'Ana'], ['2', 'Bob'], ['3', 'Cid'], ['4', 'Dan']].map(([table, name]) => join(table, name));
    people.forEach(p => s.chooseSong(p, song()));
    return { s, ana: people[0], bob: people[1], cid: people[2] };
  };
  const duoWithAna = (s, bob, ana) => {
    const duo = s.inviteDuet(bob, ana.id, song());
    s.answerDuet(ana, true, duo.entryId);
    s.reorderSongs(bob, duo.entryId, 0);
  };
  await t.test('titre de celle qui vient de chanter commencé : aucun envoi en cours', () => {
    const { s, ana, bob, cid } = fourTables();
    const stage = s.select(); s.commit(stage);
    assert.deepEqual(s.reserveNext().ids, [bob.id]);
    gesture(s, cid, 0, stage.ids);
    duoWithAna(s, bob, ana);
    s.undoLastManualChange(null, NATIVE);
    assert.notEqual(s.reservedNext?.personId, bob.id, 'l’annonce de Bob & Ana n’est pas rendue');
    s.songEnded(stage.ids);
    const next = s.select();
    assert.ok(!next.ids.includes(ana.id), `Ana ne rechante pas aussitôt (${label(s, next)})`);
  });
  // Titre d'Ana en cours d'envoi, pas encore accusé par KaraFun : rien n'est
  // compté, seul excludeIds la retient.
  await t.test('titre de l’invitée en cours d’envoi, pas encore accusé', () => {
    const { s, ana, bob, cid } = fourTables();
    const sending = s.select();
    assert.deepEqual(sending.ids, [ana.id]);
    s.reservedNext = { personId: bob.id, reservedAt: Date.now() };
    gesture(s, cid, 0, sending.ids);
    duoWithAna(s, bob, ana);
    s.undoLastManualChange(null, NATIVE, { excludeIds: sending.ids });
    assert.notEqual(s.reservedNext?.personId, bob.id, 'l’annonce de Bob & Ana n’est pas rendue');
  });
  // Relecture (passe 10) : l'invitée a chanté depuis le geste, puis un autre
  // passage est parti : seul le décompte depuis le geste (sentSince) la
  // retient.
  await t.test('invitée montée sur scène depuis le geste, un autre passage depuis : l’annonce d’avant n’est pas rendue', () => {
    const s = new Scheduler(); s._event = () => {};
    const join = (table, name) => s.join({ tableId: table, name, headcount: 1 });
    const [dan, bob, ana, cid, eve, fay] = ['Dan', 'Bob', 'Ana', 'Cid', 'Eve', 'Fay'].map((x, i) => join(String(i + 1), x));
    [dan, bob, ana, cid, eve, fay].forEach(p => s.chooseSong(p, song()));
    const stage = s.select(); s.commit(stage);
    assert.deepEqual(s.reserveNext().ids, [bob.id]);
    gesture(s, fay, 4, stage.ids);
    s.removeSong(bob, bob.song.entryId);
    s.songEnded(stage.ids);
    assert.equal(label(s, play(s)), 'Ana');
    assert.equal(label(s, play(s)), 'Cid');
    const duo = s.inviteDuet(bob, ana.id, song()); s.answerDuet(ana, true, duo.entryId);
    s.undoLastManualChange(null, NATIVE);
    assert.notEqual(s.reservedNext?.personId, bob.id, 'Ana a chanté depuis le geste');
    const next = s.select();
    assert.ok(!next.ids.includes(ana.id), `Ana ne rechante pas aussitôt (${label(s, next)})`);
  });
});

// Relecture (passe 10, rejeu aléatoire) : la personne annoncée avant un
// geste du bar ne répond pas à « Je suis là » ; son titre passe et laisse
// passer le suivant. L'annulation recalculée du geste lui rendait l'annonce
// en gardant son titre passé : les téléphones l'annonçaient, la demande
// « Je suis là » et l'envoi allaient à quelqu'un d'autre.
test('annulation recalculée après un titre passé faute de « Je suis là » : l’annonce d’avant le geste n’est pas rendue', () => {
  const s = new Scheduler({ requirePresence: true, solverEnabled: false });
  const [ana, bob, cid, dan] = ['Ana', 'Bob', 'Cid', 'Dan'].map((name, i) => s.join({ tableId: String(i + 1), name, headcount: 1 }));
  [ana, bob, cid, dan].forEach(p => s.chooseSong(p, song()));
  s.reservePresenceNext([]);
  assert.equal(s.reservedNext?.personId, ana.id);
  gesture(s, dan, 1);
  s.skipUnconfirmed(ana.id, 3);
  for (const p of [ana, bob, dan]) s.confirm(p);
  assert.equal(s.canUndoManualChange(NATIVE), false, 'le titre passé a changé la file');
  s.undoLastManualChange(null, NATIVE);
  assert.notEqual(s.reservedNext?.personId, ana.id, 'son titre passé laisse passer le suivant, comme sans le geste');
  s.reservePresenceNext([]);
  const shown = s.presenceView().find(v => !v.future && v.song);
  assert.equal(s.reservedNext?.personId, shown.ids[0], 'l’annonce suit la file');
  assert.deepEqual(s.select({ stageFree: true })?.ids, shown.ids, 'le passage envoyé est celui que la file montre');
});

// Même règle au bout d'un « Pas prêt » levé par une priorité : Cid, sauté
// une première fois (la priorité prend fin), redevient le prochain annoncé
// après le passage d'Ana et ne répond toujours pas. L'annulation recalculée
// le faisait de nouveau annoncer, titre passé gardé ; son report revient à
// 0 et le prochain envoi le libère.
test('annulation recalculée d’une priorité, titre passé deux fois faute de « Je suis là » : la file et l’annonce s’accordent', () => {
  const s = new Scheduler({ requirePresence: true, solverEnabled: false });
  const [ana, bob, cid] = ['Ana', 'Bob', 'Cid'].map((name, i) => s.join({ tableId: String(i + 1), name, headcount: 1 }));
  [ana, bob, cid].forEach(p => s.chooseSong(p, song()));
  s.deferPassage(cid.id, s.presenceView().find(v => !v.future && v.ids[0] === cid.id), 1);
  gesture(s, cid, 0);
  s.reservePresenceNext([]); s.skipUnconfirmed(cid.id, 3);
  s.confirm(ana); s.reservePresenceNext([]);
  const sent = s.select({ stageFree: true });
  assert.deepEqual(sent.ids, [ana.id]);
  s.commit(sent); s.songEnded(sent.ids);
  assert.equal(s.reservedNext?.personId, cid.id, 'son titre passé revient juste après');
  s.reservePresenceNext([]); s.skipUnconfirmed(cid.id, 3);
  s.confirm(cid); s.confirm(bob);
  s.undoLastManualChange(null, NATIVE);
  assert.notEqual(s.reservedNext?.personId, cid.id, 'Cid n’est pas annoncé avec son titre passé');
  assert.equal(cid.deferral?.remaining, 0, 'le report levé par la priorité revient à 0');
  s.reservePresenceNext([]);
  const shown = s.presenceView().find(v => !v.future && v.song);
  assert.equal(s.reservedNext?.personId, shown.ids[0], 'l’annonce suit la file');
  assert.deepEqual(s.select({ stageFree: true })?.ids, shown.ids);
});

// Relecture (passe 12) : l'annulation recalculée rendait l'annonce d'avant
// le geste, une priorité du bar comprise, à une personne dont le « Pas prêt »
// a commencé depuis. Annoncée et retenue à la fois : un titre retiré de
// KaraFun pour cette priorité attendait derrière elle, et le journal le
// disait, jusqu'au balayage suivant qui la libérait.
test('annulation recalculée après le « Pas prêt » de la personne de la priorité : la priorité ne lui revient pas', () => {
  const s = new Scheduler({ solverEnabled: false });
  const [ana, bob, cid, dan] = ['Ana', 'Bob', 'Cid', 'Dan'].map((name, i) => s.join({ tableId: String(i + 1), name, headcount: 1 }));
  [ana, bob, cid, dan].forEach(p => s.chooseSong(p, song()));
  gesture(s, dan, 0);
  gesture(s, cid, 2);
  assert.equal(s.reservedNext?.byStaff, true);
  s.deferPassage(dan.id, s.presenceView().find(v => !v.future && v.ids[0] === dan.id), 1);
  assert.equal(s.canUndoManualChange(NATIVE), false, 'le « Pas prêt » a changé la file');
  s.undoLastManualChange(null, NATIVE);
  assert.ok(s.isDeferred(dan), 'son « Pas prêt » tient');
  assert.notEqual(s.reservedNext?.personId, dan.id, 'la priorité d’avant le geste ne revient pas à une personne pas prête');
});

// Hors priorité du bar, même règle pour un duo dont l'invitée a son propre
// « Pas prêt » (_announcedGuestHeld).
test('annulation recalculée : l’annonce d’avant le geste ne revient pas à un duo dont l’invitée n’est pas prête', () => {
  const s = new Scheduler({ solverEnabled: false }); s._event = () => {};
  const [ana, bob, cid, dan] = ['Ana', 'Bob', 'Cid', 'Dan'].map((name, i) => s.join({ tableId: String(i + 1), name, headcount: 1 }));
  [ana, bob, cid, dan].forEach(p => s.chooseSong(p, song()));
  const stage = s.select(); s.commit(stage);
  assert.deepEqual(s.reserveNext().ids, [bob.id], 'Bob annoncé, en solo');
  gesture(s, dan, 0, stage.ids);
  const duo = s.inviteDuet(bob, cid.id, song()); s.answerDuet(cid, true, duo.entryId);
  s.reorderSongs(bob, duo.entryId, 0);
  s.deferPassage(cid.id, s.presenceView(stage.ids).find(v => !v.future && v.ids[0] === cid.id), 1);
  s.undoLastManualChange(null, NATIVE, { excludeIds: stage.ids });
  assert.notEqual(s.reservedNext?.personId, bob.id, 'le duo de Bob, retenu par le « Pas prêt » de Cid, n’est pas annoncé');
});

// Relecture (passe 13, cellule sans test) : une priorité du bar, elle, passe
// outre le « Pas prêt » de l'invitée (_heldFor) ; l'annulation recalculée la
// rend au duo.
test('annulation recalculée : la priorité du bar d’avant le geste revient à un duo dont l’invitée n’est pas prête', () => {
  const s = new Scheduler({ solverEnabled: false }); s._event = () => {};
  const [ana, bob, cid, dan, eve] = ['Ana', 'Bob', 'Cid', 'Dan', 'Eve'].map((name, i) => s.join({ tableId: String(i + 1), name, headcount: 1 }));
  [ana, bob, cid, dan, eve].forEach(p => s.chooseSong(p, song()));
  const duo = s.inviteDuet(bob, cid.id, song()); s.answerDuet(cid, true, duo.entryId);
  s.reorderSongs(bob, duo.entryId, 0);
  gesture(s, bob, 0);
  gesture(s, eve, 0);
  s.deferPassage(cid.id, s.presenceView().find(v => !v.future && v.ids[0] === cid.id), 1);
  s.undoLastManualChange(null, NATIVE);
  assert.equal(s.reservedNext?.personId, bob.id);
  assert.equal(s.reservedNext?.byStaff, true, 'la priorité du bar tient, l’invitée part avec le duo');
  assert.deepEqual(s.select().ids, [bob.id, cid.id]);
});

// Même famille : le report levé par le geste revient à une personne devenue
// entre-temps la prochaine annoncée ; l'annonce est libérée, comme pour un
// « Pas prêt » (deferPassage), au lieu de rester affichée jusqu'à l'envoi.
test('annulation recalculée qui rend un « Pas prêt » à la personne annoncée depuis : l’annonce est libérée', () => {
  const s = new Scheduler({ solverEnabled: false });
  const [ana, bob, cid, dan] = ['Ana', 'Bob', 'Cid', 'Dan'].map((name, i) => s.join({ tableId: String(i + 1), name, headcount: 1 }));
  [ana, bob, cid, dan].forEach(p => s.chooseSong(p, song()));
  s.deferPassage(cid.id, s.presenceView().find(v => !v.future && v.ids[0] === cid.id), 2);
  gesture(s, cid, 1);
  assert.equal(label(s, play(s)), 'Ana');
  s.reserveNext();
  assert.equal(s.reservedNext?.personId, cid.id, 'Cid annoncé après Ana');
  s.undoLastManualChange(null, NATIVE);
  assert.equal(cid.deferral?.remaining, 1, 'son report revient, moins la chanson passée');
  assert.notEqual(s.reservedNext?.personId, cid.id, 'retenu par son report, Cid n’est plus annoncé');
  const shown = s.presenceView().find(v => !v.future);
  assert.deepEqual(s.select().ids, shown.ids);
});

// Relecture (passe 9, cellule sans test) : une priorité du bar avait levé un
// « Pas prêt » ; sans réponse à « Je suis là » la priorité a pris fin, un
// passage est parti et la file annonce de nouveau la personne. L'annulation
// recalculée ne lui rend ni report à 0 ni chanson de plus : elle reste la
// prochaine.
test('annulation recalculée d’une priorité qui avait levé un « Pas prêt » écoulé : la personne reste la prochaine', () => {
  const { s, people } = evening({ requirePresence: true });
  const { Ines } = people;
  const line = s.presenceView().find(v => v.ids[0] === Ines.id);
  s.deferPassage(Ines.id, line, 1);
  gesture(s, Ines, 0);
  assert.equal(s.reservedNext?.personId, Ines.id);
  s.reservePresenceNext();
  s.skipUnconfirmed(Ines.id, 3);
  assert.equal(s.reservedNext, null, 'sans réponse, la priorité prend fin');
  const asked = s.reservePresenceNext();
  s.confirm(s.people.get(asked.ids[0]));
  const sel = s.select(); s.commit(sel); s.songEnded(sel.ids);
  s.reservePresenceNext();
  assert.equal(s.reservedNext?.personId, Ines.id, 'la file l’annonce de nouveau');
  s.chooseSong(people.Paulo, song(), 'append');
  s.undoLastManualChange(null, NATIVE);
  assert.equal(s.reservedNext?.personId, Ines.id, 'elle reste la prochaine');
  assert.equal(s.deferralFor(Ines.id), null, 'aucun report ne revient');
});

// Relecture (passe 13, cellules sans test) : une priorité du bar, donnée
// pendant l'envoi d'un titre, avait levé un « Pas prêt » de trois chansons ;
// ce titre passe, la file change, le bar annule. Le report revient moins la
// chanson passée, et la personne, retenue, n'est pas annoncée. Et une ligne fixée par le bar, annoncée par
// la file, dont le titre en cours redevient celui de son « Pas prêt » : son
// annonce est libérée, sa ligne garde sa place (_duetOnAnnounced).
test('annulation recalculée d’une priorité qui avait levé un « Pas prêt » encore en cours : le report revient, sans annonce', () => {
  const { s, people } = evening();
  const { Ines } = people;
  s.deferPassage(Ines.id, s.presenceView().find(v => v.ids[0] === Ines.id), 3);
  const sending = s.select(); // envoi de Paulo en cours
  gesture(s, Ines, 0, sending.ids);
  assert.equal(s.reservedNext?.personId, Ines.id);
  assert.equal(s.reservedNext.byStaff, true);
  s.commit(sending); s.songEnded(sending.ids); // KaraFun accuse l'envoi : une chanson passe
  assert.equal(label(s, sending), 'Paulo');
  s.chooseSong(people.Paulo, song(), 'append');
  s.undoLastManualChange(null, NATIVE);
  assert.equal(s.deferralFor(Ines.id)?.remaining, 2, 'son report revient, moins la chanson passée');
  assert.notEqual(s.reservedNext?.personId, Ines.id, 'retenue par son report, elle n’est pas annoncée');
  const shown = s.presenceView().find(v => !v.future);
  assert.deepEqual(s.select().ids, shown.ids);
});

test('ligne fixée annoncée dont le titre en cours redevient celui de son « Pas prêt » : l’annonce est libérée, la ligne garde sa place', () => {
  const s = new Scheduler({ solverEnabled: false });
  const [ana, bob, cid, dan] = ['Ana', 'Bob', 'Cid', 'Dan'].map((name, i) => s.join({ tableId: String(i + 1), name, headcount: 1 }));
  [ana, bob, cid, dan].forEach(p => s.chooseSong(p, song()));
  s.chooseSong(bob, song(), 'append');
  const stage = s.select(); s.commit(stage);
  s.deferPassage(bob.id, s.presenceView(stage.ids).find(v => !v.future && v.ids[0] === bob.id), 1);
  s.reorderSongs(bob, bob.backlog[0].entryId, 0);
  gesture(s, dan, 2, stage.ids);
  assert.ok(s.manualOrder.includes(bob.id), 'la ligne de Bob est fixée par le geste');
  s.reservedNext = { personId: bob.id, reservedAt: Date.now() };
  s.staffRemove(bob.id);
  assert.equal(s.isDeferred(bob), true, 'le titre reporté redevient son titre en cours');
  assert.notEqual(s.reservedNext?.personId, bob.id, 'retenu par son report, Bob n’est plus annoncé');
  assert.ok(s.manualOrder.includes(bob.id), 'sa ligne garde sa place');
});

test('annuler tout après d’autres changements rend toutes les lignes au calcul', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 3);
  gesture(s, people.Karim, 0);
  s.chooseSong(s.join({ tableId: '9', name: 'Zoé', headcount: 1 }), song());
  play(s);
  assert.equal(s.manualChanges.length, 1, 'la priorité de Karim est partie, le geste de Elsa reste');
  assert.equal(s.undoAllManualChanges('c'.repeat(64)), 1);
  assert.deepEqual(s.manualOrder, []);
  assert.equal(s.reservedNext?.byStaff, undefined);
});

test('une priorité reste la prochaine après un ajout, une arrivée et un redémarrage', () => {
  const { s, access, people } = evening();
  gesture(s, people.Karim, 0);
  s.chooseSong(people.Maud, song(), 'append');
  s.chooseSong(s.join({ tableId: '9', name: 'Zoé', headcount: 1 }), song());
  assert.equal(names(s)[0], 'Karim');
  const resumed = restart(s, access);
  assert.equal(resumed.reservedNext?.byStaff, true);
  assert.equal(names(resumed)[0], 'Karim', 'la priorité survit au redémarrage');
  resumed.chooseSong(resumed.people.get(people.Paulo.id), song(), 'append');
  assert.equal(resumed.select().ids[0], people.Karim.id);
});

test('redémarrage : la ligne placée et son geste survivent et tiennent encore', () => {
  const { s, access, people } = evening();
  gesture(s, people.Elsa, 3);
  const resumed = restart(s, access);
  assert.equal(resumed.manualChanges.length, 1, 'le geste survit au redémarrage');
  assert.equal(names(resumed).indexOf('Elsa'), 3);
  resumed.chooseSong(resumed.people.get(people.Maud.id), song(), 'append');
  resumed.chooseSong(resumed.join({ tableId: '9', name: 'Zoé', headcount: 1 }), song());
  assert.equal(names(resumed).indexOf('Elsa'), 3, 'après la reprise, un ajout ne déplace pas Elsa');
  resumed.undoLastManualChange(null, NATIVE);
  assert.ok(names(resumed).indexOf('Elsa') >= 6, 'annulé après la reprise, Elsa retrouve sa place calculée');
  assert.deepEqual(resumed.manualOrder, []);
});

test('mode de rotation, duo, « Pas prêt » d’un autre et titre retiré : la ligne placée tient', () => {
  for (const options of [{ tableRotation: false }, { tableRotation: true }, { tableRotation: true, weightedTables: true }]) {
    const { s, people } = evening(options);
    gesture(s, people.Elsa, 3);
    const at = () => names(s).indexOf('Elsa');
    s.opts.tableRotation = !s.opts.tableRotation;
    assert.equal(at(), 3, 'changer de mode de rotation');
    const duo = s.inviteDuet(people.Karim, people.Jade.id, song());
    s.answerDuet(people.Jade, true, duo.entryId);
    assert.equal(at(), 3, 'un duo accepté');
    const head = s.presenceView().find(v => !v.future);
    s.deferPassage(head.ids[0], head, 1);
    assert.equal(at(), 3, '« Pas prêt » de la première personne');
    s.removeSong(people.Gil, people.Gil.song.entryId);
    assert.equal(at(), 2, 'une ligne au-dessus disparaît : Elsa avance');
  }
});

test('duo ouvert proposé puis rejoint : la ligne placée tient, en « Duos uniquement » aussi', () => {
  for (const duoOnly of [false, true]) {
    const { s, people } = evening();
    s.duoOnlyRule = () => duoOnly;
    gesture(s, people.Elsa, 3);
    const at = () => names(s).indexOf('Elsa');
    const open = s.openDuet(people.Karim, { song: song() });
    assert.equal(at(), 3, 'un autre propose un duo ouvert');
    s.acceptOpenDuet(people.Paulo, people.Karim.id, open.entryId);
    assert.equal(at(), 3, 'quelqu’un rejoint ce duo ouvert');
    assert.equal(s.manualChanges.length, 1, 'le geste reste annulable');
  }
});

// Chaque personne d'un geste noté garde une ligne dans l'ordre fixé.
const gesturesHold = s => s.manualChanges.every(change => s.manualOrder.includes(change.personId));

// Relecture : un geste du bar reconstruisait l'ordre fixé à partir des seules
// lignes affichées. En « Duos uniquement », la ligne placée d'une personne
// dont le titre devient un duo ouvert (retenu hors de la file) en sortait,
// alors que son geste restait noté et annulable : rejoint, le duo passait en
// fin de file au lieu de reprendre la place donnée par le bar.
test('duo ouvert retenu en « Duos uniquement » : un autre geste du bar ne fait pas perdre sa place à la ligne placée', () => {
  for (const [kind, to, shown] of [['déplacement', 3, ['Paulo', 'Elsa & Gil', 'Maud', 'Karim']],
    ['priorité', 0, ['Karim', 'Paulo', 'Elsa & Gil', 'Maud']]]) {
    const { s, people } = evening();
    s.duoOnlyRule = () => true;
    gesture(s, people.Elsa, 1); // Paulo, Elsa
    s.openDuet(people.Elsa, { entryId: people.Elsa.song.entryId });
    assert.ok(!names(s).includes('Elsa'), 'son duo ouvert attend un volontaire hors de la file');
    gesture(s, people.Karim, to);
    assert.ok(s.manualOrder.includes(people.Elsa.id), `${kind} : sa ligne reste dans l’ordre fixé`);
    assert.ok(gesturesHold(s), `${kind} : chaque geste noté garde sa ligne`);
    s.acceptOpenDuet(people.Gil, people.Elsa.id, people.Elsa.song.entryId);
    assert.deepEqual(names(s).slice(0, 4), shown, `${kind} : rejoint, le duo reprend la place donnée par le bar`);
    assert.deepEqual(playNames(s, shown.indexOf('Elsa & Gil') + 1), shown.slice(0, shown.indexOf('Elsa & Gil') + 1), kind);
  }
});

// Relecture : la priorité du bar sur un duo ouvert retenu en « Duos
// uniquement » était annoncée « levée » au bar, alors que seule l'annonce du
// prochain l'était : le geste restait noté et annulable, sa ligne en tête de
// l'ordre fixé, et le duo passait le premier une fois rejoint. Le journal dit
// maintenant ce qui reste.
test('priorité du bar sur un duo ouvert retenu en « Duos uniquement » : en attente, elle reprend au volontaire', () => {
  const { s, people } = evening();
  const { Elsa, Gil } = people;
  let duoOnly = false;
  s.duoOnlyRule = () => duoOnly;
  s.openDuet(Elsa, { entryId: Elsa.song.entryId });
  gesture(s, Elsa, 0);
  duoOnly = true;
  assert.equal(label(s, play(s)), 'Paulo', 'le duo ouvert sans partenaire ne part pas');
  assert.notEqual(s.reservedNext?.personId, Elsa.id, 'Elsa n’est plus annoncée');
  assert.equal(s.log.find(line => line.kind === 'staff' && /^Priorité (de|levée pour) Elsa/.test(line.msg))?.msg,
    `Priorité de Elsa en attente : en « Duos uniquement », son duo ouvert « ${Elsa.song.title} » attend un volontaire hors de la file et repasse en tête dès que quelqu’un le rejoint`);
  assert.deepEqual(s.manualChanges.map(change => `${change.kind} ${change.name}`), ['priority Elsa'], 'le geste reste noté et annulable');
  assert.equal(s.manualOrder[0], Elsa.id, 'sa ligne reste en tête de l’ordre fixé');
  s.acceptOpenDuet(Gil, Elsa.id, Elsa.song.entryId);
  assert.equal(names(s)[0], 'Elsa & Gil');
  assert.equal(label(s, play(s)), 'Elsa & Gil', 'rejoint, le duo passe le premier, comme le journal l’a dit');
});

// Relecture : la ligne placée d'une personne sous « Pas prêt » était rangée à
// la place où son report l'affiche, et la ligne non placée devant laquelle
// elle s'y trouvait devenait fixée : prête, elle passait après elle.
test('ligne placée sous « Pas prêt » : un autre geste du bar la garde à son rang', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 1); // Paulo, Elsa
  const line = s.presenceView().find(v => v.ids[0] === people.Elsa.id);
  s.deferPassage(people.Elsa.id, line, 2);
  gesture(s, people.Jade, 0);
  assert.deepEqual(s.manualOrder.map(pid => s.people.get(pid).name), ['Jade', 'Paulo', 'Elsa'],
    'Maud, que le bar n’a pas placée, ne devient pas fixée');
  assert.deepEqual(names(s).slice(0, 4), ['Jade', 'Paulo', 'Elsa', 'Maud'], 'reportée de deux chansons : Jade, Paulo, puis Elsa');
  s.cancelDeferral(people.Elsa.id);
  assert.deepEqual(names(s).slice(0, 4), ['Jade', 'Paulo', 'Elsa', 'Maud'], 'prête : juste derrière Paulo, comme le bar l’a placée');
});

test('la place donnée par le bar suit la personne : titre remplacé ou réordonné, liste vidée', () => {
  const { s, people } = evening();
  gesture(s, people.Maud, 3);
  assert.equal(names(s).indexOf('Maud'), 3);
  s.reorderSongs(people.Maud, people.Maud.backlog[1].entryId, 0);
  s.chooseSong(people.Maud, song(), 'append');
  assert.equal(names(s).indexOf('Maud'), 3, 'sa liste réordonnée garde sa place');
  s.removeSong(people.Maud, people.Maud.song.entryId);
  assert.equal(names(s).indexOf('Maud'), 3, 'le titre suivant de sa liste prend la place');
  for (const entry of s.songsOf(people.Maud).map(item => item.entryId)) s.removeSong(people.Maud, entry);
  assert.deepEqual(s.manualChanges, [], 'liste vide : le geste tombe');
  assert.deepEqual(s.manualOrder, []);
});

test('« Je suis là » : une priorité du bar pour la personne encore sur scène tient jusqu’à sa sortie', () => {
  const { s, people } = evening({ requirePresence: true });
  s.chooseSong(people.Paulo, song(), 'append');
  const head = s.reservePresenceNext();
  assert.equal(head.ids[0], people.Paulo.id);
  s.confirm(people.Paulo);
  const sent = s.select();
  s.commit(sent); // Paulo est sur scène, son 2e titre attend
  gesture(s, people.Paulo, 0);
  assert.equal(s.reservedNext?.byStaff, true);
  s.reservePresenceNext([people.Paulo.id]); // balayage pendant sa chanson
  assert.equal(s.reservedNext?.personId, people.Paulo.id, 'personne d’autre n’est annoncé à sa place');
  s.songEnded(sent.ids);
  assert.equal(s.reservePresenceNext([]).ids[0], people.Paulo.id);
  s.confirm(people.Paulo);
  assert.equal(s.select().ids[0], people.Paulo.id);
});

// Décision du gérant du 26 octobre : « si je place quelqu'un, mais que pour
// une raison ou une autre il passe devant son propre passage que j'ai
// positionné, alors il faut le recalculer ». Avant, la priorité tenait et
// Karim rechantait juste après son duo improvisé.
test('duo noté au bar avec la personne prioritaire : sa priorité prend fin, les autres gestes restent', () => {
  const { s, people } = evening();
  const sent = s.select();
  s.commit(sent); // Paulo sur scène
  gesture(s, people.Elsa, 3); // Maud, Gil, Hugo, Elsa
  gesture(s, people.Karim, 0);
  s.staffCountPartner(sent.ids[0], people.Karim.id, sent); // Karim chante avec Paulo
  assert.equal(s.reservedNext, null, 'Karim n’est plus annoncé juste après son duo');
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa'],
    'la priorité de Karim n’est plus annulable ; le déplacement de Elsa reste');
  assert.ok(!s.manualOrder.includes(people.Karim.id));
  const ended = s.log.find(line => line.msg === 'Karim chante avant sa priorité : sa ligne retrouve le calcul');
  assert.equal(ended?.kind, 'staff', 'le journal du bar le dit');
  assert.match(s.log.at(-1).msg, /Karim garde son titre mais attend deux autres chansons si possible$/);
  s.songEnded(sent.ids);
  assert.deepEqual(names(s), ['Maud', 'Gil', 'Hugo', 'Elsa', 'Ines', 'Jade', 'Karim'],
    'Elsa garde sa place ; Karim attend les premiers passages des autres');
  assert.notEqual(s.select().ids[0], people.Karim.id);
});

// Relecture (passe 3) : une place cédée (giveSpot) met fin au geste de la
// personne qui la cède, mais sa priorité du bar restait : elle partait quand
// même la prochaine, sans geste à annuler, même après « Recalculer la file ».
test('place cédée par la personne prioritaire : sa priorité tombe avec son geste', () => {
  const { s, people } = evening();
  s.setHeadcount('5', 2);
  const bea = s.join({ tableId: '5', name: 'Bea' });
  gesture(s, people.Gil, 3);
  gesture(s, people.Ines, 0);
  assert.equal(s.reservedNext?.personId, people.Ines.id);
  s.giveSpot(people.Ines, bea.id);
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Gil'], 'seul le geste de Ines prend fin');
  assert.notEqual(s.reservedNext?.byStaff, true, 'aucune priorité sans geste annulable');
  assert.notEqual(s.select().ids[0], people.Ines.id, 'Ines, qui a cédé sa place, ne part pas la prochaine');
  assert.equal(s.undoAllManualChanges(NATIVE), 1);
  assert.equal(s.reservedNext, null, '« Recalculer la file » ne laisse aucune priorité');
});

// Relecture (passe 4) : même règle quand le bar annule ensuite un geste plus
// ancien hors de l'état exact (_undoRebased). Son état d'avant annonce la
// personne prioritaire ; une priorité du bar n'en revient que si sa ligne est
// encore fixée. Sinon Ines, qui a cédé sa place, repartait la prochaine, sans
// geste à annuler.
test('priorité puis déplacement, place cédée par la personne prioritaire, annulation du déplacement : aucune priorité sans geste', () => {
  const { s, people } = evening();
  s.setHeadcount('5', 2);
  const bea = s.join({ tableId: '5', name: 'Bea' });
  gesture(s, people.Ines, 0);
  gesture(s, people.Elsa, 3); // son état d'avant annonce Ines, priorité du bar
  s.giveSpot(people.Ines, bea.id);
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa']);
  s.chooseSong(people.Maud, song(), 'append'); // annulation hors de l'état exact
  s.undoLastManualChange(null, NATIVE);
  assert.deepEqual(s.manualChanges, []);
  assert.notEqual(s.reservedNext?.byStaff, true, 'Ines a cédé sa place : sa priorité ne revient pas');
  assert.notEqual(s.select().ids[0], people.Ines.id);
});

// Relecture (passe 3, cellule sans test) : giveSpot ne met fin qu'aux gestes
// des deux personnes qui échangent leur place ; les autres gestes du bar restent.
test('place cédée par une personne placée par le bar : son geste prend fin, les autres restent', () => {
  const { s, people } = evening();
  s.setHeadcount('7', 2);
  const zoe = s.join({ tableId: '7', name: 'Zoé' });
  gesture(s, people.Elsa, 3);
  gesture(s, people.Karim, 1); // Paulo, Karim, Maud, Gil, Elsa
  s.giveSpot(people.Elsa, zoe.id);
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Karim']);
  assert.ok(!s.manualOrder.includes(people.Elsa.id), 'la place cédée retrouve le calcul');
  assert.deepEqual(fixed(s), ['Paulo', 'Karim']);
  assert.equal(names(s).indexOf('Karim'), 1, 'Karim garde la place donnée par le bar');
});

// Relecture de la correction : une table partie pendant des gestes du bar
// rendait la sauvegarde impossible à reprendre (« changement manuel mal
// formé ») ; l'application ne redémarrait plus et la soirée était perdue.
test('table partie pendant des gestes : la soirée se reprend, les gestes tiennent et s’annulent', () => {
  {
    const { s, access, people } = evening();
    gesture(s, people.Elsa, 3); // ordre fixé : Paulo, Maud, Gil, Elsa
    gesture(s, people.Karim, 5); // son état d'avant nomme Maud
    s.tableLeft('2'); // Maud, sur une ligne gardée devant Elsa
    const resumed = restart(s, access);
    assert.deepEqual(resumed.warnings, []);
    assert.equal(resumed.manualChanges.length, 2, 'les deux gestes survivent');
    assert.equal(names(resumed).indexOf('Elsa'), 2, 'Elsa avance d’une place et la garde');
    assert.equal(names(resumed).indexOf('Karim'), 4);
    resumed.chooseSong(resumed.people.get(people.Paulo.id), song(), 'append');
    resumed.undoLastManualChange(null, NATIVE);
    assert.equal(names(resumed).indexOf('Elsa'), 2, 'Karim annulé, Elsa garde sa place');
    assert.ok(names(resumed).indexOf('Karim') > 2);
    resumed.undoLastManualChange(null, NATIVE);
    assert.deepEqual(resumed.manualOrder, []);
  }
  {
    const { s, access, people } = evening();
    s.reserveNext();
    assert.equal(s.reservedNext.personId, people.Paulo.id);
    gesture(s, people.Elsa, 3); // état d'avant : Paulo prochain annoncé
    s.tableLeft('1');
    const resumed = restart(s, access);
    assert.equal(names(resumed).indexOf('Elsa'), 2);
    resumed.undoLastManualChange(null, NATIVE);
    assert.notEqual(resumed.reservedNext?.personId, people.Paulo.id, 'Paulo, parti, n’est pas rendu comme prochain');
    assert.deepEqual(resumed.manualOrder, []);
  }
});

test('ancienne sauvegarde qui nomme une personne supprimée dans un geste : reprise avec un avertissement', () => {
  const { s, access, people } = evening();
  gesture(s, people.Elsa, 3);
  const snapshot = saved(s, access);
  // Comme une sauvegarde de la version précédente, qui n'oubliait pas la
  // personne supprimée dans l'état d'avant du geste.
  const before = snapshot.scheduler.manualChanges[0].before;
  before.manualOrder.push('0123456789ab');
  before.reservedNext = { personId: '0123456789ab', reservedAt: Date.now() };
  const resumed = restart(s, access, snapshot);
  assert.deepEqual(resumed.warnings, ['2 mentions d’une personne supprimée oubliées dans les changements manuels du bar']);
  assert.equal(names(resumed).indexOf('Elsa'), 3, 'le geste tient');
  resumed.chooseSong(resumed.people.get(people.Maud.id), song(), 'append');
  resumed.undoLastManualChange(null, NATIVE);
  assert.deepEqual(resumed.manualOrder, []);
  assert.equal(resumed.reservedNext, null);
});

// Relecture de la correction : une ligne gardée devant un geste sans être
// placée par le bar ne doit faire chanter personne deux fois avant les
// premiers passages des autres, ni deux fois de suite (CONTEXTE-REPRISE.md).
test('duo formé sur une ligne gardée devant un geste : l’invitée ne rechante pas avant les premiers passages', () => {
  for (const how of ['invitation acceptée', 'titre suivant devenu le titre en cours']) {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    const duo = s.inviteDuet(people.Paulo, people.Gil.id, song());
    if (how === 'invitation acceptée') s.reorderSongs(people.Paulo, duo.entryId, 0);
    s.answerDuet(people.Gil, true, duo.entryId);
    if (how !== 'invitation acceptée') s.removeSong(people.Paulo, s.songsOf(people.Paulo).find(item => item !== duo).entryId);
    assert.deepEqual(names(s).slice(0, 3), ['Paulo & Gil', 'Maud', 'Elsa'], `${how} : Gil quitte l’ordre gardé, Elsa avance`);
    assert.deepEqual(playNames(s, 5), ['Paulo & Gil', 'Maud', 'Elsa', 'Hugo', 'Ines'], how);
  }
  // Le duo d'une ligne placée par le bar : la propre ligne de l'invitée, plus
  // haut, quitte l'ordre gardé ; elle chante avec ce duo.
  const { s, people } = evening();
  gesture(s, people.Elsa, 3);
  const duo = s.inviteDuet(people.Elsa, people.Gil.id, song());
  s.reorderSongs(people.Elsa, duo.entryId, 0);
  s.answerDuet(people.Gil, true, duo.entryId);
  assert.deepEqual(playNames(s, 4), ['Paulo', 'Maud', 'Elsa & Gil', 'Hugo']);
});

test('duo formé sur une ligne gardée avec quelqu’un qui vient de chanter : le duo repasse par le calcul', () => {
  const { s, people } = evening();
  assert.equal(label(s, play(s)), 'Paulo');
  gesture(s, people.Elsa, 3); // Maud, Gil, Hugo, Elsa
  const duo = s.inviteDuet(people.Maud, people.Paulo.id, song());
  s.reorderSongs(people.Maud, duo.entryId, 0);
  s.answerDuet(people.Paulo, true, duo.entryId);
  assert.ok(!s.manualOrder.includes(people.Maud.id), 'le duo n’est plus gardé devant Elsa');
  assert.deepEqual(playNames(s, 3), ['Gil', 'Hugo', 'Elsa'], 'Paulo ne rechante pas tout de suite ; Elsa avance d’une place');
});

// Relecture (passe 3) : les deux autres gardes de _guestJoined n'avaient pas
// de test, le cas ci-dessus étant déjà pris par « invitée déjà entendue,
// auteur jamais passé ». Après le premier tour, tout le monde a chanté.
test('duo formé sur une ligne gardée après le premier tour : invitée trop récemment sur scène ou déjà montée dans ce tour', () => {
  { // Karim vient de chanter, dernier du premier tour.
    const { s, people } = evening();
    for (const p of Object.values(people)) if (p !== people.Maud) s.chooseSong(p, song(), 'append');
    assert.deepEqual(playNames(s, 8), ['Paulo', 'Maud', 'Gil', 'Hugo', 'Ines', 'Jade', 'Elsa', 'Karim']);
    gesture(s, people.Elsa, 2); // Paulo, Maud, Elsa
    s.requestDuetJoin(people.Karim, people.Paulo.id, people.Paulo.song.entryId);
    s.answerDuetJoin(people.Paulo, people.Paulo.song.entryId, people.Karim.id, true);
    assert.deepEqual(fixed(s), ['Maud', 'Elsa'], 'Karim vient de chanter : le duo n’est plus gardé');
    assert.deepEqual(playNames(s, 3), ['Maud', 'Elsa', 'Gil'], 'Karim ne rechante pas juste après son titre');
  }
  { // Paulo a déjà chanté dans le deuxième tour, Elsa pas encore.
    const { s, people } = evening();
    for (const p of Object.values(people)) if (p !== people.Maud) for (let k = 0; k < 2; k++) s.chooseSong(p, song(), 'append');
    playNames(s, 8);
    assert.deepEqual(playNames(s, 5), ['Paulo', 'Maud', 'Gil', 'Hugo', 'Ines']);
    gesture(s, people.Karim, 2); // Jade, Elsa, Karim
    assert.deepEqual(fixed(s), ['Jade', 'Elsa', 'Karim']);
    s.requestDuetJoin(people.Paulo, people.Elsa.id, people.Elsa.song.entryId);
    s.answerDuetJoin(people.Elsa, people.Elsa.song.entryId, people.Paulo.id, true);
    assert.deepEqual(fixed(s), ['Jade', 'Karim'], 'Paulo déjà monté dans ce tour : le duo repasse par le calcul');
    assert.deepEqual(playNames(s, 3), ['Jade', 'Karim', 'Elsa & Paulo'], 'le duo ne passe pas devant la ligne placée par le bar');
  }
});

test('duo improvisé noté au bar avec une personne d’une ligne gardée : elle ne chante pas deux fois de suite', () => {
  for (const requirePresence of [false, true]) {
    const { s, people } = evening({ requirePresence });
    if (requirePresence) { s.reservePresenceNext([]); s.confirm(people.Paulo); }
    const sent = s.select();
    s.commit(sent); // Paulo sur scène
    if (requirePresence) s.reservePresenceNext(sent.ids); else s.reserveNext();
    assert.equal(s.reservedNext?.personId, people.Maud.id, 'Maud est la prochaine annoncée');
    gesture(s, people.Elsa, 3, sent.ids); // Maud, Gil, Hugo, Elsa
    s.staffCountPartner(people.Paulo.id, people.Maud.id, sent); // Maud a chanté avec Paulo
    assert.equal(s.reservedNext, null, 'l’annonce de Maud est libérée');
    assert.ok(!s.manualOrder.includes(people.Maud.id));
    assert.match(s.log.at(-1).msg, /Maud garde son titre mais attend deux autres chansons si possible$/);
    s.songEnded(sent.ids);
    if (requirePresence) for (const p of Object.values(people)) s.confirm(p);
    assert.deepEqual(playNames(s, 4), ['Gil', 'Hugo', 'Elsa', 'Ines'], `« Je suis là » ${requirePresence}`);
  }
});

// Décision du gérant du 26 octobre (ci-dessus) : avant, la place donnée par
// le bar tenait quand la personne était invitée dans un duo plus haut, et
// elle chantait deux fois à trois chansons d'intervalle.
test('ligne placée par le bar invitée dans un duo plus haut : son geste prend fin au départ du duo', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 3);
  gesture(s, people.Karim, 6);
  const duo = s.inviteDuet(people.Paulo, people.Elsa.id, song());
  s.reorderSongs(people.Paulo, duo.entryId, 0);
  s.answerDuet(people.Elsa, true, duo.entryId);
  assert.equal(names(s).indexOf('Elsa'), 3, 'tant que le duo n’est pas parti (il peut être annulé), la place tient');
  assert.equal(label(s, play(s)), 'Paulo & Elsa');
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Karim'], 'seul le geste de Elsa prend fin');
  assert.equal(s.log.find(line => /^Elsa chante avant/.test(line.msg))?.msg,
    'Elsa chante avant la place donnée par le bar : sa ligne retrouve le calcul');
  assert.deepEqual(playNames(s, 8), ['Maud', 'Gil', 'Hugo', 'Ines', 'Karim', 'Jade', 'Paulo', 'Elsa'],
    'Elsa attend les premiers passages des autres ; Karim avance d’une place et la garde');
});

// Le plan adopté (Timefold) fixait la ligne placée (pinnedUntil) : le geste
// terminé, il ne la garde plus à la place du geste.
test('geste terminé par un duo : le plan qui fixait sa ligne est abandonné', async () => {
  const { s, people } = evening({ solverEnabled: true, solverBudgetMs: 100, continuousSolver: false });
  const requests = [];
  s.solverBridge = { available: true, lastError: null, close() {},
    solve: async request => {
      requests.push(request);
      const ids = request.performances.map(row => row.id);
      return { requestId: request.requestId, order: ids, seedScore: '0hard/-100medium/0soft', score: '0hard/-100medium/0soft', elapsedMs: 5 };
    } };
  try {
    gesture(s, people.Elsa, 3);
    const duo = s.inviteDuet(people.Paulo, people.Elsa.id, song());
    s.reorderSongs(people.Paulo, duo.entryId, 0);
    s.answerDuet(people.Elsa, true, duo.entryId);
    s.solverStatus();
    await s.solverPromise;
    assert.ok(s._activePlanRanks(), 'un plan Timefold est adopté avec la ligne de Elsa fixée');
    assert.ok(requests.at(-1).pinnedUntil >= 4);
    s.commit(s.select()); // le duo part vers KaraFun
    assert.equal(s._activePlanRanks(), null, 'le plan qui fixait la ligne de Elsa ne vaut plus');
    s.solverStatus();
    await s.solverPromise;
    const last = requests.at(-1);
    assert.equal(last.pinnedUntil, 0, 'le nouveau calcul ne fixe plus rien');
    assert.ok(!last.performances.slice(0, 3).some(row => row.owner === people.Elsa.id));
  } finally { s.closeSolver(); }
});

// Relecture de la correction : le geste prenait fin à l'envoi du duo vers
// KaraFun, et rien ne le rendait quand ce duo en ressortait sans avoir été
// chanté (« Pas prêt », priorité du bar avant lui, absent à « Je suis là »,
// titre passé dans KaraFun) : Elsa perdait sa place sans être montée sur
// scène, et le journal disait l'inverse.
test('ligne placée invitée dans un duo envoyé à KaraFun puis retiré sans être chanté : sa place revient', () => {
  for (const how of ['Pas prêt', 'priorité avant lui', 'absent à « Je suis là »', 'passé dans KaraFun', 'redémarrage']) {
    const { s, access, people } = evening();
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    gesture(s, people.Karim, 6);
    const duo = s.inviteDuet(people.Paulo, people.Elsa.id, song());
    s.reorderSongs(people.Paulo, duo.entryId, 0);
    s.answerDuet(people.Elsa, true, duo.entryId);
    let sel = s.select();
    assert.equal(label(s, sel), 'Paulo & Elsa');
    s.commit(sel); // le duo est chargé dans KaraFun
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Karim'], `${how} : le geste de Elsa prend fin à l’envoi`);
    let t = s;
    if (how === 'redémarrage') {
      for (const tableId of s.tables.keys()) if (!access.get(tableId)) access.issue(tableId);
      const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access,
        settings: { auto: false, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 },
        tracked: [{ queueId: 5, sel, startedAt: null, addedAt: Date.now() }] })));
      t = new Scheduler(s.opts);
      const recovered = restoreNight(snapshot, { scheduler: t, access: new TableAccess(), settings: {} });
      assert.deepEqual(recovered.warnings, []);
      sel = recovered.tracked[0].sel;
    }
    if (how === 'Pas prêt' || how === 'redémarrage') {
      t.requeueUnplayed(sel);
      t.deferPassage(people.Paulo.id, { entryId: sel.song.entryId, ids: sel.ids }, 1);
    } else if (how === 'priorité avant lui') {
      gesture(t, people.Hugo, 0);
      t.requeueUnplayed(sel);
      t.yieldToPriority(sel, people.Hugo.id);
    } else t.rollbackUnplayed(sel, { requeue: how === 'passé dans KaraFun' });
    const elsa = t.people.get(people.Elsa.id);
    assert.equal(elsa.duetGuestCount, 0, `${how} : Elsa n’a pas chanté`);
    assert.deepEqual(t.manualChanges.map(change => change.name),
      how === 'priorité avant lui' ? ['Elsa', 'Karim', 'Hugo'] : ['Elsa', 'Karim'], `${how} : son geste revient, à son rang`);
    const at = how === 'priorité avant lui' ? 3 : 2;
    assert.equal(t.manualOrder.indexOf(elsa.id), at, `${how} : Elsa reprend sa place derrière Maud et Gil`);
    assert.equal(t.log.find(line => line.msg === 'Elsa n’a finalement pas chanté : la place donnée par le bar revient')?.kind,
      'staff', `${how} : le journal du bar le dit`);
    t.undoLastManualChange(null, NATIVE); // le dernier geste
    assert.ok(t.manualChanges.some(change => change.name === 'Elsa'), `${how} : le geste de Elsa s’annule encore à son tour`);
  }
});

test('ligne placée invitée dans un duo envoyé puis retiré, mais remontée sur scène entre-temps : rien ne revient', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 3);
  const duo = s.inviteDuet(people.Paulo, people.Elsa.id, song());
  s.reorderSongs(people.Paulo, duo.entryId, 0);
  s.answerDuet(people.Elsa, true, duo.entryId);
  const sel = s.select();
  s.commit(sel);
  const stage = s.select(); // un autre titre où Elsa monte sur scène (duo improvisé)
  s.commit(stage);
  s.staffCountPartner(stage.ids[0], people.Elsa.id, stage);
  s.rollbackUnplayed(sel, { requeue: true });
  assert.deepEqual(s.manualChanges, [], 'Elsa a chanté depuis : le geste reste terminé');
  assert.ok(!s.manualOrder.includes(people.Elsa.id));
});

// Relecture de la correction : l'invitée placée par le bar qui ne chante plus
// un duo déjà chargé dans KaraFun (« Je ne chante plus ce duo », ou « Chanter
// seul » de l'auteur) ne monte pas sur scène, mais sa place ne revenait pas ;
// le reçu du passage la rendait plus tard, au hasard d'un « Pas prêt ».
test('ligne placée invitée dans un duo chargé qu’elle ne chante plus : sa place revient aussitôt', () => {
  for (const by of ['guest', 'owner']) {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    gesture(s, people.Karim, 6);
    const duo = s.inviteDuet(people.Paulo, people.Elsa.id, song());
    s.reorderSongs(people.Paulo, duo.entryId, 0);
    s.answerDuet(people.Elsa, true, duo.entryId);
    const sel = s.select();
    s.commit(sel); // le duo est chargé dans KaraFun, le geste de Elsa prend fin
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Karim']);
    s.leaveSentDuet(sel, people.Elsa.id, { by });
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa', 'Karim'], `${by} : son geste revient, à son rang`);
    assert.equal(s.manualOrder.indexOf(people.Elsa.id), 2, `${by} : Elsa reprend sa place derrière Maud et Gil`);
    assert.equal(s.log.at(-1).msg, 'Elsa n’a finalement pas chanté : la place donnée par le bar revient', by);
    assert.equal(sel.placedUndo, undefined, `${by} : le reçu ne la rendra pas une seconde fois`);
    s.songEnded(sel.ids); // Paulo a chanté seul
    assert.deepEqual(playNames(s, 3), ['Maud', 'Gil', 'Elsa'], by);
  }
});

// Invitée marquée partie par le bar (keepSentDuosOfLeavers, avant son
// départ) : elle quitte la soirée, sa place ne revient pas. Avant, le journal
// du bar annonçait son retour juste avant son départ et le plan Timefold
// était abandonné pour rien.
test('ligne placée invitée dans un duo chargé, invitée marquée partie : sa place ne revient pas', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 3);
  gesture(s, people.Karim, 6);
  const duo = s.inviteDuet(people.Paulo, people.Elsa.id, song());
  s.reorderSongs(people.Paulo, duo.entryId, 0);
  s.answerDuet(people.Elsa, true, duo.entryId);
  const sel = s.select();
  s.commit(sel);
  const plan = { version: s.version, fingerprint: s.solverContextFingerprint(), source: 'timefold', ranks: new Map() };
  s.solverPlan = plan;
  s.leaveSentDuet(sel, people.Elsa.id, { by: 'staff' });
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Karim'], 'son geste ne revient pas');
  assert.ok(!s.log.some(entry => /n’a finalement pas chanté/.test(entry.msg)), s.log.map(entry => entry.msg).join(' | '));
  assert.equal(s.solverPlan, plan, 'le plan n’est pas abandonné pour elle');
  assert.equal(sel.placedUndo, undefined, 'le reçu ne la rendra pas plus tard');
  s.leave(people.Elsa, 'staff');
  assert.ok(!s.manualOrder.includes(people.Elsa.id));
});

// Relecture (passe 3, cellule sans test) : seul geste du bar, la place de
// Elsa revient avec les lignes gardées devant elle (Maud, Gil), retournées au
// calcul quand son geste a pris fin à l'envoi du duo (_restorePlaced,
// `waiting`). Les autres tests gardaient un geste plus loin (Karim) qui les
// laissait dans l'ordre fixé. Sans elles, Elsa passait première.
test('seul geste du bar, invitée d’un duo chargé qui n’a pas chanté : sa place revient derrière les lignes gardées devant elle', () => {
  for (const how of ['l’invitée ne chante plus le duo', 'Pas prêt', 'passé dans KaraFun']) {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    const duo = s.inviteDuet(people.Paulo, people.Elsa.id, song());
    s.reorderSongs(people.Paulo, duo.entryId, 0);
    s.answerDuet(people.Elsa, true, duo.entryId);
    const sel = s.select();
    s.commit(sel);
    assert.deepEqual(s.manualOrder, [], `${how} : le geste prend fin, Maud et Gil retrouvent le calcul`);
    if (how === 'Pas prêt') {
      s.requeueUnplayed(sel);
      s.deferPassage(people.Paulo.id, { entryId: sel.song.entryId, ids: sel.ids }, 1);
    } else if (how === 'passé dans KaraFun') s.rollbackUnplayed(sel, { requeue: true });
    else s.leaveSentDuet(sel, people.Elsa.id, { by: 'guest' });
    assert.deepEqual(fixed(s), ['Maud', 'Gil', 'Elsa'], how);
    if (how !== 'Pas prêt') assert.deepEqual(names(s, how === 'passé dans KaraFun' ? [] : sel.ids).slice(0, 3), ['Maud', 'Gil', 'Elsa'], how);
  }
});

// Relecture (passe 3) : même défaut que pour un duo défait avant son envoi.
// L'invitée d'un duo formé sur une ligne gardée, déjà chargé dans KaraFun,
// qui ne le chante plus (« Je ne chante plus ce duo », ou « Chanter seul » de
// l'auteur) ne monte pas sur scène : sa propre ligne gardée, sortie de
// l'ordre fixé pour ce duo, revient. Gil, gardé devant Elsa, passait derrière
// elle. Marquée partie par le bar, sa ligne ne revient pas (celles des autres
// personnes sorties pour ce duo, si : test suivant).
test('duo formé sur une ligne gardée, chargé dans KaraFun, que l’invitée ne chante plus : sa ligne revient', () => {
  for (const by of ['guest', 'owner', 'staff']) {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    s.openDuet(people.Paulo, { entryId: people.Paulo.song.entryId });
    s.acceptOpenDuet(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
    assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Elsa'], by);
    const sel = s.select();
    assert.equal(label(s, sel), 'Paulo & Gil');
    s.commit(sel); // le duo est chargé dans KaraFun
    assert.deepEqual(fixed(s), ['Maud', 'Elsa'], by);
    s.leaveSentDuet(sel, people.Gil.id, { by });
    if (by === 'staff') {
      assert.deepEqual(fixed(s), ['Maud', 'Elsa'], 'invitée marquée partie : sa ligne ne revient pas');
      continue;
    }
    assert.equal(people.Gil.duetGuestCount, 0, `${by} : Gil n’a pas chanté`);
    assert.deepEqual(fixed(s), ['Maud', 'Gil', 'Elsa'], `${by} : Gil reprend sa place devant Elsa`);
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa'], `${by} : les gestes ne changent pas`);
    s.songEnded(sel.ids); // Paulo a chanté seul
    assert.deepEqual(playNames(s, 3), ['Maud', 'Gil', 'Elsa'], by);
  }
  // Un geste noté avant le duo comptait la ligne de Gil dans son état d'avant ;
  // l'envoi du duo l'en avait retirée (_unpinSingers). Annuler ce geste après
  // le retrait de Gil ne lui reprend pas sa place, comme avant l'envoi.
  for (const sent of [false, true]) {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    gesture(s, people.Karim, 6); // son état d'avant compte Gil devant Elsa
    s.openDuet(people.Paulo, { entryId: people.Paulo.song.entryId });
    s.acceptOpenDuet(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
    const sel = s.select();
    if (sent) {
      s.commit(sel);
      s.leaveSentDuet(sel, people.Gil.id, { by: 'guest' });
    } else s.leaveDuet(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
    s.undoLastManualChange(null, NATIVE); // Karim
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa']);
    assert.deepEqual(fixed(s), sent ? ['Maud', 'Gil', 'Elsa'] : ['Paulo', 'Maud', 'Gil', 'Elsa'],
      `${sent ? 'duo chargé' : 'avant l’envoi'} : Gil garde sa place devant Elsa`);
  }
});

// Relecture (passe 6) : le reçu `unpinned` d'un duo tient aussi les lignes
// d'autres personnes, sorties de l'ordre fixé seulement parce que l'invitée y
// chantait. Gil, invité de Hugo (ligne gardée devant Elsa) puis du duo ouvert
// de Paulo : la ligne de Hugo sort pour le duo de Paulo. Le bar marque Gil
// parti : avant l'envoi, la ligne de Hugo revient ; duo chargé, en train de
// sortir de KaraFun ou envoi sans accusé (keepSentDuosOfLeavers), elle était
// perdue et Hugo passait derrière Elsa. Seule la ligne de Gil, qui part, ne
// revient pas.
test('invitée marquée partie, duo chargé ou en cours d’envoi : la ligne gardée d’une autre personne, sortie pour ce duo, revient', () => {
  for (const when of ['avant l’envoi', 'chargé', 'pendant l’envoi']) {
    const { s, people } = evening();
    gesture(s, people.Elsa, 4); // Paulo, Maud, Gil, Hugo, Elsa
    const hugoDuo = s.inviteDuet(people.Hugo, people.Gil.id, song());
    s.reorderSongs(people.Hugo, hugoDuo.entryId, 0);
    s.answerDuet(people.Gil, true, hugoDuo.entryId);
    assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Hugo', 'Elsa'], `${when} : Gil monte sur scène avec Hugo`);
    s.openDuet(people.Paulo, { entryId: people.Paulo.song.entryId });
    s.acceptOpenDuet(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
    assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Elsa'], `${when} : Gil chante d’abord avec Paulo`);
    const sel = when === 'avant l’envoi' ? null : s.select();
    if (sel) assert.equal(label(s, sel), 'Paulo & Gil', when);
    if (when === 'chargé') {
      s.commit(sel);
      s.leaveSentDuet(sel, people.Gil.id, { by: 'staff' });
    } else if (sel) s.leaveSentDuet(sel, people.Gil.id, { by: 'staff', keepLabel: true });
    s.leave(people.Gil, 'staff');
    if (when === 'pendant l’envoi') s.commit(sel);
    assert.deepEqual(fixed(s).filter(name => name !== 'Paulo'), ['Maud', 'Hugo', 'Elsa'], `${when} : Hugo reprend sa place devant Elsa`);
    assert.ok(!s.manualOrder.includes(people.Gil.id), `${when} : la ligne de Gil, partie, ne revient pas`);
    if (sel) s.songEnded(sel.ids); // Paulo a chanté seul
    assert.deepEqual(playNames(s, 3), when === 'avant l’envoi' ? ['Paulo', 'Maud', 'Hugo'] : ['Maud', 'Hugo', 'Elsa'], when);
  }
});

// Relecture de la correction : un duo improvisé noté par erreur, puis annulé
// ou corrigé, laissait la place ou la priorité de cette personne terminée.
test('duo improvisé noté par erreur avec une personne placée par le bar, puis annulé : son geste revient', () => {
  for (const kind of ['priorité', 'déplacement']) {
    const { s, access, people } = evening();
    const sent = s.select();
    s.commit(sent); // Paulo sur scène
    gesture(s, people.Elsa, 3, sent.ids);
    gesture(s, people.Karim, kind === 'priorité' ? 0 : 1, sent.ids);
    const shown = names(s, sent.ids);
    s.staffCountPartner(sent.ids[0], people.Karim.id, sent);
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa']);
    // Une sauvegarde entre-temps garde de quoi le rendre.
    const t = restart(s, access);
    const tracked = { ...sent, staffDuo: JSON.parse(JSON.stringify(sent.staffDuo)) };
    t.staffUncountPartner(tracked.staffDuo, tracked, [tracked]);
    assert.deepEqual(t.manualChanges.map(change => change.name), ['Elsa', 'Karim'], kind);
    if (kind === 'priorité') {
      assert.equal(t.reservedNext?.personId, people.Karim.id, 'sa priorité revient');
      assert.equal(t.reservedNext?.byStaff, true);
      assert.ok(t.log.some(line => line.msg === 'Karim n’a finalement pas chanté : sa priorité revient'));
    } else assert.ok(t.log.some(line => line.msg === 'Karim n’a finalement pas chanté : la place donnée par le bar revient'));
    assert.deepEqual(names(t, sent.ids), shown, `${kind} : la file d’avant le duo noté revient`);
  }
});

// Relecture (passe 16, tests) : règles de _restorePlaced et de _guestLeft
// décrites dans leurs commentaires, qu'aucun test ne gardait.
test('geste terminé par un duo, le bar replace la personne : le duo ressorti ne rend pas l’ancienne place', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 3);
  const duo = s.inviteDuet(people.Paulo, people.Elsa.id, song());
  s.reorderSongs(people.Paulo, duo.entryId, 0);
  s.answerDuet(people.Elsa, true, duo.entryId);
  const sel = s.select(); s.commit(sel); // le geste d'Elsa prend fin (_endPlaced)
  gesture(s, people.Elsa, 1, [people.Paulo.id]); // le bar la replace 2e
  s.rollbackUnplayed(sel, { requeue: true }); // duo retiré de KaraFun sans être chanté
  assert.deepEqual(s.manualChanges.map(c => [c.name, c.to]), [['Elsa', 2]], 'seul le geste le plus récent reste');
  assert.equal(names(s)[1], 'Elsa', 'sa nouvelle place tient');
});

test('priorité terminée par un duo noté, autre priorité donnée depuis, duo noté annulé : la priorité donnée depuis tient', () => {
  const { s, people } = evening();
  const sent = s.select(); s.commit(sent); // Paulo sur scène
  gesture(s, people.Karim, 0, sent.ids);
  s.staffCountPartner(sent.ids[0], people.Karim.id, sent); // sa priorité prend fin
  gesture(s, people.Elsa, 0, sent.ids);
  s.staffUncountPartner(sent.staffDuo, sent, [sent]);
  assert.equal(s.reservedNext?.personId, people.Elsa.id, 'la priorité d’Elsa n’est pas remplacée');
  assert.deepEqual(names(s, sent.ids).slice(0, 2), ['Elsa', 'Karim']);
  assert.ok(s.log.some(line => line.msg === 'Karim n’a finalement pas chanté : la place donnée par le bar revient'));
});

test('duo formé sur une ligne gardée, geste du bar annulé ou ligne retirée, puis l’invitée quitte le duo : sa ligne n’est pas refixée seule', () => {
  for (const how of ['annulé', 'retiré']) {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil gardés devant Elsa
    const duo = s.inviteDuet(people.Paulo, people.Gil.id, song());
    s.reorderSongs(people.Paulo, duo.entryId, 0);
    s.answerDuet(people.Gil, true, duo.entryId);
    if (how === 'annulé') s.undoLastManualChange(null, NATIVE); else s.staffRemove(people.Elsa.id);
    s.leaveDuet(people.Gil, people.Paulo.id, duo.entryId);
    assert.deepEqual(s.manualOrder, [], how);
    assert.equal(names(s)[0], 'Paulo', `${how} : Gil ne passe pas devant tout le monde`);
  }
});

// Relecture de la correction : « Recalculer la file », « Annuler tous les
// changements manuels » et « Vider toutes les chansons » abandonnent tous les
// gestes du bar. Un geste terminé par un duo, gardé dans le reçu du passage
// ou du duo noté, revenait pourtant quand ce duo ressortait de KaraFun sans
// être chanté, ou quand le bar annulait le duo noté.
test('gestes abandonnés par le bar : un geste terminé par un duo ne revient plus ensuite', () => {
  const resets = {
    'Recalculer la file': s => s.forceReplan(),
    'Annuler tous les changements manuels': s => s.undoAllManualChanges(NATIVE),
    // Comme clearQueue (server.js) ; la personne rechoisit un titre avant
    // que KaraFun confirme le retrait du duo.
    'Vider toutes les chansons': s => s.invalidateManualOrder(),
  };
  const settings = { auto: false, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 };
  for (const [how, reset] of Object.entries(resets)) {
    for (const restarted of [false, true]) {
      const label = `${how}${restarted ? ', puis redémarrage' : ''}`;
      { // Duo envoyé à KaraFun, puis retiré sans être chanté.
        const { s, access, people } = evening();
        gesture(s, people.Elsa, 3);
        gesture(s, people.Karim, 6);
        const duo = s.inviteDuet(people.Paulo, people.Elsa.id, song());
        s.reorderSongs(people.Paulo, duo.entryId, 0);
        s.answerDuet(people.Elsa, true, duo.entryId);
        let sel = s.select();
        s.commit(sel);
        assert.ok(sel.placedUndo, `${label} : le reçu garde le geste de Elsa`);
        reset(s);
        let t = s;
        if (restarted) {
          for (const tableId of s.tables.keys()) if (!access.get(tableId)) access.issue(tableId);
          const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings,
            tracked: [{ queueId: 5, sel, startedAt: null, addedAt: Date.now() }] })));
          t = new Scheduler(s.opts);
          const recovered = restoreNight(snapshot, { scheduler: t, access: new TableAccess(), settings: {} });
          assert.deepEqual(recovered.warnings, []);
          sel = recovered.tracked[0].sel;
        }
        t.rollbackUnplayed(sel, { requeue: true });
        assert.deepEqual(t.manualChanges, [], `${label} : aucun geste ne revient`);
        assert.deepEqual(t.manualOrder, []);
        assert.equal(t.manualOrderActive, false);
        assert.ok(!t.log.some(line => /n’a finalement pas chanté/.test(line.msg)), `${label} : rien à annoncer au bar`);
      }
      { // Duo improvisé noté au bar, puis annulé.
        const { s, access, people } = evening();
        const sent = s.select();
        s.commit(sent); // Paulo sur scène
        gesture(s, people.Elsa, 3, sent.ids);
        gesture(s, people.Karim, 0, sent.ids);
        s.staffCountPartner(sent.ids[0], people.Karim.id, sent);
        assert.ok(sent.staffDuo?.placed, `${label} : le duo noté garde la priorité de Karim`);
        reset(s);
        const t = restarted ? restart(s, access) : s;
        const tracked = restarted ? { ...sent, staffDuo: JSON.parse(JSON.stringify(sent.staffDuo)) } : sent;
        t.staffUncountPartner(tracked.staffDuo, tracked, [tracked]);
        assert.deepEqual(t.manualChanges, [], `${label} : la priorité de Karim ne revient pas`);
        assert.deepEqual(t.manualOrder, []);
        assert.notEqual(t.reservedNext?.byStaff, true, `${label} : personne n’est annoncé par le bar`);
        assert.ok(!t.log.some(line => /n’a finalement pas chanté/.test(line.msg)));
      }
    }
  }
});

// Relecture (passe 4) : même règle pour les lignes qu'un duo a sorties de
// l'ordre fixé (_guestLeft, `epoch`). Abandonnées avec tous les gestes, elles
// ne reviennent pas quand l'invitée quitte ensuite le duo, avant son envoi ou
// une fois chargé : sinon Gil, gardé par un geste abandonné, se plaçait
// devant Hugo et Karim, placés par le bar depuis.
test('duo sur une ligne gardée, « Recalculer la file » puis un nouveau geste : la ligne de l’invitée ne revient pas', () => {
  for (const how of ['avant l’envoi', 'chargé dans KaraFun']) {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    s.openDuet(people.Paulo, { entryId: people.Paulo.song.entryId });
    s.acceptOpenDuet(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
    s.undoAllManualChanges(NATIVE);
    gesture(s, people.Karim, 3);
    assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Hugo', 'Karim'], how);
    if (how === 'avant l’envoi') {
      s.leaveDuet(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
      assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Hugo', 'Karim'], `${how} : abandonnée avec les gestes, Gil retrouve le calcul`);
    } else {
      const sel = s.select();
      assert.equal(label(s, sel), 'Paulo & Gil');
      s.commit(sel);
      assert.deepEqual(fixed(s), ['Maud', 'Hugo', 'Karim'], how);
      s.leaveSentDuet(sel, people.Gil.id, { by: 'guest' });
      assert.deepEqual(fixed(s), ['Maud', 'Hugo', 'Karim'], `${how} : abandonnée avec les gestes, Gil retrouve le calcul`);
    }
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Karim'], `${how} : les gestes ne changent pas`);
  }
});

// Relecture : `restoreToHead`, sans appelant, effaçait encore tous les gestes
// du bar. Contrat (scheduler.js, invalidateManualOrder) : seuls « Recalculer
// la file » (forceReplan) et, côté serveur, « Vider toutes les chansons » et
// la nouvelle soirée les abandonnent d'un coup ; aucune autre méthode du
// planificateur.
test('seuls les abandons du bar effacent tous ses gestes : aucune autre méthode du planificateur', () => {
  const callers = Object.getOwnPropertyNames(Scheduler.prototype).filter(name => name !== 'constructor' &&
    typeof Scheduler.prototype[name] === 'function' && /\.invalidateManualOrder\(/.test(String(Scheduler.prototype[name])));
  assert.deepEqual(callers, ['forceReplan']);
});

// Relecture de la correction : un « Pas prêt » arrivé au bout de son report au
// même passage que le titre retiré pour une priorité passait avant lui, dans
// l'ordre de la file : le titre retiré passait une chanson plus tard.
test('priorité avant un titre chargé et « Pas prêt » au bout de son report au même passage : le titre retiré passe d’abord', () => {
  const { s, people } = evening();
  const stage = s.select(); s.commit(stage); // Paulo sur scène
  const maud = people.Maud;
  s.deferPassage(maud.id, { entryId: maud.song.entryId, ids: [maud.id] }, 1);
  const loaded = s.select(); s.commit(loaded);
  assert.equal(label(s, loaded), 'Gil', 'Gil chargé dans KaraFun, Maud annoncée après lui');
  gesture(s, people.Karim, 0, stage.ids);
  pulledBack(s, loaded, people.Karim.id);
  assert.ok(s.isDeferred(maud) && s.isDeferred(people.Gil), 'deux titres attendent un passage');
  assert.deepEqual(names(s, stage.ids).slice(0, 3), ['Karim', 'Gil', 'Maud']);
  s.songEnded(stage.ids);
  assert.equal(label(s, play(s)), 'Karim');
  assert.equal(s.reservedNext?.personId, people.Gil.id, 'Gil, retiré pour Karim, passe juste après lui');
  assert.deepEqual(playNames(s, 2), ['Gil', 'Maud']);
});

test('annuler un geste ne remet pas dans l’ordre fixé une ligne sortie pour un duo', () => {
  {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3);
    gesture(s, people.Karim, 5); // Paulo, Maud, Gil, Elsa, Hugo, Karim
    const duo = s.inviteDuet(people.Paulo, people.Gil.id, song());
    s.reorderSongs(people.Paulo, duo.entryId, 0);
    s.answerDuet(people.Gil, true, duo.entryId);
    s.undoLastManualChange(null, NATIVE); // Karim
    assert.deepEqual(s.manualOrder.map(pid => s.people.get(pid).name), ['Paulo', 'Maud', 'Elsa'],
      'Gil, invitée du duo d’Paulo, ne revient pas devant Elsa');
  }
  {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3);
    gesture(s, people.Karim, 5);
    const sent = s.select();
    s.commit(sent); // Paulo
    s.staffCountPartner(people.Paulo.id, people.Gil.id, sent); // Gil a chanté avec lui
    s.undoLastManualChange(null, NATIVE); // Karim
    assert.deepEqual(s.manualOrder.map(pid => s.people.get(pid).name), ['Maud', 'Elsa'],
      'Gil, monté sur scène depuis le geste, ne revient pas dans l’ordre fixé');
  }
});

const fixed = s => s.manualOrder.map(pid => s.people.get(pid).name);

// Relecture : un duo formé sur une ligne de l'ordre fixé en sort la propre
// ligne de l'invitée (_guestJoined), ou celle de l'auteur si le duo ne peut
// pas passer à cette place. Défait avant son envoi, rien ne la remettait :
// Gil, gardé devant Elsa, passait derrière elle, et Elsa montait au-dessus
// de la place donnée par le bar.
test('duo formé sur une ligne gardée puis défait avant son envoi : la ligne qu’il avait sortie de l’ordre fixé revient', () => {
  for (const how of ['l’invitée se retire', 'l’auteur annule le duo', 'l’auteur retire le titre', 'redémarrage, puis l’invitée se retire']) {
    const ctx = evening();
    const { people } = ctx;
    gesture(ctx.s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    ctx.s.chooseSong(people.Paulo, song(), 'append'); // titre suivant de Paulo
    const duo = ctx.s.inviteDuet(people.Paulo, people.Gil.id, song());
    ctx.s.reorderSongs(people.Paulo, duo.entryId, 0);
    ctx.s.answerDuet(people.Gil, true, duo.entryId);
    assert.deepEqual(fixed(ctx.s), ['Paulo', 'Maud', 'Elsa'], `${how} : Gil chante avec Paulo, sa ligne quitte l’ordre fixé`);
    const s = how.startsWith('redémarrage') ? restart(ctx.s, ctx.access) : ctx.s;
    if (s !== ctx.s) assert.deepEqual(s.warnings, [], 'la soirée se reprend sans avertissement');
    const [paulo, gil] = [people.Paulo, people.Gil].map(p => s.people.get(p.id));
    if (how.endsWith('l’invitée se retire')) s.leaveDuet(gil, paulo.id, duo.entryId);
    else if (how === 'l’auteur annule le duo') s.cancelDuet(paulo, duo.entryId);
    else s.removeSong(paulo, duo.entryId);
    assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Gil', 'Elsa'], `${how} : Gil reprend sa place devant Elsa`);
    assert.deepEqual(names(s).slice(0, 4), ['Paulo', 'Maud', 'Gil', 'Elsa'], how);
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa'], `${how} : les gestes ne changent pas`);
  }
  // Duo qui ne pouvait pas passer sur la ligne gardée de son auteur (Paulo
  // vient de chanter) : Paulo se retire, le solo de Maud reprend sa place.
  const { s, people } = evening();
  assert.equal(label(s, play(s)), 'Paulo');
  gesture(s, people.Elsa, 3); // Maud, Gil, Hugo, Elsa
  const duo = s.inviteDuet(people.Maud, people.Paulo.id, song());
  s.reorderSongs(people.Maud, duo.entryId, 0);
  s.answerDuet(people.Paulo, true, duo.entryId);
  assert.deepEqual(fixed(s), ['Gil', 'Hugo', 'Elsa']);
  s.leaveDuet(people.Paulo, people.Maud.id, duo.entryId);
  assert.deepEqual(fixed(s), ['Maud', 'Gil', 'Hugo', 'Elsa'], 'le solo de Maud reprend sa place devant Elsa');
  assert.deepEqual(playNames(s, 4), ['Maud', 'Gil', 'Hugo', 'Elsa']);
});

// Relecture (passe 3, cellules sans test de _guestLeft) : un geste noté après
// la formation du duo compte aussi la ligne revenue dans son état d'avant ;
// l'annuler ne la retire pas. Montée sur scène depuis (duo noté au bar avec
// la personne d'une priorité), sa ligne ne revient pas.
test('duo défait après un autre geste : annuler ce geste garde la ligne revenue ; montée sur scène depuis, elle ne revient pas', () => {
  {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    const duo = s.inviteDuet(people.Paulo, people.Gil.id, song());
    s.reorderSongs(people.Paulo, duo.entryId, 0);
    s.answerDuet(people.Gil, true, duo.entryId);
    gesture(s, people.Karim, 3); // Paulo, Maud, Elsa, Karim
    s.leaveDuet(people.Gil, people.Paulo.id, duo.entryId);
    assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Gil', 'Elsa', 'Karim']);
    s.undoLastManualChange(null, NATIVE); // Karim
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa']);
    assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Gil', 'Elsa'], 'Gil, gardé devant Elsa, y reste');
  }
  const { s, people } = evening();
  gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
  const duo = s.inviteDuet(people.Paulo, people.Gil.id, song());
  s.reorderSongs(people.Paulo, duo.entryId, 0);
  s.answerDuet(people.Gil, true, duo.entryId);
  gesture(s, people.Karim, 0); // priorité
  const sent = s.select();
  assert.equal(label(s, sent), 'Karim');
  s.commit(sent);
  s.staffCountPartner(people.Karim.id, people.Gil.id, sent); // Gil chante avec Karim
  s.leaveDuet(people.Gil, people.Paulo.id, duo.entryId);
  assert.ok(!s.manualOrder.includes(people.Gil.id), 'Gil est monté sur scène depuis : sa ligne ne revient pas');
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa']);
});

// Relecture (passe 3) : réordonner sa liste pour chanter d'abord un solo
// faisait passer le duo dans la suite de la liste sans rendre les lignes
// qu'il avait sorties de l'ordre fixé. Gil, gardé devant Elsa, passait
// derrière elle ; Maud, première de l'ordre fixé, tombait 4e derrière Elsa.
test('duo formé sur une ligne gardée puis réordonné derrière un solo : les lignes qu’il avait sorties reviennent', () => {
  {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    s.chooseSong(people.Paulo, song(), 'append');
    const duo = people.Paulo.song;
    s.openDuet(people.Paulo, { entryId: duo.entryId });
    s.acceptOpenDuet(people.Gil, people.Paulo.id, duo.entryId);
    assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Elsa'], 'Gil chante avec Paulo, sa ligne quitte l’ordre fixé');
    s.reorderSongs(people.Paulo, people.Paulo.backlog[0].entryId, 0); // son solo d'abord
    assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Gil', 'Elsa'], 'Gil reprend sa place devant Elsa');
    assert.deepEqual(names(s).slice(0, 4), ['Paulo', 'Maud', 'Gil', 'Elsa']);
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa'], 'les gestes ne changent pas');
    // Le duo remis en tête : Gil chante de nouveau avec lui, sa ligne ressort.
    s.reorderSongs(people.Paulo, duo.entryId, 0);
    assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Elsa']);
    assert.deepEqual(playNames(s, 3), ['Paulo & Gil', 'Maud', 'Elsa']);
  }
  // Duo qui ne pouvait pas passer sur la ligne gardée de son auteur (Paulo
  // vient de chanter) : Maud remet son solo en tête, il reprend sa place.
  const { s, people } = evening();
  assert.equal(label(s, play(s)), 'Paulo');
  gesture(s, people.Elsa, 3); // Maud, Gil, Hugo, Elsa
  const solo = people.Maud.song;
  const duo = s.inviteDuet(people.Maud, people.Paulo.id, song());
  s.reorderSongs(people.Maud, duo.entryId, 0);
  s.answerDuet(people.Paulo, true, duo.entryId);
  assert.deepEqual(fixed(s), ['Gil', 'Hugo', 'Elsa']);
  s.reorderSongs(people.Maud, solo.entryId, 0);
  assert.deepEqual(fixed(s), ['Maud', 'Gil', 'Hugo', 'Elsa'], 'le solo de Maud reprend sa place devant Elsa');
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa']);
  assert.deepEqual(playNames(s, 4), ['Maud', 'Gil', 'Hugo', 'Elsa']);
});

// Même défaut quand un titre sort de KaraFun sans être chanté (« Pas prêt ») :
// il revient en tête de la liste de son chanteur (requeueUnplayed) et le duo
// formé entre-temps sur sa ligne placée passe dans la suite de la liste.
test('titre revenu de KaraFun devant un duo formé sur une ligne placée : la ligne de l’invitée revient', () => {
  const { s, people } = evening();
  s.chooseSong(people.Paulo, song(), 'append');
  const loaded = s.select();
  s.commit(loaded); // le premier titre de Paulo est chargé dans KaraFun
  gesture(s, people.Paulo, 2); // Maud, Gil, Paulo
  s.openDuet(people.Paulo, { entryId: people.Paulo.song.entryId });
  s.acceptOpenDuet(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
  assert.deepEqual(fixed(s), ['Maud', 'Paulo'], 'Gil chante avec Paulo, sa ligne quitte l’ordre fixé');
  s.requeueUnplayed(loaded);
  assert.equal(people.Paulo.song.entryId, loaded.song.entryId, 'le titre retiré revient en tête de sa liste');
  assert.deepEqual(fixed(s), ['Maud', 'Gil', 'Paulo'], 'le duo n’est plus le titre en cours : Gil reprend sa place');
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Paulo']);
});

// Relecture (passe 3, cellule sans test) : le bar retire le titre en cours
// d'une ligne gardée ; le titre suivant, un duo accepté, prend la ligne
// (staffRemove, _guestJoined). Sinon Gil chantait avec Paulo à la 1re ligne
// et de nouveau à la sienne, trois chansons plus tard.
test('titre retiré par le bar, duo accepté suivant sur une ligne gardée : le duo garde la ligne', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
  const duo = s.inviteDuet(people.Paulo, people.Gil.id, song());
  s.answerDuet(people.Gil, true, duo.entryId);
  assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Gil', 'Elsa']);
  s.staffRemove(people.Paulo.id);
  assert.equal(people.Paulo.song.entryId, duo.entryId);
  assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Elsa']);
  assert.deepEqual(names(s).slice(0, 3), ['Paulo & Gil', 'Maud', 'Elsa']);
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa']);
});

// Relecture (passe 3, cellule sans test) : départ de l'auteur ou de l'invitée
// d'un duo formé sur une ligne gardée (_removeDuetsForPerson) : les lignes
// sorties pour lui reviennent pour ceux qui restent, les gestes ne changent pas.
test('duo formé sur une ligne gardée, puis départ de l’auteur ou de l’invitée : les lignes qui restent reprennent leur place', () => {
  const cases = {
    'l’auteur part': [(s, people) => s.leave(people.Paulo), ['Maud', 'Gil', 'Elsa']],
    'la table de l’auteur part': [s => s.tableLeft('1'), ['Maud', 'Gil', 'Elsa']],
    'l’invitée part': [(s, people) => s.leave(people.Gil), ['Paulo', 'Maud', 'Elsa']],
  };
  for (const [how, [leave, order]] of Object.entries(cases)) {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    s.openDuet(people.Paulo, { entryId: people.Paulo.song.entryId });
    s.acceptOpenDuet(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
    assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Elsa'], how);
    leave(s, people);
    assert.deepEqual(fixed(s), order, how);
    assert.deepEqual(names(s).slice(0, 3), order, how);
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa'], how);
  }
});

// Relecture (passe 7) : même départ de l'auteur, duo déjà chargé dans
// KaraFun. Le serveur le retire sans qu'il soit chanté (keepSentDuosOfLeavers
// le range parmi les titres à retirer, removeLeaversTracks l'annule, puis
// sync appelle rollbackUnplayed quand KaraFun confirme le retrait, au besoin
// après un redémarrage : le titre suivi est sauvegardé avec son duo). La
// ligne de Gil, sortie de l'ordre fixé pour ce duo, ne revenait pas : Gil,
// gardé devant Elsa, passait derrière elle, alors que le même départ avant
// l'envoi la rend.
test('duo formé sur une ligne gardée, chargé dans KaraFun, puis départ de l’auteur : retiré sans être chanté, les lignes qui restent reprennent leur place', () => {
  const cases = {
    'l’auteur est marqué parti': (s, people) => s.leave(people.Paulo, 'staff'),
    'la table de l’auteur part': s => s.tableLeft('1'),
  };
  for (const [how, leave] of Object.entries(cases)) {
    for (const stage of ['avant l’envoi', 'duo chargé', 'duo chargé, redémarrage avant le retrait']) {
      const when = `${how}, ${stage}`;
      const { s, access, people } = evening();
      gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
      s.openDuet(people.Paulo, { entryId: people.Paulo.song.entryId });
      s.acceptOpenDuet(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
      assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Elsa'], `${when} : Gil chante avec Paulo, sa ligne quitte l’ordre fixé`);
      let sel = stage === 'avant l’envoi' ? null : s.select();
      if (sel) {
        assert.equal(label(s, sel), 'Paulo & Gil', when);
        s.commit(sel);
      }
      leave(s, people);
      let t = s;
      if (stage.includes('redémarrage')) {
        for (const tableId of s.tables.keys()) if (!access.get(tableId)) access.issue(tableId);
        const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access,
          settings: { auto: false, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 },
          tracked: [{ queueId: 5, sel, startedAt: null, addedAt: Date.now(), cancelled: true }] })));
        t = new Scheduler(s.opts);
        const recovered = restoreNight(snapshot, { scheduler: t, access: new TableAccess(), settings: {} });
        assert.deepEqual(recovered.warnings, [], when);
        sel = recovered.tracked[0].sel;
      }
      if (sel) t.rollbackUnplayed(sel); // retrait confirmé par KaraFun
      assert.equal(t.people.get(people.Gil.id).duetGuestCount || 0, 0, `${when} : Gil n’a pas chanté`);
      assert.deepEqual(fixed(t), ['Maud', 'Gil', 'Elsa'], `${when} : Gil reprend sa place devant Elsa`);
      assert.deepEqual(t.manualChanges.map(change => change.name), ['Elsa'], `${when} : les gestes ne changent pas`);
      assert.deepEqual(playNames(t, 3), ['Maud', 'Gil', 'Elsa'], when);
    }
  }
});

// Relecture (passe 3, cellule sans test) : un duo déjà accepté que son
// auteur remet en tête de sa liste, sur une ligne gardée, passe aussi par
// _guestJoined : le duo garde la ligne, celle de l'invitée quitte l'ordre fixé.
test('duo déjà accepté remis en tête de liste sur une ligne gardée : le duo garde la ligne', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
  const duo = s.inviteDuet(people.Paulo, people.Gil.id, song());
  s.answerDuet(people.Gil, true, duo.entryId);
  assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Gil', 'Elsa'], 'duo encore dans la suite de la liste : Gil garde sa ligne');
  s.reorderSongs(people.Paulo, duo.entryId, 0);
  assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Elsa']);
  assert.deepEqual(names(s).slice(0, 3), ['Paulo & Gil', 'Maud', 'Elsa']);
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa']);
});

// Relecture (cellules sans test, comportement correct) : chaque façon de
// former un duo sur le titre en cours d'une ligne gardée passe par
// _guestJoined. Le duo garde la ligne de l'auteur, la propre ligne gardée de
// l'invitée quitte l'ordre fixé (sinon elle chanterait deux fois), les
// gestes ne changent pas.
test('demande de duo acceptée sur une ligne gardée : le duo garde la ligne, celle de l’invitée quitte l’ordre fixé', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
  s.requestDuetJoin(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
  s.answerDuetJoin(people.Paulo, people.Paulo.song.entryId, people.Gil.id, true);
  assert.deepEqual(names(s).slice(0, 3), ['Paulo & Gil', 'Maud', 'Elsa']);
  assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Elsa']);
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa']);
});

// Bea, de la table de Paulo, est gardée devant le geste du bar (Hugo placé en
// dernier) : elle rejoint directement le titre en cours de Paulo.
function tablemate() {
  const { s, people } = evening();
  s.setHeadcount('1', 2);
  const bea = s.join({ tableId: '1', name: 'Bea' });
  s.chooseSong(bea, song());
  gesture(s, people.Hugo, names(s).length - 1);
  return { s, people: { ...people, Bea: bea } };
}

test('duo direct à la même table sur une ligne gardée : le duo garde la ligne, celle de l’invitée quitte l’ordre fixé', () => {
  const { s, people } = tablemate();
  assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Gil', 'Ines', 'Jade', 'Elsa', 'Karim', 'Bea', 'Hugo']);
  assert.equal(s.requestDuetJoin(people.Bea, people.Paulo.id, people.Paulo.song.entryId).direct, true);
  assert.equal(names(s)[0], 'Paulo & Bea');
  assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Gil', 'Ines', 'Jade', 'Elsa', 'Karim', 'Hugo']);
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Hugo']);
});

test('duo ouvert rejoint sur une ligne gardée : le duo garde la ligne, celle du volontaire quitte l’ordre fixé', () => {
  for (const duoOnly of [false, true]) {
    const { s, people } = evening();
    s.duoOnlyRule = () => duoOnly;
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    s.openDuet(people.Paulo, { entryId: people.Paulo.song.entryId });
    s.acceptOpenDuet(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
    assert.deepEqual(names(s).slice(0, 3), ['Paulo & Gil', 'Maud', 'Elsa'], `« Duos uniquement » ${duoOnly}`);
    assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Elsa']);
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa']);
  }
});

// Même relecture : l'invitée qui se retire avant l'envoi rend le titre en
// solo à son auteur, à sa ligne fixée, sans toucher aux gestes, quelle que
// soit la façon dont le duo s'était formé ; sa propre ligne reprend sa place.
test('invitée qui se retire avant l’envoi d’un duo formé sur une ligne gardée : solo à la ligne fixée, gestes inchangés', () => {
  const forms = {
    invitation: ({ s, people }) => {
      const duo = s.inviteDuet(people.Paulo, people.Gil.id, song());
      s.reorderSongs(people.Paulo, duo.entryId, 0);
      s.answerDuet(people.Gil, true, duo.entryId);
    },
    'demande acceptée': ({ s, people }) => {
      s.requestDuetJoin(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
      s.answerDuetJoin(people.Paulo, people.Paulo.song.entryId, people.Gil.id, true);
    },
    'duo ouvert': ({ s, people }) => {
      s.openDuet(people.Paulo, { entryId: people.Paulo.song.entryId });
      s.acceptOpenDuet(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
    },
  };
  for (const [form, make] of Object.entries(forms)) {
    const ctx = evening();
    const { s, people } = ctx;
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    make(ctx);
    assert.equal(names(s)[0], 'Paulo & Gil', form);
    s.leaveDuet(people.Gil, people.Paulo.id, people.Paulo.song.entryId);
    assert.equal(people.Paulo.song.duet, undefined, `${form} : le titre redevient un solo`);
    assert.deepEqual(names(s).slice(0, 4), ['Paulo', 'Maud', 'Gil', 'Elsa'], `${form} : Paulo à sa ligne, Gil à la sienne`);
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa'], form);
  }
  const { s, people } = tablemate();
  s.requestDuetJoin(people.Bea, people.Paulo.id, people.Paulo.song.entryId);
  s.leaveDuet(people.Bea, people.Paulo.id, people.Paulo.song.entryId);
  assert.deepEqual(fixed(s), ['Paulo', 'Maud', 'Gil', 'Ines', 'Jade', 'Elsa', 'Karim', 'Bea', 'Hugo'], 'duo direct : la ligne de Bea revient');
  assert.deepEqual(s.manualChanges.map(change => change.name), ['Hugo']);
});

// Relecture de la correction : un geste rendu par _restorePlaced (duo sorti
// de KaraFun sans être chanté) perdait sa ligne dès que le bar annulait un
// geste fait après lui, alors qu'il restait dans la liste des changements :
// Elsa passait de la 4e place à la dernière.
test('geste rendu après un duo non chanté : annuler un geste plus récent ne lui retire pas sa place', () => {
  for (const later of ['priorité de Hugo', 'déplacement de Ines']) {
    const { s, people } = evening();
    gesture(s, people.Elsa, 3); // Paulo, Maud, Gil, Elsa
    gesture(s, people.Karim, 6); // fait avant l'envoi du duo
    const duo = s.inviteDuet(people.Paulo, people.Elsa.id, song());
    s.reorderSongs(people.Paulo, duo.entryId, 0);
    s.answerDuet(people.Elsa, true, duo.entryId);
    const sel = s.select();
    s.commit(sel); // le geste de Elsa prend fin
    if (later === 'priorité de Hugo') gesture(s, people.Hugo, 0, sel.ids);
    else gesture(s, people.Ines, 4, sel.ids);
    s.requeueUnplayed(sel); // « Pas prêt » : le duo n'a pas été chanté
    s.deferPassage(people.Paulo.id, { entryId: sel.song.entryId, ids: sel.ids }, 1);
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa', 'Karim', later.split(' ').at(-1)]);
    s.undoLastManualChange(null, NATIVE); // le geste fait depuis
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa', 'Karim'], later);
    // L'ordre fixé d'avant l'envoi du duo, moins Paulo dont le titre est reporté.
    assert.deepEqual(fixed(s), ['Maud', 'Gil', 'Elsa', 'Hugo', 'Ines', 'Karim'], `${later} : Elsa garde sa place derrière Maud et Gil`);
    assert.equal(names(s).indexOf('Elsa'), 3, `${later} : derrière Maud, le duo reporté et Gil`);
    s.undoLastManualChange(null, NATIVE); // Karim, geste fait avant l'envoi
    assert.deepEqual(fixed(s), ['Maud', 'Gil', 'Elsa'], `${later} : la place de Elsa tient encore`);
    s.undoLastManualChange(null, NATIVE);
    assert.deepEqual(s.manualOrder, []);
  }
});

// Relecture de la correction : gestes faits pendant le titre de Paulo, puis
// duo improvisé noté avec lui. Annuler un autre de ces gestes rendait ce que
// le duo avait terminé (sa priorité, la ligne gardée où il chantait, son
// annonce comme prochain) : la personne rechantait juste après son duo.
test('duo noté au bar pendant le titre des gestes : annuler un autre geste ne refait pas passer la personne', () => {
  const cases = {
    'priorité': { partner: 'Karim', order: ['Maud', 'Gil', 'Hugo', 'Ines', 'Elsa'], plays: ['Maud', 'Gil', 'Hugo', 'Ines'] },
    'ligne gardée': { partner: 'Gil', order: ['Maud', 'Hugo', 'Ines', 'Elsa'], plays: ['Maud', 'Hugo', 'Ines', 'Elsa'] },
    'prochain annoncé': { partner: 'Maud', order: ['Gil', 'Hugo', 'Ines', 'Elsa'], plays: ['Gil', 'Hugo', 'Ines', 'Elsa'] },
  };
  for (const [kind, { partner, order, plays }] of Object.entries(cases)) {
    const { s, people } = evening();
    const sent = s.select();
    s.commit(sent); // Paulo sur scène
    if (kind === 'prochain annoncé') s.reserveNext();
    gesture(s, people.Elsa, 4, sent.ids); // Maud, Gil, Hugo, Ines, Elsa
    if (kind === 'priorité') gesture(s, people.Karim, 0, sent.ids);
    gesture(s, people.Jade, 6, sent.ids);
    s.staffCountPartner(people.Paulo.id, people[partner].id, sent);
    s.undoLastManualChange(null, NATIVE); // Jade
    assert.deepEqual(s.manualChanges.map(change => change.name), ['Elsa'], kind);
    assert.deepEqual(fixed(s), order, `${kind} : ${partner} reste hors de l’ordre fixé`);
    assert.notEqual(s.reservedNext?.personId, people[partner].id, `${kind} : ${partner} n’est pas annoncé de nouveau`);
    s.songEnded(sent.ids);
    assert.deepEqual(playNames(s, 4), plays, `${kind} : ${partner} ne rechante pas tout de suite`);
  }
});

// Plan Timefold : les rangées jusqu'à la dernière ligne placée sont fixées
// (pinnedUntil), comme un report « Pas prêt ». Faux solveur qui renverse
// tout ce qui n'est pas fixé.
test('un plan adopté ne contredit jamais une ligne placée ni une priorité', async () => {
  const { s, people } = evening({ solverEnabled: true, solverBudgetMs: 100, continuousSolver: false });
  const requests = [];
  s.solverBridge = { available: true, lastError: null, close() {},
    solve: async request => {
      requests.push(request);
      const ids = request.performances.map(row => row.id);
      const order = [...ids.slice(0, request.pinnedUntil), ...ids.slice(request.pinnedUntil).reverse()];
      return { requestId: request.requestId, order, seedScore: '0hard/-100medium/0soft', score: '0hard/-100medium/0soft', elapsedMs: 5 };
    } };
  try {
    gesture(s, people.Elsa, 3);
    gesture(s, people.Karim, 0);
    s.chooseSong(people.Maud, song(), 'append'); // changement réel : nouveau calcul
    s.solverStatus();
    await s.solverPromise;
    const last = requests.at(-1);
    assert.ok(last.pinnedUntil >= 5, `Karim et tout jusqu'à Elsa sont fixés (${last.pinnedUntil})`);
    const shown = names(s);
    assert.equal(shown[0], 'Karim', 'la priorité reste la prochaine après l’adoption du plan');
    assert.equal(shown.indexOf('Elsa'), 4);
  } finally { s.closeSolver(); }
});

test('vrai Timefold : la ligne placée garde sa place après le calcul',
  { skip: !fs.existsSync(JAR) && 'jar Timefold absent' }, async () => {
    const { s, people } = evening({ solverEnabled: true, solverBudgetMs: 1000, continuousSolver: false });
    s.solverBridge = new TimefoldBridge({ settleMs: 0 });
    try {
      for (let i = 0; i < 8; i++) play(s);
      for (const name of ['Paulo', 'Gil', 'Hugo', 'Ines', 'Jade', 'Elsa', 'Karim']) s.chooseSong(people[name], song());
      gesture(s, people.Elsa, 2);
      const placed = names(s).slice(0, 3);
      s.chooseSong(s.join({ tableId: '9', name: 'Zoé', headcount: 1 }), song());
      assert.equal(await s.whenPlanReady(), true, 'un vrai résultat Timefold est appliqué');
      assert.ok(['timefold', 'confirmed'].includes(s.solverPlan.source));
      assert.deepEqual(names(s).slice(0, 3), placed, 'les lignes jusqu’à Elsa ne bougent pas');
      assert.equal(s.select().ids[0], s.people.get(s.manualOrder[0]).id);
    } finally { s.closeSolver(); }
  });

// Décision du gérant du 26 octobre : « Priorité » quand un titre est déjà
// chargé dans KaraFun (envoyé pushDelaySec après le début du titre en cours,
// pas encore commencé). Confirmé par le bar, le titre sort de KaraFun
// (server.js, pullFromKaraFun) ; une fois le retrait confirmé, il revient en
// tête de la liste de son chanteur (requeueUnplayed) et repasse juste après
// la priorité (yieldToPriority), sans perdre son tour ni compter comme un
// « Pas prêt » de sa personne.
function loadedEvening(options = {}) {
  const ctx = evening(options);
  const { s } = ctx;
  const stage = s.select();
  s.commit(stage); // Paulo sur scène
  const loaded = s.select();
  s.commit(loaded); // Maud chargée dans KaraFun
  return { ...ctx, stage, loaded };
}
// KaraFun a retiré le titre : comme restorePulled (server.js), par le même
// Scheduler#returnFromKaraFun. `forId` : personne de la priorité pour
// laquelle il est sorti. Rend le report, ou null (la priorité ne tient plus :
// le titre reprend la tête).
function pulledBack(s, sel, forId) {
  return s.returnFromKaraFun(sel, { forId });
}

// Passe 17 : un titre retiré de KaraFun pour une priorité annulée reprend la
// tête, l'annonce qui le suivait juste derrière lui (`then`) : un plan
// Timefold adopté ne passe pas entre les deux. Faux solveur qui renverse tout
// ce qui n'est pas fixé.
test('passe 17 : plan Timefold, l’annonce gardée derrière le titre revenu de KaraFun reste juste derrière lui', async () => {
  const { s, people } = evening({ solverEnabled: true, solverBudgetMs: 100, continuousSolver: false, requirePresence: true });
  const requests = [];
  s.solverBridge = { available: true, lastError: null, close() {},
    solve: async request => {
      requests.push(request);
      const ids = request.performances.map(row => row.id);
      const order = [...ids.slice(0, request.pinnedUntil), ...ids.slice(request.pinnedUntil).reverse()];
      return { requestId: request.requestId, order, seedScore: '0hard/-100medium/0soft', score: '0hard/-100medium/0soft', elapsedMs: 5 };
    } };
  try {
    for (const p of Object.values(people)) s.confirm(p);
    const stage = s.select(); s.commit(stage); // Paulo sur scène
    s.skipUnconfirmed(people.Maud.id, 3); // Maud, la suivante, manque « Je suis là »
    const loaded = s.select(); s.commit(loaded); // Gil chargé dans KaraFun, Maud annoncée ensuite
    assert.equal(loaded.ids[0], people.Gil.id);
    assert.equal(s.reservedNext?.personId, people.Maud.id);
    const change = gesture(s, people.Karim, 0, stage.ids);
    s.returnFromKaraFun(loaded, { forId: people.Karim.id, forAt: s.reservedNext.reservedAt, changeId: change.id });
    s.undoLastManualChange(null, 'd'.repeat(64));
    assert.equal(s.reservedNext?.personId, people.Gil.id);
    assert.equal(s.reservedNext?.then?.personId, people.Maud.id);
    s.chooseSong(people.Hugo, song(), 'append'); // changement réel : nouveau calcul
    s.solverStatus();
    await s.solverPromise;
    assert.ok(requests.at(-1).pinnedUntil >= 2, `Gil et Maud sont fixés (${requests.at(-1).pinnedUntil})`);
    assert.deepEqual(names(s, stage.ids).slice(0, 2), ['Gil', 'Maud']);
  } finally { s.closeSolver(); }
});

// Passe 17 : deux priorités du bar l'une derrière l'autre (Jade, puis Karim
// gardé derrière elle) ; pendant l'envoi de Jade, Karim dit « Pas prêt », puis
// le bar le déplace et annule ce déplacement une fois Jade chargée. Karim ne
// redevient pas le prochain annoncé pendant son « Pas prêt ».
test('passe 17 : priorité gardée derrière une autre, sa personne dit « Pas prêt » : une annulation ne la rend pas annoncée', () => {
  const { s, people } = evening();
  const move = (person, toIndex, pending) => {
    const before = s.manualOverrideState({ deferrals: true });
    s.staffMove(person.id, toIndex, pending ? pending.ids : [], pending);
    s.recordManualChange({ kind: toIndex === 0 ? 'priority' : 'move', personId: person.id, name: person.name,
      from: 1, to: toIndex + 1, before, native: NATIVE });
  };
  move(people.Karim, 0);
  move(people.Jade, 0);
  assert.equal(s.reservedNext?.then?.personId, people.Karim.id, 'Karim est gardé derrière Jade');
  const pending = s.select();
  assert.equal(pending.ids[0], people.Jade.id);
  const line = s.presenceView(pending.ids, pending).find(v => v.ids[0] === people.Karim.id);
  s.deferPassage(people.Karim.id, line, 3, { extra: 1 });
  assert.notEqual(s.reservedNext?.then?.personId, people.Karim.id, 'son « Pas prêt » le retire de la place gardée');
  move(people.Karim, 3, pending);
  s.commit(pending);
  s.undoLastManualChange(null, 'd'.repeat(64));
  assert.equal(s.isDeferred(people.Karim), true, 'son « Pas prêt » revient avec l’annulation');
  assert.notEqual(s.reservedNext?.personId, people.Karim.id, 'Karim n’est pas annoncé pendant son « Pas prêt »');
});

test('priorité avant un titre chargé : le titre retiré repasse juste après, sans compter comme « Pas prêt »', () => {
  const { s, people, stage, loaded } = loadedEvening();
  const events = [];
  s.onEvent = (type, fields) => events.push({ type, ...fields });
  const maud = people.Maud;
  const qIndex = loaded.turnCredit.before.qIndex;
  gesture(s, people.Karim, 0, stage.ids);
  const yielded = pulledBack(s, loaded, people.Karim.id);
  assert.equal(yielded.afterPriority, true);
  assert.equal(maud.song.entryId, loaded.song.entryId, 'le titre retiré revient en tête de sa liste');
  assert.equal(s.Q.indexOf(maud.id), qIndex, 'son ticket reprend sa place (son attente continue)');
  assert.equal(maud.sung, 0, 'son passage n’a pas eu lieu');
  assert.deepEqual(names(s, stage.ids).slice(0, 3), ['Karim', 'Maud', 'Gil'], 'Karim d’abord, Maud juste après');
  assert.equal(s.deferralFor(maud.id), null, 'pas un « Pas prêt » pour son téléphone');
  assert.equal(s.deferredSongsOf(maud.song), 0, 'rien n’est décompté des cinq reports du titre');
  assert.throws(() => s.cancelDeferral(maud.id), /Aucun passage repoussé/);
  s.songEnded(stage.ids);
  assert.equal(label(s, play(s)), 'Karim');
  assert.equal(s.reservedNext?.personId, maud.id, 'Maud est la prochaine annoncée, comme après un « Pas prêt »');
  assert.equal(maud.deferral, null);
  const next = s.select();
  assert.equal(next.song.entryId, loaded.song.entryId, 'son titre retiré part ensuite');
  assert.deepEqual(events.filter(e => /^defer\./.test(e.type)), [], 'aucun « Pas prêt » au journal de soirée');
});

// Relecture de la correction : le report n'était pas lié à la priorité. Elle
// annulée, « Recalculer la file », son titre retiré ou sa personne partie,
// le titre retiré laissait quand même passer quelqu'un d'autre (Gil) devant
// lui : le bar perdait la place du titre qu'il venait de faire sortir.
test('priorité avant un titre chargé qui ne tient plus : le titre retiré reprend sa place', () => {
  const cases = ['annulée avant le retrait', 'annulée après le retrait', 'Recalculer la file', 'titre retiré',
    'personne partie', 'absente à « Je suis là »'];
  for (const when of cases) {
    const { s, people, stage, loaded } = loadedEvening();
    assert.deepEqual(names(s, stage.ids).slice(0, 2), ['Gil', 'Hugo'], 'Maud est chargée dans KaraFun');
    gesture(s, people.Karim, 0, stage.ids);
    if (when !== 'annulée avant le retrait') {
      assert.equal(pulledBack(s, loaded, people.Karim.id)?.afterPriority, true);
      assert.deepEqual(names(s, stage.ids).slice(0, 2), ['Karim', 'Maud'], `${when} : Karim d’abord, Maud juste après`);
    }
    if (when.startsWith('annulée')) s.undoLastManualChange(null, 'd'.repeat(64));
    if (when === 'Recalculer la file') s.undoAllManualChanges('d'.repeat(64));
    if (when === 'titre retiré') s.staffRemove(people.Karim.id);
    if (when === 'personne partie') s.tableLeft('8');
    if (when === 'absente à « Je suis là »') s.skipUnconfirmed(people.Karim.id);
    if (when === 'annulée avant le retrait') assert.equal(pulledBack(s, loaded, people.Karim.id), null, 'aucun report');
    const order = names(s, stage.ids);
    assert.equal(order[0], 'Maud', `${when} : Maud reprend sa place, en tête`);
    assert.equal(s.isDeferred(people.Maud), false, `${when} : plus rien ne la retient`);
    s.songEnded(stage.ids);
    assert.equal(label(s, play(s)), 'Maud', when);
  }
});

// Relecture (cellules sans test, comportement correct) : Karim, la personne
// de la priorité, chante d'abord en duo noté au bar avec la personne sur
// scène. Sa priorité prend fin (_endPlaced) et ne tient plus
// (_priorityHolds) : le titre retiré pour elle reprend la tête. Le duo noté
// par erreur puis annulé rend la priorité avec son heure d'annonce, à
// laquelle le report du titre retiré est lié : il attend de nouveau derrière
// elle.
test('priorité avant un titre chargé : sa personne chante d’abord en duo noté, le titre retiré reprend la tête', () => {
  const { s, people, stage, loaded } = loadedEvening();
  gesture(s, people.Karim, 0, stage.ids);
  pulledBack(s, loaded, people.Karim.id);
  assert.equal(s.isDeferred(people.Maud), true);
  s.staffCountPartner(stage.ids[0], people.Karim.id, stage);
  assert.notEqual(s.reservedNext?.personId, people.Karim.id, 'la priorité de Karim prend fin');
  // Passe 17 : le titre retiré, chargé avant elle, redevient le prochain annoncé.
  assert.equal(s.reservedNext?.personId, people.Maud.id, 'le titre retiré est le prochain annoncé');
  assert.equal(names(s, stage.ids)[0], 'Maud');
  assert.equal(s.isDeferred(people.Maud), false, 'plus rien ne retient le titre retiré');
  s.songEnded(stage.ids);
  assert.equal(label(s, play(s)), 'Maud');
});

test('priorité avant un titre chargé : duo noté par erreur puis annulé, la priorité et le report reviennent', () => {
  const { s, people, stage, loaded } = loadedEvening();
  gesture(s, people.Karim, 0, stage.ids);
  pulledBack(s, loaded, people.Karim.id);
  const reservedAt = s.reservedNext.reservedAt;
  s.staffCountPartner(stage.ids[0], people.Karim.id, stage);
  s.staffUncountPartner(stage.staffDuo, stage, [stage]);
  assert.equal(s.reservedNext?.personId, people.Karim.id, 'sa priorité revient');
  assert.equal(s.reservedNext.byStaff, true);
  assert.equal(s.reservedNext.reservedAt, reservedAt, 'avec son heure d’annonce');
  assert.deepEqual(names(s, stage.ids).slice(0, 2), ['Karim', 'Maud']);
  assert.equal(s.isDeferred(people.Maud), true, 'le titre retiré attend de nouveau derrière elle');
  s.songEnded(stage.ids);
  assert.deepEqual(playNames(s, 2), ['Karim', 'Maud']);
});

test('priorité avant un titre chargé qui ne tient plus, puis « Pas prêt » : seul le report demandé compte', () => {
  const { s, people, stage, loaded } = loadedEvening();
  const maud = people.Maud;
  gesture(s, people.Karim, 0, stage.ids);
  pulledBack(s, loaded, people.Karim.id);
  s.undoLastManualChange(null, 'd'.repeat(64));
  s.deferPassage(maud.id, { entryId: maud.song.entryId, ids: [maud.id] }, 1);
  assert.equal(maud.deferral.remaining, 1, 'le report de la priorité annulée ne s’ajoute pas');
  assert.equal(maud.deferral.afterPriority, undefined);
  assert.equal(s.deferralFor(maud.id)?.remaining, 1);
});

test('priorité avant un titre chargé : « Je suis là » déjà donné tient, pas d’absence comptée', () => {
  const { s, people } = evening({ requirePresence: true });
  for (const p of Object.values(people)) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  const loaded = s.select(); s.commit(loaded);
  const maud = people.Maud;
  assert.equal(maud.confirmedAt, 0, 'l’envoi efface la confirmation');
  gesture(s, people.Karim, 0, stage.ids);
  pulledBack(s, loaded, people.Karim.id);
  assert.ok(maud.confirmedAt > 0, 'la confirmation donnée pour ce titre tient');
  s.songEnded(stage.ids);
  s.confirm(people.Karim);
  s.commit(s.select()); // Karim
  assert.equal(maud.held, 0, 'pas compté absent pendant la priorité');
  assert.equal(s.reservedNext?.personId, maud.id);
  assert.equal(s.select()?.song.entryId, loaded.song.entryId, 'sa confirmation suffit pour partir');
});

test('priorité avant un duo chargé : le duo revient entier, juste après', () => {
  const { s, people } = evening();
  const duo = s.inviteDuet(people.Maud, people.Gil.id, song());
  s.reorderSongs(people.Maud, duo.entryId, 0);
  s.answerDuet(people.Gil, true, duo.entryId);
  const stage = s.select(); s.commit(stage); // Paulo
  const loaded = s.select(); s.commit(loaded);
  assert.equal(label(s, loaded), 'Maud & Gil');
  assert.equal(people.Gil.duetGuestCount, 1);
  gesture(s, people.Karim, 0, stage.ids);
  pulledBack(s, loaded, people.Karim.id);
  assert.equal(people.Gil.duetGuestCount, 0, 'le passage de l’invitée n’a pas eu lieu');
  assert.deepEqual(names(s, stage.ids).slice(0, 2), ['Karim', 'Maud & Gil']);
  s.songEnded(stage.ids);
  play(s);
  assert.deepEqual(s.select().ids, [people.Maud.id, people.Gil.id]);
});

// Relecture : le titre chargé dont l'envoi avait levé le « Pas prêt » de la
// personne prioritaire (annoncée ensuite) défaisait la priorité une fois
// retiré de KaraFun : le report revenait, la priorité du bar était libérée,
// et le titre retiré repartait le premier, à l'inverse de ce que le bar
// venait de confirmer.
test('priorité avant un titre chargé qui avait levé le « Pas prêt » de la personne : elle passe d’abord', () => {
  for (const whose of ['son propre titre', 'le duo où elle est invitée']) {
    const { s, people } = evening();
    const { Maud, Hugo } = people;
    let deferred = Maud;
    if (whose !== 'son propre titre') {
      const duo = s.inviteDuet(Maud, Hugo.id, song());
      s.reorderSongs(Maud, duo.entryId, 0);
      s.answerDuet(Hugo, true, duo.entryId);
    }
    const stage = s.select(); s.commit(stage); // Paulo sur scène
    s.deferPassage(Maud.id, { entryId: Maud.song.entryId, ids: whose === 'son propre titre' ? [Maud.id] : [Maud.id, Hugo.id] }, 1);
    const loaded = s.select(); s.commit(loaded);
    assert.equal(label(s, loaded), 'Gil', `${whose} : Gil chargé dans KaraFun`);
    assert.equal(s.reservedNext?.personId, Maud.id, `${whose} : l’envoi de Gil lève le report, Maud est annoncée`);
    const prioritized = whose === 'son propre titre' ? Maud : Hugo;
    gesture(s, prioritized, 0, stage.ids);
    const yielded = pulledBack(s, loaded, prioritized.id);
    assert.equal(yielded?.afterPriority, true, `${whose} : le titre retiré attend la priorité`);
    assert.equal(s.reservedNext?.personId, prioritized.id, `${whose} : la priorité du bar tient`);
    assert.equal(s.reservedNext?.byStaff, true, whose);
    assert.equal(s.isDeferred(deferred), false, `${whose} : le report levé ne revient pas`);
    s.songEnded(stage.ids);
    assert.equal(label(s, play(s)), prioritized.name, `${whose} : ${prioritized.name} passe d’abord`);
    assert.equal(label(s, play(s)), 'Gil', `${whose} : Gil, retiré pour elle, juste après`);
  }
});

// Relecture (passe 6) : même cas quand la personne sortie d'un « Pas prêt »
// est l'invitée du duo que le bar met en priorité. Le report de son propre
// titre revenait (seule la personne de la ligne placée comptait) : il
// retenait le duo prioritaire, quelqu'un d'autre partait pendant que la
// priorité restait annoncée, et le titre retiré pour elle perdait sa place.
// Sans retrait aussi, quand le titre chargé revient (absente à l'appel).
test('priorité sur un duo dont l’invité sortait d’un « Pas prêt » : le duo passe d’abord, le titre retiré juste après', async t => {
  for (const how of ['retiré pour la priorité', 'absente à l’appel']) await t.test(how, () => {
    const { s, people } = evening();
    const { Karim, Hugo } = people;
    const duo = s.inviteDuet(Karim, Hugo.id, song());
    s.reorderSongs(Karim, duo.entryId, 0);
    s.answerDuet(Hugo, true, duo.entryId);
    const stage = s.select(); s.commit(stage); // Paulo sur scène
    s.deferPassage(Hugo.id, { entryId: Hugo.song.entryId, ids: [Hugo.id] }, 1);
    const loaded = s.select(); s.commit(loaded);
    assert.equal(label(s, loaded), 'Maud', `${how} : Maud chargée dans KaraFun`);
    assert.equal(s.reservedNext?.personId, Hugo.id, `${how} : l’envoi de Maud lève le report de Hugo`);
    gesture(s, Karim, 0, stage.ids);
    if (how === 'retiré pour la priorité') assert.equal(pulledBack(s, loaded, Karim.id)?.afterPriority, true, how);
    else { s.rollbackUnplayed(loaded); s.putBackFirst(people.Maud, loaded.song); }
    assert.equal(s.isDeferred(Hugo), false, `${how} : le report levé de l’invité ne revient pas`);
    assert.equal(s.deferralFor(Hugo.id), null, how);
    assert.deepEqual(names(s, stage.ids).slice(0, 2), ['Karim & Hugo', 'Maud'], `${how} : annonce`);
    s.songEnded(stage.ids);
    assert.deepEqual(playNames(s, 2), ['Karim & Hugo', 'Maud'], how);
  });
});

// Relecture (passe 6, équipe rouge) : une « Priorité » du bar sur un duo
// dont l'invitée est retenue par un report ne partait jamais. Son titre
// retiré de KaraFun pour cette priorité (elle la rejoint ensuite en duo), ou
// son propre « Pas prêt » : quelqu'un d'autre partait à chaque passage
// pendant que toute la salle voyait la priorité comme prochain confirmé,
// jusqu'à l'échéance de sécurité du report. Le geste du bar l'emporte, comme
// sur le « Pas prêt » de la personne placée (staffMove) : le duo prioritaire
// part, et la file annoncée le dit.
test('priorité sur un duo dont l’invitée est retenue par un report : le duo part d’abord, comme annoncé', async t => {
  const cases = ['titre retiré, duo ouvert rejoint', 'titre retiré, demande de duo acceptée', '« Pas prêt », duo ouvert rejoint',
    '« Pas prêt », présence obligatoire'];
  for (const how of cases) await t.test(how, () => {
    const presence = how.endsWith('présence obligatoire');
    const ctx = presence ? evening({ requirePresence: true }) : evening();
    const { s, people } = ctx;
    const { Karim, Maud } = people;
    const confirmAll = () => { if (presence) for (const p of Object.values(people)) s.confirm(p); };
    confirmAll();
    const stage = s.select(); s.commit(stage); // Paulo sur scène
    if (how.startsWith('titre retiré')) {
      const loaded = s.select(); s.commit(loaded); // Maud chargée dans KaraFun
      gesture(s, Karim, 0, stage.ids);
      assert.equal(pulledBack(s, loaded, Karim.id)?.afterPriority, true, how);
    } else {
      s.deferPassage(Maud.id, { entryId: Maud.song.entryId, ids: [Maud.id] }, 2);
      gesture(s, Karim, 0, stage.ids);
    }
    assert.ok(s.isDeferred(Maud), `${how} : Maud est retenue par un report`);
    if (how.includes('demande de duo')) {
      s.requestDuetJoin(Maud, Karim.id, Karim.song.entryId);
      s.answerDuetJoin(Karim, Karim.song.entryId, Maud.id, true);
    } else {
      s.openDuet(Karim, { entryId: Karim.song.entryId });
      s.acceptOpenDuet(Maud, Karim.id, Karim.song.entryId);
    }
    // Comme sync() à chaque balayage, pendant le titre de Paulo puis scène
    // libre (relecture, passe 10) : la priorité du bar tient malgré le
    // « Pas prêt » de l'invitée.
    if (presence) s.reservePresenceNext(stage.ids);
    assert.equal(s.reservedNext?.byStaff, true, `${how} : la priorité du bar tient`);
    const announced = names(s, stage.ids).slice(0, 3);
    assert.equal(announced[0], 'Karim & Maud', `${how} : la file annonce le duo prioritaire en premier`);
    s.songEnded(stage.ids);
    if (presence) s.reservePresenceNext([]);
    assert.equal(s.reservedNext?.byStaff, true, `${how} : la priorité du bar tient, scène libre`);
    confirmAll();
    const sends = [];
    for (let k = 0; k < 3; k++) {
      sends.push(label(s, play(s)));
      confirmAll();
    }
    assert.deepEqual(sends, announced, `${how} : les passages suivent la file annoncée`);
    assert.equal(sends[0], 'Karim & Maud', `${how} : le duo prioritaire part d’abord`);
    assert.ok(!sends[1].split(' & ').includes('Maud'), `${how} : Maud ne rechante pas aussitôt (${sends.join(', ')})`);
  });
});

// Relecture (passe 13, équipe rouge) : « Priorité » avec retrait pendant
// qu'un titre passé faute de « Je suis là » attend son tour. À l'envoi de la
// priorité, ce titre prend l'annonce (_commit) ; le report du titre retiré,
// lié à la priorité (_priorityHolds), ne tenait plus et le titre retombait
// derrière les nouveaux venus, alors que la file montrée au bar et aux
// téléphones (_forecast) le faisait passer juste après. Il attend maintenant
// le passage suivant, comme la file le montre.
test('priorité avant un titre chargé, un titre passé faute de « Je suis là » en attente : les envois suivent la file montrée', () => {
  const s = new Scheduler({ requirePresence: true });
  const join = (tableId, name) => { const p = s.join({ tableId, name, headcount: 1 }); s.chooseSong(p, song()); return p; };
  ['Ana', 'Bob', 'Cy', 'Dan', 'Eve', 'Fay', 'Gus'].forEach((name, i) => join(String(i + 1), name));
  const head = (exclude = []) => s.presenceView(exclude).find(v => !v.future && v.song);
  const shown = (exclude = []) => s.presenceView(exclude).filter(v => !v.future && v.song).map(v => v.name);
  const ended = sel => { s.songEnded(sel.ids); s.endStage(sel); };
  // Premier tour : chacun confirme, chante et choisit un autre titre ; Gus chante encore.
  let onStage = null;
  for (let i = 0; i < 7; i++) {
    s.reservePresenceNext([]);
    s.confirm(s.people.get(head().ids[0]));
    const sel = s.select({ stageFree: true });
    s.commit(sel); s.recordStage(sel);
    s.chooseSong(s.people.get(sel.ids[0]), song(), 'append');
    if (i < 6) ended(sel); else onStage = sel;
  }
  // Ana confirme pendant le titre de Gus, puis dit « Pas prêt » d'une chanson.
  s.reservePresenceNext(onStage.ids);
  const ana = s.people.get(head(onStage.ids).ids[0]);
  assert.equal(ana.name, 'Ana');
  s.confirm(ana);
  s.deferPassage(ana.id, head(onStage.ids), 1);
  ended(onStage);
  // Scène libre : Bob, Cy puis Dan ne répondent pas à « Je suis là » (skipAbsentIfDue).
  for (let k = 0; k < 3; k++) { s.reservePresenceNext([]); s.skipUnconfirmed(head().ids[0], 3); }
  s.reservePresenceNext([]);
  s.confirm(s.people.get(head().ids[0]));
  const stage = s.select({ stageFree: true });
  s.commit(stage); s.recordStage(stage);
  s.reservePresenceNext(stage.ids);
  s.confirm(s.people.get(head(stage.ids).ids[0]));
  const loaded = s.select({ stageFree: false });
  s.commit(loaded);
  assert.deepEqual([label(s, stage), label(s, loaded)], ['Eve', 'Bob'], 'Eve sur scène, Bob chargé derrière elle');
  assert.deepEqual(s._presenceRetries().map(pid => s.people.get(pid).name), ['Dan'], 'Cy annoncée, Dan attend son tour');
  join('8', 'Noa'); join('9', 'Max');
  gesture(s, ana, 0, stage.ids);
  assert.equal(pulledBack(s, loaded, ana.id)?.afterPriority, true, 'le titre de Bob sort de KaraFun pour Ana');
  const forecast = shown(stage.ids);
  assert.deepEqual(forecast.slice(0, 3), ['Ana', 'Dan', 'Bob'], 'Bob juste après Dan, déjà dû');
  // Ana part derrière Eve, puis chacun confirme quand vient son tour, scène libre.
  s.reservePresenceNext(stage.ids);
  let sel = s.select({ stageFree: false });
  const sends = [label(s, sel)];
  s.commit(sel);
  ended(stage); s.recordStage(sel); ended(sel);
  // Passe 19 : il attend dans la chaîne des annonces, juste derrière Dan.
  assert.equal(s.reservedNext?.then?.personId, loaded.ids[0], 'après Ana, le titre retiré attend encore un passage, juste derrière Dan');
  for (let k = 0; k < 4; k++) {
    s.reservePresenceNext([]);
    for (const pid of head().ids) s.confirm(s.people.get(pid));
    sel = s.select({ stageFree: true });
    sends.push(label(s, sel));
    s.commit(sel); s.recordStage(sel); ended(sel);
  }
  assert.deepEqual(sends, forecast.slice(0, 5), 'les envois suivent la file montrée après le retrait');
});

// Relecture (passe 13, équipe rouge) : duo mis en priorité par le bar malgré
// le « Pas prêt » de son invitée, chargé, puis retiré de KaraFun pour une
// autre priorité. Le retour du duo rendait le report de l'invitée, que la
// priorité du bar avait passé outre et que l'envoi du duo avait fini : il
// retenait le duo (_heldFor), qui passait en dernier, contrairement à ce que
// le bar venait de confirmer (« il repasse juste après »).
test('duo en priorité malgré le « Pas prêt » de l’invitée, chargé puis retiré pour une autre priorité : il repasse juste après elle', () => {
  const s = new Scheduler();
  const join = (tableId, name) => { const p = s.join({ tableId, name, headcount: 1 }); s.chooseSong(p, song()); return p; };
  const [fay, , bob, , dan] = ['Fay', 'Ana', 'Bob', 'Cy', 'Dan', 'Eve'].map((name, i) => join(String(i + 1), name));
  let stage = null;
  for (let i = 0; i < 6; i++) {
    const sel = s.select({ stageFree: true });
    s.commit(sel); s.recordStage(sel);
    s.chooseSong(s.people.get(sel.ids[0]), song(), 'append');
    if (i < 5) { s.songEnded(sel.ids); s.endStage(sel); } else stage = sel;
  }
  assert.equal(label(s, stage), 'Eve');
  const duo = s.inviteDuet(bob, fay.id, song());
  s.answerDuet(fay, true, duo.entryId);
  s.reorderSongs(bob, duo.entryId, 0);
  const first = s.presenceView([], null).find(v => !v.future && !s.isDeferred(s.people.get(v.ids[0])));
  assert.deepEqual(first.ids, [fay.id], 'la ligne de Fay est la prochaine');
  s.deferPassage(fay.id, first, 2);
  gesture(s, bob, 0, stage.ids);
  const loaded = s.select({ stageFree: false });
  assert.equal(label(s, loaded), 'Bob & Fay', 'la priorité du bar passe outre le report de Fay');
  s.commit(loaded); // chargé derrière Eve
  gesture(s, dan, 0, stage.ids);
  assert.equal(pulledBack(s, loaded, dan.id)?.afterPriority, true, 'le duo sort de KaraFun pour Dan');
  assert.equal(s.isDeferred(fay), false, 'le report de Fay, passé outre par le bar, ne revient pas');
  assert.deepEqual(names(s, stage.ids).slice(0, 2), ['Dan', 'Bob & Fay'], 'Dan d’abord, le duo juste après');
  s.songEnded(stage.ids); s.endStage(stage);
  assert.deepEqual(playNames(s, 2), ['Dan', 'Bob & Fay']);
});

// Relecture (passe 14) : même cas quand le bar donne la priorité à Dan pendant
// l'envoi du duo (avant l'accusé de KaraFun). À l'accusé, l'annonce était
// déjà celle de Dan : le passage n'était pas noté parti comme priorité du
// bar, et son retour rendait le report de Fay.
test('duo en priorité malgré le « Pas prêt » de l’invitée, autre priorité pendant son envoi, puis retiré pour elle : il repasse juste après', () => {
  const s = new Scheduler();
  const join = (tableId, name) => { const p = s.join({ tableId, name, headcount: 1 }); s.chooseSong(p, song()); return p; };
  const [fay, , bob, , dan] = ['Fay', 'Ana', 'Bob', 'Cy', 'Dan', 'Eve'].map((name, i) => join(String(i + 1), name));
  let stage = null;
  for (let i = 0; i < 6; i++) {
    const sel = s.select({ stageFree: true });
    s.commit(sel); s.recordStage(sel);
    s.chooseSong(s.people.get(sel.ids[0]), song(), 'append');
    if (i < 5) { s.songEnded(sel.ids); s.endStage(sel); } else stage = sel;
  }
  const duo = s.inviteDuet(bob, fay.id, song());
  s.answerDuet(fay, true, duo.entryId);
  s.reorderSongs(bob, duo.entryId, 0);
  s.deferPassage(fay.id, s.presenceView([], null).find(v => !v.future && !s.isDeferred(s.people.get(v.ids[0]))), 2);
  gesture(s, bob, 0, stage.ids);
  const loaded = s.select({ stageFree: false }); // envoi du duo en cours
  assert.equal(label(s, loaded), 'Bob & Fay');
  // Priorité de Dan pendant l'envoi (route du bar : passage en cours d'envoi exclu, prévision avec lui).
  const visible = s.presenceView([...stage.ids, ...loaded.ids], loaded).filter(v => !v.future);
  const before = s.manualOverrideState({ deferrals: true });
  s.staffMove(dan.id, 0, [...stage.ids, ...loaded.ids], loaded);
  s.recordManualChange({ kind: 'priority', personId: dan.id, name: 'Dan', from: visible.findIndex(v => v.ids[0] === dan.id) + 1,
    to: 1, before, native: NATIVE });
  s.commit(loaded); // KaraFun accuse l'envoi : le duo est chargé
  gesture(s, dan, 0, stage.ids);
  assert.equal(pulledBack(s, loaded, dan.id)?.afterPriority, true, 'le duo sort de KaraFun pour Dan');
  assert.equal(s.isDeferred(fay), false, 'le report de Fay, passé outre par la priorité du duo, ne revient pas');
  assert.deepEqual(names(s, stage.ids).slice(0, 2), ['Dan', 'Bob & Fay']);
  s.songEnded(stage.ids); s.endStage(stage);
  assert.deepEqual(playNames(s, 2), ['Dan', 'Bob & Fay']);
});

// Contrepartie : priorité du duo annulée par le bar pendant son envoi. Le duo
// n'est plus parti comme priorité du bar ; ressorti sans être chanté, il rend
// le « Pas prêt » de Fay que son envoi avait fini. Et un duo parti hors
// priorité du bar rend, lui aussi, le report fini par son envoi (relecture,
// passe 14, cellule sans test).
test('duo en priorité malgré le « Pas prêt » de l’invitée, priorité annulée pendant son envoi, ressorti : le report revient', () => {
  const s = new Scheduler();
  const join = (tableId, name) => { const p = s.join({ tableId, name, headcount: 1 }); s.chooseSong(p, song()); return p; };
  const [fay, , bob] = ['Fay', 'Ana', 'Bob', 'Cy', 'Dan', 'Eve'].map((name, i) => join(String(i + 1), name));
  let stage = null;
  for (let i = 0; i < 6; i++) {
    const sel = s.select({ stageFree: true });
    s.commit(sel); s.recordStage(sel);
    s.chooseSong(s.people.get(sel.ids[0]), song(), 'append');
    if (i < 5) { s.songEnded(sel.ids); s.endStage(sel); } else stage = sel;
  }
  const duo = s.inviteDuet(bob, fay.id, song());
  s.answerDuet(fay, true, duo.entryId);
  s.reorderSongs(bob, duo.entryId, 0);
  s.deferPassage(fay.id, s.presenceView([], null).find(v => !v.future && !s.isDeferred(s.people.get(v.ids[0]))), 2);
  const priority = gesture(s, bob, 0, stage.ids);
  const loaded = s.select({ stageFree: false });
  assert.equal(label(s, loaded), 'Bob & Fay');
  assert.equal(loaded.staffPick, priority.id, 'choisi sous le geste de priorité du bar');
  s.undoLastManualChange(null, NATIVE, { excludeIds: [...stage.ids, ...loaded.ids] }); // le bar annule pendant l'envoi
  s.commit(loaded);
  assert.equal(s.isDeferred(fay), false, 'l’envoi du duo finit le report de Fay');
  s.requeueUnplayed(loaded); // absent à l'appel, titre passé dans KaraFun
  assert.equal(s.isDeferred(fay), true, 'la priorité annulée, le report de Fay revient');
});

// Relecture (passe 15) : même cas quand le bar avait d'abord déplacé le duo.
// Ce déplacement reste noté après l'annulation de la priorité : il ne fait pas
// du duo une priorité du bar, le « Pas prêt » de Fay revient quand même.
test('duo déplacé puis mis en priorité malgré le « Pas prêt » de l’invitée, priorité annulée pendant son envoi, ressorti : le report revient', () => {
  const s = new Scheduler();
  const join = (tableId, name) => { const p = s.join({ tableId, name, headcount: 1 }); s.chooseSong(p, song()); return p; };
  const [fay, , bob] = ['Fay', 'Ana', 'Bob', 'Cy', 'Dan', 'Eve'].map((name, i) => join(String(i + 1), name));
  let stage = null;
  for (let i = 0; i < 6; i++) {
    const sel = s.select({ stageFree: true });
    s.commit(sel); s.recordStage(sel);
    s.chooseSong(s.people.get(sel.ids[0]), song(), 'append');
    if (i < 5) { s.songEnded(sel.ids); s.endStage(sel); } else stage = sel;
  }
  const duo = s.inviteDuet(bob, fay.id, song());
  s.answerDuet(fay, true, duo.entryId);
  s.reorderSongs(bob, duo.entryId, 0);
  s.deferPassage(fay.id, s.presenceView([], null).find(v => !v.future && !s.isDeferred(s.people.get(v.ids[0]))), 2);
  assert.deepEqual(names(s, stage.ids), ['Ana', 'Cy', 'Fay', 'Dan', 'Bob & Fay']);
  gesture(s, bob, 3, stage.ids); // d'abord un déplacement d'une place
  const priority = gesture(s, bob, 0, stage.ids); // puis « Priorité »
  const loaded = s.select({ stageFree: false });
  assert.equal(label(s, loaded), 'Bob & Fay');
  assert.equal(loaded.staffPick, priority.id);
  s.undoLastManualChange(null, NATIVE, { excludeIds: [...stage.ids, ...loaded.ids] }); // le bar annule la priorité pendant l'envoi
  assert.deepEqual(s.manualChanges.map(change => change.kind), ['move'], 'le déplacement reste noté');
  s.commit(loaded);
  assert.equal(loaded.staffSent, undefined, 'la priorité annulée : pas parti comme priorité du bar');
  assert.equal(s.isDeferred(fay), false, 'l’envoi du duo finit le report de Fay');
  s.requeueUnplayed(loaded); // absent à l'appel, titre passé dans KaraFun
  assert.equal(s.isDeferred(fay), true, 'le « Pas prêt » de Fay revient malgré le déplacement resté noté');
  assert.notEqual(names(s, stage.ids)[0], 'Fay', 'son titre ne passe pas en tête');
});

// Relecture (passe 15, cellules sans test) : seul compte le geste de priorité
// sous lequel le duo est parti. Un autre geste du bar pendant l'envoi ne le
// remplace pas ; « Recalculer la file » pendant l'envoi l'annule, le « Pas
// prêt » de Fay revient.
test('duo en priorité malgré le « Pas prêt » de l’invitée : autre ligne déplacée pendant son envoi, priorité tenue ; « Recalculer la file » pendant son envoi, report rendu', () => {
  for (const [during, staffSent] of [['autre ligne déplacée', true], ['Recalculer la file', undefined]]) {
    const s = new Scheduler();
    const join = (tableId, name) => { const p = s.join({ tableId, name, headcount: 1 }); s.chooseSong(p, song()); return p; };
    const [fay, , bob, , dan] = ['Fay', 'Ana', 'Bob', 'Cy', 'Dan', 'Eve'].map((name, i) => join(String(i + 1), name));
    let stage = null;
    for (let i = 0; i < 6; i++) {
      const sel = s.select({ stageFree: true });
      s.commit(sel); s.recordStage(sel);
      s.chooseSong(s.people.get(sel.ids[0]), song(), 'append');
      if (i < 5) { s.songEnded(sel.ids); s.endStage(sel); } else stage = sel;
    }
    const duo = s.inviteDuet(bob, fay.id, song());
    s.answerDuet(fay, true, duo.entryId);
    s.reorderSongs(bob, duo.entryId, 0);
    s.deferPassage(fay.id, s.presenceView([], null).find(v => !v.future && !s.isDeferred(s.people.get(v.ids[0]))), 2);
    const priority = gesture(s, bob, 0, stage.ids);
    const loaded = s.select({ stageFree: false });
    assert.equal(loaded.staffPick, priority.id, during);
    const sending = [...stage.ids, ...loaded.ids];
    if (staffSent) {
      // Route du bar : passage en cours d'envoi exclu, prévision avec lui.
      const visible = s.presenceView(sending, loaded).filter(v => !v.future);
      const before = s.manualOverrideState({ deferrals: true });
      s.staffMove(dan.id, 1, sending, loaded);
      s.recordManualChange({ kind: 'move', personId: dan.id, name: 'Dan', from: visible.findIndex(v => v.ids[0] === dan.id) + 1,
        to: 2, before, native: NATIVE });
      assert.deepEqual(s.manualChanges.map(change => change.kind), ['priority', 'move'], during);
    } else {
      s.undoAllManualChanges(NATIVE, { excludeIds: sending });
      assert.equal(s.manualChanges.length, 0, during);
    }
    s.commit(loaded);
    assert.equal(loaded.staffSent, staffSent, during);
    assert.equal(s.isDeferred(fay), false, `${during} : l’envoi du duo finit le report de Fay`);
    s.requeueUnplayed(loaded); // absent à l'appel, titre passé dans KaraFun
    assert.equal(s.isDeferred(fay), !staffSent, `${during} : le report de Fay ${staffSent ? 'ne revient pas' : 'revient'}`);
  }
});

test('duo parti hors priorité du bar, « Pas prêt » de l’invité rendu pendant l’envoi et fini par l’accusé, duo ressorti : le report revient', () => {
  const s = new Scheduler({ solverEnabled: false });
  const [cid, ana, bob, dan] = ['Cid', 'Ana', 'Bob', 'Dan'].map((name, i) => s.join({ tableId: String(i + 1), name, headcount: 1 }));
  s.chooseSong(cid, song());
  const duo = s.inviteDuet(ana, bob.id, song()); s.answerDuet(bob, true, duo.entryId);
  [bob, dan].forEach(p => s.chooseSong(p, song()));
  s.deferPassage(bob.id, s.presenceView().find(v => !v.future && v.ids[0] === bob.id), 3);
  gesture(s, bob, s.presenceView().filter(v => !v.future).length - 1);
  const sing = () => { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); return label(s, sel); };
  assert.deepEqual([sing(), sing()], ['Cid', 'Dan']);
  const sending = s.select();
  assert.equal(label(s, sending), 'Ana & Bob');
  assert.equal(sending.staffPick, undefined, 'pas une priorité du bar');
  s.undoLastManualChange(null, NATIVE, { excludeIds: sending.consumedIds || sending.ids.slice(0, 1) });
  assert.equal(s.isDeferred(bob), true);
  s.commit(sending);
  assert.equal(s.isDeferred(bob), false);
  s.requeueUnplayed(sending);
  assert.equal(s.isDeferred(bob), true, 'le duo n’a pas eu lieu : le « Pas prêt » de Bob revient');
});

// Relecture (passe 3, cellule sans test) : le bar déplace lui-même le titre
// retiré pour une priorité. Son report prend fin (staffMove) sans compter
// comme un « Pas prêt » au journal de soirée, et une annulation exacte du
// déplacement le rend tel quel.
test('priorité avant un titre chargé, puis le bar déplace le titre retiré : report levé sans « Pas prêt »', () => {
  const { s, people, stage, loaded } = loadedEvening();
  const events = [];
  s.onEvent = type => events.push(type);
  gesture(s, people.Karim, 0, stage.ids);
  pulledBack(s, loaded, people.Karim.id);
  assert.equal(people.Maud.deferral?.afterPriority, true);
  gesture(s, people.Maud, 3, stage.ids);
  assert.equal(people.Maud.deferral, null, 'le bar place lui-même le titre : le report prend fin');
  assert.deepEqual(names(s, stage.ids).slice(0, 4), ['Karim', 'Gil', 'Hugo', 'Maud']);
  assert.deepEqual(events.filter(type => type.startsWith('defer.')), [], 'aucun « Pas prêt » au journal de soirée');
  s.undoLastManualChange(null, NATIVE);
  assert.equal(people.Maud.deferral?.afterPriority, true, 'l’annulation exacte rend le report');
  assert.equal(s.isDeferred(people.Maud), true);
  assert.deepEqual(names(s, stage.ids).slice(0, 2), ['Karim', 'Maud']);
});

test('priorité avant un titre chargé : le report survit à un redémarrage', () => {
  const { s, access, people, stage, loaded } = loadedEvening();
  gesture(s, people.Karim, 0, stage.ids);
  pulledBack(s, loaded, people.Karim.id);
  const resumed = restart(s, access);
  assert.deepEqual(resumed.warnings, []);
  assert.equal(resumed.people.get(people.Maud.id).deferral?.afterPriority, true);
  assert.deepEqual(names(resumed, stage.ids).slice(0, 2), ['Karim', 'Maud']);
  resumed.songEnded(stage.ids);
  resumed.commit(resumed.select());
  assert.equal(resumed.reservedNext?.personId, people.Maud.id);
});

// Relecture (passe 7, test manquant) : pendant l'envoi d'un duo prioritaire
// dont l'invitée a son propre report (« Pas prêt », ou titre retiré pour la
// priorité), la prévision lève ce report comme l'accusé de KaraFun le fera
// (_commit) : la file vue pendant l'envoi ne bouge pas à l'accusé.
test('priorité sur un duo dont l’invitée est retenue par un report : pendant l’envoi, la prévision est celle d’après l’accusé', async t => {
  for (const how of ['« Pas prêt »', 'titre retiré']) await t.test(how, () => {
    const { s, people } = evening();
    const { Karim, Maud } = people;
    const stage = s.select(); s.commit(stage); // Paulo sur scène
    if (how === '« Pas prêt »') {
      s.deferPassage(Maud.id, { entryId: Maud.song.entryId, ids: [Maud.id] }, 2);
      gesture(s, Karim, 0, stage.ids);
    } else {
      const loaded = s.select(); s.commit(loaded);
      gesture(s, Karim, 0, stage.ids);
      assert.equal(pulledBack(s, loaded, Karim.id)?.afterPriority, true);
    }
    s.openDuet(Karim, { entryId: Karim.song.entryId });
    s.acceptOpenDuet(Maud, Karim.id, Karim.song.entryId);
    s.songEnded(stage.ids);
    const sel = s.select();
    assert.equal(label(s, sel), 'Karim & Maud');
    const during = names(s, sel.consumedIds, sel);
    s.commit(sel);
    assert.deepEqual(during, names(s), `${how} : la file vue pendant l’envoi ne bouge pas à l’accusé`);
  });
});

// Relecture (passe 7, test manquant) : « Retirer » du bar sur la ligne d'une
// personne sans titre suivant, gestes en vigueur : les autres lignes gardent
// leur place (staffRemove passe par _carryPlanAcross).
test('« Retirer » du bar sur une ligne sans titre suivant, gestes en vigueur : les autres lignes ne bougent pas', () => {
  const s = new Scheduler(); s._event = () => {};
  let n = 1; const people = {};
  for (const [table, counts] of [['1', [1, 3, 1]], ['2', [1, 3, 1]], ['3', [3, 1, 2]]]) {
    s.setHeadcount(table, 3);
    counts.forEach((count, i) => {
      const p = s.join({ tableId: table, name: `P${table}${i}` }); people[p.name] = p;
      for (let k = 0; k < count; k++) s.chooseSong(p, { songId: n++, title: `T${n}` }, 'append');
    });
  }
  const view = () => s.presenceView().filter(v => !v.future).map(v => v.name);
  const sing = () => { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); };
  sing(); gesture(s, people.P11, 4); sing(); sing(); gesture(s, people.P22, 0); sing();
  const before = view();
  assert.deepEqual(before, ['P21', 'P31', 'P11', 'P12', 'P32', 'P30']);
  s.staffRemove(people.P31.id);
  assert.deepEqual(view(), before.filter(name => name !== 'P31'));
});

// ------------------------------------------------------------------ passe 18
// Relecture, passe 18 : la chaîne des annonces gardées derrière une priorité
// (`then`) et le titre retiré de KaraFun pour elle, dans les cas où la
// priorité ou le titre prennent fin autrement que par leur envoi.

// Comme la route POST /api/staff/move avec `pullLoaded` : la priorité de
// `person` retire le titre chargé `tr.sel` (forAt, changeId notés au retrait).
function pullFor18(s, tr, person, exclude = [], provisional = null) {
  const visible = s.presenceView(exclude, provisional).filter(v => !v.future);
  const from = visible.findIndex(v => v.ids[0] === person.id);
  const before = s.manualOverrideState({ deferrals: true });
  s.staffMove(person.id, 0, exclude, provisional);
  tr.pulled = { forId: person.id, at: Date.now(), forAt: s.reservedNext.reservedAt };
  tr.pulled.changeId = s.recordManualChange({ kind: 'priority', personId: person.id, name: person.name, from: from + 1, to: 1,
    before, native: NATIVE }).id;
}
// Comme restorePulled (server.js) : KaraFun a retiré le titre.
function back18(s, tr, busyIds = []) {
  return s.returnFromKaraFun(tr.sel, { forId: tr.pulled.forId, forAt: tr.pulled.forAt, changeId: tr.pulled.changeId,
    cutoff: tr.pulled.forAt, busyIds });
}
// Un premier tour chanté par tous (les nouvelles tables passent alors d'abord).
function secondRound18(options = {}) {
  const ctx = evening(options);
  const presence = ctx.s.opts.requirePresence;
  ctx.s.opts.requirePresence = false;
  for (let k = 0; k < 8; k++) play(ctx.s);
  for (const p of Object.values(ctx.people)) ctx.s.chooseSong(p, song(), 'append');
  ctx.s.opts.requirePresence = presence;
  return ctx;
}
const newcomer18 = (s, name) => { const p = s.join({ tableId: String(20 + s.people.size), name, headcount: 1 }); s.chooseSong(p, song(), 'append'); return p; };
// Envois suivants (présence confirmée pour chacun), en noms.
function sends18(s, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    for (const p of s.people.values()) if (!p.withdrawnAt) s.confirm(p);
    const sel = s.select();
    if (!sel) break;
    out.push(label(s, sel)); s.commit(sel); s.songEnded(sel.ids);
  }
  return out;
}

test('passe 18 : priorité donnée pendant l’envoi d’une priorité qui gardait une personne sautée derrière elle : elle reste juste derrière la nouvelle', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3); // la suivante manque « Je suis là »
  const loaded = s.select(); s.commit(loaded); // Maud annoncée juste après le titre chargé
  assert.equal(s.reservedNext?.personId, people.Maud.id);
  newcomer18(s, 'Nina');
  s.songEnded(stage.ids);
  gesture(s, people.Karim, 0, loaded.ids); // Maud gardée derrière Karim
  assert.equal(s.reservedNext?.then?.personId, people.Maud.id);
  const sending = s.select(); // Karim en route vers KaraFun
  assert.equal(sending.ids[0], people.Karim.id);
  const before = s.manualOverrideState({ deferrals: true });
  s.staffMove(people.Jade.id, 0, [...loaded.ids, ...sending.ids], sending);
  s.recordManualChange({ kind: 'priority', personId: people.Jade.id, name: 'Jade', from: 3, to: 1, before, native: NATIVE });
  assert.equal(s.reservedNext?.then?.personId, people.Maud.id, 'Maud reste gardée, derrière Jade');
  s.commit(sending);
  assert.deepEqual(names(s, sending.ids).slice(0, 3), ['Jade', 'Maud', 'Nina']);
  s.songEnded(loaded.ids); // Karim, chargé, monte sur scène
  assert.deepEqual(sends18(s, 3), ['Jade', 'Maud', 'Nina']);
});

test('passe 18 : nouvelle priorité pendant le retrait, la priorité du retrait gardait une priorité plus ancienne : la nouvelle, la priorité, le titre retiré, puis la plus ancienne', () => {
  const { s, people, stage, loaded } = loadedEvening();
  gesture(s, people.Jade, 0, stage.ids); // priorité sans retrait
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Gil, stage.ids); // priorité avec retrait de Maud : Jade gardée derrière Gil
  gesture(s, people.Hugo, 0, stage.ids); // pendant le retrait
  back18(s, tr);
  assert.deepEqual(names(s, stage.ids).slice(0, 4), ['Hugo', 'Gil', 'Maud', 'Jade']);
  s.songEnded(stage.ids);
  assert.deepEqual(sends18(s, 4), ['Hugo', 'Gil', 'Maud', 'Jade']);
});

test('passe 18 : personne sautée gardée derrière le titre revenu, devenue un duo avec lui : pas annoncée juste après lui, file montrée et envoi d’accord', () => {
  const { s, people } = evening({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage); // Paulo sur scène
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded); // Gil chargé, Maud annoncée après lui
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Karim, stage.ids);
  back18(s, tr);
  s.requestDuetJoin(people.Gil, people.Maud.id, people.Maud.song.entryId);
  s.answerDuetJoin(people.Maud, people.Maud.song.entryId, people.Gil.id, true);
  s.songEnded(stage.ids);
  s.confirm(people.Karim); s.confirm(people.Gil);
  const karim = s.select(); s.commit(karim); s.songEnded(karim.ids);
  const gil = s.select();
  assert.equal(gil.ids[0], people.Gil.id);
  const shown = names(s, gil.ids, gil)[0];
  s.commit(gil);
  assert.notEqual(s.reservedNext?.personId, people.Maud.id, 'Gil ne rechante pas aussitôt');
  for (const p of Object.values(people)) s.confirm(p);
  assert.equal(label(s, s.select()), shown, 'file montrée et envoi d’accord');
});

test('passe 18 : la priorité qui avait retiré un titre part, puis revient sans être chantée : le titre retiré reste le prochain', () => {
  for (const how of ['Pas prêt', 'passée dans KaraFun']) {
    const { s, people } = secondRound18();
    const stage = s.select(); s.commit(stage); // Paulo
    const loaded = s.select(); s.commit(loaded); // titre chargé
    const T = s.people.get(loaded.ids[0]);
    assert.ok(![people.Ines.id, people.Hugo.id].includes(T.id) && !stage.ids.includes(people.Ines.id));
    newcomer18(s, 'Neo');
    const tr = { sel: loaded };
    pullFor18(s, tr, people.Ines, stage.ids);
    back18(s, tr);
    s.songEnded(stage.ids);
    const ines = s.select(); s.commit(ines); // Ines chargée, Maud annoncée
    assert.equal(ines.ids[0], people.Ines.id);
    assert.equal(s.reservedNext?.personId, T.id, how);
    if (how === 'Pas prêt') {
      s.deferPassage(people.Ines.id, { entryId: ines.song.entryId, ids: ines.ids, song: ines.song }, 1);
      s.requeueUnplayed(ines);
    } else s.rollbackUnplayed(ines, { requeue: true });
    assert.equal(names(s, [])[0], T.name, `${how} : le titre retiré passe avant la nouvelle table`);
    assert.equal(sends18(s, 1)[0], T.name, how);
  }
});

test('passe 18 : titre retiré annoncé après sa priorité, retiré à son tour pour une autre priorité : il la suit, devant une nouvelle table', () => {
  const { s, people } = secondRound18();
  const stage = s.select(); s.commit(stage); // Paulo
  const loaded = s.select(); s.commit(loaded); // titre chargé
  const T = s.people.get(loaded.ids[0]);
  assert.ok(![people.Ines.id, people.Hugo.id].includes(T.id));
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Ines, stage.ids);
  back18(s, tr);
  s.songEnded(stage.ids);
  const ines = s.select(); s.commit(ines); // Ines chargée, le titre retiré annoncé
  assert.equal(s.reservedNext?.personId, T.id);
  newcomer18(s, 'Neo');
  const tr2 = { sel: ines };
  pullFor18(s, tr2, people.Hugo, []);
  back18(s, tr2);
  assert.deepEqual(names(s, []).slice(0, 4), ['Hugo', 'Ines', T.name, 'Neo']);
});

test('passe 18 : priorité d’une personne sautée, gardée derrière la priorité d’un retrait puis passée au titre retiré : elle reste la priorité du bar', () => {
  const { s, people } = evening({ requirePresence: true });
  for (const [n, p] of Object.entries(people)) if (n !== 'Maud' && n !== 'Gil') s.confirm(p);
  const p0 = s.select({ stageFree: true }); s.commit(p0); s.recordStage(p0); s.songEnded(p0.ids); s.endStage(p0);
  s.skipUnconfirmed(people.Maud.id, 3);
  s.skipUnconfirmed(people.Gil.id, 3);
  const h = s.select({ stageFree: true }); s.commit(h); s.recordStage(h); // Hugo sur scène, Maud annoncée
  gesture(s, people.Ines, 0, []);
  const ines = s.select(); s.commit(ines); // Ines chargée
  gesture(s, people.Gil, 0, []); // priorité de Gil, toujours sauté faute de « Je suis là »
  const tr = { sel: ines };
  pullFor18(s, tr, people.Karim, []);
  back18(s, tr);
  assert.equal(s._isPresenceRetry(people.Gil), false, 'la priorité du bar n’est pas un titre sauté');
  assert.deepEqual(names(s, []).slice(0, 4), ['Karim', 'Ines', 'Gil', 'Maud']);
});

test('passe 18 : priorité avec retrait gardée derrière une autre, sa personne dit « Pas prêt » ou part : le titre retiré prend sa place', () => {
  for (const how of ['Pas prêt pendant l’envoi', 'titre retiré', 'Retirer', 'partie']) {
    const { s, people } = secondRound18();
    const stage = s.select(); s.commit(stage); // Paulo
    const loaded = s.select(); s.commit(loaded); // titre chargé
    const T = s.people.get(loaded.ids[0]);
    assert.ok(![people.Ines.id, people.Hugo.id].includes(T.id) && !stage.ids.includes(people.Ines.id));
    const tr = { sel: loaded };
    pullFor18(s, tr, people.Ines, stage.ids);
    back18(s, tr);
    gesture(s, people.Hugo, 0, stage.ids);
    newcomer18(s, 'Nina');
    assert.deepEqual(names(s, stage.ids).slice(0, 4), ['Hugo', 'Ines', T.name, 'Nina'], how);
    s.songEnded(stage.ids);
    if (how === 'Pas prêt pendant l’envoi') {
      const pending = s.select();
      assert.equal(pending.ids[0], people.Hugo.id);
      const line = s.presenceView(pending.ids, pending).find(v => v.ids[0] === people.Ines.id);
      s.deferPassage(people.Ines.id, line, 1, { extra: 1 });
      assert.equal(names(s, pending.ids, pending)[0], T.name, `${how} : pendant l’envoi`);
      s.commit(pending); s.songEnded(pending.ids);
      assert.equal(names(s, [])[0], T.name, `${how} : après l’accusé`);
      assert.equal(sends18(s, 1)[0], T.name, how);
      continue;
    }
    if (how === 'titre retiré') s.removeSong(people.Ines, people.Ines.song.entryId);
    if (how === 'Retirer') s.staffRemove(people.Ines.id);
    if (how === 'partie') s.leave(people.Ines, 'staff');
    if (people.Ines.song && !people.Ines.withdrawnAt) continue; // un titre de rechange garde la ligne
    assert.deepEqual(names(s, []).slice(0, 2), ['Hugo', T.name], how);
    assert.deepEqual(sends18(s, 2), ['Hugo', T.name], how);
  }
});

test('passe 18 : priorité gardée derrière une autre, sa personne notée en duo improvisé puis annulé : elle revient gardée, toujours prioritaire', () => {
  const s = new Scheduler({});
  const list = ['Paulo', 'Maud', 'Hugo', 'Ines', 'Jade', 'Elsa', 'Karim', 'Gil'];
  const people = {};
  list.forEach((name, i) => { people[name] = s.join({ tableId: String(i + 1), name, headcount: 1 }); });
  for (const name of list) if (name !== 'Karim') s.chooseSong(people[name], song(), 'append');
  const stage = s.select(); s.commit(stage); // Paulo sur scène
  const gilLine = s.presenceView(stage.ids).find(v => v.ids[0] === people.Gil.id);
  s.deferPassage(people.Gil.id, gilLine, 3);
  const duo = s.inviteDuet(people.Karim, people.Gil.id, song());
  if (duo.duet?.state !== 'accepted') s.answerDuet(people.Gil, true, duo.entryId);
  gesture(s, people.Karim, 0, stage.ids);
  gesture(s, people.Jade, 0, stage.ids);
  assert.equal(s.reservedNext?.then?.personId, people.Karim.id);
  s.staffCountPartner(stage.ids[0], people.Karim.id, stage);
  s.staffUncountPartner(stage.staffDuo, stage, [stage]);
  assert.equal(s.reservedNext?.then?.personId, people.Karim.id, 'Karim revient gardé derrière Jade');
  assert.equal(s.reservedNext?.then?.byStaff, true, 'toujours priorité du bar');
  s.songEnded(stage.ids);
  assert.deepEqual(sends18(s, 2), ['Jade', 'Karim & Gil']);
});

test('passe 18 : personne sautée annoncée qui confirme, puis priorité du bar : elle reste juste derrière, devant une nouvelle table', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded); // Maud annoncée juste après
  s.songEnded(stage.ids); // le titre chargé est sur scène, rien d'autre de chargé
  assert.equal(s.reservedNext?.personId, people.Maud.id);
  s.confirm(people.Maud); // elle tape « Je suis là »
  gesture(s, people.Hugo, 0, loaded.ids);
  newcomer18(s, 'Zoe');
  assert.deepEqual(names(s, loaded.ids).slice(0, 3), ['Hugo', 'Maud', 'Zoe']);
  s.songEnded(loaded.ids);
  assert.deepEqual(sends18(s, 3), ['Hugo', 'Maud', 'Zoe']);
});

test('passe 18 : titre revenu qui attend la priorité, son chanteur le retire ou part : la personne sautée qui le suivait passe juste après la priorité', () => {
  for (const how of ['titre retiré', 'partie', 'Retirer']) {
    const { s, people } = secondRound18({ requirePresence: true });
    for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
    const stage = s.select(); s.commit(stage);
    s.skipUnconfirmed(people.Maud.id, 3);
    const loaded = s.select(); s.commit(loaded); // Gil chargé, Maud annoncée
    const T = s.people.get(loaded.ids[0]);
    assert.equal(s.reservedNext?.personId, people.Maud.id);
    const tr = { sel: loaded };
    pullFor18(s, tr, people.Karim, stage.ids);
    back18(s, tr);
    if (how === 'titre retiré') { while (T.song) s.removeSong(T, T.song.entryId); }
    if (how === 'partie') s.leave(T, 'staff');
    if (how === 'Retirer') { while (T.song) s.staffRemove(T.id); }
    newcomer18(s, 'Zoe');
    assert.deepEqual(names(s, stage.ids).slice(0, 3), ['Karim', 'Maud', 'Zoe'], how);
    s.songEnded(stage.ids);
    assert.deepEqual(sends18(s, 3), ['Karim', 'Maud', 'Zoe'], how);
  }
});

test('passe 18 : chaîne des annonces gardées après un redémarrage : une personne répétée garde sa première place', () => {
  const { s, access, people } = evening();
  const at = Date.now();
  s.reservedNext = { personId: people.Paulo.id, reservedAt: at, byStaff: true,
    then: { personId: people.Maud.id, reservedAt: at - 1, byStaff: true,
      then: { personId: people.Gil.id, reservedAt: at - 2, retry: true,
        then: { personId: people.Maud.id, reservedAt: at - 3, pulled: true } } } };
  s.manualOrder = [people.Paulo.id, people.Maud.id];
  const resumed = restart(s, access);
  const chain = [];
  for (let link = resumed.reservedNext; link; link = link.then) chain.push([resumed.people.get(link.personId).name, !!link.byStaff, !!link.retry, !!link.pulled]);
  assert.deepEqual(chain, [['Paulo', true, false, false], ['Maud', true, false, false], ['Gil', false, true, false]]);
});

test('passe 18 : nouvelle priorité pendant le retrait, puis la priorité du retrait dit « Pas prêt » avant le retour du titre : le titre passe juste après la nouvelle', () => {
  const { s, people } = secondRound18();
  const stage = s.select(); s.commit(stage);
  const loaded = s.select(); s.commit(loaded); // titre chargé
  const T = s.people.get(loaded.ids[0]);
  assert.ok(![people.Ines.id, people.Hugo.id].includes(T.id) && !stage.ids.includes(people.Ines.id));
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Ines, stage.ids);
  gesture(s, people.Hugo, 0, stage.ids); // pendant le retrait
  const line = s.presenceView(stage.ids).find(v => v.ids[0] === people.Ines.id);
  s.deferPassage(people.Ines.id, line, 1); // pendant le retrait aussi
  back18(s, tr);
  newcomer18(s, 'Nina');
  assert.deepEqual(names(s, stage.ids).slice(0, 2), ['Hugo', T.name]);
  s.songEnded(stage.ids);
  assert.deepEqual(sends18(s, 2), ['Hugo', T.name]);
});

// ------------------------------------------------------------------ passe 19
// Relecture, passe 19 : le titre retiré de KaraFun n'attend sa priorité sous
// forme de report que tant qu'elle est le prochain annoncé ; les annonces
// qu'elle gardait restent dans la chaîne (`then`), et dès qu'elle cesse d'être
// en tête sans partir, le titre devient un maillon juste derrière elle.

test('passe 19 : personne sautée gardée derrière la priorité du retrait, qui confirme puis reçoit « Priorité » : elle ne chante pas deux fois, la file et les envois s’accordent', () => {
  for (const how of ['priorité', 'duo']) {
    const { s, people } = secondRound18({ requirePresence: true });
    for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
    s.chooseSong(people.Maud, song(), 'append');
    const stage = s.select(); s.commit(stage);
    s.skipUnconfirmed(people.Maud.id, 3);
    const loaded = s.select(); s.commit(loaded); // Maud annoncée après le titre chargé
    const T = s.people.get(loaded.ids[0]);
    assert.equal(s.reservedNext?.personId, people.Maud.id, how);
    const tr = { sel: loaded };
    pullFor18(s, tr, people.Karim, stage.ids);
    back18(s, tr);
    s.confirm(people.Maud);
    if (how === 'priorité') gesture(s, people.Maud, 0, stage.ids);
    else {
      const duo = s.inviteDuet(people.Karim, people.Maud.id, song());
      if (duo.duet?.state !== 'accepted') s.answerDuet(people.Maud, true, duo.entryId);
      s.removeSong(people.Karim, people.Karim.song.entryId); // le duo devient son titre en cours
    }
    const shown = names(s, stage.ids).slice(0, 4);
    s.songEnded(stage.ids);
    const sent = sends18(s, 4);
    assert.deepEqual(sent, shown, `${how} : file montrée et envois d’accord`);
    const maud = sent.filter(line => line.split(' & ').includes('Maud')).length;
    assert.equal(maud, 1, `${how} : Maud ne chante qu’une fois sur ces quatre passages (${sent.join(', ')})`);
    assert.ok(sent.includes(T.name), how);
  }
});

test('passe 19 : priorité donnée pendant l’envoi de la priorité du retrait : le titre retiré repasse juste après la nouvelle, devant une nouvelle table', () => {
  const { s, people } = secondRound18();
  const stage = s.select(); s.commit(stage);
  const loaded = s.select(); s.commit(loaded);
  const T = s.people.get(loaded.ids[0]);
  assert.ok(![people.Ines.id, people.Hugo.id].includes(T.id) && !stage.ids.includes(people.Ines.id));
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Ines, stage.ids);
  back18(s, tr);
  s.songEnded(stage.ids);
  const sending = s.select(); // Ines en route vers KaraFun
  assert.equal(sending.ids[0], people.Ines.id);
  const before = s.manualOverrideState({ deferrals: true });
  s.staffMove(people.Hugo.id, 0, sending.ids, sending);
  s.recordManualChange({ kind: 'priority', personId: people.Hugo.id, name: 'Hugo', from: 3, to: 1, before, native: NATIVE });
  newcomer18(s, 'Zoe');
  const shown = names(s, sending.ids, sending).slice(0, 3);
  assert.deepEqual(shown, ['Hugo', T.name, 'Zoe'], 'pendant l’envoi');
  s.commit(sending);
  assert.deepEqual(names(s, sending.ids).slice(0, 3), shown, 'après l’accusé, la file ne change pas');
  s.songEnded(sending.ids);
  assert.deepEqual(sends18(s, 3), ['Hugo', T.name, 'Zoe']);
});

test('passe 19 : « Priorité » sur le titre retiré, ou son chanteur réordonne sa liste : la personne sautée qu’il gardait reste juste derrière la priorité', () => {
  for (const how of ['priorité', 'réordonne']) {
    const { s, people } = secondRound18({ requirePresence: true });
    for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
    const stage = s.select(); s.commit(stage);
    s.skipUnconfirmed(people.Maud.id, 3);
    const loaded = s.select(); s.commit(loaded);
    const T = s.people.get(loaded.ids[0]);
    s.chooseSong(T, song(), 'append');
    const tr = { sel: loaded };
    pullFor18(s, tr, people.Karim, stage.ids);
    back18(s, tr);
    if (how === 'priorité') gesture(s, T, 0, stage.ids);
    else s.reorderSongs(T, T.backlog.at(-1).entryId, 0);
    newcomer18(s, 'Zoe');
    // Réordonnée, sa liste garde au titre mis en tête la place du titre retiré.
    const want = how === 'priorité' ? [T.name, 'Karim', 'Maud', 'Zoe'] : ['Karim', T.name, 'Maud', 'Zoe'];
    assert.deepEqual(names(s, stage.ids).slice(0, want.length), want, how);
    s.songEnded(stage.ids);
    assert.deepEqual(sends18(s, want.length), want, how);
  }
});

test('passe 19 : titre retiré qui attend une priorité gardée derrière une ou deux plus récentes : la file montrée et les envois s’accordent', () => {
  for (const when of ['pendant le retrait', 'après le retour']) {
    const { s, people } = secondRound18({ requirePresence: true });
    for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
    const stage = s.select(); s.commit(stage);
    s.skipUnconfirmed(people.Maud.id, 3);
    const loaded = s.select(); s.commit(loaded);
    const T = s.people.get(loaded.ids[0]);
    const tr = { sel: loaded };
    pullFor18(s, tr, people.Karim, stage.ids);
    if (when === 'pendant le retrait') gesture(s, people.Hugo, 0, stage.ids);
    back18(s, tr);
    if (when === 'après le retour') gesture(s, people.Hugo, 0, stage.ids);
    newcomer18(s, 'Zoe');
    const shown = names(s, stage.ids).slice(0, 5);
    assert.deepEqual(shown, ['Hugo', 'Karim', T.name, 'Maud', 'Zoe'], when);
    s.songEnded(stage.ids);
    assert.deepEqual(sends18(s, 5), shown, when);
  }
  const { s, people } = secondRound18();
  const stage = s.select(); s.commit(stage);
  const loaded = s.select(); s.commit(loaded);
  const T = s.people.get(loaded.ids[0]);
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Karim, stage.ids);
  gesture(s, people.Hugo, 0, stage.ids);
  back18(s, tr);
  gesture(s, people.Jade, 0, stage.ids);
  newcomer18(s, 'Zoe');
  const shown = names(s, stage.ids).slice(0, 5);
  assert.deepEqual(shown, ['Jade', 'Hugo', 'Karim', T.name, 'Zoe'], 'trois priorités');
  s.songEnded(stage.ids);
  assert.deepEqual(sends18(s, 5), shown, 'trois priorités');
});

test('passe 19 : « Priorité » sans retrait, puis avec retrait pour la même ligne : la personne sautée qu’elle gardait reste derrière le titre retiré', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded);
  const T = s.people.get(loaded.ids[0]);
  gesture(s, people.Karim, 0, stage.ids); // juste après le titre chargé : Maud gardée derrière Karim
  assert.equal(s.reservedNext?.then?.personId, people.Maud.id);
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Karim, stage.ids); // puis « Avant » le titre chargé
  back18(s, tr);
  newcomer18(s, 'Zoe');
  assert.deepEqual(names(s, stage.ids).slice(0, 4), ['Karim', T.name, 'Maud', 'Zoe']);
  s.songEnded(stage.ids);
  assert.deepEqual(sends18(s, 4), ['Karim', T.name, 'Maud', 'Zoe']);
});

test('passe 19 : le chanteur du titre retiré rejoint en duo le titre de la priorité : la personne sautée qu’il gardait passe juste après le duo', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded);
  const T = s.people.get(loaded.ids[0]);
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Karim, stage.ids);
  back18(s, tr);
  s.requestDuetJoin(T, people.Karim.id, people.Karim.song.entryId);
  s.answerDuetJoin(people.Karim, people.Karim.song.entryId, T.id, true);
  newcomer18(s, 'Zoe');
  const shown = names(s, stage.ids).slice(0, 3);
  assert.deepEqual(shown.slice(0, 2), [`Karim & ${T.name}`, 'Maud']);
  s.songEnded(stage.ids);
  assert.deepEqual(sends18(s, 2), [`Karim & ${T.name}`, 'Maud']);
});

test('passe 19 : cinq priorités empilées sur une personne sautée annoncée : elle garde sa place derrière elles', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded);
  assert.equal(s.reservedNext?.personId, people.Maud.id);
  newcomer18(s, 'Zoe'); newcomer18(s, 'Yann'); // arrivés après son « Je suis là » manqué
  const stack = [people.Hugo, people.Ines, people.Jade, people.Elsa, people.Karim]
    .filter(p => !loaded.ids.includes(p.id) && !stage.ids.includes(p.id));
  assert.equal(stack.length, 5);
  for (const p of stack) gesture(s, p, 0, loaded.ids);
  const order = names(s, loaded.ids);
  assert.equal(order[5], 'Maud', `Maud juste après les cinq priorités (${order.join(', ')})`);
});

test('passe 19 : « Céder ma place » par une priorité gardée derrière une plus récente : le titre retiré pour elle prend sa place', () => {
  const { s, people } = secondRound18();
  const stage = s.select(); s.commit(stage);
  const loaded = s.select(); s.commit(loaded);
  const T = s.people.get(loaded.ids[0]);
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Ines, stage.ids);
  back18(s, tr);
  gesture(s, people.Hugo, 0, stage.ids);
  newcomer18(s, 'Zoe');
  s.setHeadcount(people.Ines.tableId, 2);
  const mate = s.join({ tableId: people.Ines.tableId, name: 'Inès bis' });
  s.giveSpot(people.Ines, mate.id);
  assert.deepEqual(names(s, stage.ids).slice(0, 2), ['Hugo', T.name]);
  s.songEnded(stage.ids);
  assert.deepEqual(sends18(s, 2), ['Hugo', T.name]);
});

// ------------------------------------------------------------------ passe 20
// Relecture, invocation 5, passe 2 : la chaîne des annonces gardées (`then`)
// reste bornée partout où elle grandit (le titre retiré de KaraFun n'y compte
// pas), ne garde pas deux fois la même personne, suit les déplacements du bar,
// les annulations recalculées et la prévision pendant un envoi.

const chain20 = s => { const out = []; for (let l = s.reservedNext; l; l = l.then) out.push(s.people.get(l.personId).name); return out; };
// Horloge réelle : la priorité suivante a une heure d'annonce plus récente.
const tick20 = () => { const t0 = Date.now(); while (Date.now() === t0) { /* attente active d'une milliseconde */ } };

test('passe 20 : quatre priorités, dont une avec retrait, sur une personne sautée : la file et un redémarrage gardent le même ordre', () => {
  const { s, access, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded); // Maud annoncée juste après le titre chargé
  assert.equal(s.reservedNext?.personId, people.Maud.id);
  const T = s.people.get(loaded.ids[0]);
  s.confirm(people.Maud);
  const tr = { sel: loaded };
  const [a, b, c, d] = names(s, stage.ids).filter(n => n !== 'Maud' && n !== T.name).slice(0, 4).map(n => people[n]);
  gesture(s, a, 0, stage.ids);
  gesture(s, b, 0, stage.ids);
  pullFor18(s, tr, c, stage.ids);
  gesture(s, d, 0, stage.ids); // pendant le retrait
  back18(s, tr);
  newcomer18(s, 'Nina');
  const want = [d.name, c.name, T.name, b.name, a.name, 'Maud', 'Nina'];
  assert.deepEqual(names(s, stage.ids).slice(0, 7), want, 'file montrée');
  s.songEnded(stage.ids);
  const resumed = restart(s, access);
  assert.deepEqual(resumed.warnings, []);
  assert.deepEqual(names(resumed).slice(0, 7), want, 'après un redémarrage');
  assert.deepEqual(sends18(resumed, 7), want, 'envois après un redémarrage');
  assert.deepEqual(sends18(s, 7), want, 'envois sans redémarrage');
});

test('passe 20 : titre retiré dont le chanteur a reçu « Priorité » pendant le retrait : il ne compte pas deux fois, un seul « Je suis là » manqué', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  const loaded = s.select(); s.commit(loaded);
  const O = s.people.get(loaded.ids[0]);
  s.chooseSong(O, song(), 'append');
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Karim, stage.ids);
  const karim = s.presenceView(stage.ids).filter(v => !v.future).find(v => v.ids[0] === people.Karim.id);
  s.deferPassage(people.Karim.id, karim, 1); // « Pas prêt » pendant le retrait
  tick20();
  gesture(s, O, 0, stage.ids); // le bar donne « Priorité » au titre suivant d'O
  back18(s, tr, stage.ids);
  assert.deepEqual(chain20(s).filter(name => name === O.name), [O.name], `O une seule fois dans la chaîne (${chain20(s).join(' > ')})`);
  s.songEnded(stage.ids);
  O.confirmedAt = 0;
  assert.equal(s.reservePresenceNext([])?.ids?.[0], O.id);
  s.skipUnconfirmed(O.id, 3);
  assert.equal(s.presenceSkipsOf(O), 1);
  assert.notEqual(s.reservedNext?.personId, O.id, 'O laisse passer un passage');
  const shown = names(s).slice(0, 1);
  const sel = s.select({ stageFree: true });
  assert.ok(sel, 'un autre passage part');
  assert.deepEqual([label(s, sel)], shown, 'file montrée et envoi d’accord');
});

test('passe 20 : priorité donnée pendant l’envoi d’un duo où chante une personne gardée : la file montrée pendant l’envoi est celle de l’accusé', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded);
  const T = s.people.get(loaded.ids[0]);
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Karim, stage.ids);
  back18(s, tr);
  s.requestDuetJoin(T, people.Karim.id, people.Karim.song.entryId);
  s.answerDuetJoin(people.Karim, people.Karim.song.entryId, T.id, true);
  newcomer18(s, 'Zoe');
  s.songEnded(stage.ids);
  for (const p of s.people.values()) if (!p.withdrawnAt) s.confirm(p);
  const sending = s.select(); // Karim & T en route vers KaraFun
  assert.deepEqual(sending.ids, [people.Karim.id, T.id]);
  const before = s.manualOverrideState({ deferrals: true });
  s.staffMove(people.Hugo.id, 0, sending.ids, sending);
  s.recordManualChange({ kind: 'priority', personId: people.Hugo.id, name: 'Hugo', from: 3, to: 1, before, native: NATIVE });
  const during = names(s, sending.ids, sending).slice(0, 5);
  s.commit(sending);
  assert.deepEqual(names(s, sending.ids).slice(0, 5), during, 'pendant l’envoi, puis après l’accusé');
  assert.deepEqual(during.slice(0, 2), ['Hugo', 'Maud']);
  s.songEnded(sending.ids);
  assert.deepEqual(sends18(s, 5), during);
});

test('passe 20 : le bar place une ligne à la 2e ou la 3e place, dans la chaîne des annonces gardées : chaque ligne garde la place montrée', () => {
  for (const at of [1, 2]) {
    const { s, people } = secondRound18({ requirePresence: true });
    for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
    const stage = s.select(); s.commit(stage);
    s.skipUnconfirmed(people.Maud.id, 3);
    const loaded = s.select(); s.commit(loaded);
    assert.equal(s.reservedNext?.personId, people.Maud.id);
    s.songEnded(stage.ids);
    const order = names(s, loaded.ids).filter(n => n !== 'Maud');
    const W = people[order[0]], X = people[order[1]], Z = people[order[4]];
    gesture(s, W, 0, loaded.ids);
    if (at === 2) gesture(s, X, 0, loaded.ids);
    newcomer18(s, 'Nina');
    const kept = names(s, loaded.ids);
    assert.equal(kept[at], 'Maud', `Maud gardée (${kept.join(', ')})`);
    gesture(s, Z, at, loaded.ids);
    const shown = names(s, loaded.ids);
    assert.equal(shown[at], Z.name, `${Z.name} à la place ${at + 1} (${shown.join(', ')})`);
    assert.equal(shown[at + 1], 'Maud', `Maud juste derrière (${shown.join(', ')})`);
    assert.ok(shown.indexOf('Nina') > at + 1, 'la nouvelle table passe après Maud');
    s.songEnded(loaded.ids);
    assert.deepEqual(sends18(s, 6), shown.slice(0, 6), `place ${at + 1} : file montrée et envois d’accord`);
  }
});

test('passe 20 : « Annuler » recalculé de la priorité en tête quand l’annonce d’avant ne peut plus revenir : ce qu’elle gardait reste', () => {
  // Sans titre retiré : la priorité plus ancienne gardée a dit « Pas prêt ».
  {
    const { s, people } = secondRound18({ requirePresence: true });
    for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
    const stage = s.select(); s.commit(stage);
    s.skipUnconfirmed(people.Maud.id, 3);
    const loaded = s.select(); s.commit(loaded);
    s.songEnded(stage.ids);
    const order = names(s, loaded.ids).filter(n => n !== 'Maud');
    const X = people[order[0]], Y = people[order[1]];
    gesture(s, X, 0, loaded.ids);
    gesture(s, Y, 0, loaded.ids);
    newcomer18(s, 'Nina');
    s.deferPassage(X.id, s.presenceView(loaded.ids).find(v => v.ids[0] === X.id), 1);
    assert.deepEqual(names(s, loaded.ids).slice(0, 2), [Y.name, 'Maud']);
    s.undoLastManualChange(null, NATIVE, { excludeIds: [], busyIds: loaded.ids });
    const shown = names(s, loaded.ids);
    assert.equal(shown[0], 'Maud', `Maud reste la prochaine (${shown.join(', ')})`);
    assert.ok(shown.indexOf('Nina') > shown.indexOf(X.name), `Nina après ${X.name} (${shown.join(', ')})`);
    s.songEnded(loaded.ids);
    assert.deepEqual(sends18(s, 5), shown.slice(0, 5));
  }
  // Avec le titre retiré : la priorité du retrait est partie.
  {
    const { s, people } = secondRound18({ requirePresence: true });
    for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
    const stage = s.select(); s.commit(stage);
    s.skipUnconfirmed(people.Maud.id, 3);
    const loaded = s.select(); s.commit(loaded);
    const T = s.people.get(loaded.ids[0]);
    const tr = { sel: loaded };
    pullFor18(s, tr, people.Karim, stage.ids);
    back18(s, tr);
    gesture(s, people.Hugo, 0, stage.ids);
    s.leave(people.Karim, 'staff');
    newcomer18(s, 'Zoe');
    assert.deepEqual(names(s, stage.ids).slice(0, 4), ['Hugo', T.name, 'Maud', 'Zoe']);
    s.undoLastManualChange(null, NATIVE, { excludeIds: [], busyIds: [] });
    const shown = names(s, stage.ids);
    assert.deepEqual(shown.slice(0, 3), [T.name, 'Maud', 'Zoe'], shown.join(', '));
    s.songEnded(stage.ids);
    assert.deepEqual(sends18(s, 4), shown.slice(0, 4));
  }
});

test('passe 20 : titre retiré qui attend sa priorité, retiré par son chanteur ou le bar avec un titre suivant : celui-ci garde sa place, que le titre attende en report ou dans la chaîne', () => {
  for (const newer of [false, true]) for (const how of ['removeSong', 'staffRemove']) {
    const { s, people } = secondRound18();
    const stage = s.select(); s.commit(stage);
    const loaded = s.select(); s.commit(loaded);
    const T = s.people.get(loaded.ids[0]);
    s.chooseSong(T, song(), 'append');
    const tr = { sel: loaded };
    pullFor18(s, tr, people.Karim, stage.ids);
    back18(s, tr);
    if (newer) gesture(s, people.Hugo, 0, stage.ids);
    newcomer18(s, 'Zoe'); newcomer18(s, 'Yann');
    const lead = newer ? ['Hugo', 'Karim'] : ['Karim'];
    assert.deepEqual(names(s, stage.ids).slice(0, lead.length + 1), [...lead, T.name]);
    if (how === 'removeSong') s.removeSong(T, T.song.entryId); else s.staffRemove(T.id);
    const shown = names(s, stage.ids);
    assert.deepEqual(shown.slice(0, lead.length + 1), [...lead, T.name], `${newer ? 'chaîne' : 'report'}, ${how} : ${shown.join(', ')}`);
    s.songEnded(stage.ids);
    assert.deepEqual(sends18(s, 6), shown.slice(0, 6), `${newer ? 'chaîne' : 'report'}, ${how}`);
  }
});

test('passe 20 : « Annuler » juste après une cinquième priorité qui avait fait tomber la personne sautée : elle est de nouveau gardée, sans être aussi sautée', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded);
  assert.equal(s.reservedNext?.personId, people.Maud.id);
  const stack = [people.Hugo, people.Ines, people.Jade, people.Elsa, people.Karim]
    .filter(p => !loaded.ids.includes(p.id) && !stage.ids.includes(p.id));
  assert.equal(stack.length, 5);
  for (const p of stack) gesture(s, p, 0, [...stage.ids, ...loaded.ids]);
  assert.ok(s.canUndoManualChange(NATIVE), 'annulation exacte');
  s.undoLastManualChange(null, NATIVE, {});
  assert.equal(s._isPresenceRetry(people.Maud), false, 'Maud gardée dans la chaîne, pas sautée');
  s.songEnded(stage.ids);
  s.songEnded(loaded.ids);
  const shown = names(s);
  assert.deepEqual(shown.slice(0, 5), [...stack.slice(0, 4).reverse().map(p => p.name), 'Maud'], shown.join(', '));
  for (let k = 0; k < 5; k++) {
    for (const p of s.people.values()) if (!p.withdrawnAt) s.confirm(p);
    const first = names(s)[0];
    const sel = s.select();
    assert.ok(sel, `passage ${k + 1} envoyé`);
    assert.equal(label(s, sel), first, `passage ${k + 1} : la tête montrée est envoyée`);
    s.commit(sel); s.songEnded(sel.ids);
  }
});

test('passe 20 : duo retiré de KaraFun dont l’invitée rejoint ensuite le duo de la priorité : il passe dès qu’il le peut, comme la file le montre', () => {
  const { s, people } = secondRound18();
  const stage = s.select(); s.commit(stage);
  const O = s.people.get(names(s, stage.ids).map(n => people[n]).find(Boolean).id);
  const G = Object.values(people).find(p => p !== O && !stage.ids.includes(p.id));
  s.requestDuetJoin(G, O.id, O.song.entryId);
  s.answerDuetJoin(O, O.song.entryId, G.id, true);
  const loaded = s.select(); s.commit(loaded);
  assert.deepEqual(loaded.ids, [O.id, G.id]);
  const X = Object.values(people).find(p => p !== G && !loaded.ids.includes(p.id) && !stage.ids.includes(p.id));
  const tr = { sel: loaded };
  pullFor18(s, tr, X, stage.ids);
  back18(s, tr);
  s.requestDuetJoin(G, X.id, X.song.entryId);
  s.answerDuetJoin(X, X.song.entryId, G.id, true);
  const shown = names(s, stage.ids).slice(0, 5);
  // Le duo retiré passe dès que son invitée le peut : juste après le passage
  // qui suit celui où elle chante avec la priorité.
  assert.equal(shown.indexOf(`${O.name} & ${G.name}`), 2, shown.join(', '));
  s.songEnded(stage.ids);
  assert.deepEqual(sends18(s, 5), shown, `file montrée et envois d’accord (${shown.join(', ')})`);
});

// Comportements de la passe 19 que seuls les rejeux couvraient (relecture,
// invocation 5, passe 2 : mutants survivants).

test('passe 20 : « Annuler » la priorité donnée pendant le retrait, une ou deux fois empilée : le titre retiré attend de nouveau la sienne', () => {
  for (const extra of [['Hugo'], ['Hugo', 'Jade']]) {
    const { s, people } = secondRound18();
    const stage = s.select(); s.commit(stage);
    const loaded = s.select(); s.commit(loaded);
    const T = s.people.get(loaded.ids[0]);
    assert.ok(![people.Karim.id, people.Hugo.id, people.Jade.id].includes(T.id));
    const tr = { sel: loaded };
    pullFor18(s, tr, people.Karim, stage.ids);
    for (const name of extra) gesture(s, people[name], 0, stage.ids);
    back18(s, tr);
    newcomer18(s, 'Zoe');
    s.undoLastManualChange(null, NATIVE, { excludeIds: stage.ids });
    const want = extra.length === 1 ? ['Karim', T.name, 'Zoe'] : ['Hugo', 'Karim', T.name, 'Zoe'];
    assert.deepEqual(names(s, stage.ids).slice(0, want.length), want, extra.join(', '));
    s.songEnded(stage.ids);
    assert.deepEqual(sends18(s, want.length), want, extra.join(', '));
  }
});

test('passe 20 : redémarrage avec le titre retiré dans la chaîne, puis « Annuler » : il attend toujours sa priorité', () => {
  const { s, access, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage); s.songEnded(stage.ids);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded);
  const T = s.people.get(loaded.ids[0]);
  assert.ok(![people.Karim.id, people.Hugo.id].includes(T.id));
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Karim);
  gesture(s, people.Hugo, 0);
  back18(s, tr);
  const r = restart(s, access);
  assert.deepEqual(r.warnings, []);
  let link = r.reservedNext;
  while (link && link.personId !== T.id) link = link.then;
  assert.equal(link?.pulled, true);
  assert.equal(link.forId, people.Karim.id, 'le maillon garde sa priorité');
  assert.ok(Number.isFinite(link.forAt));
  newcomer18(r, 'Zoe');
  r.undoLastManualChange(null, NATIVE);
  for (const p of r.people.values()) if (!p.withdrawnAt) r.confirm(p);
  const shown = names(r).slice(0, 4);
  assert.deepEqual(shown.slice(0, 2), ['Karim', T.name], shown.join(', '));
  assert.ok(shown.indexOf('Zoe') > shown.indexOf(T.name));
  assert.deepEqual(sends18(r, 4), shown);
});

test('passe 20 : priorité gardée derrière celle du retrait, sa personne encore sautée : le titre retiré passe avant elle, comme montré', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded);
  const T = s.people.get(loaded.ids[0]);
  s.skipUnconfirmed(people.Maud.id, 3);
  gesture(s, people.Maud, 0, stage.ids);
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Karim, stage.ids);
  back18(s, tr);
  newcomer18(s, 'Zoe');
  const shown = names(s, stage.ids).slice(0, 4);
  assert.deepEqual(shown.slice(0, 2), ['Karim', T.name], shown.join(', '));
  s.songEnded(stage.ids);
  assert.deepEqual(sends18(s, 4), shown);
});

test('passe 20 : le bar déplace plus bas une ligne gardée dans la chaîne, la personne sautée ou le titre retiré : sa place est celle qu’il donne', () => {
  for (const who of ['Maud', 'titre']) {
    const { s, people } = secondRound18({ requirePresence: true });
    for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
    const stage = s.select(); s.commit(stage);
    s.skipUnconfirmed(people.Maud.id, 3);
    const loaded = s.select(); s.commit(loaded);
    const T = s.people.get(loaded.ids[0]);
    const tr = { sel: loaded };
    pullFor18(s, tr, people.Karim, stage.ids);
    back18(s, tr);
    gesture(s, people.Hugo, 0, stage.ids);
    newcomer18(s, 'Zoe');
    s.confirm(people.Maud);
    const mover = who === 'titre' ? T : people.Maud;
    gesture(s, mover, 5, stage.ids);
    const shown = names(s, stage.ids).slice(0, 6);
    assert.equal(shown.indexOf(mover.name), 5, `${who} : ${shown.join(', ')}`);
    s.songEnded(stage.ids);
    assert.deepEqual(sends18(s, 6), shown, who);
  }
});

test('passe 20 : duo improvisé noté puis annulé sur la priorité du retrait : la personne sautée reste derrière le titre retiré', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded);
  const T = s.people.get(loaded.ids[0]);
  const tr = { sel: loaded };
  pullFor18(s, tr, people.Karim, stage.ids);
  back18(s, tr);
  newcomer18(s, 'Zoe');
  s.staffCountPartner(stage.ids[0], people.Karim.id, stage);
  s.staffUncountPartner(stage.staffDuo, stage, [stage]);
  const want = ['Karim', T.name, 'Maud', 'Zoe'];
  assert.deepEqual(names(s, stage.ids).slice(0, 4), want);
  s.songEnded(stage.ids);
  assert.deepEqual(sends18(s, 4), want);
});

// ------------------------------------------------------------------ passe 21
// Relecture, invocation 5, passe 3 : la reconstruction de la chaîne par un
// déplacement du bar, les annulations d'un tel déplacement, le titre retiré
// qui reprend la tête, « Remplacer ma prochaine chanson » et le titre retiré
// qui attend la priorité partante devant un simple report.

test('passe 21 : déplacer une ligne derrière le titre retiré qui attend la priorité en tête : la chaîne gardée reste derrière lui', () => {
  for (const at of [1, 2, 3, 4]) {
    const { s, people } = secondRound18({ requirePresence: true });
    for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
    const stage = s.select(); s.commit(stage);
    s.skipUnconfirmed(people.Maud.id, 3);
    const loaded = s.select(); s.commit(loaded);
    const T = s.people.get(loaded.ids[0]);
    const tr = { sel: loaded };
    pullFor18(s, tr, people.Karim, stage.ids);
    back18(s, tr);
    newcomer18(s, 'Zoe');
    const before = names(s, stage.ids);
    assert.deepEqual(before.slice(0, 3), ['Karim', T.name, 'Maud']);
    const Z = [...s.people.values()].find(p => p.name === before[6]);
    gesture(s, Z, at, stage.ids);
    const want = before.filter(n => n !== Z.name); want.splice(at, 0, Z.name);
    assert.deepEqual(names(s, stage.ids).slice(0, 6), want.slice(0, 6), `place ${at + 1}`);
    s.songEnded(stage.ids);
    assert.deepEqual(sends18(s, 6), want.slice(0, 6), `place ${at + 1} : envois`);
  }
});

test('passe 21 : « Annuler » recalculé, puis « Annuler tous les changements », du déplacement qui a placé une ligne dans la chaîne : elle revient au calcul', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded);
  s.songEnded(stage.ids);
  const order = names(s, loaded.ids).filter(n => n !== 'Maud');
  const W = people[order[0]], Z = people[order[4]];
  gesture(s, W, 0, loaded.ids);
  gesture(s, Z, 1, loaded.ids);
  assert.deepEqual(names(s, loaded.ids).slice(0, 3), [W.name, Z.name, 'Maud']);
  newcomer18(s, 'Nina'); // la file a changé : annulation recalculée
  assert.equal(s.canUndoManualChange(NATIVE), false);
  s.undoLastManualChange(null, NATIVE, { busyIds: loaded.ids });
  const shown = names(s, loaded.ids);
  assert.deepEqual(shown.slice(0, 2), [W.name, 'Maud'], shown.join(', '));
  assert.ok(shown.indexOf(Z.name) > shown.indexOf('Nina'), shown.join(', '));
  s.undoAllManualChanges(NATIVE, { busyIds: loaded.ids });
  const all = names(s, loaded.ids);
  assert.ok(all.indexOf(Z.name) > all.indexOf('Nina'), `après « Annuler tous » : ${all.join(', ')}`);
  s.songEnded(loaded.ids);
  assert.deepEqual(sends18(s, 6), all.slice(0, 6));
});

test('passe 21 : le bar place à la 2e place le titre suivant de la personne sur scène, une personne sautée gardée derrière la priorité : la place donnée tient', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded);
  s.songEnded(stage.ids);
  const onStage = s.people.get(loaded.ids[0]);
  s.chooseSong(onStage, song(), 'append');
  gesture(s, people[names(s).filter(n => n !== 'Maud' && n !== onStage.name)[0]], 0);
  newcomer18(s, 'Nina');
  gesture(s, onStage, 1);
  const shown = names(s);
  assert.equal(shown[1], onStage.name, shown.join(', '));
  assert.equal(shown[2], 'Maud', shown.join(', '));
  s.songEnded(loaded.ids);
  assert.deepEqual(sends18(s, 4), shown.slice(0, 4));
});

test('passe 21 : cinq priorités dont la dernière avec retrait, puis « Annuler » avant ou après le retour du titre : la personne sautée reste devant la nouvelle table', () => {
  for (const order of ['annuler puis retour', 'retour puis annuler']) {
    const { s, people } = secondRound18({ requirePresence: true });
    for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
    const stage = s.select(); s.commit(stage);
    s.skipUnconfirmed(people.Maud.id, 3);
    const loaded = s.select(); s.commit(loaded);
    assert.equal(s.reservedNext?.personId, people.Maud.id);
    const stack = [people.Hugo, people.Ines, people.Jade, people.Elsa, people.Karim]
      .filter(p => !loaded.ids.includes(p.id) && !stage.ids.includes(p.id));
    assert.equal(stack.length, 5);
    for (const p of stack.slice(0, 4)) gesture(s, p, 0, [...stage.ids, ...loaded.ids]);
    const tr = { sel: loaded };
    pullFor18(s, tr, stack[4], stage.ids);
    newcomer18(s, 'Nina');
    if (order === 'annuler puis retour') { s.undoLastManualChange(null, NATIVE, { busyIds: stage.ids }); back18(s, tr, stage.ids); }
    else { back18(s, tr, stage.ids); s.undoLastManualChange(null, NATIVE, { busyIds: stage.ids }); }
    const shown = names(s, stage.ids);
    assert.ok(shown.indexOf('Maud') >= 0 && shown.indexOf('Maud') < shown.indexOf('Nina'), `${order} : ${shown.join(', ')}`);
    s.songEnded(stage.ids);
    assert.deepEqual(sends18(s, 8), shown.slice(0, 8), order);
  }
});

test('passe 21 : « Remplacer ma prochaine chanson » sur le titre retiré qui attend sa priorité : le nouveau titre garde sa place, en report comme dans la chaîne', () => {
  for (const newer of [false, true]) {
    const { s, people } = secondRound18();
    const stage = s.select(); s.commit(stage);
    const loaded = s.select(); s.commit(loaded);
    const T = s.people.get(loaded.ids[0]);
    const tr = { sel: loaded };
    pullFor18(s, tr, people.Karim, stage.ids);
    back18(s, tr);
    if (newer) gesture(s, people.Hugo, 0, stage.ids);
    newcomer18(s, 'Zoe'); newcomer18(s, 'Yann');
    const lead = newer ? ['Hugo', 'Karim'] : ['Karim'];
    assert.deepEqual(names(s, stage.ids).slice(0, lead.length + 1), [...lead, T.name]);
    s.chooseSong(T, song(), 'replace');
    const shown = names(s, stage.ids);
    assert.deepEqual(shown.slice(0, lead.length + 1), [...lead, T.name], `${newer ? 'chaîne' : 'report'} : ${shown.join(', ')}`);
    s.songEnded(stage.ids);
    assert.deepEqual(sends18(s, 5), shown.slice(0, 5), newer ? 'chaîne' : 'report');
  }
});

test('passe 21 : un duo retiré qui attend en simple report, puis un autre titre retiré pour la priorité suivante : celui-ci passe juste après elle, comme montré', () => {
  const { s, people } = secondRound18();
  const stage = s.select(); s.commit(stage);
  const order = names(s, stage.ids).map(n => people[n]).filter(Boolean);
  const O = order[0];
  const G = order.find(p => p !== O && p !== order[1] && p !== order[2]);
  s.requestDuetJoin(G, O.id, O.song.entryId);
  s.answerDuetJoin(O, O.song.entryId, G.id, true);
  const loaded = s.select(); s.commit(loaded);
  assert.deepEqual(loaded.ids, [O.id, G.id]);
  const rest = names(s, stage.ids).map(n => people[n]).filter(p => p && p !== G && !loaded.ids.includes(p.id) && !stage.ids.includes(p.id));
  const X = rest[0];
  const tr = { sel: loaded };
  pullFor18(s, tr, X, stage.ids);
  back18(s, tr);
  s.requestDuetJoin(G, X.id, X.song.entryId);
  s.answerDuetJoin(X, X.song.entryId, G.id, true);
  s.songEnded(stage.ids);
  for (const p of s.people.values()) s.confirm(p);
  const xs = s.select(); s.commit(xs); // X & G part, le duo d'O ne peut pas les suivre
  assert.deepEqual(xs.ids, [X.id, G.id]);
  tick20();
  const Y = names(s, xs.ids).map(n => people[n]).filter(p => p && !xs.ids.includes(p.id) && p !== O)[1];
  const tr2 = { sel: xs };
  pullFor18(s, tr2, Y, []);
  back18(s, tr2);
  const shown = names(s).slice(0, 5);
  assert.deepEqual(shown.slice(0, 2), [Y.name, `${X.name} & ${G.name}`], shown.join(', '));
  assert.deepEqual(sends18(s, 5), shown);
});

test('passe 21 : « Annuler » recalculé d’une cinquième priorité qui avait fait tomber la personne sautée : elle est de nouveau gardée, sans être aussi sautée', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded);
  const stack = [people.Hugo, people.Ines, people.Jade, people.Elsa, people.Karim]
    .filter(p => !loaded.ids.includes(p.id) && !stage.ids.includes(p.id));
  for (const p of stack) gesture(s, p, 0, [...stage.ids, ...loaded.ids]);
  newcomer18(s, 'Nina');
  assert.equal(s.canUndoManualChange(NATIVE), false, 'annulation recalculée');
  s.undoLastManualChange(null, NATIVE, { busyIds: [...stage.ids, ...loaded.ids] });
  assert.equal(s._isPresenceRetry(people.Maud), false);
  s.songEnded(stage.ids); s.songEnded(loaded.ids);
  for (let k = 0; k < 6; k++) {
    for (const p of s.people.values()) if (!p.withdrawnAt) s.confirm(p);
    const first = names(s)[0];
    const sel = s.select();
    assert.ok(sel, `passage ${k + 1} envoyé`);
    assert.equal(label(s, sel), first, `passage ${k + 1} : la tête montrée est envoyée`);
    s.commit(sel); s.songEnded(sel.ids);
  }
});

test('passe 21 : le bar déplace dans la chaîne une priorité qu’elle gardait : elle y reste priorité du bar, à la place donnée', () => {
  const { s, people } = secondRound18({ requirePresence: true });
  for (const p of Object.values(people)) if (p !== people.Maud) s.confirm(p);
  const stage = s.select(); s.commit(stage);
  s.skipUnconfirmed(people.Maud.id, 3);
  const loaded = s.select(); s.commit(loaded);
  s.songEnded(stage.ids);
  const order = names(s, loaded.ids).filter(n => n !== 'Maud');
  const W = people[order[0]], X = people[order[1]];
  gesture(s, W, 0, loaded.ids);
  gesture(s, X, 0, loaded.ids); // X > W > Maud
  newcomer18(s, 'Nina');
  assert.deepEqual(names(s, loaded.ids).slice(0, 3), [X.name, W.name, 'Maud']);
  gesture(s, W, 2, loaded.ids); // W derrière Maud
  const shown = names(s, loaded.ids);
  assert.deepEqual(shown.slice(0, 3), [X.name, 'Maud', W.name], shown.join(', '));
  let link = s.reservedNext;
  while (link && link.personId !== W.id) link = link.then;
  assert.equal(link?.byStaff, true, 'toujours priorité du bar');
  s.songEnded(loaded.ids);
  assert.deepEqual(sends18(s, 5), shown.slice(0, 5));
});
