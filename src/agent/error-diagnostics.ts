// Intelligent Compiler & Test Error Diagnostic Parser.
// Automatically pinpoints exact failure locations across polyglot languages (TS, Python, Rust, Go, C/C++)
// and generates focused, context-aware code snippets to guide the agent harness directly to the fix.

import { existsSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

export interface CodeDiagnostic {
  filePath: string;
  line: number;
  column?: number;
  message: string;
  language: 'typescript' | 'python' | 'rust' | 'go' | 'cpp' | 'unknown';
  snippet?: string;
}

const TS_REGEX = /([^\s()]+?\.(?:ts|tsx|js|jsx)):(\d+):(\d+)\s*-\s*error\s*(TS\d+:\s*.+)/g;
const PY_FILE_REGEX = /File\s+["']([^"']+\.py)["'],\s+line\s+(\d+)(?:,\s+in\s+([^\n]+))?/g;
const RUST_REGEX = /error(?:\[E\d+\])?:\s*([^\n]+)\n\s*-->\s*([^\s:]+\.rs):(\d+):(\d+)/g;
const GO_REGEX = /([^\s()]+\.go):(\d+):(\d+):\s*([^\n]+)/g;
const CPP_REGEX = /([^\s()]+\.(?:cpp|cc|c|h|hpp)):(\d+):(\d+):\s*error:\s*([^\n]+)/g;

/** Parse tool output text for compiler, linter, or test failures */
export function parseCompilerDiagnostics(text: string, cwd: string): CodeDiagnostic[] {
  const results: CodeDiagnostic[] = [];
  const seen = new Set<string>();

  // 1. TypeScript / JavaScript errors
  let match: RegExpExecArray | null;
  while ((match = TS_REGEX.exec(text)) !== null) {
    const rawPath = match[1];
    const line = parseInt(match[2], 10);
    const col = parseInt(match[3], 10);
    const msg = match[4].trim();
    const key = `${rawPath}:${line}:${col}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({
        filePath: rawPath,
        line,
        column: col,
        message: msg,
        language: 'typescript',
      });
    }
  }

  // 2. Python traceback errors
  while ((match = PY_FILE_REGEX.exec(text)) !== null) {
    const rawPath = match[1];
    const line = parseInt(match[2], 10);
    const func = match[3] ? ` in ${match[3]}` : '';
    const key = `${rawPath}:${line}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({
        filePath: rawPath,
        line,
        message: `Python execution error${func}`,
        language: 'python',
      });
    }
  }

  // 3. Rust compiler errors
  while ((match = RUST_REGEX.exec(text)) !== null) {
    const msg = match[1].trim();
    const rawPath = match[2];
    const line = parseInt(match[3], 10);
    const col = parseInt(match[4], 10);
    const key = `${rawPath}:${line}:${col}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({
        filePath: rawPath,
        line,
        column: col,
        message: msg,
        language: 'rust',
      });
    }
  }

  // 4. Go compiler errors
  while ((match = GO_REGEX.exec(text)) !== null) {
    const rawPath = match[1];
    const line = parseInt(match[2], 10);
    const col = parseInt(match[3], 10);
    const msg = match[4].trim();
    const key = `${rawPath}:${line}:${col}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({
        filePath: rawPath,
        line,
        column: col,
        message: msg,
        language: 'go',
      });
    }
  }

  // 5. C / C++ compiler errors
  while ((match = CPP_REGEX.exec(text)) !== null) {
    const rawPath = match[1];
    const line = parseInt(match[2], 10);
    const col = parseInt(match[3], 10);
    const msg = match[4].trim();
    const key = `${rawPath}:${line}:${col}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({
        filePath: rawPath,
        line,
        column: col,
        message: msg,
        language: 'cpp',
      });
    }
  }

  // Hydrate with real file snippets if files exist on disk
  for (const diag of results) {
    try {
      const fullPath = isAbsolute(diag.filePath) ? diag.filePath : resolve(cwd, diag.filePath);
      if (existsSync(fullPath)) {
        const lines = readFileSync(fullPath, 'utf8').split('\n');
        const targetIdx = diag.line - 1;
        const start = Math.max(0, targetIdx - 2);
        const end = Math.min(lines.length - 1, targetIdx + 2);
        const snippetLines: string[] = [];

        for (let i = start; i <= end; i++) {
          const num = String(i + 1).padStart(4, ' ');
          const indicator = i === targetIdx ? ' > ' : '   ';
          snippetLines.push(`${indicator}${num} | ${lines[i]}`);
        }
        diag.snippet = snippetLines.join('\n');
      }
    } catch {}
  }

  return results;
}

/** Render parsed compiler diagnostics into a high-priority prompt advisory block */
export function renderCompilerAdvisory(diagnostics: CodeDiagnostic[]): string {
  if (!diagnostics.length) return '';

  const parts = ['\n[HARNESS COMPILER DIAGNOSTIC ADVISORY]'];
  parts.push('The previous command failed with explicit compiler/runtime errors:');

  for (const d of diagnostics.slice(0, 5)) {
    const loc = `${d.filePath}:${d.line}${d.column ? `:${d.column}` : ''}`;
    parts.push(`\n- 📍 **${loc}** (${d.language}): ${d.message}`);
    if (d.snippet) {
      parts.push('```\n' + d.snippet + '\n```');
    }
  }

  parts.push('\nAction: Focus specifically on fixing the error location(s) above before running checks again.');
  return parts.join('\n');
}
