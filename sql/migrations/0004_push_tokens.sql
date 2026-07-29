-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0004 — FCM push токены устройств.                                          ║
-- ║ Одна строка на (user_id, token). При замене токена (Firebase перевыдал —   ║
-- ║ обычно после переустановки или сброса кэша Google Play Services) старая   ║
-- ║ запись перезаписывается.                                                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table push_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  token       text not null,
  platform    text not null check (platform in ('android', 'ios', 'web')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- last_error / last_error_at — если FCM вернул INVALID_ARGUMENT или NOT_FOUND,
  -- фиксируем и удаляем при следующей ротации, чтобы не долбить мёртвые токены.
  last_error  text,
  last_error_at timestamptz,
  unique (user_id, token)
);
create index push_tokens_company on push_tokens (company_id);
create index push_tokens_user on push_tokens (user_id);
create index push_tokens_updated on push_tokens (updated_at);

create trigger push_tokens_touch before update on push_tokens
  for each row execute function touch_updated_at();
