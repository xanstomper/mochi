import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { docsQueryTool, generateAdrTool } from './docs.js';
import type { ToolContext } from './types.js';

function makeCtx(dir: string): ToolContext {
  return {
    cwd: dir,
    agentId: 'test-agent',
    events: { emit: () => {} } as any,
  } as unknown as ToolContext;
}

describe('docs_query', () => {
  it('returns ranked chunks from project docs and nothing for junk queries', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-docs-query-'));
    try {
      mkdirSync(resolve(dir, 'docs'), { recursive: true });
      writeFileSync(
        resolve(dir, 'docs', 'auth.md'),
        '# Authentication\n\nWe use OAuth device flow for the CLI and a web login for the dashboard.\n',
      );
      writeFileSync(resolve(dir, 'docs', 'deploy.md'), '# Deployment\n\nSystemd units run the daemon on port 9119.\n');

      const hit = await docsQueryTool.execute({ query: 'oauth device flow' }, makeCtx(dir));
      expect(hit).toContain('auth.md');
      expect(hit).not.toContain('deploy.md');

      const miss = await docsQueryTool.execute({ query: 'quantum blockchain' }, makeCtx(dir));
      expect(miss).toMatch(/No documentation chunks matched/);

      await expect(docsQueryTool.execute({ query: '' }, makeCtx(dir))).rejects.toThrow(/query is required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects the root option and the limit cap', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-docs-query2-'));
    try {
      mkdirSync(resolve(dir, 'guide'), { recursive: true });
      for (let i = 0; i < 8; i++) {
        writeFileSync(resolve(dir, 'guide', `f${i}.md`), `# Topic ${i}\n\nEverything about the widget topic ${i}.\n`);
      }
      const out = await docsQueryTool.execute({ query: 'widget topic', root: 'guide', limit: 999 }, makeCtx(dir));
      const lines = out.split('\n').filter((l) => /^\d+\./.test(l));
      expect(lines.length).toBeLessThanOrEqual(20); // hard cap
      expect(lines.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generate_adr', () => {
  it('writes the next numbered ADR under docs/adr and validates input', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-docs-adr-'));
    try {
      const ctx = makeCtx(dir);
      const first = await generateAdrTool.execute(
        { title: 'Use device flow for CLI auth', context: 'No browser on servers.', decision: 'OAuth device flow.' },
        ctx,
      );
      expect(first).toContain('001-use-device-flow-for-cli-auth.md');
      const written = resolve(dir, 'docs', 'adr', '001-use-device-flow-for-cli-auth.md');
      expect(existsSync(written)).toBe(true);
      const body = readFileSync(written, 'utf8');
      expect(body).toContain('Status: accepted');
      expect(body).toContain('OAuth device flow.');

      const second = await generateAdrTool.execute(
        {
          title: 'Second decision',
          context: 'c',
          decision: 'd',
          status: 'proposed',
          tradeoffs: ['a', 'b'],
        },
        ctx,
      );
      expect(second).toContain('002-second.md');
      expect(readFileSync(resolve(dir, 'docs', 'adr', '002-second.md'), 'utf8')).toContain('Status: proposed');

      await expect(generateAdrTool.execute({ title: '', context: 'c', decision: 'd' }, ctx)).rejects.toThrow(/title/);
      await expect(generateAdrTool.execute({ title: 't', context: '', decision: 'd' }, ctx)).rejects.toThrow(/context/);
      await expect(
        generateAdrTool.execute({ title: 't', context: 'c', decision: 'd', status: 'maybe' }, ctx),
      ).rejects.toThrow(/status/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
