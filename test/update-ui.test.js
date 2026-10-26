'use strict';
// Mise à jour du serveur : exécuter le vrai script de staff.html dans le DOM
// simulé déjà utilisé par la recette de cette page, sans lancer ses autres tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const harnessPath = path.join(__dirname, 'staff-ui-coverage.test.js');
const harnessSource = fs.readFileSync(harnessPath, 'utf8');
const delimiter = '// ------------------------------------------------------------------ tests';
assert.ok(harnessSource.includes(delimiter), 'début des tests du DOM simulé trouvé');
let fixtureSource = harnessSource.slice(0, harnessSource.indexOf(delimiter));
// Le DOM simulé existant ne recharge pas de document : compter ce geste du
// navigateur pour vérifier qu'il intervient seulement après validation.
assert.ok(fixtureSource.includes('assign: url => page.assigned.push(url)'));
fixtureSource = fixtureSource.replace('assign: url => page.assigned.push(url)',
  'assign: url => page.assigned.push(url), reload: () => { page.reloads = (page.reloads || 0) + 1; }');
const fixtureModule = { exports: {} };
new Function('require', '__dirname', 'module', fixtureSource + '\nmodule.exports = { openPage, baseWorld, sessionMap };')(
  createRequire(harnessPath), __dirname, fixtureModule);
const { openPage, baseWorld, sessionMap } = fixtureModule.exports;

function serverWorld(update = {}) {
  return { ...baseWorld(), app: { mode: 'server', version: 'v1.0.0' }, update: {
    enabled: true, busy: false, blockedReason: null, requiresConfirmation: false,
    phase: 'idle', currentVersion: 'v1.0.0', message: '', ...update,
  } };
}

test('mise à jour : réservée au mode serveur avec son agent installé', async () => {
  const pc = await openPage({ world: { ...serverWorld(), app: { mode: 'pc', version: 'v1.0.0' } } });
  assert.equal(pc.$('serverUpdatePanel').hidden, true);
  await pc.$('serverUpdateButton').onclick();
  assert.equal(pc.postsTo('/api/staff/update').length, 0);
  const noAgent = await openPage({ world: serverWorld({ enabled: false }) });
  assert.equal(noAgent.$('serverUpdatePanel').hidden, true);
  await noAgent.$('serverUpdateButton').onclick();
  assert.equal(noAgent.postsTo('/api/staff/update').length, 0);
  const installed = await openPage({ world: serverWorld() });
  assert.equal(installed.$('serverUpdatePanel').hidden, false);
  assert.match(installed.$('serverUpdateStatus').textContent, /v1\.0\.0/);
  assert.equal(installed.$('serverUpdateButton').disabled, false);
});

test('mise à jour : hors soirée, un clic authentifié suffit et le double clic ne soumet pas deux demandes', async () => {
  const page = await openPage({ world: serverWorld() });
  page.replies['/api/staff/update'] = () => {
    Object.assign(page.world.update, { busy: true, phase: 'checking', requestId: 'request-1' });
    return { ok: true, update: page.world.update };
  };
  const first = page.$('serverUpdateButton').onclick();
  const second = page.$('serverUpdateButton').onclick();
  await Promise.all([first, second]);
  await page.flush();
  assert.equal(page.postsTo('/api/staff/update').length, 1);
  const request = page.lastPost('/api/staff/update');
  assert.equal(request.headers['x-staff-key'], '123456');
  assert.deepEqual(request.body, {});
  assert.equal(page.confirms.length, 0, 'aucune deuxième confirmation nécessaire');
  assert.equal(page.$('serverUpdateButton').disabled, true);
  assert.match(page.$('serverUpdateStatus').textContent, /dernière version/);
});

test('mise à jour : une soirée active demande confirmation, annuler ne soumet rien', async () => {
  const page = await openPage({ world: serverWorld({ requiresConfirmation: true }) });
  page.confirmAnswer = false;
  const fetches = page.fetches.length;
  assert.equal(page.$('serverUpdateButton').disabled, false);
  await page.$('serverUpdateButton').onclick();
  assert.equal(page.confirms.length, 1);
  assert.match(page.confirms[0], /soirée.*en cours/i);
  assert.match(page.confirms[0], /interruption.*brève|brève.*interruption/i);
  assert.match(page.confirms[0], /tables.*chansons.*ordre.*conservés/i);
  assert.equal(page.postsTo('/api/staff/update').length, 0);
  assert.equal(page.fetches.length, fetches, 'annuler ne fait aucune requête');
  assert.equal(page.$('serverUpdateButton').disabled, false);
});

test('mise à jour : confirmer la soirée active envoie seulement confirmActive une fois', async () => {
  const page = await openPage({ world: serverWorld({ requiresConfirmation: true }) });
  page.replies['/api/staff/update'] = () => {
    Object.assign(page.world.update, { busy: true, phase: 'checking', requestId: 'request-live' });
    return { ok: true, update: page.world.update };
  };
  const first = page.$('serverUpdateButton').onclick();
  const second = page.$('serverUpdateButton').onclick();
  await Promise.all([first, second]);
  await page.flush();
  assert.equal(page.confirms.length, 1);
  assert.equal(page.postsTo('/api/staff/update').length, 1);
  const request = page.lastPost('/api/staff/update');
  assert.equal(request.headers['x-staff-key'], '123456');
  assert.deepEqual(request.body, { confirmActive: true });
  assert.equal(page.$('serverUpdateButton').disabled, true);
});

test('mise à jour : un blocage technique garde le bouton verrouillé même pendant une soirée', async () => {
  const blockedReason = 'Un envoi à KaraFun est en cours.';
  const page = await openPage({ world: serverWorld({ blockedReason, requiresConfirmation: true }) });
  assert.equal(page.$('serverUpdateButton').disabled, true);
  assert.equal(page.$('serverUpdateStatus').textContent, blockedReason);
  await page.$('serverUpdateButton').onclick();
  assert.equal(page.postsTo('/api/staff/update').length, 0);
  assert.equal(page.confirms.length, 0);
});

test('mise à jour : l’interruption prévue garde le suivi puis recharge une seule fois la version validée', async () => {
  const session = sessionMap();
  const page = await openPage({ world: serverWorld({ busy: true, phase: 'installing', requiresConfirmation: true }), session });
  assert.equal(session.map.get('bar-key'), '123456', 'la clé du bar reste dans l’onglet pendant le redémarrage');
  page.stateStatus = 503;
  await page.poll();
  assert.equal(page.$('kfPill').textContent, 'Mise à jour…');
  assert.match(page.$('serverUpdateStatus').textContent, /reconnexion automatique/);
  assert.equal(page.$('serverUpdateButton').disabled, true);
  page.stateStatus = 200;
  page.world.app.version = 'v1.0.1';
  Object.assign(page.world.update, { phase: 'verifying', busy: true });
  await page.poll();
  assert.equal(page.reloads || 0, 0, 'pas de rechargement avant validation');
  Object.assign(page.world.update, { phase: 'succeeded', busy: false });
  await page.poll();
  assert.equal(page.reloads, 1);
  await page.poll();
  assert.equal(page.reloads, 1, 'pas de boucle de rechargement');
  assert.equal(page.postsTo('/api/staff/update').length, 0, 'la reconnexion ne relance pas la mise à jour');
  assert.equal(page.confirms.length, 0, 'la reconnexion ne redemande pas confirmation');
});

test('mise à jour : réponse perdue après confirmation, le suivi retrouve la demande sans la renvoyer', async () => {
  const page = await openPage({ world: serverWorld({ requiresConfirmation: true }) });
  page.replies['/api/staff/update'] = () => {
    Object.assign(page.world.update, { busy: true, phase: 'checking' });
    throw new Error('Connexion interrompue.');
  };
  await page.$('serverUpdateButton').onclick();
  assert.equal(page.$('serverUpdateButton').disabled, true);
  assert.deepEqual(page.toast(), { text: 'Connexion interrompue.', bad: true });
  await page.$('serverUpdateButton').onclick();
  await page.poll();
  assert.equal(page.confirms.length, 1);
  assert.equal(page.postsTo('/api/staff/update').length, 1);
  assert.deepEqual(page.lastPost('/api/staff/update').body, { confirmActive: true });
});

test('mise à jour : une soirée commencée depuis le dernier état impose une nouvelle confirmation après le refus API', async () => {
  const page = await openPage({ world: serverWorld() });
  page.replies['/api/staff/update'] = () => {
    page.world.update.requiresConfirmation = true;
    return { status: 409, error: 'Confirme la mise à jour pendant la soirée.' };
  };
  await page.$('serverUpdateButton').onclick();
  assert.deepEqual(page.lastPost('/api/staff/update').body, {});
  assert.equal(page.confirms.length, 0);
  assert.equal(page.$('serverUpdateButton').disabled, false);
  assert.deepEqual(page.toast(), { text: 'Confirme la mise à jour pendant la soirée.', bad: true });
  page.confirmAnswer = false;
  await page.$('serverUpdateButton').onclick();
  assert.equal(page.confirms.length, 1);
  assert.equal(page.postsTo('/api/staff/update').length, 1, 'le refus ne déclenche aucun nouvel envoi automatique');
});

test('mise à jour : aucun rechargement pour un simple contrôle ou un retour arrière', async () => {
  const current = await openPage({ world: serverWorld({ phase: 'succeeded' }) });
  await current.poll();
  assert.equal(current.reloads || 0, 0);
  const rollback = await openPage({ world: serverWorld({ busy: true, phase: 'installing' }) });
  await rollback.update({ update: { ...rollback.world.update, phase: 'rolled-back', busy: false, message: '' } });
  assert.match(rollback.$('serverUpdateStatus').textContent, /précédente/);
  assert.equal(rollback.reloads || 0, 0);
  assert.equal(rollback.$('serverUpdateButton').disabled, false);
});

test('mise à jour : les messages du service restent du texte, un refus API ne cache pas la page', async () => {
  const page = await openPage({ world: serverWorld({ message: '<img id="unsafe-update" src=x onerror=alert(1)>' }) });
  assert.match(page.$('serverUpdateStatus').textContent, /<img/);
  assert.equal(page.doc.getElementById('unsafe-update'), null);
  page.replies['/api/staff/update'] = { status: 409, error: 'La soirée est en cours.' };
  await page.click(page.$('serverUpdateButton'));
  assert.deepEqual(page.toast(), { text: 'La soirée est en cours.', bad: true });
  assert.equal(page.$('serverUpdatePanel').hidden, false);
  assert.equal(page.$('serverUpdateButton').disabled, false);
});
