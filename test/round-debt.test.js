'use strict';
// Soirée du 10 octobre : une chanteuse de table attend 65 min. Pendant ce
// temps, un soliste (« En solo ») repasse une seconde fois dans le même tour
// grâce à la règle anti-série, puis repasse encore devant elle au tour suivant. Un
// passage pris en avance sur le tour doit être décompté du tour suivant.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');

function evening() {
  let n = 1;
  const song = () => ({ songId: n++, title: `Titre ${n}`, artist: 'Essai' });
  const s = new Scheduler();
  s._maybeRequestSolver = () => {};
  s.setHeadcount('T1', 12);
  const people = ['Solo1', 'Attente', 'Amie', 'Solo2'].map(name =>
    s.join({ tableId: ['Solo1', 'Solo2'].includes(name) ? 'Comptoir' : 'T1', name }));
  for (const p of people) for (let k = 0; k < 6; k++) s.chooseSong(p, song(), 'append');
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
  const { s, song, send, played, byName } = evening();
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
  const after = send();
  assert.equal(after.ids[0], sara.id, 'Sara chante ensuite');
  assert.equal(s.roundUse.get(announced.ids[0]), 2, 'dette inchangée par le passage de Sara');
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
