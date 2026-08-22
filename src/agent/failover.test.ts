import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import type { MochiConfig } from '../types.js';

// Regression: when the model degenerates into repetition loops, the agent
// must FAIL OVER to an alternate model id on the same provider and complete
// the task, not die with "repeatedly restreamed the same block".
//
// Fake server: every request hits /chat/completions. The server replays a
// degenerate looping response while the requested model is the "bad" one,
// and a clean response once the agent switches to any other model id.

function startFake() {
  const seenModels: string[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data);
      const model = body.model as string;
      seenModels.push(model);
      const bad = model.includes('bad');
      const text = bad
        ? ('The model repeated itself. '.repeat(400)) // degenerate flood
        : 'All done. The answer is 42.';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      chunk({ id: 'x', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      chunk({ id: 'x', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      chunk({ id: 'x', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise<{ port: number; seenModels: () => string[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, () => resolve({
      port: (server.address() as any).port,
      seenModels: () => [...seenModels],
      close: () => new Promise<void>((r) => server.close(() => r())),
    }));
  });
}

describe('agent model failover on stream loop', () => {
  let fake: Awaited<ReturnType<typeof startFake>> | null = null;
  let dir: string | null = null;
  afterEach(async () => {
    if (fake) await fake.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    fake = null; dir = null;
  });

  it('switches to an alternate model and completes instead of dying', async () => {
    fake = await startFake();
    dir = mkdtempSync(resolve(tmpdir(), 'mochi-failover-'));
    const config = {
      model: { provider: 'freeinference', baseUrl: `http://localhost:${fake.port}`, model: 'bad-model', apiKey: 'k' },
      safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 12, maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 8000 },
      permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
      projectDir: dir,
    } as unknown as MochiConfig;
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('answer the question');
    const agent = new Agent({ id: 'failover-agent', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
    const result = await agent.run({ id: 't1', title: 'Answer', description: 'Give the result.', role: 'coder', status: 'pending', priority: 1, dependencies: [], acceptanceCriteria: [], attempts: [], createdAt: 0, updatedAt: 0 } as any);
    expect(result.success).toBe(true);
    expect(result.summary).toContain('42');
    // The agent must have tried the bad model first, then switched.
    const models = fake.seenModels();
    expect(models.some((m) => m.includes('bad'))).toBe(true);
    expect(models.some((m) => !m.includes('bad') && m !== models[0])).toBe(true);
  }, 60_000);
});
