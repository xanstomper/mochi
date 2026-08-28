import type { Tool } from './types.js';
import { generateASTSlice } from '../core/ast-slicer.js';
import { resolve, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

export const astSliceTool: Tool = {
  def: {
    name: 'ast_slice',
    description:
      'Extracts a targeted JIT AST slice (function/class implementation, sibling type signatures, and immediate caller call-sites) without loading the full file. Saves 75-95% context tokens while preserving high reasoning fidelity.',
    parameters: [
      {
        name: 'path',
        type: 'string',
        description: 'Path to the source code file',
        required: true,
      },
      {
        name: 'symbol',
        type: 'string',
        description: 'Name of the function, class, interface, method, or type to slice',
        required: true,
      },
      {
        name: 'includeCallSites',
        type: 'boolean',
        description: 'Whether to include cross-file caller call sites (default true)',
        required: false,
      },
      {
        name: 'includeSiblingTypes',
        type: 'boolean',
        description: 'Whether to include sibling type definitions (default true)',
        required: false,
      },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '').trim();
    const symbol = String(args.symbol ?? '').trim();

    if (!rawPath || !symbol) {
      return 'Error: Both "path" and "symbol" parameters are required for ast_slice.';
    }

    const filePath = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
    if (!existsSync(filePath)) {
      return `Error: File not found at "${rawPath}".`;
    }

    const slice = await generateASTSlice({
      cwd: ctx.cwd,
      filePath,
      symbolName: symbol,
      includeSiblingTypes: args.includeSiblingTypes !== false,
      maxCallSites: args.includeCallSites === false ? 0 : 5,
    });

    if (!slice) {
      return `Error: Could not extract AST slice for "${symbol}" from "${rawPath}".`;
    }

    return slice.formattedSlice;
  },
};
