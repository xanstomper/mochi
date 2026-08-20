// ambient.ts: repo-health watcher that drafts failure proposals.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { checkOnce, detectCommands, type AmbientReport } from './ambient.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-ambient-'));
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({
    name: 'x', scripts: { test: 'node failing.js', typecheck: 'node -e "process.exit(0)"' },
  }));
  writeFileSync(resolve(dir, 'failing.js'), 'console.log("boom"); process.exit(1);\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('ambient', () => {
  it('detects failing and passing commands from package.json', () => {
    const cmds = detectCommands(dir);
    expect(cmds.some((c) => c.includes('test'))).toBe(true);
    expect(cmds.some((c) => c.includes('typecheck'))).toBe(true);
  });

  it('checkOnce writes a proposal and calls onFailure for a failing command', async () => {
    let seen: AmbientReport | undefined;
    const reports = await checkOnce({
      cwd: dir,
      commands: ['node failing.js', 'node -e "process.exit(0)"'],
      onFailure: (r) => { seen = r; },
    });
    expect(reports.length).toBe(1); // only the failing command reports
    expect(seen?.exitCode).not.toBe(0);
    expect(seen?.outputTail).toContain('boom');
    expect(seen?.proposalPath).toBeTruthy();
    const body = readFileSync(seen!.proposalPath!, 'utf8');
    expect(body).toContain('Ambient failure proposal');
    expect(body).toContain('boom');
  }, 60_000);

  it('returns an empty list when everything passes', async () => {
    const reports = await checkOnce({ cwd: dir, commands: ['node -e "process.exit(0)"'] });
    expect(reports).toEqual([]);
  });
});