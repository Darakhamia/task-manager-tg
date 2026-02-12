import { AppConfig } from './types';

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

export function loadConfig(): AppConfig {
  const allowedRaw = process.env.ALLOWED_CHAT_IDS ?? '';
  const allowedChatIds = allowedRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n));

  return {
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    telegramWebhookSecret: required('TELEGRAM_WEBHOOK_SECRET'),
    openaiApiKey: required('OPENAI_API_KEY'),
    notionToken: required('NOTION_TOKEN'),
    notionDatabaseId: required('NOTION_DATABASE_ID'),
    baseUrl: required('BASE_URL'),
    port: parseInt(process.env.PORT || '3000', 10),
    allowedChatIds,
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}
