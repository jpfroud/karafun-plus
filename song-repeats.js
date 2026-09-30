'use strict';
// Titres en double : une chanson chantée il y a peu, ou déjà prévue dans la
// file. Ce n'est qu'une alerte : aucun ajout n'est refusé pour cette raison.

const DEFAULT_REPEAT_MIN = 45;
const PLAYED_LIMIT = 200;

// KaraFun propose parfois plusieurs versions d'un même titre sous des
// identifiants différents : « Bohemian Rhapsody (Live) » reste le même morceau
// pour la salle. Accents, casse, ponctuation et précisions entre parenthèses
// ou crochets sont ignorés.
function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Clé calculée une fois par titre : la normalisation coûte cher et la page
// du bar compare toute la file toutes les deux secondes.
function songKey(song) {
  if (!song) return null;
  const id = Number(song.songId);
  return { id: id > 0 ? id : null, title: normalize(song.title), artist: normalize(song.artist) };
}

function sameKey(a, b) {
  if (!a || !b) return false;
  if (a.id && a.id === b.id) return true;
  if (!a.title || a.title !== b.title) return false;
  // Même titre chez deux artistes (reprises) : deux chansons distinctes,
  // sauf si l'une des deux entrées ne précise pas l'artiste.
  return !a.artist || !b.artist || a.artist === b.artist;
}

const sameSong = (a, b) => sameKey(songKey(a), songKey(b));

// Ligne de file publique : titre dans `song` (fmtSong) ou à plat.
const songOf = line => line?.song || (line?.title ? line : null);

// Titres lancés dans la fenêtre, avec leur clé, du plus récent au plus ancien.
function recentPlays(played, now, windowMs) {
  if (!(windowMs > 0)) return [];
  return (played || []).filter(item => item && Number.isFinite(item.at) && now - item.at < windowMs)
    .sort((a, b) => b.at - a.at).map(item => ({ item, key: songKey(item) }));
}

function lastPlay(played, song, now, windowMs, recent = recentPlays(played, now, windowMs)) {
  const key = songKey(song);
  return recent.find(entry => sameKey(entry.key, key))?.item || null;
}

// Alerte pour la personne qui ajoute un titre. `entryId` désigne le titre
// qu'elle vient d'ajouter : il permet de dire si l'autre passage est avant.
function songNotice({ song, entryId = null, queue = [], played = [], now = Date.now(), windowMs = 0 }) {
  if (!song) return null;
  const recent = lastPlay(played, song, now, windowMs);
  const own = entryId ? queue.find(line => songOf(line)?.entryId === entryId) : null;
  const key = songKey(song);
  const queued = queue.filter(line => line !== own && sameKey(songKey(songOf(line)), key)).map(line => ({
    pos: line.pos, eta: line.eta || null, name: line.name || null,
    before: own ? line.pos < own.pos : null,
  }));
  if (!recent && !queued.length) return null;
  return {
    playedAt: recent ? recent.at : null,
    minutesAgo: recent ? Math.max(0, Math.floor((now - recent.at) / 60000)) : null,
    queued, position: own ? own.pos : null, windowMin: Math.round(windowMs / 60000),
  };
}

// Repère de la page du bar pour chaque ligne de la file : autres passages du
// même titre et dernière interprétation dans la fenêtre réglée.
// Seuls les titres de même identifiant ou de même titre normalisé peuvent
// correspondre : les regrouper évite de comparer chaque paire de la file.
function queueRepeats(queue, played, now = Date.now(), windowMs = 0) {
  const keys = queue.map(line => songKey(songOf(line)));
  const byId = new Map(), byTitle = new Map();
  const add = (map, value, index) => { if (value) (map.get(value) || map.set(value, []).get(value)).push(index); };
  keys.forEach((key, index) => { if (key) { add(byId, key.id, index); add(byTitle, key.title, index); } });
  const recent = recentPlays(played, now, windowMs);
  return keys.map((key, index) => {
    if (!key) return null;
    const matches = new Set([...(byId.get(key.id) || []), ...(byTitle.get(key.title) || [])]);
    const earlier = [], later = [];
    [...matches].sort((a, b) => a - b).forEach(other => {
      if (other === index || !sameKey(keys[other], key)) return;
      (other < index ? earlier : later).push(queue[other].pos);
    });
    const play = recent.find(entry => sameKey(entry.key, key))?.item || null;
    if (!earlier.length && !later.length && !play) return null;
    return { earlier, later, playedAt: play ? play.at : null };
  });
}

module.exports = { DEFAULT_REPEAT_MIN, PLAYED_LIMIT, normalize, sameSong, lastPlay, songNotice, queueRepeats };
