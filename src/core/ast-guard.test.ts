import { describe, it, expect } from 'vitest';
import {
  validateJSON,
  validateBalancedStructure,
  validatePythonStructure,
  validateFileSyntax,
} from './ast-guard.js';

describe('In-Turn AST Diagnostic Guard', () => {
  it('validates JSON files and catches syntax errors with exact line numbers', () => {
    const valid = '{\n  "name": "mochi",\n  "version": 1\n}';
    expect(validateJSON(valid).valid).toBe(true);

    const invalid = '{\n  "name": "mochi",\n  "version": 1,\n}'; // trailing comma
    const res = validateJSON(invalid);
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.summary).toContain('JSON Syntax Error');
  });

  it('detects unclosed brackets and mismatched delimiters in TS/JS', () => {
    const valid = `
export function compute(a: number, b: number): number {
  if (a > b) {
    return a * (b + 1);
  }
  return 0;
}
`;
    expect(validateBalancedStructure(valid, 'javascript').valid).toBe(true);

    const missingBrace = `
export function compute(a: number, b: number): number {
  if (a > b) {
    return a * (b + 1);
  return 0;
}
`;
    const res = validateBalancedStructure(missingBrace, 'javascript');
    expect(res.valid).toBe(false);
    expect(res.summary).toContain('Unclosed opening bracket');
  });

  it('detects missing colons on python control statements', () => {
    const valid = `
def calculate_metrics(items):
    total = 0
    for item in items:
        if item > 0:
            total += item
    return total
`;
    expect(validatePythonStructure(valid).valid).toBe(true);

    const missingColon = `
def calculate_metrics(items)
    return sum(items)
`;
    const res = validatePythonStructure(missingColon);
    expect(res.valid).toBe(false);
    expect(res.summary).toContain("Missing colon ':'");
  });

  it('dispatches file syntax checks transparently by extension', () => {
    expect(validateFileSyntax('app.json', '{"ok": true}').valid).toBe(true);
    expect(validateFileSyntax('app.ts', 'const x = [1, 2, 3];').valid).toBe(true);
    expect(validateFileSyntax('app.py', 'def run():\n    pass\n').valid).toBe(true);
    expect(validateFileSyntax('app.rs', 'fn main() { println!("hi"); }').valid).toBe(true);
  });
});
