import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryStore } from './memory.js';
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

  private loadMemory(): string {
    const fp = fingerprint(resolve(this.projectRoot, '.mochi', 'project.md'));
    if (fp !== this.memoryFingerprint) {
      this.memoryFingerprint = fp;
      try {
        const memory = new MemoryStore(resolve(this.projectRoot, '.mochi')).load();
        this.memoryCache = memory ? memory.slice(0, 2000) : '';
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

  private buildSystemPrompt(tools: ToolDefinition[], repo?: RepoInfo): string {
    const rules = this.loadProjectRules();
    const memory = this.loadMemory();
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
    return `You are Mochi, a minimal, fast, autonomous coding agent for the terminal.
You operate in a terminal-native environment. You have access to tools.
Before editing, inspect the relevant files. Prefer small patches over rewriting whole files.
Always verify changes by running tests/build/typecheck when available.
Do not run destructive commands without explicit user approval.
WORK WITHOUT OVERTHINKING: act decisively, run lean tool sets, and stop as soon as you have enough to act. Do not repeat identical inspections.
Reason internally and tersely; do not narrate your decision process to the user or restate the task.
Use the symbol tools (get_function, find_callers, type_hierarchy) instead of reading whole files when you only need one definition.

${rules ? rules + '\n' : ''}${memory ? `Project memory:\n${memory}\n` : ''}${repoInfo}
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
    const systemPrompt = this.buildSystemPrompt(tools, repo);
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

