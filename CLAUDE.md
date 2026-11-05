# File karaoké — règles de travail

gstack est obligatoire pour les changements de code : chaque demande commence par le choix d'une commande gstack annoncé en une ligne (table de routage dans `AGENTS.md`) — `investigate` pour un défaut, `spec` pour une fonctionnalité à préciser, `qa` pour les parcours navigateur et `review` avant livraison. Le hook `gstack-gate.js` refuse toute modification du dépôt tant qu'aucune compétence gstack n'a été lancée dans la session, et le hook git `pre-push` (installé au démarrage) exige que le dernier commit envoyé sur chaque branche ait exactement le contenu d'une relecture `review` terminée (les commits intermédiaires ne sont pas comparés). L'utilisateur a demandé qu'il s'installe tout seul : au démarrage de chaque session, le hook `.claude/hooks/gstack-session-start.sh` lance `install-gstack.sh` si gstack manque (clonage officiel puis `./setup --team`), et le même hook rappelle le parcours à chaque demande (`UserPromptSubmit`). Si l'installation échoue (`GSTACK_MISSING`), donner la raison à l'utilisateur avant tout changement de code et réessayer avec `bash .claude/hooks/install-gstack.sh`. Le hook `check-gstack.sh`, sur le modèle officiel `gstack-team-init required`, refuse les compétences tant que gstack manque. Un sous-agent chargé d'un changement de code suit le même parcours.

Après toute modification de la file, des duos, des présences ou des tables, lancer `node test/run-offline.js` et consigner le résultat dans `RAPPORT-TEST.md`. Le vrai KaraFun ne doit pas servir aux essais destructifs si son code de télécommande actuel n'a pas été vérifié.

Tout changement de la rotation ou des temps d'attente (choix du passage, tours, dettes, duos, présences, Timefold, statistiques d'attente) se juge sur une vraie soirée, avec un **bilan chiffré avant/après** donné à l'utilisateur à chaque fois : rejouer la dernière soirée exportée qu'il a fournie (sinon `test/fixtures/soiree-2026-10-15-anonyme.json`) avec l'ancien et le nouveau code, `node test/rejeu-soiree.js <export.json> --avant <commit de départ> --solveur` (Timefold, comme au bar), et lui présenter le tableau : attentes, attente sans monter sur scène, équilibre des passages, anomalies, personnes qui y perdent ou y gagnent. Un changement qui déséquilibre les passages (indice de Jain en baisse, des gens qui passent plus que d'autres, quelqu'un qui perd un passage ou attend nettement plus) n'est pas bon, sauf accord explicite de l'utilisateur. Détails dans `AGENTS.md`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. Route only to skills in the session's available-skills list; answer directly for quick questions or small scoped edits.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate, unless one read-only check confirms the cause and a narrow fix (then fix it and run the focused test)
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
