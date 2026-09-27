// The loader's module hooks only exist in Node's own loader chain, which vitest
// bypasses (vite-node runs modules itself), so this runs a real Node child
// process with tsx registered, like `npm run dev`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '../..');

describe('importScript (real Node loader chain)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'automator-loader-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-evaluates edited scripts and helpers, as ESM, without leaving files behind', () => {
    const loaderUrl = pathToFileURL(path.join(here, 'loader.ts')).href;
    const runner = path.join(dir, 'runner.mts');
    writeFileSync(
      runner,
      `
      import { readdirSync, writeFileSync } from 'node:fs';
      import { importScript } from ${JSON.stringify(loaderUrl)};
      const dir = ${JSON.stringify(dir)};
      const script = dir + '/s.js';
      const out = [];
      const run = async () => { const m = await importScript(script); out.push(m.default()); };
      writeFileSync(dir + '/_h.js', "export const h = 'h1';");
      writeFileSync(script, "import { h } from './_h.js'; let n = 0; export default () => 'a:' + h + ':' + (++n);");
      await run();
      await run();
      writeFileSync(dir + '/_h.js', "export const h = 'h2';");
      await run();
      writeFileSync(script, "export default () => 'b';");
      await run();
      out.push(readdirSync(dir).sort().join(','));
      console.log(JSON.stringify(out));
      `,
    );
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', runner], {
      cwd: serverDir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const lines = stdout.trim().split('\n');
    // Module state is fresh on every load; helper edits are picked up; no temp files.
    expect(JSON.parse(lines[lines.length - 1]!)).toEqual(['a:h1:1', 'a:h1:1', 'a:h2:1', 'b', '_h.js,runner.mts,s.js']);
  });
});
