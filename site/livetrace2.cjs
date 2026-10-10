const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  // Navigate and sample ASAP — don't wait for networkidle
  const nav = p.goto('https://xanstomper.github.io/mochi/', {waitUntil:'domcontentloaded'});
  const samples = [];
  for (let i = 0; i < 20; i++) {
    try {
      const t = await p.evaluate(() => {
        const ch = document.querySelector('.giant .split-ch');
        if (!ch) return 'no-ch';
        const cs = getComputedStyle(ch);
        return { t: cs.transform.slice(0,45), o: cs.opacity, d: cs.animationDelay };
      });
      samples.push(t);
    } catch(e) { samples.push('err:'+e.message.slice(0,30)); }
    await p.waitForTimeout(80);
  }
  await nav.catch(()=>{});
  console.log(JSON.stringify(samples, null, 0));
  await b.close();
})();
