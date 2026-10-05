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
    // RAM guard (2026-10-05): vitest's default is one worker per CPU core, and
    // every worker loads the full TypeScript compiler plus the whole Mochi app.
    // On this 4-core box that meant 4 heavy workers (each hundreds of MB, more
    // under swap pressure) that ate the machine into 10Gi/11Gi used and threw
    // edge flakes (e.g. ast-guard's TS-compiler load failing under contention).
    // Cap the pool to 2 forks: keeps real parallelism while bounding peak RAM,
    // and reduces the scheduler starvation the old 4-worker contention caused.
    pool: 'forks',
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 2,
        singleFork: false,
      },
    },
  },
});
