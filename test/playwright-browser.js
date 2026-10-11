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

// Une seule raison, en CI comme sur le PC du bar : loadPlaywright ne distingue
// pas Playwright absent de Chromium absent.
function skipped(label) {
  const line = `${label} : ignoré (Playwright ou Chromium absent)`;
  console.log(process.env.CI ? `::warning::${line}` : line);
}

module.exports = { loadPlaywright, skipped };
