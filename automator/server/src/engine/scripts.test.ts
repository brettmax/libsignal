import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError } from '../contracts.js';
import { alice, bob, makeHarness, MemoryStore, type Harness } from './test-helpers.js';

describe('scripts', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({ start: false });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await h.cleanup();
  });

  it('loads scripts alphabetically on start and runs onIncoming handlers', async () => {
    h.writeScript('b.js', `export default (bot) => bot.onIncoming((m) => { if (m.body === 'ping') return m.reply('pong from ' + bot.name); });`);
    h.writeScript('a.mjs', `export default async (bot) => { await null; bot.onIncoming((m) => m.reply('a saw ' + m.body + ' ' + m.isGroup)); };`);
    h.writeScript('notes.txt', 'ignored');
    await h.automator.start();
    expect(h.automator.listScripts().map((s) => [s.name, s.loaded, s.enabled])).toEqual([
      ['a.mjs', true, true],
      ['b.js', true, true],
    ]);
    await h.automator.simulateIncoming({ source: alice.id, body: 'ping' });
    expect(h.transport.bodies()).toEqual(['a saw ping false', 'pong from b.js']);
    expect(h.automator.messages()[0]).toMatchObject({ origin: 'script', originRef: 'b.js' });
  });

  it('records load errors and runtime errors without stopping other handlers', async () => {
    h.writeScript('bad.js', `export default () => { throw new Error('setup broke'); };`);
    h.writeScript('nodefault.js', `export const x = 1;`);
    h.writeScript('syntax.js', `export default (bot) => {`);
    h.writeScript('throws.js', `export default (bot) => bot.onIncoming(() => { throw new Error('handler broke'); });`);
    h.writeScript('zz.js', `export default (bot) => bot.onIncoming((m) => m.reply('still here'));`);
    await h.automator.start();
    const byName = Object.fromEntries(h.automator.listScripts().map((s) => [s.name, s]));
    expect(byName['bad.js']).toMatchObject({ loaded: false, error: 'setup broke' });
    expect(byName['nodefault.js']!.loaded).toBe(false);
    expect(byName['nodefault.js']!.error).toMatch(/export default/);
    expect(byName['syntax.js']!.loaded).toBe(false);
    expect(byName['syntax.js']!.error).toBeTruthy();
    expect(byName['throws.js']!.loaded).toBe(true);

    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    expect(h.transport.bodies()).toEqual(['still here']);
    const t = h.automator.listScripts().find((s) => s.name === 'throws.js')!;
    expect(t).toMatchObject({ loaded: true, error: 'handler broke' });
    expect(h.logger.has('error', 'script:throws.js', /handler broke/)).toBe(true);
  });

  it('saveScript validates names, reloads edits and getScript returns source', async () => {
    await h.automator.start();
    await expect(h.automator.saveScript('../evil.js', '')).rejects.toThrow(ValidationError);
    await expect(h.automator.saveScript('a..b.js', '')).rejects.toThrow(ValidationError);
    await expect(h.automator.saveScript('x.ts', '')).rejects.toThrow(ValidationError);
    await expect(h.automator.getScript('nope.js')).rejects.toThrow(NotFoundError);

    const v1 = `export default (bot) => bot.onIncoming((m) => m.reply('v1'));`;
    const info = await h.automator.saveScript('echo.js', v1);
    expect(info).toMatchObject({ name: 'echo.js', loaded: true, enabled: true, error: null });
    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    await h.automator.saveScript('echo.js', `export default (bot) => bot.onIncoming((m) => m.reply('v2'));`);
    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    expect(h.transport.bodies()).toEqual(['v1', 'v2']);
    expect((await h.automator.getScript('echo.js')).source).toContain("'v2'");
    expect(h.events.filter((e) => e.type === 'scripts').length).toBeGreaterThan(0);
  });

  it('enable/disable persists and unloads; delete removes file and setting', async () => {
    await h.automator.start();
    await h.automator.saveScript('s.js', `export default (bot) => bot.onIncoming((m) => m.reply('on'));`);
    const off = await h.automator.setScriptEnabled('s.js', false);
    expect(off).toMatchObject({ enabled: false, loaded: false });
    expect(h.store.saved!.scriptSettings['s.js']).toEqual({ enabled: false });
    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    expect(h.transport.sent).toHaveLength(0);

    // Stays disabled after reloadScripts.
    await h.automator.reloadScripts();
    expect(h.automator.listScripts()[0]).toMatchObject({ enabled: false, loaded: false });

    expect(await h.automator.setScriptEnabled('s.js', true)).toMatchObject({ enabled: true, loaded: true });
    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    expect(h.transport.sent).toHaveLength(1);

    await h.automator.deleteScript('s.js');
    expect(existsSync(path.join(h.scriptsDir, 's.js'))).toBe(false);
    expect(h.store.saved!.scriptSettings['s.js']).toBeUndefined();
    expect(h.automator.listScripts()).toEqual([]);
    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    expect(h.transport.sent).toHaveLength(1);
    await expect(h.automator.deleteScript('s.js')).rejects.toThrow(NotFoundError);
  });

  it('skips _helpers and dot files but lets scripts import helpers relatively', async () => {
    h.writeScript('_util.js', `export const greet = (n) => 'hi ' + n;`);
    h.writeScript('.hidden.js', `export default () => { throw new Error('should not load'); };`);
    h.writeScript('main.js', `import { greet } from './_util.js';\nexport default (bot) => bot.onIncoming((m) => m.reply(greet(m.sender)));`);
    await h.automator.start();
    expect(h.automator.listScripts().map((s) => s.name)).toEqual(['main.js']);
    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    expect(h.transport.bodies()).toEqual(['hi +15550001']);
    await expect(h.automator.saveScript('_x.js', '')).rejects.toThrow(ValidationError);
    // No loader copies are left behind.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(h.scriptsDir).sort()).toEqual(['.hidden.js', '_util.js', 'main.js']);
  });

  it('reloadScripts picks up new and removed files', async () => {
    await h.automator.start();
    expect(h.automator.listScripts()).toEqual([]);
    h.writeScript('new.js', `export default () => {};`);
    expect((await h.automator.reloadScripts()).map((s) => s.name)).toEqual(['new.js']);
  });

  it('bot.command is invoked by script rule actions with the match', async () => {
    h.writeScript(
      'cmd.js',
      `export default (bot) => bot.command('order', async (ctx, match) => { await ctx.reply('order ' + match[1] + ' for ' + ctx.sender); });`,
    );
    await h.automator.start();
    expect(h.automator.listScripts()[0]!.commands).toEqual(['order']);
    h.automator.createRule({
      name: 'orders',
      enabled: true,
      pattern: 'order #(\\d+)',
      matchType: 'regex',
      caseSensitive: false,
      scope: 'all',
      fromFilter: [],
      action: { type: 'script', command: 'order' },
      cooldownSeconds: 0,
      stopProcessing: false,
    });
    await h.automator.simulateIncoming({ source: alice.id, body: 'Order #42 please' });
    expect(h.transport.sent).toEqual([expect.objectContaining({ to: alice, body: 'order 42 for +15550001' })]);
  });

  it('bot.every / after / sleep are torn down on unload', async () => {
    vi.useFakeTimers();
    h.writeScript(
      'timer.js',
      `export default (bot) => {
        bot.every(10, () => bot.send('+15550002', 'tick'));
        bot.after(25, () => bot.send('group:grp1', 'after'));
        globalThis.__sleepResult = bot.sleep(1000).then(() => 'resolved', (e) => 'rejected: ' + e.message);
      };`,
    );
    await h.automator.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.transport.bodies()).toEqual(['tick', 'tick', 'after', 'tick']);
    expect(h.transport.sent[0]!.to).toEqual(bob);
    expect(h.transport.sent[2]!.to).toEqual({ kind: 'group', id: 'grp1' });
    expect(h.automator.messages()[0]).toMatchObject({ origin: 'script', originRef: 'timer.js' });

    await h.automator.setScriptEnabled('timer.js', false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.transport.sent).toHaveLength(4);
    expect(await (globalThis as Record<string, unknown>).__sleepResult).toMatch(/^rejected/);
  });

  it('bot.store persists across reloads and restarts', async () => {
    const src = `export default (bot) => {
      const n = (bot.store.get('count') ?? 0) + 1;
      bot.store.set('count', n);
      bot.store.set('obj', { a: [1, 2] });
      bot.store.set('gone', 1);
      bot.store.delete('gone');
      bot.log('count is', n, { n });
      bot.command('count', (ctx) => ctx.reply('count ' + bot.store.get('count')));
    };`;
    h.writeScript('counter.js', src);
    await h.automator.start();
    await h.automator.reloadScripts();
    const file = path.join(h.dataDir, 'script-store', 'counter.js.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ count: 2, obj: { a: [1, 2] } });
    const h2 = await h.restart();
    h = h2;
    expect(JSON.parse(readFileSync(file, 'utf8')).count).toBe(3);
    expect(h2.logger.has('info', 'script:counter.js', /count is 3/)).toBe(true);
  });

  it('respects scriptSettings from the store', async () => {
    const store = new MemoryStore({ version: 1, repeaters: [], rules: [], scriptSettings: { 'off.js': { enabled: false } }, messages: [] });
    const h2 = await makeHarness({ start: false, store });
    try {
      h2.writeScript('off.js', `export default () => {};`);
      await h2.automator.start();
      expect(h2.automator.listScripts()[0]).toMatchObject({ enabled: false, loaded: false });
    } finally {
      await h2.cleanup();
    }
  });

  it('bot.contacts / groups expose transport data', async () => {
    h.writeScript('c.js', `export default (bot) => bot.command('who', (ctx) => ctx.reply(bot.contacts()[0].name + '/' + bot.groups()[0].name));`);
    await h.automator.start();
    h.automator.createRule({
      name: 'who', enabled: true, pattern: 'who', matchType: 'exact', caseSensitive: false, scope: 'all',
      fromFilter: [], action: { type: 'script', command: 'who' }, cooldownSeconds: 0, stopProcessing: false,
    });
    await h.automator.simulateIncoming({ source: alice.id, body: 'who' });
    expect(h.transport.bodies()).toEqual(['Alice/Friends']);
  });
});
