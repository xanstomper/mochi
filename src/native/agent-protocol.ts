// mochi-agent stdio protocol client (Rust runtime orchestration).
//
// The TypeScript frontend owns model I/O, the TUI, and tool execution. For
// pure-compute hot paths (compaction cut planning, token estimation) it
// delegates to the native mochi-agent binary over a JSON-line stdio protocol
// and falls back to the in-process TS implementation when the binary is
// absent — same answers either way, verified by parity tests.
//
// Protocol (one JSON object per line):
//   → {"op":"ping"}                          ← {"op":"pong","version":"…"}
//   → {"op":"plan","keep":6,"messages":[…]}  ← {"op":"plan","cut":12|null,…}
//   → {"op":"exit"}

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PlanRequestMessage {
  role: string;
  content: string;
  /** number of pending tool calls on this assistant message */
  tool_calls?: number;
  tool_call_id?: string;
}

export interface PlanResponse {
  cut: number | null;
  dropped?: number;
  estimatedDroppedTokens?: number;
}

let proc: ChildProcess | null = null;
let procDead = false;
const pending = new Map<string, (line: string) => void>();
let nextId = 0;

function agentPath(): string | null {
  if (process.env.MOCHI_NO_NATIVE === '1') return null;
  if (process.env.MOCHI_AGENT_BIN && existsSync(process.env.MOCHI_AGENT_BIN)) {
    return process.env.MOCHI_AGENT_BIN;
  }
  try {
    const candidates: string[] = [];
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      candidates.push(
        resolve(here, '..', '..', 'native', 'bin', 'mochi-agent'),
        resolve(here, '..', '..', 'native', 'mochi_core', 'target', 'release', 'mochi-agent'),
      );
    } catch {
      // Bundled virtual filesystem fallback
    }
    if (process.execPath) {
      const execDir = dirname(process.execPath);
      candidates.push(
        resolve(execDir, '..', 'native', 'bin', 'mochi-agent'),
        resolve(execDir, 'native', 'bin', 'mochi-agent'),
        resolve(execDir, 'mochi-agent'),
      );
    }
    const home = homedir();
    candidates.push(
      resolve(home, 'mochi', 'native', 'bin', 'mochi-agent'),
      resolve(home, '.local', 'bin', 'mochi-agent'),
      resolve(home, '.mochi', 'bin', 'mochi-agent'),
      '/usr/local/bin/mochi-agent',
    );
    for (const p of candidates) {
      if (p && existsSync(p)) return p;
    }
    return null;
  } catch {
    return null;
  }
}

export function isRustRuntimeAvailable(): boolean {
  return agentPath() !== null;
}

function ensureProc(): ChildProcess | null {
  if (procDead) return null;
  if (proc) return proc;
  const bin = agentPath();
  if (!bin) return null;
  try {
    proc = spawn(bin, ['plan'], { stdio: ['pipe', 'pipe', 'pipe'] });
    // The plan child must never hold the host's event loop open (vitest
    // workers, one-shot CLI runs). unref() lets Node exit while it idles.
    proc.unref();
    (proc.stdout as unknown as { unref(): void }).unref();
    (proc.stderr as unknown as { unref(): void }).unref();
    (proc.stdin as unknown as { unref?(): void }).unref?.();
    proc.stdout!.setEncoding('utf-8');
    let buf = '';
    proc.stdout!.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // Single-flight: only one in-flight plan at a time is realistic for
        // compaction; resolve the oldest waiter.
        const first = pending.entries().next().value as [string, (l: string) => void] | undefined;
        if (first) {
          pending.delete(first[0]);
          first[1](line);
        }
      }
    });
    proc.on('exit', () => { procDead = true; proc = null; rejectAll(); });
    proc.on('error', () => { procDead = true; proc = null; rejectAll(); });
    return proc;
  } catch {
    procDead = true;
    return null;
  }
}

function rejectAll() {
  for (const [, fn] of pending) fn('');
  pending.clear();
}

function writeLine(line: string): Promise<string> {
  return new Promise((resolvePromise) => {
    const p = ensureProc();
    if (!p) { resolvePromise(''); return; }
    const id = `r${nextId++}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolvePromise('');
    }, 2000);
    pending.set(id, (l) => { clearTimeout(timer); resolvePromise(l); });
    try {
      p.stdin!.write(line + '\n');
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      resolvePromise('');
    }
  });
}

/** Ping the native runtime; returns its version or null when unavailable. */
export async function rustRuntimeVersion(): Promise<string | null> {
  const line = await writeLine('{"op":"ping"}');
  if (!line) return null;
  try {
    const obj = JSON.parse(line) as { op?: string; version?: string };
    return obj.op === 'pong' && obj.version ? obj.version : null;
  } catch {
    return null;
  }
}

/** Ask Rust to plan the compaction cut. Returns null on any failure so the
 *  caller falls back to the TS implementation. Like nativeTokensCount, the
 *  planner sizes messages by serialized JSON and has no image model —
 *  callers gate image-bearing histories to the TS walk (audit L-04). */
export async function nativePlanCompaction(messages: PlanRequestMessage[], keep = 6): Promise<PlanResponse | null> {
  // Availability first: serializing a large history only to discover there
  // is no runtime to send it to is a per-call full-history stringify for a
  // guaranteed null (the common case on no-native installs).
  if (!isRustRuntimeAvailable()) return null;
  const payload = JSON.stringify({ op: 'plan', keep, messages });
  if (payload.length > 4_000_000) return null; // absurd transcripts: stay in TS
  const line = await writeLine(payload);
  if (!line) return null;
  try {
    const obj = JSON.parse(line) as { op?: string; cut?: number | null };
    if (obj.op !== 'plan') return null;
    return { cut: typeof obj.cut === 'number' ? obj.cut : null };
  } catch {
    return null;
  }
}

/** Ask Rust to batch-count tokens over the message history. Entries are the
 *  ChatMessage objects themselves: the runtime extracts each element object
 *  and counts over its serialized JSON — the same JSON.stringify(m) text the
 *  TS estimateTokens() walk sums, so parity holds FOR TEXT. Image parts are
 *  the exception (audit L-04): the Rust counter has no image model, so a
 *  data-URI payload is counted as base64 text (~700× the real vision cost).
 *  Callers must not use this for histories containing image parts —
 *  context.ts's estimateTokensAsync() gates on exactly that and takes the
 *  TS walk (IMAGE_PART_TOKENS per part) instead. (Pre-stringified strings
 *  are NOT usable here: the runtime's array scanner only extracts object
 *  elements and silently skipped strings, returning 0 for the whole batch.)
 *  Returns null on any failure so the caller falls back to the TS
 *  implementation. */
export async function nativeTokensCount(messages: readonly object[]): Promise<number | null> {
  // See nativePlanCompaction: never pay the full-history stringify when no
  // runtime exists to receive it (estimateTokensAsync calls this per turn).
  if (!isRustRuntimeAvailable()) return null;
  const payload = JSON.stringify({ op: 'tokens', messages });
  if (payload.length > 4_000_000) return null;
  const line = await writeLine(payload);
  if (!line) return null;
  try {
    const obj = JSON.parse(line) as { op?: string; tokens?: number };
    if (obj.op !== 'tokens' || typeof obj.tokens !== 'number') return null;
    return obj.tokens;
  } catch {
    return null;
  }
}

/** Ask Rust to assemble a finished stream (chat() path): fold normalized
 *  StreamChunk objects into {content, reasoning, toolCalls, finishReason,
 *  usage}. Returns null on any failure so the caller falls back to the TS
 *  Map-fold. */
export interface AssembledStream {
  content: string;
  reasoning: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
}

export async function nativeAssembleStream(chunks: Record<string, unknown>[]): Promise<AssembledStream | null> {
  if (!isRustRuntimeAvailable()) return null;
  const payload = JSON.stringify({ op: 'accum', chunks });
  if (payload.length > 4_000_000) return null;
  const line = await writeLine(payload);
  if (!line) return null;
  try {
    const obj = JSON.parse(line) as { op?: string } & AssembledStream;
    if (obj.op !== 'accum') return null;
    return {
      content: obj.content ?? '',
      reasoning: obj.reasoning ?? '',
      toolCalls: Array.isArray(obj.toolCalls) ? obj.toolCalls : [],
      finishReason: obj.finishReason ?? null,
      promptTokens: obj.promptTokens ?? 0,
      completionTokens: obj.completionTokens ?? 0,
    };
  } catch {
    return null;
  }
}

/** Best-effort shutdown for tests and daemon exit. */
export function closeRustRuntime(): void {
  try { proc?.stdin?.write('{"op":"exit"}\n'); } catch { /* already gone */ }
  try { proc?.kill(); } catch { /* already gone */ }
  proc = null;
}
