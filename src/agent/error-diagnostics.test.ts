import { describe, expect, it } from 'vitest';
import { parseCompilerDiagnostics, renderCompilerAdvisory } from './error-diagnostics.js';

describe('Compiler & Test Error Diagnostics', () => {
  it('parses TypeScript compiler errors accurately', () => {
    const output = `
src/foo.ts:42:15 - error TS2339: Property 'bar' does not exist on type 'User'.
src/bar.tsx:10:3 - error TS2304: Cannot find name 'React'.
    `;

    const diags = parseCompilerDiagnostics(output, '/tmp');
    expect(diags).toHaveLength(2);
    expect(diags[0].filePath).toBe('src/foo.ts');
    expect(diags[0].line).toBe(42);
    expect(diags[0].column).toBe(15);
    expect(diags[0].message).toContain('TS2339');
    expect(diags[0].language).toBe('typescript');

    expect(diags[1].filePath).toBe('src/bar.tsx');
    expect(diags[1].line).toBe(10);
  });

  it('parses Python traceback errors accurately', () => {
    const output = `
Traceback (most recent call last):
  File "app/main.py", line 88, in process_request
    raise ValueError("invalid data")
ValueError: invalid data
    `;

    const diags = parseCompilerDiagnostics(output, '/tmp');
    expect(diags).toHaveLength(1);
    expect(diags[0].filePath).toBe('app/main.py');
    expect(diags[0].line).toBe(88);
    expect(diags[0].language).toBe('python');
  });

  it('parses Rust compiler error locations', () => {
    const output = `
error[E0308]: mismatched types
  --> src/main.rs:12:5
   |
12 |     let x: u32 = "hello";
   |                  ^^^^^^^ expected \`u32\`, found \`&str\`
    `;

    const diags = parseCompilerDiagnostics(output, '/tmp');
    expect(diags).toHaveLength(1);
    expect(diags[0].filePath).toBe('src/main.rs');
    expect(diags[0].line).toBe(12);
    expect(diags[0].column).toBe(5);
    expect(diags[0].language).toBe('rust');
  });

  it('renders a formatted advisory message', () => {
    const diags = [
      {
        filePath: 'src/calc.ts',
        line: 25,
        column: 8,
        message: "TS2322: Type 'string' is not assignable to type 'number'.",
        language: 'typescript' as const,
        snippet: '   24 | function add(a: number, b: number) {\n > 25 |   return "sum";\n   26 | }',
      },
    ];

    const advisory = renderCompilerAdvisory(diags);
    expect(advisory).toContain('[HARNESS COMPILER DIAGNOSTIC ADVISORY]');
    expect(advisory).toContain('src/calc.ts:25:8');
    expect(advisory).toContain('return "sum"');
  });
});
