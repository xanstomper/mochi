import { createProvider } from './model/router.js';
import type { MochiConfig } from './types.js';
import { BudgetEngine } from './budget.js';

export interface SpeculativeCandidate {
  strategy: string;
  response: string;
  score?: number;
}

export interface SpeculativeResult {
  question: string;
  candidates: SpeculativeCandidate[];
  best?: SpeculativeCandidate;
  verifierNotes: string;
}

export class SpeculativeEngine {
  private provider: ReturnType<typeof createProvider>;

  constructor(private config: MochiConfig, private budget: BudgetEngine, private candidateCount = 3) {
    this.provider = createProvider(config.model, 'reasoning');
  }

  async speculate(question: string): Promise<SpeculativeResult> {
    if (!this.budget.canMakeModelCall()) {
      return { question, candidates: [], verifierNotes: 'Budget exhausted; speculation disabled.' };
    }
    const strategies = await this.generateStrategies(question);
    if (strategies.length === 0) {
      return { question, candidates: [], verifierNotes: 'No strategies generated.' };
    }

    const candidates: SpeculativeCandidate[] = [];
    const limited = strategies.slice(0, this.candidateCount);
    const responses = await Promise.all(limited.map((strategy) => this.evaluateStrategy(question, strategy)));
    for (let i = 0; i < limited.length; i++) {
      candidates.push({ strategy: limited[i], response: responses[i] });
    }

    const best = await this.chooseBest(question, candidates);
    return { question, candidates, best, verifierNotes: best ? 'Best strategy selected by verifier.' : 'Verifier failed.' };
  }

  private async generateStrategies(question: string): Promise<string[]> {
    if (!this.budget.canMakeModelCall()) return [];
    this.budget.recordModelCall();
    const messages = [
      { role: 'system', content: 'Generate independent debugging strategies. Return ONLY a JSON array of short strings.' },
      { role: 'user', content: `Problem: ${question}\nReturn up to ${this.candidateCount} independent strategies.` },
    ] as import('./types.js').ChatMessage[];
    const response = await this.provider.chat(messages, [], { temperature: 0.3 });
    if (response.usage) this.budget.recordTokens(response.usage.totalTokens, this.config.model.model);
    try {
      const parsed = JSON.parse((response.content ?? '[]').replace(/```json\s*|\s*```/g, '').trim());
      if (!Array.isArray(parsed)) return [];
      return parsed.map(String).filter((s) => s.trim().length > 0).slice(0, this.candidateCount);
    } catch {
      return [];
    }
  }

  private async evaluateStrategy(question: string, strategy: string): Promise<string> {
    if (!this.budget.canMakeModelCall()) return 'Budget exhausted.';
    this.budget.recordModelCall();
    const messages = [
      { role: 'system', content: 'Apply the specified strategy to the problem. Be concise and technical.' },
      { role: 'user', content: `Problem: ${question}\nStrategy: ${strategy}` },
    ] as import('./types.js').ChatMessage[];
    const response = await this.provider.chat(messages, [], { temperature: 0.2 });
    if (response.usage) this.budget.recordTokens(response.usage.totalTokens, this.config.model.model);
    return response.content ?? '';
  }

  private async chooseBest(question: string, candidates: SpeculativeCandidate[]): Promise<SpeculativeCandidate | undefined> {
    if (!this.budget.canMakeModelCall()) return undefined;
    this.budget.recordModelCall();
    const body = candidates.map((c, i) => `Candidate ${i + 1}: ${c.strategy}\n${c.response}`).join('\n\n');
    const messages = [
      { role: 'system', content: 'Select the best candidate. Return ONLY JSON: {"index":1,"reason":"..."}' },
      { role: 'user', content: `Problem: ${question}\n\n${body}` },
    ] as import('./types.js').ChatMessage[];
    const response = await this.provider.chat(messages, [], { temperature: 0 });
    if (response.usage) this.budget.recordTokens(response.usage.totalTokens, this.config.model.model);
    try {
      const parsed = JSON.parse((response.content ?? '{}').replace(/```json\s*|\s*```/g, '').trim());
      const index = Number(parsed.index);
      if (!Number.isInteger(index) || index < 1 || index > candidates.length) return undefined;
      const best = candidates[index - 1];
      best.score = 1;
      return best;
    } catch {
      return undefined;
    }
  }
}
