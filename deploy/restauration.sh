#!/usr/bin/env bash
# Restauration de data/ et journal/ de la file karaoké depuis une archive de
# sauvegarde.sh, après confirmation et sauvegarde de l'état actuel. Les
# données actuelles sont remplacées, jamais mêlées ; l'application est
# relancée à la fin, même en cas d'échec.
#   ./restauration.sh sauvegardes/karafun-plus-AAAAMMJJ-HHMMSSZ.tar.gz
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage : ./restauration.sh sauvegardes/karafun-plus-AAAAMMJJ-HHMMSSZ.tar.gz" >&2
  exit 2
fi
demande=$1
if [ ! -f "$demande" ]; then
  echo "Archive introuvable : $demande" >&2
  exit 1
fi
archive="$(cd "$(dirname "$demande")" && pwd)/$(basename "$demande")"
cd "$(dirname "$0")"
umask 077

if ! contenu=$(tar -tzf "$archive"); then
  echo "Archive illisible : $demande" >&2
  exit 1
fi
valide=1
avec_data=0
while IFS= read -r entree; do
  [[ $entree =~ ^(data|journal)(/|$) ]] || valide=0
  [[ /$entree/ == */../* ]] && valide=0
  [ "$entree" = 'data/' ] && avec_data=1
done <<< "$contenu"
if [ "$valide" != 1 ] || [ "$avec_data" != 1 ]; then
  echo "Archive refusée : elle doit contenir data/ et seulement data/ et journal/." >&2
  exit 1
fi

echo "Les données actuelles seront remplacées par $demande."
printf 'Tape RESTAURER pour confirmer : '
reponse=''
lue=0
read -r reponse && lue=1
# Réponse venue d'un tube ou d'un fichier : pas d'écho, fin de ligne ici.
[ -t 0 ] || echo
if [ "$lue" != 1 ] || [ "$reponse" != 'RESTAURER' ]; then
  echo "Restauration annulée : rien n'a changé."
  exit 1
fi

relancer() {
  local code=$?
  if docker compose up -d app > /dev/null; then
    echo "File karaoké relancée."
  else
    code=1
  fi
  exit "$code"
}
etat=$(docker compose ps --status running --quiet app)
trap relancer EXIT
if [ -n "$etat" ]; then
  echo "Arrêt de la file karaoké."
  docker compose stop app > /dev/null
fi

echo "Sauvegarde de l'état actuel avant restauration :"
./sauvegarde.sh

docker compose run --rm --no-deps -T app sh -c 'find /app/data /app/journal -mindepth 1 -delete && tar -xzf - -C /app && chmod 700 /app/data /app/journal' < "$archive"

echo "Restauration terminée depuis $demande."
