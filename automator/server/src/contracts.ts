// Server-internal contracts. Written by the integrator before work was split;
// the transport/API/store side and the engine side both build against this
// file and neither may change it without the other.

import type {
  Contact,
  Group,
  KeywordRule,
  KeywordRuleInput,
  LogEntry,
  MessageOrigin,
  Recipient,
  Repeater,
  RepeaterInput,
  ScriptInfo,
  ServerEvent,
  SignalMessage,
  TransportStatus,
} from '@automator/shared';

// ---------------------------------------------------------------- transport

/** A data message someone else sent to us (1:1 or in a group). */
export interface IncomingEnvelope {
  kind: 'incoming';
  timestamp: number;
  /** Sender number, or uuid when the number is hidden. */
  source: string;
  sourceName?: string;
  /** Present for group messages. */
  groupId?: string;
  body: string;
}

/** A message the user sent from another linked device (phone / Signal Desktop). */
export interface SentSyncEnvelope {
  kind: 'sentSync';
  timestamp: number;
  destination: Recipient;
  body: string;
}

export type Envelope = IncomingEnvelope | SentSyncEnvelope;

export interface SignalTransport {
  readonly kind: TransportStatus['kind'];
  /** Resolves once connected; rejects if the first connection attempt fails. Reconnects on its own afterwards. */
  connect(): Promise<void>;
  close(): Promise<void>;
  status(): TransportStatus;
  /** Returns the Signal timestamp of the sent message. Rejects on failure. */
  send(to: Recipient, body: string): Promise<{ timestamp: number }>;
  listContacts(): Promise<Contact[]>;
  listGroups(): Promise<Group[]>;
  /** Only data messages with a non-empty body are delivered. Returns an unsubscribe function. */
  onEnvelope(cb: (e: Envelope) => void): () => void;
  onStatus(cb: (s: TransportStatus) => void): () => void;
}

// -------------------------------------------------------------------- store

export interface PersistedState {
  version: 1;
  repeaters: Repeater[];
  rules: KeywordRule[];
  /** Keyed by ScriptInfo.name. Scripts not listed are enabled by default. */
  scriptSettings: Record<string, { enabled: boolean }>;
  /** Most recent first, capped at 500. */
  messages: SignalMessage[];
}

export interface Store {
  /** Returns defaults (empty lists) when nothing has been saved yet. */
  load(): Promise<PersistedState>;
  /** Atomic write (tmp file + rename). Callers may call often; implementation debounces. */
  save(state: PersistedState): void;
  /** Flush any pending debounced write. */
  flush(): Promise<void>;
}

// ------------------------------------------------------------------ logging

export interface Logger {
  log(level: LogEntry['level'], source: string, message: string): void;
}

// ------------------------------------------------------------------- engine

export class NotFoundError extends Error {}
export class ValidationError extends Error {}
/** Thrown by Automator.send when an outgoing hook cancelled the message. */
export class CancelledError extends Error {}

export interface AutomatorDeps {
  transport: SignalTransport;
  store: Store;
  /** Absolute path to the user scripts directory (created if missing). */
  scriptsDir: string;
  /** Absolute path to the data directory; per-script stores live in <dataDir>/script-store/<name>.json. */
  dataDir: string;
  logger: Logger;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * The engine: owns all repeaters, keyword rules, scripts and the message log.
 * The HTTP layer is a thin mapping onto these methods. Methods throw
 * NotFoundError / ValidationError / CancelledError for 404 / 400 / 409.
 */
export interface Automator {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Every state change, for the WebSocket. Returns an unsubscribe function. */
  onEvent(cb: (e: ServerEvent) => void): () => void;

  contacts(): Contact[];
  groups(): Group[];
  refreshContacts(): Promise<{ contacts: Contact[]; groups: Group[] }>;
  messages(limit?: number): SignalMessage[];
  /** Runs outgoing hooks, sends, logs and emits. */
  send(to: Recipient, body: string, origin: MessageOrigin, originRef?: string): Promise<SignalMessage>;
  /** Feed a fake incoming envelope through the full pipeline. */
  simulateIncoming(e: Omit<IncomingEnvelope, 'kind' | 'timestamp'> & { timestamp?: number }): Promise<void>;

  listRepeaters(): Repeater[];
  createRepeater(input: RepeaterInput): Repeater;
  updateRepeater(id: string, patch: Partial<RepeaterInput>): Repeater;
  deleteRepeater(id: string): void;
  runRepeaterNow(id: string): Promise<Repeater>;

  listRules(): KeywordRule[];
  createRule(input: KeywordRuleInput): KeywordRule;
  updateRule(id: string, patch: Partial<KeywordRuleInput>): KeywordRule;
  deleteRule(id: string): void;
  reorderRules(ids: string[]): KeywordRule[];
  testRules(body: string, sender?: string, group?: boolean): { ruleId: string; output: string | null }[];

  listScripts(): ScriptInfo[];
  getScript(name: string): Promise<{ info: ScriptInfo; source: string }>;
  saveScript(name: string, source: string): Promise<ScriptInfo>;
  deleteScript(name: string): Promise<void>;
  setScriptEnabled(name: string, enabled: boolean): Promise<ScriptInfo>;
  reloadScripts(): Promise<ScriptInfo[]>;
}

// ------------------------------------------------------- user scripting API
//
// A user script is a plain JavaScript ES module in the scripts directory:
//
//   /** @param {import('../server/src/contracts').Bot} bot */
//   export default function setup(bot) {
//     bot.onIncoming(async (msg) => { if (msg.body === 'ping') await msg.reply('pong'); });
//   }
//
// setup() may be async. Everything a script registers is torn down when the
// script is disabled, edited or reloaded. Errors thrown by handlers are caught,
// logged under source `script:<name>` and recorded in ScriptInfo.error.

export interface IncomingContext {
  readonly message: SignalMessage;
  readonly body: string;
  readonly sender: string;
  readonly senderName?: string;
  readonly isGroup: boolean;
  /** The conversation to answer in (the group, or the sender). */
  readonly conversation: Recipient;
  reply(text: string): Promise<SignalMessage>;
}

export interface OutgoingContext {
  readonly message: SignalMessage;
  readonly to: Recipient;
  readonly body: string;
  readonly origin: MessageOrigin;
  /** False for 'external' (already sent from another device): return values are ignored. */
  readonly cancellable: boolean;
}

/**
 * Return a string to replace the body, false to cancel the send, or
 * nothing to leave it unchanged. Hooks run in script load order.
 */
export type OutgoingHook = (ctx: OutgoingContext) => void | string | false | Promise<void | string | false>;

export interface Bot {
  /** Script file name. */
  readonly name: string;
  onIncoming(handler: (ctx: IncomingContext) => void | Promise<void>): void;
  onOutgoing(hook: OutgoingHook): void;
  /** Handler for keyword rules whose action is { type: 'script', command }. `match` is the regex match or [body]. */
  command(name: string, handler: (ctx: IncomingContext, match: string[]) => void | Promise<void>): void;
  /** A string is a contact id (number/uuid), or "group:<groupId>". */
  send(to: Recipient | string, text: string): Promise<SignalMessage>;
  /** Repeat fn every `seconds` seconds until the script unloads. Returns a cancel function. */
  every(seconds: number, fn: () => void | Promise<void>): () => void;
  /** Run fn once after `seconds`. Returns a cancel function. */
  after(seconds: number, fn: () => void | Promise<void>): () => void;
  /** Resolves after `seconds` (rejects if the script unloads first). */
  sleep(seconds: number): Promise<void>;
  contacts(): Contact[];
  groups(): Group[];
  /** Per-script persistent key/value storage (JSON-serialisable values), saved under the data dir. */
  store: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): void;
  };
  log(...args: unknown[]): void;
}
