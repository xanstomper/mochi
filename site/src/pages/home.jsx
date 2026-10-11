import { createRoot } from 'react-dom/client';
import Mochi from '../Mascot.jsx';
import Footer from '../Footer.jsx';
import FilmGrain from '../FilmGrain.jsx';
import {
  SplitText, BlurText, AnimatedContent, CountUp,
  ScrollFloat, Magnetic, Marquee2, ScrollProgress,
} from '../anim.jsx';

const STATS = [
  ['18.2 MB', 'resident memory'],
  ['38.2 ms', 'to first input'],
  ['16', 'agent roles'],
  ['0', 'dependencies'],
];

const FLOW = [
  ['01', 'Describe the goal', 'Plain language. Mochi decomposes it into a task DAG automatically.'],
  ['02', 'Specialists pick it up', 'Sixteen focused agent roles — not one generalist — run the tasks, in parallel where possible.'],
  ['03', 'Verify, then ship', 'Every change passes independent verification before it touches your tree. One command to commit.'],
];

function HeroSection() {
  return (
    <section className="hero" id="hero">
      <div className="hero-copy">
        <AnimatedContent direction="bottom" delay={0.1}>
          <div className="hero-eyebrow">
            <span className="sparkle" />
            AUTONOMOUS CODING AGENT FOR THE TERMINAL
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
          text="One binary. Sixteen specialists. Zero dependencies. Mochi turns a plain-language goal into verified, shipped code — 21× lighter than the premium agents."
          className="hero-sub"
          delay={0.8}
          stagger={0.015}
        />
        <AnimatedContent direction="bottom" delay={1.2}>
          <div className="hero-actions">
            <Magnetic strength={0.25}>
              <a href="https://github.com/xanstomper/mochi/releases" className="btn btn-primary" target="_blank" rel="noopener">
                ↓ Download
              </a>
            </Magnetic>
            <Magnetic strength={0.2}>
              <a href="./docs.html" className="btn btn-secondary">
                Read the Docs →
              </a>
            </Magnetic>
          </div>
        </AnimatedContent>
      </div>
      <div className="hero-mascot">
        <AnimatedContent direction="right" delay={0.5} duration={1}>
          <Mochi size={640} />
        </AnimatedContent>
      </div>
    </section>
  );
}

function Ticker() {
  const items = [
    '18.2 MB RESIDENT', '38.2 MS TTFI', '21× LIGHTER', '4.5× FASTER START',
    'ZERO DEPENDENCIES', '1200+ TESTS', 'MIT LICENSED', '727 FILES',
  ];
  return (
    <div className="stats-ticker" aria-hidden="true">
      <div className="ticker-track">
        {[...items, ...items].map((item, i) => (
          <span key={i} className="ticker-item">
            <span className="ticker-dot" />
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function StatsSection() {
  return (
    <section className="section stats-band" id="stats">
      <div className="stats-grid">
        {STATS.map(([val, label], i) => (
          <AnimatedContent key={label} direction="bottom" delay={i * 0.1}>
            <div className="stat">
              <div className="stat-val">
                {val.includes('.') && !val.startsWith('38') ? (
                  <CountUp end={parseFloat(val)} decimals={1} suffix={val.replace(/[0-9.]/g, '')} />
                ) : val === '0' ? (
                  <CountUp end={0} />
                ) : val.includes('ms') ? (
                  <CountUp end={38.2} decimals={1} suffix=" ms" />
                ) : (
                  <CountUp end={parseFloat(val)} decimals={1} suffix={val.replace(/[0-9.]/g, '')} />
                )}
              </div>
              <div className="stat-label">{label}</div>
            </div>
          </AnimatedContent>
        ))}
      </div>
    </section>
  );
}

function FlowSection() {
  return (
    <section className="section" id="flow">
      <ScrollFloat moveDistance={30}>
        <SplitText text="How it works." className="section-title" as="h2" delay={0.2} stagger={0.03} />
      </ScrollFloat>
      <div className="flow-list">
        {FLOW.map(([num, title, desc], i) => (
          <AnimatedContent key={num} direction="left" delay={i * 0.12}>
            <div className="flow-row">
              <div className="flow-num">{num}</div>
              <div>
                <div className="flow-title">{title}</div>
                <div className="flow-desc">{desc}</div>
              </div>
            </div>
          </AnimatedContent>
        ))}
      </div>
    </section>
  );
}

function BenchSection() {
  const mem = [
    { label: 'Mochi', value: 18.2, mochi: true, display: '18.2 MB' },
    { label: 'jcode', value: 27.8, display: '27.8 MB' },
    { label: 'Pi', value: 34.4, display: '34.4 MB' },
    { label: 'Codex CLI', value: 140.0, display: '140 MB' },
    { label: 'Cursor', value: 214.9, display: '214.9 MB' },
    { label: 'OpenCode', value: 371.5, display: '371.5 MB' },
    { label: 'Claude Code', value: 386.6, display: '386.6 MB' },
  ];
  const ttfi = [
    { label: 'Mochi', value: 38.2, mochi: true, display: '38.2 ms' },
    { label: 'jcode', value: 45.4, display: '45.4 ms' },
    { label: 'Pi', value: 52.1, display: '52.1 ms' },
    { label: 'Codex CLI', value: 93.0, display: '93 ms' },
    { label: 'Cursor', value: 121.5, display: '121.5 ms' },
    { label: 'OpenCode', value: 168.3, display: '168.3 ms' },
    { label: 'Claude Code', value: 172.4, display: '172.4 ms' },
  ];
  return (
    <section className="section" id="bench">
      <ScrollFloat moveDistance={30}>
        <SplitText text="Measured, not vibes." className="section-title" as="h2" delay={0.2} stagger={0.03} />
      </ScrollFloat>
      <BlurText
        text="Ten launches against a fixed warm cache. Same machine, same terminal. Process memory and PTY wall-clock timings — full methodology on the benchmarks page."
        className="section-desc"
        delay={0.4}
        stagger={0.015}
      />
      <div className="bench-duo">
        <AnimatedContent direction="left" delay={0.2}>
          <div className="bench-panel">
            <div className="bench-panel-title">Resident memory</div>
            <div className="hbars">
              {mem.map((d, i) => (
                <div key={d.label} className="hrow" style={{ animationDelay: (0.3 + i * 0.08) + 's' }}>
                  <span className={'hlabel' + (d.mochi ? ' is-mochi' : '')}>{d.label}</span>
                  <div className="htrack">
                    <div className={'hfill' + (d.mochi ? ' is-mochi' : '')} style={{ width: (d.value / 400 * 100) + '%' }} />
                  </div>
                  <span className={'hval' + (d.mochi ? ' is-mochi' : '')}>{d.display}</span>
                </div>
              ))}
            </div>
          </div>
        </AnimatedContent>
        <AnimatedContent direction="right" delay={0.3}>
          <div className="bench-panel">
            <div className="bench-panel-title">Time to first input</div>
            <div className="hbars">
              {ttfi.map((d, i) => (
                <div key={d.label} className="hrow" style={{ animationDelay: (0.4 + i * 0.08) + 's' }}>
                  <span className={'hlabel' + (d.mochi ? ' is-mochi' : '')}>{d.label}</span>
                  <div className="htrack">
                    <div className={'hfill' + (d.mochi ? ' is-mochi' : '')} style={{ width: (d.value / 200 * 100) + '%' }} />
                  </div>
                  <span className={'hval' + (d.mochi ? ' is-mochi' : '')}>{d.display}</span>
                </div>
              ))}
            </div>
          </div>
        </AnimatedContent>
      </div>
      <AnimatedContent direction="bottom" delay={0.4}>
        <a href="./benchmarks.html" className="btn btn-secondary" style={{ marginTop: 40 }}>
          Full benchmarks →
        </a>
      </AnimatedContent>
    </section>
  );
}

function CodaSection() {
  return (
    <section className="coda" id="coda">
      <div className="coda-mascot"><Mochi size={240} /></div>
      <AnimatedContent direction="bottom">
        <SplitText text="Ready to build?" as="h2" className="hero-title" delay={0.2} stagger={0.02} />
      </AnimatedContent>
      <BlurText
        text="Download one binary. Give it a goal. Watch it ship."
        className="hero-sub"
        delay={0.5}
      />
      <AnimatedContent direction="bottom" delay={0.7}>
        <div className="coda-actions">
          <Magnetic strength={0.25}>
            <a href="https://github.com/xanstomper/mochi/releases" className="btn btn-primary" target="_blank" rel="noopener">
              ↓ Download
            </a>
          </Magnetic>
          <a href="./docs.html" className="btn btn-outline">
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
      <FilmGrain />
      <ScrollProgress />
      <HeroSection />
      <Ticker />
      <StatsSection />
      <FlowSection />
      <BenchSection />
      <CodaSection />
      <Footer />
    </>
  );
}

const _root = document.getElementById('root');
if (_root) createRoot(_root).render(<Home />);
