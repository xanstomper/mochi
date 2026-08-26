/**
 * Shared OpenAI-compatible **SSE encoder** — the real wire-protocol half of
 * `StreamParser`.
 *
 * `StreamParser` (in `stream-parser.ts`) is the *inbound* half: it consumes
 * `data:` lines and folds them into `CompactEvent`s. Until now the matching
 * *outbound* half lived ONLY inside the test harness (`src/testutil/fake-openai.ts`),
 * whose `toSSEChunk`/response assembly hand-rolled the wire framing. That meant
 * the one and only place that knew how to emit the protocol was test code, so
 * production and tests could silently drift.
 *
 * This module makes the encoder real and shared. Both the production provider
 * (for parity / re-emission) and the test server (for scripted scenarios) build
 * the exact same byte-level OpenAI SSE the real `StreamParser` decodes:
 *
 *   data: {"id":..., "object":"chat.completion.chunk", "choices":[...]}\n\n
 *   data: [DONE]\n\n
 *
 * `buildChatCompletion` is the single source of truth for the chunk graph a
 * model reply is split into (unordered delta / ordered-looking content / the
 * terminal chunk carrying finish_reason + usage), so the protocol knowledge is
 * not duplicated anywhere.
 */

/** Frame one payload as a single SSE `data:` event. */
export function encodeSSEChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The end-of-stream marker. */
export function encodeSSEDone(): string {
  return 'data: [DONE]\n\n';
}

export interface SSEUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Usage as it appears on the wire (snake_case, per the OpenAI contract). */
export interface SSEWireUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface SSEToolCall {
  /** Tool call identity (e.g. `call_1`). */
  id: string;
  /** Function name. */
  name: string;
  /** Serialized arguments, emitted as one delta on the call's single chunk. */
  arguments: string;
}

/** A single streaming chunk object (the `data:` payload). */
export interface SSEChunk {
  id: string;
  object: 'chat.completion.chunk';
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
  usage?: SSEWireUsage;
}

/** Build one content-delta chunk (content is split across these in practice). */
export function buildContentChunk(
  id: string,
  content: string,
): string {
  const chunk: SSEChunk = {
    id,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  };
  return encodeSSEChunk(chunk);
}

/** Build one tool-call chunk. Each call gets a DISTINCT `index` so the
 *  parser's per-index accumulator keeps it a separate call even though the
 *  arguments are emitted in a single (non-sliced) delta. */
export function buildToolCallChunk(
  id: string,
  call: SSEToolCall,
  index: number,
): string {
  const chunk: SSEChunk = {
    id,
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index,
          id: call.id,
          function: { name: call.name, arguments: call.arguments },
        }],
      },
      finish_reason: null,
    }],
  };
  return encodeSSEChunk(chunk);
}

/** Build the terminal chunk that carries the finish reason and usage counters. */
export function buildFinishChunk(
  id: string,
  usage: SSEUsage,
  finishReason: string,
): string {
  const chunk: SSEChunk = {
    id,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    },
  };
  return encodeSSEChunk(chunk);
}

/** Assemble a full model reply as a complete SSE body (everything up to —
 *  but not including — the [DONE] marker). Content is split across chunks the
 *  way real providers do; tool calls each get their own chunk with a unique
 *  `index`. */
export function buildChatCompletion(params: {
  id?: string;
  content?: string;
  toolCalls?: SSEToolCall[];
  finishReason?: string;
  usage?: SSEUsage;
}): string {
  const id = params.id ?? randomChunkId();
  const content = params.content ?? '';
  const toolCalls = params.toolCalls ?? [];
  const finishReason = params.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop');

  const completionTokens = params.usage?.completionTokens
    ?? (content ? Math.max(1, Math.ceil(content.length / 4)) : 0);
  const promptTokens = params.usage?.promptTokens ?? 1;
  const usage: SSEUsage = {
    promptTokens,
    completionTokens,
    totalTokens: params.usage?.totalTokens ?? promptTokens + completionTokens,
  };

  const out: string[] = [];
  if (toolCalls.length) {
    toolCalls.forEach((call, i) => out.push(buildToolCallChunk(id, call, i)));
  } else if (content) {
    const halves = [content.slice(0, Math.ceil(content.length / 2)), content.slice(Math.ceil(content.length / 2))];
    for (const part of halves) {
      if (!part) continue;
      out.push(buildContentChunk(id, part));
    }
  }
  out.push(buildFinishChunk(id, usage, finishReason));
  return out.join('');
}

/** Random chunk id in the same shape real providers return. */
export function randomChunkId(): string {
  return `chatcmpl_${Math.random().toString(36).slice(2, 10)}`;
}