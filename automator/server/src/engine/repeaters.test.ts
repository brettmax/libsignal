import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepeaterInput } from '@automator/shared';
import { ValidationError, NotFoundError } from '../contracts.js';
import { alice, bob, makeHarness, type Harness } from './test-helpers.js';
import { setLongTimeout, MAX_TIMEOUT_MS } from './timers.js';

const base: RepeaterInput = {
  name: 'Ping',
  enabled: true,
  recipients: [alice],
  messages: ['one', 'two', 'three'],
  intervalSeconds: 60,
  jitterSeconds: 0,
  maxRuns: null,
};

describe('repeaters', () => {
  let h: Harness;
  beforeEach(async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T12:00:00Z') });
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
    vi.useRealTimers();
  });

  it('validates input', () => {
    const bad: Partial<RepeaterInput>[] = [
      { name: ' ' },
      { recipients: [] },
      { messages: [] },
      { messages: ['', '  '] },
      { intervalSeconds: 0.5 },
      { jitterSeconds: -1 },
      { maxRuns: 0 },
    ];
    for (const b of bad) expect(() => h.automator.createRepeater({ ...base, ...b })).toThrow(ValidationError);
    expect(() => h.automator.updateRepeater('nope', {})).toThrow(NotFoundError);
  });

  it('counts down, rotates messages and emits', async () => {
    const r = h.automator.createRepeater({ ...base, recipients: [alice, bob] });
    expect(r.nextRunAt).toBe(Date.now() + 60_000);
    expect(h.events.some((e) => e.type === 'repeaters')).toBe(true);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.transport.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.transport.bodies()).toEqual(['one', 'one']);
    expect(h.transport.sent.map((s) => s.to.id)).toEqual([alice.id, bob.id]);

    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(h.transport.bodies()).toEqual(['one', 'one', 'two', 'two', 'three', 'three', 'one', 'one']);
    const cur = h.automator.listRepeaters()[0]!;
    expect(cur.runCount).toBe(4);
    expect(cur.lastRunAt).toBe(Date.now());
    expect(cur.nextRunAt).toBe(Date.now() + 60_000);
    const msgs = h.automator.messages();
    expect(msgs[0]!.origin).toBe('repeater');
    expect(msgs[0]!.originRef).toBe(r.id);
    expect(h.store.saved!.repeaters[0]!.runCount).toBe(4);
  });

  it('adds jitter within bounds', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const r = h.automator.createRepeater({ ...base, jitterSeconds: 10 });
    expect(r.nextRunAt).toBe(Date.now() + 65_000);
  });

  it('disables after maxRuns', async () => {
    h.automator.createRepeater({ ...base, intervalSeconds: 5, maxRuns: 2 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.transport.bodies()).toEqual(['one', 'two']);
    const r = h.automator.listRepeaters()[0]!;
    expect(r.enabled).toBe(false);
    expect(r.nextRunAt).toBeNull();
    expect(r.runCount).toBe(2);
  });

  it('disabling clears the countdown; re-enabling restarts it', async () => {
    const r = h.automator.createRepeater(base);
    const off = h.automator.updateRepeater(r.id, { enabled: false });
    expect(off.nextRunAt).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.transport.sent).toHaveLength(0);
    const on = h.automator.updateRepeater(r.id, { enabled: true, intervalSeconds: 10 });
    expect(on.nextRunAt).toBe(Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.transport.sent).toHaveLength(1);
  });

  it('changing the interval reschedules', async () => {
    const r = h.automator.createRepeater(base);
    await vi.advanceTimersByTimeAsync(30_000);
    const u = h.automator.updateRepeater(r.id, { intervalSeconds: 5 });
    expect(u.nextRunAt).toBe(Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.transport.sent).toHaveLength(1);
    // Renaming does not reset the countdown.
    const before = h.automator.listRepeaters()[0]!.nextRunAt;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.automator.updateRepeater(r.id, { name: 'Renamed' }).nextRunAt).toBe(before);
  });

  it('runRepeaterNow sends immediately and restarts the countdown', async () => {
    const r = h.automator.createRepeater(base);
    await vi.advanceTimersByTimeAsync(50_000);
    const after = await h.automator.runRepeaterNow(r.id);
    expect(h.transport.bodies()).toEqual(['one']);
    expect(after.runCount).toBe(1);
    expect(after.nextRunAt).toBe(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(10_000); // old countdown would have fired here
    expect(h.transport.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(h.transport.bodies()).toEqual(['one', 'two']);
  });

  it('keeps going when sends fail', async () => {
    h.transport.failSends = true;
    h.automator.createRepeater({ ...base, intervalSeconds: 1 });
    await vi.advanceTimersByTimeAsync(3_000);
    const r = h.automator.listRepeaters()[0]!;
    expect(r.runCount).toBe(3);
    expect(r.enabled).toBe(true);
    expect(h.automator.messages()[0]!.ok).toBe(false);
    expect(h.logger.has('error', 'repeater')).toBe(true);
  });

  it('delete stops the timer', async () => {
    const r = h.automator.createRepeater({ ...base, intervalSeconds: 1 });
    h.automator.deleteRepeater(r.id);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.transport.sent).toHaveLength(0);
    expect(() => h.automator.deleteRepeater(r.id)).toThrow(NotFoundError);
  });

  it('after restart, an overdue repeater runs once promptly', async () => {
    h.automator.createRepeater({ ...base, intervalSeconds: 60 });
    const pending = h.automator.createRepeater({ ...base, name: 'later', intervalSeconds: 3600, messages: ['later'] });
    await h.automator.stop();
    // Down for ~10 minutes: 10 runs of the first repeater were missed.
    vi.setSystemTime(Date.now() + 600_000);
    const h2 = await h.restart();
    h = h2;
    const restartedAt = Date.now();
    await vi.advanceTimersByTimeAsync(10);
    expect(h2.transport.bodies()).toEqual(['one']);
    const [r1, r2] = h2.automator.listRepeaters();
    expect(r1!.runCount).toBe(1);
    expect(r1!.nextRunAt).toBe(restartedAt + 60_000);
    // The other one keeps its original deadline.
    expect(r2!.nextRunAt).toBe(pending.nextRunAt);
    await vi.advanceTimersByTimeAsync(3_000_000);
    expect(h2.transport.bodies().filter((b) => b === 'later')).toHaveLength(1);
  });
});

describe('setLongTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('handles delays beyond 2^31-1 ms', async () => {
    const fn = vi.fn();
    setLongTimeout(fn, MAX_TIMEOUT_MS * 2 + 5);
    await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_MS * 2);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled', async () => {
    const fn = vi.fn();
    const cancel = setLongTimeout(fn, MAX_TIMEOUT_MS + 10);
    await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_MS);
    cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('repeater edge cases', () => {
  let h: Harness;
  beforeEach(async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T12:00:00Z') });
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
    vi.useRealTimers();
  });

  it('lowering maxRuns to the runs already done finishes the repeater', async () => {
    const r = h.automator.createRepeater({ ...base, intervalSeconds: 1 });
    await vi.advanceTimersByTimeAsync(3_000);
    const u = h.automator.updateRepeater(r.id, { maxRuns: 2 });
    expect(u).toMatchObject({ enabled: false, nextRunAt: null, runCount: 3 });
    // Re-enabling a finished repeater starts it over.
    const again = h.automator.updateRepeater(r.id, { enabled: true, maxRuns: 2 });
    expect(again).toMatchObject({ enabled: true, runCount: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.automator.listRepeaters()[0]).toMatchObject({ enabled: false, runCount: 2 });
  });

  it('no timers remain after stop(), even when a run happens afterwards', async () => {
    const r = h.automator.createRepeater(base);
    await h.automator.stop();
    expect(vi.getTimerCount()).toBe(0);
    await h.automator.runRepeaterNow(r.id);
    expect(vi.getTimerCount()).toBe(0);
  });
});
