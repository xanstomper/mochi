const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.goto('https://xanstomper.github.io/mochi/', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  console.log('errors:', JSON.stringify(errs, null, 1));
  const sections = await p.evaluate(() => [...document.querySelectorAll('section')].map(s => s.className));
  console.log('sections:', sections);
  await b.close();
})();
