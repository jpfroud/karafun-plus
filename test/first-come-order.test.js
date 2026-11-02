'use strict';
// Premiers passages : les tables tournent, premier de chaque table (décision
// du gérant du 26 octobre, qui remplace « premier ajouté, premier servi » pur
// du 25 octobre). Au démarrage d'une soirée, 12 personnes ajoutent leur
// premier titre l'une après l'autre. La première se voyait prochaine, puis
// reculait à chaque ajout (jusqu'à la 5e place) : la part des tables passait
// avant l'heure de la demande. Premier ajouté, premier servi a réglé ce recul,
// mais une table dont les chanteurs ajoutent à la suite les faisait chanter à
// la suite. Maintenant, en « Chacun son tour », un cycle où chaque table
// (chaque soliste « En solo » est la sienne) fait passer une personne : les
// tables dans l'ordre d'ajout de leur prochain titre, dans une table ses
// personnes dans l'ordre d'ajout ; une table qui arrive rejoint le cycle en cours.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');

const song = n => ({ songId: n, title: `Titre ${n}`, artist: 'Essai' });
// Ordre d'ajout du constat : une personne en solo, puis les tables A (4),
// B (3) et C (3) mêlées, et une autre personne en solo à la fin.
const ARRIVALS = [['Comptoir', 'S1'], ['A', 'A1'], ['B', 'B1'], ['A', 'A2'], ['C', 'C1'], ['A', 'A3'],
  ['B', 'B2'], ['A', 'A4'], ['C', 'C2'], ['B', 'B3'], ['C', 'C3'], ['Comptoir', 'S2']];
const HEADCOUNT = { A: 4, B: 3, C: 3 };
const NAMES = ARRIVALS.map(([, name]) => name);
// Ordre attendu (exemple de référence du gérant) : un premier de chaque table
// par cycle, les tables dans l'ordre d'ajout de leur candidat.
const CYCLES = ['S1', 'A1', 'B1', 'C1', 'S2', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3', 'A4'];
const settings = () => ({ auto: true, autoPlay: false, baseUrl: 'https://chant.example.test',
  pushDelaySec: 45, playDelaySec: 8 });

function evening(options = {}) {
  const s = new Scheduler(options);
  const people = ARRIVALS.map(([tableId, name]) => s.join({ tableId, name, headcount: HEADCOUNT[tableId] }));
  return { s, people };
}
const order = s => s.readyView().map(item => item.name);
const sing = s => { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); return sel.names.join(' & '); };
const playAll = s => {
  const sung = [];
  for (let guard = 0; guard < 50 && s.select(); guard++) sung.push(sing(s));
  return sung;
};
// Horloge réglée par le test : chaque ajout a lieu une seconde après le
// précédent ; `back(sec)` la fait reculer (synchronisation de l'heure du PC).
function withClock(run) {
  const realNow = Date.now;
  let clock = Date.UTC(2026, 9, 25, 20, 0, 0);
  Date.now = () => clock;
  try { return run(() => { clock += 1000; }, sec => { clock -= sec * 1000; }); } finally { Date.now = realNow; }
}
// Ordre de référence quand tout le monde a ajouté avant le premier passage :
// le cycle k fait passer le k-ième ajouté de chaque table, dans l'ordre
// d'ajout de ces k-ièmes. Chaque soliste du Comptoir est sa propre table.
function reference(arrivals) {
  const seen = new Map();
  return arrivals.map(([table, name], at) => {
    const group = table === 'Comptoir' ? name : table;
    const rank = seen.get(group) || 0;
    seen.set(group, rank + 1);
    return { name, rank, at };
  }).sort((a, b) => a.rank - b.rank || a.at - b.at).map(item => item.name);
}

test('chacun son tour : les tables tournent, la première personne à ajouter reste première', () => {
  const { s, people } = evening();
  const steps = [];
  people.forEach((p, k) => {
    s.chooseSong(p, song(k + 1));
    steps.push(order(s));
    assert.equal(order(s)[0], 'S1', `après l’ajout de ${p.name} : ${order(s).join(' ')}`);
    assert.deepEqual(order(s), reference(ARRIVALS.slice(0, k + 1)), `après l’ajout de ${p.name}`);
  });
  assert.deepEqual(steps.at(-1), CYCLES, 'exemple de référence du gérant');
  // C1 rejoint le cycle en cours avant A2, ajouté plus tôt mais d'une table déjà passée.
  assert.deepEqual(steps[4], ['S1', 'A1', 'B1', 'C1', 'A2']);
  assert.deepEqual(playAll(s), CYCLES, 'les passages suivent l’ordre annoncé');
});

test('chacun son tour : tables et solistes mêlés au hasard, toujours le cycle puis l’ordre d’ajout', () => {
  let x = 7;
  const random = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let round = 0; round < 20; round++) {
    const s = new Scheduler();
    const tables = { A: 1 + Math.floor(random() * 6), B: 1 + Math.floor(random() * 4), C: 1 + Math.floor(random() * 3) };
    const pool = [];
    for (const [table, count] of Object.entries(tables)) for (let k = 0; k < count; k++) pool.push([table, `${table}${k + 1}`]);
    for (let k = 0; k < 3; k++) pool.push(['Comptoir', `S${k + 1}`]);
    // Ordre d'ajout au hasard, mais dans une table les personnes gardent leur numéro.
    const arrivals = [];
    while (pool.length) {
      const [table] = pool[Math.floor(random() * pool.length)];
      const next = pool.findIndex(([t]) => t === table);
      arrivals.push(pool.splice(next, 1)[0]);
    }
    const people = arrivals.map(([tableId, name]) => s.join({ tableId, name, headcount: tables[tableId] }));
    people.forEach((p, k) => s.chooseSong(p, song(k + 1)));
    const expected = reference(arrivals);
    assert.deepEqual(order(s), expected, `essai ${round} : ${arrivals.map(([, n]) => n).join(' ')}`);
    assert.deepEqual(playAll(s), expected, `essai ${round} : passages`);
  }
});

test('chacun son tour : deux ajouts dans la même milliseconde gardent leur ordre', () => {
  withClock(() => {
    const { s, people } = evening();
    people.forEach((p, k) => s.chooseSong(p, song(k + 1)));
    assert.deepEqual(order(s), CYCLES);
    const stamps = people.map(p => p.readySince);
    assert.ok(stamps.every((at, k) => !k || at > stamps[k - 1]), 'heures strictement croissantes');
  });
});

test('chacun son tour : une table qui arrive rejoint le cycle en cours, sans dépasser qui a ajouté avant elle', () => {
  withClock(tick => {
    const s = new Scheduler();
    s.setHeadcount('A', 3); s.setHeadcount('B', 2); s.setHeadcount('D', 2);
    const [a1, a2, a3] = ['A1', 'A2', 'A3'].map(name => s.join({ tableId: 'A', name }));
    const [b1, b2] = ['B1', 'B2'].map(name => s.join({ tableId: 'B', name }));
    for (const [k, p] of [a1, b1, a2, b2, a3].entries()) { tick(); s.chooseSong(p, song(k + 1)); }
    assert.deepEqual(order(s), ['A1', 'B1', 'A2', 'B2', 'A3']);
    assert.deepEqual([sing(s), sing(s), sing(s)], ['A1', 'B1', 'A2']);
    assert.deepEqual([...s.firstCycle], [a2.group], 'deuxième cycle : la table A y est passée');
    // La table D arrive pendant le deuxième cycle : D1 y passe, après B2,
    // ajouté avant lui ; D2 passe au cycle suivant, avec A3.
    const [d1, d2] = ['D1', 'D2'].map(name => s.join({ tableId: 'D', name }));
    tick(); s.chooseSong(d1, song(6));
    tick(); s.chooseSong(d2, song(7));
    assert.deepEqual(order(s), ['B2', 'D1', 'A3', 'D2'], 'D1 dans le cycle en cours, sans enchaîner D2');
    assert.deepEqual(playAll(s), ['B2', 'D1', 'A3', 'D2']);
  });
});

// Relecture : une table partie restait dans le cycle des premiers passages,
// contrairement au tour des tables (`roundGroups`). Rouverte avec le même
// numéro dans le même cycle, sa nouvelle tablée passait pour déjà servie et
// attendait tout le cycle suivant.
test('chacun son tour : une table partie puis rouverte rejoint le cycle des premiers passages en cours', () => {
  withClock(tick => {
    const s = new Scheduler();
    let n = 1;
    const add = (tableId, name) => {
      const p = s.join({ tableId, name, headcount: 3 });
      tick(); s.chooseSong(p, song(n++));
      return p;
    };
    for (const [tableId, name] of [['1', 'A1'], ['2', 'B1'], ['3', 'C1'], ['2', 'B2'], ['3', 'C2'], ['4', 'D1'], ['4', 'D2']]) add(tableId, name);
    assert.equal(sing(s), 'A1');
    s.tableLeft('1');
    assert.deepEqual([...s.firstCycle], [], 'la table partie quitte le cycle');
    add('1', 'N1');
    assert.deepEqual(order(s), ['B1', 'C1', 'D1', 'N1', 'B2', 'C2', 'D2'], 'la nouvelle tablée passe dans le cycle en cours');
    assert.deepEqual(playAll(s), ['B1', 'C1', 'D1', 'N1', 'B2', 'C2', 'D2']);
  });
});

// Relecture (passe 3) : un passage annulé (sorti de KaraFun sans être
// chanté) rendait le cycle d'avant lui tel que noté dans son reçu, table
// partie depuis comprise. Rouverte avec le même numéro, sa nouvelle tablée
// passait pour déjà servie : N1, qui a ajouté avant E1, passait après lui.
test('chacun son tour : un passage annulé ne remet pas dans le cycle une table partie depuis', () => {
  withClock(tick => {
    const s = new Scheduler();
    let n = 1;
    const add = (tableId, name) => {
      const p = s.join({ tableId, name, headcount: 1 });
      tick(); s.chooseSong(p, song(n++));
      return p;
    };
    for (const [tableId, name] of [['1', 'A1'], ['2', 'B1'], ['3', 'C1']]) add(tableId, name);
    assert.deepEqual([sing(s), sing(s)], ['A1', 'B1']);
    const sel = s.select();
    assert.deepEqual(sel.names, ['C1']);
    s.commit(sel); // C1 ferme le cycle
    assert.deepEqual([...s.firstCycle], []);
    s.tableLeft('1');
    s.requeueUnplayed(sel); // « Pas prêt » : C1 n'a pas chanté
    assert.deepEqual([...s.firstCycle], ['2'], 'le cycle d’avant C1, sans la table partie');
    add('1', 'N1');
    add('4', 'E1');
    assert.deepEqual(order(s), ['C1', 'N1', 'E1'], 'la table rouverte passe dans le cycle en cours, dans l’ordre d’ajout');
  });
});

// Relecture (passe 4) : même règle quand l'invitée quitte un duo chargé qui
// fermait le cycle (_dropPartnerCredit). Le cycle rouvert sans sa table
// reprenait toutes les tables notées à la fermeture, table partie depuis
// comprise : rouverte avec Nina, elle passait pour déjà servie, et Max, la
// deuxième personne de la table A, chantait avant Nina.
test('invitée qui quitte un duo chargé qui fermait le cycle : une table partie depuis n’y revient pas', () => withClock(tick => {
  let n = 1;
  const s = new Scheduler();
  s.setHeadcount('A', 2); s.setHeadcount('B', 1); s.setHeadcount('C', 1);
  const gus = s.join({ tableId: 'C', name: 'Gus' });
  const ines = s.join({ tableId: 'A', name: 'Inès' }), max = s.join({ tableId: 'A', name: 'Max' });
  const zoe = s.join({ tableId: 'B', name: 'Zoé' });
  tick(); s.chooseSong(gus, song(n++));
  tick(); const duo = s.inviteDuet(ines, zoe.id, song(n++));
  tick(); s.chooseSong(max, song(n++));
  tick(); s.chooseSong(zoe, song(n++));
  s.answerDuet(zoe, true, duo.entryId);
  assert.equal(sing(s), 'Gus');
  tick();
  const sel = s.select();
  assert.deepEqual(sel.cycleClosing, ['C', 'A', 'B']);
  s.commit(sel); // le duo Inès & Zoé ferme le cycle, chargé dans KaraFun
  s.tableLeft('C');
  s.leaveSentDuet(sel, zoe.id); // « Je ne chante plus ce duo »
  assert.deepEqual([...s.firstCycle], ['A'], 'le cycle reste ouvert sans la table de Zoé ni la table partie');
  const nina = s.join({ tableId: 'C', name: 'Nina', headcount: 1 });
  tick(); s.chooseSong(nina, song(n++));
  s.songEnded(sel.ids);
  assert.deepEqual(order(s), ['Zoé', 'Nina', 'Max'], 'la table rouverte passe dans le cycle en cours');
}));

// Relecture (passe 12) : même règle quand la table est rouverte avant que le
// titre qui fermait le cycle ressorte de KaraFun (« Pas prêt », absent à
// l'appel, priorité du bar, titre passé dans KaraFun). Le reçu rendait le
// cycle d'avant ce titre en gardant les tables où quelqu'un est inscrit au
// moment du retour : la table partie, rouverte avec N1, passait pour déjà
// servie, et N1, qui a ajouté avant E1, passait après lui. Une table partie
// après le reçu n'y revient pas, rouverte ou non.
test('chacun son tour : table partie et rouverte pendant que le titre qui ferme le cycle est chargé, il ressort : elle n’est pas comptée servie', () => {
  withClock(tick => {
    const s = new Scheduler();
    let n = 1;
    const add = (tableId, name) => {
      const p = s.join({ tableId, name, headcount: 1 });
      tick(); s.chooseSong(p, song(n++));
      return p;
    };
    for (const [tableId, name] of [['1', 'A1'], ['2', 'B1'], ['3', 'C1']]) add(tableId, name);
    assert.deepEqual([sing(s), sing(s)], ['A1', 'B1']);
    const sel = s.select();
    s.commit(sel); // C1 ferme le cycle, chargé dans KaraFun
    s.tableLeft('1');
    add('1', 'N1'); // la table 1 rouverte avant que le titre de C1 ressorte
    add('4', 'E1');
    s.requeueUnplayed(sel);
    assert.deepEqual([...s.firstCycle], ['2'], 'le cycle d’avant C1, sans la table partie depuis');
    assert.deepEqual(order(s), ['C1', 'N1', 'E1'], 'N1 a ajouté avant E1');
  });
});

test('chacun son tour : table partie et rouverte avant une reprise, le titre qui ferme le cycle ressort ensuite : elle n’est pas comptée servie', () => {
  withClock(tick => {
    const s = new Scheduler();
    let n = 1;
    const add = (sched, tableId, name) => {
      const p = sched.join({ tableId, name, headcount: 1 });
      tick(); sched.chooseSong(p, song(n++));
      return p;
    };
    for (const [tableId, name] of [['1', 'A1'], ['2', 'B1'], ['3', 'C1']]) add(s, tableId, name);
    assert.deepEqual([sing(s), sing(s)], ['A1', 'B1']);
    const sel = s.select();
    s.commit(sel);
    s.tableLeft('1');
    add(s, '1', 'N1');
    const access = new TableAccess();
    for (const id of s.tables.keys()) access.issue(id);
    const saved = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings: settings(), tracked: [{ sel, queueId: 7 }] })));
    const back = new Scheduler();
    const recovered = restoreNight(saved, { scheduler: back, access: new TableAccess(), settings: settings() });
    add(back, '4', 'E1');
    back.requeueUnplayed(recovered.tracked[0].sel);
    assert.deepEqual([...back.firstCycle], ['2'], 'le départ de la table survit à la reprise');
    assert.deepEqual(order(back), ['C1', 'N1', 'E1']);
  });
});

// Relecture (passe 13) : un titre du milieu du cycle est chargé, puis une
// table déjà passée dans ce cycle part (_drop la retire du cycle). Le reçu ne
// rendait le cycle que s'il n'avait pas bougé depuis : la table du titre
// ressorti restait comptée servie, et C1 passait derrière trois demandes plus
// récentes. Le cycle se compare maintenant à celui du reçu sans les tables
// parties depuis.
test('chacun son tour : titre du milieu du cycle chargé, une table déjà passée part, il ressort : sa table n’est pas comptée servie', () => withClock(tick => {
  const s = new Scheduler();
  let n = 1;
  const add = (tableId, name) => { const p = s.join({ tableId, name, headcount: 2 }); tick(); s.chooseSong(p, song(n++)); return p; };
  add('1', 'A1'); add('3', 'C1'); add('2', 'B1'); add('4', 'D1'); add('1', 'A2');
  assert.equal(sing(s), 'A1');
  const sel = s.select();
  assert.deepEqual(sel.names, ['C1']);
  s.commit(sel); // C1 chargé dans KaraFun, cycle {1, 3}
  s.tableLeft('1');
  s.requeueUnplayed(sel); // absent à l'appel, « Pas prêt », titre passé dans KaraFun
  assert.deepEqual([...s.firstCycle], [], 'le cycle d’avant C1, sans la table partie');
  assert.deepEqual(order(s), ['C1', 'B1', 'D1']);
}));

test('chacun son tour : la table de l’auteur d’un duo chargé part, le duo ressort : la table de l’invitée n’est pas comptée servie', () => withClock(tick => {
  const s = new Scheduler();
  let n = 1;
  const [ana, bob, cid] = [['1', 'Ana'], ['2', 'Bob'], ['3', 'Cid']].map(([tableId, name]) => s.join({ tableId, name, headcount: 2 }));
  tick(); const duo = s.inviteDuet(ana, bob.id, song(n++)); s.answerDuet(bob, true, duo.entryId);
  tick(); s.chooseSong(bob, song(n++));
  tick(); s.chooseSong(cid, song(n++));
  const sel = s.select();
  assert.deepEqual(sel.names, ['Ana', 'Bob']);
  s.commit(sel); // Ana & Bob chargé, cycle {1, 2}
  s.tableLeft('1');
  s.rollbackUnplayed(sel); // retrait confirmé par KaraFun (removeLeaversTracks puis sync)
  assert.deepEqual([...s.firstCycle], [], 'la table de Bob n’a pas été servie');
  assert.deepEqual(order(s), ['Bob', 'Cid'], 'Bob a ajouté avant Cid');
}));

// Relecture (passe 13, cellules sans test) : branche où rien de comparé n'a
// bougé depuis le reçu (un passage qui commence un tour neuf, la table partie
// n'était plus dans le cycle de ce tour) ; et limite du numéro de départ : une
// table partie et rouverte avant le reçu, déjà passée dans le cycle, y reste.
test('chacun son tour : titre du tour neuf chargé, table du cycle partie et rouverte, il ressort : elle n’est pas comptée servie', () => withClock(tick => {
  const s = new Scheduler({ solverEnabled: false });
  let n = 1;
  const add = (tableId, name) => { const p = s.join({ tableId, name, headcount: 1 }); tick(); s.chooseSong(p, song(n++)); return p; };
  const more = p => { tick(); s.chooseSong(p, song(n++), 'append'); };
  const [a1, b1, c1] = [['1', 'A1'], ['2', 'B1'], ['3', 'C1']].map(([tableId, name]) => add(tableId, name));
  assert.deepEqual([sing(s), sing(s)], ['A1', 'B1']);
  s.deferPassage(c1.id, s.presenceView().find(v => !v.future && v.ids[0] === c1.id), 3);
  more(a1); more(b1);
  const sel = s.select();
  s.commit(sel);
  assert.deepEqual(sel.turnCredit.before.firstCycle, ['1', '2']);
  s.tableLeft('2');
  add('2', 'N2'); add('4', 'E4');
  s.requeueUnplayed(sel);
  assert.deepEqual([...s.firstCycle], ['1']);
  assert.deepEqual([...s.roundGroups], ['1'], 'le tour d’avant ce passage, sans la table partie depuis');
  assert.deepEqual(order(s).slice(0, 2), ['N2', 'E4']);
}));

test('chacun son tour : titre qui ferme le cycle, ou duo de deux tables, ressorti sans départ : le cycle d’avant lui revient', () => withClock(tick => {
  {
    const s = new Scheduler();
    let n = 1;
    const add = (tableId, name) => { const p = s.join({ tableId, name, headcount: 1 }); tick(); s.chooseSong(p, song(n++)); return p; };
    add('1', 'A1'); add('2', 'B1'); add('3', 'C1');
    assert.deepEqual([sing(s), sing(s)], ['A1', 'B1']);
    const sel = s.select();
    s.commit(sel);
    assert.deepEqual([...s.firstCycle], [], 'C1 ferme le cycle');
    add('4', 'D1');
    s.requeueUnplayed(sel);
    assert.deepEqual([...s.firstCycle], ['1', '2']);
    assert.deepEqual(order(s), ['C1', 'D1']);
  }
  {
    const s = new Scheduler();
    let n = 1;
    const [ana, bob, cid] = [['1', 'Ana'], ['2', 'Bob'], ['3', 'Cid']].map(([tableId, name]) => s.join({ tableId, name, headcount: 2 }));
    tick(); const duo = s.inviteDuet(ana, bob.id, song(n++)); s.answerDuet(bob, true, duo.entryId);
    tick(); s.chooseSong(bob, song(n++));
    tick(); s.chooseSong(cid, song(n++));
    const sel = s.select();
    s.commit(sel);
    assert.deepEqual([...s.firstCycle], ['1', '2'], 'le duo sert ses deux tables');
    s.requeueUnplayed(sel);
    assert.deepEqual([...s.firstCycle], []);
    assert.deepEqual(order(s), ['Ana & Bob', 'Cid', 'Bob']);
  }
}));

test('chacun son tour : table partie et rouverte avant le reçu, déjà passée dans le cycle : elle y reste quand le titre ressort', () => withClock(tick => {
  const s = new Scheduler();
  let n = 1;
  const add = (tableId, name, headcount = 1) => { const p = s.join({ tableId, name, headcount }); tick(); s.chooseSong(p, song(n++)); return p; };
  add('1', 'A1'); add('2', 'B1');
  assert.equal(sing(s), 'A1');
  s.tableLeft('1');
  add('1', 'N1', 2); add('1', 'N2', 2); add('3', 'C1');
  assert.deepEqual([sing(s), sing(s)], ['B1', 'N1']);
  const sel = s.select();
  assert.deepEqual(sel.names, ['C1']);
  s.commit(sel); // C1 ferme le cycle
  add('4', 'E1');
  s.requeueUnplayed(sel);
  assert.deepEqual([...s.firstCycle], ['2', '1'], 'la table 1 est passée dans ce cycle, après sa réouverture');
  assert.deepEqual(order(s), ['C1', 'E1', 'N2']);
}));

// Même interleaving pour l'invitée qui quitte un duo chargé qui fermait le
// cycle (_dropPartnerCredit) : Nina rejoint la table C avant le départ de Zoé.
test('invitée qui quitte un duo chargé qui fermait le cycle, table partie et rouverte avant : elle n’y revient pas', () => withClock(tick => {
  let n = 1;
  const s = new Scheduler();
  s.setHeadcount('A', 2); s.setHeadcount('B', 1); s.setHeadcount('C', 1);
  const gus = s.join({ tableId: 'C', name: 'Gus' });
  const ines = s.join({ tableId: 'A', name: 'Inès' }), max = s.join({ tableId: 'A', name: 'Max' });
  const zoe = s.join({ tableId: 'B', name: 'Zoé' });
  tick(); s.chooseSong(gus, song(n++));
  tick(); const duo = s.inviteDuet(ines, zoe.id, song(n++));
  tick(); s.chooseSong(max, song(n++));
  tick(); s.chooseSong(zoe, song(n++));
  s.answerDuet(zoe, true, duo.entryId);
  assert.equal(sing(s), 'Gus');
  tick();
  const sel = s.select();
  s.commit(sel);
  s.tableLeft('C');
  const nina = s.join({ tableId: 'C', name: 'Nina', headcount: 1 });
  tick(); s.chooseSong(nina, song(n++));
  s.leaveSentDuet(sel, zoe.id);
  assert.deepEqual([...s.firstCycle], ['A'], 'le cycle reste ouvert sans la table de Zoé ni la table partie depuis');
  s.songEnded(sel.ids);
  assert.deepEqual(order(s), ['Zoé', 'Nina', 'Max'], 'la table rouverte passe dans le cycle en cours');
}));

test('chacun son tour : une table qui arrive pendant l’envoi du passage qui ferme un cycle le rejoint encore', () => {
  withClock(tick => {
    const s = new Scheduler();
    s.setHeadcount('A', 3); s.setHeadcount('B', 2); s.setHeadcount('D', 1);
    const [a1, a2, a3] = ['A1', 'A2', 'A3'].map(name => s.join({ tableId: 'A', name }));
    const [b1, b2] = ['B1', 'B2'].map(name => s.join({ tableId: 'B', name }));
    for (const [k, p] of [a1, b1, a2, b2, a3].entries()) { tick(); s.chooseSong(p, song(k + 1)); }
    assert.deepEqual([sing(s), sing(s), sing(s)], ['A1', 'B1', 'A2']);
    // B2 ferme le deuxième cycle au moment de son choix ; la table D arrive
    // avant l'accusé de KaraFun : D1 passe dans ce cycle, avant A3.
    tick();
    const sel = s.select();
    assert.deepEqual(sel.names, ['B2']);
    assert.deepEqual(sel.firstCycle, [], 'cycle fermé au choix');
    const d1 = s.join({ tableId: 'D', name: 'D1' });
    tick(); s.chooseSong(d1, song(6));
    s.commit(sel); s.songEnded(sel.ids);
    assert.deepEqual([...s.firstCycle].sort(), [a1.group, b1.group].sort(), 'le cycle reste ouvert pour D');
    assert.deepEqual(order(s), ['D1', 'A3']);
    assert.deepEqual(playAll(s), ['D1', 'A3']);
    // Sans arrivée pendant l'envoi, le cycle se ferme au même moment.
    const t = new Scheduler();
    t.setHeadcount('A', 2);
    const [x1, x2] = ['X1', 'X2'].map(name => t.join({ tableId: 'A', name }));
    const y1 = t.join({ tableId: 'B', name: 'Y1', headcount: 1 });
    for (const [k, p] of [x1, y1, x2].entries()) { tick(); t.chooseSong(p, song(k + 10)); }
    assert.equal(sing(t), 'X1');
    tick();
    const late = t.select();
    assert.deepEqual(late.names, ['Y1']);
    t.commit(late);
    assert.deepEqual([...t.firstCycle], [], 'nouveau cycle');
  });
});

// Relecture (passe 6) : pendant l'envoi, la prévision (publicState :
// presenceView(sel.consumedIds, sel), téléphones et bar) appliquait le cycle
// noté au choix tel quel, sans la règle d'arrivée de _commit : D1, arrivée
// pendant l'envoi du passage qui ferme le cycle, s'affichait derrière A3
// jusqu'à l'accusé, puis passait devant sans que la file change.
test('chacun son tour : pendant l’envoi du passage qui ferme un cycle, la prévision place la table arrivée comme l’accusé', () => {
  withClock(tick => {
    for (const arrives of [true, false]) {
      const s = new Scheduler();
      s.setHeadcount('A', 3); s.setHeadcount('B', 2); s.setHeadcount('D', 1);
      const [a1, a2, a3] = ['A1', 'A2', 'A3'].map(name => s.join({ tableId: 'A', name }));
      const [b1, b2] = ['B1', 'B2'].map(name => s.join({ tableId: 'B', name }));
      for (const [k, p] of [a1, b1, a2, b2, a3].entries()) { tick(); s.chooseSong(p, song(k + 1)); }
      assert.deepEqual([sing(s), sing(s), sing(s)], ['A1', 'B1', 'A2']);
      tick();
      const sel = s.select(); // B2 ferme le cycle au choix
      assert.deepEqual(sel.firstCycle, [], 'cycle fermé au choix');
      const view = () => [s.presenceView(sel.consumedIds, sel), s.readyView(sel.consumedIds, sel)]
        .map(list => list.filter(v => !v.future).map(v => v.name));
      assert.deepEqual(view(), [['A3'], ['A3']], 'avant l’arrivée');
      let d1 = null;
      if (arrives) { d1 = s.join({ tableId: 'D', name: 'D1' }); tick(); s.chooseSong(d1, song(6)); }
      const during = view();
      if (d1) {
        // Prévision gardée (_viewKey) : la même sélection, choisie pas avant
        // la demande de D1 (au même instant : la règle compte une arrivée
        // seulement après le choix), ne voit pas D1 arriver pendant l'envoi.
        const later = { ...sel, pickedAt: d1.readySince };
        assert.deepEqual(s.presenceView(sel.consumedIds, later).filter(v => !v.future).map(v => v.name), ['A3', 'D1'],
          'choix daté pas avant la demande de D1 : le cycle se ferme sans elle');
      }
      s.commit(sel); s.songEnded(sel.ids);
      const label = arrives ? 'D arrive pendant l’envoi' : 'sans arrivée';
      assert.deepEqual(order(s), arrives ? ['D1', 'A3'] : ['A3'], label);
      assert.deepEqual(during, [order(s), order(s)], `${label} : la prévision pendant l’envoi est l’ordre après l’accusé`);
    }
  });
});

// Relecture (passe 5) : l'heure du choix (`pickedAt`) était prise sur
// l'horloge du PC, les débuts d'attente sur celle qui ne recule jamais
// (Scheduler#_readyStamp). L'horloge du PC recule de deux minutes juste
// après le choix de B2 : la table D, arrivée pendant l'envoi, était datée
// avant ce choix et le cycle se fermait sans elle (A3 avant D1). Dans
// l'autre sens, en « Duos uniquement », le duo ouvert de Gus (table G),
// demandé avant le choix de B1, l'horloge reculant entre sa demande et ce
// choix, comptait comme une arrivée : le cycle fermé restait ouvert pour
// lui, et son duo passait devant A2, qui avait demandé avant lui. Un recul
// après le choix ne faisait pas ce faux arrivant.
test('horloge du PC reculée après le choix qui ferme un cycle, ou avant lui après une demande : arrivée pendant l’envoi ou demande d’avant, chacune à sa place', () => {
  withClock((tick, back) => {
    const s = new Scheduler();
    s.setHeadcount('A', 3); s.setHeadcount('B', 2); s.setHeadcount('D', 1);
    const [a1, a2, a3] = ['A1', 'A2', 'A3'].map(name => s.join({ tableId: 'A', name }));
    const [b1, b2] = ['B1', 'B2'].map(name => s.join({ tableId: 'B', name }));
    for (const [k, p] of [a1, b1, a2, b2, a3].entries()) { tick(); s.chooseSong(p, song(k + 1)); }
    assert.deepEqual([sing(s), sing(s), sing(s)], ['A1', 'B1', 'A2']);
    tick();
    const sel = s.select();
    assert.deepEqual(sel.names, ['B2']);
    assert.deepEqual(sel.firstCycle, [], 'cycle fermé au choix');
    back(120);
    const d1 = s.join({ tableId: 'D', name: 'D1' });
    tick(); s.chooseSong(d1, song(6));
    assert.ok(d1.readySince > sel.pickedAt, 'demande datée après le choix');
    s.commit(sel); s.songEnded(sel.ids);
    assert.deepEqual([...s.firstCycle].sort(), [a1.group, b1.group].sort(), 'le cycle reste ouvert pour D');
    assert.deepEqual(order(s), ['D1', 'A3']);
  });
  withClock((tick, back) => {
    const s = new Scheduler();
    let duoOnly = false;
    s.duoOnlyRule = () => duoOnly;
    const [a1, b1, a2] = [['A', 'A1'], ['B', 'B1'], ['A', 'A2']]
      .map(([tableId, name]) => s.join({ tableId, name, headcount: 2 }));
    const gus = s.join({ tableId: 'G', name: 'Gus', headcount: 2 }), nina = s.join({ tableId: 'N', name: 'Nina', headcount: 2 });
    for (const [k, p] of [a1, b1, a2].entries()) { tick(); s.chooseSong(p, song(k + 1)); }
    assert.equal(sing(s), 'A1');
    duoOnly = true;
    tick(); s.openDuet(gus, { song: song(4) }); // retenu tant que personne ne le rejoint
    back(120);
    const sel = s.select();
    assert.deepEqual(sel.names, ['B1']);
    assert.deepEqual(sel.firstCycle, [], 'cycle fermé au choix');
    assert.ok(gus.readySince <= sel.pickedAt, 'le duo de Gus était demandé avant le choix');
    s.commit(sel); s.songEnded(sel.ids);
    assert.deepEqual([...s.firstCycle], [], 'nouveau cycle : personne n’est arrivé pendant l’envoi');
    s.acceptOpenDuet(nina, gus.id, gus.song.entryId);
    duoOnly = false;
    assert.deepEqual(order(s), ['A2', 'Gus & Nina']);
  });
});

test('premiers passages : un duo entre deux tables fait passer les deux tables dans le cycle', () => {
  withClock(tick => {
    const s = new Scheduler();
    s.setHeadcount('A', 2); s.setHeadcount('B', 2); s.setHeadcount('C', 1);
    const [a1, a2] = ['A1', 'A2'].map(name => s.join({ tableId: 'A', name }));
    const [b1, b2] = ['B1', 'B2'].map(name => s.join({ tableId: 'B', name }));
    const c1 = s.join({ tableId: 'C', name: 'C1' });
    tick(); const duo = s.inviteDuet(a1, b1.id, song(1));
    s.answerDuet(b1, true, duo.entryId);
    for (const [k, p] of [b2, c1, a2].entries()) { tick(); s.chooseSong(p, song(k + 2)); }
    // B1 monte sur scène avec A1 : la table B est passée dans ce cycle, C1
    // passe avant B2, ajouté plus tôt ; le cycle suivant reprend l'ordre d'ajout.
    assert.deepEqual(order(s), ['A1 & B1', 'C1', 'B2', 'A2']);
    assert.deepEqual(playAll(s), ['A1 & B1', 'C1', 'B2', 'A2']);
  });
});

test('premiers passages : un duo compte par l’heure de son auteur, dans les trois modes', () => {
  for (const options of [{}, { tableRotation: true }, { tableRotation: true, weightedTables: true }]) {
    const s = new Scheduler(options);
    s.setHeadcount('A', 3); s.setHeadcount('B', 2);
    const [a1, a2, a3] = ['A1', 'A2', 'A3'].map(name => s.join({ tableId: 'A', name }));
    const [b1, b2] = ['B1', 'B2'].map(name => s.join({ tableId: 'B', name }));
    const s1 = s.join({ tableId: 'Comptoir', name: 'S1' });
    const mode = JSON.stringify(options);
    // S1 propose un duo à B1 (autre table, réponse attendue) avant tout le
    // monde ; la table A, plus grande, ajoute ensuite trois titres. En
    // « Compromis », la part de A (racine de 3) passe d'abord.
    const duo = s.inviteDuet(s1, b1.id, song(1));
    s.chooseSong(a1, song(2));
    s.chooseSong(a2, song(3));
    s.chooseSong(a3, song(4));
    const shared = options.weightedTables ? ['A1'] : [];
    assert.deepEqual(order(s).slice(0, shared.length + 1), [...shared, 'S1'],
      `${mode} : le titre de S1 attend sa réponse à sa place : ${order(s).join(' ')}`);
    // L'invitée accepte plus tard : le duo garde l'heure de son auteur.
    s.answerDuet(b1, true, duo.entryId);
    s.chooseSong(b2, song(5));
    const view = order(s);
    assert.deepEqual(view.slice(0, shared.length + 1), [...shared, 'S1 & B1'], `${mode} : ${view.join(' ')}`);
    assert.ok(view.indexOf('A1') < view.indexOf('A2') && view.indexOf('A2') < view.indexOf('A3'),
      `${mode} : une même table dans l’ordre d’ajout : ${view.join(' ')}`);
    assert.deepEqual(playAll(s), view, `${mode} : les passages suivent l’ordre annoncé`);
  }
});

test('tables à tour de rôle : la part des tables d’abord, l’ordre d’ajout à part égale', () => {
  const { s, people } = evening({ tableRotation: true });
  people.forEach((p, k) => {
    s.chooseSong(p, song(k + 1));
    // Au départ, toutes les tables ont la même part : la première arrivée
    // passe la première, la seconde personne en solo ne double personne.
    assert.equal(order(s)[0], 'S1', `après l’ajout de ${p.name} : ${order(s).join(' ')}`);
  });
  const view = order(s);
  // La part fait déjà tourner les tables ; le cycle de « Chacun son tour »
  // n'y joue pas (à part égale, A3, ajouté avant C2, passe d'abord).
  assert.deepEqual(view, ['S1', 'A1', 'B1', 'C1', 'S2', 'A2', 'B2', 'A3', 'C2', 'B3', 'A4', 'C3']);
  for (const table of ['A', 'B', 'C']) {
    const members = view.filter(name => name[0] === table);
    assert.deepEqual(members, [...members].sort(), `table ${table} dans l’ordre d’ajout`);
  }
  assert.deepEqual(playAll(s), view);
});

// Relecture (passe 9, test manquant) : à part égale, les premiers passages
// suivent l'ordre d'ajout sans tenir compte d'un bonus ni d'un malus (clé
// [0, 0, -1, addedAt] en Node, {0, 0, -1000, added} dans QueueScore.java) ;
// la clé des retours, elle, les pondère.
test('tables à tour de rôle : premiers passages dans l’ordre d’ajout, bonus ou malus compris', () => withClock(tick => {
  for (const [who, level] of [['A1', -3], ['C1', 3]]) {
    const s = new Scheduler({ tableRotation: true });
    const people = ['A', 'B', 'C'].map(table => s.join({ tableId: table, name: `${table}1`, headcount: 1 }));
    s.setPersonBonus(people.find(p => p.name === who).id, level);
    people.forEach((p, k) => { tick(); s.chooseSong(p, song(k + 1)); });
    assert.deepEqual(order(s), ['A1', 'B1', 'C1'], `${who} à ${level > 0 ? '+' : ''}${level} : l’ordre d’ajout`);
  }
}));

test('compromis : la grande table garde sa part, ses chanteurs passent dans l’ordre d’ajout', () => {
  const s = new Scheduler({ tableRotation: true, weightedTables: true });
  s.setHeadcount('A', 4); s.setHeadcount('B', 1);
  const a = ['A1', 'A2', 'A3', 'A4'].map(name => s.join({ tableId: 'A', name }));
  const b1 = s.join({ tableId: 'B', name: 'B1' });
  // A4 ajoute avant A1 ; la table A (racine de 4 = 2) passe avant B1.
  for (const [k, p] of [a[3], b1, a[1], a[0], a[2]].entries()) s.chooseSong(p, song(k + 1));
  const view = order(s);
  assert.deepEqual(view.filter(name => name[0] === 'A'), ['A4', 'A2', 'A1', 'A3'], view.join(' '));
  assert.equal(view[0], 'A4', 'la part de la grande table reste prioritaire');
});

test('déplacement du bar : il passe toujours avant le cycle des tables', () => {
  const { s, people } = evening();
  people.forEach((p, k) => s.chooseSong(p, song(k + 1)));
  const last = people.at(-1);
  s.staffMove(last.id, 0);
  assert.equal(order(s)[0], 'S2', 'la priorité du bar passe devant');
  assert.deepEqual(order(s).slice(1), CYCLES.filter(name => name !== 'S2'), 'les autres gardent le cycle');
});

test('reprise après redémarrage : le cycle et l’ordre d’ajout sont gardés, sauvegarde d’avant ces champs comprise', () => {
  withClock(tick => {
    const { s, people } = evening();
    const access = new TableAccess();
    for (const id of s.tables.keys()) access.issue(id);
    people.slice(0, 6).forEach((p, k) => { tick(); s.chooseSong(p, song(k + 1)); });
    const save = () => JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings: settings() })));
    const saved = save();
    assert.ok(saved.scheduler.people.every(p => !p.song || Number.isFinite(p.readySince)), 'heure sauvegardée');
    const resume = (snapshot, arrivals = ARRIVALS.slice(6), first = 7) => {
      const back = new Scheduler();
      restoreNight(JSON.parse(JSON.stringify(snapshot)), { scheduler: back, access: new TableAccess(), settings: settings() });
      arrivals.forEach(([, name], k) => {
        tick();
        back.chooseSong([...back.people.values()].find(p => p.name === name), song(first + k));
      });
      return back;
    };
    assert.deepEqual(order(resume(saved)), CYCLES, 'reprise : même ordre, les nouveaux à leur place');
    // Sauvegarde d'avant ce champ : l'heure d'entrée dans la file en tient lieu.
    const legacy = JSON.parse(JSON.stringify(saved));
    for (const p of legacy.scheduler.people) delete p.readySince;
    delete legacy.scheduler.firstCycle;
    legacy.scheduler.people[1].readySince = 'abîmé';
    assert.deepEqual(order(resume(legacy)), CYCLES, 'ancienne sauvegarde : lisible, même ordre');
    // En plein cycle : S1 et A1 ont chanté, B1, C1 et S2 restent à passer dans ce cycle.
    people.slice(6).forEach((p, k) => { tick(); s.chooseSong(p, song(7 + k)); });
    assert.deepEqual([sing(s), sing(s)], ['S1', 'A1']);
    const mid = save();
    assert.deepEqual(mid.scheduler.firstCycle, [people[0].group, people[1].group], 'cycle sauvegardé');
    assert.deepEqual(order(resume(mid, [])), CYCLES.slice(2), 'reprise en plein cycle : il continue');
  });
});

test('passage annulé : la personne retrouve l’heure de son attente et le cycle d’avant', () => {
  const { s, people } = evening();
  people.slice(0, 3).forEach((p, k) => s.chooseSong(p, song(k + 1)));
  const sel = s.select();
  assert.equal(sel.names[0], 'S1');
  const before = people[0].readySince;
  s.commit(sel);
  assert.deepEqual([...s.firstCycle], [people[0].group], 'la table de S1 est passée dans le cycle');
  s.chooseSong(people[0], song(20)); // titre rechoisi pendant l'envoi
  assert.ok(people[0].readySince > before);
  s.rollbackUnplayed(sel, { requeue: true });
  assert.equal(people[0].readySince, before, 'heure d’avant l’envoi rendue');
  assert.deepEqual([...s.firstCycle], [], 'cycle d’avant le passage rendu');
  assert.equal(order(s)[0], 'S1', 'S1 reste la première arrivée');
});

test('grande table arrivée tard puis un nouveau d’une autre table : les tables tournent, les habitués s’intercalent ensuite', () => {
  withClock(tick => {
    // Relecture du 26 octobre : quatre habitués ont chanté, une table de six
    // ajoute ses premiers titres, puis X1, d'une autre table, le sien. Seule,
    // la table T est intercalée d'habitués (anti-série). Avec premier ajouté,
    // premier servi pur, T enchaînait ses six titres avant X1 et les habitués
    // repassaient derrière. Le cycle des tables fait passer X1 juste après T1 ;
    // ensuite, seule T a encore des premiers passages : les habitués
    // s'intercalent de nouveau.
    const s = new Scheduler();
    const habitues = ['R1', 'R2', 'R3', 'R4'].map((name, k) => s.join({ tableId: `H${k}`, name, headcount: 1 }));
    let n = 0;
    for (const p of habitues) { tick(); s.chooseSong(p, song(++n)); s.chooseSong(p, song(++n), 'append'); }
    for (let k = 0; k < 4; k++) { sing(s); tick(); }
    const table = Array.from({ length: 6 }, (_, k) => s.join({ tableId: 'T', name: `T${k + 1}`, headcount: 6 }));
    for (const p of table) { tick(); s.chooseSong(p, song(++n)); }
    assert.deepEqual(order(s), ['T1', 'R1', 'T2', 'R2', 'T3', 'R3', 'T4', 'R4', 'T5', 'T6'], 'T seule : intercalée');
    const x1 = s.join({ tableId: 'X', name: 'X1', headcount: 1 });
    tick(); s.chooseSong(x1, song(++n));
    const after = order(s);
    assert.deepEqual(after, ['T1', 'X1', 'T2', 'R1', 'T3', 'R2', 'T4', 'R3', 'T5', 'R4', 'T6'], after.join(' '));
    assert.deepEqual(playAll(s), after, 'les passages suivent l’ordre annoncé');
  });
});

test('reprise après redémarrage : un ajout part après les heures sauvegardées, même si l’horloge a reculé', () => {
  withClock(tick => {
    const { s, people } = evening();
    const access = new TableAccess();
    for (const id of s.tables.keys()) access.issue(id);
    people.slice(0, 3).forEach((p, k) => { tick(); s.chooseSong(p, song(k + 1)); });
    const saved = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings: settings() })));
    const realNow = Date.now;
    const back = new Scheduler();
    restoreNight(saved, { scheduler: back, access: new TableAccess(), settings: settings() });
    Date.now = () => Date.UTC(2026, 9, 25, 19, 0, 0); // une heure plus tôt
    try {
      const next = [...back.people.values()].find(p => p.name === NAMES[3]);
      back.chooseSong(next, song(4));
    } finally { Date.now = realNow; }
    assert.deepEqual(order(back), NAMES.slice(0, 4));
  });
});

test('céder sa place : deux premiers passages d’une même table suivent l’ordre affiché', () => {
  const s = new Scheduler();
  s.setHeadcount('A', 2);
  const [a1, a2] = ['A1', 'A2'].map(name => s.join({ tableId: 'A', name }));
  const b1 = s.join({ tableId: 'B', name: 'B1', headcount: 1 });
  for (const [k, p] of [a1, a2, b1].entries()) s.chooseSong(p, song(k + 1));
  assert.deepEqual(order(s), ['A1', 'B1', 'A2']);
  assert.throws(() => s.giveSpot(a2, a1.id), /A1 est déjà devant toi/);
  s.giveSpot(a1, a2.id);
  assert.deepEqual(order(s), ['A2', 'B1', 'A1'], 'A2 prend la place de A1');
  assert.throws(() => s.giveSpot(a1, a2.id), /A2 est déjà devant toi/);
});

// « Je suis là » obligatoire (relecture du 27 octobre) : seul le prochain
// annoncé peut confirmer sa présence, et select() ne voyait que lui parmi les
// premiers passages en attente. Le cycle des tables semblait donc fini à
// chaque choix et repartait vide après chaque passage : premier ajouté,
// premier servi pur (S1 A1 B1 A2 C1 A3 B2 A4 C2 B3 C3 S2, S2 de la 5e à la
// dernière place), et l'ordre annoncé aux téléphones changeait à chaque
// passage. Boucle du serveur : réserver le prochain, le confirmer, l'envoyer.
test('« Je suis là » obligatoire : le cycle des tables tient d’un passage à l’autre', () => withClock(tick => {
  const s = new Scheduler({ requirePresence: true });
  const people = ARRIVALS.map(([tableId, name]) => s.join({ tableId, name, headcount: HEADCOUNT[tableId] }));
  people.forEach((p, k) => { tick(); s.chooseSong(p, song(k + 1)); });
  assert.deepEqual(s.presenceView().map(item => item.name), CYCLES, 'ordre annoncé au départ');
  const sung = [];
  for (let guard = 0; guard < 30; guard++) {
    tick();
    s.reservePresenceNext();
    if (s.reservedNext) s.confirm(s.people.get(s.reservedNext.personId));
    const sel = s.select();
    if (!sel) break;
    s.commit(sel); s.songEnded(sel.ids);
    sung.push(sel.names.join(' & '));
    assert.deepEqual(s.presenceView().map(item => item.name), CYCLES.slice(sung.length),
      `ordre annoncé après ${sung.join(' ')}`);
  }
  assert.deepEqual(sung, CYCLES);
}));

// Même cause pour les tours : un habitué intercalé entre les premiers passages
// d'une grande table, annoncé comme passage pris sur le tour suivant (dette),
// était noté à l'envoi comme le début d'un tour neuf (tour remis à zéro, sans
// dette), puisque select() ne voyait que lui. Chaque passage envoyé note
// maintenant le même état que le passage annoncé, et la soirée reste celle
// d'un bar sans « Je suis là » obligatoire.
test('« Je suis là » obligatoire : un habitué intercalé reste une dette, comme annoncé', () => {
  const night = requirePresence => withClock(tick => {
    const s = new Scheduler({ requirePresence });
    const habitues = ['R1', 'R2', 'R3', 'R4'].map((name, k) => s.join({ tableId: `H${k}`, name, headcount: 1 }));
    let n = 0;
    for (const p of habitues) { tick(); s.chooseSong(p, song(++n)); s.chooseSong(p, song(++n), 'append'); }
    const table = Array.from({ length: 6 }, (_, k) => s.join({ tableId: 'T', name: `T${k + 1}`, headcount: 6 }));
    const steps = [];
    for (let guard = 0; guard < 20; guard++) {
      tick();
      if (guard === 4) for (const p of table) { tick(); s.chooseSong(p, song(++n)); }
      // Passage annoncé, tel que la prévision des téléphones le simule.
      let announced = null;
      if (requirePresence) {
        s.reservePresenceNext();
        if (s.reservedNext) s.confirm(s.people.get(s.reservedNext.personId));
        announced = s._forecast(false, [], null, true)[0];
      }
      const sel = s.select();
      if (!sel) break;
      const state = c => ({ ids: c.ids, roundResets: c.roundResets || 0, borrowedIds: c.borrowedIds || [],
        owed: c.owed || null, firstCycle: c.firstCycle ?? null });
      if (announced) assert.deepEqual(state(sel), state(announced), `passage ${guard + 1} (${sel.names.join(' & ')}) : envoyé comme annoncé`);
      s.commit(sel); s.songEnded(sel.ids);
      steps.push({ name: sel.names.join(' & '), roundPeople: [...s.roundPeople].map(pid => s.people.get(pid).name).sort(),
        roundUse: [...s.roundUse].map(([pid, use]) => `${s.people.get(pid).name}:${use}`).sort() });
    }
    return steps;
  });
  const free = night(false), presence = night(true);
  assert.ok(free.some((step, k) => k > 4 && step.name.startsWith('R')), 'des habitués s’intercalent');
  assert.deepEqual(presence, free);
});
