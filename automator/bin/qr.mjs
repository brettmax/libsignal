#!/usr/bin/env node
// Prints a QR code for a piece of text in the terminal, or writes it to an HTML
// page, so a Signal link URI (sgnl://linkdevice?...) can be scanned with the
// phone without installing anything besides Node.js. Nothing leaves the machine.
//
//   node bin/qr.mjs 'sgnl://linkdevice?uuid=...'           # terminal (Unicode half blocks)
//   node bin/qr.mjs --blocks 'sgnl://linkdevice?uuid=...'  # terminal, colored spaces only
//   node bin/qr.mjs --html link.html 'sgnl://...'          # a page with an SVG QR code
//
// A small byte-mode QR Code encoder (ISO/IEC 18004: versions 1-40, error
// correction L/M/Q/H, automatic mask). Its structure follows Project Nayuki's
// QR Code generator (MIT License).

import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ECC = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS = [1, 0, 3, 2]; // L, M, Q, H as encoded in the format information

// Indexed [ecc][version]; index 0 is unused.
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver, ecc) {
  return Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecc][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecc][ver];
}

// ---------------------------------------------------------------- Reed-Solomon over GF(2^8)

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

// ---------------------------------------------------------------- encoding

/**
 * Encodes text (as UTF-8 bytes) and returns the QR code as rows of booleans
 * (true = dark module), without the quiet zone.
 * @param {string} text
 * @param {'L'|'M'|'Q'|'H'} [level]
 * @returns {boolean[][]}
 */
export function encode(text, level = 'L') {
  const ecc = ECC[level];
  if (ecc === undefined) throw new Error(`unknown error correction level: ${level}`);
  const bytes = [...Buffer.from(String(text), 'utf8')];

  let ver = 1;
  for (; ; ver++) {
    if (ver > 40) throw new Error('text too long for a QR code');
    if (4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver, ecc) * 8) break;
  }

  // Segment: byte mode indicator, length, data; then terminator and padding.
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0x4, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(ver, ecc) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));

  // Split into blocks, add error correction, interleave.
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc][ver];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[ecc][ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const block = data.slice(k, k + shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1));
    k += block.length;
    const eccBytes = rsRemainder(block, divisor);
    if (i < numShortBlocks) block.push(0);
    blocks.push(block.concat(eccBytes));
  }
  const codewords = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - eccLen || j >= numShortBlocks) codewords.push(block[i]);
    });
  }

  // Function patterns.
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFunction = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const align = [];
  if (ver > 1) {
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    for (let pos = size - 7; align.length < numAlign - 1; pos -= step) align.unshift(pos);
    align.unshift(6);
  }
  align.forEach((ay, i) => {
    align.forEach((ax, j) => {
      const corner = (i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) setFunction(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });
  const drawFormat = (mask) => {
    const value = (FORMAT_BITS[ecc] << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const format = ((value << 10) | rem) ^ 0x5412;
    const bit = (i) => ((format >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) setFunction(8, i, bit(i));
    setFunction(8, 7, bit(6));
    setFunction(8, 8, bit(7));
    setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(i));
    setFunction(8, size - 8, true);
  };
  drawFormat(0); // reserve the area; redrawn once the mask is chosen
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const versionBits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((versionBits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }

  // Data modules, in the zigzag order.
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < codewords.length * 8) {
          modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
      }
    }
  }

  // Try the 8 masks and keep the one with the lowest penalty.
  const masked = (mask, x, y) => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (!isFunction[y][x] && masked(mask, x, y)) modules[y][x] = !modules[y][x];
    }
  };
  let best = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const p = penalty(modules);
    if (p < bestPenalty) {
      best = mask;
      bestPenalty = p;
    }
    applyMask(mask); // XOR again to undo
  }
  applyMask(best);
  drawFormat(best);
  return modules;
}

/** Penalty rules N1-N4 of ISO/IEC 18004 section 7.8.3. */
function penalty(m) {
  const size = m.length;
  let result = 0;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(m[i]);
    lines.push(m.map((row) => row[i]));
  }
  const finderA = [true, false, true, true, true, false, true, false, false, false, false];
  const finderB = [false, false, false, false, true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) result += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 11 <= size; i++) {
      if (finderA.every((v, k) => line[i + k] === v) || finderB.every((v, k) => line[i + k] === v)) result += 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) result += 3;
    }
  }
  const total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}

// ---------------------------------------------------------------- output

const QUIET = 4;

function withQuietZone(modules) {
  const size = modules.length + QUIET * 2;
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      const mx = x - QUIET;
      const my = y - QUIET;
      return mx >= 0 && my >= 0 && mx < modules.length && my < modules.length && modules[my][mx];
    }),
  );
}

/** Two rows per text line with half blocks, black on white whatever the terminal theme. */
export function toTerminal(modules) {
  const m = withQuietZone(modules);
  const lines = [];
  for (let y = 0; y < m.length; y += 2) {
    let line = '\x1b[30;107m';
    for (let x = 0; x < m.length; x++) {
      const top = m[y][x];
      const bottom = y + 1 < m.length ? m[y + 1][x] : false;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line + '\x1b[0m');
  }
  return lines.join('\n');
}

/** Two colored spaces per module: needs no Unicode, only ANSI colors. */
export function toTerminalBlocks(modules) {
  return withQuietZone(modules)
    .map((row) => row.map((dark) => (dark ? '\x1b[40m  ' : '\x1b[107m  ')).join('') + '\x1b[0m')
    .join('\n');
}

export function toSvg(modules) {
  const m = withQuietZone(modules);
  let path = '';
  m.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x},${y}h1v1h-1z`;
    });
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.length} ${m.length}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${path}"/></svg>`
  );
}

export function toHtml(modules, text) {
  const escaped = String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link Signal Automator</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 32px 16px; background: #f4f4f5; color: #18181b; }
  main { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  h1 { font-size: 1.25rem; margin: 0 0 8px; }
  svg { display: block; width: 100%; max-width: 360px; margin: 16px auto; }
  code { word-break: break-all; font-size: .8rem; color: #52525b; }
</style>
</head>
<body>
<main>
<h1>Link Signal Automator to your Signal account</h1>
<p>On your phone open <strong>Signal &rarr; Settings &rarr; Linked devices &rarr; Link new device</strong> and scan this code.</p>
${toSvg(modules)}
<p>The code expires after a few minutes. When the terminal says the device is linked you can close this page.</p>
<p><code>${escaped}</code></p>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------- command line

function main(argv) {
  let html = null;
  let blocks = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--html') html = argv[++i];
    else if (argv[i] === '--blocks') blocks = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      process.stdout.write('usage: node qr.mjs [--blocks] [--html FILE] TEXT\n');
      return 0;
    } else rest.push(argv[i]);
  }
  if (rest.length !== 1 || !rest[0] || (html !== null && !html)) {
    process.stderr.write('usage: node qr.mjs [--blocks] [--html FILE] TEXT\n');
    return 2;
  }
  let modules;
  try {
    modules = encode(rest[0], 'L');
  } catch (err) {
    process.stderr.write(`qr.mjs: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
  if (html) writeFileSync(html, toHtml(modules, rest[0]), { encoding: 'utf8', mode: 0o600 });
  else process.stdout.write(`${blocks ? toTerminalBlocks(modules) : toTerminal(modules)}\n`);
  return 0;
}

// Run as a program (not imported)? Compare real paths: Node gives the main module's
// URL with symlinks resolved, while argv[1] is the path as typed.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
