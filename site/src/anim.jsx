import { useEffect, useRef, useState, useCallback } from 'react';

/* ── useReveal ────────────────────────────────────────────── */
export function useReveal(threshold = 0.08) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { el.classList.add('in'); io.unobserve(el); }
    }, { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return ref;
}

/* ── useInView (boolean, once) ────────────────────────────── */
export function useInView(threshold = 0.1, rootMargin = '0px') {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setInView(true); io.unobserve(el); }
    }, { threshold, rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold, rootMargin]);
  return [ref, inView];
}

/* ── useScrollY ───────────────────────────────────────────── */
export function useScrollY() {
  const [y, setY] = useState(0);
  useEffect(() => {
    let raf;
    const onScroll = () => { raf = requestAnimationFrame(() => setY(window.scrollY)); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, []);
  return y;
}

/* ── SplitText (React Bits port — zero-dep) ──────────────── */
export function SplitText({ text, className = '', delay = 50, from = 'bottom', as: Tag = 'span' }) {
  const [ref, inView] = useInView(0.05, '-50px');
  const chars = text.split('');
  const hidden = from === 'bottom' ? 'translateY(110%)' : from === 'top' ? 'translateY(-110%)' : from === 'left' ? 'translateX(-110%)' : 'translateX(110%)';
  return (
    <Tag ref={ref} className={'split-text ' + className} aria-label={text}>
      {chars.map((c, i) => (
        <span key={i} className="split-char-wrap" style={{ overflow: 'hidden', display: 'inline-block' }}>
          <span className="split-ch" style={{
            display: 'inline-block',
            transform: inView ? 'translate(0,0)' : hidden,
            opacity: inView ? 1 : 0,
            transition: `transform .9s cubic-bezier(.22,1,.36,1) ${i * delay}ms, opacity .5s ease ${i * delay}ms`,
          }}>{c === ' ' ? '\u00A0' : c}</span>
        </span>
      ))}
    </Tag>
  );
}

/* ── BlurText (React Bits port) ───────────────────────────── */
export function BlurText({ text, className = '', delay = 80, direction = 'top', as: Tag = 'p' }) {
  const [ref, inView] = useInView(0.08, '-30px');
  const words = text.split(' ');
  const yOff = direction === 'top' ? -30 : 30;
  return (
    <Tag ref={ref} className={'blur-text ' + className} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3em' }}>
      {words.map((w, wi) => (
        <span key={wi} style={{ display: 'inline-flex', overflow: 'hidden' }}>
          {w.split('').map((c, ci) => (
            <span key={ci} style={{
              display: 'inline-block',
              filter: inView ? 'blur(0px)' : 'blur(8px)',
              opacity: inView ? 1 : 0,
              transform: inView ? 'translateY(0)' : `translateY(${yOff}px)`,
              transition: `filter .6s ease ${(wi * 3 + ci) * delay / 3}ms, opacity .5s ease ${(wi * 3 + ci) * delay / 3}ms, transform .6s cubic-bezier(.22,1,.36,1) ${(wi * 3 + ci) * delay / 3}ms`,
            }}>{c}</span>
          ))}
        </span>
      ))}
    </Tag>
  );
}

/* ── AnimatedContent (React Bits port) ───────────────────── */
export function AnimatedContent({
  children, distance = 60, direction = 'vertical', reverse = false,
  duration = 0.8, initialOpacity = 0, scale = 1, threshold = 0.1,
  delay = 0, className = '', as: Tag = 'div', ...props
}) {
  const [ref, inView] = useInView(threshold, '-30px');
  const axis = direction === 'horizontal' ? 'X' : 'Y';
  const dist = reverse ? -distance : distance;
  return (
    <Tag ref={ref} className={className} {...props} style={{
      opacity: inView ? 1 : initialOpacity,
      transform: inView
        ? 'translate(0,0) scale(1)'
        : `translate${axis}(${dist}px) scale(${scale})`,
      transition: `opacity ${duration}s ease ${delay}s, transform ${duration}s cubic-bezier(.22,1,.36,1) ${delay}s`,
      willChange: 'transform, opacity',
    }}>
      {children}
    </Tag>
  );
}

/* ── CountUp (React Bits port) ────────────────────────────── */
export function CountUp({ to, from = 0, duration = 1.8, delay = 0, className = '', separator = '' }) {
  const [ref, inView] = useInView(0.3);
  const [val, setVal] = useState(from);
  const rafRef = useRef();
  const startRef = useRef();

  useEffect(() => {
    if (!inView) return;
    const timeout = setTimeout(() => {
      const step = (ts) => {
        if (!startRef.current) startRef.current = ts;
        const p = Math.min((ts - startRef.current) / (duration * 1000), 1);
        const eased = 1 - Math.pow(1 - p, 4); // easeOutQuart
        setVal(from + (to - from) * eased);
        if (p < 1) rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    }, delay * 1000);
    return () => { clearTimeout(timeout); cancelAnimationFrame(rafRef.current); startRef.current = null; };
  }, [inView, from, to, duration, delay]);

  const decimals = (() => { const s = to.toString(); return s.includes('.') ? s.split('.')[1].length : 0; })();
  const formatted = separator
    ? val.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).replace(/,/g, separator)
    : val.toFixed(decimals);

  return <span className={className} ref={ref}>{formatted}</span>;
}

/* ── ScrollFloat (React Bits port — char-level parallax) ─── */
export function ScrollFloat({ children, className = '', as: Tag = 'h2' }) {
  const ref = useRef(null);
  const scrollY = useScrollY();
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const elCenter = rect.top + scrollY + rect.height / 2;
    const viewportCenter = scrollY + window.innerHeight / 2;
    setOffset((elCenter - viewportCenter) * 0.12); // parallax factor
  }, [scrollY]);

  const chars = (typeof children === 'string' ? children : '').split('');
  return (
    <Tag ref={ref} className={'scroll-float ' + className} style={{ transform: `translateY(${offset}px)` }}>
      {chars.map((c, i) => (
        <span key={i} className="sf-char" style={{
          display: 'inline-block',
          transform: `translateY(${Math.sin(i * 0.4) * 4}px)`,
          transition: 'transform .1s linear',
        }}>{c === ' ' ? '\u00A0' : c}</span>
      ))}
    </Tag>
  );
}

/* ── ShinyText (React Bits port) ─────────────────────────── */
export function ShinyText({ text, className = '', speed = 3, color = '#8A2D4E' }) {
  return (
    <span className={'shiny-text ' + className} style={{
      background: `linear-gradient(120deg, ${color} 40%, #F2A7B8 50%, ${color} 60%)`,
      backgroundSize: '200% 100%',
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
      backgroundClip: 'text',
      animation: `shimmer ${speed}s linear infinite`,
    }}>{text}</span>
  );
}

/* ── ScrollProgress (top progress bar) ───────────────────── */
export function ScrollProgress() {
  const scrollY = useScrollY();
  const [max, setMax] = useState(1);
  useEffect(() => {
    setMax(document.documentElement.scrollHeight - window.innerHeight);
  }, [scrollY]);
  return (
    <div className="scroll-progress" style={{
      position: 'fixed', top: 0, left: 0, right: 0, height: '3px',
      background: 'var(--pink)', transformOrigin: '0 50%',
      transform: `scaleX(${Math.min(scrollY / max, 1)})`,
      zIndex: 9999, borderRadius: '0 2px 2px 0',
    }} />
  );
}

/* ── Typewriter ───────────────────────────────────────────── */
export function Typewriter({ phrases, speed = 45, pause = 1800, className = '' }) {
  const [text, setText] = useState('');
  const [pi, setPi] = useState(0);
  const [ci, setCi] = useState(0);
  const [del, setDel] = useState(false);

  useEffect(() => {
    const current = phrases[pi % phrases.length];
    let t;
    if (!del && ci < current.length) t = setTimeout(() => setCi(c => c + 1), speed);
    else if (!del && ci === current.length) t = setTimeout(() => setDel(true), pause);
    else if (del && ci > 0) t = setTimeout(() => setCi(c => c - 1), speed / 2);
    else t = setTimeout(() => { setDel(false); setPi(p => p + 1); }, 350);
    return () => clearTimeout(t);
  }, [ci, del, pi, phrases, speed, pause]);

  return (
    <span className={'typewriter ' + className}>
      {currentText(phrases, pi, ci)}
      <span className="tw-cursor">▌</span>
    </span>
  );
}
function currentText(phrases, pi, ci) {
  return phrases[pi % phrases.length].slice(0, ci);
}

/* ── Marquee2 ─────────────────────────────────────────────── */
export function Marquee2({ items, speed = 28, reverse = false, className = '', separator = '✦' }) {
  const row = items.concat(items).concat(items);
  return (
    <div className={'marquee2 ' + className} aria-hidden="true">
      <div className="marquee2-track" style={{
        animationDuration: speed + 's',
        animationDirection: reverse ? 'reverse' : 'normal',
      }}>
        {row.map((item, i) => (
          <span key={i} className="marquee2-item">{item}<span className="mq-sep">{separator}</span></span>
        ))}
      </div>
    </div>
  );
}

/* ── Magnetic (MagneticButton port) ───────────────────────── */
export function Magnetic({ children, strength = 0.3, className = '' }) {
  const ref = useRef(null);
  const onMove = useCallback((e) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left - r.width / 2;
    const y = e.clientY - r.top - r.height / 2;
    el.style.transform = `translate(${x * strength}px, ${y * strength}px)`;
  }, [strength]);
  const onLeave = useCallback(() => {
    const el = ref.current;
    if (el) el.style.transform = 'translate(0,0)';
  }, []);
  return (
    <div ref={ref} className={'magnetic ' + className}
      onMouseMove={onMove} onMouseLeave={onLeave}
      style={{ display: 'inline-block', transition: 'transform .3s cubic-bezier(.22,1,.36,1)' }}>
      {children}
    </div>
  );
}

/* ── TiltCard ─────────────────────────────────────────────── */
export function TiltCard({ children, className = '' }) {
  const ref = useRef(null);
  const onMove = useCallback((e) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const rx = ((e.clientY - r.top) / r.height - 0.5) * -8;
    const ry = ((e.clientX - r.left) / r.width - 0.5) * 8;
    el.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) scale(1.02)`;
  }, []);
  const onLeave = useCallback(() => {
    const el = ref.current;
    if (el) el.style.transform = 'perspective(900px) rotateX(0) rotateY(0) scale(1)';
  }, []);
  return (
    <div ref={ref} className={'tilt-card ' + className}
      onMouseMove={onMove} onMouseLeave={onLeave}
      style={{ transition: 'transform .4s cubic-bezier(.22,1,.36,1)', transformStyle: 'preserve-3d' }}>
      {children}
    </div>
  );
}

/* ── GooeyBorder ──────────────────────────────────────────── */
export function GooeyBorder({ children, className = '' }) {
  return (
    <div className={'gooey-border ' + className}>
      <div className="gooey-inner">{children}</div>
    </div>
  );
}

/* ── ParallaxY ────────────────────────────────────────────── */
export function ParallaxY({ children, factor = 0.15, className = '' }) {
  const scrollY = useScrollY();
  const ref = useRef(null);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const elCenter = rect.top + scrollY + rect.height / 2;
    const viewportCenter = scrollY + window.innerHeight / 2;
    setOffset((viewportCenter - elCenter) * factor);
  }, [scrollY, factor]);
  return (
    <div ref={ref} className={className} style={{ transform: `translateY(${offset}px)`, willChange: 'transform' }}>
      {children}
    </div>
  );
}


/* ── Backwards-compat aliases ─────────────────────────────── */
export function Reveal({ children, className = '', delay = 0 }) {
  return (
    <AnimatedContent direction="vertical" distance={40} duration={0.7} delay={delay} className={className}>
      {children}
    </AnimatedContent>
  );
}

export function Marquee({ items, speed = 30, reverse = false, className = '' }) {
  return <Marquee2 items={items} speed={speed} reverse={reverse} className={className} />;
}


/* ── BenchChart (backwards compat) ────────────────────────── */
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
