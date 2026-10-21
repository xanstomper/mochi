// B27 restructure: plan-mode network-read allowlist (safety.planModeNetworkReads).
//
// The fetch mutation gate made plan mode veto POST/PUT/PATCH/DELETE fetches —
// correct for the containment invariant, but it also blocked POST-based READ
// APIs (GraphQL query endpoints, search APIs that take POST bodies), which
// are legitimate plan-mode research. The operator now declares hosts whose
// mutating-method endpoints are known read-only; those fetches are exempt
// from the veto. Everything else stays vetoed.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Agent } from '../agent/loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

function makeConfig(dir: string, url: string, planReads: string[]): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 10,
      maxIterations: 10,
      maxRuntimeMinutes: 5,
      maxConcurrentAgents: 1,
      contextBudgetTokens: 4000,
      planModeNetworkReads: planReads,
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

async function runPlanScenario(planReads: string[], urlHost = 'localhost'): Promise<{ hits: number; toolResult: string }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: 'ok' }));
  });
  await new Promise<void>((r) => server.listen(0, 'localhost', r));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  let fake: Awaited<ReturnType<typeof startFakeOpenAI>> | undefined;
  const dir = mkdtempSync(join(tmpdir(), 'mochi-b27net-'));
  try {
    fake = await startFakeOpenAI([
      {
        content: 'Querying the review API.',
        toolCalls: [{
          id: 'f1',
          type: 'function',
          function: { name: 'fetch', arguments: JSON.stringify({ url: `http://${urlHost}:${port}/graphql`, method: 'POST', body: '{"query":"{ status }"}', allow_private: true }) },
        }],
        finishReason: 'tool_calls',
      },
      { content: 'PLAN:\n1. nothing destructive', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url, planReads);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('plan a change');
    const task = createTask('Plan only', 'Produce a plan. No changes.');
    const agent = new Agent({
      id: 'b27-plan-netread',
      role: 'coder',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
      planMode: true,
    });
    await agent.run(task);
    const toolMsg = context.getMessages().find((m) => m.role === 'tool' && (m as { name?: string }).name === 'fetch');
    return { hits: hits.length, toolResult: String(toolMsg?.content ?? '') };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    try { await fake?.close(); } catch { /* best-effort */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('plan-mode network-read allowlist (B27 restructure)', () => {
  it('runs a POST fetch to an allowlisted host in plan mode (research intent restored)', async () => {
    const { hits, toolResult } = await runPlanScenario(['localhost']);
    // The request actually fired against the declared read host.
    expect(hits).toBe(1);
    expect(toolResult).not.toContain('Blocked: plan mode');
  });

  it('still vetoes POST fetch without the allowlist (invariant held)', async () => {
    const { hits, toolResult } = await runPlanScenario([]);
    // RED on the pre-restructure code path — and the invariant this
    // restructure preserves: no request reaches the host.
    expect(hits).toBe(0);
    expect(toolResult).toContain('Blocked: plan mode');
  });

  it('host match is EXACT — declaring a superstring does not exempt the real host', async () => {
    // P2:8b1f861b: the exemption is includes(host) on the parsed hostname.
    // A declared entry that merely CONTAINS the real host ('localhost.evil.com'
    // vs real host 'localhost') must NOT match — only the exact hostname.
    const { hits, toolResult } = await runPlanScenario(['localhost.evil.com']);
    expect(hits).toBe(0);
    expect(toolResult).toContain('Blocked: plan mode');
  });

  it('host match is EXACT — declaring a proper SUFFIX of the host does not exempt it', async () => {
    // Pins against a suffix-matching regression (host.endsWith(entry)): the
    // entry 'ost' is a proper suffix of the bound host 'localhost' — under
    // exact matching it must veto; under endsWith semantics it would exempt.
    const { hits, toolResult } = await runPlanScenario(['ost']);
    expect(hits).toBe(0);
    expect(toolResult).toContain('Blocked: plan mode');
  });

  it('matching is case-insensitive: a mixed-case config entry matches the lowercase URL host', async () => {
    // loop.ts lowercases config entries; URL.hostname is lowercase per the
    // URL spec. Bind the server on 'localhost' and declare 'LOCALHOST' —
    // still an exact match after normalization, so the request fires.
    const { hits, toolResult } = await runPlanScenario(['LOCALHOST'], 'localhost');
    expect(hits).toBe(1);
    expect(toolResult).not.toContain('Blocked: plan mode');
  });
});
