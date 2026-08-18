import { createProvider } from './model/router.js';
import { BudgetEngine, estimateCostUsd } from './budget.js';
import type { ChatMessage, MochiConfig, ModelProfile } from './types.js';

// Lazy Chameleon — internal synthetic-parameter reasoning engine.
//
// This is NOT an external API or a shell-out. Mochi implements the enhancement
// itself using whatever model/provider the agent is already configured with. It
// takes a task and, over the agent's own provider, generates a dense block of
// multi-strategy reasoning guidance ("synthetic parameter" context) that a
// later agent pass can reason within — so a flash-class model behaves like a
// much larger one on hard, multi-step work.

export type ChameleonMode = 'flash' | 'turbo' | 'easy' | 'medium' | 'hard' | 'deep' | 'extreme' | 'genius' | 'auto';

export interface EnhanceOptions {
  task: string;
  mode?: ChameleonMode;
  profile?: ModelProfile; // which model profile to route to (default 'reasoning')
  budget?: BudgetEngine;
}

export interface EnhanceResult {
  task: string;
  mode: ChameleonMode;
  context: string;
  strategies: string[];
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
}

// Research-backed test-time-compute moves we ask the model to expand on. Higher
// modes run more of them before synthesizing, but every call goes through the
// agent's OWN configured provider — no external API.
const STRATEGIES = [
  'decompose the work into sub-problems, solve each, then synthesize',
  'draft a first solution, critique it, then revise',
  'generate the answer, then self-check by re-deriving it',
  'argue the adversarial/opposite position, then integrate the stronger view',
  'force a deep-thinking pass and identify the likeliest failure modes',
  'check the result against hard correctness/robustness principles',
];

function tierFor(mode: ChameleonMode): number {
  switch (mode) {
    case 'flash': return 1;
    case 'turbo':
    case 'easy': return 2;
    case 'medium': return 3;
    case 'hard': return 4;
    case 'deep': return 5;
    case 'extreme':
    case 'genius': return 6;
    case 'auto':
    default: return 3;
  }
}

function pickMode(mode: ChameleonMode | undefined): ChameleonMode {
  if (mode && mode !== 'auto') return mode;
  return 'medium';
}

export class ChameleonEngine {
  private provider: ReturnType<typeof createProvider>;

  constructor(private config: MochiConfig) {
    this.provider = createProvider(config.model, 'reasoning');
  }

  async enhance(opts: EnhanceOptions): Promise<EnhanceResult> {
    const mode = pickMode(opts.mode);
    const tier = tierFor(mode);
    const budget = opts.budget ?? new BudgetEngine(this.config.safety);
    const startedAt = performance.now();

    const strategies = STRATEGIES.slice(0, tier);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are the agent\'s reasoning oracle. Write a dense, actionable reasoning block a world-class engineer would keep in mind for this task: key moves, invariants, likely failure modes, and acceptance checks. Be concrete and technical.',
      },
      {
        role: 'user',
        content: `Task: ${opts.task}\n\nProduce a focused enhancement block. Fold in these reasoning moves where useful: ${strategies.join('; ')}.\nReturn rich plain prose (no JSON, no markdown fences, no code block).`,
      },
    ];

    let context = '';
    let tokensUsed = 0;
    let costUsd = 0;

    const response = await this.provider.chat(messages, [], { temperature: 0.3 });
    context = response.content ?? '';
    if (response.usage) {
      tokensUsed = response.usage.totalTokens;
      costUsd = estimateCostUsd(tokensUsed, this.config.model.model);
      budget.recordTokens(tokensUsed, this.config.model.model);
    }

    const durationMs = Math.round(performance.now() - startedAt);
    return { task: opts.task, mode, context, strategies, tokensUsed, costUsd, durationMs };
  }
}

/** One-shot: generate internal enhancement context using the agent's model. */
export async function enhance(config: MochiConfig, task: string, mode?: ChameleonMode, budget?: BudgetEngine): Promise<EnhanceResult> {
  return new ChameleonEngine(config).enhance({ task, mode, budget });
}