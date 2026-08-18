import type { ChatMessage, ModelResponse, StreamChunk, ToolDefinition } from '../types.js';

export function createMockProvider(responses: ModelResponse[]) {
  let i = 0;
  async function* streamChat(): AsyncGenerator<StreamChunk> {
    const resp = responses[i++] ?? { content: 'done', finishReason: 'stop' };
    yield {
      content: resp.content,
      toolCalls: resp.toolCalls?.map((tc, index) => ({
        index,
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
      finishReason: resp.finishReason as StreamChunk['finishReason'],
      usage: resp.usage,
    };
  }
  async function chat(_messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ModelResponse> {
    const resp = responses[i++] ?? { content: 'done', finishReason: 'stop' };
    return resp;
  }
  return { streamChat, chat };
}
