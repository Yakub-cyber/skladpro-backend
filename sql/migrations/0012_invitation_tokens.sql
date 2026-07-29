-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ 0012 — token'ы для приглашений (B5-2, ex F3-6).                          ║
-- ║ Раньше приглашение принималось только по email-match (auto-join при    ║
-- ║ первой аутентификации). Веб-клиент передавал 4-й аргумент inviteToken  ║
-- ║ в signUp, но сервер этот аргумент не читал. Теперь:                    ║
-- ║  - при create /v1/invitations генерим 32-байтный token и отдаём в GET; ║
-- ║  - /v1/auth/register принимает optional inviteToken → авто-accept,     ║
-- ║    если email совпадает с email в invitation.                         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

alter table invitations add column if not exists token text;
-- Уникальный индекс без NOT NULL: старые записи (без token) не мешают,
-- а новые обязаны иметь unique-token.
create unique index if not exists invitations_token_unique on invitations (token) where token is not null;
