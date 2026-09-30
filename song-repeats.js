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
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function sameSong(a, b) {
  if (!a || !b) return false;
  const idA = Number(a.songId), idB = Number(b.songId);
  if (idA > 0 && idA === idB) return true;
  const titleA = normalize(a.title), titleB = normalize(b.title);
  if (!titleA || titleA !== titleB) return false;
  // Même titre chez deux artistes (reprises) : deux chansons distinctes,
  // sauf si l'une des deux entrées ne précise pas l'artiste.
  const artistA = normalize(a.artist), artistB = normalize(b.artist);
  return !artistA || !artistB || artistA === artistB;
}

// Ligne de file publique : titre dans `song` (fmtSong) ou à plat.
const songOf = line => line?.song || (line?.title ? line : null);

function lastPlay(played, song, now, windowMs) {
  if (!(windowMs > 0)) return null;
  let best = null;
  for (const item of played || []) {
    if (!item || !Number.isFinite(item.at) || now - item.at >= windowMs) continue;
    if (sameSong(item, song) && (!best || item.at > best.at)) best = item;
  }
  return best;
}

// Alerte pour la personne qui ajoute un titre. `entryId` désigne le titre
// qu'elle vient d'ajouter : il permet de dire si l'autre passage est avant.
function songNotice({ song, entryId = null, queue = [], played = [], now = Date.now(), windowMs = 0 }) {
  if (!song) return null;
  const recent = lastPlay(played, song, now, windowMs);
  const own = entryId ? queue.find(line => songOf(line)?.entryId === entryId) : null;
  const queued = queue.filter(line => line !== own && sameSong(songOf(line), song)).map(line => ({
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
function queueRepeats(queue, played, now = Date.now(), windowMs = 0) {
  return queue.map((line, index) => {
    const song = songOf(line);
    if (!song) return null;
    const earlier = [], later = [];
    queue.forEach((other, otherIndex) => {
      if (otherIndex === index || !sameSong(songOf(other), song)) return;
      (otherIndex < index ? earlier : later).push(other.pos);
    });
    const recent = lastPlay(played, song, now, windowMs);
    if (!earlier.length && !later.length && !recent) return null;
    return { earlier, later, playedAt: recent ? recent.at : null };
  });
}

module.exports = { DEFAULT_REPEAT_MIN, PLAYED_LIMIT, normalize, sameSong, lastPlay, songNotice, queueRepeats };
