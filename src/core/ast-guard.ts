// In-Memory In-Turn AST Diagnostic Guard for Mochi
// Performs sub-millisecond static syntax and structural validation on file modifications
// before the agent completes its turn, enabling instant self-correction without running slow CLI test suites.

import { extname } from 'node:path';

export interface ASTDiagnosticError {
  line: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface ASTDiagnosticResult {
  valid: boolean;
  errors: ASTDiagnosticError[];
  summary?: string;
}

/** Validates JSON syntax and isolates exact error line */
export function validateJSON(content: string): ASTDiagnosticResult {
  try {
    JSON.parse(content);
    return { valid: true, errors: [] };
  } catch (err: any) {
    const msg = String(err.message || 'JSON Parse error');
    let line = 1;
    const posMatch = msg.match(/position\s+(\d+)/i);
    if (posMatch) {
      const pos = Number(posMatch[1]);
      line = content.slice(0, pos).split('\n').length;
    } else {
      const lineMatch = msg.match(/line\s+(\d+)/i);
      if (lineMatch) line = Number(lineMatch[1]);
    }
    return {
      valid: false,
      errors: [{ line, message: msg, severity: 'error' }],
      summary: `JSON Syntax Error at line ${line}: ${msg}`,
    };
  }
}

/** Validates bracket/brace/parenthesis nesting and unclosed strings across source files */
export function validateBalancedStructure(content: string, language: string): ASTDiagnosticResult {
  const lines = content.split(/\r?\n/);
  const errors: ASTDiagnosticError[] = [];
  const stack: { char: string; line: number; col: number }[] = [];

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplateString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    inLineComment = false;

    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      const prev = c > 0 ? line[c - 1] : '';
      const next = c + 1 < line.length ? line[c + 1] : '';

      // Handle comments
      if (!inSingleQuote && !inDoubleQuote && !inTemplateString) {
        if (!inBlockComment && ch === '/' && next === '/') {
          inLineComment = true;
          break; // skip rest of line
        }
        if (!inBlockComment && (ch === '#' && (language === 'python' || language === 'yaml' || language === 'sh'))) {
          inLineComment = true;
          break;
        }
        if (!inBlockComment && ch === '/' && next === '*') {
          inBlockComment = true;
          c++;
          continue;
        }
        if (inBlockComment && ch === '*' && next === '/') {
          inBlockComment = false;
          c++;
          continue;
        }
      }

      if (inBlockComment || inLineComment) continue;

      // Handle string quotes with escape support
      if (ch === "'" && !inDoubleQuote && !inTemplateString && prev !== '\\') {
        inSingleQuote = !inSingleQuote;
        continue;
      }
      if (ch === '"' && !inSingleQuote && !inTemplateString && prev !== '\\') {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }
      if (ch === '`' && !inSingleQuote && !inDoubleQuote && prev !== '\\') {
        inTemplateString = !inTemplateString;
        continue;
      }

      if (inSingleQuote || inDoubleQuote || inTemplateString) continue;

      // Check brackets
      if (ch === '{' || ch === '(' || ch === '[') {
        stack.push({ char: ch, line: l + 1, col: c + 1 });
      } else if (ch === '}' || ch === ')' || ch === ']') {
        if (stack.length === 0) {
          errors.push({
            line: l + 1,
            column: c + 1,
            message: `Unmatched closing bracket '${ch}' with no opening pair`,
            severity: 'error',
          });
        } else {
          const top = stack.pop()!;
          const expected = top.char === '{' ? '}' : top.char === '(' ? ')' : ']';
          if (ch !== expected) {
            errors.push({
              line: l + 1,
              column: c + 1,
              message: `Mismatched bracket '${ch}', expected '${expected}' matching '${top.char}' from line ${top.line}`,
              severity: 'error',
            });
          }
        }
      }
    }

    // Check unclosed single-line strings
    if ((inSingleQuote || inDoubleQuote) && !inTemplateString && language !== 'python') {
      // In JS/TS/Go/Rust, regular strings cannot span multiple lines without escape
      if (line.endsWith('\\')) {
        // Escaped newline, allowed
      } else {
        errors.push({
          line: l + 1,
          message: `Unclosed string literal on line ${l + 1}`,
          severity: 'error',
        });
        inSingleQuote = false;
        inDoubleQuote = false;
      }
    }
  }

  // Any unclosed brackets left on stack
  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1];
    errors.push({
      line: unclosed.line,
      column: unclosed.col,
      message: `Unclosed opening bracket '${unclosed.char}' at line ${unclosed.line}`,
      severity: 'error',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    summary: errors.length > 0 ? errors.map((e) => `Line ${e.line}: ${e.message}`).join('; ') : undefined,
  };
}

/** Python indentation and header colon validator */
export function validatePythonStructure(content: string): ASTDiagnosticResult {
  const balanced = validateBalancedStructure(content, 'python');
  if (!balanced.valid) return balanced;

  const lines = content.split(/\r?\n/);
  const errors: ASTDiagnosticError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Check missing colons on def / class / if / elif / else / for / while / with / try / except / finally
    const needsColon = /^(def\s+\w+.*|class\s+\w+.*|if\s+.*|elif\s+.*|else|for\s+.*|while\s+.*|with\s+.*|try|except.*|finally)$/;
    if (needsColon.test(trimmed) && !trimmed.endsWith(':') && !trimmed.includes('"""') && !trimmed.includes("'''")) {
      errors.push({
        line: i + 1,
        message: `Missing colon ':' at the end of statement: "${trimmed}"`,
        severity: 'error',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    summary: errors.length > 0 ? errors.map((e) => `Line ${e.line}: ${e.message}`).join('; ') : undefined,
  };
}

/** Fast, universal static validator dispatching based on file extension */
export function validateFileSyntax(filePath: string, content: string): ASTDiagnosticResult {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.json') {
    return validateJSON(content);
  }

  if (['.py', '.pyi'].includes(ext)) {
    return validatePythonStructure(content);
  }

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)) {
    return validateBalancedStructure(content, 'javascript');
  }

  if (['.rs', '.go', '.c', '.cpp', '.h', '.hpp', '.java'].includes(ext)) {
    return validateBalancedStructure(content, 'c-family');
  }

  return { valid: true, errors: [] };
}
