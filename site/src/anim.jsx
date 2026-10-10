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
  return (
    <span className={'split ' + className} aria-label={text}>
      {text.split('').map((c, i) => (
        <span key={i} aria-hidden="true" className="split-ch"
          style={{ animationDelay: delay + i * 70 + 'ms' }}>
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

// ---- voltagent/awesome-design-md + framer-grade gooey primitives ----

// animated conic-gradient border (gooey pink border — the "cool pink border effect" made alive)
export function GooeyBorder({ children, className = '', speed = 4, thickness = 2.5 }) {
  return (
    <div className={'gooey-wrap ' + className} style={{ '--gspeed': speed + 's', '--gthick': thickness + 'px' }}>
      <div className="gooey-inner">{children}</div>
    </div>
  );
}

// smooth infinite marquee — track duplicates content, CSS translates -50%
export function Marquee2({ items, speed = 30, className = '', separator = '✦' }) {
  const row = items.concat(items).concat(items); // 3x for wide screens
  return (
    <div className={'marquee2 ' + className} aria-hidden="true">
      <div className="marquee2-track" style={{ animationDuration: speed + 's' }}>
        {row.map((t, i) => (
          <span key={i} className="marquee2-item">{t}<i>{separator}</i></span>
        ))}
      </div>
    </div>
  );
}

// typewriter effect — cycles through phrases
export function Typewriter({ phrases, speed = 45, pause = 1800, className = '' }) {
  const [text, setText] = useState('');
  const [idx, setIdx] = useState(0);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    const cur = phrases[idx % phrases.length];
    let t;
    if (!deleting && text === cur) {
      t = setTimeout(() => setDeleting(true), pause);
    } else if (deleting && text === '') {
      setDeleting(false);
      setIdx(i => (i + 1) % phrases.length);
    } else {
      t = setTimeout(() => {
        setText(cur.slice(0, text.length + (deleting ? -1 : 1)));
      }, deleting ? speed / 2 : speed);
    }
    return () => clearTimeout(t);
  }, [text, deleting, idx, phrases, speed, pause]);
  return (
    <span className={'typewriter ' + className}>
      {text}
      <span className="tw-caret">▊</span>
    </span>
  );
}

// 3D tilt on hover — premium card interaction
export function TiltCard({ children, className = '', max = 8 }) {
  const ref = useRef(null);
  const onMove = (e) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(900px) rotateX(${-y * max}deg) rotateY(${x * max}deg) scale(1.02)`;
  };
  const onLeave = () => {
    const el = ref.current;
    if (el) el.style.transform = 'perspective(900px) rotateX(0) rotateY(0) scale(1)';
  };
  return (
    <div ref={ref} className={'tilt ' + className} onMouseMove={onMove} onMouseLeave={onLeave}>
      {children}
    </div>
  );
}

// scroll progress bar — thin pink line at top of page
export function ScrollProgress() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = document.documentElement.scrollHeight - window.innerHeight;
        el.style.width = (h > 0 ? (window.scrollY / h) * 100 : 0) + '%';
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, []);
  return <div ref={ref} className="scroll-progress" />;
}

// magnetic hover — element drifts toward cursor
export function Magnetic({ children, className = '', strength = 0.3 }) {
  const ref = useRef(null);
  const onMove = (e) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left - r.width / 2;
    const y = e.clientY - r.top - r.height / 2;
    el.style.transform = `translate(${x * strength}px, ${y * strength}px)`;
  };
  const onLeave = () => {
    const el = ref.current;
    if (el) el.style.transform = 'translate(0,0)';
  };
  return (
    <div ref={ref} className={'magnetic ' + className} onMouseMove={onMove} onMouseLeave={onLeave}>
      {children}
    </div>
  );
}


// scroll-triggered side-slide — text slides in from left/right
export function SlideIn({ from = 'left', delay = 0, className = '', children, as: Tag = 'div' }) {
  const ref = useReveal(0.1);
  return (
    <Tag ref={ref} className={'slide-in slide-' + from + (delay ? ' d' + delay : '') + (className ? ' ' + className : '')}>
      {children}
    </Tag>
  );
}

// alternating slide for lists — odd items left, even right
export function SlideAlternate({ items, className = '', itemClass = '' }) {
  return (
    <>
      {items.map((item, i) => (
        <SlideIn key={i} from={i % 2 === 0 ? 'left' : 'right'} delay={i * 80} className={itemClass}>
          {item}
        </SlideIn>
      ))}
    </>
  );
}
