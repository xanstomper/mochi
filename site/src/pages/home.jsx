import { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';
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

function SkyBackground() {
  return (
    <div className="sky-bg" aria-hidden="true">
      <div className="sky-glow sky-glow-1" />
      <div className="sky-glow sky-glow-2" />
      <div className="sky-glow sky-glow-3" />
      <div className="sky-glow sky-glow-4" />
      {/* Cloud layers */}
      <div className="cloud-layer cloud-back">
        <svg viewBox="0 0 1440 200" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
          <path d="M0,120 C200,80 400,140 600,110 C800,80 1000,130 1200,100 C1300,90 1400,110 1440,100 L1440,200 L0,200 Z" fill="rgba(255,255,255,.15)" />
          <path d="M0,150 C300,120 500,170 700,140 C900,110 1100,160 1300,130 C1380,120 1420,140 1440,130 L1440,200 L0,200 Z" fill="rgba(255,255,255,.1)" />
        </svg>
      </div>
      <div className="cloud-layer cloud-mid">
        <svg viewBox="0 0 1440 200" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
          <ellipse cx="200" cy="160" rx="150" ry="40" fill="rgba(255,255,255,.2)" />
          <ellipse cx="500" cy="170" rx="180" ry="35" fill="rgba(255,255,255,.18)" />
          <ellipse cx="800" cy="155" rx="160" ry="42" fill="rgba(255,255,255,.22)" />
          <ellipse cx="1100" cy="165" rx="170" ry="38" fill="rgba(255,255,255,.2)" />
          <ellipse cx="1350" cy="160" rx="140" ry="35" fill="rgba(255,255,255,.18)" />
        </svg>
      </div>
      <div className="cloud-layer cloud-front">
        <svg viewBox="0 0 1440 200" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
          <ellipse cx="100" cy="180" rx="120" ry="30" fill="rgba(255,255,255,.35)" />
          <ellipse cx="350" cy="185" rx="140" ry="28" fill="rgba(255,255,255,.32)" />
          <ellipse cx="600" cy="175" rx="130" ry="32" fill="rgba(255,255,255,.38)" />
          <ellipse cx="850" cy="182" rx="150" ry="30" fill="rgba(255,255,255,.35)" />
          <ellipse cx="1100" cy="178" rx="135" ry="32" fill="rgba(255,255,255,.38)" />
          <ellipse cx="1350" cy="183" rx="125" ry="28" fill="rgba(255,255,255,.35)" />
        </svg>
      </div>
    </div>
  );
}

function FloatingDecorations() {
  return (
    <div className="deco-layer" aria-hidden="true">
      <div className="deco deco-star" style={{ top: '15%', left: '8%', animationDelay: '0s' }} />
      <div className="deco deco-star cyan" style={{ top: '25%', right: '12%', animationDelay: '1s' }} />
      <div className="deco deco-star purple" style={{ top: '60%', left: '5%', animationDelay: '2s' }} />
      <div className="deco deco-sparkle" style={{ top: '10%', right: '30%', animationDelay: '.5s' }} />
      <div className="deco deco-sparkle" style={{ top: '40%', left: '15%', animationDelay: '1.5s' }} />
      <div className="deco deco-sparkle" style={{ top: '70%', right: '8%', animationDelay: '2.5s' }} />
      <div className="deco deco-bubble" style={{ top: '30%', left: '3%', animationDelay: '0s' }} />
      <div className="deco deco-bubble small" style={{ top: '50%', right: '5%', animationDelay: '1.5s' }} />
      <div className="deco deco-bubble large" style={{ top: '65%', left: '10%', animationDelay: '3s' }} />
      <div className="deco deco-bubble small" style={{ top: '20%', right: '25%', animationDelay: '2s' }} />
      <div className="deco deco-sprinkle pink" style={{ top: '35%', left: '20%', animationDelay: '0s' }} />
      <div className="deco deco-sprinkle yellow" style={{ top: '55%', right: '18%', animationDelay: '1s' }} />
      <div className="deco deco-sprinkle cyan" style={{ top: '45%', left: '8%', animationDelay: '2s' }} />
      <div className="deco deco-sprinkle purple" style={{ top: '25%', right: '8%', animationDelay: '.5s' }} />
      <div className="deco deco-sprinkle pink" style={{ top: '75%', right: '30%', animationDelay: '1.5s' }} />
    </div>
  );
}

function HeroSection() {
  return (
    <section className="hero" id="hero">
      <div className="hero-copy">
        <AnimatedContent direction="bottom" delay={0.1}>
          <div className="hero-eyebrow">Minimal Orchestrative Coding Intelligence</div>
        </AnimatedContent>
        <SplitText
          text="A SOFTER KIND OF INTELLIGENCE."
          className="hero-title"
          as="h1"
          delay={0.3}
          stagger={0.02}
        />
        <BlurText
          text="A Minimal Orchestrative Coding Intelligence, faster and better than your premium coding agents, highly capable of heavy task while being resource friendly."
          className="hero-sub"
          delay={0.8}
          stagger={0.015}
        />
        <AnimatedContent direction="bottom" delay={1.2}>
          <div className="hero-actions">
            <Magnetic strength={0.25}>
              <a href="https://github.com/xanstomper/mochi/releases" className="btn btn-primary" target="_blank" rel="noopener">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V13H5V9.3l7-3.11v8.8z"/></svg>
                DOWNLOAD
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
          <div className="mascot-bubble">
            <div className="mascot-leaf" />
            <div className="mascot-face">
              <div className="mascot-eyes">
                <div className="mascot-eye" />
                <div className="mascot-eye" />
              </div>
              <div className="mascot-cheeks">
                <div className="mascot-cheek" />
                <div className="mascot-cheek" />
              </div>
            </div>
            <div className="mascot-platform" />
          </div>
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
    <section className="cream-section" id="capabilities">
      <div style={{ maxWidth: 1120, margin: '0 auto', padding: '80px 5vw' }}>
        <AnimatedContent direction="bottom">
          <div className="section-tag">SECTION 02 / WHY MOCHI?</div>
        </AnimatedContent>
        <ScrollFloat moveDistance={40}>
          <SplitText
            text="AGENTIC CAPABILITIES"
            className="section-title"
            as="h2"
            delay={0.2}
            stagger={0.03}
          />
        </ScrollFloat>
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
      </div>
    </section>
  );
}

function StatsSection() {
  return (
    <section id="stats" style={{ maxWidth: 1120, margin: '0 auto', padding: '60px 5vw' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 20 }}>
        {STATS.map(([val, label], i) => (
          <AnimatedContent key={label} direction="bottom" delay={i * 0.1}>
            <div style={{
              background: 'rgba(255,255,255,.06)', borderRadius: 16, padding: '28px 24px',
              border: '1px solid rgba(255,255,255,.1)', textAlign: 'center',
              backdropFilter: 'blur(10px)',
            }}>
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 700,
                color: 'var(--white)', marginBottom: 8,
              }}>
                {val.includes('.') ? (
                  <CountUp end={parseFloat(val)} decimals={1} suffix={val.replace(/[0-9.]/g, '')} />
                ) : (
                  <CountUp end={parseInt(val)} />
                )}
              </div>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 11, textTransform: 'uppercase',
                letterSpacing: '.1em', color: 'rgba(255,255,255,.5)',
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
    <section id="flow" style={{ maxWidth: 720, margin: '0 auto', padding: '60px 5vw' }}>
      <AnimatedContent direction="bottom">
        <div className="hero-eyebrow">HOW IT WORKS</div>
      </AnimatedContent>
      <SplitText text="From prompt to product." className="hero-title" as="h2" style={{ fontSize: 36 }} delay={0.2} stagger={0.02} />
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
    <section id="terminal" style={{ maxWidth: 860, margin: '0 auto', padding: '60px 5vw' }}>
      <AnimatedContent direction="bottom">
        <div className="hero-eyebrow">LIVE DEMO</div>
      </AnimatedContent>
      <SplitText text="Watch it think." className="hero-title" as="h2" style={{ fontSize: 36 }} delay={0.2} stagger={0.02} />
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
    { label: 'Mochi', value: 18.2, color: 'pink', display: '18.2 MB' },
    { label: 'jcode', value: 27.8, display: '27.8 MB' },
    { label: 'Pi', value: 34.4, display: '34.4 MB' },
    { label: 'Codex CLI', value: 140.0, display: '140 MB' },
    { label: 'Cursor', value: 214.9, display: '214.9 MB' },
    { label: 'OpenCode', value: 371.5, display: '371.5 MB' },
    { label: 'Claude Code', value: 386.6, display: '386.6 MB' },
  ];
  const ttfiData = [
    { label: 'Mochi', value: 38.2, color: 'pink', display: '38.2 ms' },
    { label: 'jcode', value: 45.4, display: '45.4 ms' },
    { label: 'Pi', value: 52.1, display: '52.1 ms' },
    { label: 'Codex CLI', value: 93.0, display: '93 ms' },
    { label: 'Cursor', value: 121.5, display: '121.5 ms' },
    { label: 'OpenCode', value: 168.3, display: '168.3 ms' },
    { label: 'Claude Code', value: 172.4, display: '172.4 ms' },
  ];

  return (
    <section id="benchmarks" style={{ maxWidth: 860, margin: '0 auto', padding: '60px 5vw' }}>
      <AnimatedContent direction="bottom">
        <div className="hero-eyebrow">RECEIPTS, NOT VIBES</div>
      </AnimatedContent>
      <SplitText text="Measured. Verified. Repeated." className="hero-title" as="h2" style={{ fontSize: 36 }} delay={0.2} stagger={0.02} />
      <div style={{ marginTop: 40, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 40 }}>
        <AnimatedContent direction="left" delay={0.3}>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'rgba(255,255,255,.5)', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '.1em' }}>
              Resident Memory (MB)
            </div>
            <BenchChart data={memData} max={400} />
          </div>
        </AnimatedContent>
        <AnimatedContent direction="right" delay={0.4}>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'rgba(255,255,255,.5)', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '.1em' }}>
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
    <section id="coda" style={{
      padding: '120px 5vw', textAlign: 'center',
      background: 'linear-gradient(180deg, transparent, rgba(26,26,110,.3))',
    }}>
      <AnimatedContent direction="bottom">
        <ShinyText>
          <SplitText
            text="SMALL IS THE FEATURE."
            as="h2"
            className="hero-title"
            style={{ fontSize: 'clamp(40px, 6vw, 72px)', marginBottom: 24 }}
            delay={0.2}
            stagger={0.03}
          />
        </ShinyText>
      </AnimatedContent>
      <BlurText
        text="No bloat. No telemetry. No black boxes. Just a small, fast, capable agent that respects your machine and your time."
        className="hero-sub"
        style={{ margin: '0 auto 40px', textAlign: 'center' }}
        delay={0.6}
      />
      <AnimatedContent direction="bottom" delay={0.8}>
        <Magnetic strength={0.25}>
          <a href="https://github.com/xanstomper/mochi/releases" className="btn btn-primary" target="_blank" rel="noopener">
            Get Mochi →
          </a>
        </Magnetic>
      </AnimatedContent>
    </section>
  );
}

export default function Home() {
  return (
    <>
      <ScrollProgress />
      <SkyBackground />
      <FloatingDecorations />
      <HeroSection />
      <CapabilitiesSection />
      <StatsSection />
      <FlowSection />
      <TerminalSection />
      <BenchmarksSection />
      <CodaSection />
    </>
  );
}

const _root = document.getElementById('root');
if (_root) createRoot(_root).render(<Home />);