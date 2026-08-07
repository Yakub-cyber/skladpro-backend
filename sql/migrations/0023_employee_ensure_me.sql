-- 0023: Гарантирует, что каждый user привязан к сотруднику через user_id.
--
-- Проблема: клиент при bootstrap искал сотрудника по auth_uid (текстовое
-- поле, которого нет в схеме), не находил, и создавал нового с uid('e').
-- cloudUpsert не пробивался (whitelist), sync/push тоже (auth_uid не
-- в колонках). Итог: дубликаты при каждой загрузке.
--
-- Решение:
-- 1. Создаём уникальный индекс (company_id, user_id) — один user = один employee.
-- 2. Бэкфил: привязываем единственного сотрудника к user, если в компании
--    уже есть ровно один active employee без user_id (типичный случай —
--    первый пользователь, зашедший до этого патча).

-- Уникальный partial-индекс: не более одного employee на user в компании.
-- Partial (user_id is not null): позволяет сотрудникам без привязки (приглашённые,
-- которые ещё не залогинились).
create unique index if not exists employees_company_user_uniq
  on employees (company_id, user_id)
  where user_id is not null and deleted_at is null;

-- Бэкфил: один user, один unbound employee → привязать.
-- Если несколько unbound employees — не трогаем: человек привяжет руками,
-- зная кто есть кто. Привязка случайного сотрудника к аккаунту владельца
-- хуже, чем отсутствие привязки.
with single_user_companies as (
  select m.company_id, m.user_id
  from memberships m
  group by m.company_id, m.user_id
  having count(*) = 1
),
already_bound as (
  select company_id, user_id
  from employees
  where user_id is not null and deleted_at is null
),
eligible as (
  select s.company_id, s.user_id
  from single_user_companies s
  where not exists (
    select 1 from already_bound ab
    where ab.company_id = s.company_id and ab.user_id = s.user_id
  )
),
single_unbound as (
  select e.company_id, min(e.id) as employee_id
  from employees e
  where e.user_id is null
    and e.deleted_at is null
    and e.active
  group by e.company_id
  having count(*) = 1
)
update employees e
set user_id = el.user_id
from eligible el
join single_unbound su on su.company_id = el.company_id
where e.company_id = el.company_id
  and e.id = su.employee_id;
