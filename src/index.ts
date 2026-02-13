import express, { Request, Response } from 'express';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { loadConfig } from './config';
import { initLogger, log } from './logger';
import { initOpenAI, transcribe, parseTasks } from './openai';
import { initNotion, createTasks } from './notion';
import { downloadAndConvert } from './audio';
import { sendMessage, setWebhook } from './telegram';
import { TelegramUpdate, TelegramMessage, AppConfig, NotionCreateResult } from './types';

// ── Bootstrap ───────────────────────────────────────────────────────────────

const config = loadConfig();
initLogger(config);
initOpenAI(config.openaiApiKey);
initNotion(config.notionToken, config.notionDatabaseId);

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
  const message = update.message ?? update.edited_message;
  if (!message) {
    log.debug('Update without message, skipping', { requestId, updateId: update.update_id });
    return;
  }

  const chatId = message.chat.id;
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

  let inputText: string;

  try {
    inputText = await extractText(message, requestId, cfg);
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

  // Parse tasks
  let tasks;
  try {
    tasks = await parseTasks(inputText, requestId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Task parsing failed', { requestId, error: msg });
    await sendMessage(
      cfg.telegramBotToken,
      chatId,
      '❌ Не удалось распознать задачи из сообщения. Попробуйте переформулировать.',
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
    results = await createTasks(tasks, requestId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Notion batch creation failed', { requestId, error: msg });
    await sendMessage(
      cfg.telegramBotToken,
      chatId,
      '❌ Ошибка при создании задач в Notion. Попробуйте позже.',
    );
    return;
  }

  // Build confirmation message
  const confirmation = buildConfirmation(results);
  await sendMessage(cfg.telegramBotToken, chatId, confirmation);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function extractText(
  message: TelegramMessage,
  requestId: string,
  cfg: AppConfig,
): Promise<string> {
  if (message.voice) {
    const { mp3Path, cleanup } = await downloadAndConvert(
      cfg.telegramBotToken,
      message.voice.file_id,
      requestId,
    );
    try {
      const text = await transcribe(mp3Path, requestId);
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
    // All succeeded
    const header = `✅ Добавлено ${succeeded.length} ${pluralTask(succeeded.length)}:`;
    const list = formatTaskList(succeeded, 10);
    return `${header}\n${list}`;
  }

  if (succeeded.length === 0) {
    // All failed
    return `❌ Не удалось создать задачи в Notion (${total} шт.). Проверьте настройки базы данных.`;
  }

  // Partial
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

// Try to load TLS certs for direct HTTPS (no Nginx needed)
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
  // Fallback to plain HTTP (behind Nginx/reverse proxy)
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
