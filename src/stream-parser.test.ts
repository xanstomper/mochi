import { describe, it, expect } from 'vitest';
import { StreamParser } from './stream-parser.js';

function sse(payload: object) {
  return `data: ${JSON.stringify(payload)}\n`;
}

describe('StreamParser', () => {
  it('parses text deltas incrementally without rescanning', () => {
    const parser = new StreamParser('m1');
    const events = [
      ...parser.write(sse({ choices: [{ delta: { content: 'Hel' } }] })),
      ...parser.write(sse({ choices: [{ delta: { content: 'lo' } }] })),
      ...parser.write(sse({ choices: [{ delta: { content: '!' } }] })),
      ...parser.end(),
    ];
    const text = events
      .filter((e) => e.type === 'text-delta')
      .map((e) => (e as any).text)
      .join('');
    expect(text).toBe('Hello!');
    expect(events.some((e) => e.type === 'finish')).toBe(true);
  });

  it('handles split chunks and partial lines', () => {
    const parser = new StreamParser('m1');
    const line1 = sse({ choices: [{ delta: { content: 'abc' } }] });
    const line2 = sse({ choices: [{ delta: { content: 'def' } }] });
    const first = parser.write(line1.slice(0, line1.length - 5));
    const second = parser.write(line1.slice(line1.length - 5) + line2.slice(0, line2.length - 3));
    const third = parser.write(line2.slice(line2.length - 3));
    const events = [...first, ...second, ...third, ...parser.end()];
    const text = events
      .filter((e) => e.type === 'text-delta')
      .map((e) => (e as any).text)
      .join('');
    expect(text).toBe('abcdef');
  });

  it('emits compact tool-call events', () => {
    const parser = new StreamParser('m1');
    const events = [
      ...parser.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'edit', arguments: '{"pa' } }] } }] })),
      ...parser.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } }] })),
      ...parser.end(),
    ];
    expect(events.some((e) => e.type === 'tool-start' && (e as any).name === 'edit')).toBe(true);
    const args = events
      .filter((e) => e.type === 'tool-delta')
      .map((e) => (e as any).delta)
      .join('');
    expect(args).toBe('{"path":"x"}');
  });

  it('parses usage and finish events', () => {
    const parser = new StreamParser('m1');
    const events = [
      ...parser.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })),
      ...parser.write('data: [DONE]\n'),
    ];
    expect(events.some((e) => e.type === 'usage' && (e as any).totalTokens === 15)).toBe(true);
    expect(events.some((e) => e.type === 'finish' && (e as any).reason === 'tool_calls')).toBe(true);
  });
});
