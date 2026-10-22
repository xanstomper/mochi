import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { ChildRunStore } from '../teams/subagent-runtime.js';
import { executeTool, buildTools } from '../tools/index.js';
import type { ToolContext } from '../tools/types.js';
import { SPAWN_PRESETS } from '../teams/presets.js';
import { startFakeOpenAI, type FakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

// Multi-agent fanout integration tests. All model behavior is scripted via
// the fake OpenAI server with a sticky respondFn router (routes by request
// content, so concurrent parent/child traffic stays deterministic).

function makeConfig(dir: string, url: string, safetyExtra: Record<string, unknown> = {}): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 10,
      maxIterations: 20,
      maxRuntimeMinutes: 5,
      maxConcurrentAgents: 4,
      maxConcurrentSubagents: 4,
      maxSubagentDepth: 2,
      contextBudgetTokens: 400_000,
      ...safetyExtra,
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

function makeParent(dir: string, url: string, safetyExtra: Record<string, unknown> = {}) {
  const config = makeConfig(dir, url, safetyExtra);
  const workspace = new Workspace(dir, '.mochi');
  workspace.ensure();
  const agent = new Agent({
    role: 'coder',
    config,
    workspace,
    events: new EventBus(),
    cwd: dir,
    context: new ContextEngine(config, dir),
  });
  return { agent, workspace, config };
}

function routerFake(handler: (body: any) => FakeScriptResponse): Promise<FakeOpenAI> {
  return startFakeOpenAI([{ sticky: true, respondFn: handler }]);
}

const jsonBlock = (obj: unknown): string =>
  `All done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

const hasToolResult = (body: any): boolean =>
  Array.isArray(body?.messages) && body.messages.some((m: any) => m?.role === 'tool');

function gitRepo(): { dir: string; git: (args: string[]) => string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-ma-git-'));
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  return { dir, git };
}

describe('multi-agent fanout', () => {
  it('(a) background research child: spawn returns immediately, parent keeps working, collect folds back the structured result', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-ma-a-'));
    const fake = await routerFake((body) => {
      const text = JSON.stringify(body);
      if (text.includes('Spawn preset: researcher')) {
        return {
          content: jsonBlock({
            status: 'done',
            summary: 'The widget is implemented in src/widget.ts and rendered by WidgetView.',
            findings: [{ severity: 'info', file: 'src/widget.ts', message: 'Entry point located' }],
            artifacts: [],
          }),
          finishReason: 'stop',
          delayMs: 800,
        };
      }
      return { content: 'ok', finishReason: 'stop' };
    });
    try {
      const { agent: parent, workspace } = makeParent(dir, fake.url);
      const t0 = Date.now();
      const handle = await parent.spawnAgentAsync({
        prompt: 'Where is the widget implemented?',
        preset: 'researcher',
      });
      const spawnMs = Date.now() - t0;
      expect(handle.id).toMatch(/^sub-/);
      expect(handle.status).toBe('running');
      // The child takes ~800ms per model call; spawn must NOT have waited.
      expect(spawnMs).toBeLessThan(600);

      // The parent keeps working while the child runs.
      writeFileSync(resolve(dir, 'parent-work.txt'), 'parent kept coding');
      const early = await parent.collectChildResult(handle.id);
      expect(early).toContain('RUNNING');

      const digest = await parent.collectChildResult(handle.id, { waitMs: 60_000 });
      expect(digest).toContain('DONE');
      expect(digest).toContain('src/widget.ts');
      expect(digest).toContain('tokens');
      expect(digest).toContain('tool calls');

      const rec = new ChildRunStore(workspace).load(handle.id);
      expect(rec?.status).toBe('done');
      expect(rec?.result?.summary).toContain('WidgetView');
      expect(rec?.preset).toBe('researcher');
      expect(existsSync(resolve(dir, 'parent-work.txt'))).toBe(true);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(f) a fresh parent instance collects a finished child result from the persisted record', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-ma-f-'));
    const fake = await routerFake((body) => {
      const text = JSON.stringify(body);
      if (text.includes('Spawn preset: researcher')) {
        return {
          content: jsonBlock({
            status: 'done',
            summary: 'Persisted answer: see src/widget.ts.',
            findings: [],
            artifacts: [],
          }),
          finishReason: 'stop',
        };
      }
      return { content: 'ok', finishReason: 'stop' };
    });
    try {
      const first = makeParent(dir, fake.url);
      const handle = await first.agent.spawnAgentAsync({ prompt: 'Find the widget', preset: 'researcher' });
      const done = await first.agent.collectChildResult(handle.id, { waitMs: 60_000 });
      expect(done).toContain('DONE');

      // Simulate a parent-process restart: brand-new Agent, same workspace.
      const second = makeParent(dir, fake.url);
      const digest = await second.agent.collectChildResult(handle.id);
      expect(digest).toContain('DONE');
      expect(digest).toContain('src/widget.ts');
      const missing = await second.agent.collectChildResult('sub-doesnotexist');
      expect(missing).toContain('No subagent run with id');
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(b) two mutating children edit the same file in separate worktrees; parent applies one explicitly', async () => {
    const { dir, git } = gitRepo();
    writeFileSync(resolve(dir, 'shared.txt'), 'BASE');
    git(['add', '-A']);
    git(['commit', '-qm', 'base']);
    const fake = await routerFake((body) => {
      const text = JSON.stringify(body);
      const which = text.includes('containing the text ALPHA')
        ? 'ALPHA'
        : text.includes('containing the text BETA')
          ? 'BETA'
          : null;
      if (!which) return { content: 'ok', finishReason: 'stop' };
      // Behave like a real coder: write, then VERIFY with a shell check,
      // then report. (Answering the same done-text repeatedly instead of
      // verifying trips the harness's anti-loop guard — by design.)
      const toolResults = (body.messages ?? []).filter((m: any) => m?.role === 'tool').length;
      if (toolResults === 0) {
        return {
          content: '',
          toolCalls: [{
            id: `w-${which}`,
            type: 'function',
            function: { name: 'write', arguments: JSON.stringify({ path: 'shared.txt', content: which }) },
          }],
          finishReason: 'tool_calls',
        };
      }
      if (toolResults === 1) {
        return {
          content: '',
          toolCalls: [{
            id: `v-${which}`,
            type: 'function',
            function: { name: 'shell', arguments: JSON.stringify({ command: 'cat shared.txt' }) },
          }],
          finishReason: 'tool_calls',
        };
      }
      return {
        content: jsonBlock({ status: 'done', summary: `Wrote ${which} into shared.txt and verified it with cat (check #${toolResults}).`, findings: [], artifacts: ['shared.txt'] }),
        finishReason: 'stop',
      };
    });
    try {
      const { agent: parent, workspace } = makeParent(dir, fake.url);
      const hA = await parent.spawnAgentAsync({ prompt: 'Create shared.txt containing the text ALPHA', preset: 'coder' });
      const hB = await parent.spawnAgentAsync({ prompt: 'Create shared.txt containing the text BETA', preset: 'coder' });
      const dA = await parent.collectChildResult(hA.id, { waitMs: 90_000 });
      const dB = await parent.collectChildResult(hB.id, { waitMs: 90_000 });
      // The worktree mechanics are the spec here; the exact DONE/PARTIAL
      // label is the harness completion gate's call on a scripted run.
      expect(dA).toMatch(/DONE|PARTIAL/);
      expect(dB).toMatch(/DONE|PARTIAL/);

      const store = new ChildRunStore(workspace);
      const recA = store.load(hA.id)!;
      const recB = store.load(hB.id)!;
      expect(recA.worktree?.path).toBeTruthy();
      expect(recB.worktree?.path).toBeTruthy();
      expect(recA.worktree!.path).not.toBe(recB.worktree!.path);
      // No collision: each worktree holds its own version…
      expect(readFileSync(resolve(recA.worktree!.path, 'shared.txt'), 'utf8')).toBe('ALPHA');
      expect(readFileSync(resolve(recB.worktree!.path, 'shared.txt'), 'utf8')).toBe('BETA');
      // …and the parent's tree is untouched until it explicitly applies.
      expect(readFileSync(resolve(dir, 'shared.txt'), 'utf8')).toBe('BASE');
      expect(dA).toContain('NOT applied');
      expect(dA).toContain('shared.txt');

      const applied = await parent.collectChildResult(hA.id, { apply: true });
      expect(applied).toContain('Applied subagent');
      expect(readFileSync(resolve(dir, 'shared.txt'), 'utf8')).toBe('ALPHA');
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(c) pr-reviewer scope is enforced at the tool layer — a hallucinated write never lands', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-ma-c-'));
    const fake = await routerFake((body) => {
      const text = JSON.stringify(body);
      if (!text.includes('Spawn preset: pr-reviewer')) return { content: 'ok', finishReason: 'stop' };
      if (!hasToolResult(body)) {
        // The reviewer model tries to write — its preset must make that
        // impossible even though the tool exists in the global registry.
        return {
          content: '',
          toolCalls: [{
            id: 'w-evil',
            type: 'function',
            function: { name: 'write', arguments: JSON.stringify({ path: 'pwned.txt', content: 'x' }) },
          }],
          finishReason: 'tool_calls',
        };
      }
      return {
        content: jsonBlock({
          status: 'done',
          summary: 'One high-severity issue in the change.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 7, message: 'Null deref on widget' }],
          verdict: 'request-changes',
          artifacts: [],
        }),
        finishReason: 'stop',
      };
    });
    try {
      const { agent: parent, workspace, config } = makeParent(dir, fake.url);

      // Tool-layer unit check: even with an EMPTY agent tool map (so
      // executeTool falls back to the global registry), the allowlist in
      // the context rejects out-of-scope calls.
      const scopedCtx: ToolContext = {
        cwd: dir,
        workspace,
        config,
        events: new EventBus(),
        agentId: 'scope-test',
        toolAllowlist: new Set(SPAWN_PRESETS['pr-reviewer'].tools),
      };
      const blocked = await executeTool('write', { path: 'pwned.txt', content: 'x' }, scopedCtx, new Map());
      expect(blocked.error).toContain('not available to this agent');
      const blockedShell = await executeTool('shell', { command: 'echo hi' }, scopedCtx, new Map());
      expect(blockedShell.error).toContain('not available to this agent');

      // And the child's advertised map is pruned too.
      const childTools = buildTools(config, SPAWN_PRESETS['pr-reviewer'].tools);
      expect(childTools.has('write')).toBe(false);
      expect(childTools.has('read')).toBe(true);

      const handle = await parent.spawnAgentAsync({
        prompt: 'Review the change to src/a.ts for correctness issues.',
        preset: 'pr-reviewer',
      });
      const digest = await parent.collectChildResult(handle.id, { waitMs: 90_000 });
      expect(existsSync(resolve(dir, 'pwned.txt'))).toBe(false);
      expect(digest).toContain('request-changes');
      expect(digest).toContain('Null deref on widget');
      expect(digest).toContain('[high] src/a.ts:7');
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(d) review fleet fans out lens reviewers over one diff and aggregates (dedupe + request-changes wins)', async () => {
    const { dir, git } = gitRepo();
    mkdirSync(resolve(dir, 'src'));
    writeFileSync(resolve(dir, 'src/a.ts'), 'export const parse = (): string | null => null;\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'base']);
    writeFileSync(
      resolve(dir, 'src/a.ts'),
      'export const parse = (): string | null => null;\nexport const use = (): number => parse()!.length;\n',
    );
    const fake = await routerFake((body) => {
      const text = JSON.stringify(body);
      if (!text.includes('Spawn preset: pr-reviewer')) return { content: 'ok', finishReason: 'stop' };
      const security = text.includes('[Review lens: security]');
      return {
        content: jsonBlock({
          status: 'done',
          summary: security ? 'Unsafe deref of a nullable result.' : 'parse() can return null and use() derefs it.',
          findings: [{ severity: 'high', file: 'src/a.ts', line: 2, message: 'Unchecked null return from parse()' }],
          verdict: security ? 'request-changes' : 'comment',
          artifacts: [],
        }),
        finishReason: 'stop',
      };
    });
    try {
      const { agent: parent } = makeParent(dir, fake.url);
      const report = await parent.runReviewFleet({ lenses: ['correctness', 'security'] });
      expect(report).toContain('REQUEST-CHANGES');
      expect(report).toContain('1 unique finding');
      expect(report).toContain('duplicate');
      // The shared finding survived exactly once in the merged report.
      expect(report.match(/Unchecked null return from parse\(\)/g)).toHaveLength(1);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(e) concurrency cap queues excess children; depth cap refuses deep spawns and strips child spawners', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-ma-e-'));
    const fake = await routerFake((body) => {
      const text = JSON.stringify(body);
      // Depth test child (spawned by bare role, no preset): first tries to
      // delegate further, then reports. Checked FIRST — its requests carry
      // no preset marker, so the researcher guard below would swallow them.
      if (text.includes('delegate further if you can') && !hasToolResult(body)) {
        return {
          content: '',
          toolCalls: [{
            id: 'nested-1',
            type: 'function',
            function: { name: 'subagent', arguments: JSON.stringify({ prompt: 'nested task' }) },
          }],
          finishReason: 'tool_calls',
        };
      }
      if (!text.includes('Spawn preset: researcher')) return { content: 'ok', finishReason: 'stop' };
      return {
        content: jsonBlock({ status: 'done', summary: 'Researched.', findings: [], artifacts: [] }),
        finishReason: 'stop',
        delayMs: 900,
      };
    });
    try {
      // Concurrency cap = 2: the third spawn queues instead of running.
      const capped = makeParent(dir, fake.url, { maxConcurrentSubagents: 2 });
      const h1 = await capped.agent.spawnAgentAsync({ prompt: 'Research topic one', preset: 'researcher' });
      const h2 = await capped.agent.spawnAgentAsync({ prompt: 'Research topic two', preset: 'researcher' });
      const h3 = await capped.agent.spawnAgentAsync({ prompt: 'Research topic three', preset: 'researcher' });
      expect(h1.status).toBe('running');
      expect(h2.status).toBe('running');
      expect(h3.status).toBe('queued');
      const d3 = await capped.agent.collectChildResult(h3.id, { waitMs: 90_000 });
      expect(d3).toContain('DONE');

      // Depth cap: an agent AT the cap cannot spawn at all…
      const deep = new Agent({
        role: 'coder',
        config: capped.config,
        workspace: capped.workspace,
        events: new EventBus(),
        cwd: dir,
        context: new ContextEngine(capped.config, dir),
        subagentDepth: 2,
      });
      const refused = await deep.spawnAgentAsync({ prompt: 'anything', preset: 'researcher' });
      expect(refused.status).toBe('refused');

      // …and with maxSubagentDepth=1 a first-level child gets NO spawner:
      // its own subagent call degrades to the not-available message. (Bare
      // role spawn, no preset, and unattendedAllow opted in so the approval
      // gate steps aside — the DEPTH rule is provably the blocker.)
      const shallowConfig = makeConfig(dir, fake.url, { maxSubagentDepth: 1 });
      const shallowWorkspace = new Workspace(dir, '.mochi');
      shallowWorkspace.ensure();
      const shallowParent = new Agent({
        role: 'coder',
        config: shallowConfig,
        workspace: shallowWorkspace,
        events: new EventBus(),
        cwd: dir,
        context: new ContextEngine(shallowConfig, dir),
        unattendedAllow: true,
      });
      const kid = await shallowParent.spawnAgentAsync({
        prompt: 'Investigate the repo layout and delegate further if you can',
        role: 'coder',
      });
      const kidDigest = await shallowParent.collectChildResult(kid.id, { waitMs: 90_000 });
      expect(kidDigest).toMatch(/DONE|PARTIAL/);
      const allBodies = fake.requests.map((r) => JSON.stringify(r.body)).join('\n');
      expect(allBodies).toContain('not available in this context');
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancelling a running child aborts it and marks the record cancelled', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-ma-cancel-'));
    const fake = await routerFake((body) => {
      const text = JSON.stringify(body);
      if (text.includes('Spawn preset: researcher')) {
        return {
          content: jsonBlock({ status: 'done', summary: 'Slow research.', findings: [], artifacts: [] }),
          finishReason: 'stop',
          delayMs: 5_000,
        };
      }
      return { content: 'ok', finishReason: 'stop' };
    });
    try {
      const { agent: parent, workspace } = makeParent(dir, fake.url);
      const handle = await parent.spawnAgentAsync({ prompt: 'Very slow research', preset: 'researcher' });
      expect(handle.status).toBe('running');
      const msg = await parent.cancelChildRun(handle.id);
      expect(msg).toContain('cancellation signalled');
      const digest = await parent.collectChildResult(handle.id, { waitMs: 30_000 });
      expect(digest).toContain('CANCELLED');
      expect(new ChildRunStore(workspace).load(handle.id)?.status).toBe('cancelled');
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
