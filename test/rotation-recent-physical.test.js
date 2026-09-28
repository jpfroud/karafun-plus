'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');

// Capture du 28/09 : Johnny est seul au troisième titre, puis réapparaît
// déjà au cinquième en duo avec Osark. Yannick et Kenny attendent encore leur
// première apparition physique ; leurs duos ont des partenaires passés au #1.
function screenshotFixture(options) {
  const s = new Scheduler(options);
  const people = {};
  for (const [tableId, count, names] of [
    ['JP', 2, ['Marine', 'JP']],
    ['Leila', 4, ['Leila', 'Dam', 'Yannick', 'Kenny']],
    ['Sebastiano', 1, ['Sebastiano']],
    ['Comptoir', 40, ['Osark', 'Johnny']],
  ]) for (const name of names) {
    people[name] = s.join({ tableId, name, headcount: count });
  }
  let songId = 1;
  const song = () => ({ songId: songId++, title: `Titre ${songId}`, artist: 'Simulation' });
  const duo = (ownerName, guestName) => {
    const owner = people[ownerName], guest = people[guestName];
    const item = s.inviteDuet(owner, guest.id, song());
    if (item.duet.state === 'pending') s.answerDuet(guest, true, item.entryId);
  };
  duo('Marine', 'JP');
  duo('Leila', 'Dam');
  s.chooseSong(people.Johnny, song());
  s.chooseSong(people.Sebastiano, song());
  duo('Osark', 'Johnny');
  duo('Yannick', 'Marine');
  duo('Kenny', 'JP');
  duo('Dam', 'Yannick');
  duo('JP', 'Marine');
  s.Q = ['Marine', 'Leila', 'Johnny', 'Sebastiano', 'Osark',
    'Yannick', 'Kenny', 'Dam', 'JP'].map(name => people[name].id);
  return { s, people };
}

for (const options of [
  { tableRotation: false },
  { tableRotation: true, weightedTables: false },
  { tableRotation: true, weightedTables: true },
]) {
  const mode = options.tableRotation ? options.weightedTables ? 'tables pondérées' : 'tables' : 'personnes';
  test(`capture #5 : Johnny attend après son solo, Yannick passe d'abord (${mode})`, () => {
    const { s, people } = screenshotFixture(options);
    const factualPast = ['Marine', 'Leila', 'Johnny', 'Sebastiano'];
    for (const ownerName of factualPast) {
      // Les quatre premiers titres sont déjà joués dans la capture. Leur
      // historique est un fait, quelle que soit la stratégie future.
      s.reservedNext = { personId: people[ownerName].id, reservedAt: Date.now() };
      const selected = s.select();
      assert.equal(selected.ids[0], people[ownerName].id);
      s.commit(selected);
      s.songEnded(selected.ids);
    }
    const first = s.readyView()[0];
    assert.equal(first.ids[0], people.Yannick.id,
      `${mode} : Johnny vient de chanter au #3 ; Marine a chanté au #1, donc Yannick & Marine doivent précéder Osark & Johnny`);
    assert.equal(s.select().song.entryId, first.entryId, 'l’envoi suit la prévision');
    const osark = s.readyView().findIndex(item => item.ids[0] === people.Osark.id);
    assert.ok(osark > 0, 'Osark garde son titre et passe après un duo moins rapproché');
  });
}
