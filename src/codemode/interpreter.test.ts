// Code Mode spike: interpreter contract tests — bridge executes REAL tools,
// sandbox surface is bridge-only, caps/timeouts/confinement actually fire.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodeModeProgram } from './interpreter.js';
import { makeSpikeCtx, spikeTools } from './harness.js';
import type { ToolContext } from '../tools/types.js';
import type { Tool } from '../tools/types.js';

let dir: string;
let ctx: ToolContext;
let tools: Map<string, Tool>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mochi-codemode-interp-'));
  tools = spikeTools();
  ctx = makeSpikeCtx(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('code-mode interpreter', () => {
  it('executes real tools through the bridge and returns printed output', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    const r = await runCodeModeProgram(
      'const body = await tools.read({ path: "a.txt" });\nprint(body.includes("hello") ? "saw hello" : "missing");',
      { ctx, tools, root: dir },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain('saw hello');
    expect(r.steps).toBe(1);
  });

  it('program side effects are real (write lands on disk)', async () => {
    const r = await runCodeModeProgram('await tools.write({ path: "out.txt", content: "x=1\\n" });', { ctx, tools, root: dir });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'out.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('x=1\n');
  });

  it('exposes no require/process and blocks string code generation', async () => {
    const surface = await runCodeModeProgram('print(typeof require, typeof process, typeof module);', { ctx, tools, root: dir });
    expect(surface.ok).toBe(true);
    expect(surface.output).toContain('undefined undefined undefined');
    const ev = await runCodeModeProgram('eval("1+1");', { ctx, tools, root: dir });
    expect(ev.ok).toBe(false);
    expect(ev.error ?? '').toMatch(/code generation/i);
  });

  it('tool errors throw inside the program and can be caught', async () => {
    const r = await runCodeModeProgram(
      'try { await tools.read({ path: "nope.txt" }); print("not reached"); } catch (e) { print("caught: " + e.message.slice(0, 30)); }',
      { ctx, tools, root: dir },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain('caught:');
  });

  it('enforces the step cap', async () => {
    const r = await runCodeModeProgram('for (let i = 0; i < 50; i++) { await tools.glob({ pattern: "*" }); }', {
      ctx, tools, root: dir, maxSteps: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.error ?? '').toMatch(/step cap/i);
    expect(r.steps).toBeLessThanOrEqual(6);
  });

  it('enforces the wall-clock timeout on a synchronous spin', async () => {
    const r = await runCodeModeProgram('const t = Date.now(); while (Date.now() - t < 10000) {}', {
      ctx, tools, root: dir, timeoutMs: 300,
    });
    expect(r.ok).toBe(false);
    expect(r.durationMs).toBeLessThan(5000);
  });

  it('confines file-tool paths to the workspace root', async () => {
    const caught = await runCodeModeProgram(
      'try { await tools.read({ path: "/etc/passwd" }); print("ESCAPED"); } catch (e) { print("blocked: " + e.message.slice(0, 40)); }',
      { ctx, tools, root: dir },
    );
    expect(caught.ok).toBe(true);
    expect(caught.output).toContain('blocked:');
    expect(caught.output).not.toContain('ESCAPED');
    const rel = await runCodeModeProgram('await tools.read({ path: "../outside.txt" });', { ctx, tools, root: dir });
    expect(rel.ok).toBe(false);
    expect(rel.error ?? '').toMatch(/confinement/i);
  });

  it('clips oversized program output', async () => {
    const r = await runCodeModeProgram('print("x".repeat(20000));', { ctx, tools, root: dir, maxOutputChars: 1000 });
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeLessThan(1200);
    expect(r.output).toContain('clipped');
  });
});
