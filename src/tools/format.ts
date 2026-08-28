// Native tool: format
// Auto-detects and runs code formatters (prettier, biome, black, gofmt, rustfmt).

import type { Tool } from './types.js';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';

interface FormatterDef {
  label: string;
  configFiles: string[];
  extensions?: string[];
  buildCmd: (path: string, check: boolean) => string;
}

const FORMATTERS: FormatterDef[] = [
  {
    label: 'biome',
    configFiles: ['biome.json', 'biome.jsonc'],
    buildCmd: (p, check) => check ? `npx biome format ${p}` : `npx biome format --write ${p}`,
  },
  {
    label: 'prettier',
    configFiles: ['.prettierrc', '.prettierrc.js', '.prettierrc.json', 'prettier.config.js'],
    buildCmd: (p, check) => check ? `npx prettier --check ${p}` : `npx prettier --write ${p}`,
  },
  {
    label: 'black',
    configFiles: ['pyproject.toml', '.black'],
    extensions: ['.py'],
    buildCmd: (p, check) => check ? `black --check ${p}` : `black ${p}`,
  },
  {
    label: 'gofmt',
    configFiles: ['go.mod'],
    extensions: ['.go'],
    buildCmd: (p, check) => check ? `gofmt -l ${p}` : `gofmt -w ${p}`,
  },
  {
    label: 'rustfmt',
    configFiles: ['Cargo.toml'],
    extensions: ['.rs'],
    buildCmd: (p, check) => check ? `rustfmt --check ${p}` : `rustfmt ${p}`,
  },
];

export const formatTool: Tool = {
  def: {
    name: 'format',
    description: 'Auto-detect and run code formatter. Supports prettier, biome, black, gofmt, rustfmt.',
    parameters: [
      { name: 'path', type: 'string', description: 'File or directory to format', required: true },
      { name: 'check', type: 'boolean', description: 'Dry-run: only check, do not write (default: false)', required: false },
    ],
    permission: 'shell',
  },
  async execute(args, ctx) {
    const path = String(args.path || '.');
    const check = Boolean(args.check);
    const ext = extname(path);

    const detected = FORMATTERS.filter(f => {
      const configMatch = f.configFiles.some(cf => existsSync(join(ctx.cwd, cf)));
      const extMatch = !f.extensions || !ext || f.extensions.includes(ext);
      return configMatch && extMatch;
    });

    if (!detected.length) {
      return 'No formatter configuration found. Supported: prettier, biome, black, gofmt, rustfmt.';
    }

    const results: string[] = [];
    for (const fmt of detected.slice(0, 1)) { // use first matching (most specific)
      const cmd = fmt.buildCmd(path, check);
      try {
        const out = execSync(cmd, { cwd: ctx.cwd, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
        results.push(`[${fmt.label}] ${check ? 'Check' : 'Formatted'}: ${path}\n${out.slice(0, 1000)}`);
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        const output = ((err.stdout || '') + (err.stderr || '')).trim().slice(0, 1000);
        results.push(`[${fmt.label}] ${check ? 'Not formatted' : 'Error'}:\n${output || err.message}`);
      }
    }
    return results.join('\n');
  },
};
