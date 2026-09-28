'use strict';
// Duo inter-tables sur KaraFun réel : l'initiateur dépense son tour, l'invité
// conserve son solo, qui attend deux autres titres prêts si possible.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { staffRoute } = require('./staff-auth');
const BASE = 'http://127.0.0.1:3000';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(route, body) {
  const url = BASE + await staffRoute(BASE, route);
  const r = await fetch(url, body === undefined ? { signal: AbortSignal.timeout(10000) } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${route}: ${data.error || r.status}`);
  return data;
}
async function until(label, fn, ms = 18000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(250); }
  throw new Error(`${label} : délai dépassé`);
}
const staff = () => request('/api/staff/state');
const report = { startedAt: new Date().toISOString(), passages: [] };
let songs = [];
let initial, ids = [];
async function main() {
  initial = await staff();
  assert.equal(initial.kf?.ready, true);
  assert.equal(initial.kf.queue.length, 0, 'La file KaraFun doit être vide');
  assert.equal(initial.people.length, 0, 'Les inscriptions doivent être vides');
  const found = await request('/api/search?q=Queen');
  const titles = new Set();
  songs = found.filter(song => {
    if (!song.songId || !song.title || titles.has(song.title)) return false;
    titles.add(song.title); return true;
  }).slice(0, 4).map(({ songId, title, artist }) => ({ songId, title, artist }));
  assert.equal(songs.length, 4);
  const suffix = Date.now().toString(36).slice(-7);
  ids = ['da', 'db', 'dc', 'dd'].map(prefix => prefix + suffix);
  await request('/api/staff/settings', { auto: false, autoPlay: false, requirePresence: false });
  for (const id of ids) await request('/api/staff/table', { id, headcount: 1 });
  const tables = (await staff()).tables;
  const access = id => new URL(tables.find(t => t.id === id).url).pathname.split('/').pop();
  const people = [];
  for (const [index, name] of ['Initiateur', 'Invité', 'Autre C', 'Autre D'].entries()) {
    const t = ids[index];
    const person = await request('/api/table/person', { table: t, access: access(t), name });
    people.push({ ...person, table: t, access: access(t), name });
  }
  for (const [index, p] of people.entries()) {
    if (index === 0) continue;
    await request('/api/table/song', { table: p.table, access: p.access, personId: p.id, song: songs[index] });
  }
  await request('/api/table/duet', { table: people[0].table, access: people[0].access,
    personId: people[0].id, partnerId: people[1].id, song: songs[0] });
  await request('/api/table/duet/answer', { table: people[1].table, access: people[1].access,
    personId: people[1].id, accept: true });
  await request('/api/staff/move', { personId: people[0].id, toIndex: 0 });
  const planned = (await staff()).queue.map(q => q.name);
  assert.ok(planned[0].includes('Initiateur') && planned[0].includes('Invité'));
  await request('/api/staff/settings', { auto: true });
  const others = planned.filter(name => name === 'Autre C' || name === 'Autre D');
  assert.equal(others.length, 2);
  const expected = ['Initiateur', ...others, 'Invité'];
  const seen = new Set();
  for (const name of expected) {
    const current = await until(`envoi ${name}`, async () => {
      const s = await staff();
      const tr = s.tracked.find(t => t.label.startsWith(name) && !seen.has(t.queueId));
      return tr && s.kf.queue.some(q => q.queueId === tr.queueId) ? { s, tr } : null;
    });
    seen.add(current.tr.queueId);
    assert.equal(current.s.settings.auto, true);
    if (name === 'Initiateur') {
      assert.ok(current.tr.label.includes('Invité'), 'Le nom du duo doit être dans KaraFun');
      const owner = current.s.people.find(p => p.id === people[0].id);
      const guest = current.s.people.find(p => p.id === people[1].id);
      assert.equal(owner.sung, 1, 'L’initiateur dépense son tour');
      assert.equal(guest.sung, 0, 'L’invité garde son tour');
      const guestState = await request(`/api/state?table=${people[1].table}&access=${people[1].access}`);
      assert.equal(guestState.tablePeople[0].songs[0].songId, songs[1].songId);
    }
    report.passages.push({ name, label: current.tr.label, queueId: current.tr.queueId });
    await request('/api/staff/kf', { action: 'next' });
    await until(`retrait ${name}`, async () => {
      const s = await staff(); return !s.kf.queue.some(q => q.queueId === current.tr.queueId) ? s : null;
    });
  }
  await until('file finale vide', async () => {
    const s = await staff(); return !s.kf.queue.length && !s.tracked.length && !s.pending ? s : null;
  });
  assert.equal(new Set(report.passages.map(p => p.queueId)).size, 4);
  console.log('PASS duo réel :', report.passages.map(p => p.label).join(' > '));
}
async function cleanup() {
  if (!initial) return;
  await request('/api/staff/settings', { auto: false, autoPlay: false });
  const s = await staff();
  for (const q of s.kf.queue.filter(q => ids.some(id => q.singer?.includes(id)))) {
    await request('/api/staff/kf', { action: 'remove', queueId: q.queueId });
  }
  for (const id of ids) await request('/api/staff/table-left', { id });
  await request('/api/staff/settings', { auto: initial.settings.auto, autoPlay: initial.settings.autoPlay,
    requirePresence: initial.settings.requirePresence });
}
main().then(() => { report.ok = true; }).catch(error => {
  report.ok = false; report.error = error.stack; console.error('FAIL', error); process.exitCode = 1;
}).finally(async () => {
  try { await cleanup(); } catch (error) { report.cleanupError = error.stack; console.error('NETTOYAGE', error); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  const file = path.join(__dirname, '..', 'journal', `duo-reel-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('Rapport :', file);
});
