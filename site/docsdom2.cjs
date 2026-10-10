const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/docs.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2000);
  const info = await p.evaluate(() => {
    const pagehead = document.querySelector('.pagehead');
    const prev = pagehead?.previousElementSibling;
    const prev2 = prev?.previousElementSibling;
    const bodyChildren = [...document.body.children].map(c => {
      const r = c.getBoundingClientRect();
      return { tag: c.tagName, cls: (c.className||'').slice(0,40), top: Math.round(r.top), h: Math.round(r.height) };
    });
    return { prev: prev?.className, prev2: prev2?.className, bodyChildren };
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
