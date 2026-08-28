// Native tool: env
// Read/list .env files and environment variables safely, masking secrets.

import type { Tool } from './types.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_PATTERN = /KEY|SECRET|TOKEN|PASS|PWD|AUTH|CRED|PRIVATE/i;

function mask(key: string, value: string): string {
  return SECRET_PATTERN.test(key) ? '****' : value;
}

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export const envTool: Tool = {
  def: {
    name: 'env',
    description: 'Read, list, or write environment variables and .env files. Secret values are masked.',
    parameters: [
      { name: 'action', type: 'string', description: "'get' | 'list' | 'set' | 'load'", required: true },
      { name: 'key', type: 'string', description: 'Variable name (for get/set)', required: false },
      { name: 'value', type: 'string', description: 'Value to set', required: false },
      { name: 'file', type: 'string', description: '.env file path (default: .env)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const action = String(args.action || '').toLowerCase();
    const key = args.key ? String(args.key) : undefined;
    const value = args.value !== undefined ? String(args.value) : undefined;
    const file = args.file ? String(args.file) : '.env';
    const filePath = file.startsWith('/') ? file : join(ctx.cwd, file);

    switch (action) {
      case 'get': {
        if (!key) throw new Error('key is required for action=get');
        const val = process.env[key];
        if (val === undefined) return `${key}: (not set)`;
        return `${key}=${mask(key, val)}`;
      }
      case 'list': {
        const vars = existsSync(filePath) ? parseEnvFile(readFileSync(filePath, 'utf8')) : {};
        const env = { ...vars };
        if (!Object.keys(env).length) return 'No variables found.';
        return Object.entries(env).map(([k, v]) => `${k}=${mask(k, v)}`).join('\n');
      }
      case 'load': {
        if (!existsSync(filePath)) return `File not found: ${filePath}`;
        const vars = parseEnvFile(readFileSync(filePath, 'utf8'));
        const loaded: string[] = [];
        for (const [k, v] of Object.entries(vars)) {
          if (!process.env[k]) { process.env[k] = v; loaded.push(k); }
        }
        return `Loaded ${loaded.length} variable(s) from ${file}: ${loaded.join(', ') || 'none (all already set)'}`;
      }
      case 'set': {
        if (!key) throw new Error('key is required for action=set');
        if (value === undefined) throw new Error('value is required for action=set');
        let content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
        const lines = content.split('\n');
        const idx = lines.findIndex(l => l.startsWith(`${key}=`));
        const newLine = `${key}=${value}`;
        if (idx >= 0) lines[idx] = newLine; else lines.push(newLine);
        writeFileSync(filePath, lines.join('\n'));
        return `Set ${key}=${mask(key, value)} in ${file}`;
      }
      default:
        throw new Error(`Unknown env action: ${action}. Use get|list|set|load.`);
    }
  },
};
