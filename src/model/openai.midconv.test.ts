import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createProvider } from './router.js';

// Regression: some OpenAI-compatible models (qwen3.6-35b on freeinference)
// silently return EMPTY responses (finish=stop, 0 completion tokens) when a
// `system` message appears AFTER the user turn. Mochi appends runtime
// context (preflight, focus nudges) as mid-conversation system messages,
// which reliably killed those requests. The OpenAI adapter must therefore
// send mid-conversation system notices as user-role text.

describe('openai adapter mid-conversation system messages', () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  function startCapture(statusOnSystemAfterUser = false) {
    return new Promise<{ port: number; bodies: any[] }>((resolveStart) => {
      const bodies: any[] = [];
      server = http.createServer((req, res) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => {
          const body = JSON.parse(data);
          bodies.push(body);
          // Optionally simulate the broken-model behavior: if a system
          // message appears after a user turn, return an empty completion.
          const hasSystemAfterUser = body.messages.some(
            (m: any, i: number) => m.role === 'system' && body.messages.slice(0, i).some((x: any) => x.role === 'user'),
          );
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const empty = statusOnSystemAfterUser && hasSystemAfterUser;
          const chunk = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          chunk({ id: 'x', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          if (!empty) chunk({ id: 'x', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] });
          chunk({ id: 'x', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: empty ? 0 : 1, total_tokens: 1 } });
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      server.listen(0, () => resolveStart({ port: (server!.address() as any).port, bodies }));
    });
  }

  it('maps mid-conversation system messages to user role with framing', async () => {
    const { port, bodies } = await startCapture();
    const provider = createProvider({
      provider: 'freeinference', baseUrl: `http://localhost:${port}`, model: 'qwen3.6-35b', apiKey: 'k',
    } as any);
    const messages = [
      { role: 'system' as const, content: 'You are Mochi.' },
      { role: 'user' as const, content: 'Code a calculator.' },
      { role: 'system' as const, content: 'Preflight: repo=unknown' },
      { role: 'system' as const, content: '# Focus: implementation' },
    ];
    const res = await provider.chat(messages, [], {});
    expect(res.content).toBe('ok');
    const sent = bodies[0].messages as any[];
    // Leading system prompt stays system.
    expect(sent[0].role).toBe('system');
    // Mid-conversation system notices become user-role framed text.
    expect(sent[2].role).toBe('user');
    expect(sent[2].content).toContain('[system notice] Preflight: repo=unknown');
    expect(sent[3].role).toBe('user');
    expect(sent[3].content).toContain('[system notice] # Focus: implementation');
    // No system role after the first user turn.
    const firstUser = sent.findIndex((m) => m.role === 'user');
    expect(sent.slice(firstUser).every((m) => m.role !== 'system')).toBe(true);
  });

  it('keeps tool and assistant-with-tool_calls mappings intact', async () => {
    const { port, bodies } = await startCapture();
    const provider = createProvider({
      provider: 'freeinference', baseUrl: `http://localhost:${port}`, model: 'qwen3.6-35b', apiKey: 'k',
    } as any);
    const messages = [
      { role: 'system' as const, content: 'You are Mochi.' },
      { role: 'user' as const, content: 'Code a calculator.' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'shell', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: 'c1', content: 'ok' },
      { role: 'system' as const, content: 'Focus: implementation' },
    ] as any;
    const res = await provider.chat(messages, [], {});
    expect(res.content).toBe('ok');
    const sent = bodies[0].messages as any[];
    expect(sent[2].role).toBe('assistant');
    expect(sent[2].tool_calls).toBeDefined();
    expect(sent[3].role).toBe('tool');
    expect(sent[3].tool_call_id).toBe('c1');
    expect(sent[4].role).toBe('user');
    expect(sent[4].content).toContain('[system notice]');
  });
});
