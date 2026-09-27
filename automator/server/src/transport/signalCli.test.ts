import { describe, expect, it } from 'vitest';
import type { TransportStatus } from '@automator/shared';
import type { Envelope } from '../contracts.js';
import { createLogger } from '../logger.js';
import { SseParser } from './sse.js';
import { extractEnvelope, mapContact, mapEnvelope, mapGroup, SignalCliTransport } from './signalCli.js';

const logger = () => createLogger({ console: false });

describe('SseParser', () => {
  it('parses events split across arbitrary chunks and line endings', () => {
    const p = new SseParser();
    const text = ': comment\r\ndata: {"a":1}\r\n\r\nevent: receive\ndata: line1\ndata:line2\n\nid: 7\rdata: x\r\r';
    const events = [];
    for (let i = 0; i < text.length; i += 3) events.push(...p.push(text.slice(i, i + 3)));
    expect(events).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: 'receive', data: 'line1\nline2' },
      { event: 'message', data: 'x', id: '7' },
    ]);
  });

  it('ignores blank events', () => {
    expect(new SseParser().push('\n\n:keepalive\n\n')).toEqual([]);
  });
});

const dataEnv = {
  source: '+15551112222',
  sourceNumber: '+15551112222',
  sourceUuid: 'uuid-1',
  sourceName: 'Alice',
  timestamp: 1700000000000,
  dataMessage: { timestamp: 1700000000001, message: 'hello', groupInfo: { groupId: 'G1==', type: 'DELIVER' } },
};

describe('envelope mapping', () => {
  it('extracts wrapped, jsonrpc and bare envelopes', () => {
    expect(extractEnvelope({ account: '+1', envelope: dataEnv })).toEqual({ envelope: dataEnv, account: '+1' });
    expect(extractEnvelope({ jsonrpc: '2.0', method: 'receive', params: { envelope: dataEnv } })?.envelope).toBe(dataEnv);
    expect(extractEnvelope({ jsonrpc: '2.0', method: 'receive', params: { result: { envelope: dataEnv } } })?.envelope).toBe(dataEnv);
    expect(extractEnvelope(dataEnv)?.envelope).toBe(dataEnv);
    expect(extractEnvelope({ foo: 1 })).toBeNull();
    expect(extractEnvelope('x')).toBeNull();
  });

  it('maps data messages', () => {
    expect(mapEnvelope(dataEnv)).toEqual({
      kind: 'incoming',
      timestamp: 1700000000001,
      source: '+15551112222',
      sourceName: 'Alice',
      groupId: 'G1==',
      body: 'hello',
    });
    const noNumber = { sourceUuid: 'uuid-9', timestamp: 5, dataMessage: { message: 'hi' } };
    expect(mapEnvelope(noNumber)).toEqual({ kind: 'incoming', timestamp: 5, source: 'uuid-9', body: 'hi' });
  });

  it('skips envelopes without text', () => {
    expect(mapEnvelope({ sourceNumber: '+1', dataMessage: { message: null, reaction: {} } })).toBeNull();
    expect(mapEnvelope({ sourceNumber: '+1', receiptMessage: { isDelivery: true } })).toBeNull();
    expect(mapEnvelope({ sourceNumber: '+1', typingMessage: { action: 'STARTED' } })).toBeNull();
    expect(mapEnvelope({ syncMessage: { readMessages: [] } })).toBeNull();
  });

  it('maps sent sync messages', () => {
    expect(
      mapEnvelope({
        sourceNumber: '+1000',
        syncMessage: { sentMessage: { timestamp: 9, message: 'yo', destination: '+1', destinationNumber: '+1999' } },
      }),
    ).toEqual({ kind: 'sentSync', timestamp: 9, destination: { kind: 'contact', id: '+1999' }, body: 'yo' });
    expect(
      mapEnvelope({
        timestamp: 3,
        syncMessage: { sentMessage: { message: 'g', destination: null, groupInfo: { groupId: 'G2' } } },
      }),
    ).toEqual({ kind: 'sentSync', timestamp: 3, destination: { kind: 'group', id: 'G2' }, body: 'g' });
  });

  it('maps contacts and groups', () => {
    expect(mapContact({ number: '+1', uuid: 'u', name: 'Ann' })).toEqual({ id: '+1', number: '+1', uuid: 'u', name: 'Ann' });
    expect(mapContact({ number: null, uuid: 'u2', name: '', profile: { givenName: 'Bo', familyName: 'B' } })).toEqual({
      id: 'u2',
      uuid: 'u2',
      name: 'Bo B',
    });
    expect(mapContact({ number: '+3', profileName: 'Pro' })?.name).toBe('Pro');
    expect(mapContact({ name: 'nobody' })).toBeNull();
    expect(mapGroup({ id: 'G', name: 'Fam', members: [{}, {}] })).toEqual({ id: 'G', name: 'Fam', memberCount: 2 });
  });
});

function sseResponse(chunks: string[], keepOpen = false): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      if (!keepOpen) ctrl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('SignalCliTransport', () => {
  it('receives envelopes over SSE, learns the account and sends via JSON-RPC', async () => {
    const rpcCalls: unknown[] = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/v1/events')) {
        const msg = JSON.stringify({ account: '+15550009999', envelope: dataEnv });
        return sseResponse([`data: ${msg.slice(0, 20)}`, `${msg.slice(20)}\n\n`, 'data: {"envelope":{"receiptMessage":{}}}\n\n'], true);
      }
      const body = JSON.parse(String(init?.body));
      rpcCalls.push(body);
      const result =
        body.method === 'send'
          ? { timestamp: 1234, results: [{ type: 'SUCCESS' }] }
          : body.method === 'listContacts'
            ? [{ number: '+1', name: 'X' }, { uuid: null }]
            : [{ id: 'G', name: 'Grp', members: ['a'] }];
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    }) as typeof fetch;

    const t = new SignalCliTransport({ baseUrl: 'http://x', account: '+15550009999', logger: logger(), fetch: fakeFetch });
    const got: Envelope[] = [];
    const statuses: TransportStatus[] = [];
    t.onStatus((s) => statuses.push(s));
    const received = new Promise<void>((resolve) =>
      t.onEnvelope((e) => {
        got.push(e);
        resolve();
      }),
    );
    await t.connect();
    await received;
    expect(t.status()).toMatchObject({ state: 'connected', account: '+15550009999' });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'incoming', body: 'hello', groupId: 'G1==' });

    expect(await t.send({ kind: 'contact', id: '+1' }, 'hi')).toEqual({ timestamp: 1234 });
    await t.send({ kind: 'group', id: 'G' }, 'yo');
    expect(await t.listContacts()).toEqual([{ id: '+1', number: '+1', name: 'X' }]);
    expect(await t.listGroups()).toEqual([{ id: 'G', name: 'Grp', memberCount: 1 }]);
    expect(rpcCalls[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'send',
      params: { account: '+15550009999', recipient: ['+1'], message: 'hi' },
    });
    expect(rpcCalls[1]).toMatchObject({ method: 'send', params: { groupId: 'G', message: 'yo' } });
    await t.close();
    expect(t.status().state).toBe('disconnected');
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'connected', 'disconnected']);
  });

  it('rejects on RPC errors and failed sends', async () => {
    const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.params.recipient[0] === 'bad') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -1, message: 'nope' } }));
      }
      return new Response(JSON.stringify({ result: { timestamp: 1, results: [{ type: 'UNREGISTERED_FAILURE' }] } }));
    }) as typeof fetch;
    const t = new SignalCliTransport({ baseUrl: 'http://x', logger: logger(), fetch: fakeFetch });
    await expect(t.send({ kind: 'contact', id: 'bad' }, 'x')).rejects.toThrow(/nope/);
    await expect(t.send({ kind: 'contact', id: '+1' }, 'x')).rejects.toThrow(/UNREGISTERED_FAILURE/);
  });

  it('rejects the first connect when unreachable, then reconnects in the background', async () => {
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts++;
      if (attempts < 3) throw new TypeError('fetch failed');
      return sseResponse([], true);
    }) as unknown as typeof fetch;
    const t = new SignalCliTransport({ baseUrl: 'http://x', logger: logger(), fetch: fakeFetch, minBackoffMs: 5, maxBackoffMs: 10 });
    await expect(t.connect()).rejects.toThrow(/unreachable/);
    expect(t.status().state).toBe('error');
    const deadline = Date.now() + 2000;
    while (t.status().state !== 'connected' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(t.status().state).toBe('connected');
    expect(attempts).toBe(3);
    await t.close();
  });

  it('reconnects when the stream ends', async () => {
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts++;
      return sseResponse(attempts === 1 ? ['data: {}\n\n'] : [], attempts > 1);
    }) as unknown as typeof fetch;
    const t = new SignalCliTransport({ baseUrl: 'http://x', logger: logger(), fetch: fakeFetch, minBackoffMs: 5 });
    await t.connect();
    const deadline = Date.now() + 2000;
    while (attempts < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(attempts).toBe(2);
    await t.close();
  });
});
