// Mochi Native Core FFI Bridge (Rust <-> Node/Bun)
// Zero-copy in-process acceleration for fuzzy matching, git status, and search.

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NativeFuzzyResult {
  start: number;
  end: number;
}

let nativeLib: any = null;
let ffiAvailable = false;
let probed = false;

function findNativeLibPath(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '..', '..', 'native', 'mochi_core', 'target', 'release', 'libmochi_core.so'),
      resolve(here, '..', '..', 'native', 'mochi_core', 'target', 'release', 'libmochi_core.dylib'),
      resolve(here, '..', '..', 'native', 'mochi_core', 'target', 'release', 'mochi_core.dll'),
      resolve(here, '..', '..', 'native', 'bin', 'libmochi_core.so'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

function initNativeCore() {
  if (probed) return;
  probed = true;
  const libPath = findNativeLibPath();
  if (!libPath) return;

  try {
    // Check if running under Bun with native bun:ffi
    if (typeof (globalThis as any).Bun !== 'undefined') {
      const { dlopen, FFIType, CString, ptr } = (globalThis as any).Bun;
      nativeLib = dlopen(libPath, {
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
      });
      ffiAvailable = Boolean(nativeLib);
    }
  } catch {
    ffiAvailable = false;
  }
}

/**
 * Fast in-process Rust fuzzy matcher. Returns unique match bounds or null.
 */
export function nativeFuzzyMatch(text: string, needle: string): NativeFuzzyResult | null {
  initNativeCore();
  if (!ffiAvailable || !nativeLib) return null;

  try {
    const startBuf = new BigUint64Array(1);
    const endBuf = new BigUint64Array(1);
    const { ptr } = (globalThis as any).Bun;
    const res = nativeLib.symbols.mochi_fuzzy_match(
      Buffer.from(text + '\0'),
      Buffer.from(needle + '\0'),
      ptr(startBuf),
      ptr(endBuf),
    );
    if (res === 1) {
      return { start: Number(startBuf[0]), end: Number(endBuf[0]) };
    }
  } catch {}
  return null;
}

/**
 * Fast in-process Rust git branch discovery (<0.1ms).
 */
export function nativeGitBranch(dir: string): string | null {
  initNativeCore();
  if (!ffiAvailable || !nativeLib) return null;

  try {
    const buf = Buffer.alloc(256);
    const { ptr } = (globalThis as any).Bun;
    const len = nativeLib.symbols.mochi_git_branch(
      Buffer.from(dir + '\0'),
      ptr(buf),
      buf.length,
    );
    if (len > 0) {
      return buf.toString('utf8', 0, len);
    }
  } catch {}
  return null;
}

/**
 * Fast in-process Rust directory search.
 */
export function nativeSearchDir(dir: string, query: string, glob = '', limit = 60): string | null {
  initNativeCore();
  if (!ffiAvailable || !nativeLib) return null;

  try {
    const buf = Buffer.alloc(256_000);
    const { ptr } = (globalThis as any).Bun;
    const len = nativeLib.symbols.mochi_search(
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
  return null;
}

/**
 * Fast in-process Rust reasoning / think-tag sanitizer.
 */
export function nativeStripThinkTags(text: string): string | null {
  initNativeCore();
  if (!ffiAvailable || !nativeLib) return null;

  try {
    const buf = Buffer.alloc(Math.max(4096, text.length + 128));
    const { ptr } = (globalThis as any).Bun;
    const len = nativeLib.symbols.mochi_strip_think_tags(
      Buffer.from(text + '\0'),
      ptr(buf),
      buf.length,
    );
    if (len >= 0) {
      return buf.toString('utf8', 0, len);
    }
  } catch {}
  return null;
}

/**
 * Fast in-process 64-bit FNV-1a hash of prompt bytes for KV cache prefix indexing.
 */
export function nativeHashPrompt(text: string): bigint | null {
  initNativeCore();
  if (!ffiAvailable || !nativeLib) return null;

  try {
    const buf = Buffer.from(text, 'utf8');
    const { ptr } = (globalThis as any).Bun;
    const h = nativeLib.symbols.mochi_hash_prompt(ptr(buf), buf.length);
    return BigInt(h);
  } catch {}
  return null;
}

export function isNativeCoreAvailable(): boolean {
  initNativeCore();
  return ffiAvailable;
}
