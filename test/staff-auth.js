'use strict';
// Les recettes locales récupèrent la clé depuis la redirection de démarrage du PC.
// En mode serveur (aucune redirection), elles la lisent dans le fichier de clé
// donné au serveur (`keyFile`), relu à chaque appel. Elle n'est jamais imprimée
// dans leurs rapports.
const fs = require('fs');
const keys = new Map();
async function staffKey(base, { keyFile } = {}) {
  if (keyFile) {
    const key = fs.readFileSync(keyFile, 'utf8').trim();
    if (!key) throw new Error(`Clé du bar absente du fichier ${keyFile}`);
    return key;
  }
  if (!keys.has(base)) {
    const r = await fetch(base + '/', { redirect: 'manual' });
    if (r.status !== 302) throw new Error(`Accès local au bar impossible : HTTP ${r.status}`);
    const key = new URL(r.headers.get('location'), base).searchParams.get('key');
    if (!key) throw new Error('Clé du bar absente de la redirection locale');
    keys.set(base, key);
  }
  return keys.get(base);
}
async function staffRoute(base, route, options = {}) {
  if (!route.startsWith('/api/staff/') && !['/staff', '/print'].includes(route) && !route.startsWith('/qr/')) return route;
  return route + (route.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(await staffKey(base, options));
}
module.exports = { staffKey, staffRoute };
