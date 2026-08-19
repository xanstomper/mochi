import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  loadLessons,
  recordLesson,
  retrieveLessons,
  markLessonUsed,
  lessonsToPrompt,
  type Lesson,
} from './lessons.js';

describe('procedural memory: lessons', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-lessons-'));

  it('records and retrieves a lesson by signature and kind', () => {
    recordLesson(dir, { id: 'L1', signature: 'exit_code: 127', kind: 'env_missing', lesson: 'install tsc with npm i -D typescript' });
    recordLesson(dir, { id: 'L2', signature: 'property .* does not exist', kind: 'type', lesson: 'add the missing .js extension under nodenext' });

    const missing = retrieveLessons(dir, 'exit_code: 127 sh: tsc: not found', 'env_missing');
    expect(missing.some((l) => l.id === 'L1')).toBe(true);

    const type = retrieveLessons(dir, 'error ts2339 property foo does not exist', 'type');
    expect(type.some((l) => l.id === 'L2')).toBe(true);

    const unknown = retrieveLessons(dir, 'unrelated text', 'logic');
    expect(unknown).toEqual([]);
  });

  it('reinforces matching lessons instead of duplicating', () => {
    recordLesson(dir, { id: 'rev', signature: 'unique-sig-A', lesson: 'revert imports' });
    recordLesson(dir, { id: 'rev', signature: 'unique-sig-A', lesson: 'revert imports cleanly' });
    const all = loadLessons(dir).filter((l) => l.signature === 'unique-sig-A');
    expect(all).toHaveLength(1);
    expect(all[0].lesson).toContain('revert imports');
  });

  it('tracks use counts and successes', () => {
    recordLesson(dir, { id: 'counted', signature: 's3', lesson: 'try retry' });
    markLessonUsed(dir, 'counted', true);
    markLessonUsed(dir, 'counted', false);
    markLessonUsed(dir, 'counted', true);
    const l = loadLessons(dir).find((x) => x.id === 'counted');
    expect(l).toBeDefined();
    expect(l!.useCount).toBeGreaterThanOrEqual(3);
    expect(l!.successCount).toBeGreaterThanOrEqual(2);
    expect(typeof l!.lastUsedAtMs).toBe('number');
  });

  it('renders lessons to prompt context with usage stats', () => {
    recordLesson(dir, { id: 'render', signature: 'render-sig', lesson: 'spin retry' });
    markLessonUsed(dir, 'render', true);
    const text = lessonsToPrompt(loadLessons(dir).filter((l) => l.id === 'render'));
    expect(text).toContain('LESSONS FROM PREVIOUS ATTEMPTS');
    expect(text).toContain('render-sig');
    expect(text).toContain('spin retry');
  });

  it('persists to <workspace>/memory/lessons.json', () => {
    recordLesson(dir, { id: 'persist', signature: 'persist-sig', lesson: 'remember me' });
    expect(existsSync(resolve(dir, 'memory', 'lessons.json'))).toBe(true);
  });
});

afterAll(() => {
  rmSync(resolve(tmpdir(), 'mochi-lessons-').slice(0), { recursive: true, force: true });
});