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

  // R4: must contain at least one numbered/checkbox procedure step.
  const stepCount = (trimmed.match(/^\s*(?:\d+[.)]|[-*]\s\[[ x]\])/gm) ?? []).length;
  if (stepCount < MIN_PROCEDURE_STEPS) {
    issues.push({ rule: 'has-steps', severity: 'error', message: 'no numbered steps or checkboxes found — skills must be actionable procedures' });
  }

  // R5: no placeholder markers.
  if (/\bTODO\b|\bTBD\b|\bFIXME\b|<placeholder>|\bXXX\b/.test(trimmed)) {
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

/** Render issues into a human-readable lint report. */
export function formatSkillLint(result: SkillLintResult): string {
  if (!result.issues.length) return 'skill lint: clean';
  return result.issues.map((i) => `[${i.severity}] ${i.rule}: ${i.message}`).join('\n');
}
