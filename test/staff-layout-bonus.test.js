'use strict';
// Regression: relecture (passe 4) — l'écran « Repères » de la page du bar
// écrivait la phrase complète du bonus (jusqu'à 170 caractères) sous le nom
// de chaque personne qui en a un, et sous chaque personne d'une table qui en
// a un : dans la colonne étroite du nom, la ligne devenait deux à trois fois
// plus haute (86 px, 222 px avec le bonus de la table) et la même phrase se
// répétait pour toute la table ; la liste, bornée à 560 px, montrait environ
// 2,5 personnes au lieu de 6.
// Attendu : une étiquette courte sur la ligne d'une personne qui a son propre
// bonus (la phrase complète au survol, comme dans le menu du bonus), rien de
// plus pour le bonus de la table, dont la phrase s'écrit une seule fois, sous
// le nom de la table.
// Le DOM simulé de staff-ui-coverage.test.js ne calcule pas la mise en page :
// un vrai navigateur mesure ici, au téléphone (360 et 390 px) et sur PC. La
// page est servie sans serveur (routes interceptées), avec une salle
// factice : aucune démo, aucun KaraFun. Il faut Playwright et son Chromium
// (playwright-browser.js) : sans eux, le test est ignoré.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPlaywright, skipped } = require('./playwright-browser');

const root = path.join(__dirname, '..');
const BASE = 'http://bar.test';
const KEY = '123456'; // clé factice du bar

function world() {
  const person = (id, name, tableId, bonus = 0) => ({ id, name, tableId, active: true, songCount: 1, sung: 0, bonus });
  return {
    now: Date.now(), code: KEY, karafun: { connected: true, ready: true, demo: true },
    kf: { ready: true, connected: true, base: 'demo', code: KEY, queue: [], username: 'FileKaraoke', events: [] },
    settings: { gap: 4, cap: 2, requirePresence: false, pushDelaySec: 10, playDelaySec: 8, auto: true, autoPlay: false,
      tableRotation: false, weightedTables: false },
    tables: [{ id: 'T12', name: 'Table 12', headcount: 4, activeCount: 2, count: 2, bonus: 0 },
      { id: 'T4', name: 'Table 4', headcount: 4, activeCount: 3, count: 3, bonus: 1 }],
    people: [person('zoe', 'Zoé', 'T12'), person('bea', 'Bea', 'T12', 3),
      person('ines', 'Inès', 'T4'), person('maud', 'Maud', 'T4'), person('max', 'Max', 'T4', 3)],
    stage: null, next: null, tracked: [], ips: [], blocked: [], log: [], manualChanges: [], soloInvitations: [],
    presencePending: [], bootId: 'boot-1', restarting: false, closing: null, phoneBase: 'http://192.168.1.20:3000',
    port: 3000, avgSlotMin: 4.5, battle: { phase: 'idle' }, spotify: null, queue: [],
  };
}

const measure = page => page.evaluate(() => {
  const rows = Object.fromEntries([...document.querySelectorAll('#identityBody .identity-row')].map(row => {
    const help = row.querySelector('[data-person-bonus-help]');
    return [row.dataset.identityPerson, { h: Math.round(row.getBoundingClientRect().height),
      help: help ? { text: help.textContent, title: help.title } : null }];
  }));
  const tables = [...document.querySelectorAll('#identityBody .identity-group')].map(group => ({
    name: group.querySelector('h4').firstChild.textContent.trim(),
    help: [...group.querySelectorAll('[data-table-bonus-help]')].map(node => node.textContent) }));
  const repeated = [...document.querySelectorAll('#identityBody *')].filter(node => node.children.length === 0 &&
    /chaque personne de la table|avec le bonus de la table/.test(node.textContent)).length;
  return { rows, tables, repeated, scroll: document.documentElement.scrollWidth, innerWidth };
});

(async () => {
  const chromium = loadPlaywright();
  if (!chromium) { skipped('Bonus dans « Repères » de la page du bar en navigateur'); return; }
  const html = fs.readFileSync(path.join(root, 'public', 'staff.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'app.css'), 'utf8');
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [[360, 740], [390, 844], [1366, 900]]) {
      const phone = width < 700;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
      const page = await context.newPage();
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/staff') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        if (url.pathname === '/app.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: css });
        if (url.pathname === '/api/staff/state') return route.fulfill({ json: world() });
        return route.fulfill({ status: url.pathname.startsWith('/api/') ? 200 : 404, json: { ok: true } });
      });
      await page.goto(`${BASE}/staff?key=${KEY}#reperes`);
      await page.waitForSelector('#identityBody [data-identity-person="max"]');
      const box = await measure(page);
      const at = `${width} px`;
      const { rows } = box;
      // Bonus de la table seulement : la ligne garde la hauteur d'une ligne sans bonus.
      for (const id of ['ines', 'maud']) {
        assert.ok(rows[id].h <= rows.zoe.h + 2, `${at} : bonus de la table, ligne compacte (${id} ${rows[id].h} px contre ${rows.zoe.h} : ${JSON.stringify(box)})`);
        assert.equal(rows[id].help, null, `${at} : rien sous ${id}, la table le dit une fois`);
      }
      // Bonus personnel : une étiquette courte, au plus une ligne de plus ;
      // la phrase complète au survol.
      for (const id of ['bea', 'max']) {
        assert.ok(rows[id].h <= rows.zoe.h + 20, `${at} : bonus personnel, ligne compacte (${id} ${rows[id].h} px contre ${rows.zoe.h} : ${JSON.stringify(box)})`);
        assert.ok(rows[id].help.text.length <= 24, `${at} : étiquette courte (${JSON.stringify(rows[id].help)})`);
      }
      assert.equal(rows.bea.help.text, 'Bonus +3');
      assert.equal(rows.bea.help.title, '+3 : passe environ deux fois plus souvent ; passages en plus répartis dans le tour, après les premiers passages des nouveaux.');
      assert.equal(rows.max.help.text, 'Bonus +3 · table +1');
      assert.match(rows.max.help.title, /^\+3, avec le bonus de la table \(\+1\) : passe environ deux fois plus souvent \(pas plus de deux passages par tour\)/);
      // La phrase du bonus de la table, une seule fois, sous son nom.
      assert.deepEqual(box.tables, [{ name: 'Table 12', help: [] }, { name: 'Table 4', help: [
        'Bonus de la table +1 : chaque personne de la table passe un peu plus souvent (environ 5 passages pour 4) ; passages en plus répartis dans le tour, après les premiers passages des nouveaux.'] }]);
      assert.equal(box.repeated, 1, `${at} : phrase de la table écrite une fois (${JSON.stringify(box)})`);
      assert.ok(box.scroll <= width, `${at} : pas de défilement horizontal (${box.scroll} px)`);
      await context.close();
      console.log(`ok - bonus dans « Repères » à ${at} : lignes compactes, phrase de la table écrite une fois`);
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
