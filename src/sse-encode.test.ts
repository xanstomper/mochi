import { describe, it, expect } from 'vitest';
import {
  encodeSSEChunk,
  encodeSSEDone,
  buildChatCompletion,
  buildToolCallChunk,
  buildFinishChunk,
} from './sse-encode.js';
import { StreamParser } from './stream-parser.js';

// These tests prove the shared SSE encoder (the real outbound half of the
// protocol) produces bytes that the real production `StreamParser` decodes
// correctly — i.e. the encoder and decoder are wired to the same contract.

function collect(body: string): any[] {
  const parser = new StreamParser('test-msg');
  const events: any[] = [];
  for (const line of body.split('\n')) events.push(...parser.write(line + '\n'));
  events.push(...parser.end());
  return events;
}

describe('sse-encode round-trips through the real StreamParser', () => {
  it('encodes and decodes a plain content completion with usage', () => {
    const body = buildChatCompletion({
      id: 'chatcmpl_abc',
      content: 'Hello world',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    }) + encodeSSEDone();

    const events = collect(body);
    const texts = events.filter((e) => e.type === 'text-delta').map((e) => e.text);
    expect(texts.join('')).toBe('Hello world');

    expect(events.find((e) => e.type === 'finish')?.reason).toBe('stop');
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', promptTokens: 10, completionTokens: 20, totalTokens: 30 });
  });

  it('emits the wire usage keys in snake_case that the parser reads', () => {
    const body = buildChatCompletion({
      content: 'x',
      usage: { promptTokens: 3, completionTokens: 7, totalTokens: 10 },
    });
    expect(body).toContain('"prompt_tokens":3');
    expect(body).toContain('"completion_tokens":7');
    expect(body).toContain('"total_tokens":10');
  });

  it('emits tool-call chunks that reassemble into a single tool call', () => {
    const body = buildChatCompletion({
      id: 'chatcmpl_tc',
      content: '',
      toolCalls: [{ id: 'call_9', name: 'read', arguments: '{"path":"a.ts"}' }],
      finishReason: 'tool_calls',
      usage: { promptTokens: 2, completionTokens: 8, totalTokens: 10 },
    }) + encodeSSEDone();

    const events = collect(body);
    expect(events.find((e) => e.type === 'tool-start')).toMatchObject({ type: 'tool-start', toolCallId: 'call_9', name: 'read' });
    expect(events.find((e) => e.type === 'tool-delta')?.delta).toBe('{"path":"a.ts"}');
    expect(events.find((e) => e.type === 'finish' && e.reason !== 'tool_end')?.reason).toBe('tool_calls');
  });

  it('emits two tool calls that stay distinct (per-index accumulation)', () => {
    const body = buildChatCompletion({
      toolCalls: [
        { id: 'call_a', name: 'read', arguments: '{"a":1}' },
        { id: 'call_b', name: 'write', arguments: '{"b":2}' },
      ],
      finishReason: 'tool_calls',
    }) + encodeSSEDone();

    const starts = collect(body).filter((e) => e.type === 'tool-start');
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ toolCallId: 'call_a', name: 'read' });
    expect(starts[1]).toMatchObject({ toolCallId: 'call_b', name: 'write' });
  });

  it('splits long content across multiple chunks but reassembles in order', () => {
    const long = 'The quick brown fox jumps over the lazy dog. '.repeat(8);
    const body = buildChatCompletion({ content: long, finishReason: 'stop' }) + encodeSSEDone();
    const events = collect(body);
    const texts = events.filter((e) => e.type === 'text-delta').map((e) => e.text);
    expect(texts.join('')).toBe(long);
    expect(texts.length).toBeGreaterThan(1);
  });

  it('encodeSSEChunk/encodeSSEDone produce the expected low-level framing', () => {
    expect(encodeSSEChunk({ a: 1 })).toBe('data: {"a":1}\n\n');
    expect(encodeSSEDone()).toBe('data: [DONE]\n\n');
  });

  it('individual builders produce parseable streams', () => {
    const id = 'chatcmpl_b';
    const body = [
      buildToolCallChunk(id, { id: 'c', name: 'shell', arguments: 'true' }, 0),
      buildFinishChunk(id, { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, 'tool_calls'),
      encodeSSEDone(),
    ].join('');
    const events = collect(body);
    expect(events.find((e) => e.type === 'tool-start')?.name).toBe('shell');
  });

  it('round-trips end-to-end: encode -> parser yields the full model response', () => {
    const body = buildChatCompletion({
      id: 'chatcmpl_e2e',
      content: 'Hello world',
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 15, totalTokens: 20 },
    }) + encodeSSEDone();

    const events = collect(body);
    const text = events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('');
    expect(text).toBe('Hello world');
    expect(events.find((e) => e.type === 'usage')?.totalTokens).toBe(20);
    expect(events.find((e) => e.type === 'finish')?.reason).toBe('stop');
  });
});