'use strict';
// Remplit uniquement une démo isolée pour vérifier les lignes de file sur écran.
const BASE = process.env.BASE || 'http://127.0.0.1:3150';
const { staffRoute } = require('./staff-auth');
async function request(route, body) {
  const r = await fetch(BASE + await staffRoute(BASE, route), body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${route}: ${data.error}`);
  return data;
}
(async () => {
  await request('/api/staff/settings', { auto: false, autoPlay: false });
  for (const [table, headcount] of [['1', 2], ['2', 2], ['3', 1]]) await request('/api/staff/table', { id: table, headcount });
  const tables = (await request('/api/staff/state')).tables;
  let i = 0;
  for (const [table, names] of [['1', ['Alice', 'Marine']], ['2', ['Kenny', 'Clément']], ['3', ['Sebastiano']]]) {
    const access = new URL(tables.find(t => t.id === table).url).pathname.split('/').pop();
    for (const name of names) {
      const person = await request('/api/table/person', { table, access, name });
      await request('/api/table/song', { table, access, personId: person.id,
        song: { songId: 2000 + ++i, title: i === 4 ? 'I Think They Call This Love' : ['Slow Motion', 'Is This Love?', 'Soulmate', 'Bella Italia', 'I Think They Call This Love'][i - 1], artist: 'Artiste de démonstration' } });
    }
  }
  console.log('File visuelle de cinq passages préparée sur la démo.');
})().catch(e => { console.error(e); process.exitCode = 1; });
