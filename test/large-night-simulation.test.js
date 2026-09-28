'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');

// Trois vagues de tables comme au bar, plus douze personnes seules au comptoir :
// 3 × (5 + 4 + 1 + 2 + 3 + 1) + 12 = 60 clients distincts dans une soirée.
const tables = [
  { places: 8, singers: 5 }, { places: 4, singers: 4 },
  { places: 2, singers: 1 }, { places: 4, singers: 2 },
  { places: 3, singers: 3 }, { places: 2, singers: 1 },
];
const modes = [
  { name: 'personnes', opts: { tableRotation: false } },
  { name: 'tables', opts: { tableRotation: true } },
  { name: 'tables selon leur taille', opts: { tableRotation: true, weightedTables: true } },
];

function simulate(mode, seed) {
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const s = new Scheduler({ ...mode.opts, cap: 2 });
  const live = new Set(), seen = new Set();
  const people = [];
  let nextSong = seed * 100000 + 1;
  const context = `${mode.name}, graine ${seed}`;
  const add = (p, kind = 'append') => {
    const n = nextSong++;
    if (kind === 'replace') s.songsOf(p).forEach(t => live.delete(t.entryId));
    s.chooseSong(p, { songId: n, title: `Titre ${n}`, artist: 'Simulation de soirée' }, kind);
    live.add(s.songsOf(p).at(-1).entryId);
  };
  const removeActive = p => s.songsOf(p).forEach(t => live.delete(t.entryId));
  const check = label => {
    const waiting = [...s.people.values()].flatMap(p => s.songsOf(p).map(t => t.entryId));
    assert.equal(new Set(waiting).size, waiting.length, `${context} ${label} : identifiants de chansons uniques`);
    assert.deepEqual(new Set(waiting), live, `${context} ${label} : aucune chanson perdue ni réapparue`);
    const forecast = s.readyView();
    assert.deepEqual(new Set(forecast.map(t => t.entryId)), live,
      `${context} ${label} : la file publique couvre tous les titres prêts`);
    assert.equal(forecast.length, live.size, `${context} ${label} : aucun doublon dans la file`);
    assert.equal(new Set(s.Q).size, s.Q.length, `${context} ${label} : aucun ticket dupliqué`);
    assert.ok(s.Q.every(pid => s.people.has(pid)), `${context} ${label} : aucun ticket orphelin`);
    if (live.size) assert.equal(s.select()?.song.entryId, forecast[0]?.entryId,
      `${context} ${label} : la chanson réellement envoyable est la première annoncée`);
  };
  const play = label => {
    if (!live.size) return false;
    const before = s.readyView();
    const sel = s.select();
    assert.ok(sel, `${context} ${label} : la file ne doit pas se bloquer`);
    assert.equal(sel.song.entryId, before[0].entryId,
      `${context} ${label} : l'envoi suit la prévision`);
    assert.ok(live.delete(sel.song.entryId), `${context} ${label} : titre déjà annulé ou joué`);
    assert.ok(!seen.has(sel.song.entryId), `${context} ${label} : pas de double passage`);
    seen.add(sel.song.entryId);
    s.commit(sel);
    s.songEnded(sel.ids);
    return true;
  };

  for (let wave = 0; wave < 3; wave++) {
    for (let t = 0; t < tables.length; t++) {
      const tableId = `V${wave + 1}-${t + 1}`;
      s.setHeadcount(tableId, tables[t].places);
      for (let i = 0; i < tables[t].singers; i++) {
        const p = s.join({ tableId, name: `Personne ${wave + 1}-${t + 1}-${i + 1}` });
        people.push(p);
        add(p);
        if (random() > .42) add(p);
      }
    }
    for (let i = 0; i < 4; i++) {
      const p = s.join({ tableId: 'Comptoir', name: `Solo ${wave * 4 + i + 1}`, headcount: 40 });
      people.push(p);
      add(p);
    }
    check(`arrivée de la vague ${wave + 1}`);

    // Changement de titre, annulation d'un titre futur et correction d'ordre.
    const editable = people.filter(p => s.people.has(p.id) && s.songsOf(p).length > 1);
    for (const p of editable.slice(0, 3)) {
      const last = s.songsOf(p).at(-1);
      s.reorderSongs(p, last.entryId, 0);
    }
    const cancelling = editable.at(-1);
    if (cancelling) {
      const last = s.songsOf(cancelling).at(-1);
      live.delete(last.entryId);
      s.removeSong(cancelling, last.entryId);
    }
    const changing = editable.find(p => p !== cancelling);
    if (changing) add(changing, 'replace');
    const staffCancellation = editable.find(p => p !== changing && p !== cancelling && p.song);
    if (staffCancellation) {
      live.delete(staffCancellation.song.entryId);
      s.staffRemove(staffCancellation.id);
    }
    const queued = people.filter(p => s.people.has(p.id) && p.song);
    const emergency = queued[Math.floor(random() * queued.length)];
    if (emergency) {
      s.staffMove(emergency.id, 0); // « Je dois partir, peux-tu me faire passer ? »
      assert.equal(s.select()?.ids[0], emergency.id, `${context} : passage prioritaire effectivement envoyé`);
    }
    check(`modifications de la vague ${wave + 1}`);
    for (let n = 0; n < 12; n++) play(`vague ${wave + 1}, chanson ${n + 1}`);

    // Deux invités d'une autre table acceptent un duo ; leurs propres tours
    // restent inscrits. La simulation vérifie ensuite chaque chanson unique.
    const candidates = people.filter(p => s.people.has(p.id) && !p.withdrawnAt && p.song);
    const owner = candidates[0], partner = candidates.find(p => p.group !== owner?.group);
    if (owner && partner) {
      const n = nextSong++;
      const duet = s.inviteDuet(owner, partner.id,
        { songId: n, title: `Duo ${n}`, artist: 'Simulation de soirée' });
      live.add(duet.entryId);
      s.answerDuet(partner, true, duet.entryId);
    }
    // Départ d'un groupe entier et d'une personne sans téléphone : leurs
    // chansons sont retirées, les autres ne doivent pas être touchées.
    const departingTable = `V${wave + 1}-6`;
    for (const p of s.tableSingers(departingTable)) removeActive(p);
    s.tableLeft(departingTable);
    const leaving = people.find(p => s.people.has(p.id) && p.tableId === `V${wave + 1}-1` && p.song);
    if (leaving) { removeActive(leaving); s.leave(leaving); }
    check(`départs de la vague ${wave + 1}`);
  }

  assert.equal(people.length, 60, `${context} : soixante personnes ont participé`);
  let turns = 0;
  while (live.size) {
    play(`fin de soirée ${turns + 1}`);
    if (++turns > 200) assert.fail(`${context} : file bloquée après 200 passages`);
  }
  check('file entièrement vidée');
  assert.ok(seen.size > 50, `${context} : la soirée doit réellement jouer des dizaines de titres`);
}

for (const mode of modes) {
  test(`60 clients, 3 vagues, départs, duos, changements et urgences (${mode.name})`, () => {
    for (const seed of [7, 19]) simulate(mode, seed);
  });
}

test('une personne partie avant son passage ne bloque ni sa table ni la soirée', () => {
  const s = new Scheduler({ requirePresence: true, tableRotation: true });
  const people = [];
  for (let i = 1; i <= 6; i++) {
    const p = s.join({ tableId: String(i), name: `Chanteur ${i}`, headcount: 1 });
    s.chooseSong(p, { songId: i, title: `Chanson ${i}`, artist: 'Simulation' });
    people.push(p);
  }
  const announced = s.reservePresenceNext();
  assert.ok(announced, 'le prochain est annoncé avant la confirmation');
  assert.equal(s.select(), null, 'aucun départ automatique sans confirmation');
  const absent = s.people.get(announced.ids[0]);
  s.leave(absent);
  assert.equal(absent.song, null, 'la chanson de la personne partie disparaît');
  const next = s.reservePresenceNext();
  assert.ok(next && next.ids[0] !== absent.id, 'le prochain remplace la personne absente');
  s.confirm(s.people.get(next.ids[0]));
  const selected = s.select();
  assert.equal(selected?.ids[0], next.ids[0], 'le prochain confirmé peut chanter');
  s.commit(selected);
  s.songEnded(selected.ids);
  const remaining = new Set(people.filter(p => p !== absent && p !== s.people.get(next.ids[0]))
    .map(p => p.song.entryId));
  while (remaining.size) {
    const turn = s.reservePresenceNext();
    assert.ok(turn, 'la soirée continue après un départ');
    s.confirm(s.people.get(turn.ids[0]));
    const sel = s.select();
    assert.ok(remaining.delete(sel.song.entryId), 'chaque titre restant passe une fois');
    s.commit(sel);
    s.songEnded(sel.ids);
  }
  assert.equal(s.readyView().length, 0);
});
