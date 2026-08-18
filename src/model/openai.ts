import { StreamParser } from '../stream-parser.js';
import type { ChatMessage, ModelResponse, StreamChunk, ToolDefinition } from '../types.js';
import { ProviderError, describeModelError, parseRetryAfter } from '../utils/http-error.js';
import { withRetries, classifyError } from './rate-limit.js';

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
  return tools.map((t) => ({
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
  }));
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
  const apiKey = config.apiKey;

  async function* streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number }): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content ?? '' };
        }
        if (m.role === 'assistant' && m.tool_calls) {
          return { role: 'assistant', content: m.content ?? null, tool_calls: m.tool_calls };
        }
        return { role: m.role, content: m.content ?? '' };
      }),
      stream: true,
      ...(tools.length ? { tools: openAITools(tools), tool_choice: 'auto' } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    };

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
        });
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw describeModelError(r.status, text, model, 'opencode/OpenAI-compatible', parseRetryAfter(r.headers.get('retry-after')));
        }
        if (!r.body) throw new Error('No response body from model');
        return r;
      } catch (err) {
        // Network/transport errors carry no status; let the classifier decide
        // whether this is transient (retry) or permanent (host refused / bad DNS).
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(err instanceof Error ? err.message : String(err), { retryable: classifyError(err).retryable, cause: err });
      }
    }, { maxAttempts: 4, onBackoff: (attempt, delayMs, err) => logBackoff(attempt, delayMs, err) });

    if (!res.body) throw new ProviderError('No response body from model', { retryable: true });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalInput = 0;
    let totalOutput = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
          }
          yield {
            content: delta.content ?? undefined,
            toolCalls: parsedCalls.length ? parsedCalls : undefined,
            finishReason: choice?.finish_reason,
            usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
          };
        } catch {
          // ignore malformed lines
        }
      }
    }
  }

  async function chat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number }): Promise<ModelResponse> {
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamChat(messages, tools, options)) {
      chunks.push(chunk);
    }
    const content = chunks.map((c) => c.content).join('');
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
      toolCalls: tool_calls.length ? tool_calls : undefined,
      finishReason: chunks[chunks.length - 1]?.finishReason,
      usage,
    };
  }

  return { streamChat, chat };
}

type ToolCallAccum = { id: string; name: string; args: string };
