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
