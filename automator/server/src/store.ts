import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger, PersistedState, Store } from './contracts.js';

export function defaultState(): PersistedState {
  return { version: 1, repeaters: [], rules: [], scriptSettings: {}, messages: [] };
}

export interface JsonStoreOptions {
  dataDir: string;
  logger: Logger;
  /** Debounce delay for save(), ms (default 250). */
  debounceMs?: number;
}

export class JsonFileStore implements Store {
  readonly file: string;
  private readonly debounceMs: number;
  private pending: PersistedState | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Serialises writes so two renames never race. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly opts: JsonStoreOptions) {
    this.file = path.join(opts.dataDir, 'state.json');
    this.debounceMs = opts.debounceMs ?? 250;
  }

  async load(): Promise<PersistedState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultState();
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      const def = defaultState();
      return {
        version: 1,
        repeaters: Array.isArray(parsed.repeaters) ? parsed.repeaters : def.repeaters,
        rules: Array.isArray(parsed.rules) ? parsed.rules : def.rules,
        scriptSettings:
          parsed.scriptSettings && typeof parsed.scriptSettings === 'object' && !Array.isArray(parsed.scriptSettings)
            ? parsed.scriptSettings
            : def.scriptSettings,
        messages: Array.isArray(parsed.messages) ? parsed.messages : def.messages,
      };
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        await fs.rename(this.file, backup);
      } catch {
        // ignore: we still start fresh
      }
      this.opts.logger.log(
        'warn',
        'store',
        `state.json is unreadable (${(err as Error).message}); moved it to ${path.basename(backup)} and started fresh`,
      );
      return defaultState();
    }
  }

  save(state: PersistedState): void {
    // Snapshot now so later mutations by the caller don't leak into the write.
    this.pending = JSON.parse(JSON.stringify(state)) as PersistedState;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.writePending();
    }, this.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.writePending();
  }

  private writePending(): Promise<void> {
    const state = this.pending;
    this.pending = null;
    if (state) {
      this.writing = this.writing.then(() => this.writeFile(state)).catch((err: unknown) => {
        this.opts.logger.log('error', 'store', `failed to write state: ${(err as Error).message}`);
      });
    }
    return this.writing;
  }

  private async writeFile(state: PersistedState): Promise<void> {
    await fs.mkdir(this.opts.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, this.file);
  }
}

export function createStore(dataDir: string, logger: Logger, debounceMs?: number): JsonFileStore {
  return new JsonFileStore({ dataDir, logger, debounceMs });
}
