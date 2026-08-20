
// Warm-start on resume: prior failed autopsy attempts for the SAME task must
// be surfaced to the model as a "do not repeat" context message.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { appendAttempt, loadOrCreateAutopsy } from '../autopsy.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: {
      mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10,
      maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

describe('warm start on resume', () => {
  it('injects prior failed attempts so the model avoids dead ends', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-warm-'));
    const task = createTask('Fix flaky test', 'make the test pass');
    // Simulate a previous failed session on this exact task.
    let autopsy = loadOrCreateAutopsy(resolve(dir, '.mochi'), task.id, 'prev-agent', task.title);
    autopsy = appendAttempt(resolve(dir, '.mochi'), autopsy, {
      attempt: 1,
      hypothesisId: 'h1',
      hypothesisText: 'increase the timeout',
      confidenceBefore: 0.6,
      action: 'probed: grep timeout',
      evidence: 'timeout was not the issue',
      outcome: 'still_failing',
      confidenceAfter: 0.2,
      statusAfter: 'refuted',
      atMs: Date.now(),
    });

    const fake = await startFakeOpenAI([
      { content: 'Understood, trying a different approach.', finishReason: 'stop', completionTokens: 12 },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('fix the flaky test');

    const agent = new Agent({
      id: 'warm-agent', role: 'coder', config, workspace,
      events: new EventBus(), cwd: dir, context,
    });
    await agent.run(task);

    // The transcript must contain the prior-attempt warning (what the model
    // sees in its next packet; buildPacket includes recent messages).
    const messages = (context as unknown as { messages: unknown[] }).messages;
    const flat = JSON.stringify(messages);
    expect(flat).toContain('PRIOR SESSION CONTEXT');
    expect(flat).toContain('increase the timeout');
    expect(flat).toContain('Do NOT repeat');
    await fake.close();
  }, 30_000);
});
