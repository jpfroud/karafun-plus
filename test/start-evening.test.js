'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { locateKaraFun } = require('../start-evening');

assert.equal(locateKaraFun({}), null, 'Sans KaraFun installé, démarrage manuel annoncé');
assert.equal(locateKaraFun({ KARAFUN_EXE: process.execPath }), process.execPath,
  'Le chemin KaraFun fourni explicitement est accepté');
assert.equal(locateKaraFun({
  KARAFUN_EXE: path.join(__dirname, 'inexistant.exe'),
  ProgramFiles: path.dirname(path.dirname(process.execPath)),
}), null, 'Un chemin inexistant ne déclenche pas un processus au hasard');
console.log('Démarrage KaraFun : détection des chemins OK');
