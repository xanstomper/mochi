import type { Tool } from './types.js';
import { diagnoseFile, renderDiagnostics } from '../diagnostics.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export const getDiagnosticsTool: Tool = {
  def: {
    name: 'get_diagnostics',
    description: 'Inspect type, syntax, and compiler diagnostics (TypeScript, Python, etc.) for a specific file or touched workspace files. Surfaces errors and warnings without running full test suites.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative path to the source file to diagnose', required: true },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '').trim();
    if (!rawPath) return 'Error: path parameter is required.';

    const fullPath = resolve(ctx.cwd, rawPath);
    if (!existsSync(fullPath)) {
      return `Error: file not found at "${rawPath}".`;
    }

    try {
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
