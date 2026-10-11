'use strict';
// Barre de lecture (lot F) sur la démo complète : faux KaraFun, chansons de
// --song-seconds secondes. La barre atteint 100 % à la durée du titre, et
// « Relancer depuis le début » repart de zéro. Lancé par run-offline.js.
const assert = require('node:assert/strict');
const { staffRoute } = require('./staff-auth');
const BASE = process.env.BASE || 'http://127.0.0.1:3118';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(path, body) {
  const response = await fetch(BASE + await staffRoute(BASE, path), body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${value.error || response.status}`);
  return value;
}
async function until(what, check, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Délai dépassé : ${what}`);
    await sleep(200);
  }
}

(async () => {
  await request('/api/staff/settings', { auto: true, autoPlay: false });
  await request('/api/staff/table', { id: 'scene', headcount: 4 });
  const staff = await request('/api/staff/state');
  const access = new URL(staff.tables.find(t => t.id === 'scene').url).pathname.split('/').pop();
  const body = fields => ({ table: 'scene', access, ...fields });
  // La recherche relayée donne 200 s (catalogue du faux KaraFun) : la démo
  // joue pourtant --song-seconds, qui fait foi.
  const [found] = await request('/api/search?' + new URLSearchParams({ q: 'Toxic' }));
  assert.equal(found.duration, 200);
  const lea = await request('/api/table/person', body({ name: 'Léa' }));
  await request('/api/table/song', body({ personId: lea.id, token: lea.token, song: { ...found, duration: 99999 } }));

  const first = await until('titre sur scène', async () => (await request('/api/staff/state')).stage?.progress ? await request('/api/staff/state') : null);
  const songSeconds = first.stage.progress.durationSec;
  assert.ok(songSeconds >= 6 && songSeconds <= 12, `durée de la démo (--song-seconds) : ${songSeconds}`);
  assert.equal(first.stage.progress.paused, false);
  assert.ok(first.stage.progress.elapsedSec < 3, `départ proche de zéro : ${first.stage.progress.elapsedSec}`);
  const phone = await request('/api/state?' + new URLSearchParams({ table: 'scene', access }));
  assert.equal(phone.stage.progress.durationSec, songSeconds, 'les téléphones reçoivent la même durée');
  assert.ok(Number.isFinite(phone.now), 'heure du serveur pour corriger l’horloge des téléphones');

  // « Relancer depuis le début » : la copie repart de zéro.
  await sleep(2500);
  const before = (await request('/api/staff/state')).stage;
  assert.ok(before.progress.elapsedSec >= 2, `le temps avance : ${before.progress.elapsedSec}`);
  await request('/api/staff/kf', { action: 'restart' });
  const copy = await until('copie relancée sur scène', async () => {
    const s = await request('/api/staff/state');
    return s.stage && s.stage.queueId !== before.queueId && s.stage.progress ? s : null;
  }, 15000);
  assert.ok(copy.stage.progress.elapsedSec < 2, `la copie repart de zéro : ${copy.stage.progress.elapsedSec}`);

  // Jusqu'à la fin du titre : le temps écoulé atteint la durée (barre à 100 %).
  let last = copy.stage.progress.elapsedSec;
  for (;;) {
    const s = await request('/api/staff/state');
    if (s.stage?.queueId !== copy.stage.queueId) break;
    assert.ok(s.stage.progress.elapsedSec >= last, 'le temps ne recule jamais pendant le titre');
    last = s.stage.progress.elapsedSec;
    await sleep(150);
  }
  assert.ok(last >= songSeconds - 1 && last <= songSeconds + 1, `fin du titre à ${last} s pour ${songSeconds} s`);
  console.log(`OK barre de lecture en démo : ${songSeconds} s, relance à zéro, fin à ${last} s`);
})().catch(error => { console.error(error); process.exitCode = 1; });
