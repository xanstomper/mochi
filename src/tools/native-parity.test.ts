import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fuzzyFindUnique } from './fuzzy-match.js';

function runBin(bin: string, needle: string, text: string): string {
  const input = ['NEEDLE', ...needle.split('\n'), '---TEXT---', ...text.split('\n')].join('\n');
  return execFileSync(bin, [], { input, encoding: 'utf8' }).trim();
}

const cases: [string, string][] = [
  ['return x * 2;', 'function greet(name: string): string {\n  return "hi " + name;\n}\n'],
  ['b  c', 'a\na b  c\nd\n'],
  ['not present', 'a\nb\nc\n'],
  ['x', 'x\nx\n'], // ambiguous -> NONE in all implementations
];

function assertParity(bin: string): void {
  for (const [needle, text] of cases) {
    const ts = fuzzyFindUnique(text, needle);
    const out = runBin(bin, needle, text);
    const expectTs = ts ? `OK ${ts.start} ${ts.end}` : 'NONE';
    expect(out.trim()).toBe(expectTs);
  }
}

it('rust matches TS parity', () => assertParity('/home/jewboy420/mochi/native/bin/fuzzy_rust'));
it('cpp matches TS parity', () => assertParity('/home/jewboy420/mochi/native/bin/fuzzy_cpp'));