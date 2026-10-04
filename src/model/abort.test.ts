import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createOpenAIProvider } from './openai.js';

it('preserves the caller abort reason instead of replacing it with a generic AbortError', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const t = setInterval(() => res.write(': ping\n\n'), 50);
    res.on('close', () => clearInterval(t));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as AddressInfo;
  const ac = new AbortController();
  const reason = new Error('operator cancelled exact reason');
  const provider = createOpenAIProvider({ baseUrl: `http://127.0.0.1:${addr.port}/v1`, apiKey: 'local-test-key', model: 'm', providerName: 'openai' });
  const stream = provider.streamChat([{ role: 'user', content: 'hi' }], [], { signal: ac.signal });
  const pending = stream.next();
  const timer = setTimeout(() => ac.abort(reason), 20);
  try {
    await expect(pending).rejects.toBe(reason);
  } finally {
    clearTimeout(timer);
    ac.abort(reason);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10_000);


it('preserves the caller reason after stream output has started', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as AddressInfo;
  const ac = new AbortController();
  const reason = new Error('stop after first chunk');
  const provider = createOpenAIProvider({ baseUrl: `http://127.0.0.1:${addr.port}/v1`, apiKey: 'local-test-key', model: 'm' });
  const stream = provider.streamChat([], [], { signal: ac.signal });
  try {
    expect((await stream.next()).value?.content).toBe('partial');
    ac.abort(reason);
    await expect(stream.next()).rejects.toBe(reason);
  } finally {
    ac.abort(reason);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10_000);

it('closes the HTTP response when the consumer stops reading early', async () => {
  let responseClosed = false;
  const server = createServer((_req, res) => {
    res.on('close', () => { responseClosed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as AddressInfo;
  const provider = createOpenAIProvider({ baseUrl: `http://127.0.0.1:${addr.port}/v1`, apiKey: 'local-test-key', model: 'm' });
  const stream = provider.streamChat([], []);
  try {
    expect((await stream.next()).value?.content).toBe('partial');
    await stream.return(undefined);
    await expect.poll(() => responseClosed, { timeout: 1000 }).toBe(true);
  } finally {
    await stream.return(undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10_000);

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
