-- Настройки платформы (ключ-значение). Используется супер-админом
-- для управления публичными параметрами: видимость блока скачивания и пр.
CREATE TABLE IF NOT EXISTS platform_config (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO platform_config (key, value)
VALUES ('site', '{"showDownloads": false}')
ON CONFLICT (key) DO NOTHING;
