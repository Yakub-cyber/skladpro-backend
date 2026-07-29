-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0006 — супер-админ платформы.                                             ║
-- ║ Владелец SaaS видит агрегаты по всем компаниям (без доступа к их данным). ║
-- ║ Активация: update users set is_super_admin = true where email = '…';      ║
-- ║ Отдельного UI-эндпоинта для назначения нет — только SQL, чтобы супер-      ║
-- ║ права нельзя было получить/выдать через API.                             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

alter table users
  add column if not exists is_super_admin boolean not null default false;

-- Partial index — почти всегда пустой, нужен только для быстрой выборки «все
-- супер-админы» в /v1/admin/users фильтре. Обычные запросы users не задевает.
create index if not exists users_super_admin_idx
  on users(id) where is_super_admin;
