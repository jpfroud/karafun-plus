# Déployer la file karaoké sur un serveur Linux

Ce fichier est livré dans l'image (`/app/DEPLOIEMENT-SERVEUR.md`) et dans le kit (`karaoke-bar/DEPLOIEMENT-SERVEUR.md`).

Ce guide installe la file karaoké sur un VPS Linux loué chez OVHcloud, sous Docker, derrière Caddy en HTTPS. Le kit Windows reste le secours. Les blocs `bash` se tapent sur le serveur, les blocs `powershell` sur un PC Windows d'administration.

Valeurs à remplacer dans les commandes :

| Valeur | Sens |
|---|---|
| `<IPv4 du VPS>` | adresse IPv4 du serveur (section 3) |
| `<ancienne IPv4>` | adresse IPv4 que donnait le nom des QR avant la bascule (notée en section 9, point 2) |
| `<utilisateur OVH>` | compte de connexion donné par OVHcloud à la livraison du VPS |
| `<code>` | code affiché par la Télécommande de KaraFun |
| `vX.Y.Z` | version à installer (tag de la release) |
| `vA.B.C` | version précédente, pour un retour en arrière |
| `AAAAMMJJ` | date du jour, dans le nom d'une archive |
| `<nom de l'archive>` | nom d'un fichier de `deploy/sauvegardes/` |
| `<dossier karaoke-bar du kit>` | dossier `karaoke-bar` du kit Windows décompressé |
| `exemple.fr` | ton domaine (section 2) |
| `clients.exemple.fr` | hôte des QR imprimés, `HOTE_CLIENTS` (section 2) |
| `bar.exemple.fr` | hôte de la page du bar, `HOTE_BAR` (section 2) |
| `essai.exemple.fr`, `essai-bar.exemple.fr` | noms d'essai d'une bascule (section 2) |

`exemple.fr` est un vrai domaine, qui n'est pas le tien : il répond pour tous ses sous-domaines. Une commande lancée avec un nom d'exemple joindrait donc son serveur, mot de passe du bar compris.

## 1. Vue d'ensemble

```text
Téléphones des clients --HTTPS--> clients.exemple.fr --> caddy --> app:3001
Gérants --HTTPS et mot de passe--> bar.exemple.fr    --> caddy --> app:3000
Administrateur --tunnel SSH--> 127.0.0.1:3000 de l'hôte -------> app:3000
Port 3001 : jamais publié. Pare-feu ufw : 22, 80 et 443 (443 aussi en UDP).
PC du bar (Windows) : KaraFun et sa Télécommande, comme avant.
```

Le serveur fait tourner deux conteneurs, décrits par `deploy/compose.yaml`. `caddy` reçoit tout le trafic d'Internet et obtient les certificats de Let's Encrypt. `app` est la file elle-même, en mode serveur.

Le nom des clients (`clients.exemple.fr` dans ce guide) mène au port clients 3001. Le nom de la page du bar (`bar.exemple.fr`) mène au port 3000, derrière un mot de passe demandé par Caddy en plus de la clé du bar. Le port 3000 est aussi publié sur `127.0.0.1:3000` de l'hôte, pour le tunnel SSH de l'administrateur. Le port 3001 n'est jamais publié. Le pare-feu n'ouvre que 22, 80 et 443 (443 aussi en UDP).

Une seule file à la fois : jamais le kit Windows en même temps que le serveur. Deux files se disputeraient la Télécommande de KaraFun, et leurs soirées divergeraient.

La file pilote KaraFun par Internet. KaraFun et sa Télécommande restent sur le PC du bar : rien n'y change.

## 2. Avant de commencer

Il te faut :

- un compte OVHcloud et un domaine dont la zone DNS est chez OVHcloud ;
- un PC Windows d'administration, avec PowerShell et le client OpenSSH de Windows ;
- une release `vX.Y.Z` publiée (kit Windows et image `ghcr.io/jpfroud/karafun-plus:vX.Y.Z`), voir `.github/RELEASE.md` dans le dépôt.

**Hôte des QR imprimés.** Le champ « Adresse publique HTTPS » de la page du bar donne l'adresse des QR déjà imprimés. Son hôte, sans `https://`, devient `HOTE_CLIENTS` : les QR imprimés continueront d'y mener. Dans ce guide : `clients.exemple.fr`.

**Hôte du bar.** `HOTE_BAR` de `deploy/.env` est un nom nouveau, réservé à la page du bar. Nom proposé : `bar.exemple.fr`.

**Noms d'essai.** Pour une bascule depuis le PC Windows, le serveur tourne d'abord sous deux noms d'essai : `essai.exemple.fr` (clients) et `essai-bar.exemple.fr` (bar). Les vrais noms ne changent de cible qu'à l'étape 6 de la section 12.

**Zone DNS.** Dans PowerShell, `Resolve-DnsName exemple.fr -Type NS` doit donner des serveurs d'OVHcloud (leur nom contient `ovh`, ou `anycast` avec l'option DNS Anycast d'OVHcloud). Sinon, par exemple pour une zone chez Cloudflare, arrête-toi : ce guide ne couvre que la zone d'OVHcloud.

**Clé SSH.** Sur le PC d'administration, dans PowerShell :

```powershell
ssh-keygen -t ed25519 -C "karafun-plus-vps"
```

Accepte le fichier proposé et choisis une phrase de passe. Si `ssh-keygen` demande `Overwrite (y/n)?`, une clé existe déjà : réponds `n` et garde-la, elle sert telle quelle. La clé privée `id_ed25519` ne quitte jamais ce PC.

**Contrôle** : `Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"` affiche une seule ligne, qui commence par `ssh-ed25519` et finit par `karafun-plus-vps` (ou par le commentaire de ta clé existante).

## 3. Créer le VPS chez OVHcloud

Commande un VPS « VPS-1 » sur `www.ovhcloud.com`. Choisis une localisation en France, et le système Debian 12 ou Ubuntu 24.04. Ne prends aucune option.

Après la livraison, l'espace client d'OVHcloud liste le serveur dans « Serveurs Privés Virtuels », avec son adresse IPv4 : c'est `<IPv4 du VPS>`. L'e-mail de livraison donne le compte de connexion, `<utilisateur OVH>` (souvent `debian` ou `ubuntu`), et son mot de passe.

**Contrôle** : « Serveurs Privés Virtuels » montre le VPS démarré avec `<IPv4 du VPS>`, et tu as `<utilisateur OVH>` et son mot de passe.

## 4. Première connexion, clé SSH et mises à jour

Depuis PowerShell, pose ta clé publique sur le serveur. Le mot de passe de l'e-mail est demandé une dernière fois. À la première connexion, SSH montre l'empreinte du serveur : réponds `yes`.

```powershell
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub" | ssh <utilisateur OVH>@<IPv4 du VPS> "umask 077; mkdir -p ~/.ssh; tr -d '\r' >> ~/.ssh/authorized_keys"
ssh <utilisateur OVH>@<IPv4 du VPS>
```

La seconde commande ouvre une session sans le mot de passe de l'e-mail : seule la phrase de passe de la clé est demandée. Si le serveur exige un nouveau mot de passe, choisis-le. Si la première commande répond `Password change required but no TTY available`, lance d'abord la seconde, change le mot de passe, tape `exit`, puis relance la première.

Sur le serveur, mets le système à jour, installe les mises à jour de sécurité automatiques et règle le fuseau horaire :

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
sudo timedatectl set-timezone Europe/Paris
```

À la question de `dpkg-reconfigure`, réponds oui (« Yes »). Redémarre ensuite par `sudo reboot`, puis reconnecte-toi : un noyau mis à jour ne sert qu'après un redémarrage, et Debian ne crée pas le fichier `/var/run/reboot-required` qui le signale sous Ubuntu.

**Contrôle** : `timedatectl` affiche `Time zone: Europe/Paris`, et `apt-config dump APT::Periodic::Unattended-Upgrade` affiche `APT::Periodic::Unattended-Upgrade "1";`.

## 5. Utilisateur d'administration et SSH sans mot de passe

Crée le compte `karaoke`, qui fera tout le reste. Son mot de passe ne sert qu'à `sudo` : choisis-en un long, gardé dans un gestionnaire de mots de passe.

```bash
sudo adduser --comment "" karaoke
sudo usermod -aG sudo karaoke
sudo install -d -m 700 -o karaoke -g karaoke /home/karaoke/.ssh
sudo install -m 600 -o karaoke -g karaoke ~/.ssh/authorized_keys /home/karaoke/.ssh/authorized_keys
```

Ferme ensuite toute connexion par mot de passe, et tout compte autre que `karaoke` :

```bash
sudo tee /etc/ssh/sshd_config.d/00-karafun-plus.conf > /dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers karaoke
EOF
sudo sshd -t && sudo systemctl restart ssh
```

Le serveur SSH garde la première valeur lue pour chaque réglage. Le fichier `00-karafun-plus.conf` passe donc avant `50-cloud-init.conf`, que l'image du VPS peut contenir et qui peut permettre les mots de passe.

**Garde la première session ouverte** jusqu'à la fin de l'essai. Dans une nouvelle fenêtre PowerShell, ouvre une session `karaoke`, puis tape `sudo -v` : le mot de passe de `karaoke` est demandé.

```powershell
ssh karaoke@<IPv4 du VPS>
```

Ferme cette session, puis essaie l'ancien compte : SSH doit répondre `Permission denied (publickey).`.

```powershell
ssh <utilisateur OVH>@<IPv4 du VPS>
```

Seulement alors, dans la première session, verrouille l'ancien compte et retire son `sudo` sans mot de passe, posé par cloud-init :

```bash
sudo passwd -l <utilisateur OVH>
sudo rm -f /etc/sudoers.d/90-cloud-init-users
```

Ferme ensuite la première session. Toutes les commandes suivantes se tapent dans une session `karaoke`.

**Contrôle** : `sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|allowusers) '` affiche `permitrootlogin no`, `passwordauthentication no`, `kbdinteractiveauthentication no` et `allowusers karaoke`, et `sudo passwd -S <utilisateur OVH>` montre `L` en deuxième colonne.

## 6. Pare-feu

ufw n'ouvre que SSH (22), HTTP (80) et HTTPS (443, aussi en UDP pour HTTP/3) :

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

`ufw enable` prévient que les connexions SSH peuvent être coupées : réponds `y`, le port 22 est déjà ouvert.

Attention, Docker contourne ufw : un port publié par un conteneur reste joignable même si ufw le ferme. C'est pourquoi `deploy/compose.yaml` ne publie, pour `app`, que `127.0.0.1:3000:3000`. Ne le remplace jamais par `3000:3000`, et ne publie jamais le port 3001.

**Contrôle** : `sudo ufw status` liste `22/tcp`, `80/tcp`, `443/tcp` et `443/udp` en `ALLOW`, avec leurs lignes `(v6)`, et rien d'autre.

## 7. Installer Docker

Docker vient de son dépôt officiel, dont la clé de signature est posée à part :

```bash
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
. /etc/os-release
sudo curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $VERSION_CODENAME
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker karaoke
```

`. /etc/os-release` donne `$ID` (`debian` ou `ubuntu`) et `$VERSION_CODENAME` (`bookworm` ou `noble`) : les mêmes commandes servent aux deux systèmes. Ferme la session puis reconnecte-toi, pour que le groupe `docker` compte.

Le groupe `docker` vaut un accès administrateur au serveur : seul `karaoke` doit y être.

**Contrôle** : `getent group docker` finit par `:karaoke`, sans autre compte, et `docker compose version` répond sans `sudo`.

## 8. Diagnostic KaraFun depuis le serveur

Avant tout le reste, puis le jour de la bascule, vérifie que KaraFun accepte l'adresse du serveur. Récupère d'abord l'image de la release, puis lis son empreinte :

```bash
docker pull ghcr.io/jpfroud/karafun-plus:vX.Y.Z
docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/jpfroud/karafun-plus:vX.Y.Z
```

Elle doit être identique à la ligne « Empreinte » des notes de la release (`ghcr.io/jpfroud/karafun-plus@sha256:…`). Sinon, ne lance pas l'image : retire-la par `docker image rm ghcr.io/jpfroud/karafun-plus:vX.Y.Z`, puis signale l'écart au mainteneur du dépôt. Si Docker répond `unauthorized`, l'image n'est pas encore publique : voir « Une seule fois » dans `.github/RELEASE.md`.

Active ensuite la Télécommande de KaraFun sur le PC du bar et lis son code. Puis, sur le serveur :

```bash
 docker run --rm ghcr.io/jpfroud/karafun-plus:vX.Y.Z node tools/diag-karafun.js <code>
echo "Code de sortie : $?"
```

L'espace en tête de la première ligne la garde hors de l'historique de `bash` (réglage `HISTCONTROL=ignoreboth` des comptes Debian et Ubuntu) : le code n'y reste pas. L'outil lit une seule fois la page de la Télécommande, n'écrit rien et finit par une ligne `Verdict`.

| Code de sortie | Que faire |
|---|---|
| `0` | KaraFun répond normalement à ce serveur : continue. |
| `1` | KaraFun refuse ce serveur : ne déplace pas la file. Relance une seule fois, au moins une heure plus tard. Ne cherche jamais à contourner ce refus. |
| `2` | Non concluant : suis la ligne `Verdict` (code à vérifier, site en panne, réseau coupé). |

Ne lance jamais l'outil en boucle : chaque lecture compte dans la limite horaire que KaraFun applique à l'adresse du serveur.

**Contrôle** : l'empreinte de l'image est celle des notes de la release, et le diagnostic affiche `Code de sortie : 0`, après la ligne `Verdict : KaraFun répond normalement à ce serveur. La migration peut continuer.`

## 9. Noms d'hôtes chez OVHcloud

Dans l'espace client d'OVHcloud, ouvre ton domaine, onglet « Zone DNS ». Chaque nom de la file y est une entrée de type A, créée par « Ajouter une entrée ». Choisis le sous-domaine, la cible `<IPv4 du VPS>`, et un « TTL » « Personnalisé » de 300 secondes.

Nouvelle installation : crée les entrées A de `HOTE_CLIENTS` et de `HOTE_BAR` (sous-domaines `clients` et `bar` de ce guide). Applique ensuite les points 4 et 5 ci-dessous, et le point 7 sept jours plus tard.

Bascule depuis le PC Windows :

1. Tout de suite : crée les entrées A des noms d'essai, `essai` et `essai-bar`.
2. Au moins 24 heures avant la bascule, et plus tôt si l'ancien « TTL » dépasse 24 heures : note d'abord par écrit chaque entrée du nom des QR (type A, AAAA, CNAME ou DynHost, et sa cible). Note aussi l'IPv4 que ce nom donne (`Resolve-DnsName clients.exemple.fr -Type A`) : c'est `<ancienne IPv4>`. L'étape 10 de la section 12 et le retour arrière (section 19) en ont besoin. Puis, sur l'entrée actuelle, « Modifier l'entrée », et « TTL » « Personnalisé » à 300.
3. À l'étape 6 de la section 12 : change la cible du nom des QR pour `<IPv4 du VPS>`, et crée l'entrée A de `HOTE_BAR` si elle manque. Si l'entrée actuelle du nom des QR est un CNAME, supprime-la d'abord, puis crée son entrée A par « Ajouter une entrée » : un CNAME ne coexiste avec aucune autre entrée du même nom.
4. Au même moment, retire pour ces noms toute entrée AAAA ou CNAME, et tout DynHost. La file ne reçoit les téléphones qu'en IPv4 : le réseau Docker du compose n'a pas d'IPv6, et un téléphone venu en IPv6 arriverait avec l'adresse de la passerelle Docker. Tous ces téléphones partageraient alors la même limite d'inscriptions par adresse. Ces libellés de suppression et le menu « DynHost » n'ont pas été vérifiés : cherche-les sur la ligne de l'entrée.
5. Une fois les noms en place, ajoute pour chacun une entrée CAA : drapeau `0`, étiquette `issue`, valeur `letsencrypt.org`. Seul Let's Encrypt pourra alors leur délivrer un certificat. Si le nom des QR est le domaine lui-même, sans sous-domaine, ne lui ajoute pas de CAA : elle vaudrait aussi pour chacun de ses sous-domaines sans CAA propre, et leurs certificats d'une autre autorité seraient refusés. Un retour arrière vers un CNAME demande de retirer d'abord ces entrées CAA (section 19).
6. Une fois la bascule vérifiée (section 12) : retire les entrées A et CAA des noms d'essai, `essai` et `essai-bar`.
7. Sept jours après la bascule : remets le « TTL » de ces entrées à 3600.

N'interroge jamais un nom avant de l'avoir créé, ni par un navigateur, ni par `ping` ou `nslookup`. La réponse « nom absent » resterait en mémoire chez les résolveurs DNS, parfois plusieurs heures.

**Contrôle** : dans PowerShell, `Resolve-DnsName essai.exemple.fr -Type A` (ou chaque nom créé) donne `<IPv4 du VPS>`.

## 10. Fichiers du serveur et secrets

Dans la session `karaoke`, récupère les fichiers de déploiement de la version voulue, puis prépare `deploy/.env` :

```bash
sudo apt install -y git nano
cd ~
git clone https://github.com/jpfroud/karafun-plus.git
cd karafun-plus
git checkout vX.Y.Z
cd deploy
cp .env.example .env
chmod 600 .env
docker run --rm -it caddy:2 caddy hash-password --bcrypt-cost 10
nano .env
docker compose config --quiet
```

Si `git checkout vX.Y.Z` affiche une erreur (`pathspec … did not match`), ne continue pas : les lignes suivantes ont tourné quand même, et `deploy/` est resté sur `main`, une autre version que l'image. Corrige le tag, relance `git checkout vX.Y.Z`, puis reprends le bloc à `cp .env.example .env`.

Choisis un mot de passe du bar long et aléatoire, d'au moins 16 caractères, créé par le gestionnaire de mots de passe et jamais réutilisé : c'est la seule protection si le lien du bar fuit. `caddy hash-password` le demande deux fois : tape-le, il ne s'affiche pas. Ne le passe jamais en argument : il resterait dans l'historique. La commande affiche une empreinte qui commence par `$2a$10$`. Colle-la dans `BAR_PASSWORD_HASH`, entre apostrophes. Le coût 10 limite le calcul fait pour chaque essai sur `BAR_USER` : environ 80 ms au lieu d'une seconde avec le coût 14 de `caddy hash-password` sans option. Un essai sous un autre nom coûte toujours environ une seconde au serveur : des essais répétés peuvent encore occuper le VPS.

Remplis tous les réglages de `.env` avant le premier démarrage :

| Réglage | Valeur |
|---|---|
| `KARAFUN_PLUS_VERSION` | le tag de la release, `vX.Y.Z`, jamais `latest` |
| `HOTE_CLIENTS` | l'hôte des QR imprimés, `clients.exemple.fr` ; en bascule, d'abord `essai.exemple.fr` ; ne le change plus une fois les QR imprimés |
| `HOTE_BAR` | l'hôte de la page du bar, `bar.exemple.fr` ; en bascule, d'abord `essai-bar.exemple.fr` |
| `KARAOKE_PUBLIC_URL` | `https://` suivi de `HOTE_CLIENTS`, sans `/` final |
| `KARAOKE_STAFF_URL` | `https://` suivi de `HOTE_BAR`, sans `/` final |
| `ACME_EMAIL` | ton adresse e-mail, pour Let's Encrypt, en un seul mot : avec le texte d'exemple, Caddy refuse sa configuration (`wrong argument count`) |
| `BAR_USER` | le nom que le navigateur demande avant la page du bar, `bar` par défaut ; si tu en changes, remplace `bar` dans `curl.exe -u bar` (section 11) |
| `BAR_PASSWORD_HASH` | l'empreinte de `caddy hash-password`, entre apostrophes (elle contient des `$`) |

Vérifie ensuite que les quatre noms concordent, par cette commande tapée telle quelle :

```bash
awk -F= '/^HOTE_CLIENTS=/ {c=$2} /^HOTE_BAR=/ {b=$2} /^KARAOKE_PUBLIC_URL=/ {p=$2} /^KARAOKE_STAFF_URL=/ {s=$2} END {if (p == "https://" c && s == "https://" b) print "noms concordants"; else print "noms discordants"}' .env
```

Elle doit afficher `noms concordants`. Sinon, corrige `.env` avant de continuer : une faute dans `KARAOKE_STAFF_URL` enverrait le lien du bar, clé comprise, vers un hôte qui n'est pas le tien (section 13).

Les secrets du déploiement :

| Secret | Où il est | Règle |
|---|---|---|
| Mot de passe du bar | gestionnaire de mots de passe des gérants | jamais sur le serveur : seule son empreinte est dans `.env` |
| `deploy/.env` | serveur, en `chmod 600` | ignoré par git, jamais copié ailleurs |
| Clé du bar | `data/staff-key`, dans le volume des données | jamais écrite au journal, qui n'en garde que l'empreinte ; renouvelable (section 13) |
| Clé SSH privée | PC d'administration (`id_ed25519`) | protégée par sa phrase de passe |
| `data/`, `journal/`, archives | volumes du serveur et `deploy/sauvegardes/` | prénoms, QR secrets, jetons, code KaraFun et jeton Spotify : privés |

**Contrôle** : `git describe --tags --exact-match` affiche `vX.Y.Z`. `docker compose config --quiet` n'affiche rien, `stat -c '%a' .env` affiche `600`, et `grep -c -e '<' -e remplacer -e 'X\.Y\.Z' -e 'exemple\.fr' .env`, tapé tel quel, affiche `0` : aucune valeur d'exemple ne reste. La commande `awk` affiche `noms concordants`.

## 11. Premier démarrage

Pour un nouvel essai, après une bascule ou un retour arrière, prépare d'abord le serveur. Si les noms d'essai ont été retirés (section 9, point 6), recrée leurs entrées A, puis CAA (section 9, points 1 et 5). Remets ensuite dans `.env`, par `nano .env`, les noms d'essai de `HOTE_CLIENTS`, `HOTE_BAR`, `KARAOKE_PUBLIC_URL` et `KARAOKE_STAFF_URL` : l'étape 7 de la section 12 y a mis les noms définitifs. Relance ensuite la commande `awk` de la section 10 : elle doit afficher `noms concordants`. Restaure enfin l'archive de départ notée lors d'un essai précédent. Vérifie-la d'abord : `tar -tzf sauvegardes/<nom de l'archive> | grep -c last-karafun-code` doit afficher `0`. Sinon, elle garde un code KaraFun, et la file relancée par le script s'y reconnecterait : prends une autre archive, sans ce fichier. Restaure-la ensuite par `./restauration.sh sauvegardes/<nom de l'archive>` (section 16). Ne continue qu'après sa ligne « Restauration terminée depuis … ». Sans elle, lance `docker compose stop app` : le script a pu relancer la file, qui garde le code KaraFun. Corrige la cause, puis refais la restauration.

En bascule, `.env` porte ainsi les noms d'essai : remplace alors ci-dessous `clients.exemple.fr` et `bar.exemple.fr` par ces noms (`essai.exemple.fr` et `essai-bar.exemple.fr` dans ce guide). Dans `~/karafun-plus/deploy`, démarre la file :

```bash
docker compose up -d
```

Attends une minute, le temps que `app` passe à `(healthy)`, puis contrôle :

```bash
docker compose ps
docker compose logs --no-log-prefix app
docker compose logs caddy | grep -c 'certificate obtained successfully'
docker compose logs --no-log-prefix app | grep -c 'staff?key='
docker compose exec app node -e "fetch('http://127.0.0.1:3000/readyz').then(r => r.text()).then(t => console.log(t))"
./sauvegarde.sh
```

Résultats attendus, commande par commande :

- `docker compose ps` : `app` est `(healthy)` ; la seule flèche de sa ligne est `127.0.0.1:3000->3000/tcp`.
- Le journal de `app` contient les lignes `Mode` (`serveur`), `Fuseau horaire` (`Europe/Paris`) et `Clé du bar` (une empreinte, jamais la clé). Les lignes `Adresse des clients (QR)` et `Adresse de la page du bar` montrent les noms de `.env`, jamais un nom en `exemple.fr`.
- Caddy a obtenu les certificats des deux hôtes : `2`. Si le compte donne `0` ou `1`, attends encore une minute et relance cette commande ; après deux relances, `docker compose logs caddy | grep -i error` en donne la cause. Pour des noms que ce serveur a déjà servis (nouvel essai), Caddy reprend ses certificats sans écrire cette ligne : le compte reste plus bas, et les `curl.exe` en HTTPS ci-dessous suffisent.
- Aucun lien du bar au journal : `0`.
- `/readyz` répond `{"ok":false,"mode":"server","karafun":"no-code","solver":"available","persistence":"ok"}`. C'est normal : aucun code KaraFun n'est encore donné.
- `./sauvegarde.sh` arrête la file le temps de la copie, écrit `Sauvegarde écrite : sauvegardes/karafun-plus-AAAAMMJJ-HHMMSSZ.tar.gz (…)`, puis relance la file. Note le nom de cette archive : elle garde l'état de départ, sans code KaraFun.

Depuis le PC Windows, dans PowerShell (`curl.exe`, pas l'alias `curl`). Remplace d'abord `exemple.fr` par ton domaine dans chaque ligne : la quatrième envoie le mot de passe du bar à l'hôte qu'elle nomme, et un nom d'exemple joindrait un serveur tiers.

```powershell
curl.exe -s -o NUL -w "%{http_code}\n" https://clients.exemple.fr/healthz
curl.exe -s -o NUL -w "%{http_code}\n" https://clients.exemple.fr/staff
curl.exe -s -o NUL -w "%{http_code}\n" https://bar.exemple.fr/staff
curl.exe -s -o NUL -w "%{http_code}\n" -u bar https://bar.exemple.fr/staff
curl.exe -s -o NUL -w "%{http_code}\n" http://clients.exemple.fr/
curl.exe -s -o NUL -w "%{http_code}\n" --max-time 5 http://<IPv4 du VPS>:3000/healthz
curl.exe -s -o NUL -w "%{http_code}\n" --max-time 5 http://<IPv4 du VPS>:3001/healthz
```

Attendus, dans l'ordre : `200` (clients) ; `403` (`/staff` refusé aux clients) ; `401` (bar sans mot de passe) ; `200` (`-u bar`, mot de passe tapé) ; `308` (HTTP renvoyé vers HTTPS). Puis rien sur `:3000` ni sur `:3001` : `000`.

Aucun lien du bar aux gérants avant la bascule ; aucun code KaraFun sur le serveur avant la bascule, sauf pendant la démo de répétition, bar fermé, file du PC Windows arrêtée.

Après cette démo, avant de relancer le kit, efface le code KaraFun du serveur : restaure l'archive de départ notée plus haut, par `./restauration.sh sauvegardes/<nom de l'archive>` (section 16). Sinon, la file du serveur resterait connectée à KaraFun, ou s'y reconnecterait à son prochain démarrage, pendant une soirée du kit. `/readyz` doit ensuite répondre de nouveau `"karafun":"no-code"`. Sans la ligne « Restauration terminée depuis … », ou sans ce `"karafun":"no-code"`, lance `docker compose stop app` avant de relancer le kit : la file du serveur garde le code KaraFun, et le script relance la file même quand il échoue après la confirmation.

**Contrôle** : `app` est `(healthy)`, les deux comptes donnent `2` (moins pour des noms déjà servis) et `0`, et les sept `curl.exe` donnent `200`, `403`, `401`, `200`, `308`, `000`, `000`.

## 12. Bascule depuis un PC Windows

Bar fermé, une fois les sections 2 à 11 faites avec les noms d'essai. Compte une heure.

1. **Diagnostic.** Refais la section 8, et ne continue que sur `Code de sortie : 0`.
2. **Adresse des QR du PC.** Sur le PC Windows du kit, dans PowerShell :

   ```powershell
   Set-Location "<dossier karaoke-bar du kit>"
   $t = Get-Content -Raw -Encoding UTF8 data\tables.json | ConvertFrom-Json
   "$(@($t.tables).Count) tables, adresse $($t.baseUrl)"
   ```

   La réponse doit être `<n> tables, adresse https://clients.exemple.fr`. Note `<n>`. Si l'adresse diffère, arrête-toi : les QR imprimés ne mèneraient pas au serveur.
3. **Arrêt du kit.** Double-clique sur `ARRETER.bat` : sa fenêtre doit afficher « La file karaoké s’arrête. ». « Impossible d’arrêter la file karaoké » s'affiche aussi pour une file déjà arrêtée. Vérifie alors dans PowerShell : `curl.exe -s -o NUL -w "%{http_code}\n" --max-time 5 http://127.0.0.1:3000/healthz` doit donner `000`. Avec tout autre code, arrête-toi : la file du PC tourne encore (un kit sans `/healthz` répond `404`).
4. **Archive des données.** Toujours dans `<dossier karaoke-bar du kit>` :

   ```powershell
   tar.exe -czf karafun-plus-pc-AAAAMMJJ.tar.gz data
   Get-FileHash karafun-plus-pc-AAAAMMJJ.tar.gz -Algorithm SHA256
   scp karafun-plus-pc-AAAAMMJJ.tar.gz karaoke@<IPv4 du VPS>:karafun-plus/deploy/sauvegardes/
   ```

   Note l'empreinte SHA-256. L'archive ne contient que `data` : `journal`, avec ses prénoms, reste sur le PC.

   `scp` demande la clé SSH du PC d'administration. Si le PC du kit n'est pas celui-là, ne lance pas `scp` ici. Porte l'archive sur le PC d'administration (clé USB), refais son `Get-FileHash`, puis lance `scp` depuis lui. Efface ensuite l'archive de la clé USB (section 20). Ne copie jamais `id_ed25519` sur le PC du bar.

   Vérifie l'archive sur le serveur tout de suite, avant de toucher aux DNS. Dans `~/karafun-plus/deploy`, `sha256sum sauvegardes/karafun-plus-pc-AAAAMMJJ.tar.gz` doit donner l'empreinte notée, en minuscules. Sinon, refais `scp`.
5. **Ancienne file hors service.** Toujours dans le même dossier :

   ```powershell
   Rename-Item data "data-avant-serveur-AAAAMMJJ"
   ```

   Arrête aussi le tunnel ou le relais HTTPS du PC, et empêche-le de repartir au démarrage. Pour le service `cloudflared` du guide du bar, dans un PowerShell administrateur : `Stop-Service cloudflared`, puis `Set-Service cloudflared -StartupType Disabled`. Si le nom des QR passe par DynHost, arrête aussi son client (box ou logiciel du PC) : il pourrait remettre l'adresse du domicile. Retire enfin du bureau et de la barre des tâches les raccourcis de `KaraFun Plus.exe`, et garde celui de KaraFun : relancé par habitude, le kit ouvrirait une seconde file.
6. **DNS.** Change les cibles comme le disent les points 3 et 4 de la bascule, en section 9. Compte cinq minutes (TTL 300). Puis, dans PowerShell, `Resolve-DnsName clients.exemple.fr -Type A` et `Resolve-DnsName bar.exemple.fr -Type A` doivent donner `<IPv4 du VPS>`. Sinon, attends avant l'étape 7 : Caddy demande les certificats dès son démarrage.
7. **Restauration sur le serveur.** Dans `~/karafun-plus/deploy` :

   ```bash
   chmod 600 sauvegardes/karafun-plus-pc-AAAAMMJJ.tar.gz
   sha256sum sauvegardes/karafun-plus-pc-AAAAMMJJ.tar.gz
   nano .env
   ```

   L'empreinte doit être celle de l'étape 4, en minuscules. Dans `.env`, mets les noms définitifs dans `HOTE_CLIENTS`, `HOTE_BAR`, `KARAOKE_PUBLIC_URL` et `KARAOKE_STAFF_URL`. Relance la commande `awk` de la section 10 : elle doit afficher `noms concordants`. Puis restaure l'archive du PC :

   ```bash
   ./restauration.sh sauvegardes/karafun-plus-pc-AAAAMMJJ.tar.gz
   ```

   `restauration.sh` demande de taper `RESTAURER`. Il sauvegarde l'état d'essai, remplace `data/` et `journal/`, puis relance la file. Sur « Restauration annulée : rien n'a changé. », relance la même commande. Pour toute autre erreur, sans la ligne « Restauration terminée depuis … », suis « En cas d'échec » ci-dessous. Après cette ligne seulement, recrée Caddy sous les noms définitifs :

   ```bash
   docker compose up -d
   ```
8. **Vérifications.** Toujours sur le serveur :

   ```bash
   docker compose logs caddy | grep -c 'certificate obtained successfully'
   docker compose exec -T app stat -c '%a %U' /app/data /app/journal
   docker compose logs --no-log-prefix app | grep -E 'Soirée restaurée|Attention : data/tables.json|Impossible de démarrer'
   ```

   Attendus : `2`, pour les certificats des noms définitifs ; s'il donne moins, attends une minute et relance cette commande. Après deux relances, `docker compose logs caddy | grep -i error` en donne la cause. Pour des noms déjà servis par ce serveur (nouvel essai), le compte reste plus bas : l'étape 9 vérifie alors le certificat. Puis deux fois `700 node` : ne corrige jamais ces droits à la main. Enfin une seule ligne, `Soirée restaurée : <n> tables, …`, avec le même `<n>` qu'à l'étape 2. Une ligne `Attention : data/tables.json` ou `Impossible de démarrer` arrête la bascule : suis « En cas d'échec » ci-dessous.
9. **QR imprimé.** Wi-Fi coupé, en 4G/5G, scanne un QR **imprimé** : la page de sa table doit s'ouvrir.
10. **Ancien chemin fermé.** Sur le serveur, remplace d'abord `<ancienne IPv4>` et les deux `clients.exemple.fr` :

    ```bash
    curl -fsS -o /dev/null --max-time 10 --resolve clients.exemple.fr:443:<ancienne IPv4> https://clients.exemple.fr/app.css
    echo "Code de sortie : $?"
    ```

    Cette requête vers l'ancienne adresse doit échouer : code de sortie différent de `0`. Toutes les versions du kit servent `/app.css`, alors que `/healthz` manque aux plus anciennes. Avec `0`, une file ou un relais répond encore à l'ancienne adresse : retourne sur le PC, arrête-les comme à l'étape 5, puis refais cette étape. Une ligne `bash:` avant ce code veut dire que la commande n'a pas tourné : remplace les valeurs, puis refais cette étape.

La restauration a remplacé `data/`, clé du bar d'essai comprise : donne maintenant le lien du bar aux gérants (section 13). KaraFun fermé, la page du bar finit sur « KaraFun fermé ou code changé : essais arrêtés ». C'est normal : à l'ouverture, suis la section 14. Retire ensuite les noms d'essai (section 9, point 6).

**En cas d'échec.** Avant l'étape 6, remets `data` à son nom s'il le faut (`Rename-Item "data-avant-serveur-AAAAMMJJ" data`) et les raccourcis de `KaraFun Plus.exe`. Relance le tunnel du PC ou le client DynHost, puis `DEMARRER.bat`. Le tunnel `cloudflared` se relance dans un PowerShell administrateur : `Set-Service cloudflared -StartupType Automatic`, puis `Start-Service cloudflared`.

Après l'étape 6, tant qu'aucune soirée n'a eu lieu sur le serveur, arrête d'abord le serveur par `docker compose stop`. Remets ensuite les noms des QR comme le dit le point 3 de la section 19, puis fais comme avant l'étape 6. N'utilise pas l'archive du serveur : `data-avant-serveur-AAAAMMJJ` garde les données du PC, intactes, alors que le serveur a pu réécrire l'adresse des QR. Si l'étape 7 a eu lieu, les volumes du serveur gardent le code KaraFun du PC : avant tout nouveau `docker compose up -d`, prépare le serveur comme le dit le début de la section 11 (noms d'essai, archive de départ). Spotify peut aussi demander une reconnexion sur le PC (« Reconnecter Spotify ») : le serveur a pu renouveler son jeton. Après une soirée sur le serveur, suis la section 19.

**Contrôle** : le QR imprimé ouvre sa table en 4G/5G, et l'étape 10 affiche un code de sortie différent de `0`, sans ligne `bash:` avant lui. Le lendemain, `Resolve-DnsName clients.exemple.fr -Type A` donne encore `<IPv4 du VPS>`.

## 13. Lien de la page du bar

Serveur en retrait, aux conteneurs arrêtés ou retirés (section 19, ou bascule abandonnée en section 12) : n'y lance ni `docker compose restart`, ni `docker compose up -d` (même garde en tête de la section 18). `restart` démarre aussi un conteneur arrêté, et la file du serveur se reconnecterait à KaraFun pendant une soirée du kit. La bascule suivante lui donne une clé neuve. Pour un mot de passe divulgué, remplace seulement `BAR_PASSWORD_HASH`, comme plus bas, sans démarrer la file.

Sur le serveur, dans `~/karafun-plus/deploy` :

```bash
docker compose exec app node server.js --print-staff-url
```

La commande affiche `https://bar.exemple.fr/staff?key=<clé>`. Son hôte doit être exactement `HOTE_BAR` de `.env`, lettre pour lettre ; sinon, corrige `.env` (section 10), relance `docker compose up -d`, puis relis le lien. Donne aux gérants le lien et le mot de passe du bar par deux canaux différents : par exemple le lien par message, le mot de passe de vive voix. Le navigateur demande d'abord le nom `BAR_USER` (`bar`) et le mot de passe, puis la page s'ouvre. Le lien ne change pas au redémarrage.

Lien ou mot de passe divulgué : renouvelle la clé, puis redémarre la file. Si le lien et le mot de passe ont fui ensemble, fais-le tout de suite, même en soirée : la page du bar est ouverte à qui les détient. Sinon, de préférence hors soirée.

```bash
docker compose exec app node server.js --rotate-staff-key
docker compose restart app
```

La file reprend sa soirée en quelques secondes. Redonne ensuite le nouveau lien, obtenu par la première commande de cette section : l'ancien répond « Réservé au bar ». Pour un mot de passe divulgué, refais aussi l'empreinte par la seule commande `docker run --rm -it caddy:2 caddy hash-password --bcrypt-cost 10` (section 10), jamais par tout le bloc de la section 10 : son `cp .env.example .env` écraserait `.env`. Remplace ensuite `BAR_PASSWORD_HASH` dans `.env`, par `nano .env`, puis lance `docker compose up -d`.

**Contrôle** : le lien ouvre la page du bar après le mot de passe ; après un renouvellement, l'ancien lien affiche « Réservé au bar ».

## 14. Ouverture du bar chaque soir

Sur le serveur, rien à lancer : la file reste allumée, nuit comprise. La file ne lance jamais KaraFun : il s'ouvre au PC du bar.

1. Sur le PC du bar, lance KaraFun lui-même, jamais `KaraFun Plus.exe`, qui ouvrirait une seconde file. Active ensuite sa Télécommande.
2. Ouvre la page du bar par son lien (section 13).
3. Si elle affiche « KaraFun fermé ou code changé : essais arrêtés », clique **une** fois sur « Reconnecter ». Si le code a changé, clique plutôt sur « Saisir le code », tape le nouveau code, puis clique sur « Connecter ».
4. Si elle affiche « KaraFun limite les essais jusqu’à … », attends sans cliquer : la file réessaie seule après l'heure indiquée.

**Contrôle** : `/readyz` (commande de la section 11) répond `"karafun":"connected"`, et la page du bar affiche « KaraFun connecté ».

## 15. Spotify

Rien n'est à déclarer chez Spotify : l'adresse de retour reste `http://127.0.0.1:3000/spotify/callback`. Le jeton, `data/spotify.json`, part avec `data/` : au quotidien, Spotify marche sans rien faire. La musique ne joue jamais sur le serveur : Spotify Connect la joue sur le PC du bar ou sur une enceinte.

Reconnexion, rare (pastille « Spotify non connecté ») : depuis le PC d'administration, sans kit lancé, ouvre le tunnel SSH. Le port 3000 de ce PC doit être libre.

```powershell
ssh -N -L 3000:127.0.0.1:3000 karaoke@<IPv4 du VPS>
```

Laisse cette fenêtre ouverte. Dans le navigateur de ce PC, ouvre d'abord `http://127.0.0.1:3000/readyz`, sans clé : la réponse doit contenir `"mode":"server"`. Sinon, un autre programme tient le port 3000 de ce PC : ferme le tunnel et n'envoie pas la clé. Ouvre ensuite `http://127.0.0.1:3000/staff?key=<clé>`, avec la clé du lien de la section 13. Puis « Plus », « Reconnecter Spotify ». Après le retour de Spotify, Ctrl+C dans la fenêtre PowerShell ferme le tunnel.

Sur un serveur neuf, sans soirée reprise d'un PC, la première connexion à Spotify passe par le même tunnel, avec le panneau Spotify décrit dans GUIDE-BAR.md.

**Contrôle** : la pastille Spotify de la page du bar redevient verte, « Spotify · » suivi du nom de l'appareil.

## 16. Sauvegarde et restauration

Jamais en soirée : la sauvegarde arrête la file le temps de la copie. Dans `~/karafun-plus/deploy` :

```bash
./sauvegarde.sh
```

Le script écrit `Sauvegarde écrite : sauvegardes/karafun-plus-AAAAMMJJ-HHMMSSZ.tar.gz (…)`, puis relance la file. Copie l'archive hors du serveur, depuis le PowerShell du PC d'administration :

```powershell
scp karaoke@<IPv4 du VPS>:karafun-plus/deploy/sauvegardes/<nom de l'archive> .
```

Pour remettre une archive en place :

```bash
./restauration.sh sauvegardes/<nom de l'archive>
```

Tape `RESTAURER` pour confirmer. Le script sauvegarde d'abord l'état actuel, remplace `data/` et `journal/`, puis relance la file. Il la relance même sur un serveur en retrait, aux conteneurs arrêtés ou retirés (section 19) : n'y restaure alors qu'une archive sans code KaraFun, vérifiée comme le dit le début de la section 11. Sans sa ligne « Restauration terminée depuis … » (disque plein, connexion coupée), regarde si le script a écrit « Sauvegarde écrite : … ». Sans cette ligne, sa sauvegarde préalable a échoué avant tout changement : `data/` est intact, et le script a relancé la file telle quelle (sur un serveur en retrait, arrête-la tout de suite par `docker compose stop app`). Ne restaure rien : corrige la cause (`df -h /`), puis relance `./restauration.sh`. Avec cette ligne, le script a relancé la file sur des données incomplètes : lance tout de suite `docker compose stop app`, corrige la cause, puis restaure cette archive « Sauvegarde écrite : … », l'état d'avant la restauration. L'archive remet aussi sa clé du bar : après la restauration d'une archive plus ancienne qu'un renouvellement de la clé, renouvelle-la de nouveau et redonne le lien (section 13). Spotify peut alors demander une reconnexion (section 15). L'archive est privée : elle contient les prénoms, les QR secrets, la clé du bar et les jetons. Garde-la sur un disque protégé, jamais dans un message.

**Contrôle** : `ls -l sauvegardes/` montre l'archive en `-rw-------`, sa copie est sur le PC, et une restauration finit par « Restauration terminée depuis … ».

## 17. Mise à jour et retour à la version précédente

Serveur en retrait, après un retour au kit (section 19) ou une bascule abandonnée après l'étape 7 de la section 12 : ses volumes gardent le code KaraFun. Prépare-le d'abord comme le dit le début de la section 11, sinon le `docker compose up -d` ci-dessous reconnecterait sa file à KaraFun pendant une soirée du kit.

Hors soirée, quand une release `vX.Y.Z` paraît, sauvegarde d'abord la soirée :

```bash
cd ~/karafun-plus/deploy
./sauvegarde.sh
```

Ne continue que si le script a écrit sa ligne `Sauvegarde écrite : …`. Prépare ensuite la nouvelle version sans la démarrer :

```bash
git fetch --tags
git checkout vX.Y.Z
diff <(grep -o '^[A-Z_]*=' .env | sort) <(grep -o '^[A-Z_]*=' .env.example | sort)
sed -i 's/^KARAFUN_PLUS_VERSION=.*/KARAFUN_PLUS_VERSION=vX.Y.Z/' .env
docker compose pull
docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/jpfroud/karafun-plus:vX.Y.Z
```

`diff` compare les clés de `.env` et de `.env.example` et ne doit rien afficher. Sinon, ajoute à `.env` le réglage nouveau, décrit par les notes de la release. Ne modifie que `.env` : les autres fichiers de `deploy/` suivent la version. Si une autre commande de ce bloc affiche une erreur, ne démarre rien : les lignes suivantes ont tourné quand même. Remets alors la version actuelle, comme plus bas quand les empreintes diffèrent.

Compare l'empreinte affichée par `docker image inspect` à la ligne « Empreinte » des notes de la release (`ghcr.io/jpfroud/karafun-plus@sha256:…`). Si elles sont identiques, démarre la nouvelle version. Caddy est recréé pour relire son `Caddyfile`, que `git checkout` a pu changer :

```bash
docker compose up -d
docker compose up -d --force-recreate caddy
```

Si elles diffèrent, ne lance pas `docker compose up -d` : la version actuelle tourne toujours. Remets `.env` et `deploy/` sur elle, retire l'image refusée, puis signale l'écart au mainteneur du dépôt :

```bash
sed -i 's/^KARAFUN_PLUS_VERSION=.*/KARAFUN_PLUS_VERSION=vA.B.C/' .env
git checkout vA.B.C
docker image rm ghcr.io/jpfroud/karafun-plus:vX.Y.Z
```

Retour à la version précédente : les mêmes commandes, en échangeant `vX.Y.Z` et `vA.B.C` partout, bloc « si elles diffèrent » compris : `vA.B.C` devient la version à installer, et `vX.Y.Z` la version en service, à remettre par `sed` et `git checkout` ; l'empreinte se compare aux notes de la release `vA.B.C`. Si la file refuse ensuite de démarrer, restaure l'archive faite juste avant la mise à jour (section 16).

**Contrôle** : `docker compose ps` montre `app` en `(healthy)`, et `git describe --tags --exact-match` comme `docker compose logs --no-log-prefix app | grep '=== File karaoké'` affichent la version voulue.

## 18. Vérifications et dépannage

Serveur en retrait, aux conteneurs arrêtés ou retirés (section 19, ou bascule abandonnée en section 12) : ne démarre la file par aucune commande, ni `docker compose restart`, ni `docker compose start`, ni `docker compose up -d`. Sa file se reconnecterait à KaraFun pendant une soirée du kit. Seuls `docker compose ps`, `df -h /` et la mise à jour du système s'y appliquent : `app` y reste arrêté ou absent, même après `sudo reboot`, et c'est normal. La purge du journal, qui demande la file démarrée, attend le prochain essai (section 11).

Dans `~/karafun-plus/deploy`, les contrôles de tous les jours, sans effet sur la file. `docker compose ps` donne l'état des conteneurs, `app` en `(healthy)`, et `df -h /` la place libre sur le disque. `/readyz` (commande de la section 11) donne l'état de KaraFun, du solveur et de la sauvegarde, sans secret.

```bash
docker compose ps
df -h /
```

Redémarrer la file, la soirée reprend :

```bash
docker compose restart app
```

L'arrêter, jamais en soirée ; la soirée est enregistrée :

```bash
docker compose stop app
```

Chaque mois, mesure le journal. Après une sauvegarde (section 16), retire ses fichiers de plus de 90 jours :

```bash
docker compose exec -T app du -sh /app/journal
docker compose exec -T app find /app/journal -maxdepth 1 -type f -mtime +90 -print -delete
```

Chaque mois aussi, hors soirée, mets le système à jour. Les mises à jour automatiques de la section 4 ne suivent pas le dépôt de Docker : sans cela, Docker et containerd ne recevraient jamais leurs correctifs. La mise à jour de Docker redémarre les conteneurs, et la soirée reprend :

```bash
sudo apt update
sudo apt full-upgrade -y
docker compose ps
[ "/boot/vmlinuz-$(uname -r)" = "$(ls -1 /boot/vmlinuz-* | sort -V | tail -1)" ] || echo "Redémarrage nécessaire : nouveau noyau installé"
```

La dernière commande compare le noyau en marche au plus récent installé. Si elle affiche `Redémarrage nécessaire`, ou si le fichier `/var/run/reboot-required` existe (Ubuntu seulement : Debian ne le crée pas), redémarre par `sudo reboot` : la file repart seule. Vérifie ensuite que `docker compose ps` montre `app` en `(healthy)`.

**Caddy en panne** (pages injoignables, `caddy` arrêté dans `docker compose ps`) : la page du bar reste joignable par le tunnel de la section 15. `docker compose logs caddy` en donne la cause : `wrong argument count` y signale un `ACME_EMAIL` resté au texte d'exemple (section 10).

**`app` redémarre en boucle** (`Restarting` dans `docker compose ps`), le journal dit `Impossible de démarrer : data/staff-key ne contient pas une clé valable`, et `docker compose exec` échoue. Voici la seule exception permise : une commande ponctuelle écrit une clé neuve, puis s'arrête sans ouvrir de port.

```bash
docker compose run --rm app node server.js --rotate-staff-key
docker compose up -d
```

Attends que `docker compose ps` montre `app` en `(healthy)`, puis lis le nouveau lien :

```bash
docker compose exec app node server.js --print-staff-url
```

Redonne-le ensuite aux gérants (section 13). Une autre ligne `Impossible de démarrer : …` donne sa cause, le plus souvent un réglage de `.env` : corrige-le, puis lance `docker compose up -d`.

**Journal pour un diagnostic.** Le journal cite des prénoms : n'envoie jamais un fichier entier. Relis-le, par `docker compose logs --no-log-prefix app`, et copie seulement les lignes de connexion à KaraFun, sans aucun prénom.

Jamais : `docker compose down -v` (il efface les volumes, donc la soirée et la clé), `docker compose run` hors de l'exception ci-dessus (seconde file), `node server.js` lancé en SSH (seconde file), publier `journal/` (il contient des prénoms).

**Contrôle** : `docker compose ps` montre `caddy` et `app` en marche, `app` en `(healthy)`, et `/readyz` répond ; sur un serveur en retrait, aucun des deux n'est en marche.

## 19. Retour arrière vers le kit Windows

Bar fermé. Sur le serveur, dans `~/karafun-plus/deploy` :

```bash
docker compose stop app
./sauvegarde.sh
docker compose stop
```

La sauvegarde ne relance pas la file, déjà arrêtée. Recopie `<nom de l'archive>` depuis sa ligne `Sauvegarde écrite : …`. Sans cette ligne, arrête-toi : l'archive de la dernière soirée manquerait. Note aussi son empreinte, donnée par `sha256sum sauvegardes/<nom de l'archive>`. Puis, sur le PC Windows :

1. Télécharge le kit `vX.Y.Z` neuf, de la même version que le serveur, avec le fichier `KIT-BAR-KARAFUN.zip.sha256` de la release. `(Get-FileHash KIT-BAR-KARAFUN.zip -Algorithm SHA256).Hash.ToLower()` doit donner le premier mot de ce fichier. Sinon, ne décompresse pas le kit ; s'ils sont égaux, décompresse-le entièrement, dans un dossier neuf. Dans la suite, `<dossier karaoke-bar du kit>` est son dossier `karaoke-bar`, jamais celui de l'ancien kit.
2. Récupère l'archive, et n'en extrais que `data`. `scp` se lance depuis le PC d'administration : si le kit est sur un autre PC, porte-y ensuite l'archive (clé USB), dans `<dossier karaoke-bar du kit>`, puis fais-y `Get-FileHash` et `tar.exe`. Efface ensuite l'archive de la clé USB (section 20).

   ```powershell
   Set-Location "<dossier karaoke-bar du kit>"
   scp karaoke@<IPv4 du VPS>:karafun-plus/deploy/sauvegardes/<nom de l'archive> .
   (Get-FileHash <nom de l'archive> -Algorithm SHA256).Hash.ToLower()
   ```

   L'empreinte doit être celle notée sur le serveur. Sinon, la copie est abîmée : refais-la, et n'en extrais rien, car une archive tronquée donnerait un `data` incomplet. Puis :

   ```powershell
   tar.exe -xzf <nom de l'archive> data
   Remove-Item data\staff-key -ErrorAction SilentlyContinue
   ```

   La dernière ligne retire la clé du bar du serveur. Le kit ne s'en sert pas, et une bascule suivante la remettrait en service, avec l'ancien lien des gérants.

3. Chez OVHcloud, retire d'abord les entrées CAA du nom des QR. Remets ensuite sa cible sur `<ancienne IPv4>`, ou l'ancien CNAME ou DynHost. Pour remettre un CNAME, supprime aussi l'entrée A posée à l'étape 6 de la section 12 : un CNAME ne coexiste avec aucune autre entrée du même nom. Si son « TTL » est revenu à 3600, compte jusqu'à une heure. Relance ensuite le tunnel ou le relais du PC : pour `cloudflared`, dans un PowerShell administrateur, `Set-Service cloudflared -StartupType Automatic`, puis `Start-Service cloudflared`. Relance aussi le client DynHost arrêté à l'étape 5 de la section 12, et remets les entrées AAAA retirées, s'il y en avait.
4. Dans `<dossier karaoke-bar du kit>`, crée les raccourcis de `KaraFun Plus.exe` sur le bureau et dans la barre des tâches, à la place de ceux retirés à l'étape 5 de la section 12. Double-clique ensuite sur l'un d'eux. Préviens les gérants : chaque soir, ils lancent de nouveau la file par ce raccourci, comme avant la bascule, et non plus KaraFun seul.

Sur le serveur enfin, retire les conteneurs. Les volumes restent, pour un nouvel essai : jamais l'option qui les efface. Ils gardent aussi le code KaraFun, et la file du serveur s'y reconnecterait à son prochain démarrage. Pour un nouvel essai ou une mise à jour (section 17), prépare donc d'abord le serveur comme le dit le début de la section 11 (noms d'essai, archive de départ), avant tout `docker compose up -d`.

```bash
docker compose down
```

Avant de résilier le VPS, retire chez OVHcloud toute entrée qui vise `<IPv4 du VPS>`, celle de `HOTE_BAR` comprise : un autre client d'OVHcloud pourrait recevoir cette adresse.

Avec le kit Windows, ne relaie jamais le port du bar (3000) par un proxy HTTPS : en mode PC, un relais HTTPS installé sur la même machine fait paraître locale toute requête, et n'importe qui ouvrirait la page du bar.

**Contrôle** : un QR imprimé ouvre sa table en 4G/5G par le PC, et le raccourci de `KaraFun Plus.exe` ouvre la page du bar du kit neuf, avec les tables de la soirée. Avec `cloudflared`, `Get-Service cloudflared | Select-Object Status, StartType` affiche `Running` et `Automatic`.

## 20. Données personnelles et accès

La file est hébergée en France, sur un VPS d'OVHcloud situé dans un centre de données français. Les prénoms et les heures de présence sont des données personnelles. Ils sont dans `data/` (soirées, statistiques), dans `journal/` (le journal du serveur et celui de KaraFun citent des prénoms), et dans chaque archive de `deploy/sauvegardes/` et ses copies. Docker garde aussi les journaux des conteneurs, jusqu'à 50 Mo chacun : celui de `app` cite les mêmes prénoms, celui de `caddy` des adresses IP de téléphones. La purge de la section 18 n'y touche pas : ils disparaissent quand le conteneur est recréé, à la mise à jour suivante ou, hors soirée, par `docker compose up -d --force-recreate`. Sur un serveur en retrait, qui ne doit pas démarrer (section 13), retire-les plutôt par `docker compose down`. Les PC Windows en gardent aussi : `data-avant-serveur-AAAAMMJJ`, les archives `karafun-plus-pc-AAAAMMJJ.tar.gz` et celles copiées par `scp`, l'ancien dossier `journal` du kit, et la clé USB qui a porté une archive entre deux PC (sections 12 et 19). Range-les sur le disque protégé de la section 16, et efface-les quand le retour au kit n'est plus utile. Informe les clients par une affiche, comme avec le kit.

| Qui | Accès |
|---|---|
| Clients | la page de leur table, par son QR ; jamais la page du bar |
| Gérants | la page du bar, par son lien et le mot de passe du bar |
| Administrateur (`karaoke`) | tout le serveur par sa clé SSH : `.env`, volumes, journaux, archives |
| OVHcloud | le disque du serveur, comme tout hébergeur |

Garde ces accès au plus juste. Quand un gérant s'en va, renouvelle la clé et le mot de passe du bar (section 13). Les fichiers de `journal/` de plus de 90 jours se retirent par la commande de la section 18, les journaux de Docker par la recréation des conteneurs.
