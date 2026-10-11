'use strict';
// Parcours complet sur un serveur de démo : QR individuel compté à
// l'ouverture, prénom obligatoire, récupération par le QR personnel sur un
// autre navigateur, événement privé (un seul QR), QR de table pour les amis.
//
// Regression: retours de la soirée du 4 octobre — QR solo expiré avant la
// saisie du prénom, solo qui perd sa page, soirée privatisée sans QR commun.
const assert = require('node:assert/strict');
const { staffRoute, staffKey } = require('./staff-auth');
const BASE = process.env.BASE || 'http://127.0.0.1:3115';

async function request(path, body, cookie = '', headers = {}) {
  const route = await staffRoute(BASE, path);
  const response = await fetch(BASE + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value = {};
  try { value = JSON.parse(text); } catch (_) { value = text; }
  return { status: response.status, value, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
async function ok(path, body, cookie = '', headers = {}) {
  const result = await request(path, body, cookie, headers);
  assert.equal(result.status, 200, `${path}: HTTP ${result.status} ${JSON.stringify(result.value)}`);
  return result;
}

(async () => {
  await ok('/api/staff/settings', { auto: false });
  const staffState = async () => (await ok('/api/staff/state')).value;
  const comptoir = (await staffState()).tables.find(t => t.id === 'Comptoir');
  const access = new URL(comptoir.url).pathname.split('/').pop();
  const fields = extra => ({ table: 'Comptoir', access, ...extra });
  const state = (query, cookie = '', tokens = [], headers = {}) => ok('/api/state?' + new URLSearchParams({
    table: 'Comptoir', access, ...query }), undefined, cookie, { 'x-person-tokens': JSON.stringify(tokens), ...headers });
  const soloCount = async () => (await staffState()).people.filter(p => p.tableId === 'Comptoir').length;

  // ---- QR individuel : ouvert, la personne existe ; prénom obligatoire.
  const invitation = (await ok('/api/staff/solo-invite', { tableId: 'Comptoir' })).value;
  const token = new URL(invitation.url).searchParams.get('invitation');
  const page = await fetch(invitation.url.replace(/^https?:\/\/[^/]+/, BASE));
  assert.equal(page.status, 200, 'la page du QR s’ouvre');
  assert.equal((await state({ invitation: token })).value.soloInvitationReady, true);
  assert.equal(await soloCount(), 0, 'ni l’aperçu de lien ni la lecture d’état ne créent personne');

  const opened = await ok('/api/table/solo/open', fields({ invitation: token }));
  assert.equal(opened.value.nameRequired, true);
  assert.ok(opened.cookie, 'le téléphone reçoit son identité solo');
  const sam = { personId: opened.value.id, token: opened.value.token, cookie: opened.cookie };
  const row = (await staffState()).people.find(p => p.id === sam.personId);
  assert.equal(row.name, 'Solo 1');
  assert.equal(row.nameRequired, true, 'le bar voit « prénom à saisir » dès l’ouverture');
  assert.ok(row.lastActiveAt >= row.joinedAt);
  assert.equal((await staffState()).soloInvitations.length, 0, 'invitation consommée à l’ouverture');
  const view = (await state({ invitation: token }, sam.cookie, [sam.token])).value;
  assert.deepEqual(view.managedIds, [sam.personId]);
  assert.equal(view.me.nameRequired, true);

  const early = await request('/api/table/song', fields({ personId: sam.personId, token: sam.token,
    song: { songId: 101, title: 'Trop tôt' } }), sam.cookie);
  assert.equal(early.value.code, 'NAME_REQUIRED');
  assert.equal(early.value.error, 'Indique d’abord ton prénom.');
  await ok('/api/table/person/rename', fields({ personId: sam.personId, token: sam.token, name: 'Clara' }), sam.cookie);
  await ok('/api/table/song', fields({ personId: sam.personId, token: sam.token,
    song: { songId: 102, title: 'Enfin' } }), sam.cookie);
  assert.equal((await ok('/api/table/solo/open', fields({ invitation: token }), sam.cookie)).value.id, sam.personId,
    'rouvrir son QR sur son téléphone : la même personne');

  // ---- Autre navigateur : récupérer ses chansons, jamais une deuxième place.
  const elsewhere = await ok('/api/table/solo/open', fields({ invitation: token }));
  assert.deepEqual(elsewhere.value, { recover: { id: sam.personId, name: 'Clara' } });
  const claimed = await ok('/api/table/person/claim', fields({ key: token }));
  assert.equal(claimed.value.id, sam.personId);
  assert.ok(claimed.cookie && claimed.cookie !== sam.cookie);
  assert.equal(await soloCount(), 1, 'le nombre de personnes ne change pas');
  assert.deepEqual((await state({}, claimed.cookie, [claimed.value.token])).value.managedIds, [sam.personId]);
  assert.deepEqual((await state({}, sam.cookie, [sam.token])).value.managedIds, [], 'l’ancien téléphone perd l’accès');
  assert.equal((await request('/api/table/song', fields({ personId: sam.personId, token: sam.token,
    song: { songId: 103, title: 'Ancien' } }), sam.cookie)).status, 403);

  // ---- Activité : une page visible compte.
  const visible = await state({}, claimed.cookie, [claimed.value.token], { 'x-page-visible': '1' });
  assert.equal(visible.status, 200);
  assert.ok(Number.isFinite((await staffState()).people.find(p => p.id === sam.personId).lastActiveAt));

  // ---- Événement privé.
  const fresh = 'A'.repeat(22);
  assert.equal((await request('/api/table/enter', fields({ event: fresh }))).value.code, 'PRIVATE_EVENT');
  assert.equal((await fetch(`${BASE}/api/staff/private-event`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }) })).status, 403, 'réservé au bar');
  const on = (await ok('/api/staff/private-event', { enabled: true })).value;
  assert.equal(on.enabled, true);
  const secret = new URL(on.url).searchParams.get('evenement');
  assert.deepEqual((await staffState()).privateEvent, on);
  const key = encodeURIComponent(await staffKey(BASE));
  const svg = await fetch(`${BASE}/qr-evenement.svg?key=${key}`);
  assert.equal(svg.status, 200);
  assert.match(await svg.text(), /<svg/);
  assert.equal((await fetch(`${BASE}/qr-evenement.svg`)).status, 403);
  const before = await soloCount();
  const a = await ok('/api/table/enter', fields({ event: secret }));
  assert.equal(a.value.nameRequired, true);
  const again = await ok('/api/table/enter', fields({ event: secret }), a.cookie);
  assert.deepEqual([again.value.id, again.value.resumed], [a.value.id, true], 'même navigateur : son chanteur revient');
  const b = await ok('/api/table/enter', fields({ event: secret }));
  assert.notEqual(b.value.id, a.value.id, 'autre navigateur : un nouveau chanteur');
  assert.equal(await soloCount(), before + 2);
  const partners = (await ok('/api/duo/partners?' + new URLSearchParams({ table: 'Comptoir', access }))).value;
  assert.ok(!partners.some(p => [a.value.id, b.value.id].includes(p.id)), 'sans prénom : pas proposé en duo');
  await ok('/api/table/person/rename', fields({ personId: a.value.id, token: a.value.token, name: 'Marie' }), a.cookie);
  const dup = await request('/api/table/person/rename', fields({ personId: b.value.id, token: b.value.token, name: 'Marie' }), b.cookie);
  assert.equal(dup.value.code, 'NAME_TAKEN');
  const rotated = (await ok('/api/staff/private-event', { rotate: true })).value;
  assert.notEqual(new URL(rotated.url).searchParams.get('evenement'), secret);
  assert.equal((await request('/api/table/enter', fields({ event: secret }))).status, 403, 'l’ancien QR est refusé');
  await ok('/api/table/song', fields({ personId: a.value.id, token: a.value.token,
    song: { songId: 104, title: 'Toujours là' } }), a.cookie);
  await ok('/api/staff/private-event', { enabled: false });
  assert.equal((await staffState()).privateEvent.url, null);

  // ---- QR de table à faire scanner depuis un téléphone.
  await ok('/api/staff/table', { id: '9', headcount: 4 });
  const nine = (await staffState()).tables.find(t => t.id === '9');
  const nineAccess = new URL(nine.url).pathname.split('/').pop();
  const invite = (await ok('/api/table/invite?' + new URLSearchParams({ table: '9', access: nineAccess }))).value;
  assert.equal(invite.url, nine.url, 'même lien que le QR imprimé');
  assert.match(invite.qr, /^data:image\/png;base64,/);
  assert.equal((await request('/api/table/invite?' + new URLSearchParams({ table: 'Comptoir', access }))).status, 400);

  // ---- Nouvelle soirée : le mode est coupé, son secret effacé.
  await ok('/api/staff/private-event', { enabled: true });
  await ok('/api/staff/tables-clear', { confirmation: 'SUPPRIMER TOUTES LES TABLES' });
  assert.deepEqual((await staffState()).privateEvent, { enabled: false, url: null, qrUrl: null });
  console.log('Accès solo : QR compté à l’ouverture, prénom obligatoire, récupération, événement privé et QR de table OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
