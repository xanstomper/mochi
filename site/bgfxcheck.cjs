const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2000);
  const info = await p.evaluate(() => {
    const bgfx = document.querySelector('.bgfx');
    const bgfxR = bgfx?.getBoundingClientRect();
    const bgfxH = bgfx?.offsetHeight;
    const bgfxPos = bgfx ? getComputedStyle(bgfx).position : 'none';
    const header = document.querySelector('header.site');
    const headerH = header?.offsetHeight;
    const headerR = header?.getBoundingClientRect();
    return { bgfxH, bgfxPos, bgfxR, headerH, headerR };
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
