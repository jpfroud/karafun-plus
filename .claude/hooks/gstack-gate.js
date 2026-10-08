#!/usr/bin/env node
'use strict';
// Porte gstack du projet : hooks Claude Code déclarés dans .claude/settings.json.
//
//   node .claude/hooks/gstack-gate.js skill    PostToolUse Skill : note la compétence gstack lancée
//   node .claude/hooks/gstack-gate.js prompt   UserPromptSubmit : note une commande /compétence tapée
//   node .claude/hooks/gstack-gate.js edit     PreToolUse Edit|Write|MultiEdit|NotebookEdit
//   node .claude/hooks/gstack-gate.js deliver  PreToolUse Bash et outils GitHub d'envoi
//
// edit : refuse de modifier un fichier du dépôt tant qu'aucune compétence
// gstack n'a été lancée dans la session (les sous-agents partagent la session
// de l'agent principal).
// deliver : refuse « git push », « gh pr create » et les envois GitHub tant
// qu'une relecture gstack /review n'a pas été terminée sur le contenu exact du
// dépôt (journal de relecture de gstack, lu par gstack-review-read).
//
// Les compétences notées sont gardées dans .gstack/porte/ (ignoré par git).
// GSTACK_GATE=off coupe la porte (décision de l'utilisateur seulement).
// Une erreur interne laisse passer, sauf pour l'envoi : il reste refusé tant
// que la relecture ne peut pas être vérifiée.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODE = process.argv[2] || '';
const HOME = process.env.HOME || os.homedir();

// Compétences d'administration de gstack : elles ne valent pas parcours.
const ADMIN_SKILLS = new Set(['gstack-upgrade', 'setup-browser-cookies', 'setup-deploy', 'setup-gbrain',
  'sync-gbrain', 'context-save', 'context-restore', 'learn', 'plan-tune', 'retro', 'landing-report',
  'open-gstack-browser', 'connect-chrome', 'benchmark-models', 'unfreeze', 'skillify']);
// Relectures de diff reconnues par gstack (lib/review-evidence.ts, sauf ship).
const REVIEW_SKILLS = new Set(['review', 'adversarial-review', 'codex-review']);
// Fichiers du dépôt modifiables sans compétence : rapport local et données.
const FREE_PATHS = [/^RAPPORT-TEST\.md$/i, /^\.gstack\//, /^data\//, /^journal\//, /^node_modules\//];

const ROUTES = 'défaut signalé → investigate ; fonctionnalité à préciser → spec (plan à challenger → plan-eng-review) ; ' +
  'parcours dans l\'application → qa ; sécurité → cso ; état du code → health ; documentation → document-release';

function out(obj) { if (obj) process.stdout.write(JSON.stringify(obj) + '\n'); }
function deny(reason) {
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}
function note(context) {
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } });
}

// Lit le JSON de l'événement sans jamais attendre une entrée restée ouverte.
function readEvent() {
  return new Promise(resolve => {
    let data = '';
    const done = () => { try { resolve(data.trim() ? JSON.parse(data) : {}); } catch { resolve(null); } };
    const timer = setTimeout(() => { process.stdin.destroy(); done(); }, 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); done(); });
    process.stdin.on('error', () => { clearTimeout(timer); done(); });
  });
}

// Même résolution que check-gstack.sh et que le mode équipe officiel.
function gstackDir() {
  const candidates = [process.env.GSTACK_ROOT, '.claude/skills/gstack', '.codex/skills/gstack', '.factory/skills/gstack',
    '.kiro/skills/gstack', '.config/opencode/skills/gstack', '.slate/skills/gstack', '.cursor/skills/gstack',
    '.openclaw/skills/gstack', '.hermes/skills/gstack', '.gbrain/skills/gstack', '.gstack/repos/gstack'];
  for (const c of candidates) {
    if (!c) continue;
    const dir = path.isAbsolute(c) ? c : path.join(HOME, c);
    if (fs.existsSync(path.join(dir, 'bin'))) return dir;
  }
  return '';
}

function projectDir(event) {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || (event && event.cwd) || process.cwd());
}

function realpath(p) {
  try { return fs.realpathSync.native(p); } catch {}
  // Fichier pas encore créé : résoudre son dossier parent existant.
  const parent = path.dirname(p);
  if (parent === p) return p;
  return path.join(realpath(parent), path.basename(p));
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Chemin relatif au dépôt (barres obliques), ou null hors du dépôt.
function insideProject(file, root) {
  const rel = path.relative(realpath(root), realpath(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function stateFile(event) {
  const id = String((event && event.session_id) || 'sans-session').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  return path.join(projectDir(event), '.gstack', 'porte', `${id}.json`);
}

function readState(event) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(event), 'utf8'));
    return state && Array.isArray(state.skills) ? state : { skills: [] };
  } catch { return { skills: [] }; }
}

function writeState(event, state) {
  const file = stateFile(event);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// Nom de compétence gstack (« investigate », « gstack:qa », « /review »…) ou ''.
function gstackSkill(raw) {
  const name = String(raw || '').trim().replace(/^\//, '').replace(/^gstack[:-](?=.)/, '').split(/\s/)[0];
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name) || ADMIN_SKILLS.has(name)) return '';
  const dir = gstackDir();
  if (!dir) return '';
  if (name === 'gstack') return name;
  return fs.existsSync(path.join(dir, name, 'SKILL.md')) ? name : '';
}

function record(event, name, source) {
  const state = readState(event);
  state.skills.push({ skill: name, at: new Date().toISOString(), source, agent: (event && event.agent_id) || null });
  state.skills = state.skills.slice(-50);
  writeState(event, state);
}

function onSkill(event) {
  const input = (event && event.tool_input) || {};
  const name = gstackSkill(input.skill || input.command || input.name);
  if (name) record(event, name, 'Skill');
}

function onPrompt(event) {
  const prompt = String((event && event.prompt) || '').trim();
  const m = /^\/([A-Za-z0-9:_-]+)/.exec(prompt);
  const name = m && gstackSkill(m[1]);
  if (name) record(event, name, 'commande');
}

function onEdit(event) {
  const input = (event && event.tool_input) || {};
  const target = input.file_path || input.notebook_path || input.path;
  if (!target) return;
  const root = projectDir(event);
  const file = path.resolve((event && event.cwd) || root, String(target));
  const rel = insideProject(file, root);
  if (rel === null || FREE_PATHS.some(re => re.test(rel))) return;
  if (!gstackDir()) {
    deny('gstack est obligatoire dans ce dépôt mais n\'est pas installé : lancer bash .claude/hooks/install-gstack.sh ' +
      '(installation acceptée par l\'utilisateur), puis redémarrer l\'agent. Le dire à l\'utilisateur.');
    return;
  }
  if (readState(event).skills.length) return;
  deny(`Modification de ${rel} refusée : aucune compétence gstack n'a encore été lancée dans cette session. ` +
    `Choisir celle qui convient à la demande et la lancer avec l'outil Skill (${ROUTES}), ` +
    'en l\'annonçant en une ligne, puis reprendre la modification. /review reste exigé avant git push ou la PR.');
}

// git push (options globales comme -C admises) ou gh pr create.
const PUSH = /(?:^|[\s;&|(`])git(?:\s+(?:-C|-c)\s+\S+|\s+--?[A-Za-z][\w-]*(?:=\S+)?)*\s+push(?=\s|$|[;&|)])/;
const GH_PR = /(?:^|[\s;&|(`])gh\s+pr\s+create(?=\s|$|[;&|)])/;
const GITHUB_SEND = new Set(['mcp__github__create_pull_request', 'mcp__github__push_files', 'mcp__github__create_or_update_file']);

function deliveryTarget(event) {
  const tool = (event && event.tool_name) || '';
  const input = (event && event.tool_input) || {};
  if (tool === 'Bash') {
    const command = String(input.command || '');
    if (!PUSH.test(command) && !GH_PR.test(command)) return null;
    const dir = /\bgit\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))\s/.exec(command);
    const where = dir ? (dir[2] || dir[3] || dir[4]) : '';
    return path.resolve((event && event.cwd) || projectDir(event), where);
  }
  return GITHUB_SEND.has(tool) ? projectDir(event) : null;
}

function gitTop(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? realpath(path.resolve(r.stdout.trim())) : '';
}

// Lignes du journal de relecture et empreinte actuelle du contenu (gstack-review-read).
function readReviews(gstack, cwd) {
  const bash = process.env.CLAUDE_CODE_GIT_BASH_PATH || 'bash';
  const r = spawnSync(bash, [path.join(gstack, 'bin', 'gstack-review-read')], { cwd, encoding: 'utf8', timeout: 45000 });
  if (r.status !== 0 || !r.stdout) {
    throw new Error((r.stderr || (r.error && r.error.message) || `code ${r.status}`).trim().split('\n').pop());
  }
  const lines = r.stdout.split(/\r?\n/);
  const rows = [];
  let i = 0;
  for (; i < lines.length && lines[i] !== '---CONFIG---'; i++) {
    if (lines[i].startsWith('{')) { try { rows.push(JSON.parse(lines[i])); } catch {} }
  }
  const at = lines.indexOf('---WTREE---');
  const wtree = at >= 0 ? (lines[at + 1] || '').trim() : '';
  return { rows, wtree };
}

function onDeliver(event) {
  const target = deliveryTarget(event);
  if (!target) return;
  const root = gitTop(projectDir(event));
  const here = gitTop(target);
  if (!root || !here || !samePath(root, here)) return; // autre dépôt : pas concerné
  const gstack = gstackDir();
  const ask = 'Lancer la compétence gstack review (outil Skill) et la mener jusqu\'à son journal de relecture, puis réessayer. ' +
    'Si la porte se trompe, le dire à l\'utilisateur : lui seul peut la couper (GSTACK_GATE=off).';
  if (!gstack) {
    deny('Envoi refusé : gstack est obligatoire mais n\'est pas installé (bash .claude/hooks/install-gstack.sh). ' + ask);
    return;
  }
  let reviews;
  try { reviews = readReviews(gstack, here); } catch (e) {
    deny(`Envoi refusé : le journal de relecture gstack est illisible (${e.message}). ${ask}`);
    return;
  }
  const { rows, wtree } = reviews;
  if (!wtree || wtree === 'unknown') {
    deny(`Envoi refusé : empreinte du contenu indisponible, la relecture ne peut pas être vérifiée. ${ask}`);
    return;
  }
  const covers = row => REVIEW_SKILLS.has(row.skill) && row.completed === true && row.wtree === wtree &&
    row.review_binding && row.review_binding.state === 'verified' &&
    row.review_binding.start_wtree === wtree && row.review_binding.end_wtree === wtree;
  const done = rows.filter(covers);
  if (done.some(row => row.review_freshness && row.review_freshness.status === 'CURRENT')) return;
  if (done.length) {
    const last = done[done.length - 1];
    note(`Porte gstack : la relecture /${last.skill} couvre ce contenu mais s'est terminée avec des remarques non résolues ` +
      `(statut ${last.status || 'inconnu'}, ${last.issues_found || 0} remarque(s)). Les signaler à l'utilisateur dans le compte rendu.`);
    return;
  }
  const stale = rows.some(row => REVIEW_SKILLS.has(row.skill));
  deny('Envoi refusé : ' + (stale
    ? 'le contenu a changé depuis la dernière relecture gstack (ou elle n\'a pas été menée à son terme). '
    : 'aucune relecture gstack n\'a été faite sur cette branche. ') + ask);
}

(async () => {
  if (String(process.env.GSTACK_GATE || '').toLowerCase() === 'off') return;
  const event = await readEvent();
  if (!event) return;
  if (MODE === 'skill') onSkill(event);
  else if (MODE === 'prompt') onPrompt(event);
  else if (MODE === 'edit') onEdit(event);
  else if (MODE === 'deliver') onDeliver(event);
})().catch(e => {
  // Erreur interne : ne jamais bloquer l'agent sur un défaut du hook.
  process.stderr.write(`gstack-gate (${MODE}) : ${e && e.message}\n`);
});
