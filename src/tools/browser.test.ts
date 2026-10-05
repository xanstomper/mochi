// Browser automation tool: driver path resolution + result summarization.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { DRIVER, summarizeResult } from './browser.js';

describe('browser tool driver', () => {
  it('resolves a real, existing driver script path', () => {
    // The driver is a plain-node script (no import of playwright) so the tool
    // can shell out to it without adding a runtime dep to the Bun binary.
    expect(DRIVER.endsWith('scripts/browser-driver.mjs')).toBe(true);
    expect(existsSync(DRIVER)).toBe(true);
  });

  it('summarizes a successful navigate result compactly', () => {
    const out = summarizeResult('get', JSON.stringify({
      ok: true, title: 'Example Domain', url: 'https://example.com/',
      text: 'This is a test.', inputs: [{ sel: 'input#q', tag: 'input', name: 'q', type: 'text', val: 'hi' }],
    }));
    expect(out).toContain('[browser get] ok');
    expect(out).toContain('title: Example Domain');
    expect(out).toContain('inputs (1):');
    expect(out).toContain('input#q');
  });

  it('reports driver errors instead of crashing', () => {
    const out = summarizeResult('click', JSON.stringify({ ok: false, error: 'selector not found' }));
    expect(out).toContain('[browser click] ERROR');
    expect(out).toContain('selector not found');
  });

  it('passes through non-JSON output safely', () => {
    const out = summarizeResult('screenshot', 'raw driver noise');
    expect(out).toContain('raw driver noise');
  });

  it('handles empty/timed-out output', () => {
    expect(summarizeResult('eval', '')).toContain('no output');
  });
});