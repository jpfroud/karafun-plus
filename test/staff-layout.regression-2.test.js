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

// ---------------------------------------------------------- constats QA du 8 octobre
// Regression: constat QA Q7 — Repères : « N titres · N passages » et « Pas
// revenu depuis l'ouverture du QR (21:38) » coupés par « … » à 390 et à
// 1366 px, l'heure perdue. Les lignes secondaires passent à la ligne ; le
// prénom garde ses points de suspension.
for (const width of [390, 1366]) {
  const secondary = computed('.identity-who > span', width);
  assert.notEqual(secondary['white-space'], 'nowrap', `${width} px : lignes secondaires sur plusieurs lignes`);
  assert.notEqual(secondary['text-overflow'], 'ellipsis', `${width} px : jamais de « … » sur l’activité`);
  assert.notEqual(secondary.overflow, 'hidden', `${width} px : rien de caché`);
  assert.equal(secondary['overflow-wrap'], 'break-word', `${width} px : un mot trop long passe à la ligne`);
  const name = computed('.identity-who > strong', width);
  assert.equal(name['white-space'], 'nowrap', `${width} px : prénom sur une ligne`);
  assert.equal(name['text-overflow'], 'ellipsis', `${width} px : prénom long abrégé`);
}
assert.ok(!ALL.some(rule => rule.selectors.some(sel => /identity-who > span|\.activity\b/.test(sel)) && /nowrap|ellipsis/.test(rule.body)),
  'aucune autre règle ne recoupe l’activité');

// Regression: constat QA Q4 — à 390 px, le message avec un long lien (copie
// impossible) dépassait du bord de l'écran. Il passe à la ligne dans le cadre.
for (const width of [390, 1366]) {
  const toast = computed('.toast', width);
  assert.equal(toast['overflow-wrap'], 'anywhere', `${width} px : un lien long passe à la ligne`);
  assert.equal(toast['max-width'], '90vw');
  // Centré par left: 50 %, le cadre ne prendrait que la moitié de l'écran
  // (195 px à 390 px, mesuré dans Chromium) : sa largeur suit le texte, bornée à 90vw.
  assert.equal(toast.width, 'max-content', `${width} px : le cadre utilise toute la largeur permise`);
  assert.notEqual(toast['white-space'], 'nowrap');
}
for (const page of ['client.html', 'staff.html']) {
  const inline = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
  for (const match of inline.matchAll(/([^{}]*\.toast[^{}]*)\{([^{}]*)\}/g)) {
    assert.doesNotMatch(match[2], /white-space|overflow-wrap|word-break/, `${page} : ${match[1].trim()} ne bloque pas le retour à la ligne`);
  }
}
// Regression: Q3 (relecture) — la copie de secours donne le focus au champ du
// lien : sous 16 px, Safari iOS zoome la page et ne la rend pas ensuite.
for (const width of [390, 1366]) assert.ok(parseFloat(computed('.solo-invite-url', width)['font-size']) >= 16, `${width} px : champ du lien du bar en 16 px`);
const clientCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.html'), 'utf8');
const transferField = /\.client \.transfer-url \{([^}]*)\}/.exec(clientCss);
assert.ok(transferField && parseFloat(/font-size:\s*([\d.]+)px/.exec(transferField[1])?.[1]) >= 16, 'téléphone : champ du lien de transfert en 16 px');
// ---------------------------------------------------------- relecture finale (affichage)
// Regression: U1 — la pastille du panneau Spotify (nowrap) débordait de la
// carte à 390 px ; U2 — la pastille Spotify de la Scène est un bouton qui
// ressemblait à une étiquette fixe. Les deux restent dans leur cadre (nom
// d'appareil long abrégé par « … ») ; celle de la Scène se touche au doigt.
for (const id of ['#spotifyPill', '#spotifyChip']) {
  for (const width of [390, 1366]) {
    const pill = computed(id, width);
    assert.equal(pill.display, 'inline-block', `${id} à ${width} px : « … » possible (pas en flex)`);
    if (id === '#spotifyPill') assert.match(String(pill['max-width']), /100%/, `${id} à ${width} px : jamais plus large que son cadre`);
    assert.equal(pill.overflow, 'hidden');
    assert.equal(pill['text-overflow'], 'ellipsis');
  }
}
assert.equal(computed('#spotifyChip', 1366).cursor, 'pointer', 'la pastille de la Scène se touche');
assert.ok(ALL.some(rule => rule.selectors.includes('#spotifyChip:hover') && rule.selectors.includes('#spotifyChip:focus-visible')),
  'survol et focus clavier visibles');
assert.ok(px(computed('#spotifyChip', 390)['min-height']) >= 44, 'cible au doigt de 44 px au téléphone');
assert.ok(px(computed('#spotifyChip', 899)['min-height']) >= 44, 'et jusqu’à 899 px');
assert.equal(computed('#spotifyChip', 1366)['min-height'], undefined, 'sur PC, taille d’une pastille');
// Regression: U6 — la liste des solistes défilait dans la page au téléphone
// (défilement imbriqué) ; ses boutons faisaient moins de 40 px.
for (const width of [390, 899]) {
  assert.equal(computed('.soloist-list', width)['max-height'], 'none', `${width} px : pas de hauteur bornée`);
  assert.equal(computed('.soloist-list', width).overflow, 'visible', `${width} px : pas de défilement imbriqué`);
  assert.ok(px(computed('.soloist-row .btn', width)['min-height']) >= 40, `${width} px : « QR de reprise » de 40 px`);
}
assert.equal(computed('.soloist-list', 1366)['overflow-y'], 'auto', 'sur PC, la liste reste bornée');
// Regression: U10 — « plus long que … » était dans .queue-tags, cachées au
// téléphone : le repère court « trop long » s'y affiche, sur PC le badge suffit.
assert.equal(computed('.queue-item .person-cell .queue-tags', 390).display, 'none');
assert.notEqual(computed('.queue-item .too-long-tag', 390).display, 'none', '390 px : repère visible');
assert.notEqual(computed('.queue-item .too-long-tag', 650).display, 'none', '650 px : repère visible');
assert.equal(computed('.queue-item .too-long-tag', 651).display, 'none', 'au-delà, le badge de .queue-tags est visible');
// ---------------------------------------------------------- vérification adverse (affichage)
// Regression: U2 — un nom d'appareil Spotify long (45 caractères et plus)
// élargissait la Scène à 405 px sur un téléphone de 390 (et de 360) : un
// max-width en % ne compte pas dans la largeur minimale de la pastille, et
// .scene-chips (élément flex, min-width:auto) ne pouvait pas rétrécir.
// Mesuré au navigateur (Chromium, 390x800) : scrollWidth 405 avant, 390 après.
for (const width of [360, 390, 1366]) {
  const chip = computed('#spotifyChip', width)['max-width'];
  assert.ok(px(chip) > 0 && !/%/.test(chip), `${width} px : largeur maximale de la pastille de la Scène en px (${chip}), pas en %`);
  assert.equal(computed('.scene-chips', width)['min-width'], '0', `${width} px : les pastilles de la Scène peuvent rétrécir`);
  assert.equal(computed('.scene-chips', width)['max-width'], '100%', `${width} px : jamais plus larges que l’en-tête`);
}
// Regression: U10 — le repère « trop long » rétrécissait avec le prénom et la
// table : « trop l… » à 390 px, « tr… » à 360 px. Il garde sa largeur ; le
// prénom et la table prennent les « … ».
for (const width of [360, 390]) assert.equal(computed('.queue-item .too-long-tag', width).flex, 'none', `${width} px : « trop long » entier`);
// Regression: U1 — la phrase complète de Spotify (raison, heure du nouvel
// essai) était tout en bas du panneau, hors de l'écran du téléphone, alors
// que le guide la place sous le titre du panneau, à côté de la pastille.
const staffHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.html'), 'utf8');
const spotifyPanel = /<section[^>]*id="spotifyPanel"[^>]*>([\s\S]*?)<\/section>/.exec(staffHtml)[1];
assert.match(spotifyPanel, /^\s*<div class="section-heading">.*?id="spotifyPill".*?<\/span><\/div>\s*<p class="small" id="spotifyText" role="status"><\/p>/,
  'la phrase complète de Spotify suit directement le titre du panneau et sa pastille');
console.log('Bar : barre d’onglets, barre du haut, colonne d’actions et diagnostic à 360 px OK');
