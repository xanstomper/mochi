const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(1200);
  const checks = await p.evaluate(() => {
    const q = s => document.querySelectorAll(s).length;
    return {
      giant: q('.giant .split-ch'),       // split chars present
      splitIn: !!document.querySelector('.split.in'),
      dither: q('canvas.dither'),
      marquee: q('.marquee-item'),
      gstat: q('.gstat'),
      flowRows: q('.flow-row'),
      triCards: q('.tri-card'),
      term: !!document.querySelector('.term2-body'),
      repo: q('.rb .src-file,.rb .src-dir').length,
      codaSplit: !!document.querySelector('.coda .split'),
      sections: [...document.querySelectorAll('section')].map(s=>s.className),
      bodyH: document.body.scrollHeight,
    };
  });
  console.log(JSON.stringify(checks, null, 1), 'errors:', errs.length ? errs : 'none');
  await b.close();
})();
