'use strict';
// Regression: ISSUE-001 — au téléphone, la barre d'onglets cache les dernières commandes
// Regression: ISSUE-004 — sur PC, « Priorité » cache la fin de l'heure prévue dans la File
// Regression: ISSUE-010 — à 360 px, les valeurs du diagnostic KaraFun sont coupées
// Regression: ISSUE-011 — la pastille KaraFun amène sur Plus, titre caché sous la barre du haut
// Found by /qa on 2026-10-03
// Report: .gstack/qa-reports/run-20261003T140104Z/qa-report-127.0.0.1-2026-10-03.md
// Le DOM simulé des tests ne calcule pas la mise en page : on rejoue la
// cascade de app.css (règles dans l'ordre, requêtes @media de largeur) pour
// une largeur d'écran donnée, et on vérifie les déclarations qui décident de
// ces mises en page. Les mesures du navigateur sont dans le rapport QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Règles de premier niveau, avec la condition @media qui les entoure.
function rules(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    if (open < 0) break;
    const head = source.slice(i, open).trim();
    if (head.startsWith('@media')) {
      let depth = 1, j = open + 1;
      while (depth && j < source.length) { if (source[j] === '{') depth++; else if (source[j] === '}') depth--; j++; }
      for (const rule of rules(source.slice(open + 1, j - 1))) out.push({ ...rule, media: head.slice(6).trim() });
      i = j;
    } else {
      const close = source.indexOf('}', open);
      out.push({ selectors: head.split(',').map(s => s.trim()), body: source.slice(open + 1, close), media: null });
      i = close + 1;
    }
  }
  return out;
}
const ALL = rules(css);
const applies = (media, width) => !media || media.split(/\band\b/).every(part => {
  const m = /\((min|max)-width:\s*(\d+)px\)/.exec(part);
  return !m || (m[1] === 'min' ? width >= Number(m[2]) : width <= Number(m[2]));
});
// Déclarations retenues pour ce sélecteur exact à cette largeur (la dernière gagne).
function computed(selector, width) {
  const out = {};
  for (const rule of ALL) {
    if (!rule.selectors.includes(selector) || !applies(rule.media, width)) continue;
    for (const line of rule.body.split(';')) {
      const at = line.indexOf(':');
      if (at <= 0) continue;
      const name = line.slice(0, at).trim(), value = line.slice(at + 1).trim();
      out[name] = value;
      // Le raccourci « padding » remplace les côtés déclarés avant lui.
      if (name === 'padding') {
        const parts = value.match(/calc\([^)]*\)\)?|[^\s]+/g);
        const [top, right = top, bottom = top, left = right] = parts;
        Object.assign(out, { 'padding-top': top, 'padding-right': right, 'padding-bottom': bottom, 'padding-left': left });
      }
    }
  }
  return out;
}
const px = value => Number(/(-?\d+(?:\.\d+)?)px/.exec(String(value || ''))?.[1] ?? NaN);
// Dernière valeur d'une liste de colonnes (« 46px 24px … 186px »), sans les fonctions.
const lastColumn = value => String(value).replace(/minmax\([^)]*\)/g, 'X').trim().split(/\s+/).at(-1);

// ---------------------------------------------------------- ISSUE-001
// Barre d'onglets fixe : 58 px de bouton + 12 px de marge + 1 px de bord (71 px
// mesurés). Le bas de page doit laisser au moins cette place, à 390 et à 360 px.
for (const width of [899, 650, 390, 360]) {
  const body = computed('body.staff', width);
  const bottom = body['padding-bottom'];
  assert.ok(px(bottom) >= 80, `${width} px : marge basse ${bottom} trop courte pour la barre d’onglets (71 px)`);
}
// Une commande atteinte au clavier ou par scrollIntoView reste au-dessus de la barre.
assert.ok(px(computed('html:has(body.staff)', 390)['scroll-padding-bottom']) >= 80, 'scroll-padding-bottom au-dessus de la barre d’onglets');

// Le menu ⋯ des deux dernières lignes de la File s'ouvre au-dessus de la ligne.
assert.equal(computed('.row-actions.up .queue-actions', 390).top, 'auto');
assert.ok(px(computed('.row-actions.up .queue-actions', 390).bottom) >= 44, 'menu au-dessus du bouton ⋯');

// ---------------------------------------------------------- ISSUE-011
// La barre du haut est collante au téléphone (88 px mesurés à 390 px) :
// une section atteinte par la pastille garde son titre visible dessous.
assert.ok(px(computed('html:has(body.staff)', 390)['scroll-padding-top']) >= 96, 'scroll-padding-top sous la barre du haut');
assert.equal(computed('html:has(body.staff)', 1366)['scroll-padding-top'], undefined, 'sur PC la barre du haut ne colle pas');

// ---------------------------------------------------------- ISSUE-004
// Priorité + Réglages + Retirer : 205 px mesurés à 1366 px. La colonne des
// actions doit les contenir, et passer à la ligne plutôt que déborder sur l'heure.
for (const width of [900, 1366, 1800]) {
  const columns = computed('.queue-item', width)['grid-template-columns'];
  assert.ok(px(lastColumn(columns)) >= 214, `${width} px : colonne d’actions ${lastColumn(columns)} trop étroite`);
  assert.equal(computed('.queue-head', width)['grid-template-columns'], columns, 'en-tête aligné sur les lignes');
}
assert.equal(computed('.queue-item .queue-actions', 1366)['flex-wrap'], 'wrap', 'les boutons passent à la ligne au lieu de recouvrir l’heure');

// ---------------------------------------------------------- ISSUE-010
// Diagnostic KaraFun : la valeur peut rétrécir et passe à la ligne.
for (const width of [360, 390, 1366]) {
  const kv = computed('.kv', width)['grid-template-columns'];
  assert.match(lastColumn(kv), /^X$/, `${width} px : colonne des valeurs en minmax(0, …) (${kv})`);
  assert.match(kv, /minmax\(0,\s*1fr\)/);
}
assert.equal(computed('.kv > div', 360)['overflow-wrap'], 'anywhere', 'les adresses et droits longs passent à la ligne');
assert.equal(computed('.kv > div', 360)['min-width'], '0');
console.log('Bar : barre d’onglets, barre du haut, colonne d’actions et diagnostic à 360 px OK');
