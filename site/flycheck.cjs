const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(1500);
  // total page height
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  console.log('page height:', h);
  // scroll to 2000 (manifest section)
  await p.evaluate(() => window.scrollTo(0, 2000));
  await p.waitForTimeout(1500);
  const r = await p.evaluate(() => {
    const flies = [...document.querySelectorAll('.fly-in')];
    return {
      total: flies.length,
      in: flies.filter(f => f.classList.contains('in')).length,
      firstRect: flies[0] ? flies[0].getBoundingClientRect().top : null,
    };
  });
  console.log('fly-ins:', JSON.stringify(r));
  await b.close();
})();
