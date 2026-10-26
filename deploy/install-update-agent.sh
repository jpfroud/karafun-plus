#!/usr/bin/env bash
# One-time host installation. The web container never receives Docker or SSH.
#   sudo bash deploy/install-update-agent.sh --repo /home/karaoke/karafun-plus
set -euo pipefail
unset CDPATH

repo=/home/karaoke/karafun-plus
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) [ "$#" -ge 2 ] || exit 2; repo=$2; shift 2 ;;
    *) echo 'Usage : sudo bash deploy/install-update-agent.sh [--repo /chemin/karafun-plus]' >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo 'L’installation du service demande sudo.' >&2; exit 1; }
repo=$(realpath -- "$repo")
# Paths go into systemd unit fields, never into a shell expression.
[[ $repo =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Chemin du dépôt non pris en charge.' >&2; exit 1; }
[ -f "$repo/deploy/compose.yaml" ] && [ -f "$repo/deploy/.env" ] || {
  echo 'Le dépôt et sa configuration doivent déjà être installés.' >&2; exit 1;
}
operator=$(stat -c '%U' -- "$repo")
[[ $operator =~ ^[a-z_][a-z0-9_-]*$ ]] && [ "$operator" != root ] || {
  echo 'Le dépôt doit appartenir au compte d’exploitation non root.' >&2; exit 1;
}
operator_home=$(getent passwd "$operator" | cut -d: -f6)
[[ $operator_home =~ ^/[a-zA-Z0-9_./-]+$ ]] || exit 1
getent group 1000 > /dev/null || { echo 'Le groupe du conteneur node (1000) est absent.' >&2; exit 1; }
getent group docker > /dev/null || { echo 'Docker doit être installé avant cet agent.' >&2; exit 1; }
command -v python3 > /dev/null
command -v systemctl > /dev/null
source_file=$(realpath -- "$(dirname "$0")/update-agent.py")
python3 -c 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())' "$source_file"

library="$operator_home/.local/lib/karafun-plus"
state="$operator_home/.local/state/karafun-plus-update"
install -d -o "$operator" -g "$operator" -m 0700 "$state"
install -d -o "$operator" -g "$operator" -m 0755 "$library"
install -o root -g root -m 0755 "$source_file" "$library/update-agent.py"
install -d -o "$operator" -g 1000 -m 2770 "$repo/deploy/maintenance"

# No shell sourcing: .env includes a bcrypt hash and must remain literal text.
if [ ! -f "$state/env.before-agent-install" ]; then
  install -o "$operator" -g "$operator" -m 0600 "$repo/deploy/.env" "$state/env.before-agent-install"
fi
python3 - "$repo/deploy/.env" <<'PY'
import os, pathlib, re, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding='utf-8')
text, count = re.subn(r'^KARAOKE_UPDATE_DIR=.*$', 'KARAOKE_UPDATE_DIR=/app/maintenance', text, flags=re.M)
if count > 1:
    raise SystemExit('KARAOKE_UPDATE_DIR apparaît plusieurs fois : installation annulée.')
if count == 0:
    text = text.rstrip('\n') + '\nKARAOKE_UPDATE_DIR=/app/maintenance\n'
temporary = path.with_name('.env.install-agent.tmp')
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as output:
    output.write(text)
    output.flush()
    os.fsync(output.fileno())
os.replace(temporary, path)
PY
chown "$operator:$operator" "$repo/deploy/.env"
chmod 0600 "$repo/deploy/.env"

cat > /etc/systemd/system/karafun-plus-update.service <<UNIT
[Unit]
Description=KaraFun Plus - mise a jour depuis une release stable
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service
StartLimitIntervalSec=0

[Service]
Type=oneshot
User=$operator
Group=1000
SupplementaryGroups=docker
WorkingDirectory=$repo/deploy
ExecStart=/usr/bin/python3 $library/update-agent.py --repo $repo --state $state
TimeoutStartSec=2400
UMask=0007
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$repo $state
Environment=PYTHONDONTWRITEBYTECODE=1
UNIT
cat > /etc/systemd/system/karafun-plus-update.timer <<'UNIT'
[Unit]
Description=Verifier les demandes de mise a jour KaraFun Plus

[Timer]
OnBootSec=15s
OnUnitInactiveSec=10s
AccuracySec=1s
Unit=karafun-plus-update.service

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now karafun-plus-update.timer
echo 'Agent de mise à jour installé ; son code reste hors du dépôt mis à jour.'
echo 'Le bouton sera disponible après recréation du conteneur avec la configuration de maintenance.'
