// Repro synthesis (observability/repro-synth.ts).
//
// The reproduce-first gate refuses a fix task until the model has shown a
// failing reproduction. A model that cannot produce one stalls the gate. This
// module derives the cheapest HONEST reproduction the run already has the
// material for — the task text plus the last tool error — and validates it by
// running it. Validation is the whole point: a command that runs green proves
// nothing, so it is reported as `no-failure`, not handed to the model as a
// repro.
//
// In-place mode (the only mode the loop uses today) writes nothing: one
// confirmation run in the real tree, bounded output, bounded wall clock.
// Failure of any step returns an outcome; it never throws into the loop.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runShellString } from '../exec.js';
import { detectTestCommand } from '../health/health-scan.js';

export type ReproOutcome = 'validated' | 'no-candidate' | 'no-failure' | 'timeout' | 'error';

export interface ReproInput {
  repoRoot: string;
  /** Task title + description + the last tool error, joined. */
  text: string;
  /** Where the material came from ('task-text' today). */
  source: string;
  /** The task's declared verification command, when it has one. */
  testCommand?: string;
}

export interface ReproCandidate {
  command: string;
  /** Which rule produced it. */
  origin: 'task-command' | 'text-command' | 'repo-test-runner' | 'declared-test';
}

export interface ReproValidation {
  exitCode: number | null;
  /** First failure-looking line of output, trimmed; empty when none. */
  signature: string;
  /** Bounded tail of the output for the caller's log. */
  outputTail: string;
}

export interface ReproResult {
  outcome: ReproOutcome;
  candidate: ReproCandidate;
  /** Present only when outcome === 'validated'. */
  validation: ReproValidation;
}

/** Kill switch: MOCHI_REPRO_SYNTH=0. Default ON (only fires behind the
 *  reproduce-first gate, and only when the model supplied no repro). */
export function reproSynthEnabled(): boolean {
  return process.env.MOCHI_REPRO_SYNTH !== '0';
}

const KNOWN_RUNNER_RE =
  /\b((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|build)\b[^\n`]*|(?:npx\s+)?(?:vitest|jest|pytest|mocha|tsx|ts-node|node|python3?|go|cargo|make)\b[^\n`]*)/i;

const FAILURE_LINE_RE = /\b(error|failed|failure|exception|traceback|panic|assert(?:ion)?|expected|not ok|✗|×)\b/i;

/** Pull the first runnable command out of the material, if any. */
function commandFromText(text: string): string | null {
  // Prefer fenced/inline code, then a bare known runner invocation.
  const codeSpans = [...text.matchAll(/`([^`\n]{3,200})`/g)].map((m) => m[1].trim());
  for (const span of codeSpans) {
    if (KNOWN_RUNNER_RE.test(span) && !/[;&|]/.test(span)) return span;
  }
  const m = text.match(KNOWN_RUNNER_RE);
  if (m) {
    const cmd = m[1].trim().replace(/[.,;:]+$/, '');
    if (cmd && !/[;&|]/.test(cmd)) return cmd;
  }
  return null;
}

/** Repo test runner detection that itself never throws. */
function repoRunner(repoRoot: string): string | null {
  try {
    if (!existsSync(repoRoot)) return null;
    // Prefer a package.json test script, but never run a bare `npm test`
    // placeholder that is known to exit 1 ("no test specified").
    const pkgPath = join(repoRoot, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
        const test = pkg.scripts?.test;
        if (test && !/no test specified/i.test(test)) return 'npm test';
      } catch { /* fall through */ }
    }
    return detectTestCommand(repoRoot)?.cmd ?? null;
  } catch {
    return null;
  }
}

function candidateFor(input: ReproInput): ReproCandidate | null {
  if (input.testCommand && input.testCommand.trim()) {
    return { command: input.testCommand.trim(), origin: 'declared-test' };
  }
  const fromText = commandFromText(input.text);
  if (fromText) return { command: fromText, origin: 'text-command' };
  const runner = repoRunner(input.repoRoot);
  if (runner) return { command: runner, origin: 'repo-test-runner' };
  return null;
}

/** First failure-looking line, bounded. */
export function failureSignature(output: string): string {
  const lines = output.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (FAILURE_LINE_RE.test(t)) return t.slice(0, 300);
  }
  // No keyword hit: the last non-empty line of a failing run is still the
  // most useful hint (a compiler's "1 error" trailer, a segfault message).
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return t.slice(0, 300);
  }
  return '';
}

/**
 * Synthesise + validate a reproduction command.
 *
 * `inPlace` is the only supported mode: the command runs against the real
 * tree and nothing is written by this module.
 */
export async function synthesizeRepro(
  input: ReproInput,
  opts: { inPlace?: boolean; timeoutMs?: number } = {},
): Promise<ReproResult> {
  const candidate = candidateFor(input);
  if (!candidate) {
    return {
      outcome: 'no-candidate',
      candidate: { command: '', origin: 'task-command' },
      validation: { exitCode: null, signature: '', outputTail: '' },
    };
  }
  const timeoutMs = Math.max(1_000, Math.min(opts.timeoutMs ?? 30_000, 120_000));
  let result;
  try {
    result = await runShellString(candidate.command, {
      cwd: input.repoRoot,
      timeoutMs,
      maxOutput: 40_000,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
  } catch (e) {
    return {
      outcome: 'error',
      candidate,
      validation: {
        exitCode: null,
        signature: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
        outputTail: '',
      },
    };
  }
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  const outputTail = combined.length > 4_000 ? combined.slice(-4_000) : combined;
  const validation: ReproValidation = {
    exitCode: result.code,
    signature: result.code === 0 ? '' : failureSignature(combined),
    outputTail,
  };
  if (result.timedOut) return { outcome: 'timeout', candidate, validation };
  if (candidate.command.trim() === '' || result.code === null) return { outcome: 'error', candidate, validation };
  if (result.code === 0) return { outcome: 'no-failure', candidate, validation };
  return { outcome: 'validated', candidate, validation };
}
