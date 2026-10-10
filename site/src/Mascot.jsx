import React from 'react';

export default function Mochi({ size = 480, className = '', style = {} }) {
  const base = typeof window !== 'undefined' && window.location.pathname.startsWith('/mochi') ? '/mochi' : '';
  return (
    <img
      src={base + '/assets/mochi-mascot.png'}
      alt="mochi mascot"
      className={className}
      style={{ width: size, height: 'auto', ...style }}
      draggable="false"
    />
  );
}
