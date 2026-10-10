
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message.slice(0,200)));
  for (const [name, path] of [['home','/index.html'],['source','/source.html'],['changelog','/changelog.html']]) {
    errors.length = 0;
    await page.goto('http://127.0.0.1:8937/mochi' + path, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: '/tmp/local_' + name + '.png' });
    console.log(name, '| root len:', await page.evaluate(() => (document.getElementById('root')?.innerHTML||'').length), '| errors:', errors.length?errors:'none');
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: '/tmp/local_home_bottom.png' });
  await browser.close();
})();
