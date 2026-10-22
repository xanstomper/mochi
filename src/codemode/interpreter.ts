// CODE MODE SPIKE — EXPERIMENTAL, NOT WIRED INTO THE AGENT LOOP.
//
// A sandboxed interpreter for programmatic tool calls: instead of one model
// round trip per tool call, the model writes ONE small JavaScript program
// that calls tools through a bridge, and only the program's final output
// returns to the model. This module exists to MEASURE whether that protocol
// beats direct tool calls (see harness.ts + bench/codemode.ts); it is not a
// production execution path and nothing in the default agent imports it.
//
// Sandbox posture (honest): node:vm with string code generation disabled
// (no eval / new Function inside), a bridge-only global surface (no require,
// no process, no fs), an allowlisted tool set executed through the SAME
// executeTool chokepoint direct mode uses (same validation, permissions and
// usage recording), file-tool path confinement to the workspace root, a tool
// step cap, and wall-clock timeouts. node:vm is NOT a hard security boundary
// against a determined escape artist — a production version would run this
// in a worker/isolate and keep the identical bridge protocol over IPC. What
// the spike evaluates (round trips, transcript tokens, latency shape) is
// unaffected by that deployment choice.
import vm from 'node:vm';
import { isAbsolute, resolve, sep } from 'node:path';
import { executeTool } from '../tools/index.js';
import type { Tool, ToolContext } from '../tools/types.js';

/** Tools a code-mode program may call in this spike. Deliberately the small
 *  file/search/shell core the fixture tasks need; no network tools exist in
 *  the bridge at all, which is what "no network" means here. */
export const CODEMODE_TOOLS = ['read', 'write', 'edit', 'search', 'glob', 'shell'] as const;

/** Args keys that carry filesystem paths for the bridged file tools; each is
 *  confinement-checked before the call reaches executeTool. */
const PATH_ARG_KEYS: Record<string, string[]> = {
  read: ['path'],
  write: ['path'],
  edit: ['path'],
  search: ['path'],
  glob: ['path'],
  shell: ['cwd'],
};

export interface CodeModeLimits {
  /** Hard wall-clock budget for the whole program (default 30s). */
  timeoutMs?: number;
  /** Max bridge tool calls per program (default 100). */
  maxSteps?: number;
  /** Cap on the text returned to the model (default 8000 chars). */
  maxOutputChars?: number;
}

export interface CodeModeRunResult {
  ok: boolean;
  /** Printed output + program return value, clipped to maxOutputChars. */
  output: string;
  error?: string;
  /** Bridge tool calls actually executed. */
  steps: number;
  toolCalls: Array<{ name: string; durationMs: number }>;
  durationMs: number;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[clipped ${text.length - max} chars]…\n${text.slice(text.length - tail)}`;
}

/** Reject absolute paths outside the root and `..` escapes for file tools.
 *  Relative paths resolve against the root, exactly like the tools do. */
function assertConfined(root: string, tool: string, args: Record<string, unknown>): void {
  for (const key of PATH_ARG_KEYS[tool] ?? []) {
    const v = args[key];
    if (typeof v !== 'string' || v.length === 0) continue;
    const abs = isAbsolute(v) ? resolve(v) : resolve(root, v);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`code-mode confinement: ${tool} ${key}=${JSON.stringify(v)} escapes the workspace`);
    }
  }
}

/**
 * Run one code-mode program against real tools.
 *
 * The program runs as the body of an async function with two globals:
 *   tools.<name>(args) -> Promise<string>   (the bridge; throws on tool error)
 *   print(...parts)                          (captured into the result)
 * Its completion value (if not undefined) is appended to the output.
 */
export async function runCodeModeProgram(
  program: string,
  opts: {
    ctx: ToolContext;
    tools: Map<string, Tool>;
    root: string;
    allowedTools?: readonly string[];
  } & CodeModeLimits,
): Promise<CodeModeRunResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxSteps = opts.maxSteps ?? 100;
  const maxOutputChars = opts.maxOutputChars ?? 8_000;
  const allowed = opts.allowedTools ?? CODEMODE_TOOLS;
  const started = performance.now();
  const printed: string[] = [];
  const toolCalls: CodeModeRunResult['toolCalls'] = [];
  let steps = 0;
  let aborted = false;

  const bridge: Record<string, (args?: Record<string, unknown>) => Promise<string>> = {};
  for (const name of allowed) {
    bridge[name] = async (args: Record<string, unknown> = {}) => {
      if (aborted) throw new Error('code-mode: program aborted (limit exceeded)');
      steps += 1;
      if (steps > maxSteps) {
        aborted = true;
        throw new Error(`code-mode: step cap exceeded (max ${maxSteps} tool calls)`);
      }
      assertConfined(opts.root, name, args);
      const r = await executeTool(name, args, opts.ctx, opts.tools);
      toolCalls.push({ name, durationMs: r.durationMs });
      if (r.error) throw new Error(`${name}: ${r.error}`);
      return r.output;
    };
  }
  const print = (...parts: unknown[]) => {
    printed.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
  };

  const context = vm.createContext(
    { tools: bridge, print, console: { log: print } },
    { codeGeneration: { strings: false, wasm: false } },
  );

  const wrapped = `(async () => { "use strict";\n${program}\n})()`;
  let completion: Promise<unknown>;
  try {
    // The vm timeout covers the synchronous segment (up to the first await);
    // the host-side race below covers the rest, as far as a single-threaded
    // runtime allows (a purely synchronous infinite loop after an await can
    // still starve the event loop — documented spike limit).
    completion = vm.runInContext(wrapped, context, { timeout: timeoutMs }) as Promise<unknown>;
  } catch (err) {
    return {
      ok: false,
      output: clip(printed.join('\n'), maxOutputChars),
      error: err instanceof Error ? err.message : String(err),
      steps,
      toolCalls,
      durationMs: Math.round(performance.now() - started),
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          aborted = true;
          reject(new Error(`code-mode: timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    const parts = [...printed];
    if (value !== undefined) parts.push(typeof value === 'string' ? value : JSON.stringify(value));
    return {
      ok: true,
      output: clip(parts.join('\n'), maxOutputChars),
      steps,
      toolCalls,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (err) {
    return {
      ok: false,
      output: clip(printed.join('\n'), maxOutputChars),
      error: err instanceof Error ? err.message : String(err),
      steps,
      toolCalls,
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
