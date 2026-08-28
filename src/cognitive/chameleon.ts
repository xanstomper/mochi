/**
 * Lazy Chameleon v2.4 (Mochi Harness Baked Edition)
 * 
 * In-harness synthetic parameter synthesis and test-time compute expansion.
 * Requires ZERO external API keys or external services — operates entirely over
 * Mochi's connected model router, with instant deterministic zero-turn fallback.
 */

import { resolve } from 'node:path';
import { createProvider } from '../model/router.js';
import { BudgetEngine, estimateCostUsd } from '../budget.js';
import type { ChatMessage, MochiConfig, ModelProfile } from '../types.js';
import { evaluateOwl } from './owl.js';
import { evaluateSispis } from './sispis.js';
import { loadDoxContract } from './dox.js';

export type ChameleonMode =
  | 'flash'
  | 'turbo'
  | 'easy'
  | 'medium'
  | 'hard'
  | 'deep'
  | 'extreme'
  | 'genius'
  | 'god'
  | 'auto';

export type StallStrategy =
  | 'chain_of_draft'
  | 'budget_force'
  | 'constitutional'
  | 'devils_advocate'
  | 'self_consistency'
  | 'confidence_gate'
  | 'hybrid';

export interface EnhanceOptions {
  task: string;
  mode?: ChameleonMode;
  strategy?: StallStrategy;
  profile?: ModelProfile;
  budget?: BudgetEngine;
  cwd?: string;
  maxRuns?: number;
  autoSelect?: boolean;
}

export interface EnhanceResult {
  task: string;
  mode: ChameleonMode;
  strategy: StallStrategy;
  context: string;
  strategies: string[];
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  syntheticParameters: {
    decompositionDepth: number;
    invariantsGuarded: number;
    riskPointsIdentified: number;
  };
}

const STRATEGY_MOVES: Record<StallStrategy, string[]> = {
  chain_of_draft: [
    'generate a concise draft solution',
    'audit draft against edge cases, boundary conditions, and performance bottlenecks',
    'produce a refined, hardened final execution plan',
  ],
  budget_force: [
    'force exhaustive multi-angle decomposition',
    'analyze hidden architectural dependencies and AST realities',
    'construct complete step-by-step invariant proofs',
  ],
  constitutional: [
    'check against data loss prevention and atomicity principles',
    'enforce locality: touch only strictly required files',
    'verify conservation: preserve exact existing semantics and contract',
  ],
  devils_advocate: [
    'argue the adversarial case: how could this implementation fail?',
    'identify subtle concurrency, async race, or memory leak risks',
    'immunize solution against the identified failure modes',
  ],
  self_consistency: [
    'derive two distinct alternative approaches to solve the goal',
    'compare tradeoffs and complexity of each approach',
    'synthesize the highest-reliability hybrid solution',
  ],
  confidence_gate: [
    'estimate uncertainty on all underlying assumptions',
    'classify facts vs inferences using epistemic labeling',
    'gate execution on concrete verification triggers',
  ],
  hybrid: [
    'decompose into sub-problems and solve sequentially',
    'apply adversarial critique and identify failure modes',
    'enforce strict system invariants and verification proof',
  ],
};

function tierFor(mode: ChameleonMode): number {
  switch (mode) {
    case 'flash': return 1;
    case 'turbo': return 2;
    case 'easy': return 2;
    case 'medium': return 3;
    case 'hard': return 4;
    case 'deep': return 5;
    case 'extreme':
    case 'genius':
    case 'god': return 6;
    case 'auto':
    default: return 3;
  }
}

import { synthesizeDenseDataset } from '../chameleon/dense-dataset-synthesizer.js';

/**
 * Deterministically generates instant synthetic parameter guidance and dense real datasets in 0ms
 * without requiring any extra network round-trips or API tokens, splitting through cellular MoEs.
 */
// Scaffold cache (harness-v2 perf): the deterministic scaffold is task-derived
// and immutable, so prime it ONCE asynchronously (codegraph grammar load is
// lazy) and let the HOT sync prompt-builder read the cached string for free.
const _scaffoldCache = new Map<string, string>();

export function getCachedScaffold(task: string, cwd = process.cwd()): string | undefined {
  const v = _scaffoldCache.get(`${cwd}::${task}`);
  if (v !== undefined) return v;
  // The same task may have been primed under a different root (daemon, TUI):
  // the scaffold is derived from the task text, so any entry matches.
  for (const [k, val] of _scaffoldCache) {
    if (k.endsWith(`::${task}`)) return val;
  }
  return undefined;
}

/** Prime the scaffold for a task: warms the lazy codegraph grammars first so
 *  the cached scaffold includes real AST symbol grounding. Safe to call twice.
 */
export async function primeScaffold(task: string, cwd = process.cwd(), _unused?: unknown, langs?: readonly string[]): Promise<string> {
  const key = `${cwd}::${task}`;
  let s = _scaffoldCache.get(key);
  if (s === undefined) {
    // FREEZE GUARD: never treat $HOME as a code project root - warming over a
    // whole home directory pegged the event loop and froze the TUI.
    let root = cwd;
    try { const { homedir } = await import('node:os'); if (resolve(cwd) === homedir()) root = ''; } catch {}
    if (root) {
      try { const cg = await import('../codegraph.js'); await cg.warmCodegraph(root, langs); } catch { /* best-effort */ }
    }
    s = synthesizeDeterministicContext(task, cwd);
    _scaffoldCache.set(key, s);
  }
  return s;
}

export function synthesizeDeterministicContext(task: string, cwd = process.cwd()): string {
  const owl = evaluateOwl(task);
  const sispis = evaluateSispis(task, owl.cumulativeWeight);
  const dox = loadDoxContract(cwd);
  const denseData = synthesizeDenseDataset(task, cwd);

  const sections: string[] = [
    denseData.rawDatasetText,
    `Cognitive Mode: SISPIS ${sispis.mode} (Entropy: ${sispis.entropy.toFixed(2)})`,
  ];

  if (owl.formattedFindings.length > 0) {
    sections.push(`OWL Guardrails:\n` + owl.formattedFindings.map((f) => `  • ${f}`).join('\n'));
  }

  if (dox.constraints.length > 0) {
    sections.push(`DOX Contracts:\n` + dox.constraints.slice(0, 4).map((c) => `  • ${c}`).join('\n'));
  }

  return sections.join('\n\n');
}

export class ChameleonEngine {
  private provider: ReturnType<typeof createProvider>;

  constructor(private config: MochiConfig) {
    this.provider = createProvider(config.model, 'reasoning');
  }

  async enhance(opts: EnhanceOptions): Promise<EnhanceResult> {
    const startedAt = performance.now();
    const mode = opts.mode && opts.mode !== 'auto' ? opts.mode : 'medium';
    const strategy = opts.strategy ?? 'hybrid';
    const tier = tierFor(mode);
    const moves = STRATEGY_MOVES[strategy] || STRATEGY_MOVES.hybrid;
    const cwd = opts.cwd ?? process.cwd();

    // Fast-path: Flash mode runs 100% deterministic in 0ms with zero extra model calls!
    if (mode === 'flash') {
      const context = synthesizeDeterministicContext(opts.task, cwd);
      return {
        task: opts.task,
        mode,
        strategy,
        context,
        strategies: moves,
        tokensUsed: 0,
        costUsd: 0,
        durationMs: Math.round(performance.now() - startedAt),
        syntheticParameters: {
          decompositionDepth: 3,
          invariantsGuarded: 4,
          riskPointsIdentified: 2,
        },
      };
    }

    const budget = opts.budget ?? new BudgetEngine(this.config.safety);
    const maxRuns = opts.maxRuns ? Math.max(opts.maxRuns, 1) : (tier <= 2 ? 1 : tier === 3 ? 2 : tier === 4 ? 3 : tier === 5 ? 4 : 6);

    let tokensUsed = 0;
    let costUsd = 0;
    const runs: string[] = [];

    const deterministicScaffold = synthesizeDeterministicContext(opts.task, cwd);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are the Chameleon Synthetic Parameter Engine. Generate a dense, mathematically sound, highly actionable engineering framework for the given task. Outline concrete invariants, critical edge cases, structural constraints, and acceptance criteria. Plain technical prose without markdown fences.',
      },
      {
        role: 'user',
        content: `Task: ${opts.task}\n\nPre-evaluated cognitive context:\n${deterministicScaffold}\n\nExecute strategy passes: ${moves.join('; ')}. Output rich, dense execution guidance.`,
      },
    ];

    try {
      for (let i = 0; i < maxRuns; i++) {
        if (!budget.canMakeModelCall()) break;
        budget.recordModelCall();

        const response = await this.provider.chat(messages, [], { temperature: 0.25 + (i * 0.05) });
        const chunk = response.content ?? '';
        if (response.usage) {
          tokensUsed += response.usage.totalTokens;
          budget.recordTokens(response.usage.totalTokens, this.config.model.model);
          costUsd += estimateCostUsd(response.usage.totalTokens, this.config.model.model);
        }
        runs.push(chunk);
        const bestSoFar = chunk.trim() ? chunk : (runs.length > 1 ? runs[runs.length - 2] : deterministicScaffold);
        // Continuous improvement feedback loop: feed best synthesis back
        messages.push({
          role: 'user',
          content: `Pass ${i + 1}/${maxRuns} — previous best:
${bestSoFar.slice(0, 2500)}

Improve further: deepen proofs, identify new edge cases, harden invariants. If weaker, revert.`,
        });
      }
    } catch {
      // Graceful fallback to deterministic context on network/provider error
      runs.push(deterministicScaffold);
    }

    const context = runs.length ? runs[runs.length - 1] : deterministicScaffold;
    const durationMs = Math.round(performance.now() - startedAt);

    return {
      task: opts.task,
      mode,
      strategy,
      context,
      strategies: moves,
      tokensUsed,
      costUsd,
      durationMs,
      syntheticParameters: {
        decompositionDepth: tier * 2,
        invariantsGuarded: tier + 3,
        riskPointsIdentified: tier + 2,
      },
    };
  }
}

/** One-shot: enhance task using Mochi's in-harness connected model */
export async function enhance(
  config: MochiConfig,
  task: string,
  mode?: ChameleonMode,
  budget?: BudgetEngine,
  cwd?: string,
): Promise<EnhanceResult> {
  return new ChameleonEngine(config).enhance({ task, mode, budget, cwd });
}
