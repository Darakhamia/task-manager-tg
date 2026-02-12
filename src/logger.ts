import { AppConfig } from './types';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: number = LEVELS.info;

export function initLogger(config: Pick<AppConfig, 'logLevel'>): void {
  const lvl = (config.logLevel || 'info').toLowerCase() as LogLevel;
  minLevel = LEVELS[lvl] ?? LEVELS.info;
}

function write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  };

  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => write('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
};
