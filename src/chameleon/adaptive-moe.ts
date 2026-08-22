/**
 * Lazy Chameleon Adaptive MoE Engine
 * 
 * Dynamic cellular expert expansion: split to conquer, merge to aggregate.
 * Decomposes tasks into micro-experts, branches them for deep domain coverage,
 * and synthesizes dense, structured parameter datasets.
 */

export type ExpertRole =
  | 'planner'
  | 'coder'
  | 'critic'
  | 'verifier'
  | 'optimizer'
  | 'security'
  | 'explainer'
  | 'researcher'
  | 'merger';

export interface MicroExpert {
  id: string;
  role: ExpertRole;
  goal: string;
  specialization: string;
  confidence: number;
  budgetRemaining: number;
  parentId?: string;
  childrenIds: string[];
  alive: boolean;
  result: string;
}

export interface MoEConfig {
  baseExperts: number;
  maxExperts: number;
  splitThreshold: number;
  mergeThreshold: number;
  expertBudget: number;
}

export const ROLE_TEMPLATES: Record<ExpertRole, string> = {
  planner: 'Deconstruct approaches, isolate sub-problems, and build dependency DAGs.',
  coder: 'Derive concrete data structures, AST schemas, and implementation logic.',
  critic: 'Expose edge-case hazards, race conditions, and hidden assumptions.',
  verifier: 'Establish mathematical invariants, boundary tests, and proof criteria.',
  optimizer: 'Maximize throughput, eliminate redundant allocations, and align caches.',
  security: 'Audit threat surfaces, privilege escalations, and injection vectors.',
  explainer: 'Synthesize complex findings into high-density technical instructions.',
  researcher: 'Extract domain conventions, API realities, and protocol specs.',
  merger: 'Cross-correlate expert findings and synthesize unified datasets.',
};

export const SCALE_MAP: Record<string, number> = {
  flash: 2,
  turbo: 4,
  easy: 4,
  medium: 8,
  hard: 12,
  deep: 16,
  extreme: 24,
  genius: 32,
  god: 32,
};

export class AdaptiveMoE {
  private experts: Map<string, MicroExpert> = new Map();
  private counter = 0;

  constructor(public config: MoEConfig = {
    baseExperts: 4,
    maxExperts: 32,
    splitThreshold: 0.7,
    mergeThreshold: 0.3,
    expertBudget: 50,
  }) {}

  spawnExpert(
    role: ExpertRole,
    goal: string,
    specialization = '',
    parentId?: string,
    budget = 50,
  ): MicroExpert {
    const id = `exp-${++this.counter}`;
    const expert: MicroExpert = {
      id,
      role,
      goal,
      specialization: specialization || ROLE_TEMPLATES[role] || '',
      confidence: 0.5,
      budgetRemaining: budget,
      parentId,
      childrenIds: [],
      alive: true,
      result: '',
    };
    this.experts.set(id, expert);
    if (parentId && this.experts.has(parentId)) {
      this.experts.get(parentId)!.childrenIds.push(id);
    }
    return expert;
  }

  splitExpert(expert: MicroExpert, nChildren = 2): MicroExpert[] {
    const subGoals = this.decomposeGoal(expert.goal, nChildren);
    const children: MicroExpert[] = [];
    const childBudget = Math.max(10, Math.floor(expert.budgetRemaining / nChildren));

    for (const goal of subGoals) {
      const child = this.spawnExpert(
        expert.role,
        goal,
        expert.specialization,
        expert.id,
        childBudget,
      );
      children.push(child);
    }
    expert.alive = false; // Parent cell consumed by division
    return children;
  }

  mergeExperts(experts: MicroExpert[]): MicroExpert {
    const results = experts.filter((e) => e.result).map((e) => e.result);
    const mergedResult = results.join('\n\n---\n\n');
    const avgConf = experts.reduce((sum, e) => sum + e.confidence, 0) / Math.max(experts.length, 1);

    const merged = this.spawnExpert('merger', 'Aggregate results from sub-experts', '', undefined, 20);
    merged.result = mergedResult;
    merged.confidence = avgConf;

    for (const e of experts) {
      e.alive = false;
    }
    return merged;
  }

  scaleToTask(task: string, difficulty = 'medium'): MicroExpert[] {
    const count = Math.min(SCALE_MAP[difficulty] || 8, this.config.maxExperts);
    const roles: ExpertRole[] = ['planner', 'coder', 'critic', 'verifier', 'optimizer', 'security'];
    const spawned: MicroExpert[] = [];

    for (let i = 0; i < count; i++) {
      const role = roles[i % roles.length];
      const exp = this.spawnExpert(role, `[${role}] ${task.slice(0, 120)}`, '', undefined, this.config.expertBudget);
      spawned.push(exp);
    }
    return spawned;
  }

  aggregateResults(experts: MicroExpert[]): {
    merged: string;
    confidence: number;
    expertCount: number;
    byRole: Record<string, string[]>;
  } {
    const completed = experts.filter((e) => e.result);
    const byRole: Record<string, string[]> = {};

    for (const e of completed) {
      if (!byRole[e.role]) byRole[e.role] = [];
      byRole[e.role].push(e.result);
    }

    const sections: string[] = [];
    for (const [role, results] of Object.entries(byRole)) {
      sections.push(`=== MOE CELL [${role.toUpperCase()}] ===\n` + results.join('\n\n'));
    }

    const avgConf = completed.length > 0
      ? completed.reduce((sum, e) => sum + e.confidence, 0) / completed.length
      : 0;

    return {
      merged: sections.join('\n\n'),
      confidence: Number(avgConf.toFixed(2)),
      expertCount: completed.length,
      byRole,
    };
  }

  private decomposeGoal(goal: string, n: number): string[] {
    const aspects = [
      `Core structural logic: ${goal}`,
      `Edge cases and boundary invariant proof: ${goal}`,
      `Performance, caching, and allocation optimization: ${goal}`,
      `Concurrency, atomicity, and error handling: ${goal}`,
      `Automated testing and verification harness: ${goal}`,
    ];
    return aspects.slice(0, n);
  }
}
