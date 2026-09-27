import { describe, expect, it } from 'vitest';
import type { SignalMessage } from '@automator/shared';
import { applyEvent, backoffDelay, LOG_CAP, MESSAGE_CAP } from '../useLiveState';
import { appState, repeater } from './fixtures';

const msg = (i: number): SignalMessage => ({
  id: `m${i}`,
  direction: 'incoming',
  timestamp: i,
  peer: { kind: 'contact', id: '+1' },
  body: `hello ${i}`,
});

describe('applyEvent', () => {
  it('snapshot replaces the whole state, even from null', () => {
    const s = appState();
    expect(applyEvent(null, { type: 'snapshot', state: s })).toBe(s);
    const next = appState({ contacts: [] });
    expect(applyEvent(s, { type: 'snapshot', state: next })).toBe(next);
  });

  it('ignores non-snapshot events before the first snapshot', () => {
    expect(applyEvent(null, { type: 'message', message: msg(1) })).toBeNull();
  });

  it('prepends messages and caps at 500', () => {
    let s = appState({ messages: Array.from({ length: MESSAGE_CAP }, (_, i) => msg(i)) });
    s = applyEvent(s, { type: 'message', message: msg(9999) })!;
    expect(s.messages).toHaveLength(MESSAGE_CAP);
    expect(s.messages[0]!.id).toBe('m9999');
    expect(s.messages.at(-1)!.id).toBe(`m${MESSAGE_CAP - 2}`);
  });

  it('replaces a message with the same id in place instead of duplicating', () => {
    const s = appState({ messages: [msg(2), msg(1)] });
    const updated = { ...msg(1), body: 'edited' };
    const next = applyEvent(s, { type: 'message', message: updated })!;
    expect(next.messages.map((m) => m.body)).toEqual(['hello 2', 'edited']);
  });

  it('prepends log entries and caps at 200', () => {
    const entry = (n: number) => ({ timestamp: n, level: 'info' as const, source: 't', message: `e${n}` });
    let s = appState({ logs: Array.from({ length: LOG_CAP }, (_, i) => entry(i)) });
    s = applyEvent(s, { type: 'log', entry: entry(-1) })!;
    expect(s.logs).toHaveLength(LOG_CAP);
    expect(s.logs[0]!.message).toBe('e-1');
  });

  it('replaces slices for list and status events without touching others', () => {
    const s = appState({ messages: [msg(1)] });
    const reps = [repeater()];
    const a = applyEvent(s, { type: 'repeaters', repeaters: reps })!;
    expect(a.repeaters).toBe(reps);
    expect(a.messages).toBe(s.messages);
    expect(s.repeaters).toEqual([]); // not mutated

    const b = applyEvent(a, { type: 'rules', rules: [] })!;
    expect(b.rules).toEqual([]);
    const c = applyEvent(b, { type: 'scripts', scripts: [] })!;
    expect(c.scripts).toEqual([]);
    const d = applyEvent(c, { type: 'contacts', contacts: [], groups: [{ id: 'g', name: 'G' }] })!;
    expect(d.contacts).toEqual([]);
    expect(d.groups).toEqual([{ id: 'g', name: 'G' }]);
    const status = { kind: 'signal-cli' as const, state: 'error' as const, account: null, detail: 'boom' };
    expect(applyEvent(d, { type: 'status', status })!.status).toBe(status);
  });
});

describe('backoffDelay', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
