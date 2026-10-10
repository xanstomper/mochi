// Mochi SDK — embed Mochi programmatically (in-process) or drive a running
// daemon over HTTP (remote). One typed surface for both modes, so scripts,
// editors, CI jobs, and other agents can drive Mochi like the CLI does.
//
//   import { Mochi } from 'mochi';
//   const mochi = Mochi.create({ cwd: '/path/to/project' });  // in-process
//   const r = await mochi.prompt('fix the failing test in src/auth.ts');
//
//   const mochi = Mochi.connect({ port: 8642, token: '...' }); // remote daemon
//   await mochi.goal('add a REST endpoint for user avatars');
//
// Modes:
//  - in-process (Mochi.create): constructs a Runtime directly — full tool
//    access, no server needed. For scripts, CI, one-shot automation.
//  - remote (Mochi.connect): POSTs to the daemon's /api/* endpoints. Shares
//    workspace state, cron, and the SSE stream with the running daemon.
import { Runtime } from './runtime.js';
import { SessionStore } from './session-store.js';
import { addFact, recallFacts } from './memory-store.js';
import type { MochiConfig } from './types.js';

export interface RunResult {
  summary: string;
  status: string;
  success: boolean;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  filesModified: string[];
}

export interface GoalResultSdk {
  goalId: string;
  status: string;
  summary: string;
  tasks: Array<{ title: string; status: string }>;
}

export class Mochi {
  private constructor(private rt: Runtime) {}

  /** In-process SDK: construct a Runtime and wrap it. */
  static create(opts: { cwd?: string; config?: Partial<MochiConfig> } = {}): Mochi {
    return new Mochi(Runtime.create({ cwd: opts.cwd, config: opts.config }));
  }

  /** Remote mode: attach to a running daemon. */
  static connect(opts: { port: number; token?: string }): RemoteMochi {
    return new RemoteMochi(opts.port, opts.token ?? '');
  }

  /** One-shot prompt → full agent run → structured result. */
  async prompt(task: string): Promise<RunResult> {
    const r = await this.rt.runPromptDetailed(task);
    return {
      summary: r.summary, status: r.status, success: r.success,
      tokensUsed: r.tokensUsed, costUsd: r.costUsd, durationMs: r.durationMs,
      filesModified: r.filesModified,
    };
  }

  /** Alias of prompt() — reads as an instruction. */
  async run(task: string): Promise<RunResult> { return this.prompt(task); }

  /** Structured multi-step objective (task DAG + verifier + self-review). */
  async goal(objective: string, constraints: string[] = []): Promise<GoalResultSdk> {
    const r = await this.rt.runGoal(objective, constraints);
    return {
      goalId: r.goalId, status: r.status, summary: r.summary,
      tasks: r.tasks.map((t) => ({ title: t.title, status: t.status })),
    };
  }

  /** Plan without executing. */
  async plan(objective: string): Promise<string> { return this.rt.plan(objective); }

  /** Self-improvement cycles → report text. */
  async selfTrain(opts: { cycles?: number; focus?: string } = {}): Promise<string> {
    const r = await this.rt.selfTrain(opts);
    return r.report;
  }

  /** Switch provider/model at runtime (same semantics as /model). */
  async useProvider(providerId: string, model?: string): Promise<string> {
    return this.rt.useProvider(providerId, model);
  }

  /** Session operations. */
  newSession(): string { return this.rt.newSession(); }
  branchSession(title?: string): string { return this.rt.branchSession(title); }

  /** Session recall: recent past sessions (titles + objectives). */
  sessions(limit = 10): Array<{ id: string; objective: string; updated: number }> {
    return new SessionStore(this.rt.cwd).list(limit).map((s) => ({ id: s.id, objective: s.objective, updated: s.updatedAt }));
  }

  /** Persist a durable memory fact (MCH-42 store: dedup + scoring). */
  remember(statement: string, category: 'fact' | 'preference' | 'convention' | 'history' = 'fact'): boolean {
    return addFact(statement, category) !== null;
  }

  /** Semantic recall of relevant memory facts for a context. */
  recall(context: string, limit = 15): Array<{ statement: string; category: string }> {
    return recallFacts(context, limit).map((f) => ({ statement: f.statement, category: f.category }));
  }

  /** Raw Runtime escape hatch for anything the typed surface lacks. */
  get runtime(): Runtime { return this.rt; }
}

/** Thin typed client over the daemon's HTTP API. */
export class RemoteMochi {
  constructor(private port: number, private token: string) {}

  private base(): string { return `http://127.0.0.1:${this.port}`; }
  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) };
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base()}${path}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    return res.json() as Promise<Record<string, unknown>>;
  }

  async status(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base()}/api/status`, { headers: this.headers() });
    return res.json() as Promise<Record<string, unknown>>;
  }

  /** One-shot prompt against the daemon (same semantics as local prompt()). */
  async prompt(task: string): Promise<RunResult> {
    const r = await this.post('/api/prompt', { task });
    return {
      summary: String(r.summary ?? ''),
      status: String(r.status ?? 'unknown'),
      success: !!r.success,
      tokensUsed: Number(r.tokensUsed ?? 0),
      costUsd: Number(r.costUsd ?? 0),
      durationMs: Number(r.durationMs ?? 0),
      filesModified: Array.isArray(r.filesModified) ? (r.filesModified as string[]) : [],
    };
  }

  /** Typed convenience over status(). */
  async statusTyped(): Promise<{ ready: boolean; tasks: number; activeAgents: number }> {
    const s = await this.status();
    return { ready: !!s.ready, tasks: Number(s.tasks ?? 0), activeAgents: Number(s.activeAgents ?? 0) };
  }

  async goal(objective: string): Promise<Record<string, unknown>> { return this.post('/api/goal', { objective }); }
  async plan(objective: string): Promise<Record<string, unknown>> { return this.post('/api/plan', { objective }); }
  async approve(): Promise<Record<string, unknown>> { return this.post('/api/approve', {}); }
  async resume(goalId: string): Promise<Record<string, unknown>> { return this.post('/api/resume', { goalId }); }
}