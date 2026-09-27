import type { Config } from '../config.js';
import type { Logger, SignalTransport } from '../contracts.js';
import { MockTransport } from './mock.js';
import { SignalCliTransport } from './signalCli.js';

export { MockTransport } from './mock.js';
export { SignalCliTransport } from './signalCli.js';

export function createTransport(
  config: Pick<Config, 'transport' | 'signalCliUrl' | 'account'>,
  logger: Logger,
): SignalTransport {
  if (config.transport === 'mock') return new MockTransport(logger);
  return new SignalCliTransport({ baseUrl: config.signalCliUrl, account: config.account, logger });
}
