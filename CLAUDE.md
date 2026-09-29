# File karaoké — règles de travail

gstack est obligatoire pour les changements de code : utiliser `investigate` pour un défaut, `qa` pour les parcours navigateur et `review` avant livraison. Au démarrage de chaque session, le hook `.claude/hooks/gstack-session-start.sh` vérifie l'installation sans rien installer ; si gstack manque (`GSTACK_MISSING`), le dire à l'utilisateur avant tout changement de code et ne pas l'installer sans son accord. Le hook `check-gstack.sh`, sur le modèle officiel `gstack-team-init required`, refuse ensuite les compétences tant que gstack manque.

Après toute modification de la file, des duos, des présences ou des tables, lancer `node test/run-offline.js` et consigner le résultat dans `RAPPORT-TEST.md`. Le vrai KaraFun ne doit pas servir aux essais destructifs si son code de télécommande actuel n'a pas été vérifié.
