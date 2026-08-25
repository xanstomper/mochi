import { describe, expect, it } from 'vitest';
import { saveNamedCheckpoint, listNamedCheckpoints, deleteNamedCheckpoint } from './checkpoint-manager.js';

describe('Named Checkpoint Manager', () => {
  it('saves, lists, and deletes named checkpoints', async () => {
    const cwd = process.cwd();
    const cp = await saveNamedCheckpoint(cwd, 'test-checkpoint', 'Unit test snapshot');

    expect(cp.name).toBe('test-checkpoint');
    expect(cp.description).toBe('Unit test snapshot');
    expect(cp.createdAt).toBeDefined();

    const list = listNamedCheckpoints(cwd);
    expect(list.some(c => c.name === 'test-checkpoint')).toBe(true);

    const deleted = deleteNamedCheckpoint(cwd, 'test-checkpoint');
    expect(deleted).toBe(true);
  });
});
