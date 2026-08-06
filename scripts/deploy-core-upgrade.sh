#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ deploy-core-upgrade.sh — выкат учётного ядра (0020) в два прохода.       ║
# ║                                                                          ║
# ║ Проход 1: sync   — копирует файлы, прогоняет reconcile БЕЗ миграций.   ║
# ║ Проход 2: migrate — применяет миграции, рестартует, reconcile повторно.  ║
# ║                                                                          ║
# ║ Между проходами ОСТАНОВИТЬСЯ и прочитать вывод reconcile.               ║
# ║ Guard (install_ledger_guard) ставится ОТДЕЛЬНО, после проверки.          ║
# ║                                                                          ║
# ║ Использование:                                                           ║
# ║   scripts/deploy-core-upgrade.sh sync    root@<host>                     ║
# ║   # ← прочитать вывод reconcile, убедиться что пусто                     ║
# ║   scripts/deploy-core-upgrade.sh migrate root@<host>                     ║
# ║   # ← прочитать вывод reconcile, сравнить с первым                       ║
# ║   # ← если сошлось: ssh root@<host>, sudo -u skladpro psql -d skladpro  ║
# ║   #   select install_ledger_guard();                                     ║
# ║   #   \dt *trigger* или pg_trigger запрос для проверки                    ║
# ║   # ← reconcile в третий раз                                             ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

STEP="${1:-}"
SSH_TARGET="${2:-}"

if [[ -z "$STEP" || -z "$SSH_TARGET" ]]; then
  echo "Использование:" >&2
  echo "  $0 sync    root@<host>   # шаг 1: копировать файлы + reconcile" >&2
  echo "  $0 migrate root@<host>   # шаг 2: миграции + рестарт + reconcile" >&2
  echo "  $0 quick   root@<host>   # только JS: бандл → dist.prev → rsync → рестарт → health" >&2
  exit 1
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

case "$STEP" in
  sync)
    echo "== Сборка =="
    npm ci
    npm run build

    echo "== Бэкап (pg_dump) =="
    DUMP_NAME="skladpro-$(date +%F-%H%M).dump"
    ssh "$SSH_TARGET" bash <<REMOTE
set -euo pipefail
DUMP="/var/backups/${DUMP_NAME}"
sudo -u skladpro pg_dump -Fc -d skladpro -f "\$DUMP"
SIZE=\$(stat -c%s "\$DUMP")
echo "Бэкап: \$DUMP (\$SIZE байт)"
if [ "\$SIZE" -lt 1000 ]; then
  echo "ОШИБКА: бэкап подозрительно маленький, прерываю." >&2
  exit 1
fi
REMOTE

    echo "== Скачиваем дамп локально =="
    scp "$SSH_TARGET:/var/backups/${DUMP_NAME}" "./${DUMP_NAME}"
    echo "Локальная копия: ./${DUMP_NAME}"
    pg_restore --list "./${DUMP_NAME}" | head -5 \
      && echo "pg_restore --list: дамп читается" \
      || echo "⚠ pg_restore --list не прошёл — проверь дамп вручную"

    echo "== rsync файлов (БЕЗ миграций и рестарта) =="
    ssh "$SSH_TARGET" bash <<'REMOTE'
set -euo pipefail
cd /opt/skladpro-backend
[ -d dist ] && rm -rf dist.prev && cp -a dist dist.prev && echo "dist.prev сохранён"
REMOTE

    rsync -avz --delete \
      --exclude='.git' --exclude='node_modules' --exclude='test' \
      dist package.json package-lock.json sql \
      "$SSH_TARGET:/opt/skladpro-backend/"

    ssh "$SSH_TARGET" bash <<'REMOTE'
set -euo pipefail
chown -R skladpro:skladpro /opt/skladpro-backend
REMOTE

    echo ""
    echo "== Reconcile (база ещё НЕ тронута, но скрипт уже новый) =="
    ssh "$SSH_TARGET" bash <<'REMOTE'
set -euo pipefail
sudo -u skladpro psql -d skladpro -f /opt/skladpro-backend/sql/reconcile.sql
REMOTE

    echo ""
    echo "════════════════════════════════════════════════════════"
    echo "СТОП. Прочитай вывод reconcile выше."
    echo "Если все 8 секций пустые — запускай:"
    echo "  $0 migrate $SSH_TARGET"
    echo "Если что-то непусто — разбирайся ДО миграций."
    echo "════════════════════════════════════════════════════════"
    ;;

  migrate)
    echo "== npm ci + миграции (БЕЗ рестарта) =="
    ssh "$SSH_TARGET" bash <<'REMOTE'
set -euo pipefail
cd /opt/skladpro-backend
sudo -u skladpro -H npm ci --omit=dev
echo ""
echo "== Миграции =="
sudo -u skladpro -H node dist/migrate.js
echo ""
echo "== Проверка: последние 5 миграций =="
sudo -u skladpro psql -d skladpro -c "select name, applied_at from schema_migrations order by name desc limit 5;"
REMOTE

    echo ""
    echo "== Рестарт сервиса =="
    ssh "$SSH_TARGET" bash <<'REMOTE'
set -euo pipefail
systemctl restart skladpro-api
sleep 2
systemctl status skladpro-api --no-pager --lines=8
REMOTE

    echo ""
    echo "== Health check (порт 8787) =="
    ssh "$SSH_TARGET" bash <<'REMOTE'
set -euo pipefail
for i in 1 2 3 4 5; do
  if curl -fsS --max-time 5 http://localhost:8787/health; then
    echo "  ok"
    exit 0
  fi
  sleep 2
done
echo "  ⚠ /health не ответил после 5 попыток" >&2
exit 1
REMOTE

    echo ""
    echo "== Reconcile повторно =="
    ssh "$SSH_TARGET" bash <<'REMOTE'
set -euo pipefail
sudo -u skladpro psql -d skladpro -f /opt/skladpro-backend/sql/reconcile.sql
REMOTE

    echo ""
    echo "════════════════════════════════════════════════════════"
    echo "Прочитай reconcile. Сравни с первым прогоном."
    echo "Если сошлось — ставь guard вручную:"
    echo "  ssh $SSH_TARGET"
    echo "  sudo -u skladpro psql -d skladpro"
    echo "  select install_ledger_guard();"
    echo "  select tgname, tgrelid::regclass from pg_trigger"
    echo "    where tgname like '%ledger%' and not tgisinternal;"
    echo "  \\q"
    echo "  sudo -u skladpro psql -d skladpro -f /opt/skladpro-backend/sql/reconcile.sql"
    echo "════════════════════════════════════════════════════════"
    ;;

  quick)
    echo "== Quick deploy (только JS, без миграций) =="
    npm run build

    echo "== Сборка бандла =="
    tar -czf deploy-bundle.tar.gz dist package.json package-lock.json sql
    scp deploy-bundle.tar.gz "$SSH_TARGET:/tmp/deploy-bundle.tar.gz"
    rm deploy-bundle.tar.gz

    ssh "$SSH_TARGET" bash <<'REMOTE'
set -euo pipefail
cd /opt/skladpro-backend
[ -d dist ] && rm -rf dist.prev && cp -a dist dist.prev && echo "dist.prev сохранён"
tar -xzf /tmp/deploy-bundle.tar.gz
chown -R skladpro:skladpro dist sql
rm /tmp/deploy-bundle.tar.gz
systemctl restart skladpro-api
for i in 1 2 3 4 5; do
  if curl -fsS --max-time 5 http://localhost:8787/health; then
    echo "  ok"
    exit 0
  fi
  sleep 2
done
echo "  ⚠ /health не ответил" >&2
exit 1
REMOTE
    ;;

  *)
    echo "Неизвестный шаг: $STEP (допустимые: sync, migrate, quick)" >&2
    exit 1
    ;;
esac
