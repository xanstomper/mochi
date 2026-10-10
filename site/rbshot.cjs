const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/source.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  await p.evaluate(() => {
    const rb = document.querySelector('.rb-window');
    if (rb) rb.scrollIntoView({ block: 'start' });
  });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: '/tmp/v5_source_rb.png', clip:{x:0,y:0,width:1920,height:1080} });
  console.log('done');
  await b.close();
})();
