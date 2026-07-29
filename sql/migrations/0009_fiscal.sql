-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0009 — фискализация 54-ФЗ через АТОЛ Онлайн (и совместимые).             ║
-- ║ До этой миграции POS фискализировал чеки НАПРЯМУЮ с телефона в АТОЛ.    ║
-- ║ Проблемы:                                                                 ║
-- ║   1) Очистка данных приложения → потеря pendingReceipts, при этом чек   ║
-- ║      в ОФД уже пробит (юридически нельзя не иметь).                     ║
-- ║   2) Нельзя пробить чек с другого устройства (закрыть смену).           ║
-- ║   3) Пароль АТОЛ хранится в приложении — если телефон украли, доступ.   ║
-- ║                                                                          ║
-- ║ Теперь: POS отправляет продажу нам, мы вызываем АТОЛ, храним FN/FD/FP  ║
-- ║ на сервере. Пароль ККТ — только в БД, шифрован AES-GCM с ключом из env. ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Конфиг ККТ на компанию. Один провайдер за раз (обычно АТОЛ).
create table if not exists fiscal_configs (
  company_id          uuid primary key references companies(id) on delete cascade,
  provider            text not null default 'atol',
  -- Логин от АТОЛ Онлайн Web API (не путать с логином личного кабинета).
  login               text,
  -- AES-GCM(password) с ключом из FISCAL_KMS_KEY. Формат: base64(iv||ciphertext||tag).
  password_encrypted  bytea,
  -- Идентификатор группы касс АТОЛ.
  group_code          text,
  inn                 text,
  -- Адрес расчётов: сайт или физический адрес торговой точки.
  payment_address     text,
  -- Название организации (для чека).
  organization_name   text,
  -- Система налогообложения: osn | usn_income | usn_income_outcome | envd | esn | patent
  sno                 text default 'usn_income',
  -- Ставка НДС по-умолчанию (для строк, где не задано): none | vat0 | vat10 | vat20 | ...
  default_vat         text default 'none',
  -- Email отправителя чека (для чеков покупателю по email).
  sender_email        text,
  active              boolean not null default true,
  updated_at          timestamptz not null default now(),
  row_version         bigint not null default nextval('row_version_seq')
);

create trigger fiscal_configs_set_row_version
  before insert or update on fiscal_configs
  for each row execute function set_row_version();

-- Чек: одна запись = одна продажа. status:
--   pending    — принят, ещё не отправлен в АТОЛ (в очереди воркера)
--   processing — отправлен, ждём report
--   ready      — успех, есть FN/FD/FP
--   failed     — фатальная ошибка АТОЛ, требует вмешательства (либо retry)
create table if not exists fiscal_receipts (
  company_id       uuid not null references companies(id) on delete cascade,
  id               uuid not null default gen_random_uuid(),
  sale_id          uuid not null,
  provider         text not null default 'atol',
  -- external_id — uuid, который мы даём АТОЛ (external_id in АТОЛ API).
  external_id      text not null,
  -- Реквизиты чека (заполняются после report ready)
  fn               text,   -- заводской номер ФН
  fd               text,   -- фискальный документ (номер)
  fp               text,   -- фискальный признак
  qr               text,   -- QR-код (payload)
  ofd_url          text,   -- Ссылка на чек в ОФД
  status           text not null default 'pending',
  request_body     jsonb not null,
  response_body    jsonb,
  error_code       text,
  error_message    text,
  retries          int not null default 0,
  created_at       timestamptz not null default now(),
  closed_at        timestamptz,
  updated_at       timestamptz not null default now(),
  row_version      bigint not null default nextval('row_version_seq'),
  primary key (company_id, id)
);

create trigger fiscal_receipts_set_row_version
  before insert or update on fiscal_receipts
  for each row execute function set_row_version();

-- Один чек на sale: если POS двоит запрос — уникальный индекс не даст.
create unique index if not exists fiscal_receipts_sale_unique
  on fiscal_receipts (company_id, sale_id);

-- Быстрая очередь воркера: все processing/pending.
create index if not exists fiscal_receipts_processing_idx
  on fiscal_receipts (status, created_at) where status in ('pending', 'processing');
create index if not exists fiscal_receipts_status_idx
  on fiscal_receipts (company_id, status, created_at desc);
