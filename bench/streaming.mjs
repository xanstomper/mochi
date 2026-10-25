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
// MODE=chatty (default): 1ms between chunks — a fast, chatty stream; the
// pacing itself caps tokens/sec, so use it for TTFT.
// MODE=burst: the whole SSE body is written AT ONCE — the measured drain
// rate is then MOCHI'S OWN read/parse loop, not the mock's pacing.
const MODE = process.env.MODE ?? 'chatty';

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
    const id = `benchcmpl_${Math.random().toString(36).slice(2, 10)}`;
    const frame = (content, extra = {}) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: content !== null ? { content } : {}, finish_reason: null }], ...extra })}\n\n`;
    if (MODE === 'burst') {
      const parts = [frame('Begin: ')];
      for (let i = 0; i < CHUNKS; i++) parts.push(frame('word '.repeat(CHUNK_TOKENS)));
      parts.push(frame(null, { usage: { prompt_tokens: 10, completion_tokens: CHUNKS * CHUNK_TOKENS, total_tokens: 10 + CHUNKS * CHUNK_TOKENS } }));
      parts.push('data: [DONE]\n\n');
      res.end(parts.join(''));
      return;
    }
    let i = 0;
    const tick = setInterval(() => {
      if (i === 0) {
        res.write(frame('Begin: '));
      } else if (i <= CHUNKS) {
        res.write(frame('word '.repeat(CHUNK_TOKENS)));
      } else {
        clearInterval(tick);
        res.write(frame(null, { usage: { prompt_tokens: 10, completion_tokens: CHUNKS * CHUNK_TOKENS, total_tokens: 10 + CHUNKS * CHUNK_TOKENS } }));
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
  let lastAt = -1;
  const gaps = [];
  let tokens = 0, reads = 0;
  for await (const chunk of provider.streamChat(messages, [])) {
    reads++;
    const at = nowMs();
    if (chunk.content && firstTokenMs < 0) firstTokenMs = at - t0;
    if (lastAt >= 0) gaps.push(at - lastAt);
    lastAt = at;
    if (chunk.usage?.totalTokens) tokens = chunk.usage.totalTokens;
  }
  const dt = nowMs() - t0;
  const pct = (p) => gaps.length ? [...gaps].sort((a, b) => a - b)[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] : 0;
  return {
    firstTokenMs, reads, dtMs: dt, tokensPerSec: tokens / (dt / 1000),
    gapP50: pct(0.5), gapP95: pct(0.95), gapMax: gaps.length ? Math.max(...gaps) : 0,
  };
}

async function main() {
  const runs = 20;
  const fake = await startStreamServer();
  const provider = createOpenAIProvider({ baseUrl: fake.url, model: 'bench-model' });
  const messages = [{ role: 'user', content: 'Write a detailed response.' }];

  await measure(provider, messages); // warm the connection pool

  let totTok = 0, totFirst = 0, totReads = 0, totG50 = 0, totG95 = 0, s;
  const samples = [];
  for (let i = 0; i < runs; i++) {
    s = await measure(provider, messages);
    samples.push(s);
    totTok += s.tokensPerSec; totFirst += s.firstTokenMs; totReads += s.reads; totG50 += s.gapP50; totG95 += s.gapP95;
  }
  await fake.close();

  const avgFirst = totFirst / runs, avgTok = totTok / runs, avgReads = totReads / runs;
  console.log(`\nstreaming micro-bench (${runs} runs, local SSE, mode=${MODE}, ~${CHUNKS * CHUNK_TOKENS} tokens each)`);
  console.log(`  avg first token  : ${avgFirst.toFixed(2)} ms`);
  console.log(`  tokens/sec       : ${Math.round(avgTok)}`);
  console.log(`  reads/stream     : ${avgReads.toFixed(0)}`);
  console.log(`  inter-token p50  : ${(totG50 / runs).toFixed(3)} ms`);
  console.log(`  inter-token p95  : ${(totG95 / runs).toFixed(3)} ms`);
  const worst = samples.reduce((a, b) => (b.dtMs > a.dtMs ? b : a));
  console.log(`  worst stream     : ${worst.dtMs.toFixed(1)}ms total, gap max ${worst.gapMax.toFixed(2)}ms`);
  return { avgFirst, avgTok, avgReads, samples };
}

void main();