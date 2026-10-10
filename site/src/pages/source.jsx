import React from 'react';
import { createRoot } from 'react-dom/client';
import RepoBrowser from '../RepoBrowser.jsx';

function Source() {
  return (
    <>
      <div className="pagehead">
        <div className="wrap">
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 14 }}>Repository <span className="hd-mascot">🍡</span></h1>
          <p>
            The entire mochi codebase — every source file, readable right here. Collapsible folders, instant filter, syntax highlighting.{' '}
            <a href="https://github.com/xanstomper/mochi" target="_blank" rel="noopener">Open on GitHub ↗</a>
          </p>
        </div>
      </div>
      <div className="wrap srcwrap">
        <RepoBrowser />
      </div>
    </>
  );
}
createRoot(document.getElementById('root')).render(<Source />);
