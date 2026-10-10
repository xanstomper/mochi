const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0,100)));
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2500);

  // 1. Hero
  const hero = await p.evaluate(() => {
    const h = document.querySelector('.hero');
    const hr = h.getBoundingClientRect();
    const giant = document.querySelector('.display-xl');
    const ticker = document.querySelector('.hero-ticker');
    const tr = ticker.getBoundingClientRect();
    return {
      heroFull: Math.round(hr.height) >= window.innerHeight - 5,
      giantText: giant ? giant.textContent.trim() : 'MISSING',
      giantVisible: giant ? giant.getBoundingClientRect().height > 0 : false,
      tickerTop: Math.round(tr.top), tickerBottom: Math.round(tr.bottom),
      tickerInView: tr.bottom <= window.innerHeight && tr.top >= 0,
    };
  });
  console.log('HERO:', JSON.stringify(hero));

  // 2. Ticker moving
  const t1 = await p.evaluate(() => getComputedStyle(document.querySelector('.marquee2-track')).transform);
  await p.waitForTimeout(500);
  const t2 = await p.evaluate(() => getComputedStyle(document.querySelector('.marquee2-track')).transform);
  console.log('TICKER:', t1 !== t2 ? 'MOVING' : 'FROZEN', t1.slice(0,40), '→', t2.slice(0,40));

  // 3. Scroll sections + animations
  await p.evaluate(() => window.scrollTo(0, 1200));
  await p.waitForTimeout(1500);
  const mid = await p.evaluate(() => {
    return {
      statCards: document.querySelectorAll('.stat-card').length,
      statNums: document.querySelectorAll('.stat-num').length,
      animContents: document.querySelectorAll('[class*="AnimatedContent"], .scroll-fade, .scroll-slide').length,
      pageHeight: document.documentElement.scrollHeight,
    };
  });
  console.log('MID:', JSON.stringify(mid));

  // 4. Scroll further — check flow/terminal/features
  await p.evaluate(() => window.scrollTo(0, 3000));
  await p.waitForTimeout(1500);
  const deep = await p.evaluate(() => {
    return {
      flowRows: document.querySelectorAll('.flow-row').length,
      featCards: document.querySelectorAll('.feat-card').length,
      benchRows: document.querySelectorAll('.bench-row').length,
      termCard: !!document.querySelector('.term-card'),
      coda: !!document.querySelector('.coda'),
    };
  });
  console.log('DEEP:', JSON.stringify(deep));

  // 5. Iridescence
  const irid = await p.evaluate(() => {
    const c = document.querySelector('.iridescence-canvas');
    return c ? { w: c.width, h: c.height, display: c.getBoundingClientRect().width } : null;
  });
  console.log('IRID:', JSON.stringify(irid));

  // 6. Screenshot
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(1000);
  await p.screenshot({ path: '/tmp/v4_hero.png' });
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})();
