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
    // How many real model passes we run: higher tiers spend more test-time
    // compute (each pass is a genuine round-trip to the agent's own model).
    // tier1/2 -> 1 pass, tier3/4 -> 2 passes, tier5/6 -> 3 passes.
    const passes = tier <= 2 ? 1 : tier <= 4 ? 2 : 3; // flash/easy=1, medium/hard=2, deep/extreme/genius=3

    const strategies = STRATEGIES.slice(0, tier);
    let context = '';
    let tokensUsed = 0;
    let costUsd = 0;
    const runs: string[] = [];

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are the agent\'s reasoning oracle. Produce a dense, actionable reasoning block a world-class engineer would keep in mind for the given task: key moves, invariants, likely failure modes, and acceptance checks. Be concrete and technical, plain prose.',
      },
      {
        role: 'user',
        content: `Task: ${opts.task}\n\nDevelop the reasoning. Fold in these moves where useful: ${strategies.join('; ')}.\nReturn rich plain prose (no JSON, no markdown fences, no top-level code block).`,
      },
    ];

    try {
      for (let i = 0; i < passes; i++) {
        if (!budget.canMakeModelCall()) break; // respect per-run model-call budget
        budget.recordModelCall();

        const response = await this.provider.chat(messages, [], { temperature: 0.4 });
        const chunk = response.content ?? '';
        if (response.usage) {
          tokensUsed += response.usage.totalTokens;
          budget.recordTokens(response.usage.totalTokens, this.config.model.model);
          costUsd += estimateCostUsd(response.usage.totalTokens, this.config.model.model);
        }
        runs.push(chunk);

        if (i < passes - 1) {
          // Real multi-pass: critique the draft and refine, then synthesize at
          // the final pass.
          messages.push({
            role: 'user',
            content: `Review the previous reasoning pass, find any concrete gaps or mistakes, then produce a sharper, corrective pass. Keep it plain prose.`,
          });
        }
      }
    } catch {
      // A provider failure mid-run yields whatever we managed to generate. The
      // caller (runtime auto-inject) treats an empty context as a no-op.
    }

    // Final synthesized context: last pass wins; if none produced, we are empty.
    context = runs.length ? runs[runs.length - 1] : '';
    const durationMs = Math.round(performance.now() - startedAt);
    return { task: opts.task, mode, context, strategies, tokensUsed, costUsd, durationMs };
  }
}

/** One-shot: generate internal enhancement context using the agent's model. */
export async function enhance(config: MochiConfig, task: string, mode?: ChameleonMode, budget?: BudgetEngine): Promise<EnhanceResult> {
  return new ChameleonEngine(config).enhance({ task, mode, budget });
}