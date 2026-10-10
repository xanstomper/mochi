const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message.slice(0, 300)));
  for (const [name, path] of [['home','/'],['changelog','/changelog.html'],['source','/source.html'],['benchmarks','/benchmarks.html']]) {
    errors.length = 0;
    await page.goto('https://xanstomper.github.io/mochi' + path, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => errors.push('NAV: ' + e.message.slice(0,150)));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: '/tmp/shot_' + name + '.png' });
    const rootLen = await page.evaluate(() => (document.getElementById('root')?.innerHTML || '').length);
    console.log(name.toUpperCase(), '| root html len:', rootLen, '| errors:', errors.length ? errors.slice(0,3) : 'none');
  }
  await browser.close();
})();
