'use strict';
const assert = require('node:assert/strict');
const { Scheduler } = require('../scheduler');

function setup(weightedTables) {
  const s = new Scheduler({ tableRotation: true, weightedTables });
  let songId = 100;
  for (const [tableId, count] of [['1', 1], ['2', 10], ['3', 3]]) {
    s.setHeadcount(tableId, count);
    for (let i = 0; i < count; i++) {
      const p = s.join({ tableId, name: `${tableId}-${i}` });
      for (let j = 0; j < 8; j++) s.chooseSong(p, { songId: ++songId, title: `Titre ${songId}` }, 'append');
    }
  }
  return s;
}

function passages(s, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const selected = s.select();
    assert.ok(selected, `passage ${i + 1}`);
    out.push(s.people.get(selected.ids[0]).tableId);
    s.commit(selected);
    s.songEnded(selected.ids);
  }
  return out;
}

const strict = setup(false);
const strictFirstTurns = passages(strict, 14);
assert.equal(strictFirstTurns[0], '1');
assert.deepEqual(strictFirstTurns.slice(1, 7), ['2', '3', '2', '3', '2', '3'],
  'les tables encore inédites alternent tant que possible');
assert.equal(strictFirstTurns.filter(x => x === '1').length, 1,
  'la table de 1 ne revient pas avant les 13 premiers passages des autres tables');
assert.equal(strictFirstTurns.filter(x => x === '2').length, 10);
assert.equal(strictFirstTurns.filter(x => x === '3').length, 3);
const short = new Scheduler({ tableRotation: true });
for (const [tableId, names] of [['1', ['JP', 'Marine']], ['2', ['T2']], ['3', ['T3']]]) {
  short.setHeadcount(tableId, names.length);
  for (const name of names) {
    const p = short.join({ tableId, name });
    short.chooseSong(p, { songId: 200 + short.people.size, title: name });
  }
}
assert.deepEqual(passages(short, 4), ['1', '2', '3', '1'],
  'une table sans autre chanson reste le point de départ du cercle');
const weighted = setup(true);
const weightedFirstTurns = passages(weighted, 14);
assert.equal(weightedFirstTurns.filter(x => x === '1').length, 1);
assert.equal(weightedFirstTurns.filter(x => x === '2').length, 10);
assert.equal(weightedFirstTurns.filter(x => x === '3').length, 3);
const live = setup(false);
assert.deepEqual(live.readyView().slice(0, 3).map(v => v.tableId), ['1', '2', '3']);
live.opts.weightedTables = true;
live.tableServeCounts.clear();
// La vue donne également une place prévisionnelle aux chansons suivantes.
assert.deepEqual(live.readyView().slice(0, 7).map(v => v.tableId),
  weightedFirstTurns.slice(0, 7));

// Régression observée au bar : les titres suivants d'un chanteur doivent
// revenir dans le cercle, sans pour autant être envoyés avant son premier.
const night = new Scheduler({ tableRotation: true });
let songId = 1000;
for (const [tableId, names] of [
  ['1', ['JP', 'Marine']], ['2', ['Kenny', 'Yannick', 'Dam', 'Leila', 'Clem']],
  ['3', ['Sébastianno']],
]) {
  night.setHeadcount(tableId, names.length);
  for (const name of names) {
    const p = night.join({ tableId, name });
    night.chooseSong(p, { songId: ++songId, title: `Titre ${songId}` }, 'append');
    if (name === 'Sébastianno') night.chooseSong(p, { songId: ++songId, title: `Titre ${songId}` }, 'append');
  }
}
const byName = new Map([...night.people.values()].map(p => [p.name, p]));
night.Q = ['JP', 'Kenny', 'Sébastianno', 'Marine', 'Yannick', 'Dam', 'Leila', 'Clem']
  .map(name => byName.get(name).id);
const nightOrder = night.readyView();
assert.deepEqual(nightOrder.slice(0, 8).map(v => v.name),
  ['JP', 'Kenny', 'Sébastianno', 'Marine', 'Yannick', 'Dam', 'Leila', 'Clem']);
assert.notEqual(nightOrder[2].entryId, nightOrder[8].entryId);
assert.equal(nightOrder[2].future, false);
assert.equal(nightOrder[8].future, true);
assert.deepEqual(night.predict().filter(v => v.song).slice(0, 8).map(v => night.people.get(v.ids[0]).name),
  nightOrder.slice(0, 8).map(v => v.name));
assert.equal(night.select().song.entryId, nightOrder[0].entryId, 'seul le titre courant est envoyable');

const first = night.select(); night.commit(first);
const afterSent = night.readyView();
assert.equal(afterSent[0].name, 'Kenny', 'le titre déjà envoyé à KaraFun reste acquis');
assert.equal(afterSent.filter(v => v.name === 'Sébastianno').length, 2);

const pending = night.select();
const provisional = night.readyView(pending.consumedIds, pending);
assert.equal(provisional[0].name, 'Sébastianno');
assert.equal(provisional.filter(v => v.name === 'Sébastianno').length, 2);

// Changer de mode recalcule la prévision sans modifier un envoi déjà validé.
night.opts.weightedTables = true;
const weightedView = night.readyView();
assert.equal(weightedView[0].name, 'Kenny');
night.opts.tableRotation = false;
const peopleView = night.readyView();
assert.equal(peopleView.length, 8);
assert.ok(!peopleView.some(v => v.entryId === first.song.entryId));
console.log('Modes de rotation des tables OK');
