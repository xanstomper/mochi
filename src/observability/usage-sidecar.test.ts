// D1: per-run usage/cost telemetry sidecar tests.
//
// Five groups, per the D1 brief:
//  1. Round-trip — write then read back identical fields.
//  2. Field completeness — every required field present, each either a
//     measurement or explicitly unavailable-with-reason (never a silent
//     omission, never an invented 0).
//  3. Redaction — credential-shaped values never land in a sidecar.
//  4. Spawn-path coverage — the runtime one-shot seam (the path `mochi -p`,
//     gate trials, the scorecard live runner, the SDK and the daemon all
//     funnel through Runtime.runPromptDetailed) writes a sidecar for a REAL
//     agent run over the fake OpenAI wire; aux (subagent) attribution on the
//     recorder's own bucketing.
//  5. Existing behavior — no sidecar ⇒ consumers unchanged: trace scanning
//     still answers and the run result itself is untouched by the write.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Runtime } from '../runtime.js';
import { EventBus } from '../events.js';
import { scanRunTraces } from '../evals/regression-gate.js';
import {
  UsageSidecarRecorder, measuredNumber, newestUsageSidecar, readUsageSidecar,
  sidecarCostUsd, sidecarTotalTokens, writeUsageSidecar,
  type UsageSidecar,
} from './usage-sidecar.js';
import { startFakeOpenAI, type FakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), 'mochi-sidecar-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const WORKSPACE = () => resolve(dir, '.mochi');

/** A recorder with two main-agent usage events (one cache-reporting), a
 *  subagent with its own usage, and tool calls — the aux-heavy shape. */
function auxHeavyRecorder(): UsageSidecarRecorder {
  const events = new EventBus();
  const rec = new UsageSidecarRecorder(WORKSPACE(), 'run-aux', { model: 'fake-model', provider: 'openai' }).attach(events);
  events.emit({ type: 'subagent:started', agentId: 'child-1', parentId: 'main-1', role: 'coder', prompt: 'explore' });
  events.emit({ type: 'usage:updated', agentId: 'main-1', inputTokens: 900, outputTokens: 100, cacheTokens: 400, cacheMeasured: true, totalTokens: 1000, costUsd: 0.01, model: 'fake-model' });
  events.emit({ type: 'usage:updated', agentId: 'main-1', inputTokens: 700, outputTokens: 300, cacheTokens: 0, cacheMeasured: true, totalTokens: 1000, costUsd: 0.02, model: 'fake-model' });
  events.emit({ type: 'usage:updated', agentId: 'child-1', inputTokens: 500, outputTokens: 250, cacheTokens: 100, cacheMeasured: true, totalTokens: 750, costUsd: 0.005, model: 'fake-model' });
  events.emit({ type: 'tool:called', agentId: 'main-1', tool: 'read', args: { path: 'a.txt' } });
  events.emit({ type: 'tool:called', agentId: 'child-1', tool: 'grep', args: { pattern: 'x' } });
  events.emit({ type: 'task:completed', agentId: 'main-1', task: { id: 't1', title: 't', description: 't', role: 'coder', status: 'completed', priority: 1, dependencies: [], acceptanceCriteria: [], attempts: [], createdAt: 0, updatedAt: 0 } as never });
  return rec;
}

describe('sidecar round-trip (write then read back identical fields)', () => {
  it('finish() writes a file that readUsageSidecar returns field-for-field', () => {
    const rec = auxHeavyRecorder();
    const goalResult = {
      success: true,
      goal: { id: 'run-aux', status: 'completed' },
      tokensUsed: 2000, tokensIn: 1600, tokensOut: 400, tokensCached: 400,
      costUsd: 0.03, modelCalls: 2, durationMs: 1234,
    };
    const built = JSON.parse(JSON.stringify(rec.build({ goalResult }))) as UsageSidecar;
    const path = rec.finish({ goalResult });
    expect(path).toBeTruthy();
    const read = readUsageSidecar(WORKSPACE(), 'run-aux');
    expect(read).not.toBeNull();
    expect(read).toEqual(built);
    rec.close();
  });

  it('close() without finish() still writes an honest sidecar (exit reason unavailable)', () => {
    const events = new EventBus();
    const rec = new UsageSidecarRecorder(WORKSPACE(), 'run-crash', { model: 'fake-model', provider: 'openai' }).attach(events);
    events.emit({ type: 'usage:updated', agentId: 'main-1', inputTokens: 10, outputTokens: 5, cacheTokens: 0, cacheMeasured: true, totalTokens: 15, costUsd: 0, model: 'fake-model' });
    rec.close(); // no finish — crash/abort path
    const read = readUsageSidecar(WORKSPACE(), 'run-crash');
    expect(read).not.toBeNull();
    expect(read!.exitReason).toEqual({ unavailable: true, reason: expect.any(String) } satisfies { unavailable: true; reason: string });
    expect(read!.usage.totalTokens).toBe(15);
  });
});

describe('sidecar field completeness (present, or unavailable-with-reason)', () => {
  it('aux-heavy run: every required field present and measured', () => {
    const rec = auxHeavyRecorder();
    const sidecar = rec.build({ goalResult: { success: true, goal: { status: 'completed' }, modelCalls: 2, durationMs: 999 } });
    rec.close();
    // Every required top-level field exists (never silently omitted).
    for (const k of ['kind', 'version', 'runId', 'model', 'provider', 'startedAt', 'endedAt', 'durationMs', 'exitReason', 'success', 'usage', 'auxiliary', 'totalIncludingAuxiliary', 'notes']) {
      expect(sidecar, `field ${k}`).toHaveProperty(k);
    }
    for (const k of ['apiCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'totalTokens', 'costUsd']) {
      expect(sidecar.usage, `usage.${k}`).toHaveProperty(k);
    }
    for (const k of ['subagents', 'tools', 'other']) {
      expect(sidecar.auxiliary, `auxiliary.${k}`).toHaveProperty(k);
    }
    // Measured values on this path.
    expect(sidecar.model).toBe('fake-model');
    expect(sidecar.provider).toBe('openai');
    expect(typeof sidecar.startedAt).toBe('string');
    expect(typeof sidecar.endedAt).toBe('string');
    expect(sidecar.exitReason).toBe('completed');
    expect(sidecar.success).toBe(true);
    expect(sidecar.usage.totalTokens).toBe(2000); // main only
    expect(sidecar.usage.inputTokens).toBe(1600);
    expect(sidecar.usage.outputTokens).toBe(400);
    expect(sidecar.usage.cacheReadTokens).toBe(400);
    expect(sidecar.usage.apiCalls).toBe(2);
    expect(sidecar.usage.costUsd).toEqual({ reported: 0.03, estimated: 0, source: 'provider', complete: true });
    // Per-aux breakdown.
    expect(sidecar.auxiliary.subagents).toMatchObject({ count: 1, apiCalls: 1, totalTokens: 750, costUsd: 0.005 });
    expect(sidecar.auxiliary.subagents).not.toHaveProperty('unavailable');
    const subs = sidecar.auxiliary.subagents as { children: Array<{ agentId: string; usageReported: boolean }> };
    expect(subs.children[0]).toMatchObject({ agentId: 'child-1', usageReported: true });
    expect(sidecar.auxiliary.tools).toEqual({ calls: 2, byTool: { grep: 1, read: 1 } });
    // Totals include aux.
    expect(sidecar.totalIncludingAuxiliary).toEqual({ apiCalls: 3, inputTokens: 2100, outputTokens: 650, cacheReadTokens: 500, totalTokens: 2750, costUsd: { reported: 0.035, estimated: 0, source: 'provider', complete: true } });
    expect(sidecarTotalTokens(sidecar)).toBe(2750);
    expect(sidecarCostUsd(sidecar)).toBeCloseTo(0.035, 10);
  });

  it('no usage events on the path: token fields explicitly unavailable, never 0', () => {
    const events = new EventBus();
    const rec = new UsageSidecarRecorder(WORKSPACE(), 'run-nousage', { model: 'fake-model', provider: 'openai' }).attach(events);
    // Tool calls happened, but the provider never surfaced a usage object.
    events.emit({ type: 'tool:called', agentId: 'main-1', tool: 'read', args: {} });
    events.emit({ type: 'task:failed', agentId: 'main-1', task: { id: 't1', title: 't', description: 't', role: 'coder', status: 'failed', priority: 1, dependencies: [], acceptanceCriteria: [], attempts: [], createdAt: 0, updatedAt: 0 } as never, reason: 'Model request failed' });
    const sidecar = rec.build({});
    rec.close();
    expect(sidecar.usage.totalTokens).toEqual({ unavailable: true, reason: expect.any(String) });
    expect(sidecar.usage.inputTokens).toEqual({ unavailable: true, reason: expect.any(String) });
    expect(sidecar.usage.outputTokens).toEqual({ unavailable: true, reason: expect.any(String) });
    expect(sidecar.usage.cacheReadTokens).toEqual({ unavailable: true, reason: expect.any(String) });
    // Not a fabricated 0 — every unavailability names a reason.
    for (const v of [sidecar.usage.totalTokens, sidecar.usage.inputTokens, sidecar.usage.outputTokens, sidecar.usage.cacheReadTokens]) {
      expect((v as { unavailable: true; reason: string }).reason.length).toBeGreaterThan(10);
    }
    expect(sidecar.usage.apiCalls).toEqual({ unavailable: true, reason: expect.any(String) });
    expect(sidecar.usage.costUsd).toEqual({ unavailable: true, reason: expect.any(String) });
    expect(sidecar.exitReason).toBe('failed: Model request failed');
    expect(sidecar.success).toBe(false);
  });

  it('calls happened but the provider never reported cache data: cacheReadTokens unavailable, tokens measured', () => {
    const events = new EventBus();
    const rec = new UsageSidecarRecorder(WORKSPACE(), 'run-nocache', { model: 'fake-model', provider: 'openai' }).attach(events);
    events.emit({ type: 'usage:updated', agentId: 'main-1', inputTokens: 500, outputTokens: 50, cacheTokens: 0, totalTokens: 550, costUsd: 0, model: 'fake-model' });
    const sidecar = rec.build({});
    rec.close();
    expect(sidecar.usage.totalTokens).toBe(550);
    expect(sidecar.usage.cacheReadTokens).toEqual({ unavailable: true, reason: expect.stringContaining('cache') });
  });

  it('no ledger on the path: apiCalls falls back to billed-usage-event count, with a note', () => {
    const events = new EventBus();
    const rec = new UsageSidecarRecorder(WORKSPACE(), 'run-noledger', {}).attach(events);
    events.emit({ type: 'usage:updated', agentId: 'main-1', inputTokens: 10, outputTokens: 5, cacheTokens: 0, cacheMeasured: true, totalTokens: 15, costUsd: 0, model: 'wire-model' });
    const sidecar = rec.build({});
    rec.close();
    expect(sidecar.usage.apiCalls).toBe(1);
    expect(sidecar.notes.join(' ')).toContain('no budget ledger');
    expect(sidecar.model).toBe('wire-model'); // from the billed call, not the (absent) meta
    expect(sidecar.provider).toEqual({ unavailable: true, reason: expect.any(String) });
  });

  it('ledger vs events mismatch is refused, not invented', () => {
    const events = new EventBus();
    const rec = new UsageSidecarRecorder(WORKSPACE(), 'run-mismatch', { model: 'm', provider: 'p' }).attach(events);
    events.emit({ type: 'usage:updated', agentId: 'main-1', inputTokens: 10, outputTokens: 5, cacheTokens: 0, cacheMeasured: true, totalTokens: 15, costUsd: 0, model: 'm' });
    const sidecar = rec.build({ goalResult: { modelCalls: 0 } }); // ledger BELOW observed billed calls
    rec.close();
    expect(sidecar.auxiliary.other).toEqual({ unavailable: true, reason: expect.stringContaining('disagree') });
  });
});

describe('sidecar redaction (no credential-shaped values land in the file)', () => {
  it('credential-shaped strings in event payloads are redacted on write', () => {
    const events = new EventBus();
    const rec = new UsageSidecarRecorder(WORKSPACE(), 'run-redact', { model: 'fake-model', provider: 'openai' }).attach(events);
    // A hostile environment: a tool whose NAME carries a key (data-driven
    // fields must not leak secrets into the sidecar).
    events.emit({ type: 'tool:called', agentId: 'main-1', tool: 'sk-ant-AaaaBbbbCcccDdddEeee1234', args: {} });
    events.emit({ type: 'tool:called', agentId: 'main-1', tool: 'curl', args: { url: 'https://x', headers: 'Bearer eyJhbcd.eyJxyz.eyJ1234567890' } });
    events.emit({ type: 'usage:updated', agentId: 'main-1', inputTokens: 10, outputTokens: 5, cacheTokens: 0, cacheMeasured: true, totalTokens: 15, costUsd: 0, model: 'fake-model' });
    const path = rec.finish({});
    expect(path).toBeTruthy();
    const raw = readFileSync(path!, 'utf8');
    expect(raw).not.toContain('sk-ant-AaaaBbbbCcccDdddEeee1234');
    expect(raw).toContain('[secret-redacted]');
    expect(raw).not.toContain('eyJhbcd');
    // And the read-back view is the redacted one.
    const read = readUsageSidecar(WORKSPACE(), 'run-redact')!;
    expect(JSON.stringify(read)).not.toContain('sk-ant-');
    rec.close();
  });
});

describe('spawn-path coverage: the one-shot runtime seam writes a sidecar for a real run', () => {
  let fake: FakeOpenAI;
  let repo: string;
  beforeEach(() => {
    process.env.MOCHI_CONFIG_PATH = resolve(dir, 'no-user-config.json');
  });
  afterEach(async () => { await fake?.close(); });

  it('Runtime.runPromptDetailed (the `mochi -p` path) leaves a complete usage sidecar', async () => {
    fake = await startFakeOpenAI([
      { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }], finishReason: 'tool_calls', promptTokens: 100, completionTokens: 10, costUsd: 0.01 },
      { content: 'The file says alpha.', finishReason: 'stop', promptTokens: 150, completionTokens: 20, costUsd: 0.02 },
    ]);
    repo = mkdtempSync(resolve(tmpdir(), 'mochi-sidecar-repo-'));
    execSync('git init -q && git config user.email d@d && git config user.name d && git commit -q --allow-empty -m init', { cwd: repo });
    writeFileSync(resolve(repo, 'a.txt'), 'alpha\n');
    const rt = new Runtime({
      cwd: repo,
      config: {
        model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' },
        safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000 },
        permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
        telemetry: false, projectDir: '.mochi', configDir: tmpdir(), quiet: true,
      } as unknown as MochiConfig,
    });
    const result = await rt.runPromptDetailed('read a.txt and tell me what it says');
    try {
      expect(result.success).toBe(true);
      // The sidecar exists alongside the run's trace and is complete.
      const ws = resolve(repo, '.mochi');
      const sidecar = newestUsageSidecar(ws);
      expect(sidecar, 'usage sidecar written for the spawn').not.toBeNull();
      expect(sidecar!.kind).toBe('mochi-usage-sidecar');
      expect(typeof sidecar!.model).toBe('string');
      expect(sidecar!.provider).toBe('openai');
      expect(typeof sidecar!.startedAt).toBe('string');
      expect(typeof sidecar!.endedAt).toBe('string');
      expect(sidecar!.exitReason).toBe('completed');
      expect(sidecar!.success).toBe(true);
      expect(sidecarTotalTokens(sidecar!)).toBeGreaterThan(0);
      expect(measuredNumber(sidecar!.usage.inputTokens)).toBeGreaterThan(0);
      expect(measuredNumber(sidecar!.usage.outputTokens)).toBeGreaterThan(0);
      expect(measuredNumber(sidecar!.usage.apiCalls)).toBeGreaterThanOrEqual(2);
      expect(sidecarCostUsd(sidecar!)).not.toBeNull();
      // Per-field shape: every required usage field present.
      for (const k of ['apiCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'totalTokens', 'costUsd']) {
        expect(sidecar!.usage).toHaveProperty(k);
      }
      // Subagent-free run: an explicit zero-subagents fact, not unavailable.
      expect(sidecar!.auxiliary.subagents).toMatchObject({ count: 0 });
      const tools = sidecar!.auxiliary.tools;
      expect(tools).not.toHaveProperty('unavailable');
      expect((tools as { calls: number }).calls).toBeGreaterThanOrEqual(1);
    } finally {
      try { rt.close(); } catch { /* best-effort */ }
      rmSync(repo, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('existing behavior unchanged when no sidecar is consumed', () => {
  it('scanRunTraces answers exactly as before on a workdir without sidecars', () => {
    const workdir = resolve(dir, 'task');
    mkdirSync(join(workdir, '.mochi', 'traces'), { recursive: true });
    const t = Date.now();
    const line = JSON.stringify({ t, kind: 'usage:updated', agentId: 'a1', inputTokens: 700, outputTokens: 300, cacheTokens: 0, totalTokens: 1000, costUsd: 0.01, model: 'fake-model' });
    writeFileSync(join(workdir, '.mochi', 'traces', 'g1.jsonl'), line + '\n');
    const scan = scanRunTraces(workdir);
    expect(scan.tokens).toBe(1000);
    expect(scan.costUsd).toBeCloseTo(0.01, 10);
    expect(scan.turns).toBe(1);
    expect(scan.traceIds).toEqual(['g1']);
    // No sidecar was written → the sidecar reader finds nothing and the
    // trace scan stands (newestUsageSidecar ⇒ null is the runner's fallback).
    expect(newestUsageSidecar(join(workdir, '.mochi'))).toBeNull();
  });

  it('a sidecar-writable workspace does not change the trace file or run result', () => {
    // Round-trip write does not touch traces: write a sidecar, assert the
    // trace scan of a sibling workdir is byte-identical before/after.
    const workdir = resolve(dir, 'task2');
    mkdirSync(join(workdir, '.mochi', 'traces'), { recursive: true });
    const line = JSON.stringify({ t: Date.now(), kind: 'usage:updated', agentId: 'a1', inputTokens: 10, outputTokens: 5, cacheTokens: 0, totalTokens: 15, costUsd: 0, model: 'fake-model' });
    writeFileSync(join(workdir, '.mochi', 'traces', 'g1.jsonl'), line + '\n');
    const before = readFileSync(join(workdir, '.mochi', 'traces', 'g1.jsonl'), 'utf8');
    writeUsageSidecar(join(workdir, '.mochi'), 'g1', {
      kind: 'mochi-usage-sidecar', version: 1, runId: 'g1', model: 'fake-model', provider: 'openai',
      startedAt: '2026-10-28T00:00:00.000Z', endedAt: '2026-10-28T00:00:01.000Z', durationMs: 1000,
      exitReason: 'completed', success: true,
      usage: { apiCalls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, totalTokens: 15, costUsd: { reported: 0, estimated: 0, source: 'none', complete: true } },
      auxiliary: { subagents: { count: 0, apiCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUsd: 0, children: [] }, tools: { calls: 0, byTool: {} }, other: { apiCalls: 0, note: 'n' } },
      totalIncludingAuxiliary: { apiCalls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, totalTokens: 15, costUsd: { reported: 0, estimated: 0, source: 'none', complete: true } },
      notes: [],
    });
    expect(readFileSync(join(workdir, '.mochi', 'traces', 'g1.jsonl'), 'utf8')).toBe(before);
    const scan = scanRunTraces(workdir);
    expect(scan.tokens).toBe(15);
  });

  it('the spawned mochi process itself is node dist/cli.js -p (gate subprocess runner unchanged)', () => {
    // Spawn-path coverage: assert the runner's shape from the source of truth
    // — dist CLI one-shot flag — without running a full spawn here.
    const src = readFileSync(resolve(__dirname, '../evals/regression-gate.ts'), 'utf8');
    expect(src).toContain("'-p', '--yolo'");
    expect(src).toContain('newestUsageSidecar');
    expect(src).toContain("usageSource: sidecar ? 'sidecar' : 'traces'");
  });
});
