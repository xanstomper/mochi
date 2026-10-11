import type { ChatMessage, ModelResponse, StreamChunk, ToolDefinition } from '../types.js';
import { ProviderError, describeModelError, parseRetryAfter } from '../utils/http-error.js';
import { withRetries, classifyError } from './rate-limit.js';
import { nextKey, retireKey } from './credential-pool.js';
import { kvCache } from '../kv-cache.js';
import { nativeAssembleStream } from '../native/agent-protocol.js';

function logBackoff(attempt: number, delayMs: number, err: unknown): void {
  const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
  console.warn(`[rate-limit] model request backoff #${attempt}: sleeping ${Math.round(delayMs)}ms (${detail.slice(0, 80)})`);
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  providerName?: string;
}

function toOpenAITools(tools: ToolDefinition[]) {
  return tools.map((t, idx) => {
    const fn: any = {
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(t.parameters.map((p: ToolDefinition['parameters'][number]) => [p.name, { type: p.type, description: p.description }])),
          required: t.parameters.filter((p: ToolDefinition['parameters'][number]) => p.required).map((p: ToolDefinition['parameters'][number]) => p.name),
        },
      },
    };
    if (idx === tools.length - 1) {
      fn.cache_control = { type: 'ephemeral' };
    }
    return fn;
  });
}

// The tool schema list is stable for a given tools array across an agent run.
// Memoize the serialized payload so steady-state costs (JSON stringify + alloc)
// aren't repeated on every streaming request.
const toolSchemaCache = new WeakMap<ToolDefinition[], ReturnType<typeof toOpenAITools>>();

function openAITools(tools: ToolDefinition[]) {
  let cached = toolSchemaCache.get(tools);
  if (!cached) {
    cached = toOpenAITools(tools);
    toolSchemaCache.set(tools, cached);
  }
  return cached;
}

export function createOpenAIProvider(config: ProviderConfig) {
  const base = config.baseUrl.replace(/\/$/, '');
  const model = config.model;
  // Current key for this provider instance. Start with the configured key,
  // then rotate through the credential pool on 401/429 (Hermes insight).
  let apiKey = config.apiKey ?? null;
  if (!apiKey) {
    const pooled = nextKey(config.providerName ?? 'unknown', config.apiKey);
    apiKey = pooled.key;
  }

  /** Rotate to a fresh pool key; retire the failing one briefly. */
  function rotateCredentials(err: unknown): void {
    const status = (err as { status?: number }).status;
    // Only 401/403 (bad key) justify retiring; 429 (rate) just needs a fresh
    // key from a separate account/pool entry — retire that key too.
    if (status === 401 || status === 403 || status === 429) {
      retireKey(config.providerName ?? 'unknown', apiKey, status === 429 ? 20_000 : 120_000);
      const rotated = nextKey(config.providerName ?? 'unknown', config.apiKey);
      if (rotated.key) apiKey = rotated.key;
    }
  }

  // MCH-71 (speed): cache-aware message serializer. The transcript is
  // append-only across a run, so the mapped OpenAI payload for messages 0..N-1
  // is identical every turn. Keep the last mapped array + the source messages
  // it was derived from; on each request reuse the mapped prefix that matches
  // by reference identity and only serialize the new tail. Saves a full
  // O(messages) map + slice-scan per turn in long sessions.
  let lastMapped: { src: ChatMessage[]; out: Record<string, unknown>[] } | null = null;

  function mapMessages(messages: ChatMessage[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    let reuseLen = 0;
    if (lastMapped) {
      const max = Math.min(lastMapped.src.length, messages.length - 1); // tail must be fresh (cache_control on last)
      while (reuseLen < max && lastMapped.src[reuseLen] === messages[reuseLen]) reuseLen++;
      if (reuseLen > 0) {
        for (let i = 0; i < reuseLen; i++) out.push(lastMapped!.out[i]);
      }
    }
    for (let i = reuseLen; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content ?? '' });
        continue;
      }
      if (m.role === 'assistant' && m.tool_calls) {
        out.push({ role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls });
        continue;
      }
      // Some OpenAI-compatible models (observed: qwen3.6-35b on
      // freeinference.org) silently return an EMPTY response
      // (finish=stop, 0 completion tokens) when a `system` message appears
      // AFTER the user turn. Mochi appends runtime context (preflight,
      // focus nudges) as mid-conversation system messages, which reliably
      // killed those requests. Send mid-conversation system notices as
      // user-role text with explicit framing instead — same information,
      // compatible shape.
      const seenUserTurn = messages.slice(0, i).some((x) => x.role === 'user');
      if (m.role === 'system' && seenUserTurn) {
        out.push({ role: 'user', content: `[system notice] ${m.content ?? ''}` });
        continue;
      }
      const mapped: any = { role: m.role, content: m.content ?? '' };
      if (m.role === 'system') mapped.cache_control = { type: 'ephemeral' };
      // MCH-38 (speed): mark the LAST message so every turn's prefix is a
      // cache breakpoint — with an append-only transcript, turns N+1 reuse
      // turns 1..N from the provider prompt cache at ~10% of input cost.
      if (i === messages.length - 1) mapped.cache_control = { type: 'ephemeral' };
      out.push(mapped);
    }
    lastMapped = { src: messages.slice(), out };
    return out;
  }

  async function* streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model,
      messages: mapMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length ? { tools: openAITools(tools), tool_choice: 'auto' } : {}),
      ...(options?.temperature !== undefined && !/^(o1|o3|o4|deepseek-reasoner|deepseek-r1|r1)/i.test(model) ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined
        ? (/^(o1|o3|o4)/i.test(model) ? { max_completion_tokens: options.maxTokens } : { max_tokens: options.maxTokens })
        : {}),
      ...(() => {
        const isOpenAiNonReasoning = base.includes('api.openai.com') && !/^(o1|o3|o4|gpt-5)/i.test(model);
        if (isOpenAiNonReasoning) return {};
        const rawEffort = String((options as any)?.reasoningEffort || process.env.MOCHI_REASONING || '').toLowerCase().trim();
        if (rawEffort === 'off') {
          // Provider-level minimal reasoning: omit reasoning_effort AND ask the
          // endpoint to skip reasoning where supported (OpenRouter-style
          // reasoning.exclude / reasoning: { enabled: false } tolerant shape).
          return { reasoning_effort: 'low', reasoning: { enabled: false } } as any;
        }
        if (rawEffort === 'auto') {
          return {}; // model-default — send nothing
        }
        if (rawEffort === 'max' || rawEffort === 'extreme' || rawEffort === 'deep' || rawEffort === 'high' || rawEffort === 'hard') {
          return { reasoning_effort: 'high' };
        }
        if (rawEffort === 'medium') {
          return { reasoning_effort: 'medium' };
        }
        if (rawEffort === 'low' || rawEffort === 'easy') {
          return { reasoning_effort: 'low' };
        }
        return {};
      })(),
    };

    // A local AbortController, linked to the caller's signal, so BOTH the
    // request and (later) the watchdog stall guard can tear down the in-flight
    // stream. We reuse one signal so the caller's abort still works identically.
    const signal = new AbortController();
    const onAbort = () => signal.abort(options?.signal?.reason);
    if (options?.signal) {
      if (options.signal.aborted) signal.abort(options.signal.reason);
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const headerTimeoutRaw = Number(process.env.MOCHI_MODEL_HEADERS_TIMEOUT_MS);
    const headerTimeoutMs = Number.isFinite(headerTimeoutRaw) && headerTimeoutRaw > 0
      ? Math.max(100, headerTimeoutRaw)
      : 45_000;
    const headerTimer = setTimeout(() => signal.abort(new Error(`Model response headers stalled for ${headerTimeoutMs}ms`)), headerTimeoutMs);

    // Rate-limit + transient-failure safe fetch: only the request is retried
    // (never mid-stream), with exponential backoff honoring Retry-After.
    const res = await withRetries(async () => {
      try {
        const r = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: signal.signal,
        } as RequestInit);
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw describeModelError(r.status, text, model, 'opencode/OpenAI-compatible', parseRetryAfter(r.headers.get('retry-after')));
        }
        if (!r.body) throw new Error('No response body from model');
        return r;
      } catch (err) {
        if (signal.signal.aborted) {
          if (options?.signal?.aborted) throw options.signal.reason ?? err;
          throw new ProviderError(err instanceof Error ? err.message : String(err), { retryable: false, cause: err });
        }
        // Network/transport errors carry no status; let the classifier decide
        // whether this is transient (retry) or permanent (host refused / bad DNS).
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(err instanceof Error ? err.message : String(err), { retryable: classifyError(err).retryable, cause: err });
      }
    }, {
      maxAttempts: 4,
      onBackoff: (attempt, delayMs, err) => logBackoff(attempt, delayMs, err),
      // Rotate to a fresh pool key (401/403/429) before the next attempt.
      onRetryable: (_attempt, err) => rotateCredentials(err),
    }).catch((err: unknown) => {
      options?.signal?.removeEventListener('abort', onAbort);
      throw err;
    }).finally(() => clearTimeout(headerTimer));

    if (!res.body) throw new ProviderError('No response body from model', { retryable: true });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalInput = 0;
    let totalOutput = 0;

    // Watchdog stall guard: ONE reusable timer (not a fresh Promise + setTimeout
    // per .read()). The stream is read bare-fast with zero per-read allocation,
    // and the timer aborts the request only when the stream has been silent for
    // STALL_TIMEOUT_MS. This measurably raises token throughput on chatty
    // providers vs. a Promise.race around every chunk.
    const STALL_TIMEOUT_MS = 30_000;
    let lastChunkAt = Date.now();
    let stalled = false;
    const stallInterval = setInterval(() => {
      if (!stalled && Date.now() - lastChunkAt >= STALL_TIMEOUT_MS) {
        stalled = true;
        signal.abort(); // tear down the still-open stream now, not after read
      }
    }, 2000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastChunkAt = Date.now();
        buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        if (!data) continue;
        try {
          const chunk = JSON.parse(data);
          const choice = chunk.choices?.[0];
          const delta = choice?.delta ?? {};
          const toolCalls = delta.tool_calls;
          const reasoningContent = delta.reasoning_content ?? delta.reasoning ?? delta.thought ?? undefined;
          const parsedCalls: StreamChunk['toolCalls'] = [];
          if (toolCalls && Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              parsedCalls.push({
                id: tc.id ?? `call_${Date.now()}`,
                index: typeof tc.index === 'number' ? tc.index : undefined,
                type: 'function',
                function: {
                  name: tc.function?.name ?? '',
                  arguments: tc.function?.arguments ?? '',
                },
              });
            }
          }
          if (chunk.usage) {
            totalInput = chunk.usage.prompt_tokens ?? totalInput;
            totalOutput = chunk.usage.completion_tokens ?? totalOutput;
            // Feed the KV-cache tracker: recognize OpenAI prompt_tokens_details.cached_tokens,
            // prompt_cache_hit_tokens (DeepSeek), Anthropic cache_read, and Gemini cached_content.
            const usageAny = chunk.usage as unknown as Record<string, unknown>;
            const details = usageAny.prompt_tokens_details as Record<string, unknown> | undefined;
            const cacheRead =
              typeof details?.cached_tokens === 'number' ? details.cached_tokens
              : typeof usageAny.prompt_cache_hit_tokens === 'number' ? usageAny.prompt_cache_hit_tokens
              : typeof usageAny.cached_tokens === 'number' ? usageAny.cached_tokens
              : typeof usageAny.cacheReadTokens === 'number' ? usageAny.cacheReadTokens
              : typeof usageAny.cache_read_input_tokens === 'number' ? usageAny.cache_read_input_tokens
              : typeof usageAny.cached_content_token_count === 'number' ? usageAny.cached_content_token_count
              : 0;
            if (cacheRead > 0) kvCache.recordUsage({ cacheReadTokens: cacheRead, promptTokens: totalInput });
          }
          yield {
            content: delta.content ?? undefined,
            reasoningContent: typeof reasoningContent === 'string' && reasoningContent.length > 0 ? reasoningContent : undefined,
            toolCalls: parsedCalls.length ? parsedCalls : undefined,
            finishReason: choice?.finish_reason,
            usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
          };
        } catch {
          // ignore malformed lines
        }
      }
      }
    } finally {
      clearInterval(stallInterval);
      options?.signal?.removeEventListener('abort', onAbort);
      // Consumer return() also reaches here: stop the underlying request,
      // not just the generator, when a loop guard cuts generation short.
      signal.abort();
      try {
        await reader.cancel();
      } catch {
        // An aborted or errored transport may already have closed the reader.
      } finally {
        reader.releaseLock();
      }
    }
  }

  async function chat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }): Promise<ModelResponse> {
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamChat(messages, tools, options)) {
      chunks.push(chunk);
    }
    // Native assembly: hand the whole normalized chunk stream to the Rust
    // runtime for the Map-fold (1 stdio round-trip, off the JS hot path).
    // Falls back to the inlined TS fold when the runtime is unavailable.
    const native = await nativeAssembleStream(chunks as unknown as Record<string, unknown>[]).catch(() => null);
    if (native) {
      const tool_calls = native.toolCalls.map((a) => ({ id: a.id, type: 'function' as const, function: { name: a.name, arguments: a.arguments } }));
      return {
        content: native.content,
        reasoningContent: native.reasoning || undefined,
        toolCalls: tool_calls.length ? tool_calls : undefined,
        finishReason: native.finishReason ?? chunks[chunks.length - 1]?.finishReason,
        usage: { promptTokens: native.promptTokens, completionTokens: native.completionTokens, totalTokens: native.promptTokens + native.completionTokens },
      };
    }
    const content = chunks.map((c) => c.content || '').join('');
    const reasoningContent = chunks.map((c) => c.reasoningContent || '').join('') || undefined;
    const callsByIndex = new Map<number, ToolCallAccum>();
    for (const chunk of chunks) {
      if (chunk.toolCalls) {
        for (const tc of chunk.toolCalls) {
          const idx = tc.index ?? 0;
          const acc = callsByIndex.get(idx) ?? { id: tc.id, name: tc.function.name, args: '' };
          acc.name = acc.name || tc.function.name;
          acc.args += tc.function.arguments;
          callsByIndex.set(idx, acc);
        }
      }
    }
    const tool_calls = [...callsByIndex.values()].map((a) => ({ id: a.id, type: 'function' as const, function: { name: a.name, arguments: a.args } }));
    const usage = chunks[chunks.length - 1]?.usage;
    return {
      content,
      reasoningContent,
      toolCalls: tool_calls.length ? tool_calls : undefined,
      finishReason: chunks[chunks.length - 1]?.finishReason,
      usage,
    };
  }

  return { streamChat, chat };
}

type ToolCallAccum = { id: string; name: string; args: string };
