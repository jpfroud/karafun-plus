'use strict';
// Préchargé par test/diag-karafun.test.js (F2, node --require) : fetch rend
// toujours un refus 403 factice, pour lancer tools/diag-karafun.js dans un
// vrai processus sans réseau ni lecture de KaraFun.
globalThis.fetch = async () => ({
  ok: false, status: 403, url: '', headers: new Headers({ 'Retry-After': '120' }), text: async () => 'Forbidden',
});
