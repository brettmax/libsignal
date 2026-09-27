import type { Contact, Group, Recipient, TransportStatus } from '@automator/shared';
import type { Envelope, Logger, SignalTransport } from '../contracts.js';
import { SseParser } from './sse.js';

type FetchLike = typeof fetch;

export interface SignalCliTransportOptions {
  /** e.g. http://127.0.0.1:7584 */
  baseUrl: string;
  /** The user's number; sent as the JSON-RPC "account" param when set. */
  account?: string | null;
  logger: Logger;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: FetchLike;
  /** Reconnect backoff bounds in ms (default 1000..30000). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Per-RPC timeout in ms (default 60000). */
  rpcTimeoutMs?: number;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------ pure mapping

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Pulls the raw envelope and (when present) the account out of one SSE `data:` payload.
 * Accepts `{account, envelope}`, a JSON-RPC notification `{method:"receive", params:{envelope}}`
 * (params may also carry `account` / `result`), or a bare envelope.
 */
export function extractEnvelope(data: unknown): { envelope: Json; account?: string } | null {
  if (!isObj(data)) return null;
  if (isObj(data.envelope)) return { envelope: data.envelope, account: str(data.account) };
  if (isObj(data.params)) {
    const p = data.params;
    if (isObj(p.envelope)) return { envelope: p.envelope, account: str(p.account) };
    if (isObj(p.result) && isObj(p.result.envelope)) {
      return { envelope: p.result.envelope, account: str(p.result.account) ?? str(p.account) };
    }
  }
  if (isObj(data.result) && isObj(data.result.envelope)) {
    return { envelope: data.result.envelope, account: str(data.result.account) };
  }
  if (isObj(data.dataMessage) || isObj(data.syncMessage)) return { envelope: data };
  return null;
}

/** Maps a raw signal-cli envelope to our Envelope, or null when it carries no text message. */
export function mapEnvelope(env: Json): Envelope | null {
  const envTs = num(env.timestamp);
  const dm = env.dataMessage;
  if (isObj(dm)) {
    const body = typeof dm.message === 'string' ? dm.message : '';
    if (!body) return null;
    const source = str(env.sourceNumber) ?? str(env.sourceUuid) ?? str(env.source);
    if (!source) return null;
    const groupId = isObj(dm.groupInfo) ? str(dm.groupInfo.groupId) : undefined;
    const out: Envelope = {
      kind: 'incoming',
      timestamp: num(dm.timestamp) ?? envTs ?? Date.now(),
      source,
      body,
    };
    const sourceName = str(env.sourceName);
    if (sourceName) out.sourceName = sourceName;
    if (groupId) out.groupId = groupId;
    return out;
  }
  const sm = isObj(env.syncMessage) ? env.syncMessage.sentMessage : undefined;
  if (isObj(sm)) {
    const body = typeof sm.message === 'string' ? sm.message : '';
    if (!body) return null;
    const groupId = isObj(sm.groupInfo) ? str(sm.groupInfo.groupId) : undefined;
    let destination: Recipient;
    if (groupId) {
      destination = { kind: 'group', id: groupId };
    } else {
      const id = str(sm.destinationNumber) ?? str(sm.destinationUuid) ?? str(sm.destination);
      if (!id) return null;
      destination = { kind: 'contact', id };
    }
    return { kind: 'sentSync', timestamp: num(sm.timestamp) ?? envTs ?? Date.now(), destination, body };
  }
  return null;
}

export function mapContact(raw: unknown): Contact | null {
  if (!isObj(raw)) return null;
  const number = str(raw.number);
  const uuid = str(raw.uuid);
  const id = number ?? uuid;
  if (!id) return null;
  const profile = isObj(raw.profile) ? raw.profile : {};
  const join = (a: unknown, b: unknown) =>
    [str(a), str(b)].filter(Boolean).join(' ').trim() || undefined;
  const name =
    str(raw.name) ??
    join(raw.givenName, raw.familyName) ??
    join(profile.givenName, profile.familyName) ??
    str(raw.profileName);
  const c: Contact = { id };
  if (number) c.number = number;
  if (uuid) c.uuid = uuid;
  if (name) c.name = name;
  return c;
}

export function mapGroup(raw: unknown): Group | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id) ?? str(raw.groupId);
  if (!id) return null;
  const g: Group = { id, name: str(raw.name) ?? '' };
  if (Array.isArray(raw.members)) g.memberCount = raw.members.length;
  return g;
}

// --------------------------------------------------------------- transport

export class SignalCliTransport implements SignalTransport {
  readonly kind = 'signal-cli' as const;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly logger: Logger;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly rpcTimeout: number;
  private account: string | null;
  private st: TransportStatus;
  private envSubs = new Set<(e: Envelope) => void>();
  private statusSubs = new Set<(s: TransportStatus) => void>();
  private abort: AbortController | null = null;
  private closed = false;
  private started: Promise<void> | null = null;
  private rpcId = 0;
  private wakeSleep: (() => void) | null = null;

  constructor(opts: SignalCliTransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetch = opts.fetch ?? ((...a: Parameters<FetchLike>) => fetch(...a));
    this.logger = opts.logger;
    this.account = opts.account ?? null;
    this.minBackoff = opts.minBackoffMs ?? 1000;
    this.maxBackoff = opts.maxBackoffMs ?? 30000;
    this.rpcTimeout = opts.rpcTimeoutMs ?? 60000;
    this.st = { kind: 'signal-cli', state: 'disconnected', account: this.account, detail: null };
  }

  status(): TransportStatus {
    return { ...this.st };
  }

  onEnvelope(cb: (e: Envelope) => void): () => void {
    this.envSubs.add(cb);
    return () => {
      this.envSubs.delete(cb);
    };
  }

  onStatus(cb: (s: TransportStatus) => void): () => void {
    this.statusSubs.add(cb);
    return () => {
      this.statusSubs.delete(cb);
    };
  }

  connect(): Promise<void> {
    if (this.started) return this.started;
    this.closed = false;
    this.started = new Promise<void>((resolve, reject) => {
      void this.loop(resolve, reject);
    });
    return this.started;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort?.abort();
    this.wakeSleep?.();
    this.started = null;
    this.setStatus('disconnected', null);
  }

  async send(to: Recipient, body: string): Promise<{ timestamp: number }> {
    const params: Json = { message: body };
    if (to.kind === 'group') params.groupId = to.id;
    else params.recipient = [to.id];
    const result = await this.rpc('send', params);
    if (!isObj(result)) throw new RpcError('signal-cli send returned no result');
    const results = Array.isArray(result.results) ? result.results.filter(isObj) : [];
    if (results.length > 0 && results.every((r) => str(r.type) && r.type !== 'SUCCESS')) {
      const types = [...new Set(results.map((r) => String(r.type)))].join(', ');
      throw new RpcError(`send failed: ${types}`);
    }
    const ts = num(result.timestamp);
    if (ts === undefined) throw new RpcError('signal-cli send returned no timestamp');
    return { timestamp: ts };
  }

  async listContacts(): Promise<Contact[]> {
    const result = await this.rpc('listContacts', {});
    if (!Array.isArray(result)) return [];
    return result.map(mapContact).filter((c): c is Contact => c !== null);
  }

  async listGroups(): Promise<Group[]> {
    const result = await this.rpc('listGroups', {});
    if (!Array.isArray(result)) return [];
    return result.map(mapGroup).filter((g): g is Group => g !== null);
  }

  /** Raw JSON-RPC call against POST /api/v1/rpc. */
  async rpc(method: string, params: Json): Promise<unknown> {
    const id = ++this.rpcId;
    const p = this.account ? { account: this.account, ...params } : params;
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}/api/v1/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params: p, id }),
        signal: AbortSignal.timeout(this.rpcTimeout),
      });
    } catch (err) {
      throw new RpcError(`signal-cli unreachable at ${this.baseUrl}: ${errMsg(err)}`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new RpcError(`signal-cli ${method}: HTTP ${res.status}, invalid JSON response`);
    }
    if (isObj(json) && isObj(json.error)) {
      throw new RpcError(
        `signal-cli ${method}: ${str(json.error.message) ?? 'unknown error'}`,
        num(json.error.code),
      );
    }
    if (!res.ok) throw new RpcError(`signal-cli ${method}: HTTP ${res.status}`);
    return isObj(json) ? json.result : undefined;
  }

  // ---------------------------------------------------------------- receive

  private async loop(resolve: () => void, reject: (e: Error) => void): Promise<void> {
    let first = true;
    let backoff = this.minBackoff;
    while (!this.closed) {
      this.setStatus('connecting', null);
      let opened = false;
      try {
        await this.stream(() => {
          opened = true;
          backoff = this.minBackoff;
          this.setStatus('connected', null);
          this.logger.log('info', 'transport', `connected to signal-cli at ${this.baseUrl}`);
          if (first) {
            first = false;
            resolve();
          }
        });
        if (this.closed) break;
        this.setStatus('connecting', 'event stream ended; reconnecting');
        this.logger.log('warn', 'transport', 'signal-cli event stream ended; reconnecting');
      } catch (err) {
        if (this.closed) break;
        const msg = `signal-cli ${opened ? 'event stream failed' : 'unreachable'} at ${this.baseUrl}: ${errMsg(err)}`;
        this.setStatus('error', msg);
        this.logger.log(first ? 'error' : 'warn', 'transport', `${msg} (retrying in ${Math.round(backoff / 1000)}s)`);
        if (first) {
          first = false;
          reject(new Error(msg));
        }
      }
      if (this.closed) break;
      await this.sleep(backoff);
      backoff = Math.min(backoff * 2, this.maxBackoff);
    }
  }

  private async stream(onOpen: () => void): Promise<void> {
    const ac = new AbortController();
    this.abort = ac;
    try {
      const res = await this.fetch(`${this.baseUrl}/api/v1/events`, {
        headers: { accept: 'text/event-stream' },
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      onOpen();
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const ev of parser.push(decoder.decode(value, { stream: true }))) this.handleData(ev.data);
        }
        for (const ev of parser.push(decoder.decode() + '\n\n')) this.handleData(ev.data);
      } finally {
        reader.releaseLock?.();
      }
    } finally {
      if (this.abort === ac) this.abort = null;
    }
  }

  /** Handles one SSE data payload. Public for tests. */
  handleData(data: string): void {
    if (!data.trim()) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      this.logger.log('debug', 'transport', `ignoring non-JSON event: ${data.slice(0, 200)}`);
      return;
    }
    const ex = extractEnvelope(json);
    if (!ex) return;
    if (ex.account && ex.account !== this.account) {
      this.account = ex.account;
      this.st = { ...this.st, account: ex.account };
      this.emitStatus();
    }
    const env = mapEnvelope(ex.envelope);
    if (!env) return;
    for (const cb of this.envSubs) {
      try {
        cb(env);
      } catch (err) {
        this.logger.log('error', 'transport', `envelope handler threw: ${errMsg(err)}`);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        if (self.wakeSleep === done) self.wakeSleep = null;
        resolve();
      }
      this.wakeSleep = done;
    });
  }

  private setStatus(state: TransportStatus['state'], detail: string | null): void {
    if (this.st.state === state && this.st.detail === detail) return;
    this.st = { kind: 'signal-cli', state, account: this.account, detail };
    this.emitStatus();
  }

  private emitStatus(): void {
    const s = this.status();
    for (const cb of this.statusSubs) {
      try {
        cb(s);
      } catch {
        // ignore
      }
    }
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
