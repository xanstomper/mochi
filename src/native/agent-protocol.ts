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
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '..', '..', 'native', 'bin', 'mochi-agent'),
      resolve(here, '..', '..', 'native', 'mochi_core', 'target', 'release', 'mochi-agent'),
    ];
    for (const p of candidates) if (existsSync(p)) return p;
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
 *  caller falls back to the TS implementation. */
export async function nativePlanCompaction(messages: PlanRequestMessage[], keep = 6): Promise<PlanResponse | null> {
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

/** Best-effort shutdown for tests and daemon exit. */
export function closeRustRuntime(): void {
  try { proc?.stdin?.write('{"op":"exit"}\n'); } catch { /* already gone */ }
  try { proc?.kill(); } catch { /* already gone */ }
  proc = null;
}
