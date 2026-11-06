## Changement

<!-- Ce que fait la PR et pourquoi, en quelques lignes. -->

## Type

- [ ] Correctif
- [ ] Fonctionnalité
- [ ] Rotation ou temps d'attente (choix du passage, tours, dettes, duos, présences, Timefold, statistiques d'attente)
- [ ] Sécurité ou dépendances
- [ ] Documentation
- [ ] CI, image Docker ou déploiement

## Vérifications

- [ ] `node test/run-offline.js` vert, résultat consigné dans `RAPPORT-TEST.md`
- [ ] Relecture `review` (gstack) terminée
- [ ] Les deux modes (kit Windows et serveur Linux) restent cohérents (`AGENTS.md`)
- [ ] `DEPLOIEMENT-SERVEUR.md` à jour si `deploy/`, le `Dockerfile`, une variable `KARAOKE_*` ou une option de `server.js` change
- [ ] Aucun prénom, nom de table, hôte ou code KaraFun réel dans le dépôt

## Bilan avant/après (rotation seulement)

<!-- Tableau de `node test/rejeu-soiree.js <export.json> --avant <commit> --solveur --cles`
     (ou résumé du workflow « Bilan Timefold ») : attentes, équilibre des
     passages (Jain), anomalies, personnes qui y perdent ou y gagnent. -->

## Sécurité

<!-- Nouvelle dépendance, droit, secret, entrée ou sortie réseau ? Sinon : aucun. -->
