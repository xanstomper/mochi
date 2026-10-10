const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  const pages = ['docs.html', 'benchmarks.html', 'changelog.html', 'source.html'];
  for (const pg of pages) {
    await p.goto('http://127.0.0.1:8937/mochi/' + pg, {waitUntil:'networkidle'});
    await p.waitForTimeout(2000);
    await p.screenshot({ path: '/tmp/v5_' + pg.replace('.html','') + '.png', clip:{x:0,y:0,width:1920,height:1080} });
    console.log(pg + ' done');
  }
  await b.close();
})();
