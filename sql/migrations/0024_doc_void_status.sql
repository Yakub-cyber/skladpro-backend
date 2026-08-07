-- Добавляет статус 'void' для документов, распроведённых при отмене заказа.
-- 'draft' = ещё не проведён, можно провести.
-- 'void'  = был проведён, затем аннулирован вместе с заказом; повторное проведение запрещено.
-- Без этого распроведённые документы отменённых заказов видны как черновики
-- и могут быть повторно проведены, создавая рассогласование с cancelled-заказом.

alter table docs drop constraint if exists docs_status_check;
alter table docs add constraint docs_status_check
  check (status in ('draft', 'posted', 'void'));

-- Ретроспективно: все docs, привязанные к cancelled заказам, помечаем void.
update docs d
set status = 'void'
from orders o
where d.company_id = o.company_id
  and d.order_id = o.id
  and o.status = 'cancelled'
  and d.status = 'draft';
