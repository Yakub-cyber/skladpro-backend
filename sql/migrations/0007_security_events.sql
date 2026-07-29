-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0007 — журнал security-событий.                                          ║
-- ║ Пишем все чувствительные попытки: login (ok/fail), password change/reset,║
-- ║ refresh reuse (детекция кражи), pin change/verify, api-ключи, webhook   ║
-- ║ delivery fail. Отдельная таблица — чтобы не смешивать с бизнес-audit'ом  ║
-- ║ (в котором действия пользователя, а не системы) и чтобы можно было      ║
-- ║ дольше держать (compliance, аудит инцидентов).                          ║
-- ║                                                                          ║
-- ║ Cross-tenant: `company_id` nullable — не все события привязаны к компании║
-- ║ (например, login_fail до аутентификации). Индексы отдельные.             ║
-- ║                                                                          ║
-- ║ TTL — deletes старше 90д запускаются cron'ом (delete...). Партиции не   ║
-- ║ вводим на старте: 90д × ~10к событий/день ~= 900к строк, index-only     ║
-- ║ проходят без проблем. Если объём вырастет — переходим на partitioned    ║
-- ║ by month (см. TODO в комменте ниже).                                     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists security_events (
  id           bigserial primary key,
  company_id   uuid references companies(id) on delete set null,
  user_id      uuid references users(id) on delete set null,
  event        text not null,
  ip           inet,
  user_agent   text,
  meta         jsonb,
  at           timestamptz not null default now()
);

-- Быстрый лукап по событию за период (админский UI).
create index if not exists security_events_at_idx on security_events (at desc);
create index if not exists security_events_event_at_idx on security_events (event, at desc);
create index if not exists security_events_user_at_idx on security_events (user_id, at desc) where user_id is not null;
create index if not exists security_events_company_at_idx on security_events (company_id, at desc) where company_id is not null;

-- Функция ретеншена: удаляет события старше 90 дней. Кладите в cron
-- (`0 3 * * * psql ... -c "select prune_security_events()"`).
-- TODO(v0.3): при >5M строк — партиционировать by month и dropать
-- партиции целиком (быстрее чем DELETE).
create or replace function prune_security_events(older_than_days int default 90)
returns bigint language plpgsql as $$
declare
  deleted bigint;
begin
  delete from security_events where at < now() - make_interval(days => older_than_days);
  get diagnostics deleted = row_count;
  return deleted;
end $$;
