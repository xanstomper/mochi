import type { ChatMessage, ModelResponse, StreamChunk, ToolDefinition } from '../types.js';
import { contentText, splitContent } from '../types.js';
import type { ProviderConfig } from './router.js';
import { ProviderError, describeModelError, parseRetryAfter } from '../utils/http-error.js';
import { withRetries, classifyError } from './rate-limit.js';
import { openSSEStream } from './sse.js';

function logBackoff(attempt: number, delayMs: number, err: unknown): void {
  const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
  console.warn(`[rate-limit] model request backoff #${attempt}: sleeping ${Math.round(delayMs)}ms (${detail.slice(0, 80)})`);
}

type AnthropicBlock = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
type UsageCounts = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };

/** Wire shape of an Anthropic `message` object (both /messages JSON and the
 *  message_start event's embedded message). */
type AnthropicMessage = {
  content?: AnthropicBlock[];
  usage?: UsageCounts;
  stop_reason?: string;
};

/** Loose shape of a streamed Anthropic SSE event (message_start,
 *  content_block_delta, message_delta, message_stop, error, …). */
type StreamEvent = {
  type?: string;
  index?: number;
  message?: { usage?: UsageCounts };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: UsageCounts;
  error?: { message?: string } | string;
};

/** Map Anthropic stop reasons onto the StreamChunk finish-reason union. */
const STREAM_STOP: Record<string, StreamChunk['finishReason']> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  pause_turn: 'stop',
  refusal: 'stop',
};

/** Normalize a full (non-stream) API message into ModelResponse shape.
 *  Shared by chat() and streamChat's non-SSE fallback so both paths extract
 *  content/reasoning/tool-calls/usage identically. */
function extract(data: AnthropicMessage): ModelResponse {
  const blocks = data.content ?? [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const thinkingBlocks = blocks.filter((b) => b.type === 'thinking');
  const reasoningText = thinkingBlocks.map((b) => b.thinking).filter(Boolean).join('\n');
  const toolUses = blocks.filter((b) => b.type === 'tool_use');
  const toolCalls = toolUses.map((b: any) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const usage = data.usage ? { promptTokens: data.usage.input_tokens ?? 0, completionTokens: data.usage.output_tokens ?? 0, totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0), cachedTokens: data.usage.cache_read_input_tokens ?? 0 } : undefined;
  return { content: text, reasoningContent: reasoningText || undefined, toolCalls: toolCalls.length ? toolCalls : undefined, finishReason: data.stop_reason, usage };
}

export function createAnthropicProvider(config: ProviderConfig) {
  const base = config.baseUrl.replace(/\/$/, '');
  const model = config.model;

  // Prompt-cache breakpoints (mirrors the OpenAI mapper's MCH-38 pattern):
  // the system prompt is byte-stable across turns, so mark it as one cached
  // prefix block. Without this Anthropic bills every turn at full input price
  // (~5KB system prompt × every iteration). String form when empty preserves
  // the old wire shape exactly.
  const sysText = (msgs: ChatMessage[]) => msgs.filter((m) => m.role === 'system').map((m) => contentText(m)).join('\n');
  const sysMsg = (msgs: ChatMessage[]) => {
    const text = sysText(msgs);
    if (!text) return undefined;
    return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
  };
  const bodyMsg = (m: ChatMessage) => {
    if (m.role === 'system') return null;
    if (m.role === 'tool') {
      if (!m.tool_call_id) {
        return {
          role: 'user',
          content: [{ type: 'text', text: `[tool output: ${m.name || 'tool'}] ${contentText(m)}` }],
        };
      }
      // Wave H3: image parts in a tool result (computer screenshots) ride
      // INSIDE the tool_result as a block array — Anthropic's native
      // multimodal tool-result shape. Text-only results keep the exact
      // pre-H3 string form.
      const { text, images } = splitContent(m.content);
      if (images.length === 0) {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.tool_call_id,
              content: text,
            },
          ],
        };
      }
      const blocks: Array<{ type: string; text?: string; source?: unknown }> = [{ type: 'text', text }];
      for (const img of images) {
        if ('data' in img) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
        } else {
          blocks.push({ type: 'image', source: { type: 'url', url: img.url } });
        }
      }
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: blocks,
          },
        ],
      };
    }
    if (m.role === 'assistant' && m.tool_calls) {
      const contentBlocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> = [];
      const text = contentText(m);
      if (text) contentBlocks.push({ type: 'text', text });
      for (const tc of m.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch {}
        contentBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      return { role: 'assistant', content: contentBlocks };
    }
    // Multimodal user turn: text + native image blocks. Data URIs become
    // base64 image sources; remote URLs use Anthropic's url source.
    const { text, images } = splitContent(m.content);
    if (images.length > 0) {
      const parts: Array<{ type: string; text?: string; source?: unknown }> = [];
      if (text) parts.push({ type: 'text', text });
      for (const img of images) {
        if ('data' in img) {
          parts.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
        } else {
          parts.push({ type: 'image', source: { type: 'url', url: img.url } });
        }
      }
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: text };
  };

  /** Build the /messages request body. `stream` flips the wire flag so the
   *  same mapping feeds both chat() (JSON one-shot) and streamChat() (SSE). */
  function buildBody(messages: ChatMessage[], tools: ToolDefinition[], options: { reasoningEffort?: string } | undefined, stream: boolean): Record<string, unknown> {
    const reasoning = ((options?.reasoningEffort || process.env.MOCHI_REASONING) || '').toLowerCase();
    const supportsThinking = /(3-7|3\.7|opus-4|sonnet-4|claude-4)/i.test(model);
    const thinkingBudget = supportsThinking
      ? ((reasoning === 'max' || reasoning === 'extreme' || reasoning === 'deep') ? 32768
        : (reasoning === 'high' || reasoning === 'hard') ? 16384
        : (reasoning === 'medium') ? 4096 : 0)
      : 0;

    const rawMsgs = messages.map(bodyMsg).filter(Boolean) as Array<{ role: string; content: any }>;
    const mergedMsgs: Array<{ role: string; content: any }> = [];
    for (const m of rawMsgs) {
      const prev = mergedMsgs[mergedMsgs.length - 1];
      if (prev && prev.role === m.role) {
        const prevContent = Array.isArray(prev.content)
          ? prev.content
          : typeof prev.content === 'string'
            ? [{ type: 'text', text: prev.content }]
            : [prev.content];
        const newContent = Array.isArray(m.content)
          ? m.content
          : typeof m.content === 'string'
            ? [{ type: 'text', text: m.content }]
            : [m.content];
        prev.content = [...prevContent, ...newContent];
      } else {
        mergedMsgs.push(m);
      }
    }

    return {
      model,
      max_tokens: thinkingBudget > 0 ? Math.max(16384, thinkingBudget + 4096) : 8192,
      system: sysMsg(messages) || undefined,
      messages: mergedMsgs,
      stream,
      ...(thinkingBudget > 0 ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } : {}),
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: { type: 'object', properties: Object.fromEntries(t.parameters.map((p) => [p.name, { type: p.type, description: p.description }])), required: t.parameters.filter((x) => x.required).map((x) => x.name) } })) } : {}),
    };
  }

  async function chat(messages: ChatMessage[], tools: ToolDefinition[], options?: { reasoningEffort?: string }): Promise<ModelResponse> {
    const body = buildBody(messages, tools, options, false);
    const res = await withRetries(async () => {
      try {
        const r = await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey ?? '', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const text = await r.text();
          throw describeModelError(r.status, text, model, 'Anthropic', parseRetryAfter(r.headers.get('retry-after')));
        }
        return r;
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(err instanceof Error ? err.message : String(err), { retryable: classifyError(err).retryable, cause: err });
      }
    }, { maxAttempts: 4, onBackoff: (attempt, delayMs, err) => logBackoff(attempt, delayMs, err) });
    return extract(await res.json() as AnthropicMessage);
  }

  async function* streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { signal?: AbortSignal; reasoningEffort?: string }): AsyncGenerator<StreamChunk> {
    const body = buildBody(messages, tools, options, true);
    // Running usage: message_start carries input tokens, message_delta
    // carries the final output tokens — mirrored on every yielded chunk the
    // same way openai.ts exposes usage (incl. prompt-cache reads).
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let stop: StreamChunk['finishReason'] | undefined;
    // Content blocks by index: tool_use ids/names arrive at block start, the
    // JSON arguments stream as input_json_delta frames.
    const blocks = new Map<number, { id?: string; name?: string }>();
    const usageNow = (): NonNullable<StreamChunk['usage']> => ({
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
    });

    const frames = openSSEStream(
      (signal) => fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey ?? '', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal,
      } as RequestInit),
      { signal: options?.signal, model, provider: 'Anthropic' },
    );

    for await (const frame of frames) {
      if (frame.kind === 'json') {
        // Non-SSE fallback (plain-JSON gateway): emit the whole response as
        // a single chunk, exactly like the pre-streaming behavior.
        const resp = extract(frame.data as AnthropicMessage);
        yield { content: resp.content, reasoningContent: resp.reasoningContent, toolCalls: resp.toolCalls, finishReason: resp.finishReason as StreamChunk['finishReason'], usage: resp.usage };
        return;
      }
      let ev: StreamEvent;
      try {
        ev = JSON.parse(frame.data) as StreamEvent;
      } catch {
        continue; // ignore malformed frames (openai.ts convention)
      }
      switch (ev.type ?? frame.event) {
        case 'message_start': {
          const u = ev.message?.usage;
          if (u) {
            inputTokens = u.input_tokens ?? inputTokens;
            outputTokens = u.output_tokens ?? outputTokens;
            cacheReadTokens = u.cache_read_input_tokens ?? cacheReadTokens;
          }
          break;
        }
        case 'content_block_start': {
          const idx = ev.index ?? 0;
          const cb = ev.content_block ?? {};
          if (cb.type === 'tool_use') {
            blocks.set(idx, { id: cb.id, name: cb.name });
            // Announce the call up-front (id/name are known at block start);
            // arguments stream in as input_json_delta frames and consumers
            // stitch by index, openai-style.
            yield { toolCalls: [{ id: cb.id ?? '', index: idx, type: 'function', function: { name: cb.name ?? '', arguments: '' } }], usage: usageNow() };
          } else {
            blocks.set(idx, {});
          }
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta;
          if (!d) break;
          if (d.type === 'text_delta' && d.text) {
            yield { content: d.text, usage: usageNow() };
          } else if (d.type === 'thinking_delta' && d.thinking) {
            yield { reasoningContent: d.thinking, usage: usageNow() };
          } else if (d.type === 'input_json_delta' && d.partial_json) {
            const st = blocks.get(ev.index ?? 0);
            yield {
              toolCalls: [{ id: st?.id ?? '', index: ev.index ?? 0, type: 'function', function: { name: st?.name ?? '', arguments: d.partial_json } }],
              usage: usageNow(),
            };
          }
          break; // signature_delta / citations_delta carry no consumer output
        }
        case 'message_delta': {
          const u = ev.usage;
          if (u) {
            outputTokens = u.output_tokens ?? outputTokens;
            cacheReadTokens = u.cache_read_input_tokens ?? cacheReadTokens;
          }
          if (ev.delta?.stop_reason) stop = STREAM_STOP[ev.delta.stop_reason] ?? 'stop';
          break;
        }
        case 'message_stop': {
          yield { finishReason: stop ?? 'stop', usage: usageNow() };
          return;
        }
        case 'error': {
          const detail = typeof ev.error === 'string' ? ev.error : ev.error?.message ?? 'unknown stream error';
          throw new ProviderError(`Anthropic stream error: ${detail}`, { retryable: false });
        }
        default:
          break; // ping / content_block_stop / unknown events carry no deltas
      }
    }
    // Stream closed without message_stop: surface whatever accumulated so
    // usage/finishReason still reach the consumer instead of being lost.
    yield { finishReason: stop, usage: usageNow() };
  }

  return { chat, streamChat };
}