// Test fixtures for the engine tests (not a test file itself).
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Contact, Group, LogEntry, Recipient, ServerEvent, TransportStatus } from '@automator/shared';
import type { Automator, Envelope, Logger, PersistedState, SignalTransport, Store } from '../contracts.js';
import { createAutomator, type EngineOptions } from './index.js';

export class FakeTransport implements SignalTransport {
  readonly kind = 'mock' as const;
  sent: { to: Recipient; body: string; timestamp: number }[] = [];
  contacts: Contact[] = [{ id: '+15550001', number: '+15550001', name: 'Alice' }];
  groups: Group[] = [{ id: 'grp1', name: 'Friends' }];
  failSends = false;
  failContacts = false;
  private envCbs = new Set<(e: Envelope) => void>();
  private ts = 1_000;

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  status(): TransportStatus {
    return { kind: 'mock', state: 'connected', account: '+15559999', detail: null };
  }
  async send(to: Recipient, body: string): Promise<{ timestamp: number }> {
    if (this.failSends) throw new Error('boom');
    const timestamp = Date.now() + this.ts++;
    this.sent.push({ to, body, timestamp });
    return { timestamp };
  }
  async listContacts(): Promise<Contact[]> {
    if (this.failContacts) throw new Error('no contacts');
    return this.contacts;
  }
  async listGroups(): Promise<Group[]> {
    if (this.failContacts) throw new Error('no groups');
    return this.groups;
  }
  onEnvelope(cb: (e: Envelope) => void): () => void {
    this.envCbs.add(cb);
    return () => this.envCbs.delete(cb);
  }
  onStatus(): () => void {
    return () => {};
  }
  emit(e: Envelope): void {
    for (const cb of this.envCbs) cb(e);
  }
  get subscribers(): number {
    return this.envCbs.size;
  }
  bodies(): string[] {
    return this.sent.map((s) => s.body);
  }
}

export class MemoryStore implements Store {
  saved: PersistedState | null = null;
  saves = 0;
  flushes = 0;
  constructor(initial?: PersistedState) {
    if (initial) this.saved = structuredClone(initial);
  }
  async load(): Promise<PersistedState> {
    return this.saved
      ? structuredClone(this.saved)
      : { version: 1, repeaters: [], rules: [], scriptSettings: {}, messages: [] };
  }
  save(state: PersistedState): void {
    this.saves++;
    this.saved = structuredClone(state);
  }
  async flush(): Promise<void> {
    this.flushes++;
  }
}

export class MemoryLogger implements Logger {
  entries: Omit<LogEntry, 'timestamp'>[] = [];
  log(level: LogEntry['level'], source: string, message: string): void {
    this.entries.push({ level, source, message });
  }
  has(level: LogEntry['level'], source: string | RegExp, message?: RegExp): boolean {
    return this.entries.some(
      (e) =>
        e.level === level &&
        (typeof source === 'string' ? e.source === source : source.test(e.source)) &&
        (!message || message.test(e.message)),
    );
  }
}

export interface Harness {
  automator: Automator;
  transport: FakeTransport;
  store: MemoryStore;
  logger: MemoryLogger;
  events: ServerEvent[];
  root: string;
  scriptsDir: string;
  dataDir: string;
  writeScript(name: string, source: string): void;
  /** Recreate the automator on the same dirs/store (simulated restart). */
  restart(): Promise<Harness>;
  cleanup(): Promise<void>;
}

export async function makeHarness(
  opts: { start?: boolean; store?: MemoryStore; root?: string; transport?: FakeTransport; engine?: EngineOptions } = {},
): Promise<Harness> {
  const root = opts.root ?? mkdtempSync(path.join(tmpdir(), 'automator-engine-'));
  const scriptsDir = path.join(root, 'scripts');
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const transport = opts.transport ?? new FakeTransport();
  const store = opts.store ?? new MemoryStore();
  const logger = new MemoryLogger();
  const automator = createAutomator({ transport, store, scriptsDir, dataDir, logger }, opts.engine);
  const events: ServerEvent[] = [];
  automator.onEvent((e) => events.push(e));
  const h: Harness = {
    automator,
    transport,
    store,
    logger,
    events,
    root,
    scriptsDir,
    dataDir,
    writeScript(name, source) {
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(path.join(scriptsDir, name), source);
    },
    async restart() {
      await automator.stop();
      const next = await makeHarness({ store, root, transport: new FakeTransport(), start: false, engine: opts.engine });
      await next.automator.start();
      return next;
    },
    async cleanup() {
      await automator.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
  if (opts.start !== false) await automator.start();
  return h;
}

export const alice: Recipient = { kind: 'contact', id: '+15550001' };
export const bob: Recipient = { kind: 'contact', id: '+15550002' };
export const friends: Recipient = { kind: 'group', id: 'grp1' };
