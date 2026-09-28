'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
for (const file of ['client.html', 'staff.html', 'print.html']) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
  const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  if (!scripts.length) throw new Error(`${file} : aucun script`);
  scripts.forEach((match, index) => new vm.Script(match[1], { filename: `${file}#script${index + 1}` }));
  console.log(`${file} : ${scripts.length} script(s) valides`);
}
