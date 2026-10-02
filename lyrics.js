'use strict';
// Paroles d'un titre, pour vérifier qu'on le connaît avant de le choisir.
// KaraFun n'expose pas les paroles par sa télécommande : elles sont lues sur
// la page publique du titre (www.karafun.fr/karaoke/<artiste>/<titre>/), comme
// le ferait un navigateur. Le titre est retrouvé par son identifiant KaraFun ;
// à défaut, par son titre exact. Aucune donnée de la soirée n'est envoyée.

const BASE = 'https://www.karafun.fr';
const SONG_PATH = /^\/karaoke\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/;
const MAX_LINES = 400;

// Même règle que les adresses du site : accents retirés, minuscules, tout
// le reste devient un tiret.
function slug(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };
function decode(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === '#') {
      const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

// Page d'un titre : identifiant, titre affiché et paroles ligne à ligne.
function parsePage(html) {
  const text = String(html || '');
  const start = text.search(/class="[^"]*\blyrics\b[^"]*\bjs-lyrics\b/);
  const id = start >= 0 ? /data-song-id="(\d+)"/.exec(text.slice(start, start + 400))?.[1] : null;
  const pageTitle = decode(/<title>([^<]*)<\/title>/i.exec(text)?.[1] || '').trim();
  if (start < 0) return { songId: id ? Number(id) : null, pageTitle, lines: [] };
  // Le bloc des paroles s'arrête à ses boutons d'édition ; la page répète
  // parfois les paroles plus bas dans un formulaire.
  let end = text.indexOf('js-lyrics__action', start);
  if (end < 0) end = Math.min(text.length, start + 200000);
  const block = text.slice(start, end);
  const joined = [...block.matchAll(/<p\b[^>]*\bdata-original="([^"]*)"/g)].map(match => decode(match[1])).join('');
  const lines = [];
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
    // Une ligne vide sépare deux couplets ; jamais deux de suite.
    if (!line && (!lines.length || lines.at(-1) === '')) continue;
    lines.push(line);
    if (lines.length >= MAX_LINES) break;
  }
  while (lines.at(-1) === '') lines.pop();
  return { songId: id ? Number(id) : null, pageTitle, lines };
}

// Liens vers des pages de titres dans une page de résultats du site.
function songLinks(html, base = BASE) {
  const out = [];
  for (const match of String(html || '').matchAll(/href="([^"]+)"/g)) {
    let url;
    try { url = new URL(decode(match[1]), base); } catch (_) { continue; }
    if (url.origin !== new URL(base).origin || !SONG_PATH.test(url.pathname)) continue;
    const path = url.pathname;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

class Lyrics {
  constructor({ fetchImpl = globalThis.fetch, base = BASE, timeoutMs = 8000, cacheSize = 300, now = Date.now } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch manquant');
    this.fetchImpl = fetchImpl;
    this.base = new URL(base).origin;
    this.timeoutMs = timeoutMs;
    this.cacheSize = cacheSize;
    this.now = now;
    this.cache = new Map();
  }

  async _get(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, this.base).href, {
        signal: controller.signal, redirect: 'follow',
        headers: { Accept: 'text/html', 'Accept-Language': 'fr' } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } finally { clearTimeout(timer); }
  }

  _remember(key, value) {
    this.cache.delete(key);
    this.cache.set(key, value);
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  // { lines, url, exact } : `lines` vide si la page n'a pas de paroles,
  // `null` si le titre est introuvable (le lien mène alors à la recherche).
  async find({ songId = null, title, artist = '' }) {
    const id = Number(songId) > 0 ? Number(songId) : null;
    const titleSlug = slug(title), artistSlug = slug(artist);
    if (!titleSlug) throw new Error('Titre manquant.');
    const key = id ? `id:${id}` : `t:${titleSlug}|${artistSlug}`;
    const cached = this.cache.get(key);
    if (cached && (!cached.failedAt || this.now() - cached.failedAt < 10 * 60000)) return cached.value;
    const searchPath = `/search/?query=${encodeURIComponent(`${title} ${artist}`.trim())}`;
    const tried = new Set();
    let fallback = null;
    const check = async path => {
      if (tried.has(path) || tried.size >= 5) return null;
      tried.add(path);
      const html = await this._get(path);
      if (html == null) return null;
      const page = parsePage(html);
      const value = { lines: page.lines, url: new URL(path, this.base).href, exact: !!id && page.songId === id };
      if (value.exact || (!id && page.songId)) return value;
      // Identifiant différent : même titre exact, mais peut-être une autre
      // version. Gardé seulement si aucune page ne correspond mieux.
      if (!fallback && page.lines.length && slug(page.pageTitle).includes(titleSlug)) fallback = { ...value, exact: false };
      return null;
    };
    try {
      let found = artistSlug ? await check(`/karaoke/${artistSlug}/${titleSlug}/`) : null;
      if (!found) {
        const results = await this._get(searchPath);
        const links = songLinks(results, this.base);
        const rank = path => { const songPart = SONG_PATH.exec(path)[2];
          return songPart === titleSlug ? 0 : songPart.startsWith(`${titleSlug}-`) ? 1 : songPart.includes(titleSlug) ? 2 : 3; };
        for (const path of links.filter(path => rank(path) < 3).sort((a, b) => rank(a) - rank(b))) {
          found = await check(path);
          if (found) break;
        }
      }
      const value = found || fallback || { lines: null, url: new URL(searchPath, this.base).href, exact: false };
      return this._remember(key, { value }).value;
    } catch (error) {
      const value = { lines: null, url: new URL(searchPath, this.base).href, exact: false,
        error: error.name === 'AbortError' ? 'délai dépassé' : error.message };
      this._remember(key, { value, failedAt: this.now() });
      return value;
    }
  }
}

module.exports = { Lyrics, parsePage, songLinks, slug };
