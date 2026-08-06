-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0013 — учётное ядро: остатки, взаиморасчёты и деньги как РЕЕСТРЫ.        ║
-- ║                                                                          ║
-- ║ До этой миграции остаток был полем products.stock, которое меняли        ║
-- ║ восемь мест в четырёх роутах. Теперь остаток — это СУММА ДВИЖЕНИЙ.       ║
-- ║ Движения пишет ровно одна функция: post_doc(). Больше никто.             ║
-- ║                                                                          ║
-- ║ products.stock и customers.balance СОХРАНЯЮТСЯ как зеркало — их пишет    ║
-- ║ post_doc(), чтобы существующий фронт продолжал работать без изменений.   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── 1. Единицы измерения и упаковки ────────────────────────────────────────
-- «Упаковка = 12 шт». Без этого невозможен ни опт, ни AI-разбор заказов.
-- Всё внутри учёта хранится в БАЗОВОЙ единице; factor копируется в строку
-- документа, чтобы пересчёт задним числом не переписал историю.

create table product_units (
  company_id  uuid not null references companies(id) on delete cascade,
  id          text not null,
  product_id  text not null,
  name        text not null,                       -- 'шт', 'упак', 'коробка'
  factor      numeric not null default 1 check (factor > 0),
  is_base     boolean not null default false,      -- ровно одна на товар, factor=1
  barcode     text,
  sort        int default 0,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (company_id, id)
);
create index product_units_product on product_units (company_id, product_id);
create unique index product_units_base on product_units (company_id, product_id)
  where is_base and deleted_at is null;

-- ── 2. Счета денег ─────────────────────────────────────────────────────────
-- Их не было вообще. Приём оплаты двигал долг клиента, но деньги никуда
-- не приходили — вопрос «сколько в кассе» не имел ответа.

create table money_accounts (
  company_id  uuid not null references companies(id) on delete cascade,
  id          text not null,
  name        text not null,
  kind        text not null default 'cash' check (kind in ('cash','bank','card')),
  is_default  boolean not null default false,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (company_id, id)
);

-- ── 3. Документ — единая точка входа в учёт ────────────────────────────────
-- Одна таблица на 14 типов вместо таблицы на тип. Плюсы: одна функция
-- проведения, один журнал, одна форма на фронте. Минус: часть колонок
-- не применима к части типов — контролируется чеками ниже.
--
-- Старые `documents` и `orders` НЕ трогаются. `orders` остаётся заказом
-- (workflow, курьер, статусы), а факт отгрузки становится docs.sales_shipment
-- со ссылкой order_id. Заказ ≠ накладная — это разные сущности.

create table docs (
  company_id        uuid not null references companies(id) on delete cascade,
  id                text not null,
  no                text,
  doc_type          text not null check (doc_type in (
    'purchase_receipt',   -- приход от поставщика:  товар +, долг поставщику +
    'sales_shipment',     -- продажа / отгрузка:    товар −, долг клиента +
    'retail_receipt',     -- розничный чек:         товар −, деньги +
    'sales_return',       -- возврат от клиента:    товар +, долг клиента −
    'purchase_return',    -- возврат поставщику:    товар −, долг поставщику −
    'stock_income',       -- оприходование:         товар +
    'writeoff',           -- списание:              товар −
    'inventory',          -- инвентаризация:        товар ±
    'transfer',           -- перемещение:           товар − со склада, + на склад
    'payment_in',         -- приход денег:          деньги +, долг клиента −
    'payment_out',        -- расход денег:          деньги −, долг поставщику −
    'money_transfer',     -- перевод денег:         деньги − со счёта, + на счёт
    'opening_stock',      -- ввод начальных остатков товара
    'opening_settlement'  -- ввод начальных взаиморасчётов
  )),
  status            text not null default 'draft' check (status in ('draft','posted')),
  doc_date          timestamptz not null default now(),

  warehouse_id      text,       -- склад-источник (или единственный)
  warehouse_to_id   text,       -- склад-приёмник, только для transfer

  party_kind        text check (party_kind in ('customer','supplier')),
  party_id          text,       -- id в customers или suppliers

  account_id        text,       -- счёт денег (или счёт-источник)
  account_to_id     text,       -- счёт-приёмник, только для money_transfer

  price_type_id     text,       -- ценовая категория, по которой набирали
  order_id          text,       -- ссылка на orders, если отгрузка по заказу

  amount            numeric not null default 0,   -- итог, считает сервер
  discount          numeric not null default 0,

  note              text,
  reason            text,
  source_payload    text,       -- исходный текст заказа для AI-разбора
  "by"              text,

  posted_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  primary key (company_id, id)
);
create index docs_type_date on docs (company_id, doc_type, doc_date desc);
create index docs_party     on docs (company_id, party_kind, party_id, doc_date desc);
create index docs_order     on docs (company_id, order_id);

-- ── 4. Строки документа ────────────────────────────────────────────────────
-- Отдельная таблица, НЕ jsonb: по строкам нужны join'ы, агрегаты и индексы
-- («сколько всего колы 0.5 продали за месяц» — это group by product_id).
-- qty всегда в БАЗОВОЙ единице; qty_input/unit_id — что реально ввёл человек.

create table doc_lines (
  company_id   uuid not null references companies(id) on delete cascade,
  id           text not null,
  doc_id       text not null,
  line_no      int  not null default 0,
  product_id   text not null,
  unit_id      text,
  unit_factor  numeric not null default 1 check (unit_factor > 0),
  qty_input    numeric not null default 0,   -- 20 (упаковок)
  qty          numeric not null default 0,   -- 240 (штук) = qty_input * factor
  price        numeric not null default 0,   -- за БАЗОВУЮ единицу
  amount       numeric not null default 0,   -- qty * price
  cost_amount  numeric,                      -- себестоимость строки, ставит post_doc
  note         text,
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (company_id, id)
);
create index doc_lines_doc     on doc_lines (company_id, doc_id, line_no);
create index doc_lines_product on doc_lines (company_id, product_id);

-- ── 5. РЕЕСТРЫ. Источник истины. ───────────────────────────────────────────
-- Пишутся только из post_doc()/unpost_doc(). Никогда из роутов напрямую.
-- qty/amount со знаком: приход +, расход −. Остаток = sum().

create table stock_movements (
  company_id   uuid not null references companies(id) on delete cascade,
  id           text not null,
  doc_id       text not null,
  doc_type     text not null,
  at           timestamptz not null default now(),
  warehouse_id text not null,
  product_id   text not null,
  qty          numeric not null,             -- знаковое, базовая единица
  cost_amount  numeric not null default 0,   -- знаковая себестоимость
  updated_at   timestamptz not null default now(),
  primary key (company_id, id)
);
create index stock_mov_prod on stock_movements (company_id, product_id, at desc);
create index stock_mov_wh   on stock_movements (company_id, warehouse_id, product_id);
create index stock_mov_doc  on stock_movements (company_id, doc_id);

create table settlement_movements (
  company_id  uuid not null references companies(id) on delete cascade,
  id          text not null,
  doc_id      text not null,
  doc_type    text not null,
  at          timestamptz not null default now(),
  party_kind  text not null check (party_kind in ('customer','supplier')),
  party_id    text not null,
  -- Знак: + контрагент должен нам, − мы должны контрагенту.
  amount      numeric not null,
  updated_at  timestamptz not null default now(),
  primary key (company_id, id)
);
create index settle_mov_party on settlement_movements (company_id, party_kind, party_id, at desc);
create index settle_mov_doc   on settlement_movements (company_id, doc_id);

create table money_movements (
  company_id  uuid not null references companies(id) on delete cascade,
  id          text not null,
  doc_id      text not null,
  doc_type    text not null,
  at          timestamptz not null default now(),
  account_id  text not null,
  amount      numeric not null,              -- знаковое
  updated_at  timestamptz not null default now(),
  primary key (company_id, id)
);
create index money_mov_acc on money_movements (company_id, account_id, at desc);
create index money_mov_doc on money_movements (company_id, doc_id);

-- ── 6. Кэш остатков ────────────────────────────────────────────────────────
-- Это НЕ истина, а пересчитываемая проекция реестра: считать sum() по
-- миллиону движений на каждой продаже нельзя. Строка блокируется при
-- проведении — две кассы не продадут последнюю штуку одновременно.
-- Себестоимость — средневзвешенная, по складу.

create table stock_balances (
  company_id   uuid not null references companies(id) on delete cascade,
  warehouse_id text not null,
  product_id   text not null,
  qty          numeric not null default 0,
  cost_amount  numeric not null default 0,   -- стоимость всего остатка
  updated_at   timestamptz not null default now(),
  primary key (company_id, warehouse_id, product_id),
  constraint stock_balances_non_negative check (qty >= -0.0000001)
);

-- ── 7. Алиасы товаров под клиента ──────────────────────────────────────────
-- «кола полторашка» → конкретный SKU у конкретного клиента. Накапливается
-- при разборе заказов и со временем становится главным барьером входа.

create table product_aliases (
  company_id  uuid not null references companies(id) on delete cascade,
  id          text not null,
  product_id  text not null,
  unit_id     text,
  alias       text not null,
  party_kind  text check (party_kind in ('customer','supplier')),
  party_id    text,           -- null = алиас общий для компании
  hits        int not null default 1,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (company_id, id)
);
create index product_aliases_lookup on product_aliases (company_id, lower(alias));

-- ── 8. Нумерация документов ────────────────────────────────────────────────

create table doc_counters (
  company_id  uuid not null references companies(id) on delete cascade,
  doc_type    text not null,
  last_no     bigint not null default 0,
  primary key (company_id, doc_type)
);

-- ── 9. row_version для синка (как в 0002) ──────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'product_units','money_accounts','docs','doc_lines','stock_movements',
    'settlement_movements','money_movements','stock_balances','product_aliases'
  ]
  loop
    execute format('alter table %I add column row_version bigint not null default nextval(''row_version_seq'')', t);
    execute format('create trigger %I_rv before insert or update on %I
                    for each row execute function set_row_version()', t, t);
    execute format('create index %I_sync on %I (company_id, row_version)', t, t);
  end loop;
end $$;
