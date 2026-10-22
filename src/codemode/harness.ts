// CODE MODE SPIKE — measurement harness. EXPERIMENTAL; not part of the
// agent's runtime path.
//
// Method: for each fixture task, run the SAME work twice — once driven the
// direct way (one model turn per step, full JSON tool schemas attached to
// every request, every tool result appended to the transcript) and once the
// code-mode way (one model turn emits a program; the interpreter runs the
// tool calls locally; only the final program output enters the transcript).
//
// What is MEASURED (real):
//  - transcript tokens: every request payload is serialized exactly the way
//    the Anthropic provider serializes it (system + tools + messages) and
//    counted with the repo's own approxTokens (the native-parity counter).
//    API billing is per request, so input tokens are summed across turns —
//    re-sent history is charged every turn, which is the entire point.
//  - tool execution time: executeTool's own durationMs, real tools on a
//    real temp filesystem.
//  - interpreter/driver wall time.
// What is MODELED (labeled, never mixed into measured numbers):
//  - model latency: no live model runs in this harness. Latency totals are
//    shown parametrically as measured-local + turns × L for L in a small
//    table, so the reader can plug in their provider's real per-turn cost.
//  - model behavior: the scripts in fixtures.ts are fixed (the stub model
//    is perfect). Success therefore measures "does the protocol complete
//    the work", not "does a real model drive it well" — see RESULT.md.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approxTokens } from '../context.js';
import { ALL_TOOLS_MAP, executeTool } from '../tools/index.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { loadConfig } from '../config.js';
import type { Tool, ToolContext } from '../tools/types.js';
import type { ToolDefinition } from '../types.js';
import { CODEMODE_TOOLS, runCodeModeProgram } from './interpreter.js';
import { FIXTURE_TASKS, type FixtureTask } from './fixtures.js';

/** Representative shared system preamble (identical for both modes; the
 *  code-mode variant appends the API doc). Deliberately compact — the
 *  production prompt is larger, which would only widen the re-send delta. */
const SYSTEM_BASE =
  'You are Mochi, a coding agent operating in a local workspace. Use the available tools to complete the task. Prefer editing existing files over creating new ones, verify your work by running it, and keep narration brief. When the task is complete, say so in one short message.';

export interface ModeMetrics {
  taskId: string;
  mode: 'direct' | 'codemode';
  ok: boolean;
  detail: string;
  /** Model round trips (requests that would be sent to a provider). */
  turns: number;
  /** Real tool executions (identical work in both modes, ± batching). */
  toolCalls: number;
  /** Sum over turns of the full request payload tokens (what APIs bill). */
  inputTokens: number;
  /** Sum over turns of assistant-side tokens (narration + calls / program). */
  outputTokens: number;
  /** Sum of executeTool durationMs — real tool work. */
  toolMs: number;
  /** Whole driver wall time on this machine (excludes model latency). */
  wallMs: number;
}

/** The spike's tool set as a registry map (shared by harness + tests). */
export function spikeTools(): Map<string, Tool> {
  const map = new Map<string, Tool>();
  for (const name of CODEMODE_TOOLS) {
    const t = ALL_TOOLS_MAP.get(name);
    if (!t) throw new Error(`spike tool missing from registry: ${name}`);
    map.set(name, t);
  }
  return map;
}

/** A real ToolContext over a real Workspace in `dir` (shared by tests). */
export function makeSpikeCtx(dir: string): ToolContext {
  const workspace = new Workspace(dir);
  workspace.ensure();
  return {
    cwd: dir,
    workspace,
    config: loadConfig(),
    events: new EventBus(),
    agentId: 'codemode-spike',
    readCache: new Map(),
  };
}

/** Serialize tool defs exactly as src/model/anthropic.ts puts them on the
 *  wire (name/description/input_schema) — the direct-mode per-turn schema. */
export function serializeDirectSchemas(defs: ToolDefinition[]): string {
  return JSON.stringify(
    defs.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(t.parameters.map((p) => [p.name, { type: p.type, description: p.description }])),
        required: t.parameters.filter((x) => x.required).map((x) => x.name),
      },
    })),
  );
}

const TS_TYPE: Record<string, string> = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean', object: 'object', array: 'unknown[]' };

/** The code-mode API doc: compact TypeScript-style signatures generated from
 *  the same defs. This is what a code-mode system prompt carries instead of
 *  JSON schemas — generated mechanically so neither side is hand-tuned. */
export function renderCodeModeApiDoc(defs: ToolDefinition[]): string {
  const lines = [
    '// Code Mode: reply with ONE JavaScript program. It runs in a sandbox with',
    '// these async functions; await every call. Only print() output and the',
    '// completion value return to you — intermediate results stay local.',
    'declare const tools: {',
  ];
  for (const t of defs) {
    const params = t.parameters
      .map((p) => `${p.name}${p.required ? '' : '?'}: ${TS_TYPE[p.type] ?? 'unknown'}`)
      .join(', ');
    lines.push(`  /** ${t.description.split('\n')[0]} */`);
    lines.push(`  ${t.name}(args: { ${params} }): Promise<string>;`);
  }
  lines.push('};', 'declare function print(...parts: unknown[]): void;');
  return lines.join('\n');
}

type Msg = Record<string, unknown>;

function requestTokens(system: string, toolsJson: string | null, messages: Msg[]): number {
  const payload = JSON.stringify({ system, ...(toolsJson ? { tools: JSON.parse(toolsJson) } : {}), messages });
  return approxTokens(payload);
}

async function runDirect(task: FixtureTask, dir: string): Promise<ModeMetrics> {
  const tools = spikeTools();
  const ctx = makeSpikeCtx(dir);
  const schemas = serializeDirectSchemas([...tools.values()].map((t) => t.def));
  const messages: Msg[] = [{ role: 'user', content: task.prompt }];
  const started = performance.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let toolMs = 0;
  let turns = 0;

  for (const step of task.direct) {
    inputTokens += requestTokens(SYSTEM_BASE, schemas, messages);
    turns += 1;
    const assistant: Msg = {
      role: 'assistant',
      content: step.say,
      tool_calls: step.calls.map((c, i) => ({ id: `call_${turns}_${i}`, name: c.name, args: c.args })),
    };
    outputTokens += approxTokens(JSON.stringify(assistant));
    messages.push(assistant);
    for (const [i, call] of step.calls.entries()) {
      const r = await executeTool(call.name, call.args, ctx, tools);
      toolCalls += 1;
      toolMs += r.durationMs;
      messages.push({
        role: 'tool',
        tool_call_id: `call_${turns}_${i}`,
        content: r.error ? `Error: ${r.error}${r.output ? `\n${r.output}` : ''}` : r.output,
      });
    }
  }
  // Final turn: the model sees the last results and wraps up.
  inputTokens += requestTokens(SYSTEM_BASE, schemas, messages);
  turns += 1;
  outputTokens += approxTokens(JSON.stringify({ role: 'assistant', content: task.directFinalSay }));

  const [ok, detail] = task.check(dir);
  return {
    taskId: task.id, mode: 'direct', ok, detail, turns, toolCalls,
    inputTokens, outputTokens, toolMs,
    wallMs: Math.round(performance.now() - started),
  };
}

async function runCodeMode(task: FixtureTask, dir: string): Promise<ModeMetrics> {
  const tools = spikeTools();
  const ctx = makeSpikeCtx(dir);
  const defs = [...tools.values()].map((t) => t.def);
  const system = `${SYSTEM_BASE}\n\n${renderCodeModeApiDoc(defs)}`;
  const messages: Msg[] = [{ role: 'user', content: task.prompt }];
  const started = performance.now();

  // Turn 1: prompt in, program out. No tool schemas on the wire — the API
  // doc rides in the system block, counted here.
  let inputTokens = requestTokens(system, null, messages);
  let turns = 1;
  const programMsg: Msg = { role: 'assistant', content: task.program };
  const outputTokens = approxTokens(JSON.stringify(programMsg));
  messages.push(programMsg);

  const result = await runCodeModeProgram(task.program, { ctx, tools, root: dir });
  messages.push({
    role: 'user',
    content: result.ok ? `[program finished]\n${result.output}` : `[program failed] ${result.error}\n${result.output}`,
  });

  // Turn 2: the model sees only the program output and wraps up.
  inputTokens += requestTokens(system, null, messages);
  turns += 1;
  const finalSay = result.ok ? 'Done.' : 'The program failed; I would need to debug it.';
  const outTokens = outputTokens + approxTokens(JSON.stringify({ role: 'assistant', content: finalSay }));

  const [ok, detail] = task.check(dir);
  return {
    taskId: task.id, mode: 'codemode', ok: ok && result.ok, detail: result.ok ? detail : `program error: ${result.error}`,
    turns, toolCalls: result.steps,
    inputTokens, outputTokens: outTokens,
    toolMs: result.toolCalls.reduce((s, c) => s + c.durationMs, 0),
    wallMs: Math.round(performance.now() - started),
  };
}

export interface ComparisonRow {
  taskId: string;
  name: string;
  direct: ModeMetrics;
  codemode: ModeMetrics;
  inputTokenDeltaPct: number;
  totalTokenDeltaPct: number;
}

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function medianMetrics(runs: ModeMetrics[]): ModeMetrics {
  const m = runs[0];
  return {
    ...m,
    ok: runs.every((r) => r.ok),
    turns: m.turns,
    toolCalls: m.toolCalls,
    inputTokens: Math.round(median(runs.map((r) => r.inputTokens))),
    outputTokens: Math.round(median(runs.map((r) => r.outputTokens))),
    toolMs: Math.round(median(runs.map((r) => r.toolMs))),
    wallMs: Math.round(median(runs.map((r) => r.wallMs))),
  };
}

/** Run the full comparison. Each task×mode runs in a FRESH temp workspace,
 *  `repeats` times; token figures are deterministic, wall times are medians. */
export async function runComparison(tasks: FixtureTask[] = FIXTURE_TASKS, repeats = 3): Promise<ComparisonRow[]> {
  const rows: ComparisonRow[] = [];
  for (const task of tasks) {
    const directRuns: ModeMetrics[] = [];
    const codeRuns: ModeMetrics[] = [];
    for (let i = 0; i < repeats; i++) {
      for (const mode of ['direct', 'codemode'] as const) {
        // Interleave modes per repeat so machine load hits both fairly.
        const dir = mkdtempSync(join(tmpdir(), `mochi-codemode-${task.id}-`));
        try {
          task.setup(dir);
          const m = mode === 'direct' ? await runDirect(task, dir) : await runCodeMode(task, dir);
          (mode === 'direct' ? directRuns : codeRuns).push(m);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
    const direct = medianMetrics(directRuns);
    const codemode = medianMetrics(codeRuns);
    const dTotal = direct.inputTokens + direct.outputTokens;
    const cTotal = codemode.inputTokens + codemode.outputTokens;
    rows.push({
      taskId: task.id,
      name: task.name,
      direct,
      codemode,
      inputTokenDeltaPct: Math.round(((codemode.inputTokens - direct.inputTokens) / direct.inputTokens) * 1000) / 10,
      totalTokenDeltaPct: Math.round(((cTotal - dTotal) / dTotal) * 1000) / 10,
    });
  }
  return rows;
}
