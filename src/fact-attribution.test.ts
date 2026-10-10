// MCH-63: fact outcome attribution tests.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mochi-mch63-'));
process.env['MOCHI_MEMORY_FILE'] = join(dir, 'memory.jsonl');

const store = await import('./memory-store.js');

afterAll(() => {
  delete process.env['MOCHI_MEMORY_FILE'];
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

describe('MCH-63 fact outcome attribution', () => {
  it('surfaced facts are tracked and drained once', async () => {
    const f = store.addFact('use bun test for this repo', 'convention', 'session');
    expect(f).not.toBeNull();
    // Digest render surfaces the fact -> records its id.
    const digest = store.memoryDigest('bun test conventions');
    expect(digest).toContain('bun test');
    const drained = store.takeSurfacedFactIds();
    expect(drained.length).toBeGreaterThanOrEqual(1);
    expect(drained).toContain(f!.id);
    // Drain clears: second drain is empty.
    expect(store.takeSurfacedFactIds()).toHaveLength(0);
  });

  it('recordFactAttempt success increments success_count; failure feeds pruning', async () => {
    const f = store.addFact('deploy via wrangler', 'fact', 'session');
    expect(f).not.toBeNull();
    store.recordFactAttempt(f!.id, true);
    store.recordFactAttempt(f!.id, true);
    let facts = store.loadFacts();
    let got = facts.find((x) => x.id === f!.id);
    expect(got?.success_count).toBe(2);
    expect(got?.attempts).toBe(2);
    // 3 consecutive failures (no successes) -> MAX_FAILS prunes on next load.
    store.recordFactAttempt(f!.id, false);
    store.recordFactAttempt(f!.id, false);
    store.recordFactAttempt(f!.id, false);
    facts = store.loadFacts();
    got = facts.find((x) => x.id === f!.id);
    expect(got).toBeUndefined(); // dead-end fact auto-pruned
  });
});
