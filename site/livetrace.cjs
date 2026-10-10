const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  await p.goto('https://xanstomper.github.io/mochi/', {waitUntil:'networkidle'});
  // wait for chars to exist
  await p.waitForSelector('.giant .split-ch', {timeout: 8000});
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const t = await p.evaluate(() => {
      const ch = document.querySelector('.giant .split-ch');
      if (!ch) return 'no-ch';
      const cs = getComputedStyle(ch);
      return { t: cs.transform.slice(0,40), o: cs.opacity };
    });
    samples.push(t);
    await p.waitForTimeout(120);
  }
  console.log(JSON.stringify(samples));
  await b.close();
})();
