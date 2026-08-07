-- retail_return: розничный возврат (без контрагента).
--
-- Продажа: sales_shipment (опт, с контрагентом) / retail_receipt (розница).
-- Возврат: sales_return   (опт, с контрагентом) / retail_return (розница).
--
-- retail_return: товар на склад (+stock), деньги из кассы (-money),
-- взаиморасчёты не затрагиваются (settle_sign = 0).
-- Без этого розничный возврат через /v1/returns падал с P0006 (MISSING_PARTY),
-- потому что sales_return требует контрагента.

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
  if d.status = 'void' then
    raise exception 'Документ % аннулирован, повторное проведение запрещено', p_doc using errcode = 'P0004';
  end if;

  case d.doc_type
    when 'purchase_receipt'   then sign_stock :=  1; settle_sign := -1;
    when 'sales_shipment'     then sign_stock := -1; settle_sign :=  1;
    when 'retail_receipt'     then sign_stock := -1; money_sign  :=  1;
    when 'sales_return'       then sign_stock :=  1; settle_sign := -1;
    when 'retail_return'      then sign_stock :=  1; money_sign  := -1;
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
