import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SpeculativeBranchRacer } from './branch-racer.js';

describe('SpeculativeBranchRacer', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(resolve(tmpdir(), 'mochi-branch-racer-test-'));
    // Initialize git repository for worktree support
    execFileSync('git', ['init'], { cwd: testDir });
    execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: testDir });
    execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: testDir });

    // Create initial commit
    writeFileSync(resolve(testDir, 'math.js'), 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n');
    writeFileSync(
      resolve(testDir, 'test.js'),
      'const { add } = require("./math.js");\nif (add(2, 3) !== 5) process.exit(1);\n'
    );
    execFileSync('git', ['add', '-A'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: testDir });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('races candidate branches in parallel worktrees and promotes the passing branch', async () => {
    const racer = new SpeculativeBranchRacer(testDir);

    const candidates = [
      {
        name: 'bad-candidate',
        patches: [
          {
            filePath: 'math.js',
            newContent: 'function add(a, b) { return a * b; }\nmodule.exports = { add };\n',
          },
        ],
      },
      {
        name: 'good-candidate',
        patches: [
          {
            filePath: 'math.js',
            newContent: 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n',
          },
        ],
      },
    ];

    const result = await racer.raceCandidates(candidates, 'node test.js');

    expect(result.winner).toBeDefined();
    expect(result.winner?.name).toBe('good-candidate');
    expect(result.appliedToPrimary).toBe(true);
    expect(result.summary).toContain('Speculative race winner');

    // Verify that good-candidate was applied to primary workspace
    const finalContent = readFileSync(resolve(testDir, 'math.js'), 'utf8');
    expect(finalContent).toContain('return a + b;');
  });

  it('selects the strongest passing candidate deterministically, not the fastest completion', async () => {
    const racer = new SpeculativeBranchRacer(testDir);
    const candidates = [
      {
        name: 'preferred',
        score: 9,
        patches: [{ filePath: 'math.js', newContent: 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n' }],
      },
      {
        name: 'fast-but-weaker',
        score: 3,
        patches: [{ filePath: 'math.js', newContent: 'function add(a, b) { return Number(a) + Number(b); }\nmodule.exports = { add };\n' }],
      },
    ];

    const result = await racer.raceCandidates(candidates, 'node test.js');

    expect(result.winner?.name).toBe('preferred');
    expect(result.candidatesEvaluated.map((candidate) => candidate.name)).toEqual(['preferred', 'fast-but-weaker']);
    expect(readFileSync(resolve(testDir, 'math.js'), 'utf8')).toContain('return a + b;');
  });

  it('rejects path traversal instead of writing outside the worktree', async () => {
    const racer = new SpeculativeBranchRacer(testDir);
    const outside = resolve(testDir, '..', 'mochi-branch-racer-escape.txt');
    rmSync(outside, { force: true });

    const result = await racer.raceCandidates([{
      name: 'escape',
      patches: [{ filePath: '../mochi-branch-racer-escape.txt', newContent: 'escaped' }],
    }], 'node test.js');

    expect(result.winner).toBeUndefined();
    expect(result.appliedToPrimary).toBe(false);
    expect(() => readFileSync(outside, 'utf8')).toThrow();
  });

  it('does not claim a candidate passed when no verification command exists', async () => {
    rmSync(resolve(testDir, 'test.js'));
    const racer = new SpeculativeBranchRacer(testDir);

    const result = await racer.raceCandidates([{
      name: 'unverified',
      patches: [{ filePath: 'math.js', newContent: 'function add() { return 5; }\n' }],
    }], '');

    expect(result.winner).toBeUndefined();
    expect(result.appliedToPrimary).toBe(false);
    expect(result.summary).toContain('could not be verified');
  });

  it('does not give a failed candidate another same-named candidate\'s verification evidence', async () => {
    const racer = new SpeculativeBranchRacer(testDir);
    const result = await racer.raceCandidates([
      {
        name: 'duplicate',
        score: 9,
        patches: [{ filePath: 'math.js', newContent: 'module.exports = { add: () => 0 };\n' }],
      },
      {
        name: 'duplicate',
        score: 3,
        patches: [{ filePath: 'math.js', newContent: 'module.exports = { add: (a, b) => a + b };\n' }],
      },
    ], 'node test.js');

    expect(result.candidatesEvaluated.map(({ passed }) => passed)).toEqual([false, true]);
    expect(result.appliedToPrimary).toBe(true);
    expect(readFileSync(resolve(testDir, 'math.js'), 'utf8')).toContain('a + b');
    expect(() => execFileSync('node', ['test.js'], { cwd: testDir })).not.toThrow();
  });

  it('keeps duplicate-name evaluation results in candidate order', async () => {
    writeFileSync(resolve(testDir, 'verify.js'), [
      'const { readFileSync } = require("node:fs");',
      'const source = readFileSync("math.js", "utf8");',
      'if (source.includes("slow")) {',
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 250);',
      '  process.exit(1);',
      '}',
      'process.exit(source.includes("fast") ? 0 : 1);',
    ].join('\n'));
    execFileSync('git', ['add', 'verify.js'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'add verifier'], { cwd: testDir });
    const racer = new SpeculativeBranchRacer(testDir);

    const result = await racer.raceCandidates([
      { name: 'duplicate', patches: [{ filePath: 'math.js', newContent: '// slow\n' }] },
      { name: 'duplicate', patches: [{ filePath: 'math.js', newContent: '// fast\n' }] },
    ], 'node verify.js');

    expect(result.candidatesEvaluated.map(({ passed }) => passed)).toEqual([false, true]);
  });

  it('reports failure when all speculative candidates fail verification', async () => {
    const racer = new SpeculativeBranchRacer(testDir);

    const candidates = [
      {
        name: 'bad-candidate-1',
        patches: [
          {
            filePath: 'math.js',
            newContent: 'function add(a, b) { return 0; }\nmodule.exports = { add };\n',
          },
        ],
      },
      {
        name: 'bad-candidate-2',
        patches: [
          {
            filePath: 'math.js',
            newContent: 'function add(a, b) { return -1; }\nmodule.exports = { add };\n',
          },
        ],
      },
    ];

    const result = await racer.raceCandidates(candidates, 'node test.js');

    expect(result.winner).toBeUndefined();
    expect(result.appliedToPrimary).toBe(false);
    expect(result.summary).toContain('All 2 candidate branches failed verification');
  });

  it('runs verification commands with quoted arguments, env assignments, and && chains', async () => {
    // This command is unparseable by the old `testCmd.split(' ')` route:
    // it has an env assignment, double- and single-quoted arguments that
    // contain spaces, and an `&&` chain. Only real shell execution passes it.
    writeFileSync(resolve(testDir, 'verify-quoted.js'), [
      'if (process.env.EXPECTED_GREETING !== "hello world") process.exit(1);',
      'if (process.argv[2] !== "a b") process.exit(2);',
      'if (process.argv[3] !== "c d") process.exit(3);',
      'process.exit(0);',
    ].join('\n'));
    execFileSync('git', ['add', 'verify-quoted.js'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'add quoted verifier'], { cwd: testDir });
    const racer = new SpeculativeBranchRacer(testDir);

    const result = await racer.raceCandidates([
      {
        name: 'quoted-args-candidate',
        patches: [{ filePath: 'math.js', newContent: 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n' }],
      },
    ], 'EXPECTED_GREETING="hello world" node verify-quoted.js "a b" \'c d\' && node test.js');

    expect(result.candidatesEvaluated.map(({ passed }) => passed)).toEqual([true]);
    expect(result.winner?.name).toBe('quoted-args-candidate');
    expect(result.appliedToPrimary).toBe(true);
    expect(readFileSync(resolve(testDir, 'math.js'), 'utf8')).toContain('return a + b;');
  });

  it('fails a slow verification command when a short custom timeoutMs is configured', async () => {
    // The script would pass after ~2s if left alone; with timeoutMs: 150 it
    // must be timed out and reported as failed, not passed. (This also proves
    // the timeout is no longer the old hardcoded 30s path for this call —
    // and, conversely, that a custom value actually reaches the executor.)
    writeFileSync(resolve(testDir, 'verify-slow.js'), 'setTimeout(() => process.exit(0), 2000);\n');
    execFileSync('git', ['add', 'verify-slow.js'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'add slow verifier'], { cwd: testDir });
    const racer = new SpeculativeBranchRacer(testDir);

    const result = await racer.raceCandidates([
      {
        name: 'slow-candidate',
        patches: [{ filePath: 'math.js', newContent: 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n' }],
      },
    ], 'node verify-slow.js', { timeoutMs: 150 });

    expect(result.candidatesEvaluated.map(({ passed }) => passed)).toEqual([false]);
    expect(result.candidatesEvaluated[0].output).toContain('timed out');
    expect(result.winner).toBeUndefined();
    expect(result.appliedToPrimary).toBe(false);
  });

  it('honours the MOCHI_BRANCH_RACE_TIMEOUT_MS env override', async () => {
    writeFileSync(resolve(testDir, 'verify-slow.js'), 'setTimeout(() => process.exit(0), 2000);\n');
    execFileSync('git', ['add', 'verify-slow.js'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'add slow verifier'], { cwd: testDir });
    const racer = new SpeculativeBranchRacer(testDir);

    const previous = process.env.MOCHI_BRANCH_RACE_TIMEOUT_MS;
    process.env.MOCHI_BRANCH_RACE_TIMEOUT_MS = '150';
    try {
      const result = await racer.raceCandidates([
        {
          name: 'env-timeout-candidate',
          patches: [{ filePath: 'math.js', newContent: 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n' }],
        },
      ], 'node verify-slow.js');

      expect(result.candidatesEvaluated.map(({ passed }) => passed)).toEqual([false]);
      expect(result.winner).toBeUndefined();
      expect(result.appliedToPrimary).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.MOCHI_BRANCH_RACE_TIMEOUT_MS;
      else process.env.MOCHI_BRANCH_RACE_TIMEOUT_MS = previous;
    }
  });

  it('preserves candidate-order results when concurrency is bounded to 1', async () => {
    const racer = new SpeculativeBranchRacer(testDir);

    const result = await racer.raceCandidates([
      {
        name: 'first-bad',
        patches: [{ filePath: 'math.js', newContent: 'function add(a, b) { return 0; }\nmodule.exports = { add };\n' }],
      },
      {
        name: 'second-good',
        patches: [{ filePath: 'math.js', newContent: 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n' }],
      },
      {
        name: 'third-bad',
        patches: [{ filePath: 'math.js', newContent: 'function add(a, b) { return -1; }\nmodule.exports = { add };\n' }],
      },
    ], 'node test.js', { maxConcurrency: 1 });

    expect(result.candidatesEvaluated.map(({ name }) => name)).toEqual(['first-bad', 'second-good', 'third-bad']);
    expect(result.candidatesEvaluated.map(({ passed }) => passed)).toEqual([false, true, false]);
    expect(result.winner?.name).toBe('second-good');
    expect(result.appliedToPrimary).toBe(true);
  });
});
