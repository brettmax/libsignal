import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';
import type { Contact, Group, Recipient, ScriptInfo, SignalMessage } from '@automator/shared';
import type { Bot, IncomingContext, Logger, OutgoingHook } from '../contracts.js';
import { NotFoundError, ValidationError } from '../contracts.js';
import type { MessageOriginRef } from './types.js';
import { importScript } from './loader.js';
import { settleWithin } from './settle.js';
import { setLongTimeout } from './timers.js';

export const SCRIPT_NAME_RE = /^[A-Za-z0-9._-]+\.(js|mjs)$/;

/**
 * Files starting with '.' or '_' are not scripts: '_' is reserved for helper
 * modules that scripts import relatively, '.' for hidden / loader files.
 */
export function isScriptFileName(name: string): boolean {
  return SCRIPT_NAME_RE.test(name) && !name.includes('..') && !name.startsWith('.') && !name.startsWith('_');
}

export function validateScriptName(name: string): void {
  if (typeof name !== 'string' || !SCRIPT_NAME_RE.test(name) || name.includes('..')) {
    throw new ValidationError('script name must match [A-Za-z0-9._-]+ and end in .js or .mjs');
  }
  if (!isScriptFileName(name)) {
    throw new ValidationError('script names must not start with "." or "_" (reserved for hidden files and helper modules)');
  }
}

/** Rejection reason for bot.sleep / bot.send once the script has been unloaded. */
export class ScriptUnloadedError extends Error {
  constructor(script: string) {
    super(`script ${script} was unloaded`);
    this.name = 'ScriptUnloadedError';
  }
}

type CommandHandler = (ctx: IncomingContext, match: string[]) => void | Promise<void>;
type IncomingHandler = (ctx: IncomingContext) => void | Promise<void>;

/** One load of a script. A new instance is created on every (re)load. */
interface ScriptInstance {
  alive: boolean;
  incoming: IncomingHandler[];
  outgoing: OutgoingHook[];
  commands: Map<string, CommandHandler>;
  /** Teardown callbacks: timers, pending sleeps. */
  disposers: Set<() => void>;
}

interface ScriptRecord {
  name: string;
  loaded: boolean;
  error: string | null;
  updatedAt: number;
  instance: ScriptInstance | null;
  /** Serialises load/unload of this script. */
  queue: Promise<void>;
}

export interface ScriptHost {
  logger: Logger;
  now(): number;
  scriptsDir: string;
  dataDir: string;
  /** How long setup() may run before the script counts as loaded anyway. */
  timeoutMs: number;
  send(to: Recipient, body: string, origin: MessageOriginRef): Promise<SignalMessage>;
  contacts(): Contact[];
  groups(): Group[];
  isEnabled(name: string): boolean;
  /** Persist the enabled flag in scriptSettings (undefined = remove the setting). */
  setEnabledSetting(name: string, enabled: boolean | undefined): void;
  /** Emit 'scripts'. */
  changed(): void;
  /** Runs fn outside any outgoing-hook recursion context (for timer callbacks). */
  detach<T>(fn: () => T): T;
}

export interface LiveHandler<F> {
  script: string;
  fn: F;
  /** Record a runtime error against the script (log + ScriptInfo.error). */
  fail(err: unknown): void;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function errDetail(err: unknown): string {
  return err instanceof Error && err.stack ? err.stack : errMessage(err);
}

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? a.message;
  return inspect(a, { depth: 4, breakLength: Infinity });
}

/** Accepts a Recipient or a string: a contact id (number/uuid) or "group:<groupId>". */
export function parseRecipient(to: Recipient | string): Recipient {
  if (typeof to === 'string') {
    const s = to.trim();
    if (s.startsWith('group:')) {
      const id = s.slice('group:'.length).trim();
      if (!id) throw new ValidationError('empty group id');
      return { kind: 'group', id };
    }
    if (!s) throw new ValidationError('empty recipient');
    return { kind: 'contact', id: s };
  }
  if (!to || (to.kind !== 'contact' && to.kind !== 'group') || typeof to.id !== 'string' || !to.id.trim()) {
    throw new ValidationError('invalid recipient');
  }
  return { kind: to.kind, id: to.id.trim() };
}

/** Marks a promise as handled (failures are logged elsewhere) and returns it unchanged. */
function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

export class ScriptManager {
  private records = new Map<string, ScriptRecord>();
  private stores = new Map<string, ScriptStore>();

  constructor(private host: ScriptHost) {}

  private get dir(): string {
    return this.host.scriptsDir;
  }

  private filePath(name: string): string {
    return path.join(this.dir, name);
  }

  private sorted(): ScriptRecord[] {
    return [...this.records.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  info(rec: ScriptRecord): ScriptInfo {
    return {
      name: rec.name,
      enabled: this.host.isEnabled(rec.name),
      loaded: rec.loaded,
      error: rec.error,
      commands: rec.instance ? [...rec.instance.commands.keys()] : [],
      updatedAt: rec.updatedAt,
    };
  }

  list(): ScriptInfo[] {
    return this.sorted().map((r) => this.info(r));
  }

  private newRecord(name: string, updatedAt: number): ScriptRecord {
    const rec: ScriptRecord = { name, loaded: false, error: null, updatedAt, instance: null, queue: Promise.resolve() };
    this.records.set(name, rec);
    return rec;
  }

  /** The record for `name`, adopting a file that appeared since the last scan. */
  private async ensureRecord(name: string): Promise<ScriptRecord> {
    validateScriptName(name);
    const known = this.records.get(name);
    if (known) return known;
    try {
      const st = await stat(this.filePath(name));
      if (st.isFile()) return this.records.get(name) ?? this.newRecord(name, Math.round(st.mtimeMs));
    } catch {
      // fall through
    }
    throw new NotFoundError(`script not found: ${name}`);
  }

  private enqueue(rec: ScriptRecord, op: () => Promise<void>): Promise<void> {
    const next = rec.queue.then(op, op);
    rec.queue = next.catch(() => {});
    return next;
  }

  private async scanDir(): Promise<Map<string, number>> {
    await mkdir(this.dir, { recursive: true });
    const entries = await readdir(this.dir, { withFileTypes: true });
    const out = new Map<string, number>();
    for (const e of entries) {
      if (!e.isFile() || !isScriptFileName(e.name)) continue; // subdirectories are ignored
      try {
        out.set(e.name, (await stat(this.filePath(e.name))).mtimeMs);
      } catch {
        // vanished between readdir and stat
      }
    }
    return out;
  }

  /** Rescan the directory and (re)load every enabled script, alphabetically. */
  async loadAll(): Promise<ScriptInfo[]> {
    await this.unloadAll();
    const files = await this.scanDir();
    for (const name of [...this.records.keys()]) if (!files.has(name)) this.records.delete(name);
    for (const [name, mtime] of files) {
      const rec = this.records.get(name);
      if (rec) rec.updatedAt = Math.round(mtime);
      else this.newRecord(name, Math.round(mtime));
    }
    for (const rec of this.sorted()) {
      await this.enqueue(rec, async () => {
        this.doUnload(rec);
        rec.error = null;
        if (this.host.isEnabled(rec.name)) await this.doLoad(rec);
      });
    }
    this.host.changed();
    return this.list();
  }

  async unloadAll(): Promise<void> {
    for (const rec of this.sorted()) await this.enqueue(rec, async () => this.doUnload(rec));
  }

  async getSource(name: string): Promise<{ info: ScriptInfo; source: string }> {
    const rec = await this.ensureRecord(name);
    let source: string;
    try {
      source = await readFile(this.filePath(name), 'utf8');
    } catch {
      throw new NotFoundError(`script not found: ${name}`);
    }
    return { info: this.info(rec), source };
  }

  async save(name: string, source: string): Promise<ScriptInfo> {
    validateScriptName(name);
    if (typeof source !== 'string') throw new ValidationError('source must be a string');
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.filePath(name), source, 'utf8');
    const rec = this.records.get(name) ?? this.newRecord(name, this.host.now());
    try {
      rec.updatedAt = Math.round((await stat(this.filePath(name))).mtimeMs);
    } catch {
      rec.updatedAt = this.host.now();
    }
    await this.enqueue(rec, async () => {
      this.doUnload(rec);
      rec.error = null;
      if (this.host.isEnabled(name)) await this.doLoad(rec);
    });
    this.host.logger.log('info', 'scripts', `saved ${name}`);
    this.host.changed();
    return this.info(rec);
  }

  async remove(name: string): Promise<void> {
    const rec = await this.ensureRecord(name);
    await this.enqueue(rec, async () => this.doUnload(rec));
    try {
      await unlink(this.filePath(name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.records.delete(name);
    this.stores.delete(name); // the store file itself is kept
    this.host.setEnabledSetting(name, undefined);
    this.host.logger.log('info', 'scripts', `deleted ${name}`);
    this.host.changed();
  }

  async setEnabled(name: string, enabled: boolean): Promise<ScriptInfo> {
    if (typeof enabled !== 'boolean') throw new ValidationError('enabled must be a boolean');
    const rec = await this.ensureRecord(name);
    this.host.setEnabledSetting(name, enabled);
    await this.enqueue(rec, async () => {
      this.doUnload(rec);
      rec.error = null;
      if (enabled) await this.doLoad(rec);
    });
    this.host.logger.log('info', 'scripts', `${enabled ? 'enabled' : 'disabled'} ${name}`);
    this.host.changed();
    return this.info(rec);
  }

  // ------------------------------------------------------------ live handlers

  private live(): { rec: ScriptRecord; inst: ScriptInstance }[] {
    const out: { rec: ScriptRecord; inst: ScriptInstance }[] = [];
    for (const rec of this.sorted()) if (rec.instance?.alive && rec.loaded) out.push({ rec, inst: rec.instance });
    return out;
  }

  /** onIncoming handlers of loaded scripts, in load order. */
  incomingHandlers(): LiveHandler<IncomingHandler>[] {
    return this.live().flatMap(({ rec, inst }) =>
      inst.incoming.map((fn) => ({ script: rec.name, fn, fail: (e: unknown) => this.runtimeError(rec, inst, e) })),
    );
  }

  /** onOutgoing hooks of loaded scripts, in load order. */
  outgoingHooks(): LiveHandler<OutgoingHook>[] {
    return this.live().flatMap(({ rec, inst }) =>
      inst.outgoing.map((fn) => ({ script: rec.name, fn, fail: (e: unknown) => this.runtimeError(rec, inst, e) })),
    );
  }

  /** The handler registered via bot.command(command); the first script in load order wins. */
  findCommand(command: string): LiveHandler<CommandHandler> | null {
    for (const { rec, inst } of this.live()) {
      const fn = inst.commands.get(command);
      if (fn) return { script: rec.name, fn, fail: (e: unknown) => this.runtimeError(rec, inst, e) };
    }
    return null;
  }

  private runtimeError(rec: ScriptRecord, inst: ScriptInstance, err: unknown): void {
    const source = `script:${rec.name}`;
    if (err instanceof ScriptUnloadedError || !inst.alive) {
      // Expected fallout of an unload (e.g. a pending bot.sleep rejecting).
      this.host.logger.log('debug', source, `after unload: ${errMessage(err)}`);
      return;
    }
    this.host.logger.log('error', source, errDetail(err));
    if (rec.instance !== inst) return;
    rec.error = errMessage(err);
    this.host.changed();
  }

  // ------------------------------------------------------------ load / unload

  private doUnload(rec: ScriptRecord): void {
    const inst = rec.instance;
    rec.instance = null;
    rec.loaded = false;
    if (!inst) return;
    inst.alive = false;
    for (const d of [...inst.disposers]) {
      try {
        d();
      } catch {
        // ignore teardown errors
      }
    }
    inst.disposers.clear();
    inst.incoming.length = 0;
    inst.outgoing.length = 0;
    inst.commands.clear();
  }

  /** Imports the script's current source and runs setup(bot). Never throws. */
  private async doLoad(rec: ScriptRecord): Promise<void> {
    this.doUnload(rec);
    const inst: ScriptInstance = { alive: true, incoming: [], outgoing: [], commands: new Map(), disposers: new Set() };
    rec.instance = inst;
    const source = `script:${rec.name}`;
    try {
      if (!existsSync(this.filePath(rec.name))) throw new Error(`script file not found: ${rec.name}`);
      const mod = await importScript(this.filePath(rec.name));
      const setup = mod.default;
      if (typeof setup !== 'function') throw new Error('script must `export default function setup(bot) { ... }`');
      // A fresh store per load re-reads the file; bot.store always talks to the current one.
      this.stores.set(rec.name, this.newStore(rec.name));
      const bot = this.makeBot(rec, inst);
      const result = await settleWithin(
        () => this.host.detach(() => (setup as (bot: Bot) => unknown)(bot)),
        this.host.timeoutMs,
        (err) => this.lateSetupFailure(rec, inst, err),
      );
      if (result.kind === 'error') throw result.error;
      if (!inst.alive) return; // unloaded while setting up
      if (result.kind === 'timeout') {
        this.host.logger.log(
          'warn',
          source,
          `setup() still running after ${this.host.timeoutMs / 1000}s; treating the script as loaded`,
        );
      }
      rec.loaded = true;
      rec.error = null;
      this.host.logger.log('info', 'scripts', `loaded ${rec.name}`);
    } catch (err) {
      if (!inst.alive) {
        // Unloaded (disabled, edited, stopped) while loading: not a script error.
        this.host.logger.log('debug', source, `load abandoned: ${errMessage(err)}`);
        return;
      }
      this.host.logger.log('error', source, `failed to load: ${errDetail(err)}`);
      if (rec.instance === inst) {
        this.doUnload(rec);
        rec.error = errMessage(err);
      }
    }
  }

  /** setup() rejected after the load already counted as successful: the load failed after all. */
  private lateSetupFailure(rec: ScriptRecord, inst: ScriptInstance, err: unknown): void {
    if (err instanceof ScriptUnloadedError || !inst.alive || rec.instance !== inst) {
      this.host.logger.log('debug', `script:${rec.name}`, `setup() ended after unload: ${errMessage(err)}`);
      return;
    }
    this.host.logger.log('error', `script:${rec.name}`, `setup() failed: ${errDetail(err)}`);
    this.doUnload(rec);
    rec.error = errMessage(err);
    this.host.changed();
  }

  private newStore(name: string): ScriptStore {
    return new ScriptStore(path.join(this.host.dataDir, 'script-store', `${name}.json`), (e) =>
      this.host.logger.log('error', `script:${name}`, `store: ${errMessage(e)}`),
    );
  }

  private storeFor(name: string): ScriptStore {
    let s = this.stores.get(name);
    if (!s) {
      s = this.newStore(name);
      this.stores.set(name, s);
    }
    return s;
  }

  // ------------------------------------------------------------------- bot

  private makeBot(rec: ScriptRecord, inst: ScriptInstance): Bot {
    const host = this.host;
    const name = rec.name;
    const logSource = `script:${name}`;
    const fail = (e: unknown): void => this.runtimeError(rec, inst, e);
    const ensureAlive = (what: string): boolean => {
      if (inst.alive) return true;
      host.logger.log('warn', logSource, `${what} ignored: script is unloaded`);
      return false;
    };
    const seconds = (s: unknown, what: string, allowZero: boolean): number => {
      if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || (!allowZero && s === 0)) {
        throw new ValidationError(`${what}: seconds must be a number ${allowZero ? '>= 0' : '> 0'}`);
      }
      return s;
    };
    /** Timer callbacks: errors (sync or async) are recorded against the script. */
    const runGuarded = (fn: () => void | Promise<void>): void => {
      host.detach(() => {
        try {
          const r = fn();
          if (r && typeof (r as Promise<void>).then === 'function') (r as Promise<void>).then(undefined, fail);
        } catch (e) {
          fail(e);
        }
      });
    };
    const storeFor = (): ScriptStore => this.storeFor(name);

    const bot: Bot = {
      name,
      onIncoming(handler) {
        if (typeof handler !== 'function') throw new ValidationError('onIncoming expects a function');
        if (ensureAlive('onIncoming')) inst.incoming.push(handler);
      },
      onOutgoing(hook) {
        if (typeof hook !== 'function') throw new ValidationError('onOutgoing expects a function');
        if (ensureAlive('onOutgoing')) inst.outgoing.push(hook);
      },
      command(cmd, handler) {
        if (typeof cmd !== 'string' || !cmd.trim()) throw new ValidationError('command name must be a non-empty string');
        if (typeof handler !== 'function') throw new ValidationError('command expects a handler function');
        if (!ensureAlive('command')) return;
        inst.commands.set(cmd.trim(), handler);
        if (rec.instance === inst && rec.loaded) host.changed();
      },
      send(to, text) {
        // Pre-handled: a fire-and-forget send must not become an unhandled
        // rejection. Failures are logged by the engine either way.
        return handled(
          (async () => {
            if (!inst.alive) throw new ScriptUnloadedError(name);
            return host.send(parseRecipient(to), text == null ? '' : String(text), { origin: 'script', originRef: name });
          })(),
        );
      },
      every(s, fn) {
        const ms = 1000 * seconds(s, 'every', false);
        if (typeof fn !== 'function') throw new ValidationError('every expects a function');
        if (!ensureAlive('every')) return () => {};
        let cancelTimer: (() => void) | null = null;
        const dispose = (): void => {
          cancelTimer?.();
          cancelTimer = null;
          inst.disposers.delete(dispose);
        };
        const tick = (): void => {
          cancelTimer = setLongTimeout(() => {
            if (!inst.alive || !inst.disposers.has(dispose)) return;
            tick(); // schedule the next run first: runs may overlap, like setInterval
            runGuarded(fn);
          }, ms);
        };
        inst.disposers.add(dispose);
        tick();
        return dispose;
      },
      after(s, fn) {
        const ms = 1000 * seconds(s, 'after', true);
        if (typeof fn !== 'function') throw new ValidationError('after expects a function');
        if (!ensureAlive('after')) return () => {};
        const dispose = (): void => {
          cancel();
          inst.disposers.delete(dispose);
        };
        const cancel = setLongTimeout(() => {
          inst.disposers.delete(dispose);
          if (inst.alive) runGuarded(fn);
        }, ms);
        inst.disposers.add(dispose);
        return dispose;
      },
      sleep(s) {
        return handled(
          new Promise<void>((resolve, reject) => {
            const ms = 1000 * seconds(s, 'sleep', true);
            if (!inst.alive) throw new ScriptUnloadedError(name);
            const dispose = (): void => {
              cancel();
              inst.disposers.delete(dispose);
              reject(new ScriptUnloadedError(name));
            };
            const cancel = setLongTimeout(() => {
              inst.disposers.delete(dispose);
              resolve();
            }, ms);
            inst.disposers.add(dispose);
          }),
        );
      },
      contacts: () => structuredClone(host.contacts()),
      groups: () => structuredClone(host.groups()),
      store: {
        get: <T = unknown>(key: string): T | undefined => storeFor().get(key) as T | undefined,
        set: (key: string, value: unknown) => storeFor().set(key, value),
        delete: (key: string) => storeFor().delete(key),
      },
      log: (...args: unknown[]) => host.logger.log('info', logSource, args.map(formatArg).join(' ')),
    };
    return Object.freeze(bot);
  }
}

/** Write-through JSON key/value file for one script (sync fs, tmp file + rename). */
export class ScriptStore {
  private data: Map<string, unknown> | null = null;

  constructor(
    private file: string,
    private onError: (e: unknown) => void,
  ) {}

  private load(): Map<string, unknown> {
    if (this.data) return this.data;
    const data = new Map<string, unknown>();
    try {
      if (existsSync(this.file)) {
        const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) data.set(k, v);
        } else {
          throw new Error('store file is not a JSON object');
        }
      }
    } catch (e) {
      this.onError(e);
      // Keep the unreadable file for inspection rather than silently overwriting it.
      try {
        copyFileSync(this.file, `${this.file}.corrupt`);
      } catch {
        // ignore
      }
    }
    this.data = data;
    return data;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data ?? []), null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  get(key: string): unknown {
    const v = this.load().get(String(key));
    return v === undefined ? undefined : structuredClone(v);
  }

  set(key: string, value: unknown): void {
    const data = this.load();
    if (value === undefined) {
      data.delete(String(key));
    } else {
      const json = JSON.stringify(value);
      if (json === undefined) throw new ValidationError('store values must be JSON-serialisable');
      data.set(String(key), JSON.parse(json) as unknown);
    }
    this.persist();
  }

  delete(key: string): void {
    if (this.load().delete(String(key))) this.persist();
  }
}
