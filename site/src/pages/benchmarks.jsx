import React from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';
import { Reveal, BenchChart, CountUp } from '../anim.jsx';

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

function Headline() {
  return (
    <div className="wrap bench-hero">
      {[
        ['21.2×', 'less memory than Claude Code', 18.2, 386.6],
        ['4.5×', 'faster to first input than Claude Code', 38.2, 172.4],
        ['1.6×', 'more stable latency than Claude Code', 30.0, 10.9],
      ].map(([big, lbl, a, b], i) => (
        <Reveal as="div" className="big-stat" delay={i} key={i}>
          <div className="big">{big}</div>
          <div className="lbl">{lbl}</div>
        </Reveal>
      ))}
    </div>
  );
}

function Benchmarks() {
  return (
    <>
      <div className="pagehead">
        <div className="wrap">
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 14 }}>Benchmarks <Mochi size={46} mood="happy" className="mascot bob" /></h1>
          <p>Measured, not vibes. Ten launches per agent, cross-verified against published <code>--version</code> timings where available. Methodology, raw logs, and the harness live in the repo's <a href="https://github.com/xanstomper/mochi/blob/main/docs/BENCHMARKS.md" target="_blank" rel="noopener">BENCHMARKS.md</a>.</p>
        </div>
      </div>

      <Headline />

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

        <div className="sec-head" style={{ marginTop: 60 }}><Reveal as="div">
          <span className="kicker">Full matrix</span>
          <h2>Every metric, every agent.</h2>
        </Reveal></div>
        <Reveal as="table" className="tbl">
          <thead><tr>
            <th>Agent</th><th>Memory (MB)</th><th>TTFI (ms)</th><th>TTFT (ms)</th><th>Ext. factor (×)</th>
          </tr></thead>
          <tbody>
            {MEM.map(([n, mem], i) => (
              <tr key={n} className={n === 'Mochi' ? 'me' : ''}>
                <td>{n}</td><td>{mem}</td><td>{TTFI[i][1]}</td><td>{TTFT[i][1]}</td><td>{EXT[i][1]}</td>
              </tr>
            ))}
          </tbody>
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
    </>
  );
}
createRoot(document.getElementById('root')).render(<Benchmarks />);
