// Semantic code index (Wave J) — monorepo-scale hybrid retrieval.
//
// WHY: the repo map (src/repo/repo-map.ts) ranks files by PageRank +
// lexical overlap + call-graph neighbourhood. At monorepo scale that loses
// to Cursor's embeddings index: the right file often shares NO tokens with
// the task text and is not adjacent to any lexical hit. This module adds
// the missing signal — a persistent, incremental, vector index over
// AST-aware chunks — and fuses it with the lexical signal and the repo
// map's task conditioning, the combination Cursor does not have:
//
//   final = RRF(vector cosine, keyword) x (1 + boost x taskRepoMapScore)
//
// STORAGE: SQLite at <root>/.mochi/index/semantic.sqlite (the codegraph's
// own DB is in-memory and per-process; this one must survive restarts).
//   files(rel, hash, size, mtimeMs, chunks)   — per-file content hash
//   chunks(id, rel, symbol, kind, startLine, endLine, text)
//   vectors(hash, embedder, vector BLOB)      — keyed by CHUNK CONTENT hash
// Because vectors are keyed by chunk content (not by file), an unchanged
// file is never re-embedded, a moved/renamed file reuses its vectors, and
// identical chunks across files embed once. Writes are transactional per
// embedding batch and a file is only marked current after its chunks and
// vectors commit — an interrupted build resumes where it stopped.
//
// CHUNKING: AST-aware via the codegraph symbol table (chunks = symbols
// with their bodies, plus one header chunk per file carrying its path,
// symbol names and head). Files the graph has no symbols for (unsupported
// language, parse failure, plain text) fall back to blank-line-delimited
// blocks. Never fixed-window slicing of symbol bodies.
//
// EMBEDDERS: see embeddings.ts. When no provider embedding model is
// configured the index runs on the local LEXICAL-fallback embedder —
// hashed token/trigram vectors. Every surface (meta, stats, tool output,
// context block) labels which embedder built the index; the fallback is
// never presented as semantic.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { openDb, hasSqlite as driverAvailable, type SqliteDb } from '../sqlite.js';
import { warmCodegraph, querySymbolGraphSync } from './codegraph.js';
import { taskRepoMap } from './repo-map.js';
import { tokenize } from '../memory/relevance.js';
import {
  contentHash,
  resolveEmbedder,
  LocalFallbackEmbedder,
  type Embedder,
} from './embeddings.js';
import { PROVIDERS } from '../model/providers.js';
import type { MochiConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Constants (fusion mirrors memory/unified-search.ts: RRF K=60, floors)
// ---------------------------------------------------------------------------

const RRF_K = 60;
const KEYWORD_FLOOR = 0;
const VECTOR_FLOOR = 0.0;
/** RRF vote weight of the vector ranker. A trained provider embedding is
 *  a strong ranker and votes at full weight; the local lexical-fallback
 *  vector is a WEAK ranker (hashed features), so it votes at half weight —
 *  enough to break lexical ties with sub-word evidence, not enough to
 *  outshout an exact lexical match. Mirrors the floor logic in
 *  memory/unified-search.ts, which likewise refuses weak rankers a full
 *  share. */
const VECTOR_WEIGHT_PROVIDER = 1.0;
const VECTOR_WEIGHT_FALLBACK = 0.5;
/** Multiplicative re-rank from the repo map's task conditioning: a file
 *  the conditioned map scores 1.0 gets its fused chunk scores x1.6. */
const CONDITION_BOOST = 0.6;
const MAX_CHUNK_CHARS = 6000;
const HEADER_CHUNK_CHARS = 1500;
const MIN_SYMBOL_BODY_CHARS = 30;
const BLOCK_MAX_LINES = 50;
const MAX_FILE_BYTES = 1_500_000;
const EMBED_BATCH = 96;
/** Above this many vector bytes the corpus is not held in memory; search
 *  restricts the vector stage to lexical pre-filter candidates. */
const VECTOR_MEMORY_CAP_BYTES = 512 * 1024 * 1024;
const RESTRICTED_CANDIDATES = 3000;
export const SEMANTIC_CONTEXT_MAX_CHARS = 1200;

const INDEX_EXTS = new Set([
  '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h',
  '.rb', '.rake', '.php', '.cs', '.md',
]);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.mochi', 'dist', '.next', 'coverage',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'vendor', 'target', '.gradle',
]);

export function semanticIndexEnabled(config?: MochiConfig): boolean {
  if (process.env.MOCHI_SEMANTIC_INDEX === '0') return false;
  if (config?.retrieval?.semanticIndex === false) return false;
  return true;
}

export function semanticIndexDir(root: string): string {
  return resolve(root, '.mochi', 'index');
}

function indexDbPath(root: string): string {
  return resolve(semanticIndexDir(root), 'semantic.sqlite');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SemanticChunk {
  id: string;
  rel: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface IndexStats {
  root: string;
  embedderId: string;
  embedderKind: 'provider' | 'lexical-fallback';
  embedderReason: string;
  filesTotal: number;
  filesUpdated: number;
  filesSkipped: number;
  filesDeleted: number;
  chunksTotal: number;
  chunksEmbedded: number;
  chunksReused: number;
  graphSymbols: boolean;
  complete: boolean;
  elapsedMs: number;
}

export interface IndexStatus {
  exists: boolean;
  embedderId?: string;
  embedderKind?: string;
  dims?: number;
  files?: number;
  chunks?: number;
  builtAt?: number;
  complete?: boolean;
}

export interface SemanticHit {
  rel: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  /** Final score (fused, conditioning applied when requested). */
  score: number;
  fusedScore: number;
  vectorScore: number;
  lexicalScore: number;
  snippet: string;
}

export interface SemanticSearchResult {
  hits: SemanticHit[];
  embedderId: string;
  embedderKind: 'provider' | 'lexical-fallback';
  chunksScanned: number;
  vectorRestricted: boolean;
  conditioned: boolean;
}

// ---------------------------------------------------------------------------
// File walking + chunking
// ---------------------------------------------------------------------------

function walkRepoFiles(root: string, maxFiles: number): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (SKIP_DIRS.has(e)) continue;
      const full = resolve(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (INDEX_EXTS.has(extname(e).toLowerCase()) && st.size <= MAX_FILE_BYTES) out.push(full);
    }
  };
  walk(root);
  return out;
}

interface GraphSymbol { name: string; kind: string; line: number; body: string }

/** All codegraph symbols for the repo, grouped by normalized rel path.
 *  Empty map when the graph is unavailable/cold. */
function loadGraphSymbols(root: string): Map<string, GraphSymbol[]> {
  const byRel = new Map<string, GraphSymbol[]>();
  try {
    const q = querySymbolGraphSync(
      root,
      'SELECT name, kind, rel, line, body FROM symbols',
      400000,
    );
    if (!q || !('rows' in q)) return byRel;
    for (const r of q.rows as Array<{ name: string; kind: string; rel: string; line: number; body: string }>) {
      const rel = (r.rel ?? '').replace(/^\.\//, '');
      if (!rel || !r.name) continue;
      let arr = byRel.get(rel);
      if (!arr) { arr = []; byRel.set(rel, arr); }
      arr.push({ name: r.name, kind: r.kind ?? '', line: r.line ?? 1, body: r.body ?? '' });
    }
  } catch { /* graph unavailable — block chunking covers every file */ }
  return byRel;
}

/** Blank-line-delimited blocks of at most BLOCK_MAX_LINES lines. */
function blockChunks(rel: string, content: string): SemanticChunk[] {
  const lines = content.split('\n');
  const chunks: SemanticChunk[] = [];
  let start = 0;
  const flush = (end: number) => {
    const text = lines.slice(start, end).join('\n').trim();
    if (text.length < 20) return;
    const embedText = `${rel}\n${text}`.slice(0, MAX_CHUNK_CHARS);
    chunks.push({
      id: contentHash(embedText),
      rel, symbol: '', kind: 'block',
      startLine: start + 1, endLine: end,
      text: embedText,
    });
  };
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '' && i - start >= 5) { flush(i); start = i + 1; i++; continue; }
    if (i - start >= BLOCK_MAX_LINES) { flush(i); start = i; continue; }
    i++;
  }
  flush(lines.length);
  return chunks;
}

function chunkFile(rel: string, content: string, symbols: GraphSymbol[] | undefined): SemanticChunk[] {
  const usable = (symbols ?? []).filter((s) => (s.body ?? '').trim().length >= MIN_SYMBOL_BODY_CHARS);
  if (usable.length === 0) return blockChunks(rel, content);
  const chunks: SemanticChunk[] = [];
  // Header chunk: file path + every symbol name + the file head. Carries
  // the file-level "what lives here" signal symbol bodies alone miss.
  const names = [...new Set((symbols ?? []).map((s) => s.name))].slice(0, 60).join(', ');
  const head = content.split('\n').slice(0, 25).join('\n');
  const headerText = `${rel}\nsymbols: ${names}\n${head}`.slice(0, HEADER_CHUNK_CHARS);
  chunks.push({
    id: contentHash(headerText),
    rel, symbol: '', kind: 'file',
    startLine: 1, endLine: Math.min(25, content.split('\n').length),
    text: headerText,
  });
  const seen = new Set<string>();
  for (const s of usable) {
    const key = `${s.name}@${s.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bodyLines = s.body.split('\n').length;
    const embedText = `${rel}\n${s.kind} ${s.name}\n${s.body}`.slice(0, MAX_CHUNK_CHARS);
    chunks.push({
      id: contentHash(embedText),
      rel, symbol: s.name, kind: s.kind || 'symbol',
      startLine: s.line, endLine: s.line + bodyLines - 1,
      text: embedText,
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function openIndexDb(root: string, create: boolean): SqliteDb | null {
  if (!driverAvailable()) return null;
  const path = indexDbPath(root);
  if (!create && !existsSync(path)) return null;
  try {
    if (create) mkdirSync(semanticIndexDir(root), { recursive: true });
    const db = openDb(path);
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('PRAGMA busy_timeout=5000;');
    db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS files(rel TEXT PRIMARY KEY, hash TEXT, size INTEGER, mtime_ms REAL, chunks INTEGER);
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, rel TEXT, symbol TEXT, kind TEXT, start_line INTEGER, end_line INTEGER, text TEXT);
      CREATE INDEX IF NOT EXISTS idx_chunks_rel ON chunks(rel);
      CREATE TABLE IF NOT EXISTS vectors(hash TEXT, embedder TEXT, vector BLOB, PRIMARY KEY(hash, embedder));`);
    return db;
  } catch {
    return null;
  }
}

function metaGet(db: SqliteDb, key: string): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value?: string } | undefined;
    return row?.value;
  } catch { return undefined; }
}

function metaSet(db: SqliteDb, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

export function indexStatus(root: string): IndexStatus {
  const db = openIndexDb(root, false);
  if (!db) return { exists: existsSync(indexDbPath(root)) };
  try {
    const files = db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number };
    const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    return {
      exists: true,
      embedderId: metaGet(db, 'embedderId'),
      embedderKind: metaGet(db, 'embedderKind'),
      dims: Number(metaGet(db, 'dims') ?? 0) || undefined,
      files: files.n,
      chunks: chunks.n,
      builtAt: Number(metaGet(db, 'builtAt') ?? 0) || undefined,
      complete: metaGet(db, 'complete') === '1',
    };
  } catch {
    return { exists: true };
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Embedder reconstruction for an existing index
// ---------------------------------------------------------------------------

/** The embedder that built the index at `root`, reconstructed from meta.
 *  Search must embed queries with the SAME embedder that embedded the
 *  chunks; a config change since build time must not silently mix vector
 *  spaces. Returns null when the recorded embedder can no longer be
 *  constructed (provider key gone) — lexical ranking still works. */
export function embedderForIndex(root: string, config?: MochiConfig): Embedder | null {
  const db = openIndexDb(root, false);
  if (!db) return null;
  let id: string | undefined;
  try { id = metaGet(db, 'embedderId'); } finally { try { db.close(); } catch { /* noop */ } }
  if (!id) return null;
  if (id === new LocalFallbackEmbedder().id) return new LocalFallbackEmbedder();
  const resolved = resolveEmbedder(config);
  if (resolved.embedder.id === id) return resolved.embedder;
  const sep = id.indexOf(':');
  if (sep > 0) {
    const provider = PROVIDERS.find((p) => p.id === id.slice(0, sep));
    const model = id.slice(sep + 1);
    if (provider && provider.kind === 'openai') {
      // Rebuild the recorded provider embedder explicitly (key via the
      // standard resolution path inside resolveEmbedder's provider).
      const r2 = resolveEmbedder({
        ...(config ?? ({} as MochiConfig)),
        retrieval: { embeddingProvider: provider.id, embeddingModel: model },
        model: config?.model,
      } as MochiConfig);
      if (r2.embedder.id === id) return r2.embedder;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build / update (incremental, resumable)
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<IndexStats | null>>();

export function ensureSemanticIndex(
  root: string,
  opts: { config?: MochiConfig; embedder?: Embedder; maxFiles?: number } = {},
): Promise<IndexStats | null> {
  const key = resolve(root);
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = buildIndex(key, opts).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

async function buildIndex(
  root: string,
  opts: { config?: MochiConfig; embedder?: Embedder; maxFiles?: number },
): Promise<IndexStats | null> {
  if (!semanticIndexEnabled(opts.config)) return null;
  const started = Date.now();
  const resolution = opts.embedder
    ? { embedder: opts.embedder, reason: 'explicit embedder (caller-supplied)' }
    : resolveEmbedder(opts.config);
  const embedder = resolution.embedder;
  const db = openIndexDb(root, true);
  if (!db) return null;

  const stats: IndexStats = {
    root,
    embedderId: embedder.id,
    embedderKind: embedder.kind,
    embedderReason: resolution.reason,
    filesTotal: 0, filesUpdated: 0, filesSkipped: 0, filesDeleted: 0,
    chunksTotal: 0, chunksEmbedded: 0, chunksReused: 0,
    graphSymbols: false, complete: false, elapsedMs: 0,
  };

  try {
    // Embedder switch: stored vectors belong to the PREVIOUS embedder and
    // are invisible to this one, so the (size, mtime)/hash fast-paths —
    // which would skip every unchanged file and never notice the missing
    // vectors — are disabled for this pass. Every file re-chunks and any
    // chunk lacking a vector for THIS embedder is embedded in phase 2.
    const prevEmbedder = metaGet(db, 'embedderId');
    const embedderSwitched = prevEmbedder !== undefined && prevEmbedder !== embedder.id;
    metaSet(db, 'complete', '0');
    metaSet(db, 'embedderId', embedder.id);
    metaSet(db, 'embedderKind', embedder.kind);

    // AST symbols for chunking (best-effort: block chunking covers misses).
    await warmCodegraph(root).catch(() => undefined);
    const symbols = loadGraphSymbols(root);
    stats.graphSymbols = symbols.size > 0;

    const maxFiles = opts.maxFiles ?? (Number(process.env.MOCHI_SEMANTIC_WALK_MAX) || 20000);
    const walked = walkRepoFiles(root, maxFiles);
    const stored = new Map<string, { hash: string; size: number; mtimeMs: number }>();
    for (const r of db.prepare('SELECT rel, hash, size, mtime_ms FROM files').all() as Array<{ rel: string; hash: string; size: number; mtime_ms: number }>) {
      stored.set(r.rel, { hash: r.hash, size: r.size, mtimeMs: r.mtime_ms });
    }

    const seen = new Set<string>();
    const haveVector = db.prepare('SELECT 1 AS x FROM vectors WHERE hash=? AND embedder=?');
    const insChunk = db.prepare(
      'INSERT INTO chunks(id, rel, symbol, kind, start_line, end_line, text) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET rel=excluded.rel, symbol=excluded.symbol, kind=excluded.kind, start_line=excluded.start_line, end_line=excluded.end_line, text=excluded.text',
    );
    const delChunks = db.prepare('DELETE FROM chunks WHERE rel=?');
    const upFile = db.prepare(
      'INSERT INTO files(rel, hash, size, mtime_ms, chunks) VALUES(?, ?, ?, ?, ?) ON CONFLICT(rel) DO UPDATE SET hash=excluded.hash, size=excluded.size, mtime_ms=excluded.mtime_ms, chunks=excluded.chunks',
    );

    // Phase 1 — diff the walk against the stored hashes and chunk the
    // dirty files. Nothing is written yet, so a crash here changes nothing.
    interface DirtyFile { rel: string; hash: string; size: number; mtimeMs: number; chunks: SemanticChunk[] }
    const dirty: DirtyFile[] = [];
    const freshChunks: SemanticChunk[] = [];
    const queuedFresh = new Set<string>();
    for (const abs of walked) {
      const rel = relative(root, abs).replace(/\\/g, '/');
      seen.add(rel);
      stats.filesTotal++;
      let st;
      try { st = statSync(abs); } catch { continue; }
      const prev = stored.get(rel);
      if (!embedderSwitched && prev && prev.size === st.size && Math.abs(prev.mtimeMs - st.mtimeMs) < 0.001) {
        stats.filesSkipped++;
        continue;
      }
      let content: string;
      try { content = readFileSync(abs, 'utf8'); } catch { continue; }
      const hash = contentHash(content);
      if (!embedderSwitched && prev && prev.hash === hash) {
        upFile.run(rel, hash, st.size, st.mtimeMs, countChunks(db, rel));
        stats.filesSkipped++;
        continue;
      }
      const chunks = chunkFile(rel, content, symbols.get(rel));
      for (const c of chunks) {
        if (queuedFresh.has(c.id) || haveVector.get(c.id, embedder.id)) stats.chunksReused++;
        else { queuedFresh.add(c.id); freshChunks.push(c); }
      }
      dirty.push({ rel, hash, size: st.size, mtimeMs: st.mtimeMs, chunks });
    }

    // Phase 2 — embed every fresh chunk in batches, one transaction per
    // batch. Vectors are content-keyed and INSERT OR IGNORE, so a crash
    // here leaves harmless orphans the next run reuses; no file is marked
    // current yet, so nothing can point at a missing vector.
    for (let i = 0; i < freshChunks.length; i += EMBED_BATCH) {
      const batch = freshChunks.slice(i, i + EMBED_BATCH);
      const vecs = await embedder.embed(batch.map((c) => c.text));
      if (embedder.dims > 0) metaSet(db, 'dims', String(embedder.dims));
      db.exec('BEGIN');
      try {
        const insVec = db.prepare('INSERT OR IGNORE INTO vectors(hash, embedder, vector) VALUES(?, ?, ?)');
        for (let j = 0; j < batch.length; j++) insVec.run(batch[j].id, embedder.id, blobOf(vecs[j]));
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* noop */ }
        throw e;
      }
      stats.chunksEmbedded += batch.length;
    }

    // Phase 3 — write chunk rows + file rows, one transaction per file so
    // a file's chunks and its freshness marker commit atomically.
    for (const d of dirty) {
      db.exec('BEGIN');
      try {
        delChunks.run(d.rel);
        for (const c of d.chunks) insChunk.run(c.id, c.rel, c.symbol, c.kind, c.startLine, c.endLine, c.text);
        upFile.run(d.rel, d.hash, d.size, d.mtimeMs, d.chunks.length);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* noop */ }
        throw e;
      }
      stats.filesUpdated++;
    }

    // Files that vanished from disk.
    const delFile = db.prepare('DELETE FROM files WHERE rel=?');
    for (const rel of Array.from(stored.keys())) {
      if (seen.has(rel)) continue;
      db.exec('BEGIN');
      try {
        delChunks.run(rel);
        delFile.run(rel);
        db.exec('COMMIT');
      } catch { try { db.exec('ROLLBACK'); } catch { /* noop */ } }
      stats.filesDeleted++;
    }

    const total = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    stats.chunksTotal = total.n;
    metaSet(db, 'complete', '1');
    metaSet(db, 'builtAt', String(Date.now()));
    stats.complete = true;
  } finally {
    stats.elapsedMs = Date.now() - started;
    // Fold the WAL back into the main file before closing so the index
    // is a single self-contained file for the next process (a leftover
    // -wal/-shm pair is fragile on space-constrained tmpfs mounts).
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* best effort */ }
    try { db.close(); } catch { /* noop */ }
  }
  return stats;
}

function countChunks(db: SqliteDb, rel: string): number {
  const row = db.prepare('SELECT chunks FROM files WHERE rel=?').get(rel) as { chunks: number } | undefined;
  return row?.chunks ?? 0;
}

function blobOf(vec: Float32Array): Buffer {
  const u8 = new Uint8Array(vec.byteLength);
  u8.set(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
  return Buffer.from(u8);
}

function vectorOf(blob: unknown): Float32Array | null {
  if (!blob) return null;
  const u8 = blob as Uint8Array;
  if (u8.byteLength === 0 || u8.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
}

// ---------------------------------------------------------------------------
// Search — vector ⊕ lexical RRF, repo-map conditioning re-rank
// ---------------------------------------------------------------------------

interface LoadedChunk extends SemanticChunk {
  /** Precomputed token sets so per-query lexical scoring is set lookups,
   *  not a re-tokenization of every chunk (12k chunks x ~1KB per query
   *  measured ~800ms; with sets it is ~10ms). */
  titleTokens: Set<string>;
  textTokens: Set<string>;
}

/** scoreEntry-equivalent lexical score (memory/relevance.ts): 0.6/0.4
 *  title/body query-token overlap, rounded to 2dp — computed over
 *  precomputed token sets with identical semantics (set membership is
 *  all tokenOverlap ever tests). */
function lexicalScoreOf(queryTokens: Set<string>, chunk: LoadedChunk): number {
  if (queryTokens.size === 0) return 0;
  let titleHits = 0;
  let bodyHits = 0;
  for (const t of Array.from(queryTokens)) {
    if (chunk.titleTokens.has(t)) titleHits++;
    if (chunk.textTokens.has(t)) bodyHits++;
  }
  const score = 0.6 * (titleHits / queryTokens.size) + 0.4 * (bodyHits / queryTokens.size);
  return Math.round(score * 100) / 100;
}

interface Corpus {
  embedderId: string;
  builtAt: number;
  chunks: LoadedChunk[];
  vectorRestricted: boolean;
  dims: number;
  /** All chunk vectors in ONE contiguous matrix (row i = chunk i) with
   *  per-row norms: the per-query cosine pass is a single flat loop,
   *  ~4x faster than per-chunk array hops. Null when restricted (vectors
   *  are then loaded per-query for lexical front-runners only) or when
   *  the index has no vectors for the current embedder. */
  matrix: Float32Array | null;
  rowNorms: Float32Array | null;
}

const corpusCache = new Map<string, Corpus>();

function loadCorpus(root: string, embedder: Embedder | null): Corpus | null {
  const cached = corpusCache.get(root);
  const status = indexStatus(root);
  if (!status.exists) return null;
  if (!status.embedderId) {
    // Degraded read (e.g. transient SQLite I/O error on a loaded box):
    // a warm corpus keeps serving rather than every search collapsing
    // to null until the disk recovers.
    return cached ?? null;
  }
  if (cached && cached.builtAt === (status.builtAt ?? 0) && cached.embedderId === status.embedderId) {
    return cached;
  }
  const db = openIndexDb(root, false);
  if (!db) return null;
  try {
    const dims = status.dims ?? 0;
    const countRow = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    const restricted = dims > 0 && countRow.n * dims * 4 > VECTOR_MEMORY_CAP_BYTES;
    const rows = db.prepare(
      `SELECT c.id, c.rel, c.symbol, c.kind, c.start_line, c.end_line, c.text, v.vector
       FROM chunks c LEFT JOIN vectors v ON v.hash = c.id AND v.embedder = ?`,
    ).all(embedder?.id ?? status.embedderId) as Array<{
      id: string; rel: string; symbol: string; kind: string;
      start_line: number; end_line: number; text: string; vector: unknown;
    }>;
    const chunks: LoadedChunk[] = rows.map((r) => ({
      id: r.id, rel: r.rel, symbol: r.symbol, kind: r.kind,
      startLine: r.start_line, endLine: r.end_line, text: r.text,
      titleTokens: new Set(tokenize(r.symbol || r.rel)),
      textTokens: new Set(tokenize(r.text)),
    }));
    let matrix: Float32Array | null = null;
    let rowNorms: Float32Array | null = null;
    if (!restricted && embedder) {
      const vecs = rows.map((r) => (r.vector ? vectorOf(r.vector) : null));
      const d = vecs.find((v) => v && v.length > 0)?.length ?? 0;
      if (d > 0) {
        matrix = new Float32Array(rows.length * d);
        rowNorms = new Float32Array(rows.length);
        for (let i = 0; i < rows.length; i++) {
          const v = vecs[i];
          if (!v || v.length !== d) continue;
          matrix.set(v, i * d);
          let n = 0;
          for (let j = 0; j < d; j++) n += v[j] * v[j];
          rowNorms[i] = Math.sqrt(n);
        }
      }
    }
    const corpus: Corpus = {
      embedderId: status.embedderId,
      builtAt: status.builtAt ?? 0,
      chunks,
      vectorRestricted: restricted,
      dims,
      matrix,
      rowNorms,
    };
    corpusCache.set(root, corpus);
    return corpus;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}

/** Load vectors for a restricted candidate set (oversized-corpus path). */
function loadVectorsFor(root: string, embedderId: string, ids: string[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  const db = openIndexDb(root, false);
  if (!db) return out;
  try {
    const stmt = db.prepare('SELECT vector FROM vectors WHERE hash=? AND embedder=?');
    for (const id of ids) {
      const row = stmt.get(id, embedderId) as { vector: unknown } | undefined;
      const v = row ? vectorOf(row.vector) : null;
      if (v) out.set(id, v);
    }
  } catch { /* vectors stay absent — lexical ranking still serves */ }
  finally { try { db.close(); } catch { /* noop */ } }
  return out;
}

function rankPositions(scores: number[]): Map<number, number> {
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => (b.s - a.s) || (a.i - b.i));
  const ranks = new Map<number, number>();
  order.forEach((o, pos) => ranks.set(o.i, pos + 1));
  return ranks;
}

function cosine(query: Float32Array, queryNorm: number, v: Float32Array, vNorm: number): number {
  if (queryNorm === 0 || vNorm === 0 || query.length !== v.length) return 0;
  let dot = 0;
  const n = Math.min(query.length, v.length);
  for (let i = 0; i < n; i++) dot += query[i] * v[i];
  return dot / (queryNorm * vNorm);
}

export interface SemanticSearchOptions {
  limit?: number;
  config?: MochiConfig;
  /** Embedder to embed the query with. Defaults to the index's own
   *  embedder (embedderForIndex) — pass explicitly in tests/benches. */
  embedder?: Embedder | null;
  /** Normalized (0..1) per-file task-conditioning scores, e.g. from
   *  taskRepoMap. When present, fused scores are re-ranked by file. */
  taskScores?: Map<string, number>;
}

/**
 * Hybrid search over the index at `root`. Returns null when no index
 * exists. The vector ranker uses the index's recorded embedder; when that
 * embedder can no longer be constructed, ranking degrades to lexical-only
 * (vectorScore 0) rather than mixing vector spaces.
 */
export async function semanticSearch(
  root: string,
  query: string,
  opts: SemanticSearchOptions = {},
): Promise<SemanticSearchResult | null> {
  const absRoot = resolve(root);
  const status = indexStatus(absRoot);
  if (!status.exists) return null;
  const embedder = opts.embedder !== undefined ? opts.embedder : embedderForIndex(absRoot, opts.config);
  const corpus = loadCorpus(absRoot, embedder);
  if (!corpus || corpus.chunks.length === 0) return null;
  const chunks = corpus.chunks;
  const usableEmbedder = embedder && embedder.id === corpus.embedderId ? embedder : null;

  // Lexical scores over every chunk (scoreEntry semantics over the
  // precomputed token sets: the memory keyword ranker).
  const queryTokens = new Set(tokenize(query));
  const lexicalScores = chunks.map((c) => lexicalScoreOf(queryTokens, c));

  // Vector scores. Restricted corpora score vectors only for the lexical
  // front-runners; everyone else keeps vectorScore 0 for this query.
  const vectorScores = new Array<number>(chunks.length).fill(0);
  let queryVec: Float32Array | null = null;
  let queryNorm = 0;
  if (usableEmbedder) {
    if (usableEmbedder instanceof LocalFallbackEmbedder) {
      queryVec = usableEmbedder.embedSync(query);
    } else {
      [queryVec] = await usableEmbedder.embed([query]);
    }
    if (queryVec) { for (let i = 0; i < queryVec.length; i++) queryNorm += queryVec[i] * queryVec[i]; queryNorm = Math.sqrt(queryNorm); }
  }
  if (queryVec && queryNorm > 0) {
    if (!corpus.vectorRestricted) {
      const matrix = corpus.matrix;
      const rowNorms = corpus.rowNorms;
      if (matrix && rowNorms && matrix.length > 0) {
        const d = matrix.length / chunks.length;
        if (queryVec.length === d) {
          // Single flat pass over the contiguous matrix.
          for (let i = 0; i < chunks.length; i++) {
            const rn = rowNorms[i];
            if (rn === 0) continue;
            const base = i * d;
            let dot = 0;
            for (let j = 0; j < d; j++) dot += queryVec[j] * matrix[base + j];
            vectorScores[i] = dot / (queryNorm * rn);
          }
        }
      }
    } else {
      const byLexical = chunks.map((_, i) => i).sort((a, b) => lexicalScores[b] - lexicalScores[a]);
      const candidateIdx = byLexical.slice(0, RESTRICTED_CANDIDATES).filter((i) => lexicalScores[i] > 0);
      const vectors = loadVectorsFor(absRoot, corpus.embedderId, candidateIdx.map((i) => chunks[i].id));
      for (const i of candidateIdx) {
        const v = vectors.get(chunks[i].id);
        if (!v) continue;
        let n = 0;
        for (let j = 0; j < v.length; j++) n += v[j] * v[j];
        vectorScores[i] = cosine(queryVec, queryNorm, v, Math.sqrt(n));
      }
    }
  }

  const lexRanks = rankPositions(lexicalScores);
  const vecRanks = rankPositions(vectorScores);
  const hasVectorSignal = vectorScores.some((s) => s > VECTOR_FLOOR);
  const vectorWeight = status.embedderKind === 'provider'
    ? VECTOR_WEIGHT_PROVIDER
    : VECTOR_WEIGHT_FALLBACK;
  const taskScores = opts.taskScores;
  // Score in flat arrays first; SemanticHit objects (with snippet
  // rendering) are materialized only for the selected front-runners —
  // building 12k hit objects per query dominated latency.
  const fusedScores = new Array<number>(chunks.length).fill(0);
  const finalScores = new Array<number>(chunks.length).fill(0);
  for (let i = 0; i < chunks.length; i++) {
    let fused = 0;
    if (lexicalScores[i] > KEYWORD_FLOOR) fused += 1 / (RRF_K + (lexRanks.get(i) ?? chunks.length));
    if (hasVectorSignal && vectorScores[i] > VECTOR_FLOOR) fused += vectorWeight / (RRF_K + (vecRanks.get(i) ?? chunks.length));
    fusedScores[i] = fused;
    finalScores[i] = taskScores ? fused * (1 + CONDITION_BOOST * (taskScores.get(chunks[i].rel) ?? 0)) : fused;
  }

  const limit = opts.limit ?? 20;
  const order = chunks
    .map((_, i) => i)
    .filter((i) => fusedScores[i] > 0)
    .sort((a, b) => (finalScores[b] - finalScores[a]) || (fusedScores[b] - fusedScores[a]) || (a - b))
    .slice(0, limit);
  const top: SemanticHit[] = order.map((i) => {
    const c = chunks[i];
    return {
      rel: c.rel, symbol: c.symbol, kind: c.kind,
      startLine: c.startLine, endLine: c.endLine,
      score: finalScores[i], fusedScore: fusedScores[i],
      vectorScore: Math.round(vectorScores[i] * 1000) / 1000,
      lexicalScore: lexicalScores[i],
      snippet: c.text.replace(/\s+/g, ' ').slice(0, 200),
    };
  });
  // Note: `limit` is the CHUNK budget. Aggregation consumers
  // (aggregateHitsToFiles) pass an inflated limit (e.g. limit*4) so file
  // scores can draw on more than the display count of chunks.

  return {
    hits: top,
    embedderId: corpus.embedderId,
    embedderKind: (status.embedderKind as 'provider' | 'lexical-fallback') ?? 'lexical-fallback',
    chunksScanned: chunks.length,
    vectorRestricted: corpus.vectorRestricted,
    conditioned: !!taskScores,
  };
}

export interface FileHit {
  rel: string;
  /** Aggregated file score: best chunk + 0.25 x the rest of the file's
   *  chunk scores. A file whose evidence is spread across several chunks
   *  (header + two symbols) must be able to beat a one-chunk decoy — pure
   *  best-chunk ranking systematically under-ranks exactly the files a
   *  concept lives in. */
  fileScore: number;
  best: SemanticHit;
  chunkCount: number;
}

/** Aggregate chunk hits to a file ranking. Shared by the tool, the context
 *  packet and the benchmark so every surface ranks files the same way. */
export function aggregateHitsToFiles(hits: SemanticHit[], limit = 10): FileHit[] {
  const byFile = new Map<string, SemanticHit[]>();
  for (const h of hits) {
    let arr = byFile.get(h.rel);
    if (!arr) { arr = []; byFile.set(h.rel, arr); }
    arr.push(h);
  }
  const files: FileHit[] = Array.from(byFile.entries()).map(([rel, hs]) => {
    const sorted = [...hs].sort((a, b) => b.score - a.score);
    const rest = sorted.slice(1).reduce((a, h) => a + h.score, 0);
    return { rel, fileScore: sorted[0].score + 0.25 * rest, best: sorted[0], chunkCount: hs.length };
  });
  files.sort((a, b) => (b.fileScore - a.fileScore) || (a.rel < b.rel ? -1 : 1));
  return files.slice(0, limit);
}

/** Task-conditioned search: the query IS the task text, and the repo map's
 *  conditioned file scores re-rank the fused chunk hits — the combination
 *  (vectors + lexical + structural conditioning) Cursor's index lacks. */
export async function semanticSearchForTask(
  root: string,
  taskText: string,
  opts: SemanticSearchOptions & { kind?: string } = {},
): Promise<SemanticSearchResult | null> {
  let taskScores: Map<string, number> | undefined;
  try {
    const entries = taskRepoMap(resolve(root), { task: taskText, kind: opts.kind, topK: 40 });
    // Grounding gate: conditioning amplifies the map's opinion — when the
    // map has NO lexical grounding for this task, its ranking is PageRank
    // noise and amplifying it demotes genuinely-matching chunks (measured
    // on the fixture: retry-paraphrase recall 0.50 unconditioned vs 0.33
    // conditioned when the gate sat at 0.2 — a single generic token like
    // 'call' in symbol names produced false grounding at exactly 0.20;
    // a third of the query's terms must match somewhere to count).
    const grounded = entries.some((e) => e.lexical >= 0.34);
    if (entries.length > 0 && grounded) {
      taskScores = new Map(entries.map((e) => [e.file, e.score]));
    }
  } catch { /* conditioning is an enhancement, never a requirement */ }
  return semanticSearch(root, taskText, { ...opts, taskScores: taskScores ?? opts.taskScores });
}

// ---------------------------------------------------------------------------
// Context-packet rendering (loop wiring)
// ---------------------------------------------------------------------------

/**
 * Render the semantic-matches block for the agent's opening packet.
 * Best-effort by contract: returns undefined when the index is missing,
 * disabled, empty, or too slow (> timeoutMs — provider query embeddings
 * are a network call), and kicks off a background refresh so the NEXT
 * task start sees fresh vectors. Never throws.
 */
export async function semanticContextText(
  root: string,
  taskText: string,
  opts: { config?: MochiConfig; maxChars?: number; timeoutMs?: number } = {},
): Promise<string | undefined> {
  if (!semanticIndexEnabled(opts.config)) return undefined;
  const absRoot = resolve(root);
  const status = indexStatus(absRoot);
  if (!status.exists) {
    // Cold start: build in the background; this task runs without it.
    void ensureSemanticIndex(absRoot, { config: opts.config }).catch(() => undefined);
    return undefined;
  }
  const timeoutMs = opts.timeoutMs ?? 2500;
  const work = (async () => {
    const result = await semanticSearchForTask(absRoot, taskText, { config: opts.config, limit: 40 });
    if (!result || result.hits.length === 0) return undefined;
    // One line per FILE (aggregated over its chunks) — the packet points
    // at files, the model reads what it needs.
    const fileHits = aggregateHitsToFiles(result.hits, 8);
    const label = result.embedderKind === 'provider'
      ? `embedder: ${result.embedderId}`
      : `embedder: ${result.embedderId} [lexical-fallback — local hashed vectors, not true semantic embeddings]`;
    const header = `SEMANTIC MATCHES (hybrid vector+lexical retrieval over the persistent code index, re-ranked by task conditioning — conceptually closest code to THIS task; ${label}):`;
    const maxChars = opts.maxChars ?? SEMANTIC_CONTEXT_MAX_CHARS;
    const lines = [header];
    let used = header.length;
    for (const f of fileHits) {
      const h = f.best;
      const where = h.symbol ? `${h.rel}:${h.startLine} \`${h.symbol}\`` : h.rel;
      const line = `- ${where} (${f.fileScore.toFixed(3)})`;
      if (used + 1 + line.length > maxChars) break;
      lines.push(line);
      used += 1 + line.length;
    }
    return lines.length > 1 ? lines.join('\n') : undefined;
  })();
  const timeout = new Promise<undefined>((res) => setTimeout(() => res(undefined), timeoutMs));
  return Promise.race([work, timeout]).catch(() => undefined);
}
