import type { Tool } from './types.js';
import { getFunctionSynapse, findCallers, typeHierarchy, ensureParserLoaded } from '../codegraph.js';

// Code Property Graph-lite: tree-sitter (WASM) + SQLite symbol graph across
// TS/JS, Python, Rust, Go, Java, and C/C++.
//
// The tree-sitter runtime loads asynchronously at module init; await
// ensureParserLoaded() before the first read so a fresh process always uses
// the full polyglot index instead of silently degrading to the tsc backend
// (which only understands JS/TS) on the first tool call.
async function ready(): Promise<void> {
  await ensureParserLoaded();
}

export const symbolTools: Tool[] = [
  {
    def: {
      name: 'get_function',
      description: 'Return the body of a named function/class/method/interface/type from the codebase. Works for TS/JS, Python, Rust, Go, Java, and C/C++ (tree-sitter symbol index).',
      parameters: [{ name: 'name', type: 'string', description: 'Symbol name', required: true }],
      permission: 'read',
    },
    async execute(args, ctx) {
      await ready();
      return getFunctionSynapse(ctx.cwd, String(args.name ?? ''));
    },
  },
  {
    def: {
      name: 'find_callers',
      description: 'Find call sites / references to a symbol across the repo from the code graph (all indexed languages).',
      parameters: [{ name: 'name', type: 'string', description: 'Symbol name', required: true }],
      permission: 'read',
    },
    async execute(args, ctx) {
      await ready();
      return findCallers(ctx.cwd, String(args.name ?? ''));
    },
  },
  {
    def: {
      name: 'type_hierarchy',
      description: 'Return extends/implements/type relationships for a class, interface, or type. Works for class/struct/interface definitions in indexed languages.',
      parameters: [{ name: 'name', type: 'string', description: 'Type name', required: true }],
      permission: 'read',
    },
    async execute(args, ctx) {
      await ready();
      return typeHierarchy(ctx.cwd, String(args.name ?? ''));
    },
  },
];