const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  const delays = await p.evaluate(() => {
    return [...document.querySelectorAll('.giant .split-ch')].map(c => getComputedStyle(c).animationDelay);
  });
  console.log('per-char delays:', delays);
  await b.close();
})();
