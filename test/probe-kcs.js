'use strict';
// Diagnostic ponctuel : lecture seule, aucun ajout ni commande de lecture.
const fs = require('fs');
(async () => {
  const code = process.argv[2];
  const html = await (await fetch(`https://www.karafun.fr/${code}/`)).text();
  const settings = JSON.parse(html.match(/const Settings\s*=\s*(\{[^\n]+\});/)[1]);
  const ws = new WebSocket(settings.kcs_url, 'kcpj~v3+emuping');
  const out = [];
  ws.addEventListener('open', () => console.log('WebSocket ouvert'));
  ws.addEventListener('error', e => console.error('Erreur', e.message));
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data); out.push(m); console.log(JSON.stringify(m));
    if (m.type === 'core.PingRequest') ws.send(JSON.stringify({id:m.id,type:'core.PingResponse',payload:{}}));
    if (m.type === 'core.TimestampRequest') ws.send(JSON.stringify({id:m.id,type:'core.TimestampResponse',payload:{timestamp:{_type:'timestamp',value:new Date().toISOString()}}}));
  });
  setTimeout(() => { fs.writeFileSync('journal/kcs-probe.json', JSON.stringify(out,null,2)); ws.close(); }, 12000);
})();
