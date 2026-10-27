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
    const [paulo, gil]= [people.Paulo, people.Gil].map(p => s.people.get(p.id));
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
// KaraFun a retiré le titre : comme restorePulled (server.js). `forId` :
// personne de la priorité pour laquelle il est sorti.
function pulledBack(s, sel, forId) {
  s.requeueUnplayed(sel);
  return s.yieldToPriority(sel, forId);
}

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
  assert.equal(s.reservedNext, null, 'la priorité de Karim prend fin');
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
