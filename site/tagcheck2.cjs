const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2000);
  const info = await p.evaluate(() => {
    const tag = document.querySelector('.section-tag');
    if (!tag) return 'no tag';
    const cs = getComputedStyle(tag);
    const rect = tag.getBoundingClientRect();
    return {
      text: tag.textContent,
      bg: cs.backgroundColor, color: cs.color,
      display: cs.display, opacity: cs.opacity,
      rect: { top: rect.top, height: rect.height, width: rect.width },
    };
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
