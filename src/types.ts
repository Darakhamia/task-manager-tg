// ── Telegram types (subset we use) ──────────────────────────────────────────

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; first_name?: string };
  date: number;
  text?: string;
  voice?: TelegramVoice;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// ── Parsed task coming from LLM ─────────────────────────────────────────────

export interface ParsedTask {
  name: string;
  description: string;
  status: string;
  priority: string;
  due: string;
}

// ── Result of Notion creation ───────────────────────────────────────────────

export interface NotionCreateResult {
  task: ParsedTask;
  success: boolean;
  notionPageId?: string;
  error?: string;
}

// ── Config loaded from env ──────────────────────────────────────────────────

export interface AppConfig {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  openaiApiKey: string;
  notionToken: string;
  notionDatabaseId: string;
  baseUrl: string;
  port: number;
  allowedChatIds: number[];
  logLevel: string;
}
