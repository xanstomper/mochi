const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0,80)));
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2000);
  const checks = await p.evaluate(() => {
    const hero = document.querySelector('.hero2');
    const hr = hero.getBoundingClientRect();
    const ticker = document.querySelector('.hero-ticker');
    const tr = ticker ? ticker.getBoundingClientRect() : null;
    const irid = document.querySelector('.iridescence-canvas');
    const ir = irid.getBoundingClientRect();
    return {
      heroH: Math.round(hr.height), viewportH: window.innerHeight,
      heroFullScreen: Math.round(hr.height) >= window.innerHeight - 5,
      tickerTop: tr ? Math.round(tr.top) : null,
      tickerBottom: tr ? Math.round(tr.bottom) : null,
      tickerAtBottom: tr ? (Math.round(tr.bottom) >= window.innerHeight - 5) : false,
      iridDisplay: { w: Math.round(ir.width), h: Math.round(ir.height) },
      iridBuffer: { w: irid.width, h: irid.height },
      iridSharp: irid.width >= ir.width * 0.95,
      flyInTotal: document.querySelectorAll('.fly-in').length,
      navPillGone: !document.querySelector('nav a[aria-current="page"]').style.background.includes('gradient'),
    };
  });
  // ticker moving RIGHT? reverse animation = translateX going positive
  const t1 = await p.evaluate(() => getComputedStyle(document.querySelector('.marquee2-track')).transform);
  await p.waitForTimeout(400);
  const t2 = await p.evaluate(() => getComputedStyle(document.querySelector('.marquee2-track')).transform);
  const dir = t1 !== t2 ? 'MOVING' : 'FROZEN';
  console.log(JSON.stringify(checks, null, 1));
  console.log('ticker:', dir, '| t1:', t1.slice(0,45), '| t2:', t2.slice(0,45));
  // scroll to trigger fly-ins
  await p.evaluate(() => window.scrollTo(0, 1400));
  await p.waitForTimeout(1300);
  const flyIn = await p.evaluate(() => document.querySelectorAll('.fly-in.in').length);
  console.log('fly-ins revealed after scroll:', flyIn);
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})();
