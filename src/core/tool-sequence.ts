// MCH-52: tool-sequence n-gram predictor. Persists the ordered tool-call
// sequence of each finished task to `.mochi/tool-seqs.json`, then at the next
// task start mines bigram transitions from those sequences so the agent gets
// a "routes other tasks took" hint — e.g. after a failed `run` the pattern
// that recovered. Pure observation: never gates any tool call.
//
// D9 (v2): the store now also keeps one rich record per sequence — outcome,
// gate-verified flag, task kind, cost, and per-call ARG SHAPES (key names +
// value types only, never values) — so workflow induction can mine only
// VERIFIED winning routes instead of treating every finished run as a win.
// On-disk format v2: { version: 2, seqs: string[][], records: ToolSeqRecord[] }.
// The reader is backwards-compatible: a v1 file ({ seqs } with no version /
// records) loads with every record synthesized as outcome 'unknown', and the
// legacy `seqs` view is preserved verbatim either way. Writers always write
// v2 and never drop records already on disk.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { mochiStateDir } from './mochi-dir.js';

export interface ToolSeqStore {
  /** Most recent sequences, newest last. Capped. */
  seqs: string[][];
}

// ─── v2 records ─────────────────────────────────────────────────────────────

export type ToolSeqOutcome = 'success' | 'failure' | 'unknown';

/** One finished run's tool sequence, enriched (D9). `tools` mirrors the
 *  legacy string[] view; the rest is what v1 could not express. */
export interface ToolSeqRecord {
  tools: string[];
  /** Run outcome as the loop reported it at finish. */
  outcome: ToolSeqOutcome;
  /** True only when the verifier GATE passed the run (never self-report). */
  verified?: boolean;
  /** classifyTaskKind vocabulary ('fix' | 'implement' | …) when known. */
  taskKind?: string;
  /** Provider-reported cost of the run, when known. */
  costUsd?: number;
  /** Price-table estimate, kept separate from reported cost (C5 rule). */
  estimatedCostUsd?: number;
  /** Per-call arg shapes, parallel to `tools` (see argShapeOf). Entries may
   *  be absent for calls recorded before shapes existed. */
  argShapes?: Array<string | undefined>;
  endedAt?: number;
}

export interface ToolSeqStoreV2 {
  version: 2;
  seqs: string[][];
  records: ToolSeqRecord[];
}

const MAX_SEQS = 120;
const MAX_LEN = 40;

function storePath(workspaceDir: string): string {
  return resolve(mochiStateDir(workspaceDir), 'tool-seqs.json');
}

const OUTCOMES: ReadonlySet<string> = new Set(['success', 'failure', 'unknown']);

/** Deterministic SHAPE of a tool-call args value: key names + value types
 *  only — never the values themselves, so a shape can be persisted and mined
 *  without leaking file contents, commands, or secrets into the store.
 *  Objects render as `{command:string,path:string}` (keys sorted, capped);
 *  nested objects/arrays collapse to their type so shapes stay comparable
 *  across runs whose literal args differ. */
export function argShapeOf(args: unknown): string {
  if (args === null || args === undefined) return 'none';
  if (Array.isArray(args)) return 'array';
  if (typeof args !== 'object') return typeof args;
  const keys = Object.keys(args as Record<string, unknown>).sort().slice(0, 8);
  if (keys.length === 0) return '{}';
  const rec = args as Record<string, unknown>;
  const parts = keys.map((k) => {
    const v = rec[k];
    const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    return `${k}:${t}`;
  });
  return `{${parts.join(',')}}`;
}

function parseRecord(raw: unknown): ToolSeqRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.tools) || r.tools.length === 0) return null;
  const tools = r.tools.map(String).slice(0, MAX_LEN);
  const rec: ToolSeqRecord = {
    tools,
    outcome: typeof r.outcome === 'string' && OUTCOMES.has(r.outcome) ? (r.outcome as ToolSeqOutcome) : 'unknown',
  };
  if (typeof r.verified === 'boolean') rec.verified = r.verified;
  if (typeof r.taskKind === 'string' && r.taskKind) rec.taskKind = r.taskKind;
  if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) rec.costUsd = r.costUsd;
  if (typeof r.estimatedCostUsd === 'number' && Number.isFinite(r.estimatedCostUsd)) rec.estimatedCostUsd = r.estimatedCostUsd;
  const shapes: unknown = r.argShapes;
  if (Array.isArray(shapes)) {
    rec.argShapes = tools.map((_, i) => (typeof shapes[i] === 'string' ? (shapes[i] as string) : undefined));
  }
  if (typeof r.endedAt === 'number' && Number.isFinite(r.endedAt)) rec.endedAt = r.endedAt;
  return rec;
}

/** Load the full v2 store. Backwards-compatible: v1 files (no `records`)
 *  synthesize one 'unknown'-outcome record per stored sequence. */
export function loadToolSeqStore(workspaceDir: string): ToolSeqStoreV2 {
  try {
    const p = storePath(workspaceDir);
    if (!existsSync(p)) return { version: 2, seqs: [], records: [] };
    const raw = JSON.parse(readFileSync(p, 'utf8')) as { seqs?: unknown; records?: unknown };
    const seqs = Array.isArray(raw.seqs)
      ? raw.seqs.filter((s): s is string[] => Array.isArray(s) && s.length > 0).map((s) => s.map(String)).slice(-MAX_SEQS)
      : [];
    let records: ToolSeqRecord[] = [];
    if (Array.isArray(raw.records)) {
      records = raw.records.map(parseRecord).filter((r): r is ToolSeqRecord => r !== null).slice(-MAX_SEQS);
    }
    if (records.length === 0 && seqs.length > 0) {
      // v1 file (or records lost): keep the sequences usable, honestly
      // labelled — their outcomes were never recorded.
      records = seqs.map((tools) => ({ tools, outcome: 'unknown' as const }));
    }
    // The legacy view is the file's own `seqs` field (repeated identical
    // sequences are the frequency signal — never deduped); records are the
    // parallel rich view. A records-only file falls back to deriving it.
    return { version: 2, seqs: seqs.length ? seqs : records.map((r) => r.tools), records };
  } catch {
    return { version: 2, seqs: [], records: [] };
  }
}

export function loadToolSeqs(workspaceDir: string): ToolSeqStore {
  return { seqs: loadToolSeqStore(workspaceDir).seqs };
}

function writeStore(workspaceDir: string, store: ToolSeqStoreV2): void {
  const dir = resolve(workspaceDir, '.mochi');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(storePath(workspaceDir), JSON.stringify(store));
}

export function saveToolSeq(workspaceDir: string, store: ToolSeqStore, seq: string[]): void {
  try {
    if (seq.length < 3) return; // trivial sequences carry no signal
    // Preserve any v2 records already on disk: the legacy caller only knows
    // the string view, and rewriting the file must not downgrade it.
    const existing = loadToolSeqStore(workspaceDir);
    const clean = seq.slice(0, MAX_LEN).map(String);
    store.seqs.push(clean);
    if (store.seqs.length > MAX_SEQS) store.seqs = store.seqs.slice(-MAX_SEQS);
    // Exactly one new record per save (parallel to the one new seq), with
    // outcome honestly 'unknown' — this legacy entry point never learned it.
    const records = [...existing.records, { tools: clean, outcome: 'unknown' as const }];
    writeStore(workspaceDir, {
      version: 2,
      seqs: store.seqs,
      records: records.slice(-MAX_SEQS),
    });
  } catch { /* best-effort */ }
}

/** Append one enriched v2 record (D9). Mirrors saveToolSeq's caps and
 *  trivial-sequence rejection; also updates the passed store in place. */
export function saveToolSeqRecord(workspaceDir: string, store: ToolSeqStoreV2, record: ToolSeqRecord): void {
  try {
    if (!Array.isArray(record.tools) || record.tools.length < 3) return;
    const rec: ToolSeqRecord = { ...record, tools: record.tools.slice(0, MAX_LEN).map(String) };
    store.records.push(rec);
    if (store.records.length > MAX_SEQS) store.records = store.records.slice(-MAX_SEQS);
    store.seqs = store.records.map((r) => r.tools);
    writeStore(workspaceDir, store);
  } catch { /* best-effort */ }
}

/** Records whose run is known to have succeeded; `verifiedOnly` narrows to
 *  gate-passed runs — the only input workflow induction trusts. */
export function successfulRecords(store: ToolSeqStoreV2, verifiedOnly = false): ToolSeqRecord[] {
  return store.records.filter((r) => r.outcome === 'success' && (!verifiedOnly || r.verified === true));
}

export interface Bigram { from: string; to: string; count: number }

/** Mine top bigram transitions across all stored sequences. */
export function mineBigrams(store: ToolSeqStore, top = 12): Bigram[] {
  const counts = new Map<string, number>();
  for (const seq of store.seqs) {
    for (let i = 0; i < seq.length - 1; i++) {
      const key = `${seq[i]} -> ${seq[i + 1]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([key, count]) => {
      const [from, to] = key.split(' -> ');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

/** MCH-209: predict the next tool from the run's own live sequence. Mines
 *  bigrams across past runs, then looks up transitions FROM the tools just
 *  used this run. Returns the most likely next tool(s) with counts. Empty
 *  when there's no history or no transition from the current tail. */
export function predictNextTools(store: ToolSeqStore, currentSeq: string[], top = 3): Array<{ tool: string; count: number }> {
  if (currentSeq.length === 0 || store.seqs.length === 0) return [];
  const bigrams = mineBigrams(store, 200);
  const tail = currentSeq[currentSeq.length - 1];
  const out: Array<{ tool: string; count: number }> = [];
  for (const b of bigrams) {
    if (b.from === tail && !currentSeq.slice(-2).includes(b.to)) {
      out.push({ tool: b.to, count: b.count });
    }
  }
  return out.sort((a, b) => b.count - a.count).slice(0, top);
}

/** Compact text block for task-start injection; '' when no history yet.
 *  D9: once ANY record carries a real outcome, only successful runs feed the
 *  hint (v1 mined every finished run, failures included, while calling them
 *  "habitual successful routes"). Pure-legacy stores (all outcomes unknown)
 *  keep the v1 behavior — there is no outcome evidence to filter on. */
export function toolPatternText(store: ToolSeqStore): string {
  try {
    if (store.seqs.length < 2) return '';
    let seqs = store.seqs;
    let label = `${store.seqs.length} past tasks`;
    const v2 = store as Partial<ToolSeqStoreV2>;
    if (Array.isArray(v2.records) && v2.records.some((r) => r.outcome !== 'unknown')) {
      const wins = v2.records.filter((r) => r.outcome === 'success').map((r) => r.tools);
      if (wins.length >= 2) {
        seqs = wins;
        label = `${wins.length} successful past tasks`;
      } else if (wins.length === 1) {
        return '';
      }
    }
    const grams = mineBigrams({ seqs }, 10);
    if (grams.length === 0) return '';
    const lines = grams.map((g) => `- ${g.from} -> ${g.to}  (x${g.count})`);
    return `TOOL ROUTE PATTERNS (most common tool transitions across ${label} — habitual successful routes, not requirements):\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}
