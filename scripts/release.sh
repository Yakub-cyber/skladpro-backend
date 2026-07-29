#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ release.sh — собирает APK (мобилка + POS) и EXE (десктоп-касса), кладёт ║
# ║ на VPS в /var/www/skladpro/downloads/, обновляет latest.json.            ║
# ║ Старые версии остаются на диске (безусловно) — для отката.               ║
# ╚══════════════════════════════════════════════════════════════════════════╝
# Использование: scripts/release.sh root@<host> [--only mobile|pos|desktop]
#
# Требует локально:
#   - Android SDK для APK (мобилка + POS): expo prebuild + gradlew assembleRelease
#   - Windows или wine для EXE (десктоп): electron-builder
#   - APK-подпись: android/app/skladpro.keystore + пароли в ~/.gradle/gradle.properties
#
# Внимание: сборка APK ≈ 5-10 минут, EXE ≈ 3-5 минут.

set -euo pipefail

SSH_TARGET="${1:-}"
shift || true
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SSH_TARGET" ]]; then
  echo "Использование: scripts/release.sh <ssh-target> [--only mobile|pos|desktop]" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UPLOAD_DIR="/var/www/skladpro/downloads"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

should_build() {
  [[ -z "$ONLY" || "$ONLY" == "$1" ]]
}

# Собираем описание одного артефакта: {version, size, url, filename}
add_meta() {
  local key="$1" version="$2" filename="$3" src="$4"
  local size
  size=$(stat -c %s "$src" 2>/dev/null || stat -f %z "$src")
  cp "$src" "$STAGE/$filename"
  printf '  "%s": { "version": "%s", "size": %s, "url": "/downloads/%s", "filename": "%s" }' \
    "$key" "$version" "$size" "$filename" "$filename" >> "$STAGE/entries.tmp"
  printf ',\n' >> "$STAGE/entries.tmp"
}

: > "$STAGE/entries.tmp"

# --- Мобилка ---
if should_build mobile; then
  echo "== [mobile] сборка APK =="
  MOBILE="$REPO_ROOT/skladpro-mobile"
  MOBILE_VER=$(node -p "require('$MOBILE/package.json').version")
  (
    cd "$MOBILE"
    npm ci
    npx expo prebuild --clean --platform android
    cd android
    ./gradlew assembleRelease
  )
  APK=$(ls -1 "$MOBILE/android/app/build/outputs/apk/release"/*.apk | head -1)
  add_meta mobile "$MOBILE_VER" "skladpro-mobile-$MOBILE_VER.apk" "$APK"
fi

# --- POS Android ---
if should_build pos; then
  echo "== [pos] сборка APK =="
  POS="$REPO_ROOT/skladpro-pos"
  POS_VER=$(node -p "require('$POS/package.json').version")
  (
    cd "$POS"
    npm ci
    npx expo prebuild --clean --platform android
    cd android
    ./gradlew assembleRelease
  )
  APK=$(ls -1 "$POS/android/app/build/outputs/apk/release"/*.apk | head -1)
  add_meta pos "$POS_VER" "skladpro-kassa-$POS_VER.apk" "$APK"
fi

# --- Десктоп-касса ---
if should_build desktop; then
  echo "== [desktop] сборка EXE =="
  DESK="$REPO_ROOT/skladpro-pos-desktop"
  DESK_VER=$(node -p "require('$DESK/package.json').version")
  (
    cd "$DESK"
    npm ci
    npm run dist
  )
  EXE=$(ls -1 "$DESK/release"/*Setup*.exe 2>/dev/null | head -1)
  if [[ -z "$EXE" ]]; then
    # electron-builder может складывать в dist/ — fallback.
    EXE=$(ls -1 "$DESK/dist"/*Setup*.exe | head -1)
  fi
  add_meta desktop "$DESK_VER" "SkladPro-Kassa-Setup-$DESK_VER.exe" "$EXE"
fi

# --- latest.json ---
# Убираем висящую запятую после последней записи.
ENTRIES=$(sed '$ s/,$//' "$STAGE/entries.tmp")
BUILD_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$STAGE/latest.json" <<JSON
{
$ENTRIES
  ,"builtAt": "$BUILD_ISO"
}
JSON

# Если сборка «частичная» (--only), сохраняем прежние ключи из latest.json на
# сервере: скачиваем текущий, мёржим по ключам, отправляем результат.
if [[ -n "$ONLY" ]]; then
  echo "== Частичная сборка ($ONLY) — мёржим с текущим latest.json на сервере =="
  ssh "$SSH_TARGET" "cat $UPLOAD_DIR/latest.json 2>/dev/null || echo '{}'" > "$STAGE/remote.json"
  node -e "
    const fs = require('fs');
    const remote = JSON.parse(fs.readFileSync('$STAGE/remote.json','utf8') || '{}');
    const local = JSON.parse(fs.readFileSync('$STAGE/latest.json','utf8'));
    const merged = { ...remote, ...local };
    fs.writeFileSync('$STAGE/latest.json', JSON.stringify(merged, null, 2));
  "
fi

echo "== Загрузка на VPS =="
rsync -avz "$STAGE"/*.apk "$STAGE"/*.exe "$STAGE/latest.json" "$SSH_TARGET:$UPLOAD_DIR/" 2>/dev/null || true
# Явно копируем latest.json (rsync с glob'ом молча пропускает если APK не собирали).
scp "$STAGE/latest.json" "$SSH_TARGET:$UPLOAD_DIR/latest.json"
ssh "$SSH_TARGET" "chown -R www-data:www-data $UPLOAD_DIR"

echo "== OK. latest.json: =="
cat "$STAGE/latest.json"
