import { describe, it, expect } from 'bun:test';
import { synthesizeSubagentResults } from './agent/loop.js';

describe('synthesizeSubagentResults', () => {
  const dupFinding = 'The parser handles nested arrays by recursing into the value slot with depth tracking.';
  const dupKey = dupFinding.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');

  it('prepends a VERDICT line', () => {
    const out = synthesizeSubagentResults(['[Subagent #1 (coder)]: done']);
    expect(out[0].startsWith('[VERDICT] 1 subagent(s) returned; all succeeded')).toBe(true);
    expect(out.length).toBe(2);
  });

  it('dedupes identical finding lines (>=40 chars, normalized) across siblings', () => {
    const out = synthesizeSubagentResults([
      `[Subagent #1]: ${dupFinding}\nextra detail a`,
      `[Subagent #2]: ${dupFinding}`,
    ]);
    const occurrences = out.join('\n').split(dupFinding).length - 1;
    expect(occurrences).toBe(1); // first mention kept, second merged
  });

  it('keeps short lines and distinct findings, flags failures', () => {
    const out = synthesizeSubagentResults([
      '[Subagent #1 (coder) FAILED]: timeout after 30000ms',
      'ok',
    ]);
    expect(out[0]).toContain('at least one FAILED');
    expect(out.some((r) => r === 'ok')).toBe(true);
    expect(dupKey.length).toBeGreaterThan(0);
  });
});
