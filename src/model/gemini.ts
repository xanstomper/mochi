import type { ChatMessage, ModelResponse, StreamChunk, ToolDefinition } from '../types.js';
import { contentText, splitContent } from '../types.js';
import type { ProviderConfig } from './router.js';
import { ProviderError, describeModelError, parseRetryAfter } from '../utils/http-error.js';
import { withRetries, classifyError } from './rate-limit.js';
import { openSSEStream } from './sse.js';

export function logBackoff(attempt: number, delayMs: number, err: unknown): void {
  const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
  console.warn(`[rate-limit] model request backoff #${attempt}: sleeping ${Math.round(delayMs)}ms (${detail.slice(0, 80)})`);
}

/** Wire shape of a Gemini GenerateContentResponse (single JSON body or one
 *  SSE `data:` frame of streamGenerateContent). */
export type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name: string; args?: unknown } }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number };
};

/** Map Gemini finish reasons onto the StreamChunk finish-reason union.
 *  (SAFETY/RECITATION/OTHER have no dedicated union value — collapse.) */
export function mapGeminiFinish(reason: string): StreamChunk['finishReason'] {
  if (reason === 'MAX_TOKENS') return 'length';
  return 'stop';
}

/** Merge a non-SSE streamGenerateContent reply (a JSON array of incremental
 *  chunks) into one GenerateContentResponse-shaped body for extract(). */
function mergeGeminiChunks(arr: GeminiResponse[]): GeminiResponse {
  const parts: Array<{ text?: string; thought?: boolean; functionCall?: { name: string; args?: unknown } }> = [];
  let finishReason: string | undefined;
  let usageMetadata: GeminiResponse['usageMetadata'];
  for (const c of arr) {
    parts.push(...(c.candidates?.[0]?.content?.parts ?? []));
    finishReason = c.candidates?.[0]?.finishReason ?? finishReason;
    usageMetadata = c.usageMetadata ?? usageMetadata;
  }
  return { candidates: [{ content: { parts }, finishReason }], usageMetadata };
}

/** Normalize a full (non-stream) API response into ModelResponse shape.
 *  Shared by chat() and streamChat's non-SSE fallback so both paths extract
 *  content/reasoning/tool-calls/usage identically. */
export function parseGeminiResponse(data: GeminiResponse): ModelResponse {
  const candidates = data.candidates ?? [];
  const parts = candidates[0]?.content?.parts ?? [];
  const textParts = parts.filter((p) => !p.thought && p.text && !p.functionCall).map((p) => p.text as string);
  const thoughtParts = parts.filter((p) => p.thought && p.text).map((p) => p.text as string);
  const functionCalls = parts
    .filter((p): p is { text?: string; thought?: boolean; functionCall: { name: string; args?: unknown } } => !!p.functionCall)
    .map((p, idx: number) => ({
      id: `call_${Date.now()}_${idx}`,
      type: 'function' as const,
      function: {
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args ?? {}),
      },
    }));
  const content = textParts.join('');
  const reasoningText = thoughtParts.join('\n');
  const u = data.usageMetadata ?? {};
  return {
    content,
    reasoningContent: reasoningText || undefined,
    toolCalls: functionCalls.length ? functionCalls : undefined,
    finishReason: candidates[0]?.finishReason,
    usage: { promptTokens: u.promptTokenCount ?? 0, completionTokens: u.candidatesTokenCount ?? 0, totalTokens: u.totalTokenCount ?? 0, cachedTokens: u.cachedContentTokenCount ?? 0 },
  };
}

function toGeminiTools(tools: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: 'OBJECT',
          properties: Object.fromEntries(
            t.parameters.map((p) => [
              p.name,
              {
                type: (p.type || 'string').toUpperCase(),
                description: p.description,
              },
            ]),
          ),
          required: t.parameters.filter((p) => p.required).map((p) => p.name),
        },
      })),
    },
  ];
}

export function createGeminiProvider(config: ProviderConfig) {
  const base = config.baseUrl.replace(/\/$/, '');
  const model = config.model;



  /** Build the generateContent request body so chat() (JSON one-shot) and
   *  streamChat() (SSE) share the exact same mapping. */
  const buildGeminiBody = (messages: ChatMessage[], tools: ToolDefinition[], options: { reasoningEffort?: string } | undefined): Record<string, unknown> =>
    buildGeminiRequestBody(model, messages, tools, options);

  async function chat(messages: ChatMessage[], tools: ToolDefinition[], options?: { reasoningEffort?: string }): Promise<ModelResponse> {
    const url = `${base}/v1beta/models/${model}:generateContent?key=${config.apiKey ?? ''}`;
    const body = buildGeminiBody(messages, tools, options);
    const res = await withRetries(async () => {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const text = await r.text();
          throw describeModelError(r.status, text, model, 'Gemini', parseRetryAfter(r.headers.get('retry-after')));
        }
        return r;
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(err instanceof Error ? err.message : String(err), { retryable: classifyError(err).retryable, cause: err });
      }
    }, { maxAttempts: 4, onBackoff: (attempt, delayMs, err) => logBackoff(attempt, delayMs, err) });
    return parseGeminiResponse(await res.json() as GeminiResponse);
  }

  async function* streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { signal?: AbortSignal; reasoningEffort?: string }): AsyncGenerator<StreamChunk> {
    const body = buildGeminiBody(messages, tools, options);
    // streamGenerateContent with alt=sse: `data:` JSON frames, one per
    // incremental GenerateContentResponse chunk.
    const url = `${base}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${config.apiKey ?? ''}`;
    // usageMetadata arrives cumulatively — keep the latest reported counts
    // and mirror them on every chunk the same way openai.ts exposes usage.
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let callSeq = 0;
    let finish: StreamChunk['finishReason'] | undefined;
    const usageNow = (): NonNullable<StreamChunk['usage']> => ({
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cachedTokens: cachedTokens > 0 ? cachedTokens : undefined,
    });

    const frames = openSSEStream(
      (signal) => fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      } as RequestInit),
      { signal: options?.signal, model, provider: 'Gemini' },
    );

    for await (const frame of frames) {
      if (frame.kind === 'json') {
        // Non-SSE fallback (plain-JSON gateway): one chunk, old behavior.
        // streamGenerateContent without alt=sse replies with a JSON array —
        // merge it so the fallback stays lossless either way.
        const raw = Array.isArray(frame.data) ? mergeGeminiChunks(frame.data as GeminiResponse[]) : frame.data;
        const resp = parseGeminiResponse(raw as GeminiResponse);
        yield { content: resp.content, reasoningContent: resp.reasoningContent, toolCalls: resp.toolCalls, finishReason: resp.finishReason as StreamChunk['finishReason'], usage: resp.usage };
        return;
      }
      let chunk: GeminiResponse;
      try {
        chunk = JSON.parse(frame.data) as GeminiResponse;
      } catch {
        continue; // ignore malformed frames (openai.ts convention)
      }
      const cand = chunk.candidates?.[0];
      const parts = cand?.content?.parts ?? [];
      const u = chunk.usageMetadata;
      if (u) {
        promptTokens = u.promptTokenCount ?? promptTokens;
        completionTokens = u.candidatesTokenCount ?? completionTokens;
        cachedTokens = u.cachedContentTokenCount ?? cachedTokens;
      }
      const out: StreamChunk = { usage: usageNow() };
      const text = parts.filter((p) => !p.thought && p.text && !p.functionCall).map((p) => p.text as string).join('');
      const thought = parts.filter((p) => p.thought && p.text).map((p) => p.text as string).join('\n');
      if (text) out.content = text;
      if (thought) out.reasoningContent = thought;
      const calls: StreamChunk['toolCalls'] = [];
      for (const p of parts) {
        if (!p.functionCall) continue;
        // Gemini emits each function call complete in one part (no argument
        // deltas); give every call a fresh index so consumers stitch per-call
        // instead of concatenating across calls.
        calls.push({
          id: `call_${Date.now()}_${callSeq}`,
          index: callSeq,
          type: 'function',
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args ?? {}),
          },
        });
        callSeq++;
      }
      if (calls.length) out.toolCalls = calls;
      if (cand?.finishReason) finish = mapGeminiFinish(cand.finishReason);
      if (finish) out.finishReason = finish;
      yield out;
    }
    // Stream closed without a finish event: still surface accumulated usage.
    yield { finishReason: finish, usage: usageNow() };
  }

  return { chat, streamChat };
}

function buildGeminiContents(msgs: ChatMessage[]) {
  return msgs
      .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
      .map((m) => {
        if (m.role === 'assistant') {
          const parts: Array<{ text?: string; functionCall?: { name: string; args: unknown } }> = [];
          const text = contentText(m);
          if (text) parts.push({ text });
          if (m.tool_calls) {
            for (const tc of m.tool_calls) {
              let args = {};
              try {
                args = JSON.parse(tc.function.arguments || '{}');
              } catch {}
              parts.push({
                functionCall: {
                  name: tc.function.name,
                  args,
                },
              });
            }
          }
          return { role: 'model', parts: parts.length ? parts : [{ text: '' }] };
        }
        if (m.role === 'tool') {
          // Wave H3: image parts in a tool result (computer screenshots)
          // ride in the same user turn as inlineData parts next to the
          // functionResponse — Gemini accepts mixed parts in one content.
          // Data URIs only, matching the multimodal user branch below;
          // text-only results keep the exact pre-H3 shape.
          const parts: Array<Record<string, unknown>> = [
            {
              functionResponse: {
                name: m.name ?? 'tool',
                response: { name: m.name ?? 'tool', content: contentText(m) },
              },
            },
          ];
          const { images: toolImages } = splitContent(m.content);
          for (const img of toolImages) {
            if ('data' in img) parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
          }
          return { role: 'user', parts };
        }
        // Multimodal user turn: data-URI images become inlineData parts.
        // Remote http(s) URLs have no Gemini-native inline form (fileData
        // needs Files-API URIs), so they ride along as text — the URL itself
        // is preserved, never dropped or stringified as [object Object].
        const { text: gtext, images: gimages } = splitContent(m.content);
        const inline = gimages.filter((g): g is { mime: string; data: string } => 'data' in g);
        if (inline.length > 0) {
          const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
          if (gtext) parts.push({ text: gtext });
          for (const img of inline) parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
          return { role: 'user', parts };
        }
        const remote = gimages.filter((g): g is { url: string } => 'url' in g).map((g) => g.url);
        return { role: 'user', parts: [{ text: [gtext, ...remote].filter(Boolean).join('\n') }] };
      });
}


/** Module-scope body builder (shared with the Vertex provider). */
export function buildGeminiRequestBody(model: string, messages: ChatMessage[], tools: ToolDefinition[], options: { reasoningEffort?: string } | undefined): Record<string, unknown> {
  const reasoning = String(options?.reasoningEffort || process.env.MOCHI_REASONING || '').toLowerCase().trim();
  const supportsThinking = /(2\.0|2\.5|gemini-2)/i.test(model);
  const thinkingBudget = supportsThinking
    ? ((reasoning === 'max' || reasoning === 'extreme' || reasoning === 'deep') ? 24576
      : (reasoning === 'high' || reasoning === 'hard') ? 16384
      : (reasoning === 'medium') ? 8192
      : (reasoning === 'low' || reasoning === 'easy') ? 1024
      : 0)
    : 0;
  const geminiTools = toGeminiTools(tools);
  const sys = messages.filter((m) => m.role === 'system').map((m) => contentText(m)).join('\n');
  return {
    contents: buildGeminiContents(messages),
    systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
    ...(geminiTools ? { tools: geminiTools } : {}),
    ...(thinkingBudget > 0 ? { generationConfig: { thinking_config: { thinking_budget: thinkingBudget } } } : {}),
  };
}
