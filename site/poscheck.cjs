const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2000);
  // scroll to stats and get exact positions
  await p.evaluate(() => window.scrollTo(0, 1100));
  await p.waitForTimeout(1000);
  const r = await p.evaluate(() => {
    const nav = document.querySelector('header.site');
    const stats = document.querySelector('.stats-grid');
    const navR = nav.getBoundingClientRect();
    const statsR = stats.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      navBottom: navR.bottom,
      statsTop: statsR.top,
      clearance: statsR.top - navR.bottom,
    };
  });
  console.log(JSON.stringify(r));
  await b.close();
})();
