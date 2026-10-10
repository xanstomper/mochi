const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  const info = await p.evaluate(() => {
    const ticker = document.querySelector('.stats-ticker');
    const tickerR = ticker?.getBoundingClientRect();
    const hero = document.querySelector('.hero');
    const heroR = hero?.getBoundingClientRect();
    const sections = [...document.querySelectorAll('section')].map(s => s.className || s.id);
    const pageH = document.documentElement.scrollHeight;
    return { tickerExists: !!ticker, tickerR, heroR, sections, pageH };
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
