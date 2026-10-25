// Failover latency table (P2 speed, queue item 7 / task 4).
//
// Measures the REAL production failover machinery (model/router.ts
// withFailover — the exact function createProvider wires at line 69 — over
// the REAL openai provider, model/openai.ts) against local mock endpoints,
// so every cell is a measurement of MOCHI'S OWN logic, not network weather.
// All keys are dummies; no credential is read or sent anywhere but localhost.
//
// Failure classes, per the provider's own classifier (model/rate-limit.ts):
//   http-429 (Retry-After honored), http-429 (no header -> exponential
//   backoff), http-503 (transient), http-401 (fatal), conn-refused (fatal),
//   mid-stream drop (router policy: NEVER replay onto another provider).
// Plus the model-router.ts promise-level withFailover (retry + exponential
// backoff + cascade) at its production defaults.
//
// Run:  npm run bench:failover
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createOpenAIProvider } from '../src/model/openai.js';
import { withFailover } from '../src/model/router.js';
import { withFailover as withPromiseFailover } from '../src/model/model-router.js';

const RUNS = Number(process.env.N ?? 5);
const CHAT_TOKENS = 8;

function nowMs() { return performance.now(); }

// ── mock SSE endpoints ──────────────────────────────────────────────────────
function sseChunk(id, content, extra = {}) {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: content !== null ? { content } : {}, finish_reason: null }], ...extra })}\n\n`;
}

async function startMockServer() {
  const server = createServer((req, res) => {
    req.on('error', () => {});
    const fail = (status, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ error: { message: `mock ${status} failure`, type: 'mock' } }));
    };
    if ((req.url ?? '').startsWith('/ok')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const id = `mockok_${Math.random().toString(36).slice(2, 8)}`;
      let i = 0;
      const tick = setInterval(() => {
        i++;
        if (i === 1) res.write(sseChunk(id, 'Hello '));
        else if (i <= CHAT_TOKENS) res.write(sseChunk(id, 'token '));
        else {
          clearInterval(tick);
          res.write(sseChunk(id, null, { usage: { prompt_tokens: 5, completion_tokens: CHAT_TOKENS, total_tokens: 5 + CHAT_TOKENS } }));
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 1);
      return;
    }
    if ((req.url ?? '').startsWith('/r429nh')) return fail(429);
    if ((req.url ?? '').startsWith('/r429')) return fail(429, { 'retry-after': '0.1' });
    if ((req.url ?? '').startsWith('/r503')) return fail(503);
    if ((req.url ?? '').startsWith('/r401')) return fail(401);
    if ((req.url ?? '').startsWith('/drop-midstream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = `mockdrop_${Math.random().toString(36).slice(2, 8)}`;
      res.write(sseChunk(id, 'partial '));
      res.write(sseChunk(id, 'output '));
      setTimeout(() => { res.destroy(); }, 15); // die mid-stream
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

// A closed port for the conn-refused class.
async function closedPort() {
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

// ── measurement ──────────────────────────────────────────────────────────────
const MESSAGES = [{ role: 'user', content: 'bench' }];

/** Wrap a provider so the exact failover-dispatch moment is observable. */
function instrumented(provider, probe) {
  return {
    providerName: 'bench-ok',
    streamChat: async function* (messages, tools, options) {
      probe.dispatchAt = nowMs();
      yield* provider.streamChat(messages, tools, options);
    },
    chat: async (messages, tools, options) => {
      probe.dispatchAt = nowMs();
      return provider.chat(messages, tools, options);
    },
  };
}

async function measureChainOnce(primaryUrl) {
  const okProvider = createOpenAIProvider({ baseUrl: BASE.url + '/ok', model: 'bench-ok-model', apiKey: 'bench-dummy' });
  const probe = {};
  const chain = withFailover([
    createOpenAIProvider({ baseUrl: primaryUrl, model: 'bench-primary', apiKey: 'bench-dummy' }),
    instrumented(okProvider, probe),
  ], 'bench-primary');
  const t0 = nowMs();
  let firstTokenAt = -1;
  let sawFailover = false;
  let error = null;
  try {
    for await (const chunk of chain.streamChat(MESSAGES, [])) {
      if (chunk.content && firstTokenAt < 0) firstTokenAt = nowMs();
    }
  } catch (e) { error = e; }
  return {
    ok: !error,
    error: error ? String(error.message).split('\n')[0].slice(0, 90) : null,
    dispatchAt: probe.dispatchAt ?? null,
    t0,
    firstTokenAt,
  };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const BASE = await startMockServer();
const REFUSED = await closedPort();
const ROWS = [
  { route: 'baseline (healthy primary, no failover)', url: `${BASE.url}/ok` },
  { route: 'http-429, Retry-After 0.1s', url: `${BASE.url}/r429` },
  { route: 'http-429, no Retry-After (exp backoff)', url: `${BASE.url}/r429nh` },
  { route: 'http-503 (transient)', url: `${BASE.url}/r503` },
  { route: 'http-401 (fatal)', url: `${BASE.url}/r401` },
  { route: 'conn-refused (fatal)', url: REFUSED },
  { route: 'mid-stream drop', url: `${BASE.url}/drop-midstream` },
];

console.log(`\nfailover latency table — model/router.ts withFailover over model/openai.ts streamChat`);
console.log(`${RUNS} runs per row, local mock endpoints, node ${process.version}\n`);
console.log('route'.padEnd(44) + 'ttf (ms)'.padStart(10) + 'ttft-after (ms)'.padStart(17) + 'e2e ttft (ms)'.padStart(14) + '  outcome');

const TABLE = [];
for (const row of ROWS) {
  const tfts = [], ttfts = [], e2es = [];
  let outcome = 'failover->bench-ok';
  let lastErr = null;
  let failovered = false;
  for (let i = 0; i < RUNS; i++) {
    const r = await measureChainOnce(row.url);
    if (!r.ok) {
      outcome = `NO failover — rethrown: ${r.error}`;
      lastErr = r.error;
      continue;
    }
    if (r.dispatchAt != null) {
      failovered = true;
      tfts.push(r.dispatchAt - r.t0);
      ttfts.push(r.firstTokenAt - r.dispatchAt);
    } else {
      outcome = 'no failover needed (primary served)';
    }
    e2es.push(r.firstTokenAt - r.t0);
  }
  if (row.route.startsWith('mid-stream') && !failovered && lastErr) {
    outcome = 'no failover (by design: never replay mid-stream)';
  }
  const cell = (arr) => (arr.length ? median(arr).toFixed(1) : 'UNMEASURED');
  console.log(row.route.padEnd(44) + cell(tfts).padStart(10) + cell(ttfts).padStart(17) + cell(e2es).padStart(14) + `  ${outcome}`);
  TABLE.push({ route: row.route, timeToFailoverMs: tfts.length ? +cell(tfts) : 'UNMEASURED', ttftAfterFailoverMs: ttfts.length ? +cell(ttfts) : 'UNMEASURED', e2eTtftMs: e2es.length ? +cell(e2es) : 'UNMEASURED', outcome });
}

// ── model-router.ts promise-level failover (production retry defaults) ──────
console.log(`\nmodel-router.ts withFailover (promise tier, production defaults: 3 retries, 1s×2 backoff)`);
const pTable = [];
for (const [label, makeErr, retriable] of [
  ['http-429 (rate limit)', () => Object.assign(new Error('429 rate limit exceeded'), { status: 429 }), true],
  ['non-retriable error', () => Object.assign(new Error('invalid api key'), { status: 401 }), false],
]) {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    let failoverDispatchAt = null;
    const t0 = nowMs();
    await withPromiseFailover(
      { provider: 'bench-primary', model: 'm', failover: [{ provider: 'bench-ok', model: 'm' }] },
      'standard',
      async (cfg) => {
        if (cfg.provider === 'bench-primary') throw makeErr();
        failoverDispatchAt = nowMs();
        return 'done';
      },
      retriable ? {} : { maxRetries: 0, initialDelayMs: 0 },
    );
    times.push((failoverDispatchAt - t0));
  }
  console.log(`  ${label.padEnd(42)} time-to-failover: median ${median(times).toFixed(1)}ms over ${RUNS} runs`);
  pTable.push({ class: label, timeToFailoverMs: +median(times).toFixed(1) });
}

await BASE.close();
console.log('\nJSON:\n' + JSON.stringify({ streamChain: TABLE, promiseRouter: pTable }, null, 1));
