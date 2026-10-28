'use strict';
// « Je suis là » : un duo est présent dès que l'un des deux confirme ; un
// passage non confirmé laisse passer le suivant et revient juste après lui ;
// au bout de trois fois, le titre est retiré et le bar est prévenu.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');

let n = 1;
const song = () => ({ songId: n, title: `Titre ${n++}`, artist: 'Essai' });

function evening() {
  const s = new Scheduler({ requirePresence: true });
  const people = {};
  for (const [tableId, name] of [['1', 'Alice'], ['2', 'Bruno'], ['3', 'Chloé'], ['4', 'Driss']]) {
    people[name] = s.join({ tableId, name, headcount: 2 });
    s.chooseSong(people[name], song());
    s.chooseSong(people[name], song(), 'append');
  }
  const names = view => view.map(item => item.ids.map(pid => s.people.get(pid).name).join(' & '));
  const sing = sel => { s.commit(sel); s.songEnded(sel.ids); };
  return { s, people, names, sing };
}

test('un passage non confirmé laisse passer le suivant, revient juste après, puis est retiré au troisième', () => {
  const { s, people, names, sing } = evening();
  const first = s.reservePresenceNext();
  assert.equal(first.ids[0], people.Alice.id);
  assert.equal(s.select(), null, 'Alice n’a pas confirmé : rien ne part');

  assert.deepEqual(s.skipUnconfirmed(people.Alice.id, 3), { removed: false, skips: 1, title: 'Titre 1' });
  assert.equal(s.reservedNext, null);
  assert.deepEqual(names(s.presenceView()).slice(0, 3), ['Bruno', 'Alice', 'Chloé'],
    'Alice revient juste après le passage suivant');
  assert.equal(s.reservePresenceNext().ids[0], people.Bruno.id, 'Bruno est annoncé et reçoit la demande');
  s.confirm(people.Bruno);
  const bruno = s.select();
  assert.deepEqual(bruno.ids, [people.Bruno.id]);
  sing(bruno);
  assert.equal(s.reservedNext.personId, people.Alice.id, 'Alice redevient la prochaine annoncée');
  assert.equal(people.Alice.presenceRetry, false);

  // Deuxième puis troisième manque.
  s.skipUnconfirmed(people.Alice.id, 3);
  s.reservePresenceNext();
  s.confirm(people.Chloé);
  sing(s.select());
  assert.equal(s.reservedNext.personId, people.Alice.id);
  const removed = s.skipUnconfirmed(people.Alice.id, 3);
  assert.equal(removed.removed, true, 'au troisième manque, le titre est retiré');
  assert.deepEqual(s.songsOf(people.Alice).map(item => item.title), ['Titre 2'], 'seul le titre en cause part');
  assert.equal(people.Alice.maybeGone.skips, 3, 'le bar est prévenu');
  assert.equal(people.Alice.presenceRetry, false);
  s.dismissMaybeGone(people.Alice);
  assert.equal(people.Alice.maybeGone, null);
});

test('la prévision montre exactement l’ordre envoyé, même quand seul le titre passé reste', () => {
  const { s, people, names, sing } = evening();
  s.reservePresenceNext();
  s.skipUnconfirmed(people.Alice.id, 3);
  const forecast = names(s.presenceView());
  const real = [];
  while (real.length < forecast.length) {
    const next = s.reservePresenceNext();
    if (!next) break;
    for (const pid of next.ids) s.confirm(s.people.get(pid));
    const sel = s.select();
    real.push(names([sel])[0]);
    sing(sel);
  }
  assert.deepEqual(real, forecast);

  // Seule Alice a encore un titre : elle revient aussitôt.
  const solo = new Scheduler({ requirePresence: true });
  const alice = solo.join({ tableId: '1', name: 'Alice', headcount: 1 });
  solo.chooseSong(alice, song());
  solo.reservePresenceNext();
  solo.skipUnconfirmed(alice.id, 3);
  assert.equal(solo.presenceView()[0].ids[0], alice.id);
  assert.equal(solo.reservePresenceNext().ids[0], alice.id, 'nouvelle demande à Alice');
  assert.equal(alice.presenceRetry, false);
});

test('duo : la confirmation de l’un des deux suffit', () => {
  const s = new Scheduler({ requirePresence: true });
  const owner = s.join({ tableId: '1', name: 'Olga', headcount: 2 });
  const guest = s.join({ tableId: '1', name: 'Gus' });
  s.inviteDuet(owner, guest.id, song());
  assert.equal(s.reservePresenceNext().ids.length, 2);
  assert.equal(s.select(), null);
  s.confirm(guest);
  const sel = s.select();
  assert.deepEqual(sel.ids, [owner.id, guest.id], 'Gus a confirmé pour le duo');
  assert.equal(sel.presenceConfirmed, true);
});

test('les passages manqués survivent à un redémarrage', () => {
  const { s, people } = evening();
  s.reservePresenceNext();
  s.skipUnconfirmed(people.Alice.id, 3);
  const access = new TableAccess();
  for (const id of s.tables.keys()) access.issue(id);
  const settings = { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8, presenceGraceSec: 45, presenceMaxSkips: 4 };
  const restored = new Scheduler({});
  const restoredSettings = {};
  restoreNight(snapshotNight({ scheduler: s, access, settings }), { scheduler: restored, access: new TableAccess(), settings: restoredSettings });
  const alice = restored.people.get(people.Alice.id);
  assert.equal(alice.presenceRetry, true);
  assert.equal(alice.presenceSkips, 1);
  assert.deepEqual([restoredSettings.presenceGraceSec, restoredSettings.presenceMaxSkips], [45, 4]);
  assert.deepEqual(restored.presenceView().map(item => item.ids[0]), s.presenceView().map(item => item.ids[0]));
  const broken = snapshotNight({ scheduler: s, access, settings: { ...settings, presenceMaxSkips: 0 } });
  assert.throws(() => restoreNight(broken, { scheduler: new Scheduler({}), access: new TableAccess(), settings: {} }),
    /réglages mal formés/);
});

test('les manques comptent pour le titre passé : un titre remplacé repart de zéro', () => {
  const { s, people, names } = evening();
  s.reservePresenceNext();
  s.skipUnconfirmed(people.Alice.id, 3);
  assert.equal(s.presenceSkipsOf(people.Alice), 1);
  // Alice remplace le titre passé : le nouveau n'hérite ni du report ni du compteur.
  s.chooseSong(people.Alice, song(), 'replace');
  assert.equal(s.presenceSkipsOf(people.Alice), 0);
  assert.equal(s._isPresenceRetry(people.Alice), false);
  assert.equal(names(s.presenceView())[0], 'Alice', 'son nouveau titre reprend sa place normale');
  s.reservePresenceNext();
  assert.deepEqual(s.skipUnconfirmed(people.Alice.id, 3).skips, 1, 'premier manque pour ce nouveau titre');
});

test('passage intercalé retiré avant d’être chanté : le titre passé attend de nouveau', () => {
  const { s, people, names } = evening();
  s.reservePresenceNext();
  s.skipUnconfirmed(people.Alice.id, 3);
  s.reservePresenceNext();
  s.confirm(people.Bruno);
  const bruno = s.select();
  s.commit(bruno);
  assert.equal(s.reservedNext.personId, people.Alice.id);
  // KaraFun retire le titre de Bruno avant sa lecture.
  s.rollbackUnplayed(bruno, { requeue: true });
  assert.equal(s.reservedNext, null, 'Alice n’est plus annoncée sans qu’un passage ait chanté devant elle');
  assert.equal(s._isPresenceRetry(people.Alice), true);
  assert.notEqual(names(s.presenceView())[0], 'Alice');

  // Si Alice a confirmé entre-temps, elle garde sa place annoncée.
  const other = evening();
  other.s.reservePresenceNext();
  other.s.skipUnconfirmed(other.people.Alice.id, 3);
  other.s.reservePresenceNext();
  other.s.confirm(other.people.Bruno);
  const sel = other.s.select();
  other.s.commit(sel);
  other.s.confirm(other.people.Alice);
  other.s.rollbackUnplayed(sel, { requeue: true });
  assert.equal(other.s.reservedNext.personId, other.people.Alice.id);
});

test('titre passé dont la personne chante en invitée juste devant : présence prouvée, pas de retour immédiat', () => {
  const s = new Scheduler({ requirePresence: true });
  const alice = s.join({ tableId: '1', name: 'Alice', headcount: 1 });
  const bruno = s.join({ tableId: '2', name: 'Bruno', headcount: 1 });
  const chloe = s.join({ tableId: '3', name: 'Chloé', headcount: 1 });
  s.chooseSong(alice, song());
  s.inviteDuet(bruno, alice.id, song());
  s.answerDuet(alice, true);
  s.chooseSong(chloe, song());
  for (const p of [alice, bruno, chloe]) { p.sung = 1; p.lastAppearanceTurn = 1; }
  s.appearanceSerial = 10;
  const names = view => view.map(item => item.ids.map(pid => s.people.get(pid).name).join(' & '));
  assert.equal(s.reservePresenceNext().ids[0], alice.id);
  s.skipUnconfirmed(alice.id, 3);
  const forecast = names(s.presenceView());
  // Alice monte sur scène en invitée : son propre titre ne suit pas aussitôt
  // (pas deux passages d'affilée), il reprend sa place dans la rotation.
  assert.deepEqual(forecast, ['Bruno & Alice', 'Chloé', 'Alice']);
  const duo = s.reservePresenceNext();
  s.confirm(alice);
  assert.deepEqual(s.select().ids, duo.ids);
  s.commit(s.select()); s.songEnded(duo.ids);
  assert.equal(s.presenceSkipsOf(alice), 0, 'monter sur scène efface les manques');
  assert.equal(s._isPresenceRetry(alice), false);
  const real = ['Bruno & Alice'];
  while (real.length < forecast.length) {
    const next = s.reservePresenceNext();
    for (const pid of next.ids) s.confirm(s.people.get(pid));
    const sel = s.select();
    real.push(names([sel])[0]);
    s.commit(sel); s.songEnded(sel.ids);
  }
  assert.deepEqual(real, forecast, 'la prévision montrait déjà cet ordre');
});

// Relecture : le guide dit qu'un titre retiré faute de « Je suis là »
// n'envoie pas la personne en fin de tour (son titre suivant est annoncé
// aussitôt, avec une nouvelle demande ; si elle n'a encore jamais chanté,
// après les premiers passages qui attendaient déjà), que « Toujours là »
// ferme seulement l'alerte, et que « Marquer parti » retire ses titres et
// arrête ces annonces. Relecture (passe 5) : Bruno et Chloé ont déjà chanté
// dans le tour, Driss est le dernier premier passage, donc « juste après
// Driss » était aussi la fin du tour ; Emma, premier passage demandé après
// le retrait, montre qu'Alice n'y est pas renvoyée.
test('titre retiré faute de présence en cours de soirée : pas renvoyée en fin de tour, suivant annoncé après les premiers passages qui attendaient déjà, « Toujours là » ne confirme rien, « Marquer parti » arrête', () => {
  const { s, people, names, sing } = evening();
  const alice = people.Alice;
  const next = () => {
    const r = s.reservePresenceNext();
    for (const pid of r.ids) s.confirm(s.people.get(pid));
    sing(s.select());
  };
  for (let miss = 1; miss <= 2; miss++) {
    assert.equal(s.reservePresenceNext().ids[0], alice.id);
    assert.equal(s.skipUnconfirmed(alice.id, 3).removed, false);
    next();
  }
  assert.equal(s.reservePresenceNext().ids[0], alice.id);
  assert.equal(s.skipUnconfirmed(alice.id, 3).removed, true, 'troisième manque : titre retiré');
  assert.ok(s.appearanceSerial >= 2, 'des passages ont eu lieu entre-temps');
  assert.equal(s.songsOf(alice).length, 1);
  // Son titre suivant ouvre une nouvelle attente : elle garde la priorité
  // des premiers passages, derrière Driss, qui attendait avant elle (premier
  // ajouté, premier servi, constat du 25 octobre), devant Emma, arrivée
  // après le retrait, et avant tout retour.
  const emma = s.join({ tableId: '5', name: 'Emma', headcount: 1 });
  s.chooseSong(emma, song());
  assert.equal(s.reservePresenceNext().ids[0], people.Driss.id, 'Driss attendait avant sa nouvelle attente');
  assert.deepEqual(names(s.presenceView()).slice(0, 3), ['Driss', 'Alice', 'Emma']);
  next();
  assert.equal(s.reservePresenceNext().ids[0], alice.id, 'pas renvoyée en fin de tour : nouvelle demande aussitôt');
  assert.deepEqual(names(s.presenceView()).slice(0, 2), ['Alice', 'Emma'], 'Emma, arrivée après le retrait, passe après elle');
  const view = JSON.stringify(s.presenceView().map(v => v.ids));
  const state = JSON.stringify([s.Q, s.reservedNext.personId, s.manualContextFingerprint(), s.solverContextFingerprint()]);
  assert.equal(s.dismissMaybeGone(alice),
    `Alerte fermée pour Alice (Table 1). Prochain passage : « ${s.songsOf(alice)[0].title} ». Ce passage redemandera « Je suis là ».`);
  assert.equal(alice.maybeGone, null);
  assert.equal(s.select(), null, '« Toujours là » ne confirme pas la présence');
  assert.equal(JSON.stringify(s.presenceView().map(v => v.ids)), view, 'ni ne change la file');
  assert.equal(JSON.stringify([s.Q, s.reservedNext.personId, s.manualContextFingerprint(), s.solverContextFingerprint()]), state,
    'ni sa place dans le tour');
  assert.equal(s.dismissMaybeGone(alice), null, 'alerte déjà fermée');
  s.leave(alice, 'staff');
  assert.equal(s.songsOf(alice).length, 0, '« Marquer parti » retire ses titres restants');
  assert.equal(s.reservedNext, null);
  const after = s.reservePresenceNext();
  assert.ok(after && after.ids[0] !== alice.id, 'et arrête les annonces : la suite part sans elle');
  assert.equal(after.ids[0], emma.id);
});

// Relecture : avec un seul titre, le retrait faute de « Je suis là » vide sa
// liste ; « Toujours là » le dit au lieu d'annoncer une nouvelle demande.
test('« Toujours là » après le retrait du seul titre : aucun passage prévu, un titre à rechoisir', () => {
  const s = new Scheduler({ requirePresence: true });
  const [alice, bruno] = ['Alice', 'Bruno'].map((name, i) => s.join({ tableId: String(i + 1), name, headcount: 1 }));
  s.chooseSong(alice, song()); s.chooseSong(bruno, song());
  assert.equal(s.reservePresenceNext().ids[0], alice.id);
  assert.equal(s.skipUnconfirmed(alice.id, 1).removed, true);
  assert.equal(s.songsOf(alice).length, 0);
  assert.equal(s.dismissMaybeGone(alice), 'Alerte fermée pour Alice (Table 1). Aucun passage prévu : un titre à rechoisir sur son téléphone.');
  assert.equal(s.reservePresenceNext().ids[0], bruno.id);
  // Option coupée ensuite, alerte encore ouverte : la liste vide se dit quand même.
  s.opts.requirePresence = false;
  alice.maybeGone = { at: Date.now(), title: 'x', skips: 1 };
  assert.equal(s.dismissMaybeGone(alice), 'Alerte fermée pour Alice (Table 1). Aucun passage prévu : un titre à rechoisir sur son téléphone.');
});

// Relecture : le message donne le premier passage de la file où elle chante,
// duo d'invitée compris, et dit s'il redemandera « Je suis là » ou si la
// présence est déjà confirmée (par elle ou son partenaire de duo) ; sans
// titre à son nom, il faut en rechoisir un sur son téléphone.
test('« Toujours là » : prochain passage de la file, duo d’invitée, présence déjà confirmée', () => {
  const s = new Scheduler({ requirePresence: true });
  const zoe = s.join({ tableId: '1', name: 'Zoé', headcount: 3 });
  const alice = s.join({ tableId: '1', name: 'Alice', headcount: 3 });
  const olga = s.join({ tableId: '1', name: 'Olga', headcount: 3 });
  // Le duo d'Olga est ajouté avant le titre d'Alice : premiers passages dans
  // l'ordre d'ajout, il passe d'abord.
  s.inviteDuet(olga, alice.id, song()); // même table : duo accepté d'office
  s.chooseSong(alice, song());
  s.chooseSong(zoe, song()); s.chooseSong(zoe, song(), 'append');
  s.inviteDuet(zoe, alice.id, song());
  alice.maybeGone = { at: Date.now(), title: 'x', skips: 3 };
  const first = s.presenceView().find(v => v.ids.includes(alice.id));
  assert.deepEqual(first.ids, [olga.id, alice.id], 'le duo d’Olga passe avant son propre titre');
  assert.equal(s.dismissMaybeGone(alice),
    `Alerte fermée pour Alice (Table 1). Prochain passage : « ${first.song.title} » en duo avec Olga (Table 1). Ce passage redemandera « Je suis là ».`,
    'le duo qui passe d’abord, sans « titre à rechoisir » : il lui reste le sien');
  for (const entry of s.songsOf(alice)) s.removeSong(alice, entry.entryId, 'staff');
  const duos = s.presenceView().filter(v => v.ids.includes(alice.id));
  assert.deepEqual(duos.map(v => s.people.get(v.ids[0]).name), ['Olga', 'Zoé'], 'Olga est arrivée après Zoé mais passe avant');
  const duo = `Prochain passage : « ${duos[0].song.title} » en duo avec Olga (Table 1).`;
  const own = ' Pour un passage à son nom, un titre à rechoisir sur son téléphone.';
  assert.equal(s.presenceFollowUp(alice), `${duo} Ce passage redemandera « Je suis là ».${own}`);
  s.confirm(olga);
  assert.equal(s.presenceFollowUp(alice), `${duo} Présence déjà confirmée.${own}`, 'la réponse de son partenaire suffit');
  s.opts.requirePresence = false;
  assert.equal(s.presenceFollowUp(alice), `${duo}${own}`);
});
