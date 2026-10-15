/**
 * Google Antigravity Provider for Mochi.
 *
 * Dispatches inference requests to Google Cloud Code Assist
 * (`daily-cloudcode-pa.googleapis.com`), supporting Gemini 3, Claude 4.5/4.6,
 * and GPT-OSS models via Antigravity OAuth bearer tokens.
 */

import { randomUUID } from 'node:crypto';
import type { ChatMessage, ToolDefinition, StreamChunk, ModelResponse } from '../types.js';
import type { ProviderConfig } from './openai.js';
import { ProviderError, describeModelError, parseRetryAfter } from '../utils/http-error.js';
import { classifyError, withRetries } from './rate-limit.js';
import { openSSEStream } from './sse.js';

function logBackoff(attempt: number, delayMs: number, err: unknown): void {
  const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
  console.warn(`[antigravity] retry ${attempt} in ${delayMs}ms: ${detail}`);
}
import {
  CLOUD_CODE_ASSIST_ENDPOINT,
  CLOUD_CODE_ASSIST_SANDBOX_ENDPOINT,
  getAntigravityUserAgent,
  refreshAntigravityToken,
} from './antigravity-oauth.js';

interface AntigravityCandidatePart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: unknown };
}

interface AntigravityCandidate {
  content?: {
    parts?: AntigravityCandidatePart[];
  };
  finishReason?: string;
}

interface AntigravityUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface AntigravityResponsePayload {
  candidates?: AntigravityCandidate[];
  usageMetadata?: AntigravityUsageMetadata;
  response?: {
    candidates?: AntigravityCandidate[];
    usageMetadata?: AntigravityUsageMetadata;
  };
}

function parseCredentials(apiKeyOrJson?: string): {
  accessToken: string;
  refreshToken?: string;
  projectId: string;
  email?: string;
  expiresAtMs?: number;
} {
  if (!apiKeyOrJson) {
    return { accessToken: '', projectId: 'aicode-consumers' };
  }
  const trimmed = apiKeyOrJson.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        const access = typeof record.access === 'string'
          ? record.access
          : typeof record.access_token === 'string'
            ? record.access_token
            : '';
        const refresh = typeof record.refresh === 'string'
          ? record.refresh
          : typeof record.refresh_token === 'string'
            ? record.refresh_token
            : undefined;
        const project = typeof record.projectId === 'string'
          ? record.projectId
          : typeof record.project === 'string'
            ? record.project
            : 'aicode-consumers';
        const exp = typeof record.expires === 'number'
          ? record.expires
          : typeof record.expiresAtMs === 'number'
            ? record.expiresAtMs
            : undefined;
        const email = typeof record.email === 'string' ? record.email : undefined;
        return {
          accessToken: access,
          refreshToken: refresh,
          projectId: project,
          email,
          expiresAtMs: exp,
        };
      }
    } catch {
      // Fallback to literal token
    }
  }
  return { accessToken: trimmed, projectId: 'aicode-consumers' };
}

function contentText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return m.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function splitContent(content: ChatMessage['content']): {
  text: string;
  images: Array<{ mime: string; data: string } | { url: string }>;
} {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const textParts: string[] = [];
  const images: Array<{ mime: string; data: string } | { url: string }> = [];
  for (const part of content) {
    if (part.type === 'text') {
      textParts.push(part.text);
    } else if (part.type === 'image_url') {
      const u = part.image_url.url;
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(u);
      if (m) images.push({ mime: m[1], data: m[2] });
      else images.push({ url: u });
    }
  }
  return { text: textParts.join('\n'), images };
}

function mapAntigravityFinish(reason?: string): StreamChunk['finishReason'] {
  if (reason === 'MAX_TOKENS') return 'length';
  return 'stop';
}
export const ANTIGRAVITY_PRICING_TABLE: Record<string, { in: number; out: number; cache: number }> = {
  // Gemini 3.8 / 3.7 / 3.6 Flash ($0.75 / $3.75 per 1M tokens, cache read $0.075)
  'gemini-3.8-flash': { in: 0.75, out: 3.75, cache: 0.075 },
  'gemini-3.7-flash': { in: 0.75, out: 3.75, cache: 0.075 },
  // Gemini 3 Flash ($0.50 / $3.00 per 1M tokens, cache read $0.05)
  'gemini-3-flash': { in: 0.50, out: 3.00, cache: 0.05 },
  // Gemini 3.5 Flash ($1.50 / $9.00 per 1M tokens, cache read $0.15)
  'gemini-3.5-flash': { in: 1.50, out: 9.00, cache: 0.15 },
  'gemini-3.5-flash-lite': { in: 0.30, out: 2.50, cache: 0.03 },
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.50, cache: 0.025 },
  // Gemini 2.5 Flash ($0.30 / $2.50 per 1M tokens, cache read $0.03)
  'gemini-2.5-flash': { in: 0.30, out: 2.50, cache: 0.03 },
  'gemini-2.5-flash-lite': { in: 0.10, out: 0.40, cache: 0.01 },
  // Claude Sonnet 4.6 / 4.5 ($3.00 / $15.00 per 1M tokens, cache read $0.30)
  'claude-sonnet-4-6': { in: 3.00, out: 15.00, cache: 0.30 },
  'claude-sonnet-4-5': { in: 3.00, out: 15.00, cache: 0.30 },
  // Claude Opus 4.6 / 4.5 ($5.00 / $25.00 per 1M tokens, cache read $0.50)
  'claude-opus-4-6': { in: 5.00, out: 25.00, cache: 0.50 },
  'claude-opus-4-5': { in: 5.00, out: 25.00, cache: 0.50 },
  // Free / preview tiers ($0)
  'gpt-oss-120b': { in: 0, out: 0, cache: 0 },
  'gemini-4-argon-disabled': { in: 0, out: 0, cache: 0 },
  'tab_flash_lite_preview': { in: 0, out: 0, cache: 0 },
  'tab_jump_flash_lite_preview': { in: 0, out: 0, cache: 0 },
};

export function computeAntigravityCost(model: string, inTokens: number, outTokens: number, cachedTokens = 0): number {
  const m = model.toLowerCase();
  const direct = ANTIGRAVITY_PRICING_TABLE[m];
  let rates = direct;
  if (!rates) {
    if (m.includes('opus')) rates = ANTIGRAVITY_PRICING_TABLE['claude-opus-4-6'];
    else if (m.includes('sonnet') || m.includes('claude')) rates = ANTIGRAVITY_PRICING_TABLE['claude-sonnet-4-6'];
    else if (m.includes('3.8') || m.includes('3.7') || m.includes('3.6')) rates = ANTIGRAVITY_PRICING_TABLE['gemini-3.8-flash'];
    else if (m.includes('3.5')) rates = ANTIGRAVITY_PRICING_TABLE['gemini-3.5-flash'];
    else if (m.includes('flash')) rates = ANTIGRAVITY_PRICING_TABLE['gemini-3-flash'];
    else rates = ANTIGRAVITY_PRICING_TABLE['gemini-3.8-flash'];
  }

  const inRate = rates.in / 1_000_000;
  const outRate = rates.out / 1_000_000;
  const cacheRate = rates.cache / 1_000_000;

  const billableIn = Math.max(0, inTokens - cachedTokens);
  const cost = billableIn * inRate + cachedTokens * cacheRate + outTokens * outRate;
  return Math.round(cost * 10_000_000) / 10_000_000;
}

function extractAntigravity(data: AntigravityResponsePayload, defaultModel = 'gemini-3.8-flash'): ModelResponse {
  const container = data.response ?? data;
  const candidates = container.candidates ?? [];
  const parts = candidates[0]?.content?.parts ?? [];
  const textParts = parts.filter((p) => !p.thought && p.text && !p.functionCall).map((p) => p.text as string);
  const thoughtParts = parts.filter((p) => p.thought && p.text).map((p) => p.text as string);
  const toolCalls = parts
    .filter((p) => Boolean(p.functionCall))
    .map((p, idx) => ({
      id: `call_${idx}_${Date.now()}`,
      type: 'function' as const,
      function: {
        name: p.functionCall?.name ?? '',
        arguments: JSON.stringify(p.functionCall?.args ?? {}),
      },
    }));

  const u = container.usageMetadata ?? {};
  const pTok = u.promptTokenCount ?? 0;
  const cTok = u.candidatesTokenCount ?? 0;
  const tTok = u.totalTokenCount ?? 0;
  const caTok = u.cachedContentTokenCount ?? 0;
  const costUsd = computeAntigravityCost(defaultModel, pTok, cTok, caTok);

  return {
    content: textParts.join(''),
    reasoningContent: thoughtParts.length ? thoughtParts.join('') : undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: candidates[0]?.finishReason,
    usage: {
      promptTokens: pTok,
      completionTokens: cTok,
      totalTokens: tTok,
      cachedTokens: caTok,
      costUsd,
    },
  };
}

function toAntigravityProperty(p: { type?: string; description?: string; items?: unknown; properties?: unknown }): Record<string, unknown> {
  const type = (p.type || 'string').toUpperCase();
  const def: Record<string, unknown> = {
    type,
    description: p.description,
  };
  if (type === 'ARRAY') {
    def.items = p.items && typeof p.items === 'object'
      ? toAntigravityProperty(p.items as Record<string, unknown>)
      : { type: 'STRING' };
  } else if (type === 'OBJECT' && p.properties && typeof p.properties === 'object') {
    def.properties = Object.fromEntries(
      Object.entries(p.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        toAntigravityProperty(v as Record<string, unknown>),
      ]),
    );
  }
  return def;
}

function toAntigravityTools(tools: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: 'OBJECT',
          properties: Object.fromEntries(
            t.parameters.map((p) => [p.name, toAntigravityProperty(p)]),
          ),
          required: t.parameters.filter((p) => p.required).map((p) => p.name),
        },
      })),
    },
  ];
}

export function createAntigravityProvider(config: ProviderConfig) {
  const model = config.model;
  let creds = parseCredentials(config.apiKey);

  const getValidToken = async (): Promise<string> => {
    if (!creds.accessToken || (creds.expiresAtMs && Date.now() > creds.expiresAtMs - 60_000)) {
      try {
        const { antigravityAmbientToken } = await import('./ambient-auth.js');
        const amb = await antigravityAmbientToken(undefined, creds.email);
        if (amb?.token) {
          creds.accessToken = amb.token;
          if (amb.expiresAtMs) creds.expiresAtMs = amb.expiresAtMs;
          if (amb.account) creds.email = amb.account;
          if (amb.projectId) creds.projectId = amb.projectId;
        }
      } catch {}
    }
    if (creds.refreshToken && creds.expiresAtMs && Date.now() > creds.expiresAtMs - 60_000) {
      try {
        const refreshed = await refreshAntigravityToken(creds.refreshToken);
        creds = {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token ?? creds.refreshToken,
          projectId: creds.projectId,
          email: creds.email,
          expiresAtMs: refreshed.expiresAtMs,
        };
      } catch {}
    }
    return creds.accessToken;
  };

  const executePost = async (url: string, bodyJson: string, signal?: AbortSignal): Promise<Response> => {
    let token = await getValidToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': getAntigravityUserAgent(),
    };
    let r = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyJson,
      signal,
    });
    if (r.status === 401) {
      try {
        const { antigravityAmbientToken } = await import('./ambient-auth.js');
        const amb = await antigravityAmbientToken(undefined, creds.email);
        if (amb?.token && amb.token !== token) {
          token = amb.token;
          creds.accessToken = amb.token;
          if (amb.expiresAtMs) creds.expiresAtMs = amb.expiresAtMs;
          headers.Authorization = `Bearer ${token}`;
          r = await fetch(url, {
            method: 'POST',
            headers,
            body: bodyJson,
            signal,
          });
        }
      } catch {}
    }
    return r;
  };

  const toContents = (msgs: ChatMessage[]) => {
    const contents: Array<{ role: string; parts: unknown[] }> = [];
    for (const m of msgs) {
      if (m.role === 'assistant') {
        const parts: unknown[] = [];
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
              thoughtSignature: 'skip_thought_signature_validator',
            });
          }
        }
        contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      } else if (m.role === 'tool') {
        const part = {
          functionResponse: {
            name: m.name ?? 'tool',
            response: { output: contentText(m) },
          },
        };
        const last = contents[contents.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.parts) && last.parts.some((p) => p && typeof p === 'object' && 'functionResponse' in p)) {
          last.parts.push(part);
        } else {
          contents.push({ role: 'user', parts: [part] });
        }
      } else if (m.role === 'user') {
        const { text: gtext, images: gimages } = splitContent(m.content);
        const inline = gimages.filter((g): g is { mime: string; data: string } => 'data' in g);
        if (inline.length > 0) {
          const parts: unknown[] = [];
          if (gtext) parts.push({ text: gtext });
          for (const img of inline) parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
          contents.push({ role: 'user', parts });
        } else {
          const remote = gimages.filter((g): g is { url: string } => 'url' in g).map((g) => g.url);
          contents.push({ role: 'user', parts: [{ text: [gtext, ...remote].filter(Boolean).join('\n') }] });
        }
      }
    }
    return contents;
  };

  const system = (msgs: ChatMessage[]) =>
    msgs.filter((m) => m.role === 'system').map((m) => contentText(m)).join('\n');

  function resolveWireModel(rawModel: string, reasoningEffort?: string): string {
    const effort = (reasoningEffort || process.env.MOCHI_REASONING || '').toLowerCase().trim();
    const revMatch = /^gemini-(3\.[6-9])-flash$/i.exec(rawModel);
    if (revMatch) {
      const rev = revMatch[1];
      if (effort === 'low' || effort === 'minimal' || effort === 'easy') return `gemini-${rev}-flash-low`;
      if (effort === 'medium' || effort === 'med') return `gemini-${rev}-flash-medium`;
      return `gemini-${rev}-flash-high`;
    }
    const map: Record<string, string> = {
      'gemini-3.5-flash': 'gemini-3-flash',
      'gemini-3.1-pro': 'gemini-3-flash',
      'claude-opus-4-6': 'claude-opus-4-6-thinking',
      'claude-sonnet-4-5': 'claude-sonnet-4-5-thinking',
      'claude-opus-4-5': 'claude-opus-4-5-thinking',
      'gemini-2.5-flash': 'gemini-2.5-flash-thinking',
      'gpt-oss-120b': 'gpt-oss-120b-medium',
      'gemini-4-argon-disabled': 'gemini-4-argon',
    };
    return map[rawModel] ?? rawModel;
  }

  function buildRequestBody(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: { reasoningEffort?: string; maxTokens?: number } | undefined,
  ): Record<string, unknown> {
    const wireModel = resolveWireModel(model, options?.reasoningEffort);
    const isClaude = wireModel.toLowerCase().includes('claude');
    const maxTokens = options?.maxTokens ?? (isClaude ? 64000 : 65536);

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: maxTokens,
    };

    const effort = (options?.reasoningEffort || process.env.MOCHI_REASONING || '').toLowerCase().trim();
    if (effort && effort !== 'off') {
      const budget =
        effort === 'max' || effort === 'extreme' || effort === 'deep' ? 24576
        : effort === 'high' || effort === 'hard' ? 16384
        : effort === 'medium' || effort === 'med' ? 8192
        : 2048; // low / minimal / easy
      const level =
        effort === 'max' || effort === 'high' || effort === 'hard' ? 'HIGH'
        : effort === 'medium' || effort === 'med' ? 'MEDIUM'
        : 'LOW';

      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: budget,
        thinkingLevel: level,
      };
    }
    const sysText = system(messages);
    const antiTools = toAntigravityTools(tools);

    const stepIndex = messages.filter((m) => m.role === 'assistant').length + 1;
    const trajectoryId = randomUUID();
    const agentId = randomUUID();
    const requestId = `agent/${agentId}/${Date.now()}/${trajectoryId}/${stepIndex}`;
    const sessionId = (BigInt.asIntN(63, BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)))).toString();

    const labels: Record<string, string> = {
      trajectory_id: trajectoryId,
      last_step_index: String(Math.max(1, stepIndex - 1)),
      used_claude: String(isClaude),
      used_claude_conservative: String(isClaude),
    };

    const innerRequest: Record<string, unknown> = {
      contents: toContents(messages),
      generationConfig,
      sessionId,
      labels,
    };

    if (sysText) {
      innerRequest.systemInstruction = {
        role: 'user',
        parts: [{ text: sysText }],
      };
    }

    if (antiTools) {
      innerRequest.tools = antiTools;
    }

    if (isClaude) {
      innerRequest.toolConfig = {
        functionCallingConfig: {
          mode: 'VALIDATED',
        },
      };
    }

    return {
      project: creds.projectId,
      requestId,
      request: innerRequest,
      model: wireModel,
      userAgent: 'antigravity',
      requestType: 'agent',
    };
  }

  const endpoints = [
    CLOUD_CODE_ASSIST_ENDPOINT,
    CLOUD_CODE_ASSIST_SANDBOX_ENDPOINT,
  ];

  async function chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: { reasoningEffort?: string; maxTokens?: number },
  ): Promise<ModelResponse> {
    const body = buildRequestBody(messages, tools, options);

    let lastError: unknown;
    for (const endpoint of endpoints) {
      const url = `${endpoint}/v1internal:generateContent`;
      try {
        const res = await withRetries(async () => {
          try {
            const r = await executePost(url, JSON.stringify(body));
            if (!r.ok) {
              const text = await r.text();
              throw describeModelError(r.status, text, model, 'Antigravity', parseRetryAfter(r.headers.get('retry-after')));
            }
            return r;
          } catch (err) {
            if (err instanceof ProviderError) throw err;
            throw new ProviderError(err instanceof Error ? err.message : String(err), {
              retryable: classifyError(err).retryable,
              cause: err,
            });
          }
        }, { maxAttempts: 3, onBackoff: (attempt, delayMs, err) => logBackoff(attempt, delayMs, err) });

        const json = (await res.json()) as AntigravityResponsePayload;
        return extractAntigravity(json, model);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  async function* streamChat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: { signal?: AbortSignal; reasoningEffort?: string; maxTokens?: number },
  ): AsyncGenerator<StreamChunk> {
    const body = buildRequestBody(messages, tools, options);

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
      costUsd: computeAntigravityCost(model, promptTokens, completionTokens, cachedTokens),
    });
    const primaryUrl = `${endpoints[0]}/v1internal:streamGenerateContent?alt=sse`;

    const frames = openSSEStream(
      (signal) => executePost(primaryUrl, JSON.stringify(body), signal),
      { signal: options?.signal, model, provider: 'Antigravity' },
    );

    for await (const frame of frames) {
      if (frame.kind === 'json') {
        const raw = frame.data as AntigravityResponsePayload;
        const resp = extractAntigravity(raw, model);
        yield {
          content: resp.content,
          reasoningContent: resp.reasoningContent,
          toolCalls: resp.toolCalls,
          finishReason: resp.finishReason as StreamChunk['finishReason'],
          usage: resp.usage,
        };
        return;
      }

      let payload: AntigravityResponsePayload;
      try {
        payload = JSON.parse(frame.data) as AntigravityResponsePayload;
      } catch {
        continue;
      }

      const container = payload.response ?? payload;
      const u = container.usageMetadata;
      if (u) {
        promptTokens = u.promptTokenCount ?? promptTokens;
        completionTokens = u.candidatesTokenCount ?? completionTokens;
        cachedTokens = u.cachedContentTokenCount ?? cachedTokens;
      }

      const cand = container.candidates?.[0];
      if (cand?.finishReason) {
        finish = mapAntigravityFinish(cand.finishReason);
      }

      const parts = cand?.content?.parts ?? [];
      for (const p of parts) {
        if (p.thought && p.text) {
          yield { reasoningContent: p.text, finishReason: finish, usage: usageNow() };
        } else if (p.functionCall) {
          yield {
            toolCalls: [
              {
                id: `call_${callSeq++}_${Date.now()}`,
                type: 'function',
                function: {
                  name: p.functionCall.name,
                  arguments: JSON.stringify(p.functionCall.args ?? {}),
                },
              },
            ],
            finishReason: finish,
            usage: usageNow(),
          };
        } else if (p.text) {
          yield { content: p.text, finishReason: finish, usage: usageNow() };
        }
      }
    }

    if (finish) {
      yield { finishReason: finish, usage: usageNow() };
    }
  }

  return { chat, streamChat };
}
