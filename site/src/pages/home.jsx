import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';
import { Reveal, CountUp, BenchChart } from '../anim.jsx';
import { FeatureGrid } from '../Features.jsx';

function HeroTerm() {
  const lines = [
    { cls: '', pre: true, text: '"add a rate limiter to the auth service"' },
    { cls: 'dim', text: '  goal decomposed → 3 tasks · team: lead, coder, tester' },
    { cls: '', text: '  ├─ lead     mapped auth surfaces, cut scope to 2 files' },
    { cls: '', text: '  ├─ coder    token-bucket limiter in src/middleware/' },
    { cls: '', text: '  └─ tester   6 integration cases, all green' },
    { cls: 'g', text: '✔ verified · tests passing · git checkpoint created' },
  ];
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n >= lines.length) return;
    const t = setTimeout(() => setN(n + 1), n === 0 ? 600 : 300);
    return () => clearTimeout(t);
  }, [n]);
  return (
    <div className="term">
      <div className="bar"><i></i><i></i><i></i><span>mochi — session</span></div>
      <pre>
        {lines.slice(0, n).map((l, i) => (
          <div key={i} className={l.cls} style={{ opacity: 1, animation: 'fadeUp .45s cubic-bezier(.34,1.3,.5,1)' }}>
            {l.pre && <><span className="c">$ </span><span className="p">mochi</span> </>}
            {l.text}
          </div>
        ))}
        {n >= lines.length && (
          <div style={{ animation: 'fadeUp .45s cubic-bezier(.34,1.3,.5,1)' }}>
            <span className="c">$ </span><span className="p">mochi</span> trace <span className="g">g_8f42</span><span className="c">   # replay every step</span>
          </div>
        )}
        <span className="cursor"></span>
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

// harness flow: goal -> DAG -> team -> verify -> trace, animated arrows
function Flow() {
  const steps = [
    ['goal', 'you state a goal'],
    ['dag', 'decomposed into a task DAG'],
    ['team', 'role-diverse swarm executes'],
    ['verify', 'verifiers + outcome judge'],
    ['trace', 'durable, replayable trace'],
  ];
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep(s => (s + 1) % steps.length), 1600);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flow">
      {steps.map(([k, d], i) => (
        <React.Fragment key={k}>
          {i > 0 && <span className={'flow-arrow' + (step >= i ? ' on' : '')}></span>}
          <div className={'flow-node' + (step === i ? ' hot' : step > i ? ' done' : '')}>
            <b>{k}</b><span>{d}</span>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

function Home() {
  return (
    <>
      <section className="hero">
        <div className="wrap grid2">
          <div>
            <Reveal as="div" className="tag">🍡 Terminal-native · Rust core · zero runtime dependencies</Reveal>
            <Reveal as="h1" delay={1}>The coding agent that gets <em>out of your way</em>.</Reveal>
            <Reveal as="p" delay={2} className="sub">
              Mochi is a minimal, fast, autonomous coding agent for the terminal. Goals decompose into
              task DAGs, role-diverse teams execute them, a persistent daemon keeps them running, and
              every run replays trace-for-trace — all on 18&nbsp;MB of RAM.
            </Reveal>
            <Reveal as="div" delay={3} className="cta">
              <a className="btn primary" href="docs.html#install">Install</a>
              <a className="btn soft" href="benchmarks.html">Benchmarks</a>
            </Reveal>
          </div>
          <Reveal delay={1} className="hero-art">
            <Sparkle className="s1" />
            <Sparkle className="s2" />
            <Sparkle className="s3" />
            <Mochi size={300} mood="wink" className="bob" />
          </Reveal>
        </div>
      </section>

      <div className="wrap strip">
        {[
          [18.2, 1, ' MB', 'single-session memory · 21× lighter than Claude Code'],
          [38.2, 1, ' ms', 'time to first input · fastest of nine agents tested'],
          [16, 0, '', 'specialized agent roles orchestrated per goal'],
          [30, 0, '+', 'bundled skills covering languages, protocols, workflows'],
        ].map(([num, dec, unit, lbl], i) => (
          <Reveal as="div" className="stat" delay={i} key={i}>
            <div className="num"><CountUp target={num} decimals={dec} suffix={unit} /></div>
            <div className="lbl">{lbl}</div>
          </Reveal>
        ))}
      </div>

      <section className="sec" id="flow">
        <div className="wrap">
          <div className="sec-head"><Reveal as="div">
            <span className="kicker">How a run works</span>
            <h2>From goal to verified trace.</h2>
          </Reveal></div>
          <Reveal delay={1}><Flow /></Reveal>
        </div>
      </section>

      <section className="sec" id="features" style={{ paddingTop: 40 }}>
        <div className="wrap">
          <div className="sec-head"><Reveal as="div">
            <span className="kicker">What's inside</span>
            <h2>A complete harness, not a wrapper.</h2>
            <p>Mochi is built from scratch — no framework, no Electron, no runtime dependencies. Every layer below is clickable: see what it means and exactly how it works.</p>
          </Reveal></div>
          <FeatureGrid />
        </div>
      </section>

      <section className="sec" id="roles" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="sec-head"><Reveal as="div">
            <span className="kicker">Teams</span>
            <h2>Sixteen specialists. One goal.</h2>
            <p><code>mochi team "…"</code> spawns a swarm where every agent has a real job, a scoped tool allowlist, and a model tier matched to the work. Full table in the <a href="docs.html#roles">docs</a>.</p>
          </Reveal></div>
          <div className="grid3">
            {[
              ['reasoning', 'lead / architect / debugger', 'Decompose goals, design contracts, root-cause failures. Read-heavy, decision-heavy, no blind edits.'],
              ['coding', 'coder / devops / frontend / backend', 'Full write access with surgical patch tools, headless test verification, and checkpointed edits.'],
              ['review / fast', 'reviewer / researcher / tester', 'Read-only auditors and fast-tier test engineers — the swarm self-checks before it reports done.'],
            ].map(([k, h, p], i) => (
              <Reveal as="div" className="card" delay={i} key={i}>
                <span className="k">{k}</span>
                <h3><span className="dot"></span>{h}</h3>
                <p>{p}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="sec" id="why" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="sec-head"><Reveal as="div">
            <span className="kicker">Benchmarks</span>
            <h2>Numbers first place in every row.</h2>
            <p>Measured across nine terminal agents — 10 launches per metric, PSS profiling, high-resolution PTY timing. <a href="benchmarks.html">Full methodology →</a></p>
          </Reveal></div>
          <Reveal delay={1}>
            <BenchChart unit="MB" rows={[
              ['Mochi', 18.2, true], ['jcode', 27.8], ['Codex CLI', 140.0],
              ['Cursor Agent', 214.9], ['OpenCode', 371.5], ['Claude Code', 386.6],
            ]} />
          </Reveal>
          <Reveal as="p" delay={2} className="bench-note">PSS memory · 1 active session · lower is better</Reveal>
        </div>
      </section>

      <section className="cta-sec">
        <div className="wrap">
          <Reveal><Mochi size={130} className="bob" /></Reveal>
          <Reveal as="h2" delay={1}>Give your terminal a harness.</Reveal>
          <Reveal as="p" delay={2}>Node 22+ or Bun. Zero runtime dependencies. Under a minute to build.</Reveal>
          <Reveal as="div" delay={3} className="cta" style={{ justifyContent: 'center' }}>
            <a className="btn primary" href="docs.html#install">Get started</a>
            <a className="btn soft" href="source.html">Browse the source</a>
          </Reveal>
        </div>
      </section>
    </>
  );
}
createRoot(document.getElementById('root')).render(<Home />);
