'use strict';
// Présence sur scène : au plus deux passages par personne et par tour (son
// titre ou invitée d'un duo), et trois autres chansons entre deux passages
// d'une même personne quand un autre passage du tour le permet.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const { TimefoldBridge } = require('../solver/bridge');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');

let n = 1;
const song = () => ({ songId: n, title: `Titre ${n++}`, artist: 'Essai' });

// Tables B, C, D et deux solistes autour de la table étudiée.
function evening(extra, options = {}) {
  const s = new Scheduler(options);
  const people = [];
  const add = (tableId, count, prefix) => {
    s.setHeadcount(tableId, count);
    for (let i = 0; i < count; i++) people.push(s.join({ tableId, name: `${prefix}${i + 1}` }));
  };
  extra(add);
  add('B', 4, 'B'); add('C', 3, 'C'); add('D', 5, 'D');
  s.setHeadcount('Comptoir', 40);
  people.push(s.join({ tableId: 'Comptoir', name: 'S1' }), s.join({ tableId: 'Comptoir', name: 'S2' }));
  return { s, people, byName: name => people.find(p => p.name === name) };
}

const soloRefill = (s, p) => { while (s.songsOf(p).length < 2) s.chooseSong(p, song(), 'append'); };

function play(s, people, refill, passages) {
  const played = [];
  for (let k = 0; k < passages; k++) {
    for (const p of people) refill(p);
    const sel = s.select();
    if (!sel) break;
    s.commit(sel);
    s.songEnded(sel.ids);
    played.push(sel.ids.map(id => people.find(p => p.id === id).name));
  }
  return played;
}

const count = (played, name) => played.filter(ids => ids.includes(name)).length;
const minGap = (played, name) => {
  let last = null, gap = Infinity;
  played.forEach((ids, index) => {
    if (!ids.includes(name)) return;
    if (last !== null) gap = Math.min(gap, index - last);
    last = index;
  });
  return gap;
};

function starEvening(options) {
  const e = evening(add => add('Y', 5, 'Y'), options);
  const star = e.byName('Y1');
  const refill = p => {
    if (p.tableId === 'Y' && p !== star) { while (e.s.songsOf(p).length < 2) e.s.inviteDuet(p, star.id, song()); }
    else soloRefill(e.s, p);
  };
  return { ...e, star, refill };
}

test('tout le monde invite la même personne : deux passages par tour au plus, jamais d’affilée', () => {
  const { s, people, refill } = starEvening();
  const played = play(s, people, refill, 80);
  assert.equal(played.length, 80);
  const soloMax = Math.max(...['B1', 'C1', 'D1', 'S1'].map(name => count(played, name)));
  assert.ok(count(played, 'Y1') <= 2 * soloMax, `Y1 ${count(played, 'Y1')} passages pour ${soloMax} au plus chez les autres`);
  assert.ok(minGap(played, 'Y1') >= 4, `au moins trois chansons entre deux passages de Y1 (écart ${minGap(played, 'Y1')})`);
  for (let i = 1; i < played.length; i++) {
    assert.ok(!played[i].some(name => played[i - 1].includes(name)), `personne deux fois de suite (passage ${i + 1})`);
  }
  // Sans plafond ni espacement, le même scénario donnait 20 passages à Y1.
  const before = starEvening({ roundAppearanceCap: 0, spacingSongs: 0 });
  const unlimited = play(before.s, before.people, before.refill, 80);
  assert.ok(count(unlimited, 'Y1') > count(played, 'Y1') + 5, 'la règle réduit réellement la surexposition');
});

test('duos croisés d’une table de deux et groupe de dix en duos : répartition inchangée', () => {
  const pair = evening(add => add('A', 2, 'A'));
  const [a1, a2] = pair.people;
  const pairPlayed = play(pair.s, pair.people, p => {
    if (p === a1 || p === a2) { while (pair.s.songsOf(p).length < 2) pair.s.inviteDuet(p, (p === a1 ? a2 : a1).id, song()); }
    else soloRefill(pair.s, p);
  }, 80);
  for (const name of ['A1', 'A2']) {
    assert.ok(count(pairPlayed, name) <= count(pairPlayed, 'B1') + 1, `${name} ne monte pas plus souvent que les autres`);
    assert.ok(count(pairPlayed, name) >= count(pairPlayed, 'B1') - 1, `${name} n’est pas pénalisé`);
  }
  const group = evening(add => add('X', 10, 'X'));
  const xs = group.people.filter(p => p.tableId === 'X');
  let r = 0;
  const groupPlayed = play(group.s, group.people, p => {
    if (p.tableId === 'X') {
      while (group.s.songsOf(p).length < 2) {
        const others = xs.filter(q => q !== p);
        group.s.inviteDuet(p, others[(r++) % others.length].id, song());
      }
    } else soloRefill(group.s, p);
  }, 80);
  for (const p of xs) assert.ok(count(groupPlayed, p.name) <= count(groupPlayed, 'B1') + 2, `${p.name} reste proche des autres`);
});

test('un nouveau venu seul n’attend jamais pour l’espacement ; un duo avec quelqu’un qui vient de chanter attend trois chansons au plus', () => {
  const { s, people, star, refill } = starEvening();
  play(s, people, refill, 30);
  const newcomer = s.join({ tableId: 'Comptoir', name: 'Neuf' });
  s.chooseSong(newcomer, song());
  const next = s.select();
  assert.deepEqual(next.ids, [newcomer.id], 'le premier passage d’un soliste reste prioritaire');
  // Deux nouveaux arrivent, l'un invite Y1 qui vient de chanter.
  const late = s.join({ tableId: 'Comptoir', name: 'Tard' });
  s.commit(next); s.songEnded(next.ids);
  const dueWithStar = s.inviteDuet(late, star.id, song());
  s.answerDuet(star, true, dueWithStar.entryId);
  const order = [];
  for (let k = 0; k < 6; k++) {
    for (const p of people) refill(p);
    const sel = s.select();
    s.commit(sel); s.songEnded(sel.ids);
    order.push(sel.ids);
    if (sel.ids.includes(late.id)) break;
  }
  const wait = order.findIndex(ids => ids.includes(late.id));
  assert.ok(wait >= 0 && wait <= 3, `le premier passage de Tard arrive dans les quatre chansons suivantes (${wait})`);
});

test('la prévision affichée est exactement l’ordre réellement chanté', () => {
  const { s, people, refill } = starEvening();
  for (const p of people) refill(p);
  play(s, people, refill, 12);
  const forecast = s.readyView().map(item => item.entryId);
  const real = [];
  for (let guard = 0; guard < 100; guard++) {
    const sel = s.select();
    if (!sel) break;
    real.push(sel.song.entryId);
    s.commit(sel); s.songEnded(sel.ids);
  }
  assert.deepEqual(real, forecast);
});

test('passage annulé, duo noté par le bar et sauvegarde : le compteur du tour reste juste', () => {
  const { s, people, star, refill } = starEvening();
  for (const p of people) refill(p);
  let sel;
  do { sel = s.select(); if (!sel.ids.includes(star.id)) { s.commit(sel); s.songEnded(sel.ids); } } while (!sel.ids.includes(star.id));
  const before = s.roundApps.get(star.id) || 0;
  s.commit(sel);
  assert.equal(s.roundApps.get(star.id), before + 1);
  s.rollbackUnplayed(sel, { requeue: true });
  assert.equal(s.roundApps.get(star.id) || 0, before, 'un duo retiré avant de chanter ne compte pas');

  const guest = people.find(p => p.name === 'B2');
  const owner = people.find(p => p.name === 'C1');
  const appsBefore = s.roundApps.get(guest.id) || 0;
  s.staffCountPartner(owner.id, guest.id);
  assert.equal(s.roundApps.get(guest.id), appsBefore + 1, 'un duo noté par le bar compte comme un passage');

  const access = new TableAccess();
  for (const id of s.tables.keys()) access.issue(id);
  const settings = { auto: false, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 };
  const restored = new Scheduler({});
  restoreNight(snapshotNight({ scheduler: s, access, settings }), { scheduler: restored, access: new TableAccess(), settings: { ...settings } });
  assert.deepEqual([...restored.roundApps], [...s.roundApps]);
  assert.equal(restored.readyView().map(item => item.entryId).join(), s.readyView().map(item => item.entryId).join(),
    'après une reprise, la même file est prévue');
});

test('Timefold juge admissible l’ordre local et respecte le plafond',
  { skip: !fs.existsSync(path.join(__dirname, '..', 'solver', 'target', 'karafun-solver.jar')) &&
    !fs.existsSync(path.join(__dirname, '..', 'solver', 'karafun-solver.jar')) },
  async () => {
    const { s, people, refill } = starEvening({ solverBudgetMs: 1500 });
    for (const p of people) refill(p);
    play(s, people, refill, 14);
    for (const p of people) refill(p);
    const real = new TimefoldBridge();
    let request, response;
    s.opts.solverEnabled = true;
    s.solverBridge = { available: true, lastError: null,
      solve: async (req, options) => { request = req; response = await real.solve(req, options); return response; } };
    try {
      await s.whenPlanReady();
      assert.equal(request.roundCap, 2);
      assert.equal(request.spacing, 3);
      assert.match(response.seedScore, /^0hard/, `ordre local admissible pour Java (${response.seedScore})`);
      assert.match(response.score, /^0hard/, 'la meilleure file trouvée respecte aussi plafond et espacement');
      const ready = s.readyView();
      // En fin de prévision il ne reste que les duos avec Y1 : l'enchaînement
      // n'est admis que lorsque plus aucun autre passage n'est possible.
      for (let i = 1; i < ready.length; i++) {
        const repeated = ready[i].ids.filter(pid => ready[i - 1].ids.includes(pid));
        if (repeated.length) {
          assert.ok(ready.slice(i).every(item => repeated.some(pid => item.ids.includes(pid))),
            `personne deux fois de suite tant qu'un autre passage reste possible (rang ${i + 1})`);
        }
      }
    } finally { real.close(); }
  });
