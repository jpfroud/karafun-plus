'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { NightStateStore, snapshotNight, restoreNight, inspectRecoveredPending } = require('../night-state');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-night-test-'));
const song = (songId, title) => ({ songId, title, artist: 'Artiste' });
const settings = () => ({ auto: true, autoPlay: false, baseUrl: 'https://chant.example.test',
  pushDelaySec: 45, playDelaySec: 8 });

try {
  const sched = new Scheduler({ tableRotation: true, weightedTables: true });
  const access = new TableAccess();
  for (const [id, count] of [['1', 4], ['2', 2]]) {
    sched.table(id); sched.setHeadcount(id, count); access.issue(id);
  }
  sched.renameTable('1', 'Les amis');
  const alice = sched.join({ tableId: '1', name: 'Alice',
    photo: { type: 'image/png', buf: Buffer.from([137, 80, 78, 71]) } });
  const bob = sched.join({ tableId: '1', name: 'Bob' });
  const clara = sched.join({ tableId: '2', name: 'Clara' });
  sched.chooseSong(alice, song(101, 'Première'), 'append');
  sched.chooseSong(alice, song(102, 'Deuxième'), 'append');
  sched.chooseSong(bob, song(103, 'Bob'), 'append');
  sched.chooseSong(clara, song(104, 'Clara'), 'append');
  sched.inviteDuet(alice, clara.id, song(105, 'Duo'));
  sched.answerDuet(clara, true);
  sched.setPrivateNote(bob.id, 'T-shirt rouge');
  const revokedToken = bob.token;
  sched.byToken.delete(revokedToken);
  bob.token = crypto.randomBytes(16).toString('hex');
  sched.byToken.set(bob.token, bob.id);
  sched.manualOrder = [bob.id, alice.id];
  sched.reserveNext();
  const reservedId = sched.reservedNext.personId;
  sched.duetCooldowns.set(clara.id, 2);
  sched.tableServeCounts.set('1', 3);
  const beforeQ = [...sched.Q];
  const originalSecret = access.get('1');
  const originalToken = alice.token;
  const store = new NightStateStore(path.join(dir, 'soiree'));
  const initial = snapshotNight({ scheduler: sched, access, settings: settings() });
  assert.equal(store.save(initial), true);
  assert.equal(store.save(initial), false, 'un état identique ne doit pas réécrire le disque');

  // Deux générations : celle qui vient d'être écrite remplace seulement la plus
  // ancienne. Une coupure pendant l'écriture garde l'autre version utilisable.
  sched.chooseSong(bob, song(106, 'Encore Bob'), 'append');
  const movable = sched.presenceView().filter(turn => !turn.future);
  const beforeManual = sched.manualOverrideState();
  sched.staffMove(movable.at(-1).ids[0], 1);
  const nativeFingerprint = 'a'.repeat(64);
  sched.recordManualChange({ kind: 'move', personId: movable.at(-1).ids[0],
    name: movable.at(-1).name, from: movable.length, to: 2,
    before: beforeManual, native: nativeFingerprint });
  const afterFirstManual = sched.manualOverrideState();
  const movableAgain = sched.presenceView().filter(turn => !turn.future);
  sched.staffMove(movableAgain.at(-1).ids[0], 1);
  sched.recordManualChange({ kind: 'move', personId: movableAgain.at(-1).ids[0],
    name: movableAgain.at(-1).name, from: movableAgain.length, to: 2,
    before: afterFirstManual, native: nativeFingerprint });
  assert.equal(sched.manualOrderActive, true);
  const newest = snapshotNight({ scheduler: sched, access, settings: settings() });
  assert.equal(store.save(newest), true);
  const resumedStore = new NightStateStore(path.join(dir, 'soiree'));
  const resumed = new Scheduler();
  const resumedAccess = new TableAccess();
  const resumedSettings = settings(); resumedSettings.auto = false;
  const loaded = resumedStore.load();
  assert.equal(loaded.scheduler.people.length, 3);
  const runtime = restoreNight(loaded, { scheduler: resumed, access: resumedAccess,
    settings: resumedSettings });
  assert.equal(runtime.recoveredPending, false);
  assert.equal(resumed.person(originalToken).name, 'Alice', 'les téléphones conservent leurs droits');
  assert.ok(Buffer.isBuffer(resumed.person(originalToken).photo.buf),
    'les photos restaurées doivent rester lisibles par la réponse HTTP');
  assert.deepEqual([...resumed.person(originalToken).photo.buf], [137, 80, 78, 71]);
  assert.equal(resumed.person(revokedToken), null, 'un ancien téléphone transféré reste révoqué');
  assert.equal(resumed.person(bob.token).id, bob.id);
  assert.equal(resumedAccess.get('1'), originalSecret, 'les QR imprimés restent valides');
  assert.deepEqual(resumed.Q, beforeQ, 'la file survit au redémarrage');
  assert.equal(resumed.manualOrderActive, true, 'un déplacement bar en cours survit au redémarrage');
  assert.equal(resumed.manualChanges.length, 2, 'plusieurs annulations survivent au redémarrage');
  assert.equal(resumed.canUndoManualChange(nativeFingerprint), true);
  assert.equal(resumed.reservedNext.personId, reservedId, 'le prochain passage annoncé reste garanti');
  assert.equal(resumed.table('1').name, 'Les amis');
  assert.equal(resumed.people.get(bob.id).privateNote, 'T-shirt rouge');
  assert.equal(resumed.songsOf(resumed.people.get(bob.id)).length, 2);
  assert.equal(resumed.duetInvites(resumed.people.get(clara.id)).length, 0);
  assert.equal(resumed.songsOf(resumed.people.get(alice.id)).at(-1).duet.state, 'accepted');
  assert.equal(resumed.duetCooldowns.get(clara.id), 2);
  assert.equal(resumedSettings.auto, true);
  assert.deepEqual(resumed.predict().map(v => v.song?.title),
    sched.predict().map(v => v.song?.title), 'prévision inchangée à la reprise');
  resumed.undoLastManualChange(resumed.manualChanges.at(-1).id, nativeFingerprint);
  assert.deepEqual(resumed.manualOverrideState(), afterFirstManual,
    'la dernière intervention se défait en premier après redémarrage');
  resumed.undoLastManualChange(resumed.manualChanges.at(-1).id, nativeFingerprint);
  assert.deepEqual(resumed.manualOverrideState(), beforeManual,
    'après redémarrage, annuler restitue précisément l’état avant déplacement');

  const legacy = structuredClone(newest);
  delete legacy.scheduler.manualChanges;
  delete legacy.scheduler.roundPeoplePhysical;
  legacy.scheduler.roundPeople = [alice.id];
  legacy.scheduler.roundGroups = ['1'];
  legacy.tracked = [{ queueId: 99, sel: { ids: [alice.id, clara.id],
    song: sched.songsOf(alice).at(-1), label: 'Alice & Clara' } }];
  // Ancienne sauvegarde : la vérification des repères, retirée, ne revient pas.
  legacy.scheduler.people.find(p => p.id === bob.id).verifiedAt = Date.now();
  const migrated = new Scheduler();
  restoreNight(legacy, { scheduler: migrated, access: new TableAccess(), settings: settings() });
  assert.equal(migrated.people.get(bob.id).privateNote, 'T-shirt rouge', 'le repère lui-même est gardé');
  assert.ok(!('verifiedAt' in migrated.people.get(bob.id)), 'l’ancienne vérification est oubliée');
  assert.deepEqual(migrated.roundPeople, new Set([alice.id, clara.id]),
    'la reprise conserve les propriétaires du tour et ajoute l’invitée connue dans KaraFun');
  assert.deepEqual(migrated.roundGroups, new Set(['1']));
  assert.deepEqual(migrated.Q, sched.Q, 'la migration conserve les titres et les places');

  const selected = sched.select();
  assert.ok(selected);
  const pending = { sel: selected, before: new Set([44, 45]), at: Date.now(), attempts: 1,
    retryAt: null };
  const inFlight = snapshotNight({ scheduler: sched, access, settings: settings(),
    pending, tracked: [{ queueId: 45, sel: selected, addedAt: Date.now(), startedAt: null }] });
  assert.equal(resumedStore.save(inFlight), true);
  const crashRestored = new Scheduler();
  const crashAccess = new TableAccess();
  const crashSettings = settings();
  const crash = restoreNight(new NightStateStore(path.join(dir, 'soiree')).load(),
    { scheduler: crashRestored, access: crashAccess, settings: crashSettings });
  assert.equal(crash.recoveredPending, true);
  assert.equal(crashSettings.auto, false, 'aucun doublon auto pendant la réconciliation KaraFun');
  assert.ok(crash.pending.before instanceof Set);
  assert.deepEqual([...crash.pending.before], [44, 45]);
  assert.equal(crash.tracked[0].queueId, 45);
  assert.equal(crashRestored.people.get(alice.id).token, originalToken);
  assert.equal(inspectRecoveredPending(crash.pending, []).state, 'unconfirmed');
  const sentItem = { queueId: 46, songId: selected.song.songId,
    singer: selected.label, title: selected.song.title };
  assert.equal(inspectRecoveredPending(crash.pending, [sentItem]).state, 'found');
  assert.equal(inspectRecoveredPending(crash.pending, [{ ...sentItem, queueId: 44 }]).state,
    'unconfirmed', 'une ancienne chanson identique ne confirme pas le nouvel envoi');
  assert.equal(inspectRecoveredPending(crash.pending, [sentItem, { ...sentItem, queueId: 47 }]).state,
    'ambiguous', 'deux titres identiques exigent un rapprochement humain');

  // La génération courante abîmée par un crash doit laisser lire l'ancienne.
  fs.writeFileSync(resumedStore.slot(resumedStore.sequence), '{');
  const fallback = new NightStateStore(path.join(dir, 'soiree')).load();
  assert.equal(fallback.scheduler.people.length, 3);
  assert.equal(fallback.pending, null);
  fs.writeFileSync(resumedStore.slot(resumedStore.sequence - 1), '');
  assert.throws(() => new NightStateStore(path.join(dir, 'soiree')).load(), /illisibles/);

  // Un fichier valide cryptographiquement mais incohérent ne doit pas modifier
  // la soirée déjà active pendant l'essai de restauration.
  const malformed = structuredClone(initial);
  malformed.scheduler.Q.push('personne-inconnue');
  const untouched = new Scheduler();
  untouched.table('safe');
  const untouchedAccess = new TableAccess();
  untouchedAccess.issue('safe');
  const existingSecret = untouchedAccess.get('safe');
  assert.throws(() => restoreNight(malformed, { scheduler: untouched,
    access: untouchedAccess, settings: settings() }), /ticket orphelin/);
  assert.ok(untouched.table('safe', false));
  assert.equal(untouchedAccess.get('safe'), existingSecret);

  // Fin de soirée : l'absence de tables est un état voulu, pas un motif pour
  // rétablir une ancienne table du fichier précédent.
  const resetStore = new NightStateStore(path.join(dir, 'fin-de-soiree'));
  resetStore.save(initial);
  const emptyNight = snapshotNight({ scheduler: new Scheduler(), access: new TableAccess(),
    settings: settings() });
  resetStore.save(emptyNight);
  resetStore.save(emptyNight, { force: true }); // écrase aussi la génération antérieure
  const oldNight = new Scheduler();
  oldNight.table('ancienne');
  const oldAccess = new TableAccess(); oldAccess.issue('ancienne');
  restoreNight(new NightStateStore(path.join(dir, 'fin-de-soiree')).load(),
    { scheduler: oldNight, access: oldAccess, settings: settings() });
  assert.equal(oldNight.tables.size, 0);
  assert.equal(oldNight.people.size, 0);
  assert.equal(oldAccess.get('ancienne'), null);
  fs.writeFileSync(resetStore.slot(resetStore.sequence), '{');
  assert.equal(new NightStateStore(path.join(dir, 'fin-de-soiree')).load().scheduler.tables.length, 0,
    'même le repli après corruption ne doit pas ressusciter une table supprimée');

  const solos = new Scheduler();
  const soloAccess = new TableAccess();
  solos.table('Comptoir'); solos.setHeadcount('Comptoir', 40); soloAccess.issue('Comptoir');
  const solo = solos.join({ tableId: 'Comptoir', name: 'Soliste' });
  solo.soloDeviceHashes = [crypto.createHash('sha256').update('telephone').digest('hex')];
  const restoredSolos = new Scheduler();
  restoreNight(snapshotNight({ scheduler: solos, access: soloAccess, settings: settings() }),
    { scheduler: restoredSolos, access: new TableAccess(), settings: settings() });
  assert.deepEqual(restoredSolos.people.get(solo.id).soloDeviceHashes, solo.soloDeviceHashes,
    'le lien sécurisé avec le téléphone solo survit au redémarrage');

  // Regression: deuxième relecture finale R2 — chœurs par défaut relevés sur
  // le KaraFun du bar : gardés dans la sauvegarde (code KaraFun en empreinte),
  // repris après un redémarrage ; une valeur abîmée est ignorée sans refuser
  // la soirée.
  const kfDefaults = { code: 'a1b2c3d4e5f60718', backing: 53 };
  const withDefaults = { ...settings(), karafunDefaults: kfDefaults };
  const kept = settings();
  restoreNight(JSON.parse(JSON.stringify(snapshotNight({ scheduler: solos, access: soloAccess, settings: withDefaults }))),
    { scheduler: new Scheduler(), access: new TableAccess(), settings: kept });
  assert.deepEqual(kept.karafunDefaults, kfDefaults, 'chœurs par défaut repris');
  for (const bad of [null, 'x', [], { code: 'a1b2', backing: 53 }, { code: kfDefaults.code, backing: 101 },
    { code: kfDefaults.code, backing: 52.5 }, { code: kfDefaults.code }]) {
    const damaged = snapshotNight({ scheduler: solos, access: soloAccess, settings: { ...settings(), karafunDefaults: bad } });
    const target = settings();
    restoreNight(damaged, { scheduler: new Scheduler(), access: new TableAccess(), settings: target });
    assert.equal('karafunDefaults' in target, false, `valeur abîmée ignorée : ${JSON.stringify(bad)}`);
  }

  console.log('ok - reprise après crash : file, titres, duos, téléphones, QR, écritures atomiques et envoi ambigu');
} finally {
  // Ce dossier est créé exclusivement sous le répertoire temporaire du test.
  if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
