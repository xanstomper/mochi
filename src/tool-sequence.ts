// MCH-52: tool-sequence n-gram predictor. Persists the ordered tool-call
// sequence of each finished task to `.mochi/tool-seqs.json`, then at the next
// task start mines bigram transitions from those sequences so the agent gets
// a "routes other tasks took" hint — e.g. after a failed `run` the pattern
// that recovered. Pure observation: never gates any tool call.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ToolSeqStore {
  /** Most recent sequences, newest last. Capped. */
  seqs: string[][];
}

const MAX_SEQS = 120;
const MAX_LEN = 40;

function storePath(workspaceDir: string): string {
  return resolve(workspaceDir, '.mochi', 'tool-seqs.json');
}

export function loadToolSeqs(workspaceDir: string): ToolSeqStore {
  try {
    const p = storePath(workspaceDir);
    if (!existsSync(p)) return { seqs: [] };
    const raw = JSON.parse(readFileSync(p, 'utf8')) as ToolSeqStore;
    if (!Array.isArray(raw.seqs)) return { seqs: [] };
    return { seqs: raw.seqs.filter((s) => Array.isArray(s) && s.length > 0).slice(-MAX_SEQS) };
  } catch {
    return { seqs: [] };
  }
}

export function saveToolSeq(workspaceDir: string, store: ToolSeqStore, seq: string[]): void {
  try {
    if (seq.length < 3) return; // trivial sequences carry no signal
    store.seqs.push(seq.slice(0, MAX_LEN).map(String));
    if (store.seqs.length > MAX_SEQS) store.seqs = store.seqs.slice(-MAX_SEQS);
    const dir = resolve(workspaceDir, '.mochi');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(storePath(workspaceDir), JSON.stringify(store));
  } catch { /* best-effort */ }
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

/** Compact text block for task-start injection; '' when no history yet. */
export function toolPatternText(store: ToolSeqStore): string {
  try {
    if (store.seqs.length < 2) return '';
    const grams = mineBigrams(store, 10);
    if (grams.length === 0) return '';
    const lines = grams.map((g) => `- ${g.from} -> ${g.to}  (x${g.count})`);
    return `TOOL ROUTE PATTERNS (most common tool transitions across ${store.seqs.length} past tasks — habitual successful routes, not requirements):\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}
