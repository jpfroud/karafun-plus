'use strict';
// Regression: D15-A (vérification de la relecture finale) — sur la file du bar,
// un duo dont un ou deux solistes sont sans nouvelles :
//  - les deux partenaires inactifs : à 390 px (et à 1366 px), le nom du duo et
//    les deux prénoms (« Marie… : », « Léa : ») tombaient à 0 px et la seconde
//    durée « inactif 52 min » était coupée de 8 à 13 px ;
//  - un seul partenaire inactif : à 390 px, « Léa : » devenait « L. ».
// Le DOM simulé de staff-ui-coverage.test.js ne calcule pas la mise en page, et
// staff-layout.regression-2.test.js ne rejoue que la cascade : seul un vrai
// navigateur mesure ces largeurs. La page du bar reçoit ici un état réel de la
// démo, avancé de 65 minutes et regroupé en duos.
//
// Lancé par run-offline.js sur la démo. Il faut Playwright et son Chromium
// (installation locale ou globale de npm) : sans eux, le test est ignoré.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { staffRoute } = require('./staff-auth');
const BASE = process.env.BASE || 'http://127.0.0.1:3114';
const MIN = 60000;

function loadPlaywright() {
  for (const where of ['playwright', path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'playwright')]) {
    try {
      const { chromium } = require(where);
      if (fs.existsSync(chromium.executablePath())) return chromium;
    } catch (_) { /* absent ici */ }
  }
  return null;
}

async function request(route, body, cookie = '') {
  const response = await fetch(BASE + await staffRoute(BASE, route), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route}: ${value.error || response.status}`);
  return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}

// Six solistes du comptoir, chacun avec un titre.
const NAMES = ['Marie-Charlotte Vanden', 'Léa', 'Bob', 'Maximilien-Alexandre B.', 'Noé', 'Zoé'];
// Duos : deux partenaires inactifs (prénom long puis court, puis l'inverse avec
// « inactif depuis 21:04 », le repère le plus long), et un seul partenaire
// inactif, le second.
const DUOS = [['Léa', 'Marie-Charlotte Vanden'], ['Maximilien-Alexandre B.', 'Bob'], ['Noé', 'Zoé']];

// Réponse de /api/staff/state : 65 min plus tard, Léa et Zoé à 52 min, Bob
// jamais revenu depuis l'ouverture de son QR, Noé actif, et trois duos.
function reshape(state) {
  state.now += 65 * MIN;
  const by = name => state.people.find(p => p.name === name && p.tableId === 'Comptoir');
  for (const name of NAMES) Object.assign(by(name), { joinedAt: state.now - 80 * MIN, lastActiveAt: state.now - 65 * MIN });
  by('Léa').lastActiveAt = by('Zoé').lastActiveAt = state.now - 52 * MIN;
  Object.assign(by('Bob'), { joinedAt: state.now - 50 * MIN, lastActiveAt: state.now - 50 * MIN });
  by('Noé').lastActiveAt = state.now;
  for (const [first, second] of DUOS) {
    const [a, b] = [by(first), by(second)];
    const line = state.queue.find(q => q.ids?.length === 1 && q.ids[0] === a.id);
    line.ids = [a.id, b.id];
    line.singers = [a, b].map(p => ({ id: p.id, name: p.name, table: 'En solo', individual: true }));
    line.name = line.singer = `${a.name} & ${b.name}`;
  }
  return state;
}

// Boîtes de la cellule « chanteur » de chaque ligne qui porte un repère.
const measure = page => page.evaluate(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, scroll: el.scrollWidth, client: el.clientWidth, text: el.textContent }; };
  return {
    overflow: document.documentElement.scrollWidth - innerWidth,
    rows: [...document.querySelectorAll('#qBody .queue-item')].filter(row => row.querySelector('.idle-tag')).map(row => ({
      cell: box(row.querySelector('.person-cell')),
      name: box(row.querySelector('.person')),
      who: [...row.querySelectorAll('.idle-tag .idle-who')].map(box),
      for: [...row.querySelectorAll('.idle-tag .idle-for')].map(box),
    })),
  };
});

const inside = (part, cell) => part.width > 0 && part.left >= cell.left - 0.5 && part.right <= cell.right + 0.5
  && part.top >= cell.top - 0.5 && part.bottom <= cell.bottom + 0.5;

(async () => {
  const chromium = loadPlaywright();
  if (!chromium) { console.log('Repères « inactif » de la file en navigateur : ignoré (Playwright ou Chromium absent)'); return; }
  await request('/api/staff/settings', { auto: false });
  const tables = (await request('/api/staff/state')).value.tables;
  const access = new URL(tables.find(t => t.id === 'Comptoir').url).pathname.split('/').pop();
  const songs = [];
  for (const q of ['Queen', 'the', 'a', 'o']) for (const song of (await request(`/api/search?q=${q}`)).value) if (!songs.some(s => s.songId === song.songId)) songs.push(song);
  assert.ok(songs.length >= NAMES.length, `catalogue de démo : ${songs.length} titres`);
  // Relancé sur une démo déjà utilisée : les solistes déjà inscrits avec un titre servent tels quels.
  const before = (await request('/api/staff/state')).value;
  for (const [i, name] of NAMES.entries()) {
    const known = before.people.find(p => p.name === name && p.tableId === 'Comptoir');
    if (known && before.queue.some(q => q.ids?.length === 1 && q.ids[0] === known.id)) continue;
    const invitation = new URL((await request('/api/staff/solo-invite', { tableId: 'Comptoir' })).value.url).searchParams.get('invitation');
    const opened = await request('/api/table/solo/open', { table: 'Comptoir', access, invitation });
    const own = { table: 'Comptoir', access, personId: opened.value.id, token: opened.value.token };
    await request('/api/table/person/rename', { ...own, name }, opened.cookie);
    await request('/api/table/song', { ...own, song: songs[i] }, opened.cookie);
  }
  const staff = BASE + await staffRoute(BASE, '/staff');
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [[390, 844], [360, 740], [1366, 900]]) {
      const phone = width < 700;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
      const page = await context.newPage();
      await page.route('**/api/staff/state**', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: reshape(await response.json()) });
      });
      await page.goto(staff + '#file');
      if (phone) await page.locator('[data-tab-btn="file"]').tap();
      await page.waitForFunction(() => document.querySelectorAll('#qBody .idle-tag .idle-who').length === 5);
      const { overflow, rows } = await measure(page);
      const at = `${width} px`;
      assert.equal(overflow, 0, `${at} : pas de défilement horizontal`);
      const duos = rows.filter(row => row.who.length);
      assert.deepEqual(duos.map(row => row.who.length), [2, 2, 1], `${at} : trois duos avec repère`);
      for (const row of rows) {
        const label = `${at}, ${row.name.text}`;
        // La durée est toujours entière et visible dans la cellule.
        for (const part of row.for) {
          assert.ok(part.scroll <= part.client + 1, `${label} : « ${part.text} » coupé (${JSON.stringify(part)})`);
          assert.ok(inside(part, row.cell), `${label} : « ${part.text} » hors de la cellule (${JSON.stringify({ part, cell: row.cell })})`);
        }
      }
      for (const row of duos) {
        const label = `${at}, duo ${row.name.text}`;
        assert.ok(row.name.width >= 40, `${label} : nom du duo réduit à ${Math.round(row.name.width)} px`);
        for (const who of row.who) {
          assert.ok(inside(who, row.cell), `${label} : « ${who.text} » hors de la cellule`);
          // Un prénom court reste entier ; un prénom plus long que la colonne garde sa première partie.
          if (who.text.length <= 8) assert.ok(who.scroll <= who.client + 1, `${label} : « ${who.text} » abrégé (${JSON.stringify(who)})`);
          else assert.ok(who.width >= 40, `${label} : « ${who.text} » réduit à ${Math.round(who.width)} px`);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log('Repères « inactif » des duos en navigateur : prénoms et durées entiers à 360, 390 et 1366 px OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
