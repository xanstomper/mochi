const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const pages = ['index.html', 'docs.html', 'benchmarks.html', 'changelog.html', 'source.html'];
  for (const pg of pages) {
    const p = await b.newPage({ viewport:{width:1920,height:1080} });
    const errs = [];
    p.on('pageerror', e => errs.push(e.message.slice(0,120)));
    const url = 'https://xanstomper.github.io/mochi/' + pg;
    await p.goto(url, {waitUntil:'networkidle', timeout:30000}).catch(e => errs.push('NAV: ' + e.message.slice(0,60)));
    await p.waitForTimeout(2000);
    console.log(pg, '→', errs.length ? errs : 'CLEAN');
    await p.close();
  }
  await b.close();
})();
