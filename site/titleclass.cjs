const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  const info = await p.evaluate(() => {
    const title = document.querySelector('.hero-title');
    if (!title) return 'no title';
    const parent = title.closest('.ac');
    const grandparent = title.parentElement?.closest('.ac');
    const firstChar = title.querySelector('.split-char');
    const cs = firstChar ? getComputedStyle(firstChar) : null;
    return {
      titleClass: title.className,
      parentClass: parent?.className,
      grandparentClass: grandparent?.className,
      firstCharTransform: cs?.transform,
      firstCharTransitionDelay: cs?.transitionDelay,
      titleInView: title.classList.contains('in'),
      parentIn: parent?.classList.contains('in'),
      rect: title.getBoundingClientRect(),
    };
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
