'use strict';
// Lance T1 et arrête toujours le serveur de démo créé par ce test.
const { spawn } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const { staffRoute } = require('./staff-auth');
function run(file, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { cwd: root, windowsHide: true, stdio: 'inherit', env: {...process.env, ...env} });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${file}: code ${code}`)));
  });
}
(async () => {
  for (const f of ['check-inline.js','scheduler.test.js','scheduler-race.test.js','first-turn-fairness.test.js',
    'rotation-recent-physical.test.js','timefold-integration.test.js','appearance-persistence.test.js','solo-capacity.test.js','solo-invitations.test.js','private-event.test.js',
    'night-state.test.js','client-ui-flow.test.js','comptoir-client-ui.test.js','client-i18n.test.js','client-v04-ui.test.js','karafun-state.test.js',
    'sync-regressions.test.js','list-regressions.test.js','table-modes.test.js',
    'interaction-regressions.test.js','real-night-regressions.test.js','bar-reality.test.js','large-night-simulation.test.js','absence-duo-regressions.test.js','staff-duo-tracked-api.test.js','table-access.test.js','catalog.test.js','battle-vote.test.js','staff-ui-regressions.test.js','staff-layout.regression-1.test.js','staff-layout.regression-2.test.js',
    'bar-rotation-feedback.test.js','karafun-identity.test.js','continuous-optimization.test.js','song-repeats.test.js','duo-cap-spacing.test.js','presence-skip.test.js','presence-timeout.test.js','defer-turn.test.js','lyrics-spotify.test.js','review-v04-fixes.test.js','covers.test.js','duo-improvise-credit.test.js','staff-duo-undo.test.js','spotify-fermeture.test.js','battle-cooldown-reset-api.test.js','kcs-protocol.test.js','kcs-connection.test.js','song-settings.test.js','song-settings-server.test.js','song-settings-layout.test.js','kcs-ratelimit.test.js','server-karafun-connection.test.js','server-staff-routes.test.js','server-table-routes.test.js','solo-access-routes.test.js','evening-journal.test.js','evening-stats.test.js','evening-stats-routes.test.js','stats-page.test.js','staff-ui-coverage.test.js','print-page.test.js','client-ui-coverage.test.js','cli-persistence.test.js','duo-withdraw.test.js','duo-routes.test.js','duo-invite-expiry.test.js',
    'sim-night.js','start-evening.test.js','startup-port.test.js']) await run(`test/${f}`);
  async function demoTest(port, songSeconds, script) {
  const base = `http://127.0.0.1:${port}`;
  try { await fetch(base); throw new Error(`Le port ${port} est déjà occupé`); }
  catch (e) { if (e.message !== 'fetch failed') throw e; }
  const demo = spawn(process.execPath, ['server.js','--demo','--song-seconds',String(songSeconds),'--port',String(port),'--no-open'], {cwd:root, windowsHide:true, stdio:['ignore','ignore','inherit']});
  try {
    let ready = false;
    for (let i=0;i<50;i++) {
      try { const s=await (await fetch(base+await staffRoute(base, '/api/staff/state'))).json(); if(s.kf?.ready) {ready=true;break;} } catch {}
      await new Promise(r=>setTimeout(r,100));
    }
    if (!ready) throw new Error('Démo non prête');
    await run(script, {BASE:base});
  } finally {
    if (demo.exitCode === null) {
      await new Promise(resolve => {
        demo.once('exit', resolve);
        demo.kill();
      });
    }
  }
  }
  await demoTest(3100, 4, 'test/e2e-api.js');
  await demoTest(3101, 10, 'test/recette-profonde.js');
  await demoTest(3102, 10, 'test/public-port.test.js');
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
  await demoTest(3114, 10, 'test/staff-qr-layout.test.js');
  await demoTest(3115, 10, 'test/solo-access-api.test.js');
  await run('test/evening-controls-api.test.js');
  await run('test/priority-undo-api.test.js');
  await run('test/night-restart-api.test.js');
  console.log('T1 et recette approfondie hors ligne OK');
})().catch(e=>{console.error(e);process.exitCode=1;});
