const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  // Remove background-clip and use solid white
  await p.evaluate(() => {
    const t = document.querySelector('.hero-title');
    if (t) {
      t.style.background = 'none';
      t.style.webkitTextFillColor = 'white';
      t.style.color = 'white';
    }
  });
  await p.waitForTimeout(300);
  await p.screenshot({ path: '/tmp/v5_solid.png', clip:{x:0,y:0,width:1920,height:1080} });
  console.log('solid test done');
  await b.close();
})();
