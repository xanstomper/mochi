import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryStore } from './memory.js';
import type { MemoryEntry } from './memory.js';
import { selectRelevant } from './relevance.js';
import { loadProjectSkills, formatSkillsForPrompt } from './skills.js';
import type { ChatMessage, MochiConfig, RepoInfo, Task, ToolDefinition } from './types.js';

const CANDIDATE_RULES = ['MOCHI.md', 'mochi.md', 'AGENTS.md', 'CLAUDE.md'];

// Cost-effective change detection: skip a file entirely when absent; otherwise
// fingerprint on size+mtime so a long agent run picks up edits without
// re-reading the full body every iteration.
function fingerprint(path: string): string {
  if (!existsSync(path)) return '';
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '';
  }
}

function rulesSource(path: string, label: string): string {
  return `Project rules (${label}):\n${readFileSync(path, 'utf8').slice(0, 4000)}`;
}

export function approxTokens(text: string): number {
  // Fast approximation: ~4 chars per token for code/English.
  return Math.ceil(text.length / 4);
}

export interface ContextState {
  goal?: string;
  completedTasks: string[];
  importantDecisions: string[];
  filesModified: string[];
  knownErrors: string[];
  constraints: string[];
  nextAction?: string;
}

export interface ContextPacket {
  messages: ChatMessage[];
  systemPrompt: string;
  usedTokens: number;
  budgetTokens: number;
}

export class ContextEngine {
  private messages: ChatMessage[] = [];
  state: ContextState;
  private budget: number;
  private projectRoot: string;
  private rulesCache = '';
  private rulesFingerprint = '';
  private memoryCache = '';
  private memoryFingerprint = '';
  private memoryQuery = '';
  private skillsCache = '';
  private skillsFingerprint = '';

  constructor(config: MochiConfig, projectRoot: string) {
    this.budget = config.safety.contextBudgetTokens;
    this.projectRoot = projectRoot;
    this.state = {
      completedTasks: [],
      importantDecisions: [],
      filesModified: [],
      knownErrors: [],
      constraints: [],
    };
  }

  setGoal(goal: string) {
    this.state.goal = goal;
  }

  updateState(patch: Partial<ContextState>) {
    const s = this.state as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      s[k] = v;
    }
  }

  addMessage(message: ChatMessage) {
    if (message.role === 'tool' && typeof message.content === 'string' && message.content.length > 6000) {
      const head = message.content.slice(0, 3000);
      const tail = message.content.slice(-1500);
      const trimmed = `${head}\n\n… [${message.content.length - 4500} lines omitted] …\n\n${tail}`;
      this.messages.push({ ...message, content: trimmed });
      return;
    }
    this.messages.push(message);
  }

  /** Rough size of the current transcript in approximate tokens (excludes the
   *  per-request system/state/tool headers, which are re-added separately). */
  estimateTokens(): number {
    let sum = 0;
    for (const m of this.messages) sum += approxTokens(JSON.stringify(m));
    return sum;
  }

  private loadMemory(query = ''): string {
    const fp = fingerprint(resolve(this.projectRoot, '.mochi', 'project.md'));
    // Re-select only when the underlying memory file or the query changes; a
    // stable task keeps the same relevant subset without re-reading the disk.
    if (fp !== this.memoryFingerprint || query !== this.memoryQuery) {
      this.memoryFingerprint = fp;
      this.memoryQuery = query;
      try {
        const store = new MemoryStore(resolve(this.projectRoot, '.mochi'));
        const entries = store.entries().map((e: MemoryEntry) => ({
          title: e.title,
          body: e.body,
          kind: e.kind,
          source: e.source,
          always: e.source === 'project.md',
        }));
        const relevant = query
          ? selectRelevant(query, entries, { maxTokens: 2000 })
          : entries;
        this.memoryCache = relevant
          .map((e) => `${e.title}\n${e.body}`)
          .join('\n\n')
          .slice(0, 2000);
      } catch {
        this.memoryCache = '';
      }
    }
    return this.memoryCache;
  }

  private loadProjectRules(): string {
    for (const f of CANDIDATE_RULES) {
      const path = resolve(this.projectRoot, f);
      const fp = fingerprint(path);
      if (fp === '') continue;
      // First touch: read and cache.
      if (this.rulesFingerprint !== fp) {
        this.rulesFingerprint = fp;
        this.rulesCache = rulesSource(path, f);
      }
      return this.rulesCache;
    }
    return this.rulesCache;
  }

  /** Advertise project skills in the system prompt so the model knows to load
   *  them. Recomputes only when the skills dir fingerprint changes. */
  private skills(): string {
    const skillsDir = resolve(this.projectRoot, '.mochi', 'skills');
    const fp = fingerprint(skillsDir);
    if (fp === '' || fp === this.skillsFingerprint) return this.skillsCache;
    try {
      this.skillsFingerprint = fp;
      const { skills } = loadProjectSkills(this.projectRoot);
      this.skillsCache = formatSkillsForPrompt(skills);
    } catch {
      this.skillsCache = '';
    }
    return this.skillsCache;
  }

  private buildSystemPrompt(tools: ToolDefinition[], repo?: RepoInfo, task?: Task): string {
    const rules = this.loadProjectRules();
    const query = task ? `${task.title} ${task.description}` : this.state.goal ?? '';
    const memory = this.loadMemory(query);
    const repoInfo = repo ? `
Repository:
- language: ${repo.language ?? 'unknown'}
- framework: ${repo.framework ?? 'unknown'}
- package manager: ${repo.packageManager ?? 'unknown'}
- build: ${repo.buildCommand ?? 'unknown'}
- test: ${repo.testCommand ?? 'unknown'}
- lint: ${repo.lintCommand ?? 'unknown'}
- typecheck: ${repo.typecheckCommand ?? 'unknown'}
- important dirs: ${repo.importantDirs?.join(', ') ?? 'unknown'}
- entrypoints: ${repo.entrypoints?.join(', ') ?? 'unknown'}
` : '';
    return `You are Mochi, a minimal, fast, autonomous coding agent built for the terminal. You finish real work: you read what you need, change what must change, verify it, and stop when it is done.

# Operating principles

1. Identity & mindset
   - You are precise, decisive, and efficient. You value small, correct changes over sprawling rewrites.
   - You are an expert engineer, not a chat bot: you reason about the codebase, ship working code, and take responsibility for verifying it.
   - You prefer to complete a task end to end rather than stop at the first plausible step.

2. Move with intent, not noise
   - Inspect the smallest surface needed before editing (open a file, read a symbol, follow one caller). Use the symbol tools (get_function, find_callers, type_hierarchy) instead of whole-file reads when you only need one definition.
   - Act decisively off what you already know. Do not repeat identical inspections, do not re-read the same file twice, do not narrate your reasoning to the user.
   - Reason internally; keep user-facing output terse and concrete.

3. Small, reviewable changes
   - Prefer surgical patches over touching whole files. Preserve the existing style and conventions.
   - Match the project's patterns, types, and idioms. Fit in, don't fight the codebase.
   - When a change has a clear, low-risk next step, take it.

4. Verify everything
   - After editing, run the project's build, typecheck, and tests (or the nearest available check). Never claim something works that you have not seen pass.
   - When a check fails, read the failure, fix the root cause, and re-run until green. Do not paper over errors.
   - Treat verification as part of "done", not as an optional extra.

5. Safety and permission
   - Never run destructive commands (forced git pushes, destructive deletes, remote mutation) without explicit user approval.
   - When an action is irreversible or costly, confirm intent instead of guessing.

6. Work within your budget
   - Be aware of token and cost budgets. Prefer lean tool calls, short targeted reads, and finishing in as few steps as possible.
   - Stop iterating as soon as you have produced a correct, verified result. Resist polishing forever.

7. Stay correct, even on hard problems
   - Decompose hard work into sub-problems, solve each, then integrate.
   - For hard, multi-step tasks, think deeply first: state the invariants, likely failure modes, and acceptance checks before acting.
   - When something is ambiguous, choose the interpretation that best serves the user's goal, state it briefly, then proceed.

8. Learn from the codebase
   - Honor project rules, memory, and conventions. If the repo has an established pattern, follow it.
   - Carry forward what previous steps decided and learned; avoid re-deriving settled conclusions.

${rules ? rules + '\n' : ''}${memory ? `Project memory:\n${memory}\n` : ''}${repoInfo}${this.skills()}
`.trim();
  }

  private buildStatePrompt(task?: Task): string {
    const lines: string[] = [];
    lines.push('## Current State');
    if (this.state.goal) lines.push(`Goal: ${this.state.goal}`);
    if (task) {
      lines.push(`Task: ${task.title}`);
      lines.push(`Description: ${task.description}`);
      lines.push(`Acceptance criteria: ${task.acceptanceCriteria.join('; ')}`);
    }
    if (this.state.nextAction) lines.push(`Next action: ${this.state.nextAction}`);
    if (this.state.completedTasks.length) lines.push(`Completed tasks: ${this.state.completedTasks.join(', ')}`);
    if (this.state.filesModified.length) lines.push(`Files modified: ${this.state.filesModified.join(', ')}`);
    if (this.state.knownErrors.length) lines.push(`Known errors: ${this.state.knownErrors.join('; ')}`);
    if (this.state.importantDecisions.length) lines.push(`Important decisions: ${this.state.importantDecisions.join('; ')}`);
    if (this.state.constraints.length) lines.push(`Constraints: ${this.state.constraints.join('; ')}`);
    return lines.join('\n');
  }

  buildPacket(tools: ToolDefinition[], task?: Task, repo?: RepoInfo): ContextPacket {
    const systemPrompt = this.buildSystemPrompt(tools, repo, task);
    const statePrompt = this.buildStatePrompt(task);
    const toolPrompt = `## Available Tools\n` + tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');

    let remaining = this.budget - approxTokens(systemPrompt) - approxTokens(statePrompt) - approxTokens(toolPrompt);

    // Add recent messages until budget exhausted; prefer latest.
    const recent: ChatMessage[] = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      const text = JSON.stringify(m);
      const tokens = approxTokens(text);
      if (remaining - tokens < 0) break;
      remaining -= tokens;
      recent.unshift(m);
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: statePrompt },
      ...recent,
    ];
    if (recent.length === 0 || recent[recent.length - 1].role !== 'user') {
      messages.push({ role: 'user', content: 'Proceed with the task using tools.' });
    }

    const used = this.budget - remaining;
    return { messages, systemPrompt, usedTokens: used, budgetTokens: this.budget };
  }

  addDecision(decision: string) {
    if (!this.state.importantDecisions.includes(decision)) {
      this.state.importantDecisions.push(decision);
      if (this.state.importantDecisions.length > 20) this.state.importantDecisions.splice(0, this.state.importantDecisions.length - 20);
    }
  }

  addKnownError(error: string) {
    if (!this.state.knownErrors.includes(error)) {
      this.state.knownErrors.push(error);
      if (this.state.knownErrors.length > 20) this.state.knownErrors.splice(0, this.state.knownErrors.length - 20);
    }
  }

  addModifiedFile(path: string) {
    if (!this.state.filesModified.includes(path)) {
      this.state.filesModified.push(path);
      if (this.state.filesModified.length > 20) this.state.filesModified.splice(0, this.state.filesModified.length - 20);
    }
  }

  private stateLedger(): string {
    const s = this.state;
    const parts: string[] = [];
    if (s.goal) parts.push(`Goal: ${s.goal}`);
    if (s.filesModified.length) parts.push(`Files modified: ${s.filesModified.join(', ')}`);
    if (s.knownErrors.length) parts.push(`Known errors: ${s.knownErrors.join('; ')}`);
    if (s.importantDecisions.length) parts.push(`Decisions: ${s.importantDecisions.join('; ')}`);
    return parts.join('\n');
  }

  compact() {
    // Tier 1 (micro): drop everything but the recency window and distill small facts.
    if (this.messages.length <= 6) return;
    const keep = 6;
    const dropped = this.messages.slice(0, this.messages.length - keep);
    this.messages = this.messages.slice(-keep);

    const facts: string[] = [];
    for (const m of dropped) {
      if (m.role === 'tool') {
        const c = typeof m.content === 'string' ? m.content : '';
        if (c.length !== 0 && c.length < 500) {
          if (m.name) facts.push(`${m.name}: ${c.slice(0, 200)}`);
          else this.addDecision(`Earlier result: ${c.slice(0, 200)}`);
        }
      } else if (m.role === 'assistant' && typeof m.content === 'string') {
        const t = m.content.trim();
        if (t.length > 0 && t.length < 80 && /(decided|will|should|fix(?:ed)?|conclud)/i.test(t)) {
          this.addDecision(t.slice(0, 200));
        }
      }
    }

    // Tier 2 (semantic): re-inject a compact ledger so the model keeps high-level
    // memory without the raw history (avoids over-thinking on long runs).
    const ledger = this.stateLedger();
    if (facts.length || ledger) {
      const body = [ledger, facts.length ? 'Session facts:\n' + facts.join('\n') : ''].filter(Boolean).join('\n');
      if (body.trim()) this.messages.push({ role: 'system', content: `Earlier in this session (compacted):\n${body}` });
    }
  }
}

