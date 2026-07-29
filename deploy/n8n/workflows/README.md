# n8n workflows — SkladPro AI-суппорт

Два workflow, работающих в паре:

| Файл | Триггер | Что делает |
|---|---|---|
| [support-intake.json](support-intake.json) | Webhook `POST /webhook/skladpro-support` | Валидирует HMAC → зовёт DeepSeek с tool-use (`read_file`, `submit_fix`) → создаёт ветку `fix/support-<id>` и PR в GitHub → шлёт Telegram-уведомление с кнопками |
| [support-approve.json](support-approve.json) | Telegram callback (нажатие кнопки) | Мержит или закрывает PR → PATCH-ит статус тикета обратно в skladpro-backend → редактирует исходное Telegram-сообщение с итогом |

## Секреты (**Community Edition — через env**, не через n8n Variables!)

n8n Community Edition не даёт вкладку **Settings → Variables** (это платная фича). Вместо этого секреты передаём через переменные окружения ОС и обращаемся к ним из workflow как `$env.NAME`.

Готовый набор файлов — в `D:\n8n-secrets\`:

```
D:\n8n-secrets\
├── .env.example      ← шаблон, коммитить не нужно (папка вне репо)
├── .env              ← реальные секреты (не показывать никому)
├── start-n8n.ps1     ← запускалка: проверяет заполненность и стартует n8n
└── start-n8n.bat     ← то же для cmd
```

## Порядок настройки (один раз)

### 1. Заполнить 3 секрета в `D:\n8n-secrets\.env`

Открой файл в редакторе. Уже заполнены `WEBHOOK_SECRET` (сгенерирован автоматически), `TELEGRAM_CHAT_ID`, `SKLADPRO_REPO`, `SKLADPRO_API_URL`, `DEEPSEEK_BASE_URL`. Остаются три:

| Переменная | Где взять |
|---|---|
| `DEEPSEEK_API_KEY` | [platform.deepseek.com](https://platform.deepseek.com) → API Keys → **Create key** |
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/mybots` → выбрать бота → **API Token** |
| `GITHUB_PAT` | [github.com](https://github.com/settings/tokens?type=beta) → Fine-grained PAT → только на `Yakub-cyber/skladpro`, permissions: `Contents: R&W`, `Pull requests: R&W`, `Metadata: R` |

### 2. Запустить n8n

Двойной клик по `D:\n8n-secrets\start-n8n.bat` **или** в PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File D:\n8n-secrets\start-n8n.ps1
```

Скрипт сам:
- Проверит, что все 4 секрета заполнены (иначе жалуется в консоль и не стартует)
- Установит `dotenv-cli` и `n8n` глобально, если их нет
- Запустит `dotenv -e D:\n8n-secrets\.env -- n8n start`

n8n откроется на `http://localhost:5678`. При первом запуске — попросит создать owner-аккаунт (email/пароль для UI n8n).

### 3. Импорт workflow

В UI n8n:
1. **Workflows** → **Import from File** → выбрать `support-intake.json` из этой папки.
2. То же для `support-approve.json`.
3. Открыть каждый workflow и включить тумблером «Active» вверху справа.

### 4. Привязать Telegram credentials

Отдельно от env: нода `Telegram Trigger` в workflow #2 требует привязанный credential.

1. В UI n8n → аватар внизу слева → **Credentials** → **Add credential** → в поиске «Telegram» → **Telegram API**.
2. В поле **Access Token** — тот же `TELEGRAM_BOT_TOKEN`, что в `.env`. Save.
3. Открыть workflow `SkladPro Support — Approve/Reject` → нода `Telegram Trigger` → выбрать созданный credential. Save.

## Как проверить, что всё работает

1. Убедиться, что бэкенд `skladpro-backend` запущен: `cd D:/Claude/skladpro-backend && npm run dev`. В `.env` уже прописан `N8N_WEBHOOK_SECRET` — тот же, что и `WEBHOOK_SECRET` в n8n .env.
2. Открыть skladpro-web, залогиниться в облачном режиме.
3. Кликнуть плавающую кнопку «спасательный круг» справа внизу → написать тестовый баг («на странице заказов кнопка Создать не срабатывает»).
4. В n8n → **Executions** — должен появиться выполненный запуск `SkladPro Support — Intake` (статус success). Открыть execution — на каждой ноде увидеть данные.
5. В Telegram — прилетает сообщение вида «🛎 Новый тикет SkladPro …» с ссылкой на PR и двумя кнопками.
6. Открыть PR на GitHub, посмотреть diff в коде.
7. Нажать `✅ Одобрить и смержить` → в n8n → **Executions** — должен появиться запуск `SkladPro Support — Approve/Reject`.
8. В веб-UI SkladPro на вкладке «Мои обращения» статус тикета в реальном времени сменяется на «Исправлено» (через SSE).

## Диагностика

| Симптом | Что смотреть |
|---|---|
| «Тикет висит в Принято, executions пусто» | Проверь, что WEBHOOK_SECRET в `D:\n8n-secrets\.env` **буква в букву** совпадает с `N8N_WEBHOOK_SECRET` в `D:\Claude\skladpro-backend\.env`. Затем — доступен ли n8n по `http://localhost:5678/webhook/skladpro-support` (открой в браузере: должен вернуться JSON error, не connection refused) |
| «signature mismatch» в лоchronological | Секреты разъехались, или бэкенд перезапущен без нового .env |
| `$env.X is undefined` в n8n Code node | n8n запущен НЕ через `dotenv -e ... --` — переменные не переданы. Останови n8n и запусти через `start-n8n.ps1` |
| DeepSeek 401 | Ключ невалиден или у аккаунта 0 баланса |
| DeepSeek 429 | Rate limit — либо увеличить delay в цикле, либо повысить лимит на dashboard |
| GitHub 403 при create branch | У PAT нет `Contents: Write` на `Yakub-cyber/skladpro`, или PAT не выбрал этот репо при создании |
| Telegram не шлёт | `TELEGRAM_CHAT_ID` — число (без `@`), бот не заблокирован, бот отправил хотя бы одно сообщение боту (для новых чатов) |
| Кнопки в Telegram не работают | Workflow #2 не активирован; credentials не привязаны к ноде Telegram Trigger; бот параллельно опрашивается другим процессом (только 1 polling на бот!) |
| AI создаёт бессмыслицу | Смени модель в Code node с `deepseek-coder` на `deepseek-chat`, или подкрути `temperature` |

## Обновление workflow после правок JSON в репо

1. В UI n8n открой workflow → **⋯** (три точки вверху справа) → **Delete**.
2. **Workflows** → **Import from File** → выбери обновлённый JSON.
3. Заново привяжи Telegram credentials в ноде Trigger (у workflow #2). Активируй.

Или через **CLI**: `dotenv -e D:\n8n-secrets\.env -- n8n import:workflow --input=D:\Claude\skladpro-backend\deploy\n8n\workflows\support-intake.json` — но проще через UI.

## Ограничения текущей версии

- **Один файл на фикс** — LLM не может тронуть несколько файлов. Для 80% багов норм.
- **Нет CI-гейта перед merge** — approve → сразу merge. Включи `Required status checks` в **Settings → Branches → Branch protection rules** на GitHub, если хочешь блокировать merge при красных тестах.
- **Нет автоматического отката** — регрессия → откатывать `git revert`.
- **Один tool: `read_file`** — нет `grep`. Для skladpro (~150 файлов) хватает, для более крупных репо добавить.
- **Community Edition не имеет мультиплексора env-загрузки в UI** — если хочешь удобнее, upgrade на n8n Enterprise/Cloud или добавь External Secrets (тоже платно).
