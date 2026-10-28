// D2: protected-head tests — the protected set is defined in ONE place
// (protected-head.ts); these pin each member's rendering and bounds, and the
// re-injection block's budget enforcement. Survival through the REAL
// compaction is pinned in src/d2-compaction-evidence.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildReinjectionBlock, collectProtectedHead, readOpenTodos, renderProtectedHead,
} from './protected-head.js';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-d2-head-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('protected head: readOpenTodos (open items only, from the real todo file)', () => {
  it('reads .mochi/state/todo.json, filters done, preserves order/notes', () => {
    mkdirSync(resolve(dir, '.mochi', 'state'), { recursive: true });
    writeFileSync(resolve(dir, '.mochi', 'state', 'todo.json'), JSON.stringify([
      { order: 1, status: 'done', title: 'Reproduce the bug' },
      { order: 2, status: 'in_progress', title: 'Add regression test', notes: 'pin BUG-7734' },
      { order: 3, status: 'pending', title: 'Wire spill recall' },
    ]), 'utf8');
    const todos = readOpenTodos(dir);
    expect(todos.map((t) => t.title)).toEqual(['Add regression test', 'Wire spill recall']);
    expect(todos[0].notes).toBe('pin BUG-7734');
  });

  it('returns [] for absent, corrupt, or non-array todo files', () => {
    expect(readOpenTodos(dir)).toEqual([]);
    mkdirSync(resolve(dir, '.mochi', 'state'), { recursive: true });
    writeFileSync(resolve(dir, '.mochi', 'state', 'todo.json'), 'not json', 'utf8');
    expect(readOpenTodos(dir)).toEqual([]);
  });
});

describe('protected head: rendering (each member present, bounded)', () => {
  it('renders the session snapshot: goal + current plan state', () => {
    const head = collectProtectedHead({ goal: 'Fix the 503 retry storm', nextAction: 'Run migrate-staging-backoff' });
    const out = renderProtectedHead(head, 4000);
    expect(out).toContain('Goal: Fix the 503 retry storm');
    expect(out).toContain('Next action: Run migrate-staging-backoff');
  });

  it('renders open TODOs (with status marks and notes) but never completed ones', () => {
    const head = collectProtectedHead({
      todos: [
        { order: 1, status: 'done', title: 'Reproduce the bug' },
        { order: 2, status: 'in_progress', title: 'Add regression test for the 503 retry loop' },
        { order: 3, status: 'pending', title: 'Wire spill recall', notes: 'in finish summary' },
      ],
    });
    const out = renderProtectedHead(head, 8000);
    expect(out).toContain('Open TODOs:');
    expect(out).toContain('[ ] Wire spill recall -- in finish summary');
    expect(out).toContain('[-] Add regression test for the 503 retry loop');
    expect(out).not.toContain('Reproduce the bug'); // done = history, not head
  });

  it('renders skill NAMES in play — names only, never bodies', () => {
    const head = collectProtectedHead({ skillNames: ['test-driven-development', 'git-workflow'] });
    const out = renderProtectedHead(head, 8000);
    expect(out).toContain('Skills in play');
    expect(out).toContain('- test-driven-development');
    expect(out).toContain('- git-workflow');
    // A body would contain instructions; the head carries the name line only.
    expect(out).not.toContain('RED-GREEN-REFACTOR');
  });

  it('returns an empty render for an empty head', () => {
    expect(renderProtectedHead(collectProtectedHead({}), 4000)).toBe('');
  });

  it('honors the budget: long lists are cut with a NAMED omission note, never silently', () => {
    const head = collectProtectedHead({
      goal: 'G',
      todos: Array.from({ length: 40 }, (_, i) => ({ order: i + 1, status: 'pending', title: `todo ${i} — ${'x'.repeat(120)}` })),
      skillNames: Array.from({ length: 40 }, (_, i) => `skill-${i}-${'y'.repeat(40)}`),
    });
    const out = renderProtectedHead(head, 1500);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain('Goal: G'); // the snapshot always renders
    expect(out).toContain('omitted by the 1500-char budget'); // named, not silent
  });
});

describe('re-injection block: bounded evidence bundle', () => {
  it('includes the protected head plus described spill keys', () => {
    const head = collectProtectedHead({ goal: 'Fix the 503 retry storm', todos: [{ order: 1, status: 'pending', title: 'Wire spill recall' }] });
    const r = buildReinjectionBlock({
      head,
      keys: ['spill-aaaaaaaaaaaaaaaa'],
      describeKey: (k) => `${k}: 250,000 chars — AssertionError: BUG-7734…`,
    });
    expect(r.block).toContain('PROTECTED SESSION HEAD');
    expect(r.block).toContain('Fix the 503 retry storm');
    expect(r.block).toContain('Wire spill recall');
    expect(r.block).toContain('recall_output key="<key>"');
    expect(r.block).toContain('- spill-aaaaaaaaaaaaaaaa: 250,000 chars');
    expect(r.keysIncluded).toEqual(['spill-aaaaaaaaaaaaaaaa']);
    expect(r.truncated).toBe(false);
    expect(r.spentChars).toBeLessThanOrEqual(r.budgetChars);
  });

  it('enforces the budget cap: spent <= budget, omissions named, keys stay referenced', () => {
    const head = collectProtectedHead({ goal: 'G' });
    const keys = Array.from({ length: 50 }, (_, i) => `spill-${String(i).padStart(16, '0')}`);
    const r = buildReinjectionBlock({
      head,
      keys,
      describeKey: (k) => `${k}: ${'z'.repeat(300)}`,
      budgetChars: 1200,
    });
    expect(r.budgetChars).toBe(1200);
    expect(r.spentChars).toBeLessThanOrEqual(1200);
    expect(r.block.length).toBeLessThanOrEqual(1200);
    expect(r.truncated).toBe(true);
    expect(r.keysIncluded.length).toBeLessThan(keys.length);
    expect(r.block).toContain('omitted by the 1200-char re-injection budget'); // named, never silent
    // The omitted keys are still reported as referenced (scanned input).
    expect(r.keys.length).toBe(keys.length);
  });

  it('marks keys that fail to resolve as broken pointers — surfaced, never hidden', () => {
    const r = buildReinjectionBlock({
      head: collectProtectedHead({}),
      keys: ['spill-badbadbadbadbad1'],
      describeKey: () => null,
    });
    expect(r.block).toContain('BROKEN POINTER');
  });

  it('returns an empty block when there is neither head nor keys (no noise on plain compactions)', () => {
    const r = buildReinjectionBlock({ head: collectProtectedHead({}), keys: [] });
    expect(r.block).toBe('');
    expect(r.spentChars).toBe(0);
  });
});
