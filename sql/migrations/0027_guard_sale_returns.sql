-- Guard linked sale cancellation / return posting at the PostgreSQL boundary.
-- Definitions only: no historical data, table or column changes.
-- Order: order tuple fence -> original sale -> return document -> existing ledgers.
-- Unlinked standalone documents retain their previous accounting behavior.

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
  initial_order_id text;
  initial_type text;
  source_order orders%rowtype;
  source_sale docs%rowtype;

begin
  perform set_config('app.ledger', '1', true);

  -- Read identity without a document lock. Every linked operation locks the
  -- order before any document/balance lock, then revalidates that identity.
  select * into d from docs
   where company_id = p_company and id = p_doc;
  if not found then
    raise exception 'Документ % не найден', p_doc using errcode = 'P0002';
  end if;
  initial_order_id := d.order_id;
  initial_type := d.doc_type;

  if d.order_id is not null and d.doc_type in
       ('retail_receipt','sales_shipment','retail_return','sales_return') then
    -- A tuple write is also a serialization fence for REPEATABLE READ /
    -- SERIALIZABLE snapshots. A plain FOR UPDATE alone leaves stale snapshots
    -- able to miss a newly committed return. Business values remain unchanged;
    -- the ordinary orders row-version trigger runs only on successful commits.
    update orders set id = id
     where company_id = p_company and id = initial_order_id
     returning * into source_order;
    if initial_type in ('retail_return','sales_return') then
      if not found or source_order.deleted_at is not null or source_order.status = 'cancelled' then
        raise exception 'Исходная продажа недоступна для возврата' using errcode = 'P0011';
      end if;
      begin
        select s.* into strict source_sale from docs s
         where s.company_id = p_company and s.order_id = initial_order_id
           and s.doc_type in ('retail_receipt','sales_shipment')
           and s.status = 'posted' and s.deleted_at is null
           and (source_order.shipment_doc_id is null or s.id = source_order.shipment_doc_id)
         for share;
      exception when no_data_found or too_many_rows then
        raise exception 'Исходная продажа не проведена или связь неоднозначна' using errcode = 'P0011';
      end;
    end if;
    -- Initial sale creation can precede INSERT orders in the same transaction.
  end if;

  select * into d from docs
   where company_id = p_company and id = p_doc and deleted_at is null
   for update;
  if not found then
    raise exception 'Документ % не найден', p_doc using errcode = 'P0002';
  end if;
  if d.order_id is distinct from initial_order_id or d.doc_type is distinct from initial_type then
    raise exception 'Связь документа с исходной продажей изменилась; повторите запрос' using errcode = 'P0011';
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

create or replace function unpost_doc(p_company uuid, p_doc text)
returns void language plpgsql as $$
declare
  d docs%rowtype;
  m record;
  initial_order_id text;
  initial_type text;
  source_order orders%rowtype;

begin
  perform set_config('app.ledger', '1', true);

  -- Read identity without a document lock. Every linked operation locks the
  -- order before any document/balance lock, then revalidates that identity.
  select * into d from docs
   where company_id = p_company and id = p_doc;
  if not found then
    raise exception 'Документ % не найден', p_doc using errcode = 'P0002';
  end if;
  initial_order_id := d.order_id;
  initial_type := d.doc_type;

  if d.order_id is not null and d.doc_type in
       ('retail_receipt','sales_shipment','retail_return','sales_return') then
    -- A tuple write is also a serialization fence for REPEATABLE READ /
    -- SERIALIZABLE snapshots. A plain FOR UPDATE alone leaves stale snapshots
    -- able to miss a newly committed return. Business values remain unchanged;
    -- the ordinary orders row-version trigger runs only on successful commits.
    update orders set id = id
     where company_id = p_company and id = initial_order_id
     returning * into source_order;
    if not found then
      raise exception 'Не найден исходный заказ продажи' using errcode = 'P0011';
    end if;
  end if;

  select * into d from docs
   where company_id = p_company and id = p_doc for update;
  if not found then
    raise exception 'Документ % не найден', p_doc using errcode = 'P0002';
  end if;
  if d.order_id is distinct from initial_order_id or d.doc_type is distinct from initial_type then
    raise exception 'Связь документа с исходной продажей изменилась; повторите запрос' using errcode = 'P0011';
  end if;
  if d.status <> 'posted' then
    raise exception 'Документ % не проведён', p_doc using errcode = 'P0008';
  end if;

  if d.doc_type in ('retail_receipt','sales_shipment') and d.order_id is not null and exists (
    select 1 from docs r
     where r.company_id = p_company and r.order_id = d.order_id
       and r.doc_type in ('retail_return','sales_return')
       and (r.status = 'posted'
         or exists (select 1 from stock_movements stock_return where stock_return.company_id = p_company and stock_return.doc_id = r.id)
         or exists (select 1 from money_movements money_return where money_return.company_id = p_company and money_return.doc_id = r.id)
         or exists (select 1 from settlement_movements settlement_return where settlement_return.company_id = p_company and settlement_return.doc_id = r.id))
  ) then
    -- Do not ignore a posted return merely because it was soft-deleted.
    raise exception 'Продажа имеет проведённые возвраты; отмена запрещена' using errcode = 'P0010';
  end if;

  for m in
    select * from stock_movements
     where company_id = p_company and doc_id = p_doc
     order by qty asc
  loop
    perform apply_stock(p_company, m.warehouse_id, m.product_id, -m.qty,
                        case when m.qty < 0 then -m.cost_amount else null end,
                        true);
    perform sync_product_mirror(p_company, m.product_id);
  end loop;

  delete from stock_movements where company_id = p_company and doc_id = p_doc;
  delete from money_movements where company_id = p_company and doc_id = p_doc;
  delete from settlement_movements where company_id = p_company and doc_id = p_doc;

  if d.party_id is not null then
    perform sync_party_mirror(p_company, d.party_kind, d.party_id);
  end if;

  update docs set status = 'draft', posted_at = null
   where company_id = p_company and id = p_doc;
end $$;
