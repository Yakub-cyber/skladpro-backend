-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0010 — публичный REST API + исходящие webhooks (B4).                     ║
-- ║ До этого в веб-клиенте была секция «API-ключи и Webhooks» (D3), но      ║
-- ║ эндпоинтов /v1/api-keys и /v1/webhooks на сервере не было. Ключи        ║
-- ║ создавались локально, webhook'и никогда не срабатывали. Теперь модель  ║
-- ║ живёт в БД, а `publishEvent` из бизнес-эндпоинтов enqueue'ит доставки  ║
-- ║ подписанным endpoint'ам с exp-backoff и HMAC-подписью payload'а.       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- API-ключи. Секрет храним как sha256(secret) — plain секрет пользователь
-- увидит один раз при создании. prefix = первые 8 символов для UI-подсказки
-- «которым ключом пришли». scopes массив — 'products:read', 'orders:write',
-- 'customers:write', 'admin' — при валидации проверяем includes.
create table if not exists api_keys (
  company_id    uuid not null references companies(id) on delete cascade,
  id            uuid not null default gen_random_uuid(),
  name          text not null,
  prefix        text not null,
  hash          text not null,  -- sha256(full secret), hex
  scopes        text[] not null default '{}',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  primary key (company_id, id)
);

-- prefix уникален глобально, чтобы плагин auth.ts мог lookup по prefix
-- без company-id (запрос приходит без X-Company-Id, компания выясняется
-- из ключа).
create unique index if not exists api_keys_prefix_unique on api_keys (prefix);
create index if not exists api_keys_hash_idx on api_keys (hash) where revoked_at is null;

-- Webhook-endpoint'ы, подписанные на события компании.
-- events — массив: 'sale.created' | 'order.status_changed' | 'return.created'
-- | 'payment.created' | 'fiscal.ready' и т.д.
create table if not exists webhook_endpoints (
  company_id        uuid not null references companies(id) on delete cascade,
  id                uuid not null default gen_random_uuid(),
  name              text not null,
  url               text not null,
  secret            text not null,  -- 32-байтная случайная строка (base64url), plain — не секрет: используется для HMAC
  events            text[] not null default '{}',
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  last_delivery_at  timestamptz,
  primary key (company_id, id)
);

create index if not exists webhook_endpoints_company_idx on webhook_endpoints (company_id, active);

-- Очередь доставок. Один event → N записей (по числу подписанных endpoint'ов).
-- Воркер выбирает `next_retry_at <= now()` и `delivered_at is null`.
create table if not exists webhook_deliveries (
  id            bigserial primary key,
  company_id    uuid not null references companies(id) on delete cascade,
  endpoint_id   uuid not null,
  event         text not null,
  payload       jsonb not null,
  attempts      int not null default 0,
  next_retry_at timestamptz not null default now(),
  last_status   int,
  last_error    text,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz
);

-- Воркер: `where delivered_at is null and next_retry_at <= now()`.
create index if not exists webhook_deliveries_pending_idx
  on webhook_deliveries (next_retry_at) where delivered_at is null;
create index if not exists webhook_deliveries_endpoint_idx
  on webhook_deliveries (company_id, endpoint_id, created_at desc);

-- Ретеншен: успешные >= 7 дней и отменённые >= 30 дней стираются в cron.
create or replace function prune_webhook_deliveries()
returns bigint language plpgsql as $$
declare deleted bigint;
begin
  delete from webhook_deliveries
  where (delivered_at is not null and delivered_at < now() - interval '7 days')
     or (delivered_at is null and attempts >= 7 and created_at < now() - interval '30 days');
  get diagnostics deleted = row_count;
  return deleted;
end $$;
