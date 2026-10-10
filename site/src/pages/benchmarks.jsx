import React from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';

const MEM = [
  ['Mochi', 18.2, true], ['jcode', 27.8], ['Codex CLI', 140.0],
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

function Bars({ title, meta, rows, unit, lower = true }) {
  const max = Math.max(...rows.map(r => r[1]));
  return (
    <div className="bench rv">
      <h3>{title}</h3>
      <div className="meta">{meta}</div>
      {rows.map(([n, v, me]) => (
        <div className={'row' + (me ? ' me first' : '')} data-v={v} data-fmt={unit} key={n}>
          <span className="n">{n}</span>
          <span className="t"><span className="f"></span></span>
          <span className="v"></span>
        </div>
      ))}
      <p style={{ fontSize: 11.5, color: 'var(--faint)', fontFamily: 'var(--mono)', marginTop: 10 }}>
        {lower ? 'lower is better' : 'higher is better'} · 10 launches per agent · PSS profiling / high-res PTY timing
      </p>
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

      <div className="wrap" style={{ paddingBottom: 80 }}>
        <div className="sec-head rv" style={{ marginBottom: 8 }}>
          <span className="kicker">Methodology</span>
          <h2>How these were measured.</h2>
          <p>Each agent was launched 10 times against a fixed warm cache. Memory is Process Set Size (PSS) from <code>/proc</code> at steady state. Timing uses high-resolution PTY timestamps, wall-clock from process spawn to first output. Same machine, same terminal, same shell profile, no cold-start handouts.</p>
        </div>

        <Bars title="Memory — single active session" meta="PSS · MB · 10 runs" rows={MEM} unit="MB" />
        <Bars title="Time to first input (TTFI)" meta="spawn → prompt accepted · ms · P50" rows={TTFI} unit="ms" />
        <Bars title="Time to first token (TTFT)" meta="first prompt sent → first token rendered · ms · P50" rows={TTFT} unit="ms" />
        <Bars title="First-token p95 extension factor" meta="P95 ÷ median TTFT · × · 1.0 = perfectly stable" rows={EXT} unit="x" />

        <div className="sec-head rv" style={{ marginTop: 60 }}>
          <span className="kicker">Full matrix</span>
          <h2>Every metric, every agent.</h2>
        </div>
        <table className="tbl rv">
          <thead><tr>
            <th>Agent</th><th>Memory (MB)</th><th>TTFI (ms)</th><th>TTFT (ms)</th><th>Ext. factor (×)</th>
          </tr></thead>
          <tbody>
            {[['Mochi', 18.2, 38.2, 441, 10.9, true], ['jcode', 27.8, 45.4, 510, 12.1],
              ['Pi', 34.4, 52.1, 650, 13.6], ['Codex CLI', 140.0, 93.0, 594, 19.3],
              ['Cursor Agent', 214.9, 121.5, 621, 47.2], ['OpenCode', 371.5, 168.3, 679, 24.8],
              ['Claude Code', 386.6, 172.4, 708, 30.0]].map(r => (
              <tr key={r[0]} className={r[5] ? 'me' : ''}>
                <td>{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td><td>{r[4]}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="grid3" style={{ marginTop: 44 }}>
          {[
            ['WHY LIGHT', 'The Rust core does the heavy lifting', 'Tokenization, budget math, and compaction planning run in compiled native code. The TypeScript layer never builds multi-megabyte object graphs per turn.'],
            ['WHY FAST', 'Nothing booted that you did not ask for', 'No Electron, no bundled language servers at startup, no telemetry warm-up. The TUI renders through direct ANSI to a high-res PTY clock.'],
            ['WHY STABLE', 'Latency you can feel, not just average', 'A 10.9× p95 extension factor means worst-case first tokens stay close to the median — no multi-second stalls mid-conversation.'],
          ].map(([k, h, p], i) => (
            <div className={'card rv' + (i ? ' d' + i : '')} key={i}>
              <span className="k">{k}</span>
              <h3><span className="dot"></span>{h}</h3>
              <p>{p}</p>
            </div>
          ))}
        </div>

        <p className="rv" style={{ marginTop: 40, fontSize: 14, color: 'var(--muted)' }}>
          Reproduce it yourself: <code>npm run bench:memory</code> in the repo, or read the full <a href="https://github.com/xanstomper/mochi/blob/main/docs/BENCHMARKS.md" target="_blank" rel="noopener">methodology and raw data</a>.
        </p>
      </div>
    </>
  );
}
createRoot(document.getElementById('root')).render(<Benchmarks />);
