'use strict';
// Les droits d'administrateur KaraFun sont donnés à un participant nommé.
// Une reconnexion ne doit donc pas changer le nom « FileKaraoke-XXXX ».
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test, mock } = require('node:test');

const transports = [];
class FakeTransport extends EventEmitter {
  constructor(url) { super(); this.url = url; this.sent = []; transports.push(this); }
  send(type, payload) { this.sent.push({ type, payload }); }
  close() { this.closed = true; }
}
require('../kcs-transport').KcsTransport = FakeTransport;
delete require.cache[require.resolve('../karafun')];
const { KaraFunBridge } = require('../karafun');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-identite-'));
const file = path.join(tmp, 'karafun-login.json');

test('le nom de la file reste le même après reconnexion et redémarrage', () => {
  const bridge = new KaraFunBridge({ identityFile: file });
  const name = bridge.username;
  assert.match(name, /^FileKaraoke-\d{4}$/);
  bridge.code = '123456';
  bridge._openKcs('wss://exemple.invalid/kcs', () => true);
  bridge._openKcs('wss://exemple.invalid/kcs', () => true);
  assert.equal(bridge.username, name, 'deux connexions, un seul nom');
  const restarted = new KaraFunBridge({ identityFile: file });
  assert.equal(restarted.username, name, 'nom conservé après redémarrage de l’application');
});

test('nom encore occupé par l’ancienne connexion : on redemande le même nom, puis on prévient le bar', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const bridge = new KaraFunBridge({ identityFile: file });
    const name = bridge.username;
    bridge.code = '123456';
    transports.length = 0;
    bridge._openKcs('wss://exemple.invalid/kcs', () => true);
    const socket = transports[0];
    socket.emit('message', { type: 'core.AuthenticatedEvent', payload: {} });
    assert.equal(socket.sent.at(-1).payload.username, name);
    // Environ deux minutes d'essais : un redémarrage rapide ne change pas le nom.
    for (let attempt = 1; attempt <= 30; attempt++) {
      socket.emit('message', { type: 'Error', payload: { type: 4, message: 'Username is already used' } });
      assert.match(bridge.lastError, /ancienne connexion/);
      mock.timers.tick(4000);
      assert.equal(socket.sent.at(-1).payload.username, name, `essai ${attempt} avec le même nom`);
    }
    assert.equal(bridge.identityNotice, null);
    socket.emit('message', { type: 'Error', payload: { type: 4, message: 'Username is already used' } });
    mock.timers.tick(0);
    assert.notEqual(bridge.username, name, 'dernier recours : autre nom');
    assert.match(bridge.identityNotice, /redonne-lui les droits d’administrateur/);
    assert.equal(new KaraFunBridge({ identityFile: file }).username, bridge.username,
      'le nouveau nom devient le nom stable');
    bridge.dismissIdentityNotice();
    assert.equal(bridge.snapshot().identityNotice, null, 'le bar peut fermer l’avis');
  } finally { mock.timers.reset(); }
});

test('perte des droits après une reconnexion : alerte explicite au bar', () => {
  const bridge = new KaraFunBridge({});
  bridge._accept('permissions', { addToQueue: true, managePlayback: true, shownTypes: { battle: true } });
  assert.equal(bridge.permissionWarning, null);
  bridge._accept('permissions', { addToQueue: false, managePlayback: false, shownTypes: { battle: false } });
  assert.match(bridge.permissionWarning, /ajout de titres, mode Battle, lecture/);
  assert.match(bridge.snapshot().permissionWarning, /droits d’administrateur/);
  bridge._accept('permissions', { addToQueue: true, managePlayback: true, shownTypes: { battle: true } });
  assert.equal(bridge.permissionWarning, null, 'alerte levée quand les droits reviennent');
});
