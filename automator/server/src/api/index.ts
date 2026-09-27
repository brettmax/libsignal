import fs from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import type { ApiError, AppState, LogEntry, ServerEvent } from '@automator/shared';
import {
  CancelledError,
  NotFoundError,
  ValidationError,
  type Automator,
  type Logger,
  type SignalTransport,
} from '../contracts.js';
import {
  optBool,
  optString,
  parseLimit,
  parseRecipient,
  parseRepeaterInput,
  parseRepeaterPatch,
  parseRuleInput,
  parseRulePatch,
  parseScriptName,
  requireObject,
  requireString,
} from './validate.js';

/** A Logger that also exposes its ring buffer and a live feed (see ../logger.ts). */
export interface ApiLogger extends Logger {
  entries(): LogEntry[];
  subscribe(cb: (entry: LogEntry) => void): () => void;
}

export interface ApiDeps {
  automator: Automator;
  logger: ApiLogger;
  transport: SignalTransport;
  /** Directory holding the built web UI; served statically when it exists. */
  webDist?: string;
  /**
   * Host names (without port) accepted in the Host and Origin headers, to block
   * DNS-rebinding and cross-site requests. Defaults to localhost/127.0.0.1/::1.
   * Pass null to disable the check (only sensible when deliberately exposed).
   */
  allowedHosts?: string[] | null;
  /**
   * Resolves once the automator has started (state loaded). Until then every
   * /api route except GET /api/status waits for it, and WebSocket clients get
   * their snapshot only after it; if it rejects they get 503. Omit when already started.
   */
  ready?: Promise<unknown>;
}

export interface Api {
  app: express.Express;
  /** Attaches the WebSocket endpoint at /ws. Returns a function that closes it. */
  attachWebSocket(server: Server): () => void;
  /** Builds the full AppState snapshot. */
  snapshot(): AppState;
}

export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

type Handler = (req: Request, res: Response) => unknown;

/** Wraps an (async) handler: sends its return value as JSON (204 when undefined), forwards errors. */
const h =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(() => fn(req, res))
      .then((out) => {
        if (res.headersSent) return;
        if (out === undefined) res.status(204).end();
        else res.json(out);
      })
      .catch(next);
  };

function hostnameOf(hostHeader: string): string {
  // "[::1]:7583" -> "[::1]", "localhost:7583" -> "localhost"
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase();
  return hostHeader.replace(/:\d+$/, '').toLowerCase();
}

function originAllowed(origin: string | undefined, allowed: Set<string> | null): boolean {
  if (!allowed || !origin) return true;
  try {
    const u = new URL(origin);
    return allowed.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function hostAllowed(host: string | undefined, allowed: Set<string> | null): boolean {
  if (!allowed) return true;
  if (!host) return false;
  return allowed.has(hostnameOf(host));
}

export function createApi(deps: ApiDeps): Api {
  const { automator, logger, transport } = deps;
  const allowed =
    deps.allowedHosts === null
      ? null
      : new Set((deps.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((x) => x.toLowerCase()));

  // Readiness: the HTTP server listens before the engine has loaded its state, so
  // health checks answer early while nothing reads or mutates half-initialised state.
  let isReady = !deps.ready;
  let startupError: unknown = null;
  const whenReady: Promise<void> = (deps.ready ?? Promise.resolve()).then(
    () => {
      isReady = true;
    },
    (err: unknown) => {
      startupError = err ?? new Error('startup failed');
    },
  );

  const snapshot = (): AppState => ({
    status: transport.status(),
    contacts: automator.contacts(),
    groups: automator.groups(),
    repeaters: automator.listRepeaters(),
    rules: automator.listRules(),
    scripts: automator.listScripts(),
    messages: automator.messages(),
    logs: logger.entries(),
  });

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    if (!hostAllowed(req.headers.host, allowed) || !originAllowed(req.headers.origin, allowed)) {
      res.status(403).json({ error: 'forbidden host or origin' } satisfies ApiError);
      return;
    }
    next();
  });

  const api = express.Router();
  api.use((req, res, next) => {
    if (isReady || (req.method === 'GET' && req.path === '/status')) return next();
    void whenReady.then(() => {
      if (startupError) {
        res.status(503).json({ error: 'server failed to start' } satisfies ApiError);
      } else next();
    });
  });
  api.use(express.json({ limit: '2mb' }));

  // ------------------------------------------------------------ state
  api.get('/state', h(() => snapshot()));
  api.get('/status', h(() => transport.status()));
  api.post('/contacts/refresh', h(() => automator.refreshContacts()));
  api.get('/messages', h((req) => automator.messages(parseLimit(req.query.limit))));
  api.post(
    '/send',
    h(async (req) => {
      const b = requireObject(req.body);
      const to = parseRecipient(b.to, '"to"');
      const body = requireString(b, 'body', { nonEmpty: true });
      return automator.send(to, body, 'manual');
    }),
  );

  // -------------------------------------------------------- repeaters
  api.get('/repeaters', h(() => automator.listRepeaters()));
  api.post('/repeaters', h((req) => automator.createRepeater(parseRepeaterInput(req.body))));
  api.put('/repeaters/:id', h((req) => automator.updateRepeater(req.params.id, parseRepeaterPatch(req.body))));
  api.delete(
    '/repeaters/:id',
    h((req) => {
      automator.deleteRepeater(req.params.id);
    }),
  );
  api.post('/repeaters/:id/run', h((req) => automator.runRepeaterNow(req.params.id)));

  // ------------------------------------------------------------ rules
  api.get('/rules', h(() => automator.listRules()));
  api.post('/rules/reorder', h((req) => {
    const b = requireObject(req.body);
    if (!Array.isArray(b.ids) || !b.ids.every((x) => typeof x === 'string')) {
      throw new ValidationError('"ids" must be an array of strings');
    }
    return automator.reorderRules(b.ids as string[]);
  }));
  api.post('/rules/test', h((req) => {
    const b = requireObject(req.body);
    const body = requireString(b, 'body');
    const sender = optString(b, 'sender');
    const group = optBool(b, 'group');
    return { matches: automator.testRules(body, sender, group) };
  }));
  api.post('/rules', h((req) => automator.createRule(parseRuleInput(req.body))));
  api.put('/rules/:id', h((req) => automator.updateRule(req.params.id, parseRulePatch(req.body))));
  api.delete(
    '/rules/:id',
    h((req) => {
      automator.deleteRule(req.params.id);
    }),
  );

  // ---------------------------------------------------------- scripts
  api.get('/scripts', h(() => automator.listScripts()));
  api.post('/scripts/reload', h(() => automator.reloadScripts()));
  api.get('/scripts/:name', h((req) => automator.getScript(parseScriptName(req.params.name))));
  api.put('/scripts/:name', h((req) => {
    const name = parseScriptName(req.params.name);
    const source = requireString(requireObject(req.body), 'source');
    return automator.saveScript(name, source);
  }));
  api.delete('/scripts/:name', h(async (req) => {
    await automator.deleteScript(parseScriptName(req.params.name));
  }));
  api.post('/scripts/:name/enable', h((req) => {
    const name = parseScriptName(req.params.name);
    const b = requireObject(req.body);
    if (typeof b.enabled !== 'boolean') throw new ValidationError('"enabled" must be a boolean');
    return automator.setScriptEnabled(name, b.enabled);
  }));

  // --------------------------------------------------------- simulate
  api.post('/simulate/incoming', h(async (req) => {
    const b = requireObject(req.body);
    const from = requireString(b, 'from', { nonEmpty: true });
    const body = requireString(b, 'body', { nonEmpty: true });
    const groupId = optString(b, 'groupId');
    await automator.simulateIncoming(groupId ? { source: from, body, groupId } : { source: from, body });
  }));

  api.use((req, res) => {
    res.status(404).json({ error: `no such endpoint: ${req.method} ${req.baseUrl}${req.path}` } satisfies ApiError);
  });

  api.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let status = 500;
    let message = err instanceof Error ? err.message : String(err);
    if (err instanceof NotFoundError) status = 404;
    else if (err instanceof ValidationError) status = 400;
    else if (err instanceof CancelledError) status = 409;
    else if (isBodyParserError(err)) {
      status = err.status ?? 400;
      message = err.type === 'entity.too.large' ? 'request body too large' : 'invalid JSON body';
    }
    if (status >= 500) {
      logger.log('error', 'api', `${req.method} ${req.originalUrl} failed: ${message}`);
    }
    if (!res.headersSent) res.status(status).json({ error: message || 'error' } satisfies ApiError);
  });

  app.use('/api', api);

  // ----------------------------------------------------------- web UI
  if (deps.webDist) {
    const webDist = deps.webDist;
    const indexHtml = path.join(webDist, 'index.html');
    app.use(express.static(webDist, { index: 'index.html', fallthrough: true }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/api' || req.path === '/ws') return next();
      if (!fs.existsSync(indexHtml)) {
        res
          .status(404)
          .type('text/plain')
          .send('Signal Automator web UI is not built. Run `npm run build` in the automator folder (or `npm run dev`).');
        return;
      }
      res.sendFile(indexHtml);
    });
  }

  // --------------------------------------------------------- websocket
  const attachWebSocket = (server: Server): (() => void) => {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

    const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      if (!hostAllowed(req.headers.host, allowed) || !originAllowed(req.headers.origin, allowed)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    };
    server.on('upgrade', onUpgrade);

    const alive = new WeakMap<WebSocket, boolean>();
    /** Clients that have received their snapshot; only they get incremental events. */
    const live = new Set<WebSocket>();
    const broadcast = (ev: ServerEvent) => {
      if (live.size === 0) return;
      const data = JSON.stringify(ev);
      for (const ws of live) if (ws.readyState === WebSocket.OPEN) ws.send(data);
    };

    wss.on('connection', (ws) => {
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      ws.on('error', () => ws.terminate());
      ws.on('close', () => live.delete(ws));
      // Clients only listen; anything they send is ignored.
      void whenReady.then(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (startupError) {
          ws.close(1011, 'server failed to start');
          return;
        }
        try {
          ws.send(JSON.stringify({ type: 'snapshot', state: snapshot() } satisfies ServerEvent));
          live.add(ws);
        } catch (err) {
          logger.log('error', 'api', `failed to build snapshot: ${(err as Error).message}`);
          ws.close(1011, 'snapshot failed');
        }
      });
    });

    const unsubs = [
      automator.onEvent((ev) => broadcast(ev)),
      logger.subscribe((entry) => broadcast({ type: 'log', entry })),
      transport.onStatus((status) => broadcast({ type: 'status', status })),
    ];

    const heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (alive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        alive.set(ws, false);
        ws.ping();
      }
    }, 30000);
    heartbeat.unref();

    return () => {
      clearInterval(heartbeat);
      live.clear();
      for (const u of unsubs) u();
      server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    };
  };

  return { app, attachWebSocket, snapshot };
}

function isBodyParserError(err: unknown): err is { status?: number; type?: string } {
  return (
    !!err &&
    typeof err === 'object' &&
    typeof (err as { type?: unknown }).type === 'string' &&
    String((err as { type: string }).type).startsWith('entity.')
  );
}
