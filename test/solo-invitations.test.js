'use strict';
const assert = require('node:assert/strict');
const { SoloInvitations } = require('../solo-invitations');

const invitations = new SoloInvitations();
const first = invitations.issue('Comptoir', 1);
assert.match(first.token, /^[A-Za-z0-9_-]{32}$/);
assert.ok(invitations.verify(first.token, 'Comptoir'));
assert.equal(invitations.verify(first.token, 'Autre'), null,
  'un QR individuel ne peut pas créer une personne dans un autre groupe');
assert.throws(() => invitations.issue('Comptoir', 1), /places en solo/,
  'une invitation réservée compte dans les places disponibles');
const saved = invitations.serialize();
assert.ok(!JSON.stringify(saved).includes(first.token), 'la sauvegarde ne contient que l’empreinte du QR');
const restored = new SoloInvitations(saved);
assert.ok(restored.verify(first.token, 'Comptoir'), 'une invitation survit au redémarrage');
assert.equal(restored.consume(first.token, 'Autre'), false);
assert.equal(restored.consume(first.token, 'Comptoir'), true);
assert.equal(restored.consume(first.token, 'Comptoir'), false, 'l’invitation n’est utilisable qu’une fois');
const revoked = restored.issue('Comptoir');
assert.equal(restored.revoke(revoked.id), true);
assert.equal(restored.verify(revoked.token, 'Comptoir'), null, 'un QR annulé est inutilisable');
const expired = restored.issue('Comptoir');
const entry = restored.verify(expired.token, 'Comptoir');
entry.expiresAt = Date.now() - 1;
assert.equal(restored.verify(expired.token, 'Comptoir'), null, 'un QR périmé est refusé');
assert.deepEqual(restored.view(), [], 'les invitations expirées ne restent pas affichées au bar');
assert.deepEqual(new SoloInvitations(restored.serialize()).view(), [],
  'un redémarrage ne ressuscite pas un QR expiré');
console.log('Invitations solo : table liée, capacité, expiration, révocation, restauration et usage unique OK');
