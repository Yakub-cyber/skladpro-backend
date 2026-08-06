-- 0022: маркер серверного пути на заказе.
--
-- shipment_doc_id — id документа отгрузки (docs.id), связанного с заказом.
-- Ставится сервером в /v1/sales (sale-<id>) и в /v1/orders/:id/status
-- при переходе в shipped (ship-<id>). Клиент читает его через pull и по
-- нему понимает: «этот заказ ушёл серверным путём» — отмена должна идти
-- через /v1/orders/:id/status (unpost_doc), а не через sync/push.
--
-- Раньше маркер жил только в localStorage клиента: свежая вкладка тянула
-- заказы с сервера и теряла его — отмена молча уходила старой дорогой.
-- Маркер, который не переживает pull, — не маркер.

alter table orders add column if not exists shipment_doc_id text;

-- Бэкфилл: заказы, у которых уже есть проведённый документ отгрузки.
update orders o
   set shipment_doc_id = d.id
  from docs d
 where d.company_id = o.company_id
   and d.order_id = o.id
   and d.doc_type in ('retail_receipt', 'sales_shipment')
   and o.shipment_doc_id is null;
