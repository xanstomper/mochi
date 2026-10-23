// ACP protocol core: in-process unit tests (no spawn, no dist dependency).
import { describe, it, expect } from 'vitest';
import { handleRpc, parseClientCapabilities, elicitationPromptUser, type AcpSession, type AcpConnectionState } from './acp.js';

function freshSessions(): Map<string, AcpSession> {
  return new Map();
}

describe('ACP handleRpc', () => {
  it('initialize returns protocol metadata in spec shape', async () => {
    const r = await handleRpc({ id: 1, method: 'initialize', params: {} }, freshSessions(), process.cwd());
    expect(r.id).toBe(1);
    const res = r.result as any;
    expect(res.protocolVersion).toBe(1);
    // Verified ACP shape: agentCapabilities with nested sessionCapabilities.
    expect(res.agentCapabilities.sessionCapabilities.resume).toBeDefined();
    expect(res.agentCapabilities.sessionCapabilities.close).toBeDefined();
    expect(res.implementation.name).toBe('mochi');
  });

  it('session/new creates a session and session/close removes it', async () => {
    const sessions = freshSessions();
    const created = await handleRpc({ id: 2, method: 'session/new', params: { cwd: process.cwd() } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    expect(sid).toBeTruthy();
    expect(sessions.has(sid)).toBe(true);
    const closed = await handleRpc({ id: 3, method: 'session/close', params: { sessionId: sid } }, sessions, process.cwd());
    expect(closed.result).toEqual({}); // verified spec: empty result object
    expect(sessions.has(sid)).toBe(false);
  });

  it('session/prompt with an unknown session errors cleanly', async () => {
    const r = await handleRpc({ id: 4, method: 'session/prompt', params: { sessionId: 'nope', prompt: 'x' } }, freshSessions(), process.cwd());
    expect(r.error.code).toBe(-32602);
  });

  it('session/new returns sessionId only; session/resume reopens it', async () => {
    const sessions = freshSessions();
    const created = await handleRpc({ id: 2, method: 'session/new', params: { cwd: process.cwd() } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    // verified: result carries sessionId (no cwd field)
    expect((created.result as any).sessionId).toBeTruthy();
    await handleRpc({ id: 3, method: 'session/close', params: { sessionId: sid } }, sessions, process.cwd());
    const resumed = await handleRpc({ id: 4, method: 'session/resume', params: { sessionId: sid, cwd: process.cwd() } }, sessions, process.cwd());
    expect(resumed.error).toBeUndefined();
    expect(sessions.has(sid)).toBe(true);
  });

  it('session/prompt errors cleanly for an unknown session (fast path)', async () => {
    const r = await handleRpc({ id: 4, method: 'session/prompt', params: { sessionId: 'gone', prompt: [{ type: 'text', text: 'x' }] } }, freshSessions(), process.cwd());
    expect(r.error.code).toBe(-32602);
  });

  it('unknown method returns -32601', async () => {
    const r = await handleRpc({ id: 5, method: 'bogus/method', params: {} }, freshSessions(), process.cwd());
    expect(r.error.code).toBe(-32601);
  });
});

describe('ACP streaming', () => {
  it('session/prompt streams tool_call + message updates and returns stopReason', async () => {
    const { startFakeOpenAI } = await import('./testutil/fake-openai.js');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-acp-stream-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
    // First response: a tool call to read package.json, then final text
    const fake = await startFakeOpenAI([
      {
        toolCalls: [
          { id: 'call_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'package.json' }) } }
        ],
        finishReason: 'tool_calls',
        completionTokens: 10
      },
      { content: 'Done.', finishReason: 'stop', completionTokens: 4 }
    ]);
    const cfg = { model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' }, safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000 }, permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false }, telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false } as any;
    const sessions = new Map<string, AcpSession>();
    const created = await handleRpc({ id: 1, method: 'session/new', params: { cwd: dir } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    const updates: string[] = [];
    const { Runtime } = await import('./runtime.js');
    sessions.set(sid, { id: sid, cwd: dir, runtime: Runtime.create({ cwd: dir, config: cfg }) });

    const r = await handleRpc(
      { id: 2, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'go' }] } },
      sessions, process.cwd(),
      (_sid, update) => updates.push(JSON.stringify(update)),
    );
    expect(r.error).toBeUndefined();
    expect((r.result as any).stopReason).toBe('end_turn');
    expect(updates.length).toBeGreaterThan(0);
    // The fake returns a tool call, so we should see tool_call and tool_call_update
    expect(updates.some((u) => u.includes('tool_call'))).toBe(true);
    expect(updates.some((u) => u.includes('agent_message_chunk'))).toBe(true);
    await fake.close();
    for (const s of sessions.values()) { try { s.runtime.close(); } catch { /* best-effort */ } }
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

describe('ACP session/cancel', () => {
  it('aborts a session so session/prompt returns stopReason cancelled', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const { Runtime } = await import('./runtime.js');
    const { startFakeOpenAI } = await import('./testutil/fake-openai.js');
    const fake = await startFakeOpenAI([{ content: 'done', finishReason: 'stop', completionTokens: 4 }]);
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-acp-cancel-'));
    const cfg = { model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' }, safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 3, maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 4000 }, permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true }, telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false } as any;
    const sessions = new Map<string, AcpSession>();
    sessions.set('s1', { id: 's1', cwd: dir, runtime: Runtime.create({ cwd: dir, config: cfg }) });
    // Cancel marks the runtime aborted; the following prompt must stop early.
    const cancelled = await handleRpc({ id: 1, method: 'session/cancel', params: { sessionId: 's1' } }, sessions, process.cwd());
    expect(cancelled.error).toBeUndefined();
    // The cancel contract: the session runtime becomes aborted so an ongoing
    // prompt stops at its next checkpoint (spec: stopReason 'cancelled' when
    // the run throws; a fast fake run may simply finish with end_turn).
    expect(sessions.get('s1')!.runtime.aborted).toBe(true);
    const r = await handleRpc({ id: 2, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'x' }] } }, sessions, process.cwd());
    // Never an RPC-level error; stopReason is either cancelled (aborted run
    // threw) or end_turn (fake provider finished before the abort was seen).
    expect(r.error).toBeUndefined();
    expect(['cancelled', 'end_turn']).toContain((r.result as any).stopReason);
    for (const s of sessions.values()) { try { s.runtime.close(); } catch { /* best-effort */ } }
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe('ACP session/list + delete + mode', () => {
  it('session/list returns open sessions; delete removes one', async () => {
    const sessions = freshSessions();
    const created = await handleRpc({ id: 1, method: 'session/new', params: { cwd: process.cwd() } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    const listed = await handleRpc({ id: 2, method: 'session/list', params: {} }, sessions, process.cwd());
    expect((listed.result as any).sessions.some((s: any) => s.sessionId === sid)).toBe(true);
    const del = await handleRpc({ id: 3, method: 'session/delete', params: { sessionId: sid } }, sessions, process.cwd());
    expect(del.error).toBeUndefined();
    expect(sessions.has(sid)).toBe(false);
  });

  it('set_mode and set_config_option work against a real session', async () => {
    const sessions = freshSessions();
    const created = await handleRpc({ id: 1, method: 'session/new', params: { cwd: process.cwd() } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    const m = await handleRpc({ id: 2, method: 'session/set_mode', params: { sessionId: sid, modeId: 'plan' } }, sessions, process.cwd());
    expect((m.result as any).modeId).toBe('plan');
    expect(sessions.get(sid)!.runtime.config.planMode).toBe(true);
    const c = await handleRpc({ id: 3, method: 'session/set_config_option', params: { sessionId: sid, configId: 'plan_mode', value: false } }, sessions, process.cwd());
    expect(c.error).toBeUndefined();
    expect(sessions.get(sid)!.runtime.config.planMode).toBe(false);
  });
});

describe('ACP session/resume + persisted list + mode notify', () => {
  it('resume reopens a persisted goal and list surfaces persisted goals', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const { Runtime } = await import('./runtime.js');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-acp-resume-'));
    const cfg = { model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'x' }, telemetry: false, projectDir: '.mochi', quiet: true } as any;
    const runtime = Runtime.create({ cwd: dir, config: cfg });
    const goal = await runtime.goals.createGoal('persisted work');
    runtime.close();

    const sessions = new Map<string, AcpSession>();
    // resume with no live session but a persisted goalId must restore it.
    const resumed = await handleRpc({ id: 1, method: 'session/resume', params: { sessionId: 'r1', cwd: dir, goalId: goal.id } }, sessions, process.cwd());
    expect(resumed.error).toBeUndefined();
    expect(sessions.get('r1')!.loadedGoal?.goalId).toBe(goal.id);
    expect(sessions.get('r1')!.loadedGoal?.objective).toBe('persisted work');

    // session/list surfaces the persisted goal (session/load-able) on page one.
    const listed = await handleRpc({ id: 2, method: 'session/list', params: { limit: 50, includePersisted: true } }, sessions, process.cwd());
    const found = (listed.result as { sessions: Array<{ sessionId: string; persisted?: boolean }> }).sessions.find((s) => s.sessionId === goal.id);
    expect(found?.persisted).toBe(true);

    for (const s of sessions.values()) { try { s.runtime.close(); } catch { /* best-effort */ } }
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('set_mode notifies the client with current_mode_update', async () => {
    const sessions = freshSessions();
    const created = await handleRpc({ id: 1, method: 'session/new', params: { cwd: process.cwd() } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    const updates: string[] = [];
    const m = await handleRpc(
      { id: 2, method: 'session/set_mode', params: { sessionId: sid, modeId: 'plan' } },
      sessions, process.cwd(),
      (_sid, update) => updates.push(JSON.stringify(update)),
    );
    expect((m.result as any).modeId).toBe('plan');
    expect(updates.some((u) => u.includes('current_mode_update') && u.includes('plan'))).toBe(true);
  });
});

describe('ACP permission gate', () => {
  it('asks the client for non-auto-approved tools and honors a denial', async () => {
    const { startFakeOpenAI } = await import('./testutil/fake-openai.js');
    const { mkdtempSync, writeFileSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const { Runtime } = await import('./runtime.js');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-acp-perm-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    // Sticky router: harness-internal planning/summary calls answer inline so
    // the scripted agent turns below stay aligned.
    const turns: Array<{ content?: string; toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; finishReason: string }> = [
      { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'touch deny-marker.txt' }) } }], finishReason: 'tool_calls' },
      { content: 'done', finishReason: 'stop' },
    ];
    const fake = await startFakeOpenAI([
      {
        sticky: true,
        respondFn: (body: { messages?: Array<{ content?: unknown }> }) => {
          const texts = (body?.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n');
          if (/planning agent/i.test(texts) || texts.includes('Decompose the goal into a JSON array')) {
            const goalLine = texts.split('\n').find((l) => l.startsWith('Goal:'))?.slice(5).trim() || 'Do the prompted work';
            return { content: JSON.stringify([{ title: goalLine.slice(0, 80), description: goalLine, role: 'coder', dependencies: [], acceptanceCriteria: [] }]), finishReason: 'stop' as const };
          }
          if (/Write a concise summary/i.test(texts)) return { content: 'Run summarized.', finishReason: 'stop' as const };
          return turns.length ? turns.shift()! : { content: 'done', finishReason: 'stop' as const };
        },
      },
    ]);
    const cfg = { model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' }, safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 3, maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 4000 }, permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true }, telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false } as any;
    const sessions = new Map<string, AcpSession>();
    const sid = 'perm-sid';
    const runtime = Runtime.create({ cwd: dir, config: cfg });
    runtime.setPermPolicy('strict'); // strict: shell is never auto-approved
    sessions.set(sid, { id: sid, cwd: dir, runtime });

    const asks: Array<Record<string, unknown>> = [];
    const clientRequest = async (method: string, params: Record<string, unknown>) => {
      asks.push({ method, ...params });
      return { optionId: 'reject_once' };
    };
    const r = await handleRpc(
      { id: 1, method: 'session/prompt', params: { sessionId: sid, prompt: 'write the file deny-marker.txt with a shell touch command' } },
      sessions, process.cwd(), () => {}, { clientRequest },
    );
    expect(r.error).toBeUndefined();
    // The gate engaged: the agent asked the client for permission.
    const permAsk = asks.find((a) => a.method === 'session/request_permission');
    expect(permAsk).toBeDefined();
    expect((permAsk as any).options.some((o: any) => o.optionId === 'allow_once')).toBe(true);
    // The denial was honored: the shell command never ran.
    expect(existsSync(resolve(dir, 'deny-marker.txt'))).toBe(false);

    await fake.close();
    for (const s of sessions.values()) { try { s.runtime.close(); } catch { /* best-effort */ } }
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

describe('ACP session/load', () => {
  it('restores a persisted goal and resumes its tasks', async () => {
    const { startFakeOpenAI } = await import('./testutil/fake-openai.js');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const { Runtime } = await import('./runtime.js');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-acp-load-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
    const fake = await startFakeOpenAI([
      { content: '{"tasks":[{"title":"Say hi","description":"say hi","role":"coder","dependencies":[],"acceptanceCriteria":[],"verificationCommand":""}]}', finishReason: 'stop' },
      { content: 'done', finishReason: 'stop', completionTokens: 4 },
    ]);
    const cfg = { model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' }, safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 3, maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 4000 }, permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true }, telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false } as any;
    // Create a persisted goal in the workspace.
    const runtime = Runtime.create({ cwd: dir, config: cfg });
    const goal = await runtime.goals.createGoal('say hi');
    const tasks = await runtime.goals.decompose(goal);
    runtime.workspace.saveTasks(goal.id, tasks);
    runtime.goals.runGoal(goal, tasks, [], runtime.signal).catch(() => {});
    // Load it through ACP.
    const sessions = new Map<string, AcpSession>();
    const created = await handleRpc({ id: 1, method: 'session/new', params: { cwd: dir } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    sessions.set(sid, { id: sid, cwd: dir, runtime: Runtime.create({ cwd: dir, config: cfg }) });
    const loaded = await handleRpc({ id: 2, method: 'session/load', params: { sessionId: sid, goalId: goal.id } }, sessions, process.cwd());
    expect(loaded.error).toBeUndefined();
    expect(sessions.get(sid)!.loadedGoal?.goalId).toBe(goal.id);
    await fake.close();
    try { runtime.close(); } catch { /* best-effort */ }
    for (const s of sessions.values()) { try { s.runtime.close(); } catch { /* best-effort */ } }
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

describe('ACP acpCheck', () => {
  it('verifies the in-process lifecycle without spawning', async () => {
    const { acpCheck, ACP_PROTOCOL_VERSION } = await import('./acp.js');
    expect(ACP_PROTOCOL_VERSION).toBe(1);
    const r = await acpCheck(process.cwd());
    expect(r.ok).toBe(true);
    expect(r.report).toContain('ACP ok');
  });
});

describe('ACP protocol surface (pure dispatch)', () => {
  it('dispatches session lifecycle, config, auth, and error paths', async () => {
    const sessions = freshSessions();
    const call = (id: number, method: string, params: Record<string, unknown> = {}) =>
      handleRpc({ id, method, params }, sessions, process.cwd());

    // additionalDirectories round-trip through new -> list
    const created = await call(1, 'session/new', { cwd: process.cwd(), additionalDirectories: ['/tmp/extra-a', '/tmp/extra-b'] });
    const sid = (created.result as { sessionId: string }).sessionId;
    expect((created.result as { modes: Array<{ id: string }> }).modes.map((m) => m.id)).toEqual(['act', 'plan']);

    // set_mode: unknown session errors, default modeId is act
    expect((await call(2, 'session/set_mode', { sessionId: 'nope', modeId: 'plan' })).error?.code).toBe(-32602);
    expect((await call(3, 'session/set_mode', { sessionId: sid })).result).toEqual({ modeId: 'act' });
    expect(sessions.get(sid)!.runtime.config.planMode).toBe(false);

    // config options: clamped numeric values + unknown option + unknown session
    const mi = await call(4, 'session/set_config_option', { sessionId: sid, configId: 'max_iterations', value: 999 });
    expect((mi.result as { value: number }).value).toBe(50);
    expect(sessions.get(sid)!.runtime.config.safety.maxIterations).toBe(50);
    const cb = await call(5, 'session/set_config_option', { sessionId: sid, configId: 'context_budget_tokens', value: 100 });
    expect((cb.result as { value: number }).value).toBe(4000);
    expect((await call(6, 'session/set_config_option', { sessionId: sid, configId: 'nope', value: 1 })).error?.code).toBe(-32603);
    expect((await call(7, 'session/set_config_option', { sessionId: 'gone', configId: 'plan_mode', value: true })).error?.code).toBe(-32602);

    // tools_list exposes the runtime tool inventory
    const tl = await call(8, 'session/tools_list', { sessionId: sid });
    expect(Array.isArray((tl.result as { tools: unknown[] }).tools)).toBe(true);
    expect((await call(9, 'session/tools_list', { sessionId: 'gone' })).error?.code).toBe(-32602);

    // permission + auth + logout
    expect((await call(10, 'session/request_permission', { sessionId: sid })).result).toEqual({ outcome: 'allowed' });
    expect((await call(11, 'authenticate', { sessionId: sid, methodId: 'agent' })).error).toBeUndefined();
    expect((await call(12, 'authenticate', { sessionId: sid, methodId: 'oauth' })).error?.code).toBe(-32602);
    expect((await call(13, 'authenticate', { sessionId: 'gone' })).error?.code).toBe(-32602);
    expect((await call(14, 'logout', { sessionId: sid })).error).toBeUndefined();
    expect((await call(15, 'logout', { sessionId: 'gone' })).error?.code).toBe(-32602);

    // load: unknown session / no goalId / unknown goalId (result shape only)
    expect((await call(16, 'session/load', { sessionId: 'gone', goalId: 'g' })).error?.code).toBe(-32602);
    expect((await call(17, 'session/load', { sessionId: sid })).result).toHaveProperty('modes');
    expect((await call(18, 'session/load', { sessionId: sid, goalId: 'no-such-goal' })).result).toHaveProperty('modes');
    expect(sessions.get(sid)!.loadedGoal).toBeUndefined();

    // list pagination: single page (no cursor), additionalDirectories surfaced,
    // and a cursor past the end returns an empty page.
    const listed = await call(19, 'session/list', { limit: 50 });
    const listedRes = listed.result as { sessions: Array<{ additionalDirectories?: string[] }>; nextCursor?: string };
    expect(listedRes.sessions).toHaveLength(1);
    expect(listedRes.nextCursor).toBeUndefined();
    expect(listedRes.sessions[0].additionalDirectories).toEqual(['/tmp/extra-a', '/tmp/extra-b']);
    const past = await call(20, 'session/list', { cursor: Buffer.from(sid).toString('base64') });
    expect((past.result as { sessions: unknown[] }).sessions).toEqual([]);

    // delete unknown, resume-existing no-op, shutdown null
    expect((await call(21, 'session/delete', { sessionId: 'gone' })).error?.code).toBe(-32602);
    expect((await call(22, 'session/resume', { sessionId: sid })).result).toEqual({});
    expect((await call(23, 'shutdown')).result).toBeNull();

    await call(24, 'session/close', { sessionId: sid });
    expect(sessions.has(sid)).toBe(false);
  }, 60_000);
});

describe('ACP prompt text extraction + tool kinds', () => {
  it('normalizes string/array/number prompts, maps tool kinds, streams usage', async () => {
    const { startFakeOpenAI } = await import('./testutil/fake-openai.js');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const { Runtime } = await import('./runtime.js');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-acp-text-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
    // Shape-routed script: harness-internal model calls (goal decompose +
    // run-summary narrative) consume queue entries too, so a bare FIFO
    // misaligns — the write call lands on the wrong turn and no kind:edit
    // ever fires. The sticky router answers planning/summary calls inline
    // (no FIFO consumed); agent turns below run in script order.
    const agentTurns: Array<{ content?: string; toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; finishReason: string }> = [
      { content: 'hello!', finishReason: 'stop' },
      // P2: write tool call (kind=edit) then prose
      { toolCalls: [{ id: 'w1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'greeting.txt', content: 'hi' }) } }], finishReason: 'tool_calls' },
      { content: 'wrote it', finishReason: 'stop' },
      { content: 'three facts', finishReason: 'stop' },
      // P4: shell tool call (kind=execute) then prose
      { toolCalls: [{ id: 's1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'echo hi' }) } }], finishReason: 'tool_calls' },
      { content: 'shelled', finishReason: 'stop' },
    ];
    const fake = await startFakeOpenAI([
      {
        sticky: true,
        respondFn: (body: { messages?: Array<{ content?: unknown }> }) => {
          const texts = (body?.messages ?? []).map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).join('\n');
          if (/planning agent/i.test(texts) || texts.includes('Decompose the goal into a JSON array')) {
            // Echo the REAL goal objective into the task: classifiers only see
            // the decomposed title/description, and a generic stub ("Do the
            // prompted work") one-shots to chat — vetoing the very tool call
            // this test exists to observe.
            const goalLine = texts.split('\n').find((l) => l.startsWith('Goal:'))?.slice(5).trim() || 'Do the prompted work';
            return { content: JSON.stringify([{ title: goalLine.slice(0, 80), description: goalLine, role: 'coder', dependencies: [], acceptanceCriteria: [] }]), finishReason: 'stop' as const };
          }
          if (/Write a concise summary/i.test(texts)) {
            return { content: 'Run summarized.', finishReason: 'stop' as const };
          }
          return agentTurns.length ? agentTurns.shift()! : { content: 'done', finishReason: 'stop' as const };
        },
      },
    ]);
    const cfg = { model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' }, safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 5, maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 4000 }, permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true }, telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false } as any;
    const sessions = new Map<string, AcpSession>();
    const sid = 'text-sid';
    sessions.set(sid, { id: sid, cwd: dir, runtime: Runtime.create({ cwd: dir, config: cfg }) });
    const updates: string[] = [];
    const notify = (_s: string, u: Record<string, unknown>) => updates.push(JSON.stringify(u));

    // P1: plain string prompt (lenient path)
    const p1 = await handleRpc({ id: 1, method: 'session/prompt', params: { sessionId: sid, prompt: 'hello there friend' } }, sessions, process.cwd(), notify);
    expect((p1.result as { stopReason: string }).stopReason).toBe('end_turn');

    // P2: ContentBlock array with resource blocks, junk entries, and constraints.
    // NOTE: the lead text carries an action verb on purpose — a pure question
    // ("what is the best greeting") classifies as a chat task, and chat tasks
    // veto mutating tools before any tool:called event exists, so no tool_call
    // notification would ever fire. This test pins ACP plumbing (extraction +
    // kind mapping), not loop policy, so it asks for file work explicitly.
    const p2 = await handleRpc({ id: 2, method: 'session/prompt', params: {
      sessionId: sid,
      prompt: [
        { type: 'text', text: 'write the best greeting to greeting.txt' },
        { type: 'resource', resource: { text: 'extra context' } },
        { type: 'text' }, // no text field -> skipped
        42, // non-object -> skipped
        'loose string block',
      ],
      constraints: ['keep it short'],
    } }, sessions, process.cwd(), notify);
    expect((p2.result as { stopReason: string }).stopReason).toBe('end_turn');
    expect(updates.some((u) => u.includes('"kind":"edit"'))).toBe(true);

    // P3: numeric prompt coerced via String()
    const p3 = await handleRpc({ id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: 42 } }, sessions, process.cwd(), notify);
    expect((p3.result as { stopReason: string }).stopReason).toBe('end_turn');

    // P4: shell -> execute kind + final usage_update
    const p4 = await handleRpc({ id: 4, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'summarize the system state' }] } }, sessions, process.cwd(), notify);
    expect((p4.result as { stopReason: string }).stopReason).toBe('end_turn');
    expect(updates.some((u) => u.includes('"kind":"execute"'))).toBe(true);
    expect(updates.some((u) => u.includes('usage_update'))).toBe(true);
    expect(updates.some((u) => u.includes('tool_call_update'))).toBe(true);

    await fake.close();
    for (const s of sessions.values()) { try { s.runtime.close(); } catch { /* best-effort */ } }
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});

describe('ACP v1 completeness (W3-2)', () => {
  it('parseClientCapabilities: full shape parses; omission stores unsupported defaults', () => {
    const full = parseClientCapabilities({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      elicitation: { form: {} },
    });
    expect(full.elicitationForm).toBe(true);
    expect(full.fsReadTextFile).toBe(true);
    expect(full.fsWriteTextFile).toBe(true);
    expect(full.terminal).toBe(true);
    const bare = parseClientCapabilities(undefined);
    expect(bare.elicitationForm).toBe(false);
    expect(bare.fsReadTextFile).toBe(false);
    expect(bare.fsWriteTextFile).toBe(false);
    expect(bare.terminal).toBe(false);
    // elicitation:true without a form object does not unlock form elicitation
    expect(parseClientCapabilities({ elicitation: true }).elicitationForm).toBe(false);
  });

  it('initialize records the client capabilities into the connection state (observable by the next call)', async () => {
    const state: AcpConnectionState = { clientCapabilities: parseClientCapabilities(undefined) };
    const sessions = freshSessions();
    await handleRpc(
      { id: 1, method: 'initialize', params: { clientCapabilities: { elicitation: { form: {} }, fs: { readTextFile: true } } } },
      sessions, process.cwd(), () => {}, { state },
    );
    expect(state.clientCapabilities.elicitationForm).toBe(true);
    expect(state.clientCapabilities.fsReadTextFile).toBe(true);
    expect(state.clientCapabilities.terminal).toBe(false);
    // A second initialize (re-negotiation) overwrites, not merges.
    await handleRpc({ id: 2, method: 'initialize', params: {} }, sessions, process.cwd(), () => {}, { state });
    expect(state.clientCapabilities.elicitationForm).toBe(false);
  });

  it('additionalDirectories is honored on session/load and surfaced in session/list', async () => {
    const sessions = freshSessions();
    const created = await handleRpc({ id: 1, method: 'session/new', params: { cwd: process.cwd() } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    const loaded = await handleRpc(
      { id: 2, method: 'session/load', params: { sessionId: sid, additionalDirectories: ['/tmp/r1', 'relative/dir'] } },
      sessions, process.cwd(),
    );
    expect(loaded.error).toBeUndefined();
    const listed = await handleRpc({ id: 3, method: 'session/list', params: {} }, sessions, process.cwd());
    const entry = (listed.result as any).sessions.find((s: any) => s.sessionId === sid);
    expect(entry.additionalDirectories).toContain('/tmp/r1');
    // Relative input was resolved to an absolute path (v1 spec requirement).
    expect(entry.additionalDirectories.every((d: string) => d.startsWith('/'))).toBe(true);
    for (const s of sessions.values()) { try { s.runtime.close(); } catch { /* best-effort */ } }
  });

  it('additionalDirectories is honored on session/resume (create + refresh of a live session)', async () => {
    const sessions = freshSessions();
    const created = await handleRpc({ id: 1, method: 'session/new', params: { cwd: process.cwd() } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    await handleRpc({ id: 2, method: 'session/close', params: { sessionId: sid } }, sessions, process.cwd());
    const resumed = await handleRpc(
      { id: 3, method: 'session/resume', params: { sessionId: sid, additionalDirectories: ['/tmp/r2'] } },
      sessions, process.cwd(),
    );
    expect(resumed.error).toBeUndefined();
    // Resume of a LIVE session refreshes the roots too.
    const r2 = await handleRpc(
      { id: 4, method: 'session/resume', params: { sessionId: sid, additionalDirectories: ['/tmp/r3'] } },
      sessions, process.cwd(),
    );
    expect(r2.error).toBeUndefined();
    const listed = await handleRpc({ id: 5, method: 'session/list', params: {} }, sessions, process.cwd());
    const entry = (listed.result as any).sessions.find((s: any) => s.sessionId === sid);
    expect(entry.additionalDirectories).toEqual(['/tmp/r3']);
    for (const s of sessions.values()) { try { s.runtime.close(); } catch { /* best-effort */ } }
  });

  it('elicitation bridge: accept returns the picked labels; decline skips; client error skips', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const accept: Record<string, unknown> = { action: 'accept', content: ['oauth'] };
    const fn = elicitationPromptUser(async (method, params) => {
      calls.push({ method, params });
      if (calls.length === 2) throw new Error('client broke');
      return accept;
    }, 's-elic');
    const res = await fn({
      questions: [
        { question: 'Which auth?', options: [{ label: 'oauth' }, { label: 'token' }] },
        { question: 'Deadline?', options: [{ label: 'today' }] },
      ],
    });
    expect(calls.length).toBe(2);
    expect(calls[0].method).toBe('elicitation/create');
    expect(calls[0].params.sessionId).toBe('s-elic');
    expect(calls[0].params.mode).toBe('form');
    expect((calls[0].params as any).message).toBe('Which auth?');
    expect(res.answers[0].selected).toEqual(['oauth']);
    // Second question: the client threw → skipped, never a hang.
    expect(res.answers[1].selected).toEqual([]);
    expect(res.answers[1].skipped).toBe(true);
    // Free text passes through as freeText; decline → skipped.
    const decline = await elicitationPromptUser(async () => ({ action: 'decline' }), 's');
    const dres = await decline({ questions: [{ question: 'q', options: [{ label: 'a' }] }] });
    expect(dres.answers[0].skipped).toBe(true);
    const freetext = await elicitationPromptUser(async () => ({ action: 'accept', content: ['something custom'] }), 's');
    const fres = await freetext({ questions: [{ question: 'q', options: [{ label: 'a' }] }] });
    expect(fres.answers[0].selected).toEqual([]);
    expect(fres.answers[0].freeText).toBe('something custom');
  });
});

