// Intelligent Prompt Expander & Meta-Prompt Compiler for Mochi
// Transforms concise user requests into structured, multi-phase agent execution blueprints
// with explicit invariants, verification gates, and Cline-grade output standards.

export interface ExpandedPromptPlan {
  originalPrompt: string;
  intentCategory: 'feature' | 'bugfix' | 'refactor' | 'performance' | 'security' | 'harness' | 'general';
  title: string;
  phases: {
    phaseIndex: number;
    name: string;
    description: string;
    objectives: string[];
    verificationCriteria: string[];
  }[];
  constraints: string[];
  compiledPrompt: string;
}

export function classifyIntent(prompt: string): ExpandedPromptPlan['intentCategory'] {
  const p = prompt.toLowerCase();
  if (p.includes('harness') || p.includes('agent') || p.includes('rebuild') || p.includes('prompting') || p.includes('loop')) {
    return 'harness';
  }
  if (p.includes('fix') || p.includes('bug') || p.includes('error') || p.includes('fail') || p.includes('crash') || p.includes('broken')) {
    return 'bugfix';
  }
  if (p.includes('perf') || p.includes('speed') || p.includes('fast') || p.includes('latency') || p.includes('memory') || p.includes('cpu') || p.includes('optimize') || p.includes('slow')) {
    return 'performance';
  }
  if (p.includes('security') || p.includes('audit') || p.includes('auth') || p.includes('vulnerab') || p.includes('permission') || p.includes('sanitize')) {
    return 'security';
  }
  if (p.includes('refactor') || p.includes('clean') || p.includes('restruct') || p.includes('rewrite') || p.includes('simplify')) {
    return 'refactor';
  }
  if (p.includes('add') || p.includes('create') || p.includes('build') || p.includes('implement') || p.includes('feature')) {
    return 'feature';
  }
  return 'general';
}

export function expandUserPrompt(rawPrompt: string, repoContext?: { name?: string; testCmd?: string; lang?: string }): ExpandedPromptPlan {
  const cleanPrompt = rawPrompt.trim();
  const intent = classifyIntent(cleanPrompt);

  const title = cleanPrompt.length > 50 ? `${cleanPrompt.slice(0, 47)}...` : cleanPrompt;
  const testCmd = repoContext?.testCmd || 'npm test';

  const phases: ExpandedPromptPlan['phases'] = [
    {
      phaseIndex: 0,
      name: 'Phase 0 — Full Codebase & Architecture Audit',
      description: 'Deeply inspect the existing repository architecture before making any edits.',
      objectives: [
        'Inspect relevant modules, types, and dependencies without blind rewrites',
        'Identify data flows, call sites, and potential blast radius for modifications',
        'Preserve all existing non-broken abstractions, comments, and public APIs',
      ],
      verificationCriteria: [
        'All affected symbols, file paths, and contracts are mapped before writing code',
      ],
    },
    {
      phaseIndex: 1,
      name: 'Phase 1 — Invariant Definition & Execution Plan',
      description: 'Establish explicit acceptance criteria and deterministic sub-task execution order.',
      objectives: [
        'Break down the objective into discrete, verifiable sub-tasks',
        'Ensure tool calls and mutations are idempotent and guarded against duplicate execution',
        'Set up failure recovery paths and cancellation safety',
      ],
      verificationCriteria: [
        'Execution plan is unambiguous with clear success/failure states',
      ],
    },
    {
      phaseIndex: 2,
      name: 'Phase 2 — Targeted Implementation & In-Turn AST Validation',
      description: 'Implement modifications with zero dead-code injection and instant AST syntax validation.',
      objectives: [
        'Apply small, targeted edits and patches rather than destructive overwrites',
        'Run in-turn AST diagnostic guards on all modified files to prevent syntax breaks',
        'Maintain single execution authority across all tool calls',
      ],
      verificationCriteria: [
        'All modified files pass syntax parsing and bracket/indentation validation',
      ],
    },
    {
      phaseIndex: 3,
      name: 'Phase 3 — Multi-Layer Verification & Epistemic Testing',
      description: 'Execute automated verification test suites and ensure zero regressions.',
      objectives: [
        `Execute automated test runner (\`${testCmd}\`) and typecheck`,
        'Verify test density and synthesize unit test coverage for newly created logic',
        'Ensure all edge cases and failure modes are explicitly asserted',
      ],
      verificationCriteria: [
        `Verification command \`${testCmd}\` exits with code 0 and 0 failing tests`,
      ],
    },
    {
      phaseIndex: 4,
      name: 'Phase 4 — Cline-Grade Structured Summary & Closeout',
      description: 'Render a high-density, beautifully formatted summary with metrics, diffs, and evidence.',
      objectives: [
        'Assemble a structured summary document from real execution events (never fabricate)',
        'Display box/grid metrics (Files changed, Tests passed, Tools invoked, Duration)',
        'Include semantic color-coding and clear file references with modification status',
      ],
      verificationCriteria: [
        'Summary is hierarchical, scannable, and avoids raw unformatted text walls',
      ],
    },
  ];

  const constraints = [
    'Strictly preserve working code — never perform blind wholesale file rewrites',
    'Every tool call must pass through the execution authority with idempotency checks',
    'All verification numbers and file counts in summaries must come from real structured events',
    'Render rich Markdown with actual tables, grid boxes, and semantic color codes',
  ];

  let compiled = `# MOCHI MASTER EXECUTION BLUEPRINT: ${title.toUpperCase()}\n\n`;
  compiled += `> **Task Intent**: \`${intent.toUpperCase()}\` | **Execution Authority**: \`ENFORCED\` | **Verification**: \`${testCmd}\`\n\n`;
  compiled += `## User Directive\n${cleanPrompt}\n\n`;
  compiled += `## Execution Invariants & Constraints\n`;
  for (const c of constraints) {
    compiled += `- [x] ${c}\n`;
  }
  compiled += `\n## Multi-Phase Execution Plan\n\n`;

  for (const p of phases) {
    compiled += `### ${p.name}\n`;
    compiled += `*${p.description}*\n`;
    compiled += `**Objectives:**\n`;
    for (const obj of p.objectives) {
      compiled += `- ${obj}\n`;
    }
    compiled += `**Verification Criteria:**\n`;
    for (const crit of p.verificationCriteria) {
      compiled += `✓ ${crit}\n`;
    }
    compiled += `\n`;
  }

  return {
    originalPrompt: cleanPrompt,
    intentCategory: intent,
    title,
    phases,
    constraints,
    compiledPrompt: compiled,
  };
}
