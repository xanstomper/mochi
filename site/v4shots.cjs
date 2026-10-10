const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2000);
  await p.screenshot({ path: '/tmp/v4_full.png' });
  // hero only
  await p.screenshot({ path: '/tmp/v4_hero.png', clip: { x:0, y:0, width:1920, height:1080 } });
  // scroll to stats
  await p.evaluate(() => window.scrollTo(0, 1100));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/tmp/v4_stats.png', clip: { x:0, y:0, width:1920, height:1080 } });
  // scroll to terminal
  await p.evaluate(() => window.scrollTo(0, 5500));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/tmp/v4_term.png', clip: { x:0, y:0, width:1920, height:1080 } });
  // scroll to coda
  await p.evaluate(() => window.scrollTo(0, 17000));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/tmp/v4_coda.png', clip: { x:0, y:0, width:1920, height:1080 } });
  console.log('done');
  await b.close();
})();
