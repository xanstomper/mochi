import React from 'react';
import { createRoot } from 'react-dom/client';
import RepoBrowser from '../RepoBrowser.jsx';
import Footer from '../Footer.jsx';
import { Marquee, Reveal, AnimatedContent, SplitText } from '../anim.jsx';

const FEATURES = [
  { icon: '🌐', title: 'Open Source', desc: 'Transparent, community-driven, and always open.\u00A0→' },
  { icon: '🤝', title: 'Contribute', desc: 'Help us improve Mochi with code, ideas, and feedback.\u00A0→' },
  { icon: '💬', title: 'Join the Community', desc: 'Get support, share your projects, and connect with other builders.\u00A0→' },
];

function Source() {
  return (
    <>
      <div className="pagehead">
        <div className="wrap">
          <AnimatedContent direction="bottom" delay={0.1}>
            <div className="hero-eyebrow">
              <span className="sparkle" />
              OPEN SOURCE
            </div>
          </AnimatedContent>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
            <div className="pagehead-col">
              <SplitText
                text="Open Source and Always Free."
                className="hero-title pagehead-title"
                as="h1"
                style={{ fontSize: 48, maxWidth: 620 }}
                delay={0.3}
                stagger={0.015}
              />
              <AnimatedContent direction="bottom" delay={0.5}>
                <p className="lede" style={{ marginTop: 16, maxWidth: 560 }}>
                  Mochi is open source. Build, contribute, and make it better together with our community.
                </p>
                <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
                  <a
                    href="https://github.com/xanstomper/mochi"
                    target="_blank"
                    rel="noopener"
                    className="btn btn-dark"
                  >
                    View on GitHub
                  </a>
                  <a
                    href="https://github.com/xanstomper/mochi/blob/main/CONTRIBUTING.md"
                    target="_blank"
                    rel="noopener"
                    className="btn btn-outline"
                  >
                    Contribute →
                  </a>
                </div>
              </AnimatedContent>
            </div>
          </div>
        </div>
      </div>

      <Marquee speed={32} items={['REPO: XANSTOMPER/MOCHI', 'BRANCH: MAIN', 'LIVE FROM GITHUB', 'MIT LICENSE', 'ZERO DEPENDENCIES']} />

      <div className="wrap" style={{ padding: '48px 24px 60px' }}>
        <div className="grid3" style={{ marginBottom: 48 }}>
          {FEATURES.map((f, i) => (
            <Reveal as="div" className="card" delay={i} key={i}>
              <span className="card-icon">{f.icon}</span>
              <h3 className="card-title">{f.title}</h3>
              <p className="card-desc">{f.desc}</p>
            </Reveal>
          ))}
        </div>

        <div className="rb-window"><RepoBrowser /></div>
      </div>

      {/* Dark CTA banner */}
      <div className="wrap" style={{ padding: '0 24px 80px' }}>
        <div style={{
          position: 'relative',
          background: 'linear-gradient(135deg, #1A1633 0%, #2D2460 100%)',
          borderRadius: 28,
          padding: '60px 48px',
          color: '#fff',
          overflow: 'hidden',
        }}>
          <div style={{ maxWidth: 560, position: 'relative', zIndex: 1 }}>
            <h2 style={{ fontSize: 36, fontWeight: 700, marginBottom: 12, color: '#fff' }}>
              Ready to Build with Mochi?
            </h2>
            <p style={{ color: 'rgba(255,255,255,.75)', marginBottom: 28, fontSize: 16 }}>
              Join thousands of developers using Mochi to build faster, smarter, and better.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <a href="https://github.com/xanstomper/mochi/releases" target="_blank" rel="noopener" className="btn btn-primary">
                ↓ Download
              </a>
              <a href="./docs.html" className="btn btn-outline" style={{ borderColor: 'rgba(255,255,255,.3)', color: '#fff' }}>
                Read the Docs →
              </a>
            </div>
          </div>
        </div>
      </div>

      <Footer />
    </>
  );
}
createRoot(document.getElementById('root')).render(<Source />);
