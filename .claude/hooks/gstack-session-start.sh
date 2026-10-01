#!/usr/bin/env bash
# Hook de Claude Code (.claude/settings.json) ; tout autre agent peut le
# lancer lui-même, voir AGENTS.md.
#
#   bash .claude/hooks/gstack-session-start.sh [SessionStart|UserPromptSubmit]
#
# SessionStart : installe gstack s'il manque (install-gstack.sh, demandé par
# l'utilisateur) puis rappelle le parcours obligatoire du projet.
# UserPromptSubmit : rappelle ce parcours à chaque demande, sans rien
# installer. Ne bloque jamais l'agent (code de sortie 0) ; le hook PreToolUse
# check-gstack.sh refuse ensuite les compétences si gstack manque toujours.

EVENT="${1:-SessionStart}"
case "$EVENT" in SessionStart|UserPromptSubmit) ;; *) EVENT=SessionStart ;; esac

# Le JSON de l'événement (entrée standard) n'est pas lu : un agent qui lance
# ce script sans fermer son entrée le bloquerait jusqu'à son délai.

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"

# Même résolution que check-gstack.sh et que le mode équipe officiel.
GSTACK_DIR=""
for candidate in "${GSTACK_ROOT:-}" "$HOME/.claude/skills/gstack" "$HOME/.codex/skills/gstack" \
  "$HOME/.factory/skills/gstack" "$HOME/.kiro/skills/gstack" "$HOME/.config/opencode/skills/gstack" \
  "$HOME/.slate/skills/gstack" "$HOME/.cursor/skills/gstack" "$HOME/.openclaw/skills/gstack" \
  "$HOME/.hermes/skills/gstack" "$HOME/.gbrain/skills/gstack" "$HOME/.gstack/repos/gstack"; do
  if [ -z "$GSTACK_DIR" ] && [ -n "$candidate" ] && [ -d "$candidate/bin" ]; then
    GSTACK_DIR="$candidate"
  fi
done

INSTALLED=""
REASON=""
if [ -z "$GSTACK_DIR" ] && [ "$EVENT" = SessionStart ]; then
  ERRORS="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/gstack-installation-$$")"
  GSTACK_DIR="$(bash "$HOOKS_DIR/install-gstack.sh" claude 2>"$ERRORS" </dev/null | tail -n 1)"
  REASON="$(tail -n 1 "$ERRORS" 2>/dev/null)"
  rm -f "$ERRORS"
  [ -n "$GSTACK_DIR" ] && [ -d "$GSTACK_DIR/bin" ] && INSTALLED=1 || GSTACK_DIR=""
fi

# Session web : gstack se sert du Chromium déjà installé.
CHROMIUM="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}/chromium"
if [ "$EVENT" = SessionStart ] && [ "${CLAUDE_CODE_REMOTE:-}" = true ] && [ -n "${CLAUDE_ENV_FILE:-}" ] &&
   [ -z "${GSTACK_CHROMIUM_PATH:-}" ] && [ -x "$CHROMIUM" ]; then
  printf 'export GSTACK_CHROMIUM_PATH=%q\n' "$CHROMIUM" >>"$CLAUDE_ENV_FILE"
fi

RULES="Parcours obligatoire du projet : investigate pour un défaut, qa pour les parcours navigateur, review avant livraison. Après toute modification de la file, des duos, des présences ou des tables : node test/run-offline.js, puis consigner le résultat dans RAPPORT-TEST.md."
RETRY="L'utilisateur a donné son accord : pour réessayer, lancer bash .claude/hooks/install-gstack.sh puis redémarrer l'agent. En attendant, faire les vérifications équivalentes et ne jamais prétendre avoir exécuté une compétence."
if [ "$EVENT" = UserPromptSubmit ]; then
  if [ -n "$GSTACK_DIR" ]; then
    MESSAGE="gstack : appliquer la compétence adaptée à cette demande. $RULES"
  else
    MESSAGE="GSTACK_MISSING : gstack est obligatoire mais pas installé. Le dire à l'utilisateur avant tout changement de code. $RETRY $RULES"
  fi
elif [ -n "$INSTALLED" ]; then
  MESSAGE="GSTACK_OK : gstack vient d'être installé automatiquement ($GSTACK_DIR). $RULES"
elif [ -n "$GSTACK_DIR" ]; then
  MESSAGE="GSTACK_OK : gstack est installé ($GSTACK_DIR). $RULES"
else
  MESSAGE="GSTACK_MISSING : gstack est obligatoire dans ce dépôt et son installation automatique a échoué : ${REASON:-raison inconnue}. Le dire tout de suite à l'utilisateur, avant tout changement de code. $RETRY $RULES"
fi

json_escape() {
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  text="${text//$'\n'/ }"
  text="${text//$'\r'/ }"
  text="${text//$'\t'/ }"
  printf '%s' "$text"
}

printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' \
  "$EVENT" "$(json_escape "$MESSAGE")"
exit 0
