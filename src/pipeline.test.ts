import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { parseFindings, findingsToNdjson, renderFindings, countBySeverity, readStdin } from './pipeline.js';

function streamFrom(text: string): Readable {
  const s = new Readable();
  s._read = () => {};
  s.push(text);
  s.push(null);
  return s;
}

describe('parseFindings', () => {
  it('extracts [SEVERITY] file:line messages', () => {
    const out = parseFindings(
      [
        '[HIGH] src/auth.ts:42 SQL injection in query builder',
        '[MEDIUM] src/util.ts — hardcoded secret fallback',
        '[LOW] README.md:3 typo in title',
        '[INFO] docs/api.md Missing request example',
        'plain line with no marker is skipped',
      ].join('\n'),
    );
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ severity: 'HIGH', file: 'src/auth.ts', line: 42, message: 'SQL injection in query builder' });
    expect(out[1]).toMatchObject({ severity: 'MEDIUM', file: 'src/util.ts' });
    expect(out[2]).toMatchObject({ severity: 'LOW', file: 'README.md', line: 3 });
  });

  it('handles file-only and no-location findings', () => {
    const out = parseFindings('[HIGH] src/leak.cs Hardcoded API key\n[MEDIUM] b:7\n[LOW] README.md typo');
    expect(out[0]).toMatchObject({ severity: 'HIGH', file: 'src/leak.cs', message: 'Hardcoded API key' });
    expect(out[1]?.severity).toBe('MEDIUM');
    expect(out[2]?.file).toBe('README.md');
  });

  it('returns empty for unrelated text', () => {
    expect(parseFindings('nothing here\nall good')).toEqual([]);
  });
});

describe('renderers', () => {
  it('counts by severity', () => {
    const counts = countBySeverity([
      { severity: 'HIGH', file: 'a', message: 'x' },
      { severity: 'HIGH', file: 'b', message: 'y' },
      { severity: 'LOW', file: 'c', message: 'z' },
    ]);
    expect(counts).toEqual({ HIGH: 2, MEDIUM: 0, LOW: 1, INFO: 0 });
  });

  it('human table includes location', () => {
    const text = renderFindings([{ severity: 'MEDIUM', file: 'src/a.ts', line: 7, message: 'nit' }]);
    expect(text).toContain('[MEDIUM] src/a.ts:7 — nit');
  });
});

describe('readStdin', () => {
  it('reads piped content', async () => {
    expect(await readStdin(streamFrom('hello\nworld'))).toBe('hello\nworld');
  });

  it('returns empty for a TTY-like stream', async () => {
    const tty = { isTTY: true } as unknown as NodeJS.ReadableStream;
    expect(await readStdin(tty)).toBe('');
  });
});