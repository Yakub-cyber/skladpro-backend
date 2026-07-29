-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0003 — токены сброса пароля.                                              ║
-- ║ Храним только sha256-хэш; сам токен уходит в email одним письмом.          ║
-- ║ TTL 1 час, cleanup — сам сервер по расписанию + при попытке использования.║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table password_reset_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index password_reset_tokens_user on password_reset_tokens (user_id);
create index password_reset_tokens_expires on password_reset_tokens (expires_at);

create or replace function cleanup_password_reset_tokens()
returns int language sql security definer set search_path = public as $$
  with deleted as (
    delete from password_reset_tokens
    where expires_at < now() - interval '7 days' returning 1
  )
  select count(*)::int from deleted;
$$;
