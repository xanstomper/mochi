const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(1500);
  await p.screenshot({path:'/tmp/h1.png'});
  await p.evaluate(() => window.scrollTo(0, 2400)); await p.waitForTimeout(900);
  await p.screenshot({path:'/tmp/h2.png'});
  await p.evaluate(() => window.scrollTo(0, 99999)); await p.waitForTimeout(900);
  await p.screenshot({path:'/tmp/h3.png'});
  // dither canvas actually painted? sample pixel variance
  const px = await p.evaluate(() => {
    const c = document.querySelector('canvas.dither');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0,0,c.width,c.height).data;
    const uniq = new Set(); for (let i=0;i<d.length;i+=4) uniq.add(d[i]+','+d[i+1]+','+d[i+2]);
    return { uniqColors: uniq.size, w: c.width, h: c.height };
  });
  console.log('dither px:', JSON.stringify(px));
  await b.close();
})();
