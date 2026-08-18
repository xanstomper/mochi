import { createProvider } from './model/router.js';
import { BudgetEngine, estimateCostUsd } from './budget.js';
import type { MochiConfig, ChatMessage } from './types.js';

// "Termix" is Mochi's baked-in multi-session workbench. It is NOT a separate
// app and it does NOT auto-launch: the user explicitly runs `mochi termix`.
// A Termix run opens N agent sessions that all speak through the agent's OWN
// configured provider (same model, no external API). The user chooses whether
// the sessions COMMUNICATE (they share a rolling broadcast channel so each
// session sees what its peers concluded) or STAY SEPARATE (fully isolated).

export type TermixMode = 'communicate' | 'separate';

export interface TermixOptions {
  mode: TermixMode;
  sessions: number; // number of parallel agent sessions (default 3)
  task: string; // the work given to every session
  config?: MochiConfig;
}

export interface SessionResult {
  index: number;
  role: string;
  steps: number;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  output: string;
  error?: string;
}

export interface TermixRun {
  mode: TermixMode;
  sessions: number;
  task: string;
  results: SessionResult[];
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
}

// Distinct session personas so each agent in a run takes a fresh angle.
// Higher session counts reuse personas from the start of the list.
const ROLES = [
  'Lead architect', 'Systems engineer', 'Adversarial reviewer', 'Distributed systems reviewer',
  'Performance/edge-case', 'UX & API designer', 'Security researcher', 'Reliability SRE',
  'Testability/QA', 'Maintainability/refactor',
];

const SYSTEM = (role: string, communicate: boolean) =>
  `You are a Mochi agent session with the angle: ${role}.${communicate
    ? '\nA shared broadcast channel is active: build on peer notes when present and keep your own <broadcast> note updated.'
    : '\nYou are isolated: work from first principles and do not reference other sessions.'}\nExecute the work directly with tools, then report a short, concrete outcome in plain prose (no fences).`;

const roleFor = (index: number): string => ROLES[index % ROLES.length];

function peerNotes(broadcast: string[], selfIndex: number): string {
  return broadcast.filter((line) => !line.startsWith(`[${selfIndex}]`)).join('\n');
}

function nextUserPrompt(i: number, mode: TermixMode, peer: string, mine: string): string {
  const base = i === 0 ? 'Work this task:' : 'Continue and strengthen the result, building on (not repeating) prior slices.';
  const shared = mode === 'communicate' && (i === 0 || peer)
    ? `\n\nPeer notes (shared channel):\n${peer || '(none yet)'}`
    : '';

  return `${base}${shared}${mine ? `\n\nMy prior notes:\n${mine}` : ''}\n\nTask: (provided above)\nProduce the next concrete slice of work${i === 0 ? '' : ' now'}.${mode === 'communicate' ? ' Keep exactly one <broadcast> tag (overwrite your own note), then give the output.' : ''}`;
}

async function runSession(
  config: MochiConfig,
  task: string,
  index: number,
  mode: TermixMode,
  broadcast: string[],
): Promise<SessionResult> {
  const budget = new BudgetEngine(config.safety);
  budget.start();
  const provider = createProvider(config.model, 'reasoning');
  const role = roleFor(index);
  const startedAt = performance.now();
  let mine = '';
  let tokensUsed = 0;
  let costUsd = 0;
  let steps = 0;
  let output = '';

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM(role, mode === 'communicate') },
    { role: 'user', content: task },
  ];

  try {
    for (let i = 0; i < 8; i++) {
      if (i === 0) {
        messages[1] = { role: 'user', content: task };
      } else {
        const peer = mode === 'communicate' ? peerNotes(broadcast, index) : '';
        messages.push({
          role: 'user',
          content: nextUserPrompt(i, mode, peer, mine),
        });
      }

      const response = await provider.chat(messages, [], { temperature: 0.5 });
      output = response.content ?? '';
      if (response.usage) {
        tokensUsed += response.usage.totalTokens;
        budget.recordTokens(response.usage.totalTokens, config.model.model);
        costUsd += estimateCostUsd(response.usage.totalTokens, config.model.model);
      }
      steps++;

      const bm = output.match(/<broadcast>\s*([^<]*)/);
      if (bm) {
        mine = `[${index}] ${bm[1].trim()}`;
        if (mode === 'communicate') {
          const existing = broadcast.findIndex((l) => l.startsWith(`[${index}]`));
          if (existing >= 0) broadcast[existing] = mine;
          else broadcast.push(mine);
        }
      }
      if (i > 0 && output.length < 240) break;
    }
  } catch (e) {
    return {
      index, role, steps, tokensUsed, costUsd,
      durationMs: Math.round(performance.now() - startedAt),
      output,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  return {
    index, role, steps, tokensUsed, costUsd,
    durationMs: Math.round(performance.now() - startedAt),
    output,
  };
}

/**
 * Run the multi-session Termix workbench using the agent's own provider.
 * `mode: 'communicate'` shares peer notes between sessions; `separate` keeps
 * them isolated.
 */
export async function termix(opts: TermixOptions): Promise<TermixRun> {
  if (!opts.config) throw new Error('termix requires a Mochi config');
  const sessions = Math.max(1, Math.min(opts.sessions || 3, 10));
  const startedAt = performance.now();
  const broadcast: string[] = [];

  const results = await Promise.all(
    Array.from({ length: sessions }, (_, i) =>
      runSession(opts.config!, opts.task, i, opts.mode, broadcast),
    ),
  );

  if (opts.mode === 'communicate') {
    for (const r of results) {
      if (!r.error && r.output) broadcast.push(`[${r.index}] ${r.output.slice(0, 400)}`);
    }
  }

  return {
    mode: opts.mode,
    sessions,
    task: opts.task,
    results,
    tokensUsed: results.reduce((s, r) => s + r.tokensUsed, 0),
    costUsd: results.reduce((s, r) => s + r.costUsd, 0),
    durationMs: Math.round(performance.now() - startedAt),
  };
}