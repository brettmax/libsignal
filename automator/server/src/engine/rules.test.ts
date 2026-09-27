import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeywordRuleInput } from '@automator/shared';
import { ValidationError } from '../contracts.js';
import { matchBody } from './rules.js';
import { renderTemplate } from './templates.js';
import { alice, bob, friends, makeHarness, type Harness } from './test-helpers.js';

const rule = (p: Partial<KeywordRuleInput> = {}): KeywordRuleInput => ({
  name: 'r',
  enabled: true,
  pattern: 'hello',
  matchType: 'contains',
  caseSensitive: false,
  scope: 'all',
  fromFilter: [],
  action: { type: 'reply', text: 'hi {{senderName}}' },
  cooldownSeconds: 0,
  stopProcessing: false,
  ...p,
});

describe('matchBody', () => {
  const m = (matchType: KeywordRuleInput['matchType'], pattern: string, body: string, caseSensitive = false) =>
    matchBody({ matchType, pattern, caseSensitive }, body);

  it('contains', () => {
    expect(m('contains', 'hello', 'well HELLO there')?.text).toBe('HELLO');
    expect(m('contains', 'hello', 'well HELLO there', true)).toBeNull();
    expect(m('contains', 'xyz', 'abc')).toBeNull();
  });
  it('exact', () => {
    expect(m('exact', 'stop', ' STOP ')).not.toBeNull();
    expect(m('exact', 'stop', 'stop now')).toBeNull();
    expect(m('exact', 'stop', 'STOP', true)).toBeNull();
  });
  it('startsWith', () => {
    expect(m('startsWith', '!echo', '!ECHO foo')?.text).toBe('!ECHO');
    expect(m('startsWith', '!echo', 'say !echo')).toBeNull();
  });
  it('word', () => {
    expect(m('word', 'cat', 'the cat sat')?.text).toBe('cat');
    expect(m('word', 'cat', 'the cat sat')?.groups).toEqual(['the cat sat']);
    expect(m('word', 'cat', 'concatenate')).toBeNull();
    expect(m('word', 'cat', 'Cat!')).not.toBeNull();
    expect(m('word', 'cat', 'Cat!', true)).toBeNull();
    expect(m('word', 'c++', 'I like c++ a lot')).not.toBeNull();
    expect(m('word', 'a.b', 'axb')).toBeNull(); // regex-escaped
  });
  it('regex', () => {
    const r = m('regex', '^order (\\d+)', 'ORDER 42 please');
    expect(r?.groups).toEqual(['ORDER 42', '42']);
    expect(m('regex', '^order (\\d+)', 'ORDER 42', true)).toBeNull();
  });
});

describe('renderTemplate', () => {
  it('fills placeholders and keeps unknown ones', () => {
    const now = new Date(2026, 2, 4, 9, 5).getTime();
    const out = renderTemplate('{{body}}|{{sender}}|{{senderName}}|{{match}}|{{time}}|{{date}}|{{1}}|{{2}}|{{nope}}', {
      body: 'B',
      sender: '+1',
      match: 'M',
      groups: ['M', 'g1'],
      now,
    });
    expect(out).toBe('B|+1|+1|M|09:05|2026-03-04|g1||{{nope}}');
  });
});

describe('keyword rules', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await h.cleanup();
  });

  it('validates', () => {
    const a = h.automator;
    expect(() => a.createRule(rule({ name: '' }))).toThrow(ValidationError);
    expect(() => a.createRule(rule({ pattern: '' }))).toThrow(ValidationError);
    expect(() => a.createRule(rule({ matchType: 'regex', pattern: '(' }))).toThrow(ValidationError);
    expect(() => a.createRule(rule({ action: { type: 'reply', text: '' } }))).toThrow(ValidationError);
    expect(() => a.createRule(rule({ action: { type: 'send', to: { kind: 'contact', id: '' }, text: 'x' } }))).toThrow(ValidationError);
    expect(() => a.createRule(rule({ action: { type: 'script', command: '' } }))).toThrow(ValidationError);
    expect(() => a.createRule(rule({ action: { type: 'bogus' } as never }))).toThrow(ValidationError);
    const r = a.createRule(rule());
    expect(() => a.updateRule(r.id, { matchType: 'regex', pattern: '[' })).toThrow(ValidationError);
  });

  it('replies in the conversation using templates and counts triggers', async () => {
    const r = h.automator.createRule(rule({ action: { type: 'reply', text: 'Hi {{senderName}}, you said "{{match}}" in "{{body}}"' } }));
    await h.automator.simulateIncoming({ source: alice.id, body: 'oh Hello!' });
    expect(h.transport.sent).toEqual([
      expect.objectContaining({ to: alice, body: 'Hi Alice, you said "Hello" in "oh Hello!"' }),
    ]);
    const out = h.automator.messages()[0]!;
    expect(out).toMatchObject({ direction: 'outgoing', origin: 'keyword', originRef: r.id, ok: true });
    const incoming = h.automator.messages()[1]!;
    expect(incoming).toMatchObject({ direction: 'incoming', sender: alice.id, senderName: 'Alice', peer: alice });
    const updated = h.automator.listRules()[0]!;
    expect(updated.triggerCount).toBe(1);
    expect(updated.lastTriggeredAt).not.toBeNull();
    expect(h.events.some((e) => e.type === 'rules')).toBe(true);
  });

  it('senderName falls back to sender; group replies go to the group', async () => {
    h.automator.createRule(rule({ action: { type: 'reply', text: 'yo {{senderName}}' } }));
    await h.automator.simulateIncoming({ source: '+19998887777', body: 'hello', groupId: friends.id });
    expect(h.transport.sent[0]).toMatchObject({ to: friends, body: 'yo +19998887777' });
    expect(h.automator.messages()[1]!.peer).toEqual(friends);
  });

  it('send action goes to a fixed recipient with regex groups', async () => {
    h.automator.createRule(
      rule({ matchType: 'regex', pattern: 'code (\\w+)-(\\d)', action: { type: 'send', to: bob, text: '{{sender}}: {{1}}/{{2}}/{{3}}' } }),
    );
    await h.automator.simulateIncoming({ source: alice.id, body: 'my code AB-7 ok' });
    expect(h.transport.sent).toEqual([expect.objectContaining({ to: bob, body: '+15550001: AB/7/' })]);
  });

  it('respects scope', async () => {
    const direct = h.automator.createRule(rule({ name: 'd', scope: 'direct', action: { type: 'reply', text: 'direct' } }));
    h.automator.createRule(rule({ name: 'g', scope: 'groups', action: { type: 'reply', text: 'group' } }));
    await h.automator.simulateIncoming({ source: alice.id, body: 'hello' });
    await h.automator.simulateIncoming({ source: alice.id, body: 'hello', groupId: 'grp1' });
    expect(h.transport.bodies()).toEqual(['direct', 'group']);
    expect(h.automator.testRules('hello', alice.id, false).map((m) => m.ruleId)).toEqual([direct.id]);
  });

  it('respects fromFilter', async () => {
    h.automator.createRule(rule({ fromFilter: [bob.id] }));
    await h.automator.simulateIncoming({ source: alice.id, body: 'hello' });
    expect(h.transport.sent).toHaveLength(0);
    await h.automator.simulateIncoming({ source: bob.id, body: 'hello' });
    expect(h.transport.sent).toHaveLength(1);
  });

  it('applies cooldown per conversation', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    h.automator.createRule(rule({ cooldownSeconds: 60 }));
    await h.automator.simulateIncoming({ source: alice.id, body: 'hello' });
    await h.automator.simulateIncoming({ source: alice.id, body: 'hello' });
    await h.automator.simulateIncoming({ source: bob.id, body: 'hello' });
    expect(h.transport.sent.map((s) => s.to.id)).toEqual([alice.id, bob.id]);
    vi.setSystemTime(Date.now() + 60_000);
    await h.automator.simulateIncoming({ source: alice.id, body: 'hello' });
    expect(h.transport.sent).toHaveLength(3);
    expect(h.automator.listRules()[0]!.triggerCount).toBe(3);
  });

  it('stopProcessing stops later rules; disabled rules are skipped', async () => {
    h.automator.createRule(rule({ name: 'off', enabled: false, action: { type: 'reply', text: 'off' } }));
    const a = h.automator.createRule(rule({ name: 'a', action: { type: 'reply', text: 'a' } }));
    const b = h.automator.createRule(rule({ name: 'b', action: { type: 'reply', text: 'b' }, stopProcessing: true }));
    const c = h.automator.createRule(rule({ name: 'c', action: { type: 'reply', text: 'c' } }));
    await h.automator.simulateIncoming({ source: alice.id, body: 'hello' });
    expect(h.transport.bodies()).toEqual(['a', 'b']);
    expect(h.automator.testRules('hello', alice.id)).toEqual([
      { ruleId: a.id, output: 'a' },
      { ruleId: b.id, output: 'b' },
    ]);
    // Reorder: c first.
    const off = h.automator.listRules()[0]!.id;
    h.automator.reorderRules([c.id, off, b.id, a.id]);
    expect(h.automator.testRules('hello', alice.id).map((m) => m.ruleId)).toEqual([c.id, b.id]);
  });

  it('testRules has no side effects and returns null for script actions', () => {
    const s = h.automator.createRule(rule({ action: { type: 'script', command: 'x' } }));
    const r = h.automator.createRule(rule({ matchType: 'word', pattern: 'hello', action: { type: 'reply', text: '{{match}}!' } }));
    expect(h.automator.testRules('HELLO world')).toEqual([
      { ruleId: s.id, output: null },
      { ruleId: r.id, output: 'HELLO!' },
    ]);
    expect(h.transport.sent).toHaveLength(0);
    expect(h.automator.listRules().every((x) => x.triggerCount === 0)).toBe(true);
    expect(h.automator.testRules('nothing')).toEqual([]);
  });

  it('reorderRules requires exactly the existing ids', () => {
    const a = h.automator.createRule(rule());
    const b = h.automator.createRule(rule());
    expect(() => h.automator.reorderRules([a.id])).toThrow(ValidationError);
    expect(() => h.automator.reorderRules([a.id, a.id])).toThrow(ValidationError);
    expect(() => h.automator.reorderRules([a.id, 'x'])).toThrow(ValidationError);
    expect(h.automator.reorderRules([b.id, a.id]).map((r) => r.id)).toEqual([b.id, a.id]);
    expect(h.store.saved!.rules.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('warns when a script command is missing', async () => {
    h.automator.createRule(rule({ action: { type: 'script', command: 'missing' } }));
    await h.automator.simulateIncoming({ source: alice.id, body: 'hello' });
    expect(h.logger.has('warn', 'rules', /missing/)).toBe(true);
  });

  it('does not run rules on the user own (sentSync) messages', async () => {
    h.automator.createRule(rule());
    h.transport.emit({ kind: 'sentSync', timestamp: 5, destination: alice, body: 'hello' });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.transport.sent).toHaveLength(0);
    expect(h.automator.messages()[0]).toMatchObject({ direction: 'outgoing', origin: 'external', body: 'hello' });
  });

  it('processes envelopes from the transport', async () => {
    h.automator.createRule(rule());
    h.transport.emit({ kind: 'incoming', timestamp: 7, source: bob.id, body: 'hello' });
    await vi.waitFor(() => expect(h.transport.sent).toHaveLength(1));
  });
});
