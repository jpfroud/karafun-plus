'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { NightStateStore, snapshotNight, restoreNight, inspectRecoveredPending } = require('../night-state');
const { STAGE_ENDS_LIMIT } = require('../lib/scheduler/passages');

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

  // Retours du 23 octobre : après la reprise, un titre ajouté par quelqu'un
  // d'autre ne défait pas les gestes du bar, qui restent annulables.
  const placedAgain = new Scheduler();
  restoreNight(JSON.parse(JSON.stringify(newest)), { scheduler: placedAgain, access: new TableAccess(), settings: settings() });
  const shown = () => placedAgain.presenceView().filter(turn => !turn.future).map(turn => turn.ids[0]);
  const placedOrder = shown();
  assert.equal(placedOrder[1], movableAgain.at(-1).ids[0]);
  assert.ok(placedAgain.manualChanges.every(change => Number.isSafeInteger(change.serial)), 'le décompte des reports survit');
  placedAgain.chooseSong(placedAgain.people.get(clara.id), song(107, 'Encore Clara'), 'append');
  assert.deepEqual(shown().slice(0, 3), placedOrder.slice(0, 3), 'après la reprise, un ajout ne défait pas les gestes du bar');
  assert.equal(placedAgain.manualChanges.length, 2);
  placedAgain.undoLastManualChange(null, nativeFingerprint);
  assert.equal(placedAgain.manualChanges.length, 1, 'le dernier geste s’annule encore après l’ajout');
  assert.equal(shown().indexOf(movable.at(-1).ids[0]), 1, 'le geste plus ancien garde sa place');
  const brokenSerial = JSON.parse(JSON.stringify(newest));
  brokenSerial.scheduler.manualChanges[0].serial = 'x';
  const loose = new Scheduler();
  restoreNight(brokenSerial, { scheduler: loose, access: new TableAccess(), settings: settings() });
  assert.equal('serial' in loose.manualChanges[0], false, 'décompte abîmé oublié, geste gardé');
  {
    // Une mise à jour en soirée redémarre le serveur : l'ordre adopté par
    // Timefold doit survivre aussi, sans devenir une intervention du bar.
    // « Tables à tour de rôle » : quatre premiers passages de même part, que
    // le plan départage (en « Chacun son tour », le cycle des tables puis
    // premier ajouté, premier servi les range avant le plan).
    const planned = new Scheduler({ tableRotation: true });
    const plannedAccess = new TableAccess();
    const singers = ['1', '2', '3', '4'].map((tableId, index) => {
      planned.table(tableId); plannedAccess.issue(tableId);
      const person = planned.join({ tableId, name: `S0${index + 1}`, headcount: 1 });
      planned.chooseSong(person, song(201 + index, `T${index + 1}`));
      return person;
    });
    const local = planned.readyView().map(row => row.entryId);
    const desired = [local[2], local[0], local[3], local[1]];
    planned.solverPlan = { version: planned.version, fingerprint: planned.solverContextFingerprint(),
      ranks: new Map(desired.map((entryId, index) => [entryId, index])), source: 'timefold' };
    assert.deepEqual(planned.readyView().map(row => row.entryId), desired,
      'la recette part bien d’un ordre différent du repli local');
    const announced = planned.reserveNext();
    const saved = JSON.parse(JSON.stringify(snapshotNight({ scheduler: planned,
      access: plannedAccess, settings: settings() })));
    const resume = snapshot => {
      const scheduler = new Scheduler();
      restoreNight(snapshot, { scheduler, access: new TableAccess(), settings: settings() });
      return scheduler;
    };
    const restoredPlan = resume(saved);
    assert.deepEqual(restoredPlan.readyView().map(row => row.entryId), desired,
      'tous les passages gardent leur ordre après une mise à jour');
    assert.equal(restoredPlan.reservedNext.personId, announced.ids[0]);
    assert.equal(restoredPlan.solverPlan.source, 'timefold');
    assert.equal(restoredPlan.manualOrderActive, false, 'le plan repris ne verrouille pas la file comme un geste du bar');
    assert.deepEqual(restoredPlan.manualOrder, []);
    restoredPlan.chooseSong(restoredPlan.people.get(singers[1].id), song(210, 'Nouveau titre'), 'append');
    restoredPlan.readyView();
    assert.equal(restoredPlan.solverPlan, null, 'un vrai changement de titres permet le prochain calcul normal');

    // Le plan conserve les rangs des titres déjà chantés. La sauvegarde ne
    // garde que les titres encore en liste et reprend leur ordre relatif.
    const played = planned.select();
    planned.commit(played);
    planned.songEnded(played.ids);
    const afterPassage = JSON.parse(JSON.stringify(snapshotNight({ scheduler: planned,
      access: plannedAccess, settings: settings() })));
    assert.equal(afterPassage.scheduler.solverPlan.order.includes(played.song.entryId), false);
    assert.deepEqual(resume(afterPassage).readyView().map(row => row.entryId),
      planned.readyView().map(row => row.entryId), 'un plan réalisé en partie survit au redémarrage');

    for (const badPlan of [undefined, null, [], 'invalide', {},
      { ...saved.scheduler.solverPlan, source: 'inconnu' },
      { ...saved.scheduler.solverPlan, fingerprint: 'a'.repeat(64) },
      { ...saved.scheduler.solverPlan, order: [desired[0], desired[0], ...desired.slice(2)] },
      { ...saved.scheduler.solverPlan, order: [...desired.slice(0, -1), 'titre-inconnu'] },
      { ...saved.scheduler.solverPlan, order: desired.slice(1) },
      { ...saved.scheduler.solverPlan, order: [null, ...desired.slice(1)] }]) {
      const damaged = structuredClone(saved);
      if (badPlan === undefined) delete damaged.scheduler.solverPlan;
      else damaged.scheduler.solverPlan = badPlan;
      const repaired = resume(damaged);
      assert.equal(repaired.solverPlan, null, `plan absent, périmé ou abîmé ignoré : ${JSON.stringify(badPlan)}`);
      assert.equal(repaired.people.size, singers.length, 'les personnes restent inscrites');
      assert.equal(repaired.readyView().length, singers.length, 'aucun titre perdu avec un plan ignoré');
      assert.equal(repaired.reservedNext.personId, announced.ids[0], 'le prochain annoncé reste garanti');
    }
  }

  // Regression: quatrième relecture finale (performance) — chaque sauvegarde
  // (toutes les 2 s et après chaque action acceptée) recalculait l'empreinte
  // de chaque photo gardée : 800 photos de 400 Ko, près d'une seconde.
  const photoDir = path.join(dir, 'photos');
  const photoBytes = 64 * 1024;
  const portraits = new Scheduler();
  const portraitAccess = new TableAccess();
  portraits.table('Comptoir'); portraits.setHeadcount('Comptoir', 40); portraitAccess.issue('Comptoir');
  const faces = [1, 2, 3].map(n => portraits.join({ tableId: 'Comptoir', name: `Visage ${n}`,
    photo: { type: 'image/jpeg', buf: crypto.randomBytes(photoBytes) } }));
  const portraitSnapshot = () => snapshotNight({ scheduler: portraits, access: portraitAccess, settings: settings(), photoDir });
  const realCreateHash = crypto.createHash;
  let photoHashes = 0;
  crypto.createHash = (...args) => {
    const hash = realCreateHash(...args);
    const update = hash.update.bind(hash);
    hash.update = (data, ...rest) => {
      if (Buffer.isBuffer(data) && data.length === photoBytes) photoHashes++;
      return update(data, ...rest);
    };
    return hash;
  };
  try {
    const firstPhotos = portraitSnapshot().scheduler.people.map(p => p.photo);
    assert.equal(photoHashes, 3, 'une empreinte par photo');
    assert.deepEqual(portraitSnapshot().scheduler.people.map(p => p.photo), firstPhotos, 'mêmes fichiers');
    assert.equal(photoHashes, 3, 'une deuxième sauvegarde ne relit pas les photos inchangées');
    faces[0].photo = { type: 'image/png', buf: crypto.randomBytes(photoBytes) };
    const changed = portraitSnapshot().scheduler.people.map(p => p.photo);
    assert.equal(photoHashes, 4, 'une photo changée est lue une fois');
    assert.notEqual(changed[0].file, firstPhotos[0].file);
    assert.deepEqual(changed.slice(1), firstPhotos.slice(1));
    // Reprise : chaque fichier est vérifié une fois, les photos restent
    // lisibles et la sauvegarde suivante ne les relit pas.
    const saved = JSON.parse(JSON.stringify(portraitSnapshot()));
    const restoredPortraits = new Scheduler();
    const restoredAccess = new TableAccess();
    restoreNight(saved, { scheduler: restoredPortraits, access: restoredAccess, settings: settings(), photoDir });
    assert.equal(photoHashes, 7, 'la reprise vérifie chaque photo');
    for (const face of faces) assert.deepEqual(restoredPortraits.people.get(face.id).photo, face.photo);
    const again = snapshotNight({ scheduler: restoredPortraits, access: restoredAccess, settings: settings(), photoDir });
    assert.equal(photoHashes, 7, 'pas de nouvelle lecture après la reprise');
    assert.deepEqual(again.scheduler.people.map(p => p.photo), saved.scheduler.people.map(p => p.photo));
  } finally {
    crypto.createHash = realCreateHash;
  }

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
  // Vérification de la troisième relecture finale R4 : valeur provisoire
  // (KaraFun collant) gardée comme telle.
  const provisional = { ...kfDefaults, provisional: true };
  const keptProvisional = settings();
  restoreNight(JSON.parse(JSON.stringify(snapshotNight({ scheduler: solos, access: soloAccess,
    settings: { ...settings(), karafunDefaults: provisional } }))),
  { scheduler: new Scheduler(), access: new TableAccess(), settings: keptProvisional });
  assert.deepEqual(keptProvisional.karafunDefaults, provisional, 'valeur provisoire reprise');
  for (const bad of [null, 'x', [], { code: 'a1b2', backing: 53 }, { code: kfDefaults.code, backing: 101 },
    { code: kfDefaults.code, backing: 52.5 }, { code: kfDefaults.code }, { ...kfDefaults, provisional: 'oui' }]) {
    const damaged = snapshotNight({ scheduler: solos, access: soloAccess, settings: { ...settings(), karafunDefaults: bad } });
    const target = settings();
    restoreNight(damaged, { scheduler: new Scheduler(), access: new TableAccess(), settings: target });
    assert.equal('karafunDefaults' in target, false, `valeur abîmée ignorée : ${JSON.stringify(bad)}`);
  }

  {
    // « Duos uniquement » : gardé après un redémarrage ; une valeur abîmée laisse la valeur actuelle.
    const base = { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8, closingAt: null };
    const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: new Scheduler({ solverEnabled: false }),
      access: new TableAccess(), settings: { ...base, duoOnly: true } })));
    const restore = (value, current = false) => {
      const copy = structuredClone(snapshot);
      if (value === undefined) delete copy.settings.duoOnly; else copy.settings.duoOnly = value;
      const settings = { ...base, duoOnly: current };
      restoreNight(copy, { scheduler: new Scheduler({ solverEnabled: false }), access: new TableAccess(), settings });
      return settings.duoOnly;
    };
    assert.equal(restore(true), true, 'option gardée après un redémarrage');
    for (const bad of ['oui', 1, null, {}]) assert.equal(restore(bad, false), false, JSON.stringify(bad));
    assert.equal(restore(undefined, false), false, 'ancienne sauvegarde sans le champ');
  }

  {
    // Relecture : en « Duos uniquement », un duo ouvert sans partenaire ne
    // part pas (_openHeld) : ni lui ni les titres suivants de son auteur ne
    // sont dans le plan de Timefold. Le plan doit quand même être sauvegardé
    // et repris, sous la même règle qu'à la sauvegarde.
    const rules = { duoOnly: true };
    const planned = new Scheduler({ tableRotation: true });
    planned.duoOnlyRule = () => !!rules.duoOnly;
    const plannedAccess = new TableAccess();
    const singers = ['1', '2', '3', '4'].map((tableId, index) => {
      planned.table(tableId); plannedAccess.issue(tableId);
      const person = planned.join({ tableId, name: `S0${index + 1}`, headcount: 1 });
      planned.chooseSong(person, song(301 + index, `T${index + 1}`));
      return person;
    });
    // S02 cherche un partenaire pour son second titre, S05 pour son premier.
    planned.chooseSong(singers[1], song(311, 'Second'), 'append');
    planned.openDuet(singers[1], { entryId: planned.songsOf(singers[1])[1].entryId });
    planned.table('5'); plannedAccess.issue('5');
    const held = planned.join({ tableId: '5', name: 'S05', headcount: 1 });
    planned.openDuet(held, { song: song(321, 'Ouvert') });
    planned.chooseSong(held, song(322, 'Après'), 'append');
    const local = planned.readyView().map(row => row.entryId);
    assert.equal(local.length, 4, 'les titres retenus sont hors de la file');
    const desired = [local[2], local[0], local[3], local[1]];
    planned.solverPlan = { version: planned.version, fingerprint: planned.solverContextFingerprint(),
      ranks: new Map(desired.map((entryId, index) => [entryId, index])), source: 'timefold' };
    assert.deepEqual(planned.readyView().map(row => row.entryId), desired);
    const base = { ...settings(), duoOnly: true };
    const saved = JSON.parse(JSON.stringify(snapshotNight({ scheduler: planned, access: plannedAccess, settings: base })));
    assert.deepEqual(saved.scheduler.solverPlan?.order, desired, 'plan sauvegardé sans les titres retenus');
    // Le serveur redémarre avec « Duos uniquement » coupé : la sauvegarde le rallume.
    const target = { ...settings(), duoOnly: false };
    const resumed = new Scheduler();
    resumed.duoOnlyRule = () => !!target.duoOnly;
    restoreNight(saved, { scheduler: resumed, access: new TableAccess(), settings: target });
    assert.equal(resumed.solverPlan?.source, 'timefold', 'plan repris');
    assert.deepEqual(resumed.readyView().map(row => row.entryId), desired, 'même ordre après le redémarrage');
    assert.equal(resumed.manualOrderActive, false);
  }

  {
    // Relecture : une sauvegarde prise entre un passage annulé et le suivant
    // peut porter un début d'attente ou une marque d'échange au-delà du
    // compteur ; la reprise les ramène, sinon la personne perdrait la
    // protection de patience.
    const sched = new Scheduler();
    const access = new TableAccess();
    for (const id of ['1', '2']) { sched.table(id); sched.setHeadcount(id, 4); access.issue(id); }
    const ana = sched.join({ tableId: '1', name: 'Ana' });
    const ben = sched.join({ tableId: '2', name: 'Ben' });
    sched.chooseSong(ana, { songId: 1, title: 'A' });
    sched.chooseSong(ben, { songId: 2, title: 'B' });
    const sel = sched.select(); sched.commit(sel); sched.songEnded(sel.ids);
    const saved = JSON.parse(JSON.stringify(snapshotNight({ scheduler: sched, access, settings: settings() })));
    const row = saved.scheduler.people.find(p => p.id === ben.id);
    row.readySerial = sched.appearanceSerial + 1;
    row.emptiedAt = sched.appearanceSerial + 1;
    saved.scheduler.people.find(p => p.id === ana.id).readySerial = -4;
    const resumed = new Scheduler();
    restoreNight(saved, { scheduler: resumed, access: new TableAccess(), settings: settings() });
    const back = resumed.people.get(ben.id);
    assert.equal(back.readySerial, resumed.appearanceSerial, 'début d’attente ramené au compteur');
    assert.equal(back.emptiedAt, undefined, 'marque d’échange future abandonnée');
    assert.equal(resumed.people.get(ana.id).readySerial, 0, 'début d’attente invalide remis à zéro');
  }

  {
    // Relecture (passe 4) : la reprise gardait les 200 dernières fins de
    // passage (`stageEnds`) dans l'ordre de la sauvegarde, avec sa propre
    // copie de la limite. Comme endStage, elle garde les STAGE_ENDS_LIMIT
    // plus grands tours : les plus petits partent d'abord, quel que soit
    // l'ordre des lignes (ici les plus grands tours d'abord).
    const total = STAGE_ENDS_LIMIT + 50;
    const rows = Array.from({ length: total }, (_, k) => [total - k, 1000 * (total - k)]);
    const live = new Scheduler();
    live.appearanceSerial = total;
    for (const [turn, at] of rows) live.endStage({ turn }, at);
    assert.equal(live.stageEnds.size, STAGE_ENDS_LIMIT);
    const sched = new Scheduler();
    const access = new TableAccess();
    sched.table('1'); access.issue('1');
    sched.appearanceSerial = total;
    const saved = JSON.parse(JSON.stringify(snapshotNight({ scheduler: sched, access, settings: settings() })));
    saved.scheduler.stageEnds = rows;
    const resumed = new Scheduler();
    restoreNight(saved, { scheduler: resumed, access: new TableAccess(), settings: settings() });
    // En direct, endStage date la fin sur l'horloge des débuts d'attente :
    // on compare les tours gardés, et les heures à celles de la sauvegarde.
    const turns = map => [...map.keys()].sort((a, b) => a - b);
    assert.deepEqual(turns(resumed.stageEnds), turns(live.stageEnds), 'mêmes tours gardés qu’en direct');
    for (const [turn, at] of resumed.stageEnds) assert.equal(at, 1000 * turn, `heure de la sauvegarde gardée (tour ${turn})`);
    assert.equal(Math.min(...resumed.stageEnds.keys()), total - STAGE_ENDS_LIMIT + 1, 'les plus petits tours partent d’abord');
  }

  console.log('ok - reprise après crash : file, titres, duos, téléphones, QR, écritures atomiques et envoi ambigu');
} finally {
  // Ce dossier est créé exclusivement sous le répertoire temporaire du test.
  if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
