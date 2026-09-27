import http from 'node:http';
import { createApi, DEFAULT_ALLOWED_HOSTS } from './api/index.js';
import { loadConfig } from './config.js';
import { createAutomator } from './engine/index.js';
import { createLogger } from './logger.js';
import { createStore } from './store.js';
import { createTransport } from './transport/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger();
  const store = createStore(config.dataDir, logger);
  const transport = createTransport(config, logger);
  const automator = createAutomator({
    transport,
    store,
    scriptsDir: config.scriptsDir,
    dataDir: config.dataDir,
    logger,
  });

  const wildcard = config.host === '0.0.0.0' || config.host === '::';
  if (wildcard) {
    logger.log(
      'warn',
      'server',
      `AUTOMATOR_HOST=${config.host}: the UI (which controls your Signal account) is reachable from the network with no authentication`,
    );
  }

  let markReady!: () => void;
  let markFailed!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    markFailed = reject;
  });
  ready.catch(() => {}); // the api reports it; main() exits

  const api = createApi({
    automator,
    logger,
    transport,
    webDist: config.webDist,
    allowedHosts: wildcard ? null : [...DEFAULT_ALLOWED_HOSTS, config.host],
    ready,
  });
  const server = http.createServer(api.app);
  const closeWs = api.attachWebSocket(server);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    logger.log('info', 'server', `${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    const step = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        logger.log('error', 'server', `${what} failed: ${(err as Error).message}`);
      }
    };
    await step('automator.stop', () => automator.stop());
    await step('transport.close', () => transport.close());
    await step('store.flush', () => store.flush());
    closeWs();
    server.closeAllConnections?.();
    if (server.listening) server.close(() => process.exit(0));
    else process.exit(0);
  };
  // SIGHUP: terminal closed (and console window closed on Windows); SIGBREAK: Ctrl+Break on Windows.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(sig, () => void shutdown(sig));
  }

  // Listen first: the port doubles as a single-instance lock, so a second copy
  // fails here, before it could start repeaters and double-send.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  logger.log(
    'info',
    'server',
    `transport=${config.transport}${config.transport === 'signal-cli' ? ` (${config.signalCliUrl})` : ''}, data=${config.dataDir}, scripts=${config.scriptsDir}`,
  );

  try {
    try {
      await transport.connect();
    } catch (err) {
      logger.log(
        'warn',
        'server',
        `could not reach signal-cli yet (${(err as Error).message}); will keep retrying. ` +
          `Start it with: signal-cli -a <ACCOUNT> daemon --http 127.0.0.1:7584`,
      );
    }

    // Reload contacts/groups whenever signal-cli (re)connects after startup,
    // e.g. when the server came up before the daemon did.
    let engineStarted = false;
    let reconnectedDuringStart = false;
    let prevState = transport.status().state;
    const refresh = () =>
      automator
        .refreshContacts()
        .catch((err: unknown) => logger.log('warn', 'server', `contact refresh failed: ${(err as Error).message}`));
    transport.onStatus((s) => {
      const becameConnected = s.state === 'connected' && prevState !== 'connected';
      prevState = s.state;
      if (!becameConnected || shuttingDown) return;
      if (engineStarted) void refresh();
      else reconnectedDuringStart = true;
    });

    await automator.start();
    engineStarted = true;
    if (reconnectedDuringStart) void refresh();
  } catch (err) {
    markFailed(err);
    throw err;
  }
  markReady();

  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : config.port;
  const shownHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  logger.log('info', 'server', `Signal Automator running at http://${shownHost}:${port}`);
}

main().catch((err) => {
  const e = err as NodeJS.ErrnoException & { address?: string; port?: number };
  if (e?.code === 'EADDRINUSE') {
    console.error(
      `Signal Automator failed to start: ${e.address ?? ''}:${e.port ?? ''} is already in use. ` +
        `Is Signal Automator already running? (Set AUTOMATOR_PORT to use another port.)`,
    );
  } else {
    console.error(`Signal Automator failed to start: ${e?.stack ?? err}`);
  }
  process.exit(1);
});
