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
  const sharedLinkJoin = await request('/api/join', fields({ name: 'Intrus' }));
  assert.equal(sharedLinkJoin.status, 403,
    'le QR solo commun ne doit jamais suffire à inscrire un nouveau chanteur');
  assert.equal(sharedLinkJoin.value.code, 'SOLO_INVITATION');
  const legacyJoin = await request('/api/table/person', fields({ name: 'Intrus' }));
  assert.equal(legacyJoin.status, 403, 'l’ancienne API d’inscription solo exige aussi une invitation');
  const withoutStaffKey = await fetch(BASE + '/api/staff/solo-invite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: 'Comptoir' }),
  });
  assert.equal(withoutStaffKey.status, 403, 'un client ne peut pas fabriquer ses propres invitations');
  const invite = async () => {
    const result = (await ok('/api/staff/solo-invite', { tableId: 'Comptoir' })).value;
    assert.match(result.qr, /^data:image\/png;base64,/);
    assert.equal(new URL(result.url).pathname, new URL(table.url).pathname);
    const token = new URL(result.url).searchParams.get('invitation');
    assert.match(token, /^[A-Za-z0-9_-]{32}$/);
    return { ...result, token };
  };
  const aliceInvite = await invite();
  const bobInvite = await invite();
  const beforeJoin = (await ok('/api/staff/state')).value;
  assert.equal(beforeJoin.soloInvitations.length, 2);
  assert.ok(!JSON.stringify(beforeJoin).includes(aliceInvite.token), 'le jeton ne fuit pas dans l’état du bar');
  const alice = await ok('/api/join', fields({ name: 'Alice', invitation: aliceInvite.token }));
  const replay = await request('/api/join', fields({ name: 'Faux', invitation: aliceInvite.token }));
  assert.equal(replay.status, 403, 'un lien individuel déjà utilisé ne crée aucun autre profil sur un nouveau navigateur');
  const bob = await ok('/api/join', fields({ name: 'Bob', invitation: bobInvite.token }));
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
  const anonymousState = (await ok('/api/state?' + new URLSearchParams({
    table: 'Comptoir', access,
  }))).value;
  assert.equal(anonymousState.soloInvitationReady, false,
    'la page ouverte par le QR commun n’affiche pas de formulaire d’inscription');
  const usedState = (await ok('/api/state?' + new URLSearchParams({
    table: 'Comptoir', access, invitation: aliceInvite.token,
  }))).value;
  assert.equal(usedState.soloInvitationReady, false, 'un QR personnel consommé perd son droit côté interface');

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
  const unusedNewSlot = await invite();
  const replacement = await ok('/api/table/person/claim', fields({ personId: alice.value.id,
    code: share.code, invitation: unusedNewSlot.token }));
  assert.equal((await request('/api/join', fields({
    name: 'En trop', invitation: unusedNewSlot.token,
  }))).status, 403, 'reprendre ses titres avec un QR neuf ne laisse pas une deuxième place disponible');
  assert.deepEqual((await tableState()).recoveryPeople, [], 'une reprise consommée disparaît du parcours');
  assert.ok(replacement.cookie && replacement.cookie !== alice.cookie);
  assert.notEqual(replacement.value.token, alice.value.token);
  const oldPhone = await request('/api/table/person', fields({ name: 'Nouvelle Alice' }), alice.cookie);
  assert.equal(oldPhone.status, 403, 'l’ancien téléphone reste associé à Alice après le transfert');
  await ok('/api/table/song', fields({ personId: alice.value.id,
    token: replacement.value.token, song: { songId: 102, title: 'Reprise' } }), replacement.cookie);
  // Transfert par QR ou lien : même règle d'un seul profil par téléphone solo.
  const soloShare = (await ok('/api/staff/person/share', { personId: alice.value.id })).value;
  const reprise = new URL(soloShare.url).searchParams.get('reprise');
  assert.equal(new URL(soloShare.url).pathname, new URL(table.url).pathname, 'le lien ouvre la page « En solo »');
  const bobTakesAlice = await request('/api/table/person/claim', fields({ link: reprise }), bob.cookie);
  assert.equal(bobTakesAlice.value.code, 'SOLO_DEVICE_USED', 'le téléphone de Bob ne gère pas Alice en plus');
  assert.equal((await ok('/api/state?' + new URLSearchParams({ table: 'Comptoir', access, reprise })))
    .value.transferOffer.personId, alice.value.id, 'ce refus ne consomme pas le lien');
  const byLink = await ok('/api/table/person/claim', fields({ link: reprise }));
  assert.ok(byLink.cookie && byLink.cookie !== replacement.cookie, 'le nouveau téléphone reçoit son identité solo');
  assert.deepEqual((await tableState(byLink.value.token, byLink.cookie)).managedIds, [alice.value.id]);
  assert.deepEqual((await tableState(replacement.value.token, replacement.cookie)).managedIds, [],
    'le téléphone précédent perd la gestion d’Alice');
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
  const revoked = await invite();
  await ok('/api/staff/solo-invite/revoke', { id: revoked.id });
  assert.equal((await request('/api/join', fields({ name: 'Annulée', invitation: revoked.token }))).status, 403,
    'un QR annulé ne permet plus aucune inscription');
  const concurrent = await invite();
  const race = await Promise.all(['Eva', 'Léa'].map(name =>
    request('/api/join', fields({ name, invitation: concurrent.token }))));
  assert.deepEqual(race.map(result => result.status).sort(), [200, 403],
    'deux navigateurs qui scannent le même QR créent exactement un profil');
  const capacity = await invite();
  const active = (await ok('/api/staff/state')).value.tables.find(t => t.id === 'Comptoir').activeCount;
  await ok('/api/staff/table', { id: 'Comptoir', headcount: active, individual: true });
  const tooFull = await request('/api/join', fields({ name: 'Attente', invitation: capacity.token }));
  assert.equal(tooFull.value.code, 'TABLE_FULL', 'une erreur de capacité refuse la création du profil');
  await ok('/api/staff/table', { id: 'Comptoir', headcount: active + 1, individual: true });
  await ok('/api/join', fields({ name: 'Attente', invitation: capacity.token }));
  assert.equal((await request('/api/join', fields({ name: 'Rejeu', invitation: capacity.token }))).status, 403,
    'une inscription enfin réussie consomme l’invitation une fois');
  console.log('Comptoir : tours individuels, une seule fiche par téléphone, reprise sans accès aux autres OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
