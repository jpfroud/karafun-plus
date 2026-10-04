'use strict';
// Fenêtres de QR de la page du bar sur un vrai navigateur, en téléphone tactile :
// à l'ouverture, le titre (quelle table, quel chanteur) et le QR entier sont dans
// l'écran, sans défilement, et aucun champ de saisie n'a le focus (zoom de
// l'iPhone). Le DOM simulé de staff-ui-coverage.test.js vérifie l'ordre du
// focus ; seul un navigateur mesure le défilement de la fenêtre.
//
// Lancé par run-offline.js sur la démo. Il faut Playwright et son Chromium
// (installation locale ou globale de npm) : sans eux, le test est ignoré.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { staffRoute } = require('./staff-auth');
const BASE = process.env.BASE || 'http://127.0.0.1:3114';

function loadPlaywright() {
  for (const where of ['playwright', path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'playwright')]) {
    try {
      const { chromium } = require(where);
      if (fs.existsSync(chromium.executablePath())) return chromium;
    } catch (_) { /* absent ici */ }
  }
  return null;
}

async function request(route, body) {
  const response = await fetch(BASE + await staffRoute(BASE, route), body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${route}: ${value.error || response.status}`);
  return value;
}

// Position du titre et du QR dans l'écran, défilement de la fenêtre, focus.
const measure = (page, dialog, title, qr) => page.evaluate(([dialog, title, qr]) => {
  const box = document.getElementById(dialog), t = document.getElementById(title).getBoundingClientRect();
  const q = document.getElementById(qr).getBoundingClientRect(), focus = document.activeElement;
  return { open: box.open, scrollTop: Math.round(box.scrollTop), titleTop: Math.round(t.top), qrTop: Math.round(q.top),
    qrBottom: Math.round(q.bottom), qrHeight: Math.round(q.height), height: innerHeight, focus: focus?.id || focus?.tagName,
    field: /^(INPUT|SELECT|TEXTAREA)$/.test(focus?.tagName || '') };
}, [dialog, title, qr]);

function assertWhole(label, m) {
  assert.equal(m.open, true, `${label} : fenêtre ouverte`);
  assert.equal(m.field, false, `${label} : aucun champ de saisie focalisé (#${m.focus})`);
  assert.equal(m.scrollTop, 0, `${label} : fenêtre ouverte en haut, sans défilement (${JSON.stringify(m)})`);
  assert.ok(m.titleTop >= 0, `${label} : titre dans l’écran (${JSON.stringify(m)})`);
  assert.ok(m.qrHeight > 150 && m.qrTop >= 0 && m.qrBottom <= m.height, `${label} : QR entier dans l’écran (${JSON.stringify(m)})`);
}

(async () => {
  const chromium = loadPlaywright();
  if (!chromium) { console.log('Fenêtres de QR en navigateur : ignoré (Playwright ou Chromium absent)'); return; }
  await request('/api/staff/table', { id: '7', headcount: 4 });
  const tables = (await request('/api/staff/state')).tables;
  const access = new URL(tables.find(t => t.id === '7').url).pathname.split('/').pop();
  // Prénom propre à ce passage : le test peut être relancé sur une démo déjà utilisée.
  const name = `Alice ${String(Date.now()).slice(-4)}`;
  const joined = await fetch(BASE + '/api/table/person', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ table: '7', access, name }) });
  assert.equal(joined.ok, true, `inscription de ${name} à la table 7 : HTTP ${joined.status}`);
  const person = (await joined.json()).id;
  const staff = BASE + await staffRoute(BASE, '/staff');
  const browser = await chromium.launch();
  try {
    // Téléphones peu hauts (iPhone SE ou 8 avec les barres de Safari), iPhone 12 mini, iPhone 13, Android
    // courant ; puis un téléphone tenu en largeur, pour le grand QR de la table seulement.
    for (const [width, height] of [[375, 553], [375, 629], [390, 664], [360, 640], [667, 323]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const size = `${width}×${height}`;
      await page.goto(staff + '#accueil');
      await page.locator('#tBody [data-table-qr="7"]').tap();
      await page.waitForFunction(() => document.getElementById('tableQrDialog').open);
      const table = await measure(page, 'tableQrDialog', 'tableQrName', 'tableQrImg');
      assertWhole(`QR de la table, ${size}`, table);
      assert.equal(await page.textContent('#tableQrName'), 'Table 7');
      await page.locator('#tableQrClose').tap();
      if (width > height) { await context.close(); continue; }
      await page.locator('#issueSoloInvitation').tap();
      await page.waitForFunction(() => document.getElementById('soloInviteDialog').open);
      await page.waitForFunction(() => document.getElementById('soloInviteQr').complete);
      assertWhole(`QR individuel, ${size}`, await measure(page, 'soloInviteDialog', 'soloInviteTitle', 'soloInviteQr'));
      await page.locator('#soloInviteClose').tap();
      await page.locator('[data-tab-btn="reperes"]').tap();
      await page.locator(`#identityBody [data-identity-person="${person}"] [data-identity-share]`).tap();
      await page.waitForFunction(() => document.getElementById('shareDialog').open);
      assertWhole(`QR de transfert, ${size}`, await measure(page, 'shareDialog', 'shareTitle', 'shareQrBox'));
      assert.equal(await page.textContent('#shareTitle'), `Accès à ${name}`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log('Fenêtres de QR en navigateur : titre et QR entiers à l’ouverture OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
