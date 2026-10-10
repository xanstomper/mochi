import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectMemory, recordProjectMemory, projectMemoryPrefix, projectMemoryPath } from './project-memory.js';

const dir = mkdtempSync(join(tmpdir(), 'mochi-pm-test-'));
mkdirSync(join(dir, '.mochi'), { recursive: true });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('project memory v2', () => {
  it('records and loads facts', () => {
    recordProjectMemory(dir, 'uses bun as the test runner');
    const mem = loadProjectMemory(dir);
    expect(mem).toContain('uses bun as the test runner');
  });

  it('dedupes near-duplicate facts (recency bump, not append)', () => {
    recordProjectMemory(dir, 'the build requires npm run build and build:bin');
    recordProjectMemory(dir, 'The build requires npm run build + build:bin!');
    const mem = loadProjectMemory(dir);
    const hits = mem.split('\n').filter((l) => l.includes('build:bin')).length;
    expect(hits).toBe(1); // replaced, not duplicated
  });

  it('dates new entries and bumps the date on re-learn', () => {
    const today = new Date().toISOString().slice(0, 10);
    recordProjectMemory(dir, 'deploy target is staging first');
    const first = readFileSync(projectMemoryPath(dir), 'utf8');
    expect(first).toContain(`[${today}] deploy target is staging first`);
    // Overwrite the file with an old date for the same fact, then re-record.
    const bumped = first.replace(`[${today}] deploy target is staging first`, '[2020-01-01] deploy target is staging first');
    writeFileSync(projectMemoryPath(dir), bumped);
    recordProjectMemory(dir, 'deploy target is staging first');
    const after = readFileSync(projectMemoryPath(dir), 'utf8');
    expect(after).not.toContain('[2020-01-01]');
    expect(after).toContain(`[${today}] deploy target is staging first`);
    // It must now be the LAST entry (recency bump to bottom).
    const lines = after.split('\n').filter((l) => l.trim());
    expect(lines[lines.length - 1]).toContain('deploy target is staging first');
  });

  it('prefix tags entries older than 30 days as stale', () => {
    // Write an old dated line directly.
    const mem = loadProjectMemory(dir) + '\n- [2020-06-01] ancient fact line';
    writeFileSync(projectMemoryPath(dir), mem);
    const p2 = projectMemoryPrefix(dir);
    expect(p2).toContain('ancient fact line (stale — verify)');
  });

  it('keeps facts distinct when similarity is below threshold', () => {
    recordProjectMemory(dir, 'the api base url is localhost 8705');
    recordProjectMemory(dir, 'the ui theme is dark with muted colors');
    const mem = loadProjectMemory(dir);
    expect(mem).toContain('localhost 8705');
    expect(mem).toContain('muted colors');
  });
});
