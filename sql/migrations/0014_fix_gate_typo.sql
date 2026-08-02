-- Исправление опечатки «В разарботке» → «В разработке» во всех gate-сообщениях.
-- Опечатка могла быть введена через админ-панель и хранится в JSONB-значении
-- ключа 'site' таблицы platform_config.
UPDATE platform_config
SET value = REPLACE(value::text, 'В разарботке', 'В разработке')::jsonb,
    updated_at = now()
WHERE key = 'site'
  AND value::text LIKE '%В разарботке%';
