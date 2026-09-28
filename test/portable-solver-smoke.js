'use strict';

const { spawnSync } = require('node:child_process');
const [java, jar] = process.argv.slice(2);
if (!java || !jar) throw new Error('Chemins du runtime Java et du JAR manquants.');

const request = {
  requestId: 'kit-smoke',
  performances: [{ id: 'song1', owner: 'p1', singers: ['p1'], groups: ['table1'],
    previousIndex: 0, ownerSongIndex: 0 }],
  pinnedUntil: 0,
  pastAppearance: {},
  physicalCount: {},
  lastGroups: [],
  roundPeople: [],
  tableRotation: false,
  weightedTables: false,
};
const result = spawnSync(java, ['-jar', jar], {
  input: `${JSON.stringify(request)}\n`,
  encoding: 'utf8',
  timeout: 10_000,
  windowsHide: true,
  env: { ...process.env, JAVA_TOOL_OPTIONS: '-Dorg.slf4j.simpleLogger.defaultLogLevel=warn' },
});
if (result.error || result.status !== 0) {
  throw new Error(`Timefold ne démarre pas : ${result.error || result.stderr}`);
}
const lines = result.stdout.trim().split(/\r?\n/);
const response = JSON.parse(lines.at(-1));
if (response.requestId !== 'kit-smoke' || response.order?.[0] !== 'song1') {
  throw new Error(`Réponse Timefold incorrecte : ${result.stdout}`);
}
console.log('Timefold embarqué : calcul de la file confirmé.');
