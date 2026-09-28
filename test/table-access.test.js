'use strict';

const assert = require('assert');
const { TableAccess } = require('../table-access');

let count = 0;
function test(name, fn) { fn(); count++; console.log('ok -', name); }

test('les QR de deux tables portent des capacités indépendantes et non devinables', () => {
  const access = new TableAccess();
  const a = access.issue('1');
  const b = access.issue('2');
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.notStrictEqual(a, b);
  assert.strictEqual(access.verify('1', a), true);
  assert.strictEqual(access.verify('2', b), true);
  assert.strictEqual(access.verify('2', a), false);
  assert.strictEqual(access.verify('3', a), false);
  assert.strictEqual(access.verify('1', '1'), false);
  assert.strictEqual(access.verify('1', null), false);
});

test('réémission et révocation invalident les anciens liens', () => {
  const access = new TableAccess();
  const old = access.issue('1');
  const fresh = access.issue('1');
  assert.notStrictEqual(old, fresh);
  assert.strictEqual(access.verify('1', old), false);
  assert.strictEqual(access.verify('1', fresh), true);
  assert.strictEqual(access.revoke('1'), true);
  assert.strictEqual(access.get('1'), null);
  assert.strictEqual(access.verify('1', fresh), false);
  assert.strictEqual(access.revoke('1'), false);
});

test('URL encode le numéro ou nom de table et garde le même secret', () => {
  const access = new TableAccess();
  const key = 'Table été';
  const secret = access.issue(key);
  const link = access.url('http://192.168.0.94:3000/', key);
  assert.strictEqual(link, `http://192.168.0.94:3000/t/Table%20%C3%A9t%C3%A9/${secret}`);
  assert.strictEqual(access.get(key), secret);
  assert.strictEqual(access.verify(key, secret), true);
});

test('table non émise, identifiant invalide et format altéré sont refusés', () => {
  const access = new TableAccess();
  assert.strictEqual(access.get('7'), null);
  assert.throws(() => access.url('http://localhost:3000', '7'), /non émis/);
  assert.throws(() => access.issue('../staff'), /invalide/);
  assert.throws(() => access.issue(''), /invalide/);
  const secret = access.issue('7');
  assert.strictEqual(access.verify('7', secret + 'x'), false);
  assert.strictEqual(access.verify('7', secret.slice(0, -1) + '!'), false);
  assert.strictEqual(access.verify('../staff', secret), false);
});

test('un secret sauvegardé retrouve exactement le même QR après redémarrage', () => {
  const before = new TableAccess();
  const secret = before.issue('5');
  const after = new TableAccess();
  after.restore('5', secret);
  assert.strictEqual(after.verify('5', secret), true);
  assert.strictEqual(after.url('http://192.168.0.94:3000', '5'), before.url('http://192.168.0.94:3000', '5'));
  assert.throws(() => after.restore('5', '5'), /invalide/);
});

console.log(`\n${count} tests de capacité de table OK`);
