#!/usr/bin/env bash
# Garde-fou de projet, sur le modèle de gstack-team-init required.
# Empêche l'emploi des compétences de code si gstack n'est pas installé.
set -eu

# Même résolution que le mode équipe officiel (tous les hôtes gstack).
GSTACK_DIR=""
for candidate in "${GSTACK_ROOT:-}" "$HOME/.claude/skills/gstack" "$HOME/.codex/skills/gstack" \
  "$HOME/.factory/skills/gstack" "$HOME/.kiro/skills/gstack" "$HOME/.config/opencode/skills/gstack" \
  "$HOME/.slate/skills/gstack" "$HOME/.cursor/skills/gstack" "$HOME/.openclaw/skills/gstack" \
  "$HOME/.hermes/skills/gstack" "$HOME/.gbrain/skills/gstack" "$HOME/.copilot/skills/gstack" "$HOME/.gstack/repos/gstack"; do
  if [ -z "$GSTACK_DIR" ] && [ -n "$candidate" ] && [ -d "$candidate/bin" ]; then
    GSTACK_DIR="$candidate"
  fi
done

if [ -z "$GSTACK_DIR" ]; then
  echo 'gstack est requis dans ce projet. Lance bash .claude/hooks/install-gstack.sh puis relance ton agent.' >&2
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"gstack est requis pour les modifications de code de ce projet : lancer bash .claude/hooks/install-gstack.sh (installation acceptée par l’utilisateur), puis redémarrer l’agent."}}'
  exit 2
fi

echo '{}'
