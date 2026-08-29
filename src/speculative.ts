import { createProvider } from './model/router.js';
import type { MochiConfig } from './types.js';
import { BudgetEngine } from './budget.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redact } from './security.js';


// ─── Speculation memory: strategy→outcome records per workspace ──────────
// Every preflight that ran on a FINISHED task records which strategy class
// won and whether the task ended resolved. Future preflights on similar
// tasks retrieve these records, so strategy generation is biased by real
// outcomes instead of starting from zero each time (experience curve).

export interface SpeculationRecord {
  strategyClass: string;   // coarse archetype, e.g. "reproduce-minimal"
  taskTitle: string;       // raw title for keyword-overlap retrieval
  outcome: 'resolved' | 'unresolved';
  atMs: number;
}

export function speculationMemoryPath(workspaceDir: string): string {
  return resolve(workspaceDir, 'memory', 'speculation.json');
}

const MAX_SPECULATION_RECORDS = 200;

export function loadSpeculationMemory(workspaceDir: string): SpeculationRecord[] {
  try {
    const arr = JSON.parse(readFileSync(speculationMemoryPath(workspaceDir), 'utf8'));
    return Array.isArray(arr) ? (arr as SpeculationRecord[]).slice(-MAX_SPECULATION_RECORDS) : [];
  } catch {
    return [];
  }
}

export function recordSpeculationOutcome(workspaceDir: string, rec: SpeculationRecord): void {
  try {
    const all = loadSpeculationMemory(workspaceDir);
    all.push(rec);
    const trimmed = all.slice(-MAX_SPECULATION_RECORDS);
    mkdirSync(resolve(workspaceDir, 'memory'), { recursive: true });
    writeFileSync(speculationMemoryPath(workspaceDir), redact(JSON.stringify(trimmed, null, 2)));
  } catch { /* memory must never break the loop */ }
}

/** Keyword-overlap retrieval: past records whose taskTitle shares >=2 words
 *  (len>=4, lowercased) with the current task, most recent first. */
export function retrieveSpeculationMemory(workspaceDir: string, taskTitle: string, limit = 5): SpeculationRecord[] {
  const words = (t: string) =>
    new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  const cur = words(taskTitle);
  if (cur.size === 0) return [];
  return loadSpeculationMemory(workspaceDir)
    .filter((r) => {
      let overlap = 0;
      for (const w of words(r.taskTitle)) if (cur.has(w)) overlap++;
      return overlap >= 2;
    })
    .reverse()
    .slice(0, limit);
}

export function speculationMemoryToPrompt(recs: SpeculationRecord[]): string {
  if (!recs.length) return '';
  const lines = recs.map((r) => `- [${r.outcome}] "${r.taskTitle.slice(0, 70)}" → strategy class: ${r.strategyClass}`);
  return 'PAST STRATEGY OUTCOMES on similar tasks (learned from experience — prefer strategy classes that resolved, avoid re-deriving ones that stalled):\n' + lines.join('\n');
}

// Canonical strategy archetypes every generated strategy must declare.
const STRATEGY_CLASSES = [
  'root-cause-first (read the failing code/trace before touching anything)',
  'reproduce-minimal (build the smallest failing case, then fix it)',
  'bisect (narrow the change window until the break appears)',
  'dependency-audit (versions, imports, API contracts at the boundary)',
  'state-inspection (dump real runtime state; compare against expected)',
  'incremental-revert (roll back the suspect change, re-apply piecewise)',
].join('\n  ');


export interface SpeculativeCandidate {
  strategy: string;
  response: string;
  score?: number;
  /** Verifier's one-line reason this candidate won (on the best candidate). */
  verdictReason?: string;
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

  async speculate(question: string, context?: { pastOutcomes?: string }): Promise<SpeculativeResult> {
    if (!this.budget.canMakeModelCall()) {
      return { question, candidates: [], verifierNotes: 'Budget exhausted; speculation disabled.' };
    }
    const strategies = await this.generateStrategies(question, context?.pastOutcomes);
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

  private async generateStrategies(question: string, pastOutcomes?: string): Promise<string[]> {
    if (!this.budget.canMakeModelCall()) return [];
    this.budget.recordModelCall();
    const system =
      'You are the strategy-generation stage of a speculative reasoning engine.\n' +
      'Generate DIVERSE, INDEPENDENT attack strategies for the problem. Each strategy must:\n' +
      '- Declare its archetype from this canonical set:\n  ' + STRATEGY_CLASSES + '\n' +
      '- State its riskiest assumption (what makes it likely to fail).\n' +
      '- Name the concrete first evidence-gathering step (file, command, or probe).\n' +
      'Keep each strategy to 1-2 dense sentences. No filler, no overlap between strategies.' +
      (pastOutcomes ? '\n\n' + pastOutcomes + '\nWeight generation toward resolved classes and away from stalled ones.' : '');
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `Problem: ${question}\nReturn up to ${this.candidateCount} independent strategies as a JSON array of strings. Each string embeds: archetype, approach, riskiest assumption, first evidence step.` },
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
    const system =
      'You are the candidate-evaluation stage of a speculative reasoning engine. Develop the given strategy into an EXECUTABLE plan. Output exactly these five sections, terse and technical:\n' +
      'MECHANISM: why this attacks the likely root cause, not a symptom.\n' +
      'FIRST ACTIONS: 2-4 concrete steps (named files/commands/probes).\n' +
      'RISKIEST ASSUMPTION: the single belief that, if wrong, kills this plan — and the cheap check that falsifies it.\n' +
      'VERIFICATION: the exact signal (test/build/output) that proves success vs failure.\n' +
      'PITFALLS: 1-2 known failure modes of this approach and how to sidestep them.';
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `Problem: ${question}\n\nStrategy: ${strategy}` },
    ] as import('./types.js').ChatMessage[];
    const response = await this.provider.chat(messages, [], { temperature: 0.2 });
    if (response.usage) this.budget.recordTokens(response.usage.totalTokens, this.config.model.model);
    return response.content ?? '';
  }

  private async chooseBest(question: string, candidates: SpeculativeCandidate[]): Promise<SpeculativeCandidate | undefined> {
    if (!this.budget.canMakeModelCall()) return undefined;
    this.budget.recordModelCall();
    const body = candidates.map((c, i) => `Candidate ${i + 1}: ${c.strategy}\n${c.response}`).join('\n\n');
    const system =
      'You are the adversarial verifier of a speculative reasoning engine. Score EVERY candidate 1-10 on:\n' +
      '- evidence: grounded in the actual problem statement, not invented APIs\n' +
      '- specificity: named files/commands vs vague gestures\n' +
      '- risk: falsifiable assumption + cheap check present\n' +
      '- speed: time-to-first-signal\n' +
      'Return ONLY JSON: {"index":<best 1-based>,"reason":"<why it beats the others>","scores":[<cand1>,<cand2>,...]}.\n' +
      'Be adversarial: a plan with an uncheckable assumption must lose to a modest falsifiable one.';
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `Problem: ${question}\n\n${body}` },
    ] as import('./types.js').ChatMessage[];
    const response = await this.provider.chat(messages, [], { temperature: 0 });
    if (response.usage) this.budget.recordTokens(response.usage.totalTokens, this.config.model.model);
    try {
      const parsed = JSON.parse((response.content ?? '{}').replace(/```json\s*|\s*```/g, '').trim());
      const index = Number(parsed.index);
      if (!Number.isInteger(index) || index < 1 || index > candidates.length) return undefined;
      if (Array.isArray(parsed.scores)) {
        for (let i = 0; i < candidates.length; i++) {
          const v = Number(parsed.scores[i]);
          if (Number.isFinite(v)) candidates[i].score = v;
        }
      }
      const best = candidates[index - 1];
      best.score = best.score ?? 10;
      if (typeof parsed.reason === 'string' && parsed.reason.trim()) best.verdictReason = parsed.reason.trim();
      return best;
    } catch {
      return undefined;
    }
  }
}
