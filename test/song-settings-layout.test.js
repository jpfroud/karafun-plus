'use strict';
// Réglages de titre sur un téléphone de 360 px : le badge d'un titre réglé
// (« ♭ −6 · tempo −50 % · guide 100 · chœurs coupés ») passe à la ligne au
// lieu de sortir de la carte et de faire défiler toute la page de côté. La
// page du bar garde son badge sur une ligne, après le nom du titre, dans la
// cellule coupée à droite de la file. Le DOM simulé des tests ne calcule pas
// la mise en page : on vérifie les règles de app.css qui la décident.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// Déclarations de toutes les règles qui visent exactement ce sélecteur.
function declarations(selector) {
  const out = {};
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!selectors.split(',').map(item => item.trim()).includes(selector)) continue;
    for (const line of body.split(';')) {
      const [name, ...value] = line.split(':');
      if (name.trim()) out[name.trim()] = value.join(':').trim();
    }
  }
  return out;
}

const phone = declarations('.tune-badge');
assert.notEqual(phone['white-space'], 'nowrap', 'badge du téléphone : jamais sur une seule ligne forcée');
assert.equal(phone['white-space'], 'normal');
assert.equal(phone['max-width'], '100%', 'jamais plus large que sa ligne');
assert.equal(phone['overflow-wrap'], 'anywhere');
assert.equal(declarations('.badge.tune')['white-space'], 'nowrap', 'page du bar : badge compact sur une ligne');
assert.ok(declarations('.queue-item .song-cell .badge.tune')['margin-left'], 'file du bar : le badge suit le nom du titre');
assert.equal(declarations('.queue-item .song-cell')['overflow'], 'hidden', 'file du bar : la cellule coupe à droite, sans déborder');
console.log('Réglages de titre : badge du téléphone à la ligne, badge du bar après le titre OK');
