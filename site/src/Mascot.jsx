import React from 'react';

export default function Mochi({ className = '', style = {} }) {
  const base = typeof window !== 'undefined' && window.location.pathname.startsWith('/mochi') ? '/mochi' : '';
  return (
    <img
      src={base + '/assets/mochi-mascot.png'}
      alt="mochi mascot"
      className={className}
      style={{ height: 'auto', display: 'block', ...style }}
      draggable="false"
    />
  );
}
