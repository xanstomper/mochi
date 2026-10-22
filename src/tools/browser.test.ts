// Browser automation tool: driver path resolution + result summarization.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { buildDriverArgs, consoleErrorLines, driverScript, summarizeResult } from './browser.js';

describe('browser tool driver', () => {
  it('resolves a real, existing driver script path', () => {
    // The driver is a plain-node script (no import of playwright) so the tool
    // can shell out to it without adding a runtime dep to the Bun binary.
    const DRIVER = driverScript();
    // Normalize separators first: driverScript() returns a native path, and
    // on win32 it contains backslashes that never match a forward-slash tail.
    expect(DRIVER.replaceAll('\\', '/').endsWith('scripts/browser-driver.mjs')).toBe(true);
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

  it('surfaces console errors as a compact section when present', () => {
    const out = summarizeResult('navigate', JSON.stringify({
      ok: true, title: 'App', url: 'http://localhost:3000/',
      text: 'hello',
      consoleErrors: [
        { type: 'error', text: 'Failed to load resource: 404' },
        { type: 'warning', text: 'Deprecated API' },
        { type: 'pageerror', text: 'ReferenceError: foo is not defined' },
      ],
    }));
    expect(out).toContain('[browser navigate] ok');
    expect(out).toContain('console errors (3):');
    expect(out).toContain('[error] Failed to load resource: 404');
    expect(out).toContain('[warning] Deprecated API');
    expect(out).toContain('[pageerror] ReferenceError: foo is not defined');
  });

  it('omits the console-errors section when there are none', () => {
    const out = summarizeResult('navigate', JSON.stringify({ ok: true, title: 'Clean', text: 'ok' }));
    expect(out).not.toContain('console errors');
    expect(consoleErrorLines({})).toEqual([]);
    expect(consoleErrorLines({ consoleErrors: [] })).toEqual([]);
  });

  it('appends console errors to driver error results too', () => {
    const out = summarizeResult('click', JSON.stringify({
      ok: false, error: 'click: timeout',
      consoleErrors: [{ type: 'error', text: 'Uncaught TypeError' }],
    }));
    expect(out).toContain('[browser click] ERROR');
    expect(out).toContain('console errors (1):');
    expect(out).toContain('Uncaught TypeError');
  });

  it('caps/truncates long console error text in the summary', () => {
    const long = 'x'.repeat(1000);
    const lines = consoleErrorLines({ consoleErrors: [{ type: 'error', text: long }] });
    expect(lines).toHaveLength(2);
    expect(lines[1].length).toBeLessThan(400);
  });
});

describe('browser tool driver args (pure, no browser launch)', () => {
  it('builds navigate / press / select / hover / waitfor argv', () => {
    expect(buildDriverArgs({ command: 'navigate', url: 'https://example.com/' }))
      .toEqual(['navigate', 'https://example.com/']);
    expect(buildDriverArgs({ command: 'press', key: 'Enter' })).toEqual(['press', 'Enter']);
    // press fallbacks: text, then selector
    expect(buildDriverArgs({ command: 'press', text: 'Escape' })).toEqual(['press', 'Escape']);
    expect(buildDriverArgs({ command: 'press', selector: 'Tab' })).toEqual(['press', 'Tab']);
    expect(buildDriverArgs({ command: 'select', selector: '#country', value: 'US' }))
      .toEqual(['select', '#country', 'US']);
    expect(buildDriverArgs({ command: 'select', selector: '#country', text: 'CA' }))
      .toEqual(['select', '#country', 'CA']);
    expect(buildDriverArgs({ command: 'hover', selector: '.menu' })).toEqual(['hover', '.menu']);
    expect(buildDriverArgs({ command: 'waitfor', selector: '#ready' })).toEqual(['waitfor', '#ready']);
  });

  it('builds scroll argv for a selector, a pixel amount, and no arg', () => {
    expect(buildDriverArgs({ command: 'scroll', selector: '#footer' })).toEqual(['scroll', '#footer']);
    expect(buildDriverArgs({ command: 'scroll', selector: '600' })).toEqual(['scroll', '600']);
    expect(buildDriverArgs({ command: 'scroll' })).toEqual(['scroll', '']);
  });

  it('keeps --url prefix, wait/timeout flags, and --profile plumbing', () => {
    expect(buildDriverArgs({ command: 'click', selector: '#go', url: 'https://example.com/', waitMs: 250 }))
      .toEqual(['click', '#go', '--url', 'https://example.com/', '--wait', '250']);
    expect(buildDriverArgs({ command: 'press', key: 'Enter', url: 'https://example.com/form', profile: '/tmp/p1' }))
      .toEqual(['press', 'Enter', '--url', 'https://example.com/form', '--profile', '/tmp/p1']);
    // The driver's own default (30000) is not passed; a supplied one is.
    // (execute() always supplies one — 45000 by default — so real calls
    // forward --timeout exactly as before this refactor.)
    expect(buildDriverArgs({ command: 'waitfor', selector: '#x', timeoutMs: 5000 }))
      .toEqual(['waitfor', '#x', '--timeout', '5000']);
    expect(buildDriverArgs({ command: 'waitfor', selector: '#x', timeoutMs: 45000 }))
      .toEqual(['waitfor', '#x', '--timeout', '45000']);
    expect(buildDriverArgs({ command: 'waitfor', selector: '#x', timeoutMs: 30000 }))
      .toEqual(['waitfor', '#x']);
    expect(buildDriverArgs({ command: 'waitfor', selector: '#x' })).toEqual(['waitfor', '#x']);
  });

  it('preserves existing argv shapes for old commands', () => {
    expect(buildDriverArgs({ command: 'type', selector: '#q', text: 'hi' })).toEqual(['type', '#q', 'hi']);
    expect(buildDriverArgs({ command: 'fill', selector: '#q', text: 'hi' })).toEqual(['fill', '#q', 'hi']);
    expect(buildDriverArgs({ command: 'eval', js: '1+1' })).toEqual(['eval', '1+1']);
    expect(buildDriverArgs({ command: 'screenshot', path: '/tmp/a.png' })).toEqual(['screenshot', '/tmp/a.png']);
    expect(buildDriverArgs({ command: 'text', selector: 'main' })).toEqual(['text', 'main']);
  });
});