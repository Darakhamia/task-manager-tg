import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { UserData } from './types';
import { log } from './logger';

let filePath: string;
const users = new Map<number, UserData>();

export function initStore(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  filePath = join(dataDir, 'users.json');

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const arr: UserData[] = JSON.parse(raw);
      for (const u of arr) {
        users.set(u.chatId, u);
      }
      log.info('User store loaded', { count: users.size });
    } catch (err) {
      log.error('Failed to load user store, starting fresh', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function persist(): void {
  try {
    const arr = Array.from(users.values());
    writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (err) {
    log.error('Failed to persist user store', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getUser(chatId: number): UserData | undefined {
  return users.get(chatId);
}

export function saveUser(user: UserData): void {
  user.updatedAt = new Date().toISOString();
  users.set(user.chatId, user);
  persist();
}

export function deleteUser(chatId: number): void {
  users.delete(chatId);
  persist();
}
