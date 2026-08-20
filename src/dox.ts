// DOX cognitive engine (spec section 4): documentation index + ADR generator.
//
// dox.ts indexes local docs (Markdown/TSDoc/Rustdoc/Sphinx-ish) into chunked,
// searchable entries without polluting the model transcript — `dox_query`
// returns ranked hits, and `dox_generate_adr` writes a numbered Architecture
// Decision Record under docs/adr/. Both are pure file operations so they stay
// fast and testable.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

export interface DocChunk {
  file: string;
  title: string;
  text: string;
  path: string;
}

const DOC_EXTS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.mochi', 'coverage', '.jcode']);

/** Walk a docs root and chunk each file into ~2KB windows on paragraph gaps. */
export function indexDocs(root: string, maxChunks = 400): DocChunk[] {
  const chunks: DocChunk[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(e)) walk(full);
        continue;
      }
      const ext = e.slice(e.lastIndexOf('.')).toLowerCase();
      if (!DOC_EXTS.has(ext)) continue;
      let content: string;
      try { content = readFileSync(full, 'utf8'); } catch { continue; }
      if (content.length > 2_000_000) continue;
      const rel = relative(root, full).replace(/\\/g, '/');
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : rel;
      const paragraphs = content.split(/\n\s*\n/);
      let buf = '';
      for (const p of paragraphs) {
        if (buf.length + p.length > 2048 && buf.trim()) {
          chunks.push({ file: rel, title, text: buf.trim(), path: full });
          if (chunks.length >= maxChunks) return;
          buf = '';
        }
        buf += (buf ? '\n\n' : '') + p;
      }
      if (buf.trim()) {
        chunks.push({ file: rel, title, text: buf.trim(), path: full });
        if (chunks.length >= maxChunks) return;
      }
    }
  };
  if (existsSync(root)) walk(root);
  return chunks;
}

/** Ranked doc chunks for a query (substring + word-overlap scoring). */
export function queryDocs(root: string, query: string, limit = 5): DocChunk[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length > 2);
  const scored = indexDocs(root, 500)
    .map((c) => {
      const text = c.text.toLowerCase();
      let score = 0;
      if (text.includes(q)) score += 5;
      for (const t of terms) if (text.includes(t)) score += 1;
      if (c.title.toLowerCase().includes(q)) score += 3;
      return { c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((s) => s.c);
}

export interface AdrInput {
  title: string;
  status?: 'accepted' | 'proposed' | 'superseded' | 'deprecated';
  context: string;
  decision: string;
  tradeoffs?: string[];
  consequences?: string;
}

/** Next ADR number given the docs/adr dir. */
export function nextAdrNumber(adrDir: string): number {
  if (!existsSync(adrDir)) return 1;
  let max = 0;
  for (const f of readdirSync(adrDir)) {
    const m = f.match(/^(\d{3})-.*\.md$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Write docs/adr/NNN-slug.md from structured input. Returns the rel path. */
export function generateAdr(root: string, input: AdrInput): string {
  const adrDir = resolve(root, 'docs', 'adr');
  mkdirSync(adrDir, { recursive: true });
  const n = nextAdrNumber(adrDir);
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const status = input.status ?? 'accepted';
  const filename = `${String(n).padStart(3, '0')}-${slug}.md`;
  const body = [
    `# ${n}. ${input.title}`,
    '',
    `Status: ${status}`,
    '',
    '## Context',
    '',
    input.context,
    '',
    '## Decision',
    '',
    input.decision,
    '',
    ...(input.tradeoffs?.length ? ['## Alternatives considered', '', ...input.tradeoffs.map((t) => `- ${t}`), ''] : []),
    ...(input.consequences?.length ? ['## Consequences', '', input.consequences, ''] : []),
    '---',
  ].join('\n');
  writeFileSync(join(adrDir, filename), body);
  return relative(root, join(adrDir, filename)).replace(/\\/g, '/');
}