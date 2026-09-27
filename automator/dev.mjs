// Runs the server (tsx watch) and the web dev server (vite) together.
// A plain `a & b` npm script only works in POSIX shells; cmd.exe runs the two
// one after the other, so this spawns both and stops both on Ctrl+C.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = ['server', 'web'].map((workspace) =>
  spawn(npm, ['run', 'dev', '-w', workspace], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }),
);

let stopping = false;
const stopAll = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500).unref();
};

for (const child of children) {
  child.on('exit', (code) => stopAll(code ?? 0));
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stopAll(0));
}
