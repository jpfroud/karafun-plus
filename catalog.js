/* Catalogue HTTP de la télécommande KaraFun. Aucune URL KCS signée ici. */
const CATEGORY_TYPES = new Set(['playlist', 'styles', 'top']);
const HIGHLIGHT_TYPES = new Set(['news', 'featured']);

function positiveId(value) {
  if (!/^\d{1,10}$/.test(String(value ?? ''))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function normalizeSong(item) {
  if (!item || typeof item !== 'object') return null;
  const songId = positiveId(item.songId ?? item.id);
  const title = String(item.title || '').trim();
  if (!songId || !title) return null;
  return {
    songId,
    title,
    artist: String(item.artist || '').trim(),
    duration: item.duration != null && Number.isFinite(Number(item.duration)) ? Number(item.duration) : null,
    img: typeof item.img === 'string' ? item.img : null,
    year: item.year != null && Number.isInteger(Number(item.year)) ? Number(item.year) : null,
    isExplicit: item.isExplicit === true,
  };
}

function normalizeCategory(item, type) {
  if (!item || typeof item !== 'object') return null;
  const id = positiveId(item.id);
  const name = String(item.name || item.title || '').trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    filter: `${type === 'styles' ? 'st' : 'pl'}_${id}`,
    img: typeof item.img === 'string' ? item.img : null,
  };
}

class Catalog {
  constructor({ base, code, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('Origine catalogue invalide');
    if (!/^\d{4,12}$/.test(String(code))) throw new Error('Code KaraFun invalide');
    if (typeof fetchImpl !== 'function') throw new Error('fetch manquant');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Délai invalide');
    this.endpoint = new URL(`/${code}/`, origin.origin);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async _get(params) {
    const url = new URL(this.endpoint);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    let timer;
    const request = (async () => {
      const response = await this.fetchImpl(url.href, { signal: controller.signal });
      if (!response.ok) throw new Error(`Catalogue KaraFun : HTTP ${response.status}`);
      return response.json();
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Catalogue KaraFun : timeout'));
      }, this.timeoutMs);
    });
    try { return await Promise.race([request, timeout]); }
    finally { clearTimeout(timer); }
  }

  async categories(type) {
    if (!CATEGORY_TYPES.has(type)) throw new Error('Catégorie inconnue');
    const data = await this._get({ type });
    if (!Array.isArray(data)) throw new Error('Réponse de catégories invalide');
    return data.map((item) => normalizeCategory(item, type)).filter(Boolean);
  }

  async highlights(type) {
    if (!HIGHLIGHT_TYPES.has(type)) throw new Error('Sélection inconnue');
    const data = await this._get({ type, types: 'karaoke' });
    if (!Array.isArray(data)) throw new Error('Réponse de sélection invalide');
    return data.map(normalizeSong).filter(Boolean);
  }

  async songs(filter, offset = 0) {
    if (typeof filter !== 'string' || !/^(?:pl|st|si)_\d{1,10}$/.test(filter) ||
        !positiveId(filter.slice(3))) throw new Error('Filtre de catalogue invalide');
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('Offset invalide');
    const data = await this._get({ type: 'song_list', filter, offset, filters: 'karaoke' });
    if (!data || !Array.isArray(data.songs) || !Number.isInteger(Number(data.total)) || Number(data.total) < 0) {
      throw new Error('Réponse de chansons invalide');
    }
    return { songs: data.songs.map(normalizeSong).filter(Boolean), total: Number(data.total) };
  }
}

module.exports = { Catalog, normalizeSong, normalizeCategory };
