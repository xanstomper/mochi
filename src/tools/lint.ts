// Native tool: lint
// Auto-detects and runs project linters (eslint, biome, ruff, pylint, golangci-lint, clippy).

import type { Tool } from './types.js';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface LinterDef {
  configFiles: string[];
  buildCmd: (path: string, fix: boolean) => string;
  label: string;
}

const LINTERS: LinterDef[] = [
  {
    label: 'biome',
    configFiles: ['biome.json', 'biome.jsonc'],
    buildCmd: (p, fix) => fix ? `npx biome check --apply ${p}` : `npx biome check ${p}`,
  },
  {
    label: 'eslint',
    configFiles: ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs', 'eslint.config.js', 'eslint.config.mjs'],
    buildCmd: (p, fix) => fix ? `npx eslint --fix ${p}` : `npx eslint ${p}`,
  },
  {
    label: 'ruff',
    configFiles: ['ruff.toml', 'pyproject.toml'],
    buildCmd: (p, fix) => fix ? `ruff check --fix ${p}` : `ruff check ${p}`,
  },
  {
    label: 'pylint',
    configFiles: ['.pylintrc', 'setup.cfg'],
    buildCmd: (p, _fix) => `pylint ${p}`,
  },
  {
    label: 'golangci-lint',
    configFiles: ['.golangci.yml', '.golangci.yaml', '.golangci.json'],
    buildCmd: (p, fix) => fix ? `golangci-lint run --fix ${p}` : `golangci-lint run ${p}`,
  },
  {
    label: 'clippy',
    configFiles: ['Cargo.toml'],
    buildCmd: (_p, fix) => fix ? 'cargo clippy --fix --allow-dirty' : 'cargo clippy -- -D warnings',
  },
];

export const lintTool: Tool = {
  def: {
    name: 'lint',
    description: 'Auto-detect and run linter on a file or directory. Supports eslint, biome, ruff, pylint, golangci-lint, clippy.',
    parameters: [
      { name: 'path', type: 'string', description: 'File or directory to lint', required: true },
      { name: 'fix', type: 'boolean', description: 'Auto-fix issues where possible (default: false)', required: false },
    ],
    permission: 'shell',
  },
  async execute(args, ctx) {
    const path = String(args.path || '.');
    const fix = Boolean(args.fix);

    const detected = LINTERS.filter(l =>
      l.configFiles.some(cf => existsSync(join(ctx.cwd, cf)))
    );

    if (!detected.length) {
      return 'No linter configuration found. Supported: eslint, biome, ruff, pylint, golangci-lint, clippy.';
    }

    const results: string[] = [];
    for (const linter of detected) {
      const cmd = linter.buildCmd(path, fix);
      try {
        const out = execSync(cmd, { cwd: ctx.cwd, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
        results.push(`[${linter.label}] ${fix ? '✓ Fixed' : '✓ Clean'}\n${out.slice(0, 2000)}`);
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        const output = ((err.stdout || '') + (err.stderr || '')).slice(0, 2000);
        results.push(`[${linter.label}] Issues found:\n${output || err.message}`);
      }
    }
    return results.join('\n\n---\n\n');
  },
};
