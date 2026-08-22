import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
    environment: 'node',
    // Several tests are real integration tests that spawn `git`, `npm`, and
    // `node` subprocesses and can exceed vitest's default 5s under parallel
    // load; a generous cap keeps them from false-flaking without slowing the
    // many fast unit tests (they finish in milliseconds regardless). The full
    // GoalEngine pipeline test measured 2.5s solo but >30s when all four
    // workers contend on a 4-core box (observed 2026-08-22), so the cap is
    // high enough to absorb worst-case scheduler starvation.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
