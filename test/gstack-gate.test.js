'use strict';
// Porte gstack de Claude Code (.claude/hooks/gstack-gate.js) : modification
// refusée sans compétence gstack lancée dans la session, envoi refusé sans
// relecture /review terminée sur le contenu exact. Un faux gstack et un faux
// journal de relecture remplacent les vrais.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const GATE = path.join(__dirname, '..', '.claude', 'hooks', 'gstack-gate.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'porte-gstack-'));
const home = path.join(work, 'home');
const empty = path.join(work, 'vide');
const project = path.join(work, 'projet');
const other = path.join(work, 'autre-depot');
const reviews = path.join(work, 'journal.txt');

// Faux gstack : quelques compétences et un gstack-review-read qui rend le journal préparé.
const gstack = path.join(home, '.claude', 'skills', 'gstack');
fs.mkdirSync(path.join(gstack, 'bin'), { recursive: true });
for (const skill of ['investigate', 'review', 'qa', 'gstack-upgrade']) {
  fs.mkdirSync(path.join(gstack, skill), { recursive: true });
  fs.writeFileSync(path.join(gstack, skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
}
fs.writeFileSync(path.join(gstack, 'bin', 'gstack-review-read'),
  '#!/usr/bin/env bash\ncat "$FAUX_JOURNAL"\nexit "${FAUX_JOURNAL_CODE:-0}"\n');
fs.mkdirSync(empty, { recursive: true });

for (const dir of [project, other]) {
  fs.mkdirSync(dir, { recursive: true });
  const git = args => assert.strictEqual(spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).status, 0, args.join(' '));
  git(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'server.js'), '// app\n');
  git(['add', '-A']);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'depart']);
}

function gate(mode, event, env = {}) {
  const r = spawnSync(process.execPath, [GATE, mode], {
    input: typeof event === 'string' ? event : JSON.stringify({ cwd: project, ...event }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project,
      FAUX_JOURNAL: reviews, GSTACK_ROOT: '', GSTACK_GATE: '', ...env },
  });
  assert.strictEqual(r.status, 0, `la porte ne doit jamais échouer (${mode}) : ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const decision = reply => reply && reply.hookSpecificOutput && reply.hookSpecificOutput.permissionDecision;
const reason = reply => (reply && reply.hookSpecificOutput && reply.hookSpecificOutput.permissionDecisionReason) || '';
const edit = (session, file, env) => gate('edit', { session_id: session, tool_name: 'Edit', tool_input: { file_path: file } }, env);
const skill = (session, name) => gate('skill', { session_id: session, tool_name: 'Skill', tool_input: { skill: name, args: 'x' } });
const push = (command, env, extra = {}) => gate('deliver', { session_id: 's', tool_name: 'Bash', tool_input: { command }, ...extra }, env);

// 1. Modification refusée tant qu'aucune compétence gstack n'a été lancée.
let reply = edit('s1', path.join(project, 'server.js'));
assert.strictEqual(decision(reply), 'deny', 'modification sans compétence gstack');
assert.match(reason(reply), /server\.js/);
assert.match(reason(reply), /investigate/);
assert.match(reason(reply), /outil Skill/);
reply = gate('edit', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'public/nouveau.html' } });
assert.strictEqual(decision(reply), 'deny', 'chemin relatif dans le dépôt, fichier pas encore créé');
reply = gate('edit', { session_id: 's1', tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(project, 'a.ipynb') } });
assert.strictEqual(decision(reply), 'deny', 'carnet du dépôt');

// Hors dépôt, rapport local et données : jamais bloqués.
for (const file of [path.join(work, 'brouillon.js'), path.join(project, 'RAPPORT-TEST.md'),
  path.join(project, '.gstack', 'qa-reports', 'r.md'), path.join(project, 'data', 'soiree.json')]) {
  assert.strictEqual(edit('s1', file), null, `${file} ne doit pas être bloqué`);
}

// Compétences étrangères à gstack ou d'administration : ne comptent pas.
skill('s1', 'simplify');
skill('s1', 'gstack-upgrade');
skill('s1', '../../etc');
assert.strictEqual(decision(edit('s1', path.join(project, 'server.js'))), 'deny', 'compétence hors parcours acceptée');

// 2. Une compétence gstack lancée : la session (sous-agents compris) peut modifier.
skill('s1', 'investigate');
assert.strictEqual(edit('s1', path.join(project, 'server.js')), null, 'modification après investigate');
assert.strictEqual(gate('edit', { session_id: 's1', agent_id: 'sous-agent', tool_name: 'MultiEdit',
  tool_input: { file_path: path.join(project, 'scheduler.js') } }), null, 'sous-agent de la même session');
const state = JSON.parse(fs.readFileSync(path.join(project, '.gstack', 'porte', 's1.json'), 'utf8'));
assert.deepStrictEqual(state.skills.map(s => s.skill), ['investigate'], 'seule la compétence gstack est notée');
assert.strictEqual(decision(edit('s2', path.join(project, 'server.js'))), 'deny', 'une autre session repart de zéro');
skill('s2', 'gstack:qa');
assert.strictEqual(edit('s2', path.join(project, 'server.js')), null, 'nom préfixé gstack:');

// Commande tapée par l'utilisateur (/qa, /review…) : compte aussi.
gate('prompt', { session_id: 's3', prompt: 'bonjour, corrige le bug' });
assert.strictEqual(decision(edit('s3', path.join(project, 'server.js'))), 'deny', 'une demande ordinaire ne compte pas');
gate('prompt', { session_id: 's3', prompt: '/investigate la file se bloque' });
assert.strictEqual(edit('s3', path.join(project, 'server.js')), null, 'commande /investigate');

// gstack absent : refus avec l'installateur du projet.
reply = edit('s1', path.join(project, 'server.js'), { HOME: empty, USERPROFILE: empty });
assert.strictEqual(decision(reply), 'deny');
assert.match(reason(reply), /install-gstack\.sh/);

// 3. Envoi : seules les commandes d'envoi sont contrôlées.
fs.writeFileSync(reviews, 'NO_REVIEWS\n---CONFIG---\nfalse\n---HEAD---\nabc1234\n---WTREE---\nW1\n---TREE---\nT1\n---DIRTY---\nfalse\n');
for (const command of ['ls -la', 'git status', 'git stash push -m x', 'git log --oneline | head', 'npm test', "echo 'git push'"]) {
  assert.strictEqual(push(command), null, `« ${command} » n'est pas un envoi`);
}
for (const command of ['git push -u origin feat/x', 'cd /tmp && git push', 'git -c core.x=1 push origin x',
  'for i in 1 2; do git push -u origin b && break; done', 'gh pr create --fill', 'git --no-pager push']) {
  reply = push(command);
  assert.strictEqual(decision(reply), 'deny', `« ${command} » sans relecture`);
  assert.match(reason(reply), /aucune relecture gstack/);
  assert.match(reason(reply), /review/);
}
reply = gate('deliver', { session_id: 's', tool_name: 'mcp__github__create_pull_request', tool_input: { title: 't' } });
assert.strictEqual(decision(reply), 'deny', 'PR GitHub sans relecture');
assert.strictEqual(push(`git -C "${other}" push`), null, 'autre dépôt : pas concerné');
assert.strictEqual(push('git push', {}, { cwd: other }), null, 'autre dépôt (dossier courant)');

// Relecture terminée et propre sur le contenu exact : envoi accepté.
const row = (extra = {}) => JSON.stringify({ skill: 'review', status: 'clean', issues_found: 0, completed: true, converged: true,
  wtree: 'W1', review_binding: { state: 'verified', start_wtree: 'W1', end_wtree: 'W1' },
  review_freshness: { status: 'CURRENT', reason: 'completed clean pass on unchanged content' }, ...extra });
const journal = (...rows) => fs.writeFileSync(reviews, `${rows.join('\n')}\n---CONFIG---\nfalse\n---HEAD---\nabc\n---WTREE---\nW1\n---TREE---\nT\n---DIRTY---\nfalse\n`);
journal(row());
assert.strictEqual(push('git push -u origin feat/x'), null, 'relecture à jour');
assert.strictEqual(gate('deliver', { session_id: 's', tool_name: 'mcp__github__create_pull_request', tool_input: {} }), null);

// Contenu changé depuis la relecture, relecture inachevée ou télémétrie de /ship : refus.
journal(row({ wtree: 'W0', review_binding: { state: 'verified', start_wtree: 'W0', end_wtree: 'W0' } }));
assert.match(reason(push('git push')), /a changé depuis la dernière relecture/);
journal(row({ completed: false, review_freshness: { status: 'UNVERIFIED' } }));
assert.strictEqual(decision(push('git push')), 'deny', 'relecture inachevée');
journal(row({ review_binding: { state: 'changed', start_wtree: 'W0', end_wtree: 'W1' }, review_freshness: { status: 'STALE' } }));
assert.strictEqual(decision(push('git push')), 'deny', 'contenu modifié pendant la relecture');
journal(row({ skill: 'ship' }));
assert.strictEqual(decision(push('git push')), 'deny', '/ship ne remplace pas /review');

// Relecture terminée sur ce contenu mais avec des remarques : envoi accepté, à signaler.
journal(row({ status: 'issues_found', issues_found: 2, review_freshness: { status: 'UNVERIFIED' } }));
reply = push('git push');
assert.strictEqual(decision(reply), undefined, 'relecture terminée avec remarques');
assert.match(reply.hookSpecificOutput.additionalContext, /remarques non résolues/);

// Journal illisible ou empreinte inconnue : refus explicite.
assert.match(reason(push('git push', { FAUX_JOURNAL_CODE: '1' })), /journal de relecture gstack est illisible/);
fs.writeFileSync(reviews, `${row()}\n---CONFIG---\nfalse\n---WTREE---\nunknown\n`);
assert.match(reason(push('git push')), /empreinte du contenu indisponible/);
assert.match(reason(push('git push', { HOME: empty, USERPROFILE: empty })), /n'est pas installé/);

// 4. Coupure par l'utilisateur, entrées invalides : jamais de blocage.
assert.strictEqual(edit('zz', path.join(project, 'server.js'), { GSTACK_GATE: 'off' }), null, 'GSTACK_GATE=off');
assert.strictEqual(push('git push', { GSTACK_GATE: 'off' }), null);
assert.strictEqual(gate('edit', '{pas du json'), null);
assert.strictEqual(gate('edit', ''), null);
assert.strictEqual(gate('inconnu', { session_id: 's1' }), null);

// Entrée standard laissée ouverte (lancement à la main) : la porte ne l'attend pas.
(async () => {
  const started = Date.now();
  const child = spawn(process.execPath, [GATE, 'edit'], { env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: project }, stdio: ['pipe', 'pipe', 'pipe'] });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.strictEqual(code, 0);
  assert.ok(Date.now() - started < 8000, 'la porte attend une entrée qui ne se ferme pas');

  // 5. Les réglages du projet déclarent la porte sur les bons événements.
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude', 'settings.json'), 'utf8')).hooks;
  const command = (list, matcher) => (list || []).filter(e => e.matcher === matcher).flatMap(e => e.hooks.map(h => h.command)).join(' ');
  assert.match(command(settings.PreToolUse, 'Edit|Write|MultiEdit|NotebookEdit'), /gstack-gate\.js" edit$/);
  const deliverMatcher = settings.PreToolUse.find(e => /gstack-gate\.js" deliver$/.test(e.hooks[0].command)).matcher.split('|');
  for (const tool of ['Bash', 'mcp__github__create_pull_request', 'mcp__github__push_files']) assert.ok(deliverMatcher.includes(tool), tool);
  assert.match(command(settings.PostToolUse, 'Skill'), /gstack-gate\.js" skill$/);
  assert.match(settings.UserPromptSubmit[0].hooks.map(h => h.command).join(' '), /gstack-gate\.js" prompt/);
  assert.match(command(settings.PreToolUse, 'Skill'), /check-gstack\.sh/);

  fs.rmSync(work, { recursive: true, force: true });
  console.log('Porte gstack : modification sans compétence gstack et envoi sans relecture /review refusés OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
