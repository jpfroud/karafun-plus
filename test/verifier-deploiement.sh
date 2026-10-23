#!/usr/bin/env bash
# Vérification de deploy/ avec une image construite (Linux, Docker) : dix
# contrôles V1 à V10, dans un projet compose d'essai karafun-essai-<pid> et une
# copie de deploy/ dans un dossier temporaire. Le projet karafun-plus d'un VPS
# n'est jamais touché ; aucune lecture de karafun.com.
#   bash test/verifier-deploiement.sh <image>
# CI (#22) : bash test/verifier-deploiement.sh karafun-plus:verif
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage : bash test/verifier-deploiement.sh <image>" >&2
  exit 2
fi
IMAGE=$1
RACINE=$(cd "$(dirname "$0")/.." && pwd)
FIXTURE=$RACINE/test/fixtures/compose.essai-caddy.yaml
DEPOT_IMAGE=ghcr.io/jpfroud/karafun-plus

# Requêtes directes, jamais par un proxy de l'environnement.
requete() { curl --noproxy '*' "$@"; }
# Code de sortie de curl pour une adresse (7 : refus, 28 : délai dépassé).
code_curl() {
  local code=0
  requete -sS -o /dev/null --max-time 3 "$1" 2> /dev/null || code=$?
  echo "$code"
}

prerequis() { echo "ÉCHEC prérequis : $1" >&2; exit 1; }
for commande in docker curl node tar sha256sum ip; do
  command -v "$commande" > /dev/null 2>&1 || prerequis "commande absente : $commande"
done
docker compose version > /dev/null 2>&1 || prerequis "commande absente : docker compose"
docker info > /dev/null 2>&1 || prerequis "Docker ne répond pas (docker info)."
docker image inspect "$IMAGE" > /dev/null 2>&1 || prerequis "image introuvable : $IMAGE"
for port in 3000 3001; do
  [ "$(code_curl "http://127.0.0.1:$port/")" = 7 ] || prerequis "port déjà pris sur l'hôte : 127.0.0.1:$port"
done
EXT=$(ip -4 route get 192.0.2.1 2> /dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1) || EXT=''
[ -n "$EXT" ] || prerequis "adresse externe introuvable."

# Réglages de compose venus de l'environnement : ils primeraient sur le .env d'essai.
unset KARAFUN_PLUS_VERSION HOTE_CLIENTS HOTE_BAR KARAOKE_PUBLIC_URL KARAOKE_STAFF_URL ACME_EMAIL BAR_USER \
  BAR_PASSWORD_HASH COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_PROJECT_DIRECTORY
# Exporté : sauvegarde.sh, restauration.sh et down -v visent ce projet, jamais karafun-plus.
export COMPOSE_PROJECT_NAME=karafun-essai-$$
TAG=essai-$$
TMP=$(mktemp -d)
DEPLOI=$TMP/deploy
JOURNAL=$TMP/commandes.log
ETIQUETTE=0
COMPTE=0
ID=''
LIBELLE=''
SIGNALE=0

nettoyer() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  if [ "$code" != 0 ] && [ "$SIGNALE" = 0 ] && [ -n "$ID" ] && [ "$code" != 130 ] && [ "$code" != 143 ]; then
    echo "ÉCHEC $ID $LIBELLE : commande en échec (code $code), voir les journaux ci-dessous" >&2
  fi
  # Journal des commandes montré même avant .env (échec de caddy hash-password) :
  # il est effacé avec $TMP.
  if [ "$code" != 0 ] && [ -s "$JOURNAL" ]; then
    echo "--- commandes (50 dernières lignes) ---" >&2
    tail -n 50 "$JOURNAL" >&2
  fi
  if [ -f "$DEPLOI/.env" ]; then
    if [ "$code" != 0 ]; then
      for service in caddy app; do
        echo "--- journaux de $service (200 dernières lignes) ---" >&2
        (cd "$DEPLOI" && docker compose logs --no-log-prefix --tail 200 "$service") >&2
      done
    fi
    (cd "$DEPLOI" && docker compose down -v --remove-orphans) > /dev/null 2>&1
  fi
  [ "$ETIQUETTE" = 1 ] && docker image rm "$DEPOT_IMAGE:$TAG" > /dev/null 2>&1
  rm -rf "$TMP"
  exit "$code"
}
trap nettoyer EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

controle() { ID=$1; LIBELLE=$2; }
reussi() { COMPTE=$((COMPTE + 1)); echo "OK  $ID $LIBELLE"; }
echec() { SIGNALE=1; echo "ÉCHEC $ID $LIBELLE : $1" >&2; exit 1; }
# Commande dont la sortie va au journal de l'essai (montré en cas d'échec).
discret() { "$@" >> "$JOURNAL" 2>&1 || echec "commande en échec : $*"; }
# attendre <secondes> <commande…> : vrai dès que la commande réussit.
attendre() {
  local fin=$((SECONDS + $1))
  shift
  until "$@" > /dev/null 2>&1; do
    [ "$SECONDS" -lt "$fin" ] || return 1
    sleep 1
  done
}
# Contrôle d'un JSON lu sur l'entrée par un script node (premier défaut affiché).
verifier_json() {
  local script=$1 detail
  shift
  detail=$(node -e "$script" "$@" 2>&1) || echec "$detail"
}
C() { docker compose -f compose.yaml -f "$FIXTURE" "$@"; }

# Copie de deploy/ sans .env ni sauvegardes/, modes gardés.
mkdir "$DEPLOI"
shopt -s dotglob nullglob
for entree in "$RACINE"/deploy/*; do
  case ${entree##*/} in .env | sauvegardes) continue ;; esac
  cp -pR "$entree" "$DEPLOI/"
done
shopt -u dotglob nullglob
cd "$DEPLOI"

docker tag "$IMAGE" "$DEPOT_IMAGE:$TAG"
ETIQUETTE=1
MOT=$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))')
EMPREINTE=$(printf '%s\n' "$MOT" | docker run --rm -i caddy:2 caddy hash-password 2>> "$JOURNAL") || EMPREINTE=''
if ! [[ $EMPREINTE =~ ^\$2a\$14\$[./A-Za-z0-9]{53}$ ]]; then
  echo "ÉCHEC préparation : empreinte de caddy hash-password illisible" >&2
  exit 1
fi
# .env d'essai : hôtes en http:// (Caddy sert en HTTP, sans Let's Encrypt) et
# adresse de contact de documentation (le texte de .env.example fait plusieurs
# mots, refusés par la directive email du Caddyfile).
(
  umask 077
  while IFS= read -r ligne || [ -n "$ligne" ]; do
    case $ligne in
      KARAFUN_PLUS_VERSION=*) ligne="KARAFUN_PLUS_VERSION=$TAG" ;;
      HOTE_CLIENTS=*) ligne='HOTE_CLIENTS=http://clients.exemple.fr' ;;
      HOTE_BAR=*) ligne='HOTE_BAR=http://bar.exemple.fr' ;;
      ACME_EMAIL=*) ligne='ACME_EMAIL=essai@exemple.fr' ;;
      BAR_PASSWORD_HASH=*) ligne="BAR_PASSWORD_HASH='$EMPREINTE'" ;;
    esac
    printf '%s\n' "$ligne"
  done < .env.example > .env
)
chmod 600 .env

# État du projet karafun-plus (conteneurs, volumes) avant tout contrôle.
etat_karafun_plus() {
  local ids=()
  mapfile -t ids < <(docker ps -aq --filter label=com.docker.compose.project=karafun-plus)
  [ "${#ids[@]}" = 0 ] || docker inspect -f '{{.Id}} {{.State.Status}} {{.State.StartedAt}}' "${ids[@]}" | sort
  docker volume ls -q --filter label=com.docker.compose.project=karafun-plus | sort
}
AVANT_KARAFUN_PLUS=$(etat_karafun_plus)

# ---------------------------------------------------------------- V1
controle V1 'compose rendu'
CONFIG=$(docker compose config --format json 2>> "$JOURNAL") || echec "docker compose config en échec"
verifier_json "$(cat <<'JS'
const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
const projet = process.argv[1];
const faute = texte => { console.log(texte); process.exit(1); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (c.name !== projet) faute(`projet rendu ${c.name}, attendu ${projet}`);
const { app, caddy } = c.services || {};
if (!app || !caddy || Object.keys(c.services).length !== 2) faute("services attendus : app et caddy");
const ports = (app.ports || []).map(p => ({ host_ip: p.host_ip, published: p.published, target: p.target, protocol: p.protocol }));
if (!same(ports, [{ host_ip: "127.0.0.1", published: "3000", target: 3000, protocol: "tcp" }])) faute(`ports de app : ${JSON.stringify(app.ports)}`);
if (app.init !== true) faute("app sans init: true");
if (app.stop_grace_period !== "20s") faute(`stop_grace_period de app : ${app.stop_grace_period}`);
for (const [nom, s] of Object.entries({ app, caddy })) {
  if (s.restart !== "unless-stopped") faute(`restart de ${nom} : ${s.restart}`);
  const l = s.logging || {};
  if (l.driver !== "json-file" || !same(Object.entries(l.options || {}).sort(), [["max-file", "5"], ["max-size", "10m"]])) faute(`journal de ${nom} : ${JSON.stringify(s.logging)}`);
}
const volumes = (app.volumes || []).map(v => `${v.type}:${v.source}:${v.target}`).sort();
if (!same(volumes, ["volume:karafun-data:/app/data", "volume:karafun-journal:/app/journal"])) faute(`volumes de app : ${volumes.join(", ")}`);
const publies = (caddy.ports || []).map(p => `${p.host_ip || ""}|${p.published}|${p.target}/${p.protocol}`).sort();
if (!same(publies, ["|443|443/tcp", "|443|443/udp", "|80|80/tcp"])) faute(`ports de caddy : ${publies.join(", ")}`);
JS
)" "$COMPOSE_PROJECT_NAME" <<< "$CONFIG"
reussi

# ---------------------------------------------------------------- V2
controle V2 'variable manquante'
grep -v '^KARAOKE_STAFF_URL=' .env > "$TMP/sans-staff.env"
code=0
docker compose --env-file "$TMP/sans-staff.env" config --format json > /dev/null 2> "$TMP/v2.err" || code=$?
[ "$code" != 0 ] || echec "configuration rendue sans KARAOKE_STAFF_URL (code 0)"
grep -qF 'required variable KARAOKE_STAFF_URL is missing a value: à renseigner dans deploy/.env' "$TMP/v2.err" \
  || echec "message attendu absent de stderr : $(head -c 300 "$TMP/v2.err")"
reussi

# ---------------------------------------------------------------- V3
controle V3 'Caddyfile'
docker compose run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > "$TMP/v3.txt" 2>&1 \
  || echec "caddy validate en échec : $(tail -n 3 "$TMP/v3.txt")"
grep -qx 'Valid configuration' "$TMP/v3.txt" || echec "« Valid configuration » absent : $(tail -n 3 "$TMP/v3.txt")"
docker compose run --rm --no-deps -T caddy caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile > "$TMP/v3.json" 2>> "$JOURNAL" \
  || echec "caddy adapt en échec"
verifier_json "$(cat <<'JS'
const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
const faute = texte => { console.log(texte); process.exit(1); };
const handlers = noeud => {
  if (Array.isArray(noeud)) return noeud.flatMap(handlers);
  if (!noeud || typeof noeud !== "object") return [];
  return [...(noeud.handler ? [noeud] : []), ...Object.values(noeud).flatMap(handlers)];
};
const routes = Object.values(c.apps?.http?.servers || {}).flatMap(s => s.routes || []);
const route = hote => {
  const r = routes.filter(x => (x.match || []).some(m => (m.host || []).includes(hote)));
  if (r.length !== 1) faute(`${r.length} route(s) pour ${hote}`);
  return handlers(r[0].handle);
};
const toutes = handlers(routes);
const clients = route("clients.exemple.fr");
const bar = route("bar.exemple.fr");
const proxy = (liste, hote, dial) => {
  const p = liste.filter(h => h.handler === "reverse_proxy");
  if (p.length !== 1 || JSON.stringify(p[0].upstreams) !== JSON.stringify([{ dial }])) faute(`${hote} : reverse_proxy vers ${dial} attendu`);
  if (p[0].transport?.protocol !== "http" || p[0].transport?.keep_alive?.idle_timeout !== 50e9) faute(`${hote} : keepalive de 50 s absent (${JSON.stringify(p[0].transport)})`);
  if (JSON.stringify(p[0].headers?.request?.set?.["X-Real-Ip"]) !== JSON.stringify(["{http.request.remote.host}"])) faute(`${hote} : X-Real-Ip = {http.request.remote.host} absent`);
  return p[0];
};
proxy(clients, "clients.exemple.fr", "app:3001");
const versBar = proxy(bar, "bar.exemple.fr", "app:3000");
if (!(versBar.headers.request.delete || []).includes("Authorization")) faute("Authorization non supprimé vers app:3000");
if (clients.some(h => h.handler === "authentication")) faute("mot de passe sur l’hôte des clients");
const auth = toutes.filter(h => h.handler === "authentication");
if (auth.length !== 1 || !bar.includes(auth[0])) faute(`authentication attendue dans la seule route de bar.exemple.fr (${auth.length} trouvée(s))`);
if (auth[0].providers?.http_basic?.accounts?.[0]?.username !== "bar") faute("compte basic_auth « bar » absent");
JS
)" < "$TMP/v3.json"
reussi

# ---------------------------------------------------------------- V4
controle V4 'en-tête X-Real-IP'
discret C up -d
P=$(C port caddy 80 2>> "$JOURNAL") || echec "port de caddy introuvable"
statut() { requete -s -o /dev/null -w '%{http_code}' --max-time 5 "$@"; }
pret() { [ "$(statut -H 'Host: clients.exemple.fr' "http://$P/x")" = 200 ]; }
attendre 30 pret || echec "pas de réponse 200 de Caddy en 30 s"
ECHO=$(requete -sS --max-time 10 -H 'Host: clients.exemple.fr' -H 'X-Real-IP: 203.0.113.9' "http://$P/x") \
  || echec "requête vers clients.exemple.fr en échec"
verifier_json "$(cat <<'JS'
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
const faute = texte => { console.log(texte); process.exit(1); };
if (r.port !== 3001) faute(`requête reçue sur le port ${r.port}, attendu 3001`);
const ip = r.headers["x-real-ip"];
if (!ip || ip === "203.0.113.9") faute(`x-real-ip reçu : ${ip}`);
if (ip !== r.headers["x-forwarded-for"]) faute(`x-real-ip ${ip} différent de x-forwarded-for ${r.headers["x-forwarded-for"]}`);
JS
)" <<< "$ECHO"
reussi

# ---------------------------------------------------------------- V5
controle V5 'mot de passe du bar'
s=$(statut -H 'Host: bar.exemple.fr' "http://$P/x")
[ "$s" = 401 ] || echec "sans identifiants : HTTP $s, attendu 401"
s=$(statut -u bar:faux -H 'Host: bar.exemple.fr' "http://$P/x")
[ "$s" = 401 ] || echec "avec un faux mot de passe : HTTP $s, attendu 401"
ECHO=$(requete -sS --max-time 10 -w '\n%{http_code}' -u "bar:$MOT" -H 'Host: bar.exemple.fr' "http://$P/x") \
  || echec "requête vers bar.exemple.fr en échec"
[ "${ECHO##*$'\n'}" = 200 ] || echec "avec le bon mot de passe : HTTP ${ECHO##*$'\n'}, attendu 200"
verifier_json "$(cat <<'JS'
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
const faute = texte => { console.log(texte); process.exit(1); };
if (r.port !== 3000) faute(`requête reçue sur le port ${r.port}, attendu 3000`);
if ("authorization" in r.headers) faute("en-tête authorization transmis à l’application");
JS
)" <<< "${ECHO%$'\n'*}"
reussi

# ---------------------------------------------------------------- V6
controle V6 'journal de Caddy sans secret'
discret C stop app
s=$(statut -u "bar:$MOT" -H 'Host: bar.exemple.fr' -H 'x-staff-key: SECRETENTETE' "http://$P/api/staff/state?key=SECRETCLE")
[ "$s" = 502 ] || echec "bar, écho arrêté : HTTP $s, attendu 502"
s=$(statut -H 'Host: clients.exemple.fr' "http://$P/t/T1/SECRETACCES")
[ "$s" = 502 ] || echec "clients, écho arrêté : HTTP $s, attendu 502"
journal_502() { C logs --no-log-prefix caddy > "$TMP/caddy.log" 2>&1 && grep -qF '"status":502' "$TMP/caddy.log"; }
attendre 10 journal_502 || echec "aucune ligne \"status\":502 dans le journal de caddy"
n=$(grep -c 'SECRET' "$TMP/caddy.log" || true)
[ "$n" = 0 ] || echec "$n ligne(s) du journal de caddy contiennent SECRET"
n=$(grep -c 'Basic' "$TMP/caddy.log" || true)
[ "$n" = 0 ] || echec "$n ligne(s) du journal de caddy contiennent Basic"
discret C down -v
reussi

# ---------------------------------------------------------------- V7
controle V7 'sauvegarde'
discret docker compose up -d app
CID=$(docker compose ps -q app)
[ -n "$CID" ] || echec "conteneur app introuvable"
MONTAGES=$(docker inspect -f '{{range .Mounts}}{{.Name}}={{.Destination}} {{end}}' "$CID" | tr ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' ')
[ "$MONTAGES" = "${COMPOSE_PROJECT_NAME}_karafun-data=/app/data ${COMPOSE_PROJECT_NAME}_karafun-journal=/app/journal " ] \
  || echec "volumes de app : $MONTAGES"
DROITS=$(docker compose exec -T app stat -c '%a %U %n' /app/data /app/journal 2>> "$JOURNAL") || echec "stat des dossiers en échec"
[ "$DROITS" = $'700 node /app/data\n700 node /app/journal' ] || echec "droits des volumes neufs : $(tr '\n' ';' <<< "$DROITS")"
attendre 30 docker compose exec -T app test -s /app/data/staff-key || echec "/app/data/staff-key absent après 30 s"
code=0
./sauvegarde.sh > "$TMP/v7.out" 2> "$TMP/v7.err" || code=$?
[ "$code" = 0 ] || echec "./sauvegarde.sh : code $code, $(tail -n 3 "$TMP/v7.err")"
mapfile -t LIGNES < "$TMP/v7.out"
[ "${#LIGNES[@]}" = 3 ] && [ "${LIGNES[0]}" = 'Arrêt de la file karaoké le temps de la copie.' ] \
  && [[ ${LIGNES[1]} =~ ^Sauvegarde\ écrite\ :\ (sauvegardes/karafun-plus-[0-9]{8}-[0-9]{6}Z\.tar\.gz)\ \([0-9.,]+[KMGT]?\)$ ]] \
  && [ "${LIGNES[2]}" = 'File karaoké relancée.' ] || echec "messages de ./sauvegarde.sh : $(tr '\n' '|' < "$TMP/v7.out")"
V7_ARCHIVE=${BASH_REMATCH[1]}
CONTENU=$(ls -A sauvegardes)
[ "$CONTENU" = "${V7_ARCHIVE#sauvegardes/}" ] || echec "sauvegardes/ contient : $(tr '\n' ' ' <<< "$CONTENU")"
[ "$(stat -c '%a' sauvegardes)" = 700 ] || echec "sauvegardes/ en $(stat -c '%a' sauvegardes), attendu 700"
[ "$(stat -c '%a' "$V7_ARCHIVE")" = 600 ] || echec "$V7_ARCHIVE en $(stat -c '%a' "$V7_ARCHIVE"), attendu 600"
LISTE=$(tar -tzf "$V7_ARCHIVE") || echec "$V7_ARCHIVE illisible"
for entree in data/ data/staff-key journal/; do
  grep -qxF "$entree" <<< "$LISTE" || echec "$entree absent de $V7_ARCHIVE"
done
[ -n "$(docker compose ps --status running -q app)" ] || echec "app non relancée après la sauvegarde"
reussi

# ---------------------------------------------------------------- V8
controle V8 'restauration'
DEMARRE=$(docker inspect -f '{{.State.StartedAt}}' "$CID")
code=0
./restauration.sh < /dev/null > "$TMP/r.out" 2> "$TMP/r.err" || code=$?
[ "$code" = 2 ] && [ "$(cat "$TMP/r.err")" = 'Usage : ./restauration.sh sauvegardes/karafun-plus-AAAAMMJJ-HHMMSSZ.tar.gz' ] \
  || echec "sans argument : code $code, $(head -c 200 "$TMP/r.err")"
code=0
./restauration.sh sauvegardes/absente.tar.gz < /dev/null > "$TMP/r.out" 2> "$TMP/r.err" || code=$?
[ "$code" = 1 ] && [ "$(cat "$TMP/r.err")" = 'Archive introuvable : sauvegardes/absente.tar.gz' ] \
  || echec "archive absente : code $code, $(head -c 200 "$TMP/r.err")"
mkdir -p "$TMP/p/data"
echo piege > "$TMP/p/x"
tar -czPf "$TMP/piege.tar.gz" -C "$TMP/p" data data/../x
# Listes lues en entier avant grep -q (sinon tar peut finir sur SIGPIPE).
LISTE=$(tar -tzf "$TMP/piege.tar.gz" 2>> "$JOURNAL")
grep -qxF 'data/../x' <<< "$LISTE" || echec "archive piégée sans data/../x"
code=0
./restauration.sh "$TMP/piege.tar.gz" < /dev/null > "$TMP/r.out" 2> "$TMP/r.err" || code=$?
# Avertissements de tar visibles (section 7), puis le refus en dernière ligne.
AVERTISSEMENTS=$(sed '$d' "$TMP/r.err")
[ "$code" = 1 ] && [ "$(tail -n 1 "$TMP/r.err")" = 'Archive refusée : elle doit contenir data/ et seulement data/ et journal/.' ] \
  && { [ -z "$AVERTISSEMENTS" ] || ! grep -qv '^tar: ' <<< "$AVERTISSEMENTS"; } && [ ! -s "$TMP/r.out" ] \
  || echec "archive piégée : code $code, $(tr '\n' '|' < "$TMP/r.err" | head -c 300)"
code=0
echo non | ./restauration.sh "$V7_ARCHIVE" > "$TMP/r.out" 2> "$TMP/r.err" || code=$?
[ "$code" = 1 ] && [ "$(cat "$TMP/r.out")" = "Les données actuelles seront remplacées par $V7_ARCHIVE."$'\n'"Tape RESTAURER pour confirmer : "$'\n'"Restauration annulée : rien n'a changé." ] \
  || echec "réponse « non » : code $code, $(tr '\n' '|' < "$TMP/r.out")"
[ "$(docker inspect -f '{{.State.StartedAt}}' "$CID")" = "$DEMARRE" ] || echec "app redémarrée par un refus"
[ "$(ls -A sauvegardes)" = "${V7_ARCHIVE#sauvegardes/}" ] || echec "sauvegardes/ modifié par un refus"

mkdir "$TMP/r"
tar -xzf "$V7_ARCHIVE" -C "$TMP/r"
chmod 0755 "$TMP/r/data" "$TMP/r/journal"
tar -czf sauvegardes/essai-0755.tar.gz -C "$TMP/r" data journal
discret docker compose exec -T app sh -c 'echo essai > /app/data/marqueur-essai'
sleep 1
code=0
echo RESTAURER | ./restauration.sh sauvegardes/essai-0755.tar.gz > "$TMP/r.out" 2> "$TMP/r.err" || code=$?
[ "$code" = 0 ] || echec "RESTAURER : code $code, $(tail -n 3 "$TMP/r.err")"
mapfile -t LIGNES < "$TMP/r.out"
[ "${#LIGNES[@]}" = 7 ] && [ "${LIGNES[0]}" = 'Les données actuelles seront remplacées par sauvegardes/essai-0755.tar.gz.' ] \
  && [ "${LIGNES[1]}" = 'Tape RESTAURER pour confirmer : ' ] && [ "${LIGNES[2]}" = 'Arrêt de la file karaoké.' ] \
  && [ "${LIGNES[3]}" = "Sauvegarde de l'état actuel avant restauration :" ] \
  && [[ ${LIGNES[4]} =~ ^Sauvegarde\ écrite\ :\ sauvegardes/karafun-plus-[0-9]{8}-[0-9]{6}Z\.tar\.gz\ \(.+\)$ ]] \
  && [ "${LIGNES[5]}" = 'Restauration terminée depuis sauvegardes/essai-0755.tar.gz.' ] \
  && [ "${LIGNES[6]}" = 'File karaoké relancée.' ] || echec "messages de ./restauration.sh : $(tr '\n' '|' < "$TMP/r.out")"
[ -n "$(docker compose ps --status running -q app)" ] || echec "app arrêtée après la restauration"
docker compose exec -T app test ! -e /app/data/marqueur-essai || echec "marqueur-essai encore présent : données mêlées"
ATTENDU=$(tar -xzOf "$V7_ARCHIVE" data/staff-key | sha256sum | cut -d ' ' -f 1)
OBTENU=$(docker compose exec -T app sha256sum /app/data/staff-key 2>> "$JOURNAL" | cut -d ' ' -f 1) || OBTENU=''
[ -n "$ATTENDU" ] && [ "$OBTENU" = "$ATTENDU" ] || echec "SHA-256 de data/staff-key : $OBTENU, attendu $ATTENDU"
DROITS=$(docker compose exec -T app stat -c '%a %U %n' /app/data /app/journal /app/data/staff-key 2>> "$JOURNAL") || echec "stat après restauration en échec"
[[ $DROITS =~ ^700\ node\ /app/data$'\n'700\ node\ /app/journal$'\n'[0-7]+\ node\ /app/data/staff-key$ ]] \
  || echec "droits après restauration : $(tr '\n' ';' <<< "$DROITS")"
ARCHIVES=()
for archive in sauvegardes/karafun-plus-*; do
  if [ -e "$archive" ]; then ARCHIVES+=("${archive#sauvegardes/}"); fi
done
[ "${#ARCHIVES[@]}" = 2 ] || echec "${#ARCHIVES[@]} archive(s) karafun-plus-* dans sauvegardes/, attendu 2"
LISTE=$(tar -tzf "sauvegardes/${ARCHIVES[1]}") || echec "sauvegardes/${ARCHIVES[1]} illisible"
grep -qxF 'data/marqueur-essai' <<< "$LISTE" || echec "la sauvegarde de sécurité ${ARCHIVES[1]} ne contient pas data/marqueur-essai"
[ "$(etat_karafun_plus)" = "$AVANT_KARAFUN_PLUS" ] || echec "projet karafun-plus modifié pendant l'essai"
reussi

# ---------------------------------------------------------------- V9
controle V9 "image vue de l'intérieur"
VUE=$(docker run --rm "$IMAGE" sh -c 'ls -A /app; stat -c "%a %U %n" /app/data /app/journal /app/server.js; ls -A /app/data /app/journal' 2>> "$JOURNAL") \
  || echec "docker run en échec"
ECRIVABLE=$(docker run --rm "$IMAGE" find /app -mindepth 1 '(' -path /app/data -o -path /app/journal ')' -prune -o ! -type l '(' -user node -o -perm -0002 ')' -print 2>> "$JOURNAL") \
  || echec "find dans l'image en échec"
[ -z "$ECRIVABLE" ] || echec "code modifiable par node : $(head -n 5 <<< "$ECRIVABLE" | tr '\n' ' ')"
verifier_json "$(cat <<'JS'
const fs = require("fs");
const faute = texte => { console.log(texte); process.exit(1); };
const lignes = fs.readFileSync(0, "utf8").replace(/\n$/, "").split("\n");
const commun = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).commun;
const attendu = [...new Set(commun.map(e => e.split("/")[0])), "build-info.json", "node_modules", "solver-runtime", "LICENCES-JAVA", "data", "journal"].sort();
const fin = lignes.findIndex(l => /^\d+ \S+ \/app\//.test(l));
if (fin < 0) faute("sortie de stat absente");
const vus = lignes.slice(0, fin).sort();
const absents = attendu.filter(e => !vus.includes(e)), enTrop = vus.filter(e => !attendu.includes(e));
if (absents.length || enTrop.length) faute(`/app : absents ${absents.join(", ") || "aucun"} ; en trop ${enTrop.join(", ") || "aucun"}`);
const [data, journal, server, ...reste] = lignes.slice(fin);
if (data !== "700 node /app/data" || journal !== "700 node /app/journal") faute(`droits : ${data} ; ${journal}`);
const m = /^(\d+) (\S+) \/app\/server\.js$/.exec(server || "");
if (!m || m[2] !== "root" || (parseInt(m[1], 8) & 0o022)) faute(`server.js : ${server}`);
if (JSON.stringify(reste) !== JSON.stringify(["/app/data:", "", "/app/journal:"])) faute(`data/ ou journal/ non vide : ${reste.join("|")}`);
JS
)" "$RACINE/livrable.json" <<< "$VUE"
reussi

# ---------------------------------------------------------------- V10
controle V10 'port du bar sur la boucle locale'
PUBLIE=$(docker compose port app 3000 2>> "$JOURNAL") || PUBLIE=''
[ "$PUBLIE" = 127.0.0.1:3000 ] || echec "docker compose port app 3000 : « $PUBLIE », attendu 127.0.0.1:3000"
sante() { [ "$(requete -s --max-time 3 http://127.0.0.1:3000/healthz)" = ok ]; }
attendre 30 sante || echec "/healthz sans réponse « ok » sur 127.0.0.1:3000 en 30 s"
REPONSE=$(requete -sS --max-time 3 -w '\n%{http_code}' http://127.0.0.1:3000/healthz) || echec "/healthz en échec sur 127.0.0.1:3000"
[ "$REPONSE" = $'ok\n200' ] || echec "/healthz sur 127.0.0.1:3000 : $(tr '\n' ' ' <<< "$REPONSE")"
for cible in "$EXT:3000" 127.0.0.1:3001 "$EXT:3001"; do
  code=$(code_curl "http://$cible/healthz")
  [ "$code" = 7 ] || [ "$code" = 28 ] || echec "réponse HTTP sur $cible (curl $code), attendu aucune (7 ou 28)"
done
reussi

[ "$COMPTE" = 10 ] || { ID=fin; LIBELLE='comptage'; echec "$COMPTE contrôles réussis sur 10"; }
echo "Déploiement vérifié : 10 contrôles réussis ($IMAGE)."
