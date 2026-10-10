const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  await p.goto('https://xanstomper.github.io/mochi/', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  await p.screenshot({ path: '/tmp/live_check.png' });
  // Hide the veil momentarily to see raw shader
  await p.evaluate(() => document.querySelector('.iridescence-veil').style.display = 'none');
  await p.waitForTimeout(300);
  await p.screenshot({ path: '/tmp/live_noveil.png' });
  await b.close();
  console.log('done');
})();
