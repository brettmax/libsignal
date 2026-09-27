import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelledError, ValidationError } from '../contracts.js';
import { alice, bob, FakeTransport, makeHarness, type Harness } from './test-helpers.js';

describe('automator core', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({ start: false });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('start loads contacts, subscribes; stop unsubscribes and flushes', async () => {
    await h.automator.start();
    expect(h.automator.contacts()[0]!.name).toBe('Alice');
    expect(h.automator.groups()[0]!.name).toBe('Friends');
    expect(h.events.some((e) => e.type === 'contacts')).toBe(true);
    expect(h.transport.subscribers).toBe(1);
    await h.automator.stop();
    expect(h.transport.subscribers).toBe(0);
    expect(h.store.flushes).toBe(1);
  });

  it('start survives a contacts failure', async () => {
    const t = new FakeTransport();
    t.failContacts = true;
    const h2 = await makeHarness({ transport: t });
    try {
      expect(h2.automator.contacts()).toEqual([]);
      expect(h2.logger.has('warn', 'engine', /contacts/)).toBe(true);
    } finally {
      await h2.cleanup();
    }
  });

  it('manual send records, emits and persists', async () => {
    await h.automator.start();
    const m = await h.automator.send(alice, 'hi', 'manual');
    expect(m).toMatchObject({ direction: 'outgoing', body: 'hi', origin: 'manual', ok: true, peer: alice });
    expect(m.id).toBe(`${m.timestamp}-outgoing-${alice.id}`);
    expect(h.events.find((e) => e.type === 'message')).toBeTruthy();
    expect(h.store.saved!.messages[0]!.id).toBe(m.id);
    await expect(h.automator.send(alice, '  ', 'manual')).rejects.toThrow(ValidationError);
  });

  it('records failed sends with ok=false and rethrows', async () => {
    await h.automator.start();
    h.transport.failSends = true;
    await expect(h.automator.send(alice, 'hi', 'manual')).rejects.toThrow('boom');
    expect(h.automator.messages()[0]).toMatchObject({ ok: false, error: 'boom', body: 'hi' });
  });

  it('caps the message log at 500, most recent first', async () => {
    await h.automator.start();
    for (let i = 0; i < 510; i++) await h.automator.simulateIncoming({ source: bob.id, body: `m${i}`, timestamp: i + 1 });
    const all = h.automator.messages();
    expect(all).toHaveLength(500);
    expect(all[0]!.body).toBe('m509');
    expect(h.automator.messages(3).map((m) => m.body)).toEqual(['m509', 'm508', 'm507']);
  });

  it('outgoing hooks modify in load order and can cancel', async () => {
    h.writeScript('1-upper.js', `export default (bot) => bot.onOutgoing((ctx) => ctx.body.toUpperCase());`);
    h.writeScript('2-sign.js', `export default (bot) => bot.onOutgoing((ctx) => { if (ctx.cancellable) return ctx.body + ' -- sent by ' + ctx.origin; });`);
    h.writeScript('3-block.js', `export default (bot) => bot.onOutgoing((ctx) => ctx.body.includes('SECRET') ? false : undefined);`);
    h.writeScript('4-throws.js', `export default (bot) => bot.onOutgoing(() => { throw new Error('hook err'); });`);
    await h.automator.start();
    const m = await h.automator.send(alice, 'hello', 'manual');
    expect(m.body).toBe('HELLO -- sent by manual');
    expect(h.transport.bodies()).toEqual(['HELLO -- sent by manual']);
    await expect(h.automator.send(alice, 'my secret', 'manual')).rejects.toBeInstanceOf(CancelledError);
    expect(h.transport.sent).toHaveLength(1);
    expect(h.logger.has('info', 'send', /cancelled by 3-block\.js/)).toBe(true);
    expect(h.automator.listScripts().find((s) => s.name === '4-throws.js')!.error).toBe('hook err');
  });

  it('sentSync runs outgoing hooks as non-cancellable, ignoring return values', async () => {
    h.writeScript(
      'watch.js',
      `export default (bot) => bot.onOutgoing((ctx) => { bot.store.set('last', { body: ctx.body, origin: ctx.origin, cancellable: ctx.cancellable, to: ctx.to }); return false; });`,
    );
    await h.automator.start();
    h.transport.emit({ kind: 'sentSync', timestamp: 123, destination: bob, body: 'from phone' });
    await vi.waitFor(() => expect(h.automator.messages()[0]?.body).toBe('from phone'));
    expect(h.automator.messages()[0]).toMatchObject({ id: `123-outgoing-${bob.id}`, origin: 'external', ok: true, peer: bob });
    const { readFileSync } = await import('node:fs');
    await vi.waitFor(() => {
      const stored = JSON.parse(readFileSync(`${h.dataDir}/script-store/watch.js.json`, 'utf8'));
      expect(stored.last).toEqual({ body: 'from phone', origin: 'external', cancellable: false, to: bob });
    });
    expect(h.transport.sent).toHaveLength(0);
  });

  it('limits recursive bot.send from outgoing hooks', async () => {
    h.writeScript(
      'loop.js',
      `export default (bot) => bot.onOutgoing(async (ctx) => { if (ctx.cancellable) await bot.send(ctx.to, 'again'); });`,
    );
    await h.automator.start();
    await h.automator.send(alice, 'start', 'manual');
    // depth 0 (manual) -> 1 -> 2 -> 3 succeed, depth 4 throws inside the hook.
    expect(h.transport.bodies()).toEqual(['again', 'again', 'again', 'start']);
    expect(h.automator.listScripts()[0]!.error).toMatch(/recursion limit/);
  });

  it('script replies do not feed back into the incoming pipeline', async () => {
    h.writeScript('echo.js', `export default (bot) => bot.onIncoming((m) => m.reply('echo ' + m.body));`);
    await h.automator.start();
    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    expect(h.transport.bodies()).toEqual(['echo x']);
    expect(h.automator.messages().map((m) => m.direction)).toEqual(['outgoing', 'incoming']);
  });
});
