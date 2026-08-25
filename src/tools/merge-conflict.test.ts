import { describe, expect, it } from 'vitest';
import { parseConflictBlocks, resolveConflictsInContent } from './merge-conflict.js';

describe('Merge Conflict Tool', () => {
  const sampleConflict = `
import { a } from './a';

<<<<<<< HEAD
const version = '1.0.0';
const isDev = false;
=======
const version = '2.0.0';
const isDev = true;
>>>>>>> feature-branch

export function run() {
  return version;
}
  `.trim();

  it('parses conflict markers accurately', () => {
    const blocks = parseConflictBlocks(sampleConflict);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].ourBranch).toBe('HEAD');
    expect(blocks[0].theirBranch).toBe('feature-branch');
    expect(blocks[0].ours).toContain("version = '1.0.0'");
    expect(blocks[0].theirs).toContain("version = '2.0.0'");
  });

  it('resolves using ours strategy', () => {
    const resolved = resolveConflictsInContent(sampleConflict, 'ours');
    expect(resolved).toContain("const version = '1.0.0';");
    expect(resolved).not.toContain("const version = '2.0.0';");
    expect(resolved).not.toContain('<<<<<<<');
    expect(resolved).not.toContain('>>>>>>>');
  });

  it('resolves using theirs strategy', () => {
    const resolved = resolveConflictsInContent(sampleConflict, 'theirs');
    expect(resolved).toContain("const version = '2.0.0';");
    expect(resolved).not.toContain("const version = '1.0.0';");
    expect(resolved).not.toContain('<<<<<<<');
    expect(resolved).not.toContain('>>>>>>>');
  });

  it('resolves using both strategy', () => {
    const resolved = resolveConflictsInContent(sampleConflict, 'both');
    expect(resolved).toContain("const version = '1.0.0';");
    expect(resolved).toContain("const version = '2.0.0';");
    expect(resolved).not.toContain('<<<<<<<');
  });
});
