// Stream degeneracy detector: guards against models that loop verbatim
// mid-stream (observed live: one request emitted the same reasoning block
// 115x / 3508 events in ~60s). Detection must be aggressive on CONSECUTIVE
// verbatim loops and inert on legitimate near-repeats.
import { describe, expect, it } from 'vitest';
import { DegenerationDetector } from './stream-degen.js';

const LOOP_SENTENCE = 'The verifier checks deep/leaf.txt which does not exist on disk, hence the artifact is reported MISSING.';
const OTHER = 'Meanwhile the manifest records the flattened path instead of the nested one.';
const filler = (i: number) => `Step ${i}: inspect tree node number ${i} and compare its checksum with the expected value from the manifest.`;

function feedAll(d: DegenerationDetector, text: string): boolean {
  let hit = false;
  // Feed in small deltas like a real stream would.
  for (let i = 0; i < text.length; i += 7) hit = d.feed(text.slice(i, i + 7)) || hit;
  return hit || d.feed(undefined) as unknown as boolean; // trailing call must not throw
}

describe('DegenerationDetector', () => {
  it('detects a verbatim reasoning loop (consecutive identical long sentences)', () => {
    const d = new DegenerationDetector();
    const spam = Array.from({ length: 10 }, () => LOOP_SENTENCE).join(' ');
    const before = d.live().duplicatedChars;
    expect(feedAll(d, spam)).toBe(true);
    expect(d.abortFlagged()).toBe(true);
    expect(d.live().spanChars).toBeGreaterThan(0);
  });

  it('stays quiet on legitimate varied output even when sentences recur later', () => {
    const d = new DegenerationDetector();
    // The same recurring import line separated by other sentences must NOT trip:
    let text = '';
    for (let i = 0; i < 30; i++) {
      text += "import { describe, expect, it } from 'vitest';\n" + filler(i) + '\n';
    }
    expect(feedAll(d, text)).toBe(false);
    expect(d.abortFlagged()).toBe(false);
  });

  it('stays quiet when short stamp CONTENT VARIES (tables/counters)', () => {
    const d = new DegenerationDetector();
    let text = '';
    for (let i = 0; i < 80; i++) text += `row ${i} -> value ${(i * 37) % 977}, checksum ${i * 13}\n`;
    expect(feedAll(d, text)).toBe(false);
  });

  it('does not fire below the duplicated-character floor', () => {
    const d = new DegenerationDetector();
    const text = Array.from({ length: 5 }, () => LOOP_SENTENCE).join(' '); // streak hit but tiny volume
    expect(feedAll(d, text)).toBe(false);
  });

  it('also catches ALTERNATING two-sentence loops (A B A B …)', () => {
    // Oscillating between two blocks is exactly as user-hostile as single-
    // sentence spam: same flood, same token burn. Expect an abort.
    const d = new DegenerationDetector();
    let text = '';
    for (let k = 0; k < 12; k++) text += LOOP_SENTENCE + '\n' + OTHER + '\n';
    expect(feedAll(d, text)).toBe(true);
  });

  it('survives huge boundary-free dumps without throwing', () => {
    const d = new DegenerationDetector();
    const dump = 'x'.repeat(40_000);
    expect(() => d.feed(dump)).not.toThrow();
  });

  it('treats whitespace/ANSI-only variants as identical bytes', () => {
    const d = new DegenerationDetector();
    const styled = '\x1b[38;5;245m' + LOOP_SENTENCE.replace(/ /g, '\u00a0') + '\x1b[0m';
    const spam = Array.from({ length: 10 }, () => styled).join('\n');
    expect(feedAll(d, spam)).toBe(true);
  });
});
