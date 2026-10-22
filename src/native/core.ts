// Mochi Native Core Engine Bridge (Rust <-> Node/Bun)
// Zero-copy in-process acceleration for fuzzy matching, git status, search, token estimation, and reasoning stripping.

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export interface NativeFuzzyResult {
  start: number;
  end: number;
}

export interface NativeDiffStats {
  files: number;
  additions: number;
  deletions: number;
}

let napiModule: Record<string, unknown> | null = null;
let bunLib: { symbols: Record<string, (...args: unknown[]) => number> } | null = null;
/** Cached Bun `ptr()` from init: set iff bunLib was loaded (same branch). */
let bunPtr: ((buf: object) => unknown) | null = null;
let ffiAvailable = false;
let probed = false;

/** Minimal typing for Bun's optional FFI surface. The harness runs on node
 *  by default; every access is feature-detected through `detectBunFFI()`,
 *  never assumed — unknown runtimes fall through to the TS implementations. */
interface BunFFI {
  dlopen(path: string, defs: Record<string, unknown>): { symbols: Record<string, (...args: unknown[]) => number> };
  FFIType: Record<string, unknown>;
  ptr(buf: object): unknown;
}

function detectBunFFI(): BunFFI | undefined {
  const g = globalThis as unknown as { Bun?: Partial<BunFFI> };
  const b = g.Bun;
  if (b && typeof b.dlopen === 'function' && b.FFIType && typeof b.ptr === 'function') {
    return b as BunFFI;
  }
  return undefined;
}

function findNativePaths(): { nodeAddon: string | null; sharedLib: string | null } {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const addonCandidates = [
      resolve(here, '..', '..', 'native', 'bin', 'mochi_core.node'),
      resolve(here, '..', '..', 'native', 'mochi_core', 'target', 'release', 'libmochi_core.so'),
      resolve(here, '..', '..', 'native', 'mochi_core', 'target', 'release', 'libmochi_core.dylib'),
      resolve(here, '..', '..', 'native', 'mochi_core', 'target', 'release', 'mochi_core.dll'),
    ];
    let nodeAddon: string | null = null;
    for (const p of addonCandidates) {
      if (existsSync(p)) {
        nodeAddon = p;
        break;
      }
    }

    const libCandidates = [
      resolve(here, '..', '..', 'native', 'bin', 'libmochi_core.so'),
      resolve(here, '..', '..', 'native', 'mochi_core', 'target', 'release', 'libmochi_core.so'),
      resolve(here, '..', '..', 'native', 'mochi_core', 'target', 'release', 'libmochi_core.dylib'),
      resolve(here, '..', '..', 'native', 'mochi_core', 'target', 'release', 'mochi_core.dll'),
    ];
    let sharedLib: string | null = null;
    for (const p of libCandidates) {
      if (existsSync(p)) {
        sharedLib = p;
        break;
      }
    }

    return { nodeAddon, sharedLib };
  } catch {
    return { nodeAddon: null, sharedLib: null };
  }
}

function initNativeCore() {
  if (probed) return;
  probed = true;
  const { nodeAddon, sharedLib } = findNativePaths();

  // 1. Try Node.js in-process N-API module (works in Node.js v18, v20, v22+)
  if (nodeAddon) {
    try {
      const nodeRequire = createRequire(import.meta.url);
      napiModule = nodeRequire(nodeAddon);
      if (napiModule && typeof napiModule.gitBranch === 'function') {
        ffiAvailable = true;
        return;
      }
    } catch {}
  }

  // 2. Try Bun native FFI (if running under Bun runtime)
  const bun = detectBunFFI();
  if (sharedLib && bun) {
    try {
      const { dlopen, FFIType } = bun;
      bunLib = dlopen(sharedLib, {
        mochi_fuzzy_match: {
          args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
        mochi_git_branch: {
          args: [FFIType.cstring, FFIType.ptr, FFIType.usize],
          returns: FFIType.i32,
        },
        mochi_search: {
          args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.usize, FFIType.ptr, FFIType.usize],
          returns: FFIType.i32,
        },
        mochi_strip_think_tags: {
          args: [FFIType.cstring, FFIType.ptr, FFIType.usize],
          returns: FFIType.i32,
        },
        mochi_hash_prompt: {
          args: [FFIType.ptr, FFIType.usize],
          returns: FFIType.u64,
        },
        mochi_estimate_cost_usd: {
          args: [FFIType.cstring, FFIType.u64, FFIType.u64, FFIType.u64],
          returns: FFIType.f64,
        },
        mochi_diff_numstat: {
          args: [FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
        mochi_classify_prompt: {
          args: [FFIType.cstring],
          returns: FFIType.i32,
        },
        mochi_redact_secrets: {
          args: [FFIType.cstring, FFIType.ptr, FFIType.usize],
          returns: FFIType.i32,
        },
        mochi_budget_decide: {
          args: [FFIType.cstring, FFIType.ptr, FFIType.usize],
          returns: FFIType.i32,
        },
        mochi_classify_command: {
          args: [FFIType.cstring],
          returns: FFIType.i32,
        },
        mochi_fold_output: {
          args: [FFIType.cstring, FFIType.ptr, FFIType.usize],
          returns: FFIType.i32,
        },
        mochi_command_available: {
          args: [FFIType.cstring, FFIType.ptr, FFIType.usize],
          returns: FFIType.i32,
        },
        mochi_strip_ansi: {
          args: [FFIType.cstring, FFIType.ptr, FFIType.usize],
          returns: FFIType.i32,
        },
      });
      if (bunLib) {
        bunPtr = (buf: object) => bun.ptr(buf);
        ffiAvailable = true;
        return;
      }
    } catch {}
  }
}

/**
 * Fast in-process Rust fuzzy matcher. Returns unique match bounds or null.
 */
export function nativeFuzzyMatch(text: string, needle: string): NativeFuzzyResult | null {
  initNativeCore();
  if (!ffiAvailable) return null;

  if (napiModule && typeof napiModule.fuzzyMatch === 'function') {
    try {
      return napiModule.fuzzyMatch(text, needle) ?? null;
    } catch {
      return null;
    }
  }

  if (bunLib) {
    try {
      const startBuf = new BigUint64Array(1);
      const endBuf = new BigUint64Array(1);
      if (!bunPtr) throw new Error('bun FFI ptr unavailable');
      const ptr = bunPtr;
      const res = bunLib.symbols.mochi_fuzzy_match(
        Buffer.from(text + '\0'),
        Buffer.from(needle + '\0'),
        ptr(startBuf),
        ptr(endBuf),
      );
      if (res === 1) {
        return { start: Number(startBuf[0]), end: Number(endBuf[0]) };
      }
    } catch {}
  }

  return null;
}

/**
 * Fast in-process Rust git branch discovery (<0.05ms).
 */
export function nativeGitBranch(dir: string): string | null {
  initNativeCore();
  if (!ffiAvailable) return null;

  if (napiModule && typeof napiModule.gitBranch === 'function') {
    try {
      return napiModule.gitBranch(dir) ?? null;
    } catch {
      return null;
    }
  }

  if (bunLib) {
    try {
      const buf = Buffer.alloc(256);
      if (!bunPtr) throw new Error('bun FFI ptr unavailable');
      const ptr = bunPtr;
      const len = bunLib.symbols.mochi_git_branch(
        Buffer.from(dir + '\0'),
        ptr(buf),
        buf.length,
      );
      if (len > 0) {
        return buf.toString('utf8', 0, len);
      }
    } catch {}
  }

  return null;
}

/**
 * Fast in-process Rust directory search.
 */
export function nativeSearchDir(dir: string, query: string, glob = '', limit = 60): string | null {
  initNativeCore();
  if (!ffiAvailable) return null;

  if (napiModule && typeof napiModule.searchDir === 'function') {
    try {
      return napiModule.searchDir(dir, query, glob, limit) ?? null;
    } catch {
      return null;
    }
  }

  if (bunLib) {
    try {
      const buf = Buffer.alloc(256_000);
      if (!bunPtr) throw new Error('bun FFI ptr unavailable');
      const ptr = bunPtr;
      const len = bunLib.symbols.mochi_search(
        Buffer.from(dir + '\0'),
        Buffer.from(query + '\0'),
        Buffer.from(glob + '\0'),
        limit,
        ptr(buf),
        buf.length,
      );
      if (len > 0) {
        return buf.toString('utf8', 0, len);
      }
    } catch {}
  }

  return null;
}

/**
 * Fast in-process Rust reasoning / think-tag sanitizer.
 */
export function nativeStripThinkTags(text: string): string | null {
  initNativeCore();
  if (!ffiAvailable) return null;

  if (napiModule && typeof napiModule.stripThinkTags === 'function') {
    try {
      return napiModule.stripThinkTags(text) ?? null;
    } catch {
      return null;
    }
  }

  if (bunLib) {
    try {
      const buf = Buffer.alloc(Math.max(4096, text.length + 128));
      if (!bunPtr) throw new Error('bun FFI ptr unavailable');
      const ptr = bunPtr;
      const len = bunLib.symbols.mochi_strip_think_tags(
        Buffer.from(text + '\0'),
        ptr(buf),
        buf.length,
      );
      if (len >= 0) {
        return buf.toString('utf8', 0, len);
      }
    } catch {}
  }

  return null;
}

/**
 * Fast in-process 64-bit FNV-1a hash of prompt bytes for KV cache prefix indexing.
 */
export function nativeHashPrompt(text: string): bigint | null {
  initNativeCore();
  if (!ffiAvailable) return null;

  if (napiModule && typeof napiModule.hashPrompt === 'function') {
    try {
      const h = napiModule.hashPrompt(text);
      if (h !== null && h !== undefined) return BigInt(h);
    } catch {}
  }

  if (bunLib) {
    try {
      const buf = Buffer.from(text, 'utf8');
      if (!bunPtr) throw new Error('bun FFI ptr unavailable');
      const ptr = bunPtr;
      const h = bunLib.symbols.mochi_hash_prompt(ptr(buf), buf.length);
      return BigInt(h);
    } catch {}
  }

  return null;
}

/**
 * Fast in-process model cost estimation in USD.
 */
export function nativeEstimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0,
): number | null {
  initNativeCore();
  if (!ffiAvailable) return null;

  if (napiModule && typeof napiModule.estimateCost === 'function') {
    try {
      return napiModule.estimateCost(model, promptTokens, completionTokens, cacheReadTokens);
    } catch {
      return null;
    }
  }

  if (bunLib) {
    try {
      const cost = bunLib.symbols.mochi_estimate_cost_usd(
        Buffer.from(model + '\0'),
        BigInt(promptTokens),
        BigInt(completionTokens),
        BigInt(cacheReadTokens),
      );
      return Number(cost);
    } catch {}
  }

  return null;
}

/**
 * Fast in-process git diff numstat line parser.
 */
export function nativeDiffNumstat(output: string): NativeDiffStats | null {
  initNativeCore();
  if (!ffiAvailable) return null;

  if (napiModule && typeof napiModule.diffNumstat === 'function') {
    try {
      return napiModule.diffNumstat(output) ?? null;
    } catch {
      return null;
    }
  }

  if (bunLib) {
    try {
      const filesBuf = new BigUint64Array(1);
      const addBuf = new BigUint64Array(1);
      const delBuf = new BigUint64Array(1);
      if (!bunPtr) throw new Error('bun FFI ptr unavailable');
      const ptr = bunPtr;
      const res = bunLib.symbols.mochi_diff_numstat(
        Buffer.from(output + '\0'),
        ptr(filesBuf),
        ptr(addBuf),
        ptr(delBuf),
      );
      if (res === 1) {
        return {
          files: Number(filesBuf[0]),
          additions: Number(addBuf[0]),
          deletions: Number(delBuf[0]),
        };
      }
    } catch {}
  }

  return null;
}

/**
 * Fast in-process task kind classifier.
 */
export function nativeClassifyPrompt(prompt: string): string | null {
  initNativeCore();
  if (!ffiAvailable) return null;

  if (napiModule && typeof napiModule.classifyPrompt === 'function') {
    try {
      return napiModule.classifyPrompt(prompt) ?? null;
    } catch {
      return null;
    }
  }

  if (bunLib) {
    try {
      const code = bunLib.symbols.mochi_classify_prompt(Buffer.from(prompt + '\0'));
      switch (code) {
        case 1: return 'code-edit';
        case 2: return 'investigation';
        case 3: return 'testing';
        case 4: return 'refactor';
        case 5: return 'architecture';
        case 6: return 'one-shot-answer';
        default: return null;
      }
    } catch {}
  }

  return null;
}

export function isNativeCoreAvailable(): boolean {
  initNativeCore();
  return ffiAvailable;
}

/**
 * Rust BPE token counting (heuristic vocabulary). Returns null when the
 * native core is unavailable; callers fall back to approxTokens.
 */
export function nativeCountTokens(text: string): number | null {
  initNativeCore();
  if (!ffiAvailable) return null;
  if (napiModule && typeof napiModule.countTokens === 'function') {
    try {
      const n = napiModule.countTokens(text);
      return typeof n === 'number' && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }
  return null; // Bun FFI path not wired for tokenizer; falls back to TS.
}

/**
 * Rust token-budget truncation: keeps the head of `text` within `maxTokens`.
 * Returns null when native is unavailable; caller falls back to char slicing.
 */
export function nativeTruncateToTokens(text: string, maxTokens: number): string | null {
  initNativeCore();
  if (!ffiAvailable) return null;
  if (napiModule && typeof napiModule.truncateToTokens === 'function') {
    try {
      const out = napiModule.truncateToTokens(text, maxTokens);
      return typeof out === 'string' ? out : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fast in-process Rust Myers line diff engine. Returns unified diff string or null.
 */
export function nativeUnifiedDiff(
  oldText: string,
  newText: string,
  oldFile = 'a/file',
  newFile = 'b/file',
): string | null {
  initNativeCore();
  if (!ffiAvailable) return null;
  if (napiModule && typeof napiModule.unifiedDiff === 'function') {
    try {
      const out = napiModule.unifiedDiff(oldText, newText, oldFile, newFile);
      return typeof out === 'string' ? out : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fast in-process Rust AST source skeletonizer.
 * Collapses function/class bodies into `{ ... }` while preserving signatures.
 */
export function nativeSkeletonizeSource(source: string, ext = 'ts'): string | null {
  initNativeCore();
  if (!ffiAvailable) return null;
  if (napiModule && typeof napiModule.skeletonizeSource === 'function') {
    try {
      const out = napiModule.skeletonizeSource(source, ext);
      return typeof out === 'string' ? out : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fast in-process Rust secret-pattern redaction. Mirrors the patterns in
 * `src/security/security.ts` (sk-, sk-ant-, AIza, gh*, AKIA, JWT,
 * Bearer, PRIVATE KEY, xox*, glpat-) and replaces every match with
 * `[secret-redacted]`. The mirror is maintained by hand and may lag the
 * TS list; redact() in security.ts composes (native first, TS pass always
 * runs), so lag costs speed, never coverage.
 *
 * Returns the redacted string, or `null` when the native core is unavailable
 * (caller should fall back to the in-process TS implementation).
 */
export function nativeRedactSecrets(input: string): string | null {
  initNativeCore();
  if (!ffiAvailable || !input) return input ? null : '';

  if (napiModule && typeof napiModule.redactSecrets === 'function') {
    try {
      const out = napiModule.redactSecrets(input);
      return typeof out === 'string' ? out : null;
    } catch {
      return null;
    }
  }

  if (bunLib) {
    try {
      // The C-ABI takes an out-buffer; size it to 2x input + slack (matches
      // can only shorten the string to a fixed 16-byte literal, so 2x is
      // overkill but safe for inputs that are mostly secrets).
      const cap = Math.max(64, input.length * 2 + 64);
      const buf = Buffer.alloc(cap);
      if (!bunPtr) throw new Error('bun FFI ptr unavailable');
      const ptr = bunPtr;
      const written = bunLib.symbols.mochi_redact_secrets(
        Buffer.from(input + '\0'),
        ptr(buf),
        buf.length,
      );
      if (written < 0) return null;
      // NUL-terminated copy
      let end = buf.indexOf(0);
      if (end < 0) end = Math.min(written, buf.length);
      return buf.toString('utf8', 0, end);
    } catch {
      return null;
    }
  }

  return null;
}

/** Phase code returned by `nativeBudgetDecide`. */
export const BUDGET_PHASES = ['exhausted', 'verify', 'cheap', 'reduced', 'full'] as const;
export type BudgetPhase = (typeof BUDGET_PHASES)[number];

export interface BudgetDecision {
  /** Ratio in [0, 1] — most-constrained dimension wins. 1.0 = no cap. */
  ratio: number;
  /** 0=exhausted, 1=verify, 2=cheap, 3=reduced, 4=full. */
  phase: number;
  /** Human-readable phase name (matches `BUDGET_PHASES[phase]`). */
  phaseName: BudgetPhase;
}

/**
 * Fast in-process Rust budget decision: given current limits and used
 * counters, returns the most-constrained ratio + phase code. Mirrors
 * `BudgetEngine.ratio()` + `BudgetEngine.phase()` in `src/budget.ts` and
 * runs on every turn. Pass `Infinity` for any cap you don't want to apply
 * (matches the TS `Number.isFinite` check).
 */
export function nativeBudgetDecide(
  limits: {
    maxTokens: number;
    maxCostUsd: number;
    maxDurationMs: number;
    maxToolCalls: number;
    maxModelCalls: number;
  },
  used: {
    usedTokens: number;
    usedCostUsd: number;
    usedDurationMs: number;
    usedToolCalls: number;
    usedModelCalls: number;
  },
): BudgetDecision | null {
  initNativeCore();
  if (!ffiAvailable) return null;

  const input = JSON.stringify({ limits, used });
  let jsonOut: string | null = null;

  if (napiModule && typeof napiModule.budgetDecide === 'function') {
    try {
      const out = napiModule.budgetDecide(input);
      if (typeof out === 'string') jsonOut = out;
    } catch {
      return null;
    }
  }

  if (!jsonOut && bunLib) {
    try {
      const cap = 256;
      const buf = Buffer.alloc(cap);
      if (!bunPtr) throw new Error('bun FFI ptr unavailable');
      const ptr = bunPtr;
      const written = bunLib.symbols.mochi_budget_decide(
        Buffer.from(input + '\0'),
        ptr(buf),
        buf.length,
      );
      if (written < 0) return null;
      let end = buf.indexOf(0);
      if (end < 0) end = Math.min(written, buf.length);
      jsonOut = buf.toString('utf8', 0, end);
    } catch {
      return null;
    }
  }

  if (!jsonOut) return null;
  try {
    const parsed = JSON.parse(jsonOut) as { ratio: number; phase: number };
    const phaseName = (BUDGET_PHASES[parsed.phase] ?? 'full') as BudgetPhase;
    return { ratio: parsed.ratio, phase: parsed.phase, phaseName };
  } catch {
    return null;
  }
}

/** Result of `nativeClassifyCommand`. */
export type CommandRiskNative = 'low' | 'network' | 'destructive';

/**
 * Fast in-process Rust shell-command risk classifier. Mirrors
 * `classifyCommand()` in `src/security.ts` byte-for-byte and runs on every
 * shell tool call. Returns the risk label as a string.
 */
export function nativeClassifyCommand(cmd: string): CommandRiskNative | null {
  initNativeCore();
  if (!ffiAvailable) return null;

  if (napiModule && typeof napiModule.classifyCommand === 'function') {
    try {
      const code = napiModule.classifyCommand(cmd);
      if (typeof code === 'string') {
        const v = code.trim().toLowerCase();
        if (v === 'low' || v === 'network' || v === 'destructive') {
          return v as CommandRiskNative;
        }
        if (v === '0') return 'low';
        if (v === '1') return 'network';
        if (v === '2') return 'destructive';
      } else if (typeof code === 'number') {
        if (code === 0) return 'low';
        if (code === 1) return 'network';
        if (code === 2) return 'destructive';
      }
    } catch {
      return null;
    }
  }

  if (bunLib) {
    try {
      const code = bunLib.symbols.mochi_classify_command(Buffer.from(cmd + '\0'));
      if (code === 0) return 'low';
      if (code === 1) return 'network';
      if (code === 2) return 'destructive';
    } catch {
      return null;
    }
  }

  return null;
}

/** Result of `nativeFoldOutput` — the head/tail line selection for a tool
 *  result. Mirrors the line/byte logic in `src/core/tool-output.ts`. */
export interface NativeFoldResult {
  head: string[];
  tail: string[];
  omitted: number;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | 'none';
  totalLines: number;
  totalBytes: number;
}

/**
 * Fast in-process Rust head/tail fold for tool output. Mirrors
 * `applyToolOutputPolicy()` in `src/core/tool-output.ts` for the pure line
 * selection; the TS wrapper keeps the file-spill and telemetry side effects.
 * Returns null when the native core is unavailable.
 */
export function nativeFoldOutput(
  text: string,
  maxLines: number,
  maxBytes: number,
): NativeFoldResult | null {
  initNativeCore();
  if (!ffiAvailable) return null;

  const input = JSON.stringify({ text, maxLines, maxBytes });
  let jsonOut: string | null = null;

  if (napiModule && typeof napiModule.foldOutput === 'function') {
    try {
      const out = napiModule.foldOutput(input);
      if (typeof out === 'string') jsonOut = out;
    } catch {
      return null;
    }
  }

  if (!jsonOut && bunLib) {
    try {
      const cap = 65_536;
      const buf = Buffer.alloc(cap);
      if (!bunPtr) throw new Error('bun FFI ptr unavailable');
      const ptr = bunPtr;
      const written = bunLib.symbols.mochi_fold_output(
        Buffer.from(input + '\0'),
        ptr(buf),
        buf.length,
      );
      if (written < 0) return null;
      let end = buf.indexOf(0);
      if (end < 0) end = Math.min(written, buf.length);
      jsonOut = buf.toString('utf8', 0, end);
    } catch {
      return null;
    }
  }

  if (!jsonOut) return null;
  try {
    const parsed = JSON.parse(jsonOut) as NativeFoldResult;
    return parsed;
  } catch {
    return null;
  }
}

/** Result of `nativeCommandAvailable`. */
export interface CommandAvailableResult {
  available: boolean;
  /** The resolved program name (e.g. `npm` for `npx X`, `cargo` for `cargo build`). */
  bin: string;
}

/**
 * Fast in-process Rust `which`-style probe. Mirrors `commandAvailable()` in
 * `src/agent/loop.ts` — extracts the leading program name (handles `npx X`
 * and `cd X && Y` shapes) and resolves it against `cwd` + `pathEnv`. Used
 * by the loop to skip optional repo checks (lint/typecheck/build) when
 * the tool isn't installed.
 */
export function nativeCommandAvailable(
  command: string,
  cwd: string,
  pathEnv: string,
): CommandAvailableResult | null {
  initNativeCore();
  if (!ffiAvailable) return null;

  const input = JSON.stringify({ command, cwd, pathEnv });
  let jsonOut: string | null = null;

  if (napiModule && typeof napiModule.commandAvailable === 'function') {
    try {
      const out = napiModule.commandAvailable(input);
      if (typeof out === 'string') jsonOut = out;
    } catch {
      return null;
    }
  }

  if (!jsonOut && bunLib) {
    try {
      const buf = Buffer.alloc(256);
      if (!bunPtr) throw new Error('bun FFI ptr unavailable');
      const ptr = bunPtr;
      const written = bunLib.symbols.mochi_command_available(
        Buffer.from(input + '\0'),
        ptr(buf),
        buf.length,
      );
      if (written < 0) return null;
      let end = buf.indexOf(0);
      if (end < 0) end = Math.min(written, buf.length);
      jsonOut = buf.toString('utf8', 0, end);
    } catch {
      return null;
    }
  }

  if (!jsonOut) return null;
  try {
    const parsed = JSON.parse(jsonOut) as CommandAvailableResult;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Fast in-process Rust ANSI escape stripper. Mirrors the JS regex pass in
 * `src/tui/ansi-hygiene.ts` `stripAnsi()` byte-for-byte (single regex,
 * 256-state DFA, no allocations per match). On hot TUI render paths that
 * call `stripAnsi` once per line, this saves microseconds-per-line.
 */
export function nativeStripAnsi(text: string): string | null {
  initNativeCore();
  if (!ffiAvailable || !text) return text ? null : '';

  if (napiModule && typeof napiModule.stripAnsi === 'function') {
    try {
      const out = napiModule.stripAnsi(text);
      return typeof out === 'string' ? out : null;
    } catch {
      return null;
    }
  }

  if (bunLib) {
    try {
      const cap = Math.max(64, text.length + 32);
      const buf = Buffer.alloc(cap);
      if (!bunPtr) throw new Error('bun FFI ptr unavailable');
      const ptr = bunPtr;
      const written = bunLib.symbols.mochi_strip_ansi(
        Buffer.from(text + '\0'),
        ptr(buf),
        buf.length,
      );
      if (written < 0) return null;
      let end = buf.indexOf(0);
      if (end < 0) end = Math.min(written, buf.length);
      return buf.toString('utf8', 0, end);
    } catch {
      return null;
    }
  }

  return null;
}
