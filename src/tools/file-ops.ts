import type { Tool } from './types.js';
import { mkdirSync, renameSync, copyFileSync, cpSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export const mkdirTool: Tool = {
  def: {
    name: 'create_directory',
    description: 'Create a new directory (and any necessary parent directories) in the workspace.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative path of the directory to create', required: true },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '').trim();
    if (!rawPath) return 'Error: path parameter is required.';

    const fullPath = resolve(ctx.cwd, rawPath);
    try {
      if (existsSync(fullPath)) {
        return `Directory already exists at "${rawPath}".`;
      }
      mkdirSync(fullPath, { recursive: true });
      return `[OK] Created directory "${rawPath}".`;
    } catch (err) {
      return `Error creating directory: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const moveFileTool: Tool = {
  def: {
    name: 'move_file',
    description: 'Move or rename a file or directory from source path to destination path.',
    parameters: [
      { name: 'source', type: 'string', description: 'Relative path of the source file/directory', required: true },
      { name: 'destination', type: 'string', description: 'Relative path of the destination location', required: true },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const src = String(args.source ?? '').trim();
    const dest = String(args.destination ?? '').trim();
    if (!src || !dest) return 'Error: both source and destination parameters are required.';

    const fullSrc = resolve(ctx.cwd, src);
    const fullDest = resolve(ctx.cwd, dest);

    if (!existsSync(fullSrc)) {
      return `Error: source path does not exist at "${src}".`;
    }

    try {
      mkdirSync(dirname(fullDest), { recursive: true });
      renameSync(fullSrc, fullDest);
      return `[OK] Moved "${src}" → "${dest}".`;
    } catch (err) {
      return `Error moving file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const copyFileTool: Tool = {
  def: {
    name: 'copy_file',
    description: 'Copy a file or directory to a new destination path in the workspace.',
    parameters: [
      { name: 'source', type: 'string', description: 'Relative path of the source file/directory', required: true },
      { name: 'destination', type: 'string', description: 'Relative path of the target destination', required: true },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const src = String(args.source ?? '').trim();
    const dest = String(args.destination ?? '').trim();
    if (!src || !dest) return 'Error: both source and destination parameters are required.';

    const fullSrc = resolve(ctx.cwd, src);
    const fullDest = resolve(ctx.cwd, dest);

    if (!existsSync(fullSrc)) {
      return `Error: source path does not exist at "${src}".`;
    }

    try {
      mkdirSync(dirname(fullDest), { recursive: true });
      const stat = statSync(fullSrc);
      if (stat.isDirectory()) {
        cpSync(fullSrc, fullDest, { recursive: true });
      } else {
        copyFileSync(fullSrc, fullDest);
      }
      return `[OK] Copied "${src}" → "${dest}".`;
    } catch (err) {
      return `Error copying: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
