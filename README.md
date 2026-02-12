# Task Manager Telegram Bot

Telegram-бот, который превращает голосовые и текстовые сообщения в задачи в Notion.

- Голосовое сообщение → транскрипция (OpenAI Whisper) → парсинг задач (GPT) → создание в Notion
- Текстовое сообщение → парсинг задач (GPT) → создание в Notion

## Что понадобится

1. **VPS/сервер** с публичным IP и доменом (нужен HTTPS для Telegram webhook)
2. **Docker** и **docker-compose**
3. **Telegram Bot Token** — получить у [@BotFather](https://t.me/BotFather)
4. **OpenAI API Key** — [platform.openai.com](https://platform.openai.com/)
5. **Notion Integration Token** и **Database ID**

## Шаг 1. Настройка Notion

1. Зайти на [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration**.
2. Дать имя (например, `Task Bot`), выбрать workspace, скопировать **Internal Integration Secret** (`secret_...`).
3. Создать базу данных (таблицу) в Notion со следующими колонками:

   | Колонка       | Тип        | Значения                      |
   |---------------|------------|-------------------------------|
   | Name          | Title      | —                             |
   | Description   | Text       | —                             |
   | Status        | Select     | `To do`, `In progress`, `Done`|
   | Priority      | Select     | `Low`, `Medium`, `High`       |
   | Due           | Date       | —                             |

4. Открыть базу → **...** (три точки) → **Add connections** → выбрать свою интеграцию.
5. Скопировать **Database ID** из URL:
   ```
   https://www.notion.so/workspace/XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX?v=...
                                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                    это Database ID (32 символа)
   ```

## Шаг 2. Создание Telegram-бота

1. Написать [@BotFather](https://t.me/BotFather) команду `/newbot`.
2. Следовать инструкциям, получить **Bot Token**.
3. Придумать **секрет для вебхука** — любая рандомная строка (например, `openssl rand -hex 32`).

## Шаг 3. Установка на сервер

### Docker (если не установлен):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# перелогиниться
```

### Клонирование и настройка:

```bash
git clone https://github.com/Darakhamia/task-manager-tg.git
cd task-manager-tg
cp .env.example .env
nano .env   # заполнить все переменные
```

### Заполнить `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_WEBHOOK_SECRET=your-random-secret
OPENAI_API_KEY=sk-...
NOTION_TOKEN=secret_...
NOTION_DATABASE_ID=abcdef1234567890abcdef1234567890
BASE_URL=https://yourdomain.com
PORT=3000
ALLOWED_CHAT_IDS=          # оставить пустым = все могут, или ваш chat_id
LOG_LEVEL=info
```

> Чтобы узнать свой chat_id, напишите боту [@userinfobot](https://t.me/userinfobot).

### Запуск:

```bash
docker compose up -d --build
```

Бот стартует, автоматически регистрирует webhook в Telegram.

### Проверка что работает:

```bash
# Логи
docker compose logs -f bot

# Health check
curl http://localhost:3000/health
```

## Шаг 4. Настройка HTTPS (Nginx + Let's Encrypt)

### Установить Nginx и Certbot:

```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
```

### Получить сертификат:

```bash
sudo certbot --nginx -d yourdomain.com
```

### Конфиг Nginx:

Скопировать `nginx.conf.example` и подставить свой домен:

```bash
sudo cp nginx.conf.example /etc/nginx/sites-available/task-bot
sudo ln -s /etc/nginx/sites-available/task-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Ручная регистрация webhook (если автоматическая не сработала):

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://yourdomain.com/telegram/webhook&secret_token=<WEBHOOK_SECRET>"
```

### Проверить webhook:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

## Использование

Просто напишите или отправьте голосовое сообщение боту:

- **Текст:** `Купить молоко, позвонить маме, срочно отправить отчёт`
- **Голосовое:** скажите то же самое голосом

Бот ответит:
```
✅ Добавлено 3 задачи:
1) Купить молоко
2) Позвонить маме
3) Отправить отчёт
```

Задачи появятся в вашей Notion-базе.

## Структура проекта

```
src/
├── index.ts      — Express-сервер, webhook endpoint, основная логика
├── config.ts     — загрузка конфигурации из env
├── logger.ts     — структурированное логирование (JSON)
├── types.ts      — TypeScript типы
├── telegram.ts   — работа с Telegram API (getFile, download, sendMessage)
├── audio.ts      — скачивание голосовых + конвертация ffmpeg
├── openai.ts     — транскрипция (Whisper) + парсинг задач (GPT)
└── notion.ts     — создание страниц в Notion
```

## Обновление

```bash
cd task-manager-tg
git pull
docker compose up -d --build
```
