-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0002 — ужесточение по итогам code review (12 confirmed findings)         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- 1. Идемпотентность: PK (company_id, key). Убираем cross-tenant DoS и
-- позволяем тем же клиентским ключам жить в разных компаниях.
alter table idempotency_keys drop constraint idempotency_keys_pkey;
alter table idempotency_keys add primary key (company_id, key);
-- endpoint теперь участвует в проверке — индекс для быстрого lookup по нему не нужен.

-- 2. Row-version для sync/pull: bigserial, монотонно увеличивается ПРИ
-- каждом INSERT/UPDATE, снимок присваивается ДО COMMIT — но клиенты
-- получают версию только после видимости строки (см. код sync.ts:
-- курсор строится по max(row_version) UPTO min(pg_xact_commit_timestamp'у)
-- у видимых строк). Простое, без битов xmin.
create sequence row_version_seq;

create or replace function set_row_version()
returns trigger language plpgsql as $$
begin
  new.row_version := nextval('row_version_seq');
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'price_types','warehouses','cells','products','customers','suppliers',
    'employees','orders','invoices','documents','movements','shifts','audit'
  ]
  loop
    -- 1) добавить колонку
    execute format('alter table %I add column row_version bigint', t);
    -- 2) заполнить существующие строки монотонно
    execute format('update %I set row_version = nextval(''row_version_seq'')', t);
    execute format('alter table %I alter column row_version set not null', t);
    -- 3) заменить триггер touch_updated_at на set_row_version (он же ставит updated_at)
    execute format('drop trigger %I_touch on %I', t, t);
    execute format(
      'create trigger %I_rv before insert or update on %I
       for each row execute function set_row_version()', t, t);
    -- 4) индексы синка: keyset по (company_id, row_version, id)
    execute format('drop index if exists %I_sync', t);
    execute format('create index %I_sync on %I (company_id, row_version)', t, t);
    -- 5) DEFAULT — на случай прямой вставки в обход триггера (не наш путь, но всё же)
    execute format('alter table %I alter column row_version set default nextval(''row_version_seq'')', t);
  end loop;
end $$;

-- Users/companies/memberships/settings/refresh_tokens/invitations/idempotency_keys
-- — не участвуют в sync/pull, им row_version не нужен.

-- 3. Восстановить touch_updated_at на users/companies/settings/memberships
-- (их триггер выше не трогает — они через них не идут).
-- (уже стоят из 0001)

-- 4. Проверка активности пользователя на защищённых эндпоинтах:
-- индекс для быстрой проверки в loadMemberships.
create index if not exists users_active_idx on users(id) where active;

-- 5. Уникальность memberships на паре, чтобы limit_companies_per_user
-- работал под конкурентностью (в коде PostgreSQL exclusion constraint
-- по количеству дороже — оставим app-level, но с advisory lock; см. код).

-- 6. TTL для idempotency_keys: 30 дней (в коде хранится cleanup_idempotency_keys).
-- В 0002 функция создаётся заново с composite key.
create or replace function cleanup_idempotency_keys()
returns int language sql security definer set search_path = public as $$
  with deleted as (
    delete from idempotency_keys where created_at < now() - interval '30 days' returning 1
  )
  select count(*)::int from deleted;
$$;

-- 7. numeric приходит клиенту как STRING (node-pg default для NUMERIC).
-- Решается в коде через pg.types.setTypeParser (см. src/db.ts).

-- 8. Схема готова для батч-сессий приглашения: индекс на email + created_at desc
create index if not exists invitations_email_created on invitations (lower(email), created_at desc);
