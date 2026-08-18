import { StreamParser } from '../stream-parser.js';
import type { ChatMessage, ModelResponse, StreamChunk, ToolDefinition } from '../types.js';

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
      ...(tools.length ? { tools: toOpenAITools(tools), tool_choice: 'auto' } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    };

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Model request failed (${res.status}): ${text.slice(0, 500)}`);
    }

    if (!res.body) throw new Error('No response body from model');

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
