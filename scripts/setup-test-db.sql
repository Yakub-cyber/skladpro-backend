-- Настройка тестовой базы skladpro_test для интеграционных тестов.
-- Выполнять от суперпользователя postgres:
--   psql -U postgres -f scripts/setup-test-db.sql
--
-- После этого запуск:
--   TEST_DATABASE_URL=postgresql://skladpro_dev:skladpro_dev_pass@localhost:5432/skladpro_test npx vitest run test/integration/

-- 1. Создать базу (если нет)
SELECT 'CREATE DATABASE skladpro_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'skladpro_test')\gexec

-- 2. Создать роль (если нет)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'skladpro_dev') THEN
    CREATE ROLE skladpro_dev LOGIN PASSWORD 'skladpro_dev_pass';
  END IF;
END
$$;

-- 3. Переключиться на тестовую базу
\connect skladpro_test

-- 4. Права на схему
GRANT ALL ON SCHEMA public TO skladpro_dev;

-- 5. Миграции создают таблицы от имени текущего пользователя.
--    Если таблицы уже существуют и принадлежат другому владельцу,
--    передать владение:
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO skladpro_dev', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO skladpro_dev', r.sequencename);
  END LOOP;
  FOR r IN SELECT proname, pg_get_function_identity_arguments(oid) AS args
             FROM pg_proc WHERE pronamespace = 'public'::regnamespace LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO skladpro_dev', r.proname, r.args);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END
$$;

ALTER SCHEMA public OWNER TO skladpro_dev;

-- 6. Дефолтные привилегии для будущих объектов
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO skladpro_dev;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO skladpro_dev;

-- Готово. Проверка:
--   psql -U skladpro_dev -d skladpro_test -c "SELECT current_user, current_database()"
