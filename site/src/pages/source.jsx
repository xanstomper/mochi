import React from 'react';
import { createRoot } from 'react-dom/client';
import RepoBrowser from '../RepoBrowser.jsx';
import { Marquee, Reveal } from '../anim.jsx';

function Source() {
  return (
    <>
      <div className="pagehead">
        <div className="wrap">
          <div className="eyebrow">NOTHING HIDDEN — READ EVERYTHING</div>
          <h1>Source</h1>
          <p className="lede">Every file of mochi, fetched live from the main branch. Search it, open it, read it — without leaving the page.</p>
        </div>
      </div>
      <Marquee speed={32} items={['REPO: XANSTOMPER/MOCHI', 'BRANCH: MAIN', 'LIVE FROM GITHUB', 'MIT LICENSE', 'ZERO DEPENDENCIES']} />
      <div className="wrap" style={{ padding: '48px 24px 90px' }}>
        <div className="rb-window"><RepoBrowser /></div>
      </div>
    </>
  );
}
createRoot(document.getElementById('root')).render(<Source />);
