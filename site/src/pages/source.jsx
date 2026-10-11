import React from 'react';
import { createRoot } from 'react-dom/client';
import RepoBrowser from '../RepoBrowser.jsx';
import Footer from '../Footer.jsx';
import FilmGrain from '../FilmGrain.jsx';
import { AnimatedContent, ScrollFloat } from '../anim.jsx';

function Source() {
  return (
    <>
      <FilmGrain />
      <div className="pagehead">
        <div className="wrap">
          <AnimatedContent direction="bottom" delay={0.1}>
            <div className="hero-eyebrow">
              <span className="sparkle" />
              SOURCE
            </div>
          </AnimatedContent>
          <ScrollFloat moveDistance={24}>
            <h1 className="pagehead-title">Read every line.</h1>
          </ScrollFloat>
          <AnimatedContent direction="bottom" delay={0.5}>
            <p className="lede" style={{ marginTop: 16, maxWidth: 620 }}>
              MIT licensed, zero dependencies, 727 files — all of it auditable. Browse the live tree below or clone it yourself.
            </p>
            <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
              <a href="https://github.com/xanstomper/mochi" target="_blank" rel="noopener" className="btn btn-dark">
                View on GitHub
              </a>
              <a href="https://github.com/xanstomper/mochi/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener" className="btn btn-outline">
                Contribute →
              </a>
            </div>
          </AnimatedContent>
        </div>
      </div>

      <div className="wrap" style={{ padding: '24px 24px 80px' }}>
        <AnimatedContent direction="bottom" delay={0.2}>
          <div className="rb-window"><RepoBrowser /></div>
        </AnimatedContent>
      </div>

      <Footer />
    </>
  );
}
createRoot(document.getElementById('root')).render(<Source />);
