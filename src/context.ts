import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { MemoryStore } from './memory.js';
import type { MemoryEntry } from './memory.js';
import { selectRelevant } from './relevance.js';
import { loadAllSkills, formatSkillsForPrompt } from './skills.js';
import { nativeCountTokens } from './native/core.js';
import { nativePlanCompaction } from './native/agent-protocol.js';
import type { PlanRequestMessage } from './native/agent-protocol.js';
import { classifyTaskKind, kindHint } from './taskkind.js';
import type { ChatMessage, MochiConfig, RepoInfo, Task, ToolDefinition } from './types.js';
import { isWeakModel } from './tools/index.js';
import { getCachedScaffold } from './cognitive/chameleon.js';
import { isMode, modeInstruction } from './modes.js';

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
  // Native Rust tokenizer (heuristic BPE) when available; ~4 chars/token
  // approximation otherwise. Same contract either way: fast, deterministic.
  const native = nativeCountTokens(text);
  if (native !== null) return native;
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
Repository Context:
- Language: ${repo.language ?? 'unknown'} | Framework: ${repo.framework ?? 'unknown'}
- Build: ${repo.buildCommand ?? 'unknown'} | Test: ${repo.testCommand ?? 'unknown'}
- Lint: ${repo.lintCommand ?? 'unknown'} | Typecheck: ${repo.typecheckCommand ?? 'unknown'}
- Entrypoints: ${repo.entrypoints?.join(', ') ?? 'unknown'}
- Key Directories: ${repo.importantDirs?.join(', ') ?? 'unknown'}` : '';

            return `You are Mochi, an autonomous software engineering agent. Act with surgical precision, batch independent tool calls in parallel, and verify every change against a real test/build/compiler before declaring done.

# I. Core Directives
1. **Surgical Precision**: Act decisively. Prioritize minimal, targeted changes over sprawling rewrites. Fit seamlessly into the existing codebase architecture and stylistic conventions.
2. **Autonomous Execution**: You do not need to narrate your actions to the user. Read necessary context, execute the modifications, verify the result, and complete the task.
3. **Information Density**: Maximize token efficiency. Batch independent tool calls in parallel (e.g., executing multiple file reads or searches simultaneously).
4. **Verification Integrity**: Never declare a task complete or functional unless you have observed it pass a concrete verification check (e.g., unit test, headless script, or compiler output).

# II. Execution Protocol
- **Discovery**: Never blindly read entire files if a precise lookup (\`get_function\`, \`find_callers\`, \`type_hierarchy\`) or targeted \`search\` will suffice.
- **Modification**: Prefer \`edit\`, \`replace_symbol\`, or \`patch\` for modifying existing code. Reserve \`write\` exclusively for new files or total replacements.
- **Resilience**: If a tool call, test, or build fails, DO NOT blindly retry. Analyze the error output, hypothesize the root cause, and pivot your strategy.
- **Background Processes**: Offload long-running operations (npm install, massive test suites) using \`shell\` with \`background: true\`. Do not block synchronously.

# III. Advanced Orchestration
- **Autonomous Tool Decisions**: You possess full autonomy and consciousness to invoke ANY tool in your arsenal whenever you determine it will improve precision, prevent bugs, or verify results. Do not hesitate to invoke \`blast_radius\` before modifying shared code, \`think\` for deep algorithmic reasoning, \`sql_codebase_query\` for multi-file AST dependency queries, or \`subagent\` for parallel exploration.
- **Dependency Blast Radius**: Before refactoring, renaming, or modifying core shared functions, classes, or interfaces, invoke \`blast_radius\` to identify all upstream call sites and affected files across the repository.
- **Delegation**: If a subtask is highly complex or requires immense context scanning, spawn a \`subagent\` to handle it in an isolated environment. Do not pollute your own context window.
- **Skill Injection**: You have access to a vast library of specialized AI protocols, architectures, and engineering workflows via the \`skill\` tool. When you recognize a specific domain (e.g., debugging, rust, frontend, system-design), invoke the relevant skill to load expert instructions into your context.

# IV. Tool-Specific Guidelines
${this.toolGuidelines(tools)}

# V. Cognitive & Engineering Discipline
- **Operational Wisdom (OWL)**: Apply epistemic reality checks before editing. Validate assumptions against actual disk contents rather than unverified beliefs.
- **Documented Contracts (DOX)**: Adhere strictly to project conventions in AGENTS.md / MOCHI.md. Perform surgical edits that preserve surrounding code invariants.
- **State Continuity (ANCHOR)**: Do not repeat approaches previously marked as refuted or rejected in project memory.
- **Test-Time Compute (Chameleon)**: On complex architectural, algorithmic, or concurrency tasks, invoke the \`chameleon\` tool to synthesize cellular MoE reasoning parameters and execution DAGs.

# VI. Output Constraints (CRITICAL)
- **NO CHATTER**: Do not echo back your instructions, context, or state. 
- **NO FILLER**: Do not generate structural markdown headers (like "## Plan", "## Next Steps", "## Analysis") unless explicitly requested to draft a document.
- **TERSE & DIRECT**: If you are not invoking a tool, provide a concise, direct answer to the user. Keep user-facing responses extremely brief. Reason internally.

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
    add(['blast_radius'], 'blast_radius: analyze the downstream impact and caller call sites of a symbol before modifying or refactoring it.');
    add(['chameleon'], 'chameleon: run test-time compute expansion and cellular MoE decomposition for complex algorithms or architectural refactors.');
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
    if (this.config?.mode && isMode(this.config.mode)) {
      const modeBlurb = modeInstruction(this.config.mode);
      if (modeBlurb) parts.push(modeBlurb.trim());
    }
    if (memory) parts.push(`Project memory:\n${memory}`);
    if (task) {
      parts.push(kindHint(classifyTaskKind(task)));
      const kind = classifyTaskKind(task);
      if (kind === 'implement' || kind === 'fix' || kind === 'refactor' || kind === 'plan') {
        try {
          const scaffold = getCachedScaffold(task.title + (task.description ? ' ' + task.description : ''), process.cwd());
          if (scaffold) parts.push(scaffold);
        } catch {
          /* continue */
        }
      }
    }
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

    // Add recent messages until budget exhausted; prefer latest. Always retain
    // at least the latest turn so active tool responses are never dropped.
    const recent: ChatMessage[] = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      const text = JSON.stringify(m);
      const tokens = approxTokens(text);
      if (recent.length > 0 && remaining - tokens < 0) break;
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

  /** Compute the valid cut index for compaction: prefer the native Rust
   *  planner (identical invariant, computed off the JS hot path) and fall
   *  back to the inlined TS walk when the binary is unavailable (CI, cold
   *  installs). Never orphans a tool result. */
  private async planCutIndex(): Promise<number | null> {
    if (this.messages.length <= 6) return null;
    const keep = 6;
    const native = await nativePlanCompaction(this.messages as PlanRequestMessage[], keep);
    if (typeof native?.cut === 'number' && native.cut > 0 && native.cut < this.messages.length) {
      return native.cut;
    }
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
    return cutIndex;
  }

  /** Non-destructive preview of what compact() would drop: the valid-cut-point
   *  slice that would be removed. Returns null when nothing would be dropped
   *  (already at the recency floor). Lets the caller summarize it with an LLM
   *  BEFORE committing to the compaction (Pi's structured checkpoint). */
  async previewCompact(): Promise<ChatMessage[] | null> {
    const cutIndex = await this.planCutIndex();
    if (cutIndex === null) return null;
    return this.messages.slice(0, cutIndex);
  }

  async compact(checkpoint?: string) {
    // Tier 1 (micro): drop everything but the recency window and distill small facts.
    if (this.messages.length <= 6) return;
    const keep = 6;

    // VALID CUT POINTS (Pi insight): a tool result must stay attached to the
    // assistant message that requested it. planCutIndex() enforces that
    // invariant (native Rust planner first, TS walk as fallback) and never
    // orphans a tool result.
    const cutIndex = await this.planCutIndex();
    if (cutIndex === null) return;
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

