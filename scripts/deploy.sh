#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ deploy.sh — сборка backend локально + rsync + рестарт service на VPS.    ║
# ║ Использование: scripts/deploy.sh root@<host>                             ║
# ║ Требует на локалке: rsync, ssh с ключом; на VPS: bootstrap.sh уже прошёл.║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

SSH_TARGET="${1:-}"
if [[ -z "$SSH_TARGET" ]]; then
  echo "Использование: scripts/deploy.sh <ssh-target>" >&2
  echo "  пример: scripts/deploy.sh root@45.140.145.10" >&2
  exit 1
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

echo "== Сборка =="
# Ставим ТОЛЬКО prod deps + dev нужны для tsc — поэтому обычный ci + build,
# node_modules при синке пересобираем на сервере (npm ci --omit=dev).
npm ci
npm run build

echo "== rsync исходников =="
# Синкаем dist, package.json, package-lock.json, миграции. node_modules НЕ шлём —
# 300+ МБ по сети медленно; лучше npm ci на VPS.
rsync -avz --delete \
  --exclude='.git' --exclude='node_modules' --exclude='test' \
  dist package.json package-lock.json sql \
  "$SSH_TARGET:/opt/skladpro-backend/"

echo "== npm ci на сервере + миграции + рестарт =="
ssh "$SSH_TARGET" bash <<'REMOTE'
set -euo pipefail
cd /opt/skladpro-backend

# Права на добро — bootstrap создал каталог под skladpro:skladpro,
# rsync под root перевесил на root, возвращаем.
chown -R skladpro:skladpro /opt/skladpro-backend

# npm ci под пользователем skladpro (npm любит писать в HOME).
sudo -u skladpro -H npm ci --omit=dev

# Миграции — синхронный TS-скрипт (dist/migrate.js после сборки).
sudo -u skladpro -H node dist/migrate.js

systemctl restart skladpro-api
sleep 1
systemctl status skladpro-api --no-pager --lines=5
REMOTE

echo "== health check =="
HOST_ONLY="${SSH_TARGET#*@}"
# Без TLS/домена ходим по IP на 80 (nginx проксирует /health).
# С TLS — подставится домен в nginx.conf, ping'ать надо будет по нему.
curl -fsS --max-time 10 "http://${HOST_ONLY}/health" \
  && echo "  ok" \
  || echo "  ⚠ /health не ответил — проверьте nginx на сервере (nginx -t) и порт 80 в ufw"
