import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type TransportKind = 'signal-cli' | 'mock';

export interface Config {
  port: number;
  host: string;
  transport: TransportKind;
  signalCliUrl: string;
  /** The user's own number; passed as the JSON-RPC "account" param when set. */
  account: string | null;
  dataDir: string;
  scriptsDir: string;
  webDist: string;
}

/**
 * The automator workspace root. This file lives at <automator>/server/src/config.ts
 * (tsx) or <automator>/server/dist/config.js (built), so it is two levels up either way.
 */
export const AUTOMATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const portRaw = env.AUTOMATOR_PORT ?? '7583';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid AUTOMATOR_PORT: ${portRaw}`);
  }
  const transportRaw = (env.AUTOMATOR_TRANSPORT ?? 'signal-cli').trim();
  if (transportRaw !== 'signal-cli' && transportRaw !== 'mock') {
    throw new Error(`Invalid AUTOMATOR_TRANSPORT: ${transportRaw} (expected signal-cli or mock)`);
  }
  const dir = (v: string | undefined, def: string) => path.resolve(v && v.trim() ? v : def);
  return {
    port,
    host: env.AUTOMATOR_HOST?.trim() || '127.0.0.1',
    transport: transportRaw,
    signalCliUrl: (env.SIGNAL_CLI_URL?.trim() || 'http://127.0.0.1:7584').replace(/\/+$/, ''),
    account: env.SIGNAL_ACCOUNT?.trim() || null,
    dataDir: dir(env.AUTOMATOR_DATA_DIR, path.join(AUTOMATOR_ROOT, 'data')),
    scriptsDir: dir(env.AUTOMATOR_SCRIPTS_DIR, path.join(AUTOMATOR_ROOT, 'scripts')),
    webDist: dir(env.AUTOMATOR_WEB_DIST, path.join(AUTOMATOR_ROOT, 'web', 'dist')),
  };
}
