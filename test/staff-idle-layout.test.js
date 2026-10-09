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
// (installation locale ou globale de npm) : sans eux, le test est ignoré, avec
// une annotation dans la CI (playwright-browser.js).
const assert = require('node:assert/strict');
const { staffRoute } = require('./staff-auth');
const { loadPlaywright, skipped } = require('./playwright-browser');
const BASE = process.env.BASE || 'http://127.0.0.1:3114';
const MIN = 60000;


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
// jamais revenu depuis l'ouverture de son QR, Noé actif, et trois duos. Le
// titre de Noé et Zoé dépasse la durée maximale (5:00) : repère « trop long ».
// Restent trois lignes de soliste inactif (Marie-Charlotte, Bob, Zoé) : le
// titre de Bob est trop long lui aussi, celui de Zoé non.
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
    if (first === 'Noé') line.tooLongSec = 372;
  }
  state.queue.find(q => q.ids?.length === 1 && q.ids[0] === by('Bob').id).tooLongSec = 400;
  state.tooLong = { limitSec: 300, count: 2 };
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
      song: box(row.querySelector('.song-cell')),
      tags: box(row.querySelector('.queue-tags')),
      tooLong: row.querySelector('.too-long-tag') ? box(row.querySelector('.too-long-tag')) : null,
      who: [...row.querySelectorAll('.idle-tag .idle-who')].map(box),
      for: [...row.querySelectorAll('.idle-tag .idle-for')].map(box),
    })),
  };
});

const inside = (part, cell) => part.width > 0 && part.left >= cell.left - 0.5 && part.right <= cell.right + 0.5
  && part.top >= cell.top - 0.5 && part.bottom <= cell.bottom + 0.5;

(async () => {
  const chromium = loadPlaywright();
  if (!chromium) { skipped('Repères « inactif » de la file en navigateur'); return; }
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
      // Regression: U1 (seconde relecture) — sur PC, « plus long que 5:00 »,
      // dernier badge de .queue-tags, était coupé à « p » ; le repère court était
      // caché au-delà de 650 px. Un seul repère, entier, au début du titre.
      const long = rows.filter(row => row.tooLong);
      assert.deepEqual(long.map(row => row.who.length).sort(), [0, 1], `${at} : deux titres trop longs, d'un duo et de Bob`);
      for (const row of long) {
        assert.ok(row.tooLong.width > 0 && row.tooLong.scroll <= row.tooLong.client + 1, `${at} : « trop long » visible et entier (${JSON.stringify(row.tooLong)})`);
        assert.ok(inside(row.tooLong, row.song), `${at} : « trop long » dans la cellule du titre`);
        assert.ok(row.tooLong.left - row.song.left < 2, `${at} : « trop long » au début du titre`);
      }
      // Regression: U1 (vérification de la seconde relecture) — sur une ligne de
      // soliste inactif, .queue-tags (et la durée) prenaient la place du nom :
      // « Bob » réduit à « B » à 360 et 1366 px, avec ou sans « trop long ».
      const solos = rows.filter(row => !row.who.length);
      assert.deepEqual(solos.map(row => row.name.text).sort(), ['Bob', 'Marie-Charlotte Vanden', 'Zoé'], `${at} : trois solistes inactifs`);
      for (const row of solos) {
        const label = `${at}, soliste ${row.name.text}${row.tooLong ? ' (trop long)' : ''}`;
        assert.ok(inside(row.name, row.cell), `${label} : nom hors de la cellule`);
        if (row.name.text.length <= 8) assert.ok(row.name.scroll <= row.name.client + 1, `${label} : nom coupé à ${Math.round(row.name.width)} px (${JSON.stringify(row.name)})`);
        else assert.ok(row.name.width >= 40, `${label} : nom réduit à ${Math.round(row.name.width)} px`);
      }
      // Sur PC, les badges d'une ligne avec repère ont leur propre ligne, entiers.
      if (!phone) for (const row of rows) assert.ok(row.tags.width >= row.cell.width - 1, `${at}, ${row.name.text} : badges réduits à ${Math.round(row.tags.width)} px`);
      for (const row of duos) {
        const label = `${at}, duo ${row.name.text}`;
        assert.ok(row.name.width >= 40, `${label} : nom du duo réduit à ${Math.round(row.name.width)} px`);
        // Regression: U2 (seconde relecture) — dans la cellule qui passe à la
        // ligne, le nom seul sur sa ligne restait borné à 45 % et coupé.
        if (row.name.scroll > row.name.client + 1) assert.ok(row.name.width >= row.cell.width - 1, `${label} : nom coupé à ${Math.round(row.name.width)} px sur ${Math.round(row.cell.width)}`);
        for (const who of row.who) {
          assert.ok(inside(who, row.cell), `${label} : « ${who.text} » hors de la cellule`);
          // Un prénom court reste entier ; un prénom plus long que la colonne garde sa première partie.
          if (who.text.length <= 8) assert.ok(who.scroll <= who.client + 1, `${label} : « ${who.text} » abrégé (${JSON.stringify(who)})`);
          else assert.ok(who.width >= 40, `${label} : « ${who.text} » réduit à ${Math.round(who.width)} px`);
        }
      }
      if (phone) {
        // Regression: U5 (seconde relecture) — « Envoi et lecture automatiques
        // coupés » (bouton de la Scène) faisait moins de 44 px au téléphone.
        await page.locator('[data-tab-btn="scene"]').tap();
        const warn = await page.locator('#autoWarn').boundingBox();
        assert.ok(warn && warn.height >= 44, `${at} : pastille « automatiques coupés » de ${warn?.height} px`);
        // Regression: U4 (seconde relecture) — le disque des initiales de
        // « Solistes » avait le fond du panneau : invisible. Vérification : un
        // fond à peine différent (1,10:1) ne suffit pas ; le contour du disque
        // doit se voir sur le panneau (contraste d'au moins 2:1).
        await page.locator('[data-tab-btn="accueil"]').tap();
        await page.waitForSelector('#soloistList .soloist-row .identity-photo');
        const disc = await page.evaluate(() => {
          const style = getComputedStyle(document.querySelector('#soloistList .soloist-row .identity-photo'));
          const panel = getComputedStyle(document.querySelector('#soloistList').closest('.solo-invite-panel')).backgroundColor;
          const rgba = text => { const [r, g, b, a = 1] = text.match(/[\d.]+/g).map(Number); return { r, g, b, a }; };
          const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a) });
          const lum = c => [c.r, c.g, c.b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
          const ratio = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((m, n) => n - m); return (hi + 0.05) / (lo + 0.05); };
          const under = rgba(panel);
          const edge = parseFloat(style.borderTopWidth) > 0 ? over(rgba(style.borderTopColor), under) : over(rgba(style.backgroundColor), under);
          return { border: style.borderTopWidth, contrast: ratio(edge, under) };
        });
        assert.ok(disc.contrast >= 2, `${at} : bord du disque des initiales visible sur le panneau (${JSON.stringify(disc)})`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log('Repères « inactif » des solistes et des duos, « trop long » en navigateur : prénoms, noms, durées et badges entiers à 360, 390 et 1366 px, pastille de 44 px et contour du disque des solistes visible OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
