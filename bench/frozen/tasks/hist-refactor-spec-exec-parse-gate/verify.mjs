// Frozen verifier for hist-refactor-spec-exec-parse-gate.
// Derived from git commit 0c6db59 (refactor(loop): skip speculative
// execution parse attempts for mutating or incomplete calls). The fixture
// is the pre-refactor inline logic from src/agent/loop.ts at 0c6db59^; the
// scenarios encode the refactor's stated wins: zero parse attempts for
// mutating calls and for incomplete buffers, identical fire behavior.
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSpecGate } = require('./spec-gate.js');

// Fixture predicate: read/search/glob are read-only by name; fetch is
// argument-dependent — read-only for GET (its no-args safe default), not
// for POST; everything else is mutating.
const isReadOnly = (name, args) => {
  if (name === 'read' || name === 'search' || name === 'glob') return true;
  if (name === 'fetch') return ((args && args.method) ?? 'GET') === 'GET';
  return false;
};

const fails = [];
const streamDeltas = (full) => {
  const out = [];
  for (let i = 4; i < full.length; i += 4) out.push(full.slice(0, i));
  out.push(full);
  return out;
};

// 1. Mutating call, long stream: must never fire and never be parsed.
{
  const gate = createSpecGate(isReadOnly);
  const full = JSON.stringify({ path: 'src/big.ts', content: 'x'.repeat(1200) });
  let fired = null;
  for (const buf of streamDeltas(full)) {
    const r = gate.consider('write', buf, false);
    if (r !== null) fired = r;
  }
  if (fired !== null) fails.push('mutating write call fired speculatively');
  if (gate.parseAttempts !== 0) fails.push(`mutating stream caused ${gate.parseAttempts} parse attempts, want 0`);
}

// 2. Read-only call: fires exactly once, at the complete buffer, with one parse.
{
  const gate = createSpecGate(isReadOnly);
  const args = { path: 'src/app.ts' };
  const full = JSON.stringify(args);
  let firedAt = -1;
  let firedArgs = null;
  const deltas = streamDeltas(full);
  deltas.forEach((buf, i) => {
    const r = gate.consider('read', buf, firedAt >= 0);
    if (r !== null && firedAt < 0) { firedAt = i; firedArgs = r; }
  });
  if (firedAt !== deltas.length - 1) fails.push(`read fired at delta ${firedAt}, want only the final (${deltas.length - 1})`);
  if (JSON.stringify(firedArgs) !== JSON.stringify(args)) fails.push('read fired with wrong args');
  if (gate.parseAttempts !== 1) fails.push(`read stream caused ${gate.parseAttempts} parse attempts, want exactly 1`);
}

// 3. Argument-dependent tool: POST never fires, GET fires at completion.
{
  const gate = createSpecGate(isReadOnly);
  let fired = null;
  for (const buf of streamDeltas(JSON.stringify({ url: 'https://x', method: 'POST' }))) {
    const r = gate.consider('fetch', buf, false);
    if (r !== null) fired = r;
  }
  if (fired !== null) fails.push('fetch POST fired speculatively');
  const gate2 = createSpecGate(isReadOnly);
  fired = null;
  for (const buf of streamDeltas(JSON.stringify({ url: 'https://x', method: 'GET' }))) {
    const r = gate2.consider('fetch', buf, false);
    if (r !== null) fired = r;
  }
  if (!fired || fired.method !== 'GET') fails.push('fetch GET did not fire at completion');
}

// 4. Malformed input never throws; already-executed never fires.
{
  const gate = createSpecGate(isReadOnly);
  let threw = false;
  try {
    gate.consider('read', '{bad}', false);
    gate.consider('read', '{"path":"x"}', true);
  } catch { threw = true; }
  if (threw) fails.push('malformed buffer threw');
  if (gate.consider('read', '{"path":"x"}', true) !== null) fails.push('already-executed call fired');
}

if (fails.length === 0) {
  console.log('PASS: zero parse attempts for mutating/incomplete streams; read-only calls fire exactly at complete JSON; fire behavior unchanged');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
