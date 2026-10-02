'use strict';
// Regression: ISSUE-001 — panneau Spotify de la page du bar coincé dans une colonne étroite
// Found by /qa on 2026-10-02
// Report: .gstack/qa-reports/run-20261002T010817Z/qa-report-127.0.0.1-2026-10-02.md
// Chaque panneau de la page du bar doit occuper une largeur définie dans la
// grille de 12 colonnes ; sinon il tombe dans une colonne automatique d'une
// fraction d'écran et son texte devient illisible.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
const panels = [...html.matchAll(/<section class="card ([\w-]+-panel)\b/g)].map(match => match[1]);
assert.ok(panels.length >= 9, `panneaux repérés : ${panels.join(', ')}`);
const placed = new Set();
for (const rule of css.matchAll(/([^{}]+)\{[^}]*grid-column\s*:[^}]*\}/g)) {
  for (const selector of rule[1].split(',')) {
    const match = /\.([\w-]+-panel)\s*$/.exec(selector.trim());
    if (match) placed.add(match[1]);
  }
}
for (const panel of panels) assert.ok(placed.has(panel), `le panneau .${panel} n’a pas de place dans la grille du bar`);
console.log(`Bar : ${panels.length} panneaux placés dans la grille OK`);
