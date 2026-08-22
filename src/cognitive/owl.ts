/**
 * OWL — Operational Wisdom Layer (Cognitive Framework 2.0)
 * 
 * Pre-implementation reasoning protocol applying 9 engineering principles silently
 * by default, surfacing only when a finding would change what the user does or expects.
 */

export interface OwlSignal {
  principle: 'epistemics' | 'reality' | 'verification' | 'locality' | 'conservation' | 'simplicity' | 'invariants' | 'reversibility' | 'clarity';
  finding: string;
  implication: string;
  weight: number; // 0.1 - 1.0
  surface: boolean;
}

export interface OwlEvaluationResult {
  mode: 'silent' | 'surface';
  cumulativeWeight: number;
  signals: OwlSignal[];
  formattedFindings: string[];
  reasoningPass: string;
}

export const OWL_PRINCIPLES = [
  {
    name: 'epistemics',
    rule: "Don't assume. Expose uncertainty. Distinguish verified facts from inferences.",
    baseWeight: 0.4,
  },
  {
    name: 'reality',
    rule: 'Read code before acting. Verify actual types, dependencies, and AST reality.',
    baseWeight: 0.5,
  },
  {
    name: 'verification',
    rule: "Define what 'done' looks like. Never simulate verification or guess outcomes.",
    baseWeight: 0.4,
  },
  {
    name: 'locality',
    rule: 'Smallest possible change. Touch only what the task strictly requires.',
    baseWeight: 0.3,
  },
  {
    name: 'conservation',
    rule: 'Preserve existing intent. A refactor that breaks behavior is a modification.',
    baseWeight: 0.3,
  },
  {
    name: 'simplicity',
    rule: 'Minimal solution. Prefer native language primitives over new abstractions.',
    baseWeight: 0.2,
  },
  {
    name: 'invariants',
    rule: 'Protect system invariants, data safety, atomicity, and idempotency.',
    baseWeight: 0.4,
  },
  {
    name: 'reversibility',
    rule: 'Ensure changes can be cleanly rolled back or safely isolated.',
    baseWeight: 0.2,
  },
  {
    name: 'clarity',
    rule: 'Make the rationale and contract explicit without conversational fluff.',
    baseWeight: 0.1,
  },
] as const;

/**
 * Evaluates a task through the OWL 9-principle filter in-process.
 */
export function evaluateOwl(task: string, knownContext = ''): OwlEvaluationResult {
  const signals: OwlSignal[] = [];
  const taskLower = task.toLowerCase();

  // 1. Reality Trigger: Check if code inspection is required before editing
  if (/\b(fix|modify|update|refactor|delete|replace|rename)\b/.test(taskLower) && !knownContext.includes('file:')) {
    signals.push({
      principle: 'reality',
      finding: 'Task requests modification without prior file inspection.',
      implication: 'Must read target source files before modifying them to avoid hallucinating APIs.',
      weight: 0.6,
      surface: true,
    });
  }

  // 2. Epistemics Trigger: Check for ambiguous requirements
  if (/\b(maybe|something like|fastest possible|best way|or whatever)\b/.test(taskLower)) {
    signals.push({
      principle: 'epistemics',
      finding: 'Task contains ambiguous or open-ended success criteria.',
      implication: 'Will formulate a concrete testable hypothesis and confirm invariants.',
      weight: 0.5,
      surface: true,
    });
  }

  // 3. Verification Trigger: Check for missing verification criteria
  if (!/\b(test|verify|check|assert|validate|bench|reproduce)\b/.test(taskLower)) {
    signals.push({
      principle: 'verification',
      finding: 'No explicit verification command specified in task request.',
      implication: 'Will execute automated suite / typecheck to verify changes independently.',
      weight: 0.4,
      surface: false,
    });
  }

  // 4. Locality & Conservation: Scope guard
  if (/\b(all files|everywhere|rewrite whole|overhaul)\b/.test(taskLower)) {
    signals.push({
      principle: 'locality',
      finding: 'Broad scope requested.',
      implication: 'Enforcing strict surgical boundary to prevent accidental regressions.',
      weight: 0.5,
      surface: true,
    });
  }

  // 5. Invariants & Security: High-risk mutation guard
  if (/\b(auth|token|jwt|credential|password|secret|key|crypto|permission)\b/.test(taskLower)) {
    signals.push({
      principle: 'invariants',
      finding: 'Authentication / security sensitive boundary detected.',
      implication: 'Never leak credentials, use constant-time comparisons, and verify authorization checks.',
      weight: 0.6,
      surface: true,
    });
  }

  // 6. Concurrency / State Safety Guard
  if (/\b(concurrency|race condition|deadlock|mutex|lock|atomic|async queue|worker)\b/.test(taskLower)) {
    signals.push({
      principle: 'invariants',
      finding: 'Concurrent state mutation detected.',
      implication: 'Enforce atomic updates, strict lock hierarchies, and comprehensive race condition tests.',
      weight: 0.5,
      surface: true,
    });
  }

  // 7. Destructive Operation / Reversibility Guard
  if (/\b(delete|drop|purge|truncate|rm|destroy|reset)\b/.test(taskLower)) {
    signals.push({
      principle: 'reversibility',
      finding: 'Destructive data/code operation detected.',
      implication: 'Require pre-mutation backup or transactional boundary before applying change.',
      weight: 0.7,
      surface: true,
    });
  }

  const cumulativeWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const mode = cumulativeWeight >= 1.0 ? 'surface' : 'silent';
  const formattedFindings = signals
    .filter((s) => s.surface)
    .map((s) => `[OWL ${s.principle.toUpperCase()}]: ${s.finding} -> ${s.implication}`);

  const reasoningPass = [
    `# OWL Pre-Implementation Assessment (${mode.toUpperCase()})`,
    `Principles active: ${OWL_PRINCIPLES.map((p) => p.name).join(', ')}`,
    ...formattedFindings,
  ].join('\n');

  return {
    mode,
    cumulativeWeight,
    signals,
    formattedFindings,
    reasoningPass,
  };
}
