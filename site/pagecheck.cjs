const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  for (const pg of ['benchmarks.html','docs.html','changelog.html','source.html']) {
    await p.goto('http://127.0.0.1:8937/mochi/'+pg, {waitUntil:'networkidle'});
    await p.waitForTimeout(700);
    const r = await p.evaluate(() => ({
      eyebrow: !!document.querySelector('.eyebrow'),
      marquee: document.querySelectorAll('.marquee-item').length,
      h1: (document.querySelector('h1')||{}).textContent || 'MISSING',
    }));
    console.log(pg, JSON.stringify(r));
  }
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})();
