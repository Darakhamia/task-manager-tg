import OpenAI from 'openai';
import { createReadStream } from 'node:fs';
import { ParsedTask } from './types';
import { log } from './logger';

let client: OpenAI;

export function initOpenAI(apiKey: string): void {
  client = new OpenAI({ apiKey });
}

// ── Transcription ───────────────────────────────────────────────────────────

export async function transcribe(mp3Path: string, requestId: string): Promise<string> {
  log.info('Starting transcription', { requestId, mp3Path });

  const doTranscribe = async (): Promise<string> => {
    const file = createReadStream(mp3Path);
    const response = await client.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      language: 'ru',
    });
    return response.text;
  };

  try {
    return await doTranscribe();
  } catch (err: unknown) {
    log.warn('Transcription failed, retrying once', { requestId, error: String(err) });
    return await doTranscribe();
  }
}

// ── Task parsing ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ты — ассистент для парсинга задач. Пользователь присылает текст (возможно, расшифровку голосового сообщения).
Твоя задача — извлечь из текста список задач и вернуть ТОЛЬКО валидный JSON-массив.

Каждый элемент массива — объект с полями:
- "name": string — краткое название задачи (до 80 символов)
- "description": string — описание задачи (может быть пустой строкой "")
- "status": string — всегда "To do"
- "priority": string — "Low", "Medium" или "High". По умолчанию "Medium". Ставь "High", если в тексте есть слова: срочно, важно, asap, критично, горит, дедлайн сегодня, немедленно.
- "due": string — дата дедлайна в формате "YYYY-MM-DD" или пустая строка "", если дата не указана.

Правила:
1. Если в тексте одна задача — верни массив с одним элементом.
2. Если задач несколько — разбей на отдельные элементы.
3. Названия и описания задач оставляй на языке оригинала (обычно русский).
4. НЕ добавляй никакого текста кроме JSON. Никаких пояснений, markdown, code fences.
5. Если текст не содержит задач, верни массив с одной задачей, где name = текст сообщения целиком (обрезав до 80 символов).

Пример входа: "Купить молоко и хлеб, а ещё срочно позвонить врачу"
Пример выхода:
[{"name":"Купить молоко и хлеб","description":"","status":"To do","priority":"Medium","due":""},{"name":"Позвонить врачу","description":"Срочно","status":"To do","priority":"High","due":""}]`;

const REPAIR_PROMPT = `Предыдущий ответ не является валидным JSON. Исправь его и верни ТОЛЬКО валидный JSON-массив задач. Никакого другого текста.`;

export async function parseTasks(inputText: string, requestId: string): Promise<ParsedTask[]> {
  log.info('Parsing tasks from text', { requestId, textLength: inputText.length });

  const raw = await chatCompletion(SYSTEM_PROMPT, inputText, requestId);
  const parsed = tryParseJson(raw);

  if (parsed) {
    log.info('Tasks parsed successfully', { requestId, count: parsed.length });
    return validateTasks(parsed);
  }

  // Repair attempt
  log.warn('Invalid JSON from LLM, attempting repair', { requestId });
  const repaired = await chatCompletion(REPAIR_PROMPT, raw, requestId);
  const parsed2 = tryParseJson(repaired);

  if (parsed2) {
    log.info('Tasks parsed after repair', { requestId, count: parsed2.length });
    return validateTasks(parsed2);
  }

  throw new Error('LLM returned invalid JSON even after repair attempt');
}

async function chatCompletion(system: string, user: string, requestId: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim() ?? '';
  log.debug('LLM response', { requestId, content });
  return content;
}

function tryParseJson(raw: string): unknown[] | null {
  try {
    // Strip possible markdown code fence
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const result = JSON.parse(cleaned);
    if (Array.isArray(result)) return result;
    return null;
  } catch {
    return null;
  }
}

function validateTasks(raw: unknown[]): ParsedTask[] {
  const VALID_PRIORITIES = new Set(['Low', 'Medium', 'High']);
  const VALID_STATUSES = new Set(['To do', 'In progress', 'Done']);

  return raw.map((item: any) => ({
    name: String(item.name || 'Без названия').slice(0, 200),
    description: String(item.description ?? ''),
    status: VALID_STATUSES.has(item.status) ? item.status : 'To do',
    priority: VALID_PRIORITIES.has(item.priority) ? item.priority : 'Medium',
    due: typeof item.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.due) ? item.due : '',
  }));
}
