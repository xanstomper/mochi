import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
    environment: 'node',
    // Several tests are real integration tests that spawn `git`, `npm`, and
    // `node` subprocesses and can exceed vitest's default 5s under parallel
    // load; a generous cap keeps them from false-flaking without slowing the
    // many fast unit tests (they finish in milliseconds regardless).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
