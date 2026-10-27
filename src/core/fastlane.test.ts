import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FASTLANE_LIMITS,
  countRepoFiles,
  decideFastLane,
  fastLaneEscalationReason,
  fastLaneToolNames,
  referencedFilesFor,
  resolveFastLaneEnabled,
  type FastLaneInput,
} from './fastlane.js';

function input(over: Partial<FastLaneInput> = {}): FastLaneInput {
  return {
    kind: 'fix',
    complexity: 'simple',
    complexityScore: 2,
    referencedFiles: ['src/a.ts'],
    textChars: 120,
    acceptanceCriteria: 1,
    chameleonDifficulty: 2,
    repoFiles: 100,
    simpleScript: false,
    trivialWrite: true,
    ...over,
  };
}

describe('fast lane entry (core/fastlane.ts)', () => {
  it('enters on positive proof only', () => {
    const d = decideFastLane(input(), true);
    expect(d.eligible).toBe(true);
    expect(d.reasons.join(' ')).toContain('kind=fix');
  });

  it('refuses every disqualifying signal', () => {
    expect(decideFastLane(input(), false).eligible).toBe(false);
    expect(decideFastLane(input({ kind: 'research' }), true).eligible).toBe(false);
    expect(decideFastLane(input({ role: 'architect' }), true).eligible).toBe(false);
    expect(decideFastLane(input({ complexity: 'complex' }), true).eligible).toBe(false);
    expect(decideFastLane(input({ complexity: 'standard', complexityScore: FASTLANE_LIMITS.maxComplexityScore + 1 }), true).eligible).toBe(false);
    expect(decideFastLane(input({ chameleonDifficulty: FASTLANE_LIMITS.maxChameleonDifficulty + 1 }), true).eligible).toBe(false);
    expect(decideFastLane(input({ acceptanceCriteria: 5 }), true).eligible).toBe(false);
    expect(decideFastLane(input({ repoFiles: FASTLANE_LIMITS.maxRepoFiles + 1 }), true).eligible).toBe(false);
    expect(decideFastLane(input({ textChars: FASTLANE_LIMITS.maxTextChars + 1 }), true).eligible).toBe(false);
    expect(decideFastLane(input({ referencedFiles: ['a.ts', 'b.ts', 'c.ts'] }), true).eligible).toBe(false);
  });

  it('a low "standard" score is lane-eligible (textbook one-file fixes score 3: +2 mutate-repo, +1 multi-sentence)', () => {
    const d = decideFastLane(input({ complexity: 'standard', complexityScore: 3 }), true);
    expect(d.eligible).toBe(true);
    expect(d.reasons.join(' ')).toContain('complexity=standard (score 3)');
  });

  it('extracts referenced paths from title, description and criteria', () => {
    const files = referencedFilesFor({
      title: 'fix src/a.ts',
      description: 'see ./src/b.tsx and test/a.test.ts',
      acceptanceCriteria: ['src/c.py passes', 'src/a.ts still works'],
    });
    expect(files).toContain('src/a.ts');
    expect(files).toContain('src/b.tsx');
    expect(files).toContain('test/a.test.ts');
    expect(files).toContain('src/c.py');
    expect(new Set(files).size).toBe(files.length);
  });

  it('counts repo files but ignores dependency/build trees', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-fastlane-'));
    writeFileSync(join(dir, 'a.ts'), 'x');
    writeFileSync(join(dir, 'b.ts'), 'x');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'ignored.ts'), 'x');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'c.ts'), 'x');
    expect(countRepoFiles(dir)).toBe(3);
  });

  it('escalates on struggle evidence, not on hope', () => {
    const base = { filesEdited: 0, filesRead: 0, toolErrors: 0, consecutiveVerifyFailures: 0, loadToolsCalls: 0, iteration: 1 };
    expect(fastLaneEscalationReason(base)).toBeNull();
    expect(fastLaneEscalationReason({ ...base, filesEdited: FASTLANE_LIMITS.maxFilesEdited + 1 })).toBe('edits-exceeded');
    expect(fastLaneEscalationReason({ ...base, consecutiveVerifyFailures: FASTLANE_LIMITS.maxVerifyFailures })).toBe('verify-failures');
    expect(fastLaneEscalationReason({ ...base, toolErrors: FASTLANE_LIMITS.maxToolErrors })).toBe('tool-errors');
    expect(fastLaneEscalationReason({ ...base, iteration: FASTLANE_LIMITS.maxIterations })).toBe('turn-budget');
  });

  it('lane tool profiles stay lean', () => {
    for (const kind of ['fix', 'test', 'refactor'] as const) {
      const names = fastLaneToolNames(kind);
      expect(names).toContain('read');
      expect(names).toContain('load_tools');
      expect(names.length).toBeLessThanOrEqual(22);
    }
    expect(fastLaneToolNames('test')).not.toContain('delete');
  });

  it('kill switch wins over config', () => {
    const prev = process.env.MOCHI_FASTLANE;
    process.env.MOCHI_FASTLANE = '0';
    try {
      expect(resolveFastLaneEnabled({ enabled: true })).toBe(false);
      expect(resolveFastLaneEnabled(true)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MOCHI_FASTLANE;
      else process.env.MOCHI_FASTLANE = prev;
    }
  });
});
