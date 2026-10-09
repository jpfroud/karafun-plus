'use strict';
// Regression: T2-5 (seconde relecture) — sans Playwright ou sans Chromium, les
// mesures en vrai navigateur (page du bar, fenêtre de prénom) étaient ignorées en silence :
// la CI ne les faisait jamais, sans que personne le voie. Elles restent
// lançables hors ligne sur le PC du bar, mais dans la CI (variable CI) une
// annotation GitHub Actions « ::warning:: » signale qu'elles sont ignorées.
// Chromium est rendu introuvable ici par PLAYWRIGHT_BROWSERS_PATH ; aucune
// démo n'est lancée (le test s'arrête avant toute requête).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sans-navigateur-'));
try {
  for (const file of ['test/staff-qr-layout.test.js', 'test/staff-idle-layout.test.js', 'test/client-name-gate-layout.test.js']) {
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: nowhere, BASE: 'http://127.0.0.1:9' };
    delete env.CI;
    const run = ci => spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 60000, env: ci ? { ...env, CI: 'true' } : env });
    const local = run(false);
    assert.equal(local.status, 0, `${file} sans navigateur, hors CI : ${local.stderr}`);
    assert.match(local.stdout, /ignoré \(Playwright ou Chromium absent\)/, `${file} : ignoré, et le dit`);
    assert.doesNotMatch(local.stdout, /::warning::/, `${file} : pas d'annotation hors CI`);
    const ci = run(true);
    assert.equal(ci.status, 0, `${file} sans navigateur, en CI : ${ci.stderr}`);
    // Regression: M3-5 (troisième relecture) — ici seul Chromium manque, mais
    // l'annotation de la CI disait « Playwright absent » : même raison partout.
    assert.match(ci.stdout, /^::warning::.+ : ignoré \(Playwright ou Chromium absent\)$/m, `${file} : annotation visible dans la CI (${ci.stdout})`);
  }
} finally {
  fs.rmSync(nowhere, { recursive: true, force: true });
}
console.log('Mesures en navigateur sans Playwright : ignorées, annotation « ::warning:: » dans la CI OK');
