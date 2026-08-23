import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type * as ts from 'typescript';
import { hasSqlite as driverAvailable, openDb, type SqliteDb } from './sqlite.js';
import { mutationGeneration } from './tools/fs-signal.js';

// The TypeScript compiler costs ~75MB RSS to load; it is only needed by the
// tsc FALLBACK indexer, so load it on first use instead of at import time
// (tree-sitter is the default backend and never touches this).
let _tsc: typeof import('typescript') | null = null;
function tsc(): typeof import('typescript') {
  if (!_tsc) _tsc = createRequire(import.meta.url)('typescript') as typeof import('typescript');
  return _tsc;
}

/** True when any SQLite driver is available (node:sqlite on Node >= 22.5 or
 *  bun:sqlite in the compiled binary). Without it the codegraph degrades to
 *  "no symbol index" instead of throwing. Can be explicitly disabled via
 *  MOCHI_NO_EMBED=1 or MOCHI_LIGHT=1 for ultra-lightweight execution. */
export function hasSqlite(): boolean {
  if (process.env.MOCHI_NO_EMBED === '1' || process.env.MOCHI_LIGHT === '1' || process.env.MOCHI_NO_INDEX === '1') {
    return false;
  }
  return driverAvailable();
}

// ---------------------------------------------------------------------------
// Polyglot file coverage. The index understands the languages a real agent
// actually sees: JS/TS plus the major backend systems languages. The tree-
// sitter WASM backend is the DEFAULT (fast, in-process, no full compiler);
// the TypeScript-compiler backend covers .ts/.js only when explicitly chosen
// (MOCHI_CPG_BACKEND=tsc) or when tree-sitter is unavailable.
// ---------------------------------------------------------------------------
export const LANGUAGES = ['typescript', 'javascript', 'python', 'rust', 'go', 'java', 'cpp', 'ruby', 'php', 'csharp'] as const;
export type LanguageId = (typeof LANGUAGES)[number];

const EXT_LANG: Record<string, LanguageId> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.h': 'cpp',
  '.rb': 'ruby', '.rake': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
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
  f.endsWith('.tsx') ? tsc().ScriptKind.TSX : f.endsWith('.jsx') ? tsc().ScriptKind.JSX
    : f.endsWith('.js') || f.endsWith('.mjs') ? tsc().ScriptKind.JS
      : f.endsWith('.mts') ? tsc().ScriptKind.TS : tsc().ScriptKind.TS;

function heritage(node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration): string[] {
  if (!node.heritageClauses) return [];
  const out: string[] = [];
  for (const hc of node.heritageClauses) {
    for (const t of hc.types) {
      const expr = t.expression;
      if (tsc().isIdentifier(expr)) out.push(expr.text);
      else if (tsc().isPropertyAccessExpression(expr)) out.push(expr.name.text);
    }
  }
  return out;
}

function indexFile(file: string, rel: string, database: SqliteDb): void {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  const sf = tsc().createSourceFile(file, text, tsc().ScriptTarget.Latest, true, scriptKind(file));
  const lineOf = (p: number) => sf.getLineAndCharacterOfPosition(p).line + 1;
  const ins = database.prepare('INSERT INTO symbols(name,line,kind,file,rel,body) VALUES (?,?,?,?,?,?)');
  const relIns = database.prepare('INSERT INTO relations(src,dst,kind,file) VALUES (?,?,?,?)');
  const emit = (name: string, kind: string, start: number, body: string) => {
    if (!name) return;
    ins.run(name, lineOf(start), kind, file, rel, body.slice(0, 3000));
  };

  function visit(node: ts.Node): void {
    if (tsc().isFunctionDeclaration(node) && node.name) {
      emit(node.name.text, 'function', node.getStart(), node.getText(sf));
    } else if (tsc().isVariableDeclaration(node) && tsc().isIdentifier(node.name) && node.initializer &&
      (node.initializer.kind === tsc().SyntaxKind.ArrowFunction || node.initializer.kind === tsc().SyntaxKind.FunctionExpression)) {
      emit(node.name.text, 'function', node.getStart(), node.getText(sf));
    } else if (tsc().isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      emit(name, 'class', node.getStart(), node.getText(sf));
      for (const h of heritage(node)) { try { relIns.run(name, h, 'extends', rel); } catch {} }
      for (const m of node.members) {
        if ((tsc().isMethodDeclaration(m) || tsc().isPropertyDeclaration(m)) && tsc().isIdentifier(m.name)) {
          emit(m.name.text, 'method', m.name.getStart(sf), m.getText(sf));
        }
      }
    } else if (tsc().isInterfaceDeclaration(node) && node.name) {
      const name = node.name.text;
      emit(name, 'interface', node.getStart(), node.getText(sf));
      for (const h of heritage(node)) { try { relIns.run(name, h, 'extends', rel); } catch {} }
    } else if (tsc().isTypeAliasDeclaration(node) && node.name) {
      emit(node.name.text, 'type', node.getStart(), node.getText(sf));
    }
    tsc().forEachChild(node, visit);
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
  ruby: { pkg: 'tree-sitter-ruby', file: 'tree-sitter-ruby.wasm' },
  php: { pkg: 'tree-sitter-php', file: 'tree-sitter-php_only.wasm' },
    csharp: { pkg: 'tree-sitter-c-sharp', file: 'tree-sitter-c_sharp.wasm' },
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
  ruby: { method: 'method', class: 'class', module: 'module', singleton_method: 'method' },
  php: { function_definition: 'function', class_declaration: 'class', method_declaration: 'method', interface_declaration: 'interface' },
  csharp: { class_declaration: 'class', method_declaration: 'method', interface_declaration: 'interface', record_declaration: 'class', struct_declaration: 'class' },
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

// LAZY loading (harness-v2 perf): importing this module no longer compiles
// web-tree-sitter or ANY grammar into memory. Previously a module-scope promise
// eagerly loaded the core WASM plus all ten language grammars (~110MB RSS and
// tens of ms of CPU on every single run, even ones that never touch the
// codegraph tools). Now the core initializes on first indexing use and each
// language's grammar loads on first need — a typical single-language repo pays
// for exactly one grammar. MOCHI_LIGHT / MOCHI_NO_EMBED / MOCHI_NO_INDEX skip
// the parser entirely, making light mode genuinely zero-parser + zero-embed.

let _mod: any = null;                 // web-tree-sitter module (post-init)
let _corePromise: Promise<boolean> | null = null;
const _grammarPromises = new Map<string, Promise<boolean>>();
let _availableCache: boolean | null = null;

/** True when the user asked for minimal footprint (no parser, no index). */
export function isLightMode(): boolean {
  return process.env.MOCHI_LIGHT === '1' || process.env.MOCHI_NO_EMBED === '1' || process.env.MOCHI_NO_INDEX === '1';
}

/** Cheap availability probe: resolves the wasm paths WITHOUT loading them. */
function treeSitterAvailable(): boolean {
  if (_mod) return true;
  if (_availableCache !== null) return _availableCache;
  try {
    const req = createRequire(import.meta.url);
    req.resolve('web-tree-sitter/web-tree-sitter.wasm');
    req.resolve(`${GRAMMAR_SPECS.typescript.pkg}/package.json`);
    _availableCache = true;
  } catch {
    _availableCache = false;
  }
  return _availableCache;
}

async function ensureCore(): Promise<boolean> {
  if (_mod) return true;
  if (process.env.MOCHI_CPG_BACKEND === 'tsc' || isLightMode()) return false;
  if (!_corePromise) {
    _corePromise = (async () => {
      try {
        const req = createRequire(import.meta.url);
        const mod = await import('web-tree-sitter' as any);
        const Parser = mod.Parser as any;
        const wasmPath = req.resolve('web-tree-sitter/web-tree-sitter.wasm');
        await Parser.init({ locateFile: () => wasmPath });
        _mod = mod;
        _Parser = Parser;
        return true;
      } catch (e) {
        _tsInitError += String((e as Error)?.message ?? e);
        return false;
      }
    })();
  }
  return _corePromise;
}

/** Load ONE language's grammar on first need. Memoized per language. */
export async function ensureLanguage(lang: LanguageId | string): Promise<boolean> {
  if (_languages.has(lang as LanguageId)) return true;
  if (!(await ensureCore())) return false;
  const spec = GRAMMAR_SPECS[lang];
  if (!spec) return false;
  let p = _grammarPromises.get(lang);
  if (!p) {
    p = (async () => {
      try {
        const req = createRequire(import.meta.url);
        const pkgJson = req.resolve(`${spec.pkg}/package.json`);
        const wasmFile = resolve(dirname(pkgJson), spec.file);
        const grammarBuf = readFileSync(wasmFile);
        const grammar = await _mod.Language.load(grammarBuf);
        _languages.set(lang as LanguageId, grammar);
        return true;
      } catch (e) {
        // Individual grammar load failure only disables that language.
        const msg = (e as Error)?.message || String(e);
        _tsInitError += `[${lang}] ${msg}; `;
        return false;
      }
    })();
    _grammarPromises.set(lang, p);
  }
  return p;
}

/**
 * Preload the parser core plus grammars. With explicit `langs`, loads exactly
 * those and NEVER walks the filesystem - callers hot paths pass a cheap hint
 * (repo language) so warming cannot stall the loop. Without langs it performs
 * a BOUNDED asynchronous walk (SKIP_DIRS respected, entry/depth caps, early
 * exit once a few languages are found) - never a full synchronous tree scan.
 */
async function preloadGrammars(cwd: string, langs?: readonly string[]): Promise<void> {
  if (getParserBackend() !== 'tree-sitter') return;
  if (!(await ensureCore())) return;
  let found: Set<string>;
  if (langs && langs.length > 0) {
    found = new Set(langs);
  } else {
    // Yield to the event loop first: warming must never be the reason a UI
    // freezes. Then walk asynchronously with hard bounds.
    await new Promise((r) => setTimeout(r, 0));
    found = new Set<string>();
    let entries = 0;
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (entries > 4000 || found.size >= 4 || depth > 10) return;
      let names: string[];
      try { names = await fsp.readdir(dir); } catch { return; }
      for (const e of names) {
        if (entries > 4000 || found.size >= 4) return;
        if (SKIP_DIRS.has(e)) continue;
        const full = resolve(dir, e);
        entries++;
        let st;
        try { st = await fsp.stat(full); } catch { continue; }
        if (st.isDirectory()) { await visit(full, depth + 1); continue; }
        const l = langOf(full);
        if (l && st.size < 1_500_000) found.add(l);
      }
    };
    await visit(cwd, 0);
  }
  await Promise.all([...found].map((l) => ensureLanguage(l)));
}

export function loadTreeSitter(): { ok: boolean; message: string } {
  if (_Parser && _languages.size > 0) {
    const langs = [..._languages.keys()].join(', ');
    return { ok: true, message: `loaded (${langs})` };
  }
  if (!_Parser && treeSitterAvailable() && !isLightMode() && process.env.MOCHI_CPG_BACKEND !== 'tsc') {
    return { ok: true, message: 'lazy (loads on first symbol-index use)' };
  }
  return { ok: false, message: _tsInitError || 'tree-sitter backend unavailable (npm i web-tree-sitter + tree-sitter-<lang>)' };
}

export function getParserBackend(): ParserBackend {
  // Explicit opt-in to the tsc backend wins; light mode forces tsc too
  // (zero-parser); otherwise tree-sitter whenever the packages resolve.
  if (process.env.MOCHI_CPG_BACKEND === 'tsc') return 'tsc';
  if (isLightMode()) return 'tsc';
  return treeSitterAvailable() ? 'tree-sitter' : 'tsc';
}

// Wait for the async CORE init so backend checks are correct. Grammars now
// load per-language on demand (ensureLanguage); every codegraph read path
// preloads the languages present in the target repo before indexing.
export async function ensureParserLoaded(): Promise<void> { await ensureCore(); }

function namedChildren(node: any): any[] {
  return Array.isArray(node?.namedChildren) ? node.namedChildren : [];
}

// Symbol index using the Tree-sitter backend. Emits rows into the same schema
// as `indexFile`, so the read paths (getFunctionSynapse/findCallers/…,
// SQLite-backed) are backend-agnostic. Works for every language we have a
// grammar for; a per-file error only skips that file.
//
// Beyond declarations we also record CALL edges: each call node becomes a row
// in the `calls` table (caller <callee, file, line). findCallers then answers
// from the graph instead of re-grepping every file, which makes cross-file and
// cross-language call resolution exact and fast.
function tsIndexFile(file: string, rel: string, database: SqliteDb): void {
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
    const callIns = database.prepare('INSERT INTO calls(callee,caller,kind,file,rel,line) VALUES (?,?,?,?,?,?)');
    const kinds = DECL_KINDS[lang] ?? {};
    // Track the enclosing declaration name as we descend so a call row can
    // name its caller (helps findCallers attribute the call site).
    const callerStack: string[] = [];
    const walk = (node: any): void => {
      const kind = kinds[node.type];
      if (kind) {
        const name = nameOf(node);
        if (name) {
          ins.run(name, node.startPosition.row + 1, kind, file, rel, node.text.slice(0, 3000));
          callerStack.push(name);
        }
      }
      // Call node -> callee edge. Most grammars expose `function`/`name`/
      // `method` fields on the call node itself.
      if (node.type.endsWith('call_expression') || node.type === 'call' || node.type.endsWith('method_invocation') || node.type.endsWith('invocation_expression') || node.type.endsWith('function_call_expression') || node.type === 'scoped_call') {
        const callee = callName(node);
        if (callee) {
          const caller = callerStack[callerStack.length - 1] ?? '';
          callIns.run(callee, caller, 'calls', file, rel, node.startPosition.row + 1);
        }
      }
      for (const c of namedChildren(node)) walk(c);
      if (kind && callerStack.length) callerStack.pop();
    };
    walk(tree.rootNode);
  } catch { /* per-file error: skip; tsc backend (JS/TS) still works */ }
}

/** Extract the callee identifier from a call node across grammars. */
function callName(node: any): string | undefined {
  const field =
    node.childForFieldName?.('function')?.text ??
    node.childForFieldName?.('name')?.text ??
    node.childForFieldName?.('method')?.text;
  if (!field) return undefined;
  // "obj.method()" -> "method"; "a.b.c()" -> "c". Keep the last identifier.
  const last = field.trim().split(/\.|::|->|\\|\(/).filter(Boolean).pop();
  if (!last) return undefined;
  // Skip obvious builtins / punctuation.
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(last)) return last;
  return undefined;
}

// Per-cwd in-memory SQLite databases (symbol/relation tables) kept fresh via a
// generation fence: any write/edit/delete bumps the workspace mutation
// generation (see tools/fs-signal.ts), and here we re-index only the files whose
// (mtime,size) fingerprint changed -- never the whole tree. So read tools
// always reflect the latest edits without a full O(repo) re-walk.
interface CachedDb {
  database: SqliteDb;
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

function db(cwd: string): SqliteDb {
  const cached = dbCache.get(cwd);
  const gen = mutationGeneration();
  if (cached && cached.gen === gen && cached.files.size > 0) return cached.database;

  const database = cached?.database ?? (() => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS symbols(name TEXT,line INTEGER,kind TEXT,file TEXT,rel TEXT,body TEXT);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sym ON symbols(name);');
    db.exec('CREATE TABLE IF NOT EXISTS relations(src TEXT,dst TEXT,kind TEXT,file TEXT);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rel_src ON relations(src);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rel_dst ON relations(dst);');
    db.exec('CREATE TABLE IF NOT EXISTS calls(callee TEXT,caller TEXT,kind TEXT,file TEXT,rel TEXT,line INTEGER);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_call_callee ON calls(callee);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_call_caller ON calls(caller);');
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

export async function getFunctionSynapse(cwd: string, name: string): Promise<string> {
  if (!hasSqlite()) return `Code index unavailable on this Node runtime (needs node:sqlite, Node >= 22.5).`;
  await preloadGrammars(cwd);
  const database = db(cwd);
  const rows = database.prepare('SELECT * FROM symbols WHERE name=? ORDER BY line').all(name) as unknown as Sym[];
  if (rows.length === 0) return `No definition found for "${name}".`;
  const r = rows[0];
  const more = rows.length > 1 ? `\n# ${rows.length - 1} more definition(s).` : '';
  return `# ${r.kind} ${r.name} — ${r.rel}:${r.line}\n${r.body}${more}`;
}

export async function findCallers(cwd: string, name: string): Promise<string> {
  if (!hasSqlite()) return `Code index unavailable on this machine (needs node:sqlite, Node >= 22.5).`;
  await preloadGrammars(cwd);
  const database = db(cwd);

  // Graph answer first: exact call edges recorded at index time. This catches
  // cross-file and cross-language calls with the caller's enclosing symbol,
  // which a line grep cannot attribute.
  const edges = database.prepare('SELECT caller,rel,line FROM calls WHERE callee=? ORDER BY rel,line').all(name) as any[];
  const graphHits: string[] = [];
  if (edges.length > 0) {
    for (const e of edges.slice(0, 12)) {
      const where = e.caller ? ` called from ${e.caller}` : '';
      graphHits.push(`${e.rel}:${e.line}${where}`);
    }
  }

  // Fallback: line-grep any file still missing from the graph (functions the
  // grammar didn't index, or when tree-sitter isn't available). Exclude the
  // declaration itself so the answer shows call SITES only.
  const q = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const declSet = new Set<string>();
  for (const r of database.prepare('SELECT file,line FROM symbols WHERE name=?').all(name) as any[]) {
    declSet.add(`${r.file}:${r.line}`);
  }
  const hits: string[] = graphHits;
  const seen = new Set<string>(graphHits);
  for (const full of walkFiles(cwd, cwd)) {
    let lines: string[];
    try { lines = readFileSync(full, 'utf8').split('\n'); } catch { continue; }
    for (let i = 0; i < lines.length; i++) {
      if (q.test(lines[i])) {
        const hit = `${relative(cwd, full).replace(/\\/g, '/')}:${i + 1}: ${lines[i].trim()}`;
        if (!declSet.has(`${full}:${i + 1}`) && !seen.has(hit)) { seen.add(hit); hits.push(hit); }
        if (hits.length >= 12) return [...new Set(hits)].join('\n');
      }
    }
  }
  return hits.length ? [...new Set(hits)].join('\n') : `No references to "${name}" found.`;
}

export async function typeHierarchy(cwd: string, name: string): Promise<string> {
  if (!hasSqlite()) return `Code index unavailable on this machine (needs node:sqlite, Node >= 22.5).`;
  await preloadGrammars(cwd);
  const database = db(cwd);
  const up = database.prepare('SELECT dst FROM relations WHERE src=? AND kind=?').all(name, 'extends') as any[];
  const down = database.prepare('SELECT src FROM relations WHERE dst=? AND kind=?').all(name, 'extends') as any[];
  const out: string[] = [];
  if (up.length) out.push(`super-types of ${name}: ${up.map((r: any) => r.dst).join(', ')}`);
  if (down.length) out.push(`sub-types of ${name}:\n  ` + down.map((r: any) => '• ' + r.src).join('\n  '));
  if (!out.length) out.push(`No inheritance edges found for "${name}".`);
  return out.join('\n').slice(0, 4000);
}

export interface BlastRadiusReport {
  symbol: string;
  directCallers: { caller: string; file: string; line: number }[];
  affectedFiles: string[];
  typeRelations: { superTypes: string[]; subTypes: string[] };
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary: string;
}

/**
 * Computes the downstream AST blast radius (callers, affected files, type hierarchy)
 * for a symbol before modifying it, preventing unintended regressions across the repo.
 */
export async function computeSymbolBlastRadius(cwd: string, name: string): Promise<BlastRadiusReport> {
  if (!hasSqlite()) {
    return {
      symbol: name,
      directCallers: [],
      affectedFiles: [],
      typeRelations: { superTypes: [], subTypes: [] },
      riskLevel: 'LOW',
      summary: 'SQLite index unavailable for deep blast radius analysis.',
    };
  }

  await preloadGrammars(cwd);
  const database = db(cwd);
  const edges = database.prepare('SELECT caller,rel,line FROM calls WHERE callee=? ORDER BY rel,line').all(name) as any[];
  const callers = edges.map((e) => ({ caller: String(e.caller || 'anonymous'), file: String(e.rel || ''), line: Number(e.line || 1) }));
  
  const affectedFiles = [...new Set(callers.map((c) => c.file).filter(Boolean))];
  
  const up = database.prepare('SELECT dst FROM relations WHERE src=? AND kind=?').all(name, 'extends') as any[];
  const down = database.prepare('SELECT src FROM relations WHERE dst=? AND kind=?').all(name, 'extends') as any[];
  const superTypes = up.map((r: any) => String(r.dst));
  const subTypes = down.map((r: any) => String(r.src));

  let riskLevel: BlastRadiusReport['riskLevel'] = 'LOW';
  if (affectedFiles.length > 8 || subTypes.length > 5) riskLevel = 'CRITICAL';
  else if (affectedFiles.length > 3 || subTypes.length > 2) riskLevel = 'HIGH';
  else if (affectedFiles.length > 0 || superTypes.length > 0) riskLevel = 'MEDIUM';

  const summary = `Blast radius for "${name}": ${callers.length} call site(s) across ${affectedFiles.length} file(s). Risk: ${riskLevel}.`;

  return {
    symbol: name,
    directCallers: callers,
    affectedFiles,
    typeRelations: { superTypes, subTypes },
    riskLevel,
    summary,
  };
}

interface Sym { name: string; kind: string; file: string; rel: string; line: number; body: string; }
export { Sym };

/** Run a read-only SQL query against the live in-memory symbol graph. Only
 *  SELECT/WITH/PRAGMA allowed; LIMIT-capped. Returns rows or a descriptive
 *  error. Used by the sql_codebase_query tool (spec section 3). */
export function querySymbolGraph(cwd: string, sql: string, maxRows = 50): Promise<{ rows: unknown[] } | { error: string }> {
  return (async () => {
    if (!hasSqlite()) return { error: 'node:sqlite unavailable (Node >= 22.5)' };
    await preloadGrammars(cwd);
    // After preload the index is warm (or the tsc backend needs no grammars).
    return querySymbolGraphSync(cwd, sql, maxRows) ?? { rows: [] };
  })();
}

/** Sync variant for callers that cannot await (hot prompt-build paths).
 *  Returns undefined when the lazy parser has not been warmed yet — call
 *  warmCodegraph(cwd) first to make subsequent sync reads fully populated. */
export function querySymbolGraphSync(cwd: string, sql: string, maxRows = 50): { rows: unknown[] } | { error: string } | undefined {
  if (!hasSqlite()) return { error: 'node:sqlite unavailable (Node >= 22.5)' };
  if (getParserBackend() === 'tree-sitter' && _languages.size === 0) return undefined; // cold
  const first = sql.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!['select', 'with', 'pragma'].includes(first)) {
    return { error: `Only read-only queries allowed (SELECT/WITH/PRAGMA). Got "${first}".` };
  }
  const hasLimit = /limit\s+\d+/i.test(sql);
  const finalSql = hasLimit ? sql : `${sql.trim().replace(/;\s*$/, '')} LIMIT ${maxRows}`;
  try {
    const database = db(cwd);
    const rows = database.prepare(finalSql).all() as unknown[];
    return { rows: rows.slice(0, maxRows) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Warm the lazy parser + the grammars present under cwd so that sync read
 *  helpers (querySymbolGraphSync) return fully populated results. Cheap when
 *  already warm; a no-op in light mode / tsc backend. */
export async function warmCodegraph(cwd: string, langs?: readonly string[]): Promise<void> {
  await preloadGrammars(cwd, langs);
}
