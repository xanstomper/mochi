// Substantive success writes (P1.5): at finish, a completed run records ONE
// success fact in the GLOBAL fact store — task, changed files, verification
// outcome — via the store's existing addFact() API, which previously had no
// caller in the loop. Failed runs record nothing, and re-running the same
// task does not stack duplicate facts (trigram-similarity dedupe).
//
// The global store is redirected per test via MOCHI_MEMORY_FILE (resolved
// lazily at call time); the loop's write is explicitly enabled under vitest
// only when that redirection is present, so the suite never touches the
// real ~/.mochi store.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import { loadFacts, type MemoryFact } from '../memory/memory-store.js';
import type { MochiConfig } from '../types.js';

const MATH_BUGGY = 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n';
const REPRO_JS = 'const { add } = require("./math.js");\nif (add(2, 3) !== 5) { console.log("WRONG: add(2,3)=" + add(2, 3)); process.exit(1); }\nconsole.log("OK");\n';
const FIX_TITLE = 'Fix the bug in math.js: add() returns the wrong result';
const FIX_DESC = 'add(a, b) in math.js subtracts instead of adding, so the repro script repro.js fails. Diagnose the root cause in the existing code and correct the arithmetic.';
const EDIT_FIX = JSON.stringify({ path: 'math.js', oldText: 'return a - b', newText: 'return a + b' });
const EDIT_WRONG = JSON.stringify({ path: 'math.js', oldText: 'return a - b', newText: 'return a * b' });

function makeConfig(dir: string, url: string, maxVerifyRetries?: number): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000, ...(maxVerifyRetries !== undefined ? { maxVerifyRetries } : {}) },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function makeRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-success-mem-'));
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node repro.js' } }));
  writeFileSync(resolve(dir, 'math.js'), MATH_BUGGY);
  writeFileSync(resolve(dir, 'repro.js'), REPRO_JS);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

async function runScripted(
  dir: string,
  script: FakeScriptResponse[],
  maxVerifyRetries?: number,
  taskText: { title: string; desc: string } = { title: FIX_TITLE, desc: FIX_DESC },
) {
  const fake = await startFakeOpenAI(script);
  try {
    const config = makeConfig(dir, fake.url, maxVerifyRetries);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal(taskText.title);
    const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
    return await agent.run(createTask(taskText.title, taskText.desc));
  } finally {
    await fake.close();
  }
}

function successScript(finalProse: string): FakeScriptResponse[] {
  return [
    // Reproduce first (the gate requires a shell run before editing an
    // existing file on a fix task; the failing repro IS the reproduction).
    { finishReason: 'tool_calls', toolCalls: [{ id: 's1', function: { name: 'shell', arguments: JSON.stringify({ command: 'node repro.js' }) } }] },
    { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_FIX } }] },
    { content: finalProse, finishReason: 'stop' },
  ];
}

function historyFacts(): MemoryFact[] {
  return loadFacts().filter((f) => f.category === 'history');
}

describe('run success memory (loop finish -> global fact store)', () => {
  let dir: string | undefined;
  let memDir: string | undefined;
  let savedMemoryFile: string | undefined;

  function pointStoreAtTempFile(): void {
    memDir = mkdtempSync(resolve(tmpdir(), 'mochi-success-mem-store-'));
    savedMemoryFile = process.env['MOCHI_MEMORY_FILE'];
    process.env['MOCHI_MEMORY_FILE'] = resolve(memDir, 'memory.jsonl');
  }

  afterEach(() => {
    if (savedMemoryFile === undefined) delete process.env['MOCHI_MEMORY_FILE'];
    else process.env['MOCHI_MEMORY_FILE'] = savedMemoryFile;
    savedMemoryFile = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (memDir) rmSync(memDir, { recursive: true, force: true });
    dir = undefined;
    memDir = undefined;
  });

  it('a completed fix run writes a success fact with the changed file and verification outcome (c)', async () => {
    pointStoreAtTempFile();
    dir = makeRepo();
    const result = await runScripted(dir, successScript('Fixed add() to return a + b; the repro script now passes.'));
    expect(result.success).toBe(true);
    expect(readFileSync(resolve(dir, 'math.js'), 'utf8')).toContain('return a + b');

    const facts = historyFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].source).toBe('run');
    expect(facts[0].statement).toContain('Fix the bug in math.js');
    expect(facts[0].statement).toContain('math.js');
    expect(facts[0].statement).toContain('Verification: passed');
  }, 120_000);

  it('a failed run writes no success fact (c)', async () => {
    pointStoreAtTempFile();
    dir = makeRepo();
    // The task text demands green ("all tests"), which disables the loop's
    // baseline debt-masking — the still-failing suite after the wrong edit
    // is a REAL verification failure, not pre-existing debt.
    const result = await runScripted(dir, [
      { finishReason: 'tool_calls', toolCalls: [{ id: 's1', function: { name: 'shell', arguments: JSON.stringify({ command: 'node repro.js' }) } }] },
      // Wrong fix: the repro (npm test) keeps failing, verification exhausts
      // its retries and the run finishes as verification_failed.
      { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_WRONG } }] },
      { content: 'Fixed add() to multiply instead.', finishReason: 'stop' },
    ], 1, {
      title: 'Fix the bug in math.js: add() returns the wrong result',
      desc: 'add(a, b) in math.js subtracts instead of adding, so the repro script repro.js fails. Correct the arithmetic so all tests pass.',
    });
    expect(result.success).toBe(false);
    expect(historyFacts()).toHaveLength(0);
  }, 120_000);

  it('two near-identical completed runs do not stack duplicate facts (d)', async () => {
    pointStoreAtTempFile();
    dir = makeRepo();
    const first = await runScripted(dir, successScript('Fixed add() to return a + b; the repro script now passes.'));
    expect(first.success).toBe(true);
    expect(historyFacts()).toHaveLength(1);

    // Reset the bug and run the same task again with a one-word-different
    // summary — the recorded outcome is near-identical and must dedupe.
    writeFileSync(resolve(dir, 'math.js'), MATH_BUGGY);
    const second = await runScripted(dir, successScript('Fixed add() to return a + b; the repro script now passes cleanly.'));
    expect(second.success).toBe(true);
    expect(historyFacts()).toHaveLength(1);
  }, 240_000);
});
