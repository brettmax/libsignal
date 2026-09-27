import type { Recipient, Repeater, RepeaterInput, SignalMessage } from '@automator/shared';
import type { Logger, MessageOriginRef } from './types.js';
import { CancelledError, NotFoundError, ValidationError } from '../contracts.js';
import { newId } from './ids.js';
import { setLongTimeout } from './timers.js';

function validRecipient(r: unknown): r is Recipient {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (o.kind === 'contact' || o.kind === 'group') && typeof o.id === 'string' && o.id.trim() !== '';
}

export function validateRepeaterInput(r: RepeaterInput): void {
  if (typeof r.name !== 'string' || r.name.trim() === '') throw new ValidationError('name is required');
  if (typeof r.enabled !== 'boolean') throw new ValidationError('enabled must be a boolean');
  if (!Array.isArray(r.recipients) || r.recipients.length === 0) throw new ValidationError('at least one recipient is required');
  if (!r.recipients.every(validRecipient)) throw new ValidationError('invalid recipient');
  if (!Array.isArray(r.messages) || r.messages.some((m) => typeof m !== 'string'))
    throw new ValidationError('messages must be a list of strings');
  if (!r.messages.some((m) => m.trim() !== '')) throw new ValidationError('at least one non-empty message is required');
  if (typeof r.intervalSeconds !== 'number' || !Number.isFinite(r.intervalSeconds) || r.intervalSeconds < 1)
    throw new ValidationError('intervalSeconds must be >= 1');
  if (typeof r.jitterSeconds !== 'number' || !Number.isFinite(r.jitterSeconds) || r.jitterSeconds < 0)
    throw new ValidationError('jitterSeconds must be >= 0');
  if (r.maxRuns !== null && (typeof r.maxRuns !== 'number' || !Number.isInteger(r.maxRuns) || r.maxRuns < 1))
    throw new ValidationError('maxRuns must be null or an integer >= 1');
}

function normalize(r: RepeaterInput): RepeaterInput {
  return {
    name: r.name.trim(),
    enabled: r.enabled,
    recipients: r.recipients.map((x) => ({ kind: x.kind, id: x.id.trim() }) as Recipient),
    // Empty entries would send blank messages; drop them (at least one remains).
    messages: r.messages.filter((m) => m.trim() !== ''),
    intervalSeconds: r.intervalSeconds,
    jitterSeconds: r.jitterSeconds,
    maxRuns: r.maxRuns,
  };
}

export interface RepeaterHost {
  logger: Logger;
  now(): number;
  /** The live list (owned by the automator's state). */
  list(): Repeater[];
  send(to: Recipient, body: string, origin: MessageOriginRef): Promise<SignalMessage>;
  /** Persist + emit 'repeaters'. */
  changed(): void;
}

export class RepeaterManager {
  private timers = new Map<string, () => void>();
  private running = new Set<string>();
  /** False before startAll() and after stopAll(): no timers are armed. */
  private active = false;

  constructor(private host: RepeaterHost) {}

  private get(id: string): Repeater {
    const r = this.host.list().find((x) => x.id === id);
    if (!r) throw new NotFoundError(`repeater not found: ${id}`);
    return r;
  }

  private finished(r: Repeater): boolean {
    return r.maxRuns !== null && r.runCount >= r.maxRuns;
  }

  private clearTimer(id: string): void {
    const cancel = this.timers.get(id);
    if (cancel) cancel();
    this.timers.delete(id);
  }

  private arm(r: Repeater): void {
    this.clearTimer(r.id);
    if (!this.active || !r.enabled || r.nextRunAt === null) return;
    const id = r.id;
    const delay = Math.max(0, r.nextRunAt - this.host.now());
    this.timers.set(
      id,
      setLongTimeout(() => {
        this.timers.delete(id);
        void this.run(id, false);
      }, delay),
    );
  }

  /** Start a fresh countdown (or clear it when disabled). Does not persist. */
  private reschedule(r: Repeater): void {
    if (!r.enabled || this.finished(r)) {
      if (r.enabled && this.finished(r)) r.enabled = false;
      r.nextRunAt = null;
      this.clearTimer(r.id);
      return;
    }
    const jitterMs = r.jitterSeconds > 0 ? Math.round(Math.random() * r.jitterSeconds * 1000) : 0;
    r.nextRunAt = this.host.now() + Math.round(r.intervalSeconds * 1000) + jitterMs;
    this.arm(r);
  }

  /** After a restart: overdue repeaters run promptly (once), others resume their countdown. */
  startAll(): void {
    this.active = true;
    let dirty = false;
    for (const r of this.host.list()) {
      if (!r.enabled) {
        if (r.nextRunAt !== null) {
          r.nextRunAt = null;
          dirty = true;
        }
        continue;
      }
      if (this.finished(r)) {
        r.enabled = false;
        r.nextRunAt = null;
        dirty = true;
        continue;
      }
      if (r.nextRunAt === null) {
        this.reschedule(r);
        dirty = true;
      } else if (r.nextRunAt <= this.host.now()) {
        // Overdue: run promptly, once (missed runs are not caught up).
        this.arm(r);
      } else {
        this.arm(r);
      }
    }
    if (dirty) this.host.changed();
  }

  stopAll(): void {
    this.active = false;
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  create(input: RepeaterInput): Repeater {
    validateRepeaterInput(input);
    const n = normalize(input);
    const r: Repeater = {
      id: newId(),
      ...n,
      runCount: 0,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: this.host.now(),
    };
    this.host.list().push(r);
    this.reschedule(r);
    this.host.changed();
    return r;
  }

  update(id: string, patch: Partial<RepeaterInput>): Repeater {
    const r = this.get(id);
    const merged: RepeaterInput = {
      name: patch.name ?? r.name,
      enabled: patch.enabled ?? r.enabled,
      recipients: patch.recipients ?? r.recipients,
      messages: patch.messages ?? r.messages,
      intervalSeconds: patch.intervalSeconds ?? r.intervalSeconds,
      jitterSeconds: patch.jitterSeconds ?? r.jitterSeconds,
      maxRuns: patch.maxRuns !== undefined ? patch.maxRuns : r.maxRuns,
    };
    validateRepeaterInput(merged);
    const n = normalize(merged);
    const wasEnabled = r.enabled;
    const timingChanged =
      n.enabled !== r.enabled || n.intervalSeconds !== r.intervalSeconds || n.jitterSeconds !== r.jitterSeconds;
    Object.assign(r, n);
    // Re-enabling a repeater that already finished its runs starts it over.
    if (n.enabled && !wasEnabled && this.finished(r)) r.runCount = 0;
    if (r.enabled && this.finished(r)) {
      // maxRuns lowered to (or below) the runs already done: finished now.
      r.enabled = false;
      r.nextRunAt = null;
      this.clearTimer(r.id);
    } else if (timingChanged || (r.enabled && r.nextRunAt === null) || (!r.enabled && r.nextRunAt !== null)) {
      this.reschedule(r);
    }
    this.host.changed();
    return r;
  }

  delete(id: string): void {
    const list = this.host.list();
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) throw new NotFoundError(`repeater not found: ${id}`);
    this.clearTimer(id);
    list.splice(idx, 1);
    this.host.changed();
  }

  async runNow(id: string): Promise<Repeater> {
    this.get(id);
    await this.run(id, true);
    return this.get(id);
  }

  /** One run: send the next message in rotation to every recipient, then restart the countdown. */
  private async run(id: string, manual: boolean): Promise<void> {
    const r = this.host.list().find((x) => x.id === id);
    if (!r) return;
    if (!manual && !r.enabled) return;
    if (this.running.has(id)) {
      this.host.logger.log('warn', 'repeater', `"${r.name}" is still sending; skipped overlapping run`);
      if (!manual) this.reschedule(r);
      return;
    }
    this.clearTimer(id);
    this.running.add(id);
    const body = r.messages[r.runCount % r.messages.length] ?? '';
    const recipients = r.recipients.slice();
    r.runCount += 1;
    r.lastRunAt = this.host.now();
    try {
      for (const to of recipients) {
        try {
          await this.host.send(to, body, { origin: 'repeater', originRef: id });
        } catch (err) {
          const level = err instanceof CancelledError ? 'info' : 'error';
          this.host.logger.log(level, 'repeater', `"${r.name}" could not send to ${to.kind}:${to.id}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running.delete(id);
    }
    // The repeater may have been deleted / edited while sending.
    const cur = this.host.list().find((x) => x.id === id);
    if (!cur) return;
    if (this.finished(cur)) {
      if (cur.enabled) this.host.logger.log('info', 'repeater', `"${cur.name}" finished after ${cur.runCount} run(s)`);
      cur.enabled = false;
      cur.nextRunAt = null;
      this.clearTimer(id);
    } else if (cur.enabled) {
      this.reschedule(cur);
    } else {
      cur.nextRunAt = null;
    }
    this.host.changed();
  }
}
