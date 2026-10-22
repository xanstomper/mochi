// Approval gate: policy tiers finally enforced on the execution path.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from '../agent/loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import { describeApproval, normalizePolicy } from './approval.js';
import type { MochiConfig } from '../types.js';

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function shellCall(id: string, command: string) {
  return { id, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command }) } };
}

function auditLines(dir: string): string[] {
  const f = resolve(dir, '.mochi', 'logs', 'audit.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean);
}

describe('describeApproval + normalizePolicy (pure)', () => {
  it('summarizes shell with risk, paths, and truncates', () => {
    expect(describeApproval('shell', { command: 'ls' }).risk).toBe('low');
    expect(describeApproval('shell', { command: 'rm -rf /' }).risk).not.toBe('low');
    expect(describeApproval('write', { path: 'a/b.ts' }).summary).toContain('a/b.ts');
    expect(describeApproval('write', { path: 'x'.repeat(200) }).summary.length).toBeLessThan(140);
    expect(normalizePolicy('yolo')).toBe('yolo');
    expect(normalizePolicy('nonsense')).toBe('strict');
    expect(normalizePolicy(undefined)).toBe('strict');
  });
});

describe('approval gate on the execution path', () => {
  it('deny vetoes the call, audits it, and the run still completes on prose', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-approve-deny-'));
    const fake = await startFakeOpenAI([
      { content: 'Checking status.', toolCalls: [shellCall('s1', 'git status --short')], finishReason: 'tool_calls' },
      { content: 'Status checked without shell.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('check git');
      const seen: Array<{ tool: string; summary: string }> = [];
      const agent = new Agent({
        role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context,
        permPolicy: 'strict',
        approvalHandler: async (req) => { seen.push({ tool: req.tool, summary: req.summary }); return 'deny'; },
      });
      const result = await agent.run(createTask('Check the git status and report', 'Run git status and report the result.'));
      expect(seen).toHaveLength(1);
      expect(seen[0].tool).toBe('shell');
      expect(seen[0].summary).toContain('git status');
      expect(result.success).toBe(true);
      expect(result.stopReason).toBe('completed');
      const lines = auditLines(dir);
      expect(lines.some((l) => l.includes('"tool":"shell"') && l.includes('"decision":"deny"'))).toBe(true);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('allow-always prompts once for repeated identical calls', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-approve-always-'));
    const fake = await startFakeOpenAI([
      { content: 'First.', toolCalls: [shellCall('s1', 'echo one')], finishReason: 'tool_calls' },
      { content: 'Second.', toolCalls: [shellCall('s2', 'echo one')], finishReason: 'tool_calls' },
      { content: 'Both ran.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('run echoes');
      let prompts = 0;
      const agent = new Agent({
        role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context,
        permPolicy: 'strict',
        approvalHandler: async () => { prompts++; return 'allow-always'; },
      });
      const result = await agent.run(createTask('Run the echo probe twice and report', 'Run echo one twice via shell and report.'));
      expect(result.success).toBe(true);
      expect(prompts).toBe(1);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('headless strict without a handler: floor-safe write proceeds, approval-requiring shell DENIED by default', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-approve-headless-'));
    const fake = await startFakeOpenAI([
      { content: 'Writing.', toolCalls: [{ id: 'w1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'note.txt', content: 'hi' }) } }], finishReason: 'tool_calls' },
      { content: 'Pushing.', toolCalls: [shellCall('s1', 'git push origin main')], finishReason: 'tool_calls' },
      { content: 'Push was not approved.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('write note');
      // No approvalHandler, strict tier. Deny-by-default (fail closed) for
      // approval-requiring calls: the destructive shell call is vetoed and
      // audited as a denial, and the veto must not hang the run. The
      // in-workspace write is inside the headless-safe floor (the
      // workspace-safe tier's auto-allow set) and still proceeds.
      const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context, permPolicy: 'strict' });
      const result = await agent.run(createTask('Create the note file', 'Write note.txt containing hi, then attempt a git push and report.'));
      expect(existsSync(resolve(dir, 'note.txt'))).toBe(true);
      expect(result.success).toBe(true);
      const lines = auditLines(dir);
      expect(lines.some((l) => l.includes('"tool":"write"') && l.includes('"decision":"allow"'))).toBe(true);
      expect(lines.some((l) => l.includes('"tool":"shell"') && l.includes('"decision":"deny"'))).toBe(true);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('headless workspace-safe without a handler: policy-safe calls proceed, approval-requiring shell is denied', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-approve-headless-ws-'));
    const fake = await startFakeOpenAI([
      { content: 'Writing.', toolCalls: [{ id: 'w1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'note.txt', content: 'hi' }) } }], finishReason: 'tool_calls' },
      { content: 'Checking.', toolCalls: [shellCall('s1', 'echo hello')], finishReason: 'tool_calls' },
      { content: 'Pushing.', toolCalls: [shellCall('s2', 'git push origin main')], finishReason: 'tool_calls' },
      { content: 'Done, push was not approved.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('write note and check git');
      const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context, permPolicy: 'workspace-safe' });
      const result = await agent.run(createTask('Create the note file and report git state', 'Write note.txt containing hi, run echo hello, then attempt a git push and report.'));
      expect(result.success).toBe(true);
      // "Safe without a handler" = PermissionManager.autoAllow: in-workspace
      // write and low-risk shell proceeded with nobody to ask…
      expect(existsSync(resolve(dir, 'note.txt'))).toBe(true);
      const lines = auditLines(dir);
      expect(lines.some((l) => l.includes('"tool":"write"') && l.includes('"decision":"allow"'))).toBe(true);
      // …while the destructive shell call (not auto-allowed) was denied.
      expect(lines.some((l) => l.includes('"tool":"shell"') && l.includes('"decision":"deny"'))).toBe(true);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('explicit unattendedAllow opt-in restores headless allow + audit beyond the floor', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-approve-unattended-'));
    const fake = await startFakeOpenAI([
      { content: 'Cleaning.', toolCalls: [shellCall('s1', 'rm -rf ./scratch-dir')], finishReason: 'tool_calls' },
      { content: 'Cleaned scratch-dir.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      mkdirSync(resolve(dir, 'scratch-dir'), { recursive: true });
      const context = new ContextEngine(config, dir);
      context.setGoal('clean scratch');
      // Destructive-class shell is beyond the headless-safe floor: it runs
      // ONLY because the host explicitly opted this unattended run in —
      // never by default (see the headless-strict test above).
      const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context, permPolicy: 'strict', unattendedAllow: true });
      const result = await agent.run(createTask('Clean the scratch dir', 'Remove ./scratch-dir with rm -rf via shell and report.'));
      expect(result.success).toBe(true);
      expect(existsSync(resolve(dir, 'scratch-dir'))).toBe(false);
      const lines = auditLines(dir);
      expect(lines.some((l) => l.includes('"tool":"shell"') && l.includes('"decision":"allow"'))).toBe(true);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('subagents never prompt and are denied approval-requiring calls (handler is not consulted)', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-approve-subagent-'));
    const fake = await startFakeOpenAI([
      { content: 'Pushing.', toolCalls: [shellCall('s1', 'git push origin main')], finishReason: 'tool_calls' },
      { content: 'Blocked as a subagent.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('push changes');
      let prompts = 0;
      const agent = new Agent({
        role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context,
        permPolicy: 'strict', subagentDepth: 1,
        approvalHandler: async () => { prompts++; return 'allow-once'; },
      });
      const result = await agent.run(createTask('Push the changes', 'Run git push origin main via shell and report.'));
      expect(result.success).toBe(true);
      expect(prompts).toBe(0);
      const lines = auditLines(dir);
      expect(lines.some((l) => l.includes('"tool":"shell"') && l.includes('"decision":"deny"'))).toBe(true);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('hardline shell command is denied at the gate even under yolo', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-approve-hardline-'));
    const fake = await startFakeOpenAI([
      { content: 'Formatting.', toolCalls: [shellCall('s1', 'mkfs.ext4 /dev/null')], finishReason: 'tool_calls' },
      { content: 'Refused, as it should be.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('format disk');
      // Yolo auto-allows everything at the policy layer — the hardline
      // floor sits below it and still denies (audited as a gate denial).
      const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context, permPolicy: 'yolo' });
      const result = await agent.run(createTask('Format the disk', 'Run mkfs.ext4 /dev/null via shell.'));
      expect(result.success).toBe(true);
      const lines = auditLines(dir);
      expect(lines.some((l) => l.includes('"tool":"shell"') && l.includes('"decision":"deny"'))).toBe(true);
      const toolMsgs = context.getMessages().filter((m) => m.role === 'tool').map((m) => String(m.content ?? ''));
      expect(toolMsgs.some((t) => t.includes('hardline'))).toBe(true);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('read-only tools never prompt even in strict', async () => {    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-approve-read-'));
    const fake = await startFakeOpenAI([
      { content: 'Reading.', toolCalls: [{ id: 'r1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'package.json' }) } }], finishReason: 'tool_calls' },
      { content: 'Read it.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('read pkg');
      let prompts = 0;
      const agent = new Agent({
        role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context,
        permPolicy: 'strict',
        approvalHandler: async () => { prompts++; return 'deny'; },
      });
      await agent.run(createTask('Inspect the package manifest and report', 'Read package.json and report its name.'));
      expect(prompts).toBe(0);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('allow-always memory survives across runs sharing one session set', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-approve-session-'));
    const fake = await startFakeOpenAI([
      { content: 'First.', toolCalls: [shellCall('s1', 'echo one')], finishReason: 'tool_calls' },
      { content: 'Done once.', finishReason: 'stop' },
      { content: 'Again.', toolCalls: [shellCall('s2', 'echo one')], finishReason: 'tool_calls' },
      { content: 'Done twice.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      let prompts = 0;
      const handler = async () => { prompts++; return 'allow-always' as const; };
      // One shared set = one tab session (GoalEngine hands the same set to
      // every agent it spawns); two separate runs must prompt only once.
      const shared = new Set<string>();
      for (const title of ['Run the echo probe and report', 'Run the echo probe again and report']) {
        const context = new ContextEngine(config, dir);
        context.setGoal('run echoes');
        const agent = new Agent({
          role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context,
          permPolicy: 'strict', approvalHandler: handler, approvedAlways: shared,
        });
        const result = await agent.run(createTask(title, 'Run echo one via shell and report.'));
        expect(result.success).toBe(true);
      }
      expect(prompts).toBe(1);
      expect(shared.size).toBe(1);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
