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

  it('builds tab-management argv (tabs / newtab / switchtab / closetab)', () => {
    expect(buildDriverArgs({ command: 'tabs' })).toEqual(['tabs']);
    expect(buildDriverArgs({ command: 'newtab', url: 'https://example.com/a' }))
      .toEqual(['newtab', 'https://example.com/a']);
    expect(buildDriverArgs({ command: 'newtab' })).toEqual(['newtab', '']);
    // newtab must NOT also emit the generic --url prefix (it would navigate
    // the current tab before the new one opens).
    expect(buildDriverArgs({ command: 'newtab', url: 'https://example.com/a' })).not.toContain('--url');
    // Tab target resolution: explicit target > selector > text.
    expect(buildDriverArgs({ command: 'switchtab', target: '2' })).toEqual(['switchtab', '2']);
    expect(buildDriverArgs({ command: 'switchtab', selector: 'example.com' })).toEqual(['switchtab', 'example.com']);
    expect(buildDriverArgs({ command: 'switchtab', text: '1' })).toEqual(['switchtab', '1']);
    expect(buildDriverArgs({ command: 'closetab' })).toEqual(['closetab', '']);
    expect(buildDriverArgs({ command: 'closetab', target: '0' })).toEqual(['closetab', '0']);
    // Global flags still apply to tab commands.
    expect(buildDriverArgs({ command: 'tabs', profile: '/tmp/p1' })).toEqual(['tabs', '--profile', '/tmp/p1']);
  });

  it('builds download / upload / extract argv', () => {
    expect(buildDriverArgs({ command: 'download', selector: '#dl', path: '/tmp/out.pdf' }))
      .toEqual(['download', '#dl', '/tmp/out.pdf']);
    expect(buildDriverArgs({ command: 'download', selector: '#dl' })).toEqual(['download', '#dl', '']);
    expect(buildDriverArgs({ command: 'download', url: 'https://example.com/files' }))
      .toEqual(['download', '', '', '--url', 'https://example.com/files']);
    expect(buildDriverArgs({ command: 'upload', selector: 'input[type=file]', path: '/tmp/a.png' }))
      .toEqual(['upload', 'input[type=file]', '/tmp/a.png']);
    expect(buildDriverArgs({ command: 'extract', selector: 'article' })).toEqual(['extract', 'article']);
    expect(buildDriverArgs({ command: 'extract' })).toEqual(['extract', '']);
  });

  it('builds robust waitfor targets and the --frame flag', () => {
    expect(buildDriverArgs({ command: 'waitfor', selector: 'networkidle' })).toEqual(['waitfor', 'networkidle']);
    expect(buildDriverArgs({ command: 'waitfor', selector: 'url:/dashboard' })).toEqual(['waitfor', 'url:/dashboard']);
    expect(buildDriverArgs({ command: 'click', selector: '#pay', frame: 'iframe#stripe' }))
      .toEqual(['click', '#pay', '--frame', 'iframe#stripe']);
    expect(buildDriverArgs({ command: 'fill', selector: '#card', text: '4242', url: 'https://example.com/checkout', frame: 'payment-frame' }))
      .toEqual(['fill', '#card', '4242', '--url', 'https://example.com/checkout', '--frame', 'payment-frame']);
  });
});

describe('browser tool summaries for tabs / download / extract', () => {
  it('summarizes the tab list with the active tab marked', () => {
    const out = summarizeResult('tabs', JSON.stringify({
      ok: true,
      tabs: [
        { index: 0, url: 'https://a.example/', title: 'A', active: false },
        { index: 1, url: 'https://b.example/', title: 'B', active: true },
      ],
      active: 1,
    }));
    expect(out).toContain('tabs (2):');
    expect(out).toContain('[0] https://a.example/ — A');
    expect(out).toContain('[1] * https://b.example/ — B');
  });

  it('summarizes a download with filename and size, not the screenshot line', () => {
    const out = summarizeResult('download', JSON.stringify({
      ok: true, action: 'download', saved: '/tmp/dl/report.pdf', filename: 'report.pdf', size: 12345,
    }));
    expect(out).toContain('downloaded: /tmp/dl/report.pdf (12345 bytes, filename=report.pdf)');
    expect(out).not.toContain('saved: /tmp/dl/report.pdf');
  });

  it('summarizes extract text and a structured table', () => {
    const out = summarizeResult('extract', JSON.stringify({
      ok: true, title: 'Prices', url: 'https://example.com/prices',
      extract: '# Prices\nBasic plan costs less.',
      table: { headers: ['Plan', 'Price'], rows: [['Basic', '$5'], ['Pro', '$20']], rowCount: 2 },
    }));
    expect(out).toContain('extract:');
    expect(out).toContain('# Prices');
    expect(out).toContain('table (2 rows): Plan | Price');
    expect(out).toContain('Basic | $5');
    expect(out).toContain('Pro | $20');
  });

  it('caps the displayed table rows at 20 but reports the true row count', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`r${i}`, 'x']);
    const out = summarizeResult('extract', JSON.stringify({
      ok: true, extract: 'body', table: { headers: ['A', 'B'], rows, rowCount: 137 },
    }));
    expect(out).toContain('table (137 rows)');
    expect(out).toContain('r19');
    expect(out).not.toContain('r20');
  });
});