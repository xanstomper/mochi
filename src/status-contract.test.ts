// D3 — assumption-in-artifact + per-step status contract tests.
//
// Covers the three contract surfaces:
//   1. flag grammar + scorers (src/status-contract.ts),
//   2. todo-tool status-ledger enforcement (assumed/blocked must attribute),
//   3. compaction/summarize survival — an assumption flag that dies with a
//      dropped message is re-injected verbatim by the retention probe.
//
// The end-to-end bench legs (real agent loop, scripted provider) live in
// src/agent/assumption-status.bench.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  formatAssumptionLine,
  formatStepStatusLine,
  hasAssumptionFlag,
  hasEvidenceCitation,
  parseAssumptionFlags,
  scanForUnflaggedGuesses,
  ledgerStatusCoverage,
  todoStatusChar,
  type GuessHint,
} from './status-contract.js';
import { todoTool } from './tools/todo.js';
import { Workspace } from './workspace.js';
import { EventBus } from './events.js';
import type { ToolContext } from './tools/types.js';
import type { MochiConfig } from './types.js';
import { extractProbeFacts, probeFactsFromState, dedupeProbeFacts, ensureRetention, MAX_ASSUMPTION_PROBES } from './summary/verified-compaction.js';
import { compactSession, compactToPrompt } from './summary/compact.js';
import { ContextEngine } from './context.js';

describe('D3 flag grammar (status-contract.ts)', () => {
  it('formats the canonical artifact line and parses it back', () => {
    const line = formatAssumptionLine({
      id: 'A-1',
      claim: 'the deploy region is eu-west-1',
      attachesTo: 'deploy-plan.md:3',
      searched: 'grep -rn "region" .',
    });
    expect(line).toBe('[ASSUMPTION:A-1] the deploy region is eu-west-1 — attaches: deploy-plan.md:3; unverified (searched: grep -rn "region" .)');
    const flags = parseAssumptionFlags(`# Plan\nsome line\n${line}`);
    expect(flags).toHaveLength(1);
    expect(flags[0].line).toBe(3);
    expect(flags[0].id).toBe('A-1');
    expect(flags[0].attachesTo).toBe('deploy-plan.md:3');
    expect(flags[0].text).toContain('eu-west-1');
  });

  it('detects tolerant flag variants and UNVERIFIED', () => {
    expect(hasAssumptionFlag('[ASSUMPTION A-2] claim')).toBe(true);
    expect(hasAssumptionFlag('[UNVERIFIED] guess')).toBe(true);
    expect(hasAssumptionFlag('plain sentence')).toBe(false);
  });

  it('formats the per-step status line in every contract state', () => {
    expect(formatStepStatusLine({ state: 'done', step: 'read config', ref: 'deploy.config:1' }))
      .toBe('status: done — read config — evidence: deploy.config:1');
    expect(formatStepStatusLine({ state: 'assumed', step: 'write plan', assumptionId: 'A-1' }))
      .toBe('status: assumed — write plan — assumption: [ASSUMPTION:A-1]');
    expect(formatStepStatusLine({ state: 'blocked', step: 'fetch api', ref: 'no network' }))
      .toBe('status: blocked — fetch api — evidence: no network');
  });

  it('renders distinct ledger glyphs, legacy pending included', () => {
    expect(todoStatusChar('done')).toBe('x');
    expect(todoStatusChar('in_progress')).toBe('-');
    expect(todoStatusChar('pending')).toBe(' ');
    expect(todoStatusChar('blocked')).toBe('B');
    expect(todoStatusChar('assumed')).toBe('A');
    expect(todoStatusChar('open')).toBe('?');
  });
});

describe('D3 scorers (unflagged guesses + status coverage)', () => {
  const hint: GuessHint[] = [{ token: '+1-555-0100' }];

  it('a claim on an unflagged line is a guess; flagged or evidence-cited is attributed', () => {
    const unflagged = 'Call the oncall at +1-555-0100 whenever the build fails.';
    const flagged = '[ASSUMPTION:A-1] the oncall number is +1-555-0100 — attaches: README.md:4; unverified (searched: grep)';
    const cited = 'The region is eu-west-1 (evidence: deploy.config:1).';
    expect(scanForUnflaggedGuesses([{ source: 'a.txt', text: unflagged }], hint)).toHaveLength(1);
    expect(scanForUnflaggedGuesses([{ source: 'a.txt', text: flagged }], hint)).toHaveLength(0);
    // Evidence citation attributes a claim without a flag (search-first leg).
    expect(scanForUnflaggedGuesses([{ source: 'a.txt', text: cited }], [{ token: 'eu-west-1' }])).toHaveLength(0);
  });

  it('a claim within two lines under a flag block is covered by the flag', () => {
    const text = '[ASSUMPTION:A-1] the oncall number is +1-555-0100 — attaches: README.md:4; unverified (searched: grep)\nDial it during incidents.\nPage +1-555-0100 first.';
    expect(scanForUnflaggedGuesses([{ source: 'a.txt', text }], hint)).toHaveLength(0);
  });

  it('scans multiple artifacts and reports each violation with its source and line', () => {
    const guesses = scanForUnflaggedGuesses(
      [
        { source: 'README.md', text: 'no claims here\n' },
        { source: 'notes.md', text: 'line one\nthe number is +1-555-0100 ok' },
      ],
      hint,
    );
    expect(guesses).toHaveLength(1);
    expect(guesses[0].source).toBe('notes.md');
    expect(guesses[0].line).toBe(2);
  });

  it('status coverage: bare done-without-reference is uncovered, cited/flagged/open are covered', () => {
    const before = ledgerStatusCoverage([
      { status: 'done' },
      { status: 'done' },
    ]);
    expect(before).toEqual({ total: 2, covered: 0, rate: 0 });

    const after = ledgerStatusCoverage([
      { status: 'done', notes: 'evidence: deploy.config:1' },
      { status: 'assumed', notes: '[ASSUMPTION:A-1] recorded in plan.md:12' },
      { status: 'blocked', notes: 'blocker: no network access (searched: env, config)' },
      { status: 'open' },
    ]);
    expect(after).toEqual({ total: 4, covered: 4, rate: 1 });
  });
});

describe('D3 todo ledger enforcement (real Workspace)', () => {
  let dir: string;
  let ws: Workspace;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-d3-todo-'));
    ws = new Workspace(dir);
    ws.ensure();
    ctx = { cwd: dir, workspace: ws, config: {} as MochiConfig, events: new EventBus(), agentId: 'test' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects status=assumed without an assumption-flag note', async () => {
    await todoTool.execute({ action: 'add', title: 'Write plan' }, ctx);
    await expect(todoTool.execute({ action: 'status', title: 'Write plan', state: 'assumed' }, ctx))
      .rejects.toThrow(/Status contract violation.*ASSUMPTION/s);
    // The ledger was not mutated.
    expect(ws.loadTodos()[0].status).toBe('pending');
  });

  it('accepts status=assumed when the note references the artifact flag, and persists it', async () => {
    await todoTool.execute({ action: 'add', title: 'Write plan' }, ctx);
    const out = await todoTool.execute({
      action: 'status',
      title: 'Write plan',
      state: 'assumed',
      note: '[ASSUMPTION:A-1] recorded in plan.md:12 — unverified',
    }, ctx);
    expect(out).toContain('[A] Write plan');
    const item = ws.loadTodos()[0];
    expect(item.status).toBe('assumed');
    expect(item.notes).toContain('[ASSUMPTION:A-1]');
    expect(item.notes).toContain('plan.md:12');
  });

  it('rejects status=blocked without a blocker note; accepts with one', async () => {
    await todoTool.execute({ action: 'add', title: 'Fetch api' }, ctx);
    await expect(todoTool.execute({ action: 'status', title: 'Fetch api', state: 'blocked' }, ctx))
      .rejects.toThrow(/Status contract violation.*blocked/s);
    await todoTool.execute({ action: 'status', title: 'Fetch api', state: 'blocked', note: 'no route to host (searched: env, config)' }, ctx);
    expect(ws.loadTodos()[0].status).toBe('blocked');
  });

  it('unknown status names the valid states instead of silently mapping', async () => {
    await todoTool.execute({ action: 'add', title: 'T' }, ctx);
    await expect(todoTool.execute({ action: 'status', title: 'T', state: 'finished' }, ctx))
      .rejects.toThrow(/pending \| in_progress \| done \| blocked \| assumed \| open/);
  });

  it('legacy statuses keep their old behavior: complete needs no note', async () => {
    await todoTool.execute({ action: 'add', title: 'Legacy' }, ctx);
    const out = await todoTool.execute({ action: 'complete', title: 'Legacy' }, ctx);
    expect(out).toContain('[x] Legacy');
    await todoTool.execute({ action: 'add', title: 'Legacy2' }, ctx);
    await todoTool.execute({ action: 'status', title: 'Legacy2', state: 'in_progress' }, ctx);
    expect(ws.loadTodos().find((t) => t.title === 'Legacy2')?.status).toBe('in_progress');
  });

  it('done keeps working without a note (no enforcement change on the legacy path)', async () => {
    await todoTool.execute({ action: 'add', title: 'D' }, ctx);
    await todoTool.execute({ action: 'status', title: 'D', state: 'done' }, ctx);
    expect(ws.loadTodos()[0].status).toBe('done');
  });
});

describe('D3 compaction survival — flags are must-survive probe facts', () => {
  const FLAG = '[ASSUMPTION:A-1] the oncall number is +1-555-0100 — attaches: README.md:4; unverified (searched: grep -rn 555 .)';

  it('extractProbeFacts force-includes a flag line hidden inside write() args, beyond maxFacts', () => {
    const args = JSON.stringify({ path: 'README.md', content: `# Support\n\n${FLAG}\n\nCall during incidents.` });
    const messages = [
      { role: 'user', content: 'Add the oncall number to the README support section.' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write', arguments: args } }] },
      { role: 'tool', tool_call_id: 'w1', name: 'write', content: 'Wrote 5 lines to README.md' },
    ];
    // maxFacts=1 with several salient competitors: the flag must still come out.
    const facts = extractProbeFacts(messages, { maxFacts: 1 });
    const assumption = facts.find((f) => f.kind === 'assumption');
    expect(assumption).toBeDefined();
    expect(assumption!.text).toContain('[ASSUMPTION:A-1]');
    expect(assumption!.text).toContain('+1-555-0100');
  });

  it('two flagged claims on the same path both survive (flag lines bypass needle dedup)', () => {
    const f1 = '[ASSUMPTION:A-1] the oncall is +1-555-0100 — attaches: README.md:4; unverified';
    const f2 = '[ASSUMPTION:A-2] the escalation path is email-first — attaches: README.md:5; unverified';
    const args = JSON.stringify({ path: 'README.md', content: `${f1}\n${f2}` });
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write', arguments: args } }] },
    ];
    const facts = extractProbeFacts(messages, { maxFacts: 1 });
    const assumptions = facts.filter((f) => f.kind === 'assumption');
    // Both flag IDs present (the raw write() args line also matches the
    // flag detector — a third, JSON-noisy fact; harmless, bounded by the cap).
    expect(assumptions.some((f) => f.text.includes('[ASSUMPTION:A-1]'))).toBe(true);
    expect(assumptions.some((f) => f.text.includes('[ASSUMPTION:A-2]'))).toBe(true);
  });

  it('flag-free write args yield no assumption facts (extraction unchanged for old shapes)', () => {
    const args = JSON.stringify({ path: 'README.md', content: '# Support\n\nCall during incidents.\n' });
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write', arguments: args } }] },
    ];
    const facts = extractProbeFacts(messages, { maxFacts: 5 });
    expect(facts.find((f) => f.kind === 'assumption')).toBeUndefined();
  });

  it('assumption probe cap is bounded and exported', () => {
    expect(MAX_ASSUMPTION_PROBES).toBeGreaterThanOrEqual(1);
  });

  it('probeFactsFromState + dedupe: assumption outranks ordinary kinds', () => {
    const state = probeFactsFromState({ goal: 'Fix the login bug so rejected passwords return 401' });
    const flag = {
      id: 'fact-x', text: '[ASSUMPTION:A-9] the fix belongs in login.ts — attaches: login.ts:1; unverified',
      kind: 'assumption' as const, sourceIndex: 0, sourceRole: 'assistant', needles: ['login.ts'], tokens: ['fix'],
    };
    const merged = dedupeProbeFacts([...state, flag]);
    expect(merged[0].kind).toBe('contract'); // pinned contract still leads
    expect(merged.findIndex((f) => f.kind === 'assumption')).toBe(1); // flags outrank everything else
  });

  it('ensureRetention: a summary that paraphrases the claim but drops the flag FAILS the probe and escalates', () => {
    const fact = {
      id: 'fact-a', text: FLAG, kind: 'assumption' as const, sourceIndex: 0, sourceRole: 'assistant',
      needles: ['README.md'], tokens: ['oncall', 'number', '555-0100', 'attaches'],
    };
    const paraphrased = 'Earlier: the oncall number was added to the README support section.';
    let recovered = '';
    const outcome = ensureRetention({
      facts: [fact],
      readText: () => paraphrased + recovered,
      reinject: (missing) => { recovered += '\n' + missing.map((f) => `- [${f.kind}] ${f.text}`).join('\n'); },
    });
    expect(outcome.initial.passed).toBe(false);
    expect(outcome.escalations).toContain('re-include');
    expect(outcome.final.passed).toBe(true);
    expect(recovered).toContain('[ASSUMPTION:A-1]');
  });
});

describe('D3 summarize survival (compactSession / compactToPrompt)', () => {
  it('flagged lines in reasoning and tool outputs carry into the summary verbatim', () => {
    const flag = '[ASSUMPTION:A-1] the oncall number is +1-555-0100 — attaches: README.md:4; unverified (searched: grep)';
    const ctx = compactSession([
      { type: 'agent:reasoning', content: `Searching done. No match anywhere.\n${flag}\nProceeding with the flag.` },
      { type: 'tool:completed', tool: 'write', result: { output: `Wrote README.md\n${flag}` } },
    ] as any[]);
    expect(ctx.assumptions).toHaveLength(1); // deduped by pushBounded
    expect(ctx.assumptions[0]).toBe(flag);
    expect(ctx.isEmpty).toBe(false);
    const prompt = compactToPrompt(ctx);
    expect(prompt).toContain('ASSUMPTIONS (UNVERIFIED');
    expect(prompt).toContain('[ASSUMPTION:A-1]');
    expect(prompt).toContain('+1-555-0100');
  });

  it('a slice with NO flags has no assumptions section (unchanged summary shape)', () => {
    const ctx = compactSession([
      { type: 'agent:reasoning', content: 'decided to use approach B because it is simpler' },
      { type: 'tool:completed', tool: 'read', result: { output: 'file contents head' } },
    ] as any[]);
    expect(ctx.assumptions).toHaveLength(0);
    expect(compactToPrompt(ctx)).not.toContain('ASSUMPTIONS');
  });
});

describe('D3 real compaction (ContextEngine.compact) — flag survives the cut verbatim', () => {
  function makeConfig(dir: string): MochiConfig {
    return {
      model: { provider: 'openai', model: 'fake-model' },
      safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
      permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
      telemetry: false, projectDir: '.mochi', configDir: resolve(dir, '.config/mochi'),
      quiet: true, verbose: false, debug: false,
    } as unknown as MochiConfig;
  }

  it('a dropped flagged write is re-injected by the retention probe when the checkpoint drops the flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-d3-compact-'));
    try {
      const engine = new ContextEngine(makeConfig(dir), dir);
      engine.setGoal('Add the oncall number to the README support section');
      const FLAG = '[ASSUMPTION:A-1] the oncall number is +1-555-0100 — attaches: README.md:4; unverified (searched: grep -rn 555 .)';
      engine.addMessage({ role: 'user', content: 'Add the oncall number to the README support section. The number is not written anywhere in this workspace.' });
      engine.addMessage({
        role: 'assistant',
        content: 'No match anywhere. Writing the section with the assumption flagged in the artifact.',
        tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'README.md', content: `# Support\n\n${FLAG}\n` }) } }],
      });
      engine.addMessage({ role: 'tool', tool_call_id: 'w1', name: 'write', content: 'Wrote 3 lines to README.md' });
      for (let i = 0; i < 26; i++) {
        engine.addMessage({ role: 'user', content: `Progress check ${i}: the README support section work continues per the task.` });
        engine.addMessage({ role: 'assistant', content: `Working on followup ${i}, reviewing the support section and the incidents wording carefully.` });
      }
      // A model-written checkpoint that paraphrases the work but DROPS the flag —
      // exactly the summarize pass the contract must survive.
      const checkpoint = 'GOAL: add oncall number to README support section. Progress: section written, wording reviewed.';
      await engine.compact(checkpoint);
      const packet = engine.buildPacket([], undefined as any, undefined as any);
      const flat = packet.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      expect(flat).toContain('[ASSUMPTION:A-1]');
      expect(flat).toContain('+1-555-0100');
      // The probe PASSED (escalation proved it worked) — never silently lost.
      expect(engine.lastCompactionVerification?.passed).toBe(true);
      // And the surviving line is the flagged one, not a re-derived paraphrase.
      expect(flat).toContain('unverified');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
