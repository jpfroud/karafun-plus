# Contribuer

Les règles de travail complètes sont dans [AGENTS.md](AGENTS.md) ; ce fichier en
donne l'essentiel pour ouvrir une PR.

## Préparer le poste

- Node.js 22, puis `npm ci --ignore-scripts`.
- Java 25 et Maven pour l'optimiseur : `mvn -B -f solver/pom.xml verify`.
- `npm run demo` lance une simulation sans toucher à KaraFun. La session
  KaraFun réelle ne sert jamais aux essais destructifs.

## Avant d'ouvrir une PR

1. Partir de `main` à jour, sur une branche à part.
2. Ajouter un test de régression pour chaque défaut corrigé ou cas nouveau.
3. Lancer la suite hors ligne : `node test/run-offline.js`, et consigner le
   résultat et ses limites dans `RAPPORT-TEST.md`.
4. Pour un changement de la rotation ou des temps d'attente (choix du passage,
   tours, dettes, duos, présences, Timefold, statistiques d'attente), joindre
   le bilan avant/après d'une vraie soirée :
   `node test/rejeu-soiree.js test/fixtures/soiree-2026-10-15-anonyme.json --avant <commit de départ> --solveur --cles`.
   Un changement qui déséquilibre les passages ne se fusionne pas sans accord
   explicite (AGENTS.md).
5. Garder les deux modes cohérents, le kit Windows et le serveur Linux, et
   mettre à jour `DEPLOIEMENT-SERVEUR.md` si `deploy/`, le `Dockerfile` ou une
   variable `KARAOKE_*` change.
6. Remplir le modèle de PR : changement, vérifications, bilan, sécurité.

## Ce qui ne va jamais dans le dépôt

Prénoms, noms de table, hôtes ou adresses réels, codes de télécommande KaraFun,
clé du bar, `data/`, `journal/`, `deploy/.env` et les archives de
`deploy/sauvegardes/`. Les bilans utilisent les clés anonymes S01… et T1….

## Dépendances et workflows

Une nouvelle dépendance se justifie dans la PR. Une action GitHub s'ajoute
épinglée par SHA complet, avec sa version en commentaire, dans un workflow au
moindre droit : `node test/workflows.test.js` le vérifie. Détail et réglages du
dépôt : [SECURITY.md](SECURITY.md).

## Signaler une faille

Jamais par une issue publique : suivre [SECURITY.md](SECURITY.md).
