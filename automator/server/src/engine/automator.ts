import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  Contact,
  Group,
  KeywordRule,
  KeywordRuleInput,
  MessageOrigin,
  Recipient,
  Repeater,
  RepeaterInput,
  ScriptInfo,
  ServerEvent,
  SignalMessage,
} from '@automator/shared';
import type {
  Automator,
  AutomatorDeps,
  Envelope,
  IncomingContext,
  IncomingEnvelope,
  OutgoingContext,
  PersistedState,
  SentSyncEnvelope,
} from '../contracts.js';
import { CancelledError, NotFoundError, ValidationError } from '../contracts.js';
import { newId } from './ids.js';
import { RepeaterManager } from './repeaters.js';
import { normalizeRuleInput, renderAction, ruleApplies, validateRuleInput, type RuleInputMessage } from './rules.js';
import { ScriptManager, parseRecipient, type LiveHandler } from './scripts.js';
import { settleWithin, type Settled } from './settle.js';
import type { MessageOriginRef } from './types.js';

export const MESSAGE_LOG_CAP = 500;
/** bot.send from inside outgoing hooks may nest at most this deep. */
export const MAX_SEND_DEPTH = 3;
/** Default for EngineOptions.scriptTimeoutMs. */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000;

/** Engine tuning beyond the frozen AutomatorDeps contract. */
export interface EngineOptions {
  /**
   * How long the engine waits for a script callback before moving on:
   * setup() then counts as loaded, an onOutgoing hook's result is ignored
   * (the send proceeds), and the next onIncoming handler / rule starts while
   * the slow one keeps running. Late errors are still recorded.
   */
  scriptTimeoutMs?: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

function recipientKey(r: Recipient): string {
  return `${r.kind}:${r.id}`;
}

/** Fills fields that are missing / undefined in `input` from `defaults`. */
function withDefaults<T extends object>(input: T, defaults: Partial<T>): T {
  const out = { ...input } as Record<string, unknown>;
  for (const [k, v] of Object.entries(defaults)) if (out[k] === undefined) out[k] = v;
  return out as T;
}

function emptyState(): PersistedState {
  return { version: 1, repeaters: [], rules: [], scriptSettings: {}, messages: [] };
}

export class AutomatorImpl implements Automator {
  private readonly deps: AutomatorDeps;
  private readonly now: () => number;
  private state: PersistedState = emptyState();
  private contactList: Contact[] = [];
  private groupList: Group[] = [];
  private listeners = new Set<(e: ServerEvent) => void>();
  private unsubscribeEnvelope: (() => void) | null = null;
  private started = false;
  /** Last trigger time per `${ruleId}|${conversation}`. */
  private cooldowns = new Map<string, number>();
  /** Send recursion depth (outgoing hooks calling bot.send). */
  private sendDepth = new AsyncLocalStorage<number>();
  private readonly repeaters: RepeaterManager;
  private readonly scripts: ScriptManager;
  private readonly timeoutMs: number;

  constructor(deps: AutomatorDeps, opts: EngineOptions = {}) {
    this.deps = deps;
    // Resolve Date.now lazily so fake timers installed after construction still apply.
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs =
      opts.scriptTimeoutMs !== undefined && opts.scriptTimeoutMs > 0 ? opts.scriptTimeoutMs : DEFAULT_SCRIPT_TIMEOUT_MS;
    // A throwing logger must never break the engine.
    const logger = { log: (level: 'debug' | 'info' | 'warn' | 'error', source: string, message: string) => this.log(level, source, message) };
    const sendFrom = (to: Recipient, body: string, o: MessageOriginRef): Promise<SignalMessage> =>
      this.send(to, body, o.origin, o.originRef);
    this.repeaters = new RepeaterManager({
      logger,
      now: this.now,
      list: () => this.state.repeaters,
      send: sendFrom,
      changed: () => {
        this.persist();
        this.emit({ type: 'repeaters', repeaters: this.listRepeaters() });
      },
    });
    this.scripts = new ScriptManager({
      logger,
      now: this.now,
      scriptsDir: deps.scriptsDir,
      dataDir: deps.dataDir,
      timeoutMs: this.timeoutMs,
      send: sendFrom,
      contacts: () => this.contactList,
      groups: () => this.groupList,
      isEnabled: (name) => this.state.scriptSettings[name]?.enabled ?? true,
      setEnabledSetting: (name, enabled) => {
        if (enabled === undefined) delete this.state.scriptSettings[name];
        else this.state.scriptSettings[name] = { enabled };
        this.persist();
      },
      changed: () => this.emit({ type: 'scripts', scripts: this.scripts.list() }),
      detach: (fn) => this.sendDepth.exit(fn),
    });
  }

  // ---------------------------------------------------------------- plumbing

  private log(level: 'debug' | 'info' | 'warn' | 'error', source: string, message: string): void {
    try {
      this.deps.logger.log(level, source, message);
    } catch {
      // never let logging break the engine
    }
  }

  private emit(e: ServerEvent): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(e);
      } catch (err) {
        this.log('error', 'engine', `event listener failed: ${errMessage(err)}`);
      }
    }
  }

  private snapshot(): PersistedState {
    return {
      version: 1,
      repeaters: this.state.repeaters,
      rules: this.state.rules,
      scriptSettings: this.state.scriptSettings,
      messages: this.state.messages,
    };
  }

  private persist(): void {
    try {
      this.deps.store.save(this.snapshot());
    } catch (err) {
      this.log('error', 'engine', `failed to save state: ${errMessage(err)}`);
    }
  }

  private recordMessage(m: SignalMessage): SignalMessage {
    const list = this.state.messages;
    if (list.some((x) => x.id === m.id)) {
      let n = 2;
      while (list.some((x) => x.id === `${m.id}-${n}`)) n++;
      m.id = `${m.id}-${n}`;
    }
    list.unshift(m);
    if (list.length > MESSAGE_LOG_CAP) list.length = MESSAGE_LOG_CAP;
    this.persist();
    const copy = structuredClone(m);
    this.emit({ type: 'message', message: copy });
    return copy;
  }

  private emitRules(): void {
    this.emit({ type: 'rules', rules: this.listRules() });
  }

  // --------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    let loaded: PersistedState;
    try {
      loaded = await this.deps.store.load();
    } catch (err) {
      this.started = false;
      throw err;
    }
    this.state = {
      version: 1,
      repeaters: Array.isArray(loaded?.repeaters) ? loaded.repeaters : [],
      rules: Array.isArray(loaded?.rules) ? loaded.rules : [],
      scriptSettings: loaded?.scriptSettings && typeof loaded.scriptSettings === 'object' ? loaded.scriptSettings : {},
      messages: Array.isArray(loaded?.messages) ? loaded.messages.slice(0, MESSAGE_LOG_CAP) : [],
    };
    try {
      await this.refreshContacts();
    } catch (err) {
      this.log('warn', 'engine', `could not load contacts/groups: ${errMessage(err)}`);
    }
    this.unsubscribeEnvelope = this.deps.transport.onEnvelope((e) => {
      this.handleEnvelope(e).catch((err) => this.log('error', 'engine', `envelope handling failed: ${errMessage(err)}`));
    });
    try {
      await this.scripts.loadAll();
    } catch (err) {
      this.log('error', 'scripts', `failed to load scripts: ${errMessage(err)}`);
    }
    this.repeaters.startAll();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.repeaters.stopAll();
    this.unsubscribeEnvelope?.();
    this.unsubscribeEnvelope = null;
    try {
      await this.scripts.unloadAll();
    } catch (err) {
      this.log('error', 'scripts', `failed to unload scripts: ${errMessage(err)}`);
    }
    await this.deps.store.flush();
  }

  onEvent(cb: (e: ServerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ---------------------------------------------------------------- contacts

  contacts(): Contact[] {
    return structuredClone(this.contactList);
  }

  groups(): Group[] {
    return structuredClone(this.groupList);
  }

  async refreshContacts(): Promise<{ contacts: Contact[]; groups: Group[] }> {
    const [contacts, groups] = await Promise.all([this.deps.transport.listContacts(), this.deps.transport.listGroups()]);
    this.contactList = contacts;
    this.groupList = groups;
    const out = { contacts: this.contacts(), groups: this.groups() };
    this.emit({ type: 'contacts', ...out });
    return { contacts: this.contacts(), groups: this.groups() };
  }

  private contactName(id: string): string | undefined {
    return this.contactList.find((c) => c.id === id || c.number === id || c.uuid === id)?.name;
  }

  messages(limit?: number): SignalMessage[] {
    const n = limit === undefined || !Number.isFinite(limit) ? undefined : Math.max(0, Math.floor(limit));
    return structuredClone(n === undefined ? this.state.messages : this.state.messages.slice(0, n));
  }

  // -------------------------------------------------------------------- send

  /**
   * Runs a user-script callback with a deadline. Errors, including ones that
   * arrive after the deadline, are recorded against the script.
   */
  private runScript<T>(h: LiveHandler<unknown>, call: () => T | PromiseLike<T>): Promise<Settled<Awaited<T>>> {
    return settleWithin(call, this.timeoutMs, (err) => h.fail(err)).then((r) => {
      if (r.kind === 'error') h.fail(r.error);
      return r;
    });
  }

  async send(to: Recipient, body: string, origin: MessageOrigin, originRef?: string): Promise<SignalMessage> {
    let recipient: Recipient;
    try {
      recipient = parseRecipient(to);
      if (typeof body !== 'string' || body.trim() === '') throw new ValidationError('message body is required');
    } catch (err) {
      // Manual sends report this as a 400; automated ones would otherwise fail silently.
      if (origin !== 'manual') this.log('warn', 'send', `${origin} send rejected: ${errMessage(err)}`);
      throw err;
    }
    const depth = this.sendDepth.getStore() ?? 0;
    if (depth > MAX_SEND_DEPTH) {
      const msg = `send recursion limit reached (outgoing hooks nested deeper than ${MAX_SEND_DEPTH})`;
      this.log('warn', 'send', `message to ${recipientKey(recipient)} dropped: ${msg}`);
      throw new Error(msg);
    }

    const draftTs = this.now();
    const draft: SignalMessage = {
      // Provisional: the final id uses the timestamp the transport reports.
      id: `${draftTs}-outgoing-${recipient.id}`,
      direction: 'outgoing',
      timestamp: draftTs,
      peer: recipient,
      body,
      origin,
      ...(originRef !== undefined ? { originRef } : {}),
    };

    // Outgoing hooks, in script load order. Sends made from inside a hook see depth + 1.
    const finalBody = await this.sendDepth.run(depth + 1, async () => {
      let current = body;
      for (const h of this.scripts.outgoingHooks()) {
        const ctx: OutgoingContext = {
          message: { ...structuredClone(draft), body: current },
          to: structuredClone(recipient),
          body: current,
          origin,
          cancellable: true,
        };
        const r = await this.runScript(h, () => h.fn(ctx));
        if (r.kind === 'timeout') {
          h.fail(new Error(`onOutgoing hook did not finish within ${this.timeoutMs / 1000}s; its result was ignored`));
          continue;
        }
        if (r.kind === 'error') continue;
        const result: unknown = r.value;
        if (result === false) {
          this.log('info', 'send', `message to ${recipientKey(recipient)} cancelled by ${h.script}`);
          return { cancelledBy: h.script };
        }
        if (typeof result === 'string') current = result;
      }
      return current;
    });
    if (typeof finalBody !== 'string') {
      throw new CancelledError(`message cancelled by outgoing hook in ${finalBody.cancelledBy}`);
    }
    if (finalBody.trim() === '') {
      this.log('info', 'send', `message to ${recipientKey(recipient)} dropped: hooks left an empty body`);
      throw new CancelledError('message cancelled: outgoing hooks produced an empty body');
    }

    try {
      const { timestamp } = await this.deps.transport.send(recipient, finalBody);
      const ts = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : this.now();
      return this.recordMessage({
        ...draft,
        id: `${ts}-outgoing-${recipient.id}`,
        timestamp: ts,
        body: finalBody,
        ok: true,
      });
    } catch (err) {
      const ts = this.now();
      this.log('error', 'send', `failed to send to ${recipientKey(recipient)}: ${errMessage(err)}`);
      this.recordMessage({
        ...draft,
        id: `${ts}-outgoing-${recipient.id}`,
        timestamp: ts,
        body: finalBody,
        ok: false,
        error: errMessage(err),
      });
      throw err;
    }
  }

  // --------------------------------------------------------------- envelopes

  private async handleEnvelope(e: Envelope): Promise<void> {
    if (e.kind === 'incoming') await this.handleIncoming(e);
    else if (e.kind === 'sentSync') await this.handleSentSync(e);
  }

  async simulateIncoming(e: Omit<IncomingEnvelope, 'kind' | 'timestamp'> & { timestamp?: number }): Promise<void> {
    if (!e || typeof e.source !== 'string' || !e.source.trim()) throw new ValidationError('from is required');
    if (typeof e.body !== 'string' || !e.body) throw new ValidationError('body is required');
    await this.handleIncoming({
      kind: 'incoming',
      timestamp: e.timestamp ?? this.now(),
      source: e.source.trim(),
      ...(e.sourceName ? { sourceName: e.sourceName } : {}),
      ...(e.groupId ? { groupId: e.groupId } : {}),
      body: e.body,
    });
  }

  private async handleIncoming(e: IncomingEnvelope): Promise<void> {
    const isGroup = !!e.groupId;
    const peer: Recipient = e.groupId ? { kind: 'group', id: e.groupId } : { kind: 'contact', id: e.source };
    const senderName = e.sourceName || this.contactName(e.source);
    const message = this.recordMessage({
      id: `${e.timestamp}-incoming-${peer.id}`,
      direction: 'incoming',
      timestamp: e.timestamp,
      peer,
      sender: e.source,
      ...(senderName ? { senderName } : {}),
      body: e.body,
    });

    const makeCtx = (o: MessageOriginRef): IncomingContext => ({
      message: structuredClone(message),
      body: message.body,
      sender: e.source,
      ...(senderName ? { senderName } : {}),
      isGroup,
      conversation: structuredClone(peer),
      reply: (text: string) => {
        const p = this.send(peer, text == null ? '' : String(text), o.origin, o.originRef);
        // A fire-and-forget reply must not become an unhandled rejection; send() logs failures.
        p.catch(() => {});
        return p;
      },
    });

    // Keyword rules, in order.
    try {
      await this.runRules({ body: e.body, sender: e.source, senderName, isGroup }, peer, makeCtx);
    } catch (err) {
      this.log('error', 'rules', `rule evaluation failed: ${errMessage(err)}`);
    }

    // Scripts' onIncoming handlers, one after another in load order. A slow
    // handler keeps running in the background once the deadline passes.
    for (const h of this.scripts.incomingHandlers()) {
      const r = await this.runScript(h, () => h.fn(makeCtx({ origin: 'script', originRef: h.script })));
      if (r.kind === 'timeout') {
        this.log('debug', `script:${h.script}`, `onIncoming handler still running after ${this.timeoutMs / 1000}s; not waiting for it`);
      }
    }
  }

  private async handleSentSync(e: SentSyncEnvelope): Promise<void> {
    const peer = parseRecipient(e.destination);
    const message = this.recordMessage({
      id: `${e.timestamp}-outgoing-${peer.id}`,
      direction: 'outgoing',
      timestamp: e.timestamp,
      peer,
      body: e.body,
      origin: 'external',
      ok: true,
    });
    for (const h of this.scripts.outgoingHooks()) {
      const ctx: OutgoingContext = {
        message: structuredClone(message),
        to: structuredClone(peer),
        body: message.body,
        origin: 'external',
        cancellable: false,
      };
      await this.runScript(h, () => h.fn(ctx)); // return value ignored; errors recorded
    }
  }

  // ------------------------------------------------------------------- rules

  private async runRules(
    msg: RuleInputMessage,
    conversation: Recipient,
    makeCtx: (o: MessageOriginRef) => IncomingContext,
  ): Promise<void> {
    // Snapshot the order: rules edited mid-evaluation don't disturb this pass.
    for (const rule of this.state.rules.slice()) {
      if (!rule.enabled) continue;
      const match = ruleApplies(rule, msg);
      if (!match) continue;
      const now = this.now();
      const cdKey = `${rule.id}|${recipientKey(conversation)}`;
      if (rule.cooldownSeconds > 0) {
        const last = this.cooldowns.get(cdKey);
        if (last !== undefined && now - last < rule.cooldownSeconds * 1000) {
          this.log('debug', 'rules', `"${rule.name}" matched but is cooling down`);
          continue;
        }
      }
      this.cooldowns.set(cdKey, now);
      rule.triggerCount += 1;
      rule.lastTriggeredAt = now;
      this.persist();
      this.emitRules();
      this.log('info', 'rules', `"${rule.name}" triggered by ${msg.sender}`);

      const action = rule.action;
      try {
        if (action.type === 'script') {
          const cmd = this.scripts.findCommand(action.command);
          if (!cmd) {
            this.log('warn', 'rules', `"${rule.name}": no loaded script registered command "${action.command}"`);
          } else {
            const r = await this.runScript(cmd, () =>
              cmd.fn(makeCtx({ origin: 'script', originRef: cmd.script }), match.groups.slice()),
            );
            if (r.kind === 'timeout') {
              this.log('debug', `script:${cmd.script}`, `command "${action.command}" still running; continuing with later rules`);
            }
          }
        } else {
          const text = renderAction(rule, msg, match, now) ?? '';
          const to = action.type === 'reply' ? conversation : action.to;
          await this.send(to, text, 'keyword', rule.id);
        }
      } catch (err) {
        if (err instanceof CancelledError) this.log('info', 'rules', `"${rule.name}": ${err.message}`);
        else this.log('error', 'rules', `"${rule.name}" action failed: ${errMessage(err)}`);
      }
      if (rule.stopProcessing) break;
    }
  }

  listRules(): KeywordRule[] {
    return structuredClone(this.state.rules);
  }

  private findRule(id: string): KeywordRule {
    const r = this.state.rules.find((x) => x.id === id);
    if (!r) throw new NotFoundError(`rule not found: ${id}`);
    return r;
  }

  createRule(input: KeywordRuleInput): KeywordRule {
    if (!input || typeof input !== 'object') throw new ValidationError('rule is required');
    // Lenient defaults for optional-looking fields (the HTTP layer passes JSON through).
    const full = withDefaults<KeywordRuleInput>(input, {
      enabled: true,
      matchType: 'contains',
      caseSensitive: false,
      scope: 'all',
      fromFilter: [],
      cooldownSeconds: 0,
      stopProcessing: false,
    });
    validateRuleInput(full);
    const rule: KeywordRule = {
      id: newId(),
      ...normalizeRuleInput(full),
      triggerCount: 0,
      lastTriggeredAt: null,
      createdAt: this.now(),
    };
    this.state.rules.push(rule);
    this.persist();
    this.emitRules();
    return structuredClone(rule);
  }

  updateRule(id: string, patch: Partial<KeywordRuleInput>): KeywordRule {
    const rule = this.findRule(id);
    const merged: KeywordRuleInput = {
      name: rule.name,
      enabled: rule.enabled,
      pattern: rule.pattern,
      matchType: rule.matchType,
      caseSensitive: rule.caseSensitive,
      scope: rule.scope,
      fromFilter: rule.fromFilter,
      action: rule.action,
      cooldownSeconds: rule.cooldownSeconds,
      stopProcessing: rule.stopProcessing,
    };
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (v !== undefined && k in merged) (merged as unknown as Record<string, unknown>)[k] = v;
    }
    validateRuleInput(merged);
    Object.assign(rule, normalizeRuleInput(merged));
    this.persist();
    this.emitRules();
    return structuredClone(rule);
  }

  deleteRule(id: string): void {
    const idx = this.state.rules.findIndex((x) => x.id === id);
    if (idx < 0) throw new NotFoundError(`rule not found: ${id}`);
    this.state.rules.splice(idx, 1);
    for (const k of [...this.cooldowns.keys()]) if (k.startsWith(`${id}|`)) this.cooldowns.delete(k);
    this.persist();
    this.emitRules();
  }

  reorderRules(ids: string[]): KeywordRule[] {
    if (!Array.isArray(ids)) throw new ValidationError('ids must be a list');
    const existing = this.state.rules;
    const unique = new Set(ids);
    if (unique.size !== ids.length || ids.length !== existing.length || !existing.every((r) => unique.has(r.id))) {
      throw new ValidationError('ids must contain exactly the existing rule ids');
    }
    const byId = new Map(existing.map((r) => [r.id, r]));
    this.state.rules = ids.map((id) => byId.get(id)!);
    this.persist();
    this.emitRules();
    return this.listRules();
  }

  testRules(body: string, sender?: string, group?: boolean): { ruleId: string; output: string | null }[] {
    const s = sender ?? '';
    const msg: RuleInputMessage = {
      body: String(body ?? ''),
      sender: s,
      senderName: this.contactName(s),
      isGroup: !!group,
    };
    const now = this.now();
    const out: { ruleId: string; output: string | null }[] = [];
    for (const rule of this.state.rules) {
      if (!rule.enabled) continue;
      const match = ruleApplies(rule, msg);
      if (!match) continue;
      out.push({ ruleId: rule.id, output: renderAction(rule, msg, match, now) });
      if (rule.stopProcessing) break;
    }
    return out;
  }

  // --------------------------------------------------------------- repeaters

  listRepeaters(): Repeater[] {
    return structuredClone(this.state.repeaters);
  }

  createRepeater(input: RepeaterInput): Repeater {
    if (!input || typeof input !== 'object') throw new ValidationError('repeater is required');
    const full = withDefaults<RepeaterInput>(input, { enabled: true, jitterSeconds: 0, maxRuns: null });
    return structuredClone(this.repeaters.create(full));
  }

  updateRepeater(id: string, patch: Partial<RepeaterInput>): Repeater {
    return structuredClone(this.repeaters.update(id, patch ?? {}));
  }

  deleteRepeater(id: string): void {
    this.repeaters.delete(id);
  }

  async runRepeaterNow(id: string): Promise<Repeater> {
    return structuredClone(await this.repeaters.runNow(id));
  }

  // ----------------------------------------------------------------- scripts

  listScripts(): ScriptInfo[] {
    return this.scripts.list();
  }

  getScript(name: string): Promise<{ info: ScriptInfo; source: string }> {
    return this.scripts.getSource(name);
  }

  saveScript(name: string, source: string): Promise<ScriptInfo> {
    return this.scripts.save(name, source);
  }

  deleteScript(name: string): Promise<void> {
    return this.scripts.remove(name);
  }

  setScriptEnabled(name: string, enabled: boolean): Promise<ScriptInfo> {
    return this.scripts.setEnabled(name, enabled);
  }

  reloadScripts(): Promise<ScriptInfo[]> {
    return this.scripts.loadAll();
  }
}
