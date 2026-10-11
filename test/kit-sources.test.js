'use strict';
// Le planificateur est réparti dans lib/scheduler/ : chaque partie doit aussi
// figurer dans le kit du bar (sinon le serveur s'arrête au démarrage sur le PC
// du bar) et dans la mesure de couverture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');

test('le kit du bar et la couverture listent toutes les parties du planificateur', () => {
  const kit = fs.readFileSync(path.join(root, 'PREPARER-KIT-BAR.ps1'), 'utf8');
  const coverage = fs.readFileSync(path.join(root, 'test', 'coverage.js'), 'utf8');
  const loader = fs.readFileSync(path.join(root, 'scheduler.js'), 'utf8');
  const parts = fs.readdirSync(path.join(root, 'lib', 'scheduler')).filter(file => file.endsWith('.js'));
  assert.ok(parts.length >= 7);
  for (const file of parts) {
    assert.ok(kit.includes(`'lib\\scheduler\\${file}'`), `kit du bar : ${file}`);
    assert.ok(coverage.includes(`'lib/scheduler/${file}'`), `couverture : ${file}`);
    if (file !== 'common.js') assert.ok(loader.includes(`'${file.replace(/\.js$/, '')}'`), `planificateur : ${file}`);
  }
});
