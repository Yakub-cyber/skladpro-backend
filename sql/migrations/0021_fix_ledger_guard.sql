-- 0021 — Исправление ledger_guard(): to_jsonb вместо прямого обращения к полям.
--
-- Проблема: PL/pgSQL резолвит NEW.stock и NEW.balance при компиляции триггера
-- против типа строки таблицы. На products нет balance → компиляция падает.
-- На customers/suppliers нет stock → то же самое. Все три триггера нерабочие.
--
-- Решение: конвертируем OLD/NEW в jsonb и проверяем наличие ключа через `?`.
-- Одна функция работает на всех трёх таблицах без обращения к конкретным полям.

create or replace function ledger_guard()
returns trigger language plpgsql as $$
declare
  old_j jsonb := to_jsonb(OLD);
  new_j jsonb := to_jsonb(NEW);
begin
  if coalesce(current_setting('app.ledger', true), '') = '1' then
    return NEW;
  end if;
  if old_j ? 'stock'
     and (new_j->>'stock') is distinct from (old_j->>'stock') then
    raise exception 'products.stock пишет только post_doc()'
      using errcode = 'P0009';
  end if;
  if old_j ? 'balance'
     and (new_j->>'balance') is distinct from (old_j->>'balance') then
    raise exception '%.balance пишет только post_doc()', tg_table_name
      using errcode = 'P0009';
  end if;
  return NEW;
end $$;

-- install_ledger_guard: без изменений, но пересоздаём для единообразия.
-- Использует IF NOT EXISTS, чтобы не падать при повторном вызове.
create or replace function install_ledger_guard() returns void language plpgsql as $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'products_ledger_guard' and not tgisinternal) then
    execute 'create trigger products_ledger_guard  before update on products  for each row execute function ledger_guard()';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'customers_ledger_guard' and not tgisinternal) then
    execute 'create trigger customers_ledger_guard before update on customers for each row execute function ledger_guard()';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'suppliers_ledger_guard' and not tgisinternal) then
    execute 'create trigger suppliers_ledger_guard before update on suppliers for each row execute function ledger_guard()';
  end if;
end $$;
