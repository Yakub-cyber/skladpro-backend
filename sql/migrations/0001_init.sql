-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0001 — полная схема SkladPro (self-hosted, без Supabase).                 ║
-- ║ Применяется раннером: npm run migrate.                                    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── Аутентификация ──────────────────────────────────────────────────────────

create table users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  password_hash  text not null,
  name           text,
  active         boolean not null default true,
  -- true после импорта из Supabase, если хэш пароля не удалось перенести
  must_reset     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index users_email_unique on users (lower(email));

create table refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  -- сам токен не храним — только sha256; кража дампа БД не даёт сессий
  token_hash  text not null unique,
  family      uuid not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  user_agent  text,
  ip          text
);
create index refresh_tokens_user on refresh_tokens (user_id);
create index refresh_tokens_family on refresh_tokens (family);

-- ── Мультитенантность ───────────────────────────────────────────────────────

create table companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  plan        text not null default 'free',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table memberships (
  user_id     uuid not null references users(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  role        text not null default 'stock',  -- admin | manager | stock | courier
  name        text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  primary key (user_id, company_id)
);
create index memberships_company on memberships (company_id);

create table invitations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  email       text not null,
  role        text not null default 'stock',
  name        text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index invitations_email on invitations (lower(email));
create index invitations_company on invitations (company_id);

-- ── Служебные ───────────────────────────────────────────────────────────────

create table idempotency_keys (
  key         text primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  endpoint    text not null,
  status      int,
  response    jsonb,
  created_at  timestamptz not null default now()
);
create index idempotency_keys_created on idempotency_keys (created_at);

-- ── Данные компаний ─────────────────────────────────────────────────────────
-- id — текстовые, генерируются клиентами (offline-first), поэтому PK составной:
-- (company_id, id). Это же закрывает коллизии коротких id ('p1') между компаниями.
-- deleted_at — tombstone для синхронизации удалений на офлайн-клиенты.

create table price_types (
  company_id  uuid not null references companies(id) on delete cascade,
  id          text not null,
  name        text not null,
  color       text,
  is_default  boolean default false,
  sort        int default 0,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (company_id, id)
);

create table warehouses (
  company_id  uuid not null references companies(id) on delete cascade,
  id          text not null,
  name        text not null,
  address     text,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (company_id, id)
);

create table cells (
  company_id    uuid not null references companies(id) on delete cascade,
  id            text not null,
  warehouse_id  text,
  code          text,
  zone          text,
  x             int,
  y             int,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (company_id, id)
);

create table products (
  company_id    uuid not null references companies(id) on delete cascade,
  id            text not null,
  sku           text,
  name          text not null,
  category      text,
  unit          text default 'шт',
  price         numeric not null default 0 check (price >= 0),
  cost          numeric not null default 0 check (cost >= 0),
  stock         numeric not null default 0 check (stock >= 0),
  min_stock     numeric default 0,
  cell          text,
  warehouse_id  text,
  tags          jsonb default '[]'::jsonb,
  barcode       text,
  weighted      boolean default false,
  plu           int,
  marked        boolean default false,
  vat           text,
  image         text,
  codes         jsonb default '[]'::jsonb,
  prices        jsonb default '{}'::jsonb,
  batches       jsonb default '[]'::jsonb,  -- FIFO-партии [{id, qty, cost, at}]
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (company_id, id)
);
create index products_barcode on products (company_id, barcode);
create index products_sku on products (company_id, sku);

create table customers (
  company_id    uuid not null references companies(id) on delete cascade,
  id            text not null,
  name          text not null,
  type          text,
  city          text,
  contact       text,
  phone         text,
  email         text,
  total_spent   numeric default 0,
  bonus         numeric default 0,
  since         timestamptz default now(),
  price_type_id text,
  balance       numeric default 0,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (company_id, id)
);

create table suppliers (
  company_id  uuid not null references companies(id) on delete cascade,
  id          text not null,
  name        text not null,
  category    text,
  phone       text,
  city        text,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (company_id, id)
);

create table employees (
  company_id  uuid not null references companies(id) on delete cascade,
  id          text not null,
  name        text not null,
  role        text default 'stock',
  phone       text,
  pin_hash    text,          -- bcrypt; открытых PIN в этой схеме нет вообще
  active      boolean default true,
  user_id     uuid references users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (company_id, id)
);

create table orders (
  company_id     uuid not null references companies(id) on delete cascade,
  id             text not null,
  no             text,
  customer_id    text,
  customer_name  text,
  items          jsonb not null default '[]'::jsonb,
  subtotal       numeric not null default 0,
  discount       numeric not null default 0,
  total          numeric not null default 0,
  price_type_id  text,
  on_credit      boolean default false,
  status         text not null default 'new',
  stock_consumed boolean not null default false,
  returned       boolean not null default false,
  returns        jsonb not null default '[]'::jsonb,  -- [{at, by, items:[{productId, qty}]}]
  priority       boolean default false,
  courier        text,
  assigned_to    text,
  address        text,
  shift_id       text,
  track          jsonb default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  primary key (company_id, id)
);
create index orders_status on orders (company_id, status);
create index orders_created on orders (company_id, created_at desc);

create table invoices (
  company_id     uuid not null references companies(id) on delete cascade,
  id             text not null,
  no             text,
  kind           text,
  party          text,
  party_id       text,
  items          jsonb default '[]'::jsonb,
  total          numeric default 0,
  price_type_id  text,
  source         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  primary key (company_id, id)
);

create table documents (
  company_id       uuid not null references companies(id) on delete cascade,
  id               text not null,
  no               text,
  type             text,             -- receive | writeoff | adjust | …
  status           text default 'posted',
  items            jsonb default '[]'::jsonb,
  to_warehouse_id  text,
  reason           text,
  note             text,
  total_qty        numeric default 0,
  "by"             text,
  created_at       timestamptz not null default now(),
  posted_at        timestamptz,
  cancelled_at     timestamptz,
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  primary key (company_id, id)
);

create table movements (
  company_id  uuid not null references companies(id) on delete cascade,
  id          text not null,
  type        text,
  product_id  text,
  name        text,
  qty         numeric,
  delta       numeric,
  cost        numeric,
  reason      text,
  "by"        text,
  at          timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (company_id, id)
);
create index movements_at on movements (company_id, at desc);
create index movements_product on movements (company_id, product_id);

create table shifts (
  company_id    uuid not null references companies(id) on delete cascade,
  id            text not null,
  user_id       text,
  opened_at     timestamptz,
  closed_at     timestamptz,
  opening_cash  numeric default 0,
  closing_cash  numeric default 0,
  revenue       numeric default 0,
  orders_count  int default 0,
  moves_count   int default 0,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (company_id, id)
);

create table audit (
  company_id  uuid not null references companies(id) on delete cascade,
  id          text not null,
  at          timestamptz not null default now(),
  "by"        text,
  title       text,
  section     text,
  type        text,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (company_id, id)
);
create index audit_at on audit (company_id, at desc);

create table settings (
  company_id  uuid primary key references companies(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ── updated_at: сервер — единственный источник времени ─────────────────────
-- Триггер гарантирует монотонность даже если код забыл проставить.

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'users','companies','price_types','warehouses','cells','products',
    'customers','suppliers','employees','orders','invoices','documents',
    'movements','shifts','audit','settings'
  ]
  loop
    execute format('create trigger %I_touch before update on %I
                    for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;

-- Индексы для инкрементальной синхронизации (pull по updated_at).
do $$
declare t text;
begin
  foreach t in array array[
    'price_types','warehouses','cells','products','customers','suppliers',
    'employees','orders','invoices','documents','movements','shifts','audit'
  ]
  loop
    execute format('create index %I_sync on %I (company_id, updated_at, id)', t, t);
  end loop;
end $$;
