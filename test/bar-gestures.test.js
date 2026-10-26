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

test('duo noté au bar avec la personne prioritaire : sa priorité tient', () => {
  const { s, people } = evening();
  const sent = s.select();
  s.commit(sent);
  gesture(s, people.Karim, 0);
  s.staffCountPartner(sent.ids[0], people.Karim.id, sent);
  assert.equal(s.reservedNext?.personId, people.Karim.id, 'le geste du bar passe avant l’espacement');
  assert.match(s.log.at(-1).msg, /Karim garde son titre et la place donnée par le bar$/,
    'le journal du bar ne dit plus qu’elle attend deux autres chansons');
  assert.equal(s.select().ids[0], people.Karim.id);
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

// Choix à faire valider par le gérant (CONTEXTE-REPRISE.md) : la place
// donnée par le bar tient même quand la personne est invitée dans un duo
// plus haut ; elle chante alors deux fois à peu d'intervalle.
test('ligne placée par le bar invitée dans un duo plus haut : elle garde sa place', () => {
  const { s, people } = evening();
  gesture(s, people.Elsa, 3);
  const duo = s.inviteDuet(people.Paulo, people.Elsa.id, song());
  s.reorderSongs(people.Paulo, duo.entryId, 0);
  s.answerDuet(people.Elsa, true, duo.entryId);
  assert.deepEqual(playNames(s, 4), ['Paulo & Elsa', 'Maud', 'Gil', 'Elsa']);
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
