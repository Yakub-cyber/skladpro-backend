-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0005 — тикеты клиентской поддержки для AI-цикла авто-фиксов.               ║
-- ║ Клиент из веб-приложения жалуется на баг → тикет сохраняется здесь →      ║
-- ║ бэкенд отправляет webhook в n8n → n8n зовёт Claude → тот открывает PR →   ║
-- ║ n8n через PATCH /v1/support/tickets/:id ставит статус и pr_url обратно.  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table support_tickets (
  company_id   uuid not null references companies(id) on delete cascade,
  id           text not null,
  user_id      uuid not null references users(id) on delete cascade,
  -- Что жалуется клиент: свободный текст (до 2000 символов ограничено на API).
  description  text not null,
  -- Куда клиент был в момент жалобы — hash-роут SPA, https-URL и т.п.
  page_url     text,
  page_title   text,
  user_agent   text,
  -- Роль клиента на момент жалобы (admin/manager/stock/courier) — фиксируем,
  -- чтобы не менялось при последующей смене роли.
  role_snapshot text,
  -- Свободный контекст: последние console-ошибки, версия сборки,
  -- размер вьюпорта, breadcrumb действий, sentry event_id и т.п.
  context      jsonb not null default '{}'::jsonb,
  -- Жизненный цикл тикета:
  --  received  — тикет создан, ждёт n8n
  --  analyzing — n8n подтвердил, что взял в работу, Claude анализирует
  --  pr_open   — PR открыт, ждёт одобрения владельца
  --  merged    — владелец одобрил, PR смержен, деплой на подходе
  --  rejected  — владелец отклонил
  --  failed    — Claude/n8n не смог локализовать проблему
  status       text not null default 'received'
    check (status in ('received','analyzing','pr_open','merged','rejected','failed')),
  -- Заполняются шагами n8n:
  pr_url       text,
  pr_number    int,
  branch_name  text,
  ai_explanation text,   -- человекочитаемое объяснение причины
  ai_file_path text,     -- какой файл трогали
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (company_id, id)
);

-- Списки тикетов конкретного клиента (сортировка по дате) и по компании (для админа).
create index support_tickets_user
  on support_tickets (company_id, user_id, created_at desc);
create index support_tickets_status
  on support_tickets (company_id, status);
-- Для инкрементальной синхронизации / SSE-подписок.
create index support_tickets_sync
  on support_tickets (company_id, updated_at, id);

-- Триггер поддерживает updated_at (общая функция из 0001).
create trigger support_tickets_touch before update on support_tickets
  for each row execute function touch_updated_at();
