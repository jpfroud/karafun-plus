'use strict';
// Regression: troisième relecture finale (RT3) — la fenêtre de prénom
// (.name-gate : fixe, défilante, contenu centré par align-items: center)
// coupait son haut quand le panneau dépassait l'écran : à l'étape « Récupérer
// mes chansons » avec 5 prénoms à 390x664, 4 à 375x560 ou 6 à 640x360, le
// choix FR/EN et le titre étaient hors d'atteinte, même en remontant.
// Attendu : centrée quand elle tient, défilante depuis le haut sinon.
//
// Le DOM simulé de client-ui-coverage.test.js ne calcule pas la mise en page :
// seul un vrai navigateur mesure ces positions. Aucun serveur ni port : la
// vraie page (client.html, app.css, client-i18n.js) est servie par Playwright,
// avec un état de « Solo 3 » encore sans prénom et six reprises proposées.
// Sans Playwright ou son Chromium, le test est ignoré (playwright-browser.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPlaywright, skipped } = require('./playwright-browser');

const root = path.join(__dirname, '..');
const ORIGIN = 'http://karaoke.test';
const FILES = { '/t/Comptoir/secret': ['client.html', 'text/html'], '/app.css': ['app.css', 'text/css'],
  '/client-i18n.js': ['client-i18n.js', 'text/javascript'] };
const NAMES = ['Marie', 'Léa', 'Maximilien-Alexandre', 'Noé', 'Zoé', 'Bob'];

const stateOf = candidates => ({
  table: { id: 'Comptoir', name: 'En solo', individual: true, count: 9 },
  tablePeople: [{ id: 's3', name: 'Solo 3', nameRequired: true, viaEvent: true, active: true, songs: [], invites: [],
    inKaraFun: [], joinRequests: [], sentJoinRequests: [], canDefer: false, deferral: null }],
  managedIds: ['s3'], people: [], queue: [], waiting: [], closing: null,
  recoveryPeople: NAMES.slice(0, candidates).map((name, i) => ({ id: `p${i}`, name })),
  battle: { phase: 'idle', eligiblePersonIds: [], votedPersonIds: [], minVoters: 2, registered: 4 },
  catalogAvailable: true, stage: null, next: null, rules: {},
});

const measure = page => page.evaluate(() => {
  const gate = document.getElementById('nameGate');
  gate.scrollTop = 0;
  const top = el => el.getBoundingClientRect().top;
  const panel = gate.querySelector('.name-gate-panel').getBoundingClientRect();
  const lang = document.getElementById('nameGateLang').getBoundingClientRect();
  return { lang: lang.top, langBottom: lang.bottom, title: top(document.getElementById('nameGateTitle')),
    panelTop: panel.top, panelBottom: panel.bottom, height: innerHeight, scrolls: gate.scrollHeight > gate.clientHeight };
});

(async () => {
  const chromium = loadPlaywright();
  if (!chromium) { skipped('Fenêtre de prénom en navigateur'); return; }
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [[320, 568], [375, 560], [390, 664], [640, 360]]) {
      for (const candidates of [6, 0]) {
        const at = `${width}x${height}, ${candidates} prénom(s)`;
        const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
        const page = await context.newPage();
        await page.route(`${ORIGIN}/**`, route => {
          const url = new URL(route.request().url());
          const file = FILES[url.pathname];
          if (file) return route.fulfill({ contentType: `${file[1]}; charset=utf-8`, body: fs.readFileSync(path.join(root, 'public', file[0])) });
          if (url.pathname === '/api/state') return route.fulfill({ json: stateOf(candidates) });
          return route.fulfill({ json: { ok: true } });
        });
        await page.goto(`${ORIGIN}/t/Comptoir/secret`);
        await page.waitForSelector('#nameGate:not([hidden])');
        if (candidates) {
          // « Déjà inscrit ? J'ai un code » : le choix du prénom, panneau plus haut que l'écran.
          await page.locator('#nameGateClaimLink').click();
          await page.waitForFunction(n => document.querySelectorAll('[data-gate-claim-person]').length === n, candidates);
          const box = await measure(page);
          assert.ok(box.scrolls, `${at} : le panneau dépasse l'écran (${JSON.stringify(box)})`);
          assert.ok(box.lang >= 0, `${at} : FR/EN atteignable en haut (${JSON.stringify(box)})`);
          assert.ok(box.title >= 0, `${at} : titre atteignable en haut (${JSON.stringify(box)})`);
          // Le choix de langue se touche vraiment : la page passe en anglais.
          await page.locator('#nameGateLang [data-lang="en"]').click();
          assert.equal(await page.locator('#nameGateLang [data-lang="en"]').getAttribute('aria-pressed'), 'true', `${at} : EN choisi`);
          // Tout en bas, le dernier prénom et « Retour » restent atteignables.
          const end = await page.evaluate(() => {
            const gate = document.getElementById('nameGate');
            gate.scrollTop = gate.scrollHeight;
            return document.querySelector('[data-gate-claim-back]').getBoundingClientRect().bottom <= innerHeight + 0.5;
          });
          assert.ok(end, `${at} : « Retour » atteignable en bas`);
        } else {
          // Panneau court (prénom à saisir) : centré verticalement, comme avant.
          const box = await measure(page);
          if (box.panelBottom - box.panelTop < box.height - 40) {
            const above = box.panelTop, below = box.height - box.panelBottom;
            assert.ok(Math.abs(above - below) <= 2, `${at} : panneau centré (${JSON.stringify(box)})`);
          }
          assert.ok(box.lang >= 0 && box.title >= 0, `${at} : FR/EN et titre visibles (${JSON.stringify(box)})`);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log('Fenêtre de prénom en navigateur : FR/EN et titre atteignables avec six reprises à 320x568, 375x560, 390x664 et 640x360, panneau court centré OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
