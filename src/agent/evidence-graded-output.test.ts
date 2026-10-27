// Item 17 (evidence-graded output): the default output path, exercised through
// the real finish machinery (fake provider, real Agent.run → finishOnce).
//
// Pinned here:
//   * A completed run's summary carries the Evidence block: claims sourced
//     from code get their citation attached, and a claim with no source in
//     the run is VISIBLY marked [ungrounded] — never silently asserted as
//     fact. (Chat turns cannot run shell — the conversational guardrail
//     blocks it — so test-backed grounding through a real executed command
//     is pinned by the runShell-ledger test below.)
//   * The grade is recorded on the run (AgentResult.claimGrade), on the
//     summary:rendered event, and on the summary document (doc.evidence) —
//     not just in prose.
//   * No-fabrication through the live path: nothing is cited that the run did
//     not observe or that does not resolve on disk.
//   * A summary with no substantive claims is left byte-identical (no
//     behavior change).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { BudgetEngine } from '../budget.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import { collectRunEvidence, gradeClaims } from '../summary/claim-grade.js';
import type { MochiConfig, MochiEvent } from '../types.js';

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000, maxTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

describe('evidence-graded output on the finish path (item 17)', () => {
  it('a completed chat run answers with citations and a visible [ungrounded] marker', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-graded-finish-'));
    let fake: Awaited<ReturnType<typeof startFakeOpenAI>> | undefined;
    try {
      writeFileSync(resolve(dir, 'notes.ts'), 'export const notes = () => 1;\n');
      const readCall = (id: string) => ({ id, type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ path: 'notes.ts' }) } });
      const answer = [
        'The notes helper lives in notes.ts:1 and returns the count.',
        'The notes helper is implemented in notes.ts.',
        'Coverage improved by 3 points.',
      ].join('\n');
      // Chat-shape run (title ≤16 words starting with "hello"): the 5th tool
      // round finishes with the model's real answer (the chat tool-cap branch
      // finishes with the LAST assistant text).
      fake = await startFakeOpenAI([
        { content: 'Reading the notes.', toolCalls: [readCall('r-1')], finishReason: 'tool_calls' },
        { content: 'Still reading.', toolCalls: [readCall('r-2')], finishReason: 'tool_calls' },
        { content: 'Nearly there.', toolCalls: [readCall('r-3')], finishReason: 'tool_calls' },
        { content: 'Reading.', toolCalls: [readCall('r-4')], finishReason: 'tool_calls' },
        { content: answer, toolCalls: [readCall('r-5')], finishReason: 'tool_calls' },
      ]);
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const events = new EventBus();
      const context = new ContextEngine(config, dir);
      context.setGoal('hello');
      const task = createTask('hello there', 'hello, how does the notes system work?');
      const agent = new Agent({ id: 'graded-finish', role: 'coder', config, workspace, events, cwd: dir, context, budget: new BudgetEngine({ maxRuntimeMinutes: 5, maxTokens: 200000, maxConcurrentAgents: 1 } as never) } as never);
      const result = await agent.run(task);
      expect(result.success).toBe(true);
      expect(result.stopReason).toBe('completed');
      // The grade is recorded on the run, not just in prose.
      expect(result.claimGrade).toBeDefined();
      const counts = result.claimGrade!.counts;
      expect(counts.total).toBe(3);
      expect(counts.cited).toBe(2); // in-text notes.ts:1 + run-activity notes.ts (read this run)
      expect(counts.ungrounded).toBe(1); // the coverage claim has no source in the run
      // The default output path: the summary carries the evidence block and
      // the ungrounded claim is visibly marked — never silently asserted.
      expect(result.summary.startsWith(answer)).toBe(true);
      expect(result.summary).toContain('Evidence: 2/3 claims verified (67%) — 2 cited, 0 test-backed; 1 ungrounded.');
      expect(result.summary).toContain('[cited] "The notes helper lives in notes.ts:1 and returns the count." → notes.ts:1');
      expect(result.summary).toContain('[ungrounded] "Coverage improved by 3 points." (no file or test source in this run)');
      // No fabricated line numbers for run-activity citations.
      expect(result.summary).toContain('[cited] "The notes helper is implemented in notes.ts." → notes.ts (read this run)');
      // The event carries the grade too.
      const rendered = events.snapshot().find((e: MochiEvent) => e.type === 'summary:rendered') as { claimGrade?: { counts: { total: number } }; doc?: { evidence?: Array<{ text: string }> } };
      expect(rendered?.claimGrade?.counts.total).toBe(3);
      expect(rendered?.doc?.evidence?.some((i) => i.text.includes('[ungrounded]'))).toBe(true);
    } finally {
      await fake?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a run whose summary holds no substantive claims is left untouched (no behavior change)', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-graded-plain-'));
    let fake: Awaited<ReturnType<typeof startFakeOpenAI>> | undefined;
    try {
      fake = await startFakeOpenAI([
        { content: 'Reading.', toolCalls: [{ id: 'r-1', type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ path: 'notes.ts' }) } }], finishReason: 'tool_calls' },
        { content: 'Reading.', toolCalls: [{ id: 'r-2', type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ path: 'notes.ts' }) } }], finishReason: 'tool_calls' },
        { content: 'Reading.', toolCalls: [{ id: 'r-3', type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ path: 'notes.ts' }) } }], finishReason: 'tool_calls' },
        { content: 'Reading.', toolCalls: [{ id: 'r-4', type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ path: 'notes.ts' }) } }], finishReason: 'tool_calls' },
        { content: 'Hello! Happy to help with more questions.', toolCalls: [{ id: 'r-5', type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ path: 'notes.ts' }) } }], finishReason: 'tool_calls' },
      ]);
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('hello');
      const task = createTask('hello there', 'hello, how does the notes system work?');
      const agent = new Agent({ id: 'graded-plain', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context, budget: new BudgetEngine({ maxRuntimeMinutes: 5, maxTokens: 200000, maxConcurrentAgents: 1 } as never) } as never);
      const result = await agent.run(task);
      expect(result.success).toBe(true);
      expect(result.summary).toBe('Hello! Happy to help with more questions.');
      expect(result.claimGrade).toBeUndefined();
    } finally {
      await fake?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a command executed through runShell lands in the ledger and backs a test-backed claim', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-graded-shell-'));
    try {
      const config = makeConfig(dir, 'http://127.0.0.1:9');
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const agent = new Agent({ id: 'graded-shell', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context: new ContextEngine(config, dir) } as never);
      // The harness-side chokepoint (verify gate, milestone checks): the
      // command RAN with exit 0 — the only way a green entry enters the ledger.
      const out = await (agent as unknown as { runShell: (c: string) => Promise<string> }).runShell('node --version');
      expect(out).toContain('exit_code: 0');
      const ledger = (agent as unknown as { shellLedger: Array<{ command: string; failed: boolean }> }).shellLedger;
      expect(ledger).toHaveLength(1);
      expect(ledger[0].command).toBe('node --version');
      expect(ledger[0].failed).toBe(false);
      // The graded summary now backs the claim with the observed result.
      const report = gradeClaims(
        'The runtime check passes: node --version runs clean.',
        collectRunEvidence({
          cwd: dir,
          greenCommands: ledger.filter((c) => !c.failed).map((c) => c.command),
          failedCommands: ledger.filter((c) => c.failed).map((c) => c.command),
        }),
      );
      expect(report.counts.testBacked).toBe(1);
      expect(report.claims[0].testRef).toBe('✓ node --version');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
