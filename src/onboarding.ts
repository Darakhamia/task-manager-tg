import { UserData, OnboardingStep } from './types';
import { getUser, saveUser, deleteUser } from './store';
import { sendMessage, deleteMessage } from './telegram';
import { log } from './logger';

// ── Messages ────────────────────────────────────────────────────────────────

const WELCOME = `👋 <b>Привет! Я — бот для управления задачами.</b>

Я умею:
• Принимать текстовые и голосовые сообщения
• Извлекать из них задачи
• Создавать их в твоём Notion

Для работы мне нужны API-ключи. Настроим всё за 3 шага!`;

const ASK_OPENAI_KEY = `🔑 <b>Шаг 1/3: OpenAI API Key</b>

Нужен для распознавания голоса и парсинга задач.

<b>Как получить:</b>
1. Зайди на <a href="https://platform.openai.com/api-keys">platform.openai.com/api-keys</a>
2. Нажми <b>Create new secret key</b>
3. Скопируй ключ и отправь мне сюда

⚠️ Ключ начинается с <code>sk-</code>`;

const ASK_NOTION_TOKEN = `✅ OpenAI ключ сохранён!

🔑 <b>Шаг 2/3: Notion Integration Token</b>

<b>Как получить:</b>
1. Зайди на <a href="https://www.notion.so/my-integrations">notion.so/my-integrations</a>
2. Нажми <b>New integration</b>
3. Дай имя (например «Task Bot»), выбери workspace
4. Скопируй <b>Internal Integration Secret</b> и отправь мне

⚠️ Токен начинается с <code>ntn_</code> или <code>secret_</code>`;

const ASK_NOTION_DB = `✅ Notion токен сохранён!

🔑 <b>Шаг 3/3: Notion Database ID</b>

<b>Как получить:</b>
1. Создай или открой базу данных в Notion
2. Нажми <b>⋯</b> → <b>Copy link</b>
3. В ссылке найди ID — 32 символа после последнего <code>/</code> и до <code>?</code>:
   <code>notion.so/workspace/<b>abc123...def</b>?v=...</code>
4. Отправь мне этот ID

⚠️ <b>Не забудь подключить интеграцию к базе:</b>
   Открой базу → <b>⋯</b> → <b>Connections</b> → найди свою интеграцию

📋 <b>Нужные колонки в базе:</b>
• Name (title) • Description (text) • Status (select: To do, In progress, Done) • Priority (select: Low, Medium, High) • Due (date)`;

const SETUP_COMPLETE = `🎉 <b>Готово! Бот настроен.</b>

Теперь просто отправляй мне текстовые или голосовые сообщения с задачами — я добавлю их в твой Notion.

<b>Команды:</b>
/reset — сбросить настройки и начать заново
/status — проверить текущие настройки`;

const STATUS_NOT_CONFIGURED = `⚙️ Бот ещё не настроен. Отправь /start чтобы начать.`;

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * Handle /start command — begin or restart onboarding.
 */
export async function handleStart(
  token: string,
  chatId: number,
  firstName?: string,
): Promise<void> {
  const now = new Date().toISOString();
  const user: UserData = {
    chatId,
    step: 'awaiting_openai_key',
    firstName,
    createdAt: getUser(chatId)?.createdAt ?? now,
    updatedAt: now,
  };
  saveUser(user);

  await sendMessage(token, chatId, WELCOME);
  await sendMessage(token, chatId, ASK_OPENAI_KEY);
}

/**
 * Handle /reset — clear config and restart.
 */
export async function handleReset(
  token: string,
  chatId: number,
  firstName?: string,
): Promise<void> {
  deleteUser(chatId);
  await sendMessage(token, chatId, '🔄 Настройки сброшены.');
  await handleStart(token, chatId, firstName);
}

/**
 * Handle /status — show current config.
 */
export async function handleStatus(token: string, chatId: number): Promise<void> {
  const user = getUser(chatId);
  if (!user || user.step !== 'ready') {
    await sendMessage(token, chatId, STATUS_NOT_CONFIGURED);
    return;
  }

  const mask = (s?: string) => s ? s.slice(0, 8) + '...' + s.slice(-4) : '—';
  const msg = `⚙️ <b>Текущие настройки:</b>

• OpenAI Key: <code>${mask(user.openaiApiKey)}</code>
• Notion Token: <code>${mask(user.notionToken)}</code>
• Notion DB: <code>${mask(user.notionDatabaseId)}</code>

/reset — сбросить и настроить заново`;

  await sendMessage(token, chatId, msg);
}

/**
 * Process an onboarding step. Returns true if the message was consumed
 * by onboarding (i.e. should NOT be processed as a task).
 */
export async function handleOnboardingStep(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
): Promise<boolean> {
  const user = getUser(chatId);
  if (!user) return false;
  if (user.step === 'ready') return false;

  const input = text.trim();

  switch (user.step) {
    case 'awaiting_openai_key': {
      if (!input.startsWith('sk-')) {
        await sendMessage(token, chatId, '❌ Ключ должен начинаться с <code>sk-</code>. Попробуй ещё раз.');
        return true;
      }
      user.openaiApiKey = input;
      user.step = 'awaiting_notion_token';
      saveUser(user);
      await deleteMessage(token, chatId, messageId);
      await sendMessage(token, chatId, ASK_NOTION_TOKEN);
      return true;
    }

    case 'awaiting_notion_token': {
      if (!input.startsWith('ntn_') && !input.startsWith('secret_')) {
        await sendMessage(
          token,
          chatId,
          '❌ Токен должен начинаться с <code>ntn_</code> или <code>secret_</code>. Попробуй ещё раз.',
        );
        return true;
      }
      user.notionToken = input;
      user.step = 'awaiting_notion_db';
      saveUser(user);
      await deleteMessage(token, chatId, messageId);
      await sendMessage(token, chatId, ASK_NOTION_DB);
      return true;
    }

    case 'awaiting_notion_db': {
      // Database ID: 32 hex chars, possibly with dashes
      const cleaned = input.replace(/-/g, '');
      if (!/^[a-f0-9]{32}$/i.test(cleaned)) {
        await sendMessage(
          token,
          chatId,
          '❌ Database ID должен содержать 32 hex-символа. Попробуй ещё раз.',
        );
        return true;
      }
      user.notionDatabaseId = cleaned;
      user.step = 'ready';
      saveUser(user);
      await deleteMessage(token, chatId, messageId);
      log.info('User onboarding complete', { chatId });
      await sendMessage(token, chatId, SETUP_COMPLETE);
      return true;
    }

    default:
      return false;
  }
}
