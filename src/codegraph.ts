import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import ts from 'typescript';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { mutationGeneration } from './tools/fs-signal.js';

// Keep Node's "SQLite is experimental" noise out of the TUI.
process.removeAllListeners?.('warning');

const makeDb = (): typeof DatabaseSync => {
  const req = createRequire(import.meta.url);
  return req('node:sqlite').DatabaseSync as typeof DatabaseSync;
};
const DatabaseSyncType = makeDb;

/** True when this runtime has node:sqlite (Node >= 22.5). On older runtimes
 *  the codegraph degrades to "no symbol index" instead of throwing. */
export function hasSqlite(): boolean {
  try {
    DatabaseSyncType();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Polyglot file coverage. The index understands the languages a real agent
// actually sees: JS/TS plus the major backend systems languages. The tree-
// sitter WASM backend is the DEFAULT (fast, in-process, no full compiler);
// the TypeScript-compiler backend covers .ts/.js only when explicitly chosen
// (MOCHI_CPG_BACKEND=tsc) or when tree-sitter is unavailable.
// ---------------------------------------------------------------------------
export const LANGUAGES = ['typescript', 'javascript', 'python', 'rust', 'go', 'java', 'cpp'] as const;
export type LanguageId = (typeof LANGUAGES)[number];

const EXT_LANG: Record<string, LanguageId> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.h': 'cpp',
};

const langOf = (file: string): LanguageId | undefined => {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? undefined : EXT_LANG[file.slice(dot)];
};

// Directories to skip when walking a tree, keyed by the language they
// belong to. The old list only understood JS build dirs (node_modules,
// dist, .next), so indexing a Python repo could walk .venv and __pycache__,
// a Go repo walked vendor/, and a Rust repo walked target/ -- slow and
// noisy. Each prefix is skipped wherever it appears in the tree.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.mochi', 'dist', '.next', 'coverage',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'vendor', 'target', '.gradle',
]);

function* walkFiles(root: string, dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const full = resolve(dir, e);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walkFiles(root, full);
    else if (langOf(full) && st.size < 1_500_000) yield full;
  }
}

// ---------------------------- tsc backend ----------------------------------
const scriptKind = (f: string): ts.ScriptKind =>
  f.endsWith('.tsx') ? ts.ScriptKind.TSX : f.endsWith('.jsx') ? ts.ScriptKind.JSX
    : f.endsWith('.js') || f.endsWith('.mjs') ? ts.ScriptKind.JS
      : f.endsWith('.mts') ? ts.ScriptKind.TS : ts.ScriptKind.TS;

function heritage(node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration): string[] {
  if (!node.heritageClauses) return [];
  const out: string[] = [];
  for (const hc of node.heritageClauses) {
    for (const t of hc.types) {
      const expr = t.expression;
      if (ts.isIdentifier(expr)) out.push(expr.text);
      else if (ts.isPropertyAccessExpression(expr)) out.push(expr.name.text);
    }
  }
  return out;
}

function indexFile(file: string, rel: string, database: DatabaseSync): void {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const lineOf = (p: number) => sf.getLineAndCharacterOfPosition(p).line + 1;
  const ins = database.prepare('INSERT INTO symbols(name,line,kind,file,rel,body) VALUES (?,?,?,?,?,?)');
  const relIns = database.prepare('INSERT INTO relations(src,dst,kind,file) VALUES (?,?,?,?)');
  const emit = (name: string, kind: string, start: number, body: string) => {
    if (!name) return;
    ins.run(name, lineOf(start), kind, file, rel, body.slice(0, 3000));
  };

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name) {
      emit(node.name.text, 'function', node.getStart(), node.getText(sf));
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      (node.initializer.kind === ts.SyntaxKind.ArrowFunction || node.initializer.kind === ts.SyntaxKind.FunctionExpression)) {
      emit(node.name.text, 'function', node.getStart(), node.getText(sf));
    } else if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      emit(name, 'class', node.getStart(), node.getText(sf));
      for (const h of heritage(node)) { try { relIns.run(name, h, 'extends', rel); } catch {} }
      for (const m of node.members) {
        if ((ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && ts.isIdentifier(m.name)) {
          emit(m.name.text, 'method', m.name.getStart(sf), m.getText(sf));
        }
      }
    } else if (ts.isInterfaceDeclaration(node) && node.name) {
      const name = node.name.text;
      emit(name, 'interface', node.getStart(), node.getText(sf));
      for (const h of heritage(node)) { try { relIns.run(name, h, 'extends', rel); } catch {} }
    } else if (ts.isTypeAliasDeclaration(node) && node.name) {
      emit(node.name.text, 'type', node.getStart(), node.getText(sf));
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

// ---------------------------------------------------------------------------
// Tree-sitter backend (default). web-tree-sitter is WASM: fast, no native
// compile steps, and the SAME engine indexes every language. Grammars are
// loaded once, eagerly, behind a promise (the sync indexer never awaits).
// ---------------------------------------------------------------------------
export type ParserBackend = 'tsc' | 'tree-sitter';

let _Parser: any = null;              // web-tree-sitter Parser class (post-init)
const _languages = new Map<LanguageId, any>(); // LanguageId -> Parser.Language
let _tsInitError = '';
let _tsReady = false;

// Grammar -> npm package / wasm filename. Package names match the npm
// tree-sitter-<lang> WASM distributions.
const GRAMMAR_SPECS: Record<string, { pkg: string; file: string }> = {
  typescript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  javascript: { pkg: 'tree-sitter-javascript', file: 'tree-sitter-javascript.wasm' },
  python: { pkg: 'tree-sitter-python', file: 'tree-sitter-python.wasm' },
  rust: { pkg: 'tree-sitter-rust', file: 'tree-sitter-rust.wasm' },
  go: { pkg: 'tree-sitter-go', file: 'tree-sitter-go.wasm' },
  java: { pkg: 'tree-sitter-java', file: 'tree-sitter-java.wasm' },
  cpp: { pkg: 'tree-sitter-cpp', file: 'tree-sitter-cpp.wasm' },
};

// Declarator node types per grammar, mapped to the index `kind` column.
// The tree-sitter grammars name these nodes differently per language.
const DECL_KINDS: Record<string, Record<string, string>> = {
  typescript: { function_declaration: 'function', class_declaration: 'class', interface_declaration: 'interface', type_alias_declaration: 'type', method_definition: 'method' },
  javascript: { function_definition: 'function', class_declaration: 'class', method_definition: 'method' },
  python: { function_definition: 'function', class_definition: 'class' },
  rust: { function_item: 'function', struct_item: 'class', enum_item: 'class', trait_item: 'interface', type_item: 'type', impl_item: 'impl' },
  go: { function_declaration: 'function', method_declaration: 'method', type_declaration: 'type', var_declaration: 'var', const_declaration: 'const' },
  java: { class_declaration: 'class', interface_declaration: 'interface', method_declaration: 'method', enum_declaration: 'enum', record_declaration: 'record', type_declaration: 'type' },
  cpp: { class_specifier: 'class', struct_specifier: 'class', function_definition: 'function', namespace_definition: 'namespace' },
};

// Obtain a declaration's name: most grammars expose a `name` field; Go uses a
// `name` field on type_spec / var_spec / const_spec children of the *_declaration
// nodes. We handle both by scanning the node's named children for a `name`.
function nameOf(node: any): string | undefined {
  const direct = node.childForFieldName?.('name')?.text;
  if (direct && direct.trim()) return direct.trim();
  for (const c of node.namedChildren ?? []) {
    if (c.type === 'type_spec' || c.type === 'var_spec' || c.type === 'const_spec' || c.type === 'type_identifier' || c.type === 'identifier') {
      const childName = c.childForFieldName?.('name')?.text ?? (c.text && c.type === 'type_identifier' ? c.text : undefined);
      if (childName && childName.trim()) return childName.trim();
    }
  }
  return undefined;
}

const _initPromise: Promise<boolean> = (async () => {
  if (process.env.MOCHI_CPG_BACKEND === 'tsc') return false;
  const _req = createRequire(import.meta.url);
  try {
    const mod = await import('web-tree-sitter' as any);
    const Parser = mod.Parser as any;
    const wasmPath = _req.resolve('web-tree-sitter/web-tree-sitter.wasm');
    await Parser.init({ locateFile: () => wasmPath });
    _Parser = Parser;
    for (const lang of LANGUAGES) {
      const spec = GRAMMAR_SPECS[lang];
      if (!spec) continue;
      try {
        const pkgJson = _req.resolve(`${spec.pkg}/package.json`);
        const wasmFile = resolve(dirname(pkgJson), spec.file);
        const grammarBuf = readFileSync(wasmFile);
        const grammar = await mod.Language.load(grammarBuf);
        _languages.set(lang, grammar);
      } catch (e) {
        // Individual grammar load failure only disables that language.
        const msg = (e as Error)?.message || String(e);
        _tsInitError += `[${lang}] ${msg}; `;
      }
    }
    return _languages.size > 0;
  } catch (e) {
    _tsInitError += String((e as Error)?.message ?? e);
    return false;
  }
})();

export function loadTreeSitter(): { ok: boolean; message: string } {
  if (_Parser && _languages.size > 0) {
    const langs = [..._languages.keys()].join(', ');
    return { ok: true, message: `loaded (${langs})` };
  }
  return { ok: false, message: _tsInitError || 'tree-sitter backend unavailable (npm i web-tree-sitter + tree-sitter-<lang>)' };
}

export function getParserBackend(): ParserBackend {
  // Explicit opt-in to the tsc backend wins; else default is tree-sitter.
  if (process.env.MOCHI_CPG_BACKEND === 'tsc') return 'tsc';
  return _Parser && _languages.size > 0 ? 'tree-sitter' : 'tsc';
}

// Wait for the async init to settle so backend checks are correct.
export async function ensureParserLoaded(): Promise<void> { await _initPromise; }

function namedChildren(node: any): any[] {
  return Array.isArray(node?.namedChildren) ? node.namedChildren : [];
}

// Symbol index using the Tree-sitter backend. Emits rows into the same schema
// as `indexFile`, so the read paths (getFunctionSynapse/findCallers/…,
// SQLite-backed) are backend-agnostic. Works for every language we have a
// grammar for; a per-file error only skips that file.
function tsIndexFile(file: string, rel: string, database: DatabaseSync): void {
  const lang = langOf(file);
  if (!lang) return;
  const grammar = _languages.get(lang);
  if (!grammar) return;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  try {
    const parser = new _Parser();
    parser.setLanguage(grammar);
    const tree = parser.parse(String(text));
    const ins = database.prepare('INSERT INTO symbols(name,line,kind,file,rel,body) VALUES (?,?,?,?,?,?)');
    const kinds = DECL_KINDS[lang] ?? {};
    const walk = (node: any): void => {
      const kind = kinds[node.type];
      if (kind) {
        const name = nameOf(node);
        if (name) {
          ins.run(name, node.startPosition.row + 1, kind, file, rel, node.text.slice(0, 3000));
        }
      }
      for (const c of namedChildren(node)) walk(c);
    };
    walk(tree.rootNode);
  } catch { /* per-file error: skip; tsc backend (JS/TS) still works */ }
}

// Per-cwd in-memory SQLite databases (symbol/relation tables) kept fresh via a
// generation fence: any write/edit/delete bumps the workspace mutation
// generation (see tools/fs-signal.ts), and here we re-index only the files whose
// (mtime,size) fingerprint changed -- never the whole tree. So read tools
// always reflect the latest edits without a full O(repo) re-walk.
interface CachedDb {
  database: DatabaseSync;
  gen: number;
  files: Map<string, string>; // abs path -> "mtimeMs:size"
}
const dbCache = new Map<string, CachedDb>();

function fingerprint(full: string): string {
  try {
    const st = statSync(full);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

function db(cwd: string): DatabaseSync {
  const cached = dbCache.get(cwd);
  const gen = mutationGeneration();
  if (cached && cached.gen === gen && cached.files.size > 0) return cached.database;

  const DatabaseSyncCtor = DatabaseSyncType();
  const database = cached?.database ?? (() => {
    const db = new DatabaseSyncCtor(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS symbols(name TEXT,line INTEGER,kind TEXT,file TEXT,rel TEXT,body TEXT);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sym ON symbols(name);');
    db.exec('CREATE TABLE IF NOT EXISTS relations(src TEXT,dst TEXT,kind TEXT,file TEXT);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rel_src ON relations(src);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rel_dst ON relations(dst);');
    return db;
  })();

  const files = cached?.files ?? new Map<string, string>();
  const prevRels = new Set(files.keys());
  const useImpl = getParserBackend() === 'tree-sitter';
  const delSym = database.prepare('DELETE FROM symbols WHERE file=?');
  const delRel = database.prepare('DELETE FROM relations WHERE file=?');

  for (const full of walkFiles(cwd, cwd)) {
    const fp = fingerprint(full);
    if (fp && fp === files.get(full)) {
      prevRels.delete(full); // unchanged and still present
      continue;
    }
    prevRels.delete(full); // present -- do not purge below
    files.delete(full);
    if (cached) { delSym.run(full); delRel.run(full); }
    if (fp) {
      const rel = relative(cwd, full).replace(/\\/g, '/');
      if (useImpl) tsIndexFile(full, rel, database);
      else indexFile(full, rel, database);
      files.set(full, fp);
    }
  }
  for (const gone of prevRels) {
    if (cached) { delSym.run(gone); delRel.run(gone); }
    files.delete(gone);
  }

  dbCache.set(cwd, { database, gen, files });
  return database;
}

export function getFunctionSynapse(cwd: string, name: string): string {
  if (!hasSqlite()) return `Code index unavailable on this Node runtime (needs node:sqlite, Node >= 22.5).`;
  const database = db(cwd);
  const rows = database.prepare('SELECT * FROM symbols WHERE name=? ORDER BY line').all(name) as unknown as Sym[];
  if (rows.length === 0) return `No definition found for "${name}".`;
  const r = rows[0];
  const more = rows.length > 1 ? `\n# ${rows.length - 1} more definition(s).` : '';
  return `# ${r.kind} ${r.name} — ${r.rel}:${r.line}\n${r.body}${more}`;
}

export function findCallers(cwd: string, name: string): string {
  if (!hasSqlite()) return `Code index unavailable on this machine (needs node:sqlite, Node >= 22.5).`;
  const database = db(cwd);
  const q = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const declSet = new Set<string>();
  for (const r of database.prepare('SELECT file,line FROM symbols WHERE name=?').all(name) as any[]) {
    declSet.add(`${r.file}:${r.line}`);
  }
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const full of walkFiles(cwd, cwd)) {
    let lines: string[];
    try { lines = readFileSync(full, 'utf8').split('\n'); } catch { continue; }
    for (let i = 0; i < lines.length; i++) {
      if (q.test(lines[i])) {
        const hit = `${relative(cwd, full).replace(/\\/g, '/')}:${i + 1}: ${lines[i].trim()}`;
        if (!declSet.has(`${full}:${i + 1}`) && !seen.has(hit)) { seen.add(hit); hits.push(hit); }
        if (hits.length >= 12) return hits.join('\n');
      }
    }
  }
  return hits.length ? hits.join('\n') : `No references to "${name}" found.`;
}

export function typeHierarchy(cwd: string, name: string): string {
  if (!hasSqlite()) return `Code index unavailable on this machine (needs node:sqlite, Node >= 22.5).`;
  const database = db(cwd);
  const up = database.prepare('SELECT dst FROM relations WHERE src=? AND kind=?').all(name, 'extends') as any[];
  const down = database.prepare('SELECT src FROM relations WHERE dst=? AND kind=?').all(name, 'extends') as any[];
  const out: string[] = [];
  if (up.length) out.push(`super-types of ${name}: ${up.map((r: any) => r.dst).join(', ')}`);
  if (down.length) out.push(`sub-types of ${name}:\n  ` + down.map((r: any) => '• ' + r.src).join('\n  '));
  if (!out.length) out.push(`No inheritance edges found for "${name}".`);
  return out.join('\n').slice(0, 4000);
}

interface Sym { name: string; kind: string; file: string; rel: string; line: number; body: string; }
export { Sym };