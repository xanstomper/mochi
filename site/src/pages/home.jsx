import { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';
import Footer from '../Footer.jsx';
import { RepoBrowser } from '../RepoBrowser.jsx';
import {
  SplitText, BlurText, AnimatedContent, CountUp,
  ScrollFloat, ShinyText, Magnetic, TiltCard,
  GooeyBorder, Marquee2, ScrollProgress, ScrollVelocity,
  DitherBlock, BenchChart,
} from '../anim.jsx';
import Iridescence from '../Iridescence.jsx';
import '../Iridescence.css';

const STATS = [
  ['18.2 MB', 'RESIDENT MEMORY'],
  ['38.2 ms', 'TO FIRST INPUT'],
  ['16', 'AGENT ROLES'],
  ['31', 'RELEASES SHIPPED'],
];

const TICKER_ITEMS = [
  '18.2 MB RESIDENT', '38.2 MS TTFI', '21× LIGHTER',
  '4.5× FASTER START', '1.6× MORE STABLE', '9 AGENTS TESTED',
  'ZERO DEPS', '727 FILES', '1200 TESTS PASSING',
];

const CAPABILITIES = [
  {
    icon: '⚡', title: 'Zero Dependencies',
    desc: 'Pure TypeScript with no runtime dependencies. The entire orchestrator fits in 18.2 MB — 21× lighter than Claude Code.'
  },
  {
    icon: '🧠', title: '16 Agent Roles',
    desc: 'From code generation to security auditing, Mochi ships 16 specialized agent roles. Each is a focused expert, not a generalist.'
  },
  {
    icon: '🚀', title: '38.2 ms TTFI',
    desc: 'Time to first input is 4.5× faster than premium agents. No cold starts, no lazy loading — instant response from launch.'
  },
  {
    icon: '🔒', title: 'Security Audited',
    desc: 'Every release passes 1200+ tests. Sandboxed execution, input validation, and no telemetry — your code never leaves your machine.'
  },
  {
    icon: '📦', title: 'Single Binary',
    desc: 'One 18.2 MB binary. No npm install, no node_modules, no version hell. Download, chmod, run — that\'s the entire setup.'
  },
  {
    icon: '🌐', title: 'Open Source',
    desc: 'MIT licensed, fully auditable source. 727 files, 886 tree items, every line readable. No black boxes, no magic.'
  },
];

const FLOW_STEPS = [
  { title: 'Describe your task', desc: 'Tell Mochi what to build. Natural language, code snippets, or file paths — it understands all three.' },
  { title: 'Agent decomposition', desc: 'Mochi breaks your request into subtasks and routes each to the optimal specialist agent.' },
  { title: 'Parallel execution', desc: 'Independent tasks run concurrently. Dependent tasks wait. No wasted cycles, no idle time.' },
  { title: 'Review and refine', desc: 'Each output passes through a critic agent before assembly. You review the final result.' },
  { title: 'Ship it', desc: 'Approved code is written to disk with full git integration. One command to commit and push.' },
];

function BackgroundDecor() {
  return (
    <div className="bg-decor" aria-hidden="true">
      <div className="bg-blob bg-blob-1" />
      <div className="bg-blob bg-blob-2" />
      <div className="bg-blob bg-blob-3" />
      <div className="bg-dot bg-dot-1" />
      <div className="bg-dot bg-dot-2" />
      <div className="bg-dot bg-dot-3" />
      <div className="bg-dot bg-dot-4" />
      <div className="bg-sparkle bg-sparkle-1" />
      <div className="bg-sparkle bg-sparkle-2" />
      <div className="bg-sparkle bg-sparkle-3" />
      <div className="bg-sparkle bg-sparkle-4" />
      <div className="bg-sparkle bg-sparkle-5" />
      <div className="bg-sparkle bg-sparkle-6" />
      <div className="bg-wave bg-wave-1" />
      <div className="bg-wave bg-wave-2" />
      <div className="bg-wave bg-wave-3" />
    </div>
  );
}

function HeroSection() {
  return (
    <section className="hero" id="hero">
      <div className="hero-copy">
        <AnimatedContent direction="bottom" delay={0.1}>
          <div className="hero-eyebrow">
            <span className="sparkle" />
            THE NEXT GENERATION AI CODING AGENT
          </div>
        </AnimatedContent>
        <SplitText
          text="A Softer Kind of"
          className="hero-title hero-title-1"
          as="h1"
          delay={0.3}
          stagger={0.02}
        />
        <SplitText
          text="Intelligence."
          className="hero-title accent-title"
          as="h1"
          delay={0.5}
          stagger={0.02}
        />
        <BlurText
          text="A minimal, powerful, and friendly AI coding intelligence. Faster, smarter, and better than your premium coding agents, built to be lightweight, reliable, and resource friendly."
          className="hero-sub"
          delay={0.8}
          stagger={0.015}
        />
        <AnimatedContent direction="bottom" delay={1.2}>
          <div className="hero-actions">
            <Magnetic strength={0.25}>
              <a href="https://github.com/xanstomper/mochi/releases" className="btn btn-primary" target="_blank" rel="noopener">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V13H5V9.3l7-3.11v8.8z"/></svg>
                Download
              </a>
            </Magnetic>
            <Magnetic strength={0.2}>
              <a href="https://github.com/xanstomper/mochi#readme" className="btn btn-secondary" target="_blank" rel="noopener">
                Read the Docs →
              </a>
            </Magnetic>
          </div>
        </AnimatedContent>
      </div>
      <div className="hero-mascot">
        <AnimatedContent direction="right" delay={0.5} duration={1}>
          <Mochi size={520} />
        </AnimatedContent>
      </div>
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10 }}>
        <StatsTicker />
      </div>
    </section>
  );
}

function StatsTicker() {
  return (
    <div className="stats-ticker" aria-hidden="true">
      <div className="ticker-track">
        {[...TICKER_ITEMS, ...TICKER_ITEMS].map((item, i) => (
          <span key={i} className="ticker-item">
            <span className="ticker-dot" />
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function CapabilitiesSection() {
  return (
    <section className="section" id="capabilities">
      <AnimatedContent direction="bottom">
        <div className="section-tag">
          <span className="sparkle" />
          SECTION 02 / WHY MOCHI?
        </div>
      </AnimatedContent>
      <ScrollFloat moveDistance={40}>
        <SplitText
          text="AGENTIC"
          className="section-title"
          as="h2"
          delay={0.2}
          stagger={0.03}
        />
        <SplitText
          text="CAPABILITIES"
          className="section-title accent-title"
          as="h2"
          delay={0.3}
          stagger={0.03}
        />
      </ScrollFloat>
      <svg className="section-arrow" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="7" y1="17" x2="17" y2="7"></line>
        <polyline points="7 7 17 7 17 17"></polyline>
      </svg>
      <BlurText
        text="Six reasons why developers switch to Mochi and never look back."
        className="section-desc"
        delay={0.6}
        stagger={0.02}
      />
      <div className="caps-grid">
        {CAPABILITIES.map((cap, i) => (
          <AnimatedContent key={cap.title} direction="bottom" delay={i * 0.1}>
            <TiltCard max={6}>
              <div className="cap-card">
                <div className="cap-icon">{cap.icon}</div>
                <div className="cap-title">{cap.title}</div>
                <div className="cap-desc">{cap.desc}</div>
              </div>
            </TiltCard>
          </AnimatedContent>
        ))}
      </div>
    </section>
  );
}

function StatsSection() {
  return (
    <section className="section" id="stats">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 20 }}>
        {STATS.map(([val, label], i) => (
          <AnimatedContent key={label} direction="bottom" delay={i * 0.1}>
            <div style={{
              background: 'var(--white)', borderRadius: 16, padding: '28px 24px',
              border: '1px solid var(--hairline-ink)', textAlign: 'center',
            }}>
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 800,
                color: 'var(--ink)', marginBottom: 8,
              }}>
                {val.includes('.') ? (
                  <CountUp end={parseFloat(val)} decimals={1} suffix={val.replace(/[0-9.]/g, '')} />
                ) : (
                  <CountUp end={parseInt(val)} />
                )}
              </div>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 11, textTransform: 'uppercase',
                letterSpacing: '.1em', color: 'var(--ink-soft)',
              }}>
                {label}
              </div>
            </div>
          </AnimatedContent>
        ))}
      </div>
    </section>
  );
}

function FlowSection() {
  return (
    <section className="section" id="flow" style={{ maxWidth: 720 }}>
      <AnimatedContent direction="bottom">
        <div className="section-tag">
          <span className="sparkle" />
          HOW IT WORKS
        </div>
      </AnimatedContent>
      <SplitText text="From prompt to product." className="section-title" as="h2" style={{ fontSize: 36 }} delay={0.2} stagger={0.02} />
      <div style={{ marginTop: 40 }}>
        {FLOW_STEPS.map((step, i) => (
          <AnimatedContent key={step.title} direction="left" delay={i * 0.15}>
            <div className="flow-step">
              <div className="flow-num">{String(i + 1).padStart(2, '0')}</div>
              <div className="flow-content">
                <div className="flow-title">{step.title}</div>
                <div className="flow-desc">{step.desc}</div>
              </div>
            </div>
          </AnimatedContent>
        ))}
      </div>
    </section>
  );
}

function TerminalSection() {
  return (
    <section className="section" id="terminal" style={{ maxWidth: 860 }}>
      <AnimatedContent direction="bottom">
        <div className="section-tag">
          <span className="sparkle" />
          LIVE DEMO
        </div>
      </AnimatedContent>
      <SplitText text="Watch it think." className="section-title" as="h2" style={{ fontSize: 36 }} delay={0.2} stagger={0.02} />
      <AnimatedContent direction="bottom" delay={0.4}>
        <div style={{ marginTop: 32 }}>
          <GooeyBorder>
            <div className="term">
              <div className="term-head">
                <div className="term-dot r" />
                <div className="term-dot y" />
                <div className="term-dot g" />
                <span className="term-title">mochi — zsh</span>
              </div>
              <div className="term-body">
                <div className="term-line">
                  <span className="term-prompt">$</span>
                  <span className="term-text">mochi "build a REST API with auth"</span>
                </div>
                <div className="term-line">
                  <span className="term-comment"># Decomposing into 4 subtasks...</span>
                </div>
                <div className="term-line">
                  <span className="term-keyword">→</span>
                  <span className="term-text">scaffold-express</span>
                  <span className="term-string">[done]</span>
                </div>
                <div className="term-line">
                  <span className="term-keyword">→</span>
                  <span className="term-text">implement-jwt-auth</span>
                  <span className="term-string">[done]</span>
                </div>
                <div className="term-line">
                  <span className="term-keyword">→</span>
                  <span className="term-text">write-tests</span>
                  <span className="term-string">[done]</span>
                </div>
                <div className="term-line">
                  <span className="term-keyword">→</span>
                  <span className="term-text">security-audit</span>
                  <span className="term-string">[done]</span>
                </div>
                <div className="term-line" style={{ marginTop: 12 }}>
                  <span className="term-prompt">$</span>
                  <span className="term-text" style={{ color: '#4ade80' }}>✓ 4/4 tasks complete — 2,847 lines written</span>
                </div>
              </div>
            </div>
          </GooeyBorder>
        </div>
      </AnimatedContent>
    </section>
  );
}

function BenchmarksSection() {
  const memData = [
    { label: 'Mochi', value: 18.2, color: 'purple', display: '18.2 MB' },
    { label: 'jcode', value: 27.8, display: '27.8 MB' },
    { label: 'Pi', value: 34.4, display: '34.4 MB' },
    { label: 'Codex CLI', value: 140.0, display: '140 MB' },
    { label: 'Cursor', value: 214.9, display: '214.9 MB' },
    { label: 'OpenCode', value: 371.5, display: '371.5 MB' },
    { label: 'Claude Code', value: 386.6, display: '386.6 MB' },
  ];
  const ttfiData = [
    { label: 'Mochi', value: 38.2, color: 'purple', display: '38.2 ms' },
    { label: 'jcode', value: 45.4, display: '45.4 ms' },
    { label: 'Pi', value: 52.1, display: '52.1 ms' },
    { label: 'Codex CLI', value: 93.0, display: '93 ms' },
    { label: 'Cursor', value: 121.5, display: '121.5 ms' },
    { label: 'OpenCode', value: 168.3, display: '168.3 ms' },
    { label: 'Claude Code', value: 172.4, display: '172.4 ms' },
  ];

  return (
    <section className="section" id="benchmarks" style={{ maxWidth: 860 }}>
      <AnimatedContent direction="bottom">
        <div className="section-tag">
          <span className="sparkle" />
          RECEIPTS, NOT VIBES
        </div>
      </AnimatedContent>
      <SplitText text="Measured. Verified. Repeated." className="section-title" as="h2" style={{ fontSize: 36 }} delay={0.2} stagger={0.02} />
      <div style={{ marginTop: 40, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 40 }}>
        <AnimatedContent direction="left" delay={0.3}>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ink-soft)', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '.1em' }}>
              Resident Memory (MB)
            </div>
            <BenchChart data={memData} max={400} />
          </div>
        </AnimatedContent>
        <AnimatedContent direction="right" delay={0.4}>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ink-soft)', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '.1em' }}>
              Time to First Input (ms)
            </div>
            <BenchChart data={ttfiData} max={200} />
          </div>
        </AnimatedContent>
      </div>
    </section>
  );
}

function CodaSection() {
  return (
    <section className="coda" id="coda">
      <div style={{ position: 'absolute', right: 20, bottom: -10, opacity: 0.9, pointerEvents: 'none' }}>
        <Mochi size={200} />
      </div>
      <AnimatedContent direction="bottom">
        <SplitText
          text="Ready to Build with Mochi?"
          as="h2"
          className="hero-title"
          delay={0.2}
          stagger={0.02}
        />
      </AnimatedContent>
      <BlurText
        text="Join thousands of developers using Mochi to build faster, smarter, and better."
        className="hero-sub"
        delay={0.5}
      />
      <AnimatedContent direction="bottom" delay={0.7}>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Magnetic strength={0.25}>
            <a href="https://github.com/xanstomper/mochi/releases" className="btn btn-primary" target="_blank" rel="noopener">
              ↓ Download
            </a>
          </Magnetic>
          <a href="./docs.html" className="btn btn-outline" style={{ borderColor: 'rgba(255,255,255,.3)', color: '#fff' }}>
            Read the Docs →
          </a>
        </div>
      </AnimatedContent>
    </section>
  );
}

export default function Home() {
  return (
    <>
      <ScrollProgress />
      <BackgroundDecor />
      <HeroSection />
      <CapabilitiesSection />
      <StatsSection />
      <FlowSection />
      <TerminalSection />
      <BenchmarksSection />
      <CodaSection />
      <Footer />
    </>
  );
}

const _root = document.getElementById('root');
if (_root) createRoot(_root).render(<Home />);
