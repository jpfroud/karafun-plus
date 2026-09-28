'use strict';
// Simulation de soirées avec le vrai ordonnanceur (scheduler.js), sans réseau.
// Vérifie : équité par personne, pas deux fois de suite la même table, reculs plafonnés, 1re chanson.
const { Scheduler } = require('../scheduler');

function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }

function night(seed, nTables) {
  const R = rng(seed);
  const uni = (a, b) => a + (b - a) * R();
  const expo = (m) => -Math.log(1 - R()) * m;
  const CLOSE = 300;
  const tables = [];
  for (let t = 0; t < nTables; t++) {
    const arr = R() < 0.35 ? uni(0, 45) : uni(45, 210);
    const dep = Math.min(CLOSE, arr + uni(90, 240));
    const kind = R();
    let size, n;
    if (kind < 0.2) { size = 1; n = 1; } else if (kind < 0.5) { size = 2; n = R() < 0.6 ? 2 : 1; }
    else if (kind < 0.8) { size = 3 + Math.floor(R() * 3); n = Math.max(1, Math.floor(size / 2)) + Math.floor(R() * (size - Math.floor(size / 2) + 1)); n = Math.min(n, size); }
    else { size = 8 + Math.floor(R() * 5); n = 2 + Math.floor(R() * 3); }
    tables.push({ id: String(t + 1), arr, dep, size, n });
  }
  // Horloge virtuelle en minutes ; on remplace Date.now pour le scheduler
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now * 60000;
  const s = new Scheduler();
  const people = []; // {p, tab, readyAt, left}
  const events = [];
  for (const t of tables) {
    for (let i = 0; i < t.n; i++) events.push({ at: t.arr + expo(10), type: 'join', t, i });
    events.push({ at: t.dep, type: 'leave', t });
  }
  events.sort((a, b) => a.at - b.at);
  const stats = { songs: 0, sameNext: 0, firsts: [], fair: new Map(), got: new Map(), maxOver: 0 };
  let lastTable = null, songEnd = 0, currentIds = [];
  const present = new Set();
  const due = (pp) => { for (const x of present) stats.fair.set(x, (stats.fair.get(x) || 0) + pp / present.size); };
  while (now < CLOSE) {
    // événements jusqu'à maintenant
    while (events.length && events[0].at <= now) {
      const e = events.shift();
      if (e.type === 'join') {
        try {
          const p = s.join({ tableId: e.t.id, name: `P${e.t.id}-${e.i}`, headcount: e.t.size });
          p._arr = e.at; people.push(p); present.add(p.id);
          s.chooseSong(p, { songId: 1, title: 'x', artist: 'y' });
        } catch (err) { /* table pleine */ }
      } else if (e.type === 'leave') {
        for (const p of s.tableSingers(e.t.id)) present.delete(p.id);
        s.tableLeft(e.t.id);
      } else if (e.type === 'ready') {
        const p = s.people.get(e.pid); if (p && !p.song) s.chooseSong(p, { songId: 2, title: 'x', artist: 'y' });
      }
    }
    for (const pid of s.Q) stats.maxOver = Math.max(stats.maxOver, s.people.get(pid).over);
    if (now >= songEnd) {
      if (currentIds.length) { s.songEnded(currentIds); currentIds = []; }
      const sel = s.select();
      if (!sel) { now += 0.5; continue; }
      s.commit(sel);
      currentIds = sel.ids;
      stats.songs++;
      const tab = s.people.get(sel.ids[0]).tableId;
      if (tab === lastTable) stats.sameNext++;
      lastTable = tab;
      due(sel.ids.length);
      for (const pid of sel.ids) {
        const p = s.people.get(pid);
        stats.got.set(pid, (stats.got.get(pid) || 0) + 1);
        if (p.sung === 1) stats.firsts.push(now - p._arr);
        // prochaine chanson : tout de suite (1 fois sur 2) ou ~15 min plus tard
        const delay = R() < 0.5 ? 0 : expo(15);
        events.push({ at: now + delay, type: 'ready', pid });
      }
      events.sort((a, b) => a.at - b.at);
      const dur = uni(3, 4.5) + 0.5;
      s.recordSlot(dur * 60);
      songEnd = now + dur;
      // choix du duo : 20 % des chansons avec un partenaire de table (règle « au tour du 2e »)
      const owner = s.people.get(sel.ids[0]);
      if (sel.ids.length === 1 && R() < 0.2) {
        const mate = s.tableSingers(owner.tableId).find(q => q.id !== owner.id && !q.duet && !q.duetOf && !q.invite && s.Q.includes(q.id));
        if (mate) { try { s.inviteDuet(owner, mate.id, { songId: 3, title: 'duo', artist: 'z' }); s.answerDuet(mate, true); } catch (e) { /* */ } }
      }
    }
    now = Math.min(songEnd, events.length ? Math.max(now + 0.01, Math.min(songEnd, events[0].at)) : songEnd);
  }
  Date.now = realNow;
  // équité par taille de table : chansons reçues / part équitable
  const byKind = new Map();
  for (const p of people) {
    const t = tables.find(x => x.id === p.tableId);
    const k = t.n === 1 ? 'seul' : t.size <= 2 ? 'couple' : t.size <= 5 ? 'table 3-5' : 'table 8-12';
    const a = byKind.get(k) || { got: 0, due: 0 };
    a.got += stats.got.get(p.id) || 0; a.due += stats.fair.get(p.id) || 0;
    byKind.set(k, a);
  }
  return { stats, byKind };
}

const agg = new Map(); let songs = 0, same = 0, maxOver = 0; const firsts = [];
for (let seed = 1; seed <= 300; seed++) {
  const { stats, byKind } = night(seed, 22);
  songs += stats.songs; same += stats.sameNext; maxOver = Math.max(maxOver, stats.maxOver); firsts.push(...stats.firsts);
  for (const [k, v] of byKind) { const a = agg.get(k) || { got: 0, due: 0 }; a.got += v.got; a.due += v.due; agg.set(k, a); }
}
firsts.sort((a, b) => a - b);
console.log('Soirée chargée (22 tables), 300 soirées, vrai ordonnanceur :');
for (const [k, v] of agg) console.log(`  ${k.padEnd(12)} obtenu / part équitable = ${(v.got / v.due).toFixed(2)}`);
console.log(`  chansons même table que la précédente : ${(100 * same / songs).toFixed(1)} %`);
console.log(`  recul max observé : ${maxOver} (plafond 5)`);
console.log(`  1re chanson : médiane ${firsts[Math.floor(firsts.length / 2)].toFixed(0)} min, 9 sur 10 avant ${firsts[Math.floor(firsts.length * 0.9)].toFixed(0)} min`);
