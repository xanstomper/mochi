import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { Tool } from './types.js';

const MAX_TOTAL = 256_000;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function ripgrep(cwd: string, query: string, glob?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ['-n', '--no-heading', '--color=never', '-F', query];
    if (glob) args.push('-g', glob);
    const proc = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += String(c); if (out.length > MAX_TOTAL) out = out.slice(0, MAX_TOTAL) + '\n... [truncated]'; });
    proc.stderr.on('data', (c) => { err += String(c); });
    proc.on('close', (code) => {
      if (code !== 0 && out.length === 0) return resolve(null);
      resolve(out.trim());
    });
    proc.on('error', () => resolve(null));
  });
}

function* walkFiles(root: string, dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === '.git' || e === 'node_modules' || e === '.mochi') continue;
    const full = resolve(dir, e);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walkFiles(root, full);
    } else if (st.size < 5_000_000) {
      yield full;
    }
  }
}

function fallbackSearch(cwd: string, query: string, glob?: string): string {
  const regex = new RegExp(escapeRegex(query), 'i');
  const results: string[] = [];
  for (const full of walkFiles(cwd, cwd)) {
    if (glob) {
      const rel = relative(cwd, full).replace(/\\/g, '/');
      // naive glob check: pattern like *.ts -> endsWith .ts, **/*.{ts,js} -> splits
      const ok = glob.split(',').some((g) => {
        const ext = g.replace(/\*\//g, '').replace(/\*\*/g, '').replace(/\*/g, '');
        return rel.endsWith(ext);
      });
      if (!ok) continue;
    }
    let content: string;
    try { content = readFileSync(full, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        const rel = relative(cwd, full).replace(/\\/g, '/');
        results.push(`${rel}:${i + 1}:${lines[i].trim()}`);
        if (results.join('\n').length > MAX_TOTAL) return results.join('\n') + '\n... [truncated]';
      }
    }
  }
  return results.length ? results.join('\n') : 'No matches.';
}

export const searchTool: Tool = {
  def: {
    name: 'search',
    description: 'Search file contents for a literal string. Uses ripgrep when available, with a plain-text fallback.',
    parameters: [
      { name: 'query', type: 'string', description: 'Text to search', required: true },
      { name: 'glob', type: 'string', description: 'Optional file glob filter', required: false },
      { name: 'limit', type: 'integer', description: 'Maximum results', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const query = String(args.query ?? '');
    if (!query) throw new Error('No query provided');
    const rg = await ripgrep(ctx.cwd, query, args.glob ? String(args.glob) : undefined);
    if (rg) return rg;
    return fallbackSearch(ctx.cwd, query, args.glob ? String(args.glob) : undefined);
  },
};
