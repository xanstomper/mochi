// Lazy test output (MCH-lazy 14.3).
//
// Test/verification output surfaced to the model defaults to failures +
// summary; passing output is summarized as counts and expandable on demand
// (via the MCH-66 output archive — recall_output fetches the full log
// without re-running anything). A summary must NEVER hide a failure: every
// detected failing test is either rendered in full or explicitly named in a
// truncation marker.
//
// Kill-switch (repo convention): MOCHI_LAZY_TEST_OUTPUT=0 restores the raw
// slice.

import { stripAnsi } from './output-condenser.js';

export function lazyTestOutputEnabled(): boolean {
  return process.env.MOCHI_LAZY_TEST_OUTPUT !== '0';
}

export interface TestCounts {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  total: number | null;
}

export interface TestOutputSummary {
  framework: 'vitest' | 'jest' | 'tsc' | 'node-tap' | 'pytest' | 'generic';
  exitPassed: boolean;
  counts: TestCounts;
  /** Failing test names, every one of them (the never-hide guarantee). */
  failures: string[];
  /** Rendered failure blocks (error text with context). */
  failureBlocks: string[];
  durationMsHint: string | null;
  /** Lines summarized away — always disclosed when > 0. */
  hiddenLines: number;
  totalLines: number;
}

// ── parsers ─────────────────────────────────────────────────────────────────

interface FrameworkParse {
  framework: TestOutputSummary['framework'];
  counts: TestCounts | null;
  failures: string[];
  durationMsHint: string | null;
}

function parseVitestJest(clean: string): FrameworkParse {
  const counts: TestCounts = { passed: null, failed: null, skipped: null, total: null };
  const failures: string[] = [];
  let framework: TestOutputSummary['framework'] = 'generic';
  let durationMsHint: string | null = null;

  // Vitest prints both "Test Files  2 passed (2)" and "Tests  15 passed
  // (15)" — the Tests line wins (per-test counts), Test Files is fallback.
  let spec = '';
  let filesSpec = '';
  for (const line of clean.split(/\r?\n/)) {
    const t = line.trim();
    if (/^Test Files\s*:?\s+.+$/i.test(t)) {
      filesSpec = t.replace(/^Test Files\s*:?\s+/i, '');
      continue;
    }
    const mTests = /^Tests?\s*:?\s+(.+)$/i.exec(t);
    if (mTests) spec = mTests[1];
  }
  if (!spec) spec = filesSpec;
  if (spec) framework = 'vitest';
  for (const m of spec.matchAll(/(\d+)\s+(passed|failed|skipped|todo)/gi)) {
    const n = Number(m[1]);
    const k = m[2].toLowerCase();
    if (k === 'passed') counts.passed = n;
    else if (k === 'failed') counts.failed = n;
    else if (k === 'skipped' || k === 'todo') counts.skipped = (counts.skipped ?? 0) + n;
  }
  const dur = /Duration\s+([\d.]+)\s*(ms|s)/i.exec(clean) ?? /Time:\s*([\d.]+)\s*(ms|s)/i.exec(clean);
  if (dur) durationMsHint = `${dur[1]}${dur[2]}`;

  // Failing test names: "FAIL src/x.test.ts > suite > test" (vitest) and
  // "✕ test name" / "● test name" (jest), plus "✗". Keep every one.
  for (const line of clean.split(/\r?\n/)) {
    const v = /(?:FAIL|✕|✗|×|●)\s+(.+)/.exec(line);
    if (v) {
      const name = v[1].trim().replace(/\s+\(.*\)$/, '').slice(0, 200);
      if (name) failures.push(name);
    }
  }
  return { framework, counts, failures, durationMsHint };
}

function parseTsc(clean: string): FrameworkParse {
  const errors = [...clean.matchAll(/^(.+?)\((\d+),(\d+)\):\s*error\s*(TS\d+):\s*(.*)$/gm)];
  if (errors.length === 0 && !/\berror TS\d+:/i.test(clean)) {
    return { framework: 'generic', counts: null, failures: [], durationMsHint: null };
  }
  return {
    framework: 'tsc',
    counts: { passed: null, failed: errors.length || null, skipped: null, total: null },
    failures: errors.map((m) => `${m[1]}:${m[2]}:${m[3]} — ${m[4]}: ${m[5]}`),
    durationMsHint: null,
  };
}

function parsePytest(clean: string): FrameworkParse {
  const m = /(\d+) failed,\s*(\d+) passed/.exec(clean) ?? /(\d+) passed/.exec(clean);
  if (!m) return { framework: 'generic', counts: null, failures: [], durationMsHint: null };
  const failed = /(\d+) failed/.test(clean) ? Number(/(\d+) failed/.exec(clean)![1]) : 0;
  const passed = Number(/(\d+) passed/.exec(clean)![1]);
  const failures = [...clean.matchAll(/^FAILED (.+)$/gm)].map((x) => x[1].slice(0, 200));
  return {
    framework: 'pytest',
    counts: { passed, failed, skipped: null, total: passed + failed },
    failures,
    durationMsHint: null,
  };
}

export function parseTestOutput(clean: string): FrameworkParse {
  const vitest = parseVitestJest(clean);
  if (vitest.framework === 'vitest') return vitest;
  const tsc = parseTsc(clean);
  if (tsc.framework === 'tsc') return tsc;
  const pytest = parsePytest(clean);
  if (pytest.framework === 'pytest') return pytest;
  // Generic: any FAIL/✗ lines count as failures.
  const failures: string[] = [];
  for (const line of clean.split(/\r?\n/)) {
    const m = /(?:^|\s)(?:FAIL|✕|✗|×)\s*:?\s*(.+)/.exec(line);
    if (m) failures.push(m[1].trim().slice(0, 200));
  }
  return { framework: 'generic', counts: null, failures, durationMsHint: null };
}

// ── presentation ────────────────────────────────────────────────────────────

export interface LazyTestOutputOptions {
  /** Exit code of the run (or null when unknown). */
  exitCode?: number | null;
  /** Max failure blocks rendered in full; overflow is NAMED, never dropped. */
  maxFailureBlocks?: number;
  /** Lines of context kept around each failure block. */
  contextLines?: number;
  /** Char cap per failure block. */
  maxBlockChars?: number;
}

export interface LazyTestOutputResult {
  text: string;
  summary: TestOutputSummary;
  /** true when the presentation had to cut detail (always marked in text). */
  truncated: boolean;
}

/** FAILURE guards: lines that must survive ANY summarization. Count-only
 *  lines ("3 failed, 10 passed") are NOT guards — the counts header carries
 *  them; guards are named failures and error/assertion lines. */
function failureGuardLines(clean: string): string[] {
  const out: string[] = [];
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const countOnly = /\b\d+ (?:failed|passed)\b/.test(line) && failureNameOf(line) === null;
    if (countOnly) continue;
    if (/(?:FAIL|✕|✗|×|●|FAILED)\s*:?\s+\S/.test(line) && !/0\s+(?:failed|✕)/.test(line)) out.push(line);
    else if (/AssertionError|SyntaxError|TypeError|panic:|error TS\d+/i.test(line)) out.push(line);
    else if (/\berror\b/i.test(line) && !/0 errors?/i.test(line)) out.push(line);
    else if (/\bassert/i.test(line)) out.push(line);
    else if (/\bfailed\b/i.test(line)) out.push(line);
  }
  return out;
}

/** The laziness boundary for test/verification output.
 *
 *  - Failing run: header with counts, then EVERY detected failure rendered
 *    (bounded per-block, overflow explicitly named). Guards that survived
 *    parsing are appended so no failure line can be absent.
 *  - Passing run: counts + duration only, with an explicit "full log
 *    archived" pointer for on-demand expansion.
 *
 *  The caller owns archiving the full raw log (archiveToolOutput) and
 *  appending the recall id — this function returns `truncated` so the
 *  caller knows a marker is REQUIRED. */
export function lazyTestOutput(raw: string, opts: LazyTestOutputOptions = {}): LazyTestOutputResult {
  const clean = stripAnsi(raw);
  const lines = clean.split(/\r?\n/);
  const maxFailureBlocks = Math.max(1, opts.maxFailureBlocks ?? 8);
  const ctx = Math.max(0, opts.contextLines ?? 3);
  const maxBlockChars = Math.max(200, opts.maxBlockChars ?? 1500);

  const parsed = parseTestOutput(clean);
  const exitPassedRaw = opts.exitCode === 0 || (opts.exitCode == null && (parsed.counts?.failed ?? 0) === 0);
  const failed = !exitPassedRaw || (parsed.counts?.failed ?? 0) > 0;
  // A passing exit code with reported failures is NOT a pass: the summary
  // trusts failure markers over the exit code.
  const exitPassed = exitPassedRaw && !failed;

  const summary: TestOutputSummary = {
    framework: parsed.framework,
    exitPassed,
    counts: parsed.counts ?? { passed: null, failed: failed ? parsed.failures.length || null : 0, skipped: null, total: null },
    failures: [...new Set(parsed.failures)],
    failureBlocks: [],
    durationMsHint: parsed.durationMsHint,
    hiddenLines: 0,
    totalLines: lines.length,
  };

  // ── PASSING run: counts only, expandable on demand ──
  if (!failed) {
    if (summary.counts.failed == null) summary.counts.failed = 0; // a pass is 0 failures, never "unknown"
    const bits = ['[lazy test summary: PASS]'];
    const c = summary.counts;
    const hasParsedCounts = c.passed != null || c.skipped != null;
    const countBits: string[] = [];
    if (c.passed != null) countBits.push(`${c.passed} passed`);
    if (c.failed != null && (hasParsedCounts || c.failed > 0)) countBits.push(`${c.failed} failed`);
    if (c.skipped) countBits.push(`${c.skipped} skipped`);
    bits.push(countBits.length ? countBits.join(', ') : `${lines.length} output lines, no failures detected`);
    if (summary.durationMsHint) bits.push(`(${summary.durationMsHint})`);
    bits.push(`[${summary.framework} output condensed to counts — full log archived for on-demand expansion]`);
    summary.hiddenLines = Math.max(0, lines.length - 2);
    return { text: bits.join(' '), summary, truncated: false };
  }

  // ── FAILING run: failures + summary. Never hide a failure. ──
  const parts: string[] = ['[lazy test summary: FAIL]'];
  const c = summary.counts;
  const countBits: string[] = [];
  if (c.passed != null) countBits.push(`${c.passed} passed`);
  if (c.failed != null) countBits.push(`${c.failed} failed`);
  if (c.skipped) countBits.push(`${c.skipped} skipped`);
  parts.push(countBits.length ? countBits.join(', ') : 'failures detected below');
  if (summary.durationMsHint) parts.push(`(${summary.durationMsHint})`);

  // Failure blocks: locate FAIL/✕/FAILED/error-TS header lines and lift each
  // block, bounded per block.
  const failHeaderIdx: number[] = [];
  lines.forEach((l, i) => {
    if (/(?:FAIL|✕|✗|×)\s+\S/.test(l) && !/0\s+(?:failed|✕)/.test(l)) failHeaderIdx.push(i);
    else if (/error TS\d+:/i.test(l) && parsed.framework === 'tsc') failHeaderIdx.push(i);
    else if (/^FAILED\s+\S/.test(l)) failHeaderIdx.push(i);
  });
  const used = new Set<number>();
  let blocks = 0;
  for (const start of failHeaderIdx) {
    if (blocks >= maxFailureBlocks) break;
    const end = Math.min(lines.length - 1, start + ctx);
    const block: string[] = [];
    let chars = 0;
    let cut = false;
    for (let i = start; i <= end; i++) {
      if (used.has(i)) { block.push(lines[i]!); continue; }
      if (chars + lines[i]!.length > maxBlockChars && i > start) { cut = true; break; }
      block.push(lines[i]!);
      chars += lines[i]!.length + 1;
      used.add(i);
    }
    let text = block.join('\n');
    if (cut) text += `\n  … [failure block cut at ${maxBlockChars} chars — full text in the archived log]`;
    parts.push(text);
    summary.failureBlocks.push(text);
    blocks++;
  }

  const namedFailures = summary.failures;
  const overflow = namedFailures.length - blocks;
  if (overflow > 0) {
    // EXPLICIT truncation marker naming every elided failure — never silent.
    parts.push(
      `[FAILURE DETAIL TRUNCATED: ${overflow} more failing test(s) not rendered in full — ALL of them, by name: ` +
      namedFailures.slice(blocks).join(' | ') + ' — recall the archived full log for their complete output]',
    );
  }

  // Tail of the raw output: every framework prints its failure summary at
  // the end; a lazy summary must keep it (bounded).
  const TAIL_LINES = 15;
  const tail = lines.slice(Math.max(0, lines.length - TAIL_LINES)).filter((l) => l.trim().length > 0);
  const head = parts.join('\n\n');
  const tailKeep = tail.filter((l) => !head.includes(l.trim()));
  if (tailKeep.length > 0) parts.push(tailKeep.join('\n'));

  // Guarantee backstop: every failure-guard line that the presentation does
  // not otherwise cover is kept verbatim (bounded). Coverage = the exact
  // line is rendered, or the failing test NAME it carries is rendered.
  const presentation = parts.join('\n\n');
  const missingGuards = failureGuardLines(clean).filter((g) => {
    const t = g.trim();
    if (presentation.includes(t)) return false;
    const name = failureNameOf(t);
    return !(name && namedFailures.some((f) => f.includes(name) && presentation.includes(name)));
  });
  if (missingGuards.length > 0) {
    const keep = missingGuards.slice(0, 12);
    parts.push(
      `[summary never hides a failure — guard lines not otherwise rendered, kept verbatim (${missingGuards.length}):]\n` +
      keep.join('\n') +
      (missingGuards.length > keep.length ? `\n… [${missingGuards.length - keep.length} more guard lines in the archived full log]` : ''),
    );
  }

  const finalText = parts.join('\n\n');
  summary.hiddenLines = Math.max(0, lines.length - finalText.split('\n').length);
  return { text: finalText, summary, truncated: overflow > 0 || missingGuards.length > 0 };
}

/** Distinctive failing-test name carried by a guard line (timing and file
 *  prefixes stripped), or null for count-only summary lines. */
function failureNameOf(line: string): string | null {
  if (/^(Test Files|Tests|Tests?:|Start at|Duration)\b/i.test(line)) return null;
  const m = /(?:FAIL|✕|✗|×|●|FAILED)\s*:?\s*(.+)/.exec(line);
  if (!m) return null;
  return m[1].replace(/\s+\(.*\)$/, '').replace(/\s+\d+(\.\d+)?m?s$/, '').trim() || null;
}
