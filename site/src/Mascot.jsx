// mochi mascot — hand-drawn round mochi blob, inline SVG, original artwork.
// variants: happy (default), wink, sleepy
// Cuter upgrade: bigger sparkly eyes, rosier blush, happy tongue smile, charm sparkles.
// Kept ARM-LESS per user preference. Uses exact site palette.
import React from 'react';

function Face({ blink }) {
  return (
    <g>
      {/* eyes: rounder, lower, cuter */}
      <ellipse cx="34" cy="40" rx="4.2" ry={blink ? 0.9 : 5.2} fill="#5E4B3C" />
      <ellipse cx="62" cy="40" rx="4.2" ry={blink ? 0.9 : 5.2} fill="#5E4B3C" />
      {/* eye sparkles: dual highlight for shine */}
      {!blink && <>
        <circle cx="35.6" cy="37.6" r="1.6" fill="#fff" />
        <circle cx="63.6" cy="37.6" r="1.6" fill="#fff" />
        <circle cx="32.4" cy="42.6" r="0.9" fill="#fff" opacity=".75" />
        <circle cx="60.4" cy="42.6" r="0.9" fill="#fff" opacity=".75" />
      </>}
      {/* rosier blush */}
      <ellipse cx="21" cy="49" rx="7" ry="4" fill="#F2A7B8" opacity=".7" />
      <ellipse cx="75" cy="49" rx="7" ry="4" fill="#F2A7B8" opacity=".7" />
      {/* happy open smile + tongue */}
      <path d="M40 50 Q48 60 56 50 Q48 54 40 50" fill="#5E4B3C" />
      <path d="M45 55 Q48 62 51 55 Z" fill="#F6C1CB" />
    </g>
  );
}

export default function Mochi({ size = 240, mood = 'happy', className = '' }) {
  const blink = mood === 'blink';
  const wink = mood === 'wink';
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 96 96" fill="none" role="img" aria-label="Mochi mascot">
      {/* charm: floating sparkles + tiny heart */}
      <g fill="#E8B04B" opacity=".9">
        <path d="M20 14 l1.6 3.2 3.2 1.6 -3.2 1.6 -1.6 3.2 -1.6-3.2 -3.2-1.6 3.2-1.6z" />
        <path d="M78 66 l1.2 2.4 2.4 1.2 -2.4 1.2 -1.2 2.4 -1.2-2.4 -2.4-1.2 2.4-1.2z" opacity=".7" />
      </g>
      <path d="M16 40 c0 -2.4 1.8 -3.8 4.2 -3.8 c2.4 0 3.8 1.8 3.8 3.8 c0 3.2 -4 5.4 -4 5.4 s-4 -2.2 -4 -5.4z" fill="#F2A7B8" opacity=".65" />
      {/* body: soft round mochi */}
      <path
        d="M48 10 C71 10 85 27 85 50 C85 73 71 87 48 87 C25 87 11 73 11 50 C11 27 25 10 48 10 Z"
        fill="#FDF0E4" stroke="#8A6F5B" strokeWidth="2.6"
      />
      {/* squish highlight — cuter, bigger */}
      <path d="M24 30 C30 20 40 15 52 15" stroke="#fff" strokeWidth="6" strokeLinecap="round" opacity=".9" fill="none" />
      {/* little leaf on top */}
      <path d="M48 10 C50 4 57 2 63 4 C62 11 55 14 48 10 Z" fill="#A9C97E" stroke="#8A6F5B" strokeWidth="2" strokeLinejoin="round" />
      {wink
        ? <g>
            <ellipse cx="34" cy="40" rx="4.2" ry="5.2" fill="#5E4B3C" />
            <circle cx="35.6" cy="37.6" r="1.6" fill="#fff" />
            <circle cx="32.4" cy="42.6" r="0.9" fill="#fff" opacity=".75" />
            <path d="M58 40 q4 -4 9 0" stroke="#5E4B3C" strokeWidth="2.4" strokeLinecap="round" fill="none" />
            <ellipse cx="21" cy="49" rx="7" ry="4" fill="#F2A7B8" opacity=".7" />
            <ellipse cx="75" cy="49" rx="7" ry="4" fill="#F2A7B8" opacity=".7" />
            <path d="M40 50 Q48 62 56 50 Q48 54 40 50" fill="#5E4B3C" />
          </g>
        : <Face blink={blink} />}
    </svg>
  );
}