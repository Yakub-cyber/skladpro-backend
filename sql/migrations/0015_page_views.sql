-- Feature usage tracking: записываем какие страницы посещают пользователи.
CREATE TABLE page_views (
  id         bigserial    PRIMARY KEY,
  company_id uuid         REFERENCES companies(id) ON DELETE CASCADE,
  user_id    uuid         REFERENCES users(id) ON DELETE SET NULL,
  page       text         NOT NULL,
  at         timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX page_views_at_idx         ON page_views (at DESC);
CREATE INDEX page_views_page_at_idx    ON page_views (page, at DESC);
CREATE INDEX page_views_company_at_idx ON page_views (company_id, at DESC);

CREATE OR REPLACE FUNCTION prune_page_views(older_than_days int DEFAULT 90)
RETURNS void
LANGUAGE sql
AS $$ DELETE FROM page_views WHERE at < now() - make_interval(days => older_than_days); $$;
