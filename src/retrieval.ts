import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { relative, resolve } from 'node:path';

const SYMBOL_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(function|class|interface|type|enum|const|let|var|def|struct|trait|impl)\s+([A-Za-z0-9_$]+)/;
const IMPORT_RE = /(?:import|from)\s+['"]([^'"]+)['"]/g;

export interface SymbolInfo {
  name: string;
  file: string;
  line: number;
  kind: string;
}

export interface ReferenceInfo {
  file: string;
  line: number;
  text: string;
}

export interface ImportInfo {
  file: string;
  imports: string[];
}

export interface RetrievalResult {
  query: string;
  files: string[];
  symbols: SymbolInfo[];
  references: ReferenceInfo[];
  imports: ImportInfo[];
  recentCommits: { file: string; commits: string[] }[];
  summary: string;
}

export class RetrievalEngine {
  constructor(private cwd: string) {}

  listFiles(max = 2000): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      if (files.length >= max) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === '.git' || entry === 'node_modules' || entry === '.mochi' || entry === 'dist') continue;
        const full = resolve(dir, entry);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full);
        } else {
          const rel = relative(this.cwd, full);
          files.push(rel);
          if (files.length >= max) return;
        }
      }
    };
    walk(this.cwd);
    return files;
  }

  extractSymbols(files = this.listFiles()): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    for (const file of files) {
      const full = resolve(this.cwd, file);
      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(SYMBOL_RE);
        if (m) symbols.push({ kind: m[1], name: m[2], file, line: i + 1 });
      }
    }
    return symbols;
  }

  extractImports(files = this.listFiles()): ImportInfo[] {
    const imports: ImportInfo[] = [];
    for (const file of files) {
      const full = resolve(this.cwd, file);
      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const found: string[] = [];
      let m: RegExpExecArray | null;
      const re = new RegExp(IMPORT_RE);
      while ((m = re.exec(text))) found.push(m[1]);
      if (found.length) imports.push({ file, imports: [...new Set(found)] });
    }
    return imports;
  }

  findReferences(symbol: string, files = this.listFiles()): ReferenceInfo[] {
    const refs: ReferenceInfo[] = [];
    const word = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    for (const file of files) {
      const full = resolve(this.cwd, file);
      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (word.test(lines[i])) refs.push({ file, line: i + 1, text: lines[i].trim().slice(0, 160) });
      }
    }
    return refs;
  }

  private gitLog(file: string): Promise<string[]> {
    return new Promise((resolvePromise) => {
      if (!existsSync(resolve(this.cwd, '.git'))) return resolvePromise([]);
      execFile('git', ['log', '--oneline', '-5', '--', file], { cwd: this.cwd }, (error, stdout) => {
        if (error) return resolvePromise([]);
        const lines = String(stdout).trim().split('\n').filter(Boolean);
        resolvePromise(lines);
      });
    });
  }

  private scoreFile(query: string, file: string): number {
    const q = query.toLowerCase();
    const f = file.toLowerCase();
    if (f === q) return 100;
    if (f.includes(q)) return 60;
    const terms = q.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s/_\-.]+/).filter(Boolean);
    let score = 0;
    for (const term of terms) if (f.includes(term)) score += 10;
    if (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.py')) score += 2;
    return score;
  }

  async inspect(query: string, maxResults = 5): Promise<RetrievalResult> {
    const files = this.listFiles();
    const scoredFiles = files
      .map((f) => ({ file: f, score: this.scoreFile(query, f) }))
      .filter((x) => x.score >= 10)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((x) => x.file);

    const q = query.toLowerCase();
    const symbols = this.extractSymbols(files)
      .filter((s) => {
        const name = s.name.toLowerCase();
        if (name.length < 3) return false;
        return name === q || name.includes(q) || q.startsWith(name);
      })
      .slice(0, maxResults);

    const symbolNames = symbols.length ? symbols.map((s) => s.name) : [query];
    const references: ReferenceInfo[] = [];
    for (const name of symbolNames) {
      references.push(...this.findReferences(name, files).slice(0, maxResults));
    }

    const relevantFiles = [...new Set([...scoredFiles, ...symbols.map((s) => s.file), ...references.map((r) => r.file)])];
    const imports = this.extractImports(relevantFiles);
    const recentCommits: { file: string; commits: string[] }[] = [];
    for (const file of relevantFiles.slice(0, 5)) {
      recentCommits.push({ file, commits: await this.gitLog(file) });
    }

    const summary = [
      `Query: ${query}`,
      `Relevant files: ${relevantFiles.join(', ') || '(none)'}`,
      `Symbols: ${symbols.map((s) => `${s.name} (${s.file}:${s.line})`).join(', ') || '(none)'}`,
      `References: ${references.length}`,
      `Recent commits: ${recentCommits.filter((c) => c.commits.length).length}`,
    ].join('\n');

    return {
      query,
      files: relevantFiles,
      symbols,
      references: references.slice(0, maxResults * 2),
      imports,
      recentCommits,
      summary,
    };
  }
}
