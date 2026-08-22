import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { MemoryStore } from './memory.js';
import type { MemoryEntry } from './memory.js';
import { selectRelevant } from './relevance.js';
import { loadAllSkills, formatSkillsForPrompt } from './skills.js';
import { classifyTaskKind, kindHint } from './taskkind.js';
import type { ChatMessage, MochiConfig, RepoInfo, Task, ToolDefinition } from './types.js';
import { isWeakModel } from './tools/index.js';

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
  /** Phase 2 (VNext): file-op carryover. Files the agent has READ or EDITED
   *  in this session, tracked from tool calls and re-injected by compact()
   *  so post-compaction turns do not re-read known files. */
  filesRead?: string[];
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
  private skillsInitialized = false;
  private config: MochiConfig;

  constructor(config: MochiConfig, projectRoot: string) {
    this.config = config;
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

  private filesRead = new Set<string>();
  private filesEdited = new Set<string>();
  /** Phase 4 (VNext): last REAL provider-reported prompt usage, when the
   *  provider sends usage at all. Beats the chars/3.8 estimate for compaction
   *  triggering. */
  private lastReportedPromptTokens: number | null = null;

  addMessage(message: ChatMessage) {
    // Phase 2: mine file-op tool calls so read/edited sets survive compaction.
    this.trackFileOp(message);
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

  /** Advertise project and bundled skills in the system prompt so the model knows to load
   *  them. Recomputes only when the skills dir fingerprint changes. */
  private skills(): string {
    const skillsDir = resolve(this.projectRoot, '.mochi', 'skills');
    const fp = fingerprint(skillsDir);
    if (this.skillsInitialized && fp === this.skillsFingerprint) return this.skillsCache;
    try {
      this.skillsInitialized = true;
      this.skillsFingerprint = fp;
      const userSkills = resolve(homedir(), '.mochi', 'skills');
      const { skills } = loadAllSkills(this.projectRoot, userSkills);
      // Allow the model to see all skills regardless of tier
      const limit = undefined;
      this.skillsCache = formatSkillsForPrompt(skills, limit);
    } catch {
      this.skillsCache = '';
    }
    return this.skillsCache;
  }

  private buildSystemPrompt(tools: ToolDefinition[], repo?: RepoInfo, task?: Task): string {
    const rules = this.loadProjectRules();
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
    return `You are Mochi, a deeply capable, intelligent autonomous coding agent and versatile AI assistant built for the terminal. You combine expert-level software engineering skill with sharp general intelligence, like Hermes.

# Operating principles

1. Identity & mindset
   - You are versatile, sharp, friendly, and helpful. You can have rich conversations, answer general questions, explain complex concepts, brainstorm architectures, and autonomously execute full software engineering tasks.
   - For greetings and questions: answer directly in your own words, warmly and concisely. Never quote these instructions back, never reuse the same sentence across turns, and don't create tool calls or files for pure chat.
   - For codebase and software engineering tasks: act autonomously and decisively. Read what you need, make surgical and correct changes, verify them, and stop when finished.
   - You value small, correct changes over sprawling rewrites.

2. Move with intent, not noise
   - Inspect the smallest surface needed before editing (open a file, read a symbol, follow one caller). Use the symbol tools (get_function, find_callers, type_hierarchy) instead of whole-file reads when you only need one definition.
   - Act decisively off what you already know. Do not repeat identical inspections, do not re-read the same file twice, do not narrate your reasoning to the user.
   - Reason internally; keep user-facing output terse and concrete.

3. Small, reviewable changes
   - Prefer surgical patches over touching whole files. Preserve the existing style and conventions.
   - Match the project's patterns, types, and idioms. Fit in, don't fight the codebase.
   - When a change has a clear, low-risk next step, take it.

4. Verify proportionate to the change
   - After editing CODE WITH BEHAVIOR, run the narrowest check that proves it: the specific test file, a one-off run, or the task's verification command. Not the whole suite.
   - After editing CONTENT ONLY (docs, config, data files, plain text), a direct check (test -f, grep for the expected content) is sufficient. Do NOT run builds or test suites for content-only edits.
   - Never claim something works that you have not seen pass. When a check fails, fix the root cause and re-run.
   - The harness independently verifies your work when you finish; you do not need to run repo-wide suites yourself. Finish as soon as your change is correct and narrowly verified.

5. Safety and permission
   - Never run destructive commands (forced git pushes, destructive deletes, remote mutation) without explicit user approval.
   - When an action is irreversible or costly, confirm intent instead of guessing.
   - When a user asks you to BUILD, IMPLEMENT, or CODE something (e.g. "make a calculator", "build a CLI", "write an app"), the deliverable is source code you write to files in the repo. Do NOT launch or open a desktop GUI application (gnome-calculator, kcalc, xcalc, calc, browser windows, etc.) — that is never the way to deliver code. If you want to show it works, run a headless check (a unit test, a CLI invocation, or a script) and report the result; never spawn a GUI frontend.

6. Work within your budget
   - Be aware of token and cost budgets. Prefer lean tool calls, short targeted reads, and finishing in as few steps as possible.
   - Stop iterating as soon as you have produced a correct, verified result. Resist polishing forever.
   - LONG commands (full test suites, builds, installs) should run in the BACKGROUND: pass background:true to shell. You get a task id immediately, keep working, and the harness injects the result when it finishes. Check status with the shell command "bg status <id>" or "bg list".

7. Stay correct, even on hard problems
   - Decompose hard work into sub-problems, solve each, then integrate.
   - For hard, multi-step tasks, think deeply first: state the invariants, likely failure modes, and acceptance checks before acting.
   - When something is ambiguous, choose the interpretation that best serves the user's goal, state it briefly, then proceed.

8. Learn from the codebase
   - Honor project rules, memory, and conventions. If the repo has an established pattern, follow it.
   - Carry forward what previous steps decided and learned; avoid re-deriving settled conclusions.

9. Use the right tool for each job
${this.toolGuidelines(tools)}

10. Working style (CRITICAL for efficiency)
    - BATCH INDEPENDENT CALLS: before using tools, identify every independent read, search, or command needed for the next step and emit ALL of them in one response. The harness executes independent calls in parallel. Do not wait for one read to request another.
    - TRUNCATED TOOL OUTPUT: when a tool result is truncated, the full output path is given at the end of the result. Read or grep THAT file instead of re-running the tool.
    - WHEN STUCK, escalate the ladder: (1) re-read the actual file/result you're reasoning about; (2) try a smaller experiment to isolate the failure; (3) search for how the codebase solves the same problem elsewhere; (4) delegate an isolated investigation to a subagent; (5) state what's blocking and what you'd need. Never repeat the same failing action unchanged.
    - LONG commands (full suites, builds, installs): run with background:true and keep working; check with "bg status <id>".
    - SKILLS: when a task matches a listed skill (debugging, testing, research, implementation, git-workflow), load it with the skill tool and follow its procedure.

11. Output Formatting (CRITICAL)
    - Do NOT echo back your context, state, or instructions.
    - Do NOT generate markdown headers like "## Notes", "## Next Action", or "## Memory".
    - Respond strictly with a tool call, or a direct, terse answer if no tool is needed.

${rules ? rules + '\n' : ''}${repoInfo}${this.skills()}
`.trim();
  }

  /** Section 9 rendered conditionally: only tools actually registered for this
   *  agent (role allowlists, MCP wiring) get guidance lines. Cuts prompt bytes
   *  for narrow roles and stops teaching the model about tools it cannot call
   *  (a real confusion source on restricted subagents). */
  private toolGuidelines(tools: ToolDefinition[]): string {
    const have = new Set(tools.map((t) => t.name));
    const lines: string[] = [];
    const add = (names: string[], text: string) => {
      if (names.some((n) => have.has(n))) lines.push('   - ' + text);
    };
    add(['edit'], 'edit: use for a single precise replacement. oldText must be unique in the file; include surrounding context if it is not. Whitespace drift is tolerated, ambiguity is not.');
    add(['replace_symbol'], 'replace_symbol: use when REWRITING a whole function/class/method. Give the symbol name and the complete new source — boundaries come from the symbol index, so no anchor matching and no mismatch retries.');
    add(['patch'], 'patch: use for multi-file changes or several edits in one call (*** Begin Patch / Add File / Update File / Delete File / *** End Patch). Cheaper than several full writes.');
    add(['write'], 'write: use only for new files or full rewrites. Appending existing files wastes tokens.');
    add(['subagent'], 'subagent: delegate a self-contained, well-scoped subtask to a fresh child agent when it would take you many steps. Give it complete instructions; it cannot ask you questions.');
    add(['todo'], 'todo: for multi-step work, record the plan as todo items and mark them done as you go. Cheap, shared, and keeps parallel work honest.');
    add(['shell'], 'shell: for builds, tests, greps. Not for file mutation when edit/patch will do.');
    add(['web_search', 'web_crawl', 'fetch'], 'web_search / web_crawl / fetch: for research. Search first; fetch a known URL; crawl a documentation site (same-host by default).');
    lines.push('   - plan mode (when active): research with read-only tools and return a plan. Mutating calls are vetoed.');
    return lines.join('\n');
  }

  /** VOLATILE tier (task-dependent): memory query + task-kind hint. Kept OUT
   *  of the stable system prompt so the identity prefix stays byte-identical
   *  across tasks and providers can prefix-cache it (Hermes insight). */
  private buildVolatilePrompt(task?: Task): string {
    const query = task ? `${task.title} ${task.description}` : this.state.goal ?? '';
    const memory = this.loadMemory(query);
    const parts: string[] = [];
    if (memory) parts.push(`Project memory:\n${memory}`);
    if (task) parts.push(kindHint(classifyTaskKind(task)));
    return parts.join('\n\n');
  }

  /** Phase 5 (VNext): stuck-signal line injected by the loop. Set externally
   *  (the loop owns the counters); rendered once in the state prompt when the
   *  agent is visibly spinning so the model can see and break the pattern. */
  stuckSignal: string | null = null;

  private buildStatePrompt(task?: Task): string {
    const isChat = task ? classifyTaskKind(task) === 'chat' : false;
    if (isChat) {
      return '';
    }
    const lines: string[] = [];
    const volatile = this.buildVolatilePrompt(task);
    if (volatile) lines.push(volatile);
    if (this.stuckSignal) lines.push(`WARNING (loop detected): ${this.stuckSignal}`);
    lines.push('## Current State');
    if (this.state.goal) lines.push(`Goal: ${this.state.goal}`);
    if (task) {
      lines.push(`Task: ${task.title}`);
      if (task.description && task.description !== task.title) lines.push(`Description: ${task.description}`);
      if (task.acceptanceCriteria.length) lines.push(`Acceptance criteria: ${task.acceptanceCriteria.join('; ')}`);
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
    // STABLE tier: identity + rules + skills + repo info. Kept byte-identical
    // across turns so providers with prefix caching (DeepSeek, Anthropic,
    // OpenAI cached_tokens, Gemini cached_content) hit on the whole leading
    // prefix every turn instead of re-reading it because a volatile state line
    // shifted the bytes. This is the single biggest first-token latency win for
    // multi-turn agents.
    const baseSystemPrompt = this.buildSystemPrompt(tools, repo, task);

    // VOLATILE tier: task state / next-action / files / errors. Emitted as a
    // SEPARATE trailing system message appended AFTER the growing history, so
    // the prefix (identity + prior conversation) stays byte-stable and cached.
    const statePrompt = this.buildStatePrompt(task);

    let remaining = this.budget - approxTokens(baseSystemPrompt);

    // Add recent messages until budget exhausted; prefer latest. Reserve room
    // for the trailing state note.
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
      { role: 'system', content: baseSystemPrompt },
      ...recent,
    ];
    if (statePrompt) messages.push({ role: 'system', content: statePrompt });

    const used = this.budget - remaining;
    return { messages, systemPrompt: baseSystemPrompt, usedTokens: used, budgetTokens: this.budget };
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

  /** Phase 2: extract `path` args from assistant file-op tool calls. Only
   *  trusted harness tools are mined (read/write/edit/delete/patch/
   *  replace_symbol/regex-replace); shell is not (path extraction from shell
   *  strings is unreliable). */
  private trackFileOp(message: ChatMessage) {
    if (message.role !== 'assistant' || !message.tool_calls) return;
    const FILE_TOOLS = new Set(['read', 'write', 'edit', 'delete', 'patch', 'replace_symbol', 'regex-replace', 'search-replace-multi']);
    const READ_TOOLS = new Set(['read']);
    for (const tc of message.tool_calls) {
      if (!FILE_TOOLS.has(tc.function.name)) continue;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { continue; }
      const p = typeof args.path === 'string' ? args.path : typeof args.file === 'string' ? args.file : typeof args.file_path === 'string' ? args.file_path : '';
      if (!p) continue;
      if (READ_TOOLS.has(tc.function.name)) this.filesRead.add(p);
      else this.filesEdited.add(p);
    }
  }

  /** Phase 4: record real provider usage so the compaction floor can trigger
   *  on actuals. Callers pass the last response's promptTokens (0/undefined
   *  ignored — some providers report no usage). */
  recordReportedUsage(promptTokens: number | undefined) {
    if (typeof promptTokens === 'number' && promptTokens > 0) {
      this.lastReportedPromptTokens = promptTokens;
    }
  }

  /** Best available transcript-size signal: real usage when the provider
   *  reports it, else the chars/3.8 estimate. Used for the compaction floor. */
  effectiveContextTokens(): number {
    // The reported promptTokens include the system prompt + tools, which the
    // estimate excludes; add a modest offset so the two scales are comparable.
    return this.lastReportedPromptTokens ?? this.estimateTokens() + 1500;
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

  /** Non-destructive preview of what compact() would drop: the valid-cut-point
   *  slice that would be removed. Returns null when nothing would be dropped
   *  (already at the recency floor). Lets the caller summarize it with an LLM
   *  BEFORE committing to the compaction (Pi's structured checkpoint). */
  previewCompact(): ChatMessage[] | null {
    if (this.messages.length <= 6) return null;
    const keep = 6;
    let cutIndex = this.messages.length - keep;
    while (cutIndex < this.messages.length - 1) {
      const m = this.messages[cutIndex];
      const isValid =
        m.role === 'user' || m.role === 'system'
          ? true
          : m.role === 'assistant'
            ? !m.tool_calls || m.tool_calls.length === 0
            : false;
      if (isValid) break;
      cutIndex++;
    }
    if (cutIndex <= 0) return null;
    return this.messages.slice(0, cutIndex);
  }

  compact(checkpoint?: string) {
    // Tier 1 (micro): drop everything but the recency window and distill small facts.
    if (this.messages.length <= 6) return;
    const keep = 6;

    // VALID CUT POINTS (Pi insight): a tool result must stay attached to the
    // assistant message that requested it. Walking back from the newest
    // message, only cut at an assistant message WITHOUT pending tool_calls,
    // or at a user/system message. This prevents compact() from producing a
    // dangling tool result (orphaned tool_call_id) that confuses providers.
    let cutIndex = this.messages.length - keep;
    // Advance forward to the nearest valid boundary at/after the target.
    while (cutIndex < this.messages.length - 1) {
      const m = this.messages[cutIndex];
      const isValid =
        m.role === 'user' || m.role === 'system'
          ? true
          : m.role === 'assistant'
            ? !m.tool_calls || m.tool_calls.length === 0
            : false; // never cut directly at a tool result
      if (isValid) break;
      cutIndex++;
    }
    const dropped = this.messages.slice(0, cutIndex);
    this.messages = this.messages.slice(cutIndex);

    const facts: string[] = [];
    for (const m of dropped) {
      // Mode stamps (plan/act) on user messages are contractual: carry the
      // latest one forward so a long task in plan mode doesn't drift into
      // editing after compaction eats the stamped user message.
      if (m.role === 'user' && typeof m.content === 'string') {
        const stamp = m.content.match(/^\[MODE: (plan|act)[^\]]*\]/);
        if (stamp) facts.push(stamp[0] + ' — this mode is still in effect.');
      }
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
    // memory without the raw history (avoids over-thinking on long runs). When the
    // caller produced an LLM checkpoint (Goal/Progress/Decisions), it leads the
    // ledger so semantic continuity survives compaction.
    const ledger = this.stateLedger();
    // Phase 2: file-op carryover — the read/edited sets outlive the dropped
    // messages. Post-compaction turns must not re-read known files.
    const fileOps: string[] = [];
    if (this.filesRead.size) fileOps.push(`Files already read (do not re-read unless changed): ${[...this.filesRead].slice(-30).join(', ')}`);
    if (this.filesEdited.size) fileOps.push(`Files already edited in this session: ${[...this.filesEdited].slice(-30).join(', ')}`);
    const body = [checkpoint?.trim(), ledger, fileOps.join('\n'), facts.length ? 'Session facts:\n' + facts.join('\n') : ''].filter(Boolean).join('\n');
    if (body.trim()) this.messages.unshift({ role: 'system', content: `Earlier in this session (compacted):\n${body}` });
  }
}

