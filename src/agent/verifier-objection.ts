// Structured verifier objection (Wave S4 — smarter per token).
//
// The waste this kills: when the verifier rejects a finish attempt, the
// retry used to be informed only by (a) a one-off diagnosis dump and (b)
// the FULL prose summary appended to state.knownErrors — which is then
// re-rendered into EVERY later prompt, growing by one full summary per
// failure, with the current objection indistinguishable from stale ones.
// On suppressed-replan retries the injection shrank to a terse "same
// failure, no new evidence" note that dropped the objection entirely.
//
// The objection is the canonical, structured form of the rejection:
// failing checks, the salient evidence lines, and what closes it. The
// loop pins exactly ONE objection block in the transcript and refreshes
// it in place per rejection, so every retry demonstrably carries the
// current objection (tests assert the retry differs because of it) at a
// bounded size (~0.5K chars), and state.knownErrors gets a one-line
// digest instead of the whole summary.

export const OBJECTION_MARKER = 'VERIFIER OBJECTION';
export const OBJECTION_OPEN_MARKER = 'VERIFIER OBJECTION — OPEN';

export interface VerifierObjection {
  /** Gate status of the rejected attempt: FAIL, BLOCKED, … */
  status: string;
  /** Consecutive failed verifications including this one. */
  attempt: number;
  /** Commands of the checks that failed, in order. */
  failedChecks: string[];
  /** The evidence lines that explain WHY it failed (capped). */
  salientLines: string[];
  /** What the next attempt must do to close the objection. */
  remedy: string;
}

const SALIENT_RE = /(wrong|fail|error|expected|assert|✕|✗|×|not ok|mismatch|exception|denied|blocked)/i;
const MAX_SALIENT = 6;
const MAX_LINE_CHARS = 220;

function capLine(line: string): string {
  const t = line.trim();
  return t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS - 1)}…` : t;
}

/** Extract the evidence lines that explain a verification summary. */
export function salientFailureLines(summary: string): string[] {
  const lines = summary.split('\n').map((l) => l.trim()).filter(Boolean);
  const salient: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.startsWith('Check failed (fast lane):')) continue; // captured as a check, not evidence
    if (line.startsWith('Check failed:')) continue; // captured as a check, not evidence
    if (!SALIENT_RE.test(line)) continue;
    const capped = capLine(line);
    if (seen.has(capped)) continue;
    seen.add(capped);
    salient.push(capped);
    if (salient.length >= MAX_SALIENT) break;
  }
  if (salient.length === 0) {
    // Nothing pattern-matched: fall back to the head of the output that
    // followed the first failing check (or of the summary itself).
    const idx = lines.findIndex((l) => l.startsWith('Check failed:'));
    const from = idx >= 0 ? idx + 1 : 0;
    for (const line of lines.slice(from, from + 3)) {
      const capped = capLine(line);
      if (!seen.has(capped)) {
        seen.add(capped);
        salient.push(capped);
      }
    }
  }
  return salient;
}

/** Build the structured objection from a gate outcome. */
export function buildObjection(input: { status: string; summary: string; attempt: number }): VerifierObjection {
  const { status, summary, attempt } = input;
  const failedChecks: string[] = [];
  // The fast lane's failure line is `Check failed (fast lane): <cmd>` — the
  // `(fast lane)` infix must not hide the failing command from the objection.
  for (const m of summary.matchAll(/^Check failed(?: \(fast lane\))?: (.+)$/gm)) {
    const cmd = m[1].trim();
    if (cmd && !failedChecks.includes(cmd)) failedChecks.push(cmd);
  }
  const salientLines = salientFailureLines(summary);
  let remedy: string;
  if (status === 'BLOCKED') {
    remedy = 'Produce the change the task requires (edit or write a file) so there is evidence to verify, then finish again — a finish with no evidenced change is blocked again.';
  } else if (failedChecks.length > 0) {
    remedy = `Make the failing check pass: \`${failedChecks[0]}\`${failedChecks.length > 1 ? ` (and ${failedChecks.length - 1} more above)` : ''}. Address the evidence above — do not repeat the approach that produced it, and do not re-run the check unchanged expecting a different result.`;
  } else {
    remedy = 'Provide the evidence the verifier asked for above, then finish again.';
  }
  return { status, attempt, failedChecks, salientLines, remedy };
}

/** The pinned transcript block. Bounded (~0.6K chars) by construction. */
export function renderObjection(o: VerifierObjection): string {
  const lines: string[] = [
    `${OBJECTION_OPEN_MARKER} (attempt ${o.attempt}, status ${o.status})`,
    'The last finish attempt was REJECTED by the verifier. This block is the only open objection — it replaces any earlier rejection. Retry against it:',
  ];
  if (o.failedChecks.length) lines.push(`Failing check(s): ${o.failedChecks.join(' ; ')}`);
  if (o.salientLines.length) {
    lines.push('Evidence:');
    for (const l of o.salientLines) lines.push(`  ${l}`);
  }
  lines.push(`To close this objection: ${o.remedy}`);
  return lines.join('\n');
}

/** The same block, closed — replaces the open one when the gate passes. */
export function renderObjectionClosed(attempt: number): string {
  return `${OBJECTION_MARKER} — CLOSED (after ${attempt} rejected attempt${attempt === 1 ? '' : 's'}): all checks pass. The objection is resolved; do not keep fixing it.`;
}

/** One-line digest for state.knownErrors (re-rendered every turn, so it
 *  must stay one line — the full objection lives in the pinned block). */
export function objectionDigestLine(o: VerifierObjection): string {
  const head = o.failedChecks[0] ?? o.salientLines[0] ?? o.status;
  const tail = o.failedChecks.length && o.salientLines.length ? ` — ${o.salientLines[0]}` : '';
  return capLine(`verify ${o.status}: ${head}${tail}`);
}
