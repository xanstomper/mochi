// Failure diagnosis: classify what went wrong, propose ranked hypotheses, and
// track attempts so the agent's retry loop is observation-driven instead of
// "model tries again, hoping for the best". Paired with autopsy.ts (which
// persists what was tried) and lessons.ts (which remembers what worked).

import type { MochiConfig, ModelConfig } from './types.js';

export type FailureKind =
  | 'syntax'        // compile/parse error
  | 'type'          // type-checker error
  | 'logic'         // code compiles, runs, but produces wrong result
  | 'test_gap'      // code correct, test doesn't exercise it well
  | 'env_missing'   // command or library not installed (exit 127 / MODULE_NOT_FOUND)
  | 'env_runtime'   // command fails for env reasons (network, perms, port busy)
  | 'concurrency'   // race / lock / order-of-operations failure
  | 'unknown';      // signals don't fit a known bucket

export interface Hypothesis {
  id: string;            // stable identifier so an autopsy can name it
  description: string;   // one-line claim the agent should test
  probeCommand?: string; // optional cheap probe (read-only) to gather evidence
  confidence: number;    // 0..1, updated as evidence accumulates
  status: 'pending' | 'evidence_for' | 'evidence_against' | 'confirmed' | 'refuted';
}

export interface DiagnosisResult {
  kind: FailureKind;
  signals: string[];     // snippets of stderr / output that drove the classification
  hypotheses: Hypothesis[];
  summary: string;       // human-readable diagnostic, suitable for prompt context
}

/** Classify a failure from the verifier output and any captured stderr/stdout. */
export function classifyFailure(failureText: string): { kind: FailureKind; signals: string[] } {
  const t = failureText.toLowerCase();
  const signals: string[] = [];

  // Order matters: a single line can match several kinds, but the most
  // specific / earliest-by-cause wins. Env errors are checked first because
  // they're the cheapest cause to dispose of. Regexes are built via RegExp
  // (not literals) so quotes/backticks inside the patterns don't terminate
  // the literal mid-pattern.
  const patterns: Array<[FailureKind, RegExp, string]> = [
    ['env_missing',   /(command not found|exit_code:\s*127|enoent.*\/)/,                       'command not found / binary missing'],
    ['env_runtime',   /(econnrefused|econnreset|etimedout|enotfound|eai_again|host not found|certificate has expired|cert_has_expired|getaddrinfo|operation not permitted|permission denied)/, 'network/permission transport error'],
    ['syntax',        /(syntaxerror|syntax error|unexpected token|cannot use import statement outside a module|unexpected reserved word|parse error|unterminated string)/, 'parse-level syntax error'],
    ['type',          /\b(ts\d+|type '[a-z0-9_.]+' is not assignable|property '[a-z0-9_]+' does not exist|ts[0-9]{4}|cannot find name|cannot find type|cannot find module|has no exported member|argument of type .* is not assignable)\b/, 'TypeScript type error'],
    ['logic',         /(not ok|assertion failed|assert\.strictequal|expected .* to (?:be|equal)|expect\(.*\)\.to(?:be|equal)|failure:|test failed|tests failed)/, 'test assertion / expected-vs-actual mismatch'],
    // A "test passed" + "mutation survived" mismatch often means the test doesn't
    // actually exercise the changed logic — that's a coverage hole, not the code
    // being wrong.
    ['test_gap',      /(weak coverage|survived|injected.*bug.*not caught|coverage.*hole)/, 'weak test coverage / mutation survived'],
    ['concurrency',   /(deadlock|race condition|file lock|cannot lock|ebusy|etxtbsy|ebusy: resource busy)/, 'concurrency / file lock'],
  ];
  for (const [kind, pat, note] of patterns) {
    if (pat.test(t)) {
      signals.push(note);
      return { kind, signals };
    }
  }
  return { kind: 'unknown', signals: [] };
}

/** Order hypotheses by confidence descending; the loop tries them in order. */
export function rankHypotheses(h: Hypothesis[]): Hypothesis[] {
  return [...h].sort((a, b) => b.confidence - a.confidence);
}

/** Build an initial hypothesis set appropriate for the failure kind and the
 *  files the agent has been editing. Each hypothesis has a probe command the
 *  agent can run to gather evidence quickly (mostly read-only). */
export function formInitialHypotheses(
  kind: FailureKind,
  filesModified: string[],
): Hypothesis[] {
  const codeFiles = filesModified.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|cpp|c)$/.test(f));
  const base = (file: string | undefined) => file ? `Re-read the changed file: ${file}` : 'Re-read the changed source';
  switch (kind) {
    case 'syntax':
      return codeFiles.length
        ? [
            { id: 'syntax_in_changed_file', description: `Syntax error is in the recently changed file`, probeCommand: codeFiles[0] ? `node --check "${codeFiles[0]}" 2>&1 || npx tsc --noEmit --pretty false "${codeFiles[0]}" 2>&1` : undefined, confidence: 0.6, status: 'pending' },
            { id: 'syntax_brackets',     description: 'Mismatched brackets / quotes in recent edits', confidence: 0.35, status: 'pending' },
            { id: 'syntax_import',       description: 'Import syntax wrong (named/default typo)', confidence: 0.2, status: 'pending' },
          ]
        : [{ id: 'syntax_other', description: base(undefined), confidence: 0.4, status: 'pending' }];
    case 'type':
      return codeFiles.length
        ? [
            { id: 'type_changed_func', description: `Type error in changed file: ${codeFiles[0]}`, probeCommand: codeFiles[0] ? `npx tsc --noEmit --pretty false 2>&1 | head -40` : undefined, confidence: 0.7, status: 'pending' },
            { id: 'type_import_path', description: 'Missing/typoed import path (need .js extension under NodeNext)', confidence: 0.3, status: 'pending' },
            { id: 'type_signature',  description: 'Caller passes a wrong type after the edit', confidence: 0.2, status: 'pending' },
          ]
        : [{ id: 'type_unknown', description: 'Type error in untouched code', confidence: 0.4, status: 'pending' }];
    case 'logic':
      return codeFiles.length
        ? [
            { id: 'logic_off_by_one', description: 'Off-by-one, wrong operator, or wrong constant in the changed logic', probeCommand: codeFiles[0] ? `grep -n 'return\\|assert\\|expect' "${codeFiles[0]}" | head -20` : undefined, confidence: 0.45, status: 'pending' },
            { id: 'logic_branch',     description: 'A new branch handles some inputs but not the failing one', confidence: 0.25, status: 'pending' },
            { id: 'logic_state',      description: 'Implementation orders or mutates state wrong across calls', confidence: 0.2, status: 'pending' },
          ]
        : [{ id: 'logic_other', description: 'Logic error elsewhere (caller changed assumptions)', confidence: 0.3, status: 'pending' }];
    case 'test_gap':
      return [
        { id: 'gap_add_assert', description: 'Add an assertion that directly exercises the failing input', confidence: 0.7, status: 'pending' },
        { id: 'gap_branch_cov', description: 'Test misses the particular branch the mutation flipped', confidence: 0.2, status: 'pending' },
      ];
    case 'env_missing':
      return [
        { id: 'env_install_dep',  description: 'Install the missing binary / package locally', confidence: 0.7, status: 'pending' },
        { id: 'env_skip_cmd',     description: 'Skip this check (verifier already tolerates exit 127)', confidence: 0.25, status: 'pending' },
        { id: 'env_alternate',    description: 'Use an alternate tool that IS installed (pytest, vitest, ...)', confidence: 0.25, status: 'pending' },
      ];
    case 'env_runtime':
      return [
        { id: 'env_retry',          description: 'Transient — retry the check', confidence: 0.5, status: 'pending' },
        { id: 'env_raise_timeout',  description: 'Operation timed out — give it more time', confidence: 0.25, status: 'pending' },
        { id: 'env_network_check',  description: 'Network/auth issue — verify endpoint/reachability', confidence: 0.25, status: 'pending' },
      ];
    case 'concurrency':
      return [
        { id: 'concurrency_retry', description: 'Retry once — another agent may have released the lock', confidence: 0.6, status: 'pending' },
        { id: 'concurrency_serial', description: 'Run sequentially (avoid parallel edits to same path)', confidence: 0.4, status: 'pending' },
      ];
    default:
      return [
        { id: 'unknown_read_diff', description: 'Re-read the failing command output and any relevant source file', confidence: 0.4, status: 'pending' },
      ];
  }
}

/** Update a hypothesis's confidence based on probe output. */
export function evaluateProbe(
  h: Hypothesis,
  probeOutput: string,
): Hypothesis {
  const text = probeOutput.toLowerCase();
  const looksLikeSameError = /(error:|fail|not ok|ts[0-9]{4}|syntaxerror|typeerror)/i.test(text);
  if (looksLikeSameError && text.length > 0) {
    // The probe either reproduced the error (supports the hypothesis) or
    // produced a different, more specific error (also supports narrowing).
    return { ...h, confidence: Math.min(0.95, h.confidence + 0.2), status: 'evidence_for' };
  }
  // Probe ran cleanly => hypothesis is less likely the root cause.
  return { ...h, confidence: Math.max(0.05, h.confidence - 0.15), status: 'evidence_against' };
}

/** Build a compact summary suitable for the model to see in its next turn. */
export function diagnosisToPrompt(diag: DiagnosisResult): string {
  const top = rankHypotheses(diag.hypotheses).slice(0, 3);
  const lines = [
    `DIAGNOSIS: kind=${diag.kind}`,
    `Signals: ${diag.signals.slice(0, 3).join('; ') || '(none)'}`,
    'Top hypotheses to test:',
    ...top.map((h, i) => {
      const probe = h.probeCommand ? ` -> probe: ${h.probeCommand}` : '';
      return `  ${i + 1}. [${h.id}] ${h.description} (conf ${h.confidence.toFixed(2)})${probe}`;
    }),
  ];
  return lines.join('\n');
}

// Workaround: avoid importing MochiConfig / ModelConfig here if unused.
export type { ModelConfig };
