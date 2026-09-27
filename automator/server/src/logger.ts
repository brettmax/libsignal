import type { LogEntry } from '@automator/shared';
import type { Logger } from './contracts.js';

export const LOG_BUFFER_SIZE = 200;

export interface BufferedLogger extends Logger {
  /** Most recent first, at most LOG_BUFFER_SIZE entries. */
  entries(): LogEntry[];
  /** Called for every new entry. Returns an unsubscribe function. */
  subscribe(cb: (entry: LogEntry) => void): () => void;
}

export interface LoggerOptions {
  /** Print to the console (default true). */
  console?: boolean;
  /** Minimum level printed to the console (default 'info'; everything is buffered). */
  consoleLevel?: LogEntry['level'];
  now?: () => number;
}

const LEVELS: Record<LogEntry['level'], number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(opts: LoggerOptions = {}): BufferedLogger {
  const toConsole = opts.console ?? true;
  const minConsole = LEVELS[opts.consoleLevel ?? (process.env.AUTOMATOR_DEBUG ? 'debug' : 'info')];
  const now = opts.now ?? Date.now;
  // Stored oldest-first internally; reversed on read.
  const buf: LogEntry[] = [];
  const subs = new Set<(entry: LogEntry) => void>();

  return {
    log(level, source, message) {
      const entry: LogEntry = { timestamp: now(), level, source, message: String(message) };
      buf.push(entry);
      if (buf.length > LOG_BUFFER_SIZE) buf.splice(0, buf.length - LOG_BUFFER_SIZE);
      if (toConsole && LEVELS[level] >= minConsole) {
        const line = `${new Date(entry.timestamp).toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${entry.message}`;
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.log(line);
      }
      for (const cb of subs) {
        try {
          cb(entry);
        } catch {
          // a broken subscriber must never break logging
        }
      }
    },
    entries() {
      return buf.slice().reverse();
    },
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
}
