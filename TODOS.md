# TODOS

Travail reporté par les relectures de plan (gstack `autoplan`), avec son contexte. Les décisions viennent de `docs/designs/retours-2026-11-08.md`.

## Statistiques

### Découper ou rattacher une soirée à la main dans /stats

**What:** Dans la page des statistiques, « Séparer la soirée ici » et « Rattacher à la soirée précédente ».

**Why:** La réparation automatique ne coupe qu'aux frontières de 8 h du matin. Deux soirées le même jour, ou un après-midi privatisé suivi d'une soirée, restent dans un seul journal.

**Context:** Proposé et reporté par la relecture du 9 novembre 2026 (X4). La réparation automatique (`EveningJournal.repair`, lot A4 du plan) garde l'original dans `data/soirees-originales/` ; un outil manuel devra réutiliser ce découpage (lignes reportées, identifiants déterministes, écritures `.tmp` puis renommage) plutôt que d'en écrire un second. Risque : une chirurgie manuelle des archives, à réserver au bar. Il doit aussi rattacher une soirée découpée alors qu'elle était en cours : sa copie d'origine n'a pas la suite, et le retour à l'original (DEPLOIEMENT-SERVEUR, §18) ne la couvre pas.

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026 (règle de bornage et réparation).

### Une règle de bornage nouvelle repart des originaux

**What:** Si la règle de bornage change (règle v2 de `data/soirees/.bornage.json`), la réparation repart des copies d'origine de `data/soirees-originales/<id>/`, jamais des morceaux déjà découpés par la règle v1.

**Why:** Recouper des morceaux v1 empilerait des lignes reportées sur des lignes reportées. Une soirée remise d'origine à la main (DEPLOIEMENT-SERVEUR, §18, marquée `'ok'`) doit aussi être recoupée depuis son original.

**Context:** Reporté par la relecture CEO du 9 novembre 2026 (S10.3) : aucune règle v2 n'est prévue. L'index (`rule: 'v1'`) et `meta.split` (`from`, `part`, génération) disent déjà quelle règle a coupé chaque morceau (lot A4 du plan). Garder les identifiants des morceaux v1 quand leurs coupures ne changent pas, pour ne pas casser les liens des archives. L'outil manuel X4, plus haut, suit le même principe.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026.

### Script d'export des indicateurs de résultat

**What:** Un script qui lit les exports des soirées et donne, soirée par soirée : la part des invitations de duo expirées sans réponse, le délai entre l'arrivée d'une personne et son premier titre demandé, le nombre de Battles proposées et de duos ouverts, et le nombre de « Pas prêt ».

**Why:** L'avant/après du plan du 8 novembre se mesure en pixels et en mots. Ces indicateurs disent si les pages servent mieux le bar : moins d'invitations perdues, un premier titre demandé plus tôt, plus de duos et de Battles.

**Context:** Reporté par la relecture CEO du 9 novembre 2026 (F10) ; la note finale au gérant les cite. Les événements existent déjà au journal : `duo.invited` et `duo.inviteExpired`, `person.joined` et `song.requested`, `battle.proposed`, `duo.openRequested`, `defer.requested`. Comparer les mêmes indicateurs sur les soirées d'avant et d'après la livraison, sans prénom (clés S… de l'export). Outil d'essai hors de `livrable.json`, comme `test/rejeu-soiree.js`, avec son test dans `test/run-offline.js`.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lots B et E du plan du 8 novembre 2026, et quelques soirées exportées après la livraison.

### Outil du mainteneur pour les soirées d'origine

**What:** Une commande du mainteneur qui refait un export anonymisé d'une soirée d'origine gardée dans `data/soirees-originales/<id>/<g>/` (`exportEvening` sur ses fichiers, sortie hors du dépôt), et qui peut faire le retour à l'original décrit au §18 de DEPLOIEMENT-SERVEUR.

**Why:** Après l'installation de la v3.3.0, seule la copie d'origine garde une soirée mélangée entière, et aucune page ne l'exporte. L'export et le retour à l'original se font alors à la main, sur des fichiers qui portent les prénoms.

**Context:** Reporté par la relecture CEO du 9 novembre 2026 (lot A, export de la soirée fusionnée des 6 et 7 novembre). La réparation (A4) garde chaque copie d'origine par génération, avec `copie-complete`. Le retour à l'original ne vaut que pour une soirée close quand sa copie a été prise (`endedAt` dans le `meta.json` de la copie) : une soirée coupée pendant qu'elle était en cours n'a pas, dans sa copie, les lignes écrites après la coupure ; elle se rattache par « Rattacher à la soirée précédente » (X4, plus haut). L'outil réutilise `exportEvening`, et le découpage d'un tel export reste celui de `test/rejeu-soiree.js --soiree` : aucun second découpeur. Il n'écrit jamais de prénom dans le dépôt.

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026 (réparation et copies d'origine).

### Essai à blanc de la réparation des soirées

**What:** Une valeur `KARAOKE_REPAIR=essai` qui fait tourner la réparation sans rien écrire : pour chaque soirée, `eveningBreaks` et `planSplit` (lot A4) donnent les coupures prévues, écrites au journal du serveur en lignes « Réparation (essai) : … », sans copie, sans morceau et sans `.bornage.json`. Le découpage en direct reste coupé, comme avec `off`.

**Why:** La réparation réécrit les journaux au premier démarrage de la v3.3.0. Un essai à blanc, sur l'installation ou sur une copie de `data`, dirait d'avance au mainteneur quelles soirées seront coupées, et où.

**Context:** Proposé par la relecture DX du 10 novembre 2026 (M6) et reporté : c'est un mode nouveau, hors du périmètre de la relecture. La migration n'est pas à sens unique : la copie de `data/soirees-originales/` et le retour à l'original (DEPLOIEMENT-SERVEUR, §18) gardent chaque soirée, et une version d'avant la v3.3.0 lit les soirées découpées. Sur un export, `node test/rejeu-soiree.js <export> --soiree liste` montre déjà les coupures (lot A7). Aujourd'hui, `essai` est une valeur non reconnue, qui coupe la réparation par prudence (A4, « Coupure ») : la changer en essai à blanc ne rallume rien. `planSplit` étant pur, l'essai ne touche pas au disque et ne demande aucun second découpeur.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026 (réparation et `KARAOKE_REPAIR`).

## Page participant

### « Chercher un autre duo » depuis le message de refus

**What:** Dans le message « X ne chantera pas « titre » avec Y : « raison » », un bouton qui ouvre la demande de duo ouvert pour ce titre.

**Why:** Après un refus, l'invitant doit aujourd'hui repasser par le menu ⋯ du titre pour chercher un autre partenaire.

**Context:** Proposé et reporté par la relecture du 9 novembre 2026 (X5), pour garder la page aussi légère que possible (demande du gérant). Le flux existe déjà : bouton « Chercher un duo » du titre (`data-duet-open`) et sa confirmation.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P4
**Depends on:** Lots B et E du plan du 8 novembre 2026.

### Suivre un téléphone après plusieurs déplacements de table

**What:** Garder la liste des tables quittées par une personne, pas seulement son dernier déplacement (`movedFrom`), pour qu'un téléphone resté sur la première table la suive aussi après A → B → C.

**Why:** Dans le plan du 8 novembre (C3), ce téléphone oublie la personne et passe par le QR de reprise du bar.

**Context:** Cas accepté par la relecture n° 3 du 9 novembre 2026 (point 1.8) : deux déplacements de la même personne avant que son téléphone ne suive sont rares. `relocated` et `POST /api/table/person/follow` comparent `movedFrom.tableId` à la table présentée ; une liste courte des tables quittées, sauvegardée avec la soirée (`night-state.js`), suffirait. Les règles d'accès ne changent pas : jeton valable, accès de la table présentée tant qu'elle est ouverte, personnes parties ignorées.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P4
**Depends on:** Lot C du plan du 8 novembre 2026.

### Notifications sur un téléphone verrouillé (Web Push), après un comptage

**What:** D'abord, compter par soirée les téléphones qui ont autorisé les notifications, sans prénom ni identifiant dans le journal, et montrer ce nombre dans les statistiques. Ensuite, si ce nombre le justifie, envoyer les demandes et les messages de duo par Web Push (clés du serveur, abonnement par téléphone, envoi par le serveur), pour qu'ils arrivent aussi téléphone verrouillé ou page fermée.

**Why:** Le service worker du plan du 8 novembre (F2a) n'affiche une notification que tant que la page vit en arrière-plan (Chrome Android, ordinateurs). Un iPhone n'en reçoit aucune : Safari ne les donne qu'aux web apps de l'écran d'accueil, et la page n'en est pas une (entrée « Notifications sur iPhone : la page en web app de l'écran d'accueil ») ; un téléphone verrouillé ne reçoit rien (F2b). Le gérant ne veut rater aucune demande.

**Context:** Reporté par la relecture CEO du 9 novembre 2026 (F2c) : infrastructure nouvelle (clés, abonnements, services de push des navigateurs), hors du rayon du plan. Le comptage dit d'abord si l'effort sert : sans téléphones qui autorisent, Web Push n'atteindrait personne. Points de départ : `public/sw.js` (F2a), `systemNotice` (`public/client.html:818-824`), `GUIDE-BAR.md:81` et `:97`. Mode serveur seulement : en mode PC, la page des chanteurs est en HTTP sur le Wi-Fi du bar, où le navigateur refuse notifications et push ; le dire pour les deux modes (AGENTS.md).

**Effort:** L (humain) / M (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot B du plan du 8 novembre 2026 (service worker, F2a), puis le comptage.

### Demandes d'une personne passée à une autre table

**What:** Sur la page d'une table, signaler les demandes (« Je suis là », invitations, votes) des personnes que ce téléphone gère et que le bar a déplacées vers une autre table.

**Why:** Après une scission, un téléphone qui gère des personnes des deux tables ne voit que les demandes de la page ouverte (plan du 8 novembre, C3) : la personne déplacée peut rater son « Je suis là ».

**Context:** Reporté par la relecture CEO du 9 novembre 2026 (section 11). Le message de C3 le dit, et « Ouvrir sa page » ouvre la page de l'autre table dans un nouvel onglet. Il faudrait que la page lise aussi l'état de l'autre table, avec le jeton copié par `follow`, et mette ses demandes dans `pendingActions()` (`client.html`).

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot C du plan du 8 novembre 2026.

### Refus motivé des demandes « Duo ? »

**What:** Une étape « Que dire à {from} ? » au refus d'une demande « Duo ? » (quelqu'un qui demande à chanter sur le titre d'une personne), avec des réponses toutes faites propres à ce cas, choisies par le gérant.

**Why:** Après le plan du 8 novembre, « Refuser » ouvre l'étape de la raison pour une invitation, mais refuse d'un appui une demande « Duo ? », dans la même fenêtre. Les trois réponses de G4 parlent de la chanson proposée (« Je ne la connais pas bien », « Trop dur pour moi ») et ne vont pas à un titre que la personne a choisi elle-même.

**Context:** Reporté par la relecture design du 10 novembre 2026 (M14). Le bouton « Duo ? » s'appelle « Proposer un duo à {name} » (`public/client.html:737`, `:2361`), et la demande n° 1 du gérant parle de « la personne qui invite ». Points de départ : l'étape `decline` de la fenêtre `#attention` (lot B3), `declineWhy` et `DECLINE_TEXT_MAX` (B1), le message `joinRefused` (`public/client.html:1084`), la ligne `duo.joinAnswered` (`lib/scheduler/duets.js:847`), et la règle du petit mot hors de la sauvegarde (F7, `snapshotNight`). Mêmes essais de fuite que le lot B4, et un code de raison qui ne change plus après la livraison.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P4
**Depends on:** Lot B du plan du 8 novembre 2026, et les réponses toutes faites choisies par le gérant.

### Notifications sur iPhone : la page en web app de l'écran d'accueil

**What:** Rendre la page des chanteurs installable sur l'écran d'accueil d'un iPhone (manifeste en `display: standalone`, icône), et y reprendre les personnes de ce téléphone, pour que les notifications du lot B y arrivent.

**Why:** Après le plan du 8 novembre (B4, B5), un iPhone ne reçoit aucune notification : Safari ne les donne qu'aux web apps de l'écran d'accueil, et la page n'en est pas une (ni manifeste ni `apple-mobile-web-app-capable`, `public/client.html:3-9`).

**Context:** Reporté par la relecture ingénierie du 10 novembre 2026. Une web app de l'écran d'accueil a son propre stockage, séparé de Safari : elle n'aurait ni les jetons des personnes (`kfPeople:…`) ni les réglages des notifications, à reprendre par le QR de reprise ou un code. Même installée, une page en arrière-plan s'arrête vite sur iPhone : l'entrée « Notifications sur un téléphone verrouillé (Web Push), après un comptage » décrit l'autre chemin. À vérifier sur un vrai iPhone, au bar.

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P4
**Depends on:** Lot B du plan du 8 novembre 2026 (service worker, décision 2a) ; l'entrée « Notifications sur un téléphone verrouillé (Web Push) ».

## Bar

### « Annuler » exact d'un déplacement de personnes entre tables

**What:** Un bouton « Annuler » de quelques secondes après un déplacement, qui rend l'état exact d'avant (tables, groupes et historique de rotation).

**Why:** Aujourd'hui, défaire un déplacement se fait par un déplacement en sens inverse. La table d'origine revient alors comme une table nouvelle pour la rotation : son historique de groupe n'est pas restauré.

**Context:** Proposé (X2) puis reporté par la relecture du 9 novembre 2026. Il faut un instantané pris avant le déplacement (`lastGroup`, `roundGroups`, `firstCycle`, `recentGroups`, `tableServeCounts`, `groupDepartures`, reçus des titres envoyés). Il ne doit être rendu que si rien n'a bougé depuis (aucun passage, aucun autre geste), sur le modèle de l'annulation des changements manuels (`canUndoManualChange`).

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot C du plan du 8 novembre 2026. Revient dans le lot C avant la livraison si l'aller-retour du bilan C6 (cas 5) est refusé dans l'un des trois réglages, sans défaut du code en cause.

### Contrôle du protocole KaraFun

**What:** À la connexion, vérifier la version de KaraFun et les messages de sa télécommande. Une version ou un message inconnus font passer la file en mode manuel (envoi et lecture automatiques coupés), avec un bandeau au bar qui dit pourquoi.

**Why:** La file suit un protocole que KaraFun ne documente pas (Socket.IO 2.x). Une mise à jour de KaraFun qui le change ferait des envois faux ou perdus en pleine soirée, sans que le bar le sache.

**Context:** Reporté par la relecture CEO du 9 novembre 2026 (F11). Points de départ : `karafun.js` (`KaraFunBridge` et la détection des réglages pris en charge), `karafun-state.js` (`analyzeState`), les essais `test/kcs-protocol.test.js` et `test/kcs-connection.test.js`, et la règle d'AGENTS.md sur Socket.IO 2.x. Essais sur le faux KaraFun (`fake-karafun.js`) ; jamais d'essai destructif sur la vraie télécommande sans avoir vérifié son code actuel (CLAUDE.md). Même règle dans les deux modes.

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** rien dans le plan du 8 novembre 2026.

### Mise à jour du kit Windows sans gestes à la main

**What:** Un script du kit, lancé depuis le dossier du kit neuf, qui arrête l'ancien kit (`ARRETER.bat`), copie son dossier `data` avant le premier lancement du kit neuf, remplace les raccourcis de `KaraFun Plus.exe` et garde l'ancien kit tel quel ; et le même script en sens inverse pour le retour arrière.

**Why:** En mode PC, installer une version ou revenir à la précédente demande cinq gestes PowerShell (plan du 8 novembre, « Ordre de travail »). Un raccourci oublié relance l'ancien kit le soir suivant, et un premier lancement du kit neuf avant la copie crée un `data` vide.

**Context:** Relevé par la relecture DX du 10 novembre 2026 (mise à jour et retour arrière). Le kit n'a aujourd'hui aucune procédure de mise à jour : `KIT-BAR-LISEZMOI.txt` dit seulement de sauvegarder `data`, et DEPLOIEMENT-SERVEUR (§19) refait un kit neuf depuis une archive du serveur. Le script reprendrait la vérification de `KIT-BAR-KARAFUN.zip.sha256` du §19 et ne toucherait jamais au `data` d'origine.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026 (installation de la v3.3.0).

## Design

### Un `DESIGN.md` tiré d'`app.css`

**What:** Écrire `DESIGN.md` avec `/design-consultation`, à partir d'`app.css`, du `<style>` de `client.html` et du thème clair de `stats.html` : variables de `:root` et leurs rôles, composants (`.btn` et ses variantes, `.badge`, `.pill`, `.staff-alert` et ses formes, `.disclosure`, `.link-btn`, `.switch`, `.tab-badge`, `.cover`), cibles de 44 px, grille de 12 colonnes du bar.

**Why:** La relecture design du plan du 8 novembre a jugé ses classes contre `app.css`, faute de `DESIGN.md`. Les plans suivants pourront citer les jetons par leur nom, et une relecture vérifier un écart au lieu de le chercher.

**Context:** Reporté par la phase design d'autoplan du 10 novembre 2026 (P5.8) : le gérant ne veut plus de questions, et le plan est figé. D'ici là, la règle transversale « Vocabulaire visuel » du plan tient lieu de garde. Y entrent les formes ajoutées par les lots A à E : `staff-alert info`, `song-more`, la règle commune `a.btn`, les titres de repli de 44 px.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lots D et E du plan du 8 novembre 2026 (les formes nouvelles d'abord).

### Contraste des boutons principaux

**What:** Le texte blanc des boutons principaux (`.btn.primary`, app.css:24 : « ＋ Chanson », « Commencer », « Personne seule : QR individuel », « Rejoindre la Battle », et les nouveaux « Déplacer » de Détails et « Envoyer » de l'étape du refus…) et du repère `.badge.live` du bar (app.css:221) a un contraste de 3,0:1 sur `--accent` (#ff4fa3), sous les 4,5:1 demandés pour un texte de 16 px.

**Why:** C'est l'action principale de chaque écran, lue dans un bar sombre sur des téléphones souvent en luminosité basse ; le gérant veut une page qu'un enfant de 5 ans comprend.

**Context:** Mesuré par la phase design du 10 novembre 2026 (passe 6). Le plan figé ne change que la pastille d'onglet et les infos urgentes, passées au texte `var(--bg)` (règle « Contraste »). Deux formes possibles : texte `var(--bg)` sur le même rose (6,3:1), ou un rose plus sombre sous le texte blanc. L'une ou l'autre change l'aspect de toutes les pages que les habitués connaissent : captures avant/après à montrer au gérant avant de choisir.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Jalon 2 livré ; choix du gérant sur l'aspect.

## Sécurité

### Politique de sécurité complète des pages (CSP)

**What:** Ajouter `script-src` par empreinte, `style-src` et `img-src` à la politique de contenu des pages du bar, des tables, des statistiques et de l'impression.

**Why:** Seul `esc()` protège aujourd'hui des prénoms hostiles : un oubli exécuterait du script dans la page du bar, qui tient la clé. `base-uri 'none'` (plan du 8 novembre, règle « En-têtes de sécurité ») ne bloque que le détournement par `<base>`.

**Context:** Reporté par la relecture CEO du 9 novembre 2026, section 3 (S3.9). `server.js` pose les en-têtes dans `SERVER_HEADERS` (`server.js:277-278`), par `send()`. Chaque page n'a qu'un script en ligne (`client.html` charge aussi `/client-i18n.js`) ; `print.html` a une poignée d'événement en ligne à retirer (`onclick`). Recenser les styles en ligne et l'origine des pochettes (`coverUrl`, `server.js`) avant de fixer `style-src` et `img-src`. Tester les deux modes.

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** règles « Textes venus des clients ou du bar » et « En-têtes de sécurité » du plan du 8 novembre 2026.

### La clé du bar hors du journal du serveur, en mode PC

**What:** En mode PC, écrire au journal du serveur (`journal/serveur-<date>.log`) l'empreinte de la clé du bar, comme le mode serveur (`staffKeyFingerprint`, `server.js:6237`), et garder la clé en clair à la seule console de `DEMARRER.bat`.

**Why:** `appLog` écrit la même ligne à la console et au journal (`server.js:619-623`) : la ligne « Clé du bar (autre appareil) » y met la clé en clair (`server.js:6338`). Ce journal sort maintenant du PC (DEPLOIEMENT-SERVEUR, §18, « Envoyer une soirée au développeur ») : sans le filtre `grep -v 'Clé du bar'`, la clé de la file qui tourne partirait avec.

**Context:** Relevé par la relecture d'ingénierie du 10 novembre 2026 (L5). En mode PC, la clé est tirée à chaque démarrage (`server.js:289`) : la ligne d'un journal ancien ne sert plus après un redémarrage, et ce PC obtient de toute façon la page du bar par `GET /`. GUIDE-BAR dit déjà de ne jamais envoyer cette ligne (`GUIDE-BAR.md:263`). Une écriture à la seule console, à côté d'`appLog`, suffit ; texte du mode PC changé avec son test (AGENTS.md). Le lanceur `KaraFun Plus.exe` n'a pas de fenêtre (`launcher/KaraFunPlus.cs:28-29`) : un autre appareil passe déjà par le QR « Accès du bar depuis un téléphone ».

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** rien dans le plan du 8 novembre 2026 ; le filtre du §18 (lot A6) reste.

## Déploiement

### Nommer les réglages dans le refus de l'agent de mise à jour

**What:** Quand `deploy/.env` n'a pas les mêmes clés que le `deploy/.env.example` de la version visée, l'agent de mise à jour (`deploy/update-agent.py`) les nomme, jamais leur valeur : « Réglages à ajouter dans deploy/.env avant cette version : X, Y. » ; « deploy/.env contient KARAOKE_REPAIR, que cette version n'attend pas : retire la ligne entière, puis « Vérifier et mettre à jour » aussitôt (DEPLOIEMENT-SERVEUR §18, « Couper la réparation »). ».

**Why:** Une clé en trop et une clé manquante donnent aujourd'hui le même refus, « Cette version nécessite un réglage du serveur avant son installation. » (deploy/update-agent.py:288-289). Pendant un dépannage par `KARAOKE_REPAIR`, il fait chercher un réglage manquant alors qu'il faut retirer une ligne, même vide.

**Context:** Reporté par la relecture DX du 10 novembre 2026 (N2). Le code de l'agent ne suit pas les mises à jour (DEPLOIEMENT-SERVEUR.md:620-622) : le message n'arrive qu'après une réinstallation de l'agent par le mainteneur. En attendant, la carte « Mise à jour » dit, tant que `KARAOKE_REPAIR` est posée, de prévenir le mainteneur, qui retire la ligne (plan du 8 novembre, A6). La règle reste : la dernière version exige les mêmes clés, une version choisie peut en avoir moins. Essais dans `test/update-agent.test.py` (cas « moins de réglages » et « plus de réglages »).

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026 (`KARAOKE_REPAIR`).

### Arrêt imprévu de la file écrit au journal du serveur

**What:** Un gestionnaire `uncaughtException` et `unhandledRejection` dans `server.js`, qui écrit au journal du serveur « Arrêt imprévu : <nom>[, code <code>] » et la pile sans le message (chemins depuis le dossier de l'application), puis arrête le processus en code 1, comme Node le fait aujourd'hui.

**Why:** `server.js` n'en a aucun : il ne rattrape que l'échec de `main()` (`server.js:6371`) et les erreurs d'écoute (`:6358-6368`). Une exception qui sort d'un rappel (`setImmediate`, minuterie, événement du pont KaraFun) arrête la file. Lancée par `KaraFun Plus.exe`, sans fenêtre (`launcher/KaraFunPlus.cs:28-29`), elle s'arrête alors sans trace : sa sortie d'erreur n'est lue par personne, et le bar ne voit que « Connexion perdue ».

**Context:** Relevé par la relecture d'ingénierie du 10 novembre 2026 (registre des modes de défaillance). Le lot A garde ses propres rappels (garde de la fin de soirée, passe des soirées closes gardée en entier), mais `sync()` est déjà relancé par `setImmediate` à chaque changement du pont (`server.js:992`). Ne jamais continuer après l'exception, l'état étant inconnu : écrire la ligne, puis sortir ; en mode serveur, Docker relance `app` (`restart: unless-stopped`, `deploy/compose.yaml:61`). Essai en vrai processus : une copie retouchée lève dans un rappel ; la ligne est au journal, sans le message, et le code de sortie vaut 1.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026 (forme des piles du journal du serveur).

## Développement

### Suite hors ligne sous 10 minutes

**What:** Mesurer à la fin de chaque lot la durée de `node test/run-offline.js` et, si elle passe 9 minutes, lancer ses fichiers en deux groupes en parallèle dans `run-offline.js` lui-même : les fichiers purs et les bacs à sable `vm` d'un côté, les démos et les vrais processus de l'autre, sur leurs plages de ports réservées.

**Why:** La suite a duré 7 min 52 s le 10 novembre. `verify` coupe sa commande à 600 s (`gstack-checks run`), et une commande au premier plan du terminal de travail s'arrête à 10 min. Les lots A à E ajoutent des essais en bac à sable et en vrai processus.

**Context:** Reporté par la relecture DX du 10 novembre 2026. En attendant, la suite se lance en arrière-plan, et `gstack-checks run --timeout 1200` de `verify` aussi (plan, « Vérifications rapides »). `run()` lance les fichiers l'un après l'autre et s'arrête au premier échec (`test/run-offline.js:12-27`) ; chaque démo a déjà son port (3100 à 3127).

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Fin du jalon 2 du plan du 8 novembre 2026 (durée mesurée après les lots B à E).

### Même police pour les mesures en navigateur, dans le conteneur et dans la CI

**What:** Relever dans le job `linux` de la CI la police de `system-ui` (`fc-match system-ui`) et les hauteurs que mesurent `staff-idle-layout` et `client-open-duo-layout`, puis donner aux deux endroits la même police : celle du conteneur de travail (Inter) installée dans la CI, ou une police fixée pour ces seuls essais.

**Why:** `app.css:17` écrit en `system-ui`. Le conteneur de travail la rend en Inter, avec Playwright 1.63.0 et Chromium 153 ; la CI a Playwright 1.56.1 sur Ubuntu 24.04, police non relevée. Des mesures du plan sont à quelques pixels de leur seuil (carte « Sur scène » : 145 px pour 150) : un critère peut être vert dans l'un et rouge dans l'autre.

**Context:** Reporté par la relecture DX du 10 novembre 2026 (passe 6). Le relevé de la police dans le job `linux` (`fc-match system-ui`) entre au jalon 1 (relecture ingénierie du 10 novembre 2026, M5) ; restent le relevé des hauteurs et la même police aux deux endroits. En attendant, la CI fait foi (plan du 8 novembre, D6), et le compte rendu de chaque suite note Playwright, Chromium et la police. Une police fixée change ce qui est mesuré : la comparer d'abord aux vrais téléphones du « Test sur place au bar ».

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lots D et E du plan du 8 novembre 2026 (critères absolus de D6 et d'E8).

### Bilan C6 partiel pour chercher la cause d'un refus

**What:** Deux options de `test/bilan-deplacements.js`, `--cas <n>[,<n>]` et `--reglage chacun|tables|compromis[,…]`, qui ne refont qu'une partie du bilan C6. Leur récapitulatif commence par « Bilan partiel : ne vaut pas bilan C6. », et le bilan entier reprend ces résultats s'ils ont la même empreinte de reprise.

**Why:** Après la correction d'un défaut trouvé par un cas refusé, tout le bilan se refait : environ 40 min, 63 rejeux Timefold par soirée. Un bilan partiel donnerait en quelques minutes les tableaux du seul cas en cause, avant le bilan entier.

**Context:** Proposé par la relecture DX du 10 novembre 2026 (N12, M4) et reporté par sa critique : aucune étape acceptée du plan du 8 novembre n'en a besoin. La cause d'un refus se cherche avec `node test/rejeu-soiree.js <cas>-gestes.json --libre --solveur --gestes --cles --trace HH:MM` ; un tableau se refait à la main après `--ecrire <dossier>` ; un défaut corrigé fait refaire tout le bilan (C6, « Seuils et classement »), et l'empreinte de reprise ne garde que les cas dont rien n'a changé.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot C du plan du 8 novembre 2026 (`test/bilan-deplacements.js`).

### Une seule écriture durable pour les fichiers de données

**What:** Une fonction commune d'écriture durable (`.tmp` propre au processus, synchronisé, renommé, puis dossier synchronisé hors de Windows), employée par la sauvegarde de soirée (`night-state.js`), la mise à jour (`server-update.js`) et la réparation des journaux (`evening-journal.js`).

**Why:** Le plan du 8 novembre ajoute une troisième copie de ce schéma. `NightStateStore.save` synchronise son fichier sans son dossier (night-state.js:842-853), alors que `writeChoice` synchronise les deux (server-update.js:208-229) : un agent copie celle qu'il voit en premier.

**Context:** Relevé par la relecture d'ingénierie du 10 novembre 2026 (étape 0). Sans la synchronisation du dossier, une coupure de courant peut perdre le dernier renommage de la sauvegarde de soirée ; la reprise retombe alors sur l'autre génération, d'où la priorité basse. Avec le lot A, le disque en mémoire des essais (`test/evening-stats-routes.test.js`) reçoit `openSync`, `fsyncSync` et `closeSync`. Garder les codes et les textes d'erreur de chaque appelant ; essais : les trois appelants, chacun avec une synchronisation en échec.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026 (écritures synchronisées de la réparation).

### Essais en vrai processus sans dépendre de 8 h

**What:** Faire tourner `night-restart-api`, `server-mode-startup` et `server-update-routes` à une heure maîtrisée : quand le prochain 8 h local tombe pendant la durée d'un essai, l'essai attend 8 h et 1 min avant de lancer sa copie. Puis retirer la règle « relancer une fois » de la suite.

**Why:** Depuis le lot A, ces trois fichiers lancent une copie hors démo à l'heure réelle, avec des tables et sans titre : à cheval sur 8 h, la remise à zéro du matin peut tomber en plein essai. La règle « relancer une fois » le couvre, mais un défaut qui ne se voit qu'à 8 h y passerait.

**Context:** Reporté par la relecture ingénierie du 10 novembre 2026 (M6). La démo n'a plus de fin de soirée automatique, et `evening-end-process` prépare une soirée qu'aucun 8 h ne clôt (A7). Commencer par mesurer la durée de chaque essai de ces fichiers, puis écrire une aide commune dans `test/server-mode-startup.test.js`, qui exporte déjà `launch` et `sandboxCopy`.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026.

### Essai automatique du suivi d'une personne déplacée dans un vrai navigateur

**What:** Un essai en vrai navigateur (Playwright) sur une démo : le bar déplace deux personnes d'un même téléphone vers une autre table par `POST /api/staff/people/move`, et la page de leur ancienne table, ouverte avec leurs jetons, suit seule jusqu'à la nouvelle (adresse, jetons sous la nouvelle clé, personnes gérées) ; puis le même geste vers « En solo », avec « Qui le garde ? ».

**Why:** Dans le plan du 8 novembre (C6), la page et le serveur s'essaient chacun de leur côté, l'autre étant simulé ; le parcours entier n'est joué qu'au `qa` du jalon 2, une fois, sans garde contre une régression ensuite.

**Context:** Reporté par la relecture ingénierie du 10 novembre 2026. En attendant, les formes exactes de `relocated` et de la réponse de `follow` sont essayées des deux côtés (C6). Un tel fichier s'ignore sans Playwright, comme les six de la règle « Rien d'ignoré en silence », qu'il faudrait alors compléter, et prend un port de démo libre (3100 à 3127 sont pris, `test/run-offline.js:60-77`). Modèle : `test/staff-idle-layout.test.js` (démo sur un port fixe, état lu par la page).

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot C du plan du 8 novembre 2026.
