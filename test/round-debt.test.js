'use strict';
// Soirée du 10 octobre : une chanteuse de table attend 65 min. Pendant ce
// temps, un soliste (« En solo ») repasse une seconde fois dans le même tour
// grâce à la règle anti-série, puis repasse encore devant elle au tour suivant. Un
// passage pris en avance sur le tour doit être décompté du tour suivant.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');

// `opts` : réglages de la soirée. En « Chacun son tour » (défaut), la règle
// de patience garde l'ordre du tour précédent (Amie, Solo1, Solo2, Attente) :
// la personne qui attend depuis le plus longtemps est alors de la table T1, et
// la règle anti-série ne peut intercaler aucun soliste sans la doubler. Les
// scénarios d'emprunt par la règle anti-série tournent donc en « Tables à tour
// de rôle », où la rotation des tables passe avant la patience.
const TABLES_TOUR_DE_ROLE = { tableRotation: true };

function evening(opts = {}) {
  let n = 1;
  const song = () => ({ songId: n++, title: `Titre ${n}`, artist: 'Essai' });
  const s = new Scheduler(opts);
  s._maybeRequestSolver = () => {};
  s.setHeadcount('T1', 12);
  const people = ['Solo1', 'Attente', 'Amie', 'Solo2'].map(name =>
    s.join({ tableId: ['Solo1', 'Solo2'].includes(name) ? 'Comptoir' : 'T1', name }));
  // Les premiers passages suivent l'ordre d'ajout (« Chacun son tour ») :
  // Amie, Solo1, Solo2, Attente, comme la part des tables les rangeait.
  const added = ['Amie', 'Solo1', 'Solo2', 'Attente'].map(name => people.find(p => p.name === name));
  for (const p of added) for (let k = 0; k < 6; k++) s.chooseSong(p, song(), 'append');
  const played = [];
  const send = () => {
    const sel = s.select();
    s.commit(sel);
    s.songEnded(sel.ids);
    played.push(sel);
    return sel;
  };
  return { s, song, send, played, byName: name => people.find(p => p.name === name) };
}

// Personne ne doit consommer deux passages pendant l'attente d'une autre.
function doublesDuringWait(s, played, personId) {
  const at = played.map((sel, k) => sel.ids.includes(personId) ? k : -1).filter(k => k >= 0);
  const doubles = [];
  for (let i = 1; i < at.length; i++) {
    const owners = played.slice(at[i - 1] + 1, at[i]).map(sel => sel.ids[0]);
    for (const pid of new Set(owners)) {
      if (owners.filter(other => other === pid).length > 1) doubles.push(s.people.get(pid).name);
    }
  }
  return doubles;
}

test('passage emprunté par la règle anti-série : pris sur le tour suivant', () => {
  const { s, song, send, played, byName } = evening(TABLES_TOUR_DE_ROLE);
  for (let i = 0; i < 8; i++) send();
  // Arrivée d'un seul titre à cette table, juste après un passage de sa table.
  const sara = s.join({ tableId: 'T1', name: 'Sara' });
  s.chooseSong(sara, song(), 'append');
  const borrowed = send();
  assert.equal(borrowed.names[0], 'Solo1', 'la règle anti-série intercale un soliste');
  assert.deepEqual(borrowed.borrowedIds, [byName('Solo1').id], 'second passage du tour : emprunté');
  for (let i = 0; i < 8; i++) send();
  assert.deepEqual(doublesDuringWait(s, played, byName('Attente').id), [],
    played.map(sel => sel.names[0]).join(' '));
  // Au tour suivant, Solo1 passe après celles et ceux qui attendaient.
  const nextRound = played.slice(played.indexOf(borrowed) + 1);
  const start = nextRound.findIndex(sel => sel.newPersonRound);
  const round = nextRound.slice(start, start + 3).map(sel => sel.names[0]);
  assert.ok(!round.slice(0, 2).includes('Solo1'), `tour suivant : ${round.join(' ')}`);
});

test('prochain annoncé en fin de tour puis rattrapé par une arrivée : passage emprunté', () => {
  const { s, song, send } = evening();
  for (let i = 0; i < 4; i++) send();
  // Tout le monde a chanté dans ce tour : le prochain annoncé ouvre le tour suivant.
  const announced = s.reserveNext();
  assert.ok(announced.newPersonRound, 'annoncé comme premier du tour suivant');
  const sara = s.join({ tableId: 'T1', name: 'Sara' });
  s.chooseSong(sara, song(), 'append');
  const sent = send();
  assert.equal(sent.ids[0], announced.ids[0], 'la promesse faite au prochain annoncé tient');
  assert.ok(!sent.newPersonRound, 'Sara n’a pas chanté : le tour continue');
  assert.deepEqual(sent.borrowedIds, [announced.ids[0]], 'son passage est pris sur le tour suivant');
  assert.ok(s.roundUse.get(announced.ids[0]) > 1, 'dette reportée au tour suivant');
  // Le prochain annoncé (Amie, de T1) attendait depuis le plus longtemps. Sara,
  // de la même table, laisse passer un soliste (règle anti-série), lui aussi
  // pris sur le tour suivant, puis chante.
  const interleaved = send();
  assert.equal(interleaved.names[0], 'Solo1', 'la règle anti-série intercale un soliste');
  assert.deepEqual(interleaved.borrowedIds, [interleaved.ids[0]]);
  const after = send();
  assert.equal(after.ids[0], sara.id, 'Sara chante ensuite');
  assert.equal(s.roundUse.get(announced.ids[0]), 2, 'dette inchangée par le passage de Sara');
});

test('« Chacun son tour » : une arrivée à la table qui vient de chanter ne fait doubler personne', () => {
  const { s, song, send, played, byName } = evening();
  for (let i = 0; i < 8; i++) send();
  assert.deepEqual(played.map(sel => sel.names[0]),
    ['Amie', 'Solo1', 'Solo2', 'Attente', 'Amie', 'Solo1', 'Solo2', 'Attente'], 'le tour 2 reprend l’ordre du tour 1');
  const sara = s.join({ tableId: 'T1', name: 'Sara' });
  s.chooseSong(sara, song(), 'append');
  // Intercaler un soliste ferait voir à Amie, qui attend depuis le plus
  // longtemps, un passage en double : Sara chante tout de suite, même si sa
  // table vient de chanter.
  const next = send();
  assert.equal(next.ids[0], sara.id);
  assert.equal(next.borrowedIds, undefined, 'aucun emprunt');
  for (let i = 0; i < 8; i++) send();
  for (const name of ['Attente', 'Amie', 'Solo1', 'Solo2']) {
    assert.deepEqual(doublesDuringWait(s, played, byName(name).id), [], `${name} : ${played.map(sel => sel.names[0]).join(' ')}`);
  }
});

test('priorité donnée par le bar : aucune dette de tour', () => {
  const { s, send, byName } = evening();
  for (let i = 0; i < 4; i++) send();
  const solo1 = byName('Solo1');
  s.reservedNext = { personId: solo1.id, reservedAt: Date.now(), byStaff: true };
  const sent = send();
  assert.equal(sent.ids[0], solo1.id);
  assert.equal(sent.borrowedIds, undefined, 'la décision du bar ne retarde pas son tour suivant');
});

// Le serveur annonce le prochain passage pendant la chanson en cours.
const announceThenSend = s => {
  s.reserveNext();
  const sel = s.select();
  s.commit(sel);
  s.songEnded(sel.ids);
  return sel;
};

test('priorité du bar en plein tour, sur quelqu’un qui a déjà chanté : aucune dette de tour', () => {
  const { s, send } = evening();
  const first = send();
  send();
  s.staffMove(first.ids[0], 0);
  assert.equal(s.reservedNext?.byStaff, true);
  const sent = send();
  assert.equal(sent.ids[0], first.ids[0]);
  assert.equal(sent.newPersonRound, false, 'tour en cours');
  assert.equal(sent.borrowedIds, undefined, 'la décision du bar ne crée pas de dette');
});

test('déplacement du bar à la 2e place, puis annonce automatique : aucune dette de tour', () => {
  const { s, send } = evening();
  const first = send();
  send();
  s.staffMove(first.ids[0], 1);
  const next = announceThenSend(s);
  assert.notEqual(next.ids[0], first.ids[0]);
  const moved = announceThenSend(s);
  assert.equal(moved.ids[0], first.ids[0], 'place choisie par le bar');
  assert.equal(moved.borrowedIds, undefined, 'l’ordre du bar ne crée pas de dette');
  assert.ok(!s.roundUse.has(first.ids[0]));
});

test('duo annoncé pour présenter une nouvelle invitée : pas de dette pour son auteur', () => {
  let n = 1;
  const song = () => ({ songId: n++, title: `Titre ${n}`, artist: 'Essai' });
  const s = new Scheduler();
  s._maybeRequestSolver = () => {};
  const ana = s.join({ tableId: '1', name: 'Ana', headcount: 2 });
  const ben = s.join({ tableId: '2', name: 'Ben', headcount: 1 });
  const chloe = s.join({ tableId: '1', name: 'Chloé' });
  s.chooseSong(ana, song(), 'append');
  s.chooseSong(ben, song(), 'append');
  s.inviteDuet(ana, chloe.id, song());
  s.chooseSong(ben, song(), 'append');
  const sent = [announceThenSend(s), announceThenSend(s), announceThenSend(s)];
  const duo = sent.find(sel => sel.ids.length === 2);
  assert.deepEqual(duo?.ids, [ana.id, chloe.id], sent.map(sel => sel.ids.join('+')).join(' '));
  assert.equal(duo.newPersonRound, false);
  assert.equal(duo.borrowedIds, undefined, 'le duo présente Chloé : rien d’emprunté');
  assert.ok(!s.roundUse.has(ana.id));
});

test('dette en cours : chanter en invitée de duo ne coûte pas un tour de plus', () => {
  const s = new Scheduler();
  s._maybeRequestSolver = () => {};
  const ana = s.join({ tableId: '1', name: 'Ana', headcount: 1 });
  // Passage emprunté au tour précédent : ce tour-ci est déjà pris.
  s.roundPeople.add(ana.id);
  s.roundUse.set(ana.id, 1);
  s._useRound(s.roundPeople, s.roundUse, ana.id);
  assert.equal(s.roundUse.get(ana.id), 1, 'invitée d’un duo : son ticket reste intact');
  s._useRound(s.roundPeople, s.roundUse, ana.id, true);
  assert.equal(s.roundUse.get(ana.id), 2, 'un nouveau passage emprunté reste décompté');
});

test('dette en cours, invitée d’un duo qui ouvre le tour puis se retire : la dette reste due', () => {
  let n = 1;
  const song = () => ({ songId: n++, title: `Titre ${n}`, artist: 'Essai' });
  const s = new Scheduler();
  s._maybeRequestSolver = () => {};
  const ana = s.join({ tableId: '1', name: 'Ana', headcount: 2 });
  const xia = s.join({ tableId: '1', name: 'Xia' });
  // Tour fini ; Xia a chanté deux fois (second passage emprunté au tour suivant).
  s.roundPeople.add(ana.id);
  s.roundPeople.add(xia.id);
  s.roundUse.set(xia.id, 2);
  s.inviteDuet(ana, xia.id, song());
  const duo = s.select();
  assert.deepEqual(duo.ids, [ana.id, xia.id]);
  assert.ok(duo.newPersonRound, 'le duo ouvre le tour suivant');
  s.commit(duo);
  assert.equal(s.roundUse.get(xia.id), 1, 'tour suivant pris par la dette');
  s.leaveSentDuet(duo, xia.id);
  assert.equal(s.roundUse.get(xia.id), 1, 'le retrait ne rend pas une part jamais prise');
  assert.ok(s.roundPeople.has(xia.id), 'Xia laisse toujours passer ce tour');
});

test('prochain annoncé emprunteur : la dette survit à un redémarrage', () => {
  const { TableAccess } = require('../table-access');
  const { snapshotNight, restoreNight } = require('../night-state');
  const { s, song, send } = evening();
  for (let i = 0; i < 4; i++) send();
  const announced = s.reserveNext();
  assert.equal(s.reservedNext.borrowable, true);
  const access = new TableAccess();
  for (const id of s.tables.keys()) access.issue(id);
  const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access,
    settings: { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 } })));
  const restore = () => {
    const r = new Scheduler();
    r._maybeRequestSolver = () => {};
    restoreNight(structuredClone(snapshot), { scheduler: r, access: new TableAccess(), settings: {} });
    return r;
  };
  const r = restore();
  assert.equal(r.reservedNext?.borrowable, true);
  const sara = r.join({ tableId: 'T1', name: 'Sara' });
  r.chooseSong(sara, song(), 'append');
  const sel = r.select();
  r.commit(sel);
  assert.deepEqual(sel.borrowedIds, [announced.ids[0]], 'dette toujours prise sur le tour suivant');
  snapshot.scheduler.reservedNext.borrowable = 'oui';
  assert.equal(restore().reservedNext?.borrowable, undefined, 'valeur non booléenne ignorée');
});

test('« Je suis là » : prochain annoncé en fin de tour puis rattrapé par une arrivée, passage emprunté', () => {
  let n = 1;
  const song = () => ({ songId: n++, title: `Titre ${n}`, artist: 'Essai' });
  const s = new Scheduler({ requirePresence: true });
  s._maybeRequestSolver = () => {};
  s.setHeadcount('T1', 12);
  for (const name of ['Solo1', 'Attente', 'Amie', 'Solo2']) {
    const p = s.join({ tableId: ['Solo1', 'Solo2'].includes(name) ? 'Comptoir' : 'T1', name });
    for (let k = 0; k < 6; k++) s.chooseSong(p, song(), 'append');
  }
  const send = () => {
    for (const p of s.people.values()) if (p.song) s.confirm(p);
    const sel = s.select();
    s.commit(sel);
    s.songEnded(sel.ids);
    return sel;
  };
  for (let i = 0; i < 4; i++) send();
  const announced = s.reservePresenceNext();
  assert.equal(s.reservedNext?.borrowable, true);
  const sara = s.join({ tableId: 'T1', name: 'Sara' });
  s.chooseSong(sara, song(), 'append');
  const sent = send();
  assert.equal(sent.ids[0], announced.ids[0]);
  assert.deepEqual(sent.borrowedIds, [announced.ids[0]]);
});

test('invitée avec bonus ou malus retirée d’un duo envoyé : la part exacte prise est rendue', () => {
  for (const legacy of [false, true]) for (const level of [1, -1]) {
    const s = new Scheduler();
    s._maybeRequestSolver = () => {};
    const alice = s.join({ tableId: '1', name: 'Alice', headcount: 2 });
    const bruno = s.join({ tableId: '2', name: 'Bruno', headcount: 2 });
    s.setPersonBonus(bruno.id, level);
    const duo = s.inviteDuet(alice, bruno.id, { songId: 1, title: 'Un', artist: 'A' });
    s.answerDuet(bruno, true, duo.entryId);
    const sel = s.select();
    assert.deepEqual(sel.ids, [alice.id, bruno.id]);
    s.commit(sel);
    const charged = s.roundUse.get(bruno.id);
    assert.ok(charged > 0, `niveau ${level}`);
    assert.deepEqual(sel.turnCredit.roundCharged.find(([pid]) => pid === bruno.id), [bruno.id, charged]);
    // Ancien reçu, d'avant ce relevé : un passage entier est rendu, comme avant.
    if (legacy) delete sel.turnCredit.roundCharged;
    s.leaveSentDuet(sel, bruno.id);
    assert.equal(s.roundUse.has(bruno.id), false, `niveau ${level}${legacy ? ', ancien reçu' : ''}`);
    assert.equal(s.roundPeople.has(bruno.id), false);
  }
});

// Relecture du 12 octobre : chemin du serveur (annonce pendant la chanson en
// cours, puis envoi) pour le passage intercalé par la règle anti-série.
test('passage de la règle anti-série annoncé pendant la chanson en cours : pris sur le tour suivant', () => {
  const { s, song, byName } = evening(TABLES_TOUR_DE_ROLE);
  for (let i = 0; i < 8; i++) announceThenSend(s);
  const arrival = s.join({ tableId: 'T1', name: 'Arrivée' });
  s.chooseSong(arrival, song(), 'append');
  const announced = s.reserveNext();
  assert.equal(announced.names[0], 'Solo1', 'la règle anti-série intercale un soliste');
  assert.equal(s.reservedNext.borrowable, true, 'annonce notée comme emprunt');
  const sel = s.select(); s.commit(sel); s.songEnded(sel.ids);
  assert.deepEqual(sel.borrowedIds, [byName('Solo1').id], 'flux du serveur : second passage du tour emprunté');
  assert.ok(s.roundUse.get(byName('Solo1').id) > 1, 'dette reportée au tour suivant');
});

test('ordre du bar en fin de tour, annoncé premier du tour suivant puis rattrapé par une arrivée : aucune dette', () => {
  const { s, song, send } = evening();
  const first = send();
  send();
  send();
  // Le bar place quelqu'un qui a déjà chanté juste après le dernier du tour.
  s.staffMove(first.ids[0], 1);
  announceThenSend(s);
  const announced = s.reserveNext();
  assert.equal(announced.ids[0], first.ids[0], 'place choisie par le bar');
  const sara = s.join({ tableId: 'T1', name: 'Sara' });
  s.chooseSong(sara, song(), 'append');
  const sel = s.select(); s.commit(sel); s.songEnded(sel.ids);
  assert.equal(sel.ids[0], first.ids[0]);
  assert.equal(sel.borrowedIds, undefined, 'l’ordre du bar ne crée pas de dette, même rattrapé par une arrivée');
});

// Soirée du 15 octobre : une autrice attend 72 min son duo. Son invitée avait
// chanté en avance au tour précédent (passage emprunté par la règle
// anti-série) ; le tour suivant la comptait comme déjà passée, et le duo de
// l'autrice, qui ne devait rien, passait derrière tout le monde. La dette ne
// vaut que pour le ticket de l'invitée : invitée d'un duo, elle ne compte dans
// le tour qu'une fois montée sur scène.
function guestDebtEvening({ debt, guestSolo }) {
  let n = 1;
  const song = () => ({ songId: n++, title: `Titre ${n}`, artist: 'Essai' });
  const s = new Scheduler();
  s._maybeRequestSolver = () => {};
  const join = (tableId, name) => s.join({ tableId, name, headcount: 4 });
  const ana = join('T4', 'Ana'), bea = join('T4', 'Bea');
  const others = [['T1', 'Chris'], ['T2', 'Dina'], ['T3', 'Eli'], ['T5', 'Fred'], ['T6', 'Gus']]
    .map(([tableId, name]) => join(tableId, name));
  for (const p of [ana, bea, ...others]) s.chooseSong(p, song(), 'append');
  const send = () => { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); return sel; };
  for (let i = 0; i < 7; i++) send();
  // Liste suivante d'Ana : le duo avec Bea en tête, puis un solo.
  s.inviteDuet(ana, bea.id, song());
  s.chooseSong(ana, song(), 'append');
  if (guestSolo) s.chooseSong(bea, song(), 'append');
  for (const p of others) s.chooseSong(p, song(), 'append');
  // Second passage de Bea pris sur le tour suivant (dette, voir _useRound).
  if (debt) s.roundUse.set(bea.id, 2);
  const played = [];
  for (let i = 0; i < 9; i++) {
    const sel = s.select();
    if (!sel) break;
    s.commit(sel); s.songEnded(sel.ids);
    played.push(sel);
  }
  const names = played.map(sel => sel.names.join(' & '));
  return { names, duo: names.indexOf('Ana & Bea') };
}

test('dette de l’invitée d’un duo : le duo de l’autrice garde sa place dans le tour', () => {
  const free = guestDebtEvening({ debt: false, guestSolo: false });
  const owed = guestDebtEvening({ debt: true, guestSolo: false });
  assert.ok(free.duo >= 0 && owed.duo >= 0, `${free.names.join(' ')} / ${owed.names.join(' ')}`);
  assert.equal(owed.duo, free.duo,
    `sans dette : ${free.names.join(', ')} ; avec dette : ${owed.names.join(', ')}`);
});

test('dette de l’invitée d’un duo : son propre titre reste après le tour', () => {
  const { names, duo } = guestDebtEvening({ debt: true, guestSolo: true });
  const solo = names.indexOf('Bea');
  assert.ok(duo >= 0 && solo > duo, names.join(', '));
  // Le duo d'Ana garde sa place : il ne passe pas après tous les autres titres.
  const others = ['Chris', 'Dina', 'Eli', 'Fred', 'Gus'];
  assert.ok(names.slice(duo + 1).some(name => others.includes(name)), names.join(', '));
  // Tous les autres titres du tour passent avant le titre de Bea.
  for (const name of ['Chris', 'Dina', 'Eli', 'Fred', 'Gus']) {
    assert.ok(names.indexOf(name) < solo, `${name} avant Bea : ${names.join(', ')}`);
  }
});

// Relecture du correctif : la dette de l'invitée n'est levée que pour un
// auteur encore neuf dans le tour. Un auteur déjà compté (passage ou dette)
// ne doit pas obtenir un passage gratuit, ni perdre sa dette, grâce à elle.
// X : auteur ; G : son invitée, dans le tour par sa seule dette ; Y & Z
// présente Z, vraiment neuve dans le tour.
function ownerCountedEvening({ ownerDebt, yJustSang }) {
  let n = 1;
  const song = () => ({ songId: n++, title: `Titre ${n}`, artist: 'Essai' });
  const s = new Scheduler();
  s._maybeRequestSolver = () => {};
  const join = (tableId, name) => s.join({ tableId, name, headcount: 2 });
  const X = join('TX', 'X'), G = join('TG', 'G'), Y = join('TY', 'Y'), Z = join('TZ', 'Z'), W = join('TW', 'W');
  for (const p of [X, G, Y, Z, W]) s.chooseSong(p, song(), 'append');
  for (let i = 0; i < 5; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
  s.inviteDuet(X, G.id, song()); s.answerDuet(G, true);
  s.inviteDuet(Y, Z.id, song()); s.answerDuet(Z, true);
  s.roundPeople = new Set([X.id, G.id, Y.id, W.id]);
  s.roundApps = new Map(ownerDebt ? [[Y.id, 1], [W.id, 1]] : [[X.id, 1], [Y.id, 1], [W.id, 1]]);
  s.roundUse = new Map(ownerDebt ? [[X.id, 1], [G.id, 1]] : [[G.id, 1]]);
  s.roundOwed = new Set();
  s.appearanceSerial = 40;
  for (const p of [X, G, Y, Z]) p.lastAppearanceTurn = 10;
  W.lastAppearanceTurn = 40;
  if (yJustSang) Y.lastAppearanceTurn = 39; // Y & Z pas encore espacé (repli de l'espacement)
  s.lastGroup = W.group;
  s.recentGroups = [];
  return s;
}

test('dette de l’invitée, auteur déjà compté dans le tour : le duo qui présente une nouvelle passe d’abord', () => {
  for (const ownerDebt of [false, true]) for (const yJustSang of [false, true]) {
    const sel = ownerCountedEvening({ ownerDebt, yJustSang }).select();
    assert.equal(sel.names.join(' & '), 'Y & Z', JSON.stringify({ ownerDebt, yJustSang }));
  }
});

test('dette de l’invitée, auteur déjà monté dans le tour : son duo reste un emprunt', () => {
  let n = 1;
  const song = () => ({ songId: n++, title: `Titre ${n}`, artist: 'Essai' });
  const s = new Scheduler();
  s._maybeRequestSolver = () => {};
  const join = (tableId, name) => s.join({ tableId, name, headcount: 4 });
  const P = {};
  for (const [tableId, name] of [['T1', 'X'], ['T2', 'G'], ['T3', 'Y'], ['T5', 'A'], ['T6', 'B']]) P[name] = join(tableId, name);
  const send = () => { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); return sel; };
  for (const name of ['X', 'G', 'Y', 'A', 'B']) s.chooseSong(P[name], song(), 'append');
  for (let i = 0; i < 5; i++) send();
  // Dette réelle de G : annoncée en fin de tour, puis rattrapée par une arrivée.
  P.N = join('T7', 'N');
  s.chooseSong(P.G, song(), 'append');
  s.reserveNext();
  s.chooseSong(P.N, song(), 'append');
  assert.deepEqual(send().borrowedIds, [P.G.id], 'G chante en avance');
  send();
  assert.equal(s.roundUse.get(P.G.id), 2);
  P.Z = join('T8', 'Z');
  s.chooseSong(P.X, song(), 'append');
  // Duos entre tables : acceptés par l'invité.
  const duet = (owner, guest) => {
    const d = s.inviteDuet(owner, guest.id, song());
    if (d.duet.state !== 'accepted') s.answerDuet(guest, true, d.entryId);
  };
  duet(P.X, P.G);
  // G n'a pas d'autre titre : le sien, qui attend depuis plus longtemps que
  // X, passerait sinon en avance à la place du duo (à patience égale, la plus
  // ancienne attente d'abord).
  for (const name of ['Y', 'A', 'B', 'N']) s.chooseSong(P[name], song(), 'append');
  duet(P.N, P.Z);
  for (const name of ['X', 'Y', 'A', 'B', 'N']) s.chooseSong(P[name], song(), 'append');
  const played = [];
  for (let i = 0; i < 18; i++) { const sel = s.select(); if (!sel) break; s.commit(sel); s.songEnded(sel.ids); played.push(sel); }
  const duo = played.find(sel => sel.ids.join() === [P.X.id, P.G.id].join());
  assert.ok(duo, played.map(sel => sel.names.join('&')).join(' '));
  assert.equal(duo.newPersonRound, false, 'X a déjà chanté dans ce tour');
  assert.deepEqual(duo.borrowedIds, [P.X.id], 'second passage de X dans le tour : emprunté');
  // Au tour suivant, X laisse passer les autres (sa dette tient).
  const next = played.slice(played.indexOf(duo) + 1);
  const start = next.findIndex(sel => sel.newPersonRound);
  const round = next.slice(start, start + 4).map(sel => sel.names[0]);
  assert.ok(start >= 0 && !round.includes('X'), played.map(sel => sel.names.join('&')).join(' '));
});
