# SkladPro Backend

Самостоятельный бэкенд экосистемы SkladPro: собственная аутентификация, PostgreSQL, offline-синхронизация и складская бизнес-логика. Без Supabase и внешних сервисов. Архитектура — [ARCHITECTURE.md](ARCHITECTURE.md), выбор хостинга — [HOSTING.md](HOSTING.md).

Стек: Node 20+ · Fastify 5 · TypeScript · PostgreSQL 15+ · zod · jose · bcryptjs · vitest.

## Быстрый старт (локально)

```bash
npm install
copy .env.example .env      # заполнить DATABASE_URL и JWT_SECRET
npm run migrate             # применить sql/migrations/*
npm run dev                 # http://localhost:8787
```

`JWT_SECRET` сгенерировать: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

Нужен локальный PostgreSQL (Docker на этой машине не живёт): установщик с postgresql.org или portable-бинарники EnterpriseDB.

## Проверка

```bash
npm test          # ~218 юнит-тестов (auth, sync, sales, PIN, push, support, metrics, security-log,
                  # subscription, fiscal, api-keys+webhooks, gdpr+invite-token)
npm run typecheck
node scripts/e2e-smoke.mjs http://localhost:8787   # e2e-проверки против живой БД
```

E2E требует запущенного сервера и настоящего Postgres (`npm run migrate` заранее).

Быстрый сценарий руками:

```bash
# регистрация → токены
curl -X POST localhost:8787/v1/auth/register -H "content-type: application/json" \
  -d '{"email":"a@b.ru","password":"password123","name":"Якуб"}'
# создать компанию (подставить accessToken)
curl -X POST localhost:8787/v1/companies -H "authorization: Bearer <token>" \
  -H "content-type: application/json" -d '{"name":"Моя компания"}'
# продажа
curl -X POST localhost:8787/v1/sales -H "authorization: Bearer <token>" \
  -H "content-type: application/json" -H "idempotency-key: sale-00000001" \
  -d '{"order":{"id":"o-1","items":[{"productId":"p-1","qty":1,"price":100}]}}'
```

## Перенос данных из Supabase

```bash
# в .env добавить SUPABASE_DATABASE_URL (старая БД)
npm run migrate                  # сначала схема новой БД
npm run migrate:from-supabase    # затем данные (идемпотентно)
```

Пароли пользователей переносятся (bcrypt-хэши GoTrue совместимы) — вход старыми паролями работает. PIN сотрудников задать заново через `POST /v1/employees/pin/set`.

## Продакшен (VPS в РФ)

```bash
npm ci && npm run build && npm run migrate
NODE_ENV=production TRUST_PROXY=true node dist/index.js   # за nginx
```

Готовые конфиги в `deploy/`: [systemd-юнит](deploy/skladpro-api.service), [nginx с TLS и rate-limit](deploy/nginx.conf), [ежедневный бэкап на Яндекс.Диск](deploy/backup.sh). Выбор хостинга и цены — [HOSTING.md](HOSTING.md).

**Мониторинг:** `/metrics` в формате Prometheus (закройте basic-auth через `METRICS_USER` / `METRICS_PASS`). Дефолтные Node.js-метрики + `http_requests_total`, `http_request_duration_seconds`, `security_events_total{event}`, `sse_connections_active`. Журнал security-событий пишется в таблицу `security_events` (миграция 0007, TTL 90 дней через `select prune_security_events()` в cron).

## Структура

```
src/
  index.ts             точка входа, graceful shutdown
  app.ts               Fastify: helmet, CORS, rate limit, error handler
  config.ts            конфиг из env (zod)
  db.ts                pg-пул (TLS-режимы) + withTransaction
  migrate.ts           раннер миграций
  plugins/auth.ts      Bearer JWT → пользователь → компания/роль (X-Company-Id)
  lib/
    tokens.ts          access-JWT + refresh (sha256-хэши, ротация)
    passwords.ts       bcrypt
    idempotency.ts     ключи идемпотентности в транзакции операции
    errors.ts          единый формат ошибок
  routes/
    auth.ts            register / login / refresh (ротация+детекция кражи) / logout
    companies.ts       компании, приглашения, membership
    sync.ts            pull (keyset + tombstones) / push (whitelist) / settings
    sales.ts           продажа: FOR UPDATE, серверные суммы, идемпотентность
    documents.ts       приход / списание / инвентаризация, FIFO-партии
    orders.ts          переходы статусов, списание на отгрузке
    returns.ts         возвраты (полные/частичные, без задвоений)
    pin.ts             PIN сотрудников (bcrypt)
    health.ts          health / me
sql/migrations/        0001_init.sql — полная схема
scripts/               migrate-from-supabase.ts — разовый перенос данных
deploy/                systemd, nginx, backup.sh
```
