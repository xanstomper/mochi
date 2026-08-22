import { describe, it, expect } from 'vitest';
import {
  nativeFuzzyMatch,
  nativeGitBranch,
  nativeSearchDir,
  nativeStripThinkTags,
  nativeHashPrompt,
  isNativeCoreAvailable,
  nativeCountTokens,
  nativeTruncateToTokens,
} from './core.js';
import { fuzzyFindUnique } from '../tools/fuzzy-match.js';

describe('mochi_core native Rust engine', () => {
  it('reports availability or graceful fallback', () => {
    const avail = isNativeCoreAvailable();
    expect(typeof avail).toBe('boolean');
  });

  it('matches fuzzy needles identical to TypeScript implementation', () => {
    const text = 'function helloWorld() {\n  const x = 1;\n  return x + 2;\n}\n';
    const needle = 'const x = 1;\nreturn x + 2;';
    const tsMatch = fuzzyFindUnique(text, needle);
    expect(tsMatch).not.toBeNull();

    // If running in Bun with FFI active:
    if (isNativeCoreAvailable()) {
      const rustMatch = nativeFuzzyMatch(text, needle);
      expect(rustMatch).toEqual(tsMatch);
    }
  });

  it('finds git branch from filesystem without spawning subprocess', () => {
    const branch = nativeGitBranch(process.cwd());
    if (isNativeCoreAvailable()) {
      expect(branch).toBeTruthy();
    }
  });

  it('searches directory and extracts outline hints', () => {
    if (isNativeCoreAvailable()) {
      const res = nativeSearchDir(process.cwd(), 'createTuiState', '*.ts', 10);
      expect(res).toContain('src/tui/state.ts');
    }
  });

  it('strips reasoning blocks via native Rust sanitizer', () => {
    const raw = '<think>internal reasoning process</think>Final answer for user.';
    if (isNativeCoreAvailable()) {
      const stripped = nativeStripThinkTags(raw);
      expect(stripped).toBe('Final answer for user.');
    }
  });

  it('computes 64-bit prompt hash for KV cache prefix indexing', () => {
    if (isNativeCoreAvailable()) {
      const h1 = nativeHashPrompt('You are a coding assistant.');
      const h2 = nativeHashPrompt('You are a coding assistant.');
      const h3 = nativeHashPrompt('Different prompt prefix.');
      expect(typeof h1).toBe('bigint');
      expect(h1).toEqual(h2);
      expect(h1).not.toEqual(h3);
    }
  });
});

describe('tokenizer bridge (Rust native, parity-checked)', () => {
  it('nativeCountTokens returns sane counts and falls back cleanly', () => {
    const n = nativeCountTokens('hello world foo bar baz qux');
    if (n === null) {
      // Native core absent in this environment: contract is a clean null,
      // never a throw, and approxTokens still works.
      expect(n).toBeNull();
    } else {
      expect(n).toBeGreaterThan(0);
      // Parity: close to the ~4 chars/token heuristic within 3x
      const approx = Math.ceil('hello world foo bar baz qux'.length / 4);
      expect(n).toBeGreaterThan(approx / 3);
      expect(n).toBeLessThan(approx * 3);
    }
  });

  it('nativeTruncateToTokens shortens text and never throws', () => {
    const out = nativeTruncateToTokens('word '.repeat(100), 5);
    if (out !== null) {
      expect(out.length).toBeLessThan('word '.repeat(100).length);
    }
  });
});
