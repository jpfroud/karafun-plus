'use strict';
/*
 * Journaux de soirée pour les essais du bornage des soirées (plan du
 * 8 novembre, A4 et A7, « Réparation ») : evening-split.test.js (planSplit,
 * sans disque) et evening-journal.test.js (réparation sur le disque) les
 * reprennent. Module d'aide des essais, sans essai à lui : test/run-offline.js
 * ne le lance pas, et le kit, qui exclut test/, ne le livre pas.
 *
 * - recopierFixture : la soirée du 15 octobre recopiée à +24 h, chaque copie
 *   avec ses propres identifiants de personnes et de tables, son propre boot,
 *   et les heures écrites dans ses champs décalées (turn.sent.sentAt,
 *   battle.proposed.closesAt, closing.set.closingAt) ;
 * - tirerJournaux : journaux tirés au hasard, à graine fixe, par un générateur
 *   congruentiel (comme test/sim-night.js), de une à quatre nuits à Paris,
 *   dont des nuits qui traversent le passage à l'heure d'hiver ou d'été, avec
 *   des lignes hors d'ordre (heure t plus ancienne que celle de la ligne
 *   d'avant), une dernière ligne coupée, un boot ou un seq en double. Dans
 *   `malformes` journaux, une ligne sur dix reçoit aussi un champ de
 *   l'appelant de mauvais type, de six sortes. Chaque ligne passe par
 *   cleanFields, puis reçoit v, seq, t, ev et boot comme dans
 *   EveningJournal.append : seuls les champs de l'appelant peuvent être de
 *   mauvais type.
 *
 * Les débuts de titre (stage.started, stage.restarted) sont toujours notés à
 * leur heure, comme en vrai : une ligne hors d'ordre n'en est jamais un, et
 * n'est jamais datée d'avant la première activité du journal. La première
 * coupure d'eveningBreaks est donc aussi le C qu'eveningOver rend en direct.
 */
const fs = require('node:fs');
const path = require('node:path');
const { cleanFields, newEveningId } = require('../evening-journal');

const PARIS = 'Europe/Paris';
const MIN = 60000;
const H = 60 * MIN;
const DAY = 24 * H;
const FIXTURE = path.join(__dirname, 'fixtures', 'soiree-2026-10-15-anonyme.json');

// Générateur congruentiel, comme test/sim-night.js:6.
function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ------------------------------------------------------------- fixture
// Champs qui nomment une personne ou une table (pseudonyms, evening-stats.js).
const PERSON_FIELDS = ['personId', 'ownerId', 'partnerId', 'guestId', 'requesterId', 'voterId', 'proposerId', 'toId', 'previousPartnerId'];
const PERSON_LISTS = ['personIds', 'ids'];
const TIME_FIELDS = new Map([['turn.sent', 'sentAt'], ['battle.proposed', 'closesAt'], ['closing.set', 'closingAt']]);

// La soirée du 15 octobre recopiée `fois` fois à +24 h, dans un seul journal :
// { events, meta }. La copie k (k ≥ 2) a, si `idsPropres`, ses propres
// identifiants (« S01-2 », « T1-2 »…) ; chaque copie a son boot (« nuit-k ») ;
// les seq se suivent. meta : celle d'une soirée en cours ouverte à la
// première ligne, prénom et nom de table égaux à la clé.
function recopierFixture({ fois = 2, idsPropres = true, eveningId = '2026-10-11_1254_ab12' } = {}) {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const events = [];
  const roster = [], tables = [];
  for (let k = 0; k < fois; k++) {
    const own = id => (k > 0 && idsPropres && typeof id === 'string' ? `${id}-${k + 1}` : id);
    for (const e of fixture.events) {
      const copy = { ...e, seq: events.length + 1, t: e.t + k * DAY, boot: `nuit-${k + 1}` };
      const field = TIME_FIELDS.get(e.ev);
      if (field && Number.isFinite(e[field])) copy[field] = e[field] + k * DAY;
      for (const key of PERSON_FIELDS) if (key in e) copy[key] = own(e[key]);
      for (const key of PERSON_LISTS) if (Array.isArray(e[key])) copy[key] = e[key].map(own);
      if ('tableId' in e) copy.tableId = own(e.tableId);
      events.push(copy);
    }
    for (const p of fixture.people) roster.push([own(p.key), { name: own(p.key), tableId: own(p.table) ?? null }]);
    for (const tb of fixture.tables) tables.push([own(tb.key), { name: own(tb.key), individual: !!tb.individual }]);
  }
  const meta = { format: 'karaoke-evening-meta', version: 1, eveningId, startedAt: events[0].t, endedAt: null,
    app: { version: 'v3.0.1', commit: null }, timezone: PARIS, roster: Object.fromEntries(roster), tables: Object.fromEntries(tables) };
  return { events, meta, fixture };
}

// ----------------------------------------------------- journaux tirés
const RULES = { tableRotation: false, weightedTables: false, interleaveArrivals: true, requirePresence: false,
  roundAppearanceCap: 2, spacingSongs: 3, auto: true, autoPlay: false, pushDelaySec: 45, presenceGraceSec: 30,
  presenceMaxSkips: 3, duoOnly: false };
// Débuts des journaux, un soir vers 19 h 30 à Paris : un vendredi de
// novembre, ou un soir proche d'un changement d'heure (25 octobre 2026 à 3 h,
// heure d'hiver ; 28 mars 2027 à 2 h, heure d'été).
const DEPARTS = [
  Date.parse('2026-11-06T19:30+01:00'),
  Date.parse('2026-10-23T19:30+02:00'),
  Date.parse('2026-10-24T19:30+02:00'),
  Date.parse('2027-03-26T19:30+01:00'),
  Date.parse('2027-03-27T19:30+01:00'),
];
const TITLE_STARTS = new Set(['stage.started', 'stage.restarted']);
const ACTIVITY = new Set(['stage.started', 'song.requested', 'person.joined', 'table.opened']);

const graineDe = (graine, numero) => (Math.imul(graine >>> 0, 2654435761) ^ Math.imul(numero + 1, 40503)) >>> 0;

// Un journal tiré : { numero, graine, malforme, texte, meta, timeZone }.
// `texte` est le journal tel qu'écrit (une ligne JSON par événement, la
// dernière parfois coupée) ; parseLines(texte).events en donne les lignes
// lisibles.
function tirerJournal(graine, numero, { malforme = false } = {}) {
  const R = rng(graineDe(graine, numero));
  const between = (a, b) => a + R() * (b - a);
  const chance = p => R() < p;
  const pick = list => list[Math.floor(R() * list.length)];

  const rows = [];      // { t, ev, fields }, dans l'ordre du journal
  const row = (t, ev, fields = {}) => rows.push({ t: Math.round(t), ev, fields });
  const roster = new Map();
  const tableMeta = new Map([['Comptoir', { name: 'En solo', individual: true }]]);
  const before = [];    // personnes des nuits précédentes
  const oldTables = [];  // tables des nuits précédentes
  let people = 0, tables = 0, entries = 0, queueIds = 0, ballots = 0;
  let pendingAnswer = null, pendingSong = null, lateEnd = null;
  const newPerson = (t, tableId, fields = {}) => {
    const id = `p${++people}`;
    roster.set(id, { name: `Prénom ${people}`, tableId });
    row(t, 'person.joined', { personId: id, tableId, ...fields });
    return id;
  };

  const nights = 1 + Math.floor(R() * 4);
  let anchor = pick(DEPARTS) + between(-60, 60) * MIN + R() * MIN;
  let start = anchor;
  for (let night = 0; night < nights; night++) {
    // Séance du petit matin (de 5 h 30 à 9 h environ) : un karaoké qui
    // continue après 8 h, ou qui reprend avant.
    const morning = night > 0 && chance(0.15);
    if (night > 0) {
      if (morning) start = anchor + between(9.5, 11) * H;
      else { anchor += (chance(0.8) ? 1 : 2) * DAY + between(-60, 60) * MIN; start = anchor; }
    }
    const end = start + (morning ? between(2.5, 3.5) : between(1.5, 4)) * H;
    let t = start;
    if (night === 0) {
      row(t, 'evening.started', { rules: { ...RULES } });
      // Lignes gardées avant l'ouverture (_flushEarly), datées d'avant elle.
      if (chance(0.3)) row(t - between(1, 30) * 1000, 'table.opened', { tableId: 'Comptoir', individual: true });
      else row(t + 2, 'table.opened', { tableId: 'Comptoir', individual: true });
      row(t + 1, 'app.started', { restored: false, offlineMs: 0, version: 'v3.5.0' });
      row(t + 3, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' });
    } else if (chance(0.3)) {
      // Application redémarrée entre deux nuits.
      const off = between(5, 120) * MIN;
      row(t - off, 'app.stopped', { reason: 'stop' });
      row(t, 'app.started', { restored: true, offlineMs: Math.round(off), version: 'v3.5.0' });
    }
    t += between(1, 10) * MIN;
    row(t, 'karaoke.phase', { phase: 'between', blocker: 'permission' });
    row(t + 500, 'karaoke.phase', { phase: 'silent', blocker: 'empty' });
    // Tables et personnes de la nuit.
    const present = [];
    const nightTables = [];
    for (let i = 1 + Math.floor(R() * 3); i > 0; i--) {
      t += between(1, 12) * MIN;
      const id = `T${++tables}`;
      tableMeta.set(id, { name: `Table ${tables}`, individual: false });
      row(t, 'table.opened', { tableId: id, individual: false });
      row(t + 15, 'table.headcount', { tableId: id, n: 2 + Math.floor(R() * 5), by: 'staff' });
      if (chance(0.15)) row(t + 30, 'table.bonus', { tableId: id, level: pick([-1, 1, 2]) });
      nightTables.push(id);
    }
    for (let i = 2 + Math.floor(R() * 5); i > 0; i--) {
      t += between(0.5, 8) * MIN;
      // Une inscription sur une table de la veille, dont le QR sert encore.
      const tableId = oldTables.length && chance(0.12) ? pick(oldTables) : chance(0.15) ? 'Comptoir' : pick(nightTables);
      const id = newPerson(t, tableId);
      present.push(id);
      if (chance(0.1)) row(t + 50, 'person.bonus', { personId: id, level: pick([-2, -1, 1, 2]) });
    }
    // Personnes de la veille : citées (elles demandent un titre), ou
    // seulement nommées par des lignes qui ne citent pas.
    for (const id of before) {
      if (chance(0.25)) present.push(id);
      else if (chance(0.3)) {
        t += between(0.2, 3) * MIN;
        const kind = Math.floor(R() * 8);
        if (kind === 0) row(t, 'person.seen', { personId: id });
        else if (kind === 1) row(t, 'notice.sent', { personId: id, kind: 'turnSoon' });
        else if (kind === 2) row(t, 'presence.asked', { personIds: [id], entryId: null, source: 'auto' });
        else if (kind === 3) row(t, 'presence.skipped', { personId: id, entryId: `e${entries + 1}`, skips: 1, removed: false });
        else if (kind === 4) row(t, 'person.bonus', { personId: id, level: 1 });
        else if (kind === 5) row(t, 'defer.requested', { ownerId: id, personIds: [id], entryId: null, songs: 1 });
        else if (kind === 6) row(t, 'person.left', { personId: id, by: 'staff', songsDropped: 0 });
        else row(t, 'table.left', { tableId: roster.get(id).tableId, personIds: [id], songsDropped: 0 });
      }
    }
    // Fin de titre de la nuit d'avant, notée au retour de KaraFun.
    if (lateEnd) { t += between(0.2, 2) * MIN; row(t, 'stage.ended', { queueId: lateEnd, playedSec: 1500 }); lateEnd = null; }
    // Réponse à une invitation de duo faite avant la coupure.
    if (pendingAnswer) {
      t += between(0.2, 2) * MIN;
      row(t, 'duo.answered', { personId: pendingAnswer.partnerId, entryId: pendingAnswer.entryId, ownerId: pendingAnswer.ownerId,
        partnerId: pendingAnswer.partnerId, accepted: chance(0.7) });
      pendingAnswer = null;
    }
    if (chance(0.2)) row(t + 1000, 'settings.changed', { setting: pick(['autoPlay', 'gap', 'cap', 'pushDelaySec']), from: 1, to: 2 });

    // Titres.
    t = Math.max(t, start + between(15, 30) * MIN);
    let last = null;
    while (t < end) {
      const singer = pick(present);
      const partner = present.length > 1 && chance(0.12) ? pick(present.filter(id => id !== singer)) : null;
      // Titre demandé la nuit d'avant, chanté maintenant : sans demande dans ce morceau.
      const carriedSong = pendingSong && chance(0.5) ? pendingSong : null;
      const entryId = carriedSong ? carriedSong.entryId : `e${++entries}`;
      const owner = carriedSong ? carriedSong.personId : singer;
      if (!carriedSong) {
        row(t - between(1, 6) * MIN, 'song.requested', { personId: owner, entryId, songId: 1000 + entries, title: `Titre ${entries}`,
          artist: 'Artiste', ...(chance(0.8) ? { durationSec: 150 + Math.floor(R() * 150) } : {}), mode: 'append' });
        if (chance(0.5)) row(t - between(0.5, 1) * MIN, 'queue.entered', { personId: owner, position: 1, queueLength: 2 });
      } else pendingSong = null;
      if (partner && !carriedSong) {
        row(t - between(0.3, 0.5) * MIN, 'duo.invited', { personId: owner, entryId, ownerId: owner, partnerId: partner, sameGroup: false });
        row(t - between(0.1, 0.25) * MIN, 'duo.answered', { personId: partner, entryId, ownerId: owner, partnerId: partner, accepted: true });
      }
      const ids = partner && !carriedSong ? [owner, partner] : [owner];
      row(t - 20000, 'turn.sent', { entryId, ids, ownerId: owner, kind: ids.length > 1 ? 'duo' : 'solo', sentAt: t - 20000 });
      const queueId = ++queueIds;
      row(t, 'stage.started', { queueId, songId: 1000 + entries, title: `Titre ${entries}`, artist: 'Artiste', durationSec: 200,
        source: 'queue', entryId, ids, ownerId: owner, kind: ids.length > 1 ? 'duo' : 'solo' });
      if (chance(0.05)) row(t + MIN, 'stage.restarted', { queueId });
      const length = between(2.5, 5) * MIN;
      if (chance(0.85)) row(t + length, 'stage.ended', { queueId, playedSec: Math.round(length / 1000) });
      last = { queueId, t };
      // Le reste de la vie de la soirée, entre deux titres.
      if (chance(0.5)) row(t + between(0.5, 2) * MIN, 'person.seen', { personId: pick(present) });
      if (chance(0.3)) row(t + between(0.5, 2) * MIN, 'queue.sample', { ready: 1, songsListed: 2, demanding: 2, deferred: 0, present: present.length, inKaraFun: 1 });
      if (chance(0.1)) row(t + between(0.5, 2) * MIN, 'notice.sent', { personId: pick(present), kind: 'turnSoon' });
      if (chance(0.06)) {
        const asked = pick(present);
        row(t + between(0.5, 1) * MIN, 'presence.asked', { personIds: [asked], entryId: null, source: 'auto' });
        row(t + between(1.5, 2) * MIN, 'presence.confirmed', { personId: asked, entryId: null });
      }
      if (chance(0.04)) {
        const who = pick(present);
        row(t + between(0.5, 1) * MIN, 'defer.requested', { ownerId: who, personIds: [who], entryId: null, songs: 1 });
        // « Je suis prêt » : avec le personId de celle qui l'a touché, comme
        // cancelDeferral (lib/scheduler/presence.js) l'écrit.
        row(t + between(1.5, 2) * MIN, 'defer.ended', { personId: who, ownerId: who, entryId: null, how: 'ready' });
      }
      if (chance(0.03)) row(t + MIN, 'person.bonus', { personId: pick(present), level: pick([-1, 1]) });
      if (chance(0.03)) {
        const ballotId = `b${++ballots}`;
        row(t + MIN, 'battle.proposed', { ballotId, proposerId: pick(present), songs: [{ songId: 1, title: 'Duel' }], eligible: 3, threshold: 2, closesAt: t + 3 * MIN });
        row(t + 1.5 * MIN, 'battle.vote', { ballotId, voterId: pick(present), choice: 'yes' });
      }
      if (chance(0.03)) row(t + MIN, 'staff.next', {});
      if (chance(0.03)) row(t + MIN, 'song.removed', { personId: pick(present), entryId: `e${entries}`, by: 'staff' });
      if (chance(0.02) && present.length > 2) row(t + 1.2 * MIN, 'person.left', { personId: present.splice(Math.floor(R() * present.length), 1)[0], by: 'self', songsDropped: 0 });
      if (chance(0.02)) {
        const off = between(1, 40) * MIN;
        row(t + 1.5 * MIN, 'app.stopped', { reason: 'stop' });
        row(t + 1.5 * MIN + off, 'app.started', { restored: true, offlineMs: Math.round(off), version: 'v3.5.0' });
      }
      t += morning ? between(5, 45) * MIN : between(8, 20) * MIN;
    }
    // Ce que la nuit laisse à la suivante : titre demandé sans être chanté,
    // invitation sans réponse, titre resté sur scène (KaraFun coupé).
    if (chance(0.3)) {
      const owner = pick(present);
      pendingSong = { personId: owner, entryId: `e${++entries}` };
      row(t, 'song.requested', { personId: owner, entryId: pendingSong.entryId, title: `Titre ${entries}`, mode: 'append' });
    }
    if (present.length > 1 && chance(0.25)) {
      const ownerId = pick(present);
      pendingAnswer = { ownerId, partnerId: pick(present.filter(id => id !== ownerId)), entryId: `e${++entries}` };
      row(t + 1000, 'song.requested', { personId: ownerId, entryId: pendingAnswer.entryId, title: `Titre ${entries}`, mode: 'append' });
      row(t + 2000, 'duo.invited', { personId: ownerId, entryId: pendingAnswer.entryId, ownerId, partnerId: pendingAnswer.partnerId, sameGroup: false });
    }
    if (last && chance(0.25)) lateEnd = last.queueId;
    row(t + between(1, 10) * MIN, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' });
    // Téléphone rouvert le lendemain matin : il ne retient pas la soirée.
    if (chance(0.3)) row(t + between(6, 9) * H, 'person.seen', { personId: pick(present) });
    for (const id of present) if (!before.includes(id)) before.push(id);
    for (const id of nightTables) oldTables.push(id);
  }
  const closed = chance(0.3);
  if (closed) row(rows.reduce((m, r) => Math.max(m, r.t), 0) + 5 * MIN, 'evening.closed', { by: 'staff-reset' });

  // Ordre du journal : celui des heures, puis quelques lignes hors d'ordre.
  const first = rows[0];
  rows.sort((a, b) => (a === first ? -1 : b === first ? 1 : a.t - b.t));
  const firstActivity = rows.reduce((m, r) => (ACTIVITY.has(r.ev) && !r.fields.individual ? Math.min(m, r.t) : m), Infinity);
  // Lignes écrites en retard : datées d'une nuit, rangées dans la suivante
  // (jamais après la clôture).
  const fixed = new Set(['evening.started', 'evening.closed']);
  for (let i = rows.length - 2; i > 1; i--) {
    const r = rows[i];
    if (TITLE_STARTS.has(r.ev) || ACTIVITY.has(r.ev) || fixed.has(r.ev) || !chance(0.02)) continue;
    const later = rows.findIndex(other => other.t > r.t + 6 * H && other.ev !== 'evening.closed');
    if (later > i) rows.splice(later, 0, ...rows.splice(i, 1));
  }
  // Heures reculées de quelques minutes, sans jamais passer avant la
  // première activité ; jamais un début de titre, ni l'ouverture ou la
  // clôture de la soirée.
  for (const r of rows.slice(1)) {
    if (TITLE_STARTS.has(r.ev) || fixed.has(r.ev) || r.t <= firstActivity || !chance(0.04)) continue;
    r.t = Math.round(Math.max(firstActivity + 1, r.t - between(0.5, 8) * MIN));
  }

  // Écriture comme EveningJournal.append : champs nettoyés, puis v, seq, t, ev
  // et boot ; un nouveau boot à chaque redémarrage.
  let boot = `${numero.toString(16).padStart(4, '0')}0001`, boots = 1, seq = 0;
  const lines = rows.map(r => {
    if (r.ev === 'app.started' && r.fields.restored === true) boot = `${numero.toString(16).padStart(4, '0')}${String(++boots).padStart(4, '0')}`;
    const fields = { ...r.fields };
    if (malforme && chance(0.1)) abimer(fields, R);
    return { ...cleanFields(fields), v: 1, seq: ++seq, t: r.t, ev: r.ev, boot };
  });
  // Ligne dupliquée après un arrêt brutal (même boot, même seq), ou seq repris.
  if (chance(0.15)) { const i = Math.floor(R() * lines.length); lines.splice(i + 1, 0, { ...lines[i] }); }
  if (chance(0.1)) { const i = 1 + Math.floor(R() * (lines.length - 1)); lines[i] = { ...lines[i], seq: lines[i - 1].seq }; }
  let texte = lines.map(line => JSON.stringify(line)).join('\n') + '\n';
  // Dernière ligne coupée par un arrêt brutal.
  if (chance(0.2)) {
    const lastLine = JSON.stringify(lines.at(-1));
    texte = texte.slice(0, texte.length - 1 - lastLine.length) + lastLine.slice(0, Math.floor(lastLine.length / 2));
  }
  const startedAt = rows[0].t;
  const meta = { format: 'karaoke-evening-meta', version: 1,
    eveningId: newEveningId(startedAt, (numero % 65536).toString(16).padStart(4, '0'), PARIS),
    startedAt, endedAt: closed ? rows.findLast(r => r.ev === 'evening.closed').t : null,
    app: { version: 'v3.5.0', commit: null }, timezone: PARIS,
    roster: Object.fromEntries(roster), tables: Object.fromEntries(tableMeta) };
  return { numero, graine, malforme, texte, meta, timeZone: PARIS };
}

// Champ de l'appelant de mauvais type, de six sortes (A7, essai par propriétés).
function abimer(fields, R) {
  const pick = list => list[Math.floor(R() * list.length)];
  switch (Math.floor(R() * 6)) {
    case 0: // liste qui n'en est pas une
      fields[pick(['ids', 'personIds', 'replacedEntryIds'])] = pick(['p1', 7, null, { personId: 'p1' }]);
      break;
    case 1: // liste dont des éléments ne sont pas des chaînes non vides
      fields[pick(['ids', 'personIds', 'replacedEntryIds'])] = ['p1', '', null, 5, { id: 'p2' }, ['p3'], 'p2'];
      break;
    case 2: // booléen qui n'en est pas un
      fields[pick(['individual', 'carried', 'restored'])] = pick(['false', 0, 1, null]);
      break;
    case 3: { // identifiant d'un autre type, vide ou absent
      const key = pick(['personId', 'requesterId', 'voterId', 'proposerId', 'ownerId', 'partnerId', 'tableId']);
      if (R() < 0.2) delete fields[key];
      else fields[key] = pick([42, '', null, { id: 'p1' }, ['p1']]);
      break;
    }
    case 4: // nombre en texte
      fields[pick(['level', 'headcount', 'durationSec', 'n'])] = pick(['2', '3', '240']);
      break;
    default: // trop long (coupé à 60 par cleanFields) ou trop profond (rendu null)
      if (R() < 0.5) fields[pick(['ids', 'personIds'])] = Array.from({ length: 61 + Math.floor(R() * 20) }, (_, i) => `p${i + 1}`);
      else fields[pick(['rules', 'settings', 'songs'])] = { a: { b: { c: { d: { e: 1 } } } } };
  }
}

// `nombre` journaux tirés de la graine ; les `malformes` premiers ont des
// champs de mauvais type.
function tirerJournaux({ graine = 20261108, nombre = 200, malformes = 50 } = {}) {
  return Array.from({ length: nombre }, (_, numero) => tirerJournal(graine, numero, { malforme: numero < malformes }));
}

module.exports = { PARIS, MIN, H, DAY, FIXTURE, rng, recopierFixture, tirerJournal, tirerJournaux };
