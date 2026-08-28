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
    const testCmd = spec.verificationPlanner.primaryCommand || 'npm test';

    // Output Contract §32 — HEADER
    lines.push('# TASK');
    lines.push('');
    lines.push('## OBJECTIVE');
    lines.push(spec.normalizedIntent.primaryGoal);
    lines.push('');
    lines.push('## CONTEXT');
    lines.push('- **Reasoning Tier**: MAX (Exhaustive Architectural Decomposition)');
    lines.push(`- **Task Categories**: ${spec.classifications.join(', ')}`);
    lines.push(`- **Complexity**: ${spec.complexity}`);
    lines.push(`- **Target Platform**: ${spec.normalizedIntent.targetPlatform}`);
    lines.push(`- **Verification Command**: \`${testCmd}\``);
    lines.push(`- **Desired Outcome**: ${spec.normalizedIntent.desiredOutcome}`);
    lines.push('');

    // §3 / §7 — USER REQUIREMENTS
    lines.push('## USER REQUIREMENTS');
    for (const r of spec.explicitRequirements) lines.push(`- ${r}`);
    lines.push('');

    // §8 — INFERRED REQUIREMENTS
    lines.push('## INFERRED REQUIREMENTS');
    lines.push('> Strongly implied by the task type. Treat as mandatory unless the user explicitly overrides.');
    lines.push('');
    for (const r of spec.inferredRequirements) {
      const tag = r.isMandatory ? '**[MANDATORY]**' : '*[PREFERRED]*';
      lines.push(`- ${tag} ${r.requirement}`);
      lines.push(`  - *Rationale: ${r.rationale}*`);
    }
    lines.push('');

    // §9 — ASSUMPTIONS ENGINE (table format: id / assumption / confidence / impact / reason)
    lines.push('## ASSUMPTIONS');
    lines.push('> Transparently declared. LOW-confidence assumptions that materially change implementation will be flagged before proceeding.');
    lines.push('');
    lines.push('| ID | Assumption | Confidence | Impact | Reason |');
    lines.push('| :-- | :-- | :-- | :-- | :-- |');
    for (const a of spec.assumptions) {
      lines.push(`| ${a.id} | ${a.assumption} | ${a.confidence} | ${a.impact} | ${a.reason} |`);
    }
    lines.push('');

    // §11 — CONSTRAINTS
    lines.push('## CONSTRAINTS');
    lines.push('> Explicit constraints outrank all inferred preferences. Violations are **P0 blockers**.');
    lines.push('');
    for (const c of spec.constraints) lines.push(`- [x] **${c}**`);
    lines.push('');

    // §12 — PRIORITY SYSTEM (P0-P4)
    lines.push('## PRIORITIES');
    lines.push('');
    lines.push('| Priority | Description |');
    lines.push('| :-- | :-- |');
    for (const p of spec.priorities) lines.push(`| **${p.priority}** | ${p.description} |`);
    lines.push('');
    lines.push('> **P0 = MUST NOT FAIL** | P1 = REQUIRED | P2 = IMPORTANT | P3 = PREFERRED | P4 = OPTIONAL');
    lines.push('');

    // SUCCESS CRITERIA
    lines.push('## SUCCESS CRITERIA');
    for (const s of spec.normalizedIntent.successConditions) lines.push(`- ${s}`);
    lines.push('');

    // §36 / §37 — EXISTING-CODE PRESERVATION + INCREMENTAL IMPLEMENTATION
    lines.push('## ARCHITECTURE / APPROACH');
    lines.push('');
    lines.push('### Existing-Code Preservation Rules §36');
    lines.push('- **DO NOT** rewrite working systems unnecessarily.');
    lines.push('- **DO NOT** introduce a new framework without explicit justification.');
    lines.push('- **DO NOT** duplicate existing infrastructure or utilities.');
    lines.push('- **DO NOT** delete functionality without understanding all dependencies first.');
    lines.push('- **DO NOT** replace working architecture merely because another approach is fashionable.');
    lines.push('- **DO** inspect what already exists before writing a single line of new code.');
    lines.push('');
    lines.push('### Incremental Implementation Pattern §37');
    lines.push('```');
    lines.push('INSPECT  ->  PLAN  ->  IMPLEMENT SMALL INCREMENT  ->  BUILD  ->  TEST  ->  CONTINUE');
    lines.push('```');
    lines.push('Never make enormous unverified changes in a single step.');
    lines.push('');

    // §16 / §17 — MULTI-PHASE EXECUTION — full per-phase contract
    for (const phase of spec.phases) {
      lines.push(`## ${phase.name}`);
      lines.push('');
      lines.push(`**OBJECTIVE**: ${phase.objective}`);
      lines.push('');
      if (phase.inputs.length) {
        lines.push(`**INPUTS**: ${phase.inputs.join(', ')}`);
        lines.push('');
      }
      lines.push('**TASKS**:');
      for (const t of phase.tasks) lines.push(`1. ${t}`);
      lines.push('');
      lines.push(`**TOOLS**: \`${phase.tools.join('\`, \`')}\``);
      lines.push('');
      lines.push(`**EXPECTED OUTPUT**: ${phase.expectedOutput}`);
      lines.push('');
      lines.push('**VERIFICATION**:');
      for (const v of phase.verification) lines.push(`- ${v}`);
      lines.push('');
      lines.push('**EXIT CRITERIA**:');
      for (const e of phase.exitCriteria) lines.push(`- ${e}`);
      lines.push('');
      lines.push(`**FAILURE HANDLING**: ${phase.failureHandling}`);
      lines.push('');
    }

    // §19–20 — TOOL STRATEGY + TOOL CALL POLICY
    lines.push('## TOOL STRATEGY');
    lines.push('');
    lines.push(`**Required Tools**: \`${spec.toolStrategy.requiredTools.join('\`, \`')}\``);
    lines.push(`**Optional Tools**: \`${spec.toolStrategy.optionalTools.join('\`, \`')}\``);
    lines.push(`**Forbidden Tools**: \`${spec.toolStrategy.forbiddenTools.join('\`, \`')}\``);
    lines.push('');
    lines.push('### Tool Call Policy §20');
    lines.push('Before calling any tool, determine:');
    lines.push('1. **WHY** — What decision does this tool call enable?');
    lines.push('2. **WHAT** — What specific information is needed?');
    lines.push('3. **EXPECTED OUTPUT** — What will a successful result look like?');
    lines.push('4. **NEXT ACTION** — How will the result change the execution plan?');
    lines.push('');
    lines.push(`> **${spec.toolStrategy.callPolicy}**`);
    lines.push('');

    // §21 — REASONING STRATEGY: PROBLEM -> OBSERVATIONS -> OPTIONS -> TRADEOFFS -> DECISION -> RATIONALE -> CONFIDENCE -> NEXT ACTION
    lines.push('## REASONING STRATEGY §21');
    lines.push('');
    lines.push('For every major decision, apply this structured reasoning framework internally:');
    lines.push('```');
    lines.push('PROBLEM       -- What is the specific challenge?');
    lines.push('OBSERVATIONS  -- What evidence is available from the codebase / environment?');
    lines.push('OPTIONS       -- What are the realistic implementation paths?');
    lines.push('TRADEOFFS     -- What are the costs and benefits of each option?');
    lines.push('DECISION      -- Which option is selected?');
    lines.push('RATIONALE     -- Why is this the best choice given the constraints?');
    lines.push('CONFIDENCE    -- HIGH / MEDIUM / LOW');
    lines.push('NEXT ACTION   -- What tool call or code edit follows immediately?');
    lines.push('```');
    lines.push('');
    lines.push('> Do not expose private chain-of-thought. Provide concise decision summaries only when useful to the user.');
    lines.push('');

    // §22 — EVIDENCE-DRIVEN EXECUTION: CLAIM -> EVIDENCE -> VERIFICATION -> STATUS
    lines.push('## VERIFICATION STRATEGY §22');
    lines.push('');
    lines.push('**Never claim something works without evidence.** Apply this contract for every assertion:');
    lines.push('```');
    lines.push('CLAIM         -- What is being asserted?');
    lines.push('EVIDENCE      -- What concrete output (exit code, test output, build log) proves it?');
    lines.push('VERIFICATION  -- What was the specific command / check run?');
    lines.push('STATUS        -- VERIFIED | PARTIALLY VERIFIED | UNVERIFIED | FAILED');
    lines.push('```');
    lines.push('');
    lines.push(`**Active Strategies**: ${spec.verificationPlanner.strategies.join(', ')}`);
    lines.push(`**Primary Command**: \`${testCmd}\``);
    lines.push('');

    // §25 — FAILURE RECOVERY
    lines.push('## FAILURE RECOVERY §25');
    lines.push('');
    for (const r of spec.failureRecovery) lines.push(`- ${r}`);
    lines.push('');

    // §26 — ANTI-LOOP POLICY
    lines.push('## ANTI-LOOP RULES §26');
    lines.push('');
    lines.push('If the same operation fails twice:');
    lines.push('```');
    lines.push('STOP  →  ANALYZE ROOT CAUSE  →  CHANGE STRATEGY');
    lines.push('```');
    lines.push('Do not blindly repeat failing operations. Bounded retries only (max 2).');
    lines.push('');
    for (const rule of spec.antiLoopRules) lines.push(`- [x] ${rule}`);
    lines.push('');

    // §27–28 — CONTEXT MANAGEMENT + MEMORY MODEL
    lines.push('## CONTEXT MANAGEMENT §27–28');
    lines.push('');
    lines.push('**Prioritize in context window:**');
    lines.push('- User requirements and explicit constraints');
    lines.push('- Active decisions and their rationale');
    lines.push('- Current state of modified files and error messages');
    lines.push('- Unresolved issues and verification results');
    lines.push('');
    lines.push('**Deprioritize / drop when context is full:**');
    lines.push('- Repetitive tool output logs');
    lines.push('- Duplicate shell command output');
    lines.push('- Stale intermediate reasoning');
    lines.push('- Irrelevant conversation history');
    lines.push('');

    // §38 — COMPLETION DEFINITION
    lines.push('## QUALITY REQUIREMENTS §38');
    lines.push('');
    lines.push('> **"Done" means the acceptance criteria are satisfied -- not that code was written, files changed, or the model said it was done.**');
    lines.push('');
    lines.push('Track each deliverable as exactly one of:');
    lines.push('```');
    lines.push('IMPLEMENTED  |  VERIFIED  |  PARTIALLY VERIFIED  |  UNVERIFIED  |  FAILED  |  BLOCKED');
    lines.push('```');
    lines.push('');

    // §24 — ACCEPTANCE CRITERIA (functional / quality / performance / security)
    lines.push('## ACCEPTANCE CRITERIA §24');
    lines.push('');
    lines.push('### Functional');
    for (const f of spec.acceptanceCriteria.functional) lines.push(`- [ ] ${f}`);
    lines.push('');
    lines.push('### Quality');
    for (const q of spec.acceptanceCriteria.quality) lines.push(`- [ ] ${q}`);
    if (spec.acceptanceCriteria.performance?.length) {
      lines.push('');
      lines.push('### Performance');
      for (const p of spec.acceptanceCriteria.performance) lines.push(`- [ ] ${p}`);
    }
    if (spec.acceptanceCriteria.security?.length) {
      lines.push('');
      lines.push('### Security');
      for (const s of spec.acceptanceCriteria.security) lines.push(`- [ ] ${s}`);
    }
    lines.push('');

    // §39 — FINAL OUTPUT FORMAT (Cline-grade structured summary)
    lines.push('## FINAL OUTPUT FORMAT §39');
    lines.push('');
    lines.push('At task completion, produce a structured summary in this exact format. Never produce a wall of prose.');
    lines.push('');
    lines.push('```');
    lines.push('SUMMARY');
    lines.push('');
    lines.push('STATUS');
    lines.push('OK Complete  /  FAIL Failed  /  PARTIAL Partial');
    lines.push('');
    lines.push('WHAT CHANGED');
    lines.push('<bullet list of every file modified, added, or deleted with a one-line description each>');
    lines.push('');
    lines.push('FILES');
    lines.push('<table: path | op (MODIFIED / ADDED / DELETED) | description>');
    lines.push('');
    lines.push('TESTS');
    lines.push('<pass/fail counts and the exact command run>');
    lines.push('');
    lines.push('VERIFICATION');
    lines.push('<evidence: command + exit code + key assertion results>');
    lines.push('');
    lines.push('IMPORTANT');
    lines.push('<assumptions that became decisions, warnings, or known limitations>');
    lines.push('');
    lines.push('UNRESOLVED');
    lines.push('<anything blocked, deferred, or not yet verified>');
    lines.push('');
    lines.push('NEXT');
    lines.push('<recommended next actions, if any>');
    lines.push('```');
    lines.push('');
    lines.push('> Use tables/grids when they improve comprehension. Use code blocks for code.');
    lines.push('> **Do not fabricate any metric, test count, or file change that did not actually happen.**');

    return lines.join('\n');
  }
}

export const promptCompiler = new MochiPromptCompiler();
