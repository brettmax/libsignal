import * as nodeModule from 'node:module';
import { pathToFileURL } from 'node:url';

/** Query parameter that marks a user-script import (and busts the ESM cache). */
const MARK = 'automator-script';

/**
 * Module hooks, registered once per process with module.register(). For
 * user-script URLs carrying the marker they read the file themselves and
 * short-circuit the rest of the loader chain, which gives three guarantees
 * that a bare `?v=` query does not:
 *   - every (re)load evaluates the current source, even under tsx, whose own
 *     hooks drop the query string and would keep serving the first version;
 *   - `tsx watch` never sees the script files, so editing a script does not
 *     restart the whole server in dev mode;
 *   - scripts always parse as ES modules, whatever package.json says.
 * Relative .js/.mjs imports made by a script (helper modules such as
 * ./_utils.js) get the same treatment, so editing a helper takes effect when
 * the script reloads; each script load gets its own helper instances. Other
 * imports (packages, node: builtins, JSON) resolve normally.
 */
const HOOKS_SOURCE = `
const MARK = ${JSON.stringify(`${MARK}=`)};
const isScript = (u) => typeof u === 'string' && u.startsWith('file:') && u.includes(MARK);
const isRelativeJs = (s) => (s.startsWith('./') || s.startsWith('../')) && /\\.m?js$/.test(s);
export async function resolve(specifier, context, nextResolve) {
  if (isScript(specifier)) return { url: specifier, format: 'module', shortCircuit: true };
  const parent = context.parentURL;
  if (isScript(parent) && isRelativeJs(specifier)) {
    // A script's relative .js/.mjs helper: load it with the script's marker too,
    // so it is re-evaluated when the script reloads and parsed as ESM.
    const url = new URL(specifier, parent);
    url.search = new URL(parent).search;
    return { url: url.href, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (isScript(url)) {
    const { readFile } = await import('node:fs/promises');
    const file = new URL(url);
    file.search = '';
    file.hash = '';
    return { format: 'module', source: await readFile(file, 'utf8'), shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;

const REGISTERED = Symbol.for('signal-automator.script-loader-hooks');
let counter = 0;

function ensureHooks(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[REGISTERED] !== undefined) return;
  // Namespace access: module.register does not exist before Node 20.6. Without
  // it the query string alone still busts the cache under plain Node.
  const register = (nodeModule as { register?: (specifier: string) => void }).register;
  try {
    if (typeof register !== 'function') throw new Error('module.register is unavailable');
    register(`data:text/javascript,${encodeURIComponent(HOOKS_SOURCE)}`);
    g[REGISTERED] = true;
  } catch {
    g[REGISTERED] = false;
  }
}

/** Imports the current contents of a user-script file as a fresh ES module. */
export async function importScript(file: string): Promise<{ default?: unknown }> {
  ensureHooks();
  const url = `${pathToFileURL(file).href}?${MARK}=${Date.now().toString(36)}-${++counter}`;
  return (await import(url)) as { default?: unknown };
}
