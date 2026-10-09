'use strict';
// Playwright et son Chromium pour les mesures de la page du bar en vrai
// navigateur (staff-qr-layout, staff-idle-layout) : installation locale ou
// globale de npm. Sans eux, le test est ignoré, ce qui garde la suite lançable
// hors ligne sur le PC du bar ; dans la CI (variable CI, GitHub Actions),
// l'annotation « ::warning:: » rend cet oubli visible dans le résumé.
const fs = require('node:fs');
const path = require('node:path');

function loadPlaywright() {
  for (const where of ['playwright', path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'playwright')]) {
    try {
      const { chromium } = require(where);
      if (fs.existsSync(chromium.executablePath())) return chromium;
    } catch (_) { /* absent ici */ }
  }
  return null;
}

function skipped(label) {
  console.log(process.env.CI ? `::warning::${label} : ignoré (Playwright absent)` : `${label} : ignoré (Playwright ou Chromium absent)`);
}

module.exports = { loadPlaywright, skipped };
