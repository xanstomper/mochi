// MCH-67: SKILL.md quality gate — lint rules for auto-drafted (and authored)
// skills so the skill library stays high-signal. A skill that fails the gate
// is rejected at draft time instead of polluting retrieval.

export interface SkillLintIssue {
  rule: string;
  severity: 'error' | 'warn';
  message: string;
}

export interface SkillLintResult {
  ok: boolean; // no errors (warnings alone don't block)
  issues: SkillLintIssue[];
}

const MIN_BODY_CHARS = 120;
const MIN_PROCEDURE_STEPS = 1;
const MAX_BODY_CHARS = 40_000;

/**
 * Lint a SKILL.md document (frontmatter parsed separately by callers).
 * @param name skill slug
 * @param description skill description from frontmatter
 * @param body markdown body (without frontmatter)
 */
export function lintSkillDoc(name: string, description: string, body: string): SkillLintResult {
  const issues: SkillLintIssue[] = [];

  // R1: name must be a sane slug.
  if (!/^[a-z0-9][a-z0-9-_]{2,63}$/.test(name)) {
    issues.push({ rule: 'slug-format', severity: 'error', message: `name "${name}" is not a valid slug (lowercase, 3-64 chars, [a-z0-9-_])` });
  }

  // R2: description must exist and be substantive.
  const desc = (description ?? '').trim();
  if (desc.length < 20) {
    issues.push({ rule: 'description-min', severity: 'error', message: `description too short (${desc.length} chars, need >= 20) — it drives skill retrieval` });
  }
  if (desc.length > 500) {
    issues.push({ rule: 'description-max', severity: 'warn', message: `description very long (${desc.length} chars) — trim to one sentence` });
  }

  // R3: body must exist and be non-trivial.
  const trimmed = (body ?? '').trim();
  if (trimmed.length < MIN_BODY_CHARS) {
    issues.push({ rule: 'body-min', severity: 'error', message: `body too small (${trimmed.length} chars, need >= ${MIN_BODY_CHARS}) — a skill with no procedure is noise` });
  }
  if (trimmed.length > MAX_BODY_CHARS) {
    issues.push({ rule: 'body-max', severity: 'warn', message: `body very large (${trimmed.length} chars) — split or trim` });
  }

  // R4: must contain at least one numbered/checkbox procedure step. Numbered
  // ATX headings (`## 1. Detect`) count: that is the house style of the whole
  // bundled library, and a numbered heading IS a procedure step marker.
  const stepCount = (trimmed.match(/^\s*(?:\d+[.)]|#{1,6}\s+\d+[.)]|[-*]\s\[[ x]\])/gm) ?? []).length;
  if (stepCount < MIN_PROCEDURE_STEPS) {
    issues.push({ rule: 'has-steps', severity: 'error', message: 'no numbered steps or checkboxes found — skills must be actionable procedures' });
  }

  // R5: no placeholder markers. Quoted spans are excluded: a skill that
  // *prohibits* placeholders ('no "TODO: implement" stubs') names the marker
  // in prose — real leftovers are bare code comments, never quoted. This keeps
  // the implementation skill (which bans TODOs by name) passing without
  // letting an actual `// TODO: finish` through.
  const unquoted = trimmed.replace(/(["'`])[^"'`\n]*\1/g, '');
  if (/\bTODO\b|\bTBD\b|\bFIXME\b|<placeholder>|\bXXX\b/.test(unquoted)) {
    issues.push({ rule: 'no-placeholders', severity: 'error', message: 'placeholder marker (TODO/TBD/FIXME/XXX) in body — unfinished skills must not ship' });
  }

  // R6: avoid prompt-injection-looking lines.
  if (/^\s*ignore (all )?(previous|prior) instructions/im.test(trimmed)) {
    issues.push({ rule: 'no-injection', severity: 'error', message: 'body contains instruction-override language — possible prompt injection' });
  }

  // R7: excessive length of a single line (likely pasted log dump).
  const longestLine = trimmed.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
  if (longestLine > 2000) {
    issues.push({ rule: 'line-length', severity: 'warn', message: `single line of ${longestLine} chars — likely pasted log output, extract to a reference file` });
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

export interface InjectionScanHit {
  rule: string;
  message: string;
}

/**
 * Prompt-injection scanner for UNTRUSTED project-supplied text that is
 * about to enter the prompt (project rule files: MOCHI.md / AGENTS.md /
 * modular .mochi/rules — see context.ts). Extracted from R6 above and
 * generalized: R6 caught one phrasing of instruction-override in skills;
 * this catches the strong-signal family (instruction override, system
 * prompt exfiltration, fake system-turn markers, jailbreak mode claims).
 * Patterns are deliberately tight — ordinary project rules ("follow the
 * style guide", "never commit secrets", "you are working on X") must NOT
 * trip it, because a hit replaces the whole file's content with an
 * omission note at the call site. Returns the first hit, or null if clean.
 */
const INJECTION_PATTERNS: Array<{ rule: string; re: RegExp; message: string }> = [
  {
    rule: 'instruction-override',
    re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,60}\b(previous|prior|above|system|original|earlier|your)\b[^.\n]{0,30}\b(instructions?|directives?|prompts?|rules?|guidelines?)\b/i,
    message: 'instruction-override language (ignore/disregard prior or system instructions)',
  },
  {
    rule: 'instruction-override',
    re: /^\s*ignore\s+(all\s+)?(previous|prior)\s+instructions/im,
    message: 'instruction-override language (ignore previous instructions)',
  },
  {
    rule: 'refuse-instructions',
    re: /\bdo\s+not\s+(follow|obey|comply\s+with)\b[^.\n]{0,40}\b(system|original|previous|prior|your)\b[^.\n]{0,20}\b(instructions?|directives?|rules?)\b/i,
    message: 'directive to disobey system/original instructions',
  },
  {
    rule: 'system-prompt-exfiltration',
    re: /\b(reveal|print|output|show|repeat|leak|disclose|dump)\b[^.\n]{0,60}\b(system\s+prompt|your\s+(system\s+)?instructions|initial\s+instructions|hidden\s+instructions)\b/i,
    message: 'attempt to extract the system prompt / hidden instructions',
  },
  {
    rule: 'fake-system-turn',
    re: /^\s*\[(system|assistant)\]\s*:/im,
    message: 'fake [system]/[assistant] turn marker',
  },
  {
    rule: 'new-instructions-marker',
    re: /\bBEGIN\s+(NEW\s+)?(SYSTEM\s+)?INSTRUCTIONS?\b/i,
    message: '"BEGIN NEW INSTRUCTIONS" marker',
  },
  {
    rule: 'jailbreak-mode',
    re: /\b(jailbreak|unrestricted\s+mode|dan\s+mode|developer\s+mode\s+enabled|no\s+restrictions\s+mode)\b/i,
    message: 'jailbreak / unrestricted-mode claim',
  },
];

export function scanPromptInjection(text: string): InjectionScanHit | null {
  if (!text) return null;
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(text)) return { rule: p.rule, message: p.message };
  }
  return null;
}

/** Render issues into a human-readable lint report. */
export function formatSkillLint(result: SkillLintResult): string {
  if (!result.issues.length) return 'skill lint: clean';
  return result.issues.map((i) => `[${i.severity}] ${i.rule}: ${i.message}`).join('\n');
}
