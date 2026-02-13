import OpenAI from 'openai';
import { TaskAction, TaskIntent } from './types';
import { log } from './logger';

// ── Client cache (reuse from openai.ts pattern) ─────────────────────────────

const clients = new Map<string, OpenAI>();

function getClient(apiKey: string): OpenAI {
  let c = clients.get(apiKey);
  if (!c) {
    c = new OpenAI({ apiKey });
    clients.set(apiKey, c);
  }
  return c;
}

// ── Intent detection prompt ──────────────────────────────────────────────────

function buildIntentPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  const weekday = new Date().toLocaleDateString('ru-RU', { weekday: 'long' });

  return `Ты — ассистент для управления задачами. Определи намерение пользователя из его сообщения.

Сегодня: ${today} (${weekday}).

Возможные намерения:
1. "create" — пользователь хочет СОЗДАТЬ новую задачу (или несколько). Примеры: "Запиши задачу...", "Надо купить молоко", "Позвонить врачу завтра".
2. "update" — пользователь хочет ИЗМЕНИТЬ существующую задачу (статус, дедлайн, приоритет, название). Примеры: "Поменяй статус задачи X на готово", "Перенеси дедлайн задачи X на пятницу", "Задача про Дениса — высокий приоритет".
3. "delete" — пользователь хочет УДАЛИТЬ существующую задачу. Примеры: "Удали задачу про Дениса", "Убери задачу написать отчёт".
4. "list" — пользователь хочет ПОСМОТРЕТЬ свои задачи. Примеры: "Покажи задачи", "Что у меня в списке?", "Какие задачи на сегодня?".

Верни ТОЛЬКО валидный JSON-объект с полями:
- "intent": "create" | "update" | "delete" | "list"
- "searchQuery": строка для поиска задачи (для update/delete — ключевые слова из названия задачи, которую ищем). Пустая строка для create и list.
- "updates": объект с полями для обновления (только для update). Возможные поля:
  - "status": "To do" | "In progress" | "Done"
  - "priority": "Low" | "Medium" | "High"
  - "due": дата в формате "YYYY-MM-DD" или "" для удаления дедлайна
  - "name": новое название задачи
  Включай ТОЛЬКО те поля, которые нужно изменить.
- "createText": исходный текст для создания задач (только для create — весь текст сообщения).

Маппинг статусов из русского:
- готово, выполнено, сделано, done → "Done"
- в работе, в процессе, делаю → "In progress"
- не начато, новая, to do → "To do"

Маппинг приоритетов из русского:
- низкий, неважно → "Low"
- средний, обычный → "Medium"
- высокий, срочно, важно → "High"

Для дат: вычисляй относительные даты ("завтра", "в пятницу", "через неделю") от сегодняшней даты.

НЕ добавляй никакого текста кроме JSON. Никаких пояснений, markdown, code fences.`;
}

// ── Detect intent ────────────────────────────────────────────────────────────

export async function detectIntent(
  inputText: string,
  requestId: string,
  apiKey: string,
): Promise<TaskAction> {
  log.info('Detecting intent', { requestId, textLength: inputText.length });
  const client = getClient(apiKey);

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: buildIntentPrompt() },
      { role: 'user', content: inputText },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? '';
  log.debug('Intent LLM response', { requestId, raw });

  const parsed = tryParseAction(raw);
  if (parsed) {
    log.info('Intent detected', { requestId, intent: parsed.intent });
    return parsed;
  }

  // Fallback: treat as create
  log.warn('Could not parse intent, falling back to create', { requestId });
  return { intent: 'create', createText: inputText };
}

function tryParseAction(raw: string): TaskAction | null {
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const obj = JSON.parse(cleaned);

    const VALID_INTENTS: TaskIntent[] = ['create', 'update', 'delete', 'list'];
    if (!VALID_INTENTS.includes(obj.intent)) return null;

    const action: TaskAction = {
      intent: obj.intent,
    };

    if (obj.searchQuery) {
      action.searchQuery = String(obj.searchQuery);
    }
    if (obj.updates && typeof obj.updates === 'object') {
      action.updates = {};
      if (obj.updates.status) action.updates.status = String(obj.updates.status);
      if (obj.updates.priority) action.updates.priority = String(obj.updates.priority);
      if (obj.updates.due !== undefined) action.updates.due = String(obj.updates.due);
      if (obj.updates.name) action.updates.name = String(obj.updates.name);
    }
    if (obj.createText) {
      action.createText = String(obj.createText);
    }

    return action;
  } catch {
    return null;
  }
}
