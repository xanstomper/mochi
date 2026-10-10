const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  await p.goto('https://xanstomper.github.io/mochi/', {waitUntil:'networkidle'});
  await p.waitForTimeout(2500);
  // 1. Sample the iridescence canvas pixels directly
  const px = await p.evaluate(() => {
    const c = document.querySelector('.iridescence-canvas');
    if (!c) return 'no canvas';
    const off = document.createElement('canvas');
    off.width = 8; off.height = 8;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 8, 8).data;
    const colors = new Set();
    for (let i = 0; i < d.length; i += 4) colors.add(d[i]+','+d[i+1]+','+d[i+2]+','+d[i+3]);
    return [...colors];
  });
  console.log('iridescence pixel colors:', px);
  // 2. What does the page look like BEHIND text (body bg)?
  const bodyBg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  console.log('body bg:', bodyBg);
  // 3. Veil opacity check
  const veil = await p.evaluate(() => {
    const v = document.querySelector('.iridescence-veil');
    return v ? getComputedStyle(v).background : 'none';
  });
  console.log('veil:', veil.slice(0, 120));
  await b.close();
})();
