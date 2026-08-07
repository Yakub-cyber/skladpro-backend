-- Добавляет retail_return в CHECK constraint таблицы docs.
-- Миграция 0025 добавила retail_return в post_doc(), но не обновила
-- CHECK на таблице — INSERT падал с docs_doc_type_check.

alter table docs drop constraint if exists docs_doc_type_check;
alter table docs add constraint docs_doc_type_check check (doc_type in (
  'purchase_receipt',
  'sales_shipment',
  'retail_receipt',
  'sales_return',
  'retail_return',
  'purchase_return',
  'stock_income',
  'writeoff',
  'inventory',
  'transfer',
  'payment_in',
  'payment_out',
  'money_transfer',
  'opening_stock',
  'opening_settlement'
));
