// Browser automation tool: driver path resolution + result summarization.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { driverScript, summarizeResult, summarizeData, parseCommand } from './browser.js';
import { daemonScript } from '../browser/session.js';

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
    expect(out).toContain('page: Example Domain');
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
describe('browser tool v2', () => {
  it('resolves the persistent daemon script', () => {
    const d = daemonScript();
    expect(d.replaceAll('\\', '/').endsWith('scripts/browser-daemon.mjs')).toBe(true);
    expect(existsSync(d)).toBe(true);
  });

  it('parses the shorthand command syntax', () => {
    expect(parseCommand('navigate https://example.com/a b')).toEqual({ command: 'navigate', rest: 'https://example.com/a b' });
    expect(parseCommand('  SNAPSHOT  ')).toEqual({ command: 'snapshot', rest: '' });
    expect(parseCommand('')).toEqual({ command: '', rest: '' });
  });

  it('summarizes ref-based snapshots compactly', () => {
    const out = summarizeData('snapshot', {
      ok: true, title: 'Example', url: 'https://example.com',
      elements: [
        { ref: 'e1', role: 'link', name: 'More information', href: 'https://iana.org' },
        { ref: 'e2', role: 'textbox', name: 'Search', value: 'mochi' },
      ],
      backendUsed: 'live',
    });
    expect(out).toContain('[browser snapshot] ok');
    expect(out).toContain('e1 link "More information" -> https://iana.org');
    expect(out).toContain('value="mochi"');
    expect(out).toContain('backend: live');
  });

  it('summarizes tab lists with the active marker', () => {
    const out = summarizeData('tabs', {
      ok: true,
      tabs: [
        { index: 0, active: false, title: 'Inbox', url: 'https://mail.google.com' },
        { index: 1, active: true, title: 'Doc', url: 'https://docs.google.com/document/d/1' },
      ],
    });
    expect(out).toContain('tabs (2)');
    expect(out).toContain('*1  Doc');
  });

  it('reports structured errors with [browser <cmd>] prefix', () => {
    expect(summarizeData('click', { ok: false, error: 'no element for ref e9' }))
      .toBe('[browser click] ERROR: no element for ref e9');
  });
});
