'use strict';
const assert = require('assert');
const { Scheduler } = require('../scheduler');

let n = 0;
const song = (i) => ({ songId: 1000 + i, title: `Titre ${i}`, artist: 'Artiste' });
function t(name, fn) { prev = null; fn(); n++; console.log('ok -', name); }

function singerAt(s, table, name, headcount = 10) {
  const p = s.join({ tableId: table, name, headcount });
  return p;
}

// Horloge simulée : chaque chanson dure 4 minutes.
let clock = Date.now();
Date.now = () => clock;
// Fait « chanter » la sélection comme le ferait le pont KaraFun (la chanson précédente se termine).
let prev = null;
function play(s) {
  if (prev) { clock += 240e3; s.songEnded(prev.ids); }
  const sel = s.select();
  prev = sel;
  if (!sel) return null;
  s.commit(sel);
  return sel;
}

t('plafond de la table : pas plus de chanteurs que de personnes', () => {
  const s = new Scheduler();
  singerAt(s, '3', 'A', 2); singerAt(s, '3', 'B');
  assert.throws(() => singerAt(s, '3', 'C'), /déjà 2 chanteurs/);
});

t('premier inscrit doit donner le nombre de personnes', () => {
  const s = new Scheduler();
  assert.throws(() => s.join({ tableId: '9', name: 'X' }), e => e.code === 'NEED_HEADCOUNT');
});

t('nouveau au milieu, jamais dans les 5 prochains', () => {
  const s = new Scheduler();
  const solos = [];
  for (let i = 0; i < 12; i++) { const p = singerAt(s, `s${i}`, `S${i}`, 1); s.chooseSong(p, song(i)); solos.push(p); }
  for (let i = 0; i < 12; i++) play(s);                  // tout le monde a chanté une fois
  solos.forEach((p, i) => { s.chooseSong(p, song(20 + i)); p.waitingSince = Date.now() - 3600e3; });
  const x = singerAt(s, 'new', 'Nouveau', 1);
  s.chooseSong(x, song(99));
  const i = s.Q.indexOf(x.id);
  assert.ok(i >= 6 && i >= 5, `inséré en ${i}`);
});

t('ouverture : un nouveau passe avant quelqu\'un qui vient de chanter', () => {
  const s = new Scheduler();
  const a = singerAt(s, '1', 'Alice', 2); s.chooseSong(a, song(1));
  play(s);                                              // Alice chante, repart en fin de file (seule)
  s.chooseSong(a, song(2));
  const b = singerAt(s, '2', 'Bob', 1); s.chooseSong(b, song(3));
  assert.strictEqual(s.Q[0], b.id, 'Bob doit passer avant Alice');
});

t('une table de 5 qui arrive d\'un coup est étalée', () => {
  // Isoler ici l'effet de l'écart : avec le nouveau plafond de recul à 2,
  // les contraintes de personnes déjà repoussées peuvent primer sur l'écart.
  const s = new Scheduler({ cap: 5 });
  for (let i = 0; i < 20; i++) { const p = singerAt(s, `s${i}`, `S${i}`, 1); s.chooseSong(p, song(i)); }
  for (let i = 0; i < 20; i++) play(s);
  // leurs chansons sont finies depuis un moment (attentes étalées sur un tour)
  s.Q.forEach((pid, i) => { const p = s.people.get(pid); s.chooseSong(p, song(50)); p.waitingSince = Date.now() - (20 - i) * 240e3; });
  const five = [];
  for (let i = 0; i < 5; i++) { const p = singerAt(s, '7', `T7-${i}`, 5); s.chooseSong(p, song(60 + i)); five.push(p); }
  const idx = five.map(p => s.Q.indexOf(p.id)).sort((a, b) => a - b);
  for (let k = 1; k < idx.length; k++) assert.ok(idx[k] - idx[k - 1] >= 2, `positions ${idx}`);
});

t('jamais deux chansons de suite pour la même table quand les effectifs le permettent', () => {
  const s = new Scheduler();
  const people = [];
  for (let i = 0; i < 2; i++) people.push(singerAt(s, 'A', `A${i}`, 2));
  people.push(singerAt(s, 'B', 'B0', 1));
  people.push(singerAt(s, 'C', 'C0', 1));
  people.forEach((p, i) => s.chooseSong(p, song(i)));
  let last = null;
  for (let k = 0; k < 18; k++) {
    const sel = play(s);
    const tab = s.people.get(sel.ids[0]).tableId;
    const others = [...s.people.values()].some(p => p.tableId !== last);
    if (last && others) assert.notStrictEqual(tab, last, `deux fois ${tab}`);
    last = tab;
    sel.ids.forEach(pid => s.chooseSong(s.people.get(pid), song(100 + k)));
  }
});

t('pas prêt : garde sa place, pas de cumul', () => {
  const s = new Scheduler();
  const ps = ['A', 'B', 'C', 'D'].map(x => singerAt(s, x, x, 1));
  ps.forEach((p, i) => s.chooseSong(p, song(i)));
  for (let k = 0; k < 4; k++) { const sel = play(s); sel.ids.forEach(pid => s.chooseSong(s.people.get(pid), song(10 + k))); }
  const head = s.people.get(s.Q[0]);
  head.song = null;                                       // n'a pas choisi
  const sel1 = play(s); assert.notStrictEqual(sel1.ids[0], head.id);
  s.chooseSong(s.people.get(sel1.ids[0]), song(30));
  assert.strictEqual(s.Q[0], head.id);                    // toujours en tête
  s.chooseSong(head, song(31));
  const sel2 = play(s); assert.strictEqual(sel2.ids[0], head.id);
  s.chooseSong(head, song(32));
  const sel3 = play(s); assert.notStrictEqual(sel3.ids[0], head.id); // ne rechante pas tout de suite
});

t('duo : seul l’initiateur dépense son tour et l’invité garde sa chanson', () => {
  const s = new Scheduler();
  const a = singerAt(s, '5', 'Alice', 3), b = singerAt(s, '5', 'Bob');
  const others = ['X', 'Y', 'Z'].map(x => singerAt(s, x, x, 1));
  others.forEach((p, i) => s.chooseSong(p, song(2 + i)));
  s.chooseSong(b, song(9));
  s.inviteDuet(a, b.id, song(10));
  assert.ok(s.isReady(a));                                // même table : accord immédiat
  assert.equal(s.duetInvites(b).length, 0);
  const order = [];
  for (let k = 0; k < 5; k++) { const sel = play(s); if (!sel) break; order.push(sel.ids.map(pid => s.people.get(pid).name).join('+')); }
  assert.ok(order.includes('Alice+Bob'), order.join(','));
  assert.ok(!order.includes('Alice'), order.join(','));
  assert.strictEqual(a.sung, 1); assert.strictEqual(b.sung, 1);
  assert.ok(order.indexOf('Bob') >= 3, 'deux autres chansons séparent le duo du solo de Bob');
  assert.ok(!b.song, 'la chanson solo de Bob passe ensuite normalement');
});

t('reculs plafonnés', () => {
  const s = new Scheduler();
  assert.strictEqual(s.opts.cap, 2, 'deux places de recul par défaut');
  for (let i = 0; i < 10; i++) { const p = singerAt(s, `s${i}`, `S${i}`, 1); s.chooseSong(p, song(i)); }
  for (let i = 0; i < 10; i++) play(s);
  for (const pid of s.Q) s.chooseSong(s.people.get(pid), song(40));
  for (let i = 0; i < 8; i++) { const p = singerAt(s, `n${i}`, `N${i}`, 1); s.chooseSong(p, song(70 + i)); }
  for (const p of s.people.values()) assert.ok(p.over <= 2, `${p.name} a reculé ${p.over} fois`);
});

t('céder sa place à quelqu\'un de sa table qui est derrière', () => {
  const s = new Scheduler();
  const a = singerAt(s, '2', 'A', 2), b = singerAt(s, '2', 'B');
  const x = singerAt(s, 'x', 'X', 1);
  s.chooseSong(a, song(1)); s.chooseSong(x, song(2)); s.chooseSong(b, song(3));
  const ia = s.Q.indexOf(a.id), ib = s.Q.indexOf(b.id);
  assert.ok(ia < ib);
  s.giveSpot(a, b.id);
  assert.strictEqual(s.Q.indexOf(b.id), ia);
  assert.throws(() => s.giveSpot(a, b.id), /déjà devant/);
});

t('table partie : tickets retirés', () => {
  const s = new Scheduler();
  const a = singerAt(s, '4', 'A', 2), b = singerAt(s, '4', 'B');
  s.chooseSong(a, song(1)); s.chooseSong(b, song(2));
  s.tableLeft('4');
  assert.strictEqual(s.Q.length, 0);
  assert.strictEqual(s.people.size, 0);
});

t('heures estimées croissantes et place garantie en tête', () => {
  const s = new Scheduler();
  for (let i = 0; i < 8; i++) { const p = singerAt(s, `s${i}`, `S${i}`, 1); s.chooseSong(p, song(i)); }
  for (const p of s.people.values()) p.waitingSince = Date.now() - 3600e3;
  const v = s.view(1, Date.now() + 60000);
  for (let i = 1; i < v.length; i++) assert.ok(v[i].eta > v[i - 1].eta);
  assert.ok(v[0].guaranteed && v[4].guaranteed && !v[7].guaranteed);
});

console.log(`\n${n} tests OK`);
