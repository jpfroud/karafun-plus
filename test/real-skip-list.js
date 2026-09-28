'use strict';
// Reproduit cinq « Suivant » consécutifs, puis un nouveau choix après une
// file vidée. Lance uniquement quand la file KaraFun est vide.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.env.BASE || 'http://localhost:3000';
const { staffRoute } = require('./staff-auth');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(route, body) {
  const r = await fetch(BASE + await staffRoute(BASE, route), body === undefined ? { signal: AbortSignal.timeout(10000) } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${route}: ${data.error || r.status}`);
  return data;
}
async function until(fn, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await sleep(250);
  }
  throw new Error('Délai dépassé');
}
const report = { startedAt: new Date().toISOString(), steps: [] };
const mark = (name, data) => { report.steps.push({ at: new Date().toISOString(), name, data }); console.log('PASS', name, data || ''); };
async function main() {
  const initial = await request('/api/staff/state');
  assert.equal(initial.kf?.ready, true, 'KaraFun non connecté');
  assert.equal(initial.kf.queue.length, 0, 'La file réelle doit être vide avant la recette');
  assert.equal(initial.settings.auto, true, 'L’envoi automatique doit être activé');
  assert.equal(initial.settings.autoPlay, false, 'Désactive la lecture automatique pour cette recette');
  const id = `rs${Date.now().toString(36)}`;
  let secret, token;
  const found = await request('/api/search?q=Queen');
  const seen = new Set();
  const titles = found.filter(song => {
    if (!song.songId || !song.title || seen.has(song.title)) return false;
    seen.add(song.title); return true;
  }).slice(0, 6).map(({ songId, title, artist }) => ({ songId, title, artist }));
  assert.equal(titles.length, 6, 'Six titres KaraFun distincts sont nécessaires');
  try {
    await request('/api/staff/table', { id, headcount: 1 });
    const t = (await request('/api/staff/state')).tables.find(x => x.id === id);
    assert.ok(t?.url, 'QR manquant');
    secret = new URL(t.url).pathname.split('/').pop();
    token = (await request('/api/join', { table: id, access: secret, name: 'Recette Suivant' })).token;
    for (const song of titles.slice(0, 5)) await request('/api/table/song', { table: id, access: secret,
      personId: (await request(`/api/state?token=${token}`)).me.id, song, mode: 'append' });
    mark('Liste de cinq titres sur un seul téléphone', titles.slice(0, 5).map(s => s.title));
    const sentIds = new Set();
    for (let i = 0; i < 5; i++) {
      const current = await until(async () => {
        const s = await request('/api/staff/state');
        return s.tracked.find(x => x.title === titles[i].title && !x.startedAt) &&
          s.kf.queue.some(x => x.songId === titles[i].songId) ? s : null;
      }, 18000);
      assert.equal(current.settings.auto, true, 'L’envoi automatique ne doit pas se désactiver');
      assert.equal(current.queue[0]?.title, titles[i].title, 'La page doit suivre KaraFun');
      const qid = current.kf.queue.find(x => x.songId === titles[i].songId).queueId;
      assert.ok(!sentIds.has(qid), 'Un même UUID est rejoué');
      sentIds.add(qid);
      await request('/api/staff/kf', { action: 'next' });
      mark(`Suivant ${i + 1}/5`, titles[i].title);
    }
    await until(async () => {
      const s = await request('/api/staff/state');
      return s.kf.queue.length === 0 && s.tracked.length === 0 && !s.pending ? s : null;
    });
    await sleep(5000); // détecte la réinsertion en boucle observée dans le bar
    let end = await request('/api/staff/state');
    const me = (await request(`/api/state?token=${token}`)).me;
    assert.equal(end.kf.queue.length, 0, 'KaraFun a reçu une chanson à nouveau');
    assert.equal(end.queue.length, 0, 'La file publique annonce encore une chanson');
    assert.equal(end.tracked.length, 0);
    assert.equal(end.pending, null);
    assert.equal(me.pos, null, 'Faux rang public sans chanson');
    assert.equal(me.eta, null, 'Fausse heure sans chanson');
    assert.deepEqual(me.songs, [], 'La liste devrait être consommée');
    assert.equal(end.settings.auto, true, 'L’envoi automatique doit rester coché après cinq Suivant');
    mark('Après cinq Suivant : aucune réinsertion et aucun faux rang', 'observation 5 s');

    await request('/api/table/song', { table: id, access: secret, personId: me.id,
      song: titles[5], mode: 'append' });
    end = await until(async () => {
      const s = await request('/api/staff/state');
      return s.kf.queue.some(x => x.songId === titles[5].songId) &&
        s.tracked.some(x => x.title === titles[5].title) ? s : null;
    }, 18000);
    assert.equal(end.queue[0]?.title, titles[5].title);
    assert.equal(end.settings.auto, true);
    mark('Nouveau titre après file vide : KaraFun et page à jour', titles[5].title);
    await request('/api/staff/kf', { action: 'next' });
    await until(async () => (await request('/api/staff/state')).kf.queue.length === 0);
  } finally {
    await request('/api/staff/settings', { auto: false });
    const s = await request('/api/staff/state');
    for (const item of s.kf.queue.filter(x => x.singer?.includes(id))) {
      await request('/api/staff/kf', { action: 'remove', queueId: item.queueId });
    }
    await request('/api/staff/table-left', { id });
    await request('/api/staff/settings', { auto: initial.settings.auto, autoPlay: initial.settings.autoPlay });
  }
}
main().then(() => { report.finishedAt = new Date().toISOString(); report.ok = true; })
  .catch(error => { report.finishedAt = new Date().toISOString(); report.ok = false; report.error = error.stack; console.error('FAIL', error); process.exitCode = 1; })
  .finally(() => {
    const file = path.join(__dirname, '..', 'journal', `recette-skip-reel-${report.startedAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log('Rapport :', file);
  });
