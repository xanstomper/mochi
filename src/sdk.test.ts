// SDK surface: in-process prompt/branch/sessions against a fake provider.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Mochi } from './sdk.js';
import { startFakeOpenAI, type FakeOpenAI } from './testutil/fake-openai.js';
import type { MochiConfig } from './types.js';

function makeConfig(url: string): Partial<MochiConfig> {
  return {
    model: { provider: 'openai', baseUrl: url, apiKey: 'k', model: 'fake-model' } as MochiConfig['model'],
    // The SDK plumbing tests script fixed model turns; the scripted models
    // cannot adapt to a reproduce-first veto or satisfy the evidence
    // critic — the documented scripted-e2e seam opts these runs out.
    safety: { mode: 'auto', commandTimeoutSeconds: 30, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000, skipReproGate: true },
  };
}

let fake: FakeOpenAI | null = null;
let dir = '';
const liveSdks: Mochi[] = [];
async function setup(replies: Array<Record<string, unknown>>): Promise<Mochi> {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-sdk-'));
  execSync('git init -q ' + dir);
  writeFileSync(resolve(dir, 'README.md'), '# t');
  fake = await startFakeOpenAI(replies as never);
  const m = Mochi.create({ cwd: dir, config: makeConfig(fake.url) });
  liveSdks.push(m);
  return m;
}
afterEach(async () => {
  await fake?.close();
  // Windows locks the open SQLite file — release every runtime before the
  // workspace dir can be deleted.
  for (const m of liveSdks.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
  if (dir) rmSync(dir, { recursive: true, force: true });
  fake = null; dir = '';
});

describe('Mochi SDK (in-process mode)', () => {
  it('runs a prompt end-to-end and returns a structured result', async () => {
    // End-to-end intent: SDK plumbing returns a structured result. The script
    // performs a REAL write: prose-only replies to a creation-led prompt are
    // (correctly) failed as incomplete by the file-output guard, so a
    // do-nothing script must not expect success here.
    const mochi = await setup([
      {
        content: 'Creating the file now.',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'sdk-w1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'greeting.txt', content: 'hello mochi' }) } }],
      },
      { content: 'Created the file and ran tests. All pass.', finishReason: 'stop' },
    ]);
    const r = await mochi.prompt('Create greeting file and verify. fix tests too');
    expect(r.success).toBe(true);
    expect(r.summary).toContain('Created the file');
    expect(r.tokensUsed).toBeGreaterThanOrEqual(0);
  });

  it('branches the session and the branch copies the transcript', async () => {
    const mochi = await setup([{ content: 'did the work', finishReason: 'stop' }]);
    await mochi.prompt('Create greeting file and verify. fix tests too');
    const b = mochi.branchSession('test branch');
    expect(b).toContain('Branched session');
    const sessions = mochi.sessions(5);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  });

  it('plan returns text without executing changes', async () => {
    const mochi = await setup([{ content: 'plan text', finishReason: 'stop' }]);
    const p = await mochi.plan('restructure the auth module');
    expect(p.length).toBeGreaterThan(0);
  });

  it('run() aliases prompt() and newSession/useProvider return strings', async () => {
    const mochi = await setup([
      {
        content: 'Creating the file now.',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'sdk-r1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'greeting.txt', content: 'hello mochi' }) } }],
      },
      { content: 'ran the task', finishReason: 'stop' },
    ]);
    const r = await mochi.run('Create greeting file and verify. fix tests too');
    expect(r.summary).toContain('ran the task');
    expect(mochi.newSession()).toBeTruthy();
    expect(typeof (await mochi.useProvider('openai', 'fake-model-2'))).toBe('string');
  });

  it('on/onAny subscribe to live events and unsubscribe cleanly', async () => {
    const mochi = await setup([{ content: 'subscribed work', finishReason: 'stop' }]);
    const seen: string[] = [];
    const offAny = mochi.onAny((e) => { seen.push(e.type); });
    const offLog = mochi.on('agent:log', (e) => { seen.push(`log:${e.message}`); });
    try {
      await mochi.prompt('Create greeting file and verify. fix tests too');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.some((s) => s.startsWith('log:'))).toBe(true);
    } finally {
      offAny();
      offLog();
    }
    const frozen = seen.length;
    expect(seen.length).toBe(frozen); // unsubscribed: no accumulation after
  });

  it('stream() yields events until broken out, then closes', async () => {
    const mochi = await setup([{ content: 'stream done', finishReason: 'stop' }]);
    const iter = mochi.stream();
    const pending = mochi.prompt('Create greeting file and verify. fix tests too');
    const seen: string[] = [];
    for await (const e of iter) {
      seen.push(e.type);
      if (seen.length >= 2) break; // triggers iterator.return() -> close()
    }
    await pending;
    expect(seen.length).toBeGreaterThanOrEqual(2);
    // Closed iterator reports done immediately.
    const after = await iter[Symbol.asyncIterator]().next();
    expect(after.done).toBe(true);
    iter.close(); // idempotent
  });
});

describe('Mochi SDK programmatic tools + hooks + cancellation', () => {
  it('registerTool exposes an in-process tool to the agent', async () => {
    const mochi = await setup([
      { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'sdk_echo', arguments: JSON.stringify({ text: 'ping' }) } }], finishReason: 'tool_calls' },
      { content: 'Done echoing.', finishReason: 'stop' },
    ]);
    const calls: string[] = [];
    const off = mochi.registerTool({
      def: { name: 'sdk_echo', description: 'Echo text back', parameters: [{ name: 'text', type: 'string', description: 'text', required: true }] },
      execute: async (args) => { calls.push(String(args.text)); return `echoed:${args.text}`; },
    });
    try {
      await mochi.prompt('Use the sdk_echo tool to echo ping.');
      expect(calls).toEqual(['ping']);
    } finally { off(); }
  }, 30_000);

  it('onHook before_tool vetoes a mutating tool', async () => {
    const mochi = await setup([
      { toolCalls: [{ id: 'w1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'blocked.txt', content: 'x' }) } }], finishReason: 'tool_calls' },
      { content: 'Could not write; the hook blocked it.', finishReason: 'stop' },
    ]);
    const off = mochi.onHook('before_tool', (ctx) => (ctx.tool === 'write' ? false : undefined));
    try {
      await mochi.prompt('Create blocked.txt and verify. fix tests too');
      expect(existsSync(resolve(dir, 'blocked.txt'))).toBe(false);
    } finally { off(); }
  }, 30_000);

  it('prompt accepts an AbortSignal and stops before a slow provider responds', async () => {
    // delayMs=8000 gives the <3500ms abort assertion a huge margin: if the
    // signal were NOT honored, prompt() couldn't return before ~8s (the fake
    // provider's delay), so passing the threshold proves the abort fired even
    // under full-suite CPU load (the old 4000ms delay raced teardown and
    // flaked at 3881ms vs the 3500ms bar).
    const mochi = await setup([{ content: 'late reply', finishReason: 'stop', delayMs: 8000 }]);
    const ac = new AbortController();
    const t0 = Date.now();
    const p = mochi.prompt('Say hello to the user', { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(typeof r.summary).toBe('string');
  }, 30_000);
});

describe('Mochi SDK streaming + discovery', () => {
  it('promptStream yields live events then returns the result', async () => {
    const mochi = await setup([{ content: 'streamed work done', finishReason: 'stop' }]);
    const gen = mochi.promptStream('Do the thing');
    const seen: string[] = [];
    let result;
    for (;;) {
      const n = await gen.next();
      if (n.done) { result = n.value; break; }
      seen.push(n.value.type);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(result?.success).toBe(true);
    expect(result?.summary).toContain('streamed work done');
  });

  it('searchSkills finds bundled skills and addMcpServer validates', async () => {
    const mochi = await setup([{ content: 'x', finishReason: 'stop' }]);
    const hits = mochi.searchSkills('test', 5);
    expect(Array.isArray(hits)).toBe(true);
    const bad = mochi.addMcpServer('no-such-server-xyz');
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('Unknown MCP server');
  });
});

describe('Mochi SDK (remote daemon mode)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs status with auth headers and coerces statusTyped', async () => {
    const m = Mochi.connect({ port: 1234, token: 'tok' });
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ready: true, tasks: '3', activeAgents: null }) }));
    vi.stubGlobal('fetch', fetchMock);

    const s = await m.status();
    expect(s.ready).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:1234/api/status');
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    // The daemon rejects GET on authenticated routes — status must POST.
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((opts.headers as Record<string, string>)['content-type']).toBe('application/json');

    expect(await m.statusTyped()).toEqual({ ready: true, tasks: 3, activeAgents: 0 });
  });

  it('hits the new inventory/review/verify/health routes', async () => {
    const m = Mochi.connect({ port: 4444, token: 't' });
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: 1 }) }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await m.health()).toEqual({ ok: 1 });
    expect(await m.models()).toEqual({ ok: 1 });
    expect(await m.skills()).toEqual({ ok: 1 });
    expect(await m.review('diff-text')).toEqual({ ok: 1 });
    expect(await m.verify('test', 'a.ts')).toEqual({ ok: 1 });

    const calls = fetchMock.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      'http://127.0.0.1:4444/api/health',
      'http://127.0.0.1:4444/api/models',
      'http://127.0.0.1:4444/api/skills',
      'http://127.0.0.1:4444/api/review',
      'http://127.0.0.1:4444/api/verify',
    ]);
    // Health carries no auth at all (unauthenticated probe); the rest do.
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
    expect((fetchMock.mock.calls[1][1]!.headers as Record<string, string>).authorization).toBe('Bearer t');
    expect(fetchMock.mock.calls[3][1]!.body).toBe('{"diff":"diff-text"}');
    expect(fetchMock.mock.calls[4][1]!.body).toBe('{"command":"test","target":"a.ts"}');
  });

  it('goalStream yields SSE events and returns the terminal payload', async () => {
    const m = Mochi.connect({ port: 5555, token: 't' });
    const chunks = [
      'event: task:started\ndata: {"task":"build"}\n\n',
      'event: log\ndata: {"message":"working"}\n\n',
      'event: done\ndata: {"ok":true,"out":"shipped"}\n\n',
    ];
    const enc = new TextEncoder();
    const queue = chunks.map((c) => enc.encode(c));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }),
          cancel: async () => {},
        }),
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const seen: Array<{ event: string; data: unknown }> = [];
    const gen = m.goalStream('build it');
    for (;;) {
      const n = await gen.next();
      if (n.done) {
        expect(n.value).toEqual({ ok: true, out: 'shipped' });
        break;
      }
      seen.push(n.value);
    }
    expect(seen).toEqual([
      { event: 'task:started', data: { task: 'build' } },
      { event: 'log', data: { message: 'working' } },
    ]);
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>).accept).toBe('text/event-stream');
  });

  it('POSTs prompt, applying defaults when the daemon omits fields', async () => {
    const m = Mochi.connect({ port: 2222 }); // no token -> no auth header
    const fetchMock = vi.fn(async () => ({ json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await m.prompt('do it');
    expect(r).toEqual({ summary: '', status: 'unknown', success: false, tokensUsed: 0, costUsd: 0, durationMs: 0, filesModified: [] });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:2222/api/prompt');
    expect(fetchMock.mock.calls[0][1]!.body).toBe('{"task":"do it"}');
    expect((fetchMock.mock.calls[0][1]!.headers as Record<string, string>).authorization).toBeUndefined();

    // Full payload maps through untouched.
    fetchMock.mockImplementation(async () => ({
      json: async () => ({ summary: 's', status: 'completed', success: true, tokensUsed: 7, costUsd: 0.5, durationMs: 9, filesModified: ['a.ts'] }),
    }));
    const full = await m.prompt('do it again');
    expect(full).toEqual({ summary: 's', status: 'completed', success: true, tokensUsed: 7, costUsd: 0.5, durationMs: 9, filesModified: ['a.ts'] });
  });

  it('goal/plan/approve/resume hit their endpoints with the token', async () => {
    const m = Mochi.connect({ port: 3333, token: 't' });
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: 1 }) }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await m.goal('g')).toEqual({ ok: 1 });
    expect(await m.plan('p')).toEqual({ ok: 1 });
    expect(await m.approve()).toEqual({ ok: 1 });
    expect(await m.resume('goal-1')).toEqual({ ok: 1 });

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'http://127.0.0.1:3333/api/goal',
      'http://127.0.0.1:3333/api/plan',
      'http://127.0.0.1:3333/api/approve',
      'http://127.0.0.1:3333/api/resume',
    ]);
    expect(fetchMock.mock.calls[0][1]!.body).toBe('{"objective":"g"}');
    expect(fetchMock.mock.calls[3][1]!.body).toBe('{"goalId":"goal-1"}');
    expect((fetchMock.mock.calls[1][1]!.headers as Record<string, string>).authorization).toBe('Bearer t');
  });
});
