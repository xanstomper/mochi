import { loadConfig, loadProjectConfig, validateConfig } from './config.js';
import type { MochiConfig } from './types.js';
import { EventBus } from './events.js';
import { Workspace } from './workspace.js';
import { GoalEngine } from './goals/goal.js';
import { findProjectRoot } from './repo.js';
import { SessionStore } from './session-store.js';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkpoint as gitCheckpoint, restore as gitRestore, type CheckpointResult } from './git.js';
import { HookManager } from './hooks.js';
import { AgentProfileService } from './agents/profile.js';
import { MemoryStore } from './memory.js';
import { RetrievalEngine } from './retrieval.js';
import { SpeculativeEngine, type SpeculativeResult } from './speculative.js';
import { BudgetEngine } from './budget.js';
import {currentConfig, login as doLogin, selectProviderById, describeConfig, listModelsForProvider} from './model-manager.js';
import { UsageStore } from './usage.js';
import { buildTools } from './tools/index.js';
import { applyMode, modeInstruction, MODE_IDS, isMode } from './modes.js';
import { loadConfigFile, saveConfigFile } from './providers.js';

export interface RuntimeOptions {
  cwd?: string;
  config?: Partial<MochiConfig>;
}

export class Runtime {
  config: MochiConfig;
  events: EventBus;
  workspace: Workspace;
  cwd: string;
  goals: GoalEngine;
  private hooks: HookManager;
  readonly usage: UsageStore;
  /** MCH-79: run-level budget ledger — exposed so /usage can show a per-model cost breakdown. */
  budget?: BudgetEngine;
  private abortController: AbortController;
  private abortSignal: AbortSignal;
  activeSessionId?: string;

  constructor(opts: RuntimeOptions = {}) {
    this.config = loadConfig(opts.config);
    this.cwd = opts.cwd ?? process.cwd();
    this.events = new EventBus();
    const projectRoot = findProjectRoot(this.cwd);
    this.workspace = new Workspace(projectRoot, this.config.projectDir);
    this.workspace.ensure();
    this.goals = new GoalEngine(this.config, this.workspace, this.events, projectRoot);
    // MCH-79: capture the run-level BudgetEngine so /usage can show per-model cost.
    this.goals.onBudget = (b) => { this.budget = b as BudgetEngine; };
    this.hooks = new HookManager(this.workspace.dir);
    this.usage = new UsageStore(this.workspace.dir);
    // A run-level abort: a user hitting Ctrl-C (or a daemon shutdown) aborts
    // the active goal cleanly, letting agents stop at their next checkpoint
    // so subprocesses are not orphaned by a hard SIGKILL.
    this.abortController = new AbortController();
    this.abortSignal = this.abortController.signal;

    const projectConfig = loadProjectConfig(this.workspace.dir);
    if (Object.keys(projectConfig).length) {
      this.config = loadConfig({ ...projectConfig, ...opts.config });
    }

    // Surface misconfigurations (invalid safety mode, bad numbers, MCP server
    // shape, etc.) at startup instead of mid-run. A missing API key is NOT a
    // config-structure problem and is surfaced at the model call layer.
    const problems = validateConfig(this.config);
    if (problems.length) {
      throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    }
  }

  /** Abort the currently-running goal (if any) so the loop stops cleanly. */
  abort(reason = 'aborted by user'): void {
    if (!this.abortController.signal.aborted) this.abortController.abort(new Error(reason));
  }

  /** Reset abort controller so a new prompt can run after an abort. */
  resetAbort(): void {
    this.abortController = new AbortController();
    this.abortSignal = this.abortController.signal;
  }

  /** True after abort() — used by callers (e.g. ACP session/cancel) to learn
   *  the run ended early and report the correct stop reason. */
  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

  /** The run-level abort signal (same object GoalEngine runs receive), so
   *  callers that execute goals directly (ACP) observe session/cancel. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Register a one-shot interrupt: second signal force-exits. */
  onInterrupt(handler: () => void): void {
    let first = true;
    const onSig = () => {
      if (first) {
        first = false;
        handler();
        this.abort();
      } else {
        process.exit(130);
      }
    };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
  }

  static create(opts?: RuntimeOptions): Runtime {
    return new Runtime(opts);
  }

  async checkpoint(message = 'mochi checkpoint'): Promise<CheckpointResult> {
    const hook = await this.hooks.runBefore('on_checkpoint', { message });
    if (!hook.allowed) throw new Error('Checkpoint blocked by hook');
    const result = await gitCheckpoint(this.cwd, message);
    this.workspace.writeJson('checkpoints/latest.json', result);
    await this.hooks.runAfter('on_checkpoint', { message, ref: result.ref });
    return result;
  }

  async rollback(): Promise<string> {
    const hook = await this.hooks.runBefore('on_rollback', {});
    if (!hook.allowed) throw new Error('Rollback blocked by hook');
    const cp = this.workspace.readJson<CheckpointResult>('checkpoints/latest.json');
    if (!cp) throw new Error('No checkpoint found');
    const result = await gitRestore(this.cwd, cp);
    await this.hooks.runAfter('on_rollback', { ref: cp.ref });
    return result;
  }

  async speculate(question: string): Promise<SpeculativeResult> {
    const budget = new BudgetEngine(this.config.safety);
    budget.start();
    const engine = new SpeculativeEngine(this.config, budget);
    return engine.speculate(question);
  }

  profiles() {
    return new AgentProfileService(this.workspace.dir).list();
  }

  /** Set the active execution mode (spec/security/codemod/chaos/normal). */
  setMode(mode: string): string {
    if (!isMode(mode)) return `Unknown mode "${mode}". Modes: ${MODE_IDS.join(', ')}`;
    this.config = applyMode(this.config, mode);
    return modeInstruction(mode) || 'normal';
  }

  /** Set the active reasoning effort / compute level (low, medium, high, max). */
  setReasoning(level: string): string {
    const raw = level.trim().toLowerCase();
    const normalized: import('./types.js').ReasoningLevel =
      raw === 'max' || raw === 'extreme' || raw === 'deep' ? 'max'
      : raw === 'high' || raw === 'hard' ? 'high'
      : raw === 'low' || raw === 'easy' ? 'low'
      : raw === 'off' ? 'off'
      : raw === 'auto' ? 'auto'
      : 'medium';
    this.config.reasoning = normalized;
    process.env.MOCHI_REASONING = normalized;
    try {
      const cfg = loadConfigFile();
      cfg.reasoning = normalized;
      saveConfigFile(cfg);
    } catch { /* best-effort */ }
    const descMap: Record<import('./types.js').ReasoningLevel, string> = {
      low: 'Fast & agile: minimal reasoning overhead, speedy tool executions.',
      medium: 'Balanced: thoughtful analysis, careful edits, reliable verification.',
      high: 'Deep cognitive analysis: edge cases, AST blast radius checking, multi-step verification.',
      max: 'Maximum reasoning compute: exhaustive decomposition, Chameleon MoE synthesis, full invariant verification.',
      off: 'Disabled reasoning overhead.',
      auto: 'Model-default reasoning effort.',
    };
    return descMap[normalized] || descMap.medium;
  }

  /** Get the active reasoning effort level. */
  getReasoning(): import('./types.js').ReasoningLevel {
    return this.config.reasoning || (process.env.MOCHI_REASONING as import('./types.js').ReasoningLevel) || 'max';
  }

  /** Start a fresh session, clearing conversation context. */
  newSession(): string {
    this.activeSessionId = undefined;
    return 'Started fresh session';
  }

  /** Branch the active conversation: create a child session whose parentId
   *  links to the current one, copying the transcript so the branch starts
   *  with full context. Returns a human-readable confirmation. */
  branchSession(title?: string): string {
    const store = new SessionStore(this.cwd);
    const parentId = this.activeSessionId;
    if (!parentId) {
      // No active session yet — a branch of nothing is just a new session.
      this.activeSessionId = store.begin({ objective: title ?? 'Branched session' });
      return `No prior conversation to branch from — started a fresh session ${this.activeSessionId.slice(0, 8)}.`;
    }
    const parent = store.list(200).find((s) => s.id === parentId);
    const childId = store.begin({
      parentId,
      goalId: parent?.goalId ?? undefined,
      role: parent?.role ?? undefined,
      objective: title ?? (parent ? `Branch of: ${parent.objective.slice(0, 60)}` : 'Branched session'),
    });
    // Copy the parent transcript into the child so the branch resumes with
    // full context (the parent_id link also records the lineage).
    for (const m of store.messages(parentId)) {
      store.append(childId, m.role, m.content);
    }
    this.activeSessionId = childId;
    return `Branched session ${parentId.slice(0, 8)} → ${childId.slice(0, 8)} (${store.messages(childId).length} messages copied). You are now talking in the branch.`;
  }

  /** Reset active conversation session. */
  resetSession(): void {
    this.activeSessionId = undefined;
  }

  /** List all tools available in this runtime, returning lightweight metadata. */
  listTools(): Array<{ name: string; description: string; permission?: string; dangerous?: boolean }> {
    const tools = buildTools(this.config);
    return Array.from(tools.values()).map((t) => ({
      name: t.def.name,
      description: t.def.description,
      permission: t.def.permission,
      dangerous: t.def.dangerous,
    }));
  }

  /** Return just the names of available tools (model-aware). */
  getToolNames(): string[] {
    const tools = buildTools(this.config);
    return Array.from(tools.keys());
  }

  memory() {
    return new MemoryStore(this.workspace.dir).load();
  }

  async inspect(query: string) {
    return new RetrievalEngine(this.cwd).inspect(query);
  }

  /** MCH-74: steer a RUNNING goal — pushes guidance to all live agents; they
   *  inject it at their next loop iteration. Returns #agents reached. */
  steer(text: string): number {
    return this.goals.steerActive(text);
  }

  async goal(objective: string, constraints: string[] = [], opts?: { enhance?: boolean; enhanceMode?: string }, signal?: AbortSignal): Promise<string> {
    const r = await this.runGoal(objective, constraints, opts, signal);
    return r.summary;
  }

  /** Structured goal run: like `goal()` but returns the goal id, task list, and
   *  run stats alongside the summary. Callers that need to correlate a run with
   *  a session (editors, daemon jobs) or show the task DAG (an ACP plan) use
   *  this. */
  async runGoal(objective: string, constraints: string[] = [], opts?: { enhance?: boolean; enhanceMode?: string }, signal?: AbortSignal): Promise<{ goalId: string; tasks: import('./types.js').Task[]; summary: string; tokensUsed: number; costUsd: number; durationMs: number; status: string }> {
    const goal = await this.goals.createGoal(objective, constraints);
    const tasks = await this.goals.decompose(goal);
    const { summary, result } = await this.runGoalTraced(goal, tasks, objective, opts, this.config.planMode, signal);
    return { goalId: goal.id, tasks, summary, tokensUsed: result.tokensUsed, costUsd: result.costUsd, durationMs: result.durationMs, status: result.goal?.status ?? goal.status };
  }

  /** Shared execution: records a run trace, then delegates to GoalEngine. */
  private async runGoalTraced(goal: import('./types.js').Goal, tasks: import('./types.js').Task[], objective: string, opts?: { enhance?: boolean; enhanceMode?: string }, isPlan = this.config.planMode, signal?: AbortSignal): Promise<{ summary: string; result: import('./goals/goal.js').GoalResult }> {
    const { TraceRecorder } = await import('./trace.js');
    const recorder = new TraceRecorder(this.workspace.dir, goal.id).attach(this.events);
    try {
      const extra = await this.enhancedCtx(objective, opts);
      const sessionId = this.activeSessionId ?? (this.activeSessionId = this.goals['store'].begin({ goalId: goal.id, objective: objective.slice(0, 80) }));
      const result = await this.goals.runGoal(goal, tasks, extra, signal ?? this.abortSignal, sessionId);
      this.recordUsage(objective, result);
      recorder.log({ t: Date.now(), kind: 'goal:summary', status: result.goal?.status ?? 'unknown', tokensUsed: result.tokensUsed, costUsd: result.costUsd, durationMs: result.durationMs });
      // Plan mode: the agents' plan text is the deliverable.
      if (isPlan) {
        const plans = result.completedTasks.map((t) => t.output).filter((o) => o && o.trim());
        if (plans.length) return { summary: `Goal ${result.goal?.status ?? ''}.\n\n${plans.join('\n\n---\n\n')}`, result };
      }
      return { summary: result.summary, result };
    } finally {
      recorder.close();
    }
  }

  /**
   * Continuous improvement loop: run the prompt multiple times in series,
   * each iteration receiving the previous run's summary as a "previous best"
   * context block. The agent is poked to keep deepening the work instead
   * of finishing at the first pass. The iteration cap raises the
   * safety.maxIterations ceiling for the duration of the loop so the agent
   * is not artificially bounded at 8 internal iterations per pass.
   */
  async autoImprove(prompt: string, runs: number, opts?: { sessionId?: string; onProgress?: (i: number, lastSummary: string) => void; signal?: AbortSignal }): Promise<{ summaries: string[]; finalSummary: string; tokensUsed: number; costUsd: number; durationMs: number }> {
      const boundedRuns = Math.max(1, Math.min(40, runs | 0));
      const cap = this.config.safety.maxIterations;
      if (cap < 50) (this.config.safety as { maxIterations: number }).maxIterations = 50;
      const startedAt = performance.now();
      const summaries: string[] = [];
      const sessionId = opts?.sessionId ?? this.activeSessionId;
      try {
        let priorSummary = '';
        let consecutiveStagnant = 0;
        for (let i = 0; i < boundedRuns; i++) {
          if (opts?.signal?.aborted) break;
          // Self-review pass chain (NOT "keep going"): pass 1 produces the
          // strongest first draft; each later pass first CRITICALLY reviews what
          // was just done — naming concrete flaws, missing cases, and anything
          // that needs real verification — then applies only real improvements.
          // The prompt forces a verdict decision so the model must either make a
          // measurable improvement or explicitly declare the work complete.
          let iterPrompt: string;
          if (!priorSummary || !priorSummary.trim()) {
            iterPrompt = `${prompt}\n\n---\n[Self-review pass 1/${boundedRuns}]\nProduce the strongest complete first pass you can. Do NOT rush to declare it done — implement it fully and verify as you go.`;
          } else {
            iterPrompt = `${prompt}\n\n---\n[Self-review pass ${i + 1}/${boundedRuns}]\n\nHere is what the previous pass produced:\n${priorSummary.slice(0, 5000)}\n\nYour job now is a CRITICAL SELF-REVIEW and IMPROVEMENT pass:\n1. Review what was just done. Identify concrete flaws: missing edge cases, unimplemented requirements, incorrect logic, unverified assumptions, or opportunities to make it materially better.\n2. Run the task's verification (tests / lint / build / sample the output) to confirm what actually works vs what is broken.\n3. Make the fixes that are real and measurable. Do NOT just restate or rephrase what already exists.\n4. End with a single verdict line between <VERDICT> tags:\n   - <VERDICT>DONE</VERDICT>   — only if verification passes AND there are no remaining real improvements.\n   - <VERDICT>IMPROVED</VERDICT> — if you made at least one concrete improvement this pass.\n   If you changed code or files, say exactly what you changed and how you verified it.`;
          }
          const summary = await this.runPrompt(iterPrompt, { sessionId });
          summaries.push(summary);
          opts?.onProgress?.(i + 1, summary);
          this.events.emit({
            type: 'agent:log',
            agentId: 'auto-improve',
            message: `[auto-improve] self-review pass ${i + 1}/${boundedRuns} complete (${summary.length} chars)`,
          } as any);

          if (priorSummary) {
            const isIdentical = summary.trim() === priorSummary.trim();
            const declaredDone = /<VERDICT>\s*DONE\s*<\/VERDICT>|no\s+(further|remaining)\s+(issues|changes|improvements)|all\s+tests\s+pass|nothing\s+(left|further)\s+to\s+(fix|do|refine)|already\s+(complete|optimal|verified|perfect)/i.test(summary);
            const improvedDeclared = /<VERDICT>\s*IMPROVED\s*<\/VERDICT>/i.test(summary);
            const wordsA = new Set(priorSummary.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
            const wordsB = new Set(summary.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
            let intersection = 0;
            for (const w of wordsA) if (wordsB.has(w)) intersection++;
            const union = new Set([...wordsA, ...wordsB]).size;
            const similarity = union > 0 ? intersection / union : 0;

            if (declaredDone) {
              // Verified perfect → stop and move on (this is the real exit).
              this.events.emit({
                type: 'agent:log',
                agentId: 'auto-improve',
                message: `[auto-improve] work declared DONE and verified at pass ${i + 1}/${boundedRuns} — moving on.`,
              } as any);
              priorSummary = summary;
              break;
            }
            if (isIdentical) {
              // Verbatim identical summary: stagnation even if <VERDICT>IMPROVED</VERDICT> was repeated
              consecutiveStagnant += 2;
            } else if (improvedDeclared) {
              // Concrete non-identical improvement asserted
              consecutiveStagnant = 0;
            } else if (similarity >= 0.90) {
              // No verdict AND near-identical text: nothing new was done.
              consecutiveStagnant += 2;
            } else {
              // No verdict, text changed — cautious single strike.
              consecutiveStagnant += 1;
            }

            if (consecutiveStagnant >= 2) {
              this.events.emit({
                type: 'agent:log',
                agentId: 'auto-improve',
                message: `[auto-improve] early convergence reached at pass ${i + 1}/${boundedRuns}: no further work or improvements detected.`,
              } as any);
              priorSummary = summary;
              break;
            }
          }
          if (summary) priorSummary = summary;
        }
      } finally {
        if (cap < 50) (this.config.safety as { maxIterations: number }).maxIterations = cap;
      }
      const finalSummary = summaries[summaries.length - 1] ?? '';
      const t = this.usage.total();
      return {
        summaries,
        finalSummary,
        tokensUsed: (t.tokensIn ?? 0) + (t.tokensOut ?? 0),
        costUsd: t.costUsd ?? 0,
        durationMs: Math.round(performance.now() - startedAt),
      };
    }

  /** Continuous self-improvement / self-training driver.
   *
   *  Runs Mochi's own improvement loop in a bounded number of cycles. Each
   *  cycle composes a self-improvement task from the codebase's current state
   *  (recent traces, skill coverage, test failures) and runs it through the
   *  self-review `autoImprove` pipeline, then triggers the skill curator so new
   *  lessons persist as durable, reusable skills. When pointed at Mochi's own
   *  repo this can author code changes to itself — the "learn and get better
   *  over time" loop — bounded by `cycles` and the safety budget.
   */
  async selfTrain(opts: { cycles?: number; focus?: string; sessionId?: string; onProgress?: (i: number, message: string) => void; signal?: AbortSignal } = {}): Promise<{ report: string; tokensUsed: number; costUsd: number; durationMs: number }> {
    const cycles = Math.max(1, Math.min(20, opts.cycles ?? 3));
    const startedAt = performance.now();
    const reports: string[] = [];

    for (let c = 0; c < cycles; c++) {
      if (opts?.signal?.aborted) break;
      // Compose a concrete improvement task from the repo's current state so
      // each cycle targets a REAL gap instead of generic "make me better".
      const improvementTask = this.composeImprovementTask(c + 1, cycles, opts.focus);

      opts?.onProgress?.(c + 1, `self-train cycle ${c + 1}/${cycles}: ${improvementTask.title}`);
      const { finalSummary } = await this.autoImprove(
        improvementTask.prompt,
        3, // up to 3 self-review passes per goal until DONE
        { sessionId: opts.sessionId, signal: opts.signal, onProgress: (i, s) => opts.onProgress?.(c + 1, `  self-review pass ${i}: ${s.slice(0, 120)}`) },
      );
      reports.push(`## Cycle ${c + 1}/${cycles}: ${improvementTask.title}\n${finalSummary.trim()}\n`);
    }

    // Persist lessons as durable skills after the cycles (curator pass).
    try {
      const { runCurator, defaultCuratorConfig } = await import('./skill-curator.js');
      const co = runCurator(this.cwd, defaultCuratorConfig());
      const curatorSummary = `scanned ${co.scanned}, agent-authored ${co.agentCreated}, stale ${co.stale.length}, archived ${co.archived.length}, consolidated ${co.consolidated.length}${co.reportPath ? `\nreport: ${co.reportPath}` : ''}`;
      reports.push(`## Skill curator\n${curatorSummary}\n`);
    } catch { /* curator failure must not fail the training run */ }

    const t = this.usage.total();
    return {
      report: reports.join('\n'),
      tokensUsed: (t.tokensIn ?? 0) + (t.tokensOut ?? 0),
      costUsd: t.costUsd ?? 0,
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  /** Build one targeted self-improvement task from the current codebase,
   *  grounded in the most recent run trace so the model fixes real observed
   *  gaps rather than inventing work. */
  private composeImprovementTask(cycle: number, total: number, focus?: string): { title: string; prompt: string } {
    const repoHint = /\/mochi(?:\/|$)/.test(this.cwd)
      ? 'This is the Mochi codebase itself — you may read and modify its TypeScript source. Prefer small, correct, well-typed patches; always typecheck (`npm run typecheck`), run targeted tests, and rebuild before finishing.'
      : 'Work inside the current project. Make focused, correct improvements and verify them.';
    let evidence = '';
    try {
      const traceDir = resolve(this.cwd, '.mochi', 'traces');
      const files = readdirSync(traceDir).filter((f: string) => f.endsWith('.jsonl')).map((f: string) => resolve(traceDir, f));
      const latest = files.sort((a: string, b: string) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
      if (latest) {
        const raw = readFileSync(latest, 'utf8');
        const messages = raw.split('\n').filter(Boolean).slice(-40)
          .map((l: string) => { try { const o = JSON.parse(l); return typeof o.message === 'string' ? o.message : ''; } catch { return ''; } })
          .filter((s: string) => s.length > 0).slice(-8).join('\n').slice(0, 1500);
        if (messages) evidence = `Recent run tail (most recent trace ${latest.split('/').pop()}):\n${messages}\n`;
      }
    } catch { /* trace grounding is best-effort */ }

    const cycleGoal = focus ?? (cycle === 1
      ? 'identify the single most impactful correctness or reliability issue in this codebase and fix it properly'
      : 'improve the weakest area you can find: correctness bugs, robustness gaps, missing edge cases, performance, or self-test coverage');
    return {
      title: `Self-improvement cycle ${cycle}/${total}${focus ? `: ${focus}` : ''}`,
      prompt: `Self-improvement task.\n\n${evidence}${repoHint}\n\nGoal: ${cycleGoal}\n\nFix it fully, verify with the repo's own checks, and clearly report what you changed and how you verified it.`,
    };
  }

  async team(objective: string, opts?: { enhance?: boolean; enhanceMode?: string }): Promise<string> {
    // Real team run: decompose, assign specialist roles (coder/tester/
    // reviewer/...), and execute through the scheduler concurrently.
    const { runTeam } = await import('./teams/team.js');
    const { TraceRecorder } = await import('./trace.js');
    const goal = await this.goals.createGoal(objective);
    const recorder = new TraceRecorder(this.workspace.dir, goal.id).attach(this.events);
    try {
      const extra = await this.enhancedCtx(objective, opts);
      const { summary, status } = await runTeam(this.goals, goal, { signal: this.abortSignal, extras: extra });
      recorder.log({ t: Date.now(), kind: 'team:summary', status, summary: summary.slice(0, 500) });
      return summary;
    } finally {
      recorder.close();
    }
  }

  async plan(objective: string): Promise<string> {
    const goal = await this.goals.createGoal(objective);
    const tasks = await this.goals.decompose(goal);
    const lines = [`Plan for: ${goal.objective}\n`];
    for (const t of tasks) {
      lines.push(`- [ ] ${t.title} (${t.role})`);
      if (t.dependencies.length) lines.push(`    deps: ${t.dependencies.join(', ')}`);
      lines.push(`    criteria: ${t.acceptanceCriteria.join('; ')}`);
    }
    lines.push('\nRun /approve to execute this plan.');
    this.workspace.writeJson('state/pending-goal.json', { id: goal.id, objective: goal.objective });
    return lines.join('\n');
  }

  async approvePlan(): Promise<string> {
    const pending = this.workspace.readJson<{ id: string; objective: string }>('state/pending-goal.json');
    if (!pending) return 'No pending plan. Run /plan first.';
    const goal = this.workspace.loadGoal(pending.id) ?? await this.goals.createGoal(pending.objective);
    const tasks = this.workspace.loadTasks(pending.id).length ? this.workspace.loadTasks(pending.id) : await this.goals.decompose(goal);
    const result = await this.goals.runGoal(goal, tasks, [], this.abortSignal);
    this.recordUsage(pending.objective, result);
    this.workspace.writeJson('state/pending-goal.json', {});
    return result.summary;
  }

  /** Resume a persisted goal by id (failed, active, or pending) over any
   *  entrypoint (CLI or daemon). Re-runs the goal's tasks through the same
   *  traced path as a new goal so the run trace is continuous per goal. */
  async resumeGoal(goalId: string): Promise<string> {
    const goal = this.workspace.loadGoal(goalId);
    if (!goal) return `Goal not found: ${goalId}`;
    const tasks = this.workspace.loadTasks(goalId);
    if (!tasks.length) return `Goal ${goalId.slice(0, 8)} has no tasks to resume.`;
    goal.status = 'active';
    this.workspace.saveGoal(goal);
    const { TraceRecorder } = await import('./trace.js');
    const recorder = new TraceRecorder(this.workspace.dir, goal.id).attach(this.events);
    try {
      const result = await this.goals.runGoal(goal, tasks, [], this.abortSignal);
      this.recordUsage(goal.objective, result);
      recorder.log({ t: Date.now(), kind: 'goal:summary', status: goal.status, tokensUsed: result.tokensUsed, costUsd: result.costUsd, durationMs: result.durationMs });
      return result.summary;
    } finally {
      recorder.close();
    }
  }

  /** When the caller opts into it (or config has enhance enabled), generate
   *  synthetic-parameter reasoning context with the agent's OWN model and fold
   *  it into the goal's task contexts. No external API / CLI required. */
  private async enhancedCtx(objective: string, opts?: { enhance?: boolean; enhanceMode?: string }): Promise<string[]> {
    const cfg = (this.config as unknown as Record<string, unknown>).enhance;
    const enabled = opts?.enhance ?? (cfg ? (cfg as { enabled?: boolean }).enabled : false);
    if (!enabled) return [];
    try {
      const r = await this.enhance(objective, (opts?.enhanceMode ?? 'auto') as never);
      if (!r.context.trim()) return [];
      return [`Chameleon reasoning enhancement (mode ${r.mode}):\n${r.context.slice(0, 12000)}`];
    } catch {
      return [];
    }
  }

  /** Generate internal Chameleon enhancement context with the agent's model. */
  async enhance(task: string, mode?: import('./chameleon.js').ChameleonMode, budget?: import('./budget.js').BudgetEngine)
    : Promise<import('./chameleon.js').EnhanceResult> {
    const { ChameleonEngine } = await import('./chameleon.js');
    return new ChameleonEngine(this.config).enhance({ task, mode, budget });
  }

  async runPrompt(prompt: string, opts?: { sessionId?: string }): Promise<string> {
    const r = await this.runPromptDetailed(prompt, opts);
    return r.summary;
  }

  /** Structured one-shot run: like runPrompt but returns the goal status,
   *  stop reason, and stats so headless consumers (`--json`, CI exit codes)
   *  can branch on real outcomes instead of parsing prose. */
  async runPromptDetailed(prompt: string, opts?: { sessionId?: string }): Promise<{ summary: string; status: string; stopReason?: string; success: boolean; tokensUsed: number; costUsd: number; durationMs: number; goalId: string; filesModified: string[] }> {
    if (this.abortController.signal.aborted) this.resetAbort();
    if (opts?.sessionId) {
      this.activeSessionId = opts.sessionId;
    } else if (!this.activeSessionId) {
      this.activeSessionId = this.goals['store'].begin({ objective: prompt.slice(0, 80) });
    }
    const sessionId = this.activeSessionId;
    // Single-agent one-shot task: create task directly without waiting for decompose LLM call.
    const { createTask } = await import('./goals/task.js');
    const { classifyTaskKind } = await import('./taskkind.js');
    const goal = await this.goals.createGoal(prompt);
    const kind = classifyTaskKind({ title: prompt.split('\n')[0].slice(0, 80), description: prompt, role: 'coder' as any });
    const isChat = kind === 'chat';
    const task = createTask(prompt.split('\n')[0].slice(0, 80), prompt, { role: isChat ? 'assistant' as any : 'coder', acceptanceCriteria: [] });
    goal.tasks.push(task.id);
    this.workspace.saveGoal(goal);
    this.workspace.saveTasks(goal.id, [task]);
    const { TraceRecorder } = await import('./trace.js');
    const recorder = new TraceRecorder(this.workspace.dir, goal.id).attach(this.events);
    try {
      const result = await this.goals.runGoal(goal, [task], [], this.abortSignal, sessionId);
      this.recordUsage(prompt, result);
      recorder.log({ t: Date.now(), kind: 'goal:summary', status: goal.status, tokensUsed: result.tokensUsed, costUsd: result.costUsd, durationMs: result.durationMs });
      let summary = result.summary;
      const outputs = result.completedTasks.map((t) => t.output).filter((o) => o && o.trim()).join('\n\n');
      if (this.config.planMode) {
        if (outputs) summary = `Goal ${goal.status}.\n\n${outputs}`;
      } else if (outputs && !outputs.includes(result.summary)) {
        summary = `${outputs}\n\n${result.summary}`;
      }
      return {
        summary,
        status: goal.status,
        stopReason: result.failedTasks[0]?.attempts?.at(-1)?.failureReason,
        success: result.success,
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        goalId: goal.id,
        filesModified: [...new Set(result.completedTasks.flatMap((t) => (t as any).filesModified ?? []))],
      };
    } finally {
      recorder.close();
    }
  }

  /**
   * Review piped input (a git diff, crash log, or code snippet) with the
   * read-only Reviewer role. Returns the raw reviewer summary; the caller
   * parses structured findings with pipeline.parseFindings.
   */
  async review(input: string): Promise<string> {
    const { createTask } = await import('./goals/task.js');
    const goal = await this.goals.createGoal('Review the provided input and report issues.');
    const task = createTask(
      'Review input',
      `Review the following input (a diff, crash log, or code snippet) for correctness, security, and regressions. Respond with structured findings, one per line: [SEVERITY] file:line message, where SEVERITY is HIGH, MEDIUM, LOW, or INFO. Be specific and cite the file (or '(unknown)' when no file applies).\n\nINPUT:\n${input.slice(0, 120_000)}`,
      { role: 'reviewer', acceptanceCriteria: [], dependencies: [] },
    );
    const { TraceRecorder } = await import('./trace.js');
    const recorder = new TraceRecorder(this.workspace.dir, goal.id).attach(this.events);
    try {
      const result = await this.goals.runGoal(goal, [task], [], this.abortSignal);
      this.recordUsage('review', result);
      const output = result.completedTasks.map((t) => t.output).filter((o) => o && o.trim()).join('\n');
      return output || result.summary || '(no findings)';
    } finally {
      recorder.close();
    }
  }

  /** Run a fix task over piped input (crash log / failing test output). */
  async fix(input: string): Promise<string> {
    const goal = await this.goals.createGoal('Fix the issue described by the provided input.');
    const task = (await this.goals.decompose(goal))[0];
    task.description = `${task.description}\n\nCONTEXT FROM PIPE:\n${input.slice(0, 120_000)}`;
    const { TraceRecorder } = await import('./trace.js');
    const recorder = new TraceRecorder(this.workspace.dir, goal.id).attach(this.events);
    try {
      const result = await this.goals.runGoal(goal, [task], [], this.abortSignal);
      this.recordUsage(input.slice(0, 100), result);
      return result.summary;
    } finally {
      recorder.close();
    }
  }

  private recordUsage(goal: string, result: { tokensUsed: number; costUsd: number; durationMs: number }): void {
    this.usage.record(this.config.model.model, goal, {
      tokensOut: result.tokensUsed,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      modelCalls: 1,
    });
  }

  reloadConfig() {
    this.config = loadConfig({} as Partial<MochiConfig>);
  }

  providerInfo(): string {
    return describeConfig(this.config);
  }

  modelList(): string[] {
    return listModelsForProvider(this.config.model.provider);
  }

  async useProvider(providerId: string, model?: string) {
    const saved = currentConfig();
    this.config = selectProviderById(saved, providerId, model);
    if (!this.config.reasoning) {
      this.config.reasoning = 'max';
    }
    this.syncEngines();
    return describeConfig(this.config);
  }

  async loginProvider(provider: string, apiKey: string, model?: string) {
    const saved = currentConfig();
    this.config = doLogin(saved, provider, apiKey, model);
    if (!this.config.reasoning) {
      this.config.reasoning = 'max';
    }
    this.syncEngines();
    return describeConfig(this.config);
  }

  /** Propagate a config swap to engines that captured the config object at
   *  construction. GoalEngine (and anything else holding a reference) would
   *  otherwise keep serving the PREVIOUS model forever: useProvider replaced
   *  this.config but the engines still pointed at the old object — so /model
   *  looked applied while every run silently used the stale model. */
  private syncEngines() {
    (this.goals as unknown as { config: MochiConfig }).config = this.config;
  }

  private async runChecks(): Promise<Record<string, string>> {
    const { detectRepo } = await import('./repo.js');
    const info = detectRepo(this.cwd);
    const commands: Record<string, string> = {};
    if (info.testCommand) commands.test = info.testCommand;
    if (info.buildCommand) commands.build = info.buildCommand;
    if (info.typecheckCommand) commands.typecheck = info.typecheckCommand;
    if (info.lintCommand) commands.lint = info.lintCommand;
    const out: Record<string, string> = {};
    const { execFile } = await import('node:child_process');
    await Promise.all(Object.entries(commands).map(([name, cmd]) => new Promise<void>((res) => {
      execFile('sh', ['-c', cmd], { cwd: this.cwd, timeout: 120000 }, (e) => {
        out[name] = e ? 'FAIL' : 'PASS';
        res();
      });
    })));
    return out;
  }

  async recordGood(): Promise<string> {
    const checks = await this.runChecks();
    this.workspace.writeJson('state/knowngood.json', { ts: Date.now(), checks, model: this.config.model.model });
    const lines = Object.entries(checks).map(([n, s]) => `  ${n}: ${s}`);
    return (lines.length ? lines.join('\n') : '  (no checks configured)') + '\nRecorded as known-good baseline.';
  }

  async knownGood(): Promise<string> {
    const baseline = this.workspace.readJson<{ ts: number; checks: Record<string, string> }>('state/knowngood.json');
    if (!baseline) return 'No known-good baseline yet. Run /known-good to record one.';
    const now = await this.runChecks();
    const lines = ['compare baseline vs. current:'];
    for (const name of Object.keys(baseline.checks)) {
      const b = baseline.checks[name] ?? 'N/A';
      const n = now[name] ?? 'N/A';
      lines.push(`  ${name}: baseline ${b} -> now ${n}${b === n ? '' : '  (CHANGED)'}`);
    }
    return lines.join('\n');
  }
}
