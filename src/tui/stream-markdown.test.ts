// Wave S3 — streaming markdown renderer tests.
//
// The stream renderer (createStreamMarkdownRenderer) is a CACHE over
// renderMarkdown, not a fork: for any append-only stream of a well-formed
// document it must produce byte-identical rows to the plain renderer at
// every line-boundary prefix, at several widths, across resizes, and after
// non-append replacements. Where the stream is mid-construct (unclosed
// bold / code span / link) it intentionally differs: the virtual closure
// hides the raw syntax the plain renderer leaks. Those cases are pinned
// individually below, including what the plain renderer used to show.

import { describe, it, expect } from 'vitest';
import {
  R,
  renderMarkdown,
  createStreamMarkdownRenderer,
  visibleLen,
  stripAnsi,
} from './view.js';
import { describeToolOutcome, summarizeJsonBlob } from './cards.js';

const WIDTHS = [40, 80, 120];

/** All prefixes of `doc` that end exactly at a line boundary. */
function lineBoundaryPrefixes(doc: string): string[] {
  const out: string[] = [];
  let idx = 0;
  while (idx < doc.length) {
    const nl = doc.indexOf('\n', idx);
    if (nl === -1) break;
    out.push(doc.slice(0, nl + 1));
    idx = nl + 1;
  }
  out.push(doc);
  return out;
}

// Corpus documents. Inline constructs never span source lines, so at any
// line-boundary prefix the virtual closure is a no-op and stream output
// must equal plain output EXACTLY.
const DOC_CODE = [
  '## Implementation notes',
  '',
  'The parser is a **single pass** over the input with `O(n)` memory.',
  '',
  '```ts',
  'export function seal(text: string, from: number): number {',
  '  // Only blank lines outside fences can seal.',
  '  return findSealEnd(text, from);',
  '}',
  '```',
  '',
  '```python',
  '# Walrus included on purpose',
  'def replay(frames, width=100):',
  '    total = 0.0',
  '    for frame in frames:',
  '        if (n := len(frame.rows)) > 0:',
  '            total += n * 0.016  # frame budget',
  '    return {"frames": len(frames), "ok": True}',
  '```',
  '',
  'Done — see [the journal](https://example.com/journal) for the trace.',
].join('\n');

const DOC_TABLE = [
  '### Measurements by subsystem',
  '',
  '| Subsystem | Before (ms) | After (ms) | Δ vs budget | Notes |',
  '|---|---:|---:|---:|---|',
  '| markdown parse | 51.5 | 0.4 | -51.1 | sealed prefix cache |',
  '| table layout | 12.0 | 0.1 | -11.9 | sticky column widths |',
  '| code highlight | 3.3 | 0.2 | -3.1 | language profiles |',
  '| row diff write | 0.9 | 0.9 | 0.0 | unchanged |',
  '',
  'The wide columns stay put while rows arrive.',
].join('\n');

const DOC_LISTS = [
  '## Rollout checklist',
  '',
  '1. Land the stream renderer behind the existing wrap cache so the transcript keeps one code path',
  '2. Replay the fixture and compare the frame curves at three widths',
  '3. Golden-test the corpus at widths 40 / 80 / 120',
  '4. Ship it',
  '',
  '- The render loop re-parses the **entire** accumulated message on every frame',
  '- Column widths in tables are recomputed from scratch as rows arrive',
  '  - Nested point: `renderTable` has no memory of the previous frame',
  '  - So columns visibly *jitter* while a table streams in',
  '- Unclosed inline constructs leak raw markdown until they close',
  '',
  '> The renderer is WIDTH-AWARE now: it wraps at the exact transcript',
  '> width and emits hanging-indented final rows.',
].join('\n');

const DOC_UNICODE = [
  '## Unicode & long lines',
  '',
  'Emoji ✅ and CJK 漢字 and accents café all share the same rows.',
  '',
  'Anunbrokenlineoftextthatrefusestowraporbreakatanynaturalboundaryandkeepsgoingwellpastthewidth',
  '',
  '- ✅ done item with a trailing note',
  '- 🚧 in-progress item',
].join('\n');

// DOC_TABLE is deliberately NOT in the strict corpus: mid-stream its
// column allocation is sticky by design (see the table describe below),
// so per-prefix rows differ from a from-scratch render until it seals.
const CORPUS: [string, string][] = [
  ['code-heavy', DOC_CODE],
  ['nested lists', DOC_LISTS],
  ['unicode', DOC_UNICODE],
];

// Per-doc widths for the row-width invariant. Code-fence lines are not
// wrapped by design (the terminal clips them; autowrap is off), so the
// code doc is only checked at widths above its longest line (60 cols).
const INVARIANT_WIDTHS: Record<string, number[]> = {
  'code-heavy': [64, 80, 120],
  'nested lists': [26, 40, 60, 80, 120],
  unicode: [26, 40, 60, 80, 120],
};

describe('stream renderer equivalence (sealing is a cache, not a fork)', () => {
  for (const [name, doc] of CORPUS) {
    for (const width of WIDTHS) {
      it(`${name} @ width ${width}: identical rows at every line-boundary prefix`, () => {
        const stream = createStreamMarkdownRenderer();
        for (const prefix of lineBoundaryPrefixes(doc)) {
          expect(stream.render(prefix, width)).toEqual(renderMarkdown(prefix, width));
        }
        // Sealing actually engaged (otherwise the test proves nothing).
        expect(stream.stats().sealedChars).toBeGreaterThan(doc.length / 2);
        expect(stream.stats().segmentRenders).toBeGreaterThan(1);
      });
    }
  }

  it('survives a mid-stream resize sequence (rows equal fresh renders at each width)', () => {
    const stream = createStreamMarkdownRenderer();
    const half = DOC_LISTS.slice(0, DOC_LISTS.indexOf('\n- Unclosed'));
    expect(stream.render(half, 100)).toEqual(renderMarkdown(half, 100));
    expect(stream.render(half, 60)).toEqual(renderMarkdown(half, 60));
    expect(stream.render(DOC_LISTS, 60)).toEqual(renderMarkdown(DOC_LISTS, 60));
    expect(stream.render(DOC_LISTS, 120)).toEqual(renderMarkdown(DOC_LISTS, 120));
    expect(stream.stats().resets).toBeGreaterThanOrEqual(3);
  });

  it('falls back to a full render on a non-append replacement (provider re-send)', () => {
    const stream = createStreamMarkdownRenderer();
    stream.render(DOC_CODE, 80);
    const other = '## Different message\n\nNothing appended here at all.';
    expect(stream.render(other, 80)).toEqual(renderMarkdown(other, 80));
  });

  it('every rendered row fits the width at every prefix (width-harness invariant)', () => {
    for (const [name, doc] of CORPUS) {
      for (const width of INVARIANT_WIDTHS[name]) {
        const stream = createStreamMarkdownRenderer();
        for (const prefix of lineBoundaryPrefixes(doc)) {
          for (const row of stream.render(prefix, width)) {
            expect(visibleLen(row)).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });
});

describe('virtual closure: no raw markdown leaks mid-stream', () => {
  const vis = (rows: string[]) => stripAnsi(rows.join('\n'));

  it('unclosed bold renders as bold text, not literal **', () => {
    const stream = createStreamMarkdownRenderer();
    expect(vis(stream.render('Status: **impor', 80))).toBe('Status: impor');
    // The plain renderer (pre-S3 behavior at every mid-stream frame):
    expect(vis(renderMarkdown('Status: **impor', 80))).toContain('**impor');
    // When the closer arrives, stream and plain agree again.
    expect(stream.render('Status: **important** fix', 80))
      .toEqual(renderMarkdown('Status: **important** fix', 80));
  });

  it('unclosed inline code renders as code text, not a literal backtick', () => {
    const stream = createStreamMarkdownRenderer();
    expect(vis(stream.render('Run `npm te', 80))).toBe('Run npm te');
    expect(vis(renderMarkdown('Run `npm te', 80))).toContain('`npm te');
  });

  it('a half-typed link collapses to its label', () => {
    const stream = createStreamMarkdownRenderer();
    expect(vis(stream.render('See [the gui', 80))).toBe('See the gui');
    expect(vis(stream.render('See [the guide](https://exa', 80))).toBe('See the guide');
    expect(vis(renderMarkdown('See [the guide](https://exa', 80))).toContain('[the guide](');
    expect(stream.render('See [the guide](https://example.com) now', 80))
      .toEqual(renderMarkdown('See [the guide](https://example.com) now', 80));
  });

  it('an unclosed code fence renders its pill + highlighted lines sanely', () => {
    const stream = createStreamMarkdownRenderer();
    const out = vis(stream.render('```ts\nconst x = 1;', 80));
    expect(out).toContain('ts');
    expect(out).toContain('const x = 1;');
    expect(out).not.toContain('```');
  });

  it('does not close constructs that are already balanced', () => {
    const stream = createStreamMarkdownRenderer();
    const doc = 'A **bold** claim and `code` and [a link](https://x.co) walk in.';
    expect(stream.render(doc, 80)).toEqual(renderMarkdown(doc, 80));
  });
});

describe('streaming table column stability', () => {
  // The contract: from-scratch renders REDISTRIBUTE column widths as rows
  // arrive (computeColumnWidths shrinks some columns to grow others), so
  // the whole box jitters sideways mid-stream. The stream renderer floors
  // each column at the previous frame's width instead: same row count at
  // every prefix, box width never shrinks, and once the table's block
  // seals the rows are byte-identical to the plain renderer.
  it('box width never shrinks while rows arrive, and ends equal to plain', () => {
    const stream = createStreamMarkdownRenderer();
    let lastBox = 0;
    for (const prefix of lineBoundaryPrefixes(DOC_TABLE)) {
      const rows = stream.render(prefix, 80);
      expect(rows.length).toBe(renderMarkdown(prefix, 80).length);
      const border = rows.find((r) => stripAnsi(r).startsWith('┌'));
      if (border && prefix.split('\n').filter((l) => l.startsWith('|')).length >= 4) {
        const w = visibleLen(border);
        expect(w).toBeGreaterThanOrEqual(lastBox);
        lastBox = w;
      }
      for (const row of rows) expect(visibleLen(row)).toBeLessThanOrEqual(80);
    }
    expect(stream.render(DOC_TABLE, 80)).toEqual(renderMarkdown(DOC_TABLE, 80));
    expect(stream.render(DOC_TABLE, 40)).toEqual(renderMarkdown(DOC_TABLE, 40));
  });

  it('once the table block seals, every later prefix equals plain exactly', () => {
    const sealPrefix = DOC_TABLE.slice(0, DOC_TABLE.indexOf('The wide columns'));
    const stream = createStreamMarkdownRenderer();
    for (const prefix of lineBoundaryPrefixes(DOC_TABLE)) {
      const rows = stream.render(prefix, 80);
      if (prefix.length >= sealPrefix.length) {
        expect(rows).toEqual(renderMarkdown(prefix, 80));
      }
    }
  });
});

describe('heading depth (Wave S3: #### no longer leaks literal hashes)', () => {
  it('renders h4–h6 as headings and keeps the h1–h3 hairline', () => {
    expect(stripAnsi(renderMarkdown('#### Deep heading\n\nbody', 80)[0])).toBe('Deep heading');
    expect(stripAnsi(renderMarkdown('##### Five\n\nbody', 80)[0])).toBe('Five');
    expect(stripAnsi(renderMarkdown('###### Six\n\nbody', 80)[0])).toBe('Six');
    const h2 = renderMarkdown('## Two\n\nbody', 80).map((r) => stripAnsi(r));
    expect(h2[0]).toBe('Two');
    expect(h2[1]).toContain('─');
    // Before the fix, #### fell through to a paragraph:
    expect(stripAnsi(renderMarkdown('#### Deep heading', 80).join(' '))).not.toContain('####');
  });
});

describe('language-aware code highlighting', () => {
  it('python: # comments and def/None get comment/keyword colour', () => {
    const rows = renderMarkdown(DOC_CODE, 80);
    const comment = rows.find((r) => stripAnsi(r).includes('Walrus included'));
    expect(comment).toContain(R.codeComment);
    const def = rows.find((r) => stripAnsi(r).includes('def replay'));
    expect(def).toContain(R.codeKeyword);
    const ret = rows.find((r) => stripAnsi(r).includes('"ok": True'));
    expect(ret).toContain(R.codeType); // True is a python constant here
  });

  it('shell: # comments, keywords and $vars are coloured', () => {
    const doc = ['```bash', '# deploy step', 'if [ -f "$HOME/app" ]; then echo ok; fi', 'export PATH=$HOME/bin:$PATH', '```'].join('\n');
    const rows = renderMarkdown(doc, 80);
    expect(rows.find((r) => stripAnsi(r).includes('deploy step'))).toContain(R.codeComment);
    const ifRow = rows.find((r) => stripAnsi(r).includes('echo ok'));
    expect(ifRow).toContain(R.codeKeyword);
    // A bare $VAR (outside quotes, where it isn't part of a string token)
    // is coloured via the variable group.
    const pathRow = rows.find((r) => stripAnsi(r).includes('export PATH'));
    expect(pathRow).toContain(R.codeNumber);
  });

  it('an explicit text fence gets NO keyword highlighting', () => {
    const doc = ['```text', 'return the value and function results', '```'].join('\n');
    const rows = renderMarkdown(doc, 80);
    const line = rows.find((r) => stripAnsi(r).includes('return the value'));
    expect(line).not.toContain(R.codeKeyword);
  });

  it('typescript fences keep the JS-profile colours', () => {
    const rows = renderMarkdown(DOC_CODE, 80);
    const ret = rows.find((r) => stripAnsi(r).includes('return findSealEnd'));
    expect(ret).toContain(R.codeKeyword);
  });
});

describe('numbered-list marker placement', () => {
  it('markers land on the item rows (regression: crash in short renders)', () => {
    const doc = [
      '1. Land the stream renderer behind the existing wrap cache',
      '2. Replay the fixture and compare frame curves',
      '3. Golden-test the corpus at widths 40 / 80 / 120',
      '4. Ship it',
    ].join('\n');
    // Each marker must sit on the row that OPENS its item — the old
    // recount stamped it on an earlier row (or indexed off the array and
    // threw) when the render was short, as in a streaming tail at doc start.
    const rows = renderMarkdown(doc, 60).map((r) => stripAnsi(r));
    const markerRows = rows.filter((r) => /^\s*\d+\./.test(r));
    expect(markerRows).toHaveLength(4);
    expect(markerRows[0]).toContain('Land the stream renderer');
    expect(markerRows[1]).toContain('Replay the fixture');
    expect(markerRows[2]).toContain('Golden-test the corpus');
    expect(markerRows[3]).toContain('Ship it');
    const stream = createStreamMarkdownRenderer();
    expect(() => stream.render(doc, 60)).not.toThrow();
    expect(stream.render(doc, 60)).toEqual(renderMarkdown(doc, 60));
    const s2 = createStreamMarkdownRenderer();
    for (const prefix of lineBoundaryPrefixes(doc)) {
      expect(s2.render(prefix, 60)).toEqual(renderMarkdown(prefix, 60));
    }
  });
});

describe('tool outcome JSON summaries (cards)', () => {
  it('summarizes a giant single-line JSON object by structure', () => {
    const blob = '{"users":[{"id":1,"name":"a"},{"id":2,"name":"b"}],"total":2,"page":1,"size":50,"q":"x"}';
    const obj = describeToolOutcome('search', { output: blob });
    expect(obj.summary).toContain('users');
    expect(obj.summary).not.toContain('{"users":[{"id":1,"name":"a"');
    expect(obj.summary.length).toBeLessThan(50);
    expect(summarizeJsonBlob('[1,2,3]')).toBe('JSON · 3 items of number');
    expect(summarizeJsonBlob('{"a":1}')).toBe('JSON · {a}');
    expect(summarizeJsonBlob('not json at all')).toBeNull();
  });

  it('leaves short JSON and plain output untouched', () => {
    expect(describeToolOutcome('read', { output: '{"a":1}' }).summary).toBe('{"a":1}');
    expect(describeToolOutcome('read', { output: 'plain first line\nsecond line' }).summary)
      .toBe('plain first line');
  });
});
