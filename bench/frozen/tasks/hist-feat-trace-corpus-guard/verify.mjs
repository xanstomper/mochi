// Frozen verifier for hist-feat-trace-corpus-guard.
// Derived from git commit b0b113c (feat(retention): never prune or GC a
// completed run's trace before its trajectory is exported) and its tests in
// src/memory/retention.test.ts / src/observability/trace.test.ts.
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);

let pruneTraces;
try {
  ({ pruneTraces } = require('./prune.js'));
} catch (e) {
  console.log(`FAIL: prune.js does not load (${e.message})`);
  process.exit(1);
}

const dir = process.cwd();
const ws = join(dir, '.verify-ws');
rmSync(ws, { recursive: true, force: true });
mkdirSync(join(ws, 'traces'), { recursive: true });
mkdirSync(join(ws, 'exports'), { recursive: true });

const now = Date.now();
const write = (name, lines, ageMs) => {
  const p = join(ws, 'traces', name);
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const t = new Date(now - ageMs);
  utimesSync(p, t, t);
};
// Oldest → newest. Cap will be maxFiles=1, so every trace except the newest
// (run-e) is a would-be victim; only corpus protection can save run-a.
write('run-a-completed-unexported.jsonl', [{ t: 1, kind: 'task:started' }, { t: 2, kind: 'task:completed' }], 5000);
write('run-b-completed-exported.jsonl', [{ t: 1, kind: 'task:failed' }], 4000);
write('run-c-incomplete.jsonl', [{ t: 1, kind: 'tool:called', tool: 'read' }], 3000);
write('run-d-malformed.jsonl', ['{"kind":"task:completed"'], 2000); // terminal-looking but malformed JSON
write('run-e-recent.jsonl', [{ t: 1, kind: 'task:completed' }], 1000);
writeFileSync(join(ws, 'exports', 'trajectory-run-b-completed-exported.jsonl'), '{}\n');

const fails = [];
const removed1 = pruneTraces(ws, 1, 32 * 1024 * 1024);
const alive = (n) => existsSync(join(ws, 'traces', n));
if (!alive('run-a-completed-unexported.jsonl')) fails.push('completed-unexported trace was pruned (the data-loss bug)');
if (alive('run-b-completed-exported.jsonl')) fails.push('completed-EXPORTED trace should have been pruned');
if (alive('run-c-incomplete.jsonl')) fails.push('incomplete trace should have been pruned (no protection)');
if (alive('run-d-malformed.jsonl')) fails.push('malformed trace should have been pruned (counts as not completed)');
if (!alive('run-e-recent.jsonl')) fails.push('recent trace wrongly pruned');
if (removed1 !== 3) fails.push(`first pass removed ${removed1}, want 3`);

// Once the export exists, the protection lapses and the same trace prunes.
writeFileSync(join(ws, 'exports', 'trajectory-run-a-completed-unexported.jsonl'), '{}\n');
const removed2 = pruneTraces(ws, 1, 32 * 1024 * 1024);
if (alive('run-a-completed-unexported.jsonl')) fails.push('trace stayed protected after its export appeared');
if (removed2 !== 1) fails.push(`second pass removed ${removed2}, want 1`);

if (fails.length === 0) {
  console.log('PASS: completed-unexported traces survive pruning; exported/incomplete/malformed traces prune normally; protection lapses on export');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
