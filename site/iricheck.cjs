const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0,80)));
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(1200);
  const checks = await p.evaluate(() => {
    const q = s => document.querySelectorAll(s).length;
    const irid = document.querySelector('.iridescence-canvas');
    const iridInfo = irid ? { w: irid.width, h: irid.height } : null;
    const slides = q('.slide-in');
    const slidesIn = q('.slide-in.in');
    const mq2 = q('.marquee2-item');
    const giant = document.querySelector('.giant');
    const giantText = giant ? giant.textContent.trim() : '';
    return {
      iridCanvas: iridInfo,
      iridBg: q('.iridescence-bg'),
      veil: q('.iridescence-veil'),
      slideInTotal: slides,
      slideInRevealed: slidesIn,
      marquee2Items: mq2,
      giantText,
      giantChars: q('.giant .split-ch'),
    };
  });
  // marquee2 actually moving?
  const m1 = await p.evaluate(() => getComputedStyle(document.querySelector('.marquee2-track')).transform);
  await p.waitForTimeout(400);
  const m2 = await p.evaluate(() => getComputedStyle(document.querySelector('.marquee2-track')).transform);
  console.log(JSON.stringify(checks, null, 1));
  console.log('marquee2 moving:', m1 !== m2, '| t1:', m1.slice(0,40), '| t2:', m2.slice(0,40));
  // scroll down to trigger slides then count .in
  await p.evaluate(() => window.scrollTo(0, 1600));
  await p.waitForTimeout(1400);
  const slidesAfter = await p.evaluate(() => document.querySelectorAll('.slide-in.in').length);
  console.log('slides revealed after scroll:', slidesAfter);
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})();
