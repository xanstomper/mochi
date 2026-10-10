// mochi mascot — pastel lavender edition, inline SVG, original artwork.
// White round blob, glossy black oval eyes, pink blush, purple leaf sprout.
import React from 'react';

export default function Mochi({ size = 280, mood = 'happy', className = '' }) {
  const blink = mood === 'blink';
  const wink = mood === 'wink';

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      role="img"
      aria-label="Mochi mascot"
    >
      {/* soft shadow beneath */}
      <ellipse cx="100" cy="178" rx="55" ry="10" fill="#8B75F6" opacity=".18" />

      {/* body — soft white mochi blob */}
      <path
        d="M100 28 C138 28 162 52 162 90 C162 128 138 168 100 168 C62 168 38 128 38 90 C38 52 62 28 100 28 Z"
        fill="#FFFFFF"
        stroke="#E8E3FD"
        strokeWidth="3"
      />

      {/* subtle body shading */}
      <path
        d="M100 32 C134 32 156 54 156 88"
        stroke="#F3F1FA"
        strokeWidth="8"
        strokeLinecap="round"
        fill="none"
        opacity=".8"
      />

      {/* leaf sprout on top */}
      <g transform="translate(100, 28)">
        <path
          d="M0 0 C-2 -8 -8 -14 -14 -14 C-14 -6 -8 0 0 0 Z"
          fill="#8B75F6"
          opacity=".9"
        />
        <path
          d="M0 0 C2 -10 8 -16 14 -16 C14 -8 8 0 0 0 Z"
          fill="#8B75F6"
          opacity=".7"
        />
        <path
          d="M0 0 C0 -12 2 -18 6 -20 C8 -14 4 -4 0 0 Z"
          fill="#A78BFA"
          opacity=".8"
        />
      </g>

      {/* eyes — glossy black ovals */}
      {wink ? (
        <g>
          {/* left eye open */}
          <ellipse cx="78" cy="88" rx="7" ry="10" fill="#111116" />
          <circle cx="80" cy="84" r="3" fill="#fff" />
          <circle cx="75" cy="92" r="1.5" fill="#fff" opacity=".7" />
          {/* right eye winking */}
          <path
            d="M118 88 Q126 80 134 88"
            stroke="#111116"
            strokeWidth="3.5"
            strokeLinecap="round"
            fill="none"
          />
        </g>
      ) : (
        <g>
          {/* left eye */}
          <ellipse
            cx="78"
            cy="88"
            rx="7"
            ry={blink ? 1.5 : 10}
            fill="#111116"
          />
          {!blink && <circle cx="80" cy="84" r="3" fill="#fff" />}
          {!blink && <circle cx="75" cy="92" r="1.5" fill="#fff" opacity=".7" />}
          {/* right eye */}
          <ellipse
            cx="122"
            cy="88"
            rx="7"
            ry={blink ? 1.5 : 10}
            fill="#111116"
          />
          {!blink && <circle cx="124" cy="84" r="3" fill="#fff" />}
          {!blink && <circle cx="119" cy="92" r="1.5" fill="#fff" opacity=".7" />}
        </g>
      )}

      {/* blush — soft pink circles */}
      <ellipse cx="62" cy="108" rx="10" ry="6" fill="#E3B7EB" opacity=".6" />
      <ellipse cx="138" cy="108" rx="10" ry="6" fill="#E3B7EB" opacity=".6" />

      {/* tiny smile */}
      <path
        d="M92 112 Q100 118 108 112"
        stroke="#111116"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
        opacity=".6"
      />
    </svg>
  );
}
