import { describe, it, expect } from 'vitest';
import { estimateCostUsd, resolvePrice, normalizeModelId } from './pricing.js';

describe('price table (C5)', () => {
  it('prices input/output/cache from the built-in table', () => {
    // gpt-4o: $2.50 in / $10 out / $1.25 cache-read per 1M.
    // inputTokens includes the cached share (provider convention):
    // 800k fresh * 2.5 + 200k cached * 1.25 + 100k out * 10 = 2.00 + 0.25 + 1.00
    const est = estimateCostUsd('gpt-4o', { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 200_000 });
    expect(est).not.toBeNull();
    expect(est!.costUsd).toBeCloseTo(3.25, 8);
    expect(est!.source).toBe('table');
  });

  it('inputIncludesCache=false bills the cache count on top of input', () => {
    const est = estimateCostUsd('gpt-4o', {
      inputTokens: 800_000, outputTokens: 100_000, cacheReadTokens: 200_000, inputIncludesCache: false,
    });
    expect(est!.costUsd).toBeCloseTo(3.25, 8);
  });

  it('normalizes provider prefixes and release-date suffixes', () => {
    expect(normalizeModelId('Claude-Sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(resolvePrice('anthropic/claude-sonnet-4-5')?.price.output).toBe(15);
    expect(resolvePrice('openrouter/openai/gpt-4o-mini')?.price.input).toBe(0.15);
    expect(resolvePrice('gpt-4o-2024-08-06')?.matchedId).toBe('gpt-4o');
  });

  it('config override changes the estimate (partial rates merge over the table)', () => {
    const base = estimateCostUsd('gpt-4o', { inputTokens: 1_000_000, outputTokens: 100_000 });
    const over = estimateCostUsd('gpt-4o', { inputTokens: 1_000_000, outputTokens: 100_000 }, { 'gpt-4o': { output: 20 } });
    expect(base!.costUsd).toBeCloseTo(3.5, 8);
    expect(over!.costUsd).toBeCloseTo(4.5, 8);
    expect(over!.source).toBe('override');
  });

  it('override can price a model the table does not know', () => {
    const est = estimateCostUsd('acme-coder-1', { inputTokens: 500_000, outputTokens: 500_000 }, { 'acme-coder-1': { input: 1, output: 3 } });
    expect(est!.costUsd).toBeCloseTo(2, 8);
  });

  it('free-tier ids price at an explicit $0, unknown models stay unpriced', () => {
    const free = estimateCostUsd('opencode/deepseek-v4-flash-free', { inputTokens: 10_000, outputTokens: 10_000 });
    expect(free).not.toBeNull();
    expect(free!.costUsd).toBe(0);
    expect(free!.source).toBe('free');
    expect(estimateCostUsd('some-model-nobody-prices', { inputTokens: 10_000, outputTokens: 10_000 })).toBeNull();
  });

  it('a totalTokens-only record cannot be priced (no input/output split)', () => {
    expect(estimateCostUsd('gpt-4o', {})).toBeNull();
    expect(estimateCostUsd('gpt-4o', { inputTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it('cache write uses its own rate when the table carries one', () => {
    // claude-sonnet-4-5: cache write $3.75 / 1M.
    const est = estimateCostUsd('claude-sonnet-4-5', { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 });
    expect(est!.costUsd).toBeCloseTo(3.75, 8);
  });
});
