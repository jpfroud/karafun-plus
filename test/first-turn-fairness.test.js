'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');

const song = n => ({ songId: n, title: `Titre ${n}`, artist: 'Simulation' });
const play = s => {
  const selected = s.select();
  assert.ok(selected, 'une chanson prête doit être sélectionnée');
  s.commit(selected);
  s.songEnded(selected.ids);
  return selected;
};
const person = (s, tableId, name, headcount = 1) =>
  s.join({ tableId, name, headcount });

// Journal réel du 28/09 à 17:45:32–17:46:42, avant les interventions du bar.
// Les neuf personnes avaient déjà participé aux essais précédents : il faut
// donc mesurer les premiers passages du NOUVEAU tour, pas seulement sung === 0.
function nineTitlesFromJournal(options) {
  const s = new Scheduler(options);
  const jp = person(s, 'Table JP', 'JP', 2);
  const marine = person(s, 'Table JP', 'Marine');
  const leila = person(s, 'Table Leila', 'Leila', 4);
  const dam = person(s, 'Table Leila', 'Dam');
  const kenny = person(s, 'Table Leila', 'Kenny');
  const yannick = person(s, 'Table Leila', 'Yannick');
  const sebastiano = person(s, 'Table Sebastiano', 'Sebastiano');
  const osark = person(s, 'Comptoir', 'Osark', 40);
  const johnny = person(s, 'Comptoir', 'Johnny');
  const track = (songId, title) => ({ songId, title, artist: 'Recette réelle' });
  s.inviteDuet(jp, marine.id, track(1001, 'Man Down (Album Version)'));
  s.inviteDuet(marine, jp.id, track(1002, 'Bohemian Rhapsody'));
  s.inviteDuet(leila, dam.id, track(1003, 'Tennessee Whiskey'));
  s.inviteDuet(dam, yannick.id, track(1004, 'Mr. Brightside'));
  const kennyDuo = s.inviteDuet(kenny, jp.id, track(1005, 'Creep'));
  s.answerDuet(jp, true, kennyDuo.entryId);
  s.chooseSong(yannick, track(1006, 'Creep'));
  s.chooseSong(sebastiano, track(1007, 'Session 32'));
  s.chooseSong(osark, track(1008, "Sweet Child O' Mine"));
  s.chooseSong(johnny, track(1009, 'Vice'));

  // Ordre reconstitué en inversant les trois commits postérieurs à la capture.
  s.Q = [osark, johnny, marine, yannick, sebastiano, jp, dam, kenny, leila].map(p => p.id);
  s.lastGroup = ['Table Leila'];
  s.roundPeople = new Set(s.Q); // les neuf propriétaires ont terminé le tour précédent
  s.roundGroups = new Set(['Table Leila']);
  s.duetCooldowns = new Map([[dam.id, 2]]); // dernier duo : Leila & Dam
  const history = [
    [jp, 1, 4], [marine, 2, 2], [leila, 2, 0], [dam, 2, 2],
    [kenny, 2, 0], [yannick, 2, 2], [sebastiano, 3, 0],
    [osark, 1, 0], [johnny, 1, 0],
  ];
  for (const [p, sung, invited] of history) {
    p.sung = sung;
    p.duetGuestCount = invited;
  }
  return s;
}

function assertPhysicalTourIsFair(s, passages, context) {
  const seen = new Set();
  for (let i = 0; i < passages.length; i++) {
    const current = passages[i];
    const later = passages.slice(i + 1);
    const untouchedLater = later.some(turn => turn.ids.every(pid => !seen.has(pid)));
    if (untouchedLater && !current.ids.every(pid => !seen.has(pid))) {
      assert.fail(
        `${context} : ${current.name} repasse physiquement avant un duo ou solo entièrement inédit ; ` +
        passages.map(turn => turn.name).join(' → '));
    }
    const unseenLater = later.some(turn => turn.ids.some(pid => !seen.has(pid)));
    if (unseenLater && !current.ids.some(pid => !seen.has(pid))) {
      assert.fail(
        `${context} : ${current.name} repasse sans introduire personne avant un premier passage ; ` +
        passages.map(turn => turn.name).join(' → '));
    }
    current.ids.forEach(pid => seen.add(pid));
  }
  assert.equal(seen.size, s.people.size, `${context} : chaque chanteur doit apparaître dans ces neuf titres`);
}

for (const options of [
  { tableRotation: false },
  { tableRotation: true, weightedTables: false },
  { tableRotation: true, weightedTables: true },
]) {
  const mode = options.tableRotation ? (options.weightedTables ? 'pondéré' : 'tables') : 'personnes';
  test(`journal réel neuf titres : prévision de tour physique équitable (${mode})`, () => {
    const s = nineTitlesFromJournal(options);
    assert.deepEqual(s.Q.map(pid => s.people.get(pid).name),
      ['Osark', 'Johnny', 'Marine', 'Yannick', 'Sebastiano', 'JP', 'Dam', 'Kenny', 'Leila']);
    assert.equal(s.readyView().length, 9, 'les neuf titres du journal sont prêts');
    assert.equal(s.manualOrderActive, false, 'aucune priorité du bar au moment de la capture');
    assertPhysicalTourIsFair(s, s.readyView(), `prévision ${mode}`);
  });

  test(`journal réel neuf titres : envois successifs conservent l’équité (${mode})`, () => {
    const s = nineTitlesFromJournal(options);
    const actual = [];
    for (let i = 0; i < 9; i++) {
      const view = s.readyView();
      const selected = s.select();
      assert.ok(selected, `titre ${i + 1} toujours envoyable`);
      assert.equal(selected.song.entryId, view[0]?.entryId,
        `titre ${i + 1} : KaraFun doit suivre la file annoncée`);
      actual.push({ ids: selected.ids, name: selected.names.join(' & ') });
      s.commit(selected);
      s.songEnded(selected.ids);
    }
    assertPhysicalTourIsFair(s, actual, `envois ${mode}`);
    assert.equal(s.readyView().length, 0, 'aucun titre n’est joué deux fois');
  });

  test(`historiques et permutations : aucun retour avant les premiers passages (${mode})`, () => {
    for (let seed = 0; seed < 12; seed++) {
      const s = nineTitlesFromJournal(options);
      const shift = seed % s.Q.length;
      s.Q = [...s.Q.slice(shift), ...s.Q.slice(0, shift)];
      if (seed % 2) s.Q.reverse();
      s.roundPeople = new Set(s.Q);
      for (const p of s.people.values()) {
        p.sung += seed % 4;
        p.duetGuestCount += (seed + 1) % 3;
      }
      const forecast = s.readyView();
      assert.equal(forecast.length, 9, `graine ${seed} : les neuf titres restent prêts`);
      assertPhysicalTourIsFair(s, forecast, `${mode}, graine ${seed}`);
    }
  });
}

const permutationsOfFour = (() => {
  const all = [];
  const visit = (prefix, rest) => {
    if (!rest.length) { all.push(prefix); return; }
    for (let i = 0; i < rest.length; i++) {
      visit([...prefix, rest[i]], rest.filter((_, j) => j !== i));
    }
  };
  visit([], [0, 1, 2, 3]);
  return all;
})();

for (const options of [
  { tableRotation: false },
  { tableRotation: true, weightedTables: false },
  { tableRotation: true, weightedTables: true },
]) {
  const mode = options.tableRotation ? (options.weightedTables ? 'pondéré' : 'tables') : 'personnes';
  test(`4 chanteurs : 256 choix solo/duo × 24 ordres, prévision et envoi (${mode})`, () => {
    let scenarios = 0;
    for (let combination = 0; combination < 4 ** 4; combination++) {
      for (const order of permutationsOfFour) {
        const s = new Scheduler(options);
        const people = [
          person(s, '1', 'A', 2), person(s, '1', 'B'),
          person(s, '2', 'C', 2), person(s, '2', 'D'),
        ];
        for (let i = 0; i < people.length; i++) {
          const owner = people[i];
          const choice = Math.floor(combination / 4 ** i) % 4;
          const partner = choice ? people.filter(p => p !== owner)[choice - 1] : null;
          if (partner) {
            const duet = s.inviteDuet(owner, partner.id, song(2000 + i));
            if (duet.duet.state === 'pending') s.answerDuet(partner, true, duet.entryId);
          } else s.chooseSong(owner, song(2000 + i));
          owner.sung = 1 + (combination + i) % 3;
          owner.duetGuestCount = (combination + i * 2) % 3;
        }
        s.Q = order.map(i => people[i].id);
        s.roundPeople = new Set(s.Q); // tour historique terminé
        s.roundGroups = new Set(['1', '2']);
        s.lastGroup = ['2'];
        const context = `${mode}, combinaison ${combination}, ordre ${order.join('')}`;
        const forecast = s.readyView();
        assert.equal(forecast.length, 4, `${context} : quatre titres prévus`);
        assertPhysicalTourIsFair(s, forecast, `${context}, prévision`);
        const actual = [];
        for (let turn = 0; turn < 4; turn++) {
          const selected = s.select();
          assert.ok(selected, `${context} : le titre ${turn + 1} est envoyable`);
          assert.equal(selected.song.entryId, forecast[turn].entryId,
            `${context} : l’envoi suit l’ordre annoncé`);
          actual.push({ ids: selected.ids, name: selected.names.join(' & ') });
          s.commit(selected);
          s.songEnded(selected.ids);
        }
        assertPhysicalTourIsFair(s, actual, `${context}, envois`);
        assert.equal(s.readyView().length, 0, `${context} : aucun titre dupliqué`);
        scenarios++;
      }
    }
    assert.equal(scenarios, 4 ** 4 * 24, 'toutes les combinaisons ont été exercées');
  });
}

test('le glisser-déposer du bar atteint la deuxième place puis expire à un nouveau choix', () => {
  for (const options of [
    { tableRotation: false }, { tableRotation: true },
    { tableRotation: true, weightedTables: true },
  ]) {
    const s = new Scheduler(options);
    for (let i = 1; i <= 4; i++) {
      const p = person(s, String(i), `Personne ${i}`);
      s.chooseSong(p, song(i));
    }
    const before = s.readyView().map(turn => turn.ids[0]);
    const moved = before.at(-1);
    s.staffMove(moved, 1);
    assert.equal(s.readyView()[1].ids[0], moved, 'la deuxième place demandée doit être visible');
    assert.equal(play(s).ids[0], before[0]);
    assert.equal(s.select().ids[0], moved, 'le titre déplacé doit vraiment partir en deuxième');
    const newcomer = person(s, '5', 'Nouvelle personne');
    s.chooseSong(newcomer, song(5));
    assert.equal(s.manualOrderActive, false, 'un nouveau titre rend le déplacement manuel périmé');
    assert.deepEqual(s.manualOrder, []);
  }
});

for (const options of [
  { tableRotation: false },
  { tableRotation: true, weightedTables: false },
  { tableRotation: true, weightedTables: true },
]) {
  const mode = options.tableRotation ? (options.weightedTables ? 'pondérée' : 'stricte') : 'par personnes';
  test(`une invitée en duo ne rechante pas avant les premiers passages (${mode})`, () => {
    const s = new Scheduler(options);
    const jp = person(s, '1', 'JP', 2);
    const marine = person(s, '1', 'Marine');
    const kenny = person(s, '2', 'Kenny');
    const seb = person(s, '3', 'Seb');
    const leila = person(s, '4', 'Leila');
    const dam = person(s, '5', 'Dam');
    s.chooseSong(marine, song(1));
    s.chooseSong(kenny, song(2));
    s.chooseSong(seb, song(3));
    s.chooseSong(leila, song(5));
    s.chooseSong(dam, song(6));
    const duo = s.inviteDuet(jp, marine.id, song(4));
    s.reorderSongs(jp, duo.entryId, 0);
    s.Q = [jp.id, marine.id, kenny.id, seb.id, leila.id, dam.id];
    s.manualOrder = [jp.id];
    assert.deepEqual(play(s).ids, [jp.id, marine.id]);
    assert.equal(marine.sung, 0, 'l’invitée conserve son tour solo');
    assert.equal(marine.duetGuestCount, 1, 'elle est déjà montée sur scène');
    const forecast = s.readyView();
    const firstMarine = forecast.findIndex(x => x.ids[0] === marine.id);
    assert.ok(firstMarine >= 4, `Marine annoncée trop tôt : ${forecast.map(x => x.name)}`);
    const firstTurns = [play(s), play(s), play(s), play(s)].map(x => x.ids[0]);
    assert.deepEqual(new Set(firstTurns), new Set([kenny.id, seb.id, leila.id, dam.id]));
    assert.equal(s.select().ids[0], marine.id);
  });

  test(`une soliste déjà passée ne revient pas en duo avant les autres (${mode})`, () => {
    const s = new Scheduler(options);
    const marine = person(s, '1', 'Marine', 2);
    const jp = person(s, '1', 'JP');
    const kenny = person(s, '2', 'Kenny');
    const seb = person(s, '3', 'Seb');
    const leila = person(s, '4', 'Leila');
    s.chooseSong(marine, song(30));
    const duo = s.inviteDuet(jp, marine.id, song(31));
    s.chooseSong(kenny, song(32));
    s.chooseSong(seb, song(33));
    s.chooseSong(leila, song(34));
    s.Q = [marine.id, jp.id, kenny.id, seb.id, leila.id];
    s.manualOrder = [marine.id];
    assert.equal(play(s).ids[0], marine.id);
    assert.equal(marine.sung, 1);
    assert.equal(s.songsOf(jp)[0].entryId, duo.entryId);
    const forecast = s.readyView();
    const duoIndex = forecast.findIndex(x => x.ids[0] === jp.id);
    assert.ok(duoIndex >= 3, `duo annoncé trop tôt : ${forecast.map(x => x.name)}`);
    const firstTurns = [play(s), play(s), play(s)].map(x => x.ids[0]);
    assert.deepEqual(new Set(firstTurns), new Set([kenny.id, seb.id, leila.id]));
    assert.deepEqual(s.select().ids, [jp.id, marine.id]);
  });

  test(`soit la capture réelle : Yannick chante avant le retour de Marine (${mode})`, () => {
    const s = new Scheduler(options);
    const marine = person(s, '1', 'Marine', 2);
    const jp = person(s, '1', 'JP');
    const dam = person(s, '2', 'Dam', 4);
    const kenny = person(s, '2', 'Kenny');
    const leila = person(s, '2', 'Leila');
    const yannick = person(s, '2', 'Yannick');
    const seb = person(s, '3', 'Seb');
    s.chooseSong(marine, song(40));
    s.inviteDuet(dam, kenny.id, song(41));
    s.chooseSong(seb, song(42));
    s.inviteDuet(jp, marine.id, song(43));
    s.inviteDuet(leila, dam.id, song(44));
    const cross = s.inviteDuet(kenny, jp.id, song(45));
    s.answerDuet(jp, true, cross.entryId);
    s.chooseSong(yannick, song(46));
    s.Q = [marine.id, dam.id, seb.id, jp.id, leila.id, kenny.id, yannick.id];
    s.manualOrder = [marine.id];
    const first = play(s);
    assert.equal(first.ids[0], marine.id);
    const forecast = s.readyView();
    assert.ok(forecast.findIndex(x => x.ids[0] === yannick.id) <
      forecast.findIndex(x => x.ids[0] === jp.id), 'la prévision respecte les premiers passages');
    const realized = [first];
    for (let i = 0; i < 6; i++) realized.push(play(s));
    const firstYannick = realized.findIndex(x => x.ids.includes(yannick.id));
    const secondMarine = realized.findIndex((x, i) => i > 0 && x.ids.includes(marine.id));
    assert.ok(firstYannick >= 0 && firstYannick < secondMarine,
      `Marine est revenue avant Yannick : ${realized.map(x => x.ids.map(id => s.people.get(id).name).join('&'))}`);
  });
}

test('l’annonce du prochain passage verrouille la personne malgré arrivées et changement de mode', () => {
  const s = new Scheduler();
  const a = person(s, '1', 'Alice');
  const b = person(s, '2', 'Bruno');
  s.chooseSong(a, song(10));
  s.chooseSong(b, song(11));
  assert.equal(s.reserveNext().ids[0], a.id);
  assert.equal(s.reservedNext.personId, a.id);
  const c = person(s, '3', 'Carla');
  s.chooseSong(c, song(12));
  s.opts.tableRotation = true;
  s.opts.weightedTables = true;
  assert.equal(s.select().ids[0], a.id);
  assert.equal(s.readyView()[0].ids[0], a.id);
  play(s);
  assert.equal(s.reservedNext, null, 'la réservation est consommée à l’envoi');
});

test('une priorité manuelle peut remplacer le prochain passage réservé', () => {
  const s = new Scheduler();
  const a = person(s, '1', 'Alice');
  const b = person(s, '2', 'Bruno');
  s.chooseSong(a, song(20));
  s.chooseSong(b, song(21));
  s.reserveNext();
  s.staffMove(b.id, 0);
  assert.equal(s.reservedNext?.personId, b.id,
    'la décision du bar remplace la réservation et reste ponctuelle');
  assert.equal(s.select().ids[0], b.id);
});

test('prioriser le solo de l’invité d’un duo vise son propre titre', () => {
  const s = new Scheduler();
  const alice = person(s, '1', 'Alice', 2);
  const bob = person(s, '1', 'Bob');
  const clara = person(s, '2', 'Clara');
  s.inviteDuet(alice, bob.id, song(65));
  s.chooseSong(bob, song(66));
  s.chooseSong(clara, song(67));
  s.staffMove(alice.id, 0);
  const before = s.presenceView().filter(v => !v.future);
  assert.deepEqual(before[0].ids, [alice.id, bob.id], 'Bob est invité dans le duo priorisé');
  assert.ok(before.findIndex(v => v.ids[0] === bob.id) > 0,
    'le solo de Bob est une autre ligne, plus loin dans la file');

  s.staffMove(bob.id, 0);
  assert.equal(s.presenceView().find(v => !v.future).ids[0], bob.id,
    'la priorité déplace réellement le solo de Bob devant le duo');
  assert.equal(s.select().song.songId, 66, 'le titre sélectionné est le solo de Bob');
});

test('la priorité du bar surpasse le délai après un duo et change la file annoncée', () => {
  const s = new Scheduler();
  const alice = person(s, '1', 'Alice', 2);
  const bruno = person(s, '1', 'Bruno');
  const carla = person(s, '2', 'Carla');
  const david = person(s, '3', 'David');
  s.inviteDuet(alice, bruno.id, song(70));
  s.chooseSong(bruno, song(71));
  s.chooseSong(carla, song(72));
  s.chooseSong(david, song(73));
  s.manualOrder = [alice.id];
  assert.deepEqual(play(s).ids, [alice.id, bruno.id]);
  assert.equal(s.select().ids[0], carla.id, 'sans intervention, Bruno attend après son duo');
  assert.equal(s.readyView()[0].ids[0], carla.id);

  s.staffMove(bruno.id, 0);
  assert.equal(s.readyView()[0].ids[0], bruno.id, 'le bar voit immédiatement le nouvel ordre');
  assert.equal(s.select().ids[0], bruno.id, 'le titre prioritaire part au prochain créneau disponible');
  assert.equal(s.select().song.songId, 71, 'c’est bien son titre solo qui est choisi');
});

test('deux solistes du Comptoir confirment leur duo et ne cèdent pas leurs places entre eux', () => {
  const s = new Scheduler();
  const alice = person(s, 'Comptoir', 'Alice', 2);
  const bruno = person(s, 'Comptoir', 'Bruno');
  assert.notEqual(alice.group, bruno.group, 'leurs tours restent indépendants');
  const duo = s.inviteDuet(alice, bruno.id, song(74));
  assert.equal(duo.duet.state, 'pending', 'le second soliste doit consentir');
  assert.equal(s.duetInvites(bruno)[0]?.entryId, duo.entryId);
  // Sans réponse, le titre ne l'attend pas : à son tour, il partirait en solo.
  assert.deepEqual(s.select().ids, [alice.id], 'le duo ne part pas avant sa réponse');
  assert.throws(() => s.giveSpot(alice, bruno.id), /groupe/,
    'le Comptoir ne permet pas de céder son rang à un autre soliste');
  s.answerDuet(bruno, true, duo.entryId);
  assert.deepEqual(s.select().ids, [alice.id, bruno.id]);

  const table = new Scheduler();
  const carla = person(table, '1', 'Carla', 2);
  const david = person(table, '1', 'David');
  assert.equal(table.inviteDuet(carla, david.id, song(75)).duet.state, 'accepted',
    'une vraie table garde le duo sans confirmation');
});

test('déplacement et priorité utilisent les indices visibles pendant un envoi KaraFun', () => {
  const create = () => {
    const s = new Scheduler();
    const a = person(s, '1', 'Alice');
    const b = person(s, '2', 'Bruno');
    const c = person(s, '3', 'Carla');
    s.chooseSong(a, song(76));
    s.chooseSong(b, song(77));
    s.chooseSong(c, song(78));
    s.Q = [a.id, b.id, c.id];
    const pending = s.select();
    assert.equal(pending.ids[0], a.id);
    const exclude = pending.consumedIds;
    assert.deepEqual(s.readyView(exclude, pending).map(v => v.ids[0]), [b.id, c.id]);
    return { s, a, b, c, pending, exclude };
  };

  const moved = create();
  moved.s.staffMove(moved.b.id, 1, moved.exclude, moved.pending);
  assert.deepEqual(moved.s.readyView(moved.exclude, moved.pending).map(v => v.ids[0]),
    [moved.c.id, moved.b.id], 'B vers la deuxième ligne visible déplace réellement B après C');
  assert.throws(() => moved.s.staffMove(moved.a.id, 0, moved.exclude, moved.pending),
    /plus dans la file/, 'le titre en cours d’envoi ne peut pas être déplacé');
  moved.s.commit(moved.pending);
  assert.equal(moved.s.select().ids[0], moved.c.id, 'l’ordre survit à la confirmation KaraFun');

  const priority = create();
  priority.s.staffMove(priority.c.id, 0, priority.exclude, priority.pending);
  assert.equal(priority.s.readyView(priority.exclude, priority.pending)[0].ids[0], priority.c.id,
    'Priorité reste visible au premier créneau libre');
  priority.s.commit(priority.pending);
  assert.equal(priority.s.select().ids[0], priority.c.id);
});

for (const options of [
  { tableRotation: false },
  { tableRotation: true, weightedTables: false },
  { tableRotation: true, weightedTables: true },
]) {
  const mode = options.tableRotation ? (options.weightedTables ? 'pondérée' : 'stricte') : 'par personnes';
  test(`duos multiples : un ordre manuel ancien ne ramène pas JP et Marine avant les premiers passages (${mode})`, () => {
    const s = new Scheduler(options);
    const marine = person(s, '1', 'Marine', 2);
    const jp = person(s, '1', 'JP');
    const yannick = person(s, '2', 'Yannick', 3);
    const dam = person(s, '2', 'Dam');
    const kenny = person(s, '2', 'Kenny');
    const seb = person(s, '3', 'Sebastiano');
    const leila = person(s, '4', 'Leila');
    s.inviteDuet(marine, jp.id, song(80)); // sur scène : Marine & JP
    s.chooseSong(yannick, song(81)); // déjà chargée dans KaraFun ensuite
    s.chooseSong(seb, song(82));
    s.inviteDuet(jp, marine.id, song(83));
    s.inviteDuet(dam, yannick.id, song(84));
    const kennyDuo = s.inviteDuet(kenny, jp.id, song(85));
    s.answerDuet(jp, true, kennyDuo.entryId);
    const leilaDuo = s.inviteDuet(leila, dam.id, song(86));
    s.answerDuet(dam, true, leilaDuo.entryId);
    s.Q = [marine.id, yannick.id, seb.id, jp.id, dam.id, kenny.id, leila.id];
    s.manualOrder = [marine.id];
    assert.deepEqual(play(s).ids, [marine.id, jp.id]);
    assert.equal(jp.sung, 0, 'JP conserve son tour après avoir été invité');
    assert.equal(jp.duetGuestCount, 1, 'sa présence physique est comptée');
    s.manualOrder = [yannick.id];
    assert.equal(play(s).ids[0], yannick.id);
    // Une manipulation antérieure de la file a mémorisé toutes ses lignes.
    // Elle ne doit pas faire office de priorité perpétuelle pour chaque duo.
    s.manualOrder = [seb.id, jp.id, dam.id, kenny.id, leila.id];
    const predicted = s.readyView().map(turn => turn.ids);
    const firstSeb = predicted.findIndex(ids => ids.includes(seb.id));
    const firstLeila = predicted.findIndex(ids => ids.includes(leila.id));
    const returnPair = predicted.findIndex(ids => ids[0] === jp.id && ids[1] === marine.id);
    assert.ok(firstSeb >= 0 && firstLeila >= 0 && returnPair > firstSeb && returnPair > firstLeila,
      `JP & Marine reviennent avant des premiers passages : ${s.readyView().map(turn => turn.name)}`);
    assert.equal(play(s).ids[0], seb.id);
    assert.notEqual(s.select().ids[0], jp.id,
      'JP & Marine ne repassent pas immédiatement devant Leila');
  });
}

test('un duo qui présente une nouvelle chanteuse passe avant un retour solo malgré le répit de son partenaire', () => {
  const s = new Scheduler();
  const jp = person(s, '1', 'JP', 2);
  const marine = person(s, '1', 'Marine');
  const leila = person(s, '2', 'Leila');
  s.inviteDuet(jp, marine.id, song(90));
  s.chooseSong(jp, song(91), 'append');
  const nextDuo = s.inviteDuet(leila, marine.id, song(92));
  s.answerDuet(marine, true, nextDuo.entryId);
  s.Q = [jp.id, leila.id];
  s.manualOrder = [jp.id];
  play(s);
  assert.equal(marine.sung, 0);
  assert.equal(marine.duetGuestCount, 1);
  assert.ok(s.duetCooldowns.get(marine.id) > 0);
  assert.deepEqual(s.select().ids, [leila.id, marine.id],
    'le premier passage de Leila prime sur le repos de Marine et le retour de JP');
});

test('entre deux duos avec nouveaux chanteurs, le partenaire le moins passé chante d’abord', () => {
  const s = new Scheduler();
  const marine = person(s, '1', 'Marine', 2);
  const jp = person(s, '1', 'JP');
  const dam = person(s, '2', 'Dam', 2);
  const leila = person(s, '2', 'Leila');
  marine.sung = 1;
  marine.duetGuestCount = 2;
  dam.sung = 1;
  s.inviteDuet(marine, jp.id, song(74));
  s.inviteDuet(dam, leila.id, song(75));
  s.manualOrder = [marine.id, dam.id];
  assert.equal(s.readyView()[0].ids[0], dam.id,
    'le duo de Marine ne ramène pas un partenaire déjà vu trois fois avant Dam vu une fois');
  s.staffMove(marine.id, 0);
  assert.equal(s.select().ids[0], marine.id,
    'une priorité demandée explicitement par le bar peut toujours déroger à ce départage');
});

test('le bar peut exceptionnellement avancer un retour déjà passé, sans priorité perpétuelle ensuite', () => {
  const s = new Scheduler();
  const jp = person(s, '1', 'JP');
  const marine = person(s, '2', 'Marine');
  const leila = person(s, '3', 'Leila');
  s.chooseSong(jp, song(93), 'append');
  s.chooseSong(jp, song(94), 'append');
  s.chooseSong(marine, song(95));
  s.chooseSong(leila, song(96));
  s.Q = [jp.id, marine.id, leila.id];
  play(s);
  assert.equal(s.select().ids[0], marine.id);
  s.staffMove(jp.id, 0); // demande explicite « je dois partir » acceptée par le bar
  assert.equal(s.select().ids[0], jp.id);
  assert.equal(s.readyView()[0].ids[0], jp.id);
  play(s);
  assert.equal(s.reservedNext, null, 'la dérogation n’est valable que pour le titre avancé');
  assert.equal(s.select().ids[0], marine.id);
});

test('présence : B garde le prochain passage devant C confirmé, sans être envoyé trop tôt', () => {
  const s = new Scheduler({ requirePresence: true });
  const a = person(s, '1', 'Alice');
  const b = person(s, '2', 'Bruno');
  const c = person(s, '3', 'Carla');
  const d = person(s, '4', 'David');
  const e = person(s, '5', 'Emma');
  const f = person(s, '6', 'Farid');
  s.chooseSong(a, song(100));
  s.chooseSong(b, song(101));
  s.chooseSong(c, song(102));
  s.inviteDuet(d, e.id, song(103)); // en attente : le titre de David garde sa place, en solo
  s.Q = [a.id, b.id, c.id, d.id, e.id, f.id]; // Farid sans chanson
  s.confirm(a);
  s.confirm(c);
  const onStage = s.select();
  assert.equal(onStage.ids[0], a.id);
  s.commit(onStage);
  assert.equal(s.readyView()[0].ids[0], c.id, 'la vue strictement envoyable omet Bruno');
  assert.deepEqual(s.presenceView().map(v => v.ids), [[b.id], [c.id], [d.id]],
    'la prévision de présence montre le titre de David (invitation en attente, Emma non comprise), pas le ticket sans titre');
  assert.equal(s.reservePresenceNext().ids[0], b.id);
  assert.equal(s.select(), null, 'Carla ne part pas tant que Bruno n’a pas répondu');
  assert.equal(s.reservedNext?.personId, b.id);
  s.confirm(b);
  assert.equal(s.select().ids[0], b.id);
  s.commit(s.select());
  assert.equal(s.reservedNext, null, 'la garantie est consommée seulement à son propre envoi');
  assert.equal(s.select().ids[0], c.id);
});

test('présence : la réservation est libérée si le titre est retiré ; une invitation en attente garde sa place', () => {
  const s = new Scheduler({ requirePresence: true });
  const b = person(s, '1', 'Bruno');
  const c = person(s, '2', 'Carla');
  const d = person(s, '3', 'David');
  s.chooseSong(b, song(104));
  s.chooseSong(c, song(105));
  s.confirm(c);
  assert.equal(s.reservePresenceNext().ids[0], b.id);
  s.staffRemove(b.id);
  assert.equal(s.reservedNext, null);
  assert.equal(s.reservePresenceNext().ids[0], c.id);
  const duet = s.inviteDuet(d, b.id, song(106));
  assert.equal(duet.duet.state, 'pending');
  assert.deepEqual(s.presenceView().map(v => v.ids), [[c.id], [d.id]], 'David seul, après Carla annoncée');
  assert.equal(s.reservePresenceNext().ids[0], c.id);
  // Annoncé alors que son invitation attend : la réservation tient, pour lui seul.
  s.commit(s.select());
  assert.equal(s.reservePresenceNext().ids.join(), d.id);
  assert.equal(s.select(), null, 'David doit confirmer lui-même');
  s.confirm(b);
  assert.equal(s.select(), null, 'la réponse de Bruno ne vaut pas pour David');
  s.confirm(d);
  assert.deepEqual(s.select().ids, [d.id]);
  assert.equal(s.reservedNext?.personId, d.id);
});

test('déplacer au bar le passage réservé vers le bas remplace aussi la garantie', () => {
  const s = new Scheduler();
  const a = person(s, '1', 'Alice');
  const b = person(s, '2', 'Bruno');
  s.chooseSong(a, song(23));
  s.chooseSong(b, song(24));
  s.reserveNext();
  s.staffMove(a.id, 1);
  assert.equal(s.reservedNext, null);
  assert.equal(s.select().ids[0], b.id);
});

test('un remplacement garde le chanteur réservé ; son départ libère la place', () => {
  const s = new Scheduler();
  const alice = person(s, '1', 'Alice');
  const bruno = person(s, '2', 'Bruno');
  s.chooseSong(alice, song(50), 'append');
  s.chooseSong(alice, song(51), 'append');
  s.chooseSong(bruno, song(52));
  s.reserveNext();
  s.staffRemove(alice.id);
  assert.equal(s.reservedNext.personId, alice.id, 'son second titre prend la place garantie');
  assert.equal(s.select().song.songId, 51);
  s.leave(alice);
  assert.equal(s.reservedNext, null);
  assert.equal(s.select().ids[0], bruno.id);
});

test('un prochain passage sans présence garde sa réservation et bloque les suivants', () => {
  const s = new Scheduler();
  const alice = person(s, '1', 'Alice');
  const bruno = person(s, '2', 'Bruno');
  s.chooseSong(alice, song(60));
  s.chooseSong(bruno, song(61));
  s.reserveNext();
  assert.equal(s.reservedNext.personId, alice.id);
  s.opts.requirePresence = true;
  s.confirm(bruno);
  assert.equal(s.select(), null, 'Bruno ne double pas Alice pendant la confirmation');
  assert.equal(s.reservedNext.personId, alice.id);
  s.confirm(alice);
  assert.equal(s.select().ids[0], alice.id);
});

test('36 soirées variées : premier passage physique, invités, arrivées, départs et prévisions', () => {
  const layout = [
    [8, 5], [4, 4], [2, 1], [4, 2], [3, 3], [2, 1],
  ];
  for (const mode of [
    { tableRotation: false },
    { tableRotation: true, weightedTables: false },
    { tableRotation: true, weightedTables: true },
  ]) for (let seed = 1; seed <= 12; seed++) {
    const s = new Scheduler(mode);
    let rng = seed >>> 0;
    const random = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 2 ** 32; };
    let songId = seed * 10000;
    const groups = layout.map(([seats], i) => {
      const tableId = String(i + 1);
      s.setHeadcount(tableId, seats);
      return [];
    });
    const arrive = i => {
      const [ , singers] = layout[i];
      for (let k = 0; k < singers; k++) groups[i].push(person(s, String(i + 1), `T${i + 1}-${k}`));
      for (const p of groups[i]) {
        const tableMates = groups[i].filter(q => q !== p);
        if (tableMates.length && random() < .38) {
          s.inviteDuet(p, tableMates[Math.floor(random() * tableMates.length)].id, song(songId++));
        } else s.chooseSong(p, song(songId++), 'append');
        s.chooseSong(p, song(songId++), 'append');
      }
    };
    arrive(0); arrive(1); arrive(2);
    const played = new Set();
    let turns = 0;
    const runTurn = () => {
      const selected = s.select();
      if (!selected) return false;
      const forecast = s.readyView();
      assert.equal(forecast[0]?.entryId, selected.song.entryId,
        `graine ${seed} : la prévision doit annoncer le vrai prochain titre`);
      const appearance = pid => {
        const p = s.people.get(pid);
        return (p.sung || 0) + (p.duetGuestCount || 0);
      };
      const freshReady = s.Q.some(pid => {
        const p = s.people.get(pid);
        if (!p || p.withdrawnAt || !p.song || p.song.duet?.state === 'pending') return false;
        const guest = p.song.duet?.state === 'accepted' ? s.people.get(p.song.duet.partnerId) : null;
        return !appearance(pid) && (!guest || (!guest.withdrawnAt && !appearance(guest.id)));
      });
      if (freshReady) assert.ok(selected.ids.every(pid => appearance(pid) === 0),
        `graine ${seed} : retour sur scène avant un premier passage`);
      assert.ok(!played.has(selected.song.entryId), `graine ${seed} : titre répété`);
      played.add(selected.song.entryId);
      const guest = selected.ids[1] && s.people.get(selected.ids[1]);
      const guestTurn = guest?.sung;
      s.commit(selected); s.songEnded(selected.ids);
      if (guest) assert.equal(guest.sung, guestTurn, 'l’invité garde son tour');
      turns++;
      assert.ok(turns < 80, `graine ${seed} : file bloquée`);
      return true;
    };
    for (let i = 0; i < 3; i++) assert.ok(runTurn());
    arrive(3); arrive(4); arrive(5);
    for (let i = 0; i < 5; i++) assert.ok(runTurn());
    groups[0].slice(2).forEach(p => s.leave(p));
    s.setHeadcount('1', 2);
    while (runTurn()) {}
    assert.ok([...s.people.values()].every(p => !p.song && !s.songsOf(p).length),
      `graine ${seed} : chansons non jouées`);
    assert.equal(new Set(s.Q).size, s.Q.length, `graine ${seed} : ticket dupliqué`);
  }
});

