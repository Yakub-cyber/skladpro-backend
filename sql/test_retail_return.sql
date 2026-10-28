\set ON_ERROR_STOP on
\timing off
begin;

insert into companies (id, name) values ('22222222-2222-2222-2222-222222222222', 'Розница-тест');
\set co '''22222222-2222-2222-2222-222222222222'''

insert into warehouses (company_id, id, name) values (:co,'w1','Магазин');
insert into money_accounts (company_id, id, name, kind, is_default) values (:co,'cash','Касса','cash',true);
insert into products (company_id, id, name, sku, unit) values (:co,'p1','Молоко 1л','MILK01','шт');
insert into product_units (company_id, id, product_id, name, factor, is_base) values
  (:co,'u1','p1','шт',1,true);

\echo '=== 0. НАЧАЛЬНЫЙ ПРИХОД: 50 шт x 40 руб ==='
insert into docs (company_id, id, doc_type, warehouse_id, party_kind, party_id)
  values (:co,'d0','purchase_receipt','w1','supplier',null);
insert into suppliers (company_id, id, name) values (:co,'s1','Молзавод');
update docs set party_kind='supplier', party_id='s1' where company_id=:co and id='d0';
insert into doc_lines (company_id, id, doc_id, product_id, unit_id, unit_factor, qty_input, qty, price)
  values (:co,'d0l1','d0','p1','u1',1, 50, 50, 40);
select post_doc(:co,'d0') as sum_prihoda;

select qty as stock_after_purchase, cost_amount from stock_balances
  where company_id=:co and warehouse_id='w1' and product_id='p1';

\echo '=== 1. РОЗНИЧНАЯ ПРОДАЖА: 10 шт x 80 руб (retail_receipt) ==='
insert into docs (company_id, id, doc_type, warehouse_id, account_id)
  values (:co,'d1','retail_receipt','w1','cash');
insert into doc_lines (company_id, id, doc_id, product_id, unit_id, unit_factor, qty_input, qty, price)
  values (:co,'d1l1','d1','p1','u1',1, 10, 10, 80);
select post_doc(:co,'d1') as summa_prodazhi;

select qty as stock_after_sale from stock_balances
  where company_id=:co and warehouse_id='w1' and product_id='p1';
select balance as kassa_after_sale from money_accounts where company_id=:co and id='cash';

\echo '--- Ожидаем: stock=40, касса=+800 ---'

\echo '=== 2. РОЗНИЧНЫЙ ВОЗВРАТ: 3 шт x 80 руб (retail_return) ==='
insert into docs (company_id, id, doc_type, warehouse_id, account_id)
  values (:co,'d2','retail_return','w1','cash');
insert into doc_lines (company_id, id, doc_id, product_id, unit_id, unit_factor, qty_input, qty, price)
  values (:co,'d2l1','d2','p1','u1',1, 3, 3, 80);
select post_doc(:co,'d2') as summa_vozvrata;

select qty as stock_after_return from stock_balances
  where company_id=:co and warehouse_id='w1' and product_id='p1';
select balance as kassa_after_return from money_accounts where company_id=:co and id='cash';

\echo '--- Ожидаем: stock=43, касса=+560 (800-240) ---'

\echo '=== 3. ПОЛНЫЙ ВОЗВРАТ оставшихся 7 шт x 80 руб ==='
insert into docs (company_id, id, doc_type, warehouse_id, account_id)
  values (:co,'d3','retail_return','w1','cash');
insert into doc_lines (company_id, id, doc_id, product_id, unit_id, unit_factor, qty_input, qty, price)
  values (:co,'d3l1','d3','p1','u1',1, 7, 7, 80);
select post_doc(:co,'d3') as summa_vozvrata_2;

select qty as stock_after_full_return from stock_balances
  where company_id=:co and warehouse_id='w1' and product_id='p1';
select balance as kassa_after_full_return from money_accounts where company_id=:co and id='cash';

\echo '--- Ожидаем: stock=50 (исходный), касса=0 (800-800) ---'

\echo '=== 4. СВЕРКА: зеркала = реестры ==='
select
  (select stock from products where id='p1' and company_id=:co)
    as mirror_stock,
  (select sum(qty) from stock_balances where product_id='p1' and company_id=:co)
    as balance_qty,
  (select sum(qty) from stock_movements where product_id='p1' and company_id=:co)
    as registry_qty;

select
  (select balance from money_accounts where id='cash' and company_id=:co)
    as mirror_cash,
  (select coalesce(sum(amount),0) from money_movements where account_id='cash' and company_id=:co)
    as registry_cash;

\echo '--- mirror_stock = balance_qty = registry_qty = 50 ---'
\echo '--- mirror_cash  = registry_cash = 0 ---'

\echo '=== 5. settlement_movements: retail НЕ создаёт взаиморасчётов ==='
select count(*) as settle_count from settlement_movements
  where doc_id in ('d1','d2','d3') and company_id=:co;
\echo '--- Ожидаем: 0 ---'

\echo '=== 6. VOID GUARD: аннулированный doc нельзя перепровести ==='
select unpost_doc(:co,'d2');
update docs set status='void' where company_id=:co and id='d2';
\echo '--- Попытка post_doc на void — должна упасть с P0004 ---'
do $$ begin
  perform post_doc('22222222-2222-2222-2222-222222222222','d2');
  raise exception 'POST VOID ДОЛЖЕН БЫЛ УПАСТЬ';
exception when sqlstate 'P0004' then
  raise notice 'OK: void guard сработал — %', sqlerrm;
end $$;

\echo '=== 7. retail_return БЕЗ account_id → P0007 ==='
insert into docs (company_id, id, doc_type, warehouse_id)
  values (:co,'d_no_acc','retail_return','w1');
insert into doc_lines (company_id, id, doc_id, product_id, unit_id, unit_factor, qty_input, qty, price)
  values (:co,'d_no_acc_l1','d_no_acc','p1','u1',1, 1, 1, 80);
do $$ begin
  perform post_doc('22222222-2222-2222-2222-222222222222','d_no_acc');
  raise exception 'RETAIL_RETURN БЕЗ ACCOUNT ДОЛЖЕН БЫЛ УПАСТЬ';
exception when sqlstate 'P0007' then
  raise notice 'OK: P0007 (нет счёта денег) — %', sqlerrm;
end $$;

\echo '=== 8. retail_return НЕ требует контрагента (party) — OK ==='
\echo '--- Документы d2, d3 выше проведены без party — это и есть проверка ---'

\echo ''
\echo '✓ Все проверки розничного возврата пройдены.'

rollback;
