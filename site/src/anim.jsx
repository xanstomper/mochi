// React animation primitives — all reveal/counter/bar logic lives here so it
// runs AFTER React mounts (fixes the dead-observer bug from site.js).
import { useEffect, useRef, useState } from 'react';

// add .in when scrolled into view
export function useReveal(threshold = 0.12) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }),
      { threshold, rootMargin: '0px 0px -40px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return ref;
}

// reveal wrapper component
export function Reveal({ as: Tag = 'div', delay = 0, className = '', children, ...rest }) {
  const ref = useReveal();
  return (
    <Tag ref={ref} className={'rv' + (delay ? ' d' + delay : '') + (className ? ' ' + className : '')} {...rest}>
      {children}
    </Tag>
  );
}

// count up when visible
export function useCountUp(target, decimals = 0, duration = 1400) {
  const ref = useRef(null);
  const [val, setVal] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf;
    const io = new IntersectionObserver(es => {
      if (!es[0].isIntersecting) return;
      io.disconnect();
      const t0 = performance.now();
      const tick = now => {
        const p = Math.min(1, (now - t0) / duration);
        const eased = 1 - Math.pow(1 - p, 4); // easeOutQuart
        setVal(target * eased);
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, { threshold: 0.4 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [target, duration]);
  return [ref, val];
}

export function CountUp({ target, decimals = 0, suffix = '', prefix = '' }) {
  const [ref, v] = useCountUp(target, decimals);
  return <span ref={ref}>{prefix}{v.toFixed(decimals)}{suffix}</span>;
}

// bench bars: animate width + formatted value when the chart scrolls in
export function BenchChart({ rows, unit, lower = true, fmt }) {
  const [go, setGo] = useState(false);
  const max = Math.max(...rows.map(r => r[1]));
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(es => {
      if (es[0].isIntersecting) { setGo(true); io.disconnect(); }
    }, { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const fmtVal = (v) => {
    if (fmt) return fmt(v);
    if (unit === 'ms') return (v < 100 ? v.toFixed(1) : Math.round(v).toLocaleString()) + ' ms';
    if (unit === 'x') return v.toFixed(1) + '×';
    return (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()) + ' ' + (unit || '');
  };
  const best = lower ? Math.min(...rows.map(r => r[1])) : Math.max(...rows.map(r => r[1]));
  return (
    <div className="bench" ref={ref}>
      {rows.map(([n, v, me], i) => (
        <div className={'row' + (me ? ' me' : '')} key={n}>
          <span className="n">{n}</span>
          <span className="t">
            <span className="f" style={{
              width: go ? Math.max(3, (v / max) * 100) + '%' : '0%',
              transition: `width 1.1s cubic-bezier(.34,1.3,.5,1) ${i * 90}ms`,
            }}></span>
          </span>
          <span className="v" style={{ opacity: go ? 1 : 0, transition: `opacity .5s ${600 + i * 90}ms` }}>
            {fmtVal(v)}
            {v === best && <i>1st</i>}
            {me && v !== best ? null : null}
            {!me && unit !== 'x' ? (
              <em style={{ fontStyle: 'normal', fontSize: 10, color: 'var(--pink-deep)', marginLeft: 5, fontWeight: 700 }}>
                {lower ? `${(v / best).toFixed(1)}×` : `${(best / v).toFixed(1)}×`}
              </em>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- Nous-grade primitives ----

// scroll-linked parallax: returns ref; element translates on scroll
export function useParallax(strength = 60) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const mid = r.top + r.height / 2 - window.innerHeight / 2;
        el.style.transform = `translateY(${(-mid / window.innerHeight) * strength}px)`;
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, [strength]);
  return ref;
}

// per-char staggered rise — giant display type reveal
export function SplitText({ text, className = '', delay = 0 }) {
  const ref = useReveal(0.2);
  return (
    <span ref={ref} className={'split ' + className} aria-label={text}>
      {text.split('').map((c, i) => (
        <span key={i} aria-hidden="true" className="split-ch" style={{ transitionDelay: delay + i * 22 + 'ms' }}>
          {c === ' ' ? '\u00A0' : c}
        </span>
      ))}
    </span>
  );
}

// Bayer-dithered gradient canvas — the Nous halftone block, in our pink
export function DitherBlock({ className = '', from = '#F2A7B8', to = '#FBF6EE', height = 420 }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const w = cv.width = cv.offsetWidth;
    const h = cv.height = cv.offsetHeight;
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, from); g.addColorStop(1, to);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const lum = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      // diagonal gradient position 0..1 — keeps full palette range regardless of input colors
      lum[y*w+x] = (x / w * 0.65 + y / h * 0.35);
    }
    // 4x4 Bayer matrix
    const M = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
    const white = [251,246,238], pink = [242,167,184], deep = [217,122,147], ink = [78,55,44];
    const pal = [ink, deep, pink, white];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = lum[y*w+x] + (M[y%4][x%4] / 16 - 0.5) * 0.28;
      const idx = Math.max(0, Math.min(3, Math.floor(t * 4)));
      const c = pal[idx];
      const o = (y*w+x)*4;
      img.data[o]=c[0]; img.data[o+1]=c[1]; img.data[o+2]=c[2]; img.data[o+3]=255;
    }
    ctx.putImageData(img, 0, 0);
  }, [from, to]);
  return <canvas ref={ref} className={'dither ' + className} style={{ width: '100%', height }} aria-hidden="true" />;
}

// infinite marquee strip
export function Marquee({ items, speed = 30, className = '' }) {
  const row = items.concat(items);
  return (
    <div className={'marquee ' + className} aria-hidden="true">
      <div className="marquee-track" style={{ animationDuration: speed + 's' }}>
        {row.map((t, i) => <span key={i} className="marquee-item">{t}<i>✦</i></span>)}
      </div>
    </div>
  );
}
