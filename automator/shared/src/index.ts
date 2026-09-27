// Shared contract between the automator server and the web UI.
// TYPE-ONLY: this package is consumed with `import type` and must never
// contain runtime values, so neither side needs to build or bundle it.

/** A conversation target: a 1:1 contact (E.164 number or ACI uuid) or a group. */
export type Recipient =
  | { kind: 'contact'; id: string }
  | { kind: 'group'; id: string };

export interface Contact {
  /** E.164 number when known, otherwise the ACI uuid. Used as Recipient.id. */
  id: string;
  number?: string;
  uuid?: string;
  name?: string;
}

export interface Group {
  /** Base64 group id as reported by signal-cli. Used as Recipient.id. */
  id: string;
  name: string;
  memberCount?: number;
}

/** Why an outgoing message was sent. 'external' = sent by the user from another device (sync). */
export type MessageOrigin = 'manual' | 'repeater' | 'keyword' | 'script' | 'external';

export interface SignalMessage {
  /** Unique within the log: `${timestamp}-${direction}-${peer.id}`. */
  id: string;
  direction: 'incoming' | 'outgoing';
  /** Signal timestamp in ms since epoch. */
  timestamp: number;
  /** The conversation: the other party for 1:1, the group for group messages. */
  peer: Recipient;
  /** Incoming only: who sent it (number or uuid). */
  sender?: string;
  senderName?: string;
  body: string;
  /** Outgoing only. */
  origin?: MessageOrigin;
  /** Outgoing only: id of the repeater / rule / script name that produced it. */
  originRef?: string;
  /** Outgoing only: false when the transport rejected the send. */
  ok?: boolean;
  error?: string;
}

/** A message (or rotation of messages) sent repeatedly with a countdown pause between sends. */
export interface Repeater {
  id: string;
  name: string;
  enabled: boolean;
  recipients: Recipient[];
  /** Sent in rotation: run N sends messages[N % messages.length]. At least one entry. */
  messages: string[];
  /** Countdown pause between sends, in seconds (>= 1). */
  intervalSeconds: number;
  /** Optional random extra 0..jitterSeconds added to each pause. */
  jitterSeconds: number;
  /** Stop (and disable) after this many runs; null = forever. */
  maxRuns: number | null;
  runCount: number;
  /** When the countdown reaches zero, ms epoch. null when disabled or finished. */
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
}

export type RepeaterInput = Pick<
  Repeater,
  'name' | 'enabled' | 'recipients' | 'messages' | 'intervalSeconds' | 'jitterSeconds' | 'maxRuns'
>;

export type MatchType = 'contains' | 'exact' | 'startsWith' | 'regex' | 'word';

export type RuleAction =
  /** Reply in the conversation the message arrived in. Text is a template. */
  | { type: 'reply'; text: string }
  /** Send to a fixed recipient (e.g. forward/notify). Text is a template. */
  | { type: 'send'; to: Recipient; text: string }
  /** Invoke `bot.command(name, handler)` registered by a user script. */
  | { type: 'script'; command: string };

/**
 * Catches incoming messages matching a keyword and performs an action.
 * Templates support: {{body}} {{sender}} {{senderName}} {{match}} {{time}} {{date}}
 * and regex capture groups {{1}}..{{9}}.
 */
export interface KeywordRule {
  id: string;
  name: string;
  enabled: boolean;
  pattern: string;
  matchType: MatchType;
  caseSensitive: boolean;
  /** Which conversations the rule listens to. */
  scope: 'all' | 'direct' | 'groups';
  /** Only react to these sender ids (numbers/uuids). Empty = anyone. */
  fromFilter: string[];
  action: RuleAction;
  /** Minimum seconds between triggers per conversation. 0 = no cooldown. */
  cooldownSeconds: number;
  /** When true, later rules are not evaluated after this one matches. */
  stopProcessing: boolean;
  triggerCount: number;
  lastTriggeredAt: number | null;
  createdAt: number;
}

export type KeywordRuleInput = Pick<
  KeywordRule,
  | 'name'
  | 'enabled'
  | 'pattern'
  | 'matchType'
  | 'caseSensitive'
  | 'scope'
  | 'fromFilter'
  | 'action'
  | 'cooldownSeconds'
  | 'stopProcessing'
>;

/** A user script file in the scripts directory. */
export interface ScriptInfo {
  /** File name without directory, e.g. "auto-away.js". Unique key. */
  name: string;
  enabled: boolean;
  /** True when the script's setup() ran without throwing. */
  loaded: boolean;
  /** Last load or runtime error, if any. */
  error: string | null;
  /** Command names this script registered via bot.command(). */
  commands: string[];
  updatedAt: number;
}

export type TransportState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface TransportStatus {
  kind: 'signal-cli' | 'mock';
  state: TransportState;
  /** The linked account's number, when known. */
  account: string | null;
  detail: string | null;
}

export interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Subsystem, e.g. 'transport', 'repeater', 'rules', 'script:auto-away.js'. */
  source: string;
  message: string;
}

/** Full snapshot returned by GET /api/state and sent as the first WS event. */
export interface AppState {
  status: TransportStatus;
  contacts: Contact[];
  groups: Group[];
  repeaters: Repeater[];
  rules: KeywordRule[];
  scripts: ScriptInfo[];
  /** Most recent first, capped by the server (500). */
  messages: SignalMessage[];
  /** Most recent first, capped by the server (200). */
  logs: LogEntry[];
}

/** Server -> client events on the WebSocket at /ws. */
export type ServerEvent =
  | { type: 'snapshot'; state: AppState }
  | { type: 'status'; status: TransportStatus }
  | { type: 'message'; message: SignalMessage }
  | { type: 'repeaters'; repeaters: Repeater[] }
  | { type: 'rules'; rules: KeywordRule[] }
  | { type: 'scripts'; scripts: ScriptInfo[] }
  | { type: 'contacts'; contacts: Contact[]; groups: Group[] }
  | { type: 'log'; entry: LogEntry };

/** Body of POST /api/send. */
export interface SendRequest {
  to: Recipient;
  body: string;
}

/** Error body for any non-2xx JSON response. */
export interface ApiError {
  error: string;
}

/**
 * REST API (all JSON, all under /api, served by the server on port 7583 by default):
 *
 *   GET    /api/state                      -> AppState
 *   GET    /api/status                     -> TransportStatus
 *   POST   /api/contacts/refresh           -> { contacts: Contact[]; groups: Group[] }
 *   GET    /api/messages?limit=N           -> SignalMessage[]
 *   POST   /api/send          SendRequest  -> SignalMessage     (runs outgoing hooks; 409 if a hook cancelled it)
 *
 *   GET    /api/repeaters                  -> Repeater[]
 *   POST   /api/repeaters     RepeaterInput -> Repeater
 *   PUT    /api/repeaters/:id Partial<RepeaterInput> -> Repeater
 *   DELETE /api/repeaters/:id              -> 204
 *   POST   /api/repeaters/:id/run          -> Repeater          (send now, restart countdown)
 *
 *   GET    /api/rules                      -> KeywordRule[]     (evaluation order)
 *   POST   /api/rules         KeywordRuleInput -> KeywordRule
 *   PUT    /api/rules/:id     Partial<KeywordRuleInput> -> KeywordRule
 *   DELETE /api/rules/:id                  -> 204
 *   POST   /api/rules/reorder { ids: string[] } -> KeywordRule[]
 *   POST   /api/rules/test    { body: string; sender?: string; group?: boolean }
 *                                          -> { matches: { ruleId: string; output: string | null }[] }
 *
 *   GET    /api/scripts                    -> ScriptInfo[]
 *   GET    /api/scripts/:name              -> { info: ScriptInfo; source: string }
 *   PUT    /api/scripts/:name { source: string } -> ScriptInfo  (create or overwrite, then reload it)
 *   DELETE /api/scripts/:name              -> 204
 *   POST   /api/scripts/:name/enable  { enabled: boolean } -> ScriptInfo
 *   POST   /api/scripts/reload             -> ScriptInfo[]
 *
 *   POST   /api/simulate/incoming { from: string; body: string; groupId?: string }
 *                                          -> 204  (injects a fake incoming message; for testing rules/scripts)
 *
 *   WS     /ws                             -> stream of ServerEvent, first one is 'snapshot'
 */
export type ApiDoc = never;
