import React from 'react';

// Site-wide footer — pastel lavender
export default function Footer() {
  const base = typeof window !== 'undefined' && window.location.pathname.startsWith('/mochi') ? '/mochi' : '';
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="footer-grid">
          <div className="footer-col footer-brand">
            <a href={base + '/'} className="footer-logo">mochi<span className="sparkle" /></a>
            <p>A Softer Kind of Intelligence.</p>
          </div>
          <div className="footer-col">
            <h5>Product</h5>
            <a href={base + '/'}>Home</a>
            <a href={base + '/docs.html'}>Docs</a>
            <a href={base + '/benchmarks.html'}>Benchmarks</a>
            <a href={base + '/changelog.html'}>Changelog</a>
            <a href={base + '/source.html'}>Source</a>
          </div>
          <div className="footer-col">
            <h5>Resources</h5>
            <a href="#">Blog</a>
            <a href="#">Community</a>
            <a href="#">Support</a>
            <a href="#">Status</a>
          </div>
          <div className="footer-col">
            <h5>Social</h5>
            <a href="https://x.com/xanstomper" target="_blank" rel="noopener">X (Twitter)</a>
            <a href="#">Discord</a>
            <a href="https://github.com/xanstomper/mochi" target="_blank" rel="noopener">GitHub</a>
            <a href="#">YouTube</a>
          </div>
          <div className="footer-col footer-news">
            <h5>Stay in the loop</h5>
            <div className="news-input">
              <input type="email" placeholder="your@email.com" />
              <button type="button" aria-label="Subscribe">→</button>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© 2025 Mochi. All rights reserved.</span>
          <span>Built by the community. ♡</span>
        </div>
      </div>
    </footer>
  );
}
