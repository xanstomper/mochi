// AAIF Agent Skills conformance — the spec-level validation layer for SKILL.md
// documents (Agent Skills spec, stewarded by the Agentic AI Foundation / Linux
// Foundation; Anthropic donated the spec, name, and agentskills.io on
// 2026-10-22).
//
// This is NOT a second validator: it composes the existing machinery — the
// canonical frontmatter parser (frontmatter.ts) and the house lint gate
// (skill-lint.ts: body structure, placeholders, injection language) — and adds
// the spec-normative rules the house gate does not know: required fields, the
// exact name grammar, field length limits, field types, the name↔directory
// match, and unknown-field rejection.
//
// Sources (fetched 2026-10-25, no formal version number is published):
//   - https://agentskills.io/specification          (rendered spec)
//   - https://github.com/agentskills/agentskills    (canonical repo,
//     docs/specification.mdx @ main; skills-ref v0.1.0 reference validator)
// Where the spec is silent (body structure), the house quality bar
// (skill-lint.ts) applies on top — stricter than the spec, never looser.

import { lintSkillDoc, type SkillLintIssue } from './skill-lint.js';
import { parseFrontmatter } from './frontmatter.js';

/** Normative limits from the spec (skills-ref validator.py agrees). */
export const AAIF_LIMITS = {
  MAX_NAME_LENGTH: 64,
  MAX_DESCRIPTION_LENGTH: 1024,
  MAX_COMPATIBILITY_LENGTH: 500,
} as const;

/** Fields the spec defines. */
export const AAIF_SPEC_FIELDS: ReadonlySet<string> = new Set([
  'name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility',
]);

/** Mochi's own frontmatter extensions (documented in docs/AAIF_SKILL_AUTHORING.md).
 *  Spec-unknown but intentional; the loader/consumer for each lives in Mochi. */
export const MOCHI_EXTENSION_FIELDS: ReadonlySet<string> = new Set([
  'tools',                    // legacy pre-`allowed-tools` declared-tools field (loader falls back to it)
  'disable-model-invocation', // advertise-gate flag (skills.ts)
  'category', 'tags',         // organization metadata (curator)
  'updated',                  // staleness stamp (staleSkills)
]);

export interface AaifViolation {
  rule: string;
  severity: 'error' | 'warn';
  message: string;
  /** Display path of the offending document. */
  file: string;
  /** 1-based line in the document, when the rule pins to one. */
  line?: number;
}

export interface AaifResult {
  /** No error-severity violations. */
  ok: boolean;
  violations: AaifViolation[];
}

/** What we validate against — recorded in every report; never invented. */
export const AAIF_SPEC_INFO = {
  spec: 'Agent Skills',
  steward: 'Agentic AI Foundation (AAIF), a Linux Foundation project',
  version: 'no formal version number published (spec is identified by source + revision)',
  sources: [
    'https://agentskills.io/specification',
    'https://github.com/agentskills/agentskills (docs/specification.mdx, main)',
  ],
  /** Canonical repo main @ fetch time (provenance for every validation run). */
  revision: '69ef37e9424c0a7ea9dd2293b559e43ec8176379 (main, pushed 2026-08-09)',
  referenceValidator: 'skills-ref v0.1.0 (skills-ref/src/skills_ref/validator.py)',
  fetchedAt: '2026-10-25',
} as const;

/** Where quarantined imports go, relative to the skills target root. */
export const QUARANTINE_DIRNAME = '.quarantine';

/** Rules the ingestion path treats as BLOCKING (quarantine, never install). */
export const AAIF_BLOCKING_RULES: ReadonlySet<string> = new Set([
  'frontmatter-missing', 'name-required', 'name-format', 'name-length',
  'name-dir-match', 'description-required', 'description-length',
  'compatibility-type', 'compatibility-length', 'metadata-type',
  'allowed-tools-type', 'tools-type', 'license-type', 'unknown-field',
]);

export interface AaifValidateOpts {
  /** Display path for diagnostics (defaults to 'SKILL.md'). */
  file?: string;
  /** Skill directory name when validating `<dir>/SKILL.md` (spec layout). */
  dirName?: string;
  /** File basename (without .md) when validating Mochi's flat `<name>.md` layout. */
  flatFileName?: string;
}

/**
 * Full AAIF conformance check of one raw SKILL.md document: spec frontmatter
 * rules + the house body-structure gate (lintSkillDoc). Pure and synchronous.
 *
 * Every violation carries `rule`, `message`, and `file`, with `line` whenever
 * the rule pins to one — diagnostics are meant to be greppable and loud.
 */
export function validateAaifSkill(raw: string, opts: AaifValidateOpts = {}): AaifResult {
  const file = opts.file ?? 'SKILL.md';
  const violations: AaifViolation[] = [];
  const rawLines = raw.split(/\r?\n/);

  // Locate the frontmatter close fence to translate body-relative lint lines
  // into whole-file lines.
  let closeFenceLine = 0;
  for (let i = 1; i < rawLines.length; i++) {
    if (/^---\s*$/.test(rawLines[i])) { closeFenceLine = i + 1; break; }
  }
  const bodyOffset = closeFenceLine > 0 ? closeFenceLine : 0;
  const keyLine = (key: string): number | undefined => {
    const re = new RegExp(`^${key.replace(/[-]/g, '\\-')}\\s*:`);
    for (let i = 0; i < rawLines.length; i++) {
      if (re.test(rawLines[i])) return i + 1;
      if (i > 0 && /^---\s*$/.test(rawLines[i])) break; // frontmatter ended
    }
    return undefined;
  };

  const hasFrontmatter = /^\ufeff?---\s*\r?\n/.test(raw);
  if (!hasFrontmatter) {
    violations.push({
      rule: 'frontmatter-missing', severity: 'error',
      message: 'no YAML frontmatter block — SKILL.md must start with a --- delimited frontmatter (name + description required)',
      file, line: 1,
    });
    // The house gate still applies to the body: a frontmatter-less file is a
    // markdown document, and its body is everything.
    for (const issue of lintSkillDoc('', '', raw).issues) {
      violations.push(fromLintIssue(issue, file, 0));
    }
    return { ok: false, violations };
  }

  const { frontmatter, body } = parseFrontmatter(raw);

  // ── name ────────────────────────────────────────────────────────────────
  const rawName = frontmatter.name;
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const nameLine = keyLine('name');
  if (!name) {
    violations.push({
      rule: 'name-required', severity: 'error',
      message: 'frontmatter field `name` is required (non-empty string)',
      file, line: nameLine ?? 1,
    });
  } else {
    if (name.length > AAIF_LIMITS.MAX_NAME_LENGTH) {
      violations.push({
        rule: 'name-length', severity: 'error',
        message: `name is ${name.length} chars — spec max is ${AAIF_LIMITS.MAX_NAME_LENGTH}`,
        file, line: nameLine,
      });
    }
    if (name !== name.toLowerCase()) {
      violations.push({
        rule: 'name-format', severity: 'error',
        message: `name "${name}" must be lowercase`,
        file, line: nameLine,
      });
    }
    if (name.startsWith('-') || name.endsWith('-')) {
      violations.push({
        rule: 'name-format', severity: 'error',
        message: `name "${name}" must not start or end with a hyphen`,
        file, line: nameLine,
      });
    }
    if (name.includes('--')) {
      violations.push({
        rule: 'name-format', severity: 'error',
        message: `name "${name}" must not contain consecutive hyphens`,
        file, line: nameLine,
      });
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      violations.push({
        rule: 'name-format', severity: 'error',
        message: `name "${name}" may only contain lowercase letters, digits, and single hyphens`,
        file, line: nameLine,
      });
    }
    // Spec: the name must match the parent directory name. Mochi's flat
    // `<name>.md` layout is an extension; there the name must match the file
    // basename instead.
    if (opts.dirName !== undefined && opts.dirName !== name) {
      violations.push({
        rule: 'name-dir-match', severity: 'error',
        message: `directory "${opts.dirName}" must match skill name "${name}"`,
        file, line: nameLine,
      });
    }
    if (opts.flatFileName !== undefined && opts.flatFileName !== name) {
      violations.push({
        rule: 'name-dir-match', severity: 'error',
        message: `file basename "${opts.flatFileName}" must match skill name "${name}"`,
        file, line: nameLine,
      });
    }
  }

  // ── description ─────────────────────────────────────────────────────────
  const rawDesc = frontmatter.description;
  const description = typeof rawDesc === 'string' ? rawDesc.trim() : '';
  const descLine = keyLine('description');
  if (!description) {
    violations.push({
      rule: 'description-required', severity: 'error',
      message: 'frontmatter field `description` is required (non-empty, max 1024 chars) — it drives skill discovery',
      file, line: descLine ?? 1,
    });
  } else if (description.length > AAIF_LIMITS.MAX_DESCRIPTION_LENGTH) {
    violations.push({
      rule: 'description-length', severity: 'error',
      message: `description is ${description.length} chars — spec max is ${AAIF_LIMITS.MAX_DESCRIPTION_LENGTH}`,
      file, line: descLine,
    });
  }

  // ── optional spec fields: types + limits ────────────────────────────────
  if ('compatibility' in frontmatter) {
    const c = frontmatter.compatibility;
    if (typeof c !== 'string') {
      violations.push({
        rule: 'compatibility-type', severity: 'error',
        message: 'frontmatter field `compatibility` must be a string when present',
        file, line: keyLine('compatibility'),
      });
    } else if (c.length > AAIF_LIMITS.MAX_COMPATIBILITY_LENGTH) {
      violations.push({
        rule: 'compatibility-length', severity: 'error',
        message: `compatibility is ${c.length} chars — spec max is ${AAIF_LIMITS.MAX_COMPATIBILITY_LENGTH}`,
        file, line: keyLine('compatibility'),
      });
    }
  }
  if ('metadata' in frontmatter) {
    const m = frontmatter.metadata as unknown;
    const bad = m === null || typeof m !== 'object' || Array.isArray(m)
      || Object.entries(m as Record<string, unknown>).some(([, v]) => typeof v !== 'string');
    if (bad) {
      violations.push({
        rule: 'metadata-type', severity: 'error',
        message: 'frontmatter field `metadata` must be a map of string keys to string values',
        file, line: keyLine('metadata'),
      });
    }
  }
  if ('allowed-tools' in frontmatter) {
    const at = frontmatter['allowed-tools'];
    if (typeof at !== 'string' || !at.trim()) {
      violations.push({
        rule: 'allowed-tools-type', severity: 'error',
        message: 'frontmatter field `allowed-tools` must be a space-separated string of tool names when present',
        file, line: keyLine('allowed-tools'),
      });
    }
  }
  if ('license' in frontmatter) {
    const l = frontmatter.license;
    if (typeof l !== 'string') {
      violations.push({
        rule: 'license-type', severity: 'error',
        message: 'frontmatter field `license` must be a string when present',
        file, line: keyLine('license'),
      });
    }
  }
  // Mochi legacy declared-tools extension: same shape contract as allowed-tools.
  if ('tools' in frontmatter) {
    const t = frontmatter.tools as unknown;
    const okShape = typeof t === 'string'
      || (Array.isArray(t) && t.every((x) => typeof x === 'string'));
    if (!okShape) {
      violations.push({
        rule: 'tools-type', severity: 'error',
        message: 'frontmatter field `tools` must be a string or a list of strings when present',
        file, line: keyLine('tools'),
      });
    }
  }

  // ── unknown frontmatter fields ──────────────────────────────────────────
  const allowed = new Set([...AAIF_SPEC_FIELDS, ...MOCHI_EXTENSION_FIELDS]);
  const unknown = Object.keys(frontmatter).filter((k) => !allowed.has(k)).sort();
  if (unknown.length > 0) {
    violations.push({
      rule: 'unknown-field', severity: 'error',
      message: `unexpected frontmatter field(s): ${unknown.join(', ')} — allowed: ${[...allowed].sort().join(', ')} (see docs/AAIF_SKILL_AUTHORING.md)`,
      file, line: keyLine(unknown[0]),
    });
  }

  // ── house body-structure gate (stricter than the spec, never looser) ────
  const suppressSlug = violations.some((v) => v.rule === 'name-required' || v.rule === 'name-length');
  const suppressDescMin = violations.some((v) => v.rule === 'description-required');
  for (const issue of lintSkillDoc(name, description, body).issues) {
    if (suppressSlug && issue.rule === 'slug-format') continue;
    if (suppressDescMin && issue.rule === 'description-min') continue;
    violations.push(fromLintIssue(issue, file, bodyOffset, keyLine));
  }

  return { ok: !violations.some((v) => v.severity === 'error'), violations };
}

/** Convert a house-lint issue into an AAIF violation, translating body-relative
 *  lines into whole-file lines and pinning frontmatter-driven rules to their
 *  key line when possible. */
function fromLintIssue(issue: SkillLintIssue, file: string, bodyOffset: number, keyLineHint?: (key: string) => number | undefined): AaifViolation {
  let line = issue.line !== undefined && issue.line > 0 ? issue.line + bodyOffset : undefined;
  if (line === undefined && keyLineHint) {
    if (issue.rule === 'slug-format') line = keyLineHint('name');
    if (issue.rule === 'description-min' || issue.rule === 'description-max') line = keyLineHint('description');
  }
  return { rule: issue.rule, severity: issue.severity, message: issue.message, file, line };
}

/** Render violations for CLI output: `rule (file:line): message`. */
export function formatAaifViolations(violations: AaifViolation[]): string {
  return violations
    .map((v) => `[${v.severity}] ${v.rule} (${v.file}${v.line !== undefined ? `:${v.line}` : ''}): ${v.message}`)
    .join('\n');
}
