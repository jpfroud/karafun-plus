# File karaoké — règles de travail

gstack est obligatoire pour les changements de code : utiliser `investigate` pour un défaut, `qa` pour les parcours navigateur et `review` avant livraison. L'installation est vérifiée par le hook de ce projet, créé sur le modèle officiel `gstack-team-init required`.

Après toute modification de la file, des duos, des présences ou des tables, lancer `node test/run-offline.js` et consigner le résultat dans `RAPPORT-TEST.md`. Le vrai KaraFun ne doit pas servir aux essais destructifs si son code de télécommande actuel n'a pas été vérifié.
