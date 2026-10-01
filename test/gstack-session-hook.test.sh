#!/usr/bin/env bash
# Hooks Claude Code du projet : installation automatique de gstack au
# démarrage, rappel du parcours à chaque demande, refus des compétences si
# gstack manque. Un faux dépôt gstack et un faux bun remplacent les vrais :
# aucun téléchargement.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
START="$ROOT/.claude/hooks/gstack-session-start.sh"
CHECK="$ROOT/.claude/hooks/check-gstack.sh"
INSTALL="$ROOT/.claude/hooks/install-gstack.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "ÉCHEC : $*" >&2; exit 1; }

# Lit hookSpecificOutput.<champ> dans un JSON (échoue si le JSON est invalide).
field() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(j.hookSpecificOutput[process.argv[1]]))' "$1"; }

# Faux dépôt gstack : bin/ est versionné comme dans le vrai ; setup note ses
# arguments et crée les compétences Codex quand on les lui demande.
FAKE="$WORK/faux-gstack"; mkdir -p "$FAKE/bin"
echo '#!/usr/bin/env bash' >"$FAKE/bin/gstack-config"
cat >"$FAKE/setup" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$HOME/setup-args"
printf '%s\n' "${GSTACK_SKIP_PLAYWRIGHT:-}" >"$HOME/setup-skip"
[ "${FAUX_SETUP_ECHEC:-0}" = 1 ] && { echo "setup en échec" >&2; exit 3; }
[ "${FAUX_SETUP_LENT:-0}" = 1 ] && sleep 20
case " $* " in *" --host codex "*)
  mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills/gstack-review"
  echo ok >"${CODEX_HOME:-$HOME/.codex}/skills/gstack-review/SKILL.md" ;;
esac
exit 0
EOF
git -C "$FAKE" init -q && git -C "$FAKE" add -A &&
  git -C "$FAKE" -c user.name=test -c user.email=test@example.invalid commit -qm faux || fail "faux dépôt"
TOOLS="$WORK/outils"; mkdir -p "$TOOLS"; printf '#!/usr/bin/env bash\nexit 0\n' >"$TOOLS/bun"; chmod +x "$TOOLS/bun"

# Environnement maîtrisé : pas de session web ni de gstack existant, et pas
# de CODEX_HOME réel (le faux setup y écrirait ses compétences de test).
quiet_env() { env -u GSTACK_ROOT -u CODEX_HOME -u CLAUDE_CODE_REMOTE -u CLAUDE_ENV_FILE -u GSTACK_CHROMIUM_PATH -u GSTACK_SKIP_PLAYWRIGHT "$@"; }
run_start() { local home="$1"; shift; printf '%s' '{"hook_event_name":"SessionStart","source":"startup"}' |
  quiet_env HOME="$home" GSTACK_AUTO_INSTALL=0 "$@" bash "$START" SessionStart; }
run_auto() { local home="$1"; shift; printf '{}' |
  quiet_env HOME="$home" PATH="$TOOLS:$PATH" GSTACK_REPO_URL="$FAKE" "$@" bash "$START" SessionStart; }
run_check() { printf '%s' '{"tool_name":"Skill"}' | quiet_env HOME="$1" bash "$CHECK" 2>/dev/null; }

# 1. Installation automatique désactivée : rappel non bloquant, rien n'est créé.
empty="$WORK/vide"; mkdir -p "$empty"
out="$(run_start "$empty")" || fail "le démarrage ne doit jamais échouer"
[ "$(printf '%s' "$out" | field hookEventName)" = "SessionStart" ] || fail "événement SessionStart attendu"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_MISSING' || fail "absence de gstack non signalée"
printf '%s' "$out" | field additionalContext | grep -q 'GSTACK_AUTO_INSTALL=0' || fail "raison de l'échec absente"
printf '%s' "$out" | field additionalContext | grep -q 'install-gstack.sh' || fail "commande pour réessayer absente"
[ -z "$(ls -A "$empty")" ] || fail "rien ne doit être créé quand l'installation est désactivée"
out="$(run_check "$empty")"; code=$?
[ "$code" = "2" ] || fail "les compétences doivent être refusées sans gstack (code $code)"
[ "$(printf '%s' "$out" | field permissionDecision)" = "deny" ] || fail "refus PreToolUse attendu"
printf '%s' "$out" | field permissionDecisionReason | grep -q 'install-gstack.sh' || fail "le refus doit indiquer l'installateur"

# 2. gstack absent : le démarrage l'installe (mode équipe), une seule fois.
home="$WORK/auto"; mkdir -p "$home"
out="$(run_auto "$home")" || fail "démarrage avec installation"
printf '%s' "$out" | field additionalContext |
  grep -q "^GSTACK_OK : gstack vient d'être installé automatiquement ($home/.claude/skills/gstack)" || fail "installation automatique non faite"
[ -d "$home/.claude/skills/gstack/bin" ] && [ -f "$home/.claude/skills/gstack/setup" ] || fail "gstack absent après installation"
[ "$(cat "$home/setup-args")" = "--team" ] || fail "setup doit être lancé en mode équipe (reçu : $(cat "$home/setup-args"))"
[ "$(cat "$home/setup-skip")" = "0" ] || fail "Chromium ne doit être sauté que dans une session web"
[ "$(run_check "$home")" = "{}" ] || fail "compétences refusées après installation"
rm -f "$home/setup-args"
out="$(run_auto "$home")" || fail "second démarrage"
printf '%s' "$out" | field additionalContext | grep -q "^GSTACK_OK : gstack est installé" || fail "second démarrage"
[ ! -e "$home/setup-args" ] || fail "gstack ne doit pas être réinstallé"

# 3. Échecs : jamais bloquants, raison donnée, rien de faussement « installé ».
home="$WORK/echec-setup"; mkdir -p "$home"
out="$(run_auto "$home" FAUX_SETUP_ECHEC=1)" || fail "un échec ne doit pas bloquer le démarrage"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_MISSING.*installation de gstack échouée (code 3' || fail "échec de setup non signalé"
[ ! -e "$home/.claude/skills/gstack" ] || fail "un setup en échec ne doit pas laisser gstack pour installé"
grep -q 'setup en échec' "$home/.gstack/installation-auto.log" || fail "journal d'installation incomplet"
[ "$(run_check "$home")" != "{}" ] || fail "compétences acceptées après un échec"
out="$(run_auto "$home")" || fail "nouvel essai"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_OK' || fail "le démarrage suivant doit réessayer"

# Setup trop long : arrêté avant le délai du hook, puis repris à la session suivante.
home="$WORK/trop-long"; mkdir -p "$home"
started=$(date +%s)
out="$(run_auto "$home" FAUX_SETUP_LENT=1 GSTACK_INSTALL_BUDGET_SEC=3)" || fail "setup trop long : démarrage bloqué"
[ $(( $(date +%s) - started )) -lt 15 ] || fail "le setup trop long doit être arrêté à la fin du budget"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_MISSING.*installation de gstack trop longue' || fail "dépassement du délai non signalé"
[ ! -e "$home/.claude/skills/gstack" ] || fail "un setup arrêté ne doit pas laisser gstack pour installé"

home="$WORK/echec-depot"; mkdir -p "$home"
out="$(run_auto "$home" GSTACK_REPO_URL="$WORK/inexistant")" || fail "dépôt introuvable : démarrage bloqué"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_MISSING.*téléchargement de gstack impossible' || fail "échec du clonage non signalé"
[ -z "$(ls -A "$home/.claude/skills" 2>/dev/null)" ] || fail "clonage partiel laissé en place"

no_bun_path="$(printf '%s' "$PATH" | tr ':' '\n' | while IFS= read -r d; do
  [ -n "$d" ] && [ ! -e "$d/bun" ] && [ ! -e "$d/bun.exe" ] && printf '%s:' "$d"; done)"
home="$WORK/sans-bun"; mkdir -p "$home"
out="$(printf '{}' | quiet_env HOME="$home" PATH="$no_bun_path" GSTACK_REPO_URL="$FAKE" bash "$START")" || fail "sans bun"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_MISSING.*bun est requis' || fail "bun manquant non signalé"

home="$WORK/verrou"; mkdir -p "$home/.gstack/installation-auto.lock"
out="$(run_auto "$home" GSTACK_LOCK_WAIT_SEC=0)" || fail "verrou"
printf '%s' "$out" | field additionalContext | grep -q 'autre installation de gstack est en cours' || fail "installation concurrente non signalée"
# Verrou laissé par une installation tuée en route : retiré, l'installation se fait.
if touch -d '20 minutes ago' "$home/.gstack/installation-auto.lock" 2>/dev/null; then
  out="$(run_auto "$home" GSTACK_LOCK_WAIT_SEC=0)" || fail "verrou ancien"
  printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_OK' || fail "un verrou ancien ne doit pas bloquer l'installation"
  [ ! -e "$home/.gstack/installation-auto.lock" ] || fail "verrou non libéré après l'installation"
fi

# 4. Codex : compétences gstack-* (noms préfixés) installées par le même script.
home="$WORK/codex"; mkdir -p "$home/.claude/skills"
git clone -q "$FAKE" "$home/.claude/skills/gstack" 2>/dev/null || fail "gstack déjà installé pour Claude Code"
dir="$(quiet_env HOME="$home" PATH="$TOOLS:$PATH" bash "$INSTALL" codex </dev/null)" || fail "installation Codex"
[ "$dir" = "$home/.claude/skills/gstack" ] || fail "dossier gstack attendu pour Codex (reçu : $dir)"
[ "$(cat "$home/setup-args")" = "--host codex --prefix" ] || fail "commande Codex officielle attendue"
[ -f "$home/.codex/skills/gstack-review/SKILL.md" ] || fail "compétences Codex absentes"
[ -d "$home/.claude/skills/gstack/bin" ] || fail "une installation existante ne doit pas être déplacée"

# Codex avec GSTACK_ROOT : la source est choisie, mais les compétences
# gstack-* restent exigées (revue Codex de la PR #7).
home="$WORK/codex-root"; mkdir -p "$home"
git clone -q "$FAKE" "$home/source-gstack" 2>/dev/null || fail "source GSTACK_ROOT"
dir="$(quiet_env HOME="$home" GSTACK_ROOT="$home/source-gstack" PATH="$TOOLS:$PATH" bash "$INSTALL" codex </dev/null)" ||
  fail "installation Codex avec GSTACK_ROOT"
[ "$dir" = "$home/source-gstack" ] || fail "GSTACK_ROOT doit rester la source (reçu : $dir)"
[ "$(cat "$home/setup-args" 2>/dev/null)" = "--host codex --prefix" ] || fail "GSTACK_ROOT ne doit pas dispenser des compétences Codex"
[ -f "$home/.codex/skills/gstack-review/SKILL.md" ] || fail "compétences Codex absentes avec GSTACK_ROOT"

# Seconde session pendant le setup d'une première : gstack n'est pas encore
# prêt même si bin/ existe (revue Codex de la PR #7).
home="$WORK/concurrente"; mkdir -p "$home/.claude/skills" "$home/.gstack/installation-auto.lock"
git clone -q "$FAKE" "$home/.claude/skills/gstack" 2>/dev/null || fail "installation en cours simulée"
out="$(run_auto "$home" GSTACK_LOCK_WAIT_SEC=0)" || fail "seconde session bloquée"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_MISSING.*autre installation de gstack est en cours' ||
  fail "une installation en cours ne doit pas passer pour terminée"
( sleep 2; rmdir "$home/.gstack/installation-auto.lock" ) &
started=$(date +%s)
out="$(run_auto "$home" GSTACK_LOCK_WAIT_SEC=20)" || fail "seconde session en attente"
wait
[ $(( $(date +%s) - started )) -ge 2 ] || fail "la seconde session doit attendre la fin de la première"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_OK' || fail "gstack prêt après la première installation"
[ ! -e "$home/setup-args" ] || fail "la seconde session ne doit pas relancer setup"

# 5. Session web Claude Code : Chromium préinstallé, rien à télécharger.
home="$WORK/web"; mkdir -p "$home" "$WORK/pw"
printf '#!/bin/sh\n' >"$WORK/pw/chromium"; chmod +x "$WORK/pw/chromium"
: >"$WORK/env-session"
out="$(run_auto "$home" CLAUDE_CODE_REMOTE=true CLAUDE_ENV_FILE="$WORK/env-session" PLAYWRIGHT_BROWSERS_PATH="$WORK/pw")" || fail "session web"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_OK' || fail "installation en session web"
[ "$(cat "$home/setup-skip")" = "1" ] || fail "le téléchargement de Chromium doit être sauté en session web"
grep -q "^export GSTACK_CHROMIUM_PATH=.*pw/chromium" "$WORK/env-session" || fail "chemin de Chromium non transmis à gstack"

# 6. Rappel à chaque demande : jamais d'installation, jamais de blocage.
home="$WORK/rappel"; mkdir -p "$home"
out="$(printf '{}' | quiet_env HOME="$home" PATH="$TOOLS:$PATH" GSTACK_REPO_URL="$FAKE" bash "$START" UserPromptSubmit)" || fail "rappel"
[ "$(printf '%s' "$out" | field hookEventName)" = "UserPromptSubmit" ] || fail "événement UserPromptSubmit attendu"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_MISSING.*install-gstack.sh' || fail "rappel sans gstack"
[ -z "$(ls -A "$home")" ] || fail "le rappel ne doit rien installer"
mkdir -p "$home/.claude/skills/gstack/bin"
out="$(printf '{}' | quiet_env HOME="$home" bash "$START" UserPromptSubmit)" || fail "rappel avec gstack"
printf '%s' "$out" | field additionalContext | grep -q '^gstack : .*review avant livraison' || fail "parcours non rappelé"

# 7. Installations existantes (Claude Code, Codex, dépôt migré) : acceptées sans rien relancer.
for dir in .claude/skills/gstack .codex/skills/gstack .gstack/repos/gstack; do
  home="$WORK/home-${dir//\//_}"; mkdir -p "$home/$dir/bin"
  out="$(run_auto "$home")" || fail "démarrage ($dir)"
  printf '%s' "$out" | field additionalContext | grep -q "^GSTACK_OK : gstack est installé ($home/$dir)" || fail "gstack non trouvé dans $dir"
  [ ! -e "$home/setup-args" ] || fail "setup relancé alors que gstack est dans $dir"
  [ "$(run_check "$home")" = "{}" ] || fail "compétences refusées alors que gstack est dans $dir"
done

# 8. Chemin avec guillemets et barres obliques inverses : JSON toujours valide
#    (noms interdits par Windows : vérifié ailleurs).
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) odd="$WORK/a\"b\\c"; mkdir -p "$odd/.claude/skills/gstack/bin"
     run_start "$odd" | field additionalContext | grep -q 'GSTACK_OK' || fail "JSON invalide pour un chemin inhabituel" ;;
esac

# 9. GSTACK_ROOT explicite et événement inconnu ramené à SessionStart.
custom="$WORK/custom"; mkdir -p "$custom/bin"
out="$(printf '{}' | HOME="$empty" GSTACK_ROOT="$custom" bash "$START" Autre)"
[ "$(printf '%s' "$out" | field hookEventName)" = "SessionStart" ] || fail "événement par défaut"
printf '%s' "$out" | field additionalContext | grep -q "($custom)" || fail "GSTACK_ROOT ignoré"

# 10. Lancé à la main par un agent dont l'entrée standard reste ouverte : le
#     hook ne l'attend pas (auparavant bloqué jusqu'au délai de l'agent).
# Regression: ISSUE-001 — hook de démarrage bloqué par une entrée standard ouverte
# Found by /review on 2026-09-29
# Report: .gstack/qa-reports/run-20260929T220650Z/qa-report-127.0.0.1-2026-09-29.md
started=$(date +%s)
out="$(quiet_env HOME="$empty" GSTACK_AUTO_INSTALL=0 bash "$START" < <(sleep 20))" || fail "démarrage avec entrée ouverte"
[ $(( $(date +%s) - started )) -lt 10 ] || fail "le hook attend une entrée standard qui ne se ferme pas"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_MISSING' || fail "sortie invalide avec entrée ouverte"

# 11. Les réglages du projet enregistrent les trois hooks, avec un délai qui
#     laisse le temps d'installer gstack.
SETTINGS="$ROOT/.claude/settings.json"
command -v cygpath >/dev/null 2>&1 && SETTINGS="$(cygpath -w "$SETTINGS")"
node -e '
const s = require(process.argv[1]);
const start = s.hooks.SessionStart?.[0]?.hooks?.[0] || {};
const prompt = s.hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command || "";
const pre = s.hooks.PreToolUse?.find(e => e.matcher === "Skill")?.hooks?.[0]?.command || "";
if (!/gstack-session-start\.sh"? SessionStart$/.test(start.command || "") || !(start.timeout >= 300)) process.exit(1);
if (!/gstack-session-start\.sh"? UserPromptSubmit$/.test(prompt) || !pre.includes("check-gstack.sh")) process.exit(1);
' "$SETTINGS" || fail "hooks absents ou délai trop court dans .claude/settings.json"

echo "Hooks gstack Claude Code : installation automatique au démarrage, rappel à chaque demande, refus des compétences sans gstack OK"
