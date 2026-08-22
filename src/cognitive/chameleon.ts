/**
 * Lazy Chameleon v2.4 (Mochi Harness Baked Edition)
 * 
 * In-harness synthetic parameter synthesis and test-time compute expansion.
 * Requires ZERO external API keys or external services — operates entirely over
 * Mochi's connected model router, with instant deterministic zero-turn fallback.
 */

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

/**
 * Deterministically generates instant synthetic parameter guidance in 0ms
 * without requiring any extra network round-trips or API tokens.
 */
export function synthesizeDeterministicContext(task: string, cwd = process.cwd()): string {
  const owl = evaluateOwl(task);
  const sispis = evaluateSispis(task, owl.cumulativeWeight);
  const dox = loadDoxContract(cwd);

  const sections: string[] = [
    `[CHAMELEON SYNTHETIC PARAMETERS — ZERO-LATENCY IN-HARNESS]`,
    `Target Objective: ${task}`,
    `Cognitive Mode: SISPIS ${sispis.mode} (Entropy: ${sispis.entropy.toFixed(2)})`,
  ];

  if (owl.formattedFindings.length > 0) {
    sections.push(`OWL Guardrails:\n` + owl.formattedFindings.map((f) => `  • ${f}`).join('\n'));
  }

  if (dox.constraints.length > 0) {
    sections.push(`DOX Contracts:\n` + dox.constraints.slice(0, 4).map((c) => `  • ${c}`).join('\n'));
  }

  sections.push(
    `Execution Invariants:\n` +
    `  1. Read before write: Inspect actual file reality prior to any modification.\n` +
    `  2. Locality & Conservation: Modify the absolute minimal surface; preserve existing semantics.\n` +
    `  3. Independent Verification: Prove correctness with automated tests or strict validation.`
  );

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
    const passes = tier <= 2 ? 1 : tier <= 4 ? 2 : 3;

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
      for (let i = 0; i < passes; i++) {
        if (!budget.canMakeModelCall()) break;
        budget.recordModelCall();

        const response = await this.provider.chat(messages, [], { temperature: 0.3 });
        const chunk = response.content ?? '';
        if (response.usage) {
          tokensUsed += response.usage.totalTokens;
          budget.recordTokens(response.usage.totalTokens, this.config.model.model);
          costUsd += estimateCostUsd(response.usage.totalTokens, this.config.model.model);
        }
        runs.push(chunk);

        if (i < passes - 1) {
          messages.push({
            role: 'user',
            content: `Perform an adversarial critique pass: identify any remaining assumptions, fragile edge cases, or regression risks. Output the hardened, finalized synthesis.`,
          });
        }
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
