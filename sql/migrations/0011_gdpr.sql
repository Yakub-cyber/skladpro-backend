-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0011 — GDPR / 152-ФЗ: экспорт и удаление аккаунта (B5).                  ║
-- ║ Раньше не было ни того, ни другого — нарушает 152-ФЗ (право пользователя ║
-- ║ забрать свои данные и потребовать удаления). Теперь:                    ║
-- ║   - POST /v1/account/export создаёт export_jobs (async, JSON-дамп);      ║
-- ║   - POST /v1/account/delete помечает компанию deleted_at (grace 30 дн);  ║
-- ║   - POST /v1/account/delete/cancel — отмена в grace-окне;                ║
-- ║   - воркер prune раз в сутки стирает компании старше grace физически.  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Задача экспорта. Воркер соберёт JSON, сохранит в payload jsonb.
-- Клиент качает по download_token (не JWT — токен одноразовый, простой).
create table if not exists export_jobs (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  user_id        uuid not null references users(id) on delete set null,
  status         text not null default 'pending',  -- pending | ready | failed
  download_token text unique,                       -- 32-байтный base64url
  payload        jsonb,                             -- собранный дамп (пока нет S3)
  size_bytes     bigint,
  error          text,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  expires_at     timestamptz  -- token invalid после этой даты (по-умолчанию +48ч)
);

create index if not exists export_jobs_pending_idx on export_jobs (status, created_at) where status = 'pending';
create index if not exists export_jobs_company_idx on export_jobs (company_id, created_at desc);

-- Компании — soft-delete уже есть на бумаге, но не в UI. companies.deleted_at
-- уже поле стало полем через 0002 (см. схему) — если нет, добавляем.
alter table companies add column if not exists deleted_at timestamptz;
create index if not exists companies_deleted_idx on companies (deleted_at) where deleted_at is not null;

-- Отмена удаления в grace-окне. Функция pending_delete → cancel:
create or replace function prune_deleted_companies(grace_days int default 30)
returns bigint language plpgsql as $$
declare deleted bigint;
begin
  delete from companies
  where deleted_at is not null and deleted_at < now() - make_interval(days => grace_days);
  get diagnostics deleted = row_count;
  return deleted;
end $$;

-- Ретеншен export_jobs: держим 7 дней, потом удаляем (данные уже отданы).
create or replace function prune_export_jobs()
returns bigint language plpgsql as $$
declare deleted bigint;
begin
  delete from export_jobs where created_at < now() - interval '7 days';
  get diagnostics deleted = row_count;
  return deleted;
end $$;
