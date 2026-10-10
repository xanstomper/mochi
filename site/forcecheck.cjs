const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2000);
  // Force all animations to complete
  await p.evaluate(() => {
    document.querySelectorAll('.split-char').forEach(c => {
      c.style.animation = 'none';
      c.style.transform = 'none';
    });
    document.querySelectorAll('.blur-word').forEach(c => {
      c.style.animation = 'none';
      c.style.opacity = '1';
      c.style.filter = 'none';
    });
  });
  await p.waitForTimeout(500);
  await p.screenshot({ path: '/tmp/v5_forced.png', clip:{x:0,y:0,width:1920,height:1080} });
  console.log('forced done');
  await b.close();
})();
