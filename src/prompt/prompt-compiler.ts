// Mochi Prompt Compiler — Master System Engine
// Converts low-information human intent into high-information, machine-executable specifications
// tailored across reasoning tiers: low (micro), medium (streamlined), high (action-multi-phase), and max (architectural).

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

export type CompilerReasoningLevel = 'max' | 'high' | 'medium' | 'low' | 'off' | 'auto';

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
  reasoningLevel: CompilerReasoningLevel;
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
   * Compiles user intent according to the active reasoning tier:
   * - 'max': Full 7-pass engineering specification with 5-phase contracts and formal verification.
   * - 'high': Action-oriented multi-phase blueprint (3 focused phases, high speed & accuracy).
   * - 'medium': Streamlined invariant-first contract (concise objective, safety invariants, targeted actions).
   * - 'low': Ultra-compact micro-tier directive (zero fluff, immediate tool execution, maximum token economy).
   */
  compile(
    rawPrompt: string,
    options?: {
      reasoning?: CompilerReasoningLevel;
      repoName?: string;
      primaryLanguage?: string;
      testCommand?: string;
      existingFiles?: string[];
    }
  ): CompiledPromptSpecification {
    const cleanPrompt = rawPrompt.trim();
    const reasoning: CompilerReasoningLevel = options?.reasoning || 'max';

    const classifications = this.classifyTask(cleanPrompt);
    const complexity = this.estimateComplexity(cleanPrompt, classifications);
    const normalizedIntent = this.extractIntent(cleanPrompt, classifications, options);

    const explicitReqs = this.extractExplicitRequirements(cleanPrompt);
    const inferredReqs = this.inferRequirements(cleanPrompt, classifications, options);
    const assumptions = this.buildAssumptions(cleanPrompt, classifications, options);
    const constraints = this.extractConstraints(cleanPrompt, classifications, options);
    const priorities = this.assignPriorities(explicitReqs, inferredReqs, complexity);

    const phases = this.generatePhasesForTier(cleanPrompt, classifications, complexity, reasoning, options);
    const toolStrategy = this.buildToolStrategy(classifications, complexity, reasoning);
    const verificationPlanner = this.buildVerificationPlanner(options);
    const acceptanceCriteria = this.buildAcceptanceCriteria(cleanPrompt, classifications, complexity);

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

    let compiledMarkdownPrompt = '';
    switch (reasoning) {
      case 'low':
      case 'off':
        compiledMarkdownPrompt = this.renderLowTierPrompt(cleanPrompt, options?.testCommand || 'npm test');
        break;
      case 'medium':
        compiledMarkdownPrompt = this.renderMediumTierPrompt(cleanPrompt, constraints, options?.testCommand || 'npm test');
        break;
      case 'high':
        compiledMarkdownPrompt = this.renderHighTierPrompt({
          rawUserPrompt: cleanPrompt,
          reasoningLevel: reasoning,
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
          reasoningStrategy: 'Structured Action Plan: Audit → Implementation → Verification → Summary',
          verificationPlanner,
          failureRecovery,
          antiLoopRules,
          acceptanceCriteria,
          compiledMarkdownPrompt: '',
        });
        break;
      case 'max':
      case 'auto':
      default:
        compiledMarkdownPrompt = this.renderMaxTierPrompt({
          rawUserPrompt: cleanPrompt,
          reasoningLevel: reasoning,
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
        break;
    }

    return {
      rawUserPrompt: cleanPrompt,
      reasoningLevel: reasoning,
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
      reasoningStrategy: reasoning === 'max' ? 'Exhaustive Invariant Decomposition' : 'Targeted Action Execution',
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

  private generatePhasesForTier(
    prompt: string,
    classifications: TaskCategory[],
    complexity: ComplexityLevel,
    tier: CompilerReasoningLevel,
    context?: { testCommand?: string }
  ): PhaseContract[] {
    const testCmd = context?.testCommand || 'npm test';

    if (tier === 'low' || tier === 'off') {
      return [
        {
          phaseIndex: 0,
          name: 'Direct Execution',
          objective: `Execute: "${prompt}" directly with minimal overhead.`,
          inputs: ['Repository'],
          tasks: ['Apply edits', `Verify with \`${testCmd}\``],
          dependencies: [],
          tools: ['read', 'edit', 'write', 'shell'],
          expectedOutput: 'Target edits applied and verified',
          verification: [`${testCmd} passes`],
          exitCriteria: ['Action completed'],
          failureHandling: 'Revert changes on failure',
        },
      ];
    }

    if (tier === 'medium') {
      return [
        {
          phaseIndex: 0,
          name: 'Implementation & AST Validation',
          objective: 'Inspect relevant files and apply targeted edits with in-turn AST syntax verification.',
          inputs: ['Target files'],
          tasks: ['Inspect code context', 'Apply targeted edits and patches', 'Validate syntax in-memory'],
          dependencies: [],
          tools: ['read', 'edit', 'patch', 'write', 'ast_slice'],
          expectedOutput: 'Code modifications applied with zero syntax errors',
          verification: ['AST syntax validation'],
          exitCriteria: ['Edits applied cleanly'],
          failureHandling: 'Fuzzy match auto-healing or rollback',
        },
        {
          phaseIndex: 1,
          name: 'Verification & Summary',
          objective: `Verify changes with \`${testCmd}\` and render structured summary.`,
          inputs: ['Modified repository'],
          tasks: [`Run \`${testCmd}\``, 'Assemble structured summary'],
          dependencies: ['Implementation & AST Validation'],
          tools: ['shell', 'verify'],
          expectedOutput: 'Passing tests and clean summary',
          verification: [`${testCmd} exit 0`],
          exitCriteria: ['0 test regressions'],
          failureHandling: 'Analyze failure log and correct edit',
        },
      ];
    }

    if (tier === 'high') {
      return [
        {
          phaseIndex: 0,
          name: 'Phase 1 — Discovery & Invariant Check',
          objective: 'Inspect affected symbols, interfaces, and call sites without wholesale rewrites.',
          inputs: ['Repository tree'],
          tasks: ['Identify target symbols and dependencies', 'Establish baseline test state'],
          dependencies: [],
          tools: ['read', 'search', 'glob', 'ast_slice', 'blast_radius'],
          expectedOutput: 'Targeted file map and verified call sites',
          verification: ['Symbols mapped'],
          exitCriteria: ['Scope established'],
          failureHandling: 'Refine search terms',
        },
        {
          phaseIndex: 1,
          name: 'Phase 2 — Implementation & AST Guard',
          objective: 'Apply targeted modifications with in-turn AST validation.',
          inputs: ['Target files'],
          tasks: ['Apply edits and patches', 'Run in-turn AST diagnostic check'],
          dependencies: ['Phase 1'],
          tools: ['edit', 'patch', 'write'],
          expectedOutput: 'Syntax-clean code modifications applied',
          verification: ['In-turn AST check passes'],
          exitCriteria: ['0 syntax breaks'],
          failureHandling: 'Auto-heal via AST fuzzy matcher',
        },
        {
          phaseIndex: 2,
          name: 'Phase 3 — Epistemic Verification & Summary',
          objective: `Execute \`${testCmd}\` and produce Cline-grade summary.`,
          inputs: ['Modified workspace'],
          tasks: [`Run \`${testCmd}\``, 'Synthesize unit tests if needed', 'Render structured summary'],
          dependencies: ['Phase 2'],
          tools: ['shell', 'verify'],
          expectedOutput: '100% passing tests and structured metrics card',
          verification: [`\`${testCmd}\` exit 0`],
          exitCriteria: ['0 failing tests, 0 type errors'],
          failureHandling: 'Speculative branch racer fallback',
        },
      ];
    }

    // Default: 'max' (5 exhaustive phase contracts)
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

  private buildToolStrategy(classifications: TaskCategory[], complexity: ComplexityLevel, tier: CompilerReasoningLevel) {
    if (tier === 'low' || tier === 'off') {
      return {
        requiredTools: ['read', 'edit', 'write', 'shell'],
        optionalTools: ['ast_slice'],
        forbiddenTools: ['destructive_reset_hard'],
        callPolicy: 'Execute minimal direct tool invocations.',
      };
    }
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

  private renderLowTierPrompt(prompt: string, testCmd: string): string {
    return [
      `# DIRECT TASK: ${prompt.toUpperCase()}`,
      `> **Reasoning Tier**: \`LOW (FAST MICRO-DISPATCH)\` | **Verify**: \`${testCmd}\``,
      '',
      `## Objective`,
      prompt,
      '',
      `## Execution Rules`,
      `- Apply targeted edits directly using \`edit\` or \`write\`.`,
      `- Validate changes by executing: \`${testCmd}\`.`,
      `- Return concise confirmation upon completion.`,
    ].join('\n');
  }

  private renderMediumTierPrompt(prompt: string, constraints: string[], testCmd: string): string {
    return [
      `# TASK SPECIFICATION: ${prompt.toUpperCase()}`,
      `> **Reasoning Tier**: \`MEDIUM (STREAMLINED INVARIANT CONTRACT)\` | **Verify**: \`${testCmd}\``,
      '',
      `## Objective`,
      prompt,
      '',
      `## Core Invariants`,
      ...constraints.map((c) => `- [x] ${c}`),
      '',
      `## Action Sequence`,
      `1. **Inspect Target Files**: Read affected code and caller sites without wholesale rewrites.`,
      `2. **Apply Targeted Edits**: Use \`edit\` or \`patch\` with in-turn AST validation.`,
      `3. **Verify Execution**: Run \`${testCmd}\` and assert 0 test failures.`,
      `4. **Emit Summary**: Provide structured overview of files modified and verification outcome.`,
    ].join('\n');
  }

  private renderHighTierPrompt(spec: CompiledPromptSpecification): string {
    const lines: string[] = [];

    lines.push(`# MOCHI EXECUTION BLUEPRINT: ${spec.normalizedIntent.primaryGoal.toUpperCase()}`);
    lines.push(`> **Reasoning Tier**: \`HIGH (ACTION MULTI-PHASE)\` | **Category**: \`${spec.classifications.join(', ')}\` | **Verify**: \`${spec.verificationPlanner.primaryCommand || 'npm test'}\``);
    lines.push('');
    lines.push(`## 1. Goal & Acceptance Criteria`);
    lines.push(`- **Goal**: ${spec.normalizedIntent.primaryGoal}`);
    lines.push(`- **Exit Gate**: All tests pass via \`${spec.verificationPlanner.primaryCommand || 'npm test'}\` with 0 regressions.`);
    lines.push('');

    lines.push(`## 2. Invariants & Safe Defaults`);
    for (const c of spec.constraints) {
      lines.push(`- [x] ${c}`);
    }
    lines.push('');

    lines.push(`## 3. Multi-Phase Plan`);
    for (const phase of spec.phases) {
      lines.push(`### ${phase.name}`);
      lines.push(`*${phase.objective}*`);
      for (const t of phase.tasks) lines.push(`- ${t}`);
      lines.push(`**Exit Criteria:** ${phase.exitCriteria.join('; ')}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private renderMaxTierPrompt(spec: CompiledPromptSpecification): string {
    const lines: string[] = [];

    lines.push(`# MOCHI MASTER EXECUTION BLUEPRINT: ${spec.normalizedIntent.primaryGoal.toUpperCase()}`);
    lines.push('');
    lines.push(`> **Reasoning Tier**: \`MAX (DEEP ARCHITECTURAL SPEC)\` | **Classifications**: \`${spec.classifications.join(', ')}\` | **Complexity**: \`${spec.complexity}\` | **Verification**: \`${spec.verificationPlanner.primaryCommand || 'npm test'}\``);
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
