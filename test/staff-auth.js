'use strict';
// Les recettes locales récupèrent la clé depuis la redirection de démarrage du PC.
// Elle n'est jamais imprimée dans leurs rapports.
const keys = new Map();
async function staffKey(base) {
  if (!keys.has(base)) {
    const r = await fetch(base + '/', { redirect: 'manual' });
    if (r.status !== 302) throw new Error(`Accès local au bar impossible : HTTP ${r.status}`);
    const key = new URL(r.headers.get('location'), base).searchParams.get('key');
    if (!key) throw new Error('Clé du bar absente de la redirection locale');
    keys.set(base, key);
  }
  return keys.get(base);
}
async function staffRoute(base, route) {
  if (!route.startsWith('/api/staff/') && !['/staff', '/print'].includes(route) && !route.startsWith('/qr/')) return route;
  return route + (route.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(await staffKey(base));
}
module.exports = { staffKey, staffRoute };
