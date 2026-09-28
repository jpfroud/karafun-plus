'use strict';
/*
 * File karaoké équitable — serveur local à lancer sur le PC qui fait tourner KaraFun.
 *
 *   node server.js --code 123456        (KaraFun réel, code de la télécommande)
 *   node server.js --demo               (faux KaraFun intégré, pour essayer)
 *
 * Les clients scannent le QR de leur table et voient tout sur leur téléphone.
 * Le programme décide de l'ordre et n'envoie à KaraFun que la chanson suivante.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { Scheduler } = require('./scheduler');
const { KaraFunBridge, isBattleItem } = require('./karafun');
const { analyzeState } = require('./karafun-state');
const { TableAccess } = require('./table-access');
const { Catalog } = require('./catalog');
const { BattleVote } = require('./battle-vote');
const { NightStateStore, snapshotNight, restoreNight } = require('./night-state');

// ------------------------------------------------------------------ paramètres
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def; };
const PORT = parseInt(arg('port', process.env.PORT || 3000), 10);
// Les tunnels HTTPS doivent pointer ici, jamais vers le port du bar.
const PUBLIC_PORT = parseInt(arg('public-port', process.env.PUBLIC_PORT || PORT + 1), 10);
const DEMO = !!arg('demo', false);
const NO_OPEN = !!arg('no-open', false);
const CODE_FILE = path.join(__dirname, 'data', 'last-karafun-code.json');
function rememberedCode() {
  try { return String(JSON.parse(fs.readFileSync(CODE_FILE, 'utf8')).code || '').replace(/\D/g, ''); }
  catch { return ''; }
}
let CODE = String(arg('code', '') || rememberedCode()).replace(/\D/g, '');
const LOG_DIR = path.join(__dirname, 'journal');
fs.mkdirSync(LOG_DIR, { recursive: true });
const STAFF_KEY = crypto.randomBytes(16).toString('base64url');
const TABLE_FILE = path.join(__dirname, 'data', 'tables.json');
const BATTLE_FILE = path.join(__dirname, 'data', 'battle-vote.json');
const PHOTO_DIR = path.join(__dirname, 'data', 'photos');
const nightStore = DEMO ? null : new NightStateStore(path.join(__dirname, 'data', 'soiree'));
const RUNTIME_FILE = path.join(__dirname, 'data', `runtime-${PORT}.json`);
const STOP_KEY = crypto.randomBytes(24).toString('base64url');
let shuttingDown = false;
const personShareCodes = new Map();
const SOLO_COOKIE = 'karaoke_solo_device';
// Les titres proposés pour une Battle doivent avoir été reçus du catalogue
// KaraFun par ce serveur, et non inventés dans une requête cliente.
const battleCatalogSongs = new Map();
function rememberBattleSongs(songs) {
  for (const song of songs || []) {
    const songId = Number(song?.songId);
    const title = String(song?.title || '').trim();
    const artist = String(song?.artist || '').trim();
    if (!Number.isSafeInteger(songId) || songId <= 0 || !title || title.length > 100 || artist.length > 80) continue;
    battleCatalogSongs.delete(songId);
    battleCatalogSongs.set(songId, { songId, title, artist });
    if (battleCatalogSongs.size > 10000) battleCatalogSongs.delete(battleCatalogSongs.keys().next().value);
  }
  return songs;
}
function certifiedBattleSongs(songs) {
  if (!Array.isArray(songs) || songs.length < 1 || songs.length > 3) {
    throw new Error('Propose entre un et trois titres du catalogue pour la Battle.');
  }
  return songs.map(song => {
    const seen = battleCatalogSongs.get(Number(song?.songId));
    if (!seen) throw new Error('Retrouve ce titre dans le catalogue avant de proposer la Battle.');
    return { ...seen };
  });
}

const sched = new Scheduler({ solverEnabled: !DEMO || argv.includes('--solver') });
const access = new TableAccess();
const battleVote = new BattleVote({
  saved: !DEMO && fs.existsSync(BATTLE_FILE) ? JSON.parse(fs.readFileSync(BATTLE_FILE, 'utf8')) : null,
  onChange(event) {
    if (!DEMO) {
      fs.mkdirSync(path.dirname(BATTLE_FILE), { recursive: true });
      const temporary = `${BATTLE_FILE}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(battleVote.serialize()));
      fs.renameSync(temporary, BATTLE_FILE);
    }
    if (event === 'requested') {
      const title = battleVote.ballot?.selectedSong?.title;
      sched.note(`La salle demande une Battle collective${title ? ` sur « ${title} »` : ''} : le bar doit l’organiser dans KaraFun.`, 'battle');
    }
    else if (event === 'proposed') sched.note('Un vote pour une Battle collective est ouvert pendant deux minutes.', 'battle');
    else if (event === 'expired' || event === 'rejected') sched.note('Vote Battle terminé sans majorité. Prochain vote après la pause.', 'battle');
    else if (event === 'done' || event === 'dismissed') sched.note('Demande Battle traitée par le bar. Pause entre les votes.', 'battle');
    if (!DEMO) setImmediate(() => saveNight());
  },
});
if (DEMO) sched.opts.defaultSlotSec = parseInt(arg('song-seconds', 45), 10) + 1;
let bridge = null;
let fake = null;
const SONG_SECONDS = parseInt(arg('song-seconds', 45), 10);
// La chanson suivante est choisie le plus tard possible (pour tenir compte des derniers arrivés),
// mais assez tôt pour que KaraFun la charge : `pushDelaySec` après le début de la chanson en cours.
const settings = { auto: true, autoPlay: false, baseUrl: null,
  pushDelaySec: DEMO ? Math.max(1, Math.round(SONG_SECONDS / 3)) : 45, playDelaySec: 8,
  queueClearPending: false };
const queueClearRemovalRequests = new Map();
let curKey = null, curSince = 0;
let pending = null;     // chanson envoyée à KaraFun, en attente de confirmation
let tracked = [];       // nos chansons présentes dans KaraFun
let idleSince = null;
let idleQueueId = null;
let emptySince = null;  // transition après Suivant : KaraFun peut ignorer un ajout immédiat
let hadNativeQueue = false;
let recoveredPending = false;
let persistenceError = null;

function saveNight({ required = false, replaceBoth = false } = {}) {
  if (!nightStore) return true;
  try {
    const snapshot = snapshotNight({ scheduler: sched, access, settings, pending, tracked,
      photoDir: PHOTO_DIR });
    nightStore.save(snapshot);
    if (replaceBoth) nightStore.save(snapshot, { force: true });
    persistenceError = null;
    return true;
  } catch (error) {
    persistenceError = error.message;
    settings.auto = false;
    appLog(`ERREUR sauvegarde de soirée : ${error.message}. Envoi automatique suspendu.`);
    if (required) throw error;
    return false;
  }
}

function rememberCode() {
  if (DEMO || !CODE) return;
  fs.mkdirSync(path.dirname(CODE_FILE), { recursive: true });
  const temporary = `${CODE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ code: CODE }));
  fs.renameSync(temporary, CODE_FILE);
}

function appLog(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(msg);
  try { fs.appendFileSync(path.join(LOG_DIR, `serveur-${line.slice(0, 10)}.log`), line + '\n'); } catch (e) { /* */ }
}

function stopHelper() {
  if (shuttingDown) return;
  shuttingDown = true;
  saveNight();
  appLog('Arrêt de la file karaoké demandé par le bar.');
  sched.closeSolver();
  try { bridge?.disconnect(); } catch (_) { /* arrêt en cours */ }
  try { fake?.close(); } catch (_) { /* arrêt en cours */ }
  try {
    const runtime = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    if (runtime.pid === process.pid && runtime.secret === STOP_KEY) fs.unlinkSync(RUNTIME_FILE);
  } catch (_) { /* fichier déjà absent */ }
  server.close();
  publicServer.close();
  setTimeout(() => process.exit(0), 500).unref();
}

function saveTables() {
  if (DEMO) return;
  const data = { version: 1, baseUrl: settings.baseUrl, tables: [...sched.tables.values()].map(t => ({
    id: t.id, name: t.name, headcount: t.headcount, individual: t.individual, secret: access.get(t.id),
  })) };
  fs.mkdirSync(path.dirname(TABLE_FILE), { recursive: true });
  const temporary = `${TABLE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, TABLE_FILE);
}

function loadTables() {
  if (DEMO || !fs.existsSync(TABLE_FILE)) {
    sched.table('1'); access.issue('1'); saveTables(); return;
  }
  const data = JSON.parse(fs.readFileSync(TABLE_FILE, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.tables)) throw new Error('Fichier des tables invalide');
  settings.baseUrl = normalizeBaseUrl(data.baseUrl);
  for (const row of data.tables) {
    const id = TableAccess.key(row.id);
    if (row.headcount !== null && (!Number.isInteger(row.headcount) || row.headcount < 1 || row.headcount > 40)) {
      throw new Error(`Effectif invalide pour ${id}`);
    }
    const t = sched.table(id);
    if (row.name) {
      const name = String(row.name).replace(/\s+/g, ' ').trim();
      if (name.length > 40) throw new Error(`Nom de table invalide pour ${id}`);
      t.name = name;
    }
    t.headcount = row.headcount;
    t.individual = !!row.individual;
    access.restore(id, row.secret);
  }
}

// Le QR commun aux personnes venues seules reste disponible sans préparation
// du bar. L'identifiant historique ne change pas : les QR déjà imprimés
// continuent à fonctionner pendant une soirée restaurée.
function ensureSoloGroup() {
  let solo = sched.table('Comptoir', false);
  if (solo && !solo.individual && sched.tableSingers(solo.id).length) return;
  if (!solo) solo = sched.table('Comptoir');
  if (!solo.name || solo.name === 'Comptoir') solo.name = 'En solo';
  solo.individual = true;
  if (solo.headcount == null) solo.headcount = 40;
  if (!access.get(solo.id)) access.issue(solo.id);
  saveTables();
}

// ------------------------------------------------------------------ KaraFun : lecture de l'état
function analyze() {
  if (!bridge || !bridge.ready) return analyzeState();
  return analyzeState(bridge.queue, bridge.status);
}

function isOnStage(tr, current) {
  if (!current) return false;
  if (current.queueId != null && tr.queueId != null) return current.queueId === tr.queueId;
  return Number(current.songId) === tr.sel.song.songId;
}

// La demande « Je suis là » suit le prochain titre réel. Le simple numéro
// d'un ticket dans Q n'est pas suffisant : un ticket peut être sans chanson,
// et readyView masque justement les chanteurs qui n'ont pas encore confirmé.
function presenceCandidate({ current, upcoming } = analyze()) {
  if (!sched.opts.requirePresence || settings.queueClearPending) return null;
  if (upcoming.length) {
    const first = tracked.find(tr => !tr.cancelled && String(tr.queueId) === String(upcoming[0].queueId));
    return first ? { ...first.sel, source: 'karafun' } : null;
  }
  if (pending && !pending.cancelled) return { ...pending.sel, source: 'envoi' };
  const onStage = tracked.find(tr => isOnStage(tr, current));
  const excluded = onStage?.sel.ids || [];
  // Une notification « Je suis là » promet le prochain passage. Attendons
  // la même version du plan que l'envoi, y compris si cette lecture précède
  // le prochain balayage de synchronisation.
  if (!sched.reservedNext) {
    sched.whenPlanReady();
    if (sched.solverStatus().pending) return null;
  }
  const planned = sched.presenceView(excluded).find(turn => !turn.future && turn.song);
  return planned ? { ...planned, source: 'helper' } : null;
}

function presenceMissing(candidate) {
  if (!candidate) return [];
  const selectionConfirmed = candidate.source !== 'helper' && candidate.presenceConfirmed;
  return candidate.ids.filter(pid => {
    const p = sched.people.get(pid);
    return p && !p.withdrawnAt && !selectionConfirmed && !sched._confirmedRecently(p);
  });
}

function restore(tr, reason) {
  // L'ajout dans KaraFun avait réservé un passage, mais personne n'a chanté.
  // Annuler le crédit physique complet avant de remettre le titre en attente.
  sched.rollbackUnplayed(tr.sel);
  const owner = sched.people.get(tr.sel.ids[0]);
  if (!owner) return;
  // Une autre chanson peut avoir été ajoutée pendant que la première était
  // déjà chez KaraFun : ne jamais écraser cette liste.
  if (!owner.song || owner.song.entryId !== tr.sel.song.entryId) {
    if (owner.song) owner.backlog.unshift(owner.song);
    owner.song = tr.sel.song;
  }
  for (const pid of (tr.sel.consumedIds || tr.sel.ids)) {
    const p = sched.people.get(pid);
    if (!p) continue;
    const i = sched.Q.indexOf(pid);
    if (i >= 0) { sched.Q.splice(i, 1); sched.Q.splice(Math.min(3, sched.Q.length), 0, pid); }
  }
  sched.note(`« ${tr.sel.song.title} » (${tr.sel.label}) ${reason} : garde sa chanson et reprend la 4e place`, 'staff');
}

function battleHoldsQueue() {
  const state = battleVote.automation?.status;
  return !!state && !['released', 'resuming'].includes(state) &&
    !(state === 'waiting' && sched.reservedNext);
}

function syncBattle({ current, upcoming, q }, now) {
  let state = battleVote.automation;
  const native = [current, ...q].filter(Boolean).find(item => isBattleItem(item) &&
    item.queueId != null && String(item.queueId) !== String(state?.queueId || ''));
  if (!settings.queueClearPending && native && state?.status === 'manual' &&
      Number(native.songId) === state.songId) {
    battleVote.confirmManualAutomation(native.queueId);
    sched.note('KaraFun confirme la Battle manuelle : la fin sera détectée automatiquement.', 'battle');
    state = battleVote.automation;
  } else if (!settings.queueClearPending && native &&
      (!state || state.status === 'released' || state.status === 'manual' ||
        (state.status === 'waiting' && Number(native.songId) !== state.songId))) {
    battleVote.observeExternalBattle(native);
    sched.note('Battle ajoutée dans KaraFun : lancement et reprise du titre suivant réservés au bar.', 'battle');
    state = battleVote.automation;
  }
  if (!state || state.status === 'released') return;
  const matches = q.filter(item => Number(item.songId) === state.songId && isBattleItem(item));
  if (state.status === 'waiting') {
    if (matches.length === 1) {
      battleVote.confirmAutomation(matches[0].queueId);
      sched.note('Battle reconnue dans KaraFun : le bar laisse les téléphones rejoindre avant le départ.', 'battle');
    } else if (matches.length > 1) {
      battleVote.updateAutomation('failed', 'Plusieurs Battles identiques sont dans KaraFun. Vérifie la file.');
    } else if (!state.songId) {
      battleVote.updateAutomation('failed', 'Le vote ne contient pas de titre KaraFun compatible.');
    } else if (settings.auto &&
        (bridge.protocol !== 'kcs' || bridge.raw?.configuration) &&
        !upcoming.length && !pending && !recoveredPending && !settings.queueClearPending &&
        !sched.reservedNext && bridge.permissions?.addToQueue !== false) {
      // Le passage suivant déjà garanti garde sa place. Une Battle approuvée
      // attend qu'il ait chanté avant d'occuper la prochaine case libre.
      battleVote.beginAutomation(q.map(item => String(item.queueId)));
      try {
        bridge.addBattle(state.songId, current ? 1 : 0);
        sched.note('Titre Battle envoyé à KaraFun : attente de la confirmation du mode Battle.', 'battle');
      } catch (error) {
        battleVote.updateAutomation('failed', error.message);
        sched.note(`Battle à préparer manuellement : ${error.message}`, 'battle');
      }
    }
  } else if (state.status === 'sending' || state.status === 'failed') {
    const fresh = q.filter(item => !state.before.includes(String(item.queueId)) &&
      Number(item.songId) === state.songId);
    const battles = fresh.filter(isBattleItem);
    if (battles.length === 1) {
      battleVote.confirmAutomation(battles[0].queueId);
      sched.note('KaraFun confirme le mode Battle : la pause entre votes commence.', 'battle');
    } else if (battles.length > 1) {
      if (state.status !== 'failed') battleVote.updateAutomation('failed', 'Plusieurs Battles identiques sont apparues dans KaraFun.');
    } else if (fresh.some(item => item.singer === 'Battle collective')) {
      if (state.status !== 'failed') battleVote.updateAutomation('failed', 'KaraFun a ajouté le titre sans le mode Battle. Vérifie-le avant de lancer.');
    } else if (state.status === 'sending' && now - state.sentAt > 15000) {
      // Pas de seconde commande : un accusé tardif pourrait créer un doublon.
      battleVote.updateAutomation('failed', 'KaraFun n’a pas confirmé l’ajout Battle. Vérifie sa file avant d’agir.');
    }
  } else if (state.status === 'queued' || state.status === 'playing') {
    const queueHasBattle = q.some(item => String(item.queueId) === state.queueId);
    const statusId = bridge.status?.current?.queueId || bridge.status?.songPlaying?.queueId;
    if (current && String(current.queueId) === state.queueId && state.status === 'queued') {
      battleVote.updateAutomation('playing');
    } else if (!queueHasBattle && String(statusId || '') !== state.queueId) {
      // QueueEvent peut arriver avant StatusEvent. Si le titre prêt disparaît
      // momentanément de la file, patienter avant de conclure qu'il est fini.
      if (state.status === 'queued' && !state.missingSince) {
        state.missingSince = now;
        battleVote._changed('automation-missing');
      } else if (state.status === 'playing' || now - state.missingSince >= 1500) {
        battleVote.updateAutomation('after');
        sched.note('Battle terminée : le prochain titre attend le lancement manuel du bar.', 'battle');
      }
    } else if (state.missingSince) {
      state.missingSince = null;
      battleVote._changed('automation-found');
    }
  } else if (state.status === 'resuming') {
    if (current && !isBattleItem(current)) {
      battleVote.updateAutomation('released');
    } else if (!state.resumePlaySentAt && upcoming.length && !current) {
      const first = upcoming[0];
      if (!isBattleItem(first)) {
        try {
          bridge.play();
          state.resumePlaySentAt = now;
          battleVote._changed('automation-resume-play');
        } catch (error) { sched.note(`Reprise Battle à relancer : ${error.message}`, 'battle'); }
      }
    }
  }
}

// ------------------------------------------------------------------ synchronisation avec KaraFun
function sync() {
  if (!bridge || !bridge.ready) return;
  if (settings.auto && bridge.permissions?.addToQueue === false) {
    settings.auto = false;
    sched.note('KaraFun refuse l’ajout de titres pour le compte FileKaraoke : donne-lui le rôle administrateur dans KaraFun Pro.', 'error');
  }
  const { current, upcoming, q } = analyze();
  const qids = new Set(q.map(it => it.queueId));
  const now = Date.now();
  syncBattle({ current, upcoming, q }, now);
  if (q.length) { hadNativeQueue = true; emptySince = null; }
  else if (hadNativeQueue && emptySince === null) emptySince = now;

  if (pending) {
    const matches = q.filter(it => !pending.before.has(it.queueId) && Number(it.songId) === pending.sel.song.songId && it.singer === pending.sel.label);
    const hit = recoveredPending && matches.length !== 1 ? null : matches[0];
    if (hit) {
      if (pending.cancelled) {
        if (isOnStage({ queueId: hit.queueId, sel: pending.sel }, current)) {
          // L'accusé et le début de lecture peuvent arriver dans le même
          // événement. Ne pas arrêter un morceau déjà sur scène.
          sched.commit(pending.sel);
          if (settings.queueClearPending) {
            const consumed = new Set(pending.sel.consumedIds || pending.sel.ids);
            sched.Q = sched.Q.filter(pid => !consumed.has(pid));
          }
          tracked.push({ queueId: hit.queueId, sel: pending.sel, addedAt: now, startedAt: now });
          sched.note(`« ${pending.sel.song.title} » a commencé sur scène pendant le retrait ; elle continue.`, 'stage');
        } else {
          tracked.push({ queueId: hit.queueId, sel: pending.sel,
            addedAt: now, startedAt: null, cancelled: true, removeRequestedAt: now });
          try { bridge.remove(hit.queueId); }
          catch (error) { appLog(`Retrait KaraFun en attente : ${error.message}`); }
          sched.note(`« ${pending.sel.song.title} » retirée de KaraFun après le départ du chanteur`, 'staff');
        }
      } else {
        sched.commit(pending.sel);
        tracked.push({ queueId: hit.queueId, sel: pending.sel, addedAt: Date.now(), startedAt: null });
        appLog(`Envoyé à KaraFun : ${pending.sel.label} — ${pending.sel.song.title} (queueId ${hit.queueId})`);
      }
      pending = null;
      recoveredPending = false;
    } else if (!recoveredPending && now - pending.at > 15000) {
      // Une réponse manquante ne prouve pas que KaraFun a refusé l'ajout.
      // Le renvoyer créerait un doublon si la première commande arrive tard.
      recoveredPending = true;
      sched.note(`KaraFun n'a pas confirmé « ${pending.sel.song.title} » (${pending.sel.label}). Vérifie sa file avant de reprendre l'envoi automatique.`, 'error');
      appLog('Ajout KaraFun sans confirmation : envoi automatique suspendu, aucune seconde commande envoyée.');
    }
  }

  // Une remise à zéro peut avoir été demandée pendant une déconnexion. Au
  // retour de KaraFun, retirer aussi les titres ajoutés hors de cette page.
  // Leur queueId n'est connu qu'après un QueueEvent frais.
  if (settings.queueClearPending) {
    const known = new Set(tracked.map(tr => String(tr.queueId)));
    for (const item of upcoming) {
      const queueId = String(item.queueId);
      if (known.has(queueId) || now - (queueClearRemovalRequests.get(queueId) || 0) < 20000) continue;
      try { bridge.remove(item.queueId); queueClearRemovalRequests.set(queueId, now); }
      catch (error) { appLog(`Retrait KaraFun en attente : ${error.message}`); }
    }
    const stillUpcoming = new Set(upcoming.map(item => String(item.queueId)));
    for (const queueId of queueClearRemovalRequests.keys()) {
      if (!stillUpcoming.has(queueId)) queueClearRemovalRequests.delete(queueId);
    }
  }

  for (const tr of tracked.slice()) {
    const onStage = isOnStage(tr, current);
    // Si KaraFun était déconnecté lors du vidage, ce titre pouvait déjà être
    // sur scène. Ne jamais interrompre la chanson effectivement en lecture.
    if (tr.cancelled && onStage && settings.queueClearPending) tr.cancelled = false;
    if (tr.cancelled && qids.has(tr.queueId) && !onStage &&
        now - (tr.removeRequestedAt || 0) >= 20000) {
      tr.removeRequestedAt = now;
      try { bridge.remove(tr.queueId); }
      catch (error) { appLog(`Retrait KaraFun en attente : ${error.message}`); }
    }
    if (onStage && !tr.startedAt) {
      tr.startedAt = Date.now();
      sched.note(`Sur scène : ${tr.sel.label} — « ${tr.sel.song.title} »`, 'stage');
    }
    // QueueEvent et StatusEvent ne sont pas atomiques. Quand l'ancienne chanson
    // est encore dans status.current, attendre le second message avant de
    // conclure qu'elle a disparu (notamment après le bouton Suivant natif).
    const statusId = bridge.status && (bridge.status.current || bridge.status.songPlaying || {}).queueId;
    if (!qids.has(tr.queueId) && !onStage && statusId !== tr.queueId) {
      if (tr.cancelled) {
        // Un accusé tardif d'un envoi annulé peut avoir été suivi sans
        // `commit()` : il n'a alors aucun crédit à rendre.
        if (!tr.startedAt && tr.sel.turnCredit) sched.rollbackUnplayed(tr.sel);
        sched.note(`Retrait KaraFun confirmé : « ${tr.sel.song.title} »`, 'staff');
      }
      else if (tr.startedAt) { sched.recordSlot((Date.now() - tr.startedAt) / 1000); sched.songEnded(tr.sel.ids); }
      else if (tr.absent) restore(tr, 'retirée (absent à l\'appel)');
      else {
        sched.rollbackUnplayed(tr.sel, { requeue: true });
        sched.note(`« ${tr.sel.song.title} » (${tr.sel.label}) a été passée dans KaraFun avant la lecture : elle ne sera pas renvoyée automatiquement`, 'skip');
      }
      tracked = tracked.filter(x => x !== tr);
      sched.version++;
    }
  }

  // Le même événement QueueEvent peut confirmer un solo promis puis libérer
  // immédiatement la place pour la Battle, ou confirmer le premier titre
  // après Battle. Éviter d'attendre le prochain balayage de deux secondes.
  syncBattle({ current, upcoming, q }, now);

  if (settings.queueClearPending && !upcoming.length && !pending &&
      !tracked.some(tr => tr.cancelled && !isOnStage(tr, current))) {
    settings.queueClearPending = false;
    queueClearRemovalRequests.clear();
    sched.note('File vidée dans KaraFun : les nouveaux choix peuvent être envoyés.', 'staff');
  }

  const key = current ? String(current.queueId != null ? current.queueId : `${current.songId}|${current.title}`) : null;
  if (key !== curKey) { curKey = key; curSince = Date.now(); }
  // Dès qu'un titre est sur scène, le nom annoncé pour le passage suivant
  // reste fixe. L'envoi physique à KaraFun peut attendre le délai configuré.
  if (!upcoming.length && !pending && !settings.queueClearPending && !battleHoldsQueue()) {
    if (sched.opts.requirePresence) {
      const onStage = tracked.find(tr => isOnStage(tr, current));
      sched.reservePresenceNext(onStage?.sel.ids || []);
    } else if (current) sched.reserveNext();
  }
  const presence = presenceCandidate({ current, upcoming });
  const awaitingPresence = presenceMissing(presence).length > 0;
  const canPush = !current || Date.now() - curSince >= settings.pushDelaySec * 1000;
  const staleTracked = tracked.some(tr => !qids.has(tr.queueId));
  const emptySettled = emptySince === null || now - emptySince >= 1000;
  if (settings.auto && !settings.queueClearPending && !battleHoldsQueue() && !recoveredPending && !awaitingPresence &&
      bridge.ready && !staleTracked && upcoming.length === 0 && canPush && emptySettled) {
    if (!pending) {
      // Après un échec, la chanson du chanteur peut avoir changé : le choix
      // actuel de l'ordonnanceur prévaut au moment de la nouvelle tentative.
      const sel = sched.select();
      if (sel) {
        pending = { sel, before: qids, at: now, attempts: 1, retryAt: null };
        try {
          // La commande distante n'a pas d'accusé immédiat : conserver la
          // tentative sur disque avant de l'envoyer pour éviter un doublon.
          saveNight({ required: true });
          bridge.add(sel.song.songId, sel.label);
        } catch (e) { pending = null; settings.auto = false; appLog(`ERREUR envoi : ${e.message}`); }
      } else pending = null;
    }
  }

  // Lancement automatique si KaraFun est à l'arrêt avec une chanson prête
  if (!current && upcoming.length && bridge.ready) {
    const first = upcoming[0];
    const firstQueueId = first.queueId == null ? null : String(first.queueId);
    if (idleQueueId !== firstQueueId) { idleQueueId = firstQueueId; idleSince = Date.now(); }
    else if (!idleSince) idleSince = Date.now();
    const owner = firstQueueId === null ? null : tracked.find(tr => String(tr.queueId) === firstQueueId);
    const present = owner && !owner.cancelled && (owner.sel.ids.every(pid => sched.people.has(pid)) &&
      (!sched.opts.requirePresence || owner.sel.presenceConfirmed || sched.confirmedForTurn(owner.sel.ids)));
    if (settings.autoPlay && !settings.queueClearPending &&
        (!battleVote.automation || battleVote.automation.status === 'released' ||
          (battleVote.automation.status === 'waiting' && !isBattleItem(upcoming[0]))) &&
        present && Date.now() - idleSince >= settings.playDelaySec * 1000) {
      try { bridge.play(); idleSince = Date.now() + 20000; } catch (e) { /* */ }
    }
  } else { idleSince = null; idleQueueId = null; }
  saveNight();
}

// ------------------------------------------------------------------ vues
const fmtSong = (s) => s ? { entryId: s.entryId || null, songId: s.songId, title: s.title, artist: s.artist, img: s.img || null, duration: s.duration || null,
  duet: s.duet ? { partnerName: sched.people.get(s.duet.partnerId)?.name || 'Un chanteur', state: s.duet.state, kind: s.duet.kind || 'duo' } : null } : null;

function describe(item, byQid) {
  const tr = byQid.get(item.queueId);
  return {
    ours: !!tr, queueId: item.queueId || null,
    singer: tr ? tr.sel.label : (item.singer || (isBattleItem(item) ? 'Battle collective' : '')),
    title: item.title || '', artist: item.artist || '',
    kind: tr?.sel.kind || (isBattleItem(item) ? 'battle' : null),
    ids: tr ? tr.sel.ids : [], photos: tr ? tr.sel.ids.filter(pid => (sched.people.get(pid) || {}).photo).map(pid => `/photo/${pid}`) : [],
  };
}

function publicState(person, tableId) {
  const { current, upcoming } = analyze();
  const presence = presenceCandidate({ current, upcoming });
  const presenceMissingIds = new Set(presenceMissing(presence));
  const byQid = new Map(tracked.map(tr => [tr.queueId, tr]));
  const slot = sched.avgSlotSec() * 1000;
  const curTr = current ? tracked.find(tr => isOnStage(tr, current)) : null;
  const firstFreeAt = current ? ((curTr && curTr.startedAt) ? curTr.startedAt + slot : Date.now() + slot / 2) : Date.now();
  const stage = current ? describe(current, byQid) : null;
  const queue = upcoming.map((it, i) => ({ ...describe(it, byQid),
    source: 'karafun', pos: i + 1, eta: firstFreeAt + i * slot,
    waitingPresence: i === 0 && presence?.source === 'karafun' && presenceMissingIds.size > 0,
    name: byQid.has(it.queueId) ? byQid.get(it.queueId).sel.names.join(' & ') :
      (it.singer || (isBattleItem(it) ? 'Battle collective' : 'KaraFun')),
    song: fmtSong(it), table: byQid.has(it.queueId) ? sched.table(sched.people.get(byQid.get(it.queueId).sel.ids[0])?.tableId, false)?.name || '' : '',
  }));
  if (pending) queue.push({ source: 'envoi', ours: true, queueId: null,
    pos: queue.length + 1, eta: firstFreeAt + queue.length * slot,
    singer: pending.sel.label, name: pending.sel.names.join(' & '),
    title: pending.sel.song.title, artist: pending.sel.song.artist,
    ids: pending.sel.ids, kind: pending.sel.kind, song: fmtSong(pending.sel.song),
    table: sched.table(sched.people.get(pending.sel.ids[0])?.tableId, false)?.name || '' });
  // La file affichée montre aussi les titres dont la présence sera demandée
  // plus tard. Seul le prochain reçoit l'alerte et bloque l'envoi réel.
  const ready = sched.presenceView(pending ? (pending.sel.consumedIds || pending.sel.ids) : [], pending ? pending.sel : null);
  for (const v of ready) queue.push({ source: 'helper', ours: true, queueId: null,
    pos: queue.length + 1, eta: firstFreeAt + queue.length * slot,
    singer: `${v.name} · ${v.table}`, name: v.name, title: v.song.title, artist: v.song.artist,
    id: v.ids[0], ids: v.ids, kind: v.kind, song: fmtSong(v.song), table: v.table, tableId: v.tableId,
    qi: v.qi, over: v.over, cap: v.cap, confirmed: v.confirmed, future: !!v.future,
    waitingPresence: presence?.source === 'helper' && presenceMissingIds.size > 0 &&
      v.entryId === presence.song?.entryId,
    isNew: !v.future && ((sched.people.get(v.ids[0])?.sung || 0) +
      (sched.people.get(v.ids[0])?.duetGuestCount || 0)) === 0,
    guaranteed: !v.future && sched.reservedNext?.personId === v.ids[0] });
  const next = queue[0] || null;
  const nextEta = next?.eta || null;
  const confirmedForPage = p => !!sched._confirmedRecently(p) ||
    tracked.some(tr => tr.sel.ids.includes(p.id) && tr.sel.presenceConfirmed);
  const needsPresence = p => presenceMissingIds.has(p.id) &&
    !(stage?.ours && stage.ids.includes(p.id));
  const waiting = sched.Q.map(pid => sched.people.get(pid)).filter(p => p && !p.song && !tracked.some(tr => tr.sel.ids.includes(p.id)))
    .map(p => ({ id: p.id, name: p.name, table: sched.table(p.tableId, false)?.name || '' }));

  const out = {
    now: Date.now(),
    karafun: { connected: !!(bridge && bridge.connected), ready: !!(bridge && bridge.ready), demo: DEMO },
    stage, next, nextEta, queue, waiting, internalCount: sched.Q.length,
    catalogAvailable: !!(CODE && bridge?.ready && !DEMO),
    guaranteed: sched.reservedNext ? 1 : 0,
    avgSlotMin: Math.round(sched.avgSlotSec() / 6) / 10,
    rules: { gap: sched.opts.gap, cap: sched.opts.cap, protectTop: sched.opts.protectTop,
      requirePresence: sched.opts.requirePresence, tableRotation: sched.opts.tableRotation,
      weightedTables: sched.opts.weightedTables },
    log: sched.log.slice(-30).reverse(),
    v: sched.version,
    battle: battleVote.view(),
  };

  const guestDuosOf = person => {
    const duos = [];
    for (const owner of sched.people.values()) for (const song of sched.songsOf(owner)) {
      if (song.duet?.partnerId === person.id && song.duet.state === 'accepted') {
        duos.push({ entryId: song.entryId, fromName: owner.name, song: fmtSong(song) });
      }
    }
    return duos;
  };

  out.people = [...sched.people.values()].filter(p => !tableId || p.tableId === tableId)
    .map(p => ({ id: p.id, name: p.name,
    table: sched.table(p.tableId, false)?.name || p.tableId, tableId: p.tableId,
    busy: false }));

  const tid = person ? person.tableId : (tableId ? String(tableId) : null);
  if (tid) {
    // La file commune reste publique, mais les personnes sans titre et le
    // journal des actions des autres tables ne concernent pas ce téléphone.
    out.waiting = out.waiting.filter(item => sched.people.get(item.id)?.tableId === tid);
    delete out.log;
    out.battle = { ...out.battle,
      eligiblePersonIds: out.battle.eligiblePersonIds.filter(id => sched.people.get(id)?.tableId === tid),
      votedPersonIds: out.battle.votedPersonIds.filter(id => sched.people.get(id)?.tableId === tid) };
  }
  if (tid) {
    const t = sched.table(tid, false);
    out.table = t ? { id: t.id, name: t.name, headcount: t.headcount, individual: t.individual,
      count: sched.tableSingers(t.id).length, activeCount: sched.tableSingers(t.id).filter(p => !p.withdrawnAt).length } :
      { id: tid, name: /^\d+$/.test(tid) ? `Table ${tid}` : tid, headcount: null, count: 0, activeCount: 0 };
    if (t?.individual) {
      out.people = out.people.filter(item => item.id === person?.id);
      out.waiting = [];
      out.battle.eligiblePersonIds = out.battle.eligiblePersonIds.filter(id => id === person?.id);
      out.battle.votedPersonIds = out.battle.votedPersonIds.filter(id => id === person?.id);
      // Seules les personnes qui ont demandé un code de reprise au bar (ou
      // sur leur ancien téléphone) apparaissent dans ce parcours temporaire.
      out.recoveryPeople = person ? [] : sched.tableSingers(tid).filter(p => !p.withdrawnAt &&
        personShareCodes.get(p.id)?.expiresAt > Date.now()).map(p => ({ id: p.id, name: p.name }));
    }
    out.tablePeople = sched.tableSingers(tid).filter(p => !t?.individual || p.id === person?.id)
      .map(p => ({ id: p.id, name: p.name,
      active: !p.withdrawnAt,
      songs: sched.songsOf(p).map(fmtSong),
      confirmed: confirmedForPage(p),
      needConfirm: needsPresence(p),
      invite: p.invite ? { fromName: sched.people.get(p.invite.fromId)?.name || 'Un chanteur',
        song: fmtSong(p.invite.song) } : null,
      invites: sched.duetInvites(p).map(inv => ({ entryId: inv.entryId,
        fromName: sched.people.get(inv.fromId)?.name || 'Un chanteur', song: fmtSong(inv.song) })),
      guestDuos: guestDuosOf(p),
      duet: p.duet ? { partnerName: sched.people.get(p.duet.partnerId)?.name || 'Un chanteur',
        state: p.duet.state } : p.duetOf ? { partnerName: sched.people.get(p.duetOf)?.name || 'Un chanteur',
        state: 'accepted', asPartner: true } : null,
      inKaraFun: tracked.filter(tr => tr.sel.ids.includes(p.id)).map(tr => ({ title: tr.sel.song.title, artist: tr.sel.song.artist,
        songId: tr.sel.song.songId, queueId: tr.queueId, stage: !!(stage && stage.queueId === tr.queueId) }))
        .concat(pending && pending.sel.ids.includes(p.id) ? [{ title: pending.sel.song.title, artist: pending.sel.song.artist,
          songId: pending.sel.song.songId, queueId: null, stage: false, sending: true }] : []),
    }));
  }

  if (person) {
    if (Date.now() - (person.lastSeen || 0) >= 60000) person.lastSeen = Date.now();
    const i = sched.Q.indexOf(person.id);
    const mine = queue.find(v => v.ids?.includes(person.id)) || null;
    const onStageNow = !!(stage && stage.ours && stage.ids.includes(person.id));
    const upNext = !!(next && next.ours && next.ids.includes(person.id));
    const owner = person.duetOf ? sched.people.get(person.duetOf) : null;
    const inviter = person.invite ? sched.people.get(person.invite.fromId) : null;
    const partner = person.duet ? sched.people.get(person.duet.partnerId) : null;
    out.me = {
      id: person.id, name: person.name, tableId: person.tableId, photo: person.photo ? `/photo/${person.id}` : null,
      song: fmtSong(person.song), songs: sched.songsOf(person).map(fmtSong),
      inKaraFun: out.tablePeople?.find(p => p.id === person.id)?.inKaraFun || [],
      sung: person.sung, inQueue: i >= 0,
      pos: mine ? mine.pos : null, eta: mine ? mine.eta : null, guaranteed: mine ? mine.guaranteed : false,
      over: person.over, onStage: onStageNow, upNext,
      invite: inviter ? { fromName: inviter.name, song: fmtSong(person.invite.song) } : null,
      invites: sched.duetInvites(person).map(inv => ({ entryId: inv.entryId,
        fromName: sched.people.get(inv.fromId)?.name || 'Un chanteur', song: fmtSong(inv.song) })),
      guestDuos: guestDuosOf(person),
      duet: partner ? { partnerName: partner.name, state: person.duet.state } : (owner ? { partnerName: owner.name, state: 'accepted', asPartner: true, song: fmtSong(owner.song) } : null),
      confirmed: confirmedForPage(person),
      needConfirm: needsPresence(person),
      mates: sched.table(person.tableId, false)?.individual ? [] :
        sched.tableSingers(person.tableId).filter(p => p.id !== person.id).map(p => { const v = queue.find(x => x.ids?.includes(p.id)); return { id: p.id, name: p.name, pos: v ? v.pos : null, busy: false }; }),
    };
  }
  return out;
}

function staffState() {
  const pub = publicState(null, null);
  const presence = presenceCandidate();
  const presenceIds = new Set(presenceMissing(presence));
  const presencePending = [...presenceIds].map(pid => sched.people.get(pid)?.name).filter(Boolean);
  const ips = lanAddresses();
  const alreadySent = new Set(tracked.map(tr => tr.sel.song?.entryId).filter(Boolean));
  if (pending?.sel.song?.entryId) alreadySent.add(pending.sel.song.entryId);
  const blocked = sched.Q.map(id => sched.people.get(id)).filter(p =>
    p && p.song?.duet?.state === 'pending' && !alreadySent.has(p.song.entryId) &&
    !pub.queue.some(q => q.source === 'helper' && q.song?.entryId === p.song.entryId))
    .map(p => ({ id: p.id, name: p.name, table: sched.table(p.tableId, false)?.name || '',
      title: p.song.title, artist: p.song.artist || '', reason: 'Duo à accepter' }));
  const canUndoManual = sched.canUndoManualChange(priorityNativeFingerprint());
  const latestManual = sched.manualChanges.at(-1);
  return {
    ...pub,
    battle: battleVote.view(),
    blocked,
    manualChanges: sched.manualChanges.slice().reverse().map((change, index) => ({
      id: change.id, kind: change.kind, name: change.name,
      from: change.from, to: change.to, at: change.at,
      canUndo: index === 0 && canUndoManual,
      unavailableReason: index > 0 ? 'Annule d’abord les interventions plus récentes.' :
        canUndoManual ? null : 'La file a changé depuis cette intervention.',
    })),
    priorityUndo: latestManual?.kind === 'priority' && canUndoManual ?
      { available: true, name: latestManual.name } : null,
    presencePending,
    persistenceError, recoveredPending, queueClearPending: !!settings.queueClearPending,
    removalPending: tracked.filter(tr => tr.cancelled).length,
    log: sched.log.slice(-120).reverse(),
    settings: { ...settings, gap: sched.opts.gap, cap: sched.opts.cap, requirePresence: sched.opts.requirePresence,
      tableRotation: sched.opts.tableRotation, weightedTables: sched.opts.weightedTables,
      battleCooldownMin: battleVote.cooldownMs / 60000 },
    solver: sched.solverStatus(),
    phoneBase: phoneBase(), ips, port: PORT, staffKey: STAFF_KEY,
    tables: [...sched.tables.values()].map(t => ({ ...t,
      url: access.get(t.id) ? access.url(phoneBase(), t.id) : null,
      qrUrl: access.get(t.id) ? `/qr/${encodeURIComponent(t.id)}.svg` : null,
      count: sched.tableSingers(t.id).length,
      activeCount: sched.tableSingers(t.id).filter(p => !p.withdrawnAt).length,
      inQueue: sched.tableSingers(t.id).filter(p => sched.Q.includes(p.id)).length })),
    people: [...sched.people.values()].map(p => ({ id: p.id, name: p.name, tableId: p.tableId,
      sung: p.sung, inQueue: sched.Q.includes(p.id), lastSeen: p.lastSeen,
      active: !p.withdrawnAt, songCount: sched.songsOf(p).length,
      privateNote: p.privateNote || '', verified: !!p.verifiedAt,
      photoUrl: p.photo ? `/photo/${p.id}` : null })),
    pending: pending ? { label: pending.sel.label, title: pending.sel.song.title } : null,
    tracked: tracked.map(tr => ({ queueId: tr.queueId, label: tr.sel.label, title: tr.sel.song.title,
      ids: tr.sel.ids, startedAt: tr.startedAt })),
    kf: bridge ? bridge.snapshot() : null,
    code: CODE,
  };
}

// L'historique ne peut restaurer que la file du helper. Une évolution de la
// lecture ou de l'ordre natif KaraFun rend le dernier état manuel périmé.
function priorityNativeFingerprint() {
  const live = analyze();
  // Certaines versions annoncent le titre avant de lui attribuer un queueId.
  // Le statut varie pendant une même chanson : il n'appartient pas à l'identité.
  const identity = item => item ? [item.queueId ?? null, item.songId ?? null,
    item.title || '', item.singer || ''] : null;
  const value = JSON.stringify({
    current: identity(live.current),
    upcoming: live.upcoming.map(identity),
    pending: pending?.sel.song?.entryId || null,
    tracked: tracked.map(item => [item.queueId, item.sel.song?.entryId, item.startedAt || null]),
  });
  return crypto.createHash('sha256').update(value).digest('hex');
}

// ------------------------------------------------------------------ réseau local
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  const score = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => score(a.address) - score(b.address));
}
function phoneBase() {
  if (settings.baseUrl) return settings.baseUrl.replace(/\/$/, '');
  const ip = (lanAddresses()[0] || {}).address || 'localhost';
  return `http://${ip}:${PORT}`;
}

function normalizeBaseUrl(value) {
  if (value == null || String(value).trim() === '') return null;
  let url;
  try { url = new URL(String(value).trim()); }
  catch { throw new Error('Adresse invalide : indique une origine HTTPS, par exemple https://chant.exemple.fr.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Indique seulement l’adresse de base, sans chemin, paramètres ni identifiants.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const parts = host.split('.').map(Number);
  const privateIp = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 169 && parts[1] === 254));
  if (url.protocol === 'http:' && host !== 'localhost' && host !== '::1' && !privateIp) {
    throw new Error('Une adresse accessible depuis Internet doit utiliser HTTPS.');
  }
  if (url.protocol === 'https:' && (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.lan') || host === '::1' || privateIp)) {
    throw new Error('Pour les mobiles sans Wi-Fi, utilise un vrai nom de domaine public HTTPS.');
  }
  return url.origin;
}

// ------------------------------------------------------------------ HTTP
const PUB = path.join(__dirname, 'public');
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const sendFile = (res, file, type) => fs.readFile(path.join(PUB, file), (err, buf) => err ? send(res, 404, 'Introuvable', 'text/plain') : send(res, 200, buf, type));

function readBody(req, limit = 900 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Trop volumineux')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('JSON invalide')); } });
    req.on('error', reject);
  });
}

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return req.socket.localPort === PORT && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1');
}
function isStaff(req, u) {
  // Le tunnel arrive depuis 127.0.0.1 : la prise publique reste interdite au bar,
  // même avec la clé. Sinon son proxy serait pris pour un navigateur local.
  if (req.socket.localPort === PUBLIC_PORT) return false;
  const supplied = u.searchParams.get('key') || req.headers['x-staff-key'];
  if (typeof supplied !== 'string') return false;
  const actual = Buffer.from(STAFF_KEY), candidate = Buffer.from(supplied);
  return candidate.length === actual.length && crypto.timingSafeEqual(candidate, actual);
}

function decodePhoto(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 400 * 1024) return null;
  return { type: m[1], buf };
}

function tableByAccess(id, secret) {
  const key = TableAccess.key(id);
  if (!access.verify(key, secret)) {
    const e = new Error('Lien de table invalide ou périmé. Scanne le QR code affiché à ta table.');
    e.code = 'TABLE_ACCESS'; throw e;
  }
  const t = sched.table(key, false);
  if (!t) {
    const e = new Error('Cette table n’est plus ouverte.'); e.code = 'TABLE_CLOSED'; throw e;
  }
  return t;
}

function soloCookieHash(req) {
  const raw = String(req.headers.cookie || '').split(';').map(part => part.trim())
    .find(part => part.startsWith(`${SOLO_COOKIE}=`))?.slice(SOLO_COOKIE.length + 1);
  if (!raw || !/^[A-Za-z0-9_-]{32}$/.test(raw)) return null;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function soloDeviceOwner(req) {
  const hash = soloCookieHash(req);
  if (!hash) return null;
  return [...sched.people.values()].find(person =>
    sched.table(person.tableId, false)?.individual &&
    Array.isArray(person.soloDeviceHashes) && person.soloDeviceHashes.includes(hash)) || null;
}

function soloDeviceError(code) {
  const error = new Error(code === 'SOLO_DEVICE_USED' ?
    'Ce téléphone gère déjà une personne dans « En solo ». Chacun utilise son propre téléphone.' :
    'Ce téléphone ne gère pas cette personne. Demande au bar un code de reprise si tu as changé de téléphone.');
  error.code = code;
  return error;
}

function requireSoloControl(req, person) {
  if (sched.table(person.tableId, false)?.individual && soloDeviceOwner(req)?.id !== person.id) {
    throw soloDeviceError('SOLO_DEVICE_ACCESS');
  }
}

function bindSoloDevice(req, res, person) {
  const value = crypto.randomBytes(24).toString('base64url');
  const hash = crypto.createHash('sha256').update(value).digest('hex');
  person.soloDeviceHashes = [...new Set([...(person.soloDeviceHashes || []), hash])];
  res.setHeader('Set-Cookie', `${SOLO_COOKIE}=${value}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax${req.socket.localPort === PUBLIC_PORT ? '; Secure' : ''}`);
}

function personAtTable(body) {
  const t = tableByAccess(body.table, body.access);
  const p = sched.people.get(String(body.personId || ''));
  if (!p || p.tableId !== t.id) {
    const e = new Error('Chanteur inconnu à cette table.'); e.code = 'NO_PERSON'; throw e;
  }
  if (p.withdrawnAt) {
    const e = new Error('Cette personne a été marquée partie. Demande au bar de la réactiver.');
    e.code = 'PERSON_LEFT'; throw e;
  }
  if (!body.token || body.token !== p.token) {
    const e = new Error('Ce téléphone ne gère pas ce chanteur. Demande-lui son code de partage, ou vois avec le bar.');
    e.code = 'PERSON_ACCESS'; throw e;
  }
  return p;
}

function createPersonShareCode(p) {
  const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  const expiresAt = Date.now() + 10 * 60 * 1000;
  personShareCodes.set(p.id, { hash: crypto.createHash('sha256').update(code).digest(), expiresAt, attempts: 0 });
  return { code, expiresAt };
}

function claimPerson(body, req, res) {
  const t = tableByAccess(body.table, body.access);
  const p = sched.people.get(String(body.personId || ''));
  if (!p || p.tableId !== t.id || p.withdrawnAt) throw new Error('Chanteur indisponible à cette table.');
  if (t.individual) {
    const owner = soloDeviceOwner(req);
    if (owner && owner.id !== p.id) throw soloDeviceError('SOLO_DEVICE_USED');
  }
  const saved = personShareCodes.get(p.id);
  if (!saved || Date.now() > saved.expiresAt || saved.attempts >= 5) {
    personShareCodes.delete(p.id);
    throw new Error('Code de partage expiré. Demande un nouveau code au chanteur ou au bar.');
  }
  saved.attempts++;
  const input = String(body.code || '').trim();
  const digest = crypto.createHash('sha256').update(input).digest();
  if (!/^[0-9]{4}$/.test(input) || !crypto.timingSafeEqual(saved.hash, digest)) {
    if (saved.attempts >= 5) personShareCodes.delete(p.id);
    throw new Error('Code de partage incorrect.');
  }
  personShareCodes.delete(p.id);
  // Une reprise transfère la gestion : l'ancien téléphone perd immédiatement
  // le droit de modifier les chansons de cette personne.
  sched.byToken.delete(p.token);
  p.token = crypto.randomBytes(16).toString('hex');
  sched.byToken.set(p.token, p.id);
  if (t.individual) bindSoloDevice(req, res, p);
  sched.note(`${p.name} est désormais géré depuis un autre téléphone`, 'info');
  return { id: p.id, token: p.token };
}

function claimPersonDurably(body, req, res) {
  const id = String(body.personId || '');
  const person = sched.people.get(id);
  const code = personShareCodes.get(id);
  const attempts = code?.attempts;
  const oldToken = person?.token;
  const oldDeviceHashes = person?.soloDeviceHashes?.slice();
  const oldLog = sched.log.slice();
  const oldVersion = sched.version;
  const hadCookie = res.hasHeader('Set-Cookie');
  const oldCookie = res.getHeader('Set-Cookie');
  // Un code erroné continue de compter comme tentative. Le retour arrière
  // ci-dessous n'a lieu qu'après un code valide et une erreur de sauvegarde.
  const result = claimPerson(body, req, res);
  try {
    saveNight({ required: true });
  } catch (error) {
    sched.byToken.delete(person.token);
    person.token = oldToken;
    sched.byToken.set(oldToken, person.id);
    if (oldDeviceHashes) person.soloDeviceHashes = oldDeviceHashes;
    else delete person.soloDeviceHashes;
    if (code) { code.attempts = attempts; personShareCodes.set(id, code); }
    sched.log = oldLog;
    sched.version = oldVersion;
    if (hadCookie) res.setHeader('Set-Cookie', oldCookie);
    else res.removeHeader('Set-Cookie');
    throw error;
  }
  return result;
}

function chooseFor(p, song, mode) {
  const songId = Number(song?.songId);
  if ([...(pending && pending.sel.ids.includes(p.id) ? [pending.sel.song] : []),
    ...tracked.filter(tr => tr.sel.ids.includes(p.id)).map(tr => tr.sel.song)]
    .some(s => s.songId === songId)) {
    const e = new Error('Cette chanson est déjà envoyée à KaraFun pour ce chanteur.');
    e.code = 'ALREADY_IN_KARAFUN'; throw e;
  }
  sched.chooseSong(p, song, mode);
  sync();
}

function confirmPresence(p) {
  if (sched.opts.requirePresence) {
    const candidate = presenceCandidate();
    const { current } = analyze();
    const currentOwner = tracked.find(tr => isOnStage(tr, current));
    if (!candidate?.ids.includes(p.id) || currentOwner?.sel.ids.includes(p.id)) {
      throw new Error('La présence sera demandée quand ce chanteur sera le prochain à passer.');
    }
  }
  sched.confirm(p);
  sync();
}

function catalog() {
  if (DEMO || !CODE) throw new Error('Catalogue KaraFun indisponible en mode démo ou sans code.');
  return new Catalog({ base: bridge?.base || 'https://www.karafun.fr', code: CODE });
}

function clearQueue() {
  const { current, upcoming } = analyze();
  const removedLocalSongs = [...sched.people.values()].reduce((sum, p) => sum + sched.songsOf(p).length, 0);
  const pendingCancelled = !!pending;
  if (pending) pending.cancelled = true;
  for (const tr of tracked) {
    if (!isOnStage(tr, current)) {
      tr.cancelled = true;
      tr.removeRequestedAt = 0;
    }
  }
  const otherKaraFunSongs = upcoming.filter(item =>
    !tracked.some(tr => String(tr.queueId) === String(item.queueId))).length;
  for (const p of sched.people.values()) {
    p.song = null;
    p.backlog = [];
    p.over = 0;
    p.held = 0;
  }
  sched._refreshDuetViews();
  sched.Q = [];
  sched.roundGroups.clear();
  sched.roundPeople.clear();
  sched.invalidateManualOrder();
  sched.duetCooldowns.clear();
  sched.releaseNext();
  settings.queueClearPending = true;
  battleVote.reset();
  sched.note('Le bar a vidé toutes les chansons en attente ; les tables, accès et passages précédents sont conservés.', 'staff');
  // Écrire les deux générations avant toute commande distante : un crash ne
  // doit jamais recréer une file que le bar a décidé d'effacer.
  saveNight({ required: true, replaceBoth: true });
  if (bridge?.ready) sync();
  return { ok: true, removedLocalSongs, pendingCancelled,
    currentStillPlaying: !!current,
    removalPending: tracked.filter(tr => tr.cancelled).length,
    otherKaraFunSongs, awaitingKaraFun: !!settings.queueClearPending };
}

function clearEvening() {
  const { current, upcoming } = analyze();
  // Même pendant une reconnexion, chaque titre envoyé reste sous suivi. On ne
  // connaît alors pas la file distante : le retrait sera tenté dès son retour.
  const toRemove = tracked.filter(tr => !tr.startedAt && !isOnStage(tr, current));
  let removalErrors = 0;
  let removalRequests = 0;
  for (const tr of toRemove) {
    tr.cancelled = true;
    tr.removeRequestedAt = 0;
    if (bridge?.ready) {
      try { bridge.remove(tr.queueId); removalRequests++; tr.removeRequestedAt = Date.now(); }
      catch (error) { removalErrors++; appLog(`Retrait KaraFun non confirmé au reset : ${error.message}`); }
    }
  }
  // Un envoi encore sans accusé reste suivi uniquement pour pouvoir le retirer
  // s'il apparaît après la remise à zéro.
  if (pending) pending.cancelled = true;
  tracked = tracked.filter(tr => tr.cancelled || tr.startedAt || isOnStage(tr, current));
  for (const tableId of sched.tables.keys()) access.revoke(tableId);
  sched.tables.clear();
  sched.people.clear();
  sched.byToken.clear();
  sched.Q = [];
  sched.lastGroup = null;
  sched.roundGroups.clear();
  sched.roundPeople.clear();
  sched.invalidateManualOrder();
  sched.tableServeCounts.clear();
  sched.duetCooldowns.clear();
  sched.releaseNext();
  sched.slotSamples = [];
  sched.log = [];
  personShareCodes.clear();
  battleVote.reset();
  ensureSoloGroup();
  settings.autoPlay = false;
  if (tracked.length || pending) settings.auto = false;
  sched.note('Nouvelle soirée : anciens accès effacés et nouvel accès « En solo » créé.', 'staff');
  saveNight({ required: true, replaceBoth: true });
  saveTables();
  // Les photos ne sont plus nécessaires après deux instantanés sans personnes.
  try { for (const filename of fs.readdirSync(PHOTO_DIR)) fs.unlinkSync(path.join(PHOTO_DIR, filename)); }
  catch (_) { /* nettoyage différé : aucune photo n'est encore visible */ }
  return { ok: true, removalRequests,
    removalErrors, currentStillPlaying: !!current,
    otherKaraFunSongs: upcoming.filter(item => !tracked.some(tr => String(tr.queueId) === String(item.queueId))).length,
    removalPending: toRemove.length };
}

const handlers = {
  // ---------------- clients
  'POST /api/join': async (req, res, body) => {
    const t = tableByAccess(body.table, body.access);
    if (t.individual && soloDeviceOwner(req)) throw soloDeviceError('SOLO_DEVICE_USED');
    if (t.headcount == null) {
      const e = new Error('Le bar doit d’abord indiquer le nombre de personnes à cette table.');
      e.code = 'NEED_HEADCOUNT'; throw e;
    }
    const photo = decodePhoto(body.photo);
    const p = sched.join({ tableId: t.id, name: body.name, photo });
    if (t.individual) bindSoloDevice(req, res, p);
    sync();
    return { token: p.token, id: p.id };
  },
  'POST /api/song': async (req, res, body, me) => { chooseFor(me, body.song, body.mode || 'replace'); return { ok: true }; },
  'POST /api/table/person': async (req, res, body) => {
    const t = tableByAccess(body.table, body.access);
    if (t.individual && soloDeviceOwner(req)) throw soloDeviceError('SOLO_DEVICE_USED');
    if (t.headcount == null) { const e = new Error('Effectif de la table à définir au bar.'); e.code = 'NEED_HEADCOUNT'; throw e; }
    const p = sched.join({ tableId: t.id, name: body.name });
    if (t.individual) bindSoloDevice(req, res, p);
    sync(); return { id: p.id, token: p.token };
  },
  'POST /api/table/person/share': async (req, res, body) => createPersonShareCode(personAtTable(body)),
  'POST /api/table/person/claim': async (req, res, body) => claimPersonDurably(body, req, res),
  'POST /api/table/person/rename': async (req, res, body) => {
    const p = personAtTable(body);
    sched.rename(p, body.name); sync(); return { ok: true };
  },
  'POST /api/table/confirm': async (req, res, body) => {
    const p = personAtTable(body);
    confirmPresence(p); return { ok: true };
  },
  'POST /api/table/song': async (req, res, body) => {
    const p = personAtTable(body);
    chooseFor(p, body.song, body.mode || 'append'); return { ok: true };
  },
  'POST /api/table/song/remove': async (req, res, body) => {
    const p = personAtTable(body);
    if (pending?.sel.ids[0] === p.id && pending.sel.song.entryId === String(body.entryId)) {
      throw new Error('Ce titre est en cours d’envoi à KaraFun. Réessaie dans un instant.');
    }
    sched.removeSong(p, body.entryId); sync(); return { ok: true };
  },
  'POST /api/table/song/reorder': async (req, res, body) => {
    const p = personAtTable(body);
    const songs = sched.songsOf(p);
    const from = songs.findIndex(s => s.entryId === String(body.entryId || ''));
    const to = Number(body.toIndex);
    if (pending?.sel.ids[0] === p.id && (from === 0 || to === 0)) {
      throw new Error('Le prochain titre est en cours d’envoi à KaraFun. Réordonne les suivants ou réessaie dans un instant.');
    }
    sched.reorderSongs(p, body.entryId, body.toIndex); sync(); return { ok: true };
  },
  'POST /api/table/duet': async (req, res, body) => {
    const p = personAtTable(body);
    sched.inviteDuet(p, String(body.partnerId || ''), body.song); sync(); return { ok: true };
  },
  'POST /api/table/duet/answer': async (req, res, body) => {
    const p = personAtTable(body);
    sched.answerDuet(p, !!body.accept, body.entryId); sync(); return { ok: true };
  },
  'POST /api/table/duet/cancel': async (req, res, body) => {
    const p = personAtTable(body);
    sched.cancelDuet(p, body.entryId); sync(); return { ok: true };
  },
  'POST /api/table/battle/propose': async (req, res, body) => {
    const p = personAtTable(body);
    const eligiblePersonIds = [...sched.people.values()].filter(person => !person.withdrawnAt).map(person => person.id);
    const battle = battleVote.propose({ personId: p.id, personName: p.name, eligiblePersonIds,
      songs: certifiedBattleSongs(body.songs), proposerChoice: body.proposerChoice });
    return { ok: true, battle };
  },
  'POST /api/table/battle/vote': async (req, res, body) => {
    const p = personAtTable(body);
    const battle = battleVote.vote({ personId: p.id, choice: body.choice });
    return { ok: true, battle };
  },
  'POST /api/duet': async (req, res, body, me) => { sched.inviteDuet(me, body.partnerId, body.song); sync(); return { ok: true }; },
  'POST /api/duet/answer': async (req, res, body, me) => { sched.answerDuet(me, !!body.accept, body.entryId); sync(); return { ok: true }; },
  'POST /api/duet/cancel': async (req, res, body, me) => { sched.cancelDuet(me, body.entryId); sync(); return { ok: true }; },
  'POST /api/confirm': async (req, res, body, me) => { confirmPresence(me); return { ok: true }; },
  'POST /api/give': async (req, res, body, me) => { sched.giveSpot(me, body.to); sync(); return { ok: true }; },
  'POST /api/leave': async (req, res, body, me) => { sched.leave(me); sync(); return { ok: true }; },
  'POST /api/photo': async (req, res, body, me) => { me.photo = decodePhoto(body.photo); sched.version++; return { ok: true }; },

  // ---------------- bar
  'POST /api/staff/connect': async (req, res, body) => { CODE = String(body.code || '').replace(/\D/g, ''); connectKaraFun(); return { ok: true }; },
  'POST /api/staff/settings': async (req, res, body) => {
    const nextTableRotation = 'tableRotation' in body ? !!body.tableRotation : sched.opts.tableRotation;
    const nextWeighted = 'weightedTables' in body ? !!body.weightedTables : sched.opts.weightedTables;
    if (nextWeighted && !nextTableRotation) throw new Error('Active d’abord la rotation des tables.');
    // Valider toute la requête avant de changer un réglage : un HTTP 400 ne
    // doit jamais modifier silencieusement l'ordre de passage.
    const nextBaseUrl = 'baseUrl' in body ? normalizeBaseUrl(body.baseUrl) : settings.baseUrl;
    const nextPushDelay = 'pushDelaySec' in body ? Number(body.pushDelaySec) : settings.pushDelaySec;
    if (!Number.isInteger(nextPushDelay) || nextPushDelay < 0 || nextPushDelay > 180) {
      throw new Error('Le délai d’envoi doit être entre 0 et 180 secondes.');
    }
    const nextPlayDelay = 'playDelaySec' in body ? Number(body.playDelaySec) : settings.playDelaySec;
    if (!Number.isInteger(nextPlayDelay) || nextPlayDelay < 0 || nextPlayDelay > 30) {
      throw new Error('La pause avant lecture doit être entre 0 et 30 secondes.');
    }
    const nextBattleCooldown = 'battleCooldownMin' in body ? Number(body.battleCooldownMin) : null;
    if (nextBattleCooldown !== null && (!Number.isInteger(nextBattleCooldown) ||
        nextBattleCooldown < 1 || nextBattleCooldown > 120)) {
      throw new Error('Le délai entre Battles doit être de 1 à 120 minutes.');
    }
    if (body.auto && recoveredPending) throw new Error('Vérifie d’abord l’envoi interrompu dans KaraFun.');
    if (body.auto && persistenceError) throw new Error('Sauvegarde indisponible : l’envoi automatique reste suspendu.');
    if (body.auto && bridge?.permissions?.addToQueue === false) {
      throw new Error('KaraFun refuse l’ajout de titres au compte FileKaraoke. Vérifie ses permissions.');
    }
    if (nextTableRotation !== sched.opts.tableRotation || nextWeighted !== sched.opts.weightedTables) {
      sched.opts.tableRotation = nextTableRotation;
      sched.opts.weightedTables = nextWeighted;
      sched.tableServeCounts.clear();
      sched.roundGroups.clear();
      sched.roundPeople.clear();
      sched.invalidateManualOrder();
      sched.note(`Rotation : ${nextWeighted ? 'tables pondérées par les chanteurs prêts' : nextTableRotation ? 'tables en priorité' : 'personnes en priorité'}`, 'staff');
    }
    if ('auto' in body) {
      settings.auto = !!body.auto;
    }
    if ('autoPlay' in body) settings.autoPlay = !!body.autoPlay;
    if ('baseUrl' in body) { settings.baseUrl = nextBaseUrl; saveTables(); }
    if ('gap' in body) sched.opts.gap = Math.max(1, Math.min(10, parseInt(body.gap, 10) || 4));
    if ('cap' in body) sched.opts.cap = Math.max(1, Math.min(50, parseInt(body.cap, 10) || 2));
    if ('requirePresence' in body) sched.opts.requirePresence = !!body.requirePresence;
    settings.pushDelaySec = nextPushDelay;
    settings.playDelaySec = nextPlayDelay;
    if (nextBattleCooldown !== null) battleVote.setCooldownMinutes(nextBattleCooldown);
    sched.version++; sync();
    return { ok: true };
  },
  'POST /api/staff/table': async (req, res, body) => {
    const id = TableAccess.key(body.id);
    const existing = sched.table(id, false);
    if (id === 'Comptoir' && 'individual' in body && !body.individual) {
      throw new Error('Le groupe En solo garde ses tours individuels pendant toute la soirée.');
    }
    if (existing && 'individual' in body && existing.individual !== !!body.individual &&
        sched.tableSingers(id).length) {
      throw new Error('Le mode individuel ne peut pas changer après l’inscription de chanteurs. Crée un autre groupe.');
    }
    const t = existing || sched.table(id);
    if (!access.get(t.id)) access.issue(t.id);
    if (body.headcount) sched.setHeadcount(t.id, body.headcount, 'staff');
    if ('individual' in body) t.individual = !!body.individual;
    saveTables();
    return { ok: true };
  },
  'POST /api/staff/table/rename': async (req, res, body) => {
    const t = sched.renameTable(TableAccess.key(body.tableId), body.name);
    saveTables(); sync(); return { ok: true, table: { id: t.id, name: t.name } };
  },
  'POST /api/staff/tables-create': async (req, res, body) => {
    const n = Math.max(1, Math.min(60, parseInt(body.count, 10) || 10));
    for (let i = 1; i <= n; i++) {
      const t = sched.table(String(i));
      if (!access.get(t.id)) access.issue(t.id);
      if (body.headcount) sched.setHeadcount(t.id, body.headcount, 'staff');
    }
    const comptoir = sched.table('Comptoir');
    if (!access.get(comptoir.id)) access.issue(comptoir.id);
    sched.version++;
    saveTables();
    return { ok: true };
  },
  'POST /api/staff/table-left': async (req, res, body) => {
    const tableId = String(body.id);
    if (tableId === 'Comptoir') {
      throw new Error('Le groupe En solo reste disponible. Termine la soirée pour renouveler son QR.');
    }
    const people = sched.tableSingers(tableId);
    const ids = new Set(people.map(person => person.id));
    const { current } = analyze();
    const upcomingTracks = tracked.filter(tr => !isOnStage(tr, current) && tr.sel.ids.some(id => ids.has(id)));
    if (pending?.sel.ids.some(id => ids.has(id))) pending.cancelled = true;
    sched.tableLeft(tableId);
    access.revoke(tableId);
    saveTables();
    for (const tr of upcomingTracks) {
      tr.cancelled = true;
      tr.removeRequestedAt = Date.now();
      try { bridge?.remove(tr.queueId); }
      catch (error) { sched.note(`Retrait KaraFun à vérifier : ${error.message}`, 'error'); }
    }
    sync();
    return { ok: true, removedFromKaraFun: upcomingTracks.length, pendingCancelled: !!pending?.cancelled };
  },
  'POST /api/staff/tables-clear': async (req, res, body) => {
    if (body.confirmation !== 'SUPPRIMER TOUTES LES TABLES') {
      throw new Error('Confirme la remise à zéro de toutes les tables.');
    }
    return clearEvening();
  },
  'POST /api/staff/queue-clear': async (req, res, body) => {
    if (body.confirmation !== 'VIDER TOUTES LES CHANSONS') {
      throw new Error('Confirme le retrait de toutes les chansons en attente.');
    }
    return clearQueue();
  },
  'POST /api/staff/table-rotate': async (req, res, body) => {
    const t = sched.table(String(body.id), false);
    if (!t) throw new Error('Table inconnue.');
    access.issue(t.id); saveTables(); sched.note(`Nouveau QR pour ${t.name} : ancien lien désactivé`, 'staff');
    return { url: access.url(phoneBase(), t.id) };
  },
  'POST /api/staff/move': async (req, res, body) => {
    const provisional = pending?.sel || null;
    const excluded = provisional ? (provisional.consumedIds || provisional.ids) : [];
    const personId = String(body.personId || '');
    const toIndex = Number(body.toIndex);
    const priority = body.priority === true && toIndex === 0;
    const visible = sched.presenceView(excluded, provisional).filter(v => !v.future);
    const nativeAhead = analyze().upcoming.length + (pending ? 1 : 0);
    const from = visible.findIndex(v => v.ids[0] === personId);
    if (priority && from === 0) {
      throw new Error(nativeAhead ?
        `Ce titre est déjà le prochain passage libre. ${nativeAhead} titre${nativeAhead > 1 ? 's sont' : ' est'} déjà chargé${nativeAhead > 1 ? 's' : ''} dans KaraFun devant lui.` :
        'Ce titre est déjà le prochain passage libre.');
    }
    if (from >= 0 && from === toIndex) {
      return { ok: true, changed: false, message: 'Ce titre est déjà à cette place.' };
    }
    const nativeBefore = priorityNativeFingerprint();
    if (sched.manualChanges.length && !sched.canUndoManualChange(nativeBefore)) sched.manualChanges = [];
    const before = sched.manualOverrideState();
    sched.staffMove(personId, toIndex, excluded, provisional);
    sync();
    const nativeAfter = priorityNativeFingerprint();
    if (nativeBefore === nativeAfter) sched.recordManualChange({
      kind: priority ? 'priority' : 'move', personId,
      name: visible[from]?.name || sched.people.get(personId)?.name || 'ce chanteur',
      from: from + 1, to: toIndex + 1, before, native: nativeAfter,
    });
    else sched.manualChanges = [];
    return { ok: true, firstFreePosition: nativeAhead + 1,
      message: priority && nativeAhead ?
        `Passage avancé à la première place libre, après ${nativeAhead} titre${nativeAhead > 1 ? 's' : ''} déjà chargé${nativeAhead > 1 ? 's' : ''} dans KaraFun.` : null };
  },
  'POST /api/staff/manual-change-undo': async (req, res, body) => {
    if (!body.id) throw new Error('Indique le changement manuel à annuler.');
    sched.undoLastManualChange(String(body.id), priorityNativeFingerprint());
    sync();
    return { ok: true };
  },
  'POST /api/staff/priority-undo': async () => {
    if (sched.manualChanges.at(-1)?.kind !== 'priority') {
      throw new Error('La dernière intervention du bar n’est pas une priorité.');
    }
    sched.undoLastManualChange(null, priorityNativeFingerprint());
    sync();
    return { ok: true };
  },
  'POST /api/staff/queue-recalculate': async () => {
    const count = sched.undoAllManualChanges(priorityNativeFingerprint());
    sync();
    return { ok: true, undone: count };
  },
  'POST /api/staff/remove': async (req, res, body) => { sched.staffRemove(body.personId); sync(); return { ok: true }; },
  'POST /api/staff/person/identify': async (req, res, body) => {
    const p = sched.staffIdentify(body.personId, body.note, !!body.verified);
    return { ok: true, personId: p.id };
  },
  'POST /api/staff/person/share': async (req, res, body) => {
    const p = sched.people.get(String(body.personId || ''));
    if (!p || p.withdrawnAt) throw new Error('Chanteur inconnu ou parti.');
    return createPersonShareCode(p);
  },
  'POST /api/staff/person/leave': async (req, res, body) => {
    const p = sched.people.get(String(body.personId || ''));
    if (!p) throw new Error('Chanteur inconnu.');
    const { current } = analyze();
    const upcomingTracks = tracked.filter(tr => tr.sel.ids.includes(p.id) && !isOnStage(tr, current));
    sched.leave(p);
    if (pending?.sel.ids.includes(p.id)) pending.cancelled = true;
    for (const tr of upcomingTracks) {
      tr.cancelled = true;
      tr.removeRequestedAt = Date.now();
      try { bridge?.remove(tr.queueId); }
      catch (error) { sched.note(`Retrait KaraFun à vérifier : ${error.message}`, 'error'); }
    }
    sync();
    return { ok: true, removedFromKaraFun: upcomingTracks.length, pendingCancelled: !!pending?.cancelled };
  },
  'POST /api/staff/person/reactivate': async (req, res, body) => {
    const p = sched.people.get(String(body.personId || ''));
    if (!p || !p.withdrawnAt) throw new Error('Cette personne n’est pas marquée partie.');
    const t = sched.table(p.tableId, false);
    if (!t) throw new Error('La table n’est plus ouverte.');
    if (sched.tableSingers(t.id).filter(person => !person.withdrawnAt).length >= t.headcount) {
      throw new Error('La table est pleine. Ajuste son effectif avant de réactiver cette personne.');
    }
    p.withdrawnAt = null;
    sched.note(`${p.name} revient à ${t.name} ; son historique de passages est conservé`, 'staff');
    return { ok: true };
  },
  'POST /api/staff/duo-mark': async (req, res, body) => {
    const tr = tracked.find(x => String(x.queueId) === String(body.queueId));
    if (!tr || tr.sel.ids.length !== 1) throw new Error('Choisis un passage solo encore visible dans KaraFun.');
    const partnerId = String(body.partnerId || '');
    if (tracked.some(x => x !== tr && x.sel.ids.includes(partnerId)) ||
        (pending && pending.sel.ids.includes(partnerId))) throw new Error('Ce partenaire a déjà une chanson envoyée à KaraFun.');
    const partner = sched.staffCountPartner(tr.sel.ids[0], partnerId);
    tr.sel.ids.push(partner.id);
    tr.sel.names.push(partner.name);
    tr.sel.kind = 'duo';
    const ownerTable = sched.table(sched.people.get(tr.sel.ids[0]).tableId);
    const partnerTable = sched.table(partner.tableId);
    tr.sel.label = `${tr.sel.names.join(' & ')} · ${ownerTable.name}${ownerTable.id === partnerTable.id ? '' : ` + ${partnerTable.name}`}`;
    sync(); return { ok: true };
  },
  'POST /api/staff/battle/resolve': async (req, res, body) => {
    const battle = body.outcome === 'finished' ? battleVote.finishManual() :
      battleVote.resolve({ outcome: body.outcome });
    return { ok: true, battle };
  },
  'POST /api/staff/reconcile-pending': async () => {
    if (!recoveredPending) throw new Error('Aucun envoi interrompu à vérifier.');
    if (!bridge?.ready) throw new Error('Attends la reconnexion à KaraFun pour vérifier sa file.');
    if (bridge.permissions?.addToQueue === false) throw new Error('Donne d’abord au compte FileKaraoke le droit d’ajouter des titres.');
    sync();
    if (pending) {
      const { inspectRecoveredPending } = require('./night-state');
      const result = inspectRecoveredPending(pending, bridge.queue);
      if (result.state === 'ambiguous') throw new Error('Plusieurs titres correspondants dans KaraFun : retire le doublon manuellement avant de reprendre.');
      if (result.state === 'found') throw new Error('Un titre correspondant est encore en cours de rapprochement. Réessaie dans un instant.');
      pending = null;
    }
    recoveredPending = false;
    settings.auto = true;
    sched.note('Envoi interrompu vérifié par le bar ; envoi automatique repris.', 'staff');
    sync();
    return { ok: true };
  },
  'POST /api/staff/shutdown': async () => { setTimeout(stopHelper, 150); return { ok: true }; },
  'POST /api/staff/kf': async (req, res, body) => {
    if (!bridge) throw new Error('KaraFun non connecté');
    if (body.action === 'play') {
      const status = battleVote.automation?.status;
      if (status === 'after') {
        if (!bridge.ready) throw new Error('KaraFun est déconnecté. Reconnecte-le avant de reprendre après la Battle.');
        const upcoming = analyze().upcoming;
        const nextNative = !!upcoming[0] && !isBattleItem(upcoming[0]);
        const nextPending = !!pending && !pending.cancelled && !recoveredPending;
        const nextLocal = nextPending || sched.readyView().some(turn => !turn.future && turn.song);
        if (!nextNative && !nextLocal) {
          throw new Error('Aucun titre suivant. Ajoute d’abord une chanson, puis lance la reprise.');
        }
        if (!nextNative && !nextPending && !settings.auto) {
          throw new Error('Active l’envoi automatique à KaraFun avant de lancer le titre suivant.');
        }
        if (!nextNative && !nextPending && (recoveredPending || bridge.permissions?.addToQueue === false)) {
          throw new Error('KaraFun ne peut pas recevoir ce titre. Vérifie l’envoi interrompu et ses droits avant de reprendre.');
        }
        battleVote.updateAutomation('resuming');
        sched.note('Le bar lance manuellement le premier titre après la Battle.', 'battle');
        sync();
      } else if (['sending', 'queued', 'playing', 'manual', 'failed'].includes(status)) {
        throw new Error('La Battle attend le bar : vérifie KaraFun et laisse les téléphones rejoindre avant de lancer.');
      } else bridge.play();
    }
    else if (body.action === 'next') bridge.next();
    else if (body.action === 'reconnect') connectKaraFun();
    else if (body.action === 'absent') {
      const tr = tracked.find(x => x.queueId === body.queueId && !x.startedAt);
      if (!tr) throw new Error('Cette chanson a déjà commencé ou n\'est pas de la file');
      tr.absent = true;
      bridge.remove(tr.queueId);
    } else if (body.action === 'remove') bridge.remove(body.queueId);
    else if (body.action === 'test-add') bridge.add(body.songId, 'Test file karaoké');
    else throw new Error('Action inconnue');
    setTimeout(sync, 300);
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (req.method === 'GET') {
      if (p === '/' ) {
        if (!isLocal(req) || req.socket.localPort === PUBLIC_PORT) return send(res, 403, 'Scanne le QR code de ta table.', 'text/plain; charset=utf-8');
        res.writeHead(302, { Location: `/staff?key=${STAFF_KEY}`, 'Referrer-Policy': 'no-referrer' }); return res.end();
      }
      let m = /^\/t\/([^/]+)\/([A-Za-z0-9_-]{22})\/?$/.exec(p);
      if (m) {
        tableByAccess(decodeURIComponent(m[1]), m[2]);
        return sendFile(res, 'client.html', 'text/html; charset=utf-8');
      }
      if (/^\/t\/[^/]+\/?$/.test(p)) return send(res, 403, 'Scanne le QR code de ta table.', 'text/plain; charset=utf-8');
      if (p === '/staff') { if (!isStaff(req, u)) return send(res, 403, 'Réservé au bar', 'text/plain; charset=utf-8'); return sendFile(res, 'staff.html', 'text/html; charset=utf-8'); }
      if (p === '/print') { if (!isStaff(req, u)) return send(res, 403, 'Réservé au bar', 'text/plain; charset=utf-8'); return sendFile(res, 'print.html', 'text/html; charset=utf-8'); }
      if (p === '/app.css') return sendFile(res, 'app.css', 'text/css; charset=utf-8');
      if (p === '/api/state') {
        const me = sched.person(u.searchParams.get('token') || '');
        if (me && !u.searchParams.has('table')) {
          requireSoloControl(req, me);
          const view = publicState(me, me.tableId);
          view.managedIds = [me.id];
          return send(res, 200, view);
        }
        const t = tableByAccess(u.searchParams.get('table'), u.searchParams.get('access'));
        let headerTokens = [];
        try {
          const parsed = JSON.parse(String(req.headers['x-person-tokens'] || '[]'));
          if (Array.isArray(parsed)) headerTokens = parsed.filter(token => typeof token === 'string');
        } catch (_) { /* Une liste mal formée ne donne aucun accès. */ }
        const soloOwner = t.individual ? soloDeviceOwner(req) : null;
        const owned = [...u.searchParams.getAll('token'), ...headerTokens].slice(0, 40).map(token => sched.person(token))
          .filter(person => person && person.tableId === t.id && (!t.individual || person.id === soloOwner?.id));
        const view = publicState(owned[0] || null, t.id);
        if (t.individual && soloOwner) {
          view.recoveryPeople = (view.recoveryPeople || []).filter(person => person.id === soloOwner.id);
        }
        view.managedIds = [...new Set(owned.map(person => person.id))];
        return send(res, 200, view);
      }
      if (p === '/api/staff/state') { if (!isStaff(req, u)) return send(res, 403, { error: 'Réservé au bar' }); return send(res, 200, staffState()); }
      if (p === '/api/duo/partners') {
        const table = tableByAccess(u.searchParams.get('table'), u.searchParams.get('access'));
        return send(res, 200, [...sched.people.values()].filter(person => !person.withdrawnAt)
          .map(person => ({ id: person.id, name: person.name, tableId: person.tableId,
            table: sched.table(person.tableId, false)?.name || person.tableId,
            sameTable: person.tableId === table.id })));
      }
      if (p === '/api/search') {
        const q = String(u.searchParams.get('q') || '').trim();
        if (q.length < 2) return send(res, 200, []);
        if (!bridge) return send(res, 503, { error: 'KaraFun non connecté' });
        try { return send(res, 200, rememberBattleSongs(await bridge.search(q))); }
        catch (e) { return send(res, 502, { error: `Recherche KaraFun impossible : ${e.message}` }); }
      }
      if (p === '/api/catalog/categories' || p === '/api/catalog/highlights' || p === '/api/catalog/songs') {
        try {
          const c = catalog();
          if (p.endsWith('/categories')) return send(res, 200, await c.categories(u.searchParams.get('type')));
          if (p.endsWith('/highlights')) return send(res, 200, rememberBattleSongs(await c.highlights(u.searchParams.get('type'))));
          const page = await c.songs(u.searchParams.get('filter'), Number(u.searchParams.get('offset') || 0));
          rememberBattleSongs(page.songs);
          return send(res, 200, page);
        } catch (e) { return send(res, 502, { error: e.message }); }
      }
      m = /^\/photo\/([a-f0-9]+)$/.exec(p);
      if (m) { const pp = sched.people.get(m[1]); if (!pp || !pp.photo) return send(res, 404, ''); return send(res, 200, pp.photo.buf, pp.photo.type, { 'Cache-Control': 'max-age=60' }); }
      if (p === '/qr/staff.svg') {
        if (!isStaff(req, u)) return send(res, 403, 'Réservé au bar', 'text/plain; charset=utf-8');
        const target = `${phoneBase()}/staff?key=${STAFF_KEY}`;
        const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return send(res, 200, svg, 'image/svg+xml');
      }
      m = /^\/qr\/([^/]+)\.svg$/.exec(p);
      if (m) {
        if (!isStaff(req, u)) return send(res, 403, 'Réservé au bar', 'text/plain; charset=utf-8');
        const id = decodeURIComponent(m[1]);
        if (!sched.table(id, false) || !access.get(id)) return send(res, 404, 'QR inconnu', 'text/plain; charset=utf-8');
        const target = access.url(phoneBase(), id);
        const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return send(res, 200, svg, 'image/svg+xml');
      }
      return send(res, 404, 'Introuvable', 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST') {
      if (p === '/internal/shutdown') {
        if (!isLocal(req) || req.socket.localPort === PUBLIC_PORT || req.headers['x-helper-stop'] !== STOP_KEY) return send(res, 403, { error: 'Arrêt réservé à ce PC.' });
        send(res, 200, { ok: true }); setTimeout(stopHelper, 150); return;
      }
      const key = `POST ${p}`;
      const h = handlers[key];
      if (!h) return send(res, 404, { error: 'Introuvable' });
      if (p.startsWith('/api/staff/') && !isStaff(req, u)) return send(res, 403, { error: 'Réservé au bar' });
      const body = await readBody(req);
      let me = null;
      if (!p.startsWith('/api/staff/') && p !== '/api/join' && !p.startsWith('/api/table/')) {
        me = sched.person(body.token || '');
        if (!me) return send(res, 401, { error: 'Session inconnue : inscris-toi à nouveau.', code: 'NO_SESSION' });
        if (me.withdrawnAt) return send(res, 403, { error: 'Cette personne a été marquée partie. Demande au bar de la réactiver.', code: 'PERSON_LEFT' });
        requireSoloControl(req, me);
      }
      if (p.startsWith('/api/table/') && p !== '/api/table/person' && p !== '/api/table/person/claim') {
        const table = tableByAccess(body.table, body.access);
        if (table.individual) {
          const owner = soloDeviceOwner(req);
          if (!owner || owner.id !== String(body.personId || '')) throw soloDeviceError('SOLO_DEVICE_ACCESS');
        }
      }
      const out = await h(req, res, body, me);
      if (p !== '/api/table/person/claim') saveNight({ required: true });
      return send(res, 200, out || { ok: true });
    }
    send(res, 405, 'Méthode non gérée', 'text/plain');
  } catch (e) {
    send(res, ['TABLE_ACCESS', 'PERSON_ACCESS', 'SOLO_DEVICE_USED', 'SOLO_DEVICE_ACCESS'].includes(e.code) ? 403 : 400, { error: e.message, code: e.code || null });
  }
});
// Point d'entrée réservé au tunnel HTTPS. Lié uniquement à la boucle locale et
// privé de tous les droits du bar, même si le proxy vient de 127.0.0.1.
const publicServer = http.createServer(server.listeners('request')[0]);

// ------------------------------------------------------------------ démarrage
async function connectKaraFun() {
  if (!CODE) { appLog('Pas de code KaraFun : saisis-le sur la page du bar.'); return; }
  rememberCode();
  if (!bridge) {
    bridge = new KaraFunBridge({ logDir: LOG_DIR, bases: DEMO ? [fake.base] : undefined });
    bridge.on('change', () => setImmediate(sync));
  }
  appLog(`Connexion à KaraFun (code ${CODE})...`);
  bridge.connect(CODE);
}

async function main() {
  if (PUBLIC_PORT === PORT || !Number.isInteger(PUBLIC_PORT) || PUBLIC_PORT < 1 || PUBLIC_PORT > 65535) {
    throw new Error('Le port public doit être valide et différent de celui du bar.');
  }
  const previousNight = nightStore?.load();
  if (previousNight) {
    const recovered = restoreNight(previousNight, { scheduler: sched, access, settings,
      photoDir: PHOTO_DIR });
    pending = recovered.pending;
    tracked = recovered.tracked;
    recoveredPending = recovered.recoveredPending;
    appLog(`Soirée restaurée : ${sched.tables.size} tables, ${sched.people.size} personnes, ${sched.Q.length} tickets.`);
    if (recoveredPending) appLog('Envoi KaraFun interrompu : le bar doit vérifier la file avant de réactiver l’automatique.');
  } else loadTables();
  ensureSoloGroup();
  if (!DEMO && !sched.solverStatus().available) {
    appLog(`Solveur Timefold indisponible au démarrage : ${sched.solverStatus().fallbackLastError || 'cause inconnue'}. Rotation locale de secours.`);
  }
  saveNight({ required: true });
  if (DEMO) {
    const { startFakeKaraFun } = require('./fake-karafun');
    fake = await startFakeKaraFun({ port: PORT + 1001, code: '123456', songSeconds: SONG_SECONDS, log: appLog });
    CODE = fake.code;
    appLog(`Mode démo : faux KaraFun sur ${fake.base} (chansons de ${SONG_SECONDS} s)`);
  }
  server.listen(PORT, '0.0.0.0', () => {
    publicServer.listen(PUBLIC_PORT, '127.0.0.1', () => {
      const staffUrl = `http://localhost:${PORT}/staff?key=${STAFF_KEY}`;
      appLog('');
      appLog('=== File karaoké ===');
      appLog(`Page du bar (sur ce PC)        : ${staffUrl}`);
      appLog(`Adresse pour les téléphones    : QR secret à imprimer depuis ${staffUrl}`);
      appLog(`QR codes à imprimer            : http://localhost:${PORT}/print`);
      appLog(`Tunnel HTTPS (clients seulement) : http://127.0.0.1:${PUBLIC_PORT}`);
      appLog(`Clé du bar (autre appareil)    : ${STAFF_KEY}  (ex. ${phoneBase()}/staff?key=${STAFF_KEY})`);
      fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
      fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ pid: process.pid, port: PORT, secret: STOP_KEY }));
      appLog('Laisse cette fenêtre ouverte pendant la soirée. Ctrl+C pour arrêter.');
      appLog('');
      if (CODE) connectKaraFun();
      if (!NO_OPEN && process.platform === 'win32') spawn('cmd', ['/c', 'start', '', staffUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setInterval(sync, 2000);
      setInterval(() => battleVote.tick(), 2000);
    });
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') appLog(`Le port ${PORT} est déjà utilisé : le programme tourne peut-être déjà dans une autre fenêtre.`);
    else appLog(`Erreur serveur : ${e.message}`);
    process.exit(1);
  });
  publicServer.on('error', (e) => {
    appLog(`Port public ${PUBLIC_PORT} indisponible : ${e.message}`);
    process.exit(1);
  });
}

main().catch(e => { appLog(`Impossible de démarrer : ${e.message}`); process.exitCode = 1; });
