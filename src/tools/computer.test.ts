// Computer tool tests (Phase E12): the permission tier (denied without
// explicit opt-in at BOTH the executeTool dispatcher gate and the tool
// itself; never auto-allowed by the approval layer) and the
// screenshot-after-action contract, exercised end-to-end against the
// deterministic fake display backend.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { computerTool, computerOptInError } from './computer.js';
import { executeTool, ALL_TOOLS_MAP } from './index.js';
import { FakeDisplayBackend } from '../computer/fake-display.js';
import { setDisplayBackendForTests } from '../computer/backend.js';
import { decodePngRgba } from '../computer/png.js';
import { PermissionManager } from '../security/permission.js';
import { loadConfig } from '../config.js';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import type { MochiConfig } from '../types.js';
import type { ToolContext } from './types.js';

let dir: string;
let fake: FakeDisplayBackend;
const ENV_KEYS = ['MOCHI_COMPUTER', 'MOCHI_PERMISSION_COMPUTER', 'MOCHI_COMPUTER_BACKEND', 'DISPLAY', 'MOCHI_DISPLAY'];
let savedEnv: Record<string, string | undefined> = {};

function makeConfig(permissions: Record<string, boolean | undefined>): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true, ...permissions },
    telemetry: false,
    projectDir: dir,
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function makeCtx(permissions: Record<string, boolean | undefined>): ToolContext {
  return {
    cwd: dir,
    workspace: new Workspace(dir, '.mochi'),
    config: makeConfig(permissions),
    events: new EventBus(),
    agentId: 'computer-test',
  };
}

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-computer-'));
  fake = new FakeDisplayBackend(800, 600);
  setDisplayBackendForTests(fake);
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  setDisplayBackendForTests(null);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('computer tool definition', () => {
  it('is registered with the "computer" permission tier and marked dangerous', () => {
    const registered = ALL_TOOLS_MAP.get('computer');
    expect(registered).toBe(computerTool);
    expect(computerTool.def.permission).toBe('computer');
    expect(computerTool.def.dangerous).toBe(true);
    expect(computerTool.def.name).toBe('computer');
  });
});

describe('computer permission tier', () => {
  it('denies at the executeTool dispatcher gate without opt-in', async () => {
    const { output, error } = await executeTool('computer', { action: 'screenshot' }, makeCtx({}), new Map());
    expect(output).toBe('');
    expect(error).toContain('Permission denied for tool computer (computer)');
  });

  it('denies at the tool itself without opt-in (direct execute bypass)', async () => {
    const ctx = makeCtx({});
    expect(computerOptInError(ctx)).toContain('permission denied');
    const out = await computerTool.execute({ action: 'screenshot' }, ctx);
    expect(out).toContain('computer: permission denied');
    // And no screenshot was produced as a side effect of the denied call.
    const shotDir = resolve(dir, '.mochi', 'state', 'computer');
    expect(existsSync(shotDir)).toBe(false);
  });

  it('is never auto-allowed by the approval layer (headless deny-by-default)', () => {
    for (const policy of ['strict', 'workspace-safe'] as const) {
      const mgr = new PermissionManager(policy, dir);
      expect(mgr.autoAllow({ tool: 'computer', args: { action: 'click' }, cwd: dir, workspaceDir: dir })).toBe(false);
      expect(mgr.autoAllowAs('workspace-safe', { tool: 'computer', args: { action: 'click' }, cwd: dir, workspaceDir: dir })).toBe(false);
    }
  });

  it('default config does NOT enable computer (stricter than shell)', () => {
    const cfg = loadConfig({}, undefined, dir);
    expect(cfg.permissions.shell).toBe(true);
    expect(cfg.permissions.computer).toBeFalsy();
  });

  it('MOCHI_COMPUTER=1 is the explicit session opt-in in the config loader', () => {
    process.env.MOCHI_COMPUTER = '1';
    try {
      const cfg = loadConfig({}, undefined, dir);
      expect(cfg.permissions.computer).toBe(true);
    } finally {
      delete process.env.MOCHI_COMPUTER;
    }
  });

  it('allows via env opt-in even when config lacks the flag (tool-level check)', async () => {
    process.env.MOCHI_COMPUTER = '1';
    const ctx = makeCtx({});
    expect(computerOptInError(ctx)).toBeNull();
    const out = await computerTool.execute({ action: 'screenshot' }, ctx);
    expect(out).toContain('[computer screenshot] ok');
  });
});

describe('computer tool actions (fake backend)', () => {
  it('click performs the action and returns a fresh screenshot file', async () => {
    const ctx = makeCtx({ computer: true });
    const out = await computerTool.execute({ action: 'click', x: 100, y: 120 }, ctx);
    expect(out).toContain('[computer click] ok');
    expect(out).toContain('button 1 at (100, 120)');
    const m = /screenshot: (\S+shot-\d+\.png)/.exec(out);
    expect(m).not.toBeNull();
    const png = readFileSync(m![1]);
    const decoded = decodePngRgba(png);
    expect(decoded.width).toBe(800);
    expect(decoded.height).toBe(600);
    expect(fake.buttonLog).toEqual(['b1:down', 'b1:up']);
  });

  it('screenshot-after-action: the returned frame reflects the action just taken', async () => {
    const ctx = makeCtx({ computer: true });
    const out1 = await computerTool.execute({ action: 'move', x: 40, y: 40 }, ctx);
    const path1 = /screenshot: (\S+)/.exec(out1)![1];
    const out2 = await computerTool.execute({ action: 'move', x: 400, y: 300 }, ctx);
    const path2 = /screenshot: (\S+)/.exec(out2)![1];
    expect(path1).not.toBe(path2);
    expect(readFileSync(path1).equals(readFileSync(path2))).toBe(false);
    // The second frame is exactly the fake backend's current state.
    const current = await fake.captureRgba();
    const decoded = decodePngRgba(readFileSync(path2));
    expect(decoded.rgba.equals(current)).toBe(true);
  });

  it('types text and presses combos through the backend', async () => {
    const ctx = makeCtx({ computer: true });
    const out = await computerTool.execute({ action: 'type', text: 'hi' }, ctx);
    expect(out).toContain('typed 2 characters');
    expect(fake.typedText).toBe('hi');
    const out2 = await computerTool.execute({ action: 'key', key: 'ctrl+a' }, ctx);
    expect(out2).toContain('pressed ctrl+a');
    expect(fake.keyLog).toContain('ctrl:down');
    expect(fake.keyLog).toContain('ctrl:up');
  });

  it('scrolls and drags', async () => {
    const ctx = makeCtx({ computer: true });
    const out = await computerTool.execute({ action: 'scroll', dy: 2 }, ctx);
    expect(out).toContain('scrolled dx=0 dy=2');
    expect(fake.buttonLog.filter((l) => l.startsWith('b5'))).toHaveLength(4); // 2 clicks × down/up
    const drag = await computerTool.execute({ action: 'drag', x: 10, y: 10, x2: 60, y2: 60 }, ctx);
    expect(drag).toContain('dragged from (10, 10) to (60, 60)');
    expect(await fake.pointer()).toMatchObject({ x: 60, y: 60 });
  });

  it('reports backend/input errors as text instead of throwing', async () => {
    const ctx = makeCtx({ computer: true });
    const out = await computerTool.execute({ action: 'type', text: '€' }, ctx);
    expect(out).toContain('computer: type failed');
    const out2 = await computerTool.execute({ action: 'bogus' }, ctx);
    expect(out2).toContain('action required');
  });

  it('works end-to-end through executeTool with opt-in', async () => {
    const { output, error } = await executeTool('computer', { action: 'screenshot' }, makeCtx({ computer: true }), new Map());
    expect(error).toBeUndefined();
    expect(output).toContain('[computer screenshot] ok');
    const files = readdirSync(resolve(dir, '.mochi', 'state', 'computer'));
    expect(files.some((f) => f.endsWith('.png'))).toBe(true);
  });
});
