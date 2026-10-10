const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(1500);
  const r = await p.evaluate(() => {
    const ticker = document.querySelector('.hero-ticker');
    const tr = ticker.getBoundingClientRect();
    const cs = getComputedStyle(ticker);
    const track = ticker.querySelector('.marquee2-track');
    const tcs = getComputedStyle(track);
    const item = ticker.querySelector('.marquee2-item');
    const ics = getComputedStyle(item);
    return {
      tickerRect: { top: tr.top, bottom: tr.bottom, h: tr.height, w: tr.width },
      tickerOpacity: cs.opacity,
      tickerVisibility: cs.visibility,
      tickerDisplay: cs.display,
      tickerZIndex: cs.zIndex,
      tickerOverflow: cs.overflow,
      trackTransform: tcs.transform,
      trackOpacity: tcs.opacity,
      trackDisplay: tcs.display,
      itemColor: ics.color,
      itemFontSize: ics.fontSize,
      itemOpacity: ics.opacity,
      itemText: item.textContent,
      // is ticker actually in viewport?
      viewportH: window.innerHeight,
      tickerVisibleInViewport: tr.bottom <= window.innerHeight && tr.top >= 0,
    };
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();
