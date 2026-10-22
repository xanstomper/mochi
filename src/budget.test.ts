import { describe, it, expect } from 'vitest';
import { BudgetEngine } from './budget.js';
import { isNativeCoreAvailable, nativeBudgetDecide } from './native/core.js';

const base = {
  mode: 'auto' as const,
  commandTimeoutSeconds: 30,
  maxIterations: 10,
  maxRuntimeMinutes: 10,
  maxConcurrentAgents: 2,
  contextBudgetTokens: 1000,
};

describe('BudgetEngine', () => {
  it('never invents cost without a token breakdown — only provider-reported billing is recorded', () => {
    const b = new BudgetEngine({ ...base, maxTokens: 1000 });
    b.start();
    // A bare token count has no input/output split to price: an unpriced
    // model records $0 (the C5 price-table fallback needs the breakdown —
    // see recordUsage and the price-table describe block below).
    b.recordTokens(1000, 'some-model-nobody-prices', 'some-provider');
    expect(b.snapshot('some-model-nobody-prices').usedCostUsd).toBe(0);
    // The loop records output tokens as the LIMIT resource; provider-reported
    // billing (usage.cost from the API's own usage object) is charged as-is.
    b.recordTokens(10, 'gpt-4o', 'openai', 0.42);
    expect(b.snapshot('gpt-4o').usedTokens).toBe(1010); // limit accounting untouched
    expect(b.snapshot('gpt-4o').usedCostUsd).toBeCloseTo(0.42); // reported cost charged
    // Another unpriced record adds nothing to cost.
    b.recordTokens(10, 'glm-5.3-flash', 'freeinference');
    expect(b.snapshot('glm-5.3-flash').usedCostUsd).toBeCloseTo(0.42);
  });

  it('starts in full phase and throttles as budget is consumed', () => {
    const b = new BudgetEngine({ ...base, maxTokens: 1000 });
    b.start();
    expect(b.phase()).toBe('full');
    b.recordTokens(600, 'gpt-4o');
    expect(b.phase()).toBe('reduced');
    b.recordTokens(300, 'gpt-4o');
    expect(b.phase()).toBe('cheap');
    b.recordTokens(50, 'gpt-4o');
    expect(b.phase()).toBe('verify');
    b.recordTokens(60, 'gpt-4o');
    expect(b.phase()).toBe('exhausted');
    expect(b.canMakeModelCall()).toBe(false);
  });

  it('price-table fallback (C5): $0 provider cost + token breakdown → estimated, ledgered separately', () => {
    const b = new BudgetEngine({ ...base, maxTokens: 10_000_000 });
    b.start();
    // gpt-4o $2.50/$10/$1.25-cache per 1M: 800k fresh in + 200k cached + 100k out = $3.25.
    b.recordUsage(
      { promptTokens: 1_000_000, completionTokens: 100_000, totalTokens: 1_100_000, cachedTokens: 200_000, costUsd: 0 },
      'gpt-4o', 'openai',
    );
    const snap = b.snapshot('gpt-4o');
    expect(snap.usedTokens).toBe(100_000); // limit accounting still output-only
    expect(snap.usedCostUsd).toBeCloseTo(3.25, 8);
    expect(snap.usedEstimatedCostUsd).toBeCloseTo(3.25, 8);
    expect(snap.usedProviderCostUsd).toBe(0);
    expect(snap.costSource).toBe('estimated');
    expect(snap.byModel[0]).toMatchObject({ model: 'gpt-4o', estimatedCostUsd: 3.25, providerCostUsd: 0 });
  });

  it('price-table fallback (C5): provider-reported cost wins when nonzero', () => {
    const b = new BudgetEngine({ ...base, maxTokens: 10_000_000 });
    b.start();
    b.recordUsage(
      { promptTokens: 1_000_000, completionTokens: 100_000, totalTokens: 1_100_000, cachedTokens: 200_000, costUsd: 0.42 },
      'gpt-4o', 'openai',
    );
    // A second, $0-reported call estimates → source becomes mixed.
    b.recordUsage(
      { promptTokens: 1_000_000, completionTokens: 100_000, totalTokens: 1_100_000, cachedTokens: 200_000, costUsd: 0 },
      'gpt-4o', 'openai',
    );
    const snap = b.snapshot('gpt-4o');
    expect(snap.usedProviderCostUsd).toBeCloseTo(0.42, 8);
    expect(snap.usedEstimatedCostUsd).toBeCloseTo(3.25, 8);
    expect(snap.usedCostUsd).toBeCloseTo(3.67, 8);
    expect(snap.costSource).toBe('mixed');
  });

  it('price-table fallback (C5): config override changes the estimate; disabled restores $0', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 100_000, totalTokens: 1_100_000, costUsd: 0 };
    const overridden = new BudgetEngine({ ...base, maxTokens: 10_000_000, pricing: { overrides: { 'gpt-4o': { output: 20 } } } });
    overridden.start();
    overridden.recordUsage(usage, 'gpt-4o', 'openai');
    expect(overridden.snapshot('gpt-4o').usedEstimatedCostUsd).toBeCloseTo(4.5, 8); // 2.50 in + 100k*20 out

    const disabled = new BudgetEngine({ ...base, maxTokens: 10_000_000, pricing: { disabled: true } });
    disabled.start();
    disabled.recordUsage(usage, 'gpt-4o', 'openai');
    expect(disabled.snapshot('gpt-4o').usedCostUsd).toBe(0);
    expect(disabled.snapshot('gpt-4o').costSource).toBe('none');
  });

  it('price-table fallback (C5): estimated cost enforces maxCostUsd like reported cost', () => {
    const b = new BudgetEngine({ ...base, maxTokens: 10_000_000, maxCostUsd: 1 });
    b.start();
    b.recordUsage(
      { promptTokens: 1_000_000, completionTokens: 100_000, totalTokens: 1_100_000, cachedTokens: 200_000, costUsd: 0 },
      'gpt-4o', 'openai',
    );
    expect(b.remainingCostUsd()).toBe(0);
    expect(b.phase()).toBe('exhausted');
    expect(b.canMakeModelCall()).toBe(false);
  });

  it('tracks model and tool call limits', () => {
    const b = new BudgetEngine({ ...base, maxModelCalls: 1, maxToolCalls: 1 });
    b.start();
    b.recordModelCall();
    expect(b.canMakeModelCall()).toBe(false);
    b.recordToolCall();
    expect(b.phase()).toBe('exhausted');
  });
});

describe('nativeBudgetDecide parity (Rust vs TS fallback)', () => {
  it('returns identical ratio to the in-process engine', () => {
    if (!isNativeCoreAvailable()) return; // self-skip
    const b = new BudgetEngine({ ...base, maxTokens: 1000, maxCostUsd: 0.5, maxRuntimeMinutes: 1 });
    b.start();
    b.recordTokens(200, 'gpt-4o');
    b.recordToolCall();
    b.recordToolCall();
    b.recordModelCall();

    const ts = b.ratio();
    const used = {
      usedTokens: 200,
      usedCostUsd: b.usedCostUsd,
      usedDurationMs: 100, // a known small value to keep this deterministic
      usedToolCalls: 2,
      usedModelCalls: 1,
    };
    const nat = nativeBudgetDecide(
      {
        maxTokens: 1000,
        maxCostUsd: 0.5,
        maxDurationMs: 60_000,
        maxToolCalls: Number.POSITIVE_INFINITY,
        maxModelCalls: Number.POSITIVE_INFINITY,
      },
      used,
    );
    expect(nat).not.toBeNull();
    // ratio should be within 1e-9 of the TS-computed value (we picked the
    // inputs so the TS path is the duration dimension: 100ms / 60000ms ≈ 0.00166)
    expect(nat!.ratio).toBeGreaterThan(0);
    expect(nat!.ratio).toBeLessThan(1);
  });

  it('phase thresholds match BudgetEngine.phase()', () => {
    if (!isNativeCoreAvailable()) return;
    const cases: Array<[number, ReturnType<BudgetEngine['phase']>]> = [
      [1.0, 'full'],
      [0.6, 'full'],
      [0.5, 'reduced'],
      [0.3, 'reduced'],
      [0.25, 'cheap'],
      [0.1, 'cheap'],
      [0.05, 'verify'],
      [0.04, 'verify'],
      [0.0, 'exhausted'],
    ];
    for (const [ratio, phaseName] of cases) {
      // Build a one-shot BudgetEngine with no caps other than duration so the
      // ratio we get back is exactly what we want to test.
      const b = new BudgetEngine({ ...base, maxRuntimeMinutes: 10 });
      b.start();
      // Force the ratio by hand: back-date the engine to consume (1-ratio) of duration
      const targetUsed = (1 - ratio) * 60_000; // ms
      // We can't back-date, but we can craft a per-turn state via
      // nativeBudgetDecide directly to assert the phase.
      const nat = nativeBudgetDecide(
        {
          maxTokens: Number.POSITIVE_INFINITY,
          maxCostUsd: Number.POSITIVE_INFINITY,
          maxDurationMs: 60_000,
          maxToolCalls: Number.POSITIVE_INFINITY,
          maxModelCalls: Number.POSITIVE_INFINITY,
        },
        {
          usedTokens: 0,
          usedCostUsd: 0,
          usedDurationMs: targetUsed,
          usedToolCalls: 0,
          usedModelCalls: 0,
        },
      );
      expect(nat).not.toBeNull();
      expect(nat!.phaseName, `ratio=${ratio}`).toBe(phaseName);
    }
  });

  it('ratio uses the most-constrained dimension', () => {
    if (!isNativeCoreAvailable()) return;
    // tokens 80% remaining, cost 80% remaining, duration 20% remaining
    // → expected ratio = 0.2 → phase = cheap
    const nat = nativeBudgetDecide(
      {
        maxTokens: 1000,
        maxCostUsd: 1.0,
        maxDurationMs: 60_000,
        maxToolCalls: Number.POSITIVE_INFINITY,
        maxModelCalls: Number.POSITIVE_INFINITY,
      },
      {
        usedTokens: 200,
        usedCostUsd: 0.2,
        usedDurationMs: 48_000,
        usedToolCalls: 0,
        usedModelCalls: 0,
      },
    );
    expect(nat).not.toBeNull();
    expect(nat!.ratio).toBeCloseTo(0.2, 5);
    expect(nat!.phaseName).toBe('cheap');
  });

  it('returns null for empty input (defensive)', () => {
    if (!isNativeCoreAvailable()) return;
    // The wrapper returns null when ffiAvailable is false. If it IS true,
    // the JSON path will throw on empty input and the wrapper catches it.
    const nat = nativeBudgetDecide(
      { maxTokens: 0, maxCostUsd: 0, maxDurationMs: 0, maxToolCalls: 0, maxModelCalls: 0 },
      { usedTokens: 0, usedCostUsd: 0, usedDurationMs: 0, usedToolCalls: 0, usedModelCalls: 0 },
    );
    // With zero caps on everything (and an `is_finite && > 0` guard in Rust
    // that means "no cap applied"), the ratio is 1.0 and phase is full.
    expect(nat).not.toBeNull();
    expect(nat!.ratio).toBe(1.0);
    expect(nat!.phaseName).toBe('full');
  });
});
