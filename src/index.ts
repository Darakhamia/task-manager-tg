import express, { Request, Response } from 'express';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { loadConfig } from './config';
import { initLogger, log } from './logger';
import { initStore, getUser } from './store';
import { transcribe, parseTasks } from './openai';
import { createTasks } from './notion';
import { downloadAndConvert } from './audio';
import { sendMessage, sendMessageWithKeyboard, editMessageText, answerCallbackQuery, setWebhook } from './telegram';
import { handleStart, handleReset, handleStatus, handleOnboardingStep } from './onboarding';
import { detectIntent } from './intent';
import { handleList as execList, handleUpdate as execUpdate, handleDelete as execDelete } from './taskManager';
import { updateTask as notionUpdateTask, deleteTask as notionDeleteTask } from './notion';
import { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, AppConfig, UserData, NotionCreateResult, InlineKeyboard } from './types';

// ── Bootstrap ───────────────────────────────────────────────────────────────

const config = loadConfig();
initLogger(config);
initStore(config.dataDir);

const app = express();
app.use(express.json());

// ── Health check ────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// ── Webhook endpoint ────────────────────────────────────────────────────────

app.post('/telegram/webhook', (req: Request, res: Response) => {
  // Verify secret token
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== config.telegramWebhookSecret) {
    log.warn('Invalid webhook secret');
    res.sendStatus(403);
    return;
  }

  // Return 200 immediately so Telegram doesn't retry
  res.sendStatus(200);

  const update = req.body as TelegramUpdate;
  const requestId = uuid();

  // Process async — fire and forget (errors caught inside)
  handleUpdate(update, requestId, config).catch((err) => {
    log.error('Unhandled error in update processing', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
});

// ── Core processing logic ───────────────────────────────────────────────────

async function handleUpdate(
  update: TelegramUpdate,
  requestId: string,
  cfg: AppConfig,
): Promise<void> {
  // Handle callback queries (inline button presses)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, requestId, cfg);
    return;
  }

  const message = update.message ?? update.edited_message;
  if (!message) {
    log.debug('Update without message, skipping', { requestId, updateId: update.update_id });
    return;
  }

  const chatId = message.chat.id;
  const firstName = message.from?.first_name;
  const text = message.text?.trim() ?? '';

  log.info('Received update', {
    requestId,
    updateId: update.update_id,
    chatId,
    hasVoice: !!message.voice,
    hasText: !!message.text,
  });

  // Check allowed chat IDs
  if (cfg.allowedChatIds.length > 0 && !cfg.allowedChatIds.includes(chatId)) {
    log.warn('Chat ID not allowed', { requestId, chatId });
    await sendMessage(cfg.telegramBotToken, chatId, '⛔ У вас нет доступа к этому боту.');
    return;
  }

  // ── Commands ────────────────────────────────────────────────────────────
  if (text === '/start') {
    await handleStart(cfg.telegramBotToken, chatId, firstName);
    return;
  }
  if (text === '/reset') {
    await handleReset(cfg.telegramBotToken, chatId, firstName);
    return;
  }
  if (text === '/status') {
    await handleStatus(cfg.telegramBotToken, chatId);
    return;
  }

  // ── Onboarding flow (text only) ────────────────────────────────────────
  if (message.text) {
    const consumed = await handleOnboardingStep(
      cfg.telegramBotToken,
      chatId,
      message.message_id,
      message.text,
    );
    if (consumed) return;
  }

  // ── Check user is configured ──────────────────────────────────────────
  const user = getUser(chatId);
  if (!user || user.step !== 'ready') {
    await sendMessage(
      cfg.telegramBotToken,
      chatId,
      '⚙️ Бот ещё не настроен. Отправь /start чтобы начать настройку.',
    );
    return;
  }

  // ── Process task message ──────────────────────────────────────────────
  await processTaskMessage(message, user, requestId, cfg);
}

// ── Task processing (for configured users) ──────────────────────────────────

async function processTaskMessage(
  message: TelegramMessage,
  user: UserData,
  requestId: string,
  cfg: AppConfig,
): Promise<void> {
  const chatId = message.chat.id;

  let inputText: string;
  try {
    inputText = await extractText(message, requestId, cfg, user);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Failed to extract text', { requestId, error: msg });
    await sendMessage(
      cfg.telegramBotToken,
      chatId,
      '❌ Не удалось обработать сообщение. Попробуйте ещё раз.',
    );
    return;
  }

  if (!inputText.trim()) {
    log.info('Empty text, skipping', { requestId });
    return;
  }

  // Detect intent
  let action;
  try {
    action = await detectIntent(inputText, requestId, user.openaiApiKey!);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Intent detection failed, falling back to create', { requestId, error: msg });
    action = { intent: 'create' as const, createText: inputText };
  }

  log.info('Processing action', { requestId, intent: action.intent });

  try {
    switch (action.intent) {
      case 'list':
        await handleListAction(chatId, requestId, user, cfg);
        break;

      case 'update':
        await handleUpdateAction(action, chatId, requestId, user, cfg);
        break;

      case 'delete':
        await handleDeleteAction(action, chatId, requestId, user, cfg);
        break;

      case 'create':
      default:
        await handleCreateAction(action.createText || inputText, chatId, requestId, user, cfg);
        break;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Action processing failed', { requestId, intent: action.intent, error: msg });
    await sendMessage(
      cfg.telegramBotToken,
      chatId,
      '❌ Ошибка при выполнении операции. Попробуйте ещё раз.',
    );
  }
}

// ── Main menu keyboard ──────────────────────────────────────────────────────

const MAIN_MENU: InlineKeyboard = [
  [
    { text: '📋 Мои задачи', callback_data: 'list' },
    { text: '⚙️ Настройки', callback_data: 'status' },
  ],
];

// ── Action handlers ─────────────────────────────────────────────────────────

async function handleListAction(
  chatId: number,
  requestId: string,
  user: UserData,
  cfg: AppConfig,
): Promise<void> {
  const { text, keyboard } = await execList(requestId, user.notionToken!, user.notionDatabaseId!);
  if (keyboard.length > 0) {
    await sendMessageWithKeyboard(cfg.telegramBotToken, chatId, text, keyboard);
  } else {
    await sendMessageWithKeyboard(cfg.telegramBotToken, chatId, text, MAIN_MENU);
  }
}

async function handleUpdateAction(
  action: import('./types').TaskAction,
  chatId: number,
  requestId: string,
  user: UserData,
  cfg: AppConfig,
): Promise<void> {
  const result = await execUpdate(
    action,
    requestId,
    user.notionToken!,
    user.notionDatabaseId!,
    user.openaiApiKey!,
  );
  await sendMessage(cfg.telegramBotToken, chatId, result);
}

async function handleDeleteAction(
  action: import('./types').TaskAction,
  chatId: number,
  requestId: string,
  user: UserData,
  cfg: AppConfig,
): Promise<void> {
  const result = await execDelete(
    action,
    requestId,
    user.notionToken!,
    user.notionDatabaseId!,
    user.openaiApiKey!,
  );
  await sendMessage(cfg.telegramBotToken, chatId, result);
}

async function handleCreateAction(
  inputText: string,
  chatId: number,
  requestId: string,
  user: UserData,
  cfg: AppConfig,
): Promise<void> {
  // Parse tasks
  let tasks;
  try {
    tasks = await parseTasks(inputText, requestId, user.openaiApiKey!);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Task parsing failed', { requestId, error: msg });
    await sendMessage(
      cfg.telegramBotToken,
      chatId,
      '❌ Не удалось распознать задачи. Попробуйте переформулировать.',
    );
    return;
  }

  if (tasks.length === 0) {
    await sendMessage(cfg.telegramBotToken, chatId, '🤷 Не нашёл задач в сообщении.');
    return;
  }

  // Create in Notion
  let results: NotionCreateResult[];
  try {
    results = await createTasks(tasks, requestId, user.notionToken!, user.notionDatabaseId!);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Notion batch creation failed', { requestId, error: msg });
    await sendMessage(
      cfg.telegramBotToken,
      chatId,
      '❌ Ошибка при создании задач в Notion. Проверьте настройки (/status) или сбросьте (/reset).',
    );
    return;
  }

  // Build confirmation message with menu buttons
  const confirmation = buildConfirmation(results);
  await sendMessageWithKeyboard(cfg.telegramBotToken, chatId, confirmation, MAIN_MENU);
}

// ── Callback query handler ───────────────────────────────────────────────────

async function handleCallbackQuery(
  cq: TelegramCallbackQuery,
  requestId: string,
  cfg: AppConfig,
): Promise<void> {
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  const data = cq.data ?? '';

  if (!chatId) {
    await answerCallbackQuery(cfg.telegramBotToken, cq.id);
    return;
  }

  log.info('Callback query received', { requestId, chatId, data });

  const user = getUser(chatId);
  if (!user || user.step !== 'ready') {
    await answerCallbackQuery(cfg.telegramBotToken, cq.id, 'Бот не настроен. Отправь /start');
    return;
  }

  try {
    if (data === 'list') {
      await answerCallbackQuery(cfg.telegramBotToken, cq.id);
      const { text, keyboard } = await execList(requestId, user.notionToken!, user.notionDatabaseId!);
      if (messageId) {
        // Update the existing message instead of sending a new one
        await editMessageText(
          cfg.telegramBotToken,
          chatId,
          messageId,
          text,
          keyboard.length > 0 ? keyboard : MAIN_MENU,
        );
      } else {
        await sendMessageWithKeyboard(cfg.telegramBotToken, chatId, text, keyboard.length > 0 ? keyboard : MAIN_MENU);
      }
      return;
    }

    if (data === 'status') {
      await answerCallbackQuery(cfg.telegramBotToken, cq.id);
      await handleStatus(cfg.telegramBotToken, chatId);
      return;
    }

    // d:pageId — mark as Done
    if (data.startsWith('d:')) {
      const pageId = data.slice(2);
      await notionUpdateTask(requestId, user.notionToken!, pageId, { status: 'Done' });
      await answerCallbackQuery(cfg.telegramBotToken, cq.id, '✅ Задача выполнена!');
      // Refresh the task list
      const { text, keyboard } = await execList(requestId, user.notionToken!, user.notionDatabaseId!);
      if (messageId) {
        await editMessageText(cfg.telegramBotToken, chatId, messageId, text, keyboard.length > 0 ? keyboard : MAIN_MENU);
      }
      return;
    }

    // p:pageId — mark as In progress
    if (data.startsWith('p:')) {
      const pageId = data.slice(2);
      await notionUpdateTask(requestId, user.notionToken!, pageId, { status: 'In progress' });
      await answerCallbackQuery(cfg.telegramBotToken, cq.id, '🔵 Задача в работе!');
      const { text, keyboard } = await execList(requestId, user.notionToken!, user.notionDatabaseId!);
      if (messageId) {
        await editMessageText(cfg.telegramBotToken, chatId, messageId, text, keyboard.length > 0 ? keyboard : MAIN_MENU);
      }
      return;
    }

    // x:pageId — delete (archive) task
    if (data.startsWith('x:')) {
      const pageId = data.slice(2);
      await notionDeleteTask(requestId, user.notionToken!, pageId);
      await answerCallbackQuery(cfg.telegramBotToken, cq.id, '🗑 Задача удалена!');
      const { text, keyboard } = await execList(requestId, user.notionToken!, user.notionDatabaseId!);
      if (messageId) {
        await editMessageText(cfg.telegramBotToken, chatId, messageId, text, keyboard.length > 0 ? keyboard : MAIN_MENU);
      }
      return;
    }

    await answerCallbackQuery(cfg.telegramBotToken, cq.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Callback query processing failed', { requestId, data, error: msg });
    await answerCallbackQuery(cfg.telegramBotToken, cq.id, '❌ Ошибка, попробуйте ещё раз');
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function extractText(
  message: TelegramMessage,
  requestId: string,
  cfg: AppConfig,
  user: UserData,
): Promise<string> {
  if (message.voice) {
    const { mp3Path, cleanup } = await downloadAndConvert(
      cfg.telegramBotToken,
      message.voice.file_id,
      requestId,
    );
    try {
      const text = await transcribe(mp3Path, requestId, user.openaiApiKey!);
      log.info('Transcription result', { requestId, textLength: text.length });
      return text;
    } finally {
      await cleanup();
    }
  }

  if (message.text) {
    return message.text;
  }

  return '';
}

function buildConfirmation(results: NotionCreateResult[]): string {
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const total = results.length;

  if (failed.length === 0) {
    const header = `✅ Добавлено ${succeeded.length} ${pluralTask(succeeded.length)}:`;
    const list = formatTaskList(succeeded, 10);
    return `${header}\n${list}`;
  }

  if (succeeded.length === 0) {
    return `❌ Не удалось создать задачи в Notion (${total} шт.). Проверьте настройки (/status) или сбросьте (/reset).`;
  }

  const header = `⚠️ Добавлено ${succeeded.length}/${total} ${pluralTask(succeeded.length)}:`;
  const list = formatTaskList(succeeded, 10);
  const failedNames = failed.map((r) => r.task.name).join(', ');
  return `${header}\n${list}\n\n❌ Не удалось: ${failedNames}`;
}

function formatTaskList(results: NotionCreateResult[], max: number): string {
  const lines = results.slice(0, max).map((r, i) => `${i + 1}) ${r.task.name}`);
  if (results.length > max) {
    lines.push(`…и ещё ${results.length - max}`);
  }
  return lines.join('\n');
}

function pluralTask(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'задача';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'задачи';
  return 'задач';
}

// ── Start server ────────────────────────────────────────────────────────────

const certDir = path.resolve(__dirname, '..', 'certs');
const certPath = path.join(certDir, 'cert.pem');
const keyPath = path.join(certDir, 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const sslOptions = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
  https.createServer(sslOptions, app).listen(config.port, () => {
    log.info('HTTPS server started', { port: config.port });
    registerWebhook();
  });
} else {
  app.listen(config.port, () => {
    log.info('HTTP server started', { port: config.port });
    registerWebhook();
  });
}

function registerWebhook(): void {
  if (config.baseUrl) {
    setWebhook(config.telegramBotToken, config.baseUrl, config.telegramWebhookSecret).catch(
      (err) => {
        log.error('Failed to set webhook', { error: err instanceof Error ? err.message : String(err) });
      },
    );
  }
}
