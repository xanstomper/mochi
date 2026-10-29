// Vertex AI provider — a Gemini-wire-format client that authenticates with
// Google Cloud credentials (service account / ADC) instead of an API key and
// targets the Vertex `publishers/google/models` endpoint family.
//
// Endpoint shape (aiplatform):
//   {base}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent
//   ...:streamGenerateContent?alt=sse
//
// env: GOOGLE_CLOUD_PROJECT (or VERTEX_PROJECT / service-account project_id),
//      GOOGLE_CLOUD_LOCATION (default us-central1),
//      VERTEX_ENDPOINT (optional private-endpoint base, default
//      https://{location}-aiplatform.googleapis.com).
//
// The request/response wire format is identical to the Gemini API (generateContent
// family), so this module reuses gemini.ts's body building and response parsing
// via its exported helpers.

import type { ChatMessage, ModelResponse, StreamChunk, ToolDefinition } from '../types.js';
import { ProviderError, describeModelError, parseRetryAfter } from '../utils/http-error.js';
import { withRetries, classifyError } from './rate-limit.js';
import { openSSEStream } from './sse.js';
import { vertexToken, serviceAccountProject } from './vertex-auth.js';
import { buildGeminiRequestBody } from './gemini.js';
import { logBackoff, type GeminiResponse, mapGeminiFinish } from './gemini.js';

export interface VertexConfig {
  baseUrl?: string;   // optional override; ignored when VERTEX_ENDPOINT set
  apiKey?: string;    // unused for Vertex; honored as an explicit OAuth token passthrough
  model: string;
  providerName?: string;
}

function project(): string {
  const p = process.env.GOOGLE_CLOUD_PROJECT?.trim() || process.env.VERTEX_PROJECT?.trim() || serviceAccountProject() || '';
  if (!p) {
    throw new ProviderError(
      'Vertex AI requires a project: set GOOGLE_CLOUD_PROJECT (or auth with a service account whose JSON has project_id)',
      { retryable: false },
    );
  }
  return p;
}

function location(): string {
  return process.env.GOOGLE_CLOUD_LOCATION?.trim() || 'us-central1';
}

function endpointBase(): string {
  const explicit = process.env.VERTEX_ENDPOINT?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  return `https://${location()}-aiplatform.googleapis.com`;
}

async function auth(): Promise<string> {
  const explicit = process.env.VERTEX_ACCESS_TOKEN?.trim();
  if (explicit) return explicit;
  const tok = await vertexToken();
  if (!tok) {
    throw new ProviderError(
      'No Vertex credentials: set GOOGLE_APPLICATION_CREDENTIALS (service-account JSON), GOOGLE_SERVICE_ACCOUNT_KEY, or run `gcloud auth application-default login`',
      { retryable: false },
    );
  }
  return tok.token;
}

function modelPath(): string {
  return `projects/${project()}/locations/${location()}/publishers/google/models`;
}

/** Vertex accepts the identical Gemini request body. gemini.ts owns the mapping
 *  so both providers stay in lockstep (tools, thinking budgets, multimodal). */
export function createVertexProvider(config: VertexConfig) {
  const model = config.model;

  const { parseGeminiResponse } = gemini;

  async function chat(messages: ChatMessage[], tools: ToolDefinition[], options?: { reasoningEffort?: string }): Promise<ModelResponse> {
    const token = await auth();
    const url = `${endpointBase()}/v1/${modelPath()}/${model}:generateContent`;
    const body = buildGeminiRequestBody(model, messages, tools, options);
    const res = await withRetries(async () => {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const text = await r.text();
          throw describeModelError(r.status, text, model, 'Vertex AI', parseRetryAfter(r.headers.get('retry-after')));
        }
        return r;
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(err instanceof Error ? err.message : String(err), { retryable: classifyError(err).retryable, cause: err });
      }
    }, { maxAttempts: 4, onBackoff: logBackoff });
    return parseGeminiResponse(await res.json() as GeminiResponse);
  }

  async function* streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { signal?: AbortSignal; reasoningEffort?: string }): AsyncGenerator<StreamChunk> {
    const token = await auth();
    const body = buildGeminiRequestBody(model, messages, tools, options);
    const url = `${endpointBase()}/v1/${modelPath()}/${model}:streamGenerateContent?alt=sse`;
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
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal,
      } as RequestInit),
      { signal: options?.signal, model, provider: 'Vertex AI' },
    );

    for await (const frame of frames) {
      if (frame.kind === 'json') {
        const out = parseGeminiResponse(frame.data as GeminiResponse);
        const chunk: StreamChunk = { content: out.content, ...(out.usage ? { usage: { promptTokens: out.usage.promptTokens, completionTokens: out.usage.completionTokens, totalTokens: out.usage.totalTokens, cachedTokens: out.usage.cachedTokens } } : {}) };
        if (out.toolCalls) {
          chunk.toolCalls = out.toolCalls.map((tc, i) => ({
            id: `call_${Date.now()}_${callSeq + i}`,
            index: callSeq + i,
            type: 'function' as const,
            function: tc.function,
          }));
          callSeq += out.toolCalls.length;
        }
        const frJ = (frame.data as GeminiResponse).candidates?.[0]?.finishReason;
        if (frJ) { finish = mapGeminiFinish(frJ); chunk.finishReason = finish; }
        if (out.usage) { promptTokens = out.usage.promptTokens; completionTokens = out.usage.completionTokens; cachedTokens = out.usage.cachedTokens ?? 0; }
        yield chunk;
        continue;
      }
      // SSE data frame — one incremental GenerateContentResponse.
      let parsed: GeminiResponse;
      try {
        parsed = JSON.parse(frame.data) as GeminiResponse;
      } catch { continue; }
      const out = parseGeminiResponse(parsed);
      const chunk: StreamChunk = { content: out.content };
      if (out.toolCalls) {
        chunk.toolCalls = out.toolCalls.map((tc, i) => ({
          id: `call_${Date.now()}_${callSeq + i}`,
          index: callSeq + i,
          type: 'function' as const,
          function: tc.function,
        }));
        callSeq += out.toolCalls.length;
      }
      if (out.usage) {
        promptTokens = out.usage.promptTokens;
        completionTokens = out.usage.completionTokens;
        cachedTokens = out.usage.cachedTokens ?? 0;
        chunk.usage = usageNow();
      }
      const frS = (frame.data as GeminiResponse).candidates?.[0]?.finishReason;
      if (frS) { finish = mapGeminiFinish(frS); chunk.finishReason = finish; }
      yield chunk;
    }
    yield { finishReason: finish, usage: usageNow() };
  }

  return { chat, streamChat };
}

// gemini.ts helpers are imported lazily via `gemini` namespace below to keep
// vertex-auth importable standalone in tests.
import * as gemini from './gemini.js';
