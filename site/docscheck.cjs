const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/docs.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(2000);
  const info = await p.evaluate(() => {
    const root = document.getElementById('root');
    const children = root ? [...root.children].map(c => c.className || c.tagName) : [];
    const firstContent = root?.querySelector('h1, h2, .page-title, .docs-title');
    const pageH = document.documentElement.scrollHeight;
    return { children, firstContent: firstContent?.textContent?.slice(0,50), pageH };
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
