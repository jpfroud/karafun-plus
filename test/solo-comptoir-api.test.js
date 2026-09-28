'use strict';
// Deux personnes seules partagent le QR du Comptoir, mais aucun téléphone ne
// peut gérer une deuxième fiche. Le bar peut encore aider au changement de téléphone.
const assert = require('node:assert/strict');
const { staffRoute } = require('./staff-auth');
const BASE = process.env.BASE || 'http://127.0.0.1:3108';

async function request(path, body, cookie = '') {
  const route = await staffRoute(BASE, path);
  const response = await fetch(BASE + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? (cookie ? { Cookie: cookie } : {}) :
      { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  return { status: response.status, value, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
async function ok(path, body, cookie = '') {
  const result = await request(path, body, cookie);
  assert.equal(result.status, 200, `${path}: HTTP ${result.status} ${JSON.stringify(result.value)}`);
  return result;
}

(async () => {
  await ok('/api/staff/settings', { auto: false });
  const forbiddenMode = await request('/api/staff/table', { id: 'Comptoir', individual: false });
  assert.equal(forbiddenMode.status, 400, 'le groupe En solo ne devient jamais une table collective');
  const forbiddenDeparture = await request('/api/staff/table-left', { id: 'Comptoir' });
  assert.equal(forbiddenDeparture.status, 400, 'le groupe En solo ne peut pas disparaître pendant la soirée');
  await ok('/api/staff/table', { id: 'Comptoir', headcount: 40, individual: true });
  const staff = (await ok('/api/staff/state')).value;
  const table = staff.tables.find(row => row.id === 'Comptoir');
  assert.equal(table.individual, true);
  const access = new URL(table.url).pathname.split('/').pop();
  const fields = extra => ({ table: 'Comptoir', access, ...extra });
  const alice = await ok('/api/join', fields({ name: 'Alice' }));
  const bob = await ok('/api/join', fields({ name: 'Bob' }));
  assert.ok(alice.cookie && bob.cookie && alice.cookie !== bob.cookie,
    'chaque téléphone solo reçoit une identité distincte');
  for (const [owner, newName] of [[alice, 'Fausse Alice'], [bob, 'Faux Bob']]) {
    const extra = await request('/api/table/person', fields({ name: newName }), owner.cookie);
    assert.equal(extra.status, 403, 'un téléphone solo ne crée pas une seconde fiche');
    assert.equal(extra.value.code, 'SOLO_DEVICE_USED');
  }
  const tableState = async (token = '', cookie = '') => (await ok('/api/state?' + new URLSearchParams({
    table: 'Comptoir', access, ...(token ? { token } : {}),
  }), undefined, cookie)).value;
  const aliceView = await tableState(alice.value.token, alice.cookie);
  assert.deepEqual(aliceView.managedIds, [alice.value.id]);
  assert.deepEqual(aliceView.tablePeople.map(p => p.id), [alice.value.id],
    'Alice voit sa propre fiche, pas les listes des autres solos');
  assert.deepEqual(aliceView.people.map(p => p.id), [alice.value.id],
    'les noms des autres solos restent absents de son état ordinaire');
  assert.deepEqual(aliceView.me.mates, [], 'les autres solos ne sont pas présentés comme ses proches');
  assert.equal((await tableState()).tablePeople.length, 0);
  assert.deepEqual((await tableState(alice.value.token)).managedIds, [],
    'le jeton seul ne contourne pas l’association au téléphone');
  assert.equal(aliceView.table.activeCount, 2, 'l’effectif total reste visible');

  const denied = await request('/api/table/song', fields({ personId: alice.value.id,
    token: bob.value.token, song: { songId: 101, title: 'Usurpation' } }), bob.cookie);
  assert.equal(denied.status, 403, 'Bob ne peut pas modifier Alice');
  const stolen = await request('/api/table/song', fields({ personId: alice.value.id,
    token: alice.value.token, song: { songId: 103, title: 'Jeton copié' } }), bob.cookie);
  assert.equal(stolen.status, 403, 'même un jeton copié ne suffit pas depuis le téléphone de Bob');
  const noCookie = await request('/api/song', { token: alice.value.token,
    song: { songId: 104, title: 'Ancienne API' } });
  assert.equal(noCookie.status, 403, 'l’ancienne API exige aussi le téléphone solo');

  const share = (await ok('/api/table/person/share', fields({ personId: alice.value.id,
    token: alice.value.token }), alice.cookie)).value;
  assert.deepEqual((await tableState()).recoveryPeople.map(p => p.id), [alice.value.id],
    'un code actif rend seulement ce profil disponible pour une reprise');
  assert.deepEqual((await tableState('', alice.cookie)).recoveryPeople.map(p => p.id), [alice.value.id],
    'le téléphone qui a perdu son jeton peut récupérer son propre profil');
  assert.deepEqual((await tableState('', bob.cookie)).recoveryPeople, [],
    'le téléphone de Bob ne voit pas la reprise d’Alice');
  const takenPhone = await request('/api/table/person/claim', fields({ personId: alice.value.id,
    code: share.code }), bob.cookie);
  assert.equal(takenPhone.status, 403, 'le téléphone de Bob ne peut pas gérer Alice aussi');
  assert.equal(takenPhone.value.code, 'SOLO_DEVICE_USED');
  const replacement = await ok('/api/table/person/claim', fields({ personId: alice.value.id,
    code: share.code }));
  assert.deepEqual((await tableState()).recoveryPeople, [], 'une reprise consommée disparaît du parcours');
  assert.ok(replacement.cookie && replacement.cookie !== alice.cookie);
  assert.notEqual(replacement.value.token, alice.value.token);
  const oldPhone = await request('/api/table/person', fields({ name: 'Nouvelle Alice' }), alice.cookie);
  assert.equal(oldPhone.status, 403, 'l’ancien téléphone reste associé à Alice après le transfert');
  await ok('/api/table/song', fields({ personId: alice.value.id,
    token: replacement.value.token, song: { songId: 102, title: 'Reprise' } }), replacement.cookie);
  await ok('/api/staff/table', { id: 'Table voisine', headcount: 1 });
  const neighborTable = (await ok('/api/staff/state')).value.tables.find(t => t.id === 'Table voisine');
  const neighborAccess = new URL(neighborTable.url).pathname.split('/').pop();
  const neighbor = await ok('/api/table/person', { table: 'Table voisine', access: neighborAccess,
    name: 'Camille' });
  await ok('/api/staff/settings', { auto: true, autoPlay: false, pushDelaySec: 0 });
  let live;
  for (let i = 0; i < 80; i++) {
    live = (await ok('/api/staff/state')).value;
    if (live.tracked.some(t => t.ids?.includes(alice.value.id))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(live.tracked.some(t => t.ids?.includes(alice.value.id)),
    'La chanson du premier soliste est chargée dans le faux KaraFun.');
  await ok('/api/staff/kf', { action: 'play' });
  for (let i = 0; i < 80; i++) {
    live = (await ok('/api/staff/state')).value;
    if (live.stage?.ids?.includes(alice.value.id)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(live.stage?.ids?.includes(alice.value.id));
  await ok('/api/staff/duo-mark', { queueId: live.stage.queueId, partnerId: neighbor.value.id });
  live = (await ok('/api/staff/state')).value;
  assert.deepEqual(live.stage.ids, [alice.value.id, neighbor.value.id]);
  assert.match(live.stage.singer, /Alice.*Camille/);
  assert.equal(live.people.find(p => p.id === neighbor.value.id).sung, 0,
    'Le duo joué avec une autre table ne consomme pas le tour de l’invitée.');
  console.log('Comptoir : tours individuels, une seule fiche par téléphone, reprise sans accès aux autres OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
