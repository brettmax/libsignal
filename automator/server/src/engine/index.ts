import type { Automator, AutomatorDeps } from '../contracts.js';
import { AutomatorImpl, type EngineOptions } from './automator.js';

export function createAutomator(deps: AutomatorDeps, opts?: EngineOptions): Automator {
  return new AutomatorImpl(deps, opts);
}

export { AutomatorImpl, DEFAULT_SCRIPT_TIMEOUT_MS, MAX_SEND_DEPTH, MESSAGE_LOG_CAP, type EngineOptions } from './automator.js';
export { ScriptUnloadedError } from './scripts.js';
