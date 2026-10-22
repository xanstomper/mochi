// Flaky-test quarantine at the VerifierEngine gate: a failure that passes on
// a bounded re-run of the unchanged command classifies FLAKY-PASS (does not
// block, loudly surfaced, registry updated); a consistent failure stays FAIL
// with bounded attempts; a flake in a file this run edited is FAIL
// (anti-gaming); a known-flaky command is excluded from the mutation check.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { VerifierEngine } from './verification.js';
import { Workspace } from './workspace.js';
import { EventBus } from './events.js';
import { BudgetEngine } from './budget.js';
import { createTask } from './goals/task.js';
import { loadFlakyRegistry, saveFlakyRegistry } from './core/flaky.js';
import type { MochiConfig } from './types.js';

// Unreachable model endpoint: the LLM judge fails soft to null and the
// deterministic rule-based verdict decides (same pattern as verification.test.ts).
const baseConfig = {
  model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
  safety: {
    mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 10,
    maxConcurrentAgents: 2, contextBudgetTokens: 1000,
  },
  permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
  telemetry: false, projectDir: '.mochi', configDir: tmpdir(), quiet: true, verbose: false, debug: false,
} as unknown as MochiConfig;

/** Deterministic flake: fails the FIRST execution (counter file), passes after. */
const FLAKE_ONCE_JS = `
const fs = require('fs');
const path = require('path');
const counter = path.join(__dirname, 'flake-count.txt');
let n = 0;
try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch {}
fs.writeFileSync(counter, String(n + 1));
if (n === 0) {
  console.log(' FAIL  test/counter.test.js > counter increments');
  console.log('AssertionError: expected 1 to be 2');
  process.exit(1);
}
console.log('test/counter.test.js passed');
`;

const ALWAYS_FAIL_JS = `
const fs = require('fs');
const path = require('path');
const counter = path.join(__dirname, 'fail-count.txt');
let n = 0;
try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch {}
fs.writeFileSync(counter, String(n + 1));
console.log(' FAIL  test/broken.test.js > always broken');
console.log('AssertionError: expected true to be false');
process.exit(1);
`;

function makeVerifier(dir: string): VerifierEngine {
  const workspace = new Workspace(dir, '.mochi');
  workspace.ensure();
  return new VerifierEngine({
    cwd: dir, workspace, config: baseConfig, events: new EventBus(), budget: new BudgetEngine(baseConfig.safety),
  });
}

function gitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
}

describe('VerifierEngine flaky quarantine', () => {
  let dir: string | undefined;
  afterEach(() => { dir = undefined; });

  it('(a) fail-once-then-pass classifies FLAKY-PASS, updates the registry, and does not block', async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'mochi-flaky-engine-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }));
    writeFileSync(resolve(dir, 'flake-once.js'), FLAKE_ONCE_JS);
    const verifier = makeVerifier(dir);
    const task = createTask('Fix the counter', 'Repair the counter module', {
      acceptanceCriteria: ['counter check passes'],
      verificationCommand: 'node flake-once.js',
    });
    const result = await verifier.verify(task, 'Fixed the counter');
    expect(result.status).toBe('FLAKY-PASS');
    expect(result.flaky?.map((f) => f.id)).toContain('test/counter.test.js > counter increments');
    expect(result.summary).toContain('FLAKY');
    // Exactly two executions: the failure + one bounded re-run.
    expect(readFileSync(resolve(dir, 'flake-count.txt'), 'utf8')).toBe('2');
    // Registry captured the flake for future runs.
    const registryFile = resolve(dir, '.mochi', 'state', 'flaky-tests.json');
    expect(existsSync(registryFile)).toBe(true);
    const reg = loadFlakyRegistry(new Workspace(dir, '.mochi'));
    expect(reg.entries['test/counter.test.js > counter increments']?.score).toBe(1);
    expect(reg.entries['test/counter.test.js > counter increments']?.command).toBe('node flake-once.js');
  });

  it('(b) a consistent failure stays FAIL with bounded re-runs and no registry entry', async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'mochi-flaky-engine-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }));
    writeFileSync(resolve(dir, 'always-fail.js'), ALWAYS_FAIL_JS);
    const verifier = makeVerifier(dir);
    const task = createTask('Fix the broken test', 'Repair the broken module', {
      acceptanceCriteria: ['broken check passes'],
      verificationCommand: 'node always-fail.js',
    });
    const result = await verifier.verify(task, 'Attempted fix');
    expect(result.status).toBe('FAIL');
    // 1 initial + 2 bounded re-runs — never an unbounded retry loop.
    expect(readFileSync(resolve(dir, 'fail-count.txt'), 'utf8')).toBe('3');
    const reg = loadFlakyRegistry(new Workspace(dir, '.mochi'));
    expect(reg.entries['test/broken.test.js > always broken']).toBeUndefined();
  });

  it('(c) a flake in a test file this run edited is FAIL — the excuse is denied', async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'mochi-flaky-engine-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }));
    writeFileSync(resolve(dir, 'flake-once.js'), FLAKE_ONCE_JS.replaceAll('test/counter.test.js', 'test/own.test.js'));
    mkdirSync(resolve(dir, 'test'), { recursive: true });
    writeFileSync(resolve(dir, 'test', 'own.test.js'), '// the test file under repair\n');
    gitRepo(dir);
    // The run's own edit: the test file is dirty in the working tree.
    appendFileSync(resolve(dir, 'test', 'own.test.js'), '// touched by this run\n');
    const verifier = makeVerifier(dir);
    const task = createTask('Fix the own test', 'Repair the flaky own test', {
      acceptanceCriteria: ['own check passes'],
      verificationCommand: 'node flake-once.js',
    });
    const result = await verifier.verify(task, 'Edited the test');
    expect(result.status).toBe('FAIL');
    const evidenceText = result.evidence.map((e) => e.result).join('\n');
    expect(evidenceText).toContain('Flake excuse DENIED');
    expect(evidenceText).toContain('test/own.test.js > counter increments');
  });

  it('(d) a known-flaky command is excluded from the mutation check', async () => {
    // Shared fixture: a changed source file with a flippable operator and a
    // check command that passes while observing nothing about the code.
    const setup = (): string => {
      const d = mkdtempSync(resolve(tmpdir(), 'mochi-flaky-mut-'));
      writeFileSync(resolve(d, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }));
      writeFileSync(resolve(d, 'math.js'), 'function eq(a, b) { return a === b; }\nmodule.exports = { eq };\n');
      writeFileSync(resolve(d, 'check.js'), "console.log('checks ran ok');\n");
      gitRepo(d);
      appendFileSync(resolve(d, 'math.js'), '// touched by this run\n');
      return d;
    };
    const task = () => createTask('Adjust equality helper', 'Tweak math.js', {
      acceptanceCriteria: ['check passes'],
      verificationCommand: 'node check.js',
    });

    // Control: no quarantine history — the mutation survives the hollow
    // check and the PASS is downgraded to PARTIAL. Proves the trap is armed.
    dir = setup();
    const control = await makeVerifier(dir).verify(task(), 'Tweaked');
    expect(control.status).toBe('PARTIAL');
    expect(control.evidence.map((e) => e.result).join('\n')).toContain('SURVIVED');

    // Seeded quarantine: the same command is known-flaky (score 3 >= 2), so
    // the mutation check must skip it and the clean PASS stands.
    dir = setup();
    const ws = new Workspace(dir, '.mochi');
    ws.ensure();
    const reg = loadFlakyRegistry(ws);
    reg.entries['cmd:node check.js'] = {
      id: 'cmd:node check.js', command: 'node check.js', score: 3, flakeEvents: 3,
      firstSeenAt: Date.now(), lastSeenAt: Date.now(), examples: [],
    };
    saveFlakyRegistry(ws, reg);
    const result = await makeVerifier(dir).verify(task(), 'Tweaked');
    expect(result.status).toBe('PASS');
    expect(result.evidence.map((e) => e.result).join('\n')).toContain('Mutation check skipped');
    // The clean pass still healed the registry for the NEXT run (3 → 1.5):
    // within-run gate decisions used the start-of-run snapshot.
    const after = loadFlakyRegistry(new Workspace(dir, '.mochi'));
    expect(after.entries['cmd:node check.js']?.score).toBe(1.5);
  });
});
