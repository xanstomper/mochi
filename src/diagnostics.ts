// Instant per-file diagnostics (the Crush LSP insight): after every edit the
// model gets type/syntax errors for the touched file in the SAME turn, instead
// of discovering them at verification time and burning whole iterations.
//
// Implementation notes:
// - TS/JS: the edited project's own TypeScript LanguageService, kept in-process
//   with a cached host (warm single-file semantic check is ~100-400ms vs 6s for
//   a full tsc). Falls back to nothing when the repo has no typescript.
// - Python: `python3 -m py_compile` (fast syntax check) when python3 exists.
// - Rust: `rustc --edition 2021 --emit=metadata` is too slow per-edit; skipped
//   unless cargo check is cheap enough later. Diagnostics are best-effort and
//   NEVER block the loop on failure.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

export interface FileDiagnostics {
  path: string;
  ok: boolean;
  /** Cap the lines fed back to the model: diagnostics are context, not a dump. */
  errors: string[];
  warnings: string[];
  ms: number;
}

const MAX_LINES = 8;

function cap(lines: string[]): string[] {
  return lines.slice(0, MAX_LINES);
}

/** TypeScript language service cache: one service per project root, reused
 *  across edits so the program graph stays warm. */
interface TsService {
  ts: typeof import('typescript');
  service: import('typescript').LanguageService;
  versions: Map<string, number>;
  root: string;
}
const tsServices = new Map<string, TsService>();

function getTsService(root: string): TsService | undefined {
  const cached = tsServices.get(root);
  if (cached) return cached;
  // Use the EDITED PROJECT's own typescript (not Mochi's) so diagnostics match
  // the project's TS version and config.
  const tsPath = resolve(root, 'node_modules', 'typescript');
  if (!existsSync(tsPath)) return undefined;
  let ts: typeof import('typescript');
  try {
    // createRequire (not bare require) so this works in real ESM contexts too.
    const req = createRequire(import.meta.url);
    ts = req(tsPath) as typeof import('typescript');
  } catch {
    return undefined;
  }
  const tsconfig = resolve(root, 'tsconfig.json');
  const config = existsSync(tsconfig)
    ? ts.parseJsonConfigFileContent(ts.readConfigFile(tsconfig, ts.sys.readFile).config, ts.sys, root)
    : { options: {}, fileNames: [], errors: [] };
  const versions = new Map<string, number>();
  const snapshots = new Map<string, import('typescript').IScriptSnapshot>();
  const host: import('typescript').LanguageServiceHost = {
    getScriptFileNames: () => [...config.fileNames, ...snapshots.keys()],
    getScriptVersion: (fileName) => String(versions.get(fileName) ?? 0),
    getScriptSnapshot: (fileName) => {
      if (snapshots.has(fileName)) return snapshots.get(fileName);
      if (!ts.sys.fileExists(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) ?? '');
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => config.options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const entry: TsService = { ts, service, versions, root };
  tsServices.set(root, entry);
  return entry;
}

async function diagnoseTsViaCli(path: string, cwd: string): Promise<FileDiagnostics> {
  const t0 = Date.now();
  // npx resolves the local typescript when present; timeout keeps worst-case bounded.
  const { code, out } = await exec('npx', ['tsc', '--noEmit', path], cwd, 20_000);
  if (code === 127 || code === 0) return { path, ok: code === 0, errors: [], warnings: [], ms: Date.now() - t0 };
  const errors = out.split('\n').filter((l) => l.includes('error TS')).slice(0, MAX_LINES);
  return { path, ok: errors.length === 0, errors, warnings: [], ms: Date.now() - t0 };
}

function diagnoseTs(path: string, root: string): FileDiagnostics {
  const t0 = Date.now();
  const entry = getTsService(root);
  const empty = { path, ok: true, errors: [], warnings: [], ms: Date.now() - t0 };
  if (!entry) return empty;
  const { ts, service } = entry;
  // Bump version so the service re-reads the on-disk content after the edit.
  entry.versions.set(path, (entry.versions.get(path) ?? 0) + 1);
  const diagnostics = [
    ...service.getSyntacticDiagnostics(path),
    ...service.getSemanticDiagnostics(path),
  ];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const d of diagnostics) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    const line = d.file && typeof d.start === 'number' ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    const text = `line ${line}: ${msg} (${ts.DiagnosticCategory[d.category]})`;
    if (d.category === ts.DiagnosticCategory.Error) errors.push(text);
    else warnings.push(text);
  }
  return { path, ok: errors.length === 0, errors: cap(errors), warnings: cap(warnings), ms: Date.now() - t0 };
}

function exec(cmd: string, args: string[], cwd: string, timeout: number): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    try {
      execFile(cmd, args, { cwd, timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code! : err ? 1 : 0;
        res({ code, out: `${stdout ?? ''}\n${stderr ?? ''}` });
      });
    } catch {
      res({ code: 127, out: '' });
    }
  });
}

async function diagnosePython(path: string, cwd: string): Promise<FileDiagnostics> {
  const t0 = Date.now();
  const { code, out } = await exec('python3', ['-m', 'py_compile', path], cwd, 10_000);
  if (code === 127) return { path, ok: true, errors: [], warnings: [], ms: Date.now() - t0 };
  if (code === 0) return { path, ok: true, errors: [], warnings: [], ms: Date.now() - t0 };
  const errors = out.split('\n').filter((l) => l.includes('Error') || l.includes('error')).slice(0, MAX_LINES);
  return { path, ok: false, errors: errors.length ? errors : [out.split('\n')[0] ?? 'syntax error'], warnings: [], ms: Date.now() - t0 };
}

/** Diagnose one edited file. Best-effort: unknown languages and missing
 *  toolchains return ok=true with no errors (never blocks the loop). */
export async function diagnoseFile(path: string, cwd: string): Promise<FileDiagnostics> {
  const t0 = Date.now();
  try {
    if (!existsSync(path)) return { path, ok: true, errors: [], warnings: [], ms: Date.now() - t0 };
    if (/\.(ts|tsx|js|jsx|mts|cts)$/.test(path)) {
      // Find the project root for the file: nearest tsconfig/package.json.
      let root = dirname(path);
      for (let i = 0; i < 6; i++) {
        if (existsSync(resolve(root, 'tsconfig.json')) || existsSync(resolve(root, 'package.json'))) break;
        const parent = dirname(root);
        if (parent === root) break;
        root = parent;
      }
      if (getTsService(root)) return diagnoseTs(path, root);
      // No importable typescript in the edited project: fall back to the CLI
      // (npx tsc) so diagnostics still work in repos that only have tsc
      // installed globally or via npx. Bounded by a timeout.
      return diagnoseTsViaCli(path, root);
    }
    if (/\.py$/.test(path)) return diagnosePython(path, cwd);
    if (/\.json$/i.test(path)) {
      try {
        const { readFileSync } = await import('node:fs');
        const text = readFileSync(path, 'utf8');
        JSON.parse(text);
        return { path, ok: true, errors: [], warnings: [], ms: Date.now() - t0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { path, ok: false, errors: [`JSON Parse Error: ${msg}`], warnings: [], ms: Date.now() - t0 };
      }
    }
    if (/\.go$/i.test(path)) {
      const { code, out } = await exec('gofmt', ['-e', path], cwd, 5_000);
      if (code === 0 || code === 127) return { path, ok: true, errors: [], warnings: [], ms: Date.now() - t0 };
      const errs = out.split('\n').filter((l) => l.trim()).slice(0, MAX_LINES);
      return { path, ok: errs.length === 0, errors: errs, warnings: [], ms: Date.now() - t0 };
    }
    return { path, ok: true, errors: [], warnings: [], ms: Date.now() - t0 };
  } catch {
    return { path, ok: true, errors: [], warnings: [], ms: Date.now() - t0 };
  }
}

/** Render diagnostics for injection into the tool result the model sees. */
export function renderDiagnostics(diags: FileDiagnostics[]): string {
  const parts: string[] = [];
  for (const d of diags) {
    if (d.ok && d.warnings.length === 0) continue;
    const rel = d.path.length > 60 ? d.path.slice(-60) : d.path;
    if (!d.ok) {
      parts.push(`DIAGNOSTICS for ${rel}: ${d.errors.length} error(s) — FIX THESE BEFORE CONTINUING:\n${d.errors.map((e) => `- ${e}`).join('\n')}`);
    }
    if (d.warnings.length > 0) {
      parts.push(`warnings for ${rel}:\n${d.warnings.map((w) => `- ${w}`).join('\n')}`);
    }
  }
  return parts.join('\n');
}
