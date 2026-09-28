'use strict';
// Deux rondes de quatre chanteurs contre le vrai KaraFun. Ne démarre que sur
// une file complètement vide et nettoie ses trois tables de recette.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const BASE = 'http://127.0.0.1:3000';
const { staffRoute } = require('./staff-auth');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(route, body) {
  const r = await fetch(BASE + await staffRoute(BASE, route), body === undefined ? { signal: AbortSignal.timeout(10000) } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${route}: ${data.error || r.status}`);
  return data;
}
async function until(label, fn, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`${label} : délai dépassé`);
}
const staff = () => request('/api/staff/state');
const report = { startedAt: new Date().toISOString(), rounds: [] };
const names = ['JP recette', 'Table 2 recette', 'Marine recette', 'Table 3 recette'];
const round1 = [names[0], names[1], names[3], names[2]];
const round2 = [names[2], names[1], names[3], names[0]];
let initial, ids = [], usedQueueIds = new Set();

async function sendAndSkip(expected) {
  const s = await until(`envoi ${expected}`, async () => {
    const state = await staff();
    const tracked = state.tracked.find(t => t.label.startsWith(expected + ' · ') && !usedQueueIds.has(t.queueId));
    return tracked && state.kf.queue.some(q => q.queueId === tracked.queueId) ? { state, tracked } : null;
  });
  usedQueueIds.add(s.tracked.queueId);
  await request('/api/staff/kf', { action: 'next' });
  await until(`retrait ${expected}`, async () => {
    const state = await staff();
    return !state.kf.queue.some(q => q.queueId === s.tracked.queueId) && !state.tracked.some(t => t.queueId === s.tracked.queueId);
  });
  return { name: expected, title: s.tracked.title, queueId: s.tracked.queueId };
}

async function main() {
  initial = await staff();
  assert.equal(initial.kf?.ready, true, 'KaraFun non connecté');
  assert.equal(initial.kf.queue.length, 0, 'File KaraFun non vide');
  assert.equal(initial.people.length, 0, 'Chanteurs déjà inscrits : recette refusée');
  assert.equal(initial.pending, null, 'Envoi déjà en cours');
  await request('/api/staff/settings', { auto: false, autoPlay: false });
  const suffix = Date.now().toString(36).slice(-7);
  ids = [`rr1${suffix}`, `rr2${suffix}`, `rr3${suffix}`];
  for (const [index, id] of ids.entries()) await request('/api/staff/table', { id, headcount: index === 0 ? 2 : 1 });
  const tables = (await staff()).tables;
  const secret = id => new URL(tables.find(t => t.id === id).url).pathname.split('/').pop();
  const people = [];
  for (const [name, id] of [[names[0], ids[0]], [names[1], ids[1]], [names[2], ids[0]], [names[3], ids[2]]]) {
    const p = await request('/api/join', { table: id, access: secret(id), name });
    people.push({ name, id: p.id, table: id, access: secret(id) });
  }
  const songs = await request('/api/search?q=an');
  const unique = [...new Map(songs.map(song => [song.songId, song])).values()].slice(0, 8);
  assert.equal(unique.length, 8, 'Catalogue insuffisant pour huit titres distincts');
  for (let i = 0; i < 4; i++) {
    const p = people[i];
    await request('/api/table/song', { table: p.table, access: p.access, personId: p.id, song: unique[i] });
  }
  // Fixe l'ordre interne reproduit dans le retour utilisateur.
  for (let i = 0; i < people.length; i++) await request('/api/staff/move', { personId: people[i].id, toIndex: i });
  // Un déplacement manuel impose explicitement la file choisie par le bar.
  // Activer la rotation remet aussitôt les tables dans la ronde demandée.
  await request('/api/staff/settings', { tableRotation: true, weightedTables: false });
  let state = await staff();
  assert.deepEqual(state.queue.map(q => q.name), round1, 'Première prévision affichée');
  console.log('PASS première file affichée :', state.queue.map(q => q.name).join(' > '));
  await request('/api/staff/settings', { auto: true });
  const sent1 = [];
  for (const expected of round1) sent1.push(await sendAndSkip(expected));
  report.rounds.push(sent1);
  console.log('PASS première ronde KaraFun :', sent1.map(x => x.name).join(' > '));
  await until('file vidée après ronde 1', async () => {
    const s = await staff(); return !s.kf.queue.length && !s.tracked.length && !s.pending ? s : null;
  });

  // Marine choisit avant les trois autres, comme pendant le test du bar.
  const marine = people[2];
  await request('/api/table/song', { table: marine.table, access: marine.access, personId: marine.id, song: unique[4] });
  await until('Marine envoyée', async () => {
    const s = await staff(); return s.tracked.some(t => t.label.startsWith(names[2] + ' · ')) ? s : null;
  });
  for (const [i, index] of [0, 1, 3].entries()) {
    const p = people[index];
    await request('/api/table/song', { table: p.table, access: p.access, personId: p.id, song: unique[i + 5] });
  }
  state = await staff();
  assert.deepEqual(state.queue.filter(q => q.source === 'helper').map(q => q.name), round2.slice(1),
    'Après Marine, le helper doit afficher T2, T3, JP');
  console.log('PASS deuxième file affichée : Marine (KaraFun) >', state.queue.filter(q => q.source === 'helper').map(q => q.name).join(' > '));
  const sent2 = [];
  for (const expected of round2) sent2.push(await sendAndSkip(expected));
  report.rounds.push(sent2);
  console.log('PASS deuxième ronde KaraFun :', sent2.map(x => x.name).join(' > '));
  state = await until('file finale vidée', async () => {
    const s = await staff(); return !s.kf.queue.length && !s.tracked.length && !s.pending && !s.queue.length ? s : null;
  });
  assert.equal(state.queue.length, 0);
}

async function cleanup() {
  if (!initial) return;
  await request('/api/staff/settings', { auto: false, autoPlay: false });
  const end = Date.now() + 18000;
  while (Date.now() < end) {
    const s = await staff();
    const ours = s.kf.queue.filter(q => ids.some(id => q.singer?.includes(id)));
    if (!ours.length && !s.pending) break;
    if (s.stage && ids.some(id => s.stage.singer?.includes(id))) {
      await request('/api/staff/kf', { action: 'next' });
    } else {
      for (const item of ours) await request('/api/staff/kf', { action: 'remove', queueId: item.queueId });
    }
    await sleep(250);
  }
  assert.equal((await staff()).kf.queue.filter(q => ids.some(id => q.singer?.includes(id))).length, 0, 'Nettoyage KaraFun incomplet');
  for (const id of ids) await request('/api/staff/table-left', { id });
  await request('/api/staff/settings', { auto: initial.settings.auto, autoPlay: initial.settings.autoPlay,
    tableRotation: initial.settings.tableRotation, weightedTables: initial.settings.weightedTables });
}

main().then(() => { report.ok = true; }).catch(error => {
  report.ok = false; report.error = error.stack; console.error('FAIL', error); process.exitCode = 1;
}).finally(async () => {
  try { await cleanup(); } catch (error) { report.cleanupError = error.stack; console.error('NETTOYAGE', error); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  const file = path.join(__dirname, '..', 'journal', `rotation-reelle-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('Rapport :', file);
});
