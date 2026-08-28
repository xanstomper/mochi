// Asymmetric Dual-Model Dispatcher for Mochi
// Offloads mechanical sub-tasks (search filtering, diff formatting, summary drafting,
// syntax verification) to a sub-300ms fast micro-tier model, preserving frontier
// reasoning bandwidth strictly for complex architectural decisions.

import type { ModelConfig, ChatMessage, ToolDefinition, StreamChunk, ModelResponse } from '../types.js';
import { createProvider } from './router.js';

export interface DualDispatchOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export class DualModelDispatcher {
  private frontierProvider: ReturnType<typeof createProvider>;
  private fastProvider: ReturnType<typeof createProvider>;

  constructor(private config: ModelConfig) {
    this.frontierProvider = createProvider(config, 'coding');
    this.fastProvider = createProvider(config, 'fast');
  }

  /**
   * Dispatches a mechanical query to the fast/micro tier model (e.g. Gemini Flash,
   * DeepSeek Flash Free, Claude Haiku), saving 80%+ TTFT and frontier context tokens.
   * Automatically falls back to the primary provider if the fast provider fails.
   */
  async runFast(
    prompt: string,
    systemPrompt = 'You are a fast, concise code assistant. Respond with the direct answer only without filler.',
    options?: DualDispatchOptions
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ];

    try {
      const res = await this.fastProvider.chat(messages, [], {
        temperature: options?.temperature ?? 0.1,
        maxTokens: options?.maxTokens ?? 1024,
        signal: options?.signal,
      });
      return (res.content ?? '').trim();
    } catch {
      // Graceful fallback to frontier provider
      const fallbackRes = await this.frontierProvider.chat(messages, [], {
        temperature: options?.temperature ?? 0.1,
        maxTokens: options?.maxTokens ?? 1024,
        signal: options?.signal,
      });
      return (fallbackRes.content ?? '').trim();
    }
  }

  /** Run a strategic turn on the frontier reasoning tier with streaming */
  async *streamFrontier(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: DualDispatchOptions
  ): AsyncGenerator<StreamChunk> {
    yield* this.frontierProvider.streamChat(messages, tools, options);
  }

  /** Run a non-streaming turn on the frontier reasoning tier */
  async chatFrontier(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: DualDispatchOptions
  ): Promise<ModelResponse> {
    return this.frontierProvider.chat(messages, tools, options);
  }
}
