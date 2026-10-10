import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';

function HeroTerm() {
  const lines = [
    { cls: '', pre: true, text: 'mochi "add a rate limiter to the auth service"' },
    { cls: 'dim', text: '' },
    { cls: 'dim', text: '  goal decomposed → 3 tasks · team: lead, coder, tester' },
    { cls: '', text: '  ├─ lead     mapped auth surfaces, cut scope to 2 files' },
    { cls: '', text: '  ├─ coder    token-bucket limiter in src/middleware/' },
    { cls: '', text: '  └─ tester   6 integration cases, all green' },
    { cls: 'g', text: '✔ verified · tests passing · git checkpoint created' },
  ];
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n >= lines.length) return;
    const t = setTimeout(() => setN(n + 1), n === 1 ? 500 : 260);
    return () => clearTimeout(t);
  }, [n]);
  return (
    <div className="term">
      <div className="bar"><i></i><i></i><i></i><span>mochi — session</span></div>
      <pre>
        {lines.slice(0, n).map((l, i) => (
          <div key={i} className={l.cls} style={{ transition: 'opacity .4s' }}>
            {l.pre && <span className="c">$ </span>}
            {l.pre ? <span className="p">mochi</span> : null}
            {l.pre ? l.text.replace('mochi ', '') : l.text}
          </div>
        ))}
        {n >= lines.length && (
          <div><span className="c">$ </span><span className="p">mochi</span> trace <span className="g">g_8f42</span><span className="c">   # replay every step</span></div>
        )}
        <span className="cursor" style={{ display: 'inline-block', width: 8, height: 16, background: 'var(--pink)', verticalAlign: '-2px', marginLeft: 4, animation: 'blink 1.05s steps(1) infinite' }}></span>
        <style>{'@keyframes blink{50%{opacity:0}}'}</style>
      </pre>
    </div>
  );
}

function Sparkle({ className }) {
  return (
    <svg className={'sparkle ' + className} width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" />
    </svg>
  );
}

function Home() {
  return (
    <>
      <section className="hero">
        <div className="wrap grid2">
          <div>
            <div className="tag rv in">🍡 Terminal-native · Rust core · zero runtime dependencies</div>
            <h1 className="rv in d1">The coding agent that gets <em>out of your way</em>.</h1>
            <p className="rv in d2 sub">
              Mochi is a minimal, fast, autonomous coding agent for the terminal. Goals decompose into
              task DAGs, role-diverse teams execute them, a persistent daemon keeps them running, and
              every run replays trace-for-trace — all on 18&nbsp;MB of RAM.
            </p>
            <div className="rv in d3 cta">
              <a className="btn primary" href="docs.html#install">Install</a>
              <a className="btn soft" href="benchmarks.html">Benchmarks</a>
            </div>
          </div>
          <div className="hero-art rv in d2">
            <Sparkle className="s1" />
            <Sparkle className="s2" />
            <Sparkle className="s3" />
            <Mochi size={300} mood="wink" className="bob" />
          </div>
        </div>
      </section>

      <div className="wrap strip">
        {[
          ['18.2', 'MB', 'single-session memory · 21.2× lighter than Claude Code'],
          ['38.2', 'ms', 'time to first input · fastest of nine agents tested'],
          ['16', '', 'specialized agent roles orchestrated per goal'],
          ['0', '', 'runtime JavaScript dependencies'],
        ].map(([num, unit, lbl], i) => (
          <div className={'stat rv' + (i ? ' d' + i : '')} key={i}>
            <div className="num">{num}{unit && <em>{unit}</em>}</div>
            <div className="lbl">{lbl}</div>
          </div>
        ))}
      </div>

      <section className="sec" id="features">
        <div className="wrap">
          <div className="sec-head rv">
            <span className="kicker">What's inside</span>
            <h2>A complete harness, not a wrapper.</h2>
            <p>Mochi is built from scratch — no framework, no Electron, no runtime dependencies. The hot paths run in compiled Rust; everything else stays thin.</p>
          </div>
          <div className="grid3">
            {[
              ['ENGINE', 'Compiled Rust core', 'Tokenization, budget math, compaction planning, and loop decisions execute natively via N-API. Every path has a parity-tested TypeScript fallback.'],
              ['ORCHESTRATION', 'Goals → DAGs → teams', 'Persistent goals decompose into task DAGs and run through role-diverse swarms with independent verifiers and an outcome judge.'],
              ['RUNTIME', 'Persistent daemon', 'One background process serves jobs, approvals, resume, and cron-scheduled runs over HTTP — drive it from scripts, editors, or CI.'],
              ['CONTEXT', 'Adaptive context engine', 'Token budgets with compaction planning, project memory that survives sessions, and retrieval across files, symbols, and git history.'],
              ['INTELLIGENCE', 'AST-native tooling', 'Tree-sitter codegraph over 15 languages: find callers, resolve type hierarchies, rewrite symbols without anchor drift.'],
              ['SAFETY', 'Budgets & checkpoints', 'Token, cost, time, tool, model, and agent limits. Safe/ask/auto permissions. Git checkpoint and rollback under every destructive action.'],
              ['OBSERVABILITY', 'Deep run traces', 'Every run is durable and replayable end-to-end, with deep redaction. Full-text session search in SQLite+FTS5.'],
              ['MODELS', 'Provider-agnostic', 'Any OpenAI-compatible endpoint, capability routing (fast / coding / reasoning / review), budget-aware fallback, multi-key rotation.'],
              ['LEARNING', 'Harness that learns', 'Project memory carries cross-session engineering facts; successful recovery strategies are recorded locally and reused.'],
            ].map(([k, h, p], i) => (
              <div className={'card rv' + (i % 3 ? ' d' + (i % 3) : '')} key={i}>
                <span className="k">{k}</span>
                <h3><span className="dot"></span>{h}</h3>
                <p>{p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="sec" id="roles" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="sec-head rv">
            <span className="kicker">Teams</span>
            <h2>Sixteen specialists. One goal.</h2>
            <p><code>mochi team "…"</code> spawns a swarm where every agent has a real job, a scoped tool allowlist, and a model tier matched to the work. Full table in the <a href="docs.html#roles">docs</a>.</p>
          </div>
          <div className="grid3">
            {[
              ['reasoning', 'lead / architect / debugger', 'Decompose goals, design contracts, root-cause failures. Read-heavy, decision-heavy, no blind edits.'],
              ['coding', 'coder / devops / frontend / backend', 'Full write access with surgical patch tools, headless test verification, and checkpointed edits.'],
              ['review / fast', 'reviewer / researcher / tester', 'Read-only auditors and fast-tier test engineers — the swarm self-checks before it reports done.'],
            ].map(([k, h, p], i) => (
              <div className={'card rv' + (i ? ' d' + i : '')} key={i}>
                <span className="k">{k}</span>
                <h3><span className="dot"></span>{h}</h3>
                <p>{p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="sec" id="why" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="sec-head rv">
            <span className="kicker">Benchmarks</span>
            <h2>Numbers first place in every row.</h2>
            <p>Measured across nine terminal agents — 10 launches per metric, PSS profiling, high-resolution PTY timing. <a href="benchmarks.html">Full methodology →</a></p>
          </div>
          <div className="bench rv">
            {[
              ['Mochi', 18.2, true], ['jcode', 27.8], ['Codex CLI', 140.0],
              ['Cursor Agent', 214.9], ['OpenCode', 371.5], ['Claude Code', 386.6],
            ].map(([n, v, me]) => (
              <div className={'row' + (me ? ' me first' : '')} data-v={v} key={n}>
                <span className="n">{n}</span>
                <span className="t"><span className="f"></span></span>
                <span className="v"></span>
              </div>
            ))}
          </div>
          <p className="rv" style={{ fontSize: 13, color: 'var(--faint)', fontFamily: 'var(--mono)', marginTop: -28 }}>PSS memory · 1 active session · lower is better</p>
        </div>
      </section>

      <section className="cta-sec">
        <div className="wrap">
          <Mochi size={130} className="bob rv" />
          <h2 className="rv d1">Give your terminal a harness.</h2>
          <p className="rv d2">Node 22+ or Bun. Zero runtime dependencies. Under a minute to build.</p>
          <div className="rv d3" style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a className="btn primary" href="docs.html#install">Get started</a>
            <a className="btn soft" href="https://github.com/xanstomper/mochi" target="_blank" rel="noopener">Read the source</a>
          </div>
        </div>
      </section>
    </>
  );
}

createRoot(document.getElementById('root')).render(<Home />);
