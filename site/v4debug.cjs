const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0,200)));
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2500);
  const html = await p.evaluate(() => {
    return {
      bodyClasses: document.body.className,
      firstChild: document.body.firstElementChild?.className || document.body.firstElementChild?.tagName,
      sections: [...document.querySelectorAll('section')].map(s => s.className).slice(0,8),
      irid: !!document.querySelector('.iridescence-canvas'),
      iridParent: document.querySelector('.iridescence-canvas')?.parentElement?.className,
    };
  });
  console.log(JSON.stringify(html, null, 1));
  console.log('errors:', errs);
  await b.close();
})();
