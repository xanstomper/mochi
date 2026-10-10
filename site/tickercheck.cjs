const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(1500);
  const r = await p.evaluate(() => {
    const ticker = document.querySelector('.hero-ticker');
    const hero = document.querySelector('.hero2');
    const tr = ticker.getBoundingClientRect();
    const hr = hero.getBoundingClientRect();
    const cs = getComputedStyle(ticker);
    return {
      tickerTop: Math.round(tr.top), tickerBottom: Math.round(tr.bottom),
      tickerH: Math.round(tr.height), tickerW: Math.round(tr.width),
      heroH: Math.round(hr.height), heroBottom: Math.round(hr.bottom),
      position: cs.position, display: cs.display, zIndex: cs.zIndex,
      bg: cs.background.slice(0, 60), opacity: cs.opacity,
      items: ticker.querySelectorAll('.marquee2-item').length,
      itemText: ticker.querySelector('.marquee2-item')?.textContent?.slice(0, 30),
    };
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();
