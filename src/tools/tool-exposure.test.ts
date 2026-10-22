// P1.3 measured tool exposure: usage ledger + budgeted selection policy +
// the MOCHI_TOOLS=full escape hatch, unit-level and end-to-end.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildTools, executeTool, LEAN_TOOL_NAMES, ALL_TOOLS_MAP, toolsNamedInText } from './index.js';
import {
  recordToolExposureUsage,
  loadToolUsageLedger,
  flushToolUsageLedger,
  toolUsageLedgerFile,
  _clearToolUsageLedgerCacheForTests,
  selectToolsForExposure,
  toolsImplicatedBySignals,
  toolExposureMode,
  toolSchemaBudgetChars,
  toolsSchemaChars,
  DEFAULT_TOOL_SCHEMA_BUDGET_CHARS,
  type ToolUsageLedger,
} from './tool-exposure.js';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import { Agent } from '../agent/loop.js';
import { AgentProfileService } from '../agents/profile.js';
import { ContextEngine } from '../context.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';
import type { Tool, ToolContext } from './types.js';

function makeConfig(dir: string, url = 'http://127.0.0.1:1/v1'): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: {
      mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10,
      maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: dir,
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

const BUILTIN_NAMES = new Set([...ALL_TOOLS_MAP.keys(), 'load_tools']);

function selectFor(text: string, kind: string, ledger?: ToolUsageLedger | null, budgetChars?: number) {
  const cfg = makeConfig('/tmp');
  const candidates = [...buildTools(cfg).values()];
  const forced = new Set<string>([...toolsNamedInText(text), ...toolsImplicatedBySignals(text)]);
  return selectToolsForExposure({
    candidates,
    builtinNames: BUILTIN_NAMES,
    coreNames: LEAN_TOOL_NAMES,
    forcedNames: forced,
    ledger: ledger ?? null,
    taskKind: kind,
    budgetChars,
  });
}

let savedToolsEnv: string | undefined;
let savedBudgetEnv: string | undefined;
beforeEach(() => {
  savedToolsEnv = process.env.MOCHI_TOOLS;
  savedBudgetEnv = process.env.MOCHI_TOOL_SCHEMA_BUDGET;
  delete process.env.MOCHI_TOOLS;
  delete process.env.MOCHI_TOOL_SCHEMA_BUDGET;
  _clearToolUsageLedgerCacheForTests();
});
afterEach(() => {
  if (savedToolsEnv === undefined) delete process.env.MOCHI_TOOLS;
  else process.env.MOCHI_TOOLS = savedToolsEnv;
  if (savedBudgetEnv === undefined) delete process.env.MOCHI_TOOL_SCHEMA_BUDGET;
  else process.env.MOCHI_TOOL_SCHEMA_BUDGET = savedBudgetEnv;
  _clearToolUsageLedgerCacheForTests();
});

describe('usage ledger (via the executeTool chokepoint)', () => {
  it('increments, splits success/failure, aggregates by kind, and persists across two runs', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-exposure-ledger-'));
    try {
      const config = makeConfig(dir);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      writeFileSync(resolve(dir, 'hello.txt'), 'hello mochi');
      const tools = buildTools(config);
      const ctx: ToolContext = {
        cwd: dir, workspace, config, events: new EventBus(), agentId: 'run-1', taskKind: 'fix',
      };

      // Run 1: one successful read, one throwing tool.
      const ok = await executeTool('read', { path: resolve(dir, 'hello.txt') }, ctx, tools);
      expect(ok.error).toBeUndefined();
      const boom: Tool = {
        def: { name: 'boom_tool', description: 'always throws', parameters: [] },
        execute: async () => { throw new Error('kaboom'); },
      };
      const failed = await executeTool('boom_tool', {}, ctx, new Map([['boom_tool', boom]]));
      expect(failed.error).toContain('kaboom');

      flushToolUsageLedger(workspace);
      const file = toolUsageLedgerFile(workspace.dir);
      expect(existsSync(file)).toBe(true);
      let db = JSON.parse(readFileSync(file, 'utf8')) as ToolUsageLedger;
      expect(db.tools.read.calls).toBe(1);
      expect(db.tools.read.successes).toBe(1);
      expect(db.tools.read.failures).toBe(0);
      expect(db.tools.boom_tool.calls).toBe(1);
      expect(db.tools.boom_tool.failures).toBe(1);
      expect(db.byKind.fix.read.calls).toBe(1);
      expect(db.byKind.fix.boom_tool.failures).toBe(1);

      // Run 2: a fresh workspace object + cleared in-memory cache (a new
      // process, effectively) must see run 1's counts and add to them.
      _clearToolUsageLedgerCacheForTests();
      const workspace2 = new Workspace(dir, '.mochi');
      const ctx2: ToolContext = {
        cwd: dir, workspace: workspace2, config, events: new EventBus(), agentId: 'run-2', taskKind: 'fix',
      };
      const ok2 = await executeTool('read', { path: resolve(dir, 'hello.txt') }, ctx2, tools);
      expect(ok2.error).toBeUndefined();
      flushToolUsageLedger(workspace2);
      db = JSON.parse(readFileSync(file, 'utf8')) as ToolUsageLedger;
      expect(db.tools.read.calls).toBe(2);
      expect(db.tools.read.successes).toBe(2);
      expect(db.byKind.fix.read.calls).toBe(2);
      expect(loadToolUsageLedger(workspace2).tools.read.calls).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('record is fail-silent against a broken workspace', () => {
    const broken = {
      dir: resolve(tmpdir(), 'mochi-exposure-broken-does-not-exist'),
      readJson: () => { throw new Error('nope'); },
      writeJson: () => { throw new Error('nope'); },
    } as unknown as Workspace;
    expect(() => recordToolExposureUsage(broken, 'read', true, 'fix')).not.toThrow();
    expect(() => recordToolExposureUsage(undefined, 'read', true)).not.toThrow();
  });
});

describe('measured exposure selection', () => {
  it('keeps the core set and stays within budget across task shapes', () => {
    const samples: Array<[string, string]> = [
      ['Refactor module boundaries', 'refactor'],
      ['Fix the crash in the parser when the input file is empty', 'fix'],
      ['Implement a CSV exporter for the reports page', 'implement'],
      ['Research how the scheduler handles retries', 'research'],
      ['Write tests for the token bucket limiter', 'test'],
    ];
    for (const [text, kind] of samples) {
      const sel = selectFor(text, kind);
      expect(sel.schemaChars).toBeLessThanOrEqual(sel.budgetChars);
      expect(sel.budgetChars).toBe(DEFAULT_TOOL_SCHEMA_BUDGET_CHARS);
      const names = new Set(sel.selected.map((t) => t.def.name));
      for (const core of ['read', 'write', 'edit', 'shell', 'search', 'todo', 'load_tools']) {
        expect(names.has(core)).toBe(true);
      }
    }
  });

  it('exposes a broad set for a complex task — far above the lean tier, far below the old default', () => {
    const cfg = makeConfig('/tmp');
    const full = buildTools(cfg);
    const oldChars = toolsSchemaChars([...full.values()].map((t) => t.def));
    const sel = selectFor(
      'Move the state handling across all callers so the API contract is preserved, extend the tests in every affected module and make the whole suite green',
      'refactor',
    );
    // The old behavior for this task shape: all 69 tools, ~45K chars.
    expect(full.size).toBeGreaterThanOrEqual(65);
    expect(oldChars).toBeGreaterThan(40_000);
    // Measured: at least 40 tools (the existing complex-task floor) within budget.
    expect(sel.selected.length).toBeGreaterThanOrEqual(40);
    expect(sel.schemaChars).toBeLessThanOrEqual(DEFAULT_TOOL_SCHEMA_BUDGET_CHARS);
    expect(sel.schemaChars).toBeLessThan(oldChars);
  });

  it('ranks historically-used tools into the fill, kind history first', () => {
    const entry = (calls: number) => ({ calls, successes: calls, failures: 0, lastUsedAt: 1 });
    const ledger: ToolUsageLedger = {
      version: 1,
      updatedAt: 1,
      tools: { browser: entry(50) },
      byKind: { fix: { browser: entry(30), notebook: entry(25) } },
    };
    const sel = selectFor('Fix the login redirect loop', 'fix', ledger);
    const names = new Set(sel.selected.map((t) => t.def.name));
    // No keyword in the text implicates browser/notebook — only usage does.
    expect(names.has('browser')).toBe(true);
    expect(names.has('notebook')).toBe(true);
    expect(sel.filledNames).toContain('browser');
    expect(sel.schemaChars).toBeLessThanOrEqual(sel.budgetChars);
  });

  it('never drops an explicitly named tool, even when forced tools alone exceed the budget', () => {
    const text = 'Run db_inspect on the orders table, then session_search for the last migration discussion';
    expect(toolsNamedInText(text).has('db_inspect')).toBe(true);
    expect(toolsNamedInText(text).has('session_recall')).toBe(true); // via alias
    const sel = selectFor(text, 'implement', null, 1); // degenerate budget
    const names = new Set(sel.selected.map((t) => t.def.name));
    expect(names.has('db_inspect')).toBe(true);
    expect(names.has('session_recall')).toBe(true);
    // Core is forced too — the budget yields to forced tools, by design.
    for (const core of LEAN_TOOL_NAMES) {
      if (BUILTIN_NAMES.has(core)) expect(names.has(core)).toBe(true);
    }
  });
});

describe('escape hatch + knobs', () => {
  it('resolves mode and budget: env > config > default', () => {
    expect(toolExposureMode(null)).toBe('measured');
    expect(toolExposureMode({ toolExposure: 'full' } as MochiConfig)).toBe('full');
    process.env.MOCHI_TOOLS = 'full';
    expect(toolExposureMode({ toolExposure: 'measured' } as MochiConfig)).toBe('full');
    delete process.env.MOCHI_TOOLS;

    expect(toolSchemaBudgetChars(null)).toBe(DEFAULT_TOOL_SCHEMA_BUDGET_CHARS);
    expect(toolSchemaBudgetChars({ toolSchemaBudgetChars: 9_000 } as MochiConfig)).toBe(9_000);
    process.env.MOCHI_TOOL_SCHEMA_BUDGET = '5000';
    expect(toolSchemaBudgetChars({ toolSchemaBudgetChars: 9_000 } as MochiConfig)).toBe(5_000);
    delete process.env.MOCHI_TOOL_SCHEMA_BUDGET;
  });

  it('end-to-end: complex task advertises the measured set by default, all tools with MOCHI_TOOLS=full', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-exposure-e2e-'));
    const fake = await startFakeOpenAI([
      { content: 'Done.', finishReason: 'stop' },
      { content: 'Done.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      config.model.profiles = { fast: 'fake-fast', coding: 'fake-coding', reasoning: 'fake-reasoning' };
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      // The Agent builds its map through the role profile's allowed list —
      // compute the untrimmed count exactly the way its constructor does.
      const profile = new AgentProfileService(workspace.dir).get('coder');
      const fullCount = buildTools(config, profile?.tools).size;
      const context = new ContextEngine(config, dir);

      const runComplex = async () => {
        const bus = new EventBus();
        const logs: string[] = [];
        bus.on('agent:log', (e: any) => logs.push(e.message));
        const task = Object.assign(
          createTask('Refactor module boundaries', 'Move the state handling across all callers so the API contract is preserved, extend the tests in every affected module and make the whole suite green'),
          { fileScope: ['a.ts', 'b.ts', 'c.ts'] },
        );
        const agent = new Agent({ id: 'exposure-agent', role: 'coder', config, workspace, events: bus, cwd: dir, context });
        await agent.run(task);
        const body = fake.requests[fake.requests.length - 1]?.body;
        return { toolCount: body?.tools?.length ?? 0, logs };
      };

      const measured = await runComplex();
      expect(measured.toolCount).toBeGreaterThanOrEqual(40);
      expect(measured.toolCount).toBeLessThan(fullCount);
      expect(measured.logs.some((m) => m.includes('[tools] measured exposure (complex)'))).toBe(true);

      process.env.MOCHI_TOOLS = 'full';
      const full = await runComplex();
      expect(full.toolCount).toBe(fullCount);
      expect(full.logs.some((m) => m.includes('[tools] full exposure'))).toBe(true);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
