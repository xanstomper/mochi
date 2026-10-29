// D2: content-addressed spill store for oversized compacted units.
//
// Problem this closes: elision is only a save if the elision marker can be
// resolved later. Both pre-existing spill paths can leave markers pointing
// nowhere:
//   - core/tool-output.ts spills folds to a RANDOM path in the system
//     tmpdir — tmp cleaners reap it, and nothing ties the path to content;
//   - tools/output-archive.ts is a 200-entry ring buffer that truncates
//     entries at 200K chars — eviction orphans earlier ids silently.
// A marker that points nowhere is a silent drop, not a save.
//
// This store is the durable leg of the compaction bundle: full content,
// keyed by its own SHA-256 (content-addressed: identical content lands on
// the identical key, so spills are idempotent and self-verifying on
// retrieval), stored local-only under <root>/.mochi/spill/ — gitignored via
// an in-directory .gitignore so user workspaces ignore the store regardless
// of how .mochi itself is tracked — never truncated, never evicted.
// Retrieval verifies the hash: corrupted content resolves to null rather
// than to wrong evidence.
//
// The THRESHOLD policy (what counts as oversized) belongs to the callers
// (ContextEngine), not here; this module is the mechanism only.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../prompt/stable-prefix.js';

/** Default oversized-output threshold in chars (~52K tokens at chars/3.8).
 *  Sits ABOVE every pre-existing fold/condense limit (fold hard limit is
 *  12K simple / 120K complex), so ordinary folding behavior is untouched —
 *  only genuinely oversized units take the spill path. Overridable via
 *  MOCHI_SPILL_THRESHOLD_CHARS. */
export const DEFAULT_SPILL_THRESHOLD_CHARS = parseEnvInt('MOCHI_SPILL_THRESHOLD_CHARS', 200_000);

/** Default re-injection budget in chars for the post-compaction hook
 *  (~1.6K tokens at chars/3.8). Overridable via
 *  MOCHI_REINJECTION_BUDGET_CHARS. */
export const DEFAULT_REINJECTION_BUDGET_CHARS = parseEnvInt('MOCHI_REINJECTION_BUDGET_CHARS', 6_000);

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Canonical spill key: `spill-` + first 16 hex chars of SHA-256(content). */
export function spillKeyOf(text: string): string {
  return `spill-${sha256Hex(text).slice(0, 16)}`;
}

/** Spill keys as they appear in markers/ledgers. 16 hex chars = 64 bits of
 *  content identity — collision risk is negligible at transcript scale. */
export const SPILL_KEY_RE = /\bspill-[0-9a-f]{16}\b/g;

export interface SpilledRef {
  key: string;
  chars: number;
  /** Tool that produced the content (for the ledger line), when known. */
  tool?: string;
}

export function spillDirPath(projectRoot: string): string {
  return join(projectRoot, '.mochi', 'spill');
}

/** The spill store is local-only: make git ignore its contents in any
 *  workspace, even ones that track `.mochi/`. Best-effort. */
function ensureGitignored(dir: string): void {
  const marker = join(dir, '.gitignore');
  if (!existsSync(marker)) writeFileSync(marker, '*\n', 'utf8');
}

/**
 * Spill full content to the content-addressed store. Idempotent: identical
 * content resolves to the identical key and rewrites nothing. Returns null
 * for empty content or when the store is unwritable (disk full, read-only) —
 * callers must NOT emit a marker in that case (a marker that points nowhere
 * is a silent drop, not a save).
 */
export function spillContent(projectRoot: string, text: string, opts: { tool?: string } = {}): SpilledRef | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const dir = spillDirPath(projectRoot);
  try {
    mkdirSync(dir, { recursive: true });
    ensureGitignored(dir);
    const stem = spillKeyOf(text).slice('spill-'.length);
    const file = join(dir, `${stem}.txt`);
    if (!existsSync(file)) writeFileSync(file, text, 'utf8');
    return { key: `spill-${stem}`, chars: text.length, tool: opts.tool };
  } catch {
    return null; // caller falls back to its pre-spill behavior
  }
}

function readVerified(dir: string, stem: string): string | null {
  try {
    const text = readFileSync(join(dir, `${stem}.txt`), 'utf8');
    // Content-addressed integrity: a corrupted file resolves to NOTHING,
    // never to wrong evidence.
    if (sha256Hex(text).slice(0, 16) !== stem) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Retrieve spilled content by key. Accepts the canonical `spill-<16hex>`
 * key or a unique prefix of the hash (min 4 chars). Hash-verified; returns
 * null when the key is unknown or the content no longer matches its hash.
 */
export function retrieveSpilled(projectRoot: string, key: string): { key: string; chars: number; text: string } | null {
  const hash = key.trim().toLowerCase().replace(/^spill-/, '');
  if (!/^[0-9a-f]{4,16}$/.test(hash)) return null;
  const dir = spillDirPath(projectRoot);
  if (hash.length === 16) {
    const text = readVerified(dir, hash);
    return text === null ? null : { key: `spill-${hash}`, chars: text.length, text };
  }
  try {
    const stem = readdirSync(dir).find((f) => f.startsWith(hash) && f.endsWith('.txt'))?.replace(/\.txt$/, '');
    if (!stem) return null;
    const text = readVerified(dir, stem);
    return text === null ? null : { key: `spill-${stem}`, chars: text.length, text };
  } catch {
    return null;
  }
}

/** Every spill key referenced in `text`, in first-appearance order, deduped. */
export function scanSpillRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPILL_KEY_RE)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/**
 * The elision marker that replaces an oversized in-context copy. Names the
 * store key and the exact retrieval command — the two things a marker must
 * carry to be resolvable instead of a silent drop.
 */
export function spillMarker(key: string, opts: { tool?: string; chars?: number } = {}): string {
  const what: string[] = [];
  if (typeof opts.chars === 'number') what.push(`${opts.chars.toLocaleString('en-US')} chars of`);
  what.push(opts.tool ? `${opts.tool} output` : 'output');
  return `\n[mochi-spill: ${key} — full ${what.join(' ')} spilled to the local content store; retrieve the COMPLETE text with recall_output key="${key}"]\n`;
}

/** One-line description of a spill key for the re-injection block: chars and
 *  a short preview, so the agent can see WHICH spill it needs before paying
 *  for the full text. Null when the key does not resolve. */
export function describeSpilledRef(projectRoot: string, key: string): string | null {
  const hit = retrieveSpilled(projectRoot, key);
  if (!hit) return null;
  const preview = hit.text.slice(0, 100).replace(/\s+/g, ' ').trim();
  return `${key}: ${hit.chars.toLocaleString('en-US')} chars${preview ? ` — ${preview}…` : ''}`;
}

/** Remove the spill store (tests). */
export function clearSpillStore(projectRoot: string): void {
  try {
    rmSync(spillDirPath(projectRoot), { recursive: true, force: true });
  } catch { /* ignore */ }
}
