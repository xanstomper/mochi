const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0,120)));
  await p.goto('http://127.0.0.1:8937/mochi/benchmarks.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2000);
  const bars = await p.evaluate(() => document.querySelectorAll('.bench-bar').length);
  console.log('bench bars:', bars, '| errors:', errs.length ? errs : 'none');
  await b.close();
})();
