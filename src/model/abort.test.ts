import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createOpenAIProvider } from './openai.js';

it('aborts an in-flight stream when the signal fires', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices": [{"delta": {"content": "partial"}}]}\n\n');
    const t = setInterval(() => res.write(': ping\n\n'), 50);
    req.on('close', () => clearInterval(t));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as AddressInfo;

  const ac = new AbortController();
  const provider = createOpenAIProvider({ baseUrl: `http://127.0.0.1:${addr.port}/v1`, apiKey: 'x', model: 'm', providerName: 'openai' });
  const pro = provider.streamChat([{ role: 'user', content: 'hi' }], [], { signal: ac.signal });
  const first = await pro.next();
  expect(first.value?.content).toBe('partial');
  setTimeout(() => ac.abort(), 20);
  let ended = false;
  try {
    while (!(await pro.next()).done) { /* drain */ }
    ended = true;
  } catch { ended = true; }
  expect(ended).toBe(true);
  server.close();
}, 10_000);
