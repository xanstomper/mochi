// Frozen verifier for hist-feat-trajectory-record.
// Derived from git commit 0b225a8 (feat(trajectory): build structured
// trajectory records from run traces) and its tests in
// src/observability/trajectory.test.ts. Runs the task's build.js CLI on the
// three fixture traces and checks the TrajectoryRecord contract.
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.cwd();
const fails = [];
const build = (fixture, runId) => {
  const out = join(dir, `.verify-${runId}.json`);
  execFileSync('node', ['build.js', join('traces', fixture), runId, out], { cwd: dir, timeout: 15000 });
  return JSON.parse(readFileSync(out, 'utf8'));
};
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

// --- run-ok: clean run, object task, flat usage, two paired steps ---------
let r = build('run-ok.jsonl', 'run-ok');
eq('ok.schemaVersion', r.schemaVersion, 1);
eq('ok.runId', r.runId, 'run-ok');
eq('ok.startedAt', r.startedAt, 1000);
eq('ok.endedAt', r.endedAt, 5000);
eq('ok.durationMs', r.durationMs, 4000);
eq('ok.task', r.task, { title: 'Fix login', prompt: 'Fix the login redirect' });
eq('ok.outcome', r.outcome, { completed: true, stopReason: 'done' });
eq('ok.usage', r.usage, { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01 });
eq('ok.steps.length', r.steps?.length, 2);
eq('ok.steps[0]', r.steps?.[0] && { tool: r.steps[0].tool, ok: r.steps[0].ok, outputSnippet: r.steps[0].outputSnippet, durationMs: r.steps[0].durationMs }, { tool: 'read', ok: true, outputSnippet: 'file contents', durationMs: 12 });
eq('ok.steps[1].outputSnippet', r.steps?.[1]?.outputSnippet, 'done');
eq('ok.steps[1].durationMs (derived from stamps)', r.steps?.[1]?.durationMs, 100);
eq('ok.failureTaxonomy', r.failureTaxonomy, []);

// --- run-loop: string task, repeated identical calls, tool failure --------
r = build('run-loop.jsonl', 'run-loop');
eq('loop.task', r.task, { title: 'Search for the bug' });
eq('loop.outcome', r.outcome, { completed: false, stopReason: 'tool_loop', reason: 'repeated' });
eq('loop.steps.length', r.steps?.length, 4);
eq('loop.failureTaxonomy', r.failureTaxonomy, [
  { label: 'tool_loop', count: 1 },
  { label: 'repeated_tool_calls', count: 1 },
  { label: 'tool_errors', count: 1 },
]);
eq('loop.failed step error', r.steps?.[3]?.error, 'boom');
eq('loop.failed step outputSnippet', r.steps?.[3]?.outputSnippet, '');
eq('loop.usage', r.usage, null);

// --- run-messy: orphan completion, unclosed call, snippet cap, no task ----
r = build('run-messy.jsonl', 'run-messy');
eq('messy.task', r.task, null);
eq('messy.outcome', r.outcome, { completed: false });
eq('messy.usage', r.usage, null);
eq('messy.steps.length', r.steps?.length, 3);
eq('messy.orphan step', r.steps?.[0] && { tool: r.steps[0].tool, args: r.steps[0].args, ok: r.steps[0].ok, outputSnippet: r.steps[0].outputSnippet }, { tool: 'glob', args: null, ok: true, outputSnippet: 'a.ts b.ts' });
eq('messy.unclosed step ok', r.steps?.[1]?.ok, false);
if (r.steps?.[1] && 'error' in r.steps[1]) fails.push('messy: unclosed call must have NO error key');
if (r.steps?.[0] && 'durationMs' in r.steps[0]) fails.push('messy: orphan step must have NO durationMs key');
eq('messy.snippet length', r.steps?.[2]?.outputSnippet?.length, 500);
eq('messy.failureTaxonomy', r.failureTaxonomy, []);
eq('messy.durationMs', r.durationMs, 200);

if (fails.length === 0) {
  console.log('PASS: trajectory records built to contract across clean, looping, and messy traces');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
