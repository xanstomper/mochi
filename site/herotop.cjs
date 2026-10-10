const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  // scroll to hero top
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(500);
  await p.screenshot({ path: '/tmp/v5_hero_top.png', clip:{x:0,y:0,width:1920,height:1080} });
  const titleY = await p.evaluate(() => {
    const t = document.querySelector('.hero-title');
    return t?.getBoundingClientRect().top;
  });
  console.log('title Y at scroll 0:', titleY);
  await b.close();
})();
