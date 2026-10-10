const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message.slice(0,100)));
  const resp = await p.goto('https://xanstomper.github.io/mochi/', {waitUntil:'networkidle'});
  console.log('HTTP:', resp.status());
  // what chunks did the page actually load?
  const chunks = await p.evaluate(() => [...document.querySelectorAll('script[type=module],script[src]')].map(s => s.src).filter(Boolean));
  console.log('scripts:', chunks);
  // is iridescence in the DOM?
  const irid = await p.evaluate(() => {
    const c = document.querySelector('.iridescence-canvas');
    return c ? { w: c.width, h: c.height, cls: c.className } : 'NOT IN DOM';
  });
  console.log('iridescence:', JSON.stringify(irid));
  // check body background / computed styles for the bg layer
  const bg = await p.evaluate(() => {
    const el = document.querySelector('.iridescence-bg');
    return el ? getComputedStyle(el).position : 'NO BG LAYER';
  });
  console.log('bg layer:', bg);
  await p.screenshot({ path: '/tmp/live_now.png' });
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})();
