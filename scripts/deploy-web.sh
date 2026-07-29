#!/usr/bin/env bash
# Сборка веб-сайта (skladpro/) + rsync на VPS в /var/www/skladpro/
# Использование:
#   scripts/deploy-web.sh root@<host> [путь-до-skladpro]
#   пример: scripts/deploy-web.sh root@45.140.145.10 ../skladpro
set -euo pipefail

SSH_TARGET="${1:-}"
WEB_DIR="${2:-../skladpro}"
if [[ -z "$SSH_TARGET" ]]; then
  echo "Использование: scripts/deploy-web.sh <ssh-target> [путь-до-skladpro]" >&2
  exit 1
fi

cd "$WEB_DIR"
if [[ ! -f package.json ]]; then
  echo "Не нашёл package.json в $(pwd) — передайте путь до каталога skladpro/" >&2
  exit 1
fi

echo "== Сборка веб (Vite) =="
npm ci
npm run build

echo "== rsync в /var/www/skladpro/ =="
# --delete: удаляем на сервере файлы, которых больше нет в dist.
# Каталог downloads/ nginx раздаёт отдельно — исключаем, чтобы deploy-web не
# затирал уложенные release.sh APK/EXE.
rsync -avz --delete --exclude='downloads/' \
  dist/ "$SSH_TARGET:/var/www/skladpro/"

echo "== reload nginx =="
ssh "$SSH_TARGET" 'nginx -t && systemctl reload nginx'
echo "OK"
