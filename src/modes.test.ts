// modes.ts: execution mode registry (spec 12-E / 13-C).
import { describe, it, expect } from 'vitest';
import { isMode, modeSpec, applyMode, modeInstruction, formatModes, MODE_IDS } from './modes.js';

const base = () => ({
  model: { provider: 'openai', baseUrl: 'x', model: 'gpt-4o-mini' },
  safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 5, maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
  permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
  telemetry: false, quiet: true, verbose: false, debug: false,
} as any);

describe('modes', () => {
  it('recognizes all five modes', () => {
    expect(MODE_IDS).toHaveLength(5);
    for (const m of MODE_IDS) expect(isMode(m)).toBe(true);
    expect(isMode('nope')).toBe(false);
  });

  it('spec mode yields TDD instructions and auto safety', () => {
    const spec = modeSpec('spec');
    expect(spec.label).toBe('Spec-Driven');
    expect(spec.instruction).toContain('SPEC MODE');
    expect(spec.instruction).toContain('SPEC.md');
    expect(modeInstruction('spec')).toContain('ACTIVE MODE');
  });

  it('normal mode appends no instruction block', () => {
    expect(modeInstruction('normal')).toBe('');
  });

  it('applyMode sets planMode + safety per mode, pure', () => {
    const cfg = base();
    const codemod = applyMode(cfg, 'codemod');
    expect(codemod.planMode).toBe(true);
    expect(cfg.planMode).toBeUndefined(); // original untouched
    const security = applyMode(cfg, 'security');
    expect(security.safety.mode).toBe('auto'); // normal leaves safety unchanged
  });

  it('formatModes lists every mode and marks the current one', () => {
    const out = formatModes('security');
    expect(out).toContain('spec');
    expect(out).toContain('codemod');
    expect(out).toContain('security');
    expect(out).toMatch(/\* security/);
  });
});