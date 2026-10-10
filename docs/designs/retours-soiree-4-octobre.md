# Retours de la soirée du 4 octobre — spécification

Branche : `feat/retours-soiree-4-octobre` · une seule PR pour l'ensemble.
État du code relevé le 8 octobre 2026 (8 analyses du code, reproductions dans le bloc-notes de la session).
Rédigée avec gstack `spec` ; défauts traités avec `investigate`, parcours vérifiés avec `qa`, `review` avant livraison.

## Contexte

Le gérant a relevé onze points après la soirée du samedi 4 octobre (15 inscrits, 18 titres). Trois freinent l'accueil (QR solo qui expire avant la saisie du prénom, clients solo qui perdent leur page — neuf transferts pour une même cliente —, pas de QR commun pour une soirée privatisée), deux encombrent les téléphones des tables, deux inquiètent pendant le service (contrôle Spotify qui lâche, réglages de tonalité ou de guide qui pourraient rester sur les titres suivants), un graphique des statistiques est illisible, et deux informations manquent au bar (où en est la chanson sur scène, quels solos sont partis).

Règle à préserver partout : **hors événement privé, une personne n'a jamais deux places dans la rotation.**

## Lots, dépendances et ordre

```
A  Accès solo (QR compté à l'ouverture, prénom obligatoire, récupération)
   └─> B  Événement privé (réutilise l'ouverture et la fenêtre de prénom de A)
   └─> C  Dernière activité (même suivi que A ; liste des solos de l'Accueil)
D  Tables : faire scanner sa table, page centrée sur ses personnes   (indépendant, mêmes fichiers client que A)
E  Spotify connecté                                                   (indépendant)
F  Barre de lecture du titre sur scène                                (indépendant)
G  Réglages isolés par titre (défaut)                                 (indépendant)
H  Graphique « Déroulé de la soirée » (défaut)                        (indépendant)
P  Porte gstack (hooks) : correctifs de la relecture                  (indépendant)
I  Durée des titres avant l'ajout                                     (indépendant)
J  Durée maximale des titres                                          (après I : même affichage de la durée)
K  Prénom seul pour les solistes                                      (après A et J : mêmes fichiers)
L  Battle : les retardataires votent (défaut)                         (indépendant ; touche l'électorat défini en A)
```

A avant B et C : B et C reposent sur la personne créée à l'ouverture, sur le drapeau `nameRequired` et sur la fenêtre de prénom. D touche les mêmes zones de `client.html` que A : il passe après A ou dans la même série de modifications.

---

## A. Accès solo

### A1. Le QR individuel compte dès son ouverture, prénom obligatoire

**Aujourd'hui** (vérifié) : ouvrir `/t/Comptoir/<accès>?invitation=<jeton>` n'enregistre rien (`server.js:3594-3597`, `/api/state` ne fait que `verify`, `server.js:3622`) ; la personne n'est créée qu'à l'envoi du prénom (`joinPersonDurably`, `server.js:1986-2020`) ; l'invitation expire 30 min après son émission (`solo-invitations.js:6, 48`) ; rien n'oblige à saisir le prénom (onglets et catalogue restent accessibles, `client.html:1202-1205`).

**Changement**
1. Nouvelle route `POST /api/table/solo/open` `{table, access, invitation}` (sous `/api/table/` pour la vérification automatique des traductions ; ajoutée aux exceptions du contrôle de propriétaire solo, `server.js:3736-3742`). Jamais en GET : un aperçu de lien ne crée personne.
   - Invitation valide et inutilisée, téléphone sans profil solo : crée la personne avec un prénom provisoire unique `Solo <n>` (n = plus petit entier libre dans la table), `nameRequired: true`, consomme l'invitation, associe le téléphone (`bindSoloDevice`), enregistre la soirée (`saveNight({required:true})`, retour arrière complet en cas d'échec, sur le modèle de `joinPersonDurably`). Réponse `{id, token, nameRequired:true}`.
   - Même invitation rouverte par le téléphone qui la possède : renvoie la même personne (idempotent).
   - Invitation déjà utilisée par une autre personne : voir A2 (récupération), pas de création.
   - Téléphone qui possède déjà un autre solo : refus `SOLO_DEVICE_USED`, inchangé. Exception (deuxième relecture finale) : une place de ce navigateur encore sans prénom ni titre est retirée sans trace et l'invitation s'ouvre, seulement depuis son téléphone actuel et seulement pour une place du QR de l'événement (troisième relecture finale : une place ouverte par un autre QR individuel est gardée et ce QR neuf refusé, `SOLO_DEVICE_USED`, sinon le premier QR serait brûlé ; la reprise d'une autre place sans prénom suit la même règle ; vérification de la troisième passe : la reprise d'un profil nommé ne la retire pas non plus, ce navigateur la quitte et elle reste à son papier, que son propriétaire rescanne ; seule une place du QR de l'événement part). Une place encore sans prénom reprise ailleurs (clé personnelle, code, lien) est aussitôt détachée de tous ses anciens navigateurs : rien à protéger, l'ancien navigateur ouvre sa propre place avec un QR neuf, avant comme après le prénom donné par le nouveau (chaque papier finit par servir). Téléphone actuel d'une personne marquée partie : `PERSON_LEFT` « Cette personne a été marquée partie. Demande au bar de la réactiver. » (aussi `/api/table/person` et `/api/join`) ; un ancien téléphone de cette personne (profil passé depuis sur un autre) garde `SOLO_DEVICE_USED`.
   - Invitation expirée ou révoquée avant ouverture : message actuel inchangé.
2. `person.soloKeyHash = sha256(jeton d'invitation)` est conservé sur la personne (sauvegardé avec elle, `night-state.js:95-104`). La restauration de la soirée exige un `name` non vide : le prénom provisoire le satisfait.
3. **Fenêtre de prénom obligatoire** (`client.html`) : tant que la personne gérée a `nameRequired`, un écran plein (`div` masquée, pas de `<dialog>` : les tests n'ont pas `showModal`) recouvre tout, onglets et navigation masqués. Contenu : titre « Bienvenue ! Quel est ton prénom ? », champ prénom, bouton « Valider », bouton de langue FR/EN. Aucune fermeture (ni croix, ni Échap, ni Retour). Envoi : `POST /api/table/person/rename` (existe, `server.js:2822`), qui efface `nameRequired`. Prénom déjà pris : message dans la fenêtre « Ce prénom est déjà inscrit. Ajoute l'initiale de ton nom (ex. Marie L.). ». Révisé (relectures finales) : le serveur dit si la personne de ce prénom se reprend depuis ce téléphone (`recoverable`, même règle que la liste de reprise) ; alors le message renvoie vers « Déjà inscrit ? J’ai un code », sinon « … Ajoute l’initiale de ton nom (ex. Marie L.). Si c’est bien toi, demande au bar. ». En reprise par code, le titre de la fenêtre devient « Récupérer mes chansons » (un seul titre), rendu par « Retour ».
4. Tant que `nameRequired` : le serveur refuse ajout de titre, duo, Battle (vote ou proposition) avec « Indique d'abord ton prénom. » (traduit) ; la personne est exclue de l'électorat Battle (`server.js:1482`) et de `/api/duo/partners` (`server.js:3667-3680`).
5. Journal : `person.joined` n'est écrit qu'au premier vrai prénom (renommage qui efface `nameRequired`), pour que les statistiques ignorent les ouvertures abandonnées.
6. Bar : la personne apparaît dès l'ouverture, avec la mention « prénom à saisir ». Une ouverture abandonnée se marque « Parti » comme aujourd'hui ; aucune suppression automatique (sauf les places abandonnées du QR de l'événement privé, B.3). `POST /api/photo` exige aussi un prénom.

### A2. Un solo qui perd sa page la retrouve sans le bar, sans deuxième place

**Cause vérifiée** : l'accès solo exige deux éléments du navigateur (jeton en `localStorage` et cookie de l'appareil, `server.js:3618-3620`) ; l'adresse restante après inscription est le lien commun « En solo », qui n'identifie personne (`client.html:1879`, `395-398`) ; un scanner de QR avec son propre navigateur intégré, un onglet privé ou un autre navigateur n'a ni l'un ni l'autre ; seul le transfert par le bar ramène l'accès.

**Changement**
1. **Le QR individuel devient la clé personnelle du chanteur pour la soirée.** Ouvert sur un autre téléphone, il ne crée rien : `/api/table/solo/open` répond `{recover:{id, name}}` et la page affiche « C'est bien toi, {name} ? » avec « Récupérer mes chansons » (un toucher). La confirmation passe par `POST /api/table/person/claim {key}` : même effet que `claimPerson` (nouveau jeton, nouveau téléphone associé, l'ancien perd l'accès). Une personne encore `nameRequired` est récupérée sans confirmation. La clé meurt quand la personne est marquée partie ou à la nouvelle soirée.
2. **L'adresse garde la clé** : après ouverture ou récupération, la page ne retire plus `?invitation=` de l'adresse (au lieu de `forgetSoloInvitation`). Historique, favori, onglet restauré, « Ouvrir dans le navigateur » depuis un scanner : tout ramène au même chanteur.
3. Dans un navigateur intégré à une application (Instagram, Snapchat, Facebook, WebView Android : détection par `navigator.userAgent`), bandeau discret « Pour retrouver cette page plus tard, ouvre-la dans ton navigateur (Safari ou Chrome). ».
4. **Bar : un toucher au lieu d'une recherche.** Accueil, panneau solo : liste « Solistes » triée par activité la plus récente (lot C), recherche par prénom quand il y en a plus de 8. Chaque ligne : prénom, « prénom à saisir » éventuel, activité, bouton « QR de reprise » (ouvre la fenêtre de transfert actuelle, `openShare`). Le panneau « Donner un chanteur à un autre téléphone » reste pour les tables.

**Pourquoi une seule place reste garantie** : seule la première utilisation d'une invitation émise par le bar appelle `sched.join` ; toute autre voie rattache une personne existante. Des tests figent déjà cette règle (`test/solo-comptoir-api.test.js`) : ils restent verts, et l'un d'eux (« invitation consommée refusée dans un nouveau navigateur ») évolue délibérément vers « invitation consommée = récupération de la même personne ».

**Hors périmètre** : retrouver l'accès par le seul cookie quand le `localStorage` a été effacé (cas rare, impose de séparer appareil actuel et anciens appareils).

---

## B. Événement privé

**Aujourd'hui** : seule une invitation à usage unique émise par le bar inscrit un solo (`server.js:1965-1971`) ; une seule grande table afficherait tout le monde sur chaque téléphone.

**Changement** (option A de l'analyse)
1. Module `private-event.js` (modèle : `solo-invitations.js`) : `{enabled, secret (128 bits, base64url), since}` ; `enable()` (crée le secret s'il n'existe pas : couper puis rallumer garde le QR imprimé), `disable()`, `rotate()`, `clear()`, `verify(token)` (comparaison à temps constant, vrai seulement si activé), `serialize()/restore()` (forme invalide = mode coupé, jamais d'échec de la soirée). Sauvegardé comme champ `privateEvent` de la soirée (`night-state.js`), pas dans `settings`. Ajouté à `test/coverage.js` (SOURCES) et à `PREPARER-KIT-BAR.ps1`.
2. Bar, Accueil, en tête du panneau solo : interrupteur « Événement privé : un seul QR pour tout le monde » et aide « Bar privatisé : chaque personne scanne le même QR avec son téléphone et gère ses propres chansons. ». Activé : QR en grand, « Copier le lien », « Imprimer », « Renouveler le QR » (avec confirmation ; les personnes déjà inscrites gardent leur accès). Route `POST /api/staff/private-event {enabled?, rotate?}` ; `staffState.privateEvent = {enabled, url, qrUrl}` (adresse seulement si activé). QR SVG réservé au bar : `/qr-evenement.svg` (pas sous `/qr/<id>.svg`, une table peut s'appeler « evenement »). `print.html` : une grande carte « Événement privé » quand le mode est actif. Journal : seulement `settings.changed privateEvent true/false`, jamais le secret.
3. Le QR encode `/t/Comptoir/<accès>?evenement=<secret>`. `/api/state` renvoie `privateEventReady` (comme `soloInvitationReady`). La page appelle alors `POST /api/table/enter {table, access, event}` :
   - téléphone qui a déjà son chanteur : le renvoie, rien n'est créé ;
   - sinon : crée un chanteur provisoire `nameRequired` (A1.3 à A1.6 s'appliquent), sans invitation ni contrôle `SOLO_DEVICE_USED` ;
   - plafonds (révisés par les deux relectures finales) : 30 créations par minute et par appareil (l'adresse IPv4, IPv4 mappée comprise, ou le préfixe /64 IPv6 ; adresse de la connexion sur le Wi-Fi, jamais `X-Forwarded-For` ; par le tunnel, l'en-tête `CF-Connecting-IP` que Cloudflare réécrit, sans lui aucune limite par appareil), 120 par minute pour le bar ; au-delà `PRIVATE_EVENT_BUSY` (429, en-tête `Retry-After`) « Trop d'inscriptions d'un coup : réessaie dans une minute. », que le téléphone réessaie seul pendant 5 minutes environ (après `Retry-After`, sinon toutes les 15 à 20 s), titre « Inscription en cours… », puis bouton « Réessayer ». Au plus 400 personnes venues par l'événement (présentes et nommées, plus les places sans prénom des 10 dernières minutes ; les personnes marquées parties ne comptent plus), et au plus 800 fiches venues par l'événement non parties, nommées ou non, de tout âge (troisième relecture finale) ; au-delà `PRIVATE_EVENT_FULL` (403) « L'événement est complet par ce QR : demande au bar un QR individuel. », sans nouvel essai automatique ;
   - avant chaque création par ce QR (troisième relecture finale), les places venues par l'événement abandonnées partent sans trace : sans prénom ni titre ni clé personnelle, pas parties, ouvertes depuis 10 minutes ou plus, jamais relues par leur page (`lastSeen` au plus 1 s après l'ouverture ; vérification de la troisième passe : la première relecture visible d'une place sans prénom, passé cette seconde, le change aussitôt, une page vue quelques secondes garde donc sa place), sans action et sans code ou lien de reprise encore valable donné par le bar ; la page qui revient après coup rescanne le QR de l'événement (nouvelle place). Limite connue : une personne nommée n'est jamais retirée (« Renouveler » non plus), si bien qu'une boucle qui donne un prénom à chaque place remplit les 800 fiches, puis l'événement est complet jusqu'à ce que le bar marque des personnes parties ou coupe le mode ;
   - « Renouveler le QR » retire sans trace les places venues par l'événement encore sans prénom ni titre (leur page, même rechargée dans le même onglet, affiche « Ta place sans prénom a été retirée. Rescanne le QR de l’événement pour en avoir une nouvelle, ou demande au bar. » : la page ne distingue pas un QR renouvelé d'un « Parti » du bar, et l'ancien QR rescanné répond « QR plus actif ») ; `POST /api/leave` sur une telle place la supprime au lieu de la marquer partie, « Parti » du bar aussi (`POST /api/staff/person/leave`, troisième relecture finale : marquée partie, son navigateur restait lié à une fiche que le bar ne sait pas réactiver ; il rescanne le QR et reçoit une nouvelle place ; la réponse porte un `message` « Place « Solo N » sans prénom retirée… » qui remplace « marqué parti » sur la page du bar, dont la confirmation dit « Retirer la place « Solo N » ? ») ;
   - mode coupé ou QR renouvelé : 403, « Ce QR d'événement n'est plus actif. Demande au bar. ».
4. **Page perdue en événement privé** (décision du gérant, D1) : re-scanner le QR. Même navigateur : son chanteur revient. Autre navigateur : **toujours un nouveau chanteur**, sans reprise par prénom ; un prénom déjà pris est refusé avec la consigne d'ajouter une initiale (A1.3). L'ancien profil garde ses chansons : la liste « Solistes » (A2.4) et la dernière activité (C) aident le bar à le marquer parti.
5. Chaque participant reste son propre groupe de rotation (aucun changement d'équité ; vérifié avec 60 solos dans les trois modes). Les duos entre participants gardent l'accord de l'invité.
6. « Supprimer toutes les tables » coupe le mode et efface le secret. Un redémarrage de l'application le conserve.

---

## C. Dernière activité des solos

**Aujourd'hui** : `lastSeen` existe (`scheduler.js:487`), bougé au plus une fois par minute à chaque lecture d'état (`server.js:1684`), y compris page cachée (le téléphone interroge toutes les 4 s même en arrière-plan, `client.html:2849-2851`) ; seule la première personne d'un téléphone de table est mise à jour (`server.js:3621`) ; la page du bar ne l'affiche nulle part.

**Changement**
1. Activité = page **visible** ou action volontaire. La page envoie l'en-tête `x-page-visible: 1` sur `/api/state` si `!document.hidden`, `0` sinon ; sauf `0`, `lastSeen` bouge (sans en-tête : page en cache d'avant la mise à jour, comptée, relecture finale C1) (au plus une fois par minute) pour **toutes** les personnes gérées. Les lectures en arrière-plan ne comptent plus. Toute action personnelle acceptée (`personAtTable`, résolution de `me`, confirmation de présence, récupération) met `lastActionAt` ; l'accusé automatique `/api/table/notice/ack` ne compte pas.
2. `staffState.people[].lastActiveAt = max(lastSeen, lastActionAt)` ; l'heure du serveur `now` sert au calcul (le téléphone du bar peut avoir une autre heure).
3. Page du bar, pour les solos seulement (sur une table, un téléphone gère aussi des amis sans téléphone : l'indication tromperait) :
   - libellés : « Actif à l'instant » (< 2 min), « Actif il y a 12 min », puis « Sans nouvelles depuis 25 min » en orange dès 20 min et en rouge dès 45 min (« depuis 1 h 05 » au-delà d'une heure) ; info-bulle « Dernière activité sur son téléphone à 21:42 » ;
   - jamais revenu depuis l'ouverture du QR : « Pas revenu depuis l'ouverture du QR (21:10) » ;
   - affichés dans la liste « Solistes » de l'Accueil (A2.4), dans l'onglet Repères (élément séparé de la ligne « N titres · N passages » figée par les tests), sur une ligne de la file d'un solo au-delà de 45 min (« sans nouvelles depuis 52 min » ; à l'écran, repère court « inactif 52 min » qui passe à la ligne plutôt que de réduire le prénom à une lettre, vérification de la seconde relecture ; troisième relecture : le nom seul sur sa ligne en prend toute la largeur, soliste comme duo, plus « Marie… » à 360 px ; au téléphone, où les badges sont cachés, le nom d'un soliste actif prend aussi la place que sa table lui laisse, plus « Anne-… » suivi de vide ; et une table vide ne décale plus le premier repère d'un duo), dans l'alerte « … n'a pas répondu à « Je suis là » » ;
   - tuile « En solo » de l'Accueil : « 12 solistes · 2 sans nouvelles ».
4. Le libellé ne change qu'à la minute (pas de redessin toutes les 2 s). Personnes parties : rien.

---

## D. Tables

**Aujourd'hui** (vérifié, `client.html:1170-1218`) : le QR d'une table s'affiche sur l'écran du bar (« Touche une table pour montrer son QR en grand », `staff.html:82`) ; un téléphone de table affiche toutes les personnes de la table (`renderPeople(people)`) et un bouton « Je suis X » par personne gérée ailleurs (`claimBox`) ; un nouveau téléphone qui scanne une table déjà commencée n'a pas de formulaire d'arrivée en tête (`joinBox` masqué dès qu'une personne existe).

**Changement**
1. **Faire scanner sa table depuis son téléphone.** Dès que le téléphone gère une personne d'une table ordinaire : carte « Fais scanner ta table » avec le QR de la table en grand, « Partager le lien » (`navigator.share`, sinon copie) et l'aide « Les autres personnes de la table scannent ce QR avec leur téléphone pour s'inscrire et choisir leurs chansons. ». Déployée juste après la première inscription, repliée ensuite en un bouton « Faire scanner ma table » en haut de « Ma table ». Route `GET /api/table/invite?table&access` → `{url, qr}` (même lien que le QR imprimé, `phoneBase()`, QR en `data:` comme `server.js:2055`). Pas pour « En solo ».
2. **Arrivée d'un nouveau téléphone** sur une table déjà commencée : la carte d'accueil reste en tête (« Bienvenue à {table} ! », « Ton prénom », bouton « Rejoindre la table »), puis un lien discret « Déjà inscrit par un autre téléphone ? » qui ouvre la feuille de la table (point 3).
3. **La page principale ne montre que les personnes gérées par ce téléphone** (« Mes chanteurs »). Bouton « Voir toute la table (N) » : feuille (`openSheet`, `client.html:2610`) avec toutes les personnes, une recherche au-delà de 8, pour chacune le nombre de titres prêts et « géré par ce téléphone » le cas échéant, et l'action « C'est moi » (reprise par code, flux actuel) pour les autres. La carte `claimBox` disparaît de la page principale des tables (elle reste pour « En solo »). L'ajout d'une personne sans téléphone reste, renommé « Ajouter une personne sans téléphone ».
4. Onglet « La file » inchangé (« À notre table, sans chanson »).

---

## E. Spotify connecté

**Cause vérifiée** (`spotify.js:283-285`, `staff.html:1186-1188`) : l'identifiant d'appareil enregistré devient périmé (Spotify le dit lui-même) ; la lecture vise l'ancien identifiant et échoue (404) ; « Actualiser la liste » n'affiche plus l'appareil choisi et la liste retombe sur « Appareil actif de Spotify » sans le dire au serveur, d'où la resélection manuelle ; un 204 (aucun appareil actif) s'affiche en vert « Spotify en pause » ; une erreur ancienne reste affichée après rétablissement ; l'automatisme abandonne après trois essais par silence.

**Changement**
1. `SpotifyLink.checkHealth()` (liste des appareils + état du lecteur) et `view().health = {state, device, checkedAt, okAt, message}` ; états et pastille :
   - `ready` : « Spotify connecté · {appareil} » (vert) ;
   - `no-device` : « Spotify connecté, aucun appareil : ouvre Spotify sur {appareil} » (orange) ;
   - `error` : « Spotify injoignable, nouvel essai à HH:MM » (rouge) ;
   - `disconnected` : « Spotify non connecté » (rouge) et bouton « Reconnecter Spotify » (la reconnexion OAuth ne peut se faire que sur le PC du bar, `server.js:3658`).
   Une vérification réussie efface `lastError`.
2. Vérification toutes les 60 s dans `spotifyTick` quand aucune action n'est en cours (respecte `waiting`/`blocked` ; les tests qui comptent un seul appel après `invalid_grant` ou coupure réseau restent verts), et aussi après connexion, après choix d'appareil, après un 404 de lecture et sur le bouton « Vérifier Spotify » (ancien « Actualiser la liste », action serveur `refresh` déjà présente).
3. **Resélection automatique** : appareil enregistré absent de la liste → appareil du même nom (même type, actif de préférence) adopté et enregistré (`data/spotify.json`), journal « Appareil Spotify retrouvé : {nom} » ; 404 sur lecture → resélection puis un seul nouvel essai par transfert `PUT /me/player {device_ids:[id], play:true}`. Le nom de l'appareil n'est jamais effacé lors d'un changement d'identifiant.
4. La liste des appareils est gardée côté serveur (`view().devices`) : elle survit au rechargement de la page. L'appareil enregistré reste affiché et sélectionné même absent (« {nom} (introuvable) ») : plus de bascule silencieuse.
5. Après une resélection réussie, l'automatisme repart pour le silence en cours (compteur d'essais remis à zéro), sans passer outre une pause décidée par le bar ; au plus une fois par 10 minutes dans une même période (la limite repart à chaque nouvelle période : un appareil perdu de nouveau au silence suivant est repris), et pas quand seul l'appel de relance (`PUT /me/player/play`, ou le transfert) échoue en 5xx alors que les vérifications réussissent (deuxième relecture finale R5 : sinon trois relances de plus et un faux « Spotify rétabli » toutes les quelques minutes). Une panne du lecteur (`GET /me/player`) dans la relance est une panne de Spotify : reprise à son retour, comme une vérification qui voit Spotify en panne ou sans appareil après l'échec de l'appel (troisième relecture finale R1 : un 502 de l'appareil puis « aucun appareil » laissait la musique coupée tout le silence). La règle du 5xx ne vise que la relance : une pause en échec est reprise (troisième relecture finale R2 : sinon Spotify jouait toute la chanson par-dessus le chanteur). Rien au journal sans reprise.
6. Pastille aussi sur l'écran Scène, à côté de celle de KaraFun, quand Spotify est configuré.
7. Petit correctif : la pause avant un titre n'est plus sautée quand une lecture d'état Spotify est en cours (`server.js:2516`).

---

## F. Barre de lecture du titre sur scène

**Ce que donne KaraFun** (vérifié dans les trames réelles enregistrées, `test/song-settings.test.js:164-167`, `test/kcs-protocol.test.js:1140-1142`) : ni position ni durée dans `StatusEvent` ; seul le faux KaraFun de démo envoie `position`. Le catalogue et la recherche donnent `duration` en secondes (`catalog.js:11-25`, `karafun.js:1433-1442`).

**Changement**
1. Durée : cache serveur `songId → duration` rempli par toutes les réponses de recherche et de catalogue relayées (à côté de `rememberBattleSongs`, `server.js:96-111`) ; sinon `song.duration` envoyé par la page, borné à 30–1200 s ; en démo `--song-seconds`. Si un jour KaraFun envoie une position ou une durée numérique, elles sont prises en priorité.
2. Temps écoulé : départ `tr.startedAt` (nos titres, déjà sauvegardé) ou `curSince` (titres ajoutés dans KaraFun) ; pauses décomptées (état `paused` ou `kcsState` 5) ; tempo intégré (`rate = 1 + tempo/100`, le tempo en direct raccourcit le reste). Remis à zéro par « Relancer depuis le début » (nouvel identifiant de file).
3. `publicState().stage.progress = {elapsedSec, durationSec|null, paused, rate}` calculé à `now` ; les pages corrigent l'écart d'horloge avec `state.now` et avancent seules chaque seconde par un `setTimeout` qui se reprogramme (pas de second `setInterval` : les tests n'en gardent qu'un ; délai distinct de ceux des tests).
4. Bar, carte « Sur scène » : barre fine et « 1:42 / 3:57 · reste 2:15 » ; durée inconnue ou Battle : « 1:42 écoulées » sans barre ni fin ; pause : « En pause ».
5. Téléphones, encadré « Sur scène » : barre fine et « reste 2 min » (traduit) ; rien pour une Battle ou une durée inconnue.
6. Hors périmètre : utiliser ce reste pour les heures estimées ou l'heure de fermeture.

---

## G. Réglages isolés par titre (défaut)

**Cause confirmée** (reproduction avec le vrai `server.js` et un faux KaraFun « collant ») : au début d'un titre sans réglage, l'application n'envoie rien (`server.js:885`, `song-settings.js:225`) et compte sur KaraFun pour revenir à zéro — comportement jamais vérifié sur le KaraFun du bar ; le faux KaraFun remet toujours à zéro, donc aucun test ne pouvait voir la fuite ; si KaraFun garde la voix guide à 25, chaque titre suivant la garde, et `_observeDefaults` (`karafun.js:1370-1378`) apprend alors 25 comme « valeur par défaut », ce qui fausse les remises à zéro suivantes et masque l'anomalie au bar. Les réglages enregistrés dans la file, eux, ne fuient pas (chaque titre a les siens).

**Changement**
1. Au chargement de chaque titre (états 3/4/5, une seule fois par identifiant de file), cible = valeurs neutres (tonalité 0, tempo 0, voix guide 0, voix guide B 0 si le titre l'a, chœurs à la vraie valeur par défaut du bar seulement si le titre précédent les avait changés) complétées par les réglages du titre. Seules les différences avec l'état réel sont envoyées : aucun envoi quand KaraFun remet déjà à zéro. S'applique aussi aux titres ajoutés directement dans KaraFun (avec leurs propres options KaraFun). Un titre que l'application n'a pas vu se charger (premier état vu déjà en lecture : redémarrage de l'application, reconnexion de la télécommande) ne reçoit jamais de valeur neutre, titre de la file compris : seuls ses propres réglages sont rattrapés.
2. Les valeurs par défaut apprises ne prennent plus la voix guide (toujours 0) ; les chœurs ne sont appris que sur un titre que l'application n'a pas modifié. Une remise par KaraFun au chargement (titre vu se charger à une autre valeur que celle laissée par le titre d'avant, ou envoyée par la file) donne toujours la valeur, même déjà relevée ou reprise. Après un titre vu pour la première fois déjà en lecture, ses chœurs passent au titre suivant chez un KaraFun « collant » comme chez un KaraFun qui remet à zéro (trames identiques) : sans valeur connue, celle du titre suivant est relevée pour la soirée mais provisoire (`provisionalDefaults`, sauvegardée comme telle) jusqu'à une remise ; avec une valeur connue, rien n'est relevé avant une remise. La valeur relevée et confirmée est gardée dans la sauvegarde (`settings.karafunDefaults`, empreinte du code KaraFun, reprise tolérante) et reprise au redémarrage pour le même code ; un nouveau code oublie aussi les titres vus se charger. Troisième relecture finale R4 : un pont neuf (application relancée, même entre deux titres) et un nouveau code partent d'une histoire inconnue (le même KaraFun peut garder un réglage en direct) : la première valeur relevée est provisoire jusqu'à une remise par KaraFun au chargement ; vérification de la troisième relecture : elle est sauvegardée comme provisoire (`provisional: true`, un KaraFun collant ne remet jamais ses chœurs), reprise comme telle au redémarrage sans valeur confirmée et jamais remplacée par une valeur provisoire relevée ensuite, de sorte qu'un réglage en direct gardé par KaraFun au redémarrage n'est pas appris ; « Nouvelle soirée » oublie une valeur provisoire (sauvegardée et celle du pont), pour qu'une valeur fausse ne dure jamais plus d'une soirée ; quatrième passe de la relecture finale (K1) : une valeur confirmée reste, et après « Nouvelle soirée » ou un nouveau code les chœurs que KaraFun garde d'un titre vu ne sont jamais relevés, seulement une remise au chargement.
3. Réglage en direct ciblé : la page du bar envoie l'identifiant de file du titre affiché ; si le titre a changé entre-temps, refus « Le titre a changé : réglage non envoyé. » et rien n'est enregistré sur le nouveau titre.
4. Journal `song.settingsReset` ; sans le droit « Personnaliser la chanson en cours » : note au bar « Le réglage du titre précédent est peut-être resté sur « … » : KaraFun ne laisse pas l'application personnaliser la chanson en cours. ».
5. Faux KaraFun : option `stickyLive` pour reproduire un KaraFun qui garde les réglages ; tests dans les deux comportements.
6. `GUIDE-BAR.md` (vérifications hors service) : « Mettre la voix guide à 25 en direct, puis vérifier que le titre suivant démarre en tonalité 0 et voix guide coupée. ».

### G2. Voix guide réglable voix par voix (demande du 8 octobre)

**Aujourd'hui** (vérifié, `song-settings.js:6-9, 18, 138-140, 176-181, 235-236`) : KaraFun annonce les pistes vocales de chaque titre (`songTracks` : 4 = chœurs, 5 = voix guide 1, 6 = voix guide 2) et accepte un volume par piste (`TrackVolumeRequest {type, volume}`). L'application n'a qu'un réglage « guide » : il vise la voix 1 ; la voix 2 ne le suit que pour un titre inscrit en duo. Un titre à deux voix chanté seul ne reçoit donc le guide que sur une voix. Aucune trame réelle ne montre de troisième voix.

**Changement** (décision du gérant, D6 : un curseur par voix, pas de curseur commun)
1. Réglages d'un titre : chaque voix guide a son propre volume. `guide` reste la voix 1 (piste 5, compatibilité des sauvegardes) ; `guideVoices` = `{ "<type de piste>": volume }` règle les autres voix (`{ "6": 50 }`). Une voix sans réglage vaut 0 (guide coupé). Pistes de voix guide : 5, 6 et toute autre piste de voix que KaraFun annonce pour ce titre (hors chœurs 4), sans supposer leur nombre. Validation : types entiers annoncés ou plausibles (5 à 15), volumes 0 à 100 par pas de 25 ; sauvegarde et reprise avec le reste des réglages.
2. La règle actuelle « en duo, la voix 2 suit la voix 1 » disparaît : chaque voix est indépendante, en solo comme en duo. Une ancienne sauvegarde (duo avec `guide` et la valeur interne `guideB`) est reprise en `guideVoices["6"]`, sans perte. Une page gardée en cache d'avant la mise à jour garde son comportement sur un duo : un réglage sans `guideVoices` pose aussi la voix 2 (`guideVoices["6"] = guide`, retirée sans voix guide, comme après sa remise par défaut ; autres voix gardées), et son réglage en direct de la voix guide (sans `queueId`) règle aussi la piste 6 d'un duo de la file.
3. Interfaces (bar : réglages en direct et fiche du titre ; téléphones : réglages d'un titre à venir) : un titre à une voix montre « Voix guide » ; un titre à plusieurs voix montre « Voix 1 », « Voix 2 » (et « Voix 3 »… si KaraFun en annonce), sans curseur commun. Un titre dont les pistes ne sont pas encore connues (pas encore dans KaraFun) montre « Voix 1 » et « Voix 2 (si le titre en a deux) », la seconde appliquée seulement si le titre l'a. Phrases des téléphones traduites.
4. Isolation (lot G) : au chargement de chaque titre, toutes ses voix guide reviennent à 0 sauf réglage explicite de ce titre ; un réglage en direct d'une voix ne s'enregistre que sur le titre en cours (identifiant de file vérifié).
5. Tests : pistes 5 et 6 en solo et en duo réglées séparément, voix 2 seule, piste supplémentaire annoncée, titre sans voix 2 (réglage ignoré), retour à 0 sur le titre suivant avec un KaraFun « collant », anciennes sauvegardes reprises sans perte.

---

## I. Durée des titres avant l'ajout (demande du 8 octobre)

La durée (secondes) arrive déjà sur les téléphones avec le catalogue (`catalog.js:20`) et la recherche (`karafun.js:1441`), sans être affichée. Elle s'affiche désormais en « 3:57 » après l'artiste dans les listes du catalogue et de la recherche, dans la fiche du titre avant l'ajout et dans « Mes titres » ; une durée inconnue ou aberrante (hors 20 s à 1 h) n'affiche rien. Aucune phrase nouvelle à traduire. Test : `test/client-ui-coverage.test.js` (« durée des titres »).

---

## J. Durée maximale des titres (demande du 8 octobre)

**Aujourd'hui** : aucune limite. La durée fiable d'un titre est connue du serveur dès qu'il l'a vu passer dans le catalogue ou la recherche (`catalogDurations`, `server.js:92`, rempli par les réponses de KaraFun qu'il relaie) ; celle envoyée par le téléphone (`song.duration`) n'est pas fiable. Les ajouts des clients passent par `POST /api/table/song`, `/api/table/duet` et `/api/table/battle/propose` ; l'heure de fermeture refuse déjà des ajouts de la même manière.

**Changement**
1. Réglage du bar (« Plus » › règles) : interrupteur « Limiter la durée des chansons » (**coupé par défaut**) et « Durée maximale » en minutes et secondes (5:00 proposé à l'activation, de 2:00 à 15:00). Gardé dans `settings` (sauvegarde de la soirée, validation tolérante : valeur invalide = option coupée) ; journal `settings.changed` avec la valeur.
2. Contrôle serveur, option active : durée = celle du cache fiable, sinon celle du téléphone (bornée comme pour la barre de lecture) ; durée inconnue = accepté. Au-delà : refus « Ce titre dure 6:12 : le bar limite les chansons à 5:00. » (traduit) pour un titre, un duo ou une proposition de Battle d'un client. Le bar (ajout pour quelqu'un, Battle lancée par le bar), les titres déjà dans KaraFun et « Relancer » ne sont jamais concernés.
3. Téléphones : dans le catalogue et la recherche, un titre trop long s'affiche « 6:12 · trop long » en grisé et ne s'ajoute pas (fiche avec le message ci-dessus) ; la limite est envoyée dans l'état public (`rules.maxSongSec`).
4. Titres déjà dans la file au moment de l'activation (décision D9) : ils restent. Dans la file du bar, chacun porte le repère court « trop long » au début de son titre, à toutes les largeurs (durée et limite dans l'infobulle ; seconde relecture : l'ancien badge « plus long que 5:00 » était coupé sur PC ; troisième relecture : avec « ⚠ Doublon » ou « Chanté », le titre ne gardait que 18 à 24 px, il passe désormais sous les repères, sur toute la largeur, quand il ne tient pas à côté) ; sous l'interrupteur apparaît « Retirer les N titres trop longs » (confirmation, titres pas encore dans KaraFun seulement) ; chaque personne concernée est prévenue sur son téléphone par l'avis de retrait existant. Seuls les nouveaux ajouts sont refusés.
5. Tests : serveur (option coupée = aucun refus ; titre, duo et Battle refusés au-delà ; cache fiable prioritaire sur une durée falsifiée par le téléphone ; durée inconnue acceptée ; bar jamais limité ; titres déjà en file gardés et signalés ; retrait groupé avec avis ; sauvegarde et valeurs invalides), page du bar (interrupteur, durée, badge, retrait groupé), téléphones (titre trop long grisé, message traduit).

---

## K. Prénom seul pour les solistes (demande du 8 octobre)

**Aujourd'hui** (inventaire vérifié, 118 emplacements) : le nom de chanteur envoyé à KaraFun accole le nom du groupe solo, « Léa · En solo » (`scheduler.js:2344-2345`, repris à `scheduler.js:937`, `server.js:3779` et `server.js:1657`). Il s'affiche sur l'écran de la salle, dans la file et la scène de tous les téléphones (`client.html:1570`, `1575`, `1944`), et le bar le voit aussi. En anglais, le téléphone recompose « Léa · Solo » (`client.html:1606`). Le choix du partenaire de duo montre « ↗ Sam · En solo » (`client.html:3074-3080`, `staff.html:1159-1162`). Sur la page du bar, on retrouve l'étiquette dans la pastille verte « En solo » de la carte Scène (`staff.html:1132`), la file (`1812`), les derniers passages (`1247`), l'alerte « n'a pas répondu » (`1069`), les Repères (`801`), la recherche de transfert (`719`), le journal (« Léa (En solo) s'est inscrit », `scheduler.js:501/530/537/626`, `server.js:3680`) et les statistiques (`stats.html:426/451/631/667/750/778`). Le téléphone d'un soliste affiche « 🎤 En solo » en en-tête et plusieurs phrases qui nomment le groupe. Les prénoms sont uniques dans un même groupe (`scheduler.js:510-519`), donc deux solistes n'ont jamais le même prénom.

**Règle** (décisions D10 et D11) : partout où une personne est nommée, un soliste n'a que son prénom ; une personne de table a son prénom suivi du nom de la table.
1. Une seule fonction `passageLabel(ids)` du planificateur fabrique le nom d'un passage. Elle joint les prénoms par « & » puis ajoute « · » et les tables non individuelles, sans doublon, dans l'ordre des personnes. Exemples : « Léa », « Léa & Sam » (deux solistes), « Léa & Max · Table 4 » (soliste et table), « Max & Zoé · Table 4 + Table 2 ». Elle remplace les quatre constructions ci-dessus ; « Relancer » renvoie à KaraFun le nom recalculé et le reconnaît sous ce nom.
2. Affichage : la scène, la file, l'envoi en cours, la page du bar et les avis de doublon recalculent le nom à partir des personnes du passage. Ils ne réutilisent pas le texte enregistré, si bien qu'une soirée commencée avant la mise à jour s'affiche tout de suite au nouveau format. Le texte enregistré (`sel.label`) ne sert plus qu'à reconnaître le titre dans KaraFun ; un envoi déjà parti garde son texte d'origine. Pour une ligne de KaraFun que l'application ne suit pas, le suffixe du groupe solo (« · En solo », « En solo + ») est retiré à l'affichage.
3. Téléphones : l'en-tête d'un soliste montre son prénom (« Bienvenue » tant qu'aucune personne n'est gérée) ; la recomposition anglaise disparaît. Le choix du partenaire de duo montre « Sam » pour un soliste et « Max · Table 4 » à une table ; sur le téléphone d'un soliste, les autres solistes ne sont plus présentés comme « À ma table ».
4. Phrases reformulées sans l'étiquette, en français et en anglais : récupération (`client.html:1308`), code de changement de téléphone (`1473`), catalogue sans inscription (`2672`), inscription refusée (`2059`), erreurs du serveur (`server.js:2096`, `2104`, `2209`, `3130`), fenêtres du bar montrées au client (« QR de reprise » `staff.html:707`, texte de remplacement du QR `280`).
5. Page du bar : plus de pastille ni d'étiquette « En solo » à côté d'un prénom (Scène, File, Derniers passages, Repères, alerte, recherche de transfert, choix du partenaire, journal) ; dans un duo soliste + table, seule la table apparaît ; le groupe d'options s'appelle « Autres personnes ». Le bar retrouve les solistes dans la liste « Solistes » de l'Accueil. Les écrans de gestion qui nomment le groupe lui-même (tuile de l'Accueil, fiche du groupe, regroupement et filtre des Repères, carte « Tables » des statistiques) gardent leur nom.
6. Statistiques : un soliste s'affiche « Léa » (filtre, info-bulles, panneau personnel), et la colonne « Table » reste vide pour lui.
7. Garde-fous : le prénom « Battle collective » est refusé, car il se confondrait avec le nom de la Battle dans KaraFun. Une personne qui n'a pas encore donné son prénom (« Solo N ») n'est proposée dans aucun choix de partenaire du bar, et le serveur refuse ce duo.
8. Tests : `passageLabel` (solo, deux solos, mixte, tables, départ d'un invité de duo, duo noté par le bar), affichage recalculé pour une soirée enregistrée à l'ancien format, ligne KaraFun non suivie, « Relancer », prénom réservé, en-tête et choix du partenaire du téléphone (FR et EN), pages du bar et des statistiques ; les tests qui figeaient « · En solo » sont mis à jour.

**Hors périmètre** : renommer le groupe lui-même dans les écrans de gestion du bar ; les journaux techniques sur disque et le diagnostic brut de KaraFun.

## L. Battle : les retardataires votent (défaut signalé le 8 octobre)

**Cause confirmée** : la liste des votants est figée à l'ouverture du vote (`server.js:3278`, `eligiblePersonIds: battleElectorate()`). Ensuite, `battle-vote.js:258` refuse toute autre personne (« Cette personne ne peut pas voter. »), et `client.html:1995` n'affiche la carte de vote qu'aux personnes de cette liste. Sont exclus : une personne arrivée après l'ouverture, et un soliste qui n'avait pas encore donné son prénom (`nameRequired`, lot A).

**Changement** : tant que le vote est ouvert, toute personne inscrite, nommée et présente peut voter, y compris si elle est arrivée ou a donné son prénom après l'ouverture. La règle de majorité et le nombre minimal de votants ne changent pas ; le vote se clôt plus tôt quand toute la liste à jour a voté ; une personne partie garde son droit, comme aujourd'hui. Une seule fonction serveur ajoute les nouveaux inscrits pendant le vote. Elle est appelée après chaque changement d'état et avant chaque vote.

---

## H. Graphique « Déroulé de la soirée » (défaut)

**Cause confirmée** (capture reproduite dans Chromium) : la soirée du samedi est restée ouverte (« – en cours », « En direct ») car elle ne se clôt qu'avec « Supprimer toutes les tables » ; l'axe va donc du samedi 22:42 à maintenant, plusieurs jours plus tard ; toutes les barres tombent à 2 px dans les premiers pour cent du graphique et `timeTicks` (`stats.html:242-250`, pas maximal d'une heure, sans tenir compte de la largeur) produit des dizaines d'heures superposées.

**Changement** (`public/stats.html` seulement)
1. Graduations selon la largeur : pas pris dans 5, 10, 15, 30 min, 1, 2, 3, 6, 12 h, 1 jour, au moins 60 px entre deux étiquettes ; même fonction pour le graphique de la file.
2. Étiquettes avec le jour quand la durée dépasse 20 h (« dim. 14:00 »).
3. Domaine du Déroulé limité à l'activité : si la fin dépasse de plus de 3 h le dernier passage, l'axe s'arrête 15 min après ce passage, avec la note « Dernier passage à 00:20 · soirée encore ouverte » (ou « · soirée close à … »). Une soirée normale en direct garde « maintenant » visible (un temps mort de 40 min reste affiché).
4. Hors périmètre (à proposer au gérant) : clôturer seule une soirée inactive depuis plus de 8 h.

---

## P. Porte gstack : correctifs de la relecture

Constats de la relecture gstack (`review`, spécialistes tests, maintenabilité, sécurité, et relecture adverse) et sondes : l'analyse du texte des commandes `Bash` laissait passer `git -C …`, `bash -c "git push"`, un alias ou un worktree lié, et bloquait à tort un `git commit -m "… git push …"` ; une relecture non convergée était acceptée ; l'état de la porte se déverrouillait en l'écrivant.
1. L'envoi est contrôlé par un hook git `pre-push` (`.claude/hooks/pre-push`) que le hook de démarrage copie dans le dossier des hooks du dépôt, sauf hook étranger ou `core.hooksPath` réglé. Il n'agit que pour Claude Code (`CLAUDECODE=1`) : chaque commit envoyé doit avoir l'arbre exact d'une relecture `/review` terminée, convergée et liée par gstack ; commit déjà sur le serveur, étiquette déjà publiée et suppression passent. Plus aucune analyse du texte des commandes Bash.
2. L'écriture de fichiers par l'API GitHub (`push_files`, `create_or_update_file`, `delete_file`) est refusée vers ce dépôt ; une PR reprend une branche déjà envoyée, donc déjà contrôlée.
3. `.gstack/porte/` n'est plus modifiable par les outils d'édition et les entrées forgées sont ignorées ; nom `..x` à la racine bien considéré dans le dépôt ; `GSTACK_ROOT` relatif résolu comme dans les scripts shell ; emplacements alignés sur gstack (`.copilot`) ; compétences d'administration reconnues sous leurs deux noms ; un échec d'écriture de la trace est signalé à l'agent ; tests du hook Codex et de la table de routage au démarrage.

---

## Critères d'acceptation

1. A : ouvrir un QR individuel crée la personne (bar : « prénom à saisir ») avant toute saisie ; 30 min plus tard elle peut encore donner son prénom ; tant qu'elle ne l'a pas fait, rien d'autre n'est visible ni possible sur son téléphone.
2. A : le même QR ouvert sur un autre navigateur propose « Récupérer mes chansons » pour la même personne ; le nombre de personnes ne change pas ; l'ancien téléphone perd l'accès.
3. A : un QR individuel ne crée jamais deux personnes ; un téléphone ne crée jamais deux solos ; les tests figés de `solo-comptoir-api` restent verts (un seul évolue, voir A2).
4. B : mode coupé, le QR d'événement est refusé ; mode actif, deux téléphones différents donnent deux chanteurs, le même navigateur retrouve son chanteur ; « Renouveler » refuse l'ancien QR sans couper les inscrits ; « Supprimer toutes les tables » coupe le mode ; un redémarrage le garde.
5. C : une page restée cachée 30 min fait passer la personne en « Sans nouvelles depuis 30 min » ; la rendre visible la remet à « Actif à l'instant » ; rien ne s'affiche pour les tables ni pour les personnes parties.
6. D : un téléphone de table affiche le QR de sa table ; un nouveau téléphone qui le scanne voit « Rejoindre la table » en tête ; la page principale ne liste que les personnes gérées par ce téléphone ; « Voir toute la table (N) » liste tout le monde.
7. E : identifiant d'appareil périmé → l'appareil du même nom est repris seul, la lecture repart, la liste montre toujours l'appareil choisi ; 204 sans appareil → pastille orange, plus verte ; une vérification réussie efface l'ancienne erreur.
8. F : la barre atteint 100 % à la durée du titre en démo ; pause figée ; titre relancé repart de zéro ; durée inconnue → temps écoulé seul.
9. G : avec un KaraFun « collant », voix guide 25 en direct sur A, B sans réglage démarre à 0 ; avec un KaraFun qui remet à zéro, aucune trame en plus ; un réglage en direct envoyé pendant le changement de titre est refusé.
10. H : une soirée ouverte 4 jours montre des barres lisibles sur au moins la moitié de la largeur et des étiquettes espacées d'au moins 40 unités, sur ordinateur et à 360 px.
11. P : `git push` depuis Claude Code (quelle que soit son écriture, worktree lié compris) échoue sans relecture terminée et convergée sur l'arbre exact, passe après ; `git commit -m "… git push …"` n'est plus bloqué ; un `git push` tapé par l'utilisateur hors de Claude Code n'est jamais concerné.
12. K : un soliste apparaît « Léa » sur l'écran KaraFun, dans la file et la scène des téléphones (FR et EN) et sur la page du bar ; un duo soliste + table apparaît « Léa & Max · Table 4 » ; aucune phrase vue par un client ne contient « En solo » ; une soirée enregistrée avant la mise à jour s'affiche au nouveau format.
13. L : une personne qui rejoint une table, entre par le QR d'événement ou donne son prénom après l'ouverture d'un vote Battle voit la carte de vote sans recharger, et son vote compte.
14. `node test/run-offline.js` vert, couverture ≥ 95 % (`node test/coverage.js --min-lines 95`), toutes les nouvelles phrases des téléphones traduites, `RAPPORT-TEST.md` à jour.

## Plan de tests

| Couche | Quoi | Nombre |
|---|---|---|
| Unitaire | `private-event.js` ; valeurs neutres de `catchUpCommands` ; durée et temps écoulé ; graduations du graphique ; `resolveDevice` Spotify ; porte gstack (pre-push, relecture convergée) | +25 |
| Serveur (vm) | `/api/table/solo/open`, récupération par clé, `/api/table/enter`, activité visible/cachée, `/api/table/invite`, réglage en direct ciblé, santé Spotify | +30 |
| API démo | parcours solo complet et événement privé sur un port libre (3103, 3115+) | +2 fichiers |
| Interface (vm) | fenêtre de prénom, récupération, page de table centrée, QR de table, liste Solistes, libellés d'activité, pastille Spotify, barre de lecture, graphique | +30 |
| Navigateur (gstack `qa`) | solo à 390 px (ouverture, prénom, récupération dans un autre contexte), événement privé, table à 3 téléphones, Scène avec barre, statistiques | 5 parcours |

## Retour arrière

Annuler la PR. Les nouveaux champs (personne : `nameRequired`, `soloKeyHash`, `lastActionAt` ; soirée : `privateEvent` ; Spotify : `deviceType`) sont facultatifs à la lecture : une ancienne version ignore ces champs.

## Documentation

`GUIDE-BAR.md` (accueil, En solo, événement privé, Spotify, réglages, statistiques, vérifications hors service), `CONTEXTE-REPRISE.md` (règles d'accès solo et exception de l'événement privé), `README.md:9`, `LISEZMOI.txt`, `AGENTS.md` (porte gstack).

## Décisions prises avec le gérant (8 octobre)

- **D1, événement privé** : un scan depuis un autre navigateur crée toujours un nouveau chanteur ; pas de reprise par prénom. Le même navigateur retrouve son chanteur.
- **D2, solo qui perd sa page** : le QR individuel devient la clé personnelle de la soirée (récupération de la même personne sur n'importe quel téléphone, jamais une deuxième place), l'adresse garde la clé, et le bar a une liste des solistes triée par activité avec « QR de reprise » en un toucher.
- **D3, tables** : la page principale ne montre que les personnes gérées par ce téléphone ; « Voir toute la table (N) » ouvre la liste complète.
- **D6, voix guide** : un curseur par voix guide (voix 1, voix 2…), pas de curseur commun ; chaque titre revient à 0 au suivant.
- **D9, durée maximale** : à l'activation, les titres déjà dans la file restent, signalés au bar avec un retrait groupé en un geste ; seuls les nouveaux ajouts sont refusés.
- **D10, prénom seul** : la règle vaut partout (écran KaraFun, téléphones et page du bar) ; le bar retrouve les solistes dans la liste « Solistes ».
- **D11, téléphone du soliste** : l'en-tête montre son prénom et les phrases qui nommaient « En solo » sont reformulées (FR et EN).
- Autres choix par défaut de cette spécification (sans objection) : dernière activité affichée pour les solos seulement, seuils 20 et 45 minutes ; barre de lecture au bar et sur les téléphones ; pastille Spotify aussi sur l'écran Scène ; graphique corrigé dans la page seulement (pas de clôture automatique des soirées).
