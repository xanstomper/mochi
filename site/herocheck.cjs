const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0,100)));
  await p.goto('https://xanstomper.github.io/mochi/', {waitUntil:'networkidle'});
  await p.waitForTimeout(2500);
  // 1. Is the ticker actually MOVING on the live site? sample 3 times
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t = await p.evaluate(() => {
      const tr = document.querySelector('.hero-ticker .marquee2-track');
      return tr ? getComputedStyle(tr).transform : 'NO TRACK';
    });
    samples.push(t);
    await p.waitForTimeout(500);
  }
  console.log('ticker transforms:', samples);
  // 2. Is the giant MOCHI text in the DOM?
  const giant = await p.evaluate(() => {
    const g = document.querySelector('.giant');
    return g ? { text: g.textContent.trim(), chars: g.querySelectorAll('.split-ch').length, visible: g.getBoundingClientRect().height > 0 } : 'NOT FOUND';
  });
  console.log('giant:', JSON.stringify(giant));
  // 3. What does the hero actually look like? screenshot top of page
  await p.screenshot({ path: '/tmp/hero_live.png', clip: { x:0, y:0, width:1920, height:1080 } });
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})();
