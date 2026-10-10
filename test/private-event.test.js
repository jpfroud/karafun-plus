'use strict';
// Événement privé : un seul QR pour tout le monde, actif seulement quand le
// bar l'allume. Le secret survit à une coupure (QR imprimé gardé), change avec
// « Renouveler le QR » et disparaît à la nouvelle soirée. Une sauvegarde
// abîmée coupe le mode sans jamais faire échouer la soirée.
const assert = require('node:assert/strict');
const { PrivateEvent, CREATIONS_PER_MINUTE, CLIENT_CREATIONS_PER_MINUTE, MAX_PEOPLE, MAX_EVENT_PEOPLE, PLACEHOLDER_ABANDON_MS,
  clientKey } = require('../private-event');

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

// Plafonds : 30 créations par minute et par appareil, 120 pour tout le bar,
// 200 personnes nommées présentes au plus (les parties ne comptent pas, côté serveur).
// Regression: seconde passe de la quatrième relecture finale (adverse,
// performance) — à 400, chaque écriture acceptée bloquait le serveur environ
// 0,7 s (prévision recalculée, trois titres par invité) : 200, valeur mesurée.
assert.equal(CREATIONS_PER_MINUTE, 120);
assert.equal(CLIENT_CREATIONS_PER_MINUTE, 30);
assert.equal(MAX_PEOPLE, 200);
const capped = new PrivateEvent();
capped.enable();
const t0 = 1_000_000;
for (let i = 0; i < CLIENT_CREATIONS_PER_MINUTE; i++) assert.equal(capped.admit(i, 'a', t0 + i), 'ok');
assert.equal(capped.admit(5, 'a', t0 + 10), 'busy', '31 créations du même appareil dans la minute : la suivante attend');
assert.equal(capped.admit(5, 'b', t0 + 11), 'ok', 'un autre appareil entre');
assert.equal(capped.admit(6, 'a', t0 + 60_001), 'ok', 'une minute plus tard, de nouveau possible');
// Appareil inconnu (tunnel sans CF-Connecting-IP) : seule la limite du bar compte.
const unknown = new PrivateEvent();
unknown.enable();
for (let i = 0; i < CREATIONS_PER_MINUTE; i++) assert.equal(unknown.admit(i, null, t0), 'ok');
assert.equal(unknown.admit(120, null, t0 + 1), 'busy', 'appareils inconnus : 120 par minute pour le bar');
const venue = new PrivateEvent();
venue.enable();
for (let i = 0; i < CREATIONS_PER_MINUTE; i++) assert.equal(venue.admit(i, `c${Math.floor(i / 5)}`, t0), 'ok');
assert.equal(venue.admit(120, 'nouveau', t0 + 1), 'busy', '120 créations dans la minute pour le bar : la suivante attend');
assert.equal(capped.admit(MAX_PEOPLE, 'z', t0 + 200_000), 'full',
  '200 personnes nommées venues par l’événement : plus aucune création');
// Une création annulée (sauvegarde impossible) libère sa place dans la minute.
const undo = new PrivateEvent();
undo.enable();
for (let i = 0; i < CLIENT_CREATIONS_PER_MINUTE; i++) undo.admit(0, 'a', t0);
undo.release(t0, 'a');
assert.equal(undo.admit(0, 'a', t0 + 1), 'ok');
undo.release(42, 'a'); // horodatage inconnu : sans effet
undo.release(t0 + 1, 'b'); // autre appareil : sans effet
assert.equal(undo.admit(0, 'a', t0 + 2), 'busy');

// Regression: deuxième relecture finale (ADV F1, S2-1, S2-2, P2-1) — l'appareil
// était l'adresse exacte : un téléphone en IPv6 change d'adresse dans son
// préfixe /64 et passait la limite ; une adresse IPv4 mappée (::ffff:a.b.c.d)
// comptait à part de la même adresse IPv4.
assert.equal(clientKey('192.0.2.7'), '192.0.2.7');
assert.equal(clientKey('::ffff:192.0.2.7'), '192.0.2.7', 'IPv4 mappée = la même adresse IPv4');
assert.equal(clientKey('::FFFF:C000:0207'), '192.0.2.7', 'forme hexadécimale aussi');
const v6 = clientKey('2001:db8:1:2:aaaa::1');
assert.equal(v6, clientKey('2001:0db8:0001:0002:bbbb:cccc:dddd:eeee'), 'même préfixe /64 = même appareil');
assert.equal(v6, clientKey('2001:DB8:1:2::99'));
assert.equal(v6, clientKey('2001:db8:1:2:1:2:192.0.2.1'), 'adresse IPv6 terminée par une IPv4');
assert.notEqual(v6, clientKey('2001:db8:1:3::1'), 'autre /64 = autre appareil');
assert.notEqual(v6, clientKey('2001:db8:1::'));
assert.equal(clientKey('fe80::1%wlan0'), clientKey('fe80::2'), 'zone ignorée');
assert.equal(clientKey('::1'), clientKey('::2'));
assert.equal(clientKey(''), '');
assert.equal(clientKey('pas une adresse'), 'pas une adresse');
assert.equal(clientKey('x'.repeat(100)).length, 64, 'texte inconnu borné');
// Une même box IPv6 : 30 créations dans la minute, puis attente.
const prefix = new PrivateEvent();
prefix.enable();
for (let i = 0; i < CLIENT_CREATIONS_PER_MINUTE; i++) assert.equal(prefix.admit(0, clientKey(`2001:db8:1:2::${i.toString(16)}`), t0), 'ok');
assert.equal(prefix.admit(0, clientKey('2001:db8:1:2:ffff::1'), t0 + 1), 'busy', 'nouvelle adresse du même /64 : refusée');
assert.equal(prefix.admit(0, clientKey('2001:db8:1:3::1'), t0 + 1), 'ok');

// Regression: deuxième relecture finale (A2-2) — « réessaie » sans dire quand :
// Retry-After donne les secondes avant qu'une création se libère (au moins 1).
const wait = new PrivateEvent();
wait.enable();
for (let i = 0; i < CLIENT_CREATIONS_PER_MINUTE; i++) wait.admit(0, 'a', t0 + i * 1000);
assert.equal(wait.admit(0, 'a', t0 + 45_000), 'busy');
assert.equal(wait.retryAfter('a', t0 + 45_000), 15, 'la plus ancienne création de l’appareil sort de la minute dans 15 s');
assert.equal(wait.retryAfter('a', t0 + 59_999), 1, 'au moins une seconde');
assert.equal(wait.retryAfter('b', t0 + 45_000), 1, 'rien ne bloque cet appareil : une seconde');
const crowded = new PrivateEvent();
crowded.enable();
for (let i = 0; i < CREATIONS_PER_MINUTE; i++) crowded.admit(0, `c${i}`, t0 + i * 100);
assert.equal(crowded.admit(0, 'nouveau', t0 + 30_000), 'busy');
assert.equal(crowded.retryAfter('nouveau', t0 + 30_000), 30, 'limite du bar : la plus ancienne création sort dans 30 s');
assert.equal(crowded.retryAfter(null, t0 + 30_000), 30);

// Regression: deuxième relecture finale (ADV F1) — 400 « Solo N » sans prénom
// remplissaient l'événement pour toujours. Vérification de la seconde passe de
// la quatrième relecture finale (adverse) : les places sans prénom des 10
// dernières minutes y comptaient encore et des rescans fermaient l'événement
// sous les 200, alors qu'une place sans prénom ne coûte rien à la prévision.
// Le plafond ne compte que les personnes nommées présentes, revérifié au
// premier prénom d'une place (full) ; les places sans prénom restent bornées
// par les fiches (held), le ménage (abandoned) et les limites par minute.
const now = Date.now();
const people = [
  { viaEvent: true, joinedAt: now - 3600_000 }, // nommée : compte
  { viaEvent: true, joinedAt: now - 3600_000, withdrawnAt: now - 1 }, // partie : non
  { viaEvent: true, nameRequired: true, joinedAt: now - 60_000 }, // sans prénom, même récente : non
  { viaEvent: true, nameRequired: true, joinedAt: now - 20 * 60000 }, // sans prénom, ancienne : non
  { viaEvent: true, nameRequired: true }, // sans heure : non
  { nameRequired: true, joinedAt: now }, // QR individuel : non
  { joinedAt: now }, // pas venue par l'événement : non
];
assert.equal(PrivateEvent.present(people), 1);
assert.equal(PrivateEvent.present(new Map(people.map((p, i) => [i, p])).values()), 1, 'accepte un itérable');
const namedGuests = count => Array.from({ length: count }, () => ({ viaEvent: true }));
assert.equal(PrivateEvent.full([...namedGuests(MAX_PEOPLE - 1), ...people.slice(1)]), false, 'encore un prénom possible');
assert.equal(PrivateEvent.full([...namedGuests(MAX_PEOPLE), { viaEvent: true, nameRequired: true }]), true,
  '200 personnes nommées venues par l’événement : plus de prénom par ce QR');

// Regression: troisième relecture finale (P3-1, S3-1) — les places sans
// prénom de plus de 10 minutes ne comptaient plus, mais rien ne les retirait :
// une boucle sans cookie en ajoutait sans fin (sauvegarde, liste « Solistes »).
// Abandonnée : venue par l'événement, sans prénom ni clé personnelle, pas
// partie, ouverte il y a 10 minutes ou plus, jamais relue par sa page
// (lastSeen au plus une seconde après l'ouverture) et sans aucune action.
assert.equal(PLACEHOLDER_ABANDON_MS, 10 * 60000);
const opened = { viaEvent: true, nameRequired: true, joinedAt: now - PLACEHOLDER_ABANDON_MS, lastSeen: now - PLACEHOLDER_ABANDON_MS + 1000 };
assert.equal(PrivateEvent.abandoned(opened, now), true);
assert.equal(PrivateEvent.abandoned({ ...opened, joinedAt: now - PLACEHOLDER_ABANDON_MS + 1, lastSeen: now - PLACEHOLDER_ABANDON_MS + 1 }, now), false,
  'moins de 10 minutes : gardée');
assert.equal(PrivateEvent.abandoned({ ...opened, lastSeen: opened.joinedAt + 1001 }, now), false, 'page relue après l’ouverture : gardée');
assert.equal(PrivateEvent.abandoned({ ...opened, lastActionAt: now - 1 }, now), false, 'une action : gardée');
assert.equal(PrivateEvent.abandoned({ ...opened, nameRequired: undefined }, now), false, 'nommée : jamais');
assert.equal(PrivateEvent.abandoned({ ...opened, withdrawnAt: now - 1 }, now), false, 'partie : laissée au bar');
assert.equal(PrivateEvent.abandoned({ ...opened, viaEvent: undefined }, now), false, 'QR individuel : jamais');
assert.equal(PrivateEvent.abandoned({ ...opened, soloKeyHash: 'a'.repeat(64) }, now), false, 'clé personnelle : jamais');
assert.equal(PrivateEvent.abandoned(null, now), false);
// Plafond dur : 400 personnes venues par l'événement et pas parties, nommées
// ou non, quel que soit leur âge ; au-delà, « complet ».
assert.equal(MAX_EVENT_PEOPLE, 2 * MAX_PEOPLE);
assert.equal(PrivateEvent.held(people), 4, 'les parties et les QR individuels ne comptent pas');
const heavy = new PrivateEvent();
heavy.enable();
assert.equal(heavy.admit(0, 'a', t0, MAX_EVENT_PEOPLE - 1), 'ok');
assert.equal(heavy.admit(0, 'b', t0, MAX_EVENT_PEOPLE), 'full', '400 fiches de l’événement : plus aucune création');
assert.equal(heavy.admit(0, 'c', t0), 'ok', 'sans compte de fiches : la règle des 200 seule');

console.log('Événement privé : QR unique, coupure, renouvellement, sauvegarde tolérante et plafonds OK');
