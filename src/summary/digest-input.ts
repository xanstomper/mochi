// Salience-ranked digest input builder.
//
// The mid-run digest (loop.ts digestOldMessages) and the compaction
// checkpoint (checkpointAndCompact) both feed a slice of history to a fast
// model for summarization. The legacy input builder was blind truncation:
// each message head-sliced to 400 chars, the concatenation head-cut to the
// budget (12K chars standard). That destroys exactly the content the digest
// exists to preserve — file paths, error text, and decisions are usually
// NOT in the first 400 chars of a message, and whole late messages fall
// off the head cut entirely (measured: a fixture history with a decision
// at message 19 and an error at message 35 lost BOTH at a 12K budget).
//
// This builder spends the SAME total budget by information value instead:
//   1. Every message gets a floor render so the narrative sequence survives.
//   2. Lines carrying paths / errors / decisions are scored salient and
//      pulled into the render even when they sit deep inside a long
//      message (head + salient lines + tail instead of head-only).
//   3. Leftover budget upgrades high-salience messages first (bigger
//      per-message allowance), in chronological output order.
// Deterministic, no model calls, no new dependencies.

export interface DigestMessageLike {
  role: string;
  content?: unknown;
  name?: string;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
}

const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|rs|go|java|rb|md|json|yaml|yml|toml|sh)\b/;
const ERROR_RE = /\b(?:error|Error|ERROR|FAIL|FAILED|failed|Exception|panic|AssertionError|TypeError|SyntaxError|ReferenceError|cannot find|TS\d{4,5}|exit(?: code)? [1-9]\d*)\b/;
const DECISION_RE = /\b(?:decided|decision|chose|chosen|will use|instead of|root cause|fixed by|approach:|decisions?:|TODO|FIXME|blocked|unresolved)\b/i;

/** Salience score for one line of message text. */
export function lineSalience(line: string): number {
  let s = 0;
  if (ERROR_RE.test(line)) s += 8;
  if (DECISION_RE.test(line)) s += 8;
  if (PATH_RE.test(line)) s += 3;
  return s;
}

interface Rendered {
  index: number;
  header: string;
  body: string;
  score: number;
}

/** Render one message at a given char allowance: head lines, then salient
 *  lines in order, then tail lines — each segment marked when elided. */
function renderBody(body: string, allowance: number): string {
  if (body.length <= allowance) return body;
  const lines = body.split('\n');
  const headBudget = Math.floor(allowance * 0.3);
  const tailBudget = Math.floor(allowance * 0.2);
  const salientBudget = allowance - headBudget - tailBudget;

  const headLines: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > headBudget && headLines.length > 0) break;
    headLines.push(line);
    used += line.length + 1;
    if (used >= headBudget) break;
  }

  const tailLines: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= headLines.length; i--) {
    const line = lines[i];
    if (used + line.length + 1 > tailBudget && tailLines.length > 0) break;
    tailLines.unshift(line);
    used += line.length + 1;
    if (used >= tailBudget) break;
  }

  const middle = lines.slice(headLines.length, lines.length - tailLines.length);
  const salient: string[] = [];
  used = 0;
  for (const line of middle) {
    if (lineSalience(line) === 0) continue;
    // A single salient line longer than the budget is head-sliced: the
    // path/error token is almost always near the start of the line.
    const piece = line.length > salientBudget ? line.slice(0, salientBudget) : line;
    if (used + piece.length + 1 > salientBudget && salient.length > 0) continue;
    salient.push(piece);
    used += piece.length + 1;
    if (used >= salientBudget) break;
  }

  const parts: string[] = [];
  if (headLines.length) parts.push(headLines.join('\n'));
  if (salient.length) parts.push(`… [salient lines kept] …\n${salient.join('\n')}`);
  if (tailLines.length) parts.push(tailLines.join('\n'));
  const out = parts.join('\n');
  // Allowance is a target, not a hard cap, when the message is a single
  // giant line (no line structure to exploit): head-slice as last resort.
  return out.length > allowance * 1.5 ? out.slice(0, allowance) : out;
}

function prepare(m: DigestMessageLike, index: number): Rendered {
  let body: string;
  if (typeof m.content === 'string') body = m.content;
  else if (m.content != null) body = JSON.stringify(m.content) ?? '';
  else body = '';
  let header: string;
  if (m.role === 'tool') {
    header = `[tool ${m.name ?? ''}]`;
  } else if (m.role === 'assistant' && m.tool_calls?.length) {
    const calls = m.tool_calls
      .map((t) => `${t.function.name}(${(t.function.arguments ?? '').slice(0, 120)})`)
      .join('; ');
    header = '[assistant called]';
    body = body ? `${calls}\n${body}` : calls;
  } else {
    header = `[${m.role}]`;
  }
  let score = m.role === 'user' ? 100 : 0;
  if (m.tool_calls?.length) score += 10;
  for (const line of body.split('\n')) score += lineSalience(line);
  return { index, header, body, score };
}

/**
 * Build the summarizer input for `messages` within `budgetChars` total.
 * Chronological order is preserved. Every message appears at least at the
 * floor allowance; remaining budget upgrades messages by salience.
 */
export function buildDigestInput(
  messages: readonly DigestMessageLike[],
  budgetChars: number,
): string {
  if (messages.length === 0 || budgetChars <= 0) return '';
  const prepared = messages.map(prepare);

  // Floor allowance: shrink until the floors fit the budget (a digest slice
  // can hold hundreds of messages; below the smallest floor we fall back to
  // the compact floor for all and let the final hard cap bind).
  let floor = 160;
  const fits = (f: number) =>
    prepared.reduce((s, p) => s + p.header.length + Math.min(p.body.length, f) + 1, 0) <= budgetChars;
  while (floor > 48 && !fits(floor)) floor -= 16;

  const allowances = prepared.map(() => floor);
  let spent = prepared.reduce((s, p, i) => s + p.header.length + Math.min(p.body.length, allowances[i]) + 1, 0);

  // Upgrade pass: highest salience first, through widening tiers.
  const byScore = [...prepared].sort((a, b) => b.score - a.score || a.index - b.index);
  for (const tier of [640, 1600, 4000]) {
    for (const p of byScore) {
      if (p.body.length <= allowances[p.index]) continue;
      const next = Math.min(p.body.length, tier);
      const delta = next - allowances[p.index];
      if (spent + delta > budgetChars) continue;
      allowances[p.index] = next;
      spent += delta;
    }
  }

  const out = prepared
    .map((p) => `${p.header} ${renderBody(p.body, allowances[p.index])}`)
    .join('\n');
  return out.length > budgetChars ? out.slice(0, budgetChars) : out;
}
