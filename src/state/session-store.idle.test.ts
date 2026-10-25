// G11 — idle detection in the session store (queue item 4, second half).
// Works on both drivers (sqlite + JSON fallback): the clock is updatedAt,
// which every append/begin/rename already bumps.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SessionStore } from './session-store.js';

let dir: string;
let store: SessionStore;

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-sessions-idle-'));
  store = new SessionStore(dir);
});
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('SessionStore idle clock', () => {
  it('lastActivityAt is undefined for unknown sessions', () => {
    expect(store.lastActivityAt('no-such-session')).toBeUndefined();
    expect(store.idleDurationMs('no-such-session')).toBeUndefined();
  });

  it('idleDurationMs measures from the last activity, clamped at zero', () => {
    const id = store.begin({ goalId: 'g-idle', objective: 'idle clock check' });
    store.append(id, 'user', 'do something');
    const at = store.lastActivityAt(id);
    expect(at).toBeDefined();
    expect(store.idleDurationMs(id, at! + 60_000)).toBe(60_000);
    expect(store.idleDurationMs(id, at! - 1000)).toBe(0);
  });

  it('new activity bumps the clock', () => {
    const id = store.begin({ goalId: 'g-idle-bump', objective: 'bump check' });
    const before = store.lastActivityAt(id);
    store.append(id, 'assistant', 'more work');
    const after = store.lastActivityAt(id);
    expect(after).toBeDefined();
    expect(after!).toBeGreaterThanOrEqual(before!);
  });
});
