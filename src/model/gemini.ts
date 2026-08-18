import type { ChatMessage, ModelResponse, StreamChunk, ToolDefinition } from '../types.js';
import type { ProviderConfig } from './router.js';
import { ProviderError, describeModelError, parseRetryAfter } from '../utils/http-error.js';
import { withRetries, classifyError } from './rate-limit.js';

function logBackoff(attempt: number, delayMs: number, err: unknown): void {
  const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
  console.warn(`[rate-limit] model request backoff #${attempt}: sleeping ${Math.round(delayMs)}ms (${detail.slice(0, 80)})`);
}

export function createGeminiProvider(config: ProviderConfig) {
  const base = config.baseUrl.replace(/\/$/, '');
  const model = config.model;

  const toContents = (msgs: ChatMessage[]) =>
    msgs
      .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
      .map((m) => {
        const role = m.role === 'assistant' ? 'model' : 'user';
        if (m.role === 'tool') {
          return { role: 'user', parts: [{ text: `${m.name ?? ''} result: ${m.content ?? ''}` }] };
        }
        return { role, parts: [{ text: m.content ?? '' }] };
      });

  const system = (msgs: ChatMessage[]) => msgs.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');

  async function chat(messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ModelResponse> {
    const url = `${base}/v1beta/models/${model}:generateContent?key=${config.apiKey ?? ''}`;
    const body: Record<string, unknown> = { contents: toContents(messages), systemInstruction: system(messages) ? { parts: [{ text: system(messages) }] } : undefined };
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
    const content = candidates[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    const u = data.usageMetadata ?? {};
    return { content, finishReason: candidates[0]?.finishReason, usage: { promptTokens: u.promptTokenCount ?? 0, completionTokens: u.candidatesTokenCount ?? 0, totalTokens: u.totalTokenCount ?? 0 } };
  }

  async function* streamChat(messages: ChatMessage[], tools: ToolDefinition[]): AsyncGenerator<StreamChunk> {
    const resp = await chat(messages, tools);
    yield { content: resp.content, finishReason: resp.finishReason as any, usage: resp.usage };
  }

  return { chat, streamChat };
}