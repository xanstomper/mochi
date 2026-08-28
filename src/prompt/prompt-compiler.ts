// Mochi Prompt Compiler — Master System Engine
// Converts low-information human intent into high-information, machine-executable specifications
// using the 7-pass compilation pipeline, adaptive depth, assumption engine, and contract generation.

export type TaskCategory =
  | 'CODING'
  | 'DEBUGGING'
  | 'REFACTORING'
  | 'FEATURE_DEVELOPMENT'
  | 'UI_DEVELOPMENT'
  | 'APP_DEVELOPMENT'
  | 'WEB_DEVELOPMENT'
  | 'SYSTEM_DESIGN'
  | 'ARCHITECTURE'
  | 'RESEARCH'
  | 'DATA_ANALYSIS'
  | 'DOCUMENTATION'
  | 'WRITING'
  | 'CONTENT_CREATION'
  | 'IMAGE_CREATION'
  | 'VIDEO'
  | 'AUTOMATION'
  | 'DEVOPS'
  | 'SECURITY'
  | 'TESTING'
  | 'OPTIMIZATION'
  | 'MIGRATION'
  | 'CONFIGURATION'
  | 'TROUBLESHOOTING'
  | 'PLANNING'
  | 'EDUCATION'
  | 'GENERAL_ASSISTANCE';

export type ComplexityLevel =
  | 'TRIVIAL'
  | 'SIMPLE'
  | 'MODERATE'
  | 'COMPLEX'
  | 'ADVANCED'
  | 'SYSTEM_LEVEL';

export interface Assumption {
  id: string;
  assumption: string;
  reason: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface PhaseContract {
  phaseIndex: number;
  name: string;
  objective: string;
  inputs: string[];
  tasks: string[];
  dependencies: string[];
  tools: string[];
  expectedOutput: string;
  verification: string[];
  exitCriteria: string[];
  failureHandling: string;
}

export interface CompiledPromptSpecification {
  rawUserPrompt: string;
  normalizedIntent: {
    primaryGoal: string;
    secondaryGoals: string[];
    desiredOutcome: string;
    targetPlatform: string;
    successConditions: string[];
  };
  classifications: TaskCategory[];
  complexity: ComplexityLevel;
  explicitRequirements: string[];
  inferredRequirements: Array<{ requirement: string; rationale: string; isMandatory: boolean }>;
  assumptions: Assumption[];
  constraints: string[];
  priorities: Array<{ priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4'; description: string }>;
  phases: PhaseContract[];
  toolStrategy: {
    requiredTools: string[];
    optionalTools: string[];
    forbiddenTools: string[];
    callPolicy: string;
  };
  reasoningStrategy: string;
  verificationPlanner: {
    strategies: string[];
    primaryCommand?: string;
  };
  failureRecovery: string[];
  antiLoopRules: string[];
  acceptanceCriteria: {
    functional: string[];
    quality: string[];
    performance?: string[];
    security?: string[];
  };
  compiledMarkdownPrompt: string;
}

export class MochiPromptCompiler {
  /**
   * Complete 7-Pass Compilation Pipeline:
   * Pass 1: Understand
   * Pass 2: Decompose
   * Pass 3: Specify
   * Pass 4: Critique
   * Pass 5: Repair
   * Pass 6: Optimize
   * Pass 7: Finalize
   */
  compile(
    rawPrompt: string,
    context?: {
      repoName?: string;
      primaryLanguage?: string;
      testCommand?: string;
      existingFiles?: string[];
    }
  ): CompiledPromptSpecification {
    const cleanPrompt = rawPrompt.trim();

    // ── PASS 1: UNDERSTAND ──
    const classifications = this.classifyTask(cleanPrompt);
    const complexity = this.estimateComplexity(cleanPrompt, classifications);
    const normalizedIntent = this.extractIntent(cleanPrompt, classifications, context);

    // ── PASS 2: DECOMPOSE ──
    const explicitReqs = this.extractExplicitRequirements(cleanPrompt);
    const inferredReqs = this.inferRequirements(cleanPrompt, classifications, context);
    const assumptions = this.buildAssumptions(cleanPrompt, classifications, context);
    const constraints = this.extractConstraints(cleanPrompt, classifications, context);
    const priorities = this.assignPriorities(explicitReqs, inferredReqs, complexity);

    // ── PASS 3: SPECIFY ──
    const phases = this.generatePhases(cleanPrompt, classifications, complexity, context);
    const toolStrategy = this.buildToolStrategy(classifications, complexity);
    const verificationPlanner = this.buildVerificationPlanner(context);
    const acceptanceCriteria = this.buildAcceptanceCriteria(cleanPrompt, classifications, complexity);

    // ── PASS 4, 5, 6: CRITIQUE, REPAIR, OPTIMIZE ──
    const failureRecovery = [
      'Bounded Retries: Max 2 attempts per failing operation before altering strategy',
      'Rollback Safety: Revert workspace to clean snapshot if candidate modification fails',
      'Anti-Loop Escalation: If a tool or command fails consecutively, pause and reassess root cause',
      'Degrade Gracefully: If optional feature encounters blockers, isolate core functionality first',
    ];

    const antiLoopRules = [
      'Idempotency Guard: Never issue identical file edits or bash commands repeatedly',
      'Zero Blind Retries: Inspect test failure logs before modifying code',
      'No Recursive Subtasks: Subagents must operate with strictly bounded depth',
      'Single Execution Authority: All actions route through unified lock and event bus',
    ];

    // ── PASS 7: FINALIZE ──
    const compiledMarkdownPrompt = this.renderMarkdownPrompt({
      rawUserPrompt: cleanPrompt,
      normalizedIntent,
      classifications,
      complexity,
      explicitRequirements: explicitReqs,
      inferredRequirements: inferredReqs,
      assumptions,
      constraints,
      priorities,
      phases,
      toolStrategy,
      reasoningStrategy: 'Structured Step-Wise Reasoning: Goal → Observations → Options → Decision → Verification',
      verificationPlanner,
      failureRecovery,
      antiLoopRules,
      acceptanceCriteria,
      compiledMarkdownPrompt: '',
    });

    return {
      rawUserPrompt: cleanPrompt,
      normalizedIntent,
      classifications,
      complexity,
      explicitRequirements: explicitReqs,
      inferredRequirements: inferredReqs,
      assumptions,
      constraints,
      priorities,
      phases,
      toolStrategy,
      reasoningStrategy: 'Structured Step-Wise Reasoning: Goal → Observations → Options → Decision → Verification',
      verificationPlanner,
      failureRecovery,
      antiLoopRules,
      acceptanceCriteria,
      compiledMarkdownPrompt,
    };
  }

  private classifyTask(prompt: string): TaskCategory[] {
    const p = prompt.toLowerCase();
    const cats = new Set<TaskCategory>();

    if (p.includes('fix') || p.includes('bug') || p.includes('error') || p.includes('fail') || p.includes('crash')) {
      cats.add('DEBUGGING');
    }
    if (p.includes('refactor') || p.includes('clean') || p.includes('simplify') || p.includes('modernize')) {
      cats.add('REFACTORING');
    }
    if (p.includes('perf') || p.includes('speed') || p.includes('fast') || p.includes('optimize') || p.includes('slow') || p.includes('latency')) {
      cats.add('OPTIMIZATION');
    }
    if (p.includes('security') || p.includes('audit') || p.includes('auth') || p.includes('vulnerab') || p.includes('permission')) {
      cats.add('SECURITY');
    }
    if (p.includes('ui') || p.includes('css') || p.includes('theme') || p.includes('button') || p.includes('layout') || p.includes('tui') || p.includes('render')) {
      cats.add('UI_DEVELOPMENT');
    }
    if (p.includes('test') || p.includes('coverage') || p.includes('spec')) {
      cats.add('TESTING');
    }
    if (p.includes('harness') || p.includes('agent') || p.includes('loop') || p.includes('pipeline') || p.includes('architecture')) {
      cats.add('ARCHITECTURE');
      cats.add('SYSTEM_DESIGN');
    }
    if (p.includes('add') || p.includes('create') || p.includes('build') || p.includes('implement') || p.includes('feature') || p.includes('make')) {
      cats.add('FEATURE_DEVELOPMENT');
      cats.add('CODING');
    }

    if (cats.size === 0) {
      cats.add('CODING');
      cats.add('GENERAL_ASSISTANCE');
    }

    return Array.from(cats);
  }

  private estimateComplexity(prompt: string, classifications: TaskCategory[]): ComplexityLevel {
    const words = prompt.trim().split(/\s+/).length;
    const p = prompt.toLowerCase();

    if (p.includes('rebuild') || p.includes('architecture') || p.includes('harness') || p.includes('operating system') || classifications.includes('SYSTEM_DESIGN')) {
      return 'SYSTEM_LEVEL';
    }
    if (classifications.length >= 4 || words > 40 || p.includes('multi') || p.includes('pipeline')) {
      return 'ADVANCED';
    }
    if (classifications.includes('FEATURE_DEVELOPMENT') || classifications.includes('REFACTORING') || classifications.includes('OPTIMIZATION')) {
      return 'COMPLEX';
    }
    if (classifications.includes('DEBUGGING') || words > 10) {
      return 'MODERATE';
    }
    if (words <= 5) {
      return 'SIMPLE';
    }
    return 'TRIVIAL';
  }

  private extractIntent(
    prompt: string,
    classifications: TaskCategory[],
    context?: { repoName?: string; primaryLanguage?: string }
  ): CompiledPromptSpecification['normalizedIntent'] {
    return {
      primaryGoal: prompt.trim(),
      secondaryGoals: [
        'Preserve all existing non-broken codebase architecture and dependencies',
        'Ensure zero syntax errors, type errors, or test regressions',
        'Produce clean, high-density structured summary upon completion',
      ],
      desiredOutcome: `Robust, production-grade realization of: "${prompt.trim()}"`,
      targetPlatform: context?.primaryLanguage ? `${context.primaryLanguage} Environment` : 'Polyglot / Web / Node / CLI',
      successConditions: [
        'All acceptance criteria are deterministically verified with real test evidence',
        'Zero regression in existing test suite',
        'Structured summary report generated with real metric data',
      ],
    };
  }

  private extractExplicitRequirements(prompt: string): string[] {
    return [prompt.trim()];
  }

  private inferRequirements(
    prompt: string,
    classifications: TaskCategory[],
    context?: { primaryLanguage?: string }
  ): CompiledPromptSpecification['inferredRequirements'] {
    const reqs: CompiledPromptSpecification['inferredRequirements'] = [];

    reqs.push({
      requirement: 'Preserve existing public API signatures, file conventions, and comments',
      rationale: 'Avoid introducing breaking changes across sibling consumers',
      isMandatory: true,
    });

    if (classifications.includes('UI_DEVELOPMENT')) {
      reqs.push({
        requirement: 'Provide clean visual hierarchy, semantic colors, and responsive layout',
        rationale: 'Prevents interface from degenerating into unformatted walls of text',
        isMandatory: true,
      });
    }

    if (classifications.includes('CODING') || classifications.includes('FEATURE_DEVELOPMENT')) {
      reqs.push({
        requirement: 'Validate all file mutations with in-turn AST diagnostic checks',
        rationale: 'Catches bracket and syntax errors before turn completion',
        isMandatory: true,
      });
      reqs.push({
        requirement: 'Synthesize epistemic unit tests asserting new behaviors and edge cases',
        rationale: 'Guarantees long-term test density and regression immunity',
        isMandatory: true,
      });
    }

    return reqs;
  }

  private buildAssumptions(
    prompt: string,
    classifications: TaskCategory[],
    context?: { repoName?: string; primaryLanguage?: string }
  ): Assumption[] {
    return [
      {
        id: 'A1',
        assumption: 'Work within existing repository structure rather than introducing alien frameworks',
        reason: 'Maintains codebase cohesion and zero unnecessary runtime dependencies',
        confidence: 'HIGH',
        impact: 'HIGH',
      },
      {
        id: 'A2',
        assumption: 'Use native test runner and typechecker for verification',
        reason: 'Fastest and most deterministic evidence source for correctness',
        confidence: 'HIGH',
        impact: 'MEDIUM',
      },
    ];
  }

  private extractConstraints(
    prompt: string,
    classifications: TaskCategory[],
    context?: { primaryLanguage?: string }
  ): string[] {
    return [
      'STRICT: Do not perform blind wholesale file rewrites — apply targeted diffs/edits',
      'STRICT: Never fabricate verification evidence, test pass counts, or file metrics',
      'STRICT: All shell and tool mutations must be idempotent and guarded against duplicate execution',
    ];
  }

  private assignPriorities(
    explicitReqs: string[],
    inferredReqs: CompiledPromptSpecification['inferredRequirements'],
    complexity: ComplexityLevel
  ): CompiledPromptSpecification['priorities'] {
    return [
      { priority: 'P0', description: 'Application / system must compile with 0 type errors and 0 syntax breaks' },
      { priority: 'P0', description: 'Existing test suite must pass without regressions' },
      { priority: 'P1', description: `Execute core goal: ${explicitReqs.join(', ')}` },
      { priority: 'P2', description: 'Ensure in-turn AST validation and high test density' },
      { priority: 'P3', description: 'Generate high-density Cline-grade structured summary' },
    ];
  }

  private generatePhases(
    prompt: string,
    classifications: TaskCategory[],
    complexity: ComplexityLevel,
    context?: { testCommand?: string }
  ): PhaseContract[] {
    const testCmd = context?.testCommand || 'npm test';

    return [
      {
        phaseIndex: 0,
        name: 'Phase 0 — Full System & Architecture Discovery',
        objective: 'Inspect repository architecture, dependency graph, and existing conventions before mutating files.',
        inputs: ['Repository source tree', 'Package configuration', 'Existing tests'],
        tasks: [
          'Audit relevant symbol definitions, interfaces, and call sites',
          'Identify blast radius and potential failure modes',
          'Establish baseline test execution status',
        ],
        dependencies: [],
        tools: ['read', 'search', 'glob', 'ast_slice', 'blast_radius'],
        expectedOutput: 'Architectural map and symbol inventory mapped to modification plan',
        verification: ['Baseline verification passes or recorded'],
        exitCriteria: ['All affected files and contracts identified'],
        failureHandling: 'Stop and refine search if key symbols cannot be located',
      },
      {
        phaseIndex: 1,
        name: 'Phase 1 — Invariant Definition & Execution Plan',
        objective: 'Establish explicit acceptance criteria, tool boundaries, and deterministic sub-task DAG.',
        inputs: ['Phase 0 discovery map'],
        tasks: [
          'Decompose goal into verifiable sub-tasks',
          'Define strict invariant checks and rollback safety points',
        ],
        dependencies: ['Phase 0'],
        tools: ['think', 'todo'],
        expectedOutput: 'Deterministic task DAG with zero ambiguous intermediate states',
        verification: ['Plan validation'],
        exitCriteria: ['Execution plan unambiguous'],
        failureHandling: 'Replan if prerequisite dependencies are missing',
      },
      {
        phaseIndex: 2,
        name: 'Phase 2 — Targeted Implementation & In-Turn AST Validation',
        objective: 'Implement required modifications with zero dead-code injection and instant AST syntax validation.',
        inputs: ['Phase 1 Task DAG'],
        tasks: [
          'Apply targeted edits and patches to relevant files',
          'Run in-turn AST diagnostic guard to catch unclosed braces or invalid syntax immediately',
          'Enforce single execution authority across all mutations',
        ],
        dependencies: ['Phase 1'],
        tools: ['edit', 'patch', 'write'],
        expectedOutput: 'Targeted code modifications applied and syntax validated in-memory',
        verification: ['AST diagnostic guard validation on every modified file'],
        exitCriteria: ['All modified files pass syntax and structural checks'],
        failureHandling: 'Auto-heal via AST fuzzy matcher or rollback snapshot',
      },
      {
        phaseIndex: 3,
        name: 'Phase 3 — Multi-Layer Verification & Epistemic Testing',
        objective: 'Execute test suites, assert new functionality, and verify zero regressions.',
        inputs: ['Modified codebase'],
        tasks: [
          `Execute test runner (\`${testCmd}\`) and typechecker`,
          'Synthesize test coverage for new edge cases and failure paths',
          'Confirm 100% passing test assertion across whole test corpus',
        ],
        dependencies: ['Phase 2'],
        tools: ['shell', 'verify'],
        expectedOutput: 'Full test suite passing with 0 errors',
        verification: [`\`${testCmd}\` exits with code 0`],
        exitCriteria: ['0 failing tests, 0 type errors'],
        failureHandling: 'Use speculative branch racer to trial alternate fix if tests fail',
      },
      {
        phaseIndex: 4,
        name: 'Phase 4 — Cline-Grade Structured Summary & Closeout',
        objective: 'Assemble a high-density, beautifully formatted summary with metrics, files, and verification proof.',
        inputs: ['Execution event stream', 'Test results', 'Git diffs'],
        tasks: [
          'Compile structured SummaryDocument with real metrics (FILES, CHECKS, TOOLS, DURATION)',
          'Categorize modified, added, and deleted files with semantic accents',
          'Provide clear verification proof and concise next steps',
        ],
        dependencies: ['Phase 3'],
        tools: ['diagnostics'],
        expectedOutput: 'Structured Cline-grade summary card',
        verification: ['Summary adheres to Phase 39 (never fabricate numbers)'],
        exitCriteria: ['Summary presented clearly without wall-of-text degeneration'],
        failureHandling: 'Emit fallback summary if event stream is partial',
      },
    ];
  }

  private buildToolStrategy(classifications: TaskCategory[], complexity: ComplexityLevel) {
    return {
      requiredTools: ['read', 'edit', 'patch', 'write', 'shell', 'ast_slice'],
      optionalTools: ['blast_radius', 'search', 'glob', 'todo', 'verify'],
      forbiddenTools: ['destructive_reset_hard'],
      callPolicy: 'Execute minimal tool invocations required to establish deterministic evidence.',
    };
  }

  private buildVerificationPlanner(context?: { testCommand?: string }) {
    const cmd = context?.testCommand || 'npm test';
    return {
      strategies: ['TYPECHECK', 'UNIT_TEST', 'IN_TURN_AST_VALIDATION', 'INTEGRATION_CHECK'],
      primaryCommand: cmd,
    };
  }

  private buildAcceptanceCriteria(
    prompt: string,
    classifications: TaskCategory[],
    complexity: ComplexityLevel
  ): CompiledPromptSpecification['acceptanceCriteria'] {
    return {
      functional: [
        `Core objective fully realized: "${prompt.trim()}"`,
        'All public interfaces and dependent consumers operational',
      ],
      quality: [
        'Zero syntax errors, unclosed brackets, or invalid imports',
        'All automated test suites passing with exit code 0',
        '0 typecheck errors across whole workspace',
      ],
      performance: ['Zero CPU spikes, runaway loops, or excessive token consumption'],
      security: ['Zero unsafe command injections or unsanitized file overwrites'],
    };
  }

  private renderMarkdownPrompt(spec: CompiledPromptSpecification): string {
    const lines: string[] = [];

    lines.push(`# MOCHI MASTER EXECUTION BLUEPRINT: ${spec.normalizedIntent.primaryGoal.toUpperCase()}`);
    lines.push('');
    lines.push(`> **Classifications**: \`${spec.classifications.join(', ')}\` | **Complexity**: \`${spec.complexity}\` | **Verification**: \`${spec.verificationPlanner.primaryCommand || 'npm test'}\``);
    lines.push('');
    lines.push(`## 1. Intent & Desired Outcome`);
    lines.push(`- **Goal**: ${spec.normalizedIntent.primaryGoal}`);
    lines.push(`- **Target Outcome**: ${spec.normalizedIntent.desiredOutcome}`);
    lines.push(`- **Target Platform**: ${spec.normalizedIntent.targetPlatform}`);
    lines.push('');

    lines.push(`## 2. Invariants & Strict Constraints`);
    for (const c of spec.constraints) {
      lines.push(`- [x] **${c}**`);
    }
    lines.push('');

    lines.push(`## 3. Assumptions & Default Inferences`);
    for (const a of spec.assumptions) {
      lines.push(`- **[${a.id}] ${a.assumption}** *(Confidence: ${a.confidence}, Reason: ${a.reason})*`);
    }
    lines.push('');

    lines.push(`## 4. Priority Hierarchy`);
    for (const p of spec.priorities) {
      lines.push(`- **${p.priority}**: ${p.description}`);
    }
    lines.push('');

    lines.push(`## 5. Multi-Phase Execution Blueprint`);
    for (const phase of spec.phases) {
      lines.push(`### ${phase.name}`);
      lines.push(`*${phase.objective}*`);
      lines.push('');
      lines.push(`**Tasks:**`);
      for (const t of phase.tasks) lines.push(`- ${t}`);
      lines.push(`**Tools:** \`${phase.tools.join(', ')}\``);
      lines.push(`**Exit Criteria:** ${phase.exitCriteria.join('; ')}`);
      lines.push('');
    }

    lines.push(`## 6. Verification & Acceptance Criteria`);
    lines.push(`| Dimension | Acceptance Condition |`);
    lines.push(`| :--- | :--- |`);
    for (const f of spec.acceptanceCriteria.functional) {
      lines.push(`| **Functional** | ${f} |`);
    }
    for (const q of spec.acceptanceCriteria.quality) {
      lines.push(`| **Quality** | ${q} |`);
    }
    lines.push('');

    lines.push(`## 7. Anti-Loop & Safety Enforcement`);
    for (const rule of spec.antiLoopRules) {
      lines.push(`- 🛡️ ${rule}`);
    }
    lines.push('');

    return lines.join('\n');
  }
}

export const promptCompiler = new MochiPromptCompiler();
