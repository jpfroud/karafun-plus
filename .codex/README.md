# Hook gstack pour Codex

Le fichier `hooks.json` ajoute à chaque prompt un rappel du parcours gstack prévu par `AGENTS.md`. Si gstack manque, il demande à Codex de lancer `bash .claude/hooks/install-gstack.sh codex` (installation acceptée par l'utilisateur) ; le hook lui-même n'installe rien, son délai étant trop court. Le script n'interdit pas les commandes : en cas d'erreur ou de JSON inattendu, il se termine sans bloquer Codex. Le respect du parcours est vérifié par la revue et les tests, pas démontré par le seul hook.

Après avoir cloné ce dépôt, ouvrir `/hooks` dans Codex, examiner puis approuver le hook de projet. Codex ne lance pas les hooks locaux non approuvés. Sous Windows, le hook utilise PowerShell et retrouve sa position avec `git rev-parse --show-toplevel`, même si Codex a été ouvert dans un sous-dossier.

Test direct, sans nouvelle session Codex : `pwsh.exe -NoProfile -File test/gstack-hook.test.ps1` (PowerShell 7, disponible sur le PC de développement). Le script teste la commande du hook depuis la racine et un sous-dossier. Un changement du hook demandera une nouvelle approbation dans `/hooks`. Si un problème de démarrage réapparaît, renommer temporairement `.codex/hooks.json` en `hooks.json.disabled`, puis examiner la configuration du hook et relancer ce test ; conserver `AGENTS.md` comme règle de travail pendant le diagnostic.
