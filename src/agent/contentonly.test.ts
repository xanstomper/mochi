
// Content-only tasks: repo-wide suites are vetoed in the tool layer; direct
// checks still run. Companion to the prompt-side "verify proportionate" rule.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import { classifyContentOnly } from '../one-shot.js';
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

describe('classifyContentOnly', () => {
  it('classifies doc/config/data tasks as content-only', () => {
    expect(classifyContentOnly({ title: 'Create note.txt', description: 'write OK into note.txt', acceptanceCriteria: [], verificationCommand: undefined })).toBe(true);
    expect(classifyContentOnly({ title: 'Update README.md', description: 'document the flag', acceptanceCriteria: [], verificationCommand: undefined })).toBe(true);
    expect(classifyContentOnly({ title: 'Add config.yaml entry', description: 'set retries to 3', acceptanceCriteria: [], verificationCommand: undefined })).toBe(true);
  });
  it('does not classify behavior tasks as content-only', () => {
    expect(classifyContentOnly({ title: 'Implement rate limiter', description: 'add function', acceptanceCriteria: [], verificationCommand: undefined })).toBe(false);
    expect(classifyContentOnly({ title: 'Fix the bug in parse', description: 'fix parsing', acceptanceCriteria: [], verificationCommand: undefined })).toBe(false);
    expect(classifyContentOnly({ title: 'Write note', description: 'write', acceptanceCriteria: [], verificationCommand: 'npm test' })).toBe(false);
    // A direct content check IS proportionate verification for content tasks.
    expect(classifyContentOnly({ title: 'Create note.txt', description: 'content OK', acceptanceCriteria: [], verificationCommand: "grep -qx 'OK' note.txt" })).toBe(true);
  });
});

describe('content-only shell veto (integration)', () => {
  it('vetoes npm test for a content-only task but allows direct checks', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-contentonly-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'exit 0' } }));
    execSync('git init -q && git config user.email d@d && git config user.name d', { cwd: dir });

    const fake = await startFakeOpenAI([
      {
        content: 'Writing.',
        toolCalls: [
          { id: '1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: resolve(dir, 'note.txt'), content: 'OK' }) } },
        ],
        finishReason: 'tool_calls',
      },
      {
        content: 'Verifying with the suite.',
        toolCalls: [
          { id: '2', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'npm test' }) } },
        ],
        finishReason: 'tool_calls',
      },
      {
        content: 'Direct check then.',
        toolCalls: [
          { id: '3', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'test -f note.txt && cat note.txt' }) } },
        ],
        finishReason: 'tool_calls',
      },
      { content: 'Done.', finishReason: 'stop', completionTokens: 6 },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('write note');
    const task = createTask('Create note.txt', 'Create note.txt containing exactly OK', { acceptanceCriteria: [] });

    const agent = new Agent({ id: 'co-agent', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
    const result = await agent.run(task);

    expect(readFileSync(resolve(dir, 'note.txt'), 'utf8')).toBe('OK');
    expect(result.success).toBe(true);
    const flat = JSON.stringify((context as unknown as { messages: unknown[] }).messages);
    expect(flat).toContain('Vetoed: this is a content-only task');
    await fake.close();
  }, 60_000);
});
