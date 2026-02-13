import OpenAI from 'openai';
import { TaskAction, NotionTask, InlineKeyboard } from './types';
import { queryTasks, updateTask, deleteTask } from './notion';
import { log } from './logger';

// ── Client cache ─────────────────────────────────────────────────────────────

const clients = new Map<string, OpenAI>();

function getClient(apiKey: string): OpenAI {
  let c = clients.get(apiKey);
  if (!c) {
    c = new OpenAI({ apiKey });
    clients.set(apiKey, c);
  }
  return c;
}

// ── Find best matching task via LLM ──────────────────────────────────────────

async function findTask(
  searchQuery: string,
  tasks: NotionTask[],
  requestId: string,
  apiKey: string,
): Promise<NotionTask | null> {
  if (tasks.length === 0) return null;

  // Build a numbered list of tasks for the LLM to pick from
  const taskList = tasks
    .slice(0, 50) // limit to 50 most recent to fit context
    .map((t, i) => {
      const parts = [`${i + 1}. "${t.name}"`];
      if (t.status) parts.push(`[${t.status}]`);
      if (t.due) parts.push(`(до ${t.due})`);
      return parts.join(' ');
    })
    .join('\n');

  const client = getClient(apiKey);

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 64,
    messages: [
      {
        role: 'system',
        content: `Пользователь ищет задачу по описанию. Вот список задач:\n\n${taskList}\n\nВерни ТОЛЬКО номер задачи, которая лучше всего подходит под запрос. Если ничего не подходит, верни 0. Никакого другого текста.`,
      },
      { role: 'user', content: searchQuery },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? '';
  const num = parseInt(raw, 10);
  log.debug('Task match result', { requestId, searchQuery, matchedIndex: num, raw });

  if (num > 0 && num <= Math.min(tasks.length, 50)) {
    return tasks[num - 1];
  }

  return null;
}

// ── Handle list action ───────────────────────────────────────────────────────

export interface ListResult {
  text: string;
  keyboard: InlineKeyboard;
}

export async function handleList(
  requestId: string,
  notionToken: string,
  notionDatabaseId: string,
): Promise<ListResult> {
  const tasks = await queryTasks(requestId, notionToken, notionDatabaseId);

  if (tasks.length === 0) {
    return {
      text: '📋 Список задач пуст.',
      keyboard: [],
    };
  }

  const activeTasks = tasks.filter((t) => t.status !== 'Done');
  const doneTasks = tasks.filter((t) => t.status === 'Done');

  const lines: string[] = ['📋 <b>Ваши задачи:</b>\n'];
  const keyboard: InlineKeyboard = [];

  if (activeTasks.length > 0) {
    lines.push('<b>Активные:</b>');
    activeTasks.slice(0, 15).forEach((t, i) => {
      const status = statusEmoji(t.status);
      const priority = priorityLabel(t.priority);
      const due = t.due ? ` | до ${t.due}` : '';
      lines.push(`${i + 1}. ${status} <b>${escapeHtml(t.name)}</b> ${priority}${due}`);

      // Per-task action buttons
      const shortName = t.name.length > 20 ? t.name.slice(0, 18) + '…' : t.name;
      const row = [
        { text: `✅ ${shortName}`, callback_data: `d:${t.pageId}` },
        { text: '🗑', callback_data: `x:${t.pageId}` },
      ];
      // Add "In progress" button only if task is "To do"
      if (t.status === 'To do') {
        row.splice(1, 0, { text: '🔵', callback_data: `p:${t.pageId}` });
      }
      keyboard.push(row);
    });
    if (activeTasks.length > 15) {
      lines.push(`…и ещё ${activeTasks.length - 15}`);
    }
  }

  if (doneTasks.length > 0) {
    lines.push(`\n✅ <b>Выполнено:</b> ${doneTasks.length} ${pluralTask(doneTasks.length)}`);
  }

  // Add refresh button at the bottom
  keyboard.push([{ text: '🔄 Обновить', callback_data: 'list' }]);

  return { text: lines.join('\n'), keyboard };
}

// ── Handle update action ─────────────────────────────────────────────────────

export async function handleUpdate(
  action: TaskAction,
  requestId: string,
  notionToken: string,
  notionDatabaseId: string,
  apiKey: string,
): Promise<string> {
  if (!action.searchQuery) {
    return '❌ Не понял, какую задачу нужно обновить. Укажи название задачи.';
  }

  const tasks = await queryTasks(requestId, notionToken, notionDatabaseId);
  const matched = await findTask(action.searchQuery, tasks, requestId, apiKey);

  if (!matched) {
    return `🔍 Не нашёл задачу по запросу «${escapeHtml(action.searchQuery)}». Попробуй переформулировать.`;
  }

  if (!action.updates || Object.keys(action.updates).length === 0) {
    return `❌ Не понял, что нужно изменить в задаче «${escapeHtml(matched.name)}».`;
  }

  await updateTask(requestId, notionToken, matched.pageId, action.updates);

  // Build confirmation
  const changes: string[] = [];
  if (action.updates.status) changes.push(`статус → <b>${action.updates.status}</b>`);
  if (action.updates.priority) changes.push(`приоритет → <b>${action.updates.priority}</b>`);
  if (action.updates.due) changes.push(`дедлайн → <b>${action.updates.due}</b>`);
  if (action.updates.due === '') changes.push('дедлайн убран');
  if (action.updates.name) changes.push(`название → <b>${escapeHtml(action.updates.name)}</b>`);

  return `✏️ Задача «<b>${escapeHtml(matched.name)}</b>» обновлена:\n${changes.join('\n')}`;
}

// ── Handle delete action ─────────────────────────────────────────────────────

export async function handleDelete(
  action: TaskAction,
  requestId: string,
  notionToken: string,
  notionDatabaseId: string,
  apiKey: string,
): Promise<string> {
  if (!action.searchQuery) {
    return '❌ Не понял, какую задачу нужно удалить. Укажи название задачи.';
  }

  const tasks = await queryTasks(requestId, notionToken, notionDatabaseId);
  const matched = await findTask(action.searchQuery, tasks, requestId, apiKey);

  if (!matched) {
    return `🔍 Не нашёл задачу по запросу «${escapeHtml(action.searchQuery)}». Попробуй переформулировать.`;
  }

  await deleteTask(requestId, notionToken, matched.pageId);

  return `🗑 Задача «<b>${escapeHtml(matched.name)}</b>» удалена.`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusEmoji(status: string): string {
  switch (status) {
    case 'To do': return '⬜';
    case 'In progress': return '🔵';
    case 'Done': return '✅';
    default: return '⬜';
  }
}

function priorityLabel(priority: string): string {
  switch (priority) {
    case 'High': return '🔴';
    case 'Medium': return '🟡';
    case 'Low': return '🟢';
    default: return '';
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pluralTask(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'задача';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'задачи';
  return 'задач';
}
