#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ bootstrap.sh — первый запуск на свежем Ubuntu 24.04 (RUVDS/Timeweb).      ║
# ║ Идемпотентный: повторный запуск не ломает установленное.                 ║
# ║ Что делает: PostgreSQL 15, Node.js 20, nginx, certbot, ufw, пользователь ║
# ║ skladpro, каталоги /opt/skladpro-backend, /var/www/skladpro{,-admin}.    ║
# ╚══════════════════════════════════════════════════════════════════════════╝
# Запуск: sudo bash bootstrap.sh <db-password>
#
# После скрипта:
#   1. Положить .env в /opt/skladpro-backend/.env (см. .env.example)
#   2. Положить credentials/firebase-admin.json туда же
#   3. Скопировать nginx.conf и подставить домен
#   4. certbot --nginx (когда домен указан на IP)
#   5. Первый деплой: scripts/deploy.sh с локальной машины

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Запускать под root: sudo bash bootstrap.sh <db-password>" >&2
  exit 1
fi

DB_PASSWORD="${1:-}"
if [[ -z "$DB_PASSWORD" ]]; then
  echo "Использование: sudo bash bootstrap.sh <db-password>" >&2
  echo "  db-password — пароль для роли skladpro в Postgres (используется в .env → DATABASE_URL)" >&2
  exit 1
fi

echo "== [1/7] Обновление системы и базовые пакеты =="
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release ufw rsync

echo "== [2/7] Node.js 20 (nodesource) =="
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
node -v && npm -v

echo "== [3/7] PostgreSQL 15 =="
apt-get install -y -qq postgresql-15 postgresql-contrib-15
systemctl enable --now postgresql

# Роль и БД — CREATE только если не существует.
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='skladpro'" | grep -q 1 \
  || sudo -u postgres psql -c "create user skladpro with password '$DB_PASSWORD'"
# ALTER безопасно перезаписывает пароль (если запускаем повторно с новым).
sudo -u postgres psql -c "alter user skladpro with password '$DB_PASSWORD'"

sudo -u postgres psql -tAc "select 1 from pg_database where datname='skladpro'" | grep -q 1 \
  || sudo -u postgres psql -c "create database skladpro owner skladpro"

# pgcrypto нужен для gen_random_uuid() в миграциях (0001_init).
sudo -u postgres psql -d skladpro -c "create extension if not exists pgcrypto"

echo "== [4/7] Nginx + certbot =="
apt-get install -y -qq nginx certbot python3-certbot-nginx

echo "== [5/7] Пользователь skladpro и каталоги =="
if ! id skladpro >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash --home-dir /home/skladpro skladpro
fi

install -d -m 0755 -o skladpro -g skladpro /opt/skladpro-backend
install -d -m 0755 -o skladpro -g skladpro /opt/skladpro-backend/credentials
install -d -m 0755 -o www-data -g www-data /var/www/skladpro
install -d -m 0755 -o www-data -g www-data /var/www/skladpro-admin
install -d -m 0755 -o www-data -g www-data /var/www/skladpro/downloads
install -d -m 0750 -o skladpro -g skladpro /var/backups/skladpro
install -d -m 0755 -o skladpro -g skladpro /var/log/skladpro

echo "== [6/7] systemd unit =="
# Если репозиторий уже загружен и /opt/skladpro-backend/deploy/skladpro-api.service
# существует — используем его; иначе минимальный fallback.
if [[ -f /opt/skladpro-backend/deploy/skladpro-api.service ]]; then
  cp /opt/skladpro-backend/deploy/skladpro-api.service /etc/systemd/system/skladpro-api.service
else
  cat > /etc/systemd/system/skladpro-api.service <<'UNIT'
[Unit]
Description=SkladPro API
After=network.target postgresql.service

[Service]
Type=simple
User=skladpro
Group=skladpro
WorkingDirectory=/opt/skladpro-backend
EnvironmentFile=/opt/skladpro-backend/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3
StandardOutput=append:/var/log/skladpro/api.log
StandardError=append:/var/log/skladpro/api.err.log

[Install]
WantedBy=multi-user.target
UNIT
fi
systemctl daemon-reload
# enable — но НЕ start (файлов ещё нет; первый деплой стартанёт service сам).
systemctl enable skladpro-api >/dev/null 2>&1 || true

echo "== [7/7] ufw =="
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
# 8787 наружу закрыт — API доступен только через nginx.
ufw deny 8787 >/dev/null || true
ufw --force enable

echo
echo "OK. Следующие шаги:"
echo "  scp .env root@<IP>:/opt/skladpro-backend/.env"
echo "  scp firebase-admin.json root@<IP>:/opt/skladpro-backend/credentials/"
echo "  # с локальной машины: scripts/deploy.sh root@<IP>"
echo "  # затем certbot --nginx -d api.<домен> -d <домен> -d admin.<домен>"
