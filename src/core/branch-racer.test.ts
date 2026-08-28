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
});
