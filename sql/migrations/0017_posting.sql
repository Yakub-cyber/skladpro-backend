-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0014 — движок проведения. ЕДИНСТВЕННОЕ место, которое пишет реестры.     ║
-- ║                                                                          ║
-- ║ Роуты после этой миграции не считают ничего: вставили docs + doc_lines,  ║
-- ║ вызвали post_doc() — всё. Вся арифметика здесь, в одном экземпляре.      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Долг поставщика: зеркальная колонка, как customers.balance.
alter table suppliers add column if not exists balance numeric not null default 0;

-- ── Нумерация ──────────────────────────────────────────────────────────────

create or replace function next_doc_no(p_company uuid, p_type text)
returns text language plpgsql as $$
declare v bigint;
begin
  insert into doc_counters (company_id, doc_type, last_no)
  values (p_company, p_type, 1)
  on conflict (company_id, doc_type)
    do update set last_no = doc_counters.last_no + 1
  returning last_no into v;
  return v::text;
end $$;

-- ── Ядро остатка ───────────────────────────────────────────────────────────
-- Блокирует строку баланса, проверяет минус, двигает количество и стоимость.
-- Возвращает ЗНАКОВУЮ себестоимость движения.
--   p_qty  > 0 — приход, p_cost = стоимость прихода (обязательна).
--   p_qty  < 0 — расход, себестоимость считается по средней на складе.

create or replace function apply_stock(
  p_company uuid, p_wh text, p_prod text, p_qty numeric, p_cost numeric
) returns numeric language plpgsql as $$
declare
  cur_qty  numeric;
  cur_cost numeric;
  delta    numeric;
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

  if p_qty < 0 and cur_qty + p_qty < -0.0000001 then
    raise exception 'Недостаточно товара %: остаток %, требуется %',
      p_prod, cur_qty, abs(p_qty) using errcode = 'P0001';
  end if;

  if p_qty >= 0 then
    delta := round(coalesce(p_cost, 0), 4);
  else
    -- Средневзвешенная себестоимость склада на момент расхода.
    delta := case when cur_qty > 0
                  then round(p_qty * (cur_cost / cur_qty), 4)
                  else 0 end;
  end if;

  update stock_balances
     set qty         = round(cur_qty + p_qty, 4),
         cost_amount = greatest(round(cur_cost + delta, 4), 0)
   where company_id = p_company and warehouse_id = p_wh and product_id = p_prod;

  return delta;
end $$;

-- ── Зеркала для старого фронта ─────────────────────────────────────────────
-- products.stock/cost и customers.balance/suppliers.balance больше НЕ пишутся
-- прикладным кодом. Их пересчитывает post_doc из реестров.

create or replace function sync_product_mirror(p_company uuid, p_prod text)
returns void language sql as $$
  update products p set
    stock = coalesce(b.qty, 0),
    cost  = case when coalesce(b.qty, 0) > 0
                 then round(b.cost_amount / b.qty, 4) else p.cost end
  from (select sum(qty) qty, sum(cost_amount) cost_amount
          from stock_balances
         where company_id = p_company and product_id = p_prod) b
  where p.company_id = p_company and p.id = p_prod;
$$;

create or replace function sync_party_mirror(p_company uuid, p_kind text, p_party text)
returns void language plpgsql as $$
declare v numeric;
begin
  select coalesce(sum(amount), 0) into v
    from settlement_movements
   where company_id = p_company and party_kind = p_kind and party_id = p_party;

  if p_kind = 'customer' then
    update customers set balance = v where company_id = p_company and id = p_party;
  else
    -- У поставщика долг наш: храним модуль «сколько мы должны».
    update suppliers set balance = -v where company_id = p_company and id = p_party;
  end if;
end $$;

-- ── ПРОВЕДЕНИЕ ─────────────────────────────────────────────────────────────

create or replace function post_doc(p_company uuid, p_doc text)
returns numeric language plpgsql as $$
declare
  d            docs%rowtype;
  l            record;
  sign_stock   int    := 0;    -- направление товара: +1 приход, −1 расход
  settle_sign  int    := 0;    -- знак взаиморасчётов
  money_sign   int    := 0;
  total        numeric := 0;
  cost_delta   numeric;
  cur_qty      numeric;
  avg_cost     numeric;
  delta_qty    numeric;
begin
  perform set_config('app.ledger', '1', true);   -- разрешаем запись зеркал

  select * into d from docs
   where company_id = p_company and id = p_doc and deleted_at is null
   for update;
  if not found then
    raise exception 'Документ % не найден', p_doc using errcode = 'P0002';
  end if;
  if d.status = 'posted' then
    raise exception 'Документ % уже проведён', p_doc using errcode = 'P0003';
  end if;

  -- Направления по типу документа. Единственное место, где они заданы.
  case d.doc_type
    when 'purchase_receipt'   then sign_stock :=  1; settle_sign := -1;
    when 'sales_shipment'     then sign_stock := -1; settle_sign :=  1;
    when 'retail_receipt'     then sign_stock := -1; money_sign  :=  1;
    when 'sales_return'       then sign_stock :=  1; settle_sign := -1;
    when 'purchase_return'    then sign_stock := -1; settle_sign :=  1;
    when 'stock_income'       then sign_stock :=  1;
    when 'opening_stock'      then sign_stock :=  1;
    when 'writeoff'           then sign_stock := -1;
    when 'inventory'          then sign_stock :=  0;   -- дельта считается ниже
    when 'transfer'           then sign_stock :=  0;   -- два движения на строку
    when 'payment_in'         then settle_sign := -1; money_sign :=  1;
    when 'payment_out'        then settle_sign :=  1; money_sign := -1;
    when 'money_transfer'     then money_sign  :=  0;
    when 'opening_settlement' then settle_sign :=  1;
    else raise exception 'Неизвестный тип документа %', d.doc_type using errcode = 'P0004';
  end case;

  if d.no is null then
    update docs set no = next_doc_no(p_company, d.doc_type)
     where company_id = p_company and id = p_doc;
  end if;

  -- ── Товарная часть ──────────────────────────────────────────────────────
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
      -- qty в строке — НОВЫЙ фактический остаток, а не дельта.
      select coalesce(qty, 0), case when coalesce(qty,0) > 0 then cost_amount / qty else 0 end
        into cur_qty, avg_cost
        from stock_balances
       where company_id = p_company and warehouse_id = d.warehouse_id and product_id = l.product_id;
      delta_qty := round(l.qty - coalesce(cur_qty, 0), 4);
      if abs(delta_qty) < 0.0000001 then continue; end if;

      -- Излишек приходуем по цене из строки, а если её нет — по средней склада.
      cost_delta := apply_stock(p_company, d.warehouse_id, l.product_id, delta_qty,
                                case when delta_qty > 0
                                     then delta_qty * (case when l.price > 0 then l.price else coalesce(avg_cost, 0) end)
                                     else null end);

      insert into stock_movements (company_id, id, doc_id, doc_type, at, warehouse_id, product_id, qty, cost_amount)
      values (p_company, l.id, p_doc, d.doc_type, d.doc_date, d.warehouse_id, l.product_id, delta_qty, cost_delta);

    elsif sign_stock <> 0 then
      cost_delta := apply_stock(p_company, d.warehouse_id, l.product_id, sign_stock * l.qty,
                                case when sign_stock > 0
                                     then coalesce(l.cost_amount, l.qty * l.price) else null end);

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

  -- Для денежных документов сумма приходит в самом документе, а не из строк.
  if d.doc_type in ('payment_in','payment_out','money_transfer','opening_settlement') then
    total := d.amount;
  else
    total := round(total - coalesce(d.discount, 0), 2);
  end if;

  -- ── Взаиморасчёты ───────────────────────────────────────────────────────
  if settle_sign <> 0 and total <> 0 then
    if d.party_id is null or d.party_kind is null then
      raise exception 'Документ %: не указан контрагент', p_doc using errcode = 'P0006';
    end if;
    insert into settlement_movements (company_id, id, doc_id, doc_type, at, party_kind, party_id, amount)
    values (p_company, p_doc || ':settle', p_doc, d.doc_type, d.doc_date, d.party_kind, d.party_id, settle_sign * total);
    perform sync_party_mirror(p_company, d.party_kind, d.party_id);
  end if;

  -- ── Деньги ──────────────────────────────────────────────────────────────
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

-- ── РАСПРОВЕДЕНИЕ ──────────────────────────────────────────────────────────
-- Откатывает ровно те движения, что записал post_doc. Если товар уже ушёл
-- дальше — операция честно падает, а не уводит остаток в минус.

create or replace function unpost_doc(p_company uuid, p_doc text)
returns void language plpgsql as $$
declare
  d docs%rowtype;
  m record;
begin
  perform set_config('app.ledger', '1', true);

  select * into d from docs
   where company_id = p_company and id = p_doc for update;
  if not found then
    raise exception 'Документ % не найден', p_doc using errcode = 'P0002';
  end if;
  if d.status <> 'posted' then
    raise exception 'Документ % не проведён', p_doc using errcode = 'P0008';
  end if;

  for m in
    select * from stock_movements
     where company_id = p_company and doc_id = p_doc
     order by qty asc          -- сначала возвращаем приходы, потом снимаем расходы
  loop
    perform apply_stock(p_company, m.warehouse_id, m.product_id, -m.qty,
                        case when m.qty < 0 then -m.cost_amount else null end);
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

-- ── Витрины для отчётов и фронта ───────────────────────────────────────────

create or replace view v_stock_available as
  select b.company_id, b.warehouse_id, b.product_id,
         p.name as product_name, p.sku, w.name as warehouse_name,
         b.qty,
         case when b.qty > 0 then round(b.cost_amount / b.qty, 4) else 0 end as avg_cost,
         b.cost_amount
    from stock_balances b
    join products p on p.company_id = b.company_id and p.id = b.product_id
    left join warehouses w on w.company_id = b.company_id and w.id = b.warehouse_id
   where p.deleted_at is null;

create or replace view v_party_balance as
  select company_id, party_kind, party_id,
         sum(amount) as balance,          -- + нам должны, − мы должны
         max(at)     as last_operation_at
    from settlement_movements
   group by company_id, party_kind, party_id;

create or replace view v_money_balance as
  select m.company_id, m.account_id, a.name as account_name, a.kind,
         sum(m.amount) as balance
    from money_movements m
    left join money_accounts a on a.company_id = m.company_id and a.id = m.account_id
   group by m.company_id, m.account_id, a.name, a.kind;

-- ── Защёлка от возврата к старому поведению ────────────────────────────────
-- Ставится ПОСЛЕ переписывания роутов: запрещает менять products.stock
-- и балансы контрагентов чем-либо, кроме post_doc/unpost_doc.
-- Включение:  select install_ledger_guard();

create or replace function ledger_guard()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('app.ledger', true), '') <> '1' then
    if tg_table_name = 'products' and (new.stock is distinct from old.stock) then
      raise exception 'products.stock пишет только post_doc()' using errcode = 'P0009';
    end if;
    if tg_table_name = 'customers' and (new.balance is distinct from old.balance) then
      raise exception 'customers.balance пишет только post_doc()' using errcode = 'P0009';
    end if;
    if tg_table_name = 'suppliers' and (new.balance is distinct from old.balance) then
      raise exception 'suppliers.balance пишет только post_doc()' using errcode = 'P0009';
    end if;
  end if;
  return new;
end $$;

create or replace function install_ledger_guard() returns void language plpgsql as $$
begin
  execute 'create trigger products_ledger_guard  before update on products  for each row execute function ledger_guard()';
  execute 'create trigger customers_ledger_guard before update on customers for each row execute function ledger_guard()';
  execute 'create trigger suppliers_ledger_guard before update on suppliers for each row execute function ledger_guard()';
end $$;
