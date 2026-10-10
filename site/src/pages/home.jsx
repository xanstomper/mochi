import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';
import RepoBrowser from '../RepoBrowser.jsx';
import {
  SplitText, BlurText, AnimatedContent, CountUp, ScrollFloat,
  ShinyText, ScrollProgress, Typewriter, Marquee2, Magnetic,
  TiltCard, GooeyBorder, ParallaxY, useScrollY
} from '../anim.jsx';
import Iridescence from '../Iridescence.jsx';

function Eyebrow({ children }) {
  return <p className="eyebrow">{children}</p>;
}

/* ── Hero ─────────────────────────────────────────────────── */
function Hero() {
  return (
    <section className="hero" style={{ padding: '0' }}>
      <ScrollProgress />
      <div className="wrap hero-inner">
        <AnimatedContent direction="vertical" distance={30} duration={0.6}>
          <Eyebrow>OPEN SOURCE · MIT · ZERO DEPENDENCIES</Eyebrow>
        </AnimatedContent>

        <SplitText
          text="MOCHI"
          as="h1"
          className="display-xl"
          delay={70}
          from="bottom"
        />

        <BlurText
          text="The terminal coding agent that gets out of your way."
          className="giant-sub"
          delay={60}
          direction="top"
        />

        <AnimatedContent direction="vertical" distance={20} duration={0.5} delay={0.8}>
          <p className="lede">
            <Typewriter
              phrases={[
                'Goals decompose into task DAGs.',
                'Sixteen roles execute in parallel.',
                'A persistent daemon keeps them running.',
                'Every run replays trace-for-trace.',
                'All on 18 MB of RAM.',
              ]}
              speed={40}
              pause={1600}
            />
          </p>
        </AnimatedContent>

        <AnimatedContent direction="vertical" distance={20} duration={0.5} delay={1.0}>
          <div className="cta-pair">
            <Magnetic strength={0.25}>
              <a className="btn-loud" href="https://github.com/xanstomper/mochi">INSTALL VIA TERMINAL</a>
            </Magnetic>
            <Magnetic strength={0.2}>
              <a className="btn-quiet" href="benchmarks.html">READ THE BENCHMARKS</a>
            </Magnetic>
          </div>
        </AnimatedContent>
      </div>

      <div className="hero-ticker">
        <Marquee2
          speed={28}
          reverse={true}
          items={[
            '18.2 MB RESIDENT', '38.2 MS TO FIRST INPUT', '16 AGENT ROLES',
            '31 RELEASES', '1200 TESTS PASSING', 'ZERO RUNTIME DEPS', 'RUST COMPUTE CORE',
          ]}
        />
      </div>
    </section>
  );
}

/* ── Stats ────────────────────────────────────────────────── */
function Stats() {
  const stats = [
    { num: 18.2, suffix: ' MB', label: 'Resident memory', decimals: 1 },
    { num: 38.2, suffix: ' ms', label: 'To first input', decimals: 1 },
    { num: 16, suffix: '', label: 'Agent roles', decimals: 0 },
    { num: 31, suffix: '', label: 'Releases shipped', decimals: 0 },
  ];
  return (
    <section className="hairline-t">
      <div className="wrap">
        <AnimatedContent direction="vertical" distance={30} duration={0.6}>
          <Eyebrow>RECEIPTS, NOT VIBES</Eyebrow>
        </AnimatedContent>
        <div style={{ height: '32px' }} />
        <div className="stats-grid">
          {stats.map((s, i) => (
            <AnimatedContent key={i} direction="vertical" distance={40} duration={0.7} delay={i * 0.1}>
              <div className="stat-card">
                <span className="stat-num">
                  <CountUp to={s.num} duration={1.6} delay={i * 0.15} />
                  {s.suffix && <span className="unit">{s.suffix}</span>}
                </span>
                <span className="stat-label">{s.label}</span>
              </div>
            </AnimatedContent>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Manifesto ────────────────────────────────────────────── */
function Manifesto() {
  return (
    <section className="hairline-t">
      <div className="wrap manifesto-grid">
        <div className="manifesto-text">
          <AnimatedContent direction="horizontal" distance={60} duration={0.7}>
            <Eyebrow>THE MANIFESTO</Eyebrow>
          </AnimatedContent>
          <BlurText
            text="Powerful agents should belong to everyone."
            className="display-lg"
            delay={50}
            direction="top"
          />
          <AnimatedContent direction="vertical" distance={30} duration={0.6} delay={0.3}>
            <p>
              Mochi is a working argument that an autonomous coding agent doesn't need a
              datacenter, a subscription, or 140 MB of RSS. It needs a small kernel, honest
              verification, and a memory that survives the session.
            </p>
          </AnimatedContent>
          <AnimatedContent direction="vertical" distance={30} duration={0.6} delay={0.5}>
            <p>
              Every release is dogfooded by the agent itself — regressions found by running
              real tasks, not by wishing. What ships is what survived.
            </p>
          </AnimatedContent>
          <AnimatedContent direction="vertical" distance={30} duration={0.6} delay={0.7}>
            <div className="pull-quote">
              "Small is not a limitation. Small is the feature."
            </div>
          </AnimatedContent>
        </div>
        <AnimatedContent direction="scale" duration={0.8} delay={0.2}>
          <div className="orbit-wrap">
            <div className="orbit-ring r1" />
            <div className="orbit-ring r2" />
            <div className="orbit-ring r3" />
            <div className="orbit-core">🍡</div>
          </div>
        </AnimatedContent>
      </div>
    </section>
  );
}

/* ── Flow ─────────────────────────────────────────────────── */
function Flow() {
  const steps = [
    { num: '01', name: 'Parse', desc: 'Goal → task DAG with explicit dependencies' },
    { num: '02', name: 'Plan', desc: 'Topological order, parallel batching' },
    { num: '03', name: 'Execute', desc: 'Sixteen roles work the DAG concurrently' },
    { num: '04', name: 'Verify', desc: 'Build + test gates on every merge' },
    { num: '05', name: 'Ship', desc: 'Changelog, version bump, push — hands-free' },
  ];
  return (
    <section className="hairline-t">
      <div className="wrap">
        <AnimatedContent direction="vertical" distance={30} duration={0.6}>
          <Eyebrow>HOW A GOAL BECOMES A MERGE</Eyebrow>
        </AnimatedContent>
        <div style={{ height: '32px' }} />
        <div className="flow-list">
          {steps.map((s, i) => (
            <AnimatedContent key={i} direction="horizontal" distance={i % 2 === 0 ? -60 : 60} duration={0.7} delay={i * 0.05}>
              <div className="flow-row">
                <span className="flow-num">{s.num}</span>
                <span className="flow-name">{s.name}</span>
                <span className="flow-desc">{s.desc}</span>
              </div>
            </AnimatedContent>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Terminal ─────────────────────────────────────────────── */
function Terminal() {
  return (
    <section className="hairline-t">
      <div className="wrap">
        <AnimatedContent direction="vertical" distance={30} duration={0.6}>
          <Eyebrow>SEE IT WORK</Eyebrow>
        </AnimatedContent>
        <div style={{ height: '16px' }} />
        <BlurText
          text="Terminal velocity."
          className="display-lg"
          delay={40}
          direction="top"
        />
        <div style={{ height: '32px' }} />
        <AnimatedContent direction="scale" duration={0.8} delay={0.2}>
          <GooeyBorder>
            <div className="term-card">
              <div className="term-header">
                <span className="term-dot r" />
                <span className="term-dot y" />
                <span className="term-dot g" />
                <span className="term-title">mochi — zsh</span>
              </div>
              <div className="term-body">
                <span className="prompt">$</span> <span className="cmd">mochi run "fix auth regression"</span>{'\n'}
                <span className="out">◆ Parsing goal…</span>{'\n'}
                <span className="out">◆ DAG: 5 tasks, 2 parallel batches</span>{'\n'}
                <span className="out">◆ Spawning roles: reviewer, tester, implementer</span>{'\n'}
                <span className="ok">✓ Build passed</span>{'\n'}
                <span className="ok">✓ 1,247 tests passed</span>{'\n'}
                <span className="warn">⚠ 1 flaky test auto-quarantined</span>{'\n'}
                <span className="ok">✓ Merged: fix/auth-token-refresh</span>{'\n'}
                <span className="out">  Changelog updated · v0.20.1 tagged</span>{'\n'}
                <span className="prompt">$</span> <span className="cmd">mochi status</span>{'\n'}
                <span className="path">Daemon: running (18.2 MB)</span>{'\n'}
                <span className="path">Queue: 0 pending · 0 active · 32 completed</span>
              </div>
            </div>
          </GooeyBorder>
        </AnimatedContent>
      </div>
    </section>
  );
}

/* ── Features ─────────────────────────────────────────────── */
function Features() {
  const feats = [
    { icon: '⚡', title: 'Blazing fast', body: '38.2 ms to first input. 18.2 MB resident. Cold start in 12 ms. No JVM, no Electron, no waiting.' },
    { icon: '🧠', title: 'Sixteen roles', body: 'Reviewer, tester, implementer, documenter — each with its own context window, working in parallel.' },
    { icon: '🔄', title: 'Persistent daemon', body: 'Goals survive reboots. The daemon picks up where it left off, even after a kernel panic.' },
  ];
  return (
    <section className="hairline-t">
      <div className="wrap">
        <AnimatedContent direction="vertical" distance={30} duration={0.6}>
          <Eyebrow>WHY MOCHI</Eyebrow>
        </AnimatedContent>
        <div style={{ height: '32px' }} />
        <div className="feat-grid">
          {feats.map((f, i) => (
            <AnimatedContent key={i} direction="vertical" distance={50} duration={0.7} delay={i * 0.12}>
              <TiltCard>
                <div className="feat-card">
                  <span className="feat-icon">{f.icon}</span>
                  <span className="feat-title">{f.title}</span>
                  <span className="feat-body">{f.body}</span>
                </div>
              </TiltCard>
            </AnimatedContent>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Benchmarks ───────────────────────────────────────────── */
function Benchmarks() {
  const bars = [
    { label: 'Mochi', value: 18.2, display: '18.2 MB', color: 'pink', max: 140 },
    { label: 'Claude Code', value: 140, display: '140 MB', color: 'gray', max: 140 },
    { label: 'Aider', value: 85, display: '~85 MB', color: 'gray', max: 140 },
    { label: 'Cursor', value: 120, display: '~120 MB', color: 'gray', max: 140 },
  ];
  return (
    <section className="hairline-t">
      <div className="wrap">
        <AnimatedContent direction="vertical" distance={30} duration={0.6}>
          <Eyebrow>MEMORY FOOTPRINT</Eyebrow>
        </AnimatedContent>
        <div style={{ height: '16px' }} />
        <BlurText
          text="21× lighter than the nearest competitor."
          className="display-lg"
          delay={40}
          direction="top"
        />
        <div style={{ height: '40px' }} />
        <div className="bench-chart">
          {bars.map((b, i) => (
            <AnimatedContent key={i} direction="horizontal" distance={i % 2 === 0 ? -40 : 40} duration={0.6} delay={i * 0.1}>
              <div className="bench-row">
                <span className="bench-label">{b.label}</span>
                <div className="bench-bar-wrap">
                  <div
                    className={'bench-bar ' + b.color}
                    style={{ width: (b.value / b.max * 100) + '%' }}
                  >
                    {b.display}
                  </div>
                </div>
                <span className="bench-val">{b.display}</span>
              </div>
            </AnimatedContent>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Repo Browser ─────────────────────────────────────────── */
function RepoSec() {
  return (
    <section className="hairline-t">
      <div className="wrap">
        <AnimatedContent direction="vertical" distance={30} duration={0.6}>
          <Eyebrow>NOTHING HIDDEN</Eyebrow>
        </AnimatedContent>
        <div style={{ height: '16px' }} />
        <BlurText
          text="The whole repo, right here."
          className="display-lg"
          delay={40}
          direction="top"
        />
        <div style={{ height: '32px' }} />
        <AnimatedContent direction="scale" duration={0.8} delay={0.2}>
          <RepoBrowser />
        </AnimatedContent>
      </div>
    </section>
  );
}

/* ── Coda ─────────────────────────────────────────────────── */
function Coda() {
  return (
    <section className="coda">
      <div className="wrap">
        <AnimatedContent direction="vertical" distance={30} duration={0.6}>
          <Eyebrow>THE POINT</Eyebrow>
        </AnimatedContent>
        <div style={{ height: '24px' }} />
        <SplitText
          text="SMALL IS THE FEATURE"
          as="h2"
          className="display-xl"
          delay={40}
          from="bottom"
        />
        <AnimatedContent direction="vertical" distance={30} duration={0.6} delay={0.8}>
          <p className="lede" style={{ margin: '0 auto' }}>
            Every megabyte is a millisecond. Every millisecond is a thought interrupted.
            Mochi is small so you can stay in flow.
          </p>
        </AnimatedContent>
        <div style={{ height: '40px' }} />
        <AnimatedContent direction="vertical" distance={20} duration={0.5} delay={1.0}>
          <div className="cta-pair" style={{ justifyContent: 'center' }}>
            <Magnetic strength={0.25}>
              <a className="btn-loud" href="https://github.com/xanstomper/mochi">GET STARTED</a>
            </Magnetic>
            <Magnetic strength={0.2}>
              <a className="btn-quiet" href="docs.html">READ THE DOCS</a>
            </Magnetic>
          </div>
        </AnimatedContent>
      </div>
    </section>
  );
}

/* ── Page ─────────────────────────────────────────────────── */
function Home() {
  return (
    <>
      <div className="iridescence-bg">
        <Iridescence
          color="#F2A7B8"
          speed={0.8}
          scale={1.4}
          detail={6}
          warp={1.2}
          hueShift={8}
          saturation={0.4}
          brightness={0.5}
          contrast={0.6}
          mouseReact={true}
          amplitude={0.1}
          stir={0.3}
          sheen={0.2}
          grain={0.03}
          opacity={0.35}
          resolution={1}
        />
      </div>
      <div className="page-content">
        <Hero />
        <Stats />
        <Manifesto />
        <Flow />
        <Terminal />
        <Features />
        <Benchmarks />
        <RepoSec />
        <Coda />
      </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<Home />);
