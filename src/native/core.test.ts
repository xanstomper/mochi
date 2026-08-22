import { describe, it, expect } from 'vitest';
import {
  nativeFuzzyMatch,
  nativeGitBranch,
  nativeSearchDir,
  nativeStripThinkTags,
  nativeHashPrompt,
  isNativeCoreAvailable,
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
