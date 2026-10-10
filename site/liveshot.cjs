const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('https://xanstomper.github.io/mochi/', {waitUntil:'networkidle'});
  await p.waitForTimeout(4000);
  await p.screenshot({ path: '/tmp/live_hero.png', clip:{x:0,y:0,width:1920,height:1080} });
  await p.evaluate(() => window.scrollTo(0, 1100));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/tmp/live_caps.png', clip:{x:0,y:0,width:1920,height:1080} });
  console.log('done');
  await b.close();
})();
