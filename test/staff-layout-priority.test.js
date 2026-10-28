'use strict';
// « Priorité » avant un titre déjà chargé dans KaraFun : la question est une
// fenêtre de la page (trois choix) au lieu d'un confirm() du navigateur, dont
// « Annuler » changeait la file. Le DOM simulé de staff-ui-coverage.test.js ne
// calcule pas la mise en page : un vrai navigateur mesure ici, au téléphone
// (360 et 390 px) et sur PC, que la fenêtre tient dans l'écran et que son
// titre, son texte et ses trois boutons se lisent en entier, titre de chanson
// long compris, puis qu'« Annuler » la ferme sans rien envoyer.
// La page est servie sans serveur (routes interceptées), avec une file
// factice : aucune démo, aucun KaraFun. Il faut Playwright et son Chromium
// (playwright-browser.js) : sans eux, le test est ignoré.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPlaywright, skipped } = require('./playwright-browser');

const root = path.join(__dirname, '..');
const BASE = 'http://bar.test';
const KEY = '123456'; // clé factice du bar
const LOADED = 'Bohemian Rhapsody (version longue remasterisée, enregistrée en public)';

function world() {
  const line = (id, name, pos, title) => ({ source: 'helper', ours: true, id, ids: [id], pos, name, singer: name,
    table: 'En solo', title, song: { title, artist: 'Groupe', entryId: `e-${id}` }, eta: Date.now() + pos * 240000 });
  return {
    now: Date.now(), code: KEY, karafun: { connected: true, ready: true, demo: true },
    kf: { ready: true, connected: true, base: 'demo', code: KEY, queue: [], username: 'FileKaraoke', events: [] },
    settings: { gap: 4, cap: 2, requirePresence: false, pushDelaySec: 10, playDelaySec: 8, auto: true, autoPlay: false,
      tableRotation: false, weightedTables: false },
    tables: [{ id: 'Comptoir', name: 'En solo', individual: true, headcount: 40, activeCount: 3, count: 3 }],
    people: ['lea', 'max', 'zoe'].map(id => ({ id, name: id === 'lea' ? 'Léa' : id === 'max' ? 'Maximilien-Alexandre' : 'Zoé',
      tableId: 'Comptoir', active: true, songCount: 1, sung: 0 })),
    stage: null, next: null, tracked: [], ips: [], blocked: [], log: [], manualChanges: [], soloInvitations: [],
    presencePending: [], bootId: 'boot-1', restarting: false, closing: null, phoneBase: 'http://192.168.1.20:3000',
    port: 3000, avgSlotMin: 4.5, battle: { phase: 'idle' }, spotify: null,
    queue: [
      { source: 'karafun', ours: true, queueId: 'kf-9', pos: 1, singer: 'Léa', name: 'Léa', ids: ['lea'], title: LOADED,
        song: { title: LOADED, artist: 'Queen' }, eta: Date.now() },
      line('zoe', 'Zoé', 2, 'Valse'),
      line('max', 'Maximilien-Alexandre', 3, 'Rock'),
    ],
    priorityPull: { queueId: 'kf-9', title: LOADED, name: 'Léa', ids: ['lea'], lineIds: ['zoe', 'max'] },
  };
}

const measure = page => page.evaluate(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
    width: r.width, height: r.height, scroll: el.scrollWidth, client: el.clientWidth, text: el.textContent, hidden: el.hidden }; };
  const dialog = document.getElementById('priorityDialog');
  return { innerWidth, innerHeight, dialog: box(dialog),
    parts: ['priorityTitle', 'priorityHelp', 'priorityBefore', 'priorityAfter', 'priorityCancel'].map(id => box(document.getElementById(id))) };
});

(async () => {
  const chromium = loadPlaywright();
  if (!chromium) { skipped('Question « Priorité » de la page du bar en navigateur'); return; }
  const html = fs.readFileSync(path.join(root, 'public', 'staff.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'app.css'), 'utf8');
  const browser = await chromium.launch();
  try {
    for (const [width, height] of [[360, 740], [390, 844], [1366, 900]]) {
      const phone = width < 700;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
      const page = await context.newPage();
      const moves = [];
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/staff') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        if (url.pathname === '/app.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: css });
        if (url.pathname === '/api/staff/state') return route.fulfill({ json: world() });
        if (url.pathname === '/api/staff/move') moves.push(route.request().postDataJSON());
        return route.fulfill({ status: url.pathname.startsWith('/api/') ? 200 : 404, json: { ok: true } });
      });
      await page.goto(`${BASE}/staff?key=${KEY}#file`);
      await page.waitForSelector('#qBody [data-urgent="max"]', { state: 'attached' });
      // Au téléphone, « Priorité » est dans le menu ⋯ de la ligne.
      const menu = page.locator('#qBody .queue-item:has([data-urgent="max"]) [data-row-menu]');
      if (await menu.isVisible()) await menu.click();
      await page.locator('#qBody [data-urgent="max"]').click();
      await page.waitForSelector('#priorityDialog[open]');
      const { innerWidth, innerHeight, dialog, parts } = await measure(page);
      const at = `${width} px`;
      assert.ok(dialog.left >= 0 && dialog.right <= innerWidth, `${at} : la fenêtre tient dans la largeur (${JSON.stringify(dialog)})`);
      assert.ok(dialog.top >= 0 && dialog.bottom <= innerHeight, `${at} : la fenêtre tient dans la hauteur (${JSON.stringify(dialog)})`);
      assert.ok(dialog.scroll <= dialog.client + 1, `${at} : pas de défilement horizontal dans la fenêtre`);
      for (const part of parts.filter(p => !p.hidden)) {
        assert.ok(part.width > 0 && part.scroll <= part.client + 1, `${at} : « ${part.text} » coupé (${JSON.stringify(part)})`);
        assert.ok(part.left >= dialog.left && part.right <= dialog.right && part.bottom <= dialog.bottom + 0.5,
          `${at} : « ${part.text} » hors de la fenêtre`);
      }
      const buttons = parts.slice(2);
      assert.deepEqual(buttons.map(b => b.text), [`Avant « ${LOADED} »`, `Juste après « ${LOADED} »`, 'Annuler']);
      for (const button of buttons) assert.ok(button.height >= 44, `${at} : « ${button.text} » assez haut pour le doigt (${button.height} px)`);
      // Un choix par ligne, dans l'ordre : avant, juste après, Annuler.
      assert.ok(buttons[0].bottom <= buttons[1].top && buttons[1].bottom <= buttons[2].top, `${at} : trois choix l’un sous l’autre`);
      await page.locator('#priorityCancel').click();
      await page.waitForSelector('#priorityDialog:not([open])', { state: 'attached' });
      assert.deepEqual(moves, [], `${at} : Annuler n’envoie rien`);
      await context.close();
      console.log(`ok - question « Priorité » lisible à ${at}, Annuler ne change rien`);
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
