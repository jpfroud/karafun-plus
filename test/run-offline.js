'use strict';
// Lance T1 et arrête toujours le serveur de démo créé par ce test.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { staffRoute } = require('./staff-auth');
// Suite du mode PC : un réglage du mode serveur laissé dans l'environnement
// (KARAOKE_MODE, KARAOKE_PUBLIC_URL…) ne doit atteindre aucun serveur ni
// aucun bac à sable lancé par les tests.
for (const name of Object.keys(process.env)) if (name.toUpperCase().startsWith('KARAOKE_')) delete process.env[name];
function run(file, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { cwd: root, windowsHide: true, stdio: 'inherit', env: {...process.env, ...env} });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${file}: code ${code}`)));
  });
}
(async () => {
  for (const f of ['check-inline.js','scheduler.test.js','scheduler-race.test.js','first-turn-fairness.test.js','first-come-order.test.js','oldest-wait.test.js',
    'rotation-recent-physical.test.js','round-debt.test.js','bar-gestures.test.js','rejeu-soiree.test.js','kit-sources.test.js','preparer-livrable.test.js','deploy-config.test.js','documentation.test.js','forecast-cache.test.js','timefold-integration.test.js','appearance-persistence.test.js','solo-capacity.test.js','solo-invitations.test.js','private-event.test.js',
    'night-state.test.js','client-ui-flow.test.js','comptoir-client-ui.test.js','client-i18n.test.js','client-v04-ui.test.js','karafun-state.test.js',
    'sync-regressions.test.js','list-regressions.test.js','table-modes.test.js','health-routes.test.js','fuseau.test.js',
    'interaction-regressions.test.js','real-night-regressions.test.js','bar-reality.test.js','large-night-simulation.test.js','absence-duo-regressions.test.js','staff-duo-tracked-api.test.js','table-access.test.js','catalog.test.js','battle-vote.test.js','staff-ui-regressions.test.js','staff-layout.regression-1.test.js','staff-layout.regression-2.test.js','playwright-skip.test.js',
    'bar-rotation-feedback.test.js','karafun-identity.test.js','continuous-optimization.test.js','song-repeats.test.js','duo-cap-spacing.test.js','presence-skip.test.js','presence-timeout.test.js','defer-turn.test.js','lyrics-spotify.test.js','review-v04-fixes.test.js','covers.test.js','duo-improvise-credit.test.js','staff-duo-undo.test.js','spotify-fermeture.test.js','battle-cooldown-reset-api.test.js','battle-spotify.test.js','battle-join-api.test.js','kcs-protocol.test.js','kcs-connection.test.js','song-settings.test.js','song-settings-server.test.js','stage-progress.test.js','stage-progress-server.test.js','max-song-server.test.js','song-settings-layout.test.js','kcs-ratelimit.test.js','diag-karafun.test.js','server-karafun-connection.test.js','server-staff-routes.test.js','priority-pull-api.test.js','server-table-routes.test.js','evening-journal.test.js','evening-stats.test.js','evening-stats-routes.test.js','stats-page.test.js','staff-ui-coverage.test.js','client-ui-coverage.test.js','client-name-gate-layout.test.js','cli-persistence.test.js','duo-withdraw.test.js','duo-routes.test.js','duo-invite-expiry.test.js','duo-open.test.js','solo-access-routes.test.js','solo-names.test.js','print-page.test.js',
    'sim-night.js','start-evening.test.js','startup-port.test.js','server-mode.test.js','server-mode-startup.test.js',
    'server-update.test.js','server-update-routes.test.js','update-ui.test.js','update-agent.test.js']) await run(`test/${f}`);
  async function demoTest(port, songSeconds, script) {
  const base = `http://127.0.0.1:${port}`;
  try { await fetch(base); throw new Error(`Le port ${port} est déjà occupé`); }
  catch (e) { if (e.message !== 'fetch failed') throw e; }
  const demo = spawn(process.execPath, ['server.js','--demo','--song-seconds',String(songSeconds),'--port',String(port),'--no-open'], {cwd:root, windowsHide:true, stdio:['ignore','ignore','inherit']});
  let stopped = null;
  try {
    let ready = false;
    for (let i=0;i<50;i++) {
      try { const s=await (await fetch(base+await staffRoute(base, '/api/staff/state'))).json(); if(s.kf?.ready) {ready=true;break;} } catch {}
      await new Promise(r=>setTimeout(r,100));
    }
    if (!ready) throw new Error('Démo non prête');
    for (const one of [].concat(script)) await run(one, {BASE:base});
  } finally {
    if (demo.exitCode === null) {
      stopped = await new Promise(resolve => {
        demo.once('exit', (code, signal) => resolve({ code, signal }));
        demo.kill();
      });
    }
  }
  // D1 (issue #26) : hors Windows (où demo.kill() coupe le processus sans
  // routine d'arrêt), SIGTERM passe par la routine d'arrêt : code 0, aucun
  // signal, fichier d'arrêt retiré.
  if (stopped && process.platform !== 'win32') {
    const runtime = fs.existsSync(path.join(root, 'data', `runtime-${port}.json`));
    if (stopped.code !== 0 || stopped.signal !== null || runtime) {
      throw new Error(`Démo du port ${port} : arrêt par SIGTERM incorrect (code ${stopped.code}, signal ${stopped.signal}, fichier runtime ${runtime ? 'présent' : 'absent'}).`);
    }
  }
  }
  await demoTest(3100, 4, 'test/e2e-api.js');
  await demoTest(3101, 10, 'test/recette-profonde.js');
  await demoTest(3102, 10, ['test/public-port.test.js', 'test/sondes-demo.test.js']);
  await demoTest(3104, 10, 'test/new-features-api.js');
  await demoTest(3105, 10, 'test/playlist-api.test.js');
  await demoTest(3106, 10, 'test/admin-identity-api.test.js');
  await demoTest(3107, 10, 'test/phone-ownership-api.test.js');
  await demoTest(3108, 10, 'test/solo-comptoir-api.test.js');
  await demoTest(3109, 20, 'test/presence-next-api.test.js');
  await demoTest(3110, 10, 'test/battle-titles-api.test.js');
  await demoTest(3111, 4, 'test/bar-feedback-api.test.js');
  await demoTest(3112, 10, 'test/transfer-link-api.test.js');
  await demoTest(3113, 30, 'test/bar-feedback-v04-api.test.js');
  // Mesures de la page du bar dans un vrai navigateur, sur la même démo.
  await demoTest(3114, 10, ['test/staff-qr-layout.test.js', 'test/staff-idle-layout.test.js']);
  await demoTest(3118, 10, 'test/stage-progress-api.test.js');
  await demoTest(3115, 10, 'test/solo-access-api.test.js');
  await demoTest(3127, 10, 'test/battle-late-joiner-api.test.js');
  await run('test/evening-controls-api.test.js');
  await run('test/priority-undo-api.test.js');
  await run('test/bar-gestures-api.test.js');
  await run('test/night-restart-api.test.js');
  console.log('T1 et recette approfondie hors ligne OK');
})().catch(e=>{console.error(e);process.exitCode=1;});
