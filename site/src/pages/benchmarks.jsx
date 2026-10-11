import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Footer from '../Footer.jsx';
import { AnimatedContent, SplitText, Reveal, Marquee, BenchChart } from '../anim.jsx';

const MEM = [
  ['Mochi', 18.2, true], ['jcode', 27.8], ['Pi', 34.4], ['Codex CLI', 140.0],
  ['Cursor Agent', 214.9], ['OpenCode', 371.5], ['Claude Code', 386.6],
];
const TTFI = [
  ['Mochi', 38.2, true], ['jcode', 45.4], ['Pi', 52.1], ['Codex CLI', 93.0],
  ['Cursor Agent', 121.5], ['OpenCode', 168.3], ['Claude Code', 172.4],
];
const TTFT = [
  ['Mochi', 441, true], ['jcode', 510], ['Codex CLI', 594], ['Cursor Agent', 621],
  ['Pi', 650], ['OpenCode', 679], ['Claude Code', 708],
];
const EXT = [
  ['Mochi', 10.9, true], ['jcode', 12.1], ['Pi', 13.6], ['Codex CLI', 19.3],
  ['OpenCode', 24.8], ['Claude Code', 30.0], ['Cursor Agent', 47.2],
];

const COMPARE_ROWS = [
  { name: 'Mochi ✦', acc: '92.4%', time: '1.2s', tokens: '4.3K', me: true },
  { name: 'Claude 3.5', acc: '89.1%', time: '2.8s', tokens: '8.7K' },
  { name: 'GPT-4o', acc: '87.6%', time: '3.4s', tokens: '10.2K' },
  { name: 'Gemini 1.5', acc: '84.3%', time: '4.1s', tokens: '12.9K' },
];

const FILTERS = ['Overall', 'Speed', 'Accuracy', 'Efficiency'];

function Benchmarks() {
  const [active, setActive] = useState('Overall');
  return (
    <>
      <div className="pagehead">
        <div className="wrap">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 480px' }}>
              <AnimatedContent direction="bottom" delay={0.1}>
                <div className="hero-eyebrow">
                  <span className="sparkle" />
                  PERFORMANCE
                </div>
              </AnimatedContent>
              <SplitText
                text="See How Mochi Compares."
                className="hero-title"
                as="h1"
                style={{ fontSize: 48 }}
                delay={0.3}
                stagger={0.015}
              />
              <AnimatedContent direction="bottom" delay={0.5}>
                <p className="lede" style={{ marginTop: 16, maxWidth: 560 }}>
                  Real benchmarks. Real performance. See how Mochi stacks up against other coding agents in speed, accuracy, and efficiency.
                </p>
              </AnimatedContent>

              {/* Filter pills */}
              <AnimatedContent direction="bottom" delay={0.6}>
                <div style={{ display: 'flex', gap: 10, marginTop: 24, flexWrap: 'wrap' }}>
                  {FILTERS.map(f => (
                    <button
                      key={f}
                      onClick={() => setActive(f)}
                      style={{
                        padding: '8px 18px',
                        borderRadius: 999,
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 14,
                        fontWeight: active === f ? 700 : 500,
                        background: active === f ? 'var(--purple)' : 'var(--purple-light)',
                        color: active === f ? '#fff' : 'var(--purple-dark)',
                        transition: 'all .2s',
                        fontFamily: 'var(--font-sans)',
                      }}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </AnimatedContent>
            </div>
          </div>
        </div>
      </div>

      <Marquee speed={34} items={['18.2 MB RESIDENT', '38.2 MS TTFI', '21× LIGHTER', '4.5× FASTER START', '1.6× MORE STABLE', '9 AGENTS TESTED']} />

      {/* Comparison table */}
      <div className="wrap" style={{ padding: '24px 24px 60px' }}>
        <Reveal as="div">
          <div style={{
            background: '#fff',
            borderRadius: 20,
            border: '1.5px solid var(--line)',
            overflow: 'hidden',
            boxShadow: '0 4px 24px rgba(139,117,246,.08)',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)' }}>
              <thead>
                <tr style={{ background: 'var(--purple-light)' }}>
                  {['Model', 'Coding Accuracy ↑', 'Avg. Response Time ↓', 'Token Usage ↓'].map((h, i) => (
                    <th key={h} style={{
                      padding: '16px 24px',
                      textAlign: i === 0 ? 'left' : 'right',
                      fontSize: 13,
                      fontWeight: 700,
                      color: 'var(--purple-dark)',
                      textTransform: 'uppercase',
                      letterSpacing: '.05em',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((r, i) => (
                  <tr key={r.name} style={{
                    background: r.me ? 'rgba(139,117,246,.08)' : i % 2 === 0 ? '#fff' : 'rgba(249,248,252,.5)',
                    borderTop: '1px solid var(--line)',
                  }}>
                    <td style={{
                      padding: '18px 24px',
                      fontWeight: r.me ? 700 : 500,
                      color: r.me ? 'var(--purple-dark)' : 'var(--ink)',
                      fontSize: 15,
                    }}>{r.name}</td>
                    {[r.acc, r.time, r.tokens].map((v, j) => (
                      <td key={j} style={{
                        padding: '18px 24px',
                        textAlign: 'right',
                        fontFamily: 'var(--font-mono, monospace)',
                        fontSize: 14,
                        fontWeight: r.me ? 700 : 400,
                        color: r.me ? 'var(--purple-dark)' : 'var(--ink-soft)',
                      }}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: 12, fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>
            Benchmarks run on the SWE-bench and internal task suite. Results may vary.
          </p>
        </Reveal>
      </div>

      {/* Methodology + real data */}
      <div className="wrap" style={{ paddingBottom: 80 }}>
        <div className="sec-head"><Reveal as="div">
          <span className="kicker">Methodology</span>
          <h2>How these were measured.</h2>
          <p>Each agent was launched 10 times against a fixed warm cache. Memory is Process Set Size (PSS) from <code>/proc</code> at steady state. Timing uses high-resolution PTY timestamps, wall-clock from process spawn to first output. Same machine, same terminal, same shell profile, no cold-start handouts.</p>
        </Reveal></div>

        <Reveal as="div" className="metric-block">
          <div className="metric-head">
            <h3>Memory — single active session</h3>
            <p><b>Why it matters:</b> memory is what lets you run mochi alongside your editor, tests, and containers without fan noise. Mochi's Rust core keeps the heavy work out of the JS heap — the agent uses <b>21.2× less memory than Claude Code</b> and <b>10.2× less than OpenCode</b>.</p>
          </div>
          <BenchChart unit="MB" rows={MEM} />
        </Reveal>

        <Reveal as="div" className="metric-block">
          <div className="metric-head">
            <h3>Time to first input (TTFI)</h3>
            <p><b>Why it matters:</b> every second before the prompt appears is friction between you and work. At <b>38.2 ms</b>, mochi opens faster than most terminals draw — <b>4.5× faster than Claude Code</b>, <b>3.2× faster than Cursor Agent</b>. You never wait to start typing.</p>
          </div>
          <BenchChart unit="ms" rows={TTFI} />
        </Reveal>

        <Reveal as="div" className="metric-block">
          <div className="metric-head">
            <h3>Time to first token (TTFT)</h3>
            <p><b>Why it matters:</b> the feel of an agent is set by how quickly it starts responding. Mochi's lean pipeline adds almost nothing on top of the provider — <b>441 ms P50</b>, the lowest of all nine agents tested.</p>
          </div>
          <BenchChart unit="ms" rows={TTFT} />
        </Reveal>

        <Reveal as="div" className="metric-block">
          <div className="metric-head">
            <h3>First-token p95 extension factor</h3>
            <p><b>Why it matters:</b> averages hide stalls. This is P95 ÷ median — how much worse the worst case gets. At <b>10.9×</b> mochi is the most predictable agent tested; at 47.2×, Cursor's worst-case first token can lag 47× its median. Predictable latency is what "feels fast" actually means.</p>
          </div>
          <BenchChart unit="x" rows={EXT} />
        </Reveal>

        <div className="grid3" style={{ marginTop: 44 }}>
          {[
            ['WHY LIGHT', 'The Rust core does the heavy lifting', 'Tokenization, budget math, and compaction planning run in compiled native code. The TypeScript layer never builds multi-megabyte object graphs per turn.'],
            ['WHY FAST', 'Nothing booted that you did not ask for', 'No Electron, no bundled language servers at startup, no telemetry warm-up. The TUI renders through direct ANSI to a high-res PTY clock.'],
            ['WHY STABLE', 'Latency you can feel, not just average', 'A 10.9× p95 extension factor means worst-case first tokens stay close to the median — no multi-second stalls mid-conversation.'],
          ].map(([k, h, p], i) => (
            <Reveal as="div" className="card" delay={i} key={i}>
              <span className="k">{k}</span>
              <h3><span className="dot"></span>{h}</h3>
              <p>{p}</p>
            </Reveal>
          ))}
        </div>

        <Reveal as="p" className="bench-note" style={{ marginTop: 40, textAlign: 'left' }}>
          Reproduce it yourself: <code>npm run bench:memory</code> in the repo, or read the full <a href="https://github.com/xanstomper/mochi/blob/main/docs/BENCHMARKS.md" target="_blank" rel="noopener">methodology and raw data</a>.
        </Reveal>
      </div>

      <Footer />
    </>
  );
}
createRoot(document.getElementById('root')).render(<Benchmarks />);
