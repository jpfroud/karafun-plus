'use strict';
// L'agent hôte n'utilise que Python standard. La même recette de panne tourne
// sur Windows et Linux sans Docker, SSH, accès Internet ni installation réelle.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
execFileSync(process.platform === 'win32' ? 'python' : 'python3',
  [path.join(__dirname, 'update-agent.test.py')], { stdio: 'inherit', windowsHide: true });
