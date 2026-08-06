-- 0019 — синхронизируемый id для stock_balances.
-- Клиентский merge завязан на колонку id, а у остатков ключ составной.
-- Генерируемая колонка даёт стабильный id без дублирования данных.

alter table stock_balances
  add column id text generated always as (warehouse_id || ':' || product_id) stored;

create index stock_balances_id on stock_balances (company_id, id);
