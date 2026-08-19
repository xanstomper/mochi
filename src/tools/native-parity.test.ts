// Differential parity tests: the native Rust and C++ fuzzy matchers must
// return EXACTLY the same (start,end) as the TypeScript implementation across
// both hand-picked edge cases and thousands of randomized inputs.
//
// The binaries are built by `npm run build:native` and are NOT committed (see
// .gitignore). Both describe blocks self-skip when the corresponding binary is
// absent, so this file is safe on CI/fresh clones.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fuzzyFindUnique } from './fuzzy-match.js';

const here = dirname(fileURLToPath(import.meta.url));
const binDir = resolve(here, '..', '..', 'native', 'bin');

function runBin(bin: string, needle: string, text: string): string {
  const input = ['NEEDLE', ...needle.split('\n'), '---TEXT---', ...text.split('\n')].join('\n');
  return execFileSync(bin, [], { input, encoding: 'utf8' }).trim();
}

function tsAnswer(needle: string, text: string): string {
  const m = fuzzyFindUnique(text, needle);
  return m ? `OK ${m.start} ${m.end}` : 'NONE';
}

const cases: [string, string][] = [
  ['return x * 2;', 'function greet(name: string): string {\n  return "hi " + name;\n}\n'],
  ['b  c', 'a\na b  c\nd\n'],
  ['not present', 'a\nb\nc\n'],
  ['x', 'x\nx\n'], // ambiguous -> NONE in all implementations
  ['', 'anything here'],
  ['  padded  ', '  padded  '],
  ['a\r\nb', 'a\r\nb\r\nc\r\n'],
];

// A tiny deterministic PRNG so the fuzz corpus is reproducible.
let seed = 42;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function randText(): string {
  const words = ['foo', 'bar', 'baz', 'x', 'return', 'hello', 'if', '  ', 'func', 'name', '123', 'a+'];
  const n = 1 + Math.floor(rand() * 10);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    let line = '';
    const wc = 1 + Math.floor(rand() * 4);
    for (let j = 0; j < wc; j++) line += words[Math.floor(rand() * words.length)] + ' ';
    lines.push(line.trim());
  }
  return lines.join('\n');
}

function fuzz(bin: string): void {
  for (let i = 0; i < 400; i++) {
    const text = rand() < 0.7 ? randText() : (cases[Math.floor(rand() * cases.length)][1] ?? '');
    const needle = rand() < 0.6 ? randText() : (cases[Math.floor(rand() * cases.length)][0] ?? '');
    const got = runBin(bin, needle, text);
    const want = tsAnswer(needle, text);
    if (got !== want) {
      throw new Error(`MISMATCH needle=${JSON.stringify(needle)} text=${JSON.stringify(text)}\n  ts: ${want}\n  ${bin}: ${got}`);
    }
  }
}

describe('native fuzzy parity', () => {
  const rustBin = resolve(binDir, 'fuzzy_rust');
  const cppBin = resolve(binDir, 'fuzzy_cpp');
  const rustOk = existsSync(rustBin);
  const cppOk = existsSync(cppBin);

  (rustOk ? describe : describe.skip)('rust', () => {
    it('matches TS on curated cases', () => {
      for (const [needle, text] of cases) expect(runBin(rustBin, needle, text)).toBe(tsAnswer(needle, text));
    });
    it('matches TS on 400 random cases', () => fuzz(rustBin));
  });

  (cppOk ? describe : describe.skip)('cpp', () => {
    it('matches TS on curated cases', () => {
      for (const [needle, text] of cases) expect(runBin(cppBin, needle, text)).toBe(tsAnswer(needle, text));
    });
    it('matches TS on 400 random cases', () => fuzz(cppBin));
  });
});