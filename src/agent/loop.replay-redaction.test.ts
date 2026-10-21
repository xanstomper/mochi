// Regression (review P2 on fix/replay-output-redaction): the execution-registry
// replay branch used to inject cached.output into the model context WITHOUT
// the output-policy gate (scrubAnsiFragments(maybeRedact(...)) +
// applyToolOutputPolicy). A speculatively-executed read whose raw output
// contains a secret would reach the model context unredacted on replay. The
// replay branch now applies the identical chain as the normal completion path
// (loop.ts ~4595). This test pre-seeds the registry with a secret-bearing
// RAW result (as the speculative path stores it) and drives a real Agent run
// through the replay branch with a fake model.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI, type FakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

let fake: FakeOpenAI;
let dir: string;
let config: MochiConfig;

// Fake secret, assembled so secret-scanners don't flag the fixture itself.
const RAW_SECRET = 'sk-' + 'aaaabbbbcccc' + 'dddd1234';

beforeAll(async () => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-replay-redact-'));
  config = {
    model: { provider: 'openai', baseUrl: 'http://unused', model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 5, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
    telemetry: false, projectDir: '.mochi', configDir: resolve(dir, '.config/mochi'), quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
});

afterAll(async () => {
  await fake?.close();
  rmSync(dir, { recursive: true, force: true });
});

function readCall(id: string, path: string) {
  return { id, type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ path }) } };
}

describe('replay path redaction (execution-registry explicit replay)', () => {
  it('a replayed read with a secret-bearing cached output reaches context REDACTED', async () => {
    fake = await startFakeOpenAI([
      { content: 'Reading.', toolCalls: [readCall('read1', 'does-not-matter.txt')], finishReason: 'tool_calls' },
      { content: 'Done.', finishReason: 'stop' },
    ]);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    const events = new EventBus();
    const seen: unknown[] = [];
    events.onAll((e) => { seen.push(e); });
    const agent = new Agent({ id: 'replay-redact-agent', role: 'coder', config: { ...config, model: { ...config.model, baseUrl: fake.url } }, workspace, events, cwd: dir, context });

    // Pre-seed the registry exactly the way the speculative exec path stores
    // results: register (creates the active record) then markCompleted with
    // the RAW (unprocessed) output. The real path later presents the same
    // executionId ('read1') and hits the explicit-replay branch.
    const seeded = (agent as unknown as { executionRegistry: { register(r: { toolName: string; args: Record<string, unknown>; executionId?: string }): { executionId: string }; markCompleted(id: string, result: unknown): void } }).executionRegistry;
    seeded.register({ toolName: 'read', args: { path: 'does-not-matter.txt' }, executionId: 'read1' });
    seeded.markCompleted('read1', { output: `file content with api_key=${RAW_SECRET} inside` });

    const task = createTask('replay redact', 'Read a file.');
    await agent.run(task);

    // The tool message fed to the model must carry the REDACTED output — the
    // raw secret must never reach context via the replay branch.
    const toolMsg = context.getMessages().find((m) => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === 'read1') as { content?: string } | undefined;
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toContain('[secret-redacted]');
    expect(toolMsg?.content).not.toContain(RAW_SECRET);

    // The tool:completed event emitted from the replay branch is redacted too.
    const completed = seen.find((e) => (e as { type?: string }).type === 'tool:completed' && (e as { result?: { toolCallId?: string } }).result?.toolCallId === 'read1') as { result?: { output?: string } } | undefined;
    expect(completed).toBeDefined();
    expect(completed?.result?.output).toContain('[secret-redacted]');
    expect(completed?.result?.output).not.toContain(RAW_SECRET);
  });
});
