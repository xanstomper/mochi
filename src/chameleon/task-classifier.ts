/**
 * Lazy Chameleon Task Classifier
 * 
 * Analyzes task prompt to classify domain, calculate difficulty (1-10),
 * and recommend the optimal Chameleon compute mode & stalling strategy.
 */

export type TaskDomain =
  | 'systems_programming'
  | 'algorithms_math'
  | 'security_audit'
  | 'architecture_design'
  | 'debugging_fixing'
  | 'refactoring'
  | 'frontend_ui'
  | 'database_infra'
  | 'documentation'
  | 'general';

export interface TaskClassification {
  domain: TaskDomain;
  difficulty: number; // 1-10
  recommendedMode: 'flash' | 'turbo' | 'easy' | 'medium' | 'hard' | 'deep' | 'extreme' | 'genius';
  recommendedStrategy: 'chain_of_draft' | 'budget_force' | 'constitutional' | 'devils_advocate' | 'self_consistency' | 'confidence_gate' | 'hybrid';
  rationale: string;
  detectedKeywords: string[];
}

export function classifyTask(task: string): TaskClassification {
  const text = task.toLowerCase();
  const keywords: string[] = [];

  let domain: TaskDomain = 'general';
  let difficulty = 3;

  // Domain detection
  if (/\b(rust|c\+\+|kernel|memory|concurrency|thread|async|mutex|simd|assembly|driver)\b/.test(text)) {
    domain = 'systems_programming';
    difficulty += 3;
    keywords.push('systems');
  } else if (/\b(algorithm|graph|tree|dynamic programming|dp|math|matrix|proof|crypto|optimize)\b/.test(text)) {
    domain = 'algorithms_math';
    difficulty += 3;
    keywords.push('algorithms');
  } else if (/\b(security|vulnerability|exploit|sanitize|injection|xss|csrf|auth|crypto|jwt)\b/.test(text)) {
    domain = 'security_audit';
    difficulty += 3;
    keywords.push('security');
  } else if (/\b(architect|system design|distributed|microservice|event-driven|scale|cluster|raft)\b/.test(text)) {
    domain = 'architecture_design';
    difficulty += 4;
    keywords.push('architecture');
  } else if (/\b(bug|fix|error|crash|panic|segfault|race condition|deadlock|leak)\b/.test(text)) {
    domain = 'debugging_fixing';
    difficulty += 2;
    keywords.push('debugging');
  } else if (/\b(refactor|cleanup|migrate|rewrite|restructure|decouple|rename)\b/.test(text)) {
    domain = 'refactoring';
    difficulty += 2;
    keywords.push('refactor');
  } else if (/\b(css|html|ui|tui|react|svelte|component|layout|color|theme)\b/.test(text)) {
    domain = 'frontend_ui';
    difficulty += 1;
    keywords.push('ui');
  } else if (/\b(sql|database|query|postgres|sqlite|redis|schema|index|migration)\b/.test(text)) {
    domain = 'database_infra';
    difficulty += 2;
    keywords.push('database');
  }

  // Modifiers
  if (/\b(extreme|critical|production|massive|hardest|complex|distributed)\b/.test(text)) {
    difficulty += 2;
    keywords.push('high-stakes');
  }
  if (/\b(quick|simple|typo|rename variable|small|tldr)\b/.test(text)) {
    difficulty = Math.max(1, difficulty - 3);
    keywords.push('low-complexity');
  }

  difficulty = Math.max(1, Math.min(10, difficulty));

  // Determine mode & strategy
  let recommendedMode: TaskClassification['recommendedMode'] = 'medium';
  let recommendedStrategy: TaskClassification['recommendedStrategy'] = 'hybrid';

  if (difficulty <= 2) {
    recommendedMode = 'flash';
    recommendedStrategy = 'chain_of_draft';
  } else if (difficulty <= 4) {
    recommendedMode = 'easy';
    recommendedStrategy = 'chain_of_draft';
  } else if (difficulty <= 6) {
    recommendedMode = 'medium';
    recommendedStrategy = domain === 'security_audit' ? 'devils_advocate' : 'hybrid';
  } else if (difficulty <= 8) {
    recommendedMode = 'hard';
    recommendedStrategy = domain === 'architecture_design' ? 'self_consistency' : 'constitutional';
  } else {
    recommendedMode = 'deep';
    recommendedStrategy = 'budget_force';
  }

  return {
    domain,
    difficulty,
    recommendedMode,
    recommendedStrategy,
    rationale: `Classified as ${domain} with difficulty ${difficulty}/10 due to keywords: ${keywords.join(', ')}.`,
    detectedKeywords: keywords,
  };
}
