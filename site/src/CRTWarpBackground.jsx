import React from 'react';
import EngineeringGrid from './EngineeringGrid.jsx';

export default function EngineeringGridBackground() {
  return (
    <div
      className="site-engineering-grid-bg"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        background: 'transparent',
      }}
      aria-hidden="true"
    >
      <EngineeringGrid />
    </div>
  );
}
