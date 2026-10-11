import React from 'react';
import { createRoot } from 'react-dom/client';
import Footer from '../Footer.jsx';
import FilmGrain from '../FilmGrain.jsx';
import { AnimatedContent, SplitText, ScrollFloat } from '../anim.jsx';

/* REAL measured data — docs/BENCHMARKS.md methodology (10 launches, warm cache,
   PSS from /proc at steady state, PTY wall-clock timestamps). */
const CHARTS = [
  {
    id: 'mem', title: 'Resident memory', unit: 'MB', max: 400,
    why: 'Memory is what lets you run Mochi alongside your editor, tests, and containers without fan noise. The Rust core keeps heavy work out of the JS heap — 21.2× less memory than Claude Code, 10.2× less than OpenCode.',
    data: [['Mochi', 18.2, true], ['jcode', 27.8], ['Pi', 34.4], ['Codex CLI', 140.0], ['Cursor Agent', 214.9], ['OpenCode', 371.5], ['Claude Code', 386.6]],
  },
  {
    id: 'ttfi', title: 'Time to first input', unit: 'ms', max: 200,
    why: 'Every second before the prompt appears is friction between you and work. At 38.2 ms, Mochi opens faster than most terminals draw — 4.5× faster than Claude Code.',
    data: [['Mochi', 38.2, true], ['jcode', 45.4], ['Pi', 52.1], ['Codex CLI', 93.0], ['Cursor Agent', 121.5], ['OpenCode', 168.3], ['Claude Code', 172.4]],
  },
  {
    id: 'ttft', title: 'Time to first token', unit: 'ms', max: 800,
    why: 'The feel of an agent is set by how quickly it starts responding. Mochi\u2019s lean pipeline adds almost nothing on top of the provider — 441 ms P50, the lowest of all nine agents tested.',
    data: [['Mochi', 441, true], ['jcode', 510], ['Codex CLI', 594], ['Cursor Agent', 621], ['Pi', 650], ['OpenCode', 679], ['Claude Code', 708]],
  },
  {
    id: 'ext', title: 'First-token p95 extension', unit: '×', max: 50,
    why: 'Averages hide stalls. This is P95 ÷ median — how much worse the worst case gets. At 10.9× Mochi is the most predictable agent tested; predictability is what "feels fast" actually means.',
    data: [['Mochi', 10.9, true], ['jcode', 12.1], ['Pi', 13.6], ['Codex CLI', 19.3], ['OpenCode', 24.8], ['Claude Code', 30.0], ['Cursor Agent', 47.2]],
  },
];

function BarChart({ data, max, unit, delayBase = 0 }) {
  return (
    <div className="bchart">
      {data.map(([label, value, mochi], i) => (
        <div key={label} className="bchart-row" style={{ animationDelay: (delayBase + i * 0.09) + 's' }}>
          <span className={'bchart-label' + (mochi ? ' is-mochi' : '')}>
            {mochi ? 'Mochi ✦' : label}
          </span>
          <div className="bchart-track">
            <div
              className={'bchart-fill' + (mochi ? ' is-mochi' : '')}
              style={{ width: (value / max * 100) + '%' }}
              data-value={value}
            />
          </div>
          <span className={'bchart-val' + (mochi ? ' is-mochi' : '')}>
            {value.toLocaleString()}{unit}
          </span>
        </div>
      ))}
    </div>
  );
}

function Benchmarks() {
  return (
    <>
      <FilmGrain />
      <div className="pagehead">
        <div className="wrap">
          <div className="pagehead-row">
            <div className="pagehead-col">
              <AnimatedContent direction="bottom" delay={0.1}>
                <div className="hero-eyebrow">
                  <span className="sparkle" />
                  BENCHMARKS
                </div>
              </AnimatedContent>
              <ScrollFloat moveDistance={24}>
                <h1 className="pagehead-title">Numbers, not adjectives.</h1>
              </ScrollFloat>
              <AnimatedContent direction="bottom" delay={0.5}>
                <p className="lede" style={{ marginTop: 16, maxWidth: 620 }}>
                  Ten launches against a fixed warm cache. Same machine, same terminal, same shell profile — no cold-start handouts. Process memory is PSS from <code>/proc</code> at steady state; timing uses high-resolution PTY timestamps.
                </p>
              </AnimatedContent>
            </div>
          </div>
        </div>
      </div>

      <div className="wrap" style={{ padding: '24px 24px 40px' }}>
        {CHARTS.map((c, ci) => (
          <AnimatedContent key={c.id} direction="bottom" delay={ci * 0.05}>
            <section className="bench-section">
              <div className="bench-section-head">
                <h2>{c.title}</h2>
                <p>{c.why}</p>
              </div>
              <div className="bench-section-chart">
                <BarChart data={c.data} max={c.max} unit={c.unit} delayBase={0.2} />
              </div>
            </section>
          </AnimatedContent>
        ))}

        <AnimatedContent direction="bottom">
          <div className="bench-repro">
            <span>Reproduce it yourself:</span>
            <code>npm run bench:memory</code>
            <span>in the repo, or read the full</span>
            <a href="https://github.com/xanstomper/mochi/blob/main/docs/BENCHMARKS.md" target="_blank" rel="noopener">methodology and raw data →</a>
          </div>
        </AnimatedContent>
      </div>

      <Footer />
    </>
  );
}

createRoot(document.getElementById('root')).render(<Benchmarks />);
