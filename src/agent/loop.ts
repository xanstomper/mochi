import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { Attempt, ChatMessage, MochiConfig, ModelProfile, Task, ToolDefinition, ToolCall, ToolResult } from '../types.js';
import type { EventBus } from '../events.js';
import type { Workspace } from '../workspace.js';
import { ContextEngine } from '../context.js';
import { createProvider } from '../model/router.js';
import { executeTool, buildTools } from '../tools/index.js';
import type { ToolContext, ReadCache } from '../tools/types.js';
import { detectRepo } from '../repo.js';
import type { AgentProfile } from '../types.js';
import { AgentProfileService } from '../agents/profile.js';
import { BudgetEngine } from '../budget.js';
import { LearningStore, classifyFailure } from '../learning.js';
import { HookManager } from '../hooks.js';
import { resolve } from 'node:path';
import { classifyOneShot } from '../one-shot.js';
import { buildMcpTools } from '../mcp/tools.js';
import { preEditSnapshot as gitPreEditSnapshot, rollbackToSnapshot as gitRollback, type CheckpointResult } from '../git.js';

export interface AgentOptions {
  id?: string;
  role: string;
  modelProfile?: ModelProfile;
  profile?: AgentProfile;
  config: MochiConfig;
  workspace: Workspace;
  events: EventBus;
  cwd: string;
  context: ContextEngine;
  budget?: BudgetEngine;
  abortSignal?: AbortSignal;
  readCache?: ReadCache;
  /** Extra tools registered externally (e.g. MCP server tools). */
  extraTools?: Map<string, import('../tools/types.js').Tool>;
  /** When true, the agent plans then waits for approval before editing. */
  planMode?: boolean;
  /** Depth guard: children spawn with subagentDepth = parent + 1. Subagents
   *  may not delegate further (depth 1 has no spawnSubagent injected). */
  subagentDepth?: number;
}

export interface AgentResult {
  success: boolean;
  summary: string;
  filesModified: string[];
  attempts: number;
  tokensUsed: number;
  durationMs: number;
}

export class Agent {
  private id: string;
  private role: string;
  private profile: AgentProfile;
  private config: MochiConfig;
  private workspace: Workspace;
  private events: EventBus;
  private cwd: string;
  private context: ContextEngine;
  private budget?: BudgetEngine;
  private abortSignal?: AbortSignal;
  private tools: Map<string, import('../tools/types.js').Tool>;
  private toolDefs: ToolDefinition[];
  private provider: ReturnType<typeof createProvider>;
  private providers = new Map<ModelProfile, ReturnType<typeof createProvider>>();
  private tokensUsed = 0;
  private startTime = 0;
  private errors: string[] = [];
  private lastStrategy?: string;
  private strategyRepeats = 0;
  private learning: LearningStore;
  private seenPatterns = new Set<string>();
  private hooks: HookManager;
  private toolCallsTotal = 0;
  private verifyCount = 0;
  private fileChanged = false;
  /** Checkpoint taken before the first file edit, restored if verification
   *  fails repeatedly so a broken agent run never leaves the tree dirty. */
  private preEditCheckpoint?: CheckpointResult;
  private checkpointFailed = false;
  private lastSig = '';
  private sigStreak = 0;
  private readCache: ReadCache;
  private planMode: boolean;
  private planVetoes = 0;
  private subagentDepth: number;
  private mcpClose?: () => void;

  constructor(opts: AgentOptions) {
    this.id = opts.id ?? randomUUID();
    this.role = opts.role;
    this.config = opts.config;
    this.workspace = opts.workspace;
    this.events = opts.events;
    this.cwd = opts.cwd;
    this.context = opts.context;
    this.budget = opts.budget;
    this.abortSignal = opts.abortSignal;
    // A shared run-wide cache is preferred so parallel agents that read the same
    // source file don't each re-read it from disk; the cache is keyed on
    // (mtime, size) so any edit automatically misses, keeping it safe to share.
    this.readCache = opts.readCache ?? new Map();
    const profileService = new AgentProfileService(this.workspace.dir);
    this.profile = opts.profile ?? profileService.get(opts.role) ?? profileService.get('coder')!;
    this.tools = buildTools(this.config, this.profile.tools);
    if (opts.extraTools) {
      for (const [name, tool] of opts.extraTools) {
        if (!this.tools.has(name)) this.tools.set(name, tool);
      }
    }
    this.planMode = opts.planMode ?? this.config.planMode ?? false;
    this.subagentDepth = opts.subagentDepth ?? 0;
    this.learning = new LearningStore(this.workspace.dir);
    this.hooks = new HookManager(this.workspace.dir);
    this.toolDefs = [...this.tools.values()].map((t) => t.def);
    this.provider = createProvider(this.config.model, opts.modelProfile ?? this.profile.defaultModel ?? 'coding');
    this.events.emit({ type: 'agent:spawned', id: this.id, role: opts.role as any, taskId: '' });
  }

  async run(task: Task): Promise<AgentResult> {
    this.startTime = performance.now();
    this.events.emit({ type: 'task:started', task, agentId: this.id });
    this.context.updateState({ nextAction: `Start task: ${task.title}` });
    this.context.addMessage({ role: 'system', content: this.profile.systemPrompt });
    if (this.planMode) {
      this.context.addMessage({
        role: 'system',
        content: 'PLAN MODE: Research the codebase, then produce a concrete plan (steps, files to change, risks, verification). Do NOT edit files or run mutating commands. Finish with the plan as your answer.',
      });
    }

    const repo = detectRepo(this.cwd);
    const gitStatus = await this.runShell('git status --short');
    this.context.addMessage({ role: 'system', content: `Preflight: repo=${repo.language ?? 'unknown'}, git status:\n${gitStatus}` });

    const maxIterations = this.config.safety.maxIterations;
    const runtimeLimit = this.config.safety.maxRuntimeMinutes * 60 * 1000;

    // One-shot fast path: for high-confidence answer/summarize tasks, bias the
    // model to resolve in a single direct turn instead of spending tokens on
    // needless tool round-trips. Verification is still run before "done" is
    // accepted, so an answer is never trusted without evidence when edits happened.
    const oneShot = classifyOneShot({
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria ?? [],
      verificationCommand: task.verificationCommand,
    });
    if (oneShot.suggests) {
      this.context.addMessage({ role: 'system', content: oneShot.suggests });
    }

    // Wire any configured MCP servers into the toolset. These tools are closed
    // when the run finishes (see finish()), so subprocesses don't leak.
    if (this.config.mcpServers) {
      const log = (m: string): undefined => {
        this.events.emit({ type: 'agent:log', agentId: this.id, message: m });
        return undefined;
      };
      const connected = await buildMcpTools(this.config.mcpServers, log);
      for (const [name, tool] of connected.tools) {
        if (!this.tools.has(name)) this.tools.set(name, tool);
      }
      for (const err of connected.errors) log(err);
      if (connected.tools.size > 0) {
        this.toolDefs = [...this.tools.values()].map((t) => t.def);
      }
      this.mcpClose = connected.close;
    }

    for (let i = 0; i < maxIterations; i++) {
      if (this.abortSignal?.aborted) {
        return this.finish(task, false, 'Aborted by user');
      }
      if (performance.now() - this.startTime > runtimeLimit) {
        return this.finish(task, false, 'Runtime limit exceeded');
      }
      if (this.budget) {
        this.budget.recordAgentStart();
        if (!this.budget.canMakeModelCall()) {
          return this.finish(task, false, 'Budget exhausted before model call');
        }
        this.budget.recordModelCall();
      }

      if (i > 0 && i % 8 === 0) this.context.compact();

      // Compact-first context floor: once the live transcript grows past a
      // fraction of the context budget, roll up old turns so the packet never
      // balloons. The floor is ALSO capped by a fixed ceiling so a huge
      // configured budget (e.g. 120k+) cannot let the live transcript balloon —
      // long runs stay lean no matter what the user's safety config says.
      const ceiling = 32_000;
      const floor = Math.min(this.config.safety.contextBudgetTokens * 0.6, ceiling);
      if (i > 0 && this.context.estimateTokens() > floor) {
        this.context.compact();
      }

      const pulse = this.pulse(i, task);
      if (pulse.abort) {
        return this.finish(task, false, pulse.reason ?? 'Pulse abort');
      }
      if (pulse.message) {
        this.context.addMessage({ role: 'system', content: pulse.message });
      }

      const packet = this.context.buildPacket(this.toolDefs, task, repo);
      // Anti-loop: if it's just gathering context (read/search) without editing, force an answer.
      if (this.toolCallsTotal >= 6 && !this.fileChanged && !this.planMode) {
        this.context.addMessage({ role: 'system', content: 'You have gathered enough context without modifying any files. Stop using tools and give your final answer directly now.' });
      }
      this.emitMessage('system', `Tokens used: ${packet.usedTokens}/${packet.budgetTokens}`);

      const activeProvider = this.pickProvider();
      let response;
      const gatherStream = async (messages: any) => {
        const chunks: import('../types.js').StreamChunk[] = [];
        let first = true;
        for await (const chunk of activeProvider.streamChat(messages, this.toolDefs, { temperature: 0.2 })) {
          chunks.push(chunk);
          if (chunk.content) {
            if (first) {
              this.emitMessage('assistant', chunk.content);
              first = false;
            } else {
              this.events.emit({ type: 'message:chunk', content: chunk.content, agentId: this.id } as any);
            }
          }
        }
        const content = chunks.map((c) => c.content).join('');
        const callsByIndex = new Map<number, any>();
        for (const chunk of chunks) {
          if (chunk.toolCalls) {
            for (const tc of chunk.toolCalls as any[]) {
              const idx = tc.index ?? 0;
              const acc = callsByIndex.get(idx) ?? { id: tc.id, name: tc.function.name, args: '' };
              acc.name = acc.name || tc.function.name;
              acc.args += tc.function.arguments || '';
              callsByIndex.set(idx, acc);
            }
          }
        }
        const tool_calls = [...callsByIndex.values()].map((a) => ({ id: a.id, type: 'function' as const, function: { name: a.name, arguments: a.args } }));
        return {
          content,
          toolCalls: tool_calls.length ? tool_calls : undefined,
          finishReason: chunks[chunks.length - 1]?.finishReason,
          usage: chunks[chunks.length - 1]?.usage,
        };
      };

      try {
        response = await gatherStream(packet.messages);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.context.compact();
        const retryPacket = this.context.buildPacket(this.toolDefs, task, repo);
        try {
          response = await gatherStream(retryPacket.messages);
        } catch {
          return this.finish(task, false, `Model request failed: ${message}`);
        }
      }
      if (response.usage) {
        this.tokensUsed += response.usage.totalTokens;
        this.budget?.recordTokens(response.usage.totalTokens, this.config.model.model);
      }
      this.lastStrategy = response.toolCalls?.[0]?.function.name ?? response.content?.slice(0, 60) ?? '';

      if (response.toolCalls && response.toolCalls.length > 0) {
        this.context.addMessage({ role: 'assistant', content: response.content ?? '', tool_calls: response.toolCalls });
        // Plan mode: allow read-only research, but veto any mutating tool and
        // steer the model back to producing a plan. Every vetoed call still
        // gets a tool response (providers reject dangling tool_call_ids), and
        // the loop continues so the model can hand back its plan text. Only a
        // model that keeps attempting edits after a veto is stopped outright.
        // Read-only is an ALLOWLIST: anything not explicitly read-only (shell,
        // write/edit/delete/patch, git, MCP tools, ...) is vetoed.
        if (this.planMode) {
          const isMutating = (c: ToolCall) => !this.isReadOnly(c.function.name);
          if (response.toolCalls.some(isMutating)) {
            this.planVetoes++;
            // Mixed batches: run the read-only calls so their ids are answered,
            // and only veto the mutating ones.
            const readOnlies = response.toolCalls.filter((c) => !isMutating(c));
            if (readOnlies.length > 0) await this.executeToolCalls(readOnlies);
            for (const c of response.toolCalls) {
              if (!isMutating(c)) continue;
              this.vetoToolCall(c, 'plan mode is active. No file or command changes are permitted while planning.');
            }
            if (this.planVetoes > 1) {
              const planText = (response.content ?? '').trim();
              return this.finish(task, true, planText || this.context['state'].nextAction || 'Planned. No files were changed.');
            }
            this.context.addMessage({
              role: 'system',
              content: 'PLAN MODE: you are only planning right now. Do not edit files or run mutating commands. Do not call write/edit/delete/shell again. Hand back your plan (steps, files to change, risks, verification) as the final answer now.',
            });
            this.events.emit({ type: 'agent:log', agentId: this.id, message: '[plan-mode] vetoed mutating tool call; requesting plan' });
            continue;
          }
        }
        // Loop guard: repeated identical tool calls -> force the model to answer.
        const nowSig = response.toolCalls.map((c) => `${c.function.name}:${c.function.arguments}`).join('|');
        if (nowSig === this.lastSig) this.sigStreak++;
        else { this.sigStreak = 1; }
        this.lastSig = nowSig;
        if (this.sigStreak >= 3) {
          this.context.addMessage({ role: 'system', content: 'You are repeating the same tool call. Stop issuing tools and give a final answer now without any tool calls.' });
          this.sigStreak = 0;
        }
        this.toolCallsTotal++;
        if (this.toolCallsTotal > 24) {
          return this.finish(task, false, 'Too many tool calls; stopping to avoid an infinite loop.');
        }
        await this.executeToolCalls(response.toolCalls);
        continue;
      }

      // No tool calls: decide based on whether real edits happened.
      if (!this.fileChanged) {
        if (response.content && response.content.trim()) {
          return this.finish(task, true, response.content);
        }
        return this.finish(task, false, 'Model produced no output and no tool calls.');
      }

      const verification = await this.verify(task, repo);
      this.verifyCount++;
      if (verification.passed) {
        return this.finish(task, true, verification.summary);
      }
      if (this.verifyCount > 3) {
        // Repeated verification failure: roll the repo back to the state before
        // this agent's edits rather than leaving broken work on disk for the
        // next task (or the user) to inherit.
        let rollbackNote = '';
        if (this.preEditCheckpoint) {
          try {
            rollbackNote = '\n' + await gitRollback(this.cwd, this.preEditCheckpoint);
            this.events.emit({ type: 'agent:log', agentId: this.id, message: rollbackNote.trim() });
          } catch (err) {
            rollbackNote = `\n(Rollback failed: ${err instanceof Error ? err.message : String(err)})`;
          }
          this.preEditCheckpoint = undefined;
        }
        return this.finish(task, false, 'Verification failed repeatedly:\n' + verification.summary + rollbackNote);
      }
      this.addAttempt(task, 'verify', [`${repo.testCommand || repo.buildCommand || 'verify'}`], 'failure', verification.summary);
      this.context.addKnownError(verification.summary);
      this.context.addMessage({ role: 'user', content: `Verification failed: ${verification.summary}. Continue and fix.` });
    }

    this.addAttempt(task, 'exhausted', [], 'failure', `Reached maximum iterations (${maxIterations})`);
    return this.finish(task, false, `Reached maximum iterations (${maxIterations})`);
  }

  /**
   * Budget-phase-aware model selection. When the budget drops to the "cheap"
   * or "verify" phase we fall back to the `fast` model profile for the rest of
   * the run (cheaper/lighter), which keeps critical reasoning on the full
   * profile while trimming spend on later, lower-risk iterations. Providers are
   * cached per profile so we don't rebuild them on every iteration.
   */
  private pickProvider(): ReturnType<typeof createProvider> {
    const base = this.profile.defaultModel ?? 'coding';
    let profile: ModelProfile = base;
    if (this.budget && this.budget.shouldUseCheaperModel()) {
      profile = 'fast';
    }
    if (profile === base) return this.provider;
    let p = this.providers.get(profile);
    if (!p) {
      p = createProvider(this.config.model, profile);
      this.providers.set(profile, p);
    }
    return p;
  }

  private isReadOnly(name: string): boolean {
    // Allowlist of non-mutating tools. Note: MCP resource tools registered as
    // <server>__resources_list/read are read-only by construction.
    return ['read', 'search', 'glob', 'inspect', 'get_function', 'find_callers', 'type_hierarchy', 'todo', 'skill', 'memory', 'chameleon'].includes(name)
      || /__resources_(list|read)$/.test(name);
  }

  /** Veto a tool call in plan mode, still answering its tool_call_id so the
   *  provider never sees a dangling reference. */
  private vetoToolCall(c: ToolCall, reason: string) {
    this.context.addMessage({ role: 'tool', tool_call_id: c.id, content: `Blocked: ${reason}`, name: c.function.name });
  }

  /** Mark a tool result as "file changed" and track the affected paths. */
  private trackFileChange(name: string, args: Record<string, unknown>, toolResult?: { output?: string }) {
    if (['write', 'edit', 'delete', 'patch'].includes(name)) {
      this.fileChanged = true;
      const path = String(args.path ?? '');
      if (path) this.context.addModifiedFile(resolve(this.cwd, path));
    }
    if (name === 'patch' && toolResult?.output) {
      for (const line of toolResult.output.split('\n')) {
        const m = line.match(/^- (?:added|updated|deleted) (.+?)(?: \(\d+ lines\))?$/);
        if (m) this.context.addModifiedFile(resolve(this.cwd, m[1]));
      }
    }
  }

  private async executeToolCalls(toolCalls: ToolCall[]) {
    const batch = [...toolCalls];
    while (batch.length > 0) {
      if (this.abortSignal?.aborted) return;
      const head = batch[0];
      if (this.isReadOnly(head.function.name)) {
        let n = 0;
        while (n < batch.length && n < 8 && this.isReadOnly(batch[n].function.name)) n++;
        const group = batch.splice(0, Math.max(n, 1));
        await Promise.all(group.map((tc) => this.runMoolCall(tc)));
        continue;
      }

      // Writes-edits to DISTINCT target files are independent and safe to run in
      // parallel, which lets the model create/edit several files in one turn
      // instead of paying a round-trip per file — a real cut to iterations/tokens.
      if (['write', 'edit', 'delete'].includes(head.function.name)) {
        const seen = new Set<string>();
        const group: ToolCall[] = [];
        const remaining: ToolCall[] = [];
        for (const tc of batch) {
          if (['write', 'edit', 'delete'].includes(tc.function.name)) {
            let path = '';
            try {
              path = String(JSON.parse(tc.function.arguments || '{}').path ?? '');
            } catch { /* treat as independent */ }
            if (seen.has(path)) { remaining.push(tc); continue; }
            seen.add(path);
            group.push(tc);
          } else {
            remaining.push(tc);
          }
        }
        batch.length = 0;
        batch.push(...remaining);
        await Promise.all(group.map((tc) => this.runMoolCall(tc)));
        continue;
      }

      // shell may depend on prior results, so run alone unless clearly read-only.
      batch.shift();
      await this.runMoolCall(head);
    }
  }

  /** Spawn a fresh child agent on a subtask and return a short summary. The
   *  child shares this run's config, workspace, events, cwd, abort signal,
   *  budget, and file read cache so delegation is cheap and consistent. */
  private async spawnSubagent(prompt: string, role?: string): Promise<string> {
    const childRole = (role ?? 'coder') as import('../types.js').AgentRole;
    const childProfile = new AgentProfileService(this.workspace.dir).get(childRole) ?? this.profile;
    const child = new Agent({
      id: `${this.id}-sub-${Math.random().toString(36).slice(2, 8)}`,
      role: childRole,
      modelProfile: childProfile.defaultModel ?? 'coding',
      profile: childProfile,
      config: this.config,
      workspace: this.workspace,
      events: this.events,
      cwd: this.cwd,
      context: new ContextEngine(this.config, this.cwd),
      budget: this.budget,
      abortSignal: this.abortSignal,
      readCache: this.readCache,
      subagentDepth: this.subagentDepth + 1,
    });
    const task: Task = {
      id: `sub-${Math.random().toString(36).slice(2, 10)}`,
      title: `Subtask: ${prompt.split('\n')[0].slice(0, 60)}`,
      description: prompt,
      role: childRole,
      status: 'pending',
      priority: 1,
      dependencies: [],
      acceptanceCriteria: [],
      attempts: [],
      createdAt: Date.now(),
    };
    const result = await child.run(task);
    return `[completed=${result.success}] ${result.summary} (${result.tokensUsed} tokens, ${result.durationMs}ms)`;
  }

  private async runMoolCall(tc: ToolCall): Promise<void> {
    if (this.abortSignal?.aborted) return;
    if (this.budget) {
      this.budget.recordToolCall();
      if (!this.budget.canExecuteTool()) {
        this.context.addKnownError('Tool budget exhausted');
        this.vetoToolCall(tc, 'Tool budget exhausted. Stop calling tools and give your final answer now.');
        return;
      }
    }
    const before = await this.hooks.runBefore('before_tool', { tool: tc.function.name });
    if (!before.allowed) {
      this.context.addKnownError(`before_tool hook vetoed ${tc.function.name}`);
      this.vetoToolCall(tc, `before_tool hook vetoed ${tc.function.name}.`);
      return;
    }
    if (['edit', 'write', 'delete', 'patch'].includes(tc.function.name)) {
      const editHook = await this.hooks.runBefore('before_edit', { tool: tc.function.name });
      if (!editHook.allowed) {
        this.vetoToolCall(tc, 'before_edit hook vetoed this edit.');
        return;
      }
    }
    if (tc.function.name === 'shell') {
      const shellHook = await this.hooks.runBefore('before_shell', { tool: tc.function.name });
      if (!shellHook.allowed) return;
    }
    const args = this.parseArgs(tc.function.arguments);
    // Pre-execution snapshot: take it BEFORE the first mutating tool runs so
    // the restore point predates the agent's own edits. Only on a CLEAN tree
    // (a dirty tree has user work we must never stash or reset away).
    if (['write', 'edit', 'delete', 'patch'].includes(tc.function.name) && !this.preEditCheckpoint && !this.checkpointFailed) {
      try {
        this.preEditCheckpoint = (await gitPreEditSnapshot(this.cwd, `mochi pre-edit [${this.id}]`)) ?? undefined;
      } catch {
        this.checkpointFailed = true;
      }
    }
    const ctx: ToolContext = {
      cwd: this.cwd,
      workspace: this.workspace,
      config: this.config,
      events: this.events,
      agentId: this.id,
      abortSignal: this.abortSignal,
      readCache: this.readCache,
      // Only the top-level agent (depth 0) can delegate; children cannot spawn
      // grandchildren, bounding the delegation tree to one level.
      ...(this.subagentDepth === 0
        ? { spawnSubagent: (prompt: string, opts?: { role?: string }) => this.spawnSubagent(prompt, opts?.role) }
        : {}),
    };
    const { output, error, durationMs } = await executeTool(tc.function.name, args, ctx, this.tools);
    const result: ToolResult = {
      toolCallId: tc.id,
      name: tc.function.name,
      output: error ? `Error: ${error}\n${output}` : output,
      error,
      durationMs,
    };
    this.context.addMessage({ role: 'tool', tool_call_id: tc.id, content: result.output, name: tc.function.name });
    this.events.emit({ type: 'tool:completed', tool: tc.function.name, result, agentId: this.id });
    await this.hooks.runAfter('after_tool', { tool: tc.function.name });
    if (['edit', 'write', 'delete', 'patch'].includes(tc.function.name)) {
      await this.hooks.runAfter('after_edit', { tool: tc.function.name });
    }
    if (tc.function.name === 'shell') {
      await this.hooks.runAfter('after_shell', { tool: tc.function.name });
    }
    if (error) {
      this.errors.push(error);
      this.context.addKnownError(error);
      const classified = classifyFailure(error);
      if (classified) {
        this.seenPatterns.add(classified.pattern);
        this.learning.record(classified.pattern, this.lastStrategy ?? 'unclassified', false);
      }
    }
    this.trackFileChange(tc.function.name, args, { output: result.output });
  }
  private parseArgs(raw: string): Record<string, unknown> {
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      // Fallback: treat as string content
      return { content: raw };
    }
  }

  private async verify(task: Task, repo: ReturnType<typeof detectRepo>): Promise<{ passed: boolean; summary: string }> {
    const checks: string[] = [];
    if (task.verificationCommand) {
      checks.push(task.verificationCommand);
    }
    if (repo.testCommand) checks.push(repo.testCommand);
    if (repo.typecheckCommand) checks.push(repo.typecheckCommand);
    if (repo.lintCommand) checks.push(repo.lintCommand);
    if (repo.buildCommand) checks.push(repo.buildCommand);
    if (checks.length === 0) return { passed: true, summary: 'No verification configured.' };

    for (const cmd of checks) {
      const out = await this.runShell(cmd, 180);
      if (out.includes('exit_code: 0') || out.trim().endsWith('PASS')) {
        continue;
      }
      return { passed: false, summary: `Check failed: ${cmd}\n${out.slice(0, 1000)}` };
    }
    return { passed: true, summary: `All checks passed: ${checks.join(', ')}` };
  }

  private pulse(iteration: number, task: Task): { abort: boolean; reason?: string; message?: string } {
    const recentErrors = this.errors.slice(-3);
    const allSame = recentErrors.length === 3 && new Set(recentErrors).size === 1;
    if (allSame) {
      return { abort: false, message: `Pulse: the last 3 errors were the same (${recentErrors[0]}). Try a different strategy or gather more context before retrying.` };
    }
    if (iteration > 0 && iteration % 12 === 0) {
      return { abort: false, message: `Pulse: ${iteration} iterations. Verify progress and switch approach if blocked.` };
    }
    if (this.errors.length >= 6) {
      return { abort: true, reason: `Too many repeated failures (${this.errors.length}). Stopping.` };
    }
    this.events.emit({ type: 'pulse', state: this.context.state });
    return { abort: false };
  }

  private addAttempt(task: Task, strategy: string, actions: string[], result: Attempt['result'], failureReason?: string) {
    task.attempts.push({
      id: randomUUID(),
      strategy,
      actions,
      result,
      failureReason,
      timestamp: Date.now(),
    });
  }

  private async runShell(command: string, timeout = 60): Promise<string> {
    const ctx: ToolContext = {
      cwd: this.cwd,
      workspace: this.workspace,
      config: this.config,
      events: this.events,
      agentId: this.id,
    };
    const { output, error } = await executeTool('shell', { command, timeout }, ctx, this.tools);
    return error ? `Error: ${error}\n${output}` : output;
  }

  private emitMessage(role: 'assistant' | 'user' | 'system', content: string) {
    this.events.emit({ type: 'message', role, content, agentId: this.id });
  }

  private finish(task: Task, success: boolean, summary: string): AgentResult {
    this.mcpClose?.();
    this.mcpClose = undefined;
    this.budget?.recordAgentEnd();
    if (success) {
      for (const pattern of this.seenPatterns) {
        this.learning.record(pattern, this.lastStrategy ?? 'unclassified', true);
      }
    }
    const durationMs = Math.round(performance.now() - this.startTime);
    this.events.emit({ type: success ? 'task:completed' : 'task:failed', task, agentId: this.id, reason: summary });
    this.events.emit({ type: 'agent:completed', id: this.id, taskId: task.id });
    return {
      success,
      summary,
      filesModified: [...new Set(this.context['state'].filesModified)],
      attempts: this.errors.length + 1,
      tokensUsed: this.tokensUsed,
      durationMs,
    };
  }
}
