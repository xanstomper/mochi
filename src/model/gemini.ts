import type { ChatMessage, ModelResponse, StreamChunk, ToolDefinition } from '../types.js';
import type { ProviderConfig } from './router.js';
import { ProviderError, describeModelError, parseRetryAfter } from '../utils/http-error.js';
import { withRetries, classifyError } from './rate-limit.js';

function logBackoff(attempt: number, delayMs: number, err: unknown): void {
  const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
  console.warn(`[rate-limit] model request backoff #${attempt}: sleeping ${Math.round(delayMs)}ms (${detail.slice(0, 80)})`);
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

  const toContents = (msgs: ChatMessage[]) =>
    msgs
      .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
      .map((m) => {
        if (m.role === 'assistant') {
          const parts: any[] = [];
          if (m.content) parts.push({ text: m.content });
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
          return {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: m.name ?? 'tool',
                  response: { name: m.name ?? 'tool', content: m.content ?? '' },
                },
              },
            ],
          };
        }
        return { role: 'user', parts: [{ text: m.content ?? '' }] };
      });

  const system = (msgs: ChatMessage[]) => msgs.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');

  async function chat(messages: ChatMessage[], tools: ToolDefinition[], options?: { reasoningEffort?: string }): Promise<ModelResponse> {
    const url = `${base}/v1beta/models/${model}:generateContent?key=${config.apiKey ?? ''}`;
    const reasoning = String(options?.reasoningEffort || process.env.MOCHI_REASONING || '').toLowerCase().trim();
    const thinkingBudget = (reasoning === 'max' || reasoning === 'extreme' || reasoning === 'deep') ? 24576
      : (reasoning === 'high' || reasoning === 'hard') ? 16384
      : (reasoning === 'medium') ? 8192
      : (reasoning === 'low' || reasoning === 'easy') ? 1024
      : 0;

    const geminiTools = toGeminiTools(tools);
    const body: Record<string, unknown> = {
      contents: toContents(messages),
      systemInstruction: system(messages) ? { parts: [{ text: system(messages) }] } : undefined,
      ...(geminiTools ? { tools: geminiTools } : {}),
      ...(thinkingBudget > 0 ? { generationConfig: { thinking_config: { thinking_budget: thinkingBudget } } } : {}),
    };
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
    const data: any = await res.json();
    const candidates = data.candidates ?? [];
    const parts = candidates[0]?.content?.parts ?? [];
    const textParts = parts.filter((p: any) => !p.thought && p.text && !p.functionCall).map((p: any) => p.text);
    const thoughtParts = parts.filter((p: any) => p.thought && p.text).map((p: any) => p.text);
    const functionCalls = parts
      .filter((p: any) => p.functionCall)
      .map((p: any, idx: number) => ({
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
      usage: { promptTokens: u.promptTokenCount ?? 0, completionTokens: u.candidatesTokenCount ?? 0, totalTokens: u.totalTokenCount ?? 0 },
    };
  }

  async function* streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { reasoningEffort?: string }): AsyncGenerator<StreamChunk> {
    const resp = await chat(messages, tools, options);
    yield {
      content: resp.content,
      reasoningContent: (resp as any).reasoningContent,
      toolCalls: resp.toolCalls,
      finishReason: resp.finishReason as any,
      usage: resp.usage,
    };
  }

  return { chat, streamChat };
}