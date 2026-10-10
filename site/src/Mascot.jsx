// mochi mascot — hand-drawn round mochi blob, inline SVG, original artwork.
// variants: happy (default), wink, sleepy
import React from 'react';

function Face({ blink }) {
  return (
    <g>
      {/* eyes */}
      <ellipse cx="34" cy="40" rx="3.4" ry={blink ? 0.8 : 4.2} fill="#5E4B3C" />
      <ellipse cx="62" cy="40" rx="3.4" ry={blink ? 0.8 : 4.2} fill="#5E4B3C" />
      {/* eye sparkles */}
      {!blink && <><circle cx="35.4" cy="38.4" r="1.2" fill="#fff" /><circle cx="63.4" cy="38.4" r="1.2" fill="#fff" /></>}
      {/* blush */}
      <ellipse cx="24" cy="49" rx="5.5" ry="3.2" fill="#F2A7B8" opacity=".55" />
      <ellipse cx="72" cy="49" rx="5.5" ry="3.2" fill="#F2A7B8" opacity=".55" />
      {/* mouth */}
      <path d="M42 50 Q48 56 54 50" stroke="#5E4B3C" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </g>
  );
}

export default function Mochi({ size = 240, mood = 'happy', className = '' }) {
  const blink = mood === 'blink';
  const wink = mood === 'wink';
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 96 96" fill="none" role="img" aria-label="Mochi mascot">
      {/* body: soft round mochi */}
      <path
        d="M48 12 C70 12 84 28 84 50 C84 72 70 86 48 86 C26 86 12 72 12 50 C12 28 26 12 48 12 Z"
        fill="#FDF0E4" stroke="#8A6F5B" strokeWidth="2.6"
      />
      {/* squish highlight */}
      <path d="M26 28 C32 20 42 16 50 16" stroke="#fff" strokeWidth="5" strokeLinecap="round" opacity=".8" fill="none" />
      {/* little leaf on top */}
      <path d="M48 12 C50 6 56 3 62 5 C61 11 55 14 48 12 Z" fill="#A9C97E" stroke="#8A6F5B" strokeWidth="2" strokeLinejoin="round" />
      {wink
        ? <g>
            <ellipse cx="34" cy="40" rx="3.4" ry="4.2" fill="#5E4B3C" />
            <circle cx="35.4" cy="38.4" r="1.2" fill="#fff" />
            <path d="M58 40 q4 -4 8 0" stroke="#5E4B3C" strokeWidth="2.4" strokeLinecap="round" fill="none" />
            <ellipse cx="24" cy="49" rx="5.5" ry="3.2" fill="#F2A7B8" opacity=".55" />
            <ellipse cx="72" cy="49" rx="5.5" ry="3.2" fill="#F2A7B8" opacity=".55" />
            <path d="M40 50 Q48 59 56 50" stroke="#5E4B3C" strokeWidth="2.4" strokeLinecap="round" fill="none" />
          </g>
        : <Face blink={blink} />}
      {/* stubby arms */}
      <path d="M14 56 Q8 60 10 66" stroke="#8A6F5B" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <path d="M82 56 Q88 60 86 66" stroke="#8A6F5B" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}
