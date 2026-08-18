// Relevance-scoped retrieval: pick the memory entries most related to the
// current task so the packet only carries useful memory instead of a blanket
// dump of every entry. This mirrors jcode's "inject only relevant memories"
// principle while staying dependency-free and deterministic (no external
// embeddings), so it is fast, safe to test, and cannot bottleneck the loop.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to', 'of',
  'in', 'on', 'with', 'at', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'this', 'that', 'these', 'those', 'it', 'its', 'not', 'do', 'does', 'did',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Proportional overlap of query tokens against candidate tokens. 0..1. */
export function tokenOverlap(query: string, candidate: string): number {
  const q = new Set(tokenize(query));
  const ct = tokenize(candidate);
  if (q.size === 0 || ct.length === 0) return 0;
  let hits = 0;
  for (const t of q) if (ct.includes(t)) hits++;
  // Normalize by query size so a long candidate does not get over-credited.
  return hits / q.size;
}

/**
 * Relevance score of an entry against a query: blends token overlap over the
 * title (weighted higher) and the body, and gives a small boost to entries that
 * share a labelled topic ("architecture"/"convention"/"decision"/"failure").
 */
export function scoreEntry(query: string, title: string, body: string, kind = ''): number {
  let score = 0.6 * tokenOverlap(query, title) + 0.4 * tokenOverlap(query, body);
  if (kind && query.toLowerCase().includes(kind.toLowerCase())) score += 0.15;
  return Math.round(score * 100) / 100;
}

export interface SelectableEntry {
  title: string;
  body: string;
  kind?: string;
  source?: string;
  /** Marks a project-overview blob that should be carried regardless of score. */
  always?: boolean;
}

/**
 * Return the entries most relevant to a query, capped by `maxTokens` of total
 * rendered size and `maxEntries`. Entries below `minScore` are dropped unless
 * flagged `always` (e.g. a project overview). Deterministic: ties break on
 * insertion order.
 */
export function selectRelevant(
  query: string,
  entries: SelectableEntry[],
  opts: { maxTokens?: number; minScore?: number } = {},
): SelectableEntry[] {
  const maxTokens = opts.maxTokens ?? 2000;
  const minScore = opts.minScore ?? 0.2;

  const scored = entries.map((e) => ({
    entry: e,
    score: scoreEntry(query, e.title, e.body, e.kind ?? ''),
  }));
  scored.sort((a, b) => {
    // always entries float to the front (deterministic), then by score desc.
    if (a.entry.always !== b.entry.always) return a.entry.always ? -1 : 1;
    return b.score - a.score;
  });

  const out: SelectableEntry[] = [];
  let used = 0;
  for (const { entry, score } of scored) {
    if (!entry.always && score < minScore) continue;
    const est = Math.ceil((entry.title.length + entry.body.length) / 4);
    if (used + est > maxTokens && used > 0) break;
    out.push(entry);
    used += est;
  }
  return out;
}