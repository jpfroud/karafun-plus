'use strict';
// Retours du 4 octobre, côté serveur : accès solo (QR compté à l'ouverture,
// prénom obligatoire, récupération par le QR personnel), événement privé (un
// seul QR pour tout le monde), dernière activité des personnes et QR de table
// partagé depuis un téléphone.
//
// Regression: retours de la soirée du 4 octobre — QR solo expiré avant la
// saisie du prénom, solo qui perd sa page (neuf transferts par le bar).
//
// Même harnais que server-table-routes.test.js : server.js chargé dans un bac
// à sable `vm`, sans port, disque en mémoire, faux magasin de soirée.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));
// Plafonds de l'événement privé (valeurs vérifiées par private-event.test.js).
const { PrivateEvent, MAX_PEOPLE, MAX_EVENT_PEOPLE } = fromServer('./private-event');

function memoryDisk() {
  const disk = new Map();
  const inMemory = file => [path.join(root, 'data'), path.join(root, 'journal')]
    .some(dir => file === dir || String(file).startsWith(dir + path.sep));
  const missing = file => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  const memFs = { ...fs,
    existsSync: file => inMemory(file) ? disk.has(file) : fs.existsSync(file),
    readFileSync(file, ...rest) {
      if (!inMemory(file)) return fs.readFileSync(file, ...rest);
      if (!disk.has(file)) throw missing(file);
      return disk.get(file);
    },
    writeFileSync(file, data) { disk.set(file, String(data)); },
    appendFileSync(file, data) { disk.set(file, (disk.get(file) || '') + data); },
    renameSync(from, to) { if (!disk.has(from)) throw missing(from); disk.set(to, disk.get(from)); disk.delete(from); },
    unlinkSync(file) { disk.delete(file); },
    mkdirSync() {}, readdirSync() { return []; } };
  return { disk, memFs };
}

function fakeNightStore() {
  const control = { saves: [], fail: null };
  class Store {
    load() { return null; }
    save(snapshot) {
      if (control.fail) throw new Error(control.fail);
      control.saves.push(JSON.parse(JSON.stringify(snapshot)));
      return true;
    }
  }
  return { control, Store };
}

// clock : server.js lit l'heure de ce fichier (Date.now remplaçable par le test).
// modules : modules remplacés pour ce test (qrcode, pour retenir un QR en cours).
function harness({ persistent = false, clock = false, modules = {} } = {}) {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const memory = memoryDisk();
  const night = fakeNightStore();
  const overrides = persistent ? {
    './night-state': { ...fromServer('./night-state'), NightStateStore: night.Store },
    './scheduler': (() => {
      const real = fromServer('./scheduler');
      return { ...real, Scheduler: class extends real.Scheduler { constructor(o) { super({ ...o, solverEnabled: false }); } } };
    })(),
    './spotify': (() => {
      const real = fromServer('./spotify');
      return { ...real, SpotifyLink: class extends real.SpotifyLink { constructor(o) { super({ ...o, file: null }); } } };
    })(),
  } : {};
  Object.assign(overrides, modules);
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), ...(persistent ? [] : ['--demo'])];
  const context = { require: name => name === 'fs' ? memory.memFs : overrides[name] || fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL, setTimeout, clearTimeout,
    setImmediate, AbortSignal, ...(clock ? { Date } : {}) };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, access, soloInvitations, privateEvent, battleVote, staffState, journal,
      ensureSoloGroup, clearEvening, battleElectorate, saveNight, journalRoster, journalSample, publicState, transferSnapshot, personShareCodes,
      STAFF_KEY, PORT, PUBLIC_PORT, handle: server.listeners('request')[0], setTracked: value => { tracked = value; },
      setPending: value => { pending = value; } };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  f.journal.start({});
  return Object.assign(f, { night: night.control });
}

function call(f, method, url, { body, cookie, headers = {}, port = f.PORT, remote = '127.0.0.1' } = {}) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers: { ...headers, ...(cookie ? { cookie } : {}) },
      socket: { remoteAddress: remote, localPort: port }, destroy() {} });
    const out = { status: null, headers: {} };
    const res = {
      setHeader(name, value) { out.headers[name.toLowerCase()] = value; },
      getHeader(name) { return out.headers[name.toLowerCase()]; },
      hasHeader(name) { return name.toLowerCase() in out.headers; },
      removeHeader(name) { delete out.headers[name.toLowerCase()]; },
      writeHead(status, headers = {}) {
        out.status = status;
        for (const [name, value] of Object.entries(headers)) out.headers[name.toLowerCase()] = value;
      },
      end(data = '') {
        out.text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        out.body = out.text && /json/.test(out.headers['content-type'] || '') ? JSON.parse(out.text) : out.text;
        resolve(out);
      },
    };
    f.handle(req, res);
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  });
}
const post = (f, url, body, options = {}) => call(f, 'POST', url, { ...options, body });
const get = (f, url, options = {}) => call(f, 'GET', url, options);
const staff = (f, route) => `${route}${route.includes('?') ? '&' : '?'}key=${encodeURIComponent(f.STAFF_KEY)}`;
const cookieOf = r => r.headers['set-cookie'] ? String(r.headers['set-cookie']).split(';')[0] : null;
const plain = value => JSON.parse(JSON.stringify(value));
const song = (songId, title) => ({ songId, title, artist: 'Artiste' });
const events = (f, type) => f.journal.current.events.filter(e => !type || e.ev === type);

function openSolo(f) {
  f.ensureSoloGroup();
  const tb = { table: 'Comptoir', access: f.access.get('Comptoir') };
  return { tb, invite: () => f.soloInvitations.issue('Comptoir').token };
}
function openTable(f, id, headcount = 4) {
  f.sched.table(id).headcount = headcount;
  return { table: id, access: f.access.issue(id) };
}
async function opened(f, tb, invitation, cookie) {
  const r = await post(f, '/api/table/solo/open', { ...tb, invitation }, { cookie });
  assert.equal(r.status, 200, r.text);
  return { ...tb, personId: r.body.id, token: r.body.token, cookie: cookieOf(r) || cookie, body: r.body };
}
const stateOf = (f, tb, me, extra = {}) => get(f, `/api/state?table=${encodeURIComponent(tb.table)}&access=${tb.access}`,
  { cookie: me?.cookie, headers: { 'x-person-tokens': JSON.stringify(me ? [me.token] : []), ...extra } });

// ---------------------------------------------------------------- A1 : le QR individuel compte à l'ouverture
test('QR individuel : l’ouverture crée la personne « Solo 1 » avec prénom obligatoire, idempotente, sans journal', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const token = invite();
  // Une lecture d'état (aperçu de lien, page chargée) ne crée personne.
  const preview = await get(f, `/api/state?table=Comptoir&access=${tb.access}&invitation=${token}`);
  assert.equal(preview.body.soloInvitationReady, true);
  assert.equal(f.sched.people.size, 0, 'un aperçu de lien ne crée personne');

  const sam = await opened(f, tb, token);
  assert.deepEqual(Object.keys(sam.body).sort(), ['id', 'nameRequired', 'token']);
  assert.equal(sam.body.nameRequired, true);
  assert.ok(sam.cookie, 'le téléphone reçoit son identité solo');
  const person = f.sched.people.get(sam.personId);
  assert.equal(person.name, 'Solo 1');
  assert.equal(person.nameRequired, true);
  assert.equal(person.soloKeyHash, crypto.createHash('sha256').update(token).digest('hex'),
    'le QR individuel devient la clé personnelle (empreinte seulement)');
  assert.equal(f.soloInvitations.verify(token, 'Comptoir'), null, 'invitation consommée dès l’ouverture');
  assert.deepEqual(events(f, 'person.joined'), [], 'une ouverture sans prénom n’est pas une inscription');

  // Même téléphone qui rouvre le même QR : la même personne, rien de créé.
  const again = await opened(f, tb, token, sam.cookie);
  assert.equal(again.personId, sam.personId);
  assert.equal(again.token, sam.token);
  assert.equal(again.body.nameRequired, true);
  assert.equal(f.sched.people.size, 1);

  // La page de cette personne sait qu'il faut un prénom.
  const view = (await stateOf(f, tb, sam)).body;
  assert.deepEqual(view.managedIds, [sam.personId]);
  assert.equal(view.me.nameRequired, true);
  assert.equal(view.tablePeople[0].nameRequired, true);
  // Le bar la voit dès l'ouverture, avec la mention à afficher.
  const row = plain(f.staffState()).people.find(p => p.id === sam.personId);
  assert.equal(row.nameRequired, true);
  assert.equal(row.joinedAt, person.joinedAt);

  // Une deuxième personne prend le plus petit numéro libre.
  const second = await opened(f, tb, invite());
  assert.equal(f.sched.people.get(second.personId).name, 'Solo 2');
  f.sched.people.get(sam.personId).name = 'Anna';
  const third = await opened(f, tb, invite());
  assert.equal(f.sched.people.get(third.personId).name, 'Solo 1', 'numéro libéré réutilisé');
});

test('prénom obligatoire : titres, duos et Battle refusés, exclue des votants et des partenaires, puis prénom', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  const body = extra => ({ ...tb, personId: sam.personId, token: sam.token, ...extra });
  const refused = async (route, extra) => {
    const r = await post(f, route, body(extra), { cookie: sam.cookie });
    assert.equal(r.status, 400, `${route} : ${r.text}`);
    assert.equal(r.body.code, 'NAME_REQUIRED');
    assert.equal(r.body.error, 'Indique d’abord ton prénom.');
  };
  await refused('/api/table/song', { song: song(1, 'Sans prénom') });
  await refused('/api/table/duet', { partnerId: 'x', song: song(2, 'Duo') });
  await refused('/api/table/duet/answer', { accept: true, entryId: 'x' });
  await refused('/api/table/duet/join', { ownerId: 'x', entryId: 'x' });
  await refused('/api/table/duet/join/answer', { accept: true, entryId: 'x', fromId: 'x' });
  await refused('/api/table/battle/propose', { songs: [song(3, 'B')] });
  await refused('/api/table/battle/vote', { choice: 1 });
  // Refuser un duo reste possible : ce n'est pas une participation.
  const decline = await post(f, '/api/table/duet/answer', body({ accept: false, entryId: 'x' }), { cookie: sam.cookie });
  assert.notEqual(decline.body.code, 'NAME_REQUIRED');
  // Ancienne API par jeton : même règle.
  for (const [route, extra] of [['/api/song', { song: song(4, 'Ancienne') }], ['/api/duet', { partnerId: 'x', song: song(5, 'D') }],
    ['/api/duet/answer', { accept: true, entryId: 'x' }]]) {
    const r = await post(f, route, { token: sam.token, ...extra }, { cookie: sam.cookie });
    assert.equal(r.body.code, 'NAME_REQUIRED', route);
  }
  assert.equal(f.sched.songsOf(f.sched.people.get(sam.personId)).length, 0);

  // Exclue de l'électorat Battle et de la liste des partenaires de duo.
  const tableTb = openTable(f, '4');
  const lea = await post(f, '/api/table/person', { ...tableTb, name: 'Léa' });
  assert.deepEqual(plain(f.battleElectorate()), [lea.body.id]);
  const partners = await get(f, `/api/duo/partners?table=4&access=${tableTb.access}`);
  assert.deepEqual(partners.body.map(p => p.name), ['Léa']);

  // Prénom déjà pris : le drapeau reste.
  const taken = await post(f, '/api/table/person/rename', body({ name: 'Léa' }), { cookie: sam.cookie });
  assert.equal(taken.status, 200, 'Léa est à une autre table : prénom libre ici');
  f.sched.people.get(sam.personId).nameRequired = true; // remis pour la suite du test
  f.sched.people.get(sam.personId).name = 'Solo 1';
  const other = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...tb, personId: other.personId, token: other.token, name: 'Zoé' }, { cookie: other.cookie });
  const duplicate = await post(f, '/api/table/person/rename', body({ name: 'zoé' }), { cookie: sam.cookie });
  assert.equal(duplicate.body.code, 'NAME_TAKEN');
  assert.equal(f.sched.people.get(sam.personId).nameRequired, true, 'un prénom refusé garde la fenêtre');

  // Premier vrai prénom : drapeau effacé, inscription notée au journal à ce moment.
  const before = events(f, 'person.joined').length;
  const named = await post(f, '/api/table/person/rename', body({ name: 'Sam' }), { cookie: sam.cookie });
  assert.equal(named.status, 200, named.text);
  const person = f.sched.people.get(sam.personId);
  assert.equal(person.name, 'Sam');
  assert.equal(person.nameRequired, undefined);
  const joined = events(f, 'person.joined').slice(before);
  assert.deepEqual(joined.map(e => [e.personId, e.tableId]), [[sam.personId, 'Comptoir']]);
  assert.equal(f.journal.current.meta.roster[sam.personId].name, 'Sam');
  assert.equal(events(f, 'person.renamed').filter(e => e.personId === sam.personId).length, 0,
    'le premier prénom n’est pas un changement de prénom');
  // Un prénom identique au provisoire est accepté tel quel.
  const keep = await opened(f, tb, invite());
  const kept = await post(f, '/api/table/person/rename', { ...tb, personId: keep.personId, token: keep.token,
    name: f.sched.people.get(keep.personId).name }, { cookie: keep.cookie });
  assert.equal(kept.status, 200);
  assert.equal(f.sched.people.get(keep.personId).nameRequired, undefined);
  await post(f, '/api/table/song', body({ song: song(6, 'Enfin') }), { cookie: sam.cookie });
  assert.equal(f.sched.songsOf(person).length, 1, 'une fois nommée, elle choisit ses titres');
  assert.ok(plain(f.battleElectorate()).includes(sam.personId));
});

test('journal : une ouverture abandonnée ne laisse aucun événement, même marquée partie', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  // Lecture d'état visible ou non : pas de « person.seen » pour une personne sans prénom.
  await stateOf(f, tb, sam, { 'x-page-visible': '1' });
  const leave = await post(f, staff(f, '/api/staff/person/leave'), { personId: sam.personId });
  assert.equal(leave.status, 200, leave.text);
  assert.deepEqual(events(f).filter(e => e.personId === sam.personId), []);
  assert.equal(f.journal.current.meta.roster[sam.personId], undefined, 'son prénom provisoire n’entre pas au journal');
});

test('QR individuel : refus inchangés (téléphone déjà solo, invitation expirée, autre groupe)', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  // Téléphone qui a déjà un prénom inscrit : un autre QR individuel est refusé
  // (une place encore sans prénom, elle, laisse la place au nouveau QR).
  const nina = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...tb, personId: nina.personId, token: nina.token, name: 'Nina' }, { cookie: nina.cookie });
  const second = await post(f, '/api/table/solo/open', { ...tb, invitation: invite() }, { cookie: nina.cookie });
  assert.equal(second.status, 403);
  assert.equal(second.body.code, 'SOLO_DEVICE_USED');

  const late = invite();
  f.soloInvitations.verify(late, 'Comptoir').expiresAt = Date.now() - 1;
  const expired = await post(f, '/api/table/solo/open', { ...tb, invitation: late });
  assert.equal(expired.status, 403);
  assert.equal(expired.body.code, 'SOLO_INVITATION');
  assert.equal(expired.body.error, 'Cette invitation a déjà été utilisée ou a expiré. Demande un nouveau QR individuel au bar.');
  const garbage = await post(f, '/api/table/solo/open', { ...tb, invitation: 'pas-un-jeton' });
  assert.equal(garbage.body.code, 'SOLO_INVITATION');

  const table = openTable(f, '2');
  const wrong = await post(f, '/api/table/solo/open', { ...table, invitation: invite() });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'Ce QR individuel n’est pas valable pour cette table.');
  assert.equal(f.sched.people.size, 2);

  // Ouverte avant l'expiration, la personne garde sa fenêtre de prénom ensuite.
  f.soloInvitations.clear();
  const reopen = await post(f, '/api/table/solo/open', { ...tb, invitation: 'x'.repeat(32) }, { cookie: sam.cookie });
  assert.equal(reopen.status, 403, 'un autre jeton inconnu reste refusé');
  assert.equal(reopen.body.code, 'SOLO_INVITATION');
  const named = await post(f, '/api/table/person/rename', { ...tb, personId: sam.personId, token: sam.token, name: 'Sam' },
    { cookie: sam.cookie });
  assert.equal(named.status, 200, '30 min plus tard, le prénom se donne encore');
});

test('QR individuel : sauvegarde impossible = rien de créé, invitation intacte, pas de cookie', async () => {
  const f = harness({ persistent: true });
  const { tb, invite } = openSolo(f);
  const token = invite();
  f.night.fail = 'disque plein';
  const r = await post(f, '/api/table/solo/open', { ...tb, invitation: token });
  assert.equal(r.status, 400);
  assert.equal(f.sched.people.size, 0);
  assert.equal(r.headers['set-cookie'], undefined);
  assert.ok(f.soloInvitations.verify(token, 'Comptoir'), 'le QR reste utilisable');
  f.night.fail = null;
  const ok = await opened(f, tb, token);
  assert.equal(f.night.saves.at(-1).scheduler.people.find(p => p.id === ok.personId).nameRequired, true,
    'personne provisoire sauvegardée avec son drapeau');
});

// ---------------------------------------------------------------- A2 : récupération par le QR personnel
test('QR personnel rouvert ailleurs : même personne proposée, récupération par la clé, l’ancien téléphone perd l’accès', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const token = invite();
  const first = await opened(f, tb, token);
  await post(f, '/api/table/person/rename', { ...tb, personId: first.personId, token: first.token, name: 'Clara' },
    { cookie: first.cookie });

  // Autre navigateur (scanner intégré, onglet privé…) : rien de créé, une proposition.
  const elsewhere = await post(f, '/api/table/solo/open', { ...tb, invitation: token });
  assert.equal(elsewhere.status, 200, elsewhere.text);
  assert.deepEqual(elsewhere.body, { recover: { id: first.personId, name: 'Clara' } });
  assert.equal(elsewhere.headers['set-cookie'], undefined, 'pas de cookie avant la confirmation');
  assert.equal(f.sched.people.size, 1);

  // Confirmation : même effet qu'une reprise par le bar.
  const claimed = await post(f, '/api/table/person/claim', { ...tb, key: token });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.id, first.personId);
  assert.notEqual(claimed.body.token, first.token);
  const next = { ...tb, personId: first.personId, token: claimed.body.token, cookie: cookieOf(claimed) };
  assert.ok(next.cookie && next.cookie !== first.cookie);
  assert.equal(f.sched.people.size, 1, 'jamais une deuxième place');
  assert.deepEqual((await stateOf(f, tb, next)).body.managedIds, [first.personId]);
  assert.deepEqual((await stateOf(f, tb, first)).body.managedIds, [], 'l’ancien téléphone perd l’accès');
  assert.ok(events(f, 'person.transferred').some(e => e.personId === first.personId));
  assert.ok(f.sched.people.get(first.personId).lastActionAt > 0, 'une récupération compte comme activité');

  // L'ancien téléphone rouvre son QR : proposition de récupération, pas de retour silencieux.
  const oldPhone = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: first.cookie });
  assert.deepEqual(oldPhone.body, { recover: { id: first.personId, name: 'Clara' } });
  // Le nouveau téléphone le rouvre : sa personne, sans rien changer.
  const same = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: next.cookie });
  assert.deepEqual([same.body.id, same.body.token, same.body.nameRequired], [first.personId, next.token, false]);

  // Un téléphone qui gère déjà un autre solo (avec son prénom) ne prend pas Clara.
  const bob = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...tb, personId: bob.personId, token: bob.token, name: 'Bob' }, { cookie: bob.cookie });
  const bobTakes = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: bob.cookie });
  assert.equal(bobTakes.body.code, 'SOLO_DEVICE_USED');
  const bobClaims = await post(f, '/api/table/person/claim', { ...tb, key: token }, { cookie: bob.cookie });
  assert.equal(bobClaims.body.code, 'SOLO_DEVICE_USED');

  // Clé inconnue ou mal formée : la réponse d'une clé morte.
  for (const key of ['x'.repeat(32), 'court', 42]) {
    const bad = await post(f, '/api/table/person/claim', { ...tb, key });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.code, 'SOLO_KEY_REVOKED');
    assert.equal(bad.body.error, 'Ce QR personnel n’est plus valable. Demande au bar un QR de reprise.');
  }

  // Marquée partie : la clé ne sert plus ; une nouvelle soirée l'efface aussi.
  await post(f, staff(f, '/api/staff/person/leave'), { personId: first.personId });
  const gone = await post(f, '/api/table/solo/open', { ...tb, invitation: token });
  assert.equal(gone.body.code, 'PERSON_LEFT', 'ailleurs aussi : « marquée partie »');
  // Son propre navigateur rouvre la clé : « marquée partie », pas « invitation utilisée ».
  const mine = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: next.cookie });
  assert.equal(mine.status, 403, 'même statut que le QR de l’événement et les autres routes');
  assert.equal(mine.body.code, 'PERSON_LEFT');
  assert.equal(mine.body.error, 'Cette personne a été marquée partie. Demande au bar de la réactiver.');
  // Troisième passe de la relecture finale : la reprise par la clé répond
  // comme son ouverture tant qu'elle est partie (D2).
  const keyClaim = await post(f, '/api/table/person/claim', { ...tb, key: token });
  assert.deepEqual([keyClaim.status, keyClaim.body.code], [403, 'PERSON_LEFT'], 'partie : « marquée partie », comme l’ouverture');
});

test('QR personnel d’une personne encore sans prénom : récupérée sans confirmation', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const token = invite();
  const first = await opened(f, tb, token);
  const second = await post(f, '/api/table/solo/open', { ...tb, invitation: token });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.id, first.personId);
  assert.equal(second.body.nameRequired, true);
  assert.equal(second.body.recovered, true);
  assert.notEqual(second.body.token, first.token);
  assert.ok(cookieOf(second) && cookieOf(second) !== first.cookie);
  assert.equal(f.sched.people.size, 1);
  assert.deepEqual((await stateOf(f, tb, first)).body.managedIds, []);
  assert.deepEqual(events(f, 'person.transferred'), [], 'personne sans prénom : rien au journal');
});

test('inscription par l’ancien formulaire : le QR devient aussi la clé personnelle', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const token = invite();
  const joined = await post(f, '/api/join', { ...tb, name: 'Nina', invitation: token });
  assert.equal(joined.status, 200, joined.text);
  const person = f.sched.people.get(joined.body.id);
  assert.equal(person.nameRequired, undefined);
  assert.ok(person.soloKeyHash);
  const elsewhere = await post(f, '/api/table/solo/open', { ...tb, invitation: token });
  assert.deepEqual(elsewhere.body, { recover: { id: joined.body.id, name: 'Nina' } });
});

// ---------------------------------------------------------------- doublon marqué parti
// Regression: un navigateur qui a créé un doublon (QR de l'événement rescanné
// depuis une autre application) ne pouvait plus reprendre son ancien profil,
// même après que le bar avait marqué le doublon « Parti » : la reprise
// répondait « Ce téléphone a déjà un prénom inscrit. ».
// Chaque entrée vient d'un téléphone distinct (30 créations par minute et par appareil).
let eventDevices = 0;
async function eventEntry(f, tb, secret, name, cookie) {
  const r = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie, remote: `10.1.${eventDevices >> 8 & 255}.${eventDevices++ & 255}` });
  assert.equal(r.status, 200, r.text);
  const me = { ...tb, personId: r.body.id, token: r.body.token, cookie: cookieOf(r) || cookie };
  if (name) {
    const named = await post(f, '/api/table/person/rename', { ...tb, personId: me.personId, token: me.token, name }, { cookie: me.cookie });
    assert.equal(named.status, 200, named.text);
  }
  return me;
}
const linkOf = share => new URL(share.body.url).searchParams.get('reprise');

test('doublon parti : le QR de reprise rend l’ancien profil à ce navigateur ; un doublon encore actif bloque toujours', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  // Léa s'inscrit depuis le scanner d'Instagram, puis perd sa page et
  // rescanne depuis Snapchat : un deuxième chanteur (D1).
  const lea = await eventEntry(f, tb, secret, 'Léa');
  assert.equal((await post(f, '/api/table/song', { ...lea, song: song(7, 'Ma chanson') }, { cookie: lea.cookie })).status, 200);
  const dup = await eventEntry(f, tb, secret, 'Léa B.');

  // Doublon encore actif : toujours une seule place active par navigateur.
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  const blocked = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: dup.cookie });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'SOLO_DEVICE_USED');

  // Le bar marque le doublon parti : la reprise passe.
  assert.equal((await post(f, staff(f, '/api/staff/person/leave'), { personId: dup.personId })).status, 200);
  const offer = (await get(f, `/api/state?table=Comptoir&access=${tb.access}&reprise=${linkOf(share)}`,
    { cookie: dup.cookie, headers: { 'x-person-tokens': JSON.stringify([dup.token]) } })).body.transferOffer;
  assert.deepEqual(plain(offer).personId, lea.personId);
  const claimed = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: dup.cookie });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.id, lea.personId);
  const back = { ...tb, personId: lea.personId, token: claimed.body.token, cookie: cookieOf(claimed) };
  assert.ok(back.cookie && back.cookie !== dup.cookie);
  const view = (await get(f, `/api/state?table=Comptoir&access=${tb.access}`,
    { cookie: back.cookie, headers: { 'x-person-tokens': JSON.stringify([back.token, dup.token]) } })).body;
  assert.deepEqual(view.managedIds, [lea.personId], 'ses chansons reviennent, le doublon parti n’est pas géré');
  assert.deepEqual(view.tablePeople[0].songs.map(s => s.title), ['Ma chanson']);
  assert.deepEqual((await stateOf(f, tb, lea)).body.managedIds, [], 'l’ancien navigateur perd l’accès');
  // Le même navigateur rescanne le QR de l'événement : Léa, rien de créé.
  const rescan = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: back.cookie });
  assert.deepEqual([rescan.body.id, rescan.body.resumed], [lea.personId, true]);
  assert.equal(f.sched.people.size, 2);

  // Ce navigateur gère Léa (active) : il ne prend pas un troisième profil.
  const max = await eventEntry(f, tb, secret, 'Max');
  const maxShare = await post(f, staff(f, '/api/staff/person/share'), { personId: max.personId });
  const twice = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(maxShare) }, { cookie: back.cookie });
  assert.equal(twice.body.code, 'SOLO_DEVICE_USED');

  // Le bar réactive le doublon : il revient sans téléphone, jamais une
  // deuxième place active pour le navigateur de Léa.
  assert.equal((await post(f, staff(f, '/api/staff/person/reactivate'), { personId: dup.personId })).status, 200);
  assert.equal(f.sched.people.get(dup.personId).withdrawnAt, null);
  const after = (await get(f, `/api/state?table=Comptoir&access=${tb.access}`,
    { cookie: back.cookie, headers: { 'x-person-tokens': JSON.stringify([back.token, dup.token]) } })).body;
  assert.deepEqual(after.managedIds, [lea.personId]);
  const dupSong = await post(f, '/api/table/song', { ...dup, song: song(8, 'Autre') }, { cookie: back.cookie });
  assert.equal(dupSong.body.code, 'SOLO_DEVICE_ACCESS');
  // Même avec son ancien cookie (navigateur qui n'aurait pas gardé le nouveau).
  assert.deepEqual((await stateOf(f, tb, dup)).body.managedIds, [], 'le doublon réactivé n’a plus de téléphone');
  assert.equal((await post(f, '/api/table/song', { ...dup, song: song(8, 'Autre') }, { cookie: dup.cookie })).body.code, 'SOLO_DEVICE_ACCESS');
  // Le bar peut le confier à un téléphone par son propre QR de reprise.
  const dupShare = await post(f, staff(f, '/api/staff/person/share'), { personId: dup.personId });
  const handed = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(dupShare) });
  assert.equal(handed.status, 200, handed.text);
});

test('doublon parti : le QR personnel et le code à 4 chiffres reprennent l’ancien profil ; créer une place reste refusé', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const key = invite();
  const clara = await opened(f, tb, key);
  await post(f, '/api/table/person/rename', { ...tb, personId: clara.personId, token: clara.token, name: 'Clara' }, { cookie: clara.cookie });
  // Clara rescanne par erreur le QR de l'événement dans un autre navigateur.
  const dup = await eventEntry(f, tb, secret, 'Clara B.');
  assert.equal((await post(f, '/api/table/solo/open', { ...tb, invitation: key }, { cookie: dup.cookie })).body.code, 'SOLO_DEVICE_USED');
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, key }, { cookie: dup.cookie })).body.code, 'SOLO_DEVICE_USED');

  await post(f, staff(f, '/api/staff/person/leave'), { personId: dup.personId });
  // Créer une NOUVELLE place depuis ce navigateur reste refusé, en disant
  // pourquoi (troisième relecture finale, ADV F2) : le bar le réactive.
  assert.equal((await post(f, '/api/table/solo/open', { ...tb, invitation: invite() }, { cookie: dup.cookie })).body.code, 'PERSON_LEFT');
  assert.equal((await post(f, '/api/join', { ...tb, name: 'Zoé', invitation: invite() }, { cookie: dup.cookie })).body.code, 'PERSON_LEFT');
  // Même navigateur qui rescanne l'événement : son doublon parti, pas un troisième chanteur.
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: dup.cookie })).body.code, 'PERSON_LEFT');
  assert.equal(f.sched.people.size, 2);

  // Son QR personnel : « C'est bien toi, Clara ? », puis la reprise.
  const offer = await post(f, '/api/table/solo/open', { ...tb, invitation: key }, { cookie: dup.cookie });
  assert.deepEqual(offer.body, { recover: { id: clara.personId, name: 'Clara' } });
  const claimed = await post(f, '/api/table/person/claim', { ...tb, key }, { cookie: dup.cookie });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.id, clara.personId);
  const back = { ...tb, personId: clara.personId, token: claimed.body.token, cookie: cookieOf(claimed) };
  assert.deepEqual((await stateOf(f, tb, back)).body.managedIds, [clara.personId]);
  assert.deepEqual((await stateOf(f, tb, clara)).body.managedIds, []);

  // Code à 4 chiffres, en secours : un autre doublon parti ne le cache ni ne le bloque.
  const second = await eventEntry(f, tb, secret, 'Clara C.');
  await post(f, staff(f, '/api/staff/person/leave'), { personId: second.personId });
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: clara.personId });
  const listed = (await stateOf(f, tb, second)).body.recoveryPeople;
  assert.deepEqual(plain(listed), [{ id: clara.personId, name: 'Clara' }]);
  const byCode = await post(f, '/api/table/person/claim', { ...tb, personId: clara.personId, code: share.body.code }, { cookie: second.cookie });
  assert.equal(byCode.status, 200, byCode.text);
  assert.deepEqual((await stateOf(f, tb, back)).body.managedIds, [], 'le navigateur précédent perd l’accès');
});

// Regression: en quittant sa place partie, un navigateur rendait la main au
// téléphone précédent de cette place (celui qu'un transfert avait écarté) :
// réactivée, la personne revenait sur ce vieux navigateur.
test('doublon parti : la place quittée ne revient pas au navigateur qu’un transfert avait écarté', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const takeOver = async (personId, cookie) => {
    const share = await post(f, staff(f, '/api/staff/person/share'), { personId });
    const r = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie });
    assert.equal(r.status, 200, r.text);
    return { ...tb, personId, token: r.body.token, cookie: cookieOf(r) || cookie };
  };
  for (const viaKey of [false, true]) {
    const key = viaKey ? invite() : null;
    // Bea s'inscrit sur le navigateur Z ; le bar la confie au navigateur Y.
    const z = viaKey ? await opened(f, tb, key) : await eventEntry(f, tb, secret);
    await post(f, '/api/table/person/rename', { ...tb, personId: z.personId, token: z.token, name: viaKey ? 'Bea K' : 'Bea' }, { cookie: z.cookie });
    const y = await takeOver(z.personId, undefined);
    const other = await eventEntry(f, tb, secret, viaKey ? 'Abel K' : 'Abel');
    // Bea est marquée partie ; Y reprend un autre profil (A).
    await post(f, staff(f, '/api/staff/person/leave'), { personId: z.personId });
    await takeOver(other.personId, y.cookie);
    // Le bar réactive Bea : elle revient sans téléphone, Z reste écarté.
    assert.equal((await post(f, staff(f, '/api/staff/person/reactivate'), { personId: z.personId })).status, 200);
    if (viaKey) {
      // Sa clé personnelle est morte au départ (quatrième relecture finale, D2).
      const reopened = await post(f, '/api/table/solo/open', { ...tb, invitation: key }, { cookie: z.cookie });
      assert.equal(reopened.body.token, undefined, 'clé personnelle rouverte par Z : pas de jeton direct');
      assert.equal(reopened.body.code, 'SOLO_KEY_REVOKED');
    } else {
      const rescan = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: z.cookie });
      assert.notEqual(rescan.body.id, z.personId, 'QR de l’événement rescanné par Z : pas Bea');
      assert.equal(rescan.body.resumed, undefined);
    }
    assert.ok(!(await stateOf(f, tb, z)).body.managedIds.includes(z.personId), 'Z ne gère plus Bea');
    // Le bar peut toujours la confier à un téléphone.
    await takeOver(z.personId, undefined);
  }
});

test('doublon parti : sauvegarde impossible pendant la reprise = doublon et ancien profil intacts', async () => {
  const f = harness({ persistent: true });
  const { tb } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const lea = await eventEntry(f, tb, secret, 'Léa');
  const dup = await eventEntry(f, tb, secret, 'Léa B.');
  await post(f, staff(f, '/api/staff/person/leave'), { personId: dup.personId });
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  const before = plain([f.sched.people.get(lea.personId).soloDeviceHashes, f.sched.people.get(dup.personId).soloDeviceHashes]);
  f.night.fail = 'disque plein';
  const r = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: dup.cookie });
  assert.equal(r.status, 400);
  assert.deepEqual(plain([f.sched.people.get(lea.personId).soloDeviceHashes, f.sched.people.get(dup.personId).soloDeviceHashes]), before);
  assert.deepEqual((await stateOf(f, tb, lea)).body.managedIds, [lea.personId], 'Léa reste sur son navigateur');
  f.night.fail = null;
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: dup.cookie })).status, 200);
});

// Regression: relecture finale (ADV3) — un invité qui rescanne le QR de
// l'événement depuis une autre application reçoit une place « Solo N » sans
// prénom ; cette place bloquait le QR de reprise, le lien de transfert et la
// clé personnelle (SOLO_DEVICE_USED), et son propre prénom était « déjà pris ».
const placeholderGone = (f, id) => {
  assert.equal(f.sched.people.has(id), false, 'la place provisoire est retirée');
  assert.ok(!plain(f.staffState().people).some(p => p.id === id), 'pas de « Solo N » chez le bar');
  assert.ok(!JSON.stringify(f.journal.current.events).includes(id), 'aucune trace au journal');
};

test('rescan : la place sans prénom de ce navigateur ne bloque ni le QR de reprise ni le lien de transfert', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const lea = await eventEntry(f, tb, secret, 'Léa');
  assert.equal((await post(f, '/api/table/song', { ...lea, song: song(7, 'Ma chanson') }, { cookie: lea.cookie })).status, 200);
  // Rescan depuis Snapchat : « Solo 2 », prénom demandé ; « Léa » est pris.
  const rescan = await eventEntry(f, tb, secret);
  assert.equal(f.sched.people.get(rescan.personId).nameRequired, true);
  const taken = await post(f, '/api/table/person/rename', { ...rescan, name: 'Léa' }, { cookie: rescan.cookie });
  assert.equal(taken.body.code, 'NAME_TAKEN');

  // Le bar donne à Léa un QR de reprise : la page l'ouvre sur ce navigateur.
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  const offer = (await get(f, `/api/state?table=Comptoir&access=${tb.access}&reprise=${linkOf(share)}`,
    { cookie: rescan.cookie, headers: { 'x-person-tokens': JSON.stringify([rescan.token]) } })).body.transferOffer;
  assert.equal(plain(offer).personId, lea.personId);
  const claimed = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: rescan.cookie });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.id, lea.personId);
  placeholderGone(f, rescan.personId);
  const back = { ...tb, personId: lea.personId, token: claimed.body.token, cookie: cookieOf(claimed) };
  const view = (await get(f, `/api/state?table=Comptoir&access=${tb.access}`,
    { cookie: back.cookie, headers: { 'x-person-tokens': JSON.stringify([back.token, rescan.token]) } })).body;
  assert.deepEqual(view.managedIds, [lea.personId]);
  assert.deepEqual(view.tablePeople[0].songs.map(s => s.title), ['Ma chanson']);
  assert.deepEqual((await stateOf(f, tb, lea)).body.managedIds, [], 'l’ancien navigateur perd l’accès');
  // Ce navigateur rescanne encore : Léa revient, rien n'est créé.
  const again = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: back.cookie });
  assert.deepEqual([again.body.id, again.body.resumed], [lea.personId, true]);
  assert.equal(f.sched.people.size, 1);

  // Même chose par le code à 4 chiffres (même route de reprise).
  const max = await eventEntry(f, tb, secret, 'Max');
  const other = await eventEntry(f, tb, secret);
  const code = await post(f, staff(f, '/api/staff/person/share'), { personId: max.personId });
  const byCode = await post(f, '/api/table/person/claim', { ...tb, personId: max.personId, code: code.body.code }, { cookie: other.cookie });
  assert.equal(byCode.status, 200, byCode.text);
  placeholderGone(f, other.personId);

  // Une place encore sans prénom mais avec un titre (cas impossible par les
  // routes) n'est jamais effacée : la reprise reste refusée.
  const odd = await eventEntry(f, tb, secret);
  f.sched.people.get(odd.personId).backlog.push({ songId: 9, title: 'Titre', artist: 'A' });
  const kept = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, link: linkOf(kept) }, { cookie: odd.cookie })).body.code, 'SOLO_DEVICE_USED');
  assert.ok(f.sched.people.has(odd.personId));
  // Une place nommée (un vrai doublon) bloque toujours.
  const named = await eventEntry(f, tb, secret, 'Léa B.');
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, link: linkOf(kept) }, { cookie: named.cookie })).body.code, 'SOLO_DEVICE_USED');
});

test('rescan : la clé personnelle reprend son profil malgré la place sans prénom de ce navigateur', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const key = invite();
  const clara = await opened(f, tb, key);
  await post(f, '/api/table/person/rename', { ...tb, personId: clara.personId, token: clara.token, name: 'Clara' }, { cookie: clara.cookie });
  const rescan = await eventEntry(f, tb, secret);
  const offer = await post(f, '/api/table/solo/open', { ...tb, invitation: key }, { cookie: rescan.cookie });
  assert.deepEqual(offer.body, { recover: { id: clara.personId, name: 'Clara' } });
  assert.ok(f.sched.people.has(rescan.personId), 'la proposition seule ne retire rien');
  const claimed = await post(f, '/api/table/person/claim', { ...tb, key }, { cookie: rescan.cookie });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.id, clara.personId);
  placeholderGone(f, rescan.personId);
  const back = { ...tb, personId: clara.personId, token: claimed.body.token, cookie: cookieOf(claimed) };
  assert.deepEqual((await stateOf(f, tb, back)).body.managedIds, [clara.personId]);

  // Clé d'une personne encore sans prénom : reprise directe, la place provisoire part aussi.
  const key2 = invite();
  const zoe = await opened(f, tb, key2);
  const rescan2 = await eventEntry(f, tb, secret);
  const direct = await post(f, '/api/table/solo/open', { ...tb, invitation: key2 }, { cookie: rescan2.cookie });
  assert.equal(direct.status, 200, direct.text);
  assert.deepEqual([direct.body.id, direct.body.recovered, direct.body.nameRequired], [zoe.personId, true, true]);
  placeholderGone(f, rescan2.personId);
});

// Relecture finale (ADV2) : l'ancien navigateur de Léa (B1) rescanne le QR de
// l'événement après son passage sur Safari (B2), puis reprend Léa par un QR de
// reprise. Le rescan remplace le cookie de B1 (celui de la place « Solo N ») :
// la reprise retire cette place, aucun « Solo N » ne reste chez le bar.
test('rescan : l’ancien navigateur de la personne reprise retire aussi sa place sans prénom', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const lea = await eventEntry(f, tb, secret, 'Léa');
  // Léa passe sur Safari (B2) par le QR de reprise du bar.
  const toSafari = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, link: linkOf(toSafari) })).status, 200);
  // De retour dans Instagram (B1), elle rescanne le QR de l'événement.
  const rescan = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: lea.cookie, remote: '10.0.4.1' });
  assert.equal(rescan.status, 200, rescan.text);
  assert.equal(rescan.body.nameRequired, true);
  const placeholder = rescan.body.id;
  const b1 = cookieOf(rescan) || lea.cookie;
  // Le bar lui redonne un QR de reprise, scanné dans B1.
  const back = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  const claimed = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(back) }, { cookie: b1 });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.id, lea.personId);
  placeholderGone(f, placeholder);
  const view = (await get(f, `/api/state?table=Comptoir&access=${tb.access}`, { cookie: cookieOf(claimed),
    headers: { 'x-person-tokens': JSON.stringify([claimed.body.token, rescan.body.token]) } })).body;
  assert.deepEqual(view.managedIds, [lea.personId]);
  assert.deepEqual(plain(f.staffState().people).map(p => p.name), ['Léa']);
});

test('rescan : sauvegarde impossible pendant la reprise = place provisoire et profil intacts', async () => {
  const f = harness({ persistent: true });
  const { tb } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const lea = await eventEntry(f, tb, secret, 'Léa', undefined);
  const rescan = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.0.9' });
  const dup = { ...tb, personId: rescan.body.id, token: rescan.body.token, cookie: cookieOf(rescan) };
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  f.night.fail = 'disque plein';
  const r = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: dup.cookie });
  assert.equal(r.status, 400);
  assert.ok(f.sched.people.has(dup.personId), 'la place provisoire revient');
  assert.equal(f.sched.person(dup.token)?.id, dup.personId);
  assert.deepEqual((await stateOf(f, tb, dup)).body.managedIds, [dup.personId]);
  assert.deepEqual((await stateOf(f, tb, lea)).body.managedIds, [lea.personId], 'Léa reste sur son navigateur');
  f.night.fail = null;
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: dup.cookie })).status, 200);
  assert.equal(f.sched.people.has(dup.personId), false);
});

// ---------------------------------------------------------------- B : événement privé
test('événement privé : interrupteur du bar, QR unique, même navigateur = même chanteur, autre = nouveau', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const fresh = 'A'.repeat(22);
  // Mode coupé : le QR est refusé.
  const refused = await post(f, '/api/table/enter', { ...tb, event: fresh });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'PRIVATE_EVENT');
  assert.equal(refused.body.error, 'Ce QR d’événement n’est plus actif. Demande au bar.');
  assert.deepEqual(plain(f.staffState().privateEvent), { enabled: false, url: null, qrUrl: null });
  assert.equal((await get(f, staff(f, '/qr-evenement.svg'))).status, 404, 'pas de QR tant que le mode est coupé');

  // Réservé au bar, jamais sur la prise publique.
  assert.equal((await post(f, '/api/staff/private-event', { enabled: true })).status, 403);
  assert.equal((await post(f, staff(f, '/api/staff/private-event'), { enabled: true }, { port: f.PUBLIC_PORT })).status, 403);
  assert.equal((await post(f, staff(f, '/api/staff/private-event'), { enabled: 'oui' })).status, 400);
  const rotateOff = await post(f, staff(f, '/api/staff/private-event'), { rotate: true });
  assert.equal(rotateOff.body.error, 'Active d’abord l’événement privé.');

  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.body.enabled, true);
  assert.equal(on.body.qrUrl, '/qr-evenement.svg');
  const url = new URL(on.body.url);
  assert.equal(url.pathname, `/t/Comptoir/${tb.access}`);
  const secret = url.searchParams.get('evenement');
  assert.match(secret, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(plain(f.staffState().privateEvent), plain(on.body));
  assert.ok(!JSON.stringify(plain(f.staffState().settings)).includes(secret), 'le secret n’est pas un réglage');
  const changed = events(f, 'settings.changed').filter(e => e.setting === 'privateEvent');
  assert.deepEqual(changed.map(e => [e.from, e.to]), [[false, true]]);
  assert.ok(!JSON.stringify(f.journal.current).includes(secret), 'jamais le secret au journal');
  const svg = await get(f, staff(f, '/qr-evenement.svg'));
  assert.equal(svg.status, 200);
  assert.match(svg.text, /<svg/);
  assert.equal((await get(f, '/qr-evenement.svg')).status, 403, 'QR réservé au bar');

  // Une lecture d'état ne crée personne et ne renvoie pas le secret.
  const ready = await get(f, `/api/state?table=Comptoir&access=${tb.access}&evenement=${secret}`);
  assert.equal(ready.status, 200, ready.text);
  assert.ok(!ready.text.includes(secret), 'la page ne reçoit pas le secret');
  assert.equal(f.sched.people.size, 0);

  // Premier scan : chanteur provisoire, prénom obligatoire.
  const a = await post(f, '/api/table/enter', { ...tb, event: secret });
  assert.equal(a.status, 200, a.text);
  assert.deepEqual(Object.keys(a.body).sort(), ['id', 'nameRequired', 'token']);
  const pa = f.sched.people.get(a.body.id);
  assert.equal(pa.name, 'Solo 1');
  assert.equal(pa.nameRequired, true);
  assert.equal(pa.viaEvent, true);
  assert.equal(pa.soloKeyHash, undefined, 'pas de clé personnelle par l’événement');
  const aCookie = cookieOf(a);
  // Même navigateur qui rescanne : son chanteur revient.
  const again = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: aCookie });
  assert.deepEqual([again.body.id, again.body.token, again.body.resumed], [a.body.id, a.body.token, true]);
  assert.equal(f.sched.people.size, 1);
  // Autre navigateur : toujours un nouveau chanteur (décision D1).
  const b = await post(f, '/api/table/enter', { ...tb, event: secret });
  assert.notEqual(b.body.id, a.body.id);
  assert.equal(f.sched.people.get(b.body.id).name, 'Solo 2');
  // Chaque participant ne voit que lui-même.
  const view = (await stateOf(f, tb, { token: a.body.token, cookie: aCookie })).body;
  assert.deepEqual(view.tablePeople.map(p => p.id), [a.body.id]);
  assert.equal(view.tablePeople[0].viaEvent, true, 'la page sait que son chanteur vient du QR de l’événement');
  assert.notEqual(f.sched.people.get(a.body.id).group, f.sched.people.get(b.body.id).group, 'chacun son tour');
  // Prénom déjà pris : consigne d'ajouter une initiale côté page.
  await post(f, '/api/table/person/rename', { ...tb, personId: a.body.id, token: a.body.token, name: 'Marie' }, { cookie: aCookie });
  const dup = await post(f, '/api/table/person/rename', { ...tb, personId: b.body.id, token: b.body.token, name: 'Marie' },
    { cookie: cookieOf(b) });
  assert.equal(dup.body.code, 'NAME_TAKEN');
  // Les invitations individuelles fonctionnent toujours pendant l'événement.
  const solo = await opened(f, tb, f.soloInvitations.issue('Comptoir').token);
  assert.ok(solo.personId);
  assert.equal((await stateOf(f, tb, solo)).body.tablePeople[0].viaEvent, undefined, 'QR individuel : pas venu par l’événement');

  // Renouveler : l'ancien QR est refusé, les inscrits gardent leur accès.
  const rotated = await post(f, staff(f, '/api/staff/private-event'), { rotate: true });
  const next = new URL(rotated.body.url).searchParams.get('evenement');
  assert.notEqual(next, secret);
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret })).body.code, 'PRIVATE_EVENT');
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: next }, { cookie: aCookie })).body.id, a.body.id);
  assert.equal((await post(f, '/api/table/song', { ...tb, personId: a.body.id, token: a.body.token, song: song(7, 'Encore') },
    { cookie: aCookie })).status, 200);

  // Marquée partie : le même navigateur ne la recrée pas, le bar la réactive.
  await post(f, staff(f, '/api/staff/person/leave'), { personId: a.body.id });
  const left = await post(f, '/api/table/enter', { ...tb, event: next }, { cookie: aCookie });
  assert.equal(left.body.code, 'PERSON_LEFT');

  // Couper : QR refusé, secret gardé pour le rallumer.
  await post(f, staff(f, '/api/staff/private-event'), { enabled: false });
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: next })).status, 403);
  assert.equal(new URL((await post(f, staff(f, '/api/staff/private-event'), { enabled: true })).body.url)
    .searchParams.get('evenement'), next, 'couper puis rallumer garde le QR imprimé');

  // Pas pour une table ordinaire.
  const table = openTable(f, '3');
  assert.equal((await post(f, '/api/table/enter', { ...table, event: next })).body.code, 'PRIVATE_EVENT');

  // « Supprimer toutes les tables » coupe le mode et efface le secret.
  f.clearEvening();
  assert.equal(f.privateEvent.enabled, false);
  assert.equal(f.privateEvent.secret, null);
  assert.deepEqual(plain(f.staffState().privateEvent), { enabled: false, url: null, qrUrl: null });
});

// Regression: relecture finale (ADV1, S2) — un plafond de 30 créations par
// minute pour tout le bar et un plafond de 400 qui comptait aussi les partis :
// un script sans cookie bloquait les vrais invités, et le 31e invité de la
// minute était refusé.
// Regression: deuxième relecture finale (ADV F1, S2-2, A2-2) — 5 par appareil
// bloquaient tout un Wi-Fi qui sort par une seule adresse publique (tunnel) ;
// le refus répondait 400 sans dire quand réessayer.
test('événement privé : 30 créations par minute et par appareil, 120 pour le bar, 429 + Retry-After, X-Forwarded-For ignoré', async () => {
  const f = harness({ persistent: true });
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const enter = (remote, headers = {}) => post(f, '/api/table/enter', { ...tb, event: secret }, { remote, headers });
  f.night.fail = 'disque plein';
  const failed = await enter('10.0.0.1');
  assert.equal(failed.status, 400);
  assert.equal(f.sched.people.size, 0);
  assert.equal(failed.headers['set-cookie'], undefined);
  f.night.fail = null;
  // Une création annulée ne compte pas : trente de plus depuis le même appareil.
  for (let i = 0; i < 30; i++) assert.equal((await enter('10.0.0.1')).status, 200);
  const busy = await enter('10.0.0.1');
  assert.equal(busy.status, 429, 'trop de demandes : 429');
  assert.equal(busy.body.code, 'PRIVATE_EVENT_BUSY');
  assert.equal(busy.body.error, 'Trop d’inscriptions d’un coup : réessaie dans une minute.');
  const retryAfter = Number(busy.headers['retry-after']);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After : ${busy.headers['retry-after']}`);
  // Un en-tête X-Forwarded-For inventé ne change pas d'appareil.
  assert.equal((await enter('10.0.0.1', { 'x-forwarded-for': '10.9.9.9' })).body.code, 'PRIVATE_EVENT_BUSY');
  // Les autres invités entrent toujours.
  assert.equal((await enter('10.0.0.2')).status, 200, 'un autre appareil n’est pas bloqué');
  // Le bar entier : 120 par minute.
  for (let n = 3; f.sched.people.size < 120; n++) {
    for (let i = 0; i < 30 && f.sched.people.size < 120; i++) assert.equal((await enter(`10.0.1.${n}`)).status, 200);
  }
  const venue = await enter('10.0.2.1');
  assert.equal(venue.status, 429);
  assert.equal(venue.body.code, 'PRIVATE_EVENT_BUSY', '121e création de la minute : nouvel essai plus tard');
  assert.ok(Number(venue.headers['retry-after']) >= 1);
  assert.equal(f.sched.people.size, 120);
  const saved = f.night.saves.at(-1);
  assert.deepEqual(Object.keys(saved.privateEvent).sort(), ['enabled', 'secret', 'since']);
  assert.equal(saved.privateEvent.enabled, true);
  assert.equal(saved.scheduler.people.filter(p => p.viaEvent && p.nameRequired).length, 120);
});

// Regression: deuxième relecture finale (ADV F1, S2-1) — l'appareil était
// l'adresse exacte : un téléphone en IPv6 change d'adresse dans son /64 et
// passait la limite ; ::ffff:a.b.c.d comptait à part de a.b.c.d.
test('événement privé : un même /64 IPv6 est un seul appareil, une IPv4 mappée est son IPv4', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const enter = (remote, options = {}) => post(f, '/api/table/enter', { ...tb, event: secret }, { remote, ...options });
  for (let i = 1; i <= 30; i++) assert.equal((await enter(`2001:db8:5:6::${i.toString(16)}`)).status, 200);
  assert.equal((await enter('2001:db8:5:6:abcd:ef01:2345:6789')).body.code, 'PRIVATE_EVENT_BUSY', 'nouvelle adresse du même /64');
  assert.equal((await enter('2001:db8:5:7::1')).status, 200, 'autre /64 : autre appareil');
  for (let i = 0; i < 15; i++) assert.equal((await enter('::ffff:10.4.4.4')).status, 200);
  for (let i = 0; i < 15; i++) assert.equal((await enter('10.4.4.4')).status, 200);
  assert.equal((await enter('::ffff:10.4.4.4')).body.code, 'PRIVATE_EVENT_BUSY', 'IPv4 mappée et IPv4 : même appareil');
  // Par le tunnel : même règle sur l'adresse donnée par Cloudflare.
  const edge = ip => enter('127.0.0.1', { port: f.PUBLIC_PORT, headers: { 'cf-connecting-ip': ip } });
  for (let i = 1; i <= 30; i++) assert.equal((await edge(`2001:db8:9:9:${i.toString(16)}::1`)).status, 200);
  assert.equal((await edge('2001:db8:9:9:ffff::1')).body.code, 'PRIVATE_EVENT_BUSY');
});

// Regression: relecture finale (ADV1) — par le tunnel HTTPS (cloudflared vers
// le port clients, la configuration du guide), chaque invité arrive de
// 127.0.0.1 : la limite par appareil devenait 5 invités par minute pour tout
// le bar.
test('événement privé par le tunnel HTTPS : l’appareil est l’adresse donnée par Cloudflare', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const enter = headers => post(f, '/api/table/enter', { ...tb, event: secret },
    { port: f.PUBLIC_PORT, remote: '127.0.0.1', headers });
  for (let i = 1; i <= 8; i++) {
    const r = await enter({ 'cf-connecting-ip': `203.0.113.${i}` });
    assert.equal(r.status, 200, `invité ${i} : ${r.text}`);
  }
  // Un même invité reste limité à 30 par minute, même s'il invente X-Forwarded-For.
  for (let i = 0; i < 30; i++) assert.equal((await enter({ 'cf-connecting-ip': '198.51.100.7' })).status, 200);
  assert.equal((await enter({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '10.9.9.9' })).body.code, 'PRIVATE_EVENT_BUSY');
  // Tunnel sans cet en-tête : pas de limite par appareil, celle du bar (120) seulement.
  for (let i = 0; i < 31; i++) assert.equal((await enter({})).status, 200);
  // Sur le port du Wi-Fi, l'en-tête n'est pas cru : l'adresse de la connexion compte.
  const lan = (remote, ip) => post(f, '/api/table/enter', { ...tb, event: secret }, { remote, headers: { 'cf-connecting-ip': ip } });
  for (let i = 0; i < 30; i++) assert.equal((await lan('10.0.5.1', `192.0.2.${i}`)).status, 200);
  assert.equal((await lan('10.0.5.1', '192.0.2.99')).body.code, 'PRIVATE_EVENT_BUSY');
});

// Regression: deuxième relecture finale (ADV F1, A2-2) — 400 « Solo N » jamais
// nommés remplissaient l'événement pour toute la soirée ; complet répondait 400.
// Plafond ramené à 200 (MAX_PEOPLE) à la seconde passe de la quatrième. Sa
// vérification (adverse) : les places sans prénom des 10 dernières minutes y
// comptaient, alors qu'elles ne coûtent rien à la prévision (des rescans
// fermaient l'événement sous 200 invités) ; seules les personnes nommées
// comptent, les places sans prénom restent bornées par les fiches et le ménage.
test('événement privé : le plafond des présents (MAX_PEOPLE) compte les personnes nommées, pas les places sans prénom', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const crowd = [];
  for (let i = 0; i < MAX_PEOPLE; i++) {
    const p = f.sched.join({ tableId: 'Comptoir', name: `Invité ${i}` });
    p.viaEvent = true;
    crowd.push(p);
  }
  const full = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.3.1' });
  assert.equal(full.status, 403, 'complet : 403');
  assert.equal(full.body.code, 'PRIVATE_EVENT_FULL', `${MAX_PEOPLE} personnes nommées : plus de création par le QR commun`);
  assert.equal(full.body.error, 'L’événement est complet par ce QR : demande au bar un QR individuel.');
  assert.equal(full.headers['retry-after'], undefined, 'pas de nouvel essai annoncé');
  // Une personne marquée partie libère sa place ; des places sans prénom, même
  // récentes, ne la reprennent pas.
  f.sched.leave(crowd[0], 'staff');
  const places = [];
  for (let i = 0; i < 20; i++) {
    const r = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: `10.0.4.${i}` });
    assert.equal(r.status, 200, `place sans prénom n° ${i + 1} : ${r.text}`);
    places.push({ ...tb, personId: r.body.id, token: r.body.token, cookie: cookieOf(r) });
  }
  // Une fois nommée, une place compte.
  const named = await post(f, '/api/table/person/rename', { ...places[0], name: 'Tardive' }, { cookie: places[0].cookie });
  assert.equal(named.status, 200, named.text);
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.4.99' })).body.code, 'PRIVATE_EVENT_FULL',
    'une fois nommée, elle compte');
});

// Regression: vérification de la seconde passe de la quatrième relecture
// finale (adverse) — le plafond n'était vérifié qu'à la création : une place
// sans prénom ne comptait plus après 10 minutes, le QR laissait entrer une
// seconde vague, et le prénom donné ensuite ne revérifiait rien (400
// chanteurs nommés, la taille mesurée qui sature le serveur).
test('événement privé : le premier prénom d’une place du QR revérifie le plafond des nommés, même 10 minutes après', async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const f = harness({ clock: true });
    const { tb, invite } = openSolo(f);
    const secret = f.privateEvent.enable();
    // Trois invités ouvrent le QR et voient leur fenêtre de prénom, puis tardent.
    const late = [];
    for (let i = 0; i < 3; i++) late.push(await eventEntry(f, tb, secret));
    clock += 2000;
    for (const me of late) await stateOf(f, tb, me, { 'x-page-visible': '1' });
    clock += 10 * 60000;
    // Entre-temps, l'événement s'est rempli de personnes nommées.
    const crowd = [];
    for (let i = 0; i < MAX_PEOPLE - 1; i++) {
      const p = f.sched.join({ tableId: 'Comptoir', name: `Invité ${i}` });
      p.viaEvent = true;
      crowd.push(p);
    }
    const rename = (me, name) => post(f, '/api/table/person/rename', { ...me, name }, { cookie: me.cookie });
    assert.equal((await rename(late[0], 'Léa')).status, 200, `le prénom n° ${MAX_PEOPLE} passe`);
    const refused = await rename(late[1], 'Max');
    assert.deepEqual([refused.status, refused.body.code, refused.body.error],
      [403, 'PRIVATE_EVENT_FULL', 'L’événement est complet par ce QR : demande au bar un QR individuel.']);
    assert.equal(f.sched.people.get(late[1].personId).nameRequired, true, 'toujours sans prénom');
    // Une personne marquée partie libère sa place : le prénom passe.
    assert.equal((await post(f, staff(f, '/api/staff/person/leave'), { personId: crowd[0].id })).status, 200);
    assert.equal((await rename(late[1], 'Max')).status, 200);
    // Complet de nouveau : le QR individuel du bar, sur ce même navigateur,
    // remplace la place, et son prénom ne compte pas dans le plafond du QR commun.
    assert.equal((await rename(late[2], 'Zoé')).body.code, 'PRIVATE_EVENT_FULL');
    const personal = await opened(f, tb, invite(), late[2].cookie);
    assert.equal(f.sched.people.has(late[2].personId), false, 'la place de l’événement part');
    assert.equal((await rename(personal, 'Zoé')).status, 200);
  } finally {
    Date.now = realNow;
  }
});

// Regression: troisième passe de la relecture finale (tests) — le plafond
// était vérifié avant le prénom : à l'événement complet, une invitée qui
// tapait le prénom de son propre profil, déjà inscrit (page rouverte dans un
// autre navigateur), lisait « complet, demande au bar un QR individuel » au
// lieu de NAME_TAKEN récupérable (« Déjà inscrit ? J’ai un code »).
test('événement complet : un prénom déjà inscrit garde la réponse NAME_TAKEN récupérable, un prénom libre est refusé', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  for (let i = 0; i < MAX_PEOPLE - 2; i++) { const p = f.sched.join({ tableId: 'Comptoir', name: `Invité ${i}` }); p.viaEvent = true; }
  await eventEntry(f, tb, secret, 'Léa'); // Léa nommée : MAX_PEOPLE - 1
  const again = await eventEntry(f, tb, secret); // Léa rouvre le QR dans un autre navigateur
  const rename = name => post(f, '/api/table/person/rename', { ...again, name }, { cookie: again.cookie });
  const answer = r => [r.status, r.body.code, r.body.recoverable];
  assert.deepEqual(answer(await rename('Léa')), [400, 'NAME_TAKEN', true], `${MAX_PEOPLE - 1} nommés`);
  await eventEntry(f, tb, secret, 'Max'); // l'événement est complet
  assert.equal(PrivateEvent.full(f.sched.people.values()), true);
  assert.deepEqual(answer(await rename('Léa')), [400, 'NAME_TAKEN', true], 'complet : le prénom inscrit garde la reprise par code');
  assert.deepEqual(answer(await rename('léa')), [400, 'NAME_TAKEN', true], 'même casse différente');
  const free = await rename('Zoé');
  assert.deepEqual([free.status, free.body.code, free.body.error],
    [403, 'PRIVATE_EVENT_FULL', 'L’événement est complet par ce QR : demande au bar un QR individuel.']);
  assert.equal(f.sched.people.get(again.personId).nameRequired, true, 'toujours sans prénom');
});

// Regression: troisième passe de la relecture finale (tests, conseil) — la
// moitié « nameRequired » de la garde n'était pas testée : sans elle, une
// personne déjà nommée par le QR ne pourrait plus corriger son prénom une fois
// l'événement complet.
test('événement complet : une personne déjà nommée par le QR corrige son prénom', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  for (let i = 0; i < MAX_PEOPLE - 1; i++) { const p = f.sched.join({ tableId: 'Comptoir', name: `Invité ${i}` }); p.viaEvent = true; }
  const lea = await eventEntry(f, tb, secret, 'Lea'); // MAX_PEOPLE : complet
  assert.equal(PrivateEvent.full(f.sched.people.values()), true);
  const r = await post(f, '/api/table/person/rename', { ...lea, name: 'Léa' }, { cookie: lea.cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(f.sched.people.get(lea.personId).name, 'Léa');
});

// Regression: vérification de la seconde passe de la quatrième relecture
// finale (adverse) — avec les places sans prénom des 10 dernières minutes dans
// le plafond, un invité sur deux qui ouvre d'abord le QR dans le navigateur
// d'une application, puis dans le sien, faisait refuser des invités réels
// dès le n° 134 sur 180.
test('événement privé : MAX_PEOPLE invités entrent même quand un sur deux scanne le QR deux fois, le suivant est refusé', async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const f = harness({ clock: true });
    const { tb } = openSolo(f);
    const secret = f.privateEvent.enable();
    const enter = remote => post(f, '/api/table/enter', { ...tb, event: secret }, { remote });
    for (let g = 0; g < MAX_PEOPLE; g++) {
      clock += 3000;
      const remote = `10.70.${g >> 8 & 255}.${g & 255}`;
      if (g % 2 === 0) {
        // Navigateur de l'application : une place sans prénom, vue à l'écran.
        const inApp = await enter(remote);
        assert.equal(inApp.status, 200, `invité n° ${g + 1}, premier scan : ${inApp.text}`);
        clock += 1500;
        await stateOf(f, tb, { token: inApp.body.token, cookie: cookieOf(inApp) }, { 'x-page-visible': '1' });
      }
      // Son navigateur : une nouvelle place, puis son prénom.
      const r = await enter(remote);
      assert.equal(r.status, 200, `invité n° ${g + 1} : ${r.text}`);
      const named = await post(f, '/api/table/person/rename', { ...tb, personId: r.body.id, token: r.body.token, name: `Invité ${g}` },
        { cookie: cookieOf(r) });
      assert.equal(named.status, 200, `invité n° ${g + 1} : ${named.text}`);
    }
    clock += 3000;
    assert.equal((await enter('10.71.0.1')).body.code, 'PRIVATE_EVENT_FULL', `${MAX_PEOPLE} invités nommés : complet`);
  } finally {
    Date.now = realNow;
  }
});

// Regression: deuxième relecture finale (ADV F1, D2-4) — « Renouveler » ne
// faisait pas baisser le compte : les « Solo N » jamais nommés restaient.
test('événement privé : « Renouveler le QR » retire sans trace les places sans prénom ni titre venues par l’événement', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const lea = await eventEntry(f, tb, secret, 'Léa');
  const ghost = await eventEntry(f, tb, secret);
  const other = await eventEntry(f, tb, secret);
  const personal = await opened(f, tb, invite()); // QR individuel sans prénom : gardé
  const before = events(f).length;
  const rotated = await post(f, staff(f, '/api/staff/private-event'), { rotate: true });
  assert.equal(rotated.status, 200, rotated.text);
  assert.ok(f.sched.people.has(lea.personId), 'nommée : gardée');
  assert.ok(f.sched.people.has(personal.personId), 'QR individuel : gardé');
  for (const gone of [ghost, other]) {
    assert.equal(f.sched.people.has(gone.personId), false, 'place sans prénom retirée');
    assert.equal(f.sched.person(gone.token), null);
  }
  assert.deepEqual(events(f).slice(before).filter(e => e.personId), [], 'rien au journal pour ces places');
  // La page de la place retirée qui se recharge : l'ancien QR n'est plus actif.
  const reload = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: ghost.cookie });
  assert.equal(reload.status, 403);
  assert.equal(reload.body.code, 'PRIVATE_EVENT');
  assert.deepEqual((await stateOf(f, tb, ghost)).body.managedIds, []);
  // Léa garde son accès.
  assert.deepEqual((await stateOf(f, tb, lea)).body.managedIds, [lea.personId]);
});

// Regression: deuxième relecture finale (ADV F1) — /api/leave sur une place
// sans prénom puis un nouveau scan sans cookie : des fiches parties
// s'accumulaient pour toute la soirée.
test('événement privé : quitter une place sans prénom ni titre la supprime, sans trace', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const secret = f.privateEvent.enable();
  const before = f.sched.people.size;
  for (let i = 0; i < 3; i++) {
    const me = await eventEntry(f, tb, secret);
    const left = await post(f, '/api/leave', { token: me.token }, { cookie: me.cookie });
    assert.equal(left.status, 200, left.text);
    assert.equal(f.sched.people.has(me.personId), false);
  }
  assert.equal(f.sched.people.size, before, 'aucune fiche partie accumulée');
  assert.deepEqual(events(f, 'person.left'), []);
  // Troisième passe de la relecture finale : une personne nommée sans aucun
  // historique part aussi sans laisser de fiche (son prénom se libère) ; son
  // inscription est au journal, son départ aussi.
  const lea = await eventEntry(f, tb, secret, 'Léa');
  assert.equal((await post(f, '/api/leave', { token: lea.token }, { cookie: lea.cookie })).status, 200);
  assert.equal(f.sched.people.has(lea.personId), false, 'nommée sans historique : retirée');
  assert.equal(f.sched.person(lea.token), null);
  assert.deepEqual(events(f, 'person.left').map(e => [e.personId, e.by, e.songsDropped]), [[lea.personId, 'self', 0]]);
  assert.equal((await eventEntry(f, tb, secret, 'Léa')).personId !== lea.personId, true, 'prénom libre');
  // Avec un titre demandé, elle reste marquée partie (partie d'elle-même).
  const max = await eventEntry(f, tb, secret, 'Max');
  assert.equal((await post(f, '/api/table/song', { ...max, song: song(3, 'Titre') }, { cookie: max.cookie })).status, 200);
  assert.equal((await post(f, '/api/leave', { token: max.token }, { cookie: max.cookie })).status, 200);
  assert.ok(f.sched.people.get(max.personId).withdrawnAt);
  assert.equal(f.sched.people.get(max.personId).withdrawnBy, 'self');
  // QR individuel sans prénom : marquée partie comme avant (le bar peut la réactiver).
  const sam = await opened(f, tb, invite());
  assert.equal((await post(f, '/api/leave', { token: sam.token }, { cookie: sam.cookie })).status, 200);
  assert.ok(f.sched.people.get(sam.personId).withdrawnAt);
});

// Regression: troisième relecture finale (RT2) — « Parti » du bar sur une
// place « Solo N » du QR de l'événement la gardait, marquée partie : son
// navigateur restait lié à une fiche que le bar ne sait pas reconnaître pour
// la réactiver. Comme /api/leave : supprimée sans trace, et le QR de
// l'événement rescanné donne une nouvelle place.
test('événement privé : « Parti » du bar sur une place sans prénom ni titre la supprime ; le même navigateur repart', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const secret = f.privateEvent.enable();
  const ghost = await eventEntry(f, tb, secret);
  const before = events(f).length;
  const version = f.sched.version;
  const left = await post(f, staff(f, '/api/staff/person/leave'), { personId: ghost.personId });
  assert.equal(left.status, 200, left.text);
  // Regression: vérification de la troisième relecture — sans `message`, le
  // bar lisait « Chanteur marqué parti », alors que la place n'existe plus.
  assert.match(left.body.message, /^Place « Solo \d+ » sans prénom retirée : s’il est encore là, il rescanne le QR de l’événement\.$/);
  assert.equal(f.sched.people.has(ghost.personId), false, 'place retirée, pas marquée partie');
  assert.equal(f.sched.person(ghost.token), null);
  assert.ok(f.sched.version > version, 'les pages se mettent à jour');
  assert.deepEqual(events(f).slice(before).filter(e => e.personId), [], 'rien au journal');
  assert.deepEqual((await stateOf(f, tb, ghost)).body.managedIds, []);
  // Le même navigateur rescanne le QR de l'événement : une nouvelle place.
  const again = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: ghost.cookie });
  assert.equal(again.status, 200, again.text);
  assert.notEqual(again.body.id, ghost.personId);
  assert.equal(again.body.nameRequired, true);
  // Nommée, ou sans prénom par un QR individuel : « Parti » comme avant.
  const lea = await eventEntry(f, tb, secret, 'Léa');
  const sam = await opened(f, tb, invite());
  for (const kept of [lea, sam]) {
    const keptLeft = await post(f, staff(f, '/api/staff/person/leave'), { personId: kept.personId });
    assert.equal(keptLeft.status, 200);
    assert.equal(keptLeft.body.message, undefined, 'le bar garde « marqué parti »');
    assert.ok(f.sched.people.get(kept.personId).withdrawnAt, 'gardée, marquée partie');
  }
});

// Regression: deuxième relecture finale (ADV F5) — un QR individuel neuf était
// refusé (« Ce téléphone a déjà un prénom inscrit ») sur un navigateur qui ne
// gardait qu'une place sans prénom du QR de l'événement.
test('QR individuel neuf : la place sans prénom de ce navigateur part, le QR s’ouvre ; jamais deux places', async () => {
  const f = harness({ persistent: true });
  const { tb, invite } = openSolo(f);
  const secret = f.privateEvent.enable();
  const ghost = await eventEntry(f, tb, secret);
  // Sauvegarde impossible : la place provisoire reste, l'invitation aussi.
  const token = invite();
  f.night.fail = 'disque plein';
  const failed = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: ghost.cookie });
  assert.equal(failed.status, 400);
  assert.ok(f.sched.people.has(ghost.personId), 'place provisoire intacte');
  assert.equal(f.sched.person(ghost.token)?.id, ghost.personId);
  assert.ok(f.soloInvitations.verify(token, 'Comptoir'));
  f.night.fail = null;
  const before = events(f).length;
  const r = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: ghost.cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.nameRequired, true);
  assert.notEqual(r.body.id, ghost.personId);
  assert.equal(f.sched.people.has(ghost.personId), false, 'la place provisoire part');
  assert.deepEqual(events(f).slice(before).filter(e => e.personId === ghost.personId), [], 'sans trace');
  const me = { ...tb, personId: r.body.id, token: r.body.token, cookie: cookieOf(r) || ghost.cookie };
  assert.deepEqual((await stateOf(f, tb, me)).body.managedIds, [r.body.id]);
  // Nommée ou avec un titre : toujours refusé.
  await post(f, '/api/table/person/rename', { ...tb, personId: me.personId, token: me.token, name: 'Nina' }, { cookie: me.cookie });
  const again = await post(f, '/api/table/solo/open', { ...tb, invitation: invite() }, { cookie: me.cookie });
  assert.equal(again.body.code, 'SOLO_DEVICE_USED');
});

// Regression: deuxième relecture finale (vérification E2) — un QR individuel
// neuf, ou une reprise, retirait la place sans prénom que ce navigateur ne gère
// plus : reprise entre-temps par un autre navigateur (QR personnel donné à un
// ami, essayé par le bar), elle disparaissait avec sa clé personnelle.
test('QR individuel neuf ou reprise : la place sans prénom reprise par un autre navigateur reste la sienne', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const k1 = invite();
  const a = await opened(f, tb, k1);
  // Le QR K1 passe à un ami (navigateur B) : place encore sans prénom, reprise tout de suite.
  const takeover = await post(f, '/api/table/solo/open', { ...tb, invitation: k1 });
  assert.equal(takeover.status, 200, takeover.text);
  assert.equal(takeover.body.id, a.personId);
  const b = { ...tb, personId: takeover.body.id, token: takeover.body.token, cookie: cookieOf(takeover) };
  // A est détaché de la place reprise (vérification de la troisième passe,
  // V1) : il reprend un autre profil (lien de transfert), la place de B reste.
  assert.deepEqual((await stateOf(f, tb, a)).body.managedIds, []);
  const zoe = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...tb, personId: zoe.personId, token: zoe.token, name: 'Zoé' }, { cookie: zoe.cookie });
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: zoe.personId });
  const claim = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: a.cookie });
  assert.equal(claim.status, 200, claim.text);
  assert.ok(f.sched.people.has(b.personId), 'la place de B existe toujours après la reprise');
  assert.deepEqual((await stateOf(f, tb, b)).body.managedIds, [b.personId]);
  const named = await post(f, '/api/table/person/rename', { ...tb, personId: b.personId, token: b.token, name: 'Inès' }, { cookie: b.cookie });
  assert.equal(named.status, 200, named.text);
  // Sa clé personnelle la retrouve toujours, sur ce navigateur comme ailleurs.
  const again = await post(f, '/api/table/solo/open', { ...tb, invitation: k1 }, { cookie: b.cookie });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.id, b.personId);
  const elsewhere = await post(f, '/api/table/solo/open', { ...tb, invitation: k1 });
  assert.equal(elsewhere.status, 200, elsewhere.text);
  assert.equal(elsewhere.body.recover?.id, b.personId);
});

// Regression: deuxième relecture finale (A2-3) — une personne marquée partie
// qui rouvrait son QR personnel dans un autre navigateur lisait « demande un
// nouveau QR » au lieu de « marquée partie ».
test('QR personnel d’une personne marquée partie, ouvert ailleurs : PERSON_LEFT', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const token = invite();
  const sam = await opened(f, tb, token);
  await post(f, '/api/table/person/rename', { ...tb, personId: sam.personId, token: sam.token, name: 'Sam' }, { cookie: sam.cookie });
  await post(f, staff(f, '/api/staff/person/leave'), { personId: sam.personId });
  for (const cookie of [undefined, (await opened(f, tb, invite())).cookie]) {
    const r = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'PERSON_LEFT');
  }
  // Une invitation jamais utilisée garde son message.
  const unknown = await post(f, '/api/table/solo/open', { ...tb, invitation: 'y'.repeat(32) });
  assert.equal(unknown.body.code, 'SOLO_INVITATION');
});

// Regression: deuxième relecture finale (P2-2) — chaque reprise ajoutait une
// empreinte de téléphone, même redemandée par le téléphone actuel : la liste
// grandissait sans fin.
test('reprises répétées : le téléphone actuel ne se réassocie pas ; au plus 8 empreintes, l’actuelle en dernier', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const token = invite();
  const sam = await opened(f, tb, token);
  await post(f, '/api/table/person/rename', { ...tb, personId: sam.personId, token: sam.token, name: 'Sam' }, { cookie: sam.cookie });
  const person = f.sched.people.get(sam.personId);
  let cookie = sam.cookie;
  for (let i = 0; i < 5; i++) {
    const again = await post(f, '/api/table/person/claim', { ...tb, key: token }, { cookie });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.headers['set-cookie'], undefined, 'même téléphone : même cookie');
  }
  assert.equal(person.soloDeviceHashes.length, 1, 'le téléphone actuel ne s’ajoute pas à chaque reprise');
  assert.equal(person.soloDeviceHashes.at(-1), crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex'));
  for (let i = 0; i < 12; i++) {
    const claimed = await post(f, '/api/table/person/claim', { ...tb, key: token });
    assert.equal(claimed.status, 200, claimed.text);
    cookie = cookieOf(claimed);
  }
  assert.equal(person.soloDeviceHashes.length, 8, 'au plus 8 empreintes');
  assert.equal(person.soloDeviceHashes.at(-1), crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex'), 'l’actuelle en dernier');
  assert.deepEqual((await stateOf(f, tb, { token: f.sched.people.get(sam.personId).token, cookie })).body.managedIds, [sam.personId]);
});

test('sauvegarde de la soirée : événement privé et champs des personnes repris, formes abîmées tolérées', () => {
  const { Scheduler } = require('../scheduler');
  const { TableAccess } = require('../table-access');
  const { SoloInvitations } = require('../solo-invitations');
  const { PrivateEvent } = require('../private-event');
  const { snapshotNight, restoreNight } = require('../night-state');
  const sched = new Scheduler({ solverEnabled: false });
  const access = new TableAccess();
  const comptoir = sched.table('Comptoir');
  access.issue(comptoir.id);
  const p = sched.join({ tableId: 'Comptoir', name: 'Solo 1', nameRequired: true });
  p.soloKeyHash = 'a'.repeat(64);
  p.lastActionAt = 123;
  p.viaEvent = true;
  const privateEvent = new PrivateEvent();
  const secret = privateEvent.enable();
  const settings = () => ({ auto: false, autoPlay: false, baseUrl: null, pushDelaySec: 45, playDelaySec: 8 });
  const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: sched, access, settings: settings(),
    soloInvitations: new SoloInvitations(), privateEvent })));
  const restore = snap => {
    const target = new Scheduler({ solverEnabled: false });
    const result = restoreNight(snap, { scheduler: target, access: new TableAccess(), settings: settings() });
    return { result, person: target.people.get(p.id) };
  };
  const { result, person } = restore(snapshot);
  assert.equal(new PrivateEvent(result.privateEvent).verify(secret), true, 'un redémarrage garde le QR de l’événement');
  assert.equal(person.nameRequired, true);
  assert.equal(person.soloKeyHash, 'a'.repeat(64));
  assert.equal(person.lastActionAt, 123);
  assert.equal(person.viaEvent, true);
  // Ancienne sauvegarde sans ces champs, ou champs abîmés : jamais d'échec de la soirée.
  const old = JSON.parse(JSON.stringify(snapshot));
  delete old.privateEvent;
  assert.equal(restore(old).result.privateEvent, null);
  const broken = JSON.parse(JSON.stringify(snapshot));
  broken.privateEvent = { enabled: true, secret: 'abîmé', since: 1 };
  Object.assign(broken.scheduler.people[0], { nameRequired: 'oui', soloKeyHash: 'zz', lastActionAt: 'hier', viaEvent: 1, soloKeyRevoked: 'oui',
    withdrawnBy: 'moi' });
  const fixed = restore(broken);
  assert.equal(fixed.result.privateEvent, null, 'forme abîmée : mode coupé');
  for (const field of ['nameRequired', 'soloKeyHash', 'lastActionAt', 'viaEvent', 'soloKeyRevoked', 'withdrawnBy']) {
    assert.equal(fixed.person[field], undefined, `${field} abîmé : ignoré`);
  }
  // Départ fait par la personne ou marqué par le bar (troisième passe de la
  // relecture finale, plafond des fiches de l'événement) : gardé.
  for (const by of ['self', 'staff']) {
    const left = JSON.parse(JSON.stringify(snapshot));
    Object.assign(left.scheduler.people[0], { withdrawnAt: 456, withdrawnBy: by });
    assert.equal(restore(left).person.withdrawnBy, by);
  }
  // Clé personnelle morte au départ (quatrième relecture finale, D2) : gardée
  // par la sauvegarde. Une sauvegarde d'avant ce champ : une personne partie
  // qui a une clé l'a perdue, une personne présente la garde.
  assert.equal(person.soloKeyRevoked, undefined, 'présente : clé vivante');
  const revoked = JSON.parse(JSON.stringify(snapshot));
  revoked.scheduler.people[0].soloKeyRevoked = true;
  assert.equal(restore(revoked).person.soloKeyRevoked, true);
  const leftBefore = JSON.parse(JSON.stringify(snapshot));
  leftBefore.scheduler.people[0].withdrawnAt = 456;
  assert.equal(restore(leftBefore).person.soloKeyRevoked, true, 'partie avec sa clé : clé morte');
});

// ---------------------------------------------------------------- C : dernière activité
test('activité : seule une page cachée (x-page-visible: 0) ne compte pas ; une page visible compte pour toutes les personnes du téléphone ; actions comptées, accusé non', async () => {
  const f = harness();
  const tb = openTable(f, '5');
  const ana = await post(f, '/api/table/person', { ...tb, name: 'Ana' });
  const ben = await post(f, '/api/table/person', { ...tb, name: 'Ben' });
  const people = [ana, ben].map(r => f.sched.people.get(r.body.id));
  const old = Date.now() - 30 * 60000;
  for (const p of people) { p.lastSeen = old; delete p.lastActionAt; }
  const poll = headers => get(f, `/api/state?table=5&access=${tb.access}`,
    { headers: { 'x-person-tokens': JSON.stringify(people.map(p => p.token)), ...headers } });
  await poll({ 'x-page-visible': '0' });
  assert.deepEqual(people.map(p => p.lastSeen), [old, old], 'page cachée : rien ne bouge');
  await poll({ 'x-page-visible': '1' });
  assert.ok(people.every(p => p.lastSeen > old), 'page visible : toutes les personnes du téléphone');
  // Au plus une fois par minute.
  const seen = people.map(p => p.lastSeen - 1000);
  people.forEach((p, i) => { p.lastSeen = seen[i]; });
  await poll({ 'x-page-visible': '1' });
  assert.deepEqual(people.map(p => p.lastSeen), seen);
  // Sans jeton valable : rien.
  people[0].lastSeen = old;
  await get(f, `/api/state?table=5&access=${tb.access}`, { headers: { 'x-page-visible': '1' } });
  assert.equal(people[0].lastSeen, old);
  // Ancienne lecture par jeton seul : même règle.
  await get(f, `/api/state?token=${people[0].token}`, { headers: { 'x-page-visible': '0' } });
  assert.equal(people[0].lastSeen, old);
  await get(f, `/api/state?token=${people[0].token}`, { headers: { 'x-page-visible': '1' } });
  assert.ok(people[0].lastSeen > old);

  // L'accusé automatique des messages n'est pas une action.
  const body = { ...tb, personId: people[0].id, token: people[0].token };
  await post(f, '/api/table/notice/ack', { ...body, ids: [] });
  assert.equal(people[0].lastActionAt, undefined);
  await post(f, '/api/table/confirm', body);
  assert.ok(people[0].lastActionAt > 0, 'confirmation de présence = action');
  delete people[0].lastActionAt;
  await post(f, '/api/confirm', { token: people[0].token });
  assert.ok(people[0].lastActionAt > 0, 'ancienne API par jeton : action aussi');

  // Bar : dernière activité = la plus récente des deux, heure du serveur fournie.
  people[1].lastSeen = 1000; people[1].lastActionAt = 5000;
  const state = plain(f.staffState());
  assert.equal(state.people.find(p => p.id === people[1].id).lastActiveAt, 5000);
  people[1].lastActionAt = 10;
  assert.equal(plain(f.staffState()).people.find(p => p.id === people[1].id).lastActiveAt, 1000);
  assert.ok(Number.isFinite(state.now));
  // Jamais dans l'état des téléphones.
  const phone = (await poll({})).text;
  assert.ok(!/lastActiveAt|lastActionAt|lastSeen/.test(phone));
});

// Regression: constat QA Q1 (8 octobre) — un prénom refusé (déjà pris, vide)
// comptait comme activité : le bar affichait « Actif il y a N min » au lieu de
// « Pas revenu depuis l'ouverture du QR ». Seule une action acceptée compte (C1).
test('activité : une action personnelle refusée (prénom pris, vide, 4xx) ne compte pas', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const marie = await opened(f, tb, invite());
  assert.equal((await post(f, '/api/table/person/rename', { ...tb, personId: marie.personId, token: marie.token, name: 'Marie' },
    { cookie: marie.cookie })).status, 200);
  const sam = await opened(f, tb, invite());
  const p = f.sched.people.get(sam.personId);
  delete p.lastActionAt;
  const body = extra => ({ ...tb, personId: sam.personId, token: sam.token, ...extra });
  const refused = async (route, extra) => {
    const r = await post(f, route, body(extra), { cookie: sam.cookie });
    assert.ok(r.status >= 400 && r.status < 500, `${route} : ${r.status} ${r.text}`);
    assert.equal(p.lastActionAt, undefined, `${route} refusé : pas une activité`);
    return r;
  };
  assert.equal((await refused('/api/table/person/rename', { name: 'marie' })).body.code, 'NAME_TAKEN');
  await refused('/api/table/person/rename', { name: '   ' });
  await refused('/api/table/song', { song: song('1', 'Titre') });
  await refused('/api/table/battle/vote', { choice: 'a' });
  await refused('/api/table/song/remove', { entryId: 'inconnu' });
  assert.equal(plain(f.staffState()).people.find(row => row.id === sam.personId).lastActiveAt, p.lastSeen,
    'le bar garde l’heure d’ouverture du QR');
  // Une action acceptée compte toujours.
  assert.equal((await post(f, '/api/table/person/rename', body({ name: 'Sam' }), { cookie: sam.cookie })).status, 200);
  assert.ok(p.lastActionAt > 0, 'prénom accepté = action');
  // Ancienne API par jeton : un refus ne compte pas non plus.
  delete p.lastActionAt;
  const legacy = await post(f, '/api/duet/answer', { token: sam.token, accept: true, entryId: 'inconnu' }, { cookie: sam.cookie });
  assert.equal(legacy.status, 400, legacy.text);
  assert.equal(p.lastActionAt, undefined, 'ancienne API refusée : pas une activité');
});

test('activité solo : page visible avec le cookie du téléphone', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  const p = f.sched.people.get(sam.personId);
  p.lastSeen = 1;
  await stateOf(f, tb, { token: sam.token }, { 'x-page-visible': '1' });
  assert.equal(p.lastSeen, 1, 'sans le cookie du téléphone : rien');
  await stateOf(f, tb, sam, { 'x-page-visible': '1' });
  assert.ok(p.lastSeen > 1);
  const again = await post(f, '/api/table/solo/open', { ...tb, invitation: 'x'.repeat(32) }, { cookie: sam.cookie });
  assert.equal(again.status, 403);
});

// ---------------------------------------------------------------- D1 : faire scanner sa table
test('QR de table pour le téléphone : même lien que le QR imprimé, pas pour « En solo »', async () => {
  const f = harness();
  const tb = openTable(f, '6');
  const r = await get(f, `/api/table/invite?table=6&access=${tb.access}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.url, f.access.url(`http://${new URL(r.body.url).host}`, '6'));
  assert.match(r.body.qr, /^data:image\/png;base64,/);
  assert.equal(new URL(plain(f.staffState()).tables.find(t => t.id === '6').url).href, r.body.url);
  const bad = await get(f, `/api/table/invite?table=6&access=${'x'.repeat(22)}`);
  assert.equal(bad.status, 403);
  const { tb: solo } = openSolo(f);
  const soloInvite = await get(f, `/api/table/invite?table=Comptoir&access=${solo.access}`);
  assert.equal(soloInvite.status, 400);
  assert.equal(soloInvite.body.error, 'Pas de QR à partager : chacun demande son QR individuel au bar.');
  assert.equal((await get(f, '/api/table/inconnue')).status, 404);
});

// ---------------------------------------------------------------- relecture finale (lot serveur)
// Regression: relecture finale C1 — une page des chanteurs gardée en cache
// d'avant une mise à jour en cours de soirée n'envoie jamais x-page-visible :
// ses solos apparaissaient « Sans nouvelles » au bar. Seul « 0 » (page
// cachée, nouvelle page) ne compte pas.
test('activité : une page d’avant la mise à jour (sans en-tête) compte encore ; « 0 » seulement ne compte pas', async () => {
  const f = harness();
  const tb = openTable(f, '5');
  const ana = await post(f, '/api/table/person', { ...tb, name: 'Ana' });
  const p = f.sched.people.get(ana.body.id);
  const old = Date.now() - 30 * 60000;
  const poll = headers => get(f, `/api/state?table=5&access=${tb.access}`,
    { headers: { 'x-person-tokens': JSON.stringify([p.token]), ...headers } });
  p.lastSeen = old;
  await poll({});
  assert.ok(p.lastSeen > old, 'page en cache sans en-tête : activité notée');
  p.lastSeen = old;
  await poll({ 'x-page-visible': '0' });
  assert.equal(p.lastSeen, old, 'nouvelle page cachée : rien');
  // Ancienne lecture par jeton seul : même règle.
  await get(f, `/api/state?token=${p.token}`);
  assert.ok(p.lastSeen > old, 'lecture par jeton sans en-tête : activité notée');
  p.lastSeen = old;
  await get(f, `/api/state?token=${p.token}`, { headers: { 'x-page-visible': '0' } });
  assert.equal(p.lastSeen, old);
  // Solo : page en cache avec le cookie de son téléphone.
  const { tb: solo, invite } = openSolo(f);
  const sam = await opened(f, solo, invite());
  const sp = f.sched.people.get(sam.personId);
  sp.lastSeen = old;
  await stateOf(f, solo, sam);
  assert.ok(sp.lastSeen > old, 'solo : page en cache comptée');
});

// Regression: relecture finale C3 — au redémarrage, journalRoster() inscrivait
// au journal le prénom provisoire (« Solo 1 ») des QR ouverts sans prénom
// (spéc. A1.5 : une ouverture abandonnée n'entre ni au journal ni aux stats).
test('journal : au redémarrage, une personne encore sans prénom n’entre pas dans les prénoms du journal', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  const zoe = await opened(f, tb, invite());
  assert.equal((await post(f, '/api/table/person/rename', { ...tb, personId: zoe.personId, token: zoe.token, name: 'Zoé' },
    { cookie: zoe.cookie })).status, 200);
  f.journalRoster(); // ce que fait le démarrage (et une nouvelle soirée)
  const roster = f.journal.current.meta.roster;
  assert.equal(roster[sam.personId], undefined, 'prénom provisoire absent');
  assert.equal(roster[zoe.personId].name, 'Zoé');
  const exported = await get(f, staff(f, '/api/staff/stats/export?names=1'));
  assert.equal(exported.status, 200, exported.text);
  assert.ok(!exported.text.includes('Solo 1'), 'export avec prénoms : aucun prénom provisoire');
  assert.ok(exported.text.includes('Zoé'));
  // Son premier vrai prénom l'inscrit ensuite, comme sans redémarrage.
  await post(f, '/api/table/person/rename', { ...tb, personId: sam.personId, token: sam.token, name: 'Sam' }, { cookie: sam.cookie });
  assert.equal(f.journal.current.meta.roster[sam.personId].name, 'Sam');
});

// Regression: relecture finale C4 — PERSON_LEFT répondait 400 depuis les
// routes de table (QR individuel, QR de l'événement, actions d'une personne)
// mais 403 depuis l'ancienne API par jeton.
test('personne marquée partie : 403 PERSON_LEFT sur toutes les routes', async () => {
  const f = harness();
  const message = 'Cette personne a été marquée partie. Demande au bar de la réactiver.';
  const { tb, invite } = openSolo(f);
  const token = invite();
  const sam = await opened(f, tb, token);
  await post(f, '/api/table/person/rename', { ...tb, personId: sam.personId, token: sam.token, name: 'Sam' }, { cookie: sam.cookie });
  const secret = new URL((await post(f, staff(f, '/api/staff/private-event'), { enabled: true })).body.url).searchParams.get('evenement');
  const eva = await post(f, '/api/table/enter', { ...tb, event: secret });
  assert.equal(eva.status, 200, eva.text);
  const evaCookie = cookieOf(eva);
  // Avec un prénom : une place « Solo N » sans prénom ni titre, elle, est
  // supprimée par « Parti » (RT2), jamais marquée partie.
  assert.equal((await post(f, '/api/table/person/rename', { ...tb, personId: eva.body.id, token: eva.body.token, name: 'Eva' },
    { cookie: evaCookie })).status, 200);
  const table = openTable(f, '3');
  const ana = await post(f, '/api/table/person', { ...table, name: 'Ana' });
  for (const personId of [sam.personId, eva.body.id, ana.body.id]) await post(f, staff(f, '/api/staff/person/leave'), { personId });
  const answers = [
    await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: sam.cookie }),
    await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: evaCookie }),
    await post(f, '/api/table/confirm', { ...table, personId: ana.body.id, token: ana.body.token }),
    await post(f, '/api/confirm', { token: ana.body.token }),
  ];
  assert.deepEqual(answers.map(r => [r.status, r.body.code, r.body.error]), Array(4).fill([403, 'PERSON_LEFT', message]));
});

// Regression: relecture finale C5 — la durée envoyée par un téléphone était
// gardée telle quelle (une chaîne de 200 Ko acceptée) et renvoyée à tous les
// téléphones. Seul un nombre borné (30 à 1200 s) est gardé, sinon rien.
test('durée envoyée par un téléphone : seulement un nombre borné, pour un titre comme pour un duo', async () => {
  const f = harness();
  const tb = openTable(f, '7', 6);
  const people = [];
  for (const name of ['Ana', 'Ben', 'Cléo', 'Dan']) people.push((await post(f, '/api/table/person', { ...tb, name })).body);
  const at = (person, extra) => ({ ...tb, personId: person.id, token: person.token, ...extra });
  const choose = async (person, songId, duration) => {
    const r = await post(f, '/api/table/song', at(person, { song: { songId, title: `T${songId}`, artist: 'A', duration } }));
    assert.equal(r.status, 200, r.text);
  };
  await choose(people[0], 1, 'x'.repeat(200000));
  await choose(people[0], 2, 99999);
  await choose(people[0], 3, 10);
  await choose(people[0], 4, 215.4);
  await choose(people[0], 5, '215');
  const durations = f.sched.songsOf(f.sched.people.get(people[0].id)).map(song => song.duration);
  assert.deepEqual(durations, [null, 1200, 30, 215, 215]);
  // Duo : même règle.
  const duet = await post(f, '/api/table/duet', at(people[1], { partnerId: people[2].id,
    song: { songId: 9, title: 'Duo', artist: 'A', duration: 'y'.repeat(5000) } }));
  assert.equal(duet.status, 200, duet.text);
  assert.equal(f.sched.songsOf(f.sched.people.get(people[1].id)).at(-1).duration, null);
  // Ancienne API par jeton : même règle.
  assert.equal((await post(f, '/api/song', { token: people[3].token, song: { songId: 8, title: 'T8', artist: 'A', duration: [1, 2] } })).status, 200);
  assert.equal(f.sched.songsOf(f.sched.people.get(people[3].id))[0].duration, null);
  // Ce que les téléphones reçoivent.
  const view = await get(f, `/api/state?table=7&access=${tb.access}`, { headers: { 'x-person-tokens': JSON.stringify([people[0].token]) } });
  assert.ok(view.text.length < 50000, 'aucune durée géante renvoyée aux téléphones');
});

// ---------------------------------------------------------------- troisième relecture finale (RT1 à RT3)
// Regression: troisième relecture finale (RT1) — un soliste dont le nouveau
// navigateur avait ouvert un QR montré par le bar (QR de l'événement ou QR
// personnel neuf) avait une place « Solo N » : la liste de reprise lui était
// cachée, le code à 4 chiffres ne servait plus, et redonner son prénom
// répondait NAME_TAKEN (inscrit deux fois).
test('reprise par code : la place sans prénom de ce navigateur (événement ou QR neuf) laisse voir et utiliser le code', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const clara = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...tb, personId: clara.personId, token: clara.token, name: 'Clara' }, { cookie: clara.cookie });
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: clara.personId });
  assert.equal(share.status, 200, share.text);

  // Nouveau navigateur : QR de l'événement, place « Solo 2 » sans prénom.
  const ghost = await eventEntry(f, tb, secret);
  assert.equal(f.sched.people.get(ghost.personId).nameRequired, true);
  const view = (await stateOf(f, tb, ghost)).body;
  assert.deepEqual(view.managedIds, [ghost.personId]);
  assert.deepEqual(plain(view.recoveryPeople), [{ id: clara.personId, name: 'Clara' }], 'la reprise par code reste proposée');
  // Même vue par l'ancienne lecture au jeton seul.
  const byToken = await get(f, `/api/state?token=${ghost.token}`, { cookie: ghost.cookie });
  assert.deepEqual(plain(byToken.body.recoveryPeople), [{ id: clara.personId, name: 'Clara' }]);
  const claimed = await post(f, '/api/table/person/claim', { ...tb, personId: clara.personId, code: share.body.code }, { cookie: ghost.cookie });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(f.sched.people.has(ghost.personId), false, 'la place sans prénom part : jamais deux places');
  const back = { ...tb, personId: clara.personId, token: claimed.body.token, cookie: cookieOf(claimed) || ghost.cookie };
  assert.deepEqual((await stateOf(f, tb, back)).body.managedIds, [clara.personId]);
  assert.deepEqual((await stateOf(f, tb, back)).body.recoveryPeople, [], 'nommée : plus de liste de reprise');

  // QR personnel neuf ouvert dans un autre navigateur : même chose.
  const share2 = await post(f, staff(f, '/api/staff/person/share'), { personId: clara.personId });
  const fresh = await opened(f, tb, invite());
  assert.equal(f.sched.people.get(fresh.personId).nameRequired, true);
  assert.deepEqual(plain((await stateOf(f, tb, fresh)).body.recoveryPeople), [{ id: clara.personId, name: 'Clara' }]);
  const again = await post(f, '/api/table/person/claim', { ...tb, personId: clara.personId, code: share2.body.code }, { cookie: fresh.cookie });
  assert.equal(again.status, 200, again.text);
  // Vérification de la troisième passe (V2) : la place de ce QR personnel
  // reste à son papier (peut-être celui de quelqu'un d'autre), ce navigateur
  // la quitte ; il ne gère que Clara.
  assert.ok(f.sched.people.has(fresh.personId), 'la place du QR personnel reste à son papier');
  const there = { ...tb, personId: clara.personId, token: again.body.token, cookie: cookieOf(again) || fresh.cookie };
  assert.deepEqual((await stateOf(f, tb, there)).body.managedIds, [clara.personId]);

  // Une place nommée, elle, ne voit jamais les codes des autres.
  const share3 = await post(f, staff(f, '/api/staff/person/share'), { personId: clara.personId });
  assert.equal(share3.status, 200);
  const lea = await eventEntry(f, tb, secret, 'Léa');
  assert.deepEqual((await stateOf(f, tb, lea)).body.recoveryPeople, []);
  assert.deepEqual((await get(f, `/api/state?token=${lea.token}`, { cookie: lea.cookie })).body.recoveryPeople, []);
});

// Regression: troisième relecture finale (RT1) — l'ancien navigateur d'une
// place sans prénom reprise ailleurs (clé personnelle) ne la gère plus. Depuis
// la vérification de la troisième passe (V1), il en est détaché : il voit la
// liste comme tout navigateur neuf, sans rien gérer.
test('reprise par code : l’ancien navigateur d’une place sans prénom reprise ailleurs ne la gère plus, comme un navigateur neuf', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const clara = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...tb, personId: clara.personId, token: clara.token, name: 'Clara' }, { cookie: clara.cookie });
  await post(f, staff(f, '/api/staff/person/share'), { personId: clara.personId });
  const key = invite();
  const first = await opened(f, tb, key);
  const moved = await post(f, '/api/table/solo/open', { ...tb, invitation: key }, { remote: '10.0.9.9' });
  assert.equal(moved.body.id, first.personId, 'reprise sans confirmation : place encore sans prénom');
  const view = await get(f, `/api/state?token=${first.token}`, { cookie: first.cookie });
  assert.ok(!view.body.recoveryPeople?.length, 'ancien jeton : rien');
  // Regression: troisième relecture finale (T3-1) — lecture de la table
  // (/api/state?table=), que la page utilise.
  const byTable = (await stateOf(f, tb, first)).body;
  assert.deepEqual(byTable.managedIds, [], 'l’ancien navigateur ne gère plus la place');
  const fresh = plain((await stateOf(f, tb, null)).body.recoveryPeople);
  assert.deepEqual(fresh, [{ id: clara.personId, name: 'Clara' }], 'un navigateur neuf voit la liste (Clara a demandé un code)');
  assert.deepEqual(plain(byTable.recoveryPeople), fresh, 'l’ancien navigateur, détaché, comme un neuf');
});

// Regression: troisième relecture finale (RT2) — le relevé de la file comptait
// les places « Solo N » sans prénom parmi les personnes présentes, gonflant la
// courbe « Personnes présentes » des statistiques ; la tuile « En solo » du
// bar les comptait aussi comme solistes.
test('personnes présentes : relevé du journal, tuile « En solo » et effectif de la page sans les places sans prénom', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const lea = await eventEntry(f, tb, secret, 'Léa');
  await eventEntry(f, tb, secret);
  await opened(f, tb, invite());
  const gone = await eventEntry(f, tb, secret, 'Zoé');
  await post(f, staff(f, '/api/staff/person/leave'), { personId: gone.personId });
  f.journalSample(Date.now());
  assert.equal(events(f, 'queue.sample').at(-1).present, 1, 'Léa seule : ni « Solo N », ni partie');
  const tile = f.staffState().tables.find(t => t.id === 'Comptoir');
  assert.equal(tile.activeCount, 1, 'tuile « En solo » : 1 soliste');
  assert.equal(tile.count, 4, 'inscrits : toutes les fiches');
  assert.equal((await stateOf(f, tb, lea)).body.table.activeCount, 1);
});

// Regression: troisième relecture finale (RT3) — après « Renouveler le QR » ou
// le mode coupé, une personne inscrite (avec prénom) dont la page avait perdu
// son jeton mais gardé le cookie, qui rescannait le QR de l'événement qu'elle
// avait, était refusée (« QR plus actif ») : les inscrits gardent leur accès.
test('événement privé : un inscrit nommé qui rescanne l’ancien QR retrouve sa place ; créer une place exige le QR actif', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const lea = await eventEntry(f, tb, secret, 'Léa');
  const unnamed = await opened(f, tb, invite()); // QR individuel, encore sans prénom
  const gone = await eventEntry(f, tb, secret, 'Zoé');
  await post(f, staff(f, '/api/staff/person/leave'), { personId: gone.personId });
  await post(f, staff(f, '/api/staff/private-event'), { rotate: true });
  const size = f.sched.people.size;

  const back = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: lea.cookie });
  assert.equal(back.status, 200, back.text);
  assert.deepEqual([back.body.id, back.body.token, back.body.nameRequired, back.body.resumed], [lea.personId, lea.token, false, true]);
  // Sans place nommée : l'ancien QR ne crée rien, ne reprend rien.
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: unnamed.cookie })).body.code, 'PRIVATE_EVENT');
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: gone.cookie })).body.code, 'PRIVATE_EVENT');
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret })).body.code, 'PRIVATE_EVENT');
  assert.equal(f.sched.people.size, size, 'personne de créé');

  // Mode coupé : même chose.
  await post(f, staff(f, '/api/staff/private-event'), { enabled: false });
  const off = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: lea.cookie });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.body.id, lea.personId);
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: 'A'.repeat(22) })).status, 403);
  // Pas pour une table ordinaire, même avec le cookie d'un soliste.
  const table = openTable(f, '3');
  assert.equal((await post(f, '/api/table/enter', { ...table, event: secret }, { cookie: lea.cookie })).body.code, 'PRIVATE_EVENT');
});

// ================================================================ troisième passe finale (E1 à E5)
// Regression: troisième relecture finale (P3-1, S3-1, ADV F4) — les places
// sans prénom du QR de l'événement ne comptaient plus après 10 minutes, mais
// rien ne les retirait : une boucle sans cookie (adresses changeantes) les
// ajoutait sans fin à la soirée, à sa sauvegarde et à la liste « Solistes ».
test('événement privé : une boucle sans cookie ne fait pas grossir la soirée, une page vivante garde sa place', async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const f = harness({ persistent: true, clock: true });
    const { tb } = openSolo(f);
    const secret = f.privateEvent.enable();
    let lastSave = null;
    f.night.saves = { push(snapshot) { lastSave = snapshot; } };
    // Une invitée réelle : sa page se relit, elle garde sa place sans prénom.
    const alive = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.9.0.1' });
    const aliveMe = { ...tb, personId: alive.body.id, token: alive.body.token, cookie: cookieOf(alive) };
    // Une autre, abandonnée tout de suite : sa page reviendra plus tard.
    const lost = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.9.0.2' });
    const lostMe = { ...tb, personId: lost.body.id, token: lost.body.token, cookie: cookieOf(lost) };
    const named = await eventEntry(f, tb, secret, 'Léa');
    // Une création toutes les 2 s, le plus qu'un appareil puisse faire (30 par
    // minute) : environ 300 places sans prénom à la fois, celles des 10
    // dernières minutes, sous le plafond des fiches. Elles ne comptent pas
    // dans celui des personnes nommées (vérification de la seconde passe de
    // la quatrième relecture finale : ce test avait été ralenti à 4 s pour
    // rester sous les 200, et l'événement était complet au 200e scan).
    const step = 2000;
    const bound = 10 * 60000 / step + 5;
    assert.ok(bound < MAX_EVENT_PEOPLE);
    let refused = 0;
    for (let i = 0; i < 1000; i++) {
      clock += step;
      if (i % 30 === 0) await stateOf(f, tb, aliveMe); // page visible : relue
      const r = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: `10.${20 + (i >> 16 & 255)}.${i >> 8 & 255}.${i & 255}` });
      if (r.status !== 200) refused++;
    }
    assert.equal(refused, 0, 'jamais complète : les places abandonnées partent');
    assert.ok(f.sched.people.size <= bound, `fiches bornées (${f.sched.people.size})`);
    assert.ok(f.sched.people.has(aliveMe.personId), 'page relue : place gardée');
    assert.ok(f.sched.people.has(named.personId), 'nommée : gardée');
    assert.equal(f.sched.people.has(lostMe.personId), false, 'abandonnée : retirée');
    assert.ok(lastSave.scheduler.people.length <= bound, 'la sauvegarde aussi');
    assert.ok(JSON.stringify(lastSave).length < 400 * 1024, `sauvegarde petite (${JSON.stringify(lastSave).length} octets)`);
    assert.ok(!JSON.stringify(f.journal.current.events).includes(lostMe.personId), 'aucune trace au journal');
    // Sa page revient : elle ne gère plus rien, et le QR de l'événement lui
    // redonne une place.
    assert.deepEqual((await stateOf(f, tb, lostMe)).body.managedIds, []);
    const back = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: lostMe.cookie, remote: '10.9.0.2' });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.body.nameRequired, true);
    assert.notEqual(back.body.id, lostMe.personId);
  } finally {
    Date.now = realNow;
  }
});

// Regression: troisième relecture finale (S3-1) — aucun plafond ne bornait
// le nombre total de fiches venues par l'événement (MAX_EVENT_PEOPLE).
test('événement privé : au plus MAX_EVENT_PEOPLE fiches venues par l’événement, nommées ou non, quel que soit leur âge', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const crowd = [];
  for (let i = 0; i < MAX_EVENT_PEOPLE; i++) {
    const p = f.sched.join({ tableId: 'Comptoir', name: `Invité ${i}`, ...(i < MAX_EVENT_PEOPLE - 10 ? { nameRequired: true } : {}) });
    p.viaEvent = true;
    // Places sans prénom ouvertes il y a plus de 10 minutes, mais dont la page
    // s'est relue : elles ne comptent pas dans les présents et ne partent pas.
    if (p.nameRequired) { p.joinedAt -= 20 * 60000; p.lastSeen = Date.now(); }
    crowd.push(p);
  }
  const full = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.3.1' });
  assert.equal(full.status, 403, full.text);
  assert.equal(full.body.code, 'PRIVATE_EVENT_FULL');
  assert.equal(f.sched.people.size, MAX_EVENT_PEOPLE);
  // Une personne marquée partie libère une fiche.
  f.sched.leave(crowd[0], 'staff');
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.3.2' })).status, 200);
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.3.3' })).body.code, 'PRIVATE_EVENT_FULL');
});

// Regression: troisième passe de la relecture finale (sécurité CRITIQUE,
// adverse) — un script qui scannait le QR de l'événement, donnait un prénom
// (et une photo) puis appelait POST /api/leave n'était jamais arrêté : les
// deux plafonds sautaient les personnes marquées parties, et chaque tour
// laissait une fiche partie de plus (prénom pris, photo en mémoire,
// sauvegarde et page du bar qui grossissent toute la soirée).
test('événement privé : une boucle prénom, photo puis « Je pars » ne laisse aucune fiche, chaque prénom se libère', async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const f = harness({ persistent: true, clock: true });
    const { tb } = openSolo(f);
    const secret = f.privateEvent.enable();
    let lastSave = null;
    f.night.saves = { push(snapshot) { lastSave = snapshot; } };
    const photo = 'data:image/jpeg;base64,' + Buffer.alloc(1024, 7).toString('base64');
    const before = f.sched.people.size;
    const ids = new Set();
    let refused = 0;
    for (let i = 0; i < 1200; i++) {
      clock += 2000; // 30 par minute : la limite d'un appareil
      const remote = `10.${20 + (i >> 16 & 255)}.${i >> 8 & 255}.${i & 255}`;
      const r = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote });
      if (r.status !== 200) { refused++; continue; }
      const me = { ...tb, personId: r.body.id, token: r.body.token };
      const cookie = cookieOf(r);
      ids.add(me.personId);
      assert.equal((await post(f, '/api/table/person/rename', { ...me, name: `Boucle ${i}` }, { cookie, remote })).status, 200);
      assert.equal((await post(f, '/api/photo', { token: me.token, photo }, { cookie, remote })).status, 200);
      assert.equal((await post(f, '/api/leave', { token: me.token }, { cookie, remote })).status, 200);
    }
    assert.equal(refused, 0, 'jamais complète : ces fiches disparaissent');
    assert.equal(f.sched.people.size, before, `aucune fiche partie accumulée (${f.sched.people.size - before} de plus)`);
    assert.equal(PrivateEvent.held(f.sched.people.values()), 0);
    assert.equal(lastSave.scheduler.people.length, before, 'la sauvegarde non plus');
    assert.ok(JSON.stringify(lastSave).length < 400 * 1024, `sauvegarde petite (${JSON.stringify(lastSave).length} octets)`);
    // Rien ne cite une fiche retirée : la sauvegarde se reprend telle quelle.
    const restored = harness();
    require('../night-state').restoreNight(plain(lastSave), { scheduler: restored.sched, access: restored.access, settings: restored.settings });
    assert.equal(restored.sched.people.size, before);
    // Le journal reste cohérent : chaque inscription a son départ, par la personne elle-même.
    const joined = events(f, 'person.joined').filter(e => ids.has(e.personId));
    const left = events(f, 'person.left').filter(e => ids.has(e.personId));
    assert.equal(joined.length, ids.size);
    assert.deepEqual(left.map(e => [e.personId, e.by, e.songsDropped]), joined.map(e => [e.personId, 'self', 0]));
    // Le prénom d'une fiche retirée est libre pour une vraie invitée.
    clock += 2000;
    const guest = await eventEntry(f, tb, secret, 'Boucle 7');
    assert.equal(f.sched.people.get(guest.personId).name, 'Boucle 7');
  } finally {
    Date.now = realNow;
  }
});

// Regression: troisième passe de la relecture finale (sécurité CRITIQUE) — la
// même boucle avec un titre demandé avant « Je pars » : la fiche partie est
// gardée (son historique), mais compte dans les fiches de l'événement ; la
// boucle finit sur « complet » au lieu de grossir toute la soirée, et aucune
// fiche partie ne garde sa photo en mémoire.
test('événement privé : « Je pars » après un titre garde une fiche partie, comptée dans les fiches : la boucle finit complète', async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const f = harness({ clock: true });
    const { tb } = openSolo(f);
    const secret = f.privateEvent.enable();
    const photo = 'data:image/jpeg;base64,' + Buffer.alloc(1024, 7).toString('base64');
    let full = null, cycles = 0;
    for (let i = 0; i < 1000; i++) {
      clock += 2000;
      const remote = `10.${40 + (i >> 16 & 255)}.${i >> 8 & 255}.${i & 255}`;
      const r = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote });
      if (r.status !== 200) { full = r; break; }
      const me = { ...tb, personId: r.body.id, token: r.body.token };
      const cookie = cookieOf(r);
      assert.equal((await post(f, '/api/table/person/rename', { ...me, name: `Titre ${i}` }, { cookie, remote })).status, 200);
      assert.equal((await post(f, '/api/photo', { token: me.token, photo }, { cookie, remote })).status, 200);
      const added = await post(f, '/api/table/song', { ...me, song: song(1000 + i, `Titre ${i}`) }, { cookie, remote });
      assert.equal(added.status, 200, added.text);
      assert.equal((await post(f, '/api/leave', { token: me.token }, { cookie, remote })).status, 200);
      cycles++;
    }
    assert.ok(full, `boucle jamais arrêtée (${cycles} tours, ${f.sched.people.size} fiches)`);
    assert.deepEqual([full.status, full.body.code], [403, 'PRIVATE_EVENT_FULL']);
    assert.equal(cycles, MAX_EVENT_PEOPLE, 'arrêtée aux fiches de l’événement');
    assert.equal(PrivateEvent.held(f.sched.people.values()), MAX_EVENT_PEOPLE);
    const gone = [...f.sched.people.values()].filter(p => p.withdrawnAt);
    assert.equal(gone.length, MAX_EVENT_PEOPLE);
    assert.ok(gone.every(p => p.viaEvent && p.withdrawnBy === 'self'), 'parties d’elles-mêmes');
    assert.equal(gone.filter(p => p.photo).length, 0, 'une fiche partie ne garde pas sa photo en mémoire');
  } finally {
    Date.now = realNow;
  }
});

// Regression: troisième passe de la relecture finale (sécurité CRITIQUE) — le
// compte des départs faits par la personne elle-même est sauvegardé : un
// redémarrage ne rouvre pas l'événement. Un départ marqué par le bar
// (« Parti ») libère toujours sa fiche.
test('événement privé : une fiche partie d’elle-même compte encore après un redémarrage ; « Parti » du bar libère une fiche', async () => {
  const { restoreNight } = require('../night-state');
  const f = harness({ persistent: true });
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const crowd = [];
  for (let i = 0; i < MAX_EVENT_PEOPLE - 2; i++) {
    // Dix personnes nommées (sous les 200), les autres sans prénom, dont la
    // page s'est relue : elles comptent dans les fiches et ne partent pas.
    const p = f.sched.join({ tableId: 'Comptoir', name: `Invité ${i}`, ...(i >= 10 ? { nameRequired: true } : {}) });
    p.viaEvent = true;
    if (p.nameRequired) { p.joinedAt -= 20 * 60000; p.lastSeen = Date.now(); }
    crowd.push(p);
  }
  // Deux personnes venues par l'événement demandent un titre puis partent d'elles-mêmes.
  const leavers = [];
  for (const name of ['Léa', 'Max']) {
    const me = await eventEntry(f, tb, secret, name);
    assert.equal((await post(f, '/api/table/song', { ...me, song: song(7, name) }, { cookie: me.cookie })).status, 200);
    assert.equal((await post(f, '/api/leave', { token: me.token }, { cookie: me.cookie })).status, 200);
    assert.equal(f.sched.people.get(me.personId).withdrawnBy, 'self');
    leavers.push(me);
  }
  const enter = (g, gtb, remote) => post(g, '/api/table/enter', { ...gtb, event: secret }, { remote });
  assert.equal((await enter(f, tb, '10.0.5.1')).body.code, 'PRIVATE_EVENT_FULL', 'parties d’elles-mêmes : elles comptent');
  // Redémarrage : la soirée sauvegardée garde le compte.
  const saved = plain(f.night.saves.at(-1));
  assert.equal(saved.scheduler.people.filter(p => p.withdrawnBy === 'self').length, 2, 'départs sauvegardés');
  const restart = snapshot => {
    const g = harness();
    const result = restoreNight(snapshot, { scheduler: g.sched, access: g.access, settings: g.settings });
    g.privateEvent.restore(result.privateEvent);
    return { g, gtb: { table: 'Comptoir', access: g.access.get('Comptoir') } };
  };
  const { g, gtb } = restart(plain(saved));
  assert.equal((await enter(g, gtb, '10.0.5.2')).body.code, 'PRIVATE_EVENT_FULL', 'après un redémarrage aussi');
  // Sauvegarde d'avant ce champ, ou valeur abîmée : jamais d'échec, la fiche
  // partie ne compte plus (comme avant).
  for (const value of [undefined, 'oui']) {
    const old = plain(saved);
    for (const row of old.scheduler.people) {
      if (!row.withdrawnBy) continue;
      if (value === undefined) delete row.withdrawnBy; else row.withdrawnBy = value;
    }
    const { g: h, gtb: htb } = restart(old);
    assert.equal((await enter(h, htb, '10.0.5.3')).status, 200, `withdrawnBy ${value}`);
  }
  // « Parti » du bar libère une fiche, une seule.
  assert.equal((await post(f, staff(f, '/api/staff/person/leave'), { personId: crowd[0].id })).status, 200);
  assert.equal(f.sched.people.get(crowd[0].id).withdrawnBy, 'staff');
  assert.equal((await enter(f, tb, '10.0.5.4')).status, 200);
  assert.equal((await enter(f, tb, '10.0.5.5')).body.code, 'PRIVATE_EVENT_FULL');
  // Partie d'elle-même, réactivée puis marquée partie par le bar : sa fiche se libère.
  assert.equal((await post(f, staff(f, '/api/staff/person/reactivate'), { personId: leavers[0].personId })).status, 200);
  assert.equal((await enter(f, tb, '10.0.5.6')).body.code, 'PRIVATE_EVENT_FULL', 'réactivée : comptée une fois');
  assert.equal((await post(f, staff(f, '/api/staff/person/leave'), { personId: leavers[0].personId })).status, 200);
  assert.equal((await enter(f, tb, '10.0.5.7')).status, 200);
});

// Regression: relecture finale fraîche, première passe (adverse MOYEN,
// décision du gérant) — les personnes de l'événement parties d'elles-mêmes
// après un historique gardaient leur fiche toute la soirée : un script
// (entrée, prénom, un titre, POST /api/leave) fermait le QR de l'événement
// pour de bon, et ni « Renouveler le QR » ni couper puis rallumer le mode ne
// le rouvraient. Le renouvellement libère maintenant les fiches parties
// d'elles-mêmes de l'ancien QR : le plafond des fiches vaut pour chaque QR.
test('événement privé : « Renouveler le QR » libère les fiches parties d’elles-mêmes de l’ancien QR, même après un redémarrage', async () => {
  const { restoreNight } = require('../night-state');
  const f = harness({ persistent: true });
  const { tb } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const enter = (g, gtb, event, remote) => post(g, '/api/table/enter', { ...gtb, event }, { remote });
  // Fiches remplies de départs volontaires avec un titre : la plupart
  // directement, deux par les routes (entrée, prénom, un titre, « Je pars »).
  for (let i = 0; i < MAX_EVENT_PEOPLE - 2; i++) {
    const p = f.sched.join({ tableId: 'Comptoir', name: `Partie ${i}` });
    p.viaEvent = true;
    f.sched.chooseSong(p, song(9000 + i, `Titre ${i}`));
    f.sched.leave(p, 'self');
  }
  for (const name of ['Léa', 'Max']) {
    const me = await eventEntry(f, tb, secret, name);
    assert.equal((await post(f, '/api/table/song', { ...me, song: song(7, name) }, { cookie: me.cookie })).status, 200);
    assert.equal((await post(f, '/api/leave', { token: me.token }, { cookie: me.cookie })).status, 200);
  }
  assert.equal(PrivateEvent.held(f.sched.people.values()), MAX_EVENT_PEOPLE);
  assert.equal((await enter(f, tb, secret, '10.0.7.1')).body.code, 'PRIVATE_EVENT_FULL');
  // Couper puis rallumer le mode ne libère rien.
  assert.equal((await post(f, staff(f, '/api/staff/private-event'), { enabled: false })).status, 200);
  assert.equal((await post(f, staff(f, '/api/staff/private-event'), { enabled: true })).status, 200);
  assert.equal((await enter(f, tb, secret, '10.0.7.2')).body.code, 'PRIVATE_EVENT_FULL', 'couper puis rallumer : toujours complet');
  // « Renouveler le QR » : les fiches parties d'elles-mêmes se libèrent ; elles
  // restent (prénom, historique), marquées parties.
  const rotated = await post(f, staff(f, '/api/staff/private-event'), { rotate: true });
  assert.equal(rotated.status, 200, rotated.text);
  const fresh = new URL(rotated.body.url).searchParams.get('evenement');
  assert.notEqual(fresh, secret);
  assert.equal(PrivateEvent.held(f.sched.people.values()), 0, 'fiches libérées');
  const gone = [...f.sched.people.values()].filter(p => p.withdrawnAt);
  assert.equal(gone.length, MAX_EVENT_PEOPLE, 'les fiches restent');
  assert.ok(gone.every(p => p.withdrawnBy === 'staff'), 'libérées comme un départ marqué par le bar');
  assert.ok(f.sched.log.some(line => /Fiches libérées \(parties d’elles-mêmes\) : 400/.test(line.msg)), 'le journal du bar le dit');
  assert.equal((await enter(f, tb, secret, '10.0.7.3')).body.code, 'PRIVATE_EVENT', 'l’ancien QR est refusé');
  const nina = await eventEntry(f, tb, fresh, 'Nina');
  // Le plafond vaut de nouveau pour le nouveau QR : un départ volontaire y compte.
  assert.equal((await post(f, '/api/table/song', { ...nina, song: song(8, 'Nina') }, { cookie: nina.cookie })).status, 200);
  assert.equal((await post(f, '/api/leave', { token: nina.token }, { cookie: nina.cookie })).status, 200);
  assert.equal(f.sched.people.get(nina.personId).withdrawnBy, 'self');
  assert.equal(PrivateEvent.held(f.sched.people.values()), 1, 'départ volontaire du nouveau QR : compté');
  // Redémarrage : la soirée sauvegardée garde les fiches libérées.
  const saved = plain(f.night.saves.at(-1));
  assert.equal(saved.scheduler.people.filter(p => p.withdrawnBy === 'staff').length, MAX_EVENT_PEOPLE);
  const g = harness();
  const result = restoreNight(saved, { scheduler: g.sched, access: g.access, settings: g.settings });
  g.privateEvent.restore(result.privateEvent);
  const gtb = { table: 'Comptoir', access: g.access.get('Comptoir') };
  assert.equal(PrivateEvent.held(g.sched.people.values()), 1, 'après un redémarrage : seule Nina compte');
  assert.equal((await enter(g, gtb, fresh, '10.0.7.4')).status, 200, 'après un redémarrage, le nouveau QR fait entrer');
});

// Regression: troisième passe de la relecture finale (sécurité CRITIQUE) —
// seule une personne de l'événement sans aucun historique disparaît à son
// départ : un titre demandé (même retiré), un duo, la Battle en cours ou un
// passage sur scène gardent sa fiche partie.
test('événement privé : « Je pars » garde la fiche dès qu’il y a un historique (titre, duo, Battle, passage)', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const leave = me => post(f, '/api/leave', { token: me.token }, { cookie: me.cookie });
  const as = (me, route, extra) => post(f, route, { ...me, ...extra }, { cookie: me.cookie });
  const host = await eventEntry(f, tb, secret, 'Hôte');
  assert.equal((await as(host, '/api/table/song', { song: song(50, 'Titre de l’hôte') })).status, 200);
  const hostEntry = f.sched.songsOf(f.sched.people.get(host.personId))[0].entryId;
  // Assez de votants pour proposer une Battle ; la proposante n'a rien d'autre.
  const voters = [];
  for (let i = 0; i < 4; i++) voters.push(await eventEntry(f, tb, secret, `Votant ${i}`));
  const proposer = await eventEntry(f, tb, secret, 'Proposante');
  const cases = [
    ['titre demandé puis retiré', async me => {
      assert.equal((await as(me, '/api/table/song', { song: song(51, 'Retiré') })).status, 200);
      const entryId = f.sched.songsOf(f.sched.people.get(me.personId))[0].entryId;
      assert.equal((await as(me, '/api/table/song/remove', { entryId })).status, 200);
    }],
    ['invitée d’un duo', async me => {
      const inviter = await eventEntry(f, tb, secret, 'Invitante');
      const r = await as(inviter, '/api/table/duet', { partnerId: me.personId, song: song(52, 'Duo') });
      assert.equal(r.status, 200, r.text);
      assert.ok(f.sched.people.get(me.personId).invite || f.sched.people.get(me.personId).duetOf);
    }],
    ['demande de duo', async me => {
      const r = await as(me, '/api/table/duet/join', { ownerId: host.personId, entryId: hostEntry });
      assert.equal(r.status, 200, r.text);
    }],
    ['vote de la Battle', async me => {
      f.battleVote.propose({ personId: proposer.personId, personName: 'Proposante', eligiblePersonIds: plain(f.battleElectorate()),
        songs: [song(53, 'Battle')] });
      const r = await as(me, '/api/table/battle/vote', { choice: 53 });
      assert.equal(r.status, 200, r.text);
    }],
    ['déjà montée sur scène', async me => { f.sched.people.get(me.personId).sung = 1; }],
    ['invitée d’un duo déjà chanté', async me => { f.sched.people.get(me.personId).duetGuestCount = 1; }],
  ];
  for (const [label, history] of cases) {
    const me = await eventEntry(f, tb, secret, `Avec ${cases.findIndex(([name]) => name === label)}`);
    await history(me);
    const left = await leave(me);
    assert.equal(left.status, 200, `${label} : ${left.text}`);
    const kept = f.sched.people.get(me.personId);
    assert.ok(kept?.withdrawnAt, `${label} : fiche partie gardée`);
    assert.equal(kept.withdrawnBy, 'self', label);
  }
  // Proposer la Battle en cours compte aussi.
  assert.equal((await leave(proposer)).status, 200);
  assert.ok(f.sched.people.get(proposer.personId)?.withdrawnAt, 'proposante de la Battle : gardée');
  // Pouvoir voter sans avoir voté n'est pas un historique : sa fiche disparaît.
  const silent = voters[0];
  assert.ok(f.battleVote.ballot.eligiblePersonIds.includes(silent.personId));
  assert.equal((await leave(silent)).status, 200);
  assert.equal(f.sched.people.has(silent.personId), false, 'votante possible sans vote : retirée');
});

// Relecture finale fraîche (tests) : deux gardes de withoutHistory n'étaient
// vérifiées par aucun test (les retirer laissait tout passer). Une invitée
// d'un duo accepté, ou une personne citée par un titre en route vers KaraFun
// (envoi en attente ou titre suivi), garde sa fiche à « Je pars ».
test('événement privé : « Je pars » d’une invitée de duo accepté garde sa fiche, le duo est défait, la soirée se reprend', async () => {
  const { restoreNight } = require('../night-state');
  const f = harness({ persistent: true });
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const as = (me, route, extra) => post(f, route, { ...me, ...extra }, { cookie: me.cookie });
  const ana = await eventEntry(f, tb, secret, 'Ana');
  const bea = await eventEntry(f, tb, secret, 'Bea');
  assert.equal((await as(ana, '/api/table/duet', { partnerId: bea.personId, song: song(77, 'Duo Ana Bea') })).status, 200);
  const entryId = f.sched.songsOf(f.sched.people.get(ana.personId))[0].entryId;
  assert.equal((await as(bea, '/api/table/duet/answer', { accept: true, entryId })).status, 200);
  const b = f.sched.people.get(bea.personId);
  assert.equal(b.duetOf, ana.personId);
  assert.deepEqual([b.sung || 0, b.lastAppearanceTurn || 0, f.sched.Q.includes(b.id), !!b.invite, f.sched.songsOf(b).length],
    [0, 0, false, false, 0], 'seul le duo accepté la cite');
  assert.equal((await post(f, '/api/leave', { token: bea.token }, { cookie: bea.cookie })).status, 200);
  assert.ok(f.sched.people.get(bea.personId)?.withdrawnAt, 'fiche partie gardée');
  assert.equal(f.sched.people.get(bea.personId).withdrawnBy, 'self');
  assert.equal(f.sched.songsOf(f.sched.people.get(ana.personId))[0].duet, undefined, 'le titre d’Ana redevient un solo');
  const restored = harness();
  restoreNight(plain(f.night.saves.at(-1)), { scheduler: restored.sched, access: restored.access, settings: restored.settings });
  assert.ok(restored.sched.people.get(bea.personId)?.withdrawnAt);
});

test('événement privé : « Je pars » garde la fiche d’une personne citée par un titre en route vers KaraFun (envoi ou titre suivi)', async () => {
  for (const where of ['pending', 'tracked']) {
    const f = harness();
    const { tb } = openSolo(f);
    const secret = f.privateEvent.enable();
    const ana = await eventEntry(f, tb, secret, 'Ana');
    const gil = await eventEntry(f, tb, secret, 'Gil');
    const sel = { ids: [ana.personId, gil.personId], names: ['Ana', 'Gil'], label: 'Ana & Gil', kind: 'duo',
      song: { songId: 88, title: 'Duo en route', artist: 'Artiste', entryId: 'e-88' } };
    if (where === 'pending') f.setPending({ sel, before: new Set(), at: Date.now(), attempts: 1 });
    else f.setTracked([{ queueId: 901, sel, addedAt: Date.now(), startedAt: null, cancelled: true, removeRequestedAt: Date.now(), uncommitted: true }]);
    const g = f.sched.people.get(gil.personId);
    assert.deepEqual([g.sung || 0, g.lastAppearanceTurn || 0, f.sched.roundPeople.has(g.id), f.sched.Q.includes(g.id), !!g.duetOf, !!g.invite],
      [0, 0, false, false, false, false], `${where} : seul le titre en route la cite`);
    assert.equal((await post(f, '/api/leave', { token: gil.token }, { cookie: gil.cookie })).status, 200);
    assert.ok(f.sched.people.get(gil.personId)?.withdrawnAt, `${where} : fiche partie gardée`);
  }
});

// Regression: vérification de la troisième passe de la relecture finale —
// withoutHistory ne regardait pas le tour en cours. Un duo chargé dans
// KaraFun qui ouvre un nouveau tour, puis passé avant la lecture après un duo
// noté au bar sur le passage en scène, laisse son invitée dans les personnes
// du tour, compteurs remis à zéro (rollbackUnplayed). « Je pars » retirait sa
// fiche : chaque sauvegarde citait une personne inconnue et la soirée ne
// redémarrait plus (« personne du tour inconnue »).
test('événement privé : « Je pars » garde la fiche d’une personne encore comptée dans le tour (duo passé dans KaraFun)', async () => {
  const { restoreNight } = require('../night-state');
  const f = harness({ persistent: true });
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const as = (me, route, extra) => post(f, route, { ...me, ...extra }, { cookie: me.cookie });
  const ok = r => assert.equal(r.status, 200, r.text);
  const entryOf = me => f.sched.songsOf(f.sched.people.get(me.personId))[0].entryId;
  const olga = await eventEntry(f, tb, secret, 'Olga');
  const gil = await eventEntry(f, tb, secret, 'Gil');
  const ana = await eventEntry(f, tb, secret, 'Ana');
  const bea = await eventEntry(f, tb, secret, 'Bea');
  // Olga passe deux fois dans le tour (son solo, puis invitée d'Ana) : plafond atteint.
  ok(await as(olga, '/api/table/song', { song: song(101, 'Solo Olga') }));
  f.sched.commit(f.sched.select({ stageFree: true }));
  ok(await as(ana, '/api/table/duet', { partnerId: olga.personId, song: song(102, 'Duo Ana Olga') }));
  ok(await as(olga, '/api/table/duet/answer', { accept: true, entryId: entryOf(ana) }));
  f.sched.commit(f.sched.select({ stageFree: true }));
  // Bea chante ; le duo d'Olga avec Gil (qui n'a rien demandé) est chargé ensuite et ouvre un nouveau tour.
  ok(await as(bea, '/api/table/song', { song: song(104, 'Solo Bea') }));
  const stage = f.sched.select({ stageFree: true });
  assert.deepEqual(stage.ids, [bea.personId]);
  f.sched.commit(stage);
  ok(await as(olga, '/api/table/duet', { partnerId: gil.personId, song: song(103, 'Duo Olga Gil') }));
  ok(await as(gil, '/api/table/duet/answer', { accept: true, entryId: entryOf(olga) }));
  const duo = f.sched.select({ stageFree: false });
  assert.deepEqual([duo.ids, duo.newPersonRound], [[olga.personId, gil.personId], true]);
  f.sched.commit(duo);
  const onStage = { sel: stage, queueId: 501, addedAt: Date.now() - 1000, startedAt: Date.now() };
  f.setTracked([onStage, { sel: duo, queueId: 502, addedAt: Date.now() }]);
  // Le bar note Ana en duo avec Bea ; le duo est ensuite passé dans KaraFun avant la lecture (sync).
  ok(await post(f, staff(f, '/api/staff/duo-mark'), { queueId: 501, partnerId: ana.personId }));
  f.sched.rollbackUnplayed(duo, { requeue: true });
  f.setTracked([onStage]);
  const g = f.sched.people.get(gil.personId);
  assert.deepEqual([f.sched.roundPeople.has(g.id), g.sung, g.duetGuestCount || 0, g.lastAppearanceTurn || 0, f.sched.Q.includes(g.id)],
    [true, 0, 0, 0, false], 'Gil reste compté dans le tour, sans autre historique');
  ok(await post(f, '/api/leave', { token: gil.token }, { cookie: gil.cookie }));
  assert.ok(f.sched.people.get(gil.personId)?.withdrawnAt, 'compté dans le tour : fiche partie gardée');
  assert.equal(f.sched.people.get(gil.personId).withdrawnBy, 'self');
  // La sauvegarde écrite par la route se reprend au redémarrage.
  const restored = harness();
  restoreNight(plain(f.night.saves.at(-1)), { scheduler: restored.sched, access: restored.access, settings: restored.settings });
  assert.ok(restored.sched.people.get(gil.personId)?.withdrawnAt);
  assert.ok(restored.sched.roundPeople.has(gil.personId));
});

// Regression: troisième relecture finale (ADV F1, M3-4) — un QR personnel neuf
// retirait la place sans prénom de ce navigateur même quand elle venait d'un
// AUTRE QR personnel : ce premier QR était brûlé, son vrai propriétaire lisait
// « invitation déjà utilisée ».
test('deux QR personnels sur un navigateur : le second refusé sans brûler le premier, chaque papier finit par servir', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const qrA = invite();
  const qrB = invite();
  const x = await opened(f, tb, qrA);
  const second = await post(f, '/api/table/solo/open', { ...tb, invitation: qrB }, { cookie: x.cookie });
  assert.equal(second.status, 403, second.text);
  assert.equal(second.body.code, 'SOLO_DEVICE_USED');
  assert.ok(f.sched.people.has(x.personId), 'la place du QR A reste');
  assert.ok(f.soloInvitations.verify(qrB, 'Comptoir'), 'le QR B reste neuf');
  // Le bar donne le papier A à Y : il reprend la place encore sans prénom.
  const taken = await post(f, '/api/table/solo/open', { ...tb, invitation: qrA }, { remote: '10.0.7.1' });
  assert.equal(taken.status, 200, taken.text);
  assert.deepEqual([taken.body.id, taken.body.recovered], [x.personId, true]);
  const y = { ...tb, personId: taken.body.id, token: taken.body.token, cookie: cookieOf(taken) };
  // X rouvre le QR B : sa propre place, cette fois.
  const mine = await post(f, '/api/table/solo/open', { ...tb, invitation: qrB }, { cookie: x.cookie });
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.body.nameRequired, true);
  assert.notEqual(mine.body.id, y.personId);
  const xb = { ...tb, personId: mine.body.id, token: mine.body.token, cookie: cookieOf(mine) || x.cookie };
  assert.deepEqual((await stateOf(f, tb, xb)).body.managedIds, [xb.personId]);
  assert.deepEqual((await stateOf(f, tb, y)).body.managedIds, [y.personId]);
  for (const [me, name] of [[y, 'Yanis'], [xb, 'Xavier']]) {
    const r = await post(f, '/api/table/person/rename', { ...me, name }, { cookie: me.cookie });
    assert.equal(r.status, 200, r.text);
  }
  // Chaque papier retrouve sa personne sur son navigateur, et ailleurs la propose.
  assert.equal((await post(f, '/api/table/solo/open', { ...tb, invitation: qrA }, { cookie: y.cookie })).body.id, y.personId);
  assert.equal((await post(f, '/api/table/solo/open', { ...tb, invitation: qrB }, { cookie: xb.cookie })).body.id, xb.personId);
  assert.deepEqual(plain((await post(f, '/api/table/solo/open', { ...tb, invitation: qrA })).body), { recover: { id: y.personId, name: 'Yanis' } });
  assert.deepEqual(plain((await post(f, '/api/table/solo/open', { ...tb, invitation: qrB })).body), { recover: { id: xb.personId, name: 'Xavier' } });
});

test('place sans prénom reprise ailleurs par sa clé : sauvegarde impossible = rien ne bouge, ni pour la reprise ni pour le QR neuf', async () => {
  const f = harness({ persistent: true });
  const { tb, invite } = openSolo(f);
  const qrA = invite();
  const x = await opened(f, tb, qrA);
  const mine = f.sched.people.get(x.personId).soloDeviceHashes.slice();
  f.night.fail = 'disque plein';
  const refused = await post(f, '/api/table/solo/open', { ...tb, invitation: qrA }, { remote: '10.0.7.1' });
  assert.equal(refused.status, 400, refused.text);
  assert.deepEqual(f.sched.people.get(x.personId).soloDeviceHashes, mine, 'X reste attaché à sa place');
  assert.deepEqual((await stateOf(f, tb, x)).body.managedIds, [x.personId]);
  f.night.fail = null;
  const taken = await post(f, '/api/table/solo/open', { ...tb, invitation: qrA }, { remote: '10.0.7.1' });
  assert.equal(taken.status, 200, taken.text);
  const devices = f.sched.people.get(x.personId).soloDeviceHashes.slice();
  assert.equal(devices.length, 1, 'seul le navigateur de Y reste attaché');
  const size = f.sched.people.size;
  const qrB = invite();
  f.night.fail = 'disque plein';
  const failed = await post(f, '/api/table/solo/open', { ...tb, invitation: qrB }, { cookie: x.cookie });
  assert.equal(failed.status, 400, failed.text);
  assert.deepEqual(f.sched.people.get(x.personId).soloDeviceHashes, devices, 'téléphones de la place inchangés');
  assert.equal(f.sched.people.size, size);
  assert.ok(f.soloInvitations.verify(qrB, 'Comptoir'), 'QR B intact');
  f.night.fail = null;
  assert.equal((await post(f, '/api/table/solo/open', { ...tb, invitation: qrB }, { cookie: x.cookie })).status, 200);
  assert.deepEqual(f.sched.people.get(x.personId).soloDeviceHashes, devices, 'la place reprise reste à Y');
});

test('reprise : une place sans prénom d’un QR personnel ne part jamais ; ce navigateur la quitte pour un profil nommé', async () => {
  const f = harness({ persistent: true });
  const { tb, invite } = openSolo(f);
  const qrA = invite();
  const x = await opened(f, tb, qrA);
  // Le QR personnel d'une autre place sans prénom, ouvert par X : refusé, rien ne bouge.
  const qrK = invite();
  const other = await opened(f, tb, qrK);
  const byKey = await post(f, '/api/table/solo/open', { ...tb, invitation: qrK }, { cookie: x.cookie });
  assert.equal(byKey.status, 403, byKey.text);
  assert.equal(byKey.body.code, 'SOLO_DEVICE_USED');
  const direct = await post(f, '/api/table/person/claim', { ...tb, key: qrK }, { cookie: x.cookie });
  assert.equal(direct.body.code, 'SOLO_DEVICE_USED');
  assert.ok(f.sched.people.has(x.personId), 'la place du QR A reste');
  assert.deepEqual((await stateOf(f, tb, other)).body.managedIds, [other.personId], 'l’autre place reste à son navigateur');
  assert.deepEqual((await stateOf(f, tb, x)).body.managedIds, [x.personId]);
  // Reprendre son profil nommé par le code (RT1) : ce navigateur quitte la
  // place provisoire, qui reste à son papier (vérification de la troisième
  // passe, V2) ; sauvegarde impossible : rien ne bouge.
  const clara = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...clara, name: 'Clara' }, { cookie: clara.cookie });
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: clara.personId });
  const mine = f.sched.people.get(x.personId).soloDeviceHashes.slice();
  f.night.fail = 'disque plein';
  const failed = await post(f, '/api/table/person/claim', { ...tb, personId: clara.personId, code: share.body.code }, { cookie: x.cookie });
  assert.equal(failed.status, 400, failed.text);
  assert.deepEqual(f.sched.people.get(x.personId).soloDeviceHashes, mine, 'X reste le téléphone de sa place');
  assert.deepEqual((await stateOf(f, tb, x)).body.managedIds, [x.personId]);
  f.night.fail = null;
  const claimed = await post(f, '/api/table/person/claim', { ...tb, personId: clara.personId, code: share.body.code }, { cookie: x.cookie });
  assert.equal(claimed.status, 200, claimed.text);
  assert.ok(f.sched.people.has(x.personId), 'la place du QR A reste');
  assert.equal(f.sched.people.get(x.personId).soloDeviceHashes, undefined, 'plus aucun navigateur attaché');
  // Son papier la retrouve, sans question.
  const owner = await post(f, '/api/table/solo/open', { ...tb, invitation: qrA }, { remote: '10.0.8.4' });
  assert.deepEqual([owner.status, owner.body.id], [200, x.personId]);
});

// Regression: troisième relecture finale (ADV F2) — le téléphone d'un soliste
// marqué parti qui ouvrait un QR personnel neuf lisait « Ce téléphone a déjà
// un prénom inscrit » au lieu de « marquée partie, demande au bar ».
test('soliste marqué parti : un QR personnel neuf sur son téléphone répond PERSON_LEFT, le QR reste neuf', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...sam, name: 'Sam' }, { cookie: sam.cookie });
  await post(f, staff(f, '/api/staff/person/leave'), { personId: sam.personId });
  const fresh = invite();
  for (const [route, extra] of [['/api/table/solo/open', {}], ['/api/table/person', { name: 'Sam B.' }], ['/api/join', { name: 'Sam B.' }]]) {
    const r = await post(f, route, { ...tb, invitation: fresh, ...extra }, { cookie: sam.cookie });
    assert.equal(r.status, 403, `${route} : ${r.text}`);
    assert.equal(r.body.code, 'PERSON_LEFT', route);
    assert.equal(r.body.error, 'Cette personne a été marquée partie. Demande au bar de la réactiver.');
  }
  assert.ok(f.soloInvitations.verify(fresh, 'Comptoir'), 'le QR neuf reste utilisable');
  assert.equal(f.sched.tableSingers('Comptoir').length, 1, 'personne de créé');
  // Réactivé par le bar : son téléphone a de nouveau un prénom inscrit.
  await post(f, staff(f, '/api/staff/person/reactivate'), { personId: sam.personId });
  assert.equal((await post(f, '/api/table/solo/open', { ...tb, invitation: fresh }, { cookie: sam.cookie })).body.code, 'SOLO_DEVICE_USED');
});

// Regression: troisième relecture finale (S3-2) — POST /api/photo acceptait
// une place sans prénom (400 Ko gardés en mémoire par place, revus à chaque
// sauvegarde).
test('photo : refusée à une place sans prénom, acceptée une fois le prénom donné, taille bornée', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  const photo = `data:image/png;base64,${Buffer.from('petite image').toString('base64')}`;
  const unnamed = await post(f, '/api/photo', { token: sam.token, photo }, { cookie: sam.cookie });
  assert.equal(unnamed.status, 400, unnamed.text);
  assert.equal(unnamed.body.code, 'NAME_REQUIRED');
  assert.equal(f.sched.people.get(sam.personId).photo, null);
  assert.equal(f.sched.people.get(sam.personId).lastActionAt, undefined, 'un refus n’est pas une action');
  await post(f, '/api/table/person/rename', { ...sam, name: 'Sam' }, { cookie: sam.cookie });
  const ok = await post(f, '/api/photo', { token: sam.token, photo }, { cookie: sam.cookie });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(f.sched.people.get(sam.personId).photo.buf.toString(), 'petite image');
  const big = `data:image/png;base64,${Buffer.alloc(400 * 1024 + 1).toString('base64')}`;
  assert.equal((await post(f, '/api/photo', { token: sam.token, photo: big }, { cookie: sam.cookie })).status, 200);
  assert.equal(f.sched.people.get(sam.personId).photo, null, 'au-delà de 400 Ko : rien n’est gardé');
});

// Regression: troisième relecture finale (A3-1) — « prénom déjà pris »
// renvoyait toujours vers la reprise par code, même quand la personne de ce
// prénom ne peut pas être reprise depuis ce téléphone (partie, autre groupe).
test('prénom déjà pris : le serveur dit si la personne de ce prénom se reprend d’ici', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const named = async name => {
    const me = await opened(f, tb, invite());
    await post(f, '/api/table/person/rename', { ...me, name }, { cookie: me.cookie });
    return me;
  };
  await named('Léa');
  const gone = await named('Zoé');
  await post(f, staff(f, '/api/staff/person/leave'), { personId: gone.personId });
  const elsewhere = f.sched.table('Solo 2');
  elsewhere.individual = true;
  f.sched.join({ tableId: elsewhere.id, name: 'Inès' });
  const sam = await opened(f, tb, invite());
  const rename = name => post(f, '/api/table/person/rename', { ...sam, name }, { cookie: sam.cookie });
  for (const [name, recoverable] of [['Léa', true], [' léa ', true], ['Zoé', false], ['Inès', false]]) {
    const r = await rename(name);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.body.code, 'NAME_TAKEN');
    assert.equal(r.body.recoverable, recoverable, name);
  }
  // Une place nommée qui change de prénom : pas de reprise par code d'ici.
  const max = await named('Max');
  const taken = await post(f, '/api/table/person/rename', { ...max, name: 'Léa' }, { cookie: max.cookie });
  assert.equal(taken.body.code, 'NAME_TAKEN');
  assert.equal(taken.body.recoverable, false);
  // Table ordinaire : rien de nouveau.
  const table = openTable(f, '3');
  const a = await post(f, '/api/table/person', { ...table, name: 'Ana' });
  const b = await post(f, '/api/table/person', { ...table, name: 'Bea' });
  const dup = await post(f, '/api/table/person/rename', { ...table, personId: b.body.id, token: b.body.token, name: 'Ana' });
  assert.equal(dup.body.code, 'NAME_TAKEN');
  assert.equal('recoverable' in dup.body, false);
  assert.ok(a.body.id);
});

// ================================================================ vérification de la troisième passe (V1 à V5)
// Regression: vérification de la troisième passe (V1) — l'ancien navigateur
// d'une place sans prénom reprise ailleurs par sa clé personnelle n'en était
// détaché que par un QR neuf ouvert AVANT que le nouveau téléphone donne un
// prénom : une fois la place nommée, il restait « propriétaire » de cette
// personne, et tout QR individuel neuf lui répondait SOLO_DEVICE_USED (ou
// PERSON_LEFT, V3, si elle était ensuite marquée partie).
test('place sans prénom reprise par sa clé : l’ancien navigateur est libre tout de suite, même après le prénom', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const qrA = invite();
  const qrB = invite();
  const x = await opened(f, tb, qrA);
  assert.equal((await post(f, '/api/table/solo/open', { ...tb, invitation: qrB }, { cookie: x.cookie })).body.code, 'SOLO_DEVICE_USED');
  // Le bar donne le papier A à Y, qui le reprend et donne tout de suite son prénom.
  const taken = await post(f, '/api/table/solo/open', { ...tb, invitation: qrA }, { remote: '10.0.7.1' });
  assert.equal(taken.status, 200, taken.text);
  const y = { ...tb, personId: taken.body.id, token: taken.body.token, cookie: cookieOf(taken) };
  assert.equal(f.sched.people.get(y.personId).soloDeviceHashes.length, 1, 'seul le navigateur de Y reste attaché');
  assert.equal((await post(f, '/api/table/person/rename', { ...y, name: 'Yanis' }, { cookie: y.cookie })).status, 200);
  // X rouvre le papier B : sa propre place.
  const mine = await post(f, '/api/table/solo/open', { ...tb, invitation: qrB }, { cookie: x.cookie });
  assert.equal(mine.status, 200, mine.text);
  assert.notEqual(mine.body.id, y.personId);
  assert.deepEqual((await stateOf(f, tb, y)).body.managedIds, [y.personId], 'Yanis garde sa place');
  // Même chose si Yanis est ensuite marqué parti : un autre navigateur Z qui
  // avait ouvert A avant lui n'est jamais pris pour Yanis (V3).
  const qrC = invite();
  const z = await opened(f, tb, qrC);
  const takenC = await post(f, '/api/table/solo/open', { ...tb, invitation: qrC }, { remote: '10.0.7.2' });
  const w = { ...tb, personId: takenC.body.id, token: takenC.body.token, cookie: cookieOf(takenC) };
  await post(f, '/api/table/person/rename', { ...w, name: 'Wanda' }, { cookie: w.cookie });
  await post(f, staff(f, '/api/staff/person/leave'), { personId: w.personId });
  const fresh = await post(f, '/api/table/solo/open', { ...tb, invitation: invite() }, { cookie: z.cookie });
  assert.equal(fresh.status, 200, fresh.text);
});

// Regression: vérification de la troisième passe (V2) — reprendre son profil
// nommé (code, lien) depuis un navigateur qui avait ouvert par erreur le QR
// personnel de quelqu'un d'autre supprimait cette place : le papier était
// brûlé (« Cette invitation a déjà été utilisée »).
test('reprise d’un profil nommé : la place sans prénom d’un QR personnel reste à son papier, ce navigateur la quitte', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const xavier = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...xavier, name: 'Xavier' }, { cookie: xavier.cookie });
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: xavier.personId });
  // Le nouveau téléphone de Xavier ouvre par erreur le papier d'Alice.
  const qrAlice = invite();
  const mistake = await opened(f, tb, qrAlice);
  const claimed = await post(f, '/api/table/person/claim', { ...tb, personId: xavier.personId, code: share.body.code }, { cookie: mistake.cookie });
  assert.equal(claimed.status, 200, claimed.text);
  assert.ok(f.sched.people.has(mistake.personId), 'la place du papier d’Alice reste');
  const back = { ...tb, personId: xavier.personId, token: claimed.body.token, cookie: cookieOf(claimed) || mistake.cookie };
  assert.deepEqual((await stateOf(f, tb, back)).body.managedIds, [xavier.personId], 'ce navigateur ne gère que Xavier');
  // Alice scanne son papier : elle retrouve sa place, sans question.
  const alice = await post(f, '/api/table/solo/open', { ...tb, invitation: qrAlice }, { remote: '10.0.8.1' });
  assert.equal(alice.status, 200, alice.text);
  assert.deepEqual([alice.body.id, alice.body.nameRequired], [mistake.personId, true]);
});

// Regression: vérification de la troisième passe (V3) — PERSON_LEFT n'est dit
// qu'au téléphone actuel de la personne marquée partie : un ancien téléphone
// (profil passé depuis sur un autre) n'a pas à faire réactiver cette personne.
test('personne marquée partie : seul son téléphone actuel lit PERSON_LEFT, un ancien téléphone SOLO_DEVICE_USED', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const old = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...old, name: 'Alice' }, { cookie: old.cookie });
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: old.personId });
  const moved = await post(f, '/api/table/person/claim', { ...tb, personId: old.personId, code: share.body.code }, { remote: '10.0.8.2' });
  assert.equal(moved.status, 200, moved.text);
  await post(f, staff(f, '/api/staff/person/leave'), { personId: old.personId });
  const fresh = invite();
  for (const [route, extra] of [['/api/table/solo/open', {}], ['/api/table/person', { name: 'Ana' }], ['/api/join', { name: 'Ana' }]]) {
    const stale = await post(f, route, { ...tb, invitation: fresh, ...extra }, { cookie: old.cookie });
    assert.equal(stale.body.code, 'SOLO_DEVICE_USED', `${route} : ancien téléphone`);
    const current = await post(f, route, { ...tb, invitation: fresh, ...extra }, { cookie: cookieOf(moved) });
    assert.equal(current.body.code, 'PERSON_LEFT', `${route} : téléphone actuel`);
  }
});

// Regression: vérification de la troisième passe (V4, V5) — une invitée qui
// avait vu sa fenêtre de prénom moins d'une minute (puis téléphone verrouillé)
// perdait sa place dix minutes plus tard, et sa page lisait « QR plus actif » ;
// une place dont le bar venait de donner un code de reprise partait aussi.
test('événement privé : une page vue quelques secondes ou une place avec un code de reprise ne sont pas retirées', async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const f = harness({ clock: true });
    const { tb } = openSolo(f);
    const secret = f.privateEvent.enable();
    const seen = await eventEntry(f, tb, secret);
    await stateOf(f, tb, seen, { 'x-page-visible': '1' }); // lecture qui suit l'ouverture
    clock += 5000;
    await stateOf(f, tb, seen, { 'x-page-visible': '1' }); // relue 5 s plus tard, puis verrouillé
    const shared = await eventEntry(f, tb, secret);
    const never = await eventEntry(f, tb, secret);
    clock += 9 * 60000;
    const code = await post(f, staff(f, '/api/staff/person/share'), { personId: shared.personId });
    assert.equal(code.status, 200, code.text);
    clock += 2 * 60000;
    await eventEntry(f, tb, secret);
    assert.ok(f.sched.people.has(seen.personId), 'page vue : place gardée');
    assert.deepEqual((await stateOf(f, tb, seen)).body.managedIds, [seen.personId]);
    assert.ok(f.sched.people.has(shared.personId), 'code de reprise donné : place gardée');
    assert.equal(f.sched.people.has(never.personId), false, 'jamais relue : retirée');
    const claimed = await post(f, '/api/table/person/claim', { ...tb, personId: shared.personId, code: code.body.code }, { remote: '10.0.8.3' });
    assert.equal(claimed.status, 200, claimed.text);
  } finally {
    Date.now = realNow;
  }
});

// ================================================================ quatrième relecture finale
// Regression: quatrième relecture finale (sécurité, décision D2 « La clé
// meurt ») — la clé personnelle n'était que suspendue pendant le départ :
// « Réactiver » la ranimait, et quiconque gardait l'adresse du QR personnel
// reprenait le profil après chaque retour.
test('QR personnel : marquée partie, la clé meurt ; « Réactiver » ne la ranime pas, le QR de reprise rend l’accès', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  for (const [name, leave] of [
    ['Sam', me => post(f, staff(f, '/api/staff/person/leave'), { personId: me.personId })],
    ['Inès', me => post(f, '/api/leave', { token: me.token }, { cookie: me.cookie })],
  ]) {
    const key = invite();
    const me = await opened(f, tb, key);
    await post(f, '/api/table/person/rename', { ...me, name }, { cookie: me.cookie });
    const left = await leave(me);
    assert.equal(left.status, 200, left.text);
    // Partie : la clé dit « marquée partie », sur tout navigateur (inchangé).
    for (const cookie of [undefined, me.cookie]) {
      assert.equal((await post(f, '/api/table/solo/open', { ...tb, invitation: key }, { cookie })).body.code, 'PERSON_LEFT', name);
    }
    const back = await post(f, staff(f, '/api/staff/person/reactivate'), { personId: me.personId });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.body.message, `${name} revient. Son QR personnel ne sert plus : s’il a perdu sa page, donne-lui un QR de reprise.`);
    // Réactivée : la clé ne l'ouvre plus, ni ailleurs ni sur son propre navigateur, ni par la reprise.
    for (const cookie of [undefined, me.cookie]) {
      const refused = await post(f, '/api/table/solo/open', { ...tb, invitation: key }, { cookie });
      assert.equal(refused.status, 403, refused.text);
      assert.equal(refused.body.code, 'SOLO_KEY_REVOKED');
      assert.equal(refused.body.error, 'Ce QR personnel n’est plus valable. Demande au bar un QR de reprise.');
      assert.equal(refused.headers['set-cookie'], undefined);
    }
    const claim = await post(f, '/api/table/person/claim', { ...tb, key });
    assert.equal(claim.body.error, 'Ce QR personnel n’est plus valable. Demande au bar un QR de reprise.');
    assert.equal(f.sched.people.get(me.personId).token, me.token, 'rien de repris par la clé');
    // Son téléphone, lui, retrouve ses droits avec la réactivation.
    assert.deepEqual((await stateOf(f, tb, me)).body.managedIds, [me.personId]);
    // Le bar rend l'accès ailleurs par un QR de reprise ; la clé reste morte.
    const share = await post(f, staff(f, '/api/staff/person/share'), { personId: me.personId });
    const handed = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) });
    assert.equal(handed.status, 200, handed.text);
    assert.equal(handed.body.id, me.personId);
    assert.equal((await post(f, '/api/table/solo/open', { ...tb, invitation: key }, { cookie: cookieOf(handed) })).body.code, 'SOLO_KEY_REVOKED');
  }
  // Réactiver une personne sans clé personnelle : message habituel du bar.
  const table = openTable(f, '3');
  const ana = await post(f, '/api/table/person', { ...table, name: 'Ana' });
  await post(f, staff(f, '/api/staff/person/leave'), { personId: ana.body.id });
  assert.deepEqual((await post(f, staff(f, '/api/staff/person/reactivate'), { personId: ana.body.id })).body, { ok: true });
});

test('clé morte : la sauvegarde garde la révocation après un redémarrage, même depuis une sauvegarde d’avant ce champ', async () => {
  const { restoreNight } = require('../night-state');
  const f = harness({ persistent: true });
  const { tb, invite } = openSolo(f);
  const key = invite();
  const me = await opened(f, tb, key);
  await post(f, '/api/table/person/rename', { ...me, name: 'Sam' }, { cookie: me.cookie });
  await post(f, staff(f, '/api/staff/person/leave'), { personId: me.personId });
  await post(f, staff(f, '/api/staff/person/reactivate'), { personId: me.personId });
  const saved = plain(f.night.saves.at(-1));
  assert.equal(saved.scheduler.people.find(p => p.id === me.personId).soloKeyRevoked, true, 'révocation sauvegardée');
  // Redémarrage : la soirée sauvegardée reprise par un nouveau serveur.
  const restart = snapshot => {
    const g = harness();
    restoreNight(snapshot, { scheduler: g.sched, access: g.access, settings: g.settings });
    return { g, gtb: { table: 'Comptoir', access: g.access.get('Comptoir') } };
  };
  const { g, gtb } = restart(plain(saved));
  assert.equal((await post(g, '/api/table/solo/open', { ...gtb, invitation: key })).body.code, 'SOLO_KEY_REVOKED');
  // Sauvegarde d'avant ce champ : partie avec sa clé, elle l'a perdue.
  const old = plain(saved);
  const row = old.scheduler.people.find(p => p.id === me.personId);
  delete row.soloKeyRevoked;
  row.withdrawnAt = Date.now();
  const { g: h, gtb: htb } = restart(old);
  assert.equal((await post(h, '/api/table/solo/open', { ...htb, invitation: key })).body.code, 'PERSON_LEFT');
  await post(h, staff(h, '/api/staff/person/reactivate'), { personId: me.personId });
  assert.equal((await post(h, '/api/table/solo/open', { ...htb, invitation: key })).body.code, 'SOLO_KEY_REVOKED');
  // Présente dans une sauvegarde d'avant ce champ : sa clé vit toujours.
  const present = plain(saved);
  delete present.scheduler.people.find(p => p.id === me.personId).soloKeyRevoked;
  const { g: k, gtb: ktb } = restart(present);
  assert.deepEqual((await post(k, '/api/table/solo/open', { ...ktb, invitation: key })).body, { recover: { id: me.personId, name: 'Sam' } });
});

// Regression: seconde passe de la quatrième relecture finale (maintenabilité)
// — la reprise par une clé morte recopiait le texte de soloKeyRevokedError()
// sans son code : 400 et code null, quand l'ouverture du même QR répond 403
// SOLO_KEY_REVOKED.
test('clé morte : « Récupérer mes chansons » répond comme l’ouverture du QR (403, SOLO_KEY_REVOKED, même texte)', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const key = invite();
  const me = await opened(f, tb, key);
  await post(f, '/api/table/person/rename', { ...me, name: 'Sam' }, { cookie: me.cookie });
  // Téléphone B : « C’est bien toi, Sam ? ».
  assert.deepEqual((await post(f, '/api/table/solo/open', { ...tb, invitation: key })).body, { recover: { id: me.personId, name: 'Sam' } });
  // Le bar marque Sam « Parti » par erreur, puis « Réactiver » ; B touche « Récupérer mes chansons ».
  await post(f, staff(f, '/api/staff/person/leave'), { personId: me.personId });
  await post(f, staff(f, '/api/staff/person/reactivate'), { personId: me.personId });
  const claim = await post(f, '/api/table/person/claim', { ...tb, key });
  const open = await post(f, '/api/table/solo/open', { ...tb, invitation: key });
  assert.deepEqual([claim.status, claim.body.code, claim.body.error], [open.status, open.body.code, open.body.error]);
  assert.deepEqual([claim.status, claim.body.code], [403, 'SOLO_KEY_REVOKED']);
  assert.equal(f.sched.people.get(me.personId).token, me.token, 'rien de repris par la clé');
});

// Regression: troisième passe de la relecture finale (maintenabilité, contrat
// d'API) — pendant qu'une personne est marquée partie, ouvrir son QR
// personnel répondait PERSON_LEFT (« Demande au bar de la réactiver », D2),
// mais « Récupérer mes chansons » avec la même clé SOLO_KEY_REVOKED
// (« Demande au bar un QR de reprise »), un QR que le bar ne peut pas faire
// pour une personne partie.
test('QR personnel d’une personne partie : « Récupérer mes chansons » répond comme son ouverture (PERSON_LEFT, D2)', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const key = invite();
  const me = await opened(f, tb, key);
  await post(f, '/api/table/person/rename', { ...me, name: 'Sam' }, { cookie: me.cookie });
  // Téléphone B : « C’est bien toi, Sam ? » ; pendant ce temps le bar marque Sam « Parti ».
  assert.deepEqual((await post(f, '/api/table/solo/open', { ...tb, invitation: key })).body, { recover: { id: me.personId, name: 'Sam' } });
  await post(f, staff(f, '/api/staff/person/leave'), { personId: me.personId });
  const open = await post(f, '/api/table/solo/open', { ...tb, invitation: key });
  const claim = await post(f, '/api/table/person/claim', { ...tb, key });
  assert.deepEqual([open.status, open.body.code], [403, 'PERSON_LEFT']);
  assert.deepEqual([claim.status, claim.body.code, claim.body.error], [open.status, open.body.code, open.body.error]);
  assert.equal(claim.headers['set-cookie'], undefined);
  assert.equal(f.sched.people.get(me.personId).token, me.token, 'rien de repris par la clé');
  // Réactivée : la clé est morte, à son ouverture comme à la reprise (D2, inchangé).
  await post(f, staff(f, '/api/staff/person/reactivate'), { personId: me.personId });
  const revoked = await post(f, '/api/table/person/claim', { ...tb, key });
  assert.deepEqual([revoked.status, revoked.body.code], [403, 'SOLO_KEY_REVOKED']);
});

// Regression: quatrième relecture finale (sécurité) — le secret de
// l'événement privé, donné pour « En solo », ouvrait une place dans
// n'importe quel groupe individuel créé par le bar.
test('événement privé : le secret ne vaut que pour « En solo », pas pour un autre groupe individuel', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const created = await post(f, staff(f, '/api/staff/table'), { id: 'Solo 2', individual: true });
  assert.equal(created.status, 200, created.text);
  const other = { table: 'Solo 2', access: f.access.get('Solo 2') };
  assert.ok(other.access, 'le groupe a son QR');
  const refused = await post(f, '/api/table/enter', { ...other, event: secret });
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.body.code, 'PRIVATE_EVENT');
  assert.equal(refused.body.error, 'Ce QR d’événement n’est plus actif. Demande au bar.');
  assert.equal(refused.headers['set-cookie'], undefined);
  assert.equal(f.sched.tableSingers('Solo 2').length, 0, 'personne de créé dans l’autre groupe');
  // « En solo » accepte toujours le même secret.
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret })).status, 200);
});

// Regression: quatrième relecture finale (ADV) — « Retirer la place
// « Solo N » ? » était décidé sur l'état affiché : si l'invitée donnait son
// prénom entre-temps, elle était marquée partie (PERSON_LEFT à son prochain
// scan) et le bar lisait « Chanteur marqué parti ».
test('« Parti » du bar sur une place « Solo N » qui vient de recevoir un prénom : refusé, rien ne change', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const guest = await eventEntry(f, tb, secret);
  // La page du bar montrait « Solo 1 » ; l'invitée donne son prénom avant la confirmation.
  await post(f, '/api/table/person/rename', { ...guest, name: 'Léa' }, { cookie: guest.cookie });
  const before = events(f).length;
  const version = f.sched.version;
  const refused = await post(f, staff(f, '/api/staff/person/leave'), { personId: guest.personId, expectPlaceholder: true });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.body.error, 'Cette place vient de recevoir un prénom : vérifie avant de la marquer partie.');
  assert.equal(f.sched.people.get(guest.personId).withdrawnAt, null, 'pas marquée partie');
  assert.equal(events(f).length, before, 'rien au journal');
  assert.equal(f.sched.version, version, 'rien ne change');
  const again = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: guest.cookie });
  assert.deepEqual([again.body.id, again.body.resumed], [guest.personId, true], 'son navigateur la retrouve');
  // Toujours une place sans prénom : retirée sans trace, comme avant.
  const ghost = await eventEntry(f, tb, secret);
  const removed = await post(f, staff(f, '/api/staff/person/leave'), { personId: ghost.personId, expectPlaceholder: true });
  assert.equal(removed.status, 200, removed.text);
  assert.match(removed.body.message, /^Place « Solo \d+ » sans prénom retirée/);
  assert.equal(f.sched.people.has(ghost.personId), false);
  // Sans ce drapeau (page du bar d'avant la mise à jour) : marquée partie, comme avant.
  const left = await post(f, staff(f, '/api/staff/person/leave'), { personId: guest.personId });
  assert.equal(left.status, 200, left.text);
  assert.ok(f.sched.people.get(guest.personId).withdrawnAt);
});

// Regression: quatrième relecture finale (ADV) — la reprise d'un profil
// retirait la place « Solo N » de ce navigateur sans son code de reprise
// (orphelin en mémoire et dans la sauvegarde) ; un code demandé pendant le
// retrait d'une place la recréait ; un QR individuel neuf refusé (sauvegarde
// impossible) rendait la place sans son code.
// Codes en mémoire, lus tels quels : transferSnapshot() n'écrit que les
// personnes encore dans la soirée et cacherait la ligne orpheline d'une place
// retirée (vérification de la seconde passe de la quatrième relecture finale).
const sharedIds = f => [...f.personShareCodes.keys()];
test('place « Solo N » retirée par une reprise : son code de reprise part avec elle, et revient avec elle', async () => {
  const f = harness({ persistent: true });
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const lea = await eventEntry(f, tb, secret, 'Léa');
  const rescan = await eventEntry(f, tb, secret);
  // Le bar avait donné un code de reprise à cette place.
  assert.equal((await post(f, staff(f, '/api/staff/person/share'), { personId: rescan.personId })).status, 200);
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  const claimed = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: rescan.cookie });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(f.sched.people.has(rescan.personId), false, 'place retirée');
  assert.ok(!sharedIds(f).includes(rescan.personId), 'pas de code orphelin en mémoire');
  assert.ok(!f.night.saves.at(-1).transfers.some(row => row.personId === rescan.personId), 'ni dans la sauvegarde');
  // Sauvegarde impossible pendant la reprise : la place revient avec son code.
  const other = await eventEntry(f, tb, secret);
  const code = await post(f, staff(f, '/api/staff/person/share'), { personId: other.personId });
  const max = await eventEntry(f, tb, secret, 'Max');
  const maxShare = await post(f, staff(f, '/api/staff/person/share'), { personId: max.personId });
  f.night.fail = 'disque plein';
  const failed = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(maxShare) }, { cookie: other.cookie });
  assert.equal(failed.status, 400, failed.text);
  f.night.fail = null;
  assert.ok(f.sched.people.has(other.personId), 'la place revient');
  assert.ok(sharedIds(f).includes(other.personId), 'avec son code');
  const byCode = await post(f, '/api/table/person/claim', { ...tb, personId: other.personId, code: code.body.code }, { remote: '10.0.9.1' });
  assert.equal(byCode.status, 200, byCode.text);
});

test('QR individuel neuf refusé (sauvegarde impossible) : la place « Solo N » revient avec son code de reprise', async () => {
  const f = harness({ persistent: true });
  const { tb, invite } = openSolo(f);
  const secret = f.privateEvent.enable();
  const ghost = await eventEntry(f, tb, secret);
  const code = await post(f, staff(f, '/api/staff/person/share'), { personId: ghost.personId });
  f.night.fail = 'disque plein';
  const failed = await post(f, '/api/table/solo/open', { ...tb, invitation: invite() }, { cookie: ghost.cookie });
  assert.equal(failed.status, 400, failed.text);
  f.night.fail = null;
  assert.ok(f.sched.people.has(ghost.personId), 'la place revient');
  assert.ok(sharedIds(f).includes(ghost.personId), 'avec son code');
  const byCode = await post(f, '/api/table/person/claim', { ...tb, personId: ghost.personId, code: code.body.code }, { remote: '10.0.9.2' });
  assert.equal(byCode.status, 200, byCode.text);
});

test('code de reprise demandé pendant que la place est retirée : aucun code recréé pour elle', async () => {
  const realQr = fromServer('qrcode');
  let started, release;
  const generating = new Promise(resolve => { started = resolve; });
  const qrcode = { ...realQr, toDataURL: () => new Promise(resolve => {
    release = () => resolve('data:image/png;base64,QQ');
    started();
  }) };
  const f = harness({ modules: { qrcode } });
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const ghost = await eventEntry(f, tb, secret);
  const sharing = post(f, staff(f, '/api/staff/person/share'), { personId: ghost.personId });
  await generating; // le QR de reprise est en cours de fabrication
  const removed = await post(f, staff(f, '/api/staff/person/leave'), { personId: ghost.personId });
  assert.equal(removed.status, 200, removed.text);
  release();
  const shared = await sharing;
  assert.equal(shared.status, 400, shared.text);
  assert.equal(shared.body.error, 'Chanteur inconnu ou parti.');
  assert.ok(!sharedIds(f).includes(ghost.personId), 'pas de code pour une place retirée');
});

// Regression: seconde passe de la quatrième relecture finale (tests) — la
// moitié « partie » du garde de createPersonShareCode (`p.withdrawnAt`)
// n'était vérifiée par aucun test : la place « Solo N » du test ci-dessus
// quitte la soirée. Une personne nommée marquée « Parti » pendant la
// fabrication du QR y reste ; sans ce garde, son code était enregistré après
// que le départ eut effacé l'ancien, et reprenait le profil après « Réactiver ».
test('QR de reprise demandé pendant que le bar marque partie une personne nommée : refusé, aucun code créé', async () => {
  const realQr = fromServer('qrcode');
  let started, release;
  const generating = new Promise(resolve => { started = resolve; });
  const qrcode = { ...realQr, toDataURL: () => new Promise(resolve => {
    release = () => resolve('data:image/png;base64,QQ');
    started();
  }) };
  const f = harness({ persistent: true, modules: { qrcode } });
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...sam, name: 'Sam' }, { cookie: sam.cookie });
  const sharing = post(f, staff(f, '/api/staff/person/share'), { personId: sam.personId });
  await generating; // le QR de reprise est en cours de fabrication
  const left = await post(f, staff(f, '/api/staff/person/leave'), { personId: sam.personId });
  assert.equal(left.status, 200, left.text);
  assert.ok(f.sched.people.get(sam.personId).withdrawnAt, 'marquée partie, toujours dans la soirée');
  release();
  const shared = await sharing;
  assert.equal(shared.status, 400, shared.text);
  assert.equal(shared.body.error, 'Chanteur inconnu ou parti.');
  assert.ok(!sharedIds(f).includes(sam.personId), 'pas de code pour une personne partie');
  assert.ok(!f.night.saves.at(-1).transfers.some(row => row.personId === sam.personId), 'ni dans la sauvegarde');
});

// Regression: vérification de la quatrième relecture finale (comme D2 « La
// clé meurt ») — un lien ou un code de reprise donné avant le départ (« Parti »
// du bar, « Je pars ») ne servait pas pendant le départ, mais reprenait le
// profil après « Réactiver » : le nouveau téléphone l'obtenait, l'actuel le perdait.
test('départ : le lien et le code de reprise en attente meurent, « Réactiver » ne les ranime pas', async () => {
  const f = harness({ persistent: true });
  const { tb, invite } = openSolo(f);
  const table = openTable(f, '3');
  // Soliste : QR de reprise donné par le bar, puis « Parti » du bar.
  const sam = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...sam, name: 'Sam' }, { cookie: sam.cookie });
  // Personne de table : « Transférer la gestion » sur son téléphone, puis « Je pars ».
  const joined = await post(f, '/api/table/person', { ...table, name: 'Ana' });
  const ana = { ...table, personId: joined.body.id, token: joined.body.token };
  for (const [me, at, share, leave] of [
    [sam, tb, () => post(f, staff(f, '/api/staff/person/share'), { personId: sam.personId }),
      () => post(f, staff(f, '/api/staff/person/leave'), { personId: sam.personId })],
    [ana, table, () => post(f, '/api/table/person/share', ana), () => post(f, '/api/leave', { token: ana.token })],
  ]) {
    const shared = await share();
    assert.equal(shared.status, 200, shared.text);
    assert.equal((await leave()).status, 200);
    assert.equal((await post(f, staff(f, '/api/staff/person/reactivate'), { personId: me.personId })).status, 200);
    // Revenue : ni l'offre « C'est bien toi ? », ni le lien, ni le code d'avant le départ.
    const offer = await get(f, `/api/state?table=${at.table}&access=${at.access}&reprise=${linkOf(shared)}`);
    assert.deepEqual(offer.body.transferOffer, { invalid: true }, me.personId);
    const byLink = await post(f, '/api/table/person/claim', { ...at, link: linkOf(shared) });
    assert.equal(byLink.body.error, 'Ce lien de transfert a expiré ou a déjà servi. Demande un nouveau lien ou un code au bar.');
    const byCode = await post(f, '/api/table/person/claim', { ...at, personId: me.personId, code: shared.body.code });
    assert.equal(byCode.body.error, 'Code de partage expiré. Demande un nouveau code au chanteur ou au bar.');
    if (at === tb) assert.deepEqual((await get(f, `/api/state?table=Comptoir&access=${tb.access}`)).body.recoveryPeople, []);
    assert.ok(!sharedIds(f).includes(me.personId), 'plus de transfert en attente');
    assert.ok(!f.night.saves.at(-1).transfers.some(row => row.personId === me.personId), 'ni dans la sauvegarde');
    // Son téléphone garde le profil ; un transfert demandé après le retour sert.
    assert.equal(f.sched.people.get(me.personId).token, me.token);
    assert.deepEqual((await stateOf(f, at, me)).body.managedIds, [me.personId]);
    const handed = await post(f, '/api/table/person/claim', { ...at, link: linkOf(await share()) });
    assert.equal(handed.status, 200, handed.text);
    assert.equal(handed.body.id, me.personId);
  }
});

// Regression: quatrième relecture finale (maintenabilité) — le ménage des
// places abandonnées avant une création restait fait quand la création
// échouait, mais son numéro de version était défait : les pages ne voyaient
// pas les places retirées.
test('événement privé : création refusée ou non sauvegardée, le ménage des places abandonnées reste fait et visible', async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const f = harness({ persistent: true, clock: true });
    const { tb } = openSolo(f);
    const secret = f.privateEvent.enable();
    const enter = remote => post(f, '/api/table/enter', { ...tb, event: secret }, { remote });
    // Sauvegarde impossible.
    const lost = await enter('10.9.1.1');
    clock += 10 * 60000 + 1000;
    let version = f.sched.version;
    f.night.fail = 'disque plein';
    const failed = await enter('10.9.1.2');
    f.night.fail = null;
    assert.equal(failed.status, 400, failed.text);
    assert.equal(f.sched.people.has(lost.body.id), false, 'la place abandonnée est partie');
    assert.ok(f.sched.version > version, 'les pages voient le ménage');
    // Trop de créations dans la minute pour cet appareil.
    const lostAgain = await enter('10.9.1.3');
    clock += 9.5 * 60000;
    for (let i = 0; i < 30; i++) assert.equal((await enter('10.9.1.4')).status, 200);
    clock += 31000; // place abandonnée depuis 10 minutes, rafale encore dans la minute
    version = f.sched.version;
    const busy = await enter('10.9.1.4');
    assert.equal(busy.status, 429, busy.text);
    assert.equal(f.sched.people.has(lostAgain.body.id), false, 'la place abandonnée est partie');
    assert.ok(f.sched.version > version, 'les pages voient le ménage');
  } finally {
    Date.now = realNow;
  }
});

// Regression: quatrième relecture finale (tests) — le ménage garde une place
// dont le code OU le lien de reprise vaut encore ; seul le code était
// vérifié (retirer linkExpiresAt du calcul passait tous les tests).
test('événement privé : code de reprise expiré mais lien encore valable, la place abandonnée est gardée et le lien la reprend', async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const f = harness({ clock: true });
    const { tb } = openSolo(f);
    const secret = f.privateEvent.enable();
    const shared = await eventEntry(f, tb, secret);
    const share = await post(f, staff(f, '/api/staff/person/share'), { personId: shared.personId });
    assert.equal(share.status, 200, share.text);
    // 11 minutes : place abandonnée (jamais relue), code expiré (10 min), lien valable (30 min).
    clock += 11 * 60000;
    await eventEntry(f, tb, secret);
    assert.ok(f.sched.people.has(shared.personId), 'lien de reprise valable : place gardée');
    const expired = await post(f, '/api/table/person/claim', { ...tb, personId: shared.personId, code: share.body.code }, { remote: '10.0.9.3' });
    assert.equal(expired.body.error, 'Code de partage expiré. Demande un nouveau code au chanteur ou au bar.');
    const claimed = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { remote: '10.0.9.4' });
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(claimed.body.id, shared.personId);
  } finally {
    Date.now = realNow;
  }
});
