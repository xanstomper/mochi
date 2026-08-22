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

let napiModule: any = null;
let bunLib: any = null;
let ffiAvailable = false;
let probed = false;

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
  if (sharedLib && typeof (globalThis as any).Bun !== 'undefined') {
    try {
      const { dlopen, FFIType } = (globalThis as any).Bun;
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
      });
      if (bunLib) {
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
      const { ptr } = (globalThis as any).Bun;
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
      const { ptr } = (globalThis as any).Bun;
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
      const { ptr } = (globalThis as any).Bun;
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
      const { ptr } = (globalThis as any).Bun;
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
      const { ptr } = (globalThis as any).Bun;
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
      const { ptr } = (globalThis as any).Bun;
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
