'use strict';
// À patience égale, la plus ancienne attente d'abord ; début d'attente au
// passage sur scène (soirées des 23 et 24 octobre, analyse contre-vérifiée).
// - Le 23 à 00:11:48, Remi (demande de 23:23) passait devant Gaspard (demande
//   de 23:13, 107 min d'attente en tout) : Gaspard avait demandé pendant
//   l'envoi du passage d'Remi (envoyé à 23:12:12, chanté à 23:15:05), ce
//   passage comptait d'avant sa demande et la patience ne le protégeait plus ;
//   puis la règle des tables départageait.
// - Le 24, Kilian redemandait un titre à 00:37 et chantait à 00:47 devant
//   onze personnes qui attendaient depuis 16 à 88 min : la part de sa table
//   passait avant l'ancienneté des attentes.
// « Il faut toujours mesurer le délai à partir duquel quelqu'un demande une
// chanson » (le gérant). En « Chacun son tour », à patience égale, la plus
// ancienne attente de l'auteur d'abord (max(dernier passage, demande après une
// liste vide), à l'heure près) ; la part et la règle des tables ne départagent
// qu'ensuite. Dans les modes de tables, la part d'abord, puis la même règle.
// Une demande faite pendant qu'un passage est envoyé mais pas encore commencé
// prend le début d'attente d'avant ce passage. À compteur égal, à l'heure,
// comme dans les statistiques : l'attente d'un chanteur commence à la fin de
// sa chanson, une demande faite pendant elle passe avant son titre suivant
// (le 24 à 01:55, le dernier titre de la soirée allait au deuxième d'un
// arrivant de 01:25 plutôt qu'à une demande faite pendant son premier).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');

const settings = () => ({ auto: true, autoPlay: false, baseUrl: 'https://chant.example.test',
  pushDelaySec: 45, playDelaySec: 8 });
// Horloge du test, et une scène comme celle du bar : chaque passage est
// envoyé 45 s après le début du titre en cours et commence quand celui-ci
// finit, trois minutes plus tard (fin notée comme par le serveur :
// songEnded puis endStage). `onSent(sel)` : geste pendant l'envoi.
function evening(options = {}) {
  const realNow = Date.now;
  let clock = Date.UTC(2026, 9, 23, 21, 0, 0);
  Date.now = () => clock;
  const tick = (sec = 5) => { clock += sec * 1000; };
  let n = 1;
  const song = () => ({ songId: n, title: `Titre ${n++}`, artist: 'Essai' });
  const s = new Scheduler(options);
  const passages = [];
  let onStage = null;
  const step = onSent => {
    tick(45);
    const sel = s.select();
    if (!sel) return null;
    s.commit(sel);
    onSent?.(sel);
    tick(180);
    if (onStage) { s.songEnded(onStage.ids); s.endStage(onStage); }
    s.recordStage(sel);
    onStage = sel;
    passages.push(sel.names.join(' & '));
    return sel;
  };
  const add = (p, mode = 'append') => { tick(); s.chooseSong(p, song(), mode); };
  const view = () => s.readyView().map(item => item.name);
  // Fin du titre sur scène sans début du suivant (pause du bar).
  const endSong = () => {
    if (!onStage) return;
    s.songEnded(onStage.ids); s.endStage(onStage);
    onStage = null;
  };
  return { s, tick, song, add, step, endSong, passages, view, done: () => { Date.now = realNow; } };
}

// Cas du 24 octobre à 01:55 : Yves, arrivé avec deux titres, chante le
// premier (dernier passage) ; Tess, liste vide depuis le sien, redemande
// pendant cette chanson (`pendant`), ou après sa fin, pendant une pause du
// bar (`après`) ; O, qui attend depuis plus longtemps, passe d'abord.
function yvesEvening(moment, options = {}) {
  const e = evening(options);
  const { s, tick, add, step, endSong } = e;
  const [o, tess, yves] = ['O', 'Tess', 'Yves'].map(name => s.join({ tableId: `T-${name}`, name, headcount: 1 }));
  add(o); add(o); add(tess); add(yves); add(yves);
  for (let k = 0; k < 3; k++) step();
  assert.deepEqual(e.passages, ['O', 'Tess', 'Yves']);
  let endedAt;
  if (moment === 'pendant') { tick(60); add(tess); tick(60); endSong(); endedAt = Date.now(); }
  else { tick(120); endSong(); endedAt = Date.now(); tick(60); add(tess); }
  return { ...e, o, tess, yves, endedAt };
}

// Graine de la recherche faite pour cette correction : table T de trois
// personnes, Remi seul à la sienne. Au deuxième tour, Gaspard (T) chante son
// dernier titre, puis redemande pendant l'envoi du passage d'Remi ; Remi
// redemande à son tour, deux passages après le sien.
function gaspardEvening(options = {}) {
  const e = evening(options);
  const { s, add, step } = e;
  s.setHeadcount('T', 3);
  const gaspard = s.join({ tableId: 'T', name: 'Gaspard' });
  const remi = s.join({ tableId: 'I', name: 'Remi', headcount: 1 });
  const [t1, t2] = ['T1', 'T2'].map(name => s.join({ tableId: 'T', name }));
  for (const [p, count] of [[gaspard, 2], [remi, 2], [t1, 3], [t2, 3]]) for (let k = 0; k < count; k++) add(p);
  for (let k = 0; k < 5; k++) step();
  let during = null;
  step(sel => {
    assert.deepEqual(sel.names, ['Remi']);
    add(gaspard);
    during = { readySerial: gaspard.readySerial, turn: s.appearanceSerial };
  });
  step(); step();
  add(remi);
  return { ...e, gaspard, remi, during };
}

test('cas Gaspard : une demande faite pendant l’envoi d’un passage compte d’avant lui', () => {
  const e = gaspardEvening();
  try {
    const { s, gaspard, remi, during, passages, view } = e;
    assert.deepEqual(passages, ['Gaspard', 'Remi', 'T1', 'T2', 'Gaspard', 'Remi', 'T1', 'T2']);
    assert.equal(during.readySerial, during.turn - 1, 'début d’attente d’avant le passage d’Remi, encore à venir sur scène');
    assert.ok(gaspard.readySince < remi.readySince);
    const order = view();
    assert.ok(order.indexOf('Gaspard') < order.indexOf('Remi'), `Gaspard a demandé avant Remi : ${order.join(' ')}`);
    assert.equal(order[0], 'Gaspard', 'personne ne lui passe devant');
    for (let k = 0; k < 4; k++) e.step();
    assert.deepEqual(passages.slice(8), order, 'les passages suivent l’ordre annoncé');
    assert.ok(!s.unstartedTurn || s.unstartedTurn > during.turn);
  } finally { e.done(); }
});

test('cas Gaspard, sans la mesure à la scène : la plus ancienne attente passe quand même d’abord', () => {
  const e = gaspardEvening();
  try {
    const { gaspard, view } = e;
    // Comme avant la correction : la demande compte après le passage d'Remi.
    gaspard.readySerial += 1;
    const order = view();
    assert.ok(order.indexOf('Gaspard') < order.indexOf('Remi'), `la règle des tables ne départage qu’ensuite : ${order.join(' ')}`);
  } finally { e.done(); }
});

test('cas Kilian : un retour qui redemande un titre tard prend sa place selon sa demande', () => {
  const e = evening();
  try {
    const { s, tick, add, step, passages, view } = e;
    s.setHeadcount('K', 5);
    const [kilian, k2, k3, k4] = ['Kilian', 'K2', 'K3', 'K4'].map(name => s.join({ tableId: 'K', name }));
    const others = ['O1', 'O2', 'O3'].map((name, k) => s.join({ tableId: `O${k}`, name, headcount: 1 }));
    for (const p of [kilian, ...others, k2, k3, k4]) add(p);
    for (const p of [...others, k2, k3, k4]) add(p);
    for (let k = 0; k < 8; k++) step();
    assert.deepEqual(passages, ['Kilian', 'O1', 'O2', 'O3', 'K2', 'K3', 'K4', 'O1']);
    // Kilian, liste vide depuis son passage, redemande dix minutes plus tard :
    // les autres attendent depuis leur dernier passage, avant sa demande.
    tick(600);
    add(kilian);
    const order = view();
    assert.deepEqual(order, ['O2', 'O3', 'K2', 'K3', 'K4', 'Kilian'], `sa table ne passe plus devant : ${order.join(' ')}`);
    for (let k = 0; k < 6; k++) step();
    assert.deepEqual(passages.slice(8), order);
  } finally { e.done(); }
});

test('à compteur égal, à l’heure : une demande faite pendant une chanson passe avant le titre suivant de son chanteur', () => {
  for (const [moment, expected] of [['pendant', ['O', 'Tess', 'Yves']], ['après', ['O', 'Yves', 'Tess']]]) {
    const e = yvesEvening(moment);
    try {
      const { s, tess, yves, view, endedAt } = e;
      assert.equal(tess.readySerial, yves.lastAppearanceTurn, `${moment} : même compteur`);
      assert.equal(s._stageEnd(yves.lastAppearanceTurn), endedAt);
      assert.equal(tess.readySince < endedAt, moment === 'pendant');
      assert.deepEqual(view(), expected, `${moment} : ${view().join(' ')}`);
      // Reprise après un redémarrage : la fin du passage est sauvegardée ;
      // une sauvegarde d'avant ce champ la reprend de l'historique de scène.
      const access = new TableAccess();
      for (const id of s.tables.keys()) access.issue(id);
      const saved = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings: settings() })));
      assert.ok(saved.scheduler.stageEnds.some(([turn]) => turn === yves.lastAppearanceTurn));
      const legacy = JSON.parse(JSON.stringify(saved));
      delete legacy.scheduler.stageEnds;
      for (const data of [saved, legacy]) {
        const back = new Scheduler();
        restoreNight(JSON.parse(JSON.stringify(data)), { scheduler: back, access: new TableAccess(), settings: settings() });
        assert.equal(back._stageEnd(yves.lastAppearanceTurn), s._stageEnd(yves.lastAppearanceTurn));
        assert.deepEqual(back.readyView().map(item => item.name), expected, `${moment}, reprise`);
      }
      // Le bar vide l'historique de scène : l'ordre ne change pas.
      s.clearStageHistory([]);
      assert.deepEqual(view(), expected, `${moment}, historique vidé`);
      e.step(); e.step(); e.step();
      assert.deepEqual(e.passages.slice(3), expected, `${moment} : les passages suivent l’ordre annoncé`);
    } finally { e.done(); }
  }
});

test('à compteur égal : chanson pas encore finie, toute demande déjà faite passe avant son chanteur', () => {
  const e = evening();
  try {
    const { s, tick, add, step, view } = e;
    const [o, tess, yves] = ['O', 'Tess', 'Yves'].map(name => s.join({ tableId: `T-${name}`, name, headcount: 1 }));
    add(o); add(o); add(tess); add(yves); add(yves);
    for (let k = 0; k < 3; k++) step();
    tick(60);
    add(tess); // Yves est encore sur scène
    assert.equal(s._stageEnd(yves.lastAppearanceTurn), Infinity);
    assert.deepEqual(view(), ['O', 'Tess', 'Yves']);
    // Un passage plus ancien, sans fin connue (titre jamais fini dans
    // l'application) : de même, après les demandes faites à son compteur.
    assert.equal(s._stageEnd(0), Infinity);
  } finally { e.done(); }
});

test('demande pendant un envoi : le début d’attente suit la scène, envoi annulé et reprise compris', () => {
  const e = evening();
  try {
    const { s, add } = e;
    const [x, y, z, w] = ['X', 'Y', 'Z', 'W'].map((name, k) => s.join({ tableId: `T${k}`, name, headcount: 1 }));
    for (const p of [x, y, z]) add(p);
    const first = s.select(); s.commit(first); s.recordStage(first);
    assert.equal(s.appearanceSerial, 1);
    const sent = s.select(); s.commit(sent);
    assert.deepEqual(sent.names, ['Y']);
    // X redemande pendant l'envoi de Y : le passage de Y vient après sa demande.
    add(x);
    assert.equal(x.readySerial, 1);
    // Redémarrage pendant cet envoi : la reprise le sait encore.
    const access = new TableAccess();
    for (const id of s.tables.keys()) access.issue(id);
    const saved = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings: settings() })));
    assert.equal(saved.scheduler.unstartedTurn, 2);
    const back = new Scheduler();
    restoreNight(JSON.parse(JSON.stringify(saved)), { scheduler: back, access: new TableAccess(), settings: settings() });
    const zBack = back.people.get(z.id);
    back.removeSong(zBack, back.songsOf(zBack)[0].entryId);
    back.commit(back.select()); // passage suivant : le titre de Y avait commencé
    back.chooseSong(zBack, { songId: 99, title: 'Titre 99', artist: 'Essai' });
    assert.equal(zBack.readySerial, 2, 'nouvel envoi : le précédent a commencé');
    // Sauvegarde d'avant ce champ : aucun passage attendu sur scène.
    const legacy = JSON.parse(JSON.stringify(saved));
    delete legacy.scheduler.unstartedTurn;
    const old = new Scheduler();
    restoreNight(legacy, { scheduler: old, access: new TableAccess(), settings: settings() });
    assert.equal(old.unstartedTurn, 0);
    // Y commence : une demande compte désormais d'après lui.
    s.songEnded(first.ids);
    assert.equal(s.unstartedTurn, 2, 'la fin du titre d’avant ne fait pas commencer Y');
    s.recordStage(sent);
    assert.equal(s.unstartedTurn, 0);
    const third = s.select(); s.commit(third);
    assert.deepEqual(third.names, ['Z']);
    // Passage annulé pendant son envoi : il n'est plus attendu sur scène.
    s.rollbackUnplayed(third, { requeue: true });
    assert.equal(s.unstartedTurn, 0);
    add(w);
    assert.equal(w.readySerial, 2, 'après le passage de Y, déjà sur scène');
    // Un essai sans scène notée : la fin du titre envoyé vaut son début.
    const again = s.select(); s.commit(again);
    s.songEnded(again.ids);
    assert.equal(s.unstartedTurn, 0);
  } finally { e.done(); }
});

test('duo : l’attente qui compte est celle de son auteur', () => {
  const e = evening();
  try {
    const { s, tick, add, step, passages, view } = e;
    const owner = s.join({ tableId: 'D', name: 'Auteur', headcount: 2 });
    const guest = s.join({ tableId: 'G', name: 'Invitée', headcount: 1 });
    const [a, b] = ['A', 'B'].map((name, k) => s.join({ tableId: `O${k}`, name, headcount: 1 }));
    for (const p of [owner, guest, a, b]) add(p);
    for (const p of [a, b]) add(p);
    for (let k = 0; k < 4; k++) step();
    assert.deepEqual(passages, ['Auteur', 'Invitée', 'A', 'B']);
    // L'auteur, liste vide depuis son passage, invite plus tard l'invitée :
    // son duo attend depuis sa demande, après A, qui attend depuis son passage
    // (avant, la table de l'auteur, ouverte la première, passait devant) ; B,
    // qui vient de chanter, attend ensuite ses trois chansons.
    tick(300);
    const duo = s.inviteDuet(owner, guest.id, e.song());
    s.answerDuet(guest, true, duo.entryId);
    const order = view();
    assert.deepEqual(order, ['A', 'Auteur & Invitée', 'B'], order.join(' '));
    for (let k = 0; k < 3; k++) step();
    assert.deepEqual(passages.slice(4), order);
  } finally { e.done(); }
});

test('tables à tour de rôle : à part égale, la plus ancienne attente d’abord', () => {
  for (const options of [{ tableRotation: true }, { tableRotation: true, weightedTables: true }]) {
    const e = evening(options);
    try {
      const { s, add, step, passages, view } = e;
      const people = ['A', 'B', 'C', 'D', 'E'].map((name, k) => s.join({ tableId: `T${k}`, name, headcount: 1 }));
      const [a, b] = people;
      for (const p of people) add(p);
      for (const p of people.slice(2)) add(p);
      for (let k = 0; k < 5; k++) step();
      assert.deepEqual(passages, ['A', 'B', 'C', 'D', 'E']);
      // A et B redemandent, B d'abord : chaque table a eu sa part, B passe
      // avant A (avant, la table de A, ouverte la première, passait devant).
      add(b);
      add(a);
      const order = view();
      assert.ok(order.indexOf('B') < order.indexOf('A'), `${JSON.stringify(options)} : ${order.join(' ')}`);
    } finally { e.done(); }
  }
});

test('malus : pas protégé par l’ancienneté non plus ; bonus reposé : peut passer avant', () => {
  const e = evening();
  try {
    const { s, add, step, passages, view } = e;
    const names = ['A', 'B', 'C', 'D', 'E', 'F'];
    const people = names.map((name, k) => s.join({ tableId: `T${k}`, name, headcount: 1 }));
    const a = people[0];
    for (const p of people) { add(p); add(p); add(p); }
    for (let k = 0; k < 6; k++) step();
    assert.deepEqual(passages, names);
    assert.deepEqual(view().slice(0, 6), names, 'chacun dans l’ordre de son attente');
    s.setPersonBonus(a.id, -1);
    assert.deepEqual(view().slice(0, 6), ['B', 'C', 'D', 'E', 'F', 'A'], 'malus : les autres passent d’abord');
    // Bonus : son deuxième passage du tour, une fois reposé et espacé, peut
    // passer avant ceux qui attendent depuis plus longtemps (il chante plus
    // souvent), sans enchaîner deux de ses titres.
    s.setPersonBonus(a.id, 1);
    const round = view().slice(0, 7);
    assert.equal(round.filter(name => name === 'A').length, 2, round.join(' '));
    assert.equal(round[0], 'A');
    assert.ok(round.indexOf('A', 1) < 6, `deuxième passage avant la fin du tour : ${round.join(' ')}`);
  } finally { e.done(); }
});
