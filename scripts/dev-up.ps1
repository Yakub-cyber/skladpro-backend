# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ dev-up.ps1 — идемпотентная подготовка локального окружения (Windows).    ║
# ║ Что делает:                                                              ║
# ║  1. Находит psql (PATH или C:\Program Files\PostgreSQL\<ver>\bin).       ║
# ║  2. Создаёт роль skladpro_dev и БД skladpro_dev (если ещё нет).          ║
# ║  3. Ставит расширение pgcrypto (нужно gen_random_uuid()).                ║
# ║  4. Пишет .env в skladpro-backend/ (не трогает существующий).            ║
# ║  5. npm ci + npm run migrate.                                            ║
# ║                                                                          ║
# ║ Запуск (из корня skladpro-backend):                                      ║
# ║   pwsh scripts/dev-up.ps1                                                ║
# ║   pwsh scripts/dev-up.ps1 -DevPassword "mytestpass"   # своя пароль      ║
# ║   pwsh scripts/dev-up.ps1 -Force                     # перезаписать .env  ║
# ╚══════════════════════════════════════════════════════════════════════════╝

[CmdletBinding()]
param(
    # Пароль роли skladpro_dev. Только для localhost и dev — не секрет.
    [string]$DevPassword = "skladpro_dev_pass",
    # Перезаписать существующий .env (по умолчанию скрипт его не трогает).
    [switch]$Force,
    # Пропустить npm ci / migrate (только БД и .env).
    [switch]$SkipMigrate
)

$ErrorActionPreference = "Stop"

# ── 1. Найти psql ─────────────────────────────────────────────────────────
function Find-Psql {
    $cmd = Get-Command psql -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "C:\Program Files\PostgreSQL\17\bin\psql.exe",
        "C:\Program Files\PostgreSQL\16\bin\psql.exe",
        "C:\Program Files\PostgreSQL\15\bin\psql.exe",
        "D:\PostgreSQL\17\bin\psql.exe",
        "D:\PostgreSQL\16\bin\psql.exe",
        "D:\PostgreSQL\15\bin\psql.exe"
    )
    foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
    return $null
}

$psql = Find-Psql
if (-not $psql) {
    Write-Host ""
    Write-Host "❌ psql не найден." -ForegroundColor Red
    Write-Host "Установите PostgreSQL 15+ от EDB: https://www.postgresql.org/download/windows/"
    Write-Host "Инсталлятор автоматически ставит службу и добавляет утилиты в PATH."
    Write-Host "После установки перезапустите этот PowerShell (чтобы PATH обновился) и повторите."
    exit 1
}
Write-Host "psql: $psql" -ForegroundColor DarkGray

# ── 2. Создать роль и БД (через postgres superuser) ───────────────────────
# Скрипт запросит пароль superuser (postgres) один раз — если он не в
# ~/.pgpass. Идемпотентность: DO $$ ... END $$ проверяет через pg_roles.
$sqlBootstrap = @"
DO `$do`$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skladpro_dev') THEN
        CREATE ROLE skladpro_dev LOGIN PASSWORD '$DevPassword';
    ELSE
        ALTER ROLE skladpro_dev WITH PASSWORD '$DevPassword';
    END IF;
END
`$do`$;
"@

$env:PGCLIENTENCODING = "UTF8"

Write-Host "== создаю роль skladpro_dev ==" -ForegroundColor Cyan
$sqlBootstrap | & $psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q
if ($LASTEXITCODE -ne 0) { Write-Host "psql упал на создании роли" -ForegroundColor Red; exit 1 }

# CREATE DATABASE не работает внутри DO-блока (не транзакционно) — делаем отдельно.
Write-Host "== создаю БД skladpro_dev (если ещё нет) ==" -ForegroundColor Cyan
$dbExists = & $psql -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'skladpro_dev'"
if (-not $dbExists) {
    & $psql -U postgres -d postgres -c "CREATE DATABASE skladpro_dev OWNER skladpro_dev"
    if ($LASTEXITCODE -ne 0) { exit 1 }
} else {
    Write-Host "  уже есть" -ForegroundColor DarkGray
}

Write-Host "== ставлю расширение pgcrypto ==" -ForegroundColor Cyan
& $psql -U postgres -d skladpro_dev -c "CREATE EXTENSION IF NOT EXISTS pgcrypto" -q | Out-Null

# ── 3. Написать .env ──────────────────────────────────────────────────────
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$envFile = Join-Path $repoRoot ".env"

if ((Test-Path $envFile) -and -not $Force) {
    Write-Host ""
    Write-Host ".env уже существует — оставляю как есть." -ForegroundColor Yellow
    Write-Host "Перезаписать: pwsh scripts/dev-up.ps1 -Force"
} else {
    # Свежий JWT_SECRET, 48 байт → base64url ≈ 64 символа.
    $bytes = New-Object byte[] 48
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $jwt = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')

    $envContent = @"
# Сгенерировано scripts/dev-up.ps1 — локальный dev-профиль.
PORT=8787
HOST=0.0.0.0
NODE_ENV=development

DATABASE_URL=postgresql://skladpro_dev:$DevPassword@localhost:5432/skladpro_dev
DATABASE_SSL=disable

JWT_SECRET=$jwt
ACCESS_TOKEN_TTL_MIN=15
REFRESH_TOKEN_TTL_DAYS=30

# Веб (5173), админка (5174), любые локальные. На devе пустая = всё разрешено,
# но лучше перечислить явно, чтобы поведение совпадало с production.
CORS_ORIGINS=http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174

RATE_LIMIT_MAX=10000
TRUST_PROXY=false

# APP_URL используется в письме сброса пароля (magic-link).
# В deve SMTP выключен, но URL всё равно нужен.
APP_URL=http://localhost:5173/

# Пусто = без Sentry / SMTP / FCM / AI-суппорта. Для локального smoke это ок.
# Замечание: пустое значение полей с .url() в config.ts валидатор Zod отвергает
# (проверяется url ДО optional). Проще их не задавать — тогда optional() даёт
# undefined без проверки.
SENTRY_DSN=
SMTP_URL=
SMTP_FROM=SkladPro <no-reply@localhost>
"@
    Set-Content -Path $envFile -Value $envContent -Encoding utf8
    Write-Host ".env создан: $envFile" -ForegroundColor Green
}

# ── 4. npm ci + миграции ──────────────────────────────────────────────────
if ($SkipMigrate) {
    Write-Host ""
    Write-Host "Пропускаю npm/migrate по -SkipMigrate." -ForegroundColor Yellow
    exit 0
}

Push-Location $repoRoot
try {
    if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
        Write-Host "== npm ci ==" -ForegroundColor Cyan
        & npm ci
        if ($LASTEXITCODE -ne 0) { exit 1 }
    }

    Write-Host "== миграции 0001-0006 ==" -ForegroundColor Cyan
    & npm run migrate
    if ($LASTEXITCODE -ne 0) { exit 1 }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "✅ Готово." -ForegroundColor Green
Write-Host "  Запустить API:  npm run dev  (в каталоге skladpro-backend)"
Write-Host "  Прогнать e2e:   node scripts/e2e-smoke.mjs http://127.0.0.1:8787"
