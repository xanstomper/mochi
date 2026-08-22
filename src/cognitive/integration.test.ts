import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ContextEngine } from '../context.js';
import { evaluateOwl } from './owl.js';
import { loadDoxContract, auditDoxCloseout } from './dox.js';
import { evaluateSispis } from './sispis.js';
import { AnchorEngine } from './anchor.js';
import { synthesizeDeterministicContext, ChameleonEngine } from './chameleon.js';
import { chameleonTool } from '../tools/chameleon.js';
import { buildTools } from '../tools/index.js';
import { createTask } from '../goals/task.js';
import type { MochiConfig } from '../types.js';

function makeTestConfig(dir: string): MochiConfig {
  return {
    model: { provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free' },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 10,
      maxIterations: 10,
      maxRuntimeMinutes: 5,
      maxConcurrentAgents: 1,
      contextBudgetTokens: 4000,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true,
    verbose: false,
    debug: false,
  } as unknown as MochiConfig;
}

describe('Mochi Cognitive & Chameleon End-to-End Proof', () => {
  it('PROVE 1: Base system prompt injects Cognitive & Engineering Discipline directives', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-cog-proof-'));
    const config = makeTestConfig(dir);
    const context = new ContextEngine(config, dir);
    const tools = buildTools(config);
    const packet = context.buildPacket(Array.from(tools.values()).map((t) => t.def));

    expect(packet.systemPrompt).toContain('Cognitive & Engineering Discipline');
    expect(packet.systemPrompt).toContain('Operational Wisdom (OWL)');
    expect(packet.systemPrompt).toContain('Documented Contracts (DOX)');
    expect(packet.systemPrompt).toContain('State Continuity (ANCHOR)');
    expect(packet.systemPrompt).toContain('Test-Time Compute (Chameleon)');
  });

  it('PROVE 2: Volatile context dynamically injects zero-latency MoE invariants & boundary DAGs for coding tasks', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-moe-proof-'));
    const config = makeTestConfig(dir);
    const context = new ContextEngine(config, dir);
    const tools = buildTools(config);
    const task = createTask('Implement Rate Limiter', 'Build a distributed token bucket in Redis with atomic Lua script.');

    const packet = context.buildPacket(Array.from(tools.values()).map((t) => t.def), task);
    const stateMsg = packet.messages.find((m) => m.role === 'system' && m.content.includes('LAZY CHAMELEON DENSE SYNTHETIC DATASET'));

    expect(stateMsg).toBeDefined();
    expect(stateMsg!.content).toContain('LAZY CHAMELEON DENSE SYNTHETIC DATASET');
    expect(stateMsg!.content).toContain('[INV-1]');
    expect(stateMsg!.content).toContain('System Invariants');
    expect(stateMsg!.content).toContain('Boundary Conditions');
    expect(stateMsg!.content).toContain('Hazard Mitigation Matrix');
    expect(stateMsg!.content).toContain('Cellular Execution DAG');
  });

  it('PROVE 3: Chameleon tool executes cellular MoE decomposition with zero added latency on flash mode', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-tool-proof-'));
    const config = makeTestConfig(dir);
    const ctx = { config, cwd: dir } as any;

    const result = await chameleonTool.execute(
      { task: 'Refactor auth token validation to use public key rotation', mode: 'flash' },
      ctx,
    );

    expect(result).toContain('Chameleon flash');
    expect(result).toContain('0 tokens');
    expect(result).toContain('LAZY CHAMELEON DENSE SYNTHETIC DATASET');
    expect(result).toContain('System Invariants');
    expect(result).toContain('MOE EXPANSION');
  });

  it('PROVE 4: AnchorEngine preserves epistemic claims and blocks rejected approach repetition', () => {
    const anchor = new AnchorEngine();
    anchor.recordClaim('Redis cluster is running on port 6379', 'Verified');
    anchor.recordClaim('Node driver supports pipelining', 'Observed');
    anchor.rejectApproach('evalsha without fallback', 'Throws NOSCRIPT when script cache is flushed');

    expect(anchor.isApproachRejected('evalsha without fallback')).toBe(true);
    expect(anchor.isApproachRejected('atomic multi-exec')).toBe(false);

    const memory = anchor.renderContinuityContext();
    expect(memory).toContain('[VERIFIED]');
    expect(memory).toContain('[REJECTED]');
    expect(memory).toContain('Throws NOSCRIPT');
  });

  it('PROVE 5: OwlEngine detects engineering risk and emits high-weight principles', () => {
    const taskWithRisk = 'Refactor the global authentication singleton and delete legacy password verification logic';
    const owl = evaluateOwl(taskWithRisk);

    expect(owl.cumulativeWeight).toBeGreaterThan(0.5);
    expect(owl.signals.length).toBeGreaterThan(0);
    expect(owl.formattedFindings.length).toBeGreaterThan(0);
    expect(owl.formattedFindings.some((f) => f.includes('[OWL'))).toBe(true);
  });

  it('PROVE 6: DoxEngine crawls AGENTS.md contract and enforces closeout compliance', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-dox-proof-'));
    writeFileSync(resolve(dir, 'AGENTS.md'), '# Project Contracts\n- Never edit dist directly.\n- Must maintain 100% type safety.\n');

    const dox = loadDoxContract(dir);
    expect(dox.applicableDocs.length).toBeGreaterThan(0);
    expect(dox.constraints.length).toBeGreaterThanOrEqual(2);

    const audit = auditDoxCloseout(dir, ['src/index.ts']);
    expect(audit.needsUpdate).toBe(true);
  });

  it('PROVE 7: SispisEngine gates entropy to prevent over-structuring simple tasks', () => {
    const simple = evaluateSispis('What is the port for Redis?', 0.1);
    expect(simple.mode).toBe('NO_DECISION');

    const complex = evaluateSispis('Architectural review of architecture options for distributed database', 1.5);
    expect(complex.mode).toBe('SCHEMA');
    expect(complex.entropy).toBeGreaterThanOrEqual(0.7);
  });
});
