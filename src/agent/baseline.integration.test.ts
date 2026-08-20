
// Integration: an agent task in a repo with PRE-EXISTING check failures must
// still succeed when its own work is correct (baseline verification).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { captureBaseline } from '../verification.js';
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

describe('baseline verification (integration)', () => {
  it('a pre-existing failing repo check does not fail a correct task', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-baseline-'));
    // Repo with a test script that ALWAYS fails (pre-existing debt).
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({
      name: 'baseline-repo', version: '1.0.0',
      scripts: { test: 'node failing-test.js' },
    }));
    writeFileSync(resolve(dir, 'failing-test.js'), 'process.exit(1); // pre-existing failure\n');
    execSync('git init -q && git config user.email d@d && git config user.name d', { cwd: dir });

    // Baseline captures the failing signature.
    const baseline = await captureBaseline(dir, async (cmd) => {
      return new Promise<string>((res) => {
        const { execFile } = require('node:child_process') as typeof import('node:child_process');
        execFile('sh', ['-c', cmd], { cwd: dir }, (err, stdout, stderr) => {
          const code = err && 'code' in err ? Number((err as { code?: number }).code ?? 1) : err ? 1 : 0;
          res(`exit_code: ${code}\n${stdout ?? ''}\n${stderr ?? ''}`);
        });
      });
    });
    expect(baseline.signatures.get('npm test')).toBeTruthy();

    // Agent writes a correct file, then the loop's verify() runs repo checks.
    const fake = await startFakeOpenAI([
      {
        content: 'Writing the file.',
        toolCalls: [{
          id: '1', type: 'function',
          function: { name: 'write', arguments: JSON.stringify({ path: resolve(dir, 'note.txt'), content: 'all good' }) },
        }],
        finishReason: 'tool_calls',
      },
      { content: 'Done.', finishReason: 'stop', completionTokens: 8 },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('write a note');
    // Acceptance criteria force the verify() path (criteria present).
    const task = createTask('Write note', 'Create note.txt', { acceptanceCriteria: ['note.txt exists'] });

    const agent = new Agent({
      id: 'baseline-agent', role: 'coder', config, workspace,
      events: new EventBus(), cwd: dir, context,
      verifyBaseline: baseline,
    });
    const result = await agent.run(task);
    expect(readFileSync(resolve(dir, 'note.txt'), 'utf8')).toBe('all good');
    // THE regression: pre-existing npm-test failure must not fail this task.
    expect(result.success).toBe(true);
    await fake.close();
  }, 60_000);
});
