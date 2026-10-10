const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  // Capabilities section
  await p.evaluate(() => window.scrollTo(0, 1100));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/tmp/v5_caps.png', clip:{x:0,y:0,width:1920,height:1080} });
  // Stats + flow
  await p.evaluate(() => window.scrollTo(0, 2200));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/tmp/v5_flow.png', clip:{x:0,y:0,width:1920,height:1080} });
  // Terminal
  await p.evaluate(() => window.scrollTo(0, 3400));
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/tmp/v5_term.png', clip:{x:0,y:0,width:1920,height:1080} });
  console.log('done');
  await b.close();
})();
