import type { Tool } from './types.js';
import { diagnoseFile, renderDiagnostics } from '../diagnostics.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export const getDiagnosticsTool: Tool = {
  def: {
    name: 'get_diagnostics',
    description: 'Inspect type, syntax, and compiler diagnostics (TypeScript, Python, etc.) for a specific file or workspace root. Surfaces errors and warnings without running full test suites.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative path to the source file or directory to diagnose (default: .)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '').trim() || '.';
    const fullPath = resolve(ctx.cwd, rawPath);
    if (!existsSync(fullPath)) {
      return `Error: file not found at "${rawPath}".`;
    }

    try {
      const { statSync } = await import('node:fs');
      if (statSync(fullPath).isDirectory()) {
        const tsconfig = resolve(fullPath, 'tsconfig.json');
        if (existsSync(tsconfig)) {
          const { execFile } = await import('node:child_process');
          const tscResult = await new Promise<{ code: number; out: string }>((res) => {
            execFile('npx', ['tsc', '--noEmit'], { cwd: fullPath, timeout: 15_000 }, (err, stdout, stderr) => {
              const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code! : err ? 1 : 0;
              res({ code, out: `${stdout ?? ''}\n${stderr ?? ''}`.trim() });
            });
          });
          if (tscResult.code === 0) {
            return `[OK] No TypeScript diagnostics or compiler errors found in workspace (${rawPath}).`;
          }
          const lines = tscResult.out.split('\n').filter(Boolean).slice(0, 20);
          return `TypeScript compiler errors found in ${rawPath}:\n${lines.map((l) => `- ${l}`).join('\n')}`;
        }
        return `[OK] Workspace directory inspected at ${rawPath}. No compiler config detected.`;
      }

      const diag = await diagnoseFile(fullPath, ctx.cwd);
      if (diag.ok && diag.errors.length === 0 && diag.warnings.length === 0) {
        return `[OK] No diagnostics or syntax errors found in ${rawPath} (${diag.ms}ms).`;
      }
      return renderDiagnostics([diag]);
    } catch (err) {
      return `Diagnostic error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
