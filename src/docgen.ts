// Codebase Architecture Visualizer & Auto-Documentation Generator.
// Analyzes code outlines, class hierarchies, and symbol dependencies to produce
// clean Markdown API documentation and Mermaid architecture flowcharts.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, extname, relative } from 'node:path';
import { extractCodeOutline, type SymbolOutlineItem } from './tools/outline.js';

export interface ModuleDoc {
  file: string;
  symbols: SymbolOutlineItem[];
  imports: string[];
}

export interface ProjectDocs {
  title: string;
  moduleCount: number;
  symbolCount: number;
  modules: ModuleDoc[];
  mermaidDiagram: string;
  markdown: string;
}

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.cpp', '.c']);

/** Find all source code files in the directory */
function scanSourceFiles(dir: string, maxFiles = 100): string[] {
  const files: string[] = [];
  const stack = [dir];

  while (stack.length && files.length < maxFiles) {
    const curr = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(curr, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') {
        continue;
      }
      const full = resolve(curr, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && CODE_EXTS.has(extname(entry.name).toLowerCase())) {
        files.push(full);
      }
    }
  }

  return files;
}

/** Extract import targets from source code */
function extractImports(content: string): string[] {
  const imports: string[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/(?:import|from)\s+['"]([^'"]+)['"]/);
    if (m && !m[1].startsWith('.')) {
      imports.push(m[1]);
    } else if (m) {
      imports.push(m[1].replace(/^\.\.?\//, ''));
    }
  }
  return [...new Set(imports)];
}

/** Generate full project documentation and Mermaid architecture diagram */
export function generateProjectDocs(cwd: string, opts: { title?: string } = {}): ProjectDocs {
  const title = opts.title || 'Project Architecture & API Reference';
  const files = scanSourceFiles(cwd);
  const modules: ModuleDoc[] = [];

  let totalSymbols = 0;

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf8');
      const ext = extname(file);
      const symbols = extractCodeOutline(content, ext);
      const imports = extractImports(content);
      const relPath = relative(cwd, file);

      if (symbols.length > 0) {
        totalSymbols += symbols.length;
        modules.push({ file: relPath, symbols, imports });
      }
    } catch {}
  }

  // Build Mermaid Diagram
  const diagramLines = ['```mermaid', 'graph TD;'];
  for (const mod of modules.slice(0, 15)) {
    const modId = mod.file.replace(/[^a-zA-Z0-9]/g, '_');
    const label = `${mod.file} (${mod.symbols.length} symbols)`;
    diagramLines.push(`  ${modId}["${label}"]`);

    for (const imp of mod.imports.slice(0, 3)) {
      const targetMod = modules.find((m) => m.file.includes(imp));
      if (targetMod) {
        const targetId = targetMod.file.replace(/[^a-zA-Z0-9]/g, '_');
        if (targetId !== modId) {
          diagramLines.push(`  ${modId} --> ${targetId}`);
        }
      }
    }
  }
  diagramLines.push('```');
  const mermaidDiagram = diagramLines.join('\n');

  // Build Markdown Document
  const mdLines = [
    `# 🍡 ${title}`,
    '',
    `> Automatically generated architecture graph and API specification.`,
    `> **Modules**: ${modules.length} | **Total Symbols**: ${totalSymbols}`,
    '',
    '## 🏗️ Architecture Diagram',
    '',
    mermaidDiagram,
    '',
    '## 📦 Modules & API Reference',
    '',
  ];

  for (const mod of modules) {
    mdLines.push(`### \`${mod.file}\``);
    mdLines.push('| Line | Kind | Signature |');
    mdLines.push('| :--- | :--- | :--- |');
    for (const s of mod.symbols) {
      const safeSig = s.signature.replace(/\|/g, '\\|');
      mdLines.push(`| ${s.line} | \`${s.kind}\` | \`${safeSig}\` |`);
    }
    mdLines.push('');
  }

  const markdown = mdLines.join('\n');

  return {
    title,
    moduleCount: modules.length,
    symbolCount: totalSymbols,
    modules,
    mermaidDiagram,
    markdown,
  };
}
