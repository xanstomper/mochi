import { describe, it, expect } from 'vitest';
import { StateStore } from './state-store.js';

interface TestState {
  message: string;
  taskTree: string;
  config: string;
}

describe('StateStore', () => {
  it('marks and flushes only dirty regions', () => {
    const store = new StateStore<TestState>({ message: '', taskTree: '', config: 'stable' });
    const messageRenders: string[] = [];
    const taskRenders: string[] = [];

    store.subscribeRegion('message', () => messageRenders.push(store.get('message')));
    store.subscribeRegion('task-tree', () => taskRenders.push(store.get('taskTree')));

    store.set('message', 'hello', 'message');
    store.flush();
    expect(messageRenders).toEqual(['hello']);
    expect(taskRenders).toEqual([]);

    store.set('taskTree', 'task', 'task-tree');
    store.flush();
    expect(messageRenders).toEqual(['hello']);
    expect(taskRenders).toEqual(['task']);
  });

  it('ignores identical writes', () => {
    const store = new StateStore<TestState>({ message: 'same', taskTree: '', config: '' });
    store.set('message', 'same', 'message');
    expect(store.isDirty('message')).toBe(false);
    expect(store.getStats().writes).toBe(0);
  });

  it('tracks hot keys separately from cold state', () => {
    const store = new StateStore<TestState>({ message: '', taskTree: '', config: 'cold' });
    store.markHot('message');
    store.markHot('taskTree');
    store.set('config', 'changed', 'sidebar');
    expect(store.getStats().hotKeys).toBe(2);
  });
});
