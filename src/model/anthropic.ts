import type { ChatMessage, ModelResponse, StreamChunk, ToolDefinition } from '../types.js';
import type { ProviderConfig } from './router.js';
import { describeModelError } from '../utils/http-error.js';

export function createAnthropicProvider(config: ProviderConfig) {
  const base = config.baseUrl.replace(/\/$/, '');
  const model = config.model;

  const sysMsg = (msgs: ChatMessage[]) => msgs.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');
  const bodyMsg = (m: ChatMessage) => {
    if (m.role === 'system') return null;
    if (m.role === 'tool') return { role: 'user', content: JSON.stringify({ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }) };
    if (m.role === 'assistant' && m.tool_calls) {
      return { role: 'assistant', content: m.content ?? '', tool_use: m.tool_calls.map((tc) => ({ id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') })) };
    }
    return { role: m.role, content: m.content ?? '' };
  };

  async function chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model,
      max_tokens: 8192,
      system: sysMsg(messages) || undefined,
      messages: messages.map(bodyMsg).filter(Boolean),
      stream: false,
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: { type: 'object', properties: Object.fromEntries(t.parameters.map((p) => [p.name, { type: p.type, description: p.description }])), required: t.parameters.filter((x) => x.required).map((x) => x.name) } })) } : {}),
    };
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw describeModelError(res.status, text, model, 'Anthropic');
    }
    const data: any = await res.json();
    const blocks = data.content ?? [];
    const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    const toolUses = blocks.filter((b: any) => b.type === 'tool_use');
    const toolCalls = toolUses.map((b: any) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    const usage = data.usage ? { promptTokens: data.usage.input_tokens ?? 0, completionTokens: data.usage.output_tokens ?? 0, totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0) } : undefined;
    return { content: text, toolCalls: toolCalls.length ? toolCalls : undefined, finishReason: data.stop_reason, usage };
  }

  async function* streamChat(messages: ChatMessage[], _tools: ToolDefinition[]): AsyncGenerator<StreamChunk> {
    const resp = await chat(messages, _tools);
    yield { content: resp.content, toolCalls: resp.toolCalls, finishReason: resp.finishReason as any, usage: resp.usage };
  }

  return { chat, streamChat };
}