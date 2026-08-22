// Diff-hygiene scanner (harness-v2 quality): models routinely ship working code
// polluted with debug logging, leftover TODO markers, type-check suppressions,
// and `.only()`-focused tests. Humans then burn a cleanup pass. This module
// scans ADDED lines of a diff for that class of debris so the agent can clean
// it up itself before declaring done. Pure function — trivially testable.

export interface HygieneFinding {
  file: string;
  line: number;
  kind: 'debug-log' | 'debugger' | 'todo-marker' | 'suppressed-check' | 'focused-test';
  text: string;
}

const MAX_FINDINGS = 8;

/** Files whose whole job is tests/logging — debug output there is legitimate. */
function isTestLike(file: string): boolean {
  return /\.(test|spec)\.[jt]sx?$|(^|\/)(tests?|__tests__)\//i.test(file) || /\.test\./i.test(file);
}

function codeFile(file: string): boolean {
  return /\.(tsx?|jsx?|mts|cts|mjs|cjs|py|rs|go|java|cs|php|rb)$/i.test(file);
}

interface Rule {
  kind: HygieneFinding['kind'];
  test: RegExp;
}

const RULES: Rule[] = [
  { kind: 'debugger', test: /^\s*debugger\b/ },
  { kind: 'debug-log', test: /\bconsole\.(log|debug|info|table|dir)\b\s*\(/ },
  { kind: 'debug-log', test: /\bpdb\.set_trace\b|\bbreakpoint\s*\(\s*\)/ },
  { kind: 'todo-marker', test: /\b(TODO|FIXME|HACK|XXX)\b(?![^)]*\))/ },
  { kind: 'suppressed-check', test: /@ts-ignore|@ts-expect-error|#\s*type:\s*ignore|eslint-disable(?:-next-line)?|noqa\b|#\s*noqa/i },
  { kind: 'focused-test', test: /\b(describe|it|test)\.only\s*\(/ },
];

/**
 * Scan a unified diff for added lines that match hygiene rules. Untracked new
 * files may be folded in by prefixing every content line with '+' and a
 * `+++ b/<path>` header (see collectHygiene callers).
 */
export function scanDiffForHygiene(diff: string): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  let curFile = '';
  let curLine = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      curFile = raw.slice(6).trim();
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/^\s*@@ -\d+(?:,\d+)? \+(\d+)/);
      curLine = m ? Number(m[1]) - 1 : curLine;
      continue;
    }
    if (!raw.startsWith('+') || raw.startsWith('+++')) {
      // Context lines advance the new-file line counter; removed lines don't.
      if (raw.startsWith(' ') && curFile) curLine++;
      continue;
    }
    curLine++;
    const added = raw.slice(1);
    if (!curFile || !codeFile(curFile) || isTestLike(curFile)) continue;
    // Strip common comment/string prefixes so rules match intent, not noise.
    for (const rule of RULES) {
      if (rule.test.test(added)) {
        findings.push({
          file: curFile,
          line: Math.max(1, curLine),
          kind: rule.kind,
          text: added.trim().slice(0, 160),
        });
        break; // one finding per line
      }
    }
    if (findings.length >= MAX_FINDINGS) break;
  }
  return findings;
}

export function renderHygieneFindings(f: HygieneFinding[]): string {
  return f
    .map((x) => `- [${x.kind}] ${x.file}:${x.line} — ${x.text}`)
    .join('\n');
}
