-- Сверка ядра. Запускать после тестов и на боевой базе по расписанию.
-- Пустой вывод = всё сходится. Любая строка = баг в роуте.

\echo '=== 1. Зеркало products.stock против реестра ==='
select p.company_id, p.id, p.name,
       p.stock                as mirror,
       coalesce(b.qty, 0)     as balance,
       coalesce(m.qty, 0)     as registry
  from products p
  left join (select company_id, product_id, sum(qty) qty
               from stock_balances group by 1,2) b
    on b.company_id = p.company_id and b.product_id = p.id
  left join (select company_id, product_id, sum(qty) qty
               from stock_movements group by 1,2) m
    on m.company_id = p.company_id and m.product_id = p.id
 where p.deleted_at is null
   and (abs(p.stock - coalesce(b.qty,0)) > 0.0001
     or abs(coalesce(b.qty,0) - coalesce(m.qty,0)) > 0.0001);

\echo '=== 2. Зеркало customers.balance против реестра ==='
select c.company_id, c.id, c.name, c.balance as mirror, coalesce(s.amount,0) as registry
  from customers c
  left join (select company_id, party_id, sum(amount) amount
               from settlement_movements where party_kind='customer' group by 1,2) s
    on s.company_id = c.company_id and s.party_id = c.id
 where c.deleted_at is null and abs(c.balance - coalesce(s.amount,0)) > 0.01;

\echo '=== 3. Отрицательные остатки (не должно быть ни одного) ==='
select * from stock_balances where qty < -0.0001;

\echo '=== 4. Проведённые документы без движений (проведение молча не сработало) ==='
select d.company_id, d.id, d.doc_type, d.amount
  from docs d
 where d.status = 'posted'
   and not exists (select 1 from stock_movements      where company_id=d.company_id and doc_id=d.id)
   and not exists (select 1 from settlement_movements where company_id=d.company_id and doc_id=d.id)
   and not exists (select 1 from money_movements      where company_id=d.company_id and doc_id=d.id);

\echo '=== 5. Движения от НЕпроведённых документов (распроведение не почистило) ==='
select m.company_id, m.doc_id, m.doc_type, count(*)
  from stock_movements m
  join docs d on d.company_id=m.company_id and d.id=m.doc_id
 where d.status <> 'posted'
 group by 1,2,3;

\echo '=== 6. ДВОЙНАЯ ОТГРУЗКА: два проведённых документа на один заказ ==='
select company_id, order_id, count(*) as docs, string_agg(id, ', ') as doc_ids
  from docs
 where order_id is not null and status='posted'
   and doc_type in ('sales_shipment','retail_receipt')
 group by 1,2 having count(*) > 1;

\echo '=== 7. Строки с несогласованным пересчётом упаковок ==='
select company_id, id, doc_id, qty_input, unit_factor, qty
  from doc_lines
 where deleted_at is null
   and abs(qty - qty_input * unit_factor) > 0.0001;

\echo '=== 8. Себестоимость больше нуля при нулевом остатке ==='
select * from stock_balances where qty <= 0.0001 and cost_amount > 0.01;
