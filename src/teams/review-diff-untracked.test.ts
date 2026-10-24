import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureReviewDiff } from './subagent-runtime.js';
import { execFileSync } from 'node:child_process';

describe('captureReviewDiff untracked content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-crd-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('inlines capped snippets of untracked file contents, not just names', async () => {
    const run = (args: string[]) => execFileSync('git', args, { cwd: dir });
    run(['init', '-q']);
    run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't']);
    writeFileSync(join(dir, 'base.ts'), 'export const a = 1;\n');
    run(['add', '.']); run(['commit', '-qm', 'base']);
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'new-test.ts'), 'import { expect } from "vitest";\n'.repeat(400).slice(0, 6000));

    const { label, diff } = await captureReviewDiff(dir, 'working');
    expect(label).toBe('working tree vs HEAD');
    expect(diff).toContain('[Untracked file: sub/new-test.ts]');
    expect(diff).toContain('import { expect } from "vitest";');
    expect(diff).toContain('… [truncated]'); // 6KB body capped at 4K
  });
});
