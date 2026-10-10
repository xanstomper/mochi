import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';
import { Reveal, CountUp, SplitText, useParallax, DitherBlock, Marquee2, GooeyBorder, Typewriter, TiltCard, ScrollProgress, Magnetic, SlideIn, SlideAlternate } from '../anim.jsx';
import Iridescence from '../Iridescence.jsx';
import RepoBrowser from '../RepoBrowser.jsx';

const EYEBROW = ({ children }) => <div className="eyebrow">{children}</div>;

function Hero() {
  return (
    <section className="hero2">
      <ScrollProgress />
      <div className="bg-blob b1" />
      <div className="bg-blob b2" />
      <div className="wrap">
        <EYEBROW>OPEN SOURCE • MIT • 0 DEPENDENCIES</EYEBROW>
        <h1 className="giant">
          <SplitText text="MOCHI" />
        </h1>
        <p className="giant-sub" style={{marginBottom:16}}>
          <span className="gi">The terminal coding agent</span><br />
          <span className="gi pink">that gets out of your way.</span>
        </p>
        <p className="lede" style={{marginBottom:24}}>
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
        <div className="cta-pair">
          <Magnetic strength={0.25}>
            <a className="btn-loud" href="https://github.com/xanstomper/mochi">INSTALL VIA TERMINAL</a>
          </Magnetic>
          <Magnetic strength={0.2}>
            <a className="btn-quiet" href="benchmarks.html">READ THE BENCHMARKS</a>
          </Magnetic>
        </div>
      </div>
      <Marquee2
        speed={24}
        items={[
          '18.2 MB RESIDENT', '38.2 MS TO FIRST INPUT', '16 AGENT ROLES',
          '31 RELEASES', '1200 TESTS PASSING', 'ZERO RUNTIME DEPS', 'RUST COMPUTE CORE',
        ]}
      />
      <div className="hero-visual"><Reveal className="dither-reveal"><DitherBlock height={380} /></Reveal></div>
    </section>
  );
}

function Stat({ n, d, dec = 0, suffix = '', label, note }) {
  return (
    <Reveal className="gstat">
      <div className="gstat-n"><CountUp target={n} decimals={dec} suffix={suffix} /></div>
      <div className="gstat-label">{label}</div>
      <div className="gstat-note">{note}</div>
      <div className="gstat-d">{d}</div>
    </Reveal>
  );
}

function Numbers() {
  return (
    <section className="gnums">
      <div className="wrap">
        <EYEBROW>RECEIPTS, NOT VIBES</EYEBROW>
        <SlideAlternate className="gstat-grid" itemClass="gstat" items={[
          <><div className="gstat-n"><CountUp target={18.2} decimals={1} suffix=" MB" /></div><div className="gstat-label">RESIDENT MEMORY</div><div className="gstat-note">single session</div><div className="gstat-d">21× lighter than Claude Code — measured, not claimed</div></>,
          <><div className="gstat-n"><CountUp target={38.2} decimals={1} suffix=" ms" /></div><div className="gstat-label">TIME TO FIRST INPUT</div><div className="gstat-note">cold start</div><div className="gstat-d">fastest of nine agents tested, same task set</div></>,
          <><div className="gstat-n"><CountUp target={16} /></div><div className="gstat-label">AGENT ROLES</div><div className="gstat-note">orchestrated per goal</div><div className="gstat-d">planner, builder, verifier, critic, memory, and more</div></>,
          <><div className="gstat-n"><CountUp target={1200} suffix="+" /></div><div className="gstat-label">TESTS PASSING</div><div className="gstat-note">0 failing</div><div className="gstat-d">real integration tests against live providers</div></>,
        ]} />
      </div>
    </section>
  );
}

function Manifest() {
  const ref = useParallax(40);
  return (
    <section className="manifest">
      <div className="wrap manifest-grid">
        <Reveal as="div" className="manifest-copy">
          <GooeyBorder className="manifest-gooey" speed={6} thickness={2}>
            <div className="manifest-inner">
              <EYEBROW>THE POINT</EYEBROW>
          <SlideIn from="left"><h2 className="big2">Powerful agents should belong to everyone.</h2></SlideIn>
          <p>
            Mochi is a working argument that an autonomous coding agent doesn't need a
            datacenter, a subscription, or 140 MB of RSS. It needs a small kernel, honest
            verification, and a memory that survives the session.
          </p>
          <p>
            Every release is dogfooded by the agent itself — regressions found by running
            real tasks, not by wishing. What ships is what survived.
          </p>
              <a className="btn-quiet" href="docs.html">READ THE DOCS →</a>
            </div>
          </GooeyBorder>
        </Reveal>
        <div className="manifest-visual">
          <div className="mochi-orbit" ref={ref}>
            <Mochi size={300} className="bob" />
          </div>
          <div className="orbit-ring r1" />
          <div className="orbit-ring r2" />
        </div>
      </div>
    </section>
  );
}

function Flow() {
  const steps = [
    ['01', 'GOAL', 'You describe the outcome. Plain language, no ceremony.'],
    ['02', 'DAG', 'Mochi decomposes it into a dependency graph of concrete tasks.'],
    ['03', 'TEAM', 'Sixteen specialized roles pick up tasks in parallel — planner, builder, verifier, critic.'],
    ['04', 'VERIFY', 'Every artifact is re-checked against the filesystem, independent of the builder\'s claims.'],
    ['05', 'REPLAY', 'The whole run persists trace-for-trace. Rewind, inspect, resume.'],
  ];
  return (
    <section className="flow2">
      <div className="wrap">
        <EYEBROW>HOW A GOAL BECOMES A MERGE</EYEBROW>
        {steps.map(([n, t, d], i) => (
          <SlideIn key={n} from={i % 2 === 0 ? 'left' : 'right'} delay={i * 60} className={'flow-row' + (i < steps.length - 1 ? ' ruled' : '')}>
            <span className="flow-n">{n}</span>
            <span className="flow-t">{t}</span>
            <span className="flow-d">{d}</span>
          </SlideIn>
        ))}
      </div>
    </section>
  );
}

function Screens() {
  return (
    <section className="screens">
      <div className="wrap">
        <EYEBROW>THE SURFACE</EYEBROW>
        <SlideIn from="left"><h2 className="big2">Terminal velocity.</h2></SlideIn>
        <SlideIn from="right" delay={80}><p className="lede" style={{marginBottom:24}}>A 60 fps TUI with streaming diffs, live task trees, and zero flicker. Runs over SSH. Runs in tmux. Runs on your phone's SSH client at 2 a.m.</p></SlideIn>
        <TiltCard max={3}>
        <div className="term2">
          <div className="term2-bar"><i /><i /><i /><span>mochi — zsh — 80×24</span></div>
          <pre className="term2-body"><span className="t-dim">$</span> mochi "migrate auth to passkeys, keep tests green"
<span className="t-pink">◆ planning</span> 3 tasks · 2 parallel tracks
<span className="t-dim">│</span> <span className="t-dim">t1</span> inventory credential flows … <span className="t-green">✓ 412 ms</span>
<span className="t-dim">│</span> <span className="t-dim">t2</span> add passkey registration route … <span className="t-green">✓ 1.9 s</span>
<span className="t-dim">│</span> <span className="t-dim">t3</span> migrate session store … <span className="t-amber">◐ verifying</span>
<span className="t-pink">◆ verification</span> 1200 passed · 0 failed
<span className="t-green">✓ done</span> — replay: <span className="t-dim">.mochi/runs/2026-10-10T14:32Z</span></pre>
        </div>
        </TiltCard>
        <div className="tri">
          <SlideIn from="left" className="tri-card"><div className="tri-k">TUI</div><h3>Terminal Velocity</h3><p>Streaming everything. Keyboard-first. 60 fps.</p><a href="docs.html">INSTALL VIA TERMINAL →</a></SlideIn>
          <SlideIn from="right" delay={80} className="tri-card"><div className="tri-k">DAEMON</div><h3>Runs While You Sleep</h3><p>A persistent daemon executes long goals across sessions and resumes cleanly.</p><a href="docs.html">MEET THE DAEMON →</a></SlideIn>
          <SlideIn from="left" delay={160} className="tri-card"><div className="tri-k">MEMORY</div><h3>Learns Your Codebase</h3><p>Procedural memory persists what worked. Every session starts smarter than the last.</p><a href="docs.html">HOW MEMORY WORKS →</a></SlideIn>
        </div>
      </div>
    </section>
  );
}

function RepoSec() {
  return (
    <section className="reposec" id="repo">
      <div className="wrap">
        <EYEBROW>NOTHING HIDDEN</EYEBROW>
        <h2 className="big2">The whole repo, right here.</h2>
        <p className="lede" style={{marginBottom:24}}>Every file, readable without leaving the page. This is the actual main branch, fetched live.</p>
      </div>
      <div className="wrap rb-window"><RepoBrowser compact /></div>
    </section>
  );
}

function Coda() {
  return (
    <section className="coda">
      <DitherBlock height={300} from="#4E372C" to="#F2A7B8" />
      <div className="wrap coda-inner">
        <h2 className="giant2"><SplitText text="SMALL IS THE FEATURE" /></h2>
        <div className="cta-pair center">
          <Magnetic strength={0.25}>
            <a className="btn-loud" href="https://github.com/xanstomper/mochi">STAR ON GITHUB</a>
          </Magnetic>
          <Magnetic strength={0.2}>
            <a className="btn-quiet invert" href="changelog.html">31 RELEASES AND COUNTING</a>
          </Magnetic>
        </div>
      </div>
    </section>
  );
}

function Home() {
  return (
    <>
      <div className="iridescence-bg" aria-hidden="true">
        <Iridescence
          color="#F2A7B8"
          speed={1.5}
          scale={0.9}
          detail={10}
          warp={2.0}
          hueShift={40}
          saturation={2.0}
          brightness={1.6}
          contrast={1.6}
          mouseReact={true}
          amplitude={0.2}
          stir={0.7}
          sheen={0.5}
          clickSwirl={true}
          grain={0.08}
          opacity={1}
          resolution={0.75}
        />
      </div>
      <div className="iridescence-veil" aria-hidden="true" />
      <Hero />
      <Numbers />
      <Manifest />
      <Flow />
      <Screens />
      <RepoSec />
      <Coda />
    </>
  );
}
createRoot(document.getElementById('root')).render(<Home />);
