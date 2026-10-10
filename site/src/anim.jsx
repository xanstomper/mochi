import { useEffect, useRef, useState, useCallback } from 'react';

/* ═══════════════════════════════════════════════════════════
   MOCHI v5 — REACT BITS PORTS (zero-dependency)
   SplitText, BlurText, AnimatedContent, CountUp, ScrollFloat,
   ShinyText, Magnetic, TiltCard, GooeyBorder, Marquee2,
   ScrollProgress, ScrollVelocity
   ═══════════════════════════════════════════════════════════ */

/* ── SplitText ──────────────────────────────────────────────── */
export function SplitText({
  text, className = '', delay = 0, stagger = 0.03,
  as: Tag = 'span', once = true,
}) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) setInView(false);
      },
      { threshold: 0.1 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once]);

  const words = text.split(' ');
  let charIndex = 0;

  return (
    <Tag ref={ref} className={`${className} ${inView ? 'in' : ''}`} aria-label={text}>
      {words.map((word, wi) => (
        <span key={wi} className="split-word" aria-hidden="true">
          {word.split('').map((ch, ci) => {
            const idx = charIndex++;
            return (
              <span
                key={ci}
                className="split-char"
                style={{ transitionDelay: `${delay + idx * stagger}s` }}
              >
                {ch}
              </span>
            );
          })}
          {wi < words.length - 1 && <span>&nbsp;</span>}
        </span>
      ))}
    </Tag>
  );
}

/* ── BlurText ───────────────────────────────────────────────── */
export function BlurText({
  text, className = '', delay = 0, stagger = 0.08,
  as: Tag = 'span', once = true,
}) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) setInView(false);
      },
      { threshold: 0.1 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once]);

  const words = text.split(' ');
  return (
    <Tag ref={ref} className={`${className} ${inView ? 'in' : ''}`} aria-label={text}>
      {words.map((word, i) => (
        <span
          key={i}
          className="blur-word"
          aria-hidden="true"
          style={{ transitionDelay: `${delay + i * stagger}s` }}
        >
          {word}
          {i < words.length - 1 && '\u00A0'}
        </span>
      ))}
    </Tag>
  );
}

/* ── AnimatedContent ────────────────────────────────────────── */
export function AnimatedContent({
  children, direction = 'bottom', distance = 30, delay = 0,
  duration = 0.7, scale = 0.96, className = '', once = true,
}) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) setInView(false);
      },
      { threshold: 0.08 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [once]);

  return (
    <div
      ref={ref}
      className={`ac from-${direction} ${inView ? 'in' : ''} ${className}`}
      style={{ transitionDelay: `${delay}s`, transitionDuration: `${duration}s` }}
    >
      {children}
    </div>
  );
}

/* ── CountUp ────────────────────────────────────────────────── */
export function CountUp({
  end, start = 0, duration = 1.6, delay = 0, decimals = 0,
  prefix = '', suffix = '', className = '',
}) {
  const ref = useRef(null);
  const [val, setVal] = useState(start);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const t0 = performance.now() + delay * 1000;
          const tick = (now) => {
            const p = Math.min(1, Math.max(0, (now - t0) / (duration * 1000)));
            const e = 1 - Math.pow(1 - p, 4);
            setVal(start + (end - start) * e);
            if (p < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          io.disconnect();
        }
      },
      { threshold: 0.3 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [end, start, duration, delay]);

  return (
    <span ref={ref} className={`countup ${className}`}>
      {prefix}{val.toFixed(decimals)}{suffix}
    </span>
  );
}

/* ── ScrollFloat ────────────────────────────────────────────── */
export function ScrollFloat({
  children, scrollStart = 0.1, scrollEnd = 0.9,
  moveDistance = 60, className = '',
}) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf;
    const onScroll = () => {
      raf = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const vh = window.innerHeight;
        const progress = Math.min(1, Math.max(0,
          (vh - rect.top) / (vh + rect.height)
        ));
        const eased = progress < scrollStart ? 0
          : progress > scrollEnd ? 1
          : (progress - scrollStart) / (scrollEnd - scrollStart);
        el.style.transform = `translateY(${(1 - eased) * moveDistance}px)`;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [scrollStart, scrollEnd, moveDistance]);

  return (
    <span ref={ref} className={`sf ${className}`}>
      {children}
    </span>
  );
}

/* ── ShinyText ──────────────────────────────────────────────── */
export function ShinyText({ children, className = '' }) {
  return <span className={`shiny ${className}`}>{children}</span>;
}

/* ── Magnetic ───────────────────────────────────────────────── */
export function Magnetic({ children, strength = 0.3, className = '' }) {
  const ref = useRef(null);

  const onMove = useCallback((e) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    el.style.transform = `translate(${dx * strength}px, ${dy * strength}px)`;
  }, [strength]);

  const onLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = '';
  }, []);

  return (
    <span
      ref={ref}
      className={`magnetic ${className}`}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {children}
    </span>
  );
}

/* ── TiltCard ───────────────────────────────────────────────── */
export function TiltCard({ children, max = 8, className = '' }) {
  const ref = useRef(null);

  const onMove = useCallback((e) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    el.style.transform = `perspective(800px) rotateY(${px * max}deg) rotateX(${-py * max}deg)`;
  }, [max]);

  const onLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = '';
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ transition: 'transform .3s ease-out', willChange: 'transform' }}
    >
      {children}
    </div>
  );
}

/* ── GooeyBorder ────────────────────────────────────────────── */
export function GooeyBorder({ children, className = '' }) {
  return (
    <div className={`gooey-border ${className}`} style={{ position: 'relative' }}>
      <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden="true">
        <defs>
          <filter id="gooey-border-filter">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
            <feColorMatrix in="blur" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo" />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>
      <div
        style={{
          position: 'absolute', inset: 0, borderRadius: 'inherit',
          padding: 2,
          background: 'conic-gradient(from var(--gangle, 0deg), #f472b6, #c4b5fd, #67e8f9, #f472b6)',
          filter: 'url(#gooey-border-filter)',
          WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
          animation: 'gooeySpin 4s linear infinite',
        }}
      />
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  );
}

/* ── Marquee2 ───────────────────────────────────────────────── */
export function Marquee2({ children, speed = 30, reverse = false, className = '' }) {
  return (
    <div className={`marquee2 ${className}`} style={{ overflow: 'hidden', display: 'flex' }}>
      <div
        className="marquee2-track"
        style={{
          display: 'flex', flexShrink: 0, minWidth: '100%',
          animation: `marquee2 ${speed}s linear infinite ${reverse ? 'reverse' : 'normal'}`,
        }}
      >
        {children}
        {children}
      </div>
    </div>
  );
}

/* ── ScrollProgress ─────────────────────────────────────────── */
export function ScrollProgress() {
  useEffect(() => {
    let raf;
    const onScroll = () => {
      raf = requestAnimationFrame(() => {
        const h = document.documentElement;
        const p = h.scrollTop / (h.scrollHeight - h.clientHeight);
        const el = document.querySelector('.scroll-progress');
        if (el) el.style.transform = `scaleX(${p})`;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  return <div className="scroll-progress" aria-hidden="true" />;
}

/* ── ScrollVelocity ─────────────────────────────────────────── */
export function ScrollVelocity({ children, velocity = 0.05, className = '' }) {
  const ref = useRef(null);
  const pos = useRef(0);
  const vel = useRef(0);
  const lastScroll = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf;
    lastScroll.current = window.scrollY;

    const onScroll = () => {
      const dy = window.scrollY - lastScroll.current;
      lastScroll.current = window.scrollY;
      vel.current += dy * velocity;
    };

    const loop = () => {
      vel.current *= 0.92;
      pos.current += vel.current;
      el.style.transform = `translateX(${pos.current}px) skewX(${Math.max(-10, Math.min(10, vel.current * 0.15))}deg)`;
      raf = requestAnimationFrame(loop);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    raf = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [velocity]);

  return (
    <div className={`sv-outer ${className}`}>
      <div ref={ref} className="sv-inner">
        {children}
      </div>
    </div>
  );
}

/* ── Reveal (backwards-compat alias) ────────────────────────── */
export const Reveal = AnimatedContent;

/* ── Marquee (backwards-compat alias) ───────────────────────── */
export function Marquee({ children, speed = 30, className = '' }) {
  return (
    <div className={`marquee2 ${className}`} style={{ overflow: 'hidden', display: 'flex' }}>
      <div
        className="marquee2-track"
        style={{
          display: 'flex', flexShrink: 0, minWidth: '100%',
          animation: `marquee2 ${speed}s linear infinite`,
        }}
      >
        {children}
        {children}
      </div>
    </div>
  );
}

/* ── DitherBlock ────────────────────────────────────────────── */
export function DitherBlock({ width = 200, height = 100, color = '#f472b6', className = '' }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    const bayer = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];
    ctx.clearRect(0, 0, w, h);
    const cell = 4;
    const cols = Math.ceil(w / cell);
    const rows = Math.ceil(h / cell);
    ctx.fillStyle = color;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const threshold = bayer[y % 4][x % 4] / 16;
        const fade = 1 - (y / rows);
        if (threshold < fade) {
          ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1);
        }
      }
    }
  }, [color]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={`dither ${className}`}
      style={{ width: '100%', height: 'auto' }}
    />
  );
}

/* ── BenchChart ─────────────────────────────────────────────── */
export function BenchChart({ data, max, unit = '', rows }) {
  // support both signatures: { data, max } and { rows: [[label, value, isMochi]], unit }
  const chartData = rows
    ? rows.map(r => ({ label: r[0], value: r[1], isMochi: !!r[2], display: r[1] + (unit ? ' ' + unit : '') }))
    : data.map(d => ({ ...d, isMochi: d.color === 'pink' }));
  const chartMax = max || Math.max(...chartData.map(x => x.value));
  return (
    <div className="bench-chart">
      {chartData.map((d, i) => (
        <div key={i} className="bench-row">
          <span className="bench-label">{d.label}</span>
          <div className="bench-bar-wrap">
            <div
              className={'bench-bar ' + (d.isMochi ? 'pink' : 'gray')}
              style={{ width: (d.value / chartMax * 100) + '%' }}
            >
              {d.display}
            </div>
          </div>
          <span className="bench-val">{d.display}</span>
        </div>
      ))}
    </div>
  );
}

/* ── GooeyBorder keyframes ──────────────────────────────────── */
const gooeyStyle = document.createElement('style');
gooeyStyle.textContent = `
@keyframes gooeySpin {
  0% { --gangle: 0deg; }
  100% { --gangle: 360deg; }
}
@property --gangle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
`;
if (typeof document !== 'undefined') {
  document.head.appendChild(gooeyStyle);
}

/* ── marquee2 keyframes ─────────────────────────────────────── */
const marqueeStyle = document.createElement('style');
marqueeStyle.textContent = `
@keyframes marquee2 {
  0% { transform: translateX(0); }
  100% { transform: translateX(-50%); }
}
.marquee2-item {
  font-family: var(--font-mono); font-size: 13px; font-weight: 500;
  text-transform: uppercase; letter-spacing: .1em;
  color: rgba(255,255,255,.7); padding: 0 32px;
  display: flex; align-items: center; gap: 8px; white-space: nowrap;
}
.marquee2-item .ticker-dot { width: 6px; height: 6px; border-radius: 50%; background: #f472b6; }
`;
if (typeof document !== 'undefined') {
  document.head.appendChild(marqueeStyle);
}