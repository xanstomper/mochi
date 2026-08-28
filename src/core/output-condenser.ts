// Deterministic Noisy Compiler & Test Output Condenser
// Strips 80-95% of repetitive compiler banners, build scaffolding,
// and passing test noise, keeping strictly actionable syntax errors,
// failing assertions, and diagnostic locations.

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}

export interface CondenserResult {
  condensed: string;
  originalLineCount: number;
  condensedLineCount: number;
  savingsPercent: number;
  detectedErrors: string[];
}

/** Condenses noisy compiler, linter, or test output down to high-signal diagnostic lines */
export function condenseOutput(
  raw: string,
  options: { maxLines?: number; preserveContext?: number } = {}
): CondenserResult {
  const clean = stripAnsi(raw);
  const lines = clean.split(/\r?\n/);
  const originalLineCount = lines.length;

  if (originalLineCount <= (options.maxLines ?? 30)) {
    return {
      condensed: clean.trim(),
      originalLineCount,
      condensedLineCount: originalLineCount,
      savingsPercent: 0,
      detectedErrors: extractErrors(lines),
    };
  }

  const importantIndices = new Set<number>();
  const detectedErrors: string[] = [];

  // Identify high-signal error and failure patterns
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isError =
      /error(\[[A-Za-z0-9_-]+\])?:/i.test(line) ||
      /fail(ed|ure)?:/i.test(line) ||
      /\bFAIL\b/.test(line) ||
      /AssertionError:/i.test(line) ||
      /Expected:.*Received:/is.test(line) ||
      /SyntaxError:/i.test(line) ||
      /TypeError:/i.test(line) ||
      /panic:/i.test(line) ||
      /undefined reference to/i.test(line) ||
      /cannot find (module|symbol|package)/i.test(line) ||
      /TS\d{4,5}:/i.test(line) ||
      /\.ts\(\d+,\d+\): error/i.test(line);

    if (isError) {
      detectedErrors.push(line.trim());
      const ctx = options.preserveContext ?? 2;
      for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
        importantIndices.add(j);
      }
    }
  }

  // If no specific error markers matched, fallback to head + tail
  if (importantIndices.size === 0) {
    const head = lines.slice(0, 10);
    const tail = lines.slice(-15);
    const condensed = [
      ...head,
      `... [${originalLineCount - 25} lines omitted by output condenser] ...`,
      ...tail,
    ].join('\n');

    return {
      condensed,
      originalLineCount,
      condensedLineCount: head.length + tail.length + 1,
      savingsPercent: Math.round(((originalLineCount - (head.length + tail.length + 1)) / originalLineCount) * 100),
      detectedErrors: [],
    };
  }

  // Always preserve top 2 lines and final 3 summary lines if available
  importantIndices.add(0);
  if (lines.length > 1) importantIndices.add(1);
  for (let t = Math.max(0, lines.length - 3); t < lines.length; t++) {
    importantIndices.add(t);
  }

  const sorted = Array.from(importantIndices).sort((a, b) => a - b);
  const resultLines: string[] = [];
  let lastIdx = -1;

  for (const idx of sorted) {
    if (lastIdx !== -1 && idx > lastIdx + 1) {
      const omitted = idx - lastIdx - 1;
      resultLines.push(`  ... [${omitted} lines omitted] ...`);
    }
    resultLines.push(lines[idx]);
    lastIdx = idx;
  }

  const condensed = resultLines.join('\n').trim();
  const condensedLineCount = resultLines.length;
  const savingsPercent = Math.max(0, Math.round(((originalLineCount - condensedLineCount) / originalLineCount) * 100));

  return {
    condensed,
    originalLineCount,
    condensedLineCount,
    savingsPercent,
    detectedErrors,
  };
}

function extractErrors(lines: string[]): string[] {
  const errors: string[] = [];
  for (const line of lines) {
    if (/error|fail|panic|AssertionError|TS\d{4}/i.test(line)) {
      errors.push(line.trim());
    }
  }
  return errors;
}
