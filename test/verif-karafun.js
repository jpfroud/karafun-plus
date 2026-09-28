'use strict';
/*
 * Vérification automatique contre le VRAI KaraFun, via le serveur déjà lancé.
 *
 *   1) Lancer le serveur :   node\node.exe server.js --code 123456 --no-open
 *   2) Dans un autre terminal : node\node.exe test\verif-karafun.js
 *      (options : --base http://localhost:3000   --skip-play   --keep)
 *
 * ATTENTION : des chansons vont être ajoutées et lancées dans KaraFun (baisse le volume).
 * Le script les passe vite (commande « next ») et nettoie à la fin (sauf --keep).
 * Résultat : affichage PASS/FAIL par étape + journal/verif-<date>.json (formes exactes des messages KaraFun).
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };
const B = opt('base', process.env.BASE || 'http://localhost:3000');
const { staffRoute } = require('./staff-auth');
const SKIP_PLAY = !!opt('skip-play', false);
const KEEP = !!opt('keep', false);

const results = [];
const report = { startedAt: new Date().toISOString(), base: B, skipPlay: SKIP_PLAY, keep: KEEP, steps: results, samples: {} };
let initialQueueIds = null;
let initialSettings = null;
const introducedQueueIds = new Set();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
function step(name, ok, detail, warnOnly) {
  const level = ok ? 'PASS' : warnOnly ? 'WARN' : 'FAIL';
  results.push({ name, ok: ok || !!warnOnly, level, detail: detail === undefined ? null : detail });
  log(`${level}  ${name}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  return ok;
}
async function get(p) { const r = await fetch(B + await staffRoute(B, p), { cache: 'no-store', signal: AbortSignal.timeout(10000) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; }
async function post(p, body) {
  if (SKIP_PLAY && p === '/api/staff/kf' && body && body.action === 'play') throw new Error('--skip-play interdit la commande play');
  const r = await fetch(B + await staffRoute(B, p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.code = j.code; throw e; }
  return j;
}
async function staff() {
  const s = await get('/api/staff/state');
  if (initialQueueIds) {
    for (const item of kfQueue(s)) if (!initialQueueIds.has(item.queueId)) introducedQueueIds.add(item.queueId);
    const currentId = currentQueueId(s);
    if (currentId != null && !initialQueueIds.has(currentId)) introducedQueueIds.add(currentId);
  }
  return s;
}
async function waitFor(fn, ms, every = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); }
  return null;
}
const kfQueue = (s) => (s.kf && s.kf.queue) || [];
function currentQueueId(s) {
  const st = (s.kf && s.kf.status) || {};
  if (!/^(play|playing|pause|paused)$/i.test(String(st.state || ''))) return null;
  const cur = st.songPlaying || st.current;
  if (cur && cur.queueId != null) return cur.queueId;
  if (cur) return null; // une identité explicite inconnue ne permet pas de passer la tête de file
  return kfQueue(s).length ? kfQueue(s)[0].queueId : null;
}

(async () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const tables = [`verifA${tag}`, `verifB${tag}`, `verifC${tag}`];
  const tableUrls = new Map();
  const tableQrUrls = new Map();
  const tableAccess = new Map();
  let S;

  try {
  // ---------------------------------------------------------------- 1. connexion
  try { S = await staff(); } catch (e) { step('Serveur joignable', false, `${B} : ${e.message} (le serveur est-il lancé ?)`); return; }
  step('Serveur joignable', true, B);
  S = await waitFor(async () => { const s = await staff(); return s.kf && s.kf.ready ? s : null; }, 25000);
  if (!step('KaraFun connecté et données reçues', !!S, S ? `serveur ${S.kf.base}, code ${S.kf.code}` : 'voir « Diagnostic KaraFun » et journal/karafun-*.jsonl')) return;
  initialQueueIds = new Set(kfQueue(S).map(it => it.queueId));
  const initialCurrentId = currentQueueId(S);
  if (initialCurrentId != null) initialQueueIds.add(initialCurrentId);
  initialSettings = { auto: S.settings.auto, autoPlay: S.settings.autoPlay };
  report.initialQueueIds = [...initialQueueIds];
  report.samples.protocol = S.kf.protocol || null;
  report.samples.raw = S.kf.raw || null;
  report.samples.permissions = S.kf.permissions;
  report.samples.preferences = S.kf.preferences;
  report.samples.status = S.kf.status;
  report.samples.queue = S.kf.queue;
  if (SKIP_PLAY && initialSettings.autoPlay) await post('/api/staff/settings', { autoPlay: false });
  step('Préférence « nom du chanteur »', true, S.kf.preferences ? `askSingerName=${S.kf.preferences.askSingerName}` : 'non reçue');
  if (kfQueue(S).length) log(`INFO  La file KaraFun contient déjà ${kfQueue(S).length} élément(s) : le programme attendra qu'ils passent avant d'envoyer les siens. Vide-la pour un test plus rapide.`);

  // ---------------------------------------------------------------- 2. recherche
  let songs = [];
  try {
    for (const q of ['queen', 'abba', 'goldman', 'dion', 'stromae']) songs = songs.concat(await get(`/api/search?q=${q}`));
  } catch (e) { step('Recherche KaraFun', false, e.message); return; }
  const seen = new Set(); songs = songs.filter(s => s.songId && !seen.has(s.songId) && seen.add(s.songId));
  report.samples.search = songs.slice(0, 3);
  if (!step('Recherche KaraFun', songs.length >= 5, `${songs[0] ? songs.length + ' titres (ex. ' + songs[0].songId + ' ' + songs[0].title + ')' : 'aucun titre'}`)) return;
  try {
    const categories = await get('/api/catalog/categories?type=playlist');
    step('Catalogue : catégories', Array.isArray(categories) && categories.length > 0,
      Array.isArray(categories) ? `${categories.length} catégorie(s)` : 'réponse inattendue', true);
  } catch (e) { step('Catalogue : catégories', false, e.message, true); }

  // ---------------------------------------------------------------- 3. ajout direct + retrait
  S = await staff();
  const before = new Set(kfQueue(S).map(it => it.queueId));
  const probe = songs[0];
  await post('/api/staff/kf', { action: 'test-add', songId: probe.songId });
  const added = await waitFor(async () => { const s = await staff(); return kfQueue(s).find(it => !before.has(it.queueId) && Number(it.songId) === probe.songId) || null; }, 12000);
  report.samples.addedItem = added;
  if (!step('Ajout d\'une chanson dans la file KaraFun (queueAdd)', !!added, added ? `queueId=${added.queueId}, champs=${Object.keys(added).join(',')}` : 'la chanson n\'apparaît pas : droits de la télécommande ? voir journal')) return;
  const probeStarted = currentQueueId(await staff()) === added.queueId;
  let removable = added;
  if (probeStarted) {
    // Une chanson en cours n'est pas retirable : en ajouter une seconde pour tester réellement queueRemove.
    const secondBefore = new Set(kfQueue(await staff()).map(it => it.queueId));
    await post('/api/staff/kf', { action: 'test-add', songId: songs[1].songId });
    removable = await waitFor(async () => {
      const s = await staff();
      return kfQueue(s).find(it => !secondBefore.has(it.queueId) && Number(it.songId) === songs[1].songId) || null;
    }, 12000);
    report.samples.removableItem = removable;
  }
  if (!removable) {
    step('Retrait d\'une chanson (queueRemove)', false, 'la deuxième chanson test à retirer n\'a pas été ajoutée');
  } else {
    await post('/api/staff/kf', { action: 'remove', queueId: removable.queueId });
    const gone = await waitFor(async () => { const s = await staff(); return kfQueue(s).some(it => it.queueId === removable.queueId) ? null : true; }, 10000);
    step('Retrait d\'une chanson (queueRemove)', !!gone, gone ? `queueId=${removable.queueId}` : 'toujours présente après 10 s');
  }
  if (probeStarted && currentQueueId(await staff()) === added.queueId) {
    log('INFO  KaraFun a lancé la première chanson test tout de suite : on la passe (next).');
    await post('/api/staff/kf', { action: 'next' });
    await sleep(2000);
  }

  // ---------------------------------------------------------------- 4. tables et clients simulés
  const people = [];
  try {
    for (const [id, headcount] of [[tables[0], 2], [tables[1], 1], [tables[2], 3]]) {
      await post('/api/staff/table', { id, headcount });
    }
    const configured = await staff();
    for (const [id, headcount] of [[tables[0], 2], [tables[1], 1], [tables[2], 3]]) {
      const table = configured.tables.find(t => t.id === id);
      if (!table || table.headcount !== headcount || !table.url || !table.qrUrl) throw new Error(`table ${id} : effectif ou lien QR manquant`);
      const parts = new URL(table.url).pathname.split('/').filter(Boolean);
      if (parts.length !== 3 || parts[0] !== 't' || decodeURIComponent(parts[1]) !== id || !/^[A-Za-z0-9_-]{22}$/.test(parts[2])) {
        throw new Error(`table ${id} : lien QR invalide`);
      }
      tableUrls.set(id, table.url);
      tableQrUrls.set(id, table.qrUrl);
      tableAccess.set(id, parts[2]);
    }
    step('Tables créées par le bar (effectifs et liens QR secrets)', true, tables.join(', '));
  } catch (e) { step('Tables créées par le bar', false, e.message); return; }
  try {
    await post('/api/join', { table: tables[0], name: 'Sans QR' });
    step('Inscription refusée sans secret de table', false, 'acceptée à tort');
    return;
  } catch (e) {
    if (!step('Inscription refusée sans secret de table', e.code === 'TABLE_ACCESS', e.message)) return;
  }
  const join = async (table, name) => { const r = await post('/api/join', { table, access: tableAccess.get(table), name }); people.push({ name, table, token: r.token }); return r.token; };
  try {
    await join(tables[0], 'Alice'); await join(tables[0], 'Bob');
    await join(tables[1], 'Chloé');
    await join(tables[2], 'Dan'); await join(tables[2], 'Eva');
    step('Inscriptions (5 personnes, 3 tables)', true);
  } catch (e) { step('Inscriptions', false, e.message); return; }
  try { await join(tables[1], 'Intrus'); step('Plafond de table (2e inscription refusée pour une table de 1)', false, 'accepté à tort'); }
  catch (e) { step('Plafond de table (2e inscription refusée pour une table de 1)', /déjà/.test(e.message), e.message); }
  let k = 1;
  for (const p of people) { await post('/api/song', { token: p.token, song: songs[k++ % songs.length] }); }
  step('Choix des chansons', true, people.map(p => p.name).join(', '));

  // ---------------------------------------------------------------- 5. envoi automatique + lecture
  const pushed = await waitFor(async () => { const s = await staff(); return s.tracked.length ? s : null; }, 20000);
  if (!step('Envoi automatique de la 1re chanson à KaraFun', !!pushed, pushed ? pushed.tracked.map(t => `${t.label} — ${t.title}`).join(' | ') : 'rien envoyé en 20 s (file KaraFun non vide ? envoi auto coupé ? voir journal)')) return;
  let playing = await waitFor(async () => { const s = await staff(); return s.stage && s.stage.ours ? s : null; }, 8000);
  if (!playing && !SKIP_PLAY) {
    log('INFO  KaraFun ne lance pas tout seul la chanson ajoutée : envoi de « play ».');
    await post('/api/staff/kf', { action: 'play' });
    playing = await waitFor(async () => { const s = await staff(); return s.stage && s.stage.ours ? s : null; }, 12000);
  }
  report.samples.statusWhilePlaying = playing ? playing.kf.status : (await staff()).kf.status;
  report.samples.queueWhilePlaying = playing ? playing.kf.queue : null;
  report.samples.rawWhilePlaying = playing ? playing.kf.raw || null : null;
  step('Chanson de la file reconnue comme « sur scène »', !!playing, playing ? `${playing.stage.singer} — ${playing.stage.title}` : 'la détection de la chanson en cours ne marche pas : voir analyze() dans server.js et samples.status');

  // ---------------------------------------------------------------- 6. enchaînement (on passe les chansons avec « next »)
  const order = [];
  let lastLabel = playing ? playing.stage.singer : null;
  if (lastLabel) order.push(lastLabel);
  for (let round = 0; round < 5; round++) {
    // la suivante doit être envoyée (après ~45 s de lecture, ou tout de suite si rien ne joue)
    await post('/api/staff/kf', { action: 'next' });
    const nx = await waitFor(async () => {
      const s = await staff();
      if (s.stage && s.stage.ours && s.stage.singer !== lastLabel) return s;
      if (!s.stage && s.tracked.length && !SKIP_PLAY) { try { await post('/api/staff/kf', { action: 'play' }); } catch (e) { /* */ } }
      return null;
    }, 25000, 1000);
    if (!nx) { step(`Enchaînement ${round + 1}`, false, 'pas de nouvelle chanson de la file en 25 s'); break; }
    lastLabel = nx.stage.singer; order.push(lastLabel);
    // tout le monde rechoisit une chanson après être passé
    for (const p of people) {
      const me = (await get(`/api/state?token=${p.token}`)).me;
      if (me && !me.song && !(me.duet && me.duet.asPartner)) await post('/api/song', { token: p.token, song: songs[k++ % songs.length] });
    }
  }
  const tableOf = (label) => String(label).split('·').pop().trim();
  const consecutive = order.some((l, i) => i > 0 && tableOf(l) === tableOf(order[i - 1]));
  report.samples.order = order;
  step('Enchaînement de plusieurs chansons de la file', order.length >= 4, order.join(' | '));
  // En test accéléré (on passe les chansons au bout de quelques secondes), tout le monde « vient de chanter » :
  // la règle anti-rafale laisse alors la même table rechanter plutôt que faire rechanter quelqu'un qui sort de scène.
  step('Pas deux fois de suite la même table', !consecutive, consecutive ? `${order.join(' | ')} (attendu en test accéléré, voir A-LIRE-AGENT.md §7)` : order.join(' | '), true);

  // ---------------------------------------------------------------- 7. absent : on retire la suivante avant son passage
  const withNext = await waitFor(async () => {
    const s = await staff();
    return s.tracked.some(t => !t.startedAt && s.queue.some(x => x.queueId === t.queueId && x.source === 'karafun')) ? s : null;
  }, 70000, 1000);
  if (withNext) {
    const tr = withNext.tracked.find(t => !t.startedAt && withNext.queue.some(x => x.queueId === t.queueId && x.source === 'karafun'));
    const removedSong = kfQueue(withNext).find(it => it.queueId === tr.queueId);
    const queuedSong = withNext.queue.find(it => it.queueId === tr.queueId);
    const singerIds = (queuedSong && queuedSong.ids) || [];
    // Observer la restauration avant que sync() ne choisisse et renvoie une nouvelle chanson.
    await post('/api/staff/settings', { auto: false });
    try {
      await post('/api/staff/kf', { action: 'absent', queueId: tr.queueId });
      const back = await waitFor(async () => {
        const s = await staff();
        if (kfQueue(s).some(it => it.queueId === tr.queueId)) return null;
        return s.queue.find(x => x.source === 'helper' && x.ids?.some(id => singerIds.includes(id)) &&
          tables.includes(x.tableId) && x.song) || null;
      }, 12000);
      report.samples.absentRestore = back;
      // qi est l'indice interne de Scheduler.Q ; pos inclut les titres déjà dans KaraFun.
      const correct = singerIds.length > 0 && !!back && Number.isInteger(back.qi) && back.qi >= 0 && back.qi < 4 &&
        !!removedSong && Number(back.song.songId) === Number(removedSong.songId);
      step('Absent : chanson conservée et retour au plus à la 4e place', correct,
        back ? `${back.name} : place interne ${back.qi + 1}, passage prévu ${back.pos}, chanson ${back.song.songId}` : 'non vérifié');
    } finally {
      await post('/api/staff/settings', { auto: withNext.settings.auto });
    }
  } else step('Absent : chanson retirée de KaraFun, la personne garde sa place', false, 'aucune chanson « suivante » en attente dans les 70 s (normal si l\'envoi se fait à 45 s : relancer avec la chanson en cours plus longue)');

  // ---------------------------------------------------------------- 8. pages
  try {
    const r1 = await fetch(tableUrls.get(tables[0]), { signal: AbortSignal.timeout(10000) });
    const r2 = await fetch(B + await staffRoute(B, '/staff'), { signal: AbortSignal.timeout(10000) });
    const r3 = await fetch(B + await staffRoute(B, tableQrUrls.get(tables[0])), { signal: AbortSignal.timeout(10000) });
    const bare = await fetch(`${B}/t/1`, { signal: AbortSignal.timeout(10000) });
    step('Pages client par lien secret, bar et QR servi au bar', r1.ok && r2.ok && r3.ok &&
      /image\/svg\+xml/.test(r3.headers.get('content-type') || ''),
      `client ${r1.status}, bar ${r2.status}, qr ${r3.status}`);
    step('Accès client sans secret refusé', bare.status === 403, `/t/1 : HTTP ${bare.status}`);
    const s = await staff();
    step('Adresse pour les téléphones détectée', /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(s.phoneBase), s.phoneBase);
  } catch (e) { step('Pages', false, e.message); }

  } catch (e) {
    report.unexpectedError = { message: e.message, stack: e.stack };
    step('Erreur inattendue pendant la vérification', false, e.message);
  } finally {
    await finish();
  }

  async function finish() {
    const cleanupErrors = [];
    report.cleanup = { skipped: KEEP || !initialQueueIds, introducedQueueIds: [], remainingQueueIds: [] };
    if (!KEEP && initialQueueIds) {
      try {
        // Stopper les nouveaux envois avant de retirer les inscriptions ; un ajout déjà parti
        // peut encore apparaître pendant le nettoyage et sera repéré par son queueId.
        await post('/api/staff/settings', { auto: false, autoPlay: false });
        for (const t of tables) {
          try { await post('/api/staff/table-left', { id: t }); }
          catch (e) { cleanupErrors.push(`table ${t} : ${e.message}`); }
        }
        const skippedIds = new Set();
        const cleaned = await waitFor(async () => {
          const s = await staff();
          const currentId = currentQueueId(s);
          const remaining = kfQueue(s).filter(it => introducedQueueIds.has(it.queueId));
          for (const it of remaining) {
            if (it.queueId !== currentId) await post('/api/staff/kf', { action: 'remove', queueId: it.queueId });
          }
          if (currentId != null && introducedQueueIds.has(currentId) && !skippedIds.has(currentId)) {
            skippedIds.add(currentId);
            await post('/api/staff/kf', { action: 'next' });
          }
          if (remaining.length || (currentId != null && introducedQueueIds.has(currentId)) || s.pending) return null;
          return s;
        }, 18000, 700);
        if (!cleaned) cleanupErrors.push('des chansons ou un ajout en attente subsistent après 18 s');
        const finalState = cleaned || await staff();
        report.cleanup.remainingQueueIds = kfQueue(finalState).filter(it => introducedQueueIds.has(it.queueId)).map(it => it.queueId);
        report.samples.rawAfter = finalState.kf ? finalState.kf.raw || null : null;
      } catch (e) { cleanupErrors.push(e.message); }
    }
    if (initialSettings && (!KEEP || SKIP_PLAY)) {
      try { await post('/api/staff/settings', initialSettings); }
      catch (e) { cleanupErrors.push(`restauration des réglages : ${e.message}`); }
    }
    report.cleanup.introducedQueueIds = [...introducedQueueIds];
    report.cleanup.errors = cleanupErrors;
    if (cleanupErrors.length) step('Nettoyage et restauration des réglages', false, cleanupErrors.join(' ; '));
    else if (!report.cleanup.skipped) log('INFO  Nettoyage vérifié : tables de test et nouveaux queueId retirés ; file initiale préservée.');
    report.finishedAt = new Date().toISOString();
    report.passed = results.filter(r => r.level === 'PASS').length;
    report.warnings = results.filter(r => r.level === 'WARN').length;
    report.failed = results.filter(r => r.level === 'FAIL').length;
    const dir = path.join(__dirname, '..', 'journal');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* */ }
    const f = path.join(dir, `verif-${report.startedAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(f, JSON.stringify(report, null, 2));
    log(`\n${report.passed} PASS, ${report.warnings} WARN, ${report.failed} FAIL — détails : ${f}`);
    process.exitCode = report.failed ? 1 : 0;
  }
})().catch(e => { console.error('Impossible de finaliser le rapport :', e); process.exitCode = 2; });
