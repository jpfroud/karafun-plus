'use strict';
// Événement privé : un seul QR pour tout le monde, actif seulement quand le
// bar l'allume. Le secret survit à une coupure (QR imprimé gardé), change avec
// « Renouveler le QR » et disparaît à la nouvelle soirée. Une sauvegarde
// abîmée coupe le mode sans jamais faire échouer la soirée.
const assert = require('node:assert/strict');
const { PrivateEvent, CREATIONS_PER_MINUTE, MAX_PEOPLE } = require('../private-event');

const event = new PrivateEvent();
assert.equal(event.enabled, false);
assert.equal(event.secret, null);
assert.equal(event.verify('x'.repeat(22)), false, 'mode coupé : aucun QR accepté');
assert.equal(event.serialize(), null, 'rien à sauvegarder tant que le mode n’a jamais servi');

const secret = event.enable();
assert.match(secret, /^[A-Za-z0-9_-]{22}$/, 'secret de 128 bits en base64url');
assert.equal(event.enabled, true);
assert.ok(Number.isFinite(event.since));
assert.equal(event.verify(secret), true);
assert.equal(event.verify(secret.slice(1)), false, 'longueur différente refusée');
assert.equal(event.verify(secret.replace(/^./, c => c === 'A' ? 'B' : 'A')), false, 'un autre secret est refusé');
for (const bad of [null, undefined, 42, {}, '', 'a b c d e f g h i j k l']) assert.equal(event.verify(bad), false);

const since = event.since;
assert.equal(event.enable(), secret, 'rallumer garde le même QR');
assert.equal(event.since, since, 'rallumer un mode déjà actif ne change pas son heure');
event.disable();
assert.equal(event.enabled, false);
assert.equal(event.verify(secret), false, 'mode coupé : le QR imprimé est refusé');
assert.equal(event.enable(), secret, 'couper puis rallumer garde le QR imprimé');

const rotated = event.rotate();
assert.notEqual(rotated, secret);
assert.equal(event.verify(secret), false, 'l’ancien QR est refusé après « Renouveler »');
assert.equal(event.verify(rotated), true);

// Sauvegarde et reprise.
const saved = event.serialize();
assert.deepEqual(Object.keys(saved).sort(), ['enabled', 'secret', 'since']);
const restored = new PrivateEvent(JSON.parse(JSON.stringify(saved)));
assert.equal(restored.enabled, true);
assert.equal(restored.verify(rotated), true, 'un redémarrage garde le QR de l’événement');
const off = new PrivateEvent({ ...saved, enabled: false });
assert.equal(off.verify(rotated), false);
assert.equal(off.enable(), rotated, 'un mode coupé sauvegardé garde son secret pour le rallumer');

// Formes abîmées : mode coupé, secret oublié, jamais d'exception.
for (const bad of [42, 'texte', [], { enabled: true }, { enabled: true, secret: 'court', since: 1 },
  { enabled: 'oui', secret: rotated, since: 1 }, { enabled: true, secret: rotated, since: 'hier' },
  { enabled: true, secret: rotated + '!', since: 1 }]) {
  const broken = new PrivateEvent(bad);
  assert.equal(broken.enabled, false, `forme refusée : ${JSON.stringify(bad)}`);
  assert.equal(broken.secret, null);
  assert.equal(broken.verify(rotated), false);
}
assert.equal(new PrivateEvent(null).enabled, false);
assert.deepEqual(PrivateEvent.normalize({ ...saved, extra: 1 }), saved, 'champs inconnus ignorés');
assert.equal(PrivateEvent.normalize(undefined), null);

// Nouvelle soirée : tout est effacé.
event.clear();
assert.equal(event.enabled, false);
assert.equal(event.secret, null);
assert.equal(event.verify(rotated), false);
assert.throws(() => event.rotate(), /Active d’abord l’événement privé/, 'renouveler suppose le mode actif');

// Plafonds : 30 créations par minute, 400 personnes au plus.
assert.equal(CREATIONS_PER_MINUTE, 30);
assert.equal(MAX_PEOPLE, 400);
const capped = new PrivateEvent();
capped.enable();
const t0 = 1_000_000;
for (let i = 0; i < CREATIONS_PER_MINUTE; i++) assert.equal(capped.admit(i, t0 + i), true);
assert.equal(capped.admit(30, t0 + 100), false, 'trente créations dans la minute : la suivante attend');
assert.equal(capped.admit(30, t0 + 60_001), true, 'une minute plus tard, de nouveau possible');
assert.equal(capped.admit(MAX_PEOPLE, t0 + 200_000), false,
  'au-delà de 400 personnes venues par l’événement, plus aucune création');
// Une création annulée (sauvegarde impossible) libère sa place dans la minute.
const undo = new PrivateEvent();
undo.enable();
for (let i = 0; i < CREATIONS_PER_MINUTE; i++) undo.admit(0, t0);
undo.release(t0);
assert.equal(undo.admit(0, t0 + 1), true);
undo.release(42); // horodatage inconnu : sans effet
assert.equal(undo.admit(0, t0 + 2), false);

console.log('Événement privé : QR unique, coupure, renouvellement, sauvegarde tolérante et plafonds OK');
