#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ backup.sh — ежедневный дамп БД + выгрузка на Яндекс.Диск (WebDAV, 10 ГБ ║
# ║ бесплатно). Правило 3-2-1: бэкапы лежат ВНЕ хостера, чтобы пожар в ЦОД  ║
# ║ RUVDS не убил и базу, и её копии.                                       ║
# ║                                                                          ║
# ║ cron (от пользователя skladpro):                                         ║
# ║   0 3 * * *  /opt/skladpro-backend/deploy/backup.sh                     ║
# ║                                                                          ║
# ║ Требует: pg_dump, curl, переменные в /opt/skladpro-backend/.env:        ║
# ║   DATABASE_URL      — обычная строка Postgres                           ║
# ║   YADISK_LOGIN      — email от Яндекс.Диска                             ║
# ║   YADISK_APP_PASSWORD — «пароль приложения» из id.yandex.ru             ║
# ║   YADISK_PATH       — папка на диске, например skladpro-backups         ║
# ║   (переменные не обязательны — без них локальный дамп всё равно едет)   ║
# ╚══════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

BACKUP_DIR=/var/backups/skladpro
KEEP_LOCAL_DAYS=7
KEEP_REMOTE_DAYS=30
ENV_FILE=/opt/skladpro-backend/.env

# .env: экспортируем ТОЛЬКО нужные ключи, чтобы случайные пробелы/спецсимволы
# в JWT_SECRET и прочем не сломали source. Скобки '<()' — тихий bash trick для
# «select subset of env-file без модификации».
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source <(grep -E '^(DATABASE_URL|YADISK_LOGIN|YADISK_APP_PASSWORD|YADISK_PATH)=' "$ENV_FILE")
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "backup.sh: DATABASE_URL не задан — читаю из $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d_%H%M%S)
FILE="$BACKUP_DIR/skladpro_$STAMP.dump"

echo "== dump =="
# --format=custom (сжатый бинарь) + --compress=6 — оптимальный баланс скорости
# и размера. Восстановление: pg_restore --clean --if-exists -d skladpro FILE.
pg_dump "$DATABASE_URL" --format=custom --compress=6 --file="$FILE"
echo "  $(du -h "$FILE" | cut -f1) — $FILE"

# Локально режем старые: если что-то поломает выгрузку — недавние точно на месте.
find "$BACKUP_DIR" -name 'skladpro_*.dump' -mtime +"$KEEP_LOCAL_DAYS" -delete

if [[ -z "${YADISK_LOGIN:-}" || -z "${YADISK_APP_PASSWORD:-}" ]]; then
  echo "  YADISK_* не заданы — пропускаю выгрузку в облако (только локальный бэкап)."
  exit 0
fi

REMOTE_DIR="${YADISK_PATH:-skladpro-backups}"
REMOTE_URL="https://webdav.yandex.ru/$REMOTE_DIR"
AUTH="$YADISK_LOGIN:$YADISK_APP_PASSWORD"

echo "== upload → $REMOTE_URL =="
# MKCOL — создать папку, 405/409 если уже есть; --fail только на HTTP ≥ 400,
# но конкретно 405/409 глушим отдельным grep, чтобы не падать при повторе.
mkcol_out=$(curl -sS -u "$AUTH" -X MKCOL "$REMOTE_URL/" -o /dev/null -w '%{http_code}') || true
case "$mkcol_out" in
  201|301|405|409) ;;                                    # ok / already exists
  *) echo "  ⚠ MKCOL вернул $mkcol_out — но продолжаю"; ;;
esac

curl -sS -u "$AUTH" -T "$FILE" "$REMOTE_URL/$(basename "$FILE")" -f -o /dev/null
echo "  uploaded"

# Чистка облака: PROPFIND depth=1 → список файлов → удаление старше 30 дней.
# ISO-timestamp имени файла (skladpro_YYYYMMDD_HHMMSS.dump) удобен для сравнения
# без парсинга дат: сравниваем строку с cutoff.
CUTOFF_STAMP=$(date -u -d "$KEEP_REMOTE_DAYS days ago" +%Y%m%d 2>/dev/null \
             || date -u -v -"${KEEP_REMOTE_DAYS}d" +%Y%m%d)  # BSD-fallback

# Извлекаем hрефы вида /skladpro-backups/skladpro_YYYYMMDD_HHMMSS.dump
LIST=$(curl -sS -u "$AUTH" -X PROPFIND -H 'Depth: 1' "$REMOTE_URL/" \
       | grep -oE "skladpro_[0-9]{8}_[0-9]{6}\.dump" | sort -u || true)

echo "  очистка старше $KEEP_REMOTE_DAYS дней (cutoff=$CUTOFF_STAMP)"
for name in $LIST; do
  # Извлечь YYYYMMDD из имени (позиции 10-17).
  file_stamp="${name:9:8}"
  if [[ "$file_stamp" < "$CUTOFF_STAMP" ]]; then
    curl -sS -u "$AUTH" -X DELETE "$REMOTE_URL/$name" -o /dev/null -w "    удалён $name (HTTP %{http_code})\n"
  fi
done

echo "OK"
