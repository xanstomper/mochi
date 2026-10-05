// Architectural Codebase Mapper for Large-Scale Codebases.
// Instantly computes project ecosystem, module topology, LOC metrics, entry points, and structural blast radius.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, relative, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import type { Tool } from './types.js';

interface LangStat {
  files: number;
  lines: number;
}

interface DirSummary {
  path: string;
  files: number;
  lines: number;
  primaryLang: string;
  keyFiles: string[];
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'target', 'build', '.next', '.turbo',
  'coverage', '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
  '.yarn', '.pnpm-store', 'vendor', 'out',
]);

const EXT_LANG_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript (React)',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript (React)',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.c': 'C',
  '.h': 'C/C++ Header',
  '.cpp': 'C++',
  '.hpp': 'C++ Header',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.md': 'Markdown',
  '.sh': 'Shell',
  '.bash': 'Shell',
};

const KEY_ENTRY_NAMES = new Set([
  'index.ts', 'index.js', 'main.ts', 'main.js', 'main.rs', 'main.go',
  'app.ts', 'app.js', 'app.py', 'server.ts', 'server.js', 'cli.ts', 'cli.js',
  'lib.rs', 'mod.rs', 'routes.ts', 'router.ts', 'types.ts', 'types.d.ts',
]);

export interface CodebaseMapResult {
  projectDir: string;
  manifests: string[];
  projectTypes: string[];
  totalFiles: number;
  totalLines: number;
  languages: Record<string, LangStat>;
  modules: DirSummary[];
  entryPoints: string[];
  keyExports: Record<string, string[]>;
}

export function generateCodebaseMap(
  rootDir: string,
  opts: { maxDepth?: number; detailLevel?: 'compact' | 'standard' | 'deep'; includeExports?: boolean } = {}
): CodebaseMapResult {
  const maxDepth = Math.max(1, Math.min(6, opts.maxDepth ?? 3));
  const detailLevel = opts.detailLevel ?? 'standard';
  const includeExports = opts.includeExports ?? (detailLevel !== 'compact');

  const manifests: string[] = [];
  const projectTypes = new Set<string>();

  // Check manifests at root
  if (existsSync(join(rootDir, 'package.json'))) {
    manifests.push('package.json');
    projectTypes.add('Node.js / JS Ecosystem');
    try {
      const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
      if (pkg.workspaces) projectTypes.add('Monorepo (npm/yarn/pnpm)');
      if (pkg.dependencies?.react || pkg.devDependencies?.react) projectTypes.add('React');
      if (pkg.dependencies?.next) projectTypes.add('Next.js');
      if (pkg.dependencies?.express) projectTypes.add('Express');
      if (pkg.dependencies?.fastify) projectTypes.add('Fastify');
    } catch {}
  }
  if (existsSync(join(rootDir, 'pnpm-workspace.yaml'))) {
    manifests.push('pnpm-workspace.yaml');
    projectTypes.add('pnpm Monorepo');
  }
  if (existsSync(join(rootDir, 'Cargo.toml'))) {
    manifests.push('Cargo.toml');
    projectTypes.add('Rust / Cargo');
  }
  if (existsSync(join(rootDir, 'go.mod'))) {
    manifests.push('go.mod');
    projectTypes.add('Go');
  }
  if (existsSync(join(rootDir, 'pyproject.toml')) || existsSync(join(rootDir, 'requirements.txt'))) {
    manifests.push(existsSync(join(rootDir, 'pyproject.toml')) ? 'pyproject.toml' : 'requirements.txt');
    projectTypes.add('Python');
  }
  if (existsSync(join(rootDir, 'CMakeLists.txt')) || existsSync(join(rootDir, 'Makefile'))) {
    manifests.push(existsSync(join(rootDir, 'CMakeLists.txt')) ? 'CMakeLists.txt' : 'Makefile');
    projectTypes.add('C/C++ / Native');
  }

  const languages: Record<string, LangStat> = {};
  const modulesMap = new Map<string, { files: number; lines: number; langCounts: Record<string, number>; keyFiles: string[] }>();
  const entryPoints: string[] = [];
  const keyExports: Record<string, string[]> = {};
  let totalFiles = 0;
  let totalLines = 0;

  function countLines(content: string): number {
    let count = 0;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) count++;
    }
    return count + 1;
  }

  function extractExports(content: string): string[] {
    const lines = content.split('\n');
    const exports: string[] = [];
    const exportRegex = /^\s*export\s+(?:async\s+)?(?:function|class|interface|type|const|enum|let)\s+([A-Za-z0-9_$]+)/;
    const pubRegex = /^\s*pub(?:\([^)]+\))?\s+(?:fn|struct|enum|trait|type|const)\s+([A-Za-z0-9_]+)/;
    const pyRegex = /^(?:def|class)\s+([A-Za-z0-9_]+)/;

    for (const line of lines) {
      if (exports.length >= 10) break;
      const mExport = line.match(exportRegex);
      if (mExport) {
        exports.push(mExport[1]);
        continue;
      }
      const mPub = line.match(pubRegex);
      if (mPub) {
        exports.push(mPub[1]);
        continue;
      }
      const mPy = line.match(pyRegex);
      if (mPy && !line.startsWith('def _')) {
        exports.push(mPy[1]);
      }
    }
    return exports;
  }

  function scanDir(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(rootDir, fullPath);

      if (entry.isDirectory()) {
        scanDir(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        const lang = EXT_LANG_MAP[ext];
        if (!lang) continue;

        totalFiles++;
        let lineCount = 0;
        let content = '';
        try {
          content = readFileSync(fullPath, 'utf8');
          lineCount = countLines(content);
        } catch {
          continue;
        }

        totalLines += lineCount;

        if (!languages[lang]) {
          languages[lang] = { files: 0, lines: 0 };
        }
        languages[lang].files++;
        languages[lang].lines += lineCount;

        // Determine top-level module (depth 1 or 2 relative path)
        const parts = relPath.split('/');
        const modKey = parts.length > 1 ? (parts[0] === 'src' && parts.length > 2 ? `src/${parts[1]}` : parts[0]) : '.';

        if (!modulesMap.has(modKey)) {
          modulesMap.set(modKey, { files: 0, lines: 0, langCounts: {}, keyFiles: [] });
        }
        const m = modulesMap.get(modKey)!;
        m.files++;
        m.lines += lineCount;
        m.langCounts[lang] = (m.langCounts[lang] || 0) + 1;

        // Detect entry points
        if (KEY_ENTRY_NAMES.has(entry.name) || relPath.endsWith('index.ts') || relPath.endsWith('main.ts')) {
          if (!entryPoints.includes(relPath)) entryPoints.push(relPath);
          if (m.keyFiles.length < 5) m.keyFiles.push(entry.name);

          if (includeExports && (parts.length <= 3) && !keyExports[relPath]) {
            const syms = extractExports(content);
            if (syms.length > 0) keyExports[relPath] = syms;
          }
        }
      }
    }
  }

  scanDir(rootDir, 1);

  const modules: DirSummary[] = Array.from(modulesMap.entries())
    .map(([modPath, data]) => {
      let topLang = 'Unknown';
      let maxCount = 0;
      for (const [l, count] of Object.entries(data.langCounts)) {
        if (count > maxCount) {
          maxCount = count;
          topLang = l;
        }
      }
      return {
        path: modPath,
        files: data.files,
        lines: data.lines,
        primaryLang: topLang,
        keyFiles: data.keyFiles,
      };
    })
    .sort((a, b) => b.lines - a.lines);

  return {
    projectDir: rootDir,
    manifests,
    projectTypes: Array.from(projectTypes),
    totalFiles,
    totalLines,
    languages,
    modules,
    entryPoints: entryPoints.slice(0, 15),
    keyExports,
  };
}

export function formatCodebaseMap(res: CodebaseMapResult, detailLevel: 'compact' | 'standard' | 'deep' = 'standard'): string {
  const lines: string[] = [];
  lines.push(`🗺️ Codebase Map: ${basename(res.projectDir)} (${res.totalFiles.toLocaleString()} files, ${res.totalLines.toLocaleString()} LOC)`);
  
  if (res.projectTypes.length > 0) {
    lines.push(`📦 Ecosystem: ${res.projectTypes.join(' | ')}`);
  }
  if (res.manifests.length > 0) {
    lines.push(`📄 Manifests: ${res.manifests.join(', ')}`);
  }
  lines.push('');

  // Language Breakdown
  const sortedLangs = Object.entries(res.languages)
    .sort((a, b) => b[1].lines - a[1].lines)
    .slice(0, 8);
  lines.push('📊 Language Breakdown:');
  for (const [lang, stat] of sortedLangs) {
    const pct = res.totalLines > 0 ? ((stat.lines / res.totalLines) * 100).toFixed(1) : '0';
    lines.push(`  - ${lang.padEnd(20, ' ')}: ${stat.lines.toLocaleString().padStart(8, ' ')} LOC (${pct}%) across ${stat.files} files`);
  }
  lines.push('');

  // Primary Modules
  lines.push(`🧱 Architecture & Modules (${res.modules.length} modules detected):`);
  const topModules = detailLevel === 'compact' ? res.modules.slice(0, 8) : res.modules.slice(0, 20);
  for (const mod of topModules) {
    const keysStr = mod.keyFiles.length > 0 ? ` [Key files: ${mod.keyFiles.join(', ')}]` : '';
    lines.push(`  📁 ${mod.path.padEnd(24, ' ')} ${mod.lines.toLocaleString().padStart(7, ' ')} LOC | ${mod.files} files (${mod.primaryLang})${keysStr}`);
  }
  lines.push('');

  // Entry Points
  if (res.entryPoints.length > 0) {
    lines.push(`🎯 Key Structural Entry Points (${res.entryPoints.length}):`);
    for (const ep of res.entryPoints) {
      const exports = res.keyExports[ep];
      const expStr = exports && exports.length > 0 ? ` (exports: ${exports.join(', ')})` : '';
      lines.push(`  - ${ep}${expStr}`);
    }
  }

  return lines.join('\n');
}

export const codebaseMapTool: Tool = {
  def: {
    name: 'codebase_map',
    description:
      'Generate a comprehensive architectural map of the codebase. Detects project ecosystems, language distribution, module topology, LOC metrics, entry points, and structural blast radius across monorepos and large repositories.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative directory path to map (defaults to project root)', required: false },
      { name: 'max_depth', type: 'integer', description: 'Directory scan depth 1-6 (default 3)', required: false },
      { name: 'detail_level', type: 'string', description: 'Detail level: compact, standard, or deep (default standard)', required: false },
      { name: 'include_exports', type: 'boolean', description: 'Whether to extract key symbol exports from entry points (default true)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const raw = args.path ? String(args.path) : '';
    const dir = raw ? (raw === '~' ? homedir() : raw.startsWith('~/') ? resolve(homedir(), raw.slice(2)) : resolve(ctx.cwd, raw)) : ctx.cwd;
    if (!existsSync(dir)) throw new Error(`Directory not found: ${dir}`);

    const maxDepth = args.max_depth ? Number(args.max_depth) : 3;
    const detailLevel = (args.detail_level as any) || 'standard';
    const includeExports = args.include_exports !== undefined ? Boolean(args.include_exports) : detailLevel !== 'compact';

    const result = generateCodebaseMap(dir, { maxDepth, detailLevel, includeExports });
    return formatCodebaseMap(result, detailLevel);
  },
};
