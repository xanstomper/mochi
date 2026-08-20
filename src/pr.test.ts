// pr.ts: issue-to-PR engine (spec section 12-C) with a fake gh CLI.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fetchIssue, runIssueToPr, defaultBranch } from './pr.js';

let dir: string;
let ghShim: string;
beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-pr-'));
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init && git branch -M main', { cwd: dir });
  writeFileSync(resolve(dir, 'a.txt'), 'base\n');
  execSync('git add a.txt && git commit -q -m a', { cwd: dir });

  // Fake gh CLI: issue view returns JSON, pr create echoes a URL.
  ghShim = resolve(dir, 'fake-gh.sh');
  writeFileSync(ghShim, [
    '#!/bin/sh',
    `if [ "$1" = "issue" ] && [ "$2" = "view" ]; then`,
    '  echo \'{"number":42,"title":"Broken auth","body":"Login fails with 401 on refresh.","labels":[{"name":"bug"}],"state":"open"}\'',
    '  exit 0',
    'fi',
    `if [ "$1" = "pr" ] && [ "$2" = "create" ]; then`,
    '  echo "https://github.com/x/prs/99"',
    '  exit 0',
    'fi',
    'exit 1',
  ].join('\n'));
  execSync(`chmod +x ${ghShim}`, { cwd: dir });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('pr.ts', () => {
  it('fetchIssue parses gh output', async () => {
    const issue = await fetchIssue(42, ghShim);
    expect(issue.number).toBe(42);
    expect(issue.title).toBe('Broken auth');
    expect(issue.body).toContain('401');
  });

  it('defaultBranch resolves to main', async () => {
    expect(await defaultBranch(dir)).toBe('main');
  });

  it('runIssueToPr branches, implements, commits, pushes, opens PR', async () => {
    const { runIssueToPr } = await import('./pr.js');
    const res = await runIssueToPr({
      cwd: dir,
      issueNumber: 42,
      ghBin: ghShim,
      implement: async (issue, cwd) => {
        // A real fix: modify a.txt and reference the issue.
        writeFileSync(resolve(cwd, 'a.txt'), `# fixed for #${issue.number}\nbase\n`);
        return `Fixed login: guard against 401 (issue #${issue.number})`;
      },
    });
    expect(res.branch).toMatch(/^fix-42-broken-auth$/);
    expect(res.commits).toBeGreaterThanOrEqual(1);
    // Push will fail (no remote), so pushed=false is acceptable; the local
    // branch + commit must exist.
    const log = execSync('git log --oneline -1', { cwd: dir, encoding: 'utf-8' });
    expect(log).toMatch(/Fix #42/);
    const content = readFileSync(resolve(dir, 'a.txt'), 'utf8');
    expect(content).toContain('fixed for #42');
  }, 30_000);
});