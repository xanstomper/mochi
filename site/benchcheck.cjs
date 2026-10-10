const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/benchmarks.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2000);
  const info = await p.evaluate(() => {
    const bars = document.querySelectorAll('.bench-bar');
    const firstBar = bars[0];
    const cs = firstBar ? getComputedStyle(firstBar) : null;
    const allBars = [...bars].map(b => ({
      cls: b.className,
      bg: getComputedStyle(b).backgroundColor,
      w: b.style.width,
      text: b.textContent.slice(0,20),
    }));
    return { count: bars.length, firstBg: cs?.backgroundColor, allBars: allBars.slice(0,5) };
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
