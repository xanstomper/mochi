import React from 'react';
import { createRoot } from 'react-dom/client';
import RepoBrowser from '../RepoBrowser.jsx';
import Mochi from '../Mascot.jsx';
import Footer from '../Footer.jsx';
import EngineeringGridBackground from '../EngineeringGridBackground.jsx';
import { AnimatedContent } from '../anim.jsx';
import { IconGlobe, IconUsers, IconMessageSquare } from '../icons.jsx';

const FEATURES = [
  {
    icon: IconGlobe,
    title: 'Open Source & Permissive',
    desc: 'Transparent, community-driven, and released under the MIT license. Audit every line of Rust and TypeScript on GitHub.',
    link: 'https://github.com/xanstomper/mochi',
  },
  {
    icon: IconUsers,
    title: 'Contribution Guidelines',
    desc: 'Help us improve Mochi with code, documentation, benchmarks, and community feedback. Strict CI/CD quality gates.',
    link: 'https://github.com/xanstomper/mochi/blob/main/CONTRIBUTING.md',
  },
  {
    icon: IconMessageSquare,
    title: 'Community Discussions',
    desc: 'Get support, share workflows, propose skills, and connect with thousands of terminal agent developers.',
    link: 'https://github.com/xanstomper/mochi/discussions',
  },
];

const TELEMETRY_BLOCKS = [
  { val: '727', label: 'SOURCE FILES AUDITED', desc: 'Zero dead code or dangling unused dependencies' },
  { val: '1,459', label: 'TESTS PASSING', desc: 'Vitest, unit, and headless integration tests passing (100%)' },
  { val: '0', label: 'RUNTIME DEPENDENCIES', desc: 'Single self-contained Bun executable with Rust core' },
  { val: 'MIT', label: 'OPEN SOURCE LICENSE', desc: 'Free for personal, academic, and commercial use' },
];

export default function Source() {
  const base = typeof window !== 'undefined' && window.location.pathname.startsWith('/mochi') ? '/mochi' : '';

  return (
    <>
      <EngineeringGridBackground />
      <div className="pagehead">
        <div className="wrap" style={{ maxWidth: 1560, width: '100%' }}>
          <div className="pagehead-row">
            <div className="pagehead-col">
              <AnimatedContent direction="bottom" delay={0.1}>
                <div className="hero-eyebrow">
                  <span className="sparkle" />
                  OPEN SOURCE & TRANSPARENT
                </div>
              </AnimatedContent>

              <h1 className="hero-title">
                Open Source <span className="accent-title">and Always Free.</span>
              </h1>

              <AnimatedContent direction="bottom" delay={0.2}>
                <p className="hero-sub" style={{ maxWidth: 640 }}>
                  Mochi is 100% open source under the MIT license. Explore the live interactive repository tree, inspect our pure-Rust core tokenizer, or contribute pull requests to the project.
                </p>
              </AnimatedContent>

              <AnimatedContent direction="bottom" delay={0.3}>
                <div className="hero-actions" style={{ marginTop: 24 }}>
                  <a
                    href="https://github.com/xanstomper/mochi"
                    target="_blank"
                    rel="noopener"
                    className="btn btn-primary"
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                    </svg>
                    View on GitHub
                  </a>
                  <a
                    href="https://github.com/xanstomper/mochi/blob/main/CONTRIBUTING.md"
                    target="_blank"
                    rel="noopener"
                    className="btn btn-secondary"
                  >
                    Contribute →
                  </a>
                </div>
              </AnimatedContent>
            </div>

            {/* Custom Source Mascot: Community Builder Mochi with open-source heart & git node */}
            <AnimatedContent direction="right" delay={0.2}>
              <div className="subpage-mascot-wrap">
                <div className="subpage-doodle">built by the community ♡</div>
                <div style={{ position: 'relative' }}>
                  <span className="heart-doodle">♡</span>
                  <Mochi variant="source" size={360} />
                </div>
              </div>
            </AnimatedContent>
          </div>

          {/* 3 Cards */}
          <div className="grid3" style={{ marginTop: 44, marginBottom: 48 }}>
            {FEATURES.map((f, i) => {
              const IconComp = f.icon;
              return (
                <AnimatedContent key={f.title} direction="bottom" delay={i * 0.08}>
                  <a
                    href={f.link}
                    target="_blank"
                    rel="noopener"
                    className="card"
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    <div className="card-icon-box">
                      <IconComp size={22} />
                    </div>
                    <h3 className="card-title">
                      <span>{f.title}</span>
                      <span className="card-arrow">↗</span>
                    </h3>
                    <p className="card-desc">{f.desc}</p>
                  </a>
                </AnimatedContent>
              );
            })}
          </div>

          {/* Repository Telemetry Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 52 }}>
            {TELEMETRY_BLOCKS.map((b, i) => (
              <AnimatedContent key={b.label} direction="bottom" delay={i * 0.06}>
                <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px 20px', border: '1.5px solid var(--line)', textAlign: 'center', boxShadow: 'var(--shadow-card)' }}>
                  <div style={{ fontSize: 36, fontWeight: 800, color: 'var(--purple-dark)', marginBottom: 4 }}>
                    {b.val}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>
                    {b.label}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                    {b.desc}
                  </div>
                </div>
              </AnimatedContent>
            ))}
          </div>

          {/* Live Interactive Repo Browser */}
          <AnimatedContent direction="bottom" delay={0.2}>
            <div style={{ marginBottom: 80 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                <div>
                  <h3 style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)', margin: 0 }}>
                    Live Repository Explorer
                  </h3>
                  <p style={{ fontSize: 14, color: 'var(--ink-soft)', margin: '4px 0 0' }}>
                    Browse source files and explore core architecture directly from GitHub main.
                  </p>
                </div>
                <span className="doc-search-badge">xanstomper/mochi</span>
              </div>
              <RepoBrowser />
            </div>
          </AnimatedContent>
        </div>
      </div>

      <Footer />
    </>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<Source />);
}
