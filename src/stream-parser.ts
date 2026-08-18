import type { CompactEvent } from './stream-events.js';

interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  arguments: string;
  emittedStart: boolean;
}

/**
 * Incremental OpenAI-compatible SSE stream parser.
 *
 * Consumes each chunk exactly once. Never re-parses the accumulated buffer.
 */
export class StreamParser {
  private buffer = '';
  private messageId: string;
  private toolCalls = new Map<number, ToolCallAccumulator>();
  private finished = false;
  private parseCount = 0;
  private bytesConsumed = 0;

  constructor(messageId: string) {
    this.messageId = messageId;
  }

  write(chunk: string): CompactEvent[] {
    if (this.finished) return [];
    this.buffer += chunk;
    this.bytesConsumed += chunk.length;
    const events: CompactEvent[] = [];

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const parsed = this.parseLine(line, events);
      if (parsed === 'done') {
        this.finished = true;
        this.buffer = '';
        return events;
      }
      newlineIndex = this.buffer.indexOf('\n');
    }

    return events;
  }

  end(): CompactEvent[] {
    const events: CompactEvent[] = [];
    if (this.buffer.length > 0) {
      this.parseLine(this.buffer.replace(/\r$/, ''), events);
      this.buffer = '';
    }
    if (!this.finished) {
      this.finished = true;
      events.push({ type: 'finish', reason: 'stop' });
    }
    return events;
  }

  private parseLine(line: string, events: CompactEvent[]): 'continue' | 'done' {
    if (line.length === 0) return 'continue';
    if (!line.startsWith('data:')) return 'continue';
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      this.emitToolEnds(events);
      events.push({ type: 'finish', reason: 'stop' });
      return 'done';
    }
    if (!data) return 'continue';

    this.parseCount++;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return 'continue';
    }

    const choice = parsed.choices?.[0];
    const delta = choice?.delta ?? {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      events.push({ type: 'text-delta', messageId: this.messageId, text: delta.content });
    }

    if (Array.isArray(delta.tool_calls)) {
      this.consumeToolCalls(delta.tool_calls, events);
    }

    if (choice?.finish_reason) {
      this.emitToolEnds(events);
      events.push({ type: 'finish', reason: choice.finish_reason });
    }

    if (parsed.usage) {
      events.push({
        type: 'usage',
        promptTokens: parsed.usage.prompt_tokens ?? 0,
        completionTokens: parsed.usage.completion_tokens ?? 0,
        totalTokens: parsed.usage.total_tokens ?? 0,
      });
    }

    return 'continue';
  }

  private consumeToolCalls(toolCalls: any[], events: CompactEvent[]): void {
    for (const call of toolCalls) {
      const index = typeof call.index === 'number' ? call.index : 0;
      const id = call.id ?? `call_${index}`;
      const name = call.function?.name ?? '';
      const args = call.function?.arguments ?? '';

      let accumulator = this.toolCalls.get(index);
      if (!accumulator) {
        accumulator = { index, id, name, arguments: '', emittedStart: false };
        this.toolCalls.set(index, accumulator);
      }
      if (name && !accumulator.emittedStart) {
        accumulator.name = name;
        accumulator.emittedStart = true;
        events.push({ type: 'tool-start', messageId: this.messageId, toolCallId: id, name });
      }
      if (args) {
        accumulator.arguments += args;
        events.push({ type: 'tool-delta', toolCallId: id, delta: args });
      }
    }
  }

  private emitToolEnds(events: CompactEvent[]): void {
    for (const call of this.toolCalls.values()) {
      if (call.emittedStart) {
        events.push({ type: 'finish', reason: 'tool_end' });
      }
    }
  }

  getStats() {
    return {
      bytesConsumed: this.bytesConsumed,
      parseCount: this.parseCount,
      finished: this.finished,
    };
  }
}
