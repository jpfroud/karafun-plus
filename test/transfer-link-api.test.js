'use strict';
// Transfert d'un chanteur par QR code ou lien, et alerte « titre en double »
// renvoyée au téléphone qui ajoute. Lancé par run-offline.js sur la démo.
const assert = require('node:assert/strict');
const { staffRoute } = require('./staff-auth');
const BASE = process.env.BASE || 'http://127.0.0.1:3112';

async function request(path, body) {
  const response = await fetch(BASE + await staffRoute(BASE, path), body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${path}: ${value.error || response.status}`);
    error.status = response.status;
    error.code = value.code;
    throw error;
  }
  return value;
}

(async () => {
  await request('/api/staff/settings', { auto: false, autoPlay: false });
  await request('/api/staff/table', { id: 'lien', headcount: 4 });
  await request('/api/staff/table', { id: 'voisine', headcount: 2 });
  const staff = await request('/api/staff/state');
  const secret = id => new URL(staff.tables.find(t => t.id === id).url).pathname.split('/').pop();
  const body = (id, fields = {}) => ({ table: id, access: secret(id), ...fields });
  const julie = await request('/api/table/person', body('lien', { name: 'Julie' }));
  const marc = await request('/api/table/person', body('lien', { name: 'Marc' }));
  const nora = await request('/api/table/person', body('voisine', { name: 'Nora' }));
  const singer = (p, extra = {}) => body('lien', { personId: p.id, token: p.token, ...extra });
  const state = (table, params = {}, ...tokens) => request('/api/state?' + new URLSearchParams([
    ['table', table], ['access', secret(table)], ...Object.entries(params), ...tokens.map(token => ['token', token]),
  ]));

  // ---- Alerte titre en double : non bloquante, avant et après l'ajout.
  const song = { songId: 4101, title: 'Les Lacs du Connemara', artist: 'Michel Sardou' };
  const first = await request('/api/table/song', singer(julie, { song }));
  assert.equal(first.ok, true);
  assert.equal(first.notice, null, 'premier ajout : aucune alerte');
  const check = await request('/api/song/notice?' + new URLSearchParams({ table: 'voisine', access: secret('voisine'),
    songId: '4102', title: 'Les lacs du Connemara (version live)', artist: 'Michel SARDOU' }));
  assert.equal(check.notice.queued.length, 1, 'avant l’ajout, la page prévient que le titre est déjà prévu');
  assert.equal(check.notice.queued[0].name, 'Julie');
  const second = await request('/api/table/song', body('voisine', { personId: nora.id, token: nora.token, song }));
  assert.equal(second.ok, true, 'le doublon est ajouté malgré l’alerte');
  assert.equal(second.notice.queued[0].before, true, 'le titre de Julie passera avant celui de Nora');
  const duo = await request('/api/table/duet', singer(marc, { partnerId: julie.id, song }));
  assert.equal(duo.notice.queued.length, 2, 'un duo sur le même titre est aussi signalé');
  const lines = (await request('/api/staff/state')).queue.filter(line => line.song?.songId === 4101);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0].repeat.later.length, 2, 'la page du bar signale la première occurrence');
  assert.ok(lines.slice(1).every(line => line.repeat.earlier.includes(lines[0].pos)), 'et les doublons suivants');
  await assert.rejects(request('/api/staff/settings', { repeatWarnMin: 241 }), /entre 0 et 240/);
  await request('/api/staff/settings', { repeatWarnMin: 30 });
  assert.equal((await request('/api/staff/state')).settings.repeatWarnMin, 30);

  // ---- Transfert par lien (QR code ou message).
  const share = await request('/api/table/person/share', singer(julie));
  assert.match(share.code, /^[0-9]{4}$/, 'le code reste disponible en secours');
  assert.match(share.qr, /^data:image\/png;base64,/);
  const link = new URL(share.url);
  assert.equal(link.pathname, `/t/lien/${secret('lien')}`, 'le lien ouvre la page de la table');
  const reprise = link.searchParams.get('reprise');
  assert.match(reprise, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(share.linkExpiresAt - Date.now() > 25 * 60000, 'lien valable une trentaine de minutes');

  const preview = await state('lien', { reprise });
  assert.deepEqual([preview.transferOffer.personId, preview.transferOffer.name], [julie.id, 'Julie']);
  assert.equal((await state('lien', { reprise })).transferOffer.name, 'Julie', 'l’aperçu ne consomme pas le lien');
  assert.equal((await state('voisine', { reprise })).transferOffer.invalid, true, 'le lien ne vaut que pour sa table');
  await assert.rejects(request('/api/table/person/claim', body('voisine', { link: reprise })), /expiré ou a déjà servi/);
  await assert.rejects(request('/api/table/person/claim', body('lien', { link: 'x'.repeat(22) })), /expiré ou a déjà servi/);

  const claimed = await request('/api/table/person/claim', body('lien', { link: reprise }));
  assert.equal(claimed.id, julie.id);
  assert.notEqual(claimed.token, julie.token);
  assert.deepEqual((await state('lien', {}, julie.token, marc.token)).managedIds, [marc.id],
    'l’ancien téléphone perd Julie mais garde Marc');
  assert.deepEqual((await state('lien', {}, claimed.token)).managedIds, [julie.id]);
  await assert.rejects(request('/api/table/song', singer(julie, { song: { songId: 4103, title: 'Volé' } })),
    error => error.status === 403 && error.code === 'PERSON_ACCESS');
  await assert.rejects(request('/api/table/person/claim', body('lien', { link: reprise })), /expiré ou a déjà servi/,
    'un lien sert une seule fois');
  assert.equal((await state('lien', { reprise })).transferOffer.invalid, true);
  await assert.rejects(request('/api/table/person/claim', body('lien', { personId: julie.id, code: share.code })), /expiré/,
    'le code du même partage est annulé par l’usage du lien');

  // Le code, lui, annule le lien.
  const again = await request('/api/table/person/share', body('lien', { personId: julie.id, token: claimed.token }));
  const byCode = await request('/api/table/person/claim', body('lien', { personId: julie.id, code: again.code }));
  await assert.rejects(request('/api/table/person/claim', body('lien', {
    link: new URL(again.url).searchParams.get('reprise') })), /expiré ou a déjà servi/);

  // Le bar obtient aussi un QR de transfert direct, pour toutes les tables.
  const fromBar = await request('/api/staff/person/share', { personId: marc.id });
  assert.match(fromBar.qr, /^data:image\/png;base64,/);
  const barLink = new URL(fromBar.url).searchParams.get('reprise');
  const toMarc = await request('/api/table/person/claim', body('lien', { link: barLink }));
  assert.equal(toMarc.id, marc.id);
  assert.deepEqual(new Set((await state('lien', {}, byCode.token, toMarc.token)).managedIds), new Set([julie.id, marc.id]));
  console.log('transfert par QR/lien et alertes de doublons OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
