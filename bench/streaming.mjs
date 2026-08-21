// Streaming throughput + first-token-latency micro-benchmark.
//
// Measures how fast the REAL production openai provider drains an SSE stream
// from a local in-process server. Isolates the provider's read loop + parser
// (the hot path) from network latency. Run:  npm run bench:stream
//
// Numbers to watch:
//   firstTokenMs  — ms from request start until the first content chunk.
//   tokens/sec    — sustained tokens drained once the stream is flowing.
//
// The watchdog rewrite (bare reader.read() + one reusable timer) keeps the
// steady-state hot path allocation-free on the provider side.

import { createServer } from 'node:http';
import { once } from 'node:events';
import { createOpenAIProvider } from '../src/model/openai.js';

const CHUNKS = 500;          // SSE data chunks per completion
const CHUNK_TOKENS = 8;      // ~tokens per chunk

function nowMs() { return performance.now(); }

// Local SSE server that streams a long completion in many small chunks so the
// provider's per-chunk read loop is the thing being measured.
async function startStreamServer() {
  const server = createServer((req, res) => {
    req.on('error', () => {});
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.statusCode = 404; res.end('{}'); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let i = 0;
    const id = `benchcmpl_${Math.random().toString(36).slice(2, 10)}`;
    const tick = setInterval(() => {
      if (i === 0) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Begin: ' }, finish_reason: null }] })}\n\n`);
      } else if (i <= CHUNKS) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'word '.repeat(CHUNK_TOKENS) }, finish_reason: null }] })}\n\n`);
      } else {
        clearInterval(tick);
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: CHUNKS * CHUNK_TOKENS, total_tokens: 10 + CHUNKS * CHUNK_TOKENS } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
      i++;
    }, 1); // 1ms between chunks = a fast, chatty stream
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  return { url: `http://127.0.0.1:${addr.port}/v1`, close: () => new Promise((r) => server.close(() => r())) };
}

async function measure(provider, messages) {
  const t0 = nowMs();
  let firstTokenMs = -1;
  let tokens = 0, reads = 0;
  for await (const chunk of provider.streamChat(messages, [])) {
    reads++;
    if (chunk.content && firstTokenMs < 0) firstTokenMs = nowMs() - t0;
    if (chunk.usage?.totalTokens) tokens = chunk.usage.totalTokens;
  }
  const dt = nowMs() - t0;
  return { firstTokenMs, reads, dtMs: dt, tokensPerSec: tokens / (dt / 1000) };
}

async function main() {
  const runs = 20;
  const fake = await startStreamServer();
  const provider = createOpenAIProvider({ baseUrl: fake.url, model: 'bench-model' });
  const messages = [{ role: 'user', content: 'Write a detailed response.' }];

  await measure(provider, messages); // warm the connection pool

  let totTok = 0, totFirst = 0, totReads = 0, s;
  for (let i = 0; i < runs; i++) {
    s = await measure(provider, messages);
    totTok += s.tokensPerSec; totFirst += s.firstTokenMs; totReads += s.reads;
  }
  await fake.close();

  const avgFirst = totFirst / runs, avgTok = totTok / runs, avgReads = totReads / runs;
  console.log(`\nstreaming micro-bench (${runs} runs, local SSE, ~${CHUNKS * CHUNK_TOKENS} tokens each)`);
  console.log(`  avg first token  : ${avgFirst.toFixed(2)} ms`);
  console.log(`  tokens/sec       : ${Math.round(avgTok)}`);
  console.log(`  reads/stream     : ${avgReads.toFixed(0)}`);
  return { avgFirst, avgTok, avgReads };
}

void main();