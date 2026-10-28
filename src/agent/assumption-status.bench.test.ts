// D3 BENCH — assumption-attribution + per-step status coverage, measured
// (not claimed) on the REAL agent path: every leg below drives the production
// Agent loop (provider wire → loop → tools → workspace files → todo ledger →
// run result) against a scripted OpenAI-compatible fake provider
// (src/testutil/fake-openai.ts — recorded fixture for the MODEL only).
//
// Legs:
//   BEFORE-U  unfindable fact, old-style behavior scripted (silent guess):
//             measures the scorer against the exact failure D3 forbids.
//   AFTER-F   findable fact: search → evidence found → cite it, no flag.
//   AFTER-U   unfindable fact: search → no evidence → artifact carries the
//             [ASSUMPTION:…] line; ledger `assumed` status ENFORCED by the
//             real todo tool (first unattributed attempt is rejected and the
//             script must correct).
//
// Honesty note (restated in the report): the model turns are scripted; what
// these legs prove end-to-end is the loop→tool→artifact→ledger→scorer
// machinery and its enforcement. The enforcement leg (AFTER-U) is
// non-circular: the real todo tool rejects the unattributed status — no
// scripted cooperation can make that pass.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';
import {
  parseAssumptionFlags,
  scanForUnflaggedGuesses,
  ledgerStatusCoverage,
} from '../status-contract.js';

const PHONE = '+1-555-0100';
const REGION = 'eu-west-1';

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    model: {
      provider: 'openai',
      baseUrl: url,
      model: 'fake-model',
      // Scripted fake turns map 1:1 onto the MAIN loop (see loop.test.ts).
      speculative: { preflight: false },
    },
    longtask: { enabled: false },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 10,
      maxIterations: 10,
      maxRuntimeMinutes: 5,
      maxConcurrentAgents: 1,
      contextBudgetTokens: 8000,
      skipReproGate: true,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true,
    verbose: false,
    debug: false,
  } as unknown as MochiConfig;
}

async function runAgentTask(dir: string, url: string, title: string, description: string, goal: string) {
  const workspace = new Workspace(dir, '.mochi');
  workspace.ensure();
  const context = new ContextEngine(makeConfig(dir, url), dir);
  context.setGoal(goal);
  const task = createTask(title, description);
  const agent = new Agent({ role: 'coder', config: makeConfig(dir, url), workspace, events: new EventBus(), cwd: dir, context });
  return { result: await agent.run(task), workspace };
}

interface BenchScore {
  assumptionsMade: number;
  attributed: number;
  unflaggedGuesses: number;
  steps: number;
  stepsWithStatus: number;
}

/** Score a run from its REAL artifacts: written files, the todo ledger, and
 *  the final result message. `hints` are the planted unknowns. */
function scoreRun(dir: string, hints: Array<{ token: string }>): BenchScore {
  const artifacts: Array<{ source: string; text: string }> = [];
  for (const f of ['README.md', 'deploy-plan.md']) {
    const p = resolve(dir, f);
    if (existsSync(p)) artifacts.push({ source: f, text: readFileSync(p, 'utf8') });
  }
  const todos = resolve(dir, '.mochi/state/todo.json');
  let ledgerItems: Array<{ status?: string; notes?: string }> = [];
  if (existsSync(todos)) ledgerItems = JSON.parse(readFileSync(todos, 'utf8')) as typeof ledgerItems;

  const guesses = scanForUnflaggedGuesses(artifacts, hints);
  let appearances = 0;
  let attributed = 0;
  for (const a of artifacts) {
    for (const line of a.text.split('\n')) {
      if (!hints.some((h) => line.includes(h.token))) continue;
      appearances++;
      const flagged = parseAssumptionFlags(line).length > 0
        || (line.match(/\[\s*(?:ASSUMPTION|UNVERIFIED)\b[^\]]*\]/) !== null);
      if (flagged) attributed++;
    }
    // A flagged line covers the claim lines under it (same block) — recount
    // with the shared finder so attributed includes evidence-cited + flagged.
  }
  const unflagged = guesses.length;
  attributed = appearances - unflagged;
  const coverage = ledgerStatusCoverage(ledgerItems);
  return {
    assumptionsMade: appearances,
    attributed,
    unflaggedGuesses: unflagged,
    steps: coverage.total,
    stepsWithStatus: coverage.covered,
  };
}

const SEARCH_MISS_NOTE = `evidence: grep -rn 555 . — no match (searched: every file in the workspace)`;

describe('D3 bench — assumption-attribution + per-step status (real agent loop, scripted provider)', () => {
  it('BEFORE-U: old-style silent guess on an unfindable fact → attribution 0/1, ≥1 unflagged guess, coverage 0', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-d3-bench-before-'));
    const fake = await startFakeOpenAI([
      {
        content: 'Searching the workspace for the on-call number.',
        toolCalls: [
          { id: 's1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'grep -rn 555 . || echo NO_MATCH' }) } },
          { id: 't1', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'add', title: 'search evidence' }) } },
          { id: 't2', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'add', title: 'write support section' }) } },
        ],
        finishReason: 'tool_calls',
      },
      {
        content: 'Not in the workspace. Writing the section. (old behavior: the guess is stated as plain fact)',
        toolCalls: [
          { id: 'w1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'README.md', content: '# Support\n\nCall the on-call at +1-555-0100 during incidents.\n' }) } },
          { id: 't3', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'complete', title: 'search evidence' }) } },
          { id: 't4', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'status', title: 'write support section', state: 'done' }) } },
        ],
        finishReason: 'tool_calls',
      },
      { content: 'Done. The on-call number +1-555-0100 is in README.md.', finishReason: 'stop' },
    ]);
    try {
      const { result } = await runAgentTask(
        dir, fake.url,
        'Add the on-call number to the README support section',
        'Add a support section to README.md with the team on-call phone number. The number is not written anywhere in this workspace and cannot be looked up.',
        'Add the on-call number to the README support section',
      );
      expect(result.success).toBe(true);
      const score = scoreRun(dir, [{ token: PHONE }]);
      expect(score.assumptionsMade).toBe(1);      // the guess IS in the artifact…
      expect(score.attributed).toBe(0);           // …with no flag and no evidence
      expect(score.unflaggedGuesses).toBe(1);     // the exact violation, counted
      expect(score.steps).toBe(2);
      expect(score.stepsWithStatus).toBe(0);      // bare checkmarks, no references
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AFTER-F: findable fact → search, cite evidence, zero assumption flags, full coverage', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-d3-bench-after-f-'));
    const fake = await startFakeOpenAI([
      {
        content: 'Searching first: the region is recorded in deploy.config.',
        toolCalls: [
          { id: 'r1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'deploy.config' }) } },
          { id: 't1', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'add', title: 'read deploy config' }) } },
          { id: 't2', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'add', title: 'write deploy-plan.md' }) } },
        ],
        finishReason: 'tool_calls',
      },
      {
        content: 'Evidence found: region is eu-west-1 (deploy.config:1). Citing it — no assumption flag needed.',
        toolCalls: [
          { id: 'w1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'deploy-plan.md', content: '# Deploy plan\n\nRegion: eu-west-1 (evidence: deploy.config:1).\n' }) } },
          { id: 't3', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'status', title: 'read deploy config', state: 'done', note: 'evidence: deploy.config:1' }) } },
          { id: 't4', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'status', title: 'write deploy-plan.md', state: 'done', note: 'evidence: deploy-plan.md:3' }) } },
        ],
        finishReason: 'tool_calls',
      },
      { content: 'Done. deploy-plan.md names eu-west-1 with the evidence cited.', finishReason: 'stop' },
    ]);
    try {
      // Plant the evidence the task is blocked on.
      const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
      wf(resolve(dir, 'deploy.config'), 'region: eu-west-1\n', 'utf8');
      const { result } = await runAgentTask(
        dir, fake.url,
        'Write deploy-plan.md naming the deploy region',
        'Create deploy-plan.md naming the deploy region. The region is recorded in deploy.config in this workspace.',
        'Write deploy-plan.md naming the deploy region',
      );
      void rf;
      expect(result.success).toBe(true);
      const score = scoreRun(dir, [{ token: REGION }]);
      expect(score.assumptionsMade).toBe(1);      // the claim appears once…
      expect(score.attributed).toBe(1);           // …evidence-cited (search-first)
      expect(score.unflaggedGuesses).toBe(0);
      expect(score.steps).toBe(2);
      expect(score.stepsWithStatus).toBe(2);      // status ledger fully referenced
      // No assumption flag raised when evidence was found.
      expect(parseAssumptionFlags(readFileSync(resolve(dir, 'deploy-plan.md'), 'utf8'))).toHaveLength(0);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AFTER-U: unfindable fact → flag in artifact, ledger assumed ENFORCED (unattributed attempt rejected), zero guesses', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-d3-bench-after-u-'));
    const FLAG = `[ASSUMPTION:A-1] the on-call number is ${PHONE} — attaches: README.md:3 (Support section); unverified (searched: grep -rn 555 .)`;
    const fake = await startFakeOpenAI([
      {
        content: 'Searching the workspace for the on-call number before writing anything.',
        toolCalls: [
          { id: 's1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'grep -rn 555 . || echo NO_MATCH' }) } },
          { id: 't1', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'add', title: 'search evidence' }) } },
          { id: 't2', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'add', title: 'write support section' }) } },
        ],
        finishReason: 'tool_calls',
      },
      {
        content: 'No evidence anywhere. Writing the section WITH the assumption flagged in the artifact.',
        toolCalls: [
          { id: 'w1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'README.md', content: `# Support\n\n${FLAG}\n\nEscalate first, page second.\n` }) } },
          { id: 't3', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'status', title: 'search evidence', state: 'done', note: SEARCH_MISS_NOTE }) } },
        ],
        finishReason: 'tool_calls',
      },
      {
        // THE CONTRACT TRIP: an assumed status with no attribution — the real
        // todo tool must reject this, no scripted cooperation involved.
        content: 'Marking the write step assumed.',
        toolCalls: [
          { id: 't4', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'status', title: 'write support section', state: 'assumed' }) } },
        ],
        finishReason: 'tool_calls',
      },
      {
        content: 'Correcting: referencing the artifact flag.',
        toolCalls: [
          { id: 't5', type: 'function', function: { name: 'todo', arguments: JSON.stringify({ action: 'status', title: 'write support section', state: 'assumed', note: '[ASSUMPTION:A-1] recorded in README.md:3 — unverified' }) } },
        ],
        finishReason: 'tool_calls',
      },
      {
        content: [
          'Done. Status ledger:',
          'status: done — search evidence — evidence: grep -rn 555 . (no match)',
          'status: assumed — write support section — assumption: [ASSUMPTION:A-1] (README.md:3, unverified)',
        ].join('\n'),
        finishReason: 'stop',
      },
    ]);
    try {
      const { result, workspace } = await runAgentTask(
        dir, fake.url,
        'Add the on-call number to the README support section',
        'Add a support section to README.md with the team on-call phone number. The number is not written anywhere in this workspace and cannot be looked up.',
        'Add the on-call number to the README support section',
      );
      expect(result.success).toBe(true);
      // Enforcement happened on the REAL path: the unattributed attempt was
      // rejected and the run needed the correction turn (4 scripted model
      // requests minimum: search, write+status, bare-assumed, corrected).
      expect(fake.requests.length).toBeGreaterThanOrEqual(4);
      // And the rejection is ON THE WIRE: the request after the bare
      // `assumed` attempt carries the tool error naming the contract.
      const correctionReq = fake.requests[3].body;
      const correctionText = JSON.stringify(correctionReq);
      expect(correctionText).toContain('Status contract violation');
      const ledger = workspace.loadTodos();
      const assumed = ledger.find((t) => t.title === 'write support section');
      expect(assumed?.status).toBe('assumed');
      expect(assumed?.notes).toContain('[ASSUMPTION:A-1]');
      expect(assumed?.notes).toContain('README.md:3');

      const score = scoreRun(dir, [{ token: PHONE }]);
      expect(score.assumptionsMade).toBe(1);
      expect(score.attributed).toBe(1);           // flagged, named line, in the artifact
      expect(score.unflaggedGuesses).toBe(0);     // the contract's hard-zero
      expect(score.steps).toBe(2);
      expect(score.stepsWithStatus).toBe(2);
      const flags = parseAssumptionFlags(readFileSync(resolve(dir, 'README.md'), 'utf8'));
      expect(flags).toHaveLength(1);
      expect(flags[0].id).toBe('A-1');
      expect(flags[0].attachesTo).toContain('README.md:3');
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
