#!/usr/bin/env bash
# Сборка супер-админ панели (skladpro-admin/) + rsync в /var/www/skladpro-admin/
# Использование:
#   scripts/deploy-admin.sh root@<host> [путь-до-skladpro-admin]
set -euo pipefail

SSH_TARGET="${1:-}"
ADMIN_DIR="${2:-../skladpro-admin}"
if [[ -z "$SSH_TARGET" ]]; then
  echo "Использование: scripts/deploy-admin.sh <ssh-target> [путь-до-skladpro-admin]" >&2
  exit 1
fi

cd "$ADMIN_DIR"
if [[ ! -f package.json ]]; then
  echo "Не нашёл package.json в $(pwd)" >&2
  exit 1
fi

echo "== Сборка админ-панели =="
npm ci
npm run build

echo "== rsync в /var/www/skladpro-admin/ =="
rsync -avz --delete dist/ "$SSH_TARGET:/var/www/skladpro-admin/"

echo "== reload nginx =="
ssh "$SSH_TARGET" 'nginx -t && systemctl reload nginx'
echo "OK"
