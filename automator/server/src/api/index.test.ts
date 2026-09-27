import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { KeywordRule, Repeater, ServerEvent, SignalMessage } from '@automator/shared';
import { CancelledError, NotFoundError, ValidationError, type Automator } from '../contracts.js';
import { createLogger } from '../logger.js';
import { MockTransport } from '../transport/mock.js';
import { createApi } from './index.js';

const calls: { method: string; args: unknown[] }[] = [];
const eventSubs = new Set<(e: ServerEvent) => void>();
const repeater = { id: 'r1', name: 'R' } as Repeater;
const rule = { id: 'k1', name: 'K' } as KeywordRule;
const msg = { id: 'm1', body: 'hi' } as SignalMessage;

function rec(method: string, ...args: unknown[]) {
  calls.push({ method, args });
}

const fake: Automator = {
  async start() {},
  async stop() {},
  onEvent(cb) {
    eventSubs.add(cb);
    return () => eventSubs.delete(cb);
  },
  contacts: () => [{ id: '+1', name: 'A' }],
  groups: () => [],
  refreshContacts: async () => ({ contacts: [], groups: [] }),
  messages: (limit) => (rec('messages', limit), [msg]),
  async send(to, body, origin) {
    rec('send', to, body, origin);
    if (body === 'cancel') throw new CancelledError('cancelled by hook');
    if (body === 'boom') throw new Error('kaboom');
    return msg;
  },
  simulateIncoming: async (e) => rec('simulateIncoming', e),
  listRepeaters: () => [repeater],
  createRepeater: (input) => (rec('createRepeater', input), repeater),
  updateRepeater(id, patch) {
    rec('updateRepeater', id, patch);
    if (id !== 'r1') throw new NotFoundError(`repeater ${id} not found`);
    return repeater;
  },
  deleteRepeater(id) {
    if (id !== 'r1') throw new NotFoundError('nope');
  },
  runRepeaterNow: async () => repeater,
  listRules: () => [rule],
  createRule(input) {
    rec('createRule', input);
    if (input.pattern === '(') throw new ValidationError('bad regex');
    return rule;
  },
  updateRule: () => rule,
  deleteRule: () => {},
  reorderRules: (ids) => (rec('reorderRules', ids), [rule]),
  testRules: (body, sender, group) => (rec('testRules', body, sender, group), [{ ruleId: 'k1', output: 'x' }]),
  listScripts: () => [],
  getScript: async (name) => {
    throw new NotFoundError(`script ${name} not found`);
  },
  saveScript: async (name, source) => (rec('saveScript', name, source), { name, enabled: true, loaded: true, error: null, commands: [], updatedAt: 1 }),
  deleteScript: async (name) => rec('deleteScript', name),
  setScriptEnabled: async (name, enabled) => ({ name, enabled, loaded: true, error: null, commands: [], updatedAt: 1 }),
  reloadScripts: async () => [],
};

const logger = createLogger({ console: false });
const transport = new MockTransport(logger);
let server: http.Server;
let base: string;
let closeWs: () => void;
let webDist: string;

beforeAll(async () => {
  webDist = await fs.mkdtemp(path.join(os.tmpdir(), 'automator-web-'));
  await fs.writeFile(path.join(webDist, 'index.html'), '<html>app</html>');
  await fs.writeFile(path.join(webDist, 'app.js'), 'console.log(1)');
  await transport.connect();
  const api = createApi({ automator: fake, logger, transport, webDist });
  server = http.createServer(api.app);
  closeWs = api.attachWebSocket(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  closeWs();
  await new Promise((r) => server.close(r));
  await fs.rm(webDist, { recursive: true, force: true });
});

async function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as any };
}

describe('REST API', () => {
  it('GET /api/state assembles AppState', async () => {
    logger.log('info', 'test', 'hello log');
    const { status, json } = await req('GET', '/api/state');
    expect(status).toBe(200);
    expect(json.status).toMatchObject({ kind: 'mock', state: 'connected' });
    expect(json.contacts).toEqual([{ id: '+1', name: 'A' }]);
    expect(json.repeaters).toEqual([repeater]);
    expect(json.rules).toEqual([rule]);
    expect(json.messages).toEqual([msg]);
    expect(json.logs[0]).toMatchObject({ source: 'test', message: 'hello log' });
  });

  it('GET /api/status and /api/messages?limit', async () => {
    expect((await req('GET', '/api/status')).json.kind).toBe('mock');
    expect((await req('GET', '/api/messages?limit=5')).status).toBe(200);
    expect(calls.at(-1)).toEqual({ method: 'messages', args: [5] });
    expect((await req('GET', '/api/messages?limit=abc')).status).toBe(400);
  });

  it('POST /api/send maps errors', async () => {
    const to = { kind: 'contact', id: '+1' };
    expect(await req('POST', '/api/send', { to, body: 'hi' })).toEqual({ status: 200, json: msg });
    expect(calls.at(-1)).toEqual({ method: 'send', args: [to, 'hi', 'manual'] });
    expect((await req('POST', '/api/send', { to, body: 'cancel' })).status).toBe(409);
    const boom = await req('POST', '/api/send', { to, body: 'boom' });
    expect(boom).toEqual({ status: 500, json: { error: 'kaboom' } });
    expect((await req('POST', '/api/send', { to: { kind: 'x', id: '1' }, body: 'hi' })).status).toBe(400);
    expect((await req('POST', '/api/send', { to })).status).toBe(400);
    const bad = await req('POST', '/api/send', '{oops');
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('invalid JSON body');
  });

  it('repeater routes', async () => {
    const input = { name: 'R', recipients: [{ kind: 'group', id: 'G' }], messages: ['a'], intervalSeconds: 10 };
    expect((await req('POST', '/api/repeaters', input)).status).toBe(200);
    expect(calls.at(-1)!.args[0]).toEqual({ ...input, enabled: true, jitterSeconds: 0, maxRuns: null });
    expect((await req('POST', '/api/repeaters', { name: 'R' })).status).toBe(400);
    expect((await req('POST', '/api/repeaters', { ...input, intervalSeconds: '10' })).status).toBe(400);
    expect((await req('PUT', '/api/repeaters/r1', { enabled: false, bogus: 1 })).status).toBe(200);
    expect(calls.at(-1)).toEqual({ method: 'updateRepeater', args: ['r1', { enabled: false }] });
    const nf = await req('PUT', '/api/repeaters/zz', {});
    expect(nf).toEqual({ status: 404, json: { error: 'repeater zz not found' } });
    expect((await req('DELETE', '/api/repeaters/r1')).status).toBe(204);
    expect((await req('DELETE', '/api/repeaters/zz')).status).toBe(404);
    expect((await req('POST', '/api/repeaters/r1/run')).json).toEqual(repeater);
    expect((await req('GET', '/api/repeaters')).json).toEqual([repeater]);
  });

  it('rule routes', async () => {
    const action = { type: 'reply', text: 'pong' };
    expect((await req('POST', '/api/rules', { pattern: 'ping', action })).status).toBe(200);
    expect(calls.at(-1)!.args[0]).toMatchObject({ name: 'ping', matchType: 'contains', scope: 'all', action });
    expect((await req('POST', '/api/rules', { pattern: '(', action })).status).toBe(400);
    expect((await req('POST', '/api/rules', { pattern: 'x', action: { type: 'dance' } })).status).toBe(400);
    expect((await req('POST', '/api/rules', { pattern: 'x', action, matchType: 'fuzzy' })).status).toBe(400);
    expect((await req('POST', '/api/rules/reorder', { ids: ['k1'] })).json).toEqual([rule]);
    expect((await req('POST', '/api/rules/reorder', { ids: [1] })).status).toBe(400);
    const t = await req('POST', '/api/rules/test', { body: 'ping', group: true });
    expect(t.json).toEqual({ matches: [{ ruleId: 'k1', output: 'x' }] });
    expect(calls.at(-1)).toEqual({ method: 'testRules', args: ['ping', undefined, true] });
    expect((await req('PUT', '/api/rules/k1', { enabled: true })).status).toBe(200);
    expect((await req('DELETE', '/api/rules/k1')).status).toBe(204);
  });

  it('script routes validate names', async () => {
    expect((await req('PUT', '/api/scripts/auto.js', { source: 'x' })).json.name).toBe('auto.js');
    expect(calls.at(-1)).toEqual({ method: 'saveScript', args: ['auto.js', 'x'] });
    expect((await req('PUT', '/api/scripts/auto.js', { source: 1 })).status).toBe(400);
    expect((await req('PUT', '/api/scripts/auto.txt', { source: 'x' })).status).toBe(400);
    expect((await req('PUT', '/api/scripts/..evil.js', { source: 'x' })).status).toBe(400);
    expect((await req('GET', '/api/scripts/%2e%2e%2fetc.js')).status).toBe(400);
    expect((await req('GET', '/api/scripts/missing.js')).status).toBe(404);
    expect((await req('DELETE', '/api/scripts/auto.mjs')).status).toBe(204);
    expect((await req('POST', '/api/scripts/auto.js/enable', { enabled: false })).json.enabled).toBe(false);
    expect((await req('POST', '/api/scripts/auto.js/enable', {})).status).toBe(400);
    expect((await req('POST', '/api/scripts/reload')).json).toEqual([]);
    expect((await req('GET', '/api/scripts')).json).toEqual([]);
  });

  it('simulate, contacts refresh and unknown routes', async () => {
    expect((await req('POST', '/api/simulate/incoming', { from: '+1', body: 'ping', groupId: 'G' })).status).toBe(204);
    expect(calls.at(-1)).toEqual({ method: 'simulateIncoming', args: [{ source: '+1', body: 'ping', groupId: 'G' }] });
    expect((await req('POST', '/api/simulate/incoming', { body: 'x' })).status).toBe(400);
    expect((await req('POST', '/api/contacts/refresh')).json).toEqual({ contacts: [], groups: [] });
    const nf = await req('GET', '/api/nope');
    expect(nf.status).toBe(404);
    expect(typeof nf.json.error).toBe('string');
  });

  it('bodiless POSTs work with or without a JSON content type', async () => {
    for (const headers of [{}, { 'content-type': 'application/json' }] as Record<string, string>[]) {
      const r1 = await fetch(base + '/api/contacts/refresh', { method: 'POST', headers });
      expect(r1.status).toBe(200);
      const r2 = await fetch(base + '/api/repeaters/r1/run', { method: 'POST', headers });
      expect(r2.status).toBe(200);
      const r3 = await fetch(base + '/api/scripts/reload', { method: 'POST', headers });
      expect(r3.status).toBe(200);
    }
    const del = await fetch(base + '/api/rules/k1', { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe('');
  });

  it('rejects foreign hosts and origins', async () => {
    const r = await req('POST', '/api/send', { to: { kind: 'contact', id: '+1' }, body: 'hi' }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    const r2 = await new Promise<number>((resolve) => {
      http.get(base + '/api/state', { headers: { host: 'evil.example:7583' } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
    });
    expect(r2).toBe(403);
    expect((await req('GET', '/api/state', undefined, { origin: base })).status).toBe(200);
  });

  it('serves the web UI with SPA fallback', async () => {
    expect((await req('GET', '/')).json).toBe('<html>app</html>');
    expect((await req('GET', '/app.js')).json).toBe('console.log(1)');
    expect((await req('GET', '/repeaters/r1')).json).toBe('<html>app</html>');
  });
});

describe('WebSocket', () => {
  it('sends a snapshot then forwards events, logs and status', async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    const events: ServerEvent[] = [];
    const waitFor = (n: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(events.map((e) => e.type))}`)), 2000);
        const check = () => {
          if (events.length >= n) {
            clearTimeout(t);
            resolve();
          } else setTimeout(check, 5);
        };
        check();
      });
    ws.on('message', (d) => events.push(JSON.parse(String(d))));
    await waitFor(1);
    expect(events[0].type).toBe('snapshot');
    for (const cb of eventSubs) cb({ type: 'repeaters', repeaters: [repeater] });
    logger.log('warn', 'test', 'ws log');
    await transport.close();
    await waitFor(4);
    expect(events.slice(1).map((e) => e.type)).toEqual(['repeaters', 'log', 'status']);
    expect(events[3]).toMatchObject({ type: 'status', status: { state: 'disconnected' } });
    ws.close();
  });

  it('refuses other paths and foreign origins', async () => {
    const fail = (url: string, opts?: object) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(url, opts);
        ws.on('open', () => {
          ws.close();
          resolve(false);
        });
        ws.on('error', () => resolve(true));
      });
    expect(await fail(base.replace('http', 'ws') + '/other')).toBe(true);
    expect(await fail(base.replace('http', 'ws') + '/ws', { origin: 'https://evil.example' })).toBe(true);
  });
});

describe('startup readiness', () => {
  it('answers /api/status at once but holds other routes and the WS snapshot until ready', async () => {
    let markReady!: () => void;
    const ready = new Promise<void>((r) => (markReady = r));
    const api = createApi({ automator: fake, logger, transport, ready });
    const srv = http.createServer(api.app);
    const close = api.attachWebSocket(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      expect((await fetch(url + '/api/status')).status).toBe(200);
      let stateDone = false;
      const state = fetch(url + '/api/state').then((r) => ((stateDone = true), r.status));
      const got: string[] = [];
      const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
      ws.on('message', (d) => got.push(JSON.parse(String(d)).type));
      await new Promise((r) => ws.on('open', r));
      logger.log('info', 'test', 'before ready'); // must not reach the client before its snapshot
      await new Promise((r) => setTimeout(r, 50));
      expect(stateDone).toBe(false);
      expect(got).toEqual([]);
      markReady();
      expect(await state).toBe(200);
      const deadline = Date.now() + 2000;
      while (got.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      expect(got).toEqual(['snapshot']);
      ws.close();
    } finally {
      close();
      await new Promise((r) => srv.close(r));
    }
  });

  it('returns 503 when startup failed', async () => {
    const ready = Promise.reject(new Error('boom'));
    const api = createApi({ automator: fake, logger, transport, ready });
    const srv = http.createServer(api.app);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const r = await fetch(url + '/api/state');
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'server failed to start' });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
