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
  const api = createApi({
    automator,
    logger,
    transport,
    webDist: config.webDist,
    allowedHosts: wildcard ? null : [...DEFAULT_ALLOWED_HOSTS, config.host],
  });

  const server = http.createServer(api.app);
  const closeWs = api.attachWebSocket(server);
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
    await transport.connect();
  } catch (err) {
    logger.log(
      'warn',
      'server',
      `could not reach signal-cli yet (${(err as Error).message}); will keep retrying. ` +
        `Start it with: signal-cli -a <ACCOUNT> daemon --http 127.0.0.1:7584`,
    );
  }
  await automator.start();

  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : config.port;
  const shownHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  logger.log('info', 'server', `Signal Automator running at http://${shownHost}:${port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    logger.log('info', 'server', `${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    try {
      await automator.stop();
    } catch (err) {
      logger.log('error', 'server', `automator.stop failed: ${(err as Error).message}`);
    }
    try {
      await transport.close();
    } catch (err) {
      logger.log('error', 'server', `transport.close failed: ${(err as Error).message}`);
    }
    try {
      await store.flush();
    } catch (err) {
      logger.log('error', 'server', `store.flush failed: ${(err as Error).message}`);
    }
    closeWs();
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`Signal Automator failed to start: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
