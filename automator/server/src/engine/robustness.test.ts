// Failure modes of user scripts: slow / hung callbacks, fire-and-forget
// promises, late errors, unload while sleeping.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../contracts.js';
import { ScriptStore } from './scripts.js';
import { alice, makeHarness, type Harness } from './test-helpers.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('script robustness', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({ start: false, engine: { scriptTimeoutMs: 50 } });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('a setup() that never finishes does not block start()', async () => {
    h.writeScript(
      'loop.js',
      `export default async (bot) => {
        bot.onIncoming((m) => m.reply('alive'));
        globalThis.__loops = 0;
        for (;;) { await bot.sleep(0.01); globalThis.__loops++; }
      };`,
    );
    await h.automator.start();
    expect(h.automator.listScripts()[0]).toMatchObject({ loaded: true, error: null });
    expect(h.logger.has('warn', 'script:loop.js', /still running/)).toBe(true);
    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    expect(h.transport.bodies()).toEqual(['alive']);

    await h.automator.setScriptEnabled('loop.js', false);
    const g = globalThis as unknown as Record<string, number>;
    const loops = g.__loops!;
    await wait(60);
    expect(g.__loops).toBe(loops); // the loop ended: its sleep rejected on unload
    expect(h.automator.listScripts()[0]).toMatchObject({ loaded: false, error: null });
    expect(h.logger.has('error', 'script:loop.js')).toBe(false);
  });

  it('a setup() that fails after the deadline unloads the script', async () => {
    h.writeScript(
      'late.js',
      `export default async (bot) => { bot.onIncoming((m) => m.reply('x')); await bot.sleep(0.1); throw new Error('late boom'); };`,
    );
    await h.automator.start();
    expect(h.automator.listScripts()[0]!.loaded).toBe(true);
    await vi.waitFor(() => expect(h.automator.listScripts()[0]).toMatchObject({ loaded: false, error: 'late boom' }));
    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    expect(h.transport.sent).toHaveLength(0);
  });

  it('a hung outgoing hook is skipped and the send goes ahead', async () => {
    h.writeScript('hang.js', `export default (bot) => bot.onOutgoing(() => new Promise(() => {}));`);
    h.writeScript('z.js', `export default (bot) => bot.onOutgoing((ctx) => ctx.body + '!');`);
    await h.automator.start();
    const m = await h.automator.send(alice, 'hi', 'manual');
    expect(m.body).toBe('hi!');
    expect(h.automator.listScripts()[0]!.error).toMatch(/did not finish/);
  });

  it('slow onIncoming handlers do not hold up the others, and late errors are recorded', async () => {
    h.writeScript('a.js', `export default (bot) => bot.onIncoming(async () => { await bot.sleep(0.5); throw new Error('slow fail'); });`);
    h.writeScript('b.js', `export default (bot) => bot.onIncoming((m) => m.reply('b'));`);
    await h.automator.start();
    const t0 = Date.now();
    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(h.transport.bodies()).toEqual(['b']);
    await vi.waitFor(() => expect(h.automator.listScripts()[0]!.error).toBe('slow fail'), { timeout: 3000 });
  });

  it('fire-and-forget sends that fail do not cause unhandled rejections', async () => {
    h.writeScript(
      'ff.js',
      `export default (bot) => {
        bot.onIncoming((m) => { m.reply('r'); bot.send('+15550009', 's'); bot.send('', 'bad'); bot.sleep(-1); });
      };`,
    );
    await h.automator.start();
    h.transport.failSends = true;
    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    await wait(20);
    const out = h.automator.messages().filter((m) => m.direction === 'outgoing');
    expect(out.map((m) => [m.body, m.ok])).toEqual(
      expect.arrayContaining([
        ['r', false],
        ['s', false],
      ]),
    );
    expect(h.logger.has('error', 'send', /boom/)).toBe(true);
    // Vitest fails the run on any unhandled rejection, so reaching here is the assertion.
  });

  it('pending bot.after timers do not fire after the script is disabled', async () => {
    h.writeScript('later.js', `export default (bot) => bot.onIncoming((m) => { bot.after(0.05, () => m.reply('later')); });`);
    await h.automator.start();
    await h.automator.simulateIncoming({ source: alice.id, body: 'x' });
    await h.automator.setScriptEnabled('later.js', false);
    await wait(80);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('invalid timer arguments fail setup', async () => {
    h.writeScript('bad-every.js', `export default (bot) => bot.every(0, () => {});`);
    await h.automator.start();
    expect(h.automator.listScripts()[0]).toMatchObject({ loaded: false });
    expect(h.automator.listScripts()[0]!.error).toMatch(/> 0/);
  });

  it('adopts script files that appeared since the last scan', async () => {
    await h.automator.start();
    h.writeScript('fresh.js', `export default (bot) => bot.command('hey', () => {});`);
    expect((await h.automator.getScript('fresh.js')).source).toContain('hey');
    expect(await h.automator.setScriptEnabled('fresh.js', true)).toMatchObject({ loaded: true, commands: ['hey'] });
  });
});

describe('ScriptStore', () => {
  it('handles awkward keys and rejects non-JSON values', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'automator-store-'));
    try {
      const file = path.join(dir, 's.json');
      const errors: unknown[] = [];
      const s = new ScriptStore(file, (e) => errors.push(e));
      s.set('__proto__', { polluted: true });
      s.set('d', new Date(0));
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(() => s.set('f', () => 1)).toThrow(ValidationError);
      const again = new ScriptStore(file, (e) => errors.push(e));
      expect(again.get('__proto__')).toEqual({ polluted: true });
      expect(again.get('d')).toBe('1970-01-01T00:00:00.000Z');
      expect(JSON.parse(readFileSync(file, 'utf8')).d).toBe('1970-01-01T00:00:00.000Z');
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
