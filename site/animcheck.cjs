const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(800);
  // marquee actually animating? sample transform at two times
  const t1 = await p.evaluate(() => {
    const tr = document.querySelector('.marquee-track');
    return tr ? getComputedStyle(tr).transform : 'none';
  });
  await p.waitForTimeout(500);
  const t2 = await p.evaluate(() => {
    const tr = document.querySelector('.marquee-track');
    return tr ? getComputedStyle(tr).transform : 'none';
  });
  console.log('marquee t1:', t1.slice(0,60));
  console.log('marquee t2:', t2.slice(0,60));
  console.log('marquee moving:', t1 !== t2);
  // rb-window renders without clipping?
  const rb = await p.evaluate(() => {
    const w = document.querySelector('.rb-window');
    const r = w.getBoundingClientRect();
    const inner = w.querySelector('.rb, .rb-compact');
    const ir = inner ? inner.getBoundingClientRect() : null;
    return { windowW: r.width, windowH: r.height, innerW: ir?.width, innerH: ir?.height, clipped: ir ? (ir.width > r.width || ir.height > r.height) : 'no-inner' };
  });
  console.log('rb-window:', JSON.stringify(rb));
  // gooey border: check --gangle actually animating via @property
  const ga = await p.evaluate(() => {
    const gw = document.querySelector('.gooey-wrap');
    return gw ? getComputedStyle(gw).getPropertyValue('--gangle') : 'n/a';
  });
  await p.waitForTimeout(400);
  const ga2 = await p.evaluate(() => {
    const gw = document.querySelector('.gooey-wrap');
    return gw ? getComputedStyle(gw).getPropertyValue('--gangle') : 'n/a';
  });
  console.log('gooey angle t1:', ga, ' t2:', ga2, ' animating:', ga !== ga2);
  await b.close();
})();
