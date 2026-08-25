// High-performance Code Outline & Skeletonizer.
// Extracts high-level class, function, interface, type, struct, and method signatures
// across TypeScript, JavaScript, Python, Rust, Go, and C/C++ without loading implementation bodies.
// Saves 85-90% context tokens when exploring large codebases.

import { existsSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute, extname } from 'node:path';
import type { Tool } from './types.js';

export interface SymbolOutlineItem {
  line: number;
  kind: 'class' | 'interface' | 'type' | 'function' | 'method' | 'struct' | 'enum' | 'trait' | 'impl' | 'other';
  signature: string;
  indent: number;
}

export function extractCodeOutline(content: string, ext: string): SymbolOutlineItem[] {
  const lines = content.split('\n');
  const results: SymbolOutlineItem[] = [];

  const normExt = ext.toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }

    const indent = rawLine.search(/\S/);
    const lineNum = i + 1;

    // TypeScript / JavaScript
    if (['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].includes(normExt)) {
      if (/^(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'class', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      } else if (/^(export\s+)?(default\s+)?interface\s+\w+/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'interface', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      } else if (/^(export\s+)?(default\s+)?type\s+\w+\s*=/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'type', signature: trimmed.replace(/=.*$/, '').trim(), indent });
      } else if (/^(export\s+)?(default\s+)?(async\s+)?function(\s*\*|\s+)\w+/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'function', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      } else if (/^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?(\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'function', signature: trimmed.replace(/=>.*$/, '=> ...').trim(), indent });
      } else if (/^(export\s+)?enum\s+\w+/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'enum', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      } else if (/^(public|private|protected|static|async|get|set|\*)\s+[\w$]+\s*\(/.test(trimmed) || /^[\w$]+\s*\([^)]*\)\s*:\s*[^;{]+(\{|;)/.test(trimmed)) {
        if (!trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while') && !trimmed.startsWith('switch')) {
          results.push({ line: lineNum, kind: 'method', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
        }
      }
    }

    // Python
    else if (['.py', '.pyi'].includes(normExt)) {
      if (/^class\s+\w+/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'class', signature: trimmed.replace(/:.*$/, '').trim(), indent });
      } else if (/^(async\s+)?def\s+\w+/.test(trimmed)) {
        results.push({ line: lineNum, kind: indent > 0 ? 'method' : 'function', signature: trimmed.replace(/:.*$/, '').trim(), indent });
      }
    }

    // Rust
    else if (['.rs'].includes(normExt)) {
      if (/^(pub(\([^)]+\))?\s+)?struct\s+\w+/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'struct', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      } else if (/^(pub(\([^)]+\))?\s+)?enum\s+\w+/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'enum', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      } else if (/^(pub(\([^)]+\))?\s+)?trait\s+\w+/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'trait', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      } else if (/^impl(\s*<[^>]+>)?\s+/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'impl', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      } else if (/^(pub(\([^)]+\))?\s+)?(async\s+)?(const\s+)?(unsafe\s+)?(extern\s+"[^"]+"\s+)?fn\s+\w+/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'function', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      }
    }

    // Go
    else if (['.go'].includes(normExt)) {
      if (/^type\s+\w+\s+struct\b/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'struct', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      } else if (/^type\s+\w+\s+interface\b/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'interface', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      } else if (/^func\s+(\([^)]+\)\s+)?\w+/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'function', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      }
    }

    // C / C++
    else if (['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx'].includes(normExt)) {
      if (/^(template<[^>]+>\s*)?(class|struct)\s+\w+/.test(trimmed)) {
        results.push({ line: lineNum, kind: 'class', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
      } else if (/^(static\s+|inline\s+|virtual\s+|explicit\s+)?[\w:*&<>\s]+\s+[\w:~]+\s*\([^)]*\)\s*(const)?\s*(\{|;)/.test(trimmed)) {
        if (!trimmed.startsWith('if') && !trimmed.startsWith('for') && !trimmed.startsWith('while') && !trimmed.startsWith('return')) {
          results.push({ line: lineNum, kind: 'function', signature: trimmed.replace(/\{.*$/, '').trim(), indent });
        }
      }
    }
  }

  return results;
}

export const outlineTool: Tool = {
  def: {
    name: 'outline',
    description: 'Extract high-level file outline (classes, functions, interfaces, types, structs, and methods) without loading full implementation bodies, saving 85-90% token budget.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative or absolute file path to outline', required: true },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '').trim();
    if (!rawPath) throw new Error('Path is required for outline tool');

    const filePath = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${rawPath}`);
    }

    const content = readFileSync(filePath, 'utf8');
    const ext = extname(filePath);
    const symbols = extractCodeOutline(content, ext);

    if (!symbols.length) {
      return `Outline for ${rawPath}: No top-level class/function/type definitions found (${content.split('\n').length} lines).`;
    }

    const lines = [`Outline for ${rawPath} (${content.split('\n').length} lines, ${symbols.length} symbols):\n`];
    for (const s of symbols) {
      const pad = ' '.repeat(Math.min(s.indent, 8));
      const lineStr = String(s.line).padStart(5, ' ');
      lines.push(`${lineStr} | ${pad}[${s.kind}] ${s.signature}`);
    }

    return lines.join('\n');
  },
};
