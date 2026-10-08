# KaraFun Plus

File de karaoké pour un bar : les clients choisissent leurs titres depuis le QR de leur table et les gérants pilotent la rotation et la file KaraFun. L'application est une interface web locale qui communique avec la télécommande KaraFun. Ce protocole n'est pas une API publique garantie par KaraFun.

## Démarrage

Sur le PC du bar, télécharger et décompresser le kit Windows de la dernière release, puis double-cliquer sur **KaraFun Plus.exe**. KaraFun doit être installé séparément ; activer sa télécommande et saisir son code sur la page du bar. Le kit contient Node.js, l'optimiseur de file et son Java intégré : aucun outil de développement n'est nécessaire sur ce PC. Voir [le guide du bar](GUIDE-BAR.md) pour les QR, les droits, la sauvegarde et l'accès des téléphones hors Wi-Fi.

Pour accueillir une personne venue seule, le bar émet un QR individuel depuis sa page de gestion. Il crée une seule place dès son ouverture, puis reste la clé de la soirée : rouvert sur un autre téléphone, il propose de récupérer les mêmes chansons. Il n'y a pas de QR commun « En solo » à afficher, sauf en mode « Événement privé » (bar privatisé), où un seul QR inscrit chaque nouveau navigateur qui le scanne (un autre téléphone, ou une autre application sur le même téléphone). Pour un changement de téléphone, le téléphone actuel (ou le bar) affiche aussi un QR code de transfert, envoyable en lien par WhatsApp, SMS ou e-mail, avec un code à 4 chiffres en secours.

Pour travailler depuis les sources : `npm ci`, Java 21 et Maven pour construire `solver/pom.xml`, puis `node test/run-offline.js` pour la recette isolée. `npm run demo` démarre une simulation sans toucher à KaraFun. La CI Windows construit le solveur, lance les tests et vérifie le kit. Un tag `v*` publie une release Windows ; le workflow de publication peut aussi être déclenché manuellement depuis GitHub, mais seulement depuis `main`.

**Version de test d'une branche** (sans publication) : chaque exécution de « Tests Windows » garde le kit construit pendant 14 jours. Ouvrir l'onglet Actions → « Tests Windows » → « Run workflow », choisir la branche, puis, une fois l'exécution verte, télécharger l'artefact `kit-bar-test-…` en bas de sa page. Il contient `KIT-BAR-KARAFUN.zip`, à décompresser sur le PC du bar comme une release. Une PR produit le même artefact automatiquement.

Les fichiers `data/`, `journal/` et les codes de télécommande ne doivent pas être publiés. Les QR clients donnent accès à une table ; le lien de gestion du bar reste privé.

Un [document de reprise](CONTEXTE-REPRISE.md) résume l'architecture, les décisions et les limites pour poursuivre le projet avec un autre agent.
