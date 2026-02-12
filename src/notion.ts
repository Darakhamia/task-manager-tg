import { Client } from '@notionhq/client';
import { ParsedTask, NotionCreateResult } from './types';
import { log } from './logger';

let notion: Client;
let databaseId: string;

export function initNotion(token: string, dbId: string): void {
  notion = new Client({ auth: token });
  databaseId = dbId;
}

/**
 * Create a single page (task) in the Notion database.
 */
async function createPage(task: ParsedTask, requestId: string): Promise<NotionCreateResult> {
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
      parent: { database_id: databaseId },
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
          parent: { database_id: databaseId },
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
): Promise<NotionCreateResult[]> {
  log.info('Creating tasks in Notion', { requestId, count: tasks.length });

  const results: NotionCreateResult[] = [];
  for (const task of tasks) {
    const result = await createPage(task, requestId);
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
