// Frozen verifier for hist-fix-exec-keep-ends-truncation.
// Derived from git commit e39d744 (fix(exec): keep-ends truncation —
// firehose output keeps head AND rolling tail) and its regression test in
// src/exec.test.ts ('keeps BOTH ends': head line survives, last line
// survives). The pre-fix behavior kept the head only.
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OutputCollector } = require('./collect.js');

const fails = [];

// 1. Under-cap output passes through untouched.
{
  const c = new OutputCollector(100);
  c.push('hello ');
  c.push('world');
  if (c.result() !== 'hello world' || c.wasTruncated) fails.push('under-cap output changed or flagged truncated');
}

// 2. Firehose: head survives, tail survives, marker present, size bounded.
{
  const cap = 200;
  const c = new OutputCollector(cap);
  c.push('HEAD-FIRST-LINE\n');
  for (let i = 0; i < 60; i++) c.push(`filler line ${i} xxxxxxxxxxxxxxxxxxxx\n`);
  c.push('FINAL FAILURE SUMMARY: 3 tests failed\n');
  const out = c.result();
  if (!c.wasTruncated) fails.push('overflow not flagged truncated');
  if (!out.startsWith('HEAD-FIRST-LINE')) fails.push('head lost');
  if (!out.includes('FINAL FAILURE SUMMARY: 3 tests failed')) fails.push('TAIL LOST (the pre-fix bug)');
  if (!out.includes('[truncated]')) fails.push('[truncated] anchor missing');
  if (out.length > cap + 120) fails.push(`retained output unbounded: ${out.length} chars > cap ${cap} + marker allowance`);
}

// 3. The tail keeps rolling after overflow: later chunks displace earlier tail.
{
  const c = new OutputCollector(120);
  c.push('start\n');
  for (let i = 0; i < 40; i++) c.push(`chunk-${i} padding padding\n`);
  c.push('LAST-CHUNK-MARKER\n');
  const out = c.result();
  if (!out.includes('LAST-CHUNK-MARKER')) fails.push('post-overflow chunks were dropped (stream destroyed early)');
}

if (fails.length === 0) {
  console.log('PASS: keep-ends truncation — head and rolling tail survive, [truncated] anchor intact, retained size bounded');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
