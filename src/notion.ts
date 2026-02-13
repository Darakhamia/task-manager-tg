import { Client } from '@notionhq/client';
import { ParsedTask, NotionCreateResult, NotionTask } from './types';
import { log } from './logger';

// ── Client cache (one per token) ────────────────────────────────────────────

const clients = new Map<string, Client>();

function getClient(token: string): Client {
  let c = clients.get(token);
  if (!c) {
    c = new Client({ auth: token });
    clients.set(token, c);
  }
  return c;
}

/**
 * Create a single page (task) in the Notion database.
 */
async function createPage(
  notion: Client,
  dbId: string,
  task: ParsedTask,
  requestId: string,
): Promise<NotionCreateResult> {
  const properties: Record<string, unknown> = {
    Name: {
      title: [{ text: { content: task.name } }],
    },
    Description: {
      rich_text: [{ text: { content: task.description } }],
    },
    Status: {
      select: { name: task.status || 'To do' },
    },
    Priority: {
      select: { name: task.priority || 'Medium' },
    },
  };

  if (task.due) {
    properties['Due'] = {
      date: { start: task.due },
    };
  }

  try {
    const page = await notion.pages.create({
      parent: { database_id: dbId },
      properties: properties as any,
    });
    return { task, success: true, notionPageId: page.id };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // If select option doesn't exist, retry with safe defaults
    if (message.includes('is not an option')) {
      log.warn('Select option mismatch, retrying with defaults', { requestId, error: message });
      properties['Status'] = { select: { name: 'To do' } };
      properties['Priority'] = { select: { name: 'Medium' } };
      try {
        const page = await notion.pages.create({
          parent: { database_id: dbId },
          properties: properties as any,
        });
        return { task, success: true, notionPageId: page.id };
      } catch (retryErr: unknown) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log.error('Notion create failed even with defaults', { requestId, error: retryMsg });
        return { task, success: false, error: retryMsg };
      }
    }

    log.error('Notion create failed', { requestId, error: message });
    return { task, success: false, error: message };
  }
}

/**
 * Create all tasks in Notion. Returns results for each task.
 */
export async function createTasks(
  tasks: ParsedTask[],
  requestId: string,
  notionToken: string,
  notionDatabaseId: string,
): Promise<NotionCreateResult[]> {
  log.info('Creating tasks in Notion', { requestId, count: tasks.length });
  const notion = getClient(notionToken);

  const results: NotionCreateResult[] = [];
  for (const task of tasks) {
    const result = await createPage(notion, notionDatabaseId, task, requestId);
    results.push(result);
    log.info('Notion page created', {
      requestId,
      taskName: task.name,
      success: result.success,
      pageId: result.notionPageId,
    });
  }

  const successCount = results.filter((r) => r.success).length;
  log.info('Notion batch complete', { requestId, success: successCount, total: tasks.length });

  return results;
}

// ── Query tasks from database ────────────────────────────────────────────────

function extractPlainText(richText: any[]): string {
  if (!Array.isArray(richText)) return '';
  return richText.map((t: any) => t.plain_text ?? '').join('');
}

export async function queryTasks(
  requestId: string,
  notionToken: string,
  notionDatabaseId: string,
): Promise<NotionTask[]> {
  log.info('Querying tasks from Notion', { requestId });
  const notion = getClient(notionToken);

  const tasks: NotionTask[] = [];
  let cursor: string | undefined;

  do {
    const response: any = await notion.databases.query({
      database_id: notionDatabaseId,
      start_cursor: cursor,
      page_size: 100,
      filter: {
        property: 'Status',
        select: { does_not_equal: '__never__' },
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    });

    for (const page of response.results) {
      const props = (page as any).properties;
      tasks.push({
        pageId: page.id,
        name: extractPlainText(props.Name?.title ?? []),
        description: extractPlainText(props.Description?.rich_text ?? []),
        status: props.Status?.select?.name ?? '',
        priority: props.Priority?.select?.name ?? '',
        due: props.Due?.date?.start ?? '',
      });
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  log.info('Tasks queried', { requestId, count: tasks.length });
  return tasks;
}

// ── Update a task ──────────────────────────────────────────────────────────

export async function updateTask(
  requestId: string,
  notionToken: string,
  pageId: string,
  updates: { status?: string; priority?: string; due?: string; name?: string },
): Promise<void> {
  log.info('Updating task in Notion', { requestId, pageId, updates });
  const notion = getClient(notionToken);

  const properties: Record<string, unknown> = {};

  if (updates.name !== undefined) {
    properties['Name'] = { title: [{ text: { content: updates.name } }] };
  }
  if (updates.status !== undefined) {
    properties['Status'] = { select: { name: updates.status } };
  }
  if (updates.priority !== undefined) {
    properties['Priority'] = { select: { name: updates.priority } };
  }
  if (updates.due !== undefined) {
    properties['Due'] = updates.due
      ? { date: { start: updates.due } }
      : { date: null };
  }

  await notion.pages.update({
    page_id: pageId,
    properties: properties as any,
  });

  log.info('Task updated', { requestId, pageId });
}

// ── Delete (archive) a task ──────────────────────────────────────────────

export async function deleteTask(
  requestId: string,
  notionToken: string,
  pageId: string,
): Promise<void> {
  log.info('Archiving task in Notion', { requestId, pageId });
  const notion = getClient(notionToken);

  await notion.pages.update({
    page_id: pageId,
    archived: true,
  });

  log.info('Task archived', { requestId, pageId });
}
