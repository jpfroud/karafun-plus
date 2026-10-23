#!/usr/bin/env bash
# Sauvegarde de data/ et journal/ de la file karaoké (volumes de compose.yaml)
# dans sauvegardes/, à côté de ce script. L'application est arrêtée le temps
# de la copie (état de soirée cohérent), puis relancée, même en cas d'échec.
#   ./sauvegarde.sh
set -euo pipefail

cd "$(dirname "$0")"
umask 077
mkdir -p sauvegardes
chmod 0700 sauvegardes

archive="sauvegardes/karafun-plus-$(date -u +%Y%m%d-%H%M%SZ).tar.gz"
if [ -e "$archive" ]; then
  echo "Sauvegarde refusée : $archive existe déjà." >&2
  exit 1
fi

arretee=0
fin() {
  local code=$?
  rm -f -- "$archive.partiel"
  if [ "$arretee" = 1 ]; then
    if docker compose start app > /dev/null; then
      echo "File karaoké relancée."
    else
      code=1
    fi
  fi
  exit "$code"
}
trap fin EXIT

# Une application en boucle de redémarrage (restarting) compte comme en
# marche : sinon Docker la relancerait pendant la copie.
etat=$(docker compose ps --status running --status restarting --quiet app)
if [ -n "$etat" ]; then
  echo "Arrêt de la file karaoké le temps de la copie."
  arretee=1
  docker compose stop app > /dev/null
fi

docker compose run --rm --no-deps -T app tar -czf - -C /app data journal > "$archive.partiel"

# Liste lue en entier avant la recherche : grep -q fermerait le tube tôt.
contenu=$(tar -tzf "$archive.partiel") || contenu=''
if ! grep -qxF 'data/' <<< "$contenu"; then
  echo "Sauvegarde refusée : l'archive ne contient pas data/." >&2
  exit 1
fi

mv -- "$archive.partiel" "$archive"
chmod 0600 "$archive"
echo "Sauvegarde écrite : $archive ($(du -h -- "$archive" | cut -f1))"
