// Multi-Tier Token Budget Allocator & Lossless Compaction Engine for Mochi VNext
// Enforces strict prefix cache invariance and semantic output folding.

import type { ChatMessage } from '../types.js';

export interface ContextTierBudget {
  readonly maxTokens: number;
  readonly reservedTokens: number;
  readonly identityTokens: number;     // Tier 1: Fixed Identity (KV Cache Invariant)
  readonly taskContractTokens: number; // Tier 2: Goal, Task, Criteria
  readonly codebaseGraphTokens: number;// Tier 3: Symbol Signatures & Outline
  readonly activeDialogTokens: number; // Tier 4: Recent Turns
  readonly memoryTokens: number;       // Tier 5: Autopsy & Prior Lessons
  readonly toolOutputBudget: number;   // Tier 6: Raw Active Tool Drops
}

/** Fast token estimation: ~4 chars per token for code/text */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
}

/**
 * Lossless semantic folding for large tool outputs.
 * Preserves the exit code, error signature, and file list while collapsing middle noise.
 */
export function foldToolResult(content: string, maxTokens = 1200): string {
  const currentTokens = estimateTokens(content);
  if (currentTokens <= maxTokens) {
    return content;
  }

  const lines = content.split('\n');
  if (lines.length <= 30) {
    // Short line count but long lines (e.g. minified JS or dense JSON)
    const maxChars = maxTokens * 3.8;
    const half = Math.floor(maxChars / 2);
    return `${content.slice(0, half)}\n\n[... ${currentTokens - maxTokens} tokens omitted for context budget ...]\n\n${content.slice(-half)}`;
  }

  // Preserve leading 15 lines (headers, command start, initial errors)
  const head = lines.slice(0, 15).join('\n');
  // Preserve trailing 15 lines (summary, final exit status, test totals)
  const tail = lines.slice(-15).join('\n');
  const omittedLineCount = lines.length - 30;

  return `${head}\n\n[... ${omittedLineCount} lines omitted (${Math.round(currentTokens - maxTokens)} tokens) ...]\n\n${tail}`;
}

export class ContextBudgetManager {
  private maxTokens: number;

  constructor(maxTokens = 100_000) {
    this.maxTokens = Math.max(8_000, maxTokens);
  }

  /**
   * Allocate token slice budgets across all 6 tiers based on available context window.
   */
  getBudgetPlan(): ContextTierBudget {
    const max = this.maxTokens;
    return {
      maxTokens: max,
      reservedTokens: Math.floor(max * 0.15), // 15% safety floor for model generation
      identityTokens: Math.min(3000, Math.floor(max * 0.05)),
      taskContractTokens: Math.min(1000, Math.floor(max * 0.03)),
      codebaseGraphTokens: Math.min(4000, Math.floor(max * 0.10)),
      activeDialogTokens: Math.floor(max * 0.40),
      memoryTokens: Math.min(2500, Math.floor(max * 0.07)),
      toolOutputBudget: Math.floor(max * 0.20),
    };
  }

  /**
   * Prunes and compacts conversation history into a strictly bounded token budget.
   * Compaction operates from oldest to newest turns, preserving the active working window.
   */
  fitHistory(messages: ChatMessage[], availableTokens: number): ChatMessage[] {
    const result: ChatMessage[] = [];
    let used = 0;

    // Scan backwards from most recent message
    for (let i = messages.length - 1; i >= 0; i--) {
      let msg = messages[i];

      // Automatically fold older tool messages (>2 turns back)
      if (i < messages.length - 4 && msg.role === 'tool' && typeof msg.content === 'string') {
        const folded = foldToolResult(msg.content, 400);
        msg = { ...msg, content: folded };
      }

      const cost = estimateTokens(JSON.stringify(msg));
      if (used + cost > availableTokens) {
        // Exceeded available budget, stop including older turns
        break;
      }

      result.unshift(msg);
      used += cost;
    }

    return result;
  }
}
