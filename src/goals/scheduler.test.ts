import { describe, it, expect } from 'vitest';
import { TaskScheduler } from './scheduler.js';
import { createTask } from './task.js';

describe('TaskScheduler', () => {
  it('runs tasks in dependency order', () => {
    const a = createTask('A', 'first');
    const b = createTask('B', 'second', { dependencies: [a.id] });
    const c = createTask('C', 'third', { dependencies: [b.id] });
    const s = new TaskScheduler([c, a, b]);

    expect(s.readyTasks().map((t) => t.title)).toEqual(['A']);
    s.start(a.id);
    s.complete(a.id);
    expect(s.readyTasks().map((t) => t.title)).toEqual(['B']);
    s.start(b.id);
    s.complete(b.id);
    expect(s.readyTasks().map((t) => t.title)).toEqual(['C']);
    s.start(c.id);
    s.complete(c.id);
    expect(s.isDone()).toBe(true);
  });

  it('respects file scope conflicts', () => {
    const a = createTask('A', 'modify auth', { fileScope: ['src/auth/*'] });
    const b = createTask('B', 'modify auth2', { fileScope: ['src/auth/*'] });
    const c = createTask('C', 'modify ui', { fileScope: ['src/ui/*'] });
    const s = new TaskScheduler([a, b, c]);
    s.start(a.id);
    const ready = s.readyTasks();
    expect(ready.map((t) => t.title)).toEqual(['C']);
    expect(ready.find((t) => t.title === 'B')).toBeUndefined();
  });

  it('does not run an unscoped task alongside any other running writer', () => {
    const a = createTask('A', 'scoped', { fileScope: ['src/auth/*'] });
    const b = createTask('B', 'unscoped');
    const s = new TaskScheduler([a, b]);
    // Start the unscoped task first: no other writer is running yet.
    s.start(b.id);
    // A scoped task must NOT be ready while an unscoped writer is running.
    expect(s.readyTasks().map((t) => t.title)).toEqual([]);
  });

  it('calculates progress', () => {
    const a = createTask('A', 'first');
    const b = createTask('B', 'second');
    const s = new TaskScheduler([a, b]);
    s.complete(a.id);
    expect(s.progress()).toBe(50);
  });
});
