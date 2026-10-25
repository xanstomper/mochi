import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failureSignature, reproSynthEnabled, synthesizeRepro } from './repro-synth.js';

describe('repro synthesis (observability/repro-synth.ts)', () => {
  it('extracts the first failure-looking line, bounded', () => {
    const out = 'noise\nError: expected 1 to be 2\n    at test.ts:1';
    expect(failureSignature(out)).toBe('Error: expected 1 to be 2');
    expect(failureSignature('x'.repeat(500)).length).toBe(300);
    expect(failureSignature('')).toBe('');
  });

  it('validates a repro only when it actually FAILS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-repro-'));
    const failing = await synthesizeRepro(
      { repoRoot: dir, text: 'bug', source: 'task-text', testCommand: 'node -e "process.exit(1)"' },
      { inPlace: true, timeoutMs: 20_000 },
    );
    expect(failing.outcome).toBe('validated');
    expect(failing.candidate.origin).toBe('declared-test');
    expect(failing.validation.exitCode).toBe(1);
  });

  it('refuses to call a green command a reproduction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-repro-green-'));
    const green = await synthesizeRepro(
      { repoRoot: dir, text: 'bug', source: 'task-text', testCommand: 'node -e "process.exit(0)"' },
      { inPlace: true, timeoutMs: 20_000 },
    );
    expect(green.outcome).toBe('no-failure');
    expect(green.validation.signature).toBe('');
  });

  it('reports no-candidate rather than inventing a command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-repro-none-'));
    const none = await synthesizeRepro({ repoRoot: dir, text: 'nothing runnable here', source: 'task-text' });
    expect(none.outcome).toBe('no-candidate');
  });

  it('kill switch is readable', () => {
    const prev = process.env.MOCHI_REPRO_SYNTH;
    process.env.MOCHI_REPRO_SYNTH = '0';
    try {
      expect(reproSynthEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MOCHI_REPRO_SYNTH;
      else process.env.MOCHI_REPRO_SYNTH = prev;
    }
  });
});
