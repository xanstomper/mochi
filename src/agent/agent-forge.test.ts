// Agent Forge: verifier-gated persona synthesis + lifecycle.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mineAgentForgeCandidates,
  validateForgedPersona,
  probeForgedPersona,
  persistForgedPersona,
  recordAgentForgeSpawn,
  trimStaleForgedPersonas,
  resolveForgedPersona,
  listForgedPersonas,
  loadAgentForgeRegistry,
  FORGE_MIN_RUNS,
  FORGE_MAX_ADDENDUM_CHARS,
  FORGE_PROBE_MAX_TOKEN_RATIO,
} from './agent-forge.js';
import { SPAWN_PRESETS } from '../teams/presets.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-forge-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function spawn(runId: string, preset: string | undefined, toolsUsed: string[], prompt = 'review the diff for null-deref regressions in the parser', runVerified = true) {
  return { runId, preset, role: preset ? undefined : 'reviewer', prompt, toolsUsed, runVerified };
}

describe('mining', () => {
  it('requires ≥ MIN verifier-passed runs per shape and groups by preset+tool fingerprint', () => {
    const spawns = [
      spawn('r1', 'pr-reviewer', ['read_file', 'grep']),
      spawn('r2', 'pr-reviewer', ['grep', 'read_file']),
      spawn('r3', 'pr-reviewer', ['grep', 'read_file']),
      spawn('r4', 'pr-reviewer', ['read_file', 'grep'], 'other prompt', false), // unverified → excluded
      spawn('r5', 'explorer', ['read_file', 'grep']), // different shape
    ];
    const cands = mineAgentForgeCandidates(spawns);
    expect(cands).toHaveLength(1);
    expect(cands[0].shapeKey).toBe('pr-reviewer::grep+read_file');
    expect(cands[0].provenanceRunIds).toEqual(['r1', 'r2', 'r3']);
    expect(cands[0].basePreset).toBe('pr-reviewer');
    expect(cands[0].observedTools).toEqual(['grep', 'read_file']);
  });

  it('returns nothing when every run of a shape is unverified (evidence bar)', () => {
    const spawns = [spawn('r1', 'coder', ['write', 'shell'], 'x', false), spawn('r2', 'coder', ['write', 'shell'], 'y', false)];
    expect(mineAgentForgeCandidates(spawns)).toHaveLength(0);
  });

  it('narrowest covering preset is the fallback base for bare-role shapes', () => {
    const spawns = [spawn('r1', undefined, ['grep']), spawn('r2', undefined, ['grep']), spawn('r3', undefined, ['grep'])];
    const cands = mineAgentForgeCandidates(spawns);
    expect(cands).toHaveLength(1);
    // Every preset covering {grep} vs the narrowest known preset.
    expect(Object.values(SPAWN_PRESETS).some((p) => p.name === cands[0].basePreset)).toBe(true);
  });
});

describe('static gate', () => {
  const base = SPAWN_PRESETS['pr-reviewer'];
  const cand = { shapeKey: 'k', basePreset: 'pr-reviewer', provenanceRunIds: ['1', '2', '3'], observedTools: [], avgPromptChars: 100, promptSamples: [] };

  it('accepts a clean persona delta', () => {
    const r = validateForgedPersona(cand, base, { systemAddendum: 'Focus on off-by-one errors in loops.', description: 'Loop-boundary reviewer' });
    expect(r.ok).toBe(true);
  });

  it('rejects addendum over the cap and empty fields', () => {
    const r = validateForgedPersona(cand, base, { systemAddendum: 'x'.repeat(FORGE_MAX_ADDENDUM_CHARS + 1), description: 'd' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('cap');
    const r2 = validateForgedPersona(cand, base, { systemAddendum: '', description: '' });
    expect(r2.ok).toBe(false);
  });

  it('HARD rule: persona allowlist can narrow but never widen the base', () => {
    const widen = validateForgedPersona(cand, base, { systemAddendum: 'ok', description: 'd', tools: [...base.tools, 'shell', 'write'] });
    expect(widen.ok).toBe(false);
    expect(widen.errors.join()).toContain('outside base preset');
    const narrow = validateForgedPersona(cand, base, { systemAddendum: 'ok', description: 'd', tools: base.tools.slice(0, 3) });
    expect(narrow.ok).toBe(true);
  });

  it('rejects mutation escalation even if the base is itself mutating', () => {
    const coder = SPAWN_PRESETS['coder'];
    const c2 = { ...cand, basePreset: 'coder' };
    // coder's own allowlist contains mutation tools; a persona adding one NOT
    // in the base (e.g. 'delete' if absent) must be caught.
    const r = validateForgedPersona(c2, coder, { systemAddendum: 'ok', description: 'd', tools: [...coder.tools, 'delete'].filter((t, i, a) => a.indexOf(t) === i) });
    if (coder.tools.includes('delete')) expect(r.ok).toBe(true); // base already has it — subset holds
    else {
      expect(r.ok).toBe(false);
      expect(r.errors.join()).toContain('mutation tools');
    }
  });
});

describe('probe gate', () => {
  const cand = { shapeKey: 'k', basePreset: 'pr-reviewer', provenanceRunIds: ['1', '2', '3'], observedTools: [], avgPromptChars: 50, promptSamples: ['review this'] };
  const persona = { basePreset: 'pr-reviewer', systemAddendum: 'Check loop bounds.', tools: undefined };

  it('passes when persona quality ≥ base and tokens within ratio', async () => {
    const prober = {
      probe: async (_p: string, cfg: { systemAddendum: string }) => {
        const isPersona = cfg.systemAddendum.includes('Check loop bounds');
        return { quality: isPersona ? 0.9 : 0.8, totalTokens: isPersona ? 900 : 1000 };
      },
    };
    const r = await probeForgedPersona(cand, persona, prober);
    expect(r.ok).toBe(true);
    expect(r.personaArm).toHaveLength(2);
    expect(r.baseArm).toHaveLength(2);
  });

  it('fails when persona quality is worse than base (probe-quality check)', async () => {
    const prober = {
      probe: async (_p: string, cfg: { systemAddendum: string }) => ({ quality: cfg.systemAddendum.includes('Check loop') ? 0.5 : 0.9, totalTokens: 100 }),
    };
    const r = await probeForgedPersona(cand, persona, prober);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('quality');
  });

  it('fails when persona burns more than the token ratio', async () => {
    const prober = {
      probe: async (_p: string, cfg: { systemAddendum: string }) => ({ quality: 1, totalTokens: cfg.systemAddendum.includes('Check loop') ? 2000 : 1000 }),
    };
    const r = await probeForgedPersona(cand, persona, prober);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain(String(FORGE_PROBE_MAX_TOKEN_RATIO).slice(0, 3));
  });
});

describe('persist + lifecycle', () => {
  const cand = { shapeKey: 'pr-reviewer::grep+read_file', basePreset: 'pr-reviewer', provenanceRunIds: ['1', '2', '3'], observedTools: [], avgPromptChars: 50, promptSamples: [] };
  const synth = { systemAddendum: 'Check loop bounds.', description: 'Loop reviewer' };
  const passGate = { ok: true, checks: [{ name: 'probe-quality', ok: true, detail: '0.9 ≥ 0.8' }], errors: [] };

  it('refuses to persist when the gate failed (verdict-gated persistence)', () => {
    const res = persistForgedPersona(root, cand, synth, { ok: false, checks: [], errors: ['probe-quality failed'] });
    expect('error' in res && res.error).toContain('refusing');
    expect(listForgedPersonas(root)).toHaveLength(0);
  });

  it('persists a gated persona on probation, promotes at ≥3 helpful / 0 regressions', () => {
    const p = persistForgedPersona(root, cand, synth, passGate);
    expect('name' in p).toBe(true);
    const name = (p as { name: string }).name;
    expect(loadAgentForgeRegistry(root).personas[name].state).toBe('probation');
    recordAgentForgeSpawn(root, name, { ok: true, helpfulness: 'helpful', tokens: 900 });
    recordAgentForgeSpawn(root, name, { ok: true, helpfulness: 'neutral', tokens: 850 });
    recordAgentForgeSpawn(root, name, { ok: true, helpfulness: 'helpful', tokens: 800 });
    expect(loadAgentForgeRegistry(root).personas[name].state).toBe('probation'); // 2 helpful < 3
    const after = recordAgentForgeSpawn(root, name, { ok: true, helpfulness: 'helpful', tokens: 700 });
    expect(after?.state).toBe('active');
    expect(after?.avgTokenDelta).toBeGreaterThan(0); // EMA recorded
    expect(readFileSync(join(root, '.mochi', 'agents', 'forge-log.jsonl'), 'utf8')).toContain('promoted');
  });

  it('discards a persona on its first attributable regression', () => {
    const p = persistForgedPersona(root, cand, synth, passGate);
    const name = (p as { name: string }).name;
    const after = recordAgentForgeSpawn(root, name, { ok: false, helpfulness: 'regression', tokens: 1200 });
    expect(after?.state).toBe('discarded');
    expect(resolveForgedPersona(root, name)).toBeUndefined(); // discarded → unresolvable
  });

  it('trims stale probation personas and records why', () => {
    const p = persistForgedPersona(root, cand, synth, passGate);
    const name = (p as { name: string }).name;
    const reg = loadAgentForgeRegistry(root);
    reg.personas[name].stateAt -= 15 * 24 * 60 * 60 * 1000; // 15 days stale
    writeFileSync(join(root, '.mochi', 'agents', 'registry.json'), JSON.stringify(reg, null, 2));
    const trimmed = trimStaleForgedPersonas(root);
    expect(trimmed).toContain(name);
    expect(loadAgentForgeRegistry(root).personas[name].lastReason).toContain('stale probation');
  });
});

describe('resolution (forged/<name> spawn target)', () => {
  it('resolves a persona to a preset delta: addendum appended, tools narrowed, access never widened', () => {
    const base = SPAWN_PRESETS['pr-reviewer'];
    const cand = { shapeKey: 'pr-reviewer::grep', basePreset: 'pr-reviewer', provenanceRunIds: ['1', '2', '3'], observedTools: [], avgPromptChars: 50, promptSamples: [] };
    const gate = { ok: true, checks: [{ name: 'probe-quality', ok: true }], errors: [] } as const;
    const p = persistForgedPersona(root, cand, { systemAddendum: 'Check loop bounds.', description: 'Loop reviewer', tools: base.tools.slice(0, 4) }, gate);
    const name = (p as { name: string }).name;
    const resolved = resolveForgedPersona(root, name);
    expect(resolved).toBeDefined();
    expect(resolved!.name).toBe(`forged/${name}`);
    expect(resolved!.systemAddendum).toContain(base.systemAddendum);
    expect(resolved!.systemAddendum).toContain('Check loop bounds');
    expect(resolved!.tools!.every((t) => base.tools.includes(t))).toBe(true);
    expect(resolved!.tools!.length).toBe(4);
    expect(resolved!.access).toBe(base.access); // NEVER widens
  });

  it('returns undefined for unknown/discarded personas (fail loud at spawn site)', () => {
    expect(resolveForgedPersona(root, 'nonexistent')).toBeUndefined();
    expect(resolveForgedPersona(root, 'discarded-one')).toBeUndefined();
  });

  it('resolveSpawnPreset: forged/<name> hits the registry, bare names fall through to static presets', async () => {
    const { resolveSpawnPreset } = await import('./agent-forge.js');
    expect(resolveSpawnPreset(root, 'pr-reviewer')).toBeUndefined(); // static names not our job
    expect(resolveSpawnPreset(root, 'forged/missing')).toBeUndefined();
    const base = SPAWN_PRESETS['pr-reviewer'];
    const cand = { shapeKey: 'pr-reviewer::grep', basePreset: 'pr-reviewer', provenanceRunIds: ['1', '2', '3'], observedTools: [], avgPromptChars: 50, promptSamples: [] };
    const gate = { ok: true, checks: [], errors: [] } as const;
    const p = persistForgedPersona(root, cand, { systemAddendum: 'Check loop bounds.', description: 'Loop reviewer' }, gate);
    const resolved = resolveSpawnPreset(root, `forged/${(p as { name: string }).name}`);
    expect(resolved?.systemAddendum).toContain('Check loop bounds');
  });
});
