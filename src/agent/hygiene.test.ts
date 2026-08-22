import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

// End-to-end proof of the diff-hygiene gate: a model writes code with debug
// debris, tries to finish, gets ONE bounded cleanup nudge, fixes it, and only
// then completes — leaving clean code on disk.

describe('agent diff-hygiene gate (integration)', () => {
  function makeConfig(dir: string, url: string): MochiConfig {
    return {
      model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
      safety: {
        mode: 'auto',
        commandTimeoutSeconds: 10,
        maxIterations: 10,
        maxRuntimeMinutes: 5,
        maxConcurrentAgents: 1,
        contextBudgetTokens: 4000,
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

  it('nudges once to clean debug debris, then completes with clean code', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-hygiene-'));
    // A real git repo so the diff scanner sees the change (fresh repo: no HEAD).
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
    const greetPath = resolve(dir, 'greet.ts');
    const writeArgs = (content: string) => JSON.stringify({ path: greetPath, content });

    const fake = await startFakeOpenAI([
      { // iteration 0: writes code with debris
        content: 'Writing the module.',
        toolCalls: [{ id: '1', type: 'function', function: { name: 'write', arguments: writeArgs('export function greet(n: string) {\n  console.log("greet called", n);\n  // TODO nicer greeting\n  return `hi ${n}`;\n}\n') } }],
        finishReason: 'tool_calls',
      },
      { content: 'Done.', finishReason: 'stop', completionTokens: 8 }, // tries to finish
      { // cleanup iteration: same behavior, no debris
        content: 'Cleaning up.',
        toolCalls: [{ id: '2', type: 'function', function: { name: 'write', arguments: writeArgs('export function greet(n: string) {\n  return `hi ${n}`;\n}\n') } }],
        finishReason: 'tool_calls',
      },
      { content: 'Done.', finishReason: 'stop', completionTokens: 8 },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('write a greeting module');
    const task = createTask('Write greeting', 'Create greet.ts exporting greet().');

    const bus = new EventBus();
    const logs: string[] = [];
    bus.on('agent:log', (e) => logs.push(e.message));

    const agent = new Agent({ id: 'hygiene-agent', role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const result = await agent.run(task);

    expect(result.success).toBe(true);
    expect(existsSync(greetPath)).toBe(true);
    const final = readFileSync(greetPath, 'utf8');
    expect(final).not.toContain('console.log');
    expect(final).not.toContain('TODO');
    expect(final).toContain('hi ${n}');
    // Exactly one bounded hygiene nudge was injected.
    const hygiene = logs.filter((m) => m.includes('[hygiene]'));
    expect(hygiene).toHaveLength(1);
    expect(hygiene[0]).toContain('2 finding(s)');
    await fake.close();
  }, 60_000);
});
