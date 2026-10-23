// ACP v1 conformance over REAL stdio (W3-2): spawns the server entry as a
// child process, speaks newline-delimited JSON-RPC 2.0 to it, and drives the
// stabilized method surface — initialize, session/new, session/prompt,
// session/cancel, session/resume, session/list, session/close, shutdown —
// asserting responses, capability flags, and v1-clean negotiation.
//
// The child's model provider points at an in-test fake OpenAI server, so
// session/prompt is a REAL end-to-end goal run (model call → stopReason)
// with no network and no real provider. The elicitation flow is exercised
// the same way: the fake model calls ask_question, the child relays it as
// elicitation/create (srv-* request), the driver answers, the prompt
// completes with the user's choice.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeOpenAI, type FakeOpenAI } from './testutil/fake-openai.js';

const ENTRY = resolve(fileURLToPath(import.meta.url), '../testutil/acp-stdio-entry.ts');

interface Pending {
  resolve: (v: unknown) => void;
}
interface SrvRequest {
  resolve: (result: unknown) => void;
  params: Record<string, unknown>;
  method: string;
}

class AcpStdioClient {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private srvWaiters: Array<(r: SrvRequest) => void> = [];
  private nextId = 10;
  readonly lines: string[] = [];
  exited: Promise<number | null>;

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      cwd: resolve(fileURLToPath(import.meta.url), '../..'),
      env: { ...process.env, ...env },
    });
    this.exited = new Promise((res) => this.child.on('exit', (code) => res(code)));
    const rl = createInterface({ input: this.child.stdout, terminal: false });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      this.lines.push(t);
      let msg: any;
      try { msg = JSON.parse(t); } catch { return; }
      if (msg.method && msg.id !== undefined && String(msg.id).startsWith('srv-')) {
        // Server→client request (elicitation/create). Answer with the first
        // registered waiter's result, else decline.
        const waiter = this.srvWaiters.shift();
        const req: SrvRequest = { method: msg.method, params: msg.params ?? {}, resolve: () => {} };
        const result = waiter
          ? new Promise<unknown>((res) => { req.resolve = res; })
          : Promise.resolve({ action: 'decline' });
        if (waiter) waiter(req);
        else this.respond(msg.id, { action: 'decline' });
        void result.then((r) => this.respond(msg.id, r));
        return;
      }
      if (msg.id !== undefined && this.pending.has(String(msg.id))) {
        const p = this.pending.get(String(msg.id))!;
        this.pending.delete(String(msg.id));
        p.resolve(msg);
      }
    });
    this.child.stderr.on('data', () => { /* diagnostics only; never the RPC channel */ });
  }

  private respond(id: unknown, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  send(msg: unknown): void {
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  /** JSON-RPC request; resolves with the full response object. */
  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = ++this.nextId;
    const p = new Promise<any>((res) => this.pending.set(String(id), { resolve: res }));
    this.send({ jsonrpc: '2.0', id, method, params });
    return p;
  }

  /** Next server→client request (elicitation/create), answered by the handler. */
  nextServerRequest(timeoutMs = 30_000): Promise<SrvRequest> {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timed out waiting for a server→client request')), timeoutMs);
      this.srvWaiters.push((r) => { clearTimeout(timer); res(r); });
    });
  }

  close(): void {
    try { this.child.stdin.end(); } catch { /* already closed */ }
    try { this.child.kill('SIGTERM'); } catch { /* already exited */ }
  }
}

const clients: AcpStdioClient[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const c of clients) c.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  client: AcpStdioClient;
  fake: FakeOpenAI;
  workspace: string;
}

async function startFixture(script: Parameters<typeof startFakeOpenAI>[0]): Promise<Fixture> {
  const fake = await startFakeOpenAI(script);
  const workspace = mkdtempSync(join(tmpdir(), 'mochi-acp-conf-'));
  dirs.push(workspace);
  const configDir = mkdtempSync(join(tmpdir(), 'mochi-acp-confcfg-'));
  dirs.push(configDir);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model', apiKey: 'test-key' },
    quiet: true,
  }));
  const client = new AcpStdioClient({
    MOCHI_CONFIG_PATH: join(configDir, 'config.json'),
    ACP_FIXTURE_CWD: workspace,
  });
  clients.push(client);
  return { client, fake, workspace };
}

describe('ACP v1 conformance over stdio', () => {
  it('negotiates v1 and advertises only working capabilities', async () => {
    const { client, fake } = await startFixture([]);
    const res = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, elicitation: { form: {} } },
    });
    expect(res.result.protocolVersion).toBe(1); // v1-clean even when asked for v1
    expect(res.result.agentCapabilities.sessionCapabilities.list).toBeDefined();
    expect(res.result.agentCapabilities.sessionCapabilities.delete).toBeDefined();
    expect(res.result.agentCapabilities.sessionCapabilities.resume).toBeDefined();
    expect(res.result.agentCapabilities.sessionCapabilities.close).toBeDefined();
    expect(res.result.agentCapabilities.sessionCapabilities.additionalDirectories).toBeDefined();
    expect(res.result.agentCapabilities.loadSession).toBe(true);
    // Advertise only what works: mcpServers is not wired, so no mcpCapabilities.
    expect(res.result.agentCapabilities.mcpCapabilities).toBeUndefined();
    expect(res.result.implementation.name).toBe('mochi');
    // v2 is DRAFT: asking for it must NOT upgrade the negotiation.
    const v2 = await client.request('initialize', { protocolVersion: 2 });
    expect(v2.result.protocolVersion).toBe(1);
    await fake.close();
  }, 120_000);

  it('drives the full session lifecycle: new → prompt(end_turn) → cancel → resume → list → close', async () => {
    const { client, fake } = await startFixture([
      { content: 'Conformance done.', finishReason: 'stop', completionTokens: 5 },
    ]);
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });

    const created = await client.request('session/new', {});
    const sid = created.result?.sessionId;
    expect(typeof sid).toBe('string');
    expect(sid.length).toBeGreaterThan(0);

    const prompt = await client.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] });
    expect(prompt.error).toBeUndefined();
    expect(prompt.result.stopReason).toBe('end_turn');

    // session/update notifications must have streamed server→client.
    await new Promise((r) => setTimeout(r, 200));
    expect(client.lines.some((l) => l.includes('"session/update"'))).toBe(true);

    const cancel = await client.request('session/cancel', { sessionId: sid });
    expect(cancel.error).toBeUndefined();

    const resume = await client.request('session/resume', { sessionId: sid, additionalDirectories: ['/tmp'] });
    expect(resume.error).toBeUndefined();

    const list = await client.request('session/list', {});
    expect(list.error).toBeUndefined();
    const entry = (list.result.sessions as any[]).find((s) => s.sessionId === sid);
    expect(entry).toBeDefined();
    expect(entry.additionalDirectories).toContain(resolve('/tmp', '')); // resolved absolute

    const closed = await client.request('session/close', { sessionId: sid });
    expect(closed.error).toBeUndefined();
    const after = await client.request('session/list', {});
    expect((after.result.sessions as any[]).some((s) => s.sessionId === sid)).toBe(false);

    client.close();
    await fake.close();
  }, 180_000);

  it('relays ask_question as elicitation/create and feeds the answer back', async () => {
    const { client, fake } = await startFixture([]);
    // Route by SHAPE, not call order: pre-loop model calls (e.g. session
    // title generation) would otherwise consume scripted slots. Until a
    // tool result exists in the transcript, the model asks the question;
    // after it, the model wraps up.
    fake.append([{
      sticky: true,
      respondFn: (body: any) => {
        const sawToolResult = (body?.messages ?? []).some((m: any) => m.role === 'tool');
        if (sawToolResult) return { content: 'Chose oauth.', finishReason: 'stop', completionTokens: 5 };
        return {
          toolCalls: [{
            id: 'call_1', type: 'function' as const,
            function: { name: 'ask_question', arguments: JSON.stringify({ question: 'Which auth?', options: [{ label: 'oauth', description: 'OAuth flow' }, { label: 'token' }] }) },
          }],
          finishReason: 'tool_calls',
          completionTokens: 12,
        };
      },
    }]);
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
    const created = await client.request('session/new', {});
    const sid = created.result.sessionId as string;

    const promptP = client.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'ask me' }] });
    const srv = await client.nextServerRequest();
    expect(srv.method).toBe('elicitation/create');
    expect(srv.params.sessionId).toBe(sid);
    expect(srv.params.mode).toBe('form');
    expect(JSON.stringify(srv.params.message)).toMatch(/auth/i);
    srv.resolve({ action: 'accept', content: ['oauth'] });

    const prompt = await promptP;
    expect(prompt.error).toBeUndefined();
    expect(prompt.result.stopReason).toBe('end_turn');
    client.close();
    await fake.close();
  }, 180_000);

  it('keeps the run headless when the client did not advertise elicitation', async () => {
    const { client, fake } = await startFixture([]);
    fake.append([{
      sticky: true,
      respondFn: (body: any) => {
        const sawToolResult = (body?.messages ?? []).some((m: any) => m.role === 'tool');
        if (sawToolResult) return { content: 'ok', finishReason: 'stop', completionTokens: 3 };
        return {
          toolCalls: [{
            id: 'call_1', type: 'function' as const,
            function: { name: 'ask_question', arguments: JSON.stringify({ question: 'Which auth?', options: [{ label: 'oauth', recommended: true }, { label: 'token' }] }) },
          }],
          finishReason: 'tool_calls',
          completionTokens: 12,
        };
      },
    }]);
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} }); // no elicitation
    const created = await client.request('session/new', {});
    const sid = created.result.sessionId as string;
    const prompt = await client.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'ask me' }] });
    expect(prompt.error).toBeUndefined();
    expect(prompt.result.stopReason).toBe('end_turn');
    // No elicitation/create was ever sent to the client.
    expect(client.lines.some((l) => l.includes('elicitation/create'))).toBe(false);
    client.close();
    await fake.close();
  }, 180_000);
});
