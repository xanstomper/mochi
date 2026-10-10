const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://127.0.0.1:8937/mochi/source.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(5000);
  const info = await p.evaluate(() => {
    const root = document.getElementById('root');
    const children = root ? [...root.children].map(c => c.className?.slice(0,40) || c.tagName) : [];
    const repoBrowser = document.querySelector('.repo-browser, .file-tree, .source-view');
    const pageH = document.documentElement.scrollHeight;
    return { children, hasRepoBrowser: !!repoBrowser, pageH };
  });
  console.log(JSON.stringify({ errors, info }, null, 1));
  await b.close();
})();
