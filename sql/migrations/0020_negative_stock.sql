-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0019 — отрицательный остаток по типу документа.                          ║
-- ║                                                                          ║
-- ║ В опте нормально: товар физически приехал, разгрузили, продали с колёс,  ║
-- ║ а накладную от поставщика оператор проведёт вечером. Между этими         ║
-- ║ моментами остаток честно отрицательный — это сигнал «есть непроведённый  ║
-- ║ приход», а не блокирующая ошибка. Так работают CloudShop, МойСклад, 1С.  ║
-- ║                                                                          ║
-- ║ Разрешено:  sales_shipment, retail_receipt (товар физически ушёл).       ║
-- ║ Запрещено:  transfer, writeoff, purchase_return, sales_return в расходе, ║
-- ║             inventory, opening_stock, unpost_doc (нельзя увезти/списать  ║
-- ║             то, чего нет; распроведение прихода после расхода — ошибка). ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Сносим старую 5-аргументную версию — сигнатура меняется, replace недостаточно.
drop function if exists apply_stock(uuid, text, text, numeric, numeric);

create or replace function apply_stock(
  p_company uuid, p_wh text, p_prod text, p_qty numeric, p_cost numeric,
  p_allow_negative boolean default false
) returns numeric language plpgsql as $$
declare
  cur_qty        numeric;
  cur_cost       numeric;
  last_cost      numeric;
  qty_from_stock numeric;
  qty_below      numeric;
  delta          numeric;
begin
  if p_wh is null then
    raise exception 'Не указан склад для товара %', p_prod using errcode = 'P0001';
  end if;

  insert into stock_balances (company_id, warehouse_id, product_id, qty, cost_amount)
  values (p_company, p_wh, p_prod, 0, 0)
  on conflict (company_id, warehouse_id, product_id) do nothing;

  select qty, cost_amount into cur_qty, cur_cost
  from stock_balances
  where company_id = p_company and warehouse_id = p_wh and product_id = p_prod
  for update;

  -- Проверка минуса — только если её явно не разрешил вызывающий тип документа.
  if not p_allow_negative and p_qty < 0 and cur_qty + p_qty < -0.0000001 then
    raise exception 'Недостаточно товара %: остаток %, требуется %',
      p_prod, cur_qty, abs(p_qty) using errcode = 'P0001';
  end if;

  if p_qty >= 0 then
    delta := round(coalesce(p_cost, 0), 4);
  elsif cur_qty > 0 then
    -- Гибрид: часть расхода снимаем по средневзвешенной остатка склада,
    -- часть, что уходит ниже нуля, — по последней известной products.cost.
    -- Так средняя сохраняется, а приход, закрывающий минус, вернёт её точно.
    qty_from_stock := least(cur_qty, -p_qty);
    qty_below      := (-p_qty) - qty_from_stock;
    if qty_below > 0 then
      select coalesce(cost, 0) into last_cost
        from products where company_id = p_company and id = p_prod;
    else
      last_cost := 0;
    end if;
    delta := round(-(qty_from_stock * (cur_cost / cur_qty) + qty_below * last_cost), 4);
  else
    -- Уже в минусе: FIFO пусто. Вся себестоимость расхода — по last known.
    select coalesce(cost, 0) into last_cost
      from products where company_id = p_company and id = p_prod;
    delta := round(p_qty * last_cost, 4);
  end if;

  -- cost_amount не клэмпится на 0: отрицательное значение — учтённый «долг»
  -- перед непроведённым приходом. Когда приход придёт, разница закроется
  -- и средневзвешенная вернётся к корректной величине.
  update stock_balances
     set qty         = round(cur_qty + p_qty, 4),
         cost_amount = round(cur_cost + delta, 4)
   where company_id = p_company and warehouse_id = p_wh and product_id = p_prod;

  return delta;
end $$;

-- post_doc: пересоздаём с явной передачей p_allow_negative по типу документа.
-- Направления и вся остальная логика — без изменений против 0017.
create or replace function post_doc(p_company uuid, p_doc text)
returns numeric language plpgsql as $$
declare
  d              docs%rowtype;
  l              record;
  sign_stock     int    := 0;
  settle_sign    int    := 0;
  money_sign     int    := 0;
  total          numeric := 0;
  cost_delta     numeric;
  cur_qty        numeric;
  avg_cost       numeric;
  delta_qty      numeric;
  allow_negative boolean;
begin
  perform set_config('app.ledger', '1', true);

  select * into d from docs
   where company_id = p_company and id = p_doc and deleted_at is null
   for update;
  if not found then
    raise exception 'Документ % не найден', p_doc using errcode = 'P0002';
  end if;
  if d.status = 'posted' then
    raise exception 'Документ % уже проведён', p_doc using errcode = 'P0003';
  end if;

  case d.doc_type
    when 'purchase_receipt'   then sign_stock :=  1; settle_sign := -1;
    when 'sales_shipment'     then sign_stock := -1; settle_sign :=  1;
    when 'retail_receipt'     then sign_stock := -1; money_sign  :=  1;
    when 'sales_return'       then sign_stock :=  1; settle_sign := -1;
    when 'purchase_return'    then sign_stock := -1; settle_sign :=  1;
    when 'stock_income'       then sign_stock :=  1;
    when 'opening_stock'      then sign_stock :=  1;
    when 'writeoff'           then sign_stock := -1;
    when 'inventory'          then sign_stock :=  0;
    when 'transfer'           then sign_stock :=  0;
    when 'payment_in'         then settle_sign := -1; money_sign :=  1;
    when 'payment_out'        then settle_sign :=  1; money_sign := -1;
    when 'money_transfer'     then money_sign  :=  0;
    when 'opening_settlement' then settle_sign :=  1;
    else raise exception 'Неизвестный тип документа %', d.doc_type using errcode = 'P0004';
  end case;

  -- Минус на остатке разрешён только там, где товар физически ушёл покупателю,
  -- а приход от поставщика ещё не проведён. Всё остальное требует фактический
  -- товар: перемещение, списание, возврат поставщику, инвентаризация.
  allow_negative := d.doc_type in ('sales_shipment', 'retail_receipt');

  if d.no is null then
    update docs set no = next_doc_no(p_company, d.doc_type)
     where company_id = p_company and id = p_doc;
  end if;

  for l in
    select * from doc_lines
     where company_id = p_company and doc_id = p_doc and deleted_at is null
     order by line_no, id
  loop
    if l.qty <= 0 and d.doc_type <> 'inventory' then
      raise exception 'Строка %: количество должно быть больше нуля', l.id using errcode = 'P0005';
    end if;

    if d.doc_type = 'transfer' then
      cost_delta := apply_stock(p_company, d.warehouse_id,    l.product_id, -l.qty, null);
      perform     apply_stock(p_company, d.warehouse_to_id, l.product_id,  l.qty, -cost_delta);

      insert into stock_movements (company_id, id, doc_id, doc_type, at, warehouse_id, product_id, qty, cost_amount)
      values (p_company, l.id || ':out', p_doc, d.doc_type, d.doc_date, d.warehouse_id,    l.product_id, -l.qty,  cost_delta),
             (p_company, l.id || ':in',  p_doc, d.doc_type, d.doc_date, d.warehouse_to_id, l.product_id,  l.qty, -cost_delta);

    elsif d.doc_type = 'inventory' then
      select coalesce(qty, 0), case when coalesce(qty,0) > 0 then cost_amount / qty else 0 end
        into cur_qty, avg_cost
        from stock_balances
       where company_id = p_company and warehouse_id = d.warehouse_id and product_id = l.product_id;
      delta_qty := round(l.qty - coalesce(cur_qty, 0), 4);
      if abs(delta_qty) < 0.0000001 then continue; end if;

      cost_delta := apply_stock(p_company, d.warehouse_id, l.product_id, delta_qty,
                                case when delta_qty > 0
                                     then delta_qty * (case when l.price > 0 then l.price else coalesce(avg_cost, 0) end)
                                     else null end);

      insert into stock_movements (company_id, id, doc_id, doc_type, at, warehouse_id, product_id, qty, cost_amount)
      values (p_company, l.id, p_doc, d.doc_type, d.doc_date, d.warehouse_id, l.product_id, delta_qty, cost_delta);

    elsif sign_stock <> 0 then
      cost_delta := apply_stock(p_company, d.warehouse_id, l.product_id, sign_stock * l.qty,
                                case when sign_stock > 0
                                     then coalesce(l.cost_amount, l.qty * l.price) else null end,
                                allow_negative);

      insert into stock_movements (company_id, id, doc_id, doc_type, at, warehouse_id, product_id, qty, cost_amount)
      values (p_company, l.id, p_doc, d.doc_type, d.doc_date, d.warehouse_id, l.product_id, sign_stock * l.qty, cost_delta);
    else
      cost_delta := 0;
    end if;

    update doc_lines
       set amount      = round(l.qty * l.price, 2),
           cost_amount = abs(cost_delta)
     where company_id = p_company and id = l.id;

    total := total + round(l.qty * l.price, 2);
    perform sync_product_mirror(p_company, l.product_id);
  end loop;

  if d.doc_type in ('payment_in','payment_out','money_transfer','opening_settlement') then
    total := d.amount;
  else
    total := round(total - coalesce(d.discount, 0), 2);
  end if;

  if settle_sign <> 0 and total <> 0 then
    if d.party_id is null or d.party_kind is null then
      raise exception 'Документ %: не указан контрагент', p_doc using errcode = 'P0006';
    end if;
    insert into settlement_movements (company_id, id, doc_id, doc_type, at, party_kind, party_id, amount)
    values (p_company, p_doc || ':settle', p_doc, d.doc_type, d.doc_date, d.party_kind, d.party_id, settle_sign * total);
    perform sync_party_mirror(p_company, d.party_kind, d.party_id);
  end if;

  if d.doc_type = 'money_transfer' and total <> 0 then
    insert into money_movements (company_id, id, doc_id, doc_type, at, account_id, amount)
    values (p_company, p_doc || ':mout', p_doc, d.doc_type, d.doc_date, d.account_id,    -total),
           (p_company, p_doc || ':min',  p_doc, d.doc_type, d.doc_date, d.account_to_id,  total);
  elsif money_sign <> 0 and total <> 0 then
    if d.account_id is null then
      raise exception 'Документ %: не указан счёт денег', p_doc using errcode = 'P0007';
    end if;
    insert into money_movements (company_id, id, doc_id, doc_type, at, account_id, amount)
    values (p_company, p_doc || ':money', p_doc, d.doc_type, d.doc_date, d.account_id, money_sign * total);
  end if;

  update docs
     set status = 'posted', posted_at = now(), amount = total
   where company_id = p_company and id = p_doc;

  return total;
end $$;
