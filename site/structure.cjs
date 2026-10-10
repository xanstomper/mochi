const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(800);
  // 1. Does the giant headline animate on load?
  const split1 = await p.evaluate(() => {
    const chs = document.querySelectorAll('.giant .split-ch');
    return [...chs].map(c => getComputedStyle(c).transform);
  });
  await p.waitForTimeout(1000);
  const split2 = await p.evaluate(() => {
    const chs = document.querySelectorAll('.giant .split-ch');
    return [...chs].map(c => getComputedStyle(c).transform);
  });
  console.log('split chars at t=0:', split1.slice(0,3));
  console.log('split chars at t=1s:', split2.slice(0,3));
  // 2. Is the marquee visible in the hero?
  const mq = await p.evaluate(() => {
    const m = document.querySelector('.marquee, .marquee2');
    if (!m) return 'NOT FOUND';
    const r = m.getBoundingClientRect();
    return { top: r.top, height: r.height, visible: r.top < 900 && r.bottom > 0 };
  });
  console.log('marquee in hero:', JSON.stringify(mq));
  // 3. Is the terminal visible on first screen?
  const term = await p.evaluate(() => {
    const t = document.querySelector('.term2');
    if (!t) return 'NOT FOUND';
    const r = t.getBoundingClientRect();
    return { top: r.top, height: r.height, visible: r.top < 900 };
  });
  console.log('term2 position:', JSON.stringify(term));
  // 4. What IS the full page structure?
  const sections = await p.evaluate(() => {
    return [...document.querySelectorAll('section')].map(s => {
      const r = s.getBoundingClientRect();
      return { cls: s.className, top: Math.round(r.top + window.scrollY), h: Math.round(r.height) };
    });
  });
  console.log('sections:', JSON.stringify(sections, null, 1));
  // 5. Check the gooey border on term2 — is it in the DOM?
  const gooey = await p.evaluate(() => {
    const g = document.querySelectorAll('.gooey-wrap').length;
    const t2 = document.querySelector('.term2');
    return { gooeyWraps: g, term2Anim: t2 ? getComputedStyle(t2).animationName : 'none' };
  });
  console.log('gooey:', JSON.stringify(gooey));
  await b.close();
})();
