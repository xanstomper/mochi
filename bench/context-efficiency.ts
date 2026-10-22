#!/usr/bin/env tsx
// Context/token efficiency scorecard bench (companion to the efficiency pass).
// Builds a fixture workspace + ContextEngine and prints BEFORE/AFTER-comparable
// metrics: prompt-assembly cost per turn, stable-prefix size/stability, token
// estimator totals on a fixture corpus, digest-input information survival,
// and mid-size tool-output fold behaviour.
// Usage: ./node_modules/.bin/tsx bench/context-efficiency.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine, approxTokens, cachedMessageTokens } from '../src/context.js';
import { applyToolOutputPolicy } from '../src/core/tool-output.js';
import { buildDigestInput } from '../src/summary/digest-input.js';
import { recallArchivedOutput, listArchivedOutputs } from '../src/tools/output-archive.js';

function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'mochi-eff-bench-'));
  mkdirSync(join(root, '.mochi', 'rules'), { recursive: true });
  mkdirSync(join(root, '.mochi', 'state'), { recursive: true });
  mkdirSync(join(root, '.mochi', 'memory'), { recursive: true });
  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(root, '.mochi', 'rules', `rule-${i}.md`),
      `---\ntitle: "Rule ${i}"\nkeywords: ["typescript", "tests"]\n---\nAlways run the full test suite before committing change set ${i}. Prefer targeted edits in src/ and keep functions under 60 lines.\n`);
  }
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(root, '.cursor', 'rules', `cursor-${i}.md`), `# Cursor rule ${i}\nUse strict typing in module ${i}.\n`);
  }
  writeFileSync(join(root, 'MOCHI.md'), '# MOCHI.md\n\nProject instructions.\n\n- Use pnpm, never npm.\n- All timestamps in UTC.\n');
  writeFileSync(join(root, '.mochi', 'project.md'), '# Project\nFixture project for efficiency bench.\n');
  writeFileSync(join(root, '.mochi', 'state', 'todo.json'), JSON.stringify([
    { order: 1, status: 'done', title: 'Set up fixture' },
    { order: 2, status: 'in_progress', title: 'Measure prompt assembly' },
    { order: 3, status: 'pending', title: 'Ship efficiency pass' },
  ]));
  return root;
}

const root = fixtureWorkspace();
const cfg = {
  model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
  safety: { contextBudgetTokens: 100_000, maxIterations: 50, maxRuntimeMinutes: 10, mode: 'safe' },
} as never;
const engine = new ContextEngine(cfg, root, join(root, 'no-skills'));
engine.setGoal('Fix the parser bug in src/parser.ts');
engine.addMessage({ role: 'user', content: 'Fix the parser bug in src/parser.ts and run the tests' } as never);
engine.addMessage({ role: 'assistant', content: 'Looking at the parser now.' } as never);

const task = { title: 'Fix parser bug', description: 'Fix the parser bug in src/parser.ts', acceptanceCriteria: [] } as never;
const tools = [] as never[];

// ── 1. Prompt assembly cost per turn (buildPacket does full prompt build) ──
const N = 60;
const t0 = performance.now();
let packet: ReturnType<ContextEngine['buildPacket']> | undefined;
for (let i = 0; i < N; i++) packet = engine.buildPacket(tools, task);
const perTurnMs = (performance.now() - t0) / N;

// ── 2. Stable prefix: size + byte stability across a volatile change ──
const sysA = packet!.messages[0].content as string;
writeFileSync(join(root, '.mochi', 'state', 'todo.json'), JSON.stringify([
  { order: 1, status: 'done', title: 'Set up fixture' },
  { order: 2, status: 'done', title: 'Measure prompt assembly' },
  { order: 3, status: 'in_progress', title: 'Ship efficiency pass' },
]));
engine.updateState({ nextAction: 'ship it' });
const packet2 = engine.buildPacket(tools, task);
const sysB = packet2.messages[0].content as string;
console.log(JSON.stringify({
  metric: 'prompt-assembly',
  buildPacketMsPerTurn: Number(perTurnMs.toFixed(3)),
  stablePrefixChars: sysA.length,
  stablePrefixTokens: approxTokens(sysA),
  stablePrefixByteIdenticalAcrossVolatileChange: sysA === sysB,
}, null, 1));

// ── 3. Estimator totals on a fixture corpus ──
const corpus: Record<string, string> = {
  prose: 'The quick brown fox jumps over the lazy dog and keeps running through the forest. '.repeat(30),
  code: 'export function parse(input: string): Token[] {\n  const tokens: Token[] = [];\n  let pos = 0;\n  while (pos < input.length) { tokens.push(next(input, pos)); }\n  return tokens;\n}\n'.repeat(12),
  log: '2026-01-01T00:00:00.000Z INFO  worker[job=abc123] attempt 3/5 completed in 412ms status=ok\n'.repeat(30),
  jsonish: JSON.stringify({ role: 'tool', name: 'shell', content: 'x'.repeat(400) }).repeat(6),
};
let totChars = 0, totEst = 0;
for (const [k, v] of Object.entries(corpus)) {
  totChars += v.length; totEst += approxTokens(v);
  console.log(JSON.stringify({ metric: 'estimator', kind: k, chars: v.length, approxTokens: approxTokens(v), charsPerToken: Number((v.length / approxTokens(v)).toFixed(2)) }));
}
console.log(JSON.stringify({ metric: 'estimator-total', chars: totChars, approxTokens: totEst, charsPerToken: Number((totChars / totEst).toFixed(2)) }));

// ── 4. Digest-input survival probe ──
type M = { role: string; content: string; name?: string };
const filler = (i: number): M => ({ role: 'tool', name: 'shell', content: `step ${i} ok\n${'routine output line, nothing notable here, moving on with the task at hand.\n'.repeat(6)}exit 0` });
const msgs: M[] = [];
for (let i = 0; i < 18; i++) msgs.push(filler(i));
msgs.push({ role: 'assistant', content: `${'Investigating the layout engine and its constraints in some depth before touching anything. '.repeat(8)}DECISION: we will use the Rust tokenizer for counting because the TS fallback diverged.` });
for (let i = 18; i < 34; i++) msgs.push(filler(i));
msgs.push({ role: 'tool', name: 'shell', content: `${'compiling module after module, all quiet so far, no diagnostics worth keeping.\n'.repeat(10)}src/parser.ts:142: error TS2345: Argument of type 'string' is not assignable to parameter of type 'Token'.\n${'trailing build noise continues for a while after the failure line above.\n'.repeat(4)}` });
for (let i = 34; i < 40; i++) msgs.push(filler(i));
const oldStyle = msgs.map((m) => `${m.role}: ${(m.content ?? '').slice(0, 400)}`).join('\n').slice(0, 12_000);
const newStyle = buildDigestInput(msgs as never, 12_000);
console.log(JSON.stringify({
  metric: 'digest-survival',
  oldKeepsDecision: oldStyle.includes('DECISION: we will use the Rust tokenizer'),
  oldKeepsError: oldStyle.includes('error TS2345'),
  newKeepsDecision: newStyle.includes('DECISION: we will use the Rust tokenizer'),
  newKeepsError: newStyle.includes('error TS2345'),
  oldChars: oldStyle.length,
  newChars: newStyle.length,
}, null, 1));

// ── 5. Mid-size shell output (~13KB): under the policy's 20KB/400-line caps
// (so it reaches the context engine untouched), over the ingest fold caps.
const shellOut = Array.from({ length: 150 }, (_, i) => `line ${i}: build step output ${'x'.repeat(48)}`).join('\n')
  + '\nMIDDLE-MARKER: the one line that matters is here\n'
  + Array.from({ length: 60 }, (_, i) => `tail ${i}: more output`).join('\n');
const pol = applyToolOutputPolicy(shellOut, { toolName: 'shell' });
const engine2 = new ContextEngine(cfg, root, join(root, 'no-skills'));
engine2.addMessage({ role: 'tool', name: 'shell', content: pol.content } as never);
const stored = (engine2.getMessages()[0] as { content: string }).content;
const archived = listArchivedOutputs(root);
const recallHit = archived.length ? recallArchivedOutput(root, archived[archived.length - 1].id) : null;
console.log(JSON.stringify({
  metric: 'tool-output-fold',
  rawChars: shellOut.length,
  policyTruncated: pol.truncated,
  inlineCharsAfterIngest: stored.length,
  inlineTokensAfterIngest: approxTokens(stored),
  middleLineInline: stored.includes('MIDDLE-MARKER'),
  archivedForRecall: archived.length > 0,
  recallRecoversMiddle: Boolean(recallHit?.text.includes('MIDDLE-MARKER')),
}, null, 1));
