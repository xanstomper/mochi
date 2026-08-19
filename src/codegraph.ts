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

const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']);

function* walkFiles(root: string, dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === '.git' || e === 'node_modules' || e === '.mochi' || e === 'dist' || e === '.next' || e === 'coverage') continue;
    const full = resolve(dir, e);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walkFiles(root, full);
    else if (EXT.has(full.slice(full.lastIndexOf('.'))) && st.size < 1_500_000) yield full;
  }
}

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

export type ParserBackend = 'tsc' | 'tree-sitter';

// Optional Tree-sitter (WASM) backend behind a feature flag. Selecting it
// (MOCHI_CPG_BACKEND=tree-sitter) loads `web-tree-sitter` plus the
// `tree-sitter-typescript` grammar, then indexes declarations via a shallow
// CST walk. If the optional packages cannot be loaded it falls back to the
// TS-AST backend, so nothing breaks.

let _Parser: any = null;    // web-tree-sitter Parser class (post-init)
let _grammar: any = null;   // Parser.Language (typescript + tsx)
let _tsError = '';

// web-tree-sitter's static init is async; we run it once eagerly so the
// (synchronous) indexer can use the parser without awaiting on each file.
const _initPromise: Promise<boolean> = (async () => {
  if (process.env.MOCHI_CPG_BACKEND !== 'tree-sitter') return false;
  const _req = createRequire(import.meta.url);
  try {
    const init = (await import('web-tree-sitter/tree-sitter.js' as any)).default as any;
    const Parser = init as any;
    const wasmPath = _req.resolve('web-tree-sitter/tree-sitter.wasm');
    await Parser.init(wasmPath);
    const gpkg = _req.resolve('tree-sitter-typescript/package.json');
    const gdir = resolve(dirname(gpkg), 'tree-sitter-typescript.wasm');
    const grammarBuf = readFileSync(gdir);
    const grammar = await Parser.Language.load(grammarBuf);
    _Parser = Parser;
    _grammar = grammar;
    return true;
  } catch (e) {
    _tsError = (e as Error)?.message || String(e);
    return false;
  }
})();

export function loadTreeSitter(): { ok: boolean; message: string } {
  return _Parser && _grammar
    ? { ok: true, message: 'loaded' }
    : { ok: false, message: _tsError || 'tree-sitter backend unavailable (npm i web-tree-sitter tree-sitter-typescript)' };
}

export function getParserBackend(): ParserBackend {
  if (process.env.MOCHI_CPG_BACKEND === 'tree-sitter') return 'tree-sitter';
  return 'tsc';
}

// Wait for the async init to settle so backend checks are correct.
export async function ensureParserLoaded(): Promise<void> { await _initPromise; }

function namedChildren(node: any): any[] {
  return Array.isArray(node?.namedChildren) ? node.namedChildren : [];
}

// Symbol index using the Tree-sitter backend. Emits rows into the same schema
// as `indexFile`, so the read paths (getFunctionSynapse/findCallers/…,
// SQLite-backed) are backend-agnostic.
function tsIndexFile(file: string, rel: string, database: DatabaseSync): void {
  if (!_Parser || !_grammar) return;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  try {
    const parser = new _Parser();
    parser.setLanguage(_grammar);
    const tree = parser.parse(String(text));
    const ins = database.prepare('INSERT INTO symbols(name,line,kind,file,rel,body) VALUES (?,?,?,?,?,?)');
    const walk = (node: any): void => {
      const kind = node.type;
      if (kind.endsWith('_declaration') || kind === 'method_definition' ||
          kind === 'variable_declarator' || kind === 'lexical_declaration') {
        // Named function/class/interface/alias declarations carry a `name` field.
        const name = node.childForFieldName?.('name')?.text;
        const declKind =
          kind === 'class_declaration' || kind === 'interface_declaration' ? 'class'
            : kind === 'method_definition' ? 'method'
              : kind === 'type_alias_declaration' ? 'type'
                : kind === 'import_declaration' ? 'import'
                  : 'function';
        if (name) {
          // Skip anonymous arrow-function assignments — those have no name field.
          ins.run(name, node.startPosition.row + 1, declKind, file, rel, node.text.slice(0, 3000));
        }
      }
      for (const c of namedChildren(node)) walk(c);
    };
    walk(tree.rootNode);
  } catch { /* per-file error: skip; tsc backend still works */ }
}

// Per-cwd in-memory SQLite databases (symbol/relation tables) kept fresh via a
// generation fence: any write/edit/delete bumps the workspace mutation
// generation (see tools/fs-signal.ts), and here we re-index only the files whose
// (mtime,size) fingerprint changed — never the whole tree. So read tools
// (`get_function`, `find_callers`, `type_hierarchy`) always reflect the latest
// edits without a full O(repo) re-walk on every symbol read.
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
    // Changed or new file: drop any stale rows and re-index just this one.
    prevRels.delete(full); // it is present -- do not let it be purged below
    files.delete(full);
    if (cached) { delSym.run(full); delRel.run(full); }
    if (fp) {
      const rel = relative(cwd, full).replace(/\\/g, '/');
      if (useImpl) tsIndexFile(full, rel, database);
      else indexFile(full, rel, database);
      files.set(full, fp);
    }
  }
  // Files that existed in the cache but no longer walk: purge their rows.
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
  if (!hasSqlite()) return `Code index unavailable on this Node runtime (needs node:sqlite, Node >= 22.5).`;
  const database = db(cwd);
  const q = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const declSet = new Set<string>();
  for (const r of database.prepare('SELECT file,line FROM symbols WHERE name=?').all(name) as any[]) {
    declSet.add(`${r.file}:${r.line}`);
  }
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const full of walkFiles(cwd, cwd)) {
    if (!EXT.has(full.slice(full.lastIndexOf('.')))) continue;
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
  if (!hasSqlite()) return `Code index unavailable on this Node runtime (needs node:sqlite, Node >= 22.5).`;
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