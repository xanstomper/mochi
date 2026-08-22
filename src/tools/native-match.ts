// Native fuzzy matcher dispatch. Mochi ships a dependency-free Rust and C
// implementation of the edit tool's fuzzy line matcher (native/rust/fuzzy.rs,
// native/cpp/fuzzy.cpp) built by `npm run build:native`. Calling out to native
// code removes the JS loop from the hottest path in the agent (edit retried by
// token round-trips). When no binary is present (fresh clone without build,
// unsupported platform), we transparently fall back to the TypeScript matcher —
// same contract, same result.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuzzyFindUnique, type FuzzyMatch } from './fuzzy-match.js';
import { nativeFuzzyMatch } from '../native/core.js';

function nativeBin(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = resolve(here, '..', '..', 'native', 'bin');
  for (const name of ['fuzzy_rust', 'fuzzy_cpp']) {
    const p = resolve(dir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Find the unique region in `text` matching `needle`, preferring the in-process
 * Rust FFI matcher, then native binary, and falling back to the TypeScript matcher.
 */
export function fuzzyFindUniqueNative(text: string, needle: string): FuzzyMatch | null {
  const inMemory = nativeFuzzyMatch(text, needle);
  if (inMemory) return inMemory;
  const bin = nativeBin();
  if (!bin) return fuzzyFindUnique(text, needle);
  try {
    const input = ['NEEDLE', ...needle.split('\n'), '---TEXT---', ...text.split('\n')].join('\n');
    const out = execFileSync(bin, [], { input, encoding: 'utf8', timeout: 5000 }).trim();
    const m = /^OK\s+(\d+)\s+(\d+)$/.exec(out);
    if (m) return { start: Number(m[1]), end: Number(m[2]) };
    if (/^NONE$/.test(out)) return null;
    return fuzzyFindUnique(text, needle); // unexpected output: be safe, use TS
  } catch {
    return fuzzyFindUnique(text, needle);
  }
}