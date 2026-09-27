import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersistedState } from './contracts.js';
import { createLogger } from './logger.js';
import { createStore, defaultState } from './store.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'automator-store-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const logger = () => createLogger({ console: false });

describe('JsonFileStore', () => {
  it('returns defaults when nothing is saved', async () => {
    const store = createStore(dir, logger());
    expect(await store.load()).toEqual(defaultState());
  });

  it('round-trips through flush, writing atomically', async () => {
    const store = createStore(dir, logger(), 10_000);
    const state: PersistedState = { ...defaultState(), scriptSettings: { 'a.js': { enabled: false } } };
    store.save(state);
    state.scriptSettings['b.js'] = { enabled: true }; // mutation after save must not leak
    await store.flush();
    const files = await fs.readdir(dir);
    expect(files).toEqual(['state.json']);
    const again = await createStore(dir, logger()).load();
    expect(again.scriptSettings).toEqual({ 'a.js': { enabled: false } });
  });

  it('debounces: only the last state is written', async () => {
    const store = createStore(dir, logger(), 20);
    for (let i = 0; i < 5; i++) store.save({ ...defaultState(), scriptSettings: { [`s${i}.js`]: { enabled: true } } });
    await new Promise((r) => setTimeout(r, 80));
    await store.flush();
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
    expect(Object.keys(raw.scriptSettings)).toEqual(['s4.js']);
  });

  it('backs up a corrupt file and starts fresh', async () => {
    await fs.writeFile(path.join(dir, 'state.json'), '{not json');
    const log = logger();
    const store = createStore(dir, log);
    expect(await store.load()).toEqual(defaultState());
    const files = await fs.readdir(dir);
    expect(files.some((f) => /^state\.json\.corrupt-\d+$/.test(f))).toBe(true);
    expect(files).not.toContain('state.json');
    expect(log.entries()[0]).toMatchObject({ level: 'warn', source: 'store' });
  });

  it('fills missing fields with defaults', async () => {
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 1, rules: [] }));
    expect(await createStore(dir, logger()).load()).toEqual(defaultState());
  });
});

describe('logger', () => {
  it('keeps the last 200 entries, most recent first, and notifies subscribers', () => {
    const log = createLogger({ console: false });
    const seen: string[] = [];
    const unsub = log.subscribe((e) => seen.push(e.message));
    for (let i = 0; i < 205; i++) log.log('info', 't', `m${i}`);
    unsub();
    log.log('info', 't', 'after');
    const entries = log.entries();
    expect(entries).toHaveLength(200);
    expect(entries[0].message).toBe('after');
    expect(entries[199].message).toBe('m6');
    expect(seen).toHaveLength(205);
  });
});
