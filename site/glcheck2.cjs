const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  // DESKTOP viewport
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2000);
  const info = await p.evaluate(() => {
    const c = document.querySelector('.iridescence-canvas');
    const r = c.getBoundingClientRect();
    const gl = c.getContext('webgl2');
    return {
      display: { w: Math.round(r.width), h: Math.round(r.height) },
      buffer: { w: c.width, h: c.height },
      dpr: window.devicePixelRatio,
      visible: r.width > 0 && r.height > 0,
    };
  });
  console.log('desktop canvas:', JSON.stringify(info));
  // is it animating? sample two frames via toDataURL hash (small sample)
  const h1 = await p.evaluate(() => document.querySelector('.iridescence-canvas').toDataURL('image/png').length);
  await p.waitForTimeout(600);
  const h2 = await p.evaluate(() => document.querySelector('.iridescence-canvas').toDataURL('image/png').length);
  console.log('frame size t1:', h1, 't2:', h2, 'changing:', h1 !== h2);
  await b.close();
})();
