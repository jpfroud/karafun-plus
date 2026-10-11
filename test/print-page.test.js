'use strict';
// Page d'impression des QR (public/print.html) : la grande carte
// « Événement privé » n'apparaît que lorsque le mode est allumé, avec le QR
// réservé au bar (/qr-evenement.svg) et l'adresse ; les tables suivent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'print.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
assert.ok(script, 'script de la page d’impression');

async function openPrint(state, { key = 'k1' } = {}) {
  const els = {};
  const el = id => (els[id] ||= { id, textContent: '', innerHTML: '', disabled: true, checked: false,
    classList: { set: new Set(), toggle(name, on) { if (on) this.set.add(name); else this.set.delete(name); } } });
  const fetches = [];
  const context = {
    document: { getElementById: el },
    location: { search: key ? `?key=${key}` : '' },
    URL, URLSearchParams, Math, String, Promise,
    fetch: async (url, options) => { fetches.push({ url, options }); return { ok: true, json: async () => state }; },
  };
  await vm.runInNewContext(script, context, { filename: 'print.html' });
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  return { el, fetches };
}

const TABLE = { id: '1', name: 'Table 1', url: 'http://192.168.1.20:3000/t/1/abc', qrUrl: '/qr/1.svg' };
const SOLO = { id: 'Comptoir', name: 'En solo', individual: true, url: 'http://192.168.1.20:3000/t/Comptoir/x', qrUrl: '/qr/Comptoir.svg' };
const EVENT = { enabled: true, url: 'http://192.168.1.20:3000/t/Comptoir/x?evenement=secret', qrUrl: '/qr-evenement.svg' };

test('événement privé allumé : grande carte en tête, QR du bar avec la clé, puis les tables', async () => {
  const page = await openPrint({ tables: [TABLE, SOLO], privateEvent: EVENT, phoneBase: 'http://192.168.1.20:3000' });
  const grid = page.el('grid').innerHTML;
  assert.match(grid, /^<div class="card event-card">\s*<h2>Événement privé<\/h2>/, 'carte de l’événement en premier');
  assert.match(grid, /<img src="\/qr-evenement\.svg\?v=[0-9a-f]+&amp;key=k1" alt="QR de l’événement privé">/);
  assert.match(grid, /Scanne avec ton propre téléphone pour choisir tes chansons/);
  assert.match(grid, /Page perdue : rescanne ce QR\./);
  assert.match(grid, /evenement=secret<\/p><\/div>/, 'adresse imprimée sous le QR');
  assert.match(grid, /<h2>Table 1<\/h2>/, 'les tables suivent');
  assert.doesNotMatch(grid, /En solo/, 'le lien commun « En solo » n’est jamais imprimé');
  assert.equal(page.el('info').textContent, 'Vérifie l’accès ci-dessous avant d’imprimer : chaque QR contient le lien unique de sa table.');
  assert.equal(page.el('confirmAccess').disabled, false);
});

test('événement privé sans table ordinaire : sa carte seule ; mode coupé ou sans adresse : rien à imprimer', async () => {
  const only = await openPrint({ tables: [SOLO], privateEvent: EVENT, phoneBase: 'https://chant.exemple.fr' });
  assert.match(only.el('grid').innerHTML, /^<div class="card event-card">/);
  assert.match(only.el('grid').innerHTML, /Accès HTTPS par Internet/);
  assert.equal(only.el('info').textContent, 'Vérifie l’accès ci-dessous avant d’imprimer le QR de l’événement privé.');
  for (const privateEvent of [{ enabled: false, url: null, qrUrl: null }, { enabled: true, url: null, qrUrl: null }, undefined]) {
    const page = await openPrint({ tables: [SOLO], privateEvent, phoneBase: 'http://192.168.1.20:3000' });
    assert.equal(page.el('grid').innerHTML, '');
    assert.equal(page.el('accessNotice').textContent, 'Aucun QR code à imprimer.');
  }
  const tablesOnly = await openPrint({ tables: [TABLE], privateEvent: { enabled: false }, phoneBase: 'http://192.168.1.20:3000' }, { key: '' });
  assert.doesNotMatch(tablesOnly.el('grid').innerHTML, /Événement privé/, 'mode coupé : pas de carte');
  assert.equal(tablesOnly.fetches[0].url, '/api/staff/state');
});

// Regression: constat QA Q6 (8 octobre) — à 390 px, le QR de l'événement
// privé (340 px fixes) dépassait de sa carte et couvrait sa bordure.
// Pas de navigateur dans les tests : les règles CSS sont vérifiées.
test('QR imprimés : jamais plus larges que leur carte sur téléphone, 340 px gardés sur ordinateur et à l’impression', () => {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = selector => {
    // Première règle du sélecteur : celle de l'écran, avant les @media.
    const found = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => match[1].trim() === selector);
    assert.ok(found.length, `une règle ${selector}`);
    return Object.fromEntries(found[0][2].split(';').map(part => part.split(':').map(text => text.trim())).filter(([name]) => name));
  };
  for (const selector of ['.card img', '.card.event-card img']) {
    const decl = rule(selector);
    assert.equal(decl['max-width'], '100%', `${selector} : borné par sa carte`);
    assert.equal(decl.height, 'auto', `${selector} : reste carré en rétrécissant`);
    assert.equal(decl['aspect-ratio'] || rule('.card img')['aspect-ratio'], '1');
  }
  assert.equal(rule('.card img').width, '190px');
  assert.equal(rule('.card.event-card img').width, '340px', 'grand QR sur ordinateur');
  assert.match(rule('.grid')['grid-template-columns'], /minmax\(0, 1fr\)/, 'une colonne ne s’élargit pas au-delà de la page');
  const print = /@media print \{([\s\S]*?)\}\s*$/m.exec(style)?.[1] || '';
  assert.doesNotMatch(print, /img/, 'à l’impression, les tailles d’origine restent');
  assert.match(style, /@media screen and \(max-width: 600px\) \{[^@]*\.grid \{ grid-template-columns: 1fr; \}/, 'téléphone : une carte par ligne');
});
