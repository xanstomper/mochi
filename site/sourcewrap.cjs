const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/source.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(5000);
  const info = await p.evaluate(() => {
    const wrap = document.querySelector('.wrap');
    if (!wrap) return 'no wrap';
    const children = [...wrap.children].map(c => ({
      tag: c.tagName,
      cls: (c.className||'').slice(0,50),
      text: c.textContent?.slice(0,60),
    }));
    return children;
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
