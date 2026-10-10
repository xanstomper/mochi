const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  // capture console
  const logs = [];
  p.on('console', m => logs.push(m.type() + ': ' + m.text().slice(0,120)));
  await p.goto('https://xanstomper.github.io/mochi/', {waitUntil:'networkidle'});
  await p.waitForTimeout(2000);
  // Check webgl2 support in this context
  const gl = await p.evaluate(() => {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2');
    if (!g) return 'NO WEBGL2';
    return 'webgl2 OK: ' + g.getParameter(g.VERSION);
  });
  console.log('webgl2:', gl);
  // check the actual iridescence canvas context
  const ctx = await p.evaluate(() => {
    const c = document.querySelector('.iridescence-canvas');
    const g = c.getContext('webgl2');
    return g ? 'has ctx, drawingBuffer: ' + g.drawingBufferWidth + 'x' + g.drawingBufferHeight + ' error:' + g.getError() : 'NO CTX';
  });
  console.log('irid canvas ctx:', ctx);
  console.log('console:', logs.filter(l => !l.startsWith('log')).slice(0,5));
  await b.close();
})();
