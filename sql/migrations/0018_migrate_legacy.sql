-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0015 — разовый перенос существующих данных в реестры.                    ║
-- ║                                                                          ║
-- ║ Текущие products.stock и customers.balance превращаются в документы      ║
-- ║ ввода начальных остатков. После этого они становятся зеркалом, которое   ║
-- ║ пересчитывает post_doc(), и совпадают сами с собой — то есть переход     ║
-- ║ для фронта незаметен.                                                    ║
-- ║ Идемпотентна: повторный запуск ничего не задвоит.                        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

do $$
declare
  c        record;
  wh       text;
  acc      text;
  doc      text;
  p        record;
  cust     record;
  n        int;
begin
  perform set_config('app.ledger', '1', true);

  for c in select id from companies loop

    -- Склад по умолчанию: если складов нет вообще — заводим.
    select id into wh from warehouses
      where company_id = c.id and deleted_at is null order by id limit 1;
    if wh is null then
      wh := 'w-main';
      insert into warehouses (company_id, id, name) values (c.id, wh, 'Основной склад');
    end if;

    -- Счёт денег: их не было в старой схеме вообще.
    select id into acc from money_accounts where company_id = c.id limit 1;
    if acc is null then
      acc := 'acc-cash';
      insert into money_accounts (company_id, id, name, kind, is_default)
      values (c.id, acc, 'Касса', 'cash', true);
    end if;

    -- Базовая единица для товаров, у которых её ещё нет.
    insert into product_units (company_id, id, product_id, name, factor, is_base)
    select c.id, 'u-' || p2.id, p2.id, coalesce(nullif(p2.unit, ''), 'шт'), 1, true
      from products p2
     where p2.company_id = c.id and p2.deleted_at is null
       and not exists (select 1 from product_units u
                        where u.company_id = c.id and u.product_id = p2.id and u.is_base);

    -- ── Начальные остатки товара ─────────────────────────────────────────
    doc := 'opening-stock';
    if not exists (select 1 from docs where company_id = c.id and id = doc) then
      select count(*) into n from products
       where company_id = c.id and deleted_at is null and coalesce(stock, 0) > 0;

      if n > 0 then
        insert into docs (company_id, id, doc_type, status, warehouse_id, note, "by")
        values (c.id, doc, 'opening_stock', 'draft', wh, 'Перенос остатков из старой схемы', 'migration');

        insert into doc_lines (company_id, id, doc_id, product_id, unit_id, unit_factor,
                               qty_input, qty, price, line_no)
        select c.id, 'ol-' || p2.id, doc, p2.id,
               (select u.id from product_units u
                 where u.company_id = c.id and u.product_id = p2.id and u.is_base limit 1),
               1, p2.stock, p2.stock, coalesce(p2.cost, 0),
               row_number() over (order by p2.id)
          from products p2
         where p2.company_id = c.id and p2.deleted_at is null and coalesce(p2.stock, 0) > 0;

        -- Обнуляем зеркало, чтобы проведение выставило его заново из реестра.
        update products set stock = 0 where company_id = c.id and coalesce(stock, 0) > 0;
        perform post_doc(c.id, doc);
      end if;
    end if;

    -- ── Начальные взаиморасчёты по клиентам ──────────────────────────────
    for cust in
      select id, balance from customers
       where company_id = c.id and deleted_at is null and coalesce(balance, 0) <> 0
    loop
      doc := 'opening-settle-' || cust.id;
      if not exists (select 1 from docs where company_id = c.id and id = doc) then
        insert into docs (company_id, id, doc_type, status, party_kind, party_id, amount, note, "by")
        values (c.id, doc, 'opening_settlement', 'draft', 'customer', cust.id,
                cust.balance, 'Перенос долга из старой схемы', 'migration');
        perform post_doc(c.id, doc);
      end if;
    end loop;

  end loop;
end $$;

-- Партии FIFO из products.batches больше не используются: себестоимость
-- считается средневзвешенной по складу. Колонка остаётся до переключения
-- клиентов, но не читается и не пишется.
comment on column products.batches is 'LEGACY: не используется с 0014, себестоимость — средневзвешенная в stock_balances';
comment on column products.stock   is 'ЗЕРКАЛО: пишет только post_doc(). Истина — stock_movements/stock_balances';
comment on column customers.balance is 'ЗЕРКАЛО: пишет только post_doc(). Истина — settlement_movements';
