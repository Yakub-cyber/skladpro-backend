# n8n для AI-суппорта SkladPro

Автоматизация обработки жалоб клиентов: n8n получает тикет из [/v1/support/tickets](../../src/routes/support.ts), зовёт Claude, тот создаёт PR в `Yakub-cyber/skladpro`, ты подтверждаешь в Telegram — n8n мержит PR и через PATCH возвращает статус в тикет.

Здесь только инфраструктура. Сам workflow (шаг 4) импортируется в веб-UI n8n.

## Что понадобится

| Что | Где взять |
|---|---|
| VPS (2 vCPU, 2 ГБ RAM, 20 ГБ диск, Ubuntu 22.04) | [Timeweb Cloud](https://timeweb.cloud/services/vds), [Beget](https://beget.com/ru/vps), [Selectel](https://selectel.ru/services/cloud/servers/) — ~400–800 ₽/мес |
| Домен (или поддомен уже существующего) | Ваш регистратор, или DuckDNS/FreeDNS для теста |
| Anthropic API key | [console.anthropic.com](https://console.anthropic.com) → API keys |
| Telegram Bot Token | [@BotFather](https://t.me/BotFather) → `/newbot` |
| Ваш Telegram chat_id | [@userinfobot](https://t.me/userinfobot) |
| GitHub App с правами `contents:write`, `pull_requests:write` на `Yakub-cyber/skladpro` | [github.com/settings/apps](https://github.com/settings/apps) → New GitHub App |

## Установка (10–15 минут после того, как VPS куплен)

### 1. DNS

В панели вашего регистратора создайте A-запись:
```
n8n.example.ru  A  <IP вашего VPS>   TTL 300
```
Подождите 2–5 минут, проверьте: `nslookup n8n.example.ru` должен показать IP VPS. Без этого Let's Encrypt не выдаст сертификат.

### 2. Подключение к VPS

```bash
ssh root@<IP>
```

Установите Docker (одной командой):
```bash
apt update && apt install -y curl && curl -fsSL https://get.docker.com | sh
```

Проверьте: `docker --version` и `docker compose version`.

### 3. Копирование файлов

С локальной машины:
```bash
cd D:/Claude/skladpro-backend/deploy
scp -r n8n root@<IP>:/opt/
```
Файлы окажутся в `/opt/n8n/` на VPS.

### 4. Настройка секретов

На VPS:
```bash
cd /opt/n8n
cp .env.example .env

# Домен
sed -i 's/n8n.example.ru/n8n.вашдомен.ru/' .env

# Сгенерировать пароли (или задать вручную)
sed -i "s|CHANGE_ME_TO_A_STRONG_PASSWORD|$(openssl rand -base64 32)|" .env
sed -i "s|CHANGE_ME_MIN_32_HEX_CHARS_LONG________________|$(openssl rand -hex 32)|" .env

cat .env   # проверьте, что все три значения заполнены
```
И подставьте домен в Caddyfile: сам Caddyfile читает `{$DOMAIN}` — ничего в нём править не надо.

### 5. Запуск

```bash
docker compose up -d
docker compose ps        # все три сервиса — healthy/running
docker compose logs -f n8n     # смотрим на "Editor is now accessible via: https://..."
```

Первый запуск занимает ~1–2 минуты: Caddy получает TLS-сертификат от Let's Encrypt.

### 6. Owner setup

Открой в браузере `https://n8n.вашдомен.ru` — n8n предложит создать первого пользователя (владельца). Заведи email/пароль — это доступ к веб-UI n8n, не к SkladPro.

### 7. (следующий шаг) Добавить credentials в n8n

В UI n8n → Settings → Credentials → Add credential:

1. **Anthropic API** (или HTTP Request с Bearer) — ключ из `console.anthropic.com`
2. **Telegram Bot** — токен от @BotFather
3. **GitHub App** — App ID + Installation ID + Private Key (.pem)
4. **HTTP Header Auth** для callback'а в skladpro-backend — заголовок `X-Signature` подписывается workflow'ом, здесь только `X-Signature-Timestamp` и секрет из `.env` бэкенда

Дальше — импорт workflow (это шаг 4 нашего плана).

## Обновление n8n

```bash
cd /opt/n8n
sed -i 's|n8nio/n8n:1.72.0|n8nio/n8n:НОВАЯ_ВЕРСИЯ|' docker-compose.yml
docker compose pull n8n
docker compose up -d n8n
```

Данные (workflows, credentials, executions) в volumes `n8n-data` и `postgres-data` — переживают обновление и рестарт.

## Бэкап

Минимум: раз в сутки — pg_dump n8n в S3 другого провайдера. Пример скрипта:
```bash
docker compose exec -T postgres pg_dump -U n8n n8n | gzip > /backup/n8n-$(date +%Y%m%d).sql.gz
```
Плюс дублируем volume `caddy-data` (сертификаты — восстановится сам, но с задержкой на новый ACME challenge).

## Диагностика

| Симптом | Что смотреть |
|---|---|
| «сайт не открывается» | `docker compose ps` — все healthy? `docker compose logs caddy` — Let's Encrypt отдал сертификат? DNS правильно указан? |
| «webhook приходит, но не срабатывает» | В UI n8n → Executions — есть ли запуск? Ошибка? |
| «Claude отвечает 429/quota exceeded» | Пополнить баланс в console.anthropic.com; в workflow добавить retry с бэкоффом |
| «Telegram не шлёт» | Проверить `chat_id` — не username, а число; бот добавлен в чат (для группы) |

## Связка с skladpro-backend

Бэкенд шлёт webhook на `https://n8n.вашдомен.ru/webhook/skladpro-support` (URL появится, когда импортируешь workflow). В `.env` бэкенда:
```env
N8N_SUPPORT_WEBHOOK_URL=https://n8n.вашдомен.ru/webhook/skladpro-support
N8N_WEBHOOK_SECRET=<тот же секрет, что ты задашь в n8n Credentials>
```

Секрет **обязан совпадать**: бэкенд его использует для подписи исходящих запросов и для проверки подписи входящих PATCH'ей от n8n.
