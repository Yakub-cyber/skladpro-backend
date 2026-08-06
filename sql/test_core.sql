\set ON_ERROR_STOP on
\timing off
begin;

insert into companies (id, name) values ('11111111-1111-1111-1111-111111111111', 'Оптовик');
\set co '''11111111-1111-1111-1111-111111111111'''

insert into warehouses (company_id, id, name) values (:co,'w1','Основной'), (:co,'w2','Газель');
insert into money_accounts (company_id, id, name, kind, is_default) values (:co,'cash','Касса','cash',true);
insert into price_types (company_id, id, name, is_default) values (:co,'pt1','Оптовая',true);
insert into products (company_id, id, name, sku, unit) values (:co,'p1','Кола 0.5','COLA05','шт');
insert into product_units (company_id, id, product_id, name, factor, is_base) values
  (:co,'u1','p1','шт',1,true), (:co,'u2','p1','упак',12,false);
insert into customers (company_id, id, name, price_type_id) values (:co,'c1','Магазин Ромашка','pt1');
insert into suppliers (company_id, id, name) values (:co,'s1','Завод напитков');

\echo '=== 1. ПРИХОД: 10 упак x 12 = 120 шт на 3600 ==='
insert into docs (company_id, id, doc_type, warehouse_id, party_kind, party_id)
  values (:co,'d1','purchase_receipt','w1','supplier','s1');
insert into doc_lines (company_id, id, doc_id, product_id, unit_id, unit_factor, qty_input, qty, price)
  values (:co,'d1l1','d1','p1','u2',12, 10, 120, 30);
select post_doc(:co,'d1') as sum_prihoda;
select warehouse_id, qty, avg_cost from v_stock_available where product_id='p1';
select stock, cost from products where id='p1';
select balance as dolg_postavshiku from suppliers where id='s1';

\echo '=== 2. ПРОДАЖА: 20 шт x 50 ==='
insert into docs (company_id, id, doc_type, warehouse_id, party_kind, party_id, price_type_id)
  values (:co,'d2','sales_shipment','w1','customer','c1','pt1');
insert into doc_lines (company_id, id, doc_id, product_id, unit_id, unit_factor, qty_input, qty, price)
  values (:co,'d2l1','d2','p1','u1',1, 20, 20, 50);
select post_doc(:co,'d2') as summa_prodazhi;
select qty, cost_amount from stock_balances where warehouse_id='w1' and product_id='p1';
select cost_amount as sebestoimost_prodazhi from doc_lines where id='d2l1';
select balance as dolg_klienta from customers where id='c1';

\echo '=== 3. ОПЛАТА 600 ==='
insert into docs (company_id, id, doc_type, party_kind, party_id, account_id, amount)
  values (:co,'d3','payment_in','customer','c1','cash',600);
select post_doc(:co,'d3');
select balance as dolg_klienta from customers where id='c1';
select account_id, balance as v_kasse from v_money_balance;

\echo '=== 4. ПЕРЕМЕЩЕНИЕ 30 шт на Газель ==='
insert into docs (company_id, id, doc_type, warehouse_id, warehouse_to_id)
  values (:co,'d4','transfer','w1','w2');
insert into doc_lines (company_id, id, doc_id, product_id, unit_factor, qty_input, qty, price)
  values (:co,'d4l1','d4','p1',1, 30, 30, 0);
select post_doc(:co,'d4');
select warehouse_id, qty, cost_amount from stock_balances where product_id='p1' order by warehouse_id;
select stock as zerkalo_vsego from products where id='p1';

\echo '=== 5. ИНВЕНТАРИЗАЦИЯ на Основном: по факту 68 (было 70) ==='
insert into docs (company_id, id, doc_type, warehouse_id) values (:co,'d5','inventory','w1');
insert into doc_lines (company_id, id, doc_id, product_id, unit_factor, qty_input, qty, price)
  values (:co,'d5l1','d5','p1',1, 68, 68, 0);
select post_doc(:co,'d5');
select warehouse_id, qty from stock_balances where product_id='p1' order by warehouse_id;
select qty as dvizhenie_inventarizacii from stock_movements where doc_id='d5';

\echo '=== 6. РАСПРОВЕДЕНИЕ продажи ==='
select unpost_doc(:co,'d2');
select warehouse_id, qty from stock_balances where product_id='p1' order by warehouse_id;
select balance as dolg_klienta_posle_otmeny from customers where id='c1';
select status from docs where id='d2';

\echo '=== 7. СВЕРКА: зеркала обязаны совпасть с реестрами ==='
select
  (select stock from products where id='p1')                                   as mirror_stock,
  (select sum(qty) from stock_balances where product_id='p1')                  as balance_qty,
  (select sum(qty) from stock_movements where product_id='p1')                 as registry_qty,
  (select balance from customers where id='c1')                                as mirror_debt,
  (select coalesce(sum(amount),0) from settlement_movements
     where party_kind='customer' and party_id='c1')                            as registry_debt;

\echo '=== 8. Попытка отгрузить 500 при остатке 88 — обязана упасть ==='
insert into docs (company_id, id, doc_type, warehouse_id, party_kind, party_id)
  values (:co,'d9','sales_shipment','w1','customer','c1');
insert into doc_lines (company_id, id, doc_id, product_id, unit_factor, qty_input, qty, price)
  values (:co,'d9l1','d9','p1',1, 500, 500, 50);
select post_doc(:co,'d9');

rollback;
