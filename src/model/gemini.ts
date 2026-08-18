import type { ChatMessage, ModelResponse, StreamChunk, ToolDefinition } from '../types.js';
import type { ProviderConfig } from './router.js';

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
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini request failed (${res.status}): ${text.slice(0, 400)}`);
    }
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