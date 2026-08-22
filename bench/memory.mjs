#!/usr/bin/env node
// Memory regression gate (harness-v2 perf): spawns fresh Node children that
// import the REAL built modules, settle, then report their own peak RSS.
// Fails (exit 1) if any measurement exceeds its ceiling — this locks in the
// lazy-loading wins so an accidental eager `import ts from 'typescript'` /
// grammar pre-load can never land silently again.
//
// Usage: node bench/memory.mjs        (or: npm run bench:memory)
//
// Baselines (2026-08-22, lazy codegraph landed):
//   codegraph import      ~48MB   (was ~158MB when grammars loaded eagerly)
//   runtime chain         ~62MB   (was ~130MB+)
//   bare node baseline    ~47MB

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GATES = [
  // [label, module to import, ceiling MB]
  ['codegraph import', './dist/codegraph.js', 80],
  ['runtime chain', './dist/runtime.js', 95],
];

const SETTLE_MS = Number(process.env.SETTLE_MS ?? 600);

function measureChild(modulePath) {
  return new Promise((res, rej) => {
    const script = `
      const t = setTimeout(() => process.exit(3), ${SETTLE_MS + 15000});
      import(${JSON.stringify(resolve(root, modulePath))})
        .then(async () => {
          await new Promise((r) => setTimeout(r, ${SETTLE_MS})); // let lazy inits settle
          clearTimeout(t);
          console.log(Math.round(process.memoryUsage().rss / 1048576));
          process.exit(0);
        })
        .catch((e) => { console.error(String(e)); process.exit(2); });
    `;
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => {
      const m = out.trim().split('\n').filter(Boolean).pop();
      const mb = m && /^\d+$/.test(m) ? Number(m) : null;
      if (code === 0 && mb !== null) res(mb);
      else rej(new Error(`child exited ${code}: ${out.slice(0, 300)}`));
    });
  });
}

let failed = false;
console.log('memory gate (fresh child per probe, settled):\n');
for (const [label, modulePath, maxMb] of GATES) {
  try {
    const mb = await measureChild(modulePath);
    const ok = mb <= maxMb;
    if (!ok) failed = true;
    console.log(`  ${ok ? '✓' : '✗ FAIL'} ${label.padEnd(20)} ${mb}MB / ceiling ${maxMb}MB`);
  } catch (e) {
    failed = true;
    console.log(`  ✗ FAIL ${label.padEnd(20)} probe error: ${e.message}`);
  }
}

if (failed) {
  console.error('\nmemory gate FAILED — an eager heavy import likely crept back in.');
  console.error('Keep heavy modules lazy: load parsers/grammars/compilers on first use.');
  process.exit(1);
}
console.log('\nmemory gate passed.');
