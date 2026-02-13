import axios from 'axios';
import { TelegramFile } from './types';
import { log } from './logger';

const TIMEOUT_MS = 15_000;

function apiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/**
 * Get file metadata from Telegram (file_path needed for download).
 */
export async function getFile(token: string, fileId: string): Promise<TelegramFile> {
  const url = apiUrl(token, 'getFile');
  const res = await axios.post<{ ok: boolean; result: TelegramFile }>(
    url,
    { file_id: fileId },
    { timeout: TIMEOUT_MS },
  );
  if (!res.data.ok || !res.data.result.file_path) {
    throw new Error(`Telegram getFile failed for ${fileId}`);
  }
  return res.data.result;
}

/**
 * Download file bytes from Telegram file storage.
 */
export async function downloadFile(token: string, filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 60_000,
  });
  return Buffer.from(res.data);
}

/**
 * Send a text message to a Telegram chat.
 */
export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<void> {
  const url = apiUrl(token, 'sendMessage');
  try {
    await axios.post(
      url,
      {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      },
      { timeout: TIMEOUT_MS },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to send Telegram message', { chatId, error: message });
  }
}

/**
 * Delete a message from a Telegram chat (used to remove messages with API keys).
 */
export async function deleteMessage(
  token: string,
  chatId: number,
  messageId: number,
): Promise<void> {
  const url = apiUrl(token, 'deleteMessage');
  try {
    await axios.post(url, { chat_id: chatId, message_id: messageId }, { timeout: TIMEOUT_MS });
  } catch {
    // Best-effort: if delete fails (e.g. message too old), just continue
  }
}

/**
 * Set the webhook URL for the bot.
 */
export async function setWebhook(
  token: string,
  baseUrl: string,
  secret: string,
): Promise<void> {
  const url = apiUrl(token, 'setWebhook');
  const res = await axios.post(
    url,
    {
      url: `${baseUrl}/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ['message', 'edited_message'],
    },
    { timeout: TIMEOUT_MS },
  );
  log.info('Webhook set', { ok: res.data.ok, description: res.data.description });
}
