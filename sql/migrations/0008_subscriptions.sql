-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0008 — подписки (SaaS billing).                                          ║
-- ║ Ранее план (`companies.plan`) был неструктурированным полем и жил только ║
-- ║ на клиенте (`skladpro/src/lib/subscription.js`). Юзер стирал localStorage║
-- ║ → триал возобновлялся с нуля + лимиты обходились. Теперь сервер — ║
-- ║ источник истины: план, trial-окно, срок оплаты хранятся в БД.           ║
-- ║                                                                          ║
-- ║ План (строкой в `subscriptions.plan`): trial | free | start | business |║
-- ║ pro. Значения совпадают с ключами PLAN_LIMITS на клиенте, чтобы UI не  ║
-- ║ переводил идентификаторы.                                              ║
-- ║                                                                          ║
-- ║ Статус (`status`): trial | active | past_due | canceled.               ║
-- ║   - trial: активная 14-дневная проба (до trial_ends_at).                ║
-- ║   - active: платящий клиент (paid_until в будущем).                    ║
-- ║   - past_due: истёк paid_until, платёж не пришёл. Клиент читает данные, ║
-- ║     но лимиты пересчитываются на free.                                  ║
-- ║   - canceled: отмена (данные помечены, но не удалены).                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

create table if not exists subscriptions (
  company_id       uuid primary key references companies(id) on delete cascade,
  plan             text not null default 'trial',
  status           text not null default 'trial',
  trial_started_at timestamptz not null default now(),
  trial_ends_at    timestamptz not null default (now() + interval '14 days'),
  paid_until       timestamptz,
  -- ЮKassa customer/subscription id для последующих рекуррент-платежей.
  external_customer_id  text,
  external_subscription_id text,
  updated_at       timestamptz not null default now(),
  row_version      bigint not null default nextval('row_version_seq')
);

create trigger subscriptions_set_row_version
  before insert or update on subscriptions
  for each row execute function set_row_version();

create index if not exists subscriptions_paid_until_idx on subscriptions (paid_until) where paid_until is not null;
create index if not exists subscriptions_status_idx on subscriptions (status);

-- История платежей: audit + защита от дубль-обработки webhook'а по event_id.
-- Deduplication ключ - external_id (payment_id из ЮKassa), unique.
create table if not exists subscription_payments (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  external_id       text not null,
  external_provider text not null default 'yookassa',
  amount            numeric(12,2) not null,
  currency          text not null default 'RUB',
  plan              text not null,
  period_months     int not null default 1,
  status            text not null,       -- succeeded | pending | canceled | refunded
  metadata          jsonb,
  created_at        timestamptz not null default now()
);
create unique index if not exists subscription_payments_external_idx
  on subscription_payments (external_provider, external_id);
create index if not exists subscription_payments_company_idx
  on subscription_payments (company_id, created_at desc);

-- Backfill: у существующих компаний создаём trial с 14-дневным окном,
-- чтобы никто не залочился на первом же запросе после миграции.
insert into subscriptions (company_id, plan, status, trial_started_at, trial_ends_at)
select id, 'trial', 'trial', now(), now() + interval '14 days'
from companies
on conflict (company_id) do nothing;

-- Автосоздание строки subscription при создании компании.
create or replace function ensure_subscription_on_company_insert()
returns trigger language plpgsql as $$
begin
  insert into subscriptions (company_id) values (new.id)
  on conflict (company_id) do nothing;
  return new;
end $$;

drop trigger if exists companies_ensure_subscription on companies;
create trigger companies_ensure_subscription
  after insert on companies
  for each row execute function ensure_subscription_on_company_insert();
