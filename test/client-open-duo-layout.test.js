'use strict';
// Regression: relecture du duo ouvert (« Qui veut chanter en duo avec moi ? »).
// Le bouton « Je chante avec {name} » ne passait jamais à la ligne
// (.info-actions en flex: none) : à 375x667, le texte du bandeau tenait dans
// une colonne de 27 à 60 px et un seul bandeau mesurait 230 à 545 px ; dans
// « La file », le même bouton (white-space: nowrap) écrasait le nom et le
// titre. Trois bandeaux s'affichaient toujours, avant l'annonce du passage
// de ce téléphone, et la barre collante dépassait l'écran.
// Attendu : les boutons passent sous le texte quand ils ne tiennent pas à
// côté, deux messages au plus (ceux de ce téléphone qui pressent d'abord,
// un seul duo ouvert), puis « +N » ; dépliés, chaque duo ouvert reste
// atteignable.
//
// Seconde relecture : dans « Ma table », « Chercher un duo » (ou « Fermer la
// demande ») ajouté à chaque titre poussait la rangée d'actions hors de la
// ligne (rangée en flex: none, jamais à la ligne) : page plus large que
// l'écran à 320 px, ✕ hors de la carte à 360 et 375 px. Le contrôle « pas de
// défilement horizontal » ne pouvait pas le voir : en isMobile, Chromium
// élargit innerWidth à la largeur du contenu ; il compare désormais avec la
// largeur fixée pour la page, et chaque bouton doit tenir dans l'écran.
//
// Relecture (passe 4) : sans personne d'autre pour un duo, la fiche « Duo
// sur … » s'ouvrait sous un toast d'erreur qui cachait son titre et son
// explication pendant 4 s ; la fiche le dit désormais elle-même.
//
// Relecture (passe 5) : « Chercher un duo », en toutes lettres sur chaque
// titre sans duo, ne tenait plus avec ♪, Réglages et ⇅ à 320, 360 et 375 px
// (et à 320 px en anglais) : la rangée passait sur deux lignes, le ✕ seul
// sur la troisième, chaque ligne de 106 à 151 px. C'est désormais une icône
// de la rangée ; chaque titre sans texte d'action garde ses actions sur une
// seule ligne, ✕ compris.
//
// Le DOM simulé de client-ui-coverage.test.js ne calcule pas la mise en page :
// seul un vrai navigateur mesure ces tailles. Aucun serveur ni port : la vraie
// page (client.html, app.css, client-i18n.js) est servie par Playwright.
// Sans Playwright ou son Chromium, le test est ignoré (playwright-browser.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPlaywright, skipped } = require('./playwright-browser');

const root = path.join(__dirname, '..');
const ORIGIN = 'http://karaoke.test';
const FILES = { '/t/1/secret': ['client.html', 'text/html'], '/app.css': ['app.css', 'text/css'],
  '/client-i18n.js': ['client-i18n.js', 'text/javascript'] };

const person = (id, name, extra = {}) => ({ id, name, active: true, songs: [], invites: [], inKaraFun: [], joinRequests: [],
  sentJoinRequests: [], canDefer: false, deferral: null, inbox: [], guestDuos: [], ...extra });
const openDuet = (entryId, name, table, title) => ({ ownerId: `o-${entryId}`, ownerName: name, ownerLabel: `${name} · Table ${table}`,
  entryId, openedAt: 1000, song: { songId: 50, title, artist: 'Artiste' }, volunteerIds: ['alice'] });
const stateOf = (extra = {}) => ({
  table: { id: '1', name: 'Table 1', headcount: 4, activeCount: 1 },
  tablePeople: [person('alice', 'Alice', { songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre', artist: 'Moi' }] })],
  managedIds: ['alice'], people: [], queue: [], waiting: [], closing: null,
  battle: { phase: 'idle', eligiblePersonIds: [], votedPersonIds: [], minVoters: 2, registered: 4 },
  catalogAvailable: true, stage: null, next: null, rules: {}, ...extra,
});

// `replies` : réponses simulées d'autres routes (chemin → JSON).
async function openPage(browser, { width, height, locale = 'fr-FR', state, ready = '#infoBar:not([hidden]) .info-item', replies = {} }) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, locale });
  // Son et vibration déjà réglés : pas de fenêtre de bienvenue par-dessus.
  await context.addInitScript(() => { try { localStorage.setItem('kfAlerts:1:secret', '1'); } catch (_) { /* privé */ } });
  const page = await context.newPage();
  const accepted = [];
  await page.route(`${ORIGIN}/**`, route => {
    const url = new URL(route.request().url());
    const file = FILES[url.pathname];
    if (file) return route.fulfill({ contentType: `${file[1]}; charset=utf-8`, body: fs.readFileSync(path.join(root, 'public', file[0])) });
    if (url.pathname === '/api/state') return route.fulfill({ json: state });
    if (url.pathname in replies) return route.fulfill({ json: replies[url.pathname] });
    if (url.pathname === '/api/table/duet/open/accept') accepted.push(JSON.parse(route.request().postData() || '{}').entryId);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${ORIGIN}/t/1/secret`);
  await page.waitForSelector(ready);
  return { page, context, accepted };
}

// Débordement horizontal, mesuré contre la largeur fixée pour la page (pas
// innerWidth, qui suit le contenu en isMobile) : largeur de la page, et
// boutons affichés de `scope` qui sortent de l'écran.
const overflowX = (page, width, scope) => page.evaluate(([width, scope]) => ({
  scroll: document.documentElement.scrollWidth,
  outside: [...document.querySelectorAll(`${scope} button`)].map(button => [button, button.getBoundingClientRect()])
    .filter(([, box]) => box.width && (box.left < -0.5 || box.right > width + 0.5))
    .map(([button, box]) => `${button.textContent.trim()} [${Math.round(box.left)}, ${Math.round(box.right)}]`),
}), [width, scope]);
const assertNoOverflowX = async (page, width, scope, at) => {
  const box = await overflowX(page, width, scope);
  assert.ok(box.scroll <= width, `${at} : pas de défilement horizontal (page de ${box.scroll} px pour ${width})`);
  assert.deepEqual(box.outside, [], `${at} : aucun bouton hors de l'écran`);
};

const barBox = page => page.evaluate(() => {
  const bar = document.getElementById('infoBar').getBoundingClientRect();
  const items = [...document.querySelectorAll('#infoBar .info-item')].map(item => {
    const box = item.getBoundingClientRect();
    return { h: Math.round(box.height), text: Math.round(item.querySelector('p').getBoundingClientRect().width),
      p: item.querySelector('p').textContent };
  });
  return { top: Math.round(bar.top), bottom: Math.round(bar.bottom), items,
    nav: Math.round(document.getElementById('tabsNav').getBoundingClientRect().top),
    more: document.querySelector('#infoBar [data-info-more]')?.textContent || null };
});

(async () => {
  const chromium = loadPlaywright();
  if (!chromium) { skipped('Bandeau du duo ouvert en navigateur'); return; }
  const browser = await chromium.launch();
  try {
    // Un bandeau : texte lisible et bandeau compact, même avec un long prénom.
    for (const [width, height] of [[320, 568], [360, 640], [375, 667]]) {
      for (const [name, locale] of [['Léa', 'fr-FR'], ['Maximilien', 'fr-FR'], ['Marie-Christine', 'fr-FR'], ['Marie-Christine', 'en-GB']]) {
        const at = `${width}x${height}, ${name}, ${locale}`;
        const { page, context } = await openPage(browser, { width, height, locale,
          state: stateOf({ openDuets: [openDuet('o1', name, 12, 'Je veux te voir')] }) });
        const box = await barBox(page);
        assert.equal(box.items.length, 1, at);
        assert.ok(box.items[0].text >= 200, `${at} : texte du bandeau lisible (${JSON.stringify(box)})`);
        assert.ok(box.items[0].h <= 150, `${at} : bandeau compact (${JSON.stringify(box)})`);
        await assertNoOverflowX(page, width, '#infoBar', at);
        await context.close();
      }
    }

    // Téléphone occupé : son passage imminent, la fermeture et quatre duos
    // ouverts. L'annonce du passage d'abord, un seul duo ouvert, puis « +N » ;
    // la barre reste au-dessus des onglets ; dépliés, les quatre se rejoignent.
    const opens = [openDuet('o1', 'Marie-Christine', 12, 'Je veux te voir'), openDuet('o2', 'Maximilien', 4, 'Rock'),
      openDuet('o3', 'Anne-Sophie', 7, 'Slow'), openDuet('o4', 'Jean-Baptiste', 9, 'Tube')];
    for (const [width, height] of [[320, 568], [375, 667]]) {
      const at = `${width}x${height}, quatre duos ouverts`;
      const { page, context, accepted } = await openPage(browser, { width, height, state: stateOf({
        next: { ours: true, ids: ['alice'], song: { entryId: 'e1' }, title: 'Mon titre' },
        closing: { at: Date.now() + 3600000, full: false, passed: false }, openDuets: opens }) });
      const box = await barBox(page);
      assert.match(box.items[0].p, /Alice passe juste après la chanson en cours : prépare-toi/, `${at} : ce téléphone d'abord (${JSON.stringify(box)})`);
      assert.match(box.items[1].p, /Marie-Christine · Table 12 cherche un partenaire/, `${at} : puis un duo ouvert`);
      assert.equal(box.items.length, 2, `${at} : deux messages au plus`);
      assert.equal(box.more, '+4 autres messages', at);
      assert.ok(box.bottom <= box.nav, `${at} : barre au-dessus des onglets (${JSON.stringify(box)})`);
      await page.locator('#infoBar [data-info-more]').click();
      const expanded = await barBox(page);
      assert.ok(expanded.bottom <= expanded.nav, `${at} : dépliés, hauteur bornée (${JSON.stringify(expanded)})`);
      // Chaque « Je chante avec … » se touche (Playwright fait défiler la barre
      // et vérifie que rien ne le recouvre), et la demande part. On attend sa
      // réponse, pas son départ : l'événement de départ pouvait arriver avant
      // que la route simulée ait noté le duo, et le dernier manquait (o4).
      for (const open of opens) {
        await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/table/duet/open/accept')),
          page.locator(`#infoBar [data-open-join="${open.entryId}"]`).click()]);
      }
      assert.deepEqual(accepted, opens.map(open => open.entryId), `${at} : chaque duo ouvert se rejoint`);
      await context.close();
    }

    // « La file » : la ligne d'un duo ouvert garde une colonne nom et titre lisible.
    for (const [width, height] of [[320, 568], [375, 667]]) {
      for (const name of ['Léa', 'Marie-Christine']) {
        const at = `${width}x${height}, file, ${name}`;
        const line = { source: 'helper', id: 'o', ids: ['o'], name, pos: 1, title: 'Je veux te voir', eta: Date.now() + 600000,
          song: { entryId: 'o1', songId: 50, title: 'Je veux te voir', artist: 'Artiste', duet: { state: 'open', kind: 'duo' } } };
        const { page, context } = await openPage(browser, { width, height,
          state: stateOf({ queue: [line], openDuets: [openDuet('o1', name, 12, 'Je veux te voir')] }) });
        await page.locator('#nav-queue').click();
        await page.waitForSelector('#queueList [data-open-join="o1"]');
        const row = await page.evaluate(() => {
          const li = document.querySelector('#queueList li');
          return { grow: Math.round(li.querySelector('.grow').getBoundingClientRect().width),
            h: Math.round(li.getBoundingClientRect().height) };
        });
        assert.ok(row.grow >= 110, `${at} : nom et titre lisibles (${JSON.stringify(row)})`);
        assert.ok(row.h <= 140, `${at} : ligne compacte (${JSON.stringify(row)})`);
        await assertNoOverflowX(page, width, '#queueList', at);
        await context.close();
      }
    }

    // « Ma table » : trois titres prêts (♪, Réglages, ⇅, « Chercher un duo »,
    // ✕), ou le premier en duo ouvert (« Fermer la demande »), ou en duo
    // proposé (« Annuler duo ») ; les actions passent à la ligne dans la
    // ligne du titre, rien ne sort de la carte ni de l'écran. Un titre sans
    // texte d'action (« Chercher un duo » est une icône) garde toutes ses
    // actions sur la ligne du ✕, et sa ligne reste compacte (106 px avant
    // l'ajout de « Chercher un duo »).
    const songs = duet => [{ entryId: 'e1', songId: 1, title: 'Je veux te voir', artist: 'Artiste', ...(duet ? { duet } : {}) },
      { entryId: 'e2', songId: 2, title: 'Bohemian Rhapsody', artist: 'Queen' }, { entryId: 'e3', songId: 3, title: 'Tube', artist: 'Groupe' }];
    const duets = { aucun: null, ouvert: { state: 'open', kind: 'duo' }, proposé: { state: 'pending', kind: 'duo', partnerName: 'Max', seen: true } };
    for (const [width, height] of [[320, 568], [360, 640], [375, 667]]) {
      for (const locale of ['fr-FR', 'en-GB']) {
        for (const [label, duet] of Object.entries(duets)) {
          const at = `${width}x${height}, Ma table, duo ${label}, ${locale}`;
          const { page, context } = await openPage(browser, { width, height, locale, ready: '#peopleList .song-stack li',
            state: stateOf({ tablePeople: [person('alice', 'Alice', { songs: songs(duet) })] }) });
          const rows = await page.evaluate(() => [...document.querySelectorAll('#peopleList .song-stack li')].map(li => {
            const row = li.getBoundingClientRect(), card = li.closest('.card').getBoundingClientRect();
            return { row: [Math.round(row.left), Math.round(row.right)], card: [Math.round(card.left), Math.round(card.right)],
              h: Math.round(row.height),
              buttons: [...li.querySelectorAll('button')].map(button => {
                const box = button.getBoundingClientRect();
                return { text: button.textContent.trim(), left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top),
                  // Texte d'action d'un duo en cours (« Fermer la demande »,
                  // « Annuler duo ») : un bouton de la rangée qui n'est pas une
                  // icône, hors « Chercher un duo », toujours vérifié.
                  worded: !!button.closest('.song-actions') && !button.classList.contains('icon') && !button.hasAttribute('data-duet-open'),
                  remove: button.hasAttribute('data-remove-song'), duo: button.hasAttribute('data-duet-open'),
                  label: button.getAttribute('aria-label'), title: button.getAttribute('title') };
              }) };
          }));
          assert.equal(rows.length, 3, at);
          for (const row of rows) {
            for (const button of row.buttons) {
              assert.ok(button.left >= row.row[0] && button.right <= row.row[1],
                `${at} : « ${button.text} » dans la ligne du titre (${JSON.stringify(row)})`);
            }
            assert.ok(row.row[1] <= row.card[1], `${at} : ligne dans la carte (${JSON.stringify(row)})`);
            if (row.buttons.some(button => button.worded)) continue;
            const remove = row.buttons.find(button => button.remove);
            for (const button of row.buttons) {
              assert.ok(Math.abs(button.top - remove.top) < 20, `${at} : « ${button.title || button.text} » sur la ligne du ✕ (${JSON.stringify(row)})`);
            }
            assert.ok(row.h <= 120, `${at} : ligne du titre compacte (${row.h} px, ${JSON.stringify(row)})`);
          }
          const duos = rows.flatMap(row => row.buttons.filter(button => button.duo));
          if (label === 'aucun') {
            assert.equal(duos.length, 3, `${at} : « Chercher un duo » sur chaque titre`);
            for (const duo of duos) {
              // Nom accessible : il commence par l'étiquette affichée (texte, sinon infobulle).
              const shown = /\p{L}/u.test(duo.text) ? duo.text : duo.title;
              assert.match(shown || '', /^(Chercher un duo|Find a duet)$/, `${at} : étiquette de « Chercher un duo » (${JSON.stringify(duo)})`);
              assert.ok(duo.label.startsWith(shown), `${at} : « ${shown} » au début de « ${duo.label} »`);
            }
          }
          const labels = rows.flatMap(row => row.buttons.map(button => button.text));
          if (label === 'ouvert') assert.ok(labels.some(text => /^(Fermer la demande|Close the request)$/.test(text)), `${at} : « Fermer la demande »`);
          if (label === 'proposé') assert.ok(labels.some(text => /^(Annuler duo|Cancel duet)$/.test(text)), `${at} : « Annuler duo »`);
          await assertNoOverflowX(page, width, '#peopleList', at);
          await context.close();
        }
      }
    }

    // Personne d'autre pour un duo (début de soirée, « Duos uniquement ») :
    // la fiche « Duo sur … » s'ouvre. Un toast d'erreur rouge (z-index 30, à
    // 88 px du bas) se posait dessus 4 s : il cachait le titre et
    // l'explication de la fiche, et à 320 px le haut de son seul bouton. La
    // fiche dit elle-même qu'il n'y a personne, sans toast.
    const tube = { songId: 50, title: 'Je veux te voir', artist: 'Artiste' };
    const replies = { '/api/catalog/categories': [{ name: 'Tubes', filter: 'tubes' }], '/api/catalog/highlights': [tube],
      '/api/catalog/songs': { songs: [tube], total: 1 }, '/api/search': [tube],
      '/api/duo/partners': [{ id: 'alice', name: 'Alice', tableId: '1', table: 'Table 1' }] };
    for (const [width, height] of [[320, 568], [360, 640], [375, 667]]) {
      for (const [rules, locale, alone] of [[{ duoOnly: true }, 'fr-FR', /^Aucun partenaire disponible pour l’instant\.$/],
        [{}, 'fr-FR', /^Aucun partenaire disponible pour l’instant\.$/], [{ duoOnly: true }, 'en-GB', /^No one is available for a duet yet\.$/]]) {
        const at = `${width}x${height}, personne pour un duo${rules.duoOnly ? ', Duos uniquement' : ''}, ${locale}`;
        const { page, context } = await openPage(browser, { width, height, locale, ready: '#peopleList [data-duet-song="alice"]', replies,
          state: stateOf({ rules, tablePeople: [person('alice', 'Alice')] }) });
        await page.locator('#peopleList [data-duet-song="alice"]').click();
        await page.waitForSelector('#catalogContent [data-song-index="0"], #catalogContent [data-category-index="0"]');
        if (await page.locator('#catalogContent [data-category-index="0"]').count()) await page.locator('#catalogContent [data-category-index="0"]').click();
        await page.locator('#catalogContent [data-song-index="0"]').click();
        await page.waitForSelector('#openDuetInstead');
        const box = await page.evaluate(() => {
          const toast = document.getElementById('toast'), sheet = document.getElementById('sheetPanel');
          const rect = el => { const r = el.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)]; };
          return { toast: toast.hidden ? null : { text: toast.textContent, at: rect(toast) }, sheet: rect(sheet),
            alone: sheet.querySelector('[data-duo-alone]')?.textContent || null };
        });
        assert.equal(box.toast, null, `${at} : aucun toast par-dessus la fiche (${JSON.stringify(box)})`);
        assert.match(box.alone || '', alone, `${at} : la fiche dit qu'il n'y a personne (${JSON.stringify(box)})`);
        // Le seul bouton de la fiche se touche (Playwright vérifie que rien ne le recouvre).
        await page.locator('#openDuetInstead').click({ trial: true, timeout: 2000 });
        await assertNoOverflowX(page, width, '#sheetPanel', at);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log('Bandeau du duo ouvert en navigateur : texte lisible et bandeau compact à 320, 360 et 375 px, passage de ce téléphone d’abord, un duo ouvert puis « +N », tous atteignables, ligne de la file lisible, actions des titres de « Ma table » dans leur ligne, fiche « personne pour un duo » sans toast par-dessus, sans défilement horizontal OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
