import type { Tool } from './types.js';
import { getFunctionSynapse, findCallers, typeHierarchy } from '../codegraph.js';

// TypeScript-AST + SQLite symbol graph (Code Property Graph-lite).
export const symbolTools: Tool[] = [
  {
    def: {
      name: 'get_function',
      description: 'Return the body of a named function/class/method/interface/type from the codebase (TypeScript AST symbol table).',
      parameters: [{ name: 'name', type: 'string', description: 'Symbol name', required: true }],
      permission: 'read',
    },
    async execute(args, ctx) { return getFunctionSynapse(ctx.cwd, String(args.name ?? '')); },
  },
  {
    def: {
      name: 'find_callers',
      description: 'Find call sites / references to a symbol across the repo from the code graph.',
      parameters: [{ name: 'name', type: 'string', description: 'Symbol name', required: true }],
      permission: 'read',
    },
    async execute(args, ctx) { return findCallers(ctx.cwd, String(args.name ?? '')); },
  },
  {
    def: {
      name: 'type_hierarchy',
      description: 'Return extends/implements/type relationships for a class, interface, or type.',
      parameters: [{ name: 'name', type: 'string', description: 'Type name', required: true }],
      permission: 'read',
    },
    async execute(args, ctx) { return typeHierarchy(ctx.cwd, String(args.name ?? '')); },
  },
];