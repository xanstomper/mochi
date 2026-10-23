// TUI stream-replay benchmark — deterministic replay of a long model output
// through the REAL transcript render path (renderMarkdown, as called by
// app.ts wrapLine for the actively-streaming assistant line).
//
// Why this exists: during streaming, every frame re-renders the current
// assistant line's markdown from scratch. The line grows to STREAM_LINE_CAP
// (16,000 chars) before state.ts rolls it into a fresh line, so per-frame
// render cost grows linearly with the accumulated text and total stream cost
// is O(n²). This bench replays a fixed fixture at the production frame
// cadence (scheduleRender coalesces to ~30ms) and reports the per-frame cost
// curve — before the fix it demonstrates the growth; after the fix (stream
// renderer with a sealed prefix) the same replay runs against
// createStreamMarkdownRenderer and the curve must stay flat.
//
// Run: npx tsx bench/tui-stream.ts [--mode=plain|stream] [--width=100]
// Deterministic: the fixture is generated from a fixed seed; chunk sizes are
// fixed; only wall-clock timing varies.

import { renderMarkdown } from '../src/tui/view.js';
import * as view from '../src/tui/view.js';

// The stream renderer is the fix this bench justifies; before it lands the
// export is absent and stream mode reports itself unavailable.
const createStreamMarkdownRenderer = (view as Record<string, unknown>)['createStreamMarkdownRenderer'] as
  ((() => { render(text: string, width: number): string[] }) | undefined);

// ---------------------------------------------------------------------------
// Fixture: a realistic long agent response — prose, headings, nested lists, a
// wide table, TS + Python fences, a blockquote, inline code/links/bold.
// ~15.5K chars: one full STREAM_LINE_CAP segment, the worst single-line case.
// ---------------------------------------------------------------------------

const WORDS = ('agent loop context window token stream render frame budget verify ' +
  'checkpoint journal replay harness model tool schema cache prefix markdown table ' +
  'fence heading latency throughput coalesce diff paint cursor terminal width wrap').split(' ');

function prose(seed: number, sentences: number): string {
  let s = '';
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  for (let i = 0; i < sentences; i++) {
    const n = 6 + Math.floor(rnd() * 9);
    const words: string[] = [];
    for (let j = 0; j < n; j++) words.push(WORDS[Math.floor(rnd() * WORDS.length)]);
    words[0] = words[0][0].toUpperCase() + words[0].slice(1);
    s += words.join(' ') + '. ';
  }
  return s.trim();
}

export function buildStreamFixture(): string {
  const parts: string[] = [];
  parts.push('## Summary of the investigation\n');
  parts.push(prose(11, 6) + '\n');
  parts.push('The three findings that matter:\n');
  parts.push('- The render loop re-parses the **entire** accumulated message on every frame');
  parts.push('- Column widths in tables are recomputed from scratch as rows arrive');
  parts.push('  - Nested point: `renderTable` has no memory of the previous frame');
  parts.push('  - So columns visibly *jitter* while a table streams in');
  parts.push('- Unclosed inline constructs leak raw markdown until they close\n');
  parts.push('### Measurements by subsystem\n');
  parts.push('| Subsystem | Before (ms) | After (ms) | Notes |');
  parts.push('|---|---:|---:|---|');
  const subs = ['markdown parse', 'table layout', 'code highlight', 'row diff write', 'composer wrap', 'status bars', 'tab bar', 'selection pass'];
  for (let i = 0; i < subs.length; i++) {
    parts.push(`| ${subs[i]} | ${(3 + i * 1.7).toFixed(1)} | ${(0.4 + i * 0.3).toFixed(1)} | frame ${i + 1} of the replay |`);
  }
  parts.push('');
  parts.push('### The fix in code\n');
  parts.push('```ts');
  parts.push('export function createStreamMarkdownRenderer() {');
  parts.push('  let sealedLen = 0;');
  parts.push('  let sealedRows: string[] = [];');
  parts.push('  // Seal complete blocks; re-render only the live tail.');
  parts.push('  return {');
  parts.push('    render(text: string, width: number): string[] {');
  parts.push('      const tail = text.slice(sealedLen);');
  parts.push('      return [...sealedRows, ...renderMarkdown(tail, width)];');
  parts.push('    },');
  parts.push('  };');
  parts.push('}');
  parts.push('```\n');
  parts.push(prose(23, 8) + '\n');
  parts.push('```python');
  parts.push('# Walrus and f-strings included on purpose');
  parts.push('def replay(frames, width=100):');
  parts.push('    total = 0.0');
  parts.push('    for frame in frames:');
  parts.push('        if (n := len(frame.rows)) > 0:');
  parts.push('            total += n * 0.016  # ~60fps budget in seconds');
  parts.push('    return {"frames": len(frames), "total": total, "ok": True}');
  parts.push('```\n');
  parts.push('> The renderer is WIDTH-AWARE now: it wraps at the exact transcript');
  parts.push('> width and emits hanging-indented final rows.\n');
  parts.push('## Rollout checklist\n');
  parts.push('1. Land the stream renderer behind the existing wrap cache');
  parts.push('2. Replay the fixture and compare frame curves');
  parts.push('3. Golden-test the corpus at widths 40 / 80 / 120');
  parts.push('4. Ship it\n');
  // Pad with more prose + a second table until we approach the 16K cap —
  // real long answers interleave explanation and evidence like this.
  let seed = 41;
  while (parts.join('\n').length < 13_800) {
    parts.push(prose(seed, 5) + '\n');
    parts.push(`- Checkpoint ${seed}: verified with \`npm test\` and [the journal](https://example.com/journal/${seed})`);
    seed += 7;
  }
  parts.push('\nDone — the full trace is in the journal if you want to replay it.');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Replay: frames at the production cadence. Each frame the stream delivers
// CHARS_PER_FRAME more characters and the TUI re-renders the streaming line.
// ---------------------------------------------------------------------------

const CHARS_PER_FRAME = 150; // ~5K chars/s at 33fps — a fast real stream

interface FrameStat { len: number; ms: number; tail?: number; sealed?: number }

function replay(text: string, width: number, mode: 'plain' | 'stream'): FrameStat[] {
  const stats: FrameStat[] = [];
  if (mode === 'stream' && !createStreamMarkdownRenderer) {
    throw new Error('stream mode unavailable: createStreamMarkdownRenderer not implemented yet');
  }
  const stream = mode === 'stream' ? createStreamMarkdownRenderer!() : null;
  // Warm-up at a small prefix so JIT noise doesn't dominate the first frames.
  renderMarkdown(text.slice(0, 300), width);
  for (let len = CHARS_PER_FRAME; len <= text.length; len += CHARS_PER_FRAME) {
    const prefix = text.slice(0, len);
    const t0 = performance.now();
    if (stream) stream.render(prefix, width);
    else renderMarkdown(prefix, width);
    const ms = performance.now() - t0;
    const st = stream as unknown as { stats?: () => { tailChars: number; sealedChars: number } } | null;
    const extra = st?.stats ? st.stats() : undefined;
    stats.push({ len, ms, tail: extra?.tailChars, sealed: extra?.sealedChars });
  }
  return stats;
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(label: string, stats: FrameStat[]): void {
  const ms = stats.map((s) => s.ms).sort((a, b) => a - b);
  const total = ms.reduce((a, b) => a + b, 0);
  const over = stats.filter((s) => s.ms > 16).length;
  const at = (target: number) => {
    const s = stats.reduce((best, cur) => (Math.abs(cur.len - target) < Math.abs(best.len - target) ? cur : best), stats[0]);
    return `${s.ms.toFixed(2)}ms @${s.len}`;
  };
  console.log(
    `${label}: frames=${stats.length} total=${total.toFixed(0)}ms mean=${(total / stats.length).toFixed(2)}ms ` +
    `p95=${pct(ms, 95).toFixed(2)}ms max=${ms[ms.length - 1].toFixed(2)}ms frames>16ms=${over}`,
  );
  console.log(`  per-frame cost by message length: 2K→${at(2000)}  4K→${at(4000)}  8K→${at(8000)}  12K→${at(12000)}  15K→${at(15000)}`);
  if (process.env.SPIKES) {
    for (const s of stats) {
      if (s.ms > 8) console.log(`  spike: ${s.ms.toFixed(1)}ms @len=${s.len} tail=${s.tail ?? '-'} sealed=${s.sealed ?? '-'}`);
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const mode = (args.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'plain') as 'plain' | 'stream';
  const width = Number(args.find((a) => a.startsWith('--width='))?.split('=')[1] ?? 100);
  const fixture = buildStreamFixture();
  console.log(`fixture: ${fixture.length} chars, width=${width}, mode=${mode}`);
  const stats = replay(fixture, width, mode);
  report(mode, stats);
  // Equivalence spot-check in stream mode: final frame rows must match the
  // plain full render exactly (the stream renderer is a cache, not a fork).
  if (mode === 'stream' && createStreamMarkdownRenderer) {
    const stream = createStreamMarkdownRenderer();
    let rows: string[] = [];
    for (let len = CHARS_PER_FRAME; len <= fixture.length; len += CHARS_PER_FRAME) {
      rows = stream.render(fixture.slice(0, len), width);
    }
    rows = stream.render(fixture, width);
    const plain = renderMarkdown(fixture, width);
    const same = rows.length === plain.length && rows.every((r, i) => r === plain[i]);
    console.log(`equivalence: stream-final == plain-full → ${same} (${rows.length} rows)`);
    if (!same) process.exitCode = 1;
  }
}

main();
