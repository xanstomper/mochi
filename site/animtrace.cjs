const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'commit'});
  // Sample transform every 100ms from page start
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const t = await p.evaluate(() => {
      const ch = document.querySelector('.giant .split-ch');
      if (!ch) return 'no-ch';
      const cs = getComputedStyle(ch);
      return { transform: cs.transform, opacity: cs.opacity, anim: cs.animationName, delay: cs.animationDelay };
    });
    samples.push(t);
    await p.waitForTimeout(100);
  }
  console.log(JSON.stringify(samples, null, 1));
  await b.close();
})();
