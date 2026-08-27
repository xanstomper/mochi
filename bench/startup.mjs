// Per-startup microbenchmark. Measures cold CLI startup by spawning the REAL
// built binary N times and averaging wall time. Resolves the repo root via
// import.meta.url so the bench is machine-agnostic (was hardcoded to one
// user's absolute path before).
//
// Run: node bench/startup.mjs   (or: npm run bench)

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = resolve(root, 'dist/cli.js');

const N = Number(process.env.N ?? 20);
let total = 0;
for (let i = 0; i < N; i++) {
  const start = performance.now();
  execSync(`node ${JSON.stringify(bin)} --version`, { cwd: root, stdio: 'ignore' });
  total += performance.now() - start;
}
console.log(`Average startup: ${(total / N).toFixed(2)}ms over ${N} runs (${bin})`);
