#!/usr/bin/env bash
# Garde-fou de projet, sur le modèle de gstack-team-init required.
# Empêche l'emploi des compétences de code si gstack n'est pas installé.
set -eu

GSTACK_DIR=""
for candidate in "${GSTACK_ROOT:-}" "$HOME/.claude/skills/gstack" "$HOME/.codex/skills/gstack" "$HOME/.gstack/repos/gstack"; do
  if [ -z "$GSTACK_DIR" ] && [ -n "$candidate" ] && [ -f "$candidate/gstack/SKILL.md" -o -f "$candidate/SKILL.md" ]; then
    GSTACK_DIR="$candidate"
  fi
done

if [ -z "$GSTACK_DIR" ]; then
  echo 'gstack est requis dans ce projet. Installe-le depuis https://github.com/garrytan/gstack puis relance ton agent.' >&2
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"gstack est requis pour les modifications de code de ce projet."}}'
  exit 2
fi

echo '{}'
